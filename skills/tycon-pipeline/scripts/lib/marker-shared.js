/**
 * marker-shared.js — una parte de marker.js: el despachador la carga para sus subcomandos.
 *
 * Responsabilidad: el estado del marcador y lo que comparten los módulos de subcomandos.
 *
 * El código viene de marker.js tal cual, salvo tres reescrituras mecánicas: el estado que cambia mientras corre se lee de
 * `estado` (en marker-shared.js), la carpeta y la ruta de marker.js son `SCRIPTS_DIR` y `MARKER_JS`, y los `require`
 * locales van relativos a esta carpeta.
 */
const SCRIPTS_DIR = require('path').resolve(__dirname, '..');
const MARKER_JS = require('path').join(SCRIPTS_DIR, 'marker.js');
// el estado que cambia mientras corre: lo leen y lo cambian todos los módulos
const estado = {};
// Sin `?.` ni `??`: este guion lo tiene que poder leer un Node viejo hasta llegar a la guarda. Misma semántica: sólo null
// y undefined cuentan como «no hay» (0, '' y false se quedan).
const isNil = (v) => v === undefined || v === null;
const nn = (v, d) => (isNil(v) ? d : v);
const at = (o, k) => (isNil(o) ? undefined : o[k]);

const fs = require('fs');
const os = require('os');
const path = require('path');
// La carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: este
// archivo viaja suelto (al banco, a laboratorios de pruebas); ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const { resolveSessionId } = require('./session-id.js');
const { homeCommand, signatureCommand, pipelineRel } = require('./home-command.js');
// la tabla de los pasos: nombres, orden, equivalencia con el marcador viejo
const STEPS_LIB = require('./steps.js');
const { posixRelative } = require('./path-forms.js');   // rutas relativas al repo con `/`, también en Windows

const STATE_DIR = path.join(stateDirOf(os.homedir()));
const ACTIVE_DIR = path.join(STATE_DIR, 'active');
const LEGACY_MARKER_PATH = path.join(STATE_DIR, 'active.json');
const STALE_HOURS = 24;

// sessionId de ESTA invocación — Claude Code lo expone a todo subproceso Bash.
// En la terminal del dueño no hay variable de sesión: la firma por `--terminal` dice su sesión con `--for-session`.
// PROPIA es la sesión de quien corre el guion; SID, la sesión sobre la que trabaja: con una firma pedida para otra
// sesión (`--for-session <D>`), pasa a ser <D> al arrancar, sólo para leer hasta que la firma la fija (firmaDelDueno).
const PROPIA = resolveSessionId();
const PEDIDA = (() => { const i = process.argv.indexOf('--for-session'); return i >= 0 ? process.argv[i + 1] : null; })();
estado.SID = PROPIA === '_nosession' && process.argv.includes('--terminal') && PEDIDA && /^[\w-]+$/.test(PEDIDA) ? PEDIDA : PROPIA;
// sin firma todavía, el marcador de otra sesión no se escribe
estado.SOLO_LECTURA = false;
// El chequeo antes de la ventana de firma (owner-window.js): el guion comprueba lo que la firma exige y sale en la
// firma, sin escribir. Los renglones de los logs quedan sólo si se negó (la negativa es la que vale); si sigue, los
// escribe el comando de verdad.
const PREVIO = process.env.TYCON_SIGN_PRECHECK === '1';
const LOGS_DEL_CHEQUEO = [];
if (PREVIO) {
  process.on('exit', (codigo) => {
    if (codigo === 0) return;
    for (const [archivo, linea] of LOGS_DEL_CHEQUEO) { try { fs.appendFileSync(archivo, linea, 'utf8'); } catch (_e) { /* logging nunca rompe el comando */ } }
  });
}
estado.NECESITA_MARCADOR = false;

// Los subcomandos que firman para otra sesión: la firma del catálogo, si trabajan sobre la ejecución del destino
// (su marcador abierto) o, los de la ejecución perdida, qué argumento nombra la sesión (tiene que ser la del destino).
const PARA_OTRA_SESION = {
  // el plan con su nombre o con el número del marcador viejo, con la firma: la persona, o la coordinadora por delegación
  // con la revisión automática (sin firma no se escribe en la ejecución de otra sesión)
  'complete-step': { firma: 'plan-approval', marcador: true,
    si: (a) => (a[3] === 'approve-plan' || a[3] === '3') && ['--approved', '--mockup-approved', '--terminal'].some((f) => a.includes(f)),
    // el paso del plan sin ninguna de esas: la firma es ésa, sólo le falta la cita (lo dice paraOtraSesion)
    sinCita: (a) => a[3] === 'approve-plan' || a[3] === '3' },
  'approve-mockup': { firma: 'plan-approval', marcador: true },
  'waive-critical': { firma: 'critical-waiver', marcador: true },
  // eximir un comando de la comparación con main (historia 8.167): sobre la corrida abierta del destino
  'compare-waiver': { firma: 'compare-waiver', marcador: true },
  'mark-tested': { firma: 'manual-test', marcador: true },
  // un control declarado a mano y un criterio que no se prueba en vivo: los firma la persona, en la ventana o la terminal
  'set-check': { firma: 'escape:force-manual', marcador: true, si: (a) => a.includes('--force-manual') },
  'runtime-waiver': { firma: 'runtime-waiver', marcador: true },
  // cerrar como deuda, el rojo esperado de la matriz y apagar el modo autónomo: sobre la ejecución abierta del destino
  'close-as-debt': { firma: 'escape:cerrar-como-deuda', marcador: true },
  // el rojo esperado de la matriz; el de un control va con la firma de cerrar como deuda (reglaParaOtra)
  'expect-red': { firma: 'escape:rojo-esperado-de-la-matriz', marcador: true },
  'set-autonomous': { firma: 'escape:set-autonomous', marcador: true, si: (a) => !['true', '1', 'on'].includes(a[3]) },
  'clear-session': { firma: 'lost-run', nombra: 3, si: (a) => a.includes('--lost') && !a.includes('--partition') },
  // el ok de guardar: sobre la corrida abierta del destino, la que vio el dueño
  'approve-save': { firma: 'save', marcador: true },
  'restore': { firma: 'lost-run', nombra: 3 },
  // el arreglo rápido de otra pestaña: se escribe en adhoc/<destino>.json, no en un marcador
  'adhoc': { firma: 'adhoc-lane', si: (a) => a[3] === 'set' },
  // el pendiente que abrió otra sesión: la firma se escribe en su repo, que el freno comprueba que es de esa sesión
  'approve-pending': { firma: 'pending-approval' },
  // el freno que dejó una mirada fallida: se libera desde otra sesión, nunca desde la frenada
  'release-write-after': { firma: 'write-after-release' },
  // seguir en autónomo: la coordinadora lo pide para la sesión detenida y lo decide el click del dueño en su cuadro
  'resume-autonomy': { firma: 'autonomy-resume', marcador: true },
};

// cerrar la ejecución que la partición de su historia dejó sin objeto: la forma de rutina de la salida perdida
const PARTICION = { firma: 'lost-run:particion', nombra: 3, si: (a) => a.includes('--lost') && a.includes('--partition') };
// la regla del subcomando para firmar por otra sesión; `clear-session --lost --partition` tiene la suya
// dejar pasar un guardado ajeno y las firmas sobre un archivo: la coordinadora las pide para otra sesión (el catálogo dice
// cuáles, `otherSession`); trabajan sobre el carril o la constancia de esa sesión, no sobre un marcador
const reglaParaOtra = (argv) => {
  if (argv[2] === 'clear-session' && PARTICION.si(argv)) return PARTICION;
  if (argv[2] === 'adhoc' && argv[3] === 'allow-foreign-save') return { firma: 'adhoc-lane:guardado-ajeno' };
  // el freno de los datos, sólo para dejarlo pasar: descartar o pasar a historia tocan el carril de la sesión sin firma
  if (argv[2] === 'adhoc' && argv[3] === 'allow-data-change') return { firma: 'adhoc-lane:datos', si: (a) => a[a.indexOf('--recommends') + 1] === 'pasar' };
  if (argv[2] === 'sign-file') return { firma: `escape:${argv[3]}` };
  // el rojo esperado de un control: la firma de cerrar como deuda, con el mismo criterio que el freno
  if (argv[2] === 'expect-red' && ownerWindow().esRojoDeUnControl(argv[3])) return { firma: 'escape:cerrar-como-deuda', marcador: true };
  return PARA_OTRA_SESION[argv[2]];
};

function ownerWindow() { return require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'owner-window.js')); }

/** Con `--for-session` a otra sesión: el subcomando tiene que ser una firma que se corre así; si no, sale 2 sin escribir. */
function paraOtraSesion(argv) {
  // la revisión automática del plan y la respuesta a la pregunta de revisar no son firmas: entran por su camino
  // (cmdPlanReview, cmdReviewAnswer) y no escriben el marcador destino (sólo su constancia o su renglón). Sin
  // --for-session, la propia sesión prepara la revisión de su plan (aprueba una rutina con `review`; si no, sólo informa);
  // para otra sesión, la designada (lo mira el camino de cada una)
  if (argv[2] === 'plan-review' || argv[2] === 'review-answer' || argv[2] === 'review-ask' || argv[2] === 'owner-away') {
    if (PROPIA === '_nosession') {
      console.error(`🔒 marker.js ${argv[2]}: hace falta la sesión que lo pide (CLAUDE_CODE_SESSION_ID). No se escribió nada.`);
      process.exit(2);
    }
    if (PEDIDA && PEDIDA !== PROPIA && (argv[2] === 'review-ask' || argv[2] === 'owner-away')) {
      console.error(`🔒 marker.js ${argv[2]}: se corre desde la propia sesión, sin --for-session. No se escribió nada.`);
      process.exit(2);
    }
    if (PEDIDA && !/^[\w-]+$/.test(PEDIDA)) {
      console.error(`🔒 marker.js ${argv[2]}: la sesión ${PEDIDA} no se puede leer. No se escribió nada.`);
      process.exit(2);
    }
    estado.SOLO_LECTURA = true;
    return;
  }
  if (!PEDIDA || PEDIDA === PROPIA) return;
  // nombrar o retirar a la coordinadora: desde su propia pestaña, o la terminal del dueño que nombra esa sesión
  if ((argv[2] === 'designate-relay' || argv[2] === 'withdraw-relay') && !(PROPIA === '_nosession' && process.argv.includes('--terminal'))) {
    console.error(`🔒 marker.js ${argv[2]}: se corre desde la sesión que se nombra, no para otra (--for-session ${PEDIDA}). No se escribió nada.`);
    process.exit(1);
  }
  const no = (m) => { console.error(`🔒 marker.js: --for-session ${PEDIDA}: ${m}. No se escribió nada.`); process.exit(2); };
  // en la terminal del dueño --for-session dice su sesión; sin variable de sesión y sin terminal no hay quién la pida
  if (PROPIA === '_nosession') {
    if (!process.argv.includes('--terminal')) no('sin variable de sesión, la firma para una sesión se da en la terminal de la persona (--terminal)');
    // en la terminal, el marcador de la sesión nombrada se escribe sólo con la firma dada, y la salida de una ejecución
    // perdida nombra esa misma sesión
    const t = reglaParaOtra(argv);
    if (t && t.nombra && (!t.si || t.si(argv)) && String(argv[t.nombra] || '').replace(/[/\\]/g, '_') !== PEDIDA) no(`el comando nombra la sesión ${argv[t.nombra]}, y la firma es para ${PEDIDA}`);
    estado.SOLO_LECTURA = true;
    return;
  }
  if (!/^[\w-]+$/.test(PEDIDA)) no('la sesión no se puede leer');
  if (PEDIDA === '_nosession') no('«_nosession» es el nombre de «sin sesión», no una sesión: la firma se pide para la sesión destino por su id');
  if (argv[2] === 'clear') no(`clear cierra la ejecución de la propia sesión; la de otra sesión se cierra con marker.js clear-session ${PEDIDA} (y si quedó perdida, clear-session ${PEDIDA} --lost --for-session ${PEDIDA})`);
  const t = reglaParaOtra(argv);
  const s = t && require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'signatures.js')).SIGNATURES.find((x) => x.id === t.firma);
  // el plan sin --approved ni --terminal es la firma de otra sesión sin su cita: se dice qué falta y el comando, sin firmar
  if (t && t.si && !t.si(argv) && t.sinCita && t.sinCita(argv) && s && s.otherSession === 'yes') {
    const paso = `${argv[2]} ${argv[3]}`;
    no(`«${paso}» firma el plan de otra sesión y le falta la cita de la persona que lo aprobó. Con la cita, el freno arma el cuadro: node ${MARKER_JS} ${paso} --approved '<la cita de la persona>' --for-session ${PEDIDA}; o en la terminal de la persona: node ${MARKER_JS} ${paso} --terminal --for-session ${PEDIDA}`);
  }
  if (!t || (t.si && !t.si(argv)) || !s || s.otherSession !== 'yes') no(`«${argv.slice(2, 4).join(' ')}» no es una firma que se pida para otra sesión`);
  if (t.nombra && String(argv[t.nombra] || '').replace(/[/\\]/g, '_') !== PEDIDA) no(`el comando nombra la sesión ${argv[t.nombra]}, y la firma es para ${PEDIDA}`);
  estado.SID = PEDIDA;
  estado.SOLO_LECTURA = true;
  estado.NECESITA_MARCADOR = !!t.marcador;
  // antes de la firma, sólo se lee: sin la ejecución abierta del destino no hay nada que firmar (y el registro no se gasta)
  if (!estado.NECESITA_MARCADOR) return;
  let abierta;
  try { abierta = ownerWindow().marcadorEn(markerFilePath(PEDIDA)); } catch (e) { no(e.message); }
  if (!abierta) no(`la sesión ${PEDIDA} no tiene una ejecución abierta`);
}

