#!/usr/bin/env node
'use strict';
/*
 * heavy-turn.js — el turno de tarea pesada de una máquina con coordinadora (guides/coordination.md), del lado de las
 * ejecuciones grandes de pruebas.
 *
 * Un pase adversarial y una ejecución grande de pruebas no van juntos, porque las sondas del pase corren en la máquina y,
 * juntos, la saturan. Una ejecución es grande por cuántas suites corre, no por estar acotada o no: el corte lo pone quien
 * pide el turno (`TURN_FROM_SUITES` de run-suites-json.js; las portables enteras siempre). Los revisores son llamadas al
 * modelo y no piden turno. El corredor toma el turno al arrancar y lo suelta al terminar; con un pase en vuelo de
 * cualquier sesión viva (también la propia) no arranca y dice de quién es. El pase no deja archivo propio: está en vuelo
 * mientras su marcador lo dice (`heavyPassesInFlight` de coordination.js), y se libera al anotar su resultado o su
 * salteo. Al tomar el turno se borra la espera que esa sesión anotó: ya no espera. Una espera anotada después, con la
 * prueba ya corriendo, pierde contra este registro: la fila de la coordinadora y /wip (y con ella la oficina) leen quién
 * corre con `runningSids`.
 *
 * El turno tiene dos lugares, cada uno en su archivo (`slotFiles`). Sin ninguna ejecución grande corriendo se toma uno
 * como siempre. Con una corriendo, la segunda toma el otro lugar sólo si la memoria libre del sistema está en el piso o
 * arriba (`secondTurnFloor`: `coordination.second_heavy_min_free_pct`, o `SECOND_HEAVY_MIN_FREE_PCT`): la memoria es lo
 * que se cuida, porque la CPU ya se reparte sola (suite-times.js). Se mide una vez, al decidir; sin poder medirla no se da
 * (es un extra), y una que ya corre no se corta si la memoria baja después. Con dos corriendo, la tercera espera. Lo que
 * decide es cuántas corren, no qué archivo queda libre, y quien pierde la publicación de un lugar vuelve a contar.
 *
 *   take --what <qué corre> [--process <pid>]   0 = turno tomado (o no hay coordinadora) · 77 = no hay lugar, y dice por qué
 *   release [--process <pid>]                   suelta el lugar de ese proceso; el de otro no lo toca
 *   release --reserve                           suelta la reserva (la coordinadora, o la sesión que la puso)
 *   grant --to <sesión>                         el «arrancá» de la coordinadora para una sesión de la fila (2 = no se puede)
 *   reserve --for "<qué>" [--to <sesión>]       la coordinadora reserva el turno para revisores o un pase, de una sesión (77 = ya corre una)
 *   holder [--json]                         la ejecución grande más vieja que corre, o nadie
 *   holders [--json]                        las que corren, de la más vieja a la más nueva
 *
 * Con una coordinadora designada y viva, el turno libre no se toma solo: quien recibió un 77 queda en la fila
 * (`suite-waits/`) y lo toma sólo con el «arrancá» a su nombre (`suite-grant.json`, vence a los 10 min o con su sesión
 * cerrada); mientras un «arrancá» está vigente, nadie más lo toma. La reserva (`suite-reserve.json`) lo toma a nombre de
 * lo que la coordinadora lanzó y no tiene proceso: vence a los 90 min, o a los 10 con su sesión cerrada. Quien no es un
 * portón (la suite rápida, `queue: false`) no entra a la fila ni gasta el «arrancá» de su sesión.
 *
 * Un portón que no toma el turno (acotado, de menos suites que el corte) igual borra la espera anotada de su sesión al
 * arrancar (`gateStarted`) y, con coordinadora, se anota en `<estado>/coordination/gates/<pid>.json` mientras corre: la
 * fila de la coordinadora lo ve (`gatesRunning`) y no da el «arrancá» encima. Se borra al terminar (`gateEnded`); el de
 * un proceso que ya no vive se descarta al leer.
 *
 * Al lado de un pase en vuelo corre un solo portón acotado, de hasta `BESIDE_PASS_MAX_SUITES` suites, y sólo con la
 * memoria libre del sistema en `BESIDE_PASS_MIN_FREE_PCT` o más (`besidePass`): el pase pesa como una sesión más, y un
 * portón chico dura menos que él. Uno más largo, uno segundo o la memoria justa esperan al resultado del pase. Mirar y
 * anotarse no es un solo paso: después de anotarse, `besideRecheck` deja seguir sólo al primero de los anotados. La
 * memoria se mira una vez, al decidir; no poder medirla no frena, y se dice. Sin pase en vuelo, nada de esto se mira.
 *
 * Sin coordinadora designada y viva (la nube, la CI, una máquina sin coordinar) no se toma nada y todo corre como
 * siempre: el mismo criterio que el turno del pase (`adversarialTurn` de coordination.js). Un turno cuyo proceso ya no
 * vive (una suite cortada con kill -9), o de más de tres horas, se libera solo. El primer lugar vive en
 * `<estado>/coordination/suite-turn.json` y el segundo, al lado, en `suite-turn-2.json`. El corredor carga este archivo
 * del repo que prueba: una copia de antes del segundo lugar sigue pidiendo un solo turno, del lado seguro.
 * Off: TYCON_SUITE_TURN=0. Con TYCON_SUITE_TURN=1 se pide el turno aunque no haya coordinadora (sólo puede frenar de más:
 * es lo que usan las pruebas, que no pueden designar una coordinadora en el perfil del árbol).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SKILL_LIB = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib');
const { stateDir, claudeDir } = require(path.join(SKILL_LIB, 'state-dir.js'));
const { rolDeCoordinar, designacionVigente } = require(path.join(SKILL_LIB, 'critical-waivers.js'));
const { sessionsBySid } = require('./work-in-progress.js');

// Las portables tardan cerca de una hora: tres ya no es una suite que corre.
const TURN_MAX_MS = 3 * 3600000;
// El 75 del portón de pruebas es de `run-check`, que reescribe el de un hijo como rojo: el turno tiene su propio código, y
// test-gate.sh lo da como su 75 («otra corrida en marcha, esperá»; steps/step-06-run-tests.md).
const BUSY_EXIT = 77;
const EVICT_LOCK_MS = 10000;
// Al lado de un pase: hasta cuántas suites (las de un portón que dura menos que un pase) y con cuánta memoria libre.
const BESIDE_PASS_MAX_SUITES = 40;
const BESIDE_PASS_MIN_FREE_PCT = 40;
// El segundo turno de ejecución grande, con cuánta memoria libre como mínimo. Un portón de 4 a la vez suma hasta 1,2 GB
// de pico: en una máquina de 16 GB, dos juntos desde la mitad libre la dejan cerca de 35 %, por encima del punto en que
// Claude Code empieza a cerrar sesiones. Cada máquina lo cambia con `coordination.second_heavy_min_free_pct`.
const SECOND_HEAVY_MIN_FREE_PCT = 50;
const turnFile = (home) => path.join(stateDir(home), 'coordination', 'suite-turn.json');
// Los dos lugares del turno: el primero, el de siempre; el segundo, al lado. `slotFilesIn` los cuenta desde la carpeta de
// estado, para quien ya la tiene.
const slotFilesIn = (state) => ['suite-turn.json', 'suite-turn-2.json'].map((n) => path.join(state, 'coordination', n));
const slotFiles = (home) => slotFilesIn(stateDir(home));
const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').replace(/[\p{Cc}\p{Cf}<>]/gu, '').trim().slice(0, 80);
const hhmm = (ms) => { const d = new Date(ms); return Number.isNaN(d.getTime()) ? '?' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const alive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// El rol sale del perfil del equipo, que viaja con el arnés instalado. Un clon de trabajo del repo público no lo trae: se
// pregunta primero al árbol de este archivo y, sin respuesta, al instalado. Sin rol en ninguno, el de fábrica: la
// coordinadora ordena igual. Esta lectura sólo nombra a quién pedirle el turno.
function roleOf({ home, env, arnes }) {
  const own = rolDeCoordinar({ env, home, ...(arnes ? { arnes } : {}) });
  if (own.firma || arnes) return own.rol;
  try {
    const { harnessDir } = require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'));
    return rolDeCoordinar({ env, home, arnes: harnessDir(home) }).rol;
  } catch { return own.rol; }
}

/** El rol de la coordinadora si hay una designada y viva; null si no (y entonces no hay turno que pedir). */
function coordinator({ home, env, arnes }) {
  if (env.TYCON_SUITE_TURN === '0') return null;
  // prenderlo a mano sólo puede frenar de más: no hace falta la coordinadora para pedirlo
  if (env.TYCON_SUITE_TURN === '1') return 'coordinadora';
  const d = designacionVigente({ home });
  // no poder leerla no es «no hay coordinadora»: la suite corre igual, pero se dice que no se pudo mirar
  if (d && d.error) process.stderr.write(`heavy-turn: no pude saber cuál es la coordinadora (${d.error}): no pido turno\n`);
  if (!d || d.error) return null;
  const role = roleOf({ home, env, arnes });
  if (!role) return null;
  const s = sessionsBySid(path.join(claudeDir(home), 'sessions'), [], null).get(d.sesion);
  return s && s.alive ? role : null;
}

