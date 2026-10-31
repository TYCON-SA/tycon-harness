#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('../lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/** `v`, o `d` si `v` es null o undefined (sin `??`: este guion lo tiene que poder leer un Node viejo). */
function nn(v, d) { return v === undefined || v === null ? d : v; }
/*
 * work-in-progress.js — el trabajo en curso de esta máquina, en una tabla (el comando /wip).
 *
 * Una fila por trabajo en curso: cada marcador del pipeline y cada declaración ad-hoc. Cuatro columnas: el trabajo
 * (story y título corto), el estado (el nombre llano del paso, el mismo que muestra el pipeline), la hora estimada de
 * fin y la sesión (su nombre visible o, sin nombre, el id corto). Al pie, las sesiones vivas sin trabajo y lo que no
 * se pudo leer, con su motivo.
 *
 * La hora de fin es la suma de las medianas de los pasos que faltan, tomadas de las corridas archivadas de esta
 * máquina (`timing-history/`), contando sólo los pasos con arranque y fin medidos (`step-times.js`), más la entrada a
 * los repos de la story (CI, cola y merge: la mediana del tiempo entre el último commit de cada rama y su merge, leída
 * de su historia de git). La hora es fija: cuenta desde el arranque del paso en curso, y pasado su estimado dice
 * «atrasada (estimado HH:MM)»; nunca corre con el reloj. Si algún paso que falta no tiene mediana, no hay hora: se dice
 * cuál. Un repo sin merges medidos queda afuera de la hora, y se dice.
 *
 * Una sesión viva sin marcador ni ad-hoc también puede estar trabajando (un video, una medición, una story que todavía
 * no armó su marcador): si su archivo de sesión dice `busy`, o tuvo actividad en los últimos 5 minutos, sale en la tabla
 * como «Trabajando sin pipeline», con la hora de su última actividad. Qué hace sale del último archivo que tocó en las
 * últimas 3 h, del registro que el arnés escribe por sesión (`file-events/<sid>.jsonl`), salvo los de su carpeta temporal
 * y los de la memoria: el repo, y su rama o la primera carpeta dentro del repo; la story, de una rama `story/<id>…` o de
 * un archivo `specs/story-<id>-…`. Sin ninguno, su carpeta y su rama. Una nota (`marker.js doing`) manda sobre lo
 * deducido. Un trabajo suelto dice desde cuándo no se toca; pasada 1 h, pregunta si terminó y dice
 * cómo cerrarlo desde su sesión. La última actividad es la más nueva de las fechas de su archivo de sesión y la de su transcripción, de la que
 * sólo se mira la fecha. Libre es la que no hace nada hace más de 5 minutos; sin actividad hace más de 3 horas, va en
 * una línea aparte («Sin uso»): el proceso vive, pero nadie la usa. Sin ningún dato de actividad, sigue libre y se dice.
 *
 * En la tabla va sólo el trabajo con sesión viva. Lo que quedó de una sesión cerrada (proceso muerto) o sin rastro
 * (sin archivo de sesión: Claude lo borra al cerrar, y Codex no lo escribe) va abajo, en «Quedaron a medio camino»,
 * con la forma de limpiarlo (`clear-session` para un marcador, `adhoc clear-orphan` para un ad-hoc de más de 24 h).
 * El programa no limpia nada.
 *
 * Un marcador sin pasos pendientes está terminado y no se muestra. Uno sin tocar hace más de 24 h no cuenta, igual que
 * para `marker.js list-all`, que lo descarta; acá sólo se dice cuántos hay, sin borrarlos.
 *
 * Excepción: si cerró el paso 8 y su sesión sigue viva (de sus cierres cuenta el que cerró último), la story puede estar esperando entrar a los repos (la CI, la
 * cola, un pedido en borrador). Se buscan sus repos (`repoPath` y la raíz git de cada archivo tocado, salvo los que
 * están en su rama principal) y se pregunta por los pedidos abiertos de su rama: a GitHub con `gh`, a Azure DevOps
 * con `az`. Con alguno abierto, o con una consulta que no contestó, sale como «Entrando a los repos» y la sesión no
 * cuenta como libre; pasada la hora estimada, dice desde cuándo espera. Un repo tocado cuenta si está en la rama del
 * repo de la story o en una que la nombra: una carpeta compartida que hoy está en la rama de otra story no es de ésta.
 * Las consultas corren en paralelo, 15 s cada una y 20 s todas juntas (`az` tarda cuando renueva su permiso): lo que
 * no contesta se dice al pie y la tabla sale igual.
 *
 * Una fila por sesión: con una story en curso o esperando entrar, esa story es lo principal, y lo otro que hace la
 * sesión sale como «mientras tanto»: su arreglo rápido, su nota, o el repo de lo último que tocó si no es de la story.
 *
 * Sólo lee. No toca marcadores ni sesiones, no lee el contenido de ninguna transcripción ni la configuración de la
 * organización.
 *
 * Uso:  node scripts/tools/work-in-progress.js [--json] [--state-dir <dir>] [--sessions-dir <dir>] [--projects-dir <dir>] [--now <iso>]
 *       node scripts/tools/work-in-progress.js --marker <archivo>   (los pedidos abiertos de esa story, en JSON:
 *       `{ prs: [{ repo, ref, draft, conflict }], failed, unreadable }`; lo usa el cartel de la corrida)
 * Sale: 0 con la tabla (aunque haya ilegibles: se dicen) · 2 si no existe la carpeta de estado.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const { stateDir, claudeDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
const { stepName, isDone, byId, schemeOf, pendingSteps } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'steps.js'));
const { tiempos } = require(path.join(ROOT, 'scripts', 'metrics', 'step-times.js'));

const TITLE_MAX = 50;
const STALE_MS = 24 * 3600 * 1000;
// una sesión con actividad más nueva que esto está trabajando aunque su archivo diga `idle` (entre dos pedidos)
const WORKING_MS = 5 * 60 * 1000;
// una sesión sin actividad hace más que esto no se ofrece como libre: el proceso vive, pero nadie la usa
const IDLE_MS = 3 * 3600 * 1000;
// un trabajo suelto sin tocar hace más que esto pregunta si terminó
const LOOSE_STALE_MS = 3600 * 1000;
const MARKER_JS = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'marker.js');
const shortId = (sid) => String(sid || '').slice(0, 8) || '?';
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const cut = (s, n) => {
  const chars = Array.from(oneLine(s));
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : chars.join('');
};
const stateOf = (step) => stepName(step) || `paso ${step}`;

// Un objeto JSON, o un error con el motivo: un `null`, un número o una lista no son un marcador ni una sesión.
function readObject(file) {
  const v = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('no es un objeto');
  return v;
}

// Los .json de una carpeta. Que no exista es normal (nada de ese tipo); cualquier otro error se dice.
function jsonFiles(dir, unreadable) {
  try { return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort().map((n) => path.join(dir, n)); }
  catch (e) {
    if (e.code !== 'ENOENT') unreadable.push(`${dir}: ${e.message}`);
    return [];
  }
}

function median(values) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function storyTitle(storyPath) {
  const text = fs.readFileSync(storyPath, 'utf8');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const line = fm && /^title:[ \t]*(.+?)\r?$/m.exec(fm[1]);
  if (!line) throw new Error('sin title: en el frontmatter');
  return line[1].trim().replace(/^["']|["']$/g, '');
}

// Medianas en ms por id de paso, de los pasos medidos y sin fusionar de las corridas archivadas.
function stepMedians(dir, unreadable) {
  const samples = {};
  let broken = 0;
  for (const file of jsonFiles(dir, unreadable)) {
    let dump;
    try { dump = readObject(file); } catch { broken += 1; continue; }
    const m = dump.marker;
    if (!m || !m.stepTimings) continue;
    let t;
    try { t = tiempos(m.stepTimings, { inicio: m.startedAt }); } catch { broken += 1; continue; }
    for (const p of t.pasos || []) {
      if (!p.medida || p.subpaso || (p.pasos && p.pasos.length !== 1)) continue;
      (samples[p.paso] = samples[p.paso] || []).push(p.ms);
    }
  }
  if (broken) unreadable.push(`${broken} ejecución(es) archivada(s) en ${dir}: no se pudieron leer`);
  const out = {};
  for (const [k, v] of Object.entries(samples)) out[k] = median(v);
  // Un paso por nombre de máquina sin ejecuciones propias todavía usa la mediana de su equivalente viejo.
  // El 4 viejo era implementar y correr las pruebas: va entero a Implementar y Correr las pruebas suma 0, sin repartir.
  const sum = (...ks) => (ks.every((k) => out[k] != null) ? ks.reduce((a, k) => a + out[k], 0) : undefined);
  const viejo = { start: sum('0'), 'validate-story': sum('1'), plan: sum('2'), 'approve-plan': sum('3'), implement: sum('4'),
    'run-tests': out['4'] != null ? 0 : undefined, reviewers: sum('5'), findings: sum('6', '7'), 'prepare-commit': sum('8') };
  for (const [k, v] of Object.entries(viejo)) if (out[k] == null && v !== undefined) out[k] = v;
  return out;
}

// La fecha de la transcripción de una sesión (sólo la fecha: nunca se abre). Claude Code la guarda en una carpeta con el
// nombre de la carpeta de la sesión, cada carácter que no es letra, número ni guion cambiado por un guion.
function transcriptMs(projectsDir, cwd, sid) {
  if (!projectsDir || typeof cwd !== 'string' || !cwd || !SAFE_SID.test(String(sid))) return null;
  try { return fs.statSync(path.join(projectsDir, cwd.replace(/[^A-Za-z0-9-]/g, '-'), `${sid}.jsonl`)).mtimeMs; } catch { return null; }
}

// El nombre que le puso la persona a la pestaña con /rename: el `customTitle` del último renglón `custom-title` de su
// conversación, que Claude Code vuelve a escribir cada pocos renglones. Se mira sólo el final del archivo y, de ahí, sólo
// esos renglones: nada más de la conversación se lee ni se guarda. Sin ninguno, null.
const ABSENT_FILE = ['ENOENT', 'ENOTDIR'];
const TITLE_TAIL_BYTES = 256 * 1024;
const NAME_MAX = 40;
// un id de sesión entra en una ruta: sólo letras, números, guion y guion bajo (nada de `../`)
const SAFE_SID = /^[A-Za-z0-9_-]+$/;
function sessionTitle(projectsDir, cwd, sid, unreadable = []) {
  if (!projectsDir || typeof cwd !== 'string' || !cwd || !SAFE_SID.test(String(sid))) return null;
  const file = path.join(projectsDir, cwd.replace(/[^A-Za-z0-9-]/g, '-'), `${sid}.jsonl`);
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, TITLE_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (e) {
    // sin conversación guardada no hay título; una que está y no se lee se dice (el nombre cae al de siempre)
    if (!ABSENT_FILE.includes(e && e.code)) unreadable.push(`el nombre de la sesión ${shortId(sid)}: su conversación no se puede leer (${(e && e.code) || 'error'})`);
    return null;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes('"custom-title"')) continue;
    let t;
    try { t = JSON.parse(lines[i]); } catch { continue; }
    if (t && t.type === 'custom-title' && typeof t.customTitle === 'string' && t.customTitle.trim()) return cut(oneLine(t.customTitle), NAME_MAX);
  }
  return null;
}

// Los nombres que les puso la persona a las sesiones de Codex (`threads.name` de su base `state_<n>.sqlite`, la de número
// más alto; `title` es el resumen automático y no se usa), abierta en sólo lectura. Sin Codex, vacío; una base que no se
// abre, vacío y una línea al pie.
function codexNames(codexHome, unreadable) {
  const out = new Map();
  let bases;
  try { bases = fs.readdirSync(codexHome).filter((f) => /^state_\d+\.sqlite$/.test(f)); } catch (e) {
    // sin Codex, nada que decir; una carpeta de Codex que no se puede leer, sí
    if (!ABSENT_FILE.includes(e && e.code)) unreadable.push(`los nombres de las sesiones de Codex: ${codexHome} no se puede leer (${(e && e.code) || 'error'})`);
    return out;
  }
  const newest = bases.sort((a, b) => Number(/\d+/.exec(a)[0]) - Number(/\d+/.exec(b)[0])).pop();
  if (!newest) return out;
  let db = null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(path.join(codexHome, newest), { readOnly: true });
    for (const r of db.prepare("SELECT id, name FROM threads WHERE name IS NOT NULL AND name <> ''").all()) out.set(String(r.id), cut(oneLine(String(r.name)), NAME_MAX));
  } catch (e) {
    unreadable.push(`los nombres de las sesiones de Codex (${newest}) no se pudieron leer: ${oneLine((e && e.message) || e).slice(0, 120)}`);
  } finally { try { if (db) db.close(); } catch { /* ya cerrada */ } }
  return out;
}

