'use strict';
/**
 * delegated-pass.test.js — la corrida cuyo código va al repo hermano le deja el pase a la corrida de ese hermano
 * (@story-8.238).
 *
 * Arma dos repos de juguete: `acme-specs` (la historia, sin código) y `acme-code` (el hermano, con el código), con el
 * hermano declarado y commiteado en `.tycon/advisors.yaml`. La corrida de `acme-specs` tiene su marcador con la base; la
 * de `acme-code`, cuando se ve, es otro marcador en la carpeta del estado de una casa propia, en el TMPDIR del sistema. El
 * portón se corre por su línea de comandos, con esa casa y la sesión de la corrida.
 * Correr: node --test skills/tycon-pipeline/scripts/tests/delegated-pass.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const dp = require('../lib/delegated-pass.js');
const { stateDir } = require('../lib/state-dir.js');

const PIPELINE = path.join(__dirname, '..', 'pipeline.js');

const STORY_ID = '9.1';
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env,
    GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'acme@example.test', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'acme@example.test',
    GIT_AUTHOR_DATE: '2026-11-21T10:00:00Z', GIT_COMMITTER_DATE: '2026-11-21T10:00:00Z' } });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return String(r.stdout).trim();
};
const escribir = (f, texto) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, texto); };

/**
 * Los dos repos y la carpeta del estado. `propio` suma archivos de código declarados en el repo de la historia;
 * `verCorrida` deja el marcador de la corrida del hermano.
 */
