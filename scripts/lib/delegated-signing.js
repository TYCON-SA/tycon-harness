'use strict';

/**
 * delegated-signing.js — la delegación de firmas del dueño a la sesión designada.
 *
 * Lo que decide es `delegaSinVentana`: una firma de `approvals.delegated_signing`, fuera de `owner_only`, en una
 * máquina de `delegated_machines`, pedida por la sesión designada para otra sesión, corre sin ventana. La designación
 * vale sólo si el dueño la confirmó (`confirm-designation`: con un click en la pestaña de la sesión designada, o en su
 * terminal). Ninguna firma sale de una cita en la conversación.
 *
 * Todo se lee de la casa de la cuenta (`real-home.js`), nunca de `HOME`, `USERPROFILE` ni de una variable `TYCON_*`:
 * el agente puede poner esas variables. Cada dependencia entra por parámetro.
 *
 * CLI:
 *   node delegated-signing.js confirm-designation [--terminal]   (la sesión designada, con la firma de la persona; o el dueño en su terminal)
 */

const fs = require('fs');
const path = require('path');

const PIPELINE_LIB = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib');
// lo que no tiene vía delegada aunque el perfil lo liste, con el motivo que se dice: nombrar y retirar a la coordinadora,
// y mergear salteando la CI (es lo mismo que aflojar todos los controles juntos). El motivo dice «sólo del dueño»: la
// ventana lo calla, porque no delegar es lo normal (owner-window.js)
const NUNCA_DELEGABLES = new Map([
  ['designation-set', 'nombrar o retirar a la coordinadora lo firma el dueño con su click en la pestaña de esa sesión: no se delega'],
  ['designation-withdraw', 'nombrar o retirar a la coordinadora lo firma el dueño con su click en la pestaña de esa sesión: no se delega'],
  ['escape:merge-bypass', 'mergear salteando la cola y la CI de main es sólo del dueño: no se delega'],
  ['escape:external-pr', 'encolar o mergear un pedido de alguien de afuera del equipo es sólo del dueño: no se delega'],
  ['adhoc-lane:datos', 'dejar pasar un cambio de datos o de permisos sin historia es sólo del dueño: no se delega'],
  ['autonomy-resume', 'volver al modo autónomo lo decide el dueño con su click o su terminal: no se delega'],
  ['review-skip', 'contestar «skip» a la pregunta del pase del código es sólo del dueño, en su pestaña o la de la coordinadora: no se delega'],
  ['escape:dod_runtime_exempt', 'eximir una historia de la prueba en vivo es sólo del dueño, en su pestaña o la de la coordinadora: no se delega'],
  ['escape:advisors_exempt', 'eximir una historia de los revisores es sólo del dueño, en su pestaña o la de la coordinadora: no se delega'],
  ['runtime-waiver', 'aceptar un criterio imposible de probar en vivo es sólo del dueño, con su click o su terminal: no se delega ni sale como trámite'],
]);

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

// La confirmación y su comparación viven con la regla de quién es la coordinadora (critical-waivers.js): una sola fuente,
// que también lee un clon de sólo skills. Acá se reexportan para quien ya las pedía de este archivo.
const waivers = () => require(path.join(PIPELINE_LIB, 'critical-waivers.js'));
const confirmationRecord = (designacion, ts, extra) => waivers().confirmationRecord(designacion, ts, extra);
const confirmaLaDesignacion = (linea, designacion) => waivers().confirmaLaDesignacion(linea, designacion);

/**
 * ¿La organización deja que la coordinadora firme por el dueño? Sólo con `approvals.relay_session` en el perfil del
 * equipo del árbol de este arnés: sin perfil, o sin poder leerlo, la coordinadora ordena y no firma. `{ ok, motivo? }`.
 * `env` y `arnes`, para las pruebas.
 */
function firmaPorElDueno({ env, home, arnes } = {}) {
  // la misma lectura que el rol de ordenar (critical-waivers.js): los dos caminos no pueden contradecirse
  const r = require(path.join(PIPELINE_LIB, 'critical-waivers.js')).sesionQueReenvia({ ...(env ? { env } : {}), home, ...(arnes ? { arnes } : {}) });
  return r.valor ? { ok: true } : { ok: false, motivo: claveFaltante(r.aviso) };
}
const claveFaltante = (aviso) => `${aviso ? `${aviso.replace(/: nadie reenvía$/, '')}: ` : ''}sin approvals.relay_session en el perfil del equipo la coordinadora no firma: las firmas van a la ventana del dueño`;

