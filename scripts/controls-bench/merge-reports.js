#!/usr/bin/env node
'use strict';
if (require.main === module) { try { require('../lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }

/**
 * merge-reports.js — junta los reportes del banco de controles de cada sistema en la foto de la noche.
 *
 * El trabajo de Linux corre casi todo el banco y saltea lo declarado para otro sistema; los de macOS y Windows corren
 * sólo eso (`runner.js --only-not-on linux`). Cada caso toma el resultado de quien lo corrió, y los contadores se vuelven
 * a calcular sobre la unión. Un caso que nadie pudo correr queda «no medido» con su motivo: nunca verde.
 *
 *   node scripts/controls-bench/merge-reports.js --base <linux> --add <macos> --add <windows> --out <reporte>
 *
 * El sistema de un `--add` sale del reporte y, si no se pudo leer, del nombre del archivo (`banco-darwin.json`).
 * Un trabajo sin reporte no frena la noche: sus casos quedan no medidos. Sin el de Linux sale 3 y no escribe nada.
 */
const fs = require('fs');
const path = require('path');

const CONTADORES = ['ran', 'failed', 'skipped', 'nomedido', 'parityBreaks', 'baselineRegressions'];
const TIEMPO_AGOTADO = 'con el tiempo agotado';

const sinCorrer = (r) => !r || r.skipped !== undefined;

function motivoDeNoMedido(r) {
  const texto = String((r.failures && r.failures[0]) || 'sin motivo');
  return /agotaron|tiempo/.test(texto) ? TIEMPO_AGOTADO : texto;
}

/** El reporte, o null si no se puede usar: no se lee, o sus contadores no son números. */
function leerReporte(ruta) {
  let r;
  try { r = JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch { return null; }
  if (!r || typeof r !== 'object' || !r.results || typeof r.results !== 'object') return null;
  return CONTADORES.every((k) => r[k] === undefined || (typeof r[k] === 'number' && Number.isFinite(r[k]))) ? r : null;
}

function sistemaDelArchivo(ruta) {
  const m = /(darwin|win32|linux)/.exec(path.basename(ruta));
  return m ? m[1] : null;
}

/** De dos resultados de un mismo caso, el que corrió; si corrieron los dos, el rojo. */
function elegir(actual, nuevo, so) {
  const corrio = (e) => Object.values(e.tools).some((r) => !sinCorrer(r));
  const rojo = (e) => Object.values(e.tools).some((r) => !sinCorrer(r) && !r.pass && !r.nomedido);
  const conTrabajo = { ...nuevo, trabajo: so };
  if (!actual || !corrio(actual)) return corrio(nuevo) || !actual ? conTrabajo : actual;
  if (!corrio(nuevo)) return actual;
  return rojo(nuevo) && !rojo(actual) ? { ...conTrabajo, repetido: true } : { ...actual, repetido: true };
}

/**
 * Junta `trabajos` (`[{ so, reporte|null, build?, estado? }]`, el primero es la base) con la línea de base `base`
 * (`{ caso: estabaVerde }`). Devuelve el reporte de la noche.
 */
function juntar(trabajos, base = {}) {
  const primero = trabajos[0].reporte;
  const results = {};
  for (const t of trabajos) {
    if (!t.reporte) continue;
    for (const [key, e] of Object.entries(t.reporte.results)) results[key] = elegir(results[key], e, t.so);
  }
  const conReporte = new Set(trabajos.filter((t) => t.reporte).map((t) => t.so));
  const sinReporte = new Set(trabajos.filter((t) => !t.reporte).map((t) => t.so));
  const cuenta = { ran: 0, failed: 0, skipped: 0, nomedido: 0, parityBreaks: 0, baselineRegressions: 0 };
  const nomedidoPorMotivo = {};
  const sumarMotivo = (m) => { cuenta.nomedido++; nomedidoPorMotivo[m] = (nomedidoPorMotivo[m] || 0) + 1; };
  for (const [key, e] of Object.entries(results)) {
    const herramientas = Object.values(e.tools);
    const salteadoAca = herramientas.length > 0 && herramientas.every((r) => r.skipped === true && r.motivo);
    if (salteadoAca) {
      const declarados = e.so || [];
      const delTrabajoCaido = declarados.find((s) => sinReporte.has(s) && !conReporte.has(s));
      let motivo = herramientas[0].motivo;
      if (delTrabajoCaido) motivo = `el trabajo de ${delTrabajoCaido} no dejó reporte`;
      else if (declarados.length) motivo = `ningún trabajo de la noche corre en ${declarados.join('/')}`;
      results[key] = { ...e, nomedido: true, motivo };
      sumarMotivo(motivo);
      continue;
    }
    for (const r of herramientas) {
      if (r.skipped === true) { cuenta.skipped++; continue; }
      if (r.skipped === false) continue;
      cuenta.ran++;
      if (r.nomedido) sumarMotivo(motivoDeNoMedido(r));
      else if (!r.pass && !r.known_gap) cuenta.failed++;
    }
    const { claude: a, codex: b } = e.tools;
    if (a && b && !a.skipped && !b.skipped && a.pass !== b.pass) cuenta.parityBreaks++;
  }
  for (const [key, estabaVerde] of Object.entries(base)) {
    const e = results[key];
    if (!e) { cuenta.baselineRegressions++; continue; }
    const ahora = e.tools.claude;
    if (estabaVerde && ahora && !e.nomedido && !ahora.skipped && !ahora.nomedido && !ahora.pass && !ahora.known_gap) cuenta.baselineRegressions++;
  }
  const carteles = {};
  for (const t of trabajos) for (const [k, n] of Object.entries((t.reporte && t.reporte.carteles) || {})) carteles[k] = (carteles[k] || 0) + n;
  return {
    ...primero,
    ...cuenta,
    skippedOs: 0,
    nomedidoPorMotivo,
    carteles,
    trabajos: trabajos.map((t) => ({ so: t.so, build: (t.reporte && t.reporte.build) || t.build || null, estado: t.reporte ? (t.reporte.estado || 'completo') : 'sin reporte' })),
    results,
  };
}

function main(argv) {
  const adds = [];
  let baseRuta = null;
  let out = null;
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === '--base') baseRuta = argv[i + 1];
    else if (argv[i] === '--add') adds.push(argv[i + 1]);
    else if (argv[i] === '--out') out = argv[i + 1];
    else { console.error(`merge-reports: opción desconocida ${argv[i]}`); return 2; }
  }
  if (!baseRuta || !out) { console.error('uso: merge-reports.js --base <reporte> [--add <reporte>]… --out <reporte>'); return 2; }
  const principal = leerReporte(baseRuta);
  if (!principal) {
    console.error(`merge-reports: no se puede leer el reporte de Linux (${baseRuta}): la noche no se da por medida`);
    return 3;
  }
  const trabajos = [{ so: principal.so || 'linux', reporte: principal }];
  for (const ruta of adds) {
    const reporte = leerReporte(ruta);
    const so = (reporte && reporte.so) || sistemaDelArchivo(ruta) || path.basename(ruta);
    if (!reporte) console.log(`merge-reports: el trabajo de ${so} no dejó reporte (${path.basename(ruta)}): sus casos quedan sin medir`);
    trabajos.push({ so, reporte });
  }
  const archivoBase = process.env.TYCON_BENCH_BASELINE || path.join(__dirname, 'baseline', 'claude.json');
  let base = {};
  let sinLineaDeBase = null;
  try { base = JSON.parse(fs.readFileSync(archivoBase, 'utf8')).cases || {}; } catch (e) { sinLineaDeBase = `no se pudo leer ${archivoBase}: ${e.message}`; }
  const junto = juntar(trabajos, base);
  // sin línea de base no se comparó: la cuenta no es cero, no existe
  if (sinLineaDeBase) Object.assign(junto, { baselineRegressions: null, sinLineaDeBase });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(junto, null, 2)}\n`);
  console.log(`merge-reports: ${junto.ran} corridos · ${junto.failed} rojos · ${junto.nomedido} sin medir · `
    + (sinLineaDeBase ? `regresiones sin comparar (${sinLineaDeBase})` : `regresiones ${junto.baselineRegressions}`));
  return 0;
}

module.exports = { juntar, leerReporte };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
