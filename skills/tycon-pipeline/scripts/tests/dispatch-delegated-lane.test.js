'use strict';
/**
 * dispatch-delegated-lane.test.js — una guía de la lista de un camino corto abierto por delegación se edita.
 *
 *   T11 la guía de la lista pasa por el control de antes de editar, igual que el código de la misma lista
 *   T12 una guía que no está en la lista frena como fuera de la lista
 *
 * Corre el control de antes de editar de verdad (`hook-pre-edit.js`) como proceso aparte, con el evento por la entrada,
 * sobre un repo de git de juguete y una HOME temporal con el carril ya firmado. T12 es la que muestra que T11 pasa por la
 * comparación con la lista y no porque una guía nunca frene.
 *
 * stable-data: el carril se escribe con la hora de ahora a propósito: vence por edad contra Date.now().
 * Correr: node --test skills/tycon-pipeline/scripts/tests/dispatch-delegated-lane.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const HOOK = path.join(SCRIPTS, 'hook-pre-edit.js');
const { stateDir } = require(path.join(SCRIPTS, 'lib', 'state-dir.js'));

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// El árbol del arnés para el enlace de la HOME de juguete: el de esta prueba si lo trae; si las skills vienen solas, el
// instalado.
function arnes() {
  const propio = path.join(SCRIPTS, '..', '..', '..');
  if (fs.existsSync(path.join(propio, 'scripts', 'lib', 'hook-io.js'))) return propio;
  try { return fs.realpathSync(path.join(os.homedir(), '.claude', 'tycon-harness')); } catch (_) { return null; }
}

function corral() {
  const raiz = tmp('carril-delegado-');
  const dir = path.join(raiz, 'producto');
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  for (const [rel, txt] of [['.tycon/advisors.yaml', 'packs: []\n'], ['guides/uso.md', '# uso\n'], ['guides/otra.md', '# otra\n'], ['scripts/x.js', 'module.exports = 1;\n']]) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), txt);
  }
  git(dir, 'add', '.');
  git(dir, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'base');
  const home = tmp('home-');
  const a = arnes();
  if (a) {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.symlinkSync(a, path.join(home, '.claude', 'tycon-harness'));
  }
  const estado = stateDir(home);
  fs.mkdirSync(path.join(estado, 'adhoc'), { recursive: true });
  const ts = new Date().toISOString();
  fs.writeFileSync(path.join(estado, 'adhoc', 'del.json'), JSON.stringify({
    reason: 'arreglo de la guía de uso', maxFiles: 5, files: [], declaredAt: ts, lastTouch: ts, firmadaEn: ts,
    datos: 'sin-cambio', via: 'delegacion', allowedFiles: [path.join(dir, 'guides/uso.md'), path.join(dir, 'scripts/x.js')],
  }));
  fs.appendFileSync(path.join(estado, 'gates.log'), `${JSON.stringify({ ts, name: 'adhoc-lane-signed', status: 'ok', destino: 'del' })}\n`);
  return { dir, home };
}

function editar({ dir, home }, rel) {
  const evento = { session_id: 'del', tool_name: 'Edit', cwd: dir, hook_event_name: 'PreToolUse', tool_input: { file_path: path.join(dir, rel), old_string: '#', new_string: '##' } };
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: 'del' };
  return spawnSync(process.execPath, [HOOK], { input: JSON.stringify(evento), env, cwd: dir, encoding: 'utf8' });
}

test('T11 Dispatch_DelegatedLaneGuide_Passes @story-8.278 @ac-16 — la guía de la lista del carril delegado se edita, igual que el código de la lista', () => {
  const c = corral();
  for (const rel of ['guides/uso.md', 'scripts/x.js']) {
    const r = editar(c, rel);
    assert.equal(r.status, 0, `${rel} pasa: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /⛔/, `${rel}: ningún control frena`);
  }
});

test('T12 Dispatch_GuideOutsideLane_Blocks @story-8.278 @ac-17 — una guía que no está en la lista frena como fuera de la lista', () => {
  const c = corral();
  const r = editar(c, 'guides/otra.md');
  assert.equal(r.status, 2, `frena: ${r.stderr}`);
  assert.match(r.stderr, /FUERA DE LA LISTA/);
  assert.match(r.stderr, /guides\/otra\.md no está en la lista/);
});
