'use strict';
// office-split.test.js — the office tests split by zone: the same cases as the one file they came from, each part
// registered and under the time limit of the branch validation, and each part still a dependent of what its shared
// library loads, as the dependency reader of the validation sees it.
// Nothing here reads the real HOME: the parts are loaded with a toy HOME.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const { suiteDeps } = require(path.join(ROOT, 'scripts', 'ci', 'suite-deps.js'));

// The parts and the files this guard reads, named literally: the dependency reader of the validation follows what a suite
// names, so a change to any part, to the list of before or to the registry runs this guard too.
const PARTS = ['office-photo.test.js', 'office-hours.test.js', 'office-board.test.js', 'office-tables.test.js', 'office-page.test.js', 'office-conversation.test.js'];
const LIBRARY = 'scripts/tests/lib/office-fixtures.js';
const BEFORE = path.join(__dirname, 'fixtures', 'office-test-names.json');
const REGISTRY = path.join(__dirname, 'suites.json');
const OVER_LIMIT = path.join(ROOT, 'scripts', 'ci', 'suites-over-limit.json');
const WEIGHTS = path.join(ROOT, 'scripts', 'ci', 'suites-weights.json');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// Loads one part with a `node:test` that only writes down the name of each case: no case body runs.
const LIST_NAMES = `
const Module = require('module');
const names = [];
const note = (name) => { names.push(String(name)); return Promise.resolve(); };
const quiet = () => {};
const fake = Object.assign((name) => note(name), { skip: note, todo: note, only: note, before: quiet, after: quiet, beforeEach: quiet, afterEach: quiet });
fake.test = fake;
const load = Module._load;
Module._load = function (request, ...rest) { return request === 'node:test' ? fake : load.call(this, request, ...rest); };
require(process.argv[1]);
process.stdout.write(JSON.stringify(names));
`;
function namesOf(part) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-split-'));
  try {
    const r = spawnSync(process.execPath, ['-e', LIST_NAMES, path.join(__dirname, part)], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
    assert.strictEqual(r.status, 0, `${part} no se dejó cargar: ${r.stderr.slice(-800)}`);
    return JSON.parse(r.stdout);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

test('T33 Suites_PruebasDeLaOficina_MismosCasos @story-8.234 @ac-33 — cada caso de la lista de antes está en una sola parte, y ninguna parte repite un nombre', () => {
  const before = readJson(BEFORE).names;
  assert.strictEqual(before.length, 198, 'la lista de antes es la del corte');
  const where = new Map();
  for (const part of PARTS) {
    const names = namesOf(part);
    assert.ok(names.length > 0, `${part} no declara ningún caso`);
    for (const name of names) {
      assert.ok(!where.has(name), `«${name}» está en ${where.get(name)} y en ${part}`);
      where.set(name, part);
    }
  }
  const lost = before.filter((name) => !where.has(name));
  assert.deepStrictEqual(lost, [], 'ningún caso de antes se perdió');
});

test('T32 Suites_PruebasDeLaOficina_PartidasBajoElTope @story-8.234 @ac-32 — cada parte registrada como el archivo entero, con su peso propio bajo el tope, y dependiendo de lo que carga su biblioteca', () => {
  assert.ok(!fs.existsSync(path.join(__dirname, 'office.test.js')), 'el archivo entero ya no está');
  const registry = readJson(REGISTRY);
  const all = [...registry.diarias, ...registry.semanales];
  assert.ok(!all.some((e) => e.ruta === 'tests/office.test.js'), 'el archivo entero ya no está en suites.json');
  for (const part of PARTS) {
    // el criterio del archivo entero: diaria (no semanal), del arnés, sin requisitos ni condiciones
    assert.ok(!registry.semanales.some((e) => e.ruta === `tests/${part}`), `${part}: diaria, como el archivo entero`);
    const entries = registry.diarias.filter((e) => e.ruta === `tests/${part}`);
    assert.strictEqual(entries.length, 1, `${part}: una sola vez en suites.json`);
    assert.deepStrictEqual(entries[0], { raiz: 'arnes', ruta: `tests/${part}`, requiere: [] }, part);
  }

  // el tope y el juego de pesos salen de la lista de decisiones; el peso de cada parte, de ese juego
  const over = readJson(OVER_LIMIT);
  const set = readJson(WEIGHTS)[over.weight_set];
  assert.ok(typeof over.limit_seconds === 'number' && set && set.weights, 'el tope y el juego de pesos se leen');
  for (const part of [...PARTS, 'office-split.test.js']) {
    const w = set.weights[part];
    assert.ok(typeof w === 'number' && w > 0, `${part}: lleva su peso medido en el juego «${over.weight_set}», no el de por defecto`);
    assert.ok(w <= over.limit_seconds, `${part}: ${w} s pasa del tope de ${over.limit_seconds} s`);
    assert.ok(!(over.suites || {})[part], `${part}: no lleva excepción`);
  }

  // un cambio en lo que carga la biblioteca (office.js, marker.js, sus módulos) hace correr cada parte en la validación
  const cache = new Map();
  const library = suiteDeps(ROOT, LIBRARY, cache).files;
  for (const must of ['scripts/tools/office.js', 'skills/tycon-pipeline/scripts/marker.js']) assert.ok(library.has(must), `la biblioteca depende de ${must}`);
  for (const part of PARTS) {
    const deps = suiteDeps(ROOT, `scripts/tests/${part}`, cache).files;
    const missing = [...library].filter((f) => !deps.has(f));
    assert.deepStrictEqual(missing, [], `${part} no depende de todo lo que depende su biblioteca`);
  }
  // y esta guardia corre cuando cambia una parte o la lista de antes: si no, un caso perdido entraría sin que corra
  const self = suiteDeps(ROOT, 'scripts/tests/office-split.test.js', cache).files;
  for (const must of [...PARTS.map((p) => `scripts/tests/${p}`), 'scripts/tests/fixtures/office-test-names.json']) {
    assert.ok(self.has(must), `office-split.test.js no depende de ${must}: un cambio ahí no la haría correr`);
  }
});
