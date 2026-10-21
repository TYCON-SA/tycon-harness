'use strict';

/**
 * suite-parts.js — partir una suite de Node SIN mover sus pruebas.
 *
 * POR QUÉ: ninguna suite pasa de 45 s en la validación de una rama. Una suite con decenas de pruebas de pocos segundos
 * (la del mecanismo de publicación: 61 pruebas, ~6 min) sólo baja partiéndola, y cortar a mano un archivo de 4.500 líneas
 * en diez es el cambio más riesgoso que se le puede hacer. Acá el archivo queda como está y se le cambia UNA línea:
 *
 *     const test = require('./lib/suite-parts.js').test;        // en vez de require('node:test')
 *
 * Corrido a mano (`node --test <suite>.test.js`) corre todo, como siempre. Cada parte es un archivo de una línea,
 * `<suite>.p3.test.js`, registrado en suites.json:
 *
 *     require('./lib/suite-parts.js').runPart(__filename);
 *
 * que carga el archivo entero y deja correr sólo las pruebas de la parte 3. Cuántas partes y cuánto tarda cada prueba lo
 * dice scripts/tests/suite-parts.json (`suites["<suite>.test.js"] = { parts, seconds: { "<nombre de la prueba>": s } }`):
 * las pruebas se reparten de la más larga a la más corta, cada una a la parte que va más liviana, y dentro de cada parte
 * corren en el orden del archivo. Una prueba sin duración medida (una nueva) lleva la mediana de las medidas.
 *
 * LO QUE NO SE REPARTE: `test.before`, `test.after` y demás ganchos del archivo corren en todas las partes, y también lo
 * que el archivo haga al cargarse. `describe`/`it` no se reparten: una suite que los use no se parte con esto. Tampoco
 * una que registre pruebas después de cargarse (dentro de un `await` o de un `then`): la parte falla diciéndolo.
 *
 * Las suites de consola tienen su gemela, suite-parts.sh, al lado. `layoutProblems` mira las dos familias: la usan la
 * prueba de esta biblioteca (T42) y la que exige que toda suite esté registrada.
 * 🔴 Esta cabecera no nombra ninguna suite por su ruta a propósito: el lector de dependencias (scripts/ci/suite-deps.js)
 *    sigue las rutas que encuentra, y cada parte de cada suite partida pasaría a depender de la suite nombrada acá.
 */

const fs = require('fs');
const path = require('path');
const real = require('node:test');

const PART_FILE = /^(.+)\.p([1-9]\d*)\.test\.(js|sh)$/;
const REGISTRY_NAME = 'suite-parts.json';

// Mientras se carga el archivo entero para una parte, las pruebas se anotan acá en vez de registrarse.
let pending = null;
// Ya repartido (el nombre del archivo entero): una prueba que llega después —registrada dentro de un `await` o de un
// `then`— no se puede repartir, y registrarla tal cual la haría correr en TODAS las partes sin que nadie lo note.
// Se registra una prueba que falla diciéndolo: la parte queda roja.
let dealt = null;
const defer = (via) => (...args) => {
  // (devuelve algo que se puede encadenar, como el `test` de node: una suite que hace `test(…).then(…)` no revienta al cargar)
  if (pending) { pending.push({ via, args }); return Promise.resolve(); }
  if (dealt) {
    const name = String(args[0]);
    return real(`${name} — registrada tarde`, () => {
      throw new Error(`suite-parts: «${name}» se registró después de cargar ${dealt}: una prueba así no se puede repartir entre las partes (correría en todas). Registrala al cargar el archivo.`);
    });
  }
  return via ? real[via](...args) : real(...args);
};

/** El `test` que usan las suites que se parten: fuera de una parte es el de node, tal cual. */
const test = defer('');
for (const key of Object.keys(real)) test[key] = real[key];
for (const via of ['skip', 'todo', 'only']) test[via] = defer(via);
test.test = test;

/**
 * A qué parte (0 … n-1) va cada prueba: de la más larga a la más corta, a la parte que va más liviana (ante un empate, la
 * de número más bajo). `seconds` es nombre → segundos; la que no figura lleva la mediana de las que sí, o 1 si no hay.
 */
