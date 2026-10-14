'use strict';
// operations-github-workflows.test.js — los workflows modelo de GitHub Actions para los procesos de la noche (story 8.31,
// T1 a T8). Lee los YAML como texto (no hay biblioteca de YAML en el arnés, a propósito), corre de verdad el bloque que
// elige el arnés, prepare-tree.sh, operations-auth.sh y clone-repos.sh sobre repos de juguete, y nunca toca la red.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DIR = path.join(ROOT, 'pipelines', 'operations', 'github');
const EX = path.join(ROOT, 'pipelines', 'operations', 'examples', 'github');
const WORKFLOWS = ['dependency-audit.yml', 'stage-metrics.yml', 'team-dashboard.yml'];
const SCRIPTS = ['prepare-tree.sh', 'clone-repos.sh', 'operations-auth.sh', 'annotate.sh'];
const FAKE_GH = path.join(__dirname, 'lib', 'fake-gh.js');
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
const { check } = require(path.join(ROOT, 'scripts', 'ci', 'check-public-workflow.js'));

/** Los pasos de un workflow: bloques que empiezan en `      - ` (seis espacios) hasta el siguiente. */
function steps(text) {
  const out = [];
  let cur = null;
  for (const l of text.split('\n')) {
    if (/^ {6}- /.test(l)) { if (cur) out.push(cur.join('\n')); cur = [l]; } else if (cur && (/^ {7,}\S/.test(l) || l.trim() === '')) cur.push(l);
    else if (cur && /^\S/.test(l)) { out.push(cur.join('\n')); cur = null; }
  }
  if (cur) out.push(cur.join('\n'));
  return out;
}
/** Las líneas de código de los `run:` (una sola línea o bloque `|`). */
function runLines(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^( *)run: ?(.*)$/);
    if (!m) continue;
    if (m[2] && m[2] !== '|') { out.push(m[2]); continue; }
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() && (lines[j].length - lines[j].trimStart().length) <= m[1].length) break;
      out.push(lines[j]);
    }
  }
  return out;
}

