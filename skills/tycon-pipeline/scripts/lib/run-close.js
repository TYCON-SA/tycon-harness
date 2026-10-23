#!/usr/bin/env node
'use strict';
/**
 * run-close — cómo termina una ejecución del pipeline (`cierre`) y si cerrarla ahora la deja a medias.
 *
 * Una ejecución está «abierta» si tiene un control registrado en rojo (`marker.checks` que empieza con `red`), pasos sin
 * correr (alguno de los que `prepare-commit` exige, directa o indirectamente, en `ORDER_REQUIRES`) o el pase adversarial
 * lanzado sin cerrar (`veredictoPaseAdversarial` no da `paso`). Los controles que el pipeline acepta diciéndolo
 * (`sin-medir`, `sin-acotar`) no la abren: se nombran en el motivo.
 *
 * `cierre` es la marca única de cómo terminó: `completa` (no estaba abierta), `abortada` (se cerró abierta), `deuda` (la
 * escribe `marker.js close-as-debt`; la ejecución sigue hasta el commit, y el `clear` del final la conserva) y
 * `abandonada` (la sesión terminó sin `clear`; la marca quien sube la ejecución). `clear` no pisa un `cierre` ya escrito. La vía de una abortada sale del registro de
 * escapes del freno de seguridad: la última línea de esta sesión con `escape: cerrar-la-ejecucion`, posterior al
 * arranque de la ejecución; sin ella, `sin-registro`.
 *
 * Uso desde el freno de seguridad: node run-close.js --gate --session <id> [--command-stdin --shell bash|powershell]
 *   imprime `hay=0|1|?`, `autonomo=0|1`, `abierta=0|1` y `motivo=…`, un renglón por campo. Con el comando por la
 *   entrada, además un `frena=<escape>\t<subcomando>\t<valor>` por cada llamada a marker.js que, con este marcador,
 *   pide la frase de la persona (lib/marker-command.js las encuentra).
 */
const fs = require('fs');
const path = require('path');
const { ORDER_REQUIRES, isPending } = require('./steps.js');
const { veredictoPaseAdversarial } = require('./adversarial-verdict.js');
const { stateDir } = require('./state-dir.js');

const ESTADOS = ['completa', 'deuda', 'abortada', 'abandonada'];
const ACEPTADOS = ['sin-medir', 'sin-acotar'];

/** Los pasos que `prepare-commit` necesita hechos, directa o indirectamente. */
function requeridos(paso = 'prepare-commit', vistos = new Set()) {
  for (const p of ORDER_REQUIRES[paso] || []) {
    if (vistos.has(p)) continue;
    vistos.add(p);
    requeridos(p, vistos);
  }
  return [...vistos];
}

/** `{ rojos, sinMedir, sinCorrer, paseSinCerrar }` del marcador. */
function estado(marker) {
  const m = marker || {};
  const checks = m.checks && typeof m.checks === 'object' ? m.checks : {};
  const rojos = Object.keys(checks).filter((k) => /^red/.test(String(checks[k])));
  const sinMedir = Object.keys(checks).filter((k) => ACEPTADOS.includes(String(checks[k])));
  const pendientes = (Array.isArray(m.stepsPending) ? m.stepsPending : []).map(String);
  const sinCorrer = requeridos().filter((p) => pendientes.includes(p) || isPending(m, p));
  const paseSinCerrar = !!m.adversarial && veredictoPaseAdversarial(m).veredicto !== 'paso';
  return { rojos, sinMedir, sinCorrer, paseSinCerrar };
}

function abierta(e) {
  return e.rojos.length > 0 || e.sinCorrer.length > 0 || e.paseSinCerrar;
}

/** El motivo, en llano: qué estaba en rojo, sin correr o sin cerrar. */
function motivoDe(e) {
  const partes = [];
  if (e.rojos.length) partes.push(`en rojo: ${e.rojos.join(', ')}`);
  if (e.sinCorrer.length) partes.push(`sin correr: ${e.sinCorrer.join(', ')}`);
  if (e.paseSinCerrar) partes.push('el pase adversarial sin cerrar');
  if (e.sinMedir.length) partes.push(`aceptado sin medir: ${e.sinMedir.join(', ')}`);
  return partes.join('; ');
}

