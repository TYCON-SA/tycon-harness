'use strict';
/*
 * demo-guard.js —EL FRENO CENTRAL DEL SITIO DEMO.
 *
 * Con `SITE_DEMO=1` el proceso no abre conexiones hacia afuera, no lanza procesos y no escribe a disco fuera de una carpeta
 * temporal propia. Un intento se anota (`intentos`, y el registro) y lanza un error: el sitio demo falla cerrado.
 *
 * El freno corta POR DEFECTO: de cada módulo de salida se frena TODA función y clase exportada, salvo una lista corta y
 * explícita de lo permitido (`PERMITIDAS`, abajo). Lo que una versión nueva de Node agregue a esos módulos queda frenado solo,
 * sin tocar este archivo. Se cambian las funciones de los módulos (`http.request`, `net.connect`, `child_process.spawn`,
 * `fs.writeFileSync`, `globalThis.fetch`…), no la copia que cada archivo guarde: por eso se pone ANTES de cargar fuentes y
 * pestañas (server.js lo pide al cargarse), y este archivo no carga nada del sitio. `worker_threads` no hereda el freno: cada
 * hilo aparte lo pone de nuevo con `ponerFreno({ dir })`, y el hilo anota cada intento en su salida de error (el proceso la
 * muestra igual que la del hilo principal). Una función a frenar que este Node no trae se anota al poner el freno (`faltantes`).
 *
 *   · red       net, tls, dgram, dns, http, https, http2 y los globales `fetch` y `WebSocket`: todo bloqueado menos lo permitido.
 *               También los prototipos que conectan, consultan o lanzan (`net.Socket`, `dgram.Socket`, los `Resolver` de dns,
 *               el agente de http). Recibir pedidos sigue andando: el `listen` del servidor no es conectar.
 *   · procesos  child_process: todo bloqueado (sin permitidas), también `ChildProcess` y su `prototype.spawn`. También
 *               `process.binding` y `process.dlopen`: cargar un módulo nativo o pedir un enlace interno saltaría el freno entero.
 *   · disco     fs, en sus formas Sync, de callback y de promesas, y `FileHandle`: toda función que no está en la lista de
 *               lectura se trata como escritura. Pasa sólo si la ruta (con los enlaces resueltos: el `realpath` del padre, o
 *               del propio archivo si ya existe) queda adentro de la carpeta propia; las de descriptor (`f*`, `write`,
 *               `FileHandle.*`) pasan sólo si el descriptor se abrió adentro (stdout y stderr cuentan como adentro). Una función
 *               de fs que el freno no conoce se bloquea siempre. `mkdtemp` recibe un PREFIJO: se juzga la carpeta donde crea.
 *               `fs.cp` se salta los enlaces del origen: un enlace de afuera no llega a la carpeta propia. Los enlaces (`symlink`, `link`) se niegan siempre. Leer de cualquier lado anda,
 *               salvo con una bandera que escribe: `readFile` y los flujos de lectura (`flag`/`flags`) se juzgan como una
 *               escritura. Un flujo de escritura con `fd` exige un descriptor de adentro, sea cual sea la ruta.
 *
 * Lo permitido (`PERMITIDAS`; lo que no está acá, bloqueado):
 *   · net       createServer, Server, Socket (la crea el propio Node para stdout; su `connect` queda frenado), isIP, isIPv4, isIPv6, BlockList, SocketAddress, las cuatro de «AutoSelectFamily»
 *               y `_normalizeArgs` (sólo ordena argumentos).
 *   · tls       createServer, Server, createSecureContext, getCiphers, checkServerIdentity.
 *   · dgram     nada.
 *   · dns       getServers, setServers, getDefaultResultOrder, setDefaultResultOrder y `lookup` de una dirección numérica o de
 *               `localhost` (no sale a ningún lado). Lo mismo en `dns.promises`.
 *   · http      createServer, Server, Agent, IncomingMessage, ServerResponse, OutgoingMessage, validateHeaderName,
 *               validateHeaderValue, setMaxIdleHTTPParsers, CloseEvent, MessageEvent y `_connectionListener` (lo usa https).
 *   · https     createServer, Server, Agent.
 *   · http2     createServer, createSecureServer, Http2ServerRequest, Http2ServerResponse, getDefaultSettings,
 *               getPackedSettings, getUnpackedSettings, performServerHandshake.
 *   · child_process, fetch, WebSocket: nada.
 *   · fs (lectura)  access, exists, stat, lstat, fstat, statfs, readFile, readdir, readlink, realpath, read, readv, opendir,
 *               glob, createReadStream, close, `open` con banderas de sólo lectura y las clases Dir, Dirent, Stats,
 *               ReadStream y FileReadStream (cada una con sus formas Sync y de promesas).
 *   · FileHandle (lectura)  read, readv, readFile, readLines, createReadStream, stat, close, readableWebStream.
 *
 * Casos: scripts/tests/site-demo.test.js.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isMainThread } = require('worker_threads');

let activo = null;
const sumideros = [];
const pasados = [];
let sumideroDelHilo = false;

/** Anota un intento bloqueado y lo manda al registro (si todavía no hay registro, queda para cuando lo haya). */
function anotar(intentos, tipo, detalle) {
  const i = { tipo, detalle: String(detalle).slice(0, 200) };
  intentos.push(i);
  pasados.push(i);
  if (pasados.length > 200) pasados.shift();
  for (const fn of sumideros) { try { fn(i); } catch { /* el registro no cambia lo que pasó */ } }
  return i;
}

