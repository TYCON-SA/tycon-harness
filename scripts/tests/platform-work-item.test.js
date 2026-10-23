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
  // los pasos de la skill de creación (5 y 6), comando por comando: el campo vacío (la iteración) no se manda
  assert.deepStrictEqual(llamadasAz(m), [
    ['crear', ['boards', 'work-item', 'create', '--organization', ORG, '--project', 'Producto', '--type', 'User Story', '--title', 'Story 9.1: Algo',
      '--fields', 'System.Description=<p>d</p>', 'Microsoft.VSTS.Common.AcceptanceCriteria=<p>a</p>', 'Microsoft.VSTS.Common.Priority=2', 'System.AreaPath=Producto', 'System.Tags=tycon',
      '--output', 'json']],
    ['relacion', ['boards', 'work-item', 'relation', 'add', '--organization', ORG, '--id', '101', '--relation-type', 'parent', '--target-id', '4492', '--output', 'json']],
  ]);
  // una épica sin mapeo: se crea suelta y se dice
  const s = await P().run('work-item.create', { repoDir: repo, title: 'Story 9.2: Otra', epic: 'sin-mapeo' }, { env: m.env });
  assert.strictEqual(s.ok, true);
  assert.match(s.value.warnings.join(' '), /sin-mapeo.*suelt|suelt.*sin-mapeo/);
  assert.strictEqual(llamadasAz(m).filter(([p]) => p === 'relacion').length, 1, 'sin mapeo no hay relación');
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
  const hook = fs.readFileSync(path.join(ROOT, 'skills', 'tycon-story-work-item', 'scripts', 'on-story-create.js'), 'utf8');
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
  const hook = path.join(ROOT, 'skills', 'tycon-story-work-item', 'scripts', 'on-story-create.js');
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
  const hook = path.join(ROOT, 'skills', 'tycon-story-work-item', 'scripts', 'on-story-create.js');
  for (const campo of ['work_item:', 'ado_work_item: ']) {
    const f = path.join(tmp('historia-vacia-'), 's.md');
    const content = `---\nstory: "9.1"\nepic: 9\nstatus: ready-for-dev\napproach: "[NEW]"\n${campo}\ntitle: x\n---\n`;
    fs.writeFileSync(f, content);
    const out = spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: f, content } }), encoding: 'utf8' }).stdout;
    assert.match(out, /sin `work_item:`/, campo);
  }
});

test('SkillAndHook_Renamed_RegisteredOnce @story-8.85 @ac-12', () => {
  const VIEJA = 'tycon-ado-story-wi';
  const NUEVA = 'tycon-story-work-item';
  const SK = path.join(ROOT, 'skills');
  // la skill nueva trae el gancho; la vieja queda sólo con su reemplazo, que dice el nombre nuevo y manda a cargarla
  assert.ok(fs.existsSync(path.join(SK, NUEVA, 'scripts', 'on-story-create.js')), 'el gancho vive en la skill nueva');
  assert.match(fs.readFileSync(path.join(SK, NUEVA, 'SKILL.md'), 'utf8'), /^---\nname: tycon-story-work-item\n/);
  assert.deepStrictEqual(fs.readdirSync(path.join(SK, VIEJA)), ['SKILL.md'], 'la carpeta vieja tiene sólo el reemplazo');
  const reemplazo = fs.readFileSync(path.join(SK, VIEJA, 'SKILL.md'), 'utf8');
  assert.match(reemplazo, /^---\nname: tycon-ado-story-wi\n/, 'el nombre viejo se sigue pudiendo invocar');
  assert.match(reemplazo, /`tycon-story-work-item`/, 'y dice el nombre nuevo');
  // el despachador lanza el gancho por la ruta nueva; «Cómo trabaja», con los ids neutros
  const disp = fs.readFileSync(path.join(SK, 'tycon-pipeline', 'scripts', 'dispatch.js'), 'utf8');
  assert.match(disp, /path\.join\(SKILLS_DIR, 'tycon-story-work-item', 'scripts', 'on-story-create\.js'\)/);
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
  const conViejo = execFileSync('git', ['-C', ROOT, 'grep', '-l', VIEJA, '--', '.', ':!scripts/tests', ':!version.json'], { encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepStrictEqual(conViejo, ['scripts/setup/hooks-list.json', `skills/${NUEVA}/SKILL.md`, `skills/${VIEJA}/SKILL.md`].sort());
  // el mapa de renombres viaja sólo con el privado: con él debajo, trae la entrada del gancho y no declara la carpeta
  const mapa = path.join(ROOT, 'scripts', 'lib', 'renames.json');
  if (fs.existsSync(mapa)) {
    const e = JSON.parse(fs.readFileSync(mapa, 'utf8')).entries;
    assert.ok(e.some((x) => x.kind === 'file' && x.old === `skills/${VIEJA}/scripts/on-story-create.js` && x.new === `skills/${NUEVA}/scripts/on-story-create.js` && x.repo === 'agent-skills'));
    assert.ok(!e.some((x) => x.kind === 'folder' && x.old === `skills/${VIEJA}`), 'la carpeta vieja sigue existiendo con su reemplazo');
  }
});
