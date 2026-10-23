'use strict';
/*
 * site-repo-config.test.js — la sección por repo de la pestaña Configuración: lo que dice el `.tycon/advisors.yaml` de
 * `main` de cada repo de producto, editado fila por fila y propuesto con un pedido a ese repo. La prueba en un navegador
 * de verdad es E1, en site-propose.test.js.
 *
 *   T21 Sitio_SeccionPorRepo_Generica            T24 Sitio_ElRestoDelYamlQuedaIgual
 *   T22 Sitio_FilaMalEscrita_NoSePropone         T25 Sitio_ValidaIgualQueElArnes
 *   T23 Sitio_ProponeElPedido                    T26 Sitio_SecretoDeProductos_SoloPedidos
 *
 * Sin red: el repo del producto es un repo git local por HTTP (lib/git-http-repo.js) y la API de GitHub un servidor
 * falso en el proceso (lib/fake-github-api.js). Correos y repos inventados.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const ORG = require(path.join(ROOT, 'scripts', 'lib', 'org-config.js'));
const DEP = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'deprecated.js'));
const H = require('./lib/site-harness.js');
const SRC = require(path.join(H.SITE, 'sources.js'));
const { arrancarEmisor } = require('./lib/fake-oidc.js');
const { arrancarGithubFalso } = require('./lib/fake-github-api.js');
const { crearRepoHttp, hayHttpBackend } = require('./lib/git-http-repo.js');
const { validarConfiguracion } = require(path.join(H.SITE, 'server.js'));
const TAB = () => require(path.join(H.SITE, 'tabs', 'config.js'));

// sin git http-backend se saltea con constancia; en CI (CI=true) NO se saltea
const SIN_BACKEND = !hayHttpBackend() && !process.env.CI && 'git http-backend no está en esta máquina: el repo por HTTP no se puede armar';
const LEAD = 'lead@acme.example';
const DEV = 'dev.a@acme.example';
const AHORA = Date.parse('2026-10-22T12:00:00Z');
const ESCRITURA = `w-${crypto.randomBytes(6).toString('hex')}`;
const CAB = `Basic ${Buffer.from(`x-access-token:${ESCRITURA}`).toString('base64')}`;
const PERFIL_ENV = { SITE_PROFILE_REPO: 'https://git.acme.example/perfil.git', SITE_PROFILE_TOKEN: 't' };
const GH = (repo) => ({ platform: 'github', org: 'acme', repo });
const YAML = '.tycon/advisors.yaml';

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

function g(dir, ...a) {
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@acme.example', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@acme.example', GIT_AUTHOR_DATE: '2026-10-22T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-22T12:00:00Z' } });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function clon(archivos) {
  const d = tmp('site-repo-config-clon-');
  g(d, 'init', '-q', '-b', 'main');
  for (const [rel, c] of Object.entries(archivos)) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), typeof c === 'string' ? c : ORG.formatJson(c));
  }
  g(d, 'add', '-A'); g(d, 'commit', '-q', '--allow-empty', '-m', 'base');
  return d;
}

// el archivo del repo de juguete: otras claves antes y después, comentarios y líneas en blanco
const YAML_BASE = [
  '# configuración del arnés de app',
  'repo_group:',
  '  - ../app-web   # el hermano',
  '',
  'deprecated:',
  '  edit: warn',
  '  paths:',
  '    - path: "src/legacy/**"',
  '      level: frozen',
  '      reason: "reemplazado por src/billing"',
  '    - path: "src/no-existe/**"',
  '      level: dead',
  '      reason: "ya no está"',
  '',
  '# lo de abajo no se toca',
  'deep_review: auto',
  '',
].join('\n');
const ARCHIVOS_APP = { [YAML]: YAML_BASE, 'src/legacy/a.js': '// viejo\n', 'src/billing/b.js': '// nuevo\n' };

/**
 * El sitio con la pestaña, un repo de producto `acme/app` por HTTP con su GitHub de juguete, `acme/web` que no se puede
 * traer y `acme/profile` (el perfil, que no es de producto). `fn` recibe los ayudantes.
 */
