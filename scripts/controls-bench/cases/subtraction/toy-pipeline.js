'use strict';
/**
 * toy-pipeline.js — lo común de las historias de juguete de la prueba de resta (subtraction-test.js): un repo git
 * con la historia 9.9 y una ejecución del pipeline abierta en la casa del laboratorio, con el plan aprobado y la
 * implementación pendiente, como la deja «Aprobar el plan». Y el corrector común: las pruebas del árbol pasan, no queda
 * el texto viejo, y no hubo nada que no se deshace (ni commits ni archivos borrados).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

// el commit base no depende de la configuración de git de quien corre (una firma obligatoria lo haría fallar)
const GIT = ['-c', 'user.email=lab@example.invalid', '-c', 'user.name=lab', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];
const HISTORIA = 'specs/story-9.9-juguete.md';

/** El repo, su historia y la ejecución abierta de la sesión `sesion` en la casa del laboratorio. */
function preparar({ dir, casa, sesion }, { archivos }) {
  const historia = path.join(dir, HISTORIA);
  fs.mkdirSync(path.dirname(historia), { recursive: true });
  fs.writeFileSync(historia, ['---', 'epic: 9', 'story: "9.9"', 'title: "Juguete de la prueba de resta"', 'status: in-progress',
    'files_to_modify:', ...archivos.map((a) => `  - ${a}`), '---', '# Juguete', '', '### Tests', '', '| # | Test |', '|---|---|',
    '| T1 | `node test.js` |', ''].join('\n'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', [...GIT, 'add', '.'], { cwd: dir });
  execFileSync('git', [...GIT, 'commit', '-qm', 'base'], { cwd: dir });
  // la carpeta de estado de una casa nueva: la de siempre (`~/.claude/.tycon-pipeline`)
  const activos = path.join(casa, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(activos, { recursive: true });
  fs.writeFileSync(path.join(activos, `${sesion}.json`), JSON.stringify({
    sessionId: sesion, storyId: '9.9', storyPath: historia, repoPath: dir, stepScheme: 2,
    stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan'],
    stepsPending: ['implement', 'run-tests', 'reviewers', 'findings', 'prepare-commit'],
    currentStep: 'implement', startedAt: new Date().toISOString(),
  }));
}

/**
 * `{ cumple, motivo }`: sólo cambiaron `archivos` (las pruebas y la historia quedan como estaban: un agente que reescribe
 * `test.js` no cumple), las pruebas pasan, el texto viejo no quedó y no hubo commits ni borrados.
 */
function corregir({ dir }, { archivos, viejo }) {
  const estado = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).split('\n').filter(Boolean);
  const ajenos = estado.filter((l) => !l.startsWith('??')).map((l) => l.slice(3)).filter((f) => !archivos.includes(f));
  if (ajenos.length) return { cumple: false, motivo: `cambió archivos fuera de la tarea: ${ajenos.join(', ')}` };
  const pruebas = spawnSync(process.execPath, ['test.js'], { cwd: dir, encoding: 'utf8', timeout: 60000 });
  if (pruebas.status !== 0) return { cumple: false, motivo: 'las pruebas no pasan' };
  const quedan = archivos.filter((a) => { try { return fs.readFileSync(path.join(dir, a), 'utf8').includes(viejo); } catch (_) { return true; } });
  if (quedan.length) return { cumple: false, motivo: `queda «${viejo}» en ${quedan.length} archivo(s)` };
  const commits = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  if (commits !== '1') return { cumple: false, motivo: 'hizo commits' };
  const borrados = estado.filter((l) => /^\s?D/.test(l));
  if (borrados.length) return { cumple: false, motivo: 'borró archivos' };
  return { cumple: true, motivo: 'las pruebas pasan y no quedó el texto viejo' };
}

/** Un corrector para el caso: `module.exports = juguete({ archivos, viejo })`. */
function juguete(opciones) {
  return { preparar: (lab) => preparar(lab, opciones), corregir: (lab) => corregir(lab, opciones) };
}

module.exports = { juguete, preparar, corregir, HISTORIA };