function assign(names, seconds, n) {
  const known = names.map((name) => (seconds || {})[name]).filter((s) => typeof s === 'number' && s > 0).sort((a, b) => a - b);
  const median = known.length ? (known[Math.floor((known.length - 1) / 2)] + known[Math.floor(known.length / 2)]) / 2 : 1;
  const weight = (name) => { const s = (seconds || {})[name]; return typeof s === 'number' && s > 0 ? s : median; };
  const load = Array(n).fill(0);
  const out = Array(names.length);
  names.map((name, i) => ({ i, w: weight(name) })).sort((a, b) => b.w - a.w || a.i - b.i).forEach(({ i, w }) => {
    let lightest = 0;
    for (let p = 1; p < n; p++) if (load[p] < load[lightest]) lightest = p;
    load[lightest] += w;
    out[i] = lightest;
  });
  return out;
}

function readRegistry(dir) {
  const file = path.join(dir, REGISTRY_NAME);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { file, problem: `${file} no se deja leer (${e.code || e.message})` }; }
  if (!raw || typeof raw.suites !== 'object' || raw.suites === null || Array.isArray(raw.suites)) return { file, problem: `${file}: «suites» no es un objeto` };
  return { file, suites: raw.suites };
}
const validParts = (n) => Number.isInteger(n) && n >= 2;
// Las de consola no van en el registro: cuántas partes tienen lo dice el propio archivo (`suite_parts <n>`), que es lo
// que la biblioteca de consola comprueba al correr. Así una suite de consola que no viaja en la copia pública se va
// entera —el archivo y sus partes— sin dejar una entrada colgada en un registro.
const SHELL_DECLARES = /^\s*suite_parts\s+(\d+)\s*(?:#.*)?$/m;
// `unreadable` junta las que existen y no se dejan leer: de ésas no se sabe si corren por partes, y callarlo las daría por
// «no partidas».
function shellSuites(dir, unreadable = []) {
  const out = new Map();
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.test.sh') || PART_FILE.test(file)) continue;
    let text;
    try { text = fs.readFileSync(path.join(dir, file), 'utf8'); } catch (e) { unreadable.push({ file, reason: e.code || e.message }); continue; }
    const m = text.match(SHELL_DECLARES);
    if (m) out.set(file, { parts: Number(m[1]) });
  }
  return out;
}

/** La línea de un archivo de parte: carga el entero y corre sólo lo de esa parte. Sin poder decidir, sale 2 y no corre nada. */
function runPart(partFile) {
  const stop = (why) => { process.stderr.write(`❌ suite-parts: ${why}\n`); process.exit(2); };
  const m = path.basename(partFile).match(PART_FILE);
  if (!m || m[3] !== 'js') stop(`${path.basename(partFile)} no es una parte (<suite>.p<k>.test.js)`);
  const dir = path.dirname(partFile);
  const base = `${m[1]}.test.js`;
  const k = Number(m[2]);
  const registry = readRegistry(dir);
  if (registry.problem) stop(registry.problem);
  const spec = registry.suites[base];
  if (!spec) stop(`${base} no figura en ${registry.file}: no sé en cuántas partes va`);
  if (!validParts(spec.parts)) stop(`${base}: «parts» tiene que ser un entero de 2 o más (${registry.file})`);
  if (k > spec.parts) stop(`${base} tiene ${spec.parts} partes: no hay parte ${k}`);
  // si el archivo entero no carga, el error sale tal cual y no se registra ninguna prueba: la parte queda roja
  pending = [];
  require(path.join(dir, base));
  const mine = pending;
  pending = null;
  const names = mine.map((t) => String(t.args[0]));
  // Una duración que no es de ninguna prueba es un nombre que cambió (o se copió mal): esa prueba reparte con la mediana.
  // No frena —el reparto sigue siendo el mismo en todas las partes—, se avisa.
  const orphans = Object.keys(spec.seconds || {}).filter((name) => !names.includes(name));
  if (orphans.length) process.stderr.write(`⚠️  suite-parts: ${orphans.length} duraciones de ${registry.file} no son de ninguna prueba de ${base}: ${orphans.map((o) => `«${o}»`).join(', ')}\n`);
  const part = assign(names, spec.seconds, spec.parts);
  // Una parte sin pruebas no es un verde: node la contaría como un archivo que pasó.
  if (!part.includes(k - 1)) stop(`la parte ${k} de ${base} no recibió ninguna prueba (${mine.length} pruebas para ${spec.parts} partes): bajá «parts» en ${registry.file}`);
  mine.forEach((t, i) => { if (part[i] === k - 1) (t.via ? real[t.via] : real)(...t.args); });
  dealt = base;
}

