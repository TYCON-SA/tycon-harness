'use strict';
/**
 * nightly-coverage.js — qué criterios de una historia tienen una prueba que corre de noche, y si la historia toca firmas
 * o frenos.
 *
 * Una historia que cierra por el código con que entró a main (lib/evidence-vs-commit.js) deja de repetir sus pruebas
 * cuando otra fusión cambia ese código. Si lo que toca son firmas o frenos, alguien tiene que seguir mirándolo: una suite
 * de `diarias` en scripts/tests/suites.json o un caso del banco nocturno, que corre `cases/hooks`. Los casos de revisores y
 * de guías van en el examen periódico y no cuentan.
 *
 * Para dar cobertura las dos marcas tienen que estar juntas, en un renglón de la prueba o en un texto del caso. Un archivo
 * puede traer marcas de varias historias, y juntarlas le daría a ésta los criterios de otra.
 */
const fs = require('fs');
const path = require('path');

// Los criterios que siguen a la marca de la historia, hasta la marca de otra: `@story-9.9 @ac-1 @story-9.8 @ac-2` le da
// a la 9.9 sólo el 1.
function criteriosDelTexto(texto, historia) {
  const out = [];
  let propia = false;
  for (const m of texto.matchAll(/@story-([0-9A-Za-z][\w.-]*)|@ac-(\d+)\b/g)) {
    if (m[1] !== undefined) propia = m[1].replace(/[.-]+$/, '') === historia;
    else if (propia) out.push(Number(m[2]));
  }
  return out;
}

function textosDe(valor, out = []) {
  if (typeof valor === 'string') out.push(valor);
  else if (Array.isArray(valor)) valor.forEach((v) => textosDe(v, out));
  else if (valor && typeof valor === 'object') Object.values(valor).forEach((v) => textosDe(v, out));
  return out;
}

const realSiSePuede = (p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };

// Las rutas de `diarias`, absolutas. Las raíces son las de `__raices`: `arnes` es scripts/ y `agent-skills` es skills/.
function suitesDiarias(raiz) {
  let lista;
  try { lista = JSON.parse(fs.readFileSync(path.join(raiz, 'scripts', 'tests', 'suites.json'), 'utf8')).diarias; } catch (_) { return new Set(); }
  if (!Array.isArray(lista)) return new Set();
  const carpetas = { arnes: 'scripts', 'agent-skills': 'skills' };
  return new Set(lista.filter((s) => s && carpetas[s.raiz] && s.ruta).map((s) => realSiSePuede(path.join(raiz, carpetas[s.raiz], s.ruta))));
}

// Las formas en que una historia puede nombrar un archivo de su repo: tal cual, sin `./` ni `../`, y sin la carpeta de
// arriba (`<repo>/scripts/…`). Sobra alguna, y eso sólo puede hacer sensible de más.
function formasDe(rel) {
  const limpia = String(rel).replace(/\\/g, '/').replace(/^(\.\.?\/)+/, '');
  const sinPrimera = limpia.includes('/') ? limpia.slice(limpia.indexOf('/') + 1) : null;
  return [limpia, sinPrimera].filter(Boolean);
}

/**
 * `raiz`: la del repo del arnés. `pruebas`: rutas absolutas de las pruebas (y casos del banco) que la historia declara;
 * `declarados`: las rutas tal como las escribe la historia, para reconocer un caso del banco declarado. Devuelve un Set de
 * números. Un caso del banco que la historia no declara no le da cobertura: es de otra.
 */
function criteriosConPruebaDeNoche({ raiz, historia, pruebas = [], declarados = [] }) {
  const criterios = new Set();
  const diarias = suitesDiarias(raiz);
  const propias = new Set(pruebas.map(realSiSePuede));
  for (const prueba of pruebas) {
    if (!diarias.has(realSiSePuede(prueba))) continue;
    let texto;
    try { texto = fs.readFileSync(prueba, 'utf8'); } catch (_) { continue; }
    for (const renglon of texto.split('\n')) for (const n of criteriosDelTexto(renglon, historia)) criterios.add(n);
  }
  const casos = path.join(raiz, 'scripts', 'controls-bench', 'cases', 'hooks');
  const formas = new Set(declarados.flatMap(formasDe));
  let nombres = [];
  try { nombres = fs.readdirSync(casos); } catch (_) { nombres = []; }
  for (const nombre of nombres.filter((n) => n.endsWith('.json'))) {
    const archivo = path.join(casos, nombre);
    if (!propias.has(realSiSePuede(archivo)) && !formas.has(`scripts/controls-bench/cases/hooks/${nombre}`)) continue;
    let caso;
    try { caso = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch (_) { continue; }
    for (const texto of textosDe(caso)) for (const n of criteriosDelTexto(texto, historia)) criterios.add(n);
  }
  return criterios;
}

/** La carpeta de arriba que tiene la lista de suites del arnés, o null: una historia de otro repo no tiene prueba de noche. */
function raizConSuites(archivo) {
  let dir = path.dirname(path.resolve(archivo));
  for (;;) {
    if (fs.existsSync(path.join(dir, 'scripts', 'tests', 'suites.json'))) return dir;
    const arriba = path.dirname(dir);
    if (arriba === dir) return null;
    dir = arriba;
  }
}

// La ruta de un archivo desde la raíz de su repo de git, o null.
function desdeSuRepo(abs) {
  let dir = path.dirname(realSiSePuede(abs));
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return path.relative(dir, realSiSePuede(abs)).split(path.sep).join('/');
    const arriba = path.dirname(dir);
    if (arriba === dir) return null;
    dir = arriba;
  }
}

/**
 * ¿La historia toca firmas o frenos? Lo mismo que mira el ok de guardar: un archivo declarado de la lista de lo sensible,
 * sea código o no, también uno que borra, o código declarado que carga un archivo de firmas o de avisos. `declarados`: las
 * rutas tal como las escribe la historia, en cualquiera de las formas que la matriz resuelve. `codigo`: rutas absolutas
 * del código que no es prueba, que además se juzga por su ruta desde su repo. Lo que no se puede leer cuenta como sensible.
 */
function historiaSensible({ declarados, codigo }) {
  try {
    const ok = require('./save-ok.js');
    if (declarados.some((rel) => formasDe(rel).some((f) => ok.esSensible(f)))) return true;
    // un archivo fuera de un repo no se sabe dónde cae en la lista: cuenta como sensible
    if (codigo.some((abs) => { const rel = desdeSuRepo(abs); return rel === null || ok.esSensible(rel); })) return true;
    return codigo.some((abs) => ok.requiereSensible(fs.readFileSync(abs, 'utf8')));
  } catch (_) {
    return true;
  }
}

module.exports = { criteriosConPruebaDeNoche, raizConSuites, historiaSensible };
