#!/usr/bin/env node
'use strict';
/**
 * windows-rehearsal.js — un escenario del ensayo de Windows sobre el árbol del pedido, en un trabajo windows-latest de la
 * CI pública (.github/workflows/ci.yml, el job `windows`). Es lo mismo que corre el ensayo de Azure con la fuente github,
 * en un solo agente: el bundle de este checkout (`build-sources.js --single-repo`) y `rehearse.js all` sobre él.
 *
 * Qué corre cada trabajo lo elige la matriz del job (`--scenario`): `all` (el alta y la actualización), `waiver` (las
 * firmas del dueño), `old-node` y `npx`. La base portable (unos 48 minutos) no entra: la corre el ensayo de Azure.
 *
 * El veredicto es el de `rehearse.js`: rojo si no se pudo ensayar (un paso en error o uno que no corrió). En Windows,
 * también si ningún paso del escenario midió. Lo que el ensayo encuentra va en el reporte, con su gravedad, y no pone
 * rojo el trabajo. El reporte se imprime en la salida y,
 * en GitHub, en el resumen de la corrida.
 *
 * Uso: node scripts/ci/windows-rehearsal.js --scenario <escenario> --work <carpeta>
 *   <carpeta>: donde van el laboratorio, el bundle y el reporte. No puede ser la carpeta de usuario ni estar dentro de ella
 *   o de la carpeta temporal (son las reglas del laboratorio).
 * SALIDAS: 0 se pudo ensayar · 1 no se pudo, o no se pudo armar el bundle · 2 uso.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const WINDOWS = path.join(ROOT, 'scripts', 'tests', 'windows');
const SCENARIOS = ['all', 'waiver', 'old-node', 'npx'];

function opt(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

function run(args) {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  return r.error ? 1 : r.status;
}

function main(argv) {
  const scenario = opt(argv, '--scenario');
  const work = opt(argv, '--work');
  if (!SCENARIOS.includes(scenario) || !work) {
    console.error(`uso: node scripts/ci/windows-rehearsal.js --scenario <${SCENARIOS.join('|')}> --work <carpeta>`);
    return 2;
  }
  const sources = path.join(work, 'sources');
  const report = path.join(work, 'windows-rehearsal');
  if (run([path.join(WINDOWS, 'build-sources.js'), '--output', sources, '--harness', ROOT, '--single-repo']) !== 0) {
    console.error('no pude armar el bundle de este árbol: sin él no hay nada que ensayar');
    return 1;
  }
  const rc = run([path.join(WINDOWS, 'rehearse.js'), 'all', '--lab', path.join(work, 'lab'), '--out', report, '--sources', sources,
    '--scenario', scenario, '--harness-ref', 'github', '--same-tree',
    ...(process.env.GITHUB_RUN_ID ? ['--run-id', process.env.GITHUB_RUN_ID, '--run-number', process.env.GITHUB_RUN_NUMBER || ''] : [])]);
  let md = null;
  try { md = fs.readFileSync(path.join(report, 'windows-report.md'), 'utf8'); } catch (_) { /* lo dice abajo */ }
  if (md) {
    console.log(md);
    if (process.env.GITHUB_STEP_SUMMARY) { try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`); } catch (_) { /* el reporte ya salió arriba */ } }
  } else {
    console.error('el ensayo no dejó su reporte');
  }
  if (rc !== 0) return 1;
  // un ensayo que corrió sin que ningún paso midiera no prueba nada: en Windows es rojo; fuera de Windows (la prueba en
  // modo laboratorio) es lo esperado y queda en aviso. Azure lo marca «con avisos»; GitHub no tiene ese tercer color
  let v = null;
  try { v = JSON.parse(fs.readFileSync(path.join(report, 'windows-report.json'), 'utf8')).verdict; } catch (_) { /* abajo */ }
  if (!v) { console.error('el ensayo no dejó su veredicto: no se sabe si midió'); return 1; }
  if (v.nothing_measured) {
    const win = process.platform === 'win32';
    console.log(`::${win ? 'error' : 'warning'}::el escenario ${scenario} corrió, pero ningún paso midió${win ? ': en Windows eso es no haber ensayado' : ''}`);
    return win ? 1 : 0;
  }
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { SCENARIOS, main };
