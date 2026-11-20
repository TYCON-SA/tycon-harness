'use strict';
/**
 * ¿Dos versiones de un `.js` difieren sólo en el lugar de sus comentarios? (historia 8.217)
 *
 * Lo usan los dos frenos de lo revisado: un archivo editado después de la última vuelta de revisores que quedó igual a lo
 * revisado, salvo el lugar de sus comentarios, no pide otra vuelta. Ningún token de código cambia y ningún texto de
 * comentario cambia: lo que se saltea es volver a revisar un código idéntico, no revisar uno nuevo.
 *
 * Un lector propio, lineal, que ante la duda no decide: una `/` que no sabe leer, algo sin cerrar, llaves desparejas, un
 * `<` donde empezaría JSX o lo que Node lee como comentario de HTML dan `{ ok: false, motivo }`. Sólo `.js`, `.cjs` y
 * `.mjs`: TypeScript y JSX tienen otras reglas de lectura. Nunca lanza por el contenido.
 *
 * Un comentario que puede ser una directiva (`eslint-disable-next-line`, `c8 ignore next 3`, `@ts-…`) se aplica según
 * su lugar: si se movió, si cambió la cantidad de saltos a su alrededor o si trae un número, pide revisión.
 */
const path = require('path');

const EXTENSIONES = ['.js', '.cjs', '.mjs'];
const TOPE_BYTES = 2 * 1024 * 1024;

// Lo que un comentario nombra para ser una directiva de alguna herramienta (sin distinguir mayúsculas)
const DIRECTIVAS = [
  /eslint/i, /tslint/i, /jshint/i, /jslint/i, /prettier/i, /biome/i, /istanbul/i, /\bc8\b/i, /\bv8\b/i, /node:/i, /nosec/i,
  /nosemgrep/i, /noqa/i, /nosonar/i, /nolint/i, /pragma/i, /<reference/i, /deno-lint/i, /deno-fmt/i, /gitleaks/i, /codeql/i,
  /lgtm/i, /sourceMappingURL/i, /sourceURL/i, /webpack/i, /__PURE__/i, /__NOINLINE__/i, /harness-deprecated/i,
  /^(global|globals|exported)\b/i,
];

const FIN_DE_LINEA = /[\n\r\u2028\u2029]/;
const SALTOS = /\r\n|[\n\r\u2028\u2029]/g;
const contarSaltos = (s) => (String(s).match(SALTOS) || []).length;
const esEspacio = (c) => /\s/.test(c) && !FIN_DE_LINEA.test(c);
const esDePalabra = (c) => /[A-Za-z0-9$_\\]/.test(c) || (c.charCodeAt(0) > 127 && !/\s/.test(c));

// Antes de una `/`, la leen como expresión regular (no precedidas por `.`)
const ANTES_DE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'void', 'delete', 'throw', 'new', 'case', 'do', 'else']);
// Antes de una `/`, la leen como división
const ANTES_DE_DIVISION = new Set(['this', 'super', 'null', 'true', 'false']);
const RESERVADAS = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
  'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return',
  'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static',
  'implements', 'interface', 'package', 'private', 'protected', 'public', 'await', 'of']);
const CONTROL = new Set(['if', 'while', 'for', 'with']);

/** El texto de un comentario sin sus delimitadores ni los `*` y espacios del principio. */
function cuerpo(texto) {
  let t = String(texto);
  if (t.startsWith('//')) t = t.slice(2);
  else if (t.startsWith('/*')) t = t.slice(2, t.endsWith('*/') ? -2 : undefined);
  return t.replace(/^[\s*]+/, '');
}

