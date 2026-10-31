'use strict';
// platform-agents.test.js — los revisores, el despachador y las herramientas no hablan con una plataforma: el revisor de
// DoD pide la CI con la capa, el despachador decide el aviso del pedido de trabajo por la configuración y la capa, y
// `work-in-progress.js` pregunta los pedidos de la rama con `change-request list`. Todo contra los dobles de az y de gh:
// ninguna prueba sale a la red.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const AGENT = 'tycon-dod-runtime-checker';
const DISPATCH = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'dispatch.js');
const WIP = path.join(ROOT, 'scripts', 'tools', 'work-in-progress.js');
const FAKE_AZ = path.join(ROOT, 'scripts', 'tests', 'lib', 'fake-az.sh');
const FAKE_GH = path.join(ROOT, 'scripts', 'tests', 'lib', 'fake-gh.js');
const onWindows = process.platform === 'win32' ? 'los dobles de az y gh son guiones con #!, que Windows no corre' : false;

// Las señales duras de una plataforma (las del control de neutralidad) y `gh run`. Los nombres de los archivos de
// configuración de CI no están: de ahí el revisor lee los disparadores, no son comandos.
const HARD = /\baz (boards|repos|pipelines|devops|rest)\b|dev\.azure\.com|_apis\/|\bSystem\.[A-Z]|Microsoft\.VSTS|ado-config|AZURE_DEVOPS|SYSTEM_ACCESSTOKEN|\bgh (pr|api|run)\b|api\.github\.com/;
const signals = (file) => fs.readFileSync(file, 'utf8').split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => HARD.test(l)).map(([n, l]) => `${path.relative(ROOT, file)}:${n}: ${l.trim().slice(0, 120)}`);

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

/** Un entorno sin plataforma de la máquina: casa vacía, árbol con el perfil que pida la prueba. */
function world(profile = {}, teamRepos = null) {
  const tree = tmp('arbol-');
  const home = tmp('casa-');
  fs.writeFileSync(path.join(tree, 'team-profile.json'), JSON.stringify(profile));
  if (teamRepos) fs.writeFileSync(path.join(tree, 'team-repos.json'), JSON.stringify(teamRepos));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^TYCON_|^AZURE_DEVOPS|^GH_(TOKEN|REPO|HOST)$|^FAKE_GH_|^FIXAZ$/.test(k)) env[k] = v;
  Object.assign(env, { HOME: home, USERPROFILE: home, TYCON_TREE: tree, TYCON_HOME: path.join(home, '.tycon') });
  return { tree, home, env };
}

test('T35 Reviewers_NoPlatformCommands @story-8.85 @ac-20: el revisor de DoD y el despachador no nombran comandos de una plataforma', () => {
  const md = path.join(ROOT, 'agents', `${AGENT}.md`);
  const tomls = [path.join(ROOT, 'adapters', 'codex', 'agents', `${AGENT}.toml`), path.join(ROOT, 'adapters', 'codex', 'agents-native', `${AGENT}.toml`)];
  const found = [md, ...tomls, DISPATCH].flatMap(signals);
  assert.deepStrictEqual(found, [], `señales de plataforma:\n${found.join('\n')}`);

  // el revisor pide la CI con la capa y dice qué hace con cada veredicto; todo «no» de la capa es CRITICAL «no medido»
  const text = fs.readFileSync(md, 'utf8');
  // stable-data: «commit» es la clave del JSON que el revisor le pasa a la capa; acá no se crea ningún commit
  assert.match(text, /platform\.js ci read --repo <identidad> --args '\{"commit":"<sha>","branch":"<rama>"\}'/);
  for (const [verdict, severity] of [['verde', 'OK'], ['corriendo', 'WARNING'], ['rojo', 'CRITICAL'], ['ninguna', 'CRITICAL']]) {
    assert.match(text, new RegExp(`\`${verdict}\`[^\\n]*→ ${severity}`), `el veredicto ${verdict} no dice ${severity}`);
  }
  assert.match(text, /no_soportado[^\n]*sin_credencial[^\n]*→ CRITICAL «no medido: <motivo>»/);

  // las dos copias de Codex son las que saca el generador, byte a byte
  const { generateOne } = require(path.join(ROOT, 'build', 'generate.js'));
  const g = generateOne(ROOT, AGENT);
  assert.strictEqual(fs.readFileSync(tomls[0], 'utf8'), g.toml, 'la .toml de agents/ no es la generada');
  assert.strictEqual(fs.readFileSync(tomls[1], 'utf8'), g.nativeToml, 'la .toml de agents-native/ no es la generada');
});

