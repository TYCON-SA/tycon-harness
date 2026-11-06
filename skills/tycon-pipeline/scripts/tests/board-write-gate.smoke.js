#!/usr/bin/env node
'use strict';
// board-write-gate.smoke.js — el freno del tablero como lo corre la herramienta: cada gancho en su propio proceso, con el
// evento por la entrada, sobre una carpeta de estado de juguete. Un Edit y una redirección sobre tablero.json frenan con
// el comando de board.js; board.js set guarda.
//
//   node skills/tycon-pipeline/scripts/tests/board-write-gate.smoke.js     sale 0 si todo pasó, 1 si no

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const BOARD = path.join(SCRIPTS, '..', '..', '..', 'scripts', 'tools', 'office', 'board.js');
const fails = [];
const check = (ok, what) => { console.log(`${ok ? 'ok ' : 'MAL'} ${what}`); if (!ok) fails.push(what); };

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'freno-tablero-')));
const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_HOME: '', TYCON_NO_RUN_CHANGE: '1' };
// la carpeta de estado que ven los ganchos con esta HOME
const sdir = require(path.join(SCRIPTS, 'lib', 'state-dir.js')).stateDir(home);
fs.mkdirSync(path.join(sdir, 'coordination'), { recursive: true });
const saved = require(BOARD).save(sdir, { pendientes: [{ titulo: 'Una fila', estado: 'espera', grupo: 'Hoy' }] }, { home, live: [] });
check(saved.code === 0, 'el tablero de juguete se guardó con board.js');
const file = path.join(sdir, 'coordination', 'tablero.json');
const before = fs.readFileSync(file, 'utf8');

const hook = (script, event) => spawnSync(process.execPath, [path.join(SCRIPTS, script)], { input: JSON.stringify(event), env, encoding: 'utf8', timeout: 30000 });
const blocked = (r) => r.status === 2 && /El tablero se escribe sólo con board\.js[\s\S]*board\.js set T-41/.test(`${r.stdout}${r.stderr}`);

const edit = hook('hook-pre-edit.js', { session_id: 'prueba-8198', tool_name: 'Edit', cwd: home, tool_input: { file_path: file, old_string: 'Una fila', new_string: 'Otra fila' } });
check(blocked(edit), `un Edit sobre tablero.json frena con el comando (salió ${edit.status})`);
const redirect = hook('on-bash-write-gate.js', { session_id: 'prueba-8198', tool_name: 'Bash', cwd: home, tool_input: { command: `echo '{}' > ${file}` } });
check(blocked(redirect), `una redirección sobre tablero.json frena con el comando (salió ${redirect.status})`);
check(fs.readFileSync(file, 'utf8') === before, 'el tablero sigue igual');

const cmd = `node ${BOARD} set T-1 nota=hola --state-dir ${sdir}`;
const gate = hook('on-bash-write-gate.js', { session_id: 'prueba-8198', tool_name: 'Bash', cwd: home, tool_input: { command: cmd } });
check(gate.status === 0, `board.js set pasa el freno (salió ${gate.status})`);
const set = spawnSync(process.execPath, [BOARD, 'set', 'T-1', 'nota=hola', '--state-dir', sdir], { env, encoding: 'utf8' });
const row = JSON.parse(fs.readFileSync(file, 'utf8')).pendientes[0];
check(set.status === 0 && row.nota === 'hola' && row.id === 'T-1', 'board.js set guardó la nota en T-1');

console.log(fails.length ? `E7: FALLA (${fails.length})` : 'E7: OK');
process.exit(fails.length ? 1 : 0);
