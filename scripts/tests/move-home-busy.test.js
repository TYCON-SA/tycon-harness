'use strict';
// move-home-busy.test.js — la mudanza en Windows no arranca si otro programa tiene tomada una carpeta que va a renombrar o
// apartar (scripts/setup/harness/move-home.js, `renamedDirs` y `busyLine`, que corren dentro de las precondiciones y por eso
// también con `--dry-run`).
//
// Por qué: en una máquina Windows la mudanza puede fallar a mitad de camino, en la etapa de los enlaces, con EPERM al
// apartar `~/.claude/agent-skills` (se deshace bien, pero la persona se entera al correrla de verdad). Por eso se prueba
// cada carpeta que se va a renombrar, no sólo la del estado.
//
//   T48a · una carpeta tomada que NO es el estado (agent-skills, y una skill personal) frena: la línea nombra CADA una con su
//          código y dice qué cerrar o que se reinicie Windows; las libres vuelven a su nombre.
//   T48b · todas libres: pasa (null), con un rename real de ida y vuelta en el laboratorio; nada queda con otro nombre.
//          Fuera de Windows no se prueba nada.
//   T48c · un enlace (una unión en Windows) no se prueba: la etapa lo saca o lo re-apunta, la carpeta a la que apunta no se
//          renombra. Tampoco lo personal de un clon viejo que vive aparte (se enlaza, no se mueve).
//   T48d · la prueba no pudo devolver el nombre: se dice cuál quedó con el nombre de la prueba y que se arregle a mano.
//   T48z · nada de esta suite intentó escribir ni borrar en la casa real. Va última.
//
// El rename trabado de Windows no se puede reproducir en otro sistema: se inyecta la operación (`rename`) y el sistema
// (`ctx.platform`). Un HOME de juguete por caso.
//
// Uso: node --test scripts/tests/move-home-busy.test.js
const GUARD = require('./lib/real-home-guard.js');   // primera línea que hace algo: frena y anota todo toque a la casa real
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MH = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'move-home.js'));
const { places, classifyPersonal, renamedDirs, busyLine } = MH.__test;

const casa = (name) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `move-home-busy-${name}-`));
  if (d.startsWith(ROOT) || /agent-skills|\.claude\/|\.tycon\//.test(d)) throw new Error(`el laboratorio cayó en ${d}`);
  return d;
};
const mk = (...parts) => { const d = path.join(...parts); fs.mkdirSync(d, { recursive: true }); return d; };

/** Una máquina de juguete antes de mudarse: el clon, el estado viejo y agent-skills como carpeta real con lo personal. */
function lab(name, { skillsAsLink = false } = {}) {
  const home = casa(name);
  const tree = mk(home, 'clon');
  mk(tree, 'skills', 'tycon-pipeline');
  const ctx = { home, env: { TYCON_HOME: path.join(home, '.tycon') }, platform: 'win32', opts: {} };
  const p = places(ctx, tree);
  mk(p.oldStateDir, 'harness');
  if (skillsAsLink) {
    // la transición del arnés unificado: agent-skills es un enlace a un clon viejo que vive aparte
    const old = mk(home, 'clon-viejo-de-skills');
    mk(old, 'skills', 'mia');
    mk(old, 'skills', 'tycon-pipeline');
    mk(path.dirname(p.skillsLink));
    fs.symlinkSync(old, p.skillsLink, 'dir');
  } else {
    mk(p.skillsLink, 'skills', 'tycon-pipeline');   // del arnés: no se mueve
    mk(p.skillsLink, 'skills', 'mia');              // personal, carpeta real: se renombra
    mk(p.skillsLink, 'agents');
    fs.writeFileSync(path.join(p.skillsLink, 'agents', 'mio.md'), 'x');
  }
  const personal = classifyPersonal({ home, oldSkillsDir: p.skillsLink, tree, ownRoot: p.own.root });
  return { home, tree, ctx, p, personal };
}
const leftovers = (dir) => fs.readdirSync(dir).filter((n) => n.includes('.probe-'));

