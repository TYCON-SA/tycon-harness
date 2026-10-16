#!/usr/bin/env node
'use strict';
// stable-test-data.test.js — una prueba nueva no depende de un sha ni de una hora que cambian.
// stable-data: este archivo nombra las formas en sus textos de laboratorio a propósito; no crea commits ni lee el reloj.
//
// Por qué existe: las pruebas que salen rojas de a ratos casi nunca tienen un error en el código que miden. Tienen un
// dato que cambia en cada corrida. Dos casos de octubre de 2026:
//   · internal-history.test.js armaba commits en el momento: el sha cambiaba en cada corrida y, cuando sus primeros
//     8 caracteres salían sólo dígitos (~2,3 %), la regla que pide dígito y letra no lo veía. Tres casos en rojo.
//   · harness-plan.test.sh, harness-repoint.test.sh y harness-update.test.sh hacían `git commit` sin apagar el
//     mantenimiento automático de git, que queda corriendo desprendido y toca el `.git` del laboratorio
//     (`objects/maintenance.lock`) mientras la prueba saca su huella. Con git 2.55+ y la máquina cargada, rojo.
//
// Lo que no se puede perder (StableData_RealRepo_Clean):
//   · toda prueba que crea commits fija GIT_AUTHOR_DATE y GIT_COMMITTER_DATE (el sha sale siempre igual) y apaga el
//     mantenimiento automático de git (`maintenance.auto=false`, o `harness_lab_git` / `harness_lab_no_auto_maintenance`);
//   · toda prueba que lee el reloj de verdad (`Date.now()`, `new Date()` sin argumentos, `$(date …)`) inyecta la fecha
//     con una variable del arnés (`TYCON_TODAY`, `TYCON_…_NOW`, `TYCON_…_TODAY`) o dice por qué no hace falta con un
//     comentario `stable-data: <motivo>`;
//   · las pruebas que ya existían y no cumplen están en la lista de abajo, que sólo puede achicarse: si una ya cumple o
//     ya no existe, este control pide sacarla;
//   · nunca verde sin mirar: si encontró pocas pruebas, es rojo.
//
// Lo que el control NO ve (mira texto, no ejecuta): un sha o una hora que llegan por otro camino (un archivo que otro
// guion escribió, un `git log` de un repo ajeno). La regla escrita está en guides/test-execution-discipline.md.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// La regla vive en scripts/lib/stable-test-data.js: la usa también el freno de antes del commit, sobre las pruebas que el
// commit trae.
const regla = require('../lib/stable-test-data.js');
const { faltas } = regla;

const RAIZ = path.resolve(__dirname, '..', '..');
const FECHAS = regla.DATES;
const LISTAS = regla.BASELINES.map((f) => path.join(RAIZ, f));

/** Las pruebas: los .js y .sh que viven bajo una carpeta `tests`, en `scripts/` y `skills/`. */
function pruebas(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) pruebas(p, out);
    else if (regla.isTestFile(relativa(p))) out.push(p);
  }
  return out;
}

function relativa(f) { return path.relative(RAIZ, f).split(path.sep).join('/'); }

test('StableData_Detector_SeesFormsNotOthers — ve cada forma y no ve las que no son el caso', () => {
  // crean commits sin fechas ni mantenimiento apagado
  for (const si of ['git -C "$R" commit -q -m x', 'git commit --allow-empty -m y', "gitIn(work, ['commit', '--quiet', '-m', 'z']);", 'git commit-tree "$T" -m w',
    'g -C "$R" commit -q -m v', 'sk commit --allow-empty -m t', 'git -C "$R" \\\n  commit -q -m s']) {
    const f = faltas(si, si.includes('gitIn') ? 'lab.js' : 'lab.sh');
    assert.deepStrictEqual(f.commits, [...FECHAS, 'el mantenimiento automático de git apagado'], `no vio: ${si}`);
  }
  // leen el reloj sin inyectarlo
  for (const [si, ruta] of [['const t = Date.now();', 'lab.js'], ['const d = new Date();', 'lab.js'], ['HOY="$(date +%F)"', 'lab.sh'], ['H=`date -u`', 'lab.sh']]) {
    assert.strictEqual(faltas(si, ruta).reloj, true, `no vio: ${si}`);
  }
  // lo que no es el caso
  for (const [no, ruta] of [
    ['# git commit -m en un comentario', 'lab.sh'],
    ['// gitIn(work, [\'commit\'])', 'lab.js'],
    ['const d = new Date(\'2026-10-15T00:00:00Z\');', 'lab.js'],
    ['git log --oneline', 'lab.sh'],
    ['echo "commits del día"', 'lab.sh'],
    ['echo "hacé commit y después push"', 'lab.sh'],
    ['say(`en el commit ${r.meta.copy_commit}`);', 'lab.js'],
    ['mal "engram-pre-commit $(cuantos x)"', 'lab.sh'],
    ['/* el viejo hacía\n * git commit -q -m x y Date.now()\n */', 'lab.js'],
  ]) {
    const f = faltas(no, ruta);
    assert.ok(f.commits === null && f.reloj === false, `vio de más: ${no}`);
  }
});

