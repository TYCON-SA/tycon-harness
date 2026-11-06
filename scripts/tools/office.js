#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('../lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/*
 * office.js — el trabajo en curso de esta máquina dibujado como una oficina en 3D (el comando /office).
 *
 *   node office.js [--open] [--json] [--out <archivo>] [--now <fecha>]
 *   node office.js --owner-waits [--now <fecha>]
 *
 * Los datos son los de /wip (work-in-progress.js, con los pedidos ya preguntados), las firmas pendientes de la
 * coordinación y la sesión coordinadora designada. Cada sesión es una persona en su escritorio: su nombre, su estado
 * en palabras, la hora de fin con su atraso o adelanto, el avance, lo que hace y lo que hace mientras tanto. El estado
 * sale de si la sesión trabaja, no del paso: ocupada, parada o esperando algo del dueño, lo que dice su herramienta. El
 * atraso de una corrida se mide contra la hora de su paso (`horaDelPaso`, la anota marker.js); sin ella, contra su promesa
 * (su arranque más su estimado, del marcador); sin estimado, contra la primera hora que se vio para esa sesión y ese
 * trabajo, guardada en `<estado>/office/promises.json`.
 * La sección «El trabajo» se ve en tablas o en kanban. El kanban tiene cinco columnas (Sin sesión, En curso, Tu firma, Esperan entrar, Terminados): En curso, Tu firma
 * y Esperan entrar salen del estado real, y el tablero de la coordinadora (`<estado>/coordination/tablero.json`) suma lo que la
 * máquina no sabe. Una fila con `historia` toma su estado de la corrida; con `pedido`, de consultarlo. El panel de la
 * pared cuenta esas columnas. Sin pipeline, la tarjeta dice el encargo, lo que hace ahora y su última acción, leídos del
 * principio y del final de su conversación (scripts/lib/session-transcript.js): van sólo en la foto viva y en `--json`.
 * El título de una sesión es lo que ella dice que hace: su carril o su nota (`marker.js doing`), o su último mensaje; el
 * encargo se muestra como encargo, porque son las instrucciones de quien la abrió. «En curso» es lo que tiene una sesión
 * viva haciéndolo: lo que no, va a su columna y una sola vez. «Corriendo pruebas» se dice sólo si el árbol de procesos de la
 * sesión tiene pruebas corriendo. Una hora de fin que pasó no es un pronóstico: se dice que se pasó y desde cuándo no hay novedades.
 *
 * Las tablas «Hoy» y «Pendientes» (`buildTables`) se arman solas de las mismas tarjetas que el kanban: una fila por tema, con
 * una línea de estado contada de las tarjetas. Nadie las escribe. El tema de cada trabajo sale de office/topics.js, que corre
 * de fondo: armar la foto no llama al modelo ni lo espera.
 *
 * `--open` abre la oficina viva: arranca el proceso local de office/server.js (o reusa el que ya está) y abre su
 * dirección; la página recibe cada cambio por WebSocket. `--out` escribe la foto fija en un archivo, y `--json` imprime
 * los datos. `--owner-waits` imprime, para la coordinadora (`coordination.js owner-next` y `owner-wait`), lo que «Tu firma»
 * tiene esperando a una sesión (`ownerWaitsOf`), sin escribir nada. La foto fija es un solo archivo, sin nada de afuera: la librería 3D (three.js 0.160.0, MIT, en
 * office/vendor/three/) va adentro, y si el navegador no puede dibujar en 3D se ve la tabla. Sólo mira: no cambia nada
 * del trabajo de las sesiones.
 *
 * Con la oficina viva, un mensaje entre dos sesiones vuela como un sobre entre sus escritorios (`sobres` en la foto: quién,
 * a quién y cuándo, sin el texto). Al tocar a una persona, la página le pide al proceso sus últimos mensajes con la
 * coordinadora; los de la coordinadora incluyen los que cruzó con la persona. Ese texto no entra en la foto: no llega a
 * ningún otro lado, y la página no puede mandar nada de vuelta. Cada sesión dice cómo trabaja (`comoTrabaja`), de su marca.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const { stateDir, claudeDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
const { designacionVigente } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'critical-waivers.js'));
const { OVERDUE_HOUR: OVERDUE, wipNow, sessionsBySid, codexNames, realState, replacedByNewer, hourVerdict, readPrs, offQueueOf, identityOf, remoteOfFolder, SAFE_SID, LOOSE_STALE_MS } = require('./work-in-progress.js');
const topics = require(path.join(__dirname, 'office', 'topics.js'));
const boardTool = require(path.join(__dirname, 'office', 'board.js'));
// la fila escrita a mano sin numerar
const NO_NUMBER = 'sin número';
const signatureList = require(path.join(ROOT, 'scripts', 'lib', 'signature-list.js'));
const sessionState = require(path.join(ROOT, 'scripts', 'lib', 'session-state.js'));
const { readTranscript, codexTranscript, peerMessagesSince, readConversation, readSessionTokens, TAIL_BYTES } = require(path.join(ROOT, 'scripts', 'lib', 'session-transcript.js'));

