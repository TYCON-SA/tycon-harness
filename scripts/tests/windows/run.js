#!/usr/bin/env node
'use strict';
/**
 * run.js — la medición del arnés en Windows: arma el laboratorio, corre cada paso bajo su tope, escribe el reporte y
 * da el veredicto (story 8.17, tanda W0 · AC 2, 4 y 11). Lo llama `pipelines/azure-pipelines-windows.yml`.
 *
 * POR QUÉ EXISTE. Antes de arreglar el instalador de Windows hay que saber qué hace hoy en un Windows de verdad: el
 * análisis previo dejó quince «no se sabe». Este programa los cambia por hechos, sin arreglar nada.
 *
 * SUBCOMANDOS
 *   init     --lab <carpeta> --out <carpeta> --bundle <archivo> [--run-id N] [--run-number X] [--harness-ref R]
 *            [--disposable] [--allow-temp] [--same-tree]
 *            Crea el laboratorio (con su marca) y hace `git clone` del bundle en `<lab>/source`. Tiene que ser un clon:
 *            copiar los archivos no aplica la conversión de finales de línea y escondería justo lo que se mide.
 *            Con `--same-tree` (lo que se mide y estos guiones salen del mismo repo, en el mismo commit): el bundle
 *            tiene que traer el commit del árbol de estos guiones; si no, no hay laboratorio. La etiqueta de lo medido
 *            queda como `<harness-ref>:<commit>`.
 *   step     <inventory|install|count-hooks|fire-registered|pipeline-skeleton|session-probe> --lab … --out … [--cap <segundos>]
 *            [--disposable] (install: es un agente descartable) [--real-session] (session-probe) [--fence powershell|bash]
 *            Corre ese paso bajo `scripts/tests/clean-machine/run-capped.js` y deja `<out>/steps/<paso>.json`.
 *   finish   --out … [--gaps <known-gaps.json>]     Escribe `windows-report.json` y `windows-report.md`.
 *   verdict  --out …                                 Dice el veredicto del reporte y sale 0 (verde) o 1 (rojo).
 *   all      (las opciones de init)                  init + los seis pasos + finish + verdict, de una.
 *   propose-gaps <windows-report.json> [--keep <known-gaps.json>]
 *                                                    Imprime el `known-gaps.json` que sale de esa corrida; con --keep,
 *                                                    conserva los huecos de los pasos que no midió (los del banco).
 *
 * CADA PASO TERMINA EN UNO DE TRES ESTADOS: `measured` (con sus hallazgos), `not-measured` (con su motivo) o `error`
 * («no pude medir: <motivo>»). Un paso que vence su tope es un error con su nombre, y lo que alcanzó a medir queda.
 *
 * EL VEREDICTO sale de `known-gaps.json`, la lista declarada de lo que hoy no anda en Windows, cada hueco con la tanda
 * que lo cierra. La corrida es ROJA si hay un error, si falta un paso, si aparece un hallazgo que no está en la lista,
 * si un hueco de la lista ya no se reproduce (hay que borrarlo) o si un hueco no dice qué tanda lo cierra.
 *   🔴 Mientras la lista no tenga línea de base (`baseline: null`: todavía no se escribió desde una corrida), los
 *   hallazgos NO ponen roja la corrida: es la primera medición, y que Windows ande mal es lo que se vino a medir. Roja
 *   sigue siendo si no se pudo MEDIR. La lista se escribe desde esa primera corrida (`propose-gaps`), no desde el análisis.
 *
 * NUNCA LA CARPETA DE USUARIO REAL: el laboratorio no puede ser la carpeta de usuario, contenerla, ni vivir dentro de
 * su `.claude`; en Windows tampoco bajo la carpeta temporal (`harness.js` rechaza un clon bajo `%TEMP%`). Sin la
 * marca del laboratorio, `step` se niega y no escribe nada. Todo paso lleva `TYCON_NO_NIGHTLY_EXAM=1`.
 *
 * SALIDAS: 0 hizo lo suyo (y `verdict`: verde) · 1 `verdict` rojo · 2 uso, o no pudo ni escribir («no pude medir»).
 * Fuera de Windows corre igual, en «modo de laboratorio»: mide lo que haya, para probar los guiones sin un Windows.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('./lab.js');
const facts = require('./facts.js');

const HERE = __dirname;
const CAPPED = path.join(HERE, '..', 'clean-machine', 'run-capped.js');
const GAPS_FILE = path.join(HERE, 'known-gaps.json');
const EXIT_CAP = 124;
// Los pasos, en orden, con su tope en segundos. Todos son obligatorios: uno que falta es un rojo.
const STEPS = Object.freeze([
  { name: 'inventory', script: 'inventory.js', cap: 600, lab: false },
  { name: 'install', script: 'install-probe.js', cap: 2400, lab: true, pass: ['disposable', 'allow-temp', 'fence'] },
  { name: 'count-hooks', script: 'count-hooks.js', cap: 300, lab: true },
  { name: 'fire-registered', script: 'fire-registered.js', cap: 2400, lab: true },
  // W6 (AC 49): el esqueleto mecánico del pipeline de stories sobre el repo de ejemplo, con la instalación de `install`
  { name: 'pipeline-skeleton', script: 'pipeline-skeleton.js', cap: 1800, lab: true },
  { name: 'session-probe', script: 'session-probe.js', cap: 2400, lab: true, pass: ['real-session', 'allow-temp'] },
]);
const BATCHES = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8'];
const OPTIONS = {
  '--lab': 'value', '--out': 'value', '--bundle': 'value', '--cap': 'value', '--gaps': 'value', '--fence': 'value',
  '--run-id': 'value', '--run-number': 'value', '--harness-ref': 'value',
  '--real-session': 'flag', '--disposable': 'flag', '--allow-temp': 'flag', '--same-tree': 'flag',
};

const say = (s) => process.stdout.write(`${s}\n`);
const fail = (s) => { process.stderr.write(`run.js: ${s}\n`); return 2; };
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// ── el laboratorio ───────────────────────────────────────────────────────────────────────────────────────────────

/** ¿Esta carpeta puede ser el laboratorio? `null` si sí, o el motivo. Con `needMark`, además tiene que traer la marca. */
function labRootProblem(lab, { realHome = os.homedir(), tmpdir = os.tmpdir(), platform = process.platform, allowTemp = false, needMark = false } = {}) {
  if (!lab || !L.isAbsolute(lab, platform)) return 'la carpeta del laboratorio (--lab) tiene que ser una ruta absoluta';
  if (L.isInside(realHome, lab, platform)) return `${lab} es la carpeta de usuario real, o la contiene: acá no se mide`;
  if (L.isInside(lab, path.join(realHome, '.claude'), platform)) return `${lab} está dentro de la carpeta .claude real`;
  if (L.isWin(platform) && !allowTemp && L.isInside(lab, tmpdir, platform)) return `${lab} está bajo la carpeta temporal (${tmpdir}): el laboratorio va fuera de ella`;
  if (needMark && !fs.existsSync(path.join(lab, L.LAB_MARK))) return `${lab} no tiene la marca del laboratorio (${L.LAB_MARK}): la deja «run.js init»`;
  return null;
}

