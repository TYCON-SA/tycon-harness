'use strict';
/*
 * site-update.test.js — el actualizador del sitio (scripts/site/deploy/update-site.js): resuelve `stable`, compara con lo
 * que corre, aplica con la herramienta de cada entorno, prueba y vuelve atrás (T12 a T21 y T30).
 *
 * Sin red ni Azure ni Render: el registro es un servidor local con la forma de la API v2 (imágenes por huella, cada una
 * con su etiqueta de versión, y `stable`); `az` y `docker` son dobles de esta prueba que anotan cada orden; el hook de
 * Render, otro servidor local; la prueba sin sesión, una función que dice pasó o falló.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const UP = require(path.join(ROOT, 'scripts', 'site', 'deploy', 'update-site.js'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'site-update-'));
// stable-data: el reloj es inyectado; ninguna prueba compara contra la hora real
const T0 = Date.parse('2026-10-18T04:00:00Z');
const huella = (c) => `sha256:${c.repeat(64)}`;
const VIEJA = huella('a');
const NUEVA = huella('b');
const IMAGEN = 'ghcr.io/acme/arnes';

/** Un registro de juguete con imágenes por huella (cada una con su versión) y la etiqueta stable. */
async function registro({ imagenes = { [VIEJA]: '2026.10.15.48', [NUEVA]: '2026.10.18.9' }, stable = NUEVA } = {}) {
  const config = (v) => JSON.stringify({ config: { Labels: { 'org.opencontainers.image.version': v } } });
  const dc = (v) => `sha256:${crypto.createHash('sha256').update(config(v)).digest('hex')}`;
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/token')) { res.writeHead(200); res.end('{"token":"anonimo"}'); return; }
    const m = /\/manifests\/(.+)$/.exec(req.url);
    if (m) {
      const ref = decodeURIComponent(m[1]);
      const h = ref === 'stable' ? stable : ref;
      if (!h || !imagenes[h]) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/vnd.docker.distribution.manifest.v2+json', 'docker-content-digest': h });
      res.end(JSON.stringify({ schemaVersion: 2, config: { digest: dc(imagenes[h]) } }));
      return;
    }
    const b = /\/blobs\/(sha256:[0-9a-f]{64})$/.exec(req.url);
    const v = b && Object.values(imagenes).find((x) => dc(x) === b[1]);
    if (v) { res.writeHead(200); res.end(config(v)); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${srv.address().port}`, cerrar: () => new Promise((r) => srv.close(r)) };
}

/** Un `az` de esta prueba: contesta la imagen que corre y anota cada `update` (en memoria, sin procesos). */
/**
 * Un `az` de juguete con revisiones, como Container Apps en modo de una sola revisión: cada `update` crea una revisión
 * nueva con su imagen. `listaTras`: cuántas preguntas tarda la revisión nueva en quedar lista y con todo el tráfico
 * (0, enseguida; Infinity, nunca). Mientras no está lista, el tráfico sigue en la anterior.
 */
function azDeJuguete(corre = `${IMAGEN}@${VIEJA}`, { listaTras = 0 } = {}) {
  const ordenes = [];
  const revs = [{ nombre: 'sitio-acme--0000001', imagen: corre }];
  let lista = 0;
  let falta = 0;
  const actual = () => revs[revs.length - 1];
  const correr = (args) => {
    ordenes.push(args);
    if (args[0] === 'containerapp' && args[1] === 'show' && args.join(' ').includes('latestReadyRevisionName')) {
      if (falta > 0) falta -= 1;
      if (falta === 0) lista = revs.length - 1;
      const sirve = revs[lista].nombre;
      return { status: 0, stdout: JSON.stringify({ ultima: actual().nombre, lista: sirve, trafico: [{ revisionName: sirve, weight: 100 }] }), stderr: '' };
    }
    if (args[0] === 'containerapp' && args[1] === 'revision' && args[2] === 'show') {
      const r = revs.find((x) => x.nombre === args[args.indexOf('--revision') + 1]);
      return r ? { status: 0, stdout: JSON.stringify({ imagen: r.imagen, estado: 'Running' }), stderr: '' } : { status: 1, stdout: '', stderr: 'no existe' };
    }
    if (args[0] === 'containerapp' && args[1] === 'show') return { status: 0, stdout: `${actual().imagen}\n`, stderr: '' };
    if (args[0] === 'containerapp' && args[1] === 'update') {
      revs.push({ nombre: `sitio-acme--000000${revs.length + 1}`, imagen: args[args.indexOf('--image') + 1] });
      // volver a la anterior (la revisión ya existió) se ve enseguida; la nueva tarda lo que diga `listaTras`
      falta = revs.length > 2 && revs[revs.length - 1].imagen === revs[0].imagen ? 0 : listaTras;
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'orden no prevista' };
  };
  return { ordenes, correr, updates: () => ordenes.filter((a) => a[1] === 'update'), imagen: () => actual().imagen, sirve: () => revs[lista].imagen };
}
const AZURE = { grupo: 'rg-sitio-acme', app: 'sitio-acme', url: 'https://sitio.acme.example' };
const base = (reg, extra = {}) => ({ imagen: IMAGEN, urlRegistro: reg.base, estadoDir: tmp(), ahora: () => T0, log: () => {}, ...extra });

test('T12 2.33-Azure_IgualNoToca @story-2.33 @ac-10 — la misma huella: al_dia, ningún update', async () => {
  const reg = await registro({ stable: VIEJA });
  try {
    const az = azDeJuguete();
    const r = await UP.actualizar({ ...base(reg), plataforma: 'azure', modo: 'auto', azure: AZURE, correr: az.correr, probar: async () => ({ ok: true }) });
    assert.strictEqual(r.resultado, 'al_dia', JSON.stringify(r));
    assert.deepStrictEqual(az.updates(), []);
  } finally { await reg.cerrar(); }
});

test('T13 2.33-Azure_AvisoNoToca @story-2.33 @ac-10 — sólo aviso (o sin la clave): aviso, ningún update', async () => {
  const reg = await registro();
  try {
    for (const modo of [undefined, 'notice']) {
      const az = azDeJuguete();
      const r = await UP.actualizar({ ...base(reg), plataforma: 'azure', modo, azure: AZURE, correr: az.correr, probar: async () => ({ ok: true }) });
      assert.strictEqual(r.resultado, 'aviso', JSON.stringify(r));
      assert.strictEqual(r.desde, '2026.10.15.48'); assert.strictEqual(r.hacia, '2026.10.18.9');
      assert.deepStrictEqual(az.updates(), []);
    }
  } finally { await reg.cerrar(); }
});

test('T14 2.33-Azure_AutoActualizaYPrueba @story-2.33 @ac-10 — automático: update por huella, prueba, actualizado', async () => {
  const reg = await registro();
  try {
    const az = azDeJuguete();
    const pruebas = [];
    const r = await UP.actualizar({ ...base(reg), plataforma: 'azure', modo: 'auto', azure: AZURE, correr: az.correr, probar: async (u) => { pruebas.push(u); return { ok: true }; } });
    assert.strictEqual(r.resultado, 'actualizado', JSON.stringify(r));
    assert.strictEqual(r.desde, '2026.10.15.48'); assert.strictEqual(r.hacia, '2026.10.18.9');
    const ups = az.updates();
    assert.strictEqual(ups.length, 1);
    assert.strictEqual(ups[0][ups[0].indexOf('--image') + 1], `${IMAGEN}@${NUEVA}`, 'por huella, nunca por etiqueta');
    assert.ok(ups[0].includes(AZURE.grupo) && ups[0].includes(AZURE.app));
    assert.deepStrictEqual(pruebas, [AZURE.url], 'la prueba sin sesión contra el sitio');
  } finally { await reg.cerrar(); }
});

test('T15 2.33-Azure_PruebaFallaVuelveAtras @story-2.33 @ac-10 — la prueba en rojo: vuelve a la huella anterior y prueba otra vez', async () => {
  const reg = await registro();
  try {
    const az = azDeJuguete();
    let n = 0;
    const r = await UP.actualizar({ ...base(reg), plataforma: 'azure', modo: 'auto', azure: AZURE, correr: az.correr, probar: async () => { n += 1; return n === 1 ? { ok: false, motivo: 'la prueba sin sesión falló' } : { ok: true }; } });
    assert.strictEqual(r.resultado, 'vuelto_atras', JSON.stringify(r));
    assert.match(r.motivo, /la prueba sin sesión falló/);
    const ups = az.updates();
    assert.strictEqual(ups.length, 2);
    assert.strictEqual(ups[1][ups[1].indexOf('--image') + 1], `${IMAGEN}@${VIEJA}`, 'vuelve a la anterior por huella');
    assert.strictEqual(n, 2, 'prueba otra vez después de volver');
    assert.strictEqual(az.imagen(), `${IMAGEN}@${VIEJA}`);
  } finally { await reg.cerrar(); }
});

test('T16 2.33-Azure_HuellaFallidaNoSeReintenta @story-2.33 @ac-12 — stable igual a la que volvió atrás: no_pudo, sin tocar nada', async () => {
  const reg = await registro();
  try {
    const estadoDir = tmp();
    const az1 = azDeJuguete();
    await UP.actualizar({ ...base(reg, { estadoDir }), plataforma: 'azure', modo: 'auto', azure: AZURE, correr: az1.correr, probar: async () => ({ ok: false, motivo: 'la prueba sin sesión falló' }) });
    const az2 = azDeJuguete();
    const r = await UP.actualizar({ ...base(reg, { estadoDir, ahora: () => T0 + 86400000 }), plataforma: 'azure', modo: 'auto', azure: AZURE, correr: az2.correr, probar: async () => ({ ok: true }) });
    assert.strictEqual(r.resultado, 'no_pudo', JSON.stringify(r));
    assert.match(r.motivo, /ya volvió atrás.*la prueba sin sesión falló/);
    assert.deepStrictEqual(az2.updates(), []);
  } finally { await reg.cerrar(); }
});

test('T17 2.33-NuncaBajaDeVersion @story-2.33 @ac-12 — lo que corre es más nuevo que stable: al_dia, sin tocar', async () => {
  const reg = await registro({ imagenes: { [VIEJA]: '2026.10.19.1', [NUEVA]: '2026.10.18.9' } });
  try {
    const az = azDeJuguete();
    const r = await UP.actualizar({ ...base(reg), plataforma: 'azure', modo: 'auto', azure: AZURE, correr: az.correr, probar: async () => ({ ok: true }) });
    assert.strictEqual(r.resultado, 'al_dia', JSON.stringify(r));
    assert.deepStrictEqual(az.updates(), []);
  } finally { await reg.cerrar(); }
});

/** El hook de Render, de juguete: anota la dirección pedida y contesta `status`. */
async function hookDeJuguete(status = 200) {
  const pedidos = [];
  const srv = http.createServer((req, res) => { pedidos.push({ method: req.method, url: req.url }); res.writeHead(status); res.end('{}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/deploy/srv-acme?key=llave-del-hook-${crypto.randomBytes(4).toString('hex')}`, pedidos, cerrar: () => new Promise((r) => srv.close(r)) };
}

