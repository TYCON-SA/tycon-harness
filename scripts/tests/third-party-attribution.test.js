'use strict';

/**
 * third-party-attribution.test.js — la atribución de lo ajeno, medida sobre este repo (story 8.26, tanda I).
 *
 * Hasta el 2026-10-13 esto lo medía `third-party-real.test.sh` en el repo del equipo, sobre la copia pública que el
 * exportador armaba desde ahí. Desde que el arnés se escribe en GitHub ya no sale ninguna copia: la que se publica es
 * ESTE repo, y la atribución se mide acá, sin red. Lo de aquella suite que medía el retiro de 2026-09 (la historia,
 * las máquinas de juguete del día del retiro, el exportador) no es un camino vivo y no se trajo.
 *
 * Lo que no se puede perder:
 *   · Cobertura: cada ruta versionada cae en un solo universo del manifiesto y nada ajeno está versionado
 *     (`third-party-coverage.js` sale 0). Control negativo: una copia con una skill ajena re-agregada sale 1 nombrándola.
 *   · Las piezas del arnés que acreditan a ECC son exactamente las que el manifiesto declara como derivadas de ECC.
 *   · Cada skill derivada (una carpeta) viaja con su LICENSE, con el copyright que declara el manifiesto, y un NOTICE.md
 *     que nombra su origen (repo, commit y ruta) y cada archivo que git versiona en ella.
 * Que el LICENSE de una derivada sea el del origen byte a byte lo mide third-party-origin.test.sh (con red); que el
 * NOTICE de la raíz liste cada derivada, repo-papers.test.js.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { sinGitDelPadre } = require('../lib/clean-git-env.js');

const ROOT = path.resolve(__dirname, '..', '..');
const COVERAGE = path.join(ROOT, 'scripts', 'publishing', 'third-party-coverage.js');
const MANIFEST_PATH = path.join(ROOT, 'scripts', 'publishing', 'third-party-skills.json');
const ECC_ORIGIN = /affaan-m\/ECC/;
// Las dos formas con que una pieza acredita a ECC: el enlace a su repo y la cabecera de los revisores.
const ECC_MARKS = ['affaan-m/ECC', 'Inspirado en ECC'];

function labEnv() {
  return sinGitDelPadre({
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file',
    GIT_AUTHOR_NAME: 'Lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'Lab', GIT_COMMITTER_EMAIL: 'lab@example.com',
  });
}
function git(dir, args) {
  return spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', dir, ...args], { env: labEnv(), encoding: 'utf8' });
}
function coverage(repo) {
  return spawnSync(process.execPath, [COVERAGE, '--repo', repo, '--manifest', MANIFEST_PATH],
    { env: labEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const manifest = () => JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
/** Lo que git versiona en este repo (nunca el disco: lo suelto de una máquina no es del repo). */
function tracked(...pathspecs) {
  const r = git(ROOT, ['ls-files', '-z', '--', ...pathspecs]);
  assert.strictEqual(r.status, 0, `no pude preguntarle a git qué versiona: ${r.stderr}`);
  return r.stdout.split('\0').filter(Boolean);
}

test('Attribution_Coverage_RealRepoIsClean — cada ruta versionada en su universo, nada ajeno versionado', () => {
  assert.strictEqual(manifest().retirement, 'done', 'el manifiesto tiene que tener el retiro hecho: esta prueba mide lo publicado después');
  const r = coverage(ROOT);
  assert.strictEqual(r.status, 0, `la cobertura sobre este repo salió ${r.status}:\n${r.stdout}${r.stderr}`);
});

