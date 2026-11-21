'use strict';
/**
 * tycon-create-story-index.test.js — en un repo con los índices de historias generados (`team-repos.json` →
 * `story_index`, modo «generated»), nadie de una rama edita `specs/epics.md` ni `specs/sprint-status.yaml`.
 *
 * La skill que crea historias y el paso de acción de la revisión de desfase leían y escribían `sprint-status.yaml`. Con
 * el índice generado, eligen y escriben desde el frontmatter; sin la clave, siguen como siempre. El cambio de estado de
 * `marker.js update-story-status` nunca tocó los índices, y así sigue.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const WORKFLOW = path.join(REPO, 'skills', 'tycon-create-story', 'workflow.md');
const DRIFT = path.join(REPO, 'skills', 'check-story-drift', 'steps', 'step-05-hitl-action.md');
const MARKER = path.join(REPO, 'skills', 'tycon-pipeline', 'scripts', 'marker.js');

const leer = (f) => fs.readFileSync(f, 'utf8');

test('CreateStory_GeneratedIndexWritesOnlyFrontmatter (T7) @story-8.226 @ac-7', () => {
  const wf = leer(WORKFLOW);
  const bloque = /<!-- story-index:generated -->([\s\S]*?)<!-- \/story-index:generated -->/.exec(wf);
  assert.ok(bloque, 'la skill trae el bloque del índice generado');
  assert.match(bloque[1], /story_index/);
  assert.match(bloque[1], /frontmatter/);
  assert.match(bloque[1], /do not read nor write/i, 'no lee ni escribe los índices');
  assert.match(bloque[1], /story-index\.js/, 'nombra el guion que los genera');
  assert.match(wf, /<action>Update \{\{sprint_status\}\}<\/action>/, 'sin la clave, sigue como hoy');
  const drift = leer(DRIFT);
  assert.match(drift, /story_index: generated[\s\S]{0,400}no se edita/i, 'el paso de desfase manda a cambiar el frontmatter');
  assert.match(drift, /sprint-status\.yaml`: actualizar entry de la story a `done`/, 'sin la clave, igual que hoy');
});

test('Marker_UpdateStoryStatusLeavesIndexesAlone (T8) @story-8.226 @ac-7', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-index-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-home-'));
  fs.mkdirSync(path.join(dir, 'specs'));
  const spec = path.join(dir, 'specs', 'story-1.2-alfa.md');
  fs.writeFileSync(spec, '---\nepic: 1\nstory: "1.2"\ntitle: "Alfa"\nstatus: draft\n---\n\n# Story 1.2: Alfa\n\nStatus: draft\n');
  const indices = { 'specs/epics.md': '# Épicas\n\n| 1.2 | Alfa | draft |\n', 'specs/sprint-status.yaml': 'development_status:\n  1-2-alfa: draft\n' };
  for (const [rel, t] of Object.entries(indices)) fs.writeFileSync(path.join(dir, rel), t);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync(process.execPath, [MARKER, 'update-story-status', spec, 'ready-for-dev'], { cwd: dir, env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(leer(spec), /^status: ready-for-dev$/m);
  assert.match(leer(spec), /^Status: ready-for-dev$/m);
  for (const [rel, t] of Object.entries(indices)) assert.strictEqual(leer(path.join(dir, rel)), t, `${rel} no se toca`);
});
