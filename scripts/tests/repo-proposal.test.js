'use strict';
/*
 * repo-proposal.test.js — la propuesta por rama y pedido desde el clon del sitio (story 2.29, AC 14 a 16 y 18).
 *
 * T15  Proponer_RamaCommitEmpujeYPedido_AzureYGithub      T26  Proponer_PedidoAbiertoSobreElArchivo_MuestraElEnlace
 * T15b Credencial_NuncaEnDiscoNiEnRegistro                T27  Proponer_RamaPrincipalSinPolitica_Apagado
 * T18  FallaAMitad_DiceLoQueQuedo                         T16b Proponer_ArchivoCambio_NoCreaNada
 *
 * Sin red: el repo de operaciones es un repo git local por HTTP que anota cada empuje (lib/git-http-repo.js); las APIs
 * de Azure DevOps y de GitHub son servidores falsos en el proceso (lib/fake-ado-api.js, lib/fake-github-api.js) que
 * anotan cada llamada. Correos, organizaciones y repos inventados.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { crearRepoHttp, hayHttpBackend } = require('./lib/git-http-repo.js');
const { arrancarAdoFalso } = require('./lib/fake-ado-api.js');
const { arrancarGithubFalso } = require('./lib/fake-github-api.js');
const propuesta = require('../lib/repo-proposal.js');

const { proponer, politicaDeRevision, pedidoAbierto, remoteOf } = propuesta;

// sin git http-backend se saltea con constancia; en CI (CI=true) NO se saltea: un «verde» con estas pruebas salteadas no
// cubre los AC 14 a 16 (el mismo criterio que site-sources.test.js)
const SIN_BACKEND = !hayHttpBackend() && !process.env.CI && 'git http-backend no está en esta máquina: el repo por HTTP no se puede armar';
// stable-data: el token nace al correr, nunca escrito; la hora de cada propuesta se pasa (`now`), nunca se lee del reloj
const TOKEN = `tok-${crypto.randomBytes(8).toString('hex')}`;
const CABECERA = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`;
const AHORA = new Date('2026-10-16T10:20:30Z');
const DESPUES = new Date('2026-10-16T10:25:00Z');
const SELLO = '20261016-102030';
const QUIEN = 'lead@acme.example';
const REMOTO_AZURE = remoteOf('https://dev.azure.com/acme/Proy/_git/ops');
const REMOTO_GITHUB = remoteOf('https://github.com/acme/ops.git');
const OPS_BASE = { version: 1, owners: { default: 'lead@acme.example' }, site: { maintainers: ['lead@acme.example'] } };
const CONTENIDO_NUEVO = `${JSON.stringify({ ...OPS_BASE, owners: { default: 'lead@acme.example', fallback: 'ops@acme.example' } }, null, 2)}\n`;

const temporales = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temporales.push(d); return d; };
test.after(() => { for (const d of temporales) fs.rmSync(d, { recursive: true, force: true }); });

const gitSync = (cwd, args, env = {}) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...env } });

/**
 * El clon superficial del sitio (como lo deja sources.js): la credencial sólo por GIT_CONFIG_*. Asíncrono a propósito:
 * el repo por HTTP vive en este mismo proceso y un `spawnSync` que le hable lo dejaría sin bucle para contestar.
 */
async function clonarComoElSitio(r, raiz) {
  const clon = path.join(raiz, 'operaciones');
  const origen = new URL(r.url).origin;
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: `http.${origen}/.extraheader`, GIT_CONFIG_VALUE_1: `Authorization: ${CABECERA}` };
  const c = await propuesta.correrGit(['clone', '-q', '--depth', '1', '--branch', 'main', '--single-branch', '--no-tags', r.url, clon], { cwd: raiz, env });
  assert.strictEqual(c.status, 0, c.stderr);
  return clon;
}

/** Un `git` espía: anota cada argv y delega en el de verdad. */
function gitEspia() {
  const llamadas = [];
  const g = (args, opts) => { llamadas.push({ args, cwd: opts && opts.cwd }); return propuesta.correrGit(args, opts); };
  g.llamadas = llamadas;
  return g;
}