/**
 * La designación vigente, confirmada por el dueño: `{ ok, designacion }` o `{ ok:false, reason }`. `clave`: el
 * `approvals.relay_session` del perfil que ya leyó quien pregunta (una sola fuente por llamada); sin pasarla, se lee.
 */
function confirmedDesignation(p, { clave } = {}) {
  if (clave === undefined) {
    const f = firmaPorElDueno();
    if (!f.ok) return { ok: false, reason: f.motivo };
  } else if (!(typeof clave === 'string' && clave.trim())) return { ok: false, reason: claveFaltante(null) };
  return confirmadaEnElRegistro(p);
}

// La designación vigente con su renglón de confirmación en el registro, sin mirar el perfil.
function confirmadaEnElRegistro(p) {
  const cw = require(path.join(PIPELINE_LIB, 'critical-waivers.js'));
  const d = cw.designacionVigente({ dir: p.state });
  if (!d) return { ok: false, reason: 'ninguna sesión de esta máquina está designada para reenviar los ok del dueño' };
  if (d.error) return { ok: false, reason: d.error };
  const g = readGates(p);
  if (g.error) return { ok: false, reason: g.error };
  const ok = g.lines.some((l) => confirmaLaDesignacion(l, d));
  if (!ok) return { ok: false, reason: 'la designación de la sesión no está confirmada por el dueño: la sesión designada corre `node scripts/lib/delegated-signing.js confirm-designation` y el dueño la aprueba con un click en el cuadro de opciones, o la confirma en su terminal' };
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
function delegaSinVentana({ firma, sesion, destino, home, estado, env, arnes, perfil, huella, repo, cwd, raiz = raizDelRepo, pendiente = null } = {}) {
  const no = (motivo) => ({ ok: false, motivo });
  if (!sesion || !destino) return no('sin la sesión del pedido y la destino no se delega');
  // su constancia nombra al dueño en la huella: aunque el perfil la liste, no tiene vía delegada
  if (firma === 'adversarial-skip') return no('saltear el pase adversarial es sólo del dueño: no se delega');
  if (NUNCA_DELEGABLES.has(firma)) return no(NUNCA_DELEGABLES.get(firma));
  const cat = require('./signatures.js');
  // del nivel 2 se delegan sólo las excepciones de trámite; lo demás, y todo el nivel 3, es sólo del dueño aunque un
  // perfil lo liste (el lector del perfil ya lo saca: esto cubre a quien lee la lista sin ese lector)
  if (!cat.delegable(firma)) return no(`«${firma}» es sólo del dueño: no se delega`);
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
  // owner_only sólo restringe: ahí escape-phrases cubre también los escapes que el grupo no delega
  const ids = (v, o) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).flatMap((x) => cat.expand(x, o));
  const malFormada = ['owner_only', 'delegated_signing', 'delegated_machines'].find((k) => a[k] != null && !Array.isArray(a[k]) && !(k !== 'delegated_machines' && typeof a[k] === 'string'));
  if (malFormada) return no(`no pude leer approvals.${malFormada} del perfil: no es una lista`);
  if (ids(a.owner_only, { restringe: true }).includes(firma)) return no(`«${firma}» es sólo del dueño (approvals.owner_only)`);
  if (!ids(a.delegated_signing).includes(firma)) return no(`el perfil del equipo no delega «${firma}» (approvals.delegated_signing)`);
  // lo que el perfil subió con approvals.levels deja de delegarse (lo saca también su lector)
  if (a.levels && typeof a.levels === 'object' && !cat.delegable(firma, a.levels)) return no(`«${firma}» es sólo del dueño: el perfil le subió el nivel (approvals.levels)`);
  let fp;
  try { fp = (huella || (() => require('./machine-id.js').huella()))(); } catch (e) { return no(`no pude leer la huella de esta máquina (${e.message})`); }
  if (!fp || fp.error || !fp.huella) return no(`no pude leer la huella de esta máquina: ${(fp && fp.error) || 'sin huella'}`);
  const maquinas = Array.isArray(a.delegated_machines) ? a.delegated_machines : [];
  if (!maquinas.some((m) => m && m.id === fp.huella)) return no('esta máquina no está en approvals.delegated_machines');
  const p = { state: estado, gates: path.join(estado, 'gates.log') };
  const d = confirmedDesignation(p, { clave: a.relay_session == null ? null : a.relay_session });
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
    const m = motivoDelRepo({ repo, cwd, estado, sesion, destino, raiz, casa: home || undefined, pendiente });
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
    const salida = require('child_process').execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
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
    const d = confirmadaEnElRegistro({ state: estado, gates: path.join(estado, 'gates.log') });
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

/**
 * Por qué una copia del pendiente NO es una copia suelta de la sesión `destino`, o null si lo es. Las sesiones que abre la
 * coordinadora (`coordination.js open`) trabajan en el modo ágil sin ejecución ni arreglo rápido, en copias que arman
 * ellas mismas (`git worktree add`), a menudo de otro repo que el de la carpeta con que se abrieron: sin esto ninguna
 * firma de trámite les sale. Es suelta si es un worktree agregado (el clon principal lo comparten todas), si la sesión es
 * de fondo y la abrió la coordinadora, y si la copia no es de ninguna otra sesión: ni su ejecución, ni su arreglo
 * rápido, ni su carpeta, ni la carpeta con que la coordinadora abrió a otra. Lo que no se puede leer niega.
 */
function noEsCopiaSuelta({ estado, casa, destino, delPendiente, raiz }) {
  if (!delPendiente.enlazado) return 'es el clon principal, que comparten las sesiones';
  const coord = require('../tools/coordination.js');
  let lanzada;
  try { lanzada = coord.launchedBy({ home: casa, sid: destino }); } catch (e) { return `no pude saber si la abrió la coordinadora (${e.message})`; }
  if (lanzada.problem) return `no pude saber si la abrió la coordinadora (${lanzada.problem})`;
  if (!lanzada.launched) return 'la sesión no es una de fondo que abrió la coordinadora';
  const s = require('./signature-list.js').sesiones(casa);
  if (s.sinDato) return 'no pude leer las sesiones de la máquina';
  const vistas = new Map();
  const mismaCopia = (dir) => {
    if (typeof dir !== 'string' || !dir || !path.isAbsolute(dir)) return false;
    if (!vistas.has(dir)) { const r = raiz(dir); vistas.set(dir, Boolean(r) && r.clave === delPendiente.clave); }
    return vistas.get(dir);
  };
  // Las ejecuciones (también las detenidas, que se pueden retomar) y los arreglos rápidos de las otras sesiones, vivas o
  // no, y los declarados para ellas por otra: cualquier carpeta que nombran. Acá se cuenta de más a propósito, porque el
  // resultado niega: el repo de la ejecución y su historia, la carpeta de evidencia y de la corrida, los archivos que
  // tocó (el código suele vivir en otra copia que la historia), y la carpeta y los archivos del arreglo rápido.
  for (const dir of ['active', 'pruned', 'adhoc']) {
    let nombres = [];
    try { nombres = fs.readdirSync(path.join(estado, dir)); } catch (e) { if (e.code !== 'ENOENT') return `no pude leer las ejecuciones de la máquina (${e.code || e.message})`; }
    for (const n of nombres) {
      if (!n.endsWith('.json') || n.slice(0, -5) === safeSid(destino)) continue;
      let m;
      try { m = JSON.parse(fs.readFileSync(path.join(estado, dir, n), 'utf8')); } catch (e) { return `no pude leer ${dir}/${n} (${e.code || e.message})`; }
      if (!m || typeof m !== 'object') return `no pude leer ${dir}/${n}`;
      if (m.sessionId === destino) continue;
      const lista = (v) => (Array.isArray(v) ? v : []);
      const carpetas = [m.repoPath, m.cwd, m.evidenceDir, m.runDir, ...Object.keys((m.bases && typeof m.bases === 'object') ? m.bases : {})];
      const archivos = [m.storyPath, ...lista(m.allowedFiles), ...lista(m.files), ...lista(m.filesTouched), ...lista(m.fileEvents).map((e) => e && e.path)]
        .filter((f) => typeof f === 'string' && f);
      if ([...carpetas, ...archivos.map((f) => path.dirname(f))].some(mismaCopia)) return `es una copia de la sesión ${m.sessionId || n.slice(0, -5)}`;
    }
  }
  // la carpeta de otra sesión viva, y la carpeta con que la coordinadora abrió a otra que sigue viva (una fila de una que
  // ya terminó no es de nadie: el registro se poda recién en la próxima apertura)
  for (const [sid, x] of s.mapa) if (sid !== destino && x && x.alive && mismaCopia(x.cwd)) return `es la carpeta de la sesión ${sid}`;
  let filas;
  try { filas = coord.readLaunched(casa); } catch (e) { return `no pude leer las sesiones que abrió la coordinadora (${e.message})`; }
  const otrasVivas = [...s.mapa].filter(([sid, x]) => sid !== destino && x && x.alive).map(([, x]) => x);
  for (const f of filas) if (f && otrasVivas.some((x) => coord.launchedMatches(f, x)) && mismaCopia(f.cwd)) return `es la carpeta con que la coordinadora abrió a ${f.name || 'otra sesión'}`;
  return null;
}

/** Por qué el repo del pendiente no admite la delegación, o null: tiene que ser de `destino` y no de `sesion`. */
function motivoDelRepo({ repo, cwd, estado, sesion, destino, raiz = raizDelRepo, casa = require('os').homedir(), pendiente = null }) {
  // sin la carpeta del pedido no se sabe cuál es el checkout de la coordinadora
  if (!cwd) return 'el pedido no dice desde qué carpeta se corre';
  const delPendiente = raiz(path.resolve(cwd, repo || '.'));
  if (!delPendiente) return `${repo || cwd} no es un repo de git`;
  // un worktree agregado nunca es de la coordinadora: sólo cuentan su checkout y los clones principales donde trabaja.
  // Pedir la firma parada en el worktree de la sesión destino no lo hace suyo
  if (!delPendiente.enlazado) {
    const suyos = reposDe(estado, sesion, raiz, { estricto: true });
    if (suyos === undefined) return 'no pude leer el marcador o el arreglo rápido de la sesión del pedido, o uno de sus repos no se encuentra';
    const checkout = raiz(cwd);
    if ((checkout && checkout.clave === delPendiente.clave) || suyos.includes(delPendiente.clave)) return `${delPendiente.ruta} es un repo de la coordinadora: un pendiente suyo lo aprueba el dueño`;
  }
  const delDestino = reposDe(estado, destino, raiz);
  if (delDestino === undefined) return `no pude leer el marcador o el arreglo rápido de la sesión ${destino}`;
  if (delDestino.includes(delPendiente.clave)) return null;
  // la sesión que abrió la coordinadora trabaja en el modo ágil, sin ejecución ni arreglo rápido, en una copia que arma
  // ella. El arnés no sabe quién armó una copia: vale sólo si la sesión destino declaró este pendiente en esta copia
  // (`marker.js declare-pending`), y si ninguna otra sesión nombra la copia (como en la firma de trámite)
  const ajeno = `${delPendiente.ruta} no es un repo donde trabaja la sesión ${destino} (ni su ejecución abierta ni su arreglo rápido)`;
  const suelta = noEsCopiaSuelta({ estado, casa, destino, delPendiente, raiz });
  if (suelta) return `${ajeno}, ni una copia suelta suya: ${suelta}`;
  const declarado = declaracionDe({ estado, destino, pendiente, clave: delPendiente.clave });
  return declarado ? `${ajeno}: ${declarado}` : null;
}

/** El renglón del registro con que una sesión declara un pendiente suyo en una copia (`marker.js declare-pending`). */
const DECLARADO = 'pending-declared';

/**
 * Por qué la sesión `destino` NO declaró el pendiente `pendiente` en el repo de clave `clave`, o null si lo declaró. La
 * declaración es el renglón `pending-declared` del registro con esa sesión, ese código y esa carpeta real. Sin el
 * registro legible, no está declarado.
 */
function declaracionDe({ estado, destino, pendiente, clave }) {
  const como = `la sesión ${destino} lo declara con \`marker.js declare-pending --id <código> --repo <su copia>\` y después se aprueba`;
  if (!pendiente) return `el pedido no dice qué pendiente es: ${como}`;
  let texto;
  try { texto = fs.readFileSync(path.join(estado, 'gates.log'), 'utf8'); } catch (e) {
    return e.code === 'ENOENT' ? `no declaró ${pendiente} en esa copia: ${como}` : `no pude leer el registro de firmas (${e.code || e.message})`;
  }
  for (const l of texto.split('\n')) {
    if (!l.includes(DECLARADO)) continue;
    let j;
    try { j = JSON.parse(l); } catch (_) { continue; }
    if (j && j.name === DECLARADO && j.sesion === destino && j.id === pendiente && j.repo === clave) return null;
  }
  return `no declaró ${pendiente} en esa copia: ${como}`;
}

/**
 * El control previo de aprobar un pendiente sin persona («hecho y avisado» o la delegación), el `antes` de
 * `marker.js approve-pending`: null para firmar, o `{ codigo, motivo }`. Con la ventana, la terminal o un click, null.
 * Las sesiones salen del registro de la firma (`sesion`, la que pidió, y `destino`); en el chequeo previo del freno el
 * registro trae sólo la vía, y salen de `propia` y `pedida` (`--for-session`), como las arma el freno. Lo que mira, lo
 * mismo que la delegación: la que pide no es la destino, es la coordinadora designada y confirmada (`designada`, de
 * fábrica con la clave del perfil, `confirmedDesignation`), y el repo del pendiente es de la destino (`motivoDelRepo`).
 */
function antesDelPendiente({ via, registro, propia = null, pedida = null, estado, cwd, repo, raiz = raizDelRepo, designada, casa = require('os').homedir(), pendiente = null } = {}) {
  const sinPersona = via === 'delegacion' || (registro && ['avisado', 'delegacion', 'automatica'].includes(registro.via));
  if (!sinPersona) return null;
  const no = (motivo) => ({ codigo: 1, motivo });
  const soloLaVia = !registro || Object.keys(registro).every((k) => k === 'via');
  // la firma de trámite (automatic-signing.js) no tiene coordinadora: la pide cualquier sesión, también para sí. Vale sólo
  // sobre un repo donde trabaja la sesión destino
  if (registro && registro.via === 'automatica') {
    const destinoAuto = soloLaVia ? (pedida || propia) : registro.destino;
    if (!destinoAuto) return no('el registro de la firma no dice para qué sesión es: un pendiente no se aprueba sin persona sin saberlo');
    if (!cwd) return no('el pedido no dice desde qué carpeta se corre');
    const delPendiente = raiz(path.resolve(cwd, repo || '.'));
    if (!delPendiente) return no(`${repo || cwd} no es un repo de git`);
    const delDestino = reposDe(estado, destinoAuto, raiz);
    if (delDestino === undefined) return no(`no pude leer el marcador o el arreglo rápido de la sesión ${destinoAuto}`);
    if (delDestino.includes(delPendiente.clave)) return null;
    // la copia aparte que armó una sesión de fondo de la coordinadora también es suya, si no es de otra
    const suelta = noEsCopiaSuelta({ estado, casa, destino: destinoAuto, delPendiente, raiz });
    if (!suelta) return null;
    return no(`${delPendiente.ruta} no es un repo donde trabaja la sesión ${destinoAuto} (ni su ejecución abierta ni su arreglo rápido), ni una copia suelta suya: ${suelta}`);
  }
  const sesion = soloLaVia ? propia : registro.sesion;
  const destino = soloLaVia ? (pedida || propia) : registro.destino;
  if (!sesion || !destino) return no('el registro de la firma no dice para qué sesión es: un pendiente no se aprueba sin persona sin saberlo');
  if (sesion === destino) return no('un pendiente que abrió esta sesión lo aprueba una persona o la coordinadora, no ella misma. En una copia tuya sin ejecución ni arreglo rápido, declaralo con `marker.js declare-pending --id <código> --repo <tu copia>` y pedíselo a la coordinadora');
  const esLaCoordinadora = designada || ((s) => {
    const d = confirmedDesignation({ state: estado, gates: path.join(estado, 'gates.log') });
    return d.ok && d.designacion.sesion === s;
  });
  if (!esLaCoordinadora(sesion)) return no(`la sesión que pide no es la coordinadora designada (y confirmada por el dueño): ${sesion}`);
  const m = motivoDelRepo({ repo, cwd, estado, sesion, destino, raiz, casa, pendiente });
  return m ? no(m) : null;
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
    // sin la clave no hay firma que delegar: se dice antes de abrir una ventana, pedir la terminal o mostrar un cuadro
    const p = accountPaths(accountHome());
    // una prueba no escribe el estado real (historia 8.314): lo primero, antes de cualquier otro motivo
    const prueba = require('./lab-home.js').pruebaSobreLoReal(p.state);
    if (prueba) { console.error(`🔒 confirm-designation: ${prueba}. No se confirmó nada.`); return 2; }
    const f = firmaPorElDueno();
    if (!f.ok) { console.error(`🔒 confirm-designation: no se confirmó nada — ${f.motivo}.`); return 1; }
    const rw = require(path.join(PIPELINE_LIB, 'runtime-waiver.js'));
    const cw = require(path.join(PIPELINE_LIB, 'critical-waivers.js'));
    const vigente = cw.designacionVigente({ dir: p.state });
    if (!vigente || vigente.error) { console.error((vigente && vigente.error) || 'ninguna sesión de esta máquina está designada'); return 1; }
    // con una designación pendiente (otra, posterior a la confirmada) se confirma ésa: la nombran la terminal y el cuadro
    const d = vigente.pendiente || vigente;
    // en Windows la terminal no se lee: el mismo comando corre en una ventana nueva, y la frase se escribe adentro
    if (argv.includes('--terminal') && rw.esWindows()) {
      if (process.env[rw.MARCA_VENTANA] !== '1') {
        console.error('🪟 Abro una ventana nueva para la firma: seguí ahí.');
        const v = rw.abrirVentana({ script: __filename, args: argv, titulo: 'Firma del dueño' });
        if (v.estado === 'vencida' || v.estado === 'no-abrio') { console.error(`🔒 confirm-designation: ${v.estado === 'vencida' ? 'la ventana venció sin firmar' : `no pude abrir la ventana (${v.motivo})`}: no se confirmó nada.`); return 1; }
        return v.codigo === 0 ? 0 : (v.codigo || 1);
      }
      rw.dentroDeLaVentana();
    }
    // desde la pestaña de la sesión designada: la firma de la persona, en la ventana o con su click (owner-window.js). En
    // la terminal, la frase. Una firma que no dio una persona no confirma nada
    if (!argv.includes('--terminal') && !rw.hasTty()) {
      const propia = process.env.CLAUDE_CODE_SESSION_ID || process.env.TYCON_SESSION_ID || '';
      if (propia !== d.sesion && propia !== vigente.sesion) { console.error(`🔒 confirm-designation: se corre desde la pestaña de la sesión designada (${d.sesion})${d.sesion !== vigente.sesion ? ` o de la vigente (${vigente.sesion})` : ''}, o en la terminal del dueño.`); return 1; }
      const r = require('./owner-window.js').exigir({ firma: 'designation-confirm', argv: [__filename, ...argv], resumen: `la sesión ${d.sesion} es la «${d.rol}» de esta máquina`, propia });
      if (r.codigo !== 0) { console.error(`🔒 confirm-designation: ${r.motivo}`); return r.codigo === 2 ? 2 : 1; }
      if (!['ventana', 'click', 'mensaje'].includes(r.via)) { console.error(`🔒 confirm-designation: la firma volvió por ${r.via}, y esto lo confirma una persona: no se confirmó nada.`); return 1; }
      appendGatesLine(p, confirmationRecord(d, new Date().toISOString()));
      console.error(`✅ designación confirmada (${r.via}).`);
      return 0;
    }
    if (!rw.hasTty()) { console.error('🔒 confirm-designation --terminal pide la terminal del dueño (/dev/tty).'); return 2; }
    console.error(`La sesión designada es la «${d.rol}» (${d.sesion}), desde ${d.ts}, ${d.cita ? `con la frase: «${d.cita}»` : 'por click'}.`);
    console.error('Con esto, esa sesión firma sin ventana, en las otras sesiones, sólo las firmas que el perfil del equipo delega (approvals.delegated_signing), y sólo en las máquinas que nombra; las demás, y las de approvals.owner_only, las firmás vos.');
    if (!rw.confirmarFrase()) { console.error('No coincide: no se confirmó nada.'); return 1; }
    appendGatesLine(p, confirmationRecord(d, new Date().toISOString()));
    console.error('✅ designación confirmada.');
    return 0;
  }
  console.error('uso: delegated-signing.js confirm-designation');
  return 2;
}

module.exports = { accountPaths, confirmationRecord, confirmaLaDesignacion, confirmedDesignation, delegaSinVentana, firmaPorElDueno, signerOf, NUNCA_DELEGABLES, motivoDelRepo, antesDelPendiente, profileLists, DECLARADO, raizDelRepo };

if (require.main === module) process.exit(cli(process.argv.slice(2)));
