#!/usr/bin/env node
'use strict';
// check-staged-ci-rules.test.js — el freno de antes del commit que mira las tres reglas de la CI pública sobre lo que el
// commit trae (scripts/ci/check-staged-ci-rules.js).
// stable-data: los textos de laboratorio nombran las formas a propósito; los commits de la prueba fijan sus fechas y apagan el mantenimiento.
//
// Lo que no se puede perder:
//   · cada regla frena con archivo, línea y arreglo, y no frena lo que no es el caso;
//   · mira el ÍNDICE, no el disco: lo que se arregló sin `git add` sigue frenando;
//   · una prueba de la lista de las que ya existían pasa, y si ya cumple pide salir de la lista;
//   · el conteo del catálogo corre sólo si el commit toca agents/ o el catálogo, y sobre el catálogo del índice;
//   · «no pude mirar» sale 2, nunca 0;
//   · la prueba y el freno usan el mismo módulo (no hay una segunda copia de cada regla), y el hook lo llama.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const FRENO = path.join(RAIZ, 'scripts', 'ci', 'check-staged-ci-rules.js');
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'lab', GIT_COMMITTER_EMAIL: 'lab@example.com',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};
delete ENV.GIT_DIR; delete ENV.GIT_INDEX_FILE; delete ENV.GIT_WORK_TREE;

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { env: ENV, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}
const LABS = [];
test.after(() => { for (const d of LABS) fs.rmSync(d, { recursive: true, force: true }); });
function tmpdir(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); LABS.push(d); return d; }
function lab() {
  const dir = tmpdir('staged-ci-rules-');
  git(dir, 'init', '-q');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
  return dir;
}
function put(dir, rel, text) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}
function stage(dir, rel, text) { put(dir, rel, text); git(dir, 'add', '--', rel); }
function run(dir) {
  const r = spawnSync(process.execPath, [FRENO, '--repo', dir], { env: ENV, encoding: 'utf8' });
  return { rc: r.status, out: `${r.stdout}${r.stderr}` };
}

const MALO_SH = '#!/usr/bin/env bash\nset -uo pipefail\necho "$S" | grep -q x && echo si\n';
const COMMIT_SIN_FECHAS = '#!/usr/bin/env bash\nset -u\ngit -C "$R" commit -q -m x\n';
const RELOJ_JS = "'use strict';\nconst x = 1;\nconst t = Date.now();\n";

test('StagedCiRules_NothingRelevant_SilentZero — un commit sin guiones, pruebas ni catálogo no dice nada', () => {
  const d = lab();
  stage(d, 'guides/una.md', 'texto con | grep -q y Date.now()\n');
  stage(d, 'otro/x.sh', MALO_SH);
  const r = run(d);
  assert.strictEqual(r.rc, 0, r.out);
  assert.strictEqual(r.out, '');
});

test('StagedCiRules_GrepQPipefail_RedWithFileLineAndFix', () => {
  const d = lab();
  stage(d, 'scripts/tools/x.sh', MALO_SH);
  const r = run(d);
  assert.strictEqual(r.rc, 1, r.out);
  assert.match(r.out, /scripts\/tools\/x\.sh:3 — tubería a `grep -q` con pipefail/);
  assert.match(r.out, /Arreglo: cambiala a `\| grep … >\/dev\/null`/);
  const sinPipefail = lab();
  stage(sinPipefail, 'scripts/tools/y.sh', '#!/usr/bin/env bash\necho "$S" | grep -q x\n');
  assert.strictEqual(run(sinPipefail).rc, 0, 'sin pipefail no es el caso');
});

test('StagedCiRules_OddPathNames — una ruta con comillas o espacios no se saltea', () => {
  const d = lab();
  stage(d, 'scripts/tools/con "comillas" y espacio.sh', MALO_SH);
  const r = run(d);
  assert.strictEqual(r.rc, 1, r.out);
  assert.match(r.out, /con "comillas" y espacio\.sh:3/);
});

