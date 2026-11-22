'use strict';

/**
 * El contrato de marker.js partido por responsabilidad: cada subcomando da la misma salida, el mismo código y escribe los
 * mismos archivos que antes de partir (T3), una diferencia se nombra (T11), y lo que sostiene la partición: el
 * despachador y sus módulos por debajo del tope (T4), el freno los lee enteros (T5), un módulo que falta se dice (T10), las
 * exportaciones no cambian (T15), lo que el despachador carga de nuevo es sensible (T16), el recorrido del freno no corta
 * callado (T14) y lo publicado los lleva (T13).
 *
 * La foto de antes (`fixtures/split-contract/marker-before.json`) se graba con `SPLIT_CONTRACT_RECORD=1` sobre el
 * marker.js sin partir. Cada caso corre en una carpeta fija (`<tmp>/split-contract/<caso>`), así las huellas que salen de
 * una ruta son iguales entre la foto y la corrida; la normalización saca la carpeta, las fechas, las horas y los sellos.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const FOTO = path.join(__dirname, 'fixtures', 'split-contract', 'marker-before.json');
const SID = 'ses-contrato-8163';
const GRABAR = process.env.SPLIT_CONTRACT_RECORD === '1';

const FUERA_DEL_ENTORNO = ['TYCON_GUIDES_DIR', 'TCG', 'NODE_TEST_CONTEXT', 'TYCON_SKILLS_DIR', 'TYCON_HOME', 'TYCON_STATE_DIR',
  'TYCON_AUTO_SNAPSHOT', 'TYCON_SNAPSHOT_GUARD', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'TYCON_SESSION_ID',
  'CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'TYCON_EVIDENCE_DIR', 'TYCON_EVIDENCE_KEY', 'STOP_AUTONOMY',
  'TYCON_HARNESS_LOCK_HELD', 'TYCON_TEST_GATE', 'TYCON_TEST_SCOPE', 'TF_BUILD', 'CI', 'GITHUB_ACTIONS'];

function entorno(home, extra = {}) {
  const env = { ...process.env };
  for (const k of FUERA_DEL_ENTORNO) delete env[k];
  return Object.assign(env, {
    HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: SID, TYCON_SESSION_ID: SID, TYCON_PACKS_DEFAULT: 'none',
    // sin el perfil del equipo: el árbol armado del portón trae la capa del equipo y la foto se grabó sin ella
    TYCON_PROFILE: '0',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig-vacio'), TZ: 'UTC', LANG: 'C', LC_ALL: 'C',
    GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'acme@example.invalid', GIT_COMMITTER_NAME: 'acme',
    GIT_COMMITTER_EMAIL: 'acme@example.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  }, extra);
}

const HISTORIA = `---
epic: 9
story: "9.1"
title: "Historia de juguete del contrato"
status: in-progress
pipelines:
  - name: A-una
    title: "una"
    status: in-progress
    acs_pending: [1]
    tasks_pending: [1]
    tests_pending: [T1]
---

# Story 9.1: Historia de juguete del contrato

Status: in-progress

## Acceptance Criteria

1. **Given** algo **When** pasa **Then** se ve.

### Tests (1 verificación)

| # | Test | AC | Nivel | Escenario | Resultado esperado |
|---|------|----|-------|-----------|--------------------|
| T1 | \`Algo_Pasa_SeVe\` | 1 | unit | algo | se ve |

## Tasks / Subtasks

- [ ] Task 1: algo (AC: 1)
`;

/**
 * Los casos: al menos uno por subcomando. `marcador`: arranca con un marcador de la historia de juguete. Las rutas van
 * con marcas que el armado reemplaza: {REPO}, {STORY}, {HOME}. Los que piden una firma entran por su camino sin
 * terminal (la salida nombra el comando que corre la persona).
 */
