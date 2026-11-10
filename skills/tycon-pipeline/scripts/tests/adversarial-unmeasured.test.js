#!/usr/bin/env node
/**
 * adversarial-unmeasured.test.js — el pase adversarial no da verde si no revisó nada.
 *
 * Sin la herramienta Workflow, `workflow-lite.js` lanza los agentes en Codex. Con Codex en su tope cada agente devuelve
 * `null` en segundos, y el guion lo leía como «6 lentes limpias, nada que verificar»: un pase que no revisó nada salía
 * verde. `agent()` devuelve `null` igual en la
 * herramienta Workflow, así que el hueco era del guion, no del corredor.
 *
 * Qué fija: (1) un cazador muerto deja su lente «sin medir» y un verificador muerto deja su hallazgo «sin veredicto»,
 * con el texto entero en `detalle`; (2) `workflow-lite.js` guarda la causa de Codex, no reintenta contra el tope y
 * sale 3 con un pase no medido; (3) anotar el pase exige el archivo de resultado y uno no medido frena el paso 8, el
 * portón y el salteo; (4) la salida aprobada (agentes de Claude, `--agents-dir`) deja el mismo archivo y destraba.
 *
 * Nunca se toca la casa real: cada caso corre con un HOME falso.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/adversarial-unmeasured.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const SKILL = path.join(SCRIPTS, '..');
const MARKER = path.join(SCRIPTS, 'marker.js');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const WFLITE = path.join(SCRIPTS, 'workflow-lite.js');
const GUION = path.join(SCRIPTS, 'adversarial-verify.workflow.js');
const VERDICT_LIB = path.join(SCRIPTS, 'lib', 'adversarial-verdict.js');
const LANZADO = '2026-09-18T01:00:00.000Z';

const DEL_ENTORNO = ['TYCON_NO_DEEP_REVIEW', 'DOD_BYPASS', 'TYCON_5B_EARLY', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID',
  'TYCON_DEEP_REVIEW_DENSE_LINES', 'STOP_AUTONOMY', 'TYCON_MUTATION_CHECK', 'TYCON_ADVERSARIAL_RESULT_GATE',
  'TYCON_WFLITE_AGENT_CMD', 'TYCON_5B_GROUP', 'TYCON_WFLITE_JOBS'];

function entorno(home, extra) {
  const env = { ...process.env };
  for (const k of DEL_ENTORNO) delete env[k];
  return { ...env, HOME: home, ...(extra || {}) };
}

// Las lentes del guion, leídas de él: clave y el renglón «LENTE: …» con que el doble reconoce a cada cazador.
const LENTES = [...fs.readFileSync(GUION, 'utf8').matchAll(/key: '([a-z-]+)',\s*\n\s*prompt: `(LENTE: [^.]{8,40})/g)]
  .map((m) => ({ key: m[1], marca: m[2] }));

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

// La base que el paso le pasa al pase (un hash de 40), y la carpeta donde cada cazador guarda su prueba.
const BASE = '0123456789abcdef0123456789abcdef01234567';
const carpetaDeLaLente = (runDir, key) => path.join(runDir, 'step-05b-probes', `caza-${key}`);
/** Guarda la prueba de una lente limpia como la guardaría su cazador. */
function guardarPruebaDeLente(runDir, key, texto = 'node probe.js\n→ salió lo esperado\n') {
  const d = carpetaDeLaLente(runDir, key);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'COMO-SE-CORRIO.txt'), texto);
  return d;
}

/**
 * El doble de Codex. Lee el pedido de TYCON_WFLITE_PROMPT y la configuración de STUB_CONFIG:
 *   { hunt: { default, <lente>: 'dead' | 'tope' | [hallazgos] | {findings, base, probe} }, verify: 'dead' | 'tope' | {veredicto} | {<file>: …} }
 * Un cazador contesta con la base pedida y, sin hallazgos, guarda su prueba en su carpeta y la nombra. Con un objeto se
 * cambia: `base` (otra base, o null para no mandarla), `probe` ('vacia' → probe_dir "", 'ausente' → sin la clave,
 * 'ajena' → la carpeta de otra lente). Guarda cada pedido en STUB_PROMPTS si está.
 * Anota cada lanzamiento en STUB_LOG. 'dead' sale 1 sin escribir; 'tope' además escribe el error de tope de Codex.
 */
