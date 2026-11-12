'use strict';
/*
 * platform-github-only.test.js — una organización sólo con GitHub hace el ciclo de una historia sin Azure DevOps, y una
 * con Azure DevOps no nota el cambio.
 *
 * El ciclo pasa por la línea de comandos de la capa (scripts/lib/platform/platform.js), como lo llaman los pasos del
 * agente: crear el pedido de trabajo, marcarlo activo, abrir el pedido de cambio con auto-completar, leer la CI, cerrar
 * el pedido, listar lo asignado y leer los abiertos (votar no: la capa no lo ofrece todavía). Primero con el conector
 * de mentira (scripts/tests/lib/fake-platform/), que demuestra que el núcleo no pide nada de Azure; después con el
 * conector real de GitHub contra el gh de mentira. Un `az` espía en el PATH anota si alguien lo llamó. Sin red.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CAPA = path.join(ROOT, 'scripts', 'lib', 'platform', 'platform.js');
const FAKE = path.join(ROOT, 'scripts', 'tests', 'lib', 'fake-platform');
const FAKE_GH = path.join(ROOT, 'scripts', 'tests', 'lib', 'fake-gh.js');
const SHA = 'a'.repeat(40);

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

/**
 * Una organización con el perfil que elige `conector`, sin `ado.org` ni `az` de verdad: el `az` del PATH es un espía que
 * anota cada llamada y falla. Con GitHub, el repo del producto se declara en team-repos.json; con el conector de
 * mentira, el repo no declara plataforma y cae en la del perfil.
 */
function organizacion(conector) {
  const tree = tmp('arbol-');
  const home = tmp('casa-');
  const ints = tmp('plataformas-');
  for (const n of ['azure-devops', 'github']) fs.cpSync(path.join(ROOT, 'integrations', n), path.join(ints, n), { recursive: true });
  fs.cpSync(FAKE, path.join(ints, 'fake-platform'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'team-profile.json'), JSON.stringify({ integrations: { platform: { default: conector } } }));
  const team = { version: 1, public: { platform: 'github', org: 'acme', repo: 'arnes' }, profile: { platform: 'github', org: 'acme', repo: 'perfil' }, operations: { platform: 'github', org: 'acme', repo: 'operaciones' } };
  if (conector === 'github') team.merge_suites = { repos: [{ repo: { platform: 'github', org: 'acme', repo: 'portal' }, rule: 'automatico' }] };
  fs.writeFileSync(path.join(tree, 'team-repos.json'), JSON.stringify(team));
  const bin = tmp('bin-');
  const azLog = path.join(bin, 'az.log');
  fs.writeFileSync(path.join(bin, 'az'), `#!/bin/sh\necho "$*" >> "${azLog}"\nexit 1\n`, { mode: 0o755 });
  const ghDir = tmp('gh-');
  const ghState = path.join(ghDir, 'estado.json');
  const ghLog = path.join(ghDir, 'llamadas.log');
  fs.writeFileSync(ghState, JSON.stringify({ user: 'arnes-bot', now: '2026-11-12T10:00:00Z', issues: { 'acme/portal': [] }, pulls: { 'acme/portal': [] },
    allow_auto_merge: { 'acme/portal': true }, autoMerge: 'funciona', shas: { 'story/g': SHA }, checks: { [SHA]: [{ name: 'ci', status: 'completed', conclusion: 'success' }] } }));
  const fpLog = path.join(tmp('fp-'), 'llamadas.log');
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_HOME: path.join(home, '.tycon'), TYCON_INTEGRATIONS_DIR: ints, TYCON_TREE: tree,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, TYCON_GH_CMD: FAKE_GH, FAKE_GH_STATE: ghState, FAKE_GH_LOG: ghLog, GH_TOKEN: 'x',
    FAKE_PLATFORM_LOG: fpLog, TYCON_FAKE_PLATFORM_TOKEN: ['tok', 'falso'].join('-') };
  for (const k of Object.keys(env)) if (/^TYCON_(ADO_ORG|ADO_CMD|PLATFORM|PROFILE)$|^AZURE_DEVOPS_EXT_PAT$|^FAKE_PLATFORM_(ANSWERS|THROW)$/.test(k)) delete env[k];
  return { env, azLog, ghLog, fpLog };
}

