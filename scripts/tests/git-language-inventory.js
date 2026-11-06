#!/usr/bin/env node
'use strict';
/**
 * git-language-inventory.js — quién lee palabras de git, y si le pide a git que conteste en inglés.
 *
 * El arnés reconoce varios errores de git por su texto («not a git repository», «does not exist»…), y git los traduce
 * según el idioma de la máquina. Un script que compara una de esas frases y lanza git sin el idioma fijo se equivoca en
 * una máquina con git en castellano. El idioma se fija en un solo lugar: `idiomaFijo` o `IDIOMA_DE_GIT` de
 * scripts/lib/clean-git-env.js.
 *
 * QUÉ MIRA (los archivos de `git ls-files`: .js, .mjs, .cjs y .sh; sin pruebas, vendor/ ni .advisors/):
 *   · «sin fijar»: el archivo llama a git y tiene una frase de FRASES en una línea que no es comentario, y no usa la
 *     función. La medida es por archivo: uno que la usa en alguna llamada «fija».
 *   · «a mano»: un .js que escribe `LC_ALL` en un objeto de entorno fuera de clean-git-env.js.
 *   · «excepción muerta»: una de EXCEPCIONES que ya no existe, o que ya no cae en ninguna de las dos reglas.
 *
 * Lo usa git-language.test.js (T7 y T8). Corrido suelto imprime una línea por archivo que lee palabras de git, con
 * `fija` o `NO fija`, y los `LC_ALL` a mano; sale 0 aunque haya alguno sin fijar: es para medir, no frena.
 *
 * Correr:  node scripts/tests/git-language-inventory.js [<raíz del arnés>]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// las frases de error de git que el arnés compara en archivos que llaman a git
const FRASES = Object.freeze([
  'not a git repository', 'must be run in a work tree', 'does not exist', 'exists on disk, but not in',
  'not in the index', 'unknown revision', 'bad revision', 'invalid object name', 'not a valid object',
  'does not have any commits', "couldn't find remote ref", 'no such remote', 'not our ref', 'is not a commit',
  'unadvertised object', 'did not send all necessary objects', 'remote branch .* not found',
  'could not find remote branch', 'authentication failed', 'could not read username',
  'terminal prompts disabled', 'repository not found', 'repository .* not found',
]);
const FRASES_RE = FRASES.map((f) => new RegExp(f, 'i'));

// Cerrada: cada una con su motivo. Una que ya no existe o ya no cae en ninguna regla hace fallar la prueba.
const EXCEPCIONES = Object.freeze({
  'scripts/controls-bench/live-fire.js': 'llama a git para su laboratorio; su «does not exist» es de los errores de claude, no de git',
  'scripts/lib/owner-window.js': 'su LC_ALL es para ps, no para git',
  'scripts/site/texts.js': 'los textos del sitio: nombran a git en mensajes para la persona, no lo lanzan',
  'scripts/production/guard-libs/lib/legacy-names.js': 'la copia del freno de producción: se instala en /opt con la contraseña del dueño, no carga scripts/lib/ y ya fija el idioma',
  // la copia fija del instalador guarda sólo scripts/setup/harness.js y scripts/setup/harness/*.js: sin scripts/lib/,
  // la vuelta atrás y la desinstalación no arrancarían. Fijan el idioma a mano hasta que esa copia lleve la biblioteca.
  'scripts/setup/harness.js': 'viaja en la copia fija del instalador, sin scripts/lib/: fija el idioma a mano',
  'scripts/setup/harness/layer.js': 'viaja en la copia fija del instalador, sin scripts/lib/: fija el idioma a mano',
  'scripts/setup/harness/sources.js': 'viaja en la copia fija del instalador, sin scripts/lib/: fija el idioma a mano',
});

const BIBLIOTECA = 'scripts/lib/clean-git-env.js';
const EXTENSIONES = /\.(?:js|mjs|cjs|sh)$/;
// sin pruebas ni vendor/, ni la evidencia de las corridas (.advisors/), que en el árbol armado del privado viaja al lado
const PRUEBAS = /(?:^|\/)(?:tests|__tests__|fixtures|vendor)\/|\.test\.|^\.advisors\//;
// llama a git: el texto 'git' entre comillas, un comando de texto que empieza con git (`execSync(\`git -C …\`)`) o que
// lo encadena (`'cd ' + d + ' && git rev-parse'`), o una función cuyo nombre empieza o termina en git, también como
// método de otro módulo (`gitIn(`, `remoteGit(`, `SRC.git(`); en un guion de shell, git como comando
const LLAMA_A_GIT = /(['"`])git\1|(['"`])git\s|(?:&&|\|\||[;|])\s*git\s+[-\w]|(?:^|[^\w$])(?:git\w*|\w*Git)\s*\(/;
const LLAMA_A_GIT_SH = /(?:^|[\s;|&(`$])git\s+[-\w]/m;
// usar la función o la constante; nombrarlas al traerlas (`const { IDIOMA_DE_GIT } = require(…)`) no fija nada
const FIJA = /idiomaFijo\s*\(|IDIOMA_DE_GIT/;
const IMPORTA = /\{[^{}]*\}\s*=\s*require\s*\([^)]*\)/g;
// en shell: LC_ALL=C puesto a la llamada a git (`LC_ALL=C git …`, con otras variables en el medio) o exportado
const FIJA_SH = /(?:^|[\s;|&(`$])LC_ALL=C\s+(?:\w+=\S*\s+)*git\b|\bexport\s+LC_ALL=C\b/m;
// LC_ALL escrito en un entorno: como clave de un objeto (después de `{`, de `,` o al principio de la línea), como clave
// calculada (`['LC_ALL']: …`) o asignado (`env.LC_ALL = …`, `env['LC_ALL'] = …`); un `case 'LC_ALL':` no escribe nada
const A_MANO = /(?:^|[{,])\s*(?:LC_ALL|'LC_ALL'|"LC_ALL"|\[\s*['"`]LC_ALL['"`]\s*\])\s*:|(?:\.LC_ALL|\[\s*['"`]LC_ALL['"`]\s*\])\s*=(?!=)/;

// antes de una expresión regular va un operador, una apertura, una coma o una de estas palabras (si no, `/` es dividir)
const ANTES_DE_REGEX = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await))\s*$/;

/**
 * Las líneas de `texto` sin sus comentarios, una por línea (los números de línea no cambian). En JavaScript saca `//` y
 * los bloques `/* … *\/`, también los que ocupan varias líneas, sin confundirlos con lo que va entre comillas, en un
 * texto entre acentos graves de varias líneas (también uno dentro del `${…}` de otro) o en una expresión regular; en un
 * guion de shell, lo que va desde un `#` que empieza una palabra fuera de comillas.
 */
