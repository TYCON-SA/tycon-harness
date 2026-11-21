'use strict';
/**
 * old-marker-paths.test.js — un marcador viejo, sin la ruta del repo, no depende de la carpeta desde donde corre el
 * proceso: la carpeta de la corrida sale del repo de su historia, y sin historia absoluta no se adivina.
 *
 * Corre las funciones de la pregunta de firma con un marcador armado a mano y el proceso parado en otro repo. 0 deps.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ss = require(path.join(__dirname, '..', 'lib', 'signature-sources.js'));
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

/** Un repo de juguete (con `.git`) con una historia y la carpeta de su corrida. */
function repoConCorrida(nombre) {
  const repo = tmp(`marcador-viejo-${nombre}-`);
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, 'specs'));
  fs.writeFileSync(path.join(repo, 'specs', 'story-1.1.md'), '---\nstory: "1.1"\nepic: "1"\ntitle: "x"\nstatus: in-progress\n---\n');
  fs.mkdirSync(path.join(repo, '.advisors', 'pipeline-runs', '1.1-20261116000000'), { recursive: true });
  return repo;
}

function enCarpeta(dir, fn) {
  const antes = process.cwd();
  process.chdir(dir);
  try { return fn(); } finally { process.chdir(antes); }
}

test('OldMarker_NoRepoPath_RunDirFromStoryRepo (T1)', () => {
  const repo = repoConCorrida('historia');
  const otro = repoConCorrida('otro');
  const m = { storyId: '1.1', storyPath: path.join(repo, 'specs', 'story-1.1.md') };
  const dir = enCarpeta(otro, () => ss.carpetaDeLaCorrida(m));
  assert.ok(dir && dir.startsWith(repo), `la carpeta de la corrida sale del repo de la historia, no de la carpeta del proceso: ${dir}`);
});

const LIB = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib');

test('DirectReaders_RelativeStoryWithoutRepo_NotAgainstProcessFolder (T3)', () => {
  // el lector de la tanda: una historia relativa sin repo no se ubica contra la carpeta del proceso
  const cp = require(path.join(LIB, 'compare-previous.js'));
  const otro = repoConCorrida('otro');
  const deOtro = path.join(otro, 'specs', 'story-1.1.md');
  const r = enCarpeta(otro, () => cp.archivosDeLaTanda({ batch: 'A', storyPath: 'specs/story-1.1.md' }, deOtro));
  assert.equal(r.files, null);
  assert.match(String(r.motivo), /otra historia/, `la historia relativa se tomó como la del repo del proceso: ${JSON.stringify(r)}`);
});

test('DirectReaders_Provenance_RunFromMarkerRepoNotProcessFolder (T4)', () => {
  // la procedencia de una prueba: la carpeta de la corrida sale del repo de la historia del marcador
  const ft = require(path.join(LIB, 'frozen-tree.js'));
  const repo = repoConCorrida('historia');
  const otro = repoConCorrida('otro');
  const home = tmp('marcador-viejo-casa-');
  const active = path.join(home, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(active, { recursive: true });
  const escribir = (m) => fs.writeFileSync(path.join(active, 'sesion-vieja.json'), JSON.stringify({ sessionId: 'sesion-vieja', storyId: '1.1', ...m }));
  const env = { CLAUDE_CODE_SESSION_ID: 'sesion-vieja', TYCON_HOME: '' };
  escribir({ storyPath: path.join(repo, 'specs', 'story-1.1.md') });
  const a = enCarpeta(otro, () => ft.procedencia(null, { env, home }));
  assert.ok(String(a.run).startsWith(repo), `la corrida sale del repo de la historia: ${JSON.stringify(a)}`);
  escribir({ storyPath: 'specs/story-1.1.md' });
  const b = enCarpeta(otro, () => ft.procedencia(null, { env, home }));
  assert.equal(b.run, null, `sin repo ni historia absoluta no se adivina: ${JSON.stringify(b)}`);
  assert.match(String(b.run_error || b.runError), /no dice su repo/);
});

test('OldMarker_NoRepoPathRelativeStory_DoesNotGuess (T2)', () => {
  const otro = repoConCorrida('otro');
  const m = { storyId: '1.1', storyPath: 'specs/story-1.1.md' };
  const dir = enCarpeta(otro, () => ss.carpetaDeLaCorrida(m));
  assert.equal(dir, null, `sin la ruta del repo ni una historia absoluta, no se adivina con la carpeta del proceso: ${dir}`);
});
