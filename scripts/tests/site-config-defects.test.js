'use strict';
// Los defectos del sitio: una sola dirección, nada que no esté guardado, la capa
// que sube sola, la lista propia de nombres, la diferencia por valor y los botones de las máquinas.
// Correr: node --test scripts/tests/site-config-defects.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const ORG = require(path.join(ROOT, 'scripts', 'lib', 'org-config.js'));
const TC = require(path.join(ROOT, 'scripts', 'lib', 'tycon-config.js'));
const { t } = require(path.join(ROOT, 'scripts', 'site', 'texts.js'));
const es = (k, v) => t('es', k, v);

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const esperar = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const HOY = '2026-11-04';
const AHORA = Date.parse(`${HOY}T12:00:00Z`);
const diaHace = (n) => new Date(AHORA - n * 86400000).toISOString().slice(0, 10);
// si el texto nombra el sitio: compara el origen de cada dirección que trae, no un pedazo del texto
const nombra = (texto, origen) => (String(texto).match(/https?:\/\/[\w.-]+(?::\d+)?/g) || []).some((u) => new URL(u).origin === origen);
const capa = (v, extra = {}) => JSON.stringify({ schema: 1, name: 'acme', ...extra, requires: { harness: `>= ${v}` } });

// ── la pantalla en un DOM falso ────────────────────────────────────────────────────────────────────────────────────────

/**
 * La pantalla de Configuración con un servidor de mentira: `respuestas[ruta](cuerpo)` contesta; `cargas` son las
 * respuestas sucesivas de `/api/config` (la primera y cada relectura). Los tiempos de seguimiento, cortos.
 */
async function pantalla({ cargas, respuestas = {} }) {
  const creados = [];
  const nodo = (tag) => { const n = { tag, hijos: [], textContent: '', attrs: {}, on: {}, value: undefined, setAttribute(k, v) { n.attrs[k] = String(v); }, getAttribute(k) { return k in n.attrs ? n.attrs[k] : null; }, removeAttribute(k) { delete n.attrs[k]; }, appendChild(c) { n.hijos.push(c); return c; }, addEventListener(e, f) { n.on[e] = f; }, replaceChildren(...cs) { n.hijos = cs; } }; creados.push(n); return n; };
  const app = nodo('div');
  const document = { querySelector: () => null, getElementById: (id) => (id === 'config-app' ? app : null), createElement: (tg) => nodo(tg) };
  const pedidos = [];
  let carga = 0;
  const fetch = (ruta, o) => {
    const cuerpo = o && o.body ? JSON.parse(o.body) : null;
    pedidos.push({ ruta, cuerpo });
    let r;
    if (ruta === '/api/config' || ruta === '/api/config?releer=1') { r = cargas[Math.min(carga, cargas.length - 1)]; carga += 1; }
    else if (respuestas[ruta.split('?')[0]]) r = respuestas[ruta.split('?')[0]](cuerpo, ruta);
    else r = { ok: false, problems: [] };
    return Promise.resolve({ status: 200, json: () => Promise.resolve(r) });
  };
  new Function('document', 'fetch', 'seguimientoPedido', 'esperasConsulta', 'esperaRespuesta', ORG.pantalla('es'))(document, fetch, { cada: 1, vueltas: 200 }, [1, 1, 1], 100000);
  await esperar();
  const todo = (n) => { const out = []; const walk = (x) => { out.push(x); (x.hijos || []).forEach(walk); }; walk(n); return out; };
  const sec = (id) => todo(app).filter((n) => n.attrs.id === `seccion-${id}`).pop();
  const textoDe = (id) => (sec(id) ? todo(sec(id)).map((n) => n.textContent).join(' | ') : '');
  const campo = (id, ruta) => (sec(id) ? todo(sec(id)).find((n) => (n.tag === 'input' || n.tag === 'textarea' || n.tag === 'select') && n.attrs['data-path'] === ruta) : null);
  const escribir = async (id, ruta, valor) => { const c = campo(id, ruta); assert.ok(c, `hay un campo ${ruta} en ${id}`); c.value = valor; (c.on.input || c.on.change)({ target: { value: valor } }); await esperar(); };
  const tocar = async (texto, id) => { const b = todo(sec(id)).filter((n) => n.tag === 'button' && n.textContent === texto).pop(); assert.ok(b, `hay «${texto}» en ${id}`); b.on.click({}); await esperar(); };
  const dormir = async (ms) => { await new Promise((r) => setTimeout(r, ms)); await esperar(); };
  return { sec, textoDe, campo, escribir, tocar, pedidos, dormir, todo };
}
const SEC = (id, extra = {}) => Object.assign({ id, titulo: id, repo: 'operaciones', estado: 'cargado', soloLectura: false, borrador: {}, problems: [], avisos: [] }, extra);
const PERFIL = (id, borrador, extra = {}) => SEC(id, { repo: 'perfil', borrador, ...extra });
const carga = (secciones, extra = {}) => ({ ok: true, secciones, proponer: { operaciones: { habilitado: true }, perfil: { habilitado: true } }, versiones: [], productos: [], ...extra });

// ── la dirección ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('T7 Direccion_UnSoloCampo @story-8.203 @ac-7 — la dirección se edita sólo en el perfil; «El sitio» no la tiene', async () => {
  const p = await pantalla({ cargas: [carga([SEC('sitio', { borrador: { site: { maintainers: ['ana@acme.example'], url: 'https://sitio.acme.example' } }, campos: { url: true } }), PERFIL('direccionSitio', { site: { url: 'https://sitio.acme.example' } })])] });
  assert.strictEqual(p.campo('sitio', 'site.url'), undefined, 'la sección «El sitio» no tiene el campo de la dirección');
  assert.ok(p.campo('direccionSitio', 'site.url'), 'el campo vive en «La dirección del sitio en cada máquina»');
});

test('T8 Direccion_SoloEnOperaciones_LoDiceConElValor @story-8.203 @ac-8 — con la dirección sólo en operations.json, el campo vacío y la línea con el valor', async () => {
  const url = 'https://sitio.acme.example';
  const p = await pantalla({ cargas: [carga([SEC('sitio', { borrador: { site: { maintainers: ['ana@acme.example'], url } } }), PERFIL('direccionSitio', {})])] });
  const c = p.campo('direccionSitio', 'site.url');
  assert.strictEqual(c.attrs.value, '');
  assert.ok(p.textoDe('direccionSitio').includes(es('pantalla.direccionSoloEnOperaciones', { url })), p.textoDe('direccionSitio'));
  // con el perfil que ya la tiene, la línea no está
  const q = await pantalla({ cargas: [carga([SEC('sitio', { borrador: { site: { maintainers: ['ana@acme.example'], url } } }), PERFIL('direccionSitio', { site: { url } })])] });
  assert.ok(!q.textoDe('direccionSitio').includes(es('pantalla.direccionSoloEnOperaciones', { url })));
});

