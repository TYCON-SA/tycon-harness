'use strict';
/*
 * site-live-hub.test.js — el sitio recibe las oficinas de las máquinas y las reparte a quien las puede ver.
 *
 * Las máquinas de juguete son la conexión real de la máquina (scripts/tools/office/site-link.js) o una conexión a mano
 * cuando la prueba necesita mandar lo que la real nunca manda. El sitio es el servidor real, con el emisor local.
 *
 * T11 Alta_HuellaPorElBuzon_AtaElPedidoALaMaquina     T12 Llave_VenceA30DiasSinConectar_YBajaPorMaquina
 * T13 Puertas_SeparadasPorCredencial                  T14 Reparto_DevVeSusMaquinas
 * T15 Reparto_QuienMantieneVeTodas_SinRolNinguna      T41 Perilla_TodosVenTodas_YValorRaro
 * T16 Reparto_EnMenosDeDosSegundos                    T17 SinConexion_TresMinutos_Y24Horas
 * T18 Topes_CierranSoloEsaConexion                    T37 Sitio_EsquemaCerrado_DescartaYCierra_TextoEscapado
 * T38 Topes_PorDireccionYCarrilSeparado_LaMaquinaConClavePasa
 * T39 CheckDeploy_RutasDeLaMaquina_LleganAlSitio      T19 Reinicio_LasMaquinasVuelven
 * T30 Alta_TopesPorDireccion_YVenceASieteDias         T31 Maquina_LaDiceLaClave_YLaNuevaDesplaza
 * T32 Revision_CadaSesentaSegundos                    T33 Replicas_UnaEnCadaReceta
 * T35 RutasSinSesion_ListaFijada_RecetaConTrustProxy  T42 Imagen_TraeLoQueCargaElCentro
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { arrancarEmisor } = require('./lib/fake-oidc.js');
const H = require('./lib/site-harness.js');

const ROOT = path.resolve(H.SITE, '..', '..');
const WS = require(path.join(ROOT, 'scripts', 'tools', 'office', 'vendor', 'ws'));
const F = require(path.join(ROOT, 'scripts', 'tools', 'office', 'fields.js'));
const SL = require(path.join(ROOT, 'scripts', 'tools', 'office', 'site-link.js'));
const { crearSitio, RUTAS_SIN_SESION, VARIABLES } = require(path.join(H.SITE, 'server.js'));
const { crearLlaves, TOPES_ALTA } = require(path.join(H.SITE, 'machine-keys.js'));
const { TOPES, PLAZOS, limpiarFoto, direccionDe } = require(path.join(H.SITE, 'live-hub.js'));
const { leerHuellas } = require(path.join(H.SITE, 'sources.js'));
const access = require(path.join(H.SITE, 'access.js'));
const { bajar } = require(path.join(ROOT, 'scripts', 'metrics', 'download-runs.js'));
const { leerEspejoEnWorker } = require(path.join(H.SITE, 'summaries.js'));
const { parse: leerOperaciones } = require(path.join(ROOT, 'scripts', 'lib', 'operations-config.js'));

const A = 'dev.a@acme.example';
const B = 'dev.b@acme.example';
const LEAD = 'lead@acme.example';
const NADIE = 'nadie@acme.example';
const DIA = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

const sha = (c) => crypto.createHash('sha256').update(c).digest('hex');
const confirmada = (person) => ({ person, reported_sha256: sha(person), confirmed_by: LEAD, confirmed_on: '2026-10-15' });

/** La configuración de siempre: maquina-a de A y maquina-b de B, las dos confirmadas. */
function ops({ visibility, mailbox = true, machines } = {}) {
  return {
    version: 1,
    owners: { default: LEAD },
    site: {
      access: [{ role: 'maintainer', emails: [LEAD] }, { role: 'dev', emails: [A] }, { role: 'dev', emails: [B] }],
      ...(mailbox ? { mailbox: { provider: 'azure-blob', account: 'cuentax', container: 'runs' } } : {}),
      ...(visibility ? { offices: { visibility } } : {}),
    },
    people: { machines: machines || { 'maquina-a': confirmada(A), 'maquina-b': confirmada(B) } },
  };
}
const personasDe = () => ({ informados: H.informados({ 'maquina-a': A, 'maquina-b': B }), repos: null });
const reglasDe = (config = ops()) => access.crearReglas({ config, modelo: {}, personas: personasDe() });

function par() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clave-'));
  const key = SL.ensureKey(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return key;
}
const huellasDe = (porCarpeta, extra = {}) => ({ medido: true, carpetas: Object.fromEntries(Object.entries(porCarpeta).map(([k, v]) => [k, { huellas: v, llena: false }])), ...extra });
const pedir = (ll, key, direccion = '10.0.0.1', nombre = 'pista') => ll.pedir({ publicKey: key.publicKey, fingerprint: key.fingerprint, nombre, direccion });

const puertoLibre = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(cond, ms = 5000, que = 'la condición') {
  // stable-data: el reloj sólo pone el plazo de espera de la prueba; no entra en lo que se compara
  const fin = Date.now() + ms;
  while (Date.now() < fin) { if (cond()) return; await pausa(10); }
  throw new Error(`no se cumplió ${que}`);
}

/** El sitio real, en su dirección pública (la firma de la máquina la nombra), con su centro y su disco. */
async function montar({ config = ops(), personas = personasDe(), huellas = { medido: false, carpetas: {} }, reloj = null, opciones = {}, env = {}, dataDir, cargado = true, topesAlta = {} } = {}) {
  const emisor = await arrancarEmisor();
  const puerto = await puertoLibre();
  const base = `http://127.0.0.1:${puerto}`;
  const fuentes = H.fuentesFijas({ config, personas, cargado });
  fuentes.st.huellas = huellas;
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'sitio-'));
  const registro = [];
  const log = (l) => registro.push(l);
  const ahora = reloj ? () => reloj.t : Date.now;
  const crear = () => {
    const llaves = crearLlaves({ dataDir: dir, ahora, log, topes: topesAlta });
    const sitio = crearSitio({ env: H.envBase({ SITE_OIDC_ISSUER: emisor.issuer, SITE_PUBLIC_URL: base, ...env }), fuentes, llaves, centroOpciones: { repartoMs: 40, ...opciones }, ahora, log });
    return { sitio, llaves };
  };
  let { sitio, llaves } = crear();
  const escuchar = async () => { await sitio.iniciar(); await new Promise((r) => sitio.server.listen(puerto, '127.0.0.1', r)); };
  await escuchar();
  const h = {
    base, emisor, fuentes, registro, dir,
    get sitio() { return sitio; },
    get llaves() { return llaves; },
    get centro() { return sitio.centro; },
    pedir: (ruta, o) => H.pedirA(base, ruta, o),
    entrar: async (email) => (await H.ingresar(h, emisor, { sub: `s-${email}`, email, email_verified: true })).sesion,
    /** Aprueba una clave como lo hace quien mantiene. */
    aprobar(key, maquina = 'maquina-a') {
      fuentes.st.huellas = huellasDe({ ...Object.fromEntries(Object.entries(fuentes.st.huellas.carpetas).map(([k, v]) => [k, v.huellas])), [maquina]: [key.fingerprint] });
      const r = llaves.aprobar(key.fingerprint, LEAD, { huellas: fuentes.st.huellas, reglas: reglasDe(fuentes.st.config), conBuzon: true });
      assert.strictEqual(r.ok, true, `no se pudo aprobar: ${r.motivo}`);
    },
    /** Reinicia el sitio; `sinDisco` imita un sitio que perdió su carpeta de datos. */
    async reiniciar({ sinDisco = false } = {}) {
      await sitio.cerrar();
      if (sinDisco) fs.rmSync(path.join(dir, 'office'), { recursive: true, force: true });
      ({ sitio, llaves } = crear());
      await escuchar();
    },
    async cerrar() { await sitio.cerrar(); await emisor.cerrar(); if (!dataDir) fs.rmSync(dir, { recursive: true, force: true }); },
  };
  return h;
}

/** Una conexión a mano a una puerta del sitio. Recoge lo que llega y cómo se cerró. */
function conectar(h, ruta, { headers = {}, origin } = {}) {
  const ws = new WS(`${h.base.replace('http', 'ws')}${ruta}`, { headers: { ...(origin ? { origin } : {}), ...headers } });
  const c = { ws, msgs: [], cerro: null, abierta: false, error: null };
  ws.on('open', () => { c.abierta = true; });
  ws.on('message', (m) => { try { c.msgs.push(JSON.parse(String(m))); } catch { c.msgs.push(String(m)); } });
  ws.on('close', (code) => { c.cerro = code; });
  ws.on('error', (e) => { c.error = e; if (c.cerro === null) c.cerro = -1; });
  return c;
}
const textoFirmado = (h, nonce) => F.signedText(h.base, nonce);
const firmar = (key, texto) => crypto.sign(null, Buffer.from(texto), crypto.createPrivateKey(key.privateKey)).toString('base64');

/** Una máquina a mano ya autenticada. */
async function maquinaCruda(h, key, opciones) {
  const c = conectar(h, '/live/machine', opciones);
  await hasta(() => c.msgs.some((m) => m.type === 'challenge') || c.cerro !== null, 3000, 'el desafío');
  const reto = c.msgs.find((m) => m.type === 'challenge');
  if (reto) c.ws.send(JSON.stringify({ type: 'auth', publicKey: key.publicKey, fingerprint: key.fingerprint, signature: firmar(key, textoFirmado(h, reto.nonce)) }));
  await hasta(() => c.msgs.some((m) => m.type === 'ack') || c.cerro !== null, 3000, 'el ack o el cierre');
  return c;
}

/** Una máquina real: su clave, su estado y su conexión. */
function maquinaReal(h, { sdir, estado = 'pedida' } = {}) {
  const dir = sdir || fs.mkdtempSync(path.join(os.tmpdir(), 'maquina-'));
  const key = SL.ensureKey(dir);
  SL.writeLinkState(dir, estado);
  const link = SL.createLink({ site: h.base, sdir: dir, home: os.homedir(), WebSocket: WS, random: () => 0 });
  return { dir, key, link, parar() { link.stop(); if (!sdir) fs.rmSync(dir, { recursive: true, force: true }); } };
}

const FOTO = (nombre = 'Sesion Uno', extra = {}) => ({ agents: [{ nombre, estado: 'trabajando', titulo: 'una historia', ...extra }], free: [], unreadable: [] });
const oficinas = (nav) => {
  const out = new Map();
  for (const m of nav.msgs) {
    if (!m || m.type !== 'oficinas') continue;
    if (m.entera) out.clear();
    for (const o of m.oficinas || []) out.set(o.id, o);
    for (const id of m.fuera || []) out.delete(id);
  }
  return out;
};
async function navegador(h, email) {
  const cookie = await h.entrar(email);
  const c = conectar(h, '/live/offices', { origin: h.base, headers: { cookie } });
  await hasta(() => c.msgs.length > 0 || c.cerro !== null, 3000, 'la primera lista de oficinas');
  c.cookie = cookie;
  return c;
}
async function dosMaquinasConectadas(h) {
  const ka = par(); const kb = par();
  pedir(h.llaves, ka); pedir(h.llaves, kb, '10.0.0.2');
  h.fuentes.st.huellas = huellasDe({ 'maquina-a': [ka.fingerprint], 'maquina-b': [kb.fingerprint] });
  const ctx = { huellas: h.fuentes.st.huellas, reglas: reglasDe(h.fuentes.st.config), conBuzon: true };
  assert.strictEqual(h.llaves.aprobar(ka.fingerprint, LEAD, ctx).ok, true);
  assert.strictEqual(h.llaves.aprobar(kb.fingerprint, LEAD, ctx).ok, true);
  const ma = await maquinaCruda(h, ka);
  const mb = await maquinaCruda(h, kb);
  ma.ws.send(JSON.stringify({ type: 'foto', data: FOTO('Sesion de A') }));
  mb.ws.send(JSON.stringify({ type: 'foto', data: FOTO('Sesion de B') }));
  return { ka, kb, ma, mb };
}

// ── Lo que baja del buzón y el alta ─────────────────────────────────────────────────────────

