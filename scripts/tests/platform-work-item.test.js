'use strict';
// platform-work-item.test.js — el pedido de trabajo de la historia por la capa de plataforma: crearlo, marcarlo activo y
// cerrarlo con sus horas, con Azure DevOps (las mismas llamadas a az que escribían los pasos) y con GitHub (un issue, la
// etiqueta de tipo y de estado, las horas en un comentario). El campo `work_item` con su nombre viejo, la configuración
// del repo con su nombre viejo, lo que GitHub no tiene y el paso sin plataforma.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const LIB = path.join(ROOT, 'scripts', 'lib', 'platform');
const P = () => require(path.join(LIB, 'platform.js'));
const FIELD = () => require(path.join(LIB, 'work-item-field.js'));
const WCFG = () => require(path.join(LIB, 'work-items-config.js'));
const FAKE_AZ = path.join(ROOT, 'scripts', 'tests', 'lib', 'fake-az.sh');
const FAKE_GH = path.join(ROOT, 'scripts', 'tests', 'lib', 'fake-gh.js');
const LINT = path.join(ROOT, 'scripts', 'lib', 'lint-story-frontmatter.js');
const STEPS = path.join(ROOT, 'skills', 'tycon-pipeline', 'steps');
// el aviso al crear una historia sin pedido de trabajo: vive en la integración de Azure DevOps
const STORY_HOOK = path.join(ROOT, 'integrations', 'azure-devops', 'scripts', 'on-story-create.js');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

/** Un árbol con el perfil que elige `platform`, una casa vacía, el az y el gh de mentira, y el entorno que los apunta. */
function mundo({ platform, ghState = { user: 'arnes-bot', now: '2026-10-22T05:00:00Z', issues: {} } } = {}) {
  const tree = tmp('arbol-');
  const home = tmp('casa-');
  const fixaz = tmp('fixaz-');
  // sin elección en el perfil, tampoco hay team-repos.json: nadie eligió la plataforma
  fs.writeFileSync(path.join(tree, 'team-profile.json'), JSON.stringify(platform === undefined ? {} : { integrations: { platform } }));
  const ghFile = path.join(tmp('gh-'), 'estado.json');
  fs.writeFileSync(ghFile, JSON.stringify(ghState));
  const az = path.join(tmp('bin-'), 'az');
  fs.copyFileSync(FAKE_AZ, az);
  fs.chmodSync(az, 0o755);
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_TREE: tree, TYCON_HOME: path.join(home, '.tycon'), TYCON_ADO_CMD: az, FIXAZ: fixaz, TYCON_GH_CMD: FAKE_GH, FAKE_GH_STATE: ghFile };
  // lo que trae quien corre la prueba no entra: TYCON_PROFILE (las portables lo ponen en 0) apagaría el perfil del caso
  for (const k of Object.keys(env)) if (/^TYCON_(ADO_ORG|ADO_PROJECT|PLATFORM|PROFILE|INTEGRATIONS_DIR|AZ_FAIL|AZ_WITHOUT_SESSION)$|^GH_TOKEN$/.test(k)) delete env[k];
  return { tree, home, fixaz, ghFile, env };
}
/** Un repo de historias con su configuración del pedido de trabajo (`archivo`: work-items.yaml o ado-config.yaml). */
function repoCon(archivo, texto) {
  const repo = tmp('historias-');
  fs.mkdirSync(path.join(repo, '.tycon'), { recursive: true });
  if (archivo) fs.writeFileSync(path.join(repo, '.tycon', archivo), texto);
  return repo;
}
// La configuración de Azure DevOps de hoy, con su forma real: comentarios en la línea y épicas en bloque
const ADO_CONFIG = [
  '# Config ADO del repo — la consumen la creación, el paso de activo y el cierre',
  'ado_org: https://dev.azure.com/acme',
  'ado_project: "Producto"',
  'ado_wi_type: "User Story"        # process Agile — fijado para no re-detectar',
  'ado_area_path: "Producto"',
  'ado_iteration_path: ""           # backlog',
  'ado_iteration_auto_from_frontmatter: false',
  'ado_state_active: "Active"',
  'ado_state_closed: "Closed"',
  'ado_auto_assign: false',
  'ado_default_tags: "tycon"',
  '',
  '# Mapeo epic (frontmatter `epic:`) → id del Epic',
  'epic_links:',
  '  riesgos: 4492          # Evaluación de riesgo',
  '  # un comentario en el medio del bloque',
  '  "9": 5039',
  '',
].join('\n');
const GH_CONFIG = ['repo: acme/portal', 'type: "Historia"', 'state_active: "en curso"', 'state_closed: "hecho"', 'default_tags: "tycon"', ''].join('\n');
const ORG = 'https://dev.azure.com/acme';

/** Las llamadas que recibió el az de mentira: `[paso, args]`. */
const llamadasAz = (m) => {
  const f = path.join(m.fixaz, 'llamadas.log');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { const [paso, j] = l.split('\t'); return [paso, JSON.parse(j).args]; }) : [];
};
/** Como `llamadasAz`, con los archivos que leyó cada llamada (`@archivo`, `Campo=@archivo`): `[paso, args, archivos]`. */
const llamadasAzConArchivos = (m) => {
  const f = path.join(m.fixaz, 'llamadas.log');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { const [paso, j] = l.split('\t'); const o = JSON.parse(j); return [paso, o.args, o.archivos]; }) : [];
};
/** Un argumento `Campo=@archivo` con la ruta tapada: la ruta es temporal y cambia en cada corrida. */
const sinRuta = (a) => a.replace(/=@.*$/s, '=@<archivo>');
const estadoGh = (m) => JSON.parse(fs.readFileSync(m.ghFile, 'utf8'));
/** La capa por su línea de comandos, como la llaman los pasos. */
function cli(m, argv) {
  const r = spawnSync(process.execPath, [path.join(LIB, 'platform.js'), ...argv], { env: m.env, encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr, json: (() => { try { return JSON.parse(r.stdout); } catch (_) { return null; } })() };
}

test('WorkItem_Create_Azure_SameAzCalls @story-8.85 @ac-7', async () => {
  const m = mundo({ platform: { default: 'azure-devops' } });
  const repo = repoCon('ado-config.yaml', ADO_CONFIG);
  const r = await P().run('work-item.create', { repoDir: repo, title: 'Story 9.1: Algo', description: '<p>d</p>', acceptance: '<p>a</p>', priority: 2, epic: 'riesgos' }, { env: m.env });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.value.id, 101);
  assert.strictEqual(r.value.url, `${ORG}/Producto/_workitems/edit/101`);
  // los pasos de la skill de creación (5 y 6), comando por comando: el campo vacío (la iteración) no se manda, y la
  // descripción y los criterios van por archivo (az lee como archivo un valor que empieza con «@»)
  assert.deepStrictEqual(llamadasAz(m).map(([p, a]) => [p, a.map(sinRuta)]), [
    ['crear', ['boards', 'work-item', 'create', '--organization', ORG, '--project', 'Producto', '--type', 'User Story', '--title', 'Story 9.1: Algo',
      '--fields', 'System.Description=@<archivo>', 'Microsoft.VSTS.Common.AcceptanceCriteria=@<archivo>', 'Microsoft.VSTS.Common.Priority=2', 'System.AreaPath=Producto', 'System.Tags=tycon',
      '--output', 'json']],
    ['relacion', ['boards', 'work-item', 'relation', 'add', '--organization', ORG, '--id', '101', '--relation-type', 'parent', '--target-id', '4492', '--output', 'json']],
  ]);
  assert.deepStrictEqual(Object.values(llamadasAzConArchivos(m)[0][2]).sort(), ['<p>a</p>', '<p>d</p>']);
  // una épica sin mapeo: se crea suelta y se dice
  const s = await P().run('work-item.create', { repoDir: repo, title: 'Story 9.2: Otra', epic: 'sin-mapeo' }, { env: m.env });
  assert.strictEqual(s.ok, true);
  assert.match(s.value.warnings.join(' '), /sin-mapeo.*suelt|suelt.*sin-mapeo/);
  assert.strictEqual(llamadasAz(m).filter(([p]) => p === 'relacion').length, 1, 'sin mapeo no hay relación');
});

// Pedido_AsignadoAlResponsable @story-4.11 @ac-25 (el conector de Azure)
// 🔴 Falla con: no asignar el pedido de la noche porque auto_assign está apagado, asignar uno común sin auto_assign, o no
//    decir a quién quedó asignado.
test('T41 Pedido_AsignadoAlResponsable (el conector de Azure)', async () => {
  const m = mundo({ platform: { default: 'azure-devops' } });
  const repo = repoCon('ado-config.yaml', ADO_CONFIG);
  const noche = await P().run('work-item.create', { repoDir: repo, title: 'Las pruebas quedaron en rojo (ejecuciones)', assignTo: 'lead@acme.example', forNight: true }, { env: m.env });
  assert.strictEqual(noche.ok, true, JSON.stringify(noche));
  assert.strictEqual(noche.value.assigned, 'lead@acme.example');
  const [, args] = llamadasAz(m).find(([p]) => p === 'crear');
  assert.deepStrictEqual(args.slice(args.indexOf('--assigned-to'), args.indexOf('--assigned-to') + 2), ['--assigned-to', 'lead@acme.example']);
  // sin el pedido de la noche, auto_assign apagado sigue sin asignar
  const comun = await P().run('work-item.create', { repoDir: repo, title: 'Story 9.3: Otra', assignTo: 'lead@acme.example' }, { env: m.env });
  assert.strictEqual(comun.ok, true);
  assert.ok(!('assigned' in comun.value));
  assert.ok(!llamadasAz(m).filter(([p]) => p === 'crear')[1][1].includes('--assigned-to'));
});