/** Los siete pasos del ciclo, en orden, por la línea de comandos de la capa. */
function ciclo(org, conector) {
  const repo = JSON.stringify(conector === 'github' ? { platform: 'github', org: 'acme', repo: 'portal' } : { org: 'acme', repo: 'portal' });
  const pasos = [
    ['work-item.create', null, { title: 'Historia de prueba', description: 'lo que pide', type: 'User Story', tags: ['8.0'], repo: 'acme/portal' }],
    ['work-item.update', null, { id: 1, repo: 'acme/portal' }],
    ['change-request.open', repo, { sourceBranch: 'story/g', targetBranch: 'main', text: 'Historia de prueba\n\nlo que pide', deleteSourceBranch: false, pollSeconds: 0, waitMinutes: 0 }],
    ['ci.read', repo, { commit: SHA }],
    ['work-item.close', null, { id: 1, seconds: 1080, comment: 'listo', repo: 'acme/portal' }],
    ['assigned.list', repo, {}],
    ['change-request.list', repo, {}],
  ];
  return pasos.map(([op, r, args]) => {
    const argv = [CAPA, op, ...(r ? ['--repo', r] : []), ...(op === 'change-request.open' ? ['--auto-complete'] : []), '--args', JSON.stringify(args)];
    const x = spawnSync(process.execPath, argv, { env: org.env, encoding: 'utf8', timeout: 60000 });
    let res = null;
    try { res = JSON.parse(x.stdout); } catch (_) { /* queda null: la aserción lo dice */ }
    return { op, status: x.status, res, out: `${x.stdout || ''}${x.stderr || ''}` };
  });
}
const leer = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
const ORDEN = ['work-item.create', 'work-item.update', 'change-request.open', 'ci.read', 'work-item.close', 'assigned.list', 'change-request.list'];

test('E2E_GithubOnly_FullCycle_FakeConnector @story-8.85 @ac-26', () => {
  const org = organizacion('fake-platform');
  const r = ciclo(org, 'fake-platform');
  for (const p of r) {
    assert.strictEqual(p.status, 0, `${p.op}: ${p.out}`);
    assert.strictEqual(p.res && p.res.ok, true, `${p.op}: ${p.out}`);
  }
  assert.deepStrictEqual(leer(org.fpLog).map((l) => JSON.parse(l).operacion), ORDEN, 'las siete operaciones, en orden, al conector de mentira');
  assert.deepStrictEqual(leer(org.azLog), [], 'ninguna llamada a az');
});

test('E2E_GithubOnly_RealGithubConnector_FakeGh @story-8.85 @ac-26', () => {
  const org = organizacion('github');
  const r = ciclo(org, 'github');
  for (const p of r) {
    assert.strictEqual(p.status, 0, `${p.op}: ${p.out}`);
    assert.strictEqual(p.res && p.res.ok, true, `${p.op}: ${p.out}`);
  }
  const de = (op) => r.find((p) => p.op === op).res.value;
  assert.strictEqual(de('work-item.create').id, 1);
  assert.strictEqual(de('work-item.update').estado, 'activo');
  assert.strictEqual(de('change-request.open').modo, 'auto', 'el repo permite auto-merge: lo prende');
  assert.strictEqual(de('ci.read').state, 'succeeded');
  assert.strictEqual(de('work-item.close').hoursAs, 'comment', 'GitHub no tiene un campo de horas');
  assert.ok(Array.isArray(de('assigned.list')));
  assert.deepStrictEqual(de('change-request.list').map((p) => [p.number, p.sourceBranch, p.autoComplete]), [[de('change-request.open').id, 'story/g', true]]);
  // las llamadas a gh: las de cada operación, todas por gh api
  const llamadas = leer(org.ghLog).map((l) => { const j = JSON.parse(l); return `${j.method || 'GET'} ${String(j.ruta || '').split('?')[0]}`; });
  for (const esperada of ['POST repos/acme/portal/issues', 'PATCH repos/acme/portal/issues/1', 'POST repos/acme/portal/pulls', 'POST graphql',
    `GET repos/acme/portal/commits/${SHA}/check-runs`, 'POST repos/acme/portal/issues/1/comments', 'GET repos/acme/portal/issues', 'GET repos/acme/portal/pulls']) {
    assert.ok(llamadas.includes(esperada), `falta ${esperada} en ${llamadas.join(' · ')}`);
  }
  assert.deepStrictEqual(leer(org.azLog), [], 'ninguna llamada a az');
});

