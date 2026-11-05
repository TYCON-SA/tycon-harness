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
 * «atrasada (estimado HH:MM)»; nunca corre con el reloj. marker.js la anota al entrar a cada paso (`horaDelPaso`), y es
 * ésa aunque cambien las medianas; una hora vencida dice «vieja (de las HH:MM)» si se calculó hace más de una hora, o
 * «sin hora: el trabajo cambió» si además la corrida lleva una hora sin actividad. Si algún paso que falta no tiene
 * mediana, no hay hora: se dice cuál. Un repo sin merges medidos queda afuera de la hora, y se dice.
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
 * para `marker.js list-all`, que lo descarta; acá sólo se dice cuántos hay, sin borrarlos. Salvo el dejado a propósito
 * (`marker.js park`, o `paused_until:` en la historia): se sigue viendo con esa marca, sin hora y sin «limpiar».
 *
 * La columna «Estado» suma el estado real de la sesión, el mismo que dibuja /office: parada desde cuándo, o «Tu firma» con
 * lo que espera (`realState`). Una corrida terminada, sin pedidos y con cambios sin commitear en sus repos espera el ok de
 * guardar, aunque su sesión esté cerrada: lo dice el árbol del repo, no la falta de `saveOk`.
 *
 * Excepción: si cerró el paso 8 y su sesión sigue viva (de sus cierres cuenta el que cerró último), la story puede estar esperando entrar a los repos (la CI, la
 * cola, un pedido en borrador). Se buscan sus repos (`repoPath` y la raíz git de cada archivo tocado, salvo los que
 * están en su rama principal) y se pregunta por los pedidos abiertos de su rama a la capa de plataforma
 * (`platform.js change-request list`, lanzada como proceso, con la identidad del repo que sale de `origin`). Con alguno
 * abierto, o con una consulta que no contestó, sale como «Entrando a los repos» y la sesión no cuenta como libre; pasada
 * la hora estimada, dice desde cuándo espera. Un repo tocado cuenta si está en la rama del repo de la story o en una que
 * la nombra: una carpeta compartida que hoy está en la rama de otra story no es de ésta. Las consultas corren en
 * paralelo, 15 s cada una y 20 s todas juntas (`az` tarda cuando renueva su permiso): lo que no contesta, o un «no» de
 * la capa con su motivo, se dice al pie y la tabla sale igual.
 *
 * Una fila por sesión: con una story en curso o esperando entrar, esa story es lo principal, y lo otro que hace la
 * sesión sale como «mientras tanto»: su arreglo rápido, su nota, o el repo de lo último que tocó si no es de la story.
 *
 * Sólo lee. No toca marcadores ni sesiones y no lee el contenido de ninguna transcripción; la configuración de la
 * organización la lee la capa, no este programa.
 *
 * Uso:  node scripts/tools/work-in-progress.js [--json] [--state-dir <dir>] [--sessions-dir <dir>] [--projects-dir <dir>] [--now <iso>]
 *       node scripts/tools/work-in-progress.js --marker <archivo>   (los pedidos abiertos de esa story, en JSON:
 *       `{ prs: [{ repo, ref, draft, conflict }], failed, unreadable }`; lo usa el cartel de la corrida)
 * Sale: 0 con la tabla (aunque haya ilegibles: se dicen) · 2 si no existe la carpeta de estado.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PLATFORM = path.join(ROOT, 'scripts', 'lib', 'platform', 'platform.js');
const { stateDir, claudeDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
const { stepName, isDone, byId, schemeOf, pendingSteps, STEPS } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'steps.js'));
const { tiempos } = require(path.join(ROOT, 'scripts', 'metrics', 'step-times.js'));
const { parsePipelinesBlock } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'story-checks.js'));

const TITLE_MAX = 50;
const STALE_MS = 24 * 3600 * 1000;
// una sesión con actividad más nueva que esto está trabajando aunque su archivo diga `idle` (entre dos pedidos)
const WORKING_MS = 5 * 60 * 1000;
// una sesión sin actividad hace más que esto no se ofrece como libre: el proceso vive, pero nadie la usa
const IDLE_MS = 3 * 3600 * 1000;
// un trabajo suelto sin tocar hace más que esto pregunta si terminó
const LOOSE_STALE_MS = 3600 * 1000;
// una espera anotada hace más que esto no le gana a la sesión ocupada: está trabajando, no esperando
const WAIT_OUTLIVED_MS = 5 * 60000;
// una sesión quieta que tocó un archivo hace menos que esto sigue con algo: no está libre
const RECENT_FILE_MS = 30 * 60 * 1000;
const MARKER_JS = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'marker.js');
const shortId = (sid) => String(sid || '').slice(0, 8) || '?';
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
// texto de afuera (una nota, un registro de otra herramienta) para mostrar: en una línea, sin caracteres de control, acotado
const shown = (s, n = 160) => oneLine(String(s == null ? '' : s).replace(/[\p{Cc}\p{Cf}]/gu, ' ')).slice(0, n);
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

// La tanda que corre de una story con tandas: el `title:` de la única entrada `status: in-progress` del bloque
// `pipelines:`. Sin una sola en curso, o sin `title:`, null (la tarjeta dice el título de la story).
function storyBatch(storyPath) {
  let text;
  try { text = fs.readFileSync(storyPath, 'utf8'); } catch { return null; }
  // el bloque `pipelines:` se lee con el mismo lector que el resto del arnés: lista o mapa, con comentarios y renglones
  // en blanco
  const running = parsePipelinesBlock(text).filter((p) => p.status === 'in-progress');
  return running.length === 1 && running[0].title ? running[0].title : null;
}

// ── La marca de una corrida dejada a propósito («en fila» o «en pausa») ──────────────────────────────────────────────
// `<estado>/parked/<sesión>.json`, que escribe `marker.js park`: `{story, kind: queue | until, until, at, by}`. Vale para
// esa historia, y sólo para la corrida que ya estaba cuando se marcó. Una historia con `paused_until:` dice lo mismo.
const QUEUE_MARK = 'En fila para pruebas';
function readParked(sdir, unreadable) {
  const out = new Map();
  for (const file of jsonFiles(path.join(sdir, 'parked'), unreadable)) {
    try { out.set(path.basename(file, '.json'), readObject(file)); } catch (e) { unreadable.push(`${file}: ${e.message}`); }
  }
  return out;
}
const localYmd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// La fecha de `paused_until:` de una historia, o null. Una historia que no se puede leer no dice que no está en pausa: el
// motivo queda en `unreadable`, si viene.
function storyPausedUntil(storyPath, unreadable) {
  if (typeof storyPath !== 'string' || !storyPath) return null;
  try {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(storyPath, 'utf8'));
    const line = fm && /^paused_until:[ \t]*["']?(\d{4}-\d\d-\d\d)/m.exec(fm[1]);
    return line ? line[1] : null;
  } catch (e) {
    if (unreadable && !ABSENT_FILE.includes(e && e.code)) unreadable.push(`${storyPath}: no pude ver si está en pausa (${(e && e.code) || (e && e.message)})`);
    return null;
  }
}
// Lo que dice una corrida marcada, o null. La fecha pasada no la saca: dice que venció y se sigue viendo.
function markOf(m, sid, parked, nowMs, unreadable) {
  const mark = parked.get(String(sid).replace(/[/\\]/g, '_'));
  const started = Date.parse(m.startedAt);
  const marked = mark && String(mark.story) === String(m.storyId) && !(Number.isFinite(started) && Date.parse(mark.at) < started) ? mark : null;
  if (marked && marked.kind === 'queue') return QUEUE_MARK;
  const until = marked && typeof marked.until === 'string' ? marked.until : storyPausedUntil(m.storyPath, unreadable);
  if (!until) return null;
  const [, mo, da] = until.split('-');
  return localYmd(nowMs) > until ? `En pausa: venció el ${da}/${mo}` : `En pausa hasta el ${da}/${mo}`;
}

// La columna «Fin estimado» del arreglo rápido y de la nota: la hora que declaró la sesión (`raw`, ya leída en `ms`).
// Una hora escrita que no se puede leer se dice; no se confunde con no haber declarado ninguna.
function declaredEnd(raw, ms) {
  if (Number.isFinite(ms)) return `${hhmm(ms)} (la declaró la sesión)`;
  return raw == null || raw === '' ? 'sin estimación (no tiene pasos)' : 'hora declarada ilegible';
}

