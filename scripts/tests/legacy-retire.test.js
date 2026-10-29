'use strict';

/**
 * legacy-retire.test.js — los archivos de deuda de los productos con su nombre nuevo, y lo que un producto nombra
 * con nombre viejo. T2, T3 y T6; la comparación con el mapa del equipo vive en el privado (legacy-retire-map.test.js).
 *
 * Lo que no se puede perder:
 *   · El archivo de un producto con su nombre viejo se lee igual que con el nuevo, desde el arnés completo y
 *     desde el artefacto `arnes-ci`, que es sólo `scripts/ci` (T3).
 *   · Con el nombre nuevo y el viejo de contenido distinto, cada lector dice «no puedo» y nombra los dos: elegir uno en
 *     silencio cambiaría qué deuda ampara a quién (T2).
 *   · Los mensajes y las guías nombran sólo el nombre nuevo (T2).
 *
 * Los nombres viejos salen de los pares de `scripts/ci/legacy-files.js` en tiempo de ejecución: escritos acá, el
 * termómetro de nombres en castellano los contaría.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const HELPER = path.join(RAIZ, 'scripts', 'ci', 'legacy-files.js');
const VULN = 'pending-vulnerabilities.json';
const TESTS = 'pending-tests.json';

const lab = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `retire-${name}-`));
const write = (dir, rel, body) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body); };
const viejo = (nu) => require(HELPER).PAIRS[nu];

/** El artefacto `arnes-ci` como lo arma el pipeline de un producto: sólo `scripts/ci`, copiado entero. */
function artifact() {
  const dir = lab('arnes-ci');
  fs.cpSync(path.join(RAIZ, 'scripts', 'ci'), dir, { recursive: true });
  return dir;
}
function cleanEnv(extra) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TYCON_') && k !== 'TF_BUILD') e[k] = v;
  return { ...e, HOME: lab('home'), ...extra };
}