const readTurn = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
// Vale el turno de un proceso vivo y de menos de TURN_MAX_MS: una suite colgada o un pid reusado no frenan para siempre.
const inForce = (t, now) => Boolean(t && alive(Number(t.pid)) && !(Number.isFinite(t.at) && now - t.at >= TURN_MAX_MS));

// Un lugar del turno: `{ file, turn, unreadable }`. Un archivo que está y no se puede leer no es lo mismo que «no hay
// turno»: con `problems`, se anota ahí.
function readSlot(file, problems) {
  try { return { file, turn: JSON.parse(fs.readFileSync(file, 'utf8')), unreadable: false }; } catch (e) {
    if (e.code === 'ENOENT') return { file, turn: null, unreadable: false };
    if (problems) problems.push(`el turno de las ejecuciones grandes (${file}) no se puede leer (${e.code || oneLine(e.message)})`);
    return { file, turn: null, unreadable: true };
  }
}
// De la más vieja a la más nueva; a igual hora, el proceso menor.
const byAge = (a, b) => (Number(a.at) - Number(b.at)) || (Number(a.pid) - Number(b.pid));

/**
 * Las ejecuciones grandes que corren: `[{ pid, sid, session, what, at }]`, de la más vieja a la más nueva. Con `problems`,
 * el lugar que no se puede leer se anota ahí. Con `state`, se leen de esa carpeta de estado en vez de la de `home`.
 */
function holders({ home = require('os').homedir(), now = Date.now(), problems = null, state = null } = {}) {
  return (state ? slotFilesIn(state) : slotFiles(home)).map((f) => readSlot(f, problems).turn).filter((t) => inForce(t, now)).sort(byAge);
}

/** La ejecución grande más vieja que corre, `{ pid, sid, session, what, at }`, o null; `problems` como en `holders`. */
function holder(opts = {}) {
  return holders(opts)[0] || null;
}

const FLOOR_ORIGIN = { perfil: 'del perfil del equipo', maquina: 'de esta máquina', env: 'de una variable', 'sin-valor': 'de fábrica' };
const floorText = (f) => `piso ${f.value} %, ${FLOOR_ORIGIN[f.origin] || oneLine(f.origin)}`;

/**
 * El piso de memoria libre del segundo turno: `{ value, origin, problem }`. Sale de la configuración con el orden de
 * siempre (variable › máquina › perfil), con el perfil resuelto como `roleOf`: el del árbol de este archivo y, si no trae,
 * el del arnés instalado. Un valor roto o el lector caído dan `SECOND_HEAVY_MIN_FREE_PCT` y el motivo en `problem`.
 */
