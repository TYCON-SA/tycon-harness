'use strict';
// site-disk-opens.test.js — el sitio abre menos archivos del disco montado (A48).
//
// En Azure, el disco del sitio es un recurso compartido de Azure Files, y cada apertura (también un existsSync o un
// stat) se cobra como escritura: el 20 al 26/11 fueron entre 1,0 y 1,3 millones por día. Venían de recorrer el espejo
// del buzón entero en cada pasada. Sin red: todo pasa en una carpeta temporal, con fuentes falsas.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const runs = require(path.join(ROOT, 'scripts', 'nightly', 'dashboard', 'runs.js'));
const { bajar } = require(path.join(ROOT, 'scripts', 'metrics', 'download-runs.js'));

function carpeta(t, prefijo) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefijo));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** Cuenta las llamadas a `fn` de fs con una ruta dentro de `dentro`. */
function contar(t, fn, dentro) {
  const original = fs[fn];
  const cuenta = { n: 0 };
  fs[fn] = function (p, ...resto) { if (String(p).startsWith(dentro)) cuenta.n += 1; return original.call(this, p, ...resto); };
  t.after(() => { fs[fn] = original; });
  return cuenta;
}

test('T48a ResumirEspejo_SinConversaciones_NoPreguntaPorCadaCorrida', (t) => {
  // 🔴 rojo: resumirEspejo hacía dos existsSync por corrida (su conversación y su cambio), aunque no hubiera nada que
  //    resumir: con miles de corridas, miles de aperturas en cada pasada
  const espejo = carpeta(t, 'a48-espejo-');
  for (const maq of ['maq-a-0000aaaa', 'maq-b-0000bbbb']) {
    fs.mkdirSync(path.join(espejo, maq));
    for (let i = 0; i < 150; i += 1) fs.writeFileSync(path.join(espejo, maq, `1.${i}-2026-11-20T1010.json`), '{}');
  }
  const existe = contar(t, 'existsSync', espejo);
  const r = runs.resumirEspejo(espejo, { skillsDir: path.join(ROOT, 'skills') });
  assert.strictEqual(r.resumidas, 0);
  assert.strictEqual(r.fallidas, 0);
  assert.strictEqual(existe.n, 0, `preguntó ${existe.n} veces si existía un archivo del espejo`);
});

test('T48b ResumirEspejo_LaQueTieneSuCambio_SeSigueResumiendo', (t) => {
  // lo que ya hacía no cambia: una corrida con su cambio de git al lado se resume y el cambio se borra
  const espejo = carpeta(t, 'a48-espejo-');
  const maq = path.join(espejo, 'maq-a-0000aaaa');
  fs.mkdirSync(maq);
  fs.writeFileSync(path.join(maq, '2.1-2026-11-20T1010.json'), JSON.stringify({ marker: { storyId: '2.1' } }));
  fs.writeFileSync(path.join(maq, '2.1-2026-11-20T1010.cambio.json.gz'), require('zlib').gzipSync(JSON.stringify({ repos: [] })));
  const r = runs.resumirEspejo(espejo, { skillsDir: path.join(ROOT, 'skills') });
  assert.strictEqual(r.resumidas + r.fallidas, 1, JSON.stringify(r));
  if (r.resumidas === 1) assert.ok(!fs.existsSync(path.join(maq, '2.1-2026-11-20T1010.cambio.json.gz')), 'el cambio se borró');
});

test('T48c Uniones_SinCambios_NoSeReescriben', async (t) => {
  // 🔴 rojo: el archivo de las uniones de carpetas se reescribía en cada pasada entera aunque fuera igual
  const dir = path.join(carpeta(t, 'a48-buzon-'), 'buzon');
  const cuerpo = Buffer.from(JSON.stringify({ merge: 1 }));
  const blobs = [{ nombre: 'maq-a-0000aaaa/c-001.json', largo: cuerpo.length, md5: crypto.createHash('md5').update(cuerpo).digest('base64'), etag: 'e' }];
  const almacen = { destino: 'falso/buzon', listar: async () => ({ blobs }), leer: async () => ({ status: 200, cuerpo, cabeceras: {} }) };
  await bajar({ almacen, dir, log: () => {} });
  const uniones = path.join(dir, '.carpetas-de-maquina.json');
  assert.ok(fs.existsSync(uniones), 'la primera pasada las escribe');
  const renombres = { n: 0 };
  const original = fs.renameSync;
  fs.renameSync = (de, a) => { if (a === uniones) renombres.n += 1; return original(de, a); };
  t.after(() => { fs.renameSync = original; });
  await bajar({ almacen, dir, log: () => {} });
  assert.strictEqual(renombres.n, 0, 'la segunda, igual, no las vuelve a escribir');
});
