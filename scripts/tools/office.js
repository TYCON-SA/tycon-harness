#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('../lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/*
 * office.js — el trabajo en curso de esta máquina dibujado como una oficina en 3D (el comando /office).
 *
 *   node office.js [--open] [--json] [--out <archivo>] [--now <fecha>]
 *
 * Los datos son los de /wip (work-in-progress.js, con los pedidos ya preguntados), las firmas pendientes de la
 * coordinación y la sesión coordinadora designada. Cada sesión es una persona en su escritorio: su nombre, su estado
 * en palabras, la hora de fin con su atraso o adelanto, el avance, lo que hace y lo que hace mientras tanto. El estado
 * sale de si la sesión trabaja, no del paso: ocupada, parada o esperando algo del dueño, lo que dice su herramienta. El
 * atraso de una corrida se mide contra la hora de su paso (`horaDelPaso`, la anota marker.js); sin ella, contra su promesa
 * (su arranque más su estimado, del marcador); sin estimado, contra la primera hora que se vio para esa sesión y ese
 * trabajo, guardada en `<estado>/office/promises.json`.
 * El panel de pendientes es un kanban de cinco columnas (Tu firma, En curso, Esperan entrar, Sin empezar, Hechos): las tres
 * primeras salen del estado real, y el tablero de la coordinadora (`<estado>/coordination/tablero.json`) suma lo que la
 * máquina no sabe. Una fila con `historia` toma su estado de la corrida; con `pedido`, de consultarlo. El panel de la
 * pared cuenta esas columnas. Sin pipeline, la tarjeta dice el encargo, lo que hace ahora y su última acción, leídos del
 * principio y del final de su conversación (scripts/lib/session-transcript.js): van sólo en la foto viva y en `--json`.
 *
 * `--open` abre la oficina viva: arranca el proceso local de office/server.js (o reusa el que ya está) y abre su
 * dirección; la página recibe cada cambio por WebSocket. `--out` escribe la foto fija en un archivo, y `--json` imprime
 * los datos. La foto fija es un solo archivo, sin nada de afuera: la librería 3D (three.js 0.160.0, MIT, en
 * office/vendor/three/) va adentro, y si el navegador no puede dibujar en 3D se ve la tabla. Sólo mira: no cambia nada
 * del trabajo de las sesiones.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const { stateDir, claudeDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
const { designacionVigente } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'critical-waivers.js'));
const { wipNow, sessionsBySid, codexNames, realState, replacedByNewer, hourVerdict, readPrs, offQueueOf, identityOf, remoteOfFolder, SAFE_SID, LOOSE_STALE_MS } = require('./work-in-progress.js');
const { readPending } = require('./coordination.js');
const sessionState = require(path.join(ROOT, 'scripts', 'lib', 'session-state.js'));
const { readTranscript, codexTranscript } = require(path.join(ROOT, 'scripts', 'lib', 'session-transcript.js'));

const VENDOR = path.join(__dirname, 'office', 'vendor', 'three');
const TEMPLATE = path.join(__dirname, 'office', 'page.html');
// Los módulos de la librería que usa la escena, con el nombre con que se importan. Los archivos están copiados sin
// cambios en una sola carpeta (`extras/`); el nombre con que se importan conserva la ruta original de la librería, que
// es contra la que se resuelven sus importaciones relativas.
const MODULES = {
  three: 'three.module.min.js',
  'three/addons/controls/OrbitControls.js': 'extras/OrbitControls.js',
  'three/addons/geometries/RoundedBoxGeometry.js': 'extras/RoundedGeometry.js',
  'three/addons/postprocessing/EffectComposer.js': 'extras/EffectComposer.js',
  'three/addons/postprocessing/RenderPass.js': 'extras/RenderPass.js',
  'three/addons/postprocessing/UnrealBloomPass.js': 'extras/UnrealBloomPass.js',
  'three/addons/postprocessing/OutputPass.js': 'extras/OutputPass.js',
  'three/addons/postprocessing/Pass.js': 'extras/Pass.js',
  'three/addons/postprocessing/ShaderPass.js': 'extras/ShaderPass.js',
  'three/addons/postprocessing/MaskPass.js': 'extras/MaskPass.js',
  'three/addons/shaders/CopyShader.js': 'extras/CopyShader.js',
  'three/addons/shaders/LuminosityHighPassShader.js': 'extras/LuminosityHighPassShader.js',
  'three/addons/shaders/OutputShader.js': 'extras/OutputShader.js',
};
// Los estados de una sesión que trabaja o espera: los únicos en que estar callada dice algo.
const QUIET_STATES = new Set(['trabajando', 'prueba', 'firma', 'espera']);
// Las clases de trabajo sin corrida abierta: lo que hacen se lee de su conversación.
const NO_RUN_KINDS = new Set(['activity', 'nomarker', 'loose', 'note']);
// El nombre del paso que espera la aprobación del dueño, como lo anota el archivo de estado de la sesión.
const PLAN_STEP_NAME = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'steps.js')).stepName('approve-plan');
const PROMISE_KEEP_MS = 24 * 3600000;
const STALE_END_MS = 12 * 3600000;
// la sesión callada (decisión 20): sin novedades hace más de este umbral, en minutos; el perfil del equipo lo cambia
// con `office.quiet_minutes`, desde el sitio
const QUIET_DEFAULT_MIN = 15;
// un archivo de estado inactivo de más de un día no se dibuja (los de Codex nunca se borran); queda en disco
const SESSION_FILE_KEEP_MS = 24 * 3600000;
// Hasta 10 escritorios, según cuántas sesiones haya; las demás quedan en las tarjetas de abajo. El tope de sesiones por
// coordinadora no cuenta acá: la oficina muestra todas las de la máquina.
const MAX_DESKS = 10;
// Hasta cinco, los cinco lugares de siempre; más, dos filas de cinco a los costados del sofá: [x, z, giro].
const FIVE = [[5.6, 1.45, 0], [1.95, 3.1, Math.PI / 2], [8.75, 6.9, Math.PI / 2], [1.95, 7.0, Math.PI / 2], [5.3, 8.55, 0]];
const GRID = [1.6, 3.4, 5.2, 7.0, 8.8].flatMap((z) => [[2.6, z, 0], [8.4, z, 0]]);
/** Los lugares de `n` escritorios (como mucho MAX_DESKS). */
const deskSlots = (n) => (n <= FIVE.length ? FIVE : GRID).slice(0, Math.min(n, MAX_DESKS));

const pad = (n) => String(n).padStart(2, '0');
// La hora local como la lee la página: 'YYYY-MM-DDTHH:MM'.
const localIso = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const hhmm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

const DAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
// La hora como la dice la página: «sáb 19:36».
const dayHhmm = (ms) => `${DAYS[new Date(ms).getDay()]} ${hhmm(ms)}`;
const difTxt = (m) => { const a = Math.abs(m); return a < 60 ? `${a} min` : `${Math.floor(a / 60)} h ${pad(a % 60)}`; };

