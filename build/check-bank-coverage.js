#!/usr/bin/env node
/**
 * build/check-bank-coverage.js — el tercer control de la Etapa H: **una pieza nueva entra con sus
 * casos, o no entra**.
 *
 * Los otros dos controles del pre-commit cubren la migración en sí (los TOML al día con su
 * canónico, los hooks registrados de los dos lados). Éste cubre el DESPUÉS: el advisor #29 que
 * alguien cree en octubre, cuando la migración ya sea historia y nadie recuerde la regla B2.
 *
 * Qué rechaza:
 *   1. Un advisor en el MANIFEST sin archivo de casos en el banco.
 *   2. Un archivo de casos que existe pero está VACÍO, o cuyos casos no declaran la regla que
 *      cazan. Un archivo vacío es peor que ninguno: cuenta como cobertura en cualquier conteo
 *      ingenuo, y hace pasar en verde a un advisor que nadie probó — el mismo modo de falla que
 *      la propia Etapa G pagó cuando los casos del banco medían una forma de patch que el
 *      sistema real no producía.
 *   3. Un archivo de casos cuyo campo `advisor` no coincide con su nombre de archivo (se copió
 *      un caso de otro advisor y se olvidaron de cambiarlo: los casos correrían contra el
 *      advisor equivocado y su verde no diría nada del que dice cubrir).
 *
 * Qué NO rechaza (avisa nomás): casos de un advisor que ya no está en el manifest. Puede ser un
 * advisor retirado a propósito y sus casos quedando de testigo; forzar el borrado invitaría a
 * perder evidencia por conveniencia.
 *
 * Uso:  node build/check-bank-coverage.js [--selftest]
 * Exit: 0 al día · 1 hay piezas sin cubrir
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TCG = path.resolve(__dirname, '..');
const MANIFEST = path.join(TCG, 'adapters', 'codex', 'agents', 'MANIFEST.json');
const CASES_DIR = path.join(TCG, 'scripts', 'controls-bench', 'cases', 'advisors');

/** Lee el manifest de advisors migrados. Sin manifest no hay nada que exigir. */
function leerManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return [];
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return Array.isArray(m.advisors) ? m.advisors : [];
  } catch (e) {
    return { error: `MANIFEST.json ilegible: ${e.message}` };
  }
}

/**
 * Analiza los archivos de casos. Devuelve { porAdvisor: Map, problemas: [] } — los problemas de
 * ESTA capa son los del punto 2 y 3 (archivo presente pero inútil).
 */
function analizarCasos(casesDir) {
  const porAdvisor = new Map();
  const problemas = [];
  if (!fs.existsSync(casesDir)) return { porAdvisor, problemas };

  for (const f of fs.readdirSync(casesDir).filter((x) => x.endsWith('.json')).sort()) {
    const nombreArchivo = f.replace(/\.json$/, '');
    let d;
    try {
      d = JSON.parse(fs.readFileSync(path.join(casesDir, f), 'utf8'));
    } catch (e) {
      problemas.push(`${f}: no parsea como JSON (${e.message})`);
      continue;
    }
    const casos = Array.isArray(d.cases) ? d.cases : [];
    if (!casos.length) {
      problemas.push(`${f}: archivo de casos VACÍO — cuenta como cobertura y no prueba nada`);
      continue;
    }
    if (d.advisor && d.advisor !== nombreArchivo) {
      problemas.push(`${f}: el campo advisor dice "${d.advisor}" pero el archivo se llama "${nombreArchivo}" — los casos correrían contra otro advisor`);
    }
    const sinRegla = casos.filter((c) => c.type === 'must-flag' && !c.rule).map((c) => c.id || '(sin id)');
    if (sinRegla.length) {
      problemas.push(`${f}: ${sinRegla.length} caso(s) must-flag sin declarar qué regla cazan (${sinRegla.slice(0, 3).join(', ')}) — la paridad se mide por regla objetivo, no por conteo`);
    }
    porAdvisor.set(d.advisor || nombreArchivo, casos.length);
  }
  return { porAdvisor, problemas };
}

/** Cruce manifest ↔ casos. Devuelve la lista de problemas bloqueantes y los avisos. */
function comparar(advisors, porAdvisor) {
  const bloqueantes = [];
  const avisos = [];
  for (const a of advisors) {
    if (!porAdvisor.has(a)) {
      bloqueantes.push(`advisor "${a}" está en el MANIFEST y NO tiene casos en el banco (regla B2: entra con sus casos o no entra)`);
    }
  }
  for (const a of porAdvisor.keys()) {
    if (!advisors.includes(a)) avisos.push(`casos de "${a}" sin advisor en el MANIFEST (¿retirado? los casos quedan de testigo)`);
  }
  return { bloqueantes, avisos };
}

