'use strict';
/**
 * simulated-server.js — ¿este archivo de prueba simula el servidor de negocio?
 *
 * Una prueba de navegador que contesta el servidor con datos fabricados prueba la pantalla, no el servidor: no puede
 * contar como prueba en vivo. La matriz de verificación (`runtime-matrix.js`) usa esta detección sobre los specs que
 * corrió el portón E2E y sobre los guiones que corrió un humo.
 *
 * Las vías son las de las reglas REAL-C2 y REAL-C7 del control de realismo (`agents/tycon-e2e-realness-checker.md`):
 *   - `.route(` sobre un endpoint de negocio, con cualquier receptor (`page`, `context`, `page.context()`, un alias),
 *     cuyo manejador contesta (`fulfill`), corta (`abort`) o reescribe (`continue({ … })`). Sólo se salva un espía: un
 *     manejador que deja seguir la llamada sin cambios (`continue()`). Uno que delega en otra función o que no está
 *     escrito ahí cuenta: no se puede ver qué hace.
 *   - `routeFromHAR`, siempre.
 *   - importar `msw`, `@mswjs/…`, `nock`, `fetch-mock` o `jest-fetch-mock` (también con `import()` o `export … from`).
 * El patrón de la ruta pasa por la lista de endpoints de negocio; uno que no es un texto literal (una variable, una
 * función) cuenta como de negocio. Lo escrito dentro de un comentario o de una cadena no cuenta.
 *
 * La lista es copia exacta de la «Lista canónica de endpoint de negocio» del agente; una prueba compara las dos
 * (`tests/test-runtime-matrix.js`, T7). Las exclusiones se evalúan antes que la inclusión.
 *
 * Queda fuera lo que no pasa por esas vías (`addInitScript`, un `fetch` reemplazado a mano): no es una vía de REAL-C2 ni
 * de REAL-C7. La lectura es de texto, no un analizador de JavaScript.
 */
const fs = require('fs');
const path = require('path');

const SEGMENTOS = ['auth', 'login', 'logout', 'token', 'refresh', 'session', 'me', 'health', 'healthz', 'ping', 'ready',
  'metrics', 'telemetry', 'analytics'];
const PREFIJOS = ['/assets/', '/static/', '/_next/'];
const EXTENSIONES = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.avif', '.woff', '.woff2', '.ttf', '.otf',
  '.eot', '.css', '.map'];
const INCLUSION = /(api|graphql|rpc)/;

const LIBRERIAS_RE = /^(msw(\/.*)?|@mswjs\/.+|nock|fetch-mock|jest-fetch-mock)$/;
const EXT_GUION = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'];

/** ¿El patrón de una ruta interceptada es un endpoint de negocio? Primero las exclusiones, después la inclusión. */
function esDeNegocio(patron) {
  const p = String(patron);
  const sinConsulta = p.split(/[?#]/)[0];
  const segmentos = sinConsulta.split(/[\\/]+/).map((s) => s.toLowerCase());
  if (segmentos.some((s) => SEGMENTOS.includes(s))) return false;
  if (PREFIJOS.some((pre) => sinConsulta.includes(pre))) return false;
  const limpio = sinConsulta.replace(/[*$)\]]+$/, '');
  if (EXTENSIONES.some((ext) => limpio.toLowerCase().endsWith(ext))) return false;
  return INCLUSION.test(p);
}

/**
 * El texto con los comentarios y el contenido de las cadenas tapados por espacios (los saltos de línea quedan, así los
 * números de línea no cambian). Las comillas de las cadenas quedan: marcan dónde empieza el literal.
 */
