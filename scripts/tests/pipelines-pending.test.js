'use strict';
/**
 * pipelines-pending.test.js — una tanda en `done` con criterios, tareas o pruebas pendientes no pasa.
 *
 *   T1 PipelinesBlock_PendingOfDoneBatch — el lector cuenta los pendientes de una tanda done en las formas de YAML de
 *      una historia: en el renglón, en renglones con sangría, la secuencia compacta y los finales CRLF
 *   T2 LintFrontmatter_DoneWithPending_NewBlocks_OldWarns — el control frena la tanda done con pendientes que trae el
 *      commit, y avisa la que ya estaba así
 *   T3 UpdatePipelineStatus_DoneWithPending_Refuses — el cierre a done con pendientes se niega, dice cuáles y no
 *      toca la historia; sin pendientes, cierra
 *
 * 🔴 Falla con: una tanda done con pendientes que el control no ve (en cualquier forma válida de YAML), o un cierre que
 *    la pasa a done, o que mueve sus pendientes a hechos como si se hubieran probado.
 * stable-data: archivos y repos de juguete en el temporal; no lee el reloj.
 * 0 deps (node:test).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PB = require(path.join(ROOT, 'scripts', 'lib', 'pipelines-block.js'));
const LINT = path.join(ROOT, 'scripts', 'lib', 'lint-story-frontmatter.js');
const MARKER = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'marker.js');

const tmp = (t, prefijo) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefijo)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const historia = (bloque, { eol = '\n', extra = [] } = {}) =>
  ['---', 'story: "9.1"', 'epic: 9', 'status: in-progress', ...extra, 'pipelines:', ...bloque, '---', '', '# historia', ''].join(eol);
const pendientes = (texto) => PB.tandasDoneConPendientes(texto).map((t) => `${t.name}:${t.cuantos}`);

test('T1 PipelinesBlock_PendingOfDoneBatch — los pendientes de una tanda done, en cada forma', () => {
  const formas = {
    renglon: ['  - name: A', '    status: done', '    acs_pending: [2, 3]'],
    renglones: ['  - name: A', '    status: done', '    acs_pending:', '      - 2', '      - 3'],
    // la secuencia compacta: los `- x` a la misma sangría que su clave (YAML válido; lo escribe PyYAML)
    compacta: ['  - name: A', '    status: done', '    acs_pending:', '    - 2', '    - 3'],
    mapaCompacta: ['  A:', '    status: done', '    tests_pending:', '    - T1', '    - T2'],
    // la lista entre corchetes en el renglón de abajo, y el guion con dos espacios
    corchetesAbajo: ['  - name: A', '    status: done', '    tests_pending:', '      ["T36", "T39"]'],
    dosEspacios: ['  -  name: A', '     status: done', '     acs_pending: [2, 3]'],
  };
  for (const [forma, bloque] of Object.entries(formas)) {
    assert.deepEqual(pendientes(historia(bloque)), ['A:2'], forma);
    assert.deepEqual(pendientes(historia(bloque, { eol: '\r\n' })), ['A:2'], `${forma} con CRLF`);
  }
  // lo vacío no es nada, y una tanda que no está en done no cuenta
  assert.deepEqual(pendientes(historia(['  - name: A', '    status: done', '    acs_pending: []', '    tasks_pending: ~'])), []);
  assert.deepEqual(pendientes(historia(['  - name: A', '    status: blocked', '    acs_pending: [2]'])), []);
  // la secuencia compacta no se come la tanda siguiente
  const dos = historia(['  - name: A', '    status: done', '    acs_pending:', '    - 2', '  - name: B', '    status: done', '    acs: [1]']);
  assert.deepEqual(pendientes(dos), ['A:1']);
  assert.deepEqual(PB.leerTandas(dos.split('\n').slice(1), dos.split('\n').slice(1).findIndex((l) => l === 'pipelines:')).map((t) => t.name), ['A', 'B']);
});

function repo(t) {
  const root = tmp(t, 'pend-repo-');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  return root;
}
const commit = (root, msg) => {
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', msg], { cwd: root });
};
const lint = (root) => {
  const r = spawnSync(process.execPath, [LINT], { cwd: root, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

test('T2 LintFrontmatter_DoneWithPending_NewBlocks_OldWarns — lo nuevo frena, lo que ya estaba avisa', (t) => {
  const root = repo(t);
  const rel = 'specs/story-9.1-x.md';
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, rel), historia(['  - name: A', '    status: in-progress', '    acs_pending: [2]']));
  commit(root, 'base');
  // el commit la pasa a done con el pendiente: frena y nombra la tanda
  fs.writeFileSync(path.join(root, rel), historia(['  - name: A', '    status: done', '    acs_pending: [2]']));
  execFileSync('git', ['add', '-A'], { cwd: root });
  const nueva = lint(root);
  assert.equal(nueva.code, 1, nueva.out);
  assert.match(nueva.out, /done.*pendientes: A \(1\)/s);
  // ya estaba así en el último commit: avisa y no frena
  commit(root, 'ya estaba');
  const vieja = lint(root);
  assert.equal(vieja.code, 0, vieja.out);
  assert.match(vieja.out, /tanda `done` con pendientes/);
});

function cerrar(t, texto, tanda) {
  const dir = tmp(t, 'pend-cierre-');
  const f = path.join(dir, 'story-9.1-x.md');
  fs.writeFileSync(f, texto);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const r = spawnSync(process.execPath, [MARKER, 'update-pipeline-status', f, tanda, 'done'], { cwd: dir, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, despues: fs.readFileSync(f, 'utf8') };
}

test('T3 UpdatePipelineStatus_DoneWithPending_Refuses — el cierre a done con pendientes se niega y no toca la historia', (t) => {
  // los casos de la cuarta vuelta del #1307: en el renglón, compacta, y con un `$` en un nombre de prueba
  const casos = [
    ['  - name: A', '    status: in-progress', '    acs: [1]', '    acs_pending: [3]'],
    ['  - name: A', '    status: in-progress', '    acs: [1]', '    acs_pending:', '    - 3', '    - 4'],
    ['  - name: A', '    status: in-progress', '    tests: ["T0"]', '    tests_pending: ["T1 con $1 y $&"]'],
  ];
  for (const bloque of casos) {
    for (const eol of ['\n', '\r\n']) {
      const antes = historia(bloque, { eol });
      const r = cerrar(t, antes, 'A');
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /pendientes/);
      assert.match(r.out, /\bA\b/);
      assert.equal(r.despues, antes, 'la historia no cambia');
    }
  }
  // sin pendientes, cierra
  const ok = cerrar(t, historia(['  - name: A', '    status: in-progress', '    acs: [1]', '    acs_pending: []']), 'A');
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.despues, /status: done/);
  // un nombre con espacios (el lector viejo del cierre lo cortaba y no encontraba los pendientes), y --all
  for (const tanda of ['Tanda', '--all']) {
    const antes = historia(['  - name: "Tanda A"', '    status: in-progress', '    acs_pending: [3]']);
    const r = cerrar(t, antes, tanda);
    if (tanda === '--all') { assert.equal(r.code, 1, r.out); assert.equal(r.despues, antes); }
    else assert.notEqual(r.despues.includes('status: done'), true, `${tanda}: no la pasa a done (${r.out})`);
  }
  // con finales CRLF y sin pendientes, el cierre escribe done (no dice «done» sin escribirlo)
  const crlf = cerrar(t, historia(['  - name: A', '    status: in-progress', '    acs: [1]'], { eol: '\r\n' }), 'A');
  assert.equal(crlf.code, 0, crlf.out);
  assert.match(crlf.despues, /status: done\r\n/);
  // otra tanda con pendientes no frena el cierre de ésta
  const otra = cerrar(t, historia(['  - name: A', '    status: in-progress', '  - name: B', '    status: blocked', '    acs_pending: [2]']), 'A');
  assert.equal(otra.code, 0, otra.out);
});