// Pedido_SinConfigurar_NoLlamaYLoDice @story-4.11 @ac-35 (el conector de Azure)
// 🔴 Falla con: no tomar la organización, el proyecto y el tipo que trae el pedido de la noche (el repo de operaciones no
//    tiene configuración de pedidos: vienen de operations.json), o que el del pedido no gane sobre el del repo.
test('T43c Pedido_OrganizacionYProyectoDelPedido (el conector de Azure)', async () => {
  const m = mundo({ platform: { default: 'azure-devops' } });
  const ops = repoCon(null, null);
  const r = await P().run('work-item.create', { repoDir: ops, org: 'acme', project: 'Operaciones', type: 'Task', title: 'Las pruebas quedaron en rojo (ejecuciones)', forNight: true }, { env: m.env });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const [, args] = llamadasAz(m).find(([p]) => p === 'crear');
  for (const [op, valor] of [['--organization', ORG], ['--project', 'Operaciones'], ['--type', 'Task']]) assert.strictEqual(args[args.indexOf(op) + 1], valor, op);
  const otro = repoCon('work-items.yaml', 'org: otra\nproject: Producto\ntype: Bug\n');
  await P().run('work-item.create', { repoDir: otro, org: 'acme', project: 'Operaciones', title: 'X' }, { env: m.env });
  const [, a2] = llamadasAz(m).filter(([p]) => p === 'crear')[1];
  assert.deepStrictEqual([a2[a2.indexOf('--organization') + 1], a2[a2.indexOf('--project') + 1]], [ORG, 'Operaciones']);
});

// Pedido_TipoQueNoExiste_VaComoBacklog @story-4.11 @ac-44 (el conector de Azure)
// 🔴 Falla con: crear con un tipo que el proyecto no tiene, no caer al elemento de backlog sin tipo configurado, leer los
//    tipos sin la marca, crear sin haber podido leerlos o con un obligatorio sin cubrir, o contestar no_medido (el ciclo
//    lo lee como «pudo crearlo»).
test('T98 Pedido_TipoQueNoExiste_VaComoBacklog (el conector de Azure)', async () => {
  const m = mundo({ platform: { default: 'azure-devops' } });
  const ops = repoCon(null, null);
  const noche = (extra) => P().run('work-item.create', { repoDir: ops, org: 'acme', project: 'Operaciones', title: 'Las pruebas quedaron en rojo (ejecuciones)', forNight: true, ...extra }, { env: m.env });
  const tipoCreado = () => { const c = llamadasAz(m).filter(([p]) => p === 'crear'); const a = c[c.length - 1][1]; return a[a.indexOf('--type') + 1]; };
  const creaciones = () => llamadasAz(m).filter(([p]) => p === 'crear').length;
  const lecturas = () => llamadasAz(m).filter(([p]) => p === 'campos' || p === 'categorias').length;

  const r1 = await noche({ type: 'Riesgo', typeOrBacklog: true });
  assert.strictEqual(r1.ok, true, JSON.stringify(r1));
  assert.strictEqual(tipoCreado(), 'Bug', 'el tipo que no existe va como el elemento de backlog');
  assert.deepStrictEqual([r1.value.type, r1.value.typeFallback, r1.value.typeAsked], ['Bug', true, 'Riesgo']);
  assert.ok(r1.value.warnings.some((w) => /«Riesgo» no existe en Operaciones/.test(w)), JSON.stringify(r1.value.warnings));

  const r2 = await noche({ typeOrBacklog: true });
  assert.strictEqual(r2.ok, true, JSON.stringify(r2));
  assert.strictEqual(tipoCreado(), 'Bug', 'sin tipo configurado, directo al backlog');
  assert.deepStrictEqual([r2.value.typeFallback, r2.value.typeAsked], [true, null]);
  assert.ok(r2.value.warnings.some((w) => /^sin tipo configurado/.test(w)), JSON.stringify(r2.value.warnings));

  const r3 = await noche({ type: 'Bug', typeOrBacklog: true });
  assert.strictEqual(r3.ok, true, JSON.stringify(r3));
  assert.strictEqual(tipoCreado(), 'Bug');
  assert.strictEqual(r3.value.type, 'Bug');
  assert.ok(!('typeFallback' in r3.value), 'el que existe va tal cual');

  const antes = lecturas();
  const r4 = await noche({ type: 'Riesgo' });
  assert.strictEqual(r4.ok, true, JSON.stringify(r4));
  assert.strictEqual(tipoCreado(), 'Riesgo', 'sin la marca, el tipo que le dan');
  assert.strictEqual(lecturas(), antes, 'sin la marca no lee los tipos');

  for (const paso of ['campos', 'categorias']) {
    m.env.TYCON_AZ_FAIL = paso;
    const n = creaciones();
    const r = await noche({ type: 'Riesgo', typeOrBacklog: true });
    assert.strictEqual(r.ok, false, `${paso}: ${JSON.stringify(r)}`);
    assert.notStrictEqual(r.reason, 'no_medido', paso);
    assert.strictEqual(creaciones(), n, `${paso}: sin poder leer los tipos no se crea`);
  }
  // una caída que no es «el tipo no existe» no cae al backlog: no lee la categoría
  m.env.TYCON_AZ_FAIL = 'campos';
  const cats = llamadasAz(m).filter(([p]) => p === 'categorias').length;
  assert.strictEqual((await noche({ type: 'Riesgo', typeOrBacklog: true })).ok, false);
  assert.strictEqual(llamadasAz(m).filter(([p]) => p === 'categorias').length, cats, 'la caída de la lectura no se toma por un tipo que no existe');
  delete m.env.TYCON_AZ_FAIL;

  // una respuesta rara de la categoría, o sin tipo legible, es un no con motivo: nunca no_medido, nunca se crea
  const catFix = path.join(m.fixaz, 'categorias-Operaciones.json');
  for (const cuerpo of [{ value: {} }, { value: 'x' }, { count: 1, value: [{ referenceName: 'Microsoft.RequirementCategory' }] },
    { count: 1, value: [{ referenceName: 'Microsoft.RequirementCategory', defaultWorkItemType: { name: 'Bu/g' } }] }]) {
    fs.writeFileSync(catFix, JSON.stringify(cuerpo));
    const n = creaciones();
    const r = await noche({ typeOrBacklog: true });
    assert.deepStrictEqual([r.ok, r.reason], [false, 'rechazado'], `${JSON.stringify(cuerpo)}: ${JSON.stringify(r)}`);
    assert.strictEqual(creaciones(), n, `${JSON.stringify(cuerpo)}: no se crea`);
  }
  fs.unlinkSync(catFix);
  // los campos del tipo con un «value» que no es lista: tampoco se crea
  fs.writeFileSync(path.join(m.fixaz, 'campos-Operaciones-Bug.json'), JSON.stringify({ value: {} }));
  const nc = creaciones();
  const rCampos = await noche({ type: 'Bug', typeOrBacklog: true });
  assert.deepStrictEqual([rCampos.ok, rCampos.reason], [false, 'rechazado'], JSON.stringify(rCampos));
  assert.strictEqual(creaciones(), nc);
  fs.unlinkSync(path.join(m.fixaz, 'campos-Operaciones-Bug.json'));

  // un tipo configurado sin forma de nombre no entra en la ruta de la API
  const antesRaro = lecturas();
  const rRaro = await noche({ type: 'Ries/../go', typeOrBacklog: true });
  assert.deepStrictEqual([rRaro.ok, rRaro.reason], [false, 'rechazado'], JSON.stringify(rRaro));
  assert.strictEqual(lecturas(), antesRaro, 'un tipo sin forma no se lee');

  // el tipo configurado existe pero exige un obligatorio que el pedido no trae; uno que trae, o con valor por defecto, no frena
  fs.writeFileSync(path.join(m.fixaz, 'campos-Operaciones-Riesgo.json'), JSON.stringify({ count: 4, value: [
    { referenceName: 'System.Title', alwaysRequired: true }, { referenceName: 'Custom.Probabilidad', alwaysRequired: true },
    { referenceName: 'Custom.Origen', alwaysRequired: true, defaultValue: 'noche' }, { referenceName: 'Custom.Area', alwaysRequired: true }] }));
  const nr = creaciones();
  const rFalta = await noche({ type: 'Riesgo', typeOrBacklog: true, fields: { 'Custom.Area': 'x' } });
  assert.deepStrictEqual([rFalta.ok, rFalta.reason], [false, 'rechazado'], JSON.stringify(rFalta));
  assert.match(rFalta.detail, /Custom\.Probabilidad/);
  assert.doesNotMatch(rFalta.detail, /Custom\.(Area|Origen)|System\.Title/);
  assert.strictEqual(creaciones(), nr);
  const rTrae = await noche({ type: 'Riesgo', typeOrBacklog: true, fields: { 'Custom.Area': 'x', 'Custom.Probabilidad': 'alta' } });
  assert.strictEqual(rTrae.ok, true, JSON.stringify(rTrae));
  assert.strictEqual(tipoCreado(), 'Riesgo');
  fs.unlinkSync(path.join(m.fixaz, 'campos-Operaciones-Riesgo.json'));

  fs.writeFileSync(path.join(m.fixaz, 'campos-Operaciones-Bug.json'), JSON.stringify({ count: 2, value: [
    { referenceName: 'System.Title', alwaysRequired: true }, { referenceName: 'Custom.Impacto', alwaysRequired: true }] }));
  const n = creaciones();
  const r5 = await noche({ type: 'Riesgo', typeOrBacklog: true });
  assert.deepStrictEqual([r5.ok, r5.reason], [false, 'rechazado'], JSON.stringify(r5));
  assert.match(r5.detail, /Custom\.Impacto/);
  assert.strictEqual(creaciones(), n, 'con un obligatorio sin cubrir no se crea');
});

test('WorkItem_Create_Github_OpensIssue @story-8.85 @ac-7', async () => {
  const m = mundo({ platform: { default: 'github' } });
  const repo = repoCon('work-items.yaml', GH_CONFIG);
  const story = path.join(repo, 'story-9-1.md');
  fs.writeFileSync(story, '---\nstory: "9.1"\nepic: 9\nstatus: ready-for-dev\ndepends_on: []\n---\n\n# Story\n');
  const r = cli(m, ['work-item', 'create', '--args', JSON.stringify({ repoDir: repo, title: 'Story 9.1: Algo', description: 'el texto', acceptance: '1. anda' })]);
  assert.strictEqual(r.status, 0, r.err);
  assert.strictEqual(r.json.ok, true, r.out);
  const issue = estadoGh(m).issues['acme/portal'][0];
  assert.strictEqual(issue.title, 'Story 9.1: Algo');
  assert.deepStrictEqual(issue.labels.sort(), ['tipo:Historia', 'tycon']);
  assert.match(issue.body, /el texto/);
  assert.match(issue.body, /1\. anda/);
  assert.strictEqual(r.json.value.id, issue.number);
  assert.strictEqual(r.json.value.url, `https://github.com/acme/portal/issues/${issue.number}`);
  // el paso escribe el número con el campo neutro
  FIELD().write(story, r.json.value.id);
  assert.match(fs.readFileSync(story, 'utf8'), new RegExp(`^depends_on: \\[\\]\\nwork_item: ${issue.number}$`, 'm'));
});