function doble(dir, cfg) {
  const cfgPath = path.join(dir, 'cfg.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, lentes: LENTES, base: BASE, runDir: dir }));
  const stub = path.join(dir, 'stub.js');
  const prompts = path.join(dir, 'pedidos');
  fs.writeFileSync(stub, `
const fs = require('fs');
const path = require('path');
const cfg = JSON.parse(fs.readFileSync(process.env.STUB_CONFIG, 'utf8'));
const p = process.env.TYCON_WFLITE_PROMPT || '';
const esVerif = /REFUTARLO/.test(p);
const lente = cfg.lentes.find((l) => p.includes(l.marca));
fs.appendFileSync(process.env.STUB_LOG, (esVerif ? 'verify' : 'hunt:' + (lente && lente.key)) + '\\n');
if (process.env.STUB_PROMPTS) {
  fs.mkdirSync(process.env.STUB_PROMPTS, { recursive: true });
  fs.writeFileSync(path.join(process.env.STUB_PROMPTS, (esVerif ? 'verify-' + process.pid + '-' + Math.random() : 'hunt-' + (lente && lente.key)) + '.txt'), p);
}
const tope = () => { process.stderr.write("ERROR: You've hit your usage limit. Try again at 3:15 AM.\\n"); process.exit(1); };
const muerto = () => { process.stderr.write('boom: se cayó el agente\\n'); process.exit(1); };
let r;
if (esVerif) {
  r = cfg.verify;
  if (r && !r.verdict && typeof r === 'object') { const k = Object.keys(r).find((f) => p.includes('file=' + f)); r = k ? r[k] : 'dead'; }
} else {
  r = (cfg.hunt && lente && cfg.hunt[lente.key] !== undefined) ? cfg.hunt[lente.key] : (cfg.hunt && cfg.hunt.default);
}
if (r === 'tope') tope();
if (r === 'dead' || r === undefined) muerto();
if (esVerif) { console.log(JSON.stringify(Object.assign({ reasoning: 'corrí la prueba', adjusted_severity: 'bug', probe_dir: '', todos_el_mismo_defecto: true }, r))); process.exit(0); }
const o = Array.isArray(r) ? { findings: r } : r;
const findings = o.findings || [];
const resp = { lens: lente.key, base: o.base === undefined ? cfg.base : o.base, findings };
if (resp.base === null) delete resp.base;
const suya = path.join(cfg.runDir, 'step-05b-probes', 'caza-' + lente.key);
if (o.probe === 'vacia') resp.probe_dir = '';
else if (o.probe === 'ajena') resp.probe_dir = path.join(cfg.runDir, 'step-05b-probes', 'caza-otra');
else if (o.probe !== 'ausente') {
  if (findings.length) resp.probe_dir = '';
  else { fs.mkdirSync(suya, { recursive: true }); fs.writeFileSync(path.join(suya, 'COMO-SE-CORRIO.txt'), 'node probe.js\\n→ ok\\n'); resp.probe_dir = suya; }
}
console.log(JSON.stringify(resp));
`);
  const log = path.join(dir, 'log.txt');
  fs.writeFileSync(log, '');
  return { env: { TYCON_WFLITE_AGENT_CMD: `${process.execPath} ${stub}`, STUB_CONFIG: cfgPath, STUB_LOG: log, STUB_PROMPTS: prompts }, log, prompts };
}

function hallazgo(file, summary) {
  return { severity: 'bug', file, line: 3, summary, repro: `x(${summary.length}) → lanza`, confidence: 'high' };
}

/** Corre el guion con workflow-lite.js. Devuelve { status, stderr, result, out }. */
function correrPase(dir, envExtra, extraArgs = [], argsExtra = {}) {
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const out = path.join(dir, 'step-05b-adversarial.json');
  const args = { repo: dir, files: ['scripts/x.js'], runDir: dir, model: 'sonnet', base: BASE, ...argsExtra };
  for (const k of Object.keys(args)) if (args[k] === undefined) delete args[k];
  const r = spawnSync(process.execPath, [WFLITE, GUION, '--args', JSON.stringify(args), '--out', out, ...extraArgs],
    { encoding: 'utf8', env: entorno(home, { TYCON_WFLITE_JOBS: '6', ...envExtra }), cwd: dir, timeout: 60000 });
  let result = null;
  try { result = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (_e) { result = null; }
  return { status: r.status, stderr: r.stderr || '', result, out };
}

// ─────────────────────────────── El guion ───────────────────────────────

test('T1 8.56-CazadorMuerto_LenteSinMedir @story-8.56 @ac-1 @ac-5', () => {
  assert.equal(LENTES.length, 6, 'el guion trae seis lentes');
  const dir = tmp('adv856-t1-');
  const { env } = doble(dir, { hunt: { default: [], [LENTES[0].key]: 'dead' } });
  const r = correrPase(dir, env);
  assert.ok(r.result, r.stderr);
  assert.deepEqual(r.result.lentes_sin_medir, [LENTES[0].key]);
  assert.equal(r.result.medido, false);
  const l0 = r.result.lentes.find((l) => l.lens === LENTES[0].key);
  assert.equal(l0.estado, 'sin-medir');
  assert.doesNotMatch(r.stderr, /lentes limpias/);
});

test('T2 8.56-SeisMuertos_NoEsLimpio @story-8.56 @ac-1 @ac-7', () => {
  const dir = tmp('adv856-t2-');
  const { env } = doble(dir, { hunt: { default: 'dead' } });
  const r = correrPase(dir, env);
  assert.equal(r.status, 3, `sale 3 con un pase no medido\n${r.stderr}`);
  assert.ok(r.result, '--out escrito aunque no esté medido');
  assert.equal(r.result.lentes_sin_medir.length, 6);
  assert.equal(r.result.medido, false);
  assert.doesNotMatch(r.stderr, /lentes limpias/);
  assert.match(r.stderr, /NO MEDIDO/);
});

test('T3 8.56-LentesLimpias_Medido @story-8.56 @ac-2 @ac-7', () => {
  const dir = tmp('adv856-t3-');
  const { env } = doble(dir, { hunt: { default: [] } });
  const r = correrPase(dir, env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.result.medido, true);
  assert.equal(r.result.lentes.length, 6);
  assert.ok(r.result.lentes.every((l) => l.estado === 'medida' && l.count === 0));
  assert.deepEqual(r.result.lentes_sin_medir, []);
});

test('T4 8.56-VerificadorMuerto_SinVeredicto @story-8.56 @ac-3 @ac-4', () => {
  const dir = tmp('adv856-t4-');
  const h = hallazgo('scripts/x.js', 'divide por cero con lista vacía');
  const { env } = doble(dir, { hunt: { default: [], [LENTES[2].key]: [h] }, verify: 'dead' });
  const r = correrPase(dir, env);
  assert.equal(r.status, 3, r.stderr);
  assert.deepEqual(r.result.confirmed, []);
  assert.equal(r.result.medido, false);
  assert.equal(r.result.detalle.length, 1);
  const d = r.result.detalle[0];
  assert.equal(d.estado, 'sin-veredicto');
  assert.equal(d.summary, h.summary);
  assert.equal(d.repro, h.repro);
  assert.equal(d.lens, LENTES[2].key);
  assert.equal(d.verificador, null);
});

test('T5 8.56-Detalle_ConVeredicto @story-8.56 @ac-4', () => {
  const dir = tmp('adv856-t5-');
  const a = hallazgo('scripts/a.js', 'pierde el último elemento');
  const b = hallazgo('scripts/b.js', 'no cierra el archivo');
  const { env } = doble(dir, {
    hunt: { default: [], [LENTES[1].key]: [a, b] },
    verify: { 'scripts/a.js': { verdict: 'CONFIRMED', reasoning: 'reproducido con [1,2,3]' }, 'scripts/b.js': { verdict: 'REFUTED', reasoning: 'lo cierra el finally' } },
  });
  const r = correrPase(dir, env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.result.medido, true);
  const da = r.result.detalle.find((d) => d.file === 'scripts/a.js');
  const db = r.result.detalle.find((d) => d.file === 'scripts/b.js');
  assert.equal(da.estado, 'confirmado');
  assert.equal(da.verificador.verdict, 'CONFIRMED');
  assert.equal(da.verificador.reasoning, 'reproducido con [1,2,3]');
  assert.equal(db.estado, 'refutado');
  assert.equal(db.verificador.reasoning, 'lo cierra el finally');
  assert.equal(r.result.confirmed.length, 1);
});

test('T6 8.56-RutaWorkflow_MismoGuion @story-8.56 @ac-5', async () => {
  // La herramienta Workflow: el mismo guion, con un agent() que devuelve null cuando el agente muere.
  let source = fs.readFileSync(GUION, 'utf8').replace(/^export const meta =/m, 'const meta =');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction('args', 'log', 'agent', 'parallel', 'pipeline', source);
  const logs = [];
  const h = hallazgo('scripts/x.js', 'falla con unicode');
  const agent = async (prompt) => {
    if (/REFUTARLO/.test(prompt)) return null;
    const lente = LENTES.find((l) => prompt.includes(l.marca));
    if (lente.key === LENTES[0].key) return null;
    const conH = lente.key === LENTES[3].key;
    return { lens: lente.key, base: BASE, probe_dir: conH ? '' : `/tmp/r/run/step-05b-probes/caza-${lente.key}`, findings: conH ? [h] : [] };
  };
  const parallel = (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)));
  const r = await fn({ repo: '/tmp/r', files: ['scripts/x.js'], runDir: '/tmp/r/run', base: BASE }, (m) => logs.push(m), agent, parallel, null);
  assert.deepEqual(r.lentes_sin_medir, [LENTES[0].key]);
  assert.equal(r.medido, false);
  assert.equal(r.detalle.length, 1);
  assert.equal(r.detalle[0].estado, 'sin-veredicto');
  assert.match(r.aviso, /NO MEDIDO/);
});

// ─────────────────────────────── Codex ───────────────────────────────

test('T7 8.56-Codex_CausaYReintento @story-8.56 @ac-6', () => {
  const dir = tmp('adv856-t7-');
  const { env, log } = doble(dir, { hunt: { default: [], [LENTES[4].key]: 'dead' } });
  const r = correrPase(dir, env);
  const lanz = fs.readFileSync(log, 'utf8').split('\n').filter((l) => l === `hunt:${LENTES[4].key}`);
  assert.equal(lanz.length, 2, 'un error cualquiera se reintenta una vez');
  const m = r.result.corredor.muertos.find((x) => x.label === `hunt:${LENTES[4].key}`);
  assert.ok(m, JSON.stringify(r.result.corredor));
  assert.match(m.causa, /boom: se cayó el agente/);
});

test('T8 8.56-Codex_Tope_NoReintenta @story-8.56 @ac-6', () => {
  const dir = tmp('adv856-t8-');
  const { env, log } = doble(dir, { hunt: { default: 'tope' } });
  const r = correrPase(dir, { ...env, TYCON_WFLITE_JOBS: '1' });
  const lanz = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  assert.equal(lanz.length, 1, `con el tope, un solo lanzamiento en total: ${lanz.join(',')}`);
  assert.equal(r.status, 3);
  assert.equal(r.result.corredor.muertos.length, 6);
  for (const m of r.result.corredor.muertos) {
    assert.match(m.causa, /usage limit/i);
    assert.match(m.hora, /^\d{2}:\d{2}$/);
  }
  assert.ok(r.result.corredor.tope, 'el tope queda anotado');
  const { SALIDA_APROBADA } = require(VERDICT_LIB);
  assert.ok(r.stderr.includes(SALIDA_APROBADA), 'el aviso nombra la salida aprobada');
});