/** El registro del freno: `fn` recibe cada intento (los que ya pasaron, también). */
function alIntentar(fn) {
  sumideros.push(fn);
  for (const i of pasados) { try { fn(i); } catch { /* idem */ } }
}

/** El freno de este proceso, `{ dir, intentos, quitar }`, o null si no está puesto. */
function frenoActual() { return activo; }

/** Lo permitido de cada módulo de salida (la cabecera lo explica). Lo que no está acá, y es función o clase, se bloquea. */
const PERMITIDAS = Object.freeze({
  net: ['createServer', 'Server', 'Socket', 'isIP', 'isIPv4', 'isIPv6', 'BlockList', 'SocketAddress', 'getDefaultAutoSelectFamily', 'setDefaultAutoSelectFamily',
    'getDefaultAutoSelectFamilyAttemptTimeout', 'setDefaultAutoSelectFamilyAttemptTimeout', '_normalizeArgs'],
  tls: ['createServer', 'Server', 'createSecureContext', 'getCiphers', 'checkServerIdentity'],
  dgram: [],
  dns: ['getServers', 'setServers', 'getDefaultResultOrder', 'setDefaultResultOrder'],
  'dns.promises': ['getServers', 'setServers', 'getDefaultResultOrder', 'setDefaultResultOrder'],
  http: ['createServer', 'Server', 'Agent', 'IncomingMessage', 'ServerResponse', 'OutgoingMessage', 'validateHeaderName', 'validateHeaderValue',
    'setMaxIdleHTTPParsers', 'CloseEvent', 'MessageEvent', '_connectionListener'],
  https: ['createServer', 'Server', 'Agent'],
  http2: ['createServer', 'createSecureServer', 'Http2ServerRequest', 'Http2ServerResponse', 'getDefaultSettings', 'getPackedSettings', 'getUnpackedSettings', 'performServerHandshake'],
  child_process: [],
});
/** Las funciones de fs que sólo leen (el nombre base: valen también con `Sync` y en `fs.promises`). */
const LECTURA_FS = Object.freeze(['access', 'exists', 'stat', 'lstat', 'fstat', 'statfs', 'readFile', 'readdir', 'readlink', 'realpath', 'read', 'readv', 'opendir', 'glob',
  'createReadStream', 'close', 'Dir', 'Dirent', 'Stats', 'ReadStream', 'FileReadStream', '_toUnixTimestamp']);
