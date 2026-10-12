'use strict';

/**
 * code-identifiers.test.js — el buscador de identificadores de código en una copia (story 8.10.3, tanda D · T17).
 *
 * `scripts/publishing/code-identifiers.js` contesta una sola pregunta: ¿sale en esta carpeta un identificador de código
 * de la lista de denegación, escrito con CUALQUIER grafía? Lo usa `export-real.test.sh` (bloque «8.10.3 D») sobre la
 * copia pública de verdad, con la lista privada; esa suite tarda y no corre en cada cambio, así que la lógica se prueba
 * acá, con una lista y una copia de laboratorio (nombres inventados: `ZetaPanel`, `QX-7-lotes`…).
 *
 * Cada caso es un hallazgo confirmado por el pase adversarial de la tanda, con su rojo antes del arreglo:
 *   · un identificador que aplanado mide menos que escrito no se veía nunca;
 *   · no se miraban los nombres de archivos ni de carpetas;
 *   · una palabra más larga que contiene al identificador («Sprint…» por «…Print…») y una palabra común daban rojo;
 *   · un separador repetido o escapado partía el nombre, y uno que empieza con un dígito no se veía;
 *   · el verde decía haber mirado identificadores que no podía ver.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MODULE = path.resolve(__dirname, '..', 'publishing', 'code-identifiers.js');
const ci = require(MODULE);

const term = (patron, extra = {}) => ({ patron, categoria: 'interno', mayusculas: true, ...extra });
// 30 de relleno (el buscador se niega a opinar con una lista más corta que lo que la tanda sumó) + los de cada caso
const RELLENO = Array.from({ length: 30 }, (_, i) => term(`Relleno${String.fromCharCode(65 + (i % 26))}Cosa${i}`));
const LISTA = [
  ...RELLENO,
  term('ZetaPanel'),
  term('QX-7-lotes'),                       // escrito mide 10; aplanado, 8
  term('usarZetaStore'),
  term('7zeta-lote-final'),                // empieza con un dígito
  term('ZonaRecreo', { noVe: ['zonarecreo'] }),   // en minúscula y pegado es una palabra común: su término lo declara
  { patron: 'ZetaCorp', categoria: 'cliente' },                             // no es interno: no es de este buscador
  { patron: 'ZetaRepo', categoria: 'interno', mayusculas: true, palabra: true },   // de palabra entera: lo ve el detector
  term('Zeta'),                                                             // una sola parte: no es un identificador de código
];

function copia(archivos) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-ids-'));
  for (const [ruta, texto] of Object.entries(archivos)) {
    const abs = path.join(dir, ruta);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, texto);
  }
  return dir;
}
const ids = ci.identifiersFrom(LISTA);
const donde = (archivos) => ci.scanCopy(copia(archivos), ids).hallazgos.map((h) => h.donde).sort();

test('CodeIdentifiers_FromList_OnlyCodeIdentifiers — internos, de caja exacta, pegables, con dos partes o más', () => {
  const patrones = ids.map((x) => x.patron);
  for (const p of ['ZetaPanel', 'QX-7-lotes', 'usarZetaStore', '7zeta-lote-final', 'ZonaRecreo']) assert.ok(patrones.includes(p), p);
  for (const p of ['ZetaCorp', 'ZetaRepo', 'Zeta']) assert.ok(!patrones.includes(p), `${p} no es un identificador de código`);
  assert.equal(ids.length, 35);
  // cada uno lleva su posición en la lista: el rojo nombra al término por su número, nunca por su texto
  assert.equal(ids.find((x) => x.patron === 'ZetaPanel').indice, 30);
});

test('CodeIdentifiers_EverySpelling_IsSeen — la misma cosa con otra grafía es el mismo identificador', () => {
  const grafias = ['ZetaPanel', 'zeta-panel', 'zeta_panel', 'ZETA_PANEL', 'zeta.panel', 'zetapanel', 'ZETAPANEL', 'zetaPanel',
    'abrirZetaPanel', 'ZetaPanelProps', 'IZetaPanel', 'zeta__panel', 'zeta--panel', 'zeta\\_panel', 'ZETA__PANEL'];
  for (const g of grafias) assert.deepEqual(donde({ 'a.md': `mirar ${g} acá\n` }), ['a.md:1'], g);
});

test('CodeIdentifiers_FlattenedShorterThanWritten_IsSeen — el largo se mide aplanado en los dos lados', () => {
  for (const g of ['QX-7-lotes', 'qx-7-lotes', 'QX_7_LOTES', 'Qx7Lotes', 'qx.7.lotes', 'qx7lotes']) {
    assert.deepEqual(donde({ 'a.md': `los pasos están en ${g}, mirar\n` }), ['a.md:1'], g);
  }
});

test('CodeIdentifiers_StartsWithDigit_IsSeen', () => {
  for (const g of ['7zeta-lote-final', '7zeta_lote_final', '7ZetaLoteFinal']) assert.deepEqual(donde({ 'a.md': `id ${g}\n` }), ['a.md:1'], g);
});

test('CodeIdentifiers_FileAndFolderNames_AreLooked — el nombre de un archivo o de una carpeta también es texto de la copia', () => {
  assert.deepEqual(donde({ 'src/zeta-panel.test.tsx': 'neutro\n' }), ['src/zeta-panel.test.tsx (nombre)']);
  assert.deepEqual(donde({ 'src/zeta_panel/index.md': 'neutro\n' }), ['src/zeta_panel (nombre)']);
  assert.deepEqual(donde({ 'src/USAR_ZETA_STORE.ts': 'neutro\n' }), ['src/USAR_ZETA_STORE.ts (nombre)']);
  // un binario no se lee, pero su nombre se mira igual
  const dir = copia({ 'x/zeta-panel.png': 'x' });
  fs.writeFileSync(path.join(dir, 'x', 'zeta-panel.png'), Buffer.from([0, 1, 2, 0]));
  assert.deepEqual(ci.scanCopy(dir, ids).hallazgos.map((h) => h.donde), ['x/zeta-panel.png (nombre)']);
});

test('CodeIdentifiers_LongerWordOrCommonWord_IsNotFlagged — otra palabra que lo contiene no es el identificador', () => {
  // empieza o termina en el medio de una palabra: es otra palabra
  for (const g of ['PizzetaPanel', 'pizzeta-panel', 'ZetaPanelista', 'zetapanelista', 'mizetapanel', 'RazetaPanelo']) {
    assert.deepEqual(donde({ 'a.md': `el componente ${g}\n` }), [], g);
  }
  // la palabra común que su propio término declara en `noVe`; con otra grafía sigue siendo el identificador
  assert.deepEqual(donde({ 'a.md': 'probalo en la zonarecreo de la API\n' }), []);
  for (const g of ['ZonaRecreo', 'zona-recreo', 'ZONA_RECREO']) assert.deepEqual(donde({ 'a.md': `ver ${g}\n` }), ['a.md:1'], g);
  // prosa con espacios no es un nombre (la frase la ve el detector, con su término)
  assert.deepEqual(donde({ 'a.md': 'el zeta panel de la derecha\n' }), []);
  // un nombre partido entre carpetas, o por dos puntos, es otro nombre (decisión: sólo `-`, `_` y `.` son separadores)
  assert.deepEqual(donde({ 'a.md': 'ver zeta/panel.tsx y Zeta:Panel\n' }), []);
});

test('CodeIdentifiers_Finding_NamesTheTermByNumber — el rojo dice qué término, sin escribirlo', () => {
  const r = ci.scanCopy(copia({ 'a.md': 'uno zeta-panel\n', 'b.md': 'otro usar_zeta_store\n' }), ids);
  assert.deepEqual(r.hallazgos.map((h) => [h.donde, h.indice]), [['a.md:1', 30], ['b.md:1', 32]]);
  const out = ci.verdict(r, ids);
  assert.equal(out.estado, 'rojo');
  assert.match(out.mensaje, /a\.md:1 \(término 30\)/);
  assert.doesNotMatch(out.mensaje, /zeta/i, 'el mensaje no escribe el identificador');
});

test('CodeIdentifiers_SelfCheck_EveryIdentifierSeesItself — no se cuenta como mirado lo que no se puede ver', () => {
  assert.deepEqual(ci.blind(ids), [], 'cada identificador de la lista se ve a sí mismo');
  // uno que el buscador no puede ver (lo fuerzo desde afuera) no pasa en silencio: el veredicto es rojo y lo cuenta
  const ciego = { indice: 99, patron: 'Imposible Con Espacio', clave: 'imposibleconespacio', exentos: new Set() };
  assert.deepEqual(ci.blind([...ids, ciego]).map((x) => x.indice), [99]);
  const out = ci.verdict(ci.scanCopy(copia({ 'a.md': 'limpio\n' }), [...ids, ciego]), [...ids, ciego]);
  assert.equal(out.estado, 'rojo');
  assert.match(out.mensaje, /1 identificador\(es\) de la lista que este buscador no puede ver/);
});

test('CodeIdentifiers_Verdict_NeverGreenWithoutLooking', () => {
  // lista corta: no opina
  assert.equal(ci.verdict(ci.scanCopy(copia({ 'a.md': 'x\n' }), ids.slice(0, 5)), ids.slice(0, 5)).estado, 'rojo');
  // limpio: verde, y dice cuántos miró
  const limpio = ci.verdict(ci.scanCopy(copia({ 'a.md': 'nada que ver\n' }), ids), ids);
  assert.equal(limpio.estado, 'ok');
  assert.match(limpio.mensaje, /35 de la lista/);
  // una carpeta que no se deja leer es un rojo propio (no se prueba como root ni en Windows: ahí no hay cómo negarla)
  if (process.platform !== 'win32' && process.getuid && process.getuid() !== 0) {
    const dir = copia({ 'ok.md': 'x\n', 'cerrada/z.md': 'zeta-panel\n' });
    fs.chmodSync(path.join(dir, 'cerrada'), 0o000);
    try {
      const r = ci.scanCopy(dir, ids);
      assert.equal(r.sinLeer.length, 1);
      assert.equal(ci.verdict(r, ids).estado, 'rojo');
    } finally { fs.chmodSync(path.join(dir, 'cerrada'), 0o755); }
  }
});

test('CodeIdentifiers_Cli_PrintsOneVerdictLine — como lo llama export-real.test.sh', () => {
  const lista = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'code-ids-lista-')), 'denylist.json');
  fs.writeFileSync(lista, JSON.stringify({ terminos: LISTA }));
  const correr = (dir, l = lista) => spawnSync(process.execPath, [MODULE, '--label', 'prueba: caso ·', dir, l], { encoding: 'utf8' });
  const sucio = correr(copia({ 'a.md': 'zeta-panel\n' }));
  assert.equal(sucio.status, 0, 'el veredicto va en el texto: el que llama cuenta las líneas');
  assert.match(sucio.stdout, /^❌ prueba: caso · /);
  const limpio = correr(copia({ 'a.md': 'nada\n' }));
  assert.match(limpio.stdout, /^✅ prueba: caso · /);
  // sin la lista (la copia pública no la trae): NO MEDIDO, dicho; nunca verde
  const sinLista = correr(copia({ 'a.md': 'nada\n' }), path.join(os.tmpdir(), 'no-existe-denylist.json'));
  assert.equal(sinLista.status, 0);
  assert.match(sinLista.stdout, /^⏭ prueba: caso · NO MEDIDO/);
  // una lista que existe y no es JSON es un rojo, no «sin lista»
  const rota = path.join(path.dirname(lista), 'rota.json');
  fs.writeFileSync(rota, '{ roto');
  assert.match(correr(copia({ 'a.md': 'nada\n' }), rota).stdout, /^❌ prueba: caso · /);
});

// Revisor de fallos silenciosos (vuelta 2): con una lista de forma inesperada el proceso se caía sin imprimir ningún
// veredicto y salía 1 — justo lo que su contrato dice que no pasa. Cualquier cosa que no se pudo mirar es UNA línea ❌.
test('CodeIdentifiers_Cli_MalformedListOrMissingArgs_StillOneRedLine', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-ids-forma-'));
  const escribir = (nombre, contenido) => { const f = path.join(dir, nombre); fs.writeFileSync(f, JSON.stringify(contenido)); return f; };
  const limpia = copia({ 'a.md': 'nada\n' });
  const correr = (...args) => spawnSync(process.execPath, [MODULE, '--label', 'prueba: forma ·', ...args], { encoding: 'utf8' });
  const formas = {
    'terminos no es una lista': escribir('a.json', { terminos: { patron: 'ZetaPanel' } }),
    'terminos es un texto': escribir('b.json', { terminos: 'ZetaPanel' }),
    'un noVe que no es una lista': escribir('c.json', { terminos: [...LISTA, term('OtroPanelito', { noVe: 'otropanelito' })] }),
    'un término que no es un objeto': escribir('d.json', { terminos: [...LISTA, 'ZetaPanel', null, 7] }),
    'el archivo es una lista suelta': escribir('e.json', LISTA),
  };
  for (const [caso, lista] of Object.entries(formas)) {
    const r = correr(limpia, lista);
    assert.equal(r.status, 0, `${caso}: sale ${r.status} — ${r.stderr.slice(0, 200)}`);
    const lineas = r.stdout.trim().split('\n');
    assert.equal(lineas.length, 1, `${caso}: una sola línea de veredicto, hubo ${lineas.length}`);
    assert.match(lineas[0], /^❌ prueba: forma · /, `${caso}: no es verde ni «no medido»`);
    assert.equal(r.stderr, '', `${caso}: sin excepción suelta`);
  }
  // la lista sin la clave `terminos` no tiene identificadores: rojo por lista corta, dicho
  assert.match(correr(limpia, escribir('f.json', { patrones: [] })).stdout, /^❌ prueba: forma · la lista trae 0 identificadores/);
  // faltan argumentos: una línea ❌ con el uso
  for (const args of [[], [limpia]]) {
    const r = correr(...args);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^❌ prueba: forma · uso: code-identifiers\.js/);
  }
  // la copia que no existe no es una copia limpia
  const sinCopia = correr(path.join(dir, 'no-existe'), escribir('g.json', { terminos: LISTA }));
  assert.match(sinCopia.stdout, /^❌ prueba: forma · no pude leer 1 entrada/);
});

test('CodeIdentifiers_PartsOf_SplitsOnSeparatorsAndHumps', () => {
  assert.deepEqual(ci.partsOf('abrirZetaPanel'), ['abrir', 'zeta', 'panel']);
  assert.deepEqual(ci.partsOf('IZetaPanel'), ['i', 'zeta', 'panel']);
  assert.deepEqual(ci.partsOf('zeta-panel.test.tsx'), ['zeta', 'panel', 'test', 'tsx']);
  assert.deepEqual(ci.partsOf('ZETA__PANEL'), ['zeta', 'panel']);
  assert.deepEqual(ci.partsOf('zeta\\_panel'), ['zeta', 'panel']);
  assert.deepEqual(ci.partsOf('QX-7-lotes'), ['qx', '7', 'lotes']);
  assert.deepEqual(ci.partsOf('zetapanel'), ['zetapanel']);
  // la lista que no es una lista se dice con su motivo (no un TypeError)
  assert.throws(() => ci.identifiersFrom({ no: 'lista' }), /«terminos» tiene que ser una lista/);
  assert.throws(() => ci.identifiersFrom([term('OtroPanelito', { noVe: 'x' })]), /terminos\[0\].*«noVe» tiene que ser una lista/);
});

// Revisor de pruebas (vuelta 3): cada forma de «esto no es un término», SOLA en la lista — mezcladas con un `null`, el
// `null` ya daba rojo por otro camino y la validación podía borrarse sin que ninguna prueba lo notara.
test('CodeIdentifiers_FromList_EachMalformedTermAlone_Throws', () => {
  const formas = { 'un texto suelto': 'ZetaPanel', 'un número': 7, 'un null': null, 'una lista': ['ZetaPanel'],
    'un objeto sin patron': { categoria: 'interno', mayusculas: true }, 'un patron que no es texto': { patron: 7, categoria: 'interno', mayusculas: true } };
  for (const [caso, malo] of Object.entries(formas)) {
    assert.throws(() => ci.identifiersFrom([term('ZetaPanel'), malo]), /terminos\[1\]: no es un término/, caso);
  }
  // y por la línea de comandos, cada una sola: una línea roja que dice cuál
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-ids-solo-'));
  const limpia = copia({ 'a.md': 'nada\n' });
  for (const [caso, malo] of Object.entries(formas)) {
    const lista = path.join(dir, 'l.json');
    fs.writeFileSync(lista, JSON.stringify({ terminos: [...LISTA, malo] }));
    const r = spawnSync(process.execPath, [MODULE, '--label', 'prueba: solo ·', limpia, lista], { encoding: 'utf8' });
    assert.equal(r.status, 0, caso);
    assert.match(r.stdout, new RegExp(`^❌ prueba: solo · no pude mirar: terminos\\[${LISTA.length}\\]: no es un término`), caso);
  }
});
