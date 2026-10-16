'use strict';
// operations-github-workflows.test.js — los workflows modelo de GitHub Actions para los procesos de la noche (story 8.31,
// T1 a T8; T9: la credencial por GitHub App, 2026-10-14; T10: los privados que ve la credencial, 2026-10-14). Lee los YAML como texto (no hay biblioteca de YAML en el arnés, a propósito), corre de verdad el bloque que
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
  if (secrets.some((s) => !['HARNESS_ORG_TOKEN', 'HARNESS_APP_PRIVATE_KEY', 'TELEGRAM_BOT_TOKEN'].includes(s))) broken.push('secrets');
  // cada secreto (y el token del workflow, y el de la App) sólo como valor de una variable de env de un paso; la llave de
  // la App, sólo como `private-key` del paso que pide el token; el token de la App, sólo solo o con HARNESS_ORG_TOKEN de
  // respaldo, o comparado en un `if:`
  const appSteps = steps(text).filter((x) => /uses: actions\/create-github-app-token@/.test(x));
  const KEY_LINE = '          private-key: ${{ secrets.HARNESS_APP_PRIVATE_KEY }}';
  for (const l of text.split('\n')) {
    if (!/secrets\.|github\.token|outputs\.token/.test(l)) continue;
    const env = /^ {10}[A-Z_]+: \$\{\{ (secrets\.(HARNESS_ORG_TOKEN|TELEGRAM_BOT_TOKEN)|github\.token|steps\.[a-z-]+\.outputs\.token( \|\| secrets\.HARNESS_ORG_TOKEN)?) \}\}$/.test(l);
    const key = l === KEY_LINE && appSteps.some((x) => x.split('\n').includes(l));
    const cond = /^ {8}if: always\(\) && steps\.[a-z-]+\.outputs\.token != ''$/.test(l);
    if (!env && !key && !cond) { broken.push('secret-scope'); break; }
  }
  if (text.split('\n').filter((l) => l === KEY_LINE).length !== appSteps.length) broken.push('secret-scope');
  // el paso que pide el token de la App: sólo si está configurada, con la llave de los secretos, de la organización del
  // repo de operaciones, con permisos pedidos por nombre (contenido de lectura; issues) y ninguna otra entrada
  const WITH = { 'client-id': /^\$\{\{ vars\.HARNESS_APP_CLIENT_ID \}\}$/, 'private-key': /^\$\{\{ secrets\.HARNESS_APP_PRIVATE_KEY \}\}$/,
    owner: /^\$\{\{ github\.repository_owner \}\}$/, 'permission-contents': /^read$/, 'permission-issues': /^(read|write)$/,
    'permission-deployments': /^read$/, 'permission-actions': /^read$/, 'skip-token-revoke': /^true$/ };   // story 2.22: la foto de despliegues lee deployments y actions
  for (const st of appSteps) {
    const cond = (st.match(/^ {8}if: (.*)$/m) || [])[1] || '';
    const w = {};
    for (const m of st.matchAll(/^ {10}([a-z-]+): (.*)$/gm)) w[m[1]] = m[2];
    const ok = /^vars\.HARNESS_APP_CLIENT_ID != ''( && |$)/.test(cond) && /^ {8}id: [a-z-]+$/m.test(st)
      && Object.entries(w).every(([k, v]) => WITH[k] && WITH[k].test(v))
      && ['client-id', 'private-key', 'owner'].every((k) => k in w) && Object.keys(w).some((k) => k.startsWith('permission-'));
    if (!ok) { broken.push('app-token'); break; }
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
    'app-token': t.replace('          permission-issues: write\n', '          permission-issues: write\n          permission-contents: write\n'),
  };
  // más maneras de romper las reglas de la App, cada una por separado
  const masAlteraciones = [
    ['secret-scope', t.replace('          APP_TOKEN: ${{ steps.org-token.outputs.token }}\n', '          APP_TOKEN: ${{ steps.org-token.outputs.token }}\n          LLAVE: ${{ secrets.HARNESS_APP_PRIVATE_KEY }}\n')],
    ['secret-scope', t.replace('GH_TOKEN: ${{ steps.org-token.outputs.token || secrets.HARNESS_ORG_TOKEN }}', 'GH_TOKEN: ${{ steps.org-token.outputs.token || secrets.TELEGRAM_BOT_TOKEN }}')],
    ['app-token', t.replace("        id: org-token\n        if: vars.HARNESS_APP_CLIENT_ID != ''\n", '        id: org-token\n')],
    ['app-token', t.replace('          permission-contents: read\n          permission-issues: read\n', '')],
    ['app-token', t.replace('          owner: ${{ github.repository_owner }}\n          permission-issues: write\n', '          owner: otra-org\n          permission-issues: write\n')],
    ['app-token', t.replace('          permission-issues: write\n', '          permission-issues: write\n          github-api-url: https://example.com\n')],
  ];
  for (const [rule, alterado] of masAlteraciones) {
    assert.notStrictEqual(alterado, t, `una alteración de ${rule} no cambió nada`);
    assert.ok(brokenRules(alterado).includes(rule), `una copia alterada para ${rule} no salió roja: ${brokenRules(alterado)}`);
  }
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
  assert.strictEqual(r.status, 1); assert.match(r.stdout, /Falta la credencial de la organización[^\n]*GitHub App[^\n]*HARNESS_ORG_TOKEN/);
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
  // la copia de mantenimiento SÍ se mide (DEF-8.30-copias-del-arnes-en-team-repos: la regla es la del lector, la misma que
  // en Azure); las demás copias no. Y un team-repos.json que no valida es rojo, no «no hay copias».
  const trM = path.join(base, 'team-repos-maintainers.json');
  fs.writeFileSync(trM, JSON.stringify({ ...JSON.parse(fs.readFileSync(tr, 'utf8')), maintainers: { platform: 'github', org: 'ACME', repo: 'Extra-0' },
    harness_copies: [{ platform: 'github', org: 'acme', repo: 'harness-copy' }, { platform: 'github', org: 'acme', repo: 'extra-0' }] }));
  const destM = path.join(base, 'maint');
  r = spawnSync('bash', [sh, '--org', destM, '--team-repos', trM], { encoding: 'utf8', env: { ...env, OWNERS: 'acme', PREFIX: 'extra-', TYCON_GH_CMD: FAKE_GH, FAKE_GH_STATE: state } });
  assert.strictEqual(r.status, 0, r.stdout);
  assert.deepStrictEqual(fs.readdirSync(destM).sort(), ['acme__extra-0', 'acme__extra-1'], 'la de mantenimiento se mide');
  const trBad = path.join(base, 'team-repos-bad.json');
  fs.writeFileSync(trBad, JSON.stringify({ ...JSON.parse(fs.readFileSync(tr, 'utf8')), harness_copies: [{ platform: 'github', org: 'acme' }] }));
  r = spawnSync('bash', [sh, '--org', path.join(base, 'bad'), '--team-repos', trBad], { encoding: 'utf8', env: { ...env, OWNERS: 'acme', TYCON_GH_CMD: FAKE_GH, FAKE_GH_STATE: state } });
  assert.strictEqual(r.status, 1, r.stdout); assert.match(r.stdout, /team-repos\.json no valida: harness_copies\.0\.repo/);
  // un dueño que no se puede listar: rojo, no un barrido a medias
  r = spawnSync('bash', [sh, '--org', path.join(base, 'x'), '--team-repos', tr], { encoding: 'utf8', env: { ...env, OWNERS: 'nadie', TYCON_GH_CMD: FAKE_GH, FAKE_GH_STATE: state } });
  assert.strictEqual(r.status, 1, r.stdout); assert.match(r.stdout, /No se pudieron listar los repos de la organización: no pude saber qué es nadie/);
});