test('T11 Alta_HuellaPorElBuzon_AtaElPedidoALaMaquina — @story-8.171 @ac-9', async () => {
  const k = par(); const vieja = par(); const otra = par();
  const espejo = fs.mkdtempSync(path.join(os.tmpdir(), 'espejo-'));
  const archivo = (key) => JSON.stringify({ fingerprint: key.fingerprint, publicKey: key.publicKey });
  const volcado = JSON.stringify(H.volcado ? H.volcado({ story: '2.2' }) : {});
  const blobs = {
    'maquina-a/2.2-2026-09-02T1000.json': volcado,
    [`maquina-a/office-keys/${k.fingerprint}.json`]: archivo(k),
    [`maquina-a/office-keys/${vieja.fingerprint}.json`]: archivo(vieja),
  };
  const buzon = await H.arrancarBuzon({ blobs });
  try {
    // el camino real: la bajada del buzón, sin armar la carpeta a mano
    const sinHuellasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'espejo-'));
    const sin = await H.arrancarBuzon({ blobs: { 'maquina-a/2.2-2026-09-02T1000.json': volcado } });
    await bajar({ cuenta: 'cuentax', contenedor: 'runs', credencial: { sas: H.sas() }, urlBase: sin.base, dir: sinHuellasDir, budgetMs: 60000 });
    await sin.cerrar();
    const r = await bajar({ cuenta: 'cuentax', contenedor: 'runs', credencial: { sas: H.sas() }, urlBase: buzon.base, dir: espejo, budgetMs: 60000 });
    assert.strictEqual(r.codigo, 0);
    assert.strictEqual(r.res.ignorados, 0, 'la forma de la huella es una de las conocidas');
    const leidas = leerHuellas(espejo, () => {});
    assert.deepStrictEqual([...leidas.carpetas['maquina-a'].huellas].sort(), [k.fingerprint, vieja.fingerprint].sort(), 'una clave anterior de la misma máquina también baja y cuenta');
    // no entra como volcado: el informe de corridas es el mismo con y sin la huella
    const con = await leerEspejoEnWorker({ buzon: espejo });
    const sinHuella = await leerEspejoEnWorker({ buzon: sinHuellasDir });
    const sinFechas = (x) => JSON.stringify(x, (key, v) => (['fecha', 'leido_en', 'generado'].includes(key) ? undefined : v));
    assert.strictEqual(sinFechas(con.corridas), sinFechas(sinHuella.corridas), 'la huella no cambia el informe de corridas');
    fs.rmSync(sinHuellasDir, { recursive: true, force: true });
  } finally { await buzon.cerrar(); }

  // lo que no coincide se ignora y se anota
  const roto = path.join(espejo, 'maquina-a', 'office-keys');
  fs.writeFileSync(path.join(roto, `${otra.fingerprint}.json`), JSON.stringify({ fingerprint: k.fingerprint, publicKey: otra.publicKey }));
  fs.writeFileSync(path.join(roto, `${'a'.repeat(64)}.json`), JSON.stringify({ fingerprint: 'a'.repeat(64), publicKey: otra.publicKey }));
  fs.writeFileSync(path.join(roto, `${'b'.repeat(64)}.json`), 'x'.repeat(513));
  fs.writeFileSync(path.join(roto, 'nombre-raro.json'), archivo(otra));
  const notas = [];
  const conRotos = leerHuellas(espejo, (l) => notas.push(l));
  assert.deepStrictEqual([...conRotos.carpetas['maquina-a'].huellas].sort(), [k.fingerprint, vieja.fingerprint].sort());
  assert.match(notas.join(' | '), /archivos de huellas de maquina-a que se ignoran: 4/, 'lo ignorado se anota');

  // 21 archivos: la carpeta queda marcada
  const llena = path.join(espejo, 'maquina-b', 'office-keys');
  fs.mkdirSync(llena, { recursive: true });
  for (let i = 0; i < 21; i += 1) { const x = par(); fs.writeFileSync(path.join(llena, `${x.fingerprint}.json`), archivo(x)); }
  assert.strictEqual(leerHuellas(espejo, () => {}).carpetas['maquina-b'].llena, true);
  fs.rmSync(espejo, { recursive: true, force: true });

  // el pedido y el par
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llaves-'));
  const ll = crearLlaves({ dataDir: dir, log: () => {} });
  const reglas = reglasDe();
  const situacion = (huellas, conBuzon = true) => ll.vista({ huellas, reglas, conBuzon }).pedidos.find((p) => p.fingerprint === k.fingerprint);
  assert.strictEqual(pedir(ll, k, '10.0.0.1', 'maquina-b').status, 202);
  let p = situacion(huellasDe({}));
  assert.strictEqual(p.situacion, 'esperando_huella');
  assert.strictEqual(p.maquina, null, 'el nombre que manda la máquina es sólo pista');
  assert.strictEqual(p.nombre, 'maquina-b');
  assert.strictEqual(ll.aprobar(k.fingerprint, LEAD, { huellas: huellasDe({}), reglas, conBuzon: true }).ok, false, 'sin huella por el buzón no se aprueba');

  p = situacion(huellasDe({ 'maquina-a': [k.fingerprint] }));
  assert.strictEqual(p.situacion, 'listo');
  assert.strictEqual(p.maquina, 'maquina-a', 'la máquina sale del buzón, no de la pista');
  assert.strictEqual(p.person, A);

  assert.strictEqual(situacion(huellasDe({ 'maquina-a': [k.fingerprint], 'maquina-b': [k.fingerprint] })).situacion, 'dos_maquinas');
  assert.strictEqual(ll.aprobar(k.fingerprint, LEAD, { huellas: huellasDe({ 'maquina-a': [k.fingerprint], 'maquina-b': [k.fingerprint] }), reglas, conBuzon: true }).ok, false);

  const conLlena = { medido: true, carpetas: { 'maquina-a': { huellas: [k.fingerprint], llena: true } } };
  assert.strictEqual(situacion(conLlena).situacion, 'carpeta_llena');
  assert.strictEqual(ll.aprobar(k.fingerprint, LEAD, { huellas: conLlena, reglas, conBuzon: true }).ok, false);

  // una máquina sin confirmar no ata el pedido
  assert.strictEqual(situacion(huellasDe({ 'maquina-z': [k.fingerprint] })).situacion, 'esperando_huella');

  // dos huellas vigentes en una carpeta: se aprueba sólo con la marca de quien mantiene, anotada
  const conflicto = huellasDe({ 'maquina-a': [k.fingerprint, otra.fingerprint] });
  assert.strictEqual(situacion(conflicto).situacion, 'conflicto');
  assert.strictEqual(ll.aprobar(k.fingerprint, LEAD, { huellas: conflicto, reglas, conBuzon: true }).ok, false);
  assert.strictEqual(ll.confirmarHuella(k.fingerprint, LEAD).ok, true);
  assert.strictEqual(situacion(conflicto).situacion, 'listo');
  assert.strictEqual(ll.aprobar(k.fingerprint, LEAD, { huellas: conflicto, reglas, conBuzon: true }).ok, true);
  assert.ok(fs.readFileSync(path.join(dir, 'office', 'machine-keys.json'), 'utf8').includes(LEAD), 'la marca queda anotada con quién');

  // sitio sin buzón: no se puede aprobar
  const k2 = par();
  pedir(ll, k2);
  assert.strictEqual(ll.vista({ huellas: huellasDe({ 'maquina-b': [k2.fingerprint] }), reglas, conBuzon: false }).pedidos.find((x) => x.fingerprint === k2.fingerprint).situacion, 'sin_buzon');
  assert.strictEqual(ll.aprobar(k2.fingerprint, LEAD, { huellas: huellasDe({ 'maquina-b': [k2.fingerprint] }), reglas, conBuzon: false }).ok, false);

  // rechazar la deja afuera
  assert.strictEqual(ll.rechazar(k2.fingerprint, LEAD).ok, true);
  assert.strictEqual(ll.alConectar(k2.fingerprint).codigo, F.CLOSE.revoked);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('T12 Llave_VenceA30DiasSinConectar_YBajaPorMaquina — @story-8.171 @ac-9', async () => {
  const reloj = { t: Date.UTC(2026, 10, 3) };
  const h = await montar({ reloj });
  try {
    const k = par();
    pedir(h.llaves, k);
    h.aprobar(k);
    // conectada a diario no vence
    for (let i = 0; i < 40; i += 1) { reloj.t += DIA; assert.strictEqual(h.llaves.alConectar(k.fingerprint).codigo, null, `día ${i}`); }
    // 30 días sin conectarse, sí
    reloj.t += 30 * DIA + 1000;
    h.llaves.vencer();
    assert.strictEqual(h.llaves.alConectar(k.fingerprint).codigo, F.CLOSE.unknown);

    // de baja corta la conexión abierta con 4403
    const k2 = par();
    pedir(h.llaves, k2);
    h.aprobar(k2);
    const m = await maquinaCruda(h, k2);
    assert.ok(m.msgs.some((x) => x.type === 'ack'));
    assert.strictEqual(h.llaves.darDeBaja('maquina-a', LEAD).ok, true);
    await hasta(() => m.cerro !== null, 2000, 'el cierre de la baja');
    assert.strictEqual(m.cerro, F.CLOSE.revoked);

    // una clave nueva de esa máquina se rechaza sola, al emparejar con el buzón
    const k3 = par();
    assert.strictEqual(pedir(h.llaves, k3).status, 202);
    assert.strictEqual(h.llaves.alConectar(k3.fingerprint).codigo, F.CLOSE.pending, 'hasta emparejar, pendiente');
    const huellas = huellasDe({ 'maquina-a': [k2.fingerprint, k3.fingerprint] });
    h.llaves.emparejar({ huellas, reglas: reglasDe(), conBuzon: true });
    assert.strictEqual(h.llaves.alConectar(k3.fingerprint).codigo, F.CLOSE.revoked, 'desde que empareja, 4403');

    // reactivada, vuelve sin alta nueva
    assert.strictEqual(h.llaves.reactivar('maquina-a', LEAD).ok, true);
    assert.strictEqual(h.llaves.alConectar(k2.fingerprint).codigo, null);
  } finally { await h.cerrar(); }
});

// ── Las dos puertas ─────────────────────────────────────────────────────────────────────────