test('T9 8.56-Salida_CopiaLiteral @story-8.56 @ac-5', () => {
  const { SALIDA_APROBADA } = require(VERDICT_LIB);
  const guion = fs.readFileSync(GUION, 'utf8');
  const m = guion.match(/const SALIDA_APROBADA = '([^']+)'/);
  assert.ok(m, 'el guion trae su copia literal');
  assert.equal(m[1], SALIDA_APROBADA);
  assert.match(SALIDA_APROBADA, /Sonnet/);
  assert.match(SALIDA_APROBADA, /Opus/);
  assert.match(SALIDA_APROBADA, /nunca Fable/);
  assert.match(SALIDA_APROBADA, /--agents-dir/);
});

// ─────────────────────────────── Anotar y frenar ───────────────────────────────

function estado(home) { return path.join(home, '.claude', '.tycon-pipeline'); }
function leerMarker(home, sid) { return JSON.parse(fs.readFileSync(path.join(estado(home), 'active', `${sid}.json`), 'utf8')); }
function lineas(home, nombre) {
  const p = path.join(estado(home), nombre);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function writeFakeMarker(home, sid, extra) {
  const activeDir = path.join(estado(home), 'active');
  fs.mkdirSync(activeDir, { recursive: true });
  const marker = {
    storyId: 'A', storyPath: 'specs/a.md', repoPath: '/tmp/repo', sessionId: sid,
    startedAt: '2026-07-30T10:00:00.000Z', lastTouch: '2026-07-30T10:00:00.000Z',
    stepsCompleted: [0, 1, 2, 3, 4], stepsPending: [5], filesTouched: [], iterations: {}, fileEvents: [],
    ...extra,
  };
  fs.writeFileSync(path.join(activeDir, `${sid}.json`), JSON.stringify(marker));
  return marker;
}
function mkRepo(cuantos = 8) {
  // El repo vive en una carpeta propia: el paso 8 mira las carpetas vecinas del repo (repos hermanos), y la carpeta
  // temporal de una máquina de trabajo puede tener cientos de miles de entradas (medido: 517.471, ~40 s por llamada).
  const r = path.join(tmp('adv856-repo-'), 'repo');
  fs.mkdirSync(r);
  spawnSync('git', ['init', '-q', r]);
  for (const d of ['specs', 'scripts', 'tests']) fs.mkdirSync(path.join(r, d), { recursive: true });
  // Ocho archivos de código: el portón por tamaño da NORMAL (corre) sin depender de la densidad; con uno, LOW (no corre).
  const archivos = Array.from({ length: cuantos }, (_v, i) => `scripts/x${i}.js`);
  fs.writeFileSync(path.join(r, 'specs', 'a.md'),
    ['---', 'story: "A"', 'epic: 1', 'status: in-progress', 'files_to_create: []', 'files_to_modify:', ...archivos.map((a) => `  - ${a}`), '---', '',
      '# Story A', '', '## Acceptance Criteria', '', '1. algo', ''].join('\n'));
  for (const a of archivos) fs.writeFileSync(path.join(r, a), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(r, 'tests', 'x.test.js'), "require('node:test');\n");
  return { repo: r, archivos };
}
function correr(home, sid, args, env) {
  const r = spawnSync(process.execPath, [MARKER, ...args], { encoding: 'utf8', env: entorno(home, { CLAUDE_CODE_SESSION_ID: sid, ...(env || {}) }), cwd: os.tmpdir() });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function resultado(dir, cuerpo, nombre = 'step-05b-adversarial.json') {
  const p = path.join(dir, nombre);
  fs.writeFileSync(p, JSON.stringify(cuerpo));
  return p;
}
// Un pase medido y limpio, con la prueba de cada lente guardada junto al resultado (en `dir`, donde se escribe).
const MEDIDO = (dir, confirmed = []) => ({
  confirmed, lentes: LENTES.map((l) => ({ lens: l.key, estado: 'medida', count: 0, base: BASE, probe_dir: guardarPruebaDeLente(dir, l.key) })),
  lentes_sin_medir: [], detalle: [], medido: true,
});
// La primera lente sin medir; las otras, medidas con su prueba guardada en `dir` (sin `dir`, sin prueba: sólo para los
// casos que miran que el pase quedó sin medir, no cuáles lentes).
const SIN_MEDIR = (dir) => ({
  confirmed: [], lentes: LENTES.map((l, i) => (i === 0 ? { lens: l.key, estado: 'sin-medir', count: 0 }
    : { lens: l.key, estado: 'medida', count: 0, base: BASE, ...(dir ? { probe_dir: guardarPruebaDeLente(dir, l.key) } : {}) })),
  lentes_sin_medir: [LENTES[0].key], detalle: [], medido: false,
});
const enPaso8 = (home, sid, repo, extra) => writeFakeMarker(home, sid, {
  repoPath: repo, storyPath: path.join(repo, 'specs', 'a.md'),
  stepsCompleted: [0, 1, 2, 3, 4, 5, 6, 7], stepsPending: [8], clockiStarted: true, dodRuntimeChecked: true, ...extra,
});
const lineaDelFreno = (home) => lineas(home, 'gates.log').filter((l) => l.name === 'adversarial-result-gate');

test('T10 8.56-Anotar_ExigeResultado @story-8.56 @ac-8', () => {
  const home = tmp('adv856-t10-'); const SID = 't10';
  writeFakeMarker(home, SID, { adversarial: { launchedAtStep: 4, runId: 'wf', sessionId: SID, launchedAt: LANZADO } });
  const sin = correr(home, SID, ['mark-adversarial-result', '0', '--type', '5b']);
  assert.equal(sin.status, 2);
  assert.match(sin.stderr, /--result/);
  const dist = correr(home, SID, ['mark-adversarial-result', '1', '--type', '5b', '--result', resultado(home, MEDIDO(home)), '--tests', '0', '--deferred', '1', '--reason', 'x']);
  assert.equal(dist.status, 2);
  assert.match(dist.stderr, /confirmad/);
  const roto = path.join(home, 'roto.json'); fs.writeFileSync(roto, '{ no es json');
  assert.equal(correr(home, SID, ['mark-adversarial-result', '0', '--type', '5b', '--result', roto]).status, 2);
  const viejo = resultado(home, MEDIDO(home), 'viejo.json');
  const t = new Date('2026-09-17T00:00:00Z'); fs.utimesSync(viejo, t, t);
  const v = correr(home, SID, ['mark-adversarial-result', '0', '--type', '5b', '--result', viejo]);
  assert.equal(v.status, 2);
  assert.match(v.stderr, /anterior al lanzamiento/);
  assert.equal(lineas(home, 'gates.log').filter((l) => l.name === 'adversarial-pass').length, 0, 'nada anotado');
  const rev = correr(home, SID, ['mark-adversarial-result', '0', '--type', 'revision']);
  assert.equal(rev.status, 0, rev.stderr);
});

test('T11 8.56-Anotar_NoMedido @story-8.56 @ac-9', () => {
  // cada cuerpo se arma con la carpeta donde se escribe: ahí van las pruebas de las lentes medidas
  const casos = [
    ['lente', (h) => SIN_MEDIR(h), /lente/],
    ['veredicto', (h) => ({ ...MEDIDO(h), detalle: [{ ...hallazgo('scripts/x.js', 'algo'), lens: LENTES[1].key, estado: 'sin-veredicto', verificador: null }], medido: false }), /veredicto/],
    ['viejo', () => ({ confirmed: [], all_lenses: [] }), /formato|lentes/],
  ];
  for (const [nombre, armar, motivo] of casos) {
    const home = tmp(`adv856-t11-${nombre}-`); const SID = `t11${nombre}`;
    writeFakeMarker(home, SID);
    const p = resultado(home, armar(home));
    const r = correr(home, SID, ['mark-adversarial-result', '0', '--type', '5b', '--result', p]);
    assert.equal(r.status, 0, `${nombre}: ${r.stderr}`);
    const l = lineas(home, 'gates.log').filter((x) => x.name === 'adversarial-pass');
    assert.equal(l.length, 1);
    assert.equal(l[0].veredicto, 'no-medido', nombre);
    assert.equal(l[0].resultado, p);
    assert.match(l[0].motivo_no_medido, motivo, nombre);
    const m = leerMarker(home, SID);
    assert.equal(m.adversarialPasses[0].veredicto, 'no-medido');
    assert.notEqual(m.deepReviewDone, true, `${nombre}: un pase no medido no cierra el 5b`);
    if (nombre === 'lente') assert.deepEqual(l[0].lentes_sin_medir, [LENTES[0].key]);
    if (nombre === 'veredicto') assert.equal(l[0].hallazgos_sin_veredicto, 1);
  }
  // Un pase medido sigue como hoy.
  const home = tmp('adv856-t11-ok-'); writeFakeMarker(home, 'ok');
  correr(home, 'ok', ['mark-adversarial-result', '0', '--type', '5b', '--result', resultado(home, MEDIDO(home))]);
  assert.equal(lineas(home, 'gates.log').find((x) => x.name === 'adversarial-pass').veredicto, 'listo');
  assert.equal(leerMarker(home, 'ok').deepReviewDone, true);
});

test('T12 8.56-Paso8_NoMedido_Frena @story-8.56 @ac-10 @ac-11', () => {
  const home = tmp('adv856-t12-'); const SID = 't12'; const { repo, archivos } = mkRepo();
  enPaso8(home, SID, repo, { adversarial: { launchedAtStep: 4, runId: 'wf_A', sessionId: SID, launchedAt: LANZADO } });
  assert.equal(correr(home, SID, ['mark-adversarial-result', '0', '--type', '5b', '--result', resultado(home, SIN_MEDIR())]).status, 0);
  const { SALIDA_APROBADA } = require(VERDICT_LIB);
  for (const env of [{}, { DOD_BYPASS: '1' }]) {
    const r = correr(home, SID, ['complete-step', '8'], env);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /no medido/i);
    assert.ok(r.stderr.includes(SALIDA_APROBADA), 'el freno nombra la salida aprobada');
    assert.match(r.stderr, /--relaunch/);
  }
  assert.equal(lineaDelFreno(home).at(-1).motivo, 'pase-no-medido');
  // El portón: corre, con el motivo.
  const g = spawnSync(process.execPath, [PIPELINE, 'deep-review-gate', '--repo', repo, '--story', path.join(repo, 'specs', 'a.md'), '--files', ...archivos],
    { encoding: 'utf8', env: entorno(home, { CLAUDE_CODE_SESSION_ID: SID }), cwd: repo });
  const gate = JSON.parse(g.stdout);
  assert.equal(gate.run, true, g.stderr);
  assert.match(gate.reason, /no medido/i);
  // El salteo sin interruptor se niega.
  const s = correr(home, SID, ['mark-adversarial-skipped', '--files', ...archivos]);
  assert.notEqual(s.status, 0);
  // `next` pide relanzar.
  const n = spawnSync(process.execPath, [PIPELINE, 'next'], { encoding: 'utf8', env: entorno(home, { CLAUDE_CODE_SESSION_ID: SID }), cwd: repo });
  const nx = JSON.parse(n.stdout);
  assert.equal(nx.pending_action && nx.pending_action.kind, 'relanzar-pase-no-medido', n.stdout.slice(0, 600));
  // Relanzado y medido: destraba.
  const re = correr(home, SID, ['mark-adversarial-launched', 'wf_B', '5b', '--relaunch']);
  assert.equal(re.status, 0, re.stderr);
  // el resultado trae los sellos de lo que se congeló al lanzar (historia 8.161)
  const { sellos } = JSON.parse(re.stdout);
  assert.equal(correr(home, SID, ['mark-adversarial-result', '0', '--type', '5b', '--result', resultado(home, { ...MEDIDO(home), sellos }, 'otro.json')]).status, 0);
  correr(home, SID, ['complete-step', '8']);
  assert.equal(lineaDelFreno(home).at(-1).status, 'ok');
});

test('T13 8.56-Tablero_NoMedidoEsError @story-8.56 @ac-12', () => {
  const runs = require(path.join(SKILL, '..', '..', 'scripts', 'nightly', 'dashboard', 'runs.js'));
  assert.equal(typeof runs.estadoDelPaseAdversarial, 'function', 'runs.js exporta el lector de la línea adversarial-pass');
  assert.equal(runs.estadoDelPaseAdversarial({ name: 'adversarial-pass', veredicto: 'no-medido' }), 'error');
  assert.equal(runs.estadoDelPaseAdversarial({ name: 'adversarial-pass', veredicto: 'listo' }), 'paso');
});

test('T14 8.56-Paso5b_LoDice @story-8.56 @ac-13', () => {
  const t = fs.readFileSync(path.join(SKILL, 'steps', 'step-08-adversarial-pass.md'), 'utf8');
  assert.match(t, /--result/);
  assert.match(t, /step-05b-adversarial\.json/);
  assert.match(t, /no medido/i);
  assert.match(t, /--agents-dir/);
  const { SALIDA_APROBADA } = require(VERDICT_LIB);
  assert.ok(t.includes('nunca Fable') && t.includes('Sonnet') && t.includes('Opus'), 'el paso nombra la salida aprobada');
  assert.ok(SALIDA_APROBADA.length > 0);
  assert.match(t, /herramienta Workflow[\s\S]{0,400}step-05b-adversarial\.json|step-05b-adversarial\.json[\s\S]{0,400}herramienta Workflow/);
});

// ─────────────────────────────── La salida aprobada, de punta a punta ───────────────────────────────

test('T15 8.56-SalidaAprobada_PuntaAPunta @story-8.56 @ac-14', () => {
  const home = tmp('adv856-t15-'); const SID = 't15'; const { repo } = mkRepo();
  enPaso8(home, SID, repo, { adversarial: { launchedAtStep: 4, runId: 'wf_codex', sessionId: SID, launchedAt: LANZADO } });
  // 1) Codex sin cupo: no medido, y el paso 8 frena.
  const dir = tmp('adv856-t15-pase-');
  const { env } = doble(dir, { hunt: { default: 'tope' } });
  const codex = correrPase(dir, env);
  assert.equal(codex.status, 3);
  assert.equal(correr(home, SID, ['mark-adversarial-result', '0', '--type', '5b', '--result', codex.out]).status, 0);
  assert.equal(correr(home, SID, ['complete-step', '8']).status, 2);
  assert.equal(lineaDelFreno(home).at(-1).motivo, 'pase-no-medido');

  // 2) Relanzado con agentes de Claude: el guion deja los pedidos; los agentes escriben sus respuestas.
  const lanzado = correr(home, SID, ['mark-adversarial-launched', 'claude-1', '5b', '--relaunch']);
  assert.equal(lanzado.status, 0, lanzado.stderr);
  // los sellos del lanzamiento van en los args del pase, que los devuelve en su resultado (historia 8.161)
  const { sellos } = JSON.parse(lanzado.stdout);
  const agentes = path.join(dir, 'agentes');
  const vuelta = () => correrPase(dir, {}, ['--agents-dir', agentes], { sellos });
  const pedidos = () => JSON.parse(fs.readFileSync(path.join(agentes, 'PEDIDOS.json'), 'utf8')).pendientes;
  const h = hallazgo('scripts/x0.js', 'devuelve undefined con un objeto vacío');

  const v1 = vuelta();
  assert.equal(v1.status, 3);
  const p1 = pedidos();
  assert.equal(p1.length, 6, 'primera vuelta: seis cazadores');
  for (const p of p1) {
    assert.ok(fs.existsSync(p.prompt_file) && fs.existsSync(p.schema_file), 'cada pedido trae su texto y su esquema');
    assert.equal(p.model, 'sonnet');
    const lente = LENTES.find((l) => fs.readFileSync(p.prompt_file, 'utf8').includes(l.marca));
    const conH = lente.key === LENTES[5].key;
    fs.writeFileSync(p.answer_file, JSON.stringify({ lens: lente.key, base: BASE, probe_dir: conH ? '' : guardarPruebaDeLente(dir, lente.key), findings: conH ? [h] : [] }));
  }
  const v2 = vuelta();
  assert.equal(v2.status, 3);
  const p2 = pedidos();
  assert.equal(p2.length, 1, 'segunda vuelta: el verificador del hallazgo');
  assert.match(fs.readFileSync(p2[0].prompt_file, 'utf8'), /REFUTARLO/);
  fs.writeFileSync(p2[0].answer_file, JSON.stringify({ verdict: 'REFUTED', reasoning: 'corrí x0({}) y devuelve {}', adjusted_severity: 'not-a-bug', probe_dir: '', todos_el_mismo_defecto: true }));
  const v3 = vuelta();
  assert.equal(v3.status, 0, v3.stderr);
  assert.equal(pedidos().length, 0);
  assert.equal(v3.result.medido, true);
  assert.equal(v3.result.corredor.nombre, 'agentes-claude');
  assert.equal(v3.result.detalle[0].summary, h.summary);
  assert.equal(v3.result.detalle[0].estado, 'refutado');
  assert.equal(v3.result.detalle[0].verificador.reasoning, 'corrí x0({}) y devuelve {}');

  // 3) Anotado con --result: el paso 8 ya no frena por el pase.
  const a = correr(home, SID, ['mark-adversarial-result', '0', '--type', '5b', '--result', v3.out, '--run', 'claude-1']);
  assert.equal(a.status, 0, a.stderr);
  correr(home, SID, ['complete-step', '8']);
  assert.equal(lineaDelFreno(home).at(-1).status, 'ok');
});

// ─────────────────────── Bordes: abandono, veredictos raros, el 5b reabierto, el tope ───────────────────────

test('T16 8.56-NoMedido_AbandonoSinFirma_NoDestraba @story-8.56 @ac-10 @story-8.116', () => {
  // Clase 1 del pase (tres lentes): el abandono no destrababa. Abandonarlo lo firma el dueño: el
  // interruptor solo no abandona, y el pase no medido sigue frenando. El abandono con la constancia firmada lo cubre
  // adversarial-skip-signed.test.js (la constancia se lee de la casa de la cuenta, que una prueba no firma).
  const home = tmp('adv856-t16-'); const SID = 't16'; const { repo, archivos } = mkRepo();
  enPaso8(home, SID, repo, { adversarial: { launchedAtStep: 4, runId: 'wf_X', sessionId: SID, launchedAt: LANZADO } });
  assert.equal(correr(home, SID, ['mark-adversarial-result', '0', '--type', '5b', '--result', resultado(home, SIN_MEDIR())]).status, 0);
  const ab = correr(home, SID, ['mark-adversarial-skipped', '--files', ...archivos], { TYCON_NO_DEEP_REVIEW: '1' });
  assert.equal(ab.status, 2, ab.stderr);
  assert.match(ab.stderr, /sign-adversarial-skip/);
  correr(home, SID, ['complete-step', '8']);
  const l = lineaDelFreno(home).at(-1);
  assert.notEqual(l && l.motivo, 'abandonado', JSON.stringify(l));
});

test('T17 8.56-VeredictoRaro_SinVeredicto @story-8.56 @ac-3', () => {
  // Clases 2 y 3: `confirmed` en minúscula o `UNSURE` caían en «refutado» con el pase medido.
  for (const raro of ['confirmed', 'UNSURE']) {
    const dir = tmp(`adv856-t17-${raro}-`);
    const { env } = doble(dir, { hunt: { default: [], [LENTES[0].key]: [hallazgo('scripts/x.js', 'algo raro')] }, verify: { verdict: raro } });
    const r = correrPase(dir, env);
    assert.equal(r.status, 3, `${raro}: ${r.stderr}`);
    assert.equal(r.result.medido, false, raro);
    assert.equal(r.result.detalle[0].estado, 'sin-veredicto', raro);
    assert.equal(r.result.detalle[0].verificador, null, raro);
  }
});

test('T18 8.56-NoMedidoDespuesDeMedido_Reabre5b @story-8.56 @ac-9 @ac-11', () => {
  // Clase 4: un medido y después un no medido dejaba el 5b dado por hecho.
  const home = tmp('adv856-t18-'); const SID = 't18';
  writeFakeMarker(home, SID);
  correr(home, SID, ['mark-adversarial-result', '0', '--type', '5b', '--result', resultado(home, MEDIDO(home), 'a.json')]);
  assert.equal(leerMarker(home, SID).deepReviewDone, true);
  correr(home, SID, ['mark-adversarial-result', '0', '--type', '5b', '--result', resultado(home, SIN_MEDIR(), 'b.json')]);
  assert.equal(leerMarker(home, SID).deepReviewDone, false, 'el último resultado manda: el 5b vuelve a estar pendiente');
});

test('T19 8.56-Tope_SoloPorElError_YSecretosTapados @story-8.56 @ac-6', () => {
  // Clase 5: el pedido habla de «rate limit» (codex lo repite en su salida) y una falla cualquiera pasaba por tope.
  const dir = tmp('adv856-t19-');
  const stub = path.join(dir, 'stub.js');
  // armada por partes: entera, el escaneo de secretos de GitHub la toma por una clave de verdad
  const clave = 'sk' + '-abcdefghijklmnop';
  fs.writeFileSync(stub, `
const fs = require('fs');
fs.appendFileSync(process.env.STUB_LOG, 'x\\n');
process.stdout.write('pedido: revisá el rate limit y la quota del cliente\\n');
process.stderr.write('se cayó con Authorization: Bearer abc.def.ghi y la clave ${clave}\\n');
process.exit(1);
`);
  const log = path.join(dir, 'log.txt'); fs.writeFileSync(log, '');
  const r = correrPase(dir, { TYCON_WFLITE_AGENT_CMD: `${process.execPath} ${stub}`, STUB_LOG: log });
  assert.equal(r.result.corredor.tope, null, 'no es el tope: el renglón del error no lo dice');
  // una falla común no es el tope, pero tres seguidas dejan al corredor caído: los cazadores que siguen no lo prueban
  // (los que ya estaban lanzados en la ventana terminan sus intentos)
  const lanzados = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
  assert.ok(lanzados >= 3 && lanzados < 12, `de 3 a 11 lanzamientos, no los 12 de seis cazadores por dos intentos: ${lanzados}`);
  assert.match(Object.values(r.result.corredor.caidos)[0].causa, /veces seguidas/);
  const causa = r.result.corredor.muertos[0].causa;
  assert.ok(!causa.includes(clave), `la clave llega a la causa: ${causa}`);
  assert.doesNotMatch(causa, /abc\.def\.ghi/);
  assert.match(causa, /<REDACTED>/);
  // «Token rate limit» sí es el tope: se reconoce en el renglón crudo, antes de tapar (revisor de seguridad, vuelta 2).
  fs.writeFileSync(stub, "process.stderr.write('Error: Token rate limit exceeded, x-api-key=abc123secret\\n'); process.exit(1);\n");
  const t = correrPase(dir, { TYCON_WFLITE_AGENT_CMD: `${process.execPath} ${stub}`, STUB_LOG: log, TYCON_WFLITE_JOBS: '1' });
  assert.ok(t.result.corredor.tope, 'el tope se reconoce aunque la causa guardada quede tapada');
  assert.doesNotMatch(t.result.corredor.tope.causa, /abc123secret/);
  // Sin el binario, la causa dice por qué (ENOENT), no «salió -1 sin escribir nada» (revisor de fallos silenciosos).
  const n = correrPase(dir, { TYCON_WFLITE_AGENT_CMD: path.join(dir, 'no-existe') });
  assert.match(n.result.corredor.muertos[0].causa, /ENOENT/);
});

test('T20 8.56-Bordes_SinArchivos_SinLanzamiento_PortonLow_Tablero @story-8.56 @ac-1 @ac-9 @ac-11 @ac-12', async () => {
  const { medicionDelResultado, veredictoPaseAdversarial } = require(VERDICT_LIB);
  // El resultado: sin lentes, que no es objeto, sin `confirmed`.
  assert.equal(medicionDelResultado({ confirmed: [], lentes: [] }).medido, false);
  assert.throws(() => medicionDelResultado([]), /objeto/);
  assert.throws(() => medicionDelResultado({ lentes: [] }), /confirmed/);
  // El guion sin archivos: no medido.
  let source = fs.readFileSync(GUION, 'utf8').replace(/^export const meta =/m, 'const meta =');
  const fn = new (Object.getPrototypeOf(async function () {}).constructor)('args', 'log', 'agent', 'parallel', 'pipeline', source);
  const vacio = await fn({ repo: '/tmp/r', files: [] }, () => {}, async () => null, async () => [], null);
  assert.equal(vacio.medido, false);
  assert.match(vacio.aviso, /NO MEDIDO/);
  // Sin lanzamiento registrado, el último resultado no medido también bloquea.
  assert.equal(veredictoPaseAdversarial({ adversarialPasses: [{ tipo: '5b', ts: LANZADO, veredicto: 'no-medido' }] }).motivo, 'pase-no-medido');
  // El portón que por tamaño no corre (LOW) dice que corre con un pase no medido.
  const home = tmp('adv856-t20-'); const SID = 't20'; const { repo, archivos } = mkRepo(1);
  enPaso8(home, SID, repo, { adversarial: { launchedAtStep: 4, runId: 'wf_L', sessionId: SID, launchedAt: LANZADO } });
  const g0 = spawnSync(process.execPath, [PIPELINE, 'deep-review-gate', '--repo', repo, '--story', path.join(repo, 'specs', 'a.md'), '--files', ...archivos],
    { encoding: 'utf8', env: entorno(home, { CLAUDE_CODE_SESSION_ID: SID }), cwd: repo });
  assert.equal(JSON.parse(g0.stdout).run, false, `sin pase no medido, LOW no corre: ${g0.stderr}`);
  correr(home, SID, ['mark-adversarial-result', '0', '--type', '5b', '--result', resultado(home, SIN_MEDIR())]);
  const g1 = spawnSync(process.execPath, [PIPELINE, 'deep-review-gate', '--repo', repo, '--story', path.join(repo, 'specs', 'a.md'), '--files', ...archivos],
    { encoding: 'utf8', env: entorno(home, { CLAUDE_CODE_SESSION_ID: SID }), cwd: repo });
  const gate = JSON.parse(g1.stdout);
  assert.equal(gate.run, true);
  assert.equal(gate.previous_pass, 'no-medido');
  assert.ok(gate.model, 'con un modelo');
  // El tablero: la nota del pase no medido, sólo con números.
  const runs = require(path.join(SKILL, '..', '..', 'scripts', 'nightly', 'dashboard', 'runs.js'));
  assert.equal(runs.estadoDelPaseAdversarial({ name: 'adversarial-pass', veredicto: 'no-medido', lentes_sin_medir: ['a', 'b'], hallazgos_sin_veredicto: 1 }), 'error');
  const nota = runs.resultadoAdversarial({ name: 'adversarial-pass', veredicto: 'no-medido', lentes_sin_medir: ['a', 'b'], hallazgos_sin_veredicto: 1,
    motivo_no_medido: 'texto libre con /ruta/privada' }).nota;
  assert.equal(nota, 'no medido · 2 lentes sin medir · 1 hallazgo sin veredicto', 'sólo números, nunca la prosa del motivo');
});

// El aviso del marcador era la receta con que el agente apagaba el pase solo: «Abandonarlo es una decisión:
// TYCON_NO_DEEP_REVIEW=1 marker.js mark-adversarial-skipped …». Abandonarlo lo decide la persona con su frase.
test('T8 AvisosDelMarcador_NoRecetanElApagado @story-8.104 @ac-2', () => {
  const src = fs.readFileSync(MARKER, 'utf8');
  const avisos = src.split('\n').filter((l) => /Abandonarlo/.test(l));
  assert.equal(avisos.length, 3, `los tres avisos: el del pase no medido, el del pase sin resultado y el del salteo con el pase lanzado — ${avisos.length}`);
  // abandonarlo lo firma el dueño: ni la receta de la variable ni la frase de la persona
  for (const l of avisos) {
    assert.doesNotMatch(l, /TYCON_NO_DEEP_REVIEW/, `sin la receta ni la frase: ${l.trim()}`);
    assert.match(l, /lo firma una persona/, `con la firma del dueño: ${l.trim()}`);
  }
});

// ───────────── Un pase que no midió nada no da limpio: la base pedida y la prueba guardada ─────────────

const lentesPorNombre = (r) => Object.fromEntries(r.result.lentes.map((l) => [l.lens, l]));
const hunts = (log) => fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('hunt:'));

