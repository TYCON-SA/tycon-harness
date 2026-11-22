#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('../lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
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
 *   repeats [--log <gates.log>] [--since <fecha u hora>] [--until <fecha u hora>] [--by-story] [--story <id>] [--json]
 *        las corridas del portón por día, en hora local: cuántas y cuántas horas de primeras, repetidas enteras,
 *        acotadas y sin correr, y las enteras agrupadas por motivo. Con --by-story, por historia (para la retro: cuántas
 *        corridas y cuánto tiempo se llevó cada una); con --story, sólo las de esa historia. Lee los renglones `test-gate-run` de gates.log (sin
 *        --log, el de la carpeta de estado de esta máquina). Los días de antes de ese renglón se clasifican por el
 *        comando del check `tests` del portón: sin poder distinguir, cuenta como entera; nunca achica las repeticiones.
 *        Una fecha sola (AAAA-MM-DD) es el día entero; con hora (AAAA-MM-DDTHH:MM), ese momento.
 *
 * Sale 0 con lo pedido; 3 si no hay corridas que leer (nunca una lista vacía como si no hubiera lentas, ni «0 h» como si
 * no hubiera repeticiones); 2 con un pedido mal hecho; 1 si `record` no pudo escribir.
 */
const fs = require('fs');
const path = require('path');

const LIB = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'suite-times.js');
const st = require(LIB);

const USAGE = 'uso: suite-times.js slow [--top <n>] [--from <ruta>…] [--source <origen>] [--max-load <c>] [--json]\n'
  + '     suite-times.js runs [--last <n>] [--from <ruta>…] [--source <origen>] [--json]\n'
  + '     suite-times.js record --tsv <archivo> --source <origen> --out <archivo> [--workers <n>] [--wall-ms <n>] [--repo <nombre>] [--carga <c>] [--suites <suites.json>]\n'
  + '     suite-times.js repeats [--log <gates.log>] [--since <fecha u hora>] [--until <fecha u hora>] [--by-story] [--story <id>] [--json]\n';

function parse(argv) {
  const o = { cmd: argv[0], from: [], json: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined || v.startsWith('--')) throw new Error(`${a} pide un valor`); return v; };
    if (a === '--json') o.json = true;
    else if (a === '--by-story') o.by_story = true;
    else if (a === '--from') o.from.push(val());
    else if (['--top', '--last', '--max-load', '--workers', '--wall-ms', '--carga'].includes(a)) {
      const n = Number(val());
      if (!Number.isFinite(n) || n < 0) throw new Error(`${a} no es un número`);
      // cero suites o cero corridas no es un pedido: `slice(-0)` las devolvería todas
      if ((a === '--top' || a === '--last') && (n < 1 || !Number.isInteger(n))) throw new Error(`${a} tiene que ser un entero mayor que 0`);
      o[a.slice(2).replace('-', '_')] = n;
    } else if (['--source', '--tsv', '--out', '--repo', '--suites', '--log', '--since', '--until', '--story'].includes(a)) o[a.slice(2)] = val();
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

// ── repeats: las horas de repetición del portón por día ───────────────────────────────────────────────────────────────
// los modos del renglón `test-gate-run` (los escribe test-gate.sh): son datos del registro, no nombres de comandos
const MODOS = ['primera', 'entera', 'acotada', 'sin correr'];
const [PRIMERA, ENTERA] = MODOS;
/** La clave del modo en la salida JSON: sin espacios. */
const claveDe = (modo) => modo.replace(/ /g, '_');
const SIN_MOTIVO = 'sin motivo: de antes del registro';

/** El momento de `--since`/`--until`: una fecha sola es el día entero (desde su comienzo, o hasta su final). */
function momento(v, hasta) {
  const opcion = hasta ? '--until' : '--since';
  const p = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (!p) throw new Error(`${opcion} pide AAAA-MM-DD o AAAA-MM-DDTHH:MM, no «${v}»`);
  const [a, m, d, hh = 0, mm = 0, ss = 0] = p.slice(1).map((x) => (x === undefined ? undefined : Number(x)));
  // Date corre en silencio un 31 de febrero al 3 de marzo y da NaN con las 25:00: la fecha tiene que volver tal cual
  const f = new Date(a, m - 1, d, hh, mm, ss);
  if (f.getFullYear() !== a || f.getMonth() !== m - 1 || f.getDate() !== d || f.getHours() !== hh || f.getMinutes() !== mm || f.getSeconds() !== ss) {
    throw new Error(`${opcion}: la fecha «${v}» no existe`);
  }
  if (p[4] !== undefined) return f.getTime();
  return new Date(a, m - 1, d + (hasta ? 1 : 0)).getTime() - (hasta ? 1 : 0);
}