test('T13 Puertas_SeparadasPorCredencial — @story-8.171 @ac-10', async () => {
  const h = await montar({ opciones: { plazos: { saludoMs: 200 } } });
  try {
    assert.strictEqual(PLAZOS.saludoMs, 5000, 'el saludo se corta a los 5 s');
    const cookie = await h.entrar(LEAD);
    // credencial cruzada: la cookie no abre la puerta de la máquina
    const cruzada = conectar(h, '/live/machine', { origin: h.base, headers: { cookie } });
    await hasta(() => cruzada.msgs.length > 0, 2000, 'el desafío');
    cruzada.ws.send(JSON.stringify({ type: 'foto', data: FOTO() }));
    await hasta(() => cruzada.cerro !== null, 2000, 'el cierre');
    assert.strictEqual(cruzada.cerro, F.CLOSE.policy, 'en la puerta de la máquina sólo vale la firma');
    // la firma no abre la puerta del navegador
    const sinCookie = conectar(h, '/live/offices', { origin: h.base });
    await hasta(() => sinCookie.cerro !== null, 2000, 'el rechazo');
    assert.ok(!sinCookie.msgs.length, 'sin sesión no llega nada');
    // `Origin` ajeno
    const ajeno = conectar(h, '/live/offices', { origin: 'https://otro.example', headers: { cookie } });
    await hasta(() => ajeno.cerro !== null, 2000, 'el rechazo');
    assert.ok(!ajeno.msgs.length, 'de otro origen no llega nada');
    // saludo sin autenticar
    const mudo = conectar(h, '/live/machine');
    await hasta(() => mudo.cerro !== null, 2000, 'el corte del saludo');
    assert.ok(!mudo.msgs.some((x) => x.type === 'ack'));

    const k = par();
    // la firma de un desafío viejo no sirve
    const vieja = conectar(h, '/live/machine');
    await hasta(() => vieja.msgs.length > 0, 2000, 'el desafío');
    const nonceViejo = crypto.randomBytes(32).toString('base64');
    vieja.ws.send(JSON.stringify({ type: 'auth', publicKey: k.publicKey, fingerprint: k.fingerprint, signature: firmar(k, textoFirmado(h, nonceViejo)) }));
    await hasta(() => vieja.cerro !== null, 2000, 'el rechazo');
    assert.strictEqual(vieja.cerro, F.CLOSE.policy);
    // firma de otro sitio
    const otroSitio = conectar(h, '/live/machine');
    await hasta(() => otroSitio.msgs.length > 0, 2000, 'el desafío');
    otroSitio.ws.send(JSON.stringify({ type: 'auth', publicKey: k.publicKey, fingerprint: k.fingerprint, signature: firmar(k, F.signedText('https://otro.example', otroSitio.msgs[0].nonce)) }));
    await hasta(() => otroSitio.cerro !== null, 2000, 'el rechazo');
    assert.strictEqual(otroSitio.cerro, F.CLOSE.policy);

    // desconocida, pendiente, de baja: el código y sin abrir
    const desconocida = await maquinaCruda(h, k);
    await hasta(() => desconocida.cerro !== null, 2000, '4404');
    assert.strictEqual(desconocida.cerro, F.CLOSE.unknown);
    pedir(h.llaves, k);
    const pendiente = await maquinaCruda(h, k);
    await hasta(() => pendiente.cerro !== null, 2000, '4401');
    assert.strictEqual(pendiente.cerro, F.CLOSE.pending);
    assert.ok(!pendiente.msgs.some((x) => x.type === 'ack'));
    h.llaves.rechazar(k.fingerprint, LEAD);
    const rechazada = await maquinaCruda(h, k);
    await hasta(() => rechazada.cerro !== null, 2000, '4403');
    assert.strictEqual(rechazada.cerro, F.CLOSE.revoked);

    // cargando o frenado: 1013 en las dos puertas, nunca 4404
    const k2 = par();
    h.fuentes.st.cargado = false; h.fuentes.st.navegable = false;
    const cargando = conectar(h, '/live/machine');
    await hasta(() => cargando.cerro !== null, 2000, 'el cierre');
    assert.strictEqual(cargando.cerro, 1013);
    const navCargando = conectar(h, '/live/offices', { origin: h.base, headers: { cookie } });
    await hasta(() => navCargando.cerro !== null, 2000, 'el cierre');
    assert.strictEqual(navCargando.cerro, 1013);
    assert.strictEqual((await h.pedir('/live/enroll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicKey: k2.publicKey, fingerprint: k2.fingerprint, nombre: 'x' }) })).status, 503);
    h.fuentes.st.cargado = true; h.fuentes.st.navegable = true; h.fuentes.st.frenado = { desde: 1, fallaDesde: 1 };
    const frenado = conectar(h, '/live/machine');
    await hasta(() => frenado.cerro !== null, 2000, 'el cierre');
    assert.strictEqual(frenado.cerro, 1013);
    h.fuentes.st.frenado = null;
  } finally { await h.cerrar(); }
});

// ── Quién ve qué ────────────────────────────────────────────────────────────────────────────

test('T14 Reparto_DevVeSusMaquinas — @story-8.171 @ac-11', async () => {
  const h = await montar();
  try {
    const { ma, mb } = await dosMaquinasConectadas(h);
    const nav = await navegador(h, A);
    await hasta(() => oficinas(nav).has('maquina-a'), 3000, 'su oficina');
    await pausa(120);
    assert.deepStrictEqual([...oficinas(nav).keys()], ['maquina-a']);
    assert.ok(!JSON.stringify(nav.msgs).includes('maquina-b'), 'ningún mensaje nombra la máquina ajena');
    assert.ok(!JSON.stringify(nav.msgs).includes('Sesion de B'), 'ni su contenido');
    assert.strictEqual(oficinas(nav).get('maquina-a').foto.agents[0].nombre, 'Sesion de A');
    nav.ws.close(); ma.ws.close(); mb.ws.close();
  } finally { await h.cerrar(); }
});

test('T15 Reparto_QuienMantieneVeTodas_SinRolNinguna — @story-8.171 @ac-11', async () => {
  const h = await montar();
  try {
    const { ma, mb } = await dosMaquinasConectadas(h);
    const lead = await navegador(h, LEAD);
    await hasta(() => oficinas(lead).size === 2, 3000, 'las dos oficinas');
    const nadie = await navegador(h, NADIE);
    await hasta(() => nadie.cerro !== null, 2000, 'el cierre de quien no tiene rol');
    assert.ok(!JSON.stringify(nadie.msgs).includes('maquina-'), 'sin rol, ninguna');
    lead.ws.close(); ma.ws.close(); mb.ws.close();
  } finally { await h.cerrar(); }
});

test('T41 Perilla_TodosVenTodas_YValorRaro — @story-8.171 @ac-11 @ac-11b', async () => {
  // el lector de la configuración
  const raro = leerOperaciones(JSON.stringify(ops({ visibility: 'cualquiera' })));
  assert.strictEqual(raro.ok, false, 'un valor raro no pasa el lector');
  assert.ok(raro.problems.some((p) => p.path === 'site.offices.visibility'));
  assert.strictEqual(leerOperaciones(JSON.stringify(ops({ visibility: 'everyone' }))).ok, true);
  assert.strictEqual(leerOperaciones(JSON.stringify(ops({ visibility: 'maintainers' }))).ok, true);
  assert.strictEqual(leerOperaciones(JSON.stringify(ops())).ok, true, 'sin valor escrito');

  const reloj = { t: Date.now() };
  const h = await montar({ config: ops({ visibility: 'everyone' }), reloj });
  try {
    const { ma, mb } = await dosMaquinasConectadas(h);
    const nav = await navegador(h, A);
    await hasta(() => oficinas(nav).size === 2, 3000, 'todas, con everyone');
    assert.strictEqual(access.oficinasQueVe({ rol: 'none', email: NADIE }, reglasDe(), 'everyone')('maquina-a'), false, 'sin rol, ninguna ni con everyone');
    // sin valor escrito, el de fábrica; al cambiarla, la revisión reparte con la nueva
    h.fuentes.st.config = ops();
    h.centro.revisar();
    await hasta(() => oficinas(nav).size === 1 && oficinas(nav).has('maquina-a'), 3000, 'la perilla nueva');
    nav.ws.close(); ma.ws.close(); mb.ws.close();
  } finally { await h.cerrar(); }
});

test('T16 Reparto_EnMenosDeDosSegundos — @story-8.171 @ac-12', async () => {
  const h = await montar({ opciones: { repartoMs: 500 } });
  try {
    assert.strictEqual(PLAZOS.repartoMs, 500);
    const k = par();
    pedir(h.llaves, k);
    h.aprobar(k);
    // una máquina real, con el código de site-link.js
    const m = maquinaReal(h);
    pedir(h.llaves, m.key);
    h.fuentes.st.huellas = huellasDe({ 'maquina-a': [m.key.fingerprint] });
    assert.strictEqual(h.llaves.confirmarHuella(m.key.fingerprint, LEAD).ok, true);
    assert.strictEqual(h.llaves.aprobar(m.key.fingerprint, LEAD, { huellas: h.fuentes.st.huellas, reglas: reglasDe(), conBuzon: true }).ok, true);
    m.link.start();
    m.link.update(FOTO('Primera'));
    const nav = await navegador(h, A);
    await hasta(() => oficinas(nav).has('maquina-a'), 3000, 'la primera foto');
    const antes = nav.msgs.length;
    // stable-data: mide cuánto tarda en llegar; es el criterio de la prueba
    const t0 = Date.now();
    m.link.update(FOTO('Segunda'));
    await hasta(() => oficinas(nav).get('maquina-a').foto.agents[0].nombre === 'Segunda', 2000, 'el cambio');
    assert.ok(Date.now() - t0 < 2000, 'llega en menos de 2 s');
    // el reparto se agrupa: tres cambios seguidos, a lo sumo un mensaje por medio segundo
    const m0 = nav.msgs.length;
    m.link.update(FOTO('Tercera')); m.link.update(FOTO('Cuarta')); m.link.update(FOTO('Quinta'));
    await hasta(() => oficinas(nav).get('maquina-a').foto.agents[0].nombre === 'Quinta', 2000, 'el último cambio');
    assert.ok(nav.msgs.length - m0 <= 2, `agrupados: ${nav.msgs.length - m0}`);
    assert.ok(antes >= 1);
    nav.ws.close(); m.parar();
  } finally { await h.cerrar(); }
});

test('T17 SinConexion_TresMinutos_Y24Horas — @story-8.171 @ac-13', async () => {
  const reloj = { t: Date.now() };
  const h = await montar({ reloj });
  try {
    const { ma, mb } = await dosMaquinasConectadas(h);
    await hasta(() => h.centro.oficina('maquina-a') && h.centro.oficina('maquina-a').foto, 2000, 'la foto');
    // un ping recibe pong y cuenta como latido
    reloj.t += 2 * MIN;
    ma.ws.send(JSON.stringify({ type: 'ping' }));
    mb.ws.send(JSON.stringify({ type: 'ping' }));
    await hasta(() => ma.msgs.some((x) => x.type === 'pong') && mb.msgs.some((x) => x.type === 'pong'), 2000, 'el pong');
    reloj.t += 2 * MIN;
    h.centro.revisar();
    assert.strictEqual(h.centro.oficina('maquina-a').sinConexionDesde, null, 'el ping contó');
    // una foto también
    reloj.t += 2 * MIN;
    mb.ws.send(JSON.stringify({ type: 'foto', data: FOTO('Otra de B') }));
    await hasta(() => h.centro.oficina('maquina-b').foto.agents[0].nombre === 'Otra de B', 2000, 'la foto');
    reloj.t += 2 * MIN;
    h.centro.revisar();
    assert.strictEqual(h.centro.oficina('maquina-b').sinConexionDesde, null, 'la foto contó');
    // sin latido durante 3 min
    const ultimo = reloj.t;
    reloj.t += 3 * MIN + 1000;
    h.centro.revisar();
    const o = h.centro.oficina('maquina-b');
    assert.ok(o.sinConexionDesde && o.sinConexionDesde <= ultimo, 'sin conexión desde su último latido');
    assert.strictEqual(o.foto.agents[0].nombre, 'Otra de B', 'con su última foto');
    // a las 24 h sale
    reloj.t += DIA + 1000;
    h.centro.revisar();
    assert.strictEqual(h.centro.oficina('maquina-b'), null);
    ma.ws.close(); mb.ws.close();
  } finally { await h.cerrar(); }
});

test('T18 Topes_CierranSoloEsaConexion — @story-8.171 @ac-14', async () => {
  assert.deepStrictEqual({ m: TOPES.maquinas, n: TOPES.navegadoresPorCuenta, a: TOPES.bytesAutenticada, s: TOPES.bytesSinAutenticar, p: TOPES.mensajesPorSegundo }, { m: 50, n: 5, a: 64 * 1024, s: 2 * 1024, p: 10 });
  assert.deepStrictEqual({ n: TOPES.navegadoresTotal, c: TOPES.sinAutenticarTotal }, { n: 200, c: 1000 });
  assert.strictEqual(TOPES_ALTA.pendientesTotal, 500);

  const h = await montar({ opciones: { topes: { maquinas: 2 } } });
  try {
    const { ma, mb } = await dosMaquinasConectadas(h);
    // 2 KB antes de autenticarse
    const grande = conectar(h, '/live/machine');
    await hasta(() => grande.msgs.length > 0, 2000, 'el desafío');
    grande.ws.send(JSON.stringify({ type: 'auth', relleno: 'x'.repeat(3000) }));
    await hasta(() => grande.cerro !== null, 2000, 'el cierre');
    assert.ok([1009, F.CLOSE.policy].includes(grande.cerro), `se cerró con ${grande.cerro}`);
    // 64 KB con la clave autenticada
    ma.ws.send(JSON.stringify({ type: 'foto', data: { agents: [], relleno: 'x'.repeat(70 * 1024) } }));
    await hasta(() => ma.cerro !== null, 2000, 'el cierre');
    assert.strictEqual(ma.cerro, 1009);
    assert.strictEqual(mb.cerro, null, 'la otra sigue');
    // 50 máquinas: la de más se cierra con el motivo; la que estaba, sigue
    const ka = par();
    pedir(h.llaves, ka, '10.0.0.3');
    const m1 = await maquinaCruda(h, (() => { h.fuentes.st.huellas = huellasDe({ 'maquina-a': [ka.fingerprint], 'maquina-b': [] }); assert.strictEqual(h.llaves.confirmarHuella(ka.fingerprint, LEAD).ok, true); assert.strictEqual(h.llaves.aprobar(ka.fingerprint, LEAD, { huellas: h.fuentes.st.huellas, reglas: reglasDe(), conBuzon: true }).ok, true); return ka; })());
    assert.strictEqual(m1.cerro, null, 'entra: maquina-a dejó su lugar');
    const machines = { ...ops().people.machines, 'maquina-c': confirmada(A) };
    h.fuentes.st.config = ops({ machines });
    h.fuentes.st.personas = { informados: H.informados({ 'maquina-a': A, 'maquina-b': B, 'maquina-c': A }), repos: null };
    const kc = par();
    pedir(h.llaves, kc, '10.0.0.4');
    h.fuentes.st.huellas = huellasDe({ 'maquina-c': [kc.fingerprint] });
    assert.strictEqual(h.llaves.aprobar(kc.fingerprint, LEAD, { huellas: h.fuentes.st.huellas, reglas: access.crearReglas({ config: h.fuentes.st.config, modelo: {}, personas: h.fuentes.st.personas }), conBuzon: true }).ok, true);
    const m3 = await maquinaCruda(h, kc);
    await hasta(() => m3.cerro !== null, 2000, 'el tope');
    assert.strictEqual(m3.cerro, 1013);
    assert.strictEqual(mb.cerro, null);
    assert.strictEqual(m1.cerro, null);
    mb.ws.close(); m1.ws.close();
  } finally { await h.cerrar(); }

  // 10 mensajes por segundo y 5 navegadores por cuenta
  const h2 = await montar();
  try {
    const { ma, mb } = await dosMaquinasConectadas(h2);
    for (let i = 0; i < 12; i += 1) ma.ws.send(JSON.stringify({ type: 'ping' }));
    await hasta(() => ma.cerro !== null, 2000, 'el tope de mensajes');
    assert.strictEqual(ma.cerro, F.CLOSE.policy);
    assert.strictEqual(mb.cerro, null);
    const cookie = await h2.entrar(A);
    const navs = [];
    for (let i = 0; i < 6; i += 1) { const c = conectar(h2, '/live/offices', { origin: h2.base, headers: { cookie } }); navs.push(c); await hasta(() => c.msgs.length > 0 || c.cerro !== null, 2000, 'la lista'); }
    assert.strictEqual(navs[5].cerro, F.CLOSE.policy, 'el sexto de la cuenta se cierra');
    assert.ok(navs.slice(0, 5).every((n) => n.cerro === null), 'los otros cinco siguen');
    navs.slice(0, 5).forEach((n) => n.ws.close()); mb.ws.close();
  } finally { await h2.cerrar(); }

  // con SITE_TRUST_PROXY, la dirección es la última de la lista; sin ella, la del socket
  const pedido = (cab) => ({ headers: { 'x-forwarded-for': cab }, socket: { remoteAddress: '10.9.9.9' } });
  assert.strictEqual(direccionDe(pedido('1.1.1.1, 2.2.2.2'), true), '2.2.2.2');
  assert.strictEqual(direccionDe(pedido('inventada, 2.2.2.2'), true), '2.2.2.2', 'lo inventado adelante no cambia la dirección');
  assert.strictEqual(direccionDe(pedido('1.1.1.1, 2.2.2.2'), false), '10.9.9.9');
});

test('T37 Sitio_EsquemaCerrado_DescartaYCierra_TextoEscapado — @story-8.171 @ac-10c', async () => {
  // las formas, sobre la lista real
  const bien = limpiarFoto(FOTO());
  assert.strictEqual(bien.ok, true);
  assert.deepStrictEqual(bien.desconocidos, []);
  // lo que arma la máquina pasa por el sitio tal cual, con cada forma de la lista: las filas de las tablas, con sus
  // trabajos y una de otro proyecto, también
  const fila = (grupo, otro) => ({ grupo, que: 'Dos trabajos', col: 'Haciendo', otro, trabajos: [{ titulo: 'La pestaña', quien: 'Ana', como: 'Haciendo · 14:10', otro }] });
  const tabla = { titulo: 'Hoy', columnas: ['Tema', 'Qué', 'Cómo va'], filas: [fila('Oficinas', false), fila('Otro proyecto', true)], escrito: '14:10', cruce: '', vacio: 'Nada' };
  const deLaMaquina = F.pick({ agents: [{ nombre: 'Ana', estado: 'trabajando' }], tablas: { hoy: tabla, pendientes: tabla, hechos: tabla } }, os.homedir());
  const conTablas = limpiarFoto(deLaMaquina);
  assert.strictEqual(conTablas.ok, true, 'una foto con filas en sus tablas no es una forma mala');
  assert.deepStrictEqual(conTablas.foto, deLaMaquina, 'y llega igual que salió de la máquina');
  assert.strictEqual(limpiarFoto({ tablas: { hoy: { filas: ['no es una fila'] } } }).ok, false, 'una fila que no es un objeto sigue siendo mala');
  assert.strictEqual(limpiarFoto({ agents: [{ nombre: 'x'.repeat(201) }] }).ok, false, 'un texto de más de 200');
  assert.strictEqual(limpiarFoto({ agents: 'no es una lista' }).ok, false, 'una forma que no corresponde');
  assert.strictEqual(limpiarFoto({ agents: [{ avance: 'mucho' }] }).ok, false, 'un número que no lo es');
  assert.strictEqual(limpiarFoto({ agents: [{ estimadaIso: 'mañana' }] }).ok, false, 'una hora inválida');
  assert.strictEqual(limpiarFoto({ agents: [{ carpeta: '/otra/carpeta/proyecto' }] }).ok, false, 'una ruta entera donde va el nombre de la carpeta');
  assert.strictEqual(limpiarFoto('no es un objeto').ok, false);
  // una sesión sin historia pasa: el campo falta o viene en null
  assert.strictEqual(limpiarFoto({ agents: [{ nombre: 'x', estado: 'libre' }] }).ok, true);
  assert.strictEqual(limpiarFoto({ agents: [{ nombre: 'x', estado: 'libre', historia: null }] }).ok, true);
  // lo desconocido se ignora y la foto se acepta (D8)
  const nueva = limpiarFoto({ agents: [{ nombre: 'x', estado: 'estado-nuevo', campoNuevo: 'dato' }], otroNuevo: { a: 1 } });
  assert.strictEqual(nueva.ok, true);
  assert.ok(!JSON.stringify(nueva.foto).includes('dato') && !JSON.stringify(nueva.foto).includes('otroNuevo') && !JSON.stringify(nueva.foto).includes('estado-nuevo'), 'lo desconocido no se guarda');
  assert.strictEqual(nueva.foto.agents[0].nombre, 'x');
  assert.deepStrictEqual([...nueva.desconocidos].sort(), ['agents.campoNuevo', 'agents.estado', 'otroNuevo'].sort());
  // «Esperan entrar» es sólo lo de cada persona: los pedidos de otros autores no están en la lista, y no viajan
  assert.ok(!Object.keys(F.FIELDS).includes('pedidosProyectos'));
  const conAjenos = limpiarFoto({ agents: [], pedidosProyectos: [{ proyecto: 'p', pedidos: [{ titulo: 'de otro autor' }] }] });
  assert.ok(!JSON.stringify(conAjenos.foto).includes('de otro autor'), 'los pedidos ajenos no se guardan ni se reparten');

  const h = await montar();
  try {
    const { ka, ma, mb } = await dosMaquinasConectadas(h);
    const nav = await navegador(h, LEAD);
    await hasta(() => oficinas(nav).size === 2, 3000, 'las oficinas');
    // de más: se acepta, no llega al navegador, se anota una vez, y queda la marca para quien mantiene
    ma.ws.send(JSON.stringify({ type: 'foto', data: { agents: [{ nombre: 'Con de más', estado: 'libre', campoNuevo: 'secreto-de-prueba' }] } }));
    await hasta(() => oficinas(nav).get('maquina-a').foto.agents[0].nombre === 'Con de más', 3000, 'la foto');
    assert.strictEqual(ma.cerro, null, 'la conexión sigue');
    assert.ok(!JSON.stringify(nav.msgs).includes('secreto-de-prueba'));
    assert.ok(oficinas(nav).get('maquina-a').marcas.includes('mas_nueva'), 'la marca «más nueva que el sitio»');
    ma.ws.send(JSON.stringify({ type: 'foto', data: { agents: [{ nombre: 'Otra vez', estado: 'libre', campoNuevo: 'x' }] } }));
    await hasta(() => oficinas(nav).get('maquina-a').foto.agents[0].nombre === 'Otra vez', 3000, 'la foto');
    assert.strictEqual(h.registro.filter((l) => l.includes('más nueva que el sitio')).length, 1, 'se anota una vez por máquina');
    assert.ok(!h.registro.join('\n').includes('secreto-de-prueba'), 'el registro no trae contenido');
    // el texto viaja como dato: lo que se muestra lo prueba la página
    ma.ws.send(JSON.stringify({ type: 'foto', data: { agents: [{ nombre: '<script>alert(1)</script>', estado: 'libre' }] } }));
    await hasta(() => oficinas(nav).get('maquina-a').foto.agents[0].nombre === '<script>alert(1)</script>', 3000, 'el texto');
    // una forma que no corresponde cierra, y se anota
    ma.ws.send(JSON.stringify({ type: 'foto', data: { agents: 'no' } }));
    await hasta(() => ma.cerro !== null, 2000, 'el cierre');
    assert.strictEqual(ma.cerro, F.CLOSE.policy);
    // un tipo raro cierra
    mb.ws.send(JSON.stringify({ type: 'orden', que: 'x' }));
    await hasta(() => mb.cerro !== null, 2000, 'el cierre');
    assert.strictEqual(mb.cerro, F.CLOSE.policy);
    assert.ok(ka);
    nav.ws.close();
  } finally { await h.cerrar(); }
});

test('T38 Topes_PorDireccionYCarrilSeparado_LaMaquinaConClavePasa — @story-8.171 @ac-14b', async () => {
  // el tope del total, chico en la prueba: el código es el mismo y el valor real lo fija T18
  const h = await montar({ env: { SITE_TRUST_PROXY: '1' }, opciones: { topes: { sinAutenticarTotal: 12 }, plazos: { saludoMs: 8000 } } });
  try {
    const k = par();
    pedir(h.llaves, k, '20.0.0.1');
    h.aprobar(k);
    // la pared: conexiones sin autenticar desde muchas direcciones
    const pared = [];
    for (let i = 0; i < 12; i += 1) { const c = conectar(h, '/live/machine', { headers: { 'x-forwarded-for': `30.0.0.${i}` } }); pared.push(c); await hasta(() => c.msgs.length > 0, 2000, 'el desafío'); }
    // y los pedidos de alta de una dirección, gastados
    const gasta = { 'content-type': 'application/json', 'x-forwarded-for': '20.0.0.9' };
    const alta = async () => { const x = par(); return (await h.pedir('/live/enroll', { method: 'POST', headers: gasta, body: JSON.stringify({ publicKey: x.publicKey, fingerprint: x.fingerprint, nombre: 'x' }) })).status; };
    for (let i = 0; i < 5; i += 1) assert.strictEqual(await alta(), 202);
    assert.strictEqual(await alta(), 429);
    // la máquina aprobada igual conecta y actualiza
    const m = await maquinaCruda(h, k, { headers: { 'x-forwarded-for': '20.0.0.9' } });
    assert.ok(m.msgs.some((x) => x.type === 'ack'), 'conecta');
    m.ws.send(JSON.stringify({ type: 'foto', data: FOTO('Pasó') }));
    await hasta(() => h.centro.oficina('maquina-a') && h.centro.oficina('maquina-a').foto, 2000, 'la oficina');
    assert.ok(h.registro.some((l) => l.includes('sin autenticar')), 'llegar al tope del total queda anotado');
    // 3 sin autenticar desde una dirección: la tercera se corta
    const una = [];
    for (let i = 0; i < 3; i += 1) { const c = conectar(h, '/live/machine', { headers: { 'x-forwarded-for': '40.0.0.1' } }); una.push(c); await hasta(() => c.msgs.length > 0 || c.cerro !== null, 2000, 'la respuesta'); }
    await hasta(() => una[2].cerro !== null, 2000, 'el corte');
    assert.strictEqual(una[0].cerro, null);
    assert.strictEqual(una[1].cerro, null);
    [...pared, ...una, m].forEach((c) => { try { c.ws.terminate(); } catch { /* ya cerrada */ } });
  } finally { await h.cerrar(); }
});

// ── Lo que hace la máquina contra el sitio ──────────────────────────────────────────────────

test('T30 Alta_TopesPorDireccion_YVenceASieteDias — @story-8.171 @ac-9b', async () => {
  const reloj = { t: Date.now() };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llaves-'));
  const notas = [];
  const ll = crearLlaves({ dataDir: dir, ahora: () => reloj.t, log: (l) => notas.push(l) });
  try {
    assert.deepStrictEqual({ h: TOPES_ALTA.porHora, p: TOPES_ALTA.pendientesPorDireccion, b: TOPES_ALTA.bytes, n: TOPES_ALTA.nombre }, { h: 5, p: 20, b: 2048, n: 64 });
    // 5 por hora
    for (let i = 0; i < 5; i += 1) assert.strictEqual(pedir(ll, par(), '10.0.0.1').status, 202);
    assert.strictEqual(pedir(ll, par(), '10.0.0.1').status, 429);
    assert.strictEqual(pedir(ll, par(), '10.0.0.2').status, 202, 'otra dirección no se ve afectada');
    // 20 pendientes por dirección, aunque pase la hora
    for (let i = 0; i < 3; i += 1) { reloj.t += 61 * MIN; for (let j = 0; j < 5; j += 1) assert.strictEqual(pedir(ll, par(), '10.0.0.1').status, 202); }
    reloj.t += 61 * MIN;
    assert.strictEqual(pedir(ll, par(), '10.0.0.1').status, 429, '20 pendientes');

    // un pedido repetido no cambia su estado, no gasta el tope y contesta 202
    const k = par();
    assert.strictEqual(pedir(ll, k, '10.0.0.3').status, 202);
    for (let i = 0; i < 8; i += 1) assert.strictEqual(pedir(ll, k, '10.0.0.3').status, 202);
    for (let i = 0; i < 4; i += 1) assert.strictEqual(pedir(ll, par(), '10.0.0.3').status, 202, 'el repetido no gastó');
    const aprobada = par();
    pedir(ll, aprobada, '10.0.0.4');
    const ctx = { huellas: huellasDe({ 'maquina-a': [aprobada.fingerprint] }), reglas: reglasDe(), conBuzon: true };
    assert.strictEqual(ll.aprobar(aprobada.fingerprint, LEAD, ctx).ok, true);
    assert.strictEqual(pedir(ll, aprobada, '10.0.0.4').status, 202);
    assert.strictEqual(ll.alConectar(aprobada.fingerprint).codigo, null, 'sigue aprobada');
    const rechazada = par();
    pedir(ll, rechazada, '10.0.0.5');
    ll.rechazar(rechazada.fingerprint, LEAD);
    assert.strictEqual(pedir(ll, rechazada, '10.0.0.5').status, 202);
    assert.strictEqual(ll.alConectar(rechazada.fingerprint).codigo, F.CLOSE.revoked, 'sigue rechazada');

    // forma mala
    const buena = par();
    assert.strictEqual(ll.pedir({ publicKey: buena.publicKey, fingerprint: 'a'.repeat(64), nombre: 'x', direccion: '10.0.0.6' }).status, 400, 'la huella no coincide');
    assert.strictEqual(ll.pedir({ publicKey: Buffer.alloc(16).toString('base64'), fingerprint: sha(Buffer.alloc(16)), nombre: 'x', direccion: '10.0.0.6' }).status, 400, 'otro largo');
    assert.strictEqual(ll.pedir({ publicKey: 42, fingerprint: 'x', nombre: 'x', direccion: '10.0.0.6' }).status, 400);
    assert.strictEqual(ll.pedir({ publicKey: 'no-es-base64!!', fingerprint: 'x', direccion: '10.0.0.6' }).status, 400);
    // el nombre: 64 caracteres y saneado
    const larga = par();
    ll.pedir({ publicKey: larga.publicKey, fingerprint: larga.fingerprint, nombre: `${'n'.repeat(200)}\n<b>`, direccion: '10.0.0.7' });
    const nombre = ll.vista({ huellas: huellasDe({}), reglas: reglasDe(), conBuzon: true }).pedidos.find((p) => p.fingerprint === larga.fingerprint).nombre;
    assert.strictEqual(nombre.length, 64);
    assert.ok(!/[\n<>]/.test(nombre));

    // vence a los 7 días sin renovar; el intento firmado lo renueva sin gastar el tope
    const v = par();
    pedir(ll, v, '10.0.0.8');
    reloj.t += 6 * DIA;
    assert.strictEqual(ll.alConectar(v.fingerprint).codigo, F.CLOSE.pending, 'renueva');
    reloj.t += 6 * DIA;
    ll.vencer();
    assert.strictEqual(ll.alConectar(v.fingerprint).codigo, F.CLOSE.pending, 'renovado no vence');
    reloj.t += 7 * DIA + 1000;
    ll.vencer();
    assert.strictEqual(ll.alConectar(v.fingerprint).codigo, F.CLOSE.unknown, 'sin renovar, vence');
    // lo vencido se conserva 90 días y se suelta: los pedidos de afuera no hacen crecer el archivo sin fin
    const sinNada = { huellas: { medido: true, carpetas: {} }, reglas: reglasDe(), conBuzon: true };
    reloj.t += 89 * DIA;
    ll.emparejar(sinNada);
    assert.ok(ll.clave(v.fingerprint), 'todavía se conserva');
    reloj.t += 2 * DIA;
    ll.emparejar({ huellas: huellasDe({ 'maquina-a': [v.fingerprint] }), reglas: reglasDe(), conBuzon: true });
    assert.ok(ll.clave(v.fingerprint), 'su huella sigue en el buzón: soltarla daría un conflicto falso');
    ll.emparejar({ ...sinNada, huellas: { medido: false, carpetas: {} } });
    assert.ok(ll.clave(v.fingerprint), 'sin saber qué dice el buzón, no se suelta');
    ll.emparejar(sinNada);
    assert.ok(!ll.clave(v.fingerprint), 'se soltó');
    assert.ok(!fs.readFileSync(path.join(dir, 'office', 'machine-keys.json'), 'utf8').includes(v.fingerprint), 'y no queda en el disco');
    // reconectar sin parar no gasta el disco: la renovación escribe a lo sumo una vez por hora
    const w = par();
    pedir(ll, w, '10.0.0.9');
    const archivo = path.join(dir, 'office', 'machine-keys.json');
    const antes = fs.readFileSync(archivo, 'utf8');
    reloj.t += 60 * 1000;
    assert.strictEqual(ll.alConectar(w.fingerprint).codigo, F.CLOSE.pending);
    assert.strictEqual(fs.readFileSync(archivo, 'utf8'), antes, 'dentro de la hora no escribe');
    reloj.t += 2 * 60 * 60 * 1000;
    assert.strictEqual(ll.alConectar(w.fingerprint).codigo, F.CLOSE.pending);
    assert.notStrictEqual(fs.readFileSync(archivo, 'utf8'), antes, 'pasada la hora, sí');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  // por la ruta real: cuerpo de más de 2 KB, con un encabezado inventado adelante, y el tope del total (chico en la prueba)
  const h = await montar({ env: { SITE_TRUST_PROXY: '1' }, topesAlta: { pendientesTotal: 8 } });
  try {
    const cab = (f) => ({ 'content-type': 'application/json', 'x-forwarded-for': f });
    assert.strictEqual((await h.pedir('/live/enroll', { method: 'POST', headers: cab('50.0.0.1'), body: JSON.stringify({ publicKey: 'x'.repeat(3000) }) })).status, 413);
    assert.strictEqual((await h.pedir('/live/enroll', { method: 'POST', headers: cab('50.0.0.1'), body: 'no es json' })).status, 400);
    const alta = async (f) => { const x = par(); return (await h.pedir('/live/enroll', { method: 'POST', headers: cab(f), body: JSON.stringify({ publicKey: x.publicKey, fingerprint: x.fingerprint, nombre: 'x' }) })).status; };
    for (let i = 0; i < 5; i += 1) assert.strictEqual(await alta(`inventada-${i}, 60.0.0.1`), 202);
    assert.strictEqual(await alta('inventada-9, 60.0.0.1'), 429, 'con un encabezado inventado adelante, el tope sigue contando');
    assert.strictEqual((await h.pedir('/live/enroll')).status, 405);

    // el tope del total: rechaza los nuevos y la aprobada conecta
    const k = par();
    pedir(h.llaves, k, '70.0.0.1');
    h.aprobar(k);
    for (let i = 0; i < 3; i += 1) assert.strictEqual(await alta(`81.0.0.${i}`), 202);
    assert.strictEqual(await alta('80.0.0.1'), 503);
    assert.ok(h.registro.some((l) => l.includes('pedidos de alta pendientes')), 'queda anotado');
    const m = await maquinaCruda(h, k);
    assert.ok(m.msgs.some((x) => x.type === 'ack'));
    m.ws.close();
  } finally { await h.cerrar(); }
});

test('T31 Maquina_LaDiceLaClave_YLaNuevaDesplaza — @story-8.171 @ac-10b', async () => {
  const h = await montar();
  try {
    const { ka, ma, mb } = await dosMaquinasConectadas(h);
    // la foto va a la oficina de la clave, diga lo que diga
    ma.ws.send(JSON.stringify({ type: 'foto', data: { agents: [{ nombre: 'Dice ser otra' }], maquina: 'maquina-b', id: 'maquina-b' } }));
    await hasta(() => h.centro.oficina('maquina-a') && h.centro.oficina('maquina-a').foto.agents[0].nombre === 'Dice ser otra', 2000, 'la foto');
    await hasta(() => h.centro.oficina('maquina-b'), 2000, 'la foto de la otra');
    assert.notStrictEqual((h.centro.oficina('maquina-b').foto.agents[0] || {}).nombre, 'Dice ser otra');
    // la segunda conexión cierra la primera, y queda anotado
    const nueva = await maquinaCruda(h, ka);
    assert.ok(nueva.msgs.some((x) => x.type === 'ack'));
    await hasta(() => ma.cerro !== null, 2000, 'el desplazamiento');
    assert.strictEqual(ma.cerro, F.CLOSE.displaced);
    assert.ok(h.registro.some((l) => l.includes('desplaz')), 'el registro lo anota');
    // 11 en una hora: «posible clave copiada», para quien mantiene
    let ultima = nueva;
    for (let i = 0; i < 10; i += 1) { ultima = await maquinaCruda(h, ka); }
    assert.ok(ultima.msgs.some((x) => x.type === 'ack'));
    const vista = h.llaves.vista({ huellas: h.fuentes.st.huellas, reglas: reglasDe(), conBuzon: true });
    assert.strictEqual(vista.maquinas.find((x) => x.maquina === 'maquina-a').copiada, true);
    const lead = await navegador(h, LEAD);
    await hasta(() => oficinas(lead).has('maquina-a'), 2000, 'la oficina');
    assert.ok(oficinas(lead).get('maquina-a').marcas.includes('clave_copiada'));
    const dev = await navegador(h, A);
    await hasta(() => oficinas(dev).has('maquina-a'), 2000, 'la oficina');
    assert.deepStrictEqual(oficinas(dev).get('maquina-a').marcas, [], 'la marca es sólo para quien mantiene');
    // sólo quien mantiene la borra, y queda quién y cuándo
    assert.strictEqual(h.llaves.borrarMarca('maquina-a', LEAD).ok, true);
    assert.ok(fs.readFileSync(path.join(h.dir, 'office', 'machine-keys.json'), 'utf8').includes('marca_borrada'));
    assert.strictEqual(h.llaves.vista({ huellas: h.fuentes.st.huellas, reglas: reglasDe(), conBuzon: true }).maquinas.find((x) => x.maquina === 'maquina-a').copiada, false);
    [ultima, mb, lead, dev].forEach((c) => c.ws.close());
  } finally { await h.cerrar(); }
});

test('T32 Revision_CadaSesentaSegundos — @story-8.171 @ac-11b', async () => {
  const reloj = { t: Date.now() };
  const h = await montar({ reloj });
  try {
    assert.strictEqual(PLAZOS.revisionMs, 60000);
    const { ma, mb } = await dosMaquinasConectadas(h);
    // persona fuera de la lista
    const fuera = await navegador(h, B);
    await hasta(() => oficinas(fuera).has('maquina-b'), 2000, 'su oficina');
    const lista = ops();
    lista.site.access = lista.site.access.filter((e) => !e.emails.includes(B));
    h.fuentes.st.config = lista;
    h.centro.revisar();
    await hasta(() => fuera.cerro !== null, 2000, 'el cierre');
    h.fuentes.st.config = ops();

    // máquina perdida: el dev deja de recibirla
    const dev = await navegador(h, A);
    await hasta(() => oficinas(dev).has('maquina-a'), 2000, 'su oficina');
    const sinA = ops({ machines: { 'maquina-b': confirmada(B) } });
    h.fuentes.st.config = sinA;
    h.fuentes.st.personas = { informados: H.informados({ 'maquina-b': B }), repos: null };
    h.centro.revisar();
    await hasta(() => !oficinas(dev).has('maquina-a'), 2000, 'que deje de verla');
    // y la máquina desconfirmada se corta con 4403
    await hasta(() => ma.cerro !== null, 2000, 'el corte de la máquina');
    assert.strictEqual(ma.cerro, F.CLOSE.revoked);
    assert.strictEqual(mb.cerro, null);

    // con quién es quién sin medir, «no sé» no corta a una máquina
    h.fuentes.st.personas = { informados: null, repos: null };
    h.centro.revisar();
    await pausa(80);
    assert.strictEqual(mb.cerro, null, 'sin lo informado no se la da por desconfirmada');

    // sesión vencida
    h.fuentes.st.config = ops();
    h.fuentes.st.personas = personasDe();
    const vencida = await navegador(h, A);
    await hasta(() => vencida.msgs.length > 0, 2000, 'la lista');
    reloj.t += 30 * DIA;
    h.centro.revisar();
    await hasta(() => vencida.cerro !== null, 2000, 'el cierre');
    assert.strictEqual(vencida.cerro, F.CLOSE.pending);
    dev.ws.close(); mb.ws.close();
  } finally { await h.cerrar(); }
});

test('T19 Reinicio_LasMaquinasVuelven — @story-8.171 @ac-15', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disco-'));
  const h = await montar({ dataDir: dir });
  try {
    const m = maquinaReal(h);
    pedir(h.llaves, m.key);
    h.aprobar(m.key);
    m.link.start();
    m.link.update(FOTO('Antes del reinicio'));
    await hasta(() => h.centro.oficina('maquina-a') && h.centro.oficina('maquina-a').foto, 3000, 'la primera foto');
    assert.strictEqual(SL.readLinkState(m.dir), 'aprobada');
    const clave = m.key.fingerprint;
    // sobre el mismo disco: reconecta con su clave y la oficina vuelve con la foto entera
    await h.reiniciar();
    assert.strictEqual(h.centro.oficina('maquina-a'), null, 'la foto vive en memoria');
    m.link.wake();
    await hasta(() => h.centro.oficina('maquina-a') && h.centro.oficina('maquina-a').foto, 8000, 'la foto después del reinicio');
    assert.strictEqual(h.centro.oficina('maquina-a').foto.agents[0].nombre, 'Antes del reinicio');
    assert.strictEqual(SL.readKey(m.dir).fingerprint, clave, 'con su clave');
    m.parar();
  } finally { await h.cerrar(); fs.rmSync(dir, { recursive: true, force: true }); }

  // sin disco: el sitio olvidó la clave; la máquina recibe 4404
  const h2 = await montar();
  try {
    const m = maquinaReal(h2);
    pedir(h2.llaves, m.key);
    h2.aprobar(m.key);
    m.link.start();
    m.link.update(FOTO());
    await hasta(() => SL.readLinkState(m.dir) === 'aprobada', 3000, 'la aprobación');
    await h2.reiniciar({ sinDisco: true });
    m.link.wake();
    await hasta(() => SL.readLinkState(m.dir) === 'desconocida', 8000, 'el 4404');
    m.parar();
  } finally { await h2.cerrar(); }
});

// ── Las recetas ─────────────────────────────────────────────────────────────────────────────

test('T33 Replicas_UnaEnCadaReceta — @story-8.171 @ac-15b', () => {
  const azure = fs.readFileSync(path.join(H.SITE, 'deploy', 'azure-container-apps.js'), 'utf8');
  const lugares = azure.match(/scale:\s*\{[^}]*\}/g) || [];
  assert.strictEqual(lugares.length, 2, 'la receta de Azure escribe la escala en dos lugares');
  for (const l of lugares) assert.match(l, /maxReplicas:\s*1\b/);
  const render = fs.readFileSync(path.join(H.SITE, 'deploy', 'render.yaml'), 'utf8');
  assert.match(render, /^\s*numInstances:\s*1\s*$/m, 'Render, una instancia, fijada');
});

test('T35 RutasSinSesion_ListaFijada_RecetaConTrustProxy — @story-8.171 @ac-15c', () => {
  assert.deepStrictEqual([...RUTAS_SIN_SESION].sort(), ['/healthz', '/livez', '/saliste', '/idioma', '/static/site.css', '/static/site.js', '/static/fonts/lato-400.woff2', '/static/fonts/lato-700.woff2', '/live/machine', '/live/enroll'].sort());
  assert.ok(VARIABLES.includes('SITE_TRUST_PROXY'));
  const azure = fs.readFileSync(path.join(H.SITE, 'deploy', 'azure-container-apps.js'), 'utf8');
  assert.match(azure, /'--excluded-paths', RUTAS_SIN_SESION\.join\(','\)/, 'la receta excluye la lista entera');
  assert.match(azure, /\['SITE_TRUST_PROXY', '1'\]/, 'la receta pone la variable');
  const guia = fs.readFileSync(path.join(ROOT, 'guides', 'organization-site.md'), 'utf8');
  assert.match(guia, /\/live\/machine/, 'la guía trae el paso de una vez');
  assert.match(guia, /--excluded-paths/);
  assert.match(fs.readFileSync(path.join(ROOT, 'guides', 'organization-site.en.md'), 'utf8'), /--excluded-paths/);
});

test('T39 CheckDeploy_RutasDeLaMaquina_LleganAlSitio — @story-8.171 @ac-15d', async () => {
  const { rutasDeLaMaquina, FALTA_PASO, ENCABEZADO_DEL_SITIO } = require(path.join(H.SITE, 'check-deploy.js'));
  // el sitio real, con las rutas pasando
  const h = await montar();
  // un intermediario que imita al candado de la plataforma
  const candado = http.createServer((req, res) => { res.writeHead(302, { location: '/.auth/login/aad?post_login_redirect_uri=/' }); res.end(); });
  await new Promise((r) => candado.listen(0, '127.0.0.1', r));
  try {
    const bien = await rutasDeLaMaquina(new URL(h.base));
    assert.strictEqual(bien.aviso, null, `llegan al sitio: ${bien.capa}`);
    assert.strictEqual(bien.medido, true);
    const conEncabezado = await h.pedir('/live/machine');
    assert.strictEqual(conEncabezado.status, 426);
    assert.ok(conEncabezado.headers[ENCABEZADO_DEL_SITIO], 'la respuesta trae el encabezado propio del sitio');
    const mal = await rutasDeLaMaquina(new URL(`http://127.0.0.1:${candado.address().port}`));
    assert.strictEqual(mal.aviso, FALTA_PASO, 'sin excluir, «falta el paso de una vez»');
    assert.match(FALTA_PASO, /^falta el paso de una vez/);
    // un sitio de antes de las oficinas, sin esas rutas, no avisa nada
    const viejo = http.createServer((req, res) => { res.writeHead(404); res.end(); });
    await new Promise((r) => viejo.listen(0, '127.0.0.1', r));
    const deAntes = await rutasDeLaMaquina(new URL(`http://127.0.0.1:${viejo.address().port}`));
    assert.strictEqual(deAntes.aviso, null);
    assert.strictEqual(deAntes.medido, false);
    await new Promise((r) => viejo.close(r));
  } finally { await new Promise((r) => candado.close(r)); await h.cerrar(); }
});

test('T42 Imagen_TraeLoQueCargaElCentro — @story-8.171 @ac-15e', () => {
  const docker = fs.readFileSync(path.join(H.SITE, 'Dockerfile'), 'utf8');
  assert.match(docker, /^COPY scripts\/tools\/office\/ scripts\/tools\/office\/$/m);
  const ignore = fs.readFileSync(path.join(H.SITE, 'Dockerfile.dockerignore'), 'utf8');
  assert.match(ignore, /^!scripts\/tools\/office\/$/m);
  // lo que carga el centro está en lo que copia la imagen
  const hub = fs.readFileSync(path.join(H.SITE, 'live-hub.js'), 'utf8');
  const cargados = [...hub.matchAll(/require\('(\.[^']+)'\)/g)].map((m) => path.relative(ROOT, path.resolve(H.SITE, m[1])));
  assert.ok(cargados.some((c) => c.startsWith('scripts/tools/office/vendor/ws')), 'carga ws');
  assert.ok(cargados.some((c) => c === 'scripts/tools/office/fields.js'), 'carga la lista');
  for (const c of cargados) assert.ok(c.startsWith('scripts/site') || c.startsWith('scripts/tools/office') || c.startsWith('scripts/lib'), `${c} entra en la imagen`);
  // con el modo demo el sitio arranca sin el centro
  const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(H.SITE, 'live-hub.js'))})`], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
});

// ── Lo que confirmó el pase adversarial ─────────────────────────────────────────────────────

const reglasFijas = (mapa, medido = true) => ({ quienEsQuienMedido: medido, maquina: (c) => mapa[c] || { carpeta: c, estado: 'sin_confirmar', person: null } });
const llavesEn = (reloj, log = () => {}, dir) => {
  const d = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'llaves-'));
  return { d, ll: crearLlaves({ dataDir: d, ahora: () => reloj.t, log }) };
};

test('Regresion_MaquinaDesconfirmada_NoEntraAlReconectar — @story-8.171 @ac-9', async () => {
  const reloj = { t: Date.now() };
  const h = await montar({ reloj });
  try {
    const k = par();
    pedir(h.llaves, k);
    h.aprobar(k);
    const antes = h.llaves.clave(k.fingerprint).ultimaConexion;
    reloj.t += MIN;
    h.fuentes.st.config = ops({ machines: { 'maquina-b': confirmada(B) } });
    const c = await maquinaCruda(h, k);
    assert.strictEqual(c.msgs.some((m) => m.type === 'ack'), false, 'no recibe ack');
    await hasta(() => c.cerro !== null, 2000, 'el cierre');
    assert.strictEqual(c.cerro, F.CLOSE.revoked);
    assert.strictEqual(h.llaves.clave(k.fingerprint).ultimaConexion, antes, 'no le renueva el plazo');
    // «no sé» no es «desconfirmada»: sin leer quién es quién, la máquina entra
    h.fuentes.st.personas = { informados: { no_medido: true }, repos: null };
    const sinLeer = await maquinaCruda(h, k);
    assert.strictEqual(sinLeer.msgs.some((m) => m.type === 'ack'), true, `cerró ${sinLeer.cerro}: ${h.registro.slice(-3).join(' | ')}`);
    sinLeer.ws.close();
  } finally { await h.cerrar(); }
});

test('Regresion_FotoEnVuelo_NoResucitaLaOficina — @story-8.171 @ac-9', async () => {
  const h = await montar();
  try {
    const { ma } = await dosMaquinasConectadas(h);
    await hasta(() => h.centro.oficina('maquina-a'), 2000, 'su oficina');
    h.llaves.darDeBaja('maquina-a', LEAD);
    ma.ws.send(JSON.stringify({ type: 'foto', data: FOTO('En vuelo') }));
    await hasta(() => ma.cerro !== null, 2000, 'el cierre');
    await pausa(80);
    assert.strictEqual(h.centro.oficina('maquina-a'), null);
  } finally { await h.cerrar(); }
});

test('Regresion_CuadroInvalidoEnUnCierreTemprano_NoTumbaElSitio — @story-8.171 @ac-10', async () => {
  const h = await montar();
  try {
    for (const ruta of ['/live/offices', '/live/machine']) {
      if (ruta === '/live/machine') h.fuentes.st.frenado = { desde: 1, fallaDesde: 1 };
      const puerto = Number(new URL(h.base).port);
      await new Promise((resolve) => {
        const s = net.connect(puerto, '127.0.0.1', () => s.write(`GET ${ruta} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
        s.on('data', () => s.write(Buffer.from([0xff, 0x80, 0, 0, 0, 0])));
        s.on('close', resolve);
        s.on('error', resolve);
        setTimeout(() => s.destroy(), 300).unref();
      });
    }
    h.fuentes.st.frenado = null;
    assert.strictEqual((await h.pedir('/livez')).status, 200, 'el sitio sigue en pie');
  } finally { await h.cerrar(); }
});

