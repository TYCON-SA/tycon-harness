'use strict';
// work-items-config.js — dónde van los pedidos de trabajo de un repo de historias y con qué forma: `.tycon/work-items.yaml`
// y, si no está, `.tycon/ado-config.yaml` (el nombre viejo, con sus claves `ado_*`). Con los dos, gana el nuevo entero:
// mezclarlos dejaría un pedido con la mitad de la configuración de cada uno.
//
// Las claves (en el archivo viejo, con `ado_` adelante; `type` era `ado_wi_type`):
//   org, project (o `repo: dueño/nombre` en GitHub), type, area_path, iteration_path, iteration_root,
//   iteration_auto_from_frontmatter, state_active, state_closed, auto_assign, default_tags, epic_links,
//   fields (`estimate`: el campo de Azure DevOps de la estimación) y github (`project: { owner, number, field }`: el
//   campo numérico del proyecto de GitHub que recibe la estimación)
//
// Lee el YAML que escriben estos archivos: `clave: valor` con comentarios, textos con o sin comillas, `true`/`false`,
// números, `{}` y un bloque de un nivel (`epic_links:` con sus `clave: valor` sangrados; un valor del bloque puede ser
// un `{}` en una línea). Lo que no entiende lo dice con el número de línea; nunca lo saltea.
//
// Casos: scripts/tests/platform-work-item.test.js y scripts/tests/platform-estimate.test.js.

const fs = require('fs');
const path = require('path');

const FILES = Object.freeze(['work-items.yaml', 'ado-config.yaml']);
// las claves que se conocen (con su nombre de hoy); las demás vuelven en `unknown` para que el conector las diga
const KEYS = Object.freeze(['org', 'project', 'repo', 'type', 'area_path', 'iteration_path', 'iteration_root',
  'iteration_auto_from_frontmatter', 'state_active', 'state_closed', 'auto_assign', 'default_tags', 'epic_links', 'fields', 'github']);
// el nombre de referencia de un campo de Azure DevOps (`Custom.Estimacion`, o el que Azure arma con un GUID): nunca algo
// que az lea como opción
const NOMBRE_DE_REFERENCIA = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_-]+)*$/;

