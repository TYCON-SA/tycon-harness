#!/usr/bin/env node
'use strict';
/**
 * pr-build-wait.js — espera la compilación de CI de cada pedido de una corrida y avisa si están listos para aprobar.
 *
 * Un pedido no está listo porque se abrió: está listo cuando su compilación terminó en verde. El cierre de la corrida
 * (`marker.js clear`) lanza esta espera de fondo con la lista de sus pedidos y no dice «listo» en ningún lado. La espera
 * lee la CI de cada pedido por la capa de plataforma (`ci.read`, con `pullRequest`: en Azure DevOps la compilación de un
 * pedido corre sobre su fusión de prueba; y con `commit`, la punta empujada: la compilación de un empuje anterior no
 * cuenta) y termina en uno de tres avisos, por los canales de la sesión:
 *
 *   · todos en verde → «listos para aprobar», con cada pedido;
 *   · uno en rojo    → «en rojo», con la etapa que falló; no espera a los demás;
 *   · sin respuesta de la plataforma, o pasado el tope → «no medido», con el motivo. Nunca «listo».
 *
 * Una lectura `ninguna` (la compilación todavía no arrancó) o `corriendo` sigue esperando. Un «no» de la plataforma que no
 * se arregla esperando (sin plataforma, sin credencial, la operación no la atiende) termina enseguida en «no medido».
 *
 * El resultado queda además en `<estado>/pr-build-wait/<sesión>-resultado.json` y en `gates.log` (`pr-build`).
 *
 *   node pr-build-wait.js --file <lista>   la lista que escribe el cierre: { session, storyId, pedidos: [{ repo, nombre, numero, rama }] }
 *
 * Topes: TYCON_PR_BUILD_WAIT_MIN (90 minutos) y TYCON_PR_BUILD_WAIT_POLL_S (60 s entre lecturas).
 */
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..', '..', '..');
const SIN_ARREGLO_ESPERANDO = new Set(['sin_plataforma', 'sin_credencial', 'no_soportado', 'rechazado', 'no_encontrado']);
const MALOS = /^(failed|failure|canceled|cancelled|timed_out|action_required|startup_failure|partiallysucceeded)$/i;

function entero(v, porDefecto) {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isInteger(n) && n > 0 ? n : porDefecto;
}

const nombreDe = (p) => `#${p.numero} de ${p.nombre}`;

/** La etapa que falló de una lectura en rojo, o null. */
function etapaQueFallo(r) {
  const etapas = r && r.value && Array.isArray(r.value.stages) ? r.value.stages : [];
  const mala = etapas.find((e) => e && e.result && MALOS.test(String(e.result)));
  return mala ? [mala.pipeline, mala.name].filter(Boolean).join(' · ') : null;
}

/**
 * Espera hasta que todos den verde, uno dé rojo, o pase el tope. `leer(pedido)` devuelve la respuesta de `ci.read`.
 * `{ estado: 'listos'|'rojo'|'no-medido', pedidos: [{ ...pedido, veredicto, etapa?, motivo? }] }`.
 */
async function esperar({ pedidos, leer, dormir = (ms) => new Promise((ok) => setTimeout(ok, ms)), ahora = () => Date.now(), topeMs, cadaMs }) {
  const { verdictOf } = require(path.join(RAIZ, 'scripts', 'lib', 'platform', 'contract.js'));
  const estado = pedidos.map((p) => ({ ...p, veredicto: 'sin-leer', motivo: null }));
  const fin = ahora() + topeMs;
  for (;;) {
    for (const p of estado.filter((x) => x.veredicto !== 'verde')) {
      let r;
      try { r = await leer(p); } catch (e) { r = { ok: false, reason: 'no_medido', detail: e.message }; }
      const v = verdictOf(r);
      if (v === 'verde') { p.veredicto = 'verde'; p.motivo = null; continue; }
      if (v === 'rojo') {
        p.veredicto = 'rojo';
        p.etapa = etapaQueFallo(r);
        return { estado: 'rojo', pedidos: estado };
      }
      if (r && r.ok === false && SIN_ARREGLO_ESPERANDO.has(r.reason)) {
        p.veredicto = 'no-medido';
        p.motivo = `${r.reason}: ${r.detail || 'sin detalle'}`;
        return { estado: 'no-medido', pedidos: estado };
      }
      p.veredicto = v === 'corriendo' || v === 'ninguna' ? v : 'no-medido';
      p.motivo = v === 'no_medido' ? String((r && r.detail) || 'la plataforma no contestó') : null;
    }
    if (estado.every((x) => x.veredicto === 'verde')) return { estado: 'listos', pedidos: estado };
    if (ahora() + cadaMs > fin) {
      for (const p of estado.filter((x) => x.veredicto !== 'verde')) p.motivo = `${p.motivo ? `${p.motivo}; ` : ''}pasó el tope de ${Math.round(topeMs / 60000)} min ${p.veredicto === 'ninguna' ? 'sin que arrancara la compilación' : p.veredicto === 'corriendo' ? 'con la compilación corriendo' : 'sin poder leerla'}`;
      return { estado: 'no-medido', pedidos: estado };
    }
    await dormir(cadaMs);
  }
}

