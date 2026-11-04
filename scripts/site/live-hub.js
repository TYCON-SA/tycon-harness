'use strict';
/*
 * live-hub.js — EL CENTRO DE LAS OFICINAS: recibe de cada máquina, guarda su última foto y la reparte a quien la puede ver.
 *
 * Dos puertas, cada una con su credencial:
 *   /live/machine  una máquina. El sitio le manda un desafío y ella firma `tycon-office-v1|<sitio>|<desafío>`. Está fuera del
 *                  candado de la plataforma: la alcanza cualquiera en internet, y sólo vale la firma.
 *   /live/offices  un navegador, con la cookie de la sesión del sitio y su `Origin`.
 * Una credencial de una puerta no sirve en la otra. Con el sitio cargando o frenado, las dos cierran con 1013: sin la
 * configuración leída el sitio no puede decir que una clave no existe, y un 4404 le haría armar otra a una máquina aprobada.
 *
 * La máquina de una foto la dice la clave que firmó, nunca el mensaje. Lo que llega pasa por la misma lista de campos que
 * usa la máquina (`fields.js`): un tipo raro o una forma que no corresponde cierran con 1008; un campo o un estado que el
 * sitio no conoce se ignora, porque una máquina se actualiza antes que el sitio y cortarla congelaría su oficina.
 *
 * Quién ve qué lo decide `access.js` en cada reparto, con la configuración del momento, y el filtro va antes de mandar. Las
 * fotos viven sólo en memoria: al registro van los eventos, nunca el contenido. La conversación de cada sesión (`charla`)
 * llega aparte, también sólo en memoria y con la oficina; la máquina la manda porque el `ack` de este sitio la anuncia, y
 * se entrega a pedido (`conversacion`) con la misma regla de quién ve qué.
 *
 * Los topes van por quien los pide, porque /live/machine está al alcance de cualquiera: uno que abusa se frena solo. Al
 * llegar al tope del total de conexiones sin autenticar se corta la más vieja, así una máquina aprobada siempre tiene lugar
 * para firmar. Las máquinas ya conectadas no cuentan en ese carril.
 *
 * Casos: scripts/tests/site-live-hub.test.js
 */
const crypto = require('crypto');
const { WebSocketServer } = require('../tools/office/vendor/ws');
const { FIELDS, CHARLA, CAPABILITIES, CLOSE, TEXT_MAX, CHARLA_TEXT_MAX, MAX_MESSAGE_BYTES, MESSAGES, signedText, fingerprintOf, validHour } = require('../tools/office/fields.js');
const access = require('./access.js');
const session = require('./session.js');

const TOPES = Object.freeze({
  maquinas: 50, bytesAutenticada: MAX_MESSAGE_BYTES, bytesSinAutenticar: 2 * 1024, mensajesPorSegundo: 10,
  navegadoresPorCuenta: 5, navegadoresTotal: 200, sinAutenticarPorDireccion: 2, sinAutenticarTotal: 1000,
  // un navegador que no lee se corta antes de llenar la memoria del sitio
  bufferNavegadorBytes: 4 * 1024 * 1024,
  // las conversaciones que guarda el sitio de una oficina: no confía en el filtro de la máquina
  charlasPorOficina: 30, bytesCharlasPorOficina: 1024 * 1024,
});
const PLAZOS = Object.freeze({ saludoMs: 5000, cierreMs: 2000, repartoMs: 500,revisionMs: 60000, sinLatidoMs: 3 * 60 * 1000, fotoMs: 24 * 60 * 60 * 1000 });
const CIERRE_MUY_GRANDE = 1009;
const CIERRE_PROBA_DESPUES = 1013;
const NONCE_BYTES = 32;

/** La dirección de quien pide: la del socket, o la última de `X-Forwarded-For` si la instalación confía en el intermediario. */
function direccionDe(req, confiar) {
  const socket = (req.socket && req.socket.remoteAddress) || 'desconocida';
  if (!confiar) return socket;
  const cab = req.headers && req.headers['x-forwarded-for'];
  const partes = String(Array.isArray(cab) ? cab.join(',') : (cab || '')).split(',').map((x) => x.trim()).filter(Boolean);
  return partes.length ? partes[partes.length - 1] : socket;
}