test('T18 2.33-Render_HookPorHuellaSinFiltrar @story-2.33 @ac-13 — el hook con imgURL por huella; la dirección no sale', async () => {
  const reg = await registro();
  const hook = await hookDeJuguete(200);
  try {
    const registroLog = [];
    const r = await UP.actualizar({ ...base(reg, { log: (l) => registroLog.push(l) }), plataforma: 'render', modo: 'auto', render: { hook: hook.url } });
    assert.strictEqual(r.resultado, 'pedido', JSON.stringify(r));
    assert.strictEqual(hook.pedidos.length, 1);
    const u = new URL(hook.pedidos[0].url, 'http://x');
    assert.strictEqual(u.searchParams.get('imgURL'), `${IMAGEN}@${NUEVA}`, 'por huella');
    const salida = `${JSON.stringify(r)}\n${registroLog.join('\n')}`;
    assert.ok(!salida.includes(hook.url) && !salida.includes(new URL(hook.url).searchParams.get('key')), 'la dirección del hook no sale');
  } finally { await reg.cerrar(); await hook.cerrar(); }
});

test('T19 2.33-Render_404YSinSecreto @story-2.33 @ac-13 — 404: Render rechazó la imagen; sin el hook: falta el hook', async () => {
  const reg = await registro();
  const hook = await hookDeJuguete(404);
  try {
    const r = await UP.actualizar({ ...base(reg), plataforma: 'render', modo: 'auto', render: { hook: hook.url } });
    assert.strictEqual(r.resultado, 'no_pudo');
    assert.strictEqual(r.motivo, 'Render rechazó la imagen: tiene que ser del mismo registro y nombre');
    const s = await UP.actualizar({ ...base(reg), plataforma: 'render', modo: 'auto', render: { hook: null } });
    assert.strictEqual(s.resultado, 'no_pudo');
    assert.strictEqual(s.motivo, 'falta el hook de Render');
  } finally { await reg.cerrar(); await hook.cerrar(); }
});