/** El ambiente de todo paso: el de quien lanza, sin su git, con lo de SAFE_ENV (el examen nocturno apagado, entre otros). */
function stepEnv(base = process.env) {
  const env = Object.assign({}, base);
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) L.setEnv(env, k, null);
  for (const [k, v] of Object.entries(L.SAFE_ENV)) L.setEnv(env, k, v);
  return env;
}

/** El commit del árbol donde viven estos guiones: `{ sha }`, o `{ problem }` si no se puede saber. */
function scriptsCommit(env = stepEnv(), root = path.resolve(HERE, '..', '..', '..')) {
  // Tiene que ser el commit de ESE árbol, no el de un repo que lo contenga: desde una carpeta que no es la raíz de un
  // repo (sin .git, o con un .git que no es un repo) git sube a buscar uno en las carpetas de arriba y contestaría por
  // otro. Se le pregunta cuál es la raíz, y tiene que ser esa carpeta.
  if (!fs.existsSync(path.join(root, '.git'))) return { problem: `${root} no es un clon de git` };
  const top = L.run('git', ['-C', root, 'rev-parse', '--show-toplevel'], { env, timeoutMs: 30000 });
  if (top.error || top.exit !== 0) return { problem: `${root} no es la raíz de un clon de git: git rev-parse --show-toplevel ${top.error || `salió ${top.exit}`}${L.firstLine(top.stderr) ? ` — ${L.firstLine(top.stderr)}` : ''}` };
  // git contesta la raíz a su manera (en Windows, con barras, y la unidad o un nombre corto como le parezca): se
  // comparan las dos rutas ya resueltas por el sistema, sin mirar barras ni mayúsculas donde no cuentan
  const real = (p) => { try { return fs.realpathSync.native(p); } catch (_) { return L.realOrSelf(p); } };
  if (!L.samePath(real(path.resolve(L.firstLine(top.stdout))), real(root))) return { problem: `${root} no es la raíz de un clon de git: git contesta por ${L.firstLine(top.stdout)}` };
  const r = L.run('git', ['-C', root, 'rev-parse', 'HEAD'], { env, timeoutMs: 30000 });
  const sha = L.firstLine(r.stdout);
  return !r.error && r.exit === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? { sha } : { problem: `git rev-parse HEAD ${r.error || `salió ${r.exit}`}: ${L.firstLine(r.stderr) || 'sin mensaje'}` };
}

/**
 * `--same-tree`: lo que se va a medir tiene que ser el MISMO commit que el árbol de los guiones que lo miden (cuando los
 * dos salen del mismo repo, que no se mida un árbol con los guiones de otro). `{ ok, sha }`, o `{ ok: false, reason }`.
 * No poder leer cualquiera de los dos commits frena: no saber no es «coinciden». `verb`: «se mide» o «se ensaya».
 */
