'use strict';
/**
 * signed-record-approval.js — el registro del cuadro que aprobó el dueño, en cada constancia nueva.
 *
 * POR QUÉ EXISTE. Una constancia («no se escribe a mano») se puede escribir por caminos que el freno de escrituras no
 * ve, y la CI no tiene otro modo de saber quién la aprobó: todo lo que deja una aprobación vive en la carpeta de estado
 * de la máquina, y nada de eso viaja en git. Con esta pieza, el comando que escribe una constancia con la aprobación del
 * dueño le agrega el registro de ese cuadro, y la CI pide que cada constancia nueva traiga uno que corresponda. No hay
 * llave, para que ande igual en Mac, Windows y Linux: un registro inventado y escrito por un camino que el freno no ve
 * pasa la CI. Lo que lo impide es el freno.
 *
 * QUÉ HAY ACÁ, con una sola lista para los escritores y para la CI:
 *   · CATALOGO y entradaDe(ruta): qué archivos llevan el cuadro, qué líneas y qué firmas valen en cada uno.
 *   · aprobacionDe(r, firma): lo que el cuadro guarda de la aprobación que devolvió `exigir` (owner-window.js), o null
 *     cuando no la dio una persona (la delegación, lo hecho y avisado, la firma de trámite).
 *   · conCuadro(linea, aprobacion): la línea con su `cuadro: { aprobacion, firma, via, aprobada_en, huella }`.
 *   · huella(linea): el sha256 de la línea sin `cuadro`, en JSON con las claves ordenadas y sin blancos.
 *   · verificar(...): si una línea nueva corresponde a un cuadro (la regla `constancia-sin-cuadro` de tycon-ci-gate.js).
 *   · MODO: 'aviso' (la CI lo dice y pasa) o 'freno' (frena). Lo cambia un commit, nunca una variable ni una opción.
 *
 * Sin dependencias fuera del arnés: sólo `crypto` y el catálogo de las firmas (signatures.js, que no carga nada).
 */
const crypto = require('crypto');
const { isId } = require('./signatures.js');

// 'aviso' mientras haya máquinas que firman sin escribir el cuadro. Pasar a 'freno' es un commit que cambia este valor,
// con su constancia de cambio de control; ninguna variable, opción ni archivo lo cambia. Las pruebas lo fijan dentro del
// proceso con `module.exports.MODO`
const MODO = 'aviso';
const modo = () => (module.exports.MODO === 'aviso' ? 'aviso' : 'freno');

// las vías con que una persona aprueba: el click en el cuadro, el «aprobado» tipeado, la terminal y la ventana de permiso
const VIAS = Object.freeze(['click', 'mensaje', 'terminal', 'ventana']);

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const esHex64 = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

/** JSON con las claves ordenadas en todos los niveles y sin blancos: la misma línea da siempre el mismo texto. */
function canonico(x) {
  if (Array.isArray(x)) return `[${x.map(canonico).join(',')}]`;
  if (x && typeof x === 'object') return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canonico(x[k])}`).join(',')}}`;
  return JSON.stringify(x === undefined ? null : x);
}

/** El sha256 de la línea (un objeto) sin `cuadro`: reformatearla o cambiar el orden de sus claves no lo cambia. */
function huella(linea) {
  const { cuadro, ...resto } = linea || {}; // eslint-disable-line no-unused-vars
  return sha256(canonico(resto));
}

// la firma de cada exención, por su campo (`marker.js sign-file <firma> <archivo>`)
const FIRMA_DE_EXENCION = Object.freeze({ advisors_exempt: 'advisors_exempt', dod_runtime_exempt: 'dod_runtime_exempt' });

/**
 * Las constancias que viajan en git y firma una persona. `entero`: el archivo es una sola constancia
 * (un `.json` por firma); si no, cada línea de un `.jsonl`. `mira(l)`: qué líneas llevan el cuadro (todas, salvo en las
 * aprobaciones de una ejecución, donde sólo las manuales). `firmas(l)`: los nombres de firma que valen en esa línea.
 */
const CATALOGO = Object.freeze([
  { nombre: 'control-changes', patron: /^\.(?:github|tycon)\/control-changes\/[^/]+\.json$/i, entero: true,
    firmas: () => ['control-change', 'refresh-after-main'] },
  { nombre: 'control-changes', patron: /^\.(?:github|tycon)\/control-changes\.jsonl$/i,
    firmas: () => ['control-change', 'refresh-after-main'] },
  { nombre: 'exemptions', patron: /^\.tycon\/exemptions\.jsonl$/i,
    firmas: (l) => (l && FIRMA_DE_EXENCION[l.campo] ? [FIRMA_DE_EXENCION[l.campo]] : []) },
  { nombre: 'runtime-waivers', patron: /^\.tycon\/runtime-waivers\.jsonl$/i, firmas: () => ['runtime-waiver'] },
  // las de una ejecución, en la raíz o en una subcarpeta (como las lee `carpetasDeCorrida` de approvals.js); cada línea
  // manual nombra la firma que la escribió, y vale cualquiera del catálogo de las firmas
  { nombre: 'approvals', patron: /(?:^|\/)\.advisors\/pipeline-runs\/[^/]+\/approvals\.jsonl$/i,
    mira: (l) => Boolean(l) && l.tipo === 'manual', firmas: (l, firma) => (isId(firma) ? [firma] : []) },
]);

