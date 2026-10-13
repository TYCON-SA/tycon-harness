#!/usr/bin/env node
/**
 * dashboard-series.js — EL CONSUMIDOR que nunca se escribió.
 *
 * El capturer viene emitiendo un archivo de métricas por merge desde el 2026-05-03. Nadie los
 * agregó nunca, así que nadie se enteró de que no se podían sumar (ver el encabezado de
 * `dashboard-metrics.js`, su vecino, para la medición completa). Este script es esa mitad que faltaba.
 *
 * 🔴 **Declara su propia cobertura, siempre.** Nunca imprime un promedio sin decir sobre cuántos
 * registros lo calculó. Un número sin denominador es exactamente el problema que este script
 * existe para arreglar — sería absurdo reproducirlo.
 *
 * 🔴 **`null` no es `0`.** Un registro sin la métrica no baja el promedio: sale del denominador.
 *
 * Uso:
 *   node scripts/lib/dashboard-series.js                    # la serie + el resumen
 *   node scripts/lib/dashboard-series.js --validate         # sale 1 si un archivo v2 viola el formato
 *   node scripts/lib/dashboard-series.js --json             # para consumir desde otra pieza
 *   node scripts/lib/dashboard-series.js --since 2026-08-01 # ventana
 *   node scripts/lib/dashboard-series.js --project totora    # un proyecto
 *   node scripts/lib/dashboard-series.js --dir <path>       # otro .dashboard
 */

'use strict';

const path = require('path');
const { METRICS, loadAll } = require('./dashboard-metrics.js');

const REPO = path.resolve(__dirname, '..', '..');   // el clon: este archivo vive en scripts/lib/
// dónde vive `.dashboard` en esta máquina lo sabe tycon-home.js (story 8.23, tanda D): en una instalación bajada es
// ~/.tycon/state/dashboard; en un clon, el de siempre. Si el archivo viaja suelto, el de siempre.
function dashboardDefault() {
  // lo que escribe la máquina vive donde dice scripts/lib/night-data.js (story 8.26, tanda J): en una versión bajada, el
  // clon de mantenimiento que la máquina declara; nunca el del público. Sin esa biblioteca al lado, lo de antes.
  // (si la biblioteca ESTÁ y no carga, tira: no se vuelve callado a la ruta de antes; si no pudo saber, lo avisa ella)
  { const lib = path.join(__dirname, 'night-data.js'); if (require('fs').existsSync(lib)) { const d = require(lib).machineDashboardDir(REPO); if (d) return d; } }
  try {
    const TH = require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'));
    const d = typeof TH.dashboardDir === 'function' ? TH.dashboardDir(require('os').homedir(), REPO) : null;
    if (d) return d;
  } catch (_) { /* el de siempre */ }
  return path.join(REPO, '.dashboard');
}

function parseArgs(argv) {
  const a = { dir: dashboardDefault(), since: null, until: null, project: null,
              json: false, validate: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--json') a.json = true;
    else if (k === '--validate') a.validate = true;
    else if (k === '--verbose' || k === '-v') a.verbose = true;
    else if (k === '--dir') a.dir = argv[++i];
    else if (k === '--since') a.since = argv[++i];
    else if (k === '--until') a.until = argv[++i];
    else if (k === '--project') a.project = argv[++i];
    else if (k === '--help' || k === '-h') a.help = true;
  }
  return a;
}

function stats(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((x, y) => x - y);
  const mean = nums.reduce((t, n) => t + n, 0) / nums.length;
  const mid = Math.floor(s.length / 2);
  const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return { n: nums.length, mean, median, min: s[0], max: s[s.length - 1], sum: nums.reduce((t, n) => t + n, 0) };
}

/**
 * La tendencia se calcula sobre los registros CON fecha, en orden cronológico, y sólo si son
 * suficientes: ≥60 % de la ventana con fecha confiable y ≥6 valores. Si no, devuelve el motivo —
 * y el reporte lo imprime en vez de una flecha. Con los datos del 2026-09-05 (26 de 125 con
 * `captured_at`) el resultado correcto es NO dibujar tendencia.
 */
