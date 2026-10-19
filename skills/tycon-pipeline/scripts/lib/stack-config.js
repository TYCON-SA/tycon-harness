'use strict';

/**
 * stack-config.js — la clave `stack` del `team-repos.json` de la organización: las extensiones que también son código y
 * las reglas (cómo se nombran las pruebas, qué cuenta como pantalla, en qué idioma está la app).
 *
 * Mismo camino que el umbral de cobertura (`test-gate-report.js`, `resolverUmbral`): el árbol del arnés lo da
 * `harness-path.js` en modo hook, el archivo se lee con el lector de las máquinas (`scripts/lib/team-repos.js`). Nunca
 * tira: sin árbol, sin archivo o con el archivo roto devuelve `stack: {}` y el motivo en `problems`. Nunca imprime la
 * configuración. Lo cargan hooks que corren en cada edición: el resultado queda en memoria por proceso.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseExtensions } = require('./code-files.js');

const _cache = new Map();

function readStack({ env = process.env, home = os.homedir() } = {}) {
  const problems = [];
  let file = null;
  try {
    const tree = require('./harness-path.js').rutaArnesHook({ env, home }).dir;
    file = tree ? path.join(tree, 'team-repos.json') : null;
  } catch (e) {
    return { stack: {}, file: null, problems: [`no pude ubicar el árbol del arnés (${e && e.message ? e.message : e})`] };
  }
  if (!file) return { stack: {}, file: null, problems };
  let stat = null;
  try { stat = fs.statSync(file); } catch (_) { return { stack: {}, file, problems }; }
  const clave = `${file}|${stat.mtimeMs}|${stat.size}`;
  if (_cache.has(clave)) return _cache.get(clave);
  let out;
  try {
    const reader = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'team-repos.js');
    if (!fs.existsSync(reader)) {
      out = { stack: {}, file, problems: ['no encontré el lector team-repos.js del arnés'] };
    } else {
      const r = require(reader).parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
      if (!r.ok) {
        out = { stack: {}, file, problems: [`${file}: no se pudo usar (${r.problems.map((p) => `${p.path || '(archivo)'}: ${p.message}`).join('; ').slice(0, 200)})`] };
      } else {
        const stack = r.data && r.data.stack && typeof r.data.stack === 'object' && !Array.isArray(r.data.stack) ? r.data.stack : {};
        const sec = (r.sectionProblems && r.sectionProblems.stack) || [];
        out = { stack, file, problems: sec.map((p) => `${p.path}: ${p.message}; no se usa`) };
      }
    }
  } catch (e) {
    out = { stack: {}, file, problems: [`no pude leer la configuración de la organización (${e && e.message ? e.message : e})`] };
  }
  _cache.set(clave, out);
  return out;
}

/** Las extensiones que sumó la organización: `{ extra, problems }` (problemas como texto `ruta: motivo`). */
function codeExtensions(opts = {}) {
  const r = readStack(opts);
  const p = parseExtensions(r.stack.code_extensions);
  return { extra: p.extra, problems: [...r.problems, ...p.problems.map((x) => `${x.path}: ${x.message}`)] };
}

/** Atajo para quien sólo necesita la lista: nunca tira, y sin configuración devuelve []. */
function orgExtra(opts) {
  try { return codeExtensions(opts).extra; } catch (_) { return []; }
}

// Lo de fábrica no tiene la forma de ningún equipo: cualquier nombre de prueba, toda pantalla (.tsx, .jsx, .svelte,
// .vue) pide su E2E, y el idioma de la app no se juzga.
const RULE_DEFAULTS = Object.freeze({ test_names: 'any', screen_test: 'ui', ui_language: null });

/**
 * Las reglas de la organización: `{ rules: { <regla>: { value, source } }, problems }`, `source` = `organizacion` o
 * `por_defecto`. Una regla mal escrita ya la descartó el lector (sale en `problems`) y vale lo de fábrica. Nunca tira.
 */
function orgRules(opts = {}) {
  let r;
  try { r = readStack(opts); } catch (e) { r = { stack: {}, problems: [`no pude leer las reglas (${e && e.message ? e.message : e})`] }; }
  const declared = r.stack && r.stack.rules && typeof r.stack.rules === 'object' ? r.stack.rules : {};
  const rules = {};
  for (const [k, def] of Object.entries(RULE_DEFAULTS)) {
    rules[k] = Object.prototype.hasOwnProperty.call(declared, k)
      ? { value: declared[k], source: 'organizacion' }
      : { value: def, source: 'por_defecto' };
  }
  return { rules, problems: r.problems || [] };
}

module.exports = { readStack, codeExtensions, orgExtra, orgRules, RULE_DEFAULTS };