// Medianas en ms por id de paso, de los pasos medidos y sin fusionar de las corridas archivadas. Con `memory` no se releen
// mientras la carpeta no cambie: son más de mil archivos, y una ejecución archivada es un archivo nuevo.
function stepMedians(dir, unreadable, memory) {
  let stamp = null;
  if (memory) { try { stamp = fs.statSync(dir).mtimeMs; } catch { /* sin carpeta: lo dice jsonFiles */ } }
  const kept = memory && stamp !== null && memory.medians && memory.medians.stamp === stamp ? memory.medians : null;
  if (kept) {
    if (kept.note) unreadable.push(kept.note);
    return kept.out;
  }
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
  const note = broken ? `${broken} ejecución(es) archivada(s) en ${dir}: no se pudieron leer` : null;
  if (note) unreadable.push(note);
  const out = {};
  for (const [k, v] of Object.entries(samples)) out[k] = median(v);
  // Un paso por nombre de máquina sin ejecuciones propias todavía usa la mediana de su equivalente viejo.
  // El 4 viejo era implementar y correr las pruebas: va entero a Implementar y Correr las pruebas suma 0, sin repartir.
  const sum = (...ks) => (ks.every((k) => out[k] != null) ? ks.reduce((a, k) => a + out[k], 0) : undefined);
  const viejo = { start: sum('0'), 'validate-story': sum('1'), plan: sum('2'), 'approve-plan': sum('3'), implement: sum('4'),
    'run-tests': out['4'] != null ? 0 : undefined, reviewers: sum('5'), findings: sum('6', '7'), 'prepare-commit': sum('8') };
  for (const [k, v] of Object.entries(viejo)) if (out[k] == null && v !== undefined) out[k] = v;
  if (memory && stamp !== null) memory.medians = { stamp, out, note };
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
    const cur = { name: name || null, pid, alive, busy: s.status === 'busy' || s.status === 'shell', status: typeof s.status === 'string' ? s.status : null, waitingFor: typeof s.waitingFor === 'string' ? oneLine(s.waitingFor).slice(0, 80) : null, statusAt: Number(s.statusUpdatedAt) || null, nameSource: typeof s.nameSource === 'string' ? s.nameSource : null, kind: typeof s.kind === 'string' ? s.kind : null, jobId: typeof s.jobId === 'string' ? s.jobId : null, startedAt: Number(s.startedAt) || null, cwd, last: dates.length ? Math.max(...dates) : null, internal: isInternalAgent(cwd, s.nameSource) };
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

// Los pasos que cuentan para la hora: los que se dan por hechos con una bandera (el pase adversarial, la prueba en vivo)
// no tienen mediana propia, y su tiempo cae en el paso que acompañan, como los sub-pasos viejos.
const pendingForHour = (marker) => (marker.stepsPending || []).map(String).filter((s) => !(byId(s) && (byId(s).flag || !byId(s).number)));
// `horaDelPaso` si es del paso en curso y se puede leer: `{ at, computedAt }` en milisegundos; si no, null.
function hourOfStep(marker) {
  const h = marker && marker.horaDelPaso;
  if (!h || typeof h !== 'object' || String(h.step) !== pendingForHour(marker)[0]) return null;
  const at = Date.parse(h.at);
  return Number.isFinite(at) ? { at, computedAt: Date.parse(h.computedAt) } : null;
}

// Lo que se dice en lugar de la hora cuando ya no dice nada: la del trabajo que cambió (vencida hace rato en una corrida
// sin actividad en la última hora) o la que se calculó o declaró hace más de una hora. null: la hora vale, y si pasó, es
// atraso. Sin fechas no se juzga.
const WORK_CHANGED = 'sin hora: el trabajo cambió';
const OVERDUE_HOUR = 'se pasó de la hora';
function hourVerdict({ endAt, hourAt, activityAt, nowMs, run = false }) {
  if (!Number.isFinite(endAt) || endAt >= nowMs) return null;
  const oldHour = Number.isFinite(hourAt) && nowMs - hourAt > LOOSE_STALE_MS;
  if (run && Number.isFinite(activityAt) && nowMs - activityAt > LOOSE_STALE_MS && (oldHour || nowMs - endAt > LOOSE_STALE_MS)) return WORK_CHANGED;
  return oldHour ? OVERDUE_HOUR : null;
}

// La hora es fija: arranque del paso en curso + su mediana + las de los pasos que faltan + la entrada a los repos.
// Pasado el estimado del paso en curso, dice «atrasada» con esa hora; nunca corre con el reloj (si corriera, un paso
// pasado de su mediana mostraría la hora actual y escondería el atraso).
// En `info`, si viene, quedan la hora en milisegundos (`at`) y si está atrasada (`late`).
// Con la hora que marker.js anotó al entrar a este paso (`horaDelPaso`), es ésa: misma entrada, misma hora, aunque cambien
// las medianas. En `info` quedan además cuándo se calculó (`computedAt`) y el paso (`step`).
function estimateEnd(marker, medians, nowMs, entry, info = {}) {
  const pending = pendingForHour(marker);
  if (!pending.length) return 'sin datos (no quedan pasos)';
  const current = pending[0];
  const fixedHour = hourOfStep(marker);
  if (fixedHour) {
    info.at = fixedHour.at;
    info.computedAt = fixedHour.computedAt;
    info.step = current;
    info.late = nowMs > fixedHour.at;
    return nowMs > fixedHour.at ? `atrasada (estimado ${hhmm(fixedHour.at)})` : hhmm(fixedHour.at);
  }
  const missing = pending.find((s) => medians[s] == null);
  if (missing !== undefined) return `sin datos (${stateOf(missing)})`;
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
  info.at = fixed;
  info.late = nowMs > currentEnd;
  if (nowMs > currentEnd) return `atrasada (estimado ${hhmm(fixed)}${approx ? ', aprox.' : ''})`;
  return `${hhmm(fixed)}${approx ? ' (aprox.)' : ''}${entryNote(entry)}`;
}

/**
 * La hora de fin de un marcador, la misma que muestra la tabla: `{ endAt }` en milisegundos, o `{ endAt: null,
 * endWithoutHour }` con el motivo. Para quien la anota en el archivo de estado de la sesión (scripts/lib/session-state.js).
 */
function endOf(marker, opts = {}) {
  const home = opts.home || os.homedir();
  const sdir = opts.stateDir || stateDir(home);
  const nowMs = Number.isFinite(opts.now) ? opts.now : Date.now();
  // con la hora anotada de este paso no hace falta leer la historia de la máquina ni los repos
  if (hourOfStep(marker)) return { endAt: hourOfStep(marker).at, endWithoutHour: null };
  const medians = stepMedians(path.join(sdir, 'timing-history'), []);
  const info = {};
  const ctx = { until: Date.now() + GIT_BUDGET_MS, cache: new Map() };
  const entry = storyEntry(marker, ctx);
  const text = estimateEnd(marker, medians, nowMs, entry, info);
  return info.at == null ? { endAt: null, endWithoutHour: text } : { endAt: info.at, endWithoutHour: null, partial: Boolean(ctx.gitTimedOut) };
}

/**
 * La hora de este paso para anotar en el marcador (`horaDelPaso`), que marker.js escribe al arrancar o cerrar un paso:
 * la que ya estaba si es del paso en curso (queda fija hasta el próximo), la nueva si no, y null sin paso o sin datos.
 */
function hourForStep(marker, opts = {}) {
  const step = pendingForHour(marker)[0];
  if (step === undefined) return null;
  if (hourOfStep(marker)) return marker.horaDelPaso;
  const { endAt, partial } = endOf({ ...marker, horaDelPaso: null }, opts);
  // (un repo sin merges no cuenta: ahí no hay más dato que esperar)
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  // una hora calculada sin la entrada a un repo (git no contestó a tiempo) no se fija para todo el paso
  return endAt == null || partial ? null : { step, at: new Date(endAt).toISOString(), computedAt: new Date(now).toISOString() };
}

// La story que cerró el paso 8 y espera sus pedidos: el cierre del 8 más la entrada a los repos.
function enteringEnd(marker, entry, nowMs, info = {}) {
  if (!entry || !entry.repos || entry.missing.length) {
    return `sin estimación (espera la CI o la cola; sin merges medidos en ${entry && entry.missing.length ? entry.missing.join(', ') : 'sus repos'})`;
  }
  const t8 = (marker.stepTimings || {})['prepare-commit'] || (marker.stepTimings || {})['8'];
  const done = Date.parse(t8 && t8.completedAt);
  if (!Number.isFinite(done)) return 'sin estimación (espera la CI o la cola; sin la hora de cierre de «Preparar el commit»)';
  const fixed = done + entry.ms;
  info.at = fixed;
  info.late = nowMs > fixed;
  // pasada la hora, no está atrasada: espera la CI o la cola, y se dice desde cuándo
  return nowMs > fixed ? `esperando entrar desde ${hhmm(done)} (estimado ${hhmm(fixed)})` : `${hhmm(fixed)}${entryNote(entry)}`;
}

const ENTERING = 'Entrando a los repos';
const STALLED = 'Pedidos sin encolar';
const SAVE_WAITS = 'Terminó: espera el ok para guardar';
const SAVE_OK = 'Terminó: ya tiene el ok para guardar';
const WAITING_STATUS = /wait|input|permission/i;
// cómo anota una sesión que abrió una pregunta (scripts/hooks/session-state.js), y cómo se dice
const ANSWER_DIALOG = 'una respuesta';
const ANSWER_WAIT = 'tu respuesta en su pantalla';
const TESTING_STEPS = new Set(['run-tests', 'reviewers', 'adversarial-pass', 'live-check']);

/**
 * El estado real de una sesión con trabajo: `{ estado, parada?, espera? }`, de lo que dice la herramienta y no del paso.
 * `x` es lo que la fila sabe de su trabajo, `d` lo que dice el archivo de sesión de Claude (`status`, `statusAt`) y `f` el
 * archivo de estado de la sesión. La espera anotada manda sobre «ocupada»: quien pide un permiso espera. Sin un estado
 * legible, sale por su paso y no cuenta como parada.
 */
function realState(x, d, f) {
  // un cuadro abierto: un permiso o un plan piden tu firma, y una pregunta sólo tu respuesta
  const plan = x.kind === 'pipeline' && x.current === 'approve-plan';
  // un permiso anotado lo confirma Claude cuando dice el estado: si no la da esperando, se negó o ya siguió
  const permissionGone = Boolean(f && f.permission && d && typeof d.status === 'string' && d.status && !WAITING_STATUS.test(d.status));
  if (f && f.waitingForOwner && !permissionGone) return f.waitingFor === ANSWER_DIALOG && !plan ? { estado: 'pregunta', espera: ANSWER_WAIT } : { estado: 'firma', espera: plan ? 'que apruebes el plan' : f.waitingFor || 'algo de vos' };
  if (d && d.status && WAITING_STATUS.test(d.status)) {
    if (/permission/i.test(d.status) || /permission/i.test(String(d.waitingFor || '')) || plan) return { estado: 'firma', espera: plan ? 'que apruebes el plan' : ANSWER_WAIT };
    // sin un cuadro abierto, lo que la sesión anotó que espera (un turno, otra sesión) dice más que «esperando»
    if (x.waitingFor) return { estado: 'espera', espera: shown(x.waitingFor, 120) };
    return { estado: 'pregunta', espera: ANSWER_WAIT };
  }
  const codex = Boolean(f && f.tool === 'codex');
  const status = d && d.status;
  const busy = codex ? (typeof f.busy === 'boolean' ? f.busy : null) : status === 'busy' || status === 'shell' ? true : status === 'idle' ? false : null;
  if (x.kind === 'entering' || x.kind === 'stalled') return { estado: 'espera' };
  // terminada sin nada que guardar (`nothingToSave`: una marcada con el árbol limpio) no espera ningún ok
  if (x.kind === 'finished') return busy === false && !x.saveOk && !x.nothingToSave ? { estado: 'firma', espera: 'el ok para guardar' } : { estado: 'trabajando' };
  if (busy === false) {
    if (x.kind === 'pipeline' && x.current === 'approve-plan') return { estado: 'firma', espera: 'que apruebes el plan' };
    const at = codex ? Date.parse(f.updatedAt) : Number(d && d.statusAt);
    return { estado: 'parada', parada: Number.isFinite(at) && at > 0 ? `parada desde las ${hhmm(at)}` : 'parada' };
  }
  return { estado: x.kind === 'pipeline' && TESTING_STEPS.has(x.current) ? 'prueba' : 'trabajando' };
}

// ¿El trabajo de ahora (un arreglo o una nota, fresco y posterior a su última actividad) tapa a esta corrida abierta?
const replacedByNewer = (x, nowMs) => x.kind === 'pipeline' && Number.isFinite(x.meanwhileAt) && Number.isFinite(x.activityAt) && x.meanwhileAt > x.activityAt && nowMs - x.meanwhileAt <= LOOSE_STALE_MS;

// ¿Le quedan cambios sin commitear a los repos de la corrida? La señal de que espera el ok de guardar: guardar se autoriza
// en la ventana de permiso, así que la falta de `saveOk` no dice nada. La carpeta de la corrida (`.advisors/`) no es
// trabajo sin guardar. `{ dirty, problems }`: un repo que no se puede leer no dice que espera. La carpeta de la corrida
// puede estar en otra rama, con el trabajo de otro: en la principal o en la de otra historia, sus cambios no son de ésta.
function unsavedChanges(m, ctx) {
  const mine = ofStory(m, ctx);
  const id = m.storyId ? String(m.storyId) : '';
  const failures = [];
  const problems = [];
  let dirty = false;
  const roots = storyRepos(m, failures, ctx);
  // la carpeta que ya no está es la de una historia que entró (se borra al mergear): no es un problema
  for (const f of failures) if (!/: ya no existe$/.test(f)) problems.push(f);
  for (const root of roots) {
    const repo = repoOf(root, ctx);
    if (repo && repo.err) { problems.push(`${path.basename(root)}: ${repo.err}`); continue; }
    const head = repo ? branchOf(repo) : null;
    if (head && head.err) { problems.push(`${path.basename(root)}: ${head.err}`); continue; }
    if (!head || !mine(root, head.branch) || MAIN_BRANCHES.includes(head.branch)) continue;
    const named = storyOfBranch(head.branch);
    if (named && id && named !== id) continue;
    const st = git(root, ['--no-optional-locks', 'status', '--porcelain', '-z'], ctx);
    if (st.err) { problems.push(`${path.basename(root)}: ${st.err}`); continue; }
    if (changesOutsideRun(st.out)) dirty = true;
  }
  return { dirty, problems };
}
// `git status --porcelain -z`: cada entrada termina en NUL, sin citar la ruta; un renombre o una copia traen además su origen.
function changesOutsideRun(out) {
  const entries = String(out).split('\0');
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (!e.trim()) continue;
    const status = /^\s*(\S+)\s/.exec(e);
    if (!e.replace(/^\s*\S+\s+/, '').startsWith('.advisors/')) return true;
    if (status && /[RC]/.test(status[1]) && !String(entries[++i] || '').startsWith('.advisors/')) return true;
  }
  return false;
}
// Los archivos con cambios de esa misma salida, sin contar los de la propia corrida.
function changedFiles(out) {
  const entries = String(out).split('\0');
  let n = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (!e.trim()) continue;
    const status = /^\s*(\S+)\s/.exec(e);
    if (status && /[RC]/.test(status[1])) i += 1;
    if (!e.replace(/^\s*\S+\s+/, '').startsWith('.advisors/')) n += 1;
  }
  return n;
}
const closedAtOf = (m) => {
  const t8 = (m.stepTimings || {})['prepare-commit'] || (m.stepTimings || {})['8'];
  return [t8 && t8.completedAt, m.lastTouch].map((v) => Date.parse(v)).find(Number.isFinite) || null;
};
// el fin de una story con el paso 8 cerrado: sin un pedido en la cola no hay hora que estimar
const closedEnd = (state, m, entry, nowMs, info) => (state.startsWith(STALLED) ? 'sin estimación (ningún pedido está en la cola: hay que encolarlo)' : enteringEnd(m, entry, nowMs, info));