test('WorkItem_FieldName_NeutralWithAlias @story-8.85 @ac-8', () => {
  const F = FIELD();
  assert.strictEqual(F.idOf('story: "1"\nado_work_item: 5284\n'), '5284');
  assert.strictEqual(F.idOf('story: "1"\nwork_item: 77   # el issue\n'), '77');
  assert.strictEqual(F.idOf('work_item: 77\nado_work_item: 5284\n'), '77', 'con los dos gana el neutro');
  assert.strictEqual(F.idOf('ado_work_item: 5284\nwork_item: "88"\n'), '88');
  assert.strictEqual(F.idOf('story: "1"\n'), null);
  assert.strictEqual(F.idOf('work_item: TBD\n'), null, 'TBD no es un id');
  assert.strictEqual(F.idOf({ ado_work_item: 5284 }), '5284', 'también un frontmatter ya leído');
  assert.strictEqual(F.idOf({ work_item: 9, ado_work_item: 5284 }), '9');
  // escribir: el neutro, y el viejo se reemplaza en su lugar (nadie escribe ado_work_item)
  const d = tmp('campo-');
  const vieja = path.join(d, 'vieja.md');
  fs.writeFileSync(vieja, '---\nstory: "1"\nado_work_item: TBD\nowner: x\n---\n# S\nado_work_item: 3 en el cuerpo\n');
  F.write(vieja, 5300);
  assert.strictEqual(fs.readFileSync(vieja, 'utf8'), '---\nstory: "1"\nwork_item: 5300\nowner: x\n---\n# S\nado_work_item: 3 en el cuerpo\n');
  const sinDepends = path.join(d, 'sin.md');
  fs.writeFileSync(sinDepends, '---\nstory: "2"\nstatus: x\npipelines:\n  a: 1\n---\n');
  F.write(sinDepends, 12);
  assert.strictEqual(fs.readFileSync(sinDepends, 'utf8'), '---\nstory: "2"\nstatus: x\nwork_item: 12\npipelines:\n  a: 1\n---\n');
  // los lectores del arnés leen el mismo id con los dos nombres
  const snap = fs.readFileSync(path.join(ROOT, 'scripts', 'nightly', 'projects', 'snapshot.js'), 'utf8');
  const hook = fs.readFileSync(STORY_HOOK, 'utf8');
  const como = fs.readFileSync(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'how-it-works.js'), 'utf8');
  const pipe = fs.readFileSync(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'pipeline.js'), 'utf8');
  const visual = fs.readFileSync(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'visual-plan.js'), 'utf8');
  for (const [n, t] of [['snapshot.js', snap], ['on-story-create.js', hook], ['how-it-works.js', como], ['pipeline.js', pipe], ['visual-plan.js', visual]]) {
    assert.match(t, /work-item-field\.js/, `${n} lee el campo con el lector común`);
    assert.doesNotMatch(t.replace(/^\s*(\/\/|\*).*$/gm, ''), /fm\.ado_work_item|'ado_work_item'\)|\^ado_work_item:/, `${n} no lee el nombre viejo por su cuenta`);
  }
});

test('Lint_OldFieldName_WarnsNewStory @story-8.85 @ac-8', () => {
  const repo = tmp('lint-campo-');
  // fechas fijas y sin mantenimiento automático: el commit de juguete da lo mismo en cada corrida
  const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-C', repo, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-01T00:00:00Z' } });
  git('init', '-q'); git('config', 'user.email', 'a@b.c'); git('config', 'user.name', 'a');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  const vieja = path.join(repo, 'specs', 'story-1-1.md');
  fs.writeFileSync(vieja, '---\nstory: "1.1"\nepic: 1\nstatus: done\nado_work_item: 5284\n---\n# S\n');
  git('add', '.'); git('commit', '-qm', 'una historia que ya existía');
  const nueva = path.join(repo, 'specs', 'story-1-2.md');
  fs.writeFileSync(nueva, '---\nstory: "1.2"\nepic: 1\nstatus: ready-for-dev\nado_work_item: 5300\n---\n# S\n');
  const antes = fs.readFileSync(vieja, 'utf8');
  const r = spawnSync(process.execPath, [LINT, vieja, nueva], { cwd: repo, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `avisa, no frena: ${r.stdout}${r.stderr}`);
  const salida = r.stdout + r.stderr;
  assert.match(salida, /story-1-2\.md.*ado_work_item.*work_item/);
  assert.doesNotMatch(salida, /story-1-1\.md.*ado_work_item/, 'a la que ya existía no se le avisa');
  assert.strictEqual(fs.readFileSync(vieja, 'utf8'), antes, 'el lint no toca la existente');
});

test('WorkItem_ActiveAndClose_Azure_SameAzCalls @story-8.85 @ac-9', async () => {
  const m = mundo({ platform: { workItems: 'azure-devops' } });
  const repo = repoCon('ado-config.yaml', ADO_CONFIG);
  // paso 00c: el estado en texto, y de New a Active
  const a = cli(m, ['work-item', 'update', '--args', JSON.stringify({ repoDir: repo, id: 101 })]);
  assert.strictEqual(a.json.ok, true, a.out);
  assert.deepStrictEqual(a.json.value, { id: 101, estado: 'Active', previo: 'New', changed: true, warnings: [] });
  assert.match(a.json.summary, /#101.*New → Active/);
  // idempotente: ya activo, no se toca
  const b = cli(m, ['work-item', 'update', '--args', JSON.stringify({ repoDir: repo, id: 101 })]);
  assert.strictEqual(b.json.value.changed, false);
  // paso 09: el comentario, después el estado con las horas en CompletedWork (nunca Effort)
  const c = cli(m, ['work-item', 'close', '--args', JSON.stringify({ repoDir: repo, id: 101, comment: '**Story cerrada**', hours: 0.3 })]);
  assert.strictEqual(c.json.ok, true, c.out);
  assert.deepStrictEqual(llamadasAz(m), [
    ['wi', ['boards', 'work-item', 'show', '--organization', ORG, '--id', '101', '--query', 'fields."System.State"', '--output', 'tsv']],
    ['actualizar', ['boards', 'work-item', 'update', '--organization', ORG, '--id', '101', '--state', 'Active', '--output', 'json']],
    ['wi', ['boards', 'work-item', 'show', '--organization', ORG, '--id', '101', '--query', 'fields."System.State"', '--output', 'tsv']],
    ['comentario', ['boards', 'work-item', 'update', '--organization', ORG, '--id', '101', '--discussion', '**Story cerrada**', '--output', 'json']],
    ['actualizar', ['boards', 'work-item', 'update', '--organization', ORG, '--id', '101', '--state', 'Closed', '--fields', 'Microsoft.VSTS.Scheduling.CompletedWork=0.3', '--output', 'json']],
  ]);
  assert.doesNotMatch(JSON.stringify(llamadasAz(m)), /Effort/);
  assert.match(c.json.summary, /#101 cerrado.*0\.3 h en CompletedWork/);
  // uno cerrado no se reabre sin que lo pida una persona
  const d = cli(m, ['work-item', 'update', '--args', JSON.stringify({ repoDir: repo, id: 101 })]);
  assert.strictEqual(d.json.value.changed, false);
  assert.match(d.json.value.warnings.join(' '), /Closed.*reabrir/);
});

test('WorkItem_Close_Github_HoursInComment @story-8.85 @ac-9', async () => {
  const m = mundo({ platform: { default: 'github' }, ghState: { user: 'arnes-bot', now: '2026-10-22T05:00:00Z', issues: { 'acme/portal': [{ number: 7, state: 'open', title: 'Story 9.1', labels: ['tipo:Historia', 'estado:nuevo'] }] } } });
  const repo = repoCon('work-items.yaml', GH_CONFIG);
  const a = cli(m, ['work-item', 'update', '--args', JSON.stringify({ repoDir: repo, id: 7 })]);
  assert.strictEqual(a.json.ok, true, a.out);
  assert.deepStrictEqual(estadoGh(m).issues['acme/portal'][0].labels.sort(), ['estado:en curso', 'tipo:Historia']);
  const c = cli(m, ['work-item', 'close', '--args', JSON.stringify({ repoDir: repo, id: 7, comment: '**Story cerrada**', seconds: 1080 })]);
  assert.strictEqual(c.json.ok, true, c.out);
  const st = estadoGh(m);
  const issue = st.issues['acme/portal'][0];
  assert.strictEqual(issue.state, 'closed');
  assert.deepStrictEqual(issue.labels.sort(), ['estado:hecho', 'tipo:Historia']);
  assert.deepStrictEqual(st.comments['acme/portal#7'].map((x) => x.body), ['**Story cerrada**', 'Horas completadas: 0.3 h']);
  assert.strictEqual(c.json.value.hoursAs, 'comment');
  // el cierre de la ejecución dice que las horas no fueron a un campo
  assert.match(c.json.summary, /#7 cerrado.*0\.3 h como comentario/);
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'integrations', 'github', 'integration.json'), 'utf8'));
  assert.strictEqual(man.capabilities.completedHours, 'comment');
  for (const op of ['work-item.create', 'work-item.update', 'work-item.close']) assert.ok(man.operations.includes(op), op);
});

test('WorkItem_Type_Github_Label @story-8.85 @ac-10', async () => {
  const m = mundo({ platform: { workItems: 'github' } });
  const repo = repoCon('work-items.yaml', GH_CONFIG);
  const r = await P().run('work-item.create', { repoDir: repo, title: 'Riesgo: proveedor caído', type: 'Riesgo' }, { env: m.env });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.ok(estadoGh(m).issues['acme/portal'][0].labels.includes('tipo:Riesgo'));
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'integrations', 'github', 'integration.json'), 'utf8'));
  assert.strictEqual(man.capabilities.workItemType, 'label');
});

