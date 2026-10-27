'use strict';
/**
 * delegated-ok — la sesión designada aprueba una firma en nombre del dueño.
 *
 * Tres firmas se pueden aprobar así: «force-manual», «trust-ran» y «una vuelta más» (`DELEGABLES`). Vale sólo con todo
 * esto junto:
 *   (a) el perfil del equipo la delega (`approvals.delegated_signing`, por su id o por su grupo) y no es sólo del dueño
 *       (`approvals.owner_only`: una firma en las dos listas deja delegated_signing rota, y no se delega nada);
 *   (b) la organización usa una sesión que reenvía (`approvals.relay_session`) y está designada en esta máquina;
 *   (c) el dueño TIPEÓ «aprobá <firma>» en la conversación de esa sesión, hace `VENTANA_MIN` minutos o menos, sin
 *       preguntarlo, negarlo ni echarse atrás después. Lo pegado, lo que llegó de otra sesión o de una herramienta no
 *       cuenta (person-ok.js). «aprobá todo» no nombra ninguna firma;
 *   (d) después de ese mensaje, la sesión designada mandó uno a esta sesión que aprueba esa firma («apruebo <firma>»);
 *   (e) ese «aprobá» del dueño no se usó antes: sirve para UNA firma, y el uso queda anotado en el gates.log.
 *
 * La diferencia con el reenvío de siempre (escape-ok.js): ahí la frase tiene que llegar textual, y el arnés no sabe si la
 * escribió el dueño o la sesión que la reenvía. Acá se busca lo que tipeó el dueño en la conversación de esa sesión.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const VENTANA_MIN = 30;
const USADA = 'delegated-ok-used';
// el id de la firma en el catálogo (scripts/lib/signatures.js) y los nombres con que se la pide
const DELEGABLES = {
  'escape:force-manual': ['force-manual'],
  'escape:trust-ran': ['trust-ran'],
  'extra-round': ['una vuelta más', 'una vuelta mas', 'extra-round'],
};
const VERBO_DUENIO = 'aprob[aá]';
const VERBO_SESION = '(?:aprob[aá]|apruebo|aprobado|aprobada)';

/** El juez de un «aprobá <firma>»: la oración la nombra, no pregunta ni niega, y nada posterior la retira. */
function juezDe(firma, verbo) {
  const eo = require('./escape-ok.js');
  const jueces = DELEGABLES[firma].map((n) => eo.juez(n, verbo));
  const f = (texto) => {
    let motivo = null;
    for (const j of jueces) { const m = j(texto); if (!m) return null; motivo = motivo || m; }
    return motivo;
  };
  f.retracta = (texto) => jueces.some((j) => j.retracta(texto));
  return f;
}

/** ¿El perfil del equipo delega `firma`? null si sí, o el motivo. */
function perfilLaDelega(firma, { env, home, arnes }) {
  const lector = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'tycon-config.js');
  let r;
  try { r = require(lector).cargar({ env, home, ...(arnes ? { arnes } : {}) }); } catch (e) { return `el lector de configuración falló (${e.message})`; }
  const cat = require(path.join(path.dirname(lector), 'signatures.js'));
  const a = (r.valores && r.valores.approvals) || {};
  const ids = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).flatMap((x) => cat.expand(x));
  if (!ids(a.delegated_signing).includes(firma)) return `el perfil del equipo no delega «${firma}» (approvals.delegated_signing)`;
  if (ids(a.owner_only).includes(firma)) return `«${firma}» es sólo del dueño en el perfil del equipo (approvals.owner_only)`;
  return null;
}

function leerGates(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'gates.log'), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

/**
 * ¿La sesión designada aprobó `firma` en nombre del dueño? `{ ok, motivo?, relevo?, cita?, cuando? }`. Con `ok`, el uso
 * queda anotado. `desde`: la hora a partir de la cual vale el «aprobá» del dueño (el aviso del tope, para una vuelta
 * más); nunca antes de la ventana. `pedido`: la punta de la cadena de esta conversación (el freno la tiene).
 */