// Un agente interno de otra sesión (un examen o un pase que lanza su propio Claude): corre en la carpeta temporal del
// sistema y nadie le puso nombre. Hacen falta las dos señales: un laboratorio con nombre puesto es una sesión de verdad.
function isInternalAgent(cwd, nameSource) {
  if (nameSource !== 'derived' || !cwd) return false;
  let real = cwd;
  try { real = fs.realpathSync(cwd); } catch { /* ya no existe: se juzga por la ruta escrita */ }
  const tmp = (() => { try { return fs.realpathSync(os.tmpdir()); } catch { return os.tmpdir(); } })();
  return [tmp, '/var/folders', '/private/var/folders'].some((t) => real === t || real.startsWith(t + path.sep));
}

function sessionsBySid(dir, unreadable, projectsDir) {
  const out = new Map();
  for (const file of jsonFiles(dir, unreadable)) {
    let s;
    try { s = readObject(file); } catch (e) { unreadable.push(`${file}: ${e.message}`); continue; }
    if (!s.sessionId) { unreadable.push(`${file}: sin sessionId`); continue; }
    const pid = Number(s.pid);
    if (!Number.isInteger(pid) || pid <= 0) { unreadable.push(`${file}: pid ilegible`); continue; }
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
    const dates = [Number(s.statusUpdatedAt), Number(s.updatedAt), transcriptMs(projectsDir, s.cwd, s.sessionId)].filter((v) => Number.isFinite(v) && v > 0);
    const cwd = typeof s.cwd === 'string' ? s.cwd : null;
    // el nombre es el del archivo de sesión, el que usan los mensajes; sin él, el último /rename de la conversación
    const name = (typeof s.name === 'string' && s.name.trim()) ? cut(oneLine(s.name), NAME_MAX) : sessionTitle(projectsDir, cwd, s.sessionId, unreadable);
    const cur = { name: name || null, alive, busy: s.status === 'busy', status: typeof s.status === 'string' ? s.status : null, statusAt: Number(s.statusUpdatedAt) || null, nameSource: typeof s.nameSource === 'string' ? s.nameSource : null, cwd, last: dates.length ? Math.max(...dates) : null, internal: isInternalAgent(cwd, s.nameSource) };
    // Dos archivos con la misma sesión: manda el vivo, y la actividad es la más nueva de los dos.
    const prev = out.get(s.sessionId);
    if (!prev || (!prev.alive && alive)) out.set(s.sessionId, prev && prev.last > nn(cur.last, -1) ? { ...cur, last: prev.last } : cur);
    else if (prev.last == null || (cur.last != null && cur.last > prev.last)) prev.last = nn(cur.last, prev.last);
  }
  return out;
}

const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// Lo que dice la hora de fin sobre la entrada a los repos: sumada, o cuáles quedaron afuera por no tener merges medidos.
function entryNote(entry) {
  if (!entry || !entry.repos) return '';
  return entry.missing.length ? ` (sin la entrada a ${entry.missing.join(', ')}: sin merges medidos)` : ' (con la entrada a los repos)';
}

