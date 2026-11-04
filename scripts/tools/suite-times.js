#!/usr/bin/env node
'use strict';
/*
 * suite-times.js — cuánto tarda cada suite: las más lentas, las corridas, y el renglón de la validación de Azure.
 *
 * El registro lo escriben el portón, las portables y la validación de Azure (skills/tycon-pipeline/scripts/lib/
 * suite-times.js dice dónde y cómo). Esto lo lee.
 *
 *   slow [--top <n>] [--from <archivo o carpeta>…] [--source <origen>] [--max-load <c>] [--json]
 *        las n (20) más lentas por mediana de sus últimas 5 mediciones, con el máximo, cuántas veces se midió y la
 *        tendencia (las últimas 5 contra las 5 anteriores: «sube» o «baja» si cambia más de 15 %). Arriba, de cuántas
 *        corridas salió, de qué fechas y de qué origen. Sin --from lee el registro de esta máquina. --from lee también
 *        el registro de una parte de la CI de GitHub (el renglón marcado `SUITE-TIMES`). --max-load deja sólo las
 *        corridas que arrancaron con esa carga o menos.
 *   runs [--last <n>] [--from …] [--source <origen>] [--json]
 *        una línea por corrida: fecha, origen, repo, suites, reloj, suma de las suites, trabajadores, núcleos y carga.
 *   record --tsv <archivo> --source <origen> --out <archivo> [--workers <n>] [--wall-ms <n>] [--repo <nombre>]
 *          [--carga <c>] [--suites <suites.json>]
 *        arma el renglón de una corrida desde un TSV `suite<TAB>ms<TAB>exit` y lo agrega a --out (lo usa el paso de
 *        suites de la validación de Azure, que corre en bash). --carga es la medida al arrancar el trabajo (sin ella,
 *        la de ahora); con --suites, el nombre del archivo de cada suite se anota como su `ruta` de suites.json.
 *
 * Sale 0 con lo pedido; 3 si no hay corridas que leer (nunca una lista vacía como si no hubiera lentas); 2 con un
 * pedido mal hecho; 1 si `record` no pudo escribir.
 */
const fs = require('fs');
const path = require('path');

const LIB = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'suite-times.js');
const st = require(LIB);

const USAGE = 'uso: suite-times.js slow [--top <n>] [--from <ruta>…] [--source <origen>] [--max-load <c>] [--json]\n'
  + '     suite-times.js runs [--last <n>] [--from <ruta>…] [--source <origen>] [--json]\n'
  + '     suite-times.js record --tsv <archivo> --source <origen> --out <archivo> [--workers <n>] [--wall-ms <n>] [--repo <nombre>] [--carga <c>] [--suites <suites.json>]\n';

function parse(argv) {
  const o = { cmd: argv[0], from: [], json: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined || v.startsWith('--')) throw new Error(`${a} pide un valor`); return v; };
    if (a === '--json') o.json = true;
    else if (a === '--from') o.from.push(val());
    else if (['--top', '--last', '--max-load', '--workers', '--wall-ms', '--carga'].includes(a)) {
      const n = Number(val());
      if (!Number.isFinite(n) || n < 0) throw new Error(`${a} no es un número`);
      // cero suites o cero corridas no es un pedido: `slice(-0)` las devolvería todas
      if ((a === '--top' || a === '--last') && (n < 1 || !Number.isInteger(n))) throw new Error(`${a} tiene que ser un entero mayor que 0`);
      o[a.slice(2).replace('-', '_')] = n;
    } else if (['--source', '--tsv', '--out', '--repo', '--suites'].includes(a)) o[a.slice(2)] = val();
    else throw new Error(`no conozco ${a}`);
  }
  return o;
}

const day = (ts) => String(ts).slice(0, 10);
const secs = (ms) => `${Math.round(ms / 1000)} s`;

function load(o) {
  let sources = o.from;
  if (!sources.length) {
    const t = st.target(process.env, { byDefault: true });
    if (!t.file) return { error: `no hay registro que leer (${t.why})` };
    sources = [t.file];
  }
  const read = st.readSources(sources);
  const runs = st.filterRuns(read.runs, { origen: o.source || null, maxLoad: o.max_load === undefined ? null : o.max_load });
  return { runs, read, sources };
}