/** Un `docker` de esta prueba: la imagen que corre el servicio y cada `compose` con su SITE_IMAGE. */
function dockerDeJuguete(corre = `${IMAGEN}@${VIEJA}`) {
  const ordenes = [];
  let imagen = corre;
  const correr = (args, opts = {}) => {
    ordenes.push({ args, siteImage: opts.env ? opts.env.SITE_IMAGE : undefined });
    if (args[0] === 'compose' && args.includes('ps')) return { status: 0, stdout: 'id-del-contenedor\n', stderr: '' };
    if (args[0] === 'inspect') return { status: 0, stdout: `${imagen}\n`, stderr: '' };
    if (args[0] === 'compose' && args.includes('up')) { imagen = opts.env.SITE_IMAGE; return { status: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'compose' && args.includes('pull')) return { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: 'orden no prevista' };
  };
  return { ordenes, correr, imagen: () => imagen };
}

test('T20 2.33-Local_ComposeRecreaYVuelveAtras @story-2.33 @ac-14 — compose pull y up -d con SITE_IMAGE; en rojo, la anterior', async () => {
  const reg = await registro();
  try {
    const d = dockerDeJuguete();
    const local = { compose: '/opt/sitio/compose.yaml', url: 'http://127.0.0.1:8080' };
    const ok = await UP.actualizar({ ...base(reg), plataforma: 'local', modo: 'auto', local, correr: d.correr, probar: async () => ({ ok: true }) });
    assert.strictEqual(ok.resultado, 'actualizado', JSON.stringify(ok));
    const pull = d.ordenes.find((o) => o.args.includes('pull'));
    const up = d.ordenes.find((o) => o.args.includes('up'));
    assert.ok(pull && up && up.args.includes('-d'));
    assert.strictEqual(up.siteImage, `${IMAGEN}@${NUEVA}`);
    assert.ok(up.args.includes(local.compose));
    const d2 = dockerDeJuguete();
    const mal = await UP.actualizar({ ...base(reg), plataforma: 'local', modo: 'auto', local, correr: d2.correr, probar: async () => ({ ok: false, motivo: '/livez no contestó' }) });
    assert.strictEqual(mal.resultado, 'vuelto_atras');
    assert.strictEqual(d2.imagen(), `${IMAGEN}@${VIEJA}`);
  } finally { await reg.cerrar(); }
});

test('T21 2.33-Resultado_SinNombres @story-2.33 @ac-9 @ac-10 — el resultado escrito: estado, versiones, hora y motivo', async () => {
  // 🔴 rojo: el resultado (que se guarda en el repo de operaciones y lee el resumen de la mañana) lleva la dirección del
  // sitio, el grupo, la aplicación o el hook.
  const reg = await registro();
  const hook = await hookDeJuguete(404);
  try {
    const estadoDir = tmp();
    const az = azDeJuguete();
    for (const [plataforma, extra] of [['azure', { azure: AZURE, correr: az.correr, probar: async () => ({ ok: false, motivo: 'la prueba sin sesión falló' }) }], ['render', { render: { hook: hook.url } }]]) {
      const r = await UP.actualizar({ ...base(reg, { estadoDir }), plataforma, modo: 'auto', ...extra });
      assert.deepStrictEqual(Object.keys(r).sort(), ['desde', 'hacia', 'hora', 'motivo', 'plataforma', 'resultado', 'version'].sort(), JSON.stringify(r));
      assert.ok(UP.RESULTADOS.includes(r.resultado));
      assert.ok(r.motivo === null || UP.MOTIVOS.some((m) => r.motivo.startsWith(m)), `motivo de la lista: ${r.motivo}`);
    }
    for (const f of fs.readdirSync(estadoDir).filter((x) => x.startsWith('site-update-'))) {
      const t = fs.readFileSync(path.join(estadoDir, f), 'utf8');
      for (const prohibido of [AZURE.url, AZURE.grupo, AZURE.app, hook.url, 'llave-del-hook', IMAGEN]) assert.ok(!t.includes(prohibido), `${f} nombra ${prohibido}`);
    }
  } finally { await reg.cerrar(); await hook.cerrar(); }
});

/** Un `docker` con contenedores: cada uno `{ id, image, env, labels }`; anota cada orden y recrea con SITE_IMAGE. */
function dockerConContenedores(contenedores, { sinDocker = false } = {}) {
  const ordenes = [];
  const correr = (args, opts = {}) => {
    ordenes.push({ args, siteImage: opts.env ? opts.env.SITE_IMAGE : undefined });
    if (sinDocker) return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }) };
    if (args[0] === 'ps') return { status: 0, stdout: `${contenedores.map((c) => c.id).join('\n')}\n`, stderr: '' };
    if (args[0] === 'inspect' && args[2] === '{{json .Config.Labels}}') { const c = contenedores.find((x) => x.id === args[3]); return { status: 0, stdout: JSON.stringify(c.labels), stderr: '' }; }
    if (args[0] === 'inspect' && args[2] === '{{json .Config}}') throw new Error('nunca lee el ambiente de un contenedor');
    if (args[0] === 'inspect' && args[2] === '{{.Config.Image}}' && args[3] !== 'sitio-1') { const c = contenedores.find((x) => x.id === args[3]); return { status: 0, stdout: `${c.image}\n`, stderr: '' }; }
    if (args[0] === 'compose' && args.includes('ps')) return { status: 0, stdout: 'sitio-1\n', stderr: '' };
    if (args[0] === 'inspect') return { status: 0, stdout: `${contenedores[0].image}\n`, stderr: '' };
    if (args[0] === 'compose' && args.includes('up')) { contenedores[0].image = opts.env.SITE_IMAGE; return { status: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'compose') return { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: 'orden no prevista' };
  };
  return { ordenes, correr };
}
const SITIO = (labels) => ({ id: 'sitio-1', image: `${IMAGEN}@${VIEJA}`, env: ['SITE_SESSION_KEY=x', 'PATH=/usr/bin'], labels: { 'tycon.image': 'site', ...labels } });
const COMPOSE_DEL_ARNES = path.join(ROOT, 'scripts', 'site', 'deploy', 'local', 'compose.yaml');

