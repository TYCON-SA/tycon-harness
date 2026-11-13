'use strict';
// windows-console-probe.test.js — la medición de ventanas de consola por gancho (scripts/tools/windows-console-probe.js).
//
// Las ventanas sólo se ven en Windows: estas pruebas cubren lo que no depende de eso. Qué ganchos encuentra (los del
// usuario, los del repo y los de los plugins prendidos), con qué entrada los dispara, a qué disparo se le cuenta cada
// ventana, que sin control visto el informe dice NO MEDIDO y nunca «0 ventanas», y que fuera de Windows no escribe nada.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../tools/windows-console-probe.js');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wcp-')); }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); }
const cmd = (command, extra = {}) => ({ type: 'command', command, ...extra });

test('T1 · ConsoleProbe_Collect_UserRepoAndEnabledPlugins', () => {
  const home = tmp(); const repo = tmp();
  const pluginRoot = path.join(home, 'plugins', 'engram');
  writeJson(path.join(home, '.claude', 'settings.json'), {
    enabledPlugins: { 'engram@engram': true, 'off@x': false },
    hooks: {
      UserPromptSubmit: [{ hooks: [cmd('node "C:/h/on-prompt.js"')] }],
      PostToolUse: [{ matcher: 'Bash|PowerShell', hooks: [cmd('node "C:/h/extension-notices.js"'), cmd('node "C:/h/obs.js"', { async: true })] }],
      SessionStart: [{ hooks: [cmd('node "C:/h/start.js"')] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [cmd('bash "C:/h/safety-guard-pre.sh"')] }],
    },
  });
  writeJson(path.join(repo, '.claude', 'settings.local.json'), { hooks: { Stop: [{ hooks: [cmd('node local-stop.js')] }] } });
  writeJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), { version: 2, plugins: {
    'engram@engram': [{ scope: 'user', installPath: pluginRoot }],
    'off@x': [{ scope: 'user', installPath: path.join(home, 'plugins', 'off') }],
  } });
  writeJson(path.join(pluginRoot, 'hooks', 'hooks.json'), { hooks: { UserPromptSubmit: [{ hooks: [cmd('"${CLAUDE_PLUGIN_ROOT}/scripts/user-prompt-submit.sh"')] }] } });
  writeJson(path.join(home, 'plugins', 'off', 'hooks', 'hooks.json'), { hooks: { Stop: [{ hooks: [cmd('off.sh')] }] } });

  const list = P.collectHooks({ home, repo });
  assert.deepStrictEqual(list.map((h) => [h.event, h.source, h.command]), [
    ['UserPromptSubmit', 'usuario', 'node "C:/h/on-prompt.js"'],
    ['PostToolUse', 'usuario', 'node "C:/h/extension-notices.js"'],
    ['PostToolUse', 'usuario', 'node "C:/h/obs.js"'],
    ['Stop', 'repo (local)', 'node local-stop.js'],
    ['UserPromptSubmit', 'plugin engram@engram', '"${CLAUDE_PLUGIN_ROOT}/scripts/user-prompt-submit.sh"'],
  ], 'sólo los tres eventos, y sólo los plugins prendidos');
  assert.strictEqual(list[2].async, true);
  assert.strictEqual(list[4].env.CLAUDE_PLUGIN_ROOT, pluginRoot, 'el gancho del plugin sabe dónde está su carpeta');
  assert.strictEqual(P.collectHooks({ home, repo, plugins: false }).length, 4, '--no-plugins deja afuera los del plugin');
});

test('T2 · ConsoleProbe_Collect_BrokenOrMissingSettings_NoHooksNoCrash', () => {
  const home = tmp(); const repo = tmp();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ esto no es json');
  assert.deepStrictEqual(P.collectHooks({ home, repo }), []);
  assert.deepStrictEqual(P.hooksOf({ hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'x' }, cmd('  ')] }] } }, 'usuario'), [], 'un gancho que no es un comando no se dispara');
});

test('T3 · ConsoleProbe_Input_PerEventAndToolFromMatcher', () => {
  const ctx = { sessionId: 'probe-ventanas-x', repo: 'C:/r', transcript: 'C:/t.jsonl' };
  const up = P.inputFor({ event: 'UserPromptSubmit', matcher: '' }, ctx);
  assert.strictEqual(up.hook_event_name, 'UserPromptSubmit');
  assert.strictEqual(up.session_id, 'probe-ventanas-x', 'una sesión de mentira, nunca la de quien mide');
  assert.ok(up.prompt);
  assert.strictEqual(P.inputFor({ event: 'Stop', matcher: '' }, ctx).stop_hook_active, false);
  assert.strictEqual(P.inputFor({ event: 'PostToolUse', matcher: 'Edit|Write' }, ctx).tool_name, 'Edit');
  assert.strictEqual(P.inputFor({ event: 'PostToolUse', matcher: '' }, ctx).tool_name, 'Bash');
  assert.strictEqual(P.toolFor('mcp__spokenly__ask|AskUserQuestion'), 'mcp__spokenly__ask');
  assert.strictEqual(P.toolFor('.*'), 'Bash', 'un patrón no es una herramienta');
});

