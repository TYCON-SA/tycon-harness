#!/usr/bin/env node
/**
 * guard-auto-update.js — al abrir la sesión, lanza la actualización del freno de producción sin contraseña cuando
 * corresponde. Casos: scripts/tests/guard-auto-update.test.js y update-guard.test.sh (T29).
 *
 * POR QUÉ EXISTE: `install-guard.sh --allow-auto-update` deja un permiso de sudo para `/opt/tycon/setup/update-guard.sh`,
 * pero nada lo corría: el freno quedaba viejo hasta que la persona lo reinstalaba con su contraseña.
 *
 * CUÁNDO LANZA: con `/opt/tycon` (Mac; en Windows no hay), la marca de root del permiso
 * (`/opt/tycon/production/auto-update.json`), `guard.update: auto` en el perfil del equipo, una versión bajada
 * (`~/.tycon/harness`, con su manifiesto) distinta de la instalada (`production/installed-release.json`), y sin una falla
 * anotada de esa misma versión en `production/update-log.jsonl` (no reintenta hasta que llegue otra).
 *
 * CÓMO: `sudo -n /opt/tycon/setup/update-guard.sh` como proceso aparte, sin esperarlo, con su salida a un registro de la
 * carpeta de estado. Un gancho corre fuera de la terminal de la sesión, así que un freno instalado que frena todo no lo
 * frena: la versión arreglada se instala sola (salvo que cambie el intérprete, el lanzador o la puerta, que piden la
 * contraseña). Nunca bloquea ni cambia nada él mismo: sale 0. Off: TYCON_GUARD_AUTO_UPDATE=0.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ARBOL = path.resolve(__dirname, '..', '..');

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// `{ valor: 'auto' | 'password' }`, o `{ error }` si no se pudo leer: «no pude leer» no es «la organización no eligió».
function guardUpdate(arnes, home) {
  try {
    const c = require(path.join(ARBOL, 'scripts', 'lib', 'tycon-config.js')).cargar({ env: {}, arnes, home });
    const roto = (c.errores || []).find((e) => e.clave === 'guard.update' || !e.clave);
    if (roto) return { error: roto.mensaje || roto.motivo || String(roto.clave || 'la configuración') };
    return { valor: c.valores.guard && c.valores.guard.update === 'auto' ? 'auto' : 'password' };
  } catch (e) { return { error: e.message }; }
}

// El juicio del aviso de arranque: ¿el freno instalado quedó viejo contra el arnés que corre? Lanza si no pudo compararlo.
function frenoViejo() {
  const j = require(path.join(ARBOL, 'scripts', 'hooks', 'production-notice.js')).juzgar({ soloLeer: true });
  if (!j || j.autorizada === false) throw new Error('el aviso de arranque no juzgó esta máquina');
  return j.viejo === true;
}

const msDe = (at) => { const t = Date.parse(at); return Number.isFinite(t) ? t : NaN; };

/** ¿Corresponde lanzar? `{ launch, reason, version }`. `root` es la raíz del sistema (en pruebas, una falsa). */
function decide(opts = {}) {
  const { root = '/', home = os.homedir(), arnes } = opts;
  const opt = path.join(root, 'opt', 'tycon');
  const prod = path.join(opt, 'production');
  if (!fs.existsSync(opt)) return { launch: false, reason: 'sin /opt/tycon: esta máquina no tiene el freno' };
  if (!fs.existsSync(path.join(prod, 'auto-update.json'))) return { launch: false, reason: 'sin el permiso de actualizarse sola' };
  const corre = path.resolve(arnes || path.join(home, '.tycon', 'harness'));
  const eleccion = guardUpdate(corre, home);
  if (eleccion.error) return { launch: false, problema: true, reason: `no pude leer si la organización eligió que se actualice sola (${eleccion.error})` };
  if (eleccion.valor !== 'auto') return { launch: false, reason: 'la organización no eligió que se actualice sola' };
  const rel = readJson(path.join(corre, '.tycon-release.json'));
  if (!rel || typeof rel.commit !== 'string') return { launch: false, reason: 'el arnés que corre no es una versión bajada' };
  const inst = readJson(path.join(prod, 'installed-release.json'));
  if (inst && inst.commit === rel.commit) return { launch: false, reason: 'el freno está al día' };
  const version = typeof rel.version === 'string' ? rel.version : null;
  // otra versión del arnés no es un freno viejo: se lanza sólo si el aviso de arranque lo juzga viejo
  try {
    if (!(opts.isStale || frenoViejo)()) return { launch: false, reason: 'el freno está al día: la versión que corre no lo cambia', version };
  } catch (e) {
    return { launch: false, problema: true, reason: `no pude saber si el freno quedó viejo (${e.message}): no lanzo nada`, version };
  }
  // la bajada de la versión que corre: una falla sin versión anotada después de ella es de esta versión
  const bajada = msDe(rel.downloaded_at);
  const log = (() => { try { return fs.readFileSync(path.join(prod, 'update-log.jsonl'), 'utf8').split('\n').filter((l) => l.trim()); } catch { return []; } })();
  for (let i = log.length - 1; i >= 0; i--) {
    let r;
    try { r = JSON.parse(log[i]); } catch { continue; }
    if (!r || typeof r !== 'object') continue;
    // una actualización buena después de la falla: ésa ya no cuenta
    if (r.to_version) break;
    if (r.status !== 'failed') continue;
    if (version && r.attempted_version === version) return { launch: false, reason: `la versión ${version} ya falló (${r.reason || 'sin motivo'}): espero otra`, version };
    // una falla antes de saber la versión (sin origen fijado, sin estado, una copia que falló): si es posterior a la
    // bajada de la que corre, fue con ésta, y relanzarla en cada sesión falla igual
    if (!r.attempted_version && Number.isFinite(bajada) && msDe(r.at) >= bajada) {
      return { launch: false, reason: `la actualización a ${version || 'la versión que corre'} ya falló (${r.reason || 'sin motivo'}): espero otra`, version };
    }
  }
  return { launch: true, reason: `el freno quedó viejo: lanzo la actualización a ${version || 'la versión que corre'}`, version };
}