const diaLocal = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/**
 * Un check `tests` del portón de antes del renglón `test-gate-run`: la corrida que no se puede atar a un modo cuenta como
 * completa (primera o entera). Devuelve null si no es una corrida del portón que terminó (la que no corrió nada, la
 * cortada, una suite sola, la mitad juntada de un cierre acotado, un comando que no es el corredor), y
 * `{ ilegible: true }` si salió con un código que no se sabe leer: no se sabe qué midió. La de un repo hermano la saca
 * después su renglón `run-check-companion`.
 */
function deUnCheck(c) {
  const cmd = String(c.cmd || '');
  if (c.check !== 'tests' || c.provenance !== 'test-gate') return null;
  if (/ --suite /.test(cmd)) return null;
  const merge = /failed-first\.js merge/.test(cmd);
  if (merge && / --new /.test(cmd)) return null;
  if (!merge && !/run-suites-json\.js/.test(cmd)) return null;
  // 7 (el hermano no se pudo acotar), 75 (otra corrida), 76 (rojas sin repetir) y 77 (sin turno) no corrieron nada; más de
  // 128 es una corrida cortada por una señal: ninguna terminó
  if ([7, 75, 76, 77].includes(c.exit) || c.exit > 128) return null;
  if (c.exit !== 0 && c.exit !== 1) return { ilegible: true };
  let modo = null;
  if (merge) modo = 'sin correr';
  else if (/touched-repetidas\.json/.test(cmd)) modo = 'acotada';
  else if (/arbol-privado/.test(cmd) && / --scoped-by-repo /.test(cmd) && !/ --only-touched/.test(cmd)) modo = 'acotada';
  return { t: Date.parse(c.ts), ses: c.sessionId || '?', story: c.storyId || null, modo, motivo: null, ms: Number(c.durationMs) || 0, cmd };
}

