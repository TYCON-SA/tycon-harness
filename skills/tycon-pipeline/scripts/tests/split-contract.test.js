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
// la de pipeline.js se graba aparte (`SPLIT_CONTRACT_RECORD=pipeline`), sobre el pipeline.js sin partir
const FOTO_PIPELINE = path.join(__dirname, 'fixtures', 'split-contract', 'pipeline-before.json');
const SID = 'ses-contrato-8163';
const GRABAR = process.env.SPLIT_CONTRACT_RECORD === '1';
const GRABAR_PIPELINE = process.env.SPLIT_CONTRACT_RECORD === 'pipeline';

const FUERA_DEL_ENTORNO = ['TYCON_GUIDES_DIR', 'TCG', 'NODE_TEST_CONTEXT', 'TYCON_SKILLS_DIR', 'TYCON_HOME', 'TYCON_STATE_DIR',
  'TYCON_AUTO_SNAPSHOT', 'TYCON_SNAPSHOT_GUARD', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'TYCON_SESSION_ID',
  'CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'TYCON_EVIDENCE_DIR', 'TYCON_EVIDENCE_KEY', 'STOP_AUTONOMY',
  'TYCON_HARNESS_LOCK_HELD', 'TYCON_TEST_GATE', 'TYCON_TEST_SCOPE', 'TF_BUILD', 'CI', 'GITHUB_ACTIONS'];

// los paquetes de revisores: una carpeta propia y vacía, como la del público solo donde se grabó la foto. El árbol armado
// de la noche trae los del equipo, y sin esto la nota de paquetes cambia aunque el subcomando no
const PAQUETES_VACIOS = fs.mkdtempSync(path.join(os.tmpdir(), 'split-contract-paquetes-'));