// Lo que lee el dueño va sin números de historia ni de pedidos: «8.85 · », «8.85-E: », «!6008», «#842» se sacan. El
// título de una historia o de una tanda lo escribió una persona: queda así, entero.
// Una hora al comienzo («10.30: reunión») no es un número de historia, y «#1» no es un pedido: los pedidos tienen
// tres cifras o más.
const HOUR_AT_START = /^\s*(?:[01]?\d|2[0-3])\.[0-5]\d\s*:/;
const unnumbered = (t) => {
  const s = typeof t === 'string' ? t : '';
  return (HOUR_AT_START.test(s) ? s : s.replace(/^\s*\d+(?:\.\d+)+[A-Za-z]?(?:-[A-Za-z0-9]+)?\s*[·:]\s*/, ''))
    .replace(/\s*[!#]\d{3,}\b/g, '')
    .trim();
};
// El texto que escribe una sesión, además, va sin nombres de archivos, rutas, ramas ni identificadores; la preposición
// que los presentaba se va con ellos. El castellano queda: «10-12», «teórico-práctico», «y/o», «ad-hoc», «Node.js».
// Tampoco van los números de historia del medio («la 8.154», «historia 2.81-c»: una hora o un decimal sueltos quedan) ni
// lo que no debe verse en una tarjeta: lo que el chat marca como código, una clave, un correo, un teléfono.
const CUT = '\u0000';
const STORY_IN_TEXT = /\b(?:(?:la\s+)?(?:historia|story)|la)\s+\d+(?:\.\d+)+[A-Za-z]?(?:-[A-Za-z0-9]+)?(?=[\s.,;:!?)»]|$)/giu;
// una hora escrita con punto no es un número de historia; una fecha no es un teléfono
const BEFORE_WORDS = (t) => t
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/`[^`]*`/g, ` ${CUT} `)
  .replace(/(?<![\w+=/-])\+?\d[\d() -]{6,}\d(?![\w=/-])/g, (m) => (m.replace(/\D/g, '').length >= 8 && !/^\d{4}-\d\d-\d\d$/.test(m) ? ` ${CUT} ` : m))
  .replace(STORY_IN_TEXT, (m) => (/^la\s+1\.[0-5]\d$/i.test(m) ? m : 'la historia'))
  .replace(/\b(pedidos?)\s+[!#]?\d{3,}\b/giu, '$1');
const SECRET = (w) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(w)
  || /^[\w.-]*(?:token|clave|password|contrase[nñ]a|secret|api[-_]?key|pat)[\w.-]*[=:].+/i.test(w)
  || (/^[A-Za-z0-9_+=/.-]{20,}$/.test(w) && /\d/.test(w) && /[A-Za-z]/.test(w));
const FILE_EXT = /\.(?:c?js|mjs|tsx?|jsx|json|md|ya?ml|sh|ps1|cs|csproj|sql|html?|css|txt|log|py|lock|xml|toml|ini|env)$/i;
// Palabras que parecen técnicas y son comunes: las librerías por su nombre («three.js») y las compuestas con un
// conector en el medio («paso-a-paso», «end-to-end»). Un archivo oculto empieza en minúscula; «.NET» no lo es.
const LIBRARY = /^(?:three|node|vue|next|nuxt|d3|chart|express|react|angular|ember|backbone)\.js$/i;
const JOINED = /^\p{L}+(?:-(?:a|al|de|del|en|y|o|to|by|and|or)-\p{L}+)+$/iu;
const technical = (w) =>
  SECRET(w)
  || w.includes('\\')
  || (w.includes('/') && (/\/.*\//.test(w) || /^[.~/]/.test(w) || /[._-]/.test(w)))
  || /^\.[a-z][\w.-]*$/.test(w)
  || (FILE_EXT.test(w) && /^[\w.-]+$/.test(w) && !/^[A-Z][a-z]+\.js$/.test(w) && !LIBRARY.test(w))
  || (/^[a-z0-9_]+(?:-[a-z0-9_]+)+$/.test(w) && !/^\d+(?:-\d+)+$/.test(w) && !JOINED.test(w) && (/\d|_/.test(w) || /-.*-/.test(w)));
const plain = (t) => BEFORE_WORDS(unnumbered(t))
  .split(/(\s+)/)
  .map((tok) => {
    // sin la puntuación ni el formato del chat alrededor, y sin el renglón de un archivo («office.js:241»)
    const core = tok.replace(/^[«"'(*_~[]+|[»"'),;:!?*_~\]]+$|\.+$/g, '').replace(/[»"'),;:!?*_~\].]+$/g, '').replace(/(\.[A-Za-z]{1,5}):\d+(?::\d+)?$/, '$1');
    return core && technical(core) ? CUT : tok;
  })
  .join('')
  .replace(new RegExp(`\\s+(?:en|de|del|a|al|con|desde|para)\\s+${CUT}`, 'g'), CUT)
  .replace(new RegExp(`\\s*(?:${CUT}\\s*[·,:]?\\s*)+`, 'g'), ' ')
  .replace(/\s+/g, ' ')
  .replace(/^[\s·,:]+|[\s·,:]+$/g, '');

// Una oración llana por sesión: qué está haciendo, sin el detalle técnico de /wip.
function sentenceOf(estado, x, row) {
  if (estado === 'firma') return 'Espera tu respuesta o un permiso.';
  if (estado === 'coordina') return 'Coordina las sesiones de esta máquina.';
  if (x.kind === 'pipeline') {
    const step = (x.steps || []).find((s) => s.id === x.current);
    return step ? `Va por el paso «${step.name}».` : 'Implementa su historia.';
  }
  if (x.kind === 'finished') return x.saveOk ? 'Terminó: ya tiene el ok para guardar.' : 'Terminó: espera el ok para guardar.';
  if (x.kind === 'entering') return 'Terminó: sus cambios están entrando a los repos.';
  if (x.kind === 'stalled') {
    return /choca con main/.test(row.state || '')
      ? 'Terminó, pero sus pedidos no están en la cola y su pedido choca con main.'
      : 'Terminó, pero sus pedidos no están en la cola.';
  }
  // el trabajo suelto y la nota dicen con sus palabras qué hacen
  if ((x.kind === 'loose' || x.kind === 'note') && plain(x.text)) return plain(x.text);
  if (x.kind === 'loose') return 'Hace un trabajo suelto, sin pasos fijos.';
  if (x.kind === 'note') return 'Trabaja en algo de fondo.';
  if (x.kind === 'activity') return 'Trabaja sin pipeline.';
  if (x.kind === 'nomarker') return 'Sigue con algo: tocó archivos hace poco.';
  return 'Trabaja.';
}

/**
 * Los datos de la página, sin leer nada: `wip` es lo que devuelve wipNow, `signatures` las firmas pendientes,
 * `coordinatorSid` la sesión coordinadora (o null), `promises` la primera hora vista de cada sesión y story, `board` el
 * tablero de la coordinadora ya armado (`buildBoard`), `prAnswers` lo que contestó cada pedido que nombra (por
 * `<repo>#<número>`) y `transcripts` lo que dice la conversación de cada sesión (por sesión).
 * Devuelve `{ data, promises }`, con las promesas ya al día para guardarlas.
 */