test('T26 2.33-Update_RecreaElSitioDePrueba @story-2.33 @ac-16 — con tycon.site=local: compose pull y up -d con stable; en ensayo, sólo la línea', async () => {
  const reg = await registro();
  try {
    const labels = { 'tycon.site': 'local', 'com.docker.compose.project.config_files': COMPOSE_DEL_ARNES };
    const d = dockerConContenedores([SITIO(labels)]);
    const lineas = await UP.sitioDePrueba({ correr: d.correr, urlRegistro: reg.base, probar: async () => ({ ok: true }) });
    assert.deepStrictEqual(lineas, ['sitio de prueba local: 2026.10.15.48 → 2026.10.18.9']);
    const up = d.ordenes.find((o) => o.args.includes('up'));
    assert.ok(d.ordenes.some((o) => o.args.includes('pull')) && up && up.args.includes(fs.realpathSync(COMPOSE_DEL_ARNES)));
    assert.strictEqual(up.siteImage, `${IMAGEN}@${NUEVA}`);
    const d2 = dockerConContenedores([SITIO(labels)]);
    const ensayo = await UP.sitioDePrueba({ dryRun: true, correr: d2.correr, urlRegistro: reg.base });
    assert.deepStrictEqual(ensayo, ['el sitio de prueba local se pondría al día con stable (docker compose pull y up -d)']);
    assert.ok(!d2.ordenes.some((o) => o.args[0] === 'compose'), 'el ensayo no toca nada');
  } finally { await reg.cerrar(); }
});