test('T9 GhModels_AppToken: la App es el camino recomendado y el usuario de máquina el respaldo; ningún token de la App vivo mientras corre código de los productos', () => {
  const nombre = (st) => ((st.match(/^ {6}- name: (.*)$/m) || st.match(/^ {8}name: (.*)$/m) || [])[1] || '');
  const SHA = /uses: actions\/create-github-app-token@[0-9a-f]{40} # v\d+\.\d+\.\d+$/m;
  // las métricas: un token de sólo lectura, y el paso que clona lo toma con el secreto de respaldo
  const m = steps(read('stage-metrics.yml'));
  const mApp = m.filter((x) => /create-github-app-token@/.test(x));
  assert.strictEqual(mApp.length, 1, 'stage-metrics pide un token de la App');
  assert.match(mApp[0], SHA);
  assert.deepStrictEqual([...mApp[0].matchAll(/^ {10}(permission-[a-z-]+): (.*)$/gm)].map((x) => `${x[1]}=${x[2]}`), ['permission-contents=read']);
  assert.match(m.find((x) => /clone-repos\.sh --org/.test(x)), /^ {10}ORG_TOKEN: \$\{\{ steps\.org-token\.outputs\.token \|\| secrets\.HARNESS_ORG_TOKEN \}\}$/m);
  // el tablero no lee código de los repos de la organización; desde la story 2.22 sí lee sus despliegues: UN token de la
  // App, sólo de lectura de deployments y actions (nunca contents ni issues), y nunca el usuario de máquina
  const tb = read('team-dashboard.yml');
  assert.doesNotMatch(tb, /HARNESS_ORG_TOKEN/);
  const tApp = steps(tb).filter((x) => /create-github-app-token@/.test(x));
  assert.strictEqual(tApp.length, 1, 'el tablero pide un solo token de la App');
  assert.match(tApp[0], SHA);
  assert.deepStrictEqual([...tApp[0].matchAll(/^ {10}(permission-[a-z-]+): (.*)$/gm)].map((x) => `${x[1]}=${x[2]}`), ['permission-deployments=read', 'permission-actions=read']);
  // la revisión de dependencias: el orden es la regla
  const d = steps(read('dependency-audit.yml'));
  const at = (re) => { const i = d.findIndex((x) => re.test(x)); assert.ok(i >= 0, `falta el paso ${re}`); return i; };
  const leer = at(/id: org-token$/m);
  const clonar = at(/clone-repos\.sh --declared/);
  const estado = at(/work-items\.js state/);
  const revocar = at(/installation\/token/);
  const revisar = at(/nightly-dependencies\.js run/);
  const escribir = at(/id: org-token-issues$/m);
  const issues = at(/work-items\.js run/);
  assert.ok(leer < clonar && clonar < revocar && estado < revocar && revocar < revisar && revisar < escribir && escribir < issues,
    `el orden: ${[leer, clonar, estado, revocar, revisar, escribir, issues].map((i) => nombre(d[i])).join(' → ')}`);
  for (const i of [leer, escribir]) assert.match(d[i], SHA);
  assert.match(d[leer], /^ {10}skip-token-revoke: true$/m, 'el de leer lo revoca el paso de revocar, no la acción al final');
  assert.doesNotMatch(d[escribir], /skip-token-revoke/, 'el de los issues lo revoca la acción al terminar');
  assert.match(d[escribir], /^ {10}permission-issues: write$/m); assert.doesNotMatch(d[escribir], /permission-contents/, 'el de los issues no lee código');
  assert.match(d[revocar], /^ {8}if: always\(\) && steps\.org-token\.outputs\.token != ''$/m, 'se revoca también si un paso anterior falló');
  // nadie usa el token de leer después de revocarlo; nadie usa el de los issues antes de pedirlo
  d.forEach((st, i) => {
    if (i > revocar) assert.doesNotMatch(st, /steps\.org-token\.outputs/, `${nombre(st)} usa el token de leer ya revocado`);
    if (i < escribir) assert.doesNotMatch(st, /steps\.org-token-issues\.outputs/, `${nombre(st)} usa el token de los issues antes de pedirlo`);
  });
  // el paso que corre código de los productos no tiene ninguna credencial
  assert.doesNotMatch(d[revisar], /TOKEN|secrets\.|outputs\.token/, 'la revisión no tiene credencial');
  // el paso de revocar, corrido de verdad con un curl falso: 204 sigue; otra cosa es rojo y no sigue
  const run = d[revocar].split('\n');
  const body = run.slice(run.findIndex((l) => /^ {8}run: \|$/.test(l)) + 1).map((l) => l.replace(/^ {10}/, '')).join('\n');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'revoke-')); dirs.push(base);
  fs.writeFileSync(path.join(base, 'curl'), '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$CURL_ARGS"\nprintf "%s" "$CURL_CODE"\n', { mode: 0o755 });
  const correr = (code) => spawnSync('bash', ['-c', body], { encoding: 'utf8',
    env: cleanEnv({ PATH: `${base}${path.delimiter}${process.env.PATH}`, APP_TOKEN: 'ghs_de_prueba', GITHUB_API_URL: 'https://api.example', CURL_CODE: code, CURL_ARGS: path.join(base, 'args') }) });
  let r = correr('204');
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const args = fs.readFileSync(path.join(base, 'args'), 'utf8');
  assert.match(args, /^DELETE$/m); assert.match(args, /^https:\/\/api\.example\/installation\/token$/m); assert.match(args, /^Authorization: Bearer ghs_de_prueba$/m);
  r = correr('401');
  assert.strictEqual(r.status, 1, 'no revocado: rojo');
  assert.match(r.stdout, /::error::No se pudo revocar la credencial de la App \(HTTP 401\)/);
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /ghs_de_prueba/, 'el token no se imprime');
});