function sameTreeCheck({ measured, scripts = scriptsCommit, verb = 'se mide' }) {
  const mine = scripts();
  if (!mine || mine.problem || !mine.sha) return { ok: false, reason: `no pude leer el commit del árbol de los guiones: ${(mine && mine.problem) || 'sin respuesta'}` };
  if (!measured) return { ok: false, reason: `no sé qué commit ${verb}: la información del bundle no lo dice` };
  if (String(measured) !== mine.sha) return { ok: false, reason: `el árbol de los guiones (${mine.sha.slice(0, 10)}) no es el commit que ${verb} (${String(measured).slice(0, 10)}): con --same-tree los dos tienen que ser el mismo` };
  return { ok: true, sha: mine.sha };
}
/** La etiqueta de lo medido cuando se comprobó el árbol: lo que se pasó (o «tree») y el commit. */
const sameTreeLabel = (label, sha) => `${label || 'tree'}:${sha}`;

/**
 * Crea el laboratorio y clona el bundle. Devuelve `{ ok, reason, meta }`; nunca copia archivos: clona.
 * Con `sameTree`, antes de crear nada comprueba que el bundle traiga el commit del árbol de estos guiones.
 */
function initLab({ lab, out, bundle, meta = {}, allowTemp = false, env = stepEnv(), sameTree = false, scripts = scriptsCommit }) {
  const problem = labRootProblem(lab, { allowTemp });
  if (problem) return { ok: false, reason: problem };
  if (!bundle || !fs.existsSync(bundle)) return { ok: false, reason: `no encuentro el bundle ${bundle || '(falta --bundle)'}` };
  if (fs.existsSync(lab) && !fs.existsSync(path.join(lab, L.LAB_MARK)) && fs.readdirSync(lab).length) return { ok: false, reason: `${lab} ya existe, tiene cosas y no es un laboratorio (sin ${L.LAB_MARK}): no lo adopto` };
  const source = path.join(lab, 'source');
  if (fs.existsSync(source)) return { ok: false, reason: `${source} ya existe: el laboratorio es de una sola corrida (borralo, o usá otra carpeta)` };
  let same = null;
  if (sameTree) {
    let about = null;
    try { about = readJson(path.join(path.dirname(bundle), 'bundle-info.json')); } catch (_) { about = null; }
    same = sameTreeCheck({ measured: about && about.copy_commit, scripts, verb: 'se mide' });
    if (!same.ok) return { ok: false, reason: same.reason };
    meta = Object.assign({}, meta, { harness_ref: sameTreeLabel(meta.harness_ref, same.sha) });
  }
  try {
    fs.mkdirSync(lab, { recursive: true });
    fs.mkdirSync(path.join(out, 'steps'), { recursive: true });
    L.writeJsonAtomic(path.join(lab, L.LAB_MARK), { made_by: 'scripts/tests/windows/run.js init', at: L.nowIso() });
  } catch (e) { return { ok: false, reason: `no pude crear el laboratorio o la carpeta del reporte: ${e.code || e.message}` }; }
  // 🔴 `git clone`, no una copia: el clon aplica core.autocrlf como en la máquina de un usuario
  const r = L.run('git', ['clone', '--quiet', bundle, source], { env, timeoutMs: 10 * 60 * 1000 });
  if (r.error || r.exit !== 0) return { ok: false, reason: `git clone del bundle salió ${r.error || r.exit}: ${L.firstLine(r.stderr) || L.firstLine(r.stdout)}` };
  const head = L.run('git', ['-C', source, 'rev-parse', 'HEAD'], { env, timeoutMs: 30000 });
  // y el clon tiene que haber quedado en ese mismo commit: lo que se instala es lo que se comprobó
  if (same && L.firstLine(head.stdout) !== same.sha) return { ok: false, reason: `el clon del bundle quedó en ${L.firstLine(head.stdout).slice(0, 10) || '(ilegible)'} y no en el commit del árbol de los guiones (${same.sha.slice(0, 10)})` };
  let info = null;
  try { info = readJson(path.join(path.dirname(bundle), 'bundle-info.json')); } catch (_) { info = null; }
  const run = Object.assign({ id: null, number: null, harness_ref: null, disposable: false }, meta, {
    started: L.nowIso(), platform: process.platform, lab_mode: !L.isWin(), node: process.versions.node, copy_commit: head.exit === 0 ? L.firstLine(head.stdout) : null, bundle: info,
  });
  try { L.writeJsonAtomic(path.join(out, 'run.json'), run); } catch (e) { return { ok: false, reason: `no pude escribir ${path.join(out, 'run.json')}: ${e.code || e.message}` }; }
  return { ok: true, meta: run };
}

// ── correr un paso ───────────────────────────────────────────────────────────────────────────────────────────────

let capWorksMemo = null;
/** ¿`run-capped.js` anda en esta máquina (devuelve el código del comando)? Si no, el tope lo pone `spawnSync`. */
function capWorks(env) {
  if (capWorksMemo === null) {
    const r = spawnSync(process.execPath, [CAPPED, 'self-check', '60', '--', process.execPath, '-e', 'process.exit(7)'], { env, stdio: 'ignore', timeout: 90000, windowsHide: true });
    capWorksMemo = r.status === 7;
  }
  return capWorksMemo;
}