/** Las de lectura que aceptan una bandera de apertura (`flag` o `flags`): con una que escribe, se juzgan como escritura. */
const CON_BANDERA = Object.freeze(['readFile', 'createReadStream', 'ReadStream', 'FileReadStream']);
/** Lo que un `FileHandle` puede hacer sin que su archivo se haya abierto adentro. */
const LECTURA_MANEJADOR = Object.freeze(['read', 'readv', 'readFile', 'readLines', 'createReadStream', 'stat', 'close', 'readableWebStream']);
/** Las funciones de fs que escriben por ruta: nombre base → [lugares de la ruta, si la ruta sigue un enlace final]. */
const TABLA = Object.freeze({
  writeFile: [[0], true], appendFile: [[0], true], mkdir: [[0], false], rm: [[0], false], rmdir: [[0], false], unlink: [[0], false], rename: [[0, 1], false],
  copyFile: [[1], true], cp: [[1], true], truncate: [[0], true], chmod: [[0], true], chown: [[0], true], lchown: [[0], false], lchmod: [[0], false],
  utimes: [[0], true], lutimes: [[0], false], createWriteStream: [[0], true], WriteStream: [[0], true], FileWriteStream: [[0], true],
});
/** Las que escriben por descriptor (o manejador): pasan sólo si se abrió adentro. */
const POR_DESCRIPTOR = Object.freeze(['fchmod', 'fchown', 'futimes', 'ftruncate', 'fsync', 'fdatasync', 'write', 'writev']);
/** Las que reciben un PREFIJO y crean la carpeta al lado. */
const DE_PREFIJO = Object.freeze(['mkdtemp', 'mkdtempDisposable']);

/**
 * Los nombres de `modulo` que son función o clase. Una propiedad con `get` sólo se lee si parece una clase (`WebSocket`,
 * `BlockList`): leer una constante vieja (`fs.F_OK`) avisaría de una obsolescencia.
 */
function nombresFrenables(modulo) {
  const out = [];
  for (const n of Object.getOwnPropertyNames(modulo)) {
    const d = Object.getOwnPropertyDescriptor(modulo, n);
    if (!d) continue;
    if (typeof d.value === 'function') out.push(n);
    else if (d.get && /^[A-Z]/.test(n) && /[a-z]/.test(n)) { try { if (typeof modulo[n] === 'function') out.push(n); } catch { /* una propiedad que no se puede leer no se puede llamar */ } }
  }
  return out;
}

/**
 * Pone el freno. `dir`: la carpeta temporal propia, la única donde se puede escribir. Devuelve `{ dir, intentos, quitar }`:
 * `quitar()` deja todo como estaba (las pruebas); el proceso del sitio no lo quita nunca.
 */
