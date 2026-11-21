'use strict';
/*
 * site-invitations.test.js — invitar a alguien al sitio desde Personas.
 *
 * El módulo (scripts/site/invitations.js): el permiso por los roles del token de la identidad, el dominio de un correo
 * por el descubrimiento público, la invitación por Graph cuando el alta está en vigor, el tope por día, el estado de
 * cada invitado y el registro sin el correo. La pestaña (scripts/site/tabs/config.js): «Invitar» y «Revocar» como
 * pedidos, sólo para quien mantiene.
 *
 * Sin red: Microsoft es un servidor de juguete en el proceso (el endpoint de la identidad, Graph y el descubrimiento);
 * el repo de operaciones, un repo git local por HTTP, y GitHub, el de lib/fake-github-api.js. Correos, inquilinos y
 * repos inventados.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const INV = require(path.join(ROOT, 'scripts', 'site', 'invitations.js'));
const MS = require(path.join(ROOT, 'scripts', 'site', 'auth-providers', 'microsoft.js'));
const ORG = require(path.join(ROOT, 'scripts', 'lib', 'org-config.js'));
const TX = require(path.join(ROOT, 'scripts', 'site', 'texts.js'));
const H = require('./lib/site-harness.js');
const { arrancarEmisor } = require('./lib/fake-oidc.js');
const { arrancarGithubFalso } = require('./lib/fake-github-api.js');
const { crearRepoHttp, hayHttpBackend } = require('./lib/git-http-repo.js');
const { validarConfiguracion } = require(path.join(H.SITE, 'server.js'));
const TAB = () => require(path.join(H.SITE, 'tabs', 'config.js'));

const SIN_BACKEND = !hayHttpBackend() && !process.env.CI && 'git http-backend no está en esta máquina: el repo por HTTP no se puede armar';
const LEAD = 'lead@acme.example';
const DEV = 'dev.a@acme.example';
const INQUILINO = '11111111-2222-4333-8444-555555555555';
const OTRO_INQUILINO = '99999999-8888-4777-8666-555555555555';
const OID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const AHORA = Date.parse('2026-10-22T12:00:00Z');
const ESCRITURA = `w-${crypto.randomBytes(6).toString('hex')}`;
const CAB = `Basic ${Buffer.from(`x-access-token:${ESCRITURA}`).toString('base64')}`;

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const llave = () => crypto.randomBytes(32);

/** Un token con la forma de uno de Entra: sólo importa el cuerpo (el sitio no verifica su firma, sólo lee sus roles). */
const jwt = (claims) => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.firma`;

/**
 * Microsoft de juguete: el endpoint de la identidad administrada, Graph y el descubrimiento de dominios.
 * `st.roles` (los del token), `st.graph` (la respuesta de cada invitación: función del cuerpo), `st.dominios`
 * ({ dominio: inquilino | 'invalid_tenant' | 'caido' }). `st.invitaciones` guarda cada cuerpo recibido.
 */
async function microsoftDeJuguete() {
  const st = { roles: ['User.Invite.All'], graph: () => ({ status: 201, json: { status: 'PendingAcceptance', invitedUser: { id: 'u-1' } } }), dominios: {}, invitaciones: [], tokens: [] };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const enviar = (status, j) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (u.pathname === '/identity') {
      st.tokens.push(u.searchParams.get('resource'));
      if (req.headers['x-identity-header'] !== 'cabecera') return enviar(401, {});
      return enviar(200, { access_token: jwt({ roles: st.roles, oid: OID, tid: INQUILINO }) });
    }
    if (u.pathname === '/graph/v1.0/invitations' && req.method === 'POST') {
      let b = ''; req.on('data', (c) => { b += c; });
      // `st.graph` puede devolver una promesa: la prueba suelta la respuesta cuando quiere
      req.on('end', () => { const cuerpo = JSON.parse(b); st.invitaciones.push({ cuerpo, auth: req.headers.authorization }); Promise.resolve(st.graph(cuerpo)).then((r) => enviar(r.status, r.json)); });
      return undefined;
    }
    const m = /^\/login\/([^/]+)\/v2\.0\/\.well-known\/openid-configuration$/.exec(u.pathname);
    if (m) {
      const d = st.dominios[m[1]];
      if (d === 'caido') { req.socket.destroy(); return undefined; }
      if (!d || d === 'invalid_tenant') return enviar(400, { error: 'invalid_tenant' });
      return enviar(200, { issuer: `https://login.microsoftonline.com/${d}/v2.0` });
    }
    return enviar(404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { st, base, env: { IDENTITY_ENDPOINT: `${base}/identity`, IDENTITY_HEADER: 'cabecera' }, cerrar: () => new Promise((r) => server.close(r)) };
}

/** La configuración del sitio con Microsoft en «sólo la organización»; `cambios` pisa lo que haga falta. */
const cfgMicrosoft = (cambios = {}) => ({ publicUrl: 'https://sitio.acme.example', issuer: `https://login.microsoftonline.com/${INQUILINO}/v2.0`, inicioDeSesion: { proveedor: 'microsoft', modo: 'organization' }, ...cambios });
const ops = (extra = {}) => ({ version: 1, owners: { default: LEAD }, site: { access: [{ role: 'maintainer', emails: [LEAD] }, { role: 'dev', emails: [DEV] }], ...extra } });
const conInvitado = (correo, extra = {}) => {
  const o = ops(extra);
  o.site.access.push({ role: 'dev', emails: [correo] });
  o.site.invitations = { ...(o.site.invitations || {}), [correo]: { por: LEAD, el: '2026-10-22' } };
  return o;
};

