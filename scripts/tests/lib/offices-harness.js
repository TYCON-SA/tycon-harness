'use strict';
/*
 * offices-harness.js — el sitio real con máquinas de juguete conectadas, para las pruebas de la pestaña «Oficinas»
 * (site-offices.test.js y site-offices.smoke.js). Las máquinas firman de verdad; el sitio es el servidor real, con el
 * emisor local.
 */
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { arrancarEmisor } = require('./fake-oidc.js');
const H = require('./site-harness.js');

const ROOT = path.resolve(H.SITE, '..', '..');
const OFFICE_DIR = path.join(ROOT, 'scripts', 'tools', 'office');
const WS = require(path.join(OFFICE_DIR, 'vendor', 'ws'));
const F = require(path.join(OFFICE_DIR, 'fields.js'));
const SL = require(path.join(OFFICE_DIR, 'site-link.js'));
const { crearSitio } = require(path.join(H.SITE, 'server.js'));
const { crearLlaves } = require(path.join(H.SITE, 'machine-keys.js'));
const access = require(path.join(H.SITE, 'access.js'));

const A = 'dev.a@acme.example';
const B = 'dev.b@acme.example';
const SIN_MAQUINA = 'dev.c@acme.example';
const LEAD = 'lead@acme.example';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const sha = (c) => crypto.createHash('sha256').update(c).digest('hex');
const confirmada = (person) => ({ person, reported_sha256: sha(person), confirmed_by: LEAD, confirmed_on: '2026-10-15' });
/** maquina-a de A, maquina-b de B, y las que se pidan a nombre de quien mantiene. */
function ops(extras = []) {
  return {
    version: 1,
    owners: { default: LEAD },
    site: {
      access: [{ role: 'maintainer', emails: [LEAD] }, { role: 'dev', emails: [A] }, { role: 'dev', emails: [B] }, { role: 'dev', emails: [SIN_MAQUINA] }],
      mailbox: { provider: 'azure-blob', account: 'cuentax', container: 'runs' },
    },
    people: { machines: { 'maquina-a': confirmada(A), 'maquina-b': confirmada(B), ...Object.fromEntries(extras.map((m) => [m, confirmada(LEAD)])) } },
  };
}
const personasDe = (extras = []) => ({ informados: H.informados({ 'maquina-a': A, 'maquina-b': B, ...Object.fromEntries(extras.map((m) => [m, LEAD])) }), repos: null });
const puertoLibre = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(cond, ms = 5000, que = 'la condición') {
  // stable-data: el reloj sólo pone el plazo de espera de la prueba; no entra en lo que se compara
  const fin = Date.now() + ms;
  while (Date.now() < fin) { if (cond()) return; await pausa(10); }
  throw new Error(`no se cumplió ${que}`);
}

function par() {
  const dir = tmp('clave-');
  const key = SL.ensureKey(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return key;
}

/** El sitio real, con su centro y su disco, en su dirección pública. `extras`: más máquinas confirmadas. */
async function montar({ extras = [] } = {}) {
  const emisor = await arrancarEmisor();
  const puerto = await puertoLibre();
  const base = `http://127.0.0.1:${puerto}`;
  const fuentes = H.fuentesFijas({ config: ops(extras), personas: personasDe(extras) });
  const dir = tmp('sitio-oficinas-');
  const log = () => {};
  const llaves = crearLlaves({ dataDir: dir, log });
  const rutasExtra = require(path.join(H.SITE, 'tabs', 'offices.js')).crearRutas({ log });
  const sitio = crearSitio({ env: H.envBase({ SITE_OIDC_ISSUER: emisor.issuer, SITE_PUBLIC_URL: base }), fuentes, llaves, rutasExtra, centroOpciones: { repartoMs: 40 }, log });
  await sitio.iniciar();
  await new Promise((r) => sitio.server.listen(puerto, '127.0.0.1', r));
  const h = {
    base, fuentes, llaves, sitio, extras,
    pedir: (ruta, o) => H.pedirA(base, ruta, o),
    entrar: async (email) => (await H.ingresar(h, emisor, { sub: `s-${email}`, email, email_verified: true })).sesion,
    async cerrar() { await sitio.cerrar(); await emisor.cerrar(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
  return h;
}

function conectar(h, ruta, { headers = {}, origin } = {}) {
  const ws = new WS(`${h.base.replace('http', 'ws')}${ruta}`, { headers: { ...(origin ? { origin } : {}), ...headers } });
  const c = { ws, msgs: [], crudos: [], cerro: null };
  ws.on('message', (m) => { c.crudos.push(String(m)); try { c.msgs.push(JSON.parse(String(m))); } catch { c.msgs.push(String(m)); } });
  ws.on('close', (code) => { c.cerro = code; });
  ws.on('error', () => { if (c.cerro === null) c.cerro = -1; });
  return c;
}

/** Una máquina a mano: firma el desafío y queda autenticada. */
async function maquina(h, key) {
  const c = conectar(h, '/live/machine');
  await hasta(() => c.msgs.some((m) => m.type === 'challenge') || c.cerro !== null, 3000, 'el desafío');
  const reto = c.msgs.find((m) => m.type === 'challenge');
  const signature = crypto.sign(null, Buffer.from(F.signedText(h.base, reto.nonce)), crypto.createPrivateKey(key.privateKey)).toString('base64');
  c.ws.send(JSON.stringify({ type: 'auth', publicKey: key.publicKey, fingerprint: key.fingerprint, signature }));
  await hasta(() => c.msgs.some((m) => m.type === 'ack') || c.cerro !== null, 3000, 'el ack');
  return c;
}

/** Aprueba y conecta las máquinas pedidas (`{ id: foto }`), como lo hace quien mantiene. Devuelve `{ id: conexión }`. */
async function conectarMaquinas(h, fotos) {
  const ids = Object.keys(fotos);
  const llaves = Object.fromEntries(ids.map((id) => [id, par()]));
  ids.forEach((id, i) => h.llaves.pedir({ publicKey: llaves[id].publicKey, fingerprint: llaves[id].fingerprint, nombre: 'pista', direccion: `10.0.0.${i + 1}` }));
  h.fuentes.st.huellas = { medido: true, carpetas: Object.fromEntries(ids.map((id) => [id, { huellas: [llaves[id].fingerprint], llena: false }])) };
  const reglas = access.crearReglas({ config: ops(h.extras), modelo: {}, personas: personasDe(h.extras) });
  const ctx = { huellas: h.fuentes.st.huellas, reglas, conBuzon: true };
  const out = {};
  for (const id of ids) {
    assert.strictEqual(h.llaves.aprobar(llaves[id].fingerprint, LEAD, ctx).ok, true, `no se pudo aprobar ${id}`);
    // eslint-disable-next-line no-await-in-loop -- de a una, para que cada conexión reciba su desafío
    out[id] = await maquina(h, llaves[id]);
    out[id].ws.send(JSON.stringify({ type: 'foto', data: fotos[id] }));
  }
  return out;
}

module.exports = { A, B, SIN_MAQUINA, LEAD, tmp, hasta, pausa, par, montar, conectar, maquina, conectarMaquinas, ROOT, OFFICE_DIR, WS, F, SL, H };