test('E2E_GithubOnly_NoAzNoAdoMessages @story-8.85 @ac-26', () => {
  const textos = [];
  for (const c of ['fake-platform', 'github']) {
    const org = organizacion(c);
    textos.push(...ciclo(org, c).map((p) => p.out));
    for (const f of ['--json', '--shell', '']) {
      const x = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lib', 'tycon-config.js'), 'integrations', ...(f ? [f] : [])], { env: org.env, encoding: 'utf8' });
      textos.push(`${x.stdout || ''}${x.stderr || ''}`);
    }
  }
  for (const t of textos) {
    assert.doesNotMatch(t, /Azure DevOps (est[áa] )?apagad|ADO apagad/i, t);
    assert.doesNotMatch(t, /(^|[\s"'`(])az\s+[a-z]/, t);
  }
});

const huella = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('Migration_AzureOrg_SameConfigSameGolden @story-8.85 @ac-27', () => {
  // la configuración de hoy de una organización con Azure DevOps: ado.org en la máquina, el archivo de pedidos con su
  // nombre viejo, una historia con el campo viejo y la plataforma del repo de operaciones (el valor por defecto viejo)
  const home = tmp('casa-');
  const TH = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js'));
  const cfg = TH.configFile(home);
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({ ado: { org: 'https://dev.azure.com/acme' } }));
  const repo = tmp('producto-');
  fs.mkdirSync(path.join(repo, '.tycon'));
  fs.writeFileSync(path.join(repo, '.tycon', 'ado-config.yaml'), 'project: Producto\narea_path: Producto\\Backend\n');
  fs.mkdirSync(path.join(repo, 'specs'));
  const historia = path.join(repo, 'specs', 'story-1.1-algo.md');
  fs.writeFileSync(historia, '---\nepic: 1\nstory: "1.1"\ntitle: "Algo"\nstatus: in-progress\nado_work_item: 4321\n---\n\n# Story 1.1\n');
  const tree = tmp('arbol-');
  fs.writeFileSync(path.join(tree, 'team-profile.json'), '{}');
  fs.writeFileSync(path.join(tree, 'team-repos.json'), JSON.stringify({ version: 1, public: { platform: 'github', org: 'acme', repo: 'arnes' }, profile: { platform: 'github', org: 'acme', repo: 'perfil' }, operations: { platform: 'azure', org: 'acme', project: 'Operaciones', repo: 'operaciones' } }));
  const archivos = [cfg, path.join(repo, '.tycon', 'ado-config.yaml'), historia, path.join(tree, 'team-profile.json'), path.join(tree, 'team-repos.json')];
  const antes = archivos.map(huella);
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_HOME: path.join(home, '.tycon'), TYCON_TREE: tree, TYCON_PROFILE: '0' };
  for (const k of Object.keys(env)) if (/^TYCON_(ADO_ORG|PLATFORM|INTEGRATIONS_DIR)$/.test(k)) delete env[k];
  const corre = (args) => spawnSync(process.execPath, args, { env, cwd: repo, encoding: 'utf8', timeout: 60000 });
  const elige = corre([CAPA, 'choose', 'work-item.create']);
  assert.match(elige.stdout, /azure-devops/, `sin elegir nada, la organización de hoy sigue en Azure DevOps: ${elige.stdout}${elige.stderr}`);
  const integ = JSON.parse(corre([path.join(ROOT, 'scripts', 'lib', 'tycon-config.js'), 'integrations', '--json']).stdout);
  assert.strictEqual(integ.ado, true, 'la llave de Azure DevOps sigue prendida por ado.org');
  const campo = corre([path.join(ROOT, 'scripts', 'lib', 'platform', 'work-item-field.js'), 'get', historia]);
  assert.match(campo.stdout, /4321/, `el campo viejo se sigue leyendo: ${campo.stdout}${campo.stderr}`);
  assert.deepStrictEqual(archivos.map(huella), antes, 'ningún archivo de configuración cambia');
  // la foto de llamadas a az de cada flujo, contra la de la Task 0; sin la marca del corredor de pruebas, que haría que
  // las suites anidadas le reporten a este proceso en vez de correr solas (y sin llamadas la foto sale vacía)
  const sinCorredor = { ...process.env };
  delete sinCorredor.NODE_TEST_CONTEXT;
  const golden = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'tests', 'lib', 'record-platform-golden.js'), 'compare'], { cwd: ROOT, env: sinCorredor, encoding: 'utf8', timeout: 900000 });
  assert.strictEqual(golden.status, 0, `la foto de llamadas a az cambió: ${golden.stdout}${golden.stderr}`);
});

test('Migration_InstalledHooksAndSettings_OldPathsReplaced @story-8.85 @ac-27', () => {
  const home = tmp('casa-');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const settings = path.join(home, '.claude', 'settings.json');
  fs.writeFileSync(settings, '{}\n');
  const instalar = () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'setup', 'apply-hooks.js'), '--settings', settings, '--hooks-dir', path.join(ROOT, 'scripts', 'hooks'),
      '--skills', path.join(ROOT, 'skills'), '--list', path.join(ROOT, 'scripts', 'setup', 'hooks-list.json'), '--effects', path.join(ROOT, 'scripts', 'setup', 'install-effects.json'), '--platform', 'posix'],
    { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TYCON_PROFILE: '0', TYCON_NO_NIGHTLY_EXAM: '1' } });
    assert.strictEqual(r.status, 0, r.stderr);
    return fs.readFileSync(settings, 'utf8');
  };
  // la instalación de hoy y la actualización encima: el mismo settings.json
  const hoy = instalar();
  assert.strictEqual(instalar(), hoy, 'actualizar no cambia lo instalado');
  // un mismo gancho en dos eventos no es un duplicado: dos veces es el mismo comando en el mismo evento y el mismo matcher
  const cmds = Object.entries(JSON.parse(hoy).hooks || {}).flatMap(([evento, es]) => es.flatMap((e) => (e.hooks || []).map((h) => `${evento}\t${e.matcher || ''}\t${h.command}`)));
  assert.ok(cmds.length > 0, 'la instalación registra ganchos');
  assert.deepStrictEqual(cmds.filter((c, i) => cmds.indexOf(c) !== i), [], 'ningún gancho queda dos veces');
  for (const c of cmds) assert.doesNotMatch(c, /scripts[\\/]ci[\\/](validate-pipeline-in-ado\.sh|grant-new-product-permissions\.js)/, `${c}: ruta mudada`);
});
