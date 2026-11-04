'use strict';
/*
 * fields.js — lo que comparten la máquina y el sitio de la organización: la lista de campos de la foto de la oficina y
 * el protocolo de la conexión. La lista es una sola: lo que la página lee de la foto, con la forma de cada campo. La
 * máquina arma con ella lo que manda (`pick`) y el sitio vuelve a aplicarla a lo que recibe.
 *
 * Un campo que `collect()` suma después no viaja hasta entrar acá o en `LOCAL_ONLY`, con su motivo. Lo que la página
 * calcula sola (la ropa y el pelo de cada persona) no viaja. Los sobres viajan sin texto: el mensaje entero va con la
 * conversación de cada sesión, que sale en su propio mensaje (`charla`, con la forma de `CHARLA`) y sólo a un sitio que
 * la anuncia en su `ack`.
 * Casos: scripts/tests/office-site-link.test.js (T1, T47, T48)
 */
const crypto = require('crypto');
const path = require('path');

const TEXT_MAX = 200;
const MAX_MESSAGE_BYTES = 64 * 1024;
// un mensaje de la conversación viaja entero hasta este largo; la foto corta a TEXT_MAX
const CHARLA_TEXT_MAX = 8000;
// la conversación de una sesión sale a lo sumo una vez por minuto: la de la coordinadora se lee de hasta 64 MB
const CHARLA_EVERY_MS = 60 * 1000;
// entre dos conversaciones que salen, al menos esto: el sitio corta la conexión que pasa de 10 mensajes por segundo
const CHARLA_GAP_MS = 200;
const PR_SITES = ['github', 'azure'];
// una tirada sin espacios más larga (un volcado, un hash, una clave pegada) no viaja: el saneador tarda segundos con miles de
// caracteres seguidos, y cortada podría dejar ver la punta de una clave
const RUN_MAX = 200;
const LONG_RUN = new RegExp(`\\S{${RUN_MAX + 1},}`, 'g');
const runOut = (m) => `[${m.length} caracteres seguidos: no viajan]`;
/** Los primeros `n` caracteres, cortados en un espacio: un corte a mitad de palabra podría partir una clave y dejar pasar su punta. */
function headAtSpace(s, n) {
  if (s.length <= n) return s;
  const head = s.slice(0, n);
  const at = head.search(/\s\S*$/);
  return at > 0 ? head.slice(0, at) : head;
}

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
const longText = { form: 'longText' };
const list = (of) => ({ form: 'list', of });
const record = (fields) => ({ form: 'object', fields });
// un objeto cuyas claves son nombres de sesión (como los tokens): la clave se sanea y se corta como un texto
const byName = (of) => ({ form: 'byName', of });
const END = record({ hora: text, dif: text, cls: oneOf(END_CLASSES) });
const OTHER_PROJECT = 'Otro proyecto';
// Una fila de una tabla. El título de un trabajo de otro proyecto, o de uno que no se sabe de qué proyecto es, no sale de la
// máquina: ni en la fila ni en sus trabajos.
const tableRow = (fields) => ({ form: 'tableRow', fields });
const TABLE = record({ titulo: text, columnas: list(text), filas: list(tableRow({ grupo: text, que: text, col: text, trabajos: list(record({ titulo: text, numero: text, quien: text, como: text })) })), escrito: text, cruce: text, vacio: text });
// a quién espera la mano levantada de una sesión
const HANDS = ['dueno', 'coordinadora'];

const FIELDS = {
  agents: list(record({
    nombre: text, estado: oneOf(AGENT_STATES), comoTrabaja: text, titulo: text, historia: text, encargo: text, haciendo: text, haciendoAhora: text, agentesAhora: text, ultimaAccion: action,
    espera: text, parada: text, callada: text, mientras: text, mientrasEstado: oneOf(AGENT_STATES), enPausa: text,
    fin: END, horaPorque: text, estimadaIso: hour, avance: number, carpeta: folder, pasos: list(record({ name: text, done: flag })), novedadMs: number, sinPid: flag,
    // a quién espera la mano levantada
    mano: oneOf(HANDS), manoEtiqueta: text, manoPor: text,
  })),
  kanban: record({
    escrito: text,
    linea: text,
    columnas: list(record({
      id: oneOf(KANBAN_COLUMNS), nombre: text, nota: text,
      tarjetas: list(record({ titulo: text, numero: text, quien: text, hora: text, grupo: text, espera: text, marca: text, motivo: text, nota: text, otro: flag, mano: oneOf(HANDS), pedido: record({ numero: number, sitio: oneOf(PR_SITES), ruta: text }) })),
    })),
    medioCamino: list(record({ titulo: text, quien: text, accion: text })),
    medioCaminoNoSe: text,
    medioCaminoLeido: text,
  }),
  tablas: record({ hoy: TABLE, pendientes: TABLE, hechos: TABLE }),
  meta: record({ actualizado: text, pedidosLeidos: text, teToca: list(text), trabado: list(record({ titulo: text, filas: list(text) })), extra: number, puestos: list(list(number)), sitio: text, quietMin: number }),
  rows: list(record({ work: text, state: text, end: text, session: text, folder })),
  free: list(text),
  unreadable: list(text),
  tablero: record({}),
  tokens: byName(record({ contexto: text, consumidos: text, agentes: number, noMedido: flag })),
  sobres: list(record({ id: text, de: text, a: text, at: number })),
};

