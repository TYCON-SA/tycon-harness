'use strict';
/**
 * test-deps.test.js — lo que las pruebas de una story necesitan instalar se mira al validarla (`pipeline.js validators`).
 *
 * Lo que no se puede perder:
 *   - Un proyecto vitest sin proveedor de cobertura sale como faltante aunque la story no lo nombre: lo exige el portón
 *     de pruebas, que corre `vitest run --coverage`.
 *   - Una prueba TypeScript que usa Node, sobre un `tsconfig.json` que fija `compilerOptions.types` sin `node`, no
 *     compila aunque `@types/node` esté instalado.
 *   - Un archivo que no se puede leer dice «no medido»: nunca una lista vacía que parezca «está todo».
 *   - Un proyecto que no usa vitest ni Playwright no da ningún aviso falso.
 *   - Nada se lee fuera del repo, y un alias de `compilerOptions.paths` no es un paquete.
 *
 * 0 deps (node:test). Todo corre con carpetas temporales y un HOME de laboratorio.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const STEP_01 = path.resolve(SCRIPTS, '..', 'steps', 'step-01-validate-story.md');
const { dependenciasDePruebas } = require('../lib/test-deps.js');

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `test-deps-${p}-`)));
const HOME = tmp('home');
const escribir = (base, rel, txt) => { const f = path.join(base, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); return f; };
const pkg = (deps, extra = {}) => JSON.stringify({ name: 'proyecto-de-juguete', devDependencies: deps, ...extra }, null, 2);

/** Un repo de juguete con sus archivos y una story que declara `declarados` y trae `cuerpo` como texto. */
function repo(archivos, { declarados = [], cuerpo = '' } = {}) {
  const d = tmp('repo');
  for (const [rel, txt] of Object.entries(archivos)) escribir(d, rel, txt);
  const storyText = ['---', 'story: "9.95"', 'title: "juguete"', 'files_to_create:', ...declarados.map((f) => `  - ${f}`), '---', '',
    '# Story 9.95', '', cuerpo, ''].join('\n');
  const story = escribir(d, 'specs/story-9.95-juguete.md', storyText);
  return { d, story, storyText, declarados };
}
const correr = ({ d, storyText, declarados }) => dependenciasDePruebas({ repo: d, storyText, declared: declarados });
const paquetes = (lista) => lista.filter((x) => x.paquete).map((x) => x.paquete).sort();

test('TestDeps_VitestWithoutCoverage_Missing @story-1.15 @ac-2 — el portón exige la cobertura aunque la story no la nombre', () => {
  const r = repo({ 'package.json': pkg({ vitest: '^2.1.0' }) }, { declarados: ['src/lector.test.js'] });
  const out = correr(r);
  assert.deepEqual(paquetes(out), ['@vitest/coverage-v8']);
  assert.equal(out[0].herramienta, 'vitest');
  assert.equal(out[0].donde, 'package.json');
  assert.match(out[0].motivo, /--coverage/);
});

test('TestDeps_VitestWithIstanbul_NothingMissing @story-1.15 @ac-2 — cualquiera de los dos proveedores alcanza', () => {
  const r = repo({ 'package.json': pkg({ vitest: '^2.1.0', '@vitest/coverage-istanbul': '^2.1.0' }) }, { declarados: ['src/lector.test.js'] });
  assert.deepEqual(correr(r), []);
});

test('TestDeps_TsconfigTypesWithoutNode_Missing @story-1.15 @ac-3 — types fijado sin node: no compila aunque esté instalado', () => {
  const r = repo({
    'package.json': pkg({ vitest: '^2.1.0', '@vitest/coverage-v8': '^2.1.0', '@types/node': '^22.0.0', typescript: '^5.6.0' }),
    // con comentario y coma final, como los escribe tsc --init
    'tsconfig.json': '{\n  // tipos globales\n  "compilerOptions": { "strict": true, "types": ["vitest/globals"], },\n}\n',
    'src/lector.test.ts': "import { readFileSync } from 'node:fs';\n",
  }, { declarados: ['src/lector.test.ts'] });
  const out = correr(r);
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.equal(out[0].paquete, 'node');
  assert.equal(out[0].donde, 'tsconfig.json');
  assert.match(out[0].motivo, /compilerOptions\.types/);
});