function tapar(texto) {
  const s = String(texto);
  let out = '';
  let i = 0;
  const blanco = (c) => (c === '\n' ? '\n' : ' ');
  while (i < s.length) {
    const c = s[i];
    const d = s[i + 1];
    if (c === '\\') { out += s.slice(i, i + 2); i += 2; continue; }
    if (c === '/' && d === '/') {
      while (i < s.length && s[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && d === '*') {
      out += '  '; i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) { out += blanco(s[i]); i++; }
      if (i < s.length) { out += '  '; i += 2; }
      continue;
    }
    // Un literal de regex (una `/` donde no puede haber una división): su contenido se tapa entero, para que una
    // comilla o un paréntesis de adentro no abran una cadena ni descuenten una llamada.
    if (c === '/' && empiezaRegex(out)) {
      out += c; i++;
      let enClase = false;
      while (i < s.length && s[i] !== '\n' && (enClase || s[i] !== '/')) {
        if (s[i] === '\\') { out += '  '; i += 2; continue; }
        if (s[i] === '[') enClase = true;
        else if (s[i] === ']') enClase = false;
        out += ' '; i++;
      }
      if (i < s.length && s[i] === '/') { out += '/'; i++; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      out += c; i++;
      while (i < s.length && s[i] !== c) {
        if (s[i] === '\\') { out += blanco(s[i]) + blanco(s[i + 1] || ''); i += 2; continue; }
        if (c !== '`' && s[i] === '\n') break;
        out += blanco(s[i]); i++;
      }
      if (i < s.length && s[i] === c) { out += c; i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** ¿Una `/` en este punto empieza un literal de regex? Sí después de un operador, una apertura o una palabra clave. */
function empiezaRegex(previo) {
  const t = previo.replace(/\s+$/, '');
  if (!t) return true;
  if (/[(,=:[!&|?{};+\-*%<>~^]$/.test(t)) return true;
  return /\b(return|typeof|case|do|else|in|of|new|delete|void|throw|await|yield)$/.test(t);
}

const lineaDe = (s, idx) => s.slice(0, idx).split('\n').length;

/** El índice del paréntesis que cierra el que abre en `abre` (en el texto tapado), o el final del texto. */
function cierre(tapado, abre) {
  let n = 0;
  for (let i = abre; i < tapado.length; i++) {
    if (tapado[i] === '(') n++;
    else if (tapado[i] === ')') { n--; if (n === 0) return i; }
  }
  return tapado.length;
}

/** El primer argumento de la llamada que abre en `abre`: { literal, valor } (valor null si no es un texto literal). */
function primerArgumento(original, tapado, abre) {
  let i = abre + 1;
  while (i < tapado.length && /\s/.test(tapado[i])) i++;
  const q = tapado[i];
  if (q === '"' || q === "'" || q === '`') {
    let j = i + 1;
    while (j < tapado.length && tapado[j] !== q) j++;
    const valor = original.slice(i + 1, j);
    if (q === '`' && valor.includes('${')) return { literal: false, valor: null };
    return { literal: true, valor };
  }
  if (q === '/') {
    let j = i + 1;
    while (j < original.length && original[j] !== '/' && original[j] !== '\n') { if (original[j] === '\\') j++; j++; }
    return { literal: true, valor: original.slice(i + 1, j) };
  }
  return { literal: false, valor: null };
}

/**
 * Las simulaciones del servidor de negocio en un texto: [{ linea, via }]. Las vías de arriba; lo que está en un
 * comentario o en una cadena no cuenta.
 */
function simulaServidor(texto) {
  const original = String(texto);
  const tapado = tapar(original);
  const hallazgos = [];
  // Cualquier receptor: `page`, `context`, `page.context()`, un alias, `page?.route`, `page['route']`.
  const rutaRe = /(?:\?\.|\.)\s*route\s*\(|\[\s*['"]route['"]\s*\]\s*\(/g;
  let m;
  while ((m = rutaRe.exec(tapado))) {
    const abre = m.index + m[0].length - 1;
    const fin = cierre(tapado, abre);
    const arg = primerArgumento(original, tapado, abre);
    if (arg.literal && !esDeNegocio(arg.valor)) continue;
    const cuerpo = tapado.slice(abre, fin + 1);
    let via;
    if (/\.\s*fulfill\s*\(/.test(cuerpo)) via = 'route + fulfill';
    else if (/\.\s*abort\s*\(/.test(cuerpo)) via = 'route + abort';
    else if (/\.\s*continue\s*\(\s*[^)\s]/.test(cuerpo)) via = 'route + continue con cambios';
    // Sólo un espía se salva: un manejador que deja seguir la llamada sin cambios. Uno que delega en otra función, o
    // que no está escrito ahí, no se puede ver: cuenta.
    else if (/\.\s*continue\s*\(\s*\)/.test(cuerpo)) via = null;
    else via = 'route con un manejador que no se ve';
    if (via) hallazgos.push({ linea: lineaDe(original, m.index), via: arg.literal ? via : `${via} (patrón no literal)` });
  }
  const harRe = /\.\s*routeFromHAR\s*\(/g;
  while ((m = harRe.exec(tapado))) hallazgos.push({ linea: lineaDe(original, m.index), via: 'routeFromHAR' });
  for (const imp of importaciones(original, tapado)) {
    if (LIBRERIAS_RE.test(imp.de)) hallazgos.push({ linea: imp.linea, via: `importa ${imp.de}` });
  }
  return hallazgos.sort((a, b) => a.linea - b.linea);
}

/**
 * Lo que el texto importa (`import … from 'x'`, `import 'x'`, `import('x')`, `export … from 'x'`, `require('x')`),
 * fuera de comentarios: [{ de, linea }].
 */
function importaciones(original, tapado) {
  const out = [];
  const re = /\b(?:import\s*(?:\(\s*|[^'"`;()]*?\bfrom\s*)?|export\s[^'"`;()]*?\bfrom\s*|require\s*\(\s*)(['"])/g;
  let m;
  while ((m = re.exec(tapado))) {
    const abre = m.index + m[0].length - 1;
    const cierra = tapado.indexOf(m[1], abre + 1);
    if (cierra < 0) continue;
    out.push({ de: original.slice(abre + 1, cierra), linea: lineaDe(original, m.index) });
  }
  return out;
}

/** El archivo al que lleva un import relativo, probando las extensiones de guion y `/index.*`; null si no hay. */
function resolverRelativo(desde, de) {
  const base = path.resolve(path.dirname(desde), de);
  const candidatos = [base, ...EXT_GUION.map((e) => base + e), ...EXT_GUION.map((e) => path.join(base, 'index' + e))];
  for (const c of candidatos) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* no está: sigue con el próximo */ }
  }
  return null;
}

/**
 * Aplica `simulaServidor` a un archivo y a los que importa por ruta relativa (un nivel, como el control de realismo
 * con sus ayudantes). → { leido: true, hallazgos: [{ archivo, linea, via }] } o { leido: false, motivo }.
 * Un ayudante importado que no se puede leer no frena: el spec se leyó.
 */
function deArchivo(ruta) {
  let texto;
  try { texto = fs.readFileSync(ruta, 'utf8'); } catch (e) { return { leido: false, motivo: e.code || e.message }; }
  const hallazgos = simulaServidor(texto).map((h) => ({ archivo: ruta, ...h }));
  const vistos = new Set([path.resolve(ruta)]);
  for (const imp of importaciones(texto, tapar(texto))) {
    if (!/^\.\.?\//.test(imp.de)) continue;
    const destino = resolverRelativo(ruta, imp.de);
    if (!destino || vistos.has(destino)) continue;
    vistos.add(destino);
    let t2;
    try { t2 = fs.readFileSync(destino, 'utf8'); } catch { continue; }
    for (const h of simulaServidor(t2)) hallazgos.push({ archivo: destino, ...h });
  }
  return { leido: true, hallazgos };
}

module.exports = { SEGMENTOS, PREFIJOS, EXTENSIONES, INCLUSION, EXT_GUION, esDeNegocio, simulaServidor, deArchivo, tapar };
