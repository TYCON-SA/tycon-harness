'use strict';
// codegraph-local.test.js — CodeGraph leaves nothing to commit in a shared repo and says what it leaves on: the index goes
// to git's local exclude (never to .gitignore), the pipeline's hint names the harness installer, --no-auto removes the
// session hook, and the closing text and the plan line say what the automatic mode does.
// Nothing reads the real HOME: homes, repos and binaries are toys.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const H = require(path.join(ROOT, 'scripts', 'setup', 'harness.js'));
const P = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'pipeline.js'));
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'codegraph-session-hook.sh');
const INSTALLER = path.join(ROOT, 'scripts', 'setup', 'install-codegraph.sh');

const onWindows = process.platform === 'win32' ? 'los binarios falsos y los guiones son de sh' : false;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// A repo with one commit and a shared .gitignore.
function repo(gitignore = 'node_modules/\n') {
  const dir = tmp('cgl-repo-');
  execFileSync('git', ['init', '-q', dir]);
  fs.writeFileSync(path.join(dir, '.gitignore'), gitignore);
  fs.writeFileSync(path.join(dir, 'a.js'), 'export const a = 1;\n');
  const id = ['-c', 'user.name=t', '-c', `user.email=t${'@'}acme.example`, '-c', 'maintenance.auto=false'];
  execFileSync('git', ['-C', dir, ...id, 'add', '-A']);
  execFileSync('git', ['-C', dir, ...id, 'commit', '-qm', 'x'], { env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-20T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-20T12:00:00Z' } });
  return dir;
}
const excludeOf = (dir) => {
  const p = execFileSync('git', ['-C', dir, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' }).trim();
  const abs = path.isAbsolute(p) ? p : path.join(dir, p);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
};
// Fake codegraph (init makes .codegraph/), claude and npm first in the PATH; the real node, python3 and git after.
function fakeBin() {
  const bin = tmp('cgl-bin-');
  fs.writeFileSync(path.join(bin, 'codegraph'), '#!/bin/sh\ncase "$1" in init) mkdir -p "${3:-$PWD}/.codegraph" ;; --version) echo 1.6.2 ;; esac\nexit 0\n', { mode: 0o755 });
  for (const n of ['claude', 'npm']) fs.writeFileSync(path.join(bin, n), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return bin;
}
const envWith = (bin, home) => ({ HOME: home, PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), TYCON_NO_BOOTSTRAP_HEAL: '1' });
const runHook = (cwd, bin, home) => spawnSync('bash', [HOOK], { cwd, env: envWith(bin, home), encoding: 'utf8', input: '' });
const runInstaller = (args, cwd, bin, home) => spawnSync('bash', [INSTALLER, ...args], { cwd, env: envWith(bin, home), encoding: 'utf8', input: '' });

test('T1 Hook_ExcludeYNoGitignore @story-8.75.1 @ac-1: el gancho deja .codegraph/ en el exclude local y no toca el .gitignore', { skip: onWindows }, () => {
  for (const gi of ['node_modules/\n', 'node_modules/\n.codegraph/\n']) {
    const dir = repo(gi);
    runHook(dir, fakeBin(), tmp('cgl-home-'));
    assert.strictEqual(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), gi, 'el .gitignore queda como estaba');
    assert.match(excludeOf(dir), /^\.codegraph\/$/m);
    assert.strictEqual(execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }), '', 'nada para subir');
  }
});

test('T2 Hook_WorktreeYUnaVez @story-8.75.1 @ac-1: en un worktree va al exclude que git usa, una sola vez', { skip: onWindows }, () => {
  const main = repo();
  const wt = path.join(tmp('cgl-wt-'), 'wt');
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'otra', wt]);
  const bin = fakeBin();
  const home = tmp('cgl-home-');
  runHook(wt, bin, home);
  fs.rmSync(path.join(wt, '.codegraph', '.tycon-setup-done'), { force: true });
  runHook(wt, bin, home);
  assert.strictEqual((excludeOf(wt).match(/^\.codegraph\/$/gm) || []).length, 1, excludeOf(wt));
  assert.strictEqual(execFileSync('git', ['-C', wt, 'status', '--porcelain'], { encoding: 'utf8' }), '');
});