function secondTurnFloor({ home = require('os').homedir(), env = process.env, arnes } = {}) {
  const factory = (problem) => ({ value: SECOND_HEAVY_MIN_FREE_PCT, origin: 'sin-valor', problem });
  try {
    const TC = require(path.join(__dirname, '..', 'lib', 'tycon-config.js'));
    const load = (a) => TC.cargar({ home, env, ...(a ? { arnes: a } : {}) });
    let cfg = load(arnes);
    if (!arnes && cfg.archivos && cfg.archivos.perfil && cfg.archivos.perfil.estado === 'ausente') {
      try { cfg = load(require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js')).harnessDir(home)); } catch { /* sin arnés instalado: vale el de este árbol */ }
    }
    const key = 'coordination.second_heavy_min_free_pct';
    const errores = cfg.errores || [];
    // el error de un archivo trae la clave; el de la variable, el nombre de la variable
    const names = new Set([key, ...((TC.VARIABLES && TC.VARIABLES[key]) || [])]);
    const own = errores.find((e) => names.has(e.clave));
    if (own) return factory(`el piso configurado no vale (${oneLine(own.clave)}: ${oneLine(own.motivo)})`);
    const r = TC.coordinacion(cfg).second_heavy_min_free_pct;
    const broken = errores.find((e) => !e.clave);
    if (broken && r.origin === 'sin-valor') return factory(`la configuración no se pudo leer entera (${oneLine(broken.archivo)}: ${oneLine(broken.motivo)})`);
    return { value: r.value, origin: r.origin, problem: null };
  } catch (e) { return factory(`el lector de configuración falló (${oneLine(e.message)})`); }
}

function sessionName(home, sid) {
  if (!sid) return null;
  const s = sessionsBySid(path.join(claudeDir(home), 'sessions'), [], null).get(sid);
  return (s && s.name && oneLine(s.name)) || String(sid).slice(0, 8);
}

// Lo que dice el registro se sanea al leerlo: el archivo queda en la carpeta del estado y su texto llega al contexto de un agente.
const describe = (t) => `${oneLine(t.session) || 'una sesión sin nombre'} (${oneLine(t.what) || 'ejecución grande'}, desde las ${hhmm(t.at)})`;

// Publica el turno entero y de una: `link` falla si el archivo ya está, y nadie puede leerlo a medio escribir.
function publish(file, turn) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(turn));
  try { fs.linkSync(tmp, file); return true; } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  } finally { try { fs.unlinkSync(tmp); } catch { /* ya no está */ } }
}

// Saca un turno vencido sin pisar al que lo acaba de tomar: de a uno por vez, y mirándolo de nuevo con el candado puesto.
// Un candado de una toma que murió a mitad de camino vence solo.
function evict(file, now) {
  const lock = `${file}.evict`;
  try { fs.mkdirSync(lock); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try { if (Date.now() - fs.statSync(lock).mtimeMs > EVICT_LOCK_MS) fs.rmdirSync(lock); } catch { /* otro lo sacó */ }
    return;
  }
  try {
    // Ya no está: otro lo sacó, y borrar ahora se llevaría el turno que alguien esté publicando. Con el candado puesto,
    // lo que se leyó vencido sigue siendo eso al borrarlo: nadie publica sobre un archivo que existe.
    if (!fs.existsSync(file) || inForce(readTurn(file), now)) return;
    try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  } finally { try { fs.rmdirSync(lock); } catch { /* vence solo */ } }
}

// La sesión que toma el turno ya no lo espera: su espera anotada (`marker.js doing --waiting-for`) se va, para que /wip y
// la oficina no la sigan mostrando esperando mientras corre. Con texto propio, la nota queda sin la espera. No poder
// borrarla no frena la suite.
function clearWait(home, sid) {
  if (!sid) return;
  const file = path.join(stateDir(home), 'doing', `${String(sid).replace(/[/\\]/g, '_')}.json`);
  try {
    const note = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!note || !note.waitingFor) return;
    if (!note.text) { fs.unlinkSync(file); return; }
    const { waitingFor: _w, waitingSince: _s, ...rest } = note;
    fs.writeFileSync(file, JSON.stringify(rest));
  } catch { /* sin nota, o ilegible: no hay espera que borrar */ }
}

const hhmmIso = (iso) => hhmm(Date.parse(iso));

// El pase en vuelo que frena la ejecución grande, o null; `note` es lo que se dice aunque no frene (un pase de más de una
// hora, o no haber podido mirar). Un pase cuyo Workflow ya terminó no frena aunque nadie haya anotado su resultado: el
// mismo criterio que el turno entre pases (coordination.js passOccupiesMachine). Se carga acá y no al cargar el módulo:
// coordination.js ya carga éste.
function passHolder({ home, env, now, sid }) {
  let r;
  try { r = require('./coordination.js').heavyPassesInFlight({ home, env, now, sessionId: sid, includeOwn: true }); } catch (e) {
    return { pass: null, note: `no pude ver si hay un pase en vuelo: ${oneLine(e.message)}` };
  }
  // un pase cuya sesión no se sabe si vive (no se pudo leer todo) no frena: no poder mirar no frena, pero se dice
  const pass = r.passes.find((p) => !p.stale && !p.uncertain) || null;
  const stale = r.passes.filter((p) => p.stale);
  const unsure = r.passes.filter((p) => !p.stale && p.uncertain);
  const notes = [];
  if (r.problems.length) notes.push(`no pude ver si hay un pase en vuelo: ${oneLine(r.problems.join(' · '))}`);
  if (unsure.length) notes.push(`no sé si vive la sesión del pase de ${unsure.map((p) => `la ${oneLine(p.storyId) || 'sin story'} (${oneLine(p.session)})`).join(' · ')}: no frena`);
  if (!pass && stale.length) notes.push(`hay un pase adversarial anotado hace más de una hora (${stale.map((p) => `la ${oneLine(p.storyId) || 'sin story'}, ${oneLine(p.session)}`).join(' · ')}): puede estar terminado o colgado, así que no frena`);
  return { pass, note: notes.length ? notes.join('; ') : null };
}

/**
 * Toma un lugar del turno para `pid`. `{ ok, taken, message, note }`: ok false = no hay lugar (dos corriendo, una y la
 * memoria debajo del piso o sin medir, o un pase en vuelo), y el mensaje dice por qué y quién corre; `note` es lo que hay
 * que decir aunque se haya tomado (también va a la salida de errores). `readMemory` mide la memoria libre (`freeMemory`).
 */