/**
 * Corre un paso bajo su tope y devuelve su resultado (ya escrito en `<out>/steps/<paso>.json`). Si el guion del paso
 * no dejó resultado —se cayó, o venció el tope—, lo escribe acá como «error», con lo parcial que haya quedado.
 */
function runStep(name, { lab, out, cap, script, args = [], env = stepEnv(), quiet = false } = {}) {
  const spec = STEPS.find((s) => s.name === name) || {};
  const file = script || path.join(HERE, spec.script);
  const seconds = Number(cap || spec.cap || 600);
  const stepPath = L.stepFile(out, name);
  const partial = L.partialFile(out, name);
  fs.mkdirSync(path.dirname(stepPath), { recursive: true });
  for (const f of [stepPath, partial]) fs.rmSync(f, { force: true });
  const stepArgs = ['--out', out, ...(lab ? ['--lab', lab] : []), ...args];
  const t0 = Date.now();
  const stdio = quiet ? 'ignore' : 'inherit';
  const useCap = capWorks(env);
  const r = useCap
    ? spawnSync(process.execPath, [CAPPED, name, String(seconds), '--', process.execPath, file, ...stepArgs], { env, stdio, timeout: (seconds + 120) * 1000, windowsHide: true })
    : spawnSync(process.execPath, [file, ...stepArgs], { env, stdio, timeout: seconds * 1000, killSignal: 'SIGKILL', windowsHide: true });
  const timedOut = r.status === EXIT_CAP || Boolean(r.error && r.error.code === 'ETIMEDOUT');
  const wall = Math.round((Date.now() - t0) / 100) / 10;
  let step = null;
  try { step = readJson(stepPath); } catch (_) { step = null; }
  if (step && (step.name !== name || !Object.values(L.STATUS).includes(step.status))) step = null;
  if (!step || timedOut) {
    let kept = null;
    try { kept = readJson(partial); } catch (_) { kept = null; }
    const reason = timedOut ? `no pude medir: el paso ${name} venció su tope de ${seconds} s` : `no pude medir: el paso ${name} terminó (salió ${r.error ? r.error.code || r.error.message : r.status}) sin dejar su resultado`;
    step = Object.assign({ schema: L.SCHEMA, name, started: new Date(t0).toISOString(), facts: {}, findings: [], notes: [] }, kept || step || {}, { status: L.STATUS.error, reason });
  }
  Object.assign(step, { cap_s: seconds, capped_by: useCap ? 'run-capped.js' : 'spawn timeout (run-capped.js no anda en esta máquina)', exit: r.status === undefined ? null : r.status, wall_seconds: wall });
  L.writeJsonAtomic(stepPath, step);
  fs.rmSync(partial, { force: true });
  return step;
}

// ── el reporte y el veredicto ────────────────────────────────────────────────────────────────────────────────────

/** Junta `run.json` y los pasos en un reporte. Sin `run.json` (init no corrió) el reporte lo dice. */
function compose(out) {
  let run = null;
  try { run = readJson(path.join(out, 'run.json')); } catch (_) { run = null; }
  const steps = [];
  let names = [];
  try { names = fs.readdirSync(path.join(out, 'steps')).filter((f) => f.endsWith('.json') && !f.endsWith('.partial.json')).map((f) => f.slice(0, -5)); } catch (_) { names = []; }
  const order = STEPS.map((s) => s.name);
  for (const n of [...order.filter((x) => names.includes(x)), ...names.filter((x) => !order.includes(x)).sort()]) {
    try { steps.push(readJson(L.stepFile(out, n))); } catch (e) { steps.push({ schema: L.SCHEMA, name: n, status: L.STATUS.error, reason: `no pude medir: el resultado del paso es ilegible (${e.message})`, facts: {}, findings: [] }); }
  }
  // ¿se pidió la sesión real? Lo dice su paso: sin pedirla, sale «no medido» con ese motivo exacto
  const session = steps.find((s) => s.name === 'session-probe');
  const asked = Boolean(session) && !(session.status === L.STATUS.notMeasured && /^falta la sesión real/.test(session.reason || ''));
  return { schema: L.SCHEMA, kind: 'windows-report', run: Object.assign({ id: null }, run || { init_problem: 'no hay run.json: «run.js init» no corrió o no pudo escribir' }, { real_session: asked, finished: L.nowIso() }), steps };
}

/**
 * El veredicto de un reporte contra la lista de huecos declarados. Función pura.
 * `{ color, mode, errors, missing_steps, new_findings, stale_gaps, invalid_gaps, known, not_measured }`
 */
