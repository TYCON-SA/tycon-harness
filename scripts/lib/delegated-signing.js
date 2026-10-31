'use strict';

/**
 * delegated-signing.js — la delegación de firmas del dueño a la sesión designada.
 *
 * Lo que decide es `delegaSinVentana`: una firma de `approvals.delegated_signing`, fuera de `owner_only`, en una
 * máquina de `delegated_machines`, pedida por la sesión designada para otra sesión, corre sin ventana. La designación
 * vale sólo si el dueño la confirmó en su terminal (`confirm-designation`). Ninguna firma sale de una cita en la
 * conversación.
 *
 * Todo se lee de la casa de la cuenta (`real-home.js`), nunca de `HOME`, `USERPROFILE` ni de una variable `TYCON_*`:
 * el agente puede poner esas variables. Cada dependencia entra por parámetro.
 *
 * CLI:
 *   node delegated-signing.js confirm-designation   (lo corre el dueño en su terminal)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PIPELINE_LIB = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib');
const CONFIRMED = 'relay-designation-confirmed';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeSid = (s) => String(s).replace(/[/\\]/g, '_');

/** La casa de la cuenta: la inyectada, o la del sistema (nunca `HOME`). */
function accountHome({ home, userInfo } = {}) {
  if (home) return home;
  return require('./real-home.js').casaDeLaCuenta(userInfo ? { userInfo } : {});
}

/** Las rutas de la cuenta, sin mirar el ambiente: el estado en `~/.tycon/state` si existe, si no donde siempre. */
function accountPaths(home) {
  const own = path.join(home, '.tycon', 'state');
  let isOwn = false;
  // sólo «no existe» cae donde siempre; una carpeta que no se deja leer no se reemplaza por otra
  try { isOwn = fs.statSync(own).isDirectory(); } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw new Error(`no pude leer la carpeta de estado de la cuenta (${e.code || e.message})`);
  }
  // la de siempre la da tycon-home.js; su `stateDir` no sirve acá porque mira TYCON_HOME
  const state = isOwn ? own : require('../setup/harness/tycon-home.js').legacyStateDir(home);
  return { home, state, gates: path.join(state, 'gates.log'), tokens: path.join(state, 'signing-tokens') };
}