const MIN_COBERTURA_FECHAS = 0.6;
const MIN_VALORES_TENDENCIA = 6;
function tendencia(dated, total) {
  // "Confiable" = declarada ADENTRO del archivo. La del nombre es inferida: ordena, pero no cuenta
  // para decidir si la serie merece una flecha.
  const declaradas = dated.filter((r) => r.date_source && r.date_source !== 'filename').length;
  const cobertura = total ? declaradas / total : 0;
  if (cobertura < MIN_COBERTURA_FECHAS) {
    return { ok: false, cobertura, motivo: `sólo ${Math.round(cobertura * 100)}% de los registros tiene fecha declarada adentro (mínimo ${MIN_COBERTURA_FECHAS * 100}%; la del nombre del archivo no cuenta)` };
  }
  const vals = dated.map((r) => r.values.advisor_warnings_per_story).filter((v) => v !== null);
  if (vals.length < MIN_VALORES_TENDENCIA) {
    return { ok: false, cobertura, motivo: `sólo ${vals.length} valor(es) con fecha para esta métrica (mínimo ${MIN_VALORES_TENDENCIA})` };
  }
  const h = Math.floor(vals.length / 2);
  const primera = stats(vals.slice(0, h)), segunda = stats(vals.slice(h));
  return { ok: true, cobertura, desde: dated[0].date, hasta: dated[dated.length - 1].date, primera, segunda, delta: segunda.mean - primera.mean };
}

function fmt(n, d = 1) {
  if (n === null || n === undefined) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(d);
}

