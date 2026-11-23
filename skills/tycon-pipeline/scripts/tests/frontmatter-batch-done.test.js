#!/usr/bin/env node
'use strict';
// frontmatter-batch-done.test.js — el control de la escritura de una historia (on-frontmatter-write.js) pide la
// evidencia en vivo cuando una tanda del bloque pipelines pasa a done. La tanda que pasa a done se lee por su nombre con
// el lector de tandas: `status: "done"` y `Done` cuentan, y ni un done ajeno que se va ni un done que cambia de tanda la
// esconden.
//
// Corre el gancho de verdad con un HOME temporal sobre un repo de juguete. El freno del estado a mano se apaga con su
// interruptor (TYCON_STATUS_GATE=off): lo que se prueba es el control que viene después, el de la evidencia.
//
// Correr: node --test frontmatter-batch-done.test.js < /dev/null   (desde skills/tycon-pipeline/scripts/tests)

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'on-frontmatter-write.js');

// La historia de juguete: pide prueba en vivo («smoke runtime») y no tiene evidencia en el repo.
function historia({ tandas = [], extra = [] } = {}) {
  return [
    '---', 'story: "9.9"', 'title: "paraguas"', 'status: in-progress', ...extra,
    ...(tandas.length ? ['pipelines:', ...tandas.flatMap(([n, st, ac]) => [`  - name: ${n}`, `    status: ${st}`, `    acs: [${ac}]`])] : []),
    '---', '# Story 9.9', '', 'Cada criterio se prueba con smoke runtime.', '',
    '## Acceptance Criteria', '', '1. **Given** algo, **Then** resultado.', '2. **Given** otra cosa, **Then** otro.', '',
  ].join('\n');
}

// Escribe `antes` en el repo, lo commitea y le pasa al gancho la escritura de `despues` (Write).
function escribir(antes, despues) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-batch-done-'));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  const story = path.join(repo, 'specs', 'story-9.9-paraguas.md');
  fs.writeFileSync(story, antes);
  const FECHA = '2026-01-01T10:00:00';
  const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', repo, ...a], {
    stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA },
  });
  git('init', '-q', '-b', 'feat/x');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('add', '.');
  git('commit', '-qm', 'inicio');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: 's-fm', TYCON_STATUS_GATE: 'off', TYCON_CLOSURE_RECORD: 'off' };
  delete env.TYCON_HOME; delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [HOOK], {
    cwd: repo, env, encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's-fm', tool_name: 'Write', tool_input: { file_path: story, content: despues } }),
  });
  fs.rmSync(base, { recursive: true, force: true });
  return r;
}
const salida = (r) => `${r.stderr}${r.stdout}`;
// un gancho que se rompe deja pasar (falla abierta) y sale 0: un «pasa» sólo vale si el gancho corrió entero
const pasa = (r) => { assert.doesNotMatch(salida(r), /FAILING OPEN/, salida(r)); assert.strictEqual(r.status, 0, salida(r)); };

test('T1 FrontmatterWrite_BatchToDone_Plain_Blocks — una tanda que pasa a done sin evidencia frena, como siempre', () => {
  const r = escribir(historia({ tandas: [['A', 'pending', 1], ['B', 'pending', 2]] }), historia({ tandas: [['A', 'done', 1], ['B', 'pending', 2]] }));
  assert.strictEqual(r.status, 2, salida(r));
});

test('T2 FrontmatterWrite_BatchToDone_QuotedOrCapitalized_Blocks — `status: "done"` y `Done` cuentan como done', () => {
  for (const estado of ['"done"', "'done'", 'Done']) {
    const r = escribir(historia({ tandas: [['A', 'pending', 1], ['B', 'pending', 2]] }), historia({ tandas: [['A', estado, 1], ['B', 'pending', 2]] }));
    assert.strictEqual(r.status, 2, `${estado}: ${salida(r)}`);
  }
});

