'use strict';
// operations-pipelines.test.js — los modelos de pipelines de operaciones para cualquier organización
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
const MODELS = ['dependency-audit.yml', 'stage-metrics.yml', 'team-dashboard.yml', 'runs-review.yml'];
const TEMPLATES = ['fetch-harness.yml', 'ops-data.yml', 'check-tree.yml'];
const read = (rel) => fs.readFileSync(path.join(DIR, rel), 'utf8');

test('T1 Models_FilesInPlace: los cuatro modelos, las tres plantillas, la página y los ejemplos; cada template: existe y va con @harness', () => {
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

test('T2 Models_NoTeamLiterals: lo de la organización no está escrito en los modelos ni en las plantillas', () => {
  // Se mira la FORMA y no una lista de nombres (una lista de nombres del equipo, escrita acá, sería justo lo que no se
  // publica): un solo recurso, `harness`, con su nombre marcado para cambiar; ninguna plantilla de otro repo; ningún grupo
  // de variables (si no existe, el pipeline no arranca); ninguna conexión de servicio escrita (van por parámetro); ninguna
  // dirección de organización salvo la de ejemplo; y nada de la superposición del equipo que mantiene el arnés.
  for (const f of [...MODELS, ...TEMPLATES.map((t) => `templates/${t}`)]) {
    const text = read(f);
    const repos = [...text.matchAll(/^\s*- repository:\s*(\S+)/gm)].map((x) => x[1]);
    assert.ok(repos.every((r) => r === 'harness'), `${f}: el único recurso es harness (${repos.join(', ')})`);
    const names = [...text.matchAll(/^\s+name:\s*(\S+)(.*)$/gm)];
    for (const [, , rest] of names) assert.match(rest, /← CAMBIAR/, `${f}: un name: sin la marca de cambiar`);
    for (const [, ref] of text.matchAll(/^\s*- template:\s*\S+@([A-Za-z0-9_-]+)\s*$/gm)) assert.strictEqual(ref, 'harness', `${f}: una plantilla de @${ref}`);
    assert.doesNotMatch(text, /^\s*- group:/m, `${f}: un grupo de variables`);
    for (const [, v] of text.matchAll(/^\s*(?:endpoint|azureSubscription):\s*(.+)$/gm)) {
      assert.match(v, /^\$\{\{\s*parameters\./, `${f}: una conexión de servicio escrita (${v})`);
    }
    for (const [u] of text.matchAll(/https?:\/\/dev\.azure\.com\/[^\s/'"]+/g)) assert.match(u, /\/acme$/, `${f}: una organización escrita (${u})`);
    assert.doesNotMatch(text, /overlay-harness|HARNESS_AFTER_CUT/, `${f}: la superposición del equipo`);
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
  assert.ok(seen >= 7, `se miraron los pasos con efectos de los cuatro modelos (${seen})`);
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
function agent(opsFiles, { remote = null } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-pipelines-'));
  dirs.push(base);
  const build = path.join(base, 'build');
  const s = path.join(build, 's');
  const opsRemote = remote || path.join(base, 'operations.git');
  fs.mkdirSync(path.join(build, 'tmp'), { recursive: true });
  fs.mkdirSync(s, { recursive: true });
  git(s, ['init', '--quiet', '-b', 'main']);
  write(s, { 'scripts/a.js': 'module.exports = 1;\n', 'scripts/nightly/dashboard/sources.json': '{"del":"arnes"}\n' });
  fs.mkdirSync(path.join(s, 'scripts', 'ci'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'ci', 'harness-tree.js'), path.join(s, 'scripts', 'ci', 'harness-tree.js'));
  git(s, ['add', '-A']); git(s, ['commit', '--quiet', '-m', 'el arnés']);
  git(s, ['remote', 'add', 'origin', 'https://example.com/acme/harness.git']);
  // el repo de operaciones: un remoto desnudo con main, y su checkout en <build>/ops (con `remote`, el de otra corrida)
  if (!remote) {
    fs.mkdirSync(opsRemote);
    git(opsRemote, ['init', '--quiet', '--bare']);
    git(opsRemote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    const seed = path.join(base, 'seed');
    git(base, ['clone', '--quiet', opsRemote, seed]);
    write(seed, opsFiles);
    git(seed, ['add', '-A', '-f']); git(seed, ['commit', '--quiet', '-m', 'operaciones']); git(seed, ['branch', '-M', 'main']);
    git(seed, ['push', '--quiet', 'origin', 'main']);
  }
  git(base, ['clone', '--quiet', opsRemote, path.join(build, 'ops')]);
  return { base, build, s, opsRemote };
}
function runOpsData(w) {
  const body = opsDataScript({ 'Build.SourcesDirectory': w.s, 'Agent.BuildDirectory': w.build, 'Build.Repository.Uri': w.opsRemote, 'Agent.TempDirectory': path.join(w.build, 'tmp') });
  const r = spawnSync('bash', ['-c', body], { env: cleanEnv({ SYSTEM_ACCESSTOKEN: 'token-de-prueba' }), encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('T4 OpsData_CopiesAndRetargets: trae los datos y la configuración de la lista, los fija en un commit local, apunta origin a operaciones y deja la huella', () => {
  const w = agent({
    'operations.json': '{"version":1,"owners":{"default":"lider@acme.example"}}\n',
    'team-repos.json': '{"version":1,"operations":{"platform":"azure"}}\n', // T15: la plataforma viaja
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
  for (const [rel, want] of [['operations.json', 'lider@acme.example'], ['team-repos.json', 'platform'], ['scripts/nightly/dependencies/repos.json', 'repos'], ['scripts/nightly/dashboard/sources.json', 'operaciones'], ['.dashboard/sdlc-stage-2026-01-01.json', '{}'], ['inbox/dependencies/pending/a1b2c3d4.yaml', 'a1b2c3d4']]) {
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

// el sitio de la organización sabe qué configuración aplicó la noche por la marca
// `.dashboard/applied-config.json` — una entrada por archivo de configuración copiado, con el identificador del objeto
// en el repo de operaciones. Viaja en el commit local; a operaciones la sube el paso de guardar, sólo si la noche salió bien.
const APPLIED = '.dashboard/applied-config.json';
function appliedMark(w) {
  const text = fs.readFileSync(path.join(w.s, APPLIED), 'utf8');
  const mark = JSON.parse(text);
  assert.strictEqual(text, `${JSON.stringify(mark, null, 2)}\n`, 'la marca va con dos espacios y salto final');
  assert.ok(mark.files && typeof mark.files === 'object' && !Array.isArray(mark.files), 'la marca trae files');
  assert.match(mark.ops_commit, /^[0-9a-f]{7,40}$/, 'la marca trae el commit de operaciones');
  assert.match(mark.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, 'la marca trae la hora en UTC');
  return mark;
}

test('T4b OpsData_DejaLaMarcaDeLoAplicado @story-2.29 @ac-24: la marca nombra cada archivo de configuración copiado con su identificador de objeto, y va en el commit local', () => {
  const w = agent({
    'operations.json': '{"version":1,"owners":{"default":"lider@acme.example"}}\n',
    'scripts/nightly/dashboard/sources.json': '{"de":"operaciones"}\n',
    '.dashboard/sdlc-stage-2026-01-01.json': '{}\n',
  });
  const r = runOpsData(w);
  assert.strictEqual(r.code, 0, r.out);
  const mark = appliedMark(w);
  const ops = path.join(w.build, 'ops');
  assert.deepStrictEqual(mark.files, {
    'operations.json': git(ops, ['rev-parse', 'HEAD:operations.json']),
    'scripts/nightly/dashboard/sources.json': git(ops, ['rev-parse', 'HEAD:scripts/nightly/dashboard/sources.json']),
  }, 'sólo lo copiado, con el identificador del objeto en operaciones');
  assert.strictEqual(mark.ops_commit, git(ops, ['rev-parse', '--short', 'HEAD']));
  assert.match(git(w.s, ['show', '--name-only', '--format=', 'HEAD']), /^\.dashboard\/applied-config\.json$/m, 'la marca está en el commit local');
  assert.strictEqual(git(w.s, ['status', '--porcelain']), '', 'nada suelto fuera del commit');
  assert.match(read('templates/ops-data.yml'), /applied-config\.json/, 'la cabecera o el guion nombran la marca');
});

test('T5 OpsData_FreshOrg_NotRed: un repo de operaciones recién creado (sin datos) no sale rojo', () => {
  const w = agent({ 'operations.json': '{"version":1,"owners":{"default":"lider@acme.example"}}\n', 'pipelines/stage-metrics.yml': 'trigger: none\n' });
  const r = runOpsData(w);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /HARNESS_TREE\]/);
  // la marca se deja igual; sin otra configuración que la que copió, sólo con ésa. Sin datos, nada más.
  assert.deepStrictEqual(fs.readdirSync(path.join(w.s, '.dashboard')), ['applied-config.json'], 'no inventa carpetas de datos: sólo la marca');
  assert.deepStrictEqual(appliedMark(w).files, { 'operations.json': git(path.join(w.build, 'ops'), ['rev-parse', 'HEAD:operations.json']) });
  // sin ningún archivo de configuración, files queda vacío
  const w2 = agent({ 'README.md': '# operaciones\n' });
  const r2 = runOpsData(w2);
  assert.strictEqual(r2.code, 0, r2.out);
  assert.deepStrictEqual(appliedMark(w2).files, {}, 'sin configuración copiada, files es {}');
});

// ── las copias del arnés en las métricas: de team-repos.json, no de una variable ──────────────────────────────────
// Las métricas del modelo saben qué repos son copias del arnés por lo que dice team-repos.json, como el resto de los
// repos, y no por una variable de la definición (HARNESS_COPIES, y HARNESS_MEASURED_COPY la que cuenta): un lugar menos
// que configurar. Se corre el paso «Descubrir y clonar» REAL del modelo, con
// un `az` de mentira que contesta lo que el laboratorio declara y git de verdad contra repos locales.
function discoverScript(vars) {
  const block = steps(read('stage-metrics.yml')).find((s) => /displayName: 'Descubrir y clonar \(liviano\) los repos'/.test(s));
  assert.ok(block, 'stage-metrics.yml trae el paso «Descubrir y clonar»');
  const lines = block.split('\n');
  const end = lines.findIndex((l) => /^ {8}displayName:/.test(l));
  let body = lines.slice(1, end).map((l) => l.replace(/^ {10}/, '')).join('\n');
  for (const [k, v] of Object.entries(vars)) body = body.split(`$(${k})`).join(v);
  assert.doesNotMatch(body, /\$\([A-Z][A-Za-z]+\.[A-Za-z.]+\)/, 'no quedó ninguna macro de Azure sin reemplazar');
  return body;
}

/** La organización del laboratorio: un proyecto con el arnés tres veces (la vieja, la de mantenimiento y un espejo), un
 *  repo que sólo EMPIEZA igual que una copia, y un producto en un proyecto con espacio en el nombre. */
function labOrg(teamRepos) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-copies-'));
  dirs.push(base);
  const job = path.join(base, 'job');
  fs.mkdirSync(path.join(job, 'scripts', 'lib'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'lib', 'team-repos.js'), path.join(job, 'scripts', 'lib', 'team-repos.js'));
  if (teamRepos !== undefined) fs.writeFileSync(path.join(job, 'team-repos.json'), typeof teamRepos === 'string' ? teamRepos : JSON.stringify(teamRepos));
  const remotes = path.join(base, 'remotes');
  const tsv = {};
  for (const [proj, name] of [['Harness', 'old-harness'], ['Harness', 'maintainers'], ['Harness', 'mirror'], ['Harness', 'maintainers-docs'], ['Product One', 'app']]) {
    const bare = path.join(remotes, `${proj}__${name}.git`);
    fs.mkdirSync(bare, { recursive: true });
    git(bare, ['init', '--quiet', '--bare']);
    git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    const w = path.join(base, 'w', `${proj}__${name}`);
    git(base, ['clone', '--quiet', bare, w]);
    write(w, { 'specs/story-1.1.md': '---\nstory: 1.1\nstatus: done\n---\n', '.tycon/x.json': '{}\n' });
    git(w, ['add', '-A']); git(w, ['commit', '--quiet', '-m', 'base']); git(w, ['branch', '-M', 'main']); git(w, ['push', '--quiet', 'origin', 'main']);
    tsv[proj] = `${tsv[proj] || ''}${name}\t${bare}\n`;
  }
  const az = path.join(base, 'az');
  fs.mkdirSync(az);
  fs.writeFileSync(path.join(az, 'projects.txt'), 'Harness\nProduct One\n');
  for (const [p, t] of Object.entries(tsv)) fs.writeFileSync(path.join(az, `repos-${p}.tsv`), t);
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'az'), `#!/usr/bin/env bash
if [ "$1 $2 $3" = "devops project list" ]; then cat "$LAB_AZ/projects.txt"; exit 0; fi
if [ "$1 $2" = "repos list" ]; then
  P=""; while [ $# -gt 0 ]; do [ "$1" = "--project" ] && P="$2"; shift; done
  cat "$LAB_AZ/repos-$P.tsv"; exit 0
fi
echo "az de mentira: consulta que el laboratorio no espera: $*" >&2; exit 1
`, { mode: 0o755 });
  return { base, job, az, bin };
}
function runDiscover(lab, vars = {}) {
  const body = discoverScript({ 'System.AccessToken': 'token-de-prueba', 'System.CollectionUri': 'https://dev.azure.com/acme/',
    'Agent.TempDirectory': path.join(lab.base, 'tmp'), 'Build.SourcesDirectory': lab.job });
  const r = spawnSync('bash', ['-c', body], { cwd: lab.job, encoding: 'utf8',
    env: cleanEnv({ LAB_AZ: lab.az, PATH: `${lab.bin}${path.delimiter}${process.env.PATH}`, ...vars }) });
  const reposDir = path.join(lab.base, 'tmp', 'repos');
  return { code: r.status, out: `${r.stdout}${r.stderr}`, cloned: fs.existsSync(reposDir) ? fs.readdirSync(reposDir).sort() : [] };
}
const azRepo = (project, repo) => ({ platform: 'azure', org: 'acme', project, repo });
const teamRepos = (extra) => ({ version: 1, public: { platform: 'github', org: 'acme', repo: 'harness' }, profile: azRepo('Harness', 'profile'),
  operations: azRepo('Harness', 'operations'), ...extra });

test('T6 StageMetrics_CopiesFromTeamRepos: las copias las declara team-repos.json; se mide sólo la de mantenimiento', () => {
  const lab = labOrg(teamRepos({ maintainers: azRepo('Harness', 'maintainers'),
    harness_copies: [azRepo('Harness', 'old-harness'), azRepo('harness', 'MAINTAINERS'), azRepo('Harness', 'mirror')] }));
  const r = runDiscover(lab);
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(r.cloned, ['Harness__maintainers', 'Harness__maintainers-docs', 'Product One__app'],
    'las otras copias no se bajan; la de mantenimiento sí, y el repo que sólo empieza igual no se confunde');
  assert.match(r.out, /copias del arnés que no se miden: Harness\/old-harness Harness\/mirror$/m);
  assert.doesNotMatch(r.out, /##vso\[task\.logissue/, 'sin avisos');
  // sin mantenimiento declarado: ninguna copia se mide
  const none = runDiscover(labOrg(teamRepos({ harness_copies: [azRepo('Harness', 'old-harness'), azRepo('Harness', 'maintainers')] })));
  assert.strictEqual(none.code, 0, none.out);
  assert.deepStrictEqual(none.cloned, ['Harness__maintainers-docs', 'Harness__mirror', 'Product One__app']);
  // sin team-repos.json (es opcional en el modelo): se mide todo, como una organización sin copias
  const bare = runDiscover(labOrg(undefined));
  assert.strictEqual(bare.code, 0, bare.out);
  assert.strictEqual(bare.cloned.length, 5);
});

test('T7 StageMetrics_OldVariables_NotReadAnymore: la variable de antes avisa; sin copias en team-repos.json, rojo sin bajar nada', () => {
  const copies = teamRepos({ maintainers: azRepo('Harness', 'maintainers'), harness_copies: [azRepo('Harness', 'old-harness'), azRepo('Harness', 'maintainers')] });
  // con las copias en team-repos.json, la variable vieja (que decía OTRA cosa) no manda: aviso para borrarla
  let r = runDiscover(labOrg(copies), { HARNESS_COPIES: 'Harness/mirror;Harness/maintainers', HARNESS_MEASURED_COPY: 'Harness/mirror' });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /##vso\[task\.logissue type=warning\]HARNESS_COPIES y HARNESS_MEASURED_COPY ya no se leen/);
  assert.deepStrictEqual(r.cloned, ['Harness__maintainers', 'Harness__maintainers-docs', 'Harness__mirror', 'Product One__app'], 'manda team-repos.json');
  // la variable puesta y team-repos.json sin copias (o sin archivo): quien la puso tiene copias; medirlas dos veces en silencio, no
  for (const [caso, lab, vars] of [
    ['sin archivo', labOrg(undefined), { HARNESS_COPIES: 'Harness/old-harness;Harness/maintainers' }],
    ['sin harness_copies', labOrg(teamRepos({})), { HARNESS_MEASURED_COPY: 'Harness/maintainers' }],
  ]) {
    r = runDiscover(lab, vars);
    assert.notStrictEqual(r.code, 0, `${caso}: ${r.out}`);
    assert.match(r.out, /##vso\[task\.logissue type=error\]HARNESS_COPIES y HARNESS_MEASURED_COPY ya no se leen: las copias del arnés se declaran en team-repos\.json/, caso);
    assert.deepStrictEqual(r.cloned, [], `${caso}: no se bajó nada`);
  }
  // una variable vacía (o sólo separadores) es como no tenerla
  r = runDiscover(labOrg(undefined), { HARNESS_COPIES: ' ; ' });
  assert.strictEqual(r.code, 0, r.out);
  // un team-repos.json que no valida: rojo con el motivo, sin bajar nada («no pude saber» no es «no hay copias»)
  r = runDiscover(labOrg(teamRepos({ harness_copies: [azRepo('Harness', '')] })));
  assert.notStrictEqual(r.code, 0, r.out);
  assert.match(r.out, /harness_copies\.0\.repo/);
  assert.match(r.out, /##vso\[task\.logissue type=error\]team-repos\.json no valida/);
  assert.deepStrictEqual(r.cloned, []);
});

// ── la paridad de los productos, cada noche, dentro de la revisión de dependencias (T10-T12) ──────────────────────
const PARITY = 'Comparar los pipelines de los productos (paridad)';
const named = (text, name) => steps(text).findIndex((s) => s.includes(`displayName: '${name}'`));
/** El guion de un paso `- script: |` de un modelo, con las macros de Azure reemplazadas. */
function stepScript(model, name, vars) {
  const s = steps(read(model))[named(read(model), name)];
  assert.ok(s, `${model}: falta el paso «${name}»`);
  const m = s.match(/- script: \|\n([\s\S]*?)\n {8}displayName:/);
  assert.ok(m, `${model}: «${name}» es un paso script`);
  let body = m[1].split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n');
  for (const [k, v] of Object.entries(vars)) body = body.split(`$(${k})`).join(v);
  assert.doesNotMatch(body, /\$\([A-Z][A-Za-z]+\.[A-Za-z.]+\)/, 'no quedó ninguna macro de Azure sin reemplazar');
  return body;
}

test('T10 DependencyAudit_PasoParidad_OrdenYSalida @story-2.25 @ac-7 @ac-11 @ac-15: entre el control del árbol y la revisión; credencial, día, rc antes de tuberías, aviso por el archivo, sale 0', () => {
  const text = read('dependency-audit.yml');
  const all = steps(text);
  const tree = all.findIndex((s) => /- template: pipelines\/operations\/templates\/check-tree\.yml@harness/.test(s));
  const parity = named(text, PARITY);
  const run = named(text, 'Correr la revisión de dependencias');
  assert.ok(tree >= 0 && parity > tree && run > parity, `orden: árbol ${tree} < paridad ${parity} < revisión ${run}`);
  const s = all[parity];
  assert.match(s, /^ {8}env:\n {10}SYSTEM_ACCESSTOKEN: \$\(System\.AccessToken\)$/m, 'la credencial va en su env');
  assert.match(s, /HOY="\$\{HOY_NOCTURNO:-\$\(date -u \+%Y-%m-%d\)\}"/, 'el día, como la revisión');
  assert.match(s, /##vso\[task\.setvariable variable=HOY_NOCTURNO\]\$HOY/, 'y lo publica');
  assert.match(s, /LISTA=\$\(node scripts\/ci\/check-product-parity\.js clone-list --root "\$CLONES" --platform azure\) \\\n\s+\|\| echo "##vso\[task\.logissue type=warning\]/, 'pide lo que falta clonar, de su plataforma, y si no puede lo dice');
  assert.match(s, /done <<< "\$LISTA"/, 'clona desde la lista ya leída');
  assert.match(s, /\$\(printf '%s' "\$ERR" \| tr '\\r\\n' '  ' \| sed 's\/##vso\/## vso\/g'\)/, 'el error del clon no puede dar órdenes al agente (ni con \\r)');
  assert.match(s, /\$\(printf '%s' "\$AVISO" \| tr '\\r\\n' '  ' \| sed 's\/##vso\/## vso\/g'\)/, 'el aviso tampoco');
  const lines = s.split('\n');
  const cmd = lines.findIndex((l) => /check-product-parity\.js --root/.test(l));
  assert.ok(cmd > 0, 'corre el control');
  let end = cmd; while (/\\\s*$/.test(lines[end])) end += 1;
  assert.doesNotMatch(lines.slice(cmd, end + 1).join('\n'), /\|/, 'el control no va en una tubería');
  assert.match(lines[end + 1] || '', /^\s*RC=\$\?$/, 'el código se lee en la línea siguiente');
  assert.match(lines.slice(cmd, end + 1).join('\n'), /--today "\$HOY" --out "\$OUT"/, 'el día del archivo es el de la noche');
  assert.match(s, /OUT="\$\(Build\.SourcesDirectory\)\/\.dashboard\/paridad\/paridad-\$HOY\.json"/);
  assert.match(s, /node -e/, 'el aviso sale del archivo');
  assert.match(s, /\n\s+exit 0\n {8}displayName:/, 'el paso sale siempre 0');
  assert.doesNotMatch(s, /continueOnError|telegram|daily-summary/i, 'no avisa por ningún canal ni se esconde');
  // los pasos de antes, en el mismo orden entre sí
  const before = ['Leer la configuración de la organización (operations.json y repos.json)', 'Registrar lo que se decidió en los pull requests',
    'Clonar los repos declarados', 'Volcar el estado de los pedidos de trabajo', 'Correr la revisión de dependencias', 'Crear los pedidos de trabajo',
    'Probar el sitio sin sesión', 'Entregar el resumen', 'Guardar el snapshot y las fichas en el repo de operaciones', 'Abrir un pull request por hallazgo (ahí se decide)',
    'Denunciar que los pedidos no se intentaron'].map((n) => named(text, n));
  assert.ok(before.every((i, k) => i >= 0 && (k === 0 || i > before[k - 1])), `los pasos de siempre, en su orden: ${before.join(',')}`);
});

/** El paso de la paridad corrido de verdad: <base>/s es el árbol, <base>/t/repos los clones, <base>/org la organización. */
function parityLab(cfg, { clones = {}, org = {}, script = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-parity-'));
  dirs.push(base);
  const s = path.join(base, 's');
  const temp = path.join(base, 't');
  fs.mkdirSync(path.join(s, 'scripts', 'ci'), { recursive: true });
  if (script) for (const f of ['check-product-parity.js', 'legacy-options.js']) fs.copyFileSync(path.join(ROOT, 'scripts', 'ci', f), path.join(s, 'scripts', 'ci', f));
  fs.writeFileSync(path.join(s, 'scripts', 'ci', 'product-parity.json'), JSON.stringify(cfg));
  const publish = (dir, yml, bare) => {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, ['init', '--quiet', '-b', 'main']);
    write(dir, { 'azure-pipelines.yml': yml });
    git(dir, ['add', '-A']); git(dir, ['commit', '--quiet', '-m', 'p']);
    if (!bare) { git(dir, ['remote', 'add', 'origin', '.']); git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']); }
  };
  for (const [ruta, yml] of Object.entries(clones)) publish(path.join(temp, 'repos', ruta), yml);
  for (const [ado, yml] of Object.entries(org)) { const [p, r] = ado.split('/'); publish(path.join(base, 'org', p, '_git', r), yml, true); }
  const body = stepScript('dependency-audit.yml', PARITY, { 'Build.SourcesDirectory': s, 'Agent.TempDirectory': temp, 'System.CollectionUri': `file://${base}/org/`, RAMA_ANALIZADA: 'main' });
  assert.doesNotMatch(body, /\$\([A-Z_]+\)/, 'ninguna variable del pipeline sin reemplazar');
  const r = spawnSync('bash', ['-c', body], { env: cleanEnv({ SYSTEM_ACCESSTOKEN: 'token-de-prueba', HOY_NOCTURNO: '2026-01-02' }), encoding: 'utf8' });
  const file = path.join(s, '.dashboard', 'paridad', 'paridad-2026-01-02.json');
  return { code: r.status, out: `${r.stdout}${r.stderr}`, temp, result: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null };
}
const grupo = (...repos) => ({ grupos: { backend: repos }, rasgos: [{ id: 'reintento', que: 'reintento', patron: 'Too Many Requests' }], diferencias_declaradas: [] });

test('T10b DependencyAudit_PasoParidad_Corre @story-2.25 @ac-7: clona lo que falta, deja el archivo del día y avisa por lo que dice el archivo, nunca por el código solo', () => {
  // medido y en orden: uno ya clonado, el otro lo clona el paso; ningún aviso
  let r = parityLab(grupo({ producto: 'Acme Uno', ruta: 'Acme/Uno' }, { producto: 'Acme Dos', ruta: 'Acme/Dos', ado: 'Acme/Dos' }),
    { clones: { 'Acme/Uno': 'Too Many Requests\n' }, org: { 'Acme/Dos': 'Too Many Requests\n' } });
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.result && r.result.estado, 'medido', r.out);
  assert.doesNotMatch(r.out, /task\.logissue/, 'medido y en orden: nada');
  assert.match(r.out, /##vso\[task\.setvariable variable=HOY_NOCTURNO\]2026-01-02/);
  assert.match(r.out, /paridad: \d+ s/, 'imprime el tiempo del paso');
  assert.doesNotMatch(fs.readFileSync(path.join(r.temp, 'repos', 'Acme', 'Dos', '.git', 'config'), 'utf8'), /extraheader|token-de-prueba/, 'el clon no guarda la credencial');
  // una divergencia: aviso con las cantidades
  r = parityLab(grupo({ producto: 'Acme Uno', ruta: 'Acme/Uno' }, { producto: 'Acme Dos', ruta: 'Acme/Dos' }),
    { clones: { 'Acme/Uno': 'Too Many Requests\n', 'Acme/Dos': 'nada\n' } });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /##vso\[task\.logissue type=warning\][^\n]*1 divergencias · 0 vencidas/);
  // parcial SIN divergencias sale 0 del control: igual avisa, por el archivo
  r = parityLab(grupo({ producto: 'Acme Uno', ruta: 'Acme/Uno' }, { producto: 'Acme Dos', ruta: 'Acme/Dos' }, { producto: 'Acme Tres', ruta: 'Acme/Tres' }),
    { clones: { 'Acme/Uno': 'Too Many Requests\n', 'Acme/Dos': 'Too Many Requests\n' } });
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.result && r.result.rc, 0, r.out);
  assert.match(r.out, /##vso\[task\.logissue type=warning\][^\n]*0 divergencias · 0 vencidas · 1 sin medir/);
  // sin productos: nada
  r = parityLab({ sin_productos: 'sin lista de la organización', grupos: {}, rasgos: [], diferencias_declaradas: [] });
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.result && r.result.estado, 'sin_productos', r.out);
  assert.doesNotMatch(r.out, /task\.logissue/);
  // no medido: con su motivo
  r = parityLab(grupo({ producto: 'Acme Uno', ruta: 'Acme/Uno' }));
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /##vso\[task\.logissue type=warning\][^\n]*no medido: /);
  // el control no dejó el archivo: se dice, y el paso sigue
  r = parityLab(grupo({ producto: 'Acme Uno', ruta: 'Acme/Uno' }), { script: false });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /##vso\[task\.logissue type=warning\][^\n]*la paridad no dejó su resultado/);
});

test('T11 DependencyAudit_GuardaLaParidad @story-2.25 @ac-7: guardar lleva .dashboard/paridad', () => {
  const s = steps(read('dependency-audit.yml')).find((x) => /push-nightly-data\.js save/.test(x));
  // detrás, lo que escribe la propuesta del modelo (Casos: scripts/tests/findings-propose.test.js): las fichas de las
  // otras dos fuentes y su constancia
  assert.match(s, /-- \.dashboard\/dependencias inbox\/dependencies \.dashboard\/paridad( \.dashboard\/retros)?( inbox\/runs-review\/pending inbox\/watcher\/pending inbox\/model-proposals\.json)?\s*$/m);
});

test('T12 OpsData_TraeLaListaDeLaOrganizacion @story-2.25 @ac-9: la lista de productos de operaciones va encima; sin ella queda la del arnés', () => {
  assert.match(read('templates/ops-data.yml'), /CONFIG_FILES=\([^)]*scripts\/ci\/product-parity\.json[^)]*\)/);
  for (const [ops, want] of [[{ 'scripts/ci/product-parity.json': '{"de":"la organización"}\n' }, 'la organización'], [{}, 'del arnés']]) {
    const w = agent({ 'operations.json': '{"version":1,"owners":{"default":"lider@acme.example"}}\n', ...ops });
    write(w.s, { 'scripts/ci/product-parity.json': '{"sin_productos":"del arnés"}\n' });
    git(w.s, ['add', '-A']); git(w.s, ['commit', '--quiet', '-m', 'la copia pública']);
    const r = runOpsData(w);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(fs.readFileSync(path.join(w.s, 'scripts', 'ci', 'product-parity.json'), 'utf8'), new RegExp(want));
  }
});

// T32: lo que deja la noche para el sitio de la organización. Los dos productores corren con los datos
// de operaciones ya traídos y antes de generar la página, y se guardan con la página (bajo .dashboard, que el sync trajo).
test('T32 TeamDashboard_ProductoresDelSitio', () => {
  const y = read('team-dashboard.yml');
  const i = (re) => y.search(re);
  const traer = i(/displayName: 'Traer de main del repo de operaciones/);
  const prod = i(/displayName: 'Lo que deja la noche para el sitio/);
  const generar = i(/displayName: 'Generar la página del tablero \(modo nocturno\)'/);
  assert.ok(traer >= 0 && prod > traer && generar > prod, 'traer → productores → generar');
  assert.match(y, /open-prs\.js --today "\$DAY" --org "\$\(System\.CollectionUri\)" --json "\.dashboard\/open-prs\/open-prs-\$DAY\.json"/);
  assert.match(y, /assigned-items\.js --today "\$DAY" --org "\$\(System\.CollectionUri\)" --out \.dashboard\/assigned/);
  assert.match(y, /-- artifacts\/tablero-del-arnes\.html \.dashboard\/open-prs \.dashboard\/assigned \.dashboard\/deployments \.dashboard\/applied-config\.json\n/, 'se guardan con la página (la marca de la configuración aplicada, tanda C de la 2.29)');
  assert.match(y, /push-nightly-data\.js sync -- \.dashboard /, 'el sync trae .dashboard: guardar sus carpetas no sale 2');
});

// la foto de despliegues corre ANTES de la página, tolerante (naranja, nunca roja), con el permiso de la
// corrida, y la carpeta se guarda con la página.
test('T21 TeamDashboard_PasoDeDesplieguesAntesDelTablero (2.22)', () => {
  const y = read('team-dashboard.yml');
  const foto = y.search(/displayName: 'La foto de despliegues de cada producto'/);
  const generar = y.search(/displayName: 'Generar la página del tablero \(modo nocturno\)'/);
  assert.ok(foto >= 0 && generar > foto, 'foto → página');
  const paso = y.slice(y.lastIndexOf('- script:', foto), generar);
  assert.match(paso, /deployments\.js --today "\$\(date -u \+%Y-%m-%d\)" --org "\$\(System\.CollectionUri\)" --out \.dashboard\/deployments/);
  assert.match(paso, /continueOnError: true/);
  assert.match(paso, /AZURE_DEVOPS_EXT_PAT: \$\(System\.AccessToken\)/);
});

// la marca tiene que llegar a main de operaciones, que es lo que lee el sitio. El paso del
// tablero que trae los datos de main la pisa; por eso ops-data.yml deja una copia en la carpeta temporal del trabajo, y el
// guardado del tablero la devuelve y la nombra. Se corre dos veces el mismo día: la segunda no puede chocar.
test('T40 TableroGuarda_LaMarcaLlegaAOperaciones_DosVecesElMismoDia @story-2.29 @ac-24 (tanda C): ops-data, el sync, la devolución y el guardado reales', () => {
  const PUSH = path.join(ROOT, 'scripts', 'ci', 'push-nightly-data.js');
  // los dos pipelines del tablero devuelven la marca antes de guardar y la nombran en lo que guardan
  const pasos = [];
  for (const [f, temp] of [['team-dashboard.yml', '$(Agent.TempDirectory)'], ['github/team-dashboard.yml', '${RUNNER_TEMP}']]) {
    const y = read(f);
    const i = y.indexOf('push-nightly-data.js save');
    assert.ok(i > 0, `${f}: guarda`);
    const antes = y.slice(y.lastIndexOf('run: |', i) > y.lastIndexOf('- script: |', i) ? y.lastIndexOf('run: |', i) : y.lastIndexOf('- script: |', i), i);
    const devolver = antes.split('\n').map((l) => l.trim()).find((l) => / cp |^cp /.test(` ${l}`) && l.includes('applied-config.json'));
    assert.ok(devolver && devolver.includes(`${temp}/applied-config.json`), `${f}: devuelve la marca de la carpeta temporal en el mismo paso, antes de guardar`);
    const lista = y.slice(i, y.indexOf('\n', y.indexOf(' -- ', i)));
    assert.match(lista, / -- [^\n]*\.dashboard\/applied-config\.json/, `${f}: la marca está en lo que se guarda`);
    pasos.push(devolver);
  }
  const corrida = (remote, n) => {
    const w = agent({ 'operations.json': '{"version":1,"owners":{"default":"lider@acme.example"}}\n', 'scripts/nightly/dashboard/sources.json': '{"thresholds":{}}\n' }, { remote });
    const r = runOpsData(w);
    assert.strictEqual(r.code, 0, r.out);
    const tmp = path.join(w.build, 'tmp');
    assert.strictEqual(fs.readFileSync(path.join(tmp, 'applied-config.json'), 'utf8'), fs.readFileSync(path.join(w.s, APPLIED), 'utf8'), 'la copia de la carpeta temporal es la marca');
    const tree = (r.out.match(/##vso\[task\.setvariable variable=HARNESS_TREE\](\S+)/) || [])[1];
    const env = cleanEnv({ HARNESS_TREE: tree, BUILD_BUILDID: `corrida-${n}` });
    const sync = spawnSync(process.execPath, [PUSH, 'sync', '--', '.dashboard', 'artifacts/tablero-del-arnes.html'], { cwd: w.s, env, encoding: 'utf8' });
    assert.strictEqual(sync.status, 0, `${sync.stdout}${sync.stderr}`);
    // el tablero escribe su página; después, el paso de guardar devuelve la marca: la línea real de Azure en la primera
    // corrida y la de GitHub (con RUNNER_TEMP) en la segunda, así las dos se ejecutan de verdad
    write(w.s, { 'artifacts/tablero-del-arnes.html': `<p>ejecución ${n}</p>\n` });
    const linea = n === 1 ? pasos[0].split('$(Agent.TempDirectory)').join(tmp) : pasos[1];
    const dev = spawnSync('bash', ['-c', `set -eu; ${linea}`], { cwd: w.s, env: { ...env, RUNNER_TEMP: tmp }, encoding: 'utf8' });
    assert.strictEqual(dev.status, 0, dev.stderr);
    const save = spawnSync(process.execPath, [PUSH, 'save', '--wait-ms', '0', '--message', `tablero ${n}`, '--', 'artifacts/tablero-del-arnes.html', '.dashboard/applied-config.json'], { cwd: w.s, env, encoding: 'utf8' });
    assert.strictEqual(save.status, 0, `ejecución ${n}: ${save.stdout}${save.stderr}`);
    const enMain = JSON.parse(git(w.opsRemote, ['show', `main:${APPLIED}`]));
    assert.deepStrictEqual(enMain, JSON.parse(fs.readFileSync(path.join(tmp, 'applied-config.json'), 'utf8')), `ejecución ${n}: main de operaciones tiene la marca de esta ejecución`);
    assert.ok(enMain.files['scripts/nightly/dashboard/sources.json'], 'nombra el sources.json, que es lo que habilita Umbrales');
    return w;
  };
  const w1 = corrida(null, 1);
  corrida(w1.opsRemote, 2);
});

// ── la prueba sin sesión antes del aviso, el canal por notify.js, y las rutas protegidas (T26, T37) ───────────────────
test('T26 DependencyAudit_PruebaSinSesionAntesDelAviso (Azure) @story-2.30 @ac-15 @ac-18 @ac-23', () => {
  const t = read('dependency-audit.yml');
  const prueba = named(t, 'Probar el sitio sin sesión');
  const aviso = named(t, 'Entregar el resumen');
  assert.ok(prueba >= 0 && aviso === prueba + 1, `la prueba justo antes del aviso (${prueba}, ${aviso})`);
  const p = steps(t)[prueba];
  assert.match(p, /scripts\/site\/check-deploy\.js --url "\$URL" --out "\$\{AGENT_TEMPDIRECTORY:-\$\{TMPDIR:-\/tmp\}\}\/site-check\.json"/);
  assert.match(p, /c\.data\.site && c\.data\.site\.url/, 'sólo con site.url');
  assert.match(p, /\n {10}exit 0\n {8}displayName:/, 'la prueba nunca frena la noche');
  // un operations.json que no se pudo leer no es «sin site.url»: lo dice, y no prueba nada
  const cuerpo = stepScript('dependency-audit.yml', 'Probar el sitio sin sesión', { 'Build.SourcesDirectory': '/x' });
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-sitio-'));
  try {
    fs.symlinkSync(path.join(ROOT, 'scripts'), path.join(lab, 'scripts'));
    fs.writeFileSync(path.join(lab, 'operations.json'), '{ roto');
    const r = spawnSync('bash', ['-c', cuerpo.replace('cd "/x"', `cd "${lab}"`)], { encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH } });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /##vso\[task\.logissue type=warning\].*operations\.json no se pudo leer/);
    assert.doesNotMatch(r.stdout, /sin site\.url/);
  } finally { fs.rmSync(lab, { recursive: true, force: true }); }
  const e = steps(t)[aviso];
  const cond = (e.match(/^ {8}condition: (.*)$/m) || [])[1] || '';
  assert.strictEqual(cond, "and(succeeded(), eq('${{ parameters.efectos }}', 'true'))", 'el aviso corre siempre que haya efectos, sin mirar el chat');
  assert.match(e, /--operations "\$\(Build\.SourcesDirectory\)\/operations\.json"/);
  assert.match(e, /--site-check "\$\{AGENT_TEMPDIRECTORY:-\$\{TMPDIR:-\/tmp\}\}\/site-check\.json"/);
  assert.match(e, /^ {10}TYCON_NOTIFY_WEBHOOK_URL: \$\(TYCON_NOTIFY_WEBHOOK_URL\)$/m);
  assert.match(e, /case "\$\{TYCON_NOTIFY_WEBHOOK_URL:-\}" in \*'\$\('\*\) unset TYCON_NOTIFY_WEBHOOK_URL ;; esac/, 'el literal de Azure, como ausente');
  // el webhook, sólo en el paso del aviso, y en ningún otro modelo
  assert.deepStrictEqual(steps(t).map((x, i) => (/TYCON_NOTIFY_WEBHOOK_URL/.test(x) ? i : -1)).filter((i) => i >= 0), [aviso]);
  for (const m of MODELS.filter((f) => f !== 'dependency-audit.yml')) assert.doesNotMatch(read(m), /TYCON_NOTIFY_WEBHOOK_URL/, `${m} no lleva el webhook`);
});

test('T37 Nocturnos_NoTocanLasRutasProtegidas (Azure) @story-2.30 @ac-22', () => {
  let vistos = 0;
  for (const m of [...MODELS, ...TEMPLATES.map((x) => `templates/${x}`)]) {
    for (const g of read(m).matchAll(/push-nightly-data\.js (?:save|sync)[\s\S]*?\s--\s+([^\n|]+)/g)) {
      vistos += 1;
      for (const r of g[1].trim().split(/\s+/).filter((x) => !x.startsWith('2>'))) {
        assert.ok(r !== 'operations.json' && !r.startsWith('pipelines/') && !r.startsWith('.github/workflows'), `${m} guarda ${r}, una ruta protegida`);
      }
    }
  }
  assert.ok(vistos >= 3, `se leyeron los guardados de los modelos (vistos: ${vistos})`);
  const readme = read('README.md');
  assert.match(readme, /Minimum number of reviewers/);
  assert.match(readme, /Bypass policies when pushing/);
  assert.match(readme, /Required reviewers/);
  assert.match(readme, /archivo por archivo/);
});

// T21: la concentración por persona corre en el nocturno de métricas, en el MISMO paso que la foto
// por proyecto y después de ella; una falla avisa y no apaga el snapshot; el guardado suma su archivo. Las líneas nuevas
// no suman un paso, un `displayName` ni las palabras «clone»/«clones» (otra prueba las cuenta).
function pasoConConcentracion(y, nombre, donde) {
  const i = y.indexOf('node scripts/nightly/projects/snapshot.js');
  const j = y.indexOf(`displayName: '${nombre}'`, i);
  assert.ok(i > 0 && j > i, `${donde}: no encontré la foto y el paso «${nombre}»`);
  const paso = y.slice(i, j);
  const k = paso.indexOf('node scripts/metrics/author-concentration.js');
  assert.ok(k > 0, `${donde}: la concentración no está en el paso de la foto, después de ella`);
  const nuevo = paso.slice(k);
  assert.match(nuevo, /\|\| echo "##vso\[task\.logissue type=warning\]/, `${donde}: la falla de la concentración tiene que avisar, no apagar`);
  assert.match(nuevo, /⏱ {2}concentración por persona/, `${donde}: imprime su duración`);
  assert.doesNotMatch(nuevo, /- script:|displayName|\bclones?\b/, `${donde}: las líneas nuevas no suman pasos ni la palabra clone(s)`);
  assert.match(y, /'\.dashboard\/author-concentration-\*\.json'/, `${donde}: el guardado suma el archivo de concentración`);
}

test('T21 2.26-StageMetrics_ConcentracionEnElPasoDeLaFoto — el modelo público, y con lo privado debajo, su copia y su plantilla', () => {
  pasoConConcentracion(read('stage-metrics.yml'), 'Medir y escribir el punto del día', 'pipelines/operations/stage-metrics.yml');
  // el modelo de GitHub no cambia: sin el archivo, la ficha sale «no medido»
  assert.doesNotMatch(read('github/stage-metrics.yml'), /author-concentration/, 'el modelo de GitHub no corre la concentración');
  const privado = path.join(ROOT, 'pipelines', 'azure-pipelines.yml');
  if (!fs.existsSync(privado)) {
    console.log('  (T21 lo privado —azure-pipelines.yml, ops-data.yml y .gitignore— no viene con la copia pública: NO MEDIDO acá)');
    return;
  }
  pasoConConcentracion(fs.readFileSync(privado, 'utf8'), 'Medir las 4 métricas y escribir el snapshot del día', 'pipelines/azure-pipelines.yml');
  const ops = fs.readFileSync(path.join(ROOT, 'pipelines', 'templates', 'ops-data.yml'), 'utf8');
  assert.match(ops, /author-concentration-\*\.json/, 'ops-data.yml trae el archivo de concentración al árbol');
  const ign = spawnSync('git', ['-C', ROOT, 'check-ignore', '-q', '.dashboard/author-concentration-2026-10-15.json']);
  assert.strictEqual(ign.status, 1, '.gitignore del privado deja pasar el archivo de concentración');
});

// T9: la cuenta de los cambios sin historia corre en el mismo paso, después de la concentración, sobre
// las mismas copias; una falla avisa y no apaga el paso; el guardado suma su archivo. Sin pasos nuevos ni «clone(s)».
function pasoConSinHistoria(y, nombre, donde) {
  const i = y.indexOf('node scripts/metrics/author-concentration.js');
  const j = y.indexOf(`displayName: '${nombre}'`, i);
  assert.ok(i > 0 && j > i, `${donde}: no encontré la concentración y el paso «${nombre}»`);
  const paso = y.slice(i, j);
  const k = paso.indexOf('node scripts/metrics/story-reference.js');
  assert.ok(k > 0, `${donde}: la cuenta sin historia no está en el paso, después de la concentración`);
  const nuevo = paso.slice(k);
  assert.match(nuevo, /--scan "\$\(Agent\.TempDirectory\)\/repos"/, `${donde}: cuenta sobre las mismas copias`);
  assert.match(nuevo, /--out "\$\(Build\.SourcesDirectory\)\/\.dashboard\/story-reference-\$\(date -u \+%Y-%m-%d\)\.json"/, `${donde}: el archivo del día en .dashboard/`);
  assert.match(nuevo, /\|\| echo "##vso\[task\.logissue type=warning\]/, `${donde}: la falla avisa, no apaga`);
  assert.match(nuevo, /⏱ {2}cambios sin historia/, `${donde}: imprime su duración`);
  assert.doesNotMatch(nuevo, /- script:|displayName|\bclones?\b/, `${donde}: las líneas nuevas no suman pasos ni la palabra clone(s)`);
  assert.match(y, /'\.dashboard\/story-reference-\*\.json'/, `${donde}: el guardado suma el archivo`);
}

test('T9 1.31-StageMetrics_CuentaEnElPasoDeLaConcentracion @story-1.31 @ac-5 — el modelo público y, con lo privado debajo, su copia y su plantilla', () => {
  pasoConSinHistoria(read('stage-metrics.yml'), 'Medir y escribir el punto del día', 'pipelines/operations/stage-metrics.yml');
  assert.doesNotMatch(read('github/stage-metrics.yml'), /story-reference/, 'el modelo de GitHub no la corre: sin el archivo, la ficha sale «no medido»');
  const privado = path.join(ROOT, 'pipelines', 'azure-pipelines.yml');
  if (!fs.existsSync(privado)) {
    console.log('  (T9 lo privado —azure-pipelines.yml, ops-data.yml y .gitignore— no viene con la copia pública: NO MEDIDO acá)');
    return;
  }
  pasoConSinHistoria(fs.readFileSync(privado, 'utf8'), 'Medir las 4 métricas y escribir el snapshot del día', 'pipelines/azure-pipelines.yml');
  const ops = fs.readFileSync(path.join(ROOT, 'pipelines', 'templates', 'ops-data.yml'), 'utf8');
  assert.match(ops, /story-reference-\*\.json/, 'ops-data.yml trae el archivo del día al árbol');
  const ign = spawnSync('git', ['-C', ROOT, 'check-ignore', '-q', '.dashboard/story-reference-2026-10-20.json']);
  assert.strictEqual(ign.status, 1, '.gitignore del privado deja pasar el archivo del día');
});

test('T25 2.34-Copia_DisparosYCredencial (Azure) @story-2.34 @ac-4 — cada push a main y una vez por día, con su conexión propia', () => {
  // 🔴 rojo: la copia corre una vez por noche (un cambio tarda un día en verse) o usa la credencial de otro trabajo.
  const t = read('site-copy.yml');
  assert.match(t, /^trigger:\n {2}batch: true\n {2}branches:\n {4}include: \[main\]\n/m, 'cada push a main, sin filtro de rutas');
  assert.doesNotMatch(t, /^ {2}paths:/m, 'sin filtro de rutas: cualquier cambio de lo copiado cuenta');
  assert.match(t, /^schedules:\n {2}- cron: '[^']+'/m, 'una vez por día, de respaldo');
  assert.match(t, /^ {4}always: true$/m);
  assert.match(t, /azureSubscription: 'site-copy'/, 'su propia conexión de servicio');
  assert.match(t, /operations-copy\.js" subir \\\n\s+--repo "\$\(Pipeline\.Workspace\)\/ops" --account "\$\(SITE_COPY_ACCOUNT\)" --container "\$\(SITE_COPY_CONTAINER\)"/);
  assert.match(t, /fetch --depth 1 --no-tags origin main/, 'la punta de main, nunca el commit que disparó');
  assert.doesNotMatch(t, /SITE_OPERATIONS_TOKEN|SITE_MAILBOX|\$\([A-Z_]*(KEY|SECRET|PASSWORD)\)/, 'ningún secreto ni la credencial del buzón');
  assert.match(read('README.md'), /site-copy\.yml/, 'el README la da de alta');
});

test('T28 2.33-Nocturno_ConexionPropiaYOrden (Azure) @story-2.33 @ac-10 @ac-11 — su conexión, antes de dependencias, sin secretos escritos', () => {
  // 🔴 rojo: el nocturno que cambia producción usa la conexión de otro (la del buzón o la de dependencias), o corre después.
  const t = read('site-update.yml');
  const cron = (f) => { const m = read(f).match(/- cron: '(\d+) (\d+) \* \* \*'/); return Number(m[2]) * 60 + Number(m[1]); };
  assert.ok(cron('site-update.yml') < cron('dependency-audit.yml'), 'antes del de dependencias (que prueba el sitio y avisa a la mañana)');
  assert.match(t, /^trigger: none\b/m, 'sólo programado');
  assert.match(t, /azureSubscription: 'site-update'/, 'su propia conexión de servicio');
  assert.doesNotMatch(t, /azureSubscription: '(?!site-update')/, 'ninguna otra conexión');
  assert.match(t, /scripts\/site\/deploy\/update-site\.js --platform "\$\(SITE_PLATFORM\)"/);
  assert.match(t, /--operations-json operations\.json --state-dir \.dashboard\/site-update/, 'el modo sale de operations.json; el resultado, a los datos');
  assert.match(t, /SITE_RENDER_DEPLOY_HOOK: \$\(SITE_RENDER_DEPLOY_HOOK\)/, 'el hook de Render, de una variable secreta (nunca escrito)');
  assert.doesNotMatch(t, /https:\/\/api\.render\.com\/deploy/, 'ningún hook escrito');
  assert.match(t, /push-nightly-data\.js save[\s\S]*-- \.dashboard\/site-update/, 'el resultado se guarda en operaciones');
  assert.match(read('README.md'), /site-update\.yml/);
});

test('T9 1.26-Nocturno_BarridoAntesDelResumen @story-1.26 @ac-6: el barrido de las retros corre antes del resumen, le pasa su informe y se guarda', () => {
  const all = steps(read('dependency-audit.yml'));
  const at = (re) => all.findIndex((s) => re.test(s));
  const sweep = at(/retro-sweep\.js/);
  const deliver = at(/daily-summary\.js deliver/);
  assert.ok(sweep >= 0, 'un paso corre retro-sweep.js');
  assert.ok(sweep < deliver, 'antes de entregar el resumen');
  assert.ok(sweep > at(/displayName: 'Clonar los repos declarados'/), 'después de clonar');
  const s = all[sweep];
  assert.match(s, /--team-repos "\$\(Build\.SourcesDirectory\)\/team-repos\.json"/, 'los repos, de team-repos.json');
  assert.match(s, /--out "\$\(Build\.SourcesDirectory\)\/\.dashboard\/retros"/, 'los latidos en .dashboard/retros de operaciones');
  assert.match(s, /--report "[^"]*retro-sweep-\$HOY\.json"/, 'deja su informe del día');
  assert.match(s, /CLONE_TOKEN: \$\(System\.AccessToken\)/, 'clona con la credencial de la ejecución');
  assert.match(s, /exit 0\s*$/m, 'un repo que no se pudo mirar no corta la noche: lo dice el resumen');
  assert.match(all[deliver], /--retros "[^"]*retro-sweep-\$HOY\.json"/, 'el resumen recibe el informe');
  const save = all.find((x) => /push-nightly-data\.js save/.test(x) && /\.dashboard\/dependencias/.test(x));
  assert.match(save, /\.dashboard\/retros/, 'guardar lleva .dashboard/retros');
});

// ── Lo que se instala cada noche sale de repos.json ─────────────────────────────────────────────────────────────────────
// .NET sólo con algún repo nuget activo; Python y pip-audit sólo con alguno pip activo. El paso de la configuración lo
// decide corriendo de verdad sobre un árbol de juguete.
test('T7 ProcesoAzure_InstalaSegunRepos @story-8.50 @ac-5: el paso de la configuración decide .NET y Python; cada instalación lleva su condición', () => {
  const text = read('dependency-audit.yml');
  // el bloque que repite .NET por versión no es un paso para `steps()`: el orden y las condiciones se leen del texto
  const at = (re) => { const i = text.search(re); assert.ok(i >= 0, `falta ${re}`); return i; };
  const conf = at(/displayName: 'Leer la configuración de la organización \(operations\.json y repos\.json\)'/);
  const dotnet = at(/- task: UseDotNet@2\n {12}displayName: 'SDK \.NET \$\{\{ sdk \}\}'\n {12}condition: and\(succeeded\(\), eq\(variables\.HAS_NUGET, '1'\)\)\n/);
  const python = at(/- task: UsePythonVersion@0\n {8}displayName: [^\n]+\n {8}condition: and\(succeeded\(\), eq\(variables\.HAS_PIP, '1'\)\)\n/);
  const pipAudit = at(/- script: python -m pip install [^\n]*pip-audit==2\.10\.1\n {8}displayName: [^\n]+\n {8}condition: and\(succeeded\(\), eq\(variables\.HAS_PIP, '1'\)\)\n/);
  const review = at(/displayName: 'Correr la revisión de dependencias'/);
  assert.ok(conf < dotnet && conf < python && python < pipAudit && pipAudit < review && dotnet < review, `orden: configuración ${conf} < .NET ${dotnet}, Python ${python} < pip-audit ${pipAudit} < revisión ${review}`);
  const run = (repos) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-kinds-'));
    dirs.push(base);
    fs.mkdirSync(path.join(base, 'scripts', 'nightly', 'dependencies'), { recursive: true });
    fs.writeFileSync(path.join(base, 'scripts', 'nightly', 'dependencies', 'repos.json'), JSON.stringify({ repos }));
    const body = stepScript('dependency-audit.yml', 'Leer la configuración de la organización (operations.json y repos.json)', { 'Build.SourcesDirectory': base });
    const r = spawnSync('bash', ['-c', body], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const v = (k) => (r.stdout.match(new RegExp(`##vso\\[task\\.setvariable variable=${k}\\](\\d)`)) || [])[1];
    return `${v('HAS_NUGET')}${v('HAS_PIP')}`;
  };
  assert.strictEqual(run([{ tipo: 'npm' }, { tipo: 'nuget' }]), '10');
  assert.strictEqual(run([{ tipo: 'npm' }, { tipo: 'pip' }]), '01');
  assert.strictEqual(run([{ tipo: 'nuget', activo: false }, { tipo: 'pip', activo: false }]), '00', 'un repo apagado no pide su herramienta');
  assert.strictEqual(run([{ tipo: 'nuget' }, { tipo: 'pip' }]), '11');
});

// La regla de `main` del repo de operaciones es una sola («todo automático»), y la dicen igual el README de Azure
// DevOps y la guía del sitio en sus dos idiomas; el de GitHub dice que ahí el sitio todavía no entra solo.
function seccion(texto, desde, hasta) {
  const i = texto.indexOf(desde);
  assert.ok(i >= 0, `falta la sección «${desde}»`);
  const j = texto.indexOf(hasta, i + desde.length);
  assert.ok(j > i, `falta el fin de la sección «${desde}» («${hasta}»)`);
  return texto.slice(i, j).replace(/\s+/g, ' ');
}

test('T1 8.58-UnaSolaRegla_AzureYSitio @story-8.58: el README de Azure y la guía del sitio (es y en) dicen la misma receta', () => {
  const guia = (f) => fs.readFileSync(path.join(ROOT, 'guides', f), 'utf8');
  const secciones = {
    'README de Azure': [seccion(read('README.md'), '### La política de rama de `main`', 'La pestaña Configuración lee'), /\*\*prendido\*\*/, /Lo que se resigna/, /Volver a pedir aprobación/],
    'guía es': [seccion(guia('organization-site.md'), '### La política de rama del repo de operaciones', '### El permiso para'), /\*\*prendido\*\*/, /Lo que se resigna/, /Volver a pedir aprobación/],
    'guía en': [seccion(guia('organization-site.en.md'), '### The branch policy of the operations repo', '### The permission for'), /\*\*on\*\*/, /What you give up/, /Asking for approval again/],
  };
  for (const [donde, [s, prendido, resigna, volver]] of Object.entries(secciones)) {
    assert.match(s, /todo automático|everything automatic/, `${donde}: nombra la regla`);
    assert.match(s, /Require a minimum number of reviewers\*?\*? (\(en la API, «Minimum number of reviewers»\) )?(en|at) 1/, `${donde}: un revisor`);
    assert.match(s, new RegExp(`Allow requestors to approve their own changes\\* ${prendido.source}`), `${donde}: el voto de quien crea el pedido cuenta`);
    assert.match(s, /Prohibit the most recent pusher from approving their own changes\* (apagado|off)/, `${donde}: sin «Prohibit the most recent pusher»`);
    assert.match(s, /Bypass policies when pushing\*\* (en|set to) «?"?Allow/, `${donde}: la excepción de la noche`);
    assert.match(s, /site\.auto_apply: true/, `${donde}: el sitio aplica solo`);
    assert.match(s, resigna, `${donde}: dice qué se resigna`);
    assert.match(s, volver, `${donde}: dice cómo volver a pedir aprobación`);
  }
});

test('T2 8.58-UnaSolaRegla_GitHub @story-8.58: el README de GitHub dice la regla, que el sitio todavía no entra solo, y qué se resigna', () => {
  const s = seccion(read(path.join('github', 'README.md')), '**La protección de `operations.json` y de los workflows.**', 'Y en *Settings → Actions → General*');
  assert.match(s, /todo automático/);
  assert.match(s, /la noche entra sola; el sitio, todavía no/);
  assert.match(s, /Lo que se resigna/);
  assert.match(s, /Volver a pedir aprobación/);
});
