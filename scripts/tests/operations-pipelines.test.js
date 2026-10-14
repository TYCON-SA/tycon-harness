'use strict';
// operations-pipelines.test.js — los modelos de pipelines de operaciones para cualquier organización (story 8.30,
// T1 a T5). Lee los YAML como texto (no hay biblioteca de YAML en el arnés, a propósito) y corre de verdad el guion de
// la plantilla ops-data.yml sobre dos repos de juguete.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DIR = path.join(ROOT, 'pipelines', 'operations');
const MODELS = ['dependency-audit.yml', 'stage-metrics.yml', 'team-dashboard.yml'];
const TEMPLATES = ['fetch-harness.yml', 'ops-data.yml', 'check-tree.yml'];
const read = (rel) => fs.readFileSync(path.join(DIR, rel), 'utf8');

test('T1 Models_FilesInPlace: los tres modelos, las tres plantillas, la página y los ejemplos; cada template: existe y va con @harness', () => {
  for (const f of [...MODELS, ...TEMPLATES.map((t) => `templates/${t}`), 'README.md', 'examples/repos.json', 'examples/operations.json', 'examples/sources.json']) {
    assert.ok(fs.existsSync(path.join(DIR, f)), `falta pipelines/operations/${f}`);
  }
  for (const m of MODELS) {
    const refs = [...read(m).matchAll(/^\s*- template:\s*(\S+)\s*$/gm)].map((x) => x[1]);
    assert.ok(refs.length >= 3, `${m}: usa las plantillas`);
    for (const r of refs) {
      const [file, repo] = r.split('@');
      assert.strictEqual(repo, 'harness', `${m}: ${r} va con @harness`);
      assert.ok(file.startsWith('pipelines/operations/templates/'), `${m}: ${r} es una plantilla de operaciones`);
      assert.ok(fs.existsSync(path.join(ROOT, file)), `${m}: ${file} existe`);
    }
    // el recurso del arnés: declarado, y con su línea a cambiar marcada (resources no acepta parámetros)
    assert.match(read(m), /- repository: harness\n\s+type: (git|github)/, `${m}: declara el recurso harness`);
    assert.match(read(m), /name: \S+\s+# ← CAMBIAR/, `${m}: la línea a cambiar está marcada`);
  }
  for (const f of ['examples/repos.json', 'examples/operations.json', 'examples/sources.json']) JSON.parse(read(f));
  const ops = require(path.join(ROOT, 'scripts', 'lib', 'operations-config.js')).load(path.join(DIR, 'examples', 'operations.json'));
  assert.ok(ops.ok, `el operations.json de ejemplo valida: ${JSON.stringify(ops.problems)}`);
});

test('T2 Models_NoTeamLiterals: ni los modelos ni las plantillas nombran nada del equipo que mantiene el arnés', () => {
  // lo que los pipelines del equipo nombran y una organización no tiene
  const literals = [/harness-maintainers/i, /harness-team-operations/i, /tycon-claude-guides/i, /github\.com_/i, /vigilante-prod-hosts/i,
    /tablero-nocturno-buzon/i, /@maintainers/, /traer-arnes/, /overlay-harness/, /HARNESS_AFTER_CUT/, /dev\.azure\.com\/(?!acme)/i];
  for (const f of [...MODELS, ...TEMPLATES.map((t) => `templates/${t}`)]) {
    const text = read(f);
    for (const re of literals) assert.doesNotMatch(text, re, `${f} nombra ${re}`);
    assert.doesNotMatch(text, /^\s*- group:/m, `${f}: un grupo de variables que no existe no deja arrancar al pipeline`);
  }
});

/** Los pasos de un YAML como bloques de texto: desde `- script:`/`- task:`/`- template:` hasta el siguiente. */
function steps(text) {
  const lines = text.split('\n');
  const out = [];
  let cur = null;
  for (const l of lines) {
    if (/^\s{6}- (script|task|template|checkout):/.test(l)) { if (cur) out.push(cur.join('\n')); cur = [l]; } else if (cur) cur.push(l);
  }
  if (cur) out.push(cur.join('\n'));
  return out;
}

test('T3 Models_EffectsGateEveryWrite: todo paso con efectos depende de efectos; los que empujan a main, además, de estar en main', () => {
  const writers = [
    { re: /push-nightly-data\.js save/, main: true },
    { re: /open-pr-per-finding\.sh/, main: true },
    { re: /work-items\.js run/, main: false },
    { re: /daily-summary\.js deliver/, main: false },
  ];
  let seen = 0;
  for (const m of MODELS) {
    for (const s of steps(read(m))) {
      for (const w of writers) {
        if (!w.re.test(s)) continue;
        seen += 1;
        const cond = (s.match(/^\s+condition: (.*)$/m) || [])[1] || '';
        assert.match(cond, /parameters\.efectos \}\}', 'true'\)/, `${m}: el paso con ${w.re} depende de efectos (${cond || 'sin condición'})`);
        if (w.main) assert.match(cond, /refs\/heads\/main/, `${m}: el paso con ${w.re} empuja a main: sólo desde main`);
      }
    }
  }
  assert.ok(seen >= 6, `se miraron los pasos con efectos de los tres modelos (${seen})`);
});