function buildOffice({ wip, signatures = [], coordinatorSid = null, coordinatorName = null, promises = {}, nowMs = Date.now(),
  sessionFiles = [], codexNames: cxNames = new Map(), quietMin = QUIET_DEFAULT_MIN, isAlive, board = null, prAnswers = new Map(), transcripts = null } = {}) {
  const kept = {};
  for (const [k, p] of Object.entries(promises || {})) {
    if (p && Number.isFinite(p.at) && Number.isFinite(p.seen) && nowMs - p.seen < PROMISE_KEEP_MS) kept[k] = p;
  }
  // el archivo de estado de cada sesión, por sesión
  const files = new Map();
  for (const f of sessionFiles || []) if (f && f.session) files.set(String(f.session), f);
  const used = new Set();
  // la sesión de cada tarjeta: desempata dos con el mismo nombre, para que no cambien de escritorio
  const sidOf = new Map();
  const quiet = Number.isFinite(quietMin) && quietMin > 0 ? quietMin : QUIET_DEFAULT_MIN;
  const fileEnd = (f) => { const t = Date.parse(f && f.endAt); return Number.isFinite(t) ? t : null; };
  // la última novedad, para la página y su reloj: quieta más que el umbral, «sin novedades desde las HH:MM»
  const novelty = (a, f) => {
    const at = Date.parse(f.updatedAt);
    if (!Number.isFinite(at)) return;
    a.novedadMs = at;
    a.sinPid = f.pid == null;
    // sin pid, pasadas las 2 h, inactiva: lo mismo que decide el reloj de la página, así la foto no la devuelve atrás
    if (a.sinPid && nowMs - at > sessionState.DEAD_AFTER_MS) {
      a.estado = 'inactiva';
      a.haciendo = `Inactiva: sin novedades desde las ${hhmm(at)}.`;
      delete a.espera;
      return;
    }
    // la parada ya dice desde cuándo; acá sólo cuenta si, sin pid, pasó el tiempo de darla por inactiva
    if (a.estado !== 'parada' && nowMs - at > quiet * 60000) a.callada = `sin novedades desde las ${hhmm(at)}`;
  };
  const agents = [];
  // la historia de cada tarjeta, para cruzarla con el tablero: en la página no van números de historia
  const storyOfAgent = new Map();
  // las corridas que terminaron y esperan entrar de una sesión que siguió con otra cosa
  const closedRuns = [];
  // qué espera del dueño cada corrida de una sesión cerrada, por sesión
  const halfwayOf = new Map();
  for (const h of wip.halfwayItems || []) if (h && h.sid != null && h.kind === 'run') halfwayOf.set(String(h.sid), h);
  const toldOwner = [];
  wip.rows.forEach((row, i) => {
    const d = (wip.details && wip.details[i]) || {};
    const x0 = (wip.extra && wip.extra[i]) || {};
    const f = d.sid != null ? files.get(String(d.sid)) || null : null;
    if (f) used.add(String(d.sid));
    // el trabajo de ahora: un carril o una nota posteriores toman la tarjeta. De una corrida terminada, que va aparte a su
    // columna; de una abierta sin actividad desde entonces, que queda debajo, en pausa, sin hora
    // Lo que la marca o el dueño esperan no se tapa: la corrida sigue con su tarjeta y lo nuevo va como «mientras tanto»
    const keeps = Boolean(x0.mark) || (x0.kind === 'pipeline' && x0.current === 'approve-plan' && realState(x0, d, f).estado === 'firma');
    const replacesClosed = !keeps && replacesClosedRun(x0);
    const replacesOpen = !keeps && replacedByNewer(x0, nowMs);
    const declared = x0.kind === 'loose' || x0.kind === 'note' ? plain(x0.text) : '';
    const runTitle = unnumbered(x0.batch) || unnumbered(x0.title) || declared || plain(row.work) || null;
    const x = replacesClosed || replacesOpen
      ? { kind: x0.meanwhileKind, text: x0.meanwhile, endAt: x0.meanwhileEnd, hourAt: x0.meanwhileDeclaredAt, promiseAt: x0.meanwhileDeclaredAt }
      : x0;
    const replaced = x !== x0;
    if (replacesClosed) closedRuns.push({ titulo: runTitle, quien: row.session, storyId: x0.storyId, stalled: x0.kind === 'stalled' });
    // el archivo manda en lo que sabe: el paso mientras hay pipeline, el trabajo suelto declarado y la espera; lo que no
    // sabe (la entrada a los repos, la nota, la actividad sin marcador) sigue saliendo de /wip
    const knows = !replaced && Boolean(f) && ((x.kind === 'pipeline' && f.step) || x.kind === 'loose');
    const real = realState(x, d, f);
    // lo que espera algo manda también sobre la coordinadora
    const isCoordinator = Boolean(coordinatorSid) && d.sid === coordinatorSid;
    const estado = isCoordinator && real.estado !== 'firma' ? 'coordina' : real.estado;
    // el título es el de la tanda que corre, entero; sin tanda, el de la historia. Sin carril ni nota no hay título.
    const blind = row.work === 'no se ve qué hace' || x.kind === 'activity' || x.kind === 'nomarker';
    const titulo = blind ? null : replaced ? plain(x.text) || null : runTitle;
    // quien espera algo sigue diciendo por qué paso va; la firma sin más sólo se dice si no se sabe qué espera
    const haciendo = knows && f.sentence ? f.sentence : sentenceOf(real.espera ? real.estado === 'firma' ? 'espera' : estado : estado, x, row);
    const a = { nombre: row.session, estado, titulo, haciendo, carpeta: row.folder || null };
    if (real.espera) a.espera = real.espera;
    if (real.parada && estado === 'parada') a.parada = real.parada;
    if (knows && f.step) a.paso = f.step;
    if (titulo && !replaced && unnumbered(x.batch) && unnumbered(x.title)) a.historia = unnumbered(x.title);
    if (replacesOpen) a.enPausa = runTitle;
    // la corrida en pausa sigue abierta: su historia es de esta tarjeta y la fila del tablero no manda
    if (!replacesClosed && x0.storyId) storyOfAgent.set(a, String(x0.storyId));
    // al dueño le toca lo que le espera a él: aprobar un plan o dar el ok de guardar
    if (a.espera === 'que apruebes el plan') toldOwner.push(`Aprobar el plan: ${titulo || haciendo} (${row.session})`);
    if (a.espera === 'el ok para guardar') toldOwner.push(`Dar el ok para guardar: ${titulo || haciendo} (${row.session})`);
    // la promesa que la corrida anotó al arrancar; sin estimado, es también la hora de fin de la que sigue trabajando.
    // La que terminó y espera entrar no la toma: su hora es la de la cola, y sin ella no hay hora (como en /wip)
    const promisedAt = Number.isFinite(x.promisedAt) ? x.promisedAt : null;
    const done = x.kind === 'entering' || x.kind === 'stalled' || x.kind === 'finished';
    const ownEnd = knows ? fileEnd(f) : Number.isFinite(x.endAt) ? x.endAt : null;
    const rawEnd = x.mark ? null : ownEnd != null ? ownEnd : done ? null : promisedAt;
    // la hora que ya no dice nada se dice en palabras, no como atraso: la del trabajo que cambió y la vieja
    const verdict = x.kind === 'pipeline' || x.kind === 'loose' || x.kind === 'note'
      ? hourVerdict({ endAt: rawEnd, hourAt: x.hourAt, activityAt: x.activityAt, nowMs, run: x.kind === 'pipeline' }) : null;
    // una hora de fin que pasó hace más de STALE_END_MS ya no dice nada: se trata como si no hubiera hora
    const endAt = !verdict && Number.isFinite(rawEnd) && nowMs - rawEnd <= STALE_END_MS ? rawEnd : null;
    // lo que terminó y espera la cola no está atrasado: su hora pasada no se muestra. Los pedidos sin encolar no esperan
    // la cola: siguen con su atraso.
    // se mira la hora sin el corte de STALE_END_MS: esperar la cola más de 12 h sigue siendo esperar
    const waiting = Number.isFinite(x.endAt) && x.endAt < nowMs && x.kind === 'entering';
    // una corrida marcada dice su marca en lugar de la hora
    if (x.mark) { a.marca = x.mark; a.haciendo = x.mark; a.termina = x.mark; }
    // sin hora, se dice que no la hay: un texto en el lugar de la hora parece una hora
    else if (verdict) a.termina = verdict;
    else if (waiting) a.termina = 'esperando entrar';
    else if (estado !== 'coordina' && endAt == null) a.termina = 'sin hora estimada';
    const meanwhile = replaced ? '' : plain(x.meanwhile);
    // el «mientras tanto» es de ahora: tocado en la última hora y después de que arrancó la corrida
    const current = !Number.isFinite(x.meanwhileAt) || (nowMs - x.meanwhileAt <= LOOSE_STALE_MS && !(Number.isFinite(x.runStartedAt) && x.meanwhileAt < x.runStartedAt));
    if (meanwhile && current) { a.mientras = meanwhile; a.mientrasEstado = 'trabajando'; }
    if (x.steps) { a.pasos = x.steps; a.avance = x.progress; }
    a.fin = a.termina ? { hora: a.termina, dif: '', cls: '' } : null;
    if (endAt != null && !waiting) {
      // sin historia, la promesa es del trabajo que se declaró, y de esa declaración: otro arreglo u otra nota de la misma
      // sesión no la hereda, ni una nota nueva con el mismo texto
      const key = `${d.sid || row.session}|${x.storyId || `${x.kind || ''}:${x.text || ''}${Number.isFinite(x.promiseAt) ? `@${x.promiseAt}` : ''}`}`;
      // la promesa propia de la corrida gana a la primera hora vista: dos corridas vistas a la vez no comparten atraso
      if (promisedAt != null && !done) kept[key] = { at: promisedAt, seen: nowMs };
      else if (!kept[key]) kept[key] = { at: endAt, seen: nowMs };
      kept[key].seen = nowMs;
      a.estimadaIso = localIso(kept[key].at);
      a.pronosticoIso = localIso(endAt);
      if (x.late) a.atrasada = true;
      // con la hora de su paso, el atraso se mide contra ésa, y lo prometido queda como dato
      const reference = x.hourStep ? endAt : kept[key].at;
      if (x.hourStep) a.horaPorque = `recalculada al pasar a ${x.hourStep}`;
      // la hora pasó y no terminó: el atraso es el de ahora contra la prometida, no el de la hora vieja
      // (o contra la hora vieja, si la prometida todavía no llegó: una hora pasada nunca está en hora)
      if (endAt < nowMs) { a.atrasoMin = Math.max(1, Math.round((nowMs - Math.min(reference, endAt)) / 60000)); a.atrasada = true; }
      // la hora y su diferencia contra la prometida se calculan acá, una vez: todas las partes de la página dicen esto
      const dd = a.atrasoMin > 0 ? a.atrasoMin : Math.round((endAt - reference) / 60000);
      a.fin = a.atrasoMin > 0 || dd > 15 ? { hora: dayHhmm(endAt), dif: `+${difTxt(dd)} tarde`, cls: 'late' }
        : dd < -15 ? { hora: dayHhmm(endAt), dif: `${difTxt(dd)} antes`, cls: 'early' }
          : { hora: dayHhmm(endAt), dif: 'en hora', cls: 'ontime' };
    }
    a.tipo = x.kind || null;
    // sin pipeline, lo que dice su propia conversación
    const said = transcripts && NO_RUN_KINDS.has(x.kind) && d.sid != null ? transcripts.get(String(d.sid)) : null;
    if (said) saySession(a, said, x.lastAt);
    if (f && (QUIET_STATES.has(a.estado) || a.estado === 'parada')) novelty(a, f);
    sidOf.set(a, d.sid);
    agents.push(a);
  });
  // la coordinadora quieta no está libre: coordina a las demás. Una libre que espera algo, por su archivo o por lo que dice
  // Claude de ella, espera
  (wip.free || []).forEach((name, i) => {
    const sid = (wip.freeSids || [])[i];
    const f = sid != null ? files.get(String(sid)) || null : null;
    if (f) used.add(String(sid));
    const real = realState({}, { status: (wip.freeStatus || [])[i] }, f);
    const waits = real.estado === 'firma';
    const a = name === coordinatorName && !waits ? { nombre: name, estado: 'coordina', haciendo: 'Coordina las sesiones de esta máquina' }
      : waits ? { nombre: name, estado: 'firma', espera: real.espera, haciendo: (f && f.sentence) || 'Sin trabajo' }
        : { nombre: name, estado: 'libre', haciendo: 'Sin trabajo' };
    if (waits && f) novelty(a, f);
    sidOf.set(a, sid);
    agents.push(a);
  });
  // las sesiones que sólo tienen su archivo: Codex sin marcador, o una que se cayó sin avisar. Una de Claude viva que no
  // está en /wip está sin uso hace horas: /wip la cuenta mejor y no se dibuja de nuevo. Inactiva de más de un día, no se
  // dibuja (sigue en disco)
  const fromFile = new Set();
  for (const [sid, f] of files) {
    if (used.has(sid)) continue;
    const stale = sessionState.isStale(f, { now: nowMs, ...(isAlive ? { isAlive } : {}) });
    const at = Date.parse(f.updatedAt);
    if (stale && (!Number.isFinite(at) || nowMs - at > SESSION_FILE_KEEP_MS)) continue;
    if (f.tool === 'claude' && !stale && !f.waitingForOwner) continue;
    const a = { nombre: f.name || cxNames.get(sid) || sid.slice(0, 8), titulo: null, carpeta: null };
    if (stale) {
      a.estado = 'inactiva';
      a.haciendo = `Inactiva: sin novedades desde las ${Number.isFinite(at) ? hhmm(at) : '—'}.`;
    } else {
      // la corrida de esta sesión: Codex no tiene archivo de sesión de Claude, y su marcador sale como de una sesión cerrada
      const h = halfwayOf.get(sid);
      const awaits = h && h.awaits ? h.awaits : f.step === PLAN_STEP_NAME ? 'plan' : null;
      const real = realState(awaits === 'save' ? { kind: 'finished' } : { kind: 'pipeline', current: awaits === 'plan' ? 'approve-plan' : null }, {}, f);
      const mark = h && h.mark ? h.mark : null;
      const works = Boolean(f.step) || (f.sentence && f.sentence !== sessionState.NO_PIPELINE) || f.busy === true || Boolean(awaits) || Boolean(mark);
      a.estado = real.estado === 'firma' ? 'firma' : works ? real.estado : 'libre';
      a.haciendo = works ? (awaits === 'save' ? 'Terminó: espera el ok para guardar.' : f.sentence) : f.waitingForOwner ? (f.sentence || 'Sin trabajo') : 'Sin trabajo';
      if (real.espera) a.espera = real.espera;
      if (a.estado === 'parada') a.parada = real.parada;
      if (f.step) a.paso = f.step;
      if (a.espera === 'que apruebes el plan' || a.espera === 'el ok para guardar') {
        a.titulo = h ? unnumbered(h.text) : a.haciendo;
        toldOwner.push(`${a.espera === 'el ok para guardar' ? 'Dar el ok para guardar' : 'Aprobar el plan'}: ${a.titulo} (${a.nombre})`);
      }
      if (h && h.storyId) storyOfAgent.set(a, String(h.storyId));
      if (a.estado !== 'libre') {
        const e = mark ? null : fileEnd(f);
        // una corrida marcada dice su marca en lugar de la hora, como las que salen de /wip
        if (mark) { a.marca = mark; a.haciendo = mark; a.termina = mark; a.fin = { hora: mark, dif: '', cls: '' }; }
        else if (e != null) { a.pronosticoIso = localIso(e); a.fin = { hora: dayHhmm(e), dif: '', cls: '' }; } else { a.termina = 'sin hora estimada'; a.fin = { hora: a.termina, dif: '', cls: '' }; }
        a.tipo = 'archivo';
        // el trabajo que declaró la sesión es su título, como en Claude: el encargo no lo tapa
        if (!a.titulo && !f.step && !awaits && f.sentence && f.sentence !== sessionState.NO_PIPELINE && !mark) a.titulo = plain(f.sentence) || null;
        const said = transcripts && !f.step && !awaits && !mark ? transcripts.get(sid) : null;
        if (said) saySession(a, said, Date.parse(f.updatedAt));
        novelty(a, f);
        fromFile.add(sid);
      }
    }
    sidOf.set(a, sid);
    agents.push(a);
  }
  // un orden fijo para las tarjetas y los escritorios: la coordinadora primero y después por nombre, y entre nombres iguales
  // por sesión. Con más sesiones que escritorios, se eligen primero las que trabajan; entre los elegidos el orden sigue
  // siendo ése, así nadie cambia de lugar cuando otro cambia de estado
  const bySession = (p, q) => { const s = String(sidOf.get(p)); const t = String(sidOf.get(q)); return s < t ? -1 : s > t ? 1 : 0; };
  const byCoordinatorThenName = (p, q) => (q.estado === 'coordina') - (p.estado === 'coordina') || String(p.nombre).localeCompare(String(q.nombre), 'es') || bySession(p, q);
  agents.sort(byCoordinatorThenName);
  if (agents.length > MAX_DESKS) {
    const rank = (a) => (a.estado === 'coordina' ? 0 : a.estado === 'trabajando' || a.estado === 'prueba' ? 1 : a.estado === 'firma' ? 2 : a.estado === 'parada' || a.estado === 'espera' ? 3 : 4);
    const chosen = new Set([...agents].sort((p, q) => rank(p) - rank(q) || byCoordinatorThenName(p, q)).slice(0, MAX_DESKS));
    agents.sort((p, q) => Number(chosen.has(q)) - Number(chosen.has(p)) || byCoordinatorThenName(p, q));
  }
  agents.forEach((a, i) => { a.orden = i; });

  // lo pendiente es el trabajo de las filas de /wip, no la coordinadora quieta
  const items = agents.filter((a) => a.tipo).map((a) => ({
    titulo: a.titulo || a.haciendo, quien: a.nombre, estimadaIso: a.estimadaIso || null, pronosticoIso: a.pronosticoIso || null, fin: a.fin,
    estado: a.tipo === 'stalled' ? 'riesgo' : a.estado === 'espera' ? 'espera' : a.estado === 'firma' ? 'firma' : 'curso',
    ...(a.marca ? { marca: a.marca } : {}),
  }));
  for (const s of signatures) {
    if (!s || !s.title) continue;
    const at = Number.isFinite(s.at) ? s.at : null;
    items.push({ titulo: `Firma: ${plain(s.title)}`, quien: 'vos', estado: 'firma', estimadaIso: at == null ? null : localIso(at), pronosticoIso: null, fin: at == null ? null : { hora: dayHhmm(at), dif: '', cls: '' } });
  }
  // lo que quedó a medio camino: qué era, en llano, y qué hacer con eso. Lo que espera al dueño es su firma, y lo dejado a
  // propósito sigue en curso: esas no se ofrecen limpiar
  const halfwayCards = [];
  for (const h of wip.halfwayItems || []) {
    // la corrida de una sesión que se dibuja desde su archivo no quedó a medio camino: está trabajando
    if (h.sid != null && fromFile.has(String(h.sid))) continue;
    const accion = h.cleanAfter === 'unknown' ? 'No se sabe desde cuándo se puede limpiar: preguntale a la coordinadora'
      : Number.isFinite(h.cleanAfter) ? `Se puede limpiar después de las ${hhmm(h.cleanAfter)}` : 'Ya se puede limpiar: pedíselo a la coordinadora';
    // el de una corrida es el título de su historia: lo escribió una persona y queda entero
    const titulo = (h.kind === 'run' ? unnumbered(h.text) : plain(h.text)) || 'Un trabajo sin nombre';
    const espera = h.awaits === 'plan' ? 'que apruebes el plan' : h.awaits === 'save' ? 'el ok para guardar' : null;
    if (espera || h.mark) {
      const it = { titulo, quien: h.name || '—', estado: espera ? 'firma' : 'curso', estimadaIso: null, pronosticoIso: null, fin: null, ...(h.mark ? { marca: h.mark } : {}), ...(espera ? { espera } : {}) };
      items.push(it);
      halfwayCards.push({ columna: espera ? 'firma' : 'curso', card: { titulo, quien: it.quien, hora: '', ...(espera ? { espera } : {}), ...(h.mark ? { marca: h.mark } : {}) }, storyId: h.storyId });
      if (espera) toldOwner.push(`${h.awaits === 'save' ? 'Dar el ok para guardar' : 'Aprobar el plan'}: ${titulo} (${it.quien})`);
      continue;
    }
    items.push({ titulo, quien: '—', estado: 'riesgo', estimadaIso: null, pronosticoIso: null, fin: null, accion });
  }
  // «te toca» es sólo lo que pide una firma o una decisión del dueño: lo demás lo hace cada sesión
  const teToca = [...signatures.filter((s) => s && s.title).map((s) => `Firmar: ${plain(s.title)}`), ...toldOwner];
  const kanban = buildKanban({ agents, storyOfAgent, closedRuns, halfwayCards, items, signatures, board, prAnswers });
  const meta = {
    actualizado: hhmm(nowMs),
    teToca,
    extra: Math.max(0, agents.length - MAX_DESKS),
    puestos: deskSlots(agents.length),
    quietMin: quiet,
  };
  // la tabla dice lo mismo que las tarjetas, en llano
  const rows = agents.filter((a) => a.tipo).map((a) => ({ work: a.titulo || '', state: a.mientras ? `${a.haciendo} Mientras tanto: ${a.mientras}.` : a.haciendo, end: a.fin ? a.fin.hora + (a.fin.dif ? ` · ${a.fin.dif}` : '') : '', session: a.nombre, folder: a.carpeta || '' }));
  return { data: { agents, items, kanban, meta, rows, free: wip.free || [], unreadable: wip.unreadable || [] }, promises: kept };
}

