'use strict';
/**
 * owner-away.js — la marca del dueño ausente. La pone quien recibe el mensaje del dueño cuando dice que se va (la
 * coordinadora, o la propia sesión si no hay coordinadora): con la marca puesta, las revisiones siguen la celda de «dueño
 * ausente» enseguida, sin esperar los minutos sin respuesta. No hay una lista de frases: lo juzga quien recibe el mensaje.
 *
 * Se borra sola cuando el dueño vuelve: un mensaje tipeado por la persona (el gancho de cada mensaje), un mensaje de la
 * oficina verificado, una firma suya posterior a la marca (los renglones `<firma>-signed` de gates.log por ventana,
 * terminal, click o mensaje; una firma por delegación no cuenta) o el vencimiento a las 24 horas. Cada puesta y cada
 * borrado dejan un renglón `owner-away` en gates.log con quién la puso o qué la borró, la hora y la frase.
 *
 * La marca vive en la carpeta de estado del arnés (`owner-away.json`): es de la máquina, no de una sesión.
 */
const fs = require('fs');
const path = require('path');

const ARCHIVO = 'owner-away.json';
const VENCE_MS = 24 * 3600 * 1000;
// las vías de una firma que da el dueño en persona (las de owner-window.js); `delegacion` y `revision` son de la coordinadora
const VIAS_DEL_DUENO = Object.freeze(['ventana', 'terminal', 'click', 'mensaje']);

const estadoDe = (o) => o.estado || require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js')).stateDir(o.home);
const archivo = (estado) => path.join(estado, ARCHIVO);

function anotar(estado, r, ahora) {
  fs.mkdirSync(estado, { recursive: true });
  fs.appendFileSync(path.join(estado, 'gates.log'), `${JSON.stringify({ ts: new Date(ahora).toISOString(), name: 'owner-away', status: 'ok', ...r })}\n`);
}

// `{ m }` con la marca (null si no hay), o `{ m: null, problem }` si el archivo existe y no se puede leer: una marca rota
// no es lo mismo que ninguna marca, y quien la consulta lo dice
function leer(estado) {
  let texto;
  try { texto = fs.readFileSync(archivo(estado), 'utf8'); } catch (e) {
    return e.code === 'ENOENT' ? { m: null } : { m: null, problem: `no pude leer ${ARCHIVO} (${e.code || e.message})` };
  }
  try {
    const m = JSON.parse(texto);
    return m && typeof m.setAt === 'string' ? { m } : { m: null, problem: `${ARCHIVO} no tiene la forma de una marca (falta setAt)` };
  } catch (_) { return { m: null, problem: `${ARCHIVO} no es JSON válido` }; }
}

/** Pone la marca: `quien` (la sesión o su nombre) y `frase` (lo que dijo el dueño). `{ codigo: 0, mark }` o `{ codigo: 2, motivo }`. */
function set(o = {}) {
  const frase = String(o.frase || '').trim();
  const quien = String(o.quien || '').trim();
  if (!frase) return { codigo: 2, motivo: 'falta la frase del dueño (--phrase "<lo que dijo>")' };
  if (!quien) return { codigo: 2, motivo: 'falta quién pone la marca' };
  const estado = estadoDe(o);
  const ahora = o.ahora == null ? Date.now() : o.ahora;
  const mark = { setAt: new Date(ahora).toISOString(), quien, frase: frase.slice(0, 300) };
  fs.mkdirSync(estado, { recursive: true });
  const tmp = `${archivo(estado)}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(mark, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, archivo(estado));
  anotar(estado, { accion: 'set', quien: mark.quien, frase: mark.frase }, ahora);
  return { codigo: 0, mark };
}

/**
 * Borra la marca, con el motivo. `{ cleared: true|false }`: sin marca no hay nada que borrar ni renglón. Si la marca no se
 * puede leer o borrar, `{ cleared: false, problem }`: quien llama lo dice, porque la marca sigue puesta.
 */
function clear(o = {}) {
  const estado = estadoDe(o);
  const ahora = o.ahora == null ? Date.now() : o.ahora;
  const { m, problem } = leer(estado);
  if (problem) return { cleared: false, problem };
  if (!m) return { cleared: false };
  try { fs.unlinkSync(archivo(estado)); } catch (e) { if (e.code !== 'ENOENT') return { cleared: false, problem: e.code || e.message }; }
  anotar(estado, { accion: 'clear', motivo: String(o.motivo || 'sin motivo').slice(0, 300), puesta: m.setAt, quien: m.quien, frase: m.frase }, ahora);
  return { cleared: true };
}

/** La firma del dueño más vieja posterior a `desde` (ms), o null. */
function firmaDelDuenoDesde(estado, desde) {
  let lineas = [];
  try { lineas = fs.readFileSync(path.join(estado, 'gates.log'), 'utf8').split('\n'); } catch (_) { return null; }
  for (const l of lineas) {
    if (!l || l.indexOf('-signed') < 0) continue;
    let j;
    try { j = JSON.parse(l); } catch (_) { continue; }
    if (!j || typeof j.name !== 'string' || !/-signed$/.test(j.name) || j.status !== 'ok' || !VIAS_DEL_DUENO.includes(j.via)) continue;
    const ts = Date.parse(j.ts);
    if (Number.isFinite(ts) && ts > desde) return j;
  }
  return null;
}

/**
 * La marca vigente: `{ mark }` (null si no hay). Antes de devolverla, la borra si venció o si el dueño firmó después de
 * puesta, y lo anota. Con `problem` cuando la marca no se pudo leer o borrar: el dueño cuenta como presente, y quien
 * consulta lo dice.
 */
function get(o = {}) {
  const estado = estadoDe(o);
  const ahora = o.ahora == null ? Date.now() : o.ahora;
  const { m, problem } = leer(estado);
  if (!m) return problem ? { mark: null, problem } : { mark: null };
  const desde = Date.parse(m.setAt);
  let motivo = null;
  if (!Number.isFinite(desde) || ahora - desde >= VENCE_MS) motivo = 'venció a las 24 h de puesta';
  else {
    const f = firmaDelDuenoDesde(estado, desde);
    if (f) motivo = `firma del dueño (${String(f.name).replace(/-signed$/, '')}, por ${f.via})`;
  }
  if (!motivo) return { mark: m };
  const r = clear({ estado, ahora, motivo });
  return r.problem ? { mark: null, problem: `la marca ya no vale (${motivo}) y no la pude borrar: ${r.problem}` } : { mark: null };
}

module.exports = { ARCHIVO, VENCE_MS, VIAS_DEL_DUENO, set, clear, get };