const PARTS = require('./office/page-parts.js');
const { MODULES, moduleSource } = PARTS;
// Los estados de una sesión que trabaja o espera: los únicos en que estar callada dice algo.
const QUIET_STATES = new Set(['trabajando', 'prueba', 'firma', 'pregunta', 'espera', 'esperando']);
// lo que le toca contestar a una persona: una firma o una pregunta. La coordinadora que espera eso no dice «Coordinando»
const ASKS_OWNER = new Set(['firma', 'pregunta']);
// Las clases de trabajo sin corrida abierta: lo que hacen se lee de su conversación.
const NO_RUN_KINDS = new Set(['activity', 'nomarker', 'loose', 'note']);
// El nombre del paso que espera la aprobación del dueño, como lo anota el archivo de estado de la sesión.
const PLAN_STEP_NAME = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'steps.js')).stepName('approve-plan');
const PROMISE_KEEP_MS = 24 * 3600000;
// Claude deja el estado de una sesión en «idle» aunque siga escribiendo su conversación (con trabajo de fondo, por ejemplo). Si
// escribió bastante después de que su estado dijo parada, no paró: el fin de un turno escribe sus últimos renglones enseguida.
const WRITES_AFTER_STOP_MS = 60000;
const STILL_WORKING_MS = 5 * 60000;
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
const orElse = (v, other) => (v != null ? v : other);
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
// Lo que una sesión espera o está haciendo necesita su pedido para decir algo (`keepPrs`): «espera que entre el #907».
const unnumbered = (t, { keepPrs = false } = {}) => {
  const s = typeof t === 'string' ? t : '';
  const noStory = HOUR_AT_START.test(s) ? s : s.replace(/^\s*\d+(?:\.\d+)+[A-Za-z]?(?:-[A-Za-z0-9]+)?\s*[·:]\s*/, '');
  return (keepPrs ? noStory : noStory.replace(/(?:\s+(?:del|de|en|el|al))?\s*[!#]\d{3,}\b/g, '')).trim();
};
// El texto que escribe una sesión, además, va sin nombres de archivos, rutas, ramas ni identificadores; la preposición
// que los presentaba se va con ellos. El castellano queda: «10-12», «teórico-práctico», «y/o», «ad-hoc», «Node.js».
// Tampoco van los números de historia del medio («la 8.154», «historia 2.81-c»: una hora o un decimal sueltos quedan) ni
// lo que no debe verse en una tarjeta: lo que el chat marca como código, una clave, un correo, un teléfono.
const CUT = '\u0000';
const STORY_IN_TEXT = /\b(?:(?:la\s+)?(?:historia|story)|la)\s+\d+(?:\.\d+)+[A-Za-z]?(?:-[A-Za-z0-9]+)?(?=[\s.,;:!?)»]|$)/giu;
// una hora escrita con punto no es un número de historia; una fecha no es un teléfono
const BEFORE_WORDS = (t, keepPrs) => t
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/`[^`]*`/g, ` ${CUT} `)
  .replace(/(?<![\w+=/-])\+?\d[\d() -]{6,}\d(?![\w=/-])/g, (m) => (m.replace(/\D/g, '').length >= 8 && !/^\d{4}-\d\d-\d\d(?:\s\d{1,2})?$/.test(m) ? ` ${CUT} ` : m))
  .replace(STORY_IN_TEXT, (m) => (/^la\s+1\.[0-5]\d$/i.test(m) ? m : 'la historia'))
  .replace(/\b(pedidos?)\s+[!#]?\d{3,}\b/giu, (m, word) => (keepPrs ? m : word));
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
  // «/office» es un comando, no una ruta
  || (w.includes('/') && !/^\/[a-z][a-z-]*$/.test(w) && !/^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/.test(w) && (/\/.*\//.test(w) || /^[.~/]/.test(w) || /[._-]/.test(w)))
  || /^\.[a-z][\w.-]*$/.test(w)
  || (FILE_EXT.test(w) && /^[\w.-]+$/.test(w) && !/^[A-Z][a-z]+\.js$/.test(w) && !LIBRARY.test(w))
  || (/^[a-z0-9_]+(?:-[a-z0-9_]+)+$/.test(w) && !/^\d+(?:-\d+)+$/.test(w) && !JOINED.test(w) && (/\d|_/.test(w) || /-.*-/.test(w)));
const withCuts = (t, opts = {}) => BEFORE_WORDS(unnumbered(t, opts), opts.keepPrs)
  .split(/(\s+)/)
  .map((tok) => {
    // sin la puntuación ni el formato del chat alrededor, y sin el renglón de un archivo («office.js:241»)
    const core = tok.replace(/^[«"'(*_~[]+|[»"'),;:!?*_~\]]+$|\.+$/g, '').replace(/[»"'),;:!?*_~\].]+$/g, '').replace(/(\.[A-Za-z]{1,5}):\d+(?::\d+)?$/, '$1');
    return core && technical(core) ? CUT : tok;
  })
  .join('');
const plain = (t, opts) => withCuts(t, opts)
  .replace(new RegExp(`\\s+(?:en|de|del|a|al|con|desde|para)\\s+${CUT}`, 'g'), CUT)
  .replace(new RegExp(`\\s*(?:${CUT}\\s*[·,:]?\\s*)+`, 'g'), ' ')
  .replace(/\s+/g, ' ')
  // lo cortado no deja un signo suelto: «la memoria .», «( a medias»
  .replace(/\s+([.,;:!?)»])(?=\s|$)/g, '$1')
  .replace(/([(«])\s+/g, '$1')
  .replace(/^[\s·,:]+|[\s·,:]+$/g, '');
// Lo mismo, pero sólo si no hubo que cortarle nada: una oración de chat sin su ruta o su código queda rota («Está en la
// memoria.», «Leé y hacé»), y una oración rota no se muestra.
const plainWhole = (t, opts) => (withCuts(t, opts).includes(CUT) ? null : plain(t, opts));

// Una oración llana por sesión: qué está haciendo, sin el detalle técnico de /wip.
function sentenceOf(estado, x, row) {
  if (estado === 'firma') return 'Espera tu respuesta o un permiso.';
  if (estado === 'pregunta') return 'Te hizo una pregunta en su pantalla.';
  if (estado === 'coordina') return 'Coordina las sesiones de esta máquina.';
  // terminado sin cerrar: la ejecución con todos sus pasos hechos, o el camino corto con su pedido
  if (x.finishedOpen && x.kind === 'loose') return `Terminó «${plain(x.text) || 'un camino corto'}»: falta cerrar el camino corto${x.openPr ? ` (${x.openPr})` : ''}.`;
  if (x.finishedOpen) return x.finishedReview
    ? `Terminó la story ${x.storyId || '?'}: falta revisar lo cambiado después de los revisores.`
    : `Terminó la story ${x.storyId || '?'}: falta cerrarla.`;
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

// Lo que corre pruebas, en la línea de un proceso. El comando de una consola (`zsh -c "… vitest …"`) o una búsqueda
// (`grep vitest`) nombra pruebas sin correrlas; su hijo, si las corre, se reconoce solo.
const TEST_COMMAND = /(?:^|[\s/\\])(?:test-gate\.sh|run-suites(?:-json)?\.js|pytest|(?:vitest|jest)(?:\.[cm]?js|\.cmd)?)(?:\s|$)|node_modules[\\/](?:vitest|jest)[\\/]|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|t)\b|\b(?:go|cargo|dotnet)\s+test\b|\bdotnet\s+vstest\b|\bplaywright\s+test\b|\s--test(?:\s|$)|\.test\.(?:js|ts|sh)(?:\s|$)/;
const ONLY_NAMES_TESTS = /^(?:(?:ba|z|da|k)?sh\s+-l?c\b|(?:grep|rg|sed|awk|cat|tail|head)\b)/;
/**
 * ¿Hay pruebas corriendo bajo este proceso? true o false, mirando sus descendientes en `processes` (`{ pid, ppid, comando }`,
 * de `leerArbol`); null si no se puede saber: sin la lista de procesos (Windows), sin el proceso de la sesión o si no está en
 * la lista. Codex corre
 * sus comandos desde un servidor compartido: no encontrarlas bajo su proceso no dice que no las haya.
 */
function runningTests(pid, processes, tool = 'claude') {
  if (!Array.isArray(processes) || !Number.isInteger(pid) || pid <= 0 || !processes.some((p) => p.pid === pid || p.ppid === pid)) return null;
  const children = new Map();
  for (const p of processes) { if (!children.has(p.ppid)) children.set(p.ppid, []); children.get(p.ppid).push(p); }
  const seen = new Set([pid]);
  const queue = [pid];
  while (queue.length) {
    for (const c of children.get(queue.pop()) || []) {
      if (seen.has(c.pid)) continue;
      seen.add(c.pid);
      queue.push(c.pid);
      // el programa se mira sin su carpeta: una carpeta que se llama «cat» no lo vuelve una lectura
      if (TEST_COMMAND.test(c.comando) && !ONLY_NAMES_TESTS.test(c.comando.replace(/^\S*[\\/]/, ''))) return true;
    }
  }
  return tool === 'codex' ? null : false;
}

// Un agente de Codex en la línea de un proceso: `codex exec`, directo o por su lanzador de Node. Se mira qué programa corre:
// un comando que sólo nombra a Codex (`grep "codex exec"`) no es un agente.
const CODEX_AGENT = /^(?:\S*[\\/])?(?:(?:node|bun)(?:\.exe)?\s+\S*[\\/])?codex(?:\.js|\.exe)?\s+exec(?:\s|$)/i;
// Un agente de Claude corre dentro de su sesión, sin proceso propio: cuenta como activo si su archivo se tocó hace menos que esto
const CLAUDE_AGENT_ACTIVE_MS = 3 * 60000;
// Una tanda de agentes con la carpeta quieta hace más que esto ya terminó: sus archivos no se miran
const AGENT_BATCH_KEEP_MS = 6 * 3600000;
const REVIEW_STEPS = new Set(['reviewers', 'adversarial-pass', 'Revisores', 'Pase adversarial']);

/**
 * Cuántos agentes de Codex corren bajo este proceso, mirando sus descendientes en `processes`. El lanzador de Node y su
 * programa son el mismo agente: al encontrar uno no se sigue bajando. null sin la lista de procesos (Windows) o sin el proceso.
 */
function codexAgentsUnder(pid, processes) {
  if (!Array.isArray(processes) || !Number.isInteger(pid) || pid <= 0) return null;
  const children = new Map();
  for (const p of processes) { if (!children.has(p.ppid)) children.set(p.ppid, []); children.get(p.ppid).push(p); }
  const seen = new Set([pid]);
  const queue = [pid];
  let count = 0;
  while (queue.length) {
    for (const c of children.get(queue.pop()) || []) {
      if (seen.has(c.pid)) continue;
      seen.add(c.pid);
      if (CODEX_AGENT.test(c.comando)) count += 1;
      else queue.push(c.pid);
    }
  }
  return count;
}

/** Cuántos agentes de Claude de esta conversación tocaron su archivo hace poco: una cuenta aproximada. Sólo mira fechas. */
function claudeAgentsActive(transcript, nowMs) {
  const root = path.join(path.dirname(transcript), path.basename(transcript, '.jsonl'), 'subagents');
  const mtimeOf = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return null; } };
  const namesIn = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
  const activeIn = (dir) => namesIn(dir).filter((n) => /^agent-.*\.jsonl$/.test(n)).filter((n) => {
    const at = mtimeOf(path.join(dir, n));
    return at != null && nowMs - at < CLAUDE_AGENT_ACTIVE_MS;
  }).length;
  let count = activeIn(root);
  const batches = path.join(root, 'workflows');
  for (const n of namesIn(batches)) {
    const dir = path.join(batches, n);
    const at = mtimeOf(dir);
    if (at != null && nowMs - at < AGENT_BATCH_KEEP_MS) count += activeIn(dir);
  }
  return count;
}

// Lo que dice una sesión de sus agentes: «Unos» si la cuenta incluye agentes de Claude, que es aproximada.
function agentsSaid({ codex, claude }, reviewing) {
  const total = codex + claude;
  const doing = reviewing ? 'revisando' : 'trabajando';
  if (total === 1) return `1 agente ${doing}`;
  return `${claude ? 'Unos ' : ''}${total} agentes ${doing}`;
}

// El estado real, corregido por la conversación: quien la sigue escribiendo mucho después de que su estado dijo parada no
// paró; y si dejó de escribir hace rato, paró cuando dejó de escribir.
function notStoppedYet(real, lastWrite, statusAt, nowMs) {
  if (real.estado !== 'parada' || !Number.isFinite(lastWrite) || !(statusAt > 0) || lastWrite <= statusAt + WRITES_AFTER_STOP_MS) return real;
  return nowMs - lastWrite <= STILL_WORKING_MS ? { estado: 'trabajando' } : { estado: 'parada', parada: `parada desde las ${hhmm(lastWrite)}` };
}
// Una hora de fin que pasó no es un pronóstico: se dice eso, y desde cuándo no hay novedades.
const overdueFin = (at) => ({ hora: OVERDUE, dif: Number.isFinite(at) ? `sin novedades desde las ${hhmm(at)}` : '', cls: 'late' });
const latest = (...times) => { const v = times.filter(Number.isFinite); return v.length ? Math.max(...v) : NaN; };

/**
 * Lo que la lista de firmas pone en «Tu firma»: lo de la terminal, un renglón por fila; lo de una sesión, una sola tarjeta
 * por sesión. Con la sesión ya esperando la firma (`conTarjeta`), su tarjeta alcanza. `yaAvisada`: la sesión ya está en «te
 * toca» por lo que espera, el plan o el guardado. De un permiso sólo sale su título: el pedido no se muestra.
 */
function cardsOfSignatures(signatures, agents, sidOf) {
  const cards = [];
  const bySession = new Map();
  for (const s of signatures) {
    if (!s || !s.title) continue;
    const at = Number.isFinite(s.at) ? s.at : null;
    if (!s.destino) { cards.push({ titulo: `Firma: ${plain(s.title)}`, quien: 'vos', at, linea: `Firmar: ${plain(s.title)}`, sid: null }); continue; }
    const k = String(s.destino);
    if (!bySession.has(k)) bySession.set(k, []);
    bySession.get(k).push({ ...s, at });
  }
  for (const [sid, rows] of bySession) {
    rows.sort((a, b) => (a.at || 0) - (b.at || 0));
    const first = rows[0];
    const more = rows.length > 1 ? ` y ${rows.length - 1} más` : '';
    const isPermission = first.tipo === 'permiso';
    const agent = agents.find((a) => String(sidOf.get(a)) === sid);
    const quien = agent ? agent.nombre : plain(first.nombre) || plain(sid.slice(0, 8));
    const waits = Boolean(agent) && agent.estado === 'firma';
    cards.push({ titulo: `${isPermission ? '' : 'Firma: '}${plain(first.title)}${more}`, quien, at: first.at, conTarjeta: waits, sid,
      yaAvisada: waits && (agent.espera === 'que apruebes el plan' || agent.espera === 'el ok para guardar'),
      linea: `${isPermission ? '' : 'Firmar: '}${plain(first.title)}${more} (${quien})` });
  }
  return cards;
}

/**
 * La mano levantada y a quién espera (`mano`: `dueno` o `coordinadora`). Al dueño: la sesión con la pantalla frenada
 * esperándolo, o la que pidió una firma que sigue pendiente en el registro, unida por el id de su sesión (`manoPor` dice
 * cuál). A la coordinadora: la que anotó que la espera, por su nombre o por la palabra. Si espera a los dos, al dueño.
 */
const HAND_LABEL = { dueno: 'Espera tu firma', coordinadora: 'Espera a la Coordinadora' };
function raiseHands(agents, signatures, sidOf, coordinatorName) {
  // lo que espera una sesión de otro proyecto no sale con su título: se dice de qué es, como sus tarjetas
  const raise = (a, who, por) => { a.mano = who; a.manoEtiqueta = HAND_LABEL[who]; if (por) a.manoPor = a.otroProyecto ? 'Otro proyecto' : por; };
  // qué espera ya lo dice su renglón «Espera»: la mano sólo nombra la firma pendiente, que no sale de otro lado
  for (const a of agents) if (ASKS_OWNER.has(a.estado)) raise(a, 'dueno', null);
  for (const s of [...signatures].sort((p, q) => (p.at || 0) - (q.at || 0))) {
    if (!s || !s.destino || !s.title) continue;
    const a = agents.find((x) => String(sidOf.get(x)) === String(s.destino));
    if (a && !a.manoPor) raise(a, 'dueno', `${s.tipo === 'permiso' ? '' : 'Firma: '}${plain(s.title)}`);
  }
  const word = (n) => new RegExp(`(?<![\\p{L}\\p{N}])${String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu');
  for (const a of agents) {
    if (a.mano || a.estado !== 'esperando') continue;
    const said = String(a.termina || '').replace(/^espera /, '');
    if (word('coordinadora').test(said) || (coordinatorName && word(coordinatorName).test(said))) raise(a, 'coordinadora', null);
  }
}

// Lo trabado, por a quién espera: la primera sesión abierta que nombra su espera, o el dueño; si no nombra a nadie, «otra
// cosa». La tanda más grande primero, y «otra cosa» al final.
const OWNER_WAIT = Symbol('el dueño');
function stuckGroups(agents, coordinatorName) {
  const groups = new Map();
  const names = agents.map((a) => a.nombre).filter(Boolean);
  for (const a of agents) {
    if (a.estado !== 'esperando') continue;
    const said = String(a.termina || '').replace(/^espera /, '');
    const who = names.find((n) => n !== a.nombre && new RegExp(`(?<![\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu').test(said)) || (/(?<![\p{L}\p{N}])dueñ[oa](?![\p{L}\p{N}])/iu.test(said) ? OWNER_WAIT : null);
    if (!groups.has(who)) groups.set(who, []);
    groups.get(who).push(`${a.nombre}: ${said}`);
  }
  const verb = (n) => `${n} ${n === 1 ? 'espera' : 'esperan'}`;
  return [...groups.entries()].sort(([p, x], [q, y]) => (p === null) - (q === null) || y.length - x.length)
    .map(([who, filas]) => ({ titulo: who === null ? `${verb(filas.length)} otra cosa` : who === OWNER_WAIT ? `${verb(filas.length)} al dueño` : `${verb(filas.length)} a ${who === coordinatorName ? 'la ' : ''}${who}`, filas }));
}

/**
 * Los datos de la página, sin leer nada: `wip` es lo que devuelve wipNow, `signatures` las firmas pendientes,
 * `coordinatorSid` la sesión coordinadora (o null), `promises` la primera hora vista de cada sesión y story, `board` el
 * tablero de la coordinadora ya armado (`buildBoard`), `prAnswers` lo que contestó cada pedido que nombra (por
 * `<repo>#<número>`), `transcripts` lo que dice la conversación de cada sesión (por sesión), `lastWrites` cuándo se escribió
 * por última vez la conversación de cada sesión y `processes` los procesos de la máquina (null: no se pudieron leer).
 * Devuelve `{ data, promises }`, con las promesas ya al día para guardarlas.
 */
function buildOffice({ wip, signatures = [], coordinatorSid = null, coordinatorName = null, promises = {}, nowMs = Date.now(),
  sessionFiles = [], codexNames: cxNames = new Map(), runningAgents = new Map(), quietMin = QUIET_DEFAULT_MIN, isAlive, board = null, prAnswers = new Map(), transcripts = null, lastWrites = new Map(), processes = null, openPrs = [], openPrsNote = null, waitingPrs = null, testSessions = new Set(), personSessions = new Set(), otherProjects = new Set(), projectOf = () => 'nuestro', projectOfRepo = () => 'nuestro' } = {}) {
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
  // el paso de cada tarjeta de una ejecución, para decir si sus agentes revisan
  const stepOf = new Map();
  const quiet =Number.isFinite(quietMin) && quietMin > 0 ? quietMin : QUIET_DEFAULT_MIN;
  const fileEnd = (f) => { const t = Date.parse(f && f.endAt); return Number.isFinite(t) ? t : null; };
  // la última novedad, para la página y su reloj: quieta más que el umbral, «sin novedades desde las HH:MM»
  const novelty = (a, f, ...newer) => {
    const at = latest(Date.parse(f.updatedAt), ...newer);
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
    // el cuadro que abre una sesión de prueba es parte de la prueba: no le toca a nadie
    const isTest = d.sid != null && testSessions.has(String(d.sid));
    const dNow = isTest ? { ...d, status: 'busy' } : d;
    const fNow = isTest && f ? { ...f, waitingForOwner: false } : f;
    const keeps = Boolean(x0.mark) || (x0.kind === 'pipeline' && x0.current === 'approve-plan' && realState(x0, dNow, fNow).estado === 'firma');
    const replacesClosed = !keeps && replacesClosedRun(x0);
    const replacesOpen = !keeps && replacedByNewer(x0, nowMs);
    const declared = x0.kind === 'loose' || x0.kind === 'note' ? plain(x0.text) : '';
    const runTitle = unnumbered(x0.batch) || unnumbered(x0.title) || declared || plain(row.work) || null;
    const x = replacesClosed || replacesOpen
      ? { kind: x0.meanwhileKind, text: x0.meanwhile, endAt: x0.meanwhileEnd, hourAt: x0.meanwhileDeclaredAt, promiseAt: x0.meanwhileDeclaredAt }
      : x0;
    const replaced = x !== x0;
    const proyecto = d.sid != null && otherProjects.has(String(d.sid)) ? 'otro' : projectOf(x0.cwd || x0.runFolder);
    if (replacesClosed) closedRuns.push({ titulo: runTitle, quien: row.session, storyId: x0.storyId, stalled: x0.kind === 'stalled', proyecto });
    // el archivo manda en lo que sabe: el paso mientras hay pipeline, el trabajo suelto declarado y la espera; lo que no
    // sabe (la entrada a los repos, la nota, la actividad sin marcador) sigue saliendo de /wip
    // lo terminado sin cerrar lo sabe /wip, no el archivo: el archivo guarda el motivo del carril, no que falta cerrarlo
    const knows = !replaced && Boolean(f) && !x.finishedOpen && ((x.kind === 'pipeline' && f.step) || x.kind === 'loose');
    const lastWrite = d.sid != null ? lastWrites.get(String(d.sid)) : undefined;
    const real = notStoppedYet(realState(x, dNow, fNow), lastWrite, Number(d.statusAt), nowMs);
    // «Corriendo pruebas» sólo con pruebas corriendo: estar en el paso no alcanza
    const tests = real.estado === 'prueba' ? runningTests(f && f.pid, processes, f ? f.tool : undefined) : undefined;
    if (tests === false || tests === null) real.estado = 'trabajando';
    // lo que espera algo manda también sobre la coordinadora
    const isCoordinator = Boolean(coordinatorSid) && d.sid === coordinatorSid;
    const prsSaid = waitingPrs && d.sid != null ? waitingPrs.get(String(d.sid)) : null;
    // si ya pasó todo lo que esperaba, la espera vieja no se dice: se dice qué pasó
    const waitingFor = (prsSaid && prsSaid.all) || workedAfterWait(x0, lastWrite, d.status) ? '' : plain(x0.waitingFor, { keepPrs: true });
    // quien declaró que espera a otro no está trabajando en eso, aunque siga escribiendo
    const declaredWait = Boolean(waitingFor) && !x.mark && !ASKS_OWNER.has(real.estado);
    const estado = isCoordinator && !ASKS_OWNER.has(real.estado) ? 'coordina' : declaredWait ? 'esperando' : real.estado;
    // el título es el de la tanda que corre, entero; sin tanda, el de la historia. Sin carril ni nota no hay título.
    const blind = row.work === 'no se ve qué hace' || x.kind === 'activity' || x.kind === 'nomarker';
    const titulo = blind ? null : replaced ? plain(x.text) || null : runTitle;
    // quien espera algo sigue diciendo por qué paso va; la firma sin más sólo se dice si no se sabe qué espera
    const said0 = knows && f.sentence ? f.sentence : sentenceOf(real.espera ? ASKS_OWNER.has(real.estado) ? 'espera' : estado : estado, x, row);
    const haciendo = x.kind === 'pipeline' && x.current === 'run-tests' && tests !== true && tests !== undefined
      ? `${said0} ${tests === false ? 'Ahora no hay pruebas corriendo.' : 'No se sabe si hay pruebas corriendo.'}` : said0;
    // la tarjeta de una ejecución dice la carpeta de esa ejecución: la del último archivo tocado puede ser de otro arreglo
    const a = { nombre: row.session, estado, titulo, haciendo, carpeta: (!replaced && x0.runFolder) || row.folder || null };
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
    if (estado === 'pregunta') toldOwner.push(`Contestar: ${titulo || haciendo} (${row.session})`);
    // la promesa que la corrida anotó al arrancar; sin estimado, es también la hora de fin de la que sigue trabajando.
    // La que terminó y espera entrar no la toma: su hora es la de la cola, y sin ella no hay hora (como en /wip)
    const promisedAt = Number.isFinite(x.promisedAt) ? x.promisedAt : null;
    const done = x.kind === 'entering' || x.kind === 'stalled' || x.kind === 'finished';
    const noteEnd = Number.isFinite(x.endAt) ? x.endAt : null;
    // el archivo de la sesión no sabe la hora que anotó una nota sobre su arreglo rápido
    // la hora nueva que anotó una ejecución con su nota manda sobre la de su paso
    const ownEnd = orElse(x.noteEnd, knows ? orElse(fileEnd(f), x.kind === 'loose' ? noteEnd : null) : noteEnd);
    // quien espera a otro no da una hora: dice qué espera y desde cuándo
    const rawEnd = x.mark || waitingFor || (prsSaid && prsSaid.all) ? null : ownEnd != null ? ownEnd : done ? null : promisedAt;
    // la hora que ya no dice nada se dice en palabras, no como atraso: la del trabajo que cambió y la vieja
    const verdict = x.kind === 'pipeline' || x.kind === 'loose' || x.kind === 'note'
      ? hourVerdict({ endAt: rawEnd, hourAt: orElse(x.noteEndAt, x.hourAt), activityAt: x.activityAt, nowMs, run: x.kind === 'pipeline' && x.noteEnd == null }) : null;
    // la hora vieja sigue siendo una hora que pasó; sólo la del trabajo que cambió ya no es de este trabajo
    const workChanged = Boolean(verdict) && verdict !== OVERDUE;
    const endAt = !workChanged && Number.isFinite(rawEnd) ? rawEnd : null;
    // lo que terminó y espera la cola no está atrasado: su hora pasada no se muestra. Los pedidos sin encolar no esperan
    // la cola: siguen con su atraso.
    // se mira la hora sin el corte de STALE_END_MS: esperar la cola más de 12 h sigue siendo esperar
    const waiting = Number.isFinite(x.endAt) && x.endAt < nowMs && x.kind === 'entering';
    // una corrida marcada dice su marca en lugar de la hora
    if (x.mark) { a.marca = x.mark; a.haciendo = x.mark; a.termina = x.mark; }
    // sin hora, se dice que no la hay: un texto en el lugar de la hora parece una hora
    else if (prsSaid && prsSaid.all) a.termina = prsSaid.text;
    else if (waitingFor) a.termina = `espera ${waitingFor}${prsSaid ? ` · ${prsSaid.text}` : ''}`;
    else if (workChanged) a.termina = verdict;
    else if (waiting) a.termina = 'esperando entrar';
    else if (estado !== 'coordina' && endAt == null) a.termina = 'sin hora estimada';
    const meanwhile = replaced ? '' : plain(x.meanwhile);
    // el «mientras tanto» es de ahora: tocado en la última hora y después de que arrancó la corrida
    const current = !Number.isFinite(x.meanwhileAt) || (nowMs - x.meanwhileAt <= LOOSE_STALE_MS && !(Number.isFinite(x.runStartedAt) && x.meanwhileAt < x.runStartedAt));
    if (meanwhile && current) { a.mientras = meanwhile; a.mientrasEstado = 'trabajando'; }
    if (x.steps) { a.pasos = x.steps; a.avance = x.progress; }
    a.fin = a.termina ? { hora: a.termina, dif: '', cls: '' } : null;
    if (waitingFor && !x.mark && Number.isFinite(x0.waitingSince)) a.fin.dif = `desde las ${hhmm(x0.waitingSince)}`;
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
      // el atraso se mide siempre contra lo prometido: anotar otra hora o pasar de paso cambia el pronóstico, no la promesa
      const reference = kept[key].at;
      if (x.noteEnd != null) a.horaPorque = `la anotó a las ${hhmm(x.noteEndAt)}`;
      else if (x.hourStep) a.horaPorque = `recalculada al pasar a ${x.hourStep}`;
      // la hora pasó y no terminó: el atraso es el de ahora contra la prometida, no el de la hora vieja
      // (o contra la hora vieja, si la prometida todavía no llegó: una hora pasada nunca está en hora)
      if (endAt < nowMs) { a.atrasoMin = Math.max(1, Math.round((nowMs - Math.min(reference, endAt)) / 60000)); a.atrasada = true; }
      // la hora y su diferencia contra la prometida se calculan acá, una vez: todas las partes de la página dicen esto
      const dd = a.atrasoMin > 0 ? a.atrasoMin : Math.round((endAt - reference) / 60000);
      a.fin = dd > 15 ? { hora: dayHhmm(endAt), dif: `+${difTxt(dd)} tarde`, cls: 'late' }
        : dd < -15 ? { hora: dayHhmm(endAt), dif: `${difTxt(dd)} antes`, cls: 'early' }
          : { hora: dayHhmm(endAt), dif: 'en hora', cls: 'ontime' };
      if (endAt < nowMs) {
        const told = transcripts && d.sid != null ? transcripts.get(String(d.sid)) : null;
        a.fin = overdueFin(latest(x.activityAt, Date.parse(f && f.updatedAt), lastWrite, told ? told.lastWriteMs : NaN, x.lastAt));
        a.termina = OVERDUE;
        delete a.horaPorque;
        delete a.pronosticoIso;
      }
    }
    // parada no va «en hora», adelantada ni atrasada: lo que hay que saber es qué espera. La sesión de una persona espera a su
    // persona; una de fondo no lo anotó, y sólo ella puede decirlo
    if (estado === 'parada' && !x.mark) {
      const person = d.sid != null && personSessions.has(String(d.sid));
      if (person || endAt != null) {
        for (const k of ['atrasada', 'atrasoMin', 'horaPorque', 'pronosticoIso', ...(person ? ['estimadaIso'] : [])]) delete a[k];
        if (a.termina === OVERDUE) delete a.termina;
      }
      if (person) {
        const since = latest(lastWrite, Number(d.statusAt) > 0 ? Number(d.statusAt) : NaN);
        a.termina = 'espera a su persona';
        a.fin = { hora: a.termina, dif: Number.isFinite(since) ? `desde las ${hhmm(since)}` : '', cls: '' };
      } else if (endAt != null) a.fin = { hora: dayHhmm(endAt), dif: 'parada, no anotó qué espera', cls: '' };
    }
    // coordinar no tiene hora de fin
    if (isCoordinator) {
      for (const k of ['termina', 'estimadaIso', 'pronosticoIso', 'horaPorque', 'atrasada', 'atrasoMin']) delete a[k];
      a.fin = null;
    }
    a.tipo = x.kind || null;
    // sale de su marca: una nota no cambia cómo trabaja una sesión, y un arreglo rápido más nuevo sí
    if (x.kind === 'note' && (replaced || x.finishedStoryId)) a.comoTrabaja = waysOfWorking('pipeline', x0.storyId || x.finishedStoryId);
    else a.comoTrabaja = waysOfWorking(x.kind, replaced ? null : x0.storyId);
    // el título de la historia va aparte del trabajo: el panel y la ventana dicen «número — título» aunque corra una tanda
    if (/^Historia \S/.test(a.comoTrabaja) && unnumbered(x0.title)) a.historiaTitulo = unnumbered(x0.title);
    // sin pipeline, lo que dice su propia conversación
    const said = transcripts && NO_RUN_KINDS.has(x.kind) && d.sid != null ? transcripts.get(String(d.sid)) : null;
    if (said) saySession(a, said, x.lastAt, Boolean(titulo) && (x.kind === 'note' || x.kind === 'loose'));
    // el primer mensaje de una sesión abierta por una persona queda viejo y contradice al trabajo de ahora
    if (d.sid != null && personSessions.has(String(d.sid))) delete a.encargo;
    if (isTest) a.comoTrabaja = 'Sesión de prueba';
    else if (d.sid != null && otherProjects.has(String(d.sid))) { a.comoTrabaja = 'Otro proyecto'; a.otroProyecto = true; }
    // una nota dice cómo va, no qué se está haciendo: si siguió a una ejecución, el trabajo es el de esa ejecución
    Object.defineProperties(a, { proyecto: { value: proyecto }, esNota: { value: x.kind === 'note' }, tituloTrabajo: { value: x.kind === 'note' && replaced ? runTitle : null }, historiaTrabajo: { value: x.kind === 'note' && replaced && x0.storyId ? String(x0.storyId) : null } });
    if (f && (QUIET_STATES.has(a.estado) || a.estado === 'parada')) novelty(a, f, x.activityAt, lastWrite);
    sidOf.set(a, d.sid);
    if (x.current) stepOf.set(a, x.current);
    agents.push(a);
  });
  // la coordinadora quieta no está libre: coordina a las demás. Una libre que espera algo, por su archivo o por lo que dice
  // Claude de ella, espera
  (wip.free || []).forEach((name, i) => {
    const sid = (wip.freeSids || [])[i];
    const f = sid != null ? files.get(String(sid)) || null : null;
    if (f) used.add(String(sid));
    const isTest = sid != null && testSessions.has(String(sid));
    const real = isTest ? { estado: 'trabajando' } : realState({}, { status: (wip.freeStatus || [])[i] }, f);
    const waits = ASKS_OWNER.has(real.estado);
    const a = isTest ? { nombre: name, estado: 'trabajando', haciendo: 'Una prueba: su cuadro es parte de la prueba.' }
      : name === coordinatorName && !waits ? { nombre: name, estado: 'coordina', haciendo: 'Coordina las sesiones de esta máquina' }
        : waits ? { nombre: name, estado: real.estado, espera: real.espera, haciendo: (f && f.sentence) || 'Sin trabajo' }
          : { nombre: name, estado: 'libre', haciendo: 'Sin trabajo' };
    a.comoTrabaja = isTest ? 'Sesión de prueba' : waysOfWorking(null);
    if (real.estado === 'pregunta') toldOwner.push(`Contestar: su pregunta (${name})`);
    if (waits && f) novelty(a, f);
    sidOf.set(a, sid);
    agents.push(a);
  });
  // las sesiones que sólo tienen su archivo: Codex sin marcador, o una que se cayó sin avisar. Una de Claude viva que no
  // está en /wip está sin uso hace horas: /wip la cuenta mejor y no se dibuja de nuevo. Inactiva de más de un día, no se
  // dibuja (sigue en disco)
  const fromFile = new Set();
  // una de Claude con su proceso muerto (cerrada sin que Claude Code avisara): sin escritorio, en «Cerradas». El id
  // sirve sólo para «Quitar» de la oficina local: no viaja al sitio
  const cerradas = [];
  for (const [sid, f] of files) {
    if (used.has(sid)) continue;
    const stale = sessionState.isStale(f, { now: nowMs, ...(isAlive ? { isAlive } : {}) });
    const at = Date.parse(f.updatedAt);
    if (stale && closedByPid(f)) { cerradas.push({ nombre: f.name || sid.slice(0, 8), ultimaNovedad: Number.isFinite(at) ? at : null, id: sid }); continue; }
    if (stale && (!Number.isFinite(at) || nowMs - at > SESSION_FILE_KEEP_MS)) continue;
    if (f.tool === 'claude' && !stale && !f.waitingForOwner) continue;
    const a = { nombre: f.name || cxNames.get(sid) || sid.slice(0, 8), titulo: null, carpeta: null };
    const ownRun = halfwayOf.get(sid);
    a.comoTrabaja = waysOfWorking(!stale && (f.step || ownRun) ? 'pipeline' : null, ownRun && ownRun.storyId);
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
      a.estado = ASKS_OWNER.has(real.estado) ? real.estado : works ? real.estado : 'libre';
      if (a.estado === 'pregunta') toldOwner.push(`Contestar: ${a.haciendo || 'su pregunta'} (${a.nombre})`);
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
        else if (e != null && e < nowMs && a.estado === 'parada') a.fin = { hora: dayHhmm(e), dif: 'parada, no anotó qué espera', cls: '' };
        else if (e != null && e < nowMs) { a.termina = OVERDUE; a.fin = overdueFin(latest(at, lastWrites.get(sid))); } else if (e != null) { a.pronosticoIso = localIso(e); a.fin = { hora: dayHhmm(e), dif: '', cls: '' }; } else { a.termina = 'sin hora estimada'; a.fin = { hora: a.termina, dif: '', cls: '' }; }
        a.tipo = 'archivo';
        // el trabajo que declaró la sesión es su título, como en Claude: el encargo no lo tapa
        if (!a.titulo && !f.step && !awaits && f.sentence && f.sentence !== sessionState.NO_PIPELINE && !mark) a.titulo = plain(f.sentence) || null;
        const said = transcripts && !f.step && !awaits && !mark ? transcripts.get(sid) : null;
        if (said) saySession(a, said, Date.parse(f.updatedAt), Boolean(a.titulo));
        novelty(a, f);
        fromFile.add(sid);
      }
    }
    sidOf.set(a, sid);
    agents.push(a);
  }
  // la sesión dice cuántos agentes corren ahora; con agentes corriendo no está libre
  const notFree = new Set();
  for (const a of agents) {
    const running = runningAgents.get(String(sidOf.get(a)));
    if (!running || !(running.codex + running.claude)) continue;
    const said = agentsSaid(running, REVIEW_STEPS.has(stepOf.get(a)) || REVIEW_STEPS.has(a.paso));
    if (a.estado === 'libre') {
      a.estado = 'trabajando';
      a.haciendo = said;
      notFree.add(a.nombre);
    } else a.agentesAhora = said;
  }
  // un orden fijo para las tarjetas y los escritorios: la coordinadora primero y después por nombre, y entre nombres iguales
  // por sesión. Con más sesiones que escritorios, se eligen primero las que trabajan; entre los elegidos el orden sigue
  // siendo ése, así nadie cambia de lugar cuando otro cambia de estado
  const bySession = (p, q) => { const s = String(sidOf.get(p)); const t = String(sidOf.get(q)); return s < t ? -1 : s > t ? 1 : 0; };
  const byCoordinatorThenName = (p, q) => (q.estado === 'coordina') - (p.estado === 'coordina') || String(p.nombre).localeCompare(String(q.nombre), 'es') || bySession(p, q);
  agents.sort(byCoordinatorThenName);
  // la coordinadora no trabaja en una cosa: coordina, aunque tenga un arreglo abierto o algo que el dueño tenga que firmar
  for (const a of agents) if ((coordinatorSid && sidOf.get(a) === coordinatorSid) || (coordinatorName && a.nombre === coordinatorName)) a.comoTrabaja = 'Coordinando';
  if (agents.length > MAX_DESKS) {
    const rank = (a) => (a.estado === 'coordina' ? 0 : a.estado === 'trabajando' || a.estado === 'prueba' ? 1 : ASKS_OWNER.has(a.estado) ? 2 : a.estado === 'parada' || a.estado === 'espera' || a.estado === 'esperando' ? 3 : 4);
    const chosen = new Set([...agents].sort((p, q) => rank(p) - rank(q) || byCoordinatorThenName(p, q)).slice(0, MAX_DESKS));
    agents.sort((p, q) => Number(chosen.has(q)) - Number(chosen.has(p)) || byCoordinatorThenName(p, q));
  }
  agents.forEach((a, i) => { a.orden = i; });

  // lo pendiente es el trabajo de las filas de /wip, no la coordinadora quieta
  const items = agents.filter((a) => a.tipo).map((a) => ({
    titulo: a.titulo || a.haciendo, quien: a.nombre, estimadaIso: a.estimadaIso || null, pronosticoIso: a.pronosticoIso || null, fin: a.fin,
    estado: a.tipo === 'stalled' ? 'riesgo' : a.estado === 'espera' ? 'espera' : a.estado === 'firma' ? 'firma' : 'curso', // lo demás, una pregunta incluida, sigue en curso
    ...(a.marca ? { marca: a.marca } : {}),
  }));
  const signatureCards = cardsOfSignatures(signatures, agents, sidOf);
  raiseHands(agents, signatures, sidOf, coordinatorName);
  for (const s of signatureCards) {
    if (s.conTarjeta) continue;
    items.push({ titulo: s.titulo, quien: s.quien, estado: 'firma', estimadaIso: s.at == null ? null : localIso(s.at), pronosticoIso: null, fin: s.at == null ? null : { hora: dayHhmm(s.at), dif: '', cls: '' } });
  }
  // lo que espera al dueño es su firma, y lo dejado a propósito sigue en curso. A medio camino queda sólo lo que de verdad
  // quedó sin terminar: archivos sin guardar o commits fuera de la rama principal, una fila por carpeta. Lo demás de una
  // sesión cerrada ya no dice nada; lo que no se pudo saber se dice una vez, y una nota de `doing` nunca cuenta.
  const halfwayCards = [];
  const leftovers = new Map();
  let halfwayUnknown = 0;
  const hasOpenPr = (branch) => Boolean(branch) && openPrs.some((p) => p.branch === branch);
  for (const h of wip.halfwayItems || []) {
    // la corrida de una sesión que se dibuja desde su archivo no quedó a medio camino: está trabajando
    if (h.sid != null && fromFile.has(String(h.sid))) continue;
    // lo que ya entró a la rama principal tampoco: terminó
    if (h.entered) continue;
    // el de una corrida es el título de su historia: lo escribió una persona y queda entero
    const titulo = (h.kind === 'run' ? unnumbered(h.text) : plain(h.text)) || 'Un trabajo sin nombre';
    const proyecto = h.sid != null && otherProjects.has(String(h.sid)) ? 'otro' : projectOf(((h.left || [])[0] || {}).folder);
    const espera = h.awaits === 'plan' ? 'que apruebes el plan' : h.awaits === 'save' ? 'el ok para guardar' : null;
    if (espera || h.mark) {
      // la que espera tu firma dice de qué sesión es, para encontrarla; la marcada va a «Sin sesión», y ahí el id corto de una
      // sesión cerrada no le dice nada a nadie: su nombre, si lo tuvo
      const quien = espera ? h.name || '—' : !h.name || (h.sid != null && String(h.sid).startsWith(String(h.name))) ? '' : h.name;
      const it = { titulo, quien, estado: espera ? 'firma' : 'espera', estimadaIso: null, pronosticoIso: null, fin: null, ...(h.mark ? { marca: h.mark } : {}), ...(espera ? { espera } : {}) };
      items.push(it);
      halfwayCards.push({ columna: espera ? 'firma' : 'sinEmpezar', card: { titulo, quien, hora: '', ...(espera ? { espera } : {}), ...(h.mark ? { marca: h.mark } : {}) }, storyId: h.storyId, sid: h.sid, proyecto });
      if (espera) toldOwner.push(`${h.awaits === 'save' ? 'Dar el ok para guardar' : 'Aprobar el plan'}: ${titulo} (${it.quien})`);
      continue;
    }
    if (h.kind === 'note') continue;
    if (h.unknown || h.cleanAfter === 'unknown') halfwayUnknown += 1;
    for (const l of h.left || []) {
      // una rama con su pedido abierto no quedó sin terminar: está entrando
      const ahead = hasOpenPr(l.branch) ? 0 : l.ahead;
      if (!l.changes && !ahead) continue;
      const was = leftovers.get(l.folder);
      if (was) { was.changes = Math.max(was.changes, l.changes); was.ahead = Math.max(was.ahead, ahead); } else leftovers.set(l.folder, { ...l, ahead, work: titulo, historia: h.storyId, proyecto: h.sid != null && otherProjects.has(String(h.sid)) ? 'otro' : projectOf(l.folder) });
    }
  }
  for (const l of leftovers.values()) items.push(Object.defineProperties({ ...leftoverCard(l), estado: 'riesgo', quien: '—', estimadaIso: null, pronosticoIso: null, fin: null }, { trabajo: { value: l.work }, historia: { value: l.historia }, proyecto: { value: l.proyecto } }));
  // la sesión de fondo que cerró Claude Code no está trabajando ni libre: se dice qué pasó y cómo se levanta
  for (const r of wip.retired || []) {
    const quien = plain(r.session) || r.short;
    items.push({ titulo: `${quien}: la cerró Claude Code (${plain(r.reason)}), quieta ${r.idleMin} min`, quien, estado: 'riesgo', estimadaIso: null, pronosticoIso: null, fin: null, espera: `para levantarla: claude respawn ${r.short}` });
  }
  // «te toca» es sólo lo que pide una firma o una decisión del dueño: las firmas, lo que le preguntan y la lista del tablero,
  // que mantiene la coordinadora. Las notas no se leen: una frase no dice si es para ahora
  const teToca = [...signatureCards.filter((s) => !s.yaAvisada).map((s) => s.linea), ...toldOwner, ...((board && board.teToca) || [])];
  const kanban = buildKanban({ agents, storyOfAgent, closedRuns, halfwayCards, items, signatures: signatureCards.filter((s) => !s.conTarjeta), board, prAnswers, openPrs, openPrsNote, nowMs, projectOf, projectOfRepo, sidOf });
  if (halfwayUnknown) kanban.medioCaminoNoSe = halfwayUnknown === 1 ? 'De un trabajo de una sesión cerrada no se pudo saber si dejó algo sin terminar.' : `De ${halfwayUnknown} trabajos de sesiones cerradas no se pudo saber si dejaron algo sin terminar.`;
  if (kanban.medioCamino.length || kanban.medioCaminoNoSe) kanban.medioCaminoLeido = `Leído a las ${hhmm(wip.halfwayReadAt || nowMs)}`;
  const meta = {
    actualizado: hhmm(nowMs),
    teToca,
    trabado: stuckGroups(agents, coordinatorName),
    extra: Math.max(0, agents.length - MAX_DESKS),
    puestos: deskSlots(agents.length),
    quietMin: quiet,
  };
  kanban.linea = boardLine(kanban, { trabado: meta.trabado });
  const facts = boardFacts({ agents, storyOfAgent, sidOf, board, prAnswers, halfwayCards, nowMs });
  // la tabla dice lo mismo que las tarjetas, en llano
  const rows = agents.filter((a) => a.tipo).map((a) => ({ work: a.titulo || '', state: a.mientras ? `${a.haciendo} Mientras tanto: ${a.mientras}.` : a.haciendo, end: a.fin ? a.fin.hora + (a.fin.dif ? ` · ${a.fin.dif}` : '') : '', session: a.nombre, folder: a.carpeta || '' }));
  cerradas.sort((a, b) => (b.ultimaNovedad || 0) - (a.ultimaNovedad || 0));
  return { data: { agents, items, kanban, meta, rows, free: (wip.free || []).filter((name) => !notFree.has(name)), unreadable: wip.unreadable || [], cerradas }, promises: kept, facts: facts.list, factsComplete: facts.complete && !halfwayUnknown };
}

/**
 * Los hechos de esta foto para mover el tablero (`board.js sync`): cada sesión viva con su historia o con un número en lo que
 * hace (arrancó, o espera al dueño), cada pedido de una fila que entró o se cerró sin entrar, y cada ejecución de una
 * sesión cerrada que quedó cortada. `complete` es false si algún pedido no se pudo preguntar: entonces `sync` no aplica lo
 * que sale de no ver algo.
 */
function boardFacts({ agents, storyOfAgent, sidOf, board, prAnswers, halfwayCards, nowMs }) {
  const list = [];
  let complete = true;
  for (const a of agents) {
    if (!a.tipo || a.estado === 'coordina' || a.estado === 'inactiva' || a.estado === 'libre') continue;
    const historia = storyOfAgent.get(a) || a.historiaTrabajo || null;
    const tarea = tasksIn(a.titulo, a.haciendo)[0] || null;
    if (!historia && !tarea) continue;
    const sid = String(sidOf.get(a) || a.nombre);
    const waits = a.mano === 'dueno';
    list.push({ tipo: waits ? 'firma' : 'curso', clave: `${waits ? 'firma' : 'curso'}:${sid}`, ...(tarea ? { tarea } : { historia }), quien: a.nombre, titulo: a.titulo || undefined, at: nowMs });
  }
  // la historia que una sesión está haciendo no se pregunta a los repos (askBoardPrs la saltea): su pedido no falta
  const inCourse = new Set(agents.map((a) => storyOfAgent.get(a) || a.historiaTrabajo).filter(Boolean).map(String));
  for (const f of (board && board.filas) || []) {
    const asked = f.pedido || f.recordado;
    if (!asked || !f.numero) continue;
    if (f.historia && inCourse.has(String(f.historia))) continue;
    const answer = prAnswers.get(`${asked.repo}#${asked.numero}`);
    if (!answer || !answer.pr) { complete = false; continue; }
    const pr = answer.pr;
    if (pr.state === 'merged') list.push(...boardTool.mergeFacts([{ tarea: f.numero, pedidos: [{ repo: asked.repo, numero: asked.numero, state: 'merged', mergedAt: Date.parse(pr.mergedAt) || nowMs }] }]));
    else if (pr.state === 'closed') list.push({ tipo: 'abandonado', clave: `abandonado:${String(asked.repo).toLowerCase()}#${asked.numero}`, tarea: f.numero, pedido: asked, at: Date.parse(pr.closedAt) || nowMs });
  }
  for (const h of halfwayCards) {
    if (!h.storyId || h.columna === 'firma') continue;
    list.push({ tipo: 'cortada', clave: `cortada:${h.storyId}`, historia: String(h.storyId), at: nowMs });
  }
  return { list, complete };
}

// Una carpeta que quedó sin terminar, en llano y con qué hacer.
function leftoverCard({ folder, branch, changes, ahead, work }) {
  const name = path.basename(folder);
  const files = changes ? `${changes === 1 ? '1 archivo' : `${changes} archivos`} sin guardar` : '';
  const commits = ahead ? `${ahead === 1 ? '1 commit' : `${ahead} commits`} que no entraron a main` : '';
  const was = Array.from(work);
  const about = `Era «${was.length > 70 ? `${was.slice(0, 69).join('')}…` : work}». `;
  return {
    titulo: `${name}: ${[files, commits].filter(Boolean).join(' y ')}`,
    accion: `${about}${changes ? 'Abrí una sesión en esa carpeta y guardalos en un pedido, o descartalos si ya no hacen falta.' : `Abrí un pedido con la rama ${branch || 'de esa carpeta'}, o borrala si ya no hace falta.`}`,
  };
}

// La hora de una tarjeta, la misma de la persona.
// Cómo trabaja una sesión, por su marca y nunca por lo que dice: una ejecución (abierta o terminada y entrando) es una
// historia, un arreglo declarado es camino corto y lo demás es otra cosa. La coordinadora dice «Coordinando».
const RUN_KINDS = new Set(['pipeline', 'finished', 'entering', 'stalled']);
function waysOfWorking(kind, storyId) {
  if (RUN_KINDS.has(kind)) return storyId ? `Historia ${storyId}` : 'Historia';
  return kind === 'loose' ? 'Camino corto' : 'Otra cosa';
}
// ¿Siguió trabajando después de anotar lo que esperaba? Tocó archivos, o está ocupada y su conversación se escribió: recibir un
// mensaje estando quieta no es trabajar.
const WAIT_WORKED_MS = 5 * 60000;
function workedAfterWait(x, lastWrite, status) {
  if (!x.waitingFor || !Number.isFinite(x.waitingSince)) return false;
  const past = (at) => Number.isFinite(at) && at - x.waitingSince > WAIT_WORKED_MS;
  return past(x.touchedAt) || past(x.activityAt) || ((status === 'busy' || status === 'shell') && past(lastWrite));
}
const cardHour = (fin) => (fin ? fin.hora + (fin.dif ? ` · ${fin.dif}` : '') : '');
const firstWord = (t) => String(t || '').trim().split(/\s+/)[0].toLowerCase();
// Lo que sólo usan las tablas (la clave del trabajo, su hora y el tema de su fila) va en campos que no se enumeran: no llega a
// la página ni al sitio, y la tarjeta sigue igual.
// Una tarjeta sin título anotado muestra lo que dice su conversación: eso no es un título y no se clasifica (`sinTitulo`).
// De qué proyecto es: `otro` es la marca de siempre; si no se sabe (`sinSaber`) tampoco se manda al modelo ni viaja en las tablas.
// El título de una tarjeta puede ser una nota de cómo va, o su conversación (`esNota`): en las tablas y para el modelo cuenta el
// del trabajo (`tituloTrabajo`), que no cambia con cada nota.
// De qué sesión es una tarjeta de «Tu firma» y de dónde sale (`sesion`, `lista`, `medio` o `tablero`): no viaja en el JSON,
// y lo lee `ownerWaitsOf` para la coordinadora
const signedBy = (card, sid, origen) => Object.defineProperties(card, { sid: { value: sid == null ? null : String(sid), writable: true }, origen: { value: origen, writable: true } });

function withWork(card, { historia, pedido, tarea, finMs, tema, sinTitulo = false, proyecto, tituloTrabajo = null, esNota = false } = {}) {
  const own = (value) => ({ value, writable: true });
  if (proyecto === 'otro') card.otro = true;
  return Object.defineProperties(card, { clave: own(topics.workKey({ historia, pedido, tarea, titulo: tituloTrabajo || card.titulo })), finMs: own(finMs), tema: own(tema || undefined), sinTitulo: own(sinTitulo && !tituloTrabajo), sinSaber: own(proyecto === 'nose'), tituloTrabajo: own(tituloTrabajo || undefined), esNota: own(esNota), pedidoTexto: own(pedido && pedido.repo ? `${pedido.repo}#${pedido.numero}` : undefined) });
}

// El tablero dice cuál es el trabajo de una tarjeta que sólo trae una nota.
function setWorkTitle(card, titulo) {
  if (!card.esNota || card.tituloTrabajo || !titulo) return;
  card.tituloTrabajo = titulo;
  card.sinTitulo = false;
  if (!card.clave.startsWith('historia:') && !card.clave.startsWith('tarea:')) card.clave = topics.workKey({ titulo });
}

// Los números del tablero que nombra un texto: «T-41 · arreglo» nombra T-41.
const TASK_IN_TEXT = /(?<![\p{L}\p{N}-])T-([1-9]\d*)(?![\p{L}\p{N}])/giu;
const tasksIn = (...texts) => [...new Set(texts.filter(Boolean).flatMap((t) => [...String(t).matchAll(TASK_IN_TEXT)].map((m) => `T-${m[1]}`)))];

// El pedido de una tarjeta, para su detalle. Con `org/repo` es de GitHub y con `org/proyecto/repo`, de Azure DevOps; con sólo el
// nombre no se sabe dónde está, y dice su número sin enlace.
function cardPr(repo, numero) {
  const parts = String(repo || '').split('/').map(encodeURIComponent);
  if (parts.length === 2) return { numero, sitio: 'github', ruta: `${parts.join('/')}/pull/${numero}` };
  if (parts.length === 3) return { numero, sitio: 'azure', ruta: `${parts[0]}/${parts[1]}/_git/${parts[2]}/pullrequest/${numero}` };
  return { numero };
}

/**
 * Lo que la oficina pone en «Tu firma» y espera a una sesión, para la coordinadora: `[{ sid, quien, trabajo, espera,
 * cerrada }]`. Las firmas de la lista ya las pasa `owner-next` y las filas del tablero las escribió ella: no salen. Una por
 * sesión; si tiene tarjeta propia y otra a medio camino, gana la propia. Sin nombre, el id corto; sin espera, «algo de vos».
 */
function ownerWaitsOf(data) {
  const firma = ((data && data.kanban && data.kanban.columnas) || []).find((c) => c.id === 'firma');
  const bySession = new Map();
  for (const t of (firma && firma.tarjetas) || []) {
    if (t.origen !== 'sesion' && t.origen !== 'medio') continue;
    const k = t.sid == null ? `sin sesión:${t.titulo}` : t.sid;
    const prev = bySession.get(k);
    if (!prev || (prev.origen === 'medio' && t.origen === 'sesion')) bySession.set(k, t);
  }
  return [...bySession.values()].map((t) => {
    const nombre = String(t.quien || '').trim();
    const quien = nombre && nombre !== '—' ? nombre : t.sid == null ? '—' : `— (${t.sid.slice(0, 8)})`;
    return { sid: t.sid, quien, trabajo: String(t.titulo || ''), espera: t.espera || 'algo de vos', cerrada: t.origen === 'medio' };
  });
}

/**
 * El panel de pendientes: cinco columnas siempre en el mismo orden. En curso, Tu firma y Esperan entrar salen del estado real (una tarjeta
 * por cada sesión con trabajo, lo que quedó de las sesiones cerradas y las firmas del registro) y el tablero de la
 * coordinadora suma lo que la máquina no sabe. Una fila de una historia con corrida no aporta estado: aporta su nota. Una
 * con pedido va adonde diga el pedido; si la consulta falló, queda donde dice el archivo. «En curso» es lo que tiene una
 * sesión viva: la fila que dice «curso» sin una sesión que la haga va a «Sin sesión», y la ejecución marcada de una sesión
 * cerrada es esa misma fila, si la hay, o una tarjeta en esa columna.
 */
function buildKanban({ agents, storyOfAgent, closedRuns, halfwayCards, items, signatures, board, prAnswers, openPrs = [], openPrsNote = null, nowMs = Date.now(), projectOf = () => 'nuestro', projectOfRepo = () => 'nuestro', sidOf = new Map() }) {
  const cols = KANBAN_COLUMNS.map(([id, nombre]) => ({ id, nombre, tarjetas: [] }));
  const col = (id) => cols.find((c) => c.id === id);
  // cómo se ordena «En curso»: lo que termina antes, arriba; después lo que espera o no tiene hora, y al final la coordinadora
  const inProgress = new Map();
  // una historia puede tener más de una tarjeta, y una persona también: el tema de su fila va a todas
  const byStory = new Map();
  const addStory = (id, card) => { const k = String(id); byStory.set(k, [...(byStory.get(k) || []), card]); };
  // el número de una fila que una sesión dice en lo que hace: esa sesión hace esa fila
  const byTask = new Map();
  // la sesión de cada tarjeta: el número de su fila del tablero vuelve a su ficha, para nombrarla desde la tarjeta
  const agentOfCard = new Map();
  for (const a of agents) {
    const card = { titulo: a.titulo || a.haciendo, quien: a.nombre, hora: cardHour(a.fin), ...(a.fin && a.fin.cls ? { cls: a.fin.cls } : {}), ...(a.espera ? { espera: a.espera } : {}), ...(a.marca ? { marca: a.marca } : {}), ...(a.parada ? { motivo: a.parada } : {}), ...(a.mano ? { mano: a.mano } : {}) };
    let id = null;
    if (a.estado === 'firma') { id = 'firma'; signedBy(card, sidOf.get(a), 'sesion'); }
    // la marcada con la sesión viva va a «En curso», salvo que espere firma
    else if (a.tipo && a.estado === 'espera' && !a.marca) id = 'entrando';
    else if (a.tipo && a.estado !== 'inactiva' && a.estado !== 'libre') id = 'curso';
    // la coordinadora no es un pendiente, salvo que haya anotado un trabajo
    if (!id || (a.estado === 'coordina' && !a.titulo)) continue;
    if (a.tipo === 'stalled') card.marca = 'riesgo';
    if (a.otroProyecto) { card.quien = `${a.nombre} · Otro proyecto`; card.otro = true; }
    const hourAt = a.estado === 'esperando' ? NaN : Date.parse(a.pronosticoIso || a.estimadaIso);
    inProgress.set(card, a.estado === 'coordina' ? { tier: 2 } : Number.isFinite(hourAt) ? { tier: 0, at: hourAt } : { tier: 1 });
    const story = storyOfAgent.get(a) || a.historiaTrabajo;
    const tasks = tasksIn(a.titulo, a.haciendo);
    withWork(card, { historia: story, tarea: tasks[0], finMs: Number.isFinite(hourAt) ? hourAt : undefined, sinTitulo: !a.titulo, proyecto: a.otroProyecto ? 'otro' : a.proyecto, tituloTrabajo: a.tituloTrabajo, esNota: a.esNota || !a.titulo });
    col(id).tarjetas.push(card);
    agentOfCard.set(card, a);
    // la tarjeta se une sólo a su primer número, el mismo que usa su hecho: si nombra otros, esas filas van en su propia
    // tarjeta, porque una tarjeta lleva un solo número
    if (tasks[0]) byTask.set(tasks[0], [...(byTask.get(tasks[0]) || []), card]);
    if (story) addStory(story, card);
  }
  for (const r of closedRuns) {
    // con los pedidos sin encolar no está esperando la cola: hay que encolarlos
    const card = r.stalled ? { titulo: r.titulo, quien: r.quien, hora: 'sin hora estimada', marca: 'riesgo', motivo: 'ningún pedido está en la cola' } : { titulo: r.titulo, quien: r.quien, hora: 'esperando entrar' };
    col('entrando').tarjetas.push(withWork(card, { historia: r.storyId, proyecto: r.proyecto }));
    if (r.storyId) addStory(r.storyId, card);
  }
  // una firma dice de qué sesión es, si es de una: del proyecto de esa sesión
  for (const s of signatures) {
    const who = agents.find((a) => a.nombre === s.quien);
    col('firma').tarjetas.push(signedBy(withWork({ titulo: s.titulo, quien: s.quien, hora: s.at == null ? '' : dayHhmm(s.at) }, { proyecto: who ? (who.otroProyecto ? 'otro' : who.proyecto) : projectOf(null) }), s.sid, 'lista'));
  }
  // las ejecuciones marcadas de sesiones cerradas se cruzan con el tablero al final: pueden ser una de sus filas
  const parked = [];
  for (const h of halfwayCards) {
    withWork(h.card, { historia: h.storyId, proyecto: h.proyecto });
    if (h.columna !== 'firma') { parked.push(h); continue; }
    col(h.columna).tarjetas.push(signedBy(h.card, h.sid, 'medio'));
    if (h.storyId) addStory(h.storyId, h.card);
  }
  const boardCards = [];
  for (const f of (board && board.filas) || []) {
    // la fila que hace una sesión, por su historia o por su número, va en la tarjeta de esa sesión: no suma otra
    const joined = (f.historia && byStory.get(f.historia)) || (f.numero && byTask.get(f.numero));
    if (joined) {
      if (f.nota) joined[joined.length - 1].nota = f.nota;
      for (const c of joined) {
        if (f.numero) {
          c.numero = f.numero;
          if (agentOfCard.has(c)) agentOfCard.get(c).tarea = f.numero;
          if (!c.clave.startsWith('historia:')) c.clave = topics.workKey({ tarea: f.numero });
        }
        if (f.tema) c.tema = f.tema;
        setWorkTitle(c, f.titulo);
      }
      continue;
    }
    // el pedido que se recuerda para la fila sólo la mueve cuando entró: mientras tanto manda su `estado`
    const asked = f.pedido || f.recordado;
    const answer = asked ? (prAnswers.get(`${asked.repo}#${asked.numero}`) || {}).pr : null;
    const pr = f.pedido || (answer && answer.state === 'merged') ? answer : null;
    // la hora de una fila también puede haber pasado
    const late = Number.isFinite(f.finAt) && f.finAt < nowMs;
    const card = withWork({ titulo: f.titulo, numero: f.numero || NO_NUMBER, quien: f.quien, hora: late ? OVERDUE : f.fin, ...(late ? { cls: 'late' } : {}), ...(f.nota ? { nota: f.nota } : {}), ...(f.marca ? { marca: f.marca } : {}), ...(f.grupo ? { grupo: f.grupo } : {}), ...(f.pedido ? { pedido: cardPr(f.pedido.repo, f.pedido.numero) } : {}) }, { historia: f.historia, pedido: f.pedido, tarea: f.numero, finMs: Number.isFinite(f.finAt) ? f.finAt : undefined, tema: f.tema, proyecto: f.pedido ? projectOfRepo(f.pedido.repo) : 'nuestro' });
    let id = f.columna;
    if (id === 'hechos') card.terminadoMs = f.realAt;
    if (pr && pr.state === 'merged') {
      id = 'hechos';
      const at = Date.parse(pr.mergedAt);
      card.hora = Number.isFinite(at) ? dayHhmm(at) : 'sin hora';
      card.terminadoMs = Number.isFinite(at) ? at : null;
    } else if (pr && pr.state === 'open') {
      id = 'entrando';
      if (pr.draft === true) card.motivo = 'en borrador';
      else if (offQueueOf(pr)) card.motivo = 'fuera de la cola';
    } else if (pr) card.motivo = 'se cerró sin entrar';
    // llegó hasta acá sin una sesión viva que la haga. Si no se pudo preguntar por su pedido, no se sabe: queda donde dice el archivo
    if (id === 'curso' && (!f.pedido || pr)) id = 'sinEmpezar';
    // sin una sesión que la haga no hay nadie atrasado: se dice para cuándo estaba. Lo que espera la cola tampoco está atrasado
    if (late && id === 'sinEmpezar') { card.hora = `estaba para ${f.fin}`; delete card.cls; }
    if (late && id === 'entrando') { card.hora = 'esperando entrar'; delete card.cls; }
    inProgress.set(card, Number.isFinite(f.finAt) ? { tier: 0, at: f.finAt } : { tier: 1 });
    if (id === 'firma') signedBy(card, null, 'tablero');
    col(id).tarjetas.push(card);
    boardCards.push({ f, id, card });
  }
  for (const h of parked) {
    const byId = h.storyId ? boardCards.find((b) => b.f.historia === String(h.storyId)) : null;
    let best = byId || null;
    if (!best) {
      let top = 0;
      for (const b of boardCards) {
        if (b.id === 'hechos' || b.parked) continue;
        const score = topics.sameWorkScore(h.card.titulo, b.f.titulo);
        if (score > top) { top = score; best = b; }
      }
    }
    if (!best) { col(h.columna).tarjetas.push(h.card); continue; }
    best.parked = true;
    if (best.id !== 'hechos' && h.card.marca) best.card.marca = h.card.marca;
  }
  // los pedidos reales que esperan entrar: los que ya tienen fila del tablero no se repiten
  const onBoard = new Set(((board && board.filas) || []).filter((f) => f.pedido).map((f) => `${f.pedido.repo}#${f.pedido.numero}`.toLowerCase()));
  for (const p of openPrs) {
    if (!p.waiting || p.ajeno || onBoard.has(`${p.repoName}#${p.number}`.toLowerCase())) continue;
    col('entrando').tarjetas.push(withWork({ titulo: p.title, quien: `pedido ${p.mark}${p.number}`, hora: p.inQueue ? 'en la cola' : 'con auto-completar', pedido: cardPr(p.repo, p.number), ...(p.conflict ? { motivo: 'choca con main' } : {}) }, { pedido: { repo: p.repoName, numero: p.number }, proyecto: projectOfRepo(p.repoName) }));
  }
  if (openPrsNote) col('entrando').nota = openPrsNote;
  const rank = (c) => inProgress.get(c) || { tier: 1 };
  col('curso').tarjetas.sort((p, q) => rank(p).tier - rank(q).tier || (rank(p).tier === 0 ? rank(p).at - rank(q).at : 0));
  // «Terminados» es lo de hoy, lo último primero; lo anterior, o lo que no dice cuándo, va a la tabla «Hechos» para que la
  // columna no crezca sin fin
  const today = new Date(nowMs).toDateString();
  const done = col('hechos').tarjetas;
  const isToday = (c) => Number.isFinite(c.terminadoMs) && new Date(c.terminadoMs).toDateString() === today;
  const anteriores = done.filter((c) => !isToday(c));
  col('hechos').tarjetas = done.filter(isToday).sort((p, q) => q.terminadoMs - p.terminadoMs);
  for (const c of done) delete c.terminadoMs;
  return { anteriores, columnas: cols, medioCamino: items.filter((i) => i.estado === 'riesgo' && i.accion).map((i) => Object.defineProperties({ titulo: i.titulo, quien: i.quien, accion: i.accion }, { trabajo: { value: i.trabajo }, historia: { value: i.historia }, proyecto: { value: i.proyecto } })) };
}

/**
 * La línea de arriba del kanban, armada de las tarjetas: lo primero de «En curso» que tiene hora (ya van por hora), lo
 * que espera la firma del dueño, lo trabado (lo mismo que cuenta el cuadro de resumen) y cuándo se escribió el tablero.
 */
function boardLine(kanban, { trabado = [], escritoAt = null, hourOf = (c) => c.finMs } = {}) {
  const of = (id) => ((kanban.columnas || []).find((c) => c.id === id) || { tarjetas: [] }).tarjetas;
  const first = of('curso').find((c) => Number.isFinite(hourOf(c)));
  const parts = [first ? `Sale primero: ${first.numero && first.numero !== NO_NUMBER ? `${first.numero} ` : ''}${first.titulo} · ${first.quien} · ${first.hora}` : 'Nada con hora en curso'];
  parts.push(`Tu firma: ${of('firma').length}`, `Trabado: ${trabado.reduce((n, g) => n + g.filas.length, 0)}`);
  if (Number.isFinite(escritoAt)) parts.push(`Tablero escrito a las ${hhmm(escritoAt)}`);
  return parts.join(' · ');
}

/**
 * «¿Cómo va la T-41?»: la tarjeta con ese número, en una línea (columna, título, quién, hora, nota y pedido). `dados`: los
 * números que dio el tablero, para decir si uno que no está se borró. `ultimo`: el último hecho que movió la fila, en una
 * línea, que va al final. `{ code: 0|1, line, card }`.
 */
function findTask(data, id, { dados = {}, ultimo = null } = {}) {
  const want = boardTool.taskId(id);
  if (!want) return { code: 1, line: `«${id}» no es un número de tarea: va como T-41 o 41` };
  const line = (columna, card) => [want, columna, card.titulo, card.quien || '—', card.hora || '—', card.nota || '—', card.pedidoTexto ? `pedido ${card.pedidoTexto}` : 'sin pedido', ...(ultimo ? [ultimo] : [])].join(' · ');
  for (const c of data.kanban.columnas) {
    const card = c.tarjetas.find((t) => t.numero === want);
    if (card) return { code: 0, card, line: line(c.nombre, card) };
  }
  const old = (data.kanban.anteriores || []).find((t) => t.numero === want);
  if (old) return { code: 0, card: old, line: line('Hechos', old) };
  return { code: 1, line: Object.prototype.hasOwnProperty.call(dados, want) ? `${want} no está en el tablero: esa fila se borró del tablero («${dados[want]}»)` : `${want} no está en el tablero` };
}

/** El aviso de un tablero que cambió sin board.js (lo que el freno no vio); null si no cambió o no se puede saber. */
// Cerrada por su proceso: una de Claude con un pid. Las que no tienen pid (Codex) siguen la regla de las horas.
function closedByPid(f) {
  const pid = Number(f && f.pid);
  return Boolean(f) && f.tool === 'claude' && f.pid != null && Number.isInteger(pid) && pid > 0;
}

const REMOVE_REASONS = { open: 'ya no está cerrada', disabled: 'el registro de sesiones está apagado en esta máquina', error: 'la máquina no dejó borrarlo' };

/**
 * «Quitar» de una cerrada: borra su archivo de estado y nada más (el marcador de su corrida queda). Sólo si está entre
 * las cerradas de la última foto y su archivo, releído, sigue siendo de Claude con el proceso muerto; justo antes de
 * borrar lo relee otra vez y, si cambió (se reabrió), no lo borra. `{ status, motivo }`: 204 borrada o ya no estaba,
 * 409 ya no está cerrada, 500 si no se pudo.
 */
function removeClosed(sdir, sid, closedIds, { isAlive: alive = isAlive, env = process.env, beforeUnlink = null, unlink = fs.unlinkSync } = {}) {
  const no = (status, why) => ({ status, motivo: REMOVE_REASONS[why] });
  if (typeof sid !== 'string' || !(closedIds || []).includes(sid)) return no(409, 'open');
  if (!sessionState.enabled(env)) return no(500, 'disabled');
  const file = sessionState.pathOf(sdir, sid);
  const read = () => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  let text;
  try { text = read(); } catch { return no(500, 'error'); }
  if (text == null) return { status: 204 };
  let f;
  try { f = JSON.parse(text); } catch { f = null; }
  if (!closedByPid(f) || !sessionState.isStale(f, { isAlive: alive })) return no(409, 'open');
  if (beforeUnlink) beforeUnlink();
  try {
    if (read() !== text) return no(409, 'open');
    unlink(file);
  } catch (e) {
    if (e.code === 'ENOENT') return { status: 204 };
    sessionState.logError(sdir, `sesión ${sid}: no pude quitar su estado (${e.code || e.message})`);
    return no(500, 'error');
  }
  return { status: 204 };
}

function boardEditedNotice(sdir) {
  const p = boardTool.printCheck(sdir);
  if (p && p.ilegible) return `no se puede leer la huella del tablero (${p.motivo}): no sé si se editó fuera del comando; corré board.js check`;
  return p && p.cambiado ? `el tablero se editó fuera del comando a las ${hhmm(p.at)}: corré board.js check` : null;
}

// Las dos tablas: sus títulos, sus columnas y qué columnas del kanban cuenta cada una.
const TABLES = {
  hoy: { titulo: 'Hoy', columnas: ['Tema', 'Qué tendremos', 'Cómo va'], ids: [['curso', 'En curso'], ['firma', 'Tu firma'], ['entrando', 'Esperan entrar'], ['hechos', 'Terminados']] },
  pendientes: { titulo: 'Pendientes', columnas: ['Tema', 'Qué queda', 'Cuándo'], ids: [['sinEmpezar', 'Sin sesión']] },
};
const HALFWAY_WORD = 'A medio camino';
const COLUMN_WORD = { curso: 'En curso', firma: 'Tu firma', entrando: 'Esperan entrar', hechos: 'Terminado', sinEmpezar: 'Sin sesión', medio: HALFWAY_WORD };
const LONG_DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
// a una semana o más, el día solo se leería como el de esta semana: lleva la fecha
const FAR_DAYS_MS = 7 * 86400000;
const dayWord = (ms, nowMs) => {
  if (sameDay(ms, nowMs)) return 'hoy';
  const d = new Date(ms);
  const date = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  return Math.abs(ms - nowMs) >= FAR_DAYS_MS ? `${LONG_DAYS[d.getDay()]} ${date}` : LONG_DAYS[d.getDay()];
};
const capitalized = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const hoursOf = (cards) => cards.map((c) => c.finMs).filter(Number.isFinite);
const nextHour = (hours, nowMs) => { const ahead = hours.filter((h) => h >= nowMs); return ahead.length ? Math.min(...ahead) : null; };
const lateWord = (n) => (n === 1 ? '1 pasó su hora' : `${n} pasaron su hora`);

// Cómo va un tema hoy, contado de sus tarjetas: la fila no lo escribe nadie.
function todayLine(of, nowMs) {
  const parts = [];
  if (of.curso.length) {
    const hours = hoursOf(of.curso);
    const next = nextHour(hours, nowMs);
    const late = hours.filter((h) => h < nowMs).length;
    const when = next != null ? `, el próximo termina ${sameDay(next, nowMs) ? `a las ${hhmm(next)}` : `el ${dayWord(next, nowMs)} ${hhmm(next)}`}` : late ? `, ${lateWord(late)}` : '';
    parts.push(`${of.curso.length} en curso${when}`);
  }
  const n = of.firma.length;
  if (n) parts.push(n === 1 ? '1 espera tu firma' : `${n} esperan tu firma`);
  const e = of.entrando.length;
  if (e) parts.push(e === 1 ? '1 espera entrar' : `${e} esperan entrar`);
  const h = of.hechos.length;
  if (h) parts.push(h === 1 ? '1 terminado hoy' : `${h} terminados hoy`);
  return parts.join(' · ');
}

// Cuándo, en un tema de lo que no tiene sesión: cuántos pasaron su hora y cuál es la próxima.
function pendingLine(of, nowMs) {
  const hours = hoursOf(of.sinEmpezar);
  const late = hours.filter((h) => h < nowMs);
  const next = nextHour(hours, nowMs);
  const parts = [];
  if (late.length) {
    const first = dayWord(Math.min(...late), nowMs);
    parts.push(`${lateWord(late.length)}, ${late.length === 1 ? (first === 'hoy' ? 'hoy' : `el ${first}`) : `desde ${first === 'hoy' ? 'hoy' : `el ${first}`}`}`);
  }
  if (next != null) parts.push(`la próxima, ${dayWord(next, nowMs)} ${hhmm(next)}`);
  // una hora escrita a mano no se puede ordenar, pero es una hora. Es texto libre: la de otro proyecto se cuenta y no se dice
  const written = of.sinEmpezar.filter((c) => !Number.isFinite(c.finMs) && c.hora && !/^sin hora/.test(c.hora));
  const sayable = written.filter((c) => !c.otro && !c.sinSaber);
  if (sayable.length) parts.push(sayable.length === 1 ? sayable[0].hora : `${sayable[0].hora} y ${sayable.length - 1} más`);
  if (written.length > sayable.length) parts.push(`${written.length - sayable.length} con hora`);
  const none =of.sinEmpezar.length - hours.length - written.length;
  if (none) parts.push(`${none} sin hora`);
  if (of.medio.length) parts.push(`${of.medio.length} a medio camino`);
  return capitalized(parts.join(' · '));
}

// Hasta dos trabajos y cuántos más.
function namedWorks(works) {
  // dos tarjetas de un mismo trabajo (lo que espera entrar y la nota de cómo sigue) se nombran una vez
  const all = [...new Set(works.map((w) => w.titulo))];
  const names = all.slice(0, 2);
  if (all.length > 2) names.push(`y ${all.length - 2} más`);
  return names.join('; ');
}

// Un trabajo adentro de su tema: título, quién y cómo va.
function workOfCard(id, c) {
  const hour = !c.hora || c.hora === 'sin hora estimada' ? '' : c.hora;
  return { titulo: c.tituloTrabajo || c.titulo, quien: c.quien || '', como: [COLUMN_WORD[id], c.tituloTrabajo ? c.titulo : '', c.espera, c.motivo, hour].filter(Boolean).join(' · '), ...(c.numero ? { numero: c.numero } : {}), ...(c.otro || c.sinSaber ? { otro: true } : {}) };
}

// Las tarjetas de una tabla, juntas por tema: de más a menos trabajos, y al final «Otro proyecto» y «Otros».
function rowsByTopic(entries, ctx, line, nowMs) {
  // «Frenos» y «frenos» son un tema, y los dos nombres reservados se escriben siempre igual
  const reserved = new Map([topics.OTHERS, topics.OTHER_PROJECT].map((t) => [topics.topicKey(t), t]));
  const groups = new Map();
  for (const { id, card } of entries) {
    const tema = topics.topicOf(card, ctx);
    const key = topics.topicKey(tema);
    if (!groups.has(key)) groups.set(key, { grupo: reserved.get(key) || tema, list: [] });
    groups.get(key).list.push({ id, card });
  }
  const last = (tema) => (tema === topics.OTHERS ? 2 : tema === topics.OTHER_PROJECT ? 1 : 0);
  return [...groups.values()]
    .sort((x, y) => last(x.grupo) - last(y.grupo) || y.list.length - x.list.length)
    .map(({ grupo, list }) => {
      const trabajos = list.map(({ id, card }) => workOfCard(id, card));
      const of = { curso: [], firma: [], entrando: [], hechos: [], sinEmpezar: [], medio: [] };
      for (const { id, card } of list) of[id].push(card);
      return { grupo, que: namedWorks(trabajos), col: line(of, nowMs), trabajos, ...(grupo === topics.OTHER_PROJECT || trabajos.some((w) => w.otro) ? { otro: true } : {}) };
    });
}

// Lo que quedó a medio camino, como una tarjeta más: su tema es el del trabajo que era, porque su título nombra una carpeta.
const halfwayWorks = (kanban) => (kanban.medioCamino || []).map((m) => ({ titulo: m.titulo, quien: m.quien, hora: '', clave: topics.workKey({ historia: m.historia, titulo: m.trabajo || m.titulo }), trabajo: m.trabajo, ...(m.proyecto === 'otro' ? { otro: true } : {}), ...(m.proyecto === 'nose' ? { sinSaber: true } : {}) }));

/** Lo que hay que clasificar de la foto: el título de cada trabajo, y de lo que quedó a medio camino, el del trabajo que era. */
function workCards(kanban) {
  const cards = kanban.columnas.flatMap((c) => c.tarjetas || []);
  return [...cards, ...halfwayWorks(kanban).filter((c) => c.trabajo).map((c) => ({ ...c, titulo: c.trabajo }))];
}

// La tabla «Hechos»: lo terminado antes de hoy. Sus tres datos son qué, quién y cuándo: la página dibuja las tablas por posición,
// y acá la primera es el título.
function doneTable(kanban) {
  const filas = (kanban.anteriores || []).map((c) => ({ grupo: c.titulo, que: c.quien || '', col: c.hora || 'sin hora' }));
  return { titulo: 'Hechos', columnas: ['Qué', 'Quién', 'Cuándo'], filas, escrito: 'Lo terminado antes de hoy' };
}

/**
 * Las tablas, sin leer nada: salen enteras de las tarjetas del kanban ya calculado, una fila por tema. `temas` es lo guardado;
 * `sinModelo` y `prs`, el respaldo por títulos de pedidos; `nota`, lo que la tabla tiene que decir una vez del modelo.
 */
function buildTables({ kanban, nowMs, temas = {}, sinModelo = false, prs = [], nota = null }) {
  const cards = (id) => ((kanban.columnas.find((c) => c.id === id) || {}).tarjetas || []);
  const entriesOf = (ids) => ids.flatMap(([id]) => cards(id).map((card) => ({ id, card })));
  const inKanban = (ids) => ids.map(([id, nombre]) => `${cards(id).length} ${nombre.toLowerCase()}`).join(' · ');
  const cross = (say) => `Agrupa por tema: una fila puede juntar varios trabajos. En el kanban, de a uno: ${say}.`;
  const armada = `Armada a las ${hhmm(nowMs)}`;
  const ctx = { temas, sinModelo, prs };
  const halfway = halfwayWorks(kanban);
  const out = {
    hoy: { titulo: TABLES.hoy.titulo, columnas: TABLES.hoy.columnas, filas: rowsByTopic(entriesOf(TABLES.hoy.ids), ctx, todayLine, nowMs), escrito: nota ? `${armada}. ${nota}` : armada, cruce: cross(inKanban(TABLES.hoy.ids)) },
    pendientes: {
      titulo: TABLES.pendientes.titulo,
      columnas: TABLES.pendientes.columnas,
      filas: rowsByTopic([...entriesOf(TABLES.pendientes.ids), ...halfway.map((card) => ({ id: 'medio', card }))], ctx, pendingLine, nowMs),
      escrito: armada,
      cruce: cross(`${inKanban(TABLES.pendientes.ids)} · ${halfway.length} a medio camino`),
      vacio: 'No hay pendientes',
    },
    hechos: doneTable(kanban),
  };
  return out;
}

// La fila de cada pedido recordado: su clave no cambia con la hora ni con la sesión, y con número tampoco con el título.
// Lo recordado antes por el título sigue valiendo hasta que se guarda con la clave nueva.
const rowKey = (f) => topics.workKey({ historia: f.historia, tarea: f.numero, titulo: f.titulo });
const oldRowKey = (f) => topics.workKey({ historia: f.historia, titulo: f.titulo });
const rememberedRow = (filas, f) => filas[rowKey(f)] || filas[oldRowKey(f)];

// Las ramas que comparte todo el equipo: el pedido de `dev` no dice qué hace la sesión parada ahí.
const SHARED_BRANCHES = new Set(['dev', 'develop', 'main', 'master']);

/**
 * Qué pedido se recuerda, sin leer nada: el de la rama de una sesión viva, para la única fila abierta que la nombra (con varias,
 * no se sabe de cuál es), y el de cada sesión, para sus esperas. Lo ya recordado sigue aunque la sesión se cierre; lo de una
 * fila que ya no está abierta se olvida; lo de una sesión, si cambió de rama. Sin saber qué filas hay (`filas` null, un tablero
 * ilegible) no se olvida nada. Una fila nombra a la sesión con ese nombre; si ninguna lo tiene entero, a la única cuya primera
 * palabra coincide. `sessions`: `{ nombre, sid, repo, identity, branch }`.
 */
function rowPrsNow({ filas, memory, openPrs, sessions }) {
  const fullName = (t) => String(t || '').trim().toLowerCase();
  const sessionOf = (quien) => {
    const exact = sessions.filter((s) => fullName(s.nombre) === fullName(quien));
    const list = exact.length ? exact : sessions.filter((s) => firstWord(s.nombre) === firstWord(quien));
    return list.length === 1 ? list[0] : null;
  };
  const prOf = (s) => (s.branch && !SHARED_BRANCHES.has(s.branch.toLowerCase()) ? openPrs.find((p) => !p.ajeno && p.branch === s.branch && String(p.repoName).toLowerCase() === String(s.repo).toLowerCase()) : null);
  const remembered = (s, p) => ({ repo: s.repo, numero: p.number, identity: s.identity });
  let next = memory.filas;
  if (filas) {
    const open = filas.filter((f) => f.estado !== 'hecho');
    const named = new Map();
    for (const f of open) {
      const s = f.quien ? sessionOf(f.quien) : null;
      if (s) named.set(s.sid, (named.get(s.sid) || 0) + 1);
    }
    next = {};
    for (const f of open) {
      const key = rowKey(f);
      if (f.pedido) continue;
      if (rememberedRow(memory.filas, f)) { next[key] = rememberedRow(memory.filas, f); continue; }
      const s = f.quien ? sessionOf(f.quien) : null;
      if (!s || named.get(s.sid) !== 1) continue;
      const p = prOf(s);
      if (p) next[key] = remembered(s, p);
    }
  }
  const sesiones = {};
  for (const s of sessions) {
    const p = prOf(s);
    const was = memory.sesiones && memory.sesiones[s.sid];
    if (p) sesiones[s.sid] = { ...remembered(s, p), branch: s.branch };
    else if (was && was.branch === s.branch) sesiones[s.sid] = was;
  }
  return { filas: next, sesiones };
}

/** Le pone a cada fila del tablero el pedido que se recuerda para ella. */
function applyRowPrs(board, memory) {
  for (const f of (board && board.filas) || []) {
    const r = rememberedRow(memory.filas, f);
    if (r && !f.pedido) f.recordado = r;
  }
}

/** Con las respuestas: lo que entró guarda su hora, para no volver a preguntar; lo cerrado sin entrar se olvida. */
function settleRowPrs(board, answers, memory) {
  const filas = { ...memory.filas };
  for (const f of (board && board.filas) || []) {
    if (!f.recordado) continue;
    const pr = (answers.get(`${f.recordado.repo}#${f.recordado.numero}`) || {}).pr;
    if (oldRowKey(f) !== rowKey(f)) delete filas[oldRowKey(f)];
    if (pr && pr.state === 'merged') filas[rowKey(f)] = { ...f.recordado, mergedAt: pr.mergedAt };
    else if (pr && pr.state === 'closed') { delete filas[rowKey(f)]; delete f.recordado; }
  }
  return { ...memory, filas };
}

// El tablero que escribe la coordinadora en `<estado>/coordination/tablero.json`: `pendientes` (titulo, estado, grupo,
// orden, quien, nota, estimadaIso, pronosticoIso, realIso, termina, historia, pedido: {repo, numero}) y `meta`
// (actualizado, resumen, teToca). Sus `agentes` no se usan: los escritorios salen de /wip.
const BOARD_GROUPS = ['Hoy', 'Esta semana', 'La semana que viene', 'Más adelante'];
// Las columnas del panel de pendientes, y adónde va cada estado del tablero; uno desconocido, a lo que no arrancó.
const KANBAN_COLUMNS = [['sinEmpezar', 'Sin sesión'], ['curso', 'En curso'], ['firma', 'Tu firma'], ['entrando', 'Esperan entrar'], ['hechos', 'Terminados']];
const BOARD_COLUMN = { firma: 'firma', curso: 'curso', riesgo: 'curso', entrando: 'entrando', espera: 'sinEmpezar', 'sin-empezar': 'sinEmpezar', hecho: 'hechos' };
const BOARD_TEXT_MAX = 300;
const text = (v) => (typeof v === 'string' ? v.trim().slice(0, BOARD_TEXT_MAX) : '');
// la hora local de la página del tablero, 'YYYY-MM-DDTHH:MM', como la dice la oficina: «mar 18:00»
const boardMs = (v) => {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(typeof v === 'string' ? v : '');
  if (!m) return null;
  const ms = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  return Number.isFinite(ms) ? ms : null;
};
const boardHour = (v) => { const ms = boardMs(v); return ms == null ? '' : dayHhmm(ms); };

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
      finAt: estado === 'hecho' || text(p.termina) ? null : orElse(boardMs(p.pronosticoIso), boardMs(p.estimadaIso)),
      realAt: estado === 'hecho' ? boardMs(p.realIso) : null,
      estado, grupo: text(p.grupo), ...(text(p.tema) ? { tema: text(p.tema) } : {}), columna: Object.prototype.hasOwnProperty.call(BOARD_COLUMN, estado) ? BOARD_COLUMN[estado] : 'sinEmpezar', marca: estado === 'riesgo' ? 'riesgo' : null, historia, pedido,
      numero: typeof p.id === 'string' && boardTool.ID.test(p.id) ? p.id : null,
    };
  });
  // lo escribió alguien a mano sin numerar: la oficina no escribe el tablero, lo dice una vez con el comando
  const sinNumero = filas.filter((f) => !f.numero).length;
  if (sinNumero) avisos.push(`el tablero tiene ${sinNumero === 1 ? '1 fila' : `${sinNumero} filas`} sin número: guardalo una vez con board.js save --from <tu archivo aparte>`);
  // `meta.resumen` no se muestra: la línea de arriba del kanban se arma sola de las tarjetas
  return {
    actualizado: boardHour(meta.actualizado) || text(meta.actualizado),
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

// La foto fija lleva la librería adentro; la página del proceso local la pide a su dirección, con el token.
const moduleUrl = (live) => (key) => `/modules/${encodeURIComponent(key)}?t=${live.token}`;
const importMap = (live = null) => PARTS.importMap(live ? moduleUrl(live) : null);

/**
 * La página entera. Con `live`, la del proceso local: pide su código y sus datos con el token. Sin él, la foto fija, que
 * lleva todo adentro. El enlace al sitio sale de acá, no de lo que llega después por la conexión.
 */
function page(data, { live = null } = {}) {
  const site = data && data.meta && data.meta.sitio;
  if (!live) return PARTS.renderPage({ data, site });
  return PARTS.renderPage({ source: 'local', token: live.token, site, urlOf: moduleUrl(live), script: `page.js?t=${live.token}` });
}

// Una clave de la configuración, con el mismo lector que el comando /org-site: sale 0 con el valor, 3 si no está y 2 si
// la configuración no se pudo leer.
function readConfigKey(key) {
  const r = require('child_process').spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lib', 'tycon-config.js'), 'get', key], { input: '', encoding: 'utf8', timeout: 5000, windowsHide: true });
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
// dueño. Son las mismas que el kanban cruza con el tablero; lo demás que quedó a medio camino no tiene tarjeta, y su fila manda.
const storiesWithCard = (wip) => new Set([
  ...(wip.extra || []).map((x) => x && x.storyId),
  ...(wip.halfwayItems || []).filter((h) => h && h.awaits).map((h) => h.storyId),
].filter(Boolean).map(String));

// Los pedidos que nombra el tablero, salvo los de una fila cuya historia tiene corrida en esta máquina: esa manda. Se
// preguntan sólo ésos (la consulta de la oficina viva los recuerda un minuto). Lo que falla queda en `problems`.
async function askBoardPrs(board, wip, opts, problems, open = { prs: [] }) {
  const answers = new Map();
  const runs = storiesWithCard(wip);
  const seen = new Set();
  const asked = [];
  for (const f of (board && board.filas) || []) {
    if (f.historia && runs.has(f.historia)) continue;
    // el pedido que se recuerda para la fila se pregunta sólo si salió de la lectura de abiertos y todavía no se sabe que entró
    const p = f.pedido || f.recordado;
    if (!p) continue;
    const key = `${p.repo}#${p.numero}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!f.pedido && p.mergedAt) { answers.set(key, { pr: { state: 'merged', mergedAt: p.mergedAt } }); continue; }
    if (!f.pedido && open.prs.some((x) => x.number === p.numero && String(x.repoName).toLowerCase() === String(p.repo).toLowerCase())) continue;
    asked.push({ root: `pedido:${key}`, repo: p.repo, numero: p.numero, identity: f.pedido ? identityOfRepo(p.repo, wip) : p.identity });
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

// Una lectura de pedidos de más de esto ya no dice qué sigue abierto: un pedido entra en minutos. Con una página viva se
// renueva cada 3 (office/server.js).
const OPEN_PRS_OLD_MS = 15 * 60000;
const PR_KIND_PREFIX = /^[a-z]+(?:\([^)]*\))?!?:\s*/i;
/**
 * Los pedidos abiertos de los repos del arnés, de la última lectura que dejó `stuck-pr-notice.js` en
 * `<estado>/stuck-prs-photo.json`; armar la foto no sale a la red por esto. Sólo cuentan como esperando entrar los que no son
 * borrador y están en la cola o con auto-completar. Devuelve `{ prs, note }`; `note` dice qué se midió o que no se pudo.
 */
function readOpenPrs(sdir, nowMs) {
  let photo;
  try { photo = JSON.parse(fs.readFileSync(path.join(sdir, 'stuck-prs-photo.json'), 'utf8')); } catch { photo = null; }
  const at = photo ? Date.parse(photo.at) : NaN;
  // qué repos sigue el arnés no cambia en 15 minutos: una lectura vieja no sirve para los pedidos, pero sí para eso
  const repos = photo && photo.lecturas ? Object.keys(photo.lecturas).map((repo) => repo.split('/').pop().toLowerCase()) : null;
  if (!photo || !photo.lecturas || !Number.isFinite(at) || nowMs - at > OPEN_PRS_OLD_MS) return { prs: [], measured: false, repos, note: 'Los pedidos no se midieron: no hay una lectura de los últimos 15 minutos.' };
  let own;
  try { own = JSON.parse(fs.readFileSync(path.join(sdir, 'own-prs.json'), 'utf8')); } catch { own = null; }
  if (own && !(nowMs - Date.parse(own.at) <= OPEN_PRS_OLD_MS)) own = null;
  const prs = new Map();
  const unread = [];
  const add = (lecturas, ajeno) => {
    for (const [repo, r] of Object.entries(lecturas || {})) {
      const repoName = repo.split('/').pop();
      if (!r || !r.ok || !Array.isArray(r.value)) { unread.push(repoName); continue; }
      for (const p of r.value) {
        if (!p || !Number.isInteger(p.number)) continue;
        const github = /^[^/]+\/[^/]+$/.test(repo);
        prs.set(`${repo}#${p.number}`.toLowerCase(), { ajeno, repo, repoName, number: p.number, mark: github ? '#' : '!', branch: p.sourceBranch || null, title: plain(String(p.title || '').replace(PR_KIND_PREFIX, '')) || 'Un pedido sin título', inQueue: p.inQueue === true, conflict: p.mergeState === 'conflict' || p.mergeState === 'dirty', waiting: !p.draft && (p.inQueue === true || p.autoComplete === true) });
      }
    }
  };
  // la lista de los repos del arnés sigue sabiendo si un pedido está abierto; la columna muestra sólo los de la persona
  add(photo.lecturas, true);
  if (own) add(own.lecturas, false);
  const failed = own ? (own.fallos || []) : [];
  const whoNote = !own ? ' No muestro pedidos: no pude saber quién sos en esta máquina.' : failed.length ? ` No pude leer tus pedidos de ${failed.join(', ')}.` : '';
  const note = `Tus pedidos en la cola o con auto-completar, leídos a las ${hhmm(at)}.${unread.length ? ` No se pudo leer ${unread.join(', ')}.` : ''}${whoNote}`;
  return { prs: [...prs.values()], measured: true, note, repos };
}

