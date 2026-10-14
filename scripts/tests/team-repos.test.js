'use strict';

/**
 * team-repos.test.js — los dos lectores de la configuración de una organización (story 8.26, tanda J):
 * scripts/lib/team-repos.js (`team-repos.json`, en el perfil del equipo: dónde vive cada repo del arnés) y
 * scripts/lib/operations-config.js (`operations.json`, en el repo de operaciones: responsables y revisores).
 *
 * Lo que no se puede perder: un archivo válido da sus datos; uno con problemas no da datos a medias y cada problema
 * trae la ruta de su clave (la página de configuración marca cada campo con ella); «no pude leer» no es «no hay repo»;
 * y la lista de responsables no entra en el archivo que llega a todas las máquinas. Sin red ni repos: sólo textos.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TEAM = require(path.join(ROOT, 'scripts', 'lib', 'team-repos.js'));
const OPS = require(path.join(ROOT, 'scripts', 'lib', 'operations-config.js'));

const azure = (repo, project = 'Main Project') => ({ platform: 'azure', org: 'acme', project, repo });
const github = (repo) => ({ platform: 'github', org: 'acme', repo });
const goodTeam = () => ({
  __doc: 'un comentario',
  version: 1,
  public: github('harness'),
  profile: azure('team-profile'),
  operations: azure('team-operations'),
  maintainers: azure('maintainers'),
  harness_copies: [azure('old-harness'), azure('maintainers')],
});
const paths = (r) => r.problems.map((p) => p.path).sort();

test('TeamRepos_Valid_GivesItsData', () => {
  const r = TEAM.parse(JSON.stringify(goodTeam()));
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.operations.repo, 'team-operations');
  // y una organización sólo en GitHub, sin mantenimiento ni copias
  const gh = { version: 1, public: github('harness'), profile: github('team-profile'), operations: github('team-operations') };
  assert.strictEqual(TEAM.parse(JSON.stringify(gh)).ok, true);
});

test('TeamRepos_Problems_CarryTheKeyPath_AndNoPartialData', () => {
  const doc = goodTeam();
  delete doc.profile;
  doc.version = 2;
  doc.public.project = 'nope';
  doc.operations = { platform: 'gitlab', org: 'acme', repo: 'x' };
  doc.harness_copies[1].repo = '';
  doc.maintainers.org = 'a/b';
  doc.extra = true;
  const r = TEAM.parse(JSON.stringify(doc));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.data, null, 'con un problema no hay datos a medias');
  assert.deepStrictEqual(paths(r), ['extra', 'harness_copies.1.repo', 'maintainers.org', 'operations.platform', 'profile', 'public.project', 'version']);
});

test('TeamRepos_AzureNamesWithAccents_AreValid_GitHubOnesAreNot', () => {
  const doc = goodTeam();
  doc.operations = azure('operaciones', 'Arnés del equipo');
  assert.strictEqual(TEAM.parse(JSON.stringify(doc)).ok, true, 'Azure acepta tildes y eñes');
  assert.strictEqual(TEAM.url(doc.operations), 'https://dev.azure.com/acme/Arn%C3%A9s%20del%20equipo/_git/operaciones');
  doc.public = github('arnés');
  assert.deepStrictEqual(paths(TEAM.parse(JSON.stringify(doc))), ['public.repo'], 'GitHub, sólo ASCII');
});

test('TeamRepos_Owners_AreRejectedHere — la lista de responsables no llega a todas las máquinas', () => {
  const r = TEAM.parse(JSON.stringify({ ...goodTeam(), owners: ['someone'] }));
  assert.deepStrictEqual(paths(r), ['owners']);
  assert.match(r.problems[0].message, /operations\.json/);
});

test('TeamRepos_BrokenText_IsAProblemOfTheWholeFile', () => {
  for (const text of ['{', '[]', 'null', '"x"']) {
    const r = TEAM.parse(text);
    assert.strictEqual(r.ok, false, text);
    assert.deepStrictEqual(paths(r), [''], text);
  }
});

test('TeamRepos_Load_CouldNotReadIsNotNoRepo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-repos-'));
  try {
    const missing = TEAM.load(path.join(dir, 'team-repos.json'));
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(missing.couldNotRead, true);
    const file = path.join(dir, 'team-repos.json');
    fs.writeFileSync(file, JSON.stringify(goodTeam()));
    const read = TEAM.load(file);
    assert.strictEqual(read.ok, true);
    assert.strictEqual(read.couldNotRead, false);
    // a mano: 0 válido, 1 con problemas, 2 no pude leer
    const cli = (f) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lib', 'team-repos.js'), f], { encoding: 'utf8' }).status;
    assert.strictEqual(cli(file), 0);
    fs.writeFileSync(file, '{"version":1}');
    assert.strictEqual(cli(file), 1);
    assert.strictEqual(cli(path.join(dir, 'no-such.json')), 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TeamRepos_Url_AndPrivateRepoRef', () => {
  const d = goodTeam();
  assert.strictEqual(TEAM.url(d.profile), 'https://dev.azure.com/acme/Main%20Project/_git/team-profile');
  assert.strictEqual(TEAM.url(d.public), 'https://github.com/acme/harness');
  assert.strictEqual(TEAM.privateRepoRef(d), 'Main Project/_git/maintainers');
  delete d.maintainers;
  assert.strictEqual(TEAM.privateRepoRef(d), null);
});

test('TeamRepos_HarnessCopies_MeasuresOnlyMaintainers (DEF-8.30-copias-del-arnes-en-team-repos)', () => {
  // EL CASO: las métricas de la noche sabían qué repos son copias del arnés por una variable de la definición
  // (HARNESS_COPIES, y HARNESS_MEASURED_COPY la que cuenta). Ahora lo dice este archivo: de las copias se mide sólo la
  // de mantenimiento, comparada sin mayúsculas y con su organización; las demás se saltean.
  const d = goodTeam();
  d.harness_copies = [azure('Old-Harness'), { ...azure('MAINTAINERS'), org: 'ACME' }, azure('maintainers', 'Other Project'), github('mirror')];
  assert.deepStrictEqual(TEAM.harnessCopies(d, 'azure'), [
    { id: 'Main Project/Old-Harness', measured: false },
    { id: 'Main Project/MAINTAINERS', measured: true },
    { id: 'Other Project/maintainers', measured: false },
  ]);
  assert.deepStrictEqual(TEAM.harnessCopies(d, 'github'), [{ id: 'acme/mirror', measured: false }], 'GitHub: <org>/<repo>, sólo las de esa plataforma');
  // sin mantenimiento declarado, ninguna se mide; sin copias, la lista está vacía
  delete d.maintainers;
  assert.ok(TEAM.harnessCopies(d, 'azure').every((c) => !c.measured));
  delete d.harness_copies;
  assert.deepStrictEqual(TEAM.harnessCopies(d, 'azure'), []);
  assert.deepStrictEqual(TEAM.harnessCopies(null, 'azure'), []);
  // a mano (lo que corren los pipelines): la lista por la salida; con problemas, nada en la salida y el motivo aparte
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-repos-copies-'));
  try {
    const file = path.join(dir, 'team-repos.json');
    fs.writeFileSync(file, JSON.stringify(goodTeam()));
    const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lib', 'team-repos.js'), ...a], { encoding: 'utf8' });
    let r = cli(file, '--harness-copies', 'azure');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, 'skip\tMain Project/old-harness\nmeasure\tMain Project/maintainers\n');
    r = cli('--harness-copies', 'github', file);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, '', 'ninguna copia en GitHub');
    fs.writeFileSync(file, JSON.stringify({ ...goodTeam(), harness_copies: [azure('')] }));
    r = cli(file, '--harness-copies', 'azure');
    assert.strictEqual(r.status, 1);
    assert.strictEqual(r.stdout, '', 'con un problema no hay lista a medias');
    assert.match(r.stderr, /harness_copies\.0\.repo/);
    assert.strictEqual(cli(path.join(dir, 'no-such.json'), '--harness-copies', 'azure').status, 2, '«no pude leer» no es «no hay copias»');
    assert.strictEqual(cli(file, '--harness-copies', 'gitlab').status, 2, 'una plataforma desconocida es un error de uso');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OperationsConfig_Valid_AndOwnerFor', () => {
  const doc = { version: 1, owners: { default: 'lead@acme.example', by_project: { 'Project A': 'a@acme.example' } }, reviewers: { dependencies: ['r@acme.example'], watcher: [] } };
  const r = OPS.parse(JSON.stringify(doc));
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(OPS.ownerFor(r.data, 'Project A'), 'a@acme.example');
  assert.strictEqual(OPS.ownerFor(r.data, 'Project B'), 'lead@acme.example', 'sin uno propio, el de respaldo');
  assert.strictEqual(OPS.parse(JSON.stringify({ version: 1, owners: { default: 'octocat' } })).ok, true, 'un usuario de GitHub también es una identidad');
});

test('OperationsConfig_Problems_CarryTheKeyPath', () => {
  const r = OPS.parse(JSON.stringify({ version: 1, owners: { by_project: { P: 'with space' } }, reviewers: { watcher: 'x', other: [] }, extra: 1 }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.data, null);
  assert.deepStrictEqual(paths(r), ['extra', 'owners.by_project.P', 'owners.default', 'reviewers.other', 'reviewers.watcher']);
  assert.deepStrictEqual(paths(OPS.parse('{')), ['']);
  assert.strictEqual(OPS.load(path.join(os.tmpdir(), 'no-such-operations.json')).couldNotRead, true);
});