const CASOS = [
  { id: 'set-sin-json', argv: ['set', '{no'] },
  { id: 'set-ok', argv: ['set', '{"storyId":"9.1","storyPath":"{STORY}","repoPath":"{REPO}"}'] },
  { id: 'get', marcador: true, argv: ['get'] },
  { id: 'get-sin-marcador', argv: ['get'] },
  { id: 'touch', marcador: true, argv: ['touch'] },
  { id: 'complete-step-sin-paso', marcador: true, argv: ['complete-step'] },
  { id: 'complete-step-numero', marcador: true, argv: ['complete-step', '3'] },
  { id: 'complete-step-plan-sin-validar', marcador: true, argv: ['complete-step', 'plan'] },
  { id: 'start-step', marcador: true, argv: ['start-step', 'validate-story'] },
  { id: 'append-file', marcador: true, argv: ['append-file', '{REPO}/src/a.js'] },
  { id: 'clear', marcador: true, argv: ['clear'] },
  { id: 'is-active', marcador: true, argv: ['is-active'] },
  { id: 'list-all', marcador: true, argv: ['list-all'] },
  { id: 'find-by-story', marcador: true, argv: ['find-by-story', '9.1'] },
  { id: 'clear-session-sin-id', argv: ['clear-session'] },
  { id: 'restore-sin-id', argv: ['restore'] },
  { id: 'restore-desconocida', argv: ['restore', 'ses-que-no-existe'] },
  { id: 'adopt-session-sin-id', argv: ['adopt-session'] },
  { id: 'update-story-status', marcador: true, argv: ['update-story-status', '{STORY}', 'review'] },
  { id: 'update-story-status-invalido', marcador: true, argv: ['update-story-status', '{STORY}', 'cualquiera'] },
  { id: 'update-pipeline-status', marcador: true, argv: ['update-pipeline-status', '{STORY}', 'A-una', 'blocked'] },
  { id: 'mark-dod-runtime-checked-sin-json', marcador: true, argv: ['mark-dod-runtime-checked', '{no'] },
  { id: 'set-autonomous', marcador: true, argv: ['set-autonomous', 'false'] },
  { id: 'set-batch', marcador: true, argv: ['set-batch', 'A-una'] },
  { id: 'set-check-sin-manual', marcador: true, argv: ['set-check', 'build', 'green'] },
  { id: 'set-check-manual', marcador: true, argv: ['set-check', 'build', 'green', '--manual'] },
  { id: 'run-check-ok', marcador: true, argv: ['run-check', 'build', '--', 'node', '-e', 'process.exit(0)'] },
  { id: 'run-check-rojo', marcador: true, argv: ['run-check', 'build', '--', 'node', '-e', 'process.exit(3)'] },
  { id: 'mark-tests-not-scoped', marcador: true, argv: ['mark-tests-not-scoped'] },
  { id: 'tests-failed-sin-args', marcador: true, argv: ['tests-failed'] },
  { id: 'mark-tests-not-measured', marcador: true, argv: ['mark-tests-not-measured'] },
  { id: 'set-flag-sin-motivo', marcador: true, argv: ['set-flag', 'atddBypass', 'true'] },
  { id: 'set-flag-con-motivo', marcador: true, argv: ['set-flag', 'atddBypass', 'true', '--reason', 'refactor sobre la red de siempre'] },
  { id: 'start-warning', marcador: true, argv: ['start-warning', 'time-tracking', 'sin persona'] },
  { id: 'close-as-debt-sin-args', marcador: true, argv: ['close-as-debt'] },
  { id: 'lift-debt-sin-args', marcador: true, argv: ['lift-debt'] },
  { id: 'expect-red-sin-args', marcador: true, argv: ['expect-red'] },
  { id: 'note-red-test-sin-args', marcador: true, argv: ['note-red-test'] },
  { id: 'set-size', marcador: true, argv: ['set-size', 'completa', '--reason', 'superficie compartida'] },
  { id: 'set-models-sin-args', marcador: true, argv: ['set-models'] },
  { id: 'mark-models-warned', marcador: true, argv: ['mark-models-warned'] },
  { id: 'snapshot-iter-sin-n', marcador: true, argv: ['snapshot-iter'] },
  { id: 'snapshot-iter', marcador: true, argv: ['snapshot-iter', '1'] },
  { id: 'runtime-waiver-sin-args', marcador: true, argv: ['runtime-waiver'] },
  { id: 'runtime-waiver-sin-terminal', marcador: true, argv: ['runtime-waiver', '{STORY}'] },
  { id: 'waive-critical-sin-args', marcador: true, argv: ['waive-critical'] },
  { id: 'waive-critical-sin-terminal', marcador: true, argv: ['waive-critical', '--rule', 'X-C1', '--file', 'src/a.js', '--reason', 'probado'] },
  { id: 'compare-waiver-sin-args', marcador: true, argv: ['compare-waiver'] },
  { id: 'sign-adversarial-skip-sin-args', marcador: true, argv: ['sign-adversarial-skip'] },
  { id: 'approve-pending-sin-args', marcador: true, argv: ['approve-pending'] },
  { id: 'approve-save-sin-args', marcador: true, argv: ['approve-save'] },
  { id: 'plan-review-sin-plan', marcador: true, argv: ['plan-review'] },
  { id: 'review-ask-sin-args', marcador: true, argv: ['review-ask'] },
  { id: 'review-answer-sin-args', marcador: true, argv: ['review-answer'] },
  { id: 'owner-away-sin-args', argv: ['owner-away'] },
  { id: 'save-check-sin-args', marcador: true, argv: ['save-check'] },
  // con una frase que no nombra el rol: sin frase, la respuesta depende de las firmas del perfil del equipo, que se leen
  // siempre del perfil del árbol (ninguna variable las cambia) y el árbol armado del portón lo trae
  { id: 'designate-relay-frase-sin-rol', argv: ['designate-relay', '--approved-by', 'acme', '--quote', 'hola'] },
  { id: 'withdraw-relay', argv: ['withdraw-relay'] },
  { id: 'mark-tested-sin-args', marcador: true, argv: ['mark-tested'] },
  { id: 'mark-adversarial-launched', marcador: true, argv: ['mark-adversarial-launched', 'run-juguete', '4'] },
  { id: 'freeze-adversarial', marcador: true, argv: ['freeze-adversarial'] },
  { id: 'mark-adversarial-result-sin-json', marcador: true, argv: ['mark-adversarial-result', '{no'] },
  { id: 'mark-adversarial-skipped-sin-args', marcador: true, argv: ['mark-adversarial-skipped'] },
  { id: 'mark-adversarial-gate-sin-json', marcador: true, argv: ['mark-adversarial-gate', '{no'] },
  { id: 'promote-probe-sin-args', marcador: true, argv: ['promote-probe'] },
  { id: 'adhoc-get', argv: ['adhoc', 'get'] },
  { id: 'adhoc-clear-sin-carril', argv: ['adhoc', 'clear'] },
  { id: 'adhoc-set-sin-terminal', argv: ['adhoc', 'set', '{"reason":"arreglo del texto del botón","datos":"sin-cambio","allowedFiles":["src/a.js"]}'] },
  { id: 'adhoc-desconocido', argv: ['adhoc', 'cualquiera'] },
  { id: 'doing', marcador: true, argv: ['doing', 'algo de la historia', '--until', '23:59'] },
  { id: 'doing-esperando', marcador: true, argv: ['doing', '--waiting-for', 'la firma del plan'] },
  { id: 'story-skill-bypass', argv: ['story-skill-bypass'] },
  { id: 'sign-file-sin-args', argv: ['sign-file'] },
  { id: 'approve-mockup-sin-args', marcador: true, argv: ['approve-mockup'] },
  { id: 'rethink-sin-args', marcador: true, argv: ['rethink'] },
  { id: 'park-sin-args', marcador: true, argv: ['park'] },
  { id: 'unpark-sin-args', argv: ['unpark'] },
  // el estado que cambia mientras corre (SID, SOLO_LECTURA, NECESITA_MARCADOR): otra sesión, la terminal sin sesión
  // propia y una firma para otra sesión
  { id: 'get-para-otra-sesion', marcador: true, argv: ['get', '--for-session', 'ses-otra'] },
  { id: 'set-check-para-otra-sesion', marcador: true, argv: ['set-check', 'build', 'green', '--manual', '--for-session', 'ses-otra'] },
  { id: 'doing-terminal-sin-sesion', marcador: true, sinSesion: true, argv: ['doing', '--waiting-for', 'la firma', '--terminal', '--for-session', SID] },
  { id: 'get-terminal-sin-sesion', marcador: true, sinSesion: true, argv: ['get', '--terminal', '--for-session', SID] },
  { id: 'approve-pending-para-otra-sesion', marcador: true, argv: ['approve-pending', '--id', 'DEF-x', '--for-session', 'ses-otra'] },
  { id: 'waive-critical-para-otra-sesion', marcador: true, argv: ['waive-critical', '--rule', 'X-C1', '--file', 'src/a.js', '--reason', 'probado', '--for-session', 'ses-otra'] },
  // los subcomandos que nacieron después del primer borrador de la partición
  { id: 'pr-sin-args', marcador: true, argv: ['pr'] },
  { id: 'resume-autonomy-sin-pausa', marcador: true, argv: ['resume-autonomy'] },
  { id: 'declare-pending-sin-args', marcador: true, argv: ['declare-pending'] },
  { id: 'waiting-on-main-sin-args', marcador: true, argv: ['waiting-on-main'] },
  { id: 'waiting-on-main-mark-sin-porton', marcador: true, argv: ['waiting-on-main', 'mark'] },
  { id: 'desconocido', argv: ['cualquiera'] },
  { id: 'sin-comando', argv: [] },
];