async function conRepo({ archivos = ARCHIVOS_APP, autoApply = false, sinSecreto = false, opciones = {} } = {}, fn) {
  let api; let r; let emisor; let h;
  try {
    api = await arrancarGithubFalso({ owner: 'acme', repo: 'app' });
    api.st.proteccion = { required_pull_request_reviews: { required_approving_review_count: 1 } };
    const raiz = tmp('site-repo-config-http-');
    r = await crearRepoHttp({ raiz, nombre: 'app.git', archivos, cabecera: CAB });
    const opsDoc = { version: 1, owners: { default: LEAD }, site: { maintainers: [LEAD], ...(autoApply ? { auto_apply: true } : {}) } };
    const ops = clon({ 'operations.json': opsDoc, 'scripts/nightly/dependencies/repos.json': { repos: [{ producto: 'App', github: 'acme/app' }, { producto: 'Web', github: 'acme/web' }, { producto: 'Perfil', github: 'acme/profile' }] } });
    const perfil = clon({ 'team-repos.json': { version: 1, public: GH('harness'), profile: GH('profile'), operations: GH('ops') } });
    const fuentes = H.fuentesFijas({ config: opsDoc, personas: { informados: null, repos: null } });
    fuentes.clones = () => ({ operaciones: { dir: ops }, perfil: { dir: perfil } });
    fuentes.dirBuzon = tmp('site-repo-config-buzon-');
    fuentes.exclusivo = (f) => f();
    const raizClones = tmp('site-repo-config-productos-');
    fuentes.clonDeProducto = ({ id, url }) => SRC.prepararClonDeEscritura({ dir: path.join(raizClones, id), url });
    emisor = await arrancarEmisor();
    const env = H.envBase({ SITE_OIDC_ISSUER: emisor.issuer, SITE_OPERATIONS_WRITE_TOKEN: ESCRITURA, ...PERFIL_ENV, ...(sinSecreto ? { SITE_OPERATIONS_TOKEN: ESCRITURA } : { SITE_PRODUCTS_WRITE_TOKEN: ESCRITURA }) });
    const cfg = validarConfiguracion(env).cfg;
    const urlDeProducto = (e) => (e.repo === 'app' ? r.url : 'http://127.0.0.1:1/web.git');
    const rutasExtra = TAB().crearRutas({ cfg, fuentes, versionImagen: '2026.10.22.48', ahora: () => AHORA, urlBase: { github: api.base }, urlDeProducto, ...opciones });
    h = await H.arrancarSitio({ env, fuentes, rutasExtra });
    const entrar = async (email) => (await H.ingresar(h, emisor, { sub: `s-${email}`, email, email_verified: true })).sesion;
    const lead = await entrar(LEAD);
    const pagina = await h.pedir('/configuracion', { cookie: lead });
    const tok = (/<meta name="site-token" content="([^"]+)">/.exec(pagina.texto) || [])[1];
    const config = async () => (await h.pedir('/api/config', { cookie: lead })).json;
    const repoDe = async (id, cookie = lead) => (await h.pedir(`/api/config/repo?id=${encodeURIComponent(id)}`, { cookie }));
    const post = async (ruta, cuerpo, cookie = lead, token = tok) => (await h.pedir(`/api/config/${ruta}`, { method: 'POST', cookie, body: JSON.stringify(cuerpo), headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json', 'x-site-token': token } }));
    const idDe = async (repo) => ((await config()).reposDeProducto.lista.find((x) => x.repo === repo) || {}).id;
    await fn({ h, r, api, entrar, lead, config, repoDe, post, idDe });
  } finally { await Promise.allSettled([h && h.cerrar && h.cerrar(), emisor && emisor.cerrar && emisor.cerrar(), r && r.cerrar(), api && api.cerrar()].filter(Boolean)); }
}
const deprecatedDe = (j) => j.claves.find((c) => c.clave === 'deprecated');

// ── T21 ──────────────────────────────────────────────────────────────────────────────────────────────────────────

// una clave de juguete, descrita como cualquier otra: la pantalla no la conoce y la muestra igual
const JUGUETE = { clave: 'toy_list', titulo: 'Lista de juguete', lector: 'toy-reader.js', forma: { lista: { campo: 'items', columnas: [{ campo: 'name', tipo: 'texto' }] } } };
const LECTOR_JUGUETE = {
  leerClave: (texto) => ({ presente: /^toy_list:/m.test(texto || ''), ilegible: null, valor: { items: [] }, problemas: [] }),
  revisarValor: (v) => ({ generales: [], filas: (v.items || []).map((f) => (f.name ? [] : ['falta `name`'])) }),
  escribirClave: (v) => `toy_list:\n  items:${(v.items || []).length ? '' : ' []'}\n${(v.items || []).map((f) => `    - name: "${f.name}"\n`).join('')}`,
};

test('T21 Sitio_SeccionPorRepo_Generica — una sección por repo de producto, cada clave con su lector, y lo que no se pudo mirar lo dice @story-8.95 @ac-13', { skip: SIN_BACKEND, timeout: 60000 }, async () => {
  const opciones = { clavesDelRepo: [...ORG.CLAVES_DEL_REPO, JUGUETE], lectores: { 'toy-reader.js': LECTOR_JUGUETE } };
  await conRepo({ opciones }, async ({ config, repoDe, idDe }) => {
    const todo = await config();
    const repos = todo.reposDeProducto.lista.map((x) => x.repo).sort();
    assert.deepStrictEqual(repos, ['app', 'web'], 'el perfil (y operaciones y el público) no son repos de producto');
    const app = (await repoDe(await idDe('app'))).json;
    assert.strictEqual(app.ok, true, JSON.stringify(app));
    assert.strictEqual(app.estado, 'leido');
    assert.deepStrictEqual(app.claves.map((c) => c.clave), ['deprecated', 'toy_list'], 'las dos claves, desde su descripción');
    const dep = deprecatedDe(app);
    assert.strictEqual(dep.estado, 'ok');
    assert.deepStrictEqual(dep.valor.paths.map((p) => p.path), ['src/legacy/**', 'src/no-existe/**']);
    assert.strictEqual(dep.forma.modo.campo, 'edit');
    // un lector que no sabe marcar lo podrido no dice «nada podrido»
    assert.strictEqual(app.claves.find((c) => c.clave === 'toy_list').podridas, null);
    // el que no se pudo traer: sólo lectura con el motivo, nunca «vacío»
    const web = (await repoDe(await idDe('web'))).json;
    assert.strictEqual(web.estado, 'no_se_pudo');
    assert.ok(web.motivo, 'dice por qué');
    assert.strictEqual(web.claves.length, 0, 'nada que editar sobre lo que no se miró');
  });
  // un repo sin el archivo: vacío y editable
  await conRepo({ archivos: { 'src/a.js': '//\n' } }, async ({ repoDe, idDe }) => {
    const app = (await repoDe(await idDe('app'))).json;
    assert.strictEqual(app.estado, 'nuevo');
    assert.strictEqual(app.oid, null);
    assert.deepStrictEqual(deprecatedDe(app).valor, { edit: 'warn', paths: [] });
  });
  // la clave escrita en una forma que la pantalla no reescribe: sólo lectura con el motivo, sin valor que editar
  await conRepo({ archivos: { [YAML]: 'deprecated: {}\ndeep_review: auto\n' } }, async ({ repoDe, idDe }) => {
    const dep = deprecatedDe((await repoDe(await idDe('app'))).json);
    assert.strictEqual(dep.estado, 'ilegible');
    assert.match(dep.motivo, /a mano/);
    assert.strictEqual(dep.valor, undefined);
  });
  // pase adversarial: un repo que sólo tiene `.tycon/advisors.yml` (el arnés lo lee): se muestra y se propone sobre ése
  const YML = '.tycon/advisors.yml';
  await conRepo({ archivos: { [YML]: YAML_BASE, 'src/legacy/a.js': '//\n' } }, async ({ repoDe, idDe, post, r }) => {
    const id = await idDe('app');
    const app = (await repoDe(id)).json;
    assert.strictEqual(app.estado, 'leido');
    assert.strictEqual(app.archivo, YML);
    assert.deepStrictEqual(deprecatedDe(app).valor.paths.map((p) => p.path), ['src/legacy/**', 'src/no-existe/**']);
    const prop = (await post('repo/proponer', { id, clave: 'deprecated', valor: { ...deprecatedDe(app).valor, edit: 'block' }, oid: app.oid })).json;
    assert.strictEqual(prop.ok, true, JSON.stringify(prop));
    const rama = r.empujes.at(-1).ref.replace('refs/heads/', '');
    assert.match(r.archivoEn(rama, YML), /edit: block/);
    assert.strictEqual(r.archivoEn(rama, YAML), null, 'no crea un .yaml al lado');
    // si mientras tanto aparece un `.yaml` en main (el arnés leería ése), no se propone sobre el `.yml`
    const otra = (await repoDe(id)).json;
    r.cambiar({ [YAML]: 'deep_review: auto\n' });
    const tarde = (await post('repo/proponer', { id, clave: 'deprecated', valor: { ...deprecatedDe(otra).valor, edit: 'warn' }, oid: otra.oid })).json;
    assert.strictEqual(tarde.codigo, 'cambio', JSON.stringify(tarde));
  });
});

// ── T22 ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test('T22 Sitio_FilaMalEscrita_NoSePropone — sin motivo, nivel inválido o edit inválido no se proponen; la podrida se marca @story-8.95 @ac-14', { skip: SIN_BACKEND, timeout: 60000 }, async () => {
  await conRepo({}, async ({ repoDe, post, idDe, r }) => {
    const id = await idDe('app');
    const app = (await repoDe(id)).json;
    const dep = deprecatedDe(app);
    // la fila de main que apunta a una ruta que no existe: marcada, sin impedir proponer
    assert.deepStrictEqual(dep.podridas.map((p) => [p.fila, p.motivo]), [[1, 'no-existe']]);
    const mal = { edit: 'warn', paths: [...dep.valor.paths, { path: 'src/x/**', level: 'frozen', reason: '' }, { path: 'src/y/**', level: 'viejo', reason: 'por algo' }] };
    const rev = (await post('repo/revisar', { id, clave: 'deprecated', valor: mal, oid: app.oid })).json;
    assert.strictEqual(rev.ok, false);
    assert.match(rev.filas[2].join(' '), /falta `reason`/);
    assert.match(rev.filas[3].join(' '), /`level: viejo` no es frozen ni dead/);
    assert.deepStrictEqual(rev.filas[0], []);
    const prop = (await post('repo/proponer', { id, clave: 'deprecated', valor: mal, oid: app.oid })).json;
    assert.strictEqual(prop.ok, false, 'no se propone');
    const edit = (await post('repo/revisar', { id, clave: 'deprecated', valor: { ...dep.valor, edit: 'nunca' }, oid: app.oid })).json;
    assert.strictEqual(edit.ok, false);
    assert.match(edit.problemas.join(' '), /`edit: nunca` no es warn ni block/);
    // la podrida sola sí se puede proponer
    const bien = (await post('repo/revisar', { id, clave: 'deprecated', valor: { ...dep.valor, edit: 'block' }, oid: app.oid })).json;
    assert.strictEqual(bien.ok, true, JSON.stringify(bien));
    assert.deepStrictEqual(r.empujes, [], 'revisar no empuja nada');
  });
  // la fila de main cuya fecha de revisión ya pasó (el reloj de la prueba está fijo en AHORA): marcada, y se puede
  // proponer igual
  const vencida = YAML_BASE.replace('      reason: "reemplazado por src/billing"\n', '      reason: "reemplazado por src/billing"\n      review_by: 2026-01-31\n');
  await conRepo({ archivos: { ...ARCHIVOS_APP, [YAML]: vencida } }, async ({ repoDe, post, idDe }) => {
    const id = await idDe('app');
    const app = (await repoDe(id)).json;
    const dep = deprecatedDe(app);
    assert.deepStrictEqual(dep.podridas.map((p) => [p.fila, p.motivo]), [[0, 'vencida'], [1, 'no-existe']]);
    assert.strictEqual((await post('repo/revisar', { id, clave: 'deprecated', valor: dep.valor, oid: app.oid })).json.ok, true);
  });
});

