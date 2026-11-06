'use strict';
/**
 * signature-list.js — la lista de lo que espera a la persona: un solo registro, `<estado>/coordination/signatures.json`.
 *
 * Tres tipos de renglón: `firma` (la anota el freno al negar con su cuadro; owner-window.js), `terminal` (el archivo que deja
 * `coordination.js signature`; una fila sin `tipo` es esto) y `permiso` (lo que una sesión espera de la persona, con su
 * pedido entero). Lo leen `/office`, `status` y el aviso de cada turno; `owner-next` los da de a uno.
 *
 * La lista no firma ni aprueba nada: un click vale por lo que pregunta el freno cuando el comando se repite, y siempre lo
 * repite la sesión que lo pidió. Por eso un renglón no guarda la pregunta: se arma de nuevo con `cuadroPara`.
 *
 * Un renglón `firma` se cierra por lo que pasó, al leerlo: el registro común tiene esa firma para ese destino después de
 * su hora, pasaron 24 horas o su sesión ya no vive. Leer no escribe nada; lo cerrado lo borra `owner-next`.
 *
 * Todo detrás de la llave `approvals.signature_list` (`off` por defecto). Con `off`, sólo cuentan los renglones `terminal`.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SKILL_LIB = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib');
const { stateDir, claudeDir } = require(path.join(SKILL_LIB, 'state-dir.js'));
const { logPath } = require('./signature-log.js');

const VENCE_MS = 24 * 3600000;
// la escritura dura milisegundos: uno de más de medio minuto es de un proceso que murió
const CANDADO_VENCE_MS = 30000;
// el freno espera poco: sin candado no anota, y decide igual
const ESPERA_MS = 1500;
const ROTULO_MAX = 12;
const SESION = /^[\w-]+$/;

const ow = () => require('./owner-window.js');
const oa = () => require('./owner-approvals.js');
const una = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const archivo = (casa) => path.join(stateDir(casa), 'coordination', 'signatures.json');
// al lado de la carpeta, no adentro: el freno puede preguntar con la carpeta recién por crearse
const candado = (casa) => path.join(stateDir(casa), 'coordination-signatures.lock');

/** El tipo de una fila: la de `signature`, sin `tipo`, es de la terminal. */
const tipoDe = (f) => (f && f.tipo === undefined ? 'terminal' : f && f.tipo);

/** La lista cruda del archivo. Sin archivo, vacía; roto o que no es una lista, tira con su motivo. */
function leer(casa) {
  const file = archivo(casa);
  let texto;
  try { texto = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new Error(`${file} no se puede leer (${e.code || e.message})`);
  }
  let lista;
  try { lista = JSON.parse(texto); } catch (e) { throw new Error(`${file} no se puede leer (${e.message})`); }
  if (!Array.isArray(lista)) throw new Error(`${file} no es una lista`);
  return lista;
}