/** ¿Puede ser una directiva? Ante la duda, sí. */
function puedeSerDirectiva(texto) {
  const c = cuerpo(texto);
  return c.includes('@') || /^[#!$:]/.test(c) || DIRECTIVAS.some((re) => re.test(c));
}

/**
 * Los tokens, las separaciones y los comentarios de un texto, o `{ duda }`.
 * `separaciones[i]` es lo que hay antes del token `i` (más una al final): `''`, `' '` o `'\n'`. Un comentario cuenta
 * como separación, y es `'\n'` si tiene un fin de línea adentro. `ancla` es el índice del token que sigue.
 */
function leer(texto) {
  const s = String(texto);
  const tokens = [];
  const tipos = [];
  const separaciones = [];
  const comentarios = [];
  const pila = []; // 'llave' o 'plantilla'
  const parentesis = []; // por cada `(`, si abre la condición de un if/while/for/with
  let i = 0;
  // los fines de línea leídos fuera de los tokens, y cuántos había al emitir el último: los saltos alrededor de un
  // comentario salen de restar, sin volver a recorrer el texto (muchos comentarios seguidos no lo hacen cuadrático)
  let saltos = 0;
  let saltosAlUltimo = 0;
  let separacion = '';
  const pendientes = []; // comentarios esperando el token que sigue

  const juntar = (clase) => { if (clase === '\n' || (clase === ' ' && separacion === '')) separacion = clase; };
  const emitir = (texto, tipo, desde, extra = {}) => {
    for (const c of pendientes.splice(0)) c.saltosDespues = saltos - c.saltosAlFin;
    tokens.push(texto);
    tipos.push({ tipo, ...extra });
    separaciones.push(separacion);
    separacion = '';
    saltosAlUltimo = saltos;
  };
  const anterior = (k = 1) => (tokens.length >= k ? { t: tokens[tokens.length - k], ...tipos[tipos.length - k], sep: separaciones[tokens.length - k] } : null);

  /** Cómo se lee una `/` (o un `<`) en este lugar: 'regex', 'division' o una duda. */
  function lecturaDeBarra() {
    const a = anterior();
    if (!a) return 'regex';
    // después de `${` (o del `}…${` de un tramo del medio) y de la línea `#!` empieza una expresión
    if (a.tipo === 'plantilla-abre' || a.tipo === 'shebang') return 'regex';
    if (a.tipo === 'signo') {
      if (a.t === ')') return a.cierraControl ? 'regex' : 'division';
      if (a.t === ']') return 'division';
      if (a.t === '}') return { duda: 'una `/` después de `}`' };
      if (a.t === '.') return { duda: 'una `/` después de `.`' };
      if ((a.t === '+' || a.t === '-') && tokens.length >= 2) {
        const b = anterior(2);
        if (b.tipo === 'signo' && b.t === a.t && a.sep === '') return { duda: `una \`/\` después de \`${a.t}${a.t}\`` };
      }
      return 'regex';
    }
    if (a.tipo === 'palabra') {
      const tras = tokens.length >= 2 ? anterior(2) : null;
      const propiedad = tras && tras.tipo === 'signo' && tras.t === '.';
      if (propiedad) return 'division';
      if (ANTES_DE_REGEX.has(a.t)) return 'regex';
      if (ANTES_DE_DIVISION.has(a.t)) return 'division';
      if (RESERVADAS.has(a.t)) return { duda: `una \`/\` después de \`${a.t}\`` };
      return 'division';
    }
    // número, cadena, plantilla, expresión regular
    return 'division';
  }

  /** Un tramo de plantilla desde `desde` (que apunta a `` ` `` o a `}`): hasta `` ` `` o `${`. */
  function tramoDePlantilla(desde) {
    let j = desde + 1;
    while (j < s.length) {
      const c = s[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '`') { emitir(s.slice(desde, j + 1), 'plantilla', desde); return j + 1; }
      if (c === '$' && s[j + 1] === '{') { emitir(s.slice(desde, j + 2), 'plantilla-abre', desde); pila.push('plantilla'); return j + 2; }
      j++;
    }
    return -1;
  }

  if (s.startsWith('#!')) {
    let j = 0;
    while (j < s.length && !FIN_DE_LINEA.test(s[j])) j++;
    emitir(s.slice(0, j), 'shebang', 0);
    i = j;
  }
  while (i < s.length) {
    const c = s[i];
    if (FIN_DE_LINEA.test(c)) { if (!(c === '\r' && s[i + 1] === '\n')) saltos++; juntar('\n'); i++; continue; }
    if (esEspacio(c)) { juntar(' '); i++; continue; }
    if (s.startsWith('<!--', i) || s.startsWith('-->', i)) return { duda: '`<!--` o `-->` fuera de una cadena' };
    if (c === '/' && (s[i + 1] === '/' || s[i + 1] === '*')) {
      let j;
      if (s[i + 1] === '/') { j = i + 2; while (j < s.length && !FIN_DE_LINEA.test(s[j])) j++; }
      else { const k = s.indexOf('*/', i + 2); if (k < 0) return { duda: 'un comentario sin cerrar' }; j = k + 2; }
      const texto = s.slice(i, j);
      const com = { texto, ancla: tokens.length, saltosAntes: saltos - saltosAlUltimo, saltosDespues: 0, desde: i, fin: j };
      saltos += contarSaltos(texto);
      com.saltosAlFin = saltos;
      comentarios.push(com);
      pendientes.push(com);
      juntar(FIN_DE_LINEA.test(texto) ? '\n' : ' ');
      i = j;
      continue;
    }
    if (c === '\'' || c === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= s.length) return { duda: 'una cadena sin cerrar' };
        const d = s[j];
        if (d === '\\') { j += (s[j + 1] === '\r' && s[j + 2] === '\n') ? 3 : 2; continue; }
        if (d === '\n' || d === '\r') return { duda: 'una cadena con un fin de línea sin escapar' };
        if (d === c) break;
        j++;
      }
      emitir(s.slice(i, j + 1), 'cadena', i);
      i = j + 1;
      continue;
    }
    if (c === '`') {
      const j = tramoDePlantilla(i);
      if (j < 0) return { duda: 'una plantilla sin cerrar' };
      i = j;
      continue;
    }
    if (c === '{') { pila.push('llave'); emitir('{', 'signo', i); i++; continue; }
    if (c === '}') {
      const tope = pila.pop();
      if (!tope) return { duda: 'un `}` sin su `{`' };
      if (tope === 'plantilla') {
        const j = tramoDePlantilla(i);
        if (j < 0) return { duda: 'una plantilla sin cerrar' };
        i = j;
        continue;
      }
      emitir('}', 'signo', i);
      i++;
      continue;
    }
    if (c === '(') {
      const a = anterior();
      const b = tokens.length >= 2 ? anterior(2) : null;
      const control = !!a && a.tipo === 'palabra' && !(b && b.tipo === 'signo' && b.t === '.')
        && (CONTROL.has(a.t) || (a.t === 'await' && b && b.tipo === 'palabra' && b.t === 'for'));
      parentesis.push(control);
      emitir('(', 'signo', i);
      i++;
      continue;
    }
    if (c === ')') {
      if (!parentesis.length) return { duda: 'un `)` sin su `(`' };
      emitir(')', 'signo', i, { cierraControl: parentesis.pop() });
      i++;
      continue;
    }
    if (c === '/') {
      const l = lecturaDeBarra();
      if (l && l.duda) return { duda: l.duda };
      if (l === 'division') { emitir('/', 'signo', i); i++; continue; }
      let j = i + 1;
      let clase = false;
      for (;;) {
        if (j >= s.length || FIN_DE_LINEA.test(s[j])) return { duda: 'una expresión regular sin cerrar' };
        const d = s[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '[') clase = true;
        else if (d === ']') clase = false;
        else if (d === '/' && !clase) break;
        j++;
      }
      j++;
      while (j < s.length && /[A-Za-z0-9$_]/.test(s[j])) j++;
      emitir(s.slice(i, j), 'regex', i);
      i = j;
      continue;
    }
    if (c === '<' && lecturaDeBarra() === 'regex') return { duda: 'un `<` donde empezaría una expresión (JSX)' };
    if (esDePalabra(c)) {
      let j = i;
      while (j < s.length && esDePalabra(s[j])) j++;
      emitir(s.slice(i, j), /^[0-9]/.test(c) ? 'numero' : 'palabra', i);
      i = j;
      continue;
    }
    emitir(c, 'signo', i);
    i++;
  }
  if (pila.length) return { duda: pila[pila.length - 1] === 'plantilla' ? 'un `${` sin cerrar' : 'un `{` sin cerrar' };
  if (parentesis.length) return { duda: 'un `(` sin cerrar' };
  for (const com of pendientes.splice(0)) com.saltosDespues = saltos - com.saltosAlFin;
  separaciones.push(separacion);
  return { tokens, separaciones, comentarios: comentarios.map(({ fin, saltosAlFin, ...resto }) => resto) };
}