test('T9 Direccion_LosNocturnosLeenElPerfil @story-8.203 @ac-9 — el resumen diario, el ciclo de fichas y team-config leen la del perfil, con operations.json de respaldo', () => {
  const A = 'https://perfil.acme.example';
  const B = 'https://ops.acme.example';
  // la regla, en un solo lugar
  assert.deepStrictEqual(ORG.direccionDelSitio({ perfil: { site: { url: A } }, operaciones: { site: { url: B } } }), { url: A, de: 'perfil', distintas: true });
  assert.deepStrictEqual(ORG.direccionDelSitio({ perfil: {}, operaciones: { site: { url: B } } }), { url: B, de: 'operaciones', distintas: false });
  assert.deepStrictEqual(ORG.direccionDelSitio({ perfil: null, operaciones: { site: { url: B } } }), { url: B, de: 'operaciones', distintas: false });
  assert.deepStrictEqual(ORG.direccionDelSitio({ perfil: { site: { url: A } }, operaciones: { site: {} } }), { url: A, de: 'perfil', distintas: false });
  assert.deepStrictEqual(ORG.direccionDelSitio({ perfil: { site: { url: A } }, operaciones: { site: { url: A } } }), { url: A, de: 'perfil', distintas: false });
  const d = tmp('dir-noche-');
  const ops = (url) => { const f = path.join(d, `ops-${crypto.randomBytes(3).toString('hex')}.json`); fs.writeFileSync(f, ORG.formatJson({ version: 1, owners: { default: 'ana@acme.example' }, site: url ? { maintainers: ['ana@acme.example'], url } : { maintainers: ['ana@acme.example'] } })); return f; };
  const perfil = (url) => { const f = path.join(d, `perfil-${crypto.randomBytes(3).toString('hex')}.json`); fs.writeFileSync(f, ORG.formatJson(url ? { site: { url } } : {})); return f; };
  // el resumen diario: su línea del sitio
  const DS = require(path.join(ROOT, 'scripts', 'nightly', 'dependencies', 'daily-summary.js'));
  const prueba = { resultado: 'paso', hora: `${HOY}T09:00:00Z`, avisos: [] };
  const dos = DS.lineaDe({ operations: ops(B), perfil: perfil(A), prueba, hoy: HOY });
  assert.ok(nombra(dos.linea, A) && !nombra(dos.linea, B), dos.linea);
  assert.ok(dos.aviso && nombra(dos.aviso, A) && nombra(dos.aviso, B), 'con las dos distintas, el resumen lo dice en una línea');
  const soloOps = DS.lineaDe({ operations: ops(B), perfil: perfil(null), prueba, hoy: HOY });
  assert.ok(nombra(soloOps.linea, B)); assert.ok(!soloOps.aviso);
  assert.ok(nombra(DS.lineaDe({ operations: ops(B), perfil: null, prueba, hoy: HOY }).linea, B), 'sin perfil, como hoy');
  // el ciclo de fichas: con la del perfil, las fichas se deciden en el sitio aunque operations.json no la tenga
  const CY = require(path.join(ROOT, 'scripts', 'nightly', 'findings', 'cycle.js'));
  assert.strictEqual(CY.sitioDecide(ops(null), { perfil: perfil(A) }).codigo, 0);
  assert.strictEqual(CY.sitioDecide(ops(B), { perfil: perfil(null) }).codigo, 0);
  assert.strictEqual(CY.sitioDecide(ops(null), { perfil: perfil(null) }).codigo, 1);
  assert.strictEqual(CY.sitioDecide(ops(B)).codigo, 0, 'sin perfil, como hoy');
  // por la línea de comandos, como la llama open-pr-per-finding.sh con el perfil del pipeline
  const cli = require('child_process').spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'nightly', 'findings', 'cycle.js'), 'site-decides', '--operations', ops(null), '--profile', perfil(A)], { encoding: 'utf8' });
  assert.strictEqual(cli.status, 0, cli.stderr);
  // quienes preguntan pasan el perfil que ya trae el pipeline (TEAM_PROFILE)
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts', 'ci', 'open-pr-per-finding.sh'), 'utf8'), /site-decides --operations operations\.json \$\{PERFIL_SITIO\[@\]\+/);
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts', 'nightly', 'dependencies', 'work-items.js'), 'utf8'), /sitioDecide\(rutaOperations, \{ perfil: process\.env\.TEAM_PROFILE/);
  // team-config: la dirección de la página
  const TCF = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'team-config.js'));
  const targets = (url) => [{ id: 'operations', state: 'loaded', data: { site: url ? { url } : {} } }];
  assert.strictEqual(TCF.siteOf(targets(B), { site: { url: A } }), A);
  assert.strictEqual(TCF.siteOf(targets(B), {}), B);
  assert.strictEqual(TCF.siteOf(targets(B), null), B);
  assert.strictEqual(TCF.siteOf(targets(null), { site: { url: A } }), A);
});

// ── lo propuesto que no entró ──────────────────────────────────────────────────────────────────────────────────────────

const VIEJA = 'https://vieja.acme.example';
const NUEVA = 'https://nueva.acme.example';
const ENLACE = 'https://dev.azure.com/acme/Proy/_git/perfil/pullrequest/123';
/** Revisar y proponer la dirección nueva; `codigo` es lo que contesta el sitio al proponer. */
async function proponerDireccion({ codigo, propuesta, cargas }) {
  const p = await pantalla({
    cargas,
    respuestas: {
      '/api/config/revisar': () => ({ ok: true, texto: ORG.formatJson({ site: { url: NUEVA } }), diferencia: [], resumen: [], problems: [], avisos: [] }),
      '/api/config/proponer': () => ({ ok: true, codigo, enlace: ENLACE, message: codigo === 'aplicado' ? 'aplicado' : 'pedido abierto' }),
      '/api/config/propuesta': propuesta || (() => ({ ok: true, estado: 'abierto', enlace: ENLACE })),
    },
  });
  await p.escribir('direccionSitio', 'site.url', NUEVA);
  await p.tocar(es('pantalla.revisarCambios'), 'direccionSitio');
  await p.tocar(es('pantalla.proponerElCambio'), 'direccionSitio');
  await p.tocar(es('pantalla.confirmarYProponer'), 'direccionSitio');
  return p;
}
const conDireccion = (url) => carga([PERFIL('direccionSitio', { site: { url } }, { texto: ORG.formatJson({ site: { url } }), oid: null })]);

test('T10 Propuesto_PedidoAbierto_NoDiceAlDia @story-8.203 @ac-10 — con el pedido abierto dice «Propuesto en el pedido 123»; cuando main lo trae, «al día»', async () => {
  let estado = 'abierto';
  const p = await proponerDireccion({ codigo: 'abierto', cargas: [conDireccion(VIEJA), conDireccion(VIEJA), conDireccion(NUEVA)], propuesta: () => ({ ok: true, estado, enlace: ENLACE }) });
  const txt = p.textoDe('direccionSitio');
  assert.ok(txt.includes(es('pantalla.propuestoSinEntrar', { n: '123' })), txt);
  assert.ok(!txt.includes(es('pantalla.alDia')), 'nunca «al día» con el pedido abierto');
  assert.ok(p.todo(p.sec('direccionSitio')).some((n) => n.tag === 'a' && n.attrs.href === ENLACE), 'con el enlace al pedido');
  // entra: la relectura trae main con la dirección nueva
  estado = 'aplicado';
  await p.dormir(20);
  const despues = p.textoDe('direccionSitio');
  assert.ok(despues.includes(es('pantalla.alDia')), despues);
  assert.ok(!despues.includes(es('pantalla.propuestoSinEntrar', { n: '123' })));
});

test('T28 Propuesto_PedidoCerradoSinEntrar_LoDiceYVuelveAMain @story-8.203 @ac-10 — el pedido se cerró sin entrar: lo dice, el campo vuelve a main y lo escrito queda como borrador', async () => {
  let estado = 'abierto';
  const p = await proponerDireccion({ codigo: 'abierto', cargas: [conDireccion(VIEJA)], propuesta: () => (estado === 'abierto' ? { ok: true, estado, enlace: ENLACE } : { ok: true, estado: 'no_hay' }) });
  estado = 'no_hay';
  await p.dormir(20);
  const txt = p.textoDe('direccionSitio');
  assert.ok(txt.includes(es('pantalla.pedidoCerradoSinEntrar', { n: '123' })), txt);
  assert.strictEqual(p.campo('direccionSitio', 'site.url').attrs.value, VIEJA, 'el campo muestra lo que tiene main');
  assert.ok(txt.includes(es('pantalla.recuperarLoQueEstabas')), 'lo escrito queda para volver a proponerlo');
  await p.tocar(es('pantalla.recuperarLoQueEstabas'), 'direccionSitio');
  assert.strictEqual(p.campo('direccionSitio', 'site.url').attrs.value, NUEVA);
});

test('T11 Propuesto_Aplicado_AlDia @story-8.203 @ac-11 — aplicado por el sitio: «al día», como hoy', async () => {
  const p = await proponerDireccion({ codigo: 'aplicado', cargas: [conDireccion(VIEJA), conDireccion(NUEVA)] });
  const txt = p.textoDe('direccionSitio');
  assert.ok(txt.includes(es('pantalla.alDia')), txt);
  assert.ok(!txt.includes(es('pantalla.propuestoSinEntrar', { n: '123' })));
});

// ── la capa sube sola ──────────────────────────────────────────────────────────────────────────────────────────────────

const IMAGEN = '2026.11.03.40';
const fila = (maquina, version, dia, persona = `${maquina}@acme.example`) => ({ maquina, persona, version, dia, diaTexto: dia || 'sin fecha', estado: 'no_medido', texto: '' });
const conNiveles = { approvals: { levels: { 'plan-approval': 2 } } };