const sinBarras = (ruta) => String(ruta || '').replace(/\\/g, '/').replace(/^\.\//, '');
/** La entrada del catálogo de una ruta relativa a la raíz del repo, o null si no lleva cuadro. */
function entradaDe(ruta) {
  const r = sinBarras(ruta);
  return CATALOGO.find((e) => e.patron.test(r)) || null;
}

/**
 * Lo que el cuadro guarda de una aprobación, a partir de lo que devolvió `exigir` (owner-window.js):
 *   · click o mensaje: el id del registro de la aprobación (owner-approvals.js, el sha256 de su línea) y su hora;
 *   · ventana: el id del pedido de la ventana (el sha256 de su registro canónico) y su hora: que dijo «Sí» se sabe
 *     porque el comando corrió;
 *   · terminal: el del registro si lo hay (Codex) o, en la terminal del dueño, uno nuevo con la hora.
 * La delegación, la revisión, lo hecho y avisado y la firma de trámite no son una persona: null (va sin cuadro).
 */
function aprobacionDe(r, firma, { ahora = Date.now() } = {}) {
  if (!r || r.codigo !== 0 || typeof firma !== 'string' || !firma) return null;
  const reg = r.registro && typeof r.registro === 'object' ? r.registro : null;
  const via = r.via;
  if ((via === 'click' || via === 'mensaje') && reg && esHex64(reg.aprobacion)) {
    return { aprobacion: reg.aprobacion, firma, via, aprobada_en: String(reg.aprobada_en || reg.ts || '') };
  }
  if (via === 'ventana' && reg) return { aprobacion: sha256(canonico(reg)), firma, via, aprobada_en: String(reg.ts || '') };
  if (via === 'terminal') {
    if (reg && esHex64(reg.aprobacion)) return { aprobacion: reg.aprobacion, firma, via, aprobada_en: String(reg.aprobada_en || reg.ts || '') };
    const cuando = new Date(ahora).toISOString();
    return { aprobacion: sha256(`terminal\n${firma}\n${cuando}\n${crypto.randomBytes(16).toString('hex')}`), firma, via, aprobada_en: cuando };
  }
  return null;
}

/** La línea (un objeto) con el registro del cuadro; sin aprobación de una persona, la línea como estaba. */
function conCuadro(linea, aprobacion) {
  if (!aprobacion) return linea;
  const { cuadro, ...resto } = linea || {}; // eslint-disable-line no-unused-vars
  return { ...resto, cuadro: { ...aprobacion, huella: huella(resto) } };
}

/** El aviso de un escritor que escribe una constancia sin cuadro: la CI en freno no la deja entrar. */
const SIN_CUADRO = 'va sin el cuadro del dueño: con la CI en freno, el pedido no entra; repetí la firma con el cuadro';

/** Los ids de aprobación que nombra un texto (una línea, un archivo, la historia de git): los de los cuadros. */
function aprobacionesEnTexto(texto) {
  const out = new Set();
  for (const m of String(texto || '').matchAll(/"aprobacion"\s*:\s*"([0-9a-f]{64})"/g)) out.add(m[1]);
  return out;
}

/**
 * ¿La línea nueva `texto` de `ruta` corresponde a un cuadro? `{ ok: true }` o `{ ok: false, motivo }`. Fuera del catálogo
 * o en una línea que no lleva cuadro (las automáticas de una ejecución) es `{ ok: true, fuera: true }`.
 *   · aprobacionesDeLaBase: los ids que ya aparecen en la historia de la base (un cuadro no se usa dos veces);
 *   · delPedido: por id, las {firma, aprobada_en} de las líneas nuevas del pedido (las de una misma acción comparten id).
 */
function verificar({ ruta, texto, aprobacionesDeLaBase = new Set(), delPedido = new Map() } = {}) {
  const e = entradaDe(ruta);
  if (!e) return { ok: true, fuera: true };
  let l;
  try { l = JSON.parse(String(texto)); } catch (_) { return { ok: false, motivo: 'no es JSON: no es una constancia' }; }
  if (!l || typeof l !== 'object' || Array.isArray(l)) return { ok: false, motivo: 'no es un objeto JSON: no es una constancia' };
  if (e.mira && !e.mira(l)) return { ok: true, fuera: true };
  const c = l.cuadro;
  if (!c || typeof c !== 'object') return { ok: false, motivo: 'no trae el cuadro del dueño' };
  const faltan = ['aprobacion', 'firma', 'via', 'aprobada_en', 'huella'].filter((k) => typeof c[k] !== 'string' || !c[k]);
  if (faltan.length) return { ok: false, motivo: `el cuadro está incompleto (falta ${faltan.join(', ')})` };
  if (!esHex64(c.aprobacion) || !esHex64(c.huella)) return { ok: false, motivo: 'el cuadro no tiene la forma de un registro (su id y su huella son sha256)' };
  if (!e.firmas(l, c.firma).includes(c.firma)) return { ok: false, motivo: `la firma «${String(c.firma).slice(0, 60)}» no es la de este archivo` };
  if (!VIAS.includes(c.via)) return { ok: false, motivo: `«${String(c.via).slice(0, 40)}» no es una vía de una persona (${VIAS.join(', ')})` };
  if (c.huella !== huella(l)) return { ok: false, motivo: 'la huella del cuadro no es la de esta línea: el cuadro es de otra, o la línea cambió después' };
  if (aprobacionesDeLaBase.has(c.aprobacion)) return { ok: false, motivo: 'esa aprobación ya se usó en la historia de la base' };
  const otras = (delPedido.get(c.aprobacion) || []).filter((o) => o.firma !== c.firma || o.aprobada_en !== c.aprobada_en);
  if (otras.length) return { ok: false, motivo: 'la misma aprobación aparece en otra firma del pedido' };
  return { ok: true };
}

module.exports = {
  MODO, modo, VIAS, CATALOGO, FIRMA_DE_EXENCION, SIN_CUADRO,
  canonico, huella, entradaDe, aprobacionDe, conCuadro, aprobacionesEnTexto, verificar,
};
