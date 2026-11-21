'use strict';
/**
 * ¿El inventario de los controles que trae un commit cuadra con el pre-commit del repo privado?
 *
 * El repo privado tiene su propio pre-commit (y otras copias propias: las de `own` en su `.tycon/internal-forms.json`).
 * De noche, con lo público encima, `run-base-controls.sh check-inventory` compara el inventario
 * (`scripts/ci/controls-from-base.json`) con ese pre-commit. Por eso, un control nuevo del público que el privado no
 * corre sale rojo recién al día siguiente. Esto hace la misma comparación al commitear en el público, en la máquina que
 * declara el clon privado (`paths.maintainers`). La usa `scripts/ci/check-staged-ci-rules.js` (su regla 4).
 *
 * Arma un árbol sin tocar nada de los dos repos: lo que trae el commit (el índice), con las copias propias del privado
 * encima. Las copias salen de su `origin/main` tal como está en el clon, sin traer nada de la red. Después le corre
 * `check-inventory`. Los guiones que sólo tiene el privado no están en ese árbol: el inventario los saltea como saltea
 * un nombre de antes.
 *
 * Avisa, no frena: el privado sólo puede sumar la llamada a un control nuevo cuando el arnés instalado ya lo trae (su
 * arranque frena si falta un guion). Frenar el commit del público dejaría a los dos esperándose.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const INVENTORY = 'scripts/ci/controls-from-base.json';
const FORMS = '.tycon/internal-forms.json';
const DEFAULT_REF = 'origin/main';

/** ¿El commit toca algo que cambia la comparación? El inventario o el pre-commit del público. */
function toca(rutas, hook = '.githooks/pre-commit-checks') {
  return rutas.some((r) => r === INVENTORY || r === hook);
}

// Dentro de un hook, git exporta a dónde apunta el repo que commitea (GIT_DIR, GIT_INDEX_FILE…). Con ellas, una lectura
// del clon privado leería el público. Las lecturas del privado van sin ellas; las del público usan el índice del commit.
const DEL_REPO = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'];
function sinRepo() {
  const e = { ...process.env };
  for (const k of DEL_REPO) delete e[k];
  return e;
}