test('T12 Capa_TodasLasActivasAlDia_SubeEnElMismoPedido @story-8.203 @ac-12 — todas las activas en V o más: la capa sube en el mismo pedido, lo demás igual, y lo dice antes', () => {
  const maquinas = [fila('mac-1', IMAGEN, diaHace(1)), fila('mac-2', ORG.LEVELS_SINCE, diaHace(3)), fila('mac-3', '2026.11.02.1', diaHace(0))];
  const r = ORG.capaQueSube({ layerText: capa('2026.10.01.1', { packs: ['bizuit'] }), actual: {}, doc: conNiveles, maquinas, versionImagen: IMAGEN, ahora: AHORA });
  assert.ok(r && !r.problema, JSON.stringify(r));
  assert.strictEqual(r.archivo, 'team-layer.json');
  assert.deepStrictEqual(JSON.parse(r.contenido), { schema: 1, name: 'acme', packs: ['bizuit'], requires: { harness: `>= ${ORG.LEVELS_SINCE}` } });
  assert.strictEqual(r.version, ORG.LEVELS_SINCE);
  assert.strictEqual(r.clave, 'approvals.levels');
  assert.strictEqual(r.aviso, es('pantalla.capaSube', { version: ORG.LEVELS_SINCE, clave: 'approvals.levels', n: 3 }));
});

test('T13 Capa_UnaActivaAtrasada_FrenaYLaNombra @story-8.203 @ac-13 — una activa debajo de V o ilegible frena y se nombra; las sin noticias no cuentan', () => {
  const maquinas = [
    fila('mac-vieja', '2026.10.01.1', diaHace(1), 'ana@acme.example'),
    fila('mac-ilegible', null, diaHace(2), 'beto@acme.example'),
    fila('mac-dormida', '2026.09.01.1', diaHace(20)),
    fila('mac-sin-fecha', null, null),
  ];
  const r = ORG.capaQueSube({ layerText: capa('2026.10.01.1'), actual: {}, doc: conNiveles, maquinas, versionImagen: IMAGEN, ahora: AHORA });
  assert.ok(r && r.problema, JSON.stringify(r));
  for (const x of ['mac-vieja', 'ana@acme.example', '2026.10.01.1', 'mac-ilegible', 'beto@acme.example']) assert.ok(r.problema.includes(x), `nombra ${x}: ${r.problema}`);
  assert.ok(r.problema.includes(ORG.LEVELS_SINCE));
  assert.ok(r.problema.includes(es('pantalla.capaQuedanAfuera', { n: 2, lista: 'mac-dormida, mac-sin-fecha' })), r.problema);
  // en V pero debajo de la imagen del sitio: no frena
  const enV = ORG.capaQueSube({ layerText: capa('2026.10.01.1'), actual: {}, doc: conNiveles, maquinas: [fila('mac-1', ORG.LEVELS_SINCE, diaHace(1))], versionImagen: IMAGEN, ahora: AHORA });
  assert.ok(enV && enV.archivo, JSON.stringify(enV));
});

test('T31 Capa_NingunaActiva_Frena @story-8.203 @ac-27 — con máquinas en el buzón y ninguna activa, no sube y nombra las que quedaron afuera', () => {
  const r = ORG.capaQueSube({ layerText: capa('2026.10.01.1'), actual: {}, doc: conNiveles, maquinas: [fila('mac-dormida', IMAGEN, diaHace(20)), fila('mac-sin-fecha', IMAGEN, null)], versionImagen: IMAGEN, ahora: AHORA });
  assert.ok(r && r.problema);
  assert.ok(r.problema.startsWith(es('org.capaSinSaberVersiones', { motivo: es('org.sinMaquinasActivas') }).replace(/\)\.$/, '')), r.problema);
  assert.ok(r.problema.includes('mac-dormida') && r.problema.includes('mac-sin-fecha'));
});

test('T29 Capa_VariasClaves_LaMayorYQuienLaPide @story-8.203 @ac-12 — con varias claves, V es la mayor y el aviso nombra la que la pide', () => {
  assert.ok(ORG.versionAtLeast(ORG.SESSION_NAMES_SINCE, ORG.LEVELS_SINCE) && ORG.SESSION_NAMES_SINCE !== ORG.LEVELS_SINCE);
  const doc = { approvals: { levels: { 'plan-approval': 2 } }, coordination: { session_names: ['ana', 'beto'] } };
  const r = ORG.capaQueSube({ layerText: capa('2026.10.01.1'), actual: {}, doc, maquinas: [fila('mac-1', IMAGEN, diaHace(1))], versionImagen: IMAGEN, ahora: AHORA });
  assert.strictEqual(JSON.parse(r.contenido).requires.harness, `>= ${ORG.SESSION_NAMES_SINCE}`);
  assert.strictEqual(r.clave, 'coordination.session_names');
  // las de Integraciones también cuentan
  const conHoras = ORG.clavesQuePidenVersion({ actual: { integrations: { clockify: true } }, doc: { integrations: { timeTracking: 'clockify' } } });
  assert.deepStrictEqual(conHoras, [['integrations.timeTracking', ORG.TIME_TRACKING_SINCE]]);
});

test('T30 Capa_SinCapa_UnSoloArchivoSinFrenar @story-8.203 @ac-26 — sin team-layer.json, un solo archivo y no frena', () => {
  assert.strictEqual(ORG.capaQueSube({ layerText: null, actual: {}, doc: conNiveles, maquinas: [], versionImagen: null, ahora: AHORA }), null);
});

test('T14 Capa_YaPideLoQueHace_NoSeToca @story-8.203 @ac-14 — la capa que ya pide V o más no se toca', () => {
  assert.strictEqual(ORG.capaQueSube({ layerText: capa(IMAGEN), actual: {}, doc: conNiveles, maquinas: [fila('mac-1', '2026.10.01.1', diaHace(1))], versionImagen: IMAGEN, ahora: AHORA }), null);
  assert.strictEqual(ORG.capaQueSube({ layerText: capa('2026.10.01.1'), actual: conNiveles, doc: conNiveles, maquinas: [], versionImagen: IMAGEN, ahora: AHORA }), null, 'sin cambiar la clave, nada');
});

test('T15 Capa_IlegibleOConOtraForma_Frena @story-8.203 @ac-15 — una capa rota o con otra forma frena con su motivo y no se pisa', () => {
  const maquinas = [fila('mac-1', IMAGEN, diaHace(1))];
  const rota = ORG.capaQueSube({ layerText: '{ roto', actual: {}, doc: conNiveles, maquinas, versionImagen: IMAGEN, ahora: AHORA });
  assert.ok(rota.problema && /team-layer\.json/.test(rota.problema) && !rota.contenido);
  const otra = ORG.capaQueSube({ layerText: JSON.stringify({ requires: { harness: '2026.1' } }), actual: {}, doc: conNiveles, maquinas, versionImagen: IMAGEN, ahora: AHORA });
  assert.ok(otra.problema && /no «>= versión»/.test(otra.problema) && !otra.contenido);
});

test('T16 Capa_SinBuzon_Frena @story-8.203 @ac-16 — sin máquinas, con el buzón ilegible o sin la versión de la imagen: no sabe y no sube', () => {
  const base = { layerText: capa('2026.10.01.1'), actual: {}, doc: conNiveles, ahora: AHORA };
  const casos = [
    [{ maquinas: [], versionImagen: IMAGEN }, es('org.sinMaquinasEnElBuzon')],
    [{ maquinas: null, maquinasMotivo: 'el espejo del buzón no se puede leer (EACCES)', versionImagen: IMAGEN }, 'el espejo del buzón no se puede leer (EACCES)'],
    [{ maquinas: [fila('mac-1', IMAGEN, diaHace(1))], versionImagen: null }, es('org.imagenSinVersion')],
  ];
  for (const [extra, motivo] of casos) {
    const r = ORG.capaQueSube({ ...base, ...extra });
    assert.ok(r && r.problema, JSON.stringify(extra));
    assert.strictEqual(r.problema, es('org.capaSinSaberVersiones', { motivo }));
  }
});