function readGates(p) {
  let raw;
  try { raw = fs.readFileSync(p.gates, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { lines: [] } : { error: `no pude leer el registro del arnés (${e.code || e.message})` }; }
  const lines = [];
  for (const l of raw.split('\n')) { if (!l.trim()) continue; try { lines.push(JSON.parse(l)); } catch (_) { /* un renglón roto no tapa a los demás */ } }
  return { lines };
}
function appendGatesLine(p, obj) {
  fs.mkdirSync(path.dirname(p.gates), { recursive: true });
  fs.appendFileSync(p.gates, `${JSON.stringify(obj)}\n`);
}

/** El renglón que deja `confirm-designation`: ata la confirmación a ESA designación (sesión, hora y frase). */
function confirmationRecord(designacion, ts) {
  return { name: CONFIRMED, status: 'ok', ts, sesion: designacion.sesion, designacion_ts: designacion.ts, cita_sha: sha(designacion.cita) };
}

/** La designación vigente, confirmada en la terminal del dueño: `{ ok, designacion }` o `{ ok:false, reason }`. */
function confirmedDesignation(p) {
  const cw = require(path.join(PIPELINE_LIB, 'critical-waivers.js'));
  const d = cw.designacionVigente({ dir: p.state });
  if (!d) return { ok: false, reason: 'ninguna sesión de esta máquina está designada para reenviar los ok del dueño' };
  if (d.error) return { ok: false, reason: d.error };
  const g = readGates(p);
  if (g.error) return { ok: false, reason: g.error };
  const want = confirmationRecord(d, null);
  const ok = g.lines.some((l) => l && l.name === CONFIRMED && l.status === 'ok' && l.sesion === want.sesion
    && l.designacion_ts === want.designacion_ts && l.cita_sha === want.cita_sha);
  if (!ok) return { ok: false, reason: 'la designación de la sesión no está confirmada en la terminal del dueño: que corra `node scripts/lib/delegated-signing.js confirm-designation` en su terminal' };
  return { ok: true, designacion: d };
}

/** Las listas de firmas del perfil, leídas con el lector de configuración. */
function profileLists({ env = process.env, home, arnes } = {}) {
  const r = require('./tycon-config.js').cargar({ env, home, ...(arnes ? { arnes } : {}) });
  // un archivo roto o una lista de firmas retirada por el validador no se lee como «sin owner_only»: sin la lista que
  // veta, la delegación no se decide
  const roto = (r.errores || []).find((e) => e.clave == null || /^approvals(\.|$)/.test(String(e.clave)));
  if (roto) throw new Error(`${roto.clave || roto.archivo}: ${roto.motivo}`);
  return { approvals: (r.valores && r.valores.approvals) || {} };
}

/**
 * ¿La firma `firma` corre sin ventana (AC 22-25)? `{ ok, motivo?, maquina? }`. Todas las llaves: el id en
 * `approvals.delegated_signing` (los grupos, expandidos) y no en `approvals.owner_only`; esta máquina en
 * `approvals.delegated_machines`; `sesion` es la designada y el dueño confirmó la designación; el destino no es `sesion`
 * ni la story de una ejecución abierta de `sesion`; en una firma sobre un repo (aprobar un pendiente), `repo` (relativo a
 * `cwd`, la carpeta del pedido) es de `destino` y no de `sesion`. `estado`: la carpeta del estado de la casa. Inyectables:
 * `perfil()` → las listas (`{ delegated_signing, owner_only, delegated_machines }`), `huella()` → `{ huella }` o `{ error }`.
 */
function delegaSinVentana({ firma, sesion, destino, home, estado, env, arnes, perfil, huella, repo, cwd, raiz = raizDelRepo } = {}) {
  const no = (motivo) => ({ ok: false, motivo });
  if (!sesion || !destino) return no('sin la sesión del pedido y la destino no se delega');
  // su constancia nombra al dueño en la huella: aunque el perfil la liste, no tiene vía delegada
  if (firma === 'adversarial-skip') return no('saltear el pase adversarial es sólo del dueño: no se delega');
  if (destino === sesion) {
    // la coordinadora que aprueba un pendiente sin nombrar la sesión que lo abrió ve por qué le toca la ventana
    if (SOBRE_UN_REPO.has(firma) && esLaDesignada(estado, sesion)) return no('un pendiente se aprueba por delegación con --for-session <la sesión que lo abrió>');
    return no('la sesión que implementa no se firma sola sin ventana');
  }
  let a;
  try {
    a = perfil ? perfil() : profileLists({ env, home, arnes }).approvals;
  } catch (e) { return no(`no pude leer el perfil del equipo (${e.message})`); }
  a = a || {};
  const cat = require('./signatures.js');
  // owner_only sólo restringe: ahí escape-phrases cubre también los escapes que el grupo no delega
  const ids = (v, o) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).flatMap((x) => cat.expand(x, o));
  const malFormada = ['owner_only', 'delegated_signing', 'delegated_machines'].find((k) => a[k] != null && !Array.isArray(a[k]) && !(k !== 'delegated_machines' && typeof a[k] === 'string'));
  if (malFormada) return no(`no pude leer approvals.${malFormada} del perfil: no es una lista`);
  if (ids(a.owner_only, { restringe: true }).includes(firma)) return no(`«${firma}» es sólo del dueño (approvals.owner_only)`);
  if (!ids(a.delegated_signing).includes(firma)) return no(`el perfil del equipo no delega «${firma}» (approvals.delegated_signing)`);
  let fp;
  try { fp = (huella || (() => require('./machine-id.js').huella()))(); } catch (e) { return no(`no pude leer la huella de esta máquina (${e.message})`); }
  if (!fp || fp.error || !fp.huella) return no(`no pude leer la huella de esta máquina: ${(fp && fp.error) || 'sin huella'}`);
  const maquinas = Array.isArray(a.delegated_machines) ? a.delegated_machines : [];
  if (!maquinas.some((m) => m && m.id === fp.huella)) return no('esta máquina no está en approvals.delegated_machines');
  const p = { state: estado, gates: path.join(estado, 'gates.log') };
  const d = confirmedDesignation(p);
  if (!d.ok) return no(d.reason);
  if (d.designacion.sesion !== sesion) return no('la sesión del pedido no es la designada');
  // la story del destino no puede ser la de una ejecución abierta de la sesión del pedido
  const storyDe = (sid) => { try { const m = JSON.parse(fs.readFileSync(path.join(estado, 'active', `${safeSid(sid)}.json`), 'utf8')); return m.storyId || m.storyPath || null; } catch (e) { return e.code === 'ENOENT' ? null : undefined; } };
  const propia = storyDe(sesion);
  if (propia === undefined) return no('no pude leer el marcador de la sesión del pedido');
  const suya = propia ? storyDe(destino) : null;
  if (suya === undefined) return no('no pude leer el marcador de la sesión destino');
  if (propia && suya === propia) return no('la sesión destino trabaja la misma story que la ejecución abierta de la sesión del pedido');
  if (SOBRE_UN_REPO.has(firma)) {
    const m = motivoDelRepo({ repo, cwd, estado, sesion, destino, raiz });
    if (m) return no(m);
  }
  return { ok: true, maquina: fp.huella };
}