/** Repo + clon + (ADO o GitHub falsos), con una política de revisión en main. */
async function montar({ plataforma = 'azure', politica = true, tokenApi = `api-${crypto.randomBytes(4).toString('hex')}` } = {}) {
  const raiz = tmp('repo-prop-');
  const r = await crearRepoHttp({ raiz, nombre: 'ops.git', archivos: { 'operations.json': OPS_BASE, 'README.md': 'ops\n' }, cabecera: CABECERA });
  const clon = await clonarComoElSitio(r, raiz);
  const api = plataforma === 'azure' ? await arrancarAdoFalso({ org: 'acme', project: 'Proy', repo: 'ops', token: tokenApi }) : await arrancarGithubFalso({ owner: 'acme', repo: 'ops', token: tokenApi });
  if (plataforma === 'azure') api.st.politicas = politica ? [api.politicaDeRevisores(1)] : [];
  else api.st.proteccion = politica ? { required_pull_request_reviews: { required_approving_review_count: 1 } } : null;
  const registro = [];
  const git = gitEspia();
  const base = () => ({
    clon, archivo: 'operations.json', contenido: CONTENIDO_NUEVO, oidEsperado: r.oidDe('refs/heads/main', 'operations.json'), idCorto: 'operations', secciones: ['Responsables'], quien: QUIEN,
    credencial: { git: TOKEN, api: tokenApi }, remote: plataforma === 'azure' ? REMOTO_AZURE : REMOTO_GITHUB,
    urlBase: plataforma === 'azure' ? { azure: api.base } : { github: api.base }, now: AHORA, git, log: (l) => registro.push(l),
  });
  return { raiz, r, clon, api, git, registro, base, cerrar: async () => { await api.cerrar(); await r.cerrar(); } };
}

const oidDe = (r, ruta) => r.oidDe('refs/heads/main', ruta);
const clonLimpio = (clon) => {
  assert.strictEqual(gitSync(clon, ['status', '--porcelain']).stdout, '', 'git status del clon limpio');
  assert.strictEqual(gitSync(clon, ['symbolic-ref', 'HEAD']).stdout.trim(), 'refs/heads/main', 'HEAD sigue en main');
};
const textoDe = (x) => JSON.stringify(x);

