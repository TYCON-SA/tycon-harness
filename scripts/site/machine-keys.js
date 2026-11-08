'use strict';
/*
 * machine-keys.js — LA CLAVE DE CADA MÁQUINA EN EL SITIO: el pedido de alta, la aprobación, el vencimiento y la baja.
 *
 * Una máquina pide el alta sola, con su clave pública. El pedido no prueba de quién es: el nombre que trae es sólo una
 * pista. Lo que ata la clave a una máquina es que la misma huella llegó por el buzón, en la carpeta de una máquina
 * confirmada, y quien mantiene aprueba ese par. Sin buzón no se aprueba.
 *
 * Una clave está en uno de estos estados:
 *   pendiente  pidió el alta. Cada intento de conexión firmado la renueva; vence a los 7 días sin renovar
 *   aprobada   conecta. Vence a los 30 días sin conectarse
 *   rechazada  no conecta. Quien mantiene la rechazó, o la máquina está de baja
 *   vencida    el sitio la olvidó a propósito: contesta 4404 y la máquina arma otra. Se conserva mientras su huella siga en
 *              el buzón, para que no cuente como vigente en el conflicto de dos huellas
 *
 * La baja es de la máquina, no de la clave: una clave nueva de esa máquina se rechaza sola en cuanto el buzón dice de quién
 * es, y al reactivarla vuelve con la clave que tenía.
 *
 * Vive en `<dataDir>/office/machine-keys.json`, escrito entero y de una vez. Sin disco del sitio, un reinicio lo pierde y
 * cada máquina vuelve a pedir el alta. Nada de acá guarda el contenido de una foto, ni una dirección en claro.
 *
 * Casos: scripts/tests/site-live-hub.test.js
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CLOSE, fingerprintOf } = require('../tools/office/fields.js');

const DIA = 24 * 60 * 60 * 1000;
const HORA = 60 * 60 * 1000;
const TOPES_ALTA = Object.freeze({ porHora: 5, pendientesPorDireccion: 20, pendientesTotal: 500, bytes: 2048, nombre: 64 });
const PLAZOS_ALTA = Object.freeze({ pendienteMs: 7 * DIA, aprobadaMs: 30 * DIA, vencidaMs: 90 * DIA });
const COPIADA = Object.freeze({ desplazamientos: 10, ventanaMs: HORA });
// lo que las direcciones recuerdan de la última hora: uno que abusa con muchas no llena la memoria
const DIRECCIONES_MAX = 10000;
const ED25519_BYTES = 32;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const HUELLA = /^[0-9a-f]{64}$/;

const hashDe = (texto) => crypto.createHash('sha256').update(String(texto)).digest('hex').slice(0, 16);
const limpiarNombre = (nombre) => (nombre == null ? '' : nombre).replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, TOPES_ALTA.nombre);
// el registro dice quién sin llevar su correo; el disco del sitio guarda el correo
const quienEnElRegistro = (por) => `quien mantiene ${hashDe(por).slice(0, 8)}`;
// sin prototipo: el nombre de una máquina lo elige la máquina, y `constructor` no puede figurar de baja
const mapa = (o) => Object.assign(Object.create(null), o);

function crearLlaves({ dataDir, ahora = Date.now, log = () => {}, topes = {} }) {
  const T = { ...TOPES_ALTA, ...topes };
  const archivo = path.join(dataDir, 'office', 'machine-keys.json');
  const pedidosPorDireccion = new Map();
  // lo que el centro sabe de cada máquina mientras está conectada: vive en memoria, como las fotos
  const vivas = new Set();
  const masNuevas = new Set();
  const oyentes = [];
  let doc = { schema: 1, claves: mapa({}), bajas: mapa({}), marcas: mapa({}) };
  let noGuarda = false;
  // cuándo se escribió el disco por última vez (en memoria): `tocar` lo mira para escribir a lo sumo una vez por hora
  let guardadoEl = 0;
  // cuándo intentó `tocar` escribirlo por última vez: con el disco sin escritura, no reintenta en cada revisión
  let tocarIntentoEl = 0;

  /** Lo que no se entiende se aparta en vez de pisarlo: quien mantiene puede recuperar las aprobaciones. */
  function apartar() {
    log('oficinas: machine-keys.json no se entiende; queda como machine-keys.json.corrupto y las máquinas van a volver a pedir el alta');
    try { fs.renameSync(archivo, `${archivo}.corrupto`); } catch (e) { log(`oficinas: machine-keys.json no se pudo apartar (${e.code || e.message})`); }
  }
  try {
    const texto = fs.readFileSync(archivo, 'utf8');
    let leido = null;
    try { leido = JSON.parse(texto); } catch { /* abajo: no se entiende */ }
    if (leido && typeof leido === 'object' && leido.claves && leido.bajas && leido.marcas) doc = { ...leido, claves: mapa(leido.claves), bajas: mapa(leido.bajas), marcas: mapa(leido.marcas) };
    else apartar();
  } catch (e) {
    if (e.code !== 'ENOENT') log(`oficinas: machine-keys.json no se pudo leer (${e.code || e.message}); las máquinas van a volver a pedir el alta`);
  }

  function guardar() {
    try {
      fs.mkdirSync(path.dirname(archivo), { recursive: true, mode: 0o700 });
      const tmp = `${archivo}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
      fs.renameSync(tmp, archivo);
      noGuarda = false;
      guardadoEl = ahora();
    } catch (e) {
      noGuarda = true;
      log(`oficinas: las claves no se pudieron guardar (${e.code || e.message}): siguen en memoria hasta el reinicio`);
    }
  }
  function avisar() { for (const fn of oyentes) { try { fn(); } catch (e) { log(`oficinas: el aviso de un cambio falló (${e.message})`); } } }
  const cambio = () => { guardar(); avisar(); };

  /** Una clave ed25519: 32 bytes en base64, sin relleno raro. */
  function clavePublicaValida(publicKey) {
    if (typeof publicKey !== 'string' || !BASE64.test(publicKey) || publicKey.length > 64) return false;
    return Buffer.from(publicKey, 'base64').length === ED25519_BYTES;
  }

  /** Cuenta un pedido de esta dirección en la última hora. false: gastó el tope. */
  function gastarPedido(direccion, t) {
    const previos = (pedidosPorDireccion.get(direccion) || []).filter((x) => t - x < HORA);
    if (previos.length >= T.porHora) { pedidosPorDireccion.set(direccion, previos); return false; }
    previos.push(t);
    pedidosPorDireccion.delete(direccion);
    pedidosPorDireccion.set(direccion, previos);
    if (pedidosPorDireccion.size > DIRECCIONES_MAX) pedidosPorDireccion.delete(pedidosPorDireccion.keys().next().value);
    return true;
  }

  const pendientes = () => Object.values(doc.claves).filter((c) => c.estado === 'pendiente');

  /**
   * El pedido de `/live/enroll`: `{ status }`, con la tabla del criterio. La huella se recalcula: la que trae el pedido sólo
   * se compara. Una clave conocida contesta igual que una nueva, así el pedido no cuenta quién está aprobado.
   */
  function pedir({ publicKey, fingerprint, nombre, direccion }) {
    if (!clavePublicaValida(publicKey)) return { status: 400 };
    const huella = fingerprintOf(publicKey);
    if (fingerprint !== huella) return { status: 400 };
    if (nombre != null && typeof nombre !== 'string') return { status: 400 };
    // una clave retirada no vuelve a pedir: su huella sigue en el buzón y aparecería lista para aprobar. Contesta igual
    if (doc.claves[huella] && (doc.claves[huella].estado !== 'vencida' || doc.claves[huella].retirada)) return { status: 202 };
    const t = ahora();
    const de = hashDe(direccion);
    if (pendientes().length >= T.pendientesTotal) { log(`oficinas: llegó al tope de ${T.pendientesTotal} pedidos de alta pendientes: los nuevos se rechazan`); return { status: 503 }; }
    if (pendientes().filter((c) => c.direccion === de).length >= T.pendientesPorDireccion) return { status: 429 };
    if (!gastarPedido(de, t)) return { status: 429 };
    doc.claves[huella] = { publicKey, fingerprint: huella, nombre: limpiarNombre(nombre), estado: 'pendiente', pedidoEl: t, renovadoEl: t, direccion: de };
    log(`oficinas: pedido de alta de la huella ${huella.slice(0, 16)}`);
    cambio();
    return { status: 202 };
  }

  /**
   * Lo que se le contesta a una firma válida: `{ codigo: null, clave }` si abre; si no, el código con que se cierra.
   * `permitida(maquina)` dice si la máquina sigue confirmada: una que no lo está no abre ni renueva su plazo.
   */
  function alConectar(fingerprint, permitida = () => true) {
    const c = doc.claves[fingerprint];
    const t = ahora();
    if (!c || c.estado === 'vencida') return { codigo: CLOSE.unknown };
    if (c.estado === 'rechazada') return { codigo: CLOSE.revoked };
    if (c.estado === 'pendiente') {
      if (t - c.renovadoEl > PLAZOS_ALTA.pendienteMs) { vencerClave(c, t); guardar(); return { codigo: CLOSE.unknown }; }
      // el disco se escribe a lo sumo una vez por hora: reconectar sin parar no lo gasta, y un plazo de días no lo nota
      const escribir = t - c.renovadoEl > HORA;
      c.renovadoEl = t;
      if (escribir) guardar();
      return { codigo: CLOSE.pending };
    }
    if (c.maquina && doc.bajas[c.maquina]) return { codigo: CLOSE.revoked };
    if (c.maquina && !permitida(c.maquina)) return { codigo: CLOSE.revoked };
    if (t - (c.ultimaConexion || c.aprobadaEl) > PLAZOS_ALTA.aprobadaMs) { vencerClave(c, t); guardar(); return { codigo: CLOSE.unknown }; }
    tocar(fingerprint);
    return { codigo: null, clave: c };
  }

  /**
   * Una conexión abierta cuenta como conectada: se anota en memoria en cada revisión, y el disco se escribe cuando pasó
   * más de una hora desde la última escritura. Así la hora que sobrevive a un reinicio tiene a lo sumo una hora.
   */
  function tocar(fingerprint) {
    const c = doc.claves[fingerprint];
    if (!c || c.estado !== 'aprobada') return;
    const t = ahora();
    c.ultimaConexion = t;
    if (t - guardadoEl > HORA && t - tocarIntentoEl > HORA) { tocarIntentoEl = t; guardar(); }
  }

  /** Las máquinas aprobadas, no de baja, con su última conexión desde `desde`: las que estaban conectadas. */
  function recientes(desde) {
    const out = new Set();
    for (const c of Object.values(doc.claves)) {
      if (c.estado === 'aprobada' && c.maquina && !doc.bajas[c.maquina] && (c.ultimaConexion || 0) >= desde) out.add(c.maquina);
    }
    return [...out].sort();
  }

  function vencerClave(c, t) {
    log(`oficinas: venció la huella ${c.fingerprint.slice(0, 16)} (${c.estado})`);
    c.estado = 'vencida';
    c.vencioEl = t;
  }

  /** Vence lo que pasó su plazo. `reglas` dice qué carpetas son la misma máquina. */
  function vencer(reglas = null) {
    const t = ahora();
    let hubo = false;
    for (const c of Object.values(doc.claves)) {
      if (c.estado === 'pendiente' && t - c.renovadoEl > PLAZOS_ALTA.pendienteMs) { vencerClave(c, t); hubo = true; }
      // una máquina de baja no puede conectarse: el plazo de 30 días corre recién desde que la reactivan
      const deBaja = c.estado === 'aprobada' && (reglas ? deBajaSegun(c.maquina, reglas) : Boolean(doc.bajas[c.maquina]));
      if (c.estado === 'aprobada' && !deBaja && t - (c.ultimaConexion || c.aprobadaEl) > PLAZOS_ALTA.aprobadaMs) { vencerClave(c, t); hubo = true; }
    }
    if (hubo) cambio();
  }

  /**
   * Lo vencido hace rato se suelta si su huella ya no está en el buzón: los pedidos de afuera no pueden hacer crecer el
   * archivo sin fin. Si sigue ahí, soltarla la haría contar como vigente; sin saber qué dice el buzón, no se suelta.
   */
  function soltarVencidas(huellas, t) {
    if (!huellas || huellas.medido === false || !huellas.carpetas) return false;
    const enElBuzon = new Set(Object.values(huellas.carpetas).flatMap((info) => info.huellas));
    let hubo = false;
    for (const c of Object.values(doc.claves)) {
      // una retirada no se suelta nunca: volvería a poder pedir el alta. Son pocas: una aprobación de quien mantiene cada una
      if (c.estado === 'vencida' && !c.retirada && t - c.vencioEl > PLAZOS_ALTA.vencidaMs && !enElBuzon.has(c.fingerprint)) { delete doc.claves[c.fingerprint]; hubo = true; }
    }
    return hubo;
  }

  /** La carpeta de una máquina del buzón es la de esa máquina si está confirmada: `{ maquina, person }`, o null. */
  function confirmadaDe(carpeta, reglas) {
    const m = reglas.maquina(carpeta);
    return m.estado === 'confirmada' ? { maquina: m.carpeta, person: m.person } : null;
  }

  /** Las huellas vigentes en la carpeta de una máquina: las que el sitio no dio por vencidas ni rechazadas. */
  function vigentes(huellasDeLaCarpeta) {
    return huellasDeLaCarpeta.filter((h) => { const c = doc.claves[h]; return !c || (c.estado !== 'vencida' && c.estado !== 'rechazada'); });
  }

  /** Qué le pasa a un pedido, con lo que dice el buzón. `ctx`: `{ huellas, reglas, conBuzon }`. */
  function situacionDe(c, { huellas, reglas, conBuzon }) {
    if (!conBuzon) return { situacion: 'sin_buzon', maquina: null, person: null };
    // «no pude leer» no es «no está», y sin saber quién es quién una máquina con otro dueño pasaría por confirmada
    if (!huellas || huellas.medido === false || !huellas.carpetas || reglas.quienEsQuienMedido === false) return { situacion: 'sin_leer', maquina: null, person: null };
    const confirmadas = Object.entries(huellas.carpetas).map(([carpeta, info]) => ({ ...confirmadaDe(carpeta, reglas), info })).filter((x) => x.maquina);
    const donde = confirmadas.filter((x) => x.info.huellas.includes(c.fingerprint));
    const distintas = [...new Set(donde.map((d) => d.maquina))];
    if (!distintas.length) return { situacion: 'esperando_huella', maquina: null, person: null };
    if (distintas.length > 1) return { situacion: 'dos_maquinas', maquina: null, person: null, maquinas: distintas };
    const { maquina, person } = donde[0];
    // una máquina puede tener más de una carpeta (una vieja unida a la nueva): se miran todas, en cualquier orden
    const deLaMaquina = confirmadas.filter((x) => x.maquina === maquina);
    if (deLaMaquina.some((x) => x.info.llena)) return { situacion: 'carpeta_llena', maquina, person };
    const todas = vigentes([...new Set(deLaMaquina.flatMap((x) => x.info.huellas))]);
    if (todas.length > 1 && c.huellaVista !== true) return { situacion: 'conflicto', maquina, person, otras: todas.filter((h) => h !== c.fingerprint) };
    return { situacion: 'listo', maquina, person };
  }

  /** Una carpeta que se mudó sigue siendo la misma máquina. Sin saber quién es quién, tampoco se sabe qué carpetas se unieron: vale sólo el nombre. */
  function mismaMaquina(a, b, reglas) {
    if (a === b) return true;
    if (!reglas || reglas.quienEsQuienMedido === false) return false;
    return reglas.maquina(a).carpeta === reglas.maquina(b).carpeta;
  }
  /** El nombre con que esta máquina está de baja, o null. */
  function bajaDe(maquina, reglas) {
    if (doc.bajas[maquina]) return maquina;
    return Object.keys(doc.bajas).find((b) => mismaMaquina(b, maquina, reglas)) || null;
  }
  const deBajaSegun = (maquina, reglas) => bajaDe(maquina, reglas) !== null;

  /** Lo que el buzón decide solo: el pedido de una máquina de baja se rechaza. */
  function emparejar(ctx) {
    let hubo = false;
    for (const c of pendientes()) {
      const s = situacionDe(c, ctx);
      if (s.maquina && deBajaSegun(s.maquina, ctx.reglas)) {
        c.estado = 'rechazada';
        c.maquina = s.maquina;
        c.rechazadaPorBaja = bajaDe(s.maquina, ctx.reglas);
        hubo = true;
        log(`oficinas: el pedido de la huella ${c.fingerprint.slice(0, 16)} se rechazó solo: su máquina está de baja`);
      }
    }
    if (soltarVencidas(ctx.huellas, ahora())) hubo = true;
    if (hubo) cambio();
  }

  function aprobar(fingerprint, por, ctx) {
    const c = doc.claves[fingerprint];
    if (!c || c.estado !== 'pendiente') return { ok: false, motivo: 'no_pendiente' };
    const s = situacionDe(c, ctx);
    if (s.maquina && deBajaSegun(s.maquina, ctx.reglas)) return { ok: false, motivo: 'de_baja' };
    if (s.situacion !== 'listo') return { ok: false, motivo: s.situacion };
    const t = ahora();
    // una máquina tiene una sola clave: la nueva retira la anterior, también si se aprobó con el nombre viejo de su carpeta
    for (const otra of Object.values(doc.claves)) {
      if (otra.estado === 'aprobada' && otra.maquina && mismaMaquina(otra.maquina, s.maquina, ctx.reglas)) { vencerClave(otra, t); otra.retirada = true; }
    }
    Object.assign(c, { estado: 'aprobada', maquina: s.maquina, aprobadaPor: por, aprobadaEl: t, ultimaConexion: t });
    log(`oficinas: ${quienEnElRegistro(por)} aprobó la huella ${fingerprint.slice(0, 16)} para ${s.maquina}`);
    cambio();
    return { ok: true, maquina: s.maquina };
  }

  function rechazar(fingerprint, por) {
    const c = doc.claves[fingerprint];
    if (!c || c.estado !== 'pendiente') return { ok: false, motivo: 'no_pendiente' };
    Object.assign(c, { estado: 'rechazada', rechazadaPor: por, rechazadaEl: ahora() });
    log(`oficinas: ${quienEnElRegistro(por)} rechazó la huella ${fingerprint.slice(0, 16)}`);
    cambio();
    return { ok: true };
  }

  /** Quien mantiene dice cuál de las dos huellas vio el dev en su línea. Queda quién y cuándo. */
  function confirmarHuella(fingerprint, por) {
    const c = doc.claves[fingerprint];
    if (!c || c.estado !== 'pendiente') return { ok: false, motivo: 'no_pendiente' };
    Object.assign(c, { huellaVista: true, huellaVistaPor: por, huellaVistaEl: ahora() });
    log(`oficinas: ${quienEnElRegistro(por)} marcó la huella ${fingerprint.slice(0, 16)} como la que vio el dev`);
    cambio();
    return { ok: true };
  }

  function darDeBaja(maquina, por) {
    if (typeof maquina !== 'string' || !maquina) return { ok: false, motivo: 'sin_maquina' };
    doc.bajas[maquina] = { por, el: ahora() };
    // la marca de «posible clave copiada» dura hasta la baja: al reactivarla, la máquina arranca sin ella
    delete doc.marcas[maquina];
    log(`oficinas: ${quienEnElRegistro(por)} dio de baja ${maquina}`);
    cambio();
    return { ok: true };
  }

  function reactivar(maquina, por, reglas = null) {
    if (!doc.bajas[maquina]) return { ok: false, motivo: 'no_de_baja' };
    delete doc.bajas[maquina];
    for (const c of Object.values(doc.claves)) {
      // lo que se rechazó solo por esta baja vuelve a esperar, se llame como se llame la carpeta: quien mantiene decide con la máquina activa
      if (c.rechazadaPorBaja === maquina || (c.rechazadaPorBaja && mismaMaquina(c.maquina, maquina, reglas))) { c.estado = 'pendiente'; c.renovadoEl = ahora(); delete c.rechazadaPorBaja; }
      // el tiempo de baja no cuenta: vuelve con la clave que tenía
      if (c.estado === 'aprobada' && c.maquina && mismaMaquina(c.maquina, maquina, reglas)) c.ultimaConexion = ahora();
    }
    log(`oficinas: ${quienEnElRegistro(por)} reactivó ${maquina}`);
    cambio();
    return { ok: true };
  }

  /**
   * Retira la clave de una máquina: una clave robada no se va con la baja, porque al reactivar volvería con ella. Contesta
   * 4404 como cualquier vencida, y la máquina de verdad arma otra en su próxima sesión y vuelve a pedir el alta.
   */
  function retirar(maquina, por, reglas = null) {
    const t = ahora();
    const suyas = Object.values(doc.claves).filter((c) => c.estado === 'aprobada' && c.maquina && mismaMaquina(c.maquina, maquina, reglas));
    if (!suyas.length) return { ok: false, motivo: 'sin_clave' };
    for (const c of suyas) { vencerClave(c, t); c.retirada = true; }
    log(`oficinas: ${quienEnElRegistro(por)} retiró la clave de ${maquina}`);
    cambio();
    return { ok: true };
  }

  /** Una conexión nueva desplazó a otra de la misma clave: más de 10 en una hora marcan la máquina. */
  function anotarDesplazamiento(maquina) {
    const t = ahora();
    const m = doc.marcas[maquina] || { desplazamientos: [] };
    m.desplazamientos = (m.desplazamientos || []).filter((x) => t - x < COPIADA.ventanaMs);
    m.desplazamientos.push(t);
    const copiada = m.desplazamientos.length > COPIADA.desplazamientos;
    const nueva = copiada && !m.copiada;
    if (copiada) m.copiada = true;
    doc.marcas[maquina] = m;
    if (nueva) { log(`oficinas: ${maquina} queda marcada «posible clave copiada»`); cambio(); } else guardar();
    return copiada;
  }

  function borrarMarca(maquina, por) {
    const m = doc.marcas[maquina];
    if (!m || !m.copiada) return { ok: false, motivo: 'sin_marca' };
    doc.marcas[maquina] = { desplazamientos: [], marca_borrada: { por, el: ahora() } };
    log(`oficinas: ${quienEnElRegistro(por)} borró la marca de ${maquina}`);
    cambio();
    return { ok: true };
  }

  /** Lo que muestra Configuración: los pedidos con su situación y las máquinas con oficina. Sin la clave pública. */
  function vista(ctx) {
    const pedidos = pendientes().map((c) => {
      const s = situacionDe(c, ctx);
      return { fingerprint: c.fingerprint, nombre: c.nombre, pedidoEl: c.pedidoEl, ...s };
    });
    const porMaquina = new Map();
    for (const c of Object.values(doc.claves)) {
      if (!c.maquina || c.estado !== 'aprobada') continue;
      const previa = porMaquina.get(c.maquina);
      if (!previa || (c.ultimaConexion || 0) > (previa.ultimaConexion || 0)) porMaquina.set(c.maquina, c);
    }
    for (const maquina of Object.keys(doc.bajas)) if (!porMaquina.has(maquina)) porMaquina.set(maquina, { maquina });
    const maquinas = [...porMaquina.values()].map((c) => {
      const conf = ctx.reglas ? ctx.reglas.maquina(c.maquina) : null;
      return { maquina: c.maquina, person: conf ? conf.person || null : null, fingerprint: c.fingerprint || null, ultimaConexion: c.ultimaConexion || null, deBaja: Boolean(doc.bajas[c.maquina]), copiada: Boolean(doc.marcas[c.maquina] && doc.marcas[c.maquina].copiada), conectada: vivas.has(c.maquina), masNueva: masNuevas.has(c.maquina) };
    }).sort((a, b) => (a.maquina < b.maquina ? -1 : 1));
    return { pedidos, maquinas, noGuarda };
  }

  return {
    pedir, alConectar, tocar, recientes, vencer, emparejar, deBajaSegun, aprobar, rechazar, confirmarHuella, darDeBaja, reactivar, retirar, anotarDesplazamiento, borrarMarca, vista,
    clave: (fingerprint) => doc.claves[fingerprint] || null,
    deBaja: (maquina) => Boolean(doc.bajas[maquina]),
    copiada: (maquina) => Boolean(doc.marcas[maquina] && doc.marcas[maquina].copiada),
    alCambiar: (fn) => { oyentes.push(fn); },
    /** El centro dice qué máquina está conectada y cuál es más nueva que el sitio: Configuración lo muestra. */
    anotarConexion: (maquina, viva) => { if (viva) vivas.add(maquina); else vivas.delete(maquina); },
    anotarMasNueva: (maquina, nueva) => { if (nueva) masNuevas.add(maquina); else masNuevas.delete(maquina); },
  };
}

module.exports = { crearLlaves, TOPES_ALTA, PLAZOS_ALTA, COPIADA, HUELLA };
