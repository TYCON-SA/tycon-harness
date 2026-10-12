/**
 * story-gate-io.js — la capa con I/O del portón de carril (ver `story-gate.js` para la lógica pura y
 * el porqué). La comparten el handler de Edit|Write (`on-story-gate.js`) y el guard de Bash
 * (`on-bash-write-gate.js`): UN solo cálculo para las dos puertas.
 *
 *   evaluate({ filePath, sessionId, cwd, via }) → { verdict, message|null, ctx }
 *
 * Fuentes de estado (todas bajo ~/.claude/.tycon-pipeline/):
 *   active/<sid>.json   marker del pipeline (lo escribe marker.js)
 *   adhoc/<sid>.json    carril ad-hoc de la sesión: { reason, maxFiles, files[], declaredAt, lastTouch }
 *   lane/<sid>.json     carril FIJADO POR EL PROMPT del user (2026-08-24): { lane, laneSetAt, lanePrompt,
 *                       recentPrompts[], lastTouch } — lo escribe on-prompt.js en cada prompt; marker.js
 *                       lo lee para denegar `adhoc set` con carril pipeline y para exigir que el motivo
 *                       sea un fragmento literal de lo que escribió el user.
 *   gates.log           cada bloqueo queda registrado (status: blocked, kind)
 *
 * Señal "repo bajo el arnés": `<repo>/.tycon/` existe (barato, sin escaneo) — o, si no existe,
 * stories Mary+GOLD descubiertas en el repo (`story-discovery`, cache 1h). Kill-switch por repo
 * leído de lo COMMITEADO: `git show HEAD:.tycon/advisors.yaml` → `pipeline.story_gate: false`.
 * Sólo se consulta cuando el veredicto preliminar es bloquear (lazy): el camino feliz no paga git.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { stateDir: stateDirOf } = require('./state-dir.js');   // story 8.23 (A2): la carpeta del estado, de una sola pieza
const { execFileSync } = require('child_process');

const gate = require('./story-gate.js');
const { isInside } = require('./atdd-preedit.js');

const DEFAULT_STATE_DIR = path.join(stateDirOf(os.homedir()));
const STALE_HOURS = 6; // mismo TTL que los markers ajenos en on-prompt.js
const DISCOVERY_BUDGET_MS = Number(process.env.TYCON_STORY_SCAN_BUDGET_MS) || 500;

function safeSid(sessionId) {
  return String(sessionId || '_nosession').replace(/[/\\]/g, '_');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function isStale(obj) {
  const t = obj && (obj.lastTouch || obj.declaredAt);
  if (!t) return false;
  return Date.now() - new Date(t).getTime() > STALE_HOURS * 3600 * 1000;
}

// ── marker / ad-hoc ──────────────────────────────────────────────────────────────────────────────

function markerPath(stateDir, sessionId) {
  return path.join(stateDir, 'active', `${safeSid(sessionId)}.json`);
}
function adhocPath(stateDir, sessionId) {
  return path.join(stateDir, 'adhoc', `${safeSid(sessionId)}.json`);
}

function readMarker(stateDir, sessionId) {
  const m = readJson(markerPath(stateDir, sessionId));
  return m && m.storyId ? m : null;
}

function readAdhoc(stateDir, sessionId) {
  const a = readJson(adhocPath(stateDir, sessionId));
  if (!a || !a.reason) return null;
  if (isStale(a)) return null;
  return a;
}

/** Escritura atómica del ad-hoc (tmp + rename). Devuelve el objeto escrito. */
function writeAdhoc(stateDir, sessionId, obj) {
  const file = adhocPath(stateDir, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return obj;
}

// ── lane (carril fijado por el prompt del user) ──────────────────────────────────────────────────

const LANE_RECENT_PROMPTS = 8;
const LANE_PROMPT_MAX_CHARS = 1500;

function lanePath(stateDir, sessionId) {
  return path.join(stateDir, 'lane', `${safeSid(sessionId)}.json`);
}

function readLane(stateDir, sessionId) {
  const l = readJson(lanePath(stateDir, sessionId));
  if (!l) return null;
  if (isStale(l)) return null;
  return l;
}

/**
 * Registra el prompt del user (ring de los últimos N). Lo llama on-prompt.js en CADA prompt humano.
 * 🔴 Ya NO fija carril (2026-08-27): la detección por regex se borró tras tres incidentes en tres
 * días — ver el comentario grande en story-gate.js. El ring es la evidencia que consumen
 * reasonInPrompts (cita mecánica) y lane-classifier (el modelo que interpreta castellano); sólo
 * lo escribe este hook desde UserPromptSubmit, así que el agente no puede inyectar texto acá.
 */
function recordPrompt(stateDir, sessionId, prompt, { now = new Date().toISOString() } = {}) {
  const text = String(prompt || '').slice(0, LANE_PROMPT_MAX_CHARS);
  const prev = readLane(stateDir, sessionId) || {};
  const recent = Array.isArray(prev.recentPrompts) ? prev.recentPrompts.slice() : [];
  if (text.trim()) recent.push(text);
  const obj = { ...prev, recentPrompts: recent.slice(-LANE_RECENT_PROMPTS), lastTouch: now };
  // Estado viejo: un lane fijado por el regex borrado seguiría anulando ad-hocs para siempre.
  delete obj.lane; delete obj.laneSetAt; delete obj.lanePrompt;
  const file = lanePath(stateDir, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return obj;
}

/** Registra un archivo editado bajo el ad-hoc de la sesión (lo llama on-edit.js en PostToolUse). */
function recordAdhocFile(stateDir, sessionId, filePath) {
  const a = readAdhoc(stateDir, sessionId);
  if (!a) return null;
  const files = Array.isArray(a.files) ? a.files : [];
  if (!files.some((f) => gate.sameFile(f, filePath))) files.push(String(filePath));
  return writeAdhoc(stateDir, sessionId, { ...a, files, lastTouch: new Date().toISOString() });
}

/** Markers activos (no stale) de OTRAS sesiones cuyo repoPath contiene el archivo. */
function listOtherMarkers(stateDir, sessionId, filePath) {
  const dir = path.join(stateDir, 'active');
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f === `${safeSid(sessionId)}.json`) continue;
    const m = readJson(path.join(dir, f));
    if (!m || !m.storyId || isStale(m)) continue;
    if (Array.isArray(m.stepsPending) && m.stepsPending.length === 0) continue; // pipeline terminado (H11)
    if (m.repoPath && filePath && !isInside(m.repoPath, filePath)) continue;
    out.push({ sessionId: m.sessionId || f.replace(/\.json$/, ''), storyId: m.storyId, repoPath: m.repoPath || null });
  }
  return out;
}

