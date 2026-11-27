'use strict';
/**
 * site-temp-names.test.js — los temporales del sitio llevan un sufijo al azar, no sólo el número de proceso.
 *
 *   T1 SiteTempNames_NotOnlyPid — ningún nombre de temporal del código del sitio se arma sólo con `process.pid`
 *   T2 SiteTempNames_TwoReplicas — dos réplicas con el mismo número de proceso (el 1 de un contenedor) que guardan a la
 *      vez sobre la misma carpeta no comparten el temporal
 *
 * 🔴 Falla con: un temporal nombrado con el número de proceso solo. En contenedores todas las réplicas son el proceso 1 y
 *    comparten la carpeta de datos: dos que guardan a la vez escriben el mismo temporal y una pisa a la otra a medias.
 * stable-data: lee el código del sitio y escribe en el temporal; no lee el reloj.
 * 0 deps (node:test).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SITE = path.join(__dirname, '..', 'site');

function archivos(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'public') out.push(...archivos(p)); continue; }
    if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('T1 SiteTempNames_NotOnlyPid — ningún temporal del sitio se nombra sólo con el número de proceso', () => {
  const malos = [];
  for (const f of archivos(SITE)) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
      // un renglón que arma un nombre con `process.pid` tiene que llevar también algo al azar
      if (/\$\{process\.pid\}/.test(l) && !/randomBytes|randomUUID/.test(l)) malos.push(`${path.relative(SITE, f)}:${i + 1}`);
    });
  }
  assert.deepEqual(malos, [], `temporales nombrados sólo con el número de proceso:\n${malos.join('\n')}`);
});

test('T2 SiteTempNames_TwoReplicas — dos guardadas con el mismo proceso no comparten el temporal', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sitio-tmp-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { escribirAtomico } = require(path.join(SITE, 'sources.js'));
  const destino = path.join(dir, 'datos.json');
  // las dos «réplicas» guardan sin terminar: se miran los temporales que quedan a la vez
  const vistos = new Set();
  const orig = fs.renameSync;
  fs.renameSync = (de) => { vistos.add(de); };
  try { escribirAtomico(destino, 'uno'); escribirAtomico(destino, 'dos'); } finally { fs.renameSync = orig; }
  assert.equal(vistos.size, 2, 'cada guardada usa su propio temporal');
  for (const v of vistos) fs.rmSync(v, { force: true });
});