const iguales = (a, b) => a.length === b.length && a.every((x, k) => x === b[k]);
const clave = (c) => `${c.ancla}\u0000${c.texto}`;

/** El multiconjunto de claves como Map clave → cantidad. */
function contar(lista, f) {
  const m = new Map();
  for (const x of lista) { const k = f(x); m.set(k, (m.get(k) || 0) + 1); }
  return m;
}

/**
 * `{ ok: true, movidos }` si `ahora` es `antes` con sus comentarios en otro lugar; `{ ok: false, motivo }` si no, o si no
 * se puede decir. `antes` y `ahora` son `Buffer`; `archivo`, la ruta (decide por su extensión).
 */
function soloSeMovieronComentarios(antes, ahora, { archivo } = {}) {
  try {
    if (!EXTENSIONES.includes(path.extname(String(archivo || '')))) return { ok: false, motivo: 'sólo se leen .js, .cjs y .mjs' };
    if (!Buffer.isBuffer(antes) || !Buffer.isBuffer(ahora)) return { ok: false, motivo: 'sin el contenido de los dos lados' };
    if (antes.equals(ahora)) return { ok: true, movidos: 0 };
    if (antes.length > TOPE_BYTES || ahora.length > TOPE_BYTES) return { ok: false, motivo: 'más de 2 MiB' };
    const textos = [];
    for (const buf of [antes, ahora]) {
      const t = buf.toString('utf8');
      if (!Buffer.from(t, 'utf8').equals(buf)) return { ok: false, motivo: 'bytes que no son UTF-8 válido' };
      textos.push(t);
    }
    const a = leer(textos[0]);
    if (a.duda) return { ok: false, motivo: `lo revisado: ${a.duda}` };
    const b = leer(textos[1]);
    if (b.duda) return { ok: false, motivo: `lo de ahora: ${b.duda}` };
    if (!iguales(a.tokens, b.tokens)) return { ok: false, motivo: 'cambió el código' };
    if (!iguales(a.separaciones, b.separaciones)) return { ok: false, motivo: 'cambió la separación entre dos tokens' };
    const ta = contar(a.comentarios, (c) => c.texto);
    const tb = contar(b.comentarios, (c) => c.texto);
    if (ta.size !== tb.size || [...ta].some(([k, n]) => tb.get(k) !== n)) return { ok: false, motivo: 'cambió el texto de un comentario' };
    const enAntes = contar(a.comentarios, clave);
    const enAhora = contar(b.comentarios, clave);
    let movidos = 0;
    for (const c of b.comentarios) {
      const k = clave(c);
      const quedan = enAntes.get(k) || 0;
      if (quedan > 0) { enAntes.set(k, quedan - 1); continue; }
      if (puedeSerDirectiva(c.texto)) return { ok: false, motivo: `se movió un comentario que puede ser una directiva: ${c.texto.slice(0, 60)}` };
      movidos++;
    }
    const directivas = [...a.comentarios, ...b.comentarios].filter((c) => puedeSerDirectiva(c.texto));
    // un número suelto (el 3 de `c8 ignore next 3` cuenta renglones); el 8 de `c8` es parte del nombre
    if (directivas.some((c) => /(?:^|[^\w])\d/.test(c.texto))) return { ok: false, motivo: 'un comentario que puede ser una directiva trae un número' };
    // las directivas que no se movieron conservan los saltos a su alrededor (en orden, por su lugar y su texto)
    const porClave = (lista) => {
      const m = new Map();
      for (const c of lista.filter((x) => puedeSerDirectiva(x.texto))) { const k = clave(c); if (!m.has(k)) m.set(k, []); m.get(k).push(c); }
      return m;
    };
    const da = porClave(a.comentarios);
    const db = porClave(b.comentarios);
    for (const [k, lb] of db) {
      const la = da.get(k) || [];
      for (let n = 0; n < Math.min(la.length, lb.length); n++) {
        if (la[n].saltosAntes !== lb[n].saltosAntes || la[n].saltosDespues !== lb[n].saltosDespues) {
          return { ok: false, motivo: `cambiaron los saltos alrededor de un comentario que puede ser una directiva: ${lb[n].texto.slice(0, 60)}` };
        }
      }
    }
    void enAhora;
    return { ok: true, movidos };
  } catch (e) {
    return { ok: false, motivo: `no pude leerlo: ${String((e && e.message) || e).split('\n')[0]}` };
  }
}

module.exports = { soloSeMovieronComentarios, leer, puedeSerDirectiva, DIRECTIVAS, EXTENSIONES, TOPE_BYTES };