function verdict(report, gapsDoc) {
  const v = { color: 'green', mode: 'against-known-gaps', errors: [], missing_steps: [], new_findings: [], stale_gaps: [], invalid_gaps: [], known: [], not_measured: [] };
  const steps = report && Array.isArray(report.steps) ? report.steps : [];
  if (!steps.length) v.errors.push('el reporte no trae ningún paso: un reporte vacío no es verde');
  if (report && report.run && report.run.init_problem) v.errors.push(report.run.init_problem);
  for (const s of STEPS) if (!steps.some((x) => x && x.name === s.name)) v.missing_steps.push(s.name);
  const gaps = gapsDoc && Array.isArray(gapsDoc.gaps) ? gapsDoc.gaps : null;
  if (!gapsDoc || !gaps) v.errors.push('la lista de huecos declarados (known-gaps.json) no se pudo leer o no trae «gaps»');
  const baseline = gapsDoc && gapsDoc.baseline ? gapsDoc.baseline : null;
  if (!baseline) v.mode = 'first-measurement';
  const found = new Map();
  for (const s of steps) {
    if (!s || !Object.values(L.STATUS).includes(s.status)) { v.errors.push(`${s && s.name ? s.name : '(paso sin nombre)'}: estado desconocido «${s && s.status}»`); continue; }
    if (s.status === L.STATUS.error) v.errors.push(`${s.name}: ${s.reason || 'error sin motivo'}`);
    if (s.status === L.STATUS.notMeasured) v.not_measured.push(`${s.name}: ${s.reason || 'sin motivo'}`);
    for (const f of s.findings || []) found.set(f.id, Object.assign({ step: s.name }, f));
  }
  const declared = new Map((gaps || []).map((g) => [g.id, g]));
  for (const g of gaps || []) {
    if (!g || !g.id) { v.invalid_gaps.push('un hueco sin id'); continue; }
    if (!BATCHES.includes(g.closes)) v.invalid_gaps.push(`${g.id}: no dice qué tanda lo cierra (closes: ${BATCHES.join(' | ')})`);
    // un hueco «ya no se reproduce» sólo si su paso midió: de un paso que no corrió no se sabe
    const step = steps.find((s) => s && s.name === g.step);
    if (!found.has(g.id) && step && step.status === L.STATUS.measured) v.stale_gaps.push(`${g.id} (lo cerraba ${g.closes}): ya no se reproduce — borrarlo de known-gaps.json`);
  }
  for (const f of found.values()) (declared.has(f.id) ? v.known : v.new_findings).push(f);
  const red = v.errors.length || v.missing_steps.length || v.invalid_gaps.length || (v.mode === 'against-known-gaps' && (v.new_findings.length || v.stale_gaps.length));
  if (red) v.color = 'red';
  return v;
}

const STATUS_TEXT = { measured: 'medido', 'not-measured': 'no medido', error: 'ERROR' };
const cell = (s) => String(s === null || s === undefined ? '—' : s).replace(/\|/g, '\\|').replace(/[\n\t]/g, ' ');