test('T17 Capa_Integraciones_SigueIgualConLaRegla @story-8.203 @ac-12 @ac-13 — Integraciones también mira las máquinas: con una activa atrasada, frena', () => {
  const r = ORG.capaQueSube({ layerText: capa('2026.10.01.1'), actual: { integrations: { clockify: true } }, doc: { integrations: { timeTracking: 'solidtime' } }, maquinas: [fila('mac-vieja', '2026.10.01.1', diaHace(1))], versionImagen: IMAGEN, ahora: AHORA });
  assert.ok(r && r.problema && r.problema.includes('mac-vieja'), JSON.stringify(r));
  // y la pestaña ya no sube la capa de Integraciones por su cuenta: usa la misma regla para todas las secciones del perfil
  const fuente = fs.readFileSync(path.join(ROOT, 'scripts', 'site', 'tabs', 'config.js'), 'utf8');
  assert.ok(!/s\.id === 'integraciones' && ORG\.cambiaLaCapa/.test(fuente), 'sin el atajo de Integraciones');
  assert.ok(/ORG\.capaQueSube\(/.test(fuente), 'la pestaña usa la regla común');
});

// ── la lista propia de nombres ─────────────────────────────────────────────────────────────────────────────────────────

test('T18 Nombres_ListaPropia_CampoConLoQueHabia @story-8.203 @ac-17 — «Lista propia» abre un campo de un nombre por renglón; sin el texto viejo', async () => {
  const p = await pantalla({ cargas: [carga([PERFIL('coordinacion', { coordination: { session_names: ['ana', 'beto', 'caro'] } })])] });
  const c = p.campo('coordinacion', 'coordination.session_names.lista');
  assert.ok(c, 'hay un campo para la lista');
  assert.strictEqual(c.attrs.value !== undefined ? c.attrs.value : c.textContent, 'ana\nbeto\ncaro');
  assert.ok(!p.textoDe('coordinacion').includes('pedísela a tu sesión'));
  // desde un tema, al elegir «Lista propia», el campo nace vacío
  const q = await pantalla({ cargas: [carga([PERFIL('coordinacion', { coordination: { session_names: Object.keys(TC.sessionNames.THEMES)[0] } })])] });
  assert.strictEqual(q.campo('coordinacion', 'coordination.session_names.lista'), undefined, 'con un tema, sin campo');
  const sel = q.campo('coordinacion', 'coordination.session_names');
  assert.ok(sel.hijos.some((o) => o.attrs.value === '__propia' && o.textContent === es('pantalla.nombresListaPropiaOpcion')));
  sel.on.change({ target: { value: '__propia' } }); await esperar();
  const vacio = q.campo('coordinacion', 'coordination.session_names.lista');
  assert.ok(vacio);
  assert.strictEqual(vacio.attrs.value !== undefined ? vacio.attrs.value : vacio.textContent, '');
});

test('T19 Nombres_ListaInvalida_ElMotivoDeLaMaquina @story-8.203 @ac-18 — los mismos motivos que la máquina; los renglones vacíos y los espacios no cuentan', async () => {
  const largo = 'a'.repeat(41);
  const muchos = Array.from({ length: 201 }, (_, i) => `n${i}`).join('\n');
  const perfil = { __doc: 'perfil de juguete', coordination: { max_working: 3 } };
  const revisar = (lista) => ORG.revisar({ seccion: 'coordinacion', texto: ORG.formatJson(perfil), borrador: { coordination: { max_working: 3, session_names: lista } }, lectores: { 'harness-config': TC } });
  for (const texto of ['Ñandu', largo, 'ana\nAna', muchos, '\n\n']) {
    const lista = ORG.nombresDeLaLista(texto);
    const motivo = TC.sessionNames.problem(lista);
    assert.ok(motivo, `${texto.slice(0, 10)} no sirve`);
    // el lector de la máquina, el mismo que corre el sitio al revisar, da ese motivo y no deja texto para proponer
    const r = revisar(lista);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.texto, null);
    assert.ok(r.problems.some((p) => p.message === motivo), `${JSON.stringify(r.problems)} — ${motivo}`);
  }
  // en la pantalla: lo que se escribe en el campo llega a «Revisar» ya limpio, y con el motivo del servidor no se propone
  const p = await pantalla({ cargas: [carga([PERFIL('coordinacion', { coordination: { session_names: ['ana'] } })])], respuestas: { '/api/config/revisar': (c) => ({ ok: false, problems: [{ path: 'coordination.session_names', message: TC.sessionNames.problem(c.borrador.coordination.session_names) }] }) } });
  await p.escribir('coordinacion', 'coordination.session_names.lista', 'Ñandu\n');
  await p.tocar(es('pantalla.revisarCambios'), 'coordinacion');
  assert.ok(p.textoDe('coordinacion').includes(TC.sessionNames.problem(['Ñandu'])), p.textoDe('coordinacion').slice(0, 300));
  const proponer = p.todo(p.sec('coordinacion')).find((n) => n.tag === 'button' && n.textContent === es('pantalla.proponerElCambio'));
  assert.ok(!proponer || proponer.attrs.disabled === 'disabled', 'no se propone');
  assert.deepStrictEqual(ORG.nombresDeLaLista('  ana \r\n\r\nbeto\n\n'), ['ana', 'beto']);
  assert.deepStrictEqual(ORG.nombresDeLaLista('\n\n'), []);
});

test('T20 Nombres_ListaValida_SeGuardaYSubeLaCapa @story-8.203 @ac-19 — una lista válida va al perfil como lista y pide SESSION_NAMES_SINCE', async () => {
  const p = await pantalla({ cargas: [carga([PERFIL('coordinacion', { coordination: { max_working: 3 } })])], respuestas: { '/api/config/revisar': (c) => ({ ok: true, texto: ORG.formatJson(c.borrador), diferencia: [], resumen: [], problems: [], avisos: [] }) } });
  const sel = p.campo('coordinacion', 'coordination.session_names');
  sel.on.change({ target: { value: '__propia' } }); await esperar();
  await p.escribir('coordinacion', 'coordination.session_names.lista', 'ana\n  beto\r\ncaro\n');
  await p.tocar(es('pantalla.revisarCambios'), 'coordinacion');
  const rev = p.pedidos.find((x) => x.ruta === '/api/config/revisar');
  assert.ok(rev, 'se revisa');
  assert.deepStrictEqual(rev.cuerpo.borrador.coordination.session_names, ['ana', 'beto', 'caro']);
  const r = ORG.capaQueSube({ layerText: capa(ORG.LEVELS_SINCE), actual: { coordination: { max_working: 3 } }, doc: { coordination: { max_working: 3, session_names: ['ana', 'beto', 'caro'] } }, maquinas: [fila('mac-1', IMAGEN, diaHace(1))], versionImagen: IMAGEN, ahora: AHORA });
  assert.strictEqual(JSON.parse(r.contenido).requires.harness, `>= ${ORG.SESSION_NAMES_SINCE}`);
});

// ── la diferencia por valor ────────────────────────────────────────────────────────────────────────────────────────────

/** Un team-repos.json con la forma que tiene hoy el del perfil (objetos en un renglón, columnas alineadas), con nombres de juguete. */
function reposEnOtroFormato() {
  const r = (p, o, pr, re) => `{ "platform": "${p}", "org": "${o}",${pr ? ` "project": "${pr}",` : ''} "repo": "${re}" }`;
  const filas = [];
  for (let i = 1; i <= 14; i += 1) filas.push(`      { "repo": ${r('azure', 'acme', `Proy${i}`, `Backend${i}`)}, "full_tests_pipeline": ${100 + i} }`);
  return [
    '{',
    '  "__doc": "Dónde vive cada repo de juguete.",',
    '  "version": 1,',
    '  "context_notice": { "tokens": 750000 },',
    `  "public":      ${r('github', 'acme', null, 'harness')},`,
    `  "profile":     ${r('azure', 'acme', 'Proy', 'perfil')},`,
    `  "operations":  ${r('azure', 'acme', 'Proy', 'ops')},`,
    '  "merge_suites": {',
    '    "default": "automatico",',
    '    "repos": [',
    filas.join(',\n'),
    '    ]',
    '  }',
    '}',
    '',
  ].join('\n');
}
const lineasDe = (tramos) => tramos.flatMap((tr) => tr.renglones || []);