function take({ home = require('os').homedir(), env = process.env, arnes, pid = process.pid, what, now = Date.now(), readMemory = freeMemory, queue = true } = {}) {
  const role = coordinator({ home, env, arnes });
  if (!role) return { ok: true, taken: false, message: null };
  const sid = env.CLAUDE_CODE_SESSION_ID || env.CODEX_SESSION_ID || null;
  // La fila del «arrancá» vale sólo con una coordinadora designada y viva, que es quien lo da: con el turno prendido a
  // mano (TYCON_SUITE_TURN=1) y nadie designado, un portón anotado quedaría frenado sin nadie que lo destrabe.
  const lined = queue && Boolean(sid) && designatedAlive(home);
  // todo «no» a un portón lo anota en la fila: desde ahí, el turno libre lo toma con el «arrancá» de la coordinadora
  const refuse = (r) => { if (lined) noteWait(home, sid, what, now); return r; };
  const { pass, note } = passHolder({ home, env, now, sid });
  if (note) process.stderr.write(`heavy-turn: ${note}\n`);
  if (pass) {
    return refuse({ ok: false, taken: false, note, holder: { kind: 'pass', storyId: pass.storyId, session: pass.session, since: pass.since },
      message: `Hay un pase adversarial en vuelo en esta máquina: pase adversarial de la ${oneLine(pass.storyId) || 'sin story'} (${oneLine(pass.session)}, desde las ${hhmmIso(pass.since)}). Va una tarea pesada por vez (guides/coordination.md, «Lo pesado, con turno»): esperá que su sesión anote el resultado, o pedile turno a la ${role}.` });
  }
  const reserved = reserveInForce({ home, now });
  if (reserved && reserved.sid !== sid) {
    return refuse({ ok: false, taken: false, note, holder: { kind: 'reserve', ...reserved },
      message: `El turno de tarea pesada está reservado por la ${role} para «${oneLine(reserved.what)}» (${oneLine(reserved.session) || 'su sesión'}, desde las ${hhmm(reserved.at)}): esperá que lo suelte, o pedile turno a la ${role} (guides/coordination.md, «Lo pesado, con turno»).` });
  }
  // el «arrancá»: quien ya está en la fila toma el turno sólo con el suyo; quien no, no toma el que se le dio a otra
  const grant = grantInForce({ home, now });
  const mineGrant = Boolean(grant && sid && grant.to === sid);
  const waited = lined ? readWait(home, sid, now) : null;
  const notYours = waited && !mineGrant
    ? `Esperá el «arrancá» de la ${role}: anotaste que esperabas turno a las ${hhmm(waited.at)}, y con coordinadora el turno libre no se toma solo. Avisale que estás lista; ella lo da con heavy-turn.js grant --to ${sid}.`
    : !waited && grant && !mineGrant
      ? `La ${role} le dio el «arrancá» a ${sessionName(home, grant.to)} a las ${hhmm(grant.at)}: el turno es suyo hasta que lo tome o venza (${GRANT_MS / 60000} min). Esperá, o pedile turno a la ${role}.`
      : null;
  const files = slotFiles(home);
  fs.mkdirSync(path.dirname(files[0]), { recursive: true });
  const mine = { pid, sid, session: sessionName(home, sid), what: oneLine(what) || 'ejecución grande', at: now };
  // quien no es un portón (la suite rápida) no toca la espera de su sesión: es la del portón que todavía espera
  const taken = () => {
    if (queue) clearWait(home, sid);
    if (lined) { dropWait(home, sid); if (mineGrant) dropGrant(home, sid); }
    return { ok: true, taken: true, message: null, note };
  };
  const wait = `esperá que termine, o pedile turno a la ${role} (guides/coordination.md, «Lo pesado, con turno»)`;
  const unstick = (ts) => `Si quedó colgada, se destraba con ${ts.map((t) => `heavy-turn.js release --process ${Number(t.pid)}`).join(' o con ')}.`;
  let floor = null;
  let mem = null;
  // unos pocos intentos: entre contar, sacar un lugar vencido y publicar el propio puede entrar otro
  for (let i = 0; i < 20; i += 1) {
    if (i) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    const slots = files.map((f) => readSlot(f));
    const running = slots.filter((s) => inForce(s.turn, now)).map((s) => s.turn).sort(byAge);
    // quien ya tiene un lugar no es otra ejecución: no mide ni ocupa el otro
    if (running.some((t) => Number(t.pid) === pid)) return taken();
    if (running.length >= 2) {
      return refuse({ ok: false, taken: false, note, holder: running[0], holders: running,
        message: `Ya corren dos ejecuciones grandes de pruebas en esta máquina: ${running.map(describe).join(' y ')}. Van dos como mucho: ${wait.replace('que termine', 'que termine una')}. ${unstick(running)}` });
    }
    if (running.length === 1) {
      const [t] = running;
      const head = `Ya corre una ejecución grande de pruebas en esta máquina: ${describe(t)}.`;
      const second = (why) => refuse({ ok: false, taken: false, note, holder: t, holders: running, message: `${head} ${why}: ${wait}. ${unstick([t])}` });
      const other = slots.find((s) => !(s.turn && Number(s.turn.pid) === Number(t.pid) && inForce(s.turn, now)));
      // un lugar que no se lee puede ser de alguien que corre: el segundo no se da a ciegas
      if (other.unreadable) return second(`El otro lugar del turno (${oneLine(path.basename(other.file))}) no se puede leer, así que no doy el segundo turno`);
      if (!floor) {
        floor = secondTurnFloor({ home, env, arnes });
        if (floor.problem) process.stderr.write(`heavy-turn: ${floor.problem}: uso el piso de fábrica, ${floor.value} %\n`);
      }
      if (!mem) {
        try { mem = readMemory() || { pct: null, why: 'sin motivo' }; } catch (e) { mem = { pct: null, why: oneLine(e.message) }; }
      }
      if (mem.pct == null) return second(`La segunda no arranca: no pude medir la memoria libre: ${oneLine(mem.why) || 'sin motivo'}; sin medirla no se da el segundo turno`);
      if (mem.pct < floor.value) return second(`La segunda corre con la memoria libre en el piso o arriba, y está en ${mem.pct} % (${floorText(floor)})`);
      if (notYours) return refuse({ ok: false, taken: false, note, holder: t, holders: running, message: `${head} Hay lugar para una segunda, pero: ${notYours}` });
      evict(other.file, now);
      if (publish(other.file, mine)) {
        process.stderr.write(`heavy-turn: segunda ejecución grande: memoria libre ${mem.pct} %, ${floorText(floor)}\n`);
        return taken();
      }
      continue;
    }
    // ninguna corre: los lugares vencidos se sacan y se publica el primero, sólo ése. Quien pierde la publicación vuelve a
    // contar: si probara el otro lugar, quedaría segundo sin medir la memoria.
    if (notYours) return refuse({ ok: false, taken: false, note, message: `El turno de las ejecuciones grandes está libre. ${notYours}` });
    for (const s of slots) evict(s.file, now);
    if (publish(files[0], mine)) return taken();
  }
  return refuse({ ok: false, taken: false, message: `No pude tomar el turno de las ejecuciones grandes (${files[0]} vuelve a aparecer): no la corrí.` });
}