/** Un valor escalar: sin el comentario, sin comillas, booleanos y números como tales. */
function escalar(texto, linea) {
  let t = texto.trim();
  if (t.startsWith('"') || t.startsWith("'")) {
    // como YAML: entre comillas dobles valen los escapes (\\, \", \n, \t); entre simples, '' es una comilla
    const doble = t[0] === '"';
    let fin = 1;
    let valor = '';
    for (; fin < t.length; fin++) {
      const ch = t[fin];
      if (doble && ch === '\\' && fin + 1 < t.length) { const e = t[++fin]; valor += ({ n: '\n', t: '\t' })[e] || e; continue; }
      if (!doble && ch === "'" && t[fin + 1] === "'") { valor += "'"; fin++; continue; }
      if (ch === t[0]) break;
      valor += ch;
    }
    if (fin >= t.length) throw new Error(`línea ${linea}: comillas sin cerrar`);
    const resto = t.slice(fin + 1).trim();
    if (resto && !resto.startsWith('#')) throw new Error(`línea ${linea}: algo después de las comillas`);
    return valor;
  }
  t = t.replace(/\s+#.*$/, '').trim();
  // los booleanos como los lee YAML: `True`, `yes` o `no` también (una asignación apagada en silencio por una mayúscula
  // no se nota hasta que falta)
  if (/^(true|yes)$/i.test(t)) return true;
  if (/^(false|no)$/i.test(t)) return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

/** Un `{a: 1, "b": 2}` en una línea. */
function mapaEnLinea(texto, linea) {
  const t = texto.replace(/\s+#.*$/, '').trim();
  const dentro = t.slice(1, -1).trim();
  const out = {};
  if (!dentro) return out;
  for (const par of dentro.split(',')) {
    const i = par.indexOf(':');
    if (i < 0) throw new Error(`línea ${linea}: «${par.trim()}» no es clave: valor`);
    out[String(escalar(par.slice(0, i), linea))] = escalar(par.slice(i + 1), linea);
  }
  return out;
}

/** El YAML de estos archivos, a un objeto. Lanza con el número de línea si algo no se entiende. */
function parse(texto) {
  const out = {};
  let bloque = null;
  String(texto).replace(/^﻿/, '').split(/\r?\n/).forEach((cruda, i) => {
    const n = i + 1;
    if (!cruda.trim() || /^\s*#/.test(cruda)) return;
    const sangrada = /^\s/.test(cruda);
    const m = cruda.trim().match(/^("[^"]*"|'[^']*'|[A-Za-z0-9_.-]+)\s*:(.*)$/);
    if (!m) throw new Error(`línea ${n}: «${cruda.trim()}» no es clave: valor`);
    const clave = String(escalar(m[1], n));
    const valor = m[2];
    if (sangrada) {
      if (!bloque) throw new Error(`línea ${n}: sangría sin un bloque arriba`);
      if (out[bloque] === null) out[bloque] = {};
      out[bloque][clave] = /^\s*\{/.test(valor) ? mapaEnLinea(valor, n) : escalar(valor, n);
      return;
    }
    bloque = null;
    // una clave sin valor abre un bloque si lo siguen líneas sangradas; si no, es un valor vacío (una plantilla a medio
    // llenar), nunca un objeto que llegaría a la plataforma como texto
    if (!valor.replace(/\s+#.*$/, '').trim()) { out[clave] = null; bloque = clave; return; }
    out[clave] = /^\s*\{/.test(valor) ? mapaEnLinea(valor, n) : escalar(valor, n);
  });
  for (const k of Object.keys(out)) if (out[k] === null) out[k] = '';
  return out;
}

/** Las claves del archivo viejo, con su nombre de hoy. */
function desdeViejo(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === 'ado_wi_type') out.type = v;
    else if (k.startsWith('ado_')) out[k.slice(4)] = v;
    else out[k] = v;
  }
  return out;
}

/**
 * Dónde va la estimación, si el repo lo declara: `fields.estimate` (Azure DevOps, un nombre de referencia) y
 * `github.project` (`{ owner, number, field }`). El problema con la ruta de la clave, o null.
 */
function destinosDeLaEstimacion(config) {
  const esMapa = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  if (config.fields !== undefined && config.fields !== '') {
    if (!esMapa(config.fields)) return 'fields tiene que ser un bloque de clave: valor (fields: { estimate: Custom.Nombre })';
    const e = config.fields.estimate;
    if (e !== undefined && !(typeof e === 'string' && NOMBRE_DE_REFERENCIA.test(e))) return `fields.estimate tiene que ser el nombre de referencia de un campo (Custom.Nombre), es ${JSON.stringify(e)}`;
  }
  if (config.github !== undefined && config.github !== '') {
    if (!esMapa(config.github)) return 'github tiene que ser un bloque de clave: valor (github: con project: { owner, number, field })';
    const p = config.github.project;
    if (p !== undefined) {
      if (!esMapa(p)) return 'github.project tiene que ser { owner: <dueño>, number: <número>, field: <campo> }, en una línea';
      if (!(typeof p.owner === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(p.owner))) return `github.project.owner tiene que ser el dueño del proyecto (una organización o un usuario), es ${JSON.stringify(p.owner)}`;
      if (!(Number.isInteger(p.number) && p.number > 0)) return `github.project.number tiene que ser el número del proyecto, es ${JSON.stringify(p.number)}`;
      if (!(typeof p.field === 'string' && p.field.trim())) return `github.project.field tiene que ser el nombre del campo numérico del proyecto, es ${JSON.stringify(p.field)}`;
    }
  }
  return null;
}

/**
 * La configuración del pedido de trabajo de un repo: `{config, file, legacy}`; `{config: null}` si el repo no tiene
 * ninguno de los dos archivos; `{problem}` si el que manda no se puede leer o no se entiende.
 */
function read(repoDir) {
  for (const nombre of FILES) {
    const file = path.join(repoDir, '.tycon', nombre);
    let texto;
    try { texto = fs.readFileSync(file, 'utf8'); } catch (e) {
      if (e && e.code === 'ENOENT') continue;
      return { problem: `.tycon/${nombre} no se puede leer (${(e && e.code) || 'error'})`, file };
    }
    let o;
    try { o = parse(texto); } catch (e) { return { problem: `.tycon/${nombre}: ${e.message}`, file }; }
    const legacy = nombre === 'ado-config.yaml';
    const config = legacy ? desdeViejo(o) : o;
    const mal = destinosDeLaEstimacion(config);
    if (mal) return { problem: `.tycon/${nombre}: ${mal}`, file };
    const unknown = Object.keys(config).filter((k) => !KEYS.includes(k));
    // las dos claves de sí o no: entre comillas o como 1/0 también valen; otra cosa se dice (apagarlas callado no)
    for (const k of ['auto_assign', 'iteration_auto_from_frontmatter']) {
      if (config[k] === undefined || typeof config[k] === 'boolean') continue;
      const t = String(config[k]).trim().toLowerCase();
      if (['true', 'yes', '1'].includes(t)) config[k] = true;
      else if (['false', 'no', '0', ''].includes(t)) config[k] = false;
      else unknown.push(`${k} (vale «${config[k]}»: tiene que ser true o false)`);
    }
    return unknown.length ? { config, file, legacy, unknown } : { config, file, legacy };
  }
  return { config: null };
}

module.exports = { read, parse, FILES, KEYS };
