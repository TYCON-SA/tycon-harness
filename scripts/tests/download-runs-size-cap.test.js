'use strict';
// download-runs-size-cap.test.js — la bajada del buzón mira el tamaño de cada archivo antes de pedirlo (A38).
//
// La llave de las máquinas sólo crea, pero crea lo que quiera: un volcado, un cambio de git o un registro de 5 GB se
// pedía entero y se juntaba en memoria. Ahora cada archivo tiene un tope por tipo, el mismo con el que después se abre
// (lo que pasa ese tope no se podría leer nunca), y el pedido se corta si el cuerpo trae más de lo que dijo el listado.
// Sin red salvo un servidor local: el almacén es falso y todo pasa en una carpeta temporal.
// stable-data: T60a lee el reloj sólo para medir cuánto dura una pasada, nunca como fecha.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const B = require('../metrics/download-runs.js');
const ch = require('../nightly/dashboard/changes.js');

const MAQ = 'maq-prueba-0a1b2c3d';
const GB5 = 5 * 1024 * 1024 * 1024;

function carpeta(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tope-bajada-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** Un almacén falso: los nombres de `grandes` dicen pesar 5 GB; `chicos` traen su cuerpo. Anota lo que se pide. */
function almacen(grandes, chicos = {}) {
  const pedidos = [];
  const blob = (n, largo, md5) => ({ nombre: `${MAQ}/${n}`, largo, md5, etag: 'x', creado: Date.parse('2026-11-20T10:00:00Z'), modificado: Date.parse('2026-11-20T10:00:00Z') });
  const lista = [
    ...grandes.map((n) => blob(n, GB5, 'AAAAAAAAAAAAAAAAAAAAAA==')),
    ...Object.entries(chicos).map(([n, c]) => blob(n, c.length, crypto.createHash('md5').update(c).digest('base64'))),
  ];
  const lista_ = {
    pedidos,
    destino: 'falso/buzon',
    listar: async () => ({ blobs: lista }),
    topes: {},
    leer: async (nombre, _ms, maxBytes) => {
      const corto = nombre.split('/').slice(1).join('/');
      pedidos.push(corto);
      lista_.topes[corto] = maxBytes;
      if (chicos[corto]) return { status: 200, cuerpo: chicos[corto], cabeceras: {} };
      return { status: 404, cuerpo: Buffer.alloc(0), cabeceras: {} };
    },
  };
  return lista_;
}

const GRANDES = ['1.1-2026-11-20T1010.json', '1.1-2026-11-20T1010.cambio.json.gz', '1.2-2026-11-20T1110.json', '1.2-2026-11-20T1110.hilo.jsonl.gz', 'registros/gates.log.gz'];

test('T38a Bajada_ArchivosQuePasanSuTope_NoSePiden_YLosChicosSi', async (t) => {
  const dir = path.join(carpeta(t), 'buzon');
  const chico = Buffer.from(JSON.stringify({ story: '2.1' }));
  const a = almacen(GRANDES, { '2.1-2026-11-20T1210.json': chico });
  // el camino de una máquina: sin topes de afuera
  const { res } = await B.bajar({ almacen: a, dir, budgetMs: 20000, log: () => {} });
  assert.deepStrictEqual(a.pedidos, ['2.1-2026-11-20T1210.json'], `se pidieron: ${a.pedidos.join(', ')}`);
  assert.strictEqual(res.grandes, GRANDES.length);
  assert.ok(res.grandes_nombres.some((n) => /gates\.log\.gz.*tope/.test(n)), res.grandes_nombres.join(' | '));
  assert.ok(fs.existsSync(path.join(dir, MAQ, '2.1-2026-11-20T1210.json')));
});

test('T38b Bajada_DelSitio_TampocoPideLoQuePasaSuTope', async (t) => {
  const dir = path.join(carpeta(t), 'buzon');
  const a = almacen(GRANDES);
  await B.bajar({ almacen: a, dir, budgetMs: 20000, log: () => {}, resumenes: true, topeBytesHilos: 300 * 1048576, hiloTopeBytes: 50 * 1048576 });
  assert.deepStrictEqual(a.pedidos, [], `se pidieron: ${a.pedidos.join(', ')}`);
});

test('T38c DetalleADemanda_ConversacionQuePasaSuTope_NoSePide', async (t) => {
  const dir = carpeta(t);
  const a = almacen(['1.2-2026-11-20T1110.hilo.jsonl.gz', '1.2-2026-11-20T1110.cambio.json.gz']);
  const { codigo, res } = await B.bajarUnaCorrida({ almacen: a, dir, maquina: MAQ, base: '1.2-2026-11-20T1110' });
  assert.deepStrictEqual(a.pedidos, []);
  assert.strictEqual(codigo, 1);
  assert.strictEqual(res.estado, 'grande');
  assert.match(res.motivo, /tope/);
});

test('T38d Pedido_CuerpoMasLargoQueElListado_SeCortaSinJuntarlo', async (t) => {
  const MB = 1024 * 1024;
  const srv = http.createServer((req, res) => {
    res.writeHead(200);   // sin Content-Length: el corte tiene que salir de contar lo que llega
    let n = 0;
    const uno = Buffer.alloc(64 * 1024, 0x61);
    const escribir = () => { while (n < 64) { n += 1; if (!res.write(uno)) { res.once('drain', escribir); return; } } res.end(); };
    escribir();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const r = await B.pedir(`http://127.0.0.1:${srv.address().port}/x`, { sas: 'sv=1' }, 10000, MB);
  assert.strictEqual(r.cortado, true);
  assert.ok(r.cuerpo.length <= MB + 64 * 1024, `juntó ${r.cuerpo.length} bytes`);
});

test('T38e Topes_SonLosMismosConLosQueSeAbre', () => {
  assert.strictEqual(B.topeDeBajada('1.1-2026-11-20T1010.hilo.jsonl.gz'), ch.TOPE_HILO_DESCOMPRIMIDO);
  for (const n of ['1.1-2026-11-20T1010.cambio.json.gz', '1.1-2026-11-20T1010.json', 'registros/gates.log.gz', 'registros/cobertura.json']) {
    assert.strictEqual(B.topeDeBajada(n), ch.TOPE_JSON_DESCOMPRIMIDO, n);
  }
});

test('T38f DetalleADemanda_ConElTopeDelSitio_NoPideUnaConversacionDeMas', async (t) => {
  const dir = carpeta(t);
  const MB = 1024 * 1024;
  const cuerpo = Buffer.alloc(2 * MB, 0x61);
  const a = almacen([], { '1.3-2026-11-20T1310.hilo.jsonl.gz': cuerpo });
  const { res } = await B.bajarUnaCorrida({ almacen: a, dir, maquina: MAQ, base: '1.3-2026-11-20T1310', hiloTopeBytes: MB });
  assert.deepStrictEqual(a.pedidos, []);
  assert.strictEqual(res.estado, 'grande');
  // sin el tope del sitio, la misma conversación baja
  const otra = await B.bajarUnaCorrida({ almacen: a, dir, maquina: MAQ, base: '1.3-2026-11-20T1310' });
  assert.strictEqual(otra.res.estado, 'bajado');
});

test('T38g SitioYConectores_PasanElTopeAlDetalle', () => {
  // el camino de producción: sources.js le pasa su tope a la nube, y las dos nubes se lo pasan a la bajada
  const leer = (r) => fs.readFileSync(path.join(__dirname, '..', '..', r), 'utf8');
  assert.match(leer('scripts/site/sources.js'), /bajarUnaCorrida\(\{[^}]*hiloTopeBytes: topeConversacionBytes \}\)/);
  assert.match(leer('scripts/site/cloud/azure.js'), /bajarUnaCorrida\(\{[^}]*hiloTopeBytes \}\)/);
  assert.match(leer('integrations/gcs/scripts/mailbox.js'), /bajarUnaCorrida\(\{ almacen: p\.almacen, maquina, base, dir, hiloTopeBytes \}\)/);
});

test('T38h CadaPedido_LlevaElLargoDelListado_Y_ElCuerpoCortadoNoSeEscribe', async (t) => {
  // el corte del cuerpo tiene que llegar a `leer` desde la pasada, la cobertura y el detalle: sin el largo, un objeto que
  // sirve más de lo listado se juntaba entero
  const dir = path.join(carpeta(t), 'buzon');
  const volcado = Buffer.from(JSON.stringify({ story: '2.1' }));
  const cob = Buffer.from(JSON.stringify({ fuentes: {} }));
  const a = almacen([], { '2.1-2026-11-20T1210.json': volcado, 'registros/cobertura.json': cob });
  await B.bajar({ almacen: a, dir, budgetMs: 20000, log: () => {} });
  assert.strictEqual(a.topes['2.1-2026-11-20T1210.json'], volcado.length, 'la pasada');
  assert.strictEqual(a.topes['registros/cobertura.json'], cob.length, 'la cobertura');
  // la cobertura de un juego con versión se pide aparte, para saber si el juego está completo
  const v = almacen([], { 'registros/v20261121T000000000Z/cobertura.json': cob });
  await B.bajar({ almacen: v, dir: path.join(carpeta(t), 'buzon'), budgetMs: 20000, log: () => {} });
  assert.strictEqual(v.topes['registros/v20261121T000000000Z/cobertura.json'], cob.length, 'la cobertura de un juego con versión');
  const cambio = Buffer.from('x');
  const d = almacen([], { '3.1-2026-11-20T1310.cambio.json.gz': cambio });
  await B.bajarUnaCorrida({ almacen: d, dir: carpeta(t), maquina: MAQ, base: '3.1-2026-11-20T1310' });
  assert.strictEqual(d.topes['3.1-2026-11-20T1310.cambio.json.gz'], cambio.length, 'el detalle');
  // un cuerpo cortado no se escribe en el espejo y la pasada no queda entera
  const c = almacen([], { '4.1-2026-11-20T1410.json': volcado });
  c.leer = async () => ({ status: 200, cuerpo: volcado, cabeceras: {}, cortado: true });
  const dir2 = path.join(carpeta(t), 'buzon');
  const r = await B.bajar({ almacen: c, dir: dir2, budgetMs: 20000, log: () => {} });
  assert.ok(!fs.existsSync(path.join(dir2, MAQ, '4.1-2026-11-20T1410.json')), 'no se escribió');
  assert.strictEqual(r.res.completo, false);
});

test('T38i DetalleADemanda_UnaVersionNuevaEnorme_UsaLaAnterior', async (t) => {
  // una versión nueva y enorme del cambio, subida con la llave de sólo crear, no le saca el detalle a la ejecución
  const cambio = Buffer.from('x');
  const md5 = crypto.createHash('md5').update(cambio).digest('base64');
  const base = '5.1-2026-11-20T1510';
  const pedidos = [];
  const a = {
    destino: 'falso/buzon',
    listar: async () => ({ blobs: [
      { nombre: `${MAQ}/${base}.cambio.json.gz`, largo: cambio.length, md5, etag: 'a' },
      { nombre: `${MAQ}/v20261121T000000000Z/${base}.cambio.json.gz`, largo: GB5, md5: 'AAAAAAAAAAAAAAAAAAAAAA==', etag: 'b' },
    ] }),
    leer: async (nombre) => { pedidos.push(nombre); return { status: 200, cuerpo: cambio, cabeceras: {} }; },
  };
  const { res } = await B.bajarUnaCorrida({ almacen: a, dir: carpeta(t), maquina: MAQ, base });
  assert.deepStrictEqual(pedidos, [`${MAQ}/${base}.cambio.json.gz`]);
  assert.strictEqual(res.estado, 'bajado');
});

/** Un almacén falso que anota cuántos bytes del listado se están pidiendo a la vez. Cada pedido tarda `ms`. */
function almacenQueMideLoQueVuela(archivos, ms = 30) {
  const lista = archivos.map(([n, largo]) => ({ nombre: `${MAQ}/${n}`, largo, md5: 'AAAAAAAAAAAAAAAAAAAAAA==', etag: 'x' }));
  const a = { destino: 'falso/buzon', enVuelo: 0, pico: 0, pedidos: 0, listar: async () => ({ blobs: lista }) };
  a.leer = async (nombre) => {
    const largo = lista.find((b) => b.nombre === nombre).largo;
    a.pedidos += 1;
    a.enVuelo += largo; a.pico = Math.max(a.pico, a.enVuelo);
    await new Promise((r) => setTimeout(r, ms));
    a.enVuelo -= largo;
    // sin juntar el cuerpo de verdad: el corte lo deja como «no bajado», que alcanza para medir lo que se pidió
    return { status: 200, cuerpo: Buffer.alloc(0), cabeceras: {}, cortado: true };
  };
  return a;
}

test('T44a Bajada_LoQueSePideALaVez_TieneUnTopeEnBytes_NoSoloEnArchivos', async (t) => {
  // ocho archivos de 60 MB, cada uno debajo de su tope: de a 8 eran 480 MB juntándose a la vez fuera del techo del hilo
  const MB = 1024 * 1024;
  const archivos = Array.from({ length: 8 }, (_, i) => [`${i + 1}.1-2026-11-20T10${10 + i}.hilo.jsonl.gz`, 60 * MB]);
  const a = almacenQueMideLoQueVuela(archivos);
  await B.bajar({ almacen: a, dir: path.join(carpeta(t), 'buzon'), budgetMs: 20000, log: () => {} });
  assert.strictEqual(a.pedidos, 8, 'se piden todos');
  assert.ok(a.pico <= B.TOPE_EN_VUELO, `se pidieron ${Math.round(a.pico / MB)} MB a la vez (tope ${Math.round(B.TOPE_EN_VUELO / MB)} MB)`);
  assert.ok(B.TOPE_EN_VUELO <= 128 * MB, 'el tope de lo que vuela a la vez no pasa de 128 MB');
});

test('T44b Bajada_UnArchivoMasGrandeQueElTopeEnVuelo_BajaSolo_YLosChicosSiguenEnParalelo', async (t) => {
  // el tope no deja a nadie afuera: uno que solo lo pasa (una conversación de una máquina) se pide cuando no vuela nada
  const MB = 1024 * 1024;
  const archivos = [['1.1-2026-11-20T1010.hilo.jsonl.gz', 200 * MB], ...Array.from({ length: 6 }, (_, i) => [`${i + 2}.1-2026-11-20T1110.json`, 1000])];
  const a = almacenQueMideLoQueVuela(archivos);
  await B.bajar({ almacen: a, dir: path.join(carpeta(t), 'buzon'), budgetMs: 20000, log: () => {} });
  assert.strictEqual(a.pedidos, 7);
  assert.strictEqual(a.pico, 200 * MB, 'el grande se pidió solo');
  // con el tope chico por opción, los chicos van de a varios: el tope no apaga el paralelo
  const b = almacenQueMideLoQueVuela(Array.from({ length: 8 }, (_, i) => [`${i + 2}.1-2026-11-20T1110.json`, 1000]));
  await B.bajar({ almacen: b, dir: path.join(carpeta(t), 'buzon'), budgetMs: 20000, log: () => {}, topeEnVueloBytes: 3000 });
  assert.strictEqual(b.pico, 3000, 'tres a la vez, no ocho ni uno');
});

/** Un almacén falso con largos a mano: `{ nombre: largo }` para los que dicen pesar de más, `{ nombre: Buffer }` para los chicos. */
function almacenMixto(archivos) {
  const pedidos = [];
  const lista = Object.entries(archivos).map(([n, c]) => (Buffer.isBuffer(c)
    ? { nombre: `${MAQ}/${n}`, largo: c.length, md5: crypto.createHash('md5').update(c).digest('base64'), etag: 'x' }
    : { nombre: `${MAQ}/${n}`, largo: c, md5: 'AAAAAAAAAAAAAAAAAAAAAA==', etag: 'x' }));
  return {
    pedidos,
    destino: 'falso/buzon',
    listar: async () => ({ blobs: lista }),
    leer: async (nombre) => {
      const corto = nombre.split('/').slice(1).join('/');
      pedidos.push(corto);
      const c = archivos[corto];
      return Buffer.isBuffer(c) ? { status: 200, cuerpo: c, cabeceras: {} } : { status: 404, cuerpo: Buffer.alloc(0), cabeceras: {} };
    },
  };
}
const cobertura = (fuentes) => Buffer.from(JSON.stringify({ fuentes: Object.fromEntries(fuentes.map((f) => [f, { estado: 'medido' }])) }));

test('T45a Bajada_LoQuePasaSuTope_SeNombraAparte_NoComoSinForma', async (t) => {
  // lo salteado por tamaño no es «no tiene forma»: va a su propia lista, el registro lo dice con su motivo, y el sitio lo
  // puede mostrar (antes quedaba en `ignorados`, con la frase de los nombres sin forma)
  const lineas = [];
  const a = almacen(GRANDES, { '2.1-2026-11-20T1210.json': Buffer.from('{}') });
  const { res } = await B.bajar({ almacen: a, dir: path.join(carpeta(t), 'buzon'), budgetMs: 20000, log: (l) => lineas.push(l) });
  assert.strictEqual(res.grandes, GRANDES.length);
  assert.strictEqual(res.ignorados, 0, `ignorados: ${res.ignorados_nombres.join(' | ')}`);
  assert.strictEqual(res.grandes_nombres.length, GRANDES.length);
  assert.ok(res.grandes_nombres.some((n) => /gates\.log\.gz.*tope/.test(n)), res.grandes_nombres.join(' | '));
  assert.ok(lineas.some((l) => /pasan? (su|el) tope de bajada/.test(l)), lineas.join('\n'));
  assert.ok(!lineas.some((l) => /no tienen forma/.test(l)), lineas.join('\n'));
});

test('T45b Bajada_JuegoSinVersion_ConUnRegistroEnorme_NoBajaUnaCoberturaQueLoDaPorMedido', async (t) => {
  // la cobertura nueva diría «medido» de un registro que no se bajó: queda la anterior (o ninguna), y se dice
  const dir = path.join(carpeta(t), 'buzon');
  const a = almacenMixto({ 'registros/gates.log.gz': GB5, 'registros/bypass.log.gz': Buffer.from('x'), 'registros/cobertura.json': cobertura(['gates', 'bypass']) });
  const { codigo, res } = await B.bajar({ almacen: a, dir, budgetMs: 20000, log: () => {} });
  assert.ok(!fs.existsSync(path.join(dir, MAQ, 'registros', 'cobertura.json')), 'no se escribió');
  assert.ok(fs.existsSync(path.join(dir, MAQ, 'registros', 'bypass.log.gz')), 'el registro chico sí baja');
  assert.strictEqual(codigo, 0, 'no queda «parcial» para siempre por un archivo que nunca va a bajar');
  assert.ok(res.grandes_nombres.some((n) => /cobertura/.test(n)), res.grandes_nombres.join(' | '));
});

test('T45c Bajada_JuegoNuevoConUnRegistroEnorme_UsaElAnterior_SinPedirSuCobertura_YLoDice', async (t) => {
  const V2 = 'v20261121T000000000Z';
  const a = almacenMixto({
    'registros/gates.log.gz': Buffer.from('viejo'), 'registros/cobertura.json': cobertura(['gates']),
    [`registros/${V2}/gates.log.gz`]: GB5, [`registros/${V2}/cobertura.json`]: cobertura(['gates']),
  });
  const dir = path.join(carpeta(t), 'buzon');
  for (const pasada of [1, 2]) {
    a.pedidos.length = 0;
    const { res } = await B.bajar({ almacen: a, dir, budgetMs: 20000, log: () => {} });
    // la primera la lee para saber si declara el registro enorme; desde ahí queda anotado por su huella
    if (pasada === 2) assert.ok(!a.pedidos.includes(`registros/${V2}/cobertura.json`), 'pasada 2: se volvió a pedir la cobertura del juego que no se puede bajar');
    assert.strictEqual(res.versiones_incompletas, 0, `pasada ${pasada}: no es «incompleto», es «pasa el tope»`);
    assert.ok(res.grandes_nombres.some((n) => n.includes(V2)), res.grandes_nombres.join(' | '));
  }
  assert.strictEqual(fs.readFileSync(path.join(dir, MAQ, 'registros', 'gates.log.gz'), 'utf8'), 'viejo');
});

test('T45d Bajada_UnRegistroEnormeQueLaCoberturaNoDeclara_NoSacaAlJuego', async (t) => {
  // (Fable N1) un registro enorme con un nombre que la cobertura no declara no saca al juego entero: el espejo no vuelve
  // al juego anterior ni se queda sin registros; baja todo menos ese archivo
  const V2 = 'v20261121T000000000Z';
  const conAnterior = almacenMixto({
    'registros/gates.log.gz': Buffer.from('viejo'), 'registros/cobertura.json': cobertura(['gates']),
    [`registros/${V2}/gates.log.gz`]: Buffer.from('nuevo'), [`registros/${V2}/cobertura.json`]: cobertura(['gates']),
    [`registros/${V2}/bypass.log.gz`]: GB5,
  });
  const dir = path.join(carpeta(t), 'buzon');
  const { res } = await B.bajar({ almacen: conAnterior, dir, budgetMs: 20000, log: () => {} });
  assert.strictEqual(fs.readFileSync(path.join(dir, MAQ, 'registros', 'gates.log.gz'), 'utf8'), 'nuevo', 'se queda con el juego nuevo');
  assert.ok(!conAnterior.pedidos.includes(`registros/${V2}/bypass.log.gz`), 'el enorme no se pide');
  assert.strictEqual(res.grandes, 1);
  // y el único juego, igual: baja su cobertura y el registro chico
  const solo = almacenMixto({ [`registros/${V2}/gates.log.gz`]: Buffer.from('nuevo'), [`registros/${V2}/cobertura.json`]: cobertura(['gates']), [`registros/${V2}/bypass.log.gz`]: GB5 });
  const dir2 = path.join(carpeta(t), 'buzon');
  await B.bajar({ almacen: solo, dir: dir2, budgetMs: 20000, log: () => {} });
  assert.ok(fs.existsSync(path.join(dir2, MAQ, 'registros', 'cobertura.json')), 'baja la cobertura');
  assert.ok(fs.existsSync(path.join(dir2, MAQ, 'registros', 'gates.log.gz')), 'baja el registro chico');
  // en el juego de nombres de siempre, la cobertura que no lo declara también baja
  const viejo = almacenMixto({ 'registros/gates.log.gz': Buffer.from('x'), 'registros/cobertura.json': cobertura(['gates']), 'registros/bypass.log.gz': GB5 });
  const dir3 = path.join(carpeta(t), 'buzon');
  await B.bajar({ almacen: viejo, dir: dir3, budgetMs: 20000, log: () => {} });
  assert.ok(fs.existsSync(path.join(dir3, MAQ, 'registros', 'cobertura.json')), 'la cobertura del juego de siempre baja');
});

test('T44c Bajada_TrasUnaFalla_LosQueEsperabanLugarNoSePiden', async (t) => {
  // (Fable N2) los trabajadores que esperaban lugar cuando la pasada falló no piden su archivo después
  const MB = 1024 * 1024;
  const archivos = Array.from({ length: 6 }, (_, i) => [`${i + 1}.1-2026-11-20T10${10 + i}.hilo.jsonl.gz`, 100 * MB]);
  const a = almacenQueMideLoQueVuela(archivos, 40);
  const leer = a.leer;
  a.leer = async (nombre) => { const r = await leer(nombre); return a.pedidos === 1 ? { error: Object.assign(new Error('sin red'), { code: 'ECONNRESET' }) } : r; };
  const { codigo, res } = await B.bajar({ almacen: a, dir: path.join(carpeta(t), 'buzon'), budgetMs: 20000, log: () => {} });
  assert.strictEqual(codigo, 1);
  assert.strictEqual(res.estado, 'sin_red');
  assert.strictEqual(a.pedidos, 1, `después de la falla se pidieron ${a.pedidos - 1} más`);
});

test('T58a Bajada_LaAnotacionPorHuella_SeUsa_YSoloMientrasSuRegistroSigaEnorme', async (t) => {
  // (Fable S1/S4) la anotación «esta cobertura declara un registro enorme» evita volver a pedirla; vale sólo para la
  // misma cobertura (su huella) y mientras ESE registro siga enorme
  const V1 = 'v20261120T000000000Z';
  const V2 = 'v20261121T000000000Z';
  const archivos = {
    [`registros/${V1}/gates.log.gz`]: Buffer.from('viejo'), [`registros/${V1}/cobertura.json`]: cobertura(['gates']),
    [`registros/${V2}/gates.log.gz`]: GB5, [`registros/${V2}/bypass.log.gz`]: Buffer.from('b'), [`registros/${V2}/cobertura.json`]: cobertura(['gates', 'bypass']),
  };
  const a = almacenMixto(archivos);
  const dir = path.join(carpeta(t), 'buzon');
  await B.bajar({ almacen: a, dir, budgetMs: 20000, log: () => {} });
  assert.ok(a.pedidos.includes(`registros/${V2}/cobertura.json`), 'la primera vez la lee');
  assert.strictEqual(fs.readFileSync(path.join(dir, MAQ, 'registros', 'gates.log.gz'), 'utf8'), 'viejo');
  // segunda pasada: la del juego nuevo es distinta de la del anterior (no se lee del espejo); con la anotación no se pide
  a.pedidos.length = 0;
  await B.bajar({ almacen: a, dir, budgetMs: 20000, log: () => {} });
  assert.ok(!a.pedidos.includes(`registros/${V2}/cobertura.json`), `la segunda pasada la volvió a pedir: ${a.pedidos.join(', ')}`);
  // otra cobertura (otra huella) con el mismo nombre: la anotación no vale, se vuelve a leer
  const b = almacenMixto({ ...archivos, [`registros/${V2}/cobertura.json`]: cobertura(['gates', 'bypass', 'frenos']) });
  await B.bajar({ almacen: b, dir, budgetMs: 20000, log: () => {} });
  assert.ok(b.pedidos.includes(`registros/${V2}/cobertura.json`), 'con otra huella se vuelve a leer');
  // el registro de la anotación ya no es enorme y aparece OTRO enorme que la cobertura no declara: el juego baja
  const c = almacenMixto({ ...archivos, [`registros/${V2}/gates.log.gz`]: Buffer.from('nuevo'), [`registros/${V2}/frenos.jsonl.gz`]: GB5 });
  const dir2 = path.join(carpeta(t), 'buzon');
  await B.bajar({ almacen: almacenMixto(archivos), dir: dir2, budgetMs: 20000, log: () => {} });
  await B.bajar({ almacen: c, dir: dir2, budgetMs: 20000, log: () => {} });
  assert.strictEqual(fs.readFileSync(path.join(dir2, MAQ, 'registros', 'gates.log.gz'), 'utf8'), 'nuevo', 'la anotación vieja no saca al juego');
});

test('T60a Bajada_SinTiempoMientrasEsperaLugar_NoPide_YLaCuentaDaElTotal', async (t) => {
  // (Fable S5) con presupuesto corto, lo que esperaba lugar no se pide al vencer, y pedidos + pendientes = el total
  const MB = 1024 * 1024;
  const n = 12;
  const archivos = Array.from({ length: n }, (_, i) => [`${i + 1}.1-2026-11-20T10${10 + i}.hilo.jsonl.gz`, 100 * MB]);
  const a = almacenQueMideLoQueVuela(archivos, 120);
  const t0 = Date.now();
  const { res } = await B.bajar({ almacen: a, dir: path.join(carpeta(t), 'buzon'), budgetMs: 250, log: () => {} });
  const duro = Date.now() - t0;
  assert.ok(a.pedidos < n, `se pidieron todos (${a.pedidos}): el presupuesto no cortó`);
  assert.strictEqual(a.pedidos + res.sin_tiempo, n, `pedidos ${a.pedidos} + pendientes ${res.sin_tiempo} ≠ ${n}`);
  assert.ok(duro < 250 + 3 * 120, `después del corte se siguió pidiendo: ${duro} ms`);
});

test('T60b Bajada_LosAvisosDeJuego_VanPrimero', async (t) => {
  // (Fable N5/S5) con más de 20 archivos grandes, el aviso de que una máquina vuelve al juego anterior no se pierde
  const V1 = 'v20261120T000000000Z';
  const V2 = 'v20261121T000000000Z';
  const archivos = {
    [`registros/${V1}/gates.log.gz`]: Buffer.from('viejo'), [`registros/${V1}/cobertura.json`]: cobertura(['gates']),
    [`registros/${V2}/gates.log.gz`]: GB5, [`registros/${V2}/cobertura.json`]: cobertura(['gates']),
  };
  for (let i = 0; i < 25; i++) archivos[`9.${i}-2026-11-20T1010.json`] = GB5;
  const { res } = await B.bajar({ almacen: almacenMixto(archivos), dir: path.join(carpeta(t), 'buzon'), budgetMs: 20000, log: () => {} });
  assert.match(res.grandes_nombres[0], new RegExp(`${V2}.*juego anterior`), res.grandes_nombres.slice(0, 2).join(' | '));
});
