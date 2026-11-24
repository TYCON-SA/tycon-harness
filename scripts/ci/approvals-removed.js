#!/usr/bin/env node
'use strict';
/*
 * approvals-removed.js — la cuenta de la noche de las constancias del dueño que salieron de main.
 *
 * Una constancia del dueño (`.github/control-changes/`, `.tycon/control-changes/` y sus registros `.jsonl`) es lo que
 * deja escrito que el dueño firmó un cambio de control. La revisión de un pedido pide su firma para borrarla, pero sólo
 * mira lo que estaba en el ancestro del pedido: una constancia que trajo main mientras el pedido estaba abierto se le
 * escapa. Esta cuenta mira lo que entró a main desde la medición anterior (la punta que guardó su foto; la primera vez,
 * el último día por fecha), así que una noche que no corrió no deja un hueco, y separa las que salieron con la firma del dueño para ese
 * borrado de las que salieron sin ella.
 *
 * La comparación no se escribe acá: la hace `run-base-controls.sh removed-approvals`, el mismo guion que juzga los
 * pedidos, para que la noche y la revisión no puedan decir cosas distintas.
 *
 *   node scripts/ci/approvals-removed.js [--root <repo>] [--ref main] [--now <fecha>] [--out <foto>] [--fresh]
 *   (`--fresh`: no seguir desde la foto anterior, mirar el último día por fecha)
 *
 * Escribe la foto (por omisión scripts/controls-bench/ultimo-constancias.json, al lado de las otras de la noche):
 * `{ kind, ts, ref, desde, hasta, medido, con_firma, sin_firma, motivo }`. La lee el aviso del banco al arrancar
 * (scripts/hooks/bench-notice.js). Sale 0 con la cuenta medida, aunque haya borrados sin firma (lo dice el aviso), y 3
 * sin poder medirla: entonces la foto dice «no medido» y el motivo, nunca cero.
 *
 * Un borrado sin firma se sigue diciendo una semana desde la noche en que se vio (`avisada_desde`): la foto siguiente lo
 * arrastra, también si esa noche no pudo medir, para que no pase sin que nadie lo vea. Una foto anterior que existe y no
 * se lee no se pisa: la medición sale «no medido» y la deja como está (`--fresh` empieza de nuevo a conciencia).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIA_MS = 24 * 3600 * 1000;
// cuánto se sigue diciendo un borrado sin firma después de la noche en que se vio: una semana de arranques para verlo
const AVISO_MS = 7 * DIA_MS;
const NO_MEDIDO = 3;

function opt(argv, name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}

/**
 * La cuenta del guion de la revisión, como objeto; nunca lanza: lo que no se pudo medir vuelve con `medido: false`. Con
 * `from` (la punta que vio la medición anterior) cuenta lo que entró desde ahí; sin él, la ventana `desde`–`hasta`.
 */