// ── la plantilla ops-data.yml, corrida de verdad ──────────────────────────────────────────────────────────────
function cleanEnv(extra = {}) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(GIT_|HARNESS_|BUILD_|SYSTEM_|AGENT_)/.test(k)) e[k] = v;
  return { ...e, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), 'ops-pipelines-no-global'),
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
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/** El guion de ops-data.yml con las macros de Azure reemplazadas. */
function opsDataScript(vars) {
  const text = read('templates/ops-data.yml');
  const m = text.match(/- script: \|\n([\s\S]*?)\n {4}displayName:/);
  assert.ok(m, 'ops-data.yml trae un paso script');
  let body = m[1].split('\n').map((l) => l.replace(/^ {6}/, '')).join('\n');
  for (const [k, v] of Object.entries(vars)) body = body.split(`$(${k})`).join(v);
  assert.doesNotMatch(body, /\$\([A-Z][A-Za-z]+\.[A-Za-z.]+\)/, 'no quedó ninguna macro de Azure sin reemplazar');
  return body;
}

/** El agente: el arnés en <build>/s y el repo de operaciones en <build>/ops, con su remoto. */
function agent(opsFiles) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-pipelines-'));
  dirs.push(base);
  const build = path.join(base, 'build');
  const s = path.join(build, 's');
  const opsRemote = path.join(base, 'operations.git');
  fs.mkdirSync(s, { recursive: true });
  git(s, ['init', '--quiet', '-b', 'main']);
  write(s, { 'scripts/a.js': 'module.exports = 1;\n', 'scripts/nightly/dashboard/sources.json': '{"del":"arnes"}\n' });
  fs.mkdirSync(path.join(s, 'scripts', 'ci'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'ci', 'harness-tree.js'), path.join(s, 'scripts', 'ci', 'harness-tree.js'));
  git(s, ['add', '-A']); git(s, ['commit', '--quiet', '-m', 'el arnés']);
  git(s, ['remote', 'add', 'origin', 'https://example.com/acme/harness.git']);
  // el repo de operaciones: un remoto desnudo con main, y su checkout en <build>/ops
  fs.mkdirSync(opsRemote);
  git(opsRemote, ['init', '--quiet', '--bare']);
  git(opsRemote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const seed = path.join(base, 'seed');
  git(base, ['clone', '--quiet', opsRemote, seed]);
  write(seed, opsFiles);
  git(seed, ['add', '-A', '-f']); git(seed, ['commit', '--quiet', '-m', 'operaciones']); git(seed, ['branch', '-M', 'main']);
  git(seed, ['push', '--quiet', 'origin', 'main']);
  git(base, ['clone', '--quiet', opsRemote, path.join(build, 'ops')]);
  return { base, build, s, opsRemote };
}
function runOpsData(w) {
  const body = opsDataScript({ 'Build.SourcesDirectory': w.s, 'Agent.BuildDirectory': w.build, 'Build.Repository.Uri': w.opsRemote });
  const r = spawnSync('bash', ['-c', body], { env: cleanEnv({ SYSTEM_ACCESSTOKEN: 'token-de-prueba' }), encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('T4 OpsData_CopiesAndRetargets: trae los datos y la configuración de la lista, los fija en un commit local, apunta origin a operaciones y deja la huella', () => {
  const w = agent({
    'operations.json': '{"version":1,"owners":{"default":"lider@acme.example"}}\n',
    'scripts/nightly/dependencies/repos.json': '{"repos":[]}\n',
    'scripts/nightly/dashboard/sources.json': '{"de":"operaciones"}\n',
    '.dashboard/sdlc-stage-2026-01-01.json': '{}\n',
    'inbox/dependencies/pending/a1b2c3d4.yaml': 'id: a1b2c3d4\n',
    'pipelines/stage-metrics.yml': 'trigger: none\n',
    'scripts/a.js': 'module.exports = "pisado";\n', // código: no se trae
    'README.md': '# operaciones\n',
  });
  const head = git(w.s, ['rev-parse', 'HEAD']);
  const r = runOpsData(w);
  assert.strictEqual(r.code, 0, r.out);
  for (const [rel, want] of [['operations.json', 'lider@acme.example'], ['scripts/nightly/dependencies/repos.json', 'repos'], ['scripts/nightly/dashboard/sources.json', 'operaciones'], ['.dashboard/sdlc-stage-2026-01-01.json', '{}'], ['inbox/dependencies/pending/a1b2c3d4.yaml', 'a1b2c3d4']]) {
    assert.match(fs.readFileSync(path.join(w.s, rel), 'utf8'), new RegExp(want), `${rel} quedó encima`);
  }
  assert.strictEqual(fs.readFileSync(path.join(w.s, 'scripts', 'a.js'), 'utf8'), 'module.exports = 1;\n', 'el código del arnés no lo pisa operaciones');
  assert.ok(!fs.existsSync(path.join(w.s, 'pipelines', 'stage-metrics.yml')), 'pipelines/ de operaciones no se trae');
  assert.match(r.out, /trae archivos que esta plantilla no lee[^\n]*scripts\/a\.js/, 'lo que no se trae se nombra');
  assert.strictEqual(git(w.s, ['rev-parse', 'HEAD^']), head, 'un commit local encima del arnés');
  assert.match(git(w.s, ['log', '-1', '--format=%s']), /\[local, no se empuja\]/);
  assert.strictEqual(git(w.s, ['status', '--porcelain']), '', 'el disco es el del commit');
  assert.strictEqual(git(w.s, ['remote', 'get-url', 'origin']), w.opsRemote, 'origin → operaciones');
  assert.strictEqual(git(w.s, ['remote', 'get-url', 'harness']), 'https://example.com/acme/harness.git', 'el del arnés queda como harness');
  const mark = (r.out.match(/##vso\[task\.setvariable variable=HARNESS_TREE\](\S+)/) || [])[1];
  assert.match(mark || '', /^[0-9a-f]{64}@[0-9a-f]{40}$/, 'deja HARNESS_TREE con forma de huella');
  // la huella es la del árbol armado: la guarda la acepta
  const guard = spawnSync(process.execPath, [path.join(w.s, 'scripts', 'ci', 'harness-tree.js'), '--check-tree', '--worktree', '--repo', w.s], { env: cleanEnv({ HARNESS_TREE: mark }), encoding: 'utf8' });
  assert.strictEqual(guard.status, 0, guard.stderr);
});

test('T5 OpsData_FreshOrg_NotRed: un repo de operaciones recién creado (sin datos) no sale rojo', () => {
  const w = agent({ 'operations.json': '{"version":1,"owners":{"default":"lider@acme.example"}}\n', 'pipelines/stage-metrics.yml': 'trigger: none\n' });
  const r = runOpsData(w);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /HARNESS_TREE\]/);
  assert.ok(!fs.existsSync(path.join(w.s, '.dashboard')), 'no inventa carpetas de datos');
});