/** El guion en la forma de la herramienta Workflow, con un agent() propio. */
async function correrGuion(args, agent) {
  const source = fs.readFileSync(GUION, 'utf8').replace(/^export const meta =/m, 'const meta =');
  const fn = new (Object.getPrototypeOf(async function () {}).constructor)('args', 'log', 'agent', 'parallel', 'pipeline', source);
  const parallel = (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)));
  return fn(args, () => {}, agent, parallel, null);
}

test('T1 8.215-SinBase_NoMedido_SinCazadores @story-8.215 @ac-1', () => {
  for (const base of [undefined, '', 'origin/main']) {
    const dir = tmp('adv8215-t1-');
    const { env, log } = doble(dir, { hunt: { default: [] } });
    const r = correrPase(dir, env, [], { base });
    assert.ok(r.result, `${base}: ${r.stderr}`);
    assert.equal(r.result.medido, false, String(base));
    assert.match(r.result.aviso, /base/, String(base));
    assert.deepEqual(hunts(log), [], `${base}: sin base no se lanza ningún cazador`);
  }
});

test('T2 8.215-Pedido_NombraBaseYCarpeta @story-8.215 @ac-2', () => {
  const dir = tmp('adv8215-t2-');
  const { env, prompts } = doble(dir, { hunt: { default: [] } });
  const r = correrPase(dir, env);
  assert.equal(r.result.medido, true, r.stderr);
  for (const l of LENTES) {
    const p = fs.readFileSync(path.join(prompts, `hunt-${l.key}.txt`), 'utf8');
    assert.ok(p.includes(BASE), `${l.key}: nombra la base`);
    assert.ok(p.includes(`diff ${BASE}`), `${l.key}: el diff contra la base, con lo sin commitear`);
    assert.ok(!p.includes(`${BASE}...HEAD`), `${l.key}: nunca ...HEAD, que deja afuera lo sin commitear`);
    assert.match(p, /status --porcelain/, l.key);
    assert.match(p, /\bmain\b/, l.key);
    assert.ok(p.includes(carpetaDeLaLente(dir, l.key)), `${l.key}: nombra su carpeta`);
    assert.match(p, /\.txt/, l.key);
    assert.match(p, /<REDACTED>|credenciales/i, l.key);
  }
});