// ── El «arrancá» de la coordinadora, la fila de los portones que esperan y la reserva (guides/coordination.md) ──────
// Con coordinadora, un portón que recibió 77 queda anotado en `suite-waits/<sesión>.json` y toma el turno libre sólo con
// el «arrancá» (`suite-grant.json`) a su nombre: si no, el primero que reintenta se lo lleva encima de lo que la
// coordinadora ya lanzó. La reserva (`suite-reserve.json`) es el turno tomado a nombre de unos revisores o un pase, que no
// tienen proceso propio: su dueña es la sesión de la coordinadora y sus topes se cuentan desde `at`.
const GRANT_MS = 10 * 60000;
const RESERVE_MS = 90 * 60000;
const coordDir = (home) => path.join(stateDir(home), 'coordination');
const waitsDir = (home) => path.join(coordDir(home), 'suite-waits');
const grantFile = (home) => path.join(coordDir(home), 'suite-grant.json');
const reserveFile = (home) => path.join(coordDir(home), 'suite-reserve.json');
const safeSid = (sid) => String(sid).replace(/[/\\]/g, '_');
const sessionAlive = (home, sid) => { const s = sid && sessionsBySid(path.join(claudeDir(home), 'sessions'), [], null).get(String(sid)); return Boolean(s && s.alive); };

// Entero y de una, como el turno: escrito directo, se vería vacío mientras se escribe.
function writeWhole(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(value)); fs.renameSync(tmp, file); } finally { try { fs.unlinkSync(tmp); } catch { /* ya renombrado */ } }
}

/**
 * La espera anotada de `sid` (`{ sid, what, at }`), o null. Una de más de TURN_MAX_MS ya no cuenta, y se borra; con
 * `keep` (quien sólo lee, como la fila de la coordinadora) no se borra.
 */
function readWait(home, sid, now = Date.now(), { keep = false } = {}) {
  const file = path.join(waitsDir(home), `${safeSid(sid)}.json`);
  const w = readTurn(file);
  if (!w) return null;
  if (!Number.isFinite(w.at) || now - w.at >= TURN_MAX_MS) {
    if (!keep) { try { fs.unlinkSync(file); } catch { /* otro la borró */ } }
    return null;
  }
  return w;
}
// Anotar no frena el 77: una espera que no se puede escribir se dice y el portón espera igual.
function noteWait(home, sid, what, now) {
  if (readWait(home, sid, now)) return;
  try { writeWhole(path.join(waitsDir(home), `${safeSid(sid)}.json`), { sid, what: oneLine(what) || 'ejecución grande', at: now }); } catch (e) {
    process.stderr.write(`heavy-turn: no pude anotar la espera de esta sesión en la fila (${e.code || oneLine(e.message)})\n`);
  }
}
function dropWait(home, sid) { try { fs.unlinkSync(path.join(waitsDir(home), `${safeSid(sid)}.json`)); } catch { /* no estaba */ } }

/** El «arrancá» vigente (`{ to, by, at }`): su sesión vive y no pasaron GRANT_MS. Uno vencido queda escrito y es null. */
function grantInForce({ home = require('os').homedir(), now = Date.now() } = {}) {
  const g = readTurn(grantFile(home));
  return g && g.to && Number.isFinite(g.at) && now - g.at < GRANT_MS && sessionAlive(home, g.to) ? g : null;
}
/** El último «arrancá» escrito, vigente o no, para la fila: `{ to, by, at, inForce }` o null. */
function lastGrant({ home = require('os').homedir(), now = Date.now() } = {}) {
  const g = readTurn(grantFile(home));
  return g && g.to ? { ...g, inForce: Boolean(grantInForce({ home, now })) } : null;
}
function dropGrant(home, sid) {
  const g = readTurn(grantFile(home));
  if (g && g.to === sid) { try { fs.unlinkSync(grantFile(home)); } catch { /* otro lo borró */ } }
}

/** La reserva vigente (`{ sid, session, what, at }`): menos de RESERVE_MS, y menos de GRANT_MS si su sesión ya no vive. */
function reserveInForce({ home = require('os').homedir(), now = Date.now() } = {}) {
  const r = readTurn(reserveFile(home));
  if (!r || !Number.isFinite(r.at) || now - r.at >= RESERVE_MS) return null;
  return now - r.at < GRANT_MS || sessionAlive(home, r.sid) ? r : null;
}

// ¿Hay una coordinadora designada y viva? Sin ella no hay quien dé el «arrancá».
function designatedAlive(home) {
  const d = designacionVigente({ home });
  return Boolean(d && !d.error && d.sesion && sessionAlive(home, d.sesion));
}

// ¿`sid` es la coordinadora designada y viva? Sólo ella da el «arrancá» y reserva el turno.
function coordinatorSession({ home, env, arnes, sid }) {
  const role = coordinator({ home, env, arnes });
  if (!role) return { role: null, why: 'no hay coordinadora designada y viva en esta máquina' };
  const d = designacionVigente({ home });
  if (!d || d.error || d.sesion !== sid) return { role, why: `sólo la ${role} da el «arrancá» o reserva el turno` };
  return { role, why: null };
}

/** La sesión viva que nombra `to`: su id entero, el comienzo de su id (8 o más) o su nombre. `{ sid }` o `{ error }`. */
function resolveSession(home, to) {
  const all = [...sessionsBySid(path.join(claudeDir(home), 'sessions'), [], null)].filter(([, s]) => s.alive);
  const key = String(to || '').trim();
  if (!key) return { error: 'falta --to <sesión>' };
  const exact = all.find(([sid]) => sid === key);
  if (exact) return { sid: exact[0] };
  const hits = all.filter(([sid, s]) => (key.length >= 8 && sid.startsWith(key)) || (s.name && s.name === key));
  if (hits.length === 1) return { sid: hits[0][0] };
  if (hits.length > 1) return { error: `«${oneLine(key)}» nombra a ${hits.length} sesiones vivas: pasá su id` };
  return { error: `ninguna sesión viva se llama «${oneLine(key)}»` };
}

/** El «arrancá» de la coordinadora para `to`: `{ ok, code, message }` (code 2 = no se puede dar). */
function grant({ home = require('os').homedir(), env = process.env, arnes, to, now = Date.now() } = {}) {
  const by = env.CLAUDE_CODE_SESSION_ID || env.CODEX_SESSION_ID || null;
  const c = coordinatorSession({ home, env, arnes, sid: by });
  if (c.why) return { ok: false, code: 2, message: c.why };
  const r = resolveSession(home, to);
  if (r.error) return { ok: false, code: 2, message: r.error };
  writeWhole(grantFile(home), { to: r.sid, by, at: now });
  return { ok: true, code: 0, message: `«arrancá» para ${sessionName(home, r.sid)}: el turno libre es suyo por ${GRANT_MS / 60000} min` };
}