// ── ¿repo del harness? lo dice el remoto, no la carpeta ─────────────────────────────────────────
// El criterio es UNO y vive en el arnés (~/.claude/tycon-harness/scripts/lib/harness-repo.js,
// referencia-por-path como dispatch.js: TYCON_GUIDES_DIR · TCG · el enlace ~/.claude/tycon-harness). Estaba escrito
// tres veces —acá, en retro-pending.js y en unpushed-work-notice.js—, las tres por nombre de carpeta.
// Si la lib no está (arnés atrasado en esta máquina) o no carga, decide la carpeta, que es la conducta de
// siempre: nunca se rompe un Edit por esto. Pero lo dice por la salida de error, una vez por proceso.
let repoDelArnes; // undefined = sin intentar · null = no está · objeto = la lib
let criterioFallo = false; // ya se dijo que el criterio revienta (se dice una vez por proceso)
function isHarnessRepo(filePath) {
  if (repoDelArnes === undefined) {
    // Dónde está el arnés lo dice UN lector (harness-path.js, story 8.3): la variable o el enlace; sin ninguno, null.
    try {
      const r = require('./harness-path.js').rutaArnesHook();
      if (!r.dir) process.stderr.write(`${r.aviso} — el portón decide por nombre de carpeta mientras tanto\n`);   // AC 5: un hook lo dice y sigue
      // por su nombre de hoy y, con un arnés un pull atrás, por el de antes de la story 8.9 (por pedazos: el viejo no se
      // escribe entero). Sólo por el viejo, una copia sin reemplazos caía al nombre de carpeta sin decirlo.
      const lib = r.dir && ['harness-repo.js', `${['repo', 'del', 'arnes'].join('-')}.js`]
        .map((n) => path.join(r.dir, 'scripts', 'lib', n)).find((p) => fs.existsSync(p));
      // El arnés está y no trae el criterio con ninguno de sus dos nombres: decide la carpeta, y se dice (AC 67 de la
      // story 8.9; revisión de la tanda G: este camino era el único de la tanda que seguía cayendo callado).
      if (r.dir && !lib) process.stderr.write(`tycon: el arnés de ${r.dir} no trae scripts/lib/harness-repo.js (ni con su nombre de antes) — el portón decide por nombre de carpeta mientras tanto\n`);
      repoDelArnes = lib ? require(lib) : null;
      // carga pero no trae la función: tampoco se cae callado (pase adversarial de la tanda G, causa 7)
      if (repoDelArnes && typeof repoDelArnes.esRutaDelArnes !== 'function') {
        process.stderr.write(`tycon: el criterio del arnés (${lib}) no trae esRutaDelArnes — el portón decide por nombre de carpeta mientras tanto\n`);
        repoDelArnes = null;
      }
    } catch (e) {
      // el criterio está y no carga: tampoco se cae callado
      process.stderr.write(`tycon: no pude cargar el criterio del arnés (${(e && e.code) || (e && e.message) || e}) — el portón decide por nombre de carpeta mientras tanto\n`);
      repoDelArnes = null;
    }
  }
  if (repoDelArnes) {
    try { return !!repoDelArnes.esRutaDelArnes(filePath); } catch (e) {
      // el criterio revienta: cae al respaldo y lo dice, una vez por proceso (pase adversarial de la tanda G, causa 7)
      if (!criterioFallo) {
        criterioFallo = true;
        process.stderr.write(`tycon: el criterio del arnés falló (${(e && e.message) || e}) — el portón decide por nombre de carpeta mientras tanto\n`);
      }
    }
  }
  return gate.isHarnessPath(filePath);
}