function ensureActiveDir() {
  if (!fs.existsSync(ACTIVE_DIR)) {
    fs.mkdirSync(ACTIVE_DIR, { recursive: true });
  }
}

function nowIso() {
  return new Date().toISOString();
}

// Path del archivo de una sesión. Sanitiza separadores por las dudas.
function markerFilePath(sessionId) {
  const safe = String(sessionId || '_nosession').replace(/[/\\]/g, '_');
  return path.join(ACTIVE_DIR, `${safe}.json`);
}

// ¿la sesión tiene una firma más nueva que el corte? `{ viva }` o `{ error }` (scripts/lib/signature-log.js)
function firmadaDespuesDe(sesion, cutoff) {
  try {
    return require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'signature-log.js')).signedSince(sesion, STATE_DIR, cutoff);
  } catch (e) { return { error: `no pude mirar el registro de firmas (${(e && e.message) || e})` }; }
}

// Borra archivos de sesiones stale (>STALE_HOURS sin touch) — auto-recovery
// de pipelines huérfanos (sesión cerrada / Claude crasheó).
// Housekeeping: también purga advisor-runs/*.jsonl
// viejos (>7d, si no crecen sin límite) y *.tmp huérfanos (>1d)
// de writes atómicos interrumpidos.
function pruneStale() {
  if (!fs.existsSync(ACTIVE_DIR)) return;
  const cutoff = Date.now() - STALE_HOURS * 3600 * 1000;
  let files = [];
  try { files = fs.readdirSync(ACTIVE_DIR); } catch (_e) { return; }
  for (const f of files) {
    const full = path.join(ACTIVE_DIR, f);
    if (f.endsWith('.tmp')) {
      // tmp huérfano de un write atómico interrumpido — borrar si >1d.
      try {
        if (fs.statSync(full).mtimeMs < Date.now() - 24 * 3600 * 1000) fs.unlinkSync(full);
      } catch (_e) { /* ignore */ }
      continue;
    }
    if (!f.endsWith('.json')) continue;
    try {
      const m = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (m && m.lastTouch && new Date(m.lastTouch).getTime() < cutoff) {
        // una ejecución perdida no se poda: sale sólo por la salida del dueño
        if (perdidaSinFrenar(m.sessionId || f.replace(/\.json$/, ''), m.repoPath)) {
          process.stderr.write(`[marker] no podé el marcador de ${m.sessionId || f}: su ejecución está perdida y sale sólo por la salida que firma una persona (clear-session --lost o restore).\n`);
          continue;
        }
        // el cierre es de la sesión podada, no de la que poda
        const podada = m.sessionId || f.replace(/\.json$/, '');
        // una corrida dejada a propósito lleva días sin tocarse y no está abandonada: podarla pierde su trabajo. Tampoco la
        // que espera su turno con la espera anotada
        const io = require('./story-gate-io.js');
        if (marcaDe(podada, m) || esperaGuardar(m) || io.waitingTurn(STATE_DIR, podada)) continue;
        // ni la que el dueño firmó después del corte: la firma va a su registro y no toca el marcador
        const firma = firmadaDespuesDe(podada, cutoff);
        if (firma.error) process.stderr.write(`[marker] no podé el marcador de ${podada}: ${firma.error}; sin saber si la firmaron, no se poda.\n`);
        if (firma.error || firma.viva) continue;
        // sin su copia no se poda: `restore` la rearma desde ahí
        if (!io.savePruned(STATE_DIR, podada, m)) continue;
        fs.unlinkSync(full);
        avisarOficina(podada);
        cerrarEjecucion(podada, m, { registrar: false, estado: 'abandonada', motivo: `podada: más de ${STALE_HOURS} h sin tocarse`, soloAbierta: true });
      }
    } catch (_e) { /* ignore */ }
  }
  // advisor-runs/*.jsonl > 7 días — check-count solo mira la corrida actual.
  // 🔴 RESUMEN DURABLE ANTES DE BORRAR. Esta poda borra el ÚNICO registro no falsificable de que
  // los revisores corrieron: el voluntario (`gates.log`) sólo se escribe si alguien tipea el comando.
  // Sin un resumen, a los 7 días la pregunta "¿corrieron los revisores de la story X?" queda sin
  // respuesta mecánica para siempre, y el silencio se lee como incumplimiento. Cada archivo deja una
  // línea-resumen en `advisor-runs-summary.jsonl` (repos, stories, advisors y conteos) que no se
  // borra nunca: ~10 KB por semana, menos de 1 MB al año.
  // Si el resumen NO se pudo escribir, el archivo NO se borra — se junta hasta la próxima pasada.
  // Perder unos KB es reversible; borrar la constancia en silencio, no.
  const runsDir = path.join(STATE_DIR, 'advisor-runs');
  if (fs.existsSync(runsDir)) {
    const runCutoff = Date.now() - 7 * 24 * 3600 * 1000;
    let runFiles = [];
    try { runFiles = fs.readdirSync(runsDir); } catch (_e) { runFiles = []; }
    let ledger = null;
    try { ledger = require('./advisor-ledger.js'); } catch (_e) { ledger = null; }
    for (const f of runFiles) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const full = path.join(runsDir, f);
        if (fs.statSync(full).mtimeMs >= runCutoff) continue;
        if (ledger && !ledger.archive(full, f.replace(/\.jsonl$/, ''))) continue;
        fs.unlinkSync(full);
      } catch (_e) { /* ignore */ }
    }
  }
}

// Append-only logs en STATE_DIR — trazabilidad durable de gates y bypasses.
// gates.log: cada run-check/set-check (ts, name, status, cmd, exit, provenance).
// bypass.log: cada DOD_BYPASS / --no-verify detectado (rastro durable, no sólo stderr).
// `estricto`: el renglón es la constancia de algo que se acepta (la deuda de evidencia en vivo): si no se escribe, tira.
function appendLog(fileName, obj, { estricto = false } = {}) {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    // Namespace por repo: los logs son globales por máquina y
    // los ids cortos de story se repiten entre repos (una "S1" en cada uno) —
    // agrupar por storyId solo mezclaría proyectos en las métricas del retrospective-capturer.
    // Va ANTES de ...obj para que un `repoPath`/`repoRoot` explícito del caller gane.
    let repoPath = null;
    // La ruta de la story también: con un número que se repite en el repo, la constancia de revisores
    // de `gates.log` sólo cuenta para la story cuya ruta trae (on-pre-commit.js §findAdvisorsEvidence).
    let storyPath = null;
    try { const mk = readMarker() || {}; repoPath = mk.repoPath || null; storyPath = mk.storyPath || null; } catch (_e) { repoPath = null; }
    // Sin marker (gate corrido a mano, fuera del pipeline) la línea quedaría sin repo, y las métricas
    // por proyecto no se podrían armar. La raíz de git del
    // directorio actual lo contesta sin adivinar. Es un campo más en el log: no cambia ni un
    // bloqueo ni un veredicto.
    if (!repoPath) {
      try { repoPath = require('./repo-attrib.js').gitRoot(process.cwd()); } catch (_e) { /* sin git */ }
    }
    const linea = JSON.stringify({ ts: nowIso(), sessionId: estado.SID, repoPath, ...(storyPath ? { storyPath } : {}), ...obj }) + '\n';
    if (PREVIO) { LOGS_DEL_CHEQUEO.push([path.join(STATE_DIR, fileName), linea]); return; }
    fs.appendFileSync(path.join(STATE_DIR, fileName), linea, 'utf8');
  } catch (e) {
    // logging nunca rompe el comando, salvo la constancia de lo que se acepta; pero se dice: un renglón perdido sin
    // aviso es un control que no ve lo que pasó
    if (estricto) throw e;
    try { process.stderr.write(`⚠ marker.js: no pude escribir el renglón en ${fileName} (${(e && (e.code || e.message)) || e}): queda sin registrar.\n`); } catch (_e) { /* sin salida */ }
  }
}

// Las rutas de la corrida, absolutas contra su repo y nunca contra la carpeta del proceso (lib/run-dir.js): las usan la
// lectura y la escritura del marcador, así cualquier comando lo ve igual desde cualquier carpeta.
const conRutas = (m) => require('./run-dir.js').marcadorConRutas(m);

// El marcador de esta sesión tal como está, aunque no nombre historia: una detención del modo autónomo también puede ser
// de un marcador sin `storyId` (lib/autonomy-decision.js). null si no hay; uno que no se puede leer lanza.
function readOwnMarkerRaw() {
  const own = markerFilePath(estado.SID);
  if (!fs.existsSync(own)) return null;
  return conRutas(JSON.parse(fs.readFileSync(own, 'utf8')));
}

// Marker de ESTA sesión. Primero el archivo per-session; si no, fallback al
// legacy single-file (transición — readonly).
function readMarker() {
  const own = markerFilePath(estado.SID);
  if (fs.existsSync(own)) {
    try {
      const m = JSON.parse(fs.readFileSync(own, 'utf8'));
      if (m && m.storyId) return conRutas(m);
    } catch (_e) { /* ignore */ }
  }
  if (fs.existsSync(LEGACY_MARKER_PATH)) {
    try {
      const raw = fs.readFileSync(LEGACY_MARKER_PATH, 'utf8').trim();
      if (raw && raw !== '{}') {
        const obj = JSON.parse(raw);
        if (obj && obj.storyId) {
          // legacy plano: pertenece a la sesión sintética `_legacy`.
          return estado.SID === '_legacy' ? conRutas(obj) : null;
        }
        const m = obj && obj[estado.SID];
        if (m && m.storyId) return conRutas(m);
      }
    } catch (_e) { /* ignore */ }
  }
  return null;
}

function sinFirmaNoSeEscribe() {
  // en el chequeo antes de la ventana no se escribe: si llegó a escribir sin pasar por la firma, no dice que sí
  if (PREVIO) process.exit(0);
  if (!estado.SOLO_LECTURA) return;
  console.error(`🔒 marker.js: el marcador de la sesión ${estado.SID} se escribe sólo después de la firma. No se escribió nada.`);
  process.exit(2);
}

// Cambió lo que la oficina muestra de una sesión (un marcador, un arreglo rápido o una nota). El aviso no espera ni cambia
// el resultado: este archivo viaja suelto, y sin el aviso se pierde en silencio.
function avisarOficina(sesion = estado.SID) {
  try { require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'office-event.js')).notify(sesion); } catch (_e) { /* la vigilancia de la oficina lo ve después */ }
}

