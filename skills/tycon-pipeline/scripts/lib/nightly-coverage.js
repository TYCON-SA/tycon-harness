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

const escapar = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function criteriosDelTexto(texto, marca) {
  if (!marca.test(texto)) return [];
  return [...texto.matchAll(/@ac-(\d+)\b/g)].map((m) => Number(m[1]));
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

/** `raiz`: la del repo del arnés. `pruebas`: rutas absolutas de las pruebas que la historia declara. Devuelve un Set de números. */
function criteriosConPruebaDeNoche({ raiz, historia, pruebas = [] }) {
  const marca = new RegExp(`@story-${escapar(historia)}(?![\\w.])`);
  const criterios = new Set();
  const diarias = suitesDiarias(raiz);
  for (const prueba of pruebas) {
    if (!diarias.has(realSiSePuede(prueba))) continue;
    let texto;
    try { texto = fs.readFileSync(prueba, 'utf8'); } catch (_) { continue; }
    for (const renglon of texto.split('\n')) for (const n of criteriosDelTexto(renglon, marca)) criterios.add(n);
  }
  const casos = path.join(raiz, 'scripts', 'controls-bench', 'cases', 'hooks');
  let nombres = [];
  try { nombres = fs.readdirSync(casos); } catch (_) { nombres = []; }
  for (const nombre of nombres.filter((n) => n.endsWith('.json'))) {
    let caso;
    try { caso = JSON.parse(fs.readFileSync(path.join(casos, nombre), 'utf8')); } catch (_) { continue; }
    for (const texto of textosDe(caso)) for (const n of criteriosDelTexto(texto, marca)) criterios.add(n);
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

/**
 * ¿La historia toca firmas o frenos? Lo mismo que mira el ok de guardar: un archivo declarado de la lista de lo sensible,
 * sea código o no, o código declarado que carga un archivo de firmas o de avisos. `declarados`: rutas relativas a su repo.
 * `codigo`: rutas absolutas del código que no es prueba. Lo que no se puede leer cuenta como sensible.
 */
function historiaSensible({ declarados, codigo }) {
  try {
    const ok = require('./save-ok.js');
    if (declarados.some((rel) => ok.esSensible(String(rel).replace(/^\.\//, '')))) return true;
    return codigo.some((abs) => ok.requiereSensible(fs.readFileSync(abs, 'utf8')));
  } catch (_) {
    return true;
  }
}

module.exports = { criteriosConPruebaDeNoche, raizConSuites, historiaSensible };
