'use strict';
/*
 * invitations.js — INVITAR A ALGUIEN AL SITIO: EL NÚCLEO, SIN NINGUNA NUBE NI PROVEEDOR.
 *
 * Qué resuelve: con un inicio de sesión que sólo deja entrar a las cuentas del directorio de la organización, alguien de
 * afuera entra recién cuando está en el directorio (el primer candado) y en la lista del sitio (el segundo). «Invitar» en
 * Personas propone el alta en la lista con una marca en `site.invitations`; cuando ese pedido entra, este módulo manda
 * la invitación al directorio.
 *
 * LO DEL PROVEEDOR: quién sabe invitar lo decide el archivo del proveedor de inicio de sesión (`auth-providers/<x>.js`,
 * su `invitador`): si se puede con esta instalación, si la identidad del sitio tiene el permiso, dónde está verificado el
 * dominio de un correo, la invitación misma y el enlace al portal. Un proveedor sin `invitador` no muestra el botón y
 * Personas dice qué hacer en su lugar.
 *
 * EL ENVÍO, recalculado en cada ciclo de fuentes (`enviarPendientes`): cada correo de `site.invitations` que está en
 * la lista, sin huella de enviado ni de entró, se invita. Una falla se reintenta en el ciclo siguiente; hasta
 * `SITE_INVITATIONS_PER_DAY` (10) envíos aceptados por día UTC, y lo que pasa el tope espera al día siguiente.
 *
 * EL DISCO: `SITE_DATA_DIR/invitaciones.json`, con la huella HMAC de cada correo (como las preferencias de idioma), nunca
 * el correo. Un candado de archivo evita que dos réplicas manden la misma. Quien sale de la lista pierde sus huellas: si
 * vuelve a ser invitado, la invitación sale de nuevo. El registro del sitio nunca lleva el correo invitado.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const TX = require('./texts.js');

const M = (clave, valores) => TX.t('es', clave, valores);
const ARCHIVO = 'invitaciones.json';
const CANDADO = 'invitaciones.lock';
const CANDADO_VIEJO_MS = 10 * 60 * 1000;
const TOPE_POR_DEFECTO = 10;
const PERMISO_VIGENCIA_MS = 5 * 60 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// el nombre de los proveedores sin invitador que la pantalla nombra; el genérico (oidc) no tiene uno
const NOMBRES = { google: 'Google', github: 'GitHub' };

const norm = (c) => String(c || '').trim().toLowerCase();
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const diaDe = (t) => new Date(t).toISOString().slice(0, 10);

/** El módulo del proveedor de inicio de sesión del sitio, o null (el genérico no tiene archivo). */
function proveedorDe(cfg) {
  const nombre = cfg && cfg.inicioDeSesion && cfg.inicioDeSesion.proveedor;
  if (!nombre || !/^[a-z][a-z0-9-]*$/.test(nombre)) return null;
  const f = path.join(__dirname, 'auth-providers', `${nombre}.js`);
  return fs.existsSync(f) ? require(f) : null;
}

/** El invitador del proveedor armado para este sitio, o null si el proveedor no sabe invitar. */
function invitadorDe({ cfg, env, ...opciones }) {
  const p = proveedorDe(cfg);
  return p && typeof p.invitador === 'function' ? p.invitador({ cfg, env, ...opciones }) : null;
}

/**
 * ¿Aparece el botón? Con un proveedor que sabe invitar, si su instalación lo deja, y con el disco. Si no, `texto` dice
 * qué hacer en su lugar. `{ boton, motivo, texto }`.
 */
function disponibilidad({ cfg, env = process.env, dataDir, invitador = invitadorDe({ cfg, env }) }) {
  if (!invitador) {
    const nombre = NOMBRES[cfg.inicioDeSesion && cfg.inicioDeSesion.proveedor];
    return { boton: false, motivo: 'otro_proveedor', texto: nombre ? M('invitaciones.otroProveedor', { proveedor: nombre }) : M('invitaciones.otroProveedorOidc') };
  }
  const d = invitador.disponible();
  if (!d.ok) return { boton: false, motivo: d.motivo, texto: d.texto };
  if (!dataDir) return { boton: false, motivo: 'sin_disco', texto: M('invitaciones.sinDisco') };
  return { boton: true, motivo: d.motivo, texto: null };
}