test('StagedCiRules_ReadsTheIndexNotTheDisk — arreglado en el disco sin git add sigue frenando', () => {
  const d = lab();
  stage(d, 'skills/s/x.sh', MALO_SH);
  put(d, 'skills/s/x.sh', '#!/usr/bin/env bash\nset -uo pipefail\necho "$S" | grep x >/dev/null\n');
  assert.strictEqual(run(d).rc, 1);
  git(d, 'add', '--', 'skills/s/x.sh');
  assert.strictEqual(run(d).rc, 0);
});

test('StagedCiRules_StableData_CommitsAndClock', () => {
  const d = lab();
  stage(d, 'scripts/tests/a.test.sh', COMMIT_SIN_FECHAS);
  stage(d, 'skills/s/tests/b.test.js', RELOJ_JS);
  stage(d, 'scripts/lib/no-es-prueba.js', RELOJ_JS);
  const r = run(d);
  assert.strictEqual(r.rc, 1, r.out);
  assert.match(r.out, /scripts\/tests\/a\.test\.sh:3 — crea commits sin GIT_AUTHOR_DATE, GIT_COMMITTER_DATE, el mantenimiento automático de git apagado/);
  assert.match(r.out, /skills\/s\/tests\/b\.test\.js:3 — lee el reloj sin inyectar la fecha\. Arreglo: inyectá la fecha/);
  assert.doesNotMatch(r.out, /no-es-prueba/, 'fuera de una carpeta tests no es una prueba');

  const bien = lab();
  stage(bien, 'scripts/tests/a.test.sh', 'export GIT_AUTHOR_DATE=1 GIT_COMMITTER_DATE=1\ngit -c maintenance.auto=false -C "$R" commit -q -m x\n');
  stage(bien, 'scripts/tests/b.test.js', `// stable-data: mide cuánto tarda\n${RELOJ_JS}`);
  stage(bien, 'scripts/tests/c.test.js', `const env = { TYCON_TODAY: '2026-10-15' };\n${RELOJ_JS}`);
  const rb = run(bien);
  assert.strictEqual(rb.rc, 0, rb.out);
});

test('StagedCiRules_StableData_Baseline — la de la lista pasa; si ya cumple, pide salir', () => {
  const d = lab();
  stage(d, 'scripts/tests/fixtures/stable-test-data-baseline.json', JSON.stringify({ commits: ['scripts/tests/vieja.test.sh', 'scripts/tests/ya-cumple.test.sh'], reloj: [] }));
  stage(d, 'scripts/tests/vieja.test.sh', COMMIT_SIN_FECHAS);
  assert.strictEqual(run(d).rc, 0, 'la de la lista pasa, como en la prueba');
  stage(d, 'scripts/tests/ya-cumple.test.sh', '# nada que commitear\necho hola\n');
  const r = run(d);
  assert.strictEqual(r.rc, 1, r.out);
  assert.match(r.out, /scripts\/tests\/ya-cumple\.test\.sh — ya cumple la regla de los commits y sigue en scripts\/tests\/fixtures\/stable-test-data-baseline\.json/);
  // borrada y todavía en la lista
  stage(d, 'scripts/tests/fixtures/stable-test-data-baseline.json', JSON.stringify({ commits: ['scripts/tests/vieja.test.sh'], reloj: [] }));
  git(d, 'rm', '-q', '--cached', '--', 'scripts/tests/ya-cumple.test.sh');
  git(d, 'commit', '-q', '-m', 'lista');
  git(d, 'rm', '-q', '--', 'scripts/tests/vieja.test.sh');
  const rb = run(d);
  assert.strictEqual(rb.rc, 1, rb.out);
  assert.match(rb.out, /scripts\/tests\/vieja\.test\.sh — el commit la saca y sigue en scripts\/tests\/fixtures\/stable-test-data-baseline\.json/);
});

