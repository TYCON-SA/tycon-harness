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
const RUTAS = ["'scripts/site/**'", "'scripts/lib/**'", "'scripts/metrics/**'", "'scripts/nightly/**'", "'scripts/setup/harness/**'", "'scripts/setup/install-effects.json'",
  "'scripts/ci/check-product-parity.js'", "'scripts/ci/legacy-options.js'", "'skills/tycon-pipeline/scripts/**'", "'skills/tycon-pipeline/steps/**'",
  // lo que lee la pestaña Cómo trabaja: los guiones de los controles, su lista y las guías
  "'skills/clocki/scripts/**'", "'scripts/hooks/**'", "'scripts/setup/hooks-list.json'", "'guides/**'", "'agents/**'", "'packs/**'", "'LICENSE*'", "'NOTICE*'",
  // la guía del sitio y sus capturas: la pestaña Ayuda la arma de la imagen
  "'guides/organization-site.md'", "'guides/organization-site.en.md'", "'guides/sitio-de-la-organizacion/capturas/**'",
  // y el propio workflow: un cambio a cómo se arma la imagen la vuelve a armar
  "'.github/workflows/site-image.yml'"];

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
    // version.json no dispara (cambia en cada merge) y .tycon-release.json no está en el repo: lo escribe el workflow
    // `guide[s]/x.md*` es el comodín que deja armar la imagen sin la carpeta: la ruta que cubre es `guides/x.md`
    for (const o of origen.split(/\s+/).filter((x) => !/^(version|\.tycon-release)\.json\*?$/.test(x)).map((x) => (/\[\w\]/.test(x) ? x.replace(/\[(\w)\]/g, '$1').replace(/\*$/, '') : x))) {
      // una carpeta que se copia con comodín (`agents*`, para armarse igual sin ella) la cubre su `agents/**`
      const cubierta = RUTAS.some((r) => {
        const x = r.slice(1, -1);
        if (!x.endsWith('/**')) return o === x;
        const base = x.slice(0, -2);
        return o.startsWith(base) || (o.endsWith('*') && `${o.slice(0, -1)}/` === base);
      });
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
  // ninguna etiqueta `latest` (el `ubuntu-latest` del corredor no es una etiqueta de la imagen, ni el guion
  // `latest-release.js` que lee `stable`)
  assert.doesNotMatch(codigo(t).filter((l) => !/runs-on:/.test(l)).join('\n').replace(/latest-release\.js/g, ''), /latest/, 'nunca latest');
  assert.doesNotMatch(t, /ghcr\.io\/[a-z0-9-]+\//i, 'ningún ghcr.io/<org>/ escrito');
  assert.match(t, /IMAGEN="ghcr\.io\/\$\{GITHUB_REPOSITORY,,\}"/, 'el nombre sale del contexto, en minúsculas');
  assert.match(t, /-t "\$\{IMAGEN\}:\$\{VERSION\}"/);
  assert.match(t, /-t "\$\{IMAGEN\}:sha-\$\{GITHUB_SHA\}"/);
  assert.match(t, /-f scripts\/site\/Dockerfile/);
  assert.match(t, /uses: actions\/attest-build-provenance@[0-9a-f]{40} # v\d+\.\d+\.\d+/, 'la constancia de origen');
  assert.match(t, /subject-digest: \$\{\{ steps\.imagen\.outputs\.huella \}\}/);
  assert.match(t, /push-to-registry: true/);
});

test('T3b Imagen_VersionDelMergeYFirmaConLaSesionAbierta @story-2.30 @ac-1', () => {
  const t = read();
  // la versión es la etiqueta v<número> que el merge le puso a ESTE commit, nunca el piso de version.json
  assert.doesNotMatch(t, /require\('\.\/version\.json'\)/, 'la versión no sale de version.json');
  assert.match(t, /git ls-remote --tags "https:\/\/github\.com\/\$\{GITHUB_REPOSITORY\}\.git" 'refs\/tags\/v\*'/, 'se busca la etiqueta del merge');
  assert.match(t, /awk -v s="\$GITHUB_SHA" '\$1 == s/, 'la etiqueta de este commit, no otra');
  // con `set -o pipefail`, un awk que sale antes de leer todo corta la tubería (código 141) y tumba el paso: lee hasta el final
  const programa = (t.match(/awk -v s="\$GITHUB_SHA" '([^']*)'/) || [])[1] || '';
  assert.ok(programa && !/\bexit\b/.test(programa), `el awk no sale antes de tiempo: ${programa}`);
  assert.match(t, /printf '\{ "version": "%s", "image": "%s" \}\\n' "\$VERSION" "\$IMAGEN" > \.tycon-release\.json/, 'la versión viaja adentro de la imagen');
  // sin etiqueta no se publica una imagen con otro número: se dice y no se firma
  assert.match(t, /::warning::este commit no recibió la etiqueta del merge/);
  assert.match(t, /echo "publicar=no" >> "\$GITHUB_OUTPUT"\n {12}exit 0/);
  assert.match(t, /attest-build-provenance@[0-9a-f]{40} # v[\d.]+\n {8}if: steps\.imagen\.outputs\.publicar == 'si'/);
  // la firma se sube con la sesión del registro abierta: el cierre va después, en su propio paso, pase lo que pase
  const firma = t.indexOf('actions/attest-build-provenance@');
  const cierre = t.indexOf('docker logout ghcr.io');
  assert.ok(firma > 0 && cierre > firma, 'docker logout después de la firma');
  assert.strictEqual(t.split('docker logout').length - 1, 1, 'una sola vez');
  assert.match(t, /- name: Cerrar la sesión del registro\n {8}if: always\(\)\n {8}run: docker logout ghcr\.io/);
  // y la imagen trae ese archivo: el Dockerfile lo copia y el contexto lo deja pasar
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts', 'site', 'Dockerfile'), 'utf8'), /^COPY version\.json\* \.tycon-release\.json\* \.\/$/m);
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts', 'site', 'Dockerfile.dockerignore'), 'utf8'), /^!\.tycon-release\.json$/m);
});

test('T3c Imagen_EscaneoQueFrenaAntesDePublicar_YBaseFijada @story-2.30 @ac-1', () => {
  const t = read();
  // Trivy fijado por versión Y por huella (una etiqueta sola se puede mover)
  const trivy = (t.match(/TRIVY="([^"]+)"/) || [])[1] || '';
  assert.match(trivy, /^aquasec\/trivy:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/, `Trivy por versión y huella: ${trivy}`);
  // frena con una HIGH o CRITICAL que tenga arreglo; las sin arreglo, aviso
  assert.match(t, /--severity HIGH,CRITICAL/);
  assert.match(t, /"\$\{ESCANEAR\[@\]\}" --ignore-unfixed --exit-code 1\n/, 'el escaneo que frena');
  assert.match(t, /::warning::\$\{SIN_ARREGLO\} vulnerabilidad\(es\) HIGH o CRITICAL sin arreglo publicado/, 'las sin arreglo se avisan');
  // el orden: armar → escanear → iniciar sesión → publicar (nada se sube si el escaneo frena)
  const armar = t.indexOf('docker build -f scripts/site/Dockerfile');
  const frena = t.indexOf('--ignore-unfixed --exit-code 1');
  const login = t.indexOf('docker login ghcr.io');
  const push = t.indexOf('docker push');
  assert.ok(armar > 0 && armar < frena && frena < login && login < push, `orden armar ${armar} < escanear ${frena} < login ${login} < push ${push}`);
  // la imagen le llega a Trivy como archivo: sin el socket de Docker adentro
  assert.doesNotMatch(t, /docker\.sock/);
  assert.match(t, /docker save "\$\{IMAGEN\}:\$\{VERSION\}" -o/);
  // la base, por etiqueta y huella, con los paquetes al día y sin las herramientas de paquetes de Node
  const docker = fs.readFileSync(path.join(ROOT, 'scripts', 'site', 'Dockerfile'), 'utf8');
  assert.match(docker, /^FROM node:\d+\.\d+\.\d+-alpine\d+\.\d+@sha256:[0-9a-f]{64}$/m, 'la base fijada por huella');
  assert.match(docker, /apk upgrade --no-cache/);
  for (const x of ['/usr/local/lib/node_modules/npm', '/usr/local/lib/node_modules/corepack', '/usr/local/bin/npx', '/usr/local/bin/yarn']) assert.ok(docker.includes(x), `la imagen saca ${x}`);
});

// ── la etiqueta móvil `stable` ───────────────────────────────────────────────────────────────────────
const http = require('http');
const { spawn } = require('child_process');
/** El bloque `run:` de un paso por su nombre (sin sangría), o null. */
function paso(t, nombre) {
  const i = t.indexOf(`- name: ${nombre}`);
  if (i < 0) return null;
  const resto = t.slice(i);
  const fin = resto.slice(2).search(/\n {6}- /);
  return fin < 0 ? resto : resto.slice(0, fin + 2);
}

test('T2 2.33-Imagen_EtiquetasOciDelContexto @story-2.33 @ac-3 — las etiquetas OCI y el nombre adentro, del contexto', () => {
  // 🔴 rojo: la imagen sale sin versión legible desde el registro, o con un nombre de registro escrito en el código.
  const t = read();
  for (const [k, v] of [['version', '\\$VERSION'], ['revision', '\\$GITHUB_SHA'], ['source', '\\$\\{GITHUB_SERVER_URL\\}/\\$\\{GITHUB_REPOSITORY\\}'], ['created', '\\$CREADA']]) {
    assert.match(t, new RegExp(`--label "org\\.opencontainers\\.image\\.${k}=${v}"`), `la etiqueta OCI ${k}`);
  }
  assert.match(t, /CREADA=\$\(date -u \+%Y-%m-%dT%H:%M:%SZ\)/, 'created en UTC');
  assert.match(t, /printf '\{ "version": "%s", "image": "%s" \}\\n' "\$VERSION" "\$IMAGEN" > \.tycon-release\.json/, 'el nombre de la imagen viaja adentro');
  assert.doesNotMatch(codigo(t).join('\n'), /ghcr\.io\/[a-z0-9-]+\/[a-z0-9-]+/i, 'ningún nombre de registro escrito');
});

test('T3 2.33-Stable_SeMueveAlFinal @story-2.33 @ac-4 — stable se mueve después de firmar y verificar, antes de cerrar la sesión', () => {
  // 🔴 rojo: un `-t …:stable` en el docker build mueve la etiqueta antes del escaneo y de la firma.
  const t = read();
  assert.doesNotMatch(t, /docker build [^\n]*:stable/, 'stable nunca en el build');
  assert.doesNotMatch(t, /docker push[^\n]*:stable/, 'stable nunca se sube aparte (se apunta a la huella ya subida)');
  const firma = t.indexOf('actions/attest-build-provenance@');
  const verif = t.indexOf('gh attestation verify');
  const mover = t.indexOf('docker buildx imagetools create');
  const cierre = t.indexOf('docker logout ghcr.io');
  assert.ok(firma > 0 && verif > firma && mover > verif && cierre > mover, `el orden: firma ${firma}, verificación ${verif}, stable ${mover}, cierre ${cierre}`);
  assert.match(t, /gh attestation verify "oci:\/\/\$\{IMAGEN\}@\$\{HUELLA\}" --repo "\$GITHUB_REPOSITORY"/);
  assert.match(t, /docker buildx imagetools create -t "\$\{IMAGEN\}:stable" "\$\{IMAGEN\}@\$\{HUELLA\}"/, 'sin volver a subir capas: la misma huella');
});

test('T4 2.33-Stable_NoSeMueveSiFallaLaFirma @story-2.33 @ac-4 — mover stable depende de la publicación, la firma y la verificación', () => {
  const t = read();
  const verif = paso(t, 'Verificar la firma de la imagen');
  const mover = paso(t, 'Mover stable a la imagen nueva');
  assert.ok(verif && mover, 'los dos pasos existen');
  assert.match(verif, /\n {8}id: firma\n/);
  assert.match(verif, /\n {8}if: steps\.imagen\.outputs\.publicar == 'si'\n/);
  assert.match(mover, /\n {8}if: steps\.imagen\.outputs\.publicar == 'si' && steps\.firma\.outcome == 'success'\n/, 'sólo con la verificación en verde (y por lo tanto la firma y la publicación)');
  assert.match(mover, /GITHUB_STEP_SUMMARY/, 'el resumen del workflow dice qué pasó con stable');
});

/** Un registro de juguete: el token anónimo, el manifiesto de `stable` (o 404) y su configuración con la etiqueta. */
async function registro({ stable = null } = {}) {
  const config = stable ? JSON.stringify({ config: { Labels: { 'org.opencontainers.image.version': stable } } }) : null;
  const dConfig = config ? `sha256:${require('crypto').createHash('sha256').update(config).digest('hex')}` : null;
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/token')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"token":"anonimo"}'); return; }
    if (req.headers.authorization !== 'Bearer anonimo') { res.writeHead(401); res.end(); return; }
    if (/\/manifests\/stable$/.test(req.url)) {
      if (!stable) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/vnd.docker.distribution.manifest.v2+json', 'docker-content-digest': `sha256:${'b'.repeat(64)}` });
      res.end(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.docker.distribution.manifest.v2+json', config: { digest: dConfig } }));
      return;
    }
    if (dConfig && req.url.endsWith(`/blobs/${dConfig}`)) { res.writeHead(200); res.end(config); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${srv.address().port}`, cerrar: () => new Promise((r) => srv.close(r)) };
}
const decidir = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(ROOT, 'scripts', 'site', 'latest-release.js'), 'stable-decision', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  p.on('close', (status) => resolve({ status, out }));
});

test('T5 2.33-Stable_NuncaRetrocede @story-2.33 @ac-5 — sin stable la crea; mayor la mueve; igual o menor la deja y lo dice', async () => {
  // 🔴 rojo: una corrida vieja (re-ejecutada a mano) devuelve stable a una versión anterior y todos los sitios bajan.
  for (const [actual, nueva, esperado] of [[null, '2026.10.18.7', 'crear'], ['2026.10.18.7', '2026.10.18.8', 'mover'], ['2026.10.18.7', '2026.10.18.7', 'queda'], ['2026.10.18.7', '2026.10.17.40', 'queda']]) {
    const reg = await registro({ stable: actual });
    try {
      const r = await decidir(['--image', 'ghcr.io/acme/arnes', '--version', nueva, '--registry-url', reg.base]);
      assert.strictEqual(r.status, 0, r.out);
      assert.match(r.out, new RegExp(`^decision=${esperado}$`, 'm'), `${actual} → ${nueva}: ${r.out}`);
      if (esperado === 'queda') assert.match(r.out, /no es mayor que la de stable/);
    } finally { await reg.cerrar(); }
  }
  // sin poder leer stable no se mueve a ciegas: sale distinto de 0 y lo dice
  const r = await decidir(['--image', 'ghcr.io/acme/arnes', '--version', '2026.10.18.8', '--registry-url', 'http://127.0.0.1:9']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.out, /no se pudo leer stable/);
  assert.match(read(), /node scripts\/site\/latest-release\.js stable-decision --image "\$IMAGEN" --version "\$VERSION"/, 'el workflow decide con esta orden');
});

test('T6 2.33-SinNumero_NoPublicaNiMueve @story-2.33 @ac-6 — un commit sin número no publica ni mueve stable', () => {
  const t = read();
  assert.match(t, /echo "publicar=no" >> "\$GITHUB_OUTPUT"\n {12}exit 0/);
  for (const n of ['Verificar la firma de la imagen', 'Mover stable a la imagen nueva']) assert.match(paso(t, n), /if: steps\.imagen\.outputs\.publicar == 'si'/, `${n} no corre sin número`);
});

test('T4b 2.33-Rev_StableDiceQuePasoYLaFirmaEsDeEsteWorkflow @story-2.33 @ac-4 — el motivo de un rojo y de un «queda» se ve', () => {
  const t = read();
  assert.match(t, /\|\| \{ echo "\$SALIDA"; echo "::error::stable no se movió/, 'sin poder leer stable: el paso falla con el motivo a la vista');
  assert.match(t, /echo "::warning::stable no se movió/, 'un «queda» (igual, menor o incomparable) deja un aviso');
  assert.match(t, /--signer-workflow "\$\{GITHUB_REPOSITORY\}\/\.github\/workflows\/site-image\.yml"/, 'la firma tiene que ser de este workflow');
  assert.match(t, /--label "tycon\.image=site"/, 'la etiqueta con la que harness.js update reconoce la imagen del sitio');
});

test('T7 SiteImageWorkflow_LaSondaCorreAntesDePublicar @story-2.61.1 @ac-2 — la pestaña Cómo trabaja arma su modelo dentro de la imagen antes del escaneo', () => {
  const t = read();
  const armar = t.indexOf('docker build -f scripts/site/Dockerfile');
  const enImagen = t.search(/docker run --rm -v "\$PWD\/scripts\/tests\/lib:\/app\/scripts\/tests\/lib:ro" "\$\{IMAGEN\}:\$\{VERSION\}" node \/app\/scripts\/tests\/lib\/how-it-works-probe\.js/);
  const enArbol = t.search(/docker run --rm -v "\$PWD:\/arbol:ro" "\$\{IMAGEN\}:\$\{VERSION\}" node \/arbol\/scripts\/tests\/lib\/how-it-works-probe\.js \/arbol/);
  const escanear = t.indexOf('TRIVY=');
  assert.ok(armar > 0 && enImagen > armar && enArbol > armar, 'la sonda corre dentro de la imagen recién armada y en el checkout');
  assert.ok(enImagen < escanear && enArbol < escanear, 'antes del escaneo y de publicar: una imagen rota no se publica');
  // las dos salidas tienen que ser iguales; distinto, el paso falla con el motivo a la vista
  assert.match(t, /\[ "\$SONDA_IMAGEN" = "\$SONDA_ARBOL" \] \|\| \{ echo "::error::la pestaña Cómo trabaja no arma en la imagen lo mismo que en el árbol/, 'distinto, frena');
  assert.match(t, /set -euo pipefail/, 'una sonda que falla corta el paso');
  // iguales y rotas también frena: la de la imagen tiene que terminar sin problemas (un {error} no lo hace)
  const guarda = t.match(/case "\$SONDA_IMAGEN" in \*'"problems":\[\]\}'\) ;; \*\) echo "::error::[^"]*"; exit 1 ;; esac/);
  assert.ok(guarda && t.indexOf(guarda[0]) < escanear, 'rota en los dos lados también frena, antes del escaneo');
  // el renglón tal cual del workflow, corrido con bash
  const pasa = (salida) => require('child_process').spawnSync('bash', ['-c', guarda[0]], { env: { PATH: process.env.PATH, SONDA_IMAGEN: salida }, encoding: 'utf8' }).status === 0;
  assert.strictEqual(pasa('{"error":"x"}'), false, 'un error igual en los dos lados no pasa');
  assert.strictEqual(pasa('{"steps":[],"controls":[],"packs":[],"problems":["guides no se pudo leer"]}'), false, 'con problemas no pasa');
  // sana: la salida real de la sonda sobre este árbol
  const real = require('child_process').spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'tests', 'lib', 'how-it-works-probe.js'), ROOT], { encoding: 'utf8' });
  assert.strictEqual(real.status, 0, real.stderr);
  assert.strictEqual(pasa(real.stdout.trim()), true, 'la salida real de la sonda, sana, pasa');
});