// Las sesiones que pasaron por la corrida, con su nombre (`marker.sesiones`, scripts/lib/session-name.js): la entrada de
// la sesión que corre el comando se pone al día en los cinco comandos que marcan el arranque, cada paso, cada pase de
// sesión y el cierre. El nombre se lee una vez por comando. Leerlo nunca frena ni cambia la salida: si no se puede, la
// entrada queda sin nombre (o, sin la librería, la lista queda como estaba) y sale una línea con el código.
const COMANDOS_CON_NOMBRE = new Set(['set', 'complete-step', 'adopt-session', 'restore', 'clear']);
let nombreDelComando;
function conSesionNombrada(marker) {
  if (PREVIO || estado.SOLO_LECTURA || estado.SID !== PROPIA || estado.SID === '_nosession' || !COMANDOS_CON_NOMBRE.has(process.argv[2])) return marker;
  if (!marker || typeof marker !== 'object' || !marker.storyId) return marker;
  if (nombreDelComando === undefined) {
    try {
      const lib = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'session-name.js'));
      nombreDelComando = { lib, leido: lib.nombreDeSesion({ sid: estado.SID, home: os.homedir() }), visto: nowIso() };
      if (nombreDelComando.leido.problema) process.stderr.write(`[marker] no pude leer el nombre de la sesión (${nombreDelComando.leido.problema})\n`);
    } catch (_e) {
      nombreDelComando = null;
      process.stderr.write('[marker] no pude leer el nombre de la sesión (sin-libreria)\n');
    }
  }
  if (!nombreDelComando) return marker;
  try {
    const { lib, leido, visto } = nombreDelComando;
    marker.sesiones = lib.conSesion(marker.sesiones, { id: estado.SID, nombre: leido.nombre, cortado: leido.cortado, visto });
  } catch (_e) { /* la lista queda como estaba: el marcador se escribe igual */ }
  return marker;
}

function writeMarker(marker) {
  sinFirmaNoSeEscribe();
  conSesionNombrada(marker);
  ensureActiveDir();
  pruneStale();
  const p = markerFilePath(estado.SID);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(require('./run-dir.js').marcadorConRutas(marker, { avisar: true }), null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
  avisarOficina();
}

// El archivo de estado de la sesión que el comando cambió: su paso, su oración y su hora de fin, de lo que dice el
// disco. Sólo si ya existe: lo crea el gancho de la sesión. Nunca cambia la salida del comando.
function syncSessionState(sid) {
  if (PREVIO || estado.SOLO_LECTURA) return;
  let lib = null;
  try {
    lib = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'session-state.js'));
    lib.refresh(STATE_DIR, String(sid));
  } catch (e) {
    // sin la librería, la oficina deduce como antes; el motivo queda en el registro del estado de las sesiones
    const text = `sesión ${sid}: marker.js no pudo poner al día su estado (${e && e.message ? e.message : e})`;
    try {
      if (lib) lib.logError(STATE_DIR, text);
      else fs.appendFileSync(path.join(STATE_DIR, 'office', 'session-state-errors.log'), `${new Date().toISOString()} ${text.replace(/\s+/g, ' ').slice(0, 500)}\n`);
    } catch (_e) { /* sin registro tampoco: el comando no cambia su salida */ }
  }
}

// El cierre de la ejecución de `sesion` en el registro, con su carpeta, y la copia de la apertura borrada
// (lib/open-runs.js). Todo camino que borra un marcador pasa por acá: sin el cierre, la sesión quedaría con su apertura
// sin marcador y frenaría como perdida. Que falle no frena el comando: se dice.
function cerrarEjecucion(sesion, marcador, { extra, registrar: _registrar, ...campos } = {}) {
  // el embudo de todo lo que cierra un marcador (clear, restore, la adopción): con la carpeta absoluta contra su repo, el
  // cierre encuentra la copia de la apertura desde cualquier carpeta
  const m = conRutas(marcador);
  try {
    require('./open-runs.js').cerrar({
      sid: estado.SID, sesion, runDir: (m && m.runDir) || null, story: m && m.storyId != null ? String(m.storyId) : null,
      extra: { repoPath: (m && m.repoPath) || null, ...(m && m.storyPath ? { storyPath: m.storyPath } : {}), ...(extra || {}) }, ...campos,
    });
    return true;
  } catch (e) {
    process.stderr.write(`[marker] no pude anotar el cierre de la ejecución de la sesión ${sesion} (${e.message})\n`);
    return false;
  }
}