test('StagedCiRules_Catalog_OnlyWhenTouched_AndOnTheIndex', () => {
  const d = lab();
  const real = fs.readFileSync(path.join(RAIZ, 'guides', 'advisor-rules-catalog.md'), 'utf8');
  fs.cpSync(path.join(RAIZ, 'adapters', 'codex', 'agents'), path.join(d, 'adapters', 'codex', 'agents'), { recursive: true });
  const pack = path.join(RAIZ, 'packs', 'clients', 'pack.json');
  if (fs.existsSync(pack)) put(d, 'packs/clients/pack.json', fs.readFileSync(pack, 'utf8'));
  stage(d, 'guides/advisor-rules-catalog.md', real);
  git(d, 'commit', '-q', '-m', 'catalogo');
  // una fila más, en un commit que no toca agents/ ni el catálogo: no corre
  put(d, 'guides/advisor-rules-catalog.md', real.replace(/\n## /, '\n| **ZZZ-C1** | de más | nada |\n\n## '));
  stage(d, 'scripts/lib/otra.js', '1\n');
  assert.strictEqual(run(d).rc, 0, 'sin tocar el catálogo no cuenta');
  // tocar agents/ corre el conteo sobre el catálogo del ÍNDICE (todavía el real)
  stage(d, 'agents/x.md', '# x\n');
  const ok = run(d);
  assert.strictEqual(ok.rc, 0, ok.out);
  // ahora la fila de más entra al índice
  const rows = real.match(/^\|\s*\*\*[A-Z0-9]+-[CW]\d/m);
  assert.ok(rows, 'el catálogo real tiene filas de reglas');
  put(d, 'guides/advisor-rules-catalog.md', real.replace(rows[0], `| **ZZZQ-C1** | de más | nada |\n${rows[0]}`));
  git(d, 'add', '--', 'guides/advisor-rules-catalog.md');
  const r = run(d);
  assert.strictEqual(r.rc, 1, r.out);
  assert.match(r.out, /guides\/advisor-rules-catalog\.md — conteo del catálogo de reglas: filas=\d+, esperaba \d+ — si el catálogo creció, actualizá el número en scripts\/lib\/rules-catalog-count\.js/);
});

test('StagedCiRules_Catalog_SkipIsSaid — sin padrón de revisores el conteo se saltea y lo dice, como C5', () => {
  const d = lab();
  stage(d, 'guides/advisor-rules-catalog.md', '# catálogo\n');
  const r = run(d);
  assert.strictEqual(r.rc, 0, r.out);
  assert.match(r.out, /conteo del catálogo saltado/);
});

test('StagedCiRules_CouldNotLook_IsTwo — fuera de un repo no es verde', () => {
  const d = tmpdir('staged-ci-rules-sin-git-');
  const r = spawnSync(process.execPath, [FRENO, '--repo', d], { env: { ...ENV, GIT_CEILING_DIRECTORIES: path.dirname(d) }, encoding: 'utf8' });
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /no pude mirar/);
});

test('StagedCiRules_OneLogic — las pruebas usan el módulo del freno y el hook lo llama antes del filtro', () => {
  const t1 = fs.readFileSync(path.join(__dirname, 'grep-q-pipefail.test.js'), 'utf8');
  const t2 = fs.readFileSync(path.join(__dirname, 'stable-test-data.test.js'), 'utf8');
  const t3 = fs.readFileSync(path.join(__dirname, 'rules-catalog.test.sh'), 'utf8');
  assert.match(t1, /require\('\.\.\/lib\/grep-q-pipefail\.js'\)/);
  assert.doesNotMatch(t1, /const PIPE_A_GREP_Q\s*=/, 'el patrón vive en el módulo, no en la prueba');
  assert.match(t2, /require\('\.\.\/lib\/stable-test-data\.js'\)/);
  assert.doesNotMatch(t2, /const CREA_COMMIT\s*=/, 'los patrones viven en el módulo, no en la prueba');
  assert.match(t3, /scripts\/lib\/rules-catalog-count\.js/);
  const { EXPECTED } = require('../lib/rules-catalog-count.js');
  assert.ok(!t3.includes(`"${EXPECTED.filas}"`) && !t3.includes(`"${EXPECTED.reglas}"`), 'los números del catálogo real viven en el módulo, no en la prueba');
  const hook = fs.readFileSync(path.join(RAIZ, '.githooks', 'pre-commit-checks'), 'utf8');
  const call = hook.indexOf('node "$CI_RULES" --repo "$REPO_ROOT"');
  assert.ok(call > 0, 'el hook llama al freno');
  assert.ok(call < hook.indexOf('if ! grep -qE "$RELEVANTES"'), 'antes del filtro RELEVANTES, que saltea casi todos los commits');
});
