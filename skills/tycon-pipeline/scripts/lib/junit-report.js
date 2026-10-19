'use strict';

/**
 * junit-report.js — los totales de uno o varios reportes JUnit (pytest, gotestsum, Maven, Gradle, Karma y cualquier
 * herramienta que la organización declare con `results.format: junit`).
 *
 * Cuenta los <testcase>, no los atributos de <testsuite>: cada herramienta los escribe distinto y algunas no los
 * escriben. Un caso con <failure> o <error> es una falla; uno con <skipped>, una salteada. Nunca inventa un número: un
 * archivo que no se puede leer devuelve `ok: false` con el archivo y el motivo.
 */

const fs = require('fs');
const path = require('path');
const { leerXml } = require('./test-gate-report.js');

const local = (tag) => String(tag).replace(/^\{[^}]*\}/, '');
function porNombreLocal(el, nombre) {
  const out = [];
  const visitar = (e) => { if (local(e.tag) === nombre) out.push(e); for (const c of e.children) visitar(c); };
  visitar(el);
  return out;
}

/** `{ ok, total, passed, failed, skipped, files }`, o `{ ok: false, reason }`. */
function readJunit(files) {
  const lista = (Array.isArray(files) ? files : [files]).filter(Boolean);
  if (!lista.length) return { ok: false, reason: 'no hay reporte JUnit: la herramienta no dejó ningún archivo donde se lo esperaba' };
  let total = 0; let failed = 0; let skipped = 0;
  for (const f of lista) {
    let root;
    try { root = leerXml(fs.readFileSync(f, 'utf8')); } catch (e) {
      return { ok: false, reason: `${path.basename(f)}: no se pudo leer el reporte JUnit (${e && e.message ? e.message : e})` };
    }
    // por el nombre local: un reporte con espacio de nombres (`xmlns`) deja los tags como `{ns}testcase`
    for (const tc of porNombreLocal(root, 'testcase')) {
      total += 1;
      const hijos = tc.children.map((c) => local(c.tag));
      if (hijos.includes('failure') || hijos.includes('error')) failed += 1;
      else if (hijos.includes('skipped')) skipped += 1;
    }
  }
  return { ok: true, total, passed: total - failed - skipped, failed, skipped, files: lista.length };
}

module.exports = { readJunit };