// Un marcador que existe y no es el de una corrida (no se lee, o no dice de qué story es): ningún cierre lo borra ni lo
// pisa, ni con `--discard` ni desde otra sesión, porque no se puede anotar lo que deja sin guardar. Sale 2; mientras esté,
// el freno de guardar frena esa sesión, y lo saca una persona.
function frenarSiIlegible(archivo, sesion, comando) {
  let crudo;
  try { crudo = fs.readFileSync(archivo, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return; crudo = null; }
  let m = null;
  try { m = crudo === null ? null : JSON.parse(crudo); } catch (_e) { m = null; }
  if (m && typeof m === 'object' && !Array.isArray(m) && m.storyId) return;
  console.error(`🔒 marker.js ${comando}: el marcador de la sesión ${sesion} no se puede leer o no dice de qué story es: no sé qué deja sin guardar ni lo puedo anotar, así que no lo borro ni lo piso.`);
  console.error(`  Mientras esté, el commit, el push y los pedidos de esa sesión frenan. Lo saca una persona, después de mirarlo: ${archivo}`);
  process.exit(2);
}

// Una ejecución perdida sale sólo por `clear-session <sesión> --lost` o `restore <sesión>`, con la frase del dueño:
// clear, clear-session, adopt-session, set y las podas no la sacan. No poder preguntar tampoco es estar sana.
function frenarSiPerdida(sesion, comando, cwd) {
  let p;
  try { p = require('./open-runs.js').perdida({ sid: String(sesion), cwd: cwd || process.cwd() }); } catch (e) {
    p = { caso: 'ilegible', falta: `no pude revisar las piezas de la ejecución (${e.message})` };
  }
  if (!p) return;
  console.error(`marker.js ${comando}: la ejecución de la sesión ${sesion} está perdida (${p.caso}: ${p.falta}).`);
  // las dos formas, con la ruta estable: las mismas que el cartel de los frenos (lib/open-runs.js formasDeSalida)
  console.error('  Sale sólo con una de estas salidas, que firma una persona:');
  for (const l of require('./open-runs.js').formasDeSalida({ ...p, sesion: String(sesion) }).renglones) console.error(`  ${l}`);
  process.exit(3);
}

function perdidaSinFrenar(sesion, cwd) {
  try { return !!require('./open-runs.js').perdida({ sid: String(sesion), cwd: cwd || process.cwd() }); } catch { return true; }
}

// Snapshot de los archivos al cierre de la iteración, para el smart re-loop.
// Llamado por el orquestador justo después de invocar el set de advisors de iter N
// (típicamente al final del paso de revisores, en cada vuelta). Idempotente: re-llamar para iter N
// re-toma el snapshot (overwrites). pipeline.js smart-reloop --iter N+1 lo lee
// para computar el delta.
//
// 🔴 NO ES IDEMPOTENTE A CIEGAS — ver `lib/late-snapshot.js` para el caso completo.
// La foto se toma SOLA en el spawn del último revisor. Una segunda llamada «al cierre del step» la
// PISARÍA sin mirar: el arreglo quedaría ADENTRO de la foto, el delta siguiente saldría vacío, y los
// revisores de seguridad y de fallos silenciosos se saltearían «por superficie no tocada».
// Por eso, antes de escribir, se pregunta si hay CÓDIGO con hora posterior al último lanzamiento de
// revisores, y la tabla de decisión de abajo manda. Kill-switch: TYCON_SNAPSHOT_GUARD=0 (y queda la
// segunda capa, el corte de `computeSmartReloop`).
/**
 * La última vuelta congelada de esta sesión (lib/frozen-tree.js), con cada copia comprobada contra su sello: si una no
 * coincide, el comando frena con el repo y el sello. null si no hay vuelta congelada (una corrida de antes de la 8.161).
 */
function vueltaCongeladaComprobada(tipo, quien) {
  const ft = require('./frozen-tree.js');
  const v = ft.ultimaVuelta(STATE_DIR, estado.SID, tipo);
  if (!v) return null;
  for (const r of v.repos || []) {
    const c = ft.verify(r.repo, r.copy, r.tree);
    if (!c.ok) {
      appendLog('gates.log', { name: 'frozen-copy', status: 'blocked', quien, repo: r.repo, tree: r.tree });
      console.error(`marker.js ${quien} BLOQUEADO — ${c.error}.`);
      console.error('  La copia que leyeron los revisores cambió después de armarla: relanzá la vuelta, que arma otra copia desde su sello.');
      process.exit(2);
    }
  }
  return v;
}

/**
 * Lo que se guarda, ¿es lo revisado? (historia 8.161, decisión 3). Sella cada repo de la última vuelta de revisores
 * (nunca la del pase) y compara con su sello: los archivos distintos, sin el papeleo, frenan con el comando de la
 * vuelta (`reviewed-tree-mismatch`). Lo sin commitear adentro de un submódulo o de un repo anidado, que el sello no ve
 * (anota de cada uno sólo su commit), también frena; uno que no se puede mirar, también. Una vuelta sin sello (de antes)
 * no se compara: se dice y queda en gates.log.
 */
function comprobarLoRevisado(marker, quien) {
  const v = vueltaCongeladaComprobada('revisores', quien);
  if (!v || !(v.repos || []).length) {
    appendLog('gates.log', { name: 'reviewed-tree', status: 'no-medido', story: marker.storyId || null, quien, motivo: 'la vuelta no tiene sello' });
    console.error(`ℹ️  ${quien}: la vuelta no tiene sello: no se pudo comparar lo que se guarda con lo revisado (no medido, no «igual»).`);
    return;
  }
  const storyAbs = resolveStoryPath(marker.storyPath, marker);
  // la misma comparación que usa el tope de vueltas para dejar pasar sola una vuelta sin código (lib/reviewed-diff.js)
  const cmp = require('./reviewed-diff.js').comparar({ marker, v, storyAbs, stateDir: STATE_DIR, cierre: STEPS_LIB.reviewersClose(marker) });
  if (cmp.error) {
    appendLog('gates.log', { name: 'reviewed-tree-mismatch', status: 'blocked', story: marker.storyId || null, quien, motivo: cmp.error });
    console.error(`marker.js ${quien} BLOQUEADO — ${cmp.error}`);
    process.exit(2);
  }
  const { distintos, adentro, papeleo, deMain, sinSepararMain, huellas, movidos, sinCodigo } = cmp;
  if (distintos.length) {
    appendLog('gates.log', { name: 'reviewed-tree-mismatch', status: 'blocked', story: marker.storyId || null, quien, vuelta: v.etiqueta, files: distintos.length });
    const iter = (parseInt(String(v.etiqueta || '').replace(/\D/g, ''), 10) || 1) + 1;
    console.error(`marker.js ${quien} BLOQUEADO — lo que se guarda no es lo revisado: cambió después de la última vuelta de revisores (${v.etiqueta}):`);
    for (const d of distintos) console.error(`   · ${d.f} (${path.basename(d.repo)})`);
    for (const s of sinSepararMain) console.error(`  No pude separar lo que trajo main (${s}): cuenta como cambio.`);
    if (adentro.length) console.error('  Lo de adentro de un submódulo o repo anidado no lo ve la vuelta: commitealo en su repo, o descartalo, y después corré otra vuelta.');
    // pasado el tope, la coordinadora no firma sola otra vuelta: lo cambiado vuelve a lo
    // revisado, va a una historia de arreglo, o el dueño firma la vuelta extra
    let tope = null;
    try { tope = require('./review-rounds.js').tope({ repo: marker.repoPath || undefined }).value; } catch (_e) { tope = null; }
    // las vueltas hechas: la etiqueta del sello o las fotos del marcador, la mayor (pedidas sin --iter caen en la misma etiqueta)
    let hechas = iter - 1;
    try { hechas = Math.max(hechas, require('./review-rounds.js').vueltas(marker)); } catch (_e) { /* la etiqueta */ }
    if (tope !== null && hechas >= tope) {
      console.error(`  Pasaste el tope de ${tope} ${tope === 1 ? 'vuelta' : 'vueltas'} de revisores. Lo que cambió después de la última tiene tres salidas:`);
      console.error('  (a) Volver a lo revisado: estos comandos lo guardan aparte (stash) y dejan el disco como lo vieron los revisores.');
      console.error('      Revisá la lista: un archivo de otra tarea también queda guardado, no se pierde.');
      const porRepo = new Map();
      for (const d of distintos) { if (!porRepo.has(d.repo)) porRepo.set(d.repo, []); porRepo.get(d.repo).push(d.f); }
      const { spawnSync } = require('child_process');
      for (const [repo, archivos] of porRepo) {
        const sello = ((v.repos || []).find((r) => r.repo === repo) || {}).tree;
        // lo que git no sigue (un archivo nuevo sin agregar) no lo vuelve `restore`: lo saca el stash
        const conocido = (f) => spawnSync('git', ['-C', repo, 'ls-files', '--error-unmatch', '--', f], { windowsHide: true }).status === 0
          || (!!sello && spawnSync('git', ['-C', repo, 'cat-file', '-e', `${sello}:${f}`], { windowsHide: true }).status === 0);
        const seguidos = archivos.filter(conocido);
        // comillas simples: dentro de ellas el shell no expande nada (un `$` o una comilla invertida en un nombre)
        const mensaje = `${marker.storyId || 'historia'}: lo cambiado después de la vuelta ${hechas}`;
        console.error(`     git -C ${citar(repo)} stash push --include-untracked -m ${citar(mensaje)} -- ${archivos.map(citar).join(' ')}`);
        // lo que se commiteó después de la vuelta no lo devuelve el stash: sale del sello
        if (seguidos.length && sello) console.error(`     git -C ${citar(repo)} restore --source=${sello} --staged --worktree -- ${seguidos.map(citar).join(' ')}`);
      }
      console.error('  (b) Llevarlo a una historia de arreglo (followup_of: esta historia): lo mismo que (a), y de lo guardado sale para esa historia.');
      console.error(`  (c) Una vuelta extra, que firma una persona (no la coordinadora ni como trámite): pipeline.js smart-reloop --story ${marker.storyPath || '<historia>'}`);
      console.error(`      --repo ${marker.repoPath || '<repo>'} --iter ${hechas + 1} --files "<el diff completo>" --extra-round; la aprueba una persona en la ventana de permiso.`);
      process.exit(2);
    }
    console.error(`  Corré otra vuelta: pipeline.js smart-reloop --story ${marker.storyPath || '<historia>'} --repo ${marker.repoPath || '<repo>'} --iter ${iter} --files "<el diff completo, como hoy>".`);
    console.error('  La vuelta re-revisa lo que cambió desde su foto; con el sello nuevo, este paso sigue.');
    process.exit(2);
  }
  appendLog('gates.log', { name: 'reviewed-tree', status: 'ok', story: marker.storyId || null, quien, vuelta: v.etiqueta, papeleo: papeleo.length, deMain: deMain.length,
    ...(movidos.length ? { comentarios_movidos: movidos.length } : {}), ...(sinCodigo.length ? { sin_codigo: sinCodigo.length } : {}) });
  console.error(`✓ ${quien}: lo que se guarda es lo revisado (${huellas.join(' · ')})${papeleo.length ? `; papeleo cambiado después, que no cuenta: ${papeleo.slice(0, 5).join(', ')}${papeleo.length > 5 ? '…' : ''}` : ''}${deMain.length ? `; lo que trajo main sin tocar la corrida: ${deMain.slice(0, 5).join(', ')}${deMain.length > 5 ? '…' : ''}` : ''}${movidos.length ? `; sólo se movieron comentarios: ${movidos.join(', ')}` : ''}${sinCodigo.length ? `; lo que no se ejecuta (pruebas, imágenes, la guía de la historia), que no pide otra vuelta: ${sinCodigo.slice(0, 5).join(', ')}${sinCodigo.length > 5 ? '…' : ''}` : ''}.`);
}

/** `{ sellos, copias }` por repo de una vuelta congelada. */
function sellosDe(v) {
  const sellos = {};
  const copias = {};
  for (const r of (v && v.repos) || []) { sellos[r.repo] = r.tree; copias[r.repo] = r.copy; }
  return { sellos, copias };
}

// ¿El pase adversarial quedó atendido? Vive en lib/adversarial-verdict.js: `next` lo usa también,
// y una segunda copia del criterio se separa sola.
const { veredictoPaseAdversarial, paseAtendido } = require('./adversarial-verdict.js');

function mensajeDelPaseAdversarial(v) {
  const cmdResultado = `${homeCommand(pipelineRel('scripts/marker.js'))} mark-adversarial-result <N confirmados> --type 5b --result <RUN_DIR>/step-05b-adversarial.json --run ${v.runId || '<runId>'} --model <modelo> --tests <k promovidas> [--own <p> --in "<rutas de prueba>"] [--deferred <d> --reason "<por qué>"]`;
  const cmdSalteo = `${homeCommand(pipelineRel('scripts/marker.js'))} mark-adversarial-skipped --files <archivos de código del diff>`;
  const e = (s) => console.error(s);
  if (v.motivo === 'registro-ilegible') {
    e(`marker.js complete-step prepare-commit BLOQUEADO — no pude leer el registro de pases adversariales: el campo \`${v.campo}\` del marker no es una lista.`);
    e('  «No lo pude leer» no es «está». Revisá el marker (marker.js get): ese campo lo escriben sólo los comandos del pase.');
    return;
  }
  if (v.motivo === 'lanzamiento-sin-fecha') {
    e(`marker.js complete-step prepare-commit BLOQUEADO — el lanzamiento del pase adversarial no tiene fecha legible (\`${v.campo}\` = ${JSON.stringify(v.launchedAt)}).`);
    e('  Sin esa fecha no se puede saber si el resultado anotado es de este lanzamiento. Lo escribe mark-adversarial-launched.');
    return;
  }
  if (v.motivo === 'no-atendido') {
    e('marker.js complete-step prepare-commit BLOQUEADO — el pase adversarial no está atendido: ni lanzado ni salteado por el portón.');
    e('  (la bandera deepReviewDone sola no cuenta: es la que se escribía suelta y dejaba el pase sin constancia)');
    e('  Si el pase corrió, anotá su resultado:');
    e(`    ${cmdResultado}`);
    e('  Si no corre, que lo decida el portón:');
    e(`    ${cmdSalteo}`);
    return;
  }
  const cuando = `${v.runId || 'sin runId'}, ${v.launchedAt}`;
  if (v.motivo === 'pase-no-medido') {
    // El pase corrió pero no revisó todo. Es un pase que falta, no uno «sin hallazgos».
    const { SALIDA_APROBADA } = require('./adversarial-verdict.js');
    const p = v.pase || {};
    e(`marker.js complete-step prepare-commit BLOQUEADO — el pase adversarial (${cuando}) quedó NO MEDIDO: ${p.motivo_no_medido || 'no revisó todo'}.`);
    if (p.resultado) e(`  El resultado, con el texto de cada hallazgo: ${p.resultado}`);
    e('  Un pase que no revisó todo es un pase que falta. Relanzalo y anotá el resultado nuevo:');
    e(`    ${homeCommand(pipelineRel('scripts/marker.js'))} mark-adversarial-launched <runId nuevo> 5b --relaunch`);
    e(`    ${homeCommand(pipelineRel('scripts/marker.js'))} mark-adversarial-result <N> --type 5b --result <RUN_DIR>/step-05b-adversarial.json …`);
    e(`  Si Codex no contesta y no hay herramienta Workflow: ${SALIDA_APROBADA}.`);
    e('  Abandonarlo lo firma una persona, no el agente: `mark-adversarial-skipped --files …` anota el pedido y da los comandos de `marker.js sign-adversarial-skip`.');
    return;
  }
  if (v.motivo === 'resultado-de-otro-lanzamiento') {
    e(`marker.js complete-step prepare-commit BLOQUEADO — el pase adversarial se relanzó (${cuando}) y el resultado anotado es del lanzamiento anterior.`);
  } else {
    e(`marker.js complete-step prepare-commit BLOQUEADO — el pase adversarial se lanzó (${cuando}) y su resultado no está anotado.`);
  }
  e('  Cada confirmado va a la suite (prueba promovida o prueba propia) o se difiere con motivo:');
  e(`    ${cmdResultado}`);
  e('  Abandonarlo lo firma una persona, no el agente: `mark-adversarial-skipped --files …` anota el pedido y da los comandos de `marker.js sign-adversarial-skip`.');
}

// Cada aprobación que el pipeline ya pide queda en `approvals.jsonl`, en la carpeta de la corrida, como
// manual (una persona con nombre) o automática (un agente o una regla). Si no se puede escribir, AVISA y no frena el
// paso: el registro no agrega interrupciones. Lo agarra el portón de CI en el merge, que exige la
// línea del plan en toda corrida que declara anotar aprobaciones.
const { PLAN_FILE } = require('./plan-display.js');

/**
 * El plan escrito del paso «Armar el plan», en la carpeta de la corrida: `{ file }`, o `{ error }` si la carpeta no se puede
 * calcular (ahí pedir que se escriba el plan mandaría a buscar un archivo que no va a aparecer).
 */
function planDeLaCorrida(marker) {
  try {
    const repo = marker.repoPath || process.cwd();
    const storyAbs = resolveStoryPath(marker.storyPath, marker) || undefined;
    // con la carpeta creada, como anotarAprobacion: si todavía no existe, el mensaje dice dónde va el plan
    const runDir = require('../pipeline.js').resolveRunDir(repo, String(marker.storyId), true, storyAbs, { marker });
    return runDir ? { file: path.join(runDir, PLAN_FILE) } : { error: 'la story no da una clave para su carpeta de corrida' };
  } catch (e) { return { error: e.message }; }
}

/**
 * La huella sha256 del plan escrito de la corrida, la misma que calcula la revisión del plan (`planDe`, que no crea la
 * carpeta): `{ sha }`, o `{ motivo }` si no hay plan escrito o no se puede leer.
 */
function huellaDelPlan(marker) {
  let plan;
  try { plan = require('./plan-review.js').planDe(marker); } catch (e) { return { motivo: String(e.message || e).split('\n')[0] }; }
  if (!plan || !plan.texto || !plan.texto.trim()) return { motivo: (plan && plan.error) || 'no hay plan escrito' };
  return { sha: require('crypto').createHash('sha256').update(plan.texto).digest('hex') };
}

/**
 * ¿El plan está en lo que el agente le escribió a la persona en esta sesión? La lectura de la conversación vive en
 * lib/person-ok.js. `{ legible: false, motivo }` cuando la
 * conversación no se encuentra o no se lee —otra herramienta, como Codex, o una sesión sin registro—: quien llama falla
 * cerrado.
 */
function planEnLaConversacion(planTxt, opts = {}) {
  return require('./person-ok.js').planEnLaConversacion(planTxt, opts);
}

/**
 * El bloque del plan para la persona, por la salida normal: lo que un guion manda sólo por la salida de errores el agente
 * no se lo pasa a la persona (medido), y lo que la persona ve son los mensajes del agente.
 */
function planParaLaPersona(planTxt) {
  console.log([
    'Mostrale esto a la persona, en un mensaje tuyo o en la pregunta que le hagas, antes de seguir (el plan entero, tal cual):',
    '',
    planTxt.trim(),
    '',
    'Si creés que ya se lo mostraste: no alcanza, el control no lo encontró en lo que ella ve. Escribilo de nuevo tal cual.',
  ].join('\n'));
}

/**
 * ¿La persona vio el plan? En lo que le escribió el agente, o porque se lo mostró el arnés en pantalla antes de este
 * comando (la constancia `plan-shown` de lib/plan-display.js: la misma sesión, la misma historia y el mismo plan).
 */
function planVisto(marker, planTxt, { porElCuadro = false } = {}) {
  const visto = planEnLaConversacion(planTxt);
  if (!visto.legible || visto.mostrado) return visto;
  // el cuadro de la firma muestra «Qué hace», cuántos archivos toca y de qué zonas, y dónde está el plan completo
  // (owner-approvals.js `cuadroDe`; las rutas van a su detalle): con esas dos secciones legibles, el click en el cuadro es
  // aprobar viéndolo: la cantidad y las zonas de los archivos alcanzan para decidir. Un «aprobado» escrito, la ventana o
  // la terminal no lo muestran. El plan entero se muestra si la persona lo pide
  if (porElCuadro) {
    let secciones = null;
    try { secciones = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'signature-sources.js')).seccionesDelPlan(planTxt); } catch (e) {
      appendLog('gates.log', { name: 'plan-approval', status: 'skipped', story: marker.storyId, motivo: 'no pude leer las secciones del plan para el cuadro', error: String(e.code || e.message).slice(0, 200) });
    }
    if (secciones && !secciones.error) return { ...visto, mostrado: true, porElCuadro: true };
  }
  const pd = require('./plan-display.js');
  return pd.mostradoPorElArnes({ stateDir: STATE_DIR, sessionId: estado.SID, storyId: marker.storyId, planTxt }) ? { ...visto, mostrado: true, porElArnes: true } : visto;
}