test('T48a BusyDir_NotTheState_StopsNamingEachWithCode', () => {
  const { ctx, p, personal } = lab('tomada');
  const dirs = renamedDirs(p, personal);
  const mia = path.join(p.skillsLink, 'skills', 'mia');
  assert.deepEqual(dirs, [p.oldStateDir, p.skillsLink, mia], 'el estado, agent-skills y la skill personal real');
  const codes = { [p.skillsLink]: 'EPERM', [mia]: 'EBUSY' };
  const calls = [];
  const rename = (from, to) => {
    calls.push(from);
    if (codes[from]) { const e = new Error(`${codes[from]}: operation not permitted, rename '${from}'`); e.code = codes[from]; throw e; }
    fs.renameSync(from, to);
  };
  const line = busyLine(ctx, dirs, { rename });
  assert.ok(line, 'con una carpeta tomada la mudanza no arranca');
  assert.match(line, /^harness\.js migrate: 2 carpetas que la mudanza tiene que mover están tomadas/);
  assert.ok(line.includes(`${p.skillsLink} (EPERM)`), `nombra agent-skills con su código: ${line}`);
  assert.ok(line.includes(`${mia} (EBUSY)`), `nombra la skill personal con su código: ${line}`);
  assert.ok(!line.includes(`${p.oldStateDir} (`), 'el estado estaba libre: no se nombra');
  assert.match(line, /no se movió nada/);
  for (const w of ['VS Code', 'Claude Code', 'Codex', 'terminales', 'Explorador', 'reiniciá Windows', 'antes de abrir nada']) assert.ok(line.includes(w), `dice qué hacer (${w}): ${line}`);
  // se probaron todas (no se corta en la primera) y las libres volvieron a su nombre
  assert.ok(calls.includes(p.oldStateDir) && calls.includes(p.skillsLink) && calls.includes(mia));
  for (const d of dirs) assert.ok(fs.lstatSync(d).isDirectory(), `${d} sigue en su lugar`);
  assert.deepEqual(leftovers(path.dirname(p.oldStateDir)), []);
  // una sola tomada: en singular
  const one = busyLine(ctx, dirs, { rename: (from, to) => { if (from === p.skillsLink) { const e = new Error('x'); e.code = 'EPERM'; throw e; } fs.renameSync(from, to); } });
  assert.match(one, /una carpeta que la mudanza tiene que mover está tomada por otro programa: .*agent-skills \(EPERM\)/);
});

test('T48b AllFree_Passes_RoundTripLeavesNothingRenamed_OnlyOnWindows', () => {
  const { ctx, p, personal } = lab('libres');
  const dirs = renamedDirs(p, personal);
  const seen = [];
  assert.equal(busyLine(ctx, dirs, { rename: (a, b) => { seen.push([a, b]); fs.renameSync(a, b); } }), null);
  // ida y vuelta por cada carpeta, en ese orden
  assert.equal(seen.length, dirs.length * 2);
  dirs.forEach((d, i) => { assert.equal(seen[2 * i][0], d); assert.equal(seen[2 * i + 1][1], d); });
  for (const d of dirs) assert.ok(fs.lstatSync(d).isDirectory(), `${d} sigue en su lugar`);
  assert.deepEqual(leftovers(path.dirname(p.oldStateDir)), []);
  assert.deepEqual(leftovers(path.join(p.skillsLink, 'skills')), []);
  // con el rename de verdad, sin inyectar
  assert.equal(busyLine(ctx, dirs), null);
  // fuera de Windows no se prueba nada
  let called = 0;
  assert.equal(busyLine({ ...ctx, platform: 'darwin' }, dirs, { rename: () => { called++; } }), null);
  assert.equal(called, 0);
});

test('T48c Junction_NotProbed_NeitherPersonalFromSeparateClone', () => {
  const { ctx, p, personal } = lab('enlace', { skillsAsLink: true });
  assert.equal(personal.oldIsSeparate, true, 'el laboratorio es la transición: agent-skills enlaza a un clon aparte');
  // el estado viejo también como enlace (una mudanza anterior lo dejó así): no se renombra
  const stateReal = mk(ctx.home, 'estado-real');
  fs.rmSync(p.oldStateDir, { recursive: true, force: true });
  fs.symlinkSync(stateReal, p.oldStateDir, 'dir');
  const dirs = renamedDirs(p, personal);
  assert.deepEqual(dirs, [], `ni el enlace ni lo personal del clon aparte: ${JSON.stringify(dirs)}`);
  let called = 0;
  assert.equal(busyLine(ctx, dirs, { rename: () => { called++; const e = new Error('x'); e.code = 'EPERM'; throw e; } }), null);
  assert.equal(called, 0, 'un enlace nunca pasa por la prueba');
});

test('T48d ProbeCannotRenameBack_SaysWhichAndToFixByHand', () => {
  const { ctx, p, personal } = lab('atascada');
  const dirs = renamedDirs(p, personal);
  const rename = (from, to) => {
    if (from.endsWith(`.probe-${process.pid}`) && to === p.oldStateDir) { const e = new Error('x'); e.code = 'EBUSY'; throw e; }
    fs.renameSync(from, to);
  };
  const line = busyLine(ctx, dirs, { rename });
  const probe = `${p.oldStateDir}.probe-${process.pid}`;
  assert.ok(line.includes(`${probe} (EBUSY)`) && /a mano/.test(line), `dice cuál quedó con el nombre de la prueba: ${line}`);
  assert.ok(!/no se movió nada/.test(line), 'algo quedó movido: no dice que no se movió nada');
});

test('T48z RealHome_Untouched_NoWriteOrDeleteAttempted', () => {
  assert.equal(GUARD.attempts().length, 0, `esta suite intentó tocar la casa real (frenado):\n${GUARD.describe()}`);
});