test('T27 2.33-Update_NoTocaLoAjeno @story-2.33 @ac-16 — sin la etiqueta, sin docker, sin sitio o con el registro caído', async () => {
  const reg = await registro();
  try {
    const sinEtiqueta = dockerConContenedores([SITIO({})]);
    const l1 = await UP.sitioDePrueba({ correr: sinEtiqueta.correr, urlRegistro: reg.base });
    assert.match(l1[0], /sin la etiqueta tycon\.site=local: .*start\.js/);
    assert.ok(!sinEtiqueta.ordenes.some((o) => o.args[0] === 'compose'), 'no recrea lo que no lanzó el arnés');
    assert.deepStrictEqual(await UP.sitioDePrueba({ correr: dockerConContenedores([], { sinDocker: true }).correr }), [], 'sin docker, nada');
    assert.deepStrictEqual(await UP.sitioDePrueba({ correr: dockerConContenedores([{ id: 'otro', image: 'postgres:16', env: ['PATH=/usr/bin'], labels: {} }]).correr }), [], 'otro contenedor, nada');
    const caido = dockerConContenedores([SITIO({ 'tycon.site': 'local', 'com.docker.compose.project.config_files': COMPOSE_DEL_ARNES })]);
    const l3 = await UP.sitioDePrueba({ correr: caido.correr, urlRegistro: 'http://127.0.0.1:9' });
    assert.deepStrictEqual(l3, ['no se pudo actualizar el sitio de prueba (no se pudo leer stable)']);
    assert.ok(!caido.ordenes.some((o) => o.args.includes('up')));
  } finally { await reg.cerrar(); }
});

test('T30 2.33-Guia_RecetasYTextosNuevos @story-2.33 @ac-15 @ac-21 — la parte común y una receta por entorno, en los dos idiomas', () => {
  // 🔴 rojo: la guía sigue diciendo que el sitio lo actualiza una persona, o una receta falta en uno de los idiomas.
  const leer = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const es = leer('guides/organization-site.md');
  const en = leer('guides/organization-site.en.md');
  const comun = { es: '### Cómo se mantiene al día', en: '### How it keeps itself up to date' };
  assert.ok(es.includes(`\n${comun.es}\n`) && en.includes(`\n${comun.en}\n`), 'la parte común en los dos idiomas');
  const RECETAS = {
    es: ['### Azure Container Apps', '### Render', '### Una máquina propia', '### Kubernetes y otras nubes', '### Una red cerrada'],
    en: ['### Azure Container Apps', '### Render', '### Your own machine', '### Kubernetes and other clouds', '### A closed network'],
  };
  const AL_DIA = { es: '**Al día**:', en: '**Up to date**:' };
  for (const [lado, t] of [['es', es], ['en', en]]) {
    const pos = RECETAS[lado].map((r) => t.indexOf(`\n${r}\n`));
    assert.ok(pos.every((p) => p > 0), `${lado}: las cinco recetas (${pos})`);
    assert.deepStrictEqual([...pos].sort((a, b) => a - b), pos, `${lado}: en el mismo orden`);
    for (let i = 0; i < 3; i++) {
      const tramo = t.slice(pos[i], pos[i + 1]);
      assert.ok(tramo.includes(AL_DIA[lado]), `${lado}: ${RECETAS[lado][i]} dice cómo se mantiene al día`);
    }
    const k8s = t.slice(pos[3], pos[4]);
    assert.match(k8s, lado === 'es' ? /no probada por el arnés/i : /not tested by the harness/i);
    const cerrada = t.slice(pos[4], pos[4] + 1500);
    assert.match(cerrada, lado === 'es' ? /a mano/ : /by hand/, `${lado}: el paso a mano de la red cerrada`);
  }
  assert.match(es, /start\.js --secrets-file [^\n]* --update/, 'el guion del arnés para una máquina propia');
  assert.match(es, /Watchtower/, 'Watchtower, como alternativa');
  assert.match(es, /Microsoft\.App\/containerApps\/read/, 'el rol propio de Azure');
  for (const f of ['scripts/site/deploy/local/compose.yaml', 'scripts/site/deploy/render.yaml', 'guides/organization-site.md']) {
    assert.doesNotMatch(leer(f), /la actualiza una\s+persona/, `${f}: queda el texto de la 2.30`);
  }
});

// ── una prueba por cada hallazgo de los revisores y del pase adversarial ─────────────────────────────────────
const LR = require(path.join(ROOT, 'scripts', 'site', 'latest-release.js'));

test('A1 2.33-Adv_RegistroConPuerto @story-2.33 @ac-8 @ac-10 — un registro con puerto no se lee como Docker Hub ni pierde el puerto', async () => {
  // 🔴 rojo: `registro:5000/org/sitio` se corta en el primer «:» y el actualizador consulta e instala otra imagen.
  assert.deepStrictEqual(LR.partirImagen('registro.acme.example:5000/org/sitio:1.2'), { host: 'registro.acme.example:5000', repo: 'org/sitio' });
  assert.strictEqual(LR.nombreSinEtiqueta(`localhost:5000/sitio@${NUEVA}`), 'localhost:5000/sitio');
  assert.strictEqual(LR.partirImagen('ghcr.io/Acme/../x'), null, 'un nombre sin forma de imagen no se consulta');
  const reg = await registro();
  try {
    const az = azDeJuguete('localhost:5000/sitio@' + VIEJA);
    const r = await UP.actualizar({ ...base(reg), imagen: 'localhost:5000/sitio', plataforma: 'azure', modo: 'auto', azure: AZURE, correr: az.correr, probar: async () => ({ ok: true }) });
    assert.strictEqual(r.resultado, 'actualizado', JSON.stringify(r));
    assert.strictEqual(az.imagen(), `localhost:5000/sitio@${NUEVA}`, 'el puerto queda en la imagen instalada');
  } finally { await reg.cerrar(); }
});