// La hora es fija: arranque del paso en curso + su mediana + las de los pasos que faltan + la entrada a los repos.
// Pasado el estimado del paso en curso, dice «atrasada» con esa hora; nunca corre con el reloj (si corriera, un paso
// pasado de su mediana mostraría la hora actual y escondería el atraso).
function estimateEnd(marker, medians, nowMs, entry) {
  // los pasos que se dan por hechos con una bandera (el pase adversarial, la prueba en vivo) no tienen mediana propia:
  // su tiempo cae en el paso que acompañan, como los sub-pasos viejos
  const pending = (marker.stepsPending || []).map(String).filter((s) => !(byId(s) && (byId(s).flag || !byId(s).number)));
  if (!pending.length) return 'sin datos (no quedan pasos)';
  const missing = pending.find((s) => medians[s] == null);
  if (missing !== undefined) return `sin datos (${stateOf(missing)})`;
  const current = pending[0];
  const timings = marker.stepTimings || {};
  let since = timings[current] && Date.parse(timings[current].startedAt);
  // Sin arranque anotado del paso en curso, se cuenta desde el fin del último paso: la hora es aproximada y se dice.
  let approx = false;
  if (!Number.isFinite(since)) {
    approx = true;
    const ends = Object.values(timings).map((x) => Date.parse(x && x.completedAt)).filter(Number.isFinite);
    since = ends.length ? Math.max(...ends) : nowMs;
  }
  const currentEnd = since + medians[current];
  let fixed = currentEnd;
  for (const s of pending.slice(1)) fixed += medians[s];
  fixed += entry ? entry.ms : 0;
  if (nowMs > currentEnd) return `atrasada (estimado ${hhmm(fixed)}${approx ? ', aprox.' : ''})`;
  return `${hhmm(fixed)}${approx ? ' (aprox.)' : ''}${entryNote(entry)}`;
}

// La story que cerró el paso 8 y espera sus pedidos: el cierre del 8 más la entrada a los repos.
function enteringEnd(marker, entry, nowMs) {
  if (!entry || !entry.repos || entry.missing.length) {
    return `sin estimación (espera la CI o la cola; sin merges medidos en ${entry && entry.missing.length ? entry.missing.join(', ') : 'sus repos'})`;
  }
  const t8 = (marker.stepTimings || {})['prepare-commit'] || (marker.stepTimings || {})['8'];
  const done = Date.parse(t8 && t8.completedAt);
  if (!Number.isFinite(done)) return 'sin estimación (espera la CI o la cola; sin la hora de cierre de «Preparar el commit»)';
  const fixed = done + entry.ms;
  // pasada la hora, no está atrasada: espera la CI o la cola, y se dice desde cuándo
  return nowMs > fixed ? `esperando entrar desde ${hhmm(done)} (estimado ${hhmm(fixed)})` : `${hhmm(fixed)}${entryNote(entry)}`;
}

const ENTERING = 'Entrando a los repos';
const MAIN_BRANCHES = ['main', 'master'];
const PER_QUERY_MS = 15000;
const ALL_QUERIES_MS = 20000;
const GIT_MS = 2000;
const GIT_BUDGET_MS = 3000;

// git con tope: `{ out }` si salió bien; si no, `{ err, status }` con el motivo. `ctx.until` es el tope de toda la
// lectura de repos y `ctx.cache` guarda lo leído, para que la segunda pasada no vuelva a preguntar.
function git(dir, args, ctx) {
  const key = `${dir}\0${args.join(' ')}`;
  if (ctx.cache.has(key)) return ctx.cache.get(key);
  if (Date.now() > ctx.until) return { err: `se pasó del tope de ${GIT_BUDGET_MS / 1000} s leyendo los repos`, status: null };
  const res = gitNow(dir, args, Math.max(1, Math.min(GIT_MS, ctx.until - Date.now())));
  ctx.cache.set(key, res);
  return res;
}

// git en inglés (LC_ALL=C): los motivos «not a git repository» y «No such remote» se reconocen por su texto.
function gitNow(dir, args, ms) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, timeout: ms, env: { ...process.env, LC_ALL: 'C' } });
  if (r.status === 0) return { out: r.stdout.trim() };
  if (r.error) return { err: r.error.code === 'ETIMEDOUT' ? 'git se pasó del tope leyendo los repos' : `git: ${r.error.message}`, status: null };
  return { err: oneLine(r.stderr || `git salió con ${r.status}`).slice(0, 200), status: r.status };
}

// ── El repo de una carpeta, leído de sus archivos de git (sin lanzar git) ────────────────────────────────────────
// Ubicar una carpeta (su raíz, su rama, su `origin`) es leer tres archivos; lanzar git por cada carpeta agotaba el tope
// de 3 s con muchos worktrees. git queda para la historia de merges (`entryMedianMs`).
// Un archivo de git: `{ text }`, `{ missing: true }` si no está, o `{ err }` si está y no se puede leer (con su código).
const ABSENT = ABSENT_FILE;
function readText(file) {
  try { return { text: fs.readFileSync(file, 'utf8') }; } catch (e) {
    return ABSENT.includes(e && e.code) ? { missing: true } : { err: (e && e.code) || 'error de lectura' };
  }
}

// `{ root, gitDir, commonDir }` de la carpeta (subiendo hasta un `.git`: una carpeta, o el archivo `gitdir: <ruta>` de un
// worktree o un submódulo), o null fuera de un repo. Un `.git` que no se puede leer, o un archivo sin esa línea, es un
// repo roto: `{ root, err }`. La raíz va por su ruta real (`/private/var/…` en la Mac).
function repoOf(dir, ctx) {
  const key = `repo\0${dir}`;
  if (ctx.cache.has(key)) return ctx.cache.get(key);
  let found = null;
  for (let d = dir; ; d = path.dirname(d)) {
    const dotgit = path.join(d, '.git');
    let st = null;
    try { st = fs.statSync(dotgit); } catch (e) {
      // sin `.git` se sigue subiendo; uno que está y no se puede mirar no es «fuera de un repo»
      if (!ABSENT.includes(e && e.code)) { found = { root: d, err: `${d}: su .git no se puede leer (${(e && e.code) || 'error'})` }; break; }
    }
    if (st && st.isDirectory()) { found = { root: d, gitDir: dotgit }; break; }
    if (st && st.isFile()) {
      const r = readText(dotgit);
      const pointer = r.text !== undefined && /^gitdir:\s*(.+?)\s*$/m.exec(r.text);
      found = pointer ? { root: d, gitDir: path.resolve(d, pointer[1]) }
        : { root: d, err: r.err ? `${d}: su .git no se puede leer (${r.err})` : `${d}: su .git no dice dónde está la carpeta git` };
      break;
    }
    if (path.dirname(d) === d) break;
  }
  if (found && !found.err) {
    // en un worktree, `commondir` lleva a la carpeta git común (la del `config` con su `origin`)
    const common = readText(path.join(found.gitDir, 'commondir'));
    if (common.err) found.err = `${found.root}: su commondir no se puede leer (${common.err})`;
    found.commonDir = common.text && common.text.trim() ? path.resolve(found.gitDir, common.text.trim()) : found.gitDir;
    try { found.root = fs.realpathSync(found.root); } catch { /* queda la escrita */ }
    // quien pregunte después por la raíz misma no vuelve a subir
    ctx.cache.set(`repo\0${found.root}`, found);
  }
  ctx.cache.set(key, found);
  return found;
}

// La rama del repo: `{ branch }` (vacía con HEAD suelto), o `{ err }` si HEAD no se lee.
function branchOf(repo) {
  const head = readText(path.join(repo.gitDir, 'HEAD'));
  if (head.text === undefined) return { err: `${repo.root}: no se lee su HEAD (${head.err || 'no está'})` };
  const ref = /^ref:\s*refs\/heads\/(.+?)\s*$/.exec(head.text.trim());
  return { branch: ref ? ref[1] : '' };
}