/** El resumen legible del reporte. */
function renderMarkdown(report) {
  const v = report.verdict || {};
  const run = report.run || {};
  const M = [];
  M.push('# El arnés en Windows — reporte de la medición (story 8.17, W0)', '');
  M.push(`Corrida **${run.id === null || run.id === undefined ? 'sin número' : run.id}**${run.number ? ` (${run.number})` : ''} · arnés \`${run.harness_ref || '—'}\` · copia \`${run.copy_commit ? String(run.copy_commit).slice(0, 10) : '—'}\` · ${run.platform || '—'}${run.lab_mode ? ' — **modo de laboratorio: esto NO es un Windows**' : ''} · Node ${run.node || '—'} · sesión real: ${run.real_session ? 'sí' : 'no'}`, '');
  M.push(`## Veredicto: ${v.color === 'green' ? 'VERDE' : 'ROJO'}`, '');
  M.push(v.mode === 'first-measurement'
    ? 'Primera medición (`known-gaps.json` sin línea de base): los hallazgos no ponen roja la corrida; sólo no haber podido medir. La lista de huecos se escribe desde esta corrida: `node scripts/tests/windows/run.js propose-gaps windows-report.json`.'
    : 'Contra `known-gaps.json`: roja si hay un error, un hallazgo que no está en la lista, o un hueco de la lista que ya no se reproduce.', '');
  const bullets = (title, items, fmt = (x) => x) => { if (items && items.length) { M.push(`**${title} (${items.length})**`, ''); for (const i of items) M.push(`- ${fmt(i)}`); M.push(''); } };
  bullets('No pude medir', v.errors);
  bullets('Pasos que faltan', v.missing_steps);
  bullets('Huecos mal declarados', v.invalid_gaps);
  bullets(v.mode === 'first-measurement' ? 'Hallazgos para declarar' : 'Hallazgos NUEVOS (no están en la lista)', v.new_findings, (f) => `\`${f.id}\` (${f.step}) — ${f.detail}`);
  bullets('Huecos que ya no se reproducen', v.stale_gaps);
  bullets('No medido', v.not_measured);
  if (v.known && v.known.length) M.push(`Huecos declarados que se reprodujeron: ${v.known.length}.`, '');

  M.push('## Los pasos', '', '| Paso | Estado | Hallazgos | Duró (s) | Tope (s) | Motivo |', '|---|---|---|---|---|---|');
  for (const s of report.steps || []) M.push(`| ${s.name} | ${STATUS_TEXT[s.status] || s.status} | ${(s.findings || []).length} | ${cell(s.wall_seconds)} | ${cell(s.cap_s)} | ${cell(s.reason)} |`);
  M.push('');

  const F = (name) => (facts.stepOf(report, name) || {}).facts || {};
  const inv = F('inventory');
  if (inv.tools) {
    M.push('## Qué trae la máquina', '', '| Herramienta | Dónde (en el orden del PATH) | Versión |', '|---|---|---|');
    for (const [name, t] of Object.entries(inv.tools)) M.push(`| ${name} | ${t.state === 'present' ? cell(t.locations.join(' → ')) : (t.state === 'absent' ? 'no está' : `no pude preguntar: ${cell(t.reason)}`)} | ${cell(t.version)} |`);
    M.push('');
    const sys = inv.system || {};
    M.push(`Sistema: ${cell(sys.type)} ${cell(sys.release)} (${cell(sys.version)}), ${cell(sys.arch)}${sys.image ? ` · imagen ${sys.image}` : ''} · administrador: ${inv.administrator && inv.administrator.known ? (inv.administrator.value ? 'sí' : 'no') : 'no se sabe'} · modo desarrollador: ${inv.developer_mode && inv.developer_mode.known ? (inv.developer_mode.value ? 'prendido' : 'apagado') : 'no se sabe'}`, '');
  }
  const ins = F('install');
  if (ins.variants) {
    M.push('## Cómo quedó la instalación', '', '| Variante | El bloque salió | Duró (s) | doctor: fallas | Hooks en settings.json | .sh con \\r | Enlaces |', '|---|---|---|---|---|---|---|');
    for (const [id, x] of Object.entries(ins.variants)) {
      M.push(`| ${id} | ${x.not_run ? `no corrió: ${cell(x.not_run)}` : cell(x.run ? (x.run.error || x.run.exit) : '—')} | ${cell(x.run && x.run.seconds)} | ${x.doctor ? (x.doctor.readable ? x.doctor.fail.length : 'ilegible') : '—'} | ${x.settings ? cell(x.settings.hooks_total === undefined ? (x.settings.exists ? 'ilegible' : 'no hay') : x.settings.hooks_total) : '—'} | ${x.eol && typeof x.eol.with_cr === 'number' ? `${x.eol.with_cr} de ${x.eol.total}` : '—'} | ${Array.isArray(x.links) ? cell(x.links.map((l) => `${l.name}: ${l.present ? (l.link_type || l.kind) : 'ausente'}`).join(', ')) : '—'} |`);
    }
    M.push('', `Se contó y se disparó sobre la variante: **${ins.measured_variant || 'ninguna'}**.`, '');
    for (const [id, x] of Object.entries(ins.variants)) {
      if (x.run && (x.run.error || x.run.exit !== 0)) M.push(`Salida del bloque en \`${id}\` (final):`, '', '```text', L.clip(`${x.run.stdout}\n${x.run.stderr}`.trim(), 1500), '```', '');
    }
  }
  const cnt = F('count-hooks').result;
  if (cnt) {
    M.push('## Los hooks registrados', '', `Esperados ${cnt.expected_total} · en su lugar ${cnt.in_place} · faltan ${cnt.missing.length} · repetidos ${cnt.duplicated.length} · reemplazados que siguen sueltos ${cnt.superseded.length} · en otro lugar ${cnt.misplaced.length} · del arnés y fuera de la lista ${cnt.unexpected.length} · sin archivo ${cnt.dangling.length} · línea de arranque: ${cnt.startup_line.count}`, '');
    if (cnt.missing.length) M.push(`Faltan: ${cnt.missing.map((m) => `\`${m.hook}\``).join(', ')}`, '');
  }
  const fire = F('fire-registered');
  if (fire.by_form) {
    M.push('## Los hooks, disparados tal como quedaron registrados', '', '| Forma | Disparos | Salió 0 | Salió 2 | Otro código | No arrancó | Se colgó |', '|---|---|---|---|---|---|---|');
    for (const [id, s] of Object.entries(fire.by_form)) M.push(`| ${id} | ${s.fired} | ${s.exit_0} | ${s.exit_2} | ${s.other_exit} | ${s.did_not_start} | ${s.timed_out} |`);
    M.push('');
    const brakeRows = (fire.fires || []).filter((r) => r.case !== 'generic');
    if (brakeRows.length) {
      M.push('| Freno | Caso | Forma | Salió | ¿Frenó? |', '|---|---|---|---|---|');
      for (const r of brakeRows) M.push(`| ${cell(r.hook)} | ${r.case === 'must-block' ? 'tiene que frenar' : 'tiene que pasar'} | ${r.form} | ${cell(r.error || r.exit)} | ${r.blocked ? 'sí' : 'no'} |`);
      M.push('');
    }
  }
  if (Array.isArray(fire.bash_brakes)) {
    M.push('| Freno en bash | Con el PATH de la máquina | Con jq quitado |', '|---|---|---|');
    const one = (x) => (x ? (x.not_measured ? `no medido: ${cell(x.not_measured)}` : `${x.blocked ? 'frenó' : 'NO frenó'} (salió ${x.error || x.exit}; jq: ${x.jq_seen || 'no está'})`) : '—');
    for (const b of fire.bash_brakes) M.push(`| ${b.hook}${b.has_cr ? ' (llegó con \\r)' : ''} | ${b.not_measured ? `no medido: ${cell(b.not_measured)}` : one(b.with_agent_path)} | ${one(b.without_jq)} |`);
    M.push('');
  }
  M.push(facts.render(report).split('\n').slice(4).join('\n'));
  return `${M.join('\n')}\n`;
}

/** El `known-gaps.json` que sale de una corrida: un hueco por hallazgo, con la tanda sugerida (a revisar por una persona). */
/**
 * La lista que sale de una corrida. Con `keep` (la lista declarada de hoy), conserva tal cual los huecos de los pasos que
 * esa corrida no mide —los `bench:red:…` que también lee el banco, con su `match`— y reemplaza los de los pasos medidos.
 */
function proposeGaps(report, keep = null) {
  const gaps = [];
  // «medido» es lo mismo que en verdict(): un paso «no medido» o en «error» no dice nada de sus huecos, y se conservan
  const measured = new Set((report.steps || []).filter((s) => s && s.status === L.STATUS.measured).map((s) => s.name));
  for (const g of (keep && Array.isArray(keep.gaps) ? keep.gaps : [])) if (g && !measured.has(g.step)) gaps.push(g);
  for (const s of report.steps || []) for (const f of s.findings || []) gaps.push({ id: f.id, step: s.name, closes: BATCHES.includes(f.closes_hint) ? f.closes_hint : '?', note: f.detail });
  return {
    // con la lista de hoy, su explicación se conserva (trae además cómo lee el banco sus huecos)
    __doc: keep && typeof keep.__doc === 'string' ? keep.__doc : 'Lo que HOY no anda en Windows, medido: un hueco por hallazgo de la corrida de base, con la tanda de la story 8.17 que lo cierra (closes). Lo lee scripts/tests/windows/run.js: la corrida es roja si aparece un hallazgo que no está acá, si un hueco de acá ya no se reproduce (se borra) o si un hueco no dice su tanda. Se escribe desde una corrida (run.js propose-gaps), nunca desde el análisis. W7 la deja vacía.',
    baseline: { run: report.run ? report.run.id : null, date: report.run ? (report.run.finished || report.run.started || null) : null, harness_ref: report.run ? report.run.harness_ref || null : null },
    gaps,
  };
}

// ── la línea de comandos ─────────────────────────────────────────────────────────────────────────────────────────

function metaOf(args) {
  return { id: args['run-id'] || null, number: args['run-number'] || null, harness_ref: args['harness-ref'] || null, disposable: Boolean(args.disposable) };
}
function stepArgsOf(spec, args) {
  const out = [];
  for (const k of spec.pass || []) {
    if (args[k] === true) out.push(`--${k}`); else if (typeof args[k] === 'string') out.push(`--${k}`, args[k]);
  }
  return out;
}

function cmdStep(name, args) {
  const spec = STEPS.find((s) => s.name === name);
  if (!spec) return fail(`paso desconocido: «${name}» (los que hay: ${STEPS.map((s) => s.name).join(', ')})`);
  if (!args.out) return fail('falta --out <carpeta del reporte>');
  const out = path.resolve(args.out);
  let lab = null;
  if (spec.lab) {
    if (!args.lab) return fail('falta --lab <laboratorio>');
    lab = path.resolve(args.lab);
    // se niega ANTES de escribir nada: ni el resultado del paso
    const problem = labRootProblem(lab, { allowTemp: Boolean(args['allow-temp']), needMark: true });
    if (problem) return fail(`no mido: ${problem}`);
  }
  let step;
  try { step = runStep(name, { lab, out, cap: args.cap, args: stepArgsOf(spec, args) }); } catch (e) { return fail(`no pude escribir el resultado del paso ${name}: ${e.message}`); }
  say(`run.js: ${name} → ${STATUS_TEXT[step.status]}${step.reason ? ` — ${step.reason}` : ''} · ${(step.findings || []).length} hallazgo(s) · ${step.wall_seconds} s`);
  if (step.status === L.STATUS.error) say(`##vso[task.logissue type=warning]${name}: ${step.reason}`);
  return 0;
}