test('T15 Proponer_RamaCommitEmpujeYPedido_AzureYGithub @story-2.29 @ac-14 @ac-15', { skip: SIN_BACKEND }, async () => {
  for (const plataforma of ['azure', 'github']) {
    const m = await montar({ plataforma });
    try {
      const puntaAntes = m.r.ref('refs/heads/main');
      const res = await proponer(m.base());
      assert.strictEqual(res.ok, true, textoDe(res));
      assert.strictEqual(res.rama, `team-config/operations-${SELLO}`);
      assert.ok(res.message.startsWith('Pedido abierto: '), res.message);
      assert.ok(res.enlace && res.message.includes(res.enlace), 'el mensaje trae el enlace del pedido');
      // la rama, desde la punta de main, con UN commit de UN archivo y el autor del sitio
      const sha = m.r.ref(`refs/heads/${res.rama}`);
      assert.ok(sha, 'la rama existe en el repo');
      assert.strictEqual(m.r.ref('refs/heads/main'), puntaAntes, 'main no se movió');
      assert.strictEqual(gitSync(m.r.bare, ['rev-parse', `${sha}^`]).stdout.trim(), puntaAntes, 'el padre del commit es la punta de main');
      assert.deepStrictEqual(gitSync(m.r.bare, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha]).stdout.trim().split('\n'), ['operations.json']);
      assert.strictEqual(m.r.archivoEn(res.rama, 'operations.json'), CONTENIDO_NUEVO);
      assert.strictEqual(m.r.archivoEn(res.rama, 'README.md'), 'ops\n', 'el resto del árbol queda igual');
      assert.strictEqual(gitSync(m.r.bare, ['log', '-1', '--format=%an <%ae>', sha]).stdout.trim(), 'Sitio de la organización <sitio@localhost>');
      assert.strictEqual(gitSync(m.r.bare, ['log', '-1', '--format=%s', sha]).stdout.trim(), 'Configuración de la organización: operations.json');
      // cero empujes a main, ninguno forzado
      assert.deepStrictEqual(m.r.empujes.map((e) => e.ref), [`refs/heads/${res.rama}`]);
      assert.ok(m.r.empujes.every((e) => !e.forzado), 'ningún empuje forzado');
      assert.ok(m.r.pedidos.length > 0 && m.r.pedidos.every((p) => p.conCabecera), 'cada pedido al repo lleva la cabecera');
      // la credencial no está en el disco ni en los argumentos
      assert.ok(!fs.readFileSync(path.join(m.clon, '.git', 'config'), 'utf8').includes(TOKEN), 'el token no está en .git/config');
      assert.ok(!fs.readFileSync(path.join(m.clon, '.git', 'config'), 'utf8').includes(CABECERA), 'la cabecera no está en .git/config');
      assert.ok(m.git.llamadas.length > 0 && m.git.llamadas.every((c) => !c.args.join(' ').includes(TOKEN)), 'el token no va en ningún argumento de git');
      // el pedido: hacia main, con quién y las secciones; nunca auto-completar, merge ni PATCH
      const abiertos = m.api.llamadas.filter((l) => l.method === 'POST' && /pullrequests$|\/pulls$/.test(l.ruta));
      assert.strictEqual(abiertos.length, 1, textoDe(m.api.llamadas));
      const cuerpo = abiertos[0].cuerpo;
      const destino = plataforma === 'azure' ? cuerpo.targetRefName : cuerpo.base;
      const origenRama = plataforma === 'azure' ? cuerpo.sourceRefName : cuerpo.head;
      assert.strictEqual(destino, plataforma === 'azure' ? 'refs/heads/main' : 'main');
      assert.ok(origenRama.endsWith(res.rama), origenRama);
      assert.strictEqual(cuerpo.title, 'Configuración de la organización: operations.json');
      const texto = plataforma === 'azure' ? cuerpo.description : cuerpo.body;
      assert.ok(texto.includes(`Pedido por ${QUIEN} desde el sitio`) && texto.includes('Secciones cambiadas: Responsables'), texto);
      assert.deepStrictEqual(m.api.prohibidas(), [], 'ninguna llamada que complete, mergee o edite el pedido');
      assert.ok(m.api.llamadas.every((l) => l.auth), 'toda llamada a la API lleva la credencial');
      // el clon, intacto
      clonLimpio(m.clon);
      assert.ok(!gitSync(m.clon, ['branch', '--list']).stdout.includes('team-config/'), 'el clon no tiene la rama');
    } finally { await m.cerrar(); }
  }
});

test('T15b Credencial_NuncaEnDiscoNiEnRegistro @story-2.29 @ac-14', { skip: SIN_BACKEND }, async () => {
  const m = await montar({ plataforma: 'github' });
  try {
    const res = await proponer(m.base());
    assert.strictEqual(res.ok, true, textoDe(res));
    // con una API que se cae nombrando la credencial en el error: el mensaje tampoco la trae
    const rota = await proponer({ ...m.base(), now: DESPUES, fetch: async () => { throw new Error(`se cayó con ${TOKEN} y ${CABECERA}`); } });
    assert.strictEqual(rota.ok, false);
    const archivosDeGit = [];
    const caminar = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'objects' && e.name !== 'pack') caminar(p); } else archivosDeGit.push(p); } };
    caminar(path.join(m.clon, '.git'));
    assert.ok(archivosDeGit.length > 0);
    for (const f of archivosDeGit) {
      const t = fs.readFileSync(f, 'latin1');
      assert.ok(!t.includes(TOKEN) && !t.includes(CABECERA), `la credencial está en ${path.relative(m.clon, f)}`);
    }
    const todo = `${m.registro.join('\n')}\n${textoDe(res)}\n${textoDe(rota)}`;
    assert.ok(!todo.includes(TOKEN) && !todo.includes(CABECERA), 'la credencial no está en el registro ni en los resultados');
    assert.ok(!todo.includes(m.base().credencial.api), 'la credencial de la API tampoco');
  } finally { await m.cerrar(); }
});