test('T21 Diferencia_ArchivoEnOtroFormato_SoloElValorYLaLinea @story-8.203 @ac-20 — sólo el renglón del valor, con la marca, y la línea de la forma', () => {
  const antes = reposEnOtroFormato();
  const doc = JSON.parse(antes);
  doc.merge_suites.repos[3].full_tests_pipeline = 999;
  const despues = ORG.formatJson(doc);
  const d = ORG.diferenciaDeJson(antes, despues);
  const cambian = lineasDe(d.tramos).filter((x) => x.tipo !== 'igual');
  assert.deepStrictEqual(cambian.map((x) => x.tipo), ['sale', 'entra']);
  assert.match(cambian[0].linea, /"full_tests_pipeline": 104/);
  assert.match(cambian[1].linea, /"full_tests_pipeline": 999/);
  assert.strictEqual(cambian[0].linea.slice(cambian[0].marca[0], cambian[0].marca[1]), '104');
  assert.strictEqual(cambian[1].linea.slice(cambian[1].marca[0], cambian[1].marca[1]), '999');
  // los renglones que cambian sólo de forma: contados contra el archivo de hoy, fijados acá
  const forma = ORG.diferencia(antes, ORG.formatJson(JSON.parse(antes))).flatMap((tr) => tr.renglones || []).filter((x) => x.tipo === 'sale').length;
  assert.strictEqual(d.forma, forma);
  assert.strictEqual(d.forma, 18);
});

test('T22 Diferencia_ArchivoEnFormato_SinLinea @story-8.203 @ac-21 — en el formato del sitio: dos renglones con la marca y ninguna línea de forma', () => {
  const antes = ORG.formatJson(JSON.parse(reposEnOtroFormato()));
  const doc = JSON.parse(antes); doc.version = 2;
  const d = ORG.diferenciaDeJson(antes, ORG.formatJson(doc));
  const cambian = lineasDe(d.tramos).filter((x) => x.tipo !== 'igual');
  assert.deepStrictEqual(cambian.map((x) => [x.tipo, x.linea.slice(x.marca[0], x.marca[1])]), [['sale', '1'], ['entra', '2']]);
  assert.strictEqual(d.forma, 0);
});

test('T23 Diferencia_CrlfYMarcaDeOrden_SonForma @story-8.203 @ac-22 — los finales de Windows y la marca de orden de bytes cuentan como forma', () => {
  const enFormato = ORG.formatJson({ version: 1, owners: { default: 'ana@acme.example' } });
  for (const antes of [enFormato.replace(/\n/g, '\r\n'), `﻿${enFormato}`]) {
    const d = ORG.diferenciaDeJson(antes, enFormato);
    assert.deepStrictEqual(lineasDe(d.tramos).filter((x) => x.tipo !== 'igual'), [], 'ningún renglón de valor');
    assert.ok(d.forma > 0, 'cuentan en la línea de forma');
  }
});

test('T21c Diferencia_EnPantalla_LaLineaYLaMarca @story-8.203 @ac-20 — antes de confirmar: la línea de la forma y lo cambiado marcado dentro del renglón', async () => {
  const antes = reposEnOtroFormato();
  const doc = JSON.parse(antes); doc.merge_suites.repos[3].full_tests_pipeline = 999;
  const d = ORG.diferenciaDeJson(antes, ORG.formatJson(doc));
  const p = await pantalla({ cargas: [carga([PERFIL('repos', { version: 1 })])], respuestas: { '/api/config/revisar': () => ({ ok: true, texto: ORG.formatJson(doc), diferencia: d.tramos, forma: d.forma, resumen: [], problems: [], avisos: [] }) } });
  await p.tocar(es('pantalla.revisarCambios'), 'repos');
  await p.tocar(es('pantalla.proponerElCambio'), 'repos');
  assert.ok(p.textoDe('repos').includes(es('pantalla.formatoDelArchivo', { n: d.forma })), p.textoDe('repos').slice(0, 400));
  const marcas = p.todo(p.sec('repos')).filter((n) => n.tag === 'mark').map((n) => n.textContent);
  assert.deepStrictEqual(marcas, ['104', '999']);
});

// ── los botones de las máquinas ────────────────────────────────────────────────────────────────────────────────────────

test('T24 Maquinas_BotonesSeparados @story-8.203 @ac-23 — los botones de una celda tienen separación, también partidos en dos renglones', () => {
  const css = fs.readFileSync(path.join(ROOT, 'scripts', 'site', 'static', 'site.css'), 'utf8');
  const regla = /#config-app\s+\.tabla\s+\.acc\s*\{([^}]*)\}/.exec(css);
  assert.ok(regla, 'hay una regla para los botones de una celda de tabla');
  assert.match(regla[1], /display:\s*(inline-)?flex/);
  assert.match(regla[1], /flex-wrap:\s*wrap/);
  assert.match(regla[1], /gap:\s*[^;]*\d/);
});

// ── textos, guía y no-regresión ────────────────────────────────────────────────────────────────────────────────────────

const CLAVES_NUEVAS = ['pantalla.revisando', 'pantalla.guardando', 'pantalla.proponiendoBoton', 'pantalla.invitando', 'pantalla.abriendo', 'pantalla.sigueTrabajando', 'pantalla.direccionSoloEnOperaciones', 'pantalla.propuestoSinEntrar', 'pantalla.pedidoCerradoSinEntrar', 'pantalla.capaSube', 'pantalla.capaQuedanAfuera', 'org.capaMaquinasAtrasadas', 'org.capaSinSaberVersiones', 'org.sinMaquinasActivas', 'org.sinMaquinasEnElBuzon', 'pantalla.nombresListaPropiaOpcion', 'pantalla.nombresUnoPorRenglon', 'pantalla.formatoDelArchivo'];

test('T25 Textos_EnLosDosIdiomas @story-8.203 @ac-24 — las claves nuevas en castellano y en inglés; la vieja de la lista propia ya no está', () => {
  const TX = require(path.join(ROOT, 'scripts', 'site', 'texts.js'));
  for (const k of CLAVES_NUEVAS) {
    for (const idioma of ['es', 'en']) {
      const v = TX.t(idioma, k, { n: 1, url: 'u', version: 'v', clave: 'c', lista: 'l', motivo: 'm' });
      assert.ok(typeof v === 'string' && v.trim() && v !== k, `${k} en ${idioma}`);
    }
    assert.notStrictEqual(TX.t('es', k), TX.t('en', k), `${k} traducida`);
  }
  assert.throws(() => TX.t('es', 'pantalla.nombresListaPropia'), /no hay texto/, 'la clave vieja se borró');
});