/** Las reglas de la decisión 16 y del AC 2, con su id; [] = cumple. */
function brokenRules(text) {
  const broken = [];
  // las del ci.yml que valen acá, por el control que ya existe (no se copian)
  for (const b of check(text)) if (['pull-request-target', 'uses-by-sha'].includes(b.rule)) broken.push(b.rule);
  const on = text.match(/^on:\n((?: {2}.*\n|\n)*)/m);
  const triggers = on ? [...on[1].matchAll(/^ {2}([a-z_]+):/gm)].map((x) => x[1]).sort().join(',') : '';
  if (triggers !== 'schedule,workflow_dispatch') broken.push('triggers');
  const perms = [...text.matchAll(/^( *)permissions:/gm)];
  if (perms.length !== 1 || perms[0][1] !== '' || !/^permissions:\n {2}contents: write\n(?! {2}\S)/m.test(text)) broken.push('permissions');
  const secrets = [...text.matchAll(/secrets\.([A-Za-z_]+)/g)].map((x) => x[1]);
  if (secrets.some((s) => !['HARNESS_ORG_TOKEN', 'TELEGRAM_BOT_TOKEN'].includes(s))) broken.push('secrets');
  // cada secreto (y el token del workflow) sólo como valor de una variable de env de un paso
  for (const l of text.split('\n')) {
    if (/secrets\.|github\.token/.test(l) && !/^ {10}[A-Z_]+: \$\{\{ (secrets\.[A-Z_]+|github\.token) \}\}$/.test(l)) { broken.push('secret-scope'); break; }
  }
  for (const s of steps(text).filter((x) => /uses: actions\/checkout@/.test(x))) {
    if (!/persist-credentials: false/.test(s)) { broken.push('persist-credentials'); break; }
  }
  if (runLines(text).some((l) => /\$\{\{/.test(l))) broken.push('expression-in-run');
  return [...new Set(broken)];
}

test('T1 GhModels_FilesInPlace: los tres workflows, los cuatro guiones, la página y los tres ejemplos que validan', () => {
  for (const f of [...WORKFLOWS, ...SCRIPTS, 'README.md']) assert.ok(fs.existsSync(path.join(DIR, f)), `falta pipelines/operations/github/${f}`);
  const tr = require(path.join(ROOT, 'scripts', 'lib', 'team-repos.js')).load(path.join(EX, 'team-repos.json'));
  assert.ok(tr.ok, JSON.stringify(tr.problems));
  assert.strictEqual(tr.data.operations.platform, 'github');
  const ops = require(path.join(ROOT, 'scripts', 'lib', 'operations-config.js')).load(path.join(EX, 'operations.json'));
  assert.ok(ops.ok, JSON.stringify(ops.problems));
  const repos = JSON.parse(fs.readFileSync(path.join(EX, 'repos.json'), 'utf8'));
  assert.ok(repos.repos.every((r) => /^[^/]+\/[^/]+$/.test(r.github) && !r.ado), 'el ejemplo declara repos de GitHub y ninguno de Azure');
  assert.strictEqual(repos.github.issues_enabled, false, 'los issues nacen apagados');
  // ninguno vive donde correría sobre el repo público
  assert.ok(!fs.existsSync(path.join(ROOT, '.github', 'workflows', 'dependency-audit.yml')));
});

test('T2 GhModels_SecurityRules: los tres cumplen, y una copia alterada por regla sale roja', () => {
  for (const f of WORKFLOWS) assert.deepStrictEqual(brokenRules(read(f)), [], `${f} rompe reglas`);
  const t = read('dependency-audit.yml');
  const alteraciones = {
    'pull-request-target': t.replace('  workflow_dispatch:', '  pull_request_target:\n  workflow_dispatch:'),
    triggers: t.replace('  workflow_dispatch:', '  push:\n  workflow_dispatch:'),
    'uses-by-sha': t.replace(/actions\/setup-node@[0-9a-f]{40} # v7\.0\.0/, 'actions/setup-node@v7'),
    permissions: t.replace('permissions:\n  contents: write', 'permissions:\n  contents: write\n  issues: write'),
    secrets: t.replace('secrets.TELEGRAM_BOT_TOKEN', 'secrets.OTRO_TOKEN'),
    'secret-scope': t.replace('    timeout-minutes: 90\n    env:\n', '    timeout-minutes: 90\n    env:\n      TODO_EL_TRABAJO: ${{ secrets.HARNESS_ORG_TOKEN }}\n'),
    'persist-credentials': t.replace('          path: ops\n          persist-credentials: false', '          path: ops'),
    'expression-in-run': t.replace('echo "issues: $(', 'echo "${{ inputs.harness_ref }}"\n          echo "issues: $('),
  };
  for (const [rule, alterado] of Object.entries(alteraciones)) {
    assert.notStrictEqual(alterado, t, `la alteración de ${rule} no cambió nada`);
    assert.ok(brokenRules(alterado).includes(rule), `la copia alterada para ${rule} no salió roja: ${brokenRules(alterado)}`);
  }
});

test('T3 GhModels_EffectsGateEveryWrite: EFFECTS con la forma que vale en una corrida programada; todo paso con efectos lo pide', () => {
  const writers = [{ re: /push-nightly-data\.js save/, main: true }, { re: /work-items\.js run/, main: false }, { re: /daily-summary\.js deliver/, main: false }];
  let seen = 0;
  for (const f of WORKFLOWS) {
    const t = read(f);
    assert.match(t, /^ {6}EFFECTS: \$\{\{ github\.event_name == 'schedule' \|\| inputs\.effects \}\}$/m, `${f}: EFFECTS no tiene la forma literal`);
    assert.doesNotMatch(t, /if: .*inputs\.effects/, `${f}: un if: con inputs.effects directo (en una corrida programada está vacío)`);
    for (const s of steps(t)) {
      for (const w of writers) {
        if (!w.re.test(s)) continue;
        seen += 1;
        const cond = (s.match(/^ {8}if: (.*)$/m) || [])[1] || '';
        assert.match(cond, /env\.EFFECTS == 'true'/, `${f}: el paso con ${w.re} no pide efectos (${cond || 'sin if'})`);
        if (w.main) assert.match(cond, /github\.ref == 'refs\/heads\/main'/, `${f}: el paso con ${w.re} guarda: sólo desde main`);
      }
    }
  }
  assert.ok(seen >= 5, `se miraron los pasos con efectos (${seen})`);
});

test('T4 GhModels_NoOrgLiterals: ningún <dueño>/<repo> escrito fuera de uses:, ninguna dirección de Azure ni la superposición del equipo', () => {
  for (const f of [...WORKFLOWS, ...SCRIPTS]) {
    const t = read(f);
    for (const l of t.split('\n')) {
      if (/^\s*(- )?uses: /.test(l) || /^\s*#/.test(l)) continue;
      const m = l.match(/(?:github\.com\/|repository: )([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)/);
      assert.ok(!m, `${f}: un repo escrito: ${l.trim()}`);
    }
    assert.doesNotMatch(t, /dev\.azure\.com/, `${f}: una dirección de Azure`);
    assert.doesNotMatch(t, /overlay-harness|HARNESS_AFTER_CUT/, `${f}: la superposición del equipo`);
  }
});

// ── los guiones, corridos de verdad ──────────────────────────────────────────────────────────────────────────
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function cleanEnv(extra = {}) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(GIT_|HARNESS_|GITHUB_|OPS_|ORG_|GH_|BUILD_|SYSTEM_|TYCON_)/.test(k)) e[k] = v;
  return { ...e, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), 'ops-github-no-global'),
    GIT_AUTHOR_NAME: 'Lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'Lab', GIT_COMMITTER_EMAIL: 'lab@example.com', ...extra };
}
function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { env: cleanEnv(), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
}
const teamRepos = (ops = 'acme/operations', pub = { platform: 'github', org: 'acme', repo: 'harness' }) => `${JSON.stringify({ version: 1, public: pub,
  profile: { platform: 'github', org: 'acme', repo: 'profile' }, operations: { platform: 'github', org: ops.split('/')[0], repo: ops.split('/')[1] } })}\n`;

/** El runner: el arnés en <ws>/harness (con los guiones reales) y el repo de operaciones en <ws>/ops, con su remoto. */
function runner(opsFiles) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-github-'));
  dirs.push(base);
  const ws = path.join(base, 'ws');
  const h = path.join(ws, 'harness');
  fs.mkdirSync(h, { recursive: true });
  git(h, ['init', '--quiet', '-b', 'main']);
  write(h, { 'scripts/a.js': 'module.exports = 1;\n' });
  for (const rel of ['scripts/ci/harness-tree.js', 'scripts/lib/team-repos.js', ...SCRIPTS.map((s) => `pipelines/operations/github/${s}`)]) {
    fs.mkdirSync(path.dirname(path.join(h, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(h, rel));
  }
  git(h, ['add', '-A']); git(h, ['commit', '--quiet', '-m', 'el arnés']);
  git(h, ['remote', 'add', 'origin', 'https://example.com/acme/harness.git']);
  const opsRemote = path.join(base, 'operations.git');
  fs.mkdirSync(opsRemote);
  git(opsRemote, ['init', '--quiet', '--bare']);
  git(opsRemote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const seed = path.join(base, 'seed');
  git(base, ['clone', '--quiet', opsRemote, seed]);
  write(seed, opsFiles);
  git(seed, ['add', '-A', '-f']); git(seed, ['commit', '--quiet', '-m', 'operaciones']); git(seed, ['branch', '-M', 'main']);
  git(seed, ['push', '--quiet', 'origin', 'main']);
  git(base, ['clone', '--quiet', opsRemote, path.join(ws, 'ops')]);
  const envFile = path.join(base, 'github-env');
  fs.writeFileSync(envFile, '');
  return { base, ws, h, opsRemote, envFile };
}
function prepare(w, extra = {}) {
  const r = spawnSync('bash', [path.join(w.h, 'pipelines', 'operations', 'github', 'prepare-tree.sh')], { encoding: 'utf8',
    env: cleanEnv({ GITHUB_WORKSPACE: w.ws, GITHUB_REPOSITORY: 'acme/operations', GITHUB_ENV: w.envFile, OPS_TOKEN: 'token-de-prueba', OPS_REMOTE_URL: w.opsRemote, ...extra }) });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('T5 PrepareTree_CopiesAndRetargets: la lista encima en un commit local, los remotos, las tres variables, la guarda acepta, sin credenciales en disco', () => {
  const w = runner({
    'team-repos.json': teamRepos(),
    'operations.json': '{"version":1,"owners":{"default":"lider"}}\n',
    'scripts/nightly/dependencies/repos.json': '{"repos":[]}\n',
    '.dashboard/sdlc-stage-2026-01-01.json': '{}\n',
    'inbox/dependencies/pending/a1b2c3d4.yaml': 'id: a1b2c3d4\n',
    '.github/workflows/stage-metrics.yml': 'name: x\n',
    'scripts/a.js': 'module.exports = "pisado";\n',
  });
  const head = git(w.h, ['rev-parse', 'HEAD']);
  const r = prepare(w);
  assert.strictEqual(r.code, 0, r.out);
  for (const rel of ['team-repos.json', 'operations.json', 'scripts/nightly/dependencies/repos.json', '.dashboard/sdlc-stage-2026-01-01.json', 'inbox/dependencies/pending/a1b2c3d4.yaml']) {
    assert.ok(fs.existsSync(path.join(w.h, rel)), `${rel} quedó encima`);
  }
  assert.strictEqual(fs.readFileSync(path.join(w.h, 'scripts', 'a.js'), 'utf8'), 'module.exports = 1;\n', 'el código del arnés no lo pisa operaciones');
  assert.ok(!fs.existsSync(path.join(w.h, '.github')), '.github/ de operaciones no se trae');
  assert.match(r.out, /::warning::El repo de operaciones trae archivos que este armado no lee[^\n]*scripts\/a\.js/);
  assert.strictEqual(git(w.h, ['rev-parse', 'HEAD^']), head, 'un commit local encima del arnés');
  assert.strictEqual(git(w.h, ['log', '-1', '--format=%an']), 'github-actions[bot]');
  assert.strictEqual(git(w.h, ['remote', 'get-url', 'origin']), w.opsRemote);
  assert.strictEqual(git(w.h, ['remote', 'get-url', 'harness']), 'https://example.com/acme/harness.git');
  const env = Object.fromEntries(fs.readFileSync(w.envFile, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  assert.match(env.HARNESS_TREE || '', /^[0-9a-f]{64}@[0-9a-f]{40}$/);
  assert.strictEqual(env.HARNESS_COMMIT, head);
  assert.strictEqual(env.HARNESS_SOURCE, 'https://example.com/acme/harness.git');
  const guard = spawnSync(process.execPath, [path.join(w.h, 'scripts', 'ci', 'harness-tree.js'), '--check-tree', '--worktree', '--repo', w.h], { env: cleanEnv({ HARNESS_TREE: env.HARNESS_TREE }), encoding: 'utf8' });
  assert.strictEqual(guard.status, 0, guard.stderr);
  for (const d of [w.h, path.join(w.ws, 'ops')]) assert.doesNotMatch(fs.readFileSync(path.join(d, '.git', 'config'), 'utf8'), /extraheader/i, `${d}: una credencial en disco`);
  // operations-auth.sh: sólo variables del proceso, enmascaradas; ningún archivo
  const a = spawnSync('bash', ['-c', `. "${path.join(w.h, 'pipelines', 'operations', 'github', 'operations-auth.sh')}" && env | grep '^GIT_CONFIG_' | sort`], { encoding: 'utf8',
    env: cleanEnv({ OPS_TOKEN: 't0k3n', GITHUB_REPOSITORY: 'acme/operations', GITHUB_SERVER_URL: 'https://github.example' }) });
  assert.strictEqual(a.status, 0, a.stderr);
  assert.match(a.stdout, /^::add-mask::/m);
  assert.match(a.stdout, /GIT_CONFIG_COUNT=1/);
  assert.match(a.stdout, /GIT_CONFIG_KEY_0=http\.https:\/\/github\.example\/acme\/operations\.git\.extraheader/);
  assert.match(a.stdout, /GIT_CONFIG_VALUE_0=AUTHORIZATION: basic /);
  assert.doesNotMatch(a.stdout, /t0k3n/, 'el token no aparece en claro');
  const sinToken = spawnSync('bash', ['-c', `. "${path.join(w.h, 'pipelines', 'operations', 'github', 'operations-auth.sh')}"`], { encoding: 'utf8', env: cleanEnv() });
  assert.notStrictEqual(sinToken.status, 0, 'sin OPS_TOKEN no sigue');
});

test('T6 PrepareTree_FreshOrg_NotRed: un repo de operaciones recién creado no sale rojo', () => {
  const w = runner({ 'team-repos.json': teamRepos(), 'operations.json': '{"version":1,"owners":{"default":"lider"}}\n' });
  const r = prepare(w);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(!fs.existsSync(path.join(w.h, '.dashboard')), 'no inventa carpetas de datos');
});

test('T7 PrepareTree_And_PickHarness_Red: otro repo de operaciones, un team-repos roto, public de Azure y una referencia de pull request salen rojos', () => {
  let w = runner({ 'team-repos.json': teamRepos('acme/otro-repo') });
  let r = prepare(w);
  assert.strictEqual(r.code, 1, r.out); assert.match(r.out, /operations es acme\/otro-repo y el workflow corre en acme\/operations/);
  w = runner({ 'team-repos.json': teamRepos('ACME/Operations') });
  assert.strictEqual(prepare(w).code, 0, 'sin distinguir mayúsculas');
  w = runner({ 'team-repos.json': '{"version":1}\n' });
  r = prepare(w);
  assert.strictEqual(r.code, 1); assert.match(r.out, /team-repos\.json no valida: public: falta/);
  w = runner({ 'team-repos.json': teamRepos('acme/operations', { platform: 'azure', org: 'acme', project: 'P', repo: 'harness' }) });
  r = prepare(w);
  assert.strictEqual(r.code, 1); assert.match(r.out, /public\.platform es «azure»/);
  // el bloque que elige el arnés (antes de tenerlo): igual en los tres workflows, y corrido de verdad
  const bloques = WORKFLOWS.map((f) => read(f).match(/node - <<'JS'\n([\s\S]*?)\n {10}JS\n/)[1].replace(/^ {10}/gm, ''));
  assert.ok(bloques.every((b) => b === bloques[0]), 'el bloque que elige el arnés es el mismo en los tres');
  const elegir = (team, env) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-')); dirs.push(d);
    if (team !== null) fs.writeFileSync(path.join(d, 'team-repos.json'), team);
    const out = path.join(d, 'out'); fs.writeFileSync(out, '');
    const p = spawnSync(process.execPath, ['-'], { input: bloques[0], cwd: d, encoding: 'utf8', env: cleanEnv({ GITHUB_OUTPUT: out, ...env }) });
    return { code: p.status, out: `${p.stdout}${p.stderr}`, outputs: fs.readFileSync(out, 'utf8') };
  };
  let p = elegir(teamRepos(), { VAR_REF: 'v1.2.3' });
  assert.strictEqual(p.code, 0, p.out); assert.strictEqual(p.outputs, 'repository=acme/harness\nref=v1.2.3\n');
  p = elegir(teamRepos(), { INPUT_REF: 'mi-rama', VAR_REF: 'v1' });
  assert.match(p.outputs, /ref=mi-rama/, 'la corrida a mano gana');
  assert.match(elegir(teamRepos(), {}).outputs, /ref=main/);
  for (const ref of ['refs/pull/1/head', 'a;b', '../x', '-x']) {
    p = elegir(teamRepos(), { INPUT_REF: ref });
    assert.strictEqual(p.code, 1, `${ref} tenía que salir rojo`); assert.match(p.out, /::error::la referencia del arnés/);
  }
  p = elegir(teamRepos('acme/operations', { platform: 'github', org: 'acme;rm', repo: 'h' }), {});
  assert.strictEqual(p.code, 1); assert.match(p.out, /no es un nombre de GitHub/);
  assert.strictEqual(elegir(null, {}).code, 1);
});

test('T8 CloneRepos_DeclaredAndOrg: los declarados con el token sólo en la línea de comando; la organización paginada, con prefijo y sin copias', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-repos-')); dirs.push(base);
  const server = path.join(base, 'server');
  const mkRepo = (full, files) => {
    const bare = path.join(server, `${full}.git`);
    fs.mkdirSync(bare, { recursive: true });
    git(bare, ['init', '--quiet', '--bare']); git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    const s = path.join(base, 'seed', full);
    git(base, ['clone', '--quiet', bare, s]);
    write(s, files); git(s, ['add', '-A']); git(s, ['commit', '--quiet', '-m', 'x']); git(s, ['branch', '-M', 'main']); git(s, ['push', '--quiet', 'origin', 'main']);
  };
  mkRepo('acme/web', { 'package.json': '{}\n', 'specs/story-1.md': '# s\n' });
  mkRepo('acme/api', { 'api.sln': '\n' });
  mkRepo('acme/harness-copy', { 'README.md': '# copia\n' });
  for (const i of [0, 1]) mkRepo(`acme/extra-${i}`, { 'README.md': `# ${i}\n` });
  const sh = path.join(DIR, 'clone-repos.sh');
  const env = cleanEnv({ ORG_TOKEN: 't0k3n', GITHUB_SERVER_URL: `file://${server}` });
  // --declared
  const dest = path.join(base, 'declared');
  let r = spawnSync('bash', [sh, '--declared', dest], { input: 'acme/web\tacme/web\nacme/api\tacme/api\nsin/github\t\nacme/nope\tacme/nope\n', encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(dest, 'acme', 'web', 'package.json')) && fs.existsSync(path.join(dest, 'acme', 'api', 'api.sln')));
  assert.match(r.stdout, /sin\/github no declara «github: <dueño>\/<repo>»/);
  assert.match(r.stdout, /::warning::Repos NO clonados: sin\/github acme\/nope/);
  for (const d of ['web', 'api']) assert.doesNotMatch(fs.readFileSync(path.join(dest, 'acme', d, '.git', 'config'), 'utf8'), /extraheader/i, 'el token no queda en el clon');
  assert.doesNotMatch(r.stdout, /t0k3n/);
  r = spawnSync('bash', [sh, '--declared', dest], { input: '', encoding: 'utf8', env: cleanEnv({ GITHUB_SERVER_URL: `file://${server}` }) });
  assert.strictEqual(r.status, 1); assert.match(r.stdout, /Falta el secreto HARNESS_ORG_TOKEN/);
  // --org: 101 repos en el listado (dos páginas), prefijo, una copia del arnés declarada en team-repos.json
  const repos = [{ name: 'web' }, { name: 'api' }, { name: 'harness-copy' }, { name: 'extra-0' }, { name: 'extra-1' }];
  for (let i = 0; i < 96; i++) repos.push({ name: `otro-${i}` });
  const state = path.join(base, 'gh.json');
  fs.writeFileSync(state, JSON.stringify({ user: 'bot', owners: { acme: 'Organization' }, repos: { acme: repos } }));
  const tr = path.join(base, 'team-repos.json');
  fs.writeFileSync(tr, JSON.stringify({ version: 1, public: { platform: 'github', org: 'acme', repo: 'h' }, profile: { platform: 'github', org: 'acme', repo: 'p' },
    operations: { platform: 'github', org: 'acme', repo: 'o' }, harness_copies: [{ platform: 'github', org: 'acme', repo: 'harness-copy' }] }));
  const destOrg = path.join(base, 'org');
  const log = path.join(base, 'gh.log');
  r = spawnSync('bash', [sh, '--org', destOrg, '--team-repos', tr], { encoding: 'utf8', env: { ...env, OWNERS: 'acme', TYCON_GH_CMD: FAKE_GH, FAKE_GH_STATE: state, FAKE_GH_LOG: log } });
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.deepStrictEqual(fs.readdirSync(destOrg).sort(), ['acme__api', 'acme__extra-0', 'acme__extra-1', 'acme__web'], r.stdout);
  assert.match(r.stdout, /copias del arnés que no se miden: acme\/harness-copy/);
  assert.match(r.stdout, /::warning::Repos NO medidos:.*acme\/otro-0\(clone\)/, 'lo que no se pudo clonar se nombra');
  assert.ok(fs.readFileSync(log, 'utf8').includes('page=2'), 'pagina');
  assert.ok(fs.existsSync(path.join(destOrg, 'acme__web', 'specs', 'story-1.md')), 'el Markdown está');
  assert.ok(!fs.existsSync(path.join(destOrg, 'acme__web', 'package.json')), 'lo demás no se baja');
  // con prefijo
  const destP = path.join(base, 'pref');
  r = spawnSync('bash', [sh, '--org', destP, '--team-repos', tr], { encoding: 'utf8', env: { ...env, OWNERS: 'acme', PREFIX: 'extra-', TYCON_GH_CMD: FAKE_GH, FAKE_GH_STATE: state } });
  assert.strictEqual(r.status, 0, r.stdout);
  assert.deepStrictEqual(fs.readdirSync(destP).sort(), ['acme__extra-0', 'acme__extra-1']);
  // un dueño que no se puede listar: rojo, no un barrido a medias
  r = spawnSync('bash', [sh, '--org', path.join(base, 'x'), '--team-repos', tr], { encoding: 'utf8', env: { ...env, OWNERS: 'nadie', TYCON_GH_CMD: FAKE_GH, FAKE_GH_STATE: state } });
  assert.strictEqual(r.status, 1, r.stdout); assert.match(r.stdout, /No se pudieron listar los repos de la organización: no pude saber qué es nadie/);
});
