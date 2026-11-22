'use strict';
/**
 * change-kind.js — qué cambió adentro de un archivo de código entre dos versiones.
 *
 * Los frenos de lo revisado y el re-loop de revisores deciden por el nombre del archivo: un texto cambiado en un `.tsx`
 * cuenta igual que un cambio de lógica. Esto lee las dos versiones y dice qué cambió, `{ tipo, motivo, visibles }`:
 *   · `igual`: los mismos tokens, comentarios y textos; sólo cambiaron espacios, la sangría o los fines de línea.
 *   · `comentarios`: cambió el texto o el lugar de algún comentario, y nada más.
 *   · `textos`: cambió el contenido de alguna cadena, de un tramo de plantilla, del valor de un atributo de JSX o del texto
 *     entre etiquetas de JSX (y quizá comentarios); todos los demás tokens quedaron iguales. `visibles` es true si todo
 *     lo que cambió es texto entre etiquetas, lo que se ve en la pantalla: una cadena puede ser una consulta, una ruta o
 *     una clave.
 *   · `codigo`: cualquier otra cosa, y ante la duda.
 *
 * Lee `.js`, `.cjs`, `.mjs` y `.jsx` (con JSX), `.ts`, `.mts` y `.cts` (sin JSX), `.tsx` (con JSX) y `.cs`. Un lector
 * propio y lineal, con las reglas de lectura de lib/comment-only.js, que ante la duda dice `codigo`: algo sin cerrar, una
 * `/` o un `<` que no sabe leer, una etiqueta de JSX que cierra con otro nombre. Lo de dentro de `${…}`, de las llaves de
 * JSX y de los huecos de una cadena interpolada de C# es código; un carácter de C# (`','`) también, y una línea `#` de
 * C#, `#region` incluida. Un comentario que puede ser una directiva (`eslint-disable`, `@ts-ignore`, `ReSharper`,
 * `snyk:ignore`, el código de una regla, cualquier «ignore», «skip» o «suppress») y
 * cambió, apareció, se fue, se movió o cambió los saltos a su alrededor es código. El texto de JSX se compara como lo
 * muestra React: los espacios con un fin de línea al principio y al final de cada renglón no cuentan. Nunca lanza por
 * el contenido.
 */
const path = require('path');
const { puedeSerDirectiva, ANTES_DE_REGEX, ANTES_DE_DIVISION, RESERVADAS, CONTROL } = require('./comment-only.js');

const TOPE_BYTES = 2 * 1024 * 1024;
const IDIOMAS = Object.freeze({
  '.js': { jsx: true }, '.cjs': { jsx: true }, '.mjs': { jsx: true }, '.jsx': { jsx: true },
  '.ts': { jsx: false }, '.mts': { jsx: false }, '.cts': { jsx: false }, '.tsx': { jsx: true },
  '.cs': { cs: true },
});
const EXTENSIONES = Object.freeze(Object.keys(IDIOMAS));
const TIPOS = Object.freeze(['igual', 'comentarios', 'textos', 'codigo']);
// Lo que un comentario nombra para ser una directiva de alguna herramienta, además de las de lib/comment-only.js: los
// analizadores de C#, los escáneres de seguridad y cualquier palabra de silenciar o el código de una regla (CA2100,
// JS-0060). Ante la duda, directiva: lo peor es una vuelta de más
const DIRECTIVAS_MAS = [/resharper/i, /auto-?generated/i, /stylecop/i, /csharpier/i, /dotnet_diagnostic/i, /snyk/i, /checkov/i,
  /skipcq/i, /devskim/i, /semgrep/i, /bandit/i, /trivy/i, /\b(?:ignore|skip|suppress|disable|nolint|noinspection)/i,
  /\b[A-Z]{1,4}-?\d{3,}\b/];
const esDirectiva = (t) => puedeSerDirectiva(t) || DIRECTIVAS_MAS.some((re) => re.test(t));