function codigoDe(texto, sh) {
  const lineas = texto.split('\n');
  if (sh) return lineas.map(sinComentarioSh);
  const out = [];
  let enBloque = false;
  // los textos entre acentos graves abiertos, el de más adentro al final: `llaves` cuenta las `{` abiertas dentro de su
  // `${…}` en curso, y vale -1 mientras se está en el texto. Siguen abiertos de una línea a la otra
  const plantillas = [];
  for (const l of lineas) {
    let s = '';
    let comilla = null;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      const d = l[i + 1];
      if (enBloque) { if (c === '*' && d === '/') { enBloque = false; i++; } continue; }
      if (comilla) {
        s += c;
        if (c === '\\') { s += d === undefined ? '' : d; i++; } else if (c === comilla) comilla = null;
        continue;
      }
      const plantilla = plantillas.length ? plantillas[plantillas.length - 1] : null;
      if (plantilla && plantilla.llaves < 0) {
        s += c;
        if (c === '\\') { s += d === undefined ? '' : d; i++; }
        else if (c === '`') plantillas.pop();
        else if (c === '$' && d === '{') { s += d; i++; plantilla.llaves = 0; }
        continue;
      }
      if (plantilla && c === '{') plantilla.llaves++;
      if (plantilla && c === '}' && plantilla.llaves-- === 0) { plantilla.llaves = -1; s += c; continue; }
      if (c === '/' && d === '*') { enBloque = true; i++; continue; }
      if (c === '/' && d === '/') break;
      if (c === '/' && ANTES_DE_REGEX.test(s)) {
        // la expresión regular entera, con sus clases `[…]` (adentro una barra no la cierra), y sus banderas
        let j = i + 1;
        let enClase = false;
        for (; j < l.length; j++) {
          const e = l[j];
          if (e === '\\') { j++; continue; }
          if (enClase) { if (e === ']') enClase = false; continue; }
          if (e === '[') { enClase = true; continue; }
          if (e === '/') break;
        }
        s += l.slice(i, j + 1);
        i = j;
        continue;
      }
      if (c === '`') plantillas.push({ llaves: -1 });
      else if (c === "'" || c === '"') comilla = c;
      s += c;
    }
    out.push(s);
  }
  return out;
}

/** Una línea de shell sin su comentario: desde un `#` al principio de una palabra, fuera de comillas. */
function sinComentarioSh(l) {
  let comilla = null;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (comilla) { if (c === '\\' && comilla === '"') i++; else if (c === comilla) comilla = null; continue; }
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"') { comilla = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(l[i - 1]))) return l.slice(0, i);
  }
  return l;
}