// Un trabajo que quedó y nombra sus pedidos («#878», «!6008»): si todos entraron, entró, aunque su carpeta siga con otra cosa.
// «#» es de GitHub y «!» de Azure: el mismo número en otro repo es otro pedido. Lo que no se puede preguntar no dice que entró.
const NAMED_PR = /(?:^|[\s(])([#!])(\d{3,})\b/g;
async function askHalfwayPrs(wip, opts) {
  const plan = [];
  const asked = new Map();
  for (const h of wip.halfwayItems || []) {
    if (h.entered || !Array.isArray(h.folders) || !h.folders.length || typeof h.text !== 'string') continue;
    const remotes = h.folders.map((f) => remoteOfFolder(f)).filter((q) => q && q.kind);
    const named = [...h.text.matchAll(NAMED_PR)].map(([, sign, n]) => ({ sign, numero: Number(n), keys: [] }));
    if (!named.length) continue;
    for (const n of named) {
      for (const q of remotes) {
        if ((n.sign === '#') !== (q.kind === 'github')) continue;
        const key = `${q.name}#${n.numero}`;
        n.keys.push(key);
        if (!asked.has(key)) asked.set(key, { root: `pedido:${key}`, repo: q.name, numero: n.numero, identity: identityOf(q) });
      }
    }
    plan.push({ h, named });
  }
  if (!asked.size) return;
  const list = [...asked.values()];
  const replies = await (opts.queryPrs || readPrs)(list);
  const merged = new Set();
  list.forEach((q, i) => { const r = replies[i]; if (r && r.pr && r.pr.state === 'merged') merged.add(`${q.repo}#${q.numero}`); });
  for (const { h, named } of plan) if (named.every((n) => n.keys.some((k) => merged.has(k)))) h.entered = true;
}

// Los pedidos que nombra una nota: «#915», «!6116», «pedido 913» y el número que sigue a otro («#915 y 6116»). Un número
// suelto («la 8.182», «a las 1900») no es un pedido.
function prsNamedIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/([#!]|\bpedidos?\s+|\by\s+|,\s*)?(?<![\d.])(\d{3,})\b/gu)) {
    const before = (m[1] || '').trim();
    const continues = before === 'y' || before === ',';
    if (!before || (continues && !out.length) || out.some((n) => n.numero === Number(m[2]))) continue;
    out.push({ numero: Number(m[2]), sign: before === '#' || before === '!' ? before : null });
  }
  return out;
}

const WAITED_ENDED = new Set(['merged', 'closed']);
// Qué se dice de los pedidos de una espera, de los que terminaron. Lo que sigue abierto o no se sabe queda como espera.
function waitedPrsSaid(results) {
  const entered = results.filter((r) => r.state === 'merged').map((r) => r.numero);
  const closed = results.filter((r) => r.state === 'closed').map((r) => r.numero);
  if (!entered.length && !closed.length) return null;
  const list = (ns) => ns.map((n, i) => (i ? `el ${n}` : `El ${n}`)).join(' y ');
  const parts = [];
  if (entered.length) parts.push(`${list(entered)} ya ${entered.length === 1 ? 'entró' : 'entraron'}`);
  if (closed.length) parts.push(`${list(closed)} se ${closed.length === 1 ? 'cerró' : 'cerraron'} sin entrar`);
  return { text: parts.join(' · '), all: entered.length + closed.length === results.length };
}

/**
 * De las notas de espera que nombran pedidos, cuáles ya terminaron. Lo abierto sale de la lectura de pedidos; uno que ya no está
 * ahí se pregunta por número, una sola vez, al repo de la carpeta de la sesión y con el mismo lector de los demás pedidos. Una
 * ausencia no dice que entró. Un número sin marca puede ser de otro repo, así que tiene que haber entrado después de la nota, y
 * «se cerró» no se dice de él: un pedido cerrado no trae fecha. Sin una lectura de pedidos no se pregunta nada. El pedido de la
 * rama de la sesión (`opts.sessionPrs`, por sesión) cuenta si la nota no nombra ninguno, y sólo si entró después de anotarla.
 * Lo que entró antes de anotar la espera no la tira: esa espera es de otra cosa.
 */
async function askWaitingPrs(wip, open, opts, known) {
  const out = new Map();
  if (!open.measured) return out;
  const plan = [];
  const asked = new Map();
  const sessionPrs = opts.sessionPrs || {};
  (wip.rows || []).forEach((row, i) => {
    const x = (wip.extra && wip.extra[i]) || {};
    const d = (wip.details && wip.details[i]) || {};
    const named = x.waitingFor && d.sid != null ? prsNamedIn(x.waitingFor) : [];
    // la nota que nombra pedidos espera esos; la que no nombra ninguno, el de su rama
    const own = x.waitingFor && d.sid != null && !named.length ? sessionPrs[String(d.sid)] : null;
    if (own) {
      const n = { numero: own.numero, branch: true, open: open.prs.some((p) => p.number === own.numero && String(p.repoName).toLowerCase() === String(own.repo).toLowerCase()) };
      if (!n.open) {
        n.key = `${own.repo}#${own.numero}`;
        if (!known.has(n.key) && !asked.has(n.key)) asked.set(n.key, { root: `pedido:${n.key}`, repo: own.repo, numero: own.numero, identity: own.identity });
      }
      named.push(n);
    }
    if (!named.length) return;
    const q = x.cwd || x.runFolder ? remoteOfFolder(x.cwd || x.runFolder) : null;
    for (const n of named) {
      if (n.branch) continue;
      n.open = open.prs.some((p) => p.number === n.numero && (!n.sign || p.mark === n.sign));
      if (n.open || !q || !q.kind || (n.sign && (n.sign === '#') !== (q.kind === 'github'))) continue;
      n.key = `${q.name}#${n.numero}`;
      if (!known.has(n.key) && !asked.has(n.key)) asked.set(n.key, { root: `pedido:${n.key}`, repo: q.name, numero: n.numero, identity: identityOf(q) });
    }
    plan.push({ sid: String(d.sid), named, since: x.waitingSince });
  });
  const list = [...asked.values()];
  if (list.length) {
    const replies = await (opts.queryPrs || readPrs)(list);
    list.forEach((q, i) => {
      const pr = replies[i] && replies[i].pr;
      if (pr && WAITED_ENDED.has(pr.state)) known.set(`${q.repo}#${q.numero}`, { state: pr.state, mergedAt: Date.parse(pr.mergedAt) });
    });
  }
  for (const { sid, named, since } of plan) {
    const results = named.map((n) => {
      const a = n.key ? known.get(n.key) : null;
      if (!a) return { numero: n.numero, state: null };
      const after = a.state === 'merged' && Number.isFinite(since) && a.mergedAt > since;
      if (n.sign) return { numero: n.numero, state: a.state === 'merged' && Number.isFinite(since) && !after ? null : a.state };
      return { numero: n.numero, state: after ? 'merged' : null };
    });
    const said = waitedPrsSaid(results);
    if (said) out.set(sid, said);
  }
  return out;
}

// La rama de una carpeta, recordada un minuto por la oficina viva; '' si no se puede saber.
const BRANCH_KEEP_MS = 60000;
function branchOfFolder(dir, remembered, nowMs) {
  const seen = remembered.branches.get(dir);
  if (seen && nowMs - seen.at < BRANCH_KEEP_MS) return seen.branch;
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 2000, windowsHide: true });
  const branch = r.status === 0 ? r.stdout.trim() : '';
  remembered.branches.set(dir, { at: nowMs, branch });
  return branch;
}

// Las sesiones cuyo pedido hay que recordar: las que nombra una fila abierta y las que anotaron una espera. La carpeta es la de su
// ejecución, si tiene: una sesión puede estar parada en otro checkout. Una sesión quieta sin trabajo anotado también cuenta:
// es la que dejó su pedido en la cola y espera.
function sessionsForPrs(wip, board, remoteOf, remembered, nowMs, liveSessions = new Map()) {
  const named = new Set(((board && board.filas) || []).filter((f) => f.estado !== 'hecho' && f.quien).map((f) => firstWord(f.quien)));
  const out = [];
  (wip.rows || []).forEach((row, i) => {
    const x = (wip.extra && wip.extra[i]) || {};
    const d = (wip.details && wip.details[i]) || {};
    const cwd = x.runFolder || x.cwd;
    if (!cwd || d.sid == null || !(x.waitingFor || named.has(firstWord(row.session)))) return;
    const q = remoteOf(cwd);
    if (q && q.kind) out.push({ nombre: row.session, sid: String(d.sid), repo: q.name, identity: identityOf(q), branch: branchOfFolder(cwd, remembered, nowMs) });
  });
  (wip.free || []).forEach((name, i) => {
    const sid = (wip.freeSids || [])[i];
    const s = sid != null ? liveSessions.get(sid) || liveSessions.get(String(sid)) : null;
    if (!s || !s.cwd || !named.has(firstWord(name))) return;
    const q = remoteOf(s.cwd);
    if (q && q.kind) out.push({ nombre: name, sid: String(sid), repo: q.name, identity: identityOf(q), branch: branchOfFolder(s.cwd, remembered, nowMs) });
  });
  return out;
}

// Las sesiones de un repo que el arnés no sigue, de los que lee la lista de pedidos. Si no se sabe de qué repo es, cuenta.
function otherProjectsOf(wip, open, remoteOf) {
  const out = new Set();
  if (!open.repos) return out;
  (wip.rows || []).forEach((row, i) => {
    const x = (wip.extra && wip.extra[i]) || {};
    const d = (wip.details && wip.details[i]) || {};
    const q = d.sid != null && (x.cwd || x.runFolder) ? remoteOf(x.cwd || x.runFolder) : null;
    if (q && q.kind && q.name && !open.repos.includes(String(q.name).toLowerCase())) out.add(String(d.sid));
  });
  return out;
}

// Un número de tokens en llano: «762 mil», «95,6 millones».
function tokensTxt(n) {
  if (n < 1000) return String(n);
  if (n < 999500) return `${Math.round(n / 1000)} mil`;
  const m = n / 1e6;
  if (m < 1.05) return '1 millón';
  const said = m < 100 ? m.toFixed(1).replace('.', ',').replace(/,0$/, '') : String(Math.round(m)).replace(/\B(?=(\d{3})+$)/g, '.');
  return `${said} millones`;
}

// El modelo con su nombre corto: `claude-opus-5-5` es «Opus 5.5», y el sufijo entre corchetes va en palabras
// (`[1m]`, «(1M)»). Uno que no se conoce va tal como viene; sin modelo, «sin dato».
const NO_DATA = 'sin dato';
function modelWords(id) {
  if (typeof id !== 'string' || !id) return NO_DATA;
  const suffix = /\[([^\]]*)\]$/.exec(id);
  const bare = id.replace(/\[[^\]]*\]$/, '');
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)$/.exec(bare);
  const name = m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : bare;
  return suffix ? `${name} (${suffix[1].toUpperCase()})` : name;
}
// El esfuerzo con la palabra del selector de /model; uno que no se conoce va tal como viene.
const EFFORT_WORDS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
const effortWords = (e) => (typeof e === 'string' && e ? EFFORT_WORDS[e] || e : NO_DATA);

