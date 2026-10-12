#!/usr/bin/env node
/**
 * vacuity-audit.js — ¿los casos del banco prueban lo que dicen probar? (§5.6, 2026-08-25)
 *
 * ── LA PREGUNTA QUE CONTESTA ────────────────────────────────────────────────────────────────────
 * El plan de controles apagables dejó escrito: *"se contó cuántos scripts no tienen casos; NO se
 * verificó que los 86 casos existentes prueben lo que dicen probar"*. Y el riesgo no es teórico:
 * ya se cazaron DOS formas de caso-que-pasa-siempre (las claves de `expect` escritas como cadena,
 * que se iteraban letra por letra; y un caso cuyo laboratorio ya cumplía la condición por otra
 * vía). Un caso que no puede fallar se cuenta como cobertura y no cubre nada.
 *
 * ── EL MÉTODO: el control que no hace nada ──────────────────────────────────────────────────────
 * Cada caso AFIRMATIVO (must-block / must-run / must-emit) se vuelve a correr con su script
 * reemplazado por uno que NO HACE NADA (exit 0, sin salida, sin archivos). Un control ausente no
 * bloquea, no emite y no deja constancia — así que el caso TIENE que fallar. **Si pasa igual, el
 * caso es vacuo**: lo que asserta lo produce su propio setup, o no asserta nada real.
 *
 * Un hook puede declarar `controles`: otros programas del arnés que sus casos corren desde el setup
 * a propósito (la foto de iteración se prueba corriendo `marker.js snapshot-iter` ahí). El auditor
 * los neutraliza también, reemplazando cada mención literal en el setup por un no-op del intérprete
 * que corresponda. Sin declararlos, el caso sale vacuo: declarar es lo que pone un programa bajo
 * el auditor, correrlo no.
 *
 * Los must-not-block / must-stay-quiet NO se auditan así, a propósito: afirman que algo NO pasa,
 * y con un script mudo eso se cumple trivialmente — su valor está en ser la contracara de un caso
 * afirmativo del mismo hook, no en sí mismos.
 *
 * Reutiliza runCase/loadCaseFiles del runner (dos ejecutores del mismo caso = el drift de mañana).
 *
 * 🔴 «Falló» sólo es una respuesta si el caso CORRIÓ. Un caso que el corredor no pudo medir (en Windows sin Git for
 * Windows no hay con qué lanzar el control mudo, que es un `.sh`) también «falla», y contarlo como «prueba algo» es
 * sacar un verde de un caso que nunca corrió. Esos no se auditan: se cuentan aparte, se dice «NO MEDIDO» y se sale 2.
 *
 * Uso:  node vacuity-audit.js [--only <substr>] [--selftest]
 * Exit: 0 = ningún caso vacuo · 1 = hay casos que pasan con un control que no hace nada · 2 = hubo casos que no se
 *       pudieron medir (no se imprime ningún verde)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { runCase, loadCaseFiles, cannotMeasure } = require('./runner.js');

const AFIRMATIVOS = new Set(['must-block', 'must-run', 'must-emit']);

/**
 * El script que no hace nada — la ausencia del control, en archivo. Uno por intérprete: el `.sh`
 * reemplaza al hook (el corredor lo lanza con bash); el `.js` reemplaza a los controles que un setup
 * invoca con `node` — un `.sh` bajo `node` no es «no hacer nada», es un error de sintaxis.
 */
function noopPaths() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vacuity-'));
  const sh = path.join(d, 'noop.sh');
  fs.writeFileSync(sh, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(sh, 0o755);
  const js = path.join(d, 'noop.js');
  fs.writeFileSync(js, 'process.exit(0);\n');
  return { sh, js };
}
const noopPara = (noop, control) => (/\.(js|mjs|cjs)$/.test(control) ? noop.js : noop.sh);

