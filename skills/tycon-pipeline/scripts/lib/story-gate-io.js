/**
 * story-gate-io.js — la capa con I/O del portón de carril (ver `story-gate.js` para la lógica pura y
 * el porqué). La comparten el handler de Edit|Write (`on-story-gate.js`) y el guard de Bash
 * (`on-bash-write-gate.js`): UN solo cálculo para las dos puertas.
 *
 *   evaluate({ filePath, sessionId, cwd, via }) → { verdict, message|null, ctx }
 *
 * Fuentes de estado (todas bajo ~/.claude/.tycon-pipeline/):
 *   active/<sid>.json   marker del pipeline (lo escribe marker.js)
 *   adhoc/<sid>.json    carril ad-hoc de la sesión: { reason, maxFiles, files[], declaredAt, lastTouch, via, by,
 *                       firmadaEn } (lo escribe `marker.js adhoc set` con la firma del dueño; el portón lo acepta sólo
 *                       con el renglón `adhoc-lane-signed` de esa hora en gates.log)
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
const { stateDir: stateDirOf } = require('./state-dir.js');   // La carpeta del estado, de una sola pieza
const { execFileSync } = require('child_process');

const gate = require('./story-gate.js');
const installedTree = require('./installed-tree.js');   // el árbol instalado del arnés
const { isInside } = require('./atdd-preedit.js');

const DEFAULT_STATE_DIR = path.join(stateDirOf(os.homedir()));

// Las raíces del árbol instalado se guardan una vez encontradas (el despachador corre in-process). Una respuesta vacía
// no se guarda: si la instalación aparece después, la próxima escritura ya la ve.
let installedRootsMemo = null;
function defaultInstalledRoots() {
  if (installedRootsMemo) return installedRootsMemo;
  const r = installedTree.roots({ home: os.homedir() });
  if (r.length) installedRootsMemo = r;
  return r;
}
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

// La declaración del arreglo rápido abre el portón sólo con su firma: el renglón `adhoc-lane-signed` que deja
// `marker.js adhoc set` en gates.log para esta sesión, de la hora que la declaración anota (`firmadaEn`). Un archivo
// escrito por otra vía no la trae. Se lee la cola del registro: una firma de las últimas horas está ahí.
const FIRMA_ADHOC_MARGEN_MS = 2 * 60 * 1000;
const GATES_COLA_BYTES = 4 * 1024 * 1024;

function adhocFirmado(stateDir, sessionId, adhoc) {
  return firmaDelAdhoc(stateDir, sessionId, adhoc).ok ? adhoc : null;
}

/** `{ ok: true }`, o `{ ok: false, motivo }` con lo que le falta a la declaración para abrir el portón. */
function firmaDelAdhoc(stateDir, sessionId, adhoc) {
  if (!adhoc) return { ok: false, motivo: null };
  const hasta = Date.parse(adhoc.firmadaEn || '');
  if (Number.isNaN(hasta)) return { ok: false, motivo: 'no trae la hora de su firma (no la escribió `marker.js adhoc set`)' };
  let txt;
  try {
    const file = path.join(stateDir, 'gates.log');
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const n = Math.min(size, GATES_COLA_BYTES);
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, size - n);
      txt = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (e) { return { ok: false, motivo: `no pude leer el registro de firmas (${e.code || e.message})` }; }
  const sid = String(sessionId);
  for (const linea of txt.split('\n')) {
    if (!linea.includes('adhoc-lane-signed')) continue;
    let o;
    try { o = JSON.parse(linea); } catch { continue; }
    if (o.name !== 'adhoc-lane-signed' || o.status !== 'ok' || String(o.destino) !== sid) continue;
    const t = Date.parse(o.ts || '');
    if (!Number.isNaN(t) && t <= hasta && t >= hasta - FIRMA_ADHOC_MARGEN_MS) return { ok: true };
  }
  return { ok: false, motivo: 'no está el renglón de su firma (adhoc-lane-signed de esta sesión, a esa hora) en el registro' };
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
    if (Array.isArray(m.stepsPending) && m.stepsPending.length === 0) continue; // pipeline terminado
    if (m.repoPath && filePath && !isInside(m.repoPath, filePath)) continue;
    out.push({ sessionId: m.sessionId || f.replace(/\.json$/, ''), storyId: m.storyId, repoPath: m.repoPath || null });
  }
  return out;
}