test('T26 Guia_DiceLasCuatroCosas @story-8.203 @ac-24 — la guía y su inglés dicen la dirección única, el trabajando, la capa y la lista propia', () => {
  const g = fs.readFileSync(path.join(ROOT, 'guides', 'organization-site.md'), 'utf8');
  const en = fs.readFileSync(path.join(ROOT, 'guides', 'organization-site.en.md'), 'utf8');
  for (const rx of [/La dirección del sitio en cada máquina/, /se apaga mientras trabaja/, /sigue trabajando/, /sube `requires\.harness`/, /máquinas activas/, /Lista propia/, /Propuesto en el pull request/]) assert.match(g, rx);
  for (const rx of [/The site's address on each machine/, /turns off while it works/, /still working/, /raises `requires\.harness`/, /active machines/, /Own list/, /Proposed in pull request/]) assert.match(en, rx);
});

test('T27 NoRegresion_SuitesDelSitio @story-8.203 @ac-25 — las dos suites nuevas están en suites.json y la afirmación de la clave vieja se cambió', () => {
  const suites = fs.readFileSync(path.join(ROOT, 'scripts', 'tests', 'suites.json'), 'utf8');
  assert.match(suites, /site-busy-buttons\.test\.js/);
  assert.match(suites, /site-config-defects\.test\.js/);
  const vieja = fs.readFileSync(path.join(ROOT, 'scripts', 'tests', 'site-config.test.js'), 'utf8');
  assert.ok(!vieja.includes("'pantalla.nombresListaPropia'"), 'site-config.test.js ya no mira la clave borrada');
});

// el texto de la línea de la forma no rompe: un número suelto, en los dos idiomas
test('T21b Diferencia_LineaDeForma_ConSuNumero @story-8.203 @ac-20 — la línea de forma lleva el número', () => {
  assert.ok(es('pantalla.formatoDelArchivo', { n: 18 }).includes('18'));
  assert.ok(t('en', 'pantalla.formatoDelArchivo', { n: 18 }).includes('18'));
});

// ── lo que encontró el pase adversarial ────────────────────────────────────────────────────────────────────────────────

const BOM = '﻿';
const escribirJson = (dir, nombre, valor, conBom = false) => { const f = path.join(dir, nombre); fs.writeFileSync(f, (conBom ? BOM : '') + JSON.stringify(valor)); return f; };
const DS_CLI = path.join(ROOT, 'scripts', 'nightly', 'dependencies', 'daily-summary.js');
const sitioUrl = (...args) => require('child_process').spawnSync(process.execPath, [DS_CLI, 'site-url', ...args], { encoding: 'utf8' });

test('T32 Noche_LaPruebaDelSitio_UsaLaDireccionDelPerfil @story-8.203 @ac-9 — la prueba sin sesión de la noche prueba la misma dirección que dice el resumen', () => {
  const d = tmp('noche-url-');
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'pipelines', 'operations', 'examples', 'operations.json'), 'utf8'));
  const ops = (url) => { const o = JSON.parse(JSON.stringify(base)); o.site = { ...(o.site || {}) }; if (url) o.site.url = url; else delete o.site.url; return escribirJson(d, `ops-${url ? 'con' : 'sin'}.json`, o); };
  const perfil = escribirJson(d, 'team-profile.json', { site: { url: 'https://perfil.acme.example' } });
  let r = sitioUrl('--operations', ops('https://vieja.acme.example'), '--profile', perfil);
  assert.strictEqual(r.status, 0, r.stderr); assert.strictEqual(r.stdout.trim(), 'https://perfil.acme.example', 'con las dos, la del perfil');
  r = sitioUrl('--operations', ops(null), '--profile', perfil);
  assert.strictEqual(r.stdout.trim(), 'https://perfil.acme.example', 'sólo en el perfil');
  r = sitioUrl('--operations', ops('https://vieja.acme.example'));
  assert.strictEqual(r.stdout.trim(), 'https://vieja.acme.example', 'sin perfil, la de operations.json');
  r = sitioUrl('--operations', ops(null));
  assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout.trim(), '', 'ninguna: sin configurar');
  const rota = path.join(d, 'rota.json'); fs.writeFileSync(rota, '{');
  assert.strictEqual(sitioUrl('--operations', rota).status, 3, 'operations.json ilegible y sin perfil: no se pudo saber');
  assert.strictEqual(sitioUrl('--operations', rota, '--profile', perfil).stdout.trim(), 'https://perfil.acme.example', 'con el perfil alcanza');
  // los dos pipelines de la noche la toman de ahí
  for (const yml of ['pipelines/operations/dependency-audit.yml', 'pipelines/operations/github/dependency-audit.yml']) {
    const texto = fs.readFileSync(path.join(ROOT, yml), 'utf8');
    assert.match(texto, /daily-summary\.js site-url --operations operations\.json/, yml);
    assert.ok(!/c\.data\.site && c\.data\.site\.url/.test(texto), `${yml}: ya no lee sólo operations.json`);
  }
});

test('T33 Noche_ElPerfilLlegaAntesDeLosPedidos @story-8.203 @ac-9 — los pedidos de trabajo y el pull request por ficha ven el mismo perfil', () => {
  const ado = fs.readFileSync(path.join(ROOT, 'pipelines', 'operations', 'dependency-audit.yml'), 'utf8');
  const enAdo = (nombre) => ado.indexOf(`displayName: '${nombre}'`);
  assert.ok(enAdo('El perfil de la organización y su team-repos.json') > 0);
  assert.ok(enAdo('El perfil de la organización y su team-repos.json') < enAdo('Crear los pedidos de trabajo'), 'ADO: el perfil antes de los pedidos');
  const gh = fs.readFileSync(path.join(ROOT, 'pipelines', 'operations', 'github', 'dependency-audit.yml'), 'utf8');
  const enGh = (nombre) => gh.indexOf(`- name: ${nombre}`);
  assert.ok(enGh('El perfil de la organización') > 0, 'GitHub: un paso baja el perfil');
  assert.ok(enGh('El perfil de la organización') < enGh('Crear y comentar los issues'), 'GitHub: el perfil antes de los issues');
  assert.match(gh, /TEAM_PROFILE=.*>> "\$\{GITHUB_ENV\}"/, 'GitHub: deja TEAM_PROFILE para los pasos que siguen');
  // el resumen de GitHub usa el mismo perfil, no lo vuelve a bajar
  assert.match(gh, /PF=\(--profile "\$\{TEAM_PROFILE\}"\)/);
});

test('T34 Perfil_ConMarcaDeOrden_SeLee @story-8.203 @ac-9 — un team-profile.json con BOM, que la máquina acepta, también lo leen la noche y team-config', () => {
  const d = tmp('perfil-bom-');
  const perfil = escribirJson(d, 'team-profile.json', { site: { url: 'https://perfil.acme.example' } }, true);
  const ops = escribirJson(d, 'operations.json', { version: 1 });
  const CY = require(path.join(ROOT, 'scripts', 'nightly', 'findings', 'cycle.js'));
  assert.strictEqual(CY.sitioDecide(ops, { perfil }).codigo, 0);
  assert.strictEqual(sitioUrl('--operations', ops, '--profile', perfil).stdout.trim(), 'https://perfil.acme.example');
  const DS = require(DS_CLI);
  const l = DS.lineaDe({ operations: ops, perfil, prueba: { resultado: 'paso', hora: `${HOY}T06:00:00Z` }, hoy: HOY });
  assert.ok(nombra(l.linea, 'https://perfil.acme.example'), l.linea);
  assert.deepStrictEqual(ORG.leerPerfil(perfil), { site: { url: 'https://perfil.acme.example' } });
  assert.strictEqual(ORG.leerPerfil(path.join(d, 'no-esta.json')), null);
});

test('T35 Capa_VersionQueLaMaquinaNoLee_FrenaYNoSePisa @story-8.203 @ac-15 — un requires.harness que la máquina no lee es una capa ilegible; con BOM, se lee', () => {
  const actual = { coordination: { max_working: 3 } };
  const doc = { coordination: { max_working: 4 } };
  const maquinas = [{ maquina: 'mac-1', persona: 'a', version: '2099.01.01.1', dia: HOY }];
  for (const req of ['>= abc', '>= 2026.11.3']) {
    const r = ORG.capaQueSube({ layerText: JSON.stringify({ schema: 1, name: 'acme', requires: { harness: req } }), actual, doc, maquinas, versionImagen: '2099.01.01.1', ahora: AHORA });
    assert.ok(r && r.problema && r.problema.includes(req), `${req}: ${JSON.stringify(r)}`);
  }
  // la misma capa con BOM: el portón del perfil la lee como la máquina
  const gate = (layerText) => String(ORG.teamProfileGateProblem({ layerText, versionImagen: '2099.01.01.1', doc: { response: {} }, actual: {} }));
  const ilegible = es('org.capaIlegible', { error: 'X' }).split('X')[0];
  assert.ok(gate('{').includes(ilegible), 'sin BOM y rota: ilegible');
  assert.ok(!gate(BOM + capa('2000.01.01.1')).includes(ilegible), 'con BOM: se lee');
});

test('T36 Diferencia_CaracterFueraDelPlanoBasico_NoSeParte @story-8.203 @ac-20 — la marca no parte un carácter de dos unidades (un emoji en la lista propia)', () => {
  const antes = ORG.formatJson({ coordination: { session_names: { lista: ['🙂'] } } });
  const despues = ORG.formatJson({ coordination: { session_names: { lista: ['🙃'] } } });
  const { tramos } = ORG.diferenciaDeJson(antes, despues);
  const marcados = tramos.flatMap((tr) => tr.renglones).filter((l) => l && Array.isArray(l.marca));
  assert.ok(marcados.length >= 2, JSON.stringify(tramos));
  for (const l of marcados) {
    const [a, b] = l.marca;
    assert.ok(!/[\uD800-\uDBFF]$/.test(l.linea.slice(0, a)), `la marca empieza en medio de un carácter: ${JSON.stringify(l)}`);
    assert.ok(!/^[\uDC00-\uDFFF]/.test(l.linea.slice(b)), `la marca termina en medio de un carácter: ${JSON.stringify(l)}`);
  }
});