const reemplazar = (s, m) => String(s).replace(/\{REPO\}/g, m.repo).replace(/\{STORY\}/g, m.story).replace(/\{HOME\}/g, m.home);

function git(dir, env, ...a) {
  return spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', dir, ...a], { encoding: 'utf8', env });
}

/** La carpeta fija de un caso, vacía: la HOME y el repo de juguete con la historia. */
function armar(caso) {
  const raiz = path.join(fs.realpathSync(os.tmpdir()), 'split-contract', caso.id);
  fs.rmSync(raiz, { recursive: true, force: true });
  const home = path.join(raiz, 'home');
  const repo = path.join(raiz, 'repo');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  const story = path.join(repo, 'specs', 'story-9.1-juguete.md');
  fs.writeFileSync(story, HISTORIA);
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 1;\n');
  const env = entorno(home);
  git(repo, env, 'init', '-q', '-b', 'main');
  git(repo, env, 'add', '-A');
  git(repo, env, 'commit', '-q', '-m', 'base');
  return { raiz, home, repo, story, env };
}

/** Los archivos de la HOME y del repo (sin .git), con su texto. */
function archivos(m) {
  const out = {};
  const recorrer = (base, etiqueta) => {
    const pila = [base];
    while (pila.length) {
      const d = pila.pop();
      let hijos = [];
      try { hijos = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const h of hijos) {
        const p = path.join(d, h.name);
        if (h.isDirectory()) { if (h.name !== '.git') pila.push(p); continue; }
        if (!h.isFile()) continue;
        let t;
        try { t = fs.readFileSync(p, 'utf8'); } catch { t = '<ilegible>'; }
        out[`${etiqueta}/${path.relative(base, p)}`] = t;
      }
    }
  };
  recorrer(m.home, 'HOME');
  recorrer(m.repo, 'REPO');
  return out;
}

/**
 * Lo que cambia de una corrida a otra sin que cambie el comportamiento: la carpeta del caso, las fechas, las horas, los
 * sellos (milisegundos, pid, huellas largas) y las duraciones.
 */