// La dirección de `origin` en el `config` común del repo: `{ url }`, `{ none: true }` sin `origin`, o `{ err }`.
function originOf(repo) {
  const config = readText(path.join(repo.commonDir, 'config'));
  if (config.text === undefined) return { err: `no se lee su config (${config.err || 'no está'})` };
  let inOrigin = false;
  for (const line of config.text.split(/\r?\n/)) {
    const section = /^\s*\[\s*([^\]]+?)\s*\]/.exec(line);
    if (section) { inOrigin = /^remote\s+"origin"$/.test(section[1]); continue; }
    const url = inOrigin && /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
    if (url) return { url: url[1] };
  }
  return { none: true };
}

// La entrada a un repo (CI, cola y merge), medida en su historia de git: de los últimos merges a la rama principal, el
// tiempo entre el último commit de la rama y su merge. Mediana en ms, o null sin merges medidos. Sin red.
const ENTRY_SAMPLES = 30;
function entryMedianMs(root, ctx) {
  let ref = null;
  for (const r of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) {
    const v = git(root, ['rev-parse', '--verify', '-q', `${r}^{commit}`], ctx);
    if (!v.err && v.out) { ref = r; break; }
  }
  if (!ref) return null;
  const log = git(root, ['log', '--merges', '--first-parent', '-n', String(ENTRY_SAMPLES), '--format=%ct %P', ref], ctx);
  if (log.err || !log.out) return null;
  const merges = log.out.split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 3).map(([ct, , tip]) => ({ ct: Number(ct), tip }));
  if (!merges.length) return null;
  const tips = git(root, ['log', '--no-walk=unsorted', '--format=%H %ct', ...merges.map((x) => x.tip)], ctx);
  if (tips.err) return null;
  const at = new Map(tips.out.split('\n').map((l) => l.trim().split(' ')).map(([h, c]) => [h, Number(c)]));
  return median(merges.map((x) => (x.ct - at.get(x.tip)) * 1000).filter((v) => Number.isFinite(v) && v >= 0));
}

// La entrada a los repos de una story: la suma de las medianas (entran uno detrás del otro) y los que no tienen medida.
function storyEntry(m, ctx) {
  const roots = storyRepos(m, [], ctx);
  const out = { repos: roots.length, ms: 0, missing: [] };
  for (const root of roots) {
    const med = entryMedianMs(root, ctx);
    if (med == null) out.missing.push(path.basename(root));
    else out.ms += med;
  }
  return out;
}

// Las raíces git de la story: su repoPath y la carpeta de cada archivo tocado. Lo que no existe o no es un repo se
// saltea (un archivo tocado que se borró es normal: los temporales); un git que falla por otra cosa va a `failures`.
function storyRepos(m, failures, ctx) {
  const roots = [];
  if (m.repoPath != null && (typeof m.repoPath !== 'string' || !path.isAbsolute(m.repoPath))) failures.push(`repoPath ilegible: ${JSON.stringify(m.repoPath)}`);
  else if (m.repoPath && !fs.existsSync(m.repoPath)) failures.push(`${m.repoPath}: ya no existe`);
  const touched = Array.isArray(m.filesTouched) ? m.filesTouched.map((f) => path.dirname(String(f))) : [];
  // Una pregunta por repo: de la más corta a la más larga, una carpeta que ya está dentro de una raíz encontrada no se
  // vuelve a preguntar. Las que no se leyeron por el tope de tiempo van en un solo renglón, con la cuenta.
  const dirs = [...new Set([m.repoPath, ...touched])].filter((d) => typeof d === 'string' && path.isAbsolute(d)).sort((a, b) => a.length - b.length);
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    // git da la raíz por su ruta real (`/private/var/…` en la Mac): se compara con la carpeta por la suya
    let real = dir;
    try { real = fs.realpathSync(dir); } catch { /* se compara por la escrita */ }
    // ya está dentro de una raíz encontrada, salvo que en el medio haya otro repo (un submódulo, un `vendor/`)
    const inside = (d, r) => {
      if (d !== r && !d.startsWith(r + path.sep)) return false;
      for (let p = d; p !== r; p = path.dirname(p)) if (fs.existsSync(path.join(p, '.git'))) return false;
      return true;
    };
    if (roots.some((r) => inside(dir, r) || inside(real, r))) continue;
    const repo = repoOf(dir, ctx);
    if (repo && repo.err) { failures.push(repo.err); continue; }
    if (repo && !roots.includes(repo.root)) roots.push(repo.root);
  }
  return roots;
}