test('T10 CloneRepos_SeesPrivates: con la App, los repos donde está instalada (privados incluidos); el usuario de máquina suma los privados de una cuenta de usuario; cero repos vistos es un aviso', () => {
  // DEF-8.31-metricas-no-ven-privados-de-un-usuario: en una cuenta de usuario, users/<dueño>/repos trae sólo los públicos y
  // la corrida salía verde con «repos vistos: 0»
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-privados-')); dirs.push(base);
  const server = path.join(base, 'server');
  for (const full of ['bob/priv', 'bob/pub', 'acme/web', 'acme/api']) {
    const bare = path.join(server, `${full}.git`);
    fs.mkdirSync(bare, { recursive: true });
    git(bare, ['init', '--quiet', '--bare']); git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    const s = path.join(base, 'seed', full);
    git(base, ['clone', '--quiet', bare, s]);
    write(s, { 'specs/story-1.md': `# ${full}\n` }); git(s, ['add', '-A']); git(s, ['commit', '--quiet', '-m', 'x']); git(s, ['branch', '-M', 'main']); git(s, ['push', '--quiet', 'origin', 'main']);
  }
  const sh = path.join(DIR, 'clone-repos.sh');
  const state = path.join(base, 'gh.json');
  const estado = (extra) => fs.writeFileSync(state, JSON.stringify({ user: 'maquina', owners: { bob: 'User', acme: 'Organization' },
    repos: { bob: [{ name: 'priv', private: true }, { name: 'pub' }], acme: [{ name: 'web', private: true }, { name: 'api', private: true }] }, ...extra }));
  const tr = path.join(base, 'team-repos.json');
  fs.writeFileSync(tr, JSON.stringify({ version: 1, public: { platform: 'github', org: 'acme', repo: 'harness' }, profile: { platform: 'github', org: 'acme', repo: 'profile' },
    operations: { platform: 'github', org: 'acme', repo: 'operations' } }));
  let n = 0;
  const correr = (env) => {
    const dest = path.join(base, `d${n++}`);
    const log = path.join(base, `gh${n}.log`);
    const r = spawnSync('bash', [sh, '--org', dest, '--team-repos', tr], { encoding: 'utf8',
      env: cleanEnv({ ORG_TOKEN: 't0k3n', GITHUB_SERVER_URL: `file://${server}`, TYCON_GH_CMD: FAKE_GH, FAKE_GH_STATE: state, FAKE_GH_LOG: log, ...env }) });
    const rutas = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l).ruta) : [];
    return { ...r, out: `${r.stdout}${r.stderr}`, clones: fs.existsSync(dest) ? fs.readdirSync(dest).sort() : [], rutas };
  };

  // la App en una cuenta personal, instalada en un repo privado: se ve y se mide
  estado({ installation: ['bob/priv'] });
  let r = correr({ ORG_TOKEN_KIND: 'app', OWNERS: 'bob' });
  assert.strictEqual(r.status, 0, r.out);
  assert.deepStrictEqual(r.clones, ['bob__priv'], r.out);
  assert.match(r.stdout, /repos vistos: 1 /);
  assert.ok(r.rutas.includes('installation/repositories?per_page=100&page=1'), 'lista por installation/repositories');
  assert.ok(!r.rutas.some((x) => /^users\//.test(x)), 'con la App no pregunta por users/');
  assert.doesNotMatch(r.out, /t0k3n/);

  // la App en una organización: sólo los repos donde está instalada, paginado; un dueño de OWNERS sin la App es un aviso
  const muchos = Array.from({ length: 100 }, (_, i) => `otra/r${i}`);
  estado({ installation: [...muchos, 'acme/web'] });
  r = correr({ ORG_TOKEN_KIND: 'app', OWNERS: 'acme;bob' });
  assert.strictEqual(r.status, 0, r.out);
  assert.deepStrictEqual(r.clones, ['acme__web'], 'ni api (sin la App) ni los de otro dueño');
  assert.ok(r.rutas.includes('installation/repositories?per_page=100&page=2'), 'pagina');
  assert.ok(!r.rutas.some((x) => /^orgs\//.test(x)));
  assert.match(r.stdout, /::warning::la GitHub App no está instalada en ningún repo de bob/);
  assert.doesNotMatch(r.stdout, /Cero repos vistos/);

  // el usuario de máquina en una cuenta de usuario: los públicos más los privados que ve (sin repetir)
  estado({ visible: ['bob/priv', 'bob/pub', 'acme/web'] });
  r = correr({ OWNERS: 'bob' });
  assert.strictEqual(r.status, 0, r.out);
  assert.deepStrictEqual(r.clones, ['bob__priv', 'bob__pub'], r.out);
  assert.match(r.stdout, /repos vistos: 2 /);
  assert.ok(r.rutas.includes('user/repos?affiliation=owner,collaborator&per_page=100&page=1'));
  // y en una organización, el camino de siempre (orgs/, que ya trae los privados)
  r = correr({ ORG_TOKEN_KIND: 'user', OWNERS: 'acme' });
  assert.deepStrictEqual(r.clones, ['acme__api', 'acme__web'], r.out);
  assert.ok(!r.rutas.some((x) => /^user\/repos/.test(x)), 'una organización no necesita user/repos');
  // si user/repos falla, rojo: no un barrido a medias
  estado({ visible: [], fail: { 'GET user/repos': { status: 500 } } });
  r = correr({ OWNERS: 'bob' });
  assert.strictEqual(r.status, 1, r.out); assert.match(r.stdout, /No se pudieron listar los repos[^\n]*user\/repos/);

  // cero repos vistos con repos declarados en team-repos.json: un aviso que los nombra, no un verde mudo
  estado({ installation: [] });
  r = correr({ ORG_TOKEN_KIND: 'app', OWNERS: 'acme' });
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.stdout, /repos vistos: 0 /);
  assert.match(r.stdout, /::warning::Cero repos vistos, y team-repos\.json declara repos de estos dueños \(acme\/harness acme\/profile acme\/operations\)/);
  // sin nada declarado de ese dueño, igual es un aviso
  r = correr({ ORG_TOKEN_KIND: 'app', OWNERS: 'bob' });
  assert.match(r.stdout, /::warning::Cero repos vistos: no se midió nada/);
  // el usuario de máquina en una cuenta de usuario que no ve ningún privado: también avisa
  estado({ visible: [], repos: { bob: [{ name: 'priv', private: true }] } });
  r = correr({ OWNERS: 'bob' });
  assert.strictEqual(r.status, 0, r.out); assert.match(r.stdout, /::warning::Cero repos vistos/);
  // sin ORG_TOKEN_KIND (un workflow copiado antes): se averigua; el token de una App lee installation/repositories
  estado({ installation: ['bob/priv'] });
  r = correr({ OWNERS: 'bob' });
  assert.strictEqual(r.status, 0, r.out);
  assert.deepStrictEqual(r.clones, ['bob__priv'], r.out);
  assert.ok(!r.rutas.some((x) => /^(users|user)\//.test(x)), 'averiguó que es la App');
  // un tipo de credencial que no existe: rojo
  r = correr({ ORG_TOKEN_KIND: 'pat', OWNERS: 'bob' });
  assert.strictEqual(r.status, 1, r.out); assert.match(r.stdout, /ORG_TOKEN_KIND «pat» no es app ni user/);
  // el workflow dice qué credencial es, sin tocar el token
  const paso = steps(read('stage-metrics.yml')).find((x) => /clone-repos\.sh --org/.test(x));
  assert.match(paso, /^ {10}ORG_TOKEN_KIND: \$\{\{ steps\.org-token\.outcome == 'success' && 'app' \|\| 'user' \}\}$/m);
});

// ── story 2.25: la paridad de los productos en el workflow de dependencias (T13-T14) ────────────────────────────
test('T13 GitHub_ClonaAntesDeRevocarYComparaAntesDeCorrer @story-2.25 @ac-8: lo que falta para la paridad se clona en otra invocación, antes de revocar; se compara antes de correr código', () => {
  const all = steps(read('dependency-audit.yml'));
  const at = (name) => all.findIndex((s) => s.startsWith(`      - name: ${name}`));
  const clone = at('Clonar los repos declarados');
  const revoke = at('Revocar la credencial de la App (antes de correr código de los productos)');
  const tree = at('El árbol sigue siendo el que se armó (antes de medir)');
  const parity = at('Comparar los pipelines de los productos (paridad)');
  const run = at('Correr la revisión de dependencias');
  assert.ok(clone >= 0 && revoke > clone && tree > revoke && parity > tree && run > parity, `orden: clonar ${clone} < revocar ${revoke} < árbol ${tree} < paridad ${parity} < revisión ${run}`);
  const lines = runLines(all[clone]).map((l) => l.trim()).filter(Boolean);
  const deps = lines.findIndex((l) => /^node scripts\/nightly\/dependencies\/nightly-dependencies\.js clone-list \|/.test(l));
  const par = lines.findIndex((l) => /^LISTA="\$\(node scripts\/ci\/check-product-parity\.js clone-list --root "\$\{RUNNER_TEMP\}\/repos" --platform github\)" \\$/.test(l));
  assert.ok(deps >= 0 && par > deps, `dos invocaciones, la de la paridad después (${deps}, ${par}): ${lines.join(' ⏎ ')}`);
  assert.ok(!lines.some((l) => /nightly-dependencies\.js clone-list.*check-product-parity|check-product-parity.*nightly-dependencies/.test(l)), 'las dos listas no van en la misma tubería');
  assert.ok(lines.some((l) => /printf '%s\\n' "\$\{LISTA\}" \| bash pipelines\/operations\/github\/clone-repos\.sh --declared "\$\{RUNNER_TEMP\}\/repos" \|\| echo "::warning::/.test(l)), 'el clon de la paridad no puede cortar el paso');
  // corrido de verdad, con bash -e y pipefail como GitHub: una lista ilegible avisa y el paso sigue (la noche no se pierde)
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-github-parity-'));
  dirs.push(base);
  fs.mkdirSync(path.join(base, 'scripts', 'ci'), { recursive: true });
  for (const f of ['check-product-parity.js', 'legacy-options.js']) fs.copyFileSync(path.join(ROOT, 'scripts', 'ci', f), path.join(base, 'scripts', 'ci', f));
  fs.writeFileSync(path.join(base, 'scripts', 'ci', 'product-parity.json'), '{ roto');
  const desde = runLines(all[clone]).findIndex((l) => /LISTA=/.test(l));
  const tramo = runLines(all[clone]).slice(desde).join('\n');
  const r = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', tramo], { cwd: base, encoding: 'utf8', env: cleanEnv({ RUNNER_TEMP: path.join(base, 'tmp') }) });
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(`${r.stdout}${r.stderr}`, /::warning::Paridad: /);
  const p = all[parity];
  assert.match(p, /check-product-parity\.js --root "\$\{RUNNER_TEMP\}\/repos"/);
  assert.match(p, /--today "\$\{HOY\}" --out "\$\{OUT\}"/);
  assert.match(p, /tr '\\r\\n' '  ' \| sed 's\/::\/: :\/g'/, 'el aviso no puede dar órdenes al workflow (ni con \\r)');
  assert.match(p, /OUT="\.dashboard\/paridad\/paridad-\$\{HOY\}\.json"/);
  assert.match(p, /HOY="\$\{HOY_NOCTURNO:-\$\(date -u \+%Y-%m-%d\)\}"/);
  assert.match(p, /annotate\.sh/, 'los avisos van por annotate.sh');
  assert.match(p, /RC=\$\{PIPESTATUS\[0\]\}/, 'el código del control, no el de la tubería');
  assert.match(p, /exit 0\s*$/, 'el paso sale siempre 0');
  const save = all.find((s) => /push-nightly-data\.js save/.test(s));
  assert.match(save, /-- \.dashboard\/dependencias inbox\/dependencies \.dashboard\/paridad /);
});

test('T14 GitHub_PrepareTreeTraeLaLista @story-2.25 @ac-9: con lista en operaciones, la de la organización; sin lista, la del arnés', () => {
  for (const [ops, want] of [[{ 'scripts/ci/product-parity.json': '{"de":"la organización"}\n' }, 'la organización'], [{}, 'del arnés']]) {
    const w = runner({ 'team-repos.json': teamRepos(), 'operations.json': '{"version":1,"owners":{"default":"lider"}}\n', ...ops });
    write(w.h, { 'scripts/ci/product-parity.json': '{"sin_productos":"del arnés"}\n' });
    git(w.h, ['add', '-A']); git(w.h, ['commit', '--quiet', '-m', 'la copia pública']);
    const r = prepare(w);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(fs.readFileSync(path.join(w.h, 'scripts', 'ci', 'product-parity.json'), 'utf8'), new RegExp(want));
    assert.doesNotMatch(r.out, /no lee[^\n]*product-parity\.json/, 'la lista no se nombra como archivo que no se trae');
  }
});

// story 2.23 (AC 16, T32): en GitHub los dos productores del sitio declaran «no medido» (los pull requests y los pedidos de
// GitHub todavía no se leen), corren antes de generar la página y se guardan con ella.
test('T32 TeamDashboard_ProductoresDelSitio', () => {
  const y = read('team-dashboard.yml');
  const traer = y.search(/- name: Traer de main del repo de operaciones/);
  const prod = y.search(/- name: Lo que deja la noche para el sitio/);
  const generar = y.search(/- name: Generar la página del tablero/);
  assert.ok(traer >= 0 && prod > traer && generar > prod, 'traer → productores → generar');
  assert.match(y, /open-prs\.js --today "\$\{DAY\}" --provider github --json "\.dashboard\/open-prs\/open-prs-\$\{DAY\}\.json"/);
  assert.match(y, /assigned-items\.js --today "\$\{DAY\}" --provider github --out \.dashboard\/assigned/);
  assert.match(y, /-- artifacts\/tablero-del-arnes\.html \.dashboard\/open-prs \.dashboard\/assigned \.dashboard\/deployments 2>&1/, 'se guardan con la página');
});

// story 2.22 (AC 13 y 15): la foto de despliegues corre ANTES de la página, tolerante; un paso propio acuña el token de la
// GitHub App (con la llave sólo en su `private-key`) y la foto lo recibe como GH_TOKEN; la carpeta se guarda con la página.
test('T21 TeamDashboard_PasoDeDesplieguesAntesDelTablero (2.22)', () => {
  const y = read('team-dashboard.yml');
  const token = y.search(/- name: La credencial para leer los despliegues/);
  const foto = y.search(/- name: La foto de despliegues de cada producto/);
  const generar = y.search(/- name: Generar la página del tablero/);
  assert.ok(token >= 0 && foto > token && generar > foto, 'token → foto → página');
  const pasoFoto = steps(y).find((s) => /La foto de despliegues de cada producto/.test(s));
  assert.match(pasoFoto, /continue-on-error: true/);
  assert.match(pasoFoto, /GH_TOKEN: \$\{\{ steps\.deploy-token\.outputs\.token \}\}/);
  assert.doesNotMatch(pasoFoto, /github\.token|secrets\./, 'nunca github.token ni un secreto en el paso de la foto');
  assert.match(pasoFoto, /deployments\.js --today .* --out \.dashboard\/deployments/);
  const pasoToken = steps(y).find((s) => /La credencial para leer los despliegues/.test(s));
  assert.match(pasoToken, /continue-on-error: true/);
  assert.match(pasoToken, /permission-deployments: read/);
  assert.match(pasoToken, /permission-actions: read/);
  assert.deepStrictEqual(brokenRules(y), []);
  assert.doesNotMatch(y.split('\n').slice(0, 16).join('\n'), /No necesita la credencial de la organización/);
});