/**
 * Las invitaciones de un sitio. `cfg` (publicUrl, issuer, inicioDeSesion), `env` (SITE_INVITATIONS_PER_DAY y las del
 * proveedor), `dataDir`, `llave` (la de sesión del sitio), `ahora`, `log`; lo demás va al invitador del proveedor (las
 * pruebas cambian ahí sus servidores).
 */
function crearInvitaciones({ cfg, env = process.env, dataDir = null, llave, ahora = Date.now, log = () => {}, ...opciones }) {
  const invitador = invitadorDe({ cfg, env, ...opciones });
  const archivo = dataDir ? path.join(dataDir, ARCHIVO) : null;
  const tope = (() => { const n = Number(env.SITE_INVITATIONS_PER_DAY); return Number.isInteger(n) && n > 0 ? n : TOPE_POR_DEFECTO; })();
  const huella = (correo) => crypto.createHmac('sha256', llave).update(norm(correo)).digest('hex');
  const disponible = () => disponibilidad({ cfg, env, dataDir, invitador });
  let permisoCache = null;

  // ── el disco ──
  // `control`: la huella de un texto fijo con la llave de hoy. Si no coincide, la llave cambió y las huellas del disco ya
  // no reconocen a nadie: sin esto, el ciclo siguiente volvería a mandar todas las invitaciones
  const CONTROL = huella('__control__');
  const vacio = () => ({ schema: 1, control: CONTROL, enviadas: {}, entraron: {}, fallas: {}, yaEstaban: {}, envios: {} });
  function leer() {
    if (!archivo) return vacio();
    try {
      const d = JSON.parse(fs.readFileSync(archivo, 'utf8'));
      const v = vacio();
      for (const k of Object.keys(v)) if (isObject(d[k])) v[k] = d[k];
      v.llaveNueva = typeof d.control === 'string' && d.control !== CONTROL;
      return v;
    } catch (e) {
      if (e && e.code === 'ENOENT') return vacio();
      // ilegible (cortado, corrupto): como con la llave cambiada, lo marcado se da por enviado y no se reenvía nada
      log(`invitaciones: el registro del disco no se pudo leer (${(e && (e.code || e.name)) || 'error'}): lo que ya está en la lista se da por enviado`);
      return { ...vacio(), llaveNueva: true };
    }
  }
  function guardar(d) {
    if (!archivo) return;
    const tmp = `${archivo}.${process.pid}.tmp`;
    const { llaveNueva: _l, ...limpio } = d;
    fs.writeFileSync(tmp, JSON.stringify({ ...limpio, control: CONTROL }));
    fs.renameSync(tmp, archivo);
  }
  /**
   * Guarda lo del ciclo sin pisar los ingresos que `entro()` anotó mientras el ciclo esperaba al proveedor (`entro()`
   * escribe sin el candado, desde cualquier réplica): se suman los del disco de quien sigue en la lista.
   */
  function guardarConIngresos(d, enLista) {
    const vivas = new Set([...enLista].map(huella));
    for (const h of Object.keys(leer().entraron)) if (vivas.has(h)) d.entraron[h] = true;
    guardar(d);
  }
  /** `fn` con el candado del disco: otra réplica que lo tiene hace que éste no mande nada en este ciclo. */
  async function conCandado(fn) {
    if (!dataDir) return null;
    const ruta = path.join(dataDir, CANDADO);
    let fd;
    try { fd = fs.openSync(ruta, 'wx'); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let viejo = false;
      try { viejo = ahora() - fs.statSync(ruta).mtimeMs > CANDADO_VIEJO_MS; } catch { viejo = true; }
      if (!viejo) { log('invitaciones: otra réplica está mandando; éste espera al próximo ciclo'); return null; }
      fs.rmSync(ruta, { force: true });
      fd = fs.openSync(ruta, 'wx');
    }
    try { return await fn(); } finally { fs.closeSync(fd); fs.rmSync(ruta, { force: true }); }
  }

  /** ¿La identidad del sitio tiene el permiso de invitar? `{ ok, texto?, comando? }`. Se recuerda unos minutos. */
  async function permiso() {
    if (!invitador) return { ok: false, texto: disponible().texto, comando: null };
    if (permisoCache && ahora() - permisoCache.t < PERMISO_VIGENCIA_MS) return permisoCache.r;
    const r = await invitador.permiso();
    permisoCache = { t: ahora(), r };
    return r;
  }

  /** Antes de proponer: `{ ok, correo, motivo?, aviso? }`. `config`: operations.json vigente. */
  async function revisarCorreo(correoIn, config) {
    const correo = norm(correoIn);
    if (!EMAIL.test(correo)) return { ok: false, correo, motivo: M('invitaciones.noEsCorreo', { correo: String(correoIn || '').trim().slice(0, 120) }) };
    const access = config && isObject(config.site) && Array.isArray(config.site.access) ? config.site.access : [];
    if (access.some((e) => isObject(e) && Array.isArray(e.emails) && e.emails.map(norm).includes(correo))) return { ok: false, correo, motivo: M('invitaciones.yaEnLista', { correo }) };
    if (!invitador) return { ok: true, correo };
    const dominio = await invitador.dominio(correo);
    if (dominio === 'no_contesto') return { ok: true, correo, aviso: M('invitaciones.dominioSinComprobar') };
    const a = invitador.aviso(dominio);
    if (a && a.rechazo) return { ok: false, correo, motivo: a.rechazo };
    return a && a.aviso ? { ok: true, correo, aviso: a.aviso } : { ok: true, correo };
  }

  // ── el envío ──
  const marcasDe = (config) => {
    const site = config && isObject(config.site) ? config.site : {};
    const enLista = new Set((Array.isArray(site.access) ? site.access : []).flatMap((e) => (isObject(e) && Array.isArray(e.emails) ? e.emails : [])).map(norm));
    const inv = isObject(site.invitations) ? site.invitations : {};
    return { enLista, correos: [...new Set(Object.keys(inv).filter((k) => !k.startsWith('__')).map(norm))].filter((c) => enLista.has(c)) };
  };
  /** Quien ya no está en la lista pierde sus huellas (si vuelve a ser invitado, la invitación sale de nuevo). */
  function podar(d, enLista) {
    const vivas = new Set([...enLista].map(huella));
    let n = 0;
    for (const k of ['enviadas', 'entraron', 'fallas', 'yaEstaban']) for (const h of Object.keys(d[k])) if (!vivas.has(h)) { delete d[k][h]; n++; }
    return n;
  }
  /** Un ciclo: manda lo que falta, dentro del tope del día. Nunca rechaza. `{ enviadas, fallas, esperan }`. */
  async function enviarPendientes(config) {
    const res = { enviadas: 0, fallas: 0, esperan: 0 };
    if (!disponible().boton) return res;
    try {
      await conCandado(async () => {
        const d = leer();
        const { enLista, correos } = marcasDe(config);
        if (d.llaveNueva) {
          // la llave de sesión cambió: lo del disco no se puede leer. Las marcas de hoy se dan por enviadas (no se manda
          // nada de nuevo); las que se sumen después salen como siempre
          const ahoraIso = new Date(ahora()).toISOString();
          Object.assign(d, { enviadas: {}, entraron: {}, fallas: {}, yaEstaban: {} });
          for (const correo of correos) d.enviadas[huella(correo)] = { el: ahoraIso };
          log(`invitaciones: la llave del sitio cambió; ${correos.length} invitación(es) de la lista se dan por enviadas, sin volver a mandarlas`);
          guardar(d);
          return;
        }
        let cambio = podar(d, enLista) > 0;
        const hoy = diaDe(ahora());
        for (const k of Object.keys(d.envios)) if (k !== hoy) { delete d.envios[k]; cambio = true; }
        for (const correo of correos) {
          const h = huella(correo);
          if (d.enviadas[h] || d.entraron[h] || d.yaEstaban[h]) continue;
          if ((d.envios[hoy] || 0) >= tope) { res.esperan++; continue; }
          const r = await invitador.invitar(correo);
          if (r.ok) {
            d.enviadas[h] = { el: new Date(ahora()).toISOString(), ...(r.usuario ? { usuario: r.usuario } : {}) };
            delete d.fallas[h];
            d.envios[hoy] = (d.envios[hoy] || 0) + 1;
            res.enviadas++;
            log('invitación enviada a una cuenta de la lista, pedida por quien mantiene');
          } else if (r.yaEstaba) {
            d.yaEstaban[h] = true; delete d.fallas[h];
            log('invitación: la cuenta ya era del directorio, no hacía falta invitar');
          } else {
            // el motivo va al disco y al registro: nunca con un correo adentro, aunque el proveedor lo haya repetido
            const motivo = String(r.falla || '').replace(/[^\s@<>"'()]+@[^\s@<>"'()]+/g, '<correo>');
            d.fallas[h] = { motivo, el: new Date(ahora()).toISOString() };
            res.fallas++;
            log(`invitación: no se pudo enviar a una cuenta de la lista (${motivo}); se reintenta en el próximo ciclo`);
          }
          // se guarda después de cada una: si el disco o algo de más adelante falla, lo ya enviado queda anotado
          guardarConIngresos(d, enLista);
          cambio = false;
        }
        if (cambio) guardarConIngresos(d, enLista);
      });
    } catch (e) { log(`invitaciones: el ciclo falló (${(e && e.code) || (e && e.message) || e}); se reintenta en el próximo`); }
    return res;
  }

  /** Quien entra al sitio: si estaba invitado, su invitación queda «aceptada». */
  function entro(correo) {
    if (!archivo) return;
    try {
      const d = leer();
      // con la llave cambiada (o el registro ilegible), el ciclo rehace el registro primero: escribir acá lo daría por
      // rehecho. Ese ingreso no queda anotado: la persona sale «enviada» hasta que vuelva a entrar
      if (d.llaveNueva) { log('invitaciones: un ingreso no se anotó porque el registro se está rehaciendo (llave nueva o archivo ilegible)'); return; }
      const h = huella(correo);
      if (d.entraron[h]) return;
      d.entraron[h] = true;
      guardar(d);
    } catch (e) { log(`invitaciones: no pude anotar un ingreso (${(e && e.code) || e})`); }
  }

  const portal = (usuario) => (invitador ? invitador.portal(usuario || null) : null);

  /** El estado de cada persona de `site.invitations`: `{ correo: { estado, texto, portal } }`. */
  function estados(config) {
    const d = leer();
    const { correos } = marcasDe(config);
    const llena = (d.envios[diaDe(ahora())] || 0) >= tope;
    const out = {};
    for (const correo of correos) {
      const h = huella(correo);
      const enviada = d.enviadas[h];
      const enlace = portal(enviada && enviada.usuario);
      if (d.entraron[h]) out[correo] = { estado: 'aceptada', texto: M('invitaciones.aceptada'), portal: enlace };
      else if (d.yaEstaban[h]) out[correo] = { estado: 'ya_estaba', texto: M('invitaciones.yaEstaba'), portal: enlace };
      else if (enviada) out[correo] = { estado: 'enviada', texto: M('invitaciones.enviada'), portal: enlace };
      else if (d.fallas[h]) out[correo] = { estado: 'falla', texto: M('invitaciones.falla', { motivo: d.fallas[h].motivo }), portal: enlace };
      else if (llena) out[correo] = { estado: 'tope', texto: M('invitaciones.tope'), portal: enlace };
      else out[correo] = { estado: 'por_enviar', texto: M('invitaciones.porEnviar'), portal: enlace };
    }
    return out;
  }

  /** El enlace del portal para sacar a alguien del directorio: el de su usuario si se sabe, si no la lista. */
  function portalDe(correo) {
    const e = leer().enviadas[huella(correo)];
    return portal(e && e.usuario);
  }

  return { disponibilidad: disponible, permiso, revisarCorreo, enviarPendientes, entro, estados, portalDe, codigoPorCorreo: invitador ? invitador.codigoPorCorreo : null, tope };
}

module.exports = { crearInvitaciones, disponibilidad, proveedorDe };