test('TestDeps_TsconfigWithoutTypes_TypesNodeEnough @story-1.15 @ac-3 — sin types fijado, @types/node instalado alcanza', () => {
  const r = repo({
    'package.json': pkg({ vitest: '^2.1.0', '@vitest/coverage-v8': '^2.1.0', '@types/node': '^22.0.0' }),
    'tsconfig.json': '{ "compilerOptions": { "strict": true } }\n',
    'src/lector.test.ts': "import { readFileSync } from 'node:fs';\n",
  }, { declarados: ['src/lector.test.ts'] });
  assert.deepEqual(correr(r), []);
});

test('TestDeps_PlaywrightWithoutPackage_Missing @story-1.15 @ac-4 — una prueba Playwright sin @playwright/test', () => {
  const r = repo({
    'package.json': pkg({ vitest: '^2.1.0', '@vitest/coverage-v8': '^2.1.0' }),
    'e2e/flujo.spec.js': "const { test } = require('@playwright/test');\n",
  }, { declarados: ['e2e/flujo.spec.js'] });
  const out = correr(r);
  assert.deepEqual(paquetes(out), ['@playwright/test']);
  assert.equal(out[0].herramienta, 'playwright');
});

test('TestDeps_ScopedPackageNamedAndAbsent_Missing @story-1.15 @ac-5 — un @scope/paquete que la story nombra y el proyecto no tiene', () => {
  const r = repo({ 'package.json': pkg({ jest: '^29.0.0' }) }, {
    declarados: ['src/lector.test.js'],
    cuerpo: '### Tests\n\n| # | Test | Escenario |\n|---|---|---|\n| T1 | `Lector_Lee` | arma los datos con `@acme/fixtures` |\n\nMail: dev@acme.example',
  });
  const out = correr(r);
  assert.deepEqual(paquetes(out), ['@acme/fixtures']);
  assert.equal(out[0].donde, 'package.json');
});

test('TestDeps_PackageJsonPlannedAndNamed_NotMissing @story-1.15 @ac-6 — la story ya planea instalarlo', () => {
  const r = repo({ 'package.json': pkg({ vitest: '^2.1.0' }) }, {
    declarados: ['src/lector.test.js', 'package.json'],
    cuerpo: 'Se suma `@vitest/coverage-v8` a las devDependencies.',
  });
  assert.deepEqual(correr(r), []);
  // el package.json declarado SIN nombrar el paquete no alcanza
  const r2 = repo({ 'package.json': pkg({ vitest: '^2.1.0' }) }, { declarados: ['src/lector.test.js', 'package.json'] });
  assert.deepEqual(paquetes(correr(r2)), ['@vitest/coverage-v8']);
});

test('TestDeps_UnreadablePackageJson_NotMeasured @story-1.15 @ac-7 — un archivo ilegible dice «no medido», nunca lista vacía', () => {
  const r = repo({
    'package.json': '{ "devDependencies": { "vitest": ',
    'tsconfig.json': '{ "compilerOptions": { "types": [ ',
    'src/lector.test.ts': "import { readFileSync } from 'node:fs';\n",
  }, { declarados: ['src/lector.test.ts'] });
  const out = correr(r);
  const noMedidos = out.filter((x) => x.no_medido).map((x) => x.no_medido);
  assert.equal(noMedidos.length, 2, JSON.stringify(out));
  assert.ok(noMedidos.some((t) => /^no medido: package\.json, /.test(t)), noMedidos.join(' | '));
  assert.ok(noMedidos.some((t) => /^no medido: tsconfig\.json, /.test(t)), noMedidos.join(' | '));
});

test('TestDeps_NearestPackageJsonWins @story-1.15 @ac-1 — un package.json por formulario: manda el más cercano', () => {
  const r = repo({
    'package.json': pkg({ vitest: '^2.1.0', '@vitest/coverage-v8': '^2.1.0' }),
    'form-a/package.json': pkg({ vitest: '^2.1.0' }),
  }, { declarados: ['form-a/src/lector.test.js'] });
  const out = correr(r);
  assert.deepEqual(paquetes(out), ['@vitest/coverage-v8']);
  assert.equal(out[0].donde, path.join('form-a', 'package.json'));
});

test('TestDeps_NoVitestNoPlaywright_NoFalseAlarm @story-1.15 @ac-12 — node --test en JS: nada que avisar', () => {
  const r = repo({
    'package.json': pkg({}, { scripts: { test: 'node --test' } }),
    'tests/lector.test.js': "const test = require('node:test');\nconst fs = require('node:fs');\n",
  }, { declarados: ['tests/lector.test.js', 'lib/lector.js'], cuerpo: 'Las pruebas usan `node:test` y `process.env`; Playwright queda fuera de alcance.' });
  assert.deepEqual(correr(r), []);
});