test('T18 FallaAMitad_DiceLoQueQuedo @story-2.29 @ac-18', { skip: SIN_BACKEND }, async () => {
  // 403 al empujar: «no tiene permiso en <repo>», nada creado
  let m = await montar({ plataforma: 'azure' });
  try {
    m.r.rechazarEmpuje = 403;
    const res = await proponer(m.base());
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.codigo, 'sin_permiso');
    assert.ok(res.message.includes('no tiene permiso en ops'), res.message);
    assert.ok(!res.message.includes('Pedido abierto'));
    assert.deepStrictEqual(m.r.empujes, []);
    assert.strictEqual(m.api.llamadas.filter((l) => l.method === 'POST').length, 0, 'sin rama no se abre pedido');
    clonLimpio(m.clon);
  } finally { await m.cerrar(); }
  // rama creada y 500 al abrir el pedido: el nombre de la rama y el enlace manual, nunca «pedido abierto»
  for (const plataforma of ['azure', 'github']) {
    m = await montar({ plataforma });
    try {
      m.api.st.fallarPedido = 500;
      const res = await proponer(m.base());
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.codigo, 'pedido_no_abierto');
      assert.strictEqual(res.rama, `team-config/operations-${SELLO}`);
      assert.ok(m.r.ref(`refs/heads/${res.rama}`), 'la rama sí quedó en el repo');
      assert.ok(res.message.includes(`subió a la rama ${res.rama}`) && res.message.includes('no pude abrir el pedido'), res.message);
      assert.ok(res.manual && res.message.includes(`Abrilo desde: ${res.manual}`), res.message);
      assert.ok(res.manual.includes(plataforma === 'azure' ? 'pullrequestcreate' : '/compare/'), res.manual);
      assert.ok(!/pedido abierto/i.test(res.message), 'nunca «pedido abierto» si no se abrió');
      clonLimpio(m.clon);
    } finally { await m.cerrar(); }
  }
});

test('T26 Proponer_PedidoAbiertoSobreElArchivo_MuestraElEnlace @story-2.29 @ac-16', { skip: SIN_BACKEND }, async () => {
  for (const plataforma of ['azure', 'github']) {
    const m = await montar({ plataforma });
    try {
      const primera = await proponer(m.base());
      assert.strictEqual(primera.ok, true, textoDe(primera));
      const segunda = await proponer({ ...m.base(), secciones: ['Mantenedores'], now: DESPUES });
      assert.strictEqual(segunda.ok, false);
      assert.strictEqual(segunda.codigo, 'pedido_abierto');
      assert.strictEqual(segunda.enlace, primera.enlace);
      assert.ok(segunda.message.includes(`ya hay un pedido abierto sobre este archivo: ${primera.enlace}`), segunda.message);
      assert.strictEqual(m.r.empujes.length, 1, 'la segunda no empuja nada');
      assert.strictEqual(m.api.llamadas.filter((l) => l.method === 'POST').length, 1, 'un solo pedido abierto');
      assert.strictEqual(await pedidoAbierto({ remote: m.base().remote, credencial: m.base().credencial, idCorto: 'repos', urlBase: m.base().urlBase }), null, 'otro archivo no lo ve');
      clonLimpio(m.clon);
    } finally { await m.cerrar(); }
  }
});

test('T27 Proponer_RamaPrincipalSinPolitica_Apagado @story-2.29 @ac-15', { skip: SIN_BACKEND }, async () => {
  const SIN = 'el repo no tiene una política que pida revisión en main';
  for (const plataforma of ['azure', 'github']) {
    const m = await montar({ plataforma, politica: false });
    try {
      const b = m.base();
      const args = { remote: b.remote, credencial: b.credencial, urlBase: b.urlBase };
      // sin política
      let p = await politicaDeRevision(args);
      assert.strictEqual(p.ok, false); assert.strictEqual(p.codigo, 'sin_politica'); assert.ok(p.message.includes(SIN), p.message);
      // GitHub: tampoco con reglas vacías; con una regla que pide revisión, sí
      if (plataforma === 'github') {
        m.api.st.reglas = [{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }];
        p = await politicaDeRevision(args);
        assert.strictEqual(p.ok, true, textoDe(p));
        m.api.st.reglas = [];
      }
      // con política
      if (plataforma === 'azure') m.api.st.politicas = [m.api.politicaDeRevisores(1)]; else m.api.st.proteccion = { required_pull_request_reviews: { required_approving_review_count: 2 } };
      p = await politicaDeRevision(args);
      assert.strictEqual(p.ok, true, textoDe(p));
      assert.ok(p.detalle.includes('revisor'), p.detalle);
      // una política que no bloquea o pide cero revisores no cuenta (Azure)
      if (plataforma === 'azure') {
        m.api.st.politicas = [{ ...m.api.politicaDeRevisores(1), isBlocking: false }];
        assert.strictEqual((await politicaDeRevision(args)).ok, false);
        m.api.st.politicas = [m.api.politicaDeRevisores(0)];
        assert.strictEqual((await politicaDeRevision(args)).ok, false);
      }
      // 403 al leer
      m.api.st.politicas403 = true;
      p = await politicaDeRevision(args);
      assert.strictEqual(p.ok, false); assert.strictEqual(p.codigo, 'no_se_pudo_leer'); assert.ok(p.message.includes('no pude leer la política de la rama main'), p.message);
      m.api.st.politicas403 = false;
      // sin política, proponer no crea nada
      if (plataforma === 'azure') m.api.st.politicas = []; else m.api.st.proteccion = null;
      const res = await proponer(b);
      assert.strictEqual(res.ok, false); assert.strictEqual(res.codigo, 'sin_politica'); assert.ok(res.message.includes(SIN));
      assert.deepStrictEqual(m.r.empujes, []);
      assert.strictEqual(m.api.llamadas.filter((l) => l.method === 'POST').length, 0);
      clonLimpio(m.clon);
    } finally { await m.cerrar(); }
  }
  // una plataforma que no se reconoce
  const p = await politicaDeRevision({ remote: remoteOf('https://git.acme.example/ops.git'), credencial: { git: 'x', api: 'x' } });
  assert.strictEqual(p.codigo, 'plataforma_desconocida');
});