const FIN_DE_LINEA = /[\n\r\u2028\u2029]/;
const SALTOS = /\r\n|[\n\r\u2028\u2029]/g;
const contarSaltos = (s) => (String(s).match(SALTOS) || []).length;
const esEspacio = (c) => /\s/.test(c) && !FIN_DE_LINEA.test(c);
const esDePalabra = (c) => /[A-Za-z0-9$_\\]/.test(c) || (c.charCodeAt(0) > 127 && !/\s/.test(c));
// Un `<` donde empezaría JSX que en un .tsx es un genérico de función flecha: `<T,>` o `<T extends …>`
const GENERICO = /<\s*[A-Za-z_$][\w$]*\s*(?:,|extends\b)/y;
const NOMBRE_JSX = /[A-Za-z_$][\w$.:-]*/y;

/** El texto entre etiquetas como lo muestra React (la regla de Babel para los hijos de texto de JSX). */
function textoVisible(t) {
  const lineas = String(t).split(/\r\n|\n|\r/);
  let ultimaConTexto = -1;
  lineas.forEach((l, n) => { if (/[^ \t]/.test(l)) ultimaConTexto = n; });
  let out = '';
  lineas.forEach((l, n) => {
    let x = l.replace(/\t/g, ' ');
    if (n !== 0) x = x.replace(/^[ ]+/, '');
    if (n !== lineas.length - 1) x = x.replace(/[ ]+$/, '');
    if (x) out += n === ultimaConTexto ? x : `${x} `;
  });
  return out;
}

/**
 * Los tokens, las separaciones y los comentarios de un texto, o `{ duda }`. Cada token es `{ v, tipo, familia? }`: los
 * de tipo `texto` (cadenas, tramos de plantilla, textos de JSX) llevan su `familia`, que dice qué parte de qué es.
 * `separaciones[i]` es lo que hay antes del token `i` (más una al final): `''`, `' '` o `'\n'`; en C# y dentro de una
 * etiqueta de JSX un fin de línea separa igual que un espacio.
 */
