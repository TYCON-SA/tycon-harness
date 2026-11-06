#!/usr/bin/env node
'use strict';
/**
 * board-write-gate.test.js — el tablero de la oficina no se escribe a mano (T38, T39 de la historia 8.198).
 *
 * QUÉ CUIDA: que Edit, Write y la consola sobre `<estado>/coordination/tablero.json` frenen con el comando de board.js
 * que hace lo mismo, y que leer el tablero, escribir el archivo aparte de la coordinadora y correr board.js sigan libres.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/board-write-gate.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPTS = path.join(__dirname, '..');
const edit = require(path.join(SCRIPTS, 'on-story-gate.js'));
const bash = require(path.join(SCRIPTS, 'on-bash-write-gate.js'));

const SID = 'sesion-8198';
const ENV = { TYCON_STORY_GATE: undefined, TYCON_NO_RUN_CHANGE: '1' };

function corral() {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tablero-8198-')));
  const estado = path.join(raiz, 'estado');
  const aparte = path.join(raiz, 'borrador');
  fs.mkdirSync(path.join(estado, 'coordination'), { recursive: true });
  fs.mkdirSync(aparte, { recursive: true });
  const tablero = path.join(estado, 'coordination', 'tablero.json');
  fs.writeFileSync(tablero, '{"pendientes":[]}\n');
  return { raiz, estado, tablero, aparte: path.join(aparte, 'tablero.json') };
}

function conEnv(vars, fn) {
  const antes = {};
  for (const k of Object.keys(vars)) { antes[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k]; }
  }
}

const BOARD_TEXT = /El tablero se escribe sólo con board\.js[\s\S]*board\.js" set T-41[\s\S]*add[\s\S]*close T-41[\s\S]*save --from/;

test('T38 WriteGate_EditYWriteSobreTablero_Frena — @story-8.198 @ac-38', () => {
  const c = corral();
  conEnv(ENV, () => {
    for (const tool of ['Edit', 'Write']) {
      const r = edit.handle({ tool_name: tool, session_id: SID, cwd: c.raiz, tool_input: { file_path: c.tablero } }, { stateDir: c.estado });
      assert.ok(r && r.block, `${tool} frena`);
      assert.match(r.block, BOARD_TEXT, tool);
    }
    // el archivo aparte de la coordinadora, fuera de la carpeta de estado, sigue libre
    assert.strictEqual(edit.handle({ tool_name: 'Write', session_id: SID, cwd: c.raiz, tool_input: { file_path: c.aparte } }, { stateDir: c.estado }), null);
    // leer no pasa por el freno de escritura
    assert.strictEqual(edit.handle({ tool_name: 'Read', session_id: SID, cwd: c.raiz, tool_input: {} }, { stateDir: c.estado }), null);
  });
});

test('T39 WriteGate_ConsolaSobreTablero_Frena — @story-8.198 @ac-39', () => {
  const c = corral();
  const board = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'tools', 'office', 'board.js');
  conEnv(ENV, () => {
    const ev = (command) => ({ tool_name: 'Bash', session_id: SID, cwd: c.raiz, tool_input: { command } });
    const frenan = [
      `echo '{}' > ${c.tablero}`,
      `mv ${c.aparte} ${c.tablero}`,
      `cp ${c.aparte} ${c.tablero}`,
      `node -e "require('fs').writeFileSync('${c.tablero}', '{}')"`,
    ];
    for (const cmd of frenan) {
      const r = bash.handle(ev(cmd), { stateDir: c.estado, installedRoots: [] });
      assert.ok(r && r.block, `frena: ${cmd}`);
      assert.match(r.block, BOARD_TEXT, cmd);
    }
    for (const cmd of [`node ${board} set T-1 nota=hola --state-dir ${c.estado}`, `cat ${c.tablero}`]) {
      const r = bash.handle(ev(cmd), { stateDir: c.estado, installedRoots: [] });
      assert.ok(!r || !r.block, `no frena: ${cmd}${r && r.block ? `\n${r.block}` : ''}`);
    }
  });
});