/** Lanza la actualización si corresponde, sin esperarla. Devuelve lo que decidió. */
function run(opts = {}) {
  const d = decide(opts);
  if (!d.launch) return d;
  const root = opts.root || '/';
  const logDir = opts.logDir || logDirDe(opts.home || os.homedir());
  let out = 'ignore';
  try {
    fs.mkdirSync(logDir, { recursive: true });
    out = fs.openSync(path.join(logDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.log`), 'a');
  } catch (e) { d.sinRegistro = e.code || e.message; }
  // `exit=N` al final del registro: si sudo no arranca (pide contraseña, falta la regla), el aviso de arranque lo lee
  const child = spawn('/bin/sh', ['-c', '"$0" -n "$1"; echo "exit=$?"', opts.sudo || 'sudo', path.join(root, 'opt', 'tycon', 'setup', 'update-guard.sh')], {
    detached: true, stdio: ['ignore', out, out], env: opts.env || process.env, cwd: '/', windowsHide: true,
  });
  child.on('error', () => { /* sin sh: el registro queda sin `exit=` y el aviso no da la actualización por arrancada */ });
  child.unref();
  if (typeof out === 'number') { try { fs.closeSync(out); } catch { /* nada */ } }
  return d;
}

/** La carpeta de los registros del gancho: la lee también el aviso de arranque (guard-update-notice.js). */
function logDirDe(home) {
  return path.join(require(path.join(ARBOL, 'scripts', 'setup', 'harness', 'tycon-home.js')).stateDir(home), 'guard-auto-update');
}

if (require.main === module) {
  try {
    if (process.env.TYCON_GUARD_AUTO_UPDATE !== '0' && process.env.TYCON_EVAL_SANDBOX !== '1') {
      const d = run({});
      if (d.launch) console.log(`ℹ️ freno de producción: ${d.reason} (sin contraseña, de fondo${d.sinRegistro ? `; sin registro de su salida: ${d.sinRegistro}` : ''}).`);
      else if (d.problema) console.log(`🟠 freno de producción: ${d.reason}.`);
    }
  } catch (e) {
    console.log(`🟠 freno de producción: no pude lanzar la actualización sin contraseña (${e.message}).`);
  }
  process.exit(0);
}

module.exports = { decide, run, logDirDe };