/** La reserva del turno para «what» (revisores, un pase): `{ ok, code, message }`; 77 si corre una ejecución grande. */
function reserve({ home = require('os').homedir(), env = process.env, arnes, what, to, now = Date.now() } = {}) {
  const sid = env.CLAUDE_CODE_SESSION_ID || env.CODEX_SESSION_ID || null;
  const c = coordinatorSession({ home, env, arnes, sid });
  if (c.why) return { ok: false, code: 2, message: c.why };
  if (!oneLine(what)) return { ok: false, code: 2, message: 'falta --for "<qué>"' };
  // `--to <sesión>`: la sesión que lanza lo reservado (su pase en modo ágil; agile-pass-turn.js la reconoce por esto)
  const para = to == null ? null : resolveSession(home, to);
  if (para && para.error) return { ok: false, code: 2, message: para.error };
  const running = holders({ home, now });
  if (running.length) return { ok: false, code: BUSY_EXIT, message: `No reservo: ya corre ${running.map(describe).join(' y ')}. La reserva no la pisa: esperá que termine.` };
  writeWhole(reserveFile(home), { sid, session: sessionName(home, sid), what: oneLine(what), at: now, ...(para ? { to: para.sid, toSession: sessionName(home, para.sid) } : {}) });
  return { ok: true, code: 0, message: `turno reservado para «${oneLine(what)}»${para ? ` de ${sessionName(home, para.sid)}` : ''} hasta release --reserve, o ${RESERVE_MS / 60000} min` };
}

/** Suelta la reserva; la suelta la coordinadora o la sesión que la puso. */
function releaseReserve({ home = require('os').homedir(), env = process.env, arnes } = {}) {
  const sid = env.CLAUDE_CODE_SESSION_ID || env.CODEX_SESSION_ID || null;
  const r = readTurn(reserveFile(home));
  if (!r) return false;
  if (r.sid !== sid && coordinatorSession({ home, env, arnes, sid }).why) return false;
  try { fs.unlinkSync(reserveFile(home)); return true; } catch { return false; }
}

const gatesDirIn = (state) => path.join(state, 'coordination', 'gates');
const gatesDir = (home) => gatesDirIn(stateDir(home));

/**
 * Un portón que corre sin el turno: borra la espera de su sesión y, con coordinadora, se anota. `{ file, error }`: `file`
 * es lo anotado (null sin coordinadora); `error`, por qué no se pudo anotar. No poder anotarlo no frena el portón, pero
 * se dice: sin la anotación, la fila pediría el «arrancá» encima de él.
 */
function gateStarted({ home = require('os').homedir(), env = process.env, arnes, pid = process.pid, what, suites, now = Date.now() } = {}) {
  const sid = env.CLAUDE_CODE_SESSION_ID || env.CODEX_SESSION_ID || null;
  clearWait(home, sid);
  if (!coordinator({ home, env, arnes })) return { file: null, error: null };
  const file = path.join(gatesDir(home), `${pid}.json`);
  // entera y de una, como el turno: escrita directo, se vería vacía mientras se escribe
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ pid, sid, session: sessionName(home, sid), what: oneLine(what) || 'portón acotado', ...(Number.isInteger(suites) ? { suites } : {}), at: now }));
    fs.renameSync(tmp, file);
    return { file, error: null };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* no quedó */ }
    return { file: null, error: e.code || oneLine(e.message) };
  }
}

/** Borra la anotación del portón de `pid`. */
function gateEnded({ home = require('os').homedir(), pid = process.pid } = {}) {
  try { fs.unlinkSync(path.join(gatesDir(home), `${pid}.json`)); } catch { /* no estaba */ }
}

/**
 * Los portones sin turno que corren: `[{ pid, sid, session, what, at }]`, del más viejo al más nuevo. Los de un proceso
 * que ya no vive, o de más de TURN_MAX_MS, se descartan (y se borran). Con `problems`, la carpeta que no se lee se anota.
 */
function gatesRunning({ home = require('os').homedir(), now = Date.now(), problems = null } = {}) {
  const dir = gatesDir(home);
  let names;
  try { names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)); } catch (e) {
    if (e.code !== 'ENOENT' && problems) problems.push(`los portones en curso (${dir}) no se pueden leer (${e.code || oneLine(e.message)})`);
    return [];
  }
  const out = [];
  for (const n of names) {
    const t = readTurn(path.join(dir, n));
    if (inForce(t, now)) out.push(t);
    // una que no se pudo leer de un proceso vivo puede estar a medio publicar: se deja, y la próxima lectura la ve
    else if (!t && alive(Number(n.split('.')[0]))) continue;
    else { try { fs.unlinkSync(path.join(dir, n)); } catch { /* otro lo borró */ } }
  }
  return out.sort((a, b) => a.at - b.at);
}

// La espera anotada (`marker.js doing --waiting-for`) que es de un turno de prueba pesada: la de la suite, la del portón o
// la del turno. La de un pase no: su lugar lo dice el marcador del pase, no este registro.
const TURN_WAIT = /suite|port[oó]n|turno/i;
const PASS_WAIT = /pase|adversarial/i;
const isTurnWait = (text) => typeof text === 'string' && TURN_WAIT.test(text) && !PASS_WAIT.test(text);

/**
 * Las sesiones que corren ahora una prueba pesada según el registro de turnos: la de cada lugar del turno y la de cada
 * portón anotado, vivos. La espera de turno que anotó una de ellas quedó vieja (la anotó después de arrancar, o nadie la
 * borró): quien lee la nota prefiere este registro. Sólo lee, desde la carpeta de estado `state`; con `problems`, lo que
 * no se puede leer se anota ahí.
 */
function runningSids({ state, now = Date.now(), problems = null } = {}) {
  const out = new Set();
  const add = (t) => { if (inForce(t, now) && t.sid) out.add(String(t.sid)); };
  for (const f of slotFilesIn(state)) add(readSlot(f, problems).turn);
  const dir = gatesDirIn(state);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)); } catch (e) {
    if (e.code !== 'ENOENT' && problems) problems.push(`los portones en curso (${dir}) no se pueden leer (${e.code || oneLine(e.message)})`);
  }
  // un portón ilegible deja a su sesión con la espera de la nota: se dice, como el lugar del turno que no se lee
  for (const n of names) add(readSlot(path.join(dir, n), problems).turn);
  return out;
}