/** `pipeline.js validators` de verdad, sin paquetes de revisores (carpetas vacías). */
function validators(story, d) {
  const vacio = tmp('vacio');
  const res = spawnSync(process.execPath, [PIPELINE, 'validators', '--story', story, '--repo', d], {
    encoding: 'utf8', timeout: 60000,
    env: { PATH: process.env.PATH, HOME, USERPROFILE: HOME, LANG: 'en_US.UTF-8', TYCON_SESSION_ID: 'test-deps', TYCON_PACKS_DIR: vacio, TYCON_AGENTS_DIR: vacio, TYCON_GUIDES_DIR: vacio },
  });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch (_e) { /* el caso mira la salida */ }
  return { ...res, json };
}

test('TestDeps_ValidatorsOutput_HasFieldAndKeepsFields @story-1.15 @ac-1 @ac-11 — el campo está también sin faltantes', () => {
  const r = repo({ 'package.json': pkg({ vitest: '^2.1.0', '@vitest/coverage-v8': '^2.1.0' }) }, { declarados: ['src/lector.test.js'] });
  const v = validators(r.story, r.d);
  assert.equal(v.status, 0, v.stderr);
  assert.deepEqual(v.json.dependencias_de_pruebas, []);
  for (const k of ['story', 'repo', 'validadores', 'lanzamientos', 'packs', 'packs_dir', 'packs_nota', 'contexto']) assert.ok(k in v.json, `falta ${k}`);
  assert.deepEqual(v.json.validadores, ['tycon-story-validator']);
  // los valores de hoy, sin paquetes: nada que lanzar, ningún paquete, y los archivos declarados en el contexto
  assert.deepEqual(v.json.lanzamientos, []);
  assert.deepEqual(v.json.packs, []);
  assert.deepEqual(v.json.contexto.files, ['src/lector.test.js']);
});

test('TestDeps_RealCase_ThreeMissing @story-1.15 @ac-9 — el caso del 2026-10-01, con nombres inventados', () => {
  // Un producto con vitest y Playwright: la story arma pruebas nuevas y el proyecto no declara ni la cobertura, ni
  // los tipos de Node, ni Playwright.
  const r = repo({
    'package.json': pkg({ vitest: '^2.1.0', typescript: '^5.6.0' }),
    'tsconfig.json': '{ "compilerOptions": { "strict": true } }\n',
  }, {
    declarados: ['src/__tests__/exportador.test.ts', 'e2e/exportar.spec.ts', 'src/exportador.ts'],
    cuerpo: [
      '### Tests', '',
      '| # | Test | Escenario |', '|---|---|---|',
      '| T1 | `Exportador_EscribeElArchivo` | escribe con `node:fs` en una carpeta temporal |',
      '| T2 | `Exportar_DesdeLaPantalla` | Playwright: botón Exportar, descarga el archivo |',
    ].join('\n'),
  });
  const v = validators(r.story, r.d);
  assert.equal(v.status, 0, v.stderr);
  assert.deepEqual(paquetes(v.json.dependencias_de_pruebas), ['@playwright/test', '@types/node', '@vitest/coverage-v8']);
});

test('TestDeps_Step01_NamesValW18 @story-1.15 @ac-8 — el paso 1 suma los faltantes como VAL-W18 y pausa', () => {
  const txt = fs.readFileSync(STEP_01, 'utf8');
  assert.match(txt, /dependencias_de_pruebas/);
  assert.match(txt, /VAL-W18/);
  assert.match(txt, /VAL-W18[\s\S]{0,400}(pausa|WARNING)/);
  assert.match(txt, /no medido/);
});

// ── Bordes: lecturas, detección y formatos de archivo ────────────────────────────────────────────────────────────────

test('TestDeps_DeclaredOutsideRepo_NotMeasuredNotRead @story-1.15 @ac-7 — una ruta que sale del repo no se lee', () => {
  const afuera = tmp('afuera');
  escribir(afuera, 'package.json', pkg({ vitest: '^2.1.0' }));
  escribir(afuera, 'x.test.ts', "import fs from 'node:fs';\n");
  const r = repo({ 'package.json': pkg({ jest: '^29.0.0' }) }, { declarados: [`../${path.basename(afuera)}/x.test.ts`, path.join(afuera, 'x.test.ts')] });
  const out = correr(r);
  assert.equal(paquetes(out).length, 0, JSON.stringify(out));
  assert.equal(out.filter((x) => /fuera del repo/.test(x.no_medido || '')).length, 2, JSON.stringify(out));
  // un hermano con el mismo prefijo (`repo2` junto a `repo`) tampoco cuenta como «dentro»
  const hermano = `${r.d}2`;
  escribir(hermano, 'package.json', pkg({ vitest: '^2.1.0' }));
  assert.deepEqual(correr({ ...r, declarados: [`../${path.basename(hermano)}/a.test.js`] }).filter((x) => x.paquete), []);
});