function ponerFreno({ dir }) {
  if (activo) throw new Error('el freno del modo demo ya está puesto');
  const raiz = path.resolve(dir);
  const raices = [raiz];
  try { const real = fs.realpathSync(raiz); if (real !== raiz) raices.push(real); } catch { /* la carpeta todavía no existe: sólo su ruta */ }
  const intentos = [];
  const faltantes = [];
  const deshacer = [];
  // los descriptores y manejadores que se abrieron adentro de la carpeta propia (stdout y stderr: la salida del propio proceso)
  const fdsDentro = new Set([1, 2]);
  const manejadoresDentro = new WeakSet();
  // un hilo aparte no tiene el registro del sitio: cada intento va a su salida de error, que el proceso muestra
  if (!isMainThread && !sumideroDelHilo) { sumideroDelHilo = true; alIntentar((i) => process.stderr.write(`freno: ${i.tipo}: ${i.detalle}\n`)); }
  const adentro = (r) => raices.some((b) => r === b || r.startsWith(b + path.sep));
  /** El `realpath` del último tramo que existe de `p`, con lo que falta pegado al final (lo que no existe no puede ser un enlace). */
  const realDeExistente = (p) => {
    const resto = []; let a = p;
    for (;;) {
      try { return path.join(fs.realpathSync(a), ...resto.reverse()); } catch { /* sube un tramo */ }
      const s = path.dirname(a);
      if (s === a) return p;
      resto.push(path.basename(a)); a = s;
    }
  };
  /** La ruta real de `p`: el padre con sus enlaces resueltos y, si `sigue` y el último tramo es un enlace, adonde lleva. null: no se pudo. */
  const resolverReal = (p, sigue, prof = 0) => {
    if (prof > 16) return null;
    const completa = path.join(realDeExistente(path.dirname(p)), path.basename(p));
    if (!sigue) return completa;
    let st; try { st = fs.lstatSync(completa); } catch { return completa; }
    if (!st.isSymbolicLink()) return completa;
    let destino; try { destino = fs.readlinkSync(completa); } catch { return null; }
    return resolverReal(path.resolve(path.dirname(completa), destino), true, prof + 1);
  };
  const dentro = (ruta, sigue = true) => {
    // un descriptor o un manejador: vale si se abrió adentro (por `open`, que ya pasó por el freno)
    if (typeof ruta === 'number') return fdsDentro.has(ruta);
    if (ruta !== null && typeof ruta === 'object' && !Buffer.isBuffer(ruta) && !(ruta instanceof URL)) return manejadoresDentro.has(ruta);
    let r;
    try { r = path.resolve(ruta instanceof URL ? require('url').fileURLToPath(ruta) : String(ruta)); } catch { return false; }
    if (!adentro(r)) return false;
    const real = resolverReal(r, sigue);
    return real !== null && adentro(real);
  };
  const bloqueo = (tipo, detalle) => Object.assign(new Error(`sitio demo: ${tipo} bloqueado (${detalle})`), { code: 'EDEMO_FRENO' });
  /**
   * Cambia `objeto[nombre]` por una función que primero pregunta a `juez(args, this)`: un texto = bloqueado por eso; una lista =
   * los argumentos con que se sigue; otra cosa = sigue. `despues(resultado, args)` mira lo que devolvió (en una promesa, lo que
   * resolvió).
   */
  const envolver = (objeto, nombre, tipo, juez, { promesa = false, despues = null, vuelta = false } = {}) => {
    const d = Object.getOwnPropertyDescriptor(objeto, nombre);
    let original; try { original = objeto[nombre]; } catch { original = undefined; }
    if (typeof original !== 'function') { anotar(faltantes, 'freno', `${nombre}: no existe en este Node, no se pudo frenar`); return; }
    const frenado = function frenado(...args) {
      const veredicto = juez(args, this);
      if (typeof veredicto === 'string' && veredicto) {
        anotar(intentos, tipo, `${nombre}: ${veredicto}`);
        const e = bloqueo(tipo, `${nombre}: ${veredicto}`);
        if (promesa) return Promise.reject(e);
        // la forma con función de vuelta (`vuelta`) recibe el error por ella, como cualquier error de fs: lanzarlo dejaría un
        // rechazo suelto en quien la llamó de fondo, y eso tumba el proceso
        const cb = args[args.length - 1];
        if (vuelta && typeof cb === 'function') { process.nextTick(cb, e); return undefined; }
        throw e;
      }
      const res = original.apply(this, Array.isArray(veredicto) ? veredicto : args);
      if (!despues) return res;
      if (promesa) return res.then((v) => { despues(v, args); return v; });
      despues(res, args);
      return res;
    };
    try { frenado.prototype = original.prototype; } catch { /* sin prototipo no hay instanceof que cuidar */ }
    try { Object.defineProperty(frenado, 'name', { value: nombre }); } catch { /* el nombre no cambia lo que hace */ }
    const nuevo = { value: frenado, writable: true, configurable: true, enumerable: d ? d.enumerable : true };
    try { Object.defineProperty(objeto, nombre, nuevo); } catch { anotar(faltantes, 'freno', `${nombre}: no se pudo reemplazar`); return; }
    deshacer.push(() => { try { if (d) Object.defineProperty(objeto, nombre, d); else delete objeto[nombre]; } catch { /* queda el freno puesto */ } });
  };
  const destino = (a) => (typeof a === 'string' ? a : (Buffer.isBuffer(a) ? a.toString() : (a instanceof URL ? a.href : String(a))));

  // la red: ninguna conexión hacia afuera. Se frena TODO lo que exporta el módulo salvo lo permitido (el `listen` del servidor
  // sigue andando: recibir no es conectar)
  const http = require('http'); const https = require('https'); const net = require('net'); const tls = require('tls'); const http2 = require('http2');
  const dgram = require('dgram'); const dns = require('dns');
  const siempre = (que) => (args) => `${que}${typeof args[0] === 'string' ? ` ${args[0].slice(0, 120)}` : ''}`;
  const local = (h) => typeof h === 'string' && (h === 'localhost' || net.isIP(h) !== 0);
  const nombre = (args) => `nombre ${destino(args[0]).slice(0, 120)}`;
  /** Frena todo lo que exporta `modulo` (clave de `PERMITIDAS`) menos lo permitido; `especiales`: el juez propio de algunos nombres. */
  const cortarPorDefecto = (modulo, clave, tipo, juez, { promesa = false, especiales = {} } = {}) => {
    const permitidas = new Set(PERMITIDAS[clave]);
    for (const n of nombresFrenables(modulo)) {
      // una clase (`Resolver`) lanza al construirla; una función de promesas devuelve una promesa rechazada
      const rechaza = promesa && !/^[A-Z]/.test(n);
      if (especiales[n]) envolver(modulo, n, tipo, especiales[n], { promesa: rechaza });
      else if (!permitidas.has(n)) envolver(modulo, n, tipo, juez, { promesa: rechaza });
    }
  };
  const buscar = (args) => (local(args[0]) ? null : nombre(args));
  cortarPorDefecto(http, 'http', 'red', siempre('conexión a'));
  cortarPorDefecto(https, 'https', 'red', siempre('conexión a'));
  cortarPorDefecto(net, 'net', 'red', () => 'conexión');
  cortarPorDefecto(tls, 'tls', 'red', () => 'conexión');
  cortarPorDefecto(http2, 'http2', 'red', () => 'conexión');
  cortarPorDefecto(dgram, 'dgram', 'red', () => 'datagrama');
  cortarPorDefecto(dns, 'dns', 'red', nombre, { especiales: { lookup: buscar } });
  cortarPorDefecto(dns.promises, 'dns.promises', 'red', nombre, { promesa: true, especiales: { lookup: buscar } });
  // los prototipos que conectan o consultan (una clase que ya está en manos de alguien, o que se hereda)
  envolver(net.Socket.prototype, 'connect', 'red', () => 'conexión');
  for (const m of [http, https]) envolver(m.Agent.prototype, 'createConnection', 'red', () => 'conexión');
  for (const n of ['send', 'connect', 'bind']) envolver(dgram.Socket.prototype, n, 'red', () => 'datagrama');
  for (const [R, promesa] of [[dns.Resolver, false], [dns.promises.Resolver, true]]) {
    for (const n of Object.getOwnPropertyNames(R.prototype)) {
      if (n === 'constructor' || ['getServers', 'setServers', 'setLocalAddress', 'cancel'].includes(n) || typeof R.prototype[n] !== 'function') continue;
      envolver(R.prototype, n, 'red', nombre, { promesa });
    }
  }
  envolver(globalThis, 'WebSocket', 'red', (args) => `websocket ${destino(args[0]).slice(0, 120)}`);
  envolver(globalThis, 'fetch', 'red', (args) => `fetch ${destino(args[0] instanceof Request ? args[0].url : args[0]).slice(0, 120)}`, { promesa: true });

  // los procesos: ni git ni nada (todo lo de child_process, también la clase y su `spawn`)
  const cp = require('child_process');
  cortarPorDefecto(cp, 'child_process', 'proceso', (args) => `proceso${args[0] === undefined ? '' : ` ${destino(args[0]).slice(0, 80)}`}`);
  envolver(cp.ChildProcess.prototype, 'spawn', 'proceso', () => 'proceso');
  // las puertas nativas del proceso: cargar un módulo nativo o pedir un enlace interno salta todo el freno (el sitio no las usa)
  for (const n of ['binding', 'dlopen']) envolver(process, n, 'proceso', () => 'puerta nativa');
  // y las escrituras nativas que no pasan por fs: el informe del proceso y la foto de la memoria (el sitio no las usa)
  if (process.report) envolver(process.report, 'writeReport', 'escritura', () => 'informe del proceso');
  envolver(require('v8'), 'writeHeapSnapshot', 'escritura', () => 'foto de la memoria');

  // el disco: ninguna escritura fuera de la carpeta temporal propia (leer sí). Todo lo que fs exporta y no es de lectura se juzga
  const escribe = (flags) => {
    if (typeof flags === 'number') return (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_TRUNC)) !== 0;
    // sólo un texto o un número son banderas: en `open(ruta, callback)` el segundo argumento es la función
    return typeof flags === 'string' && /[wa+]/.test(flags);
  };
  const fuera = ([indices, sigue]) => (args) => { for (const i of indices) if (args[i] !== undefined && !dentro(args[i], sigue)) return destino(args[i]).slice(0, 160); return null; };
  // un flujo de escritura con `fd` escribe en ese descriptor, sea cual sea la ruta: el descriptor tiene que ser de adentro; la ruta,
  // si viene, también
  const flujo = (spec) => (args) => {
    const o = args[1] !== null && typeof args[1] === 'object' ? args[1] : null;
    if (o && o.fd !== undefined && o.fd !== null && !dentro(o.fd)) return `descriptor ${String(o.fd).slice(0, 40)}`;
    if (args[0] === null || args[0] === undefined) return o && o.fd !== undefined && o.fd !== null ? null : fuera(spec)(args);
    return fuera(spec)(args);
  };
  // las de lectura que abren con una bandera (`readFile`, `createReadStream`…): si la bandera escribe, juzgan como una escritura
  const conBandera = (args) => {
    const o = args.find((x, i) => i > 0 && x !== null && typeof x === 'object' && !Buffer.isBuffer(x));
    const b = o ? (o.flag !== undefined ? o.flag : o.flags) : undefined;
    if (!escribe(b)) return null;
    if (o.fd !== undefined && o.fd !== null) return dentro(o.fd) ? null : `descriptor ${String(o.fd).slice(0, 40)}`;
    return fuera([[0], true])(args);
  };
  // el prefijo de `mkdtemp` + 6 letras: se juzga la carpeta donde crea, que con la propia ruta sin barra final queda AFUERA
  const prefijo = (args) => {
    if (args[0] === undefined) return null;
    const s = destino(args[0]);
    const padre = /[\\/]$/.test(s) ? path.resolve(s) : path.dirname(path.resolve(s));
    return dentro(padre) ? null : s.slice(0, 160);
  };
  // `cp` no copia enlaces: se salta los que haya en el origen (Node 24 los copia como enlace aun con `dereference`), así uno de
  // afuera no llega a la carpeta propia; el filtro de quien llama sigue valiendo
  const sinEnlaces = (spec) => (args) => {
    const m = fuera(spec)(args);
    if (m) return m;
    const a = args.slice();
    const propio = a[2] !== null && typeof a[2] === 'object' ? a[2].filter : undefined;
    const filtro = (origen, ...resto) => {
      let enlace; try { enlace = fs.lstatSync(origen).isSymbolicLink(); } catch { enlace = false; }
      if (enlace) return false;
      return typeof propio === 'function' ? propio(origen, ...resto) : true;
    };
    if (a[2] !== null && typeof a[2] === 'object') a[2] = { ...a[2], filter: filtro };
    else a.splice(2, 0, { filter: filtro });
    return a;
  };
  const porDescriptor = (args) => (dentro(args[0]) ? null : 'un descriptor abierto afuera');
  // un `open` que pasó el freno deja su descriptor anotado como de adentro (si la ruta lo era)
  const abre = (args) => (escribe(args[1]) ? fuera([[0], true])(args) : null);
  const abreCallback = (args) => {
    const m = abre(args);
    if (m) return m;
    const i = args.findLastIndex((x) => typeof x === 'function');
    if (i < 0) return null;
    const esDeAdentro = dentro(args[0]); const a = args.slice(); const cb = a[i];
    a[i] = (err, fd, ...resto) => { if (!err && esDeAdentro) fdsDentro.add(fd); return cb(err, fd, ...resto); };
    return a;
  };
  let manejadoresParchados = false;
  /** Las funciones de un `FileHandle` que no son de lectura sirven sólo a un manejador abierto adentro. */
  const parcharManejadores = (h) => {
    if (manejadoresParchados || !h) return;
    manejadoresParchados = true;
    deshacer.push(() => { manejadoresParchados = false; });
    const proto = Object.getPrototypeOf(h);
    for (const n of Object.getOwnPropertyNames(proto)) {
      if (n === 'constructor' || LECTURA_MANEJADOR.includes(n) || typeof Object.getOwnPropertyDescriptor(proto, n).value !== 'function') continue;
      envolver(proto, n, 'escritura', (args, self) => (manejadoresDentro.has(self) ? null : `un manejador abierto afuera (${n})`), { promesa: true });
    }
  };
  for (const [modulo, promesa] of [[fs, false], [fs.promises, true]]) {
    for (const n of nombresFrenables(modulo)) {
      const sync = !promesa && n.endsWith('Sync') && n !== 'Sync';
      const base = sync ? n.slice(0, -4) : n;
      const cfg = { promesa, vuelta: !promesa && !sync };
      if (base === 'open') {
        if (promesa) envolver(modulo, n, 'escritura', abre, { promesa, despues: (h, args) => { parcharManejadores(h); if (dentro(args[0])) manejadoresDentro.add(h); } });
        else if (sync) envolver(modulo, n, 'escritura', abre, { despues: (fd, args) => { if (dentro(args[0])) fdsDentro.add(fd); } });
        else envolver(modulo, n, 'escritura', abreCallback, { vuelta: true });
      } else if (base === 'close') {
        if (!promesa) envolver(modulo, n, 'escritura', (args) => { fdsDentro.delete(args[0]); return null; });
      } else if (base === 'openAsBlob') envolver(modulo, n, 'escritura', fuera([[0], true]), { promesa: true });
      else if (CON_BANDERA.includes(base)) envolver(modulo, n, 'escritura', conBandera, cfg);
      else if (LECTURA_FS.includes(base)) continue;
      else if (base === 'cp') envolver(modulo, n, 'escritura', sinEnlaces(TABLA.cp), cfg);
      else if (base === 'createWriteStream' || base === 'WriteStream' || base === 'FileWriteStream') envolver(modulo, n, 'escritura', flujo(TABLA[base]), cfg);
      else if (base === 'truncate') envolver(modulo, n, 'escritura', (args) => (typeof args[0] === 'number' ? porDescriptor(args) : fuera(TABLA.truncate)(args)), cfg);
      else if (TABLA[base]) envolver(modulo, n, 'escritura', fuera(TABLA[base]), cfg);
      else if (DE_PREFIJO.includes(base)) envolver(modulo, n, 'escritura', prefijo, cfg);
      else if (POR_DESCRIPTOR.includes(base)) envolver(modulo, n, 'escritura', porDescriptor, cfg);
      else if (base === 'symlink' || base === 'link') envolver(modulo, n, 'escritura', () => 'un enlace', cfg);
      // una función de fs que el freno no conoce (también una que Node agregue): se bloquea
      else envolver(modulo, n, 'escritura', () => 'no está entre lo permitido', cfg);
    }
  }

  activo = {
    dir: raiz, intentos, faltantes,
    quitar() { while (deshacer.length) deshacer.pop()(); activo = null; },
  };
  return activo;
}

/**
 * El freno del proceso del sitio: crea la carpeta temporal propia (todo lo temporal del proceso va adentro: `TMPDIR` apunta
 * ahí) y la borra al salir. Lo llama server.js al cargarse, antes que nada.
 */
function frenoTemprano() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-demo-'));
  process.env.TMPDIR = dir; process.env.TMP = dir; process.env.TEMP = dir;
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* al salir no hay a quién avisar */ } });
  // mientras no hay registro del sitio, cada intento va a la salida de error (el sitio lo suma al registro al arrancar)
  alIntentar((i) => process.stderr.write(`freno: ${i.tipo}: ${i.detalle}\n`));
  return ponerFreno({ dir });
}

module.exports = { ponerFreno, frenoTemprano, frenoActual, alIntentar, PERMITIDAS, LECTURA_FS };