test('Regresion_Conflicto_MiraTodasLasCarpetasDeLaMaquina — @story-8.171 @ac-9', () => {
  const reloj = { t: Date.now() };
  const { d, ll } = llavesEn(reloj);
  try {
    const real = par(); const intruso = par();
    pedir(ll, intruso);
    const conf = { carpeta: 'maquina-a', estado: 'confirmada', person: A };
    const reglas = reglasFijas({ 'maquina-a': conf, 'maquina-a-vieja': conf });
    for (const carpetas of [{ 'maquina-a-vieja': [intruso.fingerprint], 'maquina-a': [real.fingerprint] }, { 'maquina-a': [real.fingerprint], 'maquina-a-vieja': [intruso.fingerprint] }]) {
      const ctx = { huellas: huellasDe(carpetas), reglas, conBuzon: true };
      assert.strictEqual(ll.vista(ctx).pedidos[0].situacion, 'conflicto', 'en cualquier orden de carpetas');
      assert.strictEqual(ll.aprobar(intruso.fingerprint, LEAD, ctx).motivo, 'conflicto');
    }
    // la carpeta vieja llena también frena, aunque la huella esté en la nueva
    const huellas = { medido: true, carpetas: { 'maquina-a': { huellas: [intruso.fingerprint], llena: false }, 'maquina-a-vieja': { huellas: [], llena: true } } };
    assert.strictEqual(ll.vista({ huellas, reglas, conBuzon: true }).pedidos[0].situacion, 'carpeta_llena');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('Regresion_SinLeerQuienEsQuienOElBuzon_NoSeAprueba — @story-8.171 @ac-9', () => {
  const reloj = { t: Date.now() };
  const { d, ll } = llavesEn(reloj);
  try {
    const k = par();
    pedir(ll, k);
    const conf = { 'maquina-a': { carpeta: 'maquina-a', estado: 'confirmada', person: A } };
    for (const ctx of [
      { huellas: huellasDe({ 'maquina-a': [k.fingerprint] }), reglas: reglasFijas(conf, false), conBuzon: true },
      { huellas: null, reglas: reglasFijas(conf), conBuzon: true },
      { huellas: { medido: false, carpetas: {} }, reglas: reglasFijas(conf), conBuzon: true },
    ]) {
      assert.strictEqual(ll.vista(ctx).pedidos[0].situacion, 'sin_leer');
      assert.strictEqual(ll.aprobar(k.fingerprint, LEAD, ctx).motivo, 'sin_leer');
    }
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('Regresion_BajaLarga_ReactivarVuelveConSuClave — @story-8.171 @ac-9', () => {
  const reloj = { t: Date.now() };
  const { d, ll } = llavesEn(reloj);
  try {
    const k = par();
    pedir(ll, k);
    assert.strictEqual(ll.aprobar(k.fingerprint, LEAD, { huellas: huellasDe({ 'maquina-a': [k.fingerprint] }), reglas: reglasDe(), conBuzon: true }).ok, true);
    ll.darDeBaja('maquina-a', LEAD);
    reloj.t += 40 * DIA;
    ll.vencer();
    assert.strictEqual(ll.alConectar(k.fingerprint).codigo, F.CLOSE.revoked, 'sigue de baja, no vencida');
    ll.reactivar('maquina-a', LEAD);
    ll.vencer();
    assert.strictEqual(ll.alConectar(k.fingerprint).codigo, null, 'vuelve con su clave');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('Regresion_MarcaCopiada_SaleConLaBaja — @story-8.171 @ac-10b', () => {
  const reloj = { t: Date.now() };
  const { d, ll } = llavesEn(reloj);
  try {
    for (let i = 0; i < 11; i += 1) ll.anotarDesplazamiento('maquina-a');
    assert.strictEqual(ll.copiada('maquina-a'), true);
    ll.darDeBaja('maquina-a', LEAD);
    ll.reactivar('maquina-a', LEAD);
    assert.strictEqual(ll.copiada('maquina-a'), false);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('Regresion_NombresQueHeredaUnObjeto_NoSonUnaBaja — @story-8.171 @ac-9', () => {
  const reloj = { t: Date.now() };
  const { d, ll } = llavesEn(reloj);
  try {
    assert.strictEqual(ll.deBaja('constructor'), false);
    assert.strictEqual(ll.copiada('constructor'), false);
    assert.strictEqual(ll.darDeBaja('__proto__', LEAD).ok, true);
    assert.strictEqual(ll.deBaja('__proto__'), true);
    assert.strictEqual(ll.deBaja('otra'), false, 'no cambió lo que heredan las demás');
    const relei = crearLlaves({ dataDir: d, ahora: () => reloj.t });
    assert.strictEqual(relei.deBaja('__proto__'), true, 'y vuelve del disco');
    assert.strictEqual(relei.deBaja('otra'), false);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('Regresion_ListaConNull_EsFormaMala — @story-8.171 @ac-10c', () => {
  assert.strictEqual(limpiarFoto({ agents: [null] }).ok, false);
  assert.strictEqual(limpiarFoto({ free: [null] }).ok, false);
  const opcional = limpiarFoto({ agents: [{ nombre: 'Uno', titulo: null }] });
  assert.strictEqual(opcional.ok, true, 'un campo opcional en null sigue valiendo');
  assert.strictEqual(opcional.foto.agents[0].titulo, null);
});

test('Regresion_HoraDeLaFoto_NoDependeDeLaZonaDelSitio — @story-8.171 @ac-10c', () => {
  // las 02:30 de ese día no existen en esa zona: la hora es la de la máquina, no la del sitio
  const programa = `const F = require(${JSON.stringify(path.join(ROOT, 'scripts', 'tools', 'office', 'fields.js'))}); process.stdout.write(String(F.validHour('2026-03-08T02:30')) + String(F.validHour('2026-02-30T10:00')));`;
  const r = spawnSync(process.execPath, ['-e', programa], { encoding: 'utf8', env: { ...process.env, TZ: 'America/New_York' } });
  assert.strictEqual(r.stdout, 'truefalse', r.stderr);
});

test('Regresion_ConexionCalladaSinFoto_SeCorta — @story-8.171 @ac-13', async () => {
  const reloj = { t: Date.now() };
  const h = await montar({ reloj });
  try {
    const k = par();
    pedir(h.llaves, k);
    h.aprobar(k);
    const c = await maquinaCruda(h, k);
    assert.strictEqual(h.centro.conectada('maquina-a'), true);
    const anotada = h.llaves.clave(k.fingerprint).ultimaConexion;
    reloj.t += PLAZOS.sinLatidoMs + 1000;
    h.centro.revisar();
    await hasta(() => c.cerro !== null, 2000, 'el corte');
    assert.strictEqual(h.centro.conectada('maquina-a'), false);
    assert.strictEqual(h.llaves.clave(k.fingerprint).ultimaConexion, anotada, 'callada no renueva su clave');
    assert.strictEqual(h.llaves.vista({ huellas: null, reglas: reglasDe(), conBuzon: true }).maquinas[0].conectada, false);
  } finally { await h.cerrar(); }
});

test('Regresion_SitioFrenado_LaSesionVenceYLaOficinaSeApaga — @story-8.171 @ac-11b @ac-13', async () => {
  const reloj = { t: Date.now() };
  const h = await montar({ reloj });
  try {
    const { ma } = await dosMaquinasConectadas(h);
    const nav = await navegador(h, LEAD);
    await hasta(() => oficinas(nav).has('maquina-a'), 2000, 'su oficina');
    h.fuentes.st.frenado = { desde: 1, fallaDesde: 1 };
    reloj.t += PLAZOS.sinLatidoMs + 1000;
    h.centro.revisar();
    await hasta(() => ma.cerro !== null, 2000, 'el corte de la máquina callada');
    assert.notStrictEqual(h.centro.oficina('maquina-a').sinConexionDesde, null);
    reloj.t += 9 * 60 * MIN;
    h.centro.revisar();
    await hasta(() => nav.cerro !== null, 2000, 'el cierre de la sesión vencida');
    assert.strictEqual(nav.cerro, F.CLOSE.pending);
  } finally { await h.cerrar(); }
});

test('Regresion_CambiaElDuenoDeLaMaquina_LoVeQuienMantiene — @story-8.171 @ac-11', async () => {
  const h = await montar();
  try {
    await dosMaquinasConectadas(h);
    const nav = await navegador(h, LEAD);
    await hasta(() => oficinas(nav).has('maquina-a'), 2000, 'su oficina');
    assert.strictEqual(oficinas(nav).get('maquina-a').person, A);
    h.fuentes.st.config = ops({ machines: { 'maquina-a': confirmada(B), 'maquina-b': confirmada(B) } });
    h.fuentes.st.personas = { informados: H.informados({ 'maquina-a': B, 'maquina-b': B }), repos: null };
    h.centro.revisar();
    await hasta(() => oficinas(nav).get('maquina-a').person === B, 2000, 'el dueño nuevo sin esperar otra foto');
  } finally { await h.cerrar(); }
});

test('Regresion_NombreQueNoEsTexto_SaleConCuatrocientos — @story-8.171 @ac-9b', () => {
  const reloj = { t: Date.now() };
  const { d, ll } = llavesEn(reloj);
  try {
    for (const nombre of [{ toString: null }, 123, ['x']]) {
      const k = par();
      assert.strictEqual(ll.pedir({ publicKey: k.publicKey, fingerprint: k.fingerprint, nombre, direccion: '10.0.0.1' }).status, 400);
    }
    const sin = par();
    assert.strictEqual(ll.pedir({ publicKey: sin.publicKey, fingerprint: sin.fingerprint, direccion: '10.0.0.1' }).status, 202, 'sin nombre vale');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('Regresion_ArchivoDeClavesRoto_SeApartaYElRegistroNoLlevaCorreos — @story-8.171 @ac-15', () => {
  const reloj = { t: Date.now() };
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'llaves-'));
  const registro = [];
  try {
    const archivo = path.join(d, 'office', 'machine-keys.json');
    fs.mkdirSync(path.dirname(archivo), { recursive: true });
    fs.writeFileSync(archivo, '{ roto');
    const { ll } = llavesEn(reloj, (l) => registro.push(l), d);
    const k = par();
    pedir(ll, k);
    assert.strictEqual(fs.readFileSync(`${archivo}.corrupto`, 'utf8'), '{ roto', 'la copia rota queda para mirarla');
    assert.ok(JSON.parse(fs.readFileSync(archivo, 'utf8')).claves[k.fingerprint]);
    assert.strictEqual(ll.aprobar(k.fingerprint, LEAD, { huellas: huellasDe({ 'maquina-a': [k.fingerprint] }), reglas: reglasDe(), conBuzon: true }).ok, true);
    ll.darDeBaja('maquina-a', LEAD);
    ll.reactivar('maquina-a', LEAD);
    assert.ok(registro.some((l) => /aprobó/.test(l)), 'el evento se anota');
    assert.ok(!registro.some((l) => l.includes(LEAD)), `sin el correo: ${registro.join(' | ')}`);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('Regresion_NoSePudoGuardar_SeDiceEnLaVista — @story-8.171 @ac-15', () => {
  const reloj = { t: Date.now() };
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'llaves-'));
  try {
    const noEsCarpeta = path.join(d, 'archivo');
    fs.writeFileSync(noEsCarpeta, 'x');
    const ll = crearLlaves({ dataDir: noEsCarpeta, ahora: () => reloj.t });
    pedir(ll, par());
    assert.strictEqual(ll.vista({ huellas: null, reglas: reglasDe(), conBuzon: true }).noGuarda, true);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('Regresion_CarpetaLlena_CuentaLosArchivosYAvisaUnaVez — @story-8.171 @ac-9', () => {
  const espejo = fs.mkdtempSync(path.join(os.tmpdir(), 'espejo-'));
  try {
    const dir = path.join(espejo, 'maquina-a', 'office-keys');
    fs.mkdirSync(dir, { recursive: true });
    const k = par();
    fs.writeFileSync(path.join(dir, `${k.fingerprint}.json`), JSON.stringify({ fingerprint: k.fingerprint, publicKey: k.publicKey }));
    for (let i = 0; i < 25; i += 1) fs.writeFileSync(path.join(dir, `basura-${i}.json`), '{}');
    const registro = [];
    const r = leerHuellas(espejo, (l) => registro.push(l));
    assert.deepStrictEqual(r.carpetas['maquina-a'].huellas, [k.fingerprint]);
    assert.strictEqual(r.carpetas['maquina-a'].llena, true);
    assert.strictEqual(registro.length, 1, registro.join(' | '));
    assert.match(registro[0], /25/);
    // no poder leer una carpeta no es que no tenga huellas: el resultado dice «no medido»
    const noEsCarpeta = path.join(espejo, 'maquina-b');
    fs.mkdirSync(noEsCarpeta);
    fs.writeFileSync(path.join(noEsCarpeta, 'office-keys'), 'x');
    const notas = [];
    assert.strictEqual(leerHuellas(espejo, (l) => notas.push(l)).medido, false);
    assert.match(notas.join(' | '), /las huellas de maquina-b no se pudieron leer/);
  } finally { fs.rmSync(espejo, { recursive: true, force: true }); }
});

test('Regresion_PingsSeguidos_SeCortanSinContestar — @story-8.171 @ac-14', async () => {
  // contestarlos solo apilaría las respuestas en la memoria del sitio: dos conexiones sin firmar lo dejaban sin contestar
  const h = await montar();
  try {
    const sinFirma = conectar(h, '/live/machine');
    await hasta(() => sinFirma.abierta, 2000, 'la conexión');
    let pongs = 0;
    sinFirma.ws.on('pong', () => { pongs += 1; });
    for (let i = 0; i < 50; i += 1) sinFirma.ws.ping();
    await hasta(() => sinFirma.cerro !== null, 2000, 'el corte');
    assert.strictEqual(pongs, 0, 'no contesta');
    const nav = await navegador(h, LEAD);
    for (let i = 0; i < 50; i += 1) nav.ws.ping();
    await hasta(() => nav.cerro !== null, 2000, 'el corte del navegador');
    // un ping suelto, de un intermediario, no corta
    const k = par();
    pedir(h.llaves, k);
    h.aprobar(k);
    const m = await maquinaCruda(h, k);
    m.ws.ping();
    await pausa(100);
    assert.strictEqual(m.cerro, null);
    assert.strictEqual(h.centro.conectada('maquina-a'), true);
  } finally { await h.cerrar(); }
});

test('Regresion_NavegadorSinSesion_TopePorDireccionYPlazoDeCierre — @story-8.171 @ac-14', async () => {
  // quien no contesta el cierre dejaba la conexión abierta hasta 30 s, sin tope: se juntaban sin haber iniciado sesión
  const h = await montar({ opciones: { plazos: { cierreMs: 400 } } });
  try {
    const puerto = Number(new URL(h.base).port);
    const abrir = () => new Promise((resolve) => {
      const c = { cerrada: false };
      const s = net.connect(puerto, '127.0.0.1', () => s.write(`GET /live/offices HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
      c.s = s;
      s.once('data', () => resolve(c));
      s.on('close', () => { c.cerrada = true; resolve(c); });
      s.on('error', () => {});
    });
    const conexiones = [];
    for (let i = 0; i < 6; i += 1) conexiones.push(await abrir());
    await pausa(100);
    assert.strictEqual(conexiones.filter((c) => !c.cerrada).length, 2, 'dos cierres esperando por dirección, los demás se cortan');
    // nadie contesta el cierre: el plazo corto las termina, sin esperar los 30 s
    await hasta(() => conexiones.every((c) => c.cerrada), 3000, 'el plazo del cierre');
    // pasado el plazo la dirección vuelve a tener lugar, y quien contesta recibe su cierre
    const nav = conectar(h, '/live/offices', { origin: h.base });
    await hasta(() => nav.cerro === F.CLOSE.pending, 3000, 'el cierre de quien sí contesta');
    assert.strictEqual((await h.pedir('/livez')).status, 200);
  } finally { await h.cerrar(); }
});

test('Regresion_LluviaDeCuadros_SeCortaUnaSolaVez — @story-8.171 @ac-14', async () => {
  // los cuadros que ya llegaron se siguen procesando después del corte: sin soltar el oyente, cada uno repetía el aviso
  const h = await montar();
  try {
    for (const tipo of [0x89, 0x8a]) {
      const puerto = Number(new URL(h.base).port);
      const antes = h.registro.length;
      await new Promise((resolve) => {
        const s = net.connect(puerto, '127.0.0.1', () => s.write(`GET /live/machine HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
        s.once('data', () => {
          const cuadro = Buffer.from([tipo, 0x80, 0, 0, 0, 0]);
          s.write(Buffer.concat(Array(5000).fill(cuadro)));
        });
        s.on('close', resolve);
        s.on('error', resolve);
        setTimeout(() => s.destroy(), 500).unref();
      });
      const avisos = h.registro.slice(antes).filter((l) => /cuadros de control/.test(l));
      assert.strictEqual(avisos.length, 1, `avisó ${avisos.length} veces`);
    }
    assert.strictEqual((await h.pedir('/livez')).status, 200);
  } finally { await h.cerrar(); }
});

test('Regresion_ClaveRetirada_NoVuelveAPedirElAlta — @story-8.171 @ac-9', () => {
  const reloj = { t: Date.now() };
  const { d, ll } = llavesEn(reloj);
  try {
    const k = par();
    pedir(ll, k);
    const ctx = { huellas: huellasDe({ 'maquina-a': [k.fingerprint] }), reglas: reglasDe(), conBuzon: true };
    assert.strictEqual(ll.aprobar(k.fingerprint, LEAD, ctx).ok, true);
    assert.strictEqual(ll.retirar('maquina-a', LEAD).ok, true);
    assert.strictEqual(pedir(ll, k, '10.0.0.9').status, 202, 'contesta igual: el pedido no cuenta qué pasó con la clave');
    assert.strictEqual(ll.clave(k.fingerprint).estado, 'vencida');
    assert.deepStrictEqual(ll.vista(ctx).pedidos, [], 'no aparece como un pedido que se pueda aprobar');
    // ni pasados los 90 días, aunque su huella ya no esté en el buzón
    reloj.t += 100 * DIA;
    ll.emparejar({ huellas: { medido: true, carpetas: {} }, reglas: reglasDe(), conBuzon: true });
    pedir(ll, k, '10.0.0.9');
    assert.strictEqual(ll.clave(k.fingerprint).estado, 'vencida', 'una retirada no se suelta');
    // una clave aprobada que se retiró al aprobar otra, igual
    const a = par(); const b = par();
    pedir(ll, a, '10.0.0.2'); pedir(ll, b, '10.0.0.3');
    const dos = { huellas: huellasDe({ 'maquina-b': [a.fingerprint] }), reglas: reglasDe(), conBuzon: true };
    assert.strictEqual(ll.aprobar(a.fingerprint, LEAD, dos).ok, true);
    assert.strictEqual(ll.aprobar(b.fingerprint, LEAD, { ...dos, huellas: huellasDe({ 'maquina-b': [b.fingerprint] }) }).ok, true);
    pedir(ll, a, '10.0.0.2');
    assert.strictEqual(ll.clave(a.fingerprint).estado, 'vencida');
    // una vencida por no conectarse sí puede volver: nadie la retiró
    const v = par();
    pedir(ll, v, '10.0.0.4');
    reloj.t += 8 * DIA;
    ll.vencer();
    assert.strictEqual(ll.clave(v.fingerprint).estado, 'vencida');
    pedir(ll, v, '10.0.0.4');
    assert.strictEqual(ll.clave(v.fingerprint).estado, 'pendiente');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('Regresion_MudanzaDeCarpeta_ReactivarYRetirarLaSiguen — @story-8.171 @ac-9', () => {
  const reloj = { t: Date.now() };
  const { d, ll } = llavesEn(reloj);
  try {
    const conf = { carpeta: 'nueva', estado: 'confirmada', person: A };
    const reglas = reglasFijas({ vieja: conf, nueva: conf });
    // la baja con el nombre viejo rechaza sola una clave nueva; reactivar con ese nombre la devuelve a la espera
    ll.darDeBaja('vieja', LEAD);
    const k = par();
    pedir(ll, k);
    const ctx = { huellas: huellasDe({ nueva: [k.fingerprint] }), reglas, conBuzon: true };
    ll.emparejar(ctx);
    assert.strictEqual(ll.clave(k.fingerprint).estado, 'rechazada');
    assert.strictEqual(ll.reactivar('vieja', LEAD, reglas).ok, true);
    assert.strictEqual(ll.clave(k.fingerprint).estado, 'pendiente', 'no queda afuera para siempre');
    assert.strictEqual(ll.aprobar(k.fingerprint, LEAD, ctx).ok, true);
    // retirar con el nombre nuevo alcanza la clave aprobada con el viejo
    const r2 = llavesEn(reloj);
    const k2 = par();
    pedir(r2.ll, k2);
    const antes = reglasFijas({ vieja: { carpeta: 'vieja', estado: 'confirmada', person: A } });
    assert.strictEqual(r2.ll.aprobar(k2.fingerprint, LEAD, { huellas: huellasDe({ vieja: [k2.fingerprint] }), reglas: antes, conBuzon: true }).ok, true);
    assert.strictEqual(r2.ll.retirar('nueva', LEAD, reglas).ok, true);
    assert.strictEqual(r2.ll.alConectar(k2.fingerprint).codigo, F.CLOSE.unknown);
    // el tiempo de baja no cuenta, con ninguno de los dos nombres
    const k3 = par();
    pedir(r2.ll, k3, '10.0.0.3');
    assert.strictEqual(r2.ll.aprobar(k3.fingerprint, LEAD, { huellas: huellasDe({ vieja: [k3.fingerprint] }), reglas: antes, conBuzon: true }).ok, true);
    r2.ll.darDeBaja('nueva', LEAD);
    reloj.t += 40 * DIA;
    r2.ll.vencer(reglas);
    assert.strictEqual(r2.ll.clave(k3.fingerprint).estado, 'aprobada', 'de baja: el plazo no corre');
    r2.ll.reactivar('nueva', LEAD, reglas);
    r2.ll.vencer(reglas);
    assert.strictEqual(r2.ll.clave(k3.fingerprint).estado, 'aprobada', 'vuelve con su clave');
    fs.rmSync(r2.d, { recursive: true, force: true });
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('Regresion_BajaSigueALaMaquinaMudada — @story-8.171 @ac-9', async () => {
  const dos = () => ops({ machines: { vieja: confirmada(A), nueva: confirmada(A) } });
  const unida = { informados: H.informados({ vieja: A, nueva: A }, { vieja: { estado: 'unida', nueva: 'nueva' } }), repos: null };
  const h = await montar({ config: dos(), personas: { informados: H.informados({ vieja: A, nueva: A }), repos: null } });
  try {
    const k = par();
    pedir(h.llaves, k);
    h.aprobar(k, 'vieja');
    assert.strictEqual(h.llaves.clave(k.fingerprint).maquina, 'vieja');
    const abierta = await maquinaCruda(h, k);
    assert.strictEqual(abierta.msgs.some((m) => m.type === 'ack'), true);
    // la carpeta se muda, y la baja se da con el nombre nuevo: no entra con la clave que aprobó con el nombre viejo
    h.fuentes.st.personas = unida;
    h.llaves.darDeBaja('nueva', LEAD);
    await hasta(() => abierta.cerro !== null, 2000, 'el corte de la conexión abierta');
    assert.strictEqual(abierta.cerro, F.CLOSE.revoked);
    const c = await maquinaCruda(h, k);
    assert.strictEqual(c.msgs.some((m) => m.type === 'ack'), false, 'no entra');
    await hasta(() => c.cerro !== null, 2000, 'el cierre');
    assert.strictEqual(c.cerro, F.CLOSE.revoked);
    h.llaves.reactivar('nueva', LEAD);
    // y la baja con el nombre viejo vale para una clave nueva de la misma máquina
    h.llaves.darDeBaja('vieja', LEAD);
    const k3 = par();
    pedir(h.llaves, k3, '10.0.0.3');
    const ctx = { huellas: huellasDe({ nueva: [k3.fingerprint] }), reglas: access.crearReglas({ config: dos(), modelo: {}, personas: unida }), conBuzon: true };
    assert.strictEqual(h.llaves.aprobar(k3.fingerprint, LEAD, ctx).motivo, 'de_baja');
    h.llaves.emparejar(ctx);
    assert.strictEqual(h.llaves.clave(k3.fingerprint).estado, 'rechazada', 'se rechaza sola');
  } finally { await h.cerrar(); }
});

test('Regresion_ClaveRobada_SeRetiraYLaMaquinaArmaOtraSola — @story-8.171 @ac-9', async () => {
  const h = await montar();
  const real = maquinaReal(h);
  try {
    // la máquina real, aprobada y conectada, con una foto en el sitio
    h.llaves.pedir({ publicKey: real.key.publicKey, fingerprint: real.key.fingerprint, nombre: 'real', direccion: '10.0.0.1' });
    h.aprobar(real.key);
    real.link.start();
    real.link.update(FOTO('Sesion real'));
    await hasta(() => h.centro.oficina('maquina-a'), 3000, 'su oficina');
    // retirarla la corta en el acto y saca su última foto
    assert.strictEqual(h.llaves.retirar('maquina-a', LEAD).ok, true);
    await hasta(() => !h.centro.conectada('maquina-a'), 2000, 'el corte');
    assert.strictEqual(h.centro.oficina('maquina-a'), null);
    await hasta(() => SL.readLinkState(real.dir) === 'desconocida', 2000, 'que la máquina sepa que su clave no vale');
    assert.strictEqual(h.llaves.retirar('maquina-a', LEAD).motivo, 'sin_clave');
    // quien la copió ya no entra, tampoco tras una baja y una reactivación
    const ladron = await maquinaCruda(h, real.key);
    await hasta(() => ladron.cerro !== null, 2000, 'el cierre');
    assert.strictEqual(ladron.cerro, F.CLOSE.unknown);
    h.llaves.darDeBaja('maquina-a', LEAD);
    h.llaves.reactivar('maquina-a', LEAD);
    assert.strictEqual(h.llaves.alConectar(real.key.fingerprint).codigo, F.CLOSE.unknown);
    // la próxima sesión de la máquina arma otra clave y vuelve a pedir, sin que el dev haga nada
    real.link.stop();
    const vieja = real.key.fingerprint;
    await SL.enrollIfNeeded({ site: h.base, sdir: real.dir, name: 'real', timeoutMs: 3000 });
    const nueva = SL.readKey(real.dir);
    assert.notStrictEqual(nueva.fingerprint, vieja);
    assert.strictEqual(h.llaves.clave(nueva.fingerprint).estado, 'pendiente');
    // con su huella en el buzón, la vencida no cuenta como vigente: se aprueba sin conflicto
    const ctx = { huellas: huellasDe({ 'maquina-a': [vieja, nueva.fingerprint] }), reglas: reglasDe(h.fuentes.st.config), conBuzon: true };
    assert.strictEqual(h.llaves.aprobar(nueva.fingerprint, LEAD, ctx).ok, true);
  } finally { real.parar(); await h.cerrar(); }
});

test('Regresion_AprobarUnaClaveNueva_RetiraLaAnterior — @story-8.171 @ac-9', async () => {
  const h = await montar();
  try {
    const vieja = par();
    pedir(h.llaves, vieja);
    h.aprobar(vieja);
    const c = await maquinaCruda(h, vieja);
    assert.strictEqual(c.msgs.some((m) => m.type === 'ack'), true);
    const nueva = par();
    pedir(h.llaves, nueva, '10.0.0.2');
    const ctx = { huellas: huellasDe({ 'maquina-a': [vieja.fingerprint, nueva.fingerprint] }), reglas: reglasDe(h.fuentes.st.config), conBuzon: true };
    assert.strictEqual(h.llaves.aprobar(nueva.fingerprint, LEAD, ctx).motivo, 'conflicto');
    assert.strictEqual(h.llaves.confirmarHuella(nueva.fingerprint, LEAD).ok, true);
    assert.strictEqual(h.llaves.aprobar(nueva.fingerprint, LEAD, ctx).ok, true);
    await hasta(() => c.cerro !== null, 2000, 'el corte de la conexión con la vieja');
    assert.strictEqual(c.cerro, F.CLOSE.unknown);
    assert.strictEqual(h.llaves.alConectar(vieja.fingerprint).codigo, F.CLOSE.unknown);
    assert.strictEqual(h.llaves.alConectar(nueva.fingerprint).codigo, null);
  } finally { await h.cerrar(); }
});

test('Regresion_OficinaDesconfirmadaYDesconectada_SaleDeLaVista — @story-8.171 @ac-11b', async () => {
  const h = await montar({ config: ops({ visibility: 'everyone' }) });
  try {
    const { ma } = await dosMaquinasConectadas(h);
    const nav = await navegador(h, B);
    await hasta(() => oficinas(nav).has('maquina-a'), 2000, 'su oficina');
    ma.ws.close();
    await hasta(() => !h.centro.conectada('maquina-a'), 2000, 'la desconexión');
    h.fuentes.st.config = ops({ visibility: 'everyone', machines: { 'maquina-b': confirmada(B) } });
    h.centro.revisar();
    await hasta(() => !oficinas(nav).has('maquina-a'), 2000, 'que salga de la vista');
    assert.strictEqual(h.centro.oficina('maquina-a'), null);
  } finally { await h.cerrar(); }
});

test('Regresion_ClaveVencida_CierraLaConexionAbierta — @story-8.171 @ac-9', async () => {
  const reloj = { t: Date.now() };
  const h = await montar({ reloj });
  try {
    const k = par();
    pedir(h.llaves, k);
    h.aprobar(k);
    const c = await maquinaCruda(h, k);
    // un mes con el sitio frenado: nadie renovó el plazo, y la máquina siguió latiendo
    reloj.t += 31 * DIA;
    c.ws.send(JSON.stringify({ type: 'ping' }));
    await hasta(() => c.msgs.some((m) => m.type === 'pong'), 2000, 'el pong');
    h.centro.revisar();
    await hasta(() => c.cerro !== null, 2000, 'el corte');
    assert.strictEqual(c.cerro, F.CLOSE.unknown);
  } finally { await h.cerrar(); }
});

test('Regresion_HuellaBorradaDelBuzon_SaleDelEspejo — @story-8.171 @ac-9', async () => {
  // si no sale, un conflicto causado por una huella ajena no se destraba nunca
  const espejo = fs.mkdtempSync(path.join(os.tmpdir(), 'espejo-'));
  const k = par();
  const volcado = JSON.stringify(H.volcado ? H.volcado({ story: '2.2' }) : {});
  const corrida = { 'maquina-a/2.2-2026-09-02T1000.json': volcado };
  const bajarDe = async (blobs) => {
    const buzon = await H.arrancarBuzon({ blobs });
    try { await bajar({ cuenta: 'cuentax', contenedor: 'runs', credencial: { sas: H.sas() }, urlBase: buzon.base, dir: espejo, budgetMs: 60000, podar: true }); } finally { await buzon.cerrar(); }
  };
  const archivo = path.join(espejo, 'maquina-a', 'office-keys', `${k.fingerprint}.json`);
  try {
    await bajarDe({ ...corrida, [`maquina-a/office-keys/${k.fingerprint}.json`]: JSON.stringify({ fingerprint: k.fingerprint, publicKey: k.publicKey }) });
    assert.ok(fs.existsSync(archivo), 'la huella bajó');
    await bajarDe(corrida);
    assert.ok(!fs.existsSync(archivo), 'la huella salió');
    assert.ok(fs.existsSync(path.join(espejo, 'maquina-a', '2.2-2026-09-02T1000.json')), 'lo demás queda');
    // un listado vacío no borra huellas: un buzón vacío de golpe es más probable que sea un error
    fs.mkdirSync(path.dirname(archivo), { recursive: true });
    fs.writeFileSync(archivo, '{}');
    await bajarDe({});
    assert.ok(fs.existsSync(archivo), 'la huella sigue');
  } finally { fs.rmSync(espejo, { recursive: true, force: true }); }
});

test('Regresion_ConfiarEnElIntermediario_LoDicenTodasLasRecetas — @story-8.171 @ac-14b', () => {
  const leer = (r) => fs.readFileSync(path.join(ROOT, r), 'utf8');
  assert.match(leer('scripts/site/deploy/render.yaml'), /key: SITE_TRUST_PROXY\n\s+value: "1"/);
  assert.match(leer('scripts/site/deploy/local/sitio.env.example'), /SITE_TRUST_PROXY=1/);
  for (const g of ['guides/organization-site.md', 'guides/organization-site.en.md']) assert.match(leer(g), /--set-env-vars SITE_TRUST_PROXY=1/, g);
});

// ── La conversación de cada sesión ─────────────────────────────────────────────────────────

test('T49 Sitio_GuardaYEntregaLaCharla_ConLaRegla — @story-8.171 @ac-27', async () => {
  const h = await montar();
  try {
    const { ma, mb } = await dosMaquinasConectadas(h);
    // el sitio anuncia en el ack que entiende la charla
    assert.deepStrictEqual(ma.msgs.find((m) => m.type === 'ack').puede, ['charla']);
    const charla = { conCoordinadora: [{ de: 'Coordinadora', texto: 'mirá <script>alert(1)</script> esto', at: 1000, propio: false }, { de: null, texto: 'listo', at: 2000, propio: true }] };
    ma.ws.send(JSON.stringify({ type: 'charla', sesion: 'Sesion de A', datos: charla }));
    mb.ws.send(JSON.stringify({ type: 'charla', sesion: 'Sesion de B', datos: { conCoordinadora: [{ de: 'Coordinadora', texto: 'lo de B', at: 1, propio: false }] } }));
    const ruta = (m, s) => `/offices/conversation?m=${encodeURIComponent(m)}&s=${encodeURIComponent(s)}`;
    const cookieA = await h.entrar(A);
    const cookieLead = await h.entrar(LEAD);
    const pedirHasta = async (r0, cookie, status) => {
      let r = null;
      for (let i = 0; i < 100; i += 1) { r = await h.pedir(r0, { cookie }); if (r.status === status) return r; await pausa(20); }
      return r;
    };
    const r = await pedirHasta(ruta('maquina-a', 'Sesion de A'), cookieA, 200);
    assert.strictEqual(r.status, 200, r.texto);
    assert.deepStrictEqual(r.json, charla, 'la entrega tal cual llegó: el texto va como dato y la página lo escapa');
    assert.match(r.headers['content-type'], /application\/json/);
    assert.strictEqual(r.headers['cache-control'], 'no-store');
    // quien no ve esa máquina recibe lo mismo que para una que no existe
    assert.strictEqual((await h.pedir(ruta('maquina-b', 'Sesion de B'), { cookie: cookieA })).status, 404);
    assert.strictEqual((await h.pedir(ruta('maquina-z', 'Sesion de A'), { cookie: cookieA })).status, 404);
    assert.strictEqual((await h.pedir(ruta('maquina-a', 'Otra'), { cookie: cookieA })).status, 404);
    assert.strictEqual((await pedirHasta(ruta('maquina-b', 'Sesion de B'), cookieLead, 200)).status, 200, 'quien mantiene ve todas');
    // sin sesión del sitio, nada
    assert.notStrictEqual((await h.pedir(ruta('maquina-a', 'Sesion de A'))).status, 200);
    // la sesión que sale de la foto se lleva su conversación
    ma.ws.send(JSON.stringify({ type: 'foto', data: FOTO('Otra sesion') }));
    assert.strictEqual((await pedirHasta(ruta('maquina-a', 'Sesion de A'), cookieA, 404)).status, 404, 'se fue con la sesión');
    // una charla de forma mala cierra la conexión
    mb.ws.send(JSON.stringify({ type: 'charla', sesion: 'Sesion de B', datos: { conCoordinadora: 'no es una lista' } }));
    await hasta(() => mb.cerro !== null, 3000, 'el cierre');
    assert.strictEqual(mb.cerro, F.CLOSE.policy);
    // nada del texto llega al registro, ni al disco del sitio
    assert.ok(!h.registro.join('\n').includes('alert(1)'), 'el registro no trae la conversación');
    const enDisco = [];
    const recorrer = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) recorrer(p); else enDisco.push(fs.readFileSync(p, 'utf8')); } };
    recorrer(h.dir);
    assert.ok(!enDisco.join('\n').includes('alert(1)'), 'ni el disco');
    ma.ws.close();
  } finally { await h.cerrar(); }
});

test('T49 Sitio_LaCharlaTieneTopes_PorOficinaPorSegundoYPorLargo — @story-8.171 @ac-27', async () => {
  // el sitio no confía en el filtro de la máquina: una clave filtrada no le llena la memoria
  const h = await montar({ opciones: { topes: { charlasPorOficina: 2, bytesCharlasPorOficina: 12000 } } });
  try {
    const { ma, mb } = await dosMaquinasConectadas(h);
    ma.ws.send(JSON.stringify({ type: 'foto', data: { agents: ['S1', 'S2', 'S3'].map((nombre) => ({ nombre, estado: 'trabajando' })), free: [], unreadable: [] } }));
    const de = (texto) => ({ conCoordinadora: [{ de: 'Coordinadora', texto, at: 1, propio: false }] });
    const ruta = (s) => `/offices/conversation?m=maquina-a&s=${encodeURIComponent(s)}`;
    const cookie = await h.entrar(LEAD);
    const textoDe = async (s) => { const r = await h.pedir(ruta(s), { cookie }); return r.status === 200 ? r.json.conCoordinadora[0].texto : null; };
    const hastaQue = async (fn, que) => { for (let i = 0; i < 100; i += 1) { if (await fn()) return; await pausa(20); } assert.fail(que); };
    await pausa(100);
    ma.ws.send(JSON.stringify({ type: 'charla', sesion: 'S1', datos: de('a '.repeat(1500)) }));
    ma.ws.send(JSON.stringify({ type: 'charla', sesion: 'S2', datos: de('b '.repeat(1500)) }));
    await hastaQue(async () => (await textoDe('S2')) !== null, 'guarda las dos primeras');
    // la tercera sesión pasa el tope de cantidad: no se guarda, y queda anotado una vez
    ma.ws.send(JSON.stringify({ type: 'charla', sesion: 'S3', datos: de('c') }));
    await pausa(150);
    assert.strictEqual(await textoDe('S3'), null, 'la tercera no se guarda');
    // un texto de hasta 8000 entra entero; la de una sesión ya guardada se reemplaza
    const largo = 'x '.repeat(3999) + 'y';
    ma.ws.send(JSON.stringify({ type: 'charla', sesion: 'S1', datos: de(largo) }));
    await hastaQue(async () => (await textoDe('S1')) === largo, 'un texto de 7999 caracteres entra entero');
    // la que pasaría el tope de bytes de la oficina no se guarda: queda la anterior
    ma.ws.send(JSON.stringify({ type: 'charla', sesion: 'S2', datos: de(largo) }));
    await pausa(150);
    assert.strictEqual(await textoDe('S2'), 'b '.repeat(1500), 'sin lugar, queda la anterior');
    assert.strictEqual(h.registro.filter((l) => l.includes('llenó su tope de conversaciones')).length, 1, 'anotado una vez');
    assert.strictEqual(ma.cerro, null, 'llenar el tope no corta la conexión');
    // un texto de más de 8000 es una forma mala: cierra
    mb.ws.send(JSON.stringify({ type: 'charla', sesion: 'Sesion de B', datos: de('z'.repeat(8001)) }));
    await hasta(() => mb.cerro !== null, 3000, 'el cierre por largo');
    assert.strictEqual(mb.cerro, F.CLOSE.policy);
    // las charlas cuentan para el tope de mensajes por segundo, como las fotos
    for (let i = 0; i < 12; i += 1) ma.ws.send(JSON.stringify({ type: 'charla', sesion: 'S1', datos: de(`ráfaga ${i}`) }));
    await hasta(() => ma.cerro !== null, 3000, 'el cierre por ráfaga');
    assert.strictEqual(ma.cerro, F.CLOSE.policy);
    assert.ok(h.registro.some((l) => l.includes('mensajes por segundo')));
  } finally { await h.cerrar(); }
});