test('WorkItem_OldAdoConfig_StillRead @story-8.85 @ac-10', () => {
  const C = WCFG();
  const vieja = C.read(repoCon('ado-config.yaml', ADO_CONFIG));
  assert.strictEqual(vieja.problem, undefined);
  assert.strictEqual(vieja.legacy, true);
  assert.deepStrictEqual(vieja.config, { org: ORG, project: 'Producto', type: 'User Story', area_path: 'Producto', iteration_path: '', iteration_auto_from_frontmatter: false, state_active: 'Active', state_closed: 'Closed', auto_assign: false, default_tags: 'tycon', epic_links: { riesgos: 4492, 9: 5039 } });
  // con los dos archivos gana el nuevo, entero (no se mezclan)
  const ambos = repoCon('ado-config.yaml', ADO_CONFIG);
  fs.writeFileSync(path.join(ambos, '.tycon', 'work-items.yaml'), 'org: https://dev.azure.com/otra\nproject: Nuevo\nepic_links: {}\n');
  const n = C.read(ambos);
  assert.strictEqual(n.legacy, false);
  assert.deepStrictEqual(n.config, { org: 'https://dev.azure.com/otra', project: 'Nuevo', epic_links: {} });
  assert.match(n.file, /work-items\.yaml$/);
  // sin ninguno: no hay configuración (no es un error); uno que no se entiende sí lo es, con la línea
  assert.deepStrictEqual(C.read(repoCon(null)), { config: null });
  const rota = C.read(repoCon('work-items.yaml', 'project: X\n- suelto\n'));
  assert.match(rota.problem, /línea 2/);
});

test('WorkItem_UnsupportedField_DeclaredNotSilent @story-8.85 @ac-10', async () => {
  const m = mundo({ platform: { default: 'github' } });
  const repo = repoCon('work-items.yaml', GH_CONFIG);
  const r = cli(m, ['work-item', 'create', '--args', JSON.stringify({ repoDir: repo, title: 'Riesgo X', type: 'Riesgo', priority: 1, fields: { Probabilidad: 'Alta' } })]);
  assert.strictEqual(r.json.ok, true, 'el issue se crea igual');
  assert.deepStrictEqual(r.json.value.unsupported.map((u) => u.field).sort(), ['Prioridad', 'Probabilidad']);
  for (const u of r.json.value.unsupported) assert.strictEqual(u.reason, 'no_soportado');
  // el paso lo dice en una línea, que llega al cierre de la ejecución
  assert.match(r.json.summary, /no soportado en GitHub: Prioridad, Probabilidad/);
  assert.strictEqual(r.json.summary.split('\n').length, 1);
  // en el cierre también: lo que no se cargó se dice
  const c = cli(m, ['work-item', 'close', '--args', JSON.stringify({ repoDir: repo, id: r.json.value.id, hours: 2, fields: { Probabilidad: 'Baja' } })]);
  assert.strictEqual(c.json.ok, true);
  assert.match(c.json.summary, /no soportado en GitHub: Probabilidad/);
  // el cierre lleva esa línea al mensaje de cierre, no sólo al registro
  const paso = fs.readFileSync(path.join(STEPS, 'close-work-item.md'), 'utf8');
  assert.match(paso, /`summary`[^\n]*mensaje de cierre/);
});

test('WorkItem_NoPlatform_StepSkippedOneLine @story-8.85 @ac-11', () => {
  const repo = repoCon('ado-config.yaml', ADO_CONFIG);
  // sin plataforma elegida: ni el perfil ni team-repos.json (el de operaciones no declara la suya)
  const sin = mundo({});
  const a = cli(sin, ['work-item', 'update', '--args', JSON.stringify({ repoDir: repo, id: 101 })]);
  assert.strictEqual(a.status, 0, 'el paso sigue');
  assert.strictEqual(a.json.reason, 'sin_plataforma');
  assert.strictEqual(a.json.summary.split('\n').length, 1);
  assert.match(a.json.summary, /no se tocó.*integrations\.platform/);
  assert.deepStrictEqual(llamadasAz(sin), [], 'sin plataforma no se llama a nadie');
  // sin credencial: az sin sesión
  const cred = mundo({ platform: { default: 'azure-devops' } });
  cred.env.TYCON_AZ_WITHOUT_SESSION = '1';
  const b = cli(cred, ['work-item', 'close', '--args', JSON.stringify({ repoDir: repo, id: 101, hours: 1 })]);
  assert.strictEqual(b.status, 0);
  assert.strictEqual(b.json.reason, 'sin_credencial');
  assert.match(b.json.summary, /no se tocó.*az login/);
  // los dos pasos piden a la capa y no llaman a az por su cuenta
  for (const f of ['step-01-start.md', 'close-work-item.md']) {
    const t = fs.readFileSync(path.join(STEPS, f), 'utf8');
    assert.match(t, /platform\.js work-item (update|close)/, f);
    assert.doesNotMatch(t, /^\s*(current_state=\$\()?az boards work-item (update|show|create)\b/m, `${f} no trae el comando crudo`);
  }
});

test('WorkItem_OldStory_AdoFieldOnly_ClosesAsToday @story-8.85 @ac-8 @ac-9', () => {
  // una historia que ya existía, con el campo viejo y sin el nuevo (frontmatter de una historia real de un cliente,
  // con los nombres cambiados): se lee su id y se cierra con las mismas llamadas de hoy
  const m = mundo({ platform: { default: 'azure-devops' } });
  const repo = repoCon('ado-config.yaml', ADO_CONFIG);
  const story = path.join(repo, 'specs', 'legajo', 'stories', '1-1-backend-legajo.md');
  fs.mkdirSync(path.dirname(story), { recursive: true });
  const texto = ['---', 'epic: 1', 'story: "1.1"', 'title: "Backend — legajo: buscador, solicitudes y PDF con imágenes"', 'status: review', 'sprint: TBD',
    'priority: "P1"', 'approach: "[ADAPT]"', 'depends_on: []', 'ado_work_item: 5284', 'owner: "Persona A"', 'files_to_create:', '  - "src/Acme/Features/Legajo/LegajoService.cs"', '---', '', '# Story 1.1', ''].join('\n');
  fs.writeFileSync(story, texto);
  const id = FIELD().idOf(fs.readFileSync(story, 'utf8'));
  assert.strictEqual(id, '5284');
  fs.writeFileSync(path.join(m.fixaz, 'estado-5284'), 'Active');
  const c = cli(m, ['work-item', 'close', '--args', JSON.stringify({ repoDir: repo, id, comment: 'cierre', hours: 4.5 })]);
  assert.strictEqual(c.json.ok, true, c.out);
  assert.deepStrictEqual(llamadasAz(m), [
    ['comentario', ['boards', 'work-item', 'update', '--organization', ORG, '--id', '5284', '--discussion', 'cierre', '--output', 'json']],
    ['actualizar', ['boards', 'work-item', 'update', '--organization', ORG, '--id', '5284', '--state', 'Closed', '--fields', 'Microsoft.VSTS.Scheduling.CompletedWork=4.5', '--output', 'json']],
  ]);
  assert.strictEqual(fs.readFileSync(story, 'utf8'), texto, 'cerrar no reescribe el campo de una historia vieja');
});

test('WorkItem_Failures_SaidWithTheirReason @story-8.85 @ac-7 @ac-9 @ac-11', async () => {
  const repo = repoCon('ado-config.yaml', ADO_CONFIG);
  // crear falla en az: un «no» con el motivo, sin pedido
  const m = mundo({ platform: { default: 'azure-devops' } });
  m.env.TYCON_AZ_FAIL = 'crear';
  const a = await P().run('work-item.create', { repoDir: repo, title: 'Story 9.1: Algo', epic: 'riesgos' }, { env: m.env });
  assert.strictEqual(a.ok, false);
  assert.strictEqual(a.reason, 'rechazado');
  assert.match(a.summary, /no se tocó/);
  // la relación con el Epic falla con el pedido ya creado: se crea igual y se dice
  m.env.TYCON_AZ_FAIL = 'relacion';
  const b = await P().run('work-item.create', { repoDir: repo, title: 'Story 9.1: Algo', epic: 'riesgos' }, { env: m.env });
  assert.strictEqual(b.ok, true);
  assert.match(b.value.warnings.join(' '), /no se pudo colgar del Epic 4492/);
  // el cierre con el comentario publicado y el estado rechazado: queda a medias, nunca «no se tocó»
  m.env.TYCON_AZ_FAIL = 'actualizar';
  const c = await P().run('work-item.close', { repoDir: repo, id: 101, comment: 'cierre', hours: 1 }, { env: m.env });
  assert.strictEqual(c.ok, false);
  assert.match(c.summary, /quedó a medias.*comentario ya quedó/);
  // un estado vacío no es un estado: no se inventa a cuál pasar
  delete m.env.TYCON_AZ_FAIL;
  fs.writeFileSync(path.join(m.fixaz, 'estado-55'), 'None');
  const d = await P().run('work-item.update', { repoDir: repo, id: 55 }, { env: m.env });
  assert.strictEqual(d.reason, 'no_medido');
  assert.ok(!llamadasAz(m).some(([p, x]) => p === 'actualizar' && x.includes('55')), 'sin estado no se cambia nada');
  // GitHub: el tope de pedidos no es una credencial que falta; un 401 sí
  const g = mundo({ platform: { default: 'github' }, ghState: { user: 'b', now: '2026-10-22T05:00:00Z', issues: { 'acme/portal': [{ number: 7, state: 'open', title: 'x', labels: [] }] }, fail: { 'PATCH repos/acme/portal/issues/7': { status: 403, message: 'API rate limit exceeded' } } } });
  const gr = repoCon('work-items.yaml', GH_CONFIG);
  const e = await P().run('work-item.close', { repoDir: gr, id: 7, comment: 'cierre', hours: 1 }, { env: g.env });
  assert.strictEqual(e.reason, 'rechazado');
  assert.match(e.summary, /quedó a medias.*tope de pedidos/);
});

test('WorkItem_HostileInput_NeverReachesTheCli @story-8.85 @ac-7 @ac-10', async () => {
  const m = mundo({ platform: { default: 'azure-devops' } });
  // una organización que no es de Azure DevOps no se usa: la sesión de az no va a otro host
  const fuera = repoCon('work-items.yaml', 'org: https://otro-host.example/acme\nproject: P\ntype: Bug\n');
  const a = await P().run('work-item.close', { repoDir: fuera, id: 1 }, { env: m.env });
  assert.strictEqual(a.reason, 'rechazado');
  assert.deepStrictEqual(llamadasAz(m), []);
  // un campo propio con forma de opción se rechaza; un título que empieza con «-» llega como texto
  const repo = repoCon('ado-config.yaml', ADO_CONFIG);
  const b = await P().run('work-item.create', { repoDir: repo, title: 'X', fields: { '--organization': 'otra' } }, { env: m.env });
  assert.strictEqual(b.reason, 'rechazado');
  const c = await P().run('work-item.create', { repoDir: repo, title: '--project otro' }, { env: m.env });
  assert.strictEqual(c.ok, true, JSON.stringify(c));
  assert.ok(llamadasAz(m).some(([p, x]) => p === 'crear' && x[x.indexOf('--title') + 1] === ' --project otro'));
  // GitHub: un repo con «..» no arma otra ruta de la API
  const g = mundo({ platform: { default: 'github' } });
  const d = await P().run('work-item.create', { repoDir: repoCon('work-items.yaml', 'repo: ../..\n'), title: 'X' }, { env: g.env });
  assert.strictEqual(d.reason, 'sin_plataforma');
  // el id que se escribe en la historia es un número, o nada
  const s = path.join(tmp('campo-'), 's.md');
  fs.writeFileSync(s, '---\nstory: "1"\n---\n');
  assert.throws(() => FIELD().write(s, '5\nstatus: done'), /no es un número/);
  assert.strictEqual(fs.readFileSync(s, 'utf8'), '---\nstory: "1"\n---\n');
});

test('WorkItem_Config_UnknownKeysAndBooleans_Said @story-8.85 @ac-10', async () => {
  const C = WCFG();
  const r = C.read(repoCon('work-items.yaml', 'org: acme\nproject: P\ntype: Bug\nauto_assing: True\nauto_assign: yes\n'));
  assert.strictEqual(r.config.auto_assign, true, '«yes» es verdadero, como en YAML');
  assert.deepStrictEqual(r.unknown, ['auto_assing']);
  const m = mundo({ platform: { default: 'azure-devops' } });
  fs.writeFileSync(path.join(m.fixaz, 'estado-3'), 'Active');
  const x = await P().run('work-item.update', { repoDir: repoCon('work-items.yaml', 'org: acme\nstate_active: Active\nauto_assing: true\n'), id: 3 }, { env: m.env });
  assert.match(x.summary, /claves que no conozco: auto_assing/);
});

test('WorkItem_Readers_RunForReal @story-8.85 @ac-8', () => {
  // el aviso al crear una historia, ejecutado: con el nombre viejo o el nuevo ya está ligada; sin ninguno, avisa
  const hook = STORY_HOOK;
  const correr = (campo) => {
    const d = tmp('historia-');
    const f = path.join(d, 'story-9-1.md');
    const content = `---\nstory: "9.1"\nepic: 9\nstatus: ready-for-dev\napproach: "[NEW]"\n${campo}---\n\n# S\n`;
    fs.writeFileSync(f, content);
    return spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: f, content } }), encoding: 'utf8' }).stdout;
  };
  assert.strictEqual(correr('ado_work_item: 5284\n'), '');
  assert.strictEqual(correr('work_item: 12\n'), '');
  assert.match(correr(''), /sin `work_item:`/);
  // la capa dice qué plataforma atiende sin pedirle nada (el Arranque lo pregunta antes de buscar por título)
  const m = mundo({ platform: { workItems: 'github' } });
  const r = cli(m, ['choose', 'work-item', 'update']);
  assert.strictEqual(r.json.value.connector, 'github');
  const t = fs.readFileSync(path.join(STEPS, 'step-01-start.md'), 'utf8');
  assert.ok(t.indexOf('platform.js choose work-item update') > 0 && t.indexOf('platform.js choose work-item update') < t.indexOf('az boards query'), 'la búsqueda por título va después de preguntar la plataforma');
});