test('TestDeps_UnreadableTestFile_NotMeasured @story-1.15 @ac-7 — una prueba que existe y no se lee no es «todo bien»', () => {
  const r = repo({ 'package.json': pkg({ jest: '^29.0.0' }) }, { declarados: ['tests/a.test.ts'], cuerpo: '### Tests\n\nusa `node:fs`' });
  fs.mkdirSync(path.join(r.d, 'tests', 'a.test.ts'), { recursive: true });   // existe, y leerlo falla
  const out = correr(r);
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.match(out[0].no_medido, /^no medido: tests\/a\.test\.ts, /);
});

test('TestDeps_NodeBuiltinsWithoutPrefix_Detected @story-1.15 @ac-3 — fs/promises, crypto, Buffer y process.platform son Node', () => {
  for (const uso of ["import { readFile } from 'fs/promises';", "import c from 'crypto';", "Buffer.from('a');", 'process.platform;', '__filename;']) {
    const r = repo({ 'package.json': pkg({ jest: '^29.0.0' }), 'src/a.test.ts': `${uso}\n` }, { declarados: ['src/a.test.ts'] });
    assert.deepEqual(paquetes(correr(r)), ['@types/node'], uso);
  }
});

test('TestDeps_PathAliasAndProse_NotPackages @story-1.15 @ac-5 — un alias de paths o la prosa suelta no son paquetes', () => {
  const r = repo({
    'package.json': pkg({ jest: '^29.0.0' }),
    'tsconfig.json': '{ "compilerOptions": { "paths": { "@components/*": ["src/components/*"] } } }\n',
  }, {
    declarados: ['src/a.test.js'],
    cuerpo: "### Tests\n\nver @scope/pkg-name. y (@a/b)\n\n```ts\nimport { B } from '@components/Button';\nimport { f } from '@acme/real/sub';\n```",
  });
  assert.deepEqual(paquetes(correr(r)), ['@acme/real']);
});

test('TestDeps_PackageJsonCreatedByStory_Counts @story-1.15 @ac-6 — el package.json que la story crea es el que manda', () => {
  const r = repo({ 'package.json': pkg({}) }, {
    declarados: ['forms/x/package.json', 'forms/x/tests/a.test.ts'],
    cuerpo: '### Tests\n\nla prueba usa `process.env`; el package.json nuevo trae `@types/node`',
  });
  assert.deepEqual(correr(r), []);
  // sin nombrarlo, sale contra el package.json que se crea
  const r2 = repo({}, { declarados: ['forms/x/package.json', 'forms/x/tests/a.test.ts'], cuerpo: '### Tests\n\nusa `process.env`' });
  const out = correr(r2);
  assert.deepEqual(paquetes(out), ['@types/node']);
  assert.equal(out[0].donde, path.join('forms', 'x', 'package.json'));
});

test('TestDeps_CypressE2e_NotPlaywright @story-1.15 @ac-4 @ac-12 — una prueba de e2e/ con Cypress no pide Playwright', () => {
  const r = repo({ 'package.json': pkg({ cypress: '^13.0.0' }), 'e2e/a.cy.spec.js': "describe('x', () => cy.visit('/'));\n" }, { declarados: ['e2e/a.cy.spec.js'] });
  assert.deepEqual(correr(r), []);
  const r2 = repo({ 'package.json': pkg({ cypress: '^13.0.0' }) }, { declarados: ['e2e/b.spec.js'], cuerpo: '### Tests\n\nCon Cypress, no con Playwright.' });
  assert.deepEqual(correr(r2), []);
});

