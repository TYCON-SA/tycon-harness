'use strict';

/**
 * org-rules.test.js — las reglas de la organización (`stack.rules` del `team-repos.json` del árbol del arnés): cómo se
 * nombran las pruebas, qué cuenta como pantalla para la prueba E2E obligatoria, y en qué idioma tiene que estar la app.
 *
 * Lo que sostiene: sin reglas, nada tiene la forma de un equipo en particular (cualquier nombre, cualquier pantalla, sin
 * juzgar el idioma); una regla mal escrita cae a su valor por defecto y lo dice; con las reglas de un equipo que hoy
 * nombra en PascalCase y escribe en castellano, todo queda como hoy. Y ninguna instrucción vuelve a fijar PascalCase ni
 * React como regla.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const ROOT = path.resolve(SCRIPTS, '..', '..', '..');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'org-rules-home-'));

function tree(stack) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'org-rules-')));
  fs.mkdirSync(path.join(d, 'scripts'));
  fs.writeFileSync(path.join(d, 'scripts', 'install-tycon-hooks.sh'), '#!/bin/bash\n');
  const team = {
    version: 1,
    public: { platform: 'github', org: 'acme', repo: 'harness' },
    profile: { platform: 'github', org: 'acme', repo: 'team-profile' },
    operations: { platform: 'github', org: 'acme', repo: 'team-operations' },
    ...(stack === undefined ? {} : { stack }),
  };
  fs.writeFileSync(path.join(d, 'team-repos.json'), JSON.stringify(team));
  return d;
}

function run(args, dir) {
  const env = { ...process.env, HOME, TYCON_GUIDES_DIR: dir };
  return spawnSync(process.execPath, [PIPELINE, ...args], { encoding: 'utf8', env });
}

function orgRules(dir) {
  const r = run(['org-rules'], dir);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('@story-8.48 @ac-16 T18 OrgRules_PrintsValueAndSource', () => {
  const declared = orgRules(tree({ rules: { test_names: 'snake', screen_test: 'react', ui_language: 'pt-BR' } }));
  assert.deepEqual(declared.rules, {
    test_names: { value: 'snake', source: 'organizacion' },
    screen_test: { value: 'react', source: 'organizacion' },
    ui_language: { value: 'pt-BR', source: 'organizacion' },
  });
  assert.deepEqual(declared.problems, []);

  const none = orgRules(tree(undefined));
  assert.deepEqual(none.rules, {
    test_names: { value: 'any', source: 'por_defecto' },
    screen_test: { value: 'ui', source: 'por_defecto' },
    ui_language: { value: null, source: 'por_defecto' },
  });

  // una regla mal escrita cae a su valor por defecto, lo dice, y las demás siguen
  const bad = orgRules(tree({ rules: { test_names: 'camel', ui_language: 'es' } }));
  assert.deepEqual(bad.rules.test_names, { value: 'any', source: 'por_defecto' });
  assert.deepEqual(bad.rules.ui_language, { value: 'es', source: 'organizacion' });
  assert.ok(bad.problems.some((p) => /stack\.rules\.test_names/.test(p)), JSON.stringify(bad.problems));
});

test('@story-8.48 @ac-20 T19 OrgRules_TyconProfile_KeepsToday', () => {
  // copia inventada del perfil de un equipo que hoy nombra en PascalCase y escribe la app en castellano
  const r = orgRules(tree({ rules: { test_names: 'pascal', ui_language: 'es' } }));
  assert.equal(r.rules.test_names.value, 'pascal');
  assert.equal(r.rules.screen_test.value, 'ui');
  assert.equal(r.rules.ui_language.value, 'es');
  // con esas reglas el pedido al lector de legibilidad sigue pidiendo castellano, como hoy
  const brief = run(['readability-brief'], tree({ rules: { test_names: 'pascal', ui_language: 'es' } }));
  assert.equal(brief.status, 0, brief.stderr);
  assert.match(brief.stdout, /castellano/);
});

test('@story-8.48 @ac-17 @ac-18 @ac-21 T22 Prompts_NoFixedPascalOrReact', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const files = {
    validator: read('agents/tycon-story-validator.md'),
    catalog: read('guides/advisor-rules-catalog.md'),
    template: read('skills/tycon-create-story/template.md'),
    checklist: read('skills/tycon-create-story/checklist.md'),
    storyFormat: read('story-format.md'),
    coverage: read('agents/tycon-ac-coverage-checker.md'),
    step01: read('skills/tycon-pipeline/steps/step-01-validate-story.md'),
  };
  // PascalCase sólo aparece atado a la regla de la organización, nunca como exigencia fija para una prueba (el nombre
  // de un componente de React es otra cosa: lo revisan los revisores de ese stack)
  for (const [name, text] of Object.entries(files)) {
    for (const line of text.split('\n')) {
      if (/PascalCase/.test(line) && !/REACT-W8|componente/.test(line)) {
        assert.match(line, /test_names|pascal/, `${name}: «${line.trim()}»`);
      }
    }
    assert.doesNotMatch(text, /componentes React \(archivos `\.tsx`\)|React stories have/, name);
  }
  assert.match(files.validator, /test_names/);
  assert.match(files.catalog, /VAL-W3[^\n]*test_names/);
  assert.match(files.step01, /org-rules/);
  for (const name of ['template', 'checklist', 'storyFormat']) assert.match(files[name], /screen_test/, name);
  assert.match(files.storyFormat, /\.svelte/);
  assert.match(files.storyFormat, /@pytest\.mark\.story/);
  assert.match(files.coverage, /test_\*\.py/);
  assert.match(files.coverage, /_test\.go/);
});

test('@story-8.48 @ac-18 T22a ScreenRule_DecidesWhatNeedsE2E', () => {
  const { applyScreenRule } = require(path.join(SCRIPTS, 'lib', 'ui-signal.js'));
  const story = (files) => `---\nstory: "9.9"\nfiles_to_modify:\n${files.map((f) => `  - ${f}`).join('\n')}\n---\n# x\n`;
  const svelte = story(['src/routes/Cart.svelte']);
  const tsx = story(['src/Cart.tsx']);
  const back = story(['api/app.py']);
  // ui (de fábrica): toda pantalla pide su E2E
  assert.equal(applyScreenRule(svelte, null, 'ui').ui, true);
  assert.equal(applyScreenRule(tsx, null, 'ui').ui, true);
  assert.equal(applyScreenRule(back, null, 'ui').ui, false);
  // react: sólo .tsx/.jsx
  assert.equal(applyScreenRule(svelte, null, 'react').ui, false);
  assert.match(applyScreenRule(svelte, null, 'react').note, /screen_test: react/);
  assert.equal(applyScreenRule(tsx, null, 'react').note, null);
  assert.equal(applyScreenRule(tsx, null, 'react').ui, true);
  // una pantalla señalada por algo que no es su extensión (por ejemplo el cuerpo de la story) sigue pidiendo E2E con
  // react: la regla sólo saca las que nombran nada más que .svelte o .vue
  const body = `---\nstory: "9.9"\n---\n# x\n\n### Tests\n\n| E1 | \`E2E_Cart\` | 1 | e2e | tests/e2e/cart.spec.ts | ok |\n`;
  assert.equal(applyScreenRule(body, null, 'react').ui, applyScreenRule(body, null, 'ui').ui);
  // off: no se exige, y lo dice
  const off = applyScreenRule(tsx, null, 'off');
  assert.equal(off.ui, false);
  assert.match(off.note, /screen_test: off/);
  assert.equal(applyScreenRule(back, null, 'off').note, null);
});

test('@story-8.48 @ac-19 T23 Step07c_Readability_LanguageFromOrg', () => {
  const withLang = run(['readability-brief'], tree({ rules: { ui_language: 'es' } }));
  assert.equal(withLang.status, 0, withLang.stderr);
  assert.match(withLang.stdout, /castellano/);
  const ui = run(['readability-brief', '--scope', 'ui'], tree({ rules: { ui_language: 'en' } }));
  assert.match(ui.stdout, /inglés/);
  const none = run(['readability-brief'], tree(undefined));
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /no juzgues el idioma/);
  assert.doesNotMatch(none.stdout, /castellano/);
  assert.match(none.stdout, /no declaró el idioma/);
  // un idioma mal escrito no se lee como «sin declarar»: el pedido lo dice y el problema sale por stderr
  const bad = run(['readability-brief'], tree({ rules: { ui_language: 'castellano' } }));
  assert.equal(bad.status, 0, bad.stderr);
  assert.match(bad.stdout, /no se pudo leer/);
  assert.doesNotMatch(bad.stdout, /no declaró/);
  assert.match(bad.stderr, /stack\.rules\.ui_language/);
  // un --scope desconocido frena en vez de tomarse como la guía
  assert.equal(run(['readability-brief', '--scope', 'iu'], tree(undefined)).status, 2);
  // la instrucción del paso 7c manda a usar ese pedido
  const step = fs.readFileSync(path.join(SCRIPTS, '..', 'steps', 'step-07c-dod-runtime-gate.md'), 'utf8');
  assert.match(step, /readability-brief/);
});