/** El módulo armado contra el Microsoft de juguete. */
function armar(ms, { cfg = cfgMicrosoft(), dataDir = tmp('site-inv-data-'), clave = llave(), reloj = { t: AHORA }, env = {}, log = [] } = {}) {
  const inv = INV.crearInvitaciones({ cfg, env: { ...ms.env, ...env }, dataDir, llave: clave, ahora: () => reloj.t, log: (l) => log.push(l), urlGraph: `${ms.base}/graph`, urlLogin: `${ms.base}/login` });
  return { inv, dataDir, clave, reloj, log };
}

// ── el permiso y los inicios de sesión ────────────────────────────────────────────────────────────────────────────

test('T3 2.74-SinPermiso_DiceComoSeDa @story-2.74 @ac-3', async () => {
  const ms = await microsoftDeJuguete();
  try {
    ms.st.roles = [];
    const { inv } = armar(ms);
    const p = await inv.permiso();
    assert.strictEqual(p.ok, false);
    assert.match(p.texto, /falta el permiso de invitar/i);
    assert.match(p.texto, /administrador del directorio/);
    assert.match(p.comando, /--phase permiso-de-invitar/);
    assert.ok(p.comando.includes(OID) || p.texto.includes(OID), 'nombra la identidad del sitio');
    assert.ok(p.texto.includes(INQUILINO) || p.comando.includes(INQUILINO), 'y su inquilino');
    assert.deepStrictEqual(ms.st.invitaciones, [], 'ninguna llamada a Graph');
    assert.deepStrictEqual(ms.st.tokens, ['https://graph.microsoft.com/'], 'sólo pidió el token, para el recurso de Graph');
    ms.st.roles = ['User.Invite.All'];
    const { inv: otro } = armar(ms);
    assert.strictEqual((await otro.permiso()).ok, true);
  } finally { await ms.cerrar(); }
});

test('T17 2.74-NombresYInquilino_DeLaConfiguracion @story-2.74 @ac-3', async () => {
  const ms = await microsoftDeJuguete();
  try {
    ms.st.roles = [];
    for (const [inq, url] of [[INQUILINO, 'https://uno.acme.example'], [OTRO_INQUILINO, 'https://dos.acme.example']]) {
      const { inv } = armar(ms, { cfg: cfgMicrosoft({ issuer: `https://login.microsoftonline.com/${inq}/v2.0`, publicUrl: url }) });
      const p = await inv.permiso();
      assert.ok(`${p.texto} ${p.comando}`.includes(inq), `el inquilino de la configuración: ${inq}`);
      assert.strictEqual(MS.cuerpoDeLaInvitacion('x@otra.example', { publicUrl: url }).inviteRedirectUrl, url);
    }
    // el código no trae ningún GUID fijo salvo los ids públicos de Microsoft: la aplicación de Graph y el inquilino de
    // las cuentas personales (el mismo para todas las organizaciones)
    const publicos = new Set([MS.GRAPH_APP, MS.PERSONALES]);
    for (const f of ['invitations.js', path.join('auth-providers', 'microsoft.js')]) {
      const codigo = fs.readFileSync(path.join(ROOT, 'scripts', 'site', f), 'utf8');
      const guids = (codigo.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []).filter((g) => !publicos.has(g.toLowerCase()));
      assert.deepStrictEqual(guids, [], f);
    }
  } finally { await ms.cerrar(); }
});

test('T2 2.74-OtrosInicios_SinBoton_DiceQueHacer @story-2.74 @ac-2 @ac-13', () => {
  const env = { IDENTITY_ENDPOINT: 'http://127.0.0.1:9/identity', IDENTITY_HEADER: 'x' };
  const casos = [
    [cfgMicrosoft({ inicioDeSesion: { proveedor: 'microsoft', modo: 'any' } }), env, 'cualquier_cuenta'],
    [cfgMicrosoft({ inicioDeSesion: { proveedor: 'google', modo: null } }), env, 'otro_proveedor'],
    [cfgMicrosoft({ inicioDeSesion: { proveedor: 'github', modo: null } }), env, 'otro_proveedor'],
    [cfgMicrosoft({ inicioDeSesion: { proveedor: 'oidc', modo: null } }), env, 'otro_proveedor'],
    [cfgMicrosoft(), {}, 'sin_identidad'],
  ];
  const textos = new Set();
  for (const [cfg, e, motivo] of casos) {
    const d = INV.disponibilidad({ cfg, env: e, dataDir: '/datos' });
    assert.strictEqual(d.boton, false, motivo);
    assert.strictEqual(d.motivo, motivo);
    assert.ok(d.texto && d.texto.length > 20, `${motivo} dice qué hacer`);
    textos.add(d.texto);
  }
  assert.match(INV.disponibilidad({ cfg: cfgMicrosoft({ inicioDeSesion: { proveedor: 'github', modo: null } }), env, dataDir: '/d' }).texto, /GitHub/);
  assert.match(INV.disponibilidad({ cfg: cfgMicrosoft({ inicioDeSesion: { proveedor: 'google', modo: null } }), env, dataDir: '/d' }).texto, /Google/);
  assert.match(INV.disponibilidad({ cfg: cfgMicrosoft(), env: {}, dataDir: '/d' }).texto, /portal/);
  assert.ok(textos.size >= 4, 'cada inicio de sesión con su texto');
  const sinDisco = INV.disponibilidad({ cfg: cfgMicrosoft(), env, dataDir: null });
  assert.deepStrictEqual([sinDisco.boton, sinDisco.motivo], [false, 'sin_disco']);
  assert.match(sinDisco.texto, /SITE_DATA_DIR/);
  assert.strictEqual(INV.disponibilidad({ cfg: cfgMicrosoft(), env, dataDir: '/d' }).boton, true);
});