test('T16b Proponer_ArchivoCambio_NoCreaNada @story-2.29 @ac-16', { skip: SIN_BACKEND }, async () => {
  const m = await montar({ plataforma: 'azure' });
  try {
    const oidViejo = oidDe(m.r, 'operations.json');
    assert.ok(oidViejo);
    m.r.cambiar({ 'operations.json': { ...OPS_BASE, owners: { default: 'otra@acme.example' } } });
    assert.notStrictEqual(oidDe(m.r, 'operations.json'), oidViejo);
    const res = await proponer({ ...m.base(), oidEsperado: oidViejo });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.codigo, 'cambio');
    assert.ok(res.message.includes('el archivo cambió desde que lo abriste: recargá'), res.message);
    assert.deepStrictEqual(m.r.empujes, [], 'cero empujes');
    assert.strictEqual(m.api.llamadas.filter((l) => l.method === 'POST').length, 0);
    clonLimpio(m.clon);
    // con el oid al día, propone
    const ok = await proponer({ ...m.base(), oidEsperado: oidDe(m.r, 'operations.json'), now: DESPUES });
    assert.strictEqual(ok.ok, true, textoDe(ok));
    // una plataforma que no se reconoce: nada, y lo dice
    const otra = await proponer({ ...m.base(), remote: remoteOf('https://git.acme.example/ops.git'), now: DESPUES });
    assert.strictEqual(otra.codigo, 'plataforma_desconocida');
    assert.ok(otra.message.includes('abrí el pedido a mano'));
    assert.strictEqual(m.r.empujes.length, 1);
    clonLimpio(m.clon);
  } finally { await m.cerrar(); }
});

// ── vuelta 2 (revisores y pase adversarial de la 2.29) ───────────────────────────────────────────────────────────
test('T26b Proponer_SinPoderMirarLosPedidosAbiertos_NoCreaNada @story-2.29 @ac-16 — «no pude mirar» no es «no hay»', { skip: SIN_BACKEND }, async () => {
  for (const plataforma of ['azure', 'github']) {
    const m = await montar({ plataforma });
    try {
      // la lista de pedidos abiertos contesta 500; la política sí contesta (otro endpoint): antes se abría un duplicado
      const caida = (url, o) => ((!o || !o.method || o.method === 'GET') && /pullrequests\?|\/pulls\?/.test(String(url)) ? Promise.resolve(new Response('{}', { status: 500 })) : fetch(url, o));
      const res = await proponer({ ...m.base(), fetch: caida });
      assert.strictEqual(res.ok, false, textoDe(res));
      assert.strictEqual(res.codigo, 'no_se_pudo_leer');
      assert.match(res.message, /no pude verificar si ya hay un pedido abierto sobre este archivo/);
      assert.strictEqual(m.r.empujes.length, 0, 'cero ramas');
      clonLimpio(m.clon);
    } finally { await m.cerrar(); }
  }
});