function leer(fuente, idioma) {
  const s = String(fuente);
  const tokens = [];
  const separaciones = [];
  const comentarios = [];
  const pila = []; // 'llave', 'plantilla', { jsx: base } o la cadena interpolada de C# cuyo hueco está abierto
  const parentesis = []; // por cada `(`, si abre la condición de un if/while/for/with
  const jsxPila = []; // los elementos de JSX abiertos: { fase: 'apertura' | 'atributos' | 'hijos', nombre }
  let i = 0;
  let saltos = 0;
  let saltosAlUltimo = 0;
  let separacion = '';
  let inicioDeLinea = true;
  let enEtiqueta = false;
  const pendientes = []; // comentarios esperando el token que sigue

  const juntar = (clase) => { if (clase === '\n' || (clase === ' ' && separacion === '')) separacion = clase; };
  const emitir = (v, tipo, extra = {}) => {
    for (const c of pendientes.splice(0)) c.saltosDespues = saltos - c.saltosAlFin;
    tokens.push({ v, tipo, ...extra });
    separaciones.push((idioma.cs || enEtiqueta) && separacion === '\n' ? ' ' : separacion);
    separacion = '';
    saltosAlUltimo = saltos;
    inicioDeLinea = false;
  };
  const texto = (v, familia) => emitir(v, 'texto', { familia });
  const anterior = (k = 1) => (tokens.length >= k ? tokens[tokens.length - k] : null);

  function espacio() {
    const c = s[i];
    if (FIN_DE_LINEA.test(c)) { if (!(c === '\r' && s[i + 1] === '\n')) saltos++; juntar('\n'); inicioDeLinea = true; i++; return true; }
    if (esEspacio(c)) { juntar(' '); i++; return true; }
    return false;
  }

  function comentario() {
    let j;
    if (s[i + 1] === '/') { j = i + 2; while (j < s.length && !FIN_DE_LINEA.test(s[j])) j++; }
    else { const k = s.indexOf('*/', i + 2); if (k < 0) return { duda: 'un comentario sin cerrar' }; j = k + 2; }
    const t = s.slice(i, j);
    const com = { texto: t, ancla: tokens.length, saltosAntes: saltos - saltosAlUltimo, saltosDespues: 0 };
    saltos += contarSaltos(t);
    com.saltosAlFin = saltos;
    comentarios.push(com);
    pendientes.push(com);
    juntar(FIN_DE_LINEA.test(t) ? '\n' : ' ');
    i = j;
    return null;
  }

  const esComentario = () => s[i] === '/' && (s[i + 1] === '/' || s[i + 1] === '*');

  function palabra() {
    let j = i;
    while (j < s.length && esDePalabra(s[j])) j++;
    emitir(s.slice(i, j), /^[0-9]/.test(s[i]) ? 'numero' : 'palabra');
    i = j;
  }

  // ── JavaScript y TypeScript ──

  /**
   * Cómo se lee una `/` (o un `<`, con `menor`) en este lugar: 'regex' (empieza una expresión), 'division' o una duda.
   * Un `<` pegado a otro es el desplazamiento `<<`, y después de `++` o `--` es una comparación: JSX no empieza ahí.
   */
  function lecturaDeBarra(menor = false) {
    const a = anterior();
    if (!a) return 'regex';
    if (a.finJsx) return 'division';
    if (a.tipo === 'shebang') return 'regex';
    if (a.tipo === 'texto') return a.familia === 'plantilla-abre' || a.familia === 'plantilla-medio' ? 'regex' : 'division';
    if (a.tipo === 'signo') {
      if (a.v === ')') return a.cierraControl ? 'regex' : 'division';
      if (a.v === ']') return 'division';
      if (a.v === '}') return { duda: 'una `/` o un `<` después de `}`' };
      if (a.v === '.') return { duda: 'una `/` o un `<` después de `.`' };
      if (menor && a.v === '<' && separacion === '') return 'division';
      if ((a.v === '+' || a.v === '-') && tokens.length >= 2) {
        const b = anterior(2);
        if (b.tipo === 'signo' && b.v === a.v && separaciones[tokens.length - 1] === '') {
          return menor ? 'division' : { duda: `una \`/\` después de \`${a.v}${a.v}\`` };
        }
      }
      return 'regex';
    }
    if (a.tipo === 'palabra') {
      const tras = anterior(2);
      if (tras && tras.tipo === 'signo' && tras.v === '.') return 'division';
      if (ANTES_DE_REGEX.has(a.v)) return 'regex';
      if (ANTES_DE_DIVISION.has(a.v)) return 'division';
      if (RESERVADAS.has(a.v)) return { duda: `una \`/\` o un \`<\` después de \`${a.v}\`` };
      return 'division';
    }
    return 'division';
  }

  function cadenaJs(q) {
    let j = i + 1;
    for (;;) {
      if (j >= s.length) return { duda: 'una cadena sin cerrar' };
      const d = s[j];
      if (d === '\\') { j += (s[j + 1] === '\r' && s[j + 2] === '\n') ? 3 : 2; continue; }
      if (d === '\n' || d === '\r') return { duda: 'una cadena con un fin de línea sin escapar' };
      if (d === q) break;
      j++;
    }
    texto(s.slice(i + 1, j), 'cadena');
    i = j + 1;
    return null;
  }

  /** Un tramo de plantilla desde `desde` (un `` ` `` si `inicio`, o el `}` de un hueco): hasta `` ` `` o `${`. */
  function tramo(desde, inicio) {
    let j = desde + 1;
    while (j < s.length) {
      const c = s[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '`') { texto(s.slice(desde + 1, j), inicio ? 'plantilla' : 'plantilla-cierra'); i = j + 1; return null; }
      if (c === '$' && s[j + 1] === '{') { texto(s.slice(desde + 1, j), inicio ? 'plantilla-abre' : 'plantilla-medio'); pila.push('plantilla'); i = j + 2; return null; }
      j++;
    }
    return { duda: 'una plantilla sin cerrar' };
  }

  function regex() {
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
    emitir(s.slice(i, j), 'regex');
    i = j;
    return null;
  }

  function huecoDeEtiqueta() {
    while (i < s.length) {
      if (espacio()) continue;
      if (esComentario()) { const r = comentario(); if (r) return r; continue; }
      break;
    }
    return null;
  }

  function nombreJsx() {
    NOMBRE_JSX.lastIndex = i;
    const m = NOMBRE_JSX.exec(s);
    if (!m) return null;
    i += m[0].length;
    return m[0];
  }

  /**
   * Sigue leyendo JSX desde `i` con el elemento de arriba de `jsxPila`. Vuelve null cuando hace falta leer código (abrió
   * unas llaves: su `}` lo retoma) o cuando cerró el elemento que empezó la expresión (`base` elementos abiertos debajo).
   */
  function seguirJsx(base) {
    for (;;) {
      const ctx = jsxPila[jsxPila.length - 1];
      if (ctx.fase !== 'hijos') {
        enEtiqueta = true;
        if (ctx.fase === 'apertura') {
          emitir('<', 'signo');
          i++;
          const h = huecoDeEtiqueta(); if (h) return h;
          if (s[i] === '>') { emitir('>', 'signo'); i++; ctx.nombre = ''; ctx.fase = 'hijos'; enEtiqueta = false; continue; }
          const n = nombreJsx();
          if (!n) return { duda: 'una etiqueta de JSX sin nombre' };
          if (s[i] === '<') return { duda: 'una etiqueta de JSX con tipos' };
          emitir(n, 'palabra');
          ctx.nombre = n;
          ctx.fase = 'atributos';
          continue;
        }
        const h = huecoDeEtiqueta(); if (h) return h;
        if (i >= s.length) return { duda: 'una etiqueta de JSX sin cerrar' };
        const c = s[i];
        if (c === '/' && s[i + 1] === '>') {
          const fin = jsxPila.length - 1 === base;
          emitir('/', 'signo');
          emitir('>', 'signo', fin ? { finJsx: true } : {});
          i += 2;
          jsxPila.pop();
          enEtiqueta = false;
          if (fin) return null;
          continue;
        }
        if (c === '>') { emitir('>', 'signo'); i++; ctx.fase = 'hijos'; enEtiqueta = false; continue; }
        if (c === '{') { emitir('{', 'signo'); i++; pila.push({ jsx: base }); enEtiqueta = false; return null; }
        const n = nombreJsx();
        if (!n) return { duda: `un \`${c}\` en una etiqueta de JSX` };
        emitir(n, 'palabra');
        const h2 = huecoDeEtiqueta(); if (h2) return h2;
        if (s[i] !== '=') continue;
        emitir('=', 'signo');
        i++;
        const h3 = huecoDeEtiqueta(); if (h3) return h3;
        const q = s[i];
        if (q === '"' || q === '\'') {
          const k = s.indexOf(q, i + 1);
          if (k < 0) return { duda: 'un valor de atributo de JSX sin cerrar' };
          texto(s.slice(i + 1, k), 'jsx-atributo');
          i = k + 1;
          continue;
        }
        if (q === '{') { emitir('{', 'signo'); i++; pila.push({ jsx: base }); enEtiqueta = false; return null; }
        return { duda: 'un valor de atributo de JSX que no sé leer' };
      }
      let k = i;
      while (k < s.length && s[k] !== '{' && s[k] !== '<') k++;
      if (k >= s.length) return { duda: 'un elemento de JSX sin cerrar' };
      texto(s.slice(i, k), 'jsx');
      i = k;
      if (s[i] === '{') { emitir('{', 'signo'); i++; pila.push({ jsx: base }); return null; }
      if (s[i + 1] !== '/') { jsxPila.push({ fase: 'apertura' }); continue; }
      enEtiqueta = true;
      emitir('<', 'signo');
      emitir('/', 'signo');
      i += 2;
      const h = huecoDeEtiqueta(); if (h) return h;
      const n = nombreJsx() || '';
      const h2 = huecoDeEtiqueta(); if (h2) return h2;
      if (s[i] !== '>') return { duda: 'una etiqueta de cierre de JSX que no sé leer' };
      if (n !== ctx.nombre) return { duda: `una etiqueta de JSX que abre con <${ctx.nombre}> y cierra con </${n}>` };
      if (n) emitir(n, 'palabra');
      const fin = jsxPila.length - 1 === base;
      emitir('>', 'signo', fin ? { finJsx: true } : {});
      i++;
      jsxPila.pop();
      enEtiqueta = false;
      if (fin) return null;
    }
  }

  function bucleJs() {
    if (s.startsWith('#!')) {
      let j = 0;
      while (j < s.length && !FIN_DE_LINEA.test(s[j])) j++;
      emitir(s.slice(0, j), 'shebang');
      i = j;
    }
    while (i < s.length) {
      const c = s[i];
      if (espacio()) continue;
      if (s.startsWith('<!--', i) || s.startsWith('-->', i)) return { duda: '`<!--` o `-->` fuera de una cadena' };
      if (esComentario()) { const r = comentario(); if (r) return r; continue; }
      if (c === '\'' || c === '"') { const r = cadenaJs(c); if (r) return r; continue; }
      if (c === '`') { const r = tramo(i, true); if (r) return r; continue; }
      if (c === '{') { pila.push('llave'); emitir('{', 'signo'); i++; continue; }
      if (c === '}') {
        const tope = pila.pop();
        if (!tope) return { duda: 'un `}` sin su `{`' };
        if (tope === 'plantilla') { const r = tramo(i, false); if (r) return r; continue; }
        emitir('}', 'signo');
        i++;
        if (typeof tope === 'object') { const r = seguirJsx(tope.jsx); if (r) return r; }
        continue;
      }
      if (c === '(') {
        const a = anterior();
        const b = anterior(2);
        const control = !!a && a.tipo === 'palabra' && !(b && b.tipo === 'signo' && b.v === '.')
          && (CONTROL.has(a.v) || (a.v === 'await' && b && b.tipo === 'palabra' && b.v === 'for'));
        parentesis.push(control);
        emitir('(', 'signo');
        i++;
        continue;
      }
      if (c === ')') {
        if (!parentesis.length) return { duda: 'un `)` sin su `(`' };
        emitir(')', 'signo', { cierraControl: parentesis.pop() });
        i++;
        continue;
      }
      if (c === '/') {
        const l = lecturaDeBarra();
        if (l && l.duda) return { duda: l.duda };
        if (l === 'division') { emitir('/', 'signo'); i++; continue; }
        const r = regex(); if (r) return r;
        continue;
      }
      if (c === '<' && idioma.jsx) {
        const l = lecturaDeBarra(true);
        if (l && l.duda) return { duda: l.duda };
        if (l === 'regex') {
          GENERICO.lastIndex = i;
          if (GENERICO.test(s)) { emitir('<', 'signo'); i++; continue; }
          jsxPila.push({ fase: 'apertura' });
          const r = seguirJsx(jsxPila.length - 1); if (r) return r;
          continue;
        }
      }
      if (esDePalabra(c)) { palabra(); continue; }
      emitir(c, 'signo');
      i++;
    }
    return null;
  }

  // ── C# ──

  /** El cuerpo de una cadena de C# desde `desde` (tras la comilla, o tras el `}` de un hueco): hasta la comilla o un `{`. */
  function restoCs(e, desde, inicio) {
    let j = desde;
    for (;;) {
      if (j >= s.length) return { duda: 'una cadena sin cerrar' };
      const d = s[j];
      if (e.literal) {
        if (d === '"') { if (s[j + 1] === '"') { j += 2; continue; } break; }
      } else {
        if (d === '\\') { j += 2; continue; }
        if (d === '"') break;
        if (d === '\n' || d === '\r') return { duda: 'una cadena con un fin de línea' };
      }
      if (e.interpolada && d === '{') {
        if (s[j + 1] === '{') { j += 2; continue; }
        texto(s.slice(desde, j), `cs${e.prefijo}-${inicio ? 'abre' : 'medio'}`);
        pila.push(e);
        i = j + 1;
        return null;
      }
      if (e.interpolada && d === '}') {
        if (s[j + 1] === '}') { j += 2; continue; }
        return { duda: 'una `}` suelta en una cadena interpolada' };
      }
      j++;
    }
    texto(s.slice(desde, j), `cs${e.prefijo}-${inicio ? 'entera' : 'cierra'}`);
    i = j + 1;
    return null;
  }

  function cadenaCs(prefijo, j) {
    const literal = prefijo.includes('@');
    const interpolada = prefijo.includes('$');
    let q = 0;
    while (s[j + q] === '"') q++;
    if (!literal && q >= 3) {
      if (interpolada) return { duda: 'una cadena cruda interpolada' };
      const cierre = '"'.repeat(q);
      const k = s.indexOf(cierre, j + q);
      if (k < 0) return { duda: 'una cadena cruda sin cerrar' };
      if (s[k + q] === '"') return { duda: 'una cadena cruda con más comillas al cerrar' };
      texto(s.slice(j + q, k), `cs-cruda-${q}`);
      i = k + q;
      return null;
    }
    return restoCs({ prefijo, literal, interpolada }, j + 1, true);
  }

  function bucleCs() {
    while (i < s.length) {
      const c = s[i];
      if (espacio()) continue;
      if (esComentario()) { const r = comentario(); if (r) return r; continue; }
      if (c === '#' && inicioDeLinea) {
        let j = i;
        while (j < s.length && !FIN_DE_LINEA.test(s[j])) j++;
        emitir(s.slice(i, j).replace(/\s+$/, ''), 'preproc');
        i = j;
        continue;
      }
      if (c === '"' || c === '$' || c === '@') {
        let j = i;
        while (s[j] === '$' || s[j] === '@') j++;
        if (s[j] === '"') { const r = cadenaCs(s.slice(i, j), j); if (r) return r; continue; }
        if (c === '@' && j === i + 1 && j < s.length && esDePalabra(s[j])) {
          let k = j;
          while (k < s.length && esDePalabra(s[k])) k++;
          emitir(s.slice(i, k), 'palabra');
          i = k;
          continue;
        }
      }
      if (c === '\'') {
        let j = i + 1;
        for (;;) {
          if (j >= s.length || FIN_DE_LINEA.test(s[j])) return { duda: 'un carácter sin cerrar' };
          if (s[j] === '\\') { j += 2; continue; }
          if (s[j] === '\'') break;
          j++;
        }
        emitir(s.slice(i, j + 1), 'caracter');
        i = j + 1;
        continue;
      }
      if (c === '{') { pila.push('llave'); emitir('{', 'signo'); i++; continue; }
      if (c === '}') {
        const tope = pila.pop();
        if (!tope) return { duda: 'un `}` sin su `{`' };
        if (typeof tope === 'object') { const r = restoCs(tope, i + 1, false); if (r) return r; continue; }
        emitir('}', 'signo');
        i++;
        continue;
      }
      if (c === '(') { parentesis.push(false); emitir('(', 'signo'); i++; continue; }
      if (c === ')') {
        if (!parentesis.length) return { duda: 'un `)` sin su `(`' };
        parentesis.pop();
        emitir(')', 'signo');
        i++;
        continue;
      }
      if (esDePalabra(c)) { palabra(); continue; }
      emitir(c, 'signo');
      i++;
    }
    return null;
  }

  const r = idioma.cs ? bucleCs() : bucleJs();
  if (r) return r;
  if (pila.length) {
    const tope = pila[pila.length - 1];
    return { duda: tope === 'plantilla' ? 'un `${` sin cerrar' : typeof tope === 'object' ? 'un hueco o unas llaves sin cerrar' : 'un `{` sin cerrar' };
  }
  if (parentesis.length) return { duda: 'un `(` sin cerrar' };
  if (jsxPila.length) return { duda: 'un elemento de JSX sin cerrar' };
  for (const com of pendientes.splice(0)) com.saltosDespues = saltos - com.saltosAlFin;
  separaciones.push(idioma.cs && separacion === '\n' ? ' ' : separacion);
  return { tokens, separaciones, comentarios: comentarios.map(({ saltosAlFin, ...resto }) => resto) };
}