// ── el correo ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('T5 2.74-Correo_Validado @story-2.74 @ac-4', async () => {
  const ms = await microsoftDeJuguete();
  try {
    const { inv } = armar(ms);
    const sinArroba = await inv.revisarCorreo('nadie', ops());
    assert.strictEqual(sinArroba.ok, false); assert.match(sinArroba.motivo, /no es un correo/);
    const yaEsta = await inv.revisarCorreo(` ${DEV.toUpperCase()} `, ops());
    assert.strictEqual(yaEsta.ok, false); assert.match(yaEsta.motivo, /ya está en la lista/);
    // Graph contesta que la cuenta ya es del directorio: no es una falla
    ms.st.dominios['otra.example'] = OTRO_INQUILINO;
    ms.st.graph = () => ({ status: 400, json: { error: { code: 'Request_BadRequest', message: 'The invited user already exists in the directory as a member.' } } });
    const { inv: env2 } = armar(ms);
    await env2.enviarPendientes(conInvitado('ya@otra.example'));
    const e = env2.estados(conInvitado('ya@otra.example'))['ya@otra.example'];
    assert.strictEqual(e.estado, 'ya_estaba');
    assert.match(e.texto, /ya estaba en el directorio, no hacía falta invitar/);
  } finally { await ms.cerrar(); }
});

test('T20 2.74-DominioVerificado_NoSeInvita_CodigoPorCorreo @story-2.74 @ac-4', async () => {
  const ms = await microsoftDeJuguete();
  try {
    ms.st.dominios = { 'propia.example': INQUILINO, 'ajena.example': OTRO_INQUILINO, 'caida.example': 'caido' };
    const { inv } = armar(ms);
    const propio = await inv.revisarCorreo('ana@propia.example', ops());
    assert.strictEqual(propio.ok, false);
    assert.match(propio.motivo, /necesita una cuenta en el Microsoft 365 de tu organización/);
    const ajeno = await inv.revisarCorreo('bea@ajena.example', ops());
    assert.deepStrictEqual([ajeno.ok, ajeno.aviso || null], [true, null]);
    const caido = await inv.revisarCorreo('cata@caida.example', ops());
    assert.strictEqual(caido.ok, true); assert.match(caido.aviso, /no se pudo comprobar/i);
    for (const [codigo, conAviso] of [['on', false], ['off', true], [undefined, true]]) {
      const { inv: i } = armar(ms, { env: codigo ? { SITE_INVITE_EMAIL_CODE: codigo } : {} });
      const r = await i.revisarCorreo('dani@suelto.example', ops());
      assert.strictEqual(r.ok, true, `código por correo ${codigo}`);
      if (conAviso) assert.match(r.aviso, /código de un solo uso/, `con ${codigo}`);
      else assert.ok(!r.aviso, `con ${codigo}, sin aviso`);
    }
  } finally { await ms.cerrar(); }
});

// ── el envío ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('T8 2.74-AltaEnVigor_UnaSolaInvitacion @story-2.74 @ac-6', async () => {
  const ms = await microsoftDeJuguete();
  try {
    const conf = conInvitado('Eva@Otra.Example');
    const a = armar(ms);
    await a.inv.enviarPendientes(conf);
    await a.inv.enviarPendientes(conf);
    // un reinicio: el mismo disco y la misma llave
    const b = armar(ms, { dataDir: a.dataDir, clave: a.clave });
    await b.inv.enviarPendientes(conf);
    assert.strictEqual(ms.st.invitaciones.length, 1, 'una sola invitación');
    const { cuerpo, auth } = ms.st.invitaciones[0];
    assert.deepStrictEqual(cuerpo, { invitedUserEmailAddress: 'eva@otra.example', inviteRedirectUrl: 'https://sitio.acme.example', sendInvitationMessage: true, invitedUserType: 'Guest' });
    assert.match(auth, /^Bearer /);
    assert.ok(!fs.readFileSync(path.join(a.dataDir, 'invitaciones.json'), 'utf8').includes('eva@'), 'el disco no guarda el correo');
  } finally { await ms.cerrar(); }
});

test('T18 2.74-Falla_SeReintentaElCicloSiguiente @story-2.74 @ac-6', async () => {
  const ms = await microsoftDeJuguete();
  try {
    let falla = true;
    ms.st.graph = () => (falla ? { status: 503, json: { error: { code: 'ServiceUnavailable', message: 'try later' } } } : { status: 201, json: { invitedUser: { id: 'u-2' } } });
    const conf = conInvitado('reintento@otra.example');
    const { inv } = armar(ms);
    await inv.enviarPendientes(conf);
    assert.strictEqual(inv.estados(conf)['reintento@otra.example'].estado, 'falla');
    falla = false;
    await inv.enviarPendientes(conf);
    assert.strictEqual(inv.estados(conf)['reintento@otra.example'].estado, 'enviada');
    assert.strictEqual(ms.st.invitaciones.length, 2);
    // un sitio que arranca con el alta ya aprobada la manda en su primer ciclo, sin esperar un cambio de la lista
    const { inv: nuevo } = armar(ms);
    await nuevo.enviarPendientes(conInvitado('gina@otra.example'));
    assert.strictEqual(ms.st.invitaciones.at(-1).cuerpo.invitedUserEmailAddress, 'gina@otra.example');
  } finally { await ms.cerrar(); }
});

test('T19 2.74-YaEntro_NoSeManda @story-2.74 @ac-6 @ac-8', async () => {
  const ms = await microsoftDeJuguete();
  try {
    const conf = conInvitado('hugo@otra.example');
    const { inv } = armar(ms);
    inv.entro(' HUGO@otra.example ');
    await inv.enviarPendientes(conf);
    assert.deepStrictEqual(ms.st.invitaciones, []);
    assert.strictEqual(inv.estados(conf)['hugo@otra.example'].estado, 'aceptada');
  } finally { await ms.cerrar(); }
});