/**
 * Neutraliza en el SETUP del caso todo control que el hook DECLARA (`controles`, 2026-09-17): cada
 * mención literal del control se reemplaza por su no-op. Caso real: los 10 de la foto de iteración
 * corren `marker.js snapshot-iter` en su setup y assertan lo que ÉSE escribe; con sólo `script`
 * neutralizado, el auditor los veía vacuos — 9 falsos positivos desde el 2026-09-15, y un auditor
 * que grita en falso es un auditor que se apaga. Es literal a propósito: los casos escriben
 * `${SKILLS}/…/marker.js` tal cual; un control mencionado de otra forma no se neutraliza y el caso
 * sale vacuo, que es el lado seguro.
 */
function neutralizarSetup(setup, controles, noop) {
  return (setup || []).map((cmd) => controles.reduce((s, c) => s.split(c).join(noopPara(noop, c)), String(cmd)));
}

function auditar(hookDefs, only, ctx) {
  const noop = noopPaths();
  const vacuos = [];
  const noMedidos = [];
  let corridos = 0;
  for (const hookDef of hookDefs) {
    if (only && !`${hookDef.hook}`.includes(only)) continue;
    const controles = Array.isArray(hookDef.controles) ? hookDef.controles.map(String) : [];
    for (const caseDef of hookDef.cases || []) {
      if (!AFIRMATIVOS.has(caseDef.type)) continue;
      // El script del caso (o del hook) se reemplaza por el no-op, y los controles que el hook
      // declara se neutralizan en el setup; TODO lo demás queda igual: mismo stdin, mismas aserciones.
      const mutado = { ...hookDef, script: noop.sh };
      const sinCasoScript = { ...caseDef, setup: neutralizarSetup(caseDef.setup, controles, noop) };
      delete sinCasoScript.script;
      const r = runCase('claude', mutado, sinCasoScript, ctx);
      const quien = { hook: hookDef.hook, id: caseDef.id, type: caseDef.type, file: hookDef.__file };
      if (r.nomedido) { noMedidos.push({ ...quien, motivo: r.failures.join(' | ') }); continue; }
      corridos++;
      if (r.pass) vacuos.push(quien);
    }
  }
  return { vacuos, corridos, noMedidos };
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vacself-'));
  // Un caso HONESTO: asserta un archivo que sólo el script produce.
  const honesto = {
    hook: 'honesto.sh', script: path.join(tmp, 'real.sh'), event: 'Stop', __file: 'self',
    cases: [{ id: 'produce-evidencia', type: 'must-run', stdin: {},
      expect: { file_contains: [{ path: '${FIXTURE}/salida.txt', re: 'hecho' }] } }],
  };
  fs.writeFileSync(honesto.script, '#!/bin/sh\necho hecho > "$PWD/salida.txt"\n');
  fs.chmodSync(honesto.script, 0o755);
  // Un caso VACUO: lo que asserta lo escribe su PROPIO setup.
  const vacuo = {
    hook: 'vacuo.sh', script: honesto.script, event: 'Stop', __file: 'self',
    cases: [{ id: 'la-evidencia-la-crea-el-setup', type: 'must-run',
      setup: ['echo hecho > salida.txt'], stdin: {},
      expect: { file_contains: [{ path: '${FIXTURE}/salida.txt', re: 'hecho' }] } }],
  };
  // Un caso cuya evidencia la produce OTRO control del mismo hook, invocado desde el setup — el
  // caso real: los 10 de la foto de iteración corren `marker.js snapshot-iter` ahí, y el auditor,
  // que sólo neutralizaba `script`, los vio vacuos (9 falsos positivos desde el 2026-09-15). Con
  // `controles` declarados los neutraliza a todos: la evidencia desaparece y el caso falla, que es
  // lo que prueba que no es vacuo.
  const control2 = path.join(tmp, 'control2.js');
  fs.writeFileSync(control2, 'require("fs").writeFileSync(process.cwd() + "/salida.txt", "hecho\\n");\n');
  const declarado = {
    hook: 'declarado', script: honesto.script, controles: [control2], event: 'Stop', __file: 'self',
    cases: [{ id: 'la-evidencia-la-produce-un-control-declarado', type: 'must-run',
      setup: [`node ${control2}`], stdin: {},
      expect: { file_contains: [{ path: '${FIXTURE}/salida.txt', re: 'hecho' }] } }],
  };
  // Y el espejo: el MISMO programa en el setup, sin declararlo, sigue siendo vacuo. Declarar es lo
  // que pone un programa bajo el auditor; correrlo no.
  const sinDeclarar = { ...declarado, hook: 'sin-declarar', controles: [] };
  const r1 = auditar([honesto], null);
  const r2 = auditar([vacuo], null);
  const r3 = auditar([declarado], null);
  const r4 = auditar([sinDeclarar], null);
  const checks = [
    ['un caso cuya evidencia la produce el SCRIPT no es vacuo', r1.vacuos.length === 0 && r1.corridos === 1],
    ['un caso cuya evidencia la produce su SETUP se caza como vacuo', r2.vacuos.length === 1],
    ['un caso cuya evidencia la produce un control DECLARADO del hook (corrido desde el setup) no es vacuo', r3.vacuos.length === 0 && r3.corridos === 1],
    ['el mismo programa sin declarar sigue siendo vacuo: declarar es lo que lo pone bajo el auditor', r4.vacuos.length === 1],
  ];
  let bad = 0;
  for (const [n, ok] of checks) { console.log(`${ok ? '✅' : '❌'} selftest-vacuity: ${n}`); if (!ok) bad++; }
  console.log(bad ? `❌ ${bad} rojos` : `✅ selftest-vacuity: ${checks.length}/${checks.length} verdes`);
  return bad ? 1 : 0;
}

