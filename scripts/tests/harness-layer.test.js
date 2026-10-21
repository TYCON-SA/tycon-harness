'use strict';
/**
 * harness-layer.test.js — la capa privada: CALCULAR el complemento (T3).
 *
 * Una máquina del equipo instala la copia pública y apila encima lo privado. Qué es «lo privado» no lo dice
 * ninguna lista: lo calcula la máquina comparando el commit interno con el público, ruta por ruta, por el hash de git
 * de cada archivo (`git ls-tree -r`), sin escribir nada. Lo que no se puede perder:
 *   · una ruta que está en el interno y no en el público es `add`, en su misma ruta (también bajo skills/ y packs/);
 *   · una con otro contenido es `overwrite` SÓLO si el version.json publicado la declara en `transformed`; si no, es
 *     «capa de otra versión» (exit 1 nombrándola): no hay forma de distinguir un ajuste del exportador de un cambio;
 *   · una con otro contenido que está en «el público manda» (`.gitignore`, el despachador de hooks) es `same`;
 *   · lo que está sólo en el público se acepta si está en «sólo afuera» (LICENSE, version.json); si no, es un hallazgo.
 *     «Sólo afuera» suma, sin tocar la lista a mano, lo que la lista blanca del commit interno dice que el exportador
 *     agrega sólo a la copia (`synthetic`, `generated`, `skillRenames`);
 *   · un version.json sin `transformed` no deja calcular (exit 1, con el motivo);
 *   · un archivo NUEVO que el interno publica (en una carpeta pública) y la copia no trae también es «capa de otra
 *     versión»: qué publica el interno lo dice el exportador de juguete con su lista de rutas que
 *     deja afuera (`publishableBy`); la línea de comandos usa la clasificación del exportador de verdad, con la lista
 *     blanca de juguete que el interno trae (fixtures/layer-lab-allowlist.json);
 *   · mismos commits → misma lista, byte a byte.
 * En Node a propósito: corre igual en el agente Windows.
 *
 * Laboratorio: repos de juguete en un temporal (git de verdad) y el exportador de juguete (fixtures/toy-exporter.js).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const LAYER_FILE = path.join(ROOT, 'scripts', 'setup', 'harness', 'layer.js');
const { exportToy, publishableBy } = require('./fixtures/toy-exporter.js');
const FIXTURES = path.join(__dirname, 'fixtures');

const LAB = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-t3-'));
test.after(() => { try { fs.rmSync(LAB, { recursive: true, force: true }); } catch (_) { /* nada */ } });

