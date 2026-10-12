#!/usr/bin/env node
/**
 * adversarial-probes.test.js — el pase adversarial GUARDA la prueba que confirmó un hallazgo
 * (2026-09-17, pedido del dev).
 *
 * Caso disparador: story A-2 del backend de un producto del equipo. El verificador escribió una prueba de integración
 * que devolvía 200 donde la story pedía 403 —lista para volverse la prueba de regresión—, la borró
 * al terminar (bien) y a los 30 días Claude Code borró también su conversación. Del hallazgo quedó
 * el relato; el código, nunca.
 *
 * Corre el guion REAL (adversarial-verify.workflow.js) bajo workflow-lite con un agente de mentira,
 * sin modelo: el «hunter» devuelve un hallazgo por lente pedida y el «skeptic» graba el prompt que
 * recibió y contesta CONFIRMED con la carpeta que le indicaron.
 *
 * Correr: node --test .../scripts/tests/adversarial-probes.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const WFLITE = path.join(SCRIPTS, 'workflow-lite.js');
const WORKFLOW = path.join(SCRIPTS, 'adversarial-verify.workflow.js');

// Agente de mentira: recibe el prompt por env (TYCON_WFLITE_PROMPT, así se lo pasa workflow-lite
// al stub), lo anota en un archivo por llamada y contesta según sea hunter o skeptic. Un hunter devuelve UN
// hallazgo sólo en la lente `determinism-ordering` (las demás, limpias) para que haya exactamente
// un verificador y su carpeta sea predecible.
function mkStub(tmp) {
  const stub = path.join(tmp, 'stub.js');
  fs.writeFileSync(stub, `
const fs = require('fs'); const path = require('path');
const prompt = process.env.TYCON_WFLITE_PROMPT || '';
const dir = ${JSON.stringify(tmp)};
// nombre único: los 6 hunters corren EN PARALELO y un contador por readdir los hacía pisarse
fs.writeFileSync(path.join(dir, 'prompt-' + process.pid + '-' + Date.now() + '.txt'), prompt);
if (/Un hunter \\(lente/.test(prompt)) {
  const m = prompt.match(/Cre\\u00e1 la carpeta (\\S+)/) || prompt.match(/Creá la carpeta (\\S+)/);
  console.log(JSON.stringify({ verdict: 'CONFIRMED', reasoning: 'reproducido', adjusted_severity: 'bug', probe_dir: m ? m[1] : '', todos_el_mismo_defecto: true }));
} else if (/LENTE: determinismo/.test(prompt)) {
  console.log(JSON.stringify({ lens: 'determinism-ordering', findings: [{ severity: 'bug', file: 'src/a.js', line: 3, summary: 'orden no estable', repro: 'x', confidence: 'high' }] }));
} else {
  console.log(JSON.stringify({ lens: 'otra', findings: [] }));
}
`);
  return stub;
}

// `repo` tiene que EXISTIR: workflow-lite arranca cada agente parado ahí (un repo inexistente
// mata al stub antes de contestar, y el pase termina limpio en silencio — 0 verificadores).
function correr(args) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-probes-'));
  const stub = mkStub(tmp);
  const out = path.join(tmp, 'out.json');
  args = { repo: tmp, ...args };
  const r = spawnSync(process.execPath, [WFLITE, WORKFLOW, '--args', JSON.stringify(args), '--out', out], {
    encoding: 'utf8',
    env: { ...process.env, TYCON_WFLITE_AGENT_CMD: `${process.execPath} ${stub}` },
  });
  assert.strictEqual(r.status, 0, `workflow-lite falló: ${r.stderr}`);
  const prompts = fs.readdirSync(tmp).filter((f) => f.startsWith('prompt-')).map((f) => fs.readFileSync(path.join(tmp, f), 'utf8'));
  const skeptics = prompts.filter((p) => /Un hunter \(lente/.test(p));
  return { result: JSON.parse(fs.readFileSync(out, 'utf8')), skeptics, prompts, stderr: r.stderr, tmp };
}

// 2026-10-02: un guion del pase cuyo laboratorio no se armó llamó a git con la carpeta vacía (`git -C ""` no cambia de
// carpeta) y creó una rama y dos commits en la copia de trabajo desde la que corría la sesión. La regla va en el texto
// de TODOS los agentes del pase, no sólo en el step del orquestador: son ellos los que escriben y corren los guiones.
test('todo agente del pase recibe dónde pararse, dónde armar el laboratorio y que git nunca va sin carpeta', () => {
  const { prompts, skeptics } = correr({ files: ['src/a.js'], runDir: '/repo/.advisors/pipeline-runs/9.9-20261002-1000' });
  assert.ok(prompts.length >= 7 && skeptics.length === 1, `las seis lentes y su verificador (${prompts.length} agentes)`);
  for (const p of prompts) {
    const quien = /Un hunter \(lente/.test(p) ? 'el verificador' : `la lente «${(p.match(/LENTE: ([^\n.]+)/) || [])[1] || '?'}»`;
    assert.match(p, /DÓNDE CORRE TU GUION/, `${quien}: trae la regla`);
    assert.match(p, /mktemp -d \/tmp\//, `${quien}: el laboratorio va bajo /tmp, con base fija`);
    assert.match(p, /fuera de cualquier repo/, `${quien}: parado fuera de cualquier repo`);
    assert.match(p, /git -C ""/, `${quien}: nombra la trampa de la carpeta vacía`);
    assert.match(p, /set -euo pipefail/, `${quien}: el guion corta si el laboratorio no se armó`);
    assert.match(p, /SÓLO LECTURA/, `${quien}: el repo bajo revisión no se escribe con git`);
  }
});

test('el verificador recibe la orden de guardar la prueba en <runDir>/step-05b-probes/<lente>-<n>', () => {
  const runDir = '/repo/.advisors/pipeline-runs/9.9-20260917-1200';
  const { skeptics } = correr({ files: ['src/a.js'], runDir });
  assert.strictEqual(skeptics.length, 1, 'un hallazgo → un verificador');
  const p = skeptics[0];
  assert.match(p, /GUARDÁ LA PRUEBA ANTES DE BORRARLA/);
  assert.ok(p.includes(`${runDir}/step-05b-probes/determinism-ordering-1`), 'la carpeta nombra la corrida, la lente y el número');
  assert.match(p, /COMO-SE-CORRIO\.txt/, 'pide el comando exacto y la salida');
  assert.match(p, /\.txt/, 'los archivos van con .txt para que nada los compile');
  assert.match(p, /<REDACTED>/, 'pide tapar credenciales');
  assert.match(p, /probe_dir = ""/, 'si refuta o no pudo guardar, no inventa ruta');
});

test('la carpeta de la prueba vuelve en cada CONFIRMED y en el resultado del pase', () => {
  const runDir = '/repo/.advisors/pipeline-runs/9.9-20260917-1200';
  const { result } = correr({ files: ['src/a.js'], runDir });
  assert.strictEqual(result.confirmed.length, 1);
  assert.strictEqual(result.confirmed[0].probe_dir, `${runDir}/step-05b-probes/determinism-ordering-1`);
  assert.strictEqual(result.probes_dir, `${runDir}/step-05b-probes`);
});

test('sin runDir (lanzado a mano) igual guarda, bajo pipeline-runs/adversarial-sin-corrida', () => {
  const { result, skeptics, tmp } = correr({ files: ['src/a.js'] });
  assert.strictEqual(result.probes_dir, `${tmp}/.advisors/pipeline-runs/adversarial-sin-corrida/step-05b-probes`);
  assert.ok(skeptics[0].includes(`${tmp}/.advisors/pipeline-runs/adversarial-sin-corrida/step-05b-probes/determinism-ordering-1`));
});

test('el hunter NO recibe la orden de guardar: guarda sólo quien confirma', () => {
  const { tmp } = correr({ files: ['src/a.js'], runDir: '/repo/.advisors/pipeline-runs/x' });
  const hunters = fs.readdirSync(tmp).filter((f) => f.startsWith('prompt-'))
    .map((f) => fs.readFileSync(path.join(tmp, f), 'utf8')).filter((p) => /^\s*Repo:/.test(p) && !/Un hunter \(lente/.test(p));
  assert.ok(hunters.length >= 6, `6 lentes → 6 hunters (hubo ${hunters.length})`);
  for (const h of hunters) assert.doesNotMatch(h, /GUARDÁ LA PRUEBA/);
});

test('la carpeta de la corrida queda fuera de git: el .gitignore canónico ignora todo salvo roster y findings', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'pipeline.js'), 'utf8');
  const bloque = src.slice(src.indexOf('const GITIGNORE_ADVISORS'), src.indexOf('];', src.indexOf('const GITIGNORE_ADVISORS')));
  assert.match(bloque, /'\*\*\/\.advisors\/pipeline-runs\/\*\/\*'/, 'todo lo de una corrida se ignora…');
  assert.doesNotMatch(bloque, /step-05b-probes/, '…y las pruebas no tienen excepción: no viajan (traen código de cliente y credenciales tapadas a mano)');
});