function cmdFinish(args) {
  if (!args.out) return fail('falta --out <carpeta del reporte>');
  const out = path.resolve(args.out);
  let gapsDoc = null;
  try { gapsDoc = readJson(args.gaps ? path.resolve(args.gaps) : GAPS_FILE); } catch (_) { gapsDoc = null; }
  const report = compose(out);
  report.verdict = verdict(report, gapsDoc);
  try {
    fs.mkdirSync(out, { recursive: true });
    L.writeJsonAtomic(path.join(out, 'windows-report.json'), report);
    fs.writeFileSync(path.join(out, 'windows-report.md'), renderMarkdown(report));
  } catch (e) { return fail(`no pude escribir el reporte en ${out}: ${e.message}`); }
  say(`run.js: reporte en ${path.join(out, 'windows-report.json')} y windows-report.md`);
  return 0;
}

function cmdVerdict(args) {
  if (!args.out) return fail('falta --out <carpeta del reporte>');
  let report;
  try { report = readJson(path.join(path.resolve(args.out), 'windows-report.json')); } catch (e) { return fail(`no pude leer el reporte: ${e.message} — sin reporte no hay veredicto`); }
  const v = report.verdict;
  if (!v) return fail('el reporte no trae veredicto (¿corrió «finish»?)');
  for (const s of report.steps || []) say(`  ${s.name.padEnd(16)} ${STATUS_TEXT[s.status] || s.status}${s.reason ? ` — ${s.reason}` : ''} · ${(s.findings || []).length} hallazgo(s)`);
  const lines = [...v.errors.map((e) => `no pude medir — ${e}`), ...v.missing_steps.map((s) => `falta el paso ${s}: no corrió`), ...v.invalid_gaps.map((g) => `hueco mal declarado — ${g}`)];
  if (v.mode === 'against-known-gaps') lines.push(...v.new_findings.map((f) => `hallazgo nuevo — ${f.id}: ${f.detail}`), ...v.stale_gaps.map((g) => `hueco que ya no se reproduce — ${g}`));
  for (const l of lines) say(`##vso[task.logissue type=error]${l}`);
  say(`run.js: veredicto ${v.color === 'green' ? 'VERDE' : 'ROJO'} (${v.mode === 'first-measurement' ? 'primera medición' : 'contra known-gaps.json'}) · ${v.new_findings.length} hallazgo(s) ${v.mode === 'first-measurement' ? 'para declarar' : 'nuevos'} · ${v.known.length} declarado(s) · ${v.not_measured.length} paso(s) no medido(s)`);
  return v.color === 'green' ? 0 : 1;
}