function entorno(home, extra = {}) {
  const env = { ...process.env };
  for (const k of FUERA_DEL_ENTORNO) delete env[k];
  return Object.assign(env, {
    HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: SID, TYCON_SESSION_ID: SID, TYCON_PACKS_DEFAULT: 'none', TYCON_PACKS_DIR: PAQUETES_VACIOS,
    // quién pide algo (`set-size` lo anota): fijo, porque en la CI no hay USER y cae en la sesión
    USER: 'acme', USERNAME: 'acme', LOGNAME: 'acme',
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
  { id: 'check-runtime-waiver', marcador: true, argv: ['check-runtime-waiver', '{STORY}'] },
  { id: 'waive-critical-sin-args', marcador: true, argv: ['waive-critical'] },
  { id: 'waive-critical-sin-terminal', marcador: true, argv: ['waive-critical', '--rule', 'X-C1', '--file', 'src/a.js', '--reason', 'probado'] },
  { id: 'compare-waiver-sin-args', marcador: true, argv: ['compare-waiver'] },
  { id: 'sign-adversarial-skip-sin-args', marcador: true, argv: ['sign-adversarial-skip'] },
  { id: 'sign-atdd-skip-sin-args', marcador: true, argv: ['sign-atdd-skip'] },
  { id: 'approve-save-sin-args', marcador: true, argv: ['approve-save'] },
  { id: 'save-check-sin-args', marcador: true, argv: ['save-check'] },
  { id: 'approve-pending-sin-args', marcador: true, argv: ['approve-pending'] },
  { id: 'plan-review-sin-plan', marcador: true, argv: ['plan-review'] },
  { id: 'review-ask-sin-args', marcador: true, argv: ['review-ask'] },
  { id: 'review-answer-sin-args', marcador: true, argv: ['review-answer'] },
  { id: 'owner-away-sin-args', argv: ['owner-away'] },
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
  { id: 'conditions', marcador: true, argv: ['conditions', 'ninguna'] },
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

/**
 * Los casos de pipeline.js: al menos uno por subcomando, más el carril rápido, el pedido para otra sesión, el subcomando
 * desconocido y sin comando. Los que leen la corrida arrancan con el marcador de la historia de juguete.
 */
const CASOS_PIPELINE = [
  { id: 'review-rounds-sin-marcador', argv: ['review-rounds'] },
  { id: 'review-rounds', marcador: true, argv: ['review-rounds'] },
  { id: 'advisors-sin-args', argv: ['advisors'] },
  { id: 'advisors', marcador: true, argv: ['advisors', '--repo', '{REPO}', '--story', '{STORY}', '--files', 'src/a.js'] },
  { id: 'advisors-archivo-fantasma', marcador: true, argv: ['advisors', '--repo', '{REPO}', '--story', '{STORY}', '--files', 'src/no-existe.js'] },
  { id: 'advisors-carril-sin-carril', argv: ['advisors', '--adhoc'] },
  { id: 'check-count-carril-sin-carril', argv: ['check-count', '--adhoc'] },
  { id: 'deep-review-gate-carril-sin-carril', argv: ['deep-review-gate', '--adhoc'] },
  { id: 'siblings', argv: ['siblings', '--repo', '{REPO}'] },
  { id: 'validators', argv: ['validators', '--story', '{STORY}', '--repo', '{REPO}'] },
  { id: 'smart-reloop-sin-args', argv: ['smart-reloop'] },
  { id: 'smart-reloop-sin-foto', marcador: true, argv: ['smart-reloop', '--iter', '2', '--repo', '{REPO}', '--story', '{STORY}', '--files', 'src/a.js'] },
  { id: 'preflight-frontmatter', argv: ['preflight-frontmatter', '--story-path', '{STORY}', '--target-status', 'review'] },
  { id: 'reviewers-run-sin-args', argv: ['reviewers-run'] },
  { id: 'check-count-sin-marcador', argv: ['check-count', '--ran', 'a,b'] },
  { id: 'check-count', marcador: true, argv: ['check-count', '--ran', 'a,b'] },
  { id: 'lint-config', argv: ['lint-config', '--repo', '{REPO}'] },
  { id: 'advisor-runs', marcador: true, argv: ['advisor-runs'] },
  { id: 'next-sin-marcador', argv: ['next'] },
  { id: 'next', marcador: true, argv: ['next'] },
  { id: 'next-para-otra-sesion', marcador: true, argv: ['next', '--for-session', 'ses-otra'] },
  { id: 'work-signal', marcador: true, argv: ['work-signal'] },
  { id: 'work-signal-start', marcador: true, argv: ['work-signal', 'start'] },
  { id: 'ado-mark-active-sin-pedido', marcador: true, argv: ['ado-mark-active'] },
  { id: 'estimate-real', marcador: true, argv: ['estimate-real'] },
  { id: 'start-sin-args', argv: ['start'] },
  { id: 'start', argv: ['start', '--story', '{STORY}', '--repo', '{REPO}', '--brief'] },
  { id: 'risk-class', argv: ['risk-class', '--story', '{STORY}', '--files', 'src/a.js', '--repo', '{REPO}'] },
  { id: 'story-review-gate', argv: ['story-review-gate', '--story', '{STORY}', '--repo', '{REPO}'] },
  { id: 'story-review-record-sin-args', argv: ['story-review-record'] },
  { id: 'validation-record-sin-args', argv: ['validation-record'] },
  { id: 'move-story-sin-args', argv: ['move-story'] },
  { id: 'tooling-expected', argv: ['tooling-expected', '--repo', '{REPO}'] },
  { id: 'model-hint', argv: ['model-hint', '--story', '{STORY}', '--files', 'src/a.js'] },
  { id: 'deep-review-gate', argv: ['deep-review-gate', '--repo', '{REPO}', '--story', '{STORY}', '--files', 'src/a.js'] },
  { id: 'timing-report', marcador: true, argv: ['timing-report'] },
  { id: 'cost-report', marcador: true, argv: ['cost-report'] },
  { id: 'org-rules', argv: ['org-rules', '--repo', '{REPO}'] },
  { id: 'readability-brief-sin-args', argv: ['readability-brief'] },
  { id: 'evidence-key', argv: ['evidence-key', '--story', '{STORY}'] },
  { id: 'compare-candidates-sin-args', argv: ['compare-candidates'] },
  { id: 'compare-candidates', argv: ['compare-candidates', '--story', '{STORY}', '--repo', '{REPO}'] },
  { id: 'run-dir', marcador: true, argv: ['run-dir', '--story', '{STORY}', '--repo', '{REPO}'] },
  { id: 'evidence-dir', argv: ['evidence-dir', '--story', '{STORY}'] },
  { id: 'e2e-config', argv: ['e2e-config', '--repo', '{REPO}'] },
  { id: 'dep-gate', argv: ['dep-gate', '--repo', '{REPO}', '--story', '{STORY}'] },
  { id: 'next-story', argv: ['next-story', '--repo', '{REPO}'] },
  { id: 'write-followups-sin-args', argv: ['write-followups'] },
  { id: 'write-findings-sin-hallazgos', marcador: true, argv: ['write-findings', '--story', '{STORY}', '--repo', '{REPO}', '--findings', '{REPO}/no-hay.json'] },
  { id: 'verify-finding-sin-args', argv: ['verify-finding'] },
  { id: 'record-refutation-sin-args', argv: ['record-refutation'] },
  { id: 'findings-status', marcador: true, argv: ['findings-status', '--story', '{STORY}', '--repo', '{REPO}'] },
  { id: 'dod-checker-needed', argv: ['dod-checker-needed', '--story', '{STORY}'] },
  { id: 'deferrals-open', argv: ['deferrals-open', '--story', '{STORY}'] },
  { id: 'qa-readability', argv: ['qa-readability', '--story', '{STORY}'] },
  { id: 'qa-readability-con-marcas', marcador: true, argv: ['qa-readability', '--story', '{STORY}', '--marks', '0'] },
  { id: 'followups-status', argv: ['followups-status', '--story', '{STORY}'] },
  { id: 'mech-check', argv: ['mech-check', '--repo', '{REPO}', '--story', '{STORY}', '--files', 'src/a.js'] },
  { id: 'desconocido', argv: ['cualquiera'] },
  { id: 'sin-comando', argv: [] },
].map((c) => ({ ...c, id: `pipeline-${c.id}`, guion: 'pipeline.js' }));

const reemplazar =(s, m) => String(s).replace(/\{REPO\}/g, m.repo).replace(/\{STORY\}/g, m.story).replace(/\{HOME\}/g, m.home);

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
  // de la ruta más larga a la más corta: el árbol armado de la noche vive dentro de la carpeta temporal, y reemplazar
  // antes la carpeta temporal dejaba la ruta del arnés como <RAIZ>/…
  const rutas = [[m.raiz, '<RAIZ>'], [fs.realpathSync(os.tmpdir()), '<RAIZ>'], [os.tmpdir(), '<RAIZ>'], [SCRIPTS, '<GUIONES>'],
    // la raíz del arnés (sus scripts/lib, sus guías): la carpeta de la máquina no es comportamiento, ni se publica
    [path.resolve(SCRIPTS, '..', '..', '..'), '<ARNES>'], [os.homedir(), '<CASA>'], [PAQUETES_VACIOS, '<ARNES>/packs']];
  for (const [r, marca] of rutas.sort((a, b) => b[0].length - a[0].length)) t = t.split(r).join(marca);
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
    // la huella de la muestra de un pedido de firma lleva la hora en que se anotó
    .replace(/\bMuestra [0-9a-f]{8}\b/g, 'Muestra <SELLO>')
    .replace(/"huella":"[0-9a-f]{8}"/g, '"huella":"<SELLO>"')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '<HORA>')
    .replace(/\b\d+(?:[.,]\d+)?\s?(ms|s|min)\b/g, '<N> $1')
    .replace(/"(pid|ppid|durationMs|duration_ms|ms)":\s?\d+/g, '"$1":<N>');
}

/**
 * Corre un caso contra `scripts` (la carpeta con marker.js y pipeline.js): `{ status, stdout, stderr, archivos }`,
 * normalizado. El guion del caso es `caso.guion` (de fábrica, marker.js); el marcador lo arma siempre marker.js.
 */
function correr(caso, scripts = SCRIPTS) {
  const m = armar(caso);
  const marker = path.join(scripts, 'marker.js');
  const guion = path.join(scripts, caso.guion || 'marker.js');
  if (caso.marcador) {
    const r = spawnSync(process.execPath, [marker, 'set', JSON.stringify({ storyId: '9.1', storyPath: m.story, repoPath: m.repo })],
      { cwd: m.repo, env: m.env, encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0) throw new Error(`no pude armar el marcador del caso ${caso.id}: ${r.stderr}`);
  }
  const antes = archivos(m);
  const env = { ...m.env };
  if (caso.sinSesion) { delete env.CLAUDE_CODE_SESSION_ID; delete env.TYCON_SESSION_ID; }
  // pipeline.js mira las herramientas de la máquina (engram en el PATH) y la raíz de los repos: la foto no puede depender
  // de la máquina que la graba ni de la que la corre
  if (caso.guion === 'pipeline.js') {
    if (process.platform !== 'win32') env.PATH = [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter);
    env.TYCON_REPOS_ROOT = m.raiz;
  }
  const r = spawnSync(process.execPath, [guion, ...caso.argv.map((a) => reemplazar(a, m))],
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
// Por qué una firma no pasó por la ventana depende del árbol de procesos de donde corre la prueba (un encierro sin
// permiso para listar procesos, o una consola que no es la de la herramienta), no del subcomando: se compara sin él, de
// los dos lados (la foto lo trae escrito)
const sinArbolDeProcesos = (texto) => String(texto).replace(/no pasó por la ventana: (?:el guion no lo lanzó la consola de la herramienta|no pude leer los procesos de la máquina)\./g, 'no pasó por la ventana: <ARBOL DE PROCESOS>.');

function diferencia(antes, despues) {
  if (antes.status !== despues.status) return `código de salida: antes ${antes.status}, después ${despues.status}`;
  if ((antes.signal || null) !== (despues.signal || null)) return `señal: antes ${antes.signal}, después ${despues.signal}`;
  for (const campo of ['stdout', 'stderr']) {
    const [ta, td] = [sinArbolDeProcesos(antes[campo]), sinArbolDeProcesos(despues[campo])];
    if (ta === td) continue;
    const a = ta.split('\n');
    const d = td.split('\n');
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
// el texto del freno de escrituras: el despachador y sus partes (lib/bash-gate-*.js)
const textoDelFreno = () => require(path.join(RAIZ_ARNES, 'scripts', 'ci', 'control-size.js')).textoDelFreno(path.join(SCRIPTS, 'on-bash-write-gate.js'));
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
  for (const m of texto.matchAll(/require\(\s*path\.join\(\s*(__dirname|SCRIPTS_DIR)\s*,\s*('[^']*'(?:\s*,\s*'[^']*')*)\s*(?:,\s*)?\)\s*\)/g)) {
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

/** La foto de pipeline.js: sus casos (dos veces, como la de marker.js), sus `require` y sus exportaciones. */
function grabarPipeline() {
  const foto = { nota: 'salida de cada caso con el pipeline.js sin partir; grabada con SPLIT_CONTRACT_RECORD=pipeline', casos: {} };
  const inestables = [];
  for (const caso of CASOS_PIPELINE) {
    const a = correr(caso);
    const b = correr(caso);
    const d = diferencia(a, b);
    if (d) inestables.push(`${caso.id}: ${d}`);
    foto.casos[caso.id] = a;
  }
  if (inestables.length) throw new Error(`casos inestables entre dos corridas (arreglá la normalización antes de grabar):\n${inestables.join('\n')}`);
  foto.requires = requiresLocales(path.join(SCRIPTS, 'pipeline.js'));
  foto.exports = clavesDePipeline();
  fs.mkdirSync(path.dirname(FOTO_PIPELINE), { recursive: true });
  fs.writeFileSync(FOTO_PIPELINE, JSON.stringify(foto, null, 2) + '\n');
  return foto;
}

/** Los subcomandos del despacho de pipeline.js, leídos de sus `if (cmd === '…')`. */
const subcomandosDePipeline = (scriptsDir = SCRIPTS) => [...new Set([...fs.readFileSync(path.join(scriptsDir, 'pipeline.js'), 'utf8')
  .matchAll(/\bcmd === '([\w-]+)'/g)].map((x) => x[1]))];

if (GRABAR_PIPELINE) {
  test('grabar la foto de pipeline.js', () => { grabarPipeline(); });
} else if (!GRABAR) {
  test('T6 Pipeline_SameOutputsBeforeAndAfter @story-8.163 @ac-6', () => {
    assert.ok(fs.existsSync(FOTO_PIPELINE), `falta la foto de antes: ${FOTO_PIPELINE}`);
    const foto = JSON.parse(fs.readFileSync(FOTO_PIPELINE, 'utf8'));
    const faltan = CASOS_PIPELINE.filter((c) => !foto.casos[c.id]).map((c) => c.id);
    assert.deepStrictEqual(faltan, [], `casos sin foto de antes: ${faltan.join(', ')}`);
    const distintos = [];
    for (const caso of CASOS_PIPELINE) {
      const d = diferencia(foto.casos[caso.id], correr(caso));
      if (d) distintos.push(`${caso.argv[0] || '(sin comando)'} · caso ${caso.id} · ${d}`);
    }
    assert.deepStrictEqual(distintos, [], `salidas que cambiaron al partir:\n${distintos.join('\n')}`);
  });

  test('T6b cada subcomando de pipeline.js tiene al menos un caso @story-8.163 @ac-6', () => {
    const subcomandos = subcomandosDePipeline();
    assert.ok(subcomandos.length >= 43, `esperaba los 43 subcomandos del despacho, encontré ${subcomandos.length}`);
    const conCaso = new Set(CASOS_PIPELINE.map((c) => c.argv[0]));
    const sin = subcomandos.filter((s) => !conCaso.has(s));
    assert.deepStrictEqual(sin, [], `subcomandos sin caso: ${sin.join(', ')}`);
  });
}

if (GRABAR) {
  test('grabar la foto de antes', () => { grabar(); });
} else if (!GRABAR_PIPELINE) {
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
    assert.ok(subcomandos.length >= 66, `esperaba los 66 subcomandos del despacho, encontré ${subcomandos.length}`);
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

// ── la partición ─────────────────────────────────────────────────────────────────────────────────────────────────────

const TOPE_LETRAS = 90000;
/** Los módulos del plan, con un caso de la foto que corre uno de sus subcomandos (el compartido no tiene). */
const MODULOS = {
  'marker-shared.js': null,
  'marker-lifecycle.js': 'get',
  'marker-sessions.js': 'list-all',
  'marker-steps.js': 'start-step',
  'marker-complete-step.js': 'complete-step-sin-paso',
  'marker-checks.js': 'set-check-manual',
  'marker-adversarial.js': 'mark-adversarial-launched',
  'marker-signatures.js': 'approve-pending-sin-args',
  'marker-adhoc.js': 'adhoc-get',
};
const letras = (archivo) => [...fs.readFileSync(archivo, 'utf8')].length;

test('T4 Marker_UnderLimit_OneJobPerModule @story-8.163 @ac-4', () => {
  assert.ok(letras(path.join(SCRIPTS, 'marker.js')) < TOPE_LETRAS, `marker.js tiene ${letras(path.join(SCRIPTS, 'marker.js'))} letras: el tope es ${TOPE_LETRAS}`);
  assert.deepStrictEqual(modulosDeLaParticion(), Object.keys(MODULOS).sort(), 'los módulos de la partición son los del plan');
  for (const m of Object.keys(MODULOS)) {
    const archivo = path.join(LIB, m);
    const texto = fs.readFileSync(archivo, 'utf8');
    assert.match(texto.split('\n').slice(0, 30).join('\n'), /Responsabilidad: \S/, `${m}: su cabecera dice su responsabilidad`);
    // la ubicación del archivo cambió: lo que dependía de ella va por las rutas que fija el despachador
    const sinComentarios = texto.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    if (m !== 'marker-shared.js') assert.doesNotMatch(sinComentarios, /\b__filename\b|\b__dirname\b/, `${m}: usa MARKER_JS y SCRIPTS_DIR, no su propia ubicación`);
    // el estado que cambia mientras corre se lee del objeto compartido, nunca de una copia
    const copia = sinComentarios.split('\n').find((l) => /\b(?:let|const|var)\s+(?:SID|SOLO_LECTURA|NECESITA_MARCADOR)\b/.test(l)
      || /\b(?:let|const|var)\s*\{[^}\n]*(?<![.\w])(?:SID|SOLO_LECTURA|NECESITA_MARCADOR)\b[^}\n]*\}\s*=/.test(l));
    assert.strictEqual(copia, undefined, `${m}: no copia SID, SOLO_LECTURA ni NECESITA_MARCADOR (${copia})`);
    for (const r of requiresLocales(archivo)) assert.ok(fs.existsSync(path.join(RAIZ_ARNES, r)), `${m}: carga ${r}, que no existe`);
  }
  // cada parte la lee entera el freno de guiones (por debajo de su tope por archivo)
  const freno = textoDelFreno();
  const tope = Number((/const GUION_TOPE = (\d+) \* 1024;/.exec(freno) || [])[1]) * 1024;
  assert.ok(tope > 0, 'el tope por archivo del freno se lee de su texto');
  for (const m of ['../marker.js', ...Object.keys(MODULOS)]) {
    const bytes = fs.statSync(path.join(LIB, m)).size;
    assert.ok(bytes < tope, `${m} pesa ${bytes} bytes y el freno lee enteros hasta ${tope}`);
  }
});

for (const [modulo, caso] of Object.entries(MODULOS)) {
  test(`T4 Modulo_${modulo.replace(/\.js$/, '')}_CargaYCorre @story-8.163 @ac-4`, () => {
    const archivo = path.join(LIB, modulo);
    assert.ok(fs.existsSync(archivo), `falta ${modulo}`);
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'split-modulo-')));
    if (caso === null) {
      // el compartido: el estado que cambia mientras corre y las dos rutas que fija el despachador
      const r = spawnSync(process.execPath, ['-e', `const s = require(${JSON.stringify(archivo)}); process.stdout.write(JSON.stringify({ sid: s.estado.SID, solo: s.estado.SOLO_LECTURA, necesita: s.estado.NECESITA_MARCADOR, scripts: s.SCRIPTS_DIR, marker: s.MARKER_JS }))`],
        { encoding: 'utf8', env: entorno(home), timeout: 30000 });
      assert.strictEqual(r.status, 0, r.stderr);
      assert.deepStrictEqual(JSON.parse(r.stdout), { sid: SID, solo: false, necesita: false, scripts: SCRIPTS, marker: path.join(SCRIPTS, 'marker.js') });
      return;
    }
    const carga = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(archivo)})`], { encoding: 'utf8', env: entorno(home), timeout: 30000 });
    assert.strictEqual(carga.status, 0, `${modulo} no carga: ${carga.stderr}`);
    const foto = JSON.parse(fs.readFileSync(FOTO, 'utf8'));
    const c = CASOS.find((x) => x.id === caso);
    assert.strictEqual(diferencia(foto.casos[caso], correr(c)), null, `${modulo}: su subcomando (${c.argv.join(' ')}) cambió`);
  });
}

test('T10 Split_MissingModule_FailsLoud @story-8.163 @ac-10', () => {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'split-falta-')));
  const copia = path.join(raiz, 'scripts');
  fs.cpSync(SCRIPTS, copia, { recursive: true, filter: (s) => !/[\\/]tests([\\/]|$)/.test(s.slice(SCRIPTS.length)) });
  const falta = path.join(copia, 'lib', 'marker-adhoc.js');
  assert.ok(fs.existsSync(falta), 'la copia tiene el módulo de los carriles');
  fs.rmSync(falta);
  const home = path.join(raiz, 'home');
  fs.mkdirSync(home);
  const r = spawnSync(process.execPath, [path.join(copia, 'marker.js'), 'adhoc', 'get'], { encoding: 'utf8', env: entorno(home), timeout: 30000 });
  assert.notStrictEqual(r.status, 0, 'sin su módulo, el subcomando no sigue como si nada');
  const lineas = r.stderr.split('\n').filter((l) => l.trim());
  assert.strictEqual(lineas.length, 1, `una sola línea con el motivo:\n${r.stderr}`);
  assert.match(lineas[0], /lib\/marker-adhoc\.js/, 'nombra el módulo que falta');
  const otro = spawnSync(process.execPath, [path.join(copia, 'marker.js'), 'get'], { encoding: 'utf8', env: entorno(home), timeout: 30000 });
  assert.strictEqual(otro.status, 0, `un subcomando de otro módulo sigue andando: ${otro.stderr}`);
  // el compartido lo carga el despachador al arrancar: sin él tampoco sale el error largo de Node
  fs.rmSync(path.join(copia, 'lib', 'marker-shared.js'));
  const sinCompartido = spawnSync(process.execPath, [path.join(copia, 'marker.js'), 'get'], { encoding: 'utf8', env: entorno(home), timeout: 30000 });
  assert.strictEqual(sinCompartido.status, 2, `sin el módulo compartido sale 2:\n${sinCompartido.stderr}`);
  const renglones = sinCompartido.stderr.split('\n').filter((l) => l.trim());
  assert.strictEqual(renglones.length, 1, `una sola línea con el motivo:\n${sinCompartido.stderr}`);
  assert.match(renglones[0], /lib\/marker-shared\.js/, 'nombra el módulo compartido');
});

test('T15 Exports_SameKeysBeforeAndAfter @story-8.163 @ac-15', () => {
  const foto = JSON.parse(fs.readFileSync(FOTO, 'utf8'));
  assert.ok(foto.exports, 'la foto de antes trae las exportaciones');
  assert.deepStrictEqual(clavesDeMarker(), foto.exports.marker, 'marker.js exporta lo mismo');
  assert.deepStrictEqual(clavesDePipeline(), foto.exports.pipeline, 'pipeline.js exporta lo mismo');
});

/** Lo que el despachador y sus módulos cargan y no cargaba marker.js antes de partir, y no es sensible. */
function nuevosNoSensibles(antes, archivos, scriptsDir = SCRIPTS) {
  const { esSensible } = require(path.join(LIB, 'save-ok.js'));
  const ahora = new Set(archivos.flatMap((a) => requiresLocales(a, scriptsDir)));
  return [...ahora].filter((r) => !antes.includes(r) && !esSensible(r)).sort();
}

test('T16 Split_ModulesAreSensitive @story-8.163 @ac-16', () => {
  const { esSensible } = require(path.join(LIB, 'save-ok.js'));
  const foto = JSON.parse(fs.readFileSync(FOTO, 'utf8'));
  assert.ok(Array.isArray(foto.requires) && foto.requires.length > 40, 'la foto de antes trae los require de marker.js');
  const archivos = [path.join(SCRIPTS, 'marker.js'), ...modulosDeLaParticion().map((m) => path.join(LIB, m))];
  assert.deepStrictEqual(nuevosNoSensibles(foto.requires, archivos), [], 'todo lo nuevo que carga el despachador es sensible');
  assert.ok(modulosDeLaParticion().length > 0, 'hay módulos de la partición');
  for (const m of modulosDeLaParticion()) assert.ok(esSensible(`skills/tycon-pipeline/scripts/lib/${m}`), `${m} es sensible`);
  // lo que salga de pipeline.js y del freno de guiones también nace sensible
  for (const m of ['pipeline-pasos.js', 'bash-gate-guiones.js']) assert.ok(esSensible(`skills/tycon-pipeline/scripts/lib/${m}`), `lib/${m} es sensible`);
  // un módulo de juguete nuevo, fuera del patrón y de la lista de antes, hace fallar la medida; uno viejo no cuenta
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'split-sensible-'));
  const juguete = path.join(raiz, 'skills', 'tycon-pipeline', 'scripts', 'marker.js');
  fs.mkdirSync(path.dirname(juguete), { recursive: true });
  fs.writeFileSync(juguete, "require('./lib/x.js');\nrequire('./lib/steps.js');\n");
  assert.deepStrictEqual(nuevosNoSensibles(foto.requires, [juguete], path.dirname(juguete)), ['skills/tycon-pipeline/scripts/lib/x.js'],
    'el juguete nuevo falla; lib/steps.js, que ya estaba, no');
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

test('T5 BashGate_ReadsMarkerWhole @story-8.163 @ac-5', () => {
  // una copia de trabajo, fuera de lo instalado y de cualquier repo: la instalada y la de main son exentas
  const r = repoDelFreno();
  const copia = path.join(r.raiz, 'scripts');
  fs.cpSync(SCRIPTS, copia, { recursive: true, filter: (s) => !/[\\/]tests([\\/]|$)/.test(s.slice(SCRIPTS.length)) });
  // sin una historia entre los argumentos: esa frena por su cuenta (cuenta como escrita) y taparía lo que se mide acá
  const bloque = frenar(r, `node ${path.join(copia, 'marker.js')} get`);
  const nombrado = bloque.startsWith(FRENO_ENTERO) ? bloque.split('\n')[2].trim() : null;
  assert.notStrictEqual(nombrado, path.join(copia, 'marker.js'), 'marker.js se lee entero');
  assert.ok(!nombrado || !/[\\/]lib[\\/]marker-[^\\/]+\.js$/.test(nombrado), `un módulo de la partición se lee entero (${nombrado})`);
  // con el freno y pipeline.js partidos, todo lo que marker.js carga se lee entero
  assert.strictEqual(nombrado, null, `nada queda sin leer entero (${nombrado})`);
});

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
  const freno = textoDelFreno();
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

// ── lo publicado ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('T13 Install_CopiesNewModules @story-8.163 @ac-13', () => {
  // en el repo público, lo que se publica es lo versionado: una instalación nueva lo copia tal cual
  const ls = spawnSync('git', ['-C', RAIZ_ARNES, 'ls-files', '-z', '--', 'skills', 'scripts', 'version.json'], { encoding: 'utf8', maxBuffer: 256 << 20 });
  assert.strictEqual(ls.status, 0, `no pude listar lo versionado: ${ls.stderr}`);
  const versionados = ls.stdout.split('\0').filter(Boolean);
  for (const m of Object.keys(MODULOS)) assert.ok(versionados.includes(`skills/tycon-pipeline/scripts/lib/${m}`), `lo publicado lleva lib/${m}`);
  // y las partes de pipeline.js
  const partes = fs.readdirSync(LIB).filter((f) => /^pipeline-.+\.js$/.test(f));
  assert.ok(partes.length > 0, 'hay partes de pipeline.js');
  for (const m of partes) assert.ok(versionados.includes(`skills/tycon-pipeline/scripts/lib/${m}`), `lo publicado lleva lib/${m}`);
  const instalado = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'split-instalado-')));
  for (const f of versionados) {
    const desde = path.join(RAIZ_ARNES, f);
    if (!fs.existsSync(desde)) continue;
    fs.mkdirSync(path.dirname(path.join(instalado, f)), { recursive: true });
    fs.copyFileSync(desde, path.join(instalado, f));
  }
  const scriptsInstalados = path.join(instalado, 'skills', 'tycon-pipeline', 'scripts');
  // `marker.js get` y `pipeline.js next` responden igual desde la copia que desde el árbol
  const responder = (scripts, guion, args) => {
    const caso = { id: `instalado-${guion}`, marcador: true, argv: args };
    const m = armar(caso);
    spawnSync(process.execPath, [path.join(scripts, 'marker.js'), 'set', JSON.stringify({ storyId: '9.1', storyPath: m.story, repoPath: m.repo })], { cwd: m.repo, env: m.env, encoding: 'utf8', timeout: 30000 });
    const r = spawnSync(process.execPath, [path.join(scripts, guion), ...args], { cwd: m.repo, env: m.env, encoding: 'utf8', timeout: 60000 });
    const sacar = (t) => normalizar(String(t || ''), m).split(scripts).join('<GUIONES>').split(path.resolve(scripts, '..', '..', '..')).join('<ARNES>');
    const out = { status: r.status, stdout: sacar(r.stdout), stderr: sacar(r.stderr) };
    fs.rmSync(m.raiz, { recursive: true, force: true });
    return out;
  };
  for (const [guion, args] of [['marker.js', ['get']], ['pipeline.js', ['next']]]) {
    const arbol = responder(SCRIPTS, guion, args);
    const copia = responder(scriptsInstalados, guion, args);
    assert.deepStrictEqual(copia, arbol, `${guion} ${args.join(' ')} responde igual desde lo instalado`);
  }
});

module.exports = { CASOS, correr, diferencia, normalizar, armar, entorno, requiresLocales, SID };
// ── la partición de pipeline.js ──────────────────────────────────────────────────────────────────────────────────────

/** Las partes de pipeline.js que hay hoy: `lib/pipeline-*.js`. */
const partesDePipeline = (lib = LIB) => {
  try { return fs.readdirSync(lib).filter((f) => /^pipeline-.+\.js$/.test(f)).sort(); } catch { return []; }
};
/**
 * Las partes del plan, con un caso de la foto que las corre (las bibliotecas, por el subcomando que las usa; el
 * compartido no tiene).
 */
const PARTES_PIPELINE = {
  'pipeline-shared.js': null,
  'pipeline-reviewers.js': 'pipeline-validators',
  'pipeline-rounds.js': 'pipeline-smart-reloop-sin-foto',
  'pipeline-deep-review.js': 'pipeline-deep-review-gate',
  'pipeline-lane.js': 'pipeline-advisors-carril-sin-carril',
  'pipeline-start.js': 'pipeline-tooling-expected',
  'pipeline-next.js': 'pipeline-next',
  'pipeline-preflight.js': 'pipeline-preflight-frontmatter',
  'pipeline-findings.js': 'pipeline-followups-status',
  'pipeline-reports.js': 'pipeline-evidence-dir',
  'pipeline-advisor-set.js': 'pipeline-advisors',
  'pipeline-advisor-context.js': 'pipeline-advisors',
  'pipeline-risk.js': 'pipeline-risk-class',
  'pipeline-models.js': 'pipeline-model-hint',
};

test('T7 Pipeline_UnderLimit_OneJobPerModule @story-8.163 @ac-7', () => {
  const despachador = path.join(SCRIPTS, 'pipeline.js');
  assert.ok(letras(despachador) < TOPE_LETRAS, `pipeline.js tiene ${letras(despachador)} letras: el tope es ${TOPE_LETRAS}`);
  assert.deepStrictEqual(partesDePipeline(), Object.keys(PARTES_PIPELINE).sort(), 'las partes de pipeline.js son las del plan');
  const freno = textoDelFreno();
  const tope = Number((/const GUION_TOPE = (\d+) \* 1024;/.exec(freno) || [])[1]) * 1024;
  assert.ok(tope > 0, 'el tope por archivo del freno se lee de su texto');
  assert.ok(fs.statSync(despachador).size < tope, `pipeline.js pesa ${fs.statSync(despachador).size} bytes y el freno lee enteros hasta ${tope}`);
  for (const m of Object.keys(PARTES_PIPELINE)) {
    const archivo = path.join(LIB, m);
    const texto = fs.readFileSync(archivo, 'utf8');
    assert.ok([...texto].length < TOPE_LETRAS, `${m} tiene ${[...texto].length} letras: el tope es ${TOPE_LETRAS}`);
    assert.ok(fs.statSync(archivo).size < tope, `${m} pesa ${fs.statSync(archivo).size} bytes y el freno lee enteros hasta ${tope}`);
    assert.match(texto.split('\n').slice(0, 30).join('\n'), /Responsabilidad: \S/, `${m}: su cabecera dice su responsabilidad`);
    const sinComentarios = texto.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    if (m !== 'pipeline-shared.js') assert.doesNotMatch(sinComentarios, /\b__filename\b|\b__dirname\b/, `${m}: usa PIPELINE_JS y SCRIPTS_DIR, no su propia ubicación`);
    // lo que cambia mientras corre se lee del objeto compartido, nunca de una copia
    const copia = sinComentarios.split('\n').find((l) => /\b(?:let|const|var)\s+(?:avisosDelPorton|paraOtra)\b/.test(l)
      || /\b(?:let|const|var)\s*\{[^}\n]*(?<![.\w])(?:avisosDelPorton|paraOtra)\b[^}\n]*\}\s*=/.test(l));
    assert.strictEqual(copia, undefined, `${m}: no copia avisosDelPorton ni paraOtra (${copia})`);
    // lo que la partición suma tiene que existir; lo que ya estaba en la foto queda como estaba (una `SCRIPTS_DIR`
    // local que apunta a scripts/ del arnés se lee acá como la carpeta de los guiones, antes y después)
    const antes = new Set(JSON.parse(fs.readFileSync(FOTO_PIPELINE, 'utf8')).requires);
    for (const r of requiresLocales(archivo)) if (!antes.has(r)) assert.ok(fs.existsSync(path.join(RAIZ_ARNES, r)), `${m}: carga ${r}, que no existe`);
  }
});

for (const [parte, caso] of Object.entries(PARTES_PIPELINE)) {
  test(`T7 Parte_${parte.replace(/\.js$/, '')}_CargaYCorre @story-8.163 @ac-7`, () => {
    const archivo = path.join(LIB, parte);
    assert.ok(fs.existsSync(archivo), `falta ${parte}`);
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'split-parte-')));
    if (caso === null) {
      // el compartido: lo que cambia mientras corre, con su valor de arranque, y las dos rutas que fija el despachador
      const r = spawnSync(process.execPath, ['-e', `const s = require(${JSON.stringify(archivo)}); process.stdout.write(JSON.stringify({ avisos: s.estadoPipeline.avisosDelPorton, otra: s.estadoPipeline.paraOtra, scripts: s.estadoPipeline.SCRIPTS_DIR, pipeline: s.estadoPipeline.PIPELINE_JS }))`],
        { encoding: 'utf8', env: entorno(home), timeout: 30000 });
      assert.strictEqual(r.status, 0, r.stderr);
      assert.deepStrictEqual(JSON.parse(r.stdout), { avisos: [], otra: null, scripts: SCRIPTS, pipeline: path.join(SCRIPTS, 'pipeline.js') });
      return;
    }
    const carga = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(archivo)})`], { encoding: 'utf8', env: entorno(home), timeout: 30000 });
    assert.strictEqual(carga.status, 0, `${parte} no carga: ${carga.stderr}`);
    const foto = JSON.parse(fs.readFileSync(FOTO_PIPELINE, 'utf8'));
    const c = CASOS_PIPELINE.find((x) => x.id === caso);
    assert.strictEqual(diferencia(foto.casos[caso], correr(c)), null, `${parte}: su subcomando (${c.argv.join(' ')}) cambió`);
  });
}

