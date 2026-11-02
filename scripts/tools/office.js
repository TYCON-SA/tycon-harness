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
 * Arriba del tablero van dos tablas, «Hoy» y «Pendientes» (`buildTables`). Las escribe la coordinadora (`tablas` en su tablero)
 * o, sin coordinadora, cualquier sesión a pedido, cada una en su archivo (`<estado>/coordination/tablas/<sesión>.json`), así que
 * varias no se pisan y se muestran juntas. Sin nadie que las escriba, se arman con lo que el arnés sabe, y en vez de una
 * probabilidad, que juzga una persona, dicen la hora anotada. Las dos escriben con `office.js --write-tables <archivo.json>`.
 *
 * `--open` abre la oficina viva: arranca el proceso local de office/server.js (o reusa el que ya está) y abre su
 * dirección; la página recibe cada cambio por WebSocket. `--out` escribe la foto fija en un archivo, y `--json` imprime
 * los datos. La foto fija es un solo archivo, sin nada de afuera: la librería 3D (three.js 0.160.0, MIT, en
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
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const { stateDir, claudeDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
const { designacionVigente } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'critical-waivers.js'));
const { resolveSessionId } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'session-id.js'));
const { OVERDUE_HOUR: OVERDUE, wipNow, sessionsBySid, codexNames, realState, replacedByNewer, hourVerdict, readPrs, offQueueOf, identityOf, remoteOfFolder, SAFE_SID, LOOSE_STALE_MS } = require('./work-in-progress.js');
const signatureList = require(path.join(ROOT, 'scripts', 'lib', 'signature-list.js'));
const sessionState = require(path.join(ROOT, 'scripts', 'lib', 'session-state.js'));
const { readTranscript, codexTranscript, peerMessagesSince, readConversation, readSessionTokens, TAIL_BYTES } = require(path.join(ROOT, 'scripts', 'lib', 'session-transcript.js'));

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
    if (!s.destino) { cards.push({ titulo: `Firma: ${plain(s.title)}`, quien: 'vos', at, linea: `Firmar: ${plain(s.title)}` }); continue; }
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
    cards.push({ titulo: `${isPermission ? '' : 'Firma: '}${plain(first.title)}${more}`, quien, at: first.at, conTarjeta: waits,
      yaAvisada: waits && (agent.espera === 'que apruebes el plan' || agent.espera === 'el ok para guardar'),
      linea: `${isPermission ? '' : 'Firmar: '}${plain(first.title)}${more} (${quien})` });
  }
  return cards;
}

