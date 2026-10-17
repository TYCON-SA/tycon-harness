'use strict';
// site-image-workflow.test.js — el control del workflow que publica la imagen del sitio de la organización
// (T1 a T3). Lee el archivo por TEXTO, como scripts/ci/check-public-workflow.js, y toma de ahí sólo las dos reglas que
// valen para cualquier workflow de un repo público (`pull-request-target` y `uses-by-sha`); las de `ci.yml`
// (disparadores, permisos, forma) no se le aplican: éste tiene las suyas, abajo.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const ARCHIVO = path.join(ROOT, '.github', 'workflows', 'site-image.yml');
const { check, WORKFLOWS } = require(path.join(ROOT, 'scripts', 'ci', 'check-public-workflow.js'));
const read = () => fs.readFileSync(ARCHIVO, 'utf8');
/** Las líneas de código (sin vacías ni comentarios). */
const codigo = (t) => t.split('\n').filter((l) => l.trim() && !/^\s*#/.test(l));
// lo que copia scripts/site/Dockerfile: si cambia algo que la imagen trae, la imagen se vuelve a armar
const RUTAS = ["'scripts/site/**'", "'scripts/lib/**'", "'scripts/metrics/**'", "'scripts/nightly/**'", "'scripts/setup/harness/**'",
  "'scripts/ci/check-product-parity.js'", "'scripts/ci/legacy-options.js'", "'skills/tycon-pipeline/scripts/lib/**'", "'skills/tycon-pipeline/steps/**'"];

/** Las reglas propias, con su id; [] = cumple. */
function rotas(t) {
  const r = [];
  for (const b of check(t)) if (['pull-request-target', 'uses-by-sha'].includes(b.rule)) r.push(b.rule);
  const on = t.match(/^on:\n((?: {2}.*\n|\n)*)/m);
  const bloque = on ? on[1] : '';
  const disparadores = [...bloque.matchAll(/^ {2}([a-z_]+):/gm)].map((x) => x[1]);
  const rutas = [...bloque.matchAll(/^ {6}- (.+)$/gm)].map((x) => x[1].trim());
  if (disparadores.join(',') !== 'push' || !/^ {4}branches: \[main\]$/m.test(bloque) || rutas.join(',') !== RUTAS.join(',')) r.push('disparador');
  if (/pull_request/.test(t) || /version\.json/.test(bloque)) r.push('disparador');
  const perms = [...t.matchAll(/^( *)permissions:/gm)];
  const PERMISOS = 'permissions:\n  contents: read\n  packages: write\n  id-token: write\n  attestations: write\n';
  if (perms.length !== 1 || perms[0][1] !== '' || !t.includes(PERMISOS) || /^permissions:\n(?: {2}\S.*\n){5}/m.test(t)) r.push('permisos');
  // el contexto de secretos sólo como `secrets.GITHUB_TOKEN`: cualquier otra forma de nombrarlo (por índice, entero con
  // toJSON, o el contexto suelto) puede sacar otro secreto del repo
  const usos = [...t.matchAll(/\bsecrets\b(.{0,20})/g)].map((x) => x[1]);
  if (usos.some((u) => !/^\.GITHUB_TOKEN\b/.test(u))) r.push('secretos');
  return [...new Set(r)];
}

test('T1 Imagen_SoloEnPushAMainConSusRutas @story-2.30 @ac-1 @ac-2', () => {
  const t = read();
  assert.deepStrictEqual(rotas(t), [], 'el workflow cumple sus reglas');
  assert.doesNotMatch(t, /pull_request/, 'ni pull_request ni pull_request_target');
  // copias alteradas que tienen que salir rojas
  assert.ok(rotas(t.replace('on:\n  push:', 'on:\n  pull_request:\n  push:')).includes('disparador'), 'correr en pull_request');
  assert.ok(rotas(t.replace("      - 'scripts/nightly/**'", "      - 'scripts/nightly/**'\n      - 'version.json'")).includes('disparador'), 'version.json solo lo dispararía en cada merge');
  assert.ok(rotas(t.replace('    branches: [main]', '    branches: [main, dev]')).includes('disparador'), 'otra rama');
  // cada COPY del Dockerfile tiene su ruta en el disparador
  const docker = fs.readFileSync(path.join(ROOT, 'scripts', 'site', 'Dockerfile'), 'utf8');
  for (const [, origen] of docker.matchAll(/^COPY (.+) \S+$/gm)) {
    // version.json (con o sin el comodín que lo vuelve opcional) no dispara: cambia en cada merge
    for (const o of origen.split(/\s+/).filter((x) => !/^version\.json\*?$/.test(x))) {
      const cubierta = RUTAS.some((r) => { const x = r.slice(1, -1); return x.endsWith('/**') ? o.startsWith(x.slice(0, -2)) : o === x; });
      assert.ok(cubierta, `el disparador no cubre ${o}, que la imagen copia`);
    }
  }
  // el control de la lista cerrada de workflows lo conoce
  assert.ok(WORKFLOWS.includes('site-image.yml'), 'check-public-workflow.js lo tiene en su lista de workflows conocidos');
});

test('T2 Imagen_PermisosYAccionesFijadas @story-2.30 @ac-2', () => {
  const t = read();
  for (const l of codigo(t).filter((x) => /uses:/.test(x))) assert.match(l, /uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, `fijada por el sha con el tag: ${l}`);
  assert.ok(rotas(t.replace('permissions:\n  contents: read', 'permissions: write-all\npermissions_viejo:\n  contents: read')).includes('permisos'), 'write-all');
  assert.ok(rotas(t.replace('  attestations: write\n', '  attestations: write\n  actions: write\n')).includes('permisos'), 'un permiso de más');
  assert.ok(rotas(t.replace(/uses: actions\/checkout@[0-9a-f]{40} # v[\d.]+/, 'uses: actions/checkout@v7')).includes('uses-by-sha'), 'una acción por tag');
  assert.ok(rotas(t.replace('${{ secrets.GITHUB_TOKEN }}', '${{ secrets.OTRO }}')).includes('secretos'), 'otro secreto');
  assert.ok(rotas(t.replace('${{ secrets.GITHUB_TOKEN }}', "${{ secrets['SITE_MAILBOX_SAS'] }}")).includes('secretos'), 'un secreto por índice');
  assert.ok(rotas(t.replace('${{ secrets.GITHUB_TOKEN }}', '${{ toJSON(secrets) }}')).includes('secretos'), 'todos los secretos con toJSON');
  assert.match(t, /\$\{\{ secrets\.GITHUB_TOKEN \}\}/, 'el token del workflow para empujar la imagen');
});

test('T3 Imagen_EtiquetasSinLatestYNombreDelContexto @story-2.30 @ac-1', () => {
  const t = read();
  // ninguna etiqueta `latest` (el `ubuntu-latest` del corredor no es una etiqueta de la imagen)
  assert.doesNotMatch(codigo(t).filter((l) => !/runs-on:/.test(l)).join('\n'), /latest/, 'nunca latest');
  assert.doesNotMatch(t, /ghcr\.io\/[a-z0-9-]+\//i, 'ningún ghcr.io/<org>/ escrito');
  assert.match(t, /IMAGEN="ghcr\.io\/\$\{GITHUB_REPOSITORY,,\}"/, 'el nombre sale del contexto, en minúsculas');
  assert.match(t, /VERSION=\$\(node -p "require\('\.\/version\.json'\)\.version"\)/, 'la versión sale de version.json');
  assert.match(t, /-t "\$\{IMAGEN\}:\$\{VERSION\}"/);
  assert.match(t, /-t "\$\{IMAGEN\}:sha-\$\{GITHUB_SHA\}"/);
  assert.match(t, /-f scripts\/site\/Dockerfile/);
  assert.match(t, /uses: actions\/attest-build-provenance@[0-9a-f]{40} # v\d+\.\d+\.\d+/, 'la constancia de origen');
  assert.match(t, /subject-digest: \$\{\{ steps\.imagen\.outputs\.huella \}\}/);
  assert.match(t, /push-to-registry: true/);
});
