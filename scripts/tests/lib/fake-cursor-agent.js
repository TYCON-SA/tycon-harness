#!/usr/bin/env node
'use strict';
// fake-cursor-agent.js — a `cursor-agent` for the tests of the Cursor probes. It never talks to the network, never reads a
// keychain and never writes outside the folder it runs in and the project folders of its HOME.
//
// The tests reach it through a launcher named `cursor-agent` (see cursor-probes.test.js). Its behaviour comes from a
// JSON state file named by FAKE_CURSOR_STATE (every key optional):
//   { "version": "2026.10.19-fake",      what `--version` prints ("" prints nothing)
//     "version_stderr": "Error: …",       `--version` exits 1 with this on stderr
//     "hang": ["version", "run"],         those calls never return (the time limit of the probes must cut them)
//     "fail": ["version", "run"],         those calls exit 1 with «Error: falla de mentira» on stderr
//     "fire_hooks": true,                 a run fires the hooks of <cwd>/.cursor/hooks.json before «the model»
//     "events": ["sessionStart", "beforeSubmitPrompt"],   which events it fires, in order
//     "conversation_id": "conv-1", "session_id": null,    ids of the payload
//     "payload": { … },                   extra payload fields
//     "env": { "CURSOR_CONVERSATION_ID": "conv-1" },      variables the hooks get on top of the inherited ones
//     "event_env": { "stop": { … } },     the same, for one event only
//     "foreign_project": "otro-repo",     a project folder another Cursor session creates during the run
//     "lock_short_parent": true,          the folder that holds the short project folder ends read-only
//     "raw_payload": "no es json",        what the hooks get on stdin instead of the JSON payload
//     "event_raw_payload": { "stop": "…" },   the same, for one event only
//     "no_wait": true,                    a run launches the hooks without waiting for them and ends 200 ms later
//     "exit_code": 0,                     a run ends with this code and without the error below: it reached the service
//     "run_error": "Error: otra cosa",    what a run says at the end, instead of the refused connection
//     "run_error_before": "aviso…",       printed before the refused connection
//     "run_error_after": "at /x" }        printed after the refused connection
// A run (any call that is not `--version`) ends like the real one with its service pointed to a closed address: after
// the hooks, «Error: connect ECONNREFUSED <CURSOR_API_ENDPOINT>» and exit 1.
// Every call is appended to FAKE_CURSOR_LOG (one JSON line: argv, cwd, the endpoint) when that variable is set.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const argv = process.argv.slice(2);
let state = {};
if (process.env.FAKE_CURSOR_STATE) {
  try { state = JSON.parse(fs.readFileSync(process.env.FAKE_CURSOR_STATE, 'utf8')); } catch (_e) { state = {}; }
}
const has = (list, what) => Array.isArray(list) && list.includes(what);

if (process.env.FAKE_CURSOR_LOG) {
  try {
    fs.appendFileSync(process.env.FAKE_CURSOR_LOG, `${JSON.stringify({ argv, cwd: process.cwd(), endpoint: process.env.CURSOR_API_ENDPOINT || null })}\n`);
  } catch (_e) { /* the log is only for debugging */ }
}

const call = argv.includes('--version') || argv.includes('-v') ? 'version' : 'run';
if (has(state.hang, call)) {
  // stay alive until killed
  setInterval(() => {}, 1 << 30);
} else if (has(state.fail, call)) {
  process.stderr.write('Error: falla de mentira\n');
  process.exit(1);
} else if (call === 'version') {
  if (state.version_stderr) {
    process.stderr.write(`${state.version_stderr}\n`);
    process.exit(1);
  }
  process.stdout.write(state.version === '' ? '' : `${state.version || '2026.10.19-fake'}\n`);
  process.exit(0);
} else {
  runSession();
}

function createProjectFolders(cwd, trusted) {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return;
  // like the real CLI: under CURSOR_DATA_DIR or ~/.cursor, a folder named after the workspace path, and when the whole
  // route is long, another one with its first 83 characters and a hash. `--trust` leaves the trust mark in the first
  const projects = path.join(process.env.CURSOR_DATA_DIR || path.join(home, '.cursor'), 'projects');
  const slug = cwd.replace(/^[\\/]+/, '').replace(/[^A-Za-z0-9]+/g, '-');
  const route = path.join(projects, slug);
  try {
    fs.mkdirSync(route, { recursive: true });
    if (route.length > 91) {
      const short = `${route.substring(0, 83)}-${crypto.createHash('sha256').update(route).digest('hex').slice(0, 7)}`;
      fs.mkdirSync(short, { recursive: true });
      if (state.lock_short_parent) fs.chmodSync(path.dirname(short), 0o555);
    }
    if (trusted) fs.writeFileSync(path.join(route, '.workspace-trusted'), JSON.stringify({ workspacePath: cwd, trustMethod: 'cli-flag' }));
    if (state.foreign_project) fs.mkdirSync(path.join(projects, state.foreign_project), { recursive: true });
  } catch (_e) { /* best effort */ }
}

function finish() {
  if (state.exit_code != null) process.exit(state.exit_code);
  const refused = `Error: connect ECONNREFUSED ${process.env.CURSOR_API_ENDPOINT || 'api2.cursor.sh'}`;
  const text = state.run_error || [state.run_error_before, refused, state.run_error_after].filter(Boolean).join('\n');
  process.stderr.write(`${text}\n`);
  process.exit(1);
}

function runSession() {
  const cwd = process.cwd();
  const trusted = argv.includes('--trust');
  createProjectFolders(cwd, trusted);
  if (!trusted) {
    process.stderr.write('⚠ Workspace Trust Required\nPass --trust if you trust this directory\n');
    process.exit(1);
  }
  const hooksFile = path.join(cwd, '.cursor', 'hooks.json');
  if (state.fire_hooks !== false && fs.existsSync(hooksFile)) {
    let config = {};
    try { config = JSON.parse(fs.readFileSync(hooksFile, 'utf8')); } catch (_e) { config = {}; }
    const hooks = (config && config.hooks) || {};
    const events = Array.isArray(state.events) ? state.events : ['sessionStart', 'beforeSubmitPrompt'];
    for (const event of events) {
      for (const h of hooks[event] || []) {
        if (!h || typeof h.command !== 'string') continue;
        const payload = Object.assign({
          hook_event_name: event,
          conversation_id: state.conversation_id || 'fake-conversation',
          generation_id: 'fake-generation',
          workspace_roots: [cwd],
        }, state.session_id ? { session_id: state.session_id } : {}, state.payload || {});
        const eventRaw = (state.event_raw_payload || {})[event];
        const input = eventRaw != null ? eventRaw : (state.raw_payload != null ? state.raw_payload : JSON.stringify(payload));
        const env = Object.assign({}, process.env, state.env || {}, (state.event_env || {})[event] || {});
        if (state.no_wait) {
          const child = spawn(h.command, { shell: true, cwd, env, stdio: ['pipe', 'ignore', 'ignore'] });
          child.stdin.end(input);
        } else {
          spawnSync(h.command, { shell: true, cwd, input, env, encoding: 'utf8', timeout: 15000 });
        }
      }
    }
  }
  if (state.no_wait) setTimeout(finish, 200);
  else finish();
}