/** Las líneas del registro de escapes: [] si no hay registro, null si existe y no se puede leer. */
function leerFrenos(home) {
  try {
    return fs.readFileSync(path.join(stateDir(home), 'frenos.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch (e) { return e && e.code === 'ENOENT' ? [] : null; }
}

/** El escape «cerrar la ejecución» (u otro con nombre) de esta sesión, posterior al arranque, o null. */
function escapeDeCierre(frenos, sid, desde, escape = 'cerrar-la-ejecucion') {
  const inicio = Date.parse(desde || '');
  for (let i = frenos.length - 1; i >= 0; i--) {
    const l = frenos[i];
    if (l.freno !== 'safety-guard' || l.veredicto !== 'escape' || l.escape !== escape || l.sesion !== sid) continue;
    if (Number.isFinite(inicio) && !(Date.parse(l.ts) >= inicio)) continue;
    return l;
  }
  return null;
}

/** El `cierre` que deja `clear`. Uno ya escrito (`deuda`) se devuelve tal cual. */
function cierreDe(marker, { sid, home, ahora = new Date().toISOString() } = {}) {
  const m = marker || {};
  if (m.cierre && typeof m.cierre === 'object' && ESTADOS.includes(m.cierre.estado)) return m.cierre;
  const e = estado(m);
  if (!abierta(e)) {
    const motivo = motivoDe(e);
    return { estado: 'completa', ...(motivo ? { motivo } : {}), at: ahora };
  }
  const frenos = leerFrenos(home);
  const l = frenos ? escapeDeCierre(frenos, sid || m.sessionId, m.startedAt) : null;
  const via = l && ['persona', 'reenvio'].includes(l.via) ? l.via : 'sin-registro';
  const sinVia = frenos ? '; sin constancia de quién autorizó cerrar' : '; el registro de escapes no se pudo leer';
  const motivo = motivoDe(e) + (via === 'sin-registro' ? sinVia : '');
  return { estado: 'abortada', motivo, via, ...(l && l.relevo ? { relevo: l.relevo } : {}), at: ahora };
}

/**
 * Lo que el freno pregunta antes de un comando de `marker.js`: el marcador de la sesión. `hay: '?'` = existe y no se
 * pudo leer (el freno lo trata como abierto: no poder mirar no es estar terminada).
 */
function consulta(sid, home) {
  if (!sid || !/^[\w-]+$/.test(String(sid))) return { hay: false };
  let m;
  try { m = JSON.parse(fs.readFileSync(path.join(stateDir(home), 'active', `${sid}.json`), 'utf8')); } catch (err) {
    if (err && err.code === 'ENOENT') return { hay: false };
    return { hay: '?', motivo: `no pude leer el marcador de la sesión (${(err && (err.code || err.message)) || 'error'})` };
  }
  try {
    const e = estado(m);
    return { hay: true, autonomo: m.autonomous === true, abierta: abierta(e), motivo: motivoDe(e) };
  } catch (err) {
    return { hay: '?', motivo: `no pude leer el estado del marcador (${err.message})` };
  }
}

module.exports = { ESTADOS, requeridos, estado, abierta, motivoDe, leerFrenos, escapeDeCierre, cierreDe, consulta };

if (require.main === module) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  if (!process.argv.includes('--gate')) {
    process.stderr.write('uso: node run-close.js --gate --session <id>\n');
    process.exit(2);
  }
  const sid = arg('--session');
  const una = (v) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ');
  // con el comando por la entrada: las llamadas a marker.js que piden a la persona, ya cruzadas con el marcador
  let pedidas = null;
  if (process.argv.includes('--command-stdin')) {
    // el comando no se pudo leer o el lector falló: se trata como un cierre dudoso (no poder mirar no es poder pasar)
    const dudoso = (porque) => [{ l: { sub: null, args: [{ texto: porque, literal: true }] }, esc: 'cerrar la ejecución' }];
    try {
      const { llamadas, escapeDe } = require('./marker-command.js');
      const cmd = fs.readFileSync(0, 'utf8');
      pedidas = llamadas(cmd, { shell: arg('--shell') === 'powershell' ? 'powershell' : 'bash' })
        .map((l) => ({ l, esc: escapeDe(l, sid) })).filter((x) => x.esc);
    } catch (e) {
      pedidas = dudoso(`no pude leer el comando: ${e.message}`);
    }
    if (!pedidas.length) { process.stdout.write('hay=0\n'); process.exit(0); }
  }
  let r;
  try { r = consulta(sid); } catch (e) { r = { hay: '?', motivo: `no pude consultar la ejecución (${e.message})` }; }
  const hay = r.hay === '?' ? '?' : r.hay ? 1 : 0;
  process.stdout.write(`hay=${hay}\nautonomo=${r.autonomo ? 1 : 0}\nabierta=${r.abierta ? 1 : 0}\nmotivo=${una(r.motivo)}\n`);
  // un marcador que existe y no se puede leer se trata como abierto y con el modo autónomo prendido
  for (const { l, esc } of pedidas || []) {
    if (hay === 0) break;
    // cerrar como deuda pide la frase siempre que haya una ejecución: no depende de cómo esté
    const aplica = esc === 'cerrar como deuda' ? true : esc === 'set-autonomous' ? hay === '?' || r.autonomo : hay === '?' || r.abierta;
    if (aplica) process.stdout.write(`frena=${esc}\t${una(l.sub || '?')}\t${una(l.args[0] ? l.args[0].texto : '')}\n`);
  }
}