// La hora de una tarjeta, la misma de la persona.
const cardHour = (fin) => (fin ? fin.hora + (fin.dif ? ` · ${fin.dif}` : '') : '');
const firstWord = (t) => String(t || '').trim().split(/\s+/)[0].toLowerCase();

/**
 * El panel de pendientes: cinco columnas siempre en el mismo orden. Las tres primeras salen del estado real (una tarjeta
 * por cada sesión con trabajo, lo que quedó de las sesiones cerradas y las firmas del registro) y el tablero de la
 * coordinadora suma lo que la máquina no sabe. Una fila de una historia con corrida no aporta estado: aporta su nota. Una
 * con pedido va adonde diga el pedido; si la consulta falló, queda donde dice el archivo.
 */
function buildKanban({ agents, storyOfAgent, closedRuns, halfwayCards, items, signatures, board, prAnswers }) {
  const cols = KANBAN_COLUMNS.map(([id, nombre]) => ({ id, nombre, tarjetas: [] }));
  const col = (id) => cols.find((c) => c.id === id);
  const byStory = new Map();
  const people = new Set();
  for (const a of agents) {
    const card = { titulo: a.titulo || a.haciendo, quien: a.nombre, hora: cardHour(a.fin), ...(a.fin && a.fin.cls ? { cls: a.fin.cls } : {}), ...(a.espera ? { espera: a.espera } : {}), ...(a.marca ? { marca: a.marca } : {}), ...(a.parada ? { motivo: a.parada } : {}) };
    let id = null;
    if (a.estado === 'firma') id = 'firma';
    // la marcada va a «En curso» salvo que espere firma, con la sesión viva o cerrada
    else if (a.tipo && a.estado === 'espera' && !a.marca) id = 'entrando';
    else if (a.tipo && a.estado !== 'inactiva' && a.estado !== 'libre') id = 'curso';
    if (!id) continue;
    if (a.tipo === 'stalled') card.marca = 'riesgo';
    col(id).tarjetas.push(card);
    people.add(firstWord(a.nombre));
    if (storyOfAgent.has(a)) byStory.set(storyOfAgent.get(a), card);
  }
  for (const r of closedRuns) {
    // con los pedidos sin encolar no está esperando la cola: hay que encolarlos
    const card = r.stalled ? { titulo: r.titulo, quien: r.quien, hora: 'sin hora estimada', marca: 'riesgo', motivo: 'ningún pedido está en la cola' } : { titulo: r.titulo, quien: r.quien, hora: 'esperando entrar' };
    col('entrando').tarjetas.push(card);
    if (r.storyId) byStory.set(String(r.storyId), card);
  }
  for (const s of signatures) {
    if (!s || !s.title) continue;
    col('firma').tarjetas.push({ titulo: `Firma: ${plain(s.title)}`, quien: 'vos', hora: Number.isFinite(s.at) ? dayHhmm(s.at) : '' });
  }
  for (const h of halfwayCards) {
    col(h.columna).tarjetas.push(h.card);
    if (h.storyId) byStory.set(String(h.storyId), h.card);
  }
  for (const f of (board && board.filas) || []) {
    if (f.historia && byStory.has(f.historia)) {
      if (f.nota) byStory.get(f.historia).nota = f.nota;
      continue;
    }
    // la fila de una persona que ya tiene tarjeta del estado real no se duplica: «Ana» no es «Ananda»
    if (!f.pedido && f.quien && ['firma', 'curso', 'entrando'].includes(f.columna) && people.has(firstWord(f.quien))) continue;
    const card = { titulo: f.titulo, quien: f.quien, hora: f.fin, ...(f.nota ? { nota: f.nota } : {}), ...(f.marca ? { marca: f.marca } : {}), ...(f.grupo ? { grupo: f.grupo } : {}) };
    let id = f.columna;
    const pr = f.pedido ? (prAnswers.get(`${f.pedido.repo}#${f.pedido.numero}`) || {}).pr : null;
    if (pr && pr.state === 'merged') {
      id = 'hechos';
      const at = Date.parse(pr.mergedAt);
      card.hora = Number.isFinite(at) ? dayHhmm(at) : 'sin hora';
    } else if (pr && pr.state === 'open') {
      id = 'entrando';
      if (pr.draft === true) card.motivo = 'en borrador';
      else if (offQueueOf(pr)) card.motivo = 'fuera de la cola';
    } else if (pr) card.motivo = 'se cerró sin entrar';
    col(id).tarjetas.push(card);
  }
  return { columnas: cols, medioCamino: items.filter((i) => i.estado === 'riesgo' && i.accion).map((i) => ({ titulo: i.titulo, quien: i.quien, accion: i.accion })) };
}

