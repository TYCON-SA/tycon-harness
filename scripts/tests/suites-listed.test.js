'use strict';
/**
 * suites-listed.test.js — todo archivo de prueba del arnés corre por la lista, o está excluido con su motivo.
 *
 * POR QUÉ: la CI y el nocturno corren sólo lo que dice scripts/tests/suites.json. Una prueba que nace afuera de la lista
 * no la corre nadie más que quien la abre a mano: 23 suites del pipeline quedaron así, y dos estaban rojas sin que nadie
 * lo supiera. Una suite partida (`<suite>.pN.test.*`, scripts/tests/lib/suite-parts.js) cuenta como listada por sus
 * partes. Lo que no corre por la lista va en scripts/tests/suites-unlisted.json con su motivo.
 *
 * Qué es un archivo de prueba: `*.test.js`, `*.test.sh`, `*-test.js`, `*-test.sh`, `test-*.js` o `test-*.sh` dentro de
 * una carpeta `tests/`,
 * sin contar `fixtures/` ni `lib/` (datos y ayudantes de las pruebas, no suites).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SUITE = /^(?:.+[.-]test\.(?:js|sh)|test-.+\.(?:js|sh))$/;
const PART = /^(.+)\.p\d+\.test\.(js|sh)$/;
const NOT_SUITES = new Set(['fixtures', 'lib', 'node_modules', '.git']);

/** ¿Es un reemplazo generado por legacy-names.js --write-shims? La marca va en las primeras líneas. */
function esAtajo(abs) {
  let cabeza = '';
  try { const fd = fs.openSync(abs, 'r'); const b = Buffer.alloc(400); const n = fs.readSync(fd, b, 0, 400, 0); fs.closeSync(fd); cabeza = b.toString('utf8', 0, n); } catch { return false; }
  return /^(?:#|\/\/) tycon-legacy-shim: /m.test(cabeza);
}

/** Los archivos de prueba de `root` (rutas relativas, con `/`), en `scripts/` y `skills/`. */
function testFiles(root) {
  const out = [];
  const walk = (dir, enTests) => {
    let ents;
    // una carpeta que no está (un árbol sin skills/) no tiene pruebas; cualquier otro error se dice: callarlo daría verde
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const e of ents) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (!NOT_SUITES.has(e.name)) walk(abs, enTests || e.name === 'tests'); continue; }
      // un atajo generado de un nombre viejo (marca tycon-legacy-shim) no es otra suite: la de verdad corre con su nombre nuevo
      if (enTests && SUITE.test(e.name) && !esAtajo(abs)) out.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  };
  for (const top of ['scripts', 'skills']) walk(path.join(root, top), false);
  return out.sort();
}

/** Las rutas de suites.json, relativas a la raíz del repo (`arnes` = scripts/, `agent-skills` = skills/). */
function listedPaths(suites) {
  return new Set([...(suites.diarias || []), ...(suites.semanales || [])].map((e) => `${e.raiz === 'agent-skills' ? 'skills' : 'scripts'}/${e.ruta}`));
}

/** Lo que está mal: archivos que no corre nadie, exclusiones sin motivo, de algo que no existe o de algo listado. */
function unlistedProblems(root, suites, unlisted) {
  const listed = listedPaths(suites);
  const excluded = (unlisted && unlisted.suites) || {};
  const files = testFiles(root);
  const onDisk = new Set(files);
  const out = [];
  for (const f of files) {
    if (listed.has(f) || excluded[f]) continue;
    if (PART.test(path.basename(f))) continue;   // una parte suelta la mira suite-parts.test.js
    const m = f.match(/^(.+)\.test\.(js|sh)$/);
    if (m && listed.has(`${m[1]}.p1.test.${m[2]}`)) continue;   // partida: corre por sus partes
    out.push(`${f}: no está en scripts/tests/suites.json ni en suites-unlisted.json — no la corre la CI ni el nocturno`);
  }
  for (const [f, spec] of Object.entries(excluded)) {
    if (!spec || typeof spec.why !== 'string' || !spec.why.trim()) out.push(`${f}: excluida sin motivo (\`why\`)`);
    if (!onDisk.has(f)) out.push(`${f}: excluida y no existe`);
    if (listed.has(f)) out.push(`${f}: excluida y también en suites.json`);
  }
  return out;
}