// ── repo ─────────────────────────────────────────────────────────────────────────────────────────

function repoContext(filePath) {
  let repoRoot = null;
  try {
    const { findRepoRoot } = require('./story-discovery.js');
    repoRoot = findRepoRoot(path.dirname(String(filePath)));
  } catch { repoRoot = null; }
  if (!repoRoot) return { repoRoot: null, repoHasTycon: false, repoHasStories: false, discoveryPartial: false };

  let repoHasTycon = false;
  try { repoHasTycon = fs.statSync(path.join(repoRoot, '.tycon')).isDirectory(); } catch { repoHasTycon = false; }

  // Sin `.tycon/` recién ahí se paga el descubrimiento (cacheado 1h por repo). Un repo con `.md`
  // que declaran `story:`/`status:` pero ids fuera del patrón (`excluded`) TRABAJA con stories.
  let repoHasStories = false;
  let discoveryPartial = false;
  if (!repoHasTycon) {
    try {
      const { discoverStories } = require('./story-discovery.js');
      const r = discoverStories(repoRoot, { budgetMs: DISCOVERY_BUDGET_MS });
      repoHasStories = (r.stories && r.stories.length > 0) || (r.excluded && r.excluded.length > 0);
      discoveryPartial = !!r.partial;
    } catch { repoHasStories = false; }
  }
  return { repoRoot, repoHasTycon, repoHasStories, discoveryPartial };
}

/**
 * Kill-switch por repo, leído de lo COMMITEADO (HEAD), nunca del working tree: si apagarlo fuera un
 * Write a un yaml, el agente lo apagaría en un turno. Formato:
 *   pipeline:
 *     story_gate: false
 * `key` (2026-08-30): la misma lectura sirve para otros frenos del bloque `pipeline:` —
 * `story_skill_gate` (freno de story-a-mano). Default: el del portón de carril.
 */
function gateEnabledForRepo(repoRoot, key = 'story_gate') {
  if (!repoRoot) return true;
  let yaml = '';
  try {
    yaml = execFileSync('git', ['-C', repoRoot, 'show', 'HEAD:.tycon/advisors.yaml'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
    });
  } catch { return true; }
  const block = yaml.match(/^pipeline:\s*\n((?:[ \t]+.*\n?)*)/m);
  if (!block) return true;
  return !new RegExp(`^[ \\t]+${key}:\\s*false\\b`, 'm').test(block[1]);
}

// ── log ──────────────────────────────────────────────────────────────────────────────────────────

function appendLog(stateDir, fileName, sessionId, obj) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(
      path.join(stateDir, fileName),
      JSON.stringify({ ts: new Date().toISOString(), sessionId, ...obj }) + '\n',
      'utf8',
    );
  } catch { /* logging nunca rompe el gate */ }
}

