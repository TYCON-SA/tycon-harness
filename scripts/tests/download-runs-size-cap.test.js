'use strict';
// download-runs-size-cap.test.js — la bajada del buzón mira el tamaño de cada archivo antes de pedirlo (A38).
//
// La llave de las máquinas sólo crea, pero crea lo que quiera: un volcado, un cambio de git o un registro de 5 GB se
// pedía entero y se juntaba en memoria. Ahora cada archivo tiene un tope por tipo, el mismo con el que después se abre
// (lo que pasa ese tope no se podría leer nunca), y el pedido se corta si el cuerpo trae más de lo que dijo el listado.
// Sin red salvo un servidor local: el almacén es falso y todo pasa en una carpeta temporal.

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
  return {
    pedidos,
    destino: 'falso/buzon',
    listar: async () => ({ blobs: lista }),
    leer: async (nombre) => {
      const corto = nombre.split('/').slice(1).join('/');
      pedidos.push(corto);
      if (chicos[corto]) return { status: 200, cuerpo: chicos[corto], cabeceras: {} };
      return { status: 404, cuerpo: Buffer.alloc(0), cabeceras: {} };
    },
  };
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
  assert.ok(res.ignorados_nombres.some((n) => /gates\.log\.gz.*tope/.test(n)), res.ignorados_nombres.join(' | '));
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
