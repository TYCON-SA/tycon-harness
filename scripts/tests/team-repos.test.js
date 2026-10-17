'use strict';

/**
 * team-repos.test.js — los dos lectores de la configuración de una organización (story 8.26, tanda J):
 * scripts/lib/team-repos.js (`team-repos.json`, en el perfil del equipo: dónde vive cada repo del arnés) y
 * scripts/lib/operations-config.js (`operations.json`, en el repo de operaciones: responsables, revisores y, desde la
 * story 2.28, quién es quién — `people`, con la huella del correo informado y nunca el correo en claro). Desde la story
 * 7.28, `team-repos.json` trae además `merge_suites`: dónde corren las suites completas al mergear cada repo.
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

// story 2.23: la clave `site` (mantenedores, buzón y refresco del sitio de la organización)
const goodSite = () => ({
  maintainers: ['lead@acme.example', 'Second@Acme.Example'],
  mailbox: { provider: 'azure-blob', account: 'acmeruns', container: 'runs', threads: false },
  refresh_minutes: 15,
});
const opsWithSite = (site) => ({ version: 1, owners: { default: 'lead@acme.example' }, ...(site === undefined ? {} : { site }) });

test('2.23-T3 OperationsConfig_SiteValido', () => {
  for (const site of [goodSite(), {}, undefined]) {
    const r = OPS.parse(JSON.stringify(opsWithSite(site)));
    assert.deepStrictEqual(r.problems, [], JSON.stringify(site));
    assert.strictEqual(r.ok, true);
  }
  assert.deepStrictEqual(OPS.parse(JSON.stringify(opsWithSite(goodSite()))).data.site, goodSite(), 'los datos salen tal cual');
  assert.ok(OPS.KEYS.includes('site'));
});

test('2.23-T4 OperationsConfig_SiteConSecretoEsProblema', () => {
  const casos = [
    [{ mailbox: { ...goodSite().mailbox, sas: 'sv=x' } }, ['site.mailbox.sas']],
    [{ token: 'x' }, ['site.token']],
    [{ oidc: { secret: 'x' } }, ['site.oidc', 'site.oidc.secret']],
    [{ maintainers: ['sin-arroba'] }, ['site.maintainers.0']],
    [{ maintainers: ['a@acme.example', 'con espacio@acme.example'] }, ['site.maintainers.1']],
    [{ maintainers: 'a@acme.example' }, ['site.maintainers']],
    [{ refresh_minutes: 1 }, ['site.refresh_minutes']],
    [{ refresh_minutes: 500 }, ['site.refresh_minutes']],
    [{ refresh_minutes: 7.5 }, ['site.refresh_minutes']],
    // la cuenta y el contenedor arman el host al que va la credencial: sólo la forma de Azure Storage (revisión de seguridad)
    [{ mailbox: { provider: 'azure-blob', account: 'host.malo/x?', container: 'runs' } }, ['site.mailbox.account']],
    [{ mailbox: { provider: 'azure-blob', account: 'acmeruns', container: '../x' } }, ['site.mailbox.container']],
    [{ mailbox: { provider: 'azure-blob', account: 'AB', container: 'r' } }, ['site.mailbox.account', 'site.mailbox.container']],
    [{ mailbox: { provider: 's3', account: 'acmeruns', container: 'runs' } }, ['site.mailbox.provider']],
    [{ mailbox: { provider: 'azure-blob' } }, ['site.mailbox.account', 'site.mailbox.container']],
    [{ mailbox: { ...goodSite().mailbox, threads: 'si' } }, ['site.mailbox.threads']],
    [{ mailbox: { ...goodSite().mailbox, password: 'x', SharedKey: 'y' } }, ['site.mailbox.SharedKey', 'site.mailbox.password']],
    // `site.url` existe, pero sólo https y sin usuario ni clave (T17 lo prueba entero)
    [{ url: 'http://x.example' }, ['site.url']],
    ['no', ['site']],
  ];
  for (const [site, esperado] of casos) {
    const r = OPS.parse(JSON.stringify(opsWithSite(site)));
    assert.strictEqual(r.ok, false, JSON.stringify(site));
    assert.strictEqual(r.data, null);
    assert.deepStrictEqual(paths(r), esperado, JSON.stringify(site));
  }
  // la clave con forma de secreto se nombra como secreto, no sólo como desconocida
  const sas = OPS.parse(JSON.stringify(opsWithSite({ mailbox: { ...goodSite().mailbox, sas: 'x' } })));
  assert.match(sas.problems[0].message, /secreto/);
  // un comentario `__` con la palabra no es una clave de secreto
  assert.strictEqual(OPS.parse(JSON.stringify(opsWithSite({ __token_doc: 'se explica acá', ...goodSite() }))).ok, true);
});

// ── el canal del aviso (`notify`) y la dirección del sitio (`site.url`) ─────────────────────────────────────────────
const opsWithExtra = (extra) => ({ version: 1, owners: { default: 'lead@acme.example' }, ...extra });

test('T16 OperationsConfig_NotifyYSiteUrl @story-2.30 @ac-14', () => {
  for (const channel of ['telegram', 'slack', 'teams']) {
    const r = OPS.parse(JSON.stringify(opsWithExtra({ notify: { channel } })));
    assert.deepStrictEqual(r.problems, [], channel);
    assert.strictEqual(r.data.notify.channel, channel);
  }
  const conUrl = OPS.parse(JSON.stringify(opsWithExtra({ site: { ...goodSite(), url: 'https://sitio.acme.example' } })));
  assert.deepStrictEqual(conUrl.problems, []);
  assert.strictEqual(conUrl.data.site.url, 'https://sitio.acme.example');
  // un comentario `__` dentro de notify no es problema
  assert.strictEqual(OPS.parse(JSON.stringify(opsWithExtra({ notify: { channel: 'slack', __doc: 'el webhook va en secretos' } }))).ok, true);
  assert.ok(OPS.KEYS.includes('notify'), 'la clave nace con su lector');
  assert.ok(OPS.SITE_KEYS.includes('url'));
  assert.deepStrictEqual(OPS.NOTIFY_CHANNELS, ['telegram', 'slack', 'teams']);
});

test('T17 OperationsConfig_NotifySinSecretos @story-2.30 @ac-14', () => {
  const casos = [
    [{ notify: { channel: 'slack', webhook_url: 'https://hooks.example/x' } }, ['notify.webhook_url']],
    [{ notify: { channel: 'telegram', token: 'x' } }, ['notify.token']],
    [{ notify: { channel: 'telegram', chat_id: '123' } }, ['notify.chat_id']],
    [{ notify: { channel: 'email' } }, ['notify.channel']],
    [{ notify: {} }, ['notify.channel']],
    [{ notify: { channel: 'slack', otra: 1 } }, ['notify.otra']],
    [{ notify: 'telegram' }, ['notify']],
    [{ site: { url: 'http://sitio.acme.example' } }, ['site.url']],
    [{ site: { url: 'https://u:p@sitio.acme.example' } }, ['site.url']],
    [{ site: { url: 'https://u@sitio.acme.example' } }, ['site.url']],
    [{ site: { url: 'no es una dirección' } }, ['site.url']],
    [{ site: { url: 42 } }, ['site.url']],
  ];
  for (const [extra, esperado] of casos) {
    const r = OPS.parse(JSON.stringify(opsWithExtra(extra)));
    assert.strictEqual(r.ok, false, JSON.stringify(extra));
    assert.deepStrictEqual(paths(r), esperado, JSON.stringify(extra));
  }
  // el destino se nombra como secreto, no sólo como clave desconocida
  const wh = OPS.parse(JSON.stringify(opsWithExtra({ notify: { channel: 'slack', webhook_url: 'https://hooks.example/x' } })));
  assert.match(wh.problems[0].message, /secreto/);
  assert.doesNotMatch(JSON.stringify(wh.problems), /hooks\.example/, 'el problema no repite el valor');
});

// ── story 7.28: dónde corren las suites completas al mergear (`merge_suites`) ─────────────────────────────────────────
const withSuites = (merge_suites) => Object.assign(goodTeam(), { merge_suites });

test('T17 TeamRepos_MergeSuites_ValidAbsentAndProblemsWithPath @story-7.28 @ac-11', () => {
  const full = {
    __doc: 'un comentario',
    default: 'automatico',
    repos: [
      { repo: azure('Backend', 'Ventas'), rule: 'confiar-en-el-servidor', full_tests_pipeline: 94 },
      { repo: azure('Front', 'Ventas'), full_tests_pipeline: 'Ventas Front' },
      { repo: github('widgets'), rule: 'siempre-en-la-maquina' },
      { repo: github('harness'), full_tests_pipeline: 'ci-completo' },
    ],
  };
  const ok = TEAM.parse(JSON.stringify(withSuites(full)));
  assert.deepStrictEqual(ok.problems, []);
  assert.strictEqual(ok.data.merge_suites.repos[0].full_tests_pipeline, 94);
  assert.deepStrictEqual(TEAM.MERGE_RULES, ['automatico', 'siempre-en-la-maquina', 'confiar-en-el-servidor']);
  // vacío y sin la clave: válidos, igual que hoy
  assert.strictEqual(TEAM.parse(JSON.stringify(withSuites({}))).ok, true);
  assert.strictEqual(TEAM.parse(JSON.stringify(goodTeam())).ok, true);

  const casos = [
    ['no', ['merge_suites']],
    [{ default: 'auto' }, ['merge_suites.default']],
    [{ repos: 'x' }, ['merge_suites.repos']],
    [{ otra: 1 }, ['merge_suites.otra']],
    [{ repos: ['x'] }, ['merge_suites.repos.0']],
    [{ repos: [{ repo: github('a'), rule: 'automatico', extra: 1 }] }, ['merge_suites.repos.0.extra']],
    [{ repos: [{ repo: github('a') }] }, ['merge_suites.repos.0']],
    [{ repos: [{ repo: { platform: 'github', org: 'acme' }, rule: 'automatico' }] }, ['merge_suites.repos.0.repo.repo']],
    [{ repos: [{ repo: github('a'), rule: 'nunca' }] }, ['merge_suites.repos.0.rule']],
    [{ repos: [{ repo: github('a'), full_tests_pipeline: '' }] }, ['merge_suites.repos.0.full_tests_pipeline']],
    [{ repos: [{ repo: github('a'), full_tests_pipeline: true }] }, ['merge_suites.repos.0.full_tests_pipeline']],
    [{ repos: [{ repo: github('a'), full_tests_pipeline: 7 }] }, ['merge_suites.repos.0.full_tests_pipeline']],
    [{ repos: [{ repo: azure('a'), full_tests_pipeline: 0 }] }, ['merge_suites.repos.0.full_tests_pipeline']],
    [{ repos: [{ repo: azure('a'), full_tests_pipeline: 1.5 }] }, ['merge_suites.repos.0.full_tests_pipeline']],
    // 🔴 pase adversarial: en Azure un texto de dígitos es un id, y «0» (o «00») no es ninguno
    [{ repos: [{ repo: azure('a'), full_tests_pipeline: '0' }] }, ['merge_suites.repos.0.full_tests_pipeline']],
    [{ repos: [{ repo: azure('a'), full_tests_pipeline: '00' }] }, ['merge_suites.repos.0.full_tests_pipeline']],
    [{ repos: [{ repo: github('Widgets'), rule: 'automatico' }, { repo: github('widgets'), full_tests_pipeline: 'x' }] }, ['merge_suites.repos.1.repo']],
  ];
  for (const [value, esperado] of casos) {
    const r = TEAM.parse(JSON.stringify(withSuites(value)));
    assert.strictEqual(r.ok, false, JSON.stringify(value));
    assert.strictEqual(r.data, null, 'con un problema no hay datos a medias');
    assert.deepStrictEqual(paths(r), esperado, JSON.stringify(value));
  }
});

test('T18 TeamRepos_MergeSuitesFor_DeclaredEntryDefaultAndMatch @story-7.28 @ac-6 @ac-11', () => {
  const data = withSuites({
    default: 'confiar-en-el-servidor',
    repos: [
      { repo: azure('Backend', 'Ventas Norte'), rule: 'siempre-en-la-maquina', full_tests_pipeline: '94' },
      { repo: github('widgets'), full_tests_pipeline: 'ci-completo' },
    ],
  });
  const azureId = { platform: 'azure', org: 'ACME', project: 'ventas%20norte', repo: 'backend' };
  assert.deepStrictEqual(TEAM.mergeSuitesFor(data, azureId), { declared: true, rule: 'siempre-en-la-maquina', ruleFrom: 'repo', pipeline: '94' });
  assert.deepStrictEqual(TEAM.mergeSuitesFor(data, { platform: 'github', org: 'Acme', repo: 'WIDGETS' }),
    { declared: true, rule: 'confiar-en-el-servidor', ruleFrom: 'organization', pipeline: 'ci-completo' });
  // un repo sin entrada usa el default; la misma ruta en otra plataforma no es la entrada
  assert.deepStrictEqual(TEAM.mergeSuitesFor(data, { platform: 'github', org: 'acme', repo: 'otro' }),
    { declared: true, rule: 'confiar-en-el-servidor', ruleFrom: 'organization', pipeline: null });
  assert.deepStrictEqual(TEAM.mergeSuitesFor(data, { platform: 'azure', org: 'acme', project: 'x', repo: 'widgets' }).pipeline, null);
  // `{}` declara (sin regla: automático); sin la clave, no declara
  assert.deepStrictEqual(TEAM.mergeSuitesFor(withSuites({}), azureId), { declared: true, rule: 'automatico', ruleFrom: 'default', pipeline: null });
  assert.deepStrictEqual(TEAM.mergeSuitesFor(goodTeam(), azureId), { declared: false, rule: null, ruleFrom: null, pipeline: null });
});

// ── story 7.29: la clave `models` (los modelos de cada trabajo del pipeline) ───────────────────────────────────────
const withModels = (models, base = goodTeam()) => Object.assign(base, { models });
const githubTeam = () => ({ version: 1, public: github('harness'), profile: github('harness-profile'), operations: github('harness-ops') });

test('T20 TeamRepos_Models_ValidoAusenteYProblemasDeSeccion @story-7.29 @ac-3', () => {
  const full = {
    mandatory_ceiling: true, ceiling: 'opus', reviewers: 'sonnet', reviewer: { 'mi-revisor-2': 'haiku', __nota: 'x' },
    reviewers_reloop: 'sonnet', adversarial: { model: 'sonnet', heavy: 'opus', fable_question: 'never' },
    helpers: 'haiku', session: { low: 'haiku', normal: 'sonnet', heavy: 'opus' }, __doc: 'comentario',
  };
  // válido con el perfil en Azure y en GitHub: los datos traen `models`
  for (const base of [goodTeam(), githubTeam()]) {
    const r = TEAM.parse(JSON.stringify(withModels(full, base)));
    assert.equal(r.ok, true, JSON.stringify(r.problems));
    assert.deepStrictEqual(r.data.models, full);
    assert.equal(r.sectionProblems, undefined, 'sin problemas de sección no hay sectionProblems');
  }
  // sin `models`: igual que hoy, y la versión no cambia
  const sin = TEAM.parse(JSON.stringify(goodTeam()));
  assert.equal(sin.ok, true);
  assert.equal('models' in sin.data, false);
  assert.equal(TEAM.VERSION, 1);
  // cada problema del AC 3, con su ruta, aparte: ok y data como sin models, y data sin models
  const casos = [
    [[], 'models'],
    [{ ceiling: 'sonnet' }, 'models.ceiling'],
    [{ mandatory_ceiling: true }, 'models.mandatory_ceiling'],
    [{ mandatory_ceiling: 'si', ceiling: 'sonnet' }, 'models.mandatory_ceiling'],
    [{ reviewers: 'Opus' }, 'models.reviewers'],
    [{ reviewers: 'claude-opus-5' }, 'models.reviewers'],
    [{ reviewer: { 'mi-revisor': 'gpt' } }, 'models.reviewer.mi-revisor'],
    [{ reviewer: { 'Mi Revisor': 'opus' } }, 'models.reviewer.Mi Revisor'],
    [{ reviewer: [] }, 'models.reviewer'],
    [{ session: { heavy: 'xl' } }, 'models.session.heavy'],
    [{ session: { enorme: 'opus' } }, 'models.session.enorme'],
    [{ adversarial: { fable_question: 'quizas' } }, 'models.adversarial.fable_question'],
    [{ adversarial: { otro: 'opus' } }, 'models.adversarial.otro'],
    [{ budget: 3 }, 'models.budget'],
  ];
  for (const [models, ruta] of casos) {
    const r = TEAM.parse(JSON.stringify(withModels(models)));
    assert.equal(r.ok, true, `${ruta}: un problema de models no invalida el archivo`);
    assert.ok(r.data && !('models' in r.data), `${ruta}: data sin models`);
    assert.deepStrictEqual(r.problems, []);
    assert.ok(r.sectionProblems && r.sectionProblems.models.some((p) => p.path === ruta), `${ruta}: ${JSON.stringify(r.sectionProblems)}`);
  }
  // un problema fuera de models sigue dejando data: null, y el de models igual sale aparte
  const doble = withModels({ reviewers: 'xl' });
  delete doble.operations.project;
  const rd = TEAM.parse(JSON.stringify(doble));
  assert.equal(rd.ok, false);
  assert.equal(rd.data, null);
  assert.deepStrictEqual(paths(rd), ['operations.project']);
  assert.ok(rd.sectionProblems.models.some((p) => p.path === 'models.reviewers'));
  // la capa se apila: validateTeamRepos con un problema sólo en models da ok
  const { validateTeamRepos } = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'team.js'));
  assert.deepStrictEqual(validateTeamRepos(JSON.stringify(withModels({ reviewers: 'Opus' })), { readerTree: ROOT }), { ok: true });
});

test('T21 TeamRepos_NombresDeModelos_IgualesAModelsJs @story-7.29 @ac-3', () => {
  const { resolveSkillsDirs } = require(path.join(ROOT, 'scripts', 'lib', 'skills-dir.js'));
  const MODELS = require(path.join(resolveSkillsDirs().skills, 'tycon-pipeline', 'scripts', 'lib', 'models.js')).MODELS;
  assert.deepStrictEqual(TEAM.MODEL_NAMES, MODELS);
});

// ── story 2.22: `deployments` (de qué sistema se leen los despliegues de cada producto) ─────────────────────────────
const opsWithDeployments = (deployments) => ({ version: 1, owners: { default: 'lead@acme.example' }, deployments });

test('T1 OperationsConfig_DeploymentsFormaValida (2.22, AC 1)', () => {
  const azureDoc = opsWithDeployments({ provider: 'azure', products: {
    Acme: { staging: [{ pipeline: 'Proyecto A/Acme CI', stages: ['EtapaX', 'EtapaZ'] }], production: [{ pipeline: 'Proyecto A/Acme Prod', stages: ['EtapaY'] }] },
    Beta: { production: [{ pipeline: 'B/Beta Prod', stages: ['EtapaY'] }] },
  } });
  const r = OPS.parse(JSON.stringify(azureDoc));
  assert.deepStrictEqual(r.problems, []);
  assert.ok(r.ok);
  const githubDoc = opsWithDeployments({ provider: 'github', products: {
    Acme: { staging: [{ repo: 'acme/app', environment: 'stg', workflow: 'ci.yml' }], production: [{ repo: 'acme/app', environment: 'prd' }] },
  } });
  assert.deepStrictEqual(OPS.parse(JSON.stringify(githubDoc)).problems, []);
  assert.ok(OPS.KEYS.includes('deployments'));
});

test('T2 OperationsConfig_DeploymentsProblemasEnSuRuta (2.22, AC 1)', () => {
  const r1 = OPS.parse(JSON.stringify(opsWithDeployments({ provider: 'gitlab', products: {} })));
  assert.deepStrictEqual(paths(r1), ['deployments.provider']);
  const r2 = OPS.parse(JSON.stringify(opsWithDeployments({ provider: 'azure', products: {
    Acme: { production: [{ pipeline: 'P/x', stages: [] }, { stages: ['EtapaY'] }], staging: [] },
  } })));
  assert.deepStrictEqual(paths(r2), ['deployments.products.Acme.production.0.stages', 'deployments.products.Acme.production.1.pipeline', 'deployments.products.Acme.staging']);
  assert.strictEqual(r2.data, null);
  const r3 = OPS.parse(JSON.stringify(opsWithDeployments({ provider: 'github', products: {
    Acme: { production: [{ repo: 'acme/app', environment: 'prd', workflow: 'ci.yml' }], otra: [] },
  } })));
  assert.deepStrictEqual(paths(r3), ['deployments.products.Acme.otra', 'deployments.products.Acme.production.0.workflow']);
  const r4 = OPS.parse(JSON.stringify(opsWithDeployments({ provider: 'azure', products: { Acme: { production: [{ pipeline: 'sinproyecto', stages: ['EtapaY'] }] } } })));
  assert.deepStrictEqual(paths(r4), ['deployments.products.Acme.production.0.pipeline']);
});

test('T2b OperationsConfig_DeploymentsRepoConPuntosYProductoVacio (2.22, revisores)', () => {
  const r = OPS.parse(JSON.stringify(opsWithDeployments({ provider: 'github', products: {
    Acme: { production: [{ repo: '../..', environment: 'prd' }, { repo: 'acme/..', environment: 'prd' }, { repo: 'acme/.app', environment: 'prd' }] }, Vacio: {},
  } })));
  assert.deepStrictEqual(paths(r), ['deployments.products.Acme.production.0.repo', 'deployments.products.Acme.production.1.repo', 'deployments.products.Vacio']);
});
