'use strict';
// trigger-for-files.test.js — `check-trigger-without-docs.js --repo <dir> --changed <file>…`: does this change to this repo
// fire its CI? The answer comes from the pipelines as they are in origin/main, with the same Azure rules the script
// already simulates; "could not tell" is exit 2, never "does not fire". And step 9 commits the `done` and says so.
// Repos and pipelines are toys in temporary folders; no network.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'check-trigger-without-docs.js');
const STEP9 = path.join(ROOT, 'skills', 'tycon-pipeline', 'steps', 'close-work-item.md');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ID = ['-c', 'user.name=t', '-c', `user.email=t${'@'}acme.example`, '-c', 'maintenance.auto=false'];
const FIXED = { ...process.env, GIT_AUTHOR_DATE: '2026-10-20T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-20T12:00:00Z' };

// A repo whose origin/main has the given files: a bare remote, a clone, one commit pushed.
function repoWith(files) {
  const bare = path.join(tmp('tff-remote-'), 'r.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const dir = path.join(tmp('tff-clone-'), 'r');
  execFileSync('git', ['clone', '-q', bare, dir], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'checkout', '-q', '-B', 'main']);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  execFileSync('git', ['-C', dir, ...ID, 'add', '-A']);
  execFileSync('git', ['-C', dir, ...ID, 'commit', '-qm', 'x', '--allow-empty'], { env: FIXED });
  execFileSync('git', ['-C', dir, 'push', '-q', 'origin', 'main'], { stdio: 'ignore' });
  return dir;
}
const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', input: '' });

test('T1 Changed_SinTrigger_Dispara @story-7.47 @ac-1: sin trigger, Azure dispara con todo', () => {
  const dir = repoWith({ 'azure-pipelines-ci.yml': 'pool:\n  vmImage: ubuntu-latest\nsteps:\n  - script: echo hola\n', 'specs/story-1.md': 'x\n' });
  const r = run(['--repo', dir, '--changed', 'specs/story-1.md']);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /azure-pipelines-ci\.yml.*dispara.*\(raíz\)/);
});

test('T2 Changed_SpecsExcluido_NoDispara @story-7.47 @ac-1: specs/ excluido no dispara; src/ sí, con su patrón', () => {
  const yml = "trigger:\n  branches:\n    include: [main]\n  paths:\n    include:\n      - '*'\n    exclude:\n      - 'specs/**'\n      - '.advisors/**'\n";
  const dir = repoWith({ 'azure-pipelines-ci.yml': yml });
  const docs = run(['--repo', dir, '--changed', 'specs/story-1.md', '.advisors/pipeline-runs/x/findings.json']);
  assert.strictEqual(docs.status, 0, docs.stdout + docs.stderr);
  assert.match(docs.stdout, /no dispara/);
  const code = run(['--repo', dir, '--changed', 'specs/story-1.md', 'src/Program.cs']);
  assert.strictEqual(code.status, 1, code.stdout + code.stderr);
  assert.match(code.stdout, /src\/Program\.cs/);
});

test('T3 Changed_TriggerNone_NoDispara @story-7.47 @ac-1: trigger: none no se dispara por empuje', () => {
  const dir = repoWith({ 'pipelines/azure-pipelines-prod.yml': 'trigger: none\nsteps:\n  - script: echo prod\n' });
  const r = run(['--repo', dir, '--changed', 'src/Program.cs']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /azure-pipelines-prod\.yml.*trigger: none/);
});

test('T4 Changed_LeeOrigin_NoElDisco @story-7.47 @ac-1: contesta con el pipeline de origin/main, no con el del disco', () => {
  const dir = repoWith({ 'azure-pipelines-ci.yml': "trigger:\n  paths:\n    exclude:\n      - 'specs/**'\n" });
  // on disk, someone removed the exclude: the answer is still the published one
  fs.writeFileSync(path.join(dir, 'azure-pipelines-ci.yml'), 'steps:\n  - script: echo\n');
  const r = run(['--repo', dir, '--changed', 'specs/story-1.md']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

test('T5 Changed_NoSe_Sale2 @story-7.47 @ac-2: sin pipelines o sin origin/main sale 2 con el motivo, nunca «no dispara»', () => {
  const none = repoWith({ 'README.md': 'x\n' });
  const a = run(['--repo', none, '--changed', 'specs/story-1.md']);
  assert.strictEqual(a.status, 2, a.stdout + a.stderr);
  assert.match(a.stdout, /no pude saber si dispara la CI/);
  assert.doesNotMatch(a.stdout, /no dispara/);
  const loose = tmp('tff-sin-origin-');
  execFileSync('git', ['init', '-q', loose]);
  const b = run(['--repo', loose, '--changed', 'specs/story-1.md']);
  assert.strictEqual(b.status, 2, b.stdout + b.stderr);
  assert.match(b.stdout, /no pude saber si dispara la CI.*origin\/main/);
  const c = run(['--repo', loose]);
  assert.strictEqual(c.status, 2, 'sin --changed no hay nada que medir');
});

test('T6 Paso9_CommiteaYDiceSiDispara @story-7.47 @ac-3 @ac-4 @ac-5: el paso 9 commitea el done, lo lleva a main y dice si dispara', () => {
  const t = fs.readFileSync(STEP9, 'utf8');
  for (const words of ['docs(specs): <id> — status done', 'origin/main', '--auto-complete true --squash false', '--repo', '--changed',
    'no pude saber si dispara la CI', 'merge-pr.js plan', 'checkpoint del cierre', 'acción pendiente']) {
    assert.ok(t.includes(words), words);
  }
  // origin is fetched before asking (the script reads origin/main), and the story is compared before it is copied
  const section = t.slice(t.indexOf('## Acción — llevar el `done` a main'));
  assert.ok(section.indexOf('fetch origin') < section.indexOf('--changed'), 'el fetch va antes de preguntar');
  assert.match(section, /diff --no-index[^\n]*<ruta de la story> <story en el checkout>/);
  // the final message no longer claims the done is in main on its own
  assert.doesNotMatch(t, /- Frontmatter `\.md` → status: done \(source of truth durable\)\./);
});