/** Los archivos que se miran, relativos a `raiz`, de `git ls-files`. Tira si git no contesta: no medir no es «cero». */
function archivosDe(raiz) {
  const r = spawnSync('git', ['-C', raiz, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`no pude listar los archivos de ${raiz} con git (${String(r.stderr || (r.error && r.error.message) || '').trim()})`);
  return r.stdout.split('\0').filter((f) => f && EXTENSIONES.test(f) && !PRUEBAS.test(f));
}

/** Lo que dice un archivo: `{ leePalabras, fija, lineaFrase, aMano: [linea] }`. */
function mirar(texto, archivo) {
  const sh = archivo.endsWith('.sh');
  const lineas = codigoDe(texto, sh);
  const codigo = lineas.join('\n');
  let lineaFrase = null;
  const aMano = [];
  lineas.forEach((l, i) => {
    if (lineaFrase === null && FRASES_RE.some((re) => re.test(l))) lineaFrase = i + 1;
    if (!sh && A_MANO.test(l)) aMano.push(i + 1);
  });
  const llama = LLAMA_A_GIT.test(codigo) || (sh && LLAMA_A_GIT_SH.test(codigo));
  // en un guion de shell la función no existe: fija el idioma si le pone LC_ALL=C a git
  const fija = sh ? FIJA_SH.test(codigo) : FIJA.test(codigo.replace(IMPORTA, ''));
  return { leePalabras: lineaFrase !== null && llama, fija, lineaFrase, aMano };
}

/**
 * La medición sobre el árbol `raiz`. `opciones.excepciones` reemplaza a EXCEPCIONES (las pruebas).
 * Devuelve `{ sinFijar: [{archivo, linea}], aMano: [{archivo, linea}], excepcionesMuertas: [archivo], leen: [{archivo, fija}] }`.
 */
function revisar(raiz, opciones = {}) {
  const excepciones = opciones.excepciones || EXCEPCIONES;
  const sinFijar = [];
  const aMano = [];
  const leen = [];
  const vistas = new Set();
  for (const archivo of archivosDe(raiz)) {
    let texto;
    try { texto = fs.readFileSync(path.join(raiz, archivo), 'utf8'); } catch (e) {
      if (e && e.code === 'ENOENT') continue;   // listado y borrado del árbol de trabajo
      throw e;
    }
    const m = mirar(texto, archivo);
    const exenta = Object.prototype.hasOwnProperty.call(excepciones, archivo);
    if (exenta && (m.leePalabras || m.aMano.length)) vistas.add(archivo);
    if (exenta) continue;
    if (m.leePalabras) {
      leen.push({ archivo, fija: m.fija });
      if (!m.fija) sinFijar.push({ archivo, linea: m.lineaFrase });
    }
    if (archivo !== BIBLIOTECA) for (const linea of m.aMano) aMano.push({ archivo, linea });
  }
  const excepcionesMuertas = Object.keys(excepciones).filter((a) => !vistas.has(a)).sort();
  return { sinFijar, aMano, excepcionesMuertas, leen };
}

/** Las líneas que dicen qué cambiar, una por hallazgo. */
function explicar(r) {
  return [
    ...r.sinFijar.map((h) => `${h.archivo}:${h.linea}: compara una frase de error de git y lo llama sin el idioma fijo — llamá a git con idiomaFijo de scripts/lib/clean-git-env.js`),
    ...r.aMano.map((h) => `${h.archivo}:${h.linea}: escribe LC_ALL a mano — llamá a git con idiomaFijo (o IDIOMA_DE_GIT) de scripts/lib/clean-git-env.js`),
    ...r.excepcionesMuertas.map((a) => `${a}: está en EXCEPCIONES de scripts/tests/git-language-inventory.js y ya no existe o ya no compara ninguna frase — sacala de la lista`),
  ];
}

module.exports = { FRASES, EXCEPCIONES, revisar, explicar };

if (require.main === module) {
  const raiz = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
  const r = revisar(raiz);
  for (const l of r.leen) console.log(`${l.fija ? 'fija   ' : 'NO fija'}  ${l.archivo}`);
  for (const h of r.aMano) console.log(`a mano   ${h.archivo}:${h.linea}`);
  for (const a of r.excepcionesMuertas) console.log(`excepción muerta  ${a}`);
  console.log(`— ${r.leen.length} leen palabras de git: ${r.sinFijar.length} sin fijar · ${r.aMano.length} LC_ALL a mano · ${r.excepcionesMuertas.length} excepciones muertas`);
  process.exit(0);
}