function anotarAprobacion(marker, entrada) {
  try {
    const approvals = require('./approvals.js');
    const repo = marker.repoPath || process.cwd();
    const storyAbs = resolveStoryPath(marker.storyPath, marker) || undefined;
    const runDir = require('../pipeline.js').resolveRunDir(repo, String(marker.storyId), true, storyAbs, { marker });
    if (!runDir) throw new Error('no pude calcular la carpeta de la corrida (clave de la story)');
    let commit = null;
    try {
      commit = require('child_process').execFileSync('git', ['-C', repo, 'rev-parse', '--short=12', 'HEAD'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch (_e) { /* repo sin commits: la línea va sin commit */ }
    const linea = approvals.anotar(runDir, { commit, ...entrada });
    appendLog('gates.log', { name: 'approval', status: 'ok', story: marker.storyId, que: linea.que, tipo: linea.tipo, quien: linea.quien });
    // El portón la busca en el repo de la story: viaja en el momento. Si no llega, el paso sigue y el cierre reintenta.
    let p = null;
    try { p = require('../pipeline.js').projectRunToStoryRepo(runDir, storyAbs); } catch (e) { p = { projected: false, reason: `no se pudo copiar: ${e.message || e}` }; }
    if (p && !p.projected && p.reason && p.reason !== 'mismo repo') {
      appendLog('gates.log', { name: 'approval-projection', status: 'failed', story: marker.storyId, que: linea.que, error: String(p.reason).slice(0, 200) });
      console.error(`⚠️  la aprobación «${linea.que}» quedó anotada en el repo del código y no llegó al repo de la story (${p.reason}). El paso sigue; el cierre del pipeline la vuelve a copiar y frena si sigue faltando.`);
    }
    return linea;
  } catch (e) {
    appendLog('gates.log', { name: 'approval', status: 'not-recorded', story: marker.storyId, que: entrada && entrada.que, error: String(e.message || e).slice(0, 200) });
    console.error(`⚠️  no pude anotar la aprobación «${entrada && entrada.que}» en approvals.jsonl (${e.message || e}). El paso sigue; el portón de CI la va a pedir en el merge.`);
    return null;
  }
}

/** El tipo y el quién de una aprobación, de las opciones `--approved-by`, `--delegated-by` y `--agent`. */
function quienDeLasOpciones(optVal, extra) {
  return require('./approvals.js').quienDesdeOpciones({
    approvedBy: optVal('--approved-by'), delegatedBy: optVal('--delegated-by'), agent: optVal('--agent'), ...(extra || {}),
  });
}

// Los controles que corren al cerrar cada paso. En un marcador nuevo, por nombre; en uno viejo, por su número de
// entonces. La tabla vive en lib/steps.js, que «Cómo trabaja» también lee para mostrar cada freno en su paso.
const CONTROLES_DEL_PASO = STEPS_LIB.closeControlsByStep();
// El orden del marcador viejo (cadena: 3 ← {1,2} · 4 ← {3} · 5 ← {4} · 8 ← {5}); el nuevo es STEPS_LIB.ORDER_REQUIRES.
const ORDER_REQUIRES_OLD = { 3: ['1', '2'], 4: ['3'], 5: ['4'], 8: ['5'] };

// Una firma del dueño (scripts/lib/owner-window.js): la aprobó en la ventana de permiso de la herramienta (el registro
// que escribió el freno, consumido acá) o la da en su terminal (`--terminal`). Sin eso sale 1 sin escribir nada (2 sin
// terminal). Con eso, el renglón `<firma>-signed` queda en gates.log antes de la constancia de siempre.
// `opciones`: lo que el guion comprueba con el pedido sin gastar (`antes`) y los campos más del renglón (`extra`).
function firmaDelDueno(firma, resumen, opciones = {}) {
  const ow = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'owner-window.js'));
  const r = ow.exigir({ firma, argv: process.argv.slice(1), resumen, propia: PROPIA, anotar: anotarFirma, ...opciones });
  if (r.codigo !== 0) {
    console.error(`🔒 marker.js: ${r.motivo}`);
    process.exit(r.codigo);
  }
  return trabajarSobreElDestino(ow, r);
}

// El control previo de lo que aprueba la revisión automática del plan sin persona (por la delegación o «hecho y avisado»):
// la revisión que lanzó la sesión que firma, aprobada, sobre este plan y esta historia (lib/plan-review.js antesDeAprobar).
// `{ via: 'revision', resumen, constancia }` para firmar, el `{ codigo, motivo }` de la revisión para no, y null con la
// ventana, la terminal o un click.
function antesDeLaRevision({ marker }) {
  return (via) => {
    if (via !== 'delegacion') return null;
    const r = require('./plan-review.js').antesDeAprobar({ estado: STATE_DIR, firmante: PROPIA, destino: estado.SID, marker });
    if (r.codigo) return r;
    const c = r.constancia;
    return { via: 'revision', resumen: `plan de ${marker.storyId}: revisión ${c.id} ${c.veredicto} (${c.modelo})`, constancia: c };
  };
}

// Con la firma, el guion trabaja sobre la sesión destino (la corrida que vio el dueño, su marcador abierto): lo fija
// owner-window.js, también para las bibliotecas y los procesos hijos. Sale 2 sin escribir si la corrida cambió.
function trabajarSobreElDestino(ow, r) {
  const f = ow.fijarDestino({ r, propia: PROPIA, necesitaMarcador: estado.NECESITA_MARCADOR, leerMarcador: (sid) => ow.marcadorEn(markerFilePath(sid)) });
  if (f.codigo !== 0) {
    console.error(`🔒 marker.js: ${f.motivo}. No se escribió nada.`);
    process.exit(f.codigo);
  }
  estado.SID = f.destino || estado.SID;
  estado.SOLO_LECTURA = false;
  return { ...r, constancia: f.constancia };
}

// La sesión que pidió la firma para otra, para las constancias: `{ por }`, o nada si es la propia.
const porDe = (firma) => (firma && firma.constancia && firma.constancia.por ? { por: firma.constancia.por } : {});

// ¿La firma la contestó una persona? Su click en el cuadro, su «aprobado» escrito, su terminal, o su «sí» en la ventana
// de permiso de la herramienta (owner-window.js: el freno pide la ventana sólo en una pestaña que pregunta, y su registro
// queda atado a este comando). La ventana no nombra a quién (approvals.js `deLaPersona`: el quién sale de las opciones),
// pero la contestó una persona; la delegación, la revisión, el trámite y «hecho y avisado», no.
const conPersona = (via) => via === 'ventana' || require('./approvals.js').deLaPersona(via, 'persona') !== null;

// El modo de una aprobación según la firma que la respaldó: `user` sólo si la contestó una persona, como el plan; si no,
// la vía misma (`automatica` para la firma de trámite, que owner-window.js devuelve como delegación).
function modoDeLaFirma(firma) {
  const via = firma && (firma.via || (firma.constancia && firma.constancia.via));
  if (!(firma && firma.automatica) && conPersona(via)) return 'user';
  return firma && firma.automatica ? 'automatica' : String(via || 'sin-persona');
}

// La cita de una opción (`--approved`, `--mockup-approved`): la palabra que sigue, salvo que sea otra opción. Sin esto
// `--mockup-approved --for-session <s>` dejaba «--for-session» como la cita de quien aprobó.
const citaDe = (v) => (typeof v === 'string' && v.trim() && !v.startsWith('--') ? v : null);

// Las vías con que una aprobación quedó sin persona: la delegación, la revisión automática, la firma de trámite y
// «hecho y avisado». La maqueta aprobada con el plan no guardaba su vía: es la del plan del mismo comando (la misma hora).
const SIN_PERSONA_EN_LA_CONSTANCIA = new Set(['delegacion', 'revision', 'automatica', 'avisado']);
function hechaSinPersona(ap, plan) {
  if (!ap) return false;
  if (SIN_PERSONA_EN_LA_CONSTANCIA.has(ap.mode)) return true;
  const via = ap.via || (plan && plan !== ap && plan.at && plan.at === ap.at ? plan.via : null);
  return SIN_PERSONA_EN_LA_CONSTANCIA.has(via);
}
// Lo que se guarda de la aprobación que reemplaza `--replace-delegated`.
const reemplazada = (ap) => ({ via: ap.via || null, mode: ap.mode || null, text: ap.text || null, at: ap.at || null, ...(ap.por ? { por: ap.por } : {}) });

// El control previo de `--replace-delegated`: firma sólo la persona, a ESTE pedido. owner-window.js pasa `delegacion`
// para todo lo que sale sin ella (la delegación, el trámite, «hecho y avisado»); su registro dice si fue el click o el
// «aprobado» (el del cuadro de este comando, con su sello), o el «sí» en la ventana de este comando (sin vía).
// En el chequeo previo del freno, sin registro y sin una vía sin persona, la persona todavía puede contestar: no se
// niega, y el freno ofrece la ventana y el cuadro (como `antesDelPlan`). Al correr de verdad siempre hay registro, y
// cuenta sólo su vía.
function soloLaPersona(via, registro) {
  if (!registro && via !== 'delegacion') return null;
  const v = registro ? (registro.via || 'ventana') : via;
  if (conPersona(v)) return null;
  return { codigo: 2, motivo: 'reemplazar una firma hecha por delegación pide el click, el «aprobado» o el «sí» en la ventana de una persona a este pedido, o su terminal: por la delegación o como trámite no se reemplaza' };
}

// ¿La aprobación `ap` es de una persona y sigue valiendo para la huella de ahora (`shaAhora`)? `campo` es dónde guarda
// la suya (`planSha` el plan, `sha256` la maqueta). Si las dos huellas están y difieren, lo aprobado cambió y la
// aprobación vieja ya no vale; sin alguna de las dos no se sabe si cambió, y cuenta como vigente.
function aprobadaPorPersona(ap, shaAhora, campo, plan) {
  if (!ap || ap.mode !== 'user' || hechaSinPersona(ap, plan)) return false;
  return !(ap[campo] && shaAhora && ap[campo] !== shaAhora);
}

// El control previo de una firma que reescribiría lo que ya aprobó una persona (`protegidos`: 'plan', 'maqueta'): sin
// persona (la delegación, la revisión, la firma de trámite o «hecho y avisado», que owner-window.js pasa como
// `delegacion`) no se escribe y sale 2; la persona sí puede volver a aprobar. `{ codigo, motivo }` o null.
function noPisaLaPersona(protegidos, via) {
  if (!protegidos.length || via !== 'delegacion') return null;
  const que = protegidos.includes('plan')
    ? `el plan${protegidos.includes('maqueta') ? ' (y su maqueta)' : ''} ya lo aprobó una persona; un trámite no lo pisa`
    : 'la maqueta ya la aprobó una persona; un trámite no la pisa';
  return { codigo: 2, motivo: `${que}. Para aprobarlo de nuevo, que lo apruebe la persona (su click o su «aprobado» a este pedido, o su terminal). No se escribió nada.` };
}

// Quién aprobó la maqueta, para approvals.jsonl (lo lee el portón de la CI): la persona con su click, su «aprobado» o su
// terminal, a nombre del usuario de la máquina; sin persona (la firma de trámite, la delegación, la revisión, «hecho y
// avisado»), quien firmó de verdad, como el plan. Un nombre escrito en el comando (--approved-by) cuenta sólo con la
// ventana, como siempre: nunca vuelve manual una firma que no tuvo persona.
function quienDeLaMaqueta(firma, optVal) {
  const persona = process.env.USER || process.env.LOGNAME || process.env.USERNAME || 'persona';
  const deLaPersona = require('./approvals.js').deLaPersona(firma && firma.via, persona);
  if (deLaPersona) return deLaPersona;
  if (firma && (firma.automatica || SIN_PERSONA_EN_LA_CONSTANCIA.has(firma.via))) {
    const q = firma.via === 'revision' && !firma.sesion ? { quien: 'revisión automática de la propia sesión' } : ownerWindow().quienFirmo(firma, persona);
    return { tipo: 'automatica', quien: q.quien, ...(q.delegacion ? { delegacion: q.delegacion } : {}) };
  }
  return quienDeLasOpciones(optVal);
}

// El renglón `<firma>-signed` en gates.log: estricto. Sin él, el ok de guardar por delegación no ve la exención firmada
// y la historia saldría limpia; si no se puede escribir, el comando falla a la vista y la firma no cuenta.
function anotarFirma(renglon) {
  try { appendLog('gates.log', renglon, { estricto: true }); } catch (e) {
    throw new Error(`no pude escribir el renglón de la firma ${renglon && renglon.name} en gates.log (${(e && (e.code || e.message)) || e}): la firma no quedó registrada; repetí el comando`);
  }
}
const idsDeEspera = (esperas) => [...new Set(esperas.map((w) => w.id).filter(Boolean))].join(', ') || 'sin id';

// La espera a main en el archivo `doing` de la sesión, que es lo que la oficina y /wip leen: `waitingFor`,
// `waitingSince` y `waitingKind: 'main'` (la clase de la espera), conservando el texto y la hora de la nota que hubiera.
// `id` nombra todos los registros que espera la corrida («main-1, main-2»).
const doingFileOf = (sid) => path.join(STATE_DIR, 'doing', `${String(sid).replace(/[/\\]/g, '_')}.json`);

/**
 * Escribe en el marcador `otraVuelta` (lib/steps.js `otraVueltaDe`): el cartel lo lee y no decide la vuelta por su
 * cuenta. Lo llaman cada cierre de paso y cada cambio que se anota; un marcador por número no lo lleva.
 *
 * Si el cálculo falla, el cierre sigue: el campo viejo se borra (el cartel vuelve a su regla de antes, y `next` y el
 * último paso deciden igual) y queda el rastro en hook-errors.log, como en on-edit.js.
 */
function anotarOtraVuelta(marker) {
  try {
    const v = STEPS_LIB.otraVueltaDe(marker);
    if (v === undefined) delete marker.otraVuelta;
    else marker.otraVuelta = v;
  } catch (e) {
    delete marker.otraVuelta;
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.appendFileSync(path.join(STATE_DIR, 'hook-errors.log'), `[${new Date().toISOString()}] marker otraVuelta: ${(e && e.stack) || e}\n\n`, 'utf8');
    } catch { /* el registro no corta el cierre */ }
  }
}

