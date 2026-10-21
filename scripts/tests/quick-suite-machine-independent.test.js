'use strict';

/**
 * quick-suite-machine-independent.test.js — la suite rápida del arranque prueba el ARNÉS, no el disco del dev.
 *
 * El instalador corre en cada arranque seis suites rápidas, y la actualización automática rechaza toda versión cuya
 * salida diga «FALLÓ» (vuelve sola a la anterior). Una de esas seis, `config-lint.test.js`, tiene un caso que recorre
 * `~/SourceCode` y exige que la configuración de CADA proyecto de la máquina use sólo llaves conocidas. En una
 * notebook con un proyecto viejo (una llave `advisors:` en la raíz) ese caso fallaría siempre: la máquina rechazaría
 * cada versión nueva y quedaría atrás sin que el arnés tuviera nada roto. Una configuración vieja de un proyecto es un
 * aviso para ese proyecto, no un motivo para que el arnés no se actualice.
 *
 * Lo que sostiene:
 *   · la suite rápida —la lista EXACTA del instalador— pasa con una HOME que trae un proyecto con una llave
 *     desconocida;
 *   · el espejo: el caso que mira las configuraciones reales sigue existiendo (en su propia suite, fuera del
 *     arranque) y SÍ marca esa misma HOME. Sacarlo del arranque no es apagarlo;
 *   · lo mismo por el AMBIENTE: un dev que deja exportada una variable que el propio arnés le recomienda subir
 *     (`TYCON_STORY_SCAN_BUDGET_MS`, «subilo si el repo es grande») no voltea la suite. `story-discovery.test.js` no
 *     lee el presupuesto «por defecto» del ambiente.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { sinGitDelPadre } = require('../lib/clean-git-env');

const RAIZ = path.resolve(__dirname, '..', '..');
const INSTALADOR = path.join(RAIZ, 'scripts', 'install-tycon-hooks.sh');
const SKILLS = path.join(RAIZ, 'skills');
const REAL_CONFIGS = path.join(SKILLS, 'tycon-pipeline', 'scripts', 'tests', 'config-lint-real-configs.test.js');

/** Las suites rápidas tal como las lista el instalador (el bloque `UNIT_TESTS=( … )`). */
function quickSuites() {
  const sh = fs.readFileSync(INSTALADOR, 'utf8');
  const m = sh.match(/UNIT_TESTS=\(\n([\s\S]*?)\n\s*\)/);
  assert.ok(m, 'no encontré el bloque UNIT_TESTS=( … ) en el instalador');
  const rutas = [...m[1].matchAll(/"\$UT_SKILLS\/([^"]+)"/g)].map((x) => path.join(SKILLS, x[1]));
  assert.ok(rutas.length >= 6, `el instalador lista ${rutas.length} suites rápidas; esperaba al menos seis`);
  for (const r of rutas) assert.ok(fs.existsSync(r), `el instalador lista una suite rápida que no existe: ${r}`);
  return rutas;
}

/** Una HOME con un proyecto cuya configuración usa una llave que el catálogo no conoce. */
function homeConProyectoViejo() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-suite-home-'));
  const tycon = path.join(home, 'SourceCode', 'ProyectoViejo', 'Backend', '.tycon');
  fs.mkdirSync(tycon, { recursive: true });
  fs.writeFileSync(path.join(tycon, 'advisors.yaml'), 'advisors:\n  skip: []\n');
  return home;
}

function correr(archivos, home, extra) {
  // Sin NODE_TEST_CONTEXT: corriendo dentro de `node --test`, el hijo la hereda, se cree un subproceso del corredor y
  // sale 0 aunque falle (medido al escribir esta prueba: el primer caso dio verde con la suite en rojo).
  const env = sinGitDelPadre({ HOME: home, USERPROFILE: home, TYCON_SKILLS_DIR: SKILLS }, extra);
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--test', ...archivos], {
    cwd: os.tmpdir(),
    env,
    encoding: 'utf8',
    timeout: 180000,
  });
}

test('la suite rápida del arranque pasa aunque un proyecto de la máquina tenga una configuración vieja', () => {
  const home = homeConProyectoViejo();
  try {
    const r = correr(quickSuites(), home);
    assert.equal(r.status, 0,
      'la suite rápida falló por una configuración de proyecto: la actualización automática rechazaría toda versión nueva\n'
      + (r.stdout || '').split('\n').filter((l) => /not ok|✖|AssertionError|dispara/.test(l)).slice(0, 8).join('\n'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('la suite rápida del arranque pasa con el presupuesto de escaneo subido en el ambiente del dev', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-suite-home-'));
  try {
    const r = correr(quickSuites(), home, { TYCON_STORY_SCAN_BUDGET_MS: '2000' });
    assert.equal(r.status, 0,
      'la suite rápida falló por una variable que el arnés le recomienda al dev subir\n'
      + (r.stdout || '').split('\n').filter((l) => /not ok|✖|AssertionError/.test(l)).slice(0, 8).join('\n'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('espejo: el caso de las configuraciones reales sigue vivo fuera del arranque y marca esa llave', () => {
  assert.ok(fs.existsSync(REAL_CONFIGS), `falta ${REAL_CONFIGS}: el caso de las configuraciones reales se perdió`);
  assert.ok(!quickSuites().includes(REAL_CONFIGS), 'el caso de las configuraciones reales volvió a la suite del arranque');
  const home = homeConProyectoViejo();
  try {
    const r = correr([REAL_CONFIGS], home);
    assert.notEqual(r.status, 0, 'con una llave desconocida en un proyecto, el caso de las configuraciones reales tiene que fallar');
    assert.match(r.stdout || '', /ProyectoViejo/, 'el rojo tiene que nombrar la configuración que lo dispara');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