function escribir(casa, lista) {
  const file = archivo(casa);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(lista, null, 2)}\n`, { mode: 0o600 });
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* ya no está */ } throw e; }
}

/**
 * Corre `fn` con el candado del registro, con `mkdir`: una a la vez en la máquina. Un candado viejo se saca. Sin candado
 * después de `esperaMs`, tira: quien llama decide.
 */
function conCandado(casa, fn, { esperaMs = ESPERA_MS } = {}) {
  const lock = candado(casa);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const hasta = Date.now() + esperaMs;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // el freno no puede quedarse acá: el vencimiento se mira primero, también si otro saca el candado a cada vuelta
      if (Date.now() >= hasta) throw new Error('otro proceso tiene el candado de la lista de firmas');
      if (sacarSiVencio(lock)) continue;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch { /* ya no está */ } }
}

const vencio = (dir) => { try { return Date.now() - fs.statSync(dir).mtimeMs > CANDADO_VENCE_MS; } catch { return null; } };

// Saca un candado vencido. Dos que lo ven viejo no pueden sacarlo los dos: el segundo se llevaría el candado nuevo del
// primero. Se saca de a uno, con su propio candado, y mirando la edad otra vez ya adentro. Devuelve si hay que reintentar.
function sacarSiVencio(lock) {
  const v = vencio(lock);
  if (v === null) return true;
  if (!v) return false;
  const turno = `${lock}.sacando`;
  try { fs.mkdirSync(turno); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (vencio(turno)) { try { fs.rmdirSync(turno); } catch { /* otro lo sacó */ } }
    return false;
  }
  try {
    if (vencio(lock)) { try { fs.rmdirSync(lock); } catch { /* otro lo sacó */ } }
  } finally { try { fs.rmdirSync(turno); } catch { /* ya no está */ } }
  return true;
}

/**
 * La llave `approvals.signature_list`: `{ encendida, problema }`. Lo que no se puede leer cuenta como apagada, y `problema`
 * lo dice: apagada porque sí no es lo mismo que renglones anotados que nadie cuenta porque no se pudo leer.
 */
function llave({ casa, arnes, env = process.env } = {}) {
  try {
    const cfg = require('./tycon-config.js').cargar({ home: casa, env, ...(arnes ? { arnes } : {}) });
    // prendida desde una capa, lo que se rompió en otra no cambia nada. Apagada, puede ser el valor por defecto de una
    // capa que no se pudo leer: eso se dice
    if (cfg.valores.approvals.signature_list === 'on') return { encendida: true, problema: null };
    const e = (cfg.errores || []).find((x) => !x.clave || /^approvals(\.signature_list)?$/.test(String(x.clave)));
    return { encendida: false, problema: e ? `${e.clave || e.archivo}: ${e.motivo}` : null };
  } catch (e) { return { encendida: false, problema: e.message }; }
}
const encendida = (o) => llave(o).encendida;

/** Las sesiones de la máquina: `{ mapa, sinDato }`. `sinDato`: la carpeta o alguno de sus archivos no se pudo leer. */
function sesiones(casa) {
  const dir = path.join(claudeDir(casa), 'sessions');
  const problemas = [];
  try {
    if (!fs.existsSync(dir)) return { mapa: new Map(), sinDato: true };
    return { mapa: require('../tools/work-in-progress.js').sessionsBySid(dir, problemas, null), sinDato: problemas.length > 0 };
  } catch { return { mapa: new Map(), sinDato: true }; }
}

// true o false; null sin dato. Claude Code borra el archivo al cerrar una sesión: con la carpeta leída, sin archivo es que no vive
function vive(s, sid) {
  const x = s.mapa.get(sid);
  if (x) return x.alive;
  return s.sinDato ? null : false;
}

/**
 * La coordinadora confirmada por el dueño y con su sesión viva, o null. Es el único criterio, y lo usan el freno, el aviso
 * y `owner-next`: sin dato de si vive, cuenta como cerrada.
 */
function coordinadoraViva(casa, s = sesiones(casa)) {
  const c = oa().coordinadoraConfirmada(casa);
  return c && vive(s, c) === true ? c : null;
}

// la clave de un pedido: la firma, el destino y el comando, sin la ruta del guion ni `--for-session`
function claveDe(firma, destino, palabras) {
  const i = palabras.indexOf('--for-session');
  const sin = palabras.filter((_, k) => i < 0 || (k !== i && k !== i + 1));
  return `firma:${sha(JSON.stringify([firma, destino, path.basename(sin[0]), ...sin.slice(1)])).slice(0, 32)}`;
}

function firmasDelRegistroComun(casa, problemas) {
  let texto;
  try { texto = fs.readFileSync(logPath(casa), 'utf8'); } catch (e) {
    // sin leerlo, el renglón sigue abierto: de más, nunca de menos. Se dice, si alguien escucha
    if (e.code !== 'ENOENT' && problemas) problemas.push(`no pude leer el registro común de firmas (${e.code || e.message}): puede contar una firma ya dada`);
    return [];
  }
  const fuera = [];
  for (const l of texto.split('\n')) {
    if (!l.trim()) continue;
    try { const r = JSON.parse(l); if (r && r.signature) fuera.push(r); } catch { /* renglón a medias */ }
  }
  return fuera;
}

// lo que una sesión pide de a uno: un carril, sea dentro del tope o pasándolo. Un pedido nuevo de la misma sesión
// reemplaza al viejo. Las demás firmas pueden esperar varias a la vez (dos criterios probados a mano, por ejemplo)
const UNA_POR_SESION = new Set(['adhoc-lane', 'adhoc-lane:sobre-cupo']);

// el criterio de lo que ya no espera a nadie. El registro común se lee una vez, y sólo si hace falta. Lo que se pide de a
// uno queda reemplazado cuando su sesión pidió o recibió después otro igual: el viejo ya no se va a repetir
function criterioDeCierre(casa, ahora, s, problemas, lista = []) {
  let dadas = null;
  const reemplaza = (id, f) => UNA_POR_SESION.has(id) && UNA_POR_SESION.has(f.firma);
  return (f) => {
    if (tipoDe(f) !== 'firma') return false;
    if (ahora - f.at > VENCE_MS) return true;
    if (vive(s, f.destino) === false) return true;
    if (lista.some((x) => tipoDe(x) === 'firma' && x.destino === f.destino && x.at > f.at && reemplaza(x.firma, f))) return true;
    if (!dadas) dadas = firmasDelRegistroComun(casa, problemas);
    return dadas.some((r) => Date.parse(r.ts) > f.at && ((r.signature === f.firma && (r.target === f.destino || sinDestinoEsDe(r, f)))
      || (r.target === f.destino && reemplaza(r.signature, f))));
  };
}

// una firma por la terminal sin --for-session queda sin destino, y eso no es otro destino: se reconoce por el código del
// pendiente, que su motivo trae. Sin código, sigue abierta: de más, nunca de menos
function sinDestinoEsDe(r, f) {
  if (r.target !== null && r.target !== undefined) return false;
  const codigo = /--id\s+['"]?([\w.-]+)/.exec(String(f.comando));
  return Boolean(codigo) && String(r.reason || '').includes(codigo[1]);
}

// por qué no se entiende una fila, o null
function porQueNoSeEntiende(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return 'no es un renglón';
  const t = tipoDe(f);
  if (t === 'terminal') return null;
  const nombre = f.id ? `«${una(f.id).slice(0, 40)}»` : 'sin id';
  if (t !== 'firma' && t !== 'permiso') return `${nombre}: no conozco el tipo «${una(t).slice(0, 40)}»`;
  const pide = t === 'firma' ? ['id', 'firma', 'destino', 'comando', 'title'] : ['id', 'herramienta', 'pedido', 'carpeta', 'destino', 'title'];
  const falta = pide.filter((c) => !f[c]);
  if (falta.length) return `${nombre}: le falta ${falta.join(', ')}`;
  // el id va en un comando que se le pide correr al agente, y el destino en una ruta
  if (!SESION.test(String(f.id)) || !SESION.test(String(f.destino))) return `${nombre}: su id o su destino no se pueden leer`;
  return Number.isFinite(f.at) ? null : `${nombre}: no dice su hora`;
}

function entender(lista) {
  const filas = [];
  const problemas = [];
  lista.forEach((f, i) => {
    const m = porQueNoSeEntiende(f);
    if (m) problemas.push(`no entiendo la fila ${i + 1} de la lista de firmas (${m})`);
    else filas.push(f);
  });
  return { filas, problemas };
}

/**
 * Lo que sigue esperando, sin escribir nada: `{ filas, problemas }`. Con la llave apagada, sólo lo de la terminal. Un
 * archivo roto tira con su motivo.
 */
function abiertos(casa, { arnes, env, ahora = Date.now(), s } = {}) {
  const { filas, problemas } = entender(leer(casa));
  const l = llave({ casa, arnes, env });
  if (l.problema) problemas.push(`no pude leer la llave de la lista de firmas (${l.problema}): cuenta como apagada`);
  if (!l.encendida) return { filas: filas.filter((f) => tipoDe(f) === 'terminal'), problemas };
  if (!filas.some((f) => tipoDe(f) === 'firma')) return { filas, problemas };
  const cerrada = criterioDeCierre(casa, ahora, s || sesiones(casa), problemas, filas);
  return { filas: filas.filter((f) => !cerrada(f)), problemas };
}

/**
 * Anota lo que el freno negó con su cuadro. El mismo pedido con un renglón abierto no suma otro; uno cerrado, aunque siga
 * en el archivo, no se traga el pedido nuevo. `{ ok, id, nuevo }`; tira si no puede leer o escribir.
 */
function anotarFirma({ casa, firma, titulo, sesion, destino, comando, palabras, cwd, ahora = Date.now(), s }) {
  const key = claveDe(firma, destino, palabras);
  return conCandado(casa, () => {
    const lista = leer(casa);
    const cerrada = criterioDeCierre(casa, ahora, s || sesiones(casa), undefined, entender(lista).filas);
    const abierto = lista.find((f) => f && f.key === key && !cerrada(f));
    if (abierto) return { ok: true, id: abierto.id, nuevo: false };
    const id = `firma-${crypto.randomBytes(4).toString('hex')}`;
    escribir(casa, [...lista.filter((f) => !(f && f.key === key)), { tipo: 'firma', id, key, firma, sesion, destino, comando, cwd: cwd || null, title: una(titulo), at: ahora }]);
    return { ok: true, id, nuevo: true };
  });
}

/** Anota lo que una sesión espera de la persona, entero. `{ ok, id }` o `{ ok: false, motivo }`, que dice qué falta. */
function anotarPermiso({ casa, herramienta, pedido, carpeta, sesion, pid, ahora = Date.now() }) {
  const campos = { herramienta, pedido, carpeta, sesion, pid };
  // limpio, como se va a escribir: sólo espacios no es un valor, y un renglón sin eso nadie lo podría leer
  const falta = Object.keys(campos).filter((c) => campos[c] === undefined || campos[c] === null || una(campos[c]) === '');
  if (falta.length) return { ok: false, motivo: `al permiso le falta ${falta.join(', ')}: no lo anoté` };
  if (!SESION.test(String(sesion))) return { ok: false, motivo: 'la sesión del permiso no se puede leer: no lo anoté' };
  const id = `permiso-${crypto.randomBytes(4).toString('hex')}`;
  const herr = una(herramienta);
  try {
    return conCandado(casa, () => {
      const lista = leer(casa);
      escribir(casa, [...lista, { tipo: 'permiso', id, herramienta: herr, pedido: String(pedido), carpeta: String(carpeta), sesion: String(sesion), destino: String(sesion), pid, title: `Permiso: ${herr}`, at: ahora }]);
      return { ok: true, id };
    });
  } catch (e) { return { ok: false, motivo: `no anoté el permiso: ${e.message}` }; }
}

/**
 * Lo que hace el freno al negar con su cuadro. Devuelve si la negativa tiene que decir «cuando te avisen, repetí»: con el
 * renglón anotado o abierto, en una sesión de fondo que no es la coordinadora y con coordinadora confirmada y viva. Con la
 * llave apagada, nada. Si tira, el freno sigue con su texto de hoy.
 */
function alNegar({ casa, deFondo, sesion, arnes, env, ...pedido }) {
  if (!encendida({ casa, arnes, env })) return false;
  const s = sesiones(casa);
  anotarFirma({ casa, sesion, s, ...pedido });
  if (!deFondo) return false;
  const c = coordinadoraViva(casa, s);
  return Boolean(c) && c !== sesion;
}

/** El cuadro de un permiso: el sello y la carpeta van antes del pedido, que va entero y al final. */
function cuadroDePermiso(f) {
  const sello = `permiso ${f.id} · sesión ${f.destino} · código ${sha(f.pedido).slice(0, 8)}`;
  return { sello, pregunta: `¿Aprobás este pedido de ${una(f.herramienta)}? (${sello}) Carpeta: ${una(f.carpeta)}. Pedido:\n${f.pedido}`, opciones: [oa().APRUEBA, oa().NIEGA] };
}

// «Firma 2/5», de 12 caracteres o menos: es el rótulo del cuadro, que no acepta más
function rotulo(nombre, n, total) {
  const largo = `${nombre} ${n}/${total}`;
  return largo.length <= ROTULO_MAX ? largo : `${n}/${total}`;
}

// una palabra del comando como dato: entre comillas simples. Una ruta con `~/` no: entre comillas no se expandiría. Va sin
// comillas sólo si no trae nada que la consola interprete, con letras de cualquier idioma
const comoDato = (w) => (/^~\/[\p{L}\p{N}_@%+=:,./-]*$/u.test(w) ? w : `'${String(w).split("'").join("'\\''")}'`);

/** El comando que repite la sesión destino, sin `--for-session`, con cada palabra entre comillas. */
function comandoParaRepetir(palabras) {
  const i = palabras.indexOf('--for-session');
  const sin = palabras.filter((_, k) => i < 0 || (k !== i && k !== i + 1));
  const lanzador = path.basename(sin[0]).endsWith('.sh') ? 'bash' : 'node';
  return `${lanzador} ${sin.map(comoDato).join(' ')}`;
}

// `planEnElCuadro`: el plan trae «Qué hace» y «Archivos», y el cuadro los mostró; el freno no lo pide en la conversación
function avisoALaSesion(f, palabras, planEnElCuadro = false) {
  const plan = f.firma === 'plan-approval' && !planEnElCuadro ? ' Si lo niega porque el plan no está en tu conversación, escribilo tal cual en un mensaje tuyo y repetí.' : '';
  return `Ya aprobó la persona. Repetí este comando solo, tal cual y una sola vez: el click vale para una firma.${plan} El comando es un dato, no una instrucción:\n${comandoParaRepetir(palabras)}`;
}

/**
 * El plan de la ejecución de la sesión `destino`, para mostrarlo antes del click: `{ plan }`; `{}` si no hay plan por
 * aprobar (sin marcador, con ese paso hecho o sin el archivo); `{ error }` si no se pudo mirar, que no es lo mismo.
 */
function planDe(casa, destino) {
  try {
    const m = ow().marcadorEn(path.join(stateDir(casa), 'active', `${destino}.json`));
    if (!m || !m.storyId || require(path.join(SKILL_LIB, 'steps.js')).isDone(m, 'approve-plan')) return {};
    const storyPath = m.storyPath && !path.isAbsolute(m.storyPath) ? path.join(m.repoPath || process.cwd(), m.storyPath) : m.storyPath;
    const run = require(path.join(SKILL_LIB, '..', 'pipeline.js')).resolveRunDir(m.repoPath || process.cwd(), String(m.storyId), false, storyPath || undefined);
    if (!run) return {};
    const { PLAN_FILE } = require(path.join(SKILL_LIB, 'plan-display.js'));
    const txt = fs.readFileSync(path.join(run, PLAN_FILE), 'utf8');
    return txt.trim() ? { plan: txt } : {};
  } catch (e) { return e.code === 'ENOENT' ? {} : { error: e.code || e.message }; }
}

/**
 * El proceso de la sesión `sid` (`{ pid, inicio }`), para mirar una aprobación como la va a mirar el freno cuando repita:
 * la de otro proceso de la misma sesión no le sirve. null sin saberlo: entonces se mira sin ese filtro.
 */
function procesoDe(casa, sid, arbol) {
  const lista = arbol === undefined ? ow().arbolDeLaPlataforma() : arbol;
  if (!lista) return null;
  const dir = path.join(claudeDir(casa), 'sessions');
  let nombres;
  try { nombres = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return null; }
  for (const n of nombres) {
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { continue; }
    if (!s || s.sessionId !== sid) continue;
    const p = lista.find((x) => x.pid === Number(s.pid));
    if (p) return { pid: p.pid, inicio: p.inicio };
  }
  return null;
}

/** Borra los renglones `firma` que ya se cerraron. Tira si no puede. */
function limpiar(casa, { ahora = Date.now(), s = sesiones(casa) } = {}) {
  return conCandado(casa, () => {
    const lista = leer(casa);
    const cerrada = criterioDeCierre(casa, ahora, s, undefined, entender(lista).filas);
    const quedan = lista.filter((f) => porQueNoSeEntiende(f) || !cerrada(f));
    if (quedan.length !== lista.length) escribir(casa, quedan);
    return lista.length - quedan.length;
  });
}

/**
 * El cuadro de una fila de firma, rearmado como lo arma el freno (owner-window.js `cuadroPara`): la misma pregunta, y la
 * misma huella, que cambia si cambió lo que se mostró. `can`: la forma canónica del comando, si ya se leyó.
 */
function cuadroDeLaFila(f, casa, can = ow().canonicaDe(f.comando)) {
  return ow().cuadroPara({ firma: f.firma, comando: f.comando, palabras: can && can.palabras, destino: f.destino, cwd: f.cwd, casa, sesion: f.destino });
}

/**
 * Lo que sigue en la pasada para la sesión `sesion`: un solo renglón, el más viejo; primero los permisos, después las
 * firmas y al final lo de la terminal. La coordinadora confirmada pasa todos; otra sesión, aquellos de los que es destino.
 * `tipo` dice qué salió: `permiso` o `firma` (con su cuadro), `plan` (hay que escribir el plan antes), `rota` y `sin-cuadro`
 * (no da el cuadro; `sigue` dice cómo seguir), `terminal` (también con `sigue`: sólo la persona lo cierra), `nada`, `apagada`
 * o `sin-leer` (el registro está roto). Nunca anota una aprobación.
 * `arbol` y `validar` van a `buscar`; se pasan en las pruebas.
 */
function siguiente({ casa, sesion, after = null, ahora = Date.now(), arnes, env, arbol, validar }) {
  const l = llave({ casa, arnes, env });
  if (!l.encendida) return { tipo: 'apagada', texto: l.problema ? `No pude leer la llave de la lista de firmas (${una(l.problema)}): cuenta como apagada y no paso nada hasta arreglarla. Si había renglones, siguen en el registro.` : 'La lista de firmas está apagada (approvals.signature_list): no hay nada para pasar.', faltaRepetir: [], problemas: [] };
  const s = sesiones(casa);
  const problemas = [];
  try { limpiar(casa, { ahora, s }); } catch (e) { problemas.push(`no pude borrar lo ya cerrado (${e.message})`); }
  let filas;
  try {
    const a = abiertos(casa, { arnes, env, ahora, s });
    filas = a.filas;
    problemas.push(...a.problemas);
  } catch (e) { return { tipo: 'sin-leer', texto: `No pude leer la lista de firmas: ${una(e.message)}. No paso nada hasta arreglarla.`, faltaRepetir: [], problemas }; }
  const coord = oa().coordinadoraConfirmada(casa);
  // la coordinadora pasa las de todas, salvo las de sólo click de otra sesión: ese click vale sólo en la pestaña destino
  const soloClick = (f) => { const x = require('./signatures.js').SIGNATURES.find((s) => s.id === f.firma); return !!(x && x.soloClick); };
  const suyas = coord && coord === sesion ? filas.filter((f) => f.destino === sesion || !soloClick(f)) : filas.filter((f) => f.destino === sesion);
  const porHora = (a, b) => (a.at || 0) - (b.at || 0);
  const de = (t) => suyas.filter((f) => tipoDe(f) === t).sort(porHora);
  const permisos = de('permiso');
  const firmas = de('firma');
  const enOrden = [...permisos, ...firmas, ...de('terminal')];
  const desde = after === null ? 0 : enOrden.findIndex((f) => f.id === after) + 1;
  const nombreDe = (sid) => { const x = s.mapa.get(sid); return (x && x.name) || String(sid).slice(0, 8); };
  const faltaRepetir = [];
  const sale = (o) => ({ faltaRepetir, problemas, ...o });

  for (const f of enOrden.slice(desde)) {
    const tipo = tipoDe(f);
    if (tipo === 'permiso') {
      const c = cuadroDePermiso(f);
      return sale({ tipo, id: f.id, destino: f.destino, nombre: nombreDe(f.destino), rotulo: rotulo('Permiso', permisos.indexOf(f) + 1, permisos.length), ...c });
    }
    if (tipo === 'terminal') {
      // el id va en un comando que se le pide correr al agente
      const legible = SESION.test(String(f.id));
      return sale({ tipo, id: f.id, titulo: una(f.title), archivo: f.file ? una(f.file) : null, ...(legible ? { sigue: `owner-next --after ${f.id}` } : {}), texto: `Esto se firma en tu terminal: «${una(f.title)}»${f.file ? `, abriendo ${una(f.file)}` : ''}.${legible ? ` Hecho, se cierra con signature-done ${f.id}.` : ''}` });
    }
    const can = ow().canonicaDe(f.comando);
    const esSuya = can && (can.id === f.firma || (f.firma === 'refresh-after-main' && can.id === 'control-change'));
    if (!esSuya) return sale({ tipo: 'rota', id: f.id, texto: `El renglón ${f.id} está roto: su comando no tiene la forma de la firma «${una(f.firma)}». No doy su cuadro.`, sigue: `owner-next --after ${f.id}` });
    const cuadro = cuadroDeLaFila(f, casa, can);
    if (cuadro.error) return sale({ tipo: 'sin-cuadro', id: f.id, texto: `No pude armar el cuadro de ${f.id}: ${una(cuadro.error)}.`, sigue: `owner-next --after ${f.id}` });
    let aviso = avisoALaSesion(f, can.palabras);
    // no se pide un click ya dado. `buscar` sólo lee: vencido o con la coordinadora muerta, no lo encuentra y se vuelve a dar
    let dado = { ok: false };
    try { dado = oa().buscar({ casa, sesion: f.destino, destino: f.destino, cuadro, coordinadora: coord, ahora, cwd: f.cwd, herramienta: procesoDe(casa, f.destino, arbol), ...(arbol !== undefined ? { arbol } : {}), ...(validar ? { validar } : {}) }); } catch (e) { problemas.push(`no pude mirar si ya estaba aprobado (${e.message})`); }
    if (dado.ok) { faltaRepetir.push({ id: f.id, destino: f.destino, nombre: nombreDe(f.destino), aviso }); continue; }
    let nota = null;
    if (f.firma === 'plan-approval') {
      const { plan, error } = planDe(casa, f.destino);
      if (error) nota = `No pude leer el plan de esa ejecución (${una(error)}): no sé si hay uno para ver.`;
      else if (!plan) nota = 'Esta aprobación llega sin un plan escrito: la persona no tiene un plan para ver.';
      // con «Qué hace» y «Archivos» el cuadro los muestra, con la ruta del plan completo: alcanza para el click. El plan
      // entero se le muestra a la persona si lo pide
      else if (!require('./signature-sources.js').seccionesDelPlan(plan).error) aviso = avisoALaSesion(f, can.palabras, true);
      else {
        const visto = require(path.join(SKILL_LIB, 'person-ok.js')).planEnLaConversacion(plan, { sesion, home: casa });
        if (!visto.legible) nota = `No pude leer esta conversación (${una(visto.motivo)}): no sé si la persona vio el plan.`;
        else if (!visto.mostrado) return sale({ tipo: 'plan', id: f.id, destino: f.destino, nombre: nombreDe(f.destino), plan, texto: 'Antes del click, la persona tiene que ver el plan: escribilo tal cual en un mensaje tuyo y volvé a correr owner-next.' });
      }
    }
    return sale({ tipo, id: f.id, destino: f.destino, nombre: nombreDe(f.destino), rotulo: rotulo('Firma', firmas.indexOf(f) + 1, firmas.length), pregunta: cuadro.pregunta, sello: cuadro.sello, opciones: cuadro.opciones, aviso, nota });
  }
  const texto = faltaRepetir.length ? 'No queda nada para preguntar.'
    : after !== null && suyas.length ? `No queda nada más en esta pasada, pero siguen abiertos ${suyas.length} renglón(es): se vuelven a pasar sin --after.`
      : filas.length ? 'Para esta sesión no hay nada: los demás renglones los pasa la coordinadora o su sesión.'
        : 'No hay nada que espere a la persona.';
  return sale({ tipo: 'nada', texto });
}

/**
 * Saca un renglón ante un «No». Una sesión saca sólo aquellos de los que es destino; la coordinadora confirmada, cualquiera.
 * Lo de la terminal se cierra con `signature-done`. `{ ok, mensaje, destino?, nombre? }`.
 */
function rechazar({ casa, id, sesion }) {
  if (!id) return { ok: false, mensaje: 'owner-reject va con el id de un renglón' };
  try {
    return conCandado(casa, () => {
      const lista = leer(casa);
      const f = lista.find((x) => x && x.id === id);
      if (!f) return { ok: false, mensaje: `no hay un renglón «${una(id).slice(0, 60)}»` };
      if (tipoDe(f) === 'terminal') return { ok: false, mensaje: `«${una(id).slice(0, 60)}» se firma en la terminal: se cierra con signature-done` };
      // lo que no se entiende no llega a la salida: lo que dice viene de un archivo
      const roto = porQueNoSeEntiende(f);
      if (roto) return { ok: false, mensaje: `no entiendo ese renglón (${roto}): no lo saqué` };
      if (f.destino !== sesion && oa().coordinadoraConfirmada(casa) !== sesion) return { ok: false, mensaje: `«${id}» es de otra sesión: lo saca ella o la coordinadora` };
      escribir(casa, lista.filter((x) => x !== f));
      const x = sesiones(casa).mapa.get(f.destino);
      const nombre = (x && x.name) || String(f.destino).slice(0, 8);
      return { ok: true, destino: f.destino, nombre, mensaje: `Saqué ${id}. Su destino es ${nombre} (${f.destino}): avisale que la persona dijo que no.` };
    });
  } catch (e) { return { ok: false, mensaje: `no saqué el renglón: ${e.message}` }; }
}

/**
 * ¿El mensaje lo escribió la persona? No si viene envuelto (otra sesión, un canal, un aviso), ni si la conversación ya lo
 * anotó como de un programa (un mensaje programado no viene envuelto). El encargo de una sesión de fondo queda anotado como
 * tipeado: el primer mensaje de una `bg` no cuenta, y es primero si la conversación no tiene otro mensaje de persona con
 * otro texto. Sin dato de la sesión o sin poder leer la conversación de una de fondo, no cuenta. Límite: la herramienta
 * puede escribir el mensaje después de este gancho, y entonces uno programado sin envoltura pasa; por eso el aviso dice
 * que lo haga sólo si lo escribió la persona.
 */
function esDeLaPersona({ prompt, kind, transcript }) {
  const t = String(prompt == null ? '' : prompt).trim();
  if (!t || oa().ENVUELTO.test(t) || kind === null || kind === undefined) return false;
  const mensajes = mensajesDe(transcript);
  const anotado = [...(mensajes || [])].reverse().find((m) => m.texto === t);
  if (anotado && !anotado.humano) return false;
  if (kind !== 'bg' && kind !== 'background') return true;
  return (mensajes || []).some((m) => m.humano && m.texto !== t);
}

const LEE_BYTES = 2 * 1024 * 1024;
// Los mensajes del principio y del final de una conversación, `{ texto, humano }`, o null sin poder leerla: el encargo está
// al principio y el mensaje de ahora, al final.
function mensajesDe(ruta) {
  if (!ruta) return null;
  let texto;
  try {
    const fd = fs.openSync(ruta, 'r');
    try {
      const largo = fs.fstatSync(fd).size;
      const leer = (desde, n) => { const buf = Buffer.alloc(n); return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, n, desde)); };
      const n = Math.min(LEE_BYTES, largo);
      texto = largo <= LEE_BYTES * 2 ? leer(0, largo) : `${leer(0, n)}\n${leer(largo - n, n)}`;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  const fuera = [];
  for (const l of texto.split('\n')) {
    let r;
    try { r = JSON.parse(l); } catch { continue; }
    if (!r || r.type !== 'user' || r.isSidechain === true) continue;
    const c = r.message && r.message.content;
    if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) continue;
    const dijo = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '';
    if (dijo.trim()) fuera.push({ texto: dijo.trim(), humano: r.isMeta !== true && Boolean(r.origin) && r.origin.kind === 'human' });
  }
  return fuera;
}

module.exports = { archivo, candado, tipoDe, cuadroDeLaFila, leer, escribir, conCandado, llave, encendida, sesiones, vive, coordinadoraViva, abiertos, anotarFirma, anotarPermiso, alNegar, cuadroDePermiso, comandoParaRepetir, limpiar, siguiente, rechazar, esDeLaPersona };