// La hora que la corrida prometió al arrancar, en milisegundos: su arranque más su estimado, los dos campos que el
// marcador guarda desde `pipeline.js start` (y reinicia al cambiar de historia). null si le falta alguno.
const promisedOf = (m) => {
  const t = Date.parse(m && m.startedAt);
  const min = m && Number(m.estimate_min);
  return Number.isFinite(t) && Number.isFinite(min) && min > 0 ? t + min * 60000 : null;
};

// Los pasos de una corrida, en orden, con los hechos marcados: para quien la dibuja (el comando /office).
function stagesOf(m) {
  const steps = STEPS.map((s) => ({ id: s.id, name: s.name, done: isDone(m, s.id) }));
  const current = steps.find((s) => !s.done);
  return { steps, current: current ? current.id : null, progress: Math.round((100 * steps.filter((s) => s.done).length) / steps.length) };
}
const MAIN_BRANCHES = ['main', 'master'];
const PER_QUERY_MS = 15000;
const ALL_QUERIES_MS = 20000;
const GIT_MS = 2000;
const GIT_BUDGET_MS = 3000;
const STATUS_KEEP_MS = 60 * 1000;

/**
 * Lo que un proceso que arma fotos seguido recuerda de una a la otra (`office/server.js`). Casi todo lo que se le pregunta a
 * git depende sólo de los commits, y se repite mientras no cambien. `git status` depende de los archivos, que no avisan: se
 * recuerda un rato, y por eso lo que dice puede atrasar hasta `statusKeepMs`. El de «A medio camino» no vence con el tiempo:
 * se vuelve a leer cuando alguien lo pide (`reviseHalfway`) o se cierra una sesión con la página abierta.
 */
const createMemory = ({ statusKeepMs = STATUS_KEEP_MS } = {}) => ({ git: new Map(), medians: null, statusKeepMs, halfwaySince: 0, halfwayReadAt: null, aliveSids: null, pageOpen: true });

/** Pide leer otra vez los archivos sin guardar de «A medio camino» en la próxima foto. */
const reviseHalfway = (memory) => { memory.halfwaySince = Date.now(); };

// Una sesión que estaba viva en la foto anterior y ya no: lo que dejó puede estar sin terminar. Con la página cerrada no se
// revisa nada: al abrirla se revisa igual.
function reviseIfSessionClosed(memory, sessions) {
  const alive = new Set([...sessions].filter(([, s]) => s.alive).map(([sid]) => sid));
  if (memory.pageOpen && memory.aliveSids && [...memory.aliveSids].some((sid) => !alive.has(sid))) reviseHalfway(memory);
  memory.aliveSids = alive;
}