test('T3 8.215-OtraBase_SinMedir @story-8.215 @ac-3', () => {
  const [a, b, c, d, e] = LENTES.map((l) => l.key);
  const dir = tmp('adv8215-t3-');
  const { env } = doble(dir, { hunt: { default: [],
    [a]: { findings: [], base: 'fedcba9876543210fedcba9876543210fedcba98' },
    [b]: { findings: [hallazgo('scripts/x.js', 'algo')], base: 'fedcba9876543210fedcba9876543210fedcba98' },
    [c]: { findings: [], base: BASE.slice(0, 6) },
    [d]: { findings: [], base: '' },
    [e]: { findings: [], base: BASE.slice(0, 7).toUpperCase() } }, verify: { verdict: 'REFUTED' } });
  const r = correrPase(dir, env);
  const ls = lentesPorNombre(r);
  for (const k of [a, b, c, d]) {
    assert.equal(ls[k].estado, 'sin-medir', k);
    assert.match(ls[k].motivo, /comparó contra/, k);
  }
  assert.equal(ls[e].estado, 'medida', 'un prefijo de 7 en mayúsculas coincide');
  assert.equal(r.result.medido, false);
  // una base pedida abreviada y un cazador que devuelve el hash completo
  const dir2 = tmp('adv8215-t3b-');
  const { env: env2 } = doble(dir2, { hunt: { default: [] } });
  const r2 = correrPase(dir2, env2, [], { base: BASE.slice(0, 7) });
  assert.equal(r2.result.medido, true, r2.stderr);
});