const clave = (c) => `${c.ancla}\u0000${c.texto}`;

/** Los comentarios de `x` que no están en `y` (como multiconjunto, por su lugar y su texto). */
function restar(x, y) {
  const m = new Map();
  for (const c of y) m.set(clave(c), (m.get(clave(c)) || 0) + 1);
  const fuera = [];
  for (const c of x) {
    const n = m.get(clave(c)) || 0;
    if (n > 0) m.set(clave(c), n - 1);
    else fuera.push(c);
  }
  return fuera;
}

/** `{ codigo: motivo }` si cambió una directiva; si no, `{ cambiaron }`: si cambió algún comentario. */
function compararComentarios(ca, cb) {
  const soloAntes = restar(ca, cb);
  const soloAhora = restar(cb, ca);
  const dir = [...soloAntes, ...soloAhora].find((c) => esDirectiva(c.texto));
  if (dir) return { codigo: `cambió, apareció, se fue o se movió un comentario que puede ser una directiva: ${dir.texto.slice(0, 60)}` };
  // las directivas que quedaron en su lugar conservan los saltos a su alrededor (en orden, por su lugar y su texto)
  const porClave = (lista) => {
    const m = new Map();
    for (const c of lista.filter((x) => esDirectiva(x.texto))) { if (!m.has(clave(c))) m.set(clave(c), []); m.get(clave(c)).push(c); }
    return m;
  };
  const da = porClave(ca);
  for (const [k, lb] of porClave(cb)) {
    const la = da.get(k) || [];
    for (let n = 0; n < Math.min(la.length, lb.length); n++) {
      if (la[n].saltosAntes !== lb[n].saltosAntes || la[n].saltosDespues !== lb[n].saltosDespues) {
        return { codigo: `cambiaron los saltos alrededor de un comentario que puede ser una directiva: ${lb[n].texto.slice(0, 60)}` };
      }
    }
  }
  return { cambiaron: soloAntes.length + soloAhora.length > 0 };
}