/**
 * Cuántas suites corre un portón anotado: el campo `suites`, o el número con que empieza su `what` («N suites de …», como
 * lo arma run-suites-json.js). Cualquier otra cosa es null: no se sabe, y quien decide lo cuenta como largo.
 */
function suitesOf(g) {
  if (g && Number.isInteger(g.suites)) return g.suites;
  const m = /^(\d+) suites de /.exec(String((g && g.what) || ''));
  return m ? Number(m[1]) : null;
}

// Los portones en curso para decidir al lado del pase: la carpeta que no se lee no frena, pero se dice.
function gatesRead({ home, now }) {
  const problems = [];
  const out = gatesRunning({ home, now, problems });
  if (problems.length) process.stderr.write(`heavy-turn: no pude ver los portones en curso (${oneLine(problems.join(' · '))}): lo que no leí no frena\n`);
  return out;
}

const describeGate = (g) => `${oneLine(g.session) || 'una sesión sin nombre'} (${suitesOf(g) == null ? 'sin cantidad conocida de' : suitesOf(g)} suites, desde las ${hhmm(g.at)})`;

/**
 * La memoria libre del sistema, en porcentaje: `{ pct, why }`, con `pct` null y el motivo cuando no se puede leer. En macOS,
 * «System-wide memory free percentage» de `memory_pressure -Q`; en Linux, `MemAvailable` sobre `MemTotal`. En otro
 * sistema no se mide.
 */
function freeMemory({ platform = process.platform, run, readFile } = {}) {
  try {
    if (platform === 'darwin') {
      const text = (run || (() => require('child_process').execFileSync('memory_pressure', ['-Q'], { encoding: 'utf8', timeout: 5000, windowsHide: true })))();
      const m = /memory free percentage:\s*(\d+)\s*%/i.exec(String(text));
      return m ? { pct: Number(m[1]), why: null } : { pct: null, why: 'memory_pressure no dio el porcentaje' };
    }
    if (platform === 'linux') {
      const text = String((readFile || ((p) => fs.readFileSync(p, 'utf8')))('/proc/meminfo'));
      const kb = (k) => { const m = new RegExp(`^${k}:\\s*(\\d+)\\s*kB`, 'm').exec(text); return m ? Number(m[1]) : null; };
      const total = kb('MemTotal');
      const avail = kb('MemAvailable');
      return total && avail != null ? { pct: Math.round((avail / total) * 100), why: null } : { pct: null, why: '/proc/meminfo no trae MemTotal y MemAvailable' };
    }
    return { pct: null, why: `no sé medirla en ${platform}` };
  } catch (e) { return { pct: null, why: oneLine(e.message) }; }
}

/**
 * La memoria de intercambio libre, en porcentaje: `{ pct, why, none }`. Es lo que se acaba antes de que Claude Code cierre
 * sesiones quietas, aunque la memoria libre del sistema parezca de sobra. En macOS, `sysctl vm.swapusage`; sin
 * intercambio en uso (total 0), `none: true` y `pct` null. En otro sistema no se mide: `pct` null con el motivo.
 */
function swapFree({ platform = process.platform, run } = {}) {
  if (platform !== 'darwin') return { pct: null, why: `no sé medirla en ${platform}`, none: false };
  try {
    // con el idioma fijo: en castellano, sysctl escribe el decimal con coma («7168,00M»); igual se aceptan las dos formas
    const text = String((run || (() => require('child_process').execFileSync('sysctl', ['vm.swapusage'], { encoding: 'utf8', timeout: 5000, windowsHide: true, env: require('../lib/clean-git-env.js').idiomaFijo(process.env) })))());
    const mb = (k) => { const m = new RegExp(`${k}\\s*=\\s*(\\d+(?:[.,]\\d+)?)([KMGT])`, 'i').exec(text); return m ? Number(m[1].replace(',', '.')) * ({ K: 1 / 1024, M: 1, G: 1024, T: 1048576 }[m[2].toUpperCase()]) : null; };
    const total = mb('total');
    const free = mb('free');
    if (total == null || free == null) return { pct: null, why: 'sysctl vm.swapusage no dio el total y lo libre', none: false };
    if (total === 0) return { pct: null, why: 'sin memoria de intercambio en uso', none: true };
    // hacia abajo: un 14,6 % libre es menos del 15 %, y redondeado diría 15 y no avisaría
    return { pct: Math.floor((free / total) * 100), why: null, none: false };
  } catch (e) { return { pct: null, why: oneLine(e.message), none: false }; }
}

/**
 * Los procesos del usuario contra su tope: `{ used, max, pct, why }`. Con el tope no arranca ningún comando, ni los
 * ganchos ni los frenos. En macOS, `sysctl -n kern.maxprocperuid` y `ps -U <uid>`; `run(cmd, args)` reemplaza la consola
 * en las pruebas. En otro sistema no se mide: `pct` null con el motivo.
 */
function userProcs({ platform = process.platform, run, uid = typeof process.getuid === 'function' ? process.getuid() : null } = {}) {
  const none = (why) => ({ used: null, max: null, pct: null, why });
  if (platform !== 'darwin') return none(`no sé medirlos en ${platform}`);
  try {
    const exec = run || ((cmd, args) => require('child_process').execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, windowsHide: true }));
    const max = Number(String(exec('sysctl', ['-n', 'kern.maxprocperuid'])).trim());
    if (!Number.isInteger(max) || max <= 0) return none('sysctl kern.maxprocperuid no dio un número');
    const used = String(exec('ps', ['-U', String(uid), '-o', 'pid='])).split('\n').filter((l) => /^\s*\d+\s*$/.test(l)).length;
    if (!used) return none('ps no listó ningún proceso del usuario');
    // hacia abajo: un 69,9 % no es el 70 %
    return { used, max, pct: Math.floor((used / max) * 100), why: null };
  } catch (e) { return none(oneLine(e.message)); }
}

/**
 * Si un portón acotado de `suites` suites puede correr ahora: `{ ok, message, pass, note }`. Sin coordinadora, o sin un
 * pase en vuelo, sí, y la memoria no se mira. Con un pase en vuelo, sólo si son `BESIDE_PASS_MAX_SUITES` o menos, no
 * hay otro portón al lado y la memoria libre llega al piso. `pass` es el pase al lado, para la relectura.
 */