test('T35 Reviewers_NoPlatformCommands @story-8.85 @ac-20: el despachador lanza el aviso del pedido de trabajo por la configuración, la llave o la capa', () => {
  const content = '---\nstory: "9.8"\nepic: "pedidos"\nstatus: backlog\ntitle: "Demo"\napproach: "t"\n---\n# S\n';
  const repo = (setup) => {
    const root = tmp('repo-');
    fs.mkdirSync(path.join(root, '.git'));
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'story-9-8.md'), content);
    if (setup) { fs.mkdirSync(path.join(root, '.tycon')); setup(root); }
    return root;
  };
  const fires = (root, w, extra = {}) => {
    const file = path.join(root, 'docs', 'story-9-8.md');
    const ev = { hook_event_name: 'PostToolUse', tool_name: 'Write', session_id: 'pa-t35', cwd: root, tool_input: { file_path: file, content } };
    const out = execFileSync(process.execPath, [DISPATCH, 'post-edit'], { input: JSON.stringify(ev), encoding: 'utf8', env: { ...w.env, TYCON_GUIDES_DIR: ROOT, TYCON_PROFILE: path.join(w.tree, 'team-profile.json'), ...extra } });
    return /STORY-CREATE-detect/.test(out);
  };
  const none = world();
  // la configuración de pedidos de trabajo del repo, con el nombre nuevo y con el viejo
  assert.strictEqual(fires(repo((r) => fs.writeFileSync(path.join(r, '.tycon', 'work-items.yaml'), 'org: acme\nproject: Demo\n')), none), true, 'work-items.yaml');
  assert.strictEqual(fires(repo((r) => fs.writeFileSync(path.join(r, '.tycon', ['ado', 'config'].join('-') + '.yaml'), 'ado_org: acme\nado_project: Demo\n')), none), true, 'el nombre viejo');
  // la llave de la integración prendida en la máquina
  assert.strictEqual(fires(repo(), none, { TYCON_ADO_ORG: 'acme' }), true, 'la llave');
  // la capa con un conector elegido para crear pedidos de trabajo
  assert.strictEqual(fires(repo(), world({ integrations: { platform: { workItems: 'github' } } })), true, 'la capa');
  // la capa lee el árbol de la organización que dice la máquina (TYCON_TREE), como la skill que crea el pedido
  const gh = { platform: 'github', org: 'acme', repo: 'x' };
  assert.strictEqual(fires(repo(), world({}, { version: 1, public: gh, profile: gh, operations: gh })), true, 'el árbol de la máquina');
  // sin nada de eso, no
  assert.strictEqual(fires(repo(), none), false, 'sin configuración, llave ni capa');
  assert.doesNotMatch(fs.readFileSync(DISPATCH, 'utf8'), /ado-config/);
});

test('T35 Reviewers_NoPlatformCommands @story-8.85 @ac-20: con la configuración o la capa rotas, el despachador no lanza el aviso y dice por qué', () => {
  const content = '---\nstory: "9.8"\nepic: "pedidos"\nstatus: backlog\ntitle: "Demo"\napproach: "t"\n---\n# S\n';
  const root = tmp('repo-');
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'story-9-8.md'), content);
  // un arnés igual al de esta copia salvo una pieza de la capa: cada carpeta en el camino es propia, el resto se enlaza
  // (las carpetas como junction, que Windows crea sin permisos de administrador; los archivos, copiados)
  const harness = (broken) => {
    const tree = tmp('arnes-');
    const mirror = (from, to, keep) => {
      for (const e of fs.readdirSync(from)) {
        if (e === keep[0]) {
          fs.mkdirSync(path.join(to, e));
          if (keep.length > 1) mirror(path.join(from, e), path.join(to, e), keep.slice(1));
          else for (const f of fs.readdirSync(path.join(from, e))) fs.copyFileSync(path.join(from, e, f), path.join(to, e, f));
        } else if (fs.statSync(path.join(from, e)).isDirectory()) fs.symlinkSync(path.join(from, e), path.join(to, e), 'junction');
        else fs.copyFileSync(path.join(from, e), path.join(to, e));
      }
    };
    mirror(ROOT, tree, ['scripts', 'lib', 'platform']);
    broken(path.join(tree, 'scripts', 'lib', 'platform'));
    return tree;
  };
  const run = (tree) => {
    const w = world();
    const ev = { hook_event_name: 'PostToolUse', tool_name: 'Write', session_id: 'pa-t35r', cwd: root, tool_input: { file_path: path.join(root, 'docs', 'story-9-8.md'), content } };
    const r = spawnSync(process.execPath, [DISPATCH, 'post-edit'], { input: JSON.stringify(ev), encoding: 'utf8', env: { ...w.env, TYCON_GUIDES_DIR: tree, TYCON_PROFILE: path.join(w.tree, 'team-profile.json') } });
    return { fired: /STORY-CREATE-detect/.test(r.stdout), err: r.stderr };
  };
  const rota = run(harness((dir) => fs.writeFileSync(path.join(dir, 'platform.js'), "throw new Error('capa rota');\n")));
  assert.strictEqual(rota.fired, false);
  assert.match(rota.err, /pedido de trabajo[^\n]*capa rota/, 'la capa rota se dice');
  const config = run(harness((dir) => fs.writeFileSync(path.join(dir, 'work-items-config.js'), "throw new Error('config rota');\n")));
  assert.strictEqual(config.fired, false);
  assert.match(config.err, /pedido de trabajo[^\n]*config rota/, 'la configuración rota se dice');
  // un arnés sin esas piezas no es una falla: no hay nada que decir
  const sin = run(harness((dir) => { fs.unlinkSync(path.join(dir, 'platform.js')); fs.unlinkSync(path.join(dir, 'work-items-config.js')); }));
  assert.strictEqual(sin.fired, false);
  assert.doesNotMatch(sin.err, /pedido de trabajo/);
});