const GIT_ENV = (() => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  return Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'lab', GIT_AUTHOR_EMAIL: 'lab@example.invalid', GIT_COMMITTER_NAME: 'lab', GIT_COMMITTER_EMAIL: 'lab@example.invalid',
  });
})();
function git(dir, args) {
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', '-c', 'core.hooksPath=/dev/null', '-C', dir, ...args], { env: GIT_ENV, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function write(dir, rel, text, mode) {
  const file = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mode) fs.chmodSync(file, mode);
}
function layerCli(args) {
  const r = spawnSync(process.execPath, [LAYER_FILE, ...args], { encoding: 'utf8', env: GIT_ENV });
  return { rc: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function requireLayer() {
  assert.ok(fs.existsSync(LAYER_FILE), 'no existe scripts/setup/harness/layer.js');
  const L = require(LAYER_FILE);
  for (const f of ['computeLayer', 'serializeList', 'applyLayer', 'verifyLayer']) assert.strictEqual(typeof L[f], 'function', `layer.js no exporta ${f}`);
  return L;
}

// El interno unido de juguete: agents/, skills/ y packs/ en la raíz; lo privado mezclado con lo público.
const INTERNAL = path.join(LAB, 'interno');
fs.mkdirSync(INTERNAL);
git(INTERNAL, ['init', '-q']);
write(INTERNAL, '.gitignore', 'node_modules/\n# los artefactos de los revisores no viajan\n**/.advisors/*\n!**/.advisors/dod-runtime/\n.codegraph/\n');
write(INTERNAL, '.githooks/pre-commit', '#!/usr/bin/env bash\necho despachador\n', 0o755);
write(INTERNAL, '.githooks/pre-commit-harness', '#!/usr/bin/env bash\necho arnes\n', 0o755);
write(INTERNAL, '.githooks/pre-commit-skills', '#!/usr/bin/env bash\necho skills\n', 0o755);
write(INTERNAL, 'README.md', '# arnés de juguete\n');
write(INTERNAL, 'agents/revisor.md', 'un revisor público\n');
write(INTERNAL, 'skills/publica/SKILL.md', 'una skill pública\n');
write(INTERNAL, 'skills/projects/producto/SKILL.md', 'la skill de un producto (privada)\n');
write(INTERNAL, 'packs/core/pack.json', '{"pack":"core"}\n');
write(INTERNAL, 'packs/clients/cliente-a/pack.json', '{"pack":"cliente-a"}\n');
write(INTERNAL, 'guides/guia.md', 'una guía pública\n');
write(INTERNAL, 'guides/guide-update-proposals.md', 'la guía de propuestas (privada)\n');
write(INTERNAL, 'scripts/tests/suites.json', '{\n  "diarias": [],\n  "interna": true\n}\n');
write(INTERNAL, 'tasks/tarea.md', 'una tarea (privada)\n');
// la lista blanca y la tabla de juguete: con ellas la línea de comandos sabe qué publica el commit (la copia las trae)
write(INTERNAL, 'scripts/publishing/allowlist.json', fs.readFileSync(path.join(FIXTURES, 'layer-lab-allowlist.json'), 'utf8'));
write(INTERNAL, 'scripts/publishing/replacements.json', fs.readFileSync(path.join(FIXTURES, 'layer-lab-table.json'), 'utf8'));
git(INTERNAL, ['add', '-A']);
git(INTERNAL, ['commit', '-q', '-m', 'interno v1']);
const C1 = git(INTERNAL, ['rev-parse', 'HEAD']);

const LEAVE_OUT = ['skills/projects/', 'packs/clients/', 'guides/guide-update-proposals.md', 'tasks/'];
const TRANSFORM = { path: 'scripts/tests/suites.json', transform: 'suites-json' };
const PUBLIC = exportToy({ internalDir: INTERNAL, outDir: path.join(LAB, 'publico'), leaveOut: LEAVE_OUT, transform: TRANSFORM,
  onlyPublic: { 'extra/sin-declarar.txt': 'sólo afuera y sin declarar\n' } });

const paths = (list) => list.map((e) => (typeof e === 'string' ? e : e.path));

test('T3 Layer_ComplementByBlobs_TransformedOnlyFromVersionJson_PublicWins_PublicOnly_OtherVersion_Deterministic', async (t) => {
  const L = requireLayer();
  const base = { internalDir: INTERNAL, internalCommit: C1, publicDir: PUBLIC.dir, publicCommit: PUBLIC.commit, publishable: publishableBy(LEAVE_OUT) };

  await t.test('add / overwrite / same por blob, con skills/ y packs/ en su ruta', () => {
    const r = L.computeLayer(base);
    assert.strictEqual(r.ok, true, r.reason);
    const add = r.entries.filter((e) => e.kind === 'add');
    const over = r.entries.filter((e) => e.kind === 'overwrite');
    assert.deepStrictEqual(paths(add), ['guides/guide-update-proposals.md', 'packs/clients/cliente-a/pack.json', 'skills/projects/producto/SKILL.md', 'tasks/tarea.md']);
    assert.deepStrictEqual(over.map((e) => [e.path, e.transform]), [['scripts/tests/suites.json', 'suites-json']]);
    for (const e of r.entries) {
      assert.match(e.blob, /^[0-9a-f]{40,64}$/, `${e.path} sin blob`);
      assert.strictEqual(e.blob, git(INTERNAL, ['rev-parse', `${C1}:${e.path}`]), `${e.path}: el blob no es el del interno`);
      assert.strictEqual(e.mode, '100644');
    }
    assert.ok(r.same.includes('guides/guia.md') && r.same.includes('agents/revisor.md'), 'lo igual es same');
    assert.deepStrictEqual(r.otherVersion, []);
    assert.strictEqual(r.source.name, 'internal');
    assert.strictEqual(r.source.commit, C1);
  });

  await t.test('«el público manda»: el .gitignore y el despachador con otro blob son same', () => {
    assert.notStrictEqual(git(INTERNAL, ['rev-parse', `${C1}:.gitignore`]), git(PUBLIC.dir, ['rev-parse', `${PUBLIC.commit}:.gitignore`]),
      'el .gitignore de juguete tiene que diferir (si no, la prueba no prueba nada)');
    const r = L.computeLayer(base);
    assert.ok(r.same.includes('.gitignore'), '.gitignore es same');
    assert.ok(r.same.includes('.githooks/pre-commit'), 'el despachador es same');
    assert.ok(!paths(r.entries).includes('.gitignore'));
  });

  await t.test('sólo afuera: LICENSE y version.json aceptados; el no declarado es hallazgo', () => {
    const r = L.computeLayer(base);
    assert.deepStrictEqual(r.onlyPublic.declared, ['LICENSE', 'version.json']);
    assert.deepStrictEqual(r.onlyPublic.undeclared, ['extra/sin-declarar.txt']);
    assert.strictEqual(r.ok, true, 'un hallazgo de «sólo afuera» no es «otra versión»');
  });

  await t.test('sólo afuera: lo que el exportador agrega sólo a la copia sale de la lista blanca del commit interno, sin la lista a mano', () => {
    // Sin esto, un papel nuevo de public-files/ (getting-started/*.md) que llega a la lista blanca sin sumarse
    // a layer-public-only.json hace que cada máquina con capa vea «sólo en la copia y sin declarar».
    // Lo que el exportador agrega sólo a la copia —los `synthetic`, los `generated` y la carpeta nueva de cada
    // `skillRenames`— se lee de la lista blanca de ESE commit interno: la lista a mano queda vacía a propósito
    const dir = path.join(LAB, 'interno-papeles');
    fs.mkdirSync(dir);
    git(dir, ['init', '-q']);
    write(dir, 'README.md', '# arnés de juguete\n');
    write(dir, 'skills/viejo-nombre/SKILL.md', 'una skill que la copia publica con otro nombre\n');
    write(dir, 'scripts/publishing/public-files/getting-started/mac.md', 'un papel de la copia\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'sin lista blanca']);
    const bare = git(dir, ['rev-parse', 'HEAD']);
    const lista = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'layer-lab-allowlist.json'), 'utf8'));
    Object.assign(lista, {
      synthetic: [{ target: 'getting-started/mac.md', from: 'scripts/publishing/public-files/getting-started/mac.md', packages: ['core'], reason: 'un papel de la copia' }],
      generated: [{ target: 'version.json', reason: 'la versión numerada de la copia' }],
      skillRenames: [{ source: 'agent-skills', from: 'skills/viejo-nombre', to: 'skills/nuevo-nombre', why: 'otro nombre', reason: 'de juguete' }],
    });
    write(dir, 'scripts/publishing/allowlist.json', `${JSON.stringify(lista, null, 2)}\n`);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'con lista blanca']);
    const listed = git(dir, ['rev-parse', 'HEAD']);
    const copy = exportToy({ internalDir: dir, outDir: path.join(LAB, 'publico-papeles'), leaveOut: ['skills/viejo-nombre/', 'scripts/publishing/public-files/'],
      onlyPublic: { 'getting-started/mac.md': 'un papel de la copia\n', 'skills/nuevo-nombre/SKILL.md': 'la skill con su nombre nuevo\n', 'extra/x.txt': 'sin declarar\n' } });
    const run = (commit) => L.computeLayer({ internalDir: dir, internalCommit: commit, publicDir: copy.dir, publicCommit: copy.commit, publicOnly: [], publishable: () => null });

    const r = run(listed);
    assert.strictEqual(r.ok, true, r.reason);
    assert.deepStrictEqual(r.onlyPublic.declared, ['getting-started/mac.md', 'skills/nuevo-nombre/SKILL.md', 'version.json'],
      'el sintético, el generado y la skill renombrada se reconocen desde el commit interno');
    assert.deepStrictEqual(r.onlyPublic.undeclared, ['LICENSE', 'extra/x.txt'], 'lo que la lista blanca no declara sigue siendo hallazgo');
    assert.strictEqual(r.onlyPublic.problem, null);

    // sin lista blanca en el commit no se sabe: se dice por qué, y lo de sólo afuera sigue a la vista (nunca se esconde)
    const blind = run(bare);
    assert.strictEqual(blind.ok, true, 'no poder leer los papeles de la copia no es «capa de otra versión»');
    assert.ok(blind.onlyPublic.undeclared.includes('getting-started/mac.md'), 'sin poder leer la lista, el papel queda como hallazgo');
    assert.match(String(blind.onlyPublic.problem), /no pude saber qué agrega el exportador sólo a la copia/);

    // la misma regla, para doctor: un matcher armado con el commit interno
    const outside = L.outsideMatcher({ internalDir: dir, internalCommit: listed, publicOnly: [] });
    assert.ok(outside('getting-started/mac.md') && outside('skills/nuevo-nombre/carpeta/a.md') && outside('version.json'));
    assert.ok(!outside('extra/x.txt') && !outside('getting-started/otro.md'));
  });

  // 🔴 Sólo en el clon interno: el contrato compara la lista blanca contra el árbol INTERNO («lo que el interno no tiene»).
  // En la copia pública cada destino que la lista agrega ya está en su lugar, así que no queda nada que comparar y la
  // prueba daría rojo por vacía. Allá se declara no medida, con el motivo.
  const IN_INTERNAL = fs.existsSync(path.join(ROOT, 'scripts', 'publishing', 'replacements.json'));
  await t.test('sólo afuera: cada papel que la lista blanca real agrega sólo a la copia queda declarado', { skip: !IN_INTERNAL && 'NO MEDIDO en la copia pública: compara la lista blanca contra el árbol interno, y en la copia lo que la lista agrega ya está en su destino' }, () => {
    // el contrato sobre la lista blanca de verdad (la del HEAD de este clon): cada destino `synthetic` o `generated` que
    // el interno no tiene, y cada skill renombrada, lo acepta el matcher de «sólo afuera». Sin exportar: un papel nuevo
    // en allowlist.json frena acá antes de la prueba real (T4)
    const lista = JSON.parse(git(ROOT, ['show', 'HEAD:scripts/publishing/allowlist.json']));
    const internal = new Set(git(ROOT, ['ls-tree', '-r', '--name-only', '--full-tree', 'HEAD']).split('\n'));
    const outside = L.outsideMatcher({ internalDir: ROOT, internalCommit: 'HEAD' });
    const wanted = [
      ...[...(lista.synthetic || []), ...(lista.generated || [])].map((s) => s.target).filter((p) => !internal.has(p)),
      ...(lista.skillRenames || []).filter((s) => s.to !== s.from).flatMap((s) => ['SKILL.md', 'LICENSE', 'carpeta/archivo.md'].map((f) => `${s.to}/${f}`)),
    ];
    assert.ok(wanted.length > 0, 'la lista blanca real no agrega nada sólo a la copia: la prueba no prueba nada');
    const missing = wanted.filter((p) => !outside(p));
    assert.deepStrictEqual(missing, [], `sin declarar en «sólo afuera»: ${missing.join(', ')}`);
    assert.strictEqual(outside.problem, null, String(outside.problem));
  });

  await t.test('un archivo público cambiado en el interno, sin declarar, es «capa de otra versión» (exit 1 nombrándolo)', () => {
    write(INTERNAL, 'guides/guia.md', 'una guía pública, cambiada después de publicar\n');
    git(INTERNAL, ['commit', '-q', '-am', 'interno v2: un cambio publicable']);
    const C2 = git(INTERNAL, ['rev-parse', 'HEAD']);
    const r = L.computeLayer({ ...base, internalCommit: C2 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.problem, 'other-version');
    assert.deepStrictEqual(r.otherVersion, ['guides/guia.md'], 'sólo la no declarada: el transformado declarado no es otra versión');
    const out = path.join(LAB, 'lista-c2.json');
    const cli = layerCli(['compute', '--internal', INTERNAL, '--internal-commit', C2, '--public', PUBLIC.dir, '--public-commit', PUBLIC.commit, '--out', out]);
    assert.strictEqual(cli.rc, 1, cli.out + cli.err);
    assert.match(cli.out + cli.err, /capa de otra versión/);
    assert.match(cli.out + cli.err, /guides\/guia\.md/);
    assert.ok(!fs.existsSync(out), 'con «otra versión» no deja una lista para apilar');
  });

  await t.test('un archivo NUEVO que el interno publica y la copia no trae es «capa de otra versión» (AC 5, segunda mitad)', () => {
    // desde C1, sin tocar ningún archivo público: una guía nueva (pública) y otra privada, las dos en guides/
    git(INTERNAL, ['checkout', '-q', '-b', 'nueva', C1]);
    write(INTERNAL, 'guides/nueva.md', 'una guía nueva, pública, que la copia todavía no trae\n');
    write(INTERNAL, 'guides/otra-privada.md', 'una guía privada nueva, suelta en una carpeta pública\n');
    git(INTERNAL, ['add', '-A']);
    git(INTERNAL, ['commit', '-q', '-m', 'interno v3: un archivo publicable nuevo']);
    const C3 = git(INTERNAL, ['rev-parse', 'HEAD']);
    git(INTERNAL, ['checkout', '-q', 'main']);
    const privateToo = publishableBy([...LEAVE_OUT, 'guides/otra-privada.md']);
    const r = L.computeLayer({ ...base, internalCommit: C3, publishable: privateToo });
    assert.strictEqual(r.ok, false, 'un archivo que el interno publica y la copia no trae no es un agregado');
    assert.strictEqual(r.problem, 'other-version');
    assert.deepStrictEqual(r.otherVersion, ['guides/nueva.md'], 'sólo el publicable: el privado nuevo es un agregado');
    assert.deepStrictEqual(r.unpublished, ['guides/nueva.md']);
    assert.match(r.reason, /capa de otra versión/);
    assert.match(r.reason, /guides\/nueva\.md/);
    assert.doesNotMatch(r.reason, /otra-privada/);
    // qué es publicable lo dice quien publica: si la lista también deja afuera la nueva, son dos agregados
    const both = L.computeLayer({ ...base, internalCommit: C3, publishable: publishableBy([...LEAVE_OUT, 'guides/otra-privada.md', 'guides/nueva.md']) });
    assert.strictEqual(both.ok, true, both.reason);
    assert.deepStrictEqual(both.entries.filter((e) => e.kind === 'add' && e.path.startsWith('guides/')).map((e) => e.path),
      ['guides/guide-update-proposals.md', 'guides/nueva.md', 'guides/otra-privada.md']);
    // la línea de comandos: la clasificación del exportador de verdad, con la lista blanca de juguete de ese commit
    const out = path.join(LAB, 'lista-c3.json');
    const cli = layerCli(['compute', '--internal', INTERNAL, '--internal-commit', C3, '--public', PUBLIC.dir, '--public-commit', PUBLIC.commit, '--out', out]);
    assert.strictEqual(cli.rc, 1, cli.out + cli.err);
    assert.match(cli.out + cli.err, /capa de otra versión/);
    assert.match(cli.out + cli.err, /guides\/nueva\.md/);
    assert.ok(!fs.existsSync(out), 'con «otra versión» no deja una lista para apilar');
  });

  await t.test('overwrite sólo por version.json: transformado y no declarado es «otra versión»; sin transformed no calcula', () => {
    const undeclared = exportToy({ internalDir: INTERNAL, commit: C1, outDir: path.join(LAB, 'publico-sin-declarar'), leaveOut: LEAVE_OUT, transform: TRANSFORM, declare: false });
    const r = L.computeLayer({ ...base, publicDir: undeclared.dir, publicCommit: undeclared.commit });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.otherVersion, ['scripts/tests/suites.json']);
    assert.ok(!r.entries.some((e) => e.kind === 'overwrite'), 'sin la lista no hay overwrite');

    const old = exportToy({ internalDir: INTERNAL, commit: C1, outDir: path.join(LAB, 'publico-viejo'), leaveOut: LEAVE_OUT, transform: TRANSFORM, withoutTransformed: true });
    const r2 = L.computeLayer({ ...base, publicDir: old.dir, publicCommit: old.commit });
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(r2.problem, 'no-transformed');
    assert.match(r2.reason, /la versión pública no trae la lista de transformados: la capa no se apila/);
    const cli = layerCli(['compute', '--internal', INTERNAL, '--internal-commit', C1, '--public', old.dir, '--public-commit', old.commit]);
    assert.strictEqual(cli.rc, 1, cli.out + cli.err);
    assert.match(cli.out + cli.err, /no trae la lista de transformados/);
  });

  await t.test('determinista: mismos commits, misma lista byte a byte (función y línea de comandos)', () => {
    const a = L.serializeList(L.computeLayer(base));
    const b = L.serializeList(L.computeLayer(base));
    assert.strictEqual(a, b);
    const o1 = path.join(LAB, 'lista-1.json'); const o2 = path.join(LAB, 'lista-2.json');
    for (const o of [o1, o2]) {
      const cli = layerCli(['compute', '--internal', INTERNAL, '--internal-commit', C1, '--public', PUBLIC.dir, '--public-commit', PUBLIC.commit, '--out', o]);
      assert.strictEqual(cli.rc, 0, cli.out + cli.err);
    }
    assert.ok(fs.readFileSync(o1).equals(fs.readFileSync(o2)), 'las dos listas difieren');
    assert.strictEqual(fs.readFileSync(o1, 'utf8'), a, 'la lista de la línea de comandos es la de la función');
    const parsed = JSON.parse(a);
    assert.deepStrictEqual(paths(parsed.entries), [...paths(parsed.entries)].sort(), 'en orden por ruta');
  });

  await t.test('calcular no escribe nada en ningún repo', () => {
    const snap = (dir) => git(dir, ['for-each-ref', '--format=%(refname) %(objectname)']) + git(dir, ['status', '--porcelain']);
    const before = [snap(INTERNAL), snap(PUBLIC.dir)];
    L.computeLayer(base);
    assert.deepStrictEqual([snap(INTERNAL), snap(PUBLIC.dir)], before);
  });

  // una ruta de la lista que en Windows sale del árbol no se acepta. Las rutas de git
  // usan siempre «/»: una «\», una unidad («C:») o un «.git» en mayúsculas (en Windows es la misma carpeta) frenan.
  await t.test('una ruta que sale del árbol en Windows frena antes de escribir', () => {
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-ruta-'));
    for (const bad of ['a\\..\\..\\x', 'C:/x', 'c:x', '.GIT/config', 'a/./b']) {
      const list = { source: { name: 'internal' }, entries: [{ path: bad, blob: '0'.repeat(40), kind: 'add', mode: '100644' }] };
      assert.throws(() => L.applyLayer({ tree, from: tree, list, manifest: path.join(tree, 'layer.json') }),
        (e) => e instanceof L.LayerError && /ruta inválida/.test(e.message), `«${bad}» tiene que frenar por la ruta, no por otra cosa`);
    }
    assert.deepStrictEqual(fs.readdirSync(tree), [], 'no se escribió nada');
    fs.rmSync(tree, { recursive: true, force: true });
  });

  // la misma regla para las rutas que llegan del manifiesto de la corrida
  // anterior (layer.json). Sin mirarlas llegarían al borrado de lo que salió de la lista: un manifiesto con
  // «../fuera/testigo.txt» y el sha256 de ese archivo lo borraría FUERA del árbol. Frena antes de borrar o escribir
  await t.test('una ruta del manifiesto previo que sale del árbol frena sin borrar ni escribir nada', () => {
    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-manif-'));
    const tree = path.join(box, 'arbol');
    fs.mkdirSync(tree);
    git(tree, ['init', '-q']);
    const witness = path.join(box, 'fuera', 'testigo.txt');
    write(box, 'fuera/testigo.txt', 'un archivo de la persona, fuera del árbol\n');
    const witnessSha = require('crypto').createHash('sha256').update(fs.readFileSync(witness)).digest('hex');
    const list = { source: { name: 'internal' }, entries: [] };
    const exclude = path.join(tree, '.git', 'info', 'exclude');
    const excludeBefore = fs.readFileSync(exclude, 'utf8');
    for (const bad of ['../fuera/testigo.txt', 'a\\..\\..\\fuera\\testigo.txt', 'C:/fuera/testigo.txt']) {
      const manifest = path.join(box, 'layer.json');
      const text = `${JSON.stringify({ schema: 1, files: [{ path: bad, source: 'internal', kind: 'add', blob: '0'.repeat(40), mode: '100644', sha256: witnessSha }] }, null, 2)}\n`;
      fs.writeFileSync(manifest, text);
      assert.throws(() => L.applyLayer({ tree, from: tree, list, manifest }),
        (e) => e instanceof L.LayerError && e.message.includes(`ruta inválida en el manifiesto de la capa: ${bad}`),
        `«${bad}» del manifiesto tiene que frenar por la ruta, no por otra cosa`);
      assert.throws(() => L.verifyLayer({ tree, manifest }),
        (e) => e instanceof L.LayerError && e.message.includes('ruta inválida en el manifiesto de la capa'), `verify con «${bad}» también frena`);
      assert.ok(fs.existsSync(witness), `«${bad}»: el testigo fuera del árbol se borró`);
      assert.strictEqual(fs.readFileSync(manifest, 'utf8'), text, `«${bad}»: el manifiesto se reescribió`);
    }
    assert.strictEqual(fs.readFileSync(witness, 'utf8'), 'un archivo de la persona, fuera del árbol\n', 'el testigo quedó como estaba');
    assert.deepStrictEqual(fs.readdirSync(tree), ['.git'], 'no se escribió nada en el árbol');
    assert.strictEqual(fs.readFileSync(exclude, 'utf8'), excludeBefore, 'el bloque de exclude no se escribió');
    // la regla es UNA: la que mira la lista y la que mira el manifiesto son la misma función
    assert.strictEqual(typeof L.isSafeLayerPath, 'function', 'layer.js no exporta la regla de las rutas');
    for (const bad of ['../x', 'a\\..\\x', 'C:/x', '.Git/config', 'a//b', '', '/abs', null]) assert.strictEqual(L.isSafeLayerPath(bad), false, `«${bad}» pasa`);
    for (const good of ['tasks/plan.md', 'skills/projects/acme/SKILL.md', '.gitignore']) assert.strictEqual(L.isSafeLayerPath(good), true, `«${good}» no pasa`);
    fs.rmSync(box, { recursive: true, force: true });
  });

  // el `git checkout` que devuelve al público un pisado que salió de la lista corre primero, antes de escribir los
  // agregados: si corriera después y fallara (otra sesión con el índice tomado), lo escrito quedaría sin
  // manifiesto que lo dijera. Si falla, no se escribe nada y el manifiesto queda como estaba
  await t.test('el checkout que devuelve un pisado al público falla: no se escribe nada y el manifiesto queda', () => {
    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-checkout-'));
    const tree = path.join(box, 'arbol');
    fs.mkdirSync(tree);
    git(tree, ['init', '-q']);
    write(tree, 'guides/publica.md', 'el contenido público\n');
    git(tree, ['add', '-A']);
    git(tree, ['commit', '-q', '-m', 'público']);
    // lo que dejó la capa en la corrida anterior: el pisado con el contenido interno, y su sha256 en el manifiesto
    write(tree, 'guides/publica.md', 'el contenido interno que pisó la capa\n');
    const sha = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(tree, 'guides', 'publica.md'))).digest('hex');
    const manifest = path.join(box, 'layer.json');
    const text = `${JSON.stringify({ schema: 1, files: [{ path: 'guides/publica.md', source: 'internal', kind: 'overwrite', blob: '1'.repeat(40), mode: '100644', sha256: sha }] }, null, 2)}\n`;
    fs.writeFileSync(manifest, text);
    // la lista nueva: el pisado ya no está (vuelve al público) y hay un agregado nuevo, con su blob en el repo
    const blobFile = path.join(box, 'nuevo.txt');
    fs.writeFileSync(blobFile, 'un agregado nuevo de la capa\n');
    const blob = git(tree, ['hash-object', '-w', blobFile]);
    const list = { source: { name: 'internal', label: 'lab' }, entries: [{ path: 'tasks/nuevo.md', kind: 'add', mode: '100644', blob }] };
    const exclude = path.join(tree, '.git', 'info', 'exclude');
    const excludeBefore = fs.readFileSync(exclude, 'utf8');
    // otra sesión tiene tomado el índice: el checkout no puede
    fs.writeFileSync(path.join(tree, '.git', 'index.lock'), '');
    assert.throws(() => L.applyLayer({ tree, from: tree, list, manifest }), (e) => e instanceof L.LayerError && /checkout/.test(e.message),
      'tiene que frenar el checkout, no otra cosa');
    assert.ok(!fs.existsSync(path.join(tree, 'tasks', 'nuevo.md')), 'el agregado se escribió aunque el checkout falló');
    assert.strictEqual(fs.readFileSync(manifest, 'utf8'), text, 'el manifiesto cambió');
    assert.strictEqual(fs.readFileSync(path.join(tree, 'guides', 'publica.md'), 'utf8'), 'el contenido interno que pisó la capa\n', 'el pisado cambió');
    assert.strictEqual(fs.readFileSync(exclude, 'utf8'), excludeBefore, 'el bloque de exclude se escribió');
    // sin el candado ajeno, la misma corrida entra entera
    fs.rmSync(path.join(tree, '.git', 'index.lock'));
    const r = L.applyLayer({ tree, from: tree, list, manifest });
    assert.deepStrictEqual([r.restored, r.written], [['guides/publica.md'], ['tasks/nuevo.md']]);
    assert.strictEqual(fs.readFileSync(path.join(tree, 'guides', 'publica.md'), 'utf8'), 'el contenido público\n');
    fs.rmSync(box, { recursive: true, force: true });
  });
});