test('WorkItem_Calls_AreInTheRecordedPhoto @story-8.85 @ac-7 @ac-9 @ac-27', () => {
  // cada comando que el conector manda está escrito en la foto de comandos az (la cabecera del conector), con sus opciones
  const foto = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'tests', 'fixtures', 'platform-golden', 'az-commands.json'), 'utf8'));
  const lineas = foto['integrations/azure-devops/scripts/work-items.js'] || [];
  for (const [verbo, opciones] of [['create', ['--organization', '--project', '--type', '--title', '--fields', '--output json']], ['relation add', ['--relation-type parent', '--target-id', '--output json']],
    ['show', ['--query fields."System.State"', '--output tsv']], ['update', ['--state', '--discussion', 'CompletedWork', '--output json']]]) {
    const de = lineas.filter((l) => l.includes(`az boards work-item ${verbo} `));
    assert.ok(de.length, `la foto trae az boards work-item ${verbo}`);
    for (const o of opciones) assert.ok(de.some((l) => l.includes(o)), `${verbo}: ${o} en la foto`);
  }
});

test('WorkItem_MalformedHoursAndBooleans_NotSilent @story-8.85 @ac-9 @ac-10', async () => {
  // segundos que no son un entero no cierran «sin horas»: se rechazan
  const m = mundo({ platform: { default: 'azure-devops' } });
  const r = await P().run('work-item.close', { repoDir: repoCon('ado-config.yaml', ADO_CONFIG), id: 101, seconds: '1080' }, { env: m.env });
  assert.strictEqual(r.reason, 'rechazado');
  assert.deepStrictEqual(llamadasAz(m), []);
  // un sí o no entre comillas vale; uno que no se entiende se dice
  const c = WCFG().read(repoCon('work-items.yaml', 'auto_assign: "true"\niteration_auto_from_frontmatter: quizas\n'));
  assert.strictEqual(c.config.auto_assign, true);
  assert.match(c.unknown.join(' '), /iteration_auto_from_frontmatter \(vale «quizas»/);
});

test('Adversarial_WriteField_ListWithoutIndentAndCrlf @story-8.85 @ac-8', () => {
  // una lista de depends_on con los guiones al ras (YAML válido) no se parte; una historia con CRLF no queda con un LF suelto
  const d = tmp('campo-adv-');
  const a = path.join(d, 'a.md');
  fs.writeFileSync(a, '---\nstory: "1"\ndepends_on:\n- 2.1\n- 2.2\nstatus: x\n---\n');
  FIELD().write(a, 55);
  assert.strictEqual(fs.readFileSync(a, 'utf8'), '---\nstory: "1"\ndepends_on:\n- 2.1\n- 2.2\nwork_item: 55\nstatus: x\n---\n');
  const b = path.join(d, 'b.md');
  fs.writeFileSync(b, '---\r\nstory: "1"\r\ndepends_on: []\r\n---\r\n# S\r\n');
  FIELD().write(b, 7);
  assert.strictEqual(fs.readFileSync(b, 'utf8'), '---\r\nstory: "1"\r\ndepends_on: []\r\nwork_item: 7\r\n---\r\n# S\r\n');
});

test('Adversarial_Config_EmptyValueIsEmpty_AndQuotedEscapes @story-8.85 @ac-10', async () => {
  // una clave sin valor (una plantilla a medio llenar) es vacía, nunca un objeto que llegaría como «[object Object]»
  const C = WCFG();
  const r = C.read(repoCon('work-items.yaml', 'org: acme\nproject:\ntype: User Story\narea_path:\nepic_links:\n  a: 1\n'));
  assert.deepStrictEqual(r.config, { org: 'acme', project: '', type: 'User Story', area_path: '', epic_links: { a: 1 } });
  const m = mundo({ platform: { default: 'azure-devops' } });
  const x = await P().run('work-item.create', { repoDir: repoCon('work-items.yaml', 'org: acme\nproject:\ntype: Bug\n'), title: 'X' }, { env: m.env });
  assert.strictEqual(x.reason, 'sin_plataforma');
  assert.ok(!JSON.stringify(llamadasAz(m)).includes('[object Object]'));
  // entre comillas dobles valen los escapes de YAML; entre simples, '' es una comilla
  assert.deepStrictEqual(C.parse('a: "Proyecto\\\\Sprint 1"\nb: \'it\'\'s\'\n'), { a: 'Proyecto\\Sprint 1', b: "it's" });
});

test('Adversarial_Update_AlreadyActiveInBasicAndScrum_NoChange @story-8.85 @ac-9', async () => {
  // un pedido ya activo en Basic («Doing») o en Scrum («Committed») no se manda a «Active»
  const m = mundo({ platform: { default: 'azure-devops' } });
  const repo = repoCon('work-items.yaml', 'org: acme\n');
  for (const [id, est] of [[11, 'Doing'], [12, 'Committed'], [13, 'In Progress']]) {
    fs.writeFileSync(path.join(m.fixaz, `estado-${id}`), est);
    const r = await P().run('work-item.update', { repoDir: repo, id }, { env: m.env });
    assert.strictEqual(r.value.changed, false, `${est}: ${JSON.stringify(r)}`);
  }
  assert.ok(!llamadasAz(m).some(([p]) => p === 'actualizar'));
  // y To Do (Basic) pasa a Doing
  fs.writeFileSync(path.join(m.fixaz, 'estado-14'), 'To Do');
  const t = await P().run('work-item.update', { repoDir: repo, id: 14 }, { env: m.env });
  assert.strictEqual(t.value.estado, 'Doing');
});

test('WorkItem_Update_Closed_PideReabrir @story-8.93 @ac-8', async () => {
  // cerrado sin reopen: pideReabrir, para que el núcleo pida la confirmación, y ningún comando que escriba; activo, no
  const m = mundo({ platform: { default: 'azure-devops' } });
  const repo = repoCon('work-items.yaml', 'org: acme\n');
  fs.writeFileSync(path.join(m.fixaz, 'estado-21'), 'Closed');
  const c = await P().run('work-item.update', { repoDir: repo, id: 21 }, { env: m.env });
  assert.strictEqual(c.value.pideReabrir, true, JSON.stringify(c));
  assert.strictEqual(c.value.changed, false);
  assert.ok(!llamadasAz(m).some(([p]) => p === 'actualizar'), 'no escribió');
  fs.writeFileSync(path.join(m.fixaz, 'estado-22'), 'Active');
  const a = await P().run('work-item.update', { repoDir: repo, id: 22 }, { env: m.env });
  assert.strictEqual(a.value.pideReabrir, undefined, JSON.stringify(a));
  // GitHub: un issue cerrado, lo mismo
  const g = mundo({ platform: { default: 'github' }, ghState: { user: 'arnes-bot', now: '2026-10-22T05:00:00Z', issues: { 'acme/portal': [{ number: 8, state: 'closed', title: 'Story 9.2', labels: ['tipo:Historia', 'estado:hecho'] }] } } });
  const r = cli(g, ['work-item', 'update', '--args', JSON.stringify({ repoDir: repoCon('work-items.yaml', GH_CONFIG), id: 8 })]);
  assert.strictEqual(r.json.value.pideReabrir, true, r.out);
  assert.strictEqual(estadoGh(g).issues['acme/portal'][0].state, 'closed', 'no lo reabrió');
});

// T81 Pedido_Update_SoloComentario_NoCambiaElEstado @story-4.11 @ac-28
// 🔴 Falla con: que `update` con `comment` y sin `state` pase el pedido a activo, pida reabrir uno cerrado, cambie sus
//    etiquetas, no publique el comentario, o lo publique dos veces.
test('T81 Pedido_Update_SoloComentario_NoCambiaElEstado', async () => {
  const m = mundo({ platform: { default: 'azure-devops' } });
  const ops = repoCon(null, null);
  const AVISO = 'Volvió a aparecer: ejecución abortada (RR-CIERRE:abortada), vista el 2026-10-25.';
  for (const [id, est] of [[31, 'New'], [32, 'Closed']]) {
    fs.writeFileSync(path.join(m.fixaz, `estado-${id}`), est);
    const antes = fs.readdirSync(m.fixaz).filter((f) => f.startsWith('estado-')).map((f) => [f, fs.readFileSync(path.join(m.fixaz, f), 'utf8')]);
    const r = await P().run('work-item.update', { repoDir: ops, org: 'acme', project: 'Operaciones', id, comment: AVISO }, { env: m.env });
    const despues = fs.readdirSync(m.fixaz).filter((f) => f.startsWith('estado-')).map((f) => [f, fs.readFileSync(path.join(m.fixaz, f), 'utf8')]);
    assert.deepStrictEqual(despues, antes, `${est}: el estado del pedido, igual antes y después`);
    assert.strictEqual(r.ok, true, `${est}: ${JSON.stringify(r)}`);
    assert.strictEqual(r.value.changed, false, est);
    assert.strictEqual(r.value.commented, true, est);
    assert.strictEqual(r.value.pideReabrir, undefined, `${est}: comentar no pide reabrir`);
  }
  const llamadas = llamadasAz(m);
  assert.ok(!llamadas.some(([p]) => p === 'actualizar'), `ningún cambio de estado: ${JSON.stringify(llamadas)}`);
  assert.deepStrictEqual(llamadas.filter(([p]) => p === 'comentario'), [31, 32].map((id) =>
    ['comentario', ['boards', 'work-item', 'update', '--organization', ORG, '--id', String(id), '--discussion', AVISO, '--output', 'json']]));
  // GitHub: abierto y cerrado, el comentario y nada más
  const g = mundo({ platform: { default: 'github' }, ghState: { user: 'arnes-bot', now: '2026-10-25T05:00:00Z', issues: { 'acme/portal': [
    { number: 9, state: 'open', title: 'Pedido A', labels: ['tipo:Historia', 'estado:nuevo'] },
    { number: 10, state: 'closed', title: 'Pedido B', labels: ['tipo:Historia', 'estado:hecho'] }] } } });
  const repo = repoCon('work-items.yaml', GH_CONFIG);
  const foto = () => estadoGh(g).issues['acme/portal'].map((i) => [i.number, i.state, [...i.labels].sort().join(',')]);
  const antes = foto();
  for (const id of [9, 10]) {
    const r = cli(g, ['work-item', 'update', '--args', JSON.stringify({ repoDir: repo, id, comment: AVISO })]);
    assert.strictEqual(r.json && r.json.ok, true, r.out + r.err);
    assert.strictEqual(r.json.value.commented, true);
  }
  const st = estadoGh(g);
  assert.deepStrictEqual(foto(), antes, 'estado y etiquetas, iguales antes y después');
  assert.deepStrictEqual(antes, [[9, 'open', 'estado:nuevo,tipo:Historia'], [10, 'closed', 'estado:hecho,tipo:Historia']]);
  assert.deepStrictEqual(st.comments['acme/portal#9'].map((x) => x.body), [AVISO]);
  assert.deepStrictEqual(st.comments['acme/portal#10'].map((x) => x.body), [AVISO]);
});

test('Adversarial_Hours_NotANumber_Rejected @story-8.85 @ac-9', async () => {
  // «horas» que no son un número no se escriben como 0 o 1 en CompletedWork
  const m = mundo({ platform: { default: 'azure-devops' } });
  const repo = repoCon('work-items.yaml', 'org: acme\n');
  for (const hours of [' ', true, []]) {
    const r = await P().run('work-item.close', { repoDir: repo, id: 101, hours }, { env: m.env });
    assert.strictEqual(r.reason, 'rechazado', JSON.stringify(hours));
  }
  assert.deepStrictEqual(llamadasAz(m), []);
});

test('Adversarial_StoryCreateHook_EmptyFieldIsNotLinked @story-8.85 @ac-8', () => {
  // un `work_item:` vacío seguido de otra clave no cuenta como ligado: el aviso sale
  const hook = STORY_HOOK;
  for (const campo of ['work_item:', 'ado_work_item: ']) {
    const f = path.join(tmp('historia-vacia-'), 's.md');
    const content = `---\nstory: "9.1"\nepic: 9\nstatus: ready-for-dev\napproach: "[NEW]"\n${campo}\ntitle: x\n---\n`;
    fs.writeFileSync(f, content);
    const out = spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: f, content } }), encoding: 'utf8' }).stdout;
    assert.match(out, /sin `work_item:`/, campo);
  }
});