/**
 * La hora de ARRANQUE de un paso. Pura: devuelve el marker con el arranque anotado, o
 * `null` si no hay nada que anotar — el paso ya arrancó o ya está completo. Nunca mueve un arranque:
 * la primera consulta es la que marca, y las siguientes (el orquestador pregunta `next` varias veces)
 * no pueden correrlo hacia adelante y esconder el tiempo que ya pasó.
 */
// Los sub-pasos del marcador viejo (el reloj, el pedido en ADO, el pase adversarial y la prueba en vivo) se cierran con
// una BANDERA, no con complete-step: tienen arranque y no fin propio. Sin arranque, su trabajo (el pase adversarial
// dura ~30 min) caería como «tiempo
// entre pasos» en la cuenta.
// En un marcador nuevo arranca cualquier paso de la tabla, por su nombre.
const PASO_ARRANCABLE = /^(\d|0b|0c|5b|7c)$/;
const arrancable = (marker, k) => (STEPS_LIB.schemeOf(marker) === 2 ? !!STEPS_LIB.byId(k) : PASO_ARRANCABLE.test(k));
function anotarArranque(marker, n, ts) {
  const k = String(n);
  if (!marker || !arrancable(marker, k)) return null;
  const completos = (marker.stepsCompleted || []).map(String);
  if (completos.includes(k)) return null;
  const st = marker.stepTimings && typeof marker.stepTimings === 'object' ? marker.stepTimings : {};
  const previo = st[k] && typeof st[k] === 'object' ? st[k] : {};
  if (previo.startedAt || previo.completedAt) return null;
  return { ...marker, stepTimings: { ...st, [k]: { ...previo, startedAt: ts } } };
}

// `tests-suite`: una suite sola de suites.json, repetida con `test-gate.sh --suite` después de un rojo. Nunca vale como
// `tests` (la corrida completa), pero comparte su candado: las dos corren las mismas suites del repo.
const VALID_CHECKS = ['build', 'tests', 'tests-suite', 'advisors', 'dod', 'acmatrix'];

// DODRT-C5.1 — verifica que el evidencePath de una story de UI sea evidencia
// Playwright REAL: el archivo EXISTE (resuelto relativo a marker.repoPath si el path es relativo) y su
// CONTENIDO menciona playwright / tests/e2e / @story- / E2E-N. Espejo del check del hook
// on-pre-commit.js:578 — así el gate del marker (complete-step prepare-commit) y el gate del commit exigen lo mismo.
/**
 * Resuelve el `storyPath` del marker a una ruta USABLE.
 *
 * 🔴 `pipeline.js start` lo guarda RELATIVO al repo (`specs/<epic>/<story>.md`), así que cualquier
 * `fs.existsSync(marker.storyPath)` falla salvo que el proceso corra parado justo en la raíz del
 * repo. Eso rompería en silencio 3 sitios distintos: el gate de `complete-step prepare-commit`, el check de la
 * guía de QA, y el fallback de `runtime-waiver` (que además le echaría la culpa al usuario con un
 * "el marker no lo tiene"). `runtime-matrix.js` resuelve lo mismo con su propio `path.resolve`.
 *
 * Mismo criterio que `evidencePath` más abajo: relativo ⇒ contra `marker.repoPath` (absoluto por
 * construcción, `readMarker` lo defaultea a `process.cwd()`), nunca contra el cwd del proceso.
 * @returns {string|null} la ruta absoluta si el archivo existe; `null` si no
 */
function resolveStoryPath(raw, marker) {
  if (!raw) { return null; }
  let p = String(raw);
  if (!path.isAbsolute(p)) {
    const base = (marker && marker.repoPath) || process.cwd();
    p = path.join(base, p);
  }
  return fs.existsSync(p) ? p : null;
}

// ¿La corrida pide la prueba de navegador? La pantalla de las tandas que no están bloqueadas (`scope: 'active'`).
function markerStoryIsUi(marker) {
  return markerScreenRule(marker, { scope: 'active' });
}

function markerScreenRule(marker, opts) {
  try {
    const p = marker && marker.storyPath;
    if (!p || !fs.existsSync(p)) return false;
    const content = fs.readFileSync(p, 'utf8');
    const ui = require(path.join(__dirname, '..', 'lib', 'ui-signal.js'));
    const repo = (marker && marker.repoPath) || process.cwd();
    // la baja de una tanda bloqueada se cruza con lo que cambió la corrida desde su arranque; con tanda anotada, la
    // pantalla mira las mismas tandas que la matriz
    const changed = opts.scope === 'active' ? ui.changedFiles(repo, marker.baseSha) : undefined;
    const batches = opts.scope === 'active' ? tandasMedidasDe(marker) : null;
    // qué cuenta como pantalla lo dice la regla screen_test de la organización (ui de fábrica, react u off)
    return ui.applyScreenRule(content, repo, screenRule(), { ...opts, changed, batches }).ui;
  } catch (e) {
    // no deja la exigencia de pantalla apagada en silencio
    console.error(`⚠️  no pude decidir si la story toca pantalla (${e && e.message ? e.message : e}): se trata como sin pantalla`);
    return false;
  }
}

function screenRule() {
  try { return require(path.join(__dirname, '..', 'lib', 'stack-config.js')).orgRules().rules.screen_test.value; } catch (_e) { return 'ui'; }
}

// Las tandas que mide la corrida (la anotada más las que volvieron), con la matriz de «Preparar el pull request»; null sin
// tanda, sin lista o con el marcador de otra historia. Se calcula una vez por comando: la pantalla la pregunta varias.
const TANDAS_MEDIDAS = new Map();
function tandasMedidasDe(marker) {
  const storyPath = marker && resolveStoryPath(marker.storyPath, marker);
  if (!marker || !marker.batch || !storyPath) return null;
  if (TANDAS_MEDIDAS.has(storyPath)) return TANDAS_MEDIDAS.get(storyPath);
  let out = null;
  try {
    const rmx = require(path.join(__dirname, '..', 'runtime-matrix.js'));
    const op = rmx.opcionesDeTandaDelMarcador({ ...marker, storyPath }, storyPath);
    if (op.batch && Array.isArray(op.changed)) out = rmx.compute({ storyPath, ...op }).measuredBatches || null;
  } catch (_e) { out = null; }
  TANDAS_MEDIDAS.set(storyPath, out);
  return out;
}

// La baja de pantalla nunca es muda. Si la story dejó de contar como de pantalla porque la
// palabra del frente sólo está en la prosa o en documentos, se dice en UNA
// línea por stderr, sin bloquear. Se llama una sola vez por comando, al nivel del comando: NO dentro de
// markerStoryIsUi, que `complete-step prepare-commit` llama más de una vez.
function avisarBajaDePantalla(marker) {
  try {
    const p = marker && resolveStoryPath(marker.storyPath, marker);
    if (!p || !fs.existsSync(p)) return;
    const ui = require(path.join(__dirname, '..', 'lib', 'ui-signal.js'));
    const content = fs.readFileSync(p, 'utf8');
    const linea = ui.proseDropNotice(ui.uiSignalDetail(content, marker.repoPath || process.cwd()));
    if (linea) console.error(linea);
    // la pantalla de una tanda bloqueada no se pide en esta corrida, y se dice
    const repo = marker.repoPath || process.cwd();
    const tanda = ui.screenScope(content, repo, { changed: ui.changedFiles(repo, marker.baseSha), batches: tandasMedidasDe(marker) }).note;
    if (tanda) console.error(tanda);
    // con screen_test: off, el cierre dice que la prueba de pantalla no se exigió
    const regla = ui.applyScreenRule(content, marker.repoPath || process.cwd(), screenRule()).note;
    if (regla) console.error(regla);
  } catch (_e) { /* el aviso nunca rompe el comando */ }
}

/**
 * `tests-failed`: la lista de suites que fallaron en la última corrida completa de la puerta (`marker.testsFailed`, al
 * lado de `checks`: el freno de cierre de turno recorre `checks` y una lista no es un check). La usa test-gate.sh:
 * Cada entrada lleva el repo de su corrida (`--repo`): la lista es de la sesión, y una corrida en otro repo no reemplaza,
 * no saca ni pide las de éste.
 *   · `record --summary <resumen> --repo <repo>`: reemplaza las de ese repo con las fallas del resumen de
 *     run-suites-json.js (sin resumen legible, ninguna) y borra `checks['tests-suite']`, para que no quede en pie el rojo
 *     de una suite sola anterior;
 *   · `clear --path <ruta> --repo <repo> [--summary <resumen> --tree <árbol> [--coverage-file <lcov>]]`: saca esa ruta (la suite
 *     sola salió verde); con el resumen de la suite sola y la foto de su carpeta, la suma a lo guardado de la completa
 *     roja, con su cobertura; con `--result <tests-result.json> [--story-id <id>] [--sealed <copia>] [--inherited]`,
 *     saca su falla de la constancia de esa completa (lib/failed-first.js `rewriteResult`, con la `full_ts` de la lista);
 *     con `--full-suite-by <quién>` (la corrida está acotada: la completa la corre la CI del pedido) y sin lo guardado de la
 *     completa roja, si era la última roja y la constancia queda en verde, deja el check `tests` en verde;
 *   · `record` acepta `--full-ts <ts>`: la hora de la completa, que cada suite de la lista guarda;
 *   · `pending --suites <suites.json> --gate <test-gate.sh> --repo <repo> [--story <story>]`: saca las rutas que ya no
 *     están en suites.json (y lo dice); si queda alguna, nombra cada una con su comando y sale 76;
 *   · `save-red`, `red-full` y `drop-red`: lo guardado de la última completa roja del repo (`testsRedFull`, con su
 *     carpeta en `red-full/` y su hash), para que repetir solas las rojas cierre sin otra completa (lib/failed-first.js);
 *   · `save-green`, `green-full` y `drop-green`: lo mismo para la última completa verde (`testsGreenFull`, carpeta
 *     `green-full/`), para que la próxima corrida corra sólo lo que cambió desde ella. Las dos guardan
 *     `--story-id`; `save-green` recibe además `--after-inherited <resumen>`, el de después del juez de heredados, y las
 *     dos `--origin-at <ts>`, la hora de la completa de origen de un cierre. Si no pueden guardar salen 1 y lo de antes
 *     queda como estaba;
 *   · `run-end --mode <m> --reason <t> --exit <n> --saved verde|rojo|no [--saved-reason <t>] [--origin-at <ts>]
 *     [--suites <n>] [--duration-ms <n>]`: al final de cada corrida del portón de arriba que terminó en verde o en rojo,
 *     anota en el marcador la nota de esa corrida para su repo (`testsSavedNote`, una entrada por repo, con la historia)
 *     y agrega a gates.log el renglón `test-gate-run`. Sin corrida abierta, sólo el renglón.
 * `record`, `clear`, `save-*`, `drop-*` y `run-end` escriben lo que mide la puerta: sólo los llama test-gate.sh
 * (TYCON_TEST_GATE=1). Sin corrida abierta: sale 0, no escribe nada en el marcador y lo dice.
 */
const TESTS_FAILED_PENDING = 76;

/**
 * `mark-tests-not-measured`: la salida 3 de test-gate.sh es «sin medir» (no reconoce ninguna herramienta de pruebas en el
 * repo y no corrió nada). Pone `sin-medir` sobre cualquier estado anterior: un verde de otra corrida no puede quedar en
 * pie. No es verde ni un rojo para arreglar: complete-step run-tests y «Preparar el pull request» lo anuncian (nunca un verde callado). Sólo lo
 * llama test-gate.sh.
 */
