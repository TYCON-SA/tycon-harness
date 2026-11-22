'use strict';
/**
 * slow-suites-goal.test.js — la meta de las suites lentas, contra su registro (`slow-suites-goal.json`).
 *
 * La suite completa del arnés tiene que tardar menos de 20 min de reloj en la Mac de quien mantiene. Las suites que se
 * bajan para llegar se bajan en su tiempo, no en lo que prueban: los mismos casos, cada uno rojo cuando se rompe lo que
 * mira, y nada escondido (ni a la noche, ni salteado, ni con el tope achicado, ni fuera de la lista). Este guion lee el
 * registro y compara cada suite bajada con su versión del commit de la medición de antes. El antes y el después se miden
 * en un día normal, con la carga que haya y la regla de trabajadores sin variable; si el después no llega a 20 min, el
 * registro dice cuánto falta y trae la excepción escrita del dueño. Las partes de GitHub traen siempre su corrida de antes;
 * la de después sale de la CI del pedido y se anota antes de cerrar la historia.
 *
 *   T18 Lentas_TablaCompletaEnElRegistro — las dos mediciones, las bajadas con su meta, las partes de GitHub
 *   T19 Lentas_MismosCasos               — cada suite bajada tiene los mismos casos que en el commit de antes
 *   T20 Lentas_RomperDaRojo              — cada bajada dice qué se rompió y qué caso suyo dio rojo
 *   T21 Guia_TrabajadoresLentasYBase     — las dos guías: cuántas a la vez y por qué, las lentas, la base del portón
 *   T22 Lentas_NadaSeEscondio            — ni a la noche, ni salteado, ni tope menor, ni fuera de suites.json
 *   T30 Lentas_MedicionConCarga          — el antes y el después también en un día normal, con su carga
 *
 * 🔴 Falla con: un registro sin medir, un después sobre la meta sin lo que falta o sin la excepción del dueño, una meta
 *    de suite mal calculada, una suite con un caso de menos o renombrado, un `skip`
 *    nuevo, un peso o un tope menor, o una suite que pasó a correr sólo cuando se la toca.
 * stable-data: no crea commits ni lee el reloj; de git sólo lee el propio clon (`show`, `cat-file -e` y `rev-parse`).
 * 0 deps (node:test). Lee git del propio clon; sin el commit de antes (un clon recortado, o el árbol armado del privado,
 * que no trae la historia del público), T19 y T22 lo dicen y no miden.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const REGISTRO = path.join(__dirname, 'slow-suites-goal.json');
const META_RELOJ_S = 20 * 60;

const registro = () => JSON.parse(fs.readFileSync(REGISTRO, 'utf8'));
const git = (...a) => spawnSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const enCommit = (commit, rel) => {
  const r = git('show', `${commit}:${rel}`);
  return r.status === 0 ? r.stdout : null;
};
/**
 * ¿Está el commit en este clon? Puede faltar en un clon recortado o en una copia sin la historia del público (el árbol
 * que arma el privado con el público encima): ahí la comparación no se mide, y se dice, porque no es un verde.
 */
function commitDisponible(t, commit) {
  if (git('cat-file', '-e', `${commit}^{commit}`).status === 0) return true;
  const recortado = git('rev-parse', '--is-shallow-repository').stdout.trim() === 'true';
  t.skip(`NO MEDIDO: ${recortado ? 'clon recortado' : 'copia sin la historia del público'}, sin el commit de antes (${commit}). No es un verde.`);
  return false;
}

/** Los casos de una suite: los nombres de `test(`/`it(`/`describe(` en node:test; en bash, sus `T<n>` y lo que nombra `corre`. */
function casos(archivo, texto) {
  const out = new Set();
  if (/\.(?:c|m)?js$/.test(archivo)) {
    for (const m of texto.matchAll(/\b(?:test|it|describe)\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) out.add(m[2]);
  } else {
    for (const m of texto.matchAll(/\bT\d+[a-z]?\b/g)) out.add(m[0]);
    for (const m of texto.matchAll(/\bcorre\s+([A-Za-z][\w-]*)/g)) out.add(m[1]);
  }
  return [...out].sort();
}
const saltos = (texto) => (texto.match(/\.(?:skip|todo)\s*\(|\b(?:skip|todo)\s*:\s*(?!false\b)[^,}\s]/g) || []).length;
const topes = (texto) => [...texto.matchAll(/\btimeout\s*[:=]\s*(\d[\d_]*)/g)].map((m) => Number(m[1].replace(/_/g, ''))).sort((a, b) => b - a);

/** Las hojas numéricas de `obj` cuya ruta nombra a `nombre` o es un `factor`/`floor` de un tope, con su ruta. */
function numerosDe(obj, nombre, ruta = [], out = new Map()) {
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) numerosDe(v, nombre, [...ruta, k], out);
  } else if (typeof obj === 'number' && (ruta.includes(nombre) || /^(?:factor|floor)$/.test(ruta[ruta.length - 1]))) {
    out.set(ruta.join('.'), obj);
  }
  return out;
}
const entradaDe = (suites, archivo) => [...(suites.diarias || []), ...(suites.semanales || [])].find((e) => {
  const base = e.raiz === 'agent-skills' ? 'skills' : 'scripts';
  return `${base}/${e.ruta}` === archivo;
});

