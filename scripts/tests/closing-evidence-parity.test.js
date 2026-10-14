'use strict';
/**
 * Paridad de las DOS definiciones de «evidencia de cierre» (2026-09-06).
 *
 * El criterio vivía en cuatro lugares y decían cosas distintas — el freno del Edit aceptaba la
 * matriz y el self-audit, el commit y el portón no, y el medidor contaba hasta un `.jsonl`. Ahora
 * hay UNA definición en el skill (`lib/closing-evidence.js`), que importan los dos hooks, y una
 * COPIA deliberada en el portón de CI, que corre en un agente sin `~/.claude/` y no puede importar
 * la lib. El medidor del tablero importa la del portón (mismo repo), así que son dos copias en
 * total — y este archivo es lo que impide que vuelvan a separarse.
 *
 * Mismo mecanismo que `roster-validate-parity.test.js`: se corren LAS DOS sobre los mismos nombres
 * y se compara el veredicto. Sin la lib del skill en la máquina NO pasa en silencio: avisa y se
 * saltea — un skip mudo sería el mismo pecado que este test existe para evitar.
 *
 * 🔴 rojo previo verificado: quitarle un patrón a la copia del portón pone rojo este test.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

const gate = require(path.join(__dirname, '..', 'ci', 'tycon-ci-gate.js'));
// 🔴 2026-10-14: esta ruta apuntaba a `evidencia-de-cierre.js` en las skills instaladas, y la biblioteca se llama
// `closing-evidence.js` desde que los nombres pasaron al inglés. El require fallaba siempre y el test se salteaba
// con su aviso: la paridad no se medía en ningún lado. Ahora las skills se buscan como el resto del arnés
// (scripts/lib/skills-dir.js: la variable, el propio clon si es unido, o las instaladas), con el nombre de hoy.
const libPath = (() => {
  try {
    const skills = require(path.join(__dirname, '..', 'lib', 'skills-dir.js')).resolveSkillsDirs().skills;
    return path.join(skills, 'tycon-pipeline', 'scripts', 'lib', 'closing-evidence.js');
  } catch {
    return path.join(os.homedir(), '.claude', 'agent-skills', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'closing-evidence.js');
  }
})();

let lib = null;
try { lib = require(libPath); } catch { /* sin el skill instalado */ }

// Los nombres REALES del disco, más los bordes que importan.
const NOMBRES = [
  '1.1-runtime-matrix.md', '1.1-self-audit.md', '1.1-self-audit-iter7.md', '1.1-manual-test-plan.md',
  '1.1-smoke-ledger.jsonl', '1.1-smoke-driver.mjs',
  '1.1-2026-08-31T10-00-00Z.md', '1.1-dod-runtime-checker.md', '1.1-full-dod-runtime-20260827T002909Z.md',
  '1.1-e2e-gate-20260831T100000Z.md', '1.1-dod-evidence.md', '1.1-dod-runtime-probe.md', '1.1-cierre.md',
  'M-10-runtime-matrix.md', 'M-10-20260827T001549Z.md',
  '', 'sin-extension', 'tandaC-self-audit-iter1.md',
];

test('las dos definiciones de evidencia de cierre dan el MISMO veredicto en todos los nombres', (t) => {
  if (!lib) {
    console.error(`⚠️  paridad NO verificada: no está ${libPath} (¿máquina sin el arnés?).\n` +
      '   No es un verde: es un control que no pudo correr.');
    t.skip('lib del skill ausente');
    return;
  }
  assert.equal(typeof gate.esEvidenciaDeCierre, 'function', 'el portón tiene que exportar su copia para poder compararla');
  for (const n of NOMBRES) {
    assert.equal(gate.esEvidenciaDeCierre(n), lib.esEvidenciaDeCierre(n),
      `veredicto distinto en "${n}": skill=${lib.esEvidenciaDeCierre(n)} ci=${gate.esEvidenciaDeCierre(n)}`);
  }
});

test('y los patrones de exclusión son los mismos, uno por uno', (t) => {
  if (!lib) { t.skip('lib del skill ausente'); return; }
  assert.deepEqual(
    (gate.NO_ES_EVIDENCIA_DE_CIERRE || []).map(String).sort(),
    lib.NO_ES_EVIDENCIA_DE_CIERRE.map(String).sort(),
    'las listas divergieron: un nombre puede pasar en una capa y rebotar en la otra');
  assert.deepEqual(
    (gate.ES_EVIDENCIA_ADEMAS || []).map(String).sort(),
    (lib.ES_EVIDENCIA_ADEMAS || []).map(String).sort(),
    'lo que cuenta ADEMÁS del .md (el ledger) también tiene que ser el mismo en las dos');
});