// ── T23 ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const FILA_NUEVA = { path: 'src/v1/**', level: 'dead', reason: "el v1 de 'cobros'", review_by: '2027-01-31' };
const YAML_ESPERADO = YAML_BASE.replace([
  '    - path: "src/no-existe/**"',
  '      level: dead',
  '      reason: "ya no está"',
].join('\n'), [
  '    - path: "src/no-existe/**"',
  '      level: dead',
  '      reason: "ya no está"',
  '    - path: "src/v1/**"',
  '      level: dead',
  '      reason: "el v1 de \'cobros\'"',
  '      review_by: 2027-01-31',
].join('\n'));

test('T23 Sitio_ProponeElPedido — el pedido trae el YAML esperado; quien no mantiene, 403; sin secreto, a mano; main cambiada, recargar @story-8.95 @ac-15', { skip: SIN_BACKEND, timeout: 90000 }, async () => {
  await conRepo({}, async ({ repoDe, post, idDe, r, api, entrar, h }) => {
    const id = await idDe('app');
    const app = (await repoDe(id)).json;
    assert.strictEqual(app.proponer.habilitado, true, JSON.stringify(app.proponer));
    const valor = { ...deprecatedDe(app).valor, paths: [...deprecatedDe(app).valor.paths, FILA_NUEVA] };
    const rev = (await post('repo/revisar', { id, clave: 'deprecated', valor, oid: app.oid })).json;
    assert.strictEqual(rev.ok, true, JSON.stringify(rev));
    assert.strictEqual(rev.texto, YAML_ESPERADO);
    assert.ok(rev.diferencia.length, 'la diferencia a la vista');
    // quien no mantiene: ni leer (un GET, sin token de por medio) ni proponer, aun con el token de su propia sesión; el
    // rechazo es por su rol, no por el token, y no empuja nada
    const dev = await entrar(DEV);
    assert.strictEqual((await repoDe(id, dev)).status, 403);
    const tokDev = (/<meta name="site-token" content="([^"]+)">/.exec((await h.pedir('/configuracion', { cookie: dev })).texto || '') || [])[1] || 'sin-token';
    const ajeno = await post('repo/proponer', { id, clave: 'deprecated', valor, oid: app.oid }, dev, tokDev);
    assert.strictEqual(ajeno.status, 403);
    assert.ok(!/token/i.test(JSON.stringify(ajeno.json || {})), `el rechazo no es el del token: ${JSON.stringify(ajeno.json)}`);
    assert.deepStrictEqual(r.empujes, []);
    const prop = (await post('repo/proponer', { id, clave: 'deprecated', valor, oid: app.oid })).json;
    assert.strictEqual(prop.ok, true, JSON.stringify(prop));
    const rama = r.empujes.at(-1).ref.replace('refs/heads/', '');
    assert.match(rama, /^team-config\/advisors-app-/, 'un id de rama por repo');
    assert.strictEqual(r.archivoEn(rama, YAML), YAML_ESPERADO);
    assert.strictEqual(api.st.pedidos.length, 1);
    // main cambió desde que se abrió: no se propone y se pide recargar
    r.cambiar({ [YAML]: `${YAML_BASE}# otro cambio\n` });
    const tarde = (await post('repo/proponer', { id, clave: 'deprecated', valor, oid: app.oid })).json;
    assert.strictEqual(tarde.ok, false);
    assert.strictEqual(tarde.codigo, 'cambio');
    assert.strictEqual(api.st.pedidos.length, 1, 'ningún pedido más');
  });
  // main sin política de revisión: no se propone y se dice; la identidad sin permiso de empujar: el «sin permiso»
  await conRepo({}, async ({ repoDe, post, idDe, r, api }) => {
    const id = await idDe('app');
    api.st.proteccion = null;
    const sinPolitica = (await repoDe(id)).json;
    assert.strictEqual(sinPolitica.proponer.habilitado, false);
    assert.match(sinPolitica.proponer.motivo, /política/);
    const valor = { ...deprecatedDe(sinPolitica).valor, edit: 'block' };
    const p1 = (await post('repo/proponer', { id, clave: 'deprecated', valor, oid: sinPolitica.oid })).json;
    assert.strictEqual(p1.ok, false);
    assert.deepStrictEqual(r.empujes, [], 'sin política, nada empujado');
    api.st.proteccion = { required_pull_request_reviews: { required_approving_review_count: 1 } };
    r.rechazarEmpuje = 403;
    const p2 = (await post('repo/proponer', { id, clave: 'deprecated', valor, oid: sinPolitica.oid })).json;
    assert.strictEqual(p2.ok, false);
    assert.strictEqual(p2.codigo, 'sin_permiso', JSON.stringify(p2));
    assert.strictEqual(api.st.pedidos.length, 0);
  });
  // sin el secreto (y con una credencial de lectura de operaciones que llega al repo): se ve lo declarado y se dice
  // cómo proponerlo a mano
  await conRepo({ sinSecreto: true }, async ({ repoDe, post, idDe, r }) => {
    const id = await idDe('app');
    const app = (await repoDe(id)).json;
    assert.strictEqual(app.estado, 'leido', 'sin el secreto, lee con la credencial de lectura de operaciones');
    assert.strictEqual(app.proponer.habilitado, false);
    assert.match(app.proponer.motivo, /a mano/);
    const prop = (await post('repo/proponer', { id, clave: 'deprecated', valor: deprecatedDe(app).valor, oid: app.oid })).json;
    assert.strictEqual(prop.ok, false);
    assert.deepStrictEqual(r.empujes, []);
  });
});