test('Attribution_Coverage_ForeignSkillReAdded_FailsNamingIt — control negativo: la prueba ve lo que dice que mira', () => {
  const foreign = manifest().third_party.map((e) => e.target).find((t) => t.startsWith('skills/'));
  assert.ok(foreign, 'el manifiesto no declara ninguna skill ajena: el control negativo no tendría qué re-agregar');
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'attribution-lab-'));
  try {
    const copy = path.join(lab, 'copy');
    let r = spawnSync('git', ['clone', '-q', '--shared', ROOT, copy], { env: labEnv(), encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `no pude clonar el repo para el control negativo: ${r.stderr}`);
    fs.mkdirSync(path.join(copy, foreign), { recursive: true });
    fs.writeFileSync(path.join(copy, foreign, 'SKILL.md'), '---\nname: re-agregada\n---\n');
    // `-f`: el .gitignore la ignora a propósito (el retiro); re-agregarla a la fuerza es justo el error que se busca
    assert.strictEqual(git(copy, ['add', '-f', '--', foreign]).status, 0, 'no pude preparar la skill re-agregada');
    assert.strictEqual(git(copy, ['commit', '-q', '-m', 're-agrego una ajena']).status, 0, 'no pude commitear la skill re-agregada');
    r = coverage(copy);
    const out = `${r.stdout}${r.stderr}`;
    assert.strictEqual(r.status, 1, `con ${foreign} re-agregada la cobertura tenía que salir 1 y salió ${r.status}:\n${out}`);
    assert.ok(out.includes(foreign), `el hallazgo tiene que nombrar ${foreign}:\n${out}`);
  } finally {
    fs.rmSync(lab, { recursive: true, force: true });
  }
});

test('Attribution_EccCredits_MatchTheManifest — las piezas que acreditan a ECC son las derivadas declaradas', () => {
  // Fuera de la cuenta, lo que nombra a ECC sin acreditarlo: el manifiesto (lo declara), las pruebas (lo buscan) y las
  // plantillas de los papeles que el repo del equipo conserva por un tiempo (su NOTICE LISTA las derivadas para dar el
  // crédito; no es una de ellas). Sin esa exclusión, la suite sale roja en el árbol armado del repo del equipo. También quedan
  // fuera las decisiones fechadas (guides/decisions/): son historia que vive sólo en el repo de mantenimiento y no se publican.
  const r = git(ROOT, ['grep', '-l', ...ECC_MARKS.flatMap((m) => ['-e', m]), '--', 'guides', 'scripts',
    ':!scripts/publishing/third-party-skills.json', ':!scripts/tests', ':!scripts/publishing/public-files', ':!guides/decisions']);
  // git grep sale 1 cuando no encuentra nada: eso también es un resultado (y uno malo: ver abajo), no un error
  assert.ok(r.status === 0 || r.status === 1, `no pude buscar los créditos a ECC: ${r.stderr}`);
  const credited = r.stdout.split('\n').filter(Boolean).sort();
  const declared = manifest().derived
    .filter((d) => ECC_ORIGIN.test((d.based_on || {}).origin || '') && /^(guides|scripts)\//.test(d.target))
    .map((d) => d.target).sort();
  assert.ok(credited.length > 0, 'ninguna pieza acredita a ECC: la búsqueda no está mirando lo que dice que mira');
  assert.deepStrictEqual(credited, declared, 'las piezas que acreditan a ECC (izquierda) contra las derivadas de ECC del manifiesto (derecha)');
});

test('Attribution_DerivedSkills_CarryLicenseAndNotice — cada skill derivada con su LICENSE y su NOTICE.md', () => {
  const skills = manifest().derived.filter((d) => d.target.startsWith('skills/'));
  assert.ok(skills.length > 0, 'el manifiesto no declara ninguna skill derivada: la prueba no estaría probando nada');
  const problems = [];
  for (const d of skills) {
    const dir = path.join(ROOT, d.target);
    const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { return null; } };
    const license = read('LICENSE');
    const notice = read('NOTICE.md');
    if (license === null) problems.push(`${d.target}: no hay LICENSE`);
    else if (!d.copyright || !license.includes(d.copyright)) problems.push(`${d.target}: el LICENSE no trae «${d.copyright}»`);
    if (notice === null) { problems.push(`${d.target}: no hay NOTICE.md`); continue; }
    for (const k of ['origin', 'commit', 'path']) {
      const v = (d.based_on || {})[k];
      if (!v || !notice.includes(v)) problems.push(`${d.target}: NOTICE.md no nombra based_on.${k}`);
    }
    const files = tracked(d.target).map((p) => path.posix.basename(p)).filter((f) => !['LICENSE', 'NOTICE.md'].includes(f));
    if (!files.length) problems.push(`${d.target}: git no versiona ningún archivo de la skill`);
    for (const f of files) if (!notice.includes(f)) problems.push(`${d.target}: NOTICE.md no nombra ${f}`);
  }
  assert.deepStrictEqual(problems, []);
});