function bar(v, max, width = 22) {
  if (!max || v === null) return '';
  const k = Math.max(1, Math.round((v / max) * width));
  return '█'.repeat(k);
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) {
    console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?|^ \* ?/gm, ''));
    process.exit(0);
  }

  const { records, counts, dir } = loadAll(a.dir);

  // ── modo validador: sólo mira los v2 rotos ────────────────────────────────────────────────
  if (a.validate) {
    const bad = records.filter((r) => r.status === 'invalid' || r.status === 'unreadable');
    if (!bad.length) {
      console.log(`✅ dashboard-series: ${counts.v2ok} archivo(s) en formato 2.0 válidos · ${counts.legacy} legacy (no se validan) · 0 rotos`);
      process.exit(0);
    }
    console.error(`❌ dashboard-series: ${bad.length} archivo(s) violan el formato 2.0\n`);
    for (const r of bad) {
      console.error(`  ${r.file}`);
      for (const e of (r.errors || ['no se pudo parsear el JSON'])) console.error(`     · ${e}`);
    }
    console.error('\nEl formato vive en scripts/lib/dashboard-metrics.js. Recordá: una métrica no');
    console.error('medida se declara con value:null + unavailable_reason, NUNCA con 0.');
    process.exit(1);
  }

  // ── filtros ────────────────────────────────────────────────────────────────────────────────
  // 🔴 Todo filtro REPORTA cuántos registros dejó afuera y por qué (2026-09-05). Antes, con la
  // fecha leída de un solo campo, `--since` descartaba 99 de 125 en silencio: un denominador que
  // se achica sin decirlo se lee igual que uno completo.
  let rows = records.filter((r) => r.status === 'ok' || r.status === 'legacy');
  const antesDeVentana = rows.length;
  const sinFecha = rows.filter((r) => !r.date).length;
  if (a.since) rows = rows.filter((r) => r.date && r.date >= a.since);
  if (a.until) rows = rows.filter((r) => r.date && r.date <= a.until);
  const fueraDeVentana = antesDeVentana - rows.length;
  if (a.project) {
    const q = a.project.toLowerCase();
    rows = rows.filter((r) => (r.project || '').toLowerCase().includes(q));
  }

  // 🔴 El orden cronológico se arma SÓLO con los que tienen fecha. Ordenar por `String(date)` con
  // nulos ponía "null" después de cualquier fecha: la "segunda mitad" mezclaba mayo con septiembre.
  const dated = rows.filter((r) => r.date).sort((x, y) => x.date.localeCompare(y.date));
  const dateSources = {};
  for (const r of rows) { const k = r.date_source || 'ninguna'; dateSources[k] = (dateSources[k] === undefined ? 0 : dateSources[k]) + 1; }
  const dateConflicts = rows.filter((r) => r.date_conflict).length;

  const series = {};
  for (const [name] of Object.entries(METRICS)) {
    series[name] = stats(rows.map((r) => r.values[name]).filter((v) => v !== null));
  }
  const trend = tendencia(dated, rows.length);

  if (a.json) {
    console.log(JSON.stringify({
      dir, counts, filtered: rows.length,
      window: { since: dated[0] ? dated[0].date : null, until: dated.length ? dated[dated.length - 1].date : null },
      dated: dated.length, undated: rows.length - dated.length, date_sources: dateSources, date_conflicts: dateConflicts,
      excluded_by_window: fueraDeVentana, undated_before_window: sinFecha,
      series, trend, records: a.verbose ? rows : undefined,
    }, null, 2));
    process.exit(0);
  }

  // ── reporte ────────────────────────────────────────────────────────────────────────────────
  const W = 78;
  console.log('═'.repeat(W));
  console.log('  SERIE DE MÉTRICAS DEL ARNÉS');
  console.log('═'.repeat(W));
  console.log(`  origen: ${dir}`);

  console.log('\n  COBERTURA — cuántos de los registros se pueden usar de verdad');
  console.log('  ' + '─'.repeat(W - 4));
  const pct = (n) => counts.total ? ` (${Math.round(n / counts.total * 100)}%)` : '';
  console.log(`    ${String(counts.total).padStart(4)}  registros en total`);
  console.log(`    ${String(counts.v2ok).padStart(4)}  en formato 2.0, válidos${pct(counts.v2ok)}   ← los que suman`);
  console.log(`    ${String(counts.legacy).padStart(4)}  en formato viejo${pct(counts.legacy)}   ← se leen si el número es inequívoco`);
  console.log(`    ${String(counts.v2bad).padStart(4)}  en formato 2.0 pero rotos${pct(counts.v2bad)}`);
  console.log(`    ${String(counts.unreadable).padStart(4)}  ilegibles${pct(counts.unreadable)}`);

  if (!rows.length) {
    console.log('\n  Sin registros en la ventana pedida.\n');
    process.exit(0);
  }

  const desde = dated[0] ? dated[0].date : '?';
  const hasta = dated.length ? dated[dated.length - 1].date : '?';
  const projs = new Set(rows.map((r) => r.project).filter(Boolean));
  console.log(`\n  VENTANA — ${rows.length} registro(s), ${desde} → ${hasta}, ${projs.size} proyecto(s)`);
  const fuentes = Object.entries(dateSources).map(([k, v]) => `${k} ${v}`).join(' · ');
  console.log(`    con fecha: ${dated.length} (${fuentes})   sin fecha: ${rows.length - dated.length}${dateConflicts ? `   ⚠️  ${dateConflicts} con fecha declarada distinta a la del nombre` : ''}`);
  if (a.since || a.until) {
    console.log(`    fuera de la ventana pedida: ${fueraDeVentana} registro(s)${sinFecha ? ` — de los cuales ${sinFecha} salieron por NO TENER FECHA, no por estar fuera` : ''}`);
  }

  console.log('\n  LAS MÉTRICAS');
  console.log('  ' + '─'.repeat(W - 4));
  for (const [name, spec] of Object.entries(METRICS)) {
    const s = series[name];
    console.log(`\n    ${spec.label}`);
    console.log(`    ${name}`);
    if (!s) {
      console.log(`      sin dato utilizable en ninguno de los ${rows.length} registros`);
      continue;
    }
    const cob = Math.round(s.n / rows.length * 100);
    const media = spec.kind === 'ratio' ? `${(s.mean * 100).toFixed(0)}%` : fmt(s.mean);
    console.log(`      media ${media}  ·  mediana ${fmt(s.median)}  ·  rango ${fmt(s.min)}–${fmt(s.max)}`);
    console.log(`      medido en ${s.n} de ${rows.length} registros (${cob}%)${cob < 50 ? '   ⚠️  cobertura baja: la media dice poco' : ''}`);
  }

  // tendencia sobre la métrica principal — sólo si la ventana tiene fecha confiable
  console.log('\n  TENDENCIA — hallazgos nuevos por story');
  console.log('  ' + '─'.repeat(W - 4));
  if (!trend.ok) {
    console.log(`    sin tendencia: ${trend.motivo}.`);
    console.log('    Una flecha sobre registros sin fecha ordena "null" después de cualquier mes: no significa nada.');
  } else {
    const { primera: a1, segunda: a2 } = trend;
    const mx = Math.max(a1.mean, a2.mean);
    console.log(`    ${trend.desde} → ${trend.hasta} · ${Math.round(trend.cobertura * 100)}% de los registros con fecha`);
    console.log(`    primera mitad (${a1.n})  ${fmt(a1.mean)}  ${bar(a1.mean, mx)}`);
    console.log(`    segunda mitad (${a2.n})  ${fmt(a2.mean)}  ${bar(a2.mean, mx)}`);
    const d = trend.delta;
    console.log(`    → ${d === 0 ? 'sin cambio' : (d < 0 ? 'bajando' : 'subiendo')} ${d !== 0 ? fmt(Math.abs(d)) + ' hallazgos por story' : ''}`);
  }

  console.log('\n  ' + '─'.repeat(W - 4));
  if (counts.v2ok < 10) {
    console.log('  🔴 TODAVÍA NO HAY SERIE. Sólo ' + counts.v2ok + ' registro(s) en el formato nuevo.');
    console.log('     Hacen falta ~2-3 semanas de capturas válidas antes de que estos números');
    console.log('     signifiquen algo. Hasta entonces son anécdotas con promedio.');
  } else {
    console.log(`  ✅ Serie utilizable: ${counts.v2ok} registros en formato válido.`);
  }
  console.log('');
}

if (require.main === module) main();
module.exports = { stats, tendencia };