test('T4 8.215-LimpiaSinPrueba_SinMedir @story-8.215 @ac-4', () => {
  const [a, b, c] = LENTES.map((l) => l.key);
  const dir = tmp('adv8215-t4-');
  const { env } = doble(dir, { hunt: { default: [], [a]: { probe: 'vacia' }, [b]: { probe: 'ajena' }, [c]: { probe: 'ausente' } } });
  const r = correrPase(dir, env);
  const ls = lentesPorNombre(r);
  assert.equal(ls[a].estado, 'sin-medir');
  assert.match(ls[a].motivo, /no guardó la prueba/);
  assert.equal(ls[b].estado, 'sin-medir');
  assert.match(ls[b].motivo, /no guardó la prueba/);
  assert.equal(ls[c].estado, 'sin-medir');
  assert.match(ls[c].motivo, /no contestó/);
  assert.equal(r.result.medido, false);
});

test('T5 8.215-ConHallazgos_MedidaComoHoy @story-8.215 @ac-5', () => {
  const dir = tmp('adv8215-t5-');
  const { env } = doble(dir, { hunt: { default: [], [LENTES[2].key]: [hallazgo('scripts/x.js', 'pierde el último')] }, verify: { verdict: 'REFUTED' } });
  const r = correrPase(dir, env);
  assert.equal(r.result.medido, true, r.stderr);
  for (const l of r.result.lentes) {
    assert.equal(l.estado, 'medida', l.lens);
    assert.equal(l.base, BASE, l.lens);
    assert.equal(typeof l.probe_dir, 'string', l.lens);
  }
  assert.equal(lentesPorNombre(r)[LENTES[2].key].probe_dir, '');
});