/** Lo que la foto trae y no viaja, con por qué. La prueba que compara las listas (T47) exige que cada campo esté acá o arriba. */
const LOCAL_ONLY = Object.freeze({
  items: 'la página lo guarda pero no dibuja ninguno de sus campos: los pendientes le llegan por `kanban`',
  // de cada sesión, lo que `collect()` usa para armar otros campos que sí viajan
  termina: 'es el texto con que se arma `fin`, que viaja: la página dibuja la hora desde `fin`',
  atrasada: 'decide la clase de `fin` (`late`), que viaja: la página no lo lee',
  atrasoMin: 'es la diferencia escrita en `fin.dif`, que viaja: la página no lo lee',
  pronosticoIso: 'es la hora que usa la tabla de /wip; la oficina muestra `fin`, que viaja',
  tipo: 'decide qué sesiones van al panel de pendientes, que viaja ya armado en `kanban`',
  orden: 'el orden de los escritorios es el de la lista `agents`, que viaja en ese orden',
  // los de un lugar solo de la foto van con su ruta: el mismo nombre en otro lugar sí viaja
  'agents.pasos.id': 'la página dibuja cada paso por su nombre y por si está hecho; el identificador del paso no se muestra',
  'kanban.anteriores': 'lo terminado otros días llega ya armado en `tablas`, que viaja',
  'kanban.columnas.tarjetas.cls': 'el color de la hora de una tarjeta lo calcula la página desde `hora`; la clase no se usa',
  'tablero.actualizado': 'la hora en que se escribió el tablero llega en `kanban.escrito`, que viaja',
  'tablero.teToca': 'lo que te toca llega en `meta.teToca`, que lo junta con las firmas y viaja',
});

// La conversación de una sesión: lo que devuelve la ruta local de la conversación (`readConversation`), con cada texto
// hasta CHARLA_TEXT_MAX. `recortada`: no entraba en 64 KB y se sacaron los mensajes más viejos.
const MESSAGE = record({ de: text, texto: longText, at: number, propio: flag });
const CHARLA = record({
  sinCoordinadora: flag,
  conCoordinadora: list(MESSAGE),
  arranque: record({ texto: longText, at: number }),
  conVos: list(record({ quien: text, texto: longText, at: number })),
  conSesiones: list(record({ sesion: text, at: number, mensajes: list(MESSAGE) })),
  recortada: flag,
});

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
    // las tiradas largas sin espacios salen antes de sanear (el proceso de la oficina no puede trabarse por un mensaje), y el
    // texto se corta en un espacio; el corte final es sobre lo ya saneado
    case 'longText': return typeof value === 'string' ? sanitize(headAtSpace(value.replace(LONG_RUN, runOut), CHARLA_TEXT_MAX * 2), home).slice(0, CHARLA_TEXT_MAX) : undefined;
    case 'byName': {
      if (typeof value !== 'object' || Array.isArray(value)) return undefined;
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        const c = cleaned(spec.of, v, home, sanitize);
        if (c !== undefined && c !== null) out[cut(k)] = c;
      }
      return out;
    }
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
    case 'tableRow': {
      if (typeof value !== 'object' || Array.isArray(value)) return undefined;
      const row = pickFields(spec.fields, value, home, sanitize);
      if (value.otro !== true) return row;
      // en una fila mezclada se tapa el trabajo que corresponde; la frase de la fila junta títulos, así que se tapa siempre. De
      // «cómo va» queda sólo la columna: lo demás puede ser una nota de ese trabajo
      const works = Array.isArray(value.trabajos) ? value.trabajos : [];
      const marked = works.some((w) => w && w.otro === true);
      const masked = (w) => ({ ...w, titulo: OTHER_PROJECT, ...(typeof w.como === 'string' ? { como: w.como.split(' · ')[0] } : {}) });
      return { ...row, que: OTHER_PROJECT, ...(row.trabajos ? { trabajos: row.trabajos.map((w, i) => (!marked || (works[i] && works[i].otro === true) ? masked(w) : w)) } : {}) };
    }
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

/** La conversación que sale de la máquina: con la forma de `CHARLA`, cada texto saneado y hasta CHARLA_TEXT_MAX. */
function pickCharla(datos, home) {
  const { sanear } = require(path.join(__dirname, '..', '..', 'metrics', 'tokens-digest.js'));
  return pickFields(CHARLA.fields, datos && typeof datos === 'object' && !Array.isArray(datos) ? datos : {}, home, sanear);
}

/** El nombre de una sesión como sale en la foto: la conversación se busca en el sitio por ese mismo valor. */
function sessionName(name, home) {
  const { sanear } = require(path.join(__dirname, '..', '..', 'metrics', 'tokens-digest.js'));
  return cleaned(text, String(name), home, sanear);
}

// El protocolo. Lo que la máquina le puede mandar al sitio y lo único que acepta de él. `charla` va sólo a un sitio cuyo
// `ack` trae `puede` con `charla` (CAPABILITIES): uno anterior cierra con 1008 un tipo que no conoce.
const MESSAGES = Object.freeze({ toSite: ['auth', 'foto', 'ping', 'charla'], toMachine: ['challenge', 'ack', 'pong'] });
const CAPABILITIES = Object.freeze(['charla']);
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

module.exports = { FIELDS, LOCAL_ONLY, CHARLA, TEXT_MAX, CHARLA_TEXT_MAX, CHARLA_EVERY_MS, CHARLA_GAP_MS, MAX_MESSAGE_BYTES, AGENT_STATES, validHour, pick, pickCharla, sessionName, MESSAGES, CAPABILITIES, CLOSE, SITE_HEADER, SIGNATURE_PREFIX, NONCE_BYTES, siteAddress, signedText, validNonce, machineUrl, fingerprintOf, displayFingerprint };