// ── ¿repo del harness? lo dice el remoto, no la carpeta ─────────────────────────────────────────
// El criterio es UNO y vive en el arnés (~/.claude/tycon-harness/scripts/lib/harness-repo.js,
// referencia-por-path como dispatch.js: TYCON_GUIDES_DIR · TCG · el enlace ~/.claude/tycon-harness). Sin ese
// lector estaría escrito tres veces —acá, en retro-pending.js y en unpushed-work-notice.js—, las tres por nombre de carpeta.
// Si la lib no está (arnés atrasado en esta máquina) o no carga, decide la carpeta, que es el comportamiento
// por defecto: nunca se rompe un Edit por esto. Pero lo dice por la salida de error, una vez por proceso.
let repoDelArnes; // undefined = sin intentar · null = no está · objeto = la lib
let criterioFallo = false; // ya se dijo que el criterio revienta (se dice una vez por proceso)
function isHarnessRepo(filePath) {
  if (repoDelArnes === undefined) {
    // Dónde está el arnés lo dice UN lector (harness-path.js): la variable o el enlace; sin ninguno, null.
    try {
      const r = require('./harness-path.js').rutaArnesHook();
      if (!r.dir) process.stderr.write(`${r.aviso} — el portón decide por nombre de carpeta mientras tanto\n`);   // un hook lo dice y sigue
      // El criterio se busca por su nombre actual y, con un arnés atrasado, por el nombre anterior (por pedazos:
      // el viejo no se escribe entero). Sin esa segunda búsqueda, una copia sin reemplazos caería al nombre de
      // carpeta sin decirlo.
      const lib = r.dir && ['harness-repo.js', `${['repo', 'del', 'arnes'].join('-')}.js`]
        .map((n) => path.join(r.dir, 'scripts', 'lib', n)).find((p) => fs.existsSync(p));
      // El arnés está y no trae el criterio con ninguno de sus dos nombres: decide la carpeta, y se dice.
      // Sin este aviso, el camino caería callado.
      if (r.dir && !lib) process.stderr.write(`tycon: el arnés de ${r.dir} no trae scripts/lib/harness-repo.js (ni con su nombre de antes) — el portón decide por nombre de carpeta mientras tanto\n`);
      repoDelArnes = lib ? require(lib) : null;
      // carga pero no trae la función: tampoco se cae callado
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
      // el criterio revienta: cae al respaldo y lo dice, una vez por proceso
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
 * `key`: la misma lectura sirve para otros frenos del bloque `pipeline:` —
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
function evaluate({ filePath, sessionId, cwd, via, stateDir = DEFAULT_STATE_DIR, installedRoots }) {
  const abs = path.isAbsolute(String(filePath)) ? String(filePath) : path.resolve(cwd || process.cwd(), String(filePath));
  // Una ejecución abierta a la que le falta una pieza frena antes que nada: ni el carril, ni un ad-hoc, ni
  // `story_gate: false` la apagan (lib/open-runs.js). No poder preguntar no es estar sana: frena con el motivo.
  {
    const or = require('./open-runs.js');
    let p;
    // desde el directorio de trabajo y desde el archivo: con el cwd en la carpeta de arriba, la copia está en el repo del archivo
    try { p = or.perdida({ sid: sessionId, cwd: [cwd || process.cwd(), path.dirname(abs)] }); } catch (e) {
      p = { caso: 'ilegible', falta: `no pude revisar las piezas de la ejecución (${e.message})`, sesion: String(sessionId) };
    }
    if (p) {
      const verdict = { action: 'block', kind: 'ejecucion-perdida', reason: `ejecución perdida (${p.caso}): ${p.falta}` };
      appendLog(stateDir, 'gates.log', sessionId, { name: 'story-gate', status: 'blocked', kind: verdict.kind, file: abs, via: via || null, story: p.story, reason: verdict.reason });
      return { verdict, message: or.cartel(p, { markerJs: path.join(__dirname, '..', 'marker.js') }), ctx: { filePath: abs, perdida: p, via } };
    }
  }
  const roots = Array.isArray(installedRoots) ? installedRoots : defaultInstalledRoots();
  const realFilePath = installedTree.realPath(abs);
  const realStateDir = installedTree.realPath(stateDir);
  const marker = readMarker(stateDir, sessionId);
  const declarado = readAdhoc(stateDir, sessionId);
  const firma = firmaDelAdhoc(stateDir, sessionId, declarado);
  const adhoc = firma.ok ? declarado : null;
  // una declaración sin firma reconocida no abre, y el bloqueo dice por qué (no es lo mismo que no haber declarado)
  const adhocSinFirma = declarado && !firma.ok ? firma.motivo : null;

  // Camino barato primero: state-dir / no-código / marker no necesitan mirar el repo. Se arranca
  // suponiendo que NO es un repo del harness: si así ya pasa, pasa y no se pagó ningún git. Sólo si
  // bloquearía (y no es el state-dir, que bloquea siempre) se lee el remoto — y `isHarness` viaja
  // SIEMPRE como booleano: si no, la lógica pura caería al respaldo por carpeta, que es el agujero.
  const hipotetico = (isHarness) => gate.computeStoryGate({
    filePath: abs, stateDir, homeDir: os.homedir(), repoRoot: '/__unknown__', repoHasTycon: true, repoHasStories: true,
    marker, adhoc, isHarness, realFilePath, installedRoots: roots, realStateDir,
  });
  let pre = hipotetico(false);
  if (pre.action === 'block' && pre.kind !== 'state-dir' && pre.kind !== 'installed-tree' && pre.kind !== 'control-approvals' && isHarnessRepo(abs)) pre = hipotetico(true);
  // Si con un repo "hipotéticamente bajo el arnés" ya pasa, pasa (no-código, harness, marker OK, ad-hoc OK).
  // Si bloquea por state-dir, installed-tree o plan, bloquea sin mirar el repo. Sólo no-lane / adhoc-cap dependen del repo.
  let repo = { repoRoot: null, repoHasTycon: false, repoHasStories: false, discoveryPartial: false };
  let verdict = pre;
  if (pre.action === 'block' && (pre.kind === 'no-lane' || pre.kind === 'adhoc-cap')) {
    repo = repoContext(abs);
    verdict = gate.computeStoryGate({
      filePath: abs, stateDir, homeDir: os.homedir(), ...repo, marker, adhoc, isHarness: false,
      realFilePath, installedRoots: roots, realStateDir,
      gateEnabled: gateEnabledForRepo(repo.repoRoot),
    });
  }

  const ctx = { filePath: abs, marker, adhoc, repo, via };
  if (verdict.action !== 'block') {
    // Pasó porque el repo "no trabaja con el arnés" pero el escaneo fue PARCIAL (sin .tycon/, bajo carga):
    // que no sea silencioso — queda medido en gates.log como `unknown`.
    if (repo.discoveryPartial && !repo.repoHasTycon && !repo.repoHasStories) {
      appendLog(stateDir, 'gates.log', sessionId, { repoPath: repo.repoRoot || null, name: 'story-gate', status: 'unknown', file: abs, via: via || null, reason: 'escaneo de stories parcial (presupuesto agotado) — el repo podría trabajar con stories' });
    }
    return { verdict, message: null, ctx };
  }

  const otherMarkers = verdict.kind === 'no-lane' ? listOtherMarkers(stateDir, sessionId, abs) : [];
  // repoPath: namespace por repo — misma key que marker.js.
  appendLog(stateDir, 'gates.log', sessionId, {
    repoPath: repo.repoRoot || null,
    name: 'story-gate', status: 'blocked', kind: verdict.kind, file: abs, via: via || null,
    story: marker ? marker.storyId : null, reason: verdict.reason, ...(adhocSinFirma ? { adhocSinFirma } : {}),
  });
  let message = gate.blockMessage(verdict, { filePath: abs, repoRoot: repo.repoRoot, marker, otherMarkers, via });
  if (adhocSinFirma && verdict.kind === 'no-lane') {
    message += `\n\n  ⚠️ Hay una declaración del arreglo rápido para esta sesión, pero sin su firma: ${adhocSinFirma}. No abre el\n`
      + '     portón. Si el dueño quiere el arreglo rápido, se vuelve a declarar con `marker.js adhoc set`, que él aprueba en la ventana.';
  }
  return { verdict, message, ctx: { ...ctx, otherMarkers } };
}

module.exports = {
  DEFAULT_STATE_DIR, STALE_HOURS,
  readMarker, readAdhoc, adhocFirmado, writeAdhoc, recordAdhocFile, adhocPath, listOtherMarkers,
  repoContext, gateEnabledForRepo, appendLog, evaluate, isHarnessRepo, defaultInstalledRoots,
};