/**
 * Los archivos del núcleo de `root` que nombran `nombre` (las pruebas lo nombran a propósito; version.json lo regenera la
 * publicación). En el árbol armado de los nocturnos cuenta sólo lo que viaja al público; si del núcleo no viaja nada,
 * no hubo qué medir y lanza.
 */
function filesNaming(root, nombre) {
  const donde = ['--', '.', ':!scripts/tests', ':!version.json'];
  const ih = require(path.join(ROOT, 'scripts', 'publishing', 'internal-history.js'));
  ih.travelling(root, execFileSync('git', ['-C', root, 'ls-files', '-z', ...donde], { encoding: 'utf8' }).split('\0').filter(Boolean), 'el núcleo');
  const r = spawnSync('git', ['-C', root, '-c', 'core.quotePath=false', 'grep', '-l', nombre, ...donde], { encoding: 'utf8' });
  assert.ok(r.status === 0 || r.status === 1, `git grep corrió (${r.status}: ${r.stderr})`);
  return r.stdout.split('\n').filter(Boolean).filter(ih.travels(root)).sort();
}

test('OldSkillName_OnlyWhatTravels — en el árbol armado, el nombre viejo en un archivo sólo del privado no cuenta', (t) => {
  // 🔴 rojo: una página del privado que nombra la skill vieja pone en rojo la prueba del público, o lo traído deja de contar
  const { overlayLab } = require('./lib/overlay-lab.js');
  const lab = overlayLab({ privado: { 'artifacts/mapa.html': 'tycon-ado-story-wi\n' }, publico: { 'scripts/z.js': '// tycon-ado-story-wi\n' } });
  t.after(lab.cleanup);
  assert.deepStrictEqual(filesNaming(lab.root, 'tycon-ado-story-wi'), ['scripts/z.js'], 'sólo cuenta lo que trajo el público');
  lab.git(['checkout', '--quiet', lab.tip]);
  assert.deepStrictEqual(filesNaming(lab.root, 'tycon-ado-story-wi'), ['artifacts/mapa.html'], 'sin superposición, el árbol entero');
  // lo traído son sólo pruebas: del núcleo no viaja nada, y eso no es verde
  const fuera = overlayLab({ privado: { 'artifacts/mapa.html': 'tycon-ado-story-wi\n' }, publico: { 'scripts/tests/t.js': 't\n' } });
  t.after(fuera.cleanup);
  assert.throws(() => filesNaming(fuera.root, 'tycon-ado-story-wi'), /no se midió/, 'sin nada que revisar, rojo');
});