// git con tope: `{ out }` si salió bien; si no, `{ err, status }` con el motivo. `ctx.until` es el tope de toda la
// lectura de repos y `ctx.cache` guarda lo leído, para que la segunda pasada no vuelva a preguntar. Con `ctx.memory`, lo
// que git ya contestó no se vuelve a preguntar mientras siga valiendo, y eso no gasta el tope. `ctx.halfway`: el `git status`
// de «A medio camino», que dura más que el de una tarjeta en curso y por eso se guarda aparte.
function git(dir, args, ctx) {
  const isStatus = args.includes('status');
  const forHalfway = isStatus && Boolean(ctx.halfway);
  const key = `${forHalfway ? 'medio\0' : ''}${dir}\0${args.join(' ')}`;
  if (ctx.cache.has(key)) return ctx.cache.get(key);
  const stamp = ctx.memory && !isStatus ? commitsStamp(dir, ctx) : null;
  const kept = ctx.memory ? ctx.memory.git.get(key) : null;
  const stillValid = () => {
    if (forHalfway) return kept.at > ctx.memory.halfwaySince;
    return isStatus ? Date.now() - kept.at < ctx.memory.statusKeepMs : stamp !== null && kept.stamp === stamp;
  };
  if (kept && stillValid()) {
    ctx.cache.set(key, kept.res);
    return kept.res;
  }
  if (Date.now() > ctx.until) { ctx.gitTimedOut = true; return { err: `se pasó del tope de ${GIT_BUDGET_MS / 1000} s leyendo los repos`, status: null }; }
  const res = gitNow(dir, args, Math.max(1, Math.min(GIT_MS, ctx.until - Date.now())));
  if (res.err && res.status == null) ctx.gitTimedOut = true;
  ctx.cache.set(key, res);
  if (forHalfway && ctx.memory) ctx.memory.halfwayReadAt = Date.now();
  // un git que no llegó a contestar no dice nada: no se recuerda
  if (ctx.memory && !(res.err && res.status == null)) ctx.memory.git.set(key, { res, stamp, at: Date.now() });
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

// Lo que dice en qué commits está el repo, leído de sus archivos: HEAD, las puntas que se preguntan y la fecha de
// `packed-refs`, donde git guarda las que no tienen archivo propio. null si no se puede saber: entonces no se recuerda nada.
function commitsStamp(dir, ctx) {
  const repo = repoOf(dir, ctx);
  if (!repo || repo.err) return null;
  const head = readText(path.join(repo.gitDir, 'HEAD'));
  if (head.text === undefined) return null;
  const { branch } = branchOf(repo);
  const refs = [...(branch ? [`refs/heads/${branch}`] : []), 'refs/remotes/origin/HEAD',
    ...['main', 'master'].flatMap((b) => [`refs/remotes/origin/${b}`, `refs/heads/${b}`])];
  const parts = [head.text.trim(), ...refs.map((r) => readText(path.join(repo.commonDir, r)).text || '')];
  try { parts.push(String(fs.statSync(path.join(repo.commonDir, 'packed-refs')).mtimeMs)); } catch { parts.push(''); }
  return parts.join('\0');
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

// Adónde apunta el `origin` de una carpeta, en la rama que sea: `parseRemote`, o null si no se sabe.
function remoteOfFolder(root) {
  const repo = repoOf(root, { until: Date.now() + GIT_BUDGET_MS, cache: new Map() });
  if (!repo || repo.err) return null;
  const origin = originOf(repo);
  return origin.url ? parseRemote(origin.url) : null;
}

// La identidad del repo para la capa de plataforma, sacada de su origin.
function identityOf(q) {
  if (q.kind === 'github') { const [org, repo] = q.slug.split('/'); return { platform: 'github', org, repo }; }
  return { platform: 'azure', org: q.org, project: q.project, repo: q.repo };
}

// Fuera de la cola: no es borrador, no tiene auto-completar y la plataforma dice que no está en la cola (`inQueue:
// false`) o no tiene cola (sin `inQueue`). Con `inQueue: null` la plataforma no supo decirlo: no se marca afuera, y
// el pedido sale con «(cola sin verificar)».
const offQueueOf = (p) => p.draft !== true && !p.autoComplete && (p.inQueue === false || !('inQueue' in p));

// Mata una consulta y lo que ella lanzó (el gh o el az del conector): fuera de Windows corre en su propio grupo.
function killQuery(child) {
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch { /* ya terminó */ }
}

// Una operación de la capa de plataforma lanzada como proceso: lo que devuelve `onValue` con su `value`, o `{ error }`. Un
// «no» de la capa trae su motivo.
function askLayer(args, perMs, env, children, onValue) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PLATFORM, ...args], { env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let out = '';
    let err = '';
    let late = false;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { late = true; killQuery(child); }, perMs);
    const done = (r) => { clearTimeout(timer); resolve(r); };
    const fail = (why) => done({ error: `la capa de plataforma: ${why}` });
    child.on('error', (e) => fail(`no arrancó (${e.code || e.message})`));
    child.on('close', (code) => {
      if (late) { fail(`se pasó del tope de ${perMs / 1000} s`); return; }
      let r;
      try { r = JSON.parse(out); } catch { fail(`respuesta ilegible (${oneLine(err || out).slice(0, 200) || `salió ${code}`})`); return; }
      if (!r || r.ok !== true) { fail(`${(r && r.reason) || 'no_medido'}: ${oneLine((r && r.detail) || 'sin detalle').slice(0, 200)}`); return; }
      const v = onValue(r.value);
      if (v && v.bad) { fail(v.bad); return; }
      done(v);
    });
  });
}

// Los pedidos abiertos de la rama, con `change-request list`: `{ prs }` o `{ error }`. Choca con main lo dice el conector
// (`mergeState: 'conflict'`).
function runQuery(q, perMs, env, children) {
  const args = ['change-request', 'list', '--repo', JSON.stringify(identityOf(q)),
    '--args', JSON.stringify({ sourceBranch: q.branch, checks: false, deadlineMs: Date.now() + perMs })];
  return askLayer(args, perMs, env, children, (value) => {
    if (!Array.isArray(value)) return { bad: 'respuesta ilegible (no es una lista)' };
    const prs = value.map((p) => ({
      number: p && p.number, draft: Boolean(p && p.draft === true), conflict: Boolean(p && p.mergeState === 'conflict'),
      offQueue: Boolean(p && typeof p === 'object' && offQueueOf(p)),
      // sin borrador ni auto-completar, la plataforma no supo si está en la cola: se dice, no se da por encolado
      queueUnknown: Boolean(p && typeof p === 'object' && p.draft !== true && !p.autoComplete && p.inQueue === null),
    }));
    if (!prs.every((p) => Number.isInteger(p.number))) return { bad: 'respuesta ilegible (un pedido sin número)' };
    return { prs };
  });
}

// Un pedido que nombra el tablero de la coordinadora, por su número, con `change-request read`: `{ pr }` o `{ error }`.
// `q`: `{ repo, numero, identity }`; sin identidad no se sabe a quién preguntarle.
function runRead(q, perMs, env, children) {
  if (!q.identity) return Promise.resolve({ error: `no sé en qué plataforma vive el repo ${q.repo}` });
  const args = ['change-request', 'read', '--repo', JSON.stringify(q.identity), '--args', JSON.stringify({ number: q.numero, deadlineMs: Date.now() + perMs })];
  return askLayer(args, perMs, env, children, (value) => (value && typeof value === 'object' && !Array.isArray(value) ? { pr: value } : { bad: 'respuesta ilegible (no es un pedido)' }));
}

// Todas las consultas a la vez, cada una con su tope y todas juntas con otro; al vencer el total se matan las que
// siguen vivas, para que el comando termine. Lo que no contesta es un error.
function queryAll(queries, { perMs = PER_QUERY_MS, totalMs = ALL_QUERIES_MS, env = process.env, run = runQuery } = {}) {
  const children = [];
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => {
      for (const c of children) killQuery(c);
      resolve({ error: `se pasó del tope de ${totalMs / 1000} s para todas las consultas` });
    }, totalMs);
  });
  return Promise.all(queries.map((q) => Promise.race([run(q, perMs, env, children), late]))).finally(() => clearTimeout(timer));
}
const readPrs = (queries, opts = {}) => queryAll(queries, { ...opts, run: runRead });

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

// La story que nombra una rama (`story/<id>…`), o `null`.
function storyOfBranch(branch) {
  const x = /^story\/(\d+(?:\.\d+)+)(?:[-/]|$)/.exec(branch || '');
  return x ? x[1] : null;
}
// La story de la rama de la carpeta de una sesión, o `null`.
const storyBranch = (dir, ctx, unreadable) => storyOfBranch(branchAt(dir, ctx, unreadable));

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
function lastTouched(sdir, sid, home, nowMs, unreadable, maxAgeMs = IDLE_MS) {
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
    if (nowMs - ts > maxAgeMs) break;
    if (/[\\/]scratchpad[\\/]/.test(p) || p.startsWith(memory) || out.includes(p)) continue;
    if (!out.length) out.newest = ts;
    out.push(p);
  }
  return out;
}

// Cuándo tocó archivos una sesión sin ejecución, para saber si siguió trabajando después de anotar lo que esperaba.
function touchedField(sdir, sid, home, nowMs, unreadable) {
  const at = lastTouched(sdir, sid, home, nowMs, unreadable).newest;
  return Number.isFinite(at) ? { touchedAt: at } : {};
}