test('T10 Pipeline_MissingModule_FailsLoud @story-8.163 @ac-10', () => {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'split-falta-p-')));
  const copia = path.join(raiz, 'scripts');
  fs.cpSync(SCRIPTS, copia, { recursive: true, filter: (s) => !/[\\/]tests([\\/]|$)/.test(s.slice(SCRIPTS.length)) });
  const falta = path.join(copia, 'lib', 'pipeline-reports.js');
  assert.ok(fs.existsSync(falta), 'la copia tiene la parte de los informes');
  fs.rmSync(falta);
  const home = path.join(raiz, 'home');
  fs.mkdirSync(home);
  const r = spawnSync(process.execPath, [path.join(copia, 'pipeline.js'), 'evidence-key', '--story', path.join(raiz, 'x.md')], { encoding: 'utf8', env: entorno(home), timeout: 30000 });
  assert.notStrictEqual(r.status, 0, 'sin su parte, el subcomando no sigue como si nada');
  const lineas = r.stderr.split('\n').filter((l) => l.trim());
  assert.strictEqual(lineas.length, 1, `una sola línea con el motivo:\n${r.stderr}`);
  assert.match(lineas[0], /lib\/pipeline-reports\.js/, 'nombra la parte que falta');
  const otro = spawnSync(process.execPath, [path.join(copia, 'pipeline.js'), 'lint-config', '--repo', raiz], { encoding: 'utf8', env: entorno(home), timeout: 30000 });
  assert.strictEqual(otro.status, 0, `un subcomando de otra parte sigue andando: ${otro.stderr}`);
  // el compartido lo carga el despachador al arrancar: sin él tampoco sale el error largo de Node
  fs.rmSync(path.join(copia, 'lib', 'pipeline-shared.js'));
  const sinCompartido = spawnSync(process.execPath, [path.join(copia, 'pipeline.js'), 'lint-config', '--repo', raiz], { encoding: 'utf8', env: entorno(home), timeout: 30000 });
  assert.strictEqual(sinCompartido.status, 2, `sin el compartido sale 2:\n${sinCompartido.stderr}`);
  const renglones = sinCompartido.stderr.split('\n').filter((l) => l.trim());
  assert.strictEqual(renglones.length, 1, `una sola línea con el motivo:\n${sinCompartido.stderr}`);
  assert.match(renglones[0], /lib\/pipeline-shared\.js/, 'nombra el compartido');
});