test('SkillAndHook_Renamed_RegisteredOnce @story-8.85 @ac-12', () => {
  const VIEJA = 'tycon-ado-story-wi';
  const NUEVA = 'tycon-story-work-item';
  const SK = path.join(ROOT, 'skills');
  // el gancho vive en la integración de Azure DevOps; la skill vieja queda sólo con su reemplazo, que dice
  // el nombre nuevo y manda a cargarla
  assert.ok(fs.existsSync(STORY_HOOK) && !fs.existsSync(path.join(SK, NUEVA, 'scripts', 'on-story-create.js')), 'el gancho vive en la integración');
  assert.match(fs.readFileSync(path.join(SK, NUEVA, 'SKILL.md'), 'utf8'), /^---\nname: tycon-story-work-item\n/);
  assert.deepStrictEqual(fs.readdirSync(path.join(SK, VIEJA)), ['SKILL.md'], 'la carpeta vieja tiene sólo el reemplazo');
  const reemplazo = fs.readFileSync(path.join(SK, VIEJA, 'SKILL.md'), 'utf8');
  assert.match(reemplazo, /^---\nname: tycon-ado-story-wi\n/, 'el nombre viejo se sigue pudiendo invocar');
  assert.match(reemplazo, /`tycon-story-work-item`/, 'y dice el nombre nuevo');
  // el despachador lanza el gancho por la ruta nueva; «Cómo trabaja», con los ids neutros
  const disp = fs.readFileSync(path.join(SK, 'tycon-pipeline', 'scripts', 'dispatch.js'), 'utf8');
  assert.match(disp, /path\.join\(INTEGRATIONS_DIR, 'azure-devops', 'scripts', 'on-story-create\.js'\)/);
  assert.match(disp, /const INTEGRATIONS_DIR = \[path\.join\(SKILLS_DIR, '\.\.', 'integrations'\), ARNES_DIR && path\.join\(ARNES_DIR, 'integrations'\)\]/);
  const { INTEGRATION_PIECES } = require(path.join(SK, 'tycon-pipeline', 'scripts', 'lib', 'how-it-works.js'));
  const ids = INTEGRATION_PIECES.map((p) => p.id);
  assert.ok(ids.includes('workItemActive') && ids.includes('workItemClose'), ids.join(', '));
  assert.ok(!ids.some((i) => /^ado/.test(i)), ids.join(', '));
  for (const p of INTEGRATION_PIECES.filter((x) => x.id === 'workItemClose' || x.id === 'timeTrackingClose')) assert.match(p.code, /close-work-item\.md$/);
  // un settings.json con el gancho por la ruta vieja, y otro con la ruta ya reescrita a la nueva: pasados por el
  // aplicador de los dos instaladores, el gancho no queda suelto (lo lanza el despachador), sea cual sea el orden
  const lista = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'hooks-list.json'), 'utf8'));
  for (const skill of [VIEJA, NUEVA]) assert.ok(lista.superseded.includes(`${skill}/scripts/on-story-create.js`), `superseded nombra ${skill}`);
  for (const skill of [VIEJA, NUEVA]) {
    const base = tmp('renombre-');
    const skills = path.join(base, 'tcg', 'skills');
    const hooksDir = path.join(base, 'tcg', 'scripts', 'hooks');
    const home = path.join(base, 'home');
    const gancho = path.join(skills, skill, 'scripts', 'on-story-create.js');
    const otro = path.join(skills, 'tycon-pipeline', 'scripts', 'hook-post-edit.js');
    for (const f of [gancho, otro]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '// gancho de juguete\n'); }
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const settingsPath = path.join(home, '.claude', 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: `node "${gancho}"` }] }] } }, null, 2));
    const listPath = path.join(base, 'hooks-list.json');
    fs.writeFileSync(listPath, JSON.stringify({ hooks: [{ event: 'PostToolUse', matcher: 'Edit|Write', spec: 'tycon-pipeline/scripts/hook-post-edit.js', label: 'el registro de ediciones', when: 'always', platforms: { windows: true }, steps: ['all'], effect: 'records' }], superseded: lista.superseded }));
    for (const platform of ['posix', 'windows']) {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'setup', 'apply-hooks.js'), '--settings', settingsPath, '--hooks-dir', hooksDir,
        '--skills', skills, '--list', listPath, '--effects', path.join(ROOT, 'scripts', 'setup', 'install-effects.json'), '--platform', platform],
      { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TYCON_PROFILE: '0', TYCON_NO_NIGHTLY_EXAM: '1' } });
      assert.strictEqual(r.status, 0, `${skill} ${platform}: ${r.stderr}`);
      const cmds = Object.values(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks || {}).flat().flatMap((e) => (e.hooks || []).map((h) => h.command));
      assert.strictEqual(cmds.filter((c) => /on-story-create\.js/.test(c)).length, 0, `${skill} ${platform}: el gancho no queda suelto (${cmds.join(' · ')})`);
      assert.ok(cmds.some((c) => /hook-post-edit\.js/.test(c)), `${skill} ${platform}: el resto de la lista se registra`);
    }
  }
  // en el núcleo, el nombre viejo sólo en el reemplazo, en la skill nueva (que lo cuenta) y en la lista de reemplazados;
  // las pruebas lo nombran a propósito y version.json lo regenera la publicación
  assert.deepStrictEqual(filesNaming(ROOT, VIEJA), ['scripts/setup/hooks-list.json', `skills/${NUEVA}/SKILL.md`, `skills/${VIEJA}/SKILL.md`].sort());
  // el mapa de renombres viaja sólo con el privado: con él debajo, no declara la carpeta vieja (la mudanza del gancho a
  // su integración la mira how-it-works.test.js)
  const mapa = path.join(ROOT, 'scripts', 'lib', 'renames.json');
  if (fs.existsSync(mapa)) {
    const e = JSON.parse(fs.readFileSync(mapa, 'utf8')).entries;
    assert.ok(!e.some((x) => x.kind === 'folder' && x.old === `skills/${VIEJA}`), 'la carpeta vieja sigue existiendo con su reemplazo');
  }
});

test('PlatformWorkItem_MovedHook_StillFindsTheField @story-8.127 @ac-3 — el gancho mudado encuentra el lector del campo y contesta igual', () => {
  // el lector común está donde el gancho lo pide: tres carpetas arriba, scripts/lib/platform/
  const lector = path.join(path.dirname(STORY_HOOK), '..', '..', '..', 'scripts', 'lib', 'platform', 'work-item-field.js');
  assert.ok(fs.existsSync(lector), 'work-item-field.js al alcance del gancho');
  assert.match(fs.readFileSync(STORY_HOOK, 'utf8'), /require\(path\.join\(__dirname, '\.\.', '\.\.', '\.\.', 'scripts', 'lib', 'platform', 'work-item-field\.js'\)\)/);
  // en una carpeta de juguete: ligada con cualquiera de los dos nombres, calla; sin ninguno, avisa con el título
  const correr = (campo) => {
    const f = path.join(tmp('historia-mudada-'), 'story-9-2.md');
    const content = `---\nstory: "9.2"\nepic: 9\nstatus: ready-for-dev\napproach: "[NEW]"\ntitle: "Mudanza"\n${campo}---\n\n# S\n`;
    fs.writeFileSync(f, content);
    const r = spawnSync(process.execPath, [STORY_HOOK], { input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: f, content } }), encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    return r.stdout;
  };
  assert.strictEqual(correr('work_item: 77\n'), '');
  assert.strictEqual(correr('ado_work_item: 78\n'), '');
  const aviso = correr('');
  assert.match(aviso, /sin `work_item:`/);
  assert.match(aviso, /9\.2 — Mudanza/);
  assert.match(aviso, /Skill\(skill="tycon-story-work-item"/, 'sigue mandando a la skill');
});