function cmdInit(args) {
  if (!args.lab || !args.out) return fail('faltan --lab <laboratorio> y --out <carpeta del reporte>');
  const r = initLab({ lab: path.resolve(args.lab), out: path.resolve(args.out), bundle: args.bundle ? path.resolve(args.bundle) : null, meta: metaOf(args), allowTemp: Boolean(args['allow-temp']), sameTree: Boolean(args['same-tree']) });
  if (!r.ok) { say(`##vso[task.logissue type=error]no pude medir: ${r.reason}`); return fail(`no pude medir: ${r.reason}`); }
  say(`run.js: laboratorio en ${path.resolve(args.lab)} · la copia, clonada del bundle, en el commit ${r.meta.copy_commit}`);
  return 0;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') { say('uso: node scripts/tests/windows/run.js init|step <paso>|finish|verdict|all|propose-gaps … (ver la cabecera del archivo)'); return cmd ? 0 : 2; }
  if (cmd === 'propose-gaps') {
    const keepAt = rest.indexOf('--keep');
    const keepFile = keepAt >= 0 ? rest[keepAt + 1] : null;
    const files = keepAt >= 0 ? rest.filter((_, i) => i !== keepAt && i !== keepAt + 1) : rest;
    if (files.length !== 1 || (keepAt >= 0 && !keepFile)) return fail('uso: run.js propose-gaps <windows-report.json> [--keep <known-gaps.json>]');
    let report;
    try { report = readJson(files[0]); } catch (e) { return fail(`no pude leer ${files[0]}: ${e.message}`); }
    if (!Array.isArray(report.steps) || !report.steps.length) return fail('el reporte no trae pasos: de ahí no sale ninguna lista');
    let keep = null;
    if (keepFile) {
      // la lista a conservar se lee entera o no se usa: ilegible no es «no había nada que conservar»
      try { keep = readJson(keepFile); } catch (e) { return fail(`no pude leer la lista a conservar ${keepFile}: ${e.message}`); }
      if (!keep || !Array.isArray(keep.gaps)) return fail(`la lista a conservar ${keepFile} no trae «gaps»`);
    }
    say(JSON.stringify(proposeGaps(report, keep), null, 2));
    return 0;
  }
  const args = L.parseArgs(rest, OPTIONS);
  if (args.problem) return fail(args.problem);
  if (cmd === 'init') return cmdInit(args);
  if (cmd === 'step') return args._.length === 1 ? cmdStep(args._[0], args) : fail('uso: run.js step <paso> --lab … --out …');
  if (cmd === 'finish') return cmdFinish(args);
  if (cmd === 'verdict') return cmdVerdict(args);
  if (cmd === 'all') {
    let rc = cmdInit(args);
    if (rc === 0) for (const s of STEPS) { rc = cmdStep(s.name, args); if (rc !== 0) break; }
    const wrote = cmdFinish(args);
    if (wrote !== 0) return wrote;
    const v = cmdVerdict(args);
    return rc !== 0 ? rc : v;
  }
  return fail(`subcomando desconocido: «${cmd}» (los que hay: init, step, finish, verdict, all, propose-gaps)`);
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { STEPS, BATCHES, labRootProblem, stepEnv, initLab, scriptsCommit, sameTreeCheck, sameTreeLabel, runStep, compose, verdict, renderMarkdown, proposeGaps };
