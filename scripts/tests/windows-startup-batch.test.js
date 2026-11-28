'use strict';
// windows-startup-batch.test.js — lo que el arranque de Windows corre como el del .sh: la recolección de hallazgos antes de
// la subida, cada una con su registro.
//
// Lo que no se puede perder:
//   · el lanzador en orden (run-in-order.js) corre cada comando después del anterior, y uno que falla no corta los demás:
//     la subida corre aunque la recolección no encuentre nada;
//   · la recolección con `--log <archivo>` AGREGA su salida al registro (un proceso de fondo de PowerShell no puede
//     agregar a un archivo) y no escribe nada en la consola;
//   · si el programa no se encuentra por su nombre (un `node` que sólo existe como node.cmd), corre con el Node de este
//     proceso: la subida no se pierde sin dejar rastro.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const ORDEN = path.join(RAIZ, 'scripts', 'lib', 'run-in-order.js');
const RECOLECTAR = path.join(RAIZ, 'scripts', 'metrics', 'collect-findings.js');

function carpeta(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'win-startup-batch-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
// con la HOME de laboratorio: nada de la máquina de quien corre
const env = (home) => ({ ...process.env, HOME: home, USERPROFILE: home, NODE_TEST_CONTEXT: '' });

// 🔴 Falla con: un arranque de Windows que lanza la subida sin esperar a la recolección (lo de hoy sube mañana).
test('W1 EnOrden_UnoDespuesDelOtro_YUnoQueFallaNoCortaLosDemas', (t) => {
  const d = carpeta(t);
  const marca = path.join(d, 'orden.txt');
  const a = path.join(d, 'a.js');
  const b = path.join(d, 'b.js');
  // el primero tarda y falla; el segundo tiene que correr después, y correr igual. Guiones fijos: la marca les llega
  // como argumento
  fs.writeFileSync(a, "setTimeout(() => { require('fs').appendFileSync(process.argv[2], 'a\\n'); process.exit(3); }, 300);");
  fs.writeFileSync(b, "require('fs').appendFileSync(process.argv[2], 'b\\n');");
  const r = spawnSync(process.execPath, [ORDEN, process.execPath, '--', a, marca, '--', b, marca], { encoding: 'utf8', env: env(d) });
  assert.strictEqual(fs.readFileSync(marca, 'utf8'), 'a\nb\n');
  assert.strictEqual(r.status, 1, 'uno falló: sale 1');
  const mal = spawnSync(process.execPath, [ORDEN, process.execPath, a], { encoding: 'utf8', env: env(d) });
  assert.strictEqual(mal.status, 2, 'sin `--` está mal llamado');
});

// 🔴 Falla con: la recolección sin `--log` (su salida, lanzada de fondo por PowerShell, se pierde y no queda registro).
test('W2 Recoleccion_ConLog_AgregaAlRegistro_YNoEscribeEnLaConsola', (t) => {
  const d = carpeta(t);
  fs.mkdirSync(path.join(d, 'repos'));
  const log = path.join(d, 'estado', 'collect-findings.log');
  fs.mkdirSync(path.dirname(log));
  fs.writeFileSync(log, 'renglón de antes\n');
  const r = spawnSync(process.execPath, [RECOLECTAR, '--root', path.join(d, 'repos'), '--output', path.join(d, 'h.jsonl'), '--log', log],
    { encoding: 'utf8', env: env(d) });
  assert.strictEqual(r.stdout + r.stderr, '', 'nada en la consola');
  const texto = fs.readFileSync(log, 'utf8');
  assert.match(texto, /^renglón de antes\n/, 'agrega: lo de antes sigue');
  assert.match(texto, /no encontré ningún repo/, 'el motivo queda en el registro');
});

// 🔴 Falla con: el lanzador que busca `node` por su nombre sin shell: con un Node que sólo existe como node.cmd no lo
// encuentra y, sin salida, no queda rastro de que la subida no corrió.
test('W3 EnOrden_ProgramaQueNoSeEncuentra_UsaElNodeDeEsteProceso', (t) => {
  const d = carpeta(t);
  const marca = path.join(d, 'corrio.txt');
  const a = path.join(d, 'a.js');
  fs.writeFileSync(a, "require('fs').writeFileSync(process.argv[2], 'si');");
  const r = spawnSync(process.execPath, [ORDEN, path.join(d, 'no-existe-node'), '--', a, marca], { encoding: 'utf8', env: env(d) });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(marca, 'utf8'), 'si');
});