test('T4 2.74-GraphRechaza_MotivoEnLlano @story-2.74 @ac-3 @ac-6', async () => {
  const ms = await microsoftDeJuguete();
  try {
    ms.st.graph = () => ({ status: 403, json: { error: { code: 'Authorization_RequestDenied', message: 'Guest invitations not allowed for your company.' } } });
    const conf = conInvitado('ines@otra.example');
    const { inv } = armar(ms);
    await inv.enviarPendientes(conf);
    const e = inv.estados(conf)['ines@otra.example'];
    assert.strictEqual(e.estado, 'falla');
    assert.match(e.texto, /^no se pudo enviar: /);
    assert.match(e.texto, /invitaciones están cerradas en el directorio/);
    assert.match(e.texto, /Guest invitations not allowed/, 'con el motivo de Microsoft');
  } finally { await ms.cerrar(); }
});

test('T9 2.74-Tope_PorDia @story-2.74 @ac-7', async () => {
  const ms = await microsoftDeJuguete();
  try {
    let n = 0;
    ms.st.graph = () => { n++; return n === 3 ? { status: 503, json: { error: { message: 'un rato' } } } : { status: 201, json: { invitedUser: { id: `u-${n}` } } }; };
    let conf = ops();
    for (let i = 1; i <= 12; i++) conf = { ...conf, site: { ...conf.site, access: [...conf.site.access, { role: 'dev', emails: [`p${i}@otra.example`] }], invitations: { ...(conf.site.invitations || {}), [`p${i}@otra.example`]: { por: LEAD, el: '2026-10-22' } } } };
    const a = armar(ms, { env: { SITE_INVITATIONS_PER_DAY: '10' } });
    await a.inv.enviarPendientes(conf);
    const est = a.inv.estados(conf);
    const enviadas = Object.values(est).filter((e) => e.estado === 'enviada').length;
    assert.strictEqual(enviadas, 10, 'salen 10 (la falla no cuenta)');
    assert.strictEqual(Object.values(est).filter((e) => e.estado === 'falla').length, 1);
    const esperando = Object.values(est).filter((e) => e.estado === 'tope');
    assert.strictEqual(esperando.length, 1);
    assert.match(esperando[0].texto, /esperando el tope de mañana/);
    a.reloj.t += 24 * 3600000;
    await a.inv.enviarPendientes(conf);
    assert.ok(Object.values(a.inv.estados(conf)).every((e) => e.estado === 'enviada'), 'al día siguiente salen la que esperaba y la que falló');
  } finally { await ms.cerrar(); }
});

test('T10 2.74-Estado_CuatroCasos @story-2.74 @ac-8', async () => {
  const ms = await microsoftDeJuguete();
  try {
    ms.st.graph = (c) => (c.invitedUserEmailAddress === 'mal@otra.example' ? { status: 400, json: { error: { message: 'Bad email domain.' } } } : { status: 201, json: { invitedUser: { id: 'u' } } });
    let conf = ops();
    // la falla primero (no cuenta para el tope de 1), después la que sale, la que entró y la que espera
    for (const c of ['mal@otra.example', 'env@otra.example', 'ent@otra.example', 'tope@otra.example']) conf = { ...conf, site: { ...conf.site, access: [...conf.site.access, { role: 'dev', emails: [c] }], invitations: { ...(conf.site.invitations || {}), [c]: { por: LEAD, el: '2026-10-22' } } } };
    const { inv } = armar(ms, { env: { SITE_INVITATIONS_PER_DAY: '1' } });
    inv.entro('ent@otra.example');
    await inv.enviarPendientes(conf);
    const t = Object.fromEntries(Object.entries(inv.estados(conf)).map(([k, v]) => [k, v.texto]));
    assert.match(t['env@otra.example'], /invitación enviada, todavía no entró/);
    assert.match(t['ent@otra.example'], /aceptada/);
    assert.match(t['mal@otra.example'], /no se pudo enviar: /);
    assert.match(t['tope@otra.example'], /esperando el tope de mañana/);
    // cada estado tiene su texto en inglés
    for (const k of ['enviada', 'aceptada', 'tope', 'falla', 'porEnviar', 'yaEstaba']) assert.ok(TX.t('en', `invitaciones.${k}`, { motivo: 'x' }) !== TX.t('es', `invitaciones.${k}`, { motivo: 'x' }), k);
  } finally { await ms.cerrar(); }
});

test('T11 2.74-Registro_SinCorreo @story-2.74 @ac-9', async () => {
  const ms = await microsoftDeJuguete();
  try {
    const { inv, log } = armar(ms);
    await inv.enviarPendientes(conInvitado('juan@otra.example'));
    const linea = log.find((l) => /invitación enviada/.test(l));
    assert.ok(linea, log.join('\n'));
    assert.match(linea, /pedida por quien mantiene/);
    assert.ok(!log.join('\n').includes('juan@'), 'el registro no trae el correo');
  } finally { await ms.cerrar(); }
});