function okDelegado({ firma, sesion, pedido, home, env = process.env, arnes, ahora = Date.now(), desde } = {}) {
  const no = (motivo) => ({ ok: false, motivo });
  if (!Object.prototype.hasOwnProperty.call(DELEGABLES, firma)) return no(`«${firma}» no se aprueba por delegación`);
  const casa = home || os.homedir();
  const e = { ...env, ...(sesion ? { CLAUDE_CODE_SESSION_ID: String(sesion) } : {}) };
  const perfil = perfilLaDelega(firma, { env: e, home: casa, arnes });
  if (perfil) return no(perfil);
  const cw = require('./critical-waivers.js');
  const relevo = cw.sesionQueReenvia({ env: e, home: casa, ...(arnes ? { arnes } : {}) });
  if (!relevo.valor) return no(`la organización no declara la sesión que aprueba por el dueño (approvals.relay_session)${relevo.aviso ? `: ${relevo.aviso}` : ''}`);
  const pok = require('./person-ok.js');
  const l = pok.laDesignada(relevo.valor, { sesion, home: casa, env: e, soloCadena: !!pedido, pedido });
  if (!l.legible) return no(`no puedo leer la conversación de esta sesión (${l.motivo})`);
  if (l.rechazo) return no(l.rechazo);
  let t0 = ahora - VENTANA_MIN * 60000;
  if (desde && Date.parse(desde) > t0) t0 = Date.parse(desde);
  // lo que tipeó el dueño en la conversación designada: el «aprobá» más nuevo de la ventana que la nombra
  const delDuenio = l.duenio.filter((t) => Date.parse(t.cuando || '') >= t0);
  const juezDuenio = juezDe(firma, VERBO_DUENIO);
  let pedidoDelDuenio = null;
  for (let i = delDuenio.length - 1; i >= 0 && !pedidoDelDuenio; i--) {
    if (juezDuenio(delDuenio[i].texto)) continue;
    if (delDuenio.slice(i + 1).some((t) => juezDuenio.retracta(t.texto))) return no('después de su «aprobá», el dueño se echó atrás');
    pedidoDelDuenio = delDuenio[i];
  }
  if (!pedidoDelDuenio) return no(`el dueño no tipeó «aprobá ${DELEGABLES[firma][0]}» en la conversación de la ${relevo.valor} en los últimos ${VENTANA_MIN} minutos${desde ? ' (después del aviso)' : ''}`);
  // el mensaje de la designada a esta sesión, posterior al del dueño, que aprueba esa firma
  const juezSesion = juezDe(firma, VERBO_SESION);
  const t1 = Date.parse(pedidoDelDuenio.cuando);
  const suyo = l.reenviados.filter((t) => Date.parse(t.cuando || '') >= t1 && !juezSesion(t.texto)).pop();
  if (!suyo) return no(`la ${relevo.valor} no mandó a esta sesión un mensaje que apruebe «${DELEGABLES[firma][0]}» después del pedido del dueño`);
  // un «aprobá» del dueño, una firma
  const clave = `${l.designada}|${pedidoDelDuenio.cuando}`;
  const dir = require('./state-dir.js').stateDir(casa);
  let usos;
  try { usos = leerGates(dir); } catch (err) { return no(`no pude leer el registro del arnés (${err.code || err.message}): no sé si ese «aprobá» ya se usó`); }
  if (usos.some((g) => g.name === USADA && g.clave === clave)) return no('ese «aprobá» del dueño ya se usó para otra firma: cada firma pide el suyo');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'gates.log'), `${JSON.stringify({ ts: new Date(ahora).toISOString(), name: USADA, status: 'ok', firma, clave, relevo: relevo.valor, sesion: sesion || null, cita: pedidoDelDuenio.texto.slice(0, 200) })}\n`);
  return { ok: true, relevo: relevo.valor, cita: pedidoDelDuenio.texto, cuando: pedidoDelDuenio.cuando };
}

module.exports = { DELEGABLES, VENTANA_MIN, USADA, okDelegado };