test('T37 Propuesto_EntroConUnAjuste_DejaDeDecirTodaviaNo @story-8.203 @ac-10 — cuando entra, aunque main lo traiga con un ajuste del revisor, deja de decir «todavía no entró»', async () => {
  let estado = 'abierto';
  const p = await proponerDireccion({ codigo: 'abierto', cargas: [conDireccion(VIEJA), conDireccion(VIEJA), conDireccion('https://ajustada.acme.example')], propuesta: () => ({ ok: true, estado, enlace: ENLACE }) });
  estado = 'aplicado';
  await p.dormir(30);
  const txt = p.textoDe('direccionSitio');
  assert.ok(!txt.includes(es('pantalla.propuestoSinEntrar', { n: '123' })), txt);
  assert.strictEqual(p.campo('direccionSitio', 'site.url').attrs.value, 'https://ajustada.acme.example');
});

test('T39 Capa_Ilegible_NoFrenaUnCambioQueNoPideVersion @story-8.203 @ac-15 — una capa que no se puede leer sólo frena lo que pide versión: cambiar ado.org abre el pull request', { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) ? 'sin permisos de archivo que se puedan quitar' : false }, async () => {
  const T = path.join(ROOT, 'scripts', 'tests');
  const H = require(path.join(T, 'lib', 'site-harness.js'));
  const { arrancarEmisor } = require(path.join(T, 'lib', 'fake-oidc.js'));
  const { validarConfiguracion } = require(path.join(H.SITE, 'server.js'));
  const { crearRepoHttp } = require(path.join(T, 'lib', 'git-http-repo.js'));
  const { arrancarAdoFalso } = require(path.join(T, 'lib', 'fake-ado-api.js'));
  const { spawnSync, execFile } = require('child_process');
  const LEAD = 'lead@acme.example';
  const ESCRITURA = `w-${crypto.randomBytes(6).toString('hex')}`;
  const CAB = `Basic ${Buffer.from(`x-access-token:${ESCRITURA}`).toString('base64')}`;
  const GH = (repo) => ({ platform: 'github', org: 'acme', repo });
  const opsBase = () => ({ version: 1, owners: { default: LEAD }, site: { maintainers: [LEAD] } });
  const PERFIL_DOC = { ado: { org: 'https://dev.azure.com/acme' }, integrations: { clockify: true, engram: true, mailbox: true, codex: 'detect', nightly: true }, update: { channel: 'latest', apply: 'auto', skills_source: 'separate' }, packs: { default: 'all' }, install: { profile: 'full' } };
  const g = (dir, ...a) => { const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@acme.example', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@acme.example', GIT_AUTHOR_DATE: '2026-10-16T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-16T12:00:00Z' } }); if (r.status) throw new Error(r.stderr); };
  const ops = tmp('capa-ops-'); g(ops, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(ops, 'operations.json'), ORG.formatJson(opsBase())); g(ops, 'add', '-A'); g(ops, 'commit', '-q', '-m', 'b');
  const buzon = tmp('capa-buzon-'); fs.mkdirSync(path.join(buzon, 'mac-1', 'registros'), { recursive: true }); fs.writeFileSync(path.join(buzon, 'mac-1', 'registros', 'place.json'), JSON.stringify({ day: HOY, install: { version: '2026.11.03.40' } }));
  const ado = await arrancarAdoFalso({ org: 'acme', project: 'Proy', repo: 'perfil' });
  ado.st.politicas = [{ isEnabled: true, isBlocking: true, type: { displayName: 'Minimum number of reviewers' }, settings: { minimumApproverCount: 1, creatorVoteCounts: false, scope: [{ refName: 'refs/heads/main', matchKind: 'Exact', repositoryId: ado.st.repoId }] } }];
  const raiz = tmp('capa-http-');
  const r = await crearRepoHttp({ raiz, nombre: 'perfil.git', archivos: { 'team-profile.json': PERFIL_DOC, 'team-layer.json': { requires: { harness: `>= ${ORG.RESPONSE_SINCE}` } }, 'team-repos.json': { version: 1, public: GH('harness'), profile: GH('profile'), operations: GH('ops') } }, cabecera: CAB });
  const dir = path.join(raiz, 'clon-del-sitio');
  await require('util').promisify(execFile)('git', ['-c', `http.extraheader=Authorization: ${CAB}`, 'clone', '-q', '--depth', '1', '--branch', 'main', r.url, dir]);
  const capaArchivo = path.join(dir, 'team-layer.json');
  let emisor; let h;
  try {
    const f = H.fuentesFijas({ config: opsBase(), modelo: {}, personas: { informados: null, repos: null } });
    f.clones = () => ({ operaciones: { dir: ops }, perfil: { dir } });
    f.dirBuzon = buzon; f.exclusivo = (fn) => fn();
    emisor = await arrancarEmisor();
    const env = H.envBase({ SITE_OIDC_ISSUER: emisor.issuer, SITE_PROFILE_REPO: 'https://git.acme.example/perfil.git', SITE_PROFILE_TOKEN: 't', SITE_PROFILE_WRITE_TOKEN: ESCRITURA });
    const cfg = validarConfiguracion(env).cfg;
    const remotos = { perfil: { platform: 'azure', org: 'acme', project: 'Proy', repo: 'perfil', web: 'https://dev.azure.com/acme/Proy/_git/perfil' } };
    const rutasExtra = require(path.join(H.SITE, 'tabs', 'config.js')).crearRutas({ cfg, fuentes: f, versionImagen: '2026.11.03.40', ahora: () => AHORA, remotos, urlBase: { azure: ado.base } });
    h = await H.arrancarSitio({ env, fuentes: f, rutasExtra });
    const lead = (await H.ingresar(h, emisor, { sub: 's', email: LEAD, email_verified: true })).sesion;
    const pag = await h.pedir('/configuracion', { cookie: lead });
    const tok = /<meta name="site-token" content="([^"]+)">/.exec(pag.texto)[1];
    const post = (ruta, c) => h.pedir(ruta, { method: 'POST', cookie: lead, body: JSON.stringify(c), headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json', 'x-site-token': tok } });
    fs.chmodSync(capaArchivo, 0o000);
    const s = (await h.pedir('/api/config', { cookie: lead })).json.secciones.find((x) => x.id === 'ado');
    const rev = (await post('/api/config/revisar', { seccion: 'ado', borrador: { ado: { org: 'https://dev.azure.com/otra' } } })).json;
    assert.strictEqual(rev.ok, true, JSON.stringify(rev));
    const prop = (await post('/api/config/proponer', { seccion: 'ado', texto: rev.texto, oid: s.oid })).json;
    assert.strictEqual(prop.ok, true, JSON.stringify(prop));
    assert.strictEqual(ado.st.pedidos.length, 1, 'abrió el pull request');
  } finally {
    try { fs.chmodSync(capaArchivo, 0o644); } catch { /* ya estaba */ }
    await Promise.allSettled([h, emisor, r, ado].filter(Boolean).map((x) => x.cerrar()));
  }
});

test('T40 Capa_SinRequiresONoObjeto @story-8.203 @ac-12 @ac-15 — una capa sin requires.harness sube a V; una que no es un objeto es ilegible y no se pisa', () => {
  const actual = { coordination: { max_working: 3 } };
  const doc = { coordination: { max_working: 4 } };
  const maquinas = [{ maquina: 'mac-1', persona: 'a', version: '2099.01.01.1', dia: HOY }];
  const sin = ORG.capaQueSube({ layerText: JSON.stringify({ schema: 1, name: 'acme' }), actual, doc, maquinas, versionImagen: '2099.01.01.1', ahora: AHORA });
  assert.ok(sin && sin.contenido && JSON.parse(sin.contenido).requires.harness === `>= ${sin.version}`, JSON.stringify(sin));
  for (const txt of ['[]', '"capa"', 'null']) {
    const r = ORG.capaQueSube({ layerText: txt, actual, doc, maquinas, versionImagen: '2099.01.01.1', ahora: AHORA });
    assert.ok(r && r.problema, `${txt}: ${JSON.stringify(r)}`);
  }
});