// Los repos o carpetas de trabajo de una lista de archivos, si alguno estaba en una carpeta de trabajo que ya no existe, y si
// alguno no se pudo leer.
function rootsOf(paths, ctx) {
  const roots = new Map();
  let gone = false;
  let unreadable = false;
  for (const p of paths) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) continue;
    const worktree = /^(.*[\\/]worktrees[\\/][^\\/]+)[\\/]/.exec(p);
    if (worktree && !fs.existsSync(worktree[1])) { gone = true; continue; }
    let dir = path.dirname(p);
    while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
    const repo = repoOf(dir, ctx);
    if (repo && repo.err) unreadable = true;
    else if (repo) roots.set(repo.root, repo);
  }
  return { roots, gone, unreadable };
}

// ¿El trabajo de una sesión cerrada ya entró a la rama principal? Se mira la carpeta de cada archivo que nombra o tocó: la
// punta de su rama es parte de `origin/<principal>` y no le quedan cambios sin commitear. Lo que no se puede leer no cuenta
// como entrado: sin evidencia positiva, sigue a medio camino.
function enteredMain(paths, ctx) {
  const { roots, gone, unreadable } = rootsOf(paths, ctx);
  if (unreadable) return false;
  // la carpeta de trabajo que ya no está se borró al entrar: es lo que hacen el merge y el cierre de una sesión
  let seen = gone;
  for (const [root, repo] of roots) {
    const head = branchOf(repo);
    if (head.err) return false;
    if (!head.branch || MAIN_BRANCHES.includes(head.branch)) {
      // parada en la principal no dice que entró, salvo que tenga archivos cambiados: ésos no están guardados en ninguna parte
      const onMain = git(root, ['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=no'], ctx);
      if (onMain.err || changesOutsideRun(onMain.out)) return false;
      continue;
    }
    const st = git(root, ['--no-optional-locks', 'status', '--porcelain', '-z'], ctx);
    if (st.err || changesOutsideRun(st.out)) return false;
    // `merge-base --is-ancestor` sale 1 si no es parte; otro código, que esa rama principal no está en este repo
    const inMain = MAIN_BRANCHES.some((b) => !git(root, ['merge-base', '--is-ancestor', 'HEAD', `origin/${b}`], ctx).err);
    if (!inMain) return false;
    seen = true;
  }
  return seen;
}

// Lo que de verdad quedó de una sesión cerrada en sus carpetas: archivos sin guardar y commits que no están en la rama
// principal, por carpeta. `unknown` si alguna no se pudo leer; una carpeta que ya no está no deja nada.
function leftInFolders(roots, ctx) {
  const left = [];
  let unknown = false;
  for (const [root, repo] of roots) {
    const head = branchOf(repo);
    // en la principal, lo que no sigue git no es de nadie en particular: el mismo criterio de `enteredMain`
    const onMain = !head.err && (!head.branch || MAIN_BRANCHES.includes(head.branch));
    const st = git(root, ['--no-optional-locks', 'status', '--porcelain', '-z', ...(onMain ? ['--untracked-files=no'] : [])], ctx);
    if (st.err || head.err) { unknown = true; continue; }
    const counts = MAIN_BRANCHES.map((b) => git(root, ['rev-list', '--count', `origin/${b}..HEAD`], ctx)).find((r) => !r.err);
    if (!counts) unknown = true;
    const changes = changedFiles(st.out);
    const ahead = counts ? Number(counts.out) || 0 : 0;
    if (changes || ahead) left.push({ folder: root, branch: head.branch || null, changes, ahead });
  }
  return { left, unknown };
}