// Lo trabado, por a quién espera: la primera sesión abierta que nombra su espera; si no nombra ninguna, «otra cosa». La
// tanda más grande primero, y «otra cosa» al final.
function stuckGroups(agents, coordinatorName) {
  const groups = new Map();
  const names = agents.map((a) => a.nombre).filter(Boolean);
  for (const a of agents) {
    if (a.estado !== 'esperando') continue;
    const said = String(a.termina || '').replace(/^espera /, '');
    const who = names.find((n) => n !== a.nombre && new RegExp(`(?<![\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu').test(said)) || null;
    if (!groups.has(who)) groups.set(who, []);
    groups.get(who).push(`${a.nombre}: ${said}`);
  }
  const verb = (n) => `${n} ${n === 1 ? 'espera' : 'esperan'}`;
  return [...groups.entries()].sort(([p, x], [q, y]) => (p === null) - (q === null) || y.length - x.length)
    .map(([who, filas]) => ({ titulo: who === null ? `${verb(filas.length)} otra cosa` : `${verb(filas.length)} a ${who === coordinatorName ? 'la ' : ''}${who}`, filas }));
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
  sessionFiles = [], codexNames: cxNames = new Map(), quietMin = QUIET_DEFAULT_MIN, isAlive, board = null, prAnswers = new Map(), transcripts = null, lastWrites = new Map(), processes = null, openPrs = [], openPrsNote = null, waitingPrs = null, testSessions = new Set(), personSessions = new Set(), otherProjects = new Set() } = {}) {
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
    if (replacesClosed) closedRuns.push({ titulo: runTitle, quien: row.session, storyId: x0.storyId, stalled: x0.kind === 'stalled' });
    // el archivo manda en lo que sabe: el paso mientras hay pipeline, el trabajo suelto declarado y la espera; lo que no
    // sabe (la entrada a los repos, la nota, la actividad sin marcador) sigue saliendo de /wip
    const knows = !replaced && Boolean(f) && ((x.kind === 'pipeline' && f.step) || x.kind === 'loose');
    const lastWrite = d.sid != null ? lastWrites.get(String(d.sid)) : undefined;
    const real = notStoppedYet(realState(x, dNow, fNow), lastWrite, Number(d.statusAt), nowMs);
    // «Corriendo pruebas» sólo con pruebas corriendo: estar en el paso no alcanza
    const tests = real.estado === 'prueba' ? runningTests(f && f.pid, processes, f ? f.tool : undefined) : undefined;
    if (tests === false || tests === null) real.estado = 'trabajando';
    // lo que espera algo manda también sobre la coordinadora
    const isCoordinator = Boolean(coordinatorSid) && d.sid === coordinatorSid;
    const prsSaid = waitingPrs && d.sid != null ? waitingPrs.get(String(d.sid)) : null;
    // si ya pasó todo lo que esperaba, la espera vieja no se dice: se dice qué pasó
    const waitingFor = prsSaid && prsSaid.all ? '' : plain(x0.waitingFor, { keepPrs: true });
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
      // con la hora de su paso, el atraso se mide contra ésa, y lo prometido queda como dato
      const reference = x.hourStep || x.noteEnd != null ? endAt : kept[key].at;
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
    a.tipo = x.kind || null;
    // sale de su marca: una nota no cambia cómo trabaja una sesión, y un arreglo rápido más nuevo sí
    if (x.kind === 'note' && (replaced || x.finishedStoryId)) a.comoTrabaja = waysOfWorking('pipeline', x0.storyId || x.finishedStoryId);
    else a.comoTrabaja = waysOfWorking(x.kind, replaced ? null : x0.storyId);
    // sin pipeline, lo que dice su propia conversación
    const said = transcripts && NO_RUN_KINDS.has(x.kind) && d.sid != null ? transcripts.get(String(d.sid)) : null;
    if (said) saySession(a, said, x.lastAt, Boolean(titulo) && (x.kind === 'note' || x.kind === 'loose'));
    // el primer mensaje de una sesión abierta por una persona queda viejo y contradice al trabajo de ahora
    if (d.sid != null && personSessions.has(String(d.sid))) delete a.encargo;
    if (isTest) a.comoTrabaja = 'Sesión de prueba';
    else if (d.sid != null && otherProjects.has(String(d.sid))) { a.comoTrabaja = 'Otro proyecto'; a.otroProyecto = true; }
    if (f && (QUIET_STATES.has(a.estado) || a.estado === 'parada')) novelty(a, f, x.activityAt, lastWrite);
    sidOf.set(a, d.sid);
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
  for (const [sid, f] of files) {
    if (used.has(sid)) continue;
    const stale = sessionState.isStale(f, { now: nowMs, ...(isAlive ? { isAlive } : {}) });
    const at = Date.parse(f.updatedAt);
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
    const espera = h.awaits === 'plan' ? 'que apruebes el plan' : h.awaits === 'save' ? 'el ok para guardar' : null;
    if (espera || h.mark) {
      // la que espera tu firma dice de qué sesión es, para encontrarla; la marcada va a «Sin sesión», y ahí el id corto de una
      // sesión cerrada no le dice nada a nadie: su nombre, si lo tuvo
      const quien = espera ? h.name || '—' : !h.name || (h.sid != null && String(h.sid).startsWith(String(h.name))) ? '' : h.name;
      const it = { titulo, quien, estado: espera ? 'firma' : 'espera', estimadaIso: null, pronosticoIso: null, fin: null, ...(h.mark ? { marca: h.mark } : {}), ...(espera ? { espera } : {}) };
      items.push(it);
      halfwayCards.push({ columna: espera ? 'firma' : 'sinEmpezar', card: { titulo, quien, hora: '', ...(espera ? { espera } : {}), ...(h.mark ? { marca: h.mark } : {}) }, storyId: h.storyId });
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
      if (was) { was.changes = Math.max(was.changes, l.changes); was.ahead = Math.max(was.ahead, ahead); } else leftovers.set(l.folder, { ...l, ahead, work: titulo });
    }
  }
  for (const l of leftovers.values()) items.push({ ...leftoverCard(l), estado: 'riesgo', quien: '—', estimadaIso: null, pronosticoIso: null, fin: null });
  // «te toca» es sólo lo que pide una firma o una decisión del dueño: las firmas, lo que le preguntan y la lista del tablero,
  // que mantiene la coordinadora. Las notas no se leen: una frase no dice si es para ahora
  const teToca = [...signatureCards.filter((s) => !s.yaAvisada).map((s) => s.linea), ...toldOwner, ...((board && board.teToca) || [])];
  const kanban = buildKanban({ agents, storyOfAgent, closedRuns, halfwayCards, items, signatures: signatureCards.filter((s) => !s.conTarjeta), board, prAnswers, openPrs, openPrsNote, nowMs });
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
  // la tabla dice lo mismo que las tarjetas, en llano
  const rows = agents.filter((a) => a.tipo).map((a) => ({ work: a.titulo || '', state: a.mientras ? `${a.haciendo} Mientras tanto: ${a.mientras}.` : a.haciendo, end: a.fin ? a.fin.hora + (a.fin.dif ? ` · ${a.fin.dif}` : '') : '', session: a.nombre, folder: a.carpeta || '' }));
  return { data: { agents, items, kanban, meta, rows, free: wip.free || [], unreadable: wip.unreadable || [] }, promises: kept };
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
const cardHour = (fin) => (fin ? fin.hora + (fin.dif ? ` · ${fin.dif}` : '') : '');
const firstWord = (t) => String(t || '').trim().split(/\s+/)[0].toLowerCase();
// ¿Dos títulos hablan del mismo trabajo? El de una ejecución y el que le puso la coordinadora en el tablero pueden no ser iguales
// («La revisión de la semana se configura desde el sitio: el tope…» y «La revisión semanal se configura desde el sitio»). Se
// comparan las palabras con contenido de lo que va antes de los dos puntos. La fila que nombra su `historia` no necesita esto.
const FILLER = new Set('a al algo cada como con cuando de del desde el en entre es la las lo los no o para por que se si sin su sus un una uno y'.split(' '));
const wordsOf = (t) => new Set(String(t || '').split(':')[0].normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && !FILLER.has(w)));
const SAME_WORK_SHARE = 0.6;
function sameWorkScore(a, b) {
  const x = wordsOf(a);
  const y = wordsOf(b);
  const least = Math.min(x.size, y.size);
  if (least < 2) return 0;
  const score = [...x].filter((w) => y.has(w)).length / least;
  return score >= SAME_WORK_SHARE ? score : 0;
}

/**
 * El panel de pendientes: cinco columnas siempre en el mismo orden. En curso, Tu firma y Esperan entrar salen del estado real (una tarjeta
 * por cada sesión con trabajo, lo que quedó de las sesiones cerradas y las firmas del registro) y el tablero de la
 * coordinadora suma lo que la máquina no sabe. Una fila de una historia con corrida no aporta estado: aporta su nota. Una
 * con pedido va adonde diga el pedido; si la consulta falló, queda donde dice el archivo. «En curso» es lo que tiene una
 * sesión viva: la fila que dice «curso» sin una sesión que la haga va a «Sin sesión», y la ejecución marcada de una sesión
 * cerrada es esa misma fila, si la hay, o una tarjeta en esa columna.
 */
function buildKanban({ agents, storyOfAgent, closedRuns, halfwayCards, items, signatures, board, prAnswers, openPrs = [], openPrsNote = null, nowMs = Date.now() }) {
  const cols = KANBAN_COLUMNS.map(([id, nombre]) => ({ id, nombre, tarjetas: [] }));
  const col = (id) => cols.find((c) => c.id === id);
  const byStory = new Map();
  const people = new Set();
  for (const a of agents) {
    const card = { titulo: a.titulo || a.haciendo, quien: a.nombre, hora: cardHour(a.fin), ...(a.fin && a.fin.cls ? { cls: a.fin.cls } : {}), ...(a.espera ? { espera: a.espera } : {}), ...(a.marca ? { marca: a.marca } : {}), ...(a.parada ? { motivo: a.parada } : {}) };
    let id = null;
    if (a.estado === 'firma') id = 'firma';
    // la marcada con la sesión viva va a «En curso», salvo que espere firma
    else if (a.tipo && a.estado === 'espera' && !a.marca) id = 'entrando';
    else if (a.tipo && a.estado !== 'inactiva' && a.estado !== 'libre') id = 'curso';
    // la coordinadora no es un pendiente, salvo que haya anotado un trabajo
    if (!id || (a.estado === 'coordina' && !a.titulo)) continue;
    if (a.tipo === 'stalled') card.marca = 'riesgo';
    if (a.otroProyecto) { card.quien = `${a.nombre} · Otro proyecto`; card.otro = true; }
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
  for (const s of signatures) col('firma').tarjetas.push({ titulo: s.titulo, quien: s.quien, hora: s.at == null ? '' : dayHhmm(s.at) });
  // las ejecuciones marcadas de sesiones cerradas se cruzan con el tablero al final: pueden ser una de sus filas
  const parked = [];
  for (const h of halfwayCards) {
    if (h.columna !== 'firma') { parked.push(h); continue; }
    col(h.columna).tarjetas.push(h.card);
    if (h.storyId) byStory.set(String(h.storyId), h.card);
  }
  const boardCards = [];
  for (const f of (board && board.filas) || []) {
    if (f.historia && byStory.has(f.historia)) {
      if (f.nota) byStory.get(f.historia).nota = f.nota;
      continue;
    }
    // la fila de una persona que ya tiene tarjeta del estado real no se duplica: «Ana» no es «Ananda»
    if (!f.pedido && f.quien && ['firma', 'curso', 'entrando'].includes(f.columna) && people.has(firstWord(f.quien))) continue;
    // la hora de una fila también puede haber pasado
    const late = Number.isFinite(f.finAt) && f.finAt < nowMs;
    const card = { titulo: f.titulo, quien: f.quien, hora: late ? OVERDUE : f.fin, ...(late ? { cls: 'late' } : {}), ...(f.nota ? { nota: f.nota } : {}), ...(f.marca ? { marca: f.marca } : {}), ...(f.grupo ? { grupo: f.grupo } : {}) };
    let id = f.columna;
    const pr = f.pedido ? (prAnswers.get(`${f.pedido.repo}#${f.pedido.numero}`) || {}).pr : null;
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
        const score = sameWorkScore(h.card.titulo, b.f.titulo);
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
    if (!p.waiting || onBoard.has(`${p.repoName}#${p.number}`.toLowerCase())) continue;
    col('entrando').tarjetas.push({ titulo: p.title, quien: `pedido ${p.mark}${p.number}`, hora: p.inQueue ? 'en la cola' : 'con auto-completar', ...(p.conflict ? { motivo: 'choca con main' } : {}) });
  }
  if (openPrsNote) col('entrando').nota = openPrsNote;
  // «Terminados» es lo de hoy, lo último primero; lo anterior, o lo que no dice cuándo, va a la tabla «Hechos» para que la
  // columna no crezca sin fin
  const today = new Date(nowMs).toDateString();
  const done = col('hechos').tarjetas;
  const isToday = (c) => Number.isFinite(c.terminadoMs) && new Date(c.terminadoMs).toDateString() === today;
  const anteriores = done.filter((c) => !isToday(c));
  col('hechos').tarjetas = done.filter(isToday).sort((p, q) => q.terminadoMs - p.terminadoMs);
  for (const c of done) delete c.terminadoMs;
  return { anteriores, columnas: cols, medioCamino: items.filter((i) => i.estado === 'riesgo' && i.accion).map((i) => ({ titulo: i.titulo, quien: i.quien, accion: i.accion })) };
}

// Las dos tablas: la clave de su tercera columna, sus títulos, y los de esa columna cuando la arma el arnés.
const TABLES = {
  hoy: { titulo: 'Hoy', third: 'hoy', columnas: ['Grupo', 'Qué tendremos', 'Hoy'], armadas: ['Grupo', 'Qué tendremos', 'Hora'] },
  pendientes: { titulo: 'Pendientes', third: 'cuando', columnas: ['Grupo', 'Qué queda', 'Cuándo'], armadas: ['Grupo', 'Qué queda', 'Cuándo'] },
};
// escrita hace más de esto, la tabla dice que está vieja
const TABLE_OLD_MS = 2 * 3600000;
// una tabla de una sesión cerrada se sigue mostrando un día, y después deja de decir algo
const TABLE_KEEP_MS = 24 * 3600000;

// Las filas de una tabla escrita: las que tienen qué decir, como `{ grupo, que, col }`. null si no es una lista.
function tableRows(raw, key) {
  if (!Array.isArray(raw)) return null;
  return raw.filter((r) => r && typeof r === 'object' && text(r.que)).map((r) => ({ grupo: text(r.grupo), que: text(r.que), col: text(r[TABLES[key].third]) }));
}

// La hora de una tabla: la suya, o la de todo el archivo.
const tableAt = (at, key) => { const v = at && typeof at === 'object' ? at[key] : at; const n = typeof v === 'string' ? Date.parse(v) : v; return Number.isFinite(n) ? n : null; };
const writtenText = (at, nowMs) => (Number.isFinite(at) ? `Escrita ${new Date(at).toDateString() === new Date(nowMs).toDateString() ? `a las ${hhmm(at)}` : `el ${dayHhmm(at)}`}${nowMs - at > TABLE_OLD_MS ? ' (vieja)' : ''}` : 'Escrita, sin hora');
// Las filas de un mismo grupo, juntas, en el orden en que aparece cada grupo: la página dice su nombre una sola vez.
const byGroup = (rows) => { const g = new Map(); for (const r of rows) { if (!g.has(r.grupo)) g.set(r.grupo, []); g.get(r.grupo).push(r); } return [...g.values()].flat(); };
const hourOrNone = (h) => (!h || h === 'sin hora estimada' ? 'sin hora' : h);

// Una fila de «Hoy» terminada: lo dice su estado y no dice que falte algo («En main; sin programar» no terminó).
const ROW_DONE = /^(?:instalad|en main|publicad|hech[oa]|aprobad\p{L}*; entr|entr[oó])/iu;
const ROW_PENDING = /falta|sigue|sin programar|se programa|pendiente|despu[eé]s/iu;
const rowDone = (r) => ROW_DONE.test(r.col) && !ROW_PENDING.test(r.col);
// El estado de una sesión abierta, para decirlo en una fila: lo mismo que su tarjeta.
const STATE_WORDS = { trabajando: 'trabajando', prueba: 'corriendo pruebas', parada: 'parada', espera: 'esperando entrar', firma: 'espera tu firma', pregunta: 'te pregunta', libre: 'libre', coordina: 'coordinando', inactiva: 'inactiva', esperando: 'esperando' };
function sessionNow(a, nowMs) {
  const hora = a.fin ? String(a.fin.hora) : '';
  if (hora.startsWith('espera ')) return hora;
  const word = STATE_WORDS[a.estado] || a.estado;
  // hoy no hace falta decir el día
  return /\d\d:\d\d$/.test(hora) ? `${word}; termina ${hora.replace(`${dayHhmm(nowMs).split(' ')[0]} `, '')}` : word;
}
// Palabras que empiezan una nota con dos puntos y no son el nombre de una sesión.
const NOT_A_SESSION = new Set(['Hoy', 'Mañana', 'Hecho', 'Instalado', 'Publicada', 'Nota', 'Tanda', 'Entró', 'Sin', 'Esta']);
const NOTE_SAYS_ACTIVE = /en curso|espera|\b\d{1,2}:\d{2}\b/iu;
const DAY_IN_NOTE = /\b(?:lun|mar|mi[eé]|jue|vie|s[aá]b|dom)\b/iu;

/**
 * Una fila escrita, contra lo real: la sesión que nombra dice lo que hace ahora; la que no está abierta no sigue «en curso»;
 * un pedido que terminó lo dice; una hora de hoy que pasó, sin sesión con quién cruzarla, está vencida. Una nota que no
 * pretende nada de eso queda como está.
 */
function crossRow(r, { agents, nowMs, writtenAt, prsEnded }) {
  const named = prsNamedIn(`${r.que} ${r.col}`).filter((n) => n.sign);
  const said = named.length ? waitedPrsSaid(named.map((n) => ({ numero: n.numero, state: prsEnded.get(`${n.sign}${n.numero}`) || null }))) : null;
  if (said) return { ...r, col: said.all ? said.text : `${r.col} · ${said.text}` };
  const first = /^(\p{Lu}[\p{L}-]+)(?=$|[\s:,;])/u.exec(r.col);
  const live = first && agents.find((a) => a.nombre === first[1]);
  if (live) return { ...r, col: `${live.nombre}: ${sessionNow(live, nowMs)}` };
  const note = /^(\p{Lu}[\p{L}-]+)[:,]\s*(.*)$/u.exec(r.col);
  if (note && !NOT_A_SESSION.has(note[1]) && NOTE_SAYS_ACTIVE.test(note[2])) return { ...r, col: `${note[1]} no está abierta; la nota decía: ${note[2]}` };
  const hours = [...r.col.matchAll(/\b(\d{1,2}):(\d{2})\b/g)].pop();
  if (hours && !DAY_IN_NOTE.test(r.col) && !ROW_DONE.test(r.col) && Number.isFinite(writtenAt) && new Date(writtenAt).toDateString() === new Date(nowMs).toDateString()) {
    const at = new Date(nowMs);
    at.setHours(Number(hours[1]), Number(hours[2]), 0, 0);
    if (at.getTime() < nowMs) return { ...r, col: `Vencida: ${hours[0]}` };
  }
  return r;
}
// La historia o el pedido de una fila, para no dibujarla dos veces.
const rowKeys = (r) => [...`${r.que}`.matchAll(/(?<![\d.])\d+\.\d{1,3}(?![\d.])|[#!]\d{3,}/g)].map((m) => m[0]);

// La tabla «Hechos»: lo terminado antes de hoy, y lo que salió de «Hoy» sin tarjeta en el kanban. Sus tres datos son qué, quién y
// cuándo: la página dibuja las tablas por posición, y acá la primera es el título.
function doneTable(kanban, removed) {
  const cards = [...((kanban.columnas.find((c) => c.id === 'hechos') || {}).tarjetas || []), ...(kanban.anteriores || [])];
  const known = (r) => cards.some((c) => sameWorkScore(r.que, c.titulo) > 0);
  const filas = [
    ...(kanban.anteriores || []).map((c) => ({ grupo: c.titulo, que: c.quien || '', col: c.hora || 'sin hora' })),
    ...removed.filter((r) => !known(r)).map((r) => ({ grupo: r.que, que: '', col: 'hoy' })),
  ];
  return { titulo: 'Hechos', columnas: ['Qué', 'Quién', 'Cuándo'], filas, escrito: 'Lo terminado antes de hoy, y lo de hoy que no está en el kanban', origen: 'arnes' };
}

/**
 * Las dos tablas, sin leer nada: la que escribió la coordinadora manda; sin ella, las de las sesiones (`sessionTables`:
 * `{ at, hoy, pendientes }`) juntas, sin repetir una fila; sin ninguna, las arma con el kanban ya calculado.
 */
function buildTables({ board = null, boardWrittenAt = null, sessionTables = [], kanban, nowMs, agents = [], prsEnded = new Map() }) {
  const cards = (id) => ((kanban.columnas.find((c) => c.id === id) || {}).tarjetas || []);
  // cómo cruzar una tabla con el kanban: una escrita agrupa por tema, y una armada lleva una fila por tarjeta
  const inKanban = (ids) => ids.map(([id, nombre]) => `${cards(id).length} ${nombre.toLowerCase()}`).join(' · ');
  const CROSS = { hoy: [['curso', 'En curso'], ['entrando', 'Esperan entrar'], ['hechos', 'Terminados']], pendientes: [['firma', 'Tu firma'], ['sinEmpezar', 'Sin sesión']] };
  const grouped = (key) => `Agrupa por tema: una fila puede juntar varios trabajos. En el kanban, de a uno: ${inKanban(CROSS[key])}.`;
  const fromCards = (ids) => ids.flatMap(([id, grupo]) => cards(id).map((t) => ({ grupo, que: t.titulo, col: hourOrNone(t.hora) })));
  const made = {
    hoy: fromCards([['curso', 'En curso'], ['entrando', 'Esperan entrar']]),
    pendientes: [...fromCards([['firma', 'Tu firma'], ['sinEmpezar', 'Sin sesión']]), ...(kanban.medioCamino || []).map((m) => ({ grupo: 'A medio camino', que: m.titulo, col: 'sin hora' }))],
  };
  const out = {};
  const removed = [];
  const seenWork = new Set();
  // lo escrito, contra lo real: lo terminado sale de «Hoy» y una historia o un pedido se dibuja una vez, en la primera tabla
  const crossed = (rows, key, writtenAt) => rows.filter((r) => {
    if (key === 'hoy' && rowDone(r)) { removed.push(r); return false; }
    const keys = rowKeys(r);
    if (keys.some((k) => seenWork.has(k))) return false;
    keys.forEach((k) => seenWork.add(k));
    return true;
  }).map((r) => crossRow(r, { agents, nowMs, writtenAt, prsEnded }));
  for (const [key, t] of Object.entries(TABLES)) {
    const own = board && board.tablas && board.tablas[key];
    if (own && own.length) {
      const at = orElse(tableAt(board.tablas.at, key), boardWrittenAt);
      out[key] = { titulo: t.titulo, columnas: t.columnas, filas: byGroup(crossed(own, key, at)), escrito: writtenText(at, nowMs), origen: 'coordinadora', cruce: grouped(key) };
      continue;
    }
    const written = sessionTables.filter((x) => x && Array.isArray(x[key]) && x[key].length).sort((a, b) => tableAt(a.at, key) - tableAt(b.at, key));
    if (written.length) {
      const seen = new Map();
      for (const x of written) for (const r of x[key]) seen.set(`${r.grupo}\u0000${r.que}`, r);
      const at = tableAt(written[written.length - 1].at, key);
      out[key] = { titulo: t.titulo, columnas: t.columnas, filas: byGroup(crossed([...seen.values()], key, at)), escrito: writtenText(at, nowMs), origen: 'sesiones', cruce: grouped(key) };
      continue;
    }
    out[key] = { titulo: t.titulo, columnas: t.armadas, filas: byGroup(made[key]), escrito: `Armada por el arnés a las ${hhmm(nowMs)}`, origen: 'arnes', cruce: 'Una fila por tarjeta del kanban.', contar: true };
  }
  out.hechos = doneTable(kanban, removed);
  return out;
}

// Lo que escribió cada sesión. Una tabla rota o vieja no tapa a las demás: la rota se dice.
function readSessionTables(sdir, nowMs, problems) {
  const dir = path.join(sdir, 'coordination', 'tablas');
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch (e) {
    if (e.code !== 'ENOENT') problems.push(`las tablas de las sesiones no se pudieron leer (${e.code || e.message})`);
    return [];
  }
  const out = [];
  for (const n of names) {
    try {
      const file = path.join(dir, n);
      const mtime = fs.statSync(file).mtimeMs;
      if (nowMs - mtime > TABLE_KEEP_MS) continue;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const row = { at: {} };
      for (const key of Object.keys(TABLES)) {
        const rows = raw[key] === undefined ? [] : tableRows(raw[key], key);
        if (!rows) problems.push(`la tabla ${n}: «${key}» no es una lista de filas`);
        row[key] = rows || [];
        row.at[key] = orElse(tableAt(raw.at, key), mtime);
      }
      out.push(row);
    } catch (e) { problems.push(`la tabla ${n} no se pudo leer (${e.message})`); }
  }
  return out;
}

// Escribe un archivo entero y después lo renombra: otro lector nunca lo ve a medias.
function writeWhole(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/**
 * `--write-tables`: la coordinadora las deja en su tablero, sin tocar lo demás; cualquier otra sesión, en su propio archivo.
 * Una tabla que no viene queda como estaba. Tira si lo pedido no tiene la forma.
 */
function writeTables(input, { sdir, sid, coordinatorSid, nowMs = Date.now() }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('va un objeto con «hoy» y «pendientes»');
  const keys = Object.keys(TABLES).filter((k) => input[k] !== undefined);
  if (!keys.length) throw new Error('va un objeto con «hoy» y «pendientes»');
  for (const k of keys) if (!tableRows(input[k], k)) throw new Error(`«${k}» no es una lista de filas`);
  const raw = (k) => input[k].filter((r) => r && typeof r === 'object' && text(r.que));
  const coord = coordinatorSid && sid === coordinatorSid;
  const file = coord ? path.join(sdir, 'coordination', 'tablero.json') : path.join(sdir, 'coordination', 'tablas', `${String(sid).replace(/[^\w.-]/g, '_')}.json`);
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error(`${path.basename(file)} no se pudo leer (${e.message})`); }
  if (coord) {
    const tablas = { ...(prev.tablas || {}), at: { ...(prev.tablas && typeof prev.tablas.at === 'object' ? prev.tablas.at : {}) } };
    for (const k of keys) { tablas[k] = raw(k); tablas.at[k] = new Date(nowMs).toISOString(); }
    writeWhole(file, `${JSON.stringify({ ...prev, tablas }, null, 2)}\n`);
  } else {
    const next = { ...prev, at: { ...(prev.at && typeof prev.at === 'object' ? prev.at : {}) } };
    for (const k of keys) { next[k] = raw(k); next.at[k] = new Date(nowMs).toISOString(); }
    writeWhole(file, `${JSON.stringify(next, null, 2)}\n`);
  }
  return file;
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
      estado, grupo: text(p.grupo), columna: Object.prototype.hasOwnProperty.call(BOARD_COLUMN, estado) ? BOARD_COLUMN[estado] : 'sinEmpezar', marca: estado === 'riesgo' ? 'riesgo' : null, historia, pedido,
    };
  });
  const rawTablas = raw.tablas && typeof raw.tablas === 'object' && !Array.isArray(raw.tablas) ? raw.tablas : {};
  for (const key of Object.keys(TABLES)) if (rawTablas[key] !== undefined && !tableRows(rawTablas[key], key)) avisos.push(`el tablero: la tabla «${key}» no es una lista de filas`);
  return {
    tablas: { hoy: tableRows(rawTablas.hoy, 'hoy') || [], pendientes: tableRows(rawTablas.pendientes, 'pendientes') || [], at: rawTablas.at },
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
// dueño. Son las mismas que el kanban cruza con el tablero; lo demás que quedó a medio camino no tiene tarjeta, y su fila manda.
const storiesWithCard = (wip) => new Set([
  ...(wip.extra || []).map((x) => x && x.storyId),
  ...(wip.halfwayItems || []).filter((h) => h && h.awaits).map((h) => h.storyId),
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
  if (!photo || !photo.lecturas || !Number.isFinite(at) || nowMs - at > OPEN_PRS_OLD_MS) return { prs: [], measured: false, note: 'Los pedidos no se midieron: no hay una lectura de los últimos 15 minutos.' };
  const prs = [];
  const unread = [];
  for (const [repo, r] of Object.entries(photo.lecturas)) {
    const repoName = repo.split('/').pop();
    if (!r || !r.ok || !Array.isArray(r.value)) { unread.push(repoName); continue; }
    for (const p of r.value) {
      if (!p || !Number.isInteger(p.number)) continue;
      const github = /^[^/]+\/[^/]+$/.test(repo);
      prs.push({ repoName, number: p.number, mark: github ? '#' : '!', branch: p.sourceBranch || null, title: plain(String(p.title || '').replace(PR_KIND_PREFIX, '')) || 'Un pedido sin título', inQueue: p.inQueue === true, conflict: p.mergeState === 'conflict' || p.mergeState === 'dirty', waiting: !p.draft && (p.inQueue === true || p.autoComplete === true) });
    }
  }
  const note = `Cuenta los pedidos de los repos del arnés en la cola o con auto-completar, leídos a las ${hhmm(at)}.${unread.length ? ` No se pudo leer ${unread.join(', ')}.` : ''}`;
  return { prs, measured: true, note, repos: Object.keys(photo.lecturas).map((repo) => repo.split('/').pop().toLowerCase()) };
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
 * «se cerró» no se dice de él: un pedido cerrado no trae fecha. Sin una lectura de pedidos no se pregunta nada.
 */
async function askWaitingPrs(wip, open, opts, known) {
  const out = new Map();
  if (!open.measured) return out;
  const plan = [];
  const asked = new Map();
  (wip.rows || []).forEach((row, i) => {
    const x = (wip.extra && wip.extra[i]) || {};
    const d = (wip.details && wip.details[i]) || {};
    const named = x.waitingFor && d.sid != null ? prsNamedIn(x.waitingFor) : [];
    if (!named.length) return;
    const q = x.cwd || x.runFolder ? remoteOfFolder(x.cwd || x.runFolder) : null;
    for (const n of named) {
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
      if (n.sign) return { numero: n.numero, state: a.state };
      return { numero: n.numero, state: a.state === 'merged' && Number.isFinite(since) && a.mergedAt > since ? 'merged' : null };
    });
    const said = waitedPrsSaid(results);
    if (said) out.set(sid, said);
  }
  return out;
}

/**
 * Los pedidos que nombran las tablas escritas y ya terminaron: `«#915» → estado`. Una fila no dice de qué repo es, así que un
 * pedido se pregunta sólo con su marca y si esa plataforma tiene un solo repo entre las carpetas de las sesiones.
 */
async function askTablePrs(board, sessionTables, wip, open, opts, known, remoteOf) {
  const out = new Map();
  if (!open.measured) return out;
  const remotes = new Map();
  for (const x of wip.extra || []) {
    const q = x && (x.cwd || x.runFolder) ? remoteOf(x.cwd || x.runFolder) : null;
    if (q && q.kind) { const key = q.kind === 'github' ? '#' : '!'; if (!remotes.has(key)) remotes.set(key, new Map()); remotes.get(key).set(q.name, q); }
  }
  const rows = [board && board.tablas, ...sessionTables].filter(Boolean).flatMap((t) => [...(t.hoy || []), ...(t.pendientes || [])]);
  const named = new Map();
  const asked = new Map();
  for (const r of rows) {
    for (const n of prsNamedIn(`${r.que} ${r.col}`)) {
      const of = n.sign && remotes.get(n.sign);
      if (!of || of.size !== 1 || open.prs.some((p) => p.number === n.numero && p.mark === n.sign)) continue;
      const q = [...of.values()][0];
      const key = `${q.name}#${n.numero}`;
      named.set(`${n.sign}${n.numero}`, key);
      if (!known.has(key) && !asked.has(key)) asked.set(key, { root: `pedido:${key}`, repo: q.name, numero: n.numero, identity: identityOf(q) });
    }
  }
  const list = [...asked.values()];
  if (list.length) {
    const replies = await (opts.queryPrs || readPrs)(list);
    list.forEach((q, i) => {
      const pr = replies[i] && replies[i].pr;
      if (pr && WAITED_ENDED.has(pr.state)) known.set(`${q.repo}#${q.numero}`, { state: pr.state, mergedAt: Date.parse(pr.mergedAt) });
    });
  }
  for (const [label, key] of named) if (known.has(key)) out.set(label, known.get(key).state);
  return out;
}

// De prueba es la sesión que lanzó otra sesión: ninguna de las de verdad desciende de otra. El árbol de procesos sólo se lee si
// hay un cuadro abierto; sin árbol (Windows) no se sabe, y la sesión cuenta como una más.
function testSessionsOf(sessions, states, readTree) {
  const out = new Set();
  const fileOf = new Map(states.map((f) => [String(f.session), f]));
  const asking = [...sessions].filter(([sid, s]) => s.alive && Number.isInteger(s.pid) && ASKS_OWNER.has(realState({}, { status: s.status }, fileOf.get(String(sid)) || null).estado));
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

// Las sesiones de un repo que el arnés no sigue, de los que lee la lista de pedidos. Si no se sabe de qué repo es, cuenta.
function otherProjectsOf(wip, open, remoteOf) {
  const out = new Set();
  if (!open.measured) return out;
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

// Lo que dice la tarjeta de los tokens de una sesión.
function tokensCard(t) {
  if (!t || t.noMedido) return { noMedido: true };
  const contexto = t.limite ? `${tokensTxt(t.contexto)} de ${tokensTxt(t.limite)} · ${Math.round((t.contexto / t.limite) * 100)} %` : `${tokensTxt(t.contexto)} · porcentaje no medido`;
  return { contexto, consumidos: `Read ${tokensTxt(t.lectura)} · Write ${tokensTxt(t.escritura)} · Cache Read ${tokensTxt(t.cache)}`, agentes: t.agentes };
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
const createEnvelopes = () => ({ offsets: new Map(), files: new Map(), recent: new Map(), coordinator: null, tokens: new Map(), prsEnded: new Map(), remotes: new Map() });

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

/** Los últimos mensajes de una persona que está en la oficina, a pedido; null si no está. Nada de esto se guarda. */
function conversationOf(env, name) {
  const e = env.files.get(name);
  if (!e) return null;
  const c = env.coordinator;
  return readConversation(e.file, { coordinator: c && c.name, isCoordinator: Boolean(c) && e.sid === c.sid, background: e.background });
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
  await askHalfwayPrs(wip, opts);
  const transcripts = opts.noTranscripts ? null : readTranscripts(wip, ss.states, { home, nowMs, projectsDir: opts.projectsDir, codexHome: opts.codexHome }, problems);
  const lastWrites = readLastWrites(wip, { home, projectsDir: opts.projectsDir });
  // los procesos se leen sólo si alguien está en un paso de pruebas
  const needsTree = (wip.extra || []).some((x) => x && x.kind === 'pipeline');
  const processes = opts.processes !== undefined ? opts.processes : needsTree ? require(path.join(ROOT, 'scripts', 'lib', 'owner-window.js')).leerArbol() : null;
  const open = readOpenPrs(sdir, nowMs);
  const waitingPrs = await askWaitingPrs(wip, open, opts, remembered.prsEnded);
  const sessionTables = readSessionTables(sdir, nowMs, problems);
  const remoteOf = (cwd) => {
    if (!remembered.remotes.has(cwd)) remembered.remotes.set(cwd, remoteOfFolder(cwd));
    return remembered.remotes.get(cwd);
  };
  const tablePrs = await askTablePrs(board.board, sessionTables, wip, open, opts, remembered.prsEnded, remoteOf);
  const testSessions = testSessionsOf(sessions, ss.states, () => (processes != null ? processes : opts.processes !== undefined ? opts.processes : require(path.join(ROOT, 'scripts', 'lib', 'owner-window.js')).leerArbol()));
  const personSessions = new Set([...sessions].filter(([, s]) => s.kind === 'interactive').map(([sid]) => String(sid)));
  const { data, promises } = buildOffice({ wip, signatures, coordinatorSid, coordinatorName, promises: saved.promises, nowMs, sessionFiles: ss.states, codexNames: cxNames, quietMin, board: board.board, prAnswers, transcripts, lastWrites, processes, openPrs: open.prs, openPrsNote: open.note, waitingPrs, testSessions, personSessions, otherProjects: otherProjectsOf(wip, open, remoteOf) });
  // sólo con la oficina abierta: la primera pasada lee conversaciones enteras, y la foto fija y `--json` empezarían de cero cada vez
  if (opts.envelopes && !opts.noTranscripts) data.tokens = readTokens(wip, ss.states, remembered.tokens, { home, nowMs, projectsDir: opts.projectsDir, codexHome: opts.codexHome, cxNames });
  // lo del tablero que no es una fila: su resumen, lo que dice que le toca al dueño y cuándo se escribió
  data.tablas = buildTables({ board: board.board, boardWrittenAt: board.writtenAt, sessionTables, kanban: data.kanban, nowMs, agents: data.agents, prsEnded: tablePrs });
  data.tablero = board.board ? { actualizado: board.board.actualizado, resumen: board.board.resumen, teToca: board.board.teToca } : null;
  if (opts.envelopes) {
    opts.envelopes.coordinator = coordinatorSid ? { sid: coordinatorSid, name: coordinatorName } : null;
    data.sobres = readEnvelopes(opts.envelopes, wip, { home, nowMs, projectsDir: opts.projectsDir, sessions });
  }
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

function writeTablesCli(fileName) {
  const sid = resolveSessionId();
  if (sid === '_nosession') { process.stderr.write('office.js: no sé qué sesión es: falta su identificador\n'); return 2; }
  const sdir = stateDir(os.homedir());
  const des = designacionVigente({ dir: sdir });
  try {
    const file = writeTables(JSON.parse(fs.readFileSync(fileName, 'utf8')), { sdir, sid, coordinatorSid: des && des.sesion ? des.sesion : null });
    process.stdout.write(`Tablas escritas en ${file}\n`);
    return 0;
  } catch (e) { process.stderr.write(`office.js: no escribí las tablas: ${e.message}\n`); return 2; }
}

async function main(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--open') opts.open = true;
    else if (a === '--write-tables') {
      const v = argv[++i];
      if (!v) { process.stderr.write('office.js: --write-tables pide un archivo JSON con «hoy» y «pendientes»\n'); return 2; }
      return writeTablesCli(v);
    } else if (a === '--out' || a === '--now') {
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
    const { waitingLine, linkedSite } = require('./office/site-link.js');
    const waiting = waitingLine(stateDir(os.homedir()));
    // sin sitio o con el enlace apagado, nadie la aprueba ni el estado cambia: la línea no diría nada cierto
    if (waiting && linkedSite(readSiteUrl())) process.stdout.write(`${waiting}\n`);
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

module.exports = { prsNamedIn, waitedPrsSaid, askWaitingPrs, tokensTxt, tokensCard, buildOffice, buildBoard, page, importMap, moduleSource, collect, createEnvelopes, conversationOf, waysOfWorking, openFile, openLive, deskSlots, readSiteUrl, readQuietMinutes, plain, plainWhole, runningTests, buildTables, writeTables, readTranscripts, readLastWrites, MODULES };
