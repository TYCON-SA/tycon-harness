'use strict';
/**
 * nightly-green.js — ¿la última noche corrió en verde la prueba de un criterio?
 *
 * La matriz da por cubierto, sin la firma del dueño, un criterio declarado imposible de probar en vivo
 * (`runtime_not_verifiable`) sólo si se cumplen las tres cosas:
 *   1. su prueba, con `@story-N` y `@ac-N` en un mismo renglón, ya estaba en el commit de main que midió la noche;
 *   2. la suite de esa prueba corrió esa noche y no quedó en rojo ni sin medir;
 *   3. la foto de esa noche tiene menos de 36 h.
 * La foto es `scripts/controls-bench/ultimo-suites.json`, leída por el mismo camino que el aviso de arranque
 * (scripts/hooks/bench-notice.js): lo publicado en el clon de mantenimiento, o la que está al lado del arnés. La variable
 * `TYCON_SUITES_REPORT` del aviso no vale acá: apuntaría la matriz a una foto cualquiera y cubriría un criterio sin firma.
 * Sin foto, ilegible, vieja o sin el commit que midió, no cubre: el criterio sigue esperando la firma. Una noche roja la
 * vuelve a pedir, porque la matriz se calcula con la foto de cada vez.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { criteriosDelTexto } = require('./nightly-coverage.js');

const MAX_AGE_MS = 36 * 60 * 60 * 1000;
const FUTURE_MS = 60 * 60 * 1000;
const PHOTO = 'scripts/controls-bench/ultimo-suites.json';
const HARNESS_ROOT = path.join(__dirname, '..', '..', '..', '..');

function parsePhoto(text, where) {
  let rep;
  try { rep = JSON.parse(text); } catch (_) { return { rep: null, problem: `la foto de las suites nocturnas (${where}) no se deja leer` }; }
  return rep && typeof rep === 'object' && !Array.isArray(rep) ? { rep, problem: null } : { rep: null, problem: `la foto de las suites nocturnas (${where}) no es un objeto` };
}

function photoFromFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    return { rep: null, problem: e && e.code === 'ENOENT' ? `no hay foto de las suites nocturnas (${file})` : `no pude leer la foto de las suites nocturnas (${(e && e.code) || e})` };
  }
  return parsePhoto(text, file);
}

/**
 * La foto de las suites nocturnas: `{ rep, problem }`, con `rep` null si no hay una que se pueda usar. Nunca tira.
 * `file` lo pasan sólo las pruebas, desde el código: ni la línea de comandos ni el entorno llegan acá.
 */
function readPhoto({ root = HARNESS_ROOT, nightData, file } = {}) {
  if (file) return photoFromFile(file);
  let N = nightData;
  if (!N) { try { N = require(path.join(root, 'scripts', 'lib', 'night-data.js')); } catch (_) { N = null; } }
  if (N) {
    let r;
    try { r = N.resolve(root, { nightly: true }); } catch (e) { return { rep: null, problem: `no pude saber de dónde leer la foto de las suites nocturnas (${(e && e.message) || e})` }; }
    if (r.source === 'maintainers') {
      if (!r.dir) return { rep: null, problem: r.problem || 'no sé de qué clon de mantenimiento leer la foto de las suites nocturnas' };
      const p = N.readPublished(r.dir, PHOTO);
      if (p.state !== 'ok') return { rep: null, problem: `no hay foto de las suites nocturnas en el clon de mantenimiento (${p.state})` };
      return parsePhoto(p.text, 'el clon de mantenimiento');
    }
    if (r.problem) return { rep: null, problem: r.problem };
    if (r.source !== 'own') return { rep: null, problem: 'esta máquina no recibe los procesos nocturnos' };
  }
  return photoFromFile(path.join(root, ...PHOTO.split('/')));
}

