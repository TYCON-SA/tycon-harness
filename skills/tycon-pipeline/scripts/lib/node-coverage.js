'use strict';
/**
 * node-coverage.js — el lcov que deja el medidor de cobertura de Node, leído como lo usa el informe de pruebas.
 *
 * El corredor de suites del arnés (run-suites-json.js) corre cada suite bajo el medidor de Node y junta lo que deja
 * en un solo lcov. test-gate-report.js necesita de ahí lo mismo que ya saca de coverage-final.json (istanbul) y de
 * cobertura.xml (dotnet): por archivo, qué líneas son medibles y cuáles corrieron. Eso devuelve `readLcov`.
 *
 * Las claves son rutas ABSOLUTAS Y REALES con `/`. Lo que el lcov dice viene de la carpeta desde donde corrió la suite
 * (`SF:scripts/lib/x.js`) o con barras de Windows (`SF:scripts\lib\x.js`); `base` es esa carpeta. Con `within`, lo de
 * fuera de esa carpeta se descarta y se nombra en `outside`: una suite que hace `git commit` corre los hooks de git
 * del arnés INSTALADO, y esos archivos no son los de la story aunque se llamen igual.
 *
 * Un archivo que aparece en varios registros (lo midieron varias suites) suma: una línea está cubierta si ALGUNA la
 * ejecutó. Un lcov vacío, cortado o con una línea rota no da un mapa a medias: da `{ ok: false, reason }`, con el
 * archivo y el motivo, y el informe lo dice como «sin cruce». V8 cuenta como medibles también las llaves y las
 * declaraciones; istanbul, sólo las líneas donde empieza una sentencia: el mismo archivo tiene más líneas medibles acá.
 */
const fs = require('fs');
const path = require('path');

const slash = (p) => String(p).split('\\').join('/');
const isAbs = (p) => path.isAbsolute(p) || /^[A-Za-z]:\//.test(p);
// La misma ruta real que `rutaReal` de test-gate-report.js: en Windows, la versión nativa (mayúsculas y nombres cortos
// canónicos); con la otra, la clave del lcov y la ruta que busca el informe no coinciden.
const realpath = process.platform === 'win32' ? fs.realpathSync.native : fs.realpathSync;
// lo que no existe se resuelve por su carpeta (como `rutaReal`): en Mac, /var y /private/var son el mismo lugar
const realOf = (p) => {
  try { return slash(realpath(p)); } catch (_) {
    const abs = path.resolve(p);
    const arriba = path.dirname(abs);
    return arriba === abs ? slash(abs) : `${realOf(arriba)}/${path.basename(abs)}`;
  }
};

/**
 * Las líneas de `texto` que tienen código: ni en blanco ni sólo comentario. V8 marca como cubiertas las líneas de
 * comentario del nivel superior de un archivo que se cargó, y una cabecera de documentación alcanzaría para pasar el
 * umbral sin que corra ninguna función. Lee comentarios de línea y de bloque, cadenas y expresiones regulares
 * literales (una `/` donde no puede haber una división). Las comillas simples y dobles se cierran al final de la línea,
 * como en JavaScript: un archivo mal leído no arrastra el error al resto.
 */
