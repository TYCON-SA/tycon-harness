'use strict';
/**
 * real-home-guard.js — la red de las pruebas que llaman código capaz de borrar: nada escribe ni borra en la casa real.
 *
 * Una suite la carga en su primera línea (`require('./lib/real-home-guard.js')`). Desde ahí, en ese proceso y en cada
 * `node` que lance con el ambiente heredado, todo intento de crear, escribir, mover o borrar adentro de las carpetas del
 * arnés y de las herramientas en la HOME de quien corre (`~/.tycon`, `~/.claude`, `~/.codex`, y `TYCON_HOME` si está)
 * se FRENA (tira EPERM) y queda anotado. La suite cierra con una prueba que exige `attempts()` vacío; si aun así queda
 * algo anotado al salir, el proceso termina en 1.
 *
 * Por qué frena Y anota: el código que borra suele tragarse el error (un `rmrf` con try/catch, un registro que «nunca
 * rompe el commit»), así que frenar solo deja la prueba verde. Y anotar sin frenar llega tarde: el caso que la motivó
 * fue una prueba de «deshacer la mudanza» con el ambiente vacío, que borró el arnés instalado.
 *
 * Lo que NO ve: procesos que no son node (git, bash) y un `node` lanzado con un ambiente armado a mano que no hereda
 * `NODE_OPTIONS`. Para eso está la HOME de juguete de cada caso; esta red atrapa cuando la HOME de juguete falta.
 *
 * Las raíces se fijan UNA vez, en el primer proceso, y viajan por el ambiente: un hijo con `HOME` de juguete no las
 * vuelve a calcular (frenaría su propio laboratorio).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');

const ROOTS_VAR = 'TYCON_REAL_HOME_GUARD_ROOTS';
const LOG_VAR = 'TYCON_REAL_HOME_GUARD_LOG';
const FOLD = process.platform === 'darwin' || process.platform === 'win32';   // discos que no distinguen mayúsculas
const fold = (p) => (FOLD ? p.toLowerCase() : p);

// los originales, antes de envolver nada: la red los usa para leer y para anotar
const raw = { appendFileSync: fs.appendFileSync, readFileSync: fs.readFileSync, rmSync: fs.rmSync, realpathSync: fs.realpathSync };
const realOrSelf = (p) => { try { return raw.realpathSync(p); } catch (_) { return p; } };

const OWNER = !process.env[ROOTS_VAR];
if (OWNER) {
  const home = os.homedir();
  const named = [path.join(home, '.tycon'), path.join(home, '.claude'), path.join(home, '.codex')];
  const asked = String(process.env.TYCON_HOME || '').trim();
  if (asked && path.isAbsolute(asked)) named.push(asked);
  // la ruta como se escribe y la real (una HOME detrás de un enlace): las dos cuentan
  process.env[ROOTS_VAR] = JSON.stringify([...new Set(named.flatMap((p) => [path.resolve(p), realOrSelf(p)]))]);
  process.env[LOG_VAR] = path.join(os.tmpdir(), `tycon-real-home-guard-${process.pid}-${Date.now()}.jsonl`);
  // los `node` que la suite lance con el ambiente heredado cargan la misma red (comillas: una ruta con espacios)
  const self = `--require "${__filename.replace(/\\/g, '/')}"`;
  if (!String(process.env.NODE_OPTIONS || '').includes(self)) process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} ${self}`.trim();
}
const ROOTS = JSON.parse(process.env[ROOTS_VAR]).map(fold);
const LOG = process.env[LOG_VAR];

const asPath = (p) => {
  if (typeof p === 'string') return p;
  if (Buffer.isBuffer(p)) return p.toString();
  if (p instanceof URL) { try { return fileURLToPath(p); } catch (_) { return null; } }
  return null;   // un descriptor ya abierto: lo frenó (o no) quien lo abrió
};
const under = (p) => { const a = fold(p); return ROOTS.some((r) => a === r || a.startsWith(r + path.sep)); };
/** ¿La ruta cae en la casa real? Se mira como se escribió y por su carpeta real (un enlace en el camino). */
function hits(p, { follow = false } = {}) {
  const s = asPath(p);
  if (!s) return false;
  const abs = path.resolve(s);
  if (under(abs)) return true;
  // la carpeta real del primer ancestro que existe; el último tramo no se sigue al borrar o mover (se toca el enlace, no
  // su destino) y sí al escribir (se escribe a través de él)
  let base = follow ? abs : path.dirname(abs);
  const rest = follow ? [] : [path.basename(abs)];
  for (;;) {
    let r = null;
    try { r = raw.realpathSync(base); } catch (_) { r = null; }
    if (r) return under(path.join(r, ...rest));
    const up = path.dirname(base);
    if (up === base) return false;
    rest.unshift(path.basename(base)); base = up;
  }
}
function refuse(fn, targets) {
  const where = (new Error().stack || '').split('\n').slice(3, 8).map((l) => l.trim());
  try { raw.appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, fn, targets, argv: process.argv.slice(1, 4), stack: where })}\n`); } catch (_) { /* sin registro igual frena */ }
  const e = new Error(`real-home-guard: ${fn} sobre la casa real, frenado: ${targets.join(' → ')}`);
  e.code = 'EPERM';
  return e;
}

// qué argumentos son un destino, y si el último tramo se sigue (escribir) o no (borrar, mover, crear)
const REMOVE = { args: [0], follow: false };
const WRITE = { args: [0], follow: true };
const BOTH = { args: [0, 1], follow: false };
const SECOND = { args: [1], follow: false };
const OPS = {
  rm: REMOVE, rmdir: REMOVE, unlink: REMOVE, mkdir: REMOVE, mkdtemp: REMOVE,
  rename: BOTH, symlink: SECOND, link: SECOND, cp: { args: [1], follow: true }, copyFile: { args: [1], follow: true },
  writeFile: WRITE, appendFile: WRITE, truncate: WRITE, chmod: WRITE, chown: WRITE, utimes: WRITE,
};
const writesByFlags = (flags) => (typeof flags === 'number'
  ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0
  : /[wa+]/.test(String(flags === undefined || flags === null ? 'r' : flags)));
const blockedBy = (name, args) => {
  if (name === 'open') return writesByFlags(args[1]) && hits(args[0], { follow: true }) ? [asPath(args[0])] : null;
  const op = OPS[name];
  const bad = op.args.map((i) => args[i]).filter((a) => hits(a, { follow: op.follow })).map(asPath);
  return bad.length ? bad : null;
};

function wrap(target, name, kind) {
  const key = kind === 'sync' ? `${name}Sync` : name;
  const orig = target[key];
  if (typeof orig !== 'function') return;
  target[key] = function guarded(...args) {
    const bad = blockedBy(name, args);
    if (!bad) return orig.apply(this, args);
    const e = refuse(key, bad);
    if (kind === 'sync') throw e;
    if (kind === 'promise') return Promise.reject(e);
    const cb = args[args.length - 1];
    if (typeof cb === 'function') { process.nextTick(cb, e); return undefined; }
    throw e;
  };
}
if (!fs.__realHomeGuard) {
  Object.defineProperty(fs, '__realHomeGuard', { value: true });
  for (const name of [...Object.keys(OPS), 'open']) { wrap(fs, name, 'sync'); wrap(fs, name, 'callback'); wrap(fs.promises, name, 'promise'); }
  const stream = fs.createWriteStream;
  fs.createWriteStream = function guarded(p, ...rest) {
    if (hits(p, { follow: true })) throw refuse('createWriteStream', [asPath(p)]);
    return stream.call(this, p, ...rest);
  };
}

/** Lo anotado hasta ahora, por este proceso y por los `node` que lanzó. */
function attempts() {
  let text = '';
  try { text = raw.readFileSync(LOG, 'utf8'); } catch (_) { return []; }
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return { fn: '?', targets: [l] }; } });
}
/** Una línea por intento, para el mensaje de la prueba que cierra la suite. */
const describe = (list = attempts()) => list.map((a) => `${a.fn} ${(a.targets || []).join(' → ')}${a.stack && a.stack[0] ? ` — ${a.stack.slice(0, 2).join(' ← ')}` : ''}`).join('\n');

if (OWNER) {
  process.on('exit', () => {
    const left = attempts();
    try { raw.rmSync(LOG, { force: true }); } catch (_) { /* queda en el temporal */ }
    if (!left.length) return;
    process.stderr.write(`❌ real-home-guard: ${left.length} intento(s) de escribir o borrar en la casa real (frenados):\n${describe(left)}\n`);
    if (!process.exitCode) process.exitCode = 1;
  });
}

module.exports = { attempts, describe, roots: () => JSON.parse(process.env[ROOTS_VAR]), ROOTS_VAR, LOG_VAR };
