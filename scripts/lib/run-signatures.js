'use strict';
/**
 * run-signatures.js — las firmas de una ejecución, tomadas del registro común (`signatures.jsonl`, signature-log.js),
 * listas para viajar en su volcado al buzón.
 *
 * Las firmas de una ejecución son los renglones cuyo `target` es una de sus sesiones y cuya hora cae entre su arranque y
 * su cierre. El registro se lee en dos casas: la de la cuenta, donde `appendSignature` escribe por defecto, y la de
 * HOME si es otra, donde escribe `firmar()` cuando el guion anota su propio gates.log. Un renglón igual en las dos
 * cuenta una vez; el que sólo está en la de HOME sale con `otra_casa: true`.
 *
 * Cada línea viaja con ocho campos y nada más (cuando, firma, nivel, via, delegada, quien, pedida_por, razon). La razón
 * no se llama `motivo`: el sitio traduce con sus moldes toda cadena bajo esa clave. Los ids de sesión se acortan a 8
 * caracteres antes de sanear, porque `sanear` cambia todo id entero por «<sesión>». Sin el saneador no sube ninguna
 * línea. Tope de 200 líneas y 64 KB: pasado cualquiera, salen las más recientes y `recortadas` cuenta el resto.
 *
 * Nunca tira: lo que no se puede leer o calcular sale `no_medido` con su motivo.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { logPath, VIAS } = require('./signature-log.js');

const TOPE_LINEAS = 200;
const TOPE_BYTES = 64 * 1024;
const MAX_RAZON = 300;
const MAX_TEXTO = 160;
const FIRMA = /^[\w.:-]{1,60}$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ES_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIN_SANEADOR = 'el saneado (tokens-digest.js) no está en esta máquina: las firmas no se subieron';
const SIN_ARRANQUE = 'la ejecución no anotó su hora de arranque: no se sabe qué firmas son suyas';
const SIN_SESION = 'la sesión no se conoce: no se sabe qué firmas son suyas';

const noMedido = (motivo) => ({ estado: 'no_medido', motivo });

/** Todo id de sesión entero de un texto, en sus primeros 8 caracteres (como /office). */
const acortarIds = (s) => String(s).replace(UUID, (u) => u.slice(0, 8));

/** El saneador por defecto, de tokens-digest.js; null si no está. */
function saneadorPorDefecto() {
  try {
    const d = require(path.join(__dirname, '..', 'metrics', 'tokens-digest.js'));
    return typeof d.sanear === 'function' ? d.sanear : null;
  } catch (_) { return null; }
}

/**
 * Las casas del registro por defecto: la de la cuenta y la de HOME, sin repetir. Sin la de la cuenta no se sigue con
 * la de HOME sola: ahí escribe `appendSignature`, y no mirarla haría pasar «no pude mirar» por «no hubo firmas».
 */
function casasPorDefecto(cuenta = () => require('./real-home.js').casaDeLaCuenta()) {
  let deLaCuenta;
  try { deLaCuenta = cuenta(); } catch (e) {
    throw Object.assign(new Error(`no supe dónde está la casa de la cuenta (${e.code || e.message}): las firmas no se midieron`), { esLectura: true });
  }
  if (typeof deLaCuenta !== 'string' || !deLaCuenta) {
    throw Object.assign(new Error('no supe dónde está la casa de la cuenta: las firmas no se midieron'), { esLectura: true });
  }
  const casas = [deLaCuenta];
  const home = os.homedir();
  if (path.resolve(deLaCuenta) !== path.resolve(home)) casas.push(home);
  return casas;
}

/**
 * Los renglones de cada casa: `{ renglones: [{ o, otra }], ilegibles, leidas }`. Un renglón igual a uno de una casa
 * anterior se cuenta una vez; dentro de un mismo archivo, cada renglón cuenta, aunque se repita.
 */