// ── T36: los instaladores y work-in-progress.js ─────────────────────────────────────────────────────────────

/** Un `az` y un `gh` espías en el PATH: sólo anotan que los llamaron. */
function spies() {
  const bin = tmp('espias-');
  const log = path.join(bin, 'llamadas.log');
  for (const name of ['az', 'gh']) {
    fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + '\\n');\nprocess.exit(1);\n`, { mode: 0o755 });
  }
  return { bin, calls: () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean); } catch (_) { return []; } } };
}

/** La capa apuntada al az y al gh de mentira, con los pedidos de cada uno. */
function doubles(w, { azPrs = [], ghPulls = [] } = {}) {
  const fix = tmp('fixaz-');
  fs.writeFileSync(path.join(fix, 'prs-0.json'), JSON.stringify({ count: azPrs.length, value: azPrs }));
  const az = path.join(tmp('az-'), 'az');
  fs.copyFileSync(FAKE_AZ, az);
  fs.chmodSync(az, 0o755);
  const gh = tmp('gh-');
  const state = path.join(gh, 'estado.json');
  const ghLog = path.join(gh, 'llamadas.jsonl');
  fs.writeFileSync(state, JSON.stringify({ user: 'arnes-bot', now: '2026-10-31T10:00:00Z', pulls: { 'acme/x': ghPulls } }));
  Object.assign(w.env, { TYCON_ADO_CMD: az, FIXAZ: fix, TYCON_GH_CMD: FAKE_GH, FAKE_GH_STATE: state, FAKE_GH_LOG: ghLog });
  const lines = (f) => { try { return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean); } catch (_) { return []; } };
  return {
    azCalls: () => lines(path.join(fix, 'llamadas.log')).map((l) => { const [step, j] = l.split('\t'); return { step, args: JSON.parse(j).args }; }),
    ghCalls: () => lines(ghLog).map((l) => JSON.parse(l)),
  };
}
const pullGh = (n, o = {}) => ({ number: n, state: 'open', title: `pedido ${n}`, body: '', created_at: '2026-10-30T10:00:00Z', head: { ref: 'story/x' }, base: { ref: 'main' }, user: { login: 'ana' }, ...o });
const prAz = (n, o = {}) => ({ pullRequestId: n, status: 'active', isDraft: false, sourceRefName: 'refs/heads/story/x', targetRefName: 'refs/heads/main', mergeStatus: 'succeeded', repository: { name: 'y' }, creationDate: '2026-10-30T10:00:00Z', title: 't', createdBy: { uniqueName: 'ana' }, ...o });
const QUERIES = [
  { kind: 'github', slug: 'acme/x', branch: 'story/x', name: 'x' },
  { kind: 'azure', org: 'acme', project: 'Proyecto Uno', repo: 'y', branch: 'story/x', name: 'y' },
];

test('T36 Installers_AndWip_UseLayer @story-8.85 @ac-21: los pedidos de la rama salen por la capa; los espías no anotan nada', { skip: onWindows }, async () => {
  const w = world();
  const spy = spies();
  const d = doubles(w, {
    ghPulls: [pullGh(236, { draft: true }), pullGh(9, { head: { ref: 'otra' } }), pullGh(240, { head: { ref: 'story/x', repo: { full_name: 'ana/x' } } })],
    azPrs: [prAz(4920, { mergeStatus: 'conflicts' }), prAz(4921, { sourceRefName: 'refs/heads/otra' }), prAz(4922, { repository: { name: 'otro-repo' } })],
  });
  // GitHub dice que choca recién al leer el pedido entero: la lista no trae `mergeable`
  const st = JSON.parse(fs.readFileSync(w.env.FAKE_GH_STATE, 'utf8'));
  st.pulls['acme/x'][0].mergeable = false;
  fs.writeFileSync(w.env.FAKE_GH_STATE, JSON.stringify(st));
  w.env.PATH = `${spy.bin}${path.delimiter}${w.env.PATH}`;
  const { queryAll } = require(WIP);
  const [gh, az] = await queryAll(QUERIES.map((q) => ({ ...q, root: w.tree })), { env: w.env });
  // el de la rama abierto desde un fork también cuenta: la sesión no sale libre con un pedido suyo abierto
  // sin auto-completar y, en GitHub, sin lugar en la cola de merge: fuera de la cola (el borrador, no)
  assert.deepStrictEqual(gh, { prs: [{ number: 236, draft: true, conflict: true, offQueue: false, queueUnknown: false }, { number: 240, draft: false, conflict: false, offQueue: true, queueUnknown: false }] });
  assert.deepStrictEqual(az, { prs: [{ number: 4920, draft: false, conflict: true, offQueue: true, queueUnknown: false }] });
  assert.deepStrictEqual(spy.calls(), [], 'nadie llamó a az ni a gh directo');
  // el az de mentira anota la rama en la búsqueda; el gh, la lista de abiertos y la lectura de cada pedido de la rama.
  // La lista de GitHub va sin `head=<dueño>:<rama>`: con un origin que todavía nombra al dueño viejo, GitHub contesta
  // ese filtro con una lista vacía y sin error, y la sesión saldría libre
  const azArgs = d.azCalls().filter((c) => c.step === 'prs').map((c) => c.args.join(' '));
  assert.ok(azArgs.length && azArgs.every((a) => a.includes('searchCriteria.sourceRefName=refs/heads/story/x')), azArgs.join(' | '));
  const ghRoutes = d.ghCalls().map((c) => c.ruta);
  assert.ok(ghRoutes.some((r) => /^repos\/acme\/x\/pulls\?/.test(r)), ghRoutes.join(' | '));
  assert.ok(ghRoutes.every((r) => !/head=/.test(r)), ghRoutes.join(' | '));
  assert.ok(ghRoutes.includes('repos/acme/x/pulls/236'), ghRoutes.join(' | '));
  assert.ok(!ghRoutes.includes('repos/acme/x/pulls/9'), 'el pedido de otra rama no se lee');
  assert.strictEqual(ghRoutes.filter((r) => r === 'graphql').length, 1, 'la cola de merge, de una sola consulta');
});

test('T36 Installers_AndWip_UseLayer @story-8.85 @ac-21: con la capa que no contesta, el pie dice «no se pudo consultar» y la sesión no queda libre', { skip: onWindows }, async () => {
  const w = world();
  const spy = spies();
  w.env.PATH = `${spy.bin}${path.delimiter}${w.env.PATH}`;
  // la capa sin dobles ni credenciales: su «no» llega con el motivo, nunca como «sin pedidos»
  w.env.TYCON_GH_CMD = path.join(tmp('nada-'), 'gh-que-no-existe');
  w.env.TYCON_ADO_CMD = path.join(tmp('nada-'), 'az-que-no-existe');
  const { queryAll } = require(WIP);
  const answers = await queryAll(QUERIES.map((q) => ({ ...q, root: w.tree })), { env: w.env });
  for (const a of answers) assert.match(a.error || '', /^la capa de plataforma: (no_medido|red|sin_credencial|sin_plataforma)/, JSON.stringify(a));
  // un proceso de la capa que se cuelga: lo corta el tope
  const hang = path.join(tmp('colgado-'), 'gh.js');
  fs.writeFileSync(hang, 'setTimeout(() => {}, 10000);\n');
  const [slow] = await queryAll([{ ...QUERIES[0], root: w.tree }], { perMs: 300, totalMs: 600, env: { ...w.env, TYCON_GH_CMD: hang } });
  assert.match(slow.error, /tope/);
  assert.deepStrictEqual(spy.calls(), []);

  // de punta a punta: la sesión que entra a los repos queda ocupada y el pie dice por qué
  const state = path.join(w.home, 'state');
  const sessions = path.join(w.home, 'sessions');
  for (const s of ['active', 'adhoc', 'timing-history']) fs.mkdirSync(path.join(state, s), { recursive: true });
  fs.mkdirSync(sessions);
  const repo = path.join(w.home, 'x');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'symbolic-ref', 'HEAD', 'refs/heads/story/x']);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/x.git']);
  const storyFile = path.join(w.home, 'story-5.1.md');
  fs.writeFileSync(storyFile, '---\nstory: "5.1"\ntitle: "Lo que entra"\n---\n# S\n');
  const NOW = '2026-10-31T10:00:00.000Z';
  fs.writeFileSync(path.join(state, 'active', 'ent00000-1.json'), JSON.stringify({ sessionId: 'ent00000-1', storyId: '5.1', storyPath: storyFile, repoPath: repo, stepsCompleted: [0, 1, 2, 3, 4, 5, 6, 8], stepsPending: [], lastTouch: NOW }));
  fs.writeFileSync(path.join(sessions, 'ent00000-1.json'), JSON.stringify({ pid: process.pid, sessionId: 'ent00000-1', name: 'ocupada', status: 'idle', statusUpdatedAt: Date.parse(NOW) - 20 * 60000 }));
  const out = JSON.parse(execFileSync(process.execPath, [WIP, '--state-dir', state, '--sessions-dir', sessions, '--now', NOW, '--json'], { input: '', encoding: 'utf8', env: w.env }));
  assert.strictEqual(out.rows[0].state, 'Entrando a los repos (no se pudo consultar los pedidos)');
  assert.ok(out.unreadable.some((u) => /pedidos de x \(story\/x\): la capa de plataforma: /.test(u)), out.unreadable.join(' | '));
  assert.deepStrictEqual(out.free, []);
  assert.deepStrictEqual(spy.calls(), []);
});

test('T36 Installers_AndWip_UseLayer @story-8.85 @ac-21: sin sourceBranch, los dos conectores llaman como siempre', { skip: onWindows }, async () => {
  const P = require(path.join(ROOT, 'scripts', 'lib', 'platform', 'platform.js'));
  const w = world();
  const d = doubles(w, { ghPulls: [pullGh(236), pullGh(9, { head: { ref: 'otra' } })], azPrs: [prAz(4920), prAz(4921, { sourceRefName: 'refs/heads/otra' })] });
  const gh = await P.run('change-request.list', { checks: false }, { env: w.env, repo: { platform: 'github', org: 'acme', repo: 'x' } });
  const az = await P.run('change-request.list', {}, { env: w.env, repo: { platform: 'azure', org: 'acme', project: 'Proyecto Uno', repo: 'y' } });
  assert.deepStrictEqual(gh.value.map((p) => p.number).sort((a, b) => a - b), [9, 236]);
  assert.deepStrictEqual(az.value.map((p) => p.number), [4920, 4921]);
  assert.ok(d.ghCalls().every((c) => !/head=/.test(c.ruta) && !/pulls\/\d+$/.test(c.ruta)), d.ghCalls().map((c) => c.ruta).join(' | '));
  assert.ok(d.azCalls().filter((c) => c.step === 'prs').every((c) => !c.args.some((a) => /sourceRefName/.test(a))));
});

test('T36 Installers_AndWip_UseLayer @story-8.85 @ac-21: ningún renglón de los instaladores invoca az ni gh', () => {
  for (const f of ['install-tycon-hooks.sh', 'install-tycon-hooks.ps1']) {
    const lines = fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8').split('\n');
    const calls = lines.map((l, i) => [i + 1, l]).filter(([, l]) => {
      const code = l.replace(/^\s*#.*$/, '').replace(/(command -v|Get-Command)\s+(az|gh)\b/g, '');
      return /(^|[\s;|&(`$])(az|gh)(\.cmd|\.exe)?\s+[a-z-]/.test(code);
    });
    assert.deepStrictEqual(calls, [], `${f} invoca az o gh:\n${calls.map(([n, l]) => `${n}: ${l.trim()}`).join('\n')}`);
  }
});
