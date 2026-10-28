'use strict';
/*
 * site-latest-release.test.js — la última imagen publicada en `stable`, leída sin credenciales, y lo que el sitio dice
 * con ella: el cartel para quienes mantienen y la línea de Arnés (T7 a T11).
 *
 * Sin red: el registro es un servidor local con la forma de la API v2 de distribución (el token anónimo, el manifiesto
 * y la configuración con la etiqueta de versión). El sitio es el de laboratorio de las pruebas (lib/site-harness.js).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const H = require('./lib/site-harness.js');
const { arrancarEmisor } = require('./lib/fake-oidc.js');

const LR = require(path.join(H.SITE, 'latest-release.js'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'site-ultima-'));
const LEAD = 'lead@acme.example';
const A = 'ana@acme.example';
// stable-data: el reloj de las pruebas es inyectado (T0); la hora real sólo la usa el emisor de mentira, como uno de verdad
const T0 = Date.parse('2026-10-18T12:00:00Z');

/** Un registro de juguete. `estado`: 'ok' | 401 | 'manifiesto-roto' | 'sin-version' | 'indice'. Anota cada pedido. */
async function registro({ version = '2026.10.18.9', estado = 'ok', source = 'https://github.example/acme/arnes', realm = null } = {}) {
  const config = JSON.stringify({ created: '2026-10-18T03:49:45Z', config: { Labels: estado === 'sin-version' ? {} : { 'org.opencontainers.image.version': version, 'org.opencontainers.image.revision': 'abc123', 'org.opencontainers.image.source': source, 'org.opencontainers.image.created': '2026-10-18T03:49:45Z' } } });
  const dConfig = `sha256:${crypto.createHash('sha256').update(config).digest('hex')}`;
  const huella = `sha256:${'c'.repeat(64)}`;
  const pedidos = [];
  const srv = http.createServer((req, res) => {
    pedidos.push({ url: req.url, auth: req.headers.authorization || null });
    // `realm`: el registro anuncia su token en otra ruta (en /oauth2/token) y /token no existe
    if (realm && req.url === '/v2/') { res.writeHead(401, { 'www-authenticate': realm(srv.address().port) }); res.end(); return; }
    if (realm && req.url.startsWith('/token')) { res.writeHead(404); res.end(); return; }
    if (realm && req.url.startsWith('/oauth2/token')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"access_token":"anonimo"}'); return; }
    if (req.url.startsWith('/token')) {
      if (estado === 401) { res.writeHead(401); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"token":"anonimo"}'); return;
    }
    if (req.headers.authorization !== 'Bearer anonimo') { res.writeHead(401); res.end(); return; }
    if (/\/manifests\/stable$/.test(req.url)) {
      if (estado === 'manifiesto-roto') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>no soy un manifiesto</html>'); return; }
      if (estado === 'indice') {
        res.writeHead(200, { 'content-type': 'application/vnd.oci.image.index.v1+json', 'docker-content-digest': huella });
        res.end(JSON.stringify({ schemaVersion: 2, manifests: [{ digest: `sha256:${'d'.repeat(64)}`, platform: { os: 'linux', architecture: 'amd64' } }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/vnd.docker.distribution.manifest.v2+json', 'docker-content-digest': huella });
      res.end(JSON.stringify({ schemaVersion: 2, config: { digest: dConfig } }));
      return;
    }
    if (req.url.endsWith(`/manifests/sha256:${'d'.repeat(64)}`)) { res.writeHead(200); res.end(JSON.stringify({ schemaVersion: 2, config: { digest: dConfig } })); return; }
    if (req.url.endsWith(`/blobs/${dConfig}`)) { res.writeHead(200); res.end(config); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${srv.address().port}`, pedidos, huella, cerrar: () => new Promise((r) => srv.close(r)) };
}

test('T7 2.33-Ultima_AnonimaDelRegistro @story-2.33 @ac-8 — la versión, la huella y la fecha, sin credenciales', async () => {
  // 🔴 rojo: el sitio manda una credencial al registro, o baja la imagen entera para saber su versión.
  for (const estado of ['ok', 'indice']) {
    const reg = await registro({ estado });
    try {
      const r = await LR.consultar({ imagen: 'ghcr.io/acme/arnes', urlBase: reg.base });
      assert.strictEqual(r.ok, true, r.motivo);
      assert.strictEqual(r.version, '2026.10.18.9');
      assert.strictEqual(r.huella, reg.huella);
      assert.strictEqual(r.creada, '2026-10-18T03:49:45Z');
      assert.ok(reg.pedidos.every((p) => p.auth === null || p.auth === 'Bearer anonimo'), 'sólo el token anónimo');
      assert.ok(!reg.pedidos.some((p) => /\/blobs\//.test(p.url) && !p.url.includes('sha256:')), 'ninguna capa');
      // el anuncio del token (/v2/), el token, el manifiesto (o el índice y su imagen) y la configuración
      assert.ok(reg.pedidos.length <= 5, `pocos pedidos: ${reg.pedidos.length}`);
    } finally { await reg.cerrar(); }
  }
});

test('T8 2.33-Ultima_NoPudoConMotivo @story-2.33 @ac-8 — 401, sin red, un manifiesto inválido, sin la etiqueta: no_pudo, sin tirar', async () => {
  for (const [estado, motivo] of [[401, /no es pública/], ['manifiesto-roto', /no se entiende/], ['sin-version', /etiqueta de versión/]]) {
    const reg = await registro({ estado });
    try {
      const v = LR.crearVigia({ imagen: 'ghcr.io/acme/arnes', dataDir: tmp(), ahora: () => T0, urlBase: reg.base });
      await v.mirar();
      const e = v.estado();
      assert.strictEqual(e.estado, 'no_pudo', JSON.stringify(e));
      assert.match(e.motivo, motivo);
      assert.ok(LR.MOTIVOS.includes(e.motivo), `motivo de la lista cerrada: ${e.motivo}`);
    } finally { await reg.cerrar(); }
  }
  const v = LR.crearVigia({ imagen: 'ghcr.io/acme/arnes', dataDir: tmp(), ahora: () => T0, urlBase: 'http://127.0.0.1:9' });
  await v.mirar();
  assert.deepStrictEqual(v.estado(), { estado: 'no_pudo', motivo: 'sin red' });
  const sinImagen = LR.crearVigia({ imagen: null, dataDir: tmp(), ahora: () => T0 });
  await sinImagen.mirar();
  assert.strictEqual(sinImagen.estado().estado, 'no_pudo');
  assert.ok(LR.MOTIVOS.includes(sinImagen.estado().motivo));
});

test('T9 2.33-Ultima_UnaVezPorHora @story-2.33 @ac-8 — un pedido por hora, guardado en SITE_DATA_DIR; sin disco, lo dice', async () => {
  const reg = await registro();
  try {
    let t = T0;
    const dataDir = tmp();
    const registroLog = [];
    const v = LR.crearVigia({ imagen: 'ghcr.io/acme/arnes', dataDir, ahora: () => t, urlBase: reg.base, log: (l) => registroLog.push(l) });
    await v.mirar();
    const tokens = () => reg.pedidos.filter((p) => p.url.startsWith('/token')).length;
    assert.strictEqual(tokens(), 1);
    t = T0 + 30 * 60000; await v.mirar();
    assert.strictEqual(tokens(), 1, 'a los 30 minutos no vuelve a mirar');
    // otro proceso (un reinicio) con el mismo disco tampoco: la respuesta guardada vale
    const v2 = LR.crearVigia({ imagen: 'ghcr.io/acme/arnes', dataDir, ahora: () => t, urlBase: reg.base });
    await v2.mirar();
    assert.strictEqual(tokens(), 1, 'después de reiniciar, con la respuesta guardada, tampoco');
    assert.strictEqual(v2.estado().version, '2026.10.18.9');
    t = T0 + 61 * 60000; await v.mirar();
    assert.strictEqual(tokens(), 2, 'a los 61 minutos, sí');
    // un disco que no se puede escribir: no guarda y lo dice en el registro, sin romper nada
    const soloLectura = path.join(tmp(), 'no-existe', 'ni-se-crea');
    fs.writeFileSync(path.dirname(path.dirname(soloLectura)) + '/no-existe', 'un archivo, no una carpeta');
    const v3 = LR.crearVigia({ imagen: 'ghcr.io/acme/arnes', dataDir: soloLectura, ahora: () => t, urlBase: reg.base, log: (l) => registroLog.push(l) });
    await v3.mirar();
    assert.strictEqual(v3.estado().version, '2026.10.18.9', 'igual responde');
    assert.ok(registroLog.some((l) => /no se pudo guardar la última publicada/.test(l)), registroLog.join('\n'));
  } finally { await reg.cerrar(); }
});

/** El sitio de laboratorio con una imagen vieja y su vigía contra el registro de juguete; dos sesiones. */
async function conSitio({ reg, version = '2026.10.15.48', config }, fn) {
  const emisor = await arrancarEmisor();
  let h = null;
  try {
    const vigia = LR.crearVigia({ imagen: 'ghcr.io/acme/arnes', dataDir: tmp(), ahora: () => T0, urlBase: reg ? reg.base : 'http://127.0.0.1:9' });
    h = await H.arrancarSitio({ env: H.envBase({ SITE_OIDC_ISSUER: emisor.issuer, SITE_PUBLIC_URL: 'https://site.acme.example' }), fuentes: H.fuentesFijas({ config }), version, vigia });
    await vigia.mirar();
    const entrar = async (email) => (await H.ingresar(h, emisor, { sub: `s-${email}`, email, email_verified: true })).sesion;
    await fn({ h, entrar });
  } finally { if (h) await h.cerrar(); await emisor.cerrar(); }
}
const CONFIG = { version: 1, owners: { default: LEAD }, site: { maintainers: [LEAD] }, people: { machines: { 'maq-a-11111111': { person: A, reported_sha256: null, confirmed_by: LEAD, confirmed_on: '2026-10-18' } } } };

test('T10 2.33-Sitio_CartelSoloMantenedores @story-2.33 @ac-7 — quien mantiene ve el cartel con las dos versiones; una persona no', async () => {
  const reg = await registro();
  try {
    await conSitio({ reg, config: CONFIG }, async ({ h, entrar }) => {
      const lead = await entrar(LEAD);
      for (const ruta of ['/', '/arnes']) {
        const r = await h.pedir(ruta, { cookie: lead });
        assert.strictEqual(r.status, 200, ruta);
        assert.match(r.texto, /hay una versión nueva del sitio: 2026\.10\.18\.9 \(la tuya: 2026\.10\.15\.48\)/, `${ruta}: el cartel`);
        // sin site.update, el modo es sólo aviso: el enlace a cómo se actualiza (la receta de la guía, del repo de la imagen)
        assert.match(r.texto, /cómo se actualiza: <a href="https:\/\/github\.example\/acme\/arnes\/blob\/main\/guides\/organization-site\.md#c%C3%B3mo-se-mantiene-al-d%C3%ADa">/, `${ruta}: el modo`);
      }
      const arnes = (await h.pedir('/arnes', { cookie: lead })).texto;
      assert.match(arnes, /Última publicada<\/span><span class="estado">2026\.10\.18\.9 \(del 2026-10-18\)/);
      const ana = await entrar(A);
      const r = await h.pedir('/', { cookie: ana });
      assert.strictEqual(r.status, 200);
      assert.doesNotMatch(r.texto, /versión nueva del sitio|2026\.10\.18\.9/, 'una persona no ve el cartel ni la versión');
    });
    // con site.update «auto», el texto del modo cambia
    await conSitio({ reg, config: { ...CONFIG, site: { ...CONFIG.site, update: 'auto' } } }, async ({ h, entrar }) => {
      const r = await h.pedir('/', { cookie: await entrar(LEAD) });
      assert.match(r.texto, /se instala sola con el próximo nocturno/);
    });
    // la misma versión: sin cartel
    await conSitio({ reg, version: '2026.10.18.9', config: CONFIG }, async ({ h, entrar }) => {
      const r = await h.pedir('/', { cookie: await entrar(LEAD) });
      assert.doesNotMatch(r.texto, /versión nueva del sitio/);
    });
  } finally { await reg.cerrar(); }
});

test('T11 2.33-Sitio_SinMirarNuncaAlDia @story-2.33 @ac-8 @ac-20 — con el registro caído, lo dice; /healthz igual', async () => {
  await conSitio({ reg: null, config: CONFIG }, async ({ h, entrar }) => {
    const lead = await entrar(LEAD);
    const arnes = (await h.pedir('/arnes', { cookie: lead })).texto;
    assert.match(arnes, /no se pudo mirar la última publicada \(sin red\)/);
    assert.doesNotMatch(arnes, /al día|versión nueva del sitio/, 'nunca «al día» sin haber mirado, y sin cartel');
    const hz = await h.pedir('/healthz');
    assert.strictEqual(hz.status, 200);
    assert.strictEqual(hz.texto, '{"ok":true}', '/healthz exactamente igual que antes');
    const lz = await h.pedir('/livez');
    assert.doesNotMatch(lz.texto, /2026\./, 'ninguna versión sin sesión');
  });
});

test('T7b 2.33-Ultima_TokenDondeLoAnunciaElRegistro @story-2.33 @ac-8 — el token donde lo anuncia el 401 del registro, sólo del mismo origen', async () => {
  // 🔴 rojo: con un registro que da el token en /oauth2/token (Azure), el lector pide /token y no lee nada.
  const reg = await registro({ realm: (port) => `Bearer realm="http://127.0.0.1:${port}/oauth2/token",service="lab.example"` });
  try {
    const r = await LR.consultar({ imagen: 'lab.example/acme/arnes', urlBase: reg.base });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.version, '2026.10.18.9');
    const tok = reg.pedidos.find((p) => p.url.startsWith('/oauth2/token'));
    assert.ok(tok && /service=lab\.example/.test(tok.url) && /scope=repository%3Aacme%2Farnes%3Apull|scope=repository:acme\/arnes:pull/.test(tok.url), JSON.stringify(reg.pedidos));
  } finally { await reg.cerrar(); }
  // un token anunciado en otro origen no se pide: la consulta no manda nada afuera del registro elegido
  const ajeno = await registro({ realm: () => 'Bearer realm="https://otro.example/oauth2/token",service="lab.example"' });
  try {
    const r = await LR.consultar({ imagen: 'lab.example/acme/arnes', urlBase: ajeno.base });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.codigo, 'ilegible');
  } finally { await ajeno.cerrar(); }
});