/** La raíz del repo de git de un archivo y su ruta real, o null. */
function repoOf(abs) {
  let real;
  try { real = fs.realpathSync(abs); } catch (_) { return null; }
  for (let dir = path.dirname(real); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return { root: dir, rel: path.relative(dir, real).split(path.sep).join('/') };
    if (path.dirname(dir) === dir) return null;
  }
}

/** El texto de `rel` en `commit` del repo `root`, o null si git no lo tiene. */
function showAt(root, commit, rel) {
  let env = process.env;
  try { env = require(path.join(HARNESS_ROOT, 'scripts', 'lib', 'clean-git-env.js')).idiomaFijo(undefined, { GIT_OPTIONAL_LOCKS: '0' }); } catch (_) { /* el entorno propio */ }
  const r = spawnSync('git', ['-C', root, '-c', 'core.fsmonitor=false', 'show', `${commit}:${rel}`], { encoding: 'utf8', timeout: 5000, windowsHide: true, env, stdio: ['ignore', 'pipe', 'ignore'] });
  return !r.error && r.status === 0 ? String(r.stdout || '') : null;
}

const list = (v) => (Array.isArray(v) ? v.map(String) : []);

/**
 * Los criterios de `acs` que la noche cubre: `{ covered: Map(ac → { suite, noche }), problems }`. `tests`: rutas
 * absolutas de las pruebas que declara la historia. `problems` dice por qué la noche no pudo cubrir.
 */
function nightlyCovered({ rep, story, acs, tests, nowMs = Date.now(), show = showAt, repoOfFile = repoOf }) {
  const covered = new Map();
  const problems = [];
  const t = rep && rep.ts ? Date.parse(rep.ts) : NaN;
  if (!Number.isFinite(t)) return { covered, problems: ['la foto de las suites nocturnas no trae su hora'] };
  const noche = new Date(t).toISOString().slice(0, 10);
  if (nowMs - t > MAX_AGE_MS) return { covered, problems: [`la última foto de las suites nocturnas es del ${noche}, de hace más de 36 h`] };
  if (t - nowMs > FUTURE_MS) return { covered, problems: ['la foto de las suites nocturnas tiene una hora del futuro'] };
  const commit = rep.harness && /^[0-9a-f]{7,40}$/i.test(String(rep.harness.commit || '')) ? String(rep.harness.commit) : null;
  if (!commit) return { covered, problems: ['la foto de las suites nocturnas no dice qué commit de main midió'] };
  const ran = new Set(list(rep.ran));
  const red = new Set(list(rep.failures));
  // «x.test.sh(no-medida)»: el nombre de la suite, sin el motivo
  const unmeasured = new Set(list(rep.unmeasured).map((s) => s.replace(/\(.*\)$/, '')));
  const wanted = new Set(acs);
  const marksFor = (text) => text.split('\n').flatMap((line) => criteriosDelTexto(line, story)).filter((n) => wanted.has(n));
  for (const test of tests) {
    // sólo las pruebas que hoy marcan alguno de esos criterios: las demás no tienen nada que decir
    let now;
    try { now = fs.readFileSync(test, 'utf8'); } catch (_) { continue; }
    if (!marksFor(now).length) continue;
    const suite = path.basename(test);
    if (!ran.has(suite)) { problems.push(`${suite} no corrió la noche del ${noche}`); continue; }
    if (red.has(suite)) { problems.push(`${suite} quedó en rojo la noche del ${noche}`); continue; }
    if (unmeasured.has(suite)) { problems.push(`${suite} no se midió la noche del ${noche}`); continue; }
    const repo = repoOfFile(test);
    const text = repo ? show(repo.root, commit, repo.rel) : null;
    if (text === null) { problems.push(`${suite} no está en el commit que midió la noche (${commit.slice(0, 9)}), o no lo tengo a mano`); continue; }
    for (const n of marksFor(text)) if (!covered.has(n)) covered.set(n, { suite, noche });
  }
  return { covered, problems };
}

module.exports = { readPhoto, nightlyCovered, MAX_AGE_MS, PHOTO };