// T85 Plataforma_SoloComentario_NoInventaElEstado @story-4.11 @ac-28
// 🔴 Falla con: decir «sin cambios (undefined)» del comentario que avisa que la falla volvió: sin estado leído, la línea
//    dice que se comentó y que el estado no se tocó. Un cambio de estado sigue diciendo de cuál a cuál.
test('T85 Plataforma_SoloComentario_NoInventaElEstado @story-4.11 @ac-28', () => {
  const s = P().summary('work-item.update', { ok: true, value: { id: 901, changed: false, commented: true, warnings: [] } }, 'Azure DevOps');
  assert.strictEqual(s, 'pedido de trabajo #901 en Azure DevOps: comentado, sin cambiar el estado');
  assert.doesNotMatch(s, /undefined/);
  assert.match(P().summary('work-item.update', { ok: true, value: { id: 7, changed: true, previo: 'New', estado: 'Active' } }), /#7: New → Active/);
  assert.match(P().summary('work-item.update', { ok: true, value: { id: 7, changed: false, estado: 'Active' } }), /#7: sin cambios \(Active\)/);
});

// Plataforma_BuscarPorEtiqueta_DosConectores @story-4.11 @ac-42
// 🔴 Falla con: buscar sin acotar por proyecto, tomar por propio un pedido cuya etiqueta sólo empieza igual
//    (`arnes:abc-1` no es `arnes:abc`), contar un pull request de GitHub como pedido, leer sólo la primera página, o
//    contestar una lista vacía cuando la búsqueda no se pudo hacer.
test('T92 Plataforma_BuscarPorEtiqueta_DosConectores @story-4.11 @ac-42', async () => {
  const m = mundo({ platform: { default: 'azure-devops' } });
  const repo = repoCon('ado-config.yaml', ADO_CONFIG);
  fs.writeFileSync(path.join(m.fixaz, 'wiql-Producto.json'), JSON.stringify({ workItems: [{ id: 7 }, { id: 8 }, { id: 9 }, { id: 7 }] }));
  fs.writeFileSync(path.join(m.fixaz, 'wi-7.json'), JSON.stringify({ id: 7, fields: { 'System.Tags': 'arnes-hallazgo; arnes:abc' } }));
  fs.writeFileSync(path.join(m.fixaz, 'wi-8.json'), JSON.stringify({ id: 8, fields: { 'System.Tags': 'arnes:abc-1' } }));
  fs.writeFileSync(path.join(m.fixaz, 'wi-9.json'), JSON.stringify({ id: 9, fields: { 'System.Tags': 'ARNES:ABC; otra' } }));
  const r = await P().run('work-item.find', { repoDir: repo, tag: 'arnes:abc' }, { env: m.env });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(r.value.ids, [7, 9]);
  assert.match(r.summary, /2 pedidos? con la etiqueta arnes:abc/);
  const [, wiql, archivos] = llamadasAzConArchivos(m).find(([p]) => p === 'wiql');
  assert.strictEqual(wiql[wiql.indexOf('--route-parameters') + 1], 'project=Producto');
  assert.ok(wiql.includes('--organization') && wiql.includes('--output'), 'con la organización y la salida explícitas');
  assert.match(Object.values(archivos)[0], /\[System\.TeamProject\] = @project AND \[System\.Tags\] CONTAINS 'arnes:abc'/);
  // el proyecto de la noche gana sobre el del repo
  await P().run('work-item.find', { repoDir: repo, tag: 'arnes:abc', org: 'acme', project: 'Otro' }, { env: m.env });
  const otra = llamadasAz(m).filter(([p]) => p === 'wiql')[1][1];
  assert.strictEqual(otra[otra.indexOf('--route-parameters') + 1], 'project=Otro');
  // caída la consulta o la relectura de una etiqueta: no_medido, nunca una lista vacía
  for (const falla of ['wiql', 'wi']) {
    const caida = await P().run('work-item.find', { repoDir: repo, tag: 'arnes:abc' }, { env: { ...m.env, TYCON_AZ_FAIL: falla } });
    assert.strictEqual(caida.ok, false, falla);
    assert.strictEqual(caida.reason, 'no_medido', falla);
    assert.ok(!('value' in caida), falla);
  }
  // una etiqueta que no es segura para la consulta no llega a az
  const antes = llamadasAz(m).length;
  for (const tag of ["arnes:x' OR 1=1", '', undefined]) {
    const mal = await P().run('work-item.find', { repoDir: repo, tag }, { env: m.env });
    assert.strictEqual(mal.reason, 'rechazado', String(tag));
  }
  assert.strictEqual(llamadasAz(m).length, antes);

  // GitHub: todas las páginas, la etiqueta exacta y sin pull requests
  const issues = [];
  for (let n = 1; n <= 101; n++) issues.push({ number: n, state: n % 2 ? 'open' : 'closed', title: `x${n}`, labels: ['arnes:abc'] });
  issues.push({ number: 102, state: 'open', title: 'pr', labels: ['arnes:abc'], pull_request: { url: 'https://api.github.com/repos/acme/portal/pulls/102' } });
  issues.push({ number: 103, state: 'open', title: 'otra', labels: ['arnes:abc-1'] });
  // GitHub no distingue mayúsculas en las etiquetas: el issue que quedó con «ARNES:ABC» es el mismo pedido
  issues.push({ number: 104, state: 'open', title: 'mayúsculas', labels: ['ARNES:ABC'] });
  const g = mundo({ platform: { default: 'github' }, ghState: { user: 'arnes-bot', now: '2026-10-25T05:00:00Z', issues: { 'acme/portal': issues } } });
  const gr = repoCon('work-items.yaml', GH_CONFIG);
  const x = await P().run('work-item.find', { repoDir: gr, tag: 'arnes:abc' }, { env: g.env });
  assert.strictEqual(x.ok, true, JSON.stringify(x));
  assert.deepStrictEqual(x.value.ids, [...Array.from({ length: 101 }, (_, i) => i + 1), 104]);
  const st = estadoGh(g);
  st.fail = { 'GET repos/acme/portal/issues': { status: 500, message: 'caída' } };
  fs.writeFileSync(g.ghFile, JSON.stringify(st));
  const gc = await P().run('work-item.find', { repoDir: gr, tag: 'arnes:abc' }, { env: g.env });
  assert.strictEqual(gc.reason, 'no_medido');
});

// Plataforma_LeerEstado_DosConectores @story-4.11 @ac-29
// 🔴 Falla con: decidir «cerrado» por el nombre del estado (Resolved no es cerrado; Done y Closed sí, por su categoría),
//    leer las categorías de otro proyecto o de otro tipo, o contestar «abierto» cuando la lectura no se pudo hacer.
test('T93 Plataforma_LeerEstado_DosConectores @story-4.11 @ac-29', async () => {
  const m = mundo({ platform: { default: 'azure-devops' } });
  const repo = repoCon('ado-config.yaml', ADO_CONFIG);
  const wi = (id, estado, tipo = 'Bug', proyecto = 'Producto') => fs.writeFileSync(path.join(m.fixaz, `wi-${id}.json`),
    JSON.stringify({ id, fields: { 'System.State': estado, 'System.WorkItemType': tipo, 'System.TeamProject': proyecto } }));
  fs.writeFileSync(path.join(m.fixaz, 'estados-Producto-Bug.json'), JSON.stringify({ value: [
    { name: 'New', category: 'Proposed' }, { name: 'Active', category: 'InProgress' }, { name: 'Resolved', category: 'Resolved' },
    { name: 'Closed', category: 'Completed' }, { name: 'Removed', category: 'Removed' }] }));
  fs.writeFileSync(path.join(m.fixaz, 'estados-Ops-Task.json'), JSON.stringify({ value: [{ name: 'To Do', category: 'Proposed' }, { name: 'Done', category: 'Completed' }] }));
  wi(7, 'Closed'); wi(8, 'Resolved'); wi(9, 'Removed'); wi(10, 'Active'); wi(11, 'Done', 'Task', 'Ops');
  const leer = (id, env = m.env) => P().run('work-item.read', { repoDir: repo, id }, { env });
  for (const [id, estado, cerrado] of [[7, 'Closed', true], [8, 'Resolved', false], [9, 'Removed', true], [10, 'Active', false], [11, 'Done', true]]) {
    const r = await leer(id);
    assert.strictEqual(r.ok, true, `${id}: ${JSON.stringify(r)}`);
    assert.deepStrictEqual({ id: r.value.id, estado: r.value.estado, cerrado: r.value.cerrado }, { id, estado, cerrado }, String(id));
    assert.match(r.summary, new RegExp(`#${id}.*${cerrado ? 'cerrado' : 'abierto'}`));
  }
  // las categorías son las del proyecto y el tipo del pedido
  const estados = llamadasAz(m).filter(([p]) => p === 'estados').map(([, a]) => `${a[a.indexOf('--route-parameters') + 1]} ${a[a.indexOf('--route-parameters') + 2]}`);
  assert.ok(estados.includes('project=Ops type=Task'), estados.join(' · '));
  // el que no existe es no_encontrado; las categorías caídas, no_medido; un id que no es un número no llega a az
  assert.strictEqual((await leer(12)).reason, 'no_encontrado');
  const caida = await leer(7, { ...m.env, TYCON_AZ_FAIL: 'estados' });
  assert.strictEqual(caida.reason, 'no_medido');
  assert.strictEqual((await leer(7, { ...m.env, TYCON_AZ_FAIL: 'wi' })).ok, false);
  assert.strictEqual((await leer('7; rm')).reason, 'rechazado');

  // GitHub: cerrado es state: closed; el borrado y el que no está, no_encontrado
  const g = mundo({ platform: { default: 'github' }, ghState: { user: 'arnes-bot', now: '2026-10-25T05:00:00Z', gone: ['acme/portal#7'],
    issues: { 'acme/portal': [{ number: 5, state: 'closed', state_reason: 'completed', title: 'a', labels: ['estado:hecho'] }, { number: 6, state: 'open', title: 'b', labels: [] }] } } });
  const gr = repoCon('work-items.yaml', GH_CONFIG);
  const g5 = await P().run('work-item.read', { repoDir: gr, id: 5 }, { env: g.env });
  assert.deepStrictEqual({ id: g5.value.id, cerrado: g5.value.cerrado }, { id: 5, cerrado: true });
  const g6 = await P().run('work-item.read', { repoDir: gr, id: 6 }, { env: g.env });
  assert.strictEqual(g6.value.cerrado, false);
  for (const id of [7, 99]) assert.strictEqual((await P().run('work-item.read', { repoDir: gr, id }, { env: g.env })).reason, 'no_encontrado', String(id));
});

// Azure_DescripcionPorArchivo_NoLeeArchivosLocales @story-4.11 @ac-42
// 🔴 Falla con: mandar la descripción o los criterios en la línea de comandos: az lee como archivo un valor que empieza
//    con «@», y el pedido saldría con el contenido de un archivo de la máquina en vez del texto.
test('T95 Azure_DescripcionPorArchivo_NoLeeArchivosLocales @story-4.11 @ac-42', async () => {
  const m = mundo({ platform: { default: 'azure-devops' } });
  const repo = repoCon('ado-config.yaml', ADO_CONFIG);
  const secreto = path.join(tmp('secreto-'), 'llave.txt');
  fs.writeFileSync(secreto, 'CONTENIDO-QUE-NO-DEBE-VIAJAR');
  const r = await P().run('work-item.create', { repoDir: repo, title: 'Algo', description: `@${secreto}`, acceptance: `@${secreto}` }, { env: m.env });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const [, args, archivos] = llamadasAzConArchivos(m).find(([p]) => p === 'crear');
  assert.deepStrictEqual(Object.values(archivos), [`@${secreto}`, `@${secreto}`], 'el texto llega tal cual, por archivo');
  assert.ok(!JSON.stringify(archivos).includes('CONTENIDO-QUE-NO-DEBE-VIAJAR'));
  assert.ok(!args.some((a) => a.includes(`=@${secreto}`)), 'la ruta del archivo de la máquina no va en la línea');
  // los archivos del texto no quedan en el disco
  for (const f of Object.keys(archivos)) assert.ok(!fs.existsSync(f), `${f} se borró`);
});

// T95b Azure_CampoConGuid_SeAcepta @story-4.11 @ac-42
// 🔴 Falla con: rechazar un campo que la configuración acepta, como el nombre de referencia que Azure DevOps arma con un
//    GUID (guiones después del punto): el Bug de dependencias no se crearía nunca con esa configuración.
test('T95b Azure_CampoConGuid_SeAcepta @story-4.11 @ac-42', async () => {
  const OPS = require(path.join(ROOT, 'scripts', 'lib', 'operations-config.js'));
  const campo = 'Custom.00000000-0ca3-4efd-8feb-000000000042';
  assert.ok(OPS.workItemFieldOk(campo, 'Seguridad'), 'la configuración lo acepta');
  const m = mundo({ platform: { default: 'azure-devops' } });
  const repo = repoCon('ado-config.yaml', ADO_CONFIG);
  const r = await P().run('work-item.create', { repoDir: repo, title: 'Riesgo', fields: { [campo]: 'Seguridad', 'Custom.Probabilidad': 3 } }, { env: m.env });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const [, args] = llamadasAz(m).find(([q]) => q === 'crear');
  assert.ok(args.includes(`${campo}=Seguridad`), JSON.stringify(args));
  // con forma de opción sigue sin pasar
  const b = await P().run('work-item.create', { repoDir: repo, title: 'X', fields: { '-Custom.x': 'y' } }, { env: m.env });
  assert.strictEqual(b.reason, 'rechazado');
});