test('A2 2.33-Adv_VersionesIncomparables @story-2.33 @ac-12 — versiones que no se pueden ordenar: no_pudo, nunca «al día»', async () => {
  const reg = await registro({ imagenes: { [VIEJA]: 'v-raro', [NUEVA]: '2026.10.18.9' } });
  try {
    const az = azDeJuguete();
    const r = await UP.actualizar({ ...base(reg), plataforma: 'azure', modo: 'auto', azure: AZURE, correr: az.correr, probar: async () => ({ ok: true }) });
    assert.strictEqual(r.resultado, 'no_pudo', JSON.stringify(r));
    assert.strictEqual(r.motivo, 'no se pudieron comparar las versiones');
    assert.deepStrictEqual(az.updates(), []);
  } finally { await reg.cerrar(); }
});

test('A3 2.33-Adv_DosCorridasALaVez @story-2.33 @ac-12 — si otra ejecución cambió la imagen en el medio, ésta no toca nada', async () => {
  // 🔴 rojo: una corrida vieja instala su stable sobre una versión más nueva que otra acaba de poner.
  const reg = await registro();
  try {
    const az = azDeJuguete();
    let lecturas = 0;
    const correr = (args) => {
      if (args[1] === 'show') { lecturas += 1; return { status: 0, stdout: `${IMAGEN}@${lecturas === 1 ? VIEJA : huella('e')}\n`, stderr: '' }; }
      return az.correr(args);
    };
    const r = await UP.actualizar({ ...base(reg), plataforma: 'azure', modo: 'auto', azure: AZURE, correr, probar: async () => ({ ok: true }) });
    assert.strictEqual(r.resultado, 'no_pudo', JSON.stringify(r));
    assert.strictEqual(r.motivo, 'la imagen que corre cambió durante la ejecución');
    assert.deepStrictEqual(az.updates(), []);
  } finally { await reg.cerrar(); }
});

test('A4 2.33-Rev_404QueNoEsLaEtiqueta @story-2.33 @ac-5 — un 404 de la configuración no es «no hay stable»', async () => {
  // 🔴 rojo: un 404 pasajero de la configuración se lee como «sin etiqueta» y stable se «crea» sin comparar (podría bajar).
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/token')) { res.writeHead(200); res.end('{"token":"anonimo"}'); return; }
    if (/\/manifests\/stable$/.test(req.url)) { res.writeHead(200, { 'docker-content-digest': NUEVA }); res.end(JSON.stringify({ schemaVersion: 2, config: { digest: huella('f') } })); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  try {
    const r = await LR.consultar({ imagen: IMAGEN, urlBase: `http://127.0.0.1:${srv.address().port}` });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.codigo, 'ilegible', 'no «sin_etiqueta»');
  } finally { await new Promise((ok) => srv.close(ok)); }
});

test('A5 2.33-Rev_ModoIlegibleNoEsAviso @story-2.33 @ac-17 — un site.update que no vale o un operations.json ilegible: no_pudo', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'a.json'), '{"site":{"update":"Auto"}}');
  fs.writeFileSync(path.join(d, 'b.json'), 'no es json');
  fs.writeFileSync(path.join(d, 'c.json'), '{"site":{}}');
  assert.strictEqual(UP.modoDe(path.join(d, 'a.json')), null);
  assert.strictEqual(UP.modoDe(path.join(d, 'b.json')), null);
  assert.strictEqual(UP.modoDe(path.join(d, 'c.json')), 'notice', 'sin la clave, sólo aviso (por contrato)');
  const reg = await registro();
  try {
    const r = await UP.actualizar({ ...base(reg), plataforma: 'azure', modo: null, azure: AZURE, correr: azDeJuguete().correr });
    assert.strictEqual(r.resultado, 'no_pudo');
    assert.strictEqual(r.motivo, 'no se pudo leer site.update');
  } finally { await reg.cerrar(); }
});

test('A6 2.33-Rev_SinLaVersionQueCorreNoInstala @story-2.33 @ac-12 — sin saber qué corre, en automático no instala', async () => {
  const reg = await registro({ imagenes: { [NUEVA]: '2026.10.18.9' } });
  try {
    const az = azDeJuguete();
    const r = await UP.actualizar({ ...base(reg), plataforma: 'azure', modo: 'auto', azure: AZURE, correr: az.correr, probar: async () => ({ ok: true }) });
    assert.strictEqual(r.resultado, 'no_pudo', JSON.stringify(r));
    // lo que no se sabe es la VERSIÓN de la imagen que corre (una imagen de antes de que la imagen trajera su versión):
    // el motivo lo dice y dice cómo salir
    assert.strictEqual(r.motivo, 'no se sabe qué versión corre: la imagen que corre no trae su versión en el registro; la primera actualización va a mano');
    assert.deepStrictEqual(az.updates(), []);
  } finally { await reg.cerrar(); }
});