// El tablero que escribe la coordinadora en `<estado>/coordination/tablero.json`: `pendientes` (titulo, estado, grupo,
// orden, quien, nota, estimadaIso, pronosticoIso, realIso, termina, historia, pedido: {repo, numero}) y `meta`
// (actualizado, resumen, teToca). Sus `agentes` no se usan: los escritorios salen de /wip.
const BOARD_GROUPS = ['Hoy', 'Esta semana', 'La semana que viene', 'Más adelante'];
// Las columnas del panel de pendientes, y adónde va cada estado del tablero; uno desconocido, a lo que no arrancó.
const KANBAN_COLUMNS = [['firma', 'Tu firma'], ['curso', 'En curso'], ['entrando', 'Esperan entrar'], ['sinEmpezar', 'Sin empezar'], ['hechos', 'Hechos']];
const BOARD_COLUMN = { firma: 'firma', curso: 'curso', riesgo: 'curso', entrando: 'entrando', espera: 'sinEmpezar', 'sin-empezar': 'sinEmpezar', hecho: 'hechos' };
const BOARD_TEXT_MAX = 300;
const text = (v) => (typeof v === 'string' ? v.trim().slice(0, BOARD_TEXT_MAX) : '');
// la hora local de la página del tablero, 'YYYY-MM-DDTHH:MM', como la dice la oficina: «mar 18:00»
const boardHour = (v) => {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(typeof v === 'string' ? v : '');
  if (!m) return '';
  const ms = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  return Number.isFinite(ms) ? dayHhmm(ms) : '';
};