test('T4 · ConsoleProbe_Label_NamesTheScript', () => {
  assert.strictEqual(P.labelOf('"D:/tools/.tycon/node/node.exe" "D:/tools/.tycon/harness/scripts/hooks/retro-pending.js"'), 'hooks/retro-pending.js');
  assert.strictEqual(P.labelOf('bash "C:/h/scripts/hooks/safety-guard-pre.sh"'), 'hooks/safety-guard-pre.sh');
  assert.strictEqual(P.labelOf('"${CLAUDE_PLUGIN_ROOT}/scripts/user-prompt-submit.sh"'), 'scripts/user-prompt-submit.sh');
});

test('T5 · ConsoleProbe_Attribute_WindowGoesToItsShotOrStaysLoose', () => {
  const runs = [{ label: 'a', start: 1000, end: 2000 }, { label: 'b', start: 5000, end: 6000 }];
  const windows = [{ t: 1500, pid: 1 }, { t: 3400, pid: 2 }, { t: 3600, pid: 3 }, { t: 5999, pid: 4 }];
  const r = P.attribute(windows, runs, 1500);
  assert.deepStrictEqual(r.runs.map((x) => x.windows.map((w) => w.pid)), [[1, 2], [4]], 'cuenta hasta el fin más la espera');
  assert.deepStrictEqual(r.loose.map((w) => w.pid), [3], 'lo que no cae en ningún tramo queda aparte, no se pierde');
});

test('T6 · ConsoleProbe_Events_ReadyWindowsAndBrokenLines', () => {
  const e = P.parseEvents('{"ready":true,"t":1}\r\n{"t":5,"class":"ConsoleWindowClass","pid":9,"name":"git"}\nbasura\n{"done":true,"t":9}\n');
  assert.strictEqual(e.ready, true);
  assert.deepStrictEqual(e.windows.map((w) => w.pid), [9]);
  assert.strictEqual(P.parseEvents('{"ready":false,"error":"SetWinEventHook no anduvo"}').error, 'SetWinEventHook no anduvo');
  assert.strictEqual(P.parseEvents('').ready, false);
  assert.strictEqual(P.parseEvents('﻿{"ready":false,"error":"x"}\r\n').error, 'x', 'la línea con BOM de PowerShell 5.1 se lee');
});

test('T7 · ConsoleProbe_Report_NotMeasuredNeverSaysZero', () => {
  const base = { machine: 'PC', at: '2026-11-13T00:00:00Z', loose: [], bash: 'C:/Git/bin/bash.exe' };
  const blind = P.renderReport({ ...base, measured: false, why: 'el control no abrió ninguna ventana', runs: [] });
  assert.match(blind, /NO MEDIDO/);
  assert.doesNotMatch(blind, /Ninguna ventana/);
  const clean = P.renderReport({ ...base, measured: true, control: { windows: 1 }, runs: [{ round: 1, when: 'al cerrar el turno', label: 'hooks/retro-pending.js', source: 'usuario', windows: [], ms: 300 }] });
  assert.match(clean, /Ninguna ventana/);
  const dirty = P.renderReport({ ...base, measured: true, control: { windows: 1 },
    runs: [{ round: 1, when: 'al mandar un mensaje', label: 'scripts/user-prompt-submit.sh', source: 'plugin engram@engram', windows: [{ t: 1, pid: 7, name: 'engram', parent: 6, parentName: 'bash' }], ms: 900 }],
    loose: [{ t: 2, pid: 8, name: 'git', class: 'ConsoleWindowClass' }] });
  assert.match(dirty, /1 ventana\(s\) en 1 disparo\(s\)/);
  assert.match(dirty, /engram \(pid 7\), lo abrió bash \(pid 6\)/, 'dice qué programa abrió la ventana y quién lo lanzó');
  assert.match(dirty, /fuera de todo disparo \(1\)/);
});

test('T8 · ConsoleProbe_OutsideWindows_SaysSoAndWritesNothing', async () => {
  const home = tmp();
  let said = '';
  const code = await P.main([], { home, platform: 'darwin', write: (s) => { said += s; } });
  assert.strictEqual(code, 2);
  assert.match(said, /ventanas de Windows/);
  assert.deepStrictEqual(fs.readdirSync(home), [], 'no deja nada en la máquina');
});

test('T9 · ConsoleProbe_Args_UnknownOptionAndRoundsCapped', async () => {
  assert.strictEqual(P.parseArgs(['--rounds', '99']).rounds, 5);
  assert.strictEqual(P.parseArgs(['--no-plugins']).plugins, false);
  let said = '';
  assert.strictEqual(await P.main(['--wipe'], { platform: 'win32', write: (s) => { said += s; } }), 2);
  assert.match(said, /no conozco la opción --wipe/);
});

test('T10 · ConsoleProbe_QuietEnv_TurnsOffWhatChangesTheInstall', () => {
  assert.deepStrictEqual(P.QUIET_ENV, { TYCON_NO_AUTOINSTALL: '1', TYCON_GUIDES_HEAL: '0', TYCON_OFFICE_LINK: '0' });
});
