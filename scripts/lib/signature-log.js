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
function appendSignature({ signature, via, signer = null, orderedBy = null, target = null, reason = '', source = null, home, now = Date.now(), huella } = {}) {
  try {
    if (!VIAS.includes(via)) return { ok: false, error: `la vía «${via}» no es una de ${VIAS.join(', ')}` };
    const n = nivelDe(signature, DELEGADAS.includes(via));
    if (!n) return { ok: false, error: `«${signature}» no es un id del catálogo de firmas` };
    const renglon = {
      ts: new Date(now).toISOString(), signature, level: n.level, covers: n.covers, via, delegated: DELEGADAS.includes(via),
      signer, ordered_by: orderedBy, target, machine: maquina(huella), reason: una(reason, MOTIVO_MAX), source,
    };
    const p = logPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, `${JSON.stringify(renglon)}\n`);
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: e.code || e.message };
  }
}

module.exports = { FILE, VIAS, logPath, appendSignature };