// Una historia y un pedido llegan a cruzarse con una corrida y a una consulta: sólo con su forma. Los ids de historia no
// son sólo números (8.85-E, OC-5, VH-1b) y Azure admite espacios en el nombre de un repo. Lo que no tiene la forma se dice.
const STORY_ID = /^[\p{L}\p{N}]+(?:[.\-_][\p{L}\p{N}]+)*$/u;
const REPO_NAME = /^[\w.-][\w .-]*(?:\/[\w.-][\w .-]*)?$/;
function boardPr(v) {
  if (!v || typeof v !== 'object' || typeof v.repo !== 'string' || !REPO_NAME.test(v.repo.trim())) return null;
  const numero = typeof v.numero === 'string' && /^\d+$/.test(v.numero.trim()) ? Number(v.numero) : v.numero;
  return Number.isInteger(numero) && numero > 0 ? { repo: v.repo.trim(), numero } : null;
}

/** Las filas del tablero para el kanban, sin leer nada; `raw` es el archivo ya leído. Tira si no tiene la forma. */
function buildBoard(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('no es un objeto');
  if (raw.pendientes != null && !Array.isArray(raw.pendientes)) throw new Error('«pendientes» no es una lista');
  const meta = raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta) ? raw.meta : {};
  const rows = (raw.pendientes || []).filter((p) => p && typeof p === 'object' && text(p.titulo));
  // los grupos de la semana van en su orden; los demás, después, en el orden en que aparecen. Dentro de cada grupo, por su orden
  const others = [];
  for (const p of rows) { const g = text(p.grupo); if (!BOARD_GROUPS.includes(g) && !others.includes(g)) others.push(g); }
  const place = (p) => { const g = text(p.grupo); const i = BOARD_GROUPS.indexOf(g); return i < 0 ? BOARD_GROUPS.length + others.indexOf(g) : i; };
  const ord = (p) => (Number.isFinite(p.orden) ? p.orden : Infinity);
  rows.sort((a, b) => place(a) - place(b) || ord(a) - ord(b));
  const avisos = [];
  const filas = rows.map((p) => {
    const estado = text(p.estado);
    const historia = typeof p.historia === 'string' && STORY_ID.test(p.historia.trim()) ? p.historia.trim() : null;
    if (p.historia != null && p.historia !== '' && !historia) avisos.push(`el tablero: la fila «${text(p.titulo)}» nombra una historia que no reconozco: no se cruzó con su ejecución`);
    const pedido = boardPr(p.pedido);
    if (p.pedido != null && !pedido) avisos.push(`el tablero: la fila «${text(p.titulo)}» nombra un pedido que no reconozco: no se consultó`);
    return {
      titulo: text(p.titulo), quien: text(p.quien), nota: text(p.nota),
      fin: estado === 'hecho' ? boardHour(p.realIso) || 'sin hora' : text(p.termina) || boardHour(p.pronosticoIso) || boardHour(p.estimadaIso) || 'sin hora estimada',
      estado, grupo: text(p.grupo), columna: Object.prototype.hasOwnProperty.call(BOARD_COLUMN, estado) ? BOARD_COLUMN[estado] : 'sinEmpezar', marca: estado === 'riesgo' ? 'riesgo' : null, historia, pedido,
    };
  });
  return {
    actualizado: boardHour(meta.actualizado) || text(meta.actualizado),
    resumen: text(meta.resumen),
    teToca: (Array.isArray(meta.teToca) ? meta.teToca : []).map(text).filter(Boolean),
    filas,
    avisos,
  };
}

// El tablero de la coordinadora, y cuándo se escribió. Sin archivo, no hay tablero; uno roto o ilegible se dice en `problem`.
function readBoard(file) {
  let raw;
  let writtenAt = null;
  try { raw = fs.readFileSync(file, 'utf8'); writtenAt = fs.statSync(file).mtimeMs; } catch (e) {
    return e.code === 'ENOENT' ? { board: null } : { board: null, problem: `el tablero de la coordinadora no se pudo leer (${e.code || e.message})` };
  }
  try { return { board: buildBoard(JSON.parse(raw)), writtenAt }; } catch (e) {
    return { board: null, problem: `el tablero de la coordinadora no se pudo leer (${e.message})` };
  }
}