// Lo que dice la tarjeta de los tokens de una sesión. Su modelo y su esfuerzo van en campos que no se enumeran: no salen
// en `tokens` (ni al sitio por ahí); la foto los pasa a cada sesión, que es lo que la página lee.
function tokensCard(t) {
  const how = { modelo: { value: modelWords(t && t.modelo) }, esfuerzo: { value: effortWords(t && t.esfuerzo) } };
  if (!t || t.noMedido) return Object.defineProperties({ noMedido: true }, how);
  const contexto = t.limite ? `${tokensTxt(t.contexto)} de ${tokensTxt(t.limite)} · ${Math.round((t.contexto / t.limite) * 100)} %` : `${tokensTxt(t.contexto)} · porcentaje no medido`;
  return Object.defineProperties({ contexto, consumidos: `Read ${tokensTxt(t.lectura)} · Write ${tokensTxt(t.escritura)} · Cache Read ${tokensTxt(t.cache)}`, agentes: t.agentes }, how);
}

// El ajuste de compactación de cada modelo, de la configuración de esta máquina. Sin él, cuenta la ventana del modelo.
function readModelSettings(home) {
  try { const s = JSON.parse(fs.readFileSync(path.join(claudeDir(home), 'settings.json'), 'utf8')); return s && s.modelSettings; } catch { return null; }
}