test('StableData_NewCommitWithoutDatesOrMaintenanceOff_Red — commits sin fechas fijas, o sin apagar el mantenimiento', () => {
  const conFechas = 'export GIT_AUTHOR_DATE=2026-01-01T00:00:00Z GIT_COMMITTER_DATE=2026-01-01T00:00:00Z\ngit commit -q -m x\n';
  assert.deepStrictEqual(faltas(conFechas, 'lab.sh').commits, ['el mantenimiento automático de git apagado']);
  const conTodo = `${conFechas}git -c maintenance.auto=false -c gc.auto=0 commit -q -m y\n`;
  assert.strictEqual(faltas(conTodo, 'lab.sh').commits, null);
  const conLaboratorio = 'GIT_AUTHOR_DATE=1 GIT_COMMITTER_DATE=1 harness_lab_git "$R" commit -q -m z\n';
  assert.strictEqual(faltas(conLaboratorio, 'lab.sh').commits, null, 'harness_lab_git apaga el mantenimiento');
  assert.deepStrictEqual(faltas('harness_lab_git "$R" commit -q -m z\n', 'lab.sh').commits, FECHAS, 'por el envoltorio: ve el commit, le faltan las fechas');
  assert.deepStrictEqual(faltas('git -c maintenance.auto=false commit -q -m x\n', 'lab.sh').commits, FECHAS);
  // nombrarlas en un comentario no es fijarlas
  const soloComentario = '# GIT_AUTHOR_DATE GIT_COMMITTER_DATE maintenance.auto\ngit commit -q -m x\n';
  assert.deepStrictEqual(faltas(soloComentario, 'lab.sh').commits, [...FECHAS, 'el mantenimiento automático de git apagado']);
  // la declaración vale en un comentario, no dentro de un texto del código
  assert.notStrictEqual(faltas("const nota = 'stable-data: no';\ngitIn(r, ['commit', '-m', 'x']);", 'lab.js').commits, null);
  assert.strictEqual(faltas("// stable-data: prueba el orden por fecha\ngitIn(r, ['commit', '-m', 'x']);", 'lab.js').commits, null);
});

test('StableData_NewClockRead_Red — el reloj de verdad, salvo inyectado o declarado', () => {
  assert.strictEqual(faltas('const t = Date.now();', 'lab.js').reloj, true);
  assert.strictEqual(faltas('const env = { TYCON_TODAY: "2026-10-15" };\nconst t = Date.now();', 'lab.js').reloj, false, 'inyectada');
  assert.strictEqual(faltas('// stable-data: mide cuánto tarda, no compara la hora\nconst t = Date.now();', 'lab.js').reloj, false, 'declarada');
  assert.strictEqual(faltas('# stable-data:\nHOY="$(date +%F)"', 'lab.sh').reloj, true, 'una declaración sin motivo no vale');
});

/** Cada lista que existe, con sus dos reglas. La del público es obligatoria: sin ella no hay trinquete. */
function leerListas() {
  assert.ok(fs.existsSync(LISTAS[0]), `falta ${relativa(LISTAS[0])}`);
  return regla.readBaselinesFromDisk(RAIZ).map((l) => ({ ...l, archivo: path.join(RAIZ, l.file) }));
}

test('StableData_Baseline_OnlyShrinks — la lista de las que ya existían sólo puede achicarse', () => {
  for (const lista of leerListas()) {
    const sobran = [];
    for (const regla of ['commits', 'reloj']) {
      for (const r of lista[regla]) {
        const abs = path.join(RAIZ, r);
        if (!fs.existsSync(abs)) { sobran.push(`${r} (${regla}): ya no existe`); continue; }
        const f = faltas(fs.readFileSync(abs, 'utf8'), abs);
        if (regla === 'commits' ? f.commits === null : !f.reloj) sobran.push(`${r} (${regla}): ya cumple`);
      }
      assert.deepStrictEqual(lista[regla], [...new Set(lista[regla])].sort(), `${relativa(lista.archivo)} · ${regla}: la lista va ordenada y sin repetidos`);
    }
    assert.deepStrictEqual(sobran, [], `sacalas de ${relativa(lista.archivo)}: la lista sólo guarda las que todavía no cumplen\n  ${sobran.join('\n  ')}`);
  }
});

test('StableData_RealRepo_Clean — ninguna prueba nueva depende de un sha ni de una hora que cambian', () => {
  const todas = regla.FOLDERS.filter((c) => fs.existsSync(path.join(RAIZ, c))).flatMap((c) => pruebas(path.join(RAIZ, c)));
  assert.ok(todas.length > 100, `pocas pruebas (${todas.length}): no miré lo que debía`);
  const listas = leerListas();
  const enLista = { commits: new Set(listas.flatMap((l) => l.commits)), reloj: new Set(listas.flatMap((l) => l.reloj)) };
  const nuevas = [];
  for (const f of todas) {
    const r = relativa(f);
    const falta = faltas(fs.readFileSync(f, 'utf8'), f);
    if (falta.commits && !enLista.commits.has(r)) nuevas.push(`${r}: crea commits sin ${falta.commits.join(', ')}`);
    if (falta.reloj && !enLista.reloj.has(r)) nuevas.push(`${r}: lee el reloj sin inyectar la fecha (TYCON_TODAY, TYCON_…_NOW) ni declarar «stable-data: <motivo>»`);
  }
  assert.deepStrictEqual(nuevas, [], `una prueba que depende de un sha o de una hora sale roja de a ratos (guides/test-execution-discipline.md):\n  ${nuevas.join('\n  ')}`);
});