// las firmas que actúan sobre un repo y no sobre la ejecución de una sesión: la delegación vale sólo sobre el repo de la
// sesión destino, y nunca sobre uno de la coordinadora (lo que abre ella lo aprueba el dueño)
const SOBRE_UN_REPO = new Set(['pending-approval']);

/**
 * La raíz de un repo de git (`{ ruta, clave }`), o null. Dos rutas son el mismo repo si tienen la misma `clave` (el
 * dispositivo y el nodo de la carpeta): la cadena no alcanza en un disco que no distingue mayúsculas. `enlazado` dice si
 * es un worktree agregado (`git worktree add`), no el clon principal.
 */
function raizDelRepo(dir) {
  try {
    const salida = require('child_process').execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const [r, gitDir, comun] = salida.split(/\r?\n/);
    if (!r || !gitDir || !comun) return null;
    const st = fs.statSync(r);
    const enlazado = fs.realpathSync(gitDir) !== fs.realpathSync(path.resolve(dir, comun));
    return { ruta: fs.realpathSync(r), clave: `${st.dev}:${st.ino}`, enlazado };
  } catch (_) { return null; }
}

/** ¿`sesion` es la designada, con la confirmación del dueño? Sólo elige el motivo: nunca decide la firma. */
function esLaDesignada(estado, sesion) {
  try {
    const d = confirmedDesignation({ state: estado, gates: path.join(estado, 'gates.log') });
    return d.ok && d.designacion.sesion === sesion;
  } catch (_) { return false; }
}

/**
 * Las claves de los repos donde trabaja la sesión `sid`: el de su ejecución abierta, el de la story de esa ejecución y
 * la carpeta de su arreglo rápido. El arreglo rápido cuenta sólo si lo declaró la propia sesión: el que otra pidió para
 * ella (`by`) guarda la carpeta de quien lo pidió. undefined si uno de los dos existe y no se puede leer.
 *
 * `estricto` es el lado de la coordinadora, donde cada repo suyo es una negación: una ruta declarada que no resuelve a
 * un repo devuelve undefined, para que la delegación no se abra por un dato que falta. Del otro lado sólo achica lo
 * permitido, y la story suma su repo sólo si es un worktree agregado: el clon principal lo comparten varias stories.
 */
function reposDe(estado, sid, raiz, { estricto = false } = {}) {
  const repos = [];
  const sumar = (r) => { if (!repos.includes(r.clave)) repos.push(r.clave); };
  for (const [dir, campo] of [['active', 'repoPath'], ['adhoc', 'cwd']]) {
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(estado, dir, `${safeSid(sid)}.json`), 'utf8')); } catch (e) {
      if (e.code === 'ENOENT') continue;
      return undefined;
    }
    if (dir === 'adhoc' && m && m.by != null && m.by !== sid) continue;
    if (m && typeof m[campo] === 'string' && m[campo]) {
      const r = raiz(m[campo]);
      if (r) sumar(r);
      else if (estricto) return undefined;
    }
    // la story de una ejecución suele vivir en otro worktree (el privado): ese repo también es de la sesión
    if (dir === 'active' && m && typeof m.storyPath === 'string' && m.storyPath) {
      const s = path.isAbsolute(m.storyPath) ? raiz(path.dirname(m.storyPath)) : null;
      if (estricto) { if (!s) return undefined; sumar(s); } else if (s && s.enlazado) sumar(s);
    }
  }
  return repos;
}