function main(ctx) {
  if (process.argv.includes('--selftest')) return selftest();
  const i = process.argv.indexOf('--only');
  const only = i >= 0 ? process.argv[i + 1] : null;
  const why = cannotMeasure(ctx);
  if (why) {
    console.error(`🟡 vacuity — NO MEDIDO: ${why}. No se auditó ningún caso.`);
    return 2;
  }
  const { vacuos, corridos, noMedidos } = auditar(loadCaseFiles(), only, ctx);
  if (noMedidos.length) {
    // va ANTES de cualquier veredicto, y sin un solo verde: con casos sin medir no hay nada que afirmar del resto
    console.error(`🟡 vacuity — NO MEDIDO: ${noMedidos.length} caso(s) afirmativo(s) no se pudieron correr (${corridos} sí)${vacuos.length ? `, y ${vacuos.length} de los que corrieron pasan con un control que no hace nada` : ''}.`);
    console.error(`   ${noMedidos[0].motivo}`);
    console.error('   Un caso que no corrió no «falla con un control mudo»: no dice nada. Se vuelve a auditar con eso resuelto.');
    return 2;
  }
  if (!vacuos.length) {
    console.log(`✅ vacuity: ${corridos} casos afirmativos, todos FALLAN con un control que no hace nada — prueban algo de verdad.`);
    return 0;
  }
  console.error(`❌ vacuity — ${vacuos.length} de ${corridos} casos PASAN con un control que NO HACE NADA:`);
  for (const v of vacuos) console.error(`   · ${v.file} · ${v.hook}::${v.id} (${v.type}) — lo que asserta no lo produce el control`);
  console.error('\n   Un caso que no puede fallar se cuenta como cobertura y no cubre nada. Arreglalo para');
  console.error('   que la evidencia la produzca el SCRIPT, no el setup del laboratorio — o, si el setup corre');
  console.error('   a propósito OTRO control del arnés (marker.js, pipeline.js), declaralo en `controles` del');
  console.error('   hook: el auditor lo neutraliza también, y el caso tiene que fallar igual.');
  return 1;
}

// 🔴 `process.exitCode`, NO `process.exit()`: en Node las escrituras a una tubería son
// ASINCRÓNICAS y `process.exit()` mata el proceso con parte de lo escrito en el aire. Medido con
// la forma de este guión (una escritura grande y salir): a 41 KB llega cortado en 8192 y el JSON
// se rompe; el consumidor lo lee como «no pude», nunca como un error.
// Caso: guides/incident-log.md#informe-cortado-por-la-tuberia-2026-09-28
if (require.main === module) process.exitCode = main();
module.exports = { auditar, main };