test('T18 Lentas_TablaCompletaEnElRegistro — las dos mediciones, las bajadas con su meta y las partes de GitHub', () => {
  const r = registro();
  for (const k of ['antes', 'despues']) {
    const m = r[k];
    assert.ok(m && typeof m === 'object', `falta la medición «${k}»: el registro no está medido`);
    assert.match(String(m.commit), /^[0-9a-f]{40}$/, `${k}: el commit del público donde corrió`);
    assert.ok(m.fecha, `${k}: la fecha`);
    assert.ok(typeof m.carga === 'number', `${k}: la carga al arrancar`);
    assert.ok(Number.isInteger(m.trabajadores) && m.trabajadores > 0, `${k}: cuántas a la vez`);
    for (const c of ['suites', 'reloj_s', 'suma_s']) assert.ok(Number(m[c]) > 0, `${k}: ${c}`);
  }
  assert.notEqual(r.despues.commit, r.antes.commit, 'el después corre en otro commit que el antes');
  if (r.despues.reloj_s >= META_RELOJ_S) {
    assert.equal(r.despues.falta_s, r.despues.reloj_s - META_RELOJ_S + 1,
      `la suite completa tarda ${r.despues.reloj_s} s: falta_s dice cuánto falta para menos de ${META_RELOJ_S}`);
    assert.match(String(r.despues.excepcion || ''), /dueñ/, 'el después no llega a la meta y no tiene la excepción del dueño');
  }
  assert.ok(r.bajadas.length > 0, 'ninguna suite bajada');
  for (const b of r.bajadas) {
    assert.ok(b.archivo && b.cambio, `una bajada sin archivo o sin lo que se cambió: ${JSON.stringify(b)}`);
    assert.equal(b.meta_s, Math.max(Math.ceil(b.antes_s / 2), 60), `${b.archivo}: la meta es la mitad de ${b.antes_s} s o 60 s`);
    assert.ok(b.despues_s <= b.meta_s || /dueñ/.test(String(b.excepcion || '')),
      `${b.archivo}: tarda ${b.despues_s} s, la meta es ${b.meta_s} s y no tiene la excepción del dueño`);
  }
  assert.ok(r.github.length > 0, 'faltan las partes de GitHub');
  for (const g of r.github) {
    assert.ok(g.parte && g.corrida_antes, `una parte sin su nombre o su corrida de antes: ${JSON.stringify(g)}`);
    assert.ok(Number(g.antes_s) > 0, `${g.parte}: los segundos de antes`);
    if (g.despues_s != null || g.corrida_despues != null) {
      assert.ok(Number(g.despues_s) > 0 && g.corrida_despues, `${g.parte}: los segundos de después con su corrida`);
    }
  }
});

test('T19 Lentas_MismosCasos — cada suite bajada tiene los mismos casos que en el commit de antes', (t) => {
  const r = registro();
  assert.ok(r.antes && r.bajadas.length > 0, 'el registro no está medido');
  if (!commitDisponible(t, r.antes.commit)) return;
  for (const b of r.bajadas) {
    const antes = enCommit(r.antes.commit, b.archivo);
    assert.ok(antes !== null, `${b.archivo} no existía en el commit de antes`);
    const ahora = fs.readFileSync(path.join(ROOT, b.archivo), 'utf8');
    assert.ok(casos(b.archivo, antes).length > 0, `${b.archivo}: no encontré sus casos`);
    // lo que se mira es que bajar el tiempo no sacó ni renombró un caso; una prueba nueva de otra historia puede sumarse
    const hoy = new Set(casos(b.archivo, ahora));
    assert.deepEqual(casos(b.archivo, antes).filter((c) => !hoy.has(c)), [], `${b.archivo}: faltan casos del commit de antes`);
  }
});

test('T20 Lentas_RomperDaRojo — cada bajada dice qué se rompió y qué caso suyo dio rojo', () => {
  const r = registro();
  assert.ok(r.bajadas.length > 0, 'el registro no está medido');
  for (const b of r.bajadas) {
    assert.ok(String(b.rompi || '').trim(), `${b.archivo}: falta qué se rompió a propósito`);
    const lista = casos(b.archivo, fs.readFileSync(path.join(ROOT, b.archivo), 'utf8'));
    assert.ok(lista.some((c) => String(b.caso_rojo || '').includes(c)), `${b.archivo}: «${b.caso_rojo}» no es uno de sus casos`);
  }
});