function contar({ root, ref, desde, hasta, from }) {
  const guion = path.join(__dirname, 'run-base-controls.sh');
  const rango = from ? ['--from', from] : ['--since', desde, '--until', hasta];
  const r = spawnSync('bash', [guion, 'removed-approvals', '--root', root, '--ref', ref, ...rango], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { medido: false, motivo: `no pude correr ${guion}: ${r.error.message}` };
  const renglon = String(r.stdout || '').trim().split('\n').pop();
  let datos = null;
  try { datos = JSON.parse(renglon); } catch (_) { datos = null; }
  if (!datos || typeof datos !== 'object') {
    return { medido: false, motivo: `el guion de la revisión salió ${r.status} sin decir qué midió${r.stderr ? ` (${String(r.stderr).trim().split('\n')[0]})` : ''}` };
  }
  if (datos.medido !== true) return { medido: false, motivo: datos.motivo || `el guion de la revisión salió ${r.status}` };
  if (!Array.isArray(datos.con_firma) || !Array.isArray(datos.sin_firma) || typeof datos.tip !== 'string') return { medido: false, motivo: 'el guion de la revisión dio una cuenta sin sus listas o sin la punta que miró' };
  return datos;
}

/**
 * Desde dónde sigue esta medición: la punta que vio la última que midió (una foto que no midió la conserva). Sin foto
 * anterior, o con una sin punta, se mira el último día por fecha, y la foto lo dice con `desde_punta` en null. Una foto
 * que existe y no se lee vuelve como `{ ilegible }`: no es «no hay foto», y quien la lee no la pisa.
 */
function anterior(out) {
  let texto;
  try { texto = fs.readFileSync(out, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    return { ilegible: `no pude leer la foto anterior ${out} (${e.code || e.message})` };
  }
  let prev = null;
  try { prev = JSON.parse(texto); } catch (e) { return { ilegible: `la foto anterior ${out} no es JSON (${e.message})` }; }
  if (!prev || typeof prev !== 'object' || Array.isArray(prev)) return { ilegible: `la foto anterior ${out} no es un objeto` };
  // una foto sin punta (la primera medición, que falló) igual sirve: su `desde` es dónde empieza lo que falta mirar
  return { ...prev, tip: typeof prev.tip === 'string' && /^[0-9a-f]{40,64}$/.test(prev.tip) ? prev.tip : null };
}

/**
 * Los borrados sin firma de la foto anterior que todavía se dicen: los de menos de una semana desde la noche en que se
 * vieron. Uno sin fecha de aviso (de una foto de antes de este arrastre) cuenta desde el final de la ventana que lo vio.
 */
function arrastrados(prev, ahora) {
  if (!prev || !Array.isArray(prev.sin_firma)) return [];
  return prev.sin_firma.filter((x) => x && typeof x === 'object' && typeof x.path === 'string').map((x) => {
    const desde = typeof x.avisada_desde === 'string' && !Number.isNaN(Date.parse(x.avisada_desde)) ? x.avisada_desde : (prev.hasta || null);
    return { ...x, avisada_desde: desde };
  }).filter((x) => x.avisada_desde !== null && ahora - Date.parse(x.avisada_desde) < AVISO_MS);
}

/** Los arrastrados más los nuevos, sin repetir un mismo borrado (ruta y commit): el que ya se avisaba conserva su fecha. */
function juntar(viejos, nuevos, hasta) {
  const clave = (x) => `${x.path}\u0000${x.commit}`;
  const vistos = new Set(viejos.map(clave));
  return [...viejos, ...nuevos.filter((x) => !vistos.has(clave(x))).map((x) => ({ ...x, avisada_desde: hasta }))];
}

function main(argv) {
  const root = path.resolve(opt(argv, '--root', '.'));
  const ref = opt(argv, '--ref', 'main');
  const ahora = opt(argv, '--now') ? Date.parse(opt(argv, '--now')) : Date.now();
  if (Number.isNaN(ahora)) { console.error('approvals-removed: --now pide una fecha'); return 2; }
  const out = path.resolve(opt(argv, '--out', path.join(__dirname, '..', 'controls-bench', 'ultimo-constancias.json')));
  const prev = argv.includes('--fresh') ? null : anterior(out);
  if (prev && prev.ilegible) {
    console.log(`constancias del dueño que salieron de ${ref}: no medido (${prev.ilegible}; no la piso: arreglala, o corré con --fresh para empezar de nuevo)`);
    return NO_MEDIDO;
  }
  const hasta = new Date(ahora).toISOString();
  // la ventana que se cubre: desde lo último medido (una noche que no midió no corre el comienzo)
  const desde = prev ? ((prev.medido === true ? prev.hasta : prev.desde) || new Date(ahora - DIA_MS).toISOString()) : new Date(ahora - DIA_MS).toISOString();
  const c = contar({ root, ref, desde, hasta, from: prev ? prev.tip : null });
  // sin medir, la punta de la anterior se conserva: la próxima noche sigue desde ahí y no salta lo que esta no vio
  const tip = c.medido === true ? c.tip : (prev ? prev.tip : null);
  // los sin firma de noches anteriores siguen en la lista su semana, aunque esta noche no haya medido
  const sinFirma = juntar(arrastrados(prev, ahora), c.medido === true ? c.sin_firma : [], hasta);
  const foto = {
    kind: 'constancias-borradas', ts: new Date().toISOString(), ref, desde, hasta, desde_punta: prev ? prev.tip : null, tip,
    medido: c.medido === true, con_firma: c.medido === true ? c.con_firma : [], sin_firma: sinFirma,
    ...(c.medido === true ? {} : { motivo: c.motivo }),
  };
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(foto, null, 2)}\n`);
  } catch (e) {
    console.error(`approvals-removed: no pude escribir la foto ${out}: ${e.message}`);
    return NO_MEDIDO;
  }
  if (!foto.medido) {
    console.log(`constancias del dueño que salieron de ${ref} desde la medición anterior: no medido (${foto.motivo})`);
    return NO_MEDIDO;
  }
  const deAntes = foto.sin_firma.filter((x) => x.avisada_desde !== hasta).length;
  console.log(`constancias del dueño que salieron de ${ref} ${prev ? 'desde la medición anterior' : 'en el último día'}: ${foto.sin_firma.length} sin firma${deAntes ? ` (${deAntes} de noches anteriores, se dicen una semana)` : ''} · ${foto.con_firma.length} con la firma del dueño`);
  for (const x of foto.sin_firma) console.log(`   sin firma: ${x.path} (${String(x.commit).slice(0, 12)}, avisada desde ${String(x.avisada_desde).slice(0, 10)})`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { contar, main };
