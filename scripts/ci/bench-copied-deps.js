#!/usr/bin/env node
'use strict';
/**
 * bench-copied-deps.js — avisa en el pedido cuando un archivo que los casos del banco copian a mano suma una dependencia
 * que esos casos no copian. Sólo lee; nunca frena.
 * Casos: scripts/tests/bench-copied-deps.test.js
 *
 * POR QUÉ EXISTE: el banco con los casos de la base corre en la cola de merge y en un push a main, no en el pedido (ver
 * .github/workflows/ci.yml). Varios casos arman una copia chica del arnés con `cp $TCG/<ruta> …`, archivo por archivo.
 * Si el pedido le suma a uno de esos archivos un `require` local que el caso no copia, el gancho se cae al cargar en la
 * copia chica y el banco lo lee como frenos aflojados: el pedido da verde y se cae recién en la cola. Esto lo avisa en
 * el pedido, sin sumar trabajos de GitHub (corre dentro de la parte checks).
 *
 * QUÉ MIRA: en cada caso de scripts/controls-bench/cases/ de la punta, cada texto con `$TCG/<ruta>` es un comando que
 * copia: sus rutas (también las de un `$(ls …)`) son lo que ese comando copia, y una carpeta copiada cubre lo que tiene
 * adentro. Por cada archivo `.js` que el rango cambia y que algún comando copia, compara sus `require('./…')` y
 * `require('../…')` en la punta contra la base: cada dependencia nueva que ese comando no copia es un aviso. Una
 * dependencia de la dependencia no se sigue: el aviso nombra la primera, y con eso alcanza para mirar el caso. Un
 * `require` dentro de un bloque `try` no cuenta: si el archivo falta, el gancho tiene su salida y carga igual.
 *
 * USO:  node scripts/ci/bench-copied-deps.js [--root <dir>] --range <base>...<punta>
 * SALIDA: un renglón `⚠️ bench-copied-deps: <caso>: …` por aviso y un resumen; public-ci.sh sube cada `⚠️` como aviso del
 * pedido, como los de control-size. Sale 0 siempre;
 * lo que no puede medir lo dice («no pude medir»), nunca calla.
 */
const path = require('path');
const { spawnSync } = require('child_process');

const CASOS = 'scripts/controls-bench/cases';

function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${(r.stderr || '').trim().split('\n')[0]}`);
  return r.stdout;
}

/** El texto de `ruta` en el commit `rev`, o null si no existe ahí. */
function enCommit(root, rev, ruta) {
  const r = spawnSync('git', ['-C', root, 'show', `${rev}:${ruta}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/** Los textos de un JSON (los valores, a cualquier profundidad). */
function textos(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) textos(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) textos(x, out);
  return out;
}

/** Las rutas que copia un comando: cada `$TCG/<ruta>` o `${TCG}/<ruta>`, sin la barra final. */
function copiadas(texto) {
  const out = new Set();
  for (const m of texto.matchAll(/\$\{?TCG\}?\/([A-Za-z0-9_.\-/]+)/g)) out.add(m[1].replace(/\/+$/, ''));
  return out;
}

const cubre = (copias, ruta) => [...copias].some((c) => ruta === c || ruta.startsWith(`${c}/`));

/**
 * ¿La posición `i` está adentro de un bloque `try`? Cuenta las llaves desde el último `try {` anterior. Un `require`
 * ahí tiene su salida si el archivo falta (el gancho carga igual), así que no se avisa. Las llaves dentro de un texto
 * pueden confundirlo: es un aviso, no un freno.
 */