// Los tokens de cada persona de la oficina, por nombre. Quedan al nivel de arriba de la foto, como los sobres: la lista de
// lo que viaja al sitio no los trae. Lo que ya se contó no se vuelve a leer (`counts`).
function readTokens(wip, states, counts, { home, nowMs, projectsDir, codexHome, cxNames }) {
  const dir = projectsDir || path.join(claudeDir(home), 'projects');
  const modelSettings = readModelSettings(home);
  const out = {};
  for (const p of peopleOf(wip)) {
    const file = transcriptOf(dir, p.sid, p.cwd);
    if (file && !out[p.name]) out[p.name] = tokensCard(readSessionTokens(file, counts, { modelSettings }));
  }
  for (const f of states) {
    if (f.tool !== 'codex') continue;
    // el mismo nombre con que sale su tarjeta
    const name = f.name || cxNames.get(f.session) || String(f.session).slice(0, 8);
    if (out[name]) continue;
    const file = codexTranscript(codexHome || path.join(home, '.codex'), f.session, { now: nowMs });
    if (file) out[name] = tokensCard(readSessionTokens(file, counts, {}));
  }
  return out;
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

// El archivo de la conversación de una sesión de Claude: en la carpeta de su arranque, o en la de un proyecto en el que arrancó
// antes de cambiar de carpeta (`cwd` es la de ahora, y la conversación no se muda). null si no está.
function transcriptOf(dir, sid, cwd) {
  if (!SAFE_SID.test(String(sid))) return null;
  const name = `${sid}.jsonl`;
  if (typeof cwd === 'string' && cwd) {
    const guess = path.join(dir, cwd.replace(/[^A-Za-z0-9-]/g, '-'), name);
    if (fs.existsSync(guess)) return guess;
  }
  let folders;
  try { folders = fs.readdirSync(dir); } catch { return null; }
  for (const f of folders) {
    const file = path.join(dir, f, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * Los hilos de Codex que no son sesiones de una persona: los que lanzó un guion (`exec`) y los subagentes, de la base más
 * nueva, en sólo lectura. Sin Codex, ninguno. Si la base no se puede leer no se sabe: no se oculta nada y se dice una vez.
 */
function codexAgentThreads(codexHome, problems) {
  const unknown = () => { problems.push('No pude leer la lista de sesiones de Codex: alguna de estas personas puede ser un agente.'); return new Set(); };
  let bases;
  try { bases = fs.readdirSync(codexHome).filter((f) => /^state_\d+\.sqlite$/.test(f)); } catch (e) { return e.code === 'ENOENT' ? new Set() : unknown(); }
  const newest = bases.sort((a, b) => Number(/\d+/.exec(a)[0]) - Number(/\d+/.exec(b)[0])).pop();
  if (!newest) return new Set();
  let db = null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(path.join(codexHome, newest), { readOnly: true });
    const cols = new Set(db.prepare('PRAGMA table_info(threads)').all().map((c) => c.name));
    const where = [cols.has('source') ? "source = 'exec'" : null, cols.has('thread_source') ? "thread_source = 'subagent'" : null].filter(Boolean);
    if (!where.length) return unknown();
    return new Set(db.prepare(`SELECT id FROM threads WHERE ${where.join(' OR ')}`).all().map((r) => String(r.id)));
  } catch { return unknown(); } finally { try { if (db) db.close(); } catch { /* ya cerrada */ } }
}

// Los agentes que corren ahora en cada sesión con persona en la oficina: `sesión → { codex, claude }`. Los de Codex, bajo su
// proceso; una sesión de Codex no da el suyo y no se cuentan.
function countRunningAgents(wip, sessions, processes, { dir, nowMs }) {
  const out = new Map();
  for (const p of peopleOf(wip)) {
    const session = sessions.get(p.sid);
    const codex = (session && session.alive && codexAgentsUnder(session.pid, processes)) || 0;
    const file = transcriptOf(dir, p.sid, p.cwd);
    const claude = file ? claudeAgentsActive(file, nowMs) : 0;
    if (codex || claude) out.set(p.sid, { codex, claude });
  }
  return out;
}

// Cuándo se escribió por última vez la conversación de cada sesión de /wip, por sesión: sólo la fecha del archivo.
function readLastWrites(wip, { home, projectsDir }) {
  const out = new Map();
  const dir = projectsDir || path.join(claudeDir(home), 'projects');
  (wip.details || []).forEach((d, i) => {
    if (!d || d.sid == null) return;
    const file = transcriptOf(dir, d.sid, ((wip.extra && wip.extra[i]) || {}).cwd);
    if (!file) return;
    try { out.set(String(d.sid), fs.statSync(file).mtimeMs); } catch { /* se fue: no se sabe */ }
  });
  return out;
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
    say(d.sid, transcriptOf(dir, d.sid, x.cwd), row.session);
  });
  for (const f of states) {
    if (f.tool === 'codex' && !f.step && !out.has(String(f.session))) say(f.session, codexTranscript(codexHome || path.join(home, '.codex'), f.session, { now: nowMs }), f.name || String(f.session).slice(0, 8));
  }
  return out;
}

// Lo que se dice de una sesión sin corrida abierta, de su conversación: su oración es lo que está haciendo. El título no sale
// de acá: el encargo son las instrucciones de quien la abrió, y su último mensaje ya es lo que hace. Sin nada legible, desde
// cuándo no hay novedades. Lo que ella misma anotó (`annotated`) le gana a lo que se deduce de su último mensaje.
function saySession(a, said, fallbackAt, annotated = false) {
  if (said.encargo) a.encargo = said.encargo;
  if (said.ultimaAccion) a.ultimaAccion = said.ultimaAccion;
  if (annotated) return;
  if (said.haciendoAhora) a.haciendoAhora = said.haciendoAhora;
  if (said.haciendoAhora) { a.haciendo = said.haciendoAhora; return; }
  const at = [said.lastWriteMs, fallbackAt].find(Number.isFinite);
  a.haciendo = at === undefined ? 'Sin novedades.' : `Sin novedades desde las ${hhmm(at)}`;
}

// Los sobres: lo que vive sólo en el proceso de la oficina abierta. La foto fija y `--json` no lo crean, así que ni los
// sobres ni la conversación pueden salir de esa oficina. De cada conversación se recuerda hasta dónde se leyó: si no
// creció, no se lee nada. El texto nunca entra en la foto: se pide al tocar a una persona (`conversationOf`).
const ENVELOPE_WINDOW_MS = 60 * 1000;
const createEnvelopes = () => ({ offsets: new Map(), files: new Map(), recent: new Map(), coordinator: null, tokens: new Map(), prsEnded: new Map(), remotes: new Map(), branches: new Map() });

// Las personas de la oficina que tienen una sesión: las que trabajan y las libres.
function peopleOf(wip) {
  const people = [];
  (wip.rows || []).forEach((row, i) => {
    const d = (wip.details && wip.details[i]) || {};
    if (d.sid != null) people.push({ name: row.session, sid: String(d.sid), cwd: ((wip.extra && wip.extra[i]) || {}).cwd });
  });
  (wip.free || []).forEach((name, i) => { const sid = (wip.freeSids || [])[i]; if (sid != null) people.push({ name, sid: String(sid) }); });
  return people;
}

function readEnvelopes(env, wip, { home, nowMs, projectsDir, sessions }) {
  const dir = projectsDir || path.join(claudeDir(home), 'projects');
  const people = peopleOf(wip);
  env.files.clear();
  for (const p of people) {
    const file = transcriptOf(dir, p.sid, p.cwd);
    if (!file) continue;
    const session = sessions && sessions.get(p.sid);
    if (!env.files.has(p.name)) env.files.set(p.name, { file, sid: p.sid, background: Boolean(session) && session.kind === 'bg' });
    let offset = env.offsets.get(file);
    if (offset === undefined) {
      // la primera vez, desde poco antes del final: lo viejo no vuela
      try { offset = Math.max(0, fs.statSync(file).size - TAIL_BYTES); } catch { continue; }
    }
    const got = peerMessagesSince(file, offset);
    env.offsets.set(file, got.offset);
    for (const m of got.items) if (!env.recent.has(m.id)) env.recent.set(m.id, { id: m.id, de: m.de, a: p.name, at: m.at });
  }
  for (const [id, m] of env.recent) if (!Number.isFinite(m.at) || nowMs - m.at > ENVELOPE_WINDOW_MS) env.recent.delete(id);
  return [...env.recent.values()].sort((p, q) => p.at - q.at);
}

// Los estados en que su pantalla espera un cuadro de la persona (`ASKS_OWNER`) y en que está trabajando: un mensaje de la
// oficina entra recién cuando contesta el cuadro o cuando termina el paso.
const WORKING = ['trabajando', 'prueba'];

/**
 * A quién se le puede escribir desde la oficina, sólo en la oficina viva: a cada persona le pone `recibe` (`si`, `sin-vigilante`,
 * `codex`, `apagado` o `espera-cierre`) y deja en `env.recipients` su sesión y su estado, para el proceso. La lista cerrada de
 * lo que viaja al sitio (`office/fields.js`) no lo lleva.
 */
function markRecipients(data, env, states, sdir, { isAlive, startOf, cxNames = new Map() } = {}) {
  const om = require(path.join(ROOT, 'scripts', 'lib', 'office-messages.js'));
  const off = process.env.TYCON_OFFICE_MESSAGES === '0';
  // con el mismo nombre que le pone la oficina a una sesión de Codex sin nombre en su archivo
  const codex = new Set(states.filter((s) => s.tool === 'codex' && (s.name || s.session)).map((s) => s.name || cxNames.get(s.session) || String(s.session).slice(0, 8)));
  env.recipients = new Map();
  for (const a of data.agents || []) {
    if (!a || !a.nombre) continue;
    const e = env.files.get(a.nombre);
    let recibe;
    if (off) recibe = 'apagado';
    else if (codex.has(a.nombre)) recibe = 'codex';
    else if (!e) continue;
    else {
      const w = om.watcherState(sdir, e.sid, { ...(isAlive ? { isAlive } : {}), ...(startOf ? { startOf } : {}) });
      recibe = w.alive ? 'si' : (Number.isFinite(w.deliveredAt) ? 'espera-cierre' : 'sin-vigilante');
    }
    a.recibe = recibe;
    env.recipients.set(a.nombre, { sid: e ? e.sid : null, recibe, estado: a.estado, ocupada: WORKING.includes(a.estado), cuadro: ASKS_OWNER.has(a.estado) });
  }
}

/** Los últimos mensajes de una persona que está en la oficina, a pedido; null si no está. Nada de esto se guarda. */
function conversationOf(env, name, { lastActivityOf = (n) => closedSessionLastAt(os.homedir(), n) } = {}) {
  const e = env.files.get(name);
  if (!e) return null;
  const c = env.coordinator;
  // la designada puede no tener nombre (una sesión de VS Code nombrada por click): sigue siendo la coordinadora, y su
  // ventana no dice que no hay. Se la llama por su cargo, como la nombran las sesiones; nunca por su identificador
  const said = readConversation(e.file, { coordinator: c && (c.name || 'Coordinadora'), isCoordinator: Boolean(c) && e.sid === c.sid, background: e.background });
  return said && said.conSesiones ? markClosedSessions(said, env, { lastActivityOf }) : said;
}

/**
 * «Con las sesiones» de la coordinadora: primero las vivas (las mismas que tienen escritorio), después las cerradas,
 * cada grupo con la que habló último primero. A una cerrada se le pone la hora de su última actividad, o null si no se
 * encuentra su conversación: la hora en que se cerró no está escrita en ningún lado.
 */
function markClosedSessions(said, env, { lastActivityOf }) {
  const live = said.conSesiones.filter((s) => env.files.has(s.sesion));
  const closed = said.conSesiones.filter((s) => !env.files.has(s.sesion)).map((s) => ({ ...s, cerrada: true, ultimaActividad: lastActivityOf(s.sesion) }));
  return { ...said, conSesiones: [...live, ...closed] };
}

// La hora del último renglón de la conversación de una sesión ya cerrada, buscada por su nombre en el estado de las
// sesiones de fondo (la más reciente con ese nombre); null si no se encuentra.
function closedSessionLastAt(home, name) {
  const dir = path.join(claudeDir(home), 'jobs');
  let best = null;
  let ids = [];
  try { ids = fs.readdirSync(dir); } catch { return null; }
  for (const id of ids) {
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, id, 'state.json'), 'utf8')); } catch { continue; }
    if (!s || s.name !== name || typeof s.linkScanPath !== 'string') continue;
    if (!best || String(s.updatedAt) > String(best.updatedAt)) best = s;
  }
  if (!best) return null;
  let tail;
  try {
    const fd = fs.openSync(best.linkScanPath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      tail = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  for (const line of tail.split('\n').reverse()) {
    const m = /"timestamp":"([^"]+)"/.exec(line);
    const at = m ? Date.parse(m[1]) : NaN;
    if (Number.isFinite(at)) return at;
  }
  return null;
}