const codigo = (motivo) => ({ tipo: 'codigo', motivo });
const forma = (t) => (t.tipo === 'texto' ? `\u0000${t.familia}` : t.v);

/**
 * Qué cambió de `antes` a `ahora` (dos `Buffer`) en `archivo` (decide por su extensión): `{ tipo, motivo }`, más
 * `visibles` cuando el tipo es `textos`. Ante cualquier duda, `codigo`.
 */
function queCambio(antes, ahora, { archivo } = {}) {
  try {
    const ext = path.extname(String(archivo || '')).toLowerCase();
    const idioma = IDIOMAS[ext];
    if (!idioma) return codigo(ext ? `no sé leer los ${ext}` : 'un archivo sin extensión');
    if (!Buffer.isBuffer(antes) || !Buffer.isBuffer(ahora)) return codigo('sin el contenido de los dos lados');
    if (antes.equals(ahora)) return { tipo: 'igual', motivo: 'los mismos bytes' };
    if (antes.length > TOPE_BYTES || ahora.length > TOPE_BYTES) return codigo('más de 2 MiB');
    const fuentes = [];
    for (const buf of [antes, ahora]) {
      const t = buf.toString('utf8');
      if (!Buffer.from(t, 'utf8').equals(buf)) return codigo('bytes que no son UTF-8 válido');
      fuentes.push(t);
    }
    const a = leer(fuentes[0], idioma);
    if (a.duda) return codigo(`lo de antes: ${a.duda}`);
    const b = leer(fuentes[1], idioma);
    if (b.duda) return codigo(`lo de ahora: ${b.duda}`);
    if (a.tokens.length !== b.tokens.length || a.tokens.some((t, k) => forma(t) !== forma(b.tokens[k]))) return codigo('cambió el código');
    if (a.separaciones.some((x, k) => x !== b.separaciones[k])) return codigo('cambió la separación entre dos tokens');
    const com = compararComentarios(a.comentarios, b.comentarios);
    if (com.codigo) return codigo(com.codigo);
    let textos = 0;
    let deJsx = 0;
    a.tokens.forEach((t, k) => {
      if (t.tipo !== 'texto') return;
      const u = b.tokens[k];
      const igual = t.familia === 'jsx' ? textoVisible(t.v) === textoVisible(u.v) : t.v === u.v;
      if (igual) return;
      textos++;
      if (t.familia === 'jsx') deJsx++;
    });
    if (textos) {
      const cuantos = textos === 1 ? 'un texto' : `${textos} textos`;
      return { tipo: 'textos', visibles: deJsx === textos, motivo: `cambió ${cuantos}${deJsx ? ` (${deJsx === textos ? 'todo' : deJsx} de pantalla)` : ''}${com.cambiaron ? ' y algún comentario' : ''}` };
    }
    if (com.cambiaron) return { tipo: 'comentarios', motivo: 'cambiaron comentarios, y nada más' };
    return { tipo: 'igual', motivo: 'sólo cambiaron espacios, la sangría o los fines de línea' };
  } catch (e) {
    return codigo(`no pude leerlo: ${String((e && e.message) || e).split('\n')[0]}`);
  }
}

module.exports = { queCambio, leer, textoVisible, EXTENSIONES, TIPOS, TOPE_BYTES };