/** La línea que dicen «Correr las pruebas» y «Preparar el pull request» cuando el check `tests` quedó «sin medir». */
function testsNotMeasuredLine(marker) {
  const r = String((marker && marker.testsNotMeasuredReason) || '');
  // el portón sabe correrlas, pero la herramienta no arrancó: el motivo es ése
  if (r.startsWith('la herramienta de pruebas')) return `pruebas no medidas: ${r.slice(0, 300)}`;
  const m = r.match(/no encontré (un proyecto de [^.]*?)(?:\. |$)/);
  return `pruebas no medidas: el portón no sabe correr las pruebas de este repo${m ? ` (no encontré ${m[1]})` : ''}`;
}

// Bytes crudos que se retienen de la salida para armar la cola. El tope publicado (700 caracteres
// saneados) es mucho menor; se retiene de más porque sanear achica y los colores ocupan.
const COLA_BYTES_RETENIDOS = 64 * 1024;

// «Ocupado, probá después» (EX_TEMPFAIL): no se confunde con un rojo ni con las salidas 3-7 de test-gate.sh.
const RUN_CHECK_BUSY = 75;
const SENALES_RUN_CHECK = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

// Flags booleanos de las partes del Arranque (el reloj / el pedido en ADO) — el resume y
// `pipeline.js next` los leen para no re-ejecutar (evita doble timer / doble
// transición de WI al retomar cross-session).
// `atddBypass`: escape consciente del portón pre-edit de ATDD (on-atdd-preedit.js) —
// para el refactor legítimo sobre red preexistente. Pide la firma del dueño para la ejecución (lib/atdd-skip.js); el
// uso queda en bypass.log, no es silencioso.
// `waitingForHuman` — EL TERCER ESTADO del portón de autonomía.
// El Stop-hook distingue dos cosas: "podés cerrar" (todo verde) y "no cierres, arreglá" (algo en
// rojo). Este flag cubre la tercera, que es la más común: "le pregunté al dev y estoy esperando". Y como
// preguntar ES terminar el turno, sin el flag el agente queda atrapado justo cuando necesita hablar — sobre
// todo con el único rojo que él NO puede poner en verde, la matriz esperando el waiver. La única salida
// sería el botón de pánico `STOP_AUTONOMY`, que es un archivo para TODA la máquina: frena
// también las corridas de al lado y les apaga el portón (una sesión lo pone y otra lo saca:
// las corridas de al lado quedan con el portón apagado sin saberlo).
// Este flag es de UN SOLO USO y lo CONSUME el Stop-hook: deja cerrar ese turno sin tocar
// `autonomous`, y se apaga solo. Mismo patrón que `ALLOW_DOD_EVIDENCE_WRITE`.
//
// 🔴 `deepReviewDone` NO se escribe a mano. Es la bandera que cierra el pase adversarial, y cualquiera que la escriba
// la cierra sin anotar qué encontró el pase, y «Preparar el pull request» la da por buena. La escriben sólo los dos
// comandos que cierran el pase con constancia: `mark-adversarial-result` (el pase corrió y se anota su
// resultado) y `mark-adversarial-skipped` (el portón decidió que no corre).
// Las banderas, en dos listas (lib/external-flags.js): las de hechos externos las pone sólo el arnés cuando hizo el
// trabajo; las de estado de la ejecución, el modelo, cada una con su motivo. `next` y el cartel también leen el nombre
// viejo de la bandera del reloj en un marker de una corrida en vuelo (no se reabre el aviso de trabajo).
const { VALID_FLAGS, EXTERNAL_FLAGS, HARNESS_COMMAND } = require('./external-flags.js');
// El nombre viejo de la bandera del reloj, de cuando el paso era el reloj de una herramienta.
const OLD_FLAGS = { clockiStarted: 'workSignalStarted' };

/** El valor de `--reason` en una lista de argumentos, sin espacios a los costados ('' si no está). */
function motivoDe(args) {
  const lista = Array.isArray(args) ? args : [];
  const i = lista.indexOf('--reason');
  return i >= 0 ? String(nn(lista[i + 1], '')).trim().slice(0, 300) : '';
}

// El valor de una opción `--<nombre> <valor>` de la línea, recortado; '' si falta.
function opcion(args, nombre) {
  const i = args.indexOf(`--${nombre}`);
  return i >= 0 ? String(nn(args[i + 1], '')).trim() : '';
}

// El tope de la fecha de vencimiento de un rojo esperado de la matriz, en días desde el cierre en deuda.
const TOPE_DE_LA_DEUDA_EN_VIVO = 14;

/** La fecha local `AAAA-MM-DD` de un momento: el vencimiento vale el día entero de la máquina. */
function fechaLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function sumarDias(fecha, dias) {
  const [a, m, d] = fecha.split('-').map(Number);
  return fechaLocal(new Date(a, m - 1, d + dias));
}
const esFecha = (t) => /^\d{4}-\d{2}-\d{2}$/.test(String(t || '')) && sumarDias(String(t), 0) === String(t);

/**
 * Dónde vive la historia en su repo, para el renglón de la deuda: `{ storyRel, repoCommon }` (la ruta dentro del repo y
 * su carpeta git común, la que comparten todas sus carpetas de trabajo). El aviso de la deuda vencida la busca ahí
 * cuando la carpeta de trabajo de la corrida ya se borró. Sin git, `{}`: el aviso dice que no pudo mirar.
 */
// dónde vive la historia (su ruta en su copia y la carpeta git común): una sola versión, en lib/reviewed-diff.js
function dondeViveLaHistoria(storyPath) { return require('./reviewed-diff.js').dondeViveLaHistoria(storyPath); }

function deudaDeLaMatriz(marker, matrix) {
  const er = (marker.expectedRed || {}).acmatrix;
  if (!marker.cierre || marker.cierre.estado !== 'deuda' || !er || !/^rojo-esperado/.test(String(at(marker.checks, 'acmatrix') || ''))) return null;
  const tests = Array.isArray(er.tests) ? er.tests.map(String) : [];
  const motivos = [];
  const hoy = fechaLocal(new Date());
  if (!esFecha(er.until)) motivos.push('🔴 el rojo esperado de la matriz no tiene fecha de vencimiento: la deuda no lo acepta sin ella (marker.js expect-red acmatrix --tests … --until <AAAA-MM-DD>)');
  else if (hoy > er.until) motivos.push(`🔴 la deuda ${marker.cierre.deuda} venció el ${er.until}: corré la evidencia de los criterios, o que la persona renueve la fecha dentro del tope (marker.js expect-red acmatrix --tests … --until <AAAA-MM-DD>)`);
  const c = require('../runtime-matrix.js').debtCoverage(matrix, tests);
  const lista = (ns) => ns.map((x) => '#' + x).join(', ');
  if (c.uncovered.length) motivos.push(`🔴 sin correr y fuera de la deuda: ${lista(c.uncovered)} — la lista del rojo esperado (${tests.join(', ')}) no tiene todas las pruebas de la tabla que los nombran`);
  if ((matrix.unreadableTests || []).length) motivos.push(`🔴 la deuda no cubre nada mientras la tabla tenga pruebas con la columna AC ilegible: ${matrix.unreadableTests.join(', ')}`);
  if ((matrix.notVerifiable || []).length) motivos.push(`🔴 la deuda no exime los imposibles-declarados sin firma: ${lista(matrix.notVerifiable)}`);
  if ((matrix.accionNoEjercida || []).length) motivos.push(`🔴 la deuda no exime la evidencia que no ejerció la acción: ${lista(matrix.accionNoEjercida)}`);
  if ((matrix.sinImagen || []).length) motivos.push(`🔴 la deuda no exime los criterios de pantalla sin imagen: ${lista(matrix.sinImagen)}`);
  // corrieron y su medida no cumple la cota del criterio, o falta: se miden de nuevo, se cambia el criterio o se firman
  if ((matrix.fueraDeCota || []).length) motivos.push(`🔴 la deuda no exime los criterios fuera de la cota: ${lista(matrix.fueraDeCota)}`);
  if ((matrix.sinMedicion || []).length) motivos.push(`🔴 la deuda no exime los criterios sin medición: ${lista(matrix.sinMedicion)}`);
  if ((matrix.noLeidos || []).length) motivos.push(`🔴 la deuda no exime el código declarado que la matriz no pudo leer: ${matrix.noLeidos.map((x) => x.rel || x).join(', ')}`);
  return { acepta: motivos.length === 0 && c.covered.length > 0, acs: c.covered, tests, until: er.until, motivos };
}

// Los repos hermanos de la corrida (`evidence.companion_repos`): el ok de guardar los mide si tienen cambios. No poder
// leerlos tira: un hermano sin medir no es un hermano sin cambios.
function hermanosDeLaCorrida(marker) {
  const story = resolveStoryPath(marker.storyPath, marker) || undefined;
  return require('./companion-repos.js').companionRoots(path.resolve(marker.repoPath || process.cwd()), story);
}

// La carpeta de la ejecución del marcador, o null. No poder calcularla se dice: no es «no hay ejecución».
function carpetaDeLaCorrida(marker) {
  try {
    const story = resolveStoryPath(marker.storyPath, marker) || undefined;
    const rd = require('../pipeline.js').resolveRunDir(path.resolve(marker.repoPath || process.cwd()), String(marker.storyId), false, story, { marker });
    return rd ? require('./adversarial-skip.js').carpetaReal(rd) : rd;
  } catch (e) {
    console.error(`⚠️  no pude calcular la carpeta de la ejecución (${String(e.message || e).split('\n')[0]})`);
    return null;
  }
}

// Anota en el registro de autoría el salteo firmado. Sin carpeta, o con un registro que no se lee, lo dice.
function anotarSalteoEnElRegistro(marker, firmado) {
  const rd = carpetaDeLaCorrida(marker);
  if (!rd) {
    console.error('⚠️  el salteo firmado no quedó en el registro de autoría: no hay carpeta de la ejecución (lo trae el próximo que se escriba, del marcador).');
    return;
  }
  try { require('./review-roster.js').anotarSalteo(rd, firmado); } catch (e) {
    console.error(`⚠️  no pude anotar el salteo en el registro de autoría (${String(e.message || e).split('\n')[0]}): lo trae el próximo que se escriba.`);
  }
}

// El pase ya no está salteado (corrió, o la ejecución volvió a completa): el salteo sale del registro de autoría.
function quitarSalteoDelRegistro(marker) {
  const rd = carpetaDeLaCorrida(marker);
  if (!rd) return;
  try { require('./review-roster.js').quitarSalteo(rd); } catch (e) {
    console.error(`⚠️  el registro de autoría puede seguir diciendo «salteado»: no pude corregirlo (${String(e.message || e).split('\n')[0]}).`);
  }
}

// Las opciones de los dos guiones del arnés que llama el cierre (`tokens-digest.js` y `run-change.js`), con sus nombres
// viejos (anteriores al renombre). El cierre llama con los de hoy; si el guion sale con su código de «argumentos
// inválidos» es un arnés atrasado, que sólo entiende los viejos, y se lo llama UNA vez más con ésos.
// Sin el mapa de renombres (la copia pública no lo trae), el guion sale 2 y cada cierre anotaría «no medido»:
// sin el cambio de git, sin el hilo y sin el consumo. Se arman por partes: no son nombres a usar.
// Los dos guiones salen 2 también cuando no pudieron escribir su salida: ahí la segunda vuelta repite el intento una vez,
// falla igual, y el motivo que queda anotado es el de esa última.
// Casos: `tests/marker-archive-change.test.js` (T13–T16).
const HARNESS_INVALID_ARGS = 2;
const HARNESS_OLD_OPTION = {
  run: `--${['co', 'rrida'].join('')}`,
  dump: `--${['vol', 'cado'].join('')}`,
  state: `--${['es', 'tado'].join('')}`,
};

