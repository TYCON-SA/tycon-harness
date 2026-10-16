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
    'team-repos.json': '{"version":1,"operations":{"platform":"azure"}}\n', // story 8.31 (T15): la plataforma viaja
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

// story 2.29 (AC 24, decisión 12): el sitio de la organización sabe qué configuración aplicó la noche por la marca
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
  // story 2.29 (AC 24): la marca se deja igual; sin otra configuración que la que copió, sólo con ésa. Sin datos, nada más.
  assert.deepStrictEqual(fs.readdirSync(path.join(w.s, '.dashboard')), ['applied-config.json'], 'no inventa carpetas de datos: sólo la marca');
  assert.deepStrictEqual(appliedMark(w).files, { 'operations.json': git(path.join(w.build, 'ops'), ['rev-parse', 'HEAD:operations.json']) });
  // sin ningún archivo de configuración, files queda vacío
  const w2 = agent({ 'README.md': '# operaciones\n' });
  const r2 = runOpsData(w2);
  assert.strictEqual(r2.code, 0, r2.out);
  assert.deepStrictEqual(appliedMark(w2).files, {}, 'sin configuración copiada, files es {}');
});

// ── las copias del arnés en las métricas: de team-repos.json, no de una variable (DEF-8.30-copias-del-arnes-en-team-repos)
// EL CASO: las métricas del modelo sabían qué repos son copias del arnés por una variable de la definición
// (HARNESS_COPIES, y HARNESS_MEASURED_COPY la que cuenta). El dueño decidió (2026-10-14) que lo diga team-repos.json,
// como el resto de los repos: un lugar menos que configurar. Se corre el paso «Descubrir y clonar» REAL del modelo, con
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

// ── story 2.25: la paridad de los productos, cada noche, dentro de la revisión de dependencias (T10-T12) ──────────
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
    'Entregar el resumen (si hay bot de Telegram)', 'Guardar el snapshot y las fichas en el repo de operaciones', 'Abrir un pull request por hallazgo (ahí se decide)',
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
  assert.match(s, /-- \.dashboard\/dependencias inbox\/dependencies \.dashboard\/paridad\s*$/m);
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

// story 2.23 (AC 16, T32): lo que deja la noche para el sitio de la organización. Los dos productores corren con los datos
// de operaciones ya traídos y antes de generar la página, y se guardan con la página (bajo .dashboard, que el sync trajo).
// La foto de despliegues de la 2.22 todavía no está en el modelo: cuando entre, los productores van después de ella.
test('T32 TeamDashboard_ProductoresDelSitio', () => {
  const y = read('team-dashboard.yml');
  const i = (re) => y.search(re);
  const traer = i(/displayName: 'Traer de main del repo de operaciones/);
  const prod = i(/displayName: 'Lo que deja la noche para el sitio/);
  const generar = i(/displayName: 'Generar la página del tablero \(modo nocturno\)'/);
  assert.ok(traer >= 0 && prod > traer && generar > prod, 'traer → productores → generar');
  assert.match(y, /open-prs\.js --today "\$DAY" --org "\$\(System\.CollectionUri\)" --json "\.dashboard\/open-prs\/open-prs-\$DAY\.json"/);
  assert.match(y, /assigned-items\.js --today "\$DAY" --org "\$\(System\.CollectionUri\)" --out \.dashboard\/assigned/);
  assert.match(y, /-- artifacts\/tablero-del-arnes\.html \.dashboard\/open-prs \.dashboard\/assigned \.dashboard\/deployments\n/, 'se guardan con la página');
  assert.match(y, /push-nightly-data\.js sync -- \.dashboard /, 'el sync trae .dashboard: guardar sus carpetas no sale 2');
});

// story 2.22 (AC 13): la foto de despliegues corre ANTES de la página, tolerante (naranja, nunca roja), con el permiso de la
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
