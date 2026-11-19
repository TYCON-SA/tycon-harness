'use strict';
/**
 * El inventario de adopción del portón de CI (scripts/nightly/gate-adoption/gate-adoption.js): qué repos tienen el
 * portón exigido, cuáles no y cuáles no se pudieron medir. Azure DevOps y GitHub son servidores locales que contestan
 * como su API (scripts/tests/lib/fake-ado-api.js y fake-github-api.js, en su modo de varios repos). Sin red.
 * No medido no es «sin portón»: una API que no contesta nunca se cuenta como un repo sin portón.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const GUION = path.join(ROOT, 'scripts', 'nightly', 'gate-adoption', 'gate-adoption.js');
const ga = require(GUION);
const { arrancarAdoFalso, politicaDeCompilacion } = require('./lib/fake-ado-api.js');
const { arrancarGithubFalso } = require('./lib/fake-github-api.js');

const TOKEN = 'token-de-prueba';
const YAML_CON = 'steps:\n  - script: node "$GATE" --repo . --base origin/main\n    env:\n      GATE: tcg/scripts/ci/tycon-ci-gate.js\n';
const YAML_SIN = 'steps:\n  - script: npm test\n';
const YAML_ESCAPE = `${YAML_CON}    continueOnError: true\n`;
const YAML_COMENTARIO = `${YAML_CON}  # antes iba con || true, ya no\n`;
const FLUJO = (extra = '') => `name: stories-gate\non:\n  pull_request:\njobs:\n  gate:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node tcg/scripts/ci/tycon-ci-gate.js --repo . --base origin/main\n${extra}`;
const REGLA = (ctx) => [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: ctx }] } }];

async function conAdo(t, repos, extra = {}) {
  const a = await arrancarAdoFalso({ org: 'acme', project: 'Proy', token: TOKEN });
  t.after(() => a.cerrar());
  Object.assign(a.st, { repos, ...extra });
  return a;
}
async function conGithub(t, repos, extra = {}) {
  const g = await arrancarGithubFalso({ owner: 'acme', token: TOKEN });
  t.after(() => g.cerrar());
  Object.assign(g.st, { repos, ...extra });
  return g;
}
const env = (o = {}) => { const e = { ...process.env, AZURE_DEVOPS_EXT_PAT: TOKEN, GH_TOKEN: TOKEN, ...o }; delete e.GITHUB_TOKEN; return e; };
function correr(args, extraEnv) {
  return new Promise((resolve) => {
    execFile(process.execPath, [GUION, ...args], { encoding: 'utf8', env: env(extraEnv) }, (err, stdout, stderr) => resolve({ status: err ? err.code : 0, stdout, stderr }));
  });
}
const conPat = (fn) => { const antes = process.env.AZURE_DEVOPS_EXT_PAT; const antesGh = process.env.GH_TOKEN; process.env.AZURE_DEVOPS_EXT_PAT = TOKEN; process.env.GH_TOKEN = TOKEN; return fn().finally(() => { if (antes === undefined) delete process.env.AZURE_DEVOPS_EXT_PAT; else process.env.AZURE_DEVOPS_EXT_PAT = antes; if (antesGh === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = antesGh; }); };
const estados = (res) => Object.fromEntries(res.repos.map((r) => [r.nombre.split('/').pop(), r.estado]));
const repoAz = (name, o = {}) => ({ name, id: `id-${name}`, defaultBranch: 'refs/heads/main', archivos: {}, definiciones: [], politicas: [], ...o });

test('T6 Adoption_FourStates_Azure — requerido, pipeline sin política, sin portón y no medido @ac-4 @ac-5', (t) => conPat(async () => {
  const a = await conAdo(t, [
    repoAz('con-politica', { archivos: { 'ci.yml': YAML_CON }, definiciones: [{ id: 11, name: 'gate', yaml: '/ci.yml' }], politicas: [politicaDeCompilacion('id-con-politica', 11)] }),
    repoAz('sin-politica', { archivos: { 'ci.yml': YAML_CON }, definiciones: [{ id: 12, name: 'gate', yaml: 'ci.yml' }] }),
    repoAz('sin-porton', { archivos: { 'ci.yml': YAML_SIN }, definiciones: [{ id: 13, name: 'ci', yaml: 'ci.yml' }] }),
    repoAz('politica-caida', { archivos: { 'ci.yml': YAML_CON }, definiciones: [{ id: 14, name: 'gate', yaml: 'ci.yml' }], politicas500: true }),
  ]);
  const res = await ga.medirAzure({ org: `${a.base}/acme`, projects: ['Proy'], branch: 'main' });
  assert.ok(res.listaCompleta);
  assert.deepStrictEqual(estados(res), { 'con-politica': 'requerido', 'sin-politica': 'pipeline-sin-política', 'sin-porton': 'sin-portón', 'politica-caida': 'no-medido' });
  assert.match(res.repos.find((r) => r.nombre.endsWith('/politica-caida')).motivo, /500/);
  // una política apagada o que no bloquea no exige
  a.st.repos[0].politicas = [politicaDeCompilacion('id-con-politica', 11, { isBlocking: false })];
  const otra = await ga.medirAzure({ org: `${a.base}/acme`, projects: ['Proy'], branch: 'main' });
  assert.strictEqual(estados(otra)['con-politica'], 'pipeline-sin-política');
  // la credencial va por la cabecera, nunca en la ruta
  assert.ok(a.llamadas.every((l) => !l.ruta.includes(TOKEN) && !JSON.stringify(l.query).includes(TOKEN)));
}));

test('T7 Adoption_FourStates_GitHub — los mismos estados, con el control requerido en las reglas o en la protección @ac-4 @ac-5', (t) => conPat(async () => {
  const g = await conGithub(t, [
    { name: 'con-regla', flujos: { 'stories-gate.yml': FLUJO() }, reglas: REGLA('gate') },
    { name: 'con-proteccion', flujos: { 'stories-gate.yml': FLUJO() }, proteccion: { required_status_checks: { contexts: [], checks: [{ context: 'gate' }] } } },
    { name: 'sin-politica', flujos: { 'stories-gate.yml': FLUJO() } },
    { name: 'sin-porton', flujos: { 'ci.yml': 'jobs:\n  test:\n    steps:\n      - run: npm test\n' } },
    { name: 'sin-flujos' },
    { name: 'proteccion-sin-permiso', flujos: { 'stories-gate.yml': FLUJO() }, proteccion403: true },
  ]);
  const res = await ga.medirGithub({ org: 'acme', branch: 'main', api: g.base });
  assert.ok(res.listaCompleta);
  assert.deepStrictEqual(estados(res), {
    'con-regla': 'requerido', 'con-proteccion': 'requerido', 'sin-politica': 'pipeline-sin-política',
    'sin-porton': 'sin-portón', 'sin-flujos': 'sin-portón', 'proteccion-sin-permiso': 'no-medido',
  });
  assert.match(res.repos.find((r) => r.nombre === 'proteccion-sin-permiso').motivo, /administrador/);
  // el control requerido tiene que ser el trabajo del flujo que nombra el portón, no cualquiera
  g.st.repos[0].reglas = REGLA('build');
  assert.strictEqual(estados(await ga.medirGithub({ org: 'acme', branch: 'main', api: g.base }))['con-regla'], 'pipeline-sin-política');
}));

test('T8 Adoption_ApiDown_NeverWithoutGate — la lista caída o incompleta da «?» y sale 1; un repo ilegible es no medido @ac-5 @ac-17', (t) => conPat(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-adoption-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'linea.txt');
  // (1) la lista de repos contesta 500
  const a = await conAdo(t, [repoAz('uno')], { fallarListaRepos: 500 });
  let r = await correr(['azure', '--org', `${a.base}/acme`, '--project', 'Proy', '--out', out]);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(fs.readFileSync(out, 'utf8').trim(), 'Portón de CI (repos): ?');
  // (2) la segunda página contesta 500 (Azure y GitHub)
  a.st.fallarListaRepos = null; a.st.repos = [repoAz('uno'), repoAz('dos'), repoAz('tres')]; a.st.reposPorPagina = 2; a.st.fallarPaginaRepos = 2;
  r = await correr(['azure', '--org', `${a.base}/acme`, '--project', 'Proy', '--out', out]);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(fs.readFileSync(out, 'utf8').trim(), 'Portón de CI (repos): ?');
  const g = await conGithub(t, [{ name: 'a' }, { name: 'b' }, { name: 'c' }], { reposPorPagina: 2, fallarPaginaRepos: 2 });
  r = await correr(['github', '--org', 'acme', '--out', out], { TYCON_GITHUB_API: g.base });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(fs.readFileSync(out, 'utf8').trim(), 'Portón de CI (repos): ?');
  // las páginas que sí contestan se recorren todas
  g.st.fallarPaginaRepos = null;
  r = await correr(['github', '--org', 'acme', '--out', out], { TYCON_GITHUB_API: g.base });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(fs.readFileSync(out, 'utf8'), /sin portón 3/);
  // (3) con la lista entera: un 403 en las políticas y un YAML ilegible
  a.st.reposPorPagina = null; a.st.fallarPaginaRepos = null;
  a.st.repos = [
    repoAz('politicas-403', { archivos: { 'ci.yml': YAML_CON }, definiciones: [{ id: 21, name: 'gate', yaml: 'ci.yml' }], politicas403: true }),
    repoAz('yaml-ilegible', { definiciones: [{ id: 22, name: 'gate', yaml: 'ci.yml' }], fallarArchivo: 500 }),
    repoAz('sano', { archivos: { 'ci.yml': YAML_SIN }, definiciones: [{ id: 23, name: 'ci', yaml: 'ci.yml' }] }),
  ];
  r = await correr(['azure', '--org', `${a.base}/acme`, '--project', 'Proy', '--out', out]);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(fs.readFileSync(out, 'utf8').trim(), 'Portón de CI (repos): requerido 0 · con escape 0 · pipeline sin política 0 · sin portón 1 · no aplica 0 · no medido 2');
  assert.match(r.stdout, /politicas-403: no-medido/);
  assert.match(r.stdout, /yaml-ilegible: no-medido/);
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(TOKEN), 'la credencial no sale nunca');
  // (4) GitHub sin credencial: la API listaría sólo los repos públicos, así que la lista no se mide y no se pregunta nada
  const pedidosAntes = g.llamadas.length;
  r = await correr(['github', '--org', 'acme', '--out', out], { TYCON_GITHUB_API: g.base, GH_TOKEN: '' });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.strictEqual(fs.readFileSync(out, 'utf8').trim(), 'Portón de CI (repos): ?');
  assert.match(r.stdout, /GH_TOKEN/);
  assert.strictEqual(g.llamadas.length, pedidosAntes, 'sin credencial no se le pide nada a la API');
  // (5) Azure sin credencial: lo mismo
  r = await correr(['azure', '--org', `${a.base}/acme`, '--project', 'Proy', '--out', out], { AZURE_DEVOPS_EXT_PAT: '' });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.strictEqual(fs.readFileSync(out, 'utf8').trim(), 'Portón de CI (repos): ?');
  assert.match(r.stdout, /AZURE_DEVOPS_EXT_PAT/);
}));

test('T9 Adoption_LineHasOnlyNumbers — la línea del resumen sólo trae números @ac-4', () => {
  const repos = ['requerido', 'requerido-con-escape', 'pipeline-sin-política', 'sin-portón', 'no-aplica', 'no-medido', 'sin-portón']
    .map((estado, i) => ({ nombre: `acme-repo-${i}`, estado }));
  const l = ga.linea({ listaCompleta: true, repos });
  assert.strictEqual(l, 'Portón de CI (repos): requerido 1 · con escape 1 · pipeline sin política 1 · sin portón 2 · no aplica 1 · no medido 1');
  assert.doesNotMatch(l, /acme/);
  assert.strictEqual(ga.linea({ listaCompleta: false, repos }), 'Portón de CI (repos): ?');
  const fuente = fs.readFileSync(GUION, 'utf8');
  assert.match(fuente, /`requerido` no prueba que el portón corra/, 'la cabecera dice lo que `requerido` no prueba');
});

test('T10 Nightly_StepWiredToSummary — el paso nocturno sólo con sus parámetros, naranja y con su línea al resumen @ac-6', () => {
  const y = fs.readFileSync(path.join(ROOT, 'pipelines', 'operations', 'production-watch.yml'), 'utf8');
  for (const p of ['gateAdoptionAzureProjects', 'gateAdoptionGithubOrg']) assert.match(y, new RegExp(`- name: ${p}\\n(?:.*\\n){0,2}\\s+type: string\\n\\s+default: ''`), `parámetro ${p} vacío por defecto`);
  const on = "or(ne(parameters.gateAdoptionAzureProjects, ''), ne(parameters.gateAdoptionGithubOrg, ''))";
  const paso = y.slice(y.indexOf(`\${{ if ${on} }}:`));
  assert.ok(y.includes(`\${{ if ${on} }}:`), 'el paso corre sólo con parámetros');
  const bloque = paso.slice(0, paso.indexOf('displayName') + 400);
  assert.match(bloque, /node scripts\/nightly\/gate-adoption\/gate-adoption\.js/);
  assert.match(bloque, /OUT="\$\(Agent\.TempDirectory\)\/gate-adoption\.txt"/);
  assert.match(bloque, /--out "\$OUT\.azure"/);
  assert.match(bloque, /--out "\$OUT\.github"/);
  assert.match(bloque, /continueOnError: true/);
  assert.match(y, /GATE_ADOPTION_ON: \$\{\{ or\(ne\(parameters\.gateAdoptionAzureProjects, ''\), ne\(parameters\.gateAdoptionGithubOrg, ''\)\) \}\}/);
  assert.match(y, /\[ -s "\$GATE_TXT" \] \|\| echo "Portón de CI \(repos\): \?" > "\$GATE_TXT"/, 'sin línea del paso, el resumen dice «?»');
  assert.match(y, /EX\+=\(--extra "\$GATE_TXT"\)/);
});

test('T28 Adoption_NotApplicableAndEscape — repos vacíos o archivados, el escape y el comentario que no cuenta @ac-4', (t) => conPat(async () => {
  const a = await conAdo(t, [
    repoAz('vacio', { size: 0, defaultBranch: undefined }),
    repoAz('apagado', { isDisabled: true }),
    repoAz('escape', { archivos: { 'ci.yml': YAML_ESCAPE }, definiciones: [{ id: 31, name: 'gate', yaml: 'ci.yml' }], politicas: [politicaDeCompilacion('id-escape', 31)] }),
    repoAz('comentario', { archivos: { 'ci.yml': YAML_COMENTARIO }, definiciones: [{ id: 32, name: 'gate', yaml: 'ci.yml' }], politicas: [politicaDeCompilacion('id-comentario', 32)] }),
  ]);
  const az = await ga.medirAzure({ org: `${a.base}/acme`, projects: ['Proy'], branch: 'main' });
  assert.deepStrictEqual(estados(az), { vacio: 'no-aplica', apagado: 'no-aplica', escape: 'requerido-con-escape', comentario: 'requerido' });
  const g = await conGithub(t, [
    { name: 'archivado', archived: true, flujos: { 'g.yml': FLUJO() }, reglas: REGLA('gate') },
    { name: 'vacio', size: 0, sinRama: true },
    { name: 'escape', flujos: { 'g.yml': FLUJO('        continue-on-error: true\n') }, reglas: REGLA('gate') },
    { name: 'comentario', flujos: { 'g.yml': FLUJO('      # || true\n') }, reglas: REGLA('gate') },
  ]);
  const gh = await ga.medirGithub({ org: 'acme', branch: 'main', api: g.base });
  assert.deepStrictEqual(estados(gh), { archivado: 'no-aplica', vacio: 'no-aplica', escape: 'requerido-con-escape', comentario: 'requerido' });
  assert.strictEqual(ga.linea(gh), 'Portón de CI (repos): requerido 1 · con escape 1 · pipeline sin política 0 · sin portón 0 · no aplica 2 · no medido 0');
  // `|| true` fuera de un comentario sí cuenta
  assert.strictEqual(ga.tieneEscape('  - run: node tycon-ci-gate.js || true\n'), true);
  assert.strictEqual(ga.tieneEscape('  # node tycon-ci-gate.js || true\n'), false);
}));

test('T28 Adoption_QuotedEscapeAndHashInQuotes — el escape entre comillas cuenta y un # dentro de comillas no corta la línea @ac-4', () => {
  assert.strictEqual(ga.tieneEscape("    continue-on-error: 'true'\n"), true);
  assert.strictEqual(ga.tieneEscape('    continueOnError: "true"\n'), true);
  assert.strictEqual(ga.nombraElPorton('  - run: echo "paso #1" && node tcg/scripts/ci/tycon-ci-gate.js --repo .\n'), true);
  assert.strictEqual(ga.nombraElPorton("  - script: echo 'uno #dos' # node tcg/scripts/ci/tycon-ci-gate.js\n"), false, 'después de las comillas sí es comentario');
});

test('T7 Adoption_GitHub_JobsAnyIndentMatrixAndReusable — el control requerido se reconoce con cualquier sangría, con matriz y desde un flujo reutilizable @ac-4', (t) => conPat(async () => {
  const CUATRO = 'name: stories-gate\non:\n    pull_request:\njobs:\n    gate:\n        runs-on: ubuntu-latest\n        steps:\n            - run: node tcg/scripts/ci/tycon-ci-gate.js --repo . --base origin/main\n';
  const REUTILIZABLE = 'on:\n  workflow_call:\njobs:\n  gate:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node tcg/scripts/ci/tycon-ci-gate.js --repo .\n';
  const LLAMA = 'on:\n  pull_request:\njobs:\n  llamar:\n    uses: ./.github/workflows/gate.yml\n';
  // el `name:` del flujo y el de un paso no son nombres de trabajo
  const NOMBRE_DE_FLUJO = 'name: gate\non:\n  pull_request:\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - name: gate\n        run: node tcg/scripts/ci/tycon-ci-gate.js --repo .\n';
  const g = await conGithub(t, [
    { name: 'cuatro-espacios', flujos: { 'stories-gate.yml': CUATRO }, reglas: REGLA('gate') },
    { name: 'con-matriz', flujos: { 'stories-gate.yml': FLUJO() }, reglas: REGLA('gate (ubuntu-latest)') },
    { name: 'reutilizable', flujos: { 'gate.yml': REUTILIZABLE, 'pr.yml': LLAMA }, reglas: REGLA('llamar / gate') },
    { name: 'nombre-de-flujo', flujos: { 'ci.yml': NOMBRE_DE_FLUJO }, reglas: REGLA('gate') },
  ]);
  const res = await ga.medirGithub({ org: 'acme', api: g.base });
  assert.deepStrictEqual(estados(res), { 'cuatro-espacios': 'requerido', 'con-matriz': 'requerido', reutilizable: 'requerido', 'nombre-de-flujo': 'pipeline-sin-política' });
  // si no se puede saber el nombre del trabajo (`jobs:` en forma de flujo, un nombre armado por expresión), no se sabe
  // si la rama lo exige: no medido, nunca «pipeline sin política»
  const EN_LINEA = 'on: pull_request\njobs: { gate: { runs-on: ubuntu-latest, steps: [ { run: "node tcg/scripts/ci/tycon-ci-gate.js" } ] } }\n';
  const EXPRESION = 'on: pull_request\njobs:\n  gate:\n    name: ${{ github.event_name }} gate\n    steps:\n      - run: node tcg/scripts/ci/tycon-ci-gate.js\n';
  const g2 = await conGithub(t, [
    { name: 'en-linea', flujos: { 'g.yml': EN_LINEA }, reglas: REGLA('gate') },
    { name: 'expresion', flujos: { 'g.yml': EXPRESION }, reglas: REGLA('pull_request gate') },
  ]);
  const res2 = await ga.medirGithub({ org: 'acme', api: g2.base });
  assert.deepStrictEqual(estados(res2), { 'en-linea': 'no-medido', expresion: 'no-medido' });
  assert.match(res2.repos[0].motivo, /nombre del trabajo/);
  // un trabajo cuyo `name:` difiere de su clave: el control requerido es el nombre
  const NOMBRADO = 'on: pull_request\njobs:\n  gate:\n    name: Portón de CI\n    steps:\n      - run: node tcg/scripts/ci/tycon-ci-gate.js\n';
  const g3 = await conGithub(t, [{ name: 'nombrado', flujos: { 'g.yml': NOMBRADO }, reglas: REGLA('Portón de CI') }]);
  assert.strictEqual(estados(await ga.medirGithub({ org: 'acme', api: g3.base })).nombrado, 'requerido');
}));

test('T6 Adoption_ScopeOfAnotherRepoOrBranch — un alcance de otro repo, o de rama principal sobre otra rama, no exige @ac-4', (t) => conPat(async () => {
  const conPolitica = (id, def, scope) => ({ isEnabled: true, isBlocking: true, type: { id: 'tipo-compilacion' }, settings: { buildDefinitionId: def, scope: [{ repositoryId: id, ...scope }] } });
  const a = await conAdo(t, [
    repoAz('otro-repo', { archivos: { 'ci.yml': YAML_CON }, definiciones: [{ id: 51, name: 'gate', yaml: 'ci.yml' }], politicas: [conPolitica('id-de-otro', 51, { refName: 'refs/heads/main', matchKind: 'Exact' })] }),
    repoAz('principal-en-otra', { ramas: ['refs/heads/main', 'refs/heads/release'], archivos: { 'ci.yml': YAML_CON }, definiciones: [{ id: 52, name: 'gate', yaml: 'ci.yml' }], politicas: [conPolitica('id-principal-en-otra', 52, { refName: null, matchKind: 'DefaultBranch' })] }),
  ]);
  assert.strictEqual(estados(await ga.medirAzure({ org: `${a.base}/acme`, projects: ['Proy'] }))['otro-repo'], 'pipeline-sin-política');
  assert.strictEqual(estados(await ga.medirAzure({ org: `${a.base}/acme`, projects: ['Proy'], branch: 'release' }))['principal-en-otra'], 'pipeline-sin-política');
}));

test('T9 Adoption_JoinOnePlatformAndUsage — con una sola plataforma la línea es la suya; mal usado sale 2 @ac-4', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-adoption-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const az = path.join(dir, 'az'); const out = path.join(dir, 'out');
  const l = 'Portón de CI (repos): requerido 2 · con escape 0 · pipeline sin política 1 · sin portón 0 · no aplica 1 · no medido 0';
  fs.writeFileSync(az, `${l}\n`);
  const juntar = (...args) => require('child_process').spawnSync(process.execPath, [GUION, 'juntar', ...args], { encoding: 'utf8' });
  assert.strictEqual(juntar('--out', out, az).status, 0);
  assert.strictEqual(fs.readFileSync(out, 'utf8').trim(), l);
  assert.strictEqual(juntar('--out', out).status, 2, 'sin ninguna línea es mal uso');
  assert.strictEqual(juntar(az).status, 2, 'sin --out es mal uso');
});

test('T6 Adoption_DefaultBranchAndScopes — sin --branch se mide la rama principal de cada repo; una rama pedida que no existe es no-aplica; los alcances de prefijo y de rama principal exigen @ac-4', (t) => conPat(async () => {
  const conPolitica = (id, def, scope) => ({ isEnabled: true, isBlocking: true, type: { id: 'tipo-compilacion' }, settings: { buildDefinitionId: def, scope: [{ repositoryId: id, ...scope }] } });
  const a = await conAdo(t, [
    repoAz('en-master', { defaultBranch: 'refs/heads/master', archivos: { 'ci.yml': YAML_CON }, definiciones: [{ id: 41, name: 'gate', yaml: 'ci.yml' }], politicas: [conPolitica('id-en-master', 41, { refName: 'refs/heads/master', matchKind: 'Exact' })] }),
    repoAz('prefijo', { archivos: { 'ci.yml': YAML_CON }, definiciones: [{ id: 42, name: 'gate', yaml: 'ci.yml' }], politicas: [conPolitica('id-prefijo', 42, { refName: 'refs/heads/', matchKind: 'Prefix' })] }),
    repoAz('principal', { archivos: { 'ci.yml': YAML_CON }, definiciones: [{ id: 43, name: 'gate', yaml: 'ci.yml' }], politicas: [conPolitica('id-principal', 43, { refName: null, matchKind: 'DefaultBranch' })] }),
  ]);
  const az = await ga.medirAzure({ org: `${a.base}/acme`, projects: ['Proy'] });
  assert.deepStrictEqual(estados(az), { 'en-master': 'requerido', prefijo: 'requerido', principal: 'requerido' });
  // con --branch main pedido a mano, el repo que no tiene main no es «pipeline sin política»: no aplica
  const conMain = await ga.medirAzure({ org: `${a.base}/acme`, projects: ['Proy'], branch: 'main' });
  assert.strictEqual(estados(conMain)['en-master'], 'no-aplica');
  assert.match(conMain.repos.find((r) => r.nombre.endsWith('/en-master')).motivo, /sin rama main/);
  // GitHub: la rama principal del repo, sin --branch
  const g = await conGithub(t, [{ name: 'en-master', default_branch: 'master', flujos: { 'stories-gate.yml': FLUJO() }, reglas: REGLA('gate') }]);
  assert.strictEqual(estados(await ga.medirGithub({ org: 'acme', api: g.base }))['en-master'], 'requerido');
  // el nocturno no fija la rama: mide la principal de cada repo
  assert.strictEqual(ga.parseArgs(['github', '--org', 'acme']).branch, undefined);
}));

test('T8 Adoption_BodyCutIsNotMeasured — una respuesta cortada a la mitad deja ese repo no medido y no tira el guion @ac-5', (t) => conPat(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-adoption-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'linea.txt');
  const g = await conGithub(t, [{ name: 'cortado', flujos: { 'g.yml': FLUJO() }, cortarCuerpo: true }, { name: 'sano', flujos: { 'ci.yml': 'jobs:\n  t:\n    steps:\n      - run: npm test\n' } }]);
  const r = await correr(['github', '--org', 'acme', '--out', out], { TYCON_GITHUB_API: g.base });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /cortado: no-medido/);
  assert.match(r.stdout, /sano: sin-portón/);
  assert.strictEqual(fs.readFileSync(out, 'utf8').trim(), 'Portón de CI (repos): requerido 0 · con escape 0 · pipeline sin política 0 · sin portón 1 · no aplica 0 · no medido 1');
}));

test('T9 Adoption_JoinPlatforms — con Azure y GitHub la línea suma las dos; si a una le falta su línea, sale «?» @ac-4 @ac-5', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-adoption-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const az = path.join(dir, 'az'); const gh = path.join(dir, 'gh'); const out = path.join(dir, 'out');
  fs.writeFileSync(az, 'Portón de CI (repos): requerido 2 · con escape 0 · pipeline sin política 1 · sin portón 0 · no aplica 1 · no medido 0\n');
  fs.writeFileSync(gh, 'Portón de CI (repos): requerido 1 · con escape 1 · pipeline sin política 0 · sin portón 3 · no aplica 0 · no medido 2\n');
  const juntar = (...args) => require('child_process').spawnSync(process.execPath, [GUION, 'juntar', '--out', out, ...args], { encoding: 'utf8' });
  let r = juntar(az, gh);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(fs.readFileSync(out, 'utf8').trim(), 'Portón de CI (repos): requerido 3 · con escape 1 · pipeline sin política 1 · sin portón 3 · no aplica 1 · no medido 2');
  r = juntar(az, path.join(dir, 'no-existe'));
  assert.strictEqual(r.status, 1);
  assert.strictEqual(fs.readFileSync(out, 'utf8').trim(), 'Portón de CI (repos): ?', 'una plataforma sin su línea no se cuenta como cero');
  fs.writeFileSync(gh, 'Portón de CI (repos): ?\n');
  r = juntar(az, gh);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(fs.readFileSync(out, 'utf8').trim(), 'Portón de CI (repos): ?');
});

test('T10 Nightly_LineReachesSummary — la línea del inventario y su «?» llegan tal cual al resumen diario @ac-6', (t) => {
  const { seccionExtra } = require(path.join(ROOT, 'scripts', 'nightly', 'dependencies', 'daily-summary.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-adoption-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'gate.txt');
  const l = 'Portón de CI (repos): requerido 3 · con escape 0 · pipeline sin política 1 · sin portón 2 · no aplica 1 · no medido 0';
  fs.writeFileSync(f, `${l}\n`);
  assert.strictEqual(seccionExtra(f, 1), l);
  fs.writeFileSync(f, 'Portón de CI (repos): ?\n');
  assert.strictEqual(seccionExtra(f, 1), 'Portón de CI (repos): ?');
  // una línea que empieza como la del portón y no tiene su forma sale con «?», sin su texto
  fs.writeFileSync(f, 'Portón de CI (repos): acme-secreto 3\n');
  assert.strictEqual(seccionExtra(f, 1), 'Portón de CI (repos): ?');
  // el paso nocturno junta las plataformas en una sola línea
  const y = fs.readFileSync(path.join(ROOT, 'pipelines', 'operations', 'production-watch.yml'), 'utf8');
  assert.match(y, /gate-adoption\.js juntar --out "\$OUT"/);
});