// ── T24 ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test('T24 Sitio_ElRestoDelYamlQuedaIgual — sólo cambia el bloque de la clave; sin archivo, se crea con esa sola clave @story-8.95 @ac-15', () => {
  const bloque = DEP.escribirClave({ edit: 'block', paths: [] });
  const nuevo = ORG.reemplazarBloque(YAML_BASE, 'deprecated', bloque);
  assert.strictEqual(nuevo.ilegible, undefined);
  const antes = YAML_BASE.split('\n'); const despues = nuevo.texto.split('\n');
  assert.deepStrictEqual(despues.slice(0, 4), antes.slice(0, 4), 'lo de arriba, igual');
  assert.deepStrictEqual(despues.slice(-4), antes.slice(-4), 'lo de abajo (comentario y otra clave), igual');
  assert.ok(nuevo.texto.includes('deprecated:\n  edit: block\n  paths: []\n'), nuevo.texto);
  // sin la clave: va al final; sin archivo: sólo ella
  assert.strictEqual(ORG.reemplazarBloque('deep_review: auto\n', 'deprecated', bloque).texto, `deep_review: auto\n\n${bloque}`);
  assert.strictEqual(ORG.reemplazarBloque(null, 'deprecated', bloque).texto, bloque);
  // con fin de línea de Windows, el archivo sigue con el suyo
  const crlf = ORG.reemplazarBloque(YAML_BASE.replace(/\n/g, '\r\n'), 'deprecated', bloque).texto;
  assert.ok(!/[^\r]\n/.test(crlf), 'todo con \\r\\n');
  // la clave escrita en otra forma: no se reescribe a ciegas
  assert.ok(ORG.reemplazarBloque('deprecated: {}\n', 'deprecated', bloque).ilegible);
  // pase adversarial: con finales de línea mezclados, cada renglón de afuera conserva el suyo
  const mezclado = 'a: 1\r\nb: 2\n\ndeprecated:\r\n  edit: warn\r\n  paths: []\r\n# abajo\nc: 3\r\n';
  const m = ORG.reemplazarBloque(mezclado, 'deprecated', bloque).texto;
  assert.ok(m.startsWith('a: 1\r\nb: 2\n\n'), JSON.stringify(m));
  assert.ok(m.endsWith('# abajo\nc: 3\r\n'), JSON.stringify(m));
});