// Lo que anotó una sesión con su nota sobre su hora: la que dice ahora, la primera que prometió por ese trabajo y qué
// espera, desde cuándo. Quien espera no tiene hora: no se la inventa.
function hourOfNote(d) {
  const at = Date.parse(d.at);
  const until = Date.parse(d.endAt);
  const first = Date.parse(d.promisedAt);
  const since = Date.parse(d.waitingSince);
  return {
    ...(Number.isFinite(until) ? { endAt: until, hourAt: at, promiseAt: at } : {}),
    ...(Number.isFinite(first) ? { promisedAt: first } : {}),
    ...(d.waitingFor ? { waitingFor: String(d.waitingFor), waitingSince: Number.isFinite(since) ? since : null } : {}),
  };
}
const waitingEnd = (d) => {
  const since = Date.parse(d.waitingSince);
  return `espera ${d.waitingFor}${Number.isFinite(since) ? ` desde las ${hhmm(since)}` : ''}`;
};

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
  let queued = 0;
  let off = 0;
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
      found.push({ repo: q.name, ref, draft: p.draft, conflict: p.conflict, offQueue: p.offQueue });
      shown.push(`${q.name} ${ref}${p.draft ? ' (borrador)' : ''}${p.conflict ? ' (choca con main)' : ''}${p.offQueue ? ' (fuera de la cola)' : ''}${p.queueUnknown ? ' (cola sin verificar)' : ''}`);
      if (!p.draft && !p.offQueue) queued += 1;
      if (p.offQueue) off += 1;
    }
  }
  unreadable.push(...failures.map((f) => `story ${m.storyId || '?'}: ${f}`));
  // ninguno en camino (todos en borrador o fuera de la cola, alguno fuera): no está entrando, espera que lo encolen
  if (shown.length && !queued && off && !failures.length) return `${STALLED} · ${shown.join(' · ')}`;
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
  const medians = stepMedians(path.join(sdir, 'timing-history'), unreadable, opts.memory);
  if (opts.memory) reviseIfSessionClosed(opts.memory, sessions);
  const rows = [];
  // la sesión de cada fila, en el mismo orden: el --json la suma a la fila
  const rowSids = [];
  // lo que cada fila sabe además del texto (qué clase de trabajo es, la hora en milisegundos, los pasos): para /office
  const extra = [];
  const addRow = (row, sid, x = {}) => { rows.push(row); rowSids.push(sid); extra.push(x); };
  const busy = new Set();
  // la historia de la ejecución sin pasos pendientes de cada sesión: una nota de esa sesión sigue siendo de esa historia
  const finishedStory = new Map();
  // la fila de la story de cada sesión, para sumarle lo que hace mientras tanto
  const pipeRows = new Map();
  // la fila del arreglo rápido de cada sesión: su hora puede venir de una nota
  const looseRows = new Map();
  const wanted = [];
  const gitCtx = opts.gitCtx || { until: Date.now() + nn(opts.repoBudgetMs, GIT_BUDGET_MS), cache: new Map(), memory: opts.memory };

  const halfway = [];
  // lo mismo que `halfway`, como datos, para quien lo dice en llano (el comando /office): qué quedó y desde cuándo se
  // puede limpiar (null: ya se puede)
  const halfwayItems = [];
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
  // ¿Ya entró a la rama principal lo que dejó esta sesión cerrada? Los archivos de su carril, o los últimos que tocó. Cada una
  // tiene su propio tope: con la máquina cargada, las primeras no le gastan el tiempo a las demás
  const leftInMain = (sid, named, fallback) => {
    const leftCtx = { until: Date.now() + nn(opts.repoBudgetMs, GIT_BUDGET_MS), cache: gitCtx.cache, memory: gitCtx.memory, halfway: true };
    const paths = [...(Array.isArray(named) ? named : []), ...lastTouched(sdir, sid, home, nowMs, unreadable, Infinity)];
    const named2 = paths.length ? paths : [fallback];
    if (enteredMain(named2, leftCtx)) return { entered: true };
    // otra sesión viva sigue en esa misma carpeta: no quedó a medio camino, lo tiene ella
    const live = new Set([...sessions.values()].filter((s) => s.alive && s.cwd).map((s) => s.cwd));
    const { roots, unreadable: noRoots } = rootsOf(named2, leftCtx);
    const folders = [...roots.keys()];
    if (folders.length > 0 && folders.every((r) => live.has(r))) return { entered: true };
    // la carpeta que tiene otra sesión viva es de ella; sin ninguna ruta que mirar, o con una ilegible, no se sabe
    const { left, unknown } = leftInFolders(new Map([...roots].filter(([r]) => !live.has(r))), leftCtx);
    // sin saberlo por las carpetas, quien lo lea todavía puede preguntarle al pedido que nombre el trabajo
    return { folders, left, unknown: unknown || noRoots || !paths.length };
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
  const parked = readParked(sdir, unreadable);
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
    const sid = m.sessionId || path.basename(file, '.json');
    // la dejada a propósito se sigue viendo aunque lleve días sin tocarse
    const mark = markOf(m, sid, parked, nowMs, unreadable);
    // Con el paso 8 cerrado, lo que queda sin guardar espera al dueño aunque lleve días sin tocarse
    const tree = closed ? unsavedChanges(m, gitCtx) : null;
    const tellProblems = () => { for (const p of tree.problems) unreadable.push(`story ${m.storyId || '?'}: no se pudo leer si le quedan cambios sin guardar (${p})`); };
    // un cerrado viejo con la sesión muerta es una corrida terminada; con la sesión viva no se sabe si sus pedidos
    // entraron: se dice al pie, y la sesión sale con lo que hace hoy (o libre)
    if (nowMs - touched > STALE_MS && !mark && !(tree && tree.dirty)) {
      if (!closed) stale += 1;
      else if (liveName(sid)) staleWaiting += 1;
      if (tree) tellProblems();
      continue;
    }
    // Con el paso 8 cerrado cuenta si la sesión vive y la story todavía no entró a sus repos, o si le quedan cambios sin
    // guardar (viva o no: espera el ok del dueño). `save`: 'waits' o, con el ok ya dado, 'ok'.
    let entering = null;
    let save = null;
    if (closed) {
      if (!liveName(sid) && !tree.dirty && !mark) { tellProblems(); continue; }
      entering = enteringState(m, opts.prs, unreadable, wanted, gitCtx);
      if (!entering) {
        tellProblems();
        if (tree.dirty) save = m.saveOk ? 'ok' : 'waits';
        if (!save && !mark) { if (m.storyId) finishedStory.set(sid, String(m.storyId)); continue; }
      } else if (!liveName(sid) && !mark) continue;
    }
    busy.add(sid);
    let title;
    try { title = storyTitle(m.storyPath); } catch (e) {
      title = '(título ilegible)';
      unreadable.push(`${m.storyPath || '(sin ruta de story)'}: ${e.code === 'ENOENT' ? 'no existe' : e.message}`);
    }
    // con el esquema por nombre, el que sigue incluye los pasos de bandera («Probar en vivo»), que stepsPending no lista
    const saveText = save === 'waits' ? SAVE_WAITS : save === 'ok' ? SAVE_OK : null;
    const step = mark || entering || saveText || (closed ? 'Terminó' : stateOf((schemeOf(m) === 2 && pendingSteps(m)[0]) || m.stepsPending[0]));
    const work = `${m.storyId || '?'} · ${cut(title, TITLE_MAX)}`;
    const label = liveName(sid);
    const stages = stagesOf(m);
    if (label) {
      const entry = storyEntry(m, gitCtx);
      pipeRows.set(sid, { i: rows.length, m });
      const info = {};
      let end = entering ? closedEnd(entering, m, entry, nowMs, info) : closed ? 'sin estimación (ya terminó)' : estimateEnd(m, medians, nowMs, entry, info);
      const kind = save ? 'finished' : !entering && closed ? 'finished' : !entering ? 'pipeline' : entering.startsWith(STALLED) ? 'stalled' : 'entering';
      const promisedAt = promisedOf(m);
      const activityAt = Date.parse(m.lastTouch);
      const verdict = kind === 'pipeline' ? hourVerdict({ endAt: info.at == null ? promisedAt : info.at, hourAt: info.computedAt, activityAt, nowMs, run: true }) : null;
      if (verdict) end = verdict;
      if (mark) end = 'sin hora de fin';
      addRow({ work, state: step, end, session: label, folder: folderOf(sid, m.repoPath) }, sid,
        { kind, storyId: m.storyId ? String(m.storyId) : null, title, batch: storyBatch(m.storyPath), endAt: info.at == null ? null : info.at, late: Boolean(info.late), promisedAt, ...stages,
          ...(verdict ? { hourInWords: true } : {}), ...(mark ? { mark } : {}), ...(save === 'ok' ? { saveOk: true } : {}), ...(kind === 'finished' && !save ? { nothingToSave: true } : {}),
          ...(info.step !== undefined ? { hourStep: stepName(info.step) || `paso ${info.step}`, hourAt: info.computedAt } : {}),
          runFolder: typeof m.repoPath === 'string' && m.repoPath ? tilde(m.repoPath) : null,
          activityAt: Number.isFinite(activityAt) ? activityAt : null, runStartedAt: Date.parse(m.startedAt) || null, closedAt: closed ? closedAtOf(m) : null });
    }
    else {
      const awaits = save === 'waits' ? 'save' : !closed && stages.current === 'approve-plan' ? 'plan' : null;
      const item = { kind: 'run', text: title, cleanAfter: null, sid, name: nameOf(sid), storyId: m.storyId ? String(m.storyId) : null, ...(awaits ? { awaits } : {}), ...(mark || save === 'ok' ? { mark: mark || SAVE_OK } : {}) };
      // lo marcado, sin guardar o que espera al dueño no se ofrece limpiar: limpiarlo pierde el trabajo. La firma le gana a la marca
      if (awaits === 'plan') halfway.push(`${work} · ${nameOf(sid)} · ${mark ? `${mark} · ` : ''}Tu firma: que apruebes el plan`);
      else if (mark || save) halfway.push(`${work} · ${nameOf(sid)} · ${mark && save === 'waits' ? `${mark} · ${SAVE_WAITS}` : step}`);
      else {
        halfway.push(`${work} · ${nameOf(sid)} · quedó en: ${step} · limpiar: node ${MARKER_JS} clear-session ${sid}`);
        if (typeof m.repoPath === 'string') Object.assign(item, leftInMain(sid, [path.join(m.repoPath, 'x')], null));
      }
      halfwayItems.push(item);
    }
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
    const info = {};
    const end = closedEnd(entering, m, storyEntry(m, gitCtx), nowMs, info);
    addRow({ work: `${m.storyId || '?'} · ${cut(title, TITLE_MAX)}`, state: entering, end, session: liveName(sid), folder: folderOf(sid, m.repoPath) }, sid,
      { kind: entering.startsWith(STALLED) ? 'stalled' : 'entering', storyId: m.storyId ? String(m.storyId) : null, title, batch: storyBatch(m.storyPath), endAt: info.at == null ? null : info.at, late: Boolean(info.late), promisedAt: promisedOf(m), closedAt: closedAtOf(m), ...stagesOf(m) });
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
    if (pipe) {
      // sin tocar hace más de 1 h puede haber terminado: se dice desde cuándo
      const last = [a.lastTouch, a.declaredAt].map((v) => Date.parse(v)).find(Number.isFinite);
      const old = last !== undefined && nowMs - last > LOOSE_STALE_MS ? ` (sin tocar desde ${hhmm(last)})` : '';
      rows[pipe.i].meanwhile = `arreglo rápido «${work}»${old}`;
      const end = Date.parse(a.until);
      const declaredAt = [a.untilAt, a.declaredAt].map((v) => Date.parse(v)).find(Number.isFinite);
      Object.assign(extra[pipe.i], { meanwhile: String(a.reason || ''), meanwhileKind: 'loose', meanwhileAt: last === undefined ? null : last, meanwhileEnd: Number.isFinite(end) ? end : null, meanwhileDeclaredAt: declaredAt === undefined ? null : declaredAt });
      continue;
    }
    const label = liveName(sid);
    if (label) {
      // Desde cuándo no se toca: pasada 1 h, pregunta si terminó y dice cómo cerrarlo desde su sesión (no lo borra).
      const last = [a.lastTouch, a.declaredAt].map((v) => Date.parse(v)).find(Number.isFinite);
      const parts = ['Trabajo suelto'];
      if (last !== undefined) parts.push(`sin tocar desde ${hhmm(last)}`);
      if (last !== undefined && nowMs - last > LOOSE_STALE_MS) parts.push(`¿terminó? cerralo desde su sesión: node ${MARKER_JS} adhoc clear`);
      const until = Date.parse(a.until);
      const declared = Number.isFinite(until);
      // cuándo se declaró la hora: la promesa es de esa declaración, y una declaración vieja ya no dice nada
      const declaredAt = [a.untilAt, a.declaredAt].map((v) => Date.parse(v)).find(Number.isFinite);
      looseRows.set(sid, rows.length);
      addRow({ work, state: parts.join(' · '), end: hourVerdict({ endAt: until, hourAt: declaredAt, nowMs }) || declaredEnd(a.until, until), session: label, folder: folderOf(sid) }, sid,
        { ...touchedField(sdir, sid, home, nowMs, unreadable), kind: 'loose', text: String(a.reason || ''), endAt: declared ? until : null, hourAt: declaredAt === undefined ? null : declaredAt, promiseAt: declaredAt === undefined ? null : declaredAt });
    }
    else {
      // Se limpia con `adhoc clear-orphan`, que sólo borra pasadas las 24 h sin tocarse: antes, se dice desde cuándo.
      let touched = [a.lastTouch, a.declaredAt].map((v) => Date.parse(v)).find(Number.isFinite);
      if (touched === undefined) {
        try { touched = fs.statSync(file).mtimeMs; } catch (e) {
          unreadable.push(`${file}: sin fecha legible (${e.message})`);
          halfway.push(`ad-hoc «${work}» · ${nameOf(sid)} · fecha ilegible: no se sabe desde cuándo se puede limpiar`);
          halfwayItems.push({ kind: 'adhoc', text: String(a.reason || ''), cleanAfter: 'unknown', sid });
          continue;
        }
      }
      const how = nowMs - touched > STALE_MS
        ? `limpiar: node ${MARKER_JS} adhoc clear-orphan ${sid}`
        : `se podrá limpiar después de las ${hhmm(touched + STALE_MS)}`;
      halfway.push(`ad-hoc «${work}» · ${nameOf(sid)} · ${how}`);
      halfwayItems.push({ kind: 'adhoc', text: String(a.reason || ''), cleanAfter: nowMs - touched > STALE_MS ? null : touched + STALE_MS, sid, ...leftInMain(sid, [...(a.files || []), ...(a.rutas || [])], a.cwd) });
    }
  }

  // Lo que anota una sesión sin story (`marker.js doing`): no es un permiso, sólo dice qué hace. Con una story en curso
  // es lo que hace mientras tanto, si un ad-hoc no lo dijo antes; sin story, un ad-hoc de la misma sesión manda.
  for (const file of jsonFiles(path.join(sdir, 'doing'), unreadable)) {
    const sid = path.basename(file, '.json');
    const pipe = pipeRows.get(sid);
    const looseRow = looseRows.get(sid);
    if (busy.has(sid) && !pipe && looseRow === undefined) continue;
    let d;
    try { d = readObject(file); } catch (e) { unreadable.push(`${file}: ${e.message}`); continue; }
    // la espera vieja de una sesión ocupada no gana sobre la actividad real: sin texto propio, la nota no dice nada
    const waitSince = Date.parse(d.waitingSince);
    if (d.waitingFor && sessions.get(sid) && sessions.get(sid).busy && Number.isFinite(waitSince) && nowMs - waitSince > WAIT_OUTLIVED_MS) {
      if (!d.text) continue;
      d = { ...d, waitingFor: undefined, waitingSince: undefined };
    }
    const work = cut(String(d.text || '(sin texto)'), TITLE_MAX);
    const at = Date.parse(d.at);
    // con un arreglo rápido abierto, la nota no abre otra fila: le da su hora, o dice qué espera
    if (looseRow !== undefined) {
      const hour = hourOfNote(d);
      Object.assign(extra[looseRow], hour);
      if (hour.waitingFor) rows[looseRow].end = waitingEnd(d);
      else if (Number.isFinite(hour.endAt)) rows[looseRow].end = hourVerdict({ endAt: hour.endAt, hourAt: at, nowMs }) || declaredEnd(d.endAt, hour.endAt);
      continue;
    }
    if (pipe) {
      if (d.waitingFor) { Object.assign(extra[pipe.i], { waitingFor: String(d.waitingFor), waitingSince: hourOfNote(d).waitingSince }); rows[pipe.i].end = waitingEnd(d); }
      else {
        // la hora de la nota es de la ejecución si la nombra o si la de su paso ya venció; si no, es de lo que hace mientras tanto
        const run = extra[pipe.i];
        const runEnd = Number.isFinite(run.endAt) ? run.endAt : run.promisedAt;
        const isOfRun = (run.storyId && String(d.text || '').includes(run.storyId)) || (Number.isFinite(runEnd) && runEnd < nowMs);
        if (isOfRun && Number.isFinite(Date.parse(d.endAt)) && Number.isFinite(at) && !(at < run.hourAt) && !(at < run.runStartedAt)) Object.assign(run, { noteEnd: Date.parse(d.endAt), noteEndAt: at });
      }
      const old = Number.isFinite(at) && nowMs - at > LOOSE_STALE_MS ? ` (sin tocar desde ${hhmm(at)})` : '';
      // la nota más nueva que el arreglo es lo de ahora: un carril viejo no la tapa
      const priorAt = extra[pipe.i].meanwhileAt;
      if (!rows[pipe.i].meanwhile || (Number.isFinite(at) && Number.isFinite(priorAt) && at > priorAt)) {
        rows[pipe.i].meanwhile = `${work}${old}`;
        const end = Date.parse(d.endAt);
        Object.assign(extra[pipe.i], { meanwhile: String(d.text || ''), meanwhileKind: 'note', meanwhileAt: Number.isFinite(at) ? at : null, meanwhileEnd: Number.isFinite(end) ? end : null, meanwhileDeclaredAt: Number.isFinite(at) ? at : null });
      }
      continue;
    }
    const label = liveName(sid);
    if (!label) {
      // como el ad-hoc: se borra con `doing clear-orphan`, que sólo borra pasadas las 24 h sin tocarse
      let touched = at;
      if (!Number.isFinite(touched)) { try { touched = fs.statSync(file).mtimeMs; } catch { touched = nowMs; } }
      const how = nowMs - touched > STALE_MS ? `borrar: node ${MARKER_JS} doing clear-orphan ${sid}` : `se podrá borrar después de las ${hhmm(touched + STALE_MS)}`;
      halfway.push(`nota «${work}» · ${nameOf(sid)} · ${how}`);
      halfwayItems.push({ kind: 'note', text: String(d.text || ''), cleanAfter: nowMs - touched > STALE_MS ? null : touched + STALE_MS, sid, ...leftInMain(sid, [], null) });
      continue;
    }
    busy.add(sid);
    const parts = ['Anotado por la sesión'];
    if (Number.isFinite(at)) parts.push(`sin tocar desde ${hhmm(at)}`);
    if (Number.isFinite(at) && nowMs - at > LOOSE_STALE_MS) parts.push(`¿terminó? borrala desde su sesión: node ${MARKER_JS} doing clear`);
    const until = Date.parse(d.endAt);
    const declared = Number.isFinite(until);
    addRow({ work, state: parts.join(' · '), end: d.waitingFor ? waitingEnd(d) : hourVerdict({ endAt: until, hourAt: at, nowMs }) || declaredEnd(d.endAt, until), session: label, folder: folderOf(sid) }, sid,
      { ...touchedField(sdir, sid, home, nowMs, unreadable), kind: 'note', text: String(d.text || ''), endAt: declared ? until : null, hourAt: Number.isFinite(at) ? at : null, promiseAt: Number.isFinite(at) ? at : null, ...(finishedStory.has(sid) ? { finishedStoryId: finishedStory.get(sid) } : {}), ...hourOfNote(d) });
  }

  // sin arreglo ni nota: si lo último que tocó la sesión está en un repo que no es de su story, eso hace mientras tanto
  for (const [sid, { i, m }] of pipeRows) {
    if (rows[i].meanwhile) continue;
    let place = null;
    for (const file of touchedOf(sid)) { place = touchedPlace(file, gitCtx, unreadable); if (place) break; }
    if (place && !ofStory(m, gitCtx)(place.root, place.branch) && place.story !== String(m.storyId || '')) rows[i].meanwhile = place.work;
  }
  // una corrida abierta tapada por el trabajo de ahora queda en pausa y sin hora, como en la oficina
  for (const [, { i }] of pipeRows) {
    if (extra[i].mark || !replacedByNewer(extra[i], nowMs)) continue;
    rows[i].end = 'sin hora estimada (en pausa)';
  }

  const free = [];
  // la sesión de cada libre, en el mismo orden: para /office, que la cruza con su archivo de estado
  const freeSids = [];
  const freeStatus = [];
  const noData = [];
  const idle = [];
  let internal = 0;
  for (const [sid, s] of sessions) {
    if (s.alive && s.internal && !busy.has(sid)) { internal += 1; continue; }
    if (!s.alive || busy.has(sid)) continue;
    const label = s.name || shortId(sid);
    const active = s.busy || (s.last != null && nowMs - s.last < WORKING_MS);
    // quieta, pero con un archivo tocado hace poco: sigue con algo (espera una prueba de fondo, pone al día una rama)
    // y no está libre
    const files = touchedOf(sid);
    const recentFile = files.newest != null && nowMs - files.newest < RECENT_FILE_MS;
    if (active || recentFile) {
      // lo que hace sale del último archivo que tocó dentro de un repo; sin uno, de la carpeta donde arrancó
      let place = null;
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
      const parts = [active ? 'Trabajando sin pipeline' : 'Trabajando sin marcador', why, story && `story ${story} en preparación`,
        s.last != null && `última actividad ${hhmm(s.last)}`, !active && `último archivo ${hhmm(files.newest)}`].filter(Boolean);
      addRow({ work: place ? place.work : unknown ? 'no se ve qué hace' : sessionPlace(s.cwd, gitCtx, unreadable), state: parts.join(' · '), end: 'sin estimación (no tiene pasos)', session: label, folder: place ? tilde(place.root) : tilde(s.cwd) }, sid, { kind: active ? 'activity' : 'nomarker' });
    } else if (s.last == null) { free.push(label); freeSids.push(sid); freeStatus.push(s.status); noData.push(label); }
    // la que espera una respuesta no está sin uso, aunque lleve horas esperando
    else if (nowMs - s.last > IDLE_MS && !WAITING_STATUS.test(s.status || '')) idle.push(`${label} (desde ${hhmm(s.last)})`);
    else { free.push(label); freeSids.push(sid); freeStatus.push(s.status); }
  }
  const details = rowSids.map((sid) => {
    const s = sessions.get(sid);
    return { sid, status: s ? s.status : null, statusAt: s ? s.statusAt : null, nameSource: s ? s.nameSource : null };
  });
  // lo que la conversación y la tabla necesitan de cada sesión, y su estado real: /wip dice lo mismo que la oficina
  const files = sessionFileMap(sdir, unreadable);
  rowSids.forEach((sid, i) => {
    const s = sessions.get(sid);
    if (s) { extra[i].cwd = s.cwd; extra[i].lastAt = s.last; }
  });
  // el cuadro de una sesión de prueba no le toca a nadie: /wip no lo dice, como la oficina
  const testSids = testSessionsOf(sessions, files, () => (opts.processes !== undefined ? opts.processes : require(path.join(ROOT, 'scripts', 'lib', 'owner-window.js')).leerArbol()));
  const notes = rowSids.map((sid, i) => (testSids.has(String(sid)) ? '' : stateNote(extra[i], details[i], files.get(String(sid)))));
  rows.forEach((r, i) => { const n = promiseNote(extra[i], nowMs); if (n) r.promise = n; });
  // la libre que espera algo: /office la pone en «Tu firma» y /wip lo dice igual
  const freeNotes = new Map(free.map((name, i) => {
    if (testSids.has(String(freeSids[i]))) return [name, 'sesión de prueba'];
    const r = realState({}, { status: freeStatus[i] }, files.get(String(freeSids[i])));
    return [name, r.estado === 'firma' ? `Tu firma: ${r.espera}` : r.estado === 'pregunta' ? `Te pregunta: ${r.espera}` : ''];
  }));
  // los repos de las corridas con fila: /office los reconoce al preguntar por un pedido que nombra el tablero
  const runRepos = [...new Set([...pipeRows.values()].map(({ m }) => m.repoPath).filter((p) => typeof p === 'string' && path.isAbsolute(p)))];
  const retired = retiredNow(home, nowMs, sessions, unreadable);
  const text = render(rows, free, noData, idle, halfway, unreadable, internal, notes, freeNotes) + renderRetired(retired);
  return { testSids, rows, details, extra, free, freeSids, freeStatus, idle, halfway, halfwayItems, halfwayReadAt: (gitCtx.memory && gitCtx.memory.halfwayReadAt) || nowMs, unreadable, wanted, runRepos, internal, retired, text };
}

