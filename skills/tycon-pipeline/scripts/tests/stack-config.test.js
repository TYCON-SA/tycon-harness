'use strict';

/**
 * stack-config.test.js — la clave `stack` de la organización, leída desde el `team-repos.json` del árbol del arnés.
 *
 * Lo que sostiene: sin `stack`, todo sale de fábrica y sin problemas; con `stack.code_extensions`, la ampliación llega a
 * quien pregunta; mal escrita, no se usa y queda dicho; un árbol sin archivo, o un archivo roto, nunca tira.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIB = path.resolve(__dirname, '..', 'lib');
const { readStack, codeExtensions, orgRules } = require(path.join(LIB, 'stack-config.js'));

function arbol(stack, { roto = false } = {}) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stack-cfg-')));
  fs.mkdirSync(path.join(d, 'scripts'));
  fs.writeFileSync(path.join(d, 'scripts', 'install-tycon-hooks.sh'), '#!/bin/bash\n');
  if (roto) { fs.writeFileSync(path.join(d, 'team-repos.json'), '{roto'); return d; }
  if (stack === null) return d;
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
const env = (dir) => ({ TYCON_GUIDES_DIR: dir });
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-cfg-home-'));

test('@story-8.48 @ac-16 @ac-33 T5 StackConfig_NoStackKey_Defaults', () => {
  for (const d of [arbol(undefined), arbol(null)]) {
    const r = readStack({ env: env(d), home: HOME });
    assert.deepEqual(r.stack, {}, 'sin clave: nada declarado');
    assert.deepEqual(r.problems, []);
    assert.deepEqual(codeExtensions({ env: env(d), home: HOME }), { extra: [], problems: [] });
  }
});

test('@story-8.48 @ac-2 StackConfig_CodeExtensions_Reach', () => {
  const r = codeExtensions({ env: env(arbol({ code_extensions: ['.gd', '.ex'] })), home: HOME });
  assert.deepEqual(r, { extra: ['.gd', '.ex'], problems: [] });
});

test('@story-8.48 @ac-6 StackConfig_CodeExtensions_Invalid_NotUsedAndSaid', () => {
  const r = codeExtensions({ env: env(arbol({ code_extensions: ['GD'] })), home: HOME });
  assert.deepEqual(r.extra, []);
  assert.ok(r.problems.some((p) => /stack\.code_extensions/.test(p)), JSON.stringify(r.problems));
});

test('@story-8.48 @ac-6 StackConfig_BrokenFile_NeverThrows', () => {
  const r = codeExtensions({ env: env(arbol(null, { roto: true })), home: HOME });
  assert.deepEqual(r.extra, []);
  assert.ok(r.problems.length > 0, 'el archivo roto deja el motivo');
  const sinArbol = codeExtensions({ env: { TYCON_GUIDES_DIR: path.join(HOME, 'no-existe') }, home: HOME });
  assert.deepEqual(sinArbol.extra, []);
});

test('@story-8.48 @ac-6 StackConfig_SameExtensionShape_BothReaders', () => {
  // el lector de las máquinas (scripts/lib/team-repos.js) no carga el skill: tiene su copia de la forma y del vocabulario
  const team = require(path.resolve(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'team-repos.js'));
  const { EXT_RE } = require(path.join(LIB, 'code-files.js'));
  assert.equal(String(team.STACK_EXT_RE), String(EXT_RE));
  assert.deepEqual(team.STACK_KEYS, ['code_extensions', 'test_runners', 'rules']);
  // una terminación mala no apaga el archivo: sale aparte y la sección queda sin esa subclave
  const base = { version: 1, public: { platform: 'github', org: 'acme', repo: 'h' }, profile: { platform: 'github', org: 'acme', repo: 'p' }, operations: { platform: 'github', org: 'acme', repo: 'o' } };
  const r = team.parse(JSON.stringify({ ...base, stack: { code_extensions: ['GD'] } }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.stack, {});
  assert.match(r.sectionProblems.stack[0].path, /^stack\.code_extensions/);
  const bien = team.parse(JSON.stringify({ ...base, stack: { code_extensions: ['.gd'] } }));
  assert.deepEqual(bien.data.stack, { code_extensions: ['.gd'] });
  assert.equal(bien.sectionProblems, undefined);
  // una regla mal escrita sale aparte y las demás reglas quedan
  const reglas = team.parse(JSON.stringify({ ...base, stack: { rules: { test_names: 'camel', ui_language: 'es', otra: 1 } } }));
  assert.equal(reglas.ok, true);
  assert.deepEqual(reglas.data.stack, { rules: { ui_language: 'es' } });
  assert.deepEqual(reglas.sectionProblems.stack.map((p) => p.path).sort(), ['stack.rules.otra', 'stack.rules.test_names']);
});

test('@story-8.48 @ac-16 StackConfig_Rules_DefaultsWithoutConfig', () => {
  // sin árbol, sin archivo o sin `stack`: las reglas de fábrica, y nunca tira
  for (const e of [{ TYCON_GUIDES_DIR: path.join(HOME, 'no-existe') }, env(arbol(null)), env(arbol(undefined))]) {
    const r = orgRules({ env: e, home: HOME });
    assert.deepEqual(r.rules, {
      test_names: { value: 'any', source: 'por_defecto' },
      screen_test: { value: 'ui', source: 'por_defecto' },
      ui_language: { value: null, source: 'por_defecto' },
    });
  }
  const roto = orgRules({ env: env(arbol(undefined, { roto: true })), home: HOME });
  assert.equal(roto.rules.test_names.value, 'any');
  assert.ok(roto.problems.length > 0);
});