/** Un resultado medido y limpio escrito en `dir`; `cambiar(lentes)` lo toca antes de escribirlo. */
function resultadoLimpio(dir, cambiar) {
  const cuerpo = MEDIDO(dir);
  if (cambiar) cambiar(cuerpo);
  return resultado(dir, cuerpo);
}
const anotar = (home, sid, ruta, extra = []) => correr(home, sid, ['mark-adversarial-result', '0', '--type', '5b', '--result', ruta, ...extra]);
const ultimoPase = (home) => lineas(home, 'gates.log').filter((x) => x.name === 'adversarial-pass').at(-1);

test('T6 8.215-Anotar_LimpiaSinPruebaEnDisco_NoMedido @story-8.215 @ac-6', () => {
  for (const caso of ['sin-carpeta', 'vacio']) {
    const home = tmp(`adv8215-t6-${caso}-`); const SID = `t6${caso}`;
    writeFakeMarker(home, SID);
    const p = resultadoLimpio(home, () => {
      const d = carpetaDeLaLente(home, LENTES[0].key);
      if (caso === 'sin-carpeta') fs.rmSync(d, { recursive: true, force: true });
      else fs.writeFileSync(path.join(d, 'COMO-SE-CORRIO.txt'), '');
    });
    assert.equal(anotar(home, SID, p).status, 0);
    const l = ultimoPase(home);
    assert.equal(l.veredicto, 'no-medido', caso);
    assert.match(l.motivo_no_medido, /sin prueba guardada en disco/, caso);
    assert.notEqual(leerMarker(home, SID).deepReviewDone, true, caso);
  }
});

test('T7 8.215-Anotar_ConPruebas_Cierra @story-8.215 @ac-6 @ac-7', async () => {
  const home = tmp('adv8215-t7-'); const SID = 't7';
  writeFakeMarker(home, SID, { adversarial: { launchedAtStep: 4, runId: 'wf', sessionId: SID, launchedAt: LANZADO } });
  assert.equal(anotar(home, SID, resultadoLimpio(home)).status, 0);
  assert.equal(ultimoPase(home).veredicto, 'listo');
  assert.equal(leerMarker(home, SID).deepReviewDone, true);
});

test('T12 8.215-Tablero_SinTurnoNoEsBloqueo @story-8.215 @ac-12', () => {
  const reducer = require(path.join(SKILL, '..', '..', 'scripts', 'nightly', 'dashboard', 'reducer.js'));
  const digest = require(path.join(SKILL, '..', '..', 'scripts', 'metrics', 'tokens-digest.js'));
  assert.equal(typeof reducer.esBloqueo, 'function', 'reducer.js exporta esBloqueo');
  assert.equal(typeof digest.esRojo, 'function', 'tokens-digest.js exporta esRojo');
  assert.equal(reducer.esBloqueo('sin-turno'), false);
  assert.equal(digest.esRojo('sin-turno'), false);
  assert.equal(reducer.esBloqueo('red:exit=77'), true, 'un rojo sigue siendo bloqueo');
});

test('T13 8.215-ModoPlan_SinCambios @story-8.215 @ac-7', async () => {
  const { SALIDA_APROBADA } = require(VERDICT_LIB);
  const pedidos = [];
  const muerta = 'ac-sin-cubrir';
  const r = await correrGuion({ modo: 'plan', pedido: '0123456789abcdef', storyTexto: 'historia', planTexto: 'plan', repo: '/tmp/r' },
    async (prompt) => {
      pedidos.push(prompt);
      if (prompt.includes(`LENTE DEL PLAN: ${muerta}`)) return null;
      return { lens: 'x', findings: [] };
    });
  assert.equal(pedidos.length, 4, 'las cuatro lentes del plan');
  for (const p of pedidos) {
    assert.doesNotMatch(p, /caza-|status --porcelain|CONTRA QUÉ SE COMPARA/, 'el plan no pide base ni prueba guardada');
  }
  assert.equal(r.aviso, `adversarial-verify: 🔴 pase NO MEDIDO — 1 lente(s) SIN MEDIR (${muerta}): su cazador no contestó. No es verde ni «sin hallazgos»: relanzá el pase, o ${SALIDA_APROBADA}.`);
});

test('T14 8.215-Aviso_NombraMotivos @story-8.215 @ac-5', () => {
  const [a, b] = LENTES.map((l) => l.key);
  const dir = tmp('adv8215-t14-');
  const { env } = doble(dir, { hunt: { default: [], [a]: { findings: [], base: 'fedcba9876543210fedcba9876543210fedcba98' }, [b]: { probe: 'vacia' } } });
  const r = correrPase(dir, env);
  assert.match(r.result.aviso, new RegExp(`${a}[^;]*comparó contra`));
  assert.match(r.result.aviso, new RegExp(`${b}[^;]*no guardó la prueba`));
});

test('T15 8.215-Anotar_ProbeDirRelativo_SeResuelveContraElRepo @story-8.215 @ac-6', () => {
  const home = tmp('adv8215-t15-'); const SID = 't15r';
  const repo = tmp('adv8215-t15-repo-');
  const runDir = path.join(repo, '.advisors', 'pipeline-runs', 'A-1');
  fs.mkdirSync(runDir, { recursive: true });
  writeFakeMarker(home, SID, { repoPath: repo });
  const p = resultadoLimpio(runDir, (c) => {
    for (const l of c.lentes) l.probe_dir = path.relative(repo, l.probe_dir);
  });
  assert.equal(anotar(home, SID, p).status, 0);
  assert.equal(ultimoPase(home).veredicto, 'listo', ultimoPase(home).motivo_no_medido);
});