test('T15 Pipeline_SameExportsAsThePhoto @story-8.163 @ac-15', () => {
  const foto = JSON.parse(fs.readFileSync(FOTO_PIPELINE, 'utf8'));
  assert.ok(Array.isArray(foto.exports) && foto.exports.length > 70, 'la foto de pipeline.js trae sus exportaciones');
  assert.deepStrictEqual(clavesDePipeline(), foto.exports, 'pipeline.js exporta las mismas claves');
  // cada clave trae lo mismo que traía: una función sigue siendo función y un valor sigue siendo del mismo tipo
  const r = spawnSync(process.execPath, ['-e', `const p = require(${JSON.stringify(path.join(SCRIPTS, 'pipeline.js'))}); process.stdout.write(JSON.stringify(Object.keys(p).filter((k) => p[k] === undefined)))`],
    { encoding: 'utf8', env: entorno(fs.mkdtempSync(path.join(os.tmpdir(), 'split-claves-'))), timeout: 30000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), [], 'ninguna exportación quedó vacía');
});

test('T16 Pipeline_ModulesAreSensitive @story-8.163 @ac-16', () => {
  const { esSensible } = require(path.join(LIB, 'save-ok.js'));
  const foto = JSON.parse(fs.readFileSync(FOTO_PIPELINE, 'utf8'));
  assert.ok(Array.isArray(foto.requires) && foto.requires.length > 40, 'la foto de pipeline.js trae sus require');
  const archivos = [path.join(SCRIPTS, 'pipeline.js'), ...partesDePipeline().map((m) => path.join(LIB, m))];
  assert.deepStrictEqual(nuevosNoSensibles(foto.requires, archivos), [], 'todo lo nuevo que cargan pipeline.js y sus partes es sensible');
  assert.ok(partesDePipeline().length > 0, 'hay partes de pipeline.js');
  for (const m of partesDePipeline()) assert.ok(esSensible(`skills/tycon-pipeline/scripts/lib/${m}`), `${m} es sensible`);
});

test('T7 BashGate_ReadsPipelineWhole @story-8.163 @ac-7', () => {
  const r = repoDelFreno();
  const copia = path.join(r.raiz, 'scripts');
  fs.cpSync(SCRIPTS, copia, { recursive: true, filter: (s) => !/[\\/]tests([\\/]|$)/.test(s.slice(SCRIPTS.length)) });
  const bloque = frenar(r, `node ${path.join(copia, 'pipeline.js')} next`);
  const nombrado = bloque.startsWith(FRENO_ENTERO) ? bloque.split('\n')[2].trim() : null;
  assert.notStrictEqual(nombrado, path.join(copia, 'pipeline.js'), 'pipeline.js se lee entero');
  assert.ok(!nombrado || !/[\\/]lib[\\/]pipeline-[^\\/]+\.js$/.test(nombrado), `una parte de pipeline.js se lee entera (${nombrado})`);
});