test('T21 Guia_TrabajadoresLentasYBase — las dos guías dicen cuántas a la vez y por qué, cómo ver las lentas y la base del portón', () => {
  for (const g of ['guides/test-execution-discipline.md', 'guides/piezas-del-arnes.md']) {
    const texto = g === 'guides/piezas-del-arnes.md' ? require('./lib/pieces-guide.js').piecesText(ROOT) : fs.readFileSync(path.join(ROOT, g), 'utf8');
    assert.match(texto, /núcleos menos dos/, `${g}: cuántas suites corren a la vez`);
    assert.match(texto, /dos núcleos (?:quedan )?para la persona/i, `${g}: por qué no más`);
    assert.match(texto, /suite-times\.js slow/, `${g}: cómo se listan las lentas`);
    assert.match(texto, /bifurcación con main/, `${g}: un portón a mano acota desde la bifurcación con main`);
  }
});

test('T30 Lentas_MedicionConCarga — el antes y el después también en un día normal, con su carga y sus trabajadores', () => {
  const r = registro();
  for (const k of ['antes_con_carga', 'despues_con_carga']) {
    const m = r[k];
    assert.ok(m && typeof m === 'object', `falta la medición «${k}»`);
    assert.match(String(m.commit), /^[0-9a-f]{40}$/, `${k}: el commit`);
    assert.ok(m.fecha, `${k}: la fecha`);
    assert.ok(typeof m.carga === 'number', `${k}: la carga al arrancar`);
    assert.ok(Number.isInteger(m.trabajadores) && m.trabajadores > 0, `${k}: cuántas a la vez`);
    for (const c of ['suites', 'reloj_s', 'suma_s']) assert.ok(Number(m[c]) > 0, `${k}: ${c}`);
  }
  assert.equal(r.antes_con_carga.commit, r.antes.commit, 'el antes con carga corre en el commit del antes');
  assert.equal(r.despues_con_carga.commit, r.despues.commit, 'y el después en el del después');
});

test('T22 Lentas_NadaSeEscondio — ni a la noche, ni salteado, ni tope menor, ni fuera de suites.json', (t) => {
  const r = registro();
  assert.ok(r.antes && r.bajadas.length > 0, 'el registro no está medido');
  if (!commitDisponible(t, r.antes.commit)) return;
  const leer = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const suitesAhora = JSON.parse(leer('scripts/tests/suites.json'));
  const suitesAntes = JSON.parse(enCommit(r.antes.commit, 'scripts/tests/suites.json'));
  const pesadasAhora = leer('scripts/ci/heavy-suites.json');
  const pesadasAntes = enCommit(r.antes.commit, 'scripts/ci/heavy-suites.json') || '';
  const pesosAhora = JSON.parse(leer('scripts/ci/suites-weights.json'));
  const pesosAntes = JSON.parse(enCommit(r.antes.commit, 'scripts/ci/suites-weights.json'));
  const topePortables = (s) => Number((/TYCON_PORTABLE_CAP_MS \|\| (\d+)/.exec(s) || [])[1]);
  assert.ok(topePortables(leer('scripts/tests/portable-suites.test.sh')) >= topePortables(enCommit(r.antes.commit, 'scripts/tests/portable-suites.test.sh')),
    'el tope de las portables bajó');
  for (const b of r.bajadas) {
    const nombre = path.basename(b.archivo);
    const ahora = entradaDe(suitesAhora, b.archivo);
    const antes = entradaDe(suitesAntes, b.archivo);
    assert.ok(ahora, `${b.archivo} salió de suites.json`);
    if (antes && !antes.gate_only_when_touching) assert.ok(!ahora.gate_only_when_touching, `${b.archivo}: pasó a correr sólo cuando se la toca`);
    const veces = (texto) => texto.split(nombre).length - 1;
    assert.ok(veces(pesadasAhora) <= veces(pesadasAntes), `${b.archivo}: entró a heavy-suites.json`);
    const pa = numerosDe(pesosAntes, nombre);
    const pn = numerosDe(pesosAhora, nombre);
    for (const [k, v] of pa) assert.ok(pn.has(k) && pn.get(k) >= v, `${b.archivo}: suites-weights.json ${k} bajó de ${v} a ${pn.get(k)}`);
    const codigoAntes = enCommit(r.antes.commit, b.archivo);
    const codigoAhora = leer(b.archivo);
    assert.ok(saltos(codigoAhora) <= saltos(codigoAntes), `${b.archivo}: un caso salteado o pendiente nuevo`);
    const ta = topes(codigoAntes);
    const tn = topes(codigoAhora);
    assert.ok(tn.length >= ta.length && ta.every((v, i) => tn[i] >= v), `${b.archivo}: un tope menor (${ta} → ${tn})`);
  }
});