// Adónde apunta `origin`: GitHub (dueño/repo), Azure DevOps (organización, proyecto, repo) u otro servidor. Del otro
// servidor sólo se da el nombre: nunca la dirección, que puede traer usuario y contraseña.
function parseRemote(url) {
  // el servidor va después del último «@» de lo que está antes de la primera «/», así un «@» de la ruta no lo corre; si
  // ahí no hay «@» (una contraseña con «/» sin codificar), después del último «@» de toda la dirección. La ruta es lo
  // que le sigue, sin el puerto. Se reconoce por el servidor, nunca por un pedazo de la ruta.
  const rest = String(url || '').trim().replace(/^[a-z+]+:\/\//i, '');
  const authority = rest.split('/')[0];
  const tail = rest.slice((authority.includes('@') ? authority.lastIndexOf('@') : rest.lastIndexOf('@')) + 1);
  const host = tail.split(/[/:]/)[0].toLowerCase();
  const route = tail.slice(host.length).replace(/^:\d+\//, '/').slice(1);
  const plain = (v) => /^[\p{L}\p{N}][\p{L}\p{N}_ .-]*$/u.test(v) && !v.includes('..');
  const decode = (v) => { try { return decodeURIComponent(v); } catch { return v; } };
  if (host === 'github.com' || host === 'ssh.github.com') {
    const x = /^([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(route);
    return x && plain(x[1]) && plain(x[2]) ? { kind: 'github', slug: `${x[1]}/${x[2]}`, name: x[2] } : { kind: null, host: 'GitHub, con un repo que no reconozco' };
  }
  let x = null;
  if (host === 'dev.azure.com') {
    // sin proyecto (`org/_git/repo`), Azure DevOps usa el proyecto que se llama como el repo
    const y = /^([^/]+)\/_git\/([^/]+?)\/?$/.exec(route);
    x = y ? [null, y[1], y[2], y[2]] : /^([^/]+)\/([^/]+)\/_git\/([^/]+?)\/?$/.exec(route);
  }
  else if (host === 'ssh.dev.azure.com') x = /^v3\/([^/]+)\/([^/]+)\/([^/]+?)\/?$/.exec(route);
  else if (host.endsWith('.visualstudio.com')) {
    const y = /^(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+?)\/?$/.exec(route);
    x = y && [null, host.slice(0, -'.visualstudio.com'.length), y[1], y[2]];
  }
  if (host === 'dev.azure.com' || host === 'ssh.dev.azure.com' || host.endsWith('.visualstudio.com')) {
    const [org, project, repo] = x ? x.slice(1).map(decode) : [];
    if (!x || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(org) || !plain(project) || !plain(repo)) {
      return { kind: null, host: 'Azure DevOps, con una organización, un proyecto o un repo que no reconozco' };
    }
    return { kind: 'azure', org, project, repo, name: repo };
  }
  return { kind: null, host: /^[\w-]+(\.[\w-]+)+$/.test(host) ? host : 'un servidor que no reconozco' };
}

// Qué preguntar por cada raíz con rama propia: `null` si está en su rama principal o sin rama (HEAD suelto).
function repoQuery(root, failures, ctx) {
  const repo = repoOf(root, ctx);
  if (!repo) return null;
  if (repo.err) { failures.push(repo.err); return null; }
  const head = branchOf(repo);
  if (head.err) { failures.push(head.err); return null; }
  if (!head.branch || MAIN_BRANCHES.includes(head.branch)) return null;
  const origin = originOf(repo);
  if (!origin.url) return { root, branch: head.branch, kind: null, host: origin.none ? 'ningún servidor (el repo no tiene origin)' : `ningún servidor (no pude leer origin: ${origin.err})` };
  return { root, branch: head.branch, ...parseRemote(origin.url) };
}

function commandFor(q) {
  if (q.kind === 'github') return ['gh', ['pr', 'list', '--repo', q.slug, '--head', q.branch, '--state', 'open', '--json', 'number,isDraft,mergeable,mergeStateStatus']];
  return ['az', ['repos', 'pr', 'list', '--org', `https://dev.azure.com/${encodeURIComponent(q.org)}`, '--project', q.project,
    '--repository', q.repo, '--source-branch', q.branch, '--status', 'active', '--output', 'json']];
}

// En Windows `az` es az.cmd, que node sólo corre por la consola: sólo con letras, números y . _ : / - y espacio.
const shellSafe = (args) => args.every((a) => /^[\p{L}\p{N}_ .:/-]+$/u.test(a));

function runQuery(q, perMs, env, children) {
  return new Promise((resolve) => {
    let [cmd, args] = commandFor(q);
    const options = { encoding: 'utf8', windowsHide: true, timeout: perMs, killSignal: 'SIGKILL', env };
    if (process.platform === 'win32' && cmd === 'az') {
      if (!shellSafe(args)) { resolve({ error: 'az: argumentos con caracteres no seguros para la consola' }); return; }
      args = args.map((a) => `"${a}"`);
      options.shell = true;
    }
    children.push(execFile(cmd, args, options, (err, stdout, stderr) => {
      if (err) {
        const why = err.killed ? `se pasó del tope de ${perMs / 1000} s`
          : err.code === 'ENOENT' ? 'no está instalado' : oneLine(stderr || err.message).slice(0, 200);
        resolve({ error: `${cmd}: ${why}` });
        return;
      }
      try {
        const list = JSON.parse(stdout);
        if (!Array.isArray(list)) throw new Error('no es una lista');
        // choca con main: lo dice el servidor (GitHub DIRTY o CONFLICTING, Azure `conflicts`); UNKNOWN o sin el dato, nada
        const prs = list.map((p) => ({
          number: p && nn(p.number, p.pullRequestId), draft: Boolean(p && p.isDraft === true),
          conflict: Boolean(p && (p.mergeStateStatus === 'DIRTY' || p.mergeable === 'CONFLICTING' || p.mergeStatus === 'conflicts')),
        }));
        if (!prs.every((p) => Number.isInteger(p.number))) throw new Error('un pedido sin número');
        resolve({ prs });
      } catch (e) { resolve({ error: `${cmd}: respuesta ilegible (${e.message})` }); }
    }));
  });
}

// Todas las consultas a la vez, cada una con su tope y todas juntas con otro; al vencer el total se matan las que
// siguen vivas, para que el comando termine. Lo que no contesta es un error.
function queryAll(queries, { perMs = PER_QUERY_MS, totalMs = ALL_QUERIES_MS, env = process.env } = {}) {
  const children = [];
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => {
      for (const c of children) c.kill('SIGKILL');
      resolve({ error: `se pasó del tope de ${totalMs / 1000} s para todas las consultas` });
    }, totalMs);
  });
  return Promise.all(queries.map((q) => Promise.race([runQuery(q, perMs, env, children), late]))).finally(() => clearTimeout(timer));
}

// La rama de una carpeta, o '' (sin repo, sin rama, o que no existe). Un repo roto o un HEAD que no se lee van a
// `unreadable` (una vez cada uno), no se callan.
function branchAt(dir, ctx, unreadable) {
  if (!dir || !path.isAbsolute(dir) || !fs.existsSync(dir)) return '';
  const repo = repoOf(dir, ctx);
  const head = repo && !repo.err ? branchOf(repo) : null;
  const err = (repo && repo.err) || (head && head.err);
  if (err && unreadable && !unreadable.includes(err)) unreadable.push(err);
  return head && !head.err ? head.branch : '';
}

// La story de la rama de la carpeta de una sesión (`story/<id>…`), o `null`.
function storyBranch(dir, ctx, unreadable) {
  const x = /^story\/(\d+(?:\.\d+)+)(?:[-/]|$)/.exec(branchAt(dir, ctx, unreadable));
  return x ? x[1] : null;
}

// Qué hace una sesión sin pipeline: su carpeta y la rama en que está (sin rama: sólo la carpeta).
function sessionPlace(cwd, ctx, unreadable) {
  if (!cwd) return '(carpeta desconocida)';
  const branch = branchAt(cwd, ctx, unreadable);
  return branch ? `${path.basename(cwd)} · ${branch}` : path.basename(cwd);
}

// Los últimos archivos que tocó una sesión, del más nuevo al más viejo, del registro que escribe el arnés
// (`file-events/<sid>.jsonl`, un `{path, ts}` por renglón): de las últimas 3 h, sin los de su carpeta temporal
// (`scratchpad`) ni los de la memoria de Claude Code, que toca entre medio de su trabajo, y sin repetir. Sólo se lee el
// final del registro: el renglón más nuevo está abajo.
const TOUCHED_TAIL_BYTES = 64 * 1024;
const TOUCHED_MAX = 20;
function lastTouched(sdir, sid, home, nowMs, unreadable) {
  if (!SAFE_SID.test(String(sid))) return [];
  const file = path.join(sdir, 'file-events', `${sid}.jsonl`);
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, TOUCHED_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (e) {
    if (e.code !== 'ENOENT') unreadable.push(`${file}: ${e.message}`);
    return [];
  }
  const memory = path.join(home, '.claude', 'projects') + path.sep;
  const lines = text.split('\n');
  const out = [];
  // un renglón cortado (el primero de la cola) o roto no es un archivo: se saltea
  for (let i = lines.length - 1; i >= 0 && out.length < TOUCHED_MAX; i -= 1) {
    let ev;
    try { ev = JSON.parse(lines[i]); } catch { continue; }
    const p = ev && typeof ev.path === 'string' ? ev.path : '';
    const ts = Date.parse(ev && ev.ts);
    if (!path.isAbsolute(p) || !Number.isFinite(ts)) continue;
    if (nowMs - ts > IDLE_MS) break;
    if (/[\\/]scratchpad[\\/]/.test(p) || p.startsWith(memory) || out.includes(p)) continue;
    out.push(p);
  }
  return out;
}

// Qué hace una sesión según un archivo que tocó: el repo, y la rama si no es la principal o la primera carpeta dentro del
// repo si lo es; la story, de una rama `story/<id>…` o de un archivo `specs/story-<id>-…`; `root`, la raíz del repo o
// worktree. Fuera de un repo, `null`; un HEAD que no se lee, al pie.
function touchedPlace(file, ctx, unreadable) {
  let dir = path.dirname(file);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const repo = repoOf(dir, ctx);
  if (!repo) return null;
  if (repo.err) { if (!unreadable.includes(repo.err)) unreadable.push(repo.err); return null; }
  const root = repo.root;
  // la raíz va por su ruta real (`/private/var/…` en la Mac): el archivo se mide desde la suya
  let real = dir;
  try { real = fs.realpathSync(dir); } catch { /* se mide desde la escrita */ }
  const rel = path.relative(root, path.join(real, path.relative(dir, file)));
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  const head = branchOf(repo);
  if (head.err && !unreadable.includes(head.err)) unreadable.push(head.err);
  const branch = head.err ? '' : head.branch;
  const fromBranch = /^story\/(\d+(?:\.\d+)+)(?:[-/]|$)/.exec(branch);
  const fromSpec = /(?:^|[\\/])specs[\\/]story-(\d+(?:\.\d+)+)-/.exec(rel);
  const parts = rel.split(/[\\/]/);
  const base = path.basename(root);
  const work = branch && !MAIN_BRANCHES.includes(branch) ? `${base} · ${branch}` : parts.length > 1 ? `${base} · ${parts[0]}` : base;
  return { work, root, branch, story: (fromBranch && fromBranch[1]) || (fromSpec && fromSpec[1]) || null };
}

// ¿Es de la story un repo (su raíz y su rama)? El de su repoPath, uno en la misma rama, o uno en una rama que nombra la
// story (`story/<id>-…`).
function ofStory(m, ctx) {
  const own = typeof m.repoPath === 'string' && path.isAbsolute(m.repoPath) && fs.existsSync(m.repoPath) ? repoOf(m.repoPath, ctx) : null;
  const ownHead = own && !own.err ? branchOf(own) : null;
  const ownRoot = own && !own.err ? own.root : null;
  const ownBranch = ownHead && !ownHead.err ? ownHead.branch : '';
  const id = m.storyId ? String(m.storyId) : '';
  return (root, branch) => root === ownRoot || (Boolean(branch) && (branch === ownBranch || (Boolean(id) && branch.split(/[\\/_-]/).includes(id))));
}

// El estado de una story con el paso 8 cerrado: `null` si ya entró (nada abierto y todo contestado). En `found`, si
// viene, quedan los pedidos abiertos uno por uno.
function enteringState(m, prsOf, unreadable, wanted, ctx, found = []) {
  const shown = [];
  const failures = [];
  const mine = ofStory(m, ctx);
  for (const root of storyRepos(m, failures, ctx)) {
    const q = repoQuery(root, failures, ctx);
    if (!q || !mine(q.root, q.branch)) continue;
    if (!q.kind) { failures.push(`pedidos de ${path.basename(root)} (${q.branch}): no sé consultar pedidos en ${q.host}`); continue; }
    wanted.push(q);
    const res = prsOf ? prsOf(q) : { error: 'no se consultó' };
    if (!res || res.error) { failures.push(`pedidos de ${q.name} (${q.branch}): ${res ? res.error : 'sin respuesta'}`); continue; }
    for (const p of res.prs) {
      const ref = `${q.kind === 'github' ? '#' : '!'}${p.number}`;
      found.push({ repo: q.name, ref, draft: p.draft, conflict: p.conflict });
      shown.push(`${q.name} ${ref}${p.draft ? ' (borrador)' : ''}${p.conflict ? ' (choca con main)' : ''}`);
    }
  }
  unreadable.push(...failures.map((f) => `story ${m.storyId || '?'}: ${f}`));
  if (shown.length) return `${ENTERING} · ${shown.join(' · ')}`;
  return failures.length ? `${ENTERING} (no se pudo consultar los pedidos)` : null;
}

// El cierre más nuevo de cada sesión en timing-history/ (sesión → marcador archivado), entre los archivos de las últimas
// 24 h por su fecha (sin abrir los viejos: son cientos) y con el paso 8 cerrado. Uno reciente que no se lee, al pie.
function latestClosures(dir, nowMs, unreadable) {
  const out = new Map();
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch (e) {
    if (e.code !== 'ENOENT') unreadable.push(`${dir}: ${e.message}`);
    return out;
  }
  const recent = [];
  for (const n of names) {
    const file = path.join(dir, n);
    let mtime;
    try { mtime = fs.statSync(file).mtimeMs; } catch (e) { unreadable.push(`${file}: sin fecha legible (${e.message})`); continue; }
    if (nowMs - mtime <= STALE_MS) recent.push({ file, mtime });
  }
  // el más nuevo de cada sesión es el que cerró último (`archivedAt`), no el archivo tocado último: algo puede volver a
  // escribir un cierre viejo. Sin `archivedAt` legible, vale la fecha del archivo.
  const closed = [];
  for (const { file, mtime } of recent) {
    let h;
    try { h = readObject(file); } catch (e) { unreadable.push(`${file}: ${e.message}`); continue; }
    const m = h.marker;
    if (!m || !m.sessionId) continue;
    const at = Date.parse(h.archivedAt);
    closed.push({ m, at: Number.isFinite(at) ? at : mtime });
  }
  closed.sort((a, b) => b.at - a.at);
  // cuenta el más nuevo de cada sesión aunque no haya cerrado el paso 8: uno más viejo no lo reemplaza
  const seen = new Set();
  for (const { m } of closed) {
    if (seen.has(m.sessionId)) continue;
    seen.add(m.sessionId);
    if (isDone(m, 'prepare-commit')) out.set(m.sessionId, m);
  }
  return out;
}

function buildWip(opts = {}) {
  const home = opts.home || os.homedir();
  const sdir = opts.stateDir || stateDir(home);
  const sessionsDir = opts.sessionsDir || path.join(claudeDir(home), 'sessions');
  const nowMs = opts.now ? Date.parse(opts.now) : Date.now();
  if (!Number.isFinite(nowMs)) {
    const err = new Error(`--now no es una fecha: ${opts.now}`);
    err.code = 'BAD_ARG';
    throw err;
  }
  if (!fs.existsSync(sdir)) {
    const err = new Error(`no existe la carpeta de estado del pipeline: ${sdir}`);
    err.code = 'NO_STATE';
    throw err;
  }
  const unreadable = [];
  const projectsDir = opts.projectsDir || path.join(claudeDir(home), 'projects');
  const sessions = sessionsBySid(sessionsDir, unreadable, projectsDir);
  const medians = stepMedians(path.join(sdir, 'timing-history'), unreadable);
  const rows = [];
  // la sesión de cada fila, en el mismo orden: el --json la suma a la fila
  const rowSids = [];
  const addRow = (row, sid) => { rows.push(row); rowSids.push(sid); };
  const busy = new Set();
  // la fila de la story de cada sesión, para sumarle lo que hace mientras tanto
  const pipeRows = new Map();
  const wanted = [];
  const gitCtx = opts.gitCtx || { until: Date.now() + nn(opts.repoBudgetMs, GIT_BUDGET_MS), cache: new Map() };

  const halfway = [];
  const liveName = (sid) => {
    const s = sessions.get(sid);
    return s && s.alive ? (s.name || shortId(sid)) : null;
  };
  // una sesión sin archivo de sesión (cerrada, o de Codex, que no lo escribe): el nombre que le puso la persona en Codex,
  // o el id corto. La base de Codex se lee una vez y sólo si hace falta.
  let codex = null;
  const nameOf = (sid) => {
    if (!codex) codex = codexNames(opts.codexHome || path.join(home, '.codex'), unreadable);
    return codex.get(sid) || shortId(sid);
  };
  // La carpeta donde edita una sesión: la raíz del repo o worktree de su último archivo tocado; sin uno, `fallback` o su
  // carpeta de arranque. Con `~` en lugar del HOME.
  let realHome = home;
  try { realHome = fs.realpathSync(home); } catch { /* queda el escrito */ }
  const tilde = (p) => {
    if (!p) return '(carpeta desconocida)';
    for (const h of [home, realHome]) if (p === h || p.startsWith(h + path.sep)) return path.join('~', p.slice(h.length + 1));
    return p;
  };
  const touchedCache = new Map();
  const touchedOf = (sid) => {
    if (!touchedCache.has(sid)) touchedCache.set(sid, lastTouched(sdir, sid, home, nowMs, unreadable));
    return touchedCache.get(sid);
  };
  const folderOf = (sid, fallback) => {
    for (const f of touchedOf(sid)) {
      let d = path.dirname(f);
      while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
      const repo = repoOf(d, gitCtx);
      if (repo && repo.err) { if (!unreadable.includes(repo.err)) unreadable.push(repo.err); continue; }
      if (repo) return tilde(repo.root);
    }
    const s = sessions.get(sid);
    const usable = (p) => typeof p === 'string' && path.isAbsolute(p);
    return tilde(usable(fallback) ? fallback : s && usable(s.cwd) ? s.cwd : null);
  };

  let stale = 0;
  let staleWaiting = 0;
  for (const file of jsonFiles(path.join(sdir, 'active'), unreadable)) {
    let m;
    try { m = readObject(file); } catch (e) { unreadable.push(`${file}: ${e.message}`); continue; }
    if (!Array.isArray(m.stepsPending)) { unreadable.push(`${file}: sin lista de pasos pendientes`); continue; }
    const closed = !m.stepsPending.length;
    if (closed && !isDone(m, 'prepare-commit')) continue;
    // Sin lastTouch legible, la fecha del archivo; si tampoco se lee, se dice y no se lo da por reciente.
    let touched = Date.parse(m.lastTouch);
    if (!Number.isFinite(touched)) {
      try { touched = fs.statSync(file).mtimeMs; } catch (e) { unreadable.push(`${file}: sin fecha legible (${e.message})`); continue; }
    }
    // un cerrado viejo con la sesión muerta es una corrida terminada; con la sesión viva no se sabe si sus pedidos
    // entraron: se dice al pie, y la sesión sale con lo que hace hoy (o libre)
    if (nowMs - touched > STALE_MS) {
      const sid = m.sessionId || path.basename(file, '.json');
      if (!closed) stale += 1;
      else if (liveName(sid)) staleWaiting += 1;
      continue;
    }
    const sid = m.sessionId || path.basename(file, '.json');
    // Con el paso 8 cerrado sólo cuenta si la sesión vive y la story todavía no entró a sus repos.
    let entering = null;
    if (closed) {
      if (!liveName(sid)) continue;
      entering = enteringState(m, opts.prs, unreadable, wanted, gitCtx);
      if (!entering) continue;
    }
    busy.add(sid);
    let title;
    try { title = storyTitle(m.storyPath); } catch (e) {
      title = '(título ilegible)';
      unreadable.push(`${m.storyPath || '(sin ruta de story)'}: ${e.code === 'ENOENT' ? 'no existe' : e.message}`);
    }
    // con el esquema por nombre, el que sigue incluye los pasos de bandera («Probar en vivo»), que stepsPending no lista
    const step = entering || stateOf((schemeOf(m) === 2 && pendingSteps(m)[0]) || m.stepsPending[0]);
    const work = `${m.storyId || '?'} · ${cut(title, TITLE_MAX)}`;
    const label = liveName(sid);
    if (label) {
      const entry = storyEntry(m, gitCtx);
      pipeRows.set(sid, { i: rows.length, m });
      addRow({ work, state: step, end: entering ? enteringEnd(m, entry, nowMs) : estimateEnd(m, medians, nowMs, entry), session: label, folder: folderOf(sid, m.repoPath) }, sid);
    }
    else halfway.push(`${work} · ${nameOf(sid)} · quedó en: ${step} · limpiar: node ${MARKER_JS} clear-session ${sid}`);
  }

  // Después del cierre: `marker.js clear` borra el marcador y deja el cierre en timing-history/. Una sesión viva sin
  // marcador activo cuyo cierre más nuevo (de las últimas 24 h, por la fecha del archivo, antes de abrirlo) cerró el
  // paso 8 se trata como un marcador cerrado: si su rama tiene pedidos abiertos, sale «Entrando a los repos».
  const closures = latestClosures(path.join(sdir, 'timing-history'), nowMs, unreadable);
  for (const [sid, m] of closures) {
    if (busy.has(sid) || !liveName(sid)) continue;
    // el worktree de la story se borra al mergear: si su carpeta ya no existe, la story entró (no es un problema)
    if (typeof m.repoPath === 'string' && path.isAbsolute(m.repoPath) && !fs.existsSync(m.repoPath)) continue;
    const entering = enteringState(m, opts.prs, unreadable, wanted, gitCtx);
    if (!entering) continue;
    busy.add(sid);
    let title;
    try { title = storyTitle(m.storyPath); } catch (e) {
      title = '(título ilegible)';
      unreadable.push(`${m.storyPath || '(sin ruta de story)'}: ${e.code === 'ENOENT' ? 'no existe' : e.message}`);
    }
    pipeRows.set(sid, { i: rows.length, m });
    addRow({ work: `${m.storyId || '?'} · ${cut(title, TITLE_MAX)}`, state: entering, end: enteringEnd(m, storyEntry(m, gitCtx), nowMs), session: liveName(sid), folder: folderOf(sid, m.repoPath) }, sid);
  }

  if (stale) unreadable.push(`${stale} marcador(es) sin tocar hace más de 24 h: no cuentan (marker.js list-all los descarta)`);
  if (staleWaiting) unreadable.push(`${staleWaiting} story(s) con el pipeline cerrado hace más de 24 h y la sesión viva: no consulté sus pedidos`);

  for (const file of jsonFiles(path.join(sdir, 'adhoc'), unreadable)) {
    const sid = path.basename(file, '.json');
    let a;
    try { a = readObject(file); } catch (e) { unreadable.push(`${file}: ${e.message}`); continue; }
    busy.add(sid);
    const work = cut(String(a.reason || '(sin motivo)'), TITLE_MAX);
    // con una story en curso, el arreglo rápido es lo que hace mientras tanto: no abre otra fila
    const pipe = pipeRows.get(sid);
    if (pipe) { rows[pipe.i].meanwhile = `arreglo rápido «${work}»`; continue; }
    const label = liveName(sid);
    if (label) {
      // Desde cuándo no se toca: pasada 1 h, pregunta si terminó y dice cómo cerrarlo desde su sesión (no lo borra).
      const last = [a.lastTouch, a.declaredAt].map((v) => Date.parse(v)).find(Number.isFinite);
      const parts = ['Trabajo suelto'];
      if (last !== undefined) parts.push(`sin tocar desde ${hhmm(last)}`);
      if (last !== undefined && nowMs - last > LOOSE_STALE_MS) parts.push(`¿terminó? cerralo desde su sesión: node ${MARKER_JS} adhoc clear`);
      addRow({ work, state: parts.join(' · '), end: 'sin estimación (no tiene pasos)', session: label, folder: folderOf(sid) }, sid);
    }
    else {
      // Se limpia con `adhoc clear-orphan`, que sólo borra pasadas las 24 h sin tocarse: antes, se dice desde cuándo.
      let touched = [a.lastTouch, a.declaredAt].map((v) => Date.parse(v)).find(Number.isFinite);
      if (touched === undefined) {
        try { touched = fs.statSync(file).mtimeMs; } catch (e) {
          unreadable.push(`${file}: sin fecha legible (${e.message})`);
          halfway.push(`ad-hoc «${work}» · ${nameOf(sid)} · fecha ilegible: no se sabe desde cuándo se puede limpiar`);
          continue;
        }
      }
      const how = nowMs - touched > STALE_MS
        ? `limpiar: node ${MARKER_JS} adhoc clear-orphan ${sid}`
        : `se podrá limpiar después de las ${hhmm(touched + STALE_MS)}`;
      halfway.push(`ad-hoc «${work}» · ${nameOf(sid)} · ${how}`);
    }
  }

  // Lo que anota una sesión sin story (`marker.js doing`): no es un permiso, sólo dice qué hace. Con una story en curso
  // es lo que hace mientras tanto, si un ad-hoc no lo dijo antes; sin story, un ad-hoc de la misma sesión manda.
  for (const file of jsonFiles(path.join(sdir, 'doing'), unreadable)) {
    const sid = path.basename(file, '.json');
    const pipe = pipeRows.get(sid);
    if (busy.has(sid) && !pipe) continue;
    let d;
    try { d = readObject(file); } catch (e) { unreadable.push(`${file}: ${e.message}`); continue; }
    const work = cut(String(d.text || '(sin texto)'), TITLE_MAX);
    if (pipe) { if (!rows[pipe.i].meanwhile) rows[pipe.i].meanwhile = work; continue; }
    const at = Date.parse(d.at);
    const label = liveName(sid);
    if (!label) {
      // como el ad-hoc: se borra con `doing clear-orphan`, que sólo borra pasadas las 24 h sin tocarse
      let touched = at;
      if (!Number.isFinite(touched)) { try { touched = fs.statSync(file).mtimeMs; } catch { touched = nowMs; } }
      const how = nowMs - touched > STALE_MS ? `borrar: node ${MARKER_JS} doing clear-orphan ${sid}` : `se podrá borrar después de las ${hhmm(touched + STALE_MS)}`;
      halfway.push(`nota «${work}» · ${nameOf(sid)} · ${how}`);
      continue;
    }
    busy.add(sid);
    const parts = ['Anotado por la sesión'];
    if (Number.isFinite(at)) parts.push(`sin tocar desde ${hhmm(at)}`);
    if (Number.isFinite(at) && nowMs - at > LOOSE_STALE_MS) parts.push(`¿terminó? borrala desde su sesión: node ${MARKER_JS} doing clear`);
    addRow({ work, state: parts.join(' · '), end: 'sin estimación (no tiene pasos)', session: label, folder: folderOf(sid) }, sid);
  }

  // sin arreglo ni nota: si lo último que tocó la sesión está en un repo que no es de su story, eso hace mientras tanto
  for (const [sid, { i, m }] of pipeRows) {
    if (rows[i].meanwhile) continue;
    let place = null;
    for (const file of touchedOf(sid)) { place = touchedPlace(file, gitCtx, unreadable); if (place) break; }
    if (place && !ofStory(m, gitCtx)(place.root, place.branch) && place.story !== String(m.storyId || '')) rows[i].meanwhile = place.work;
  }

  const free = [];
  const noData = [];
  const idle = [];
  let internal = 0;
  for (const [sid, s] of sessions) {
    if (s.alive && s.internal && !busy.has(sid)) { internal += 1; continue; }
    if (!s.alive || busy.has(sid)) continue;
    const label = s.name || shortId(sid);
    if (s.busy || (s.last != null && nowMs - s.last < WORKING_MS)) {
      // lo que hace sale del último archivo que tocó dentro de un repo; sin uno, de la carpeta donde arrancó
      let place = null;
      const files = touchedOf(sid);
      for (const file of files) {
        place = touchedPlace(file, gitCtx, unreadable);
        if (place) break;
      }
      const story = (place && place.story) || (s.cwd && storyBranch(s.cwd, gitCtx, unreadable));
      // sin archivo en un repo ni story, y con la carpeta de arranque en la rama principal de su repo, no se sabe qué
      // hace: se dice en llano, con el motivo, en lugar de «<repo> · main», que dice lo mismo para todas
      const startBranch = s.cwd ? branchAt(s.cwd, gitCtx, unreadable) : '';
      const unknown = !place && !story && MAIN_BRANCHES.includes(startBranch);
      const why = unknown && (files.length ? 'los archivos que tocó no están en un repo' : `no tocó archivos en las últimas ${IDLE_MS / 3600000} h`);
      const parts = ['Trabajando sin pipeline', why, story && `story ${story} en preparación`, s.last != null && `última actividad ${hhmm(s.last)}`].filter(Boolean);
      addRow({ work: place ? place.work : unknown ? 'no se ve qué hace' : sessionPlace(s.cwd, gitCtx, unreadable), state: parts.join(' · '), end: 'sin estimación (no tiene pasos)', session: label, folder: place ? tilde(place.root) : tilde(s.cwd) }, sid);
    } else if (s.last == null) { free.push(label); noData.push(label); }
    else if (nowMs - s.last > IDLE_MS) idle.push(`${label} (desde ${hhmm(s.last)})`);
    else free.push(label);
  }
  const details = rowSids.map((sid) => {
    const s = sessions.get(sid);
    return { sid, status: s ? s.status : null, nameSource: s ? s.nameSource : null };
  });
  return { rows, details, free, idle, halfway, unreadable, wanted, internal, text: render(rows, free, noData, idle, halfway, unreadable, internal) };
}

function render(rows, free, noData, idle, halfway, unreadable, internal = 0) {
  const esc = (s) => oneLine(s).replace(/\|/g, '\\|');
  const lines = ['| Trabajo | Estado | Fin estimado | Sesión | Carpeta |', '|---|---|---|---|---|'];
  if (!rows.length) lines.push('| (nada en curso) | | | | |');
  for (const r of rows) lines.push(`| ${esc(r.work)} | ${esc(r.meanwhile ? `${r.state} · mientras tanto: ${r.meanwhile}` : r.state)} | ${esc(r.end)} | ${esc(r.session)} | ${esc(r.folder || '')} |`);
  const freeText = free.map((f) => (noData.includes(f) ? `${f} (sin dato de actividad)` : f));
  lines.push('', `Libres: ${freeText.length ? freeText.join(', ') : 'ninguna'}`);
  if (idle.length) lines.push(`Sin uso hace más de ${IDLE_MS / 3600000} h: ${idle.join(', ')}`);
  if (internal) lines.push(`${internal} agente(s) interno(s) de otras sesiones (sin fila: corren en la carpeta temporal, sin nombre puesto)`);
  if (halfway.length) lines.push('', `Quedaron a medio camino (sesión cerrada o sin rastro): ${halfway.length}`, ...halfway.map((h) => `- ${h}`));
  if (unreadable.length) lines.push('', 'No se pudo leer:', ...unreadable.map((u) => `- ${u}`));
  return lines.join('\n');
}

// Los pedidos abiertos de UNA story, para el cartel de la corrida: se ve qué preguntar, se pregunta todo junto y se
// vuelve a armar con las respuestas, como la tabla. `failed` dice que alguna consulta no contestó.
async function storyEntering(m, { query = queryAll, budgetMs = GIT_BUDGET_MS } = {}) {
  const ctx = { until: Date.now() + budgetMs, cache: new Map() };
  const wanted = [];
  enteringState(m, null, [], wanted, ctx);
  const unique = [...new Map(wanted.map((q) => [q.root, q])).values()];
  const answers = unique.length ? await query(unique) : [];
  const byRoot = new Map(unique.map((q, i) => [q.root, answers[i]]));
  const unreadable = [];
  const prs = [];
  enteringState(m, (q) => byRoot.get(q.root), unreadable, [], ctx, prs);
  return { prs, failed: unreadable.length > 0, unreadable };
}

async function main(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--marker') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) { process.stderr.write(`work-in-progress.js: ${a} pide un valor\n`); return 2; }
      opts.marker = v;
    }
    else if (['--state-dir', '--sessions-dir', '--projects-dir', '--now'].includes(a)) {
      const v = argv[++i];
      if (!v || v.startsWith('--')) { process.stderr.write(`work-in-progress.js: ${a} pide un valor\n`); return 2; }
      opts[{ '--state-dir': 'stateDir', '--sessions-dir': 'sessionsDir', '--projects-dir': 'projectsDir', '--now': 'now' }[a]] = v;
    } else { process.stderr.write(`work-in-progress.js: opción desconocida ${a}\n`); return 2; }
  }
  if (opts.marker) {
    let m;
    try { m = JSON.parse(fs.readFileSync(opts.marker, 'utf8')); } catch (e) {
      process.stderr.write(`work-in-progress.js: no pude leer el marcador ${opts.marker}: ${e.message}\n`);
      return 2;
    }
    process.stdout.write(`${JSON.stringify(await storyEntering(m && typeof m === 'object' ? m : {}))}\n`);
    return 0;
  }
  opts.gitCtx = { until: Date.now() + GIT_BUDGET_MS, cache: new Map() };
  let r;
  try { r = buildWip(opts); } catch (e) {
    if (e.code === 'NO_STATE' || e.code === 'BAD_ARG') { process.stderr.write(`work-in-progress.js: ${e.message}\n`); return 2; }
    throw e;
  }
  // Primero se ve qué preguntar; las preguntas van todas juntas y la tabla se arma otra vez con las respuestas.
  if (r.wanted.length) {
    const unique = [...new Map(r.wanted.map((q) => [q.root, q])).values()];
    const answers = await queryAll(unique);
    const byRoot = new Map(unique.map((q, i) => [q.root, answers[i]]));
    r = buildWip({ ...opts, prs: (q) => byRoot.get(q.root) });
  }
  process.stdout.write(opts.json ? `${JSON.stringify(jsonOf(r), null, 2)}\n` : `${r.text}\n`);
  return 0;
}

// La salida de --json: cada fila con la sesión que la trae (su id, su estado y de dónde salió su nombre).
function jsonOf(r) {
  const rows = r.rows.map((row, i) => ({ ...row, ...((r.details && r.details[i]) || {}) }));
  return { rows, free: r.free, idle: r.idle, halfway: r.halfway, unreadable: r.unreadable };
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`work-in-progress.js: ${e && e.stack ? e.stack : e}\n`);
    process.exitCode = 1;
  });
}

module.exports = { buildWip, jsonOf, sessionsBySid, storyEntering, median, queryAll, parseRemote, shellSafe, PER_QUERY_MS, ALL_QUERIES_MS };