function header(runs, read, o) {
  const origenes = {};
  for (const r of runs) origenes[r.origen] = (origenes[r.origen] || 0) + 1;
  const parts = [`de ${runs.length} ejecuciones (${Object.entries(origenes).map(([k, v]) => `${k} ${v}`).join(', ')})`,
    `del ${day(runs[0].ts)} al ${day(runs[runs.length - 1].ts)}`];
  if (o.max_load !== undefined) parts.push(`con carga de ${o.max_load} o menos al arrancar`);
  if (read.unreadable) parts.push(`${read.unreadable} renglón(es) ilegible(s)`);
  if (read.missing.length) parts.push(`no pude leer: ${read.missing.join(', ')}`);
  return { line: parts.join(' · '), origenes };
}

function noRuns(l, o) {
  const why = l.error || `no hay ejecuciones en ${l.sources.join(', ')}${o.source || o.max_load !== undefined ? ' que pasen el filtro' : ''}`;
  process.stdout.write(`suite-times: ${why.startsWith('no hay') ? why : `no hay ejecuciones: ${why}`}\n`);
  return 3;
}

function slowCmd(o) {
  const l = load(o);
  if (l.error || !l.runs.length) return noRuns(l, o);
  const rows = st.slow(l.runs, { top: o.top === undefined ? 20 : o.top });
  const h = header(l.runs, l.read, o);
  if (o.json) {
    process.stdout.write(`${JSON.stringify({ corridas: l.runs.length, origenes: h.origenes, desde: l.runs[0].ts, hasta: l.runs[l.runs.length - 1].ts,
      ilegibles: l.read.unreadable, suites: rows }, null, 2)}\n`);
    return 0;
  }
  const out = [`las ${rows.length} más lentas, ${h.line}`];
  for (const r of rows) out.push(`  ${secs(r.mediana).padStart(7)}  máx ${secs(r.max).padStart(7)}  n ${String(r.n).padStart(3)}  ${r.tendencia.padEnd(13)}  ${r.s}`);
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

function runsCmd(o) {
  const l = load(o);
  if (l.error || !l.runs.length) return noRuns(l, o);
  const rows = l.runs.slice(-(o.last === undefined ? 20 : o.last)).map(st.runRow);
  if (o.json) { process.stdout.write(`${JSON.stringify({ runs: rows }, null, 2)}\n`); return 0; }
  const out = [`${rows.length} ejecuciones, ${header(l.runs, l.read, o).line}`];
  for (const r of rows) {
    out.push(`  ${r.ts.slice(0, 16).replace('T', ' ')}  ${String(r.origen).padEnd(10)} ${String(r.repo).padEnd(22)} ${String(r.suites).padStart(4)} suites`
      + `  reloj ${secs(r.wall_ms || 0).padStart(7)}  suma ${secs(r.suma_ms).padStart(7)}  ${r.workers} a la vez · ${r.nucleos} núcleos · carga ${r.carga}${r.cortada ? '  (cortada)' : ''}`);
  }
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

function recordCmd(o) {
  if (!o.tsv || !o.source || !o.out) throw new Error('record pide --tsv, --source y --out');
  const byName = o.suites ? st.routesByName(fs.readFileSync(o.suites, 'utf8')) : null;
  const { suites, unreadable } = st.fromTsv(fs.readFileSync(o.tsv, 'utf8'), byName);
  const m = st.machine();
  const entry = st.entryOf({ origen: o.source, repo: o.repo || path.basename(process.cwd()), head: st.headOf(process.cwd()),
    workers: o.workers === undefined ? null : o.workers, nucleos: m.nucleos, carga: o.carga === undefined ? m.carga : o.carga,
    wallMs: o.wall_ms === undefined ? null : o.wall_ms, suites });
  const r = st.append(entry, path.resolve(o.out));
  if (!r.ok) { process.stderr.write(`suite-times: no pude anotar los tiempos: ${r.reason}\n`); return 1; }
  process.stdout.write(`suite-times: ${suites.length} suite(s) anotadas en ${r.file}${unreadable ? ` · ${unreadable} renglón ilegible del TSV` : ''}\n`);
  return 0;
}

function main(argv) {
  let o;
  try { o = parse(argv); } catch (e) { process.stderr.write(`suite-times: ${e.message}\n${USAGE}`); return 2; }
  try {
    if (o.cmd === 'slow') return slowCmd(o);
    if (o.cmd === 'runs') return runsCmd(o);
    if (o.cmd === 'record') return recordCmd(o);
  } catch (e) { process.stderr.write(`suite-times: ${e.message}\n${USAGE}`); return 2; }
  process.stderr.write(USAGE);
  return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { main };