// Un módulo de la librería con sus importaciones relativas cambiadas por el nombre con que figura en MODULES: un
// módulo que viene de una dirección `data:` no tiene carpeta contra la cual resolverlas.
function moduleSource(key, rel) {
  const src = fs.readFileSync(path.join(VENDOR, rel), 'utf8');
  if (key === 'three') return src;
  const dir = path.posix.dirname(key);
  return src.replace(/(from\s*|import\s*)(['"])(\.{1,2}\/[^'"]+)\2/g, (all, kw, q, spec) => `${kw}${q}${path.posix.normalize(path.posix.join(dir, spec))}${q}`);
}

// La foto fija lleva la librería adentro; la página del proceso local la pide a su dirección, con el token.
function importMap(live = null) {
  const imports = {};
  for (const [key, rel] of Object.entries(MODULES)) {
    imports[key] = live ? `/modules/${encodeURIComponent(key)}?t=${live.token}` : `data:text/javascript;base64,${Buffer.from(moduleSource(key, rel)).toString('base64')}`;
  }
  return JSON.stringify({ imports });
}

/** La página entera, con los datos; con `live`, además el token para recibir las fotos nuevas del proceso local. */
function page(data, { live = null } = {}) {
  const safe = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
  return fs.readFileSync(TEMPLATE, 'utf8')
    // los datos van últimos: un texto de una sesión que diga el nombre de otro marcador no lo reemplaza
    .replace('__OFFICE_IMPORTMAP__', () => importMap(live).replace(/</g, '\\u003c'))
    .replace('__OFFICE_LIVE__', () => safe(live ? { token: live.token } : null))
    .replace('__OFFICE_DATA__', () => safe(data));
}

// Una clave de la configuración, con el mismo lector que el comando /org-site: sale 0 con el valor, 3 si no está y 2 si
// la configuración no se pudo leer.
function readConfigKey(key) {
  const r = require('child_process').spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lib', 'tycon-config.js'), 'get', key], { input: '', encoding: 'utf8', timeout: 5000 });
  return { code: r.status == null ? 2 : r.status, out: r.status === 0 ? r.stdout : (r.stderr || r.stdout || (r.error && r.error.message) || '') };
}
// La dirección del sitio de la organización.
const readSiteUrl = () => readConfigKey('site.url');
// El umbral de la sesión callada, en minutos (decisión 20).
const readQuietMinutes = () => readConfigKey('office.quiet_minutes');

// Las horas prometidas guardadas. Sin archivo, ninguna; un archivo roto o ilegible se dice en `problem`: tomarlo por
// vacío haría medir los atrasos contra la hora de ahora sin avisar.
function readPromises(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    return e.code === 'ENOENT' ? { promises: {} } : { promises: {}, problem: `las horas prometidas no se pudieron leer (${e.code || e.message})` };
  }
  try {
    const p = JSON.parse(text);
    if (p && typeof p === 'object' && !Array.isArray(p)) return { promises: p };
  } catch { /* abajo: lo mismo que un archivo que no es un objeto */ }
  return { promises: {}, problem: 'las horas prometidas no se pudieron leer (el archivo está roto): el atraso se mide desde ahora' };
}

// ¿Un carril o una nota posteriores toman la tarjeta de esta corrida terminada?
const replacesClosedRun = (x) => (x.kind === 'entering' || x.kind === 'stalled') && Number.isFinite(x.meanwhileAt) && Number.isFinite(x.closedAt) && x.meanwhileAt > x.closedAt;

// Las historias con tarjeta del estado real: las de cada fila de /wip y lo que quedó de una sesión cerrada esperando al
// dueño o marcado. Son las mismas que el kanban cruza con el tablero; lo demás que quedó a medio camino no tiene tarjeta, y
// su fila manda.
const storiesWithCard = (wip) => new Set([
  ...(wip.extra || []).map((x) => x && x.storyId),
  ...(wip.halfwayItems || []).filter((h) => h && (h.awaits || h.mark)).map((h) => h.storyId),
].filter(Boolean).map(String));

// Los pedidos que nombra el tablero, salvo los de una fila cuya historia tiene corrida en esta máquina: esa manda. Se
// preguntan sólo ésos (la consulta de la oficina viva los recuerda un minuto). Lo que falla queda en `problems`.
async function askBoardPrs(board, wip, opts, problems) {
  const answers = new Map();
  const runs = storiesWithCard(wip);
  const seen = new Set();
  const asked = [];
  for (const f of (board && board.filas) || []) {
    if (!f.pedido || (f.historia && runs.has(f.historia))) continue;
    const key = `${f.pedido.repo}#${f.pedido.numero}`;
    if (seen.has(key)) continue;
    seen.add(key);
    asked.push({ root: `pedido:${key}`, repo: f.pedido.repo, numero: f.pedido.numero, identity: identityOfRepo(f.pedido.repo, wip) });
  }
  if (!asked.length) return answers;
  const replies = await (opts.queryPrs || readPrs)(asked);
  asked.forEach((q, i) => {
    const r = replies[i] || { error: 'sin respuesta' };
    answers.set(`${q.repo}#${q.numero}`, r);
    if (r.error) problems.push(`el pedido ${q.numero} de ${q.repo}: ${r.error}`);
  });
  return answers;
}

// A quién preguntarle por un pedido: el repo de una corrida de esta máquina, por su origin, o el que declara el equipo.
function identityOfRepo(name, wip) {
  const wanted = name.toLowerCase();
  const local = (wip.wanted || []).find((q) => q.kind && String(q.name).toLowerCase() === wanted);
  if (local) return identityOf(local);
  // `wanted` sólo trae las corridas cerradas: una abierta se reconoce por el origin de su carpeta
  for (const root of wip.runRepos || []) {
    const q = remoteOfFolder(root);
    if (q && q.kind && String(q.name).toLowerCase() === wanted) return identityOf(q);
  }
  return require(path.join(ROOT, 'scripts', 'lib', 'platform', 'platform.js')).identityByName(name);
}

// Lo que dice la conversación de las sesiones sin corrida abierta, por sesión. Nada de esto se guarda en disco.
function readTranscripts(wip, states, { home, nowMs, projectsDir, codexHome }, problems) {
  const out = new Map();
  const dir = projectsDir || path.join(claudeDir(home), 'projects');
  const say = (sid, file, name) => {
    const r = file ? readTranscript(file, { now: nowMs }) : { encargo: null, haciendoAhora: null, ultimaAccion: null, lastWriteMs: null, problem: null };
    out.set(String(sid), r);
    if (r.problem) problems.push(`la conversación de ${name}: ${r.problem}`);
  };
  (wip.rows || []).forEach((row, i) => {
    const x = (wip.extra && wip.extra[i]) || {};
    const d = (wip.details && wip.details[i]) || {};
    // una corrida terminada tapada por un carril ya no es la tarjeta: la sesión dice lo suyo como una sin corrida
    if ((!NO_RUN_KINDS.has(x.kind) && !(replacesClosedRun(x) && !x.mark)) || d.sid == null) return;
    const safe = SAFE_SID.test(String(d.sid)) && typeof x.cwd === 'string' && x.cwd;
    say(d.sid, safe ? path.join(dir, x.cwd.replace(/[^A-Za-z0-9-]/g, '-'), `${d.sid}.jsonl`) : null, row.session);
  });
  for (const f of states) {
    if (f.tool === 'codex' && !f.step && !out.has(String(f.session))) say(f.session, codexTranscript(codexHome || path.join(home, '.codex'), f.session, { now: nowMs }), f.name || String(f.session).slice(0, 8));
  }
  return out;
}

// Lo que se dice de una sesión sin corrida abierta, de su conversación: su oración es lo que está haciendo; su título, el
// carril o la nota si hay, y si no, el encargo. Sin nada legible, desde cuándo no hay novedades.
function saySession(a, said, fallbackAt) {
  if (said.encargo) a.encargo = said.encargo;
  if (said.haciendoAhora) a.haciendoAhora = said.haciendoAhora;
  if (said.ultimaAccion) a.ultimaAccion = said.ultimaAccion;
  if (!a.titulo && said.encargo) a.titulo = said.encargo;
  if (said.haciendoAhora) { a.haciendo = said.haciendoAhora; return; }
  const at = [said.lastWriteMs, fallbackAt].find(Number.isFinite);
  a.haciendo = at === undefined ? 'Sin novedades.' : `Sin novedades desde las ${hhmm(at)}`;
}

/** Lee todo lo de esta máquina y arma los datos; guarda las promesas al día. */
async function collect(opts = {}) {
  const home = opts.home || os.homedir();
  const sdir = opts.stateDir || stateDir(home);
  const nowMs = opts.now ? Date.parse(opts.now) : Date.now();
  const wip = await wipNow(opts);
  const problems = [];
  let signatures = [];
  try { signatures = readPending(home); } catch (e) { problems.push(`las firmas pendientes no se pudieron leer: ${e.message}`); }
  const des = designacionVigente({ dir: sdir });
  if (des && des.error) problems.push(`no se sabe cuál es la coordinadora: ${des.error}`);
  const coordinatorSid = des && des.sesion ? des.sesion : null;
  let coordinatorName = null;
  if (coordinatorSid) {
    const s = sessionsBySid(opts.sessionsDir || path.join(claudeDir(home), 'sessions'), [], null).get(coordinatorSid);
    coordinatorName = s && s.name ? s.name : null;
  }
  const file = path.join(sdir, 'office', 'promises.json');
  const saved = readPromises(file);
  if (saved.problem) problems.push(saved.problem);
  // los archivos de estado de cada sesión; uno que no se puede usar se dice, y esa sesión sale como la deduce /wip
  const ss = sessionState.readAll(sdir);
  problems.push(...ss.problems);
  const cxNames = ss.states.some((s) => s.tool === 'codex' && !s.name) ? codexNames(opts.codexHome || path.join(home, '.codex'), problems) : new Map();
  // el umbral de la sesión callada: un número entero de minutos, o el de por defecto
  let q;
  try { q = await (opts.quietMinutes || readQuietMinutes)(); } catch (e) { q = { code: 2, out: e.message }; }
  const qn = q && q.code === 0 ? Number(String(q.out || '').trim()) : NaN;
  const quietMin = Number.isInteger(qn) && qn > 0 ? qn : QUIET_DEFAULT_MIN;
  if (q && q.code === 2) problems.push(`el umbral de la sesión callada no se pudo leer: ${String(q.out || '').trim().split('\n')[0] || 'sin motivo'}; uso ${QUIET_DEFAULT_MIN} min`);
  else if (q && q.code === 0 && quietMin !== qn) problems.push(`office.quiet_minutes no es un número de minutos (${String(q.out || '').trim().slice(0, 40)}); uso ${QUIET_DEFAULT_MIN} min`);
  const board = readBoard(path.join(sdir, 'coordination', 'tablero.json'));
  if (board.problem) problems.push(board.problem);
  if (board.board) problems.push(...board.board.avisos);
  const prAnswers = await askBoardPrs(board.board, wip, opts, problems);
  const transcripts = opts.noTranscripts ? null : readTranscripts(wip, ss.states, { home, nowMs, projectsDir: opts.projectsDir, codexHome: opts.codexHome }, problems);
  const { data, promises } = buildOffice({ wip, signatures, coordinatorSid, coordinatorName, promises: saved.promises, nowMs, sessionFiles: ss.states, codexNames: cxNames, quietMin, board: board.board, prAnswers, transcripts });
  // lo del tablero que no es una fila: su resumen, lo que dice que le toca al dueño y cuándo se escribió
  data.tablero = board.board ? { actualizado: board.board.actualizado, resumen: board.board.resumen, teToca: board.board.teToca } : null;
  if (board.board && Number.isFinite(board.writtenAt)) data.kanban.escrito = `Tablero escrito a las ${hhmm(board.writtenAt)}${nowMs - board.writtenAt > quietMin * 60000 ? ' (vieja)' : ''}`;
  data.unreadable.push(...problems);
  // el enlace al sitio, sólo con una dirección web: cualquier otra cosa no se muestra
  let site;
  try { site = await (opts.siteUrl || readSiteUrl)(); } catch (e) { site = { code: 2, out: e.message }; }
  const url = site.code === 0 ? String(site.out || '').trim() : '';
  if (/^https?:\/\/\S+$/i.test(url)) data.meta.sitio = url;
  else if (site.code === 2) data.unreadable.push(`la dirección del sitio no se pudo leer: ${String(site.out || '').trim().split('\n')[0] || 'sin motivo'}`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // entero y después renombrado: otro lector (la foto fija y el proceso vivo leen el mismo) nunca lo ve a medias
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(promises, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (e) { data.unreadable.push(`las horas prometidas no se pudieron guardar (${e.code || e.message}): el atraso se mide contra la hora de ahora`); }
  return data;
}

// Abre un archivo o una dirección en el navegador, sin shell: en Windows, `rundll32` recibe la ruta como un solo
// argumento, así un `&`, un `|` o un `^` de la ruta no corren otra orden.
function openFile(target, { platform = process.platform, spawn: run = spawn } = {}) {
  const [cmd, args] = platform === 'darwin' ? ['open', [target]] : platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', target]] : ['xdg-open', [target]];
  const child = run(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => process.stderr.write(`office.js: no pude abrirla; abrila a mano: ${target}\n`));
  child.unref();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// El proceso del candado contesta en 1 s, con su pid.
function answers(lock) {
  return new Promise((resolve) => {
    if (!lock || !Number.isInteger(lock.pid) || !Number.isInteger(lock.port) || !isAlive(lock.pid)) { resolve(false); return; }
    const req = require('http').get({ host: '127.0.0.1', port: lock.port, path: `/health?t=${lock.token}`, headers: { host: `127.0.0.1:${lock.port}` }, timeout: 1000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(res.statusCode === 200 && JSON.parse(body).pid === lock.pid); } catch { resolve(false); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/**
 * La oficina viva: reusa el proceso local si contesta o arranca uno aparte, y devuelve su dirección. Dos aperturas a la
 * vez no arrancan dos: la que llega segunda espera a la primera y usa su proceso.
 */
async function openLive(home = os.homedir()) {
  const dir = path.join(stateDir(home), 'office');
  const lockFile = path.join(dir, 'server.json');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (e) { throw new Error(`no puedo escribir el candado en ${dir} (${e.code || e.message})`); }
  const readLock = () => { try { return JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { return null; } };
  const urlOf = (l) => `http://127.0.0.1:${l.port}/?t=${l.token}`;
  const mutex = path.join(dir, 'server.starting');
  for (let i = 0; ; i += 1) {
    try { fs.closeSync(fs.openSync(mutex, 'wx', 0o600)); break; } catch (e) {
      if (e.code !== 'EEXIST') throw new Error(`no puedo escribir el candado en ${dir} (${e.code})`);
      try { if (Date.now() - fs.statSync(mutex).mtimeMs > 15000) fs.unlinkSync(mutex); } catch { /* lo sacó el otro */ }
      if (i > 150) throw new Error('otra apertura de la oficina no terminó en 15 s');
      await sleep(100);
    }
  }
  try {
    const current = readLock();
    if (await answers(current)) return { url: urlOf(current), reused: true };
    const log = path.join(dir, 'server.log');
    const out = fs.openSync(log, 'a', 0o600);
    const child = spawn(process.execPath, [path.join(__dirname, 'office', 'server.js')], { detached: true, stdio: ['ignore', 'ignore', out] });
    fs.closeSync(out);
    let exited = null;
    child.on('exit', (code) => { exited = code; });
    child.unref();
    for (let i = 0; i < 200; i += 1) {
      const lock = readLock();
      if (lock && lock.pid === child.pid && await answers(lock)) return { url: urlOf(lock), reused: false };
      if (exited != null) break;
      await sleep(50);
    }
    let why = 'no contestó en 10 s';
    try { why = fs.readFileSync(log, 'utf8').trim().split('\n').pop() || why; } catch { /* sin registro */ }
    try { process.kill(child.pid, 'SIGTERM'); } catch { /* ya salió */ }
    throw new Error(`la oficina viva ${why}`);
  } finally {
    try { fs.unlinkSync(mutex); } catch { /* ya no está */ }
  }
}

async function main(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--open') opts.open = true;
    else if (a === '--out' || a === '--now') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) { process.stderr.write(`office.js: ${a} pide un valor\n`); return 2; }
      opts[a.slice(2)] = v;
    } else { process.stderr.write(`office.js: opción desconocida ${a}\n`); return 2; }
  }
  // --open sin foto fija: la oficina viva, del proceso local
  if (opts.open && !opts.json && !opts.out && !opts.now) {
    let r;
    try { r = await openLive(); } catch (e) { process.stderr.write(`office.js: ${String(e.message).split('\n')[0]}\n`); return 1; }
    process.stdout.write(r.reused ? `La oficina ya estaba abierta: ${r.url}\n` : `La oficina está abierta en ${r.url}\n`);
    if (process.env.TYCON_OFFICE_NO_BROWSER !== '1') openFile(r.url);
    return 0;
  }
  let data;
  // la foto que queda en un archivo no lleva nada de las conversaciones: eso sólo viaja en la foto viva
  try { data = await collect({ now: opts.now, noTranscripts: !opts.json }); } catch (e) {
    if (e.code === 'NO_STATE' || e.code === 'BAD_ARG') { process.stderr.write(`office.js: ${e.message}\n`); return 2; }
    throw e;
  }
  if (opts.json) { process.stdout.write(`${JSON.stringify(data, null, 2)}\n`); return 0; }
  const file = opts.out ? path.resolve(opts.out) : path.join(os.tmpdir(), 'tycon-office', 'office.html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, page(data));
  process.stdout.write(`La oficina está en ${file}\n`);
  if (opts.open) openFile(file);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`office.js: ${e && e.stack ? e.stack : e}\n`);
    process.exitCode = 1;
  });
}

module.exports = { buildOffice, buildBoard, page, importMap, moduleSource, collect, openFile, openLive, deskSlots, readSiteUrl, readQuietMinutes, plain, MODULES };