test('T3 Instalador_ExcludeYSinRepo @story-8.75.1 @ac-1 @ac-2: el instalador usa el exclude; sin repo no escribe nada y lo dice', { skip: onWindows }, () => {
  const dir = repo();
  const r = runInstaller(['--repo', '--no-auto', dir], dir, fakeBin(), tmp('cgl-home-'));
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'node_modules/\n');
  assert.match(excludeOf(dir), /^\.codegraph\/$/m);
  // a folder that is not a repo: nothing written, one line that says so
  const loose = tmp('cgl-suelta-');
  fs.writeFileSync(path.join(loose, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(loose, '.gitignore'), 'x/\n');
  const s = runInstaller(['--repo', '--no-auto', loose], loose, fakeBin(), tmp('cgl-home-'));
  assert.strictEqual(s.status, 0, s.stdout + s.stderr);
  assert.strictEqual(fs.readFileSync(path.join(loose, '.gitignore'), 'utf8'), 'x/\n');
  assert.match(s.stdout + s.stderr, /no es un repo de git: no anoté \.codegraph\//);
  // a project folder inside a repo: the index lives in that repo, so it goes to that repo's exclude and nothing is left to commit
  const outer = repo();
  const inner = path.join(outer, 'plugins', 'uno');
  fs.mkdirSync(inner, { recursive: true });
  fs.writeFileSync(path.join(inner, 'package.json'), '{}\n');
  execFileSync('git', ['-C', outer, '-c', 'user.name=t', '-c', `user.email=t${'@'}acme.example`, 'add', '-A']);
  execFileSync('git', ['-C', outer, '-c', 'user.name=t', '-c', `user.email=t${'@'}acme.example`, 'commit', '-qm', 'y']);
  const n = runInstaller(['--repo', '--no-auto', inner], inner, fakeBin(), tmp('cgl-home-'));
  assert.strictEqual(n.status, 0, n.stdout + n.stderr);
  assert.match(excludeOf(outer), /^\.codegraph\/$/m);
  assert.strictEqual(fs.readFileSync(path.join(outer, '.gitignore'), 'utf8'), 'node_modules/\n');
  assert.strictEqual(execFileSync('git', ['-C', outer, 'status', '--porcelain'], { encoding: 'utf8' }), '');
});

test('T4 Pipeline_AvisoNombraElInstalador @story-8.75.1 @ac-3: el aviso de herramientas faltantes nombra el instalador del arnés', () => {
  // the binary is there but the session has no server: the hint says how to wire it
  const out = P.computeToolingExpected(tmp('cgl-r-'), { integrations: { codegraph: true }, exec: () => '/usr/local/bin/codegraph\n', skillsDir: tmp('cgl-s-') });
  const cg = (out.expected || out).find((e) => e.name === 'codegraph');
  assert.ok(cg, JSON.stringify(out));
  const text = JSON.stringify(cg);
  assert.match(text, /install-codegraph/);
  assert.doesNotMatch(text, /`codegraph install`/);
});

test('T5 NoAuto_SacaElGancho @story-8.75.1 @ac-4: --no-auto saca el gancho de arranque y deja los demás', { skip: onWindows }, () => {
  const home = tmp('cgl-home-');
  fs.mkdirSync(path.join(home, '.claude'));
  const settings = path.join(home, '.claude', 'settings.json');
  const other = { type: 'command', command: 'node otro.js' };
  fs.writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [other] }, { hooks: [{ type: 'command', command: 'bash "/x/codegraph-session-hook.sh"', async: true }] }] }, model: 'opus' }));
  const r = runInstaller(['--tool-only', '--no-auto'], tmp('cgl-cwd-'), fakeBin(), home);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.deepStrictEqual(after.hooks.SessionStart, [{ hooks: [other] }]);
  assert.strictEqual(after.model, 'opus');
  assert.match(r.stdout, /saqué el modo automático/);
});

test('T6 Cierre_DiceModoSacarYReiniciar @story-8.75.1 @ac-5: al cerrar dice qué hace el modo automático, cómo sacarlo y que hay que reiniciar', { skip: onWindows }, () => {
  const r = runInstaller(['--tool-only'], tmp('cgl-cwd-'), fakeBin(), tmp('cgl-home-'));
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  for (const words of ['al abrir una sesión en un repo', 'lo indexa y lo registra', 'no corre en cada mensaje', '--no-auto', 'reiniciá Claude Code', 'aprobá el servidor']) {
    assert.ok(r.stdout.includes(words), `${words}\n${r.stdout}`);
  }
});