test('T41 Noche_PerfilRotoODireccionConCredencial_LoDiceSinMostrarla @story-8.203 @ac-9 — un perfil ilegible se avisa; el resumen muestra sólo el origen de cada dirección', () => {
  const d = tmp('noche-aviso-');
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'pipelines', 'operations', 'examples', 'operations.json'), 'utf8'));
  const ops = escribirJson(d, 'operations.json', { ...base, site: { ...(base.site || {}), url: 'https://vieja.acme.example' } });
  const DS = require(DS_CLI);
  const prueba = { resultado: 'paso', hora: `${HOY}T06:00:00Z` };
  // la dirección del perfil con usuario, clave y parámetros: el resumen va a los canales y no los muestra
  const conClave = escribirJson(d, 'con-clave.json', { site: { url: 'https://quien:secreto@perfil.acme.example/x?token=abc' } });
  const l = DS.lineaDe({ operations: ops, perfil: conClave, prueba, hoy: HOY });
  const todo = `${l.linea} ${l.aviso || ''}`;
  assert.ok(!/secreto|token=abc|quien/.test(todo), todo);
  assert.ok(nombra(todo, 'https://perfil.acme.example'), todo);
  // un perfil que está pero no se puede leer no es «sin perfil»: lo dice, y sigue con operations.json
  const roto = path.join(d, 'roto.json'); fs.writeFileSync(roto, '{');
  const r = DS.lineaDe({ operations: ops, perfil: roto, prueba, hoy: HOY });
  assert.ok(nombra(r.linea, 'https://vieja.acme.example'), r.linea);
  assert.ok(r.aviso && /perfil/.test(r.aviso) && /no se pudo leer/.test(r.aviso), JSON.stringify(r));
  const cli = sitioUrl('--operations', ops, '--profile', roto);
  assert.strictEqual(cli.stdout.trim(), 'https://vieja.acme.example');
  assert.match(cli.stderr, /perfil.*no se pudo leer/);
  // sin archivo de perfil, como hoy: sin aviso
  assert.ok(!DS.lineaDe({ operations: ops, perfil: null, prueba, hoy: HOY }).aviso);
});

test('T42 Diferencia_ArchivoConMarcaDeOrden_SeRevisa @story-8.203 @ac-22 — un team-repos.json con BOM, que la máquina lee, el sitio también lo revisa y la marca cuenta como forma', () => {
  const TR = require(path.join(ROOT, 'scripts', 'lib', 'team-repos.js'));
  const GHR = (repo) => ({ platform: 'github', org: 'acme', repo });
  const doc = { version: 1, context_notice: { tokens: 750000 }, public: GHR('harness'), profile: GHR('profile'), operations: GHR('ops') };
  const conBom = BOM + ORG.formatJson(doc);
  const r = ORG.revisar({ seccion: 'contexto', texto: conBom, borrador: { context_notice: { tokens: 800000 } }, lectores: { 'team-repos.js': TR } });
  assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
  assert.strictEqual(JSON.parse(r.texto).context_notice.tokens, 800000);
  const dif = ORG.diferenciaDeJson(conBom, r.texto);
  assert.ok(dif.forma > 0, 'la marca de orden cuenta como forma');
  // la pestaña lee el archivo del clon como la máquina
  const CFG = require(path.join(ROOT, 'scripts', 'site', 'tabs', 'config.js'));
  assert.deepStrictEqual(CFG.docDe(conBom), doc);
});

test('T43 Lectores_BordesDelPerfilYDelOrigen @story-8.203 @ac-9 @ac-22 — perfil con BOM, ausente o ilegible; dirección que no se lee; JSON que no es objeto', () => {
  const d = tmp('lectores-');
  const conBom = escribirJson(d, 'con-bom.json', { site: { url: 'https://perfil.acme.example' } }, true);
  assert.deepStrictEqual(ORG.estadoDelPerfil(conBom), { doc: { site: { url: 'https://perfil.acme.example' } }, ilegible: false });
  assert.deepStrictEqual(ORG.estadoDelPerfil(path.join(d, 'no-esta.json')), { doc: null, ilegible: false }, 'ausente no es ilegible');
  // una carpeta en lugar del archivo: está y no se puede leer
  fs.mkdirSync(path.join(d, 'carpeta.json'));
  assert.deepStrictEqual(ORG.estadoDelPerfil(path.join(d, 'carpeta.json')), { doc: null, ilegible: true });
  const roto = path.join(d, 'roto.json'); fs.writeFileSync(roto, '{');
  assert.deepStrictEqual(ORG.estadoDelPerfil(roto), { doc: null, ilegible: true });
  assert.strictEqual(ORG.origenDe('no es una dirección'), '(una dirección que no se puede leer)');
  assert.strictEqual(ORG.origenDe('https://a:b@sitio.acme.example:8443/x?y=1'), 'https://sitio.acme.example:8443');
  const CFG = require(path.join(ROOT, 'scripts', 'site', 'tabs', 'config.js'));
  for (const t of ['[]', '"texto"', '{', `${BOM}[]`]) assert.strictEqual(CFG.docDe(t), null, t);
});

test('T38 Propuesto_YaNoApareceYMainLoTiene_NoDiceCerrado @story-8.203 @ac-10 — si la plataforma ya no lo encuentra pero main tiene lo propuesto, entró: no dice que se cerró', async () => {
  let estado = 'abierto';
  const p = await proponerDireccion({ codigo: 'abierto', cargas: [conDireccion(VIEJA), conDireccion(VIEJA), conDireccion(NUEVA)], propuesta: () => (estado === 'abierto' ? { ok: true, estado, enlace: ENLACE } : { ok: true, estado: 'no_hay' }) });
  estado = 'no_hay';
  await p.dormir(30);
  const txt = p.textoDe('direccionSitio');
  assert.ok(!txt.includes(es('pantalla.pedidoCerradoSinEntrar', { n: '123' })), txt);
  assert.ok(txt.includes(es('pantalla.alDia')), txt);
});

// 🔴 Falla con: `office` fuera de las claves que piden versión: el cambio no sube la capa y una máquina anterior a
// OFFICE_SINCE rechaza el perfil entero.
test('Regresion_Oficina_SubeLaCapa — cambiar o sumar office.quiet_minutes sube requires.harness a OFFICE_SINCE', () => {
  const maquinas = [fila('mac-1', IMAGEN, diaHace(1))];
  for (const actual of [{ office: { quiet_minutes: 10 } }, {}]) {
    const doc = { office: { quiet_minutes: 20 } };
    assert.deepStrictEqual(ORG.clavesQuePidenVersion({ actual, doc }), [['office', ORG.OFFICE_SINCE]], JSON.stringify(actual));
    const r = ORG.capaQueSube({ layerText: capa('2026.10.20.3'), actual, doc, maquinas, versionImagen: IMAGEN, ahora: AHORA });
    assert.ok(r && r.archivo, JSON.stringify(r));
    assert.strictEqual(JSON.parse(r.contenido).requires.harness, `>= ${ORG.OFFICE_SINCE}`);
    assert.strictEqual(r.clave, 'office');
  }
  assert.deepStrictEqual(ORG.clavesQuePidenVersion({ actual: { office: { quiet_minutes: 20 } }, doc: { office: { quiet_minutes: 20 } } }), [], 'sin cambio no pide nada');
  const lista = ORG.clavesQuePidenVersion({ actual: { approvals: { relay_session: 'x' } }, doc: { approvals: { relay_session: 'x', signature_list: 'on' } } });
  assert.ok(lista.some(([k, v]) => k === 'approvals.signature_list' && v === ORG.SIGNATURE_LIST_SINCE), JSON.stringify(lista));
});

// 🔴 Falla con: una sección nueva del lector del perfil sin su versión en pedidasDelPerfil.
test('Regresion_CadaSeccionDelPerfil_PideSuVersion — toda sección que el primer lector publicado no conocía pide una versión', () => {
  // las que ya leía v2026.10.16.1, el primer lector publicado; `models` es de la máquina: en el perfil es un error siempre
  const deSiempre = ['rutas', 'github', 'azure', 'ado', 'telegram', 'integraciones', 'update', 'packs', 'install', 'adversarial'];
  const deLaMaquina = ['models'];
  const enArchivo = { rutas: 'paths', integraciones: 'integrations' };
  for (const s of Object.keys(TC.VOCABULARIO).filter((k) => !deSiempre.includes(k) && !deLaMaquina.includes(k))) {
    const clave = enArchivo[s] || s;
    const pedidas = ORG.pedidasDelPerfil({ actual: {}, doc: { [clave]: {} } });
    assert.ok(pedidas.some(([k]) => k === clave), `${clave} no pide versión: ${JSON.stringify(pedidas)}`);
  }
});