test('TestDeps_BomAndCommaInString_Read @story-1.15 @ac-7 — un BOM (PowerShell) o una coma en un string se leen bien', () => {
  const r = repo({
    'package.json': `﻿${pkg({ vitest: '^2.1.0', '@vitest/coverage-v8': '^2.1.0', '@types/node': '^22.0.0' })}`,
    'tsconfig.json': '﻿{ "compilerOptions": { "types": ["vitest/globals", "node"], "outDir": "a,}" }, }\n',
    'src/a.test.ts': "import fs from 'node:fs';\n",
  }, { declarados: ['src/a.test.ts'] });
  assert.deepEqual(correr(r), []);
  const { parseJsonc } = require('../lib/test-deps.js');
  assert.equal(parseJsonc('{ "a": "x,}" , }').a, 'x,}');
});

test('TestDeps_ExtendsTypesWithoutNode_Missing @story-1.15 @ac-3 — types heredado por extends también cuenta', () => {
  const r = repo({
    'package.json': pkg({ '@types/node': '^22.0.0' }),
    'tsconfig.base.json': '{ "compilerOptions": { "types": ["jest"] } }\n',
    'tsconfig.json': '{ "extends": "./tsconfig.base", "compilerOptions": { "strict": true } }\n',
    'src/a.test.ts': "import fs from 'node:fs';\n",
  }, { declarados: ['src/a.test.ts'] });
  const out = correr(r);
  assert.deepEqual(out.map((x) => [x.paquete, x.donde]), [['node', 'tsconfig.json']]);
});

test('TestDeps_OtherRepoPrefix_Skipped @story-1.15 @ac-1 — los archivos «(otro-repo) ruta» no se resuelven contra éste', () => {
  const { dependenciasDePruebas: dp } = require('../lib/test-deps.js');
  const d = tmp('prefijo');
  escribir(d, 'package.json', pkg({ vitest: '^2.1.0' }));
  const storyText = '---\nfiles_to_create:\n  - "(agent-skills) skills/x/tests/a.test.js"\n---\n';
  assert.deepEqual(dp({ repo: d, storyText }), []);
  // el mismo archivo sin prefijo sí cuenta
  assert.deepEqual(paquetes(dp({ repo: d, storyText: '---\nfiles_to_create:\n  - skills/x/tests/a.test.js\n---\n' })), ['@vitest/coverage-v8']);
});

test('TestDeps_ScopedDeclared_NotMissing @story-1.15 @ac-5 — el @scope/paquete que el proyecto declara no sale', () => {
  const r = repo({ 'package.json': pkg({ '@acme/fixtures': '1.0.0' }) }, { declarados: ['src/a.test.js'], cuerpo: '### Tests\n\ncon `@acme/fixtures`' });
  assert.deepEqual(correr(r), []);
});

test('TestDeps_NoPackageJson_SaysThereIsNone @story-1.15 @ac-4 — sin package.json, el faltante lo dice', () => {
  const r = repo({ 'e2e/a.spec.js': "const { test } = require('@playwright/test');\n" }, { declarados: ['e2e/a.spec.js'] });
  const out = correr(r);
  assert.deepEqual(out.map((x) => [x.paquete, x.donde]), [['@playwright/test', 'package.json (no hay)']]);
});

test('TestDeps_TsconfigBrokenOnly_NotMeasured @story-1.15 @ac-7 — package.json sano y tsconfig roto: «no medido» del tsconfig', () => {
  const r = repo({
    'package.json': pkg({ '@types/node': '^22.0.0' }),
    'tsconfig.json': '{ "compilerOptions": ',
    'src/a.test.ts': "import fs from 'node:fs';\n",
  }, { declarados: ['src/a.test.ts'] });
  const out = correr(r);
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.match(out[0].no_medido, /^no medido: tsconfig\.json, /);
});

test('TestDeps_BrokenTable_NotMeasured @story-1.15 @ac-7 — la tabla rota da «no medido», no tira abajo validators', () => {
  const copia = tmp('tabla');
  fs.copyFileSync(path.join(SCRIPTS, 'lib', 'test-deps.js'), path.join(copia, 'test-deps.js'));
  fs.writeFileSync(path.join(copia, 'test-deps.json'), '{ "rules": [ ');
  const r = repo({ 'package.json': pkg({ vitest: '^2.1.0' }) }, { declarados: ['src/a.test.js'] });
  const res = spawnSync(process.execPath, ['-e',
    `const m=require(${JSON.stringify(path.join(copia, 'test-deps.js'))});process.stdout.write(JSON.stringify(m.dependenciasDePruebas({repo:${JSON.stringify(r.d)},storyText:'',declared:['src/a.test.js']})))`],
  { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.length, 1);
  assert.match(out[0].no_medido, /test-deps\.json/);
});