// Las sesiones de fondo que Claude Code cerró y no volvieron (scripts/lib/claude-retired.js). Un registro que existe y no se
// pudo leer o entender se dice en `unreadable`; sin registro (otra máquina, Codex), nada.
function retiredNow(home, nowMs, sessions, unreadable) {
  try {
    const r = require(path.join(ROOT, 'scripts', 'lib', 'claude-retired.js')).retiredSessions({ home, now: nowMs });
    if (!r.measured && !/^no hay registro/.test(String(r.why))) unreadable.push(`las sesiones que cerró Claude Code: ${shown(r.why)}`);
    return r.retired.filter((x) => !(x.sid && sessions.get(x.sid) && sessions.get(x.sid).alive));
  } catch (e) {
    unreadable.push(`las sesiones que cerró Claude Code (${shown((e && e.message) || e)})`);
    return [];
  }
}

// Su renglón en /wip, debajo de la tabla: qué pasó y el comando que la levanta.
function renderRetired(retired) {
  if (!retired || !retired.length) return '';
  return `\n\nCerradas por Claude Code:\n${retired.map((x) => `- ${shown(x.session, 40)}: la cerró Claude Code (${shown(x.reason, 40)}), quieta ${x.idleMin} min — claude respawn ${x.short}`).join('\n')}`;
}