function besidePass({ home = require('os').homedir(), env = process.env, arnes, pid = process.pid, suites, now = Date.now(), readMemory = freeMemory } = {}) {
  const role = coordinator({ home, env, arnes });
  if (!role) return { ok: true, pass: null };
  const sid = env.CLAUDE_CODE_SESSION_ID || env.CODEX_SESSION_ID || null;
  const { pass, note } = passHolder({ home, env, now, sid });
  if (note) process.stderr.write(`heavy-turn: ${note}\n`);
  if (!pass) return { ok: true, pass: null, note };
  const what = `Hay un pase adversarial en vuelo en esta máquina: pase adversarial de la ${oneLine(pass.storyId) || 'sin story'} (${oneLine(pass.session)}, desde las ${hhmmIso(pass.since)})`;
  const tail = `Esperá su resultado, o pedile turno a la ${role} (guides/coordination.md, «Lo pesado, con turno»).`;
  if (!(Number.isInteger(suites) && suites <= BESIDE_PASS_MAX_SUITES)) {
    return { ok: false, pass, note, message: `${what}, y este portón corre ${Number.isInteger(suites) ? suites : 'una cantidad desconocida de'} suites: al lado del pase corre uno de ${BESIDE_PASS_MAX_SUITES} suites o menos. ${tail}` };
  }
  const others = gatesRead({ home, now }).filter((g) => Number(g.pid) !== pid);
  if (others.length) return { ok: false, pass, note, message: `${what}, y al lado ya corre otro portón: ${describeGate(others[0])}. Al lado del pase va uno solo: esperá que termine. ${tail}` };
  let mem;
  try { mem = readMemory(); } catch (e) { mem = { pct: null, why: oneLine(e.message) }; }
  if (!mem || mem.pct == null) process.stderr.write(`heavy-turn: no pude medir la memoria libre: ${oneLine(mem && mem.why) || 'sin motivo'}; no frena\n`);
  else if (mem.pct < BESIDE_PASS_MIN_FREE_PCT) return { ok: false, pass, note, message: `${what}, y la memoria libre está en ${mem.pct} %: al lado del pase se corre con ${BESIDE_PASS_MIN_FREE_PCT} % o más. ${tail}` };
  return { ok: true, pass, note };
}

/**
 * Después de anotarse al lado de un pase: sigue sólo el primero de los portones anotados (menor `at`; a igual hora, menor
 * proceso). El que pierde borra su registro y dice cuál sigue: `{ ok, message }`.
 */
function besideRecheck({ home = require('os').homedir(), pid = process.pid, now = Date.now() } = {}) {
  const all = gatesRead({ home, now });
  const mine = all.find((g) => Number(g.pid) === pid);
  if (!mine) return { ok: true };
  const first = all.filter((g) => g.at < mine.at || (g.at === mine.at && Number(g.pid) < pid))[0];
  if (!first) return { ok: true };
  gateEnded({ home, pid });
  return { ok: false, message: `Al lado del pase adversarial ya arrancó otro portón: ${describeGate(first)}. Al lado del pase va uno solo: esperá que termine (guides/coordination.md, «Lo pesado, con turno»).` };
}

/** Suelta el lugar del turno de `pid`, el que sea. El de otro proceso no se toca. */
function release({ home = require('os').homedir(), pid = process.pid } = {}) {
  let done = false;
  for (const file of slotFiles(home)) {
    const t = readTurn(file);
    if (!t || Number(t.pid) !== pid) continue;
    try { fs.unlinkSync(file); done = true; } catch (e) {
      // ya no está: otro lo sacó. Si está y no se pudo borrar, queda tomado hasta vencer: se dice
      if (e.code !== 'ENOENT') process.stderr.write(`heavy-turn: no pude soltar el lugar del turno ${file} (${e.code || oneLine(e.message)}): queda tomado hasta que el proceso termine o venza\n`);
    }
  }
  return done;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const val = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
  const pid = val('--process') !== undefined ? Number(val('--process')) : process.ppid;
  if ((cmd === 'take' || cmd === 'release') && !(Number.isInteger(pid) && pid > 0)) { process.stderr.write('heavy-turn.js: --process va con un número de proceso\n'); return 2; }
  if (cmd === 'take') {
    const r = take({ pid, what: val('--what') });
    if (!r.ok) process.stderr.write(`${r.message}\n`);
    return r.ok ? 0 : BUSY_EXIT;
  }
  if (cmd === 'release' && rest.includes('--reserve')) {
    const done = releaseReserve();
    process.stdout.write(done ? 'reserva suelta\n' : 'no había reserva tuya que soltar\n');
    return 0;
  }
  if (cmd === 'release') { release({ pid }); return 0; }
  if (cmd === 'grant' || cmd === 'reserve') {
    // `--to` sin su sesión (al final, o seguido de otra opción) no es «sin --to»: falla en vez de reservar sin sesión
    const toOf = () => (rest.includes('--to') ? (/^--/.test(val('--to') || '--') ? '' : val('--to')) : undefined);
    const r = cmd === 'grant' ? grant({ to: val('--to') }) : reserve({ what: val('--for'), to: toOf() });
    (r.ok ? process.stdout : process.stderr).write(`${r.message}\n`);
    return r.code;
  }
  if (cmd === 'holder') {
    const t = holder();
    process.stdout.write(rest.includes('--json') ? `${JSON.stringify(t)}\n` : `${t ? describe(t) : 'nadie'}\n`);
    return 0;
  }
  if (cmd === 'holders') {
    const all = holders();
    process.stdout.write(rest.includes('--json') ? `${JSON.stringify(all)}\n` : `${all.length ? all.map(describe).join('\n') : 'nadie'}\n`);
    return 0;
  }
  process.stderr.write('uso: heavy-turn.js take --what <qué> [--process <pid>] | release [--process <pid>] | release --reserve | grant --to <sesión> | reserve --for "<qué>" | holder [--json] | holders [--json]\n');
  return 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { take, release, holder, holders, coordinator, secondTurnFloor, grant, reserve, releaseReserve, grantInForce, lastGrant, reserveInForce, readWait, swapFree, userProcs, GRANT_MS, RESERVE_MS, describe, turnFile, slotFiles, SECOND_HEAVY_MIN_FREE_PCT, clearWait, gateStarted, gateEnded, gatesRunning, runningSids, isTurnWait, besidePass, besideRecheck, freeMemory, suitesOf, describeGate, BUSY_EXIT, BESIDE_PASS_MAX_SUITES, BESIDE_PASS_MIN_FREE_PCT };