function repeatsCmd(o) {
  const { stateDir } = require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
  const file = o.log ? path.resolve(o.log) : path.join(stateDir(), 'gates.log');
  const desde = o.since ? momento(o.since, false) : -Infinity;
  const hasta = o.until ? momento(o.until, true) : Infinity;
  let texto;
  try { texto = fs.readFileSync(file, 'utf8'); } catch (e) {
    process.stdout.write(`suite-times: no hay ejecuciones que leer (${file}: ${e.code || e.message})\n`);
    return 3;
  }
  const corridas = [];
  const checks = [];
  const hermanos = [];
  // lo que parecía una corrida y no se pudo leer (un renglón cortado, una hora o un modo que no se entienden): no cuenta,
  // y se dice cuánto fue, para que «menos repeticiones» nunca salga de no haber podido leer
  let descartados = 0;
  for (const l of texto.split('\n')) {
    if (!l.includes('"test-gate-run"') && !l.includes('"check":"tests"')) continue;
    let j;
    try { j = JSON.parse(l); } catch (_) { descartados += 1; continue; }
    if (j.name === 'test-gate-run') {
      corridas.push({ t: Date.parse(j.ts), ses: j.sessionId || '?', story: j.story || null, modo: j.modo, motivo: j.motivo || null, ms: Number(j.duracion_ms) || 0 });
    } else if (j.name === 'run-check-companion') {
      const t = Date.parse(j.ts);
      if (Number.isFinite(t)) hermanos.push({ t, ses: j.sessionId || '?', cmd: String(j.cmd || '') });
      else descartados += 1;
    } else if (j.check === 'tests') {
      const c = deUnCheck(j);
      if (c && c.ilegible) descartados += 1;
      else if (c) checks.push(c);
    }
  }
  // una corrida con su renglón también dejó su check: el check que cae dentro de ella (misma sesión) no se cuenta
  const cubierto = (c) => corridas.some((r) => r.ses === c.ses && c.t <= r.t && c.t >= r.t - r.ms - 60000);
  // la corrida de un repo hermano es parte de la que la lanzó: `run-check` deja, al lado de su check, un renglón con el
  // mismo comando y la misma sesión. Cada marca saca un solo check, el más cercano: el mismo comando en el repo de arriba
  // unos segundos antes no se pierde del informe
  const deHermano = new Set();
  for (const h of hermanos) {
    let mejor = null;
    for (const c of checks) {
      if (deHermano.has(c) || c.ses !== h.ses || c.cmd !== h.cmd || Math.abs(h.t - c.t) > 10000) continue;
      if (!mejor || Math.abs(h.t - c.t) < Math.abs(h.t - mejor.t)) mejor = c;
    }
    if (mejor) deHermano.add(mejor);
  }
  const leibles = [...corridas, ...checks.filter((c) => !cubierto(c) && !deHermano.has(c))];
  const todas = leibles.filter((x) => Number.isFinite(x.t) && (!x.modo || MODOS.includes(x.modo))).sort((a, b) => a.t - b.t);
  descartados += leibles.length - todas.length;
  const aviso = descartados ? `${descartados} renglón(es) de ejecuciones que no pude leer: no cuentan` : null;
  const vistas = new Set();
  const dias = new Map();
  // por día, o por historia con --by-story (para la retro: cuántas corridas y cuánto tiempo se llevó cada una)
  const campo = o.by_story ? 'historia' : 'dia';
  for (const x of todas) {
    const clave = `${x.story || '?'}|${x.ses}`;
    let modo = x.modo;
    let motivo = x.motivo;
    if (!modo) { modo = vistas.has(clave) ? ENTERA : PRIMERA; if (modo === ENTERA) motivo = SIN_MOTIVO; }
    vistas.add(clave);
    if (x.t < desde || x.t > hasta) continue;
    if (o.story && String(x.story) !== String(o.story)) continue;
    const dia = o.by_story ? (x.story ? String(x.story) : 'sin historia') : diaLocal(x.t);
    if (!dias.has(dia)) dias.set(dia, { [campo]: dia, total: { n: 0, ms: 0 }, primera: { n: 0, ms: 0 }, entera: { n: 0, ms: 0 }, acotada: { n: 0, ms: 0 }, sin_correr: { n: 0, ms: 0 }, motivos: new Map() });
    const d = dias.get(dia);
    const k = claveDe(modo);
    d[k].n += 1;
    d[k].ms += x.ms;
    d.total.n += 1;
    d.total.ms += x.ms;
    if (modo === ENTERA) {
      const m = d.motivos.get(motivo || SIN_MOTIVO) || { motivo: motivo || SIN_MOTIVO, n: 0, ms: 0 };
      m.n += 1;
      m.ms += x.ms;
      d.motivos.set(m.motivo, m);
    }
  }
  if (!dias.size) {
    const filtro = [o.since || o.until ? 'en ese rango' : '', o.story ? `de la historia ${o.story}` : ''].filter(Boolean).join(' ');
    process.stdout.write(`suite-times: no hay ejecuciones que leer en ${file}${filtro ? ` ${filtro}` : ''}${aviso ? ` (${aviso})` : ''}\n`);
    return 3;
  }
  const filas = [...dias.values()].sort((a, b) => a[campo].localeCompare(b[campo], undefined, { numeric: true })).map(({ motivos, ...d }) => ({
    ...d, enteras_por_motivo: [...motivos.values()].sort((a, b) => b.ms - a.ms || a.motivo.localeCompare(b.motivo)) }));
  if (o.json) {
    process.stdout.write(`${JSON.stringify({ log: file, desde: o.since || null, hasta: o.until || null, historia: o.story || null, descartados, [o.by_story ? 'historias' : 'dias']: filas }, null, 2)}\n`);
    return 0;
  }
  const horas = (ms) => `${(ms / 3600000).toFixed(1).replace('.', ',')} h`;
  const out = [`ejecuciones del portón por ${o.by_story ? 'historia' : 'día'}, de ${file}`];
  for (const d of filas) {
    out.push(o.by_story ? `${d.historia}: ${d.total.n} ejecución(es), ${horas(d.total.ms)}` : d.dia);
    for (const modo of MODOS) {
      const v = d[claveDe(modo)];
      out.push(`  ${modo.padEnd(11)} ${String(v.n).padStart(3)} ejecución(es), ${horas(v.ms)}`);
    }
    for (const m of d.enteras_por_motivo) out.push(`      ${String(m.n).padStart(3)} · ${horas(m.ms).padStart(7)} · ${m.motivo}`);
  }
  if (aviso) out.push(`⚠️  ${aviso}`);
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

function main(argv) {
  let o;
  try { o = parse(argv); } catch (e) { process.stderr.write(`suite-times: ${e.message}\n${USAGE}`); return 2; }
  try {
    if (o.cmd === 'slow') return slowCmd(o);
    if (o.cmd === 'runs') return runsCmd(o);
    if (o.cmd === 'record') return recordCmd(o);
    if (o.cmd === 'repeats') return repeatsCmd(o);
  } catch (e) { process.stderr.write(`suite-times: ${e.message}\n${USAGE}`); return 2; }
  process.stderr.write(USAGE);
  return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { main };