// ── T25 ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test('T25 Sitio_ValidaIgualQueElArnes — los mismos rechazos con los mismos motivos que deprecated.parsear @story-8.95 @ac-14', () => {
  const desc = ORG.CLAVES_DEL_REPO.find((d) => d.clave === 'deprecated');
  const lector = ORG.lectorDeClave(ROOT, desc, {});
  const filas = [
    { path: '', level: 'frozen', reason: 'x' },
    { path: 'a/**', level: 'viejo', reason: 'x' },
    { path: 'b/**', level: 'dead', reason: '' },
    { path: '/abs/c', level: 'dead', reason: 'x' },
    { path: 'd/**', level: 'frozen', reason: 'x', review_by: 'mañana' },
    { path: 'e/**', level: 'frozen', reason: 'ok' },
  ];
  const sitio = ORG.revisarClaveDelRepo({ descriptor: desc, lector, texto: YAML_BASE, valor: { edit: 'warn', paths: filas } });
  assert.strictEqual(sitio.ok, false);
  // el arnés, sobre el texto que se propondría con todas las filas
  const propuesto = ORG.reemplazarBloque(YAML_BASE, 'deprecated', DEP.escribirClave({ edit: 'warn', paths: filas })).texto;
  const arnes = DEP.parsear(propuesto).problems.map((p) => p.motivo.replace(/^línea \d+: /, ''));
  const delSitio = sitio.filas.flat();
  assert.deepStrictEqual(delSitio.sort(), arnes.sort());
  assert.deepStrictEqual(sitio.filas[5], [], 'la buena, sin motivo');
  // lo que se escribe se vuelve a leer igual (comillas, numerales, apóstrofos)
  const raras = [{ path: 'src/a b/**', level: 'frozen', reason: 'usa "comillas" # y numeral' }, { path: 'x/**', level: 'dead', reason: "lleva 'simples'" }];
  const vuelta = lector.leerClave(lector.escribirClave({ edit: 'block', paths: raras }));
  assert.deepStrictEqual(vuelta.valor, { edit: 'block', paths: raras });
  // las dos comillas a la vez o un salto de línea no se pueden escribir: se dice, no se rompe el archivo
  const r2 = ORG.revisarClaveDelRepo({ descriptor: desc, lector, texto: '', valor: { edit: 'warn', paths: [{ path: 'q/**', level: 'dead', reason: 'a "b" \'c\'' }, { path: 'n/**', level: 'dead', reason: 'a\nb' }] } });
  assert.strictEqual(r2.ok, false);
  assert.ok(r2.filas[0].length && r2.filas[1].length, JSON.stringify(r2.filas));

  // pase adversarial: una fila mal escrita en main se corrige en la pantalla, con el campo nuevo al final del objeto
  const conHueco = 'deprecated:\n  edit: warn\n  paths:\n    - path: "src/a"\n      reason: "x"\n';
  const leida = lector.leerClave(conHueco).valor;
  leida.paths[0].level = 'frozen';
  assert.strictEqual(ORG.revisarClaveDelRepo({ descriptor: desc, lector, texto: conHueco, valor: leida }).ok, true, 'el orden de los campos no importa');
  // una ruta que el arnés normaliza (`./`, barras invertidas) no se rechaza por eso
  for (const p of ['./src/a', 'src\\a']) {
    const r3 = ORG.revisarClaveDelRepo({ descriptor: desc, lector, texto: conHueco, valor: { edit: 'warn', paths: [{ path: p, level: 'frozen', reason: 'x' }] } });
    assert.strictEqual(r3.ok, true, `${p}: ${JSON.stringify(r3)}`);
  }
  // un comentario pegado al margen dentro del bloque no esconde `edit: block` (antes el sitio mostraba warn y aflojaba)
  const conComentario = 'deprecated:\n# el modo\n  edit: block\n  paths:\n    - path: "src/a"\n      level: frozen\n      reason: "x"\n';
  assert.strictEqual(DEP.parsear(conComentario).edit, 'block');
  assert.strictEqual(lector.leerClave(conComentario).valor.edit, 'block');
  // con dos `edit:` el sitio muestra el mismo que aplica el arnés (revisión de seguridad, mirada extra)
  const dosEdit = 'deprecated:\n  edit: warn\n  edit: block\n  paths: []\n';
  assert.strictEqual(lector.leerClave(dosEdit).valor.edit, DEP.parsear(dosEdit).edit);
  // una fecha de revisión mal escrita llega a la pantalla tal cual, con su problema en la fila, y no se pierde al proponer
  const fechaMal = 'deprecated:\n  edit: warn\n  paths:\n    - path: "src/a"\n      level: frozen\n      reason: "x"\n      review_by: 2026-1-1\n';
  const lf = lector.leerClave(fechaMal);
  assert.strictEqual(lf.valor.paths[0].review_by, '2026-1-1');
  assert.deepStrictEqual(lf.problemas.map((p) => p.fila), [0]);
  assert.strictEqual(ORG.revisarClaveDelRepo({ descriptor: desc, lector, texto: fechaMal, valor: lf.valor }).ok, false, 'no se propone sin corregirla');
  // una ruta con espacios en los bordes no alcanza ningún archivo: no se propone
  const espacios = ORG.revisarClaveDelRepo({ descriptor: desc, lector, texto: '', valor: { edit: 'warn', paths: [{ path: ' src/a ', level: 'frozen', reason: 'x' }] } });
  assert.match(espacios.filas[0].join(' '), /espacios/);
});

