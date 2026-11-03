'use strict';
/*
 * fields.js — lo que comparten la máquina y el sitio de la organización: la lista de campos de la foto de la oficina y
 * el protocolo de la conexión. La lista es una sola: lo que la página lee de la foto, con la forma de cada campo. La
 * máquina arma con ella lo que manda (`pick`) y el sitio vuelve a aplicarla a lo que recibe.
 *
 * Un campo que `collect()` suma después no viaja hasta entrar acá. Lo que la página calcula sola (la ropa y el pelo de
 * cada persona) no viaja, ni `items`, cuyos campos la página no lee: los pendientes le llegan por `kanban`. Tampoco viajan
 * `sobres` ni la conversación de una sesión: son sólo de la oficina abierta en la máquina.
 * Casos: scripts/tests/office-site-link.test.js
 */
const crypto = require('crypto');
const path = require('path');

const TEXT_MAX = 200;
const MAX_MESSAGE_BYTES = 64 * 1024;

const AGENT_STATES = ['trabajando', 'prueba', 'parada', 'espera', 'esperando', 'firma', 'pregunta', 'libre', 'coordina', 'inactiva'];
const END_CLASSES = ['late', 'early', 'ontime', ''];
const KANBAN_COLUMNS = ['firma', 'curso', 'entrando', 'sinEmpezar', 'hechos'];
const LOCAL_HOUR = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)$/;

const text = { form: 'text' };
const folder = { form: 'folder' };
const number = { form: 'number' };
const flag = { form: 'flag' };
const hour = { form: 'hour' };
const action = { form: 'action' };
const oneOf = (values) => ({ form: 'state', values });
const list = (of) => ({ form: 'list', of });
const record = (fields) => ({ form: 'object', fields });
const END = record({ hora: text, dif: text, cls: oneOf(END_CLASSES) });
const TABLE = record({ titulo: text, columnas: list(text), filas: list(record({ grupo: text, que: text, col: text })), escrito: text, cruce: text, contar: flag });

const FIELDS = {
  agents: list(record({
    nombre: text, estado: oneOf(AGENT_STATES), comoTrabaja: text, titulo: text, historia: text, encargo: text, haciendo: text, haciendoAhora: text, ultimaAccion: action,
    espera: text, parada: text, callada: text, mientras: text, mientrasEstado: oneOf(AGENT_STATES), enPausa: text,
    fin: END, horaPorque: text, estimadaIso: hour, avance: number, carpeta: folder, pasos: list(record({ name: text, done: flag })), novedadMs: number, sinPid: flag,
  })),
  kanban: record({
    escrito: text,
    columnas: list(record({
      id: oneOf(KANBAN_COLUMNS), nombre: text, nota: text,
      tarjetas: list(record({ titulo: text, quien: text, hora: text, grupo: text, espera: text, marca: text, motivo: text, nota: text, otro: flag })),
    })),
    medioCamino: list(record({ titulo: text, accion: text })),
    medioCaminoNoSe: text,
    medioCaminoLeido: text,
  }),
  tablas: record({ hoy: TABLE, pendientes: TABLE, hechos: TABLE }),
  meta: record({ actualizado: text, pedidosLeidos: text, teToca: list(text), trabado: list(record({ titulo: text, filas: list(text) })), extra: number, puestos: list(list(number)), sitio: text, quietMin: number }),
  rows: list(record({ work: text, state: text, end: text, session: text, folder })),
  free: list(text),
  unreadable: list(text),
  tablero: record({ resumen: text }),
};

function validHour(value) {
  const m = LOCAL_HOUR.exec(value);
  if (!m) return false;
  // en UTC: la hora es local de la máquina, y en la zona de quien valida puede caer justo en un cambio de hora
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] && d.getUTCHours() === +m[4] && d.getUTCMinutes() === +m[5];
}

/** Sólo el último tramo de la ruta: una ruta entera dice la carpeta personal y cómo está ordenado el disco. */
const folderName = (value) => value.replace(/[\\/]+$/, '').split(/[\\/]/).pop();

/** De la última acción, qué hizo y a qué hora: el nombre de un archivo puede decir el de un cliente, y el saneador no lo ve. */
const withoutFile = (value) => {
  const parts = value.split(' · ');
  const last = parts[parts.length - 1];
  return parts.length > 1 && /^a las \d\d:\d\d$/.test(last) ? `${parts[0]} · ${last}` : parts[0];
};

