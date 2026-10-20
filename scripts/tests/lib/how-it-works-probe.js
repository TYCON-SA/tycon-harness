'use strict';
// how-it-works-probe.js — arma el modelo de la pestaña «Cómo trabaja» del sitio sin repo del perfil y escribe en la
// salida, en JSON, lo que la pestaña mostraría del arnés: cada paso con su objetivo y sus guías, los controles con sus
// pasos y su efecto, los revisores de cada paso, las piezas de «Según la historia» con su resultado y los problemas de
// lectura. Si el armado tira, escribe `{ "error": <mensaje> }`.
// Corre igual en el árbol del arnés y dentro de la imagen del sitio (site-image.test.js y site-image.yml la montan ahí):
// lo que falta en la imagen y está en el árbol cambia la segunda salida. No imprime rutas de la máquina.
//
//   node how-it-works-probe.js [raíz]   →   { "steps": [...], "controls": [...], "problems": [...] }
//   con --modules, además la lista de módulos cargados (rutas relativas a la raíz) para cruzarla con lo que copia la imagen
const path = require('path');

const ROOT = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) || path.join(__dirname, '..', '..', '..'));
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
    problems: (m.problems || []).map(texto),
  };
} catch (e) {
  salida = { error: String((e && e.message) || e).split('\n')[0] };
}
if (process.argv.includes('--modules')) {
  salida.modules = Object.keys(require.cache).filter((f) => f.startsWith(ROOT + path.sep) && !f.includes(`${path.sep}tests${path.sep}`)).map(rel).sort();
}
process.stdout.write(`${JSON.stringify(salida)}\n`);