test('T3 RetireA_CiArtifactReadsBothWithoutLib — el lector de scripts/ci solo, sin biblioteca ni mapa, lee los dos nombres', () => {
  const ci = artifact();
  assert.ok(!fs.existsSync(path.join(ci, '..', 'lib', 'legacy-names.js')), 'el artefacto no trae la biblioteca');
  const probe = `
    const lf = require(${JSON.stringify(path.join(ci, 'legacy-files.js'))});
    const repo = process.argv[1];
    try { const r = lf.resolveDebtFile(repo, ${JSON.stringify(VULN)}, 'scripts/ci/audit-dependencies.js'); process.stdout.write(JSON.stringify({ name: r.name, exists: r.exists })); }
    catch (e) { process.stdout.write(JSON.stringify({ error: e.name, message: e.message })); }`;
  const run = (repo) => {
    const r = spawnSync(process.execPath, ['-e', probe, repo], { encoding: 'utf8', env: cleanEnv({ TF_BUILD: 'True' }) });
    return { out: JSON.parse(r.stdout || '{}'), err: r.stderr };
  };
  const old = viejo(VULN);
  assert.ok(old && old !== VULN, 'el par del archivo de vulnerabilidades está declarado');

  const soloViejo = lab('viejo'); write(soloViejo, old, '{"revision":"2099-01-01","paquetes":[]}');
  const a = run(soloViejo);
  assert.deepStrictEqual(a.out, { name: old, exists: true }, 'con sólo el viejo se lee el viejo');
  assert.match(a.err, /##vso\[task\.logissue type=warning\]nombre viejo/, 'en la corrida queda el aviso del nombre viejo');

  const soloNuevo = lab('nuevo'); write(soloNuevo, VULN, '{}');
  assert.deepStrictEqual(run(soloNuevo).out, { name: VULN, exists: true });

  const ninguno = lab('ninguno');
  assert.deepStrictEqual(run(ninguno).out, { name: VULN, exists: false }, 'sin ninguno: el nuevo, que no existe');

  const iguales = lab('iguales'); write(iguales, VULN, '{"a":1}'); write(iguales, old, '{"a":1}');
  assert.deepStrictEqual(run(iguales).out, { name: VULN, exists: true }, 'los dos iguales: el nuevo');

  const distintos = lab('distintos'); write(distintos, VULN, '{"a":1}'); write(distintos, old, '{"a":2}');
  const d = run(distintos).out;
  assert.strictEqual(d.error, 'LegacyFilesError');
  assert.ok(d.message.includes(VULN) && d.message.includes(old), `el error nombra los dos: ${d.message}`);
});

test('T3 RetireA_CiArtifactReadsBothWithoutLib — una revisión de git con el nombre viejo se lee igual', () => {
  const lf = require(HELPER);
  const old = viejo(TESTS);
  // `show` devuelve el texto, null si no está, o lanza si no pudo mirar
  const show = (files) => (rel) => (rel in files ? files[rel] : null);
  assert.deepStrictEqual(lf.readDebtAtRevision(show({ [old]: 'v' }), TESTS, 'x'), { name: old, text: 'v' });
  assert.deepStrictEqual(lf.readDebtAtRevision(show({ [TESTS]: 'n' }), TESTS, 'x'), { name: TESTS, text: 'n' });
  assert.strictEqual(lf.readDebtAtRevision(show({}), TESTS, 'x'), null, 'sin ninguno: null');
  assert.deepStrictEqual(lf.readDebtAtRevision(show({ [TESTS]: 'n', [old]: 'n' }), TESTS, 'x'), { name: TESTS, text: 'n' });
  assert.throws(() => lf.readDebtAtRevision(show({ [TESTS]: 'n', [old]: 'v' }), TESTS, 'x'), (e) => e.name === 'LegacyFilesError' && e.message.includes(old));
  const rota = () => { throw new Error('objeto corrupto'); };
  assert.throws(() => lf.readDebtAtRevision(rota, TESTS, 'x'), (e) => e.name === 'LegacyFilesError' && /no pude/.test(e.message), 'un git que falla no es «no está en la base»');
});

test('T3 RetireA_CiArtifactReadsBothWithoutLib — el uso del nombre de antes se anota con el nombre solo, aunque la ruta traiga carpetas', () => {
  const FORMS = 'pending-form-vulnerabilities.json';
  const old = viejo(FORMS);
  const home = lab('home-uso'); fs.mkdirSync(path.join(home, '.tycon', 'state'), { recursive: true });
  const repo = lab('uso'); write(repo, old, '{}'); fs.mkdirSync(path.join(repo, 'form-a'));
  const probe = `require(${JSON.stringify(HELPER)}).resolveDebtFile(process.argv[1], '../${FORMS}', 'scripts/ci/audit-dependencies.js')`;
  const r = spawnSync(process.execPath, ['-e', probe, path.join(repo, 'form-a')], { encoding: 'utf8', env: cleanEnv({ HOME: home, TYCON_GUIDES_DIR: RAIZ }) });
  assert.strictEqual(r.status, 0, r.stderr);
  const reg = path.join(home, '.tycon', 'state', 'legacy-names.jsonl');
  const lines = fs.existsSync(reg) ? fs.readFileSync(reg, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  assert.deepStrictEqual(lines.map((l) => [l.old, l.new]), [[old, FORMS]], 'el nombre solo, como en el mapa');
  const ci = spawnSync(process.execPath, ['-e', probe.replace(JSON.stringify(HELPER), JSON.stringify(path.join(artifact(), 'legacy-files.js'))), path.join(repo, 'form-a')],
    { encoding: 'utf8', env: cleanEnv({ HOME: lab('home-ci'), TF_BUILD: 'True' }) });
  assert.match(ci.stderr, new RegExp(`nombre viejo «${old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}»`), 'en la corrida, también el nombre solo');
});

test('T2 RetireA_DebtFilesReadBothNames — audit-dependencies lee la deuda con cualquiera de los dos nombres y frena con los dos distintos', () => {
  const { leerDeclaracion } = require(path.join(RAIZ, 'scripts', 'ci', 'audit-dependencies.js'));
  const old = viejo(VULN);
  const body = JSON.stringify({ revision: '2099-01-01', paquetes: [{ paquete: 'lodash', advisories: ['GHSA-x'], motivo: 'm' }] });
  for (const [nombre, rel] of [['nuevo', VULN], ['viejo', old]]) {
    const repo = lab(`audit-${nombre}`); write(repo, rel, body);
    const d = leerDeclaracion(repo, null, '2026-10-29');
    assert.strictEqual(d.existe, true, `con el ${nombre}: existe`);
    assert.strictEqual(d.archivo, rel, `con el ${nombre}: dice qué archivo leyó`);
    assert.ok(d.paquetes.lodash, `con el ${nombre}: ampara lo declarado`);
  }
  const repo = lab('audit-dos'); write(repo, VULN, body); write(repo, old, '{"revision":"2099-01-01","paquetes":[]}');
  const d = leerDeclaracion(repo, null, '2026-10-29');
  assert.strictEqual(d.ilegible, true, 'los dos distintos: no ampara a nadie');
  assert.ok(d.error.includes(VULN) && d.error.includes(old), `nombra los dos: ${d.error}`);
});

test('T2 RetireA_DebtFilesReadBothNames — la deuda de los formularios por --declared ../<archivo>: el nombre nuevo o el de antes, y los dos distintos frenan', () => {
  const { leerDeclaracion } = require(path.join(RAIZ, 'scripts', 'ci', 'audit-dependencies.js'));
  const FORMS = 'pending-form-vulnerabilities.json';
  const old = viejo(FORMS);
  assert.ok(old && old !== FORMS, 'el par del archivo de formularios está declarado');
  const body = JSON.stringify({ revision: '2099-01-01', paquetes: [{ paquete: 'lodash', advisories: ['GHSA-x'], motivo: 'm' }] });
  for (const [nombre, rel] of [['nuevo', FORMS], ['viejo', old]]) {
    const repo = lab(`forms-${nombre}`); write(repo, rel, body);
    const form = path.join(repo, 'form-a'); fs.mkdirSync(form);
    const d = leerDeclaracion(form, `../${FORMS}`, '2026-10-29');
    assert.strictEqual(d.existe, true, `con el ${nombre}: existe`);
    assert.strictEqual(d.archivo, `../${rel}`, `con el ${nombre}: dice qué archivo leyó`);
    assert.ok(d.paquetes.lodash, `con el ${nombre}: ampara lo declarado`);
  }
  const repo = lab('forms-dos'); write(repo, FORMS, body); write(repo, old, '{"revision":"2099-01-01","paquetes":[]}');
  const form = path.join(repo, 'form-a'); fs.mkdirSync(form);
  const d = leerDeclaracion(form, `../${FORMS}`, '2026-10-29');
  assert.strictEqual(d.conflicto, true, 'los dos distintos: no pude medir');
  const otro = lab('forms-otro'); write(otro, 'mi-deuda.json', body);
  assert.strictEqual(leerDeclaracion(otro, 'mi-deuda.json', '2026-10-29').archivo, 'mi-deuda.json', 'un nombre sin par se lee tal cual');
});

test('T2 RetireA_DebtFilesReadBothNames — affected-forms compara la deuda de pruebas aunque cambie de nombre entre la base y hoy', () => {
  const { deltaDeDeuda } = require(path.join(RAIZ, 'scripts', 'ci', 'affected-forms.js'));
  const old = viejo(TESTS);
  const repo = lab('afectados');
  // fecha fija y sin mantenimiento automático: el commit de laboratorio da lo mismo en cualquier máquina
  const env = { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  const decl = (forms) => JSON.stringify({ sin_pruebas: forms.map((f) => ({ formulario: f, motivo: 'm' })), con_pruebas_en_rojo: [] });
  write(repo, old, decl(['a', 'b'])); git('add', '-A'); git('commit', '-qm', 'base');
  fs.rmSync(path.join(repo, old)); write(repo, TESTS, decl(['a', 'c']));
  assert.deepStrictEqual(deltaDeDeuda(repo, 'HEAD'), { forms: ['b', 'c'] }, 'el renombre solo no afecta: cuentan los formularios que cambiaron');
  write(repo, old, decl(['z']));
  const dos = deltaDeDeuda(repo, 'HEAD');
  assert.strictEqual(dos.todos, true, 'los dos distintos hoy: TODOS, el lado seguro');
  assert.ok(dos.motivo.includes(TESTS) && dos.motivo.includes(old), `lo dice: ${dos.motivo}`);
});

test('T6 RetireA_ProductReportFindsEveryOldName — lista cada clase con archivo y línea, salvo homónimo e historia; 0, 1 y 2', () => {
  const LIB = path.join(RAIZ, 'scripts', 'lib', 'legacy-names.js');
  const dir = lab('producto');
  const oldDebt = viejo(TESTS);
  const map = {
    retire_after: '2026-11-17',
    entries: [
      { kind: 'file', old: 'scripts/ci/viejo-c.sh', new: 'scripts/ci/new-c.sh', batch: 'L' },
      { kind: 'option', old: 'kind-old', new: 'kind', where: 'scripts/ci/audit-dependencies.js', batch: 'L' },
      { kind: 'value', old: 'formulario-v', new: 'form', option: 'kind', where: 'scripts/ci/release-notes.sh', batch: 'L' },
      { kind: 'config-file', old: oldDebt, new: TESTS, batch: 'L' },
      { kind: 'file', old: 'scripts/ci/otro-viejo.js', new: 'scripts/ci/other.js', batch: 'L', homonyms: [{ glob: 'README.md', reason: 'el producto tiene su propio otro-viejo.js' }] },
    ],
  };
  write(dir, 'map.json', JSON.stringify(map));
  const repo = path.join(dir, 'repo');
  write(repo, 'azure-pipelines.yml', [
    'steps:',
    '  - script: bash $(arnes)/scripts/ci/viejo-c.sh',
    '  - script: node audit-dependencies.js --kind-old npm',
    '  - script: bash release-notes.sh --kind formulario-v',
    '  - script: bash viejo-c.sh --only',
  ].join('\n'));
  write(repo, '.githooks/pre-commit', 'node ~/.claude/tycon-harness/scripts/ci/viejo-c.sh\n');
  write(repo, 'CLAUDE.md', 'Ver scripts/ci/viejo-c.sh antes de commitear.\n');
  write(repo, 'README.md', 'Corré scripts/ci/otro-viejo.js (el nuestro).\n');
  write(repo, 'specs/story-1.md', 'Historia: scripts/ci/viejo-c.sh\n');
  write(repo, 'tasks/todo.md', 'scripts/ci/viejo-c.sh\n');
  write(repo, oldDebt, '{}');
  const rep = (r) => spawnSync(process.execPath, [LIB, '--product-report', r, '--json', '--map', path.join(dir, 'map.json')], { encoding: 'utf8', env: cleanEnv() });

  const r = rep(repo);
  assert.strictEqual(r.status, 1, r.stderr);
  const got = JSON.parse(r.stdout).findings.map((f) => `${f.file}:${f.line}:${f.old}`).sort();
  assert.deepStrictEqual(got, [
    `${oldDebt}:0:${oldDebt}`,
    '.githooks/pre-commit:1:scripts/ci/viejo-c.sh',
    'CLAUDE.md:1:scripts/ci/viejo-c.sh',
    'azure-pipelines.yml:2:scripts/ci/viejo-c.sh',
    'azure-pipelines.yml:3:kind-old',
    'azure-pipelines.yml:4:formulario-v',
    'azure-pipelines.yml:5:scripts/ci/viejo-c.sh',
  ].sort(), 'cada clase con archivo y línea; ni el homónimo del README ni la historia');

  // un archivo de deuda con su nombre de antes en una subcarpeta (el de un formulario), una variable y una clave
  const mas = { ...map, entries: [...map.entries,
    { kind: 'env', old: 'TYCON_LEGACY_X', new: 'TYCON_NEW_X', batch: 'L' },
    { kind: 'key', old: 'servidores-v', new: 'servers', where: '.tycon/production.json', batch: 'L' }] };
  write(dir, 'map2.json', JSON.stringify(mas));
  const sub = path.join(dir, 'sub');
  write(sub, `formA/${oldDebt}`, '{}');
  write(sub, 'azure-pipelines.yml', 'variables:\n  TYCON_LEGACY_X: srv\n');
  write(sub, '.tycon/production.json', '{ "servidores-v": [] }\n');
  write(sub, 'otro.json', '{ "servidores-v": 1 }\n');
  const r2 = spawnSync(process.execPath, [LIB, '--product-report', sub, '--json', '--map', path.join(dir, 'map2.json')], { encoding: 'utf8', env: cleanEnv() });
  assert.strictEqual(r2.status, 1, r2.stderr);
  assert.deepStrictEqual(JSON.parse(r2.stdout).findings.map((f) => `${f.file}:${f.line}:${f.old}`).sort(), [
    '.tycon/production.json:1:servidores-v', 'azure-pipelines.yml:2:TYCON_LEGACY_X', `formA/${oldDebt}:0:${oldDebt}`,
  ].sort(), 'la de la subcarpeta, la variable y la clave sólo en su archivo');

  // una carpeta que no se deja leer es «no pude leer» (2), nunca «no nombra nada»; los lockfiles no se leen
  const cerrado = path.join(dir, 'cerrado');
  write(cerrado, 'azure-pipelines.yml', 'steps: []\n');
  write(cerrado, 'package-lock.json', `{"x": "${'a'.repeat(2 * 1024 * 1024)}"}`);
  write(cerrado, 'privada/nota.md', 'scripts/ci/viejo-c.sh\n');
  fs.chmodSync(path.join(cerrado, 'privada'), 0o000);
  try {
    const rc = spawnSync(process.execPath, [LIB, '--product-report', cerrado, '--map', path.join(dir, 'map.json')], { encoding: 'utf8', env: cleanEnv() });
    if (process.getuid && process.getuid() !== 0) {
      assert.strictEqual(rc.status, 2, 'una subcarpeta ilegible: no pude leer');
      assert.match(rc.stderr, /privada/);
    }
  } finally { fs.chmodSync(path.join(cerrado, 'privada'), 0o755); }
  assert.strictEqual(spawnSync(process.execPath, [LIB, '--product-report', cerrado, '--map', path.join(dir, 'map.json')], { encoding: 'utf8', env: cleanEnv() }).status, 1,
    'legible: encuentra la mención, y el lockfile grande no frena');

  const limpio = path.join(dir, 'limpio'); write(limpio, 'azure-pipelines.yml', 'steps:\n  - script: bash $(arnes)/scripts/ci/new-c.sh\n');
  assert.strictEqual(rep(limpio).status, 0, 'nada viejo: 0');
  assert.strictEqual(rep(path.join(dir, 'no-existe')).status, 2, 'no pudo leer: 2');
});

test('T2 RetireA_DebtFilesReadBothNames — los mensajes y las guías nombran sólo el nombre nuevo', () => {
  const { PAIRS } = require(HELPER);
  const viejos = Object.values(PAIRS);
  const archivos = [
    'scripts/ci/audit-dependencies.js', 'scripts/ci/affected-forms.js', 'scripts/ci/check-trigger-without-docs.js',
    'scripts/nightly/dependencies/nightly-dependencies.js', 'scripts/nightly/dependencies/work-items.js',
    'scripts/nightly/dependencies/github-issues.js', 'scripts/site/texts.js',
    'INDEX.md', 'guides/piezas-del-arnes.md', 'guides/maintaining/piezas-en-detalle.md', 'pipelines/operations/github/README.md',
  ];
  for (const rel of archivos) {
    const abs = path.join(RAIZ, rel);
    if (!fs.existsSync(abs)) continue;
    const txt = fs.readFileSync(abs, 'utf8');
    for (const v of viejos) assert.ok(!txt.includes(v), `${rel} todavía nombra ${v}`);
  }
});