/** Lo que viaja de un valor según su forma; `undefined` si no tiene esa forma. Primero se sanea y después se recorta: un corte antes dejaría pasar la punta de una clave. */
function cleaned(spec, value, home, sanitize) {
  if (value === null) return null;
  const cut = (s) => sanitize(s, home).slice(0, TEXT_MAX);
  switch (spec.form) {
    case 'text': return typeof value === 'string' ? cut(value) : undefined;
    case 'folder': return typeof value === 'string' ? cut(folderName(value)) : undefined;
    case 'action': return typeof value === 'string' ? cut(withoutFile(value)) : undefined;
    case 'number': return Number.isFinite(value) ? value : undefined;
    case 'flag': return typeof value === 'boolean' ? value : undefined;
    case 'state': return spec.values.includes(value) ? value : undefined;
    case 'hour': return typeof value === 'string' && validHour(value) ? value : undefined;
    case 'list':
      if (!Array.isArray(value)) return undefined;
      return value.map((v) => cleaned(spec.of, v, home, sanitize)).filter((v) => v !== undefined && v !== null);
    case 'object':
      if (typeof value !== 'object' || Array.isArray(value)) return undefined;
      return pickFields(spec.fields, value, home, sanitize);
    default: return undefined;
  }
}

function pickFields(fields, source, home, sanitize) {
  const out = {};
  for (const [name, spec] of Object.entries(fields)) {
    if (!Object.prototype.hasOwnProperty.call(source, name)) continue;
    const v = cleaned(spec, source[name], home, sanitize);
    if (v !== undefined) out[name] = v;
  }
  return out;
}

/**
 * Lo que sale de la máquina: un objeto nuevo sólo con los campos de la lista, cada texto saneado y recortado. `home` es la
 * carpeta personal de la máquina, que el saneador borra. El saneador se carga recién acá: el sitio usa la lista sin él.
 */
function pick(foto, home) {
  const { sanear } = require(path.join(__dirname, '..', '..', 'metrics', 'tokens-digest.js'));
  return pickFields(FIELDS, foto && typeof foto === 'object' ? foto : {}, home, sanear);
}

// El protocolo. Lo que la máquina le puede mandar al sitio y lo único que acepta de él.
const MESSAGES = Object.freeze({ toSite: ['auth', 'foto', 'ping'], toMachine: ['challenge', 'ack', 'pong'] });
const CLOSE = Object.freeze({ pending: 4401, revoked: 4403, unknown: 4404, displaced: 4409, policy: 1008 });
// lo pone el sitio al contestar sus rutas de la máquina: así se distingue del candado de la plataforma, que va delante
const SITE_HEADER = 'x-tycon-offices';
const SIGNATURE_PREFIX = 'tycon-office-v1';
const NONCE_BYTES = 32;

/** La dirección del sitio tal como entra en la firma: una conversación grabada con otro sitio no sirve para éste. */
const siteAddress = (site) => new URL(site).origin;
/** Lo que firma la máquina: siempre este texto, nunca lo que el sitio mande tal cual. */
const signedText = (site, nonce) => `${SIGNATURE_PREFIX}|${siteAddress(site)}|${nonce}`;
/** ¿El desafío trae un nonce de 32 bytes? */
const validNonce = (nonce) => typeof nonce === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(nonce) && Buffer.from(nonce, 'base64').length === NONCE_BYTES;

/** La dirección de la conexión de la máquina, o null si la dirección del sitio no es web. */
function machineUrl(site) {
  try {
    const u = new URL(site);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}/live/machine`;
  } catch { return null; }
}

/** La huella: el sha256 de los 32 bytes de la clave pública, en hexadecimal. */
const fingerprintOf = (publicKey) => crypto.createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex');
/** La huella como la ven las personas: sus primeros 16 caracteres en grupos de cuatro, igual en la máquina y en el sitio. */
const displayFingerprint = (fingerprint) => String(fingerprint).slice(0, 16).match(/.{1,4}/g).join('-');

module.exports = { FIELDS, TEXT_MAX, MAX_MESSAGE_BYTES, AGENT_STATES, validHour, pick, MESSAGES, CLOSE, SITE_HEADER, SIGNATURE_PREFIX, NONCE_BYTES, siteAddress, signedText, validNonce, machineUrl, fingerprintOf, displayFingerprint };
