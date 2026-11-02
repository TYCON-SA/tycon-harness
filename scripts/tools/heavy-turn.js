#!/usr/bin/env node
'use strict';
/*
 * heavy-turn.js — el turno de la suite completa en una máquina con coordinadora (guides/coordination.md).
 *
 * En la máquina corre una suite completa por vez: dos a la vez la saturan. Una suite completa y un pase adversarial o una
 * tanda de revisores de otra sesión sí pueden ir juntos (corren en la nube). El corredor de la suite toma el turno al
 * arrancar y lo suelta al terminar; con el turno tomado por otro proceso vivo, no arranca y dice quién lo tiene.
 *
 *   take --what <qué corre> [--process <pid>]   0 = turno tomado (o no hay coordinadora) · 77 = lo tiene otro, y dice quién
 *   release [--process <pid>]                   suelta el turno si es de ese proceso; el de otro no lo toca
 *   holder [--json]                         quién lo tiene ahora, o nadie
 *
 * Sin coordinadora designada y viva (la nube, la CI, una máquina sin coordinar) no se toma nada y todo corre como
 * siempre: el mismo criterio que el turno del pase (`adversarialTurn` de coordination.js). Un turno cuyo proceso ya no
 * vive (una suite cortada con kill -9), o de más de tres horas, se libera solo. El registro vive en `<estado>/coordination/suite-turn.json`.
 * Off: TYCON_SUITE_TURN=0. Con TYCON_SUITE_TURN=1 se pide el turno aunque no haya coordinadora (sólo puede frenar de más:
 * es lo que usan las pruebas, que no pueden designar una coordinadora en el perfil del árbol).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SKILL_LIB = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib');
const { stateDir, claudeDir } = require(path.join(SKILL_LIB, 'state-dir.js'));
const { sesionQueReenvia, designacionVigente } = require(path.join(SKILL_LIB, 'critical-waivers.js'));
const { sessionsBySid } = require('./work-in-progress.js');

// Las portables tardan cerca de una hora: tres ya no es una suite que corre.
const TURN_MAX_MS = 3 * 3600000;
// El 75 del portón de pruebas es de `run-check`, que reescribe el de un hijo como rojo: el turno tiene su propio código, y
// test-gate.sh lo da como su 75 («otra corrida en marcha, esperá»; steps/step-06-run-tests.md).
const BUSY_EXIT = 77;
const EVICT_LOCK_MS = 10000;
const turnFile = (home) => path.join(stateDir(home), 'coordination', 'suite-turn.json');
const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').replace(/[\p{Cc}\p{Cf}<>]/gu, '').trim().slice(0, 80);
const hhmm = (ms) => { const d = new Date(ms); return Number.isNaN(d.getTime()) ? '?' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const alive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// El rol sale del perfil del equipo, que viaja con el arnés instalado. Un clon de trabajo del repo público no lo trae: se
// pregunta primero al árbol de este archivo y, sin respuesta, al instalado. Esta lectura sólo puede prender un freno.
function roleOf({ home, env, arnes }) {
  const own = sesionQueReenvia({ env, home, ...(arnes ? { arnes } : {}) });
  if (own.valor || arnes) return own.valor;
  try {
    const { harnessDir } = require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'));
    return sesionQueReenvia({ env, home, arnes: harnessDir(home) }).valor;
  } catch { return null; }
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

/** El turno vigente: `{ pid, sid, session, what, at }`, o null. */
function holder({ home = require('os').homedir(), now = Date.now() } = {}) {
  const t = readTurn(turnFile(home));
  return inForce(t, now) ? t : null;
}

function sessionName(home, sid) {
  if (!sid) return null;
  const s = sessionsBySid(path.join(claudeDir(home), 'sessions'), [], null).get(sid);
  return (s && s.name && oneLine(s.name)) || String(sid).slice(0, 8);
}

// Lo que dice el registro se sanea al leerlo: el archivo queda en la carpeta del estado y su texto llega al contexto de un agente.
const describe = (t) => `${oneLine(t.session) || 'una sesión sin nombre'} (${oneLine(t.what) || 'suite completa'}, desde las ${hhmm(t.at)})`;

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

/** Toma el turno para `pid`. `{ ok, taken, message }`: ok false = lo tiene otro proceso vivo, y el mensaje dice quién. */
function take({ home = require('os').homedir(), env = process.env, arnes, pid = process.pid, what, now = Date.now() } = {}) {
  const role = coordinator({ home, env, arnes });
  if (!role) return { ok: true, taken: false, message: null };
  const file = turnFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sid = env.CLAUDE_CODE_SESSION_ID || env.CODEX_SESSION_ID || null;
  const mine = { pid, sid, session: sessionName(home, sid), what: oneLine(what) || 'suite completa', at: now };
  // unos pocos intentos: entre sacar un turno vencido y publicar el propio puede entrar otro, o estar sacándolo otro
  for (let i = 0; i < 20; i += 1) {
    if (i) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    if (publish(file, mine)) return { ok: true, taken: true, message: null };
    const t = readTurn(file);
    if (inForce(t, now)) {
      if (Number(t.pid) === pid) return { ok: true, taken: true, message: null };
      return { ok: false, taken: false, holder: t, message: `Ya corre una suite completa en esta máquina: ${describe(t)}. Va una por vez (guides/coordination.md, «Lo pesado, con turno»): esperá que termine, o pedile turno a la ${role}. Si quedó colgada, se destraba con heavy-turn.js release --process ${Number(t.pid)}.` };
    }
    evict(file, now);
  }
  return { ok: false, taken: false, message: `No pude tomar el turno de la suite completa (${file} vuelve a aparecer): no la corrí.` };
}

/** Suelta el turno si es de `pid`. El de otro proceso no se toca. */
function release({ home = require('os').homedir(), pid = process.pid } = {}) {
  const file = turnFile(home);
  let t;
  try { t = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
  if (!t || Number(t.pid) !== pid) return false;
  try { fs.unlinkSync(file); return true; } catch { return false; }
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
  if (cmd === 'release') { release({ pid }); return 0; }
  if (cmd === 'holder') {
    const t = holder();
    process.stdout.write(rest.includes('--json') ? `${JSON.stringify(t)}\n` : `${t ? describe(t) : 'nadie'}\n`);
    return 0;
  }
  process.stderr.write('uso: heavy-turn.js take --what <qué> [--process <pid>] | release [--process <pid>] | holder [--json]\n');
  return 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { take, release, holder, describe, turnFile, BUSY_EXIT };