const MALA = Symbol('forma mala');

/** Un valor según su forma: lo que se guarda, `undefined` si se ignora (un estado desconocido) o MALA. */
function valorSegun(spec, value, donde, desconocidos) {
  if (value === null) return null;
  switch (spec.form) {
    case 'text':
    case 'action': return typeof value === 'string' && value.length <= TEXT_MAX ? value : MALA;
    case 'longText': return typeof value === 'string' && value.length <= CHARLA_TEXT_MAX ? value : MALA;
    case 'byName': {
      if (typeof value !== 'object' || Array.isArray(value)) return MALA;
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (k.length > TEXT_MAX || v === null) return MALA;
        const x = valorSegun(spec.of, v, donde, desconocidos);
        if (x === MALA) return MALA;
        if (x !== undefined) out[k] = x;
      }
      return out;
    }
    case 'folder': return typeof value === 'string' && value.length <= TEXT_MAX && !/[\\/]/.test(value) ? value : MALA;
    case 'number': return Number.isFinite(value) ? value : MALA;
    case 'flag': return typeof value === 'boolean' ? value : MALA;
    case 'hour': return typeof value === 'string' && validHour(value) ? value : MALA;
    case 'state':
      if (typeof value !== 'string' || value.length > TEXT_MAX) return MALA;
      if (spec.values.includes(value)) return value;
      desconocidos.add(donde);
      return undefined;
    case 'list': {
      if (!Array.isArray(value)) return MALA;
      const out = [];
      for (const v of value) {
        // null vale para un campo opcional, no como elemento: la máquina no los manda, y la página recorre la lista
        if (v === null) return MALA;
        const x = valorSegun(spec.of, v, donde, desconocidos);
        if (x === MALA) return MALA;
        if (x !== undefined) out.push(x);
      }
      return out;
    }
    // una fila de tabla llega como un objeto: lo que se tapa de otro proyecto ya lo tapó la máquina
    case 'object':
    case 'tableRow': return camposSegun(spec.fields, value, donde, desconocidos);
    default: return MALA;
  }
}

function camposSegun(campos, source, donde, desconocidos) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return MALA;
  const out = {};
  for (const clave of Object.keys(source)) {
    const ruta = donde ? `${donde}.${clave}` : clave;
    if (!Object.prototype.hasOwnProperty.call(campos, clave)) { desconocidos.add(ruta); continue; }
    const v = valorSegun(campos[clave], source[clave], ruta, desconocidos);
    if (v === MALA) return MALA;
    if (v !== undefined) out[clave] = v;
  }
  return out;
}

/**
 * Lo que queda de una foto después de pasarla por la lista: `{ ok: true, foto, desconocidos }` o `{ ok: false }`.
 * `desconocidos` trae las rutas de lo que se ignoró, nunca su valor.
 */
function limpiarFoto(data) {
  const desconocidos = new Set();
  const foto = camposSegun(FIELDS, data, '', desconocidos);
  if (foto === MALA) return { ok: false };
  return { ok: true, foto, desconocidos: [...desconocidos] };
}

/** La conversación de una sesión, por la forma de `CHARLA`: `{ ok: true, datos }` o `{ ok: false }`. Lo desconocido se ignora. */
function limpiarCharla(datos) {
  const datosLimpios = camposSegun(CHARLA.fields, datos, '', new Set());
  return datosLimpios === MALA ? { ok: false } : { ok: true, datos: datosLimpios };
}

// Los nombres de la foto: una conversación se guarda sólo si su sesión está en la oficina
const nombresDe = (foto) => new Set([...((foto && foto.agents) || []).map((a) => a && a.nombre), ...((foto && foto.free) || [])].filter((n) => typeof n === 'string'));