/** Mueve el tablero con los hechos de la foto. La foto sale igual si falla: el motivo va una vez a lo que no se pudo leer. */
function syncBoardFromPhoto(sdir, facts, complete, problems, { now, home, sync = boardTool.sync } = {}) {
  try {
    const r = sync(sdir, facts, { complete, now, home });
    if (r && r.aviso) problems.push(r.aviso);
    return r;
  } catch (e) {
    problems.push(`el tablero no se movió solo: ${e.message}`);
    return null;
  }
}

// El proceso de la oficina de esta máquina está vivo: es él quien mueve el tablero.
function officeProcessAlive(sdir) {
  try {
    const { pid } = JSON.parse(fs.readFileSync(path.join(sdir, 'office', 'server.json'), 'utf8'));
    return Number.isInteger(pid) && isAlive(pid);
  } catch { return false; }
}

/** Lee todo lo de esta máquina y arma los datos; guarda las promesas al día. */
async function collect(opts = {}) {
  const home = opts.home || os.homedir();
  const sdir = opts.stateDir || stateDir(home);
  const nowMs = opts.now ? Date.parse(opts.now) : Date.now();
  const wip = await wipNow(opts);
  const problems = [];
  let signatures = [];
  try {
    const open = signatureList.abiertos(home, { arnes: opts.arnes, env: opts.env, ahora: nowMs });
    problems.push(...open.problemas);
    const names = sessionsBySid(opts.sessionsDir || path.join(claudeDir(home), 'sessions'), [], null);
    signatures = open.filas.map((f) => (f.destino && names.get(f.destino) ? { ...f, nombre: names.get(f.destino).name } : f));
  } catch (e) { problems.push(`las firmas pendientes no se pudieron leer: ${e.message}`); }
  const des = designacionVigente({ dir: sdir });
  if (des && des.error) problems.push(`no se sabe cuál es la coordinadora: ${des.error}`);
  const coordinatorSid = des && des.sesion ? des.sesion : null;
  let coordinatorName = null;
  const sessions = sessionsBySid(opts.sessionsDir || path.join(claudeDir(home), 'sessions'), [], null);
  if (coordinatorSid) {
    const s = sessions.get(coordinatorSid);
    coordinatorName = s && s.name ? s.name : null;
  }
  // lo que se recuerda de una foto a la otra; la foto fija empieza de cero
  const remembered = opts.envelopes || createEnvelopes();
  const file = path.join(sdir, 'office', 'promises.json');
  const saved = readPromises(file);
  if (saved.problem) problems.push(saved.problem);
  // los archivos de estado de cada sesión; uno que no se puede usar se dice, y esa sesión sale como la deduce /wip
  const ss = sessionState.readAll(sdir);
  problems.push(...ss.problems);
  // un agente lanzado por un guion escribe su archivo como cualquier Codex, pero no es una sesión: desde acá no existe. El que
  // anotó un trabajo o va por un paso sí lo es
  const mayBeAgent = (s) => s.tool === 'codex' && !s.step && (!s.sentence || s.sentence === sessionState.NO_PIPELINE);
  const agentThreads = ss.states.some(mayBeAgent) ? codexAgentThreads(opts.codexHome || path.join(home, '.codex'), problems) : new Set();
  const isAgent = (s) => mayBeAgent(s) && agentThreads.has(String(s.session));
  const states = ss.states.filter((s) => !isAgent(s));
  const cxNames = states.some((s) => s.tool === 'codex' && !s.name) ? codexNames(opts.codexHome || path.join(home, '.codex'), problems) : new Map();
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
  const edited = board.board ? boardEditedNotice(sdir) : null;
  if (edited) problems.push(edited);
  const open = readOpenPrs(sdir, nowMs);
  const remoteOf = (cwd) => {
    if (!remembered.remotes.has(cwd)) remembered.remotes.set(cwd, remoteOfFolder(cwd));
    return remembered.remotes.get(cwd);
  };
  // de qué proyecto es algo, por lo que se sabe: lo que no se puede decir que es de un repo que sigue el arnés no sale de la máquina
  const projectOfRepo = (name) => (!open.repos ? 'nose' : open.repos.includes(String(name || '').split('/').pop().toLowerCase()) ? 'nuestro' : 'otro');
  const projectOf = (folder) => {
    if (!folder || !open.repos) return 'nose';
    const q = remoteOf(folder);
    return q && q.kind && q.name ? projectOfRepo(q.name) : 'nose';
  };
  // el pedido que se recuerda para cada fila y cada sesión: sin una lectura de abiertos no se aprende nada nuevo
  const rowMemory = topics.readRowPrs(sdir);
  if (rowMemory.problem) problems.push(rowMemory.problem);
  const rowFilas = board.board ? board.board.filas : board.problem ? null : [];
  const rowPrs = rowPrsNow({ filas: rowFilas, memory: rowMemory, openPrs: open.measured ? open.prs : [], sessions: sessionsForPrs(wip, board.board, remoteOf, remembered, nowMs, sessions) });
  applyRowPrs(board.board, rowPrs);
  const prAnswers = await askBoardPrs(board.board, wip, opts, problems, open);
  const rowPrsAfter = settleRowPrs(board.board, prAnswers, rowPrs);
  if (!opts.readOnly && JSON.stringify({ filas: rowPrsAfter.filas, sesiones: rowPrsAfter.sesiones }) !== JSON.stringify({ filas: rowMemory.filas, sesiones: rowMemory.sesiones })) {
    try { topics.saveRowPrs(sdir, rowPrsAfter.filas, nowMs, rowPrsAfter.sesiones); } catch (e) { problems.push(`row-prs.json no se pudo guardar (${e.code || e.message})`); }
  }
  await askHalfwayPrs(wip, opts);
  const transcripts = opts.noTranscripts ? null : readTranscripts(wip, states, { home, nowMs, projectsDir: opts.projectsDir, codexHome: opts.codexHome }, problems);
  const lastWrites = readLastWrites(wip, { home, projectsDir: opts.projectsDir });
  // los procesos se leen sólo si alguien está en un paso de pruebas o hay un agente de Codex sin terminar
  const needsTree = (wip.extra || []).some((x) => x && x.kind === 'pipeline') || ss.states.some((s) => isAgent(s) && s.busy !== false);
  const processes = opts.processes !== undefined ? opts.processes : needsTree ? require(path.join(ROOT, 'scripts', 'lib', 'owner-window.js')).leerArbol() : null;
  const runningAgents = countRunningAgents(wip, sessions, processes, { dir: opts.projectsDir || path.join(claudeDir(home), 'projects'), nowMs });
  const waitingPrs = await askWaitingPrs(wip, open, { ...opts, sessionPrs: rowPrsAfter.sesiones }, remembered.prsEnded);
  const testSessions = wip.testSids || new Set();
  const personSessions = new Set([...sessions].filter(([, s]) => s.kind === 'interactive').map(([sid]) => String(sid)));
  const { data, promises, facts, factsComplete } = buildOffice({ wip, signatures, coordinatorSid, coordinatorName, promises: saved.promises, nowMs, sessionFiles: states, codexNames: cxNames, runningAgents, quietMin, board: board.board, prAnswers, transcripts, lastWrites, processes, openPrs: open.prs, openPrsNote: open.note, waitingPrs, testSessions, personSessions, otherProjects: otherProjectsOf(wip, open, remoteOf), projectOf, projectOfRepo });
  // el tablero se mueve solo con los hechos de esta foto: lo hace sólo quien tiene el candado de la oficina, con board.js
  if (opts.syncBoard && board.board && !opts.readOnly) syncBoardFromPhoto(sdir, facts, factsComplete && open.measured !== false, problems, { now: nowMs, home, sync: opts.boardSync });
  // sólo con la oficina abierta: la primera pasada lee conversaciones enteras, y la foto fija y `--json` empezarían de cero cada vez
  if (opts.envelopes && !opts.noTranscripts) data.tokens = readTokens(wip, states, remembered.tokens, { home, nowMs, projectsDir: opts.projectsDir, codexHome: opts.codexHome, cxNames });
  // el modelo y el esfuerzo de cada sesión, de su última respuesta: van con la persona, a su etiqueta y a sus tarjetas
  if (data.tokens) for (const a of data.agents) { const t = data.tokens[a.nombre]; if (t) { a.modelo = t.modelo; a.esfuerzo = t.esfuerzo; } }
  // lo del tablero que no es una fila: su resumen, lo que dice que le toca al dueño y cuándo se escribió
  const savedTopics = topics.readTopics(sdir);
  if (savedTopics.problem) problems.push(savedTopics.problem);
  const topicState = topics.readState(sdir).state;
  const sinModelo = Boolean(topicState.sinModelo);
  data.tablas = buildTables({ kanban: data.kanban, nowMs, temas: savedTopics.temas, sinModelo, prs: sinModelo ? topics.prScopes(topics.readPrTitles(sdir)) : [], nota: topics.tableNote(topicState, nowMs) });
  // sólo la oficina viva deja qué falta clasificar: la foto fija y `--json` no lanzan nada
  if (opts.envelopes) {
    try { topics.writePending(sdir, topics.pendingWorks(workCards(data.kanban), savedTopics.temas)); } catch (e) { problems.push(`los trabajos por clasificar no se pudieron guardar (${e.code || e.message})`); }
  }
  data.tablero = board.board ? { actualizado: board.board.actualizado, teToca: board.board.teToca } : null;
  if (opts.envelopes) {
    opts.envelopes.coordinator = coordinatorSid ? { sid: coordinatorSid, name: coordinatorName } : null;
    data.sobres = readEnvelopes(opts.envelopes, wip, { home, nowMs, projectsDir: opts.projectsDir, sessions });
    markRecipients(data, opts.envelopes, states, sdir, { cxNames });
  }
  if (board.board && Number.isFinite(board.writtenAt)) data.kanban.escrito = `Tablero escrito a las ${hhmm(board.writtenAt)}${nowMs - board.writtenAt > quietMin * 60000 ? ' (vieja)' : ''}`;
  data.kanban.linea = boardLine(data.kanban, { trabado: data.meta.trabado, escritoAt: board.board ? board.writtenAt : null });
  data.unreadable.push(...problems);
  // el enlace al sitio, sólo con una dirección web: cualquier otra cosa no se muestra
  let site;
  try { site = await (opts.siteUrl || readSiteUrl)(); } catch (e) { site = { code: 2, out: e.message }; }
  const url = site.code === 0 ? String(site.out || '').trim() : '';
  if (/^https?:\/\/\S+$/i.test(url)) data.meta.sitio = url;
  else if (site.code === 2) data.unreadable.push(`la dirección del sitio no se pudo leer: ${String(site.out || '').trim().split('\n')[0] || 'sin motivo'}`);
  if (!opts.readOnly) try {
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
  const child = run(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
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
    const child = spawn(process.execPath, [path.join(__dirname, 'office', 'server.js')], { detached: true, stdio: ['ignore', 'ignore', out], windowsHide: true });
    fs.closeSync(out);
    let exited = null;
    child.on('exit', (code) => { exited = code; });
    child.unref();
    // el proceso nuevo se va sin tocar el candado (sale 0) si el que está sólo tardaba en contestar: vale cualquier
    // candado cuyo dueño conteste, con su pid. El plazo es por hora y pasa los 10 s que el nuevo le espera al de antes
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const lock = readLock();
      if (lock && await answers(lock)) return { url: urlOf(lock), reused: lock.pid !== child.pid };
      if (exited != null && exited !== 0) break;
      await sleep(50);
    }
    let why = 'no contestó en 15 s';
    try { why = fs.readFileSync(log, 'utf8').trim().split('\n').pop() || why; } catch { /* sin registro */ }
    try { process.kill(child.pid, 'SIGTERM'); } catch { /* ya salió */ }
    throw new Error(`la oficina viva ${why}`);
  } finally {
    try { fs.unlinkSync(mutex); } catch { /* ya no está */ }
  }
}