test('T15c Registro_SinElCorreoDeQuienPropone @story-2.29 @ac-14 — el registro del sitio dice archivo y rama, no la persona', { skip: SIN_BACKEND }, async () => {
  const m = await montar({ plataforma: 'github' });
  try {
    const res = await proponer(m.base());
    assert.strictEqual(res.ok, true, textoDe(res));
    assert.ok(m.registro.length > 0);
    assert.ok(!m.registro.join('\n').includes(QUIEN), 'el correo no va al registro (sí al cuerpo del pedido)');
  } finally { await m.cerrar(); }
});

test('T28b RemoteOf_VisualstudioConUsuario_SinElUsuario @story-2.29 @ac-15', () => {
  const { remoteOf } = require(path.join(ROOT, 'scripts', 'lib', 'repo-proposal.js'));
  for (const f of [remoteOf, require(path.join(ROOT, 'scripts', 'lib', 'org-config.js')).remoteOf]) {
    // la dirección con usuario, armada por partes: escrita entera tiene forma de correo y el freno de publicación la para
    const r = f(['https://acme', 'acme.visualstudio.com/Proj/_git/repo'].join('@'));
    assert.strictEqual(r.org, 'acme');
    assert.strictEqual(r.web, 'https://dev.azure.com/acme/Proj/_git/repo');
  }
});

// ── la política con filtro de ruta de Azure DevOps, archivo por archivo (T39-T41) ───────────
/** Una «Required reviewers» bloqueante, con su filtro de ruta. */
const requeridos = (api, { patrones = ['/operations.json', '/pipelines/*'], n = 1, votoDelAutor = false } = {}) => ({
  isEnabled: true, isBlocking: true, type: { displayName: 'Required reviewers' },
  settings: { minimumApproverCount: n, creatorVoteCounts: votoDelAutor, addedFilesOnly: false, requiredReviewerIds: ['grupo-de-quienes-mantienen'], filenamePatterns: patrones,
    scope: [{ refName: 'refs/heads/main', matchKind: 'Exact', repositoryId: api.st.repoId }] },
});

test('T39 Politica_RequiredReviewersCubreElArchivo @story-2.30 @ac-22b', { skip: SIN_BACKEND }, async () => {
  const m = await montar({ plataforma: 'azure', politica: false });
  try {
    const b = m.base();
    const args = { remote: b.remote, credencial: b.credencial, urlBase: b.urlBase };
    m.api.st.politicas = [requeridos(m.api)];
    // los dos archivos protegidos por el filtro de la receta alternativa
    for (const archivo of ['operations.json', 'pipelines/dependency-audit.yml']) {
      const p = await politicaDeRevision({ ...args, archivo });
      assert.strictEqual(p.ok, true, `${archivo}: ${textoDe(p)}`);
      assert.ok(p.detalle.includes('revisor'), p.detalle);
    }
    // y proponer, con esa política, sí crea la rama y el pedido
    const res = await proponer(b);
    assert.strictEqual(res.ok, true, textoDe(res));
  } finally { await m.cerrar(); }
});

test('T40 Politica_FiltroQueNoCubre_NoHabilita @story-2.30 @ac-22b', { skip: SIN_BACKEND }, async () => {
  const m = await montar({ plataforma: 'azure', politica: false });
  try {
    const b = m.base();
    const args = { remote: b.remote, credencial: b.credencial, urlBase: b.urlBase };
    m.api.st.politicas = [requeridos(m.api)];
    const archivo = 'scripts/nightly/dependencies/repos.json';
    let p = await politicaDeRevision({ ...args, archivo });
    assert.strictEqual(p.ok, false, textoDe(p));
    assert.strictEqual(p.codigo, 'no_cubre');
    assert.ok(p.message.includes(`la política de main no cubre ${archivo}`), p.message);
    // una exclusión del filtro tampoco cubre
    m.api.st.politicas = [requeridos(m.api, { patrones: ['/*', '!/operations.json'] })];
    p = await politicaDeRevision({ ...args, archivo: 'operations.json' });
    assert.strictEqual(p.ok, false, textoDe(p));
    // sin archivo, una política con filtro no habilita (no se sabe qué se propone)
    m.api.st.politicas = [requeridos(m.api)];
    assert.strictEqual((await politicaDeRevision(args)).ok, false);
    // proponer un archivo que el filtro no cubre no crea nada
    const res = await proponer({ ...b, archivo: 'README.md', oidEsperado: oidDe(m.r, 'README.md') });
    assert.strictEqual(res.ok, false, textoDe(res));
    assert.strictEqual(res.codigo, 'no_cubre');
    assert.deepStrictEqual(m.r.empujes, []);
    clonLimpio(m.clon);
  } finally { await m.cerrar(); }
});