function crearCentro({ cfg, fuentes, llaves, sesionDe, ahora = Date.now, log = () => {}, topes = {}, plazos = {}, repartoMs, firstMaintainer = null }) {
  const T = { ...TOPES, ...topes };
  const P = { ...PLAZOS, ...plazos, ...(repartoMs ? { repartoMs } : {}) };
  // autoPong apagado: contestar cada ping apila las respuestas en memoria si el otro no lee, y el protocolo no los usa
  const puerta = new WebSocketServer({ noServer: true, maxPayload: T.bytesAutenticada, autoPong: false });
  const sinAutenticar = new Set();
  const cerrandoPorDireccion = new Map();
  let cerrandoTotal = 0;
  const maquinas = new Map();    // máquina → su conexión
  const oficinas = new Map();    // máquina → { foto, version, ultimoLatido, sinConexionDesde, masNueva }
  const navegadores = new Set();
  let version = 0;
  let huboCambios = false;

  const noDisponible = () => {
    const st = fuentes.estado();
    return Boolean(st.frenado) || !(st.cargado || st.navegable);
  };
  const cerrar = (ws, codigo, motivo) => { try { ws.close(codigo, motivo); } catch { /* ya cerrada */ } };
  const quienEs = (ses) => access.quienPide(ses, { config: fuentes.config(), firstMaintainer });
  const reglasAhora = () => {
    const config = fuentes.config();
    return access.crearReglas({ config, modelo: fuentes.modelo ? fuentes.modelo() : {}, personas: fuentes.personas ? fuentes.personas() : null });
  };
  // sin saber quién es quién, «no sé» no es «desconfirmada»: pasa tras un reinicio, hasta leer el buzón
  const desconfirmada = (reglas, id) => reglas.quienEsQuienMedido && reglas.maquina(id).estado !== 'confirmada';
  const visibilidadAhora = () => {
    const site = (fuentes.config() || {}).site;
    return (site && site.offices && site.offices.visibility) || 'maintainers';
  };

  /** Lo que un navegador recibe de una oficina: las marcas y de quién es, sólo para quien mantiene. */
  function oficinaPara(id, o, mantiene, reglas) {
    const marcas = [];
    if (mantiene && llaves.copiada(id)) marcas.push('clave_copiada');
    if (mantiene && o.masNueva) marcas.push('mas_nueva');
    return { id, foto: o.foto, conectada: maquinas.has(id) && o.sinConexionDesde === null, sinConexionDesde: o.sinConexionDesde, marcas, ...(mantiene ? { person: reglas.maquina(id).person || null } : {}) };
  }

  function mandar(nav, msg) {
    if (nav.ws.readyState !== nav.ws.OPEN) return;
    if (nav.ws.bufferedAmount > T.bufferNavegadorBytes) { log('oficinas: un navegador no lee lo que le llega: se corta'); nav.ws.terminate(); return; }
    nav.ws.send(JSON.stringify(msg));
  }

  /** El reparto: a cada navegador, lo que puede ver y cambió, y lo que dejó de poder ver. */
  function repartir(forzado = false) {
    if (!huboCambios && !forzado) return;
    huboCambios = false;
    if (!navegadores.size) return;
    const reglas = reglasAhora();
    const perilla = visibilidadAhora();
    for (const nav of navegadores) {
      const ve = access.oficinasQueVe(nav.quien, reglas, perilla);
      const mantiene = nav.quien.rol === 'maintainer';
      const cambiadas = [];
      const fuera = [];
      for (const [id, o] of oficinas) {
        if (ve(id)) {
          const firma = `${o.version}|${o.sinConexionDesde}|${maquinas.has(id)}|${mantiene}|${mantiene && llaves.copiada(id)}|${mantiene ? reglas.maquina(id).person : ''}`;
          if (nav.vistas.get(id) !== firma) { nav.vistas.set(id, firma); cambiadas.push(oficinaPara(id, o, mantiene, reglas)); }
        }
      }
      for (const id of nav.vistas.keys()) {
        if (!oficinas.has(id) || !ve(id)) { nav.vistas.delete(id); fuera.push(id); }
      }
      if (nav.entera) { nav.entera = false; mandar(nav, { type: 'oficinas', entera: true, oficinas: cambiadas, fuera: [] }); continue; }
      if (cambiadas.length || fuera.length) mandar(nav, { type: 'oficinas', oficinas: cambiadas, fuera });
    }
  }

  /** Una sesión vence igual con el sitio frenado: la configuración hace falta sólo para saber qué rol tiene. */
  function revisarNavegadores(disponible) {
    for (const nav of navegadores) {
      const ses = sesionDe(nav.cookies);
      if (!ses) { cerrar(nav.ws, CLOSE.pending, 'la sesión venció'); continue; }
      if (!disponible) continue;
      const quien = quienEs(ses);
      if (quien.rol === 'none') { cerrar(nav.ws, CLOSE.revoked, 'la cuenta salió de la lista'); continue; }
      nav.quien = quien;
    }
  }

  function revisarMaquinas(disponible) {
    const reglas = disponible ? reglasAhora() : null;
    const t = ahora();
    for (const [id, conn] of maquinas) {
      if (disponible && llaves.deBajaSegun(id, reglas)) { cerrar(conn.ws, CLOSE.revoked, 'de baja'); oficinas.delete(id); huboCambios = true; continue; }
      if (disponible && desconfirmada(reglas, id)) { cerrar(conn.ws, CLOSE.revoked, 'desconfirmada'); oficinas.delete(id); huboCambios = true; continue; }
      // su clave venció mientras estaba abierta: lo que llega por una conexión abierta no vuelve a mirarla
      const clave = llaves.clave(conn.fingerprint);
      if (disponible && (!clave || clave.estado !== 'aprobada')) { cerrar(conn.ws, CLOSE.unknown, 'la clave venció'); continue; }
      const callada = t - conn.ultimoLatido >= P.sinLatidoMs;
      // sin foto no hay oficina que marcar: una conexión muda ocuparía su lugar para siempre
      if (callada && !oficinas.has(id)) {
        maquinas.delete(id);
        llaves.anotarConexion(id, false);
        conn.ws.terminate();
        log(`oficinas: ${id} sin conexión`);
        continue;
      }
      if (disponible && !callada) llaves.tocar(conn.fingerprint);
    }
    for (const [id, o] of oficinas) {
      // también la de una máquina que ya se había desconectado: su última foto no sigue a la vista
      if (disponible && !maquinas.has(id) && (desconfirmada(reglas, id) || llaves.deBajaSegun(id, reglas))) { oficinas.delete(id); huboCambios = true; continue; }
      if (o.sinConexionDesde === null && t - o.ultimoLatido >= P.sinLatidoMs) {
        o.sinConexionDesde = o.ultimoLatido;
        huboCambios = true;
        const conn = maquinas.get(id);
        if (conn) { maquinas.delete(id); llaves.anotarConexion(id, false); conn.ws.terminate(); }
        log(`oficinas: ${id} sin conexión`);
      } else if (o.sinConexionDesde !== null && t - o.sinConexionDesde >= P.fotoMs) {
        oficinas.delete(id);
        huboCambios = true;
      }
    }
  }

  /** La revisión de las conexiones abiertas. Una conexión queda abierta horas: la regla se aplica igual que en cada pedido. */
  function revisar() {
    const disponible = !noDisponible();
    // un paso que falla no se lleva a los otros: el corte de una sesión vencida no depende de las claves
    const paso = (que, fn) => { try { fn(); } catch (e) { log(`oficinas: la revisión de ${que} falló (${e.message})`); } };
    if (disponible) {
      paso('las claves', () => {
        llaves.vencer(reglasAhora());
        llaves.emparejar({ huellas: fuentes.huellas ? fuentes.huellas() : null, reglas: reglasAhora(), conBuzon: conBuzon() });
      });
    }
    paso('los navegadores', () => revisarNavegadores(disponible));
    paso('las máquinas', () => revisarMaquinas(disponible));
    repartir(true);
  }
  const conBuzon = () => { const site = (fuentes.config() || {}).site; return Boolean(site && site.mailbox); };

  const relojReparto = setInterval(() => { try { repartir(); } catch (e) { log(`oficinas: el reparto falló (${e.message})`); } }, P.repartoMs);
  const relojRevision = setInterval(() => { try { revisar(); } catch (e) { log(`oficinas: la revisión falló (${e.message})`); } }, P.revisionMs);
  relojReparto.unref();
  relojRevision.unref();
  // una baja o una aprobación desde Configuración no espera a la revisión
  llaves.alCambiar(() => {
    const reglas = reglasAhora();
    for (const [id, conn] of maquinas) if (llaves.deBajaSegun(id, reglas)) cerrar(conn.ws, CLOSE.revoked, 'de baja');
    // una clave retirada se corta en el acto, y su última foto no sigue a la vista: pudo mandarla quien la robó
    for (const [id, conn] of maquinas) {
      const clave = llaves.clave(conn.fingerprint);
      if (!clave || clave.estado !== 'aprobada') { cerrar(conn.ws, CLOSE.unknown, 'la clave ya no vale'); oficinas.delete(id); }
    }
    // la oficina de una máquina de baja no sigue a la vista con su última foto
    for (const id of oficinas.keys()) if (llaves.deBajaSegun(id, reglas)) oficinas.delete(id);
    huboCambios = true;
  });

  function soltarSinAutenticar(conn) {
    sinAutenticar.delete(conn);
    if (conn.reloj) { clearTimeout(conn.reloj); conn.reloj = null; }
  }

  function autenticar(conn, msg) {
    const { publicKey, fingerprint, signature } = msg;
    if (typeof publicKey !== 'string' || typeof signature !== 'string') return cerrar(conn.ws, CLOSE.policy, 'sin firma');
    const huella = fingerprintOf(publicKey);
    if (fingerprint !== huella) return cerrar(conn.ws, CLOSE.policy, 'la huella no coincide');
    let valida = false;
    try {
      const x = Buffer.from(publicKey, 'base64').toString('base64url');
      const clave = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
      valida = crypto.verify(null, Buffer.from(signedText(cfg.publicUrl, conn.nonce)), clave, Buffer.from(signature, 'base64'));
    } catch { valida = false; }
    if (!valida) return cerrar(conn.ws, CLOSE.policy, 'la firma no vale');
    if (noDisponible()) return cerrar(conn.ws, CIERRE_PROBA_DESPUES, 'el sitio está cargando');
    const reglas = reglasAhora();
    const r = llaves.alConectar(huella, (maquina) => !desconfirmada(reglas, maquina) && !llaves.deBajaSegun(maquina, reglas));
    if (r.codigo !== null) return cerrar(conn.ws, r.codigo, 'sin oficina');
    const id = r.clave.maquina;
    const previa = maquinas.get(id);
    if (!previa && maquinas.size >= T.maquinas) { log(`oficinas: llegó al tope de ${T.maquinas} máquinas: ${id} no entra`); return cerrar(conn.ws, CIERRE_PROBA_DESPUES, 'tope de máquinas'); }
    if (previa) {
      log(`oficinas: una conexión nueva desplazó a la anterior de ${id}`);
      maquinas.delete(id);
      cerrar(previa.ws, CLOSE.displaced, 'otra conexión con la misma clave');
      llaves.anotarDesplazamiento(id);
    }
    soltarSinAutenticar(conn);
    conn.autenticada = true;
    conn.id = id;
    conn.fingerprint = huella;
    conn.ultimoLatido = ahora();
    maquinas.set(id, conn);
    llaves.anotarConexion(id, true);
    const o = oficinas.get(id);
    if (o) { o.ultimoLatido = ahora(); o.sinConexionDesde = null; huboCambios = true; }
    // lo que este sitio entiende además de la foto: una máquina manda la conversación sólo si lo lee acá
    conn.ws.send(JSON.stringify({ type: 'ack', puede: CAPABILITIES }));
    log(`oficinas: ${id} conectó`);
    return undefined;
  }

  function latido(conn) {
    conn.ultimoLatido = ahora();
    const o = oficinas.get(conn.id);
    if (o) {
      o.ultimoLatido = conn.ultimoLatido;
      if (o.sinConexionDesde !== null) { o.sinConexionDesde = null; huboCambios = true; }
    }
  }

  function recibirFoto(conn, data) {
    const r = limpiarFoto(data);
    if (!r.ok) { log(`oficinas: ${conn.id} mandó una foto con una forma que no corresponde: se cierra`); return cerrar(conn.ws, CLOSE.policy, 'forma mala'); }
    const previa = oficinas.get(conn.id);
    const masNueva = r.desconocidos.length > 0;
    llaves.anotarMasNueva(conn.id, masNueva);
    if (masNueva && !(previa && previa.anotada)) log(`oficinas: ${conn.id} es más nueva que el sitio: se ignora lo que el sitio no conoce (${r.desconocidos.slice(0, 5).join(', ')})`);
    version += 1;
    // la conversación de una sesión que salió de la foto se va con ella
    const charlas = previa && previa.charlas ? previa.charlas : new Map();
    const nombres = nombresDe(r.foto);
    for (const s of charlas.keys()) if (!nombres.has(s)) charlas.delete(s);
    oficinas.set(conn.id, { foto: r.foto, version, ultimoLatido: ahora(), sinConexionDesde: null, masNueva, anotada: Boolean(previa && previa.anotada) || masNueva, charlas, charlasLlenas: Boolean(previa && previa.charlasLlenas) });
    huboCambios = true;
    return undefined;
  }

  /** La conversación de una sesión de la oficina de esa clave: sólo en memoria, y sólo de una sesión que está en su foto. */
  function recibirCharla(conn, msg) {
    const r = typeof msg.sesion === 'string' && msg.sesion.length <= TEXT_MAX ? limpiarCharla(msg.datos) : { ok: false };
    if (!r.ok) { log(`oficinas: ${conn.id} mandó una conversación con una forma que no corresponde: se cierra`); return cerrar(conn.ws, CLOSE.policy, 'forma mala'); }
    const o = oficinas.get(conn.id);
    // antes de su primera foto, o de una sesión que no está en ella, no se guarda: no hay dónde mostrarla
    if (!o || !nombresDe(o.foto).has(msg.sesion)) return undefined;
    // con el tope de la oficina lleno, la nueva no se guarda y queda anotado una vez; la de una sesión ya guardada se reemplaza
    const bytes = Buffer.byteLength(JSON.stringify(r.datos));
    let otras = 0;
    let total = bytes;
    for (const [s, c] of o.charlas) if (s !== msg.sesion) { otras += 1; total += c.bytes; }
    if (otras >= T.charlasPorOficina || total > T.bytesCharlasPorOficina) {
      if (!o.charlasLlenas) { o.charlasLlenas = true; log(`oficinas: ${conn.id} llenó su tope de conversaciones (${T.charlasPorOficina} o ${T.bytesCharlasPorOficina} bytes): la nueva no se guarda`); }
      return undefined;
    }
    o.charlas.set(msg.sesion, { datos: r.datos, bytes });
    return undefined;
  }

  /** Lo que ve quien pide de la conversación de una sesión, o null: no la ve, o no existe (para quien pide es lo mismo). */
  function conversacion(quien, id, sesion) {
    if (!quien || !quien.rol || quien.rol === 'none') return null;
    const o = oficinas.get(id);
    if (!o || !o.charlas || !access.oficinasQueVe(quien, reglasAhora(), visibilidadAhora())(id)) return null;
    const c = o.charlas.get(sesion);
    return c ? c.datos : null;
  }

  function alMensajeDeMaquina(conn, raw) {
    // lo que llega después del cierre, o a una conexión desplazada, no cuenta: una foto en vuelo resucitaría una oficina dada de baja
    if (conn.ws.readyState !== conn.ws.OPEN) return undefined;
    if (conn.autenticada && maquinas.get(conn.id) !== conn) return undefined;
    const tamano = raw.length;
    if (!conn.autenticada && tamano > T.bytesSinAutenticar) return cerrar(conn.ws, CIERRE_MUY_GRANDE, 'demasiado grande antes de firmar');
    const t = ahora();
    conn.mensajes = conn.mensajes.filter((x) => t - x < 1000);
    conn.mensajes.push(t);
    if (conn.mensajes.length > T.mensajesPorSegundo) { log(`oficinas: ${conn.id || 'una conexión'} pasó de ${T.mensajesPorSegundo} mensajes por segundo: se cierra`); return cerrar(conn.ws, CLOSE.policy, 'demasiados mensajes'); }
    let msg = null;
    try { msg = JSON.parse(String(raw)); } catch { /* abajo: sin tipo */ }
    const tipo = msg && typeof msg === 'object' && !Array.isArray(msg) ? msg.type : undefined;
    if (!MESSAGES.toSite.includes(tipo)) { log(`oficinas: ${conn.id || 'una conexión'} mandó un mensaje de un tipo raro: se cierra`); return cerrar(conn.ws, CLOSE.policy, 'tipo raro'); }
    if (!conn.autenticada) {
      if (tipo !== 'auth' || conn.firmo) return cerrar(conn.ws, CLOSE.policy, 'primero la firma');
      conn.firmo = true;
      return autenticar(conn, msg);
    }
    if (tipo === 'auth') return cerrar(conn.ws, CLOSE.policy, 'ya firmó');
    latido(conn);
    if (tipo === 'ping') { conn.ws.send(JSON.stringify({ type: 'pong' })); return undefined; }
    if (tipo === 'charla') return recibirCharla(conn, msg);
    return recibirFoto(conn, msg.data);
  }

  /** Lugar para una conexión sin autenticar. false: esa dirección ya tiene las suyas. */
  function hacerLugar(direccion) {
    const deEsa = [...sinAutenticar].filter((c) => c.direccion === direccion).length;
    if (deEsa >= T.sinAutenticarPorDireccion) return false;
    if (sinAutenticar.size >= T.sinAutenticarTotal) {
      log(`oficinas: llegó al tope de ${T.sinAutenticarTotal} conexiones sin autenticar: se corta la más vieja`);
      const vieja = sinAutenticar.values().next().value;
      soltarSinAutenticar(vieja);
      vieja.ws.terminate();
    }
    return true;
  }

  function abrirMaquina(ws, req) {
    if (noDisponible()) return cerrar(ws, CIERRE_PROBA_DESPUES, 'el sitio está cargando');
    const direccion = direccionDe(req, cfg.trustProxy);
    if (!hacerLugar(direccion)) { ws.terminate(); return undefined; }
    const conn = { ws, direccion, nonce: crypto.randomBytes(NONCE_BYTES).toString('base64'), autenticada: false, firmo: false, mensajes: [], reloj: null };
    sinAutenticar.add(conn);
    conn.reloj = setTimeout(() => { soltarSinAutenticar(conn); cerrar(ws, CLOSE.policy, 'sin firma a tiempo'); }, P.saludoMs);
    conn.reloj.unref();
    ws.on('message', (raw) => { try { alMensajeDeMaquina(conn, raw); } catch (e) { log(`oficinas: un mensaje de máquina falló (${e.message})`); cerrar(ws, 1011, 'error del sitio'); } });
    ws.on('close', () => {
      soltarSinAutenticar(conn);
      if (conn.id && maquinas.get(conn.id) === conn) { maquinas.delete(conn.id); llaves.anotarConexion(conn.id, false); huboCambios = true; }
    });
    ws.send(JSON.stringify({ type: 'challenge', nonce: conn.nonce }));
    return undefined;
  }

  /**
   * Un navegador que no entró. Un cierre espera que el otro lado lo conteste hasta 30 s: quien no contesta juntaría conexiones
   * sin haber iniciado sesión. Por eso cada dirección tiene su tope de cierres esperando, y el cierre un plazo corto.
   */
  function rechazarNavegador(ws, req, codigo, motivo) {
    const direccion = direccionDe(req, cfg.trustProxy);
    const deEsa = cerrandoPorDireccion.get(direccion) || 0;
    if (deEsa >= T.sinAutenticarPorDireccion || cerrandoTotal >= T.sinAutenticarTotal) { ws.terminate(); return undefined; }
    cerrandoPorDireccion.set(direccion, deEsa + 1);
    cerrandoTotal += 1;
    const plazo = setTimeout(() => ws.terminate(), P.cierreMs);
    plazo.unref();
    ws.once('close', () => {
      clearTimeout(plazo);
      cerrandoTotal -= 1;
      const quedan = cerrandoPorDireccion.get(direccion) - 1;
      if (quedan > 0) cerrandoPorDireccion.set(direccion, quedan);
      else cerrandoPorDireccion.delete(direccion);
    });
    return cerrar(ws, codigo, motivo);
  }

  function abrirNavegador(ws, req) {
    if (noDisponible()) return rechazarNavegador(ws, req, CIERRE_PROBA_DESPUES, 'el sitio está cargando');
    const cookies = session.leerCookies(req.headers.cookie);
    const ses = req.headers.origin === cfg.publicUrl ? sesionDe(cookies) : null;
    if (!ses) return rechazarNavegador(ws, req, CLOSE.pending, 'sin sesión');
    const quien = quienEs(ses);
    if (quien.rol === 'none') return cerrar(ws, CLOSE.revoked, 'sin rol');
    if (navegadores.size >= T.navegadoresTotal) { log(`oficinas: llegó al tope de ${T.navegadoresTotal} navegadores`); return cerrar(ws, CIERRE_PROBA_DESPUES, 'tope de navegadores'); }
    if ([...navegadores].filter((n) => n.quien.email === quien.email).length >= T.navegadoresPorCuenta) return cerrar(ws, CLOSE.policy, 'tope de navegadores de la cuenta');
    const nav = { ws, cookies, quien, vistas: new Map(), entera: true };
    navegadores.add(nav);
    ws.on('close', () => navegadores.delete(nav));
    // lo que un navegador manda no se lee: la página no le da órdenes al sitio
    ws.on('message', () => {});
    huboCambios = true;
    repartir(true);
    return undefined;
  }

  /** El `upgrade` del servidor. Sólo las dos puertas: otra ruta se corta. */
  function alUpgrade(req, socket, head) {
    let ruta = null;
    try { ruta = new URL(req.url, 'http://sitio.invalid').pathname; } catch { /* abajo */ }
    if (ruta !== '/live/machine' && ruta !== '/live/offices') { socket.destroy(); return; }
    puerta.handleUpgrade(req, socket, head, (ws) => {
      // antes que cualquier cierre: un cuadro inválido en una conexión que se está cerrando emite un error, y sin quien lo
      // reciba tumba el proceso del sitio
      ws.on('error', (e) => log(`oficinas: una conexión de ${ruta} falló (${e.code || 'sin código'})`));
      // los cuadros de control no pasan por el tope de mensajes: uno suelto (un intermediario) no molesta, una lluvia se corta
      let desde = 0;
      let cuenta = 0;
      const contarControl = () => {
        const t = Date.now();
        if (t - desde >= 1000) { desde = t; cuenta = 0; }
        cuenta += 1;
        if (cuenta <= T.mensajesPorSegundo) return;
        // lo que ya llegó se sigue procesando después del corte: se deja de escuchar, para avisar y cortar una sola vez
        ws.off('ping', contarControl);
        ws.off('pong', contarControl);
        log(`oficinas: una conexión de ${ruta} pasó de ${T.mensajesPorSegundo} cuadros de control por segundo: se corta`);
        ws.terminate();
      };
      ws.on('ping', contarControl);
      ws.on('pong', contarControl);
      try { (ruta === '/live/machine' ? abrirMaquina : abrirNavegador)(ws, req); }
      catch (e) { log(`oficinas: abrir una conexión de ${ruta} falló (${e.message})`); ws.terminate(); }
    });
  }

  return {
    alUpgrade, revisar, repartir, conversacion,
    oficina: (id) => oficinas.get(id) || null,
    conectada: (id) => maquinas.has(id),
    detener() {
      clearInterval(relojReparto);
      clearInterval(relojRevision);
      for (const c of sinAutenticar) { if (c.reloj) clearTimeout(c.reloj); c.ws.terminate(); }
      for (const c of maquinas.values()) c.ws.terminate();
      for (const n of navegadores) n.ws.terminate();
      puerta.close();
    },
  };
}

module.exports = { crearCentro, limpiarFoto, limpiarCharla, direccionDe, TOPES, PLAZOS };
