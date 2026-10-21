'use strict';
// legacy-options.js — que una opción vieja siga andando en un guion de scripts/ci
//
// 🔴 POR QUÉ EXISTE, Y POR QUÉ NO ES aliasOptions DE scripts/lib/legacy-names.js. Los pipelines de los productos corren
// los guiones de esta carpeta también desde el artefacto `arnes-ci`, que es SÓLO esta carpeta: en la etapa de
// producción no hay scripts/lib ni el mapa de renombres. Este traductor vive en la misma carpeta y no lee el mapa: cada
// guion declara sus pares viejo:nuevo, y `spanish-names.js --check-map` verifica que el mapa (scripts/lib/renames.json,
// la lista oficial) y cada guion digan lo mismo. Es el par de legacy-options.sh; en el retiro se sacan los pares de los
// dos lados y, sin pares, los dos se borran.
//
// Uso:
//   const { aliasLegacyOptions, LegacyOptionsError } = require('./legacy-options.js');
//   argv = aliasLegacyOptions(argv, 'tipo:type proyecto:project type=formulario:form', 'scripts/ci/<guion>.js');
//   (LegacyOptionsError con la vieja y la nueva juntas: el guion lo trata como a su opción desconocida)
//
// Qué hace: pasa `--viejo` y `--viejo=x` a `--nuevo` hasta un `--`; con un par `opcion=viejo:nuevo`, el
// valor viejo de esa opción —el argumento siguiente o lo que va tras `=`— pasa al nuevo. Cada nombre viejo usado se anota con la biblioteca
// general si está (scripts/lib/legacy-names.js: registro de usos y, en Azure DevOps, el warning de la corrida); en el
// artefacto, sin la biblioteca, deja igual el warning de la corrida. Guía: guides/maintaining/nombres-en-ingles.md.

class LegacyOptionsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LegacyOptionsError';
  }
}

/**
 * Los pares de una declaración como [{ kind, old, new }]: «viejo:nuevo» es una opción; «opcion=viejo:nuevo» es un valor
 * viejo de esa opción (su nombre nuevo), con `option`.
 */
function parsePairs(pairs) {
  return String(pairs || '').split(/\s+/).filter(Boolean).map((p) => {
    const eq = p.indexOf('=');
    const colon = p.indexOf(':');
    if (eq > 0 && eq < colon) return { kind: 'value', option: p.slice(0, eq), old: p.slice(eq + 1, colon), new: p.slice(colon + 1) };
    return { kind: 'option', old: p.slice(0, colon), new: p.slice(colon + 1) };
  });
}

// 🔴 stdout y stderr al mismo lugar = quien llama guarda la salida como dato (`X=$(node … 2>&1)`): el warning de la
// corrida terminaría adentro del dato, por ejemplo en las notas de versión (ver legacy-options.sh).
function sameOutput() {
  try { const a = require('fs').fstatSync(1); const b = require('fs').fstatSync(2); return a.dev === b.dev && a.ino === b.ino; } catch { return false; }
}

function note(old, nu, where, kind = 'option') {
  let lib = null;
  try { lib = require('../lib/legacy-names.js'); } catch { /* el artefacto arnes-ci: sin scripts/lib */ }
  const merged = sameOutput();
  if (lib && typeof lib.recordUse === 'function') {
    lib.recordUse({ kind, old, new: nu, script: where }, merged ? { env: { ...process.env, TF_BUILD: '' } } : {});
    return;
  }
  if (!merged && /^true$/i.test(String(process.env.TF_BUILD || ''))) {
    const shown = kind === 'option' ? [`--${old}`, `--${nu}`] : [old, nu];
    try {
      process.stderr.write(`##vso[task.logissue type=warning]nombre viejo «${shown[0]}» (${kind}) en ${where}: sigue andando y no es la causa de ningún error de este paso — cuando puedas, cambialo por «${shown[1]}» (el viejo se retira: guides/maintaining/nombres-en-ingles.md)\n`);
    } catch { /* anotar nunca rompe */ }
  }
}

/** El argv con las opciones viejas de `pairs` pasadas a las nuevas, y los valores viejos de una opción a los nuevos. */
function aliasLegacyOptions(argv, pairs, where) {
  const all = parsePairs(pairs);
  const list = all.filter((p) => p.kind === 'option');
  const values = all.filter((p) => p.kind === 'value');
  const seenOld = new Set();
  const seenNew = new Set();
  const noted = new Set();
  const value = (v, opt) => {
    const p = values.find((x) => x.option === opt && x.old === v);
    if (!p) return v;
    if (!noted.has(`${opt}=${p.old}`)) note(p.old, p.new, where, 'value');
    noted.add(`${opt}=${p.old}`);
    return p.new;
  };
  const out = [];
  let done = false;
  let prev = null;   // la opción (nombre nuevo) del argumento anterior, si era `--x` sin `=`
  for (const a0 of argv || []) {
    let a = String(a0);
    const after = prev;
    prev = null;
    if (!done && a === '--') done = true;
    else if (!done && a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      const byOld = list.find((p) => p.old === name);
      const nuName = byOld ? byOld.new : name;
      const rest = eq < 0 ? '' : `=${value(a.slice(eq + 1), nuName)}`;
      if (eq < 0) prev = nuName;
      if (byOld) {
        if (!seenOld.has(byOld.old)) note(byOld.old, byOld.new, where);
        seenOld.add(byOld.old);
        a = `--${byOld.new}${rest}`;
      } else {
        if (list.some((p) => p.new === name)) seenNew.add(name);
        a = `--${name}${rest}`;
      }
    } else if (!done && after) a = value(a, after);
    out.push(a);
  }
  for (const p of list) {
    if (seenOld.has(p.old) && seenNew.has(p.new)) {
      throw new LegacyOptionsError(`la misma opción dos veces: --${p.old} y --${p.new} (--${p.old} es el nombre viejo de --${p.new})`);
    }
  }
  return out;
}

// La declaración de pares en un guion, para --check-map: `legacy_options '<pares>'` (bash) o
// `aliasLegacyOptions(<argv>, '<pares>'` (JS). Devuelve null si el guion no declara nada.
const DECLARATION = /(?:\blegacy_options\s+|\baliasLegacyOptions\([^\n']*?,\s*)'([^']*)'/g;
function declaredPairs(text) {
  const found = [];
  for (const m of String(text).matchAll(DECLARATION)) found.push(...parsePairs(m[1]));
  return found.length ? found : null;
}

module.exports = { aliasLegacyOptions, LegacyOptionsError, parsePairs, declaredPairs };