test('2.74-Proveedor_RolesYMotivos_SinCorreo @story-2.74 @ac-3 @ac-9', async () => {
  // los roles del token: un JWT de verdad, uno sin roles y uno roto
  assert.deepStrictEqual(MS.rolesDelToken(jwt({ roles: ['User.Invite.All'], oid: OID, tid: INQUILINO })), { roles: ['User.Invite.All'], oid: OID, tid: INQUILINO });
  assert.deepStrictEqual(MS.rolesDelToken(jwt({ oid: OID })).roles, []);
  assert.strictEqual(MS.rolesDelToken('no-es-un-token'), null);
  assert.strictEqual(MS.rolesDelToken('a.%%%.b'), null);
  // los motivos de Graph, en llano, y nunca con el correo aunque Microsoft lo repita
  const conCorreo = JSON.stringify({ error: { message: 'Invitation for Pepe@Otra.Example was blocked: guest invitations disabled' } });
  assert.match(MS.motivoDeGraph(403, conCorreo), /invitaciones están cerradas/);
  assert.ok(!/pepe@/i.test(MS.motivoDeGraph(403, conCorreo)), 'sin el correo');
  assert.match(MS.motivoDeGraph(401, '{}'), /falta el permiso/);
  assert.match(MS.motivoDeGraph(500, 'no es json'), /Microsoft contestó 500 \(no es json\)/);
  // y en el ciclo: ni el registro ni el disco traen el correo
  const ms = await microsoftDeJuguete();
  try {
    ms.st.graph = (c) => ({ status: 400, json: { error: { message: `Bad request for ${c.invitedUserEmailAddress}` } } });
    const { inv, log, dataDir } = armar(ms);
    await inv.enviarPendientes(conInvitado('rosa@otra.example'));
    assert.ok(!log.join('\n').includes('rosa@'), log.join('\n'));
    assert.ok(!fs.readFileSync(path.join(dataDir, 'invitaciones.json'), 'utf8').includes('rosa@'));
  } finally { await ms.cerrar(); }
});

// ── lo que encontró el pase adversarial (cada caso, su prueba de regresión) ─────────────────────────────────────

test('2.74-Adv_IngresoDuranteElCiclo_NoSePierde @story-2.74 @ac-8 — entro() mientras el ciclo espera al proveedor', async () => {
  const ms = await microsoftDeJuguete();
  try {
    const { inv } = armar(ms);
    await inv.enviarPendientes(conInvitado('ana@otra.example'));
    // el segundo ciclo queda esperando a Graph con «bo»; en el medio, ana entra al sitio
    let soltar;
    let llego;
    const pidio = new Promise((r) => { llego = r; });
    const espera = new Promise((r) => { soltar = r; });
    ms.st.graph = () => { llego(); return espera.then(() => ({ status: 201, json: { invitedUser: { id: 'u-bo' } } })); };
    const conf = conInvitado('ana@otra.example');
    conf.site.access.push({ role: 'dev', emails: ['bo@otra.example'] });
    conf.site.invitations['bo@otra.example'] = { por: LEAD, el: '2026-10-22' };
    const ciclo = inv.enviarPendientes(conf);
    await pidio;
    inv.entro('ana@otra.example');
    soltar();
    await ciclo;
    assert.strictEqual(inv.estados(conf)['ana@otra.example'].estado, 'aceptada', 'el ingreso sigue anotado después del ciclo');
  } finally { await ms.cerrar(); }
});

test('2.74-Adv_DominioInternacional_SeConsulta @story-2.74 @ac-4', async () => {
  const ms = await microsoftDeJuguete();
  try {
    ms.st.dominios = { 'empresa.xn--p1ai': INQUILINO };
    const { inv } = armar(ms);
    // el correo se arma por partes: escrito entero, con un dominio que no es .example, parece uno real
    const r = await inv.revisarCorreo(['ana', 'empresa.xn--p1ai'].join('@'), ops());
    assert.strictEqual(r.ok, false, 'el dominio del propio inquilino, aunque sea internacional, no se invita');
    assert.match(r.motivo, /Microsoft 365 de tu organización/);
  } finally { await ms.cerrar(); }
});

test('2.74-Adv_LlaveNueva_NoVuelveAMandar @story-2.74 @ac-6 — cambiar SITE_SESSION_KEY no reenvía', async () => {
  const ms = await microsoftDeJuguete();
  try {
    const conf = conInvitado('ivo@otra.example');
    const a = armar(ms);
    await a.inv.enviarPendientes(conf);
    assert.strictEqual(ms.st.invitaciones.length, 1);
    // el mismo disco con otra llave: las huellas viejas no reconocen a nadie
    const b = armar(ms, { dataDir: a.dataDir, clave: llave() });
    await b.inv.enviarPendientes(conf);
    await b.inv.enviarPendientes(conf);
    assert.strictEqual(ms.st.invitaciones.length, 1, 'no se vuelve a mandar');
    assert.strictEqual(b.inv.estados(conf)['ivo@otra.example'].estado, 'enviada');
    // una invitación nueva, después del cambio, sale como siempre
    const otra = conInvitado('ivo@otra.example');
    otra.site.access.push({ role: 'dev', emails: ['eli@otra.example'] });
    otra.site.invitations['eli@otra.example'] = { por: LEAD, el: '2026-10-22' };
    await b.inv.enviarPendientes(otra);
    assert.strictEqual(ms.st.invitaciones.at(-1).cuerpo.invitedUserEmailAddress, 'eli@otra.example');
    // un registro ilegible (cortado a la mitad) tampoco reenvía lo que ya estaba en la lista
    fs.writeFileSync(path.join(a.dataDir, 'invitaciones.json'), '{"schema":1,"envi');
    const antes = ms.st.invitaciones.length;
    await b.inv.enviarPendientes(otra);
    assert.strictEqual(ms.st.invitaciones.length, antes, 'archivo ilegible: no se reenvía');
    assert.strictEqual(b.inv.estados(otra)['eli@otra.example'].estado, 'enviada');
  } finally { await ms.cerrar(); }
});

