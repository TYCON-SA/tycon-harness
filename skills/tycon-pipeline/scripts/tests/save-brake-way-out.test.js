'use strict';
/**
 * save-brake-way-out.test.js — el pedido sin preparar, cuando no es de la historia (el arreglo que destraba su cierre, por
 * ejemplo), dice la salida en una línea: la coordinadora cierra la ejecución con el comando exacto. El freno no se afloja.
 *
 * Vive aparte de save-brake.test.js porque esa suite es de las bajadas (scripts/tests/slow-suites-goal.json): no se le
 * suman casos. Laboratorio por prueba: una HOME vacía, un repo con su `origin` (un repo desnudo local) y la rama de la
 * story empujada con seguimiento, y el marcador de la corrida en el estado de esa HOME; el freno se llama directo.
 *
 * stable-data: las horas de la corrida son fijas; ninguna se compara con el reloj.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Sin arnés instalado packs.default no se puede leer: la suite fija el valor del perfil del equipo, como save-brake.test.js.
process.env.TYCON_PACKS_DEFAULT = 'all';
const BRAKE_LIB = path.join(__dirname, '..', 'lib', 'save-brake.js');

const ANTES = '2026-10-29T10:00:00.000Z';
const RAMA = 'story/la-prueba';
const SID = 'ses-freno';
const SIN_PREPARAR = /el pull request sale después de preparar/;

const GIT_ENV = { GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@example.com', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@example.com' };
function sh(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const tmp = (t, pre) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), pre)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
function escribir(d, r, c) {
  const f = path.join(d, r);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, c);
}

/** Un repo con `origin` (desnudo, local), `main` empujada y la rama de la story empujada con seguimiento. */
function repoConOrigin(t, nombre = 'repo') {
  const base = tmp(t, `salida-${nombre}-`);
  const origen = path.join(base, 'origen.git');
  const d = path.join(base, nombre);
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origen]);
  fs.mkdirSync(d);
  sh(d, 'init', '-q', '-b', 'main');
  escribir(d, 'LEEME.md', 'hola\n');
  escribir(d, 'specs/story-9.99.md', '---\nstory_id: "9.99"\nstatus: in-progress\n---\n');
  sh(d, 'add', '-A');
  sh(d, 'commit', '-q', '-m', 'base');
  sh(d, 'remote', 'add', 'origin', origen);
  sh(d, 'push', '-q', 'origin', 'main');
  sh(d, 'checkout', '-q', '-b', RAMA);
  sh(d, 'push', '-q', '-u', 'origin', RAMA);
  return d;
}

/** La HOME vacía de la prueba, con la carpeta del estado. */
function home(t) {
  const h = tmp(t, 'salida-home-');
  fs.mkdirSync(path.join(h, '.claude', '.tycon-pipeline', 'active'), { recursive: true });
  return h;
}

/** Abre la corrida de prueba sobre `repo`, con «Ejecutar las pruebas» sin cerrar. */
function abrir(h, repo) {
  const m = {
    storyId: '9.99', startedAt: ANTES, sessionId: SID, repoPath: repo, storyPath: path.join(repo, 'specs', 'story-9.99.md'),
    stepScheme: 2, stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan', 'implement'], stepsPending: ['run-tests'],
    lastTouch: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(h, '.claude', '.tycon-pipeline', 'active', `${SID}.json`), JSON.stringify(m, null, 2));
}
const decide = (h, command, cwd) => require(BRAKE_LIB).decidir({ command, cwd, sid: SID, home: h });

// 🔴 Falla con: el pedido sin preparar que frena sin decir la salida cuando no es de la historia (el arreglo que destraba
// su cierre, por ejemplo): la coordinadora cierra la ejecución con el comando exacto, en una línea. El freno no se afloja.
test('PedidoSinPreparar_DiceLaSalidaSiNoEsDeLaHistoria', (t) => {
  const h = home(t);
  const a = repoConOrigin(t);
  const otro = repoConOrigin(t, 'otro');
  abrir(h, a);
  for (const cwd of [a, otro]) {
    const r = decide(h, 'gh pr create --fill', cwd) || {};
    assert.match(r.texto || '', SIN_PREPARAR, JSON.stringify(r));
    const salida = (r.texto || '').split('\n').filter((l) => /no es de la historia 9\.99/.test(l));
    assert.strictEqual(salida.length, 1, r.texto);
    assert.ok(salida[0].includes(`marker.js" clear-session ${SID}`), salida[0]);
  }
  // con un empuje a una rama compartida antes del pedido en la misma línea, la salida también aparece
  assert.match((decide(h, 'git push origin main && gh pr create --fill', a) || {}).texto || '', /no es de la historia 9\.99/);
  // el empuje a una rama compartida no lleva la salida: no es un pedido
  assert.doesNotMatch((decide(h, 'git push origin main', a) || {}).texto || '', /no es de la historia/);
});