test('T7 Plan_DiceModoAutomatico y Ps1_MismoTexto @story-8.75.1 @ac-1 @ac-5 @ac-6: el renglón del plan, la nota del arnés y los .ps1', { skip: onWindows }, () => {
  // the real plan, with the team profile on and no binary
  const prof = tmp('cgl-prof-');
  fs.writeFileSync(path.join(prof, 'team-profile.json'), JSON.stringify({ integrations: { codegraph: true } }));
  const env = { HOME: tmp('cgl-home-'), PATH: [tmp('cgl-empty-'), '/usr/bin', '/bin'].join(path.delimiter), TYCON_PROFILE: path.join(prof, 'team-profile.json') };
  const out = H.installQuestions({ home: env.HOME, env, opts: { profile: 'minimal' }, tree: ROOT }, ROOT, null);
  assert.ok((out.head || []).some((l) => /CodeGraph: tu organización lo usa.*modo automático.*al abrir una sesión en un repo/.test(l)), JSON.stringify(out.head));
  // the note after a successful install
  const tree = tmp('cgl-tree-');
  fs.mkdirSync(path.join(tree, 'scripts', 'setup'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'scripts', 'setup', 'install-codegraph.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.match(H.codegraphInstall({ tree, env: { PATH: process.env.PATH, HOME: tmp('cgl-home-') } }).note, /reiniciá Claude Code y aprobá el servidor.*--no-auto/);
  for (const f of ['scripts/setup/install-codegraph.ps1', 'scripts/hooks/codegraph-session-hook.ps1']) {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.match(t, /--git-path['" ,]+info\/exclude/, f);
    assert.doesNotMatch(t, /Add-Content -LiteralPath \$Gi/, f);
  }
  const ps1 = fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'install-codegraph.ps1'), 'utf8');
  for (const words of ['al abrir una sesión en un repo', 'no corre en cada mensaje', '-NoAuto', 'reiniciá Claude Code', 'saqué el modo automático']) assert.ok(ps1.includes(words), words);
});

// A bin folder whose fake `claude` ends `mcp add` with the given code; without `claude` when claudeExit is null.
function binWithClaude(claudeExit) {
  const bin = fakeBin();
  fs.rmSync(path.join(bin, 'claude'));
  if (claudeExit !== null) fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\n[ "$2" = add ] && exit ${claudeExit}\nexit 0\n`, { mode: 0o755 });
  return bin;
}
const marker = (dir) => fs.existsSync(path.join(dir, '.codegraph', '.tycon-setup-done'));
// Only the toy bin and the system folders: a real `claude` installed next to node must not leak into these cases.
const closedEnv = (bin, home) => ({ HOME: home, PATH: [bin, '/usr/bin', '/bin'].join(path.delimiter), TYCON_NO_BOOTSTRAP_HEAL: '1' });
const runHookClosed = (cwd, bin, home) => spawnSync('bash', [HOOK], { cwd, env: closedEnv(bin, home), encoding: 'utf8', input: '' });

test('T8 Hook_MarcaSoloTrasRegistrar: la marca de listo se escribe sólo si el registro del servidor salió bien, y se reintenta', { skip: onWindows }, () => {
  const dir = repo();
  const home = tmp('cgl-home-');
  runHookClosed(dir, binWithClaude(1), home);
  assert.ok(fs.existsSync(path.join(dir, '.codegraph')), 'indexa aunque el registro falle');
  assert.strictEqual(marker(dir), false, 'registro fallido: sin marca, la próxima sesión lo reintenta');
  runHookClosed(dir, binWithClaude(0), home);
  assert.strictEqual(marker(dir), true, 'registro bueno: queda la marca');
  // without the claude CLI the index is the whole job: it indexes and marks
  const solo = repo();
  runHookClosed(solo, binWithClaude(null), home);
  assert.ok(fs.existsSync(path.join(solo, '.codegraph')), 'sin claude indexa igual');
  assert.strictEqual(marker(solo), true, 'sin claude, con el índice hecho, queda la marca');
});

const PWSH_BIN = spawnSync('sh', ['-c', 'command -v pwsh'], { encoding: 'utf8' }).stdout.trim();
const HOOK_PS1 = path.join(ROOT, 'scripts', 'hooks', 'codegraph-session-hook.ps1');
const runHookPs1 = (cwd, bin, home) => spawnSync(PWSH_BIN, ['-NoProfile', '-NonInteractive', '-File', HOOK_PS1], { cwd, env: closedEnv(bin, home), encoding: 'utf8', input: '' });

test('T9 HookPs1_IndexaSinClaudeYMarcaSoloTrasRegistrar: el gancho de Windows indexa sin claude y marca sólo tras registrar', { skip: onWindows || (!PWSH_BIN && 'sin pwsh') }, () => {
  const home = tmp('cgl-home-');
  const solo = repo();
  runHookPs1(solo, binWithClaude(null), home);
  assert.ok(fs.existsSync(path.join(solo, '.codegraph')), 'sin claude indexa igual');
  assert.strictEqual(marker(solo), true, 'sin claude, con el índice hecho, queda la marca');
  const dir = repo();
  runHookPs1(dir, binWithClaude(1), home);
  assert.ok(fs.existsSync(path.join(dir, '.codegraph')));
  assert.strictEqual(marker(dir), false, 'registro fallido: sin marca');
  runHookPs1(dir, binWithClaude(0), home);
  assert.strictEqual(marker(dir), true, 'registro bueno: queda la marca');
});