function armar(t, { propio = [], verCorrida = true, marcadorDelHermano = {} } = {}) {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pase-delegado-')));
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
  const specs = path.join(raiz, 'acme-specs');
  const code = path.join(raiz, 'acme-code');
  for (const r of [specs, code]) { fs.mkdirSync(r); git(r, 'init', '-q', '-b', 'main'); }
  escribir(path.join(code, 'src', 'a.js'), 'module.exports = 1;\n');
  git(code, 'add', '.'); git(code, 'commit', '-q', '-m', 'inicio');
  escribir(path.join(specs, '.tycon', 'advisors.yaml'), 'evidence:\n  companion_repos:\n    - acme-code\n');
  const story = path.join(specs, 'specs', `story-${STORY_ID}-acme.md`);
  const declarados = ['  - (acme-code) src/a.js', '  - specs/notas.md', ...propio.map((p) => `  - ${p}`)];
  escribir(story, `---\nstory: "${STORY_ID}"\nstatus: in-progress\nfiles_to_create: []\nfiles_to_modify:\n${declarados.join('\n')}\n---\n\n# Story ${STORY_ID}\n`);
  escribir(path.join(specs, 'specs', 'sprint-status.yaml'), 'a: backlog\n');
  escribir(path.join(specs, 'scripts', 'viejo.js'), 'module.exports = 0;\n');
  git(specs, 'add', '.'); git(specs, 'commit', '-q', '-m', 'inicio');
  const baseSha = git(specs, 'rev-parse', 'HEAD');
  // lo que hace la corrida del repo de la historia: sólo documentación
  escribir(path.join(specs, 'specs', 'sprint-status.yaml'), 'a: in-progress\n');
  const casa = path.join(raiz, 'casa');
  const estado = stateDir(casa);
  fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
  const marcador = { storyId: STORY_ID, storyPath: story, repoPath: specs, baseSha, sessionId: 's-specs', startedAt: '2026-11-21T10:00:00.000Z' };
  fs.writeFileSync(path.join(estado, 'active', 's-specs.json'), JSON.stringify(marcador));
  if (verCorrida) {
    fs.writeFileSync(path.join(estado, 'active', 's-code.json'), JSON.stringify({ storyId: STORY_ID, repoPath: code, sessionId: 's-code',
      startedAt: '2026-11-21T10:05:00.000Z', ...marcadorDelHermano }));
  }
  return { raiz, specs, code, story, marcador, estado, casa };
}
// el portón del pase de la corrida de `acme-specs`, por su línea de comandos
function porton(c, { files = [], extra = [] } = {}) {
  const env = { PATH: process.env.PATH, HOME: c.casa, USERPROFILE: c.casa, TYCON_SESSION_ID: 's-specs' };
  const r = spawnSync(process.execPath, [PIPELINE, 'deep-review-gate', '--repo', c.specs, '--story', c.story, ...extra, '--files', ...files],
    { encoding: 'utf8', env, cwd: c.specs });
  assert.strictEqual(r.status, 0, `el portón salió ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
const consultar = (c, extra = {}) => dp.paseDelegado({ repo: c.specs, story: c.story, files: [], filesDeclarado: true, marcador: c.marcador, estado: c.estado, ...extra });

// T6 Delegate_NoOwnCodeAndVisibleCompanionRun_SkipsWithoutAsking @story-8.238 @ac-6
// 🔴 Falla con: la corrida sin código propio que pregunta por el pase aunque la corrida del hermano lo decide.
test('T6 Delegate_NoOwnCodeAndVisibleCompanionRun_SkipsWithoutAsking @story-8.238 @ac-6', (t) => {
  const c = armar(t);
  const d = consultar(c);
  assert.strictEqual(d.ok, true, d.motivo);
  assert.strictEqual(d.hermanos.length, 1);
  assert.strictEqual(d.hermanos[0].sesion, 's-code');
  const g = porton(c);
  assert.strictEqual(g.run, false, g.reason);
  assert.strictEqual(g.decision, 'delegate', g.reason);
  assert.strictEqual(g.question, undefined, 'no se pregunta');
  assert.match(g.reason, /acme-code/);
  assert.strictEqual(g.delegated_to[0].sesion, 's-code');
});

// T7 Delegate_CompanionRunNotVisible_AsksAsToday @story-8.238 @ac-7
// 🔴 Falla con: dejarle el pase a una corrida del hermano que no se ve, o un «no» sin el motivo.
test('T7 Delegate_CompanionRunNotVisible_AsksAsToday @story-8.238 @ac-7', (t) => {
  const c = armar(t, { verCorrida: false });
  const d = consultar(c);
  assert.strictEqual(d.ok, false);
  assert.match(d.motivo, /no veo una ejecución abierta de la historia 9\.1 en acme-code/);
  const g = porton(c);
  assert.strictEqual(g.decision, 'ask', g.reason);
  assert.match(g.delegation.motivo, /no veo una ejecución abierta/);
  // una ejecución del hermano de otra historia, o ya cerrada, tampoco se ve
  for (const otro of [{ storyId: '9.2' }, { cierre: { estado: 'completa' } }]) {
    const c2 = armar(t, { marcadorDelHermano: otro });
    assert.strictEqual(consultar(c2).ok, false, JSON.stringify(otro));
  }
});

// T8 Delegate_OwnCodeChanged_DoesNotDelegate @story-8.238 @ac-7
// 🔴 Falla con: un cambio de código del repo propio (commiteado, sin commitear o nuevo) que queda sin pase.
test('T8 Delegate_OwnCodeChanged_DoesNotDelegate @story-8.238 @ac-7', (t) => {
  const commiteado = armar(t);
  escribir(path.join(commiteado.specs, 'scripts', 'nuevo.js'), 'module.exports = 2;\n');
  git(commiteado.specs, 'add', '.'); git(commiteado.specs, 'commit', '-q', '-m', 'código');
  const sinCommitear = armar(t);
  escribir(path.join(sinCommitear.specs, 'scripts', 'viejo.js'), 'module.exports = 3;\n');
  const nuevo = armar(t);
  escribir(path.join(nuevo.specs, 'scripts', 'otro.sh'), 'echo hola\n');
  for (const [caso, c] of [['commiteado', commiteado], ['sin commitear', sinCommitear], ['nuevo', nuevo]]) {
    const d = consultar(c);
    assert.strictEqual(d.ok, false, caso);
    assert.match(d.motivo, /el repo de la corrida tiene código cambiado/, caso);
  }
});

// T9 Delegate_BaseNotFromRunMarker_DoesNotDelegate @story-8.238 @ac-7
// 🔴 Falla con: medir contra la bifurcación o HEAD (un .md sin commitear sobre código commiteado parecería sólo
//    documentación).
test('T9 Delegate_BaseNotFromRunMarker_DoesNotDelegate @story-8.238 @ac-7', (t) => {
  const c = armar(t);
  for (const marcador of [{ ...c.marcador, baseSha: undefined }, { ...c.marcador, baseSha: '0000000000000000000000000000000000000000' }]) {
    const d = consultar(c, { marcador });
    assert.strictEqual(d.ok, false);
    assert.match(d.motivo, /la base no sale del marcador de la corrida/);
  }
});

// T10 Delegate_FilesBringCode_DoesNotDelegate @story-8.238 @ac-7
// 🔴 Falla con: una corrida que dice traer código (en `--files`) y no corre su pase; o sin `--files`.
test('T10 Delegate_FilesBringCode_DoesNotDelegate @story-8.238 @ac-7', (t) => {
  const c = armar(t);
  const conCodigo = consultar(c, { files: [path.join(c.code, 'src', 'a.js')] });
  assert.strictEqual(conCodigo.ok, false);
  assert.match(conCodigo.motivo, /--files trae código/);
  const sinFiles = consultar(c, { files: [], filesDeclarado: false });
  assert.strictEqual(sinFiles.ok, false);
  assert.match(sinFiles.motivo, /sin --files/);
  // documentación en `--files` no cambia nada
  assert.strictEqual(consultar(c, { files: [path.join(c.specs, 'specs', 'sprint-status.yaml')] }).ok, true);
});

// T11 Delegate_CodeDeclaredInOwnRepo_DoesNotDelegate @story-8.238 @ac-7
// 🔴 Falla con: una historia que declara código en su propio repo y se queda sin pase porque todavía no lo escribió.
test('T11 Delegate_CodeDeclaredInOwnRepo_DoesNotDelegate @story-8.238 @ac-7', (t) => {
  const c = armar(t, { propio: ['scripts/viejo.js'] });
  const d = consultar(c);
  assert.strictEqual(d.ok, false);
  assert.match(d.motivo, /la historia declara código en el repo de la corrida/);
});

// T12 Delegate_ExplicitRunRequestsStillRun @story-8.238 @ac-8
// 🔴 Falla con: dejarle el pase al hermano por encima de un pedido explícito de correr o de la superficie compartida.
test('T12 Delegate_ExplicitRunRequestsStillRun @story-8.238 @ac-8', (t) => {
  const c = armar(t);
  assert.strictEqual(consultar(c).ok, true, consultar(c).motivo);
  for (const flag of ['--deep-review', '--ultracode']) {
    const g = porton(c, { extra: [flag] });
    assert.strictEqual(g.run, true, `${flag}: ${g.reason}`);
  }
  escribir(path.join(c.specs, '.tycon', 'advisors.yaml'), 'deep_review: always\nevidence:\n  companion_repos:\n    - acme-code\n');
  assert.strictEqual(porton(c).run, true, 'deep_review: always del repo');
  escribir(path.join(c.specs, '.tycon', 'advisors.yaml'), 'deep_review_always_paths:\n  - specs/**\nevidence:\n  companion_repos:\n    - acme-code\n');
  const g = porton(c, { files: [path.join(c.specs, 'specs', 'sprint-status.yaml')] });
  assert.strictEqual(g.run, true, `superficie compartida: ${g.reason}`);
});