// De prueba es la sesión que lanzó otra sesión: ninguna de las de verdad desciende de otra. El árbol de procesos sólo se lee si
// hay un cuadro abierto; sin árbol (Windows) no se sabe, y la sesión cuenta como una más.
function testSessionsOf(sessions, files, readTree) {
  const out = new Set();
  const asking = [...sessions].filter(([sid, s]) => s.alive && Number.isInteger(s.pid) && ['firma', 'pregunta'].includes(realState({}, { status: s.status }, files.get(String(sid)) || null).estado));
  if (!asking.length) return out;
  const tree = readTree();
  if (!Array.isArray(tree)) return out;
  const parent = new Map(tree.map((p) => [Number(p.pid), Number(p.ppid)]));
  const sessionPids = new Set([...sessions.values()].filter((s) => s.alive).map((s) => s.pid));
  for (const [sid, s] of asking) {
    let p = parent.get(s.pid);
    for (let i = 0; p > 1 && i < 64; i += 1) {
      if (sessionPids.has(p)) { out.add(String(sid)); break; }
      p = parent.get(p);
    }
  }
  return out;
}

// Los archivos de estado de las sesiones, por sesión. Los que no se pueden usar los dice la oficina; lo que tira al leer
// la carpeta entera se dice acá.
function sessionFileMap(sdir, unreadable) {
  const out = new Map();
  try { for (const f of require(path.join(ROOT, 'scripts', 'lib', 'session-state.js')).readAll(sdir).states) out.set(String(f.session), f); } catch (e) {
    if (unreadable) unreadable.push(`los archivos de estado de las sesiones no se pudieron leer (${(e && e.code) || (e && e.message)})`);
  }
  return out;
}

// El atraso contra lo prometido, para sumarlo a la columna «Fin estimado»: la misma cuenta y el mismo margen que la oficina. Una
// marca, una espera o una hora que se dice en palabras (la ejecución dormida) no dicen atraso, ni lo que ya terminó.
const PROMISE_MARGIN_MIN = 15;
function promiseNote(x, nowMs) {
  const end = Number.isFinite(x.noteEnd) ? x.noteEnd : x.endAt;
  if (!Number.isFinite(x.promisedAt) || !Number.isFinite(end) || x.mark || x.waitingFor || x.hourInWords || ['entering', 'stalled', 'finished'].includes(x.kind)) return '';
  const min = Math.round((end < nowMs ? nowMs - Math.min(x.promisedAt, end) : end - x.promisedAt) / 60000);
  if (min <= PROMISE_MARGIN_MIN) return '';
  const later = min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
  const sameDay = new Date(x.promisedAt).toDateString() === new Date(nowMs).toDateString();
  return `+${later} tarde, prometida ${sameDay ? '' : `el ${new Date(x.promisedAt).getDate()}, `}${hhmm(x.promisedAt)}`;
}

// El estado real de una fila, para sumarlo a la columna «Estado»: nada si la fila ya lo dice. Lo que espera al dueño se
// dice también en una fila marcada: la firma le gana a la marca.
function stateNote(x, d, f) {
  const r = realState(x, d, f);
  if (r.estado === 'pregunta') return `Te pregunta: ${r.espera}`;
  if (r.estado === 'firma') return x.kind === 'finished' && r.espera === 'el ok para guardar' && !x.mark ? '' : `Tu firma: ${r.espera}`;
  return x.mark || x.kind === 'finished' ? '' : r.parada || '';
}

function render(rows, free, noData, idle, halfway, unreadable, internal = 0, notes = [], freeNotes = new Map()) {
  const esc = (s) => oneLine(s).replace(/\|/g, '\\|');
  const lines = ['| Trabajo | Estado | Fin estimado | Sesión | Carpeta |', '|---|---|---|---|---|'];
  if (!rows.length) lines.push('| (nada en curso) | | | | |');
  rows.forEach((r, i) => {
    const state = notes[i] ? `${r.state} · ${notes[i]}` : r.state;
    lines.push(`| ${esc(r.work)} | ${esc(r.meanwhile ? `${state} · mientras tanto: ${r.meanwhile}` : state)} | ${esc(r.promise ? `${r.end} · ${r.promise}` : r.end)} | ${esc(r.session)} | ${esc(r.folder || '')} |`);
  });
  const freeText = free.map((f) => (freeNotes.get(f) ? `${f} (${freeNotes.get(f)})` : noData.includes(f) ? `${f} (sin dato de actividad)` : f));
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

// El trabajo en curso de ahora, con los pedidos ya preguntados: primero se ve qué preguntar, las preguntas van todas
// juntas y la tabla se arma otra vez con las respuestas.
async function wipNow(opts = {}) {
  const o = { ...opts, gitCtx: opts.gitCtx || { until: Date.now() + GIT_BUDGET_MS, cache: new Map(), memory: opts.memory } };
  let r = buildWip(o);
  if (r.wanted.length) {
    const unique = [...new Map(r.wanted.map((q) => [q.root, q])).values()];
    const answers = await (opts.queryAll || queryAll)(unique);
    const byRoot = new Map(unique.map((q, i) => [q.root, answers[i]]));
    r = buildWip({ ...o, prs: (q) => byRoot.get(q.root) });
  }
  return r;
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
  let r;
  try { r = await wipNow(opts); } catch (e) {
    if (e.code === 'NO_STATE' || e.code === 'BAD_ARG') { process.stderr.write(`work-in-progress.js: ${e.message}\n`); return 2; }
    throw e;
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

module.exports = { buildWip, wipNow, renderRetired, retiredNow, createMemory, reviseHalfway, git, stepMedians, enteredMain, OVERDUE_HOUR, stagesOf, jsonOf, sessionsBySid, storyEntering, median, queryAll, readPrs, parseRemote, offQueueOf, identityOf, remoteOfFolder, endOf, hourForStep, hourVerdict, realState, replacedByNewer, storyPausedUntil, unsavedChanges, codexNames, PER_QUERY_MS, ALL_QUERIES_MS, SAFE_SID, LOOSE_STALE_MS };