test('T17 8.215-Anotar_PruebaEnCarpetaAjena_NoMedido @story-8.215 @ac-6', () => {
  for (const caso of ['otra-lente', 'otra-corrida', 'afuera']) {
    const home = tmp(`adv8215-t17-${caso}-`); const SID = `t17${caso}`;
    writeFakeMarker(home, SID);
    const runDir = path.join(home, 'run');
    fs.mkdirSync(runDir);
    const p = resultadoLimpio(runDir, (c) => {
      const l0 = c.lentes[0];
      if (caso === 'otra-lente') l0.probe_dir = c.lentes[1].probe_dir;
      if (caso === 'otra-corrida') l0.probe_dir = guardarPruebaDeLente(path.join(home, 'otra-run'), l0.lens);
      if (caso === 'afuera') { const d = tmp('adv8215-afuera-'); fs.writeFileSync(path.join(d, 'COMO-SE-CORRIO.txt'), 'x\n'); l0.probe_dir = d; }
    });
    assert.equal(anotar(home, SID, p).status, 0);
    const l = ultimoPase(home);
    assert.equal(l.veredicto, 'no-medido', caso);
    assert.match(l.motivo_no_medido, /no está en la carpeta de la lente/, caso);
  }
});

test('T18 8.215-Anotar_ConteoQueNoCoincide_NoMedido @story-8.215 @ac-13', () => {
  const casos = [
    ['no-coincide', (l) => { l.count = 1; l.probe_dir = ''; }, /el conteo no coincide con el detalle/],
    ['sin-count', (l) => { delete l.count; }, /conteo ilegible/],
    ['texto', (l) => { l.count = '0'; }, /conteo ilegible/],
  ];
  for (const [nombre, cambiar, motivo] of casos) {
    const home = tmp(`adv8215-t18-${nombre}-`); const SID = `t18${nombre}`;
    writeFakeMarker(home, SID);
    const p = resultadoLimpio(home, (c) => {
      fs.rmSync(c.lentes[0].probe_dir, { recursive: true, force: true });
      cambiar(c.lentes[0]);
    });
    assert.equal(anotar(home, SID, p).status, 0);
    const l = ultimoPase(home);
    assert.equal(l.veredicto, 'no-medido', nombre);
    assert.match(l.motivo_no_medido, motivo, nombre);
  }
});

test('T21 8.215-PedidoVerificador_SinBloquesDelCazador @story-8.215 @ac-2', async () => {
  const dir = tmp('adv8215-t21-');
  const { env, prompts } = doble(dir, { hunt: { default: [], [LENTES[0].key]: [hallazgo('scripts/x.js', 'algo')] }, verify: { verdict: 'REFUTED' } });
  correrPase(dir, env);
  const verif = fs.readdirSync(prompts).filter((f) => f.startsWith('verify-'));
  assert.ok(verif.length >= 1, 'hubo un verificador');
  for (const f of verif) {
    const p = fs.readFileSync(path.join(prompts, f), 'utf8');
    assert.doesNotMatch(p, /caza-|status --porcelain|CONTRA QUÉ SE COMPARA/, 'el verificador no recibe los bloques del cazador');
  }
  const uno = await correrGuion({ modo: 'single-finding', soloPedido: true, base: BASE, hallazgo: { file: 'x.js', summary: 's' } }, async () => null);
  assert.doesNotMatch(uno.prompt, /caza-|status --porcelain|CONTRA QUÉ SE COMPARA/, 'el modo un hallazgo tampoco');
});

test('T23 8.215-Anotar_PruebaDeUnPaseAnterior_NoMedido @story-8.215 @ac-6', () => {
  // con lanzamiento: la prueba fechada antes del lanzamiento
  const home = tmp('adv8215-t23-'); const SID = 't23';
  // stable-data: se compara contra la fecha real de los archivos que la prueba escribe
  // el lanzamiento, 2 s antes: Linux fecha los archivos con un reloj de varios ms y el resultado quedaba «anterior»
  const ahora = new Date(Date.now() - 2000);
  writeFakeMarker(home, SID, { adversarial: { launchedAtStep: 4, runId: 'wf', sessionId: SID, launchedAt: ahora.toISOString() } });
  const p = resultadoLimpio(home, (c) => {
    const viejo = new Date(ahora.getTime() - 60 * 60 * 1000);
    fs.utimesSync(path.join(c.lentes[0].probe_dir, 'COMO-SE-CORRIO.txt'), viejo, viejo);
  });
  assert.equal(anotar(home, SID, p).status, 0);
  assert.match(ultimoPase(home).motivo_no_medido, /la prueba es de un pase anterior/);
  // sin lanzamiento (como el carril o una revisión): más de 12 h antes que el resultado
  const { medicionDelResultado } = require(VERDICT_LIB);
  const dir = tmp('adv8215-t23b-');
  const r = resultadoLimpio(dir, (c) => {
    const viejo = new Date(Date.now() - 13 * 60 * 60 * 1000);
    fs.utimesSync(path.join(c.lentes[0].probe_dir, 'COMO-SE-CORRIO.txt'), viejo, viejo);
  });
  const m = medicionDelResultado(JSON.parse(fs.readFileSync(r, 'utf8')), { repo: dir, resultado: r });
  assert.equal(m.medido, false);
  assert.match(m.motivo, /la prueba es de un pase anterior/);
});

// Un cazador guarda su prueba con Bash, con la corrida abierta y parado en el repo de la historia: el gancho de escrituras
// no lo frena por el nombre de la carpeta (`step-05b-probes/caza-*`). En el pase de la 8.215 se frenaron seis
// laboratorios en /tmp que creaban un enlace simbólico (`ln -s`, el gancho no ve qué trae): eso sigue frenando.
test('T27 8.215-CazadorGuardaSuPrueba_ElGanchoNoLoFrena @story-8.215 @ac-2', () => {
  const home = tmp('adv8215-t27-'); const SID = 't27'; const { repo } = mkRepo();
  writeFakeMarker(home, SID, { repoPath: repo, storyPath: path.join(repo, 'specs', 'a.md'), stepsCompleted: [0, 1, 2, 3, 4], stepsPending: [5] });
  const caza = path.join(repo, '.advisors', 'pipeline-runs', 'A-1', 'step-05b-probes', 'caza-determinism-ordering');
  const gancho = (cmd) => spawnSync(process.execPath, [path.join(SCRIPTS, 'on-bash-write-gate.js')], {
    input: JSON.stringify({ session_id: SID, tool_name: 'Bash', tool_input: { command: cmd }, cwd: repo, hook_event_name: 'PreToolUse' }),
    encoding: 'utf8', env: entorno(home, { CLAUDE_CODE_SESSION_ID: SID }),
  });
  for (const cmd of [
    `mkdir -p ${caza} && printf 'node probe.js\\n' > ${caza}/COMO-SE-CORRIO.txt`,
    `cat > ${caza}/COMO-SE-CORRIO.txt <<'EOF'\nnode probe.js\nEOF`,
    `cp /tmp/probe.js ${caza}/probe.js.txt`,
    `D=${caza}; mkdir -p $D; printf 'x' > $D/COMO-SE-CORRIO.txt`,
  ]) {
    const r = gancho(cmd);
    assert.equal(r.status, 0, `${cmd}\n${r.stdout}${r.stderr}`);
  }
  // un enlace simbólico a una carpeta que no se ve sigue frenando (el gancho no sabe qué trae)
  assert.equal(gancho('L=$(mktemp -d /tmp/probe.XXXXXX); mkdir -p $L/run/step-05b-probes/caza-a; ln -s run $L/runlink').status, 2);
});

test('T24 8.215-Revision_ConResultado_MiraLasPruebas @story-8.215 @ac-6', () => {
  const home = tmp('adv8215-t24-'); const SID = 't24';
  writeFakeMarker(home, SID);
  const sin = resultadoLimpio(home, (c) => fs.rmSync(c.lentes[0].probe_dir, { recursive: true, force: true }));
  correr(home, SID, ['mark-adversarial-result', '0', '--type', 'revision', '--result', sin]);
  const l1 = lineas(home, 'gates.log').filter((x) => x.name === 'adversarial-pass').at(-1);
  assert.equal(l1.veredicto, 'no-medido', JSON.stringify(l1));
  const home2 = tmp('adv8215-t24b-'); writeFakeMarker(home2, 't24b');
  const r = correr(home2, 't24b', ['mark-adversarial-result', '0', '--type', 'revision', '--result', resultadoLimpio(home2)]);
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(lineas(home2, 'gates.log').filter((x) => x.name === 'adversarial-pass').at(-1).veredicto, 'no-medido');
});
