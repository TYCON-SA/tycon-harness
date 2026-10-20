'use strict';
// how-it-works-probe.js — arma el modelo de la pestaña «Cómo trabaja» del sitio sin repo del perfil y escribe en la
// salida, en JSON, lo que la pestaña mostraría del arnés: cada paso con su objetivo y sus guías, los controles con sus
// pasos y su efecto, los revisores de cada paso, las piezas de «Según la historia» con su resultado y los problemas de
// lectura. Si el armado tira, escribe `{ "error": <mensaje> }`.
// Corre igual en el árbol del arnés y dentro de la imagen del sitio (site-image.test.js y site-image.yml la montan ahí):
// lo que falta en la imagen y está en el árbol cambia la segunda salida. No imprime rutas de la máquina.
//
//   node how-it-works-probe.js [raíz]   →   { "steps": [...], "controls": [...], "publicRepo", "codeLinks", "problems": [...] }
//   con --modules, además la lista de módulos cargados (rutas relativas a la raíz) para cruzarla con lo que copia la imagen
//   con --public-remotes-tree <carpeta>, el repo público se lee de ahí (las pruebas lo apuntan a una carpeta vacía)
const path = require('path');

const args = process.argv.slice(2);
const opcion = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const ROOT = path.resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--public-remotes-tree') || path.join(__dirname, '..', '..', '..'));
// sólo para las pruebas: de dónde se lee el repo público (una carpeta sin el archivo hace de la imagen de antes)
const REMOTES_TREE = path.resolve(opcion('--public-remotes-tree') || ROOT);
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

let salida;
try {
  const HIW = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'how-it-works.js'));
  const m = HIW.buildModel({ treeDir: ROOT });
  const texto = (p) => (typeof p === 'string' ? p : `${p.spec || ''}: ${p.message || JSON.stringify(p)}`);
  const revisores = (r) => Object.fromEntries(Object.entries(r || {}).map(([grupo, xs]) => [grupo, (xs || []).map((x) => x.agent || x.name || String(x))]));
  salida = {
    steps: m.steps.map((s) => ({
      id: s.id, goal: s.goal || null, guides: s.guides || [], reviewers: revisores(s.reviewers),
      controls: (s.controls || []).map((c) => `${c.spec}|${c.effect}|${c.off || ''}`),
      storyPieces: (s.storyPieces || []).map((x) => x.id), problems: (s.problems || []).map(texto),
    })),
    controls: ((m.allSteps && m.allSteps.controls) || []).map((c) => `${c.spec}|${(c.steps || []).join(',')}|${c.effect}`),
    packs: (m.packs || []).map((p) => `${p.name}|${(p.problems || []).length}`),
  };
  // la página armada: el repo público (de scripts/setup/public-remotes.json) y cuántos «Ver el código» trae. Sin uno de
  // los dos es un problema más: la guarda del workflow no publica la imagen
  const TAB = require(path.join(ROOT, 'scripts', 'site', 'tabs', 'how-it-works.js'));
  salida.publicRepo = TAB.publicRepoOf(REMOTES_TREE);
  salida.codeLinks = (TAB.renderPage(m, { idioma: 'es', publicRepo: salida.publicRepo, version: '' }).match(/href="[^"]*\/blob\/main\//g) || []).length;
  // `problems` va última: la guarda del workflow mira que la salida termine en "problems":[]}
  salida.problems = (m.problems || []).map(texto);
  if (!salida.publicRepo) salida.problems.push('sin repo público: scripts/setup/public-remotes.json no se pudo leer');
  else if (!salida.codeLinks) salida.problems.push('sin enlaces al código en la página');
} catch (e) {
  salida = { error: String((e && e.message) || e).split('\n')[0] };
}
if (process.argv.includes('--modules')) {
  salida.modules = Object.keys(require.cache).filter((f) => f.startsWith(ROOT + path.sep) && !f.includes(`${path.sep}tests${path.sep}`)).map(rel).sort();
}
process.stdout.write(`${JSON.stringify(salida)}\n`);