// ── evaluate ─────────────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} p
 * @param {string} p.filePath   archivo (absoluto o relativo a cwd)
 * @param {string} p.sessionId
 * @param {string} [p.cwd]
 * @param {string} [p.via]      'Edit'|'Write'|'Bash: <cmd recortado>' — sólo para el mensaje/log
 * @param {string} [p.stateDir] override para tests
 * @returns {{ verdict: {action, kind?, reason}, message: string|null, ctx: object }}
 */
function evaluate({ filePath, sessionId, cwd, via, stateDir = DEFAULT_STATE_DIR }) {
  const abs = path.isAbsolute(String(filePath)) ? String(filePath) : path.resolve(cwd || process.cwd(), String(filePath));
  const marker = readMarker(stateDir, sessionId);
  const adhoc = readAdhoc(stateDir, sessionId);

  // Camino barato primero: state-dir / no-código / marker no necesitan mirar el repo. Se arranca
  // suponiendo que NO es un repo del harness: si así ya pasa, pasa y no se pagó ningún git. Sólo si
  // bloquearía (y no es el state-dir, que bloquea siempre) se lee el remoto — y `isHarness` viaja
  // SIEMPRE como booleano: si no, la lógica pura caería al respaldo por carpeta, que es el agujero.
  const hipotetico = (isHarness) => gate.computeStoryGate({
    filePath: abs, stateDir, homeDir: os.homedir(), repoRoot: '/__unknown__', repoHasTycon: true, repoHasStories: true,
    marker, adhoc, isHarness,
  });
  let pre = hipotetico(false);
  if (pre.action === 'block' && pre.kind !== 'state-dir' && isHarnessRepo(abs)) pre = hipotetico(true);
  // Si con un repo "hipotéticamente bajo el arnés" ya pasa, pasa (no-código, harness, marker OK, ad-hoc OK).
  // Si bloquea por state-dir o plan, bloquea sin mirar el repo. Sólo no-lane / adhoc-cap dependen del repo.
  let repo = { repoRoot: null, repoHasTycon: false, repoHasStories: false, discoveryPartial: false };
  let verdict = pre;
  if (pre.action === 'block' && (pre.kind === 'no-lane' || pre.kind === 'adhoc-cap')) {
    repo = repoContext(abs);
    verdict = gate.computeStoryGate({
      filePath: abs, stateDir, homeDir: os.homedir(), ...repo, marker, adhoc, isHarness: false,
      gateEnabled: gateEnabledForRepo(repo.repoRoot),
    });
  }

  const ctx = { filePath: abs, marker, adhoc, repo, via };
  if (verdict.action !== 'block') {
    // Pasó porque el repo "no trabaja con el arnés" pero el escaneo fue PARCIAL (sin .tycon/, bajo carga):
    // que no sea silencioso (H14) — queda medido en gates.log como `unknown`.
    if (repo.discoveryPartial && !repo.repoHasTycon && !repo.repoHasStories) {
      appendLog(stateDir, 'gates.log', sessionId, { repoPath: repo.repoRoot || null, name: 'story-gate', status: 'unknown', file: abs, via: via || null, reason: 'escaneo de stories parcial (presupuesto agotado) — el repo podría trabajar con stories' });
    }
    return { verdict, message: null, ctx };
  }

  const otherMarkers = verdict.kind === 'no-lane' ? listOtherMarkers(stateDir, sessionId, abs) : [];
  // repoPath: namespace por repo (GATESLOG-STORYID-NS-1) — misma key que marker.js.
  appendLog(stateDir, 'gates.log', sessionId, {
    repoPath: repo.repoRoot || null,
    name: 'story-gate', status: 'blocked', kind: verdict.kind, file: abs, via: via || null,
    story: marker ? marker.storyId : null, reason: verdict.reason,
  });
  const message = gate.blockMessage(verdict, { filePath: abs, repoRoot: repo.repoRoot, marker, otherMarkers, via });
  return { verdict, message, ctx: { ...ctx, otherMarkers } };
}

module.exports = {
  DEFAULT_STATE_DIR, STALE_HOURS, LANE_RECENT_PROMPTS,
  readMarker, readAdhoc, writeAdhoc, recordAdhocFile, adhocPath, listOtherMarkers,
  lanePath, readLane, recordPrompt,
  repoContext, gateEnabledForRepo, appendLog, evaluate, isHarnessRepo,
};
