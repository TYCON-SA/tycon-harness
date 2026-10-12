'use strict';
// real-home-guard.test.js — la red de scripts/tests/lib/real-home-guard.js, medida contra una HOME de mentira.
//
// La red la cargan las suites que llaman código capaz de borrar (move-home.test.js, harness-state.test.js): si dejara
// de frenar o de anotar, esas suites seguirían verdes y la máquina de quien las corre quedaría otra vez sin resguardo
// (2026-10-11: una prueba de «deshacer la mudanza» borró el arnés instalado). Acá cada caso lanza un `node` con su
// HOME apuntando a una carpeta temporal —que hace de «casa real»— y mira qué frenó, qué anotó y con qué código salió.
//
//   G1 · escribir, crear, mover y borrar en ~/.tycon, ~/.claude y ~/.codex se frena (EPERM), queda anotado y, aunque el
//        código se trague el error, el proceso sale 1 nombrando cada intento. Lo que había sigue ahí.
//   G2 · fuera de esas carpetas no frena nada, leer adentro tampoco, y sale 0 sin decir nada.
//   G3 · un `node` lanzado con el ambiente heredado y OTRA HOME carga la misma red con las mismas raíces: su laboratorio
//        no se frena, lo que intente sobre la casa real sí, y lo ve el proceso que lo lanzó.
//   G4 · por un enlace: borrar ADENTRO de un enlace que lleva a la casa real se frena; sacar el enlace, no.
//   G5 · las formas con callback y con promesa también.
//   G6 · una TYCON_HOME del ambiente es casa real.
//
// Uso: node --test scripts/tests/real-home-guard.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GUARD = path.join(__dirname, 'lib', 'real-home-guard.js');
const LINK = process.platform === 'win32' ? 'junction' : 'dir';

const lab = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `real-home-guard-${name}-`));
/** Una «casa real» de mentira con algo adentro de cada carpeta que la red cuida. */
function fakeHome(name) {
  const home = path.join(lab(name), 'casa');
  for (const d of ['.tycon/harness', '.claude', '.codex']) { fs.mkdirSync(path.join(home, d), { recursive: true }); fs.writeFileSync(path.join(home, d, 'keep.txt'), 'estaba\n'); }
  return home;
}
/** Corre un guion en un `node` nuevo cuya HOME es `home`, sin nada de una red ya cargada en el ambiente. */
function run(home, body, extraEnv = {}) {
  const file = path.join(lab('guion'), 'guion.js');
  fs.writeFileSync(file, `'use strict';\nconst G = require(${JSON.stringify(GUARD)});\nconst fs = require('fs'); const path = require('path');\nconst HOME = ${JSON.stringify(home)};\n${body}\n`);
  const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home }, extraEnv);
  for (const k of ['TYCON_REAL_HOME_GUARD_ROOTS', 'TYCON_REAL_HOME_GUARD_LOG', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT']) if (!(k in extraEnv)) delete env[k];
  if (!('TYCON_HOME' in extraEnv)) delete env.TYCON_HOME;
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 60000, env });
  return { rc: r.status, out: r.stdout || '', err: r.stderr || '' };
}
const lastJson = (out) => JSON.parse(out.trim().split('\n').pop());

