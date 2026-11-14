'use strict';
/**
 * signature-log.js — el registro común de las firmas: `signatures.jsonl`, en la carpeta de estado de la casa de la
 * cuenta (al lado de `gates.log`), un renglón por firma dada.
 *
 * Cada renglón dice quién firmó (`signer`), por qué vía (`via`: window, terminal, delegation, command, la de un
 * comando de emergencia, o review, la coordinadora con la revisión automática del plan), si fue delegada, quién la pidió (`ordered_by`), sobre qué sesión (`target`), su id y su nivel
 * en el catálogo (signatures.js: una firma de hoy o un id de la tabla de niveles), la huella de la máquina
 * (machine-id.js), la hora, el motivo y el guion que la escribió (`source`).
 *
 * Lo escribe `firmar()` de owner-window.js, por donde pasan las firmas de los guiones, y lo puede llamar cualquier
 * camino nuevo de firma. Los registros de cada guion y el renglón `-signed` de `gates.log` siguen como estaban.
 *
 * No lanza: si no puede escribir, devuelve `{ ok: false, error }` y quien llama avisa y sigue, porque la firma ya se dio.
 * Los escapes del freno de seguridad no pasan por acá: su constancia se escribe al pedir la ventana, antes de la firma.
 */
const fs = require('fs');
const path = require('path');

const cat = require('./signatures.js');
const { casaDeLaCuenta } = require('./real-home.js');

const stateDir = (casa) => require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js')).stateDir(casa);

const FILE = 'signatures.jsonl';
// `review`: la coordinadora por delegación, respaldada por el veredicto aprobado de la revisión automática que ella lanzó
// (la aprobación de un plan de rutina): nivel 1, delegada
// `notified`: lo de rutina que se hizo sin firma en una pestaña sin permisos, con aviso a la persona (owner-window.js)
// `click` y `message`: la aprobación explícita de la persona sin terminal, un click en el cuadro de opciones o su
// «aprobado» escrito, anotada por un gancho (owner-approvals.js)
const VIAS = Object.freeze(['window', 'terminal', 'delegation', 'command', 'review', 'notified', 'click', 'message']);
const DELEGADAS = Object.freeze(['delegation', 'review']);
const MOTIVO_MAX = 500;

const una = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

/** La ruta del registro en esa casa (la de la cuenta si no se dice). */
function logPath(home) {
  return path.join(stateDir(home === undefined ? casaDeLaCuenta() : home), FILE);
}

/** El nivel y lo que cubre un id: una firma de hoy, o un id de la tabla de niveles. null si no es ninguno. */
function nivelDe(id, delegada) {
  const s = cat.SIGNATURES.find((x) => x.id === id);
  if (s) return { level: delegada ? cat.delegatedLevel(id) : s.level, covers: [...s.covers] };
  const l = cat.LEVELS.find((x) => x.id === id);
  return l ? { level: l.level, covers: [l.id] } : null;
}

function maquina(huella) {
  try {
    const fp = (huella || (() => require('./machine-id.js').huella()))();
    return fp && !fp.error && fp.huella ? fp.huella : null;
  } catch (_) { return null; }
}

/**
 * Agrega el renglón de una firma. `{ ok: true, path }` o `{ ok: false, error }`; nunca lanza.
 * `home`, `now` y `huella` se pasan en las pruebas.
 */
function appendSignature({ signature, via, signer = null, orderedBy = null, target = null, reason = '', source = null, key = null, home, now = Date.now(), huella } = {}) {
  try {
    if (!VIAS.includes(via)) return { ok: false, error: `la vía «${via}» no es una de ${VIAS.join(', ')}` };
    const n = nivelDe(signature, DELEGADAS.includes(via));
    if (!n) return { ok: false, error: `«${signature}» no es un id del catálogo de firmas` };
    const renglon = {
      ts: new Date(now).toISOString(), signature, level: n.level, covers: n.covers, via, delegated: DELEGADAS.includes(via),
      signer, ordered_by: orderedBy, target, machine: maquina(huella), reason: una(reason, MOTIVO_MAX), source,
      // la clave del pedido (la de su fila en la lista de firmas): con ella, la firma cierra sólo ese pedido
      ...(key ? { key: String(key) } : {}),
    };
    const p = logPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, `${JSON.stringify(renglon)}\n`);
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: e.code || e.message };
  }
}

/**
 * Los registros de firmas que mira la poda de los marcadores: el de la carpeta de estado donde viven los marcadores
 * (`estado`, la que sale de HOME) y el de la casa de la cuenta, donde escribe `appendSignature`. Son el mismo cuando
 * HOME es la casa de la cuenta; si difieren, mirar sólo uno dejaría sin ver las firmas del otro.
 */
function signaturePathsFor(estado) {
  const out = [path.join(estado, FILE)];
  try { const p = logPath(); if (!out.includes(p)) out.push(p); } catch (_) { /* sin la casa de la cuenta, el de la HOME */ }
  return out;
}

/**
 * La hora de la última firma sobre una sesión (`target` u `ordered_by` igual a `sessionId`): `{ ts }`, `{ ts: null }`
 * sin ninguna (o sin registro), o `{ error }` si un registro existe y no se lee. Una firma con `ts` ilegible o posterior
 * a `now` no cuenta: una hora futura dejaría viva la corrida para siempre. `paths`: los registros a mirar.
 */
function lastSignatureFor(sessionId, { paths = [logPath()], now = Date.now() } = {}) {
  let ultima = null;
  for (const p of paths) {
    let texto;
    try { texto = fs.readFileSync(p, 'utf8'); } catch (e) {
      if (e && e.code === 'ENOENT') continue;
      return { error: `no pude leer el registro de firmas ${p} (${(e && e.code) || (e && e.message) || e})` };
    }
    for (const l of texto.split('\n')) {
      if (!l.includes(sessionId)) continue;
      let o;
      try { o = JSON.parse(l); } catch (_) { continue; }
      if (!o || (o.target !== sessionId && o.ordered_by !== sessionId)) continue;
      const t = typeof o.ts === 'string' ? Date.parse(o.ts) : NaN;
      if (!Number.isFinite(t) || t > now) continue;
      if (ultima === null || t > ultima) ultima = t;
    }
  }
  return { ts: ultima === null ? null : new Date(ultima).toISOString() };
}

/**
 * Para las podas de los marcadores: ¿la sesión tiene una firma más nueva que el corte? `{ viva }` o `{ error }`. Una
 * corrida que el dueño firmó no está abandonada aunque su marcador lleve horas sin tocarse; y no saber si la firmaron no
 * es «no la firmaron».
 */
function signedSince(sessionId, estado, cutoffMs) {
  const r = lastSignatureFor(sessionId, { paths: signaturePathsFor(estado) });
  if (r.error) return { error: r.error };
  return { viva: r.ts !== null && Date.parse(r.ts) >= cutoffMs };
}

module.exports = { FILE, VIAS, logPath, appendSignature, signaturePathsFor, lastSignatureFor, signedSince };