test('A7 2.33-Rev_CambioAMedias @story-2.33 @ac-12 @ac-14 — el cambio falla a medias: vuelve a la anterior y no reintenta', async () => {
  const reg = await registro();
  try {
    const estadoDir = tmp();
    const d = dockerDeJuguete();
    const correr = (args, opts) => (args.includes('up') && opts && opts.env && opts.env.SITE_IMAGE.endsWith(NUEVA) ? { status: 1, stdout: '', stderr: 'error del demonio en /opt/secreto/acme' } : d.correr(args, opts));
    const r = await UP.actualizar({ ...base(reg, { estadoDir }), plataforma: 'local', modo: 'auto', local: { compose: '/opt/sitio/compose.yaml' }, correr, probar: async () => ({ ok: true }) });
    assert.strictEqual(r.resultado, 'no_pudo', JSON.stringify(r));
    assert.ok(d.ordenes.some((o) => o.args.includes('up') && o.siteImage === `${IMAGEN}@${VIEJA}`), 'intentó volver a la anterior');
    const otra = await UP.actualizar({ ...base(reg, { estadoDir }), plataforma: 'local', modo: 'auto', local: { compose: '/opt/sitio/compose.yaml' }, correr: dockerDeJuguete().correr, probar: async () => ({ ok: true }) });
    assert.strictEqual(otra.resultado, 'no_pudo');
    assert.match(otra.motivo, /^la huella de stable ya volvió atrás/);
    // y el texto de docker (que puede nombrar rutas o recursos) no llega al resultado guardado
    for (const f of fs.readdirSync(estadoDir)) assert.ok(!fs.readFileSync(path.join(estadoDir, f), 'utf8').includes('/opt/secreto/acme'), `${f} trae la salida de docker`);
  } finally { await reg.cerrar(); }
});

test('A8 2.33-Rev_ComposeAjenoNoSeCorre @story-2.33 @ac-16 — un contenedor con la etiqueta pero de otro compose: no se toca', async () => {
  // 🔴 rojo: un contenedor ajeno con las etiquetas hace que harness.js update corra el compose que elija.
  const reg = await registro();
  try {
    const d = dockerConContenedores([SITIO({ 'tycon.site': 'local', 'com.docker.compose.project.config_files': '/tmp/compose-ajeno.yaml' })]);
    const l = await UP.sitioDePrueba({ correr: d.correr, urlRegistro: reg.base, probar: async () => ({ ok: true }) });
    assert.match(l[0], /no salió del compose\.yaml de este arnés/);
    assert.ok(!d.ordenes.some((o) => o.args[0] === 'compose'));
  } finally { await reg.cerrar(); }
});

test('A9 2.33-Rev_RenderSeProbaraAlOtroDia @story-2.33 @ac-13 — lo pedido a Render se prueba la noche siguiente; si falla, no es «al día»', async () => {
  const reg = await registro();
  const hook = await hookDeJuguete(200);
  try {
    const estadoDir = tmp();
    await UP.actualizar({ ...base(reg, { estadoDir }), plataforma: 'render', modo: 'auto', render: { hook: hook.url } });
    const r = await UP.actualizar({ ...base(reg, { estadoDir }), plataforma: 'render', modo: 'auto', render: { hook: hook.url, url: 'https://sitio.acme.example' }, probar: async () => ({ ok: false }) });
    assert.strictEqual(r.resultado, 'no_pudo', JSON.stringify(r));
    assert.strictEqual(r.motivo, 'la prueba sin sesión falló');
    // un hook por http (no local) no se llama: lleva su llave en la dirección
    const s = await UP.actualizar({ ...base(reg, { estadoDir: tmp() }), plataforma: 'render', modo: 'auto', render: { hook: 'http://render.example/deploy/x?key=y' } });
    assert.strictEqual(s.motivo, 'falta el hook de Render');
  } finally { await reg.cerrar(); await hook.cerrar(); }
});

test('A10 2.33-Rev_StartUpdatePideLaImagen @story-2.33 @ac-14 — start.js --update sin --image no usa el ejemplo de compose.yaml', () => {
  const d = tmp();
  const env = path.join(d, 'sitio.env');
  fs.writeFileSync(env, 'SITE_SESSION_KEY=x\n', { mode: 0o600 });
  const r = require('child_process').spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'site', 'deploy', 'local', 'start.js'), '--secrets-file', env, '--update', '--dry-run'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /--update necesita --image/);
});

test('A11 2.33-Rev_EstadoIlegibleNoSePisa @story-2.33 @ac-12 — el estado corrupto: no_pudo, sin tocar nada y sin pisarlo', async () => {
  // 🔴 rojo: con el estado corrupto se olvidan las huellas que volvieron atrás y se reintenta una mala.
  const reg = await registro();
  try {
    const estadoDir = tmp();
    fs.writeFileSync(path.join(estadoDir, 'site-update-estado.json'), '{ esto no es JSON');
    const az = azDeJuguete();
    const r = await UP.actualizar({ ...base(reg, { estadoDir }), plataforma: 'azure', modo: 'auto', azure: AZURE, correr: az.correr, probar: async () => ({ ok: true }) });
    assert.strictEqual(r.resultado, 'no_pudo');
    assert.strictEqual(r.motivo, 'no se pudo leer el estado del actualizador');
    assert.deepStrictEqual(az.updates(), []);
    assert.strictEqual(fs.readFileSync(path.join(estadoDir, 'site-update-estado.json'), 'utf8'), '{ esto no es JSON', 'no se pisó');
  } finally { await reg.cerrar(); }
});