function codeLines(texto) {
  const out = new Set();
  let linea = 1;
  let estado = null;   // null · 'bloque' · "'" · '"' · '`'
  let previo = '';     // el último carácter de código (no espacio, no comentario): decide si una `/` abre una regex
  const s = String(texto);
  let palabra = '';    // la última palabra de código: después de `return` o `typeof` una `/` también abre una regex
  const PALABRAS = ['return', 'typeof', 'case', 'in', 'of', 'void', 'delete', 'throw', 'new', 'yield', 'await'];
  const abreRegex = () => previo === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(previo) || PALABRAS.includes(palabra);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const sig = s[i + 1];
    if (c === '\n') {
      linea++;
      if (estado === "'" || estado === '"') estado = null;
      continue;
    }
    if (estado === 'bloque') { if (c === '*' && sig === '/') { estado = null; i++; } continue; }
    if (estado) {
      if (c === '\\') { i++; if (s[i] === '\n') linea++; } else if (c === estado) { estado = null; previo = c; }
      out.add(linea);
      continue;
    }
    if (c === '/' && sig === '/') { while (i < s.length && s[i] !== '\n') i++; i--; continue; }
    if (c === '/' && sig === '*') { estado = 'bloque'; i++; continue; }
    if (c === '#' && sig === '!' && i === 0) { while (i < s.length && s[i] !== '\n') i++; i--; continue; }
    if (c === '/' && abreRegex()) {
      // una expresión regular literal: hasta la `/` que la cierra (fuera de una clase `[...]`), en la misma línea
      let clase = false;
      for (i++; i < s.length && s[i] !== '\n'; i++) {
        if (s[i] === '\\') { i++; continue; }
        if (s[i] === '[') clase = true;
        else if (s[i] === ']') clase = false;
        else if (s[i] === '/' && !clase) break;
      }
      out.add(linea);
      previo = '/';
      if (s[i] === '\n') i--;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') estado = c;
    if (/[A-Za-z0-9_$]/.test(c)) palabra = /[A-Za-z0-9_$]/.test(s[i - 1] || '') ? palabra + c : c;
    else if (!/\s/.test(c)) palabra = '';
    if (!/\s/.test(c)) { out.add(linea); previo = c; }
  }
  return out;
}

/**
 * `{ ok: true, map, outside }` o `{ ok: false, reason }`.
 *   map      Map(ruta real → Map(línea → cubierta))
 *   outside  rutas reales descartadas por estar fuera de `within` (vacío sin `within`)
 */
function readLcov(lcovPath, { base = process.cwd(), within = null, label = null, realpath: resolver = null } = {}) {
  // `realpath`: la función de ruta real de quien va a buscar en el mapa (el informe pasa la suya)
  const realKey = resolver || realOf;
  // `label`: cómo se nombra el archivo en el motivo (el informe no pone la carpeta temporal de la corrida)
  const file = label || lcovPath;
  let text;
  try { text = fs.readFileSync(lcovPath, 'utf8'); } catch (e) {
    return { ok: false, reason: `${file}: no se pudo leer (${e.code || e.message})` };
  }
  const raiz = within ? realKey(within) : null;
  const map = new Map();
  const outside = new Set();
  let actual = null;     // { key, lines } del registro abierto; key null = descartado
  let abierto = null;    // el SF del registro abierto, tal como vino
  let registros = 0;
  const lineas = text.split(/\r?\n/);
  for (let i = 0; i < lineas.length; i++) {
    const ln = lineas[i].trim();
    if (!ln) continue;
    if (ln.startsWith('SF:')) {
      if (abierto !== null) return { ok: false, reason: `${file}: línea ${i + 1}: el registro de ${abierto} no termina antes del siguiente` };
      abierto = ln.slice(3);
      const sf = slash(abierto);
      const key = realKey(isAbs(sf) ? sf : path.join(base, sf));
      if (raiz && key !== raiz && !key.startsWith(raiz + '/')) { outside.add(key); actual = { key: null }; continue; }
      if (!map.has(key)) map.set(key, new Map());
      actual = { key, lines: map.get(key) };
    } else if (ln === 'end_of_record') {
      if (abierto === null) return { ok: false, reason: `${file}: línea ${i + 1}: «end_of_record» sin registro abierto` };
      abierto = null;
      actual = null;
      registros++;
    } else if (ln.startsWith('DA:')) {
      const m = /^DA:(\d+),(\d+)(?:,.*)?$/.exec(ln);
      if (!m && abierto !== null && lineas.slice(i + 1).every((x) => !x.trim())) {
        // la última línea a medio escribir: el archivo se cortó (una suite que murió escribiendo)
        return { ok: false, reason: `${file}: cortado: el registro de ${abierto} termina a mitad de una línea («${ln.slice(0, 60)}»)` };
      }
      if (!m || abierto === null) return { ok: false, reason: `${file}: línea ${i + 1}: no se puede leer «${ln.slice(0, 60)}»` };
      if (!actual.key) continue;
      const nro = Number(m[1]);
      actual.lines.set(nro, (actual.lines.get(nro) || false) || Number(m[2]) > 0);
    }
    // TN, FN, FNDA, BRDA, LH, LF…: no hacen falta para las líneas
  }
  if (abierto !== null) return { ok: false, reason: `${file}: cortado: el registro de ${abierto} no termina (falta «end_of_record»)` };
  if (!registros) return { ok: false, reason: `${file}: no trae ningún archivo (lcov vacío)` };
  // sólo las líneas con código: un archivo que no se puede leer queda con lo que dijo V8, y se nombra en
  // `sourceUnreadable` (sus comentarios pueden estar contados como cubiertos)
  const sourceUnreadable = [];
  for (const [key, lineas] of map) {
    let fuente;
    try { fuente = fs.readFileSync(key, 'utf8'); } catch (_) { sourceUnreadable.push(key); continue; }
    const codigo = codeLines(fuente);
    for (const nro of [...lineas.keys()]) if (!codigo.has(nro)) lineas.delete(nro);
  }
  return { ok: true, map, outside: [...outside].sort(), sourceUnreadable: sourceUnreadable.sort() };
}

