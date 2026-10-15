'use strict';

/**
 * team-repos.test.js — los dos lectores de la configuración de una organización (story 8.26, tanda J):
 * scripts/lib/team-repos.js (`team-repos.json`, en el perfil del equipo: dónde vive cada repo del arnés) y
 * scripts/lib/operations-config.js (`operations.json`, en el repo de operaciones: responsables, revisores y, desde la
 * story 2.28, quién es quién — `people`, con la huella del correo informado y nunca el correo en claro).
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

// ── story 2.28: quién es quién. `people` ata cada máquina a una persona (la confirma un mantenedor) y corrige dónde
// trabaja cada una. Guarda la huella del correo que informa la máquina, nunca el correo en claro.
const HUELLA = (correo) => require('crypto').createHash('sha256').update(String(correo).trim().toLowerCase()).digest('hex');
const opsWith = (people) => ({ version: 1, owners: { default: 'lead@acme.example' }, ...(people === undefined ? {} : { people }) });
// la ruta de un problema bajo people.projects lleva el correo adentro; se arma pegando el correo de ejemplo, así el texto
// de la prueba no trae «<correo>.remove», que el freno del remoto público lee como un dominio real
const enProyectos = (correo, resto) => ['people', 'projects', correo, resto].join('.');
const goodPeople = () => ({
  __doc: 'un comentario',
  machines: {
    'maq-uno-1a2b3c4d': { person: 'dev.uno@acme.example', reported_sha256: HUELLA('Dev.Uno@Acme.example'), confirmed_by: 'lead@acme.example', confirmed_on: '2026-10-15' },
    'maq-dos.local_2': { person: 'dev.dos@acme.example', reported_sha256: null, confirmed_by: 'lead@acme.example', confirmed_on: '2026-02-28' },
  },
  projects: {
    'dev.uno@acme.example': { add: ['Gama'], remove: ['Beta'] },
    'dev.dos@acme.example': { add: [] },
  },
});

test('T5 OperationsConfig_People_FormaAceptada (2.28, AC 5 y 21)', () => {
  const full = OPS.parse(JSON.stringify(opsWith(goodPeople())));
  assert.deepStrictEqual(full.problems, [], 'people completo: con huella de 64 hexadecimales y con huella null');
  assert.strictEqual(full.ok, true);
  assert.strictEqual(full.data.people.machines['maq-dos.local_2'].reported_sha256, null);
  for (const people of [{}, { machines: {} }, { projects: {} }]) {
    assert.deepStrictEqual(OPS.parse(JSON.stringify(opsWith(people))).problems, [], `people ${JSON.stringify(people)}: las dos partes son opcionales`);
  }
  assert.strictEqual(OPS.parse(JSON.stringify(opsWith(undefined))).ok, true, 'un operations.json sin people sigue validando');
  assert.ok(OPS.KEYS.includes('people'), 'people es una clave conocida de la raíz');
});

test('T6 OperationsConfig_People_ProblemasConRuta (2.28, AC 6)', () => {
  const p = goodPeople();
  const m = p.machines['maq-uno-1a2b3c4d'];
  p.machines['maq-a'] = { ...m, person: 'sin-arroba' };                         // un correo sin forma de correo
  p.machines['Maq A'] = { ...m };                                                // una máquina con mayúsculas y espacios
  p.machines['maq-b'] = { ...m, confirmed_on: '15/10/2026' };                    // una fecha que no es AAAA-MM-DD
  p.machines['maq-c'] = { ...m, foo: 1 };                                        // una clave desconocida
  p.projects['dev.uno@acme.example'] = { add: ['Gama', 'Beta'], remove: ['Beta'] }; // el mismo producto en add y remove
  p.machines['maq-d'] = { ...m, reported_sha256: 'dev.uno@acme.example' };      // el correo en claro en vez de la huella
  const r = OPS.parse(JSON.stringify(opsWith(p)));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.data, null, 'con un problema no hay datos a medias');
  assert.deepStrictEqual(paths(r), [
    'people.machines.Maq A',
    'people.machines.maq-a.person',
    'people.machines.maq-b.confirmed_on',
    'people.machines.maq-c.foo',
    'people.machines.maq-d.reported_sha256',
    enProyectos('dev.uno@acme.example', 'remove.0'),
  ].sort(), 'seis problemas, cada uno con su ruta');
  const sha = r.problems.find((x) => x.path === 'people.machines.maq-d.reported_sha256');
  assert.ok(!sha.message.includes('dev.uno@acme.example'), 'el mensaje no repite el correo en claro');

  // y los demás bordes: una fecha con forma pero que no existe, una huella en mayúsculas, lo que falta, lo que no es objeto
  const q = goodPeople();
  q.extra = true;
  q.machines['maq-e'] = { ...m, confirmed_on: '2026-02-30', reported_sha256: m.reported_sha256.toUpperCase() };
  q.machines['maq-f'] = { person: 'dev.uno@acme.example' };
  q.machines['maq-g'] = 'dev.uno@acme.example';
  q.projects['no-es-correo'] = { add: ['Gama'] };
  q.projects['dev.dos@acme.example'] = { add: 'Gama', remove: [''], otra: [] };
  assert.deepStrictEqual(paths(OPS.parse(JSON.stringify(opsWith(q)))), [
    'people.extra',
    'people.machines.maq-e.confirmed_on',
    'people.machines.maq-e.reported_sha256',
    'people.machines.maq-f.confirmed_by',
    'people.machines.maq-f.confirmed_on',
    'people.machines.maq-f.reported_sha256',
    'people.machines.maq-g',
    enProyectos('dev.dos@acme.example', 'add'),
    enProyectos('dev.dos@acme.example', 'otra'),
    enProyectos('dev.dos@acme.example', 'remove.0'),
    'people.projects.no-es-correo',
  ].sort());
  // dos claves de projects que son el mismo correo con otras mayúsculas o espacios: una se perdería en silencio
  // 🔴 rojo previo (pase adversarial, clase 8): validaba, y `dondeTrabaja` aplicaba una sola de las dos correcciones.
  const r2 = goodPeople();
  r2.projects['Dev.Uno@Acme.Example'] = { remove: ['Beta'] };
  assert.deepStrictEqual(paths(OPS.parse(JSON.stringify(opsWith(r2)))), ['people.projects.Dev.Uno@Acme.Example']);
  assert.deepStrictEqual(paths(OPS.parse(JSON.stringify(opsWith([])))), ['people']);
  assert.deepStrictEqual(paths(OPS.parse(JSON.stringify(opsWith({ machines: [], projects: 'x' })))), ['people.machines', 'people.projects']);
});

test('T21 EjemplosPublicos_TraenPeopleInventado_YValidan (2.28, AC 20)', () => {
  const dir = path.join(ROOT, 'pipelines', 'operations');
  for (const rel of ['examples/operations.json', 'examples/github/operations.json']) {
    const r = OPS.load(path.join(dir, rel));
    assert.deepStrictEqual(r.problems, [], `${rel} valida`);
    const people = r.data.people;
    assert.ok(people && Object.keys(people.machines || {}).length, `${rel} trae people.machines`);
    assert.ok(people.projects && Object.keys(people.projects).length, `${rel} trae people.projects`);
    const text = JSON.stringify(people);
    const correos = text.match(/[^\s"@]+@[^\s"@]+/g) || [];
    assert.ok(correos.length, `${rel}: hay correos de ejemplo`);
    for (const c of correos) assert.match(c, /@acme\.example$/, `${rel}: «${c}» es inventado (acme.example)`);
    const huellas = Object.values(people.machines).map((e) => e.reported_sha256).filter((h) => h !== null);
    assert.ok(huellas.length, `${rel}: trae una huella de ejemplo`);
    for (const h of huellas) {
      assert.match(h, /^[0-9a-f]{64}$/);
      assert.ok(correos.some((c) => HUELLA(c) === h), `${rel}: la huella es la de un correo inventado del ejemplo, normalizado`);
    }
  }
  for (const rel of ['README.md', 'github/README.md']) {
    const text = fs.readFileSync(path.join(dir, rel), 'utf8');
    assert.match(text, /`people`/, `${rel} describe la clave people`);
    assert.match(text, /reported_sha256/, `${rel} dice que se guarda la huella`);
    assert.match(text, /createHash\('sha256'\)/, `${rel} da el comando de la huella`);
  }
});

test('T23 OperationsConfig_FormaMaquina_IgualQueUploadRuns (2.28, AC 5)', () => {
  const forma = (rel) => {
    const m = /^const FORMA_MAQUINA = (\/.+\/[a-z]*);/m.exec(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    assert.ok(m, `${rel} declara FORMA_MAQUINA`);
    return m[1];
  };
  assert.strictEqual(forma('scripts/lib/operations-config.js'), forma('scripts/metrics/upload-runs.js'), 'la copia del lector es igual a la de la subida');
  assert.strictEqual(String(OPS.FORMA_MAQUINA), forma('scripts/lib/operations-config.js'), 'y es la que exporta el lector');
  // el lector viaja solo: no carga nada fuera de fs (tampoco people.js ni upload-runs.js)
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'operations-config.js'), 'utf8');
  const requires = [...src.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((x) => x[1]);
  assert.deepStrictEqual(requires, ['fs']);
  assert.doesNotMatch(src, /require\(\s*[^'"`\s]/, 'ningún require con una ruta armada');
});