function enUnTry(texto, i) {
  const antes = texto.slice(0, i);
  for (const m of [...antes.matchAll(/\btry\s*\{/g)].reverse()) {
    let hondo = 1;
    for (const c of antes.slice(m.index + m[0].length)) {
      if (c === '{') hondo += 1;
      else if (c === '}' && (hondo -= 1) === 0) break;
    }
    if (hondo > 0) return true;
  }
  return false;
}

/** Los `require` locales de un texto, resueltos a rutas del repo desde la carpeta del archivo (sin los de un `try`). */
function dependencias(texto, archivo, existe) {
  const out = new Set();
  for (const m of texto.matchAll(/require\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g)) {
    if (enUnTry(texto, m.index)) continue;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(archivo), m[2]));
    const candidatas = [base, `${base}.js`, `${base}.json`, `${base}/index.js`];
    out.add(candidatas.find(existe) || base);
  }
  return out;
}

function medir(root, rango) {
  const m = /^(.+?)\.\.\.?(.+)$/.exec(rango);
  if (!m) throw new Error(`el rango «${rango}» no es <base>...<punta>`);
  const [, base, punta] = m;
  const cambiados = git(root, ['diff', '--name-only', `${base}...${punta}`]).split('\n').filter((f) => /\.(c|m)?js$/.test(f));
  if (!cambiados.length) return { avisos: [], mirados: 0 };
  const enPunta = new Set(git(root, ['ls-tree', '-r', '--name-only', punta]).split('\n').filter(Boolean));
  const existe = (ruta) => enPunta.has(ruta);
  // cada comando que copia, con su caso
  const comandos = [];
  for (const caso of [...enPunta].filter((f) => f.startsWith(`${CASOS}/`) && f.endsWith('.json'))) {
    let json;
    try { json = JSON.parse(enCommit(root, punta, caso)); } catch (e) { throw new Error(`no pude leer ${caso}: ${e.message}`); }
    for (const t of textos(json)) {
      const copias = copiadas(t);
      if (copias.size) comandos.push({ caso, copias });
    }
  }
  const avisos = [];
  const vistos = new Set();
  let mirados = 0;
  for (const archivo of cambiados) {
    const usan = comandos.filter((c) => c.copias.has(archivo));
    if (!usan.length) continue;
    mirados += 1;
    const ahora = enCommit(root, punta, archivo);
    if (ahora === null) continue;
    const antes = enCommit(root, base, archivo);
    const viejas = antes === null ? new Set() : dependencias(antes, archivo, existe);
    for (const dep of dependencias(ahora, archivo, existe)) {
      if (viejas.has(dep)) continue;
      for (const { caso, copias } of usan) {
        const clave = `${caso}\n${archivo}\n${dep}`;
        if (cubre(copias, dep) || vistos.has(clave)) continue;
        vistos.add(clave);
        avisos.push({ caso, archivo, dep });
      }
    }
  }
  return { avisos, mirados };
}

function main(argv) {
  let root = path.resolve(__dirname, '..', '..');
  let rango = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') root = path.resolve(argv[(i += 1)]);
    else if (argv[i] === '--range') rango = argv[(i += 1)];
  }
  if (!rango) { console.log('bench-copied-deps: sin --range no aplica (mira lo que el pedido cambia)'); return 0; }
  let r;
  try { r = medir(root, rango); } catch (e) { console.log(`⚠️ bench-copied-deps: no pude medir: ${e.message}`); return 0; }
  for (const { caso, archivo, dep } of r.avisos) {
    console.log(`⚠️ bench-copied-deps: ${caso}: el caso copia ${archivo} a mano y no copia ${dep}, que el pedido le suma: en la copia chica del banco de la base el gancho no carga. Sumá ${dep} a la copia del caso (con $(ls …) si todavía no está en main).`);
  }
  if (r.avisos.length) console.log(`⚠️ bench-copied-deps: ${r.avisos.length} dependencia(s) nueva(s) que los casos del banco no copian (el banco de la base corre en la cola, no acá)`);
  else console.log(`✅ bench-copied-deps: ${r.mirados} archivo(s) que los casos copian a mano, sin dependencias nuevas sin copiar`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { copiadas, dependencias, medir };