// ── T26 ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test('T26 Sitio_SecretoDeProductos_SoloPedidos — con auto_apply prendido igual: sólo una rama team-config sin forzar y un pedido sin completar @story-8.95 @ac-15', { skip: SIN_BACKEND, timeout: 90000 }, async () => {
  await conRepo({ autoApply: true }, async ({ repoDe, post, idDe, r, api }) => {
    const id = await idDe('app');
    const app = (await repoDe(id)).json;
    const valor = { ...deprecatedDe(app).valor, paths: [...deprecatedDe(app).valor.paths, FILA_NUEVA] };
    const prop = (await post('repo/proponer', { id, clave: 'deprecated', valor, oid: app.oid })).json;
    assert.strictEqual(prop.ok, true, JSON.stringify(prop));
    assert.ok(prop.enlace, 'el enlace del pedido');
    assert.ok(!/aplicad|applied/i.test(prop.message), `nunca «aplicado»: ${prop.message}`);
    assert.ok(r.empujes.length >= 1);
    for (const e of r.empujes) {
      assert.match(e.ref, /^refs\/heads\/team-config\//, `sólo ramas de propuesta: ${e.ref}`);
      assert.notStrictEqual(e.ref, 'refs/heads/main');
      assert.strictEqual(e.forzado, false, 'sin --force');
    }
    assert.deepStrictEqual(api.prohibidas(), [], 'ni merge ni auto-merge');
    assert.ok(!api.llamadas.some((c) => /\/reviews\b/.test(c.ruta) && c.method === 'POST'), 'ni aprueba el pedido');
    assert.strictEqual(api.st.pedidos.length, 1);
    assert.ok(!api.st.pedidos[0].merged_at, 'el pedido queda abierto');
  });
});
