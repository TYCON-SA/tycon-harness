'use strict';
/**
 * findings-real-home.test.js — las pruebas del cierre de hallazgos no leen la carpeta personal de quien las corre.
 *
 * `write-findings` cruza lo que se escribe con el registro de críticos reportados y el de lanzamientos de revisores,
 * y los dos viven en la carpeta de estado de la carpeta personal. Una prueba que corre `write-findings` (o
 * `writeFindings` dentro del proceso) sin cambiar la carpeta personal cruza contra lo que dejaron las sesiones reales
 * de la máquina: verde en la CI, que la tiene vacía, y rojo en el portón local cuando otra sesión dejó lanzamientos
 * sin historia.
 *
 * Acá se arma una carpeta personal «envenenada» como la que deja otra sesión: el registro de críticos con un renglón y
 * el de lanzamientos con tres revisores que salieron sin historia. Con esa carpeta como la de quien corre:
 *   - las pruebas del cierre de hallazgos tienen que dar verde (cada una arma su propia carpeta personal);
 *   - el mismo `write-findings` sin carpeta propia tiene que caer: si no cae, el veneno no muerde y la primera prueba
 *     no mide nada (sale saltada con su motivo, nunca verde).
 *
 * Los hijos corren sin `TYCON_HOME` (con ella, el hijo cuya carpeta personal es la de juguete calcula su casa propia
 * desde la variable y el padre no: mirarían carpetas de estado distintas) y sin `NODE_TEST_CONTEXT` (con ella, el hijo
 * le reporta al padre y no escribe su salida). El reporte TAP va pedido a mano: desde Node 23 la salida por defecto es
 * la de personas, sin «# pass».
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { fakeHomeEnv } = require('./lib/fake-home.js');

const SCRIPTS = path.join(__dirname, '..');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const { stateDir } = require(path.join(SCRIPTS, 'lib', 'state-dir.js'));

const UNIT = path.join(__dirname, 'unit.test.js');
const SIGNER = path.join(__dirname, 'write-findings-signer.test.js');
const T1_NOMBRE = 'writeFindings + findings-status: escribe validado, status pasa de missing(exit3) a present';
const T2_NOMBRE = 'ProyeccionDelRunDirAlRepoDeLaStory_SoloRosterYFindings';
const REVISORES = ['tycon-plugin-tests-coverage', 'tycon-plugin-security-basics', 'tycon-silent-failure-hunter'];

const escaparRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** La carpeta personal que deja otra sesión: un renglón en el registro de críticos y tres salidas sin historia. */
function armarVeneno() {
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'veneno-'));
  const estado = stateDir(casa);
  // stable-data: el cruce cuenta lo que salió desde el primer renglón del registro; el veneno tiene que ser de hoy
  const ahora = Date.now();
  const hora = (minutosAntes) => new Date(ahora - minutosAntes * 60000).toISOString();
  fs.mkdirSync(path.join(estado, 'reported-criticals'), { recursive: true });
  fs.writeFileSync(path.join(estado, 'reported-criticals', 'otra-sesion.jsonl'), `${JSON.stringify({
    ts: hora(120), kind: 'launched', advisor: 'tycon-otro-revisor', iter: 1, story: '0.0', run: null, launcher: null,
  })}\n`);
  fs.mkdirSync(path.join(estado, 'advisor-runs'), { recursive: true });
  const renglones = [{ ts: hora(90), event: 'step5-start', expected: REVISORES }];
  REVISORES.forEach((advisor, i) => renglones.push({ ts: hora(60 - i), advisor, model: null, repo: casa, story: null }));
  fs.writeFileSync(path.join(estado, 'advisor-runs', 'otra-sesion.jsonl'), `${renglones.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return casa;
}

/** El entorno de un hijo con la carpeta envenenada como la de quien corre. */
function envVeneno(casa) {
  const env = { ...process.env, ...fakeHomeEnv(casa) };
  delete env.TYCON_HOME;
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function correrSuite(casa, archivo, nombre) {
  const args = ['--test-reporter=tap'];
  if (nombre) args.push('--test-name-pattern', `^${escaparRegex(nombre)}$`);
  args.push(archivo);
  return spawnSync(process.execPath, args, { encoding: 'utf8', env: envVeneno(casa), timeout: 600000 });
}

test('FindingsSuites_PoisonedRealHome_StayGreen @story-8.269 @ac-4', () => {
  const casa = armarVeneno();
  try {
    // las tres se corren siempre y se dice cuáles cayeron: una que cae no tapa a las otras
    const caidas = [];
    for (const [archivo, nombre] of [[UNIT, T1_NOMBRE], [UNIT, T2_NOMBRE], [SIGNER, null]]) {
      const r = correrSuite(casa, archivo, nombre);
      const quien = `${path.basename(archivo)}${nombre ? ` «${nombre}»` : ''}`;
      const stdout = r.stdout || '';
      // un patrón que no encuentra nada sale 0 sin correr nada: se exige la cuenta de las que pasaron
      const corrio = (nombre ? /^# pass 1$/m : /^# pass [1-9]\d*$/m).test(stdout);
      if (r.status !== 0 || !/^# fail 0$/m.test(stdout) || !corrio) {
        caidas.push(`${quien}: sale ${r.status}, ${(stdout.match(/^# (pass|fail) \d+$/mg) || ['sin reporte TAP']).join(', ')}\n`
          + `${(stdout + (r.stderr || '')).slice(-2000)}`);
      }
    }
    assert.deepStrictEqual(caidas, [], `con la carpeta personal envenenada:\n${caidas.join('\n')}`);
  } finally {
    fs.rmSync(casa, { recursive: true, force: true });
  }
});

test('FindingsSuites_PoisonBites_WithoutCleanHome @story-8.269 @ac-5', (t) => {
  const casa = armarVeneno();
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'veneno-lab-'));
  try {
    const spec = path.join(d, 'story-7.13-x.md');
    fs.writeFileSync(spec, ['---', 'story: "7.13"', 'title: "t"', 'status: in-progress', '---', '',
      '# Story', '', '## Acceptance Criteria', '', '1. algo', ''].join('\n'));
    fs.mkdirSync(path.join(d, '.advisors', 'pipeline-runs', '7.13-20260922120000'), { recursive: true });
    const r = spawnSync(process.execPath, [PIPELINE, 'write-findings', '--repo', d, '--story', spec, '--findings', '-'],
      { encoding: 'utf8', input: '[]', env: envVeneno(casa), timeout: 120000 });
    const salida = `${r.stdout || ''}${r.stderr || ''}`;
    if (r.status === 0) {
      t.skip('el cruce ya no cuenta lanzamientos sin historia: el veneno no muerde');
      return;
    }
    assert.match(salida, /no pude leer lo que reportó/, `cae por el cruce, no por otra cosa\n${salida.slice(-3000)}`);
  } finally {
    fs.rmSync(casa, { recursive: true, force: true });
    fs.rmSync(d, { recursive: true, force: true });
  }
});
