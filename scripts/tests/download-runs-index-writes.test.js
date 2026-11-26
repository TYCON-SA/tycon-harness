'use strict';
// download-runs-index-writes.test.js — cuántas veces la bajada del buzón reescribe su índice (issue #1785).
//
// Con el disco de datos del sitio montado sobre un almacenamiento de objetos (Cloud Run con un volumen de Cloud Storage),
// cada reescritura del mismo archivo es una mutación del mismo objeto, y Cloud Storage admite una por segundo: reescribir
// el índice después de cada archivo, con varios en paralelo, da 429. Y dos instancias con el mismo pid (1, en un
// contenedor) escribían el mismo temporal. Sin red: el almacén es falso y todo pasa en una carpeta temporal.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { bajar } = require('../metrics/download-runs.js');

const INDICE = 'mailbox-downloads.json';

function carpeta(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'indice-bajada-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** Un almacén falso con `n` corridas de una máquina; `fallaEn` hace que ese archivo corte la pasada. */
function almacen(n, { fallaEn = null } = {}) {
  const blobs = Array.from({ length: n }, (_, i) => {
    const cuerpo = Buffer.from(JSON.stringify({ merge: i }));
    return { nombre: `maq-a/corrida-${String(i).padStart(3, '0')}.json`, largo: cuerpo.length, md5: crypto.createHash('md5').update(cuerpo).digest('base64'), etag: `e${i}`, cuerpo };
  });
  return {
    destino: 'falso/buzon',
    listar: async () => ({ blobs: blobs.map(({ cuerpo, ...b }) => b) }),
    leer: async (nombre) => {
      const b = blobs.find((x) => x.nombre === nombre);
      if (fallaEn !== null && nombre === blobs[fallaEn].nombre) return { error: { code: 'ECONNRESET' } };
      return { status: 200, cuerpo: b.cuerpo, cabeceras: {} };
    },
  };
}

/** Cuenta los renombres que dejan el índice en su lugar, y anota con qué temporal. */
function espiarRenombres(t) {
  const original = fs.renameSync;
  const alIndice = [];
  fs.renameSync = (de, a) => { if (path.basename(a) === INDICE) alIndice.push(de); return original(de, a); };
  t.after(() => { fs.renameSync = original; });
  return alIndice;
}

test('T1785a Bajada_17Archivos_ElIndiceSeEscribeUnaVez', async (t) => {
  const raiz = carpeta(t);
  const dir = path.join(raiz, 'buzon');
  const alIndice = espiarRenombres(t);
  const { codigo, res } = await bajar({ almacen: almacen(17), dir, log: () => {} });
  assert.strictEqual(codigo, 0, JSON.stringify(res));
  assert.strictEqual(res.bajados, 17);
  assert.ok(alIndice.length <= 1, `el índice se reescribió ${alIndice.length} veces en una pasada de 17 archivos`);
  const indice = JSON.parse(fs.readFileSync(path.join(raiz, INDICE), 'utf8'));
  assert.strictEqual(Object.keys(indice.blobs).length, 17, 'el índice anota los 17');
});

test('T1785b Bajada_CortadaAMitad_ElIndiceAnotaLoQueBajo', async (t) => {
  // con un solo trabajador, el orden es el del listado: bajan los 5 primeros y el sexto corta la pasada
  const raiz = carpeta(t);
  const dir = path.join(raiz, 'buzon');
  const { codigo, res } = await bajar({ almacen: almacen(10, { fallaEn: 5 }), dir, concurrencia: 1, log: () => {} });
  assert.notStrictEqual(codigo, 0);
  assert.strictEqual(res.bajados, 5, JSON.stringify(res));
  const indice = JSON.parse(fs.readFileSync(path.join(raiz, INDICE), 'utf8'));
  assert.strictEqual(Object.keys(indice.blobs).length, 5, 'lo bajado antes del corte queda anotado');
});

test('T1785c Indice_TemporalConNombreUnico_NoSoloElPid', async (t) => {
  // dos instancias en contenedores distintos tienen el mismo pid (1): el temporal tiene que llevar algo más
  const raiz = carpeta(t);
  const alIndice = espiarRenombres(t);
  await bajar({ almacen: almacen(2), dir: path.join(raiz, 'buzon'), log: () => {} });
  assert.ok(alIndice.length >= 1, 'el índice se escribió');
  for (const tmp of alIndice) assert.match(path.basename(tmp), new RegExp(`^${INDICE.replace('.', '\\.')}\\.tmp-${process.pid}-[0-9a-f]{8}$`), tmp);
});