// La marca de una corrida dejada a propósito: `<estado>/parked/<sesión>.json` con `{story, kind: queue | until, until, at,
// by}`. Vive junto a las corridas y no adentro: sin firma no se escribe el marcador de otra sesión, y las de la fila tienen
// la sesión cerrada. No autoriza nada, sólo protege y cambia lo que se muestra: ni ponerla ni sacarla piden firma.
const parkedPath = (sid) => path.join(STATE_DIR, 'parked', `${String(sid).replace(/[/\\]/g, '_')}.json`);
// La marca que protege a esta corrida: la de su historia, puesta después de que arrancó (una corrida nueva no la hereda), o
// la fecha de `paused_until:` de su historia, que /wip y la oficina muestran igual. Una marca que está y no se puede leer
// protege: no poder preguntar no es estar sin marca.
function marcaDe(sid, m) {
  let mark = null;
  try { mark = JSON.parse(fs.readFileSync(parkedPath(sid), 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') {
      process.stderr.write(`[marker] no pude leer la marca de la sesión ${sid} (${e.code || e.message}): la trato como marcada.\n`);
      return { kind: 'ilegible' };
    }
  }
  if (mark && String(mark.story) === String(m && m.storyId) && !(Date.parse(mark.at) < Date.parse(m.startedAt))) return mark;
  let until = null;
  try { until = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'tools', 'work-in-progress.js')).storyPausedUntil(m && m.storyPath); } catch (e) {
    // sin ese lector, sólo cuenta la marca: se dice, porque esto protege trabajo
    process.stderr.write(`[marker] no pude ver si la historia ${m && m.storyId} está en pausa (${e.message}).\n`);
  }
  return until ? { kind: 'historia', until } : null;
}
// Una corrida terminada con cambios sin guardar espera el ok del dueño, aunque lleve días sin tocarse: no está abandonada.
// Si no se puede leer el repo tampoco se poda.
function esperaGuardar(m) {
  if (!m || !Array.isArray(m.stepsPending) || m.stepsPending.length) return false;
  try {
    const t = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'tools', 'work-in-progress.js')).unsavedChanges(m, { until: Date.now() + 3000, cache: new Map() });
    return t.dirty || t.problems.length > 0;
  } catch (_e) { return true; }
}

// La hora de este paso, para que /wip y la oficina digan la misma aunque nadie mire y cambien las medianas. Si no se puede
// calcular, el marcador queda sin ella y se calcula como antes.
function conHoraDelPaso(marker) {
  if (PREVIO) return marker;
  try {
    const hora = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'tools', 'work-in-progress.js')).hourForStep(marker, { home: os.homedir(), stateDir: STATE_DIR });
    if (hora) marker.horaDelPaso = hora; else delete marker.horaDelPaso;
  } catch (e) {
    delete marker.horaDelPaso;
    try { require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'session-state.js')).logError(STATE_DIR, `marker.js no pudo calcular la hora del paso (${e && e.message ? e.message : e})`); } catch (_e) { /* sin registro tampoco */ }
  }
  return marker;
}

// ¿Está viva la sesión? Lo dicen los archivos de sesión de Claude Code (la carpeta de sesiones, <pid>.json, con su
// sessionId): viva si alguno la nombra y su proceso existe. Un archivo que no se puede leer podría ser el de esa
// sesión, así que no se la puede dar por muerta: se devuelve cuál.
// Sin registro de la sesión cuenta como muerta, como siempre (lib/session-liveness.js dice por qué puede no estar).
function sessionLiveness(sid) {
  return require('./session-liveness.js').liveness(sid, { home: os.homedir() });
}

// `adhoc clear-orphan <sid>`: borra el ad-hoc que dejó una sesión que ya no está. Se borra sólo si la sesión no está viva
// y el ad-hoc lleva más de STALE_HOURS sin tocarse; cada borrado y cada negativa quedan en adhoc.log.
// `doing "<qué hago>"`: lo que hace una sesión sin story (un video, una medición), para que /wip lo diga. No es un
// permiso: no toca el portón de carril ni el ad-hoc. Otro `doing` la reemplaza; `doing clear` la borra;
// `doing clear-orphan <sid>` borra la nota de otra sesión que ya no vive. Archivo: doing/<sid>.json { text, at }; doing.log.
// Con una ejecución abierta en la sesión sólo anota la espera de un turno sin texto; lo demás sale 3 sin escribir nada.
// `--until HH:MM`: a qué hora dice que termina. Volver a anotar el mismo trabajo (el mismo texto, o sin texto) conserva en
// `promisedAt` la primera hora que prometió, contra la que la oficina compara. La primera corrección, en los 10 minutos de
// la primera hora anotada, es un error de tipeo y la reemplaza; una sola, para que corregir seguido no renueve la ventana.
// `--waiting-for "<qué espera>"`: no tiene hora porque depende de otro; queda desde cuándo (`waitingSince`), que no cambia mientras espere lo mismo.
// `--kind main|session`, sólo con `--waiting-for`: a qué espera (`waitingKind`), para que la oficina la ponga en su grupo; sin él, a otra sesión.
// La hora de fin que declara una sesión, «HH:MM», como fecha completa: la de hoy; la de mañana si quedaría más de 12 h
// antes de ahora (a las 23:00, «01:30» es de mañana); la de ayer si quedaría más de 18 h después (a las 00:10, «23:30» es
// de anoche, y ya pasó). Una hora mal escrita es null.
function untilIso(text) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(text || '').trim());
  if (!m) return null;
  const now = Date.now();
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() < now - 12 * 3600 * 1000) d.setDate(d.getDate() + 1);
  else if (d.getTime() > now + 18 * 3600 * 1000) d.setDate(d.getDate() - 1);
  return d.toISOString();
}

// Una hora declarada que ya pasó se anota igual (puede ser a propósito), pero se avisa: /office la va a mostrar atrasada.
function warnPastUntil(cmd, iso) {
  if (Date.parse(iso) < Date.now()) console.error(`marker.js ${cmd}: esa hora ya pasó hoy; quedó anotada y la oficina la va a mostrar atrasada`);
}

// ============================================================
// Story `status:` frontmatter mutation (fix robusto capa 3)
// Source of truth durable cross-sesión y cross-máquina. Permite que el
// orquestador setee status: in-progress al arrancar y review/done al cerrar.
// Mutación atómica via tmp+rename.
// ============================================================

const VALID_STATUSES = ['ready-for-dev', 'in-progress', 'review', 'done', 'blocked', 'abandoned'];

// El estado de una tanda del bloque `pipelines:` de la story (lista de `- name: X` con su `status:`). Lo usa el cierre
// («Cerrar la historia») para pasar a `done` las tandas que ya están en main: `deferrals-open` frena con cualquiera que no lo esté.
const VALID_PIPELINE_STATUSES = ['done', 'in-progress', 'blocked', 'pending'];

// Los repos de la corrida de un marcador, para la comparación con main (lib/save-ok.js). Lanza si no se pueden calcular.
function reposParaComparar(m) {
  const so = require('./save-ok.js');
  return so.reposDeLaCorrida({ marker: { ...m, storyPath: resolveStoryPath(m.storyPath, m) || m.storyPath }, hermanos: hermanosDeLaCorrida(m) });
}

const delegatedSigning = () => require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'delegated-signing.js'));

// ============================================================
// Carril AD-HOC — hotfix / ajuste chico SIN story, declarado por sesión.
// Es la salida (b) del portón de carril (lib/story-gate.js): un repo bajo el arnés no acepta
// código sin pipeline activo ni esta declaración. Archivo: adhoc/<sid>.json
//   { reason, maxFiles, files[], declaredAt, lastTouch, via, by }
// Declararlo o cambiarle el cupo es una firma del dueño (`adhoc-lane`, scripts/lib/owner-window.js): la aprueba en la
// ventana de permiso, la da en su terminal (`--terminal`), o la da la sesión designada de esta máquina por la delegación
// del perfil (`--for-session <destino>`). Nada de la conversación la abre: lo que dice el chat lo puede escribir la
// sesión, y la ventana muestra sólo lo que hace el comando.
// El cupo lo cuentan los archivos de IMPLEMENTACIÓN distintos (on-edit.js los registra en
// PostToolUse); al pasarse, el portón vuelve a cerrar (→ story + pipeline, o re-declarar con cupo
// mayor y motivo). Todo queda en adhoc.log. `adhoc clear` lo termina; `marker.js set` (pipeline)
// tiene prioridad sobre él aunque siga existiendo.
// ============================================================
// el cupo más grande que declara la designada por otra pestaña: uno mayor lo aprueba el dueño en su ventana
const { cupoAlDeclarar } = require('./story-gate.js');
const ADHOC_MOTIVO_MAX = 200;
const ADHOC_CUPO_MAX = 50;
// la respuesta al abrir un camino corto: ¿cambia de dónde salen los datos o quién los ve? (Casos: story-gate-cli.test.js)
const DATOS_VALORES = ['sin-cambio', 'cambian'];
const DATOS_TEXTO = { 'sin-cambio': 'no cambia de dónde salen los datos ni quién los ve' };
// una palabra de un comando que se le da a alguien para que lo corra: entre comillas simples, sin nada que la consola
// interprete
const citar = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * Las dos formas de pedir una firma sobre un archivo, cada una dicha para quién es (scripts/lib/owner-window.js, la
 * única fuente). Sin esa biblioteca, el renglón dice qué firma pedir sin escribir el comando.
 */
function formasDeFirmarArchivo(firma, archivo, sesion) {
  try {
    return require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'owner-window.js')).formasDeFirmar(firma, archivo, sesion).renglones;
  } catch (e) {
    return [`la firma de archivo ${firma}${archivo ? ` sobre ${archivo}` : ''}, en la ventana de permiso (no pude armar el comando: ${e.message})`];
  }
}

// Las opciones viejas siguen andando hasta el retiro (también desde una sesión abierta con las
// instrucciones de antes en la memoria)
require('./legacy-names.js').aliasArgv('skills/tycon-pipeline/scripts/marker.js');
const cmd = process.argv[2];
const arg1 = process.argv[3];
const arg2 = process.argv[4];
paraOtraSesion(process.argv);

module.exports = {
  estado, SCRIPTS_DIR, MARKER_JS, isNil, nn, at, fs, os, path, stateDirOf, resolveSessionId, homeCommand,
  signatureCommand, STEPS_LIB, posixRelative, STATE_DIR, ACTIVE_DIR, LEGACY_MARKER_PATH, STALE_HOURS, PROPIA, PEDIDA,
  PREVIO, LOGS_DEL_CHEQUEO, PARA_OTRA_SESION, PARTICION, reglaParaOtra, ownerWindow, paraOtraSesion, ensureActiveDir,
  nowIso, markerFilePath, firmadaDespuesDe, pruneStale, appendLog, conRutas, readOwnMarkerRaw, readMarker,
  sinFirmaNoSeEscribe, avisarOficina, conSesionNombrada, writeMarker, syncSessionState, cerrarEjecucion, frenarSiIlegible, frenarSiPerdida,
  perdidaSinFrenar, vueltaCongeladaComprobada, comprobarLoRevisado, sellosDe, veredictoPaseAdversarial, paseAtendido,
  mensajeDelPaseAdversarial, PLAN_FILE, planDeLaCorrida, huellaDelPlan, planEnLaConversacion, planParaLaPersona,
  planVisto, anotarAprobacion, quienDeLasOpciones, CONTROLES_DEL_PASO, ORDER_REQUIRES_OLD, firmaDelDueno,
  antesDeLaRevision, trabajarSobreElDestino, porDe, conPersona, modoDeLaFirma, citaDe, hechaSinPersona, reemplazada,
  soloLaPersona, aprobadaPorPersona, noPisaLaPersona, quienDeLaMaqueta, anotarFirma, idsDeEspera, doingFileOf, anotarOtraVuelta,
  PASO_ARRANCABLE, arrancable, anotarArranque, VALID_CHECKS, resolveStoryPath, markerStoryIsUi, markerScreenRule,
  screenRule, TANDAS_MEDIDAS, tandasMedidasDe, avisarBajaDePantalla, TESTS_FAILED_PENDING, testsNotMeasuredLine,
  COLA_BYTES_RETENIDOS, RUN_CHECK_BUSY, SENALES_RUN_CHECK, VALID_FLAGS, EXTERNAL_FLAGS, HARNESS_COMMAND, OLD_FLAGS,
  motivoDe, opcion, TOPE_DE_LA_DEUDA_EN_VIVO, fechaLocal, sumarDias, esFecha, dondeViveLaHistoria, deudaDeLaMatriz,
  hermanosDeLaCorrida, carpetaDeLaCorrida, anotarSalteoEnElRegistro, quitarSalteoDelRegistro, HARNESS_INVALID_ARGS,
  HARNESS_OLD_OPTION, parkedPath, marcaDe, esperaGuardar, conHoraDelPaso, sessionLiveness, untilIso, warnPastUntil,
  VALID_STATUSES, VALID_PIPELINE_STATUSES, reposParaComparar, delegatedSigning, cupoAlDeclarar, ADHOC_MOTIVO_MAX,
  ADHOC_CUPO_MAX, DATOS_VALORES, DATOS_TEXTO, citar, formasDeFirmarArchivo, cmd, arg1, arg2,
};