test('A12 2.33-Rev_PruebaLaRevisionNueva @story-2.33 @ac-10 @ac-12 — prueba recién cuando la revisión nueva sirve todo; si no llega, vuelve atrás', async () => {
  // 🔴 rojo (medido en un laboratorio real): la prueba sin sesión le pegó a la revisión vieja, todavía con el tráfico,
  //    y el actualizador dijo «actualizado» con una imagen que no pasaba la prueba.
  const reg = await registro();
  try {
    const espera = { cadaMs: 0, plazoMs: 50, dormir: async () => {} };
    // tarda dos preguntas en quedar lista: la prueba corre recién cuando la nueva sirve, y contra la nueva
    const az = azDeJuguete(undefined, { listaTras: 2 });
    const vistas = [];
    const r = await UP.actualizar({ ...base(reg), plataforma: 'azure', modo: 'auto', azure: { ...AZURE, espera }, correr: az.correr, probar: async () => { vistas.push(az.sirve()); return { ok: true }; } });
    assert.strictEqual(r.resultado, 'actualizado', JSON.stringify(r));
    assert.deepStrictEqual(vistas, [`${IMAGEN}@${NUEVA}`], 'la prueba ve la imagen nueva');

    // nunca queda lista: cuenta como prueba fallida, vuelve a la anterior y no se reintenta
    const lenta = azDeJuguete(undefined, { listaTras: Infinity });
    let probadas = 0;
    const estadoDir = tmp();
    const r2 = await UP.actualizar({ ...base(reg, { estadoDir }), plataforma: 'azure', modo: 'auto', azure: { ...AZURE, espera }, correr: lenta.correr, probar: async () => { probadas += 1; return { ok: true }; } });
    assert.strictEqual(r2.resultado, 'vuelto_atras', JSON.stringify(r2));
    assert.match(r2.motivo, /^la prueba sin sesión falló \(la revisión nueva no quedó lista/);
    assert.strictEqual(lenta.imagen(), `${IMAGEN}@${VIEJA}`, 'vuelve a la anterior por huella');
    assert.strictEqual(probadas, 1, 'sólo se prueba la anterior, ya de vuelta');
    const est = JSON.parse(fs.readFileSync(path.join(estadoDir, 'site-update-estado.json'), 'utf8'));
    assert.ok(est.fallidas[NUEVA], 'la huella nueva queda anotada');
  } finally { await reg.cerrar(); }
});

/** Un sitio de juguete: `/livez` con `demo` y la portada con o sin la franja. `vida: null` no contesta `/livez`. */
async function sitioDeJuguete({ vida = { ok: true, demo: true }, franja = true } = {}) {
  const srv = http.createServer((req, res) => {
    if (req.url === '/livez' && vida) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(vida)); return; }
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<html><body${franja ? ' class="demo"><div class="franja-demo" role="note">' : '>'}acme</body></html>`); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${srv.address().port}`, cerrar: () => new Promise((ok) => srv.close(ok)) };
}

test('D1 SitioDemo_PruebaPropia — el demo pasa con /livez en demo y la franja; un sitio real o sin franja, no', async () => {
  const casos = [
    [{}, true, null],
    [{ vida: { ok: true, demo: false } }, false, /no está en modo demo/],
    [{ vida: { ok: true } }, false, /no está en modo demo/],
    [{ franja: false }, false, /no trae la franja/],
    [{ vida: null }, false, /\/livez no contestó/],
  ];
  for (const [forma, pasa, motivo] of casos) {
    const s = await sitioDeJuguete(forma);
    try {
      const r = await UP.probarDemo({ espera: 0, pausa: 1 })(`${s.url}/`);
      assert.strictEqual(r.ok, pasa, `${JSON.stringify(forma)}: ${JSON.stringify(r)}`);
      if (motivo) {
        assert.match(r.motivo, /^la prueba sin sesión falló \(/, 'el motivo sigue la lista cerrada');
        assert.match(r.motivo, motivo);
      }
    } finally { await s.cerrar(); }
  }
});

test('D2 SitioDemo_ActualizaConSuPrueba — con demo, la prueba es la del demo: actualiza el demo y vuelve atrás en un sitio real', async () => {
  const reg = await registro();
  try {
    const demo = await sitioDeJuguete();
    try {
      const az = azDeJuguete();
      const r = await UP.actualizar({ ...base(reg), plataforma: 'azure', modo: 'auto', demo: true, azure: { ...AZURE, url: demo.url }, correr: az.correr });
      assert.strictEqual(r.resultado, 'actualizado', JSON.stringify(r));
      assert.strictEqual(az.imagen(), `${IMAGEN}@${NUEVA}`);
    } finally { await demo.cerrar(); }
    const real = await sitioDeJuguete({ vida: { ok: true, demo: false }, franja: false });
    try {
      const az = azDeJuguete();
      const r = await UP.actualizar({ ...base(reg), plataforma: 'azure', modo: 'auto', demo: true, azure: { ...AZURE, url: real.url }, correr: az.correr });
      assert.strictEqual(r.resultado, 'vuelto_atras', JSON.stringify(r));
      assert.match(r.motivo, /no está en modo demo/);
      assert.strictEqual(az.imagen(), `${IMAGEN}@${VIEJA}`);
    } finally { await real.cerrar(); }
  } finally { await reg.cerrar(); }
});