function normalizar(texto, m) {
  let t = String(texto);
  for (const r of [m.raiz, fs.realpathSync(os.tmpdir()), os.tmpdir()]) t = t.split(r).join('<RAIZ>');
  t = t.split(SCRIPTS).join('<GUIONES>');
  // la raíz del arnés (sus scripts/lib, sus guías): la carpeta de la máquina no es comportamiento, ni se publica
  t = t.split(path.resolve(SCRIPTS, '..', '..', '..')).join('<ARNES>');
  t = t.split(os.homedir()).join('<CASA>');
  // el usuario de la máquina (quién anotó algo): tampoco es comportamiento
  const usuario = (() => { try { return os.userInfo().username; } catch { return ''; } })();
  if (usuario.length >= 3) t = t.replace(new RegExp(`\\b${usuario.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), '<USUARIO>');
  return t
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<FECHA>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?Z?/g, '<FECHA>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{4}(?:\d{2})?\b/g, '<FECHA>')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<DIA>')
    .replace(/\b\d{8}-?\d{6}\b/g, '<SELLO>')
    .replace(/\b\d{13}\b/g, '<MS>')
    .replace(/\b[0-9a-f]{12,}\b/g, '<HEX>')
    // el sello de la copia congelada de un repo depende del árbol, no de lo que hace el subcomando
    .replace(/\brepo-[0-9a-f]{8}\b/g, 'repo-<SELLO>')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '<HORA>')
    .replace(/\b\d+(?:[.,]\d+)?\s?(ms|s|min)\b/g, '<N> $1')
    .replace(/"(pid|ppid|durationMs|duration_ms|ms)":\s?\d+/g, '"$1":<N>');
}

/** Corre un caso contra `scripts` (la carpeta con marker.js): `{ status, stdout, stderr, archivos }`, normalizado. */
function correr(caso, scripts = SCRIPTS) {
  const m = armar(caso);
  const marker = path.join(scripts, 'marker.js');
  if (caso.marcador) {
    const r = spawnSync(process.execPath, [marker, 'set', JSON.stringify({ storyId: '9.1', storyPath: m.story, repoPath: m.repo })],
      { cwd: m.repo, env: m.env, encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0) throw new Error(`no pude armar el marcador del caso ${caso.id}: ${r.stderr}`);
  }
  const antes = archivos(m);
  const env = { ...m.env };
  if (caso.sinSesion) { delete env.CLAUDE_CODE_SESSION_ID; delete env.TYCON_SESSION_ID; }
  const r = spawnSync(process.execPath, [marker, ...caso.argv.map((a) => reemplazar(a, m))],
    { cwd: m.repo, env, encoding: 'utf8', timeout: 30000, input: '' });
  const despues = archivos(m);
  const cambiados = {};
  for (const [k, v] of Object.entries(despues)) if (antes[k] !== v) cambiados[normalizar(k, m)] = normalizar(v, m);
  for (const k of Object.keys(antes)) if (!(k in despues)) cambiados[normalizar(k, m)] = '<BORRADO>';
  const out = { status: r.status, signal: r.signal || null, stdout: normalizar(r.stdout || '', m), stderr: normalizar(r.stderr || '', m), archivos: cambiados };
  fs.rmSync(m.raiz, { recursive: true, force: true });
  return out;
}

/**
 * La primera diferencia entre dos resultados de un caso, en una línea legible, o null si son iguales: qué campo, qué
 * renglón y qué decía antes y después.
 */
function diferencia(antes, despues) {
  if (antes.status !== despues.status) return `código de salida: antes ${antes.status}, después ${despues.status}`;
  if ((antes.signal || null) !== (despues.signal || null)) return `señal: antes ${antes.signal}, después ${despues.signal}`;
  for (const campo of ['stdout', 'stderr']) {
    if (antes[campo] === despues[campo]) continue;
    const a = String(antes[campo]).split('\n');
    const d = String(despues[campo]).split('\n');
    const i = a.findIndex((l, k) => l !== d[k]);
    const n = i === -1 ? a.length : i;
    return `${campo}, renglón ${n + 1}: antes «${a[n] === undefined ? '<nada>' : a[n]}», después «${d[n] === undefined ? '<nada>' : d[n]}»`;
  }
  const ka = Object.keys(antes.archivos || {}).sort();
  const kd = Object.keys(despues.archivos || {}).sort();
  for (const k of new Set([...ka, ...kd])) {
    if (!(k in (antes.archivos || {}))) return `archivo escrito sólo después: ${k}`;
    if (!(k in (despues.archivos || {}))) return `archivo escrito sólo antes: ${k}`;
    if (antes.archivos[k] !== despues.archivos[k]) {
      const a = antes.archivos[k].split('\n');
      const d = despues.archivos[k].split('\n');
      const i = a.findIndex((l, j) => l !== d[j]);
      const n = i === -1 ? a.length : i;
      return `archivo ${k}, renglón ${n + 1}: antes «${a[n] === undefined ? '<nada>' : a[n]}», después «${d[n] === undefined ? '<nada>' : d[n]}»`;
    }
  }
  return null;
}

const RAIZ_ARNES = path.resolve(SCRIPTS, '..', '..', '..');
const LIB = path.join(SCRIPTS, 'lib');
/** Los módulos de la partición que hay hoy: `lib/marker-*.js` (sin marker-command.js, que ya existía y es otra cosa). */
const modulosDeLaParticion = (lib = LIB) => {
  try { return fs.readdirSync(lib).filter((f) => /^marker-.+\.js$/.test(f) && f !== 'marker-command.js').sort(); } catch { return []; }
};

/**
 * Los `require` locales de un archivo, resueltos a rutas relativas a la raíz del arnés (con `/`): los literales
 * (`require('./x.js')`) y los armados con la carpeta del archivo o con `SCRIPTS_DIR` y partes literales
 * (`require(path.join(__dirname, 'lib', 'x.js'))`). Lo que se arma con otra variable no se puede resolver y no cuenta.
 */
function requiresLocales(archivo, scriptsDir = SCRIPTS) {
  const texto = fs.readFileSync(archivo, 'utf8');
  const dir = path.dirname(archivo);
  const out = new Set();
  const rel = (abs) => path.relative(path.resolve(scriptsDir, '..', '..', '..'), abs).split(path.sep).join('/');
  for (const m of texto.matchAll(/require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g)) out.add(rel(path.resolve(dir, m[1])));
  for (const m of texto.matchAll(/require\(\s*path\.join\(\s*(__dirname|SCRIPTS_DIR)\s*,\s*((?:'[^']*'\s*,?\s*)+)\)\s*\)/g)) {
    const base = m[1] === '__dirname' ? dir : scriptsDir;
    const partes = [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]);
    out.add(rel(path.resolve(base, ...partes)));
  }
  return [...out].sort();
}

/** Las claves de `module.exports` de pipeline.js (se carga sin correr: tiene su guardia de `require.main`). */
function clavesDePipeline(scriptsDir = SCRIPTS) {
  const r = spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(Object.keys(require(${JSON.stringify(path.join(scriptsDir, 'pipeline.js'))})).sort()))`],
    { encoding: 'utf8', env: entorno(fs.mkdtempSync(path.join(os.tmpdir(), 'split-claves-'))), timeout: 30000 });
  if (r.status !== 0) throw new Error(`no pude cargar pipeline.js: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/**
 * Las claves de `module.exports` de marker.js, leídas del texto: el despachador corre al cargarse, así que no se puede
 * hacer `require` sin correr un subcomando. Hoy no exporta nada.
 */
function clavesDeMarker(scriptsDir = SCRIPTS) {
  const texto = fs.readFileSync(path.join(scriptsDir, 'marker.js'), 'utf8');
  const claves = new Set();
  for (const m of texto.matchAll(/module\.exports\s*=\s*\{([^}]*)\}/g)) for (const k of m[1].split(',')) if (k.trim()) claves.add(k.split(':')[0].trim());
  for (const m of texto.matchAll(/module\.exports\.(\w+)\s*=/g)) claves.add(m[1]);
  return [...claves].sort();
}

/** Corre todos los casos dos veces y deja afuera lo que no es estable entre corridas (eso no es comportamiento). */
function grabar() {
  const foto = { nota: 'salida de cada caso con el marker.js sin partir; grabada con SPLIT_CONTRACT_RECORD=1', casos: {} };
  const inestables = [];
  for (const caso of CASOS) {
    const a = correr(caso);
    const b = correr(caso);
    const d = diferencia(a, b);
    if (d) inestables.push(`${caso.id}: ${d}`);
    foto.casos[caso.id] = a;
  }
  if (inestables.length) throw new Error(`casos inestables entre dos corridas (arreglá la normalización antes de grabar):\n${inestables.join('\n')}`);
  foto.requires = requiresLocales(path.join(SCRIPTS, 'marker.js'));
  foto.exports = { marker: clavesDeMarker(), pipeline: clavesDePipeline() };
  fs.mkdirSync(path.dirname(FOTO), { recursive: true });
  fs.writeFileSync(FOTO, JSON.stringify(foto, null, 2) + '\n');
  return foto;
}

if (GRABAR) {
  test('grabar la foto de antes', () => { grabar(); });
} else {
  test('T3 Marker_SameOutputsBeforeAndAfter @story-8.163 @ac-3', () => {
    assert.ok(fs.existsSync(FOTO), `falta la foto de antes: ${FOTO}`);
    const foto = JSON.parse(fs.readFileSync(FOTO, 'utf8'));
    const faltan = CASOS.filter((c) => !foto.casos[c.id]).map((c) => c.id);
    assert.deepStrictEqual(faltan, [], `casos sin foto de antes: ${faltan.join(', ')}`);
    const distintos = [];
    for (const caso of CASOS) {
      const d = diferencia(foto.casos[caso.id], correr(caso));
      if (d) distintos.push(`${caso.argv[0] || '(sin comando)'} · caso ${caso.id} · ${d}`);
    }
    assert.deepStrictEqual(distintos, [], `salidas que cambiaron al partir:\n${distintos.join('\n')}`);
  });

  test('T3b cada subcomando del despacho tiene al menos un caso @story-8.163 @ac-3', () => {
    const texto = fs.readFileSync(path.join(SCRIPTS, 'marker.js'), 'utf8');
    const despacho = texto.slice(texto.lastIndexOf('switch (cmd)'));
    const subcomandos = [...despacho.matchAll(/case '([\w-]+)':/g)].map((x) => x[1]);
    assert.ok(subcomandos.length >= 65, `esperaba los 65 subcomandos del despacho, encontré ${subcomandos.length}`);
    const conCaso = new Set(CASOS.map((c) => c.argv[0]));
    const sin = subcomandos.filter((s) => !conCaso.has(s));
    assert.deepStrictEqual(sin, [], `subcomandos sin caso: ${sin.join(', ')}`);
  });
}

test('T11 Split_ChangedOutput_Named @story-8.163 @ac-11', () => {
  const base = { status: 0, signal: null, stdout: 'uno\ndos\n', stderr: '', archivos: { 'HOME/a.json': '{"x":1}' } };
  assert.strictEqual(diferencia(base, JSON.parse(JSON.stringify(base))), null, 'iguales: sin diferencia');
  assert.match(diferencia(base, { ...base, status: 2 }), /código de salida: antes 0, después 2/);
  assert.match(diferencia(base, { ...base, stdout: 'uno\ntres\n' }), /stdout, renglón 2: antes «dos», después «tres»/);
  assert.match(diferencia(base, { ...base, archivos: { 'HOME/a.json': '{"x":2}' } }), /archivo HOME\/a\.json, renglón 1/);
  assert.match(diferencia(base, { ...base, archivos: {} }), /archivo escrito sólo antes: HOME\/a\.json/);
  // la prueba de T3 arma su mensaje con el subcomando, el caso y la diferencia
  const caso = CASOS.find((c) => c.id === 'get');
  const linea = `${caso.argv[0]} · caso ${caso.id} · ${diferencia(base, { ...base, status: 1 })}`;
  assert.match(linea, /^get · caso get · código de salida: antes 0, después 1$/);
});

test('T15 Exports_SameKeysBeforeAndAfter @story-8.163 @ac-15', () => {
  const foto = JSON.parse(fs.readFileSync(FOTO, 'utf8'));
  assert.ok(foto.exports, 'la foto de antes trae las exportaciones');
  assert.deepStrictEqual(clavesDeMarker(), foto.exports.marker, 'marker.js exporta lo mismo');
  assert.deepStrictEqual(clavesDePipeline(), foto.exports.pipeline, 'pipeline.js exporta lo mismo');
});

/** Lo que cargan los archivos y no estaba en la lista de antes, y no es sensible. */
function nuevosNoSensibles(antes, archivos, scriptsDir = SCRIPTS) {
  const { esSensible } = require(path.join(LIB, 'save-ok.js'));
  const ahora = new Set(archivos.flatMap((a) => requiresLocales(a, scriptsDir)));
  return [...ahora].filter((r) => !antes.includes(r) && !esSensible(r)).sort();
}

test('T16 Split_ModulesAreSensitive @story-8.163 @ac-16', () => {
  const { esSensible } = require(path.join(LIB, 'save-ok.js'));
  // lo que sale de marker.js, de pipeline.js y del freno de guiones nace sensible, se llame como se llame la parte
  for (const m of ['marker-firmas.js', 'pipeline-pasos.js', 'bash-gate-guiones.js']) {
    assert.ok(esSensible(`skills/tycon-pipeline/scripts/lib/${m}`), `lib/${m} es sensible`);
  }
  // la medida es lo que carga el despachador contra la lista de antes, no el nombre: un módulo nuevo fuera del patrón
  // falla; uno de la partición no; uno que ya cargaba (lib/steps.js) no cuenta
  const antes = requiresLocales(path.join(SCRIPTS, 'marker.js'));
  assert.ok(antes.includes('skills/tycon-pipeline/scripts/lib/steps.js'), 'marker.js ya cargaba lib/steps.js');
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'split-sensible-'));
  const juguete = path.join(raiz, 'skills', 'tycon-pipeline', 'scripts', 'marker.js');
  fs.mkdirSync(path.dirname(juguete), { recursive: true });
  fs.writeFileSync(juguete, "require('./lib/x.js');\nrequire('./lib/steps.js');\nrequire('./lib/marker-firmas.js');\n");
  assert.deepStrictEqual(nuevosNoSensibles(antes, [juguete], path.dirname(juguete)), ['skills/tycon-pipeline/scripts/lib/x.js'],
    'el juguete nuevo falla; lib/steps.js, que ya estaba, y lib/marker-firmas.js, sensible, no');
});

// ── el recorrido del freno de guiones ────────────────────────────────────────────────────────────────────────────────

const bash = () => require(path.join(SCRIPTS, 'on-bash-write-gate.js'));
const FRENO_ENTERO = '⛔ tycon-pipeline — GUION QUE NO SE PUEDE LEER ENTERO';

/** Un repo de juguete con una historia y una carpeta de estado, para el freno. */
function repoDelFreno() {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'split-freno-')));
  const estado = path.join(raiz, 'estado');
  const dir = path.join(raiz, 'repo');
  fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'specs', 'story-1.1.md'), '---\nstory: "1.1"\nepic: "1"\ntitle: "x"\nstatus: in-progress\n---\n\n# x\n');
  return { raiz, estado, dir };
}

function frenar(r, command, installedRoots = []) {
  const antes = process.env.TYCON_NO_RUN_CHANGE;
  process.env.TYCON_NO_RUN_CHANGE = '1';
  try {
    const x = bash().handle({ tool_name: 'Bash', session_id: 'sesion-split', cwd: r.dir, tool_input: { command } }, { stateDir: r.estado, installedRoots });
    return x && x.block ? String(x.block) : '';
  } finally { if (antes === undefined) delete process.env.TYCON_NO_RUN_CHANGE; else process.env.TYCON_NO_RUN_CHANGE = antes; }
}

/** Una cadena de módulos de juguete: `principal.js` → m1 → … → m<largo>; el último hace `ultimo`. */
function cadena(dir, largo, ultimo) {
  fs.mkdirSync(path.join(dir, 'herr'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'herr', 'principal.js'), "require('./m1.js');\n");
  for (let i = 1; i <= largo; i++) fs.writeFileSync(path.join(dir, 'herr', `m${i}.js`), i === largo ? ultimo : `require('./m${i + 1}.js');\n`);
}
// la ruta de la constancia va armada por partes: escrita entera, el freno de esta misma sesión leería esta prueba como
// un guion que escribe una constancia
const CONSTANCIA = ['.tycon', 'control-changes', 'aprobado.json'].join('/');
const ESCRIBE_CONSTANCIA = ['require(\'fs\').write', 'FileSync(\'', CONSTANCIA, '\', \'{}\');\n'].join('');
const NO_ESCRIBE = "module.exports = 1 + 1;\n";

// 🔴 Falla con: el recorrido que corta callado a los 2 niveles o a los 20 archivos (el freno de antes), o que juzga el
// primer módulo pasado el tope pero no lo que ese módulo carga.
test('T14 BashGate_DeepModule_BlocksNotCuts @story-8.163 @ac-14', () => {
  const freno = fs.readFileSync(path.join(SCRIPTS, 'on-bash-write-gate.js'), 'utf8');
  // sin nombre todavía, el de antes: 2 niveles y 20 archivos (el comportamiento da el rojo, no la falta del nombre)
  const niveles = Number((/const RECORRIDO_NIVELES = (\d+);/.exec(freno) || [])[1]) || 2;
  const tope = Number((/const RECORRIDO_ARCHIVOS = (\d+);/.exec(freno) || [])[1]) || 20;
  // nivel 3: el freno de antes cortaba callado a los 2 niveles
  const a = repoDelFreno();
  cadena(a.dir, 3, ESCRIBE_CONSTANCIA);
  assert.notStrictEqual(frenar(a, 'node herr/principal.js'), '', 'el módulo del nivel 3 que escribe una constancia frena');
  // el archivo 21 de los que carga: el de antes cortaba callado a los 20
  const b = repoDelFreno();
  fs.mkdirSync(path.join(b.dir, 'herr'), { recursive: true });
  fs.writeFileSync(path.join(b.dir, 'herr', 'principal.js'), Array.from({ length: 21 }, (_, i) => `require('./h${i + 1}.js');`).join('\n') + '\n');
  for (let i = 1; i <= 21; i++) fs.writeFileSync(path.join(b.dir, 'herr', `h${i}.js`), i === 21 ? ESCRIBE_CONSTANCIA : NO_ESCRIBE);
  assert.notStrictEqual(frenar(b, 'node herr/principal.js'), '', 'el archivo 21 que escribe una constancia frena');
  // más allá del número nuevo: frena con «no se puede leer entero»
  const c = repoDelFreno();
  cadena(c.dir, niveles + 1, ESCRIBE_CONSTANCIA);
  assert.ok(frenar(c, 'node herr/principal.js').startsWith(FRENO_ENTERO), 'más allá del tope, frena con «no se puede leer entero»');
  // igual de hondo, sin escribir ni nombrar historia ni constancia: no frena
  const d = repoDelFreno();
  cadena(d.dir, niveles + 1, NO_ESCRIBE);
  assert.strictEqual(frenar(d, 'node herr/principal.js'), '', 'igual de hondo y sin escribir: no frena');
  // lo que carga un módulo fuera del tope también se mira: dos niveles más allá frena igual, y sin escribir sigue sin frenar
  const e = repoDelFreno();
  cadena(e.dir, niveles + 2, ESCRIBE_CONSTANCIA);
  assert.ok(frenar(e, 'node herr/principal.js').startsWith(FRENO_ENTERO), 'dos niveles más allá del tope, frena');
  const f = repoDelFreno();
  cadena(f.dir, niveles + 2, NO_ESCRIBE);
  assert.strictEqual(frenar(f, 'node herr/principal.js'), '', 'dos niveles más allá y sin escribir: no frena');
  // lo mismo pasado el tope de archivos: el último de la lista no escribe, pero carga al que escribe
  const g = repoDelFreno();
  fs.mkdirSync(path.join(g.dir, 'herr'), { recursive: true });
  fs.writeFileSync(path.join(g.dir, 'herr', 'principal.js'), Array.from({ length: tope + 1 }, (_, i) => `require('./h${i + 1}.js');`).join('\n') + '\n');
  for (let i = 1; i <= tope; i++) fs.writeFileSync(path.join(g.dir, 'herr', `h${i}.js`), NO_ESCRIBE);
  fs.writeFileSync(path.join(g.dir, 'herr', `h${tope + 1}.js`), "require('./detras.js');\n");
  fs.writeFileSync(path.join(g.dir, 'herr', 'detras.js'), ESCRIBE_CONSTANCIA);
  assert.ok(frenar(g, 'node herr/principal.js').startsWith(FRENO_ENTERO), 'detrás del tope de archivos, frena');
  // un ciclo pasado el tope termina, sin frenar
  const h = repoDelFreno();
  cadena(h.dir, niveles + 2, `require('./m${niveles + 1}.js');\n`);
  assert.strictEqual(frenar(h, 'node herr/principal.js'), '', 'un ciclo pasado el tope termina y no frena');
  // pasado el tope, lo que no se puede leer no se da por bueno
  if (process.platform !== 'win32' && process.getuid() !== 0) {
    const i = repoDelFreno();
    cadena(i.dir, niveles + 1, NO_ESCRIBE);
    fs.chmodSync(path.join(i.dir, 'herr', `m${niveles + 1}.js`), 0o000);
    assert.ok(frenar(i, 'node herr/principal.js').startsWith(FRENO_ENTERO), 'un módulo ilegible pasado el tope frena');
  }
  // uno instalado pasado el tope no se juzga, pero lo que carga sí
  const j = repoDelFreno();
  const arnes = path.join(j.raiz, 'arnes');
  fs.mkdirSync(arnes);
  cadena(j.dir, niveles, "require('../../arnes/puente.js');\n");
  fs.writeFileSync(path.join(arnes, 'puente.js'), "require('../repo/herr/detras.js');\n");
  fs.writeFileSync(path.join(j.dir, 'herr', 'detras.js'), ESCRIBE_CONSTANCIA);
  assert.ok(frenar(j, 'node herr/principal.js', [arnes]).startsWith(FRENO_ENTERO), 'detrás de uno instalado, frena');
  assert.ok(niveles > 2 && tope > 20, `el tope del recorrido tiene nombre y subió (niveles ${niveles}, archivos ${tope})`);
});

// 🔴 Falla con: un recorrido que lee el mismo módulo cada vez que alguien lo pide, que no tiene tope de lectura, o que
// lee entero un ejecutable para ver su línea `#!`.
test('T14 BashGate_ModuleWalk_ReadsAreBounded @story-8.163 @ac-14', () => {
  // el mismo módulo, pedido desde dos lados, se lee una sola vez
  const a = repoDelFreno();
  fs.mkdirSync(path.join(a.dir, 'herr'), { recursive: true });
  const repetido = path.join(a.dir, 'herr', 'a.js');
  fs.writeFileSync(path.join(a.dir, 'herr', 'principal.js'), "require('./uno.js');\nrequire('./otro.js');\n");
  fs.writeFileSync(path.join(a.dir, 'herr', 'uno.js'), "require('./a.js');\n");
  fs.writeFileSync(path.join(a.dir, 'herr', 'otro.js'), "require('./a.js');\n");
  fs.writeFileSync(repetido, NO_ESCRIBE);
  const original = fs.readFileSync;
  let lecturas = 0;
  fs.readFileSync = (f, ...resto) => { if (String(f) === repetido) lecturas++; return original(f, ...resto); };
  try { assert.strictEqual(frenar(a, 'node herr/principal.js'), '', 'un módulo que no escribe no frena'); } finally { fs.readFileSync = original; }
  assert.strictEqual(lecturas, 1, 'el módulo repetido se lee una vez');
  // gastado el tope de lectura no se lee más, y lo que falta cuenta como que no se pudo leer
  const b = repoDelFreno();
  fs.mkdirSync(path.join(b.dir, 'herr'), { recursive: true });
  fs.writeFileSync(path.join(b.dir, 'herr', 'principal.js'), "require('./grande.js');\nrequire('./despues.js');\n");
  fs.writeFileSync(path.join(b.dir, 'herr', 'grande.js'), `// ${'x'.repeat(20000)}\n`);
  fs.writeFileSync(path.join(b.dir, 'herr', 'despues.js'), NO_ESCRIBE);
  const guiones = bash().guionesEnArchivo('node herr/principal.js', [b.dir], [], 8192);
  assert.ok(guiones.some((g) => g.grande && !g.texto), 'agotado el tope, queda un guion sin leer');
  assert.ok(!guiones.some((g) => g.archivo.endsWith('despues.js') && g.texto), 'lo de después del tope no se lee');
  // el tope es lo que se lee entre todos, no un umbral que se mira antes de leer: un archivo que lo pasaría no se lee
  const b2 = repoDelFreno();
  fs.mkdirSync(path.join(b2.dir, 'herr'), { recursive: true });
  fs.writeFileSync(path.join(b2.dir, 'herr', 'principal.js'), "require('./justo.js');\n");
  fs.writeFileSync(path.join(b2.dir, 'herr', 'justo.js'), `// ${'x'.repeat(5000)}\n`);
  const justos = bash().guionesEnArchivo('node herr/principal.js', [b2.dir], [], 8192);
  assert.ok(!justos.some((g) => g.archivo.endsWith('justo.js') && g.texto), 'el que pasaría el tope de lectura no se lee');
  assert.ok(justos.some((g) => g.grande && !g.texto), 'y queda como un guion sin leer');
  // de un ejecutable nombrado se mira el comienzo: su línea `#!` no pide leerlo entero
  if (process.platform !== 'win32') {
    const c = repoDelFreno();
    fs.mkdirSync(path.join(c.dir, 'herr'), { recursive: true });
    const ejecutable = path.join(c.dir, 'herr', 'programa');
    fs.writeFileSync(ejecutable, `#!/bin/sh\n# ${'x'.repeat(1024)}\n`, { mode: 0o755 });
    let leidas = 0;
    fs.readFileSync = (f, ...resto) => { if (String(f) === ejecutable) leidas++; return original(f, ...resto); };
    try { assert.strictEqual(frenar(c, './herr/programa'), '', 'un ejecutable que no corre un intérprete de guiones no frena'); } finally { fs.readFileSync = original; }
    assert.strictEqual(leidas, 0, 'el ejecutable no se lee entero para ver su primera línea');
    // con un intérprete de guiones se sigue mirando lo que escribe
    const d = repoDelFreno();
    fs.mkdirSync(path.join(d.dir, 'herr'), { recursive: true });
    fs.writeFileSync(path.join(d.dir, 'herr', 'guion'), `#!/usr/bin/env node\n${ESCRIBE_CONSTANCIA}`, { mode: 0o755 });
    assert.notStrictEqual(frenar(d, './herr/guion'), '', 'un ejecutable de node que escribe una constancia frena');
  }
});

module.exports = { CASOS, correr, diferencia, normalizar, armar, entorno, requiresLocales, SID };