/** El texto del aviso: una línea de título y una por pedido. */
function texto({ storyId, resultado }) {
  const h = `Historia ${storyId}`;
  const renglon = (p) => {
    if (p.veredicto === 'verde') return `· ${nombreDe(p)}: compilación en verde`;
    if (p.veredicto === 'rojo') return `· ${nombreDe(p)}: compilación en ROJO${p.etapa ? ` (${p.etapa})` : ''}`;
    return `· ${nombreDe(p)}: ${p.veredicto === 'corriendo' ? 'corriendo' : p.veredicto === 'ninguna' ? 'sin compilación' : 'no medido'}${p.motivo ? ` (${p.motivo})` : ''}`;
  };
  if (resultado.estado === 'listos') return [`${h}: pedidos listos para aprobar.`, ...resultado.pedidos.map(renglon)].join('\n');
  if (resultado.estado === 'rojo') {
    return [`${h}: un pedido tiene la compilación en rojo. No está listo: arreglá el rojo y volvé a empujar.`, ...resultado.pedidos.map(renglon)].join('\n');
  }
  return [`${h}: no pude ver la compilación de todos los pedidos. No están listos hasta verla en verde.`, ...resultado.pedidos.map(renglon)].join('\n');
}

/** La lectura de verdad: la identidad del repo por su remoto y `ci.read` por la capa de plataforma. */
function lectorReal({ env = process.env } = {}) {
  const platform = require(path.join(RAIZ, 'scripts', 'lib', 'platform', 'platform.js'));
  const { hostOf } = require(path.join(RAIZ, 'scripts', 'tools', 'merge-pr.js'));
  return async (p) => {
    // sin el commit de la punta no se sabe cuál es la compilación del último empuje: una vieja en verde diría «listo»
    if (!p.commit) return { ok: false, reason: 'no_medido', detail: `${p.nombre}: no sé el commit de la punta del pedido` };
    const where = hostOf(p.repo);
    if (where.problem) return { ok: false, reason: 'no_medido', detail: where.problem };
    const repo = platform.identityFromRemote(where);
    if (!repo) return { ok: false, reason: 'sin_plataforma', detail: `${p.nombre}: su remoto no es de una plataforma conocida` };
    return platform.run('ci.read', { pullRequest: p.numero, commit: p.commit, ...(p.rama ? { branch: p.rama } : {}), deadlineMs: Date.now() + 120000 }, { env, repo, tree: RAIZ });
  };
}

/** Deja el resultado en el estado, en `gates.log` y en los canales de la sesión. Nunca tira. */
function avisar({ stateDir, session, storyId, resultado }) {
  const t = texto({ storyId, resultado });
  try {
    const dir = path.join(stateDir, 'pr-build-wait');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${session}-resultado.json`), JSON.stringify({ ts: new Date().toISOString(), storyId, ...resultado, texto: t }, null, 2));
  } catch (_) { /* el aviso sale igual */ }
  try {
    fs.appendFileSync(path.join(stateDir, 'gates.log'), `${JSON.stringify({ ts: new Date().toISOString(), session, name: 'pr-build', story: storyId, estado: resultado.estado,
      pedidos: resultado.pedidos.map((p) => ({ repo: p.nombre, numero: p.numero, veredicto: p.veredicto, ...(p.etapa ? { etapa: p.etapa } : {}) })) })}\n`);
  } catch (_) { /* el aviso sale igual */ }
  try {
    const notify = require(path.join(RAIZ, 'scripts', 'lib', 'notify.js'));
    const via = notify.canalesListos({ texto: t });
    if (!via.problema && via.canales.length) notify.avisar({ canales: via.canales, texto: t, lado: 'sesion', mail: via.mail, chat: via.chat, reintentar: false });
  } catch (_) { /* sin canales, queda el archivo y el registro */ }
  return t;
}

async function main(argv) {
  const k = argv.indexOf('--file');
  const archivo = k >= 0 ? argv[k + 1] : null;
  if (!archivo) { process.stderr.write('uso: pr-build-wait.js --file <lista de pedidos>\n'); return 2; }
  let lista;
  try { lista = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch (e) { process.stderr.write(`pr-build-wait: no pude leer ${archivo} (${e.message})\n`); return 2; }
  try { fs.rmSync(archivo, { force: true }); } catch (_) { /* queda; no cambia la espera */ }
  const { stateDir } = require('./state-dir.js');
  const resultado = await esperar({
    pedidos: lista.pedidos || [], leer: lectorReal(),
    topeMs: entero(process.env.TYCON_PR_BUILD_WAIT_MIN, 90) * 60000, cadaMs: entero(process.env.TYCON_PR_BUILD_WAIT_POLL_S, 60) * 1000,
  });
  process.stdout.write(`${avisar({ stateDir: stateDir(), session: lista.session, storyId: lista.storyId, resultado })}\n`);
  return resultado.estado === 'listos' ? 0 : 1;
}

if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { process.stderr.write(`pr-build-wait: ${e.message}\n`); process.exit(2); });

module.exports = { esperar, texto, avisar, etapaQueFallo, lectorReal };