test('2.74-Adv_FichaExistente_OtraMayusculaYRemove @story-2.74 @ac-5 — invitar con productos sobre una ficha vieja', { skip: SIN_BACKEND }, async () => {
  const archivo = ops();
  archivo.people = { projects: { 'Lu@Otra.Example': { add: ['viejo'], remove: ['alfa'] } } };
  await sitioConInvitar({ archivo }, async ({ entrar, post, gh, r }) => {
    const lead = await entrar(LEAD);
    const res = (await post(lead, 'invitar', { correo: 'lu@otra.example', productos: ['alfa', 'beta'] })).json;
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    const nuevo = JSON.parse(r.archivoEn(gh.st.pedidos[0].head.ref, 'operations.json'));
    assert.deepStrictEqual(Object.keys(nuevo.people.projects), ['Lu@Otra.Example'], 'una sola clave, la que ya estaba');
    assert.deepStrictEqual(nuevo.people.projects['Lu@Otra.Example'], { add: ['viejo', 'alfa', 'beta'] }, 'lo sumado sale de remove');
  });
});

test('2.74-Revocar_BorraLasHuellas_ReinvitarMandaDeNuevo @story-2.74 @ac-10', async () => {
  const ms = await microsoftDeJuguete();
  try {
    const { inv } = armar(ms);
    await inv.enviarPendientes(conInvitado('kim@otra.example'));
    // la baja entró: la lista ya no lo trae
    await inv.enviarPendientes(ops());
    await inv.enviarPendientes(conInvitado('kim@otra.example'));
    assert.strictEqual(ms.st.invitaciones.length, 2, 'reinvitado, la invitación sale de nuevo');
  } finally { await ms.cerrar(); }
});

// ── la pestaña: «Invitar» y «Revocar» como pedidos ───────────────────────────────────────────────────────────────