/** Por qué el repo del pendiente no admite la delegación, o null: tiene que ser de `destino` y no de `sesion`. */
function motivoDelRepo({ repo, cwd, estado, sesion, destino, raiz }) {
  // sin la carpeta del pedido no se sabe cuál es el checkout de la coordinadora
  if (!cwd) return 'el pedido no dice desde qué carpeta se corre';
  const delPendiente = raiz(path.resolve(cwd, repo || '.'));
  if (!delPendiente) return `${repo || cwd} no es un repo de git`;
  const suyos = reposDe(estado, sesion, raiz, { estricto: true });
  if (suyos === undefined) return 'no pude leer el marcador o el arreglo rápido de la sesión del pedido, o uno de sus repos no se encuentra';
  const checkout = raiz(cwd);
  if ((checkout && checkout.clave === delPendiente.clave) || suyos.includes(delPendiente.clave)) return `${delPendiente.ruta} es un repo de la coordinadora: un pendiente suyo lo aprueba el dueño`;
  const delDestino = reposDe(estado, destino, raiz);
  if (delDestino === undefined) return `no pude leer el marcador o el arreglo rápido de la sesión ${destino}`;
  if (!delDestino.includes(delPendiente.clave)) return `${delPendiente.ruta} no es un repo donde trabaja la sesión ${destino} (ni su ejecución abierta ni su arreglo rápido)`;
  return null;
}

/**
 * Quién firmó un cambio de control, para su constancia: la sesión designada por su ventana es la coordinadora; la
 * ventana de otra sesión o la terminal, el dueño. Sólo nombra al firmante: nunca decide si la firma vale.
 */
function signerOf({ via, sesion } = {}, { home } = {}) {
  if (via !== 'ventana' || !sesion) return 'dueño';
  try {
    const p = accountPaths(accountHome({ home }));
    const d = require(path.join(PIPELINE_LIB, 'critical-waivers.js')).designacionVigente({ dir: p.state });
    return d && !d.error && d.sesion === sesion ? 'coordinadora' : 'dueño';
  } catch (_) { return 'dueño'; }
}

function cli(argv) {
  const [cmd] = argv;
  if (cmd === 'confirm-designation') {
    const rw = require(path.join(PIPELINE_LIB, 'runtime-waiver.js'));
    if (!rw.hasTty()) { console.error('🔒 confirm-designation pide la terminal del dueño (/dev/tty): el agente no puede correrlo.'); return 2; }
    const p = accountPaths(accountHome());
    const cw = require(path.join(PIPELINE_LIB, 'critical-waivers.js'));
    const d = cw.designacionVigente({ dir: p.state });
    if (!d || d.error) { console.error((d && d.error) || 'ninguna sesión de esta máquina está designada'); return 1; }
    console.error(`La sesión designada es la «${d.rol}» (${d.sesion}), desde ${d.ts}, con la frase: «${d.cita}».`);
    console.error('Con esto, esa sesión firma sin ventana, en las otras sesiones, sólo las firmas que el perfil del equipo delega (approvals.delegated_signing), y sólo en las máquinas que nombra; las demás, y las de approvals.owner_only, las firmás vos.');
    if (!rw.confirmarFrase()) { console.error('No coincide: no se confirmó nada.'); return 1; }
    appendGatesLine(p, confirmationRecord(d, new Date().toISOString()));
    console.error('✅ designación confirmada.');
    return 0;
  }
  console.error('uso: delegated-signing.js confirm-designation');
  return 2;
}

module.exports = { accountPaths, confirmationRecord, delegaSinVentana, signerOf };

if (require.main === module) process.exit(cli(process.argv.slice(2)));