test('T3 FrontmatterWrite_BatchToDone_ForeignDoneRemoved_Blocks — el done ajeno que se va en la misma escritura no la esconde', () => {
  const r = escribir(
    historia({ extra: ['review:', '  status: done'], tandas: [['A', 'pending', 1], ['B', 'pending', 2]] }),
    historia({ tandas: [['A', 'done', 1], ['B', 'pending', 2]] }));
  assert.strictEqual(r.status, 2, salida(r));
});

test('T4 FrontmatterWrite_DoneSwappedBetweenBatches_Blocks — el done que pasa de una tanda a otra se mide', () => {
  const r = escribir(historia({ tandas: [['A', 'done', 1], ['B', 'pending', 2]] }), historia({ tandas: [['A', 'pending', 1], ['B', 'done', 2]] }));
  assert.strictEqual(r.status, 2, salida(r));
});

test('T5 FrontmatterWrite_NoBatchToDone_Passes — sin tanda nueva en done, la escritura pasa', () => {
  const antes = historia({ tandas: [['A', 'done', 1], ['B', 'pending', 2]] });
  pasa(escribir(antes, antes.replace('title: "paraguas"', 'title: "paraguas, con otro título"')));
});

// La historia con un bloque de tandas escrito tal cual.
const conBloque = (bloque) => historia().replace('---\n# Story', `${bloque}---\n# Story`);
const tanda = (nombre, estado, ac) => `  - name: ${nombre}\n    status: ${estado}\n    acs: [${ac}]\n`;
// Bloques que el lector de tandas no lee bien, antes y después de que una tanda pase a done.
const DUDOSOS = [
  ['nombres con punto', `pipelines:\n${tanda('9.1-back', 'done', 1)}${tanda('9.2-front', 'pending', 2)}`,
    `pipelines:\n${tanda('9.1-back', 'done', 1)}${tanda('9.2-front', 'done', 2)}`],
  ['nombres con espacio', `pipelines:\n${tanda('"A b"', 'done', 1)}${tanda('"A c"', 'pending', 2)}`,
    `pipelines:\n${tanda('"A b"', 'done', 1)}${tanda('"A c"', 'done', 2)}`],
  ['nombres repetidos', `pipelines:\n${tanda('A', 'done', 1)}${tanda('A', 'pending', 2)}`,
    `pipelines:\n${tanda('A', 'done', 1)}${tanda('A', 'done', 2)}`],
  ['pipelines: # comentario', `pipelines: # tandas\n${tanda('A', 'pending', 1)}${tanda('B', 'pending', 2)}`,
    `pipelines: # tandas\n${tanda('A', '"done"', 1)}${tanda('B', 'pending', 2)}`],
  ['la forma de una línea', 'pipelines:\n  - {name: A, status: pending, acs: [1]}\n  - {name: B, status: pending, acs: [2]}\n',
    'pipelines:\n  - {name: A, status: done, acs: [1]}\n  - {name: B, status: pending, acs: [2]}\n'],
  ['- title: primero', 'pipelines:\n  - title: x\n    name: A\n    status: pending\n    acs: [1]\n',
    'pipelines:\n  - title: x\n    name: A\n    status: "done"\n    acs: [1]\n'],
  ['status: >- con done abajo', `pipelines:\n${tanda('A', 'pending', 1)}`, 'pipelines:\n  - name: A\n    status: >-\n      done\n    acs: [1]\n'],
];

test('T6 FrontmatterWrite_DoubtfulBatchesBlock_Blocks — ante la duda se mide: un bloque que el lector no lee bien frena sin evidencia', async (t) => {
  for (const [caso, antes, despues] of DUDOSOS) {
    await t.test(caso, () => {
      const r = escribir(conBloque(antes), conBloque(despues));
      assert.strictEqual(r.status, 2, salida(r));
    });
  }
});

test('T7 FrontmatterWrite_DoubtfulBlockUnchanged_Passes — sin una tanda nueva en done, el bloque dudoso no frena', () => {
  const antes = conBloque(DUDOSOS[0][2]);
  pasa(escribir(antes, antes.replace('title: "paraguas"', 'title: "paraguas, con otro título"')));
});