/**
 * La dirección de la oficina de esta máquina en el sitio, o null si la oficina se ve sólo acá: sin sitio, con el enlace
 * apagado, sin aprobar, o sin saber cómo se llama la máquina. El nombre es el de la subida al buzón: con él la conoce el sitio.
 */
function officeInSite(sdir) {
  const { linkedSite, readLinkState } = require('./office/site-link.js');
  const site = linkedSite(readSiteUrl());
  if (!site || readLinkState(sdir) !== 'aprobada') return null;
  let machine = null;
  try { machine = require('../metrics/upload-runs.js').nombreDeMaquina(); } catch { /* sin nombre, la local */ }
  return machine ? `${new URL(site).origin}/offices#${encodeURIComponent(machine)}` : null;
}

async function main(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--owner-waits') opts.ownerWaits = true;
    else if (a === '--open') opts.open = true;
    else if (a === '--local') opts.local = true;
    else if (a === '--write-tables') {
      process.stderr.write('office.js: las tablas se arman solas: ya no se escriben. El tema de un trabajo se corrige con `tema` en su fila del tablero.\n');
      return 2;
    } else if (a === '--out' || a === '--now' || a === '--task') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) { process.stderr.write(`office.js: ${a} pide un valor\n`); return 2; }
      opts[a.slice(2)] = v;
    } else { process.stderr.write(`office.js: opción desconocida ${a}\n`); return 2; }
  }
  // lo que espera a la persona en «Tu firma», para la coordinadora: sólo mira, no escribe nada (ni el tablero, ni los pedidos
  // de las filas, ni las promesas), así no compite con la oficina viva
  if (opts.ownerWaits) {
    let data;
    try { data = await collect({ now: opts.now, noTranscripts: false, syncBoard: false, readOnly: true }); } catch (e) {
      if (e.code === 'NO_STATE' || e.code === 'BAD_ARG') { process.stderr.write(`office.js: ${e.message}\n`); return 2; }
      throw e;
    }
    process.stdout.write(`${JSON.stringify({ esperas: ownerWaitsOf(data), problemas: data.unreadable || [] })}\n`);
    return 0;
  }
  // --open sin foto fija: la pestaña del sitio si esta máquina está aprobada; si no, la oficina viva, del proceso local
  if (opts.open && !opts.json && !opts.out && !opts.now) {
    const inSite = opts.local ? null : officeInSite(stateDir(os.homedir()));
    if (inSite) {
      process.stdout.write(`La oficina está en el sitio: ${inSite}\n`);
      if (process.env.TYCON_OFFICE_NO_BROWSER !== '1') openFile(inSite);
      return 0;
    }
    let r;
    try { r = await openLive(); } catch (e) { process.stderr.write(`office.js: ${String(e.message).split('\n')[0]}\n`); return 1; }
    process.stdout.write(r.reused ? `La oficina ya estaba abierta: ${r.url}\n` : `La oficina está abierta en ${r.url}\n`);
    const { waitingLine, linkedSite } = require('./office/site-link.js');
    const waiting = waitingLine(stateDir(os.homedir()));
    // sin sitio o con el enlace apagado, nadie la aprueba ni el estado cambia: la línea no diría nada cierto
    if (waiting && linkedSite(readSiteUrl())) process.stdout.write(`${waiting}\n`);
    if (process.env.TYCON_OFFICE_NO_BROWSER !== '1') openFile(r.url);
    return 0;
  }
  let data;
  // la foto que queda en un archivo no lleva nada de las conversaciones: eso sólo viaja en la foto viva
  // sin el proceso de la oficina, el tablero lo mueve esta foto; una foto de otra hora no escribe nada
  const sdir = stateDir(os.homedir());
  try { data = await collect({ now: opts.now, noTranscripts: !opts.json && !opts.task, syncBoard: !opts.now && !officeProcessAlive(sdir) }); } catch (e) {
    if (e.code === 'NO_STATE' || e.code === 'BAD_ARG') { process.stderr.write(`office.js: ${e.message}\n`); return 2; }
    throw e;
  }
  if (opts.task) {
    const r = findTask(data, opts.task, { dados: boardTool.readNumbers(sdir).dados, ultimo: boardTool.lastFactLine(sdir, boardTool.taskId(opts.task)) });
    if (opts.json && r.card) process.stdout.write(`${JSON.stringify(r.card, null, 2)}\n`);
    else process.stdout.write(`${r.line}\n`);
    return r.code;
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

module.exports = { ownerWaitsOf, closedByPid,removeClosed, markRecipients, markClosedSessions, closedSessionLastAt, prsNamedIn, waitedPrsSaid, askWaitingPrs, tokensTxt, tokensCard, buildOffice, buildBoard, boardLine, findTask, boardEditedNotice, syncBoardFromPhoto, page, importMap, moduleSource, collect, createEnvelopes, conversationOf, waysOfWorking, openFile, openLive, deskSlots, readSiteUrl, readQuietMinutes, plain, plainWhole, runningTests, cardPr, codexAgentsUnder, claudeAgentsActive, buildTables, rowPrsNow, applyRowPrs, settleRowPrs, workCards, readTranscripts, readLastWrites, MODULES };