function leerCasas(casas) {
  const deAntes = new Set();
  const crudos = [];
  let ilegibles = 0;
  let leidas = 0;
  const rutas = new Set();
  casas.forEach((casa, i) => {
    const p = logPath(casa);
    const real = path.resolve(p);
    if (rutas.has(real)) return;
    rutas.add(real);
    let texto;
    try { texto = fs.readFileSync(p, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return;
      throw Object.assign(new Error(`no pude leer el registro común de firmas (${e.code || 'error'})`), { esLectura: true });
    }
    leidas += 1;
    const deEsta = [];
    for (const l of texto.split('\n')) {
      const t = l.trim();
      if (!t || deAntes.has(t)) continue;
      deEsta.push(t);
      crudos.push({ texto: t, otra: i > 0 });
    }
    for (const t of deEsta) deAntes.add(t);
  });
  const renglones = [];
  for (const r of crudos) {
    let o;
    try { o = JSON.parse(r.texto); } catch (_) { ilegibles += 1; continue; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) { ilegibles += 1; continue; }
    renglones.push({ o, otra: r.otra });
  }
  return { renglones, ilegibles, leidas };
}

/** Corta a `n` caracteres contando por letra, no por mitad de emoji. */
function cortar(s, n) {
  const letras = Array.from(s);
  return letras.length > n ? `${letras.slice(0, n - 1).join('')}…` : s;
}
const texto = (v, n, sanear) => (v === null || v === undefined ? null : cortar(String(sanear(acortarIds(String(v)), os.homedir())).trim(), n));

/**
 * Las firmas de una ejecución. `sesiones`: sus ids; `desde` y `hasta`: su ventana (ms o ISO, inclusive); `casas`: las
 * casas del registro (por defecto, la de la cuenta y la de HOME); `sanear`: la función de tokens-digest.js (por
 * defecto, la cargada; algo que no es función: sin saneador).
 */
function deCorrida({ sesiones, desde, hasta, casas, sanear } = {}) {
  try {
    const san = sanear === undefined ? saneadorPorDefecto() : sanear;
    if (typeof san !== 'function') return noMedido(SIN_SANEADOR);
    const ses = (Array.isArray(sesiones) ? sesiones : []).filter((s) => typeof s === 'string' && s);
    if (!ses.length) return noMedido(SIN_SESION);
    const d = typeof desde === 'number' ? desde : Date.parse(desde || '');
    const h = typeof hasta === 'number' ? hasta : Date.parse(hasta || '');
    if (!Number.isFinite(d)) return noMedido(SIN_ARRANQUE);
    if (!Number.isFinite(h)) return noMedido('la ejecución no tiene hora de cierre: no se sabe qué firmas son suyas');
    let leido;
    try {
      const lista = typeof casas === 'function' ? casas() : casas;
      leido = leerCasas(Array.isArray(lista) && lista.length ? lista : casasPorDefecto());
    } catch (e) {
      return noMedido(e.esLectura ? e.message : `no pude leer el registro común de firmas (${e.code || 'error'})`);
    }
    if (!leido.leidas) return { estado: 'ausente' };
    let ilegibles = leido.ilegibles;
    const todas = [];
    for (const { o, otra } of leido.renglones) {
      if (!ses.includes(o.target)) continue;
      const t = Date.parse(o.ts || '');
      if (!Number.isFinite(t)) { ilegibles += 1; continue; }
      if (t < d || t > h) continue;
      // el id de la firma pasa por el mismo acortador y saneador que los textos: después tiene que seguir siendo un id
      const id = typeof o.signature === 'string' && FIRMA.test(o.signature) ? texto(o.signature, 60, san) : null;
      if (!id || !FIRMA.test(id) || !VIAS.includes(o.via)) { ilegibles += 1; continue; }
      const pide = typeof o.ordered_by === 'string' && ES_UUID.test(o.ordered_by) && !ses.includes(o.ordered_by) ? o.ordered_by : null;
      const linea = {
        cuando: new Date(t).toISOString(),
        firma: id,
        nivel: Number.isInteger(o.level) ? o.level : null,
        via: o.via,
        delegada: o.delegated === true,
        quien: texto(o.signer, MAX_TEXTO, san),
        pedida_por: pide ? texto(pide, MAX_TEXTO, san) : null,
        razon: texto(o.reason, MAX_RAZON, san),
      };
      if (otra) linea.otra_casa = true;
      todas.push({ t, linea });
    }
    todas.sort((a, b) => a.t - b.t);
    // las más recientes primero, hasta llenar el tope de líneas o de bytes; después, en orden de hora
    const quedan = [];
    let bytes = 2;
    for (let i = todas.length - 1; i >= 0 && quedan.length < TOPE_LINEAS; i -= 1) {
      const b = Buffer.byteLength(JSON.stringify(todas[i].linea)) + (quedan.length ? 1 : 0);
      if (bytes + b > TOPE_BYTES) break;
      bytes += b;
      quedan.push(todas[i].linea);
    }
    quedan.reverse();
    return { estado: 'leido', lineas: quedan, ilegibles, recortadas: todas.length - quedan.length };
  } catch (e) {
    return noMedido(`no pude armar las firmas de la ejecución (${e.code || e.message})`);
  }
}

/**
 * Las firmas de una ejecución a partir de su volcado: sus sesiones (la del marcador, la adoptada y la restaurada) y su
 * ventana (del arranque al cierre del volcado, o `hasta` si se da). `{ casas, sanear, hasta }` van a `deCorrida`.
 * Adoptar o restaurar otra vez pisa `adoptedFrom` y `restoredFrom`: de una cadena, sólo cuenta la última de cada clase.
 */
function deVolcado(dump, { casas, sanear, hasta } = {}) {
  try {
    const m = dump && dump.marker;
    if (!m || typeof m !== 'object') return noMedido('el volcado no trae su marcador: no se sabe qué firmas son suyas');
    const sesiones = [m.sessionId, m.adoptedFrom, m.restoredFrom].filter((s) => typeof s === 'string' && s);
    return deCorrida({ sesiones, desde: m.startedAt, hasta: hasta !== undefined ? hasta : dump.archivedAt, casas, sanear });
  } catch (e) {
    return noMedido(`no pude armar las firmas de la ejecución (${e.code || e.message})`);
  }
}

module.exports = { deCorrida, deVolcado, acortarIds, casasPorDefecto, TOPE_LINEAS, TOPE_BYTES, MAX_RAZON, MAX_TEXTO, SIN_SANEADOR, SIN_ARRANQUE, SIN_SESION };