function selftest() {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bankcov-'));
  const casos = path.join(tmp, 'cases');
  fs.mkdirSync(casos);
  const man = path.join(tmp, 'MANIFEST.json');
  const esc = (o) => JSON.stringify(o);

  // Escenario base: un advisor, con su archivo de casos sano.
  fs.writeFileSync(man, esc({ advisors: ['adv-uno'] }));
  fs.writeFileSync(path.join(casos, 'adv-uno.json'), esc({ advisor: 'adv-uno', cases: [{ id: 'c1', type: 'must-flag', rule: 'X-C1' }] }));
  const sano = comparar(leerManifest(man), analizarCasos(casos).porAdvisor);

  // Escenario 1: advisor nuevo en el manifest, sin casos.
  fs.writeFileSync(man, esc({ advisors: ['adv-uno', 'adv-dos'] }));
  const sinCasos = comparar(leerManifest(man), analizarCasos(casos).porAdvisor);

  // Escenario 2: archivo de casos vacío.
  fs.writeFileSync(path.join(casos, 'adv-dos.json'), esc({ advisor: 'adv-dos', cases: [] }));
  const vacio = analizarCasos(casos).problemas;

  // Escenario 3: el campo advisor no coincide con el nombre del archivo.
  fs.writeFileSync(path.join(casos, 'adv-dos.json'), esc({ advisor: 'adv-otro', cases: [{ id: 'c', type: 'must-flag', rule: 'Y-C1' }] }));
  const cruzado = analizarCasos(casos).problemas;

  // Escenario 4: must-flag sin regla declarada.
  fs.writeFileSync(path.join(casos, 'adv-dos.json'), esc({ advisor: 'adv-dos', cases: [{ id: 'c', type: 'must-flag' }] }));
  const sinRegla = analizarCasos(casos).problemas;

  fs.rmSync(tmp, { recursive: true, force: true });

  const checks = [
    ['el caso sano NO bloquea', sano.bloqueantes.length === 0],
    ['advisor en manifest sin casos → bloquea', sinCasos.bloqueantes.length === 1 && /adv-dos/.test(sinCasos.bloqueantes[0])],
    ['archivo de casos vacío → problema', vacio.some((p) => /VAC[IÍ]O/.test(p))],
    ['advisor cruzado con el nombre del archivo → problema', cruzado.some((p) => /correrían contra otro advisor/.test(p))],
    ['must-flag sin regla declarada → problema', sinRegla.some((p) => /sin declarar qué regla/.test(p))],
  ];
  let bad = 0;
  for (const [n, ok] of checks) { console.log(`${ok ? '✅' : '❌'} selftest-bank-coverage: ${n}`); if (!ok) bad++; }
  console.log(bad ? `❌ ${bad} rojos` : `✅ selftest-bank-coverage: ${checks.length}/${checks.length} verdes`);
  return bad ? 1 : 0;
}

function main() {
  if (process.argv.includes('--selftest')) return selftest();

  const advisors = leerManifest(MANIFEST);
  if (advisors.error) { console.error(`❌ bank-coverage: ${advisors.error}`); return 1; }
  if (!advisors.length) { console.log('✅ bank-coverage: manifest vacío, nada que exigir'); return 0; }

  const { porAdvisor, problemas } = analizarCasos(CASES_DIR);
  const { bloqueantes, avisos } = comparar(advisors, porAdvisor);
  const todos = [...bloqueantes, ...problemas];

  for (const a of avisos) console.log(`⚠ bank-coverage: ${a}`);
  if (!todos.length) {
    console.log(`✅ bank-coverage: ${advisors.length} advisors del manifest, todos con casos en el banco`);
    return 0;
  }
  console.error('❌ bank-coverage — una pieza sin casos es una pieza sin control:');
  for (const p of todos) console.error(`   · ${p}`);
  console.error('   Cómo se arregla: agregá scripts/controls-bench/cases/advisors/<advisor>.json con al menos');
  console.error('   un caso por regla objetivo (must-flag con su `rule`), o sacá el advisor del MANIFEST.');
  return 1;
}

if (require.main === module) process.exit(main());
module.exports = { leerManifest, analizarCasos, comparar };
