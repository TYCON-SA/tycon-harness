'use strict';
/**
 * clean-machine-startup-log.test.js — cuando un escenario de la máquina limpia falla, su registro del arranque sale del
 * contenedor en la salida del paso, y llega al registro de la CI.
 *
 *   T1 CleanMachine_FailedScenario_PrintsStartupLog — un escenario con un ❌ cierra mostrando las últimas líneas de
 *      ~/.claude/.tycon-pipeline/harness/startup.log, cada una con sangría (no se cuentan como ✅ ni ❌)
 *   T2 CleanMachine_GreenScenario_Silent — sin fallas, no muestra nada del registro
 *   T3 CleanMachine_NoStartupLog_Says — con fallas y sin registro, dice que no lo hay
 *   T4 CleanMachine_TallyPassesTheLog — el anfitrión (tally) pasa esas líneas a su salida
 *
 * 🔴 Falla con: un rojo de la máquina limpia en la CI cuyo detalle quedó dentro del contenedor (que corre con --rm y se
 *    borra al terminar), o un renglón del registro que se cuenta como un ✅ o un ❌.
 * stable-data: una casa de juguete en el temporal; no usa docker ni lee el reloj.
 * 0 deps (node:test).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = path.join(__dirname, 'clean-machine');
const LIB = path.join(DIR, 'lib.sh');

function correr(t, { fallas, registro }) {
  const casa = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-arranque-')));
  t.after(() => fs.rmSync(casa, { recursive: true, force: true }));
  if (registro !== undefined) {
    const f = path.join(casa, '.claude', '.tycon-pipeline', 'harness', 'startup.log');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, registro);
  }
  // el guion es un texto fijo: la ruta de lib.sh y lo que el escenario hace le llegan por el entorno
  const guion = '. "${CM_LIB}"\nif [ "${CM_FALLA}" = 1 ]; then no "T99 algo falló"; else ok "T99 todo bien"; fi\nscenario_end prueba\n';
  const r = spawnSync('bash', ['-c', guion], { encoding: 'utf8', env: { ...process.env, HOME: casa, CM_LIB: LIB, CM_FALLA: fallas ? '1' : '0' } });
  return `${r.stdout || ''}${r.stderr || ''}`;
}

test('T1 CleanMachine_FailedScenario_PrintsStartupLog — con un ❌ muestra el final del registro', (t) => {
  const lineas = Array.from({ length: 120 }, (_, i) => `renglón ${i + 1}`);
  lineas.push('✅ clean-machine: T1 esto no es un resultado');
  const out = correr(t, { fallas: true, registro: `${lineas.join('\n')}\n` });
  assert.match(out, /clean-machine: registro del arranque/);
  assert.match(out, /^ {3}│ renglón 120$/m);
  assert.doesNotMatch(out, /^ {3}│ renglón 1$/m, 'sólo el final, no el registro entero');
  assert.doesNotMatch(out, /^✅ clean-machine: T1 esto/m, 'un renglón del registro no se lee como resultado');
  // el cierre del escenario sigue siendo la última línea
  assert.match(out.trimEnd(), /clean-machine: fin del escenario prueba$/);
});

test('T2 CleanMachine_GreenScenario_Silent — sin fallas no muestra el registro', (t) => {
  const out = correr(t, { fallas: false, registro: 'algo\n' });
  assert.doesNotMatch(out, /registro del arranque/);
});

test('T3 CleanMachine_NoStartupLog_Says — con fallas y sin registro, lo dice', (t) => {
  const out = correr(t, { fallas: true });
  assert.match(out, /registro del arranque: no hay/);
});

test('T4 CleanMachine_TallyPassesTheLog — el anfitrión pasa las líneas del registro a su salida', () => {
  const texto = fs.readFileSync(path.join(__dirname, 'clean-machine.test.sh'), 'utf8');
  const tally = /tally\(\) \{[\s\S]*?\n\}/.exec(texto);
  assert.ok(tally, 'clean-machine.test.sh tiene tally()');
  assert.match(tally[0], /"clean-machine: registro del arranque"\*/);
  assert.match(tally[0], /" {3}│ "\*/);
});