/** El sitio con la pestaña, el repo de operaciones por HTTP, el GitHub de juguete y Microsoft de juguete. */
async function sitioConInvitar({ archivo = ops(), cfgCambios = {}, conDisco = true } = {}, fn) {
  let gh; let r; let ms; let emisor; let h;
  // el reloj de la pestaña (el nombre de la rama de cada pedido sale de la hora): la prueba lo adelanta
  const reloj = { t: AHORA };
  try {
    ms = await microsoftDeJuguete();
    ms.st.dominios = { 'otra.example': OTRO_INQUILINO, 'propia.example': INQUILINO };
    gh = await arrancarGithubFalso({ owner: 'acme', repo: 'ops' });
    gh.st.proteccion = { required_pull_request_reviews: { required_approving_review_count: 1 } };
    const raiz = tmp('site-inv-plat-');
    r = await crearRepoHttp({ raiz, nombre: 'ops.git', archivos: { 'operations.json': archivo }, cabecera: CAB });
    const dir = path.join(raiz, 'clon-del-sitio');
    await require('util').promisify(require('child_process').execFile)('git', ['-c', `http.extraheader=Authorization: ${CAB}`, 'clone', '-q', '--depth', '1', '--branch', 'main', r.url, dir]);
    const fuentes = H.fuentesFijas({ config: archivo, personas: { informados: null, repos: null } });
    fuentes.clones = () => ({ operaciones: { dir }, perfil: null });
    fuentes.dirBuzon = tmp('site-inv-buzon-');
    fuentes.exclusivo = (fn2) => fn2();
    emisor = await arrancarEmisor();
    const envSitio = H.envBase({ SITE_OIDC_ISSUER: emisor.issuer, SITE_OPERATIONS_WRITE_TOKEN: ESCRITURA });
    const cfg = validarConfiguracion(envSitio).cfg;
    const cfgInv = { ...cfg, ...cfgMicrosoft(cfgCambios), publicUrl: cfg.publicUrl };
    const dataDir = conDisco ? tmp('site-inv-data-') : null;
    const invitaciones = INV.crearInvitaciones({ cfg: cfgInv, env: ms.env, dataDir, llave: llave(), ahora: () => AHORA, log: () => {}, urlGraph: `${ms.base}/graph`, urlLogin: `${ms.base}/login` });
    const rutasExtra = TAB().crearRutas({ cfg, fuentes, versionImagen: ORG.RESPONSE_SINCE, ahora: () => reloj.t, remotos: { operaciones: { platform: 'github', org: 'acme', repo: 'ops', web: 'https://github.example/acme/ops' } }, urlBase: { github: gh.base }, invitaciones });
    h = await H.arrancarSitio({ env: envSitio, fuentes, rutasExtra });
    const entrar = async (email) => (await H.ingresar(h, emisor, { sub: `s-${email}`, email, email_verified: true })).sesion;
    const token = async (cookie) => { const p = await h.pedir('/configuracion', { cookie }); const m = /<meta name="site-token" content="([^"]+)">/.exec(p.texto); return m ? m[1] : null; };
    const post = async (cookie, ruta, cuerpo) => h.pedir(`/api/config/${ruta}`, { method: 'POST', cookie, body: JSON.stringify(cuerpo), headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json', 'x-site-token': await token(cookie) } });
    const sitio = async (cookie) => (await h.pedir('/api/config', { cookie })).json.secciones.find((s) => s.id === 'sitio');
    await fn({ h, entrar, post, sitio, ms, gh, r, invitaciones, reloj });
  } finally { await Promise.allSettled([h, emisor, gh, r, ms].filter(Boolean).map((x) => x.cerrar())); }
}

test('T1 2.74-Boton_SoloQuienMantiene_MicrosoftOrganizacion @story-2.74 @ac-1', { skip: SIN_BACKEND }, async () => {
  await sitioConInvitar({}, async ({ entrar, post, sitio, h }) => {
    const lead = await entrar(LEAD);
    const s = await sitio(lead);
    assert.strictEqual(s.extras.invitaciones.boton, true, JSON.stringify(s.extras.invitaciones));
    assert.strictEqual(s.extras.invitaciones.permiso.ok, true);
    const dev = await entrar(DEV);
    for (const ruta of ['invitar', 'revocar']) {
      const r = await h.pedir(`/api/config/${ruta}`, { method: 'POST', cookie: dev, body: '{}', headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json' } });
      assert.strictEqual(r.status, 403, `${ruta}: 403 al dev`);
    }
    assert.ok(post);
  });
});

// ── la pantalla: documento mínimo y fetch falso (como site-propose.test.js) ─────────────────────────────────────────

async function pantallaDelSitio(invitaciones, rutas = {}) {
  const nodo = (tag) => { const n = { tag, hijos: [], textContent: '', attrs: {}, on: {}, setAttribute(k, v) { n.attrs[k] = v; }, appendChild(c) { n.hijos.push(c); return c; }, addEventListener(e, f) { n.on[e] = f; }, replaceChildren(...cs) { n.hijos = cs; } }; return n; };
  const app = nodo('div');
  const document = { hidden: false, querySelector: () => null, getElementById: (id) => (id === 'config-app' ? app : null), createElement: (t) => nodo(t), addEventListener() {} };
  const seccion = { id: 'sitio', titulo: 'El sitio', repo: 'operaciones', archivo: 'operations.json', estado: 'cargado', soloLectura: false, texto: '{}\n', oid: 'oid-s', problems: [], avisos: [],
    borrador: { site: { access: [{ role: 'maintainer', emails: [LEAD] }, { role: 'dev', emails: ['ana@otra.example', 'bea@otra.example'] }] } },
    extras: { conAcceso: true, inicioDeSesion: { proveedor: 'microsoft', modo: 'organization', texto: 'Microsoft' }, invitaciones } };
  const llamadas = [];
  const todas = { 'GET /api/config': () => ({ ok: true, secciones: [seccion], proponer: { operaciones: { habilitado: true } }, versiones: [], productos: [] }), ...rutas };
  const fetchFalso = (ruta, opts) => {
    const metodo = (opts && opts.method) || 'GET';
    llamadas.push({ metodo, ruta, cuerpo: opts && opts.body ? JSON.parse(opts.body) : null });
    const f = todas[`${metodo} ${ruta.replace(/\?.*$/, '')}`];
    if (!f) return Promise.reject(new Error(`ruta sin contestar: ${metodo} ${ruta}`));
    const j = f(opts && opts.body ? JSON.parse(opts.body) : null);
    return Promise.resolve({ status: 200, json: () => Promise.resolve(j) });
  };
  const codigo = ORG.pantalla();
  new Function('document', 'fetch', 'location', 'esperasConsulta', 'sessionStorage', 'seguimientoPedido', 'esperaRespuesta', codigo)(document, fetchFalso, { hash: '' }, [1, 1, 1], undefined, { cada: 1, vueltas: 5 }, undefined);
  const soltar = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
  await soltar();
  const todos = (n = app) => [n, ...n.hijos.flatMap((h) => todos(h))];
  const textoDe = (n) => [n.textContent, ...n.hijos.map(textoDe)].filter(Boolean).join(' ');
  const sec = () => todos().find((n) => n.attrs.id === 'seccion-sitio');
  const boton = (texto, dentro = sec()) => todos(dentro).find((n) => n.tag === 'button' && n.textContent === texto);
  const correo = (c) => todos(sec()).find((n) => (n.attrs.class || '').startsWith('correos') && textoDe(n).includes(c));
  return { llamadas, soltar, todos, textoDe, sec, boton, correo };
}
const INV_OK = (estados = {}) => ({ boton: true, motivo: 'microsoft_organizacion', texto: null, permiso: { ok: true, texto: null, comando: null }, estados, codigoPorCorreo: 'on' });

test('2.74-Pantalla_Invitar_EstadosYRevocar @story-2.74 @ac-1 @ac-5 @ac-8 @ac-10', async () => {
  const enlace = 'https://github.example/acme/ops/pull/3';
  const p = await pantallaDelSitio(INV_OK({ 'ana@otra.example': { estado: 'enviada', texto: 'invitación enviada, todavía no entró' }, 'bea@otra.example': { estado: 'falla', texto: 'no se pudo enviar: Microsoft contestó 503' } }), {
    'POST /api/config/invitar': () => ({ ok: true, message: 'Pull request abierto: la invitación sale cuando se apruebe y el sitio lea la lista nueva.', enlace, aviso: 'Ese correo no es una cuenta de Microsoft' }),
    'POST /api/config/revocar': () => ({ ok: true, message: 'Pedido de baja abierto. Esto no la saca del directorio: para eso, borrala en el portal de Entra.', portal: 'https://entra.example/u-1' }),
  });
  assert.ok(p.textoDe(p.sec()).includes('Invitar a alguien'), 'el bloque de invitar');
  // los estados, al lado de cada correo
  assert.ok(p.textoDe(p.correo('ana@otra.example')).includes('invitación enviada, todavía no entró'));
  assert.ok(p.textoDe(p.correo('bea@otra.example')).includes('no se pudo enviar: Microsoft contestó 503'));
  // invitar: el correo y los productos, y la respuesta con el enlace del pedido y el aviso
  const campos = p.todos(p.sec()).filter((n) => n.tag === 'input' && /invitar|productos/i.test(n.attrs['aria-label'] || ''));
  campos[0].value = 'nueva@otra.example'; campos[1].value = 'alfa, beta';
  p.boton('Invitar').on.click(); await p.soltar();
  assert.deepStrictEqual(p.llamadas.find((c) => c.ruta === '/api/config/invitar').cuerpo.productos, ['alfa', 'beta']);
  assert.strictEqual(p.llamadas.find((c) => c.ruta === '/api/config/invitar').cuerpo.correo, 'nueva@otra.example');
  assert.ok(p.todos(p.sec()).some((n) => n.tag === 'a' && n.attrs.href === enlace), 'el enlace del pedido');
  assert.ok(p.textoDe(p.sec()).includes('Ese correo no es una cuenta de Microsoft'), 'y el aviso');
  // revocar: el pedido de baja y el enlace al portal, al lado del correo
  p.todos(p.correo('ana@otra.example')).find((n) => n.tag === 'button' && n.textContent === 'Revocar').on.click(); await p.soltar();
  assert.strictEqual(p.llamadas.find((c) => c.ruta === '/api/config/revocar').cuerpo.correo, 'ana@otra.example');
  assert.ok(p.todos(p.correo('ana@otra.example')).some((n) => n.tag === 'a' && n.attrs.href === 'https://entra.example/u-1'), 'el enlace al usuario invitado');
});

test('2.74-Pantalla_SinPermisoYOtrosInicios @story-2.74 @ac-2 @ac-3', async () => {
  const sin = await pantallaDelSitio({ ...INV_OK(), permiso: { ok: false, texto: 'Falta el permiso de invitar. Lo da, una vez, un administrador del directorio', comando: 'node … --phase permiso-de-invitar --apply' } });
  assert.ok(!sin.boton('Invitar'), 'sin el permiso no hay botón');
  assert.ok(sin.textoDe(sin.sec()).includes('--phase permiso-de-invitar'), 'el comando');
  const otro = await pantallaDelSitio({ boton: false, motivo: 'otro_proveedor', texto: 'Con GitHub no se invita: sumá a la persona a la lista', permiso: null, estados: {} });
  assert.ok(!otro.boton('Invitar'));
  assert.ok(otro.textoDe(otro.sec()).includes('Con GitHub no se invita'));
});

test('T6 2.74-Invitar_ProponeElAlta @story-2.74 @ac-5', { skip: SIN_BACKEND }, async () => {
  const archivo = ops();
  archivo.people = { projects: { [DEV]: { add: ['alfa'] } } };
  await sitioConInvitar({ archivo }, async ({ entrar, post, gh, r, ms }) => {
    const lead = await entrar(LEAD);
    const res = (await post(lead, 'invitar', { correo: ' Lu@Otra.Example ', productos: ['alfa', 'beta'] })).json;
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.ok(res.enlace, 'la respuesta trae el enlace del pedido');
    assert.match(res.message, /la invitación sale cuando se apruebe/);
    assert.strictEqual(gh.st.pedidos.length, 1, 'un solo pedido');
    const rama = gh.st.pedidos[0].head && (gh.st.pedidos[0].head.ref || gh.st.pedidos[0].head);
    const nuevo = JSON.parse(r.archivoEn(rama, 'operations.json'));
    const esperado = JSON.parse(JSON.stringify(archivo));
    esperado.site.access.push({ role: 'dev', emails: ['lu@otra.example'] });
    esperado.people.projects['lu@otra.example'] = { add: ['alfa', 'beta'] };
    esperado.site.invitations = { 'lu@otra.example': { por: LEAD, el: '2026-10-22' } };
    assert.deepStrictEqual(nuevo, esperado, 'el resto, igual');
    assert.deepStrictEqual(ms.st.invitaciones, [], 'nada sale hacia Graph');
  });
});

test('T12 2.74-Revocar_BajaYEnlace @story-2.74 @ac-10', { skip: SIN_BACKEND }, async () => {
  // dos invitadas: «mia» ya enviada, «noe» todavía sin enviar (su alta entró, el ciclo no pasó)
  const archivo = conInvitado('mia@otra.example');
  archivo.site.access.push({ role: 'dev', emails: ['noe@otra.example'] });
  archivo.site.invitations['noe@otra.example'] = { por: LEAD, el: '2026-10-22' };
  await sitioConInvitar({ archivo }, async ({ entrar, post, gh, r, invitaciones, ms, reloj }) => {
    await invitaciones.enviarPendientes(conInvitado('mia@otra.example'));
    const lead = await entrar(LEAD);
    const res = (await post(lead, 'revocar', { correo: 'MIA@otra.example' })).json;
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.match(res.message, /portal/);
    assert.match(res.portal || '', /u-1/, 'con el enlace al usuario invitado');
    const rama = gh.st.pedidos[0].head && (gh.st.pedidos[0].head.ref || gh.st.pedidos[0].head);
    const nuevo = JSON.parse(r.archivoEn(rama, 'operations.json'));
    assert.ok(!JSON.stringify(nuevo.site.access).includes('mia@'), 'sin la entrada');
    assert.ok(!nuevo.site.invitations || !nuevo.site.invitations['mia@otra.example'], 'sin la marca');
    assert.ok(nuevo.site.invitations['noe@otra.example'], 'la otra marca queda');
    // revocar a la que todavía no se mandó (el primer pedido ya se cerró): con la baja en vigor, el ciclo no la manda
    gh.st.pedidos[0].state = 'closed';
    reloj.t += 60 * 1000;
    const baja = (await post(lead, 'revocar', { correo: 'noe@otra.example' })).json;
    assert.strictEqual(baja.ok, true, JSON.stringify(baja));
    const sinNoe = JSON.parse(r.archivoEn(gh.st.pedidos[1].head.ref, 'operations.json'));
    assert.ok(!sinNoe.site.invitations || !sinNoe.site.invitations['noe@otra.example']);
    await invitaciones.enviarPendientes(sinNoe);
    assert.ok(!ms.st.invitaciones.some((x) => x.cuerpo.invitedUserEmailAddress === 'noe@otra.example'), 'la sin enviar no sale');
  });
});