test('T41 Politica_VotoDeQuienCrea_NoCuenta @story-2.30 @ac-22b', { skip: SIN_BACKEND }, async () => {
  const m = await montar({ plataforma: 'azure', politica: false });
  try {
    const b = m.base();
    const args = { remote: b.remote, credencial: b.credencial, urlBase: b.urlBase, archivo: 'operations.json' };
    m.api.st.politicas = [{ ...m.api.politicaDeRevisores(1), settings: { ...m.api.politicaDeRevisores(1).settings, creatorVoteCounts: true } }];
    assert.strictEqual((await politicaDeRevision(args)).ok, false, 'el mínimo de revisores que deja votar al autor no cuenta');
    m.api.st.politicas = [requeridos(m.api, { votoDelAutor: true })];
    assert.strictEqual((await politicaDeRevision(args)).ok, false, 'los revisores requeridos que dejan votar al autor no cuentan');
    // con `false`, la de toda la rama sigue valiendo como hoy, con y sin archivo
    m.api.st.politicas = [m.api.politicaDeRevisores(1)];
    assert.strictEqual((await politicaDeRevision(args)).ok, true);
    assert.strictEqual((await politicaDeRevision({ remote: b.remote, credencial: b.credencial, urlBase: b.urlBase })).ok, true);
  } finally { await m.cerrar(); }
});

test('Politica_AutorPuedeAprobar_DiceElAjuste @story-2.38 @ac-9', { skip: SIN_BACKEND }, async () => {
  // la política existe y alcanzaría, pero deja que quien crea el pedido lo apruebe: el motivo lo dice, no «no tiene»
  const m = await montar({ plataforma: 'azure', politica: false });
  try {
    const b = m.base();
    const args = { remote: b.remote, credencial: b.credencial, urlBase: b.urlBase, archivo: 'operations.json' };
    m.api.st.politicas = [{ ...m.api.politicaDeRevisores(1), settings: { ...m.api.politicaDeRevisores(1).settings, creatorVoteCounts: true } }];
    const p = await politicaDeRevision(args);
    assert.deepStrictEqual([p.ok, p.codigo], [false, 'autor_aprueba'], textoDe(p));
    assert.match(p.message, /Allow requestors to approve their own changes/);
    assert.doesNotMatch(p.message, /no tiene una política/);
    // también con «Required reviewers» que cubre el archivo: el motivo es el voto del autor, no «no cubre»
    m.api.st.politicas = [requeridos(m.api, { votoDelAutor: true })];
    const req = await politicaDeRevision(args);
    assert.deepStrictEqual([req.ok, req.codigo], [false, 'autor_aprueba'], textoDe(req));
    // sin ninguna política, sigue «no tiene»
    m.api.st.politicas = [];
    assert.strictEqual((await politicaDeRevision(args)).codigo, 'sin_politica');
  } finally { await m.cerrar(); }
});