const leer = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

/** Un árbol de juguete con la forma del arnés. */
function juguete(archivos) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'suites-listed-'));
  for (const [rel, txt] of Object.entries(archivos)) {
    fs.mkdirSync(path.dirname(path.join(raiz, rel)), { recursive: true });
    fs.writeFileSync(path.join(raiz, rel), txt);
  }
  return raiz;
}
const SUITES_JUGUETE = { diarias: [{ raiz: 'arnes', ruta: 'tests/a.test.js', requiere: [] }, { raiz: 'agent-skills', ruta: 'p/scripts/tests/b.test.js', requiere: [] }, { raiz: 'arnes', ruta: 'tests/c.p1.test.js', requiere: [] }], semanales: [] };
const BASE = {
  'scripts/tests/a.test.js': '', 'skills/p/scripts/tests/b.test.js': '', 'scripts/tests/c.test.js': '', 'scripts/tests/c.p1.test.js': '',
  'scripts/tests/fixtures/x/y.test.js': '', 'scripts/tests/lib/helper.test.js': '',
};

test('T1 SuitesListed_EveryTestFileListedOrExcluded @story-7.35 @ac-3 @ac-4 — en el árbol real, nada queda sin correr', () => {
  // un árbol que no se pudo recorrer daría verde sin mirar nada: el arnés tiene cientos de archivos de prueba
  assert.ok(testFiles(ROOT).length > 300, `encontré sólo ${testFiles(ROOT).length} archivos de prueba`);
  const problems = unlistedProblems(ROOT, leer('scripts/tests/suites.json'), leer('scripts/tests/suites-unlisted.json'));
  assert.deepStrictEqual(problems, [], problems.join('\n'));
});

test('T2 SuitesListed_NewUnlistedFile_IsRed @story-7.35 @ac-4 — un archivo de prueba nuevo fuera de la lista se nombra', () => {
  const sano = juguete(BASE);
  assert.deepStrictEqual(unlistedProblems(sano, SUITES_JUGUETE, { suites: {} }), [], 'listadas, partidas, fixtures y lib: nada que decir');
  const nuevo = juguete({ ...BASE, 'skills/p/scripts/tests/test-nueva.js': '', 'scripts/tests/d.test.sh': '', 'skills/p/scripts/tests/humo-test.sh': '', 'scripts/tests/smokes-1.2.sh': '' });
  const p = unlistedProblems(nuevo, SUITES_JUGUETE, { suites: {} });
  // `*-test.sh` también es una suite (pase adversarial: dod-hook-smoke-test.sh no la corría nadie); un humo de story no
  assert.strictEqual(p.length, 3, p.join('\n'));
  assert.match(p.join('\n'), /humo-test\.sh: no está/);
  assert.match(p.join('\n'), /skills\/p\/scripts\/tests\/test-nueva\.js: no está/);
  assert.match(p.join('\n'), /scripts\/tests\/d\.test\.sh: no está/);
});

test('T3 SuitesListed_ExclusionWithoutReason_IsRed @story-7.35 @ac-4 — una exclusión sin motivo no vale', () => {
  const raiz = juguete({ ...BASE, 'scripts/tests/d.test.sh': '' });
  assert.deepStrictEqual(unlistedProblems(raiz, SUITES_JUGUETE, { suites: { 'scripts/tests/d.test.sh': { why: 'la corre otro pipeline' } } }), []);
  const p = unlistedProblems(raiz, SUITES_JUGUETE, { suites: { 'scripts/tests/d.test.sh': { why: '  ' } } });
  assert.deepStrictEqual(p, ['scripts/tests/d.test.sh: excluida sin motivo (`why`)']);
});

test('T4 SuitesListed_ExclusionGhostOrListed_IsRed @story-7.35 @ac-4 — excluir algo que no existe o que ya está listado', () => {
  const raiz = juguete(BASE);
  const p = unlistedProblems(raiz, SUITES_JUGUETE, { suites: {
    'scripts/tests/fantasma.test.js': { why: 'x' },
    'scripts/tests/a.test.js': { why: 'x' },
  } });
  assert.deepStrictEqual(p.sort(), ['scripts/tests/a.test.js: excluida y también en suites.json', 'scripts/tests/fantasma.test.js: excluida y no existe']);
});