/**
 * Junta los lcov de una carpeta (uno por suite) en `out`, sin los registros de `drop` (rutas; las relativas del lcov se
 * resuelven contra `base`). `{ withData, withoutData, unreadable }`: cuántas suites dejaron algún registro, cuáles no
 * dejaron ninguno (una de bash que no lanza `node`, o una que falló antes de arrancar) y cuáles dejaron un archivo que
 * no se pudo leer (`{ name, reason }`: no es lo mismo que «sin datos»). Ninguna rompe nada: sus archivos quedan «sin
 * datos» en el informe, nunca como 0 %.
 */
function joinLcov(dir, out, { base = process.cwd(), drop = [] } = {}) {
  const fuera = new Set(drop.map(realOf));
  let nombres = [];
  try { nombres = fs.readdirSync(dir).filter((n) => n.endsWith('.lcov')).sort(); } catch (_) { nombres = []; }
  const partes = [];
  const withoutData = [];
  const unreadable = [];
  let withData = 0;
  for (const n of nombres) {
    let t;
    try { t = fs.readFileSync(path.join(dir, n), 'utf8'); } catch (e) {
      unreadable.push({ name: n, reason: `no se pudo leer (${e.code || e.message})` });
      continue;
    }
    // por registro: de `SF:` hasta `end_of_record`
    const registros = (t.match(/^SF:[^\r\n]*[\s\S]*?^end_of_record[^\S\r\n]*$/gm) || []).filter((r) => {
      const sf = slash(r.slice(3, r.search(/\r?\n/)));
      return !fuera.has(realOf(isAbs(sf) ? sf : path.join(base, sf)));
    });
    // un registro abierto que no termina es un archivo cortado (la suite murió escribiéndolo): se nombra, no se tira
    const abiertos = (t.match(/^SF:/gm) || []).length;
    const cerrados = (t.match(/^end_of_record/gm) || []).length;
    if (abiertos !== cerrados) { unreadable.push({ name: n, reason: `cortado: ${abiertos} registro(s) abierto(s) y ${cerrados} cerrado(s)` }); continue; }
    if (registros.length) { partes.push(...registros.map((r) => `TN:\n${r}\n`)); withData++; } else withoutData.push(n);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, partes.join(''));
  return { withData, withoutData, unreadable };
}

module.exports = { readLcov, joinLcov, codeLines, realOf };