test('T43 Politica_LoQueNoSePuedeProbar_Apagado @story-2.30 @ac-22b', { skip: SIN_BACKEND }, async () => {
  // La regla: «Proponer» se habilita sólo si se puede PROBAR que la política exige un revisor en ese archivo. Cualquier
  // forma que no se entiende queda apagada (no una lista de casos malos).
  const m = await montar({ plataforma: 'azure', politica: false });
  try {
    const b = m.base();
    const args = { remote: b.remote, credencial: b.credencial, urlBase: b.urlBase, archivo: 'operations.json' };
    const conAjuste = (ajuste) => { const p = requeridos(m.api); p.settings = { ...p.settings, ...ajuste }; return p; };
    const apagadas = {
      'sólo exclusiones (en Azure no incluye nada)': conAjuste({ filenamePatterns: ['!/docs/*'] }),
      'una exclusión con ? que saca el archivo': conAjuste({ filenamePatterns: ['/*', '!/operations.jso?'] }),
      'sólo archivos nuevos': conAjuste({ addedFilesOnly: true }),
      'sin revisores requeridos': conAjuste({ requiredReviewerIds: [] }),
      'sin la lista de revisores': (() => { const p = requeridos(m.api); delete p.settings.requiredReviewerIds; return p; })(),
      'sin decir si cuenta el voto del autor': (() => { const p = requeridos(m.api); delete p.settings.creatorVoteCounts; return p; })(),
      'un patrón que no empieza con /': conAjuste({ filenamePatterns: ['operations.json'] }),
      'un patrón con caracteres desconocidos': conAjuste({ filenamePatterns: ['/operations.{json,yml}'] }),
      'sin patrones': conAjuste({ filenamePatterns: [] }),
      'el mínimo de revisores sin decir si cuenta el voto del autor': (() => { const p = m.api.politicaDeRevisores(1); delete p.settings.creatorVoteCounts; return p; })(),
    };
    for (const [caso, pol] of Object.entries(apagadas)) {
      m.api.st.politicas = [pol];
      const p = await politicaDeRevision(args);
      assert.strictEqual(p.ok, false, `${caso}: ${textoDe(p)}`);
    }
    // y lo que sí se puede probar, encendido: un ? que incluye el archivo, una exclusión que no lo toca, un * en el medio
    for (const patrones of [['/operations.jso?'], ['/*', '!/docs/*'], ['/OPERATIONS.json'], ['/oper*.json']]) {
      m.api.st.politicas = [conAjuste({ filenamePatterns: patrones, addedFilesOnly: false })];
      const p = await politicaDeRevision(args);
      assert.strictEqual(p.ok, true, `${patrones.join(';')}: ${textoDe(p)}`);
    }
    // el * no cruza carpetas: sin poder probar que en Azure es recursivo, el lado seguro
    m.api.st.politicas = [conAjuste({ filenamePatterns: ['/scripts/*'] })];
    assert.strictEqual((await politicaDeRevision({ ...args, archivo: 'scripts/nightly/dependencies/repos.json' })).ok, false, '/scripts/* no cubre una subcarpeta');
    assert.strictEqual((await politicaDeRevision({ ...args, archivo: 'scripts/x.json' })).ok, true, '/scripts/* cubre lo de esa carpeta');
    // el punto es literal, y sin la clave del filtro no hay nada que pruebe
    m.api.st.politicas = [conAjuste({ filenamePatterns: ['/operations.json'] })];
    assert.strictEqual((await politicaDeRevision({ ...args, archivo: 'operationsXjson' })).ok, false, 'el punto no es un comodín');
    m.api.st.politicas = [(() => { const p = requeridos(m.api); delete p.settings.filenamePatterns; return p; })()];
    assert.strictEqual((await politicaDeRevision(args)).ok, false, '«Required reviewers» sin filenamePatterns');
    // el mínimo de revisores con un filtro: cuenta sólo si el filtro cubre el archivo
    const minimoConFiltro = (patrones) => { const p = m.api.politicaDeRevisores(1); p.settings = { ...p.settings, filenamePatterns: patrones }; return p; };
    m.api.st.politicas = [minimoConFiltro(['/docs/*'])];
    assert.strictEqual((await politicaDeRevision(args)).ok, false, 'mínimo de revisores con un filtro que no cubre');
    m.api.st.politicas = [minimoConFiltro(['/operations.json'])];
    assert.strictEqual((await politicaDeRevision(args)).ok, true, 'mínimo de revisores con un filtro que cubre');
    // proponer con una política que no se puede probar no crea nada
    m.api.st.politicas = [apagadas['sólo exclusiones (en Azure no incluye nada)']];
    const res = await proponer(b);
    assert.strictEqual(res.ok, false, textoDe(res));
    assert.deepStrictEqual(m.r.empujes, []);
  } finally { await m.cerrar(); }
});

test('T16c Proponer_SinVersion_NoPropone @story-2.29 @ac-16 — la librería también exige la versión del archivo que se abrió', async () => {
  const res = await proponer({ clon: '/no/existe', archivo: 'operations.json', contenido: '{}\n', idCorto: 'operations', credencial: 'x', remote: REMOTO_GITHUB });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.codigo, 'sin_version');
});