/**
 * Lo que está mal armado en las suites partidas de `ctx.dir`. `ctx`: `registry` (el contenido de suite-parts.json),
 * `entries` (las de suites.json del arnés, con `name`), `weights` (`pr` y `nightly`: nombre → segundos), `heavy` (las
 * `suites` de heavy-suites.json), `limit` (segundos) y, si las hay, `decided` (un Set con los nombres que pasan del límite
 * con una decisión anotada en suites-over-limit.json). Devuelve una lista de frases; vacía = todo en su lugar.
 */
function layoutProblems(ctx) {
  const out = [];
  const registered = (ctx.registry && ctx.registry.suites) || {};
  const suites = {};
  for (const [base, spec] of Object.entries(registered)) {
    if (base.endsWith('.test.js')) suites[base] = spec;
    else out.push(`${base}: en ${REGISTRY_NAME} van sólo las de Node; una de consola dice sus partes con \`suite_parts <n>\``);
  }
  const unreadable = [];
  for (const [base, spec] of shellSuites(ctx.dir, unreadable)) suites[base] = spec;
  for (const u of unreadable) out.push(`${u.file} no se deja leer (${u.reason}): no sé si corre por partes`);
  const byName = new Map(ctx.entries.map((e) => [e.name, e]));
  const onDisk = fs.readdirSync(ctx.dir);
  // un archivo que no está y uno que no se deja leer no son lo mismo: `missing` dice cuál fue
  const why = new Map();
  const read = (name) => { try { return fs.readFileSync(path.join(ctx.dir, name), 'utf8'); } catch (e) { why.set(name, e.code === 'ENOENT' ? null : (e.code || e.message)); return null; } };
  const missing = (name) => (why.get(name) ? `no se deja leer (${why.get(name)})` : 'no existe');
  const code = (text) => text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('//') && l !== "'use strict';");
  const criterion = (e) => JSON.stringify({ requiere: e.requiere, gate: e.gate_only_when_touching, exclusive: e.exclusive, semanal: e.semanal });

  for (const file of onDisk) {
    const m = file.match(PART_FILE);
    if (!m) continue;
    const base = `${m[1]}.test.${m[3]}`;
    if (!suites[base]) out.push(m[3] === 'js' ? `${file} es una parte de ${base}, que no figura en ${REGISTRY_NAME}` : `${file} es una parte de ${base}, que no declara sus partes (\`suite_parts <n>\`)`);
    else if (validParts(suites[base].parts) && Number(m[2]) > suites[base].parts) out.push(`${file} sobra: ${base} tiene ${suites[base].parts} partes`);
  }
  for (const [base, spec] of Object.entries(suites)) {
    const ext = (base.match(/\.test\.(js|sh)$/) || [])[1];
    if (!ext) { out.push(`${base}: no es una suite (.test.js o .test.sh)`); continue; }
    if (!validParts(spec && spec.parts)) { out.push(`${base}: «parts» tiene que ser un entero de 2 o más`); continue; }
    const whole = read(base);
    if (whole === null) { out.push(`${base} figura como partida y ${missing(base)}`); continue; }
    if (byName.has(base)) out.push(`${base} está partida y sigue en suites.json: correría entera y por partes`);
    if (ctx.weights.pr[base] !== undefined || ctx.weights.nightly[base] !== undefined) out.push(`${base} está partida y conserva su peso: los pesos son de sus partes`);
    if (ctx.heavy[base] !== undefined) out.push(`${base} está partida y sigue en heavy-suites.json: el criterio es de sus partes`);
    const parts = Array.from({ length: spec.parts }, (_, i) => base.replace(/\.test\.(js|sh)$/, `.p${i + 1}.test.$1`));

    if (ext === 'js') {
      if (!/require\(['"]\.\/lib\/suite-parts\.js['"]\)\.test\b/.test(whole)) out.push(`${base} no toma \`test\` de lib/suite-parts.js: sus partes correrían todas las pruebas`);
    } else {
      if (!/lib\/suite-parts\.sh/.test(whole)) out.push(`${base} no carga lib/suite-parts.sh`);
      const blocks = new Set([...whole.matchAll(/\bsuite_part\s+(\d+)\b/g)].map((x) => Number(x[1])));
      for (let k = 1; k <= spec.parts; k++) if (!blocks.has(k)) out.push(`${base} no tiene ningún bloque de la parte ${k}`);
      for (const b of blocks) if (b < 1 || b > spec.parts) out.push(`${base} tiene un bloque de la parte ${b} y sus partes son ${spec.parts}`);
    }
    parts.forEach((part, i) => {
      const text = read(part);
      if (text === null) { out.push(`${part} ${missing(part)}`); return; }
      const want = ext === 'js'
        ? ["require('./lib/suite-parts.js').runPart(__filename);"]
        : ['#!/usr/bin/env bash', `SUITE_PART=${i + 1}/${spec.parts} exec bash "$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)/${base}"`];
      const got = ext === 'js' ? code(text) : text.split('\n').map((l) => l.trim()).filter((l) => l && (l.startsWith('#!') || !l.startsWith('#')));
      if (JSON.stringify(got) !== JSON.stringify(want)) out.push(`${part} no es la línea de una parte (${want[want.length - 1]})`);
      if (!byName.has(part)) out.push(`${part} no está en suites.json: esa parte no la corre nadie`);
      const pr = ctx.weights.pr[part];
      if (typeof pr !== 'number') out.push(`${part} no tiene peso en el juego de la validación`);
      // Una parte que es un solo paso largo no se parte más: pasa del límite con su decisión anotada, como cualquier suite
      // (`decided`). Que la decisión esté firmada y siga haciendo falta lo mide suites-over-limit.test.js, no esto.
      else if (pr > ctx.limit && !(ctx.decided && ctx.decided.has(part))) out.push(`${part} pesa ${pr} s: pasa de ${ctx.limit} s, hay que partir en más (o anotar su decisión en scripts/ci/suites-over-limit.json)`);
      if (typeof ctx.weights.nightly[part] !== 'number') out.push(`${part} no tiene peso en el juego del nocturno`);
    });
    const registered = parts.filter((p) => byName.has(p)).map((p) => criterion(byName.get(p)));
    if (new Set(registered).size > 1) out.push(`las partes de ${base} no llevan el mismo criterio en suites.json (requiere, gate_only_when_touching, exclusive)`);
    const heavy = parts.map((p) => (ctx.heavy[p] === undefined ? '' : JSON.stringify({ ...ctx.heavy[p], patterns: (ctx.heavy[p].patterns || []).filter((x) => !parts.some((q) => x.endsWith(q))) })));
    if (new Set(heavy).size > 1) out.push(`las partes de ${base} no llevan el mismo criterio en heavy-suites.json`);
  }
  return out;
}

/** Los archivos enteros de las suites partidas de `dir` (los que NO van en suites.json): nombre → cantidad de partes. */
function partitioned(dir) {
  const registry = readRegistry(dir);
  if (registry.problem) throw new Error(registry.problem);
  const out = new Map(Object.entries(registry.suites).map(([base, spec]) => [base, spec && spec.parts]));
  const unreadable = [];
  for (const [base, spec] of shellSuites(dir, unreadable)) out.set(base, spec.parts);
  if (unreadable.length) throw new Error(unreadable.map((u) => `${u.file} no se deja leer (${u.reason}): no sé si corre por partes`).join('; '));
  return out;
}

module.exports = { test, runPart, assign, layoutProblems, partitioned, PART_FILE };