function git(root, args, { input, env, ajeno = false } = {}) {
  const r = spawnSync('git', ['-C', root, '-c', 'core.quotePath=false', ...args], { input, encoding: 'utf8', env: { ...(ajeno ? sinRepo() : process.env), ...(env || {}) }, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (r.error) throw new Error(`git ${args[0]}: ${r.error.message}`);
  return r;
}
function gitOk(root, args, opts) {
  const r = git(root, args, opts);
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${(r.stderr || '').trim().split('\n')[0]}`);
  return r.stdout.replace(/\n+$/, '');
}

/** El clon privado: el que se pasa, o el que declara la máquina. `{ path }`, `{ none }` o `{ problem }`. */
function clonPrivado(privado, env) {
  if (privado) return { path: path.resolve(privado) };
  let d;
  try { d = require('../setup/harness/tycon-home.js').maintainersClone({ env }); } catch (e) {
    return { problem: `no pude leer lo que declara la máquina (${String((e && e.message) || e).split('\n')[0]})` };
  }
  if (d.problem) return { problem: d.problem };
  if (!d.declared) return { none: true };
  return { path: d.path };
}

/** Las rutas que el privado guarda como propias (`own` es ruta → motivo), de su `<ref>`. */
function propias(privado, ref) {
  const r = git(privado, ['show', `${ref}:${FORMS}`], { ajeno: true });
  if (r.status !== 0) return [];
  const own = JSON.parse(r.stdout).own;
  if (!own || typeof own !== 'object' || Array.isArray(own)) throw new Error(`${FORMS} del privado no trae la lista «own»`);
  return Object.keys(own);
}

/** Un commit suelto (no queda en ninguna rama) con el índice del público y las copias propias del privado encima. */
function arbolArmado(repo, privado, ref, rutas) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'private-inventory-'));
  const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
  try {
    gitOk(repo, ['read-tree', gitOk(repo, ['write-tree'])], { env });
    for (const p of rutas) {
      const m = /^(\d+) blob [0-9a-f]+\t/.exec(gitOk(privado, ['ls-tree', ref, '--', p], { ajeno: true }));
      if (!m) continue;
      const blob = gitOk(repo, ['hash-object', '-w', '--stdin'], { input: git(privado, ['cat-file', 'blob', `${ref}:${p}`], { ajeno: true }).stdout });
      gitOk(repo, ['update-index', '--add', '--cacheinfo', `${m[1]},${blob},${p}`], { env });
    }
    const tree = gitOk(repo, ['write-tree'], { env });
    return gitOk(repo, ['-c', 'user.name=inventario', '-c', 'user.email=inventario@ejemplo.test', 'commit-tree', tree, '-m', 'el inventario contra el privado']);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/**
 * La comparación. `estado`:
 *   'cuadra' · 'no-cuadra' (`problemas`: lo que dice check-inventory) · 'sin-clon' (la máquina no declara el privado)
 *   · 'no-aplica' (el repo no trae el inventario en el índice: es el privado, o un repo sin controles de la base)
 *   · 'no-pude' (`motivo`).
 * Siempre trae `ref` y, si leyó el clon, `fecha` (la del último commit de esa ref).
 */
function comparar({ repo, privado = null, ref = DEFAULT_REF, env = process.env } = {}) {
  const base = { ref };
  repo = path.resolve(repo);
  try {
    if (git(repo, ['cat-file', '-e', `:${INVENTORY}`]).status !== 0) return { ...base, estado: 'no-aplica' };
  } catch (e) { return { ...base, estado: 'no-pude', motivo: e.message }; }
  const c = clonPrivado(privado, env);
  if (c.none) return { ...base, estado: 'sin-clon' };
  if (c.problem) return { ...base, estado: 'no-pude', motivo: c.problem };
  const guion = path.join(repo, 'scripts', 'ci', 'run-base-controls.sh');
  if (!fs.existsSync(guion)) return { ...base, estado: 'no-pude', motivo: 'este árbol no trae scripts/ci/run-base-controls.sh' };
  let commit; let fecha;
  try {
    if (git(c.path, ['rev-parse', '--verify', '-q', `${ref}^{commit}`], { ajeno: true }).status !== 0) return { ...base, estado: 'no-pude', motivo: `${ref} no está en el clon privado ${c.path}` };
    fecha = gitOk(c.path, ['log', '-1', '--format=%cs', ref], { ajeno: true });
    commit = arbolArmado(repo, c.path, ref, propias(c.path, ref));
  } catch (e) { return { ...base, estado: 'no-pude', motivo: e.message }; }
  const r = spawnSync('bash', [guion, 'check-inventory', '--root', repo, '--ref', commit], { encoding: 'utf8', env: sinRepo(), windowsHide: true });
  const salida = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.status === 0) return { ...base, fecha, estado: 'cuadra' };
  if (r.status !== 1) return { ...base, fecha, estado: 'no-pude', motivo: salida.split('\n').pop() || `check-inventory salió ${r.status}` };
  const problemas = salida.split('\n').filter((l) => /^❌/.test(l) && !/el inventario no cuadra \(\d+\)$/.test(l)).map((l) => l.replace(/^❌ base-controls: /, ''));
  return { ...base, fecha, estado: 'no-cuadra', problemas };
}

/** El aviso para la persona, o null si no hay nada que decir. */
function aviso(r) {
  const donde = `${r.ref}${r.fecha ? ` del ${r.fecha}` : ''}`;
  if (r.estado === 'no-cuadra') {
    return [
      `⚠️  el inventario de los controles de este commit no cuadra con el pre-commit del privado (${donde}):`,
      ...r.problemas.map((p) => `   · ${p}`),
      '   Esta noche sale rojo en el privado. Abrí ya el pedido al privado con el mismo cambio en su',
      '   .githooks/pre-commit-checks: entra cuando éste esté en el arnés instalado (antes, su arranque lo frena).',
    ].join('\n');
  }
  if (r.estado === 'no-pude') return `⚠️  el inventario contra el pre-commit del privado: no pude mirar (${r.motivo}). Lo mira la revisión de la noche.`;
  return null;
}

module.exports = { INVENTORY, DEFAULT_REF, toca, comparar, aviso };