test('G1 Guard_BlocksAndRecords_WriteCreateMoveDelete_ExitsOneEvenWhenSwallowed', () => {
  const home = fakeHome('g1');
  const r = run(home, `
    const codes = [];
    const tryIt = (f) => { try { f(); codes.push('pasó'); } catch (e) { codes.push(e.code); } };   // tragado, como un rmrf
    tryIt(() => fs.rmSync(path.join(HOME, '.tycon', 'harness'), { recursive: true, force: true }));
    tryIt(() => fs.unlinkSync(path.join(HOME, '.claude', 'keep.txt')));
    tryIt(() => fs.writeFileSync(path.join(HOME, '.codex', 'nuevo.txt'), 'x'));
    tryIt(() => fs.appendFileSync(path.join(HOME, '.tycon', 'harness', 'keep.txt'), 'x'));
    tryIt(() => fs.mkdirSync(path.join(HOME, '.tycon', 'state'), { recursive: true }));
    tryIt(() => fs.renameSync(path.join(HOME, '.tycon', 'harness'), path.join(HOME, 'afuera')));
    tryIt(() => fs.cpSync(path.join(HOME, '.codex'), path.join(HOME, '.claude', 'copia'), { recursive: true }));
    tryIt(() => fs.closeSync(fs.openSync(path.join(HOME, '.claude', 'abierto.txt'), 'w')));
    console.log(JSON.stringify({ codes, fns: G.attempts().map((a) => a.fn) }));
  `);
  const seen = lastJson(r.out);
  assert.deepEqual(seen.codes, Array(8).fill('EPERM'), `todo frenado con EPERM: ${r.out}${r.err}`);
  assert.deepEqual(seen.fns, ['rmSync', 'unlinkSync', 'writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'cpSync', 'openSync']);
  assert.equal(r.rc, 1, `con los errores tragados el proceso igual sale 1: rc ${r.rc}\n${r.err}`);
  assert.match(r.err, /real-home-guard: 8 intento\(s\)/);
  assert.ok(r.err.includes(path.join(home, '.tycon', 'harness')), 'nombra la ruta');
  for (const d of ['.tycon/harness', '.claude', '.codex']) assert.equal(fs.readFileSync(path.join(home, d, 'keep.txt'), 'utf8'), 'estaba\n', `${d} quedó como estaba`);
  assert.deepEqual(fs.readdirSync(path.join(home, '.tycon')), ['harness'], 'no se creó nada');
  assert.ok(!fs.existsSync(path.join(home, 'afuera')) && !fs.existsSync(path.join(home, '.codex', 'nuevo.txt')) && !fs.existsSync(path.join(home, '.claude', 'abierto.txt')));
});

test('G2 Guard_OutsideTheRootsAndReads_NothingBlocked_ExitsZeroSilent', () => {
  const home = fakeHome('g2');
  const r = run(home, `
    fs.mkdirSync(path.join(HOME, 'proyectos', 'x'), { recursive: true });
    fs.writeFileSync(path.join(HOME, 'proyectos', 'x', 'a.txt'), 'a');
    fs.renameSync(path.join(HOME, 'proyectos', 'x', 'a.txt'), path.join(HOME, 'proyectos', 'b.txt'));
    fs.rmSync(path.join(HOME, 'proyectos'), { recursive: true, force: true });
    fs.writeFileSync(path.join(HOME, '.tyconx'), 'un nombre que empieza igual no es la carpeta');
    const read = fs.readFileSync(path.join(HOME, '.tycon', 'harness', 'keep.txt'), 'utf8') + fs.readdirSync(path.join(HOME, '.claude')).join(',');
    fs.closeSync(fs.openSync(path.join(HOME, '.codex', 'keep.txt'), 'r'));
    console.log(JSON.stringify({ read, attempts: G.attempts().length, roots: G.roots().length }));
  `);
  assert.equal(r.rc, 0, `rc ${r.rc}: ${r.out}${r.err}`);
  assert.equal(r.err, '', 'sin intentos no dice nada');
  const seen = lastJson(r.out);
  assert.equal(seen.read, 'estaba\nkeep.txt');
  assert.equal(seen.attempts, 0);
  assert.ok(seen.roots >= 3);
  assert.ok(fs.existsSync(path.join(home, '.tyconx')));
});

test('G3 Guard_ChildWithToyHome_SameRootsTravel_LabNotBlocked_RealBlockedAndSeenByParent', () => {
  const home = fakeHome('g3');
  const toy = path.join(lab('g3-juguete'), 'home');
  const child = path.join(lab('g3-hijo'), 'hijo.js');
  // el hijo NO carga la red a mano: le llega por NODE_OPTIONS; escribe en su laboratorio y prueba borrar en la casa real
  fs.writeFileSync(child, `'use strict';
    const fs = require('fs'); const path = require('path'); const os = require('os');
    const out = { home: os.homedir() };
    fs.mkdirSync(path.join(os.homedir(), '.tycon', 'state'), { recursive: true });
    fs.writeFileSync(path.join(os.homedir(), '.tycon', 'state', 'x.json'), '{}');
    out.lab = fs.existsSync(path.join(os.homedir(), '.tycon', 'state', 'x.json'));
    try { fs.rmSync(${JSON.stringify(path.join(home, '.tycon', 'harness'))}, { recursive: true, force: true }); out.real = 'pasó'; } catch (e) { out.real = e.code; }
    console.log(JSON.stringify(out));
  `);
  const r = run(home, `
    const { spawnSync } = require('child_process');
    const toy = ${JSON.stringify(toy)};
    const c = spawnSync(process.execPath, [${JSON.stringify(child)}], { encoding: 'utf8', env: Object.assign({}, process.env, { HOME: toy, USERPROFILE: toy }) });
    console.log(JSON.stringify({ child: JSON.parse(c.stdout.trim()), childErr: c.stderr, childRc: c.status, mine: G.attempts().map((a) => a.fn) }));
  `);
  const seen = lastJson(r.out);
  assert.equal(seen.child.home, toy, `el hijo corrió con su HOME de juguete: ${r.out}${r.err}`);
  assert.equal(seen.child.lab, true, 'su laboratorio (~/.tycon de juguete) no se frena: las raíces viajan, no se recalculan');
  assert.equal(seen.child.real, 'EPERM', 'la casa real, sí');
  assert.equal(seen.childRc, 0, `el hijo no es quien cierra la cuenta: ${seen.childErr}`);
  assert.deepEqual(seen.mine, ['rmSync'], 'lo que anotó el hijo lo ve quien lo lanzó');
  assert.equal(r.rc, 1);
  assert.ok(fs.existsSync(path.join(home, '.tycon', 'harness', 'keep.txt')));
});

test('G4 Guard_ThroughALink_InsideBlocked_RemovingTheLinkAllowed', () => {
  const home = fakeHome('g4');
  const r = run(home, `
    const link = path.join(HOME, 'atajo');
    fs.symlinkSync(path.join(HOME, '.tycon', 'harness'), link, ${JSON.stringify(LINK)});
    let inside = 'pasó';
    try { fs.rmSync(path.join(link, 'keep.txt'), { force: true }); } catch (e) { inside = e.code; }
    fs.unlinkSync(link);   // el enlace vive afuera: sacarlo no toca la casa real
    let into = 'pasó';
    try { fs.symlinkSync(path.join(HOME, 'x'), path.join(HOME, '.claude', 'enlace'), ${JSON.stringify(LINK)}); } catch (e) { into = e.code; }
    console.log(JSON.stringify({ inside, into, linkLeft: fs.existsSync(link), fns: G.attempts().map((a) => a.fn) }));
  `);
  const seen = lastJson(r.out);
  assert.equal(seen.inside, 'EPERM', `${r.out}${r.err}`);
  assert.equal(seen.into, 'EPERM', 'crear un enlace ADENTRO de la casa real se frena');
  assert.equal(seen.linkLeft, false);
  assert.deepEqual(seen.fns, ['rmSync', 'symlinkSync']);
  assert.equal(fs.readFileSync(path.join(home, '.tycon', 'harness', 'keep.txt'), 'utf8'), 'estaba\n');
});

test('G5 Guard_CallbackAndPromiseForms_AlsoBlocked', () => {
  const home = fakeHome('g5');
  const r = run(home, `
    const target = path.join(HOME, '.tycon', 'harness');
    fs.rm(target, { recursive: true, force: true }, (e1) => {
      fs.promises.rm(target, { recursive: true, force: true }).then(() => 'pasó', (e) => e.code).then((p) => {
        fs.promises.writeFile(path.join(HOME, '.claude', 'p.txt'), 'x').then(() => 'pasó', (e) => e.code).then((w) => {
          console.log(JSON.stringify({ cb: e1 && e1.code, promise: p, write: w, fns: G.attempts().map((a) => a.fn) }));
        });
      });
    });
  `);
  const seen = lastJson(r.out);
  assert.deepEqual(seen, { cb: 'EPERM', promise: 'EPERM', write: 'EPERM', fns: ['rm', 'rm', 'writeFile'] }, `${r.out}${r.err}`);
  assert.equal(r.rc, 1);
  assert.ok(fs.existsSync(path.join(home, '.tycon', 'harness', 'keep.txt')));
});

test('G6 Guard_TyconHomeFromEnv_IsAlsoRealHome', () => {
  const home = fakeHome('g6');
  const elsewhere = path.join(lab('g6-otra'), 'tycon');
  fs.mkdirSync(path.join(elsewhere, 'harness'), { recursive: true });
  const r = run(home, `
    let code = 'pasó';
    try { fs.rmSync(path.join(process.env.TYCON_HOME, 'harness'), { recursive: true, force: true }); } catch (e) { code = e.code; }
    console.log(JSON.stringify({ code }));
  `, { TYCON_HOME: elsewhere });
  assert.equal(lastJson(r.out).code, 'EPERM', `${r.out}${r.err}`);
  assert.ok(fs.existsSync(path.join(elsewhere, 'harness')));
  assert.equal(r.rc, 1);
});
