'use strict';
/**
 * harness-place-operations.test.js — la regla de nacimiento del lugar del arnés, con enlaces y carpetas de verdad.
 * En Node a propósito: es la suite que el escenario `place` del pipeline 182 corre en el agente Windows, donde
 * un enlace es un junction y el bash de Git no pregunta bien por él.
 *
 * El riesgo: con un nombre nuevo, el lugar FALTA en todas las máquinas el primer día. Si se creara hacia el clon
 * que corre el instalador, como el equipo trabaja desde clones descartables, el primero que corriera
 * se quedaría con el nombre y al borrarlo lo dejaría colgado. Por eso el lugar nace hacia donde apunta el nombre viejo, o lo
 * que dice el estado, y recién después hacia el clon que corre; el viejo apunta al lugar y no se borra.
 *
 * Qué fija:
 *   T2  el laboratorio se niega a correr si la HOME no es la suya;
 *   T5  S1: viejo → X e instalador desde Y → el lugar va a X; viejo colgado y estado en Z → Z; sin nada → Y;
 *   T6  las 49 celdas de la matriz (y sus variantes), el lugar escrito antes que el viejo, una carpeta real que es un clon
 *       intacta, el ciclo resuelto, y una segunda corrida que no escribe;
 *   T7  conflicto, carpeta ajena y archivo en el lugar, el lugar que no se puede crear, --check de sólo lectura, el
 *       candado (tomado: espera y se va; viejo: se toma) y dos procesos a la vez;
 *   T8  --link con nombre temporal: re-apunta, un temporal que no se crea no borra nada, un cambio final que falla
 *       recrea el destino anterior, una carpeta real en el lugar sale 2, y la vuelta sola de la copia fija no re-apunta
 *       una carpeta real (cae al respaldo y lo anota en startup.log);
 *   T9  los lectores en Node y en shell: primero el lugar, después el viejo, el viejo sin decir nada, y bajo USERPROFILE
 *       cuando difiere de HOME.
 * 🔴 Nunca la HOME real: el laboratorio fija HOME y USERPROFILE a su carpeta y se niega a seguir si os.homedir() da otra.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const IS_WIN = process.platform === 'win32';
const LINK_TYPE = IS_WIN ? 'junction' : 'dir';

// ── la guarda del laboratorio (T2) ──────────────────────────────────────────────────────────────────────────────────
const LAB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-place-operations-')));
if (process.env.TYCON_PLACE_LAB_KEEP_HOME !== '1') { process.env.HOME = LAB; process.env.USERPROFILE = LAB; }
if (path.resolve(os.homedir()) !== path.resolve(LAB)) {
  process.stderr.write(`harness-place-operations: me niego a correr — os.homedir() es ${os.homedir()}, no la carpeta del laboratorio ${LAB}\n`);
  try { fs.rmdirSync(LAB); } catch (_) { /* nada */ }
  process.exit(3);
}
if (process.argv.includes('--guard-only')) { process.stdout.write('guarda: ok\n'); fs.rmdirSync(LAB); process.exit(0); }

const test = require('node:test');
const assert = require('node:assert');
const PLACE = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'place.js'));
const CP_FILE = path.join(ROOT, 'scripts', 'lib', 'canonical-path.js');
const CP = require(CP_FILE);
test.after(() => { try { fs.rmSync(LAB, { recursive: true, force: true }); } catch (_) { /* un proceso de fondo todavía la usa */ } });

let seq = 0;
const dir = (...p) => { const d = path.join(LAB, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
/** Un clon de juguete del arnés: tiene scripts/install-tycon-hooks.sh (el criterio de «clon válido»). */
function clone(name) {
  const d = dir('clones', `${name}-${++seq}`);
  fs.mkdirSync(path.join(d, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(d, 'scripts', 'install-tycon-hooks.sh'), '#!/usr/bin/env bash\n');
  fs.writeFileSync(path.join(d, 'testigo.txt'), 'el clon de la persona\n');
  return fs.realpathSync(d);
}
/** Un clon de juguete que además trae el código que corre (scripts/lib y scripts/setup copiados: uno enlazado no sirve). */
function fullClone(name) {
  const d = clone(name);
  fs.cpSync(path.join(ROOT, 'scripts', 'lib'), path.join(d, 'scripts', 'lib'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'scripts', 'setup'), path.join(d, 'scripts', 'setup'), { recursive: true });
  return d;
}
function home(name) { const h = dir('homes', `${name}-${++seq}`); fs.mkdirSync(path.join(h, '.claude'), { recursive: true }); return h; }
const placeOf = (h) => PLACE.placePath(h);
const legacyOf = (h) => PLACE.legacyPlacePath(h);
const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return null; } };
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; } };
const isRealDir = (p) => { try { const s = fs.lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch (_) { return false; } };
const exists = (p) => { try { fs.lstatSync(p); return true; } catch (_) { return false; } };
const direct = (p) => { try { return path.resolve(path.dirname(p), fs.readlinkSync(p)); } catch (_) { return null; } };
const link = (target, at) => fs.symlinkSync(target, at, LINK_TYPE);
function cli(args, env = {}) {
  return spawnSync(process.execPath, [CP_FILE, ...args], { encoding: 'utf8', env: Object.assign({}, process.env, { TYCON_NO_CANONICAL_PATH: '' }, env) });
}
function writeState(h, tree) {
  const d = path.join(h, '.claude', '.tycon-pipeline'); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'harness-state.json'), JSON.stringify({ schema: 1, mode: 'managed', tree }, null, 2));
}
/** El hash de todo lo que hay bajo la HOME (nombres, tipos, destinos de los enlaces y contenidos). */
function homeHash(h) {
  const hash = crypto.createHash('sha256');
  const walk = (d) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n); const s = fs.lstatSync(p);
      if (s.isSymbolicLink()) hash.update(`L ${p} ${fs.readlinkSync(p)}\n`);
      else if (s.isDirectory()) { hash.update(`D ${p}\n`); walk(p); }
      else hash.update(`F ${p} ${fs.readFileSync(p).toString('base64')}\n`);
    }
  };
  walk(h);
  return hash.digest('hex');
}
/** Corre `fn` mirando en qué orden se crean los enlaces (el temporal cuenta por el nombre al que va). */
function observeWrites(fn) {
  const order = [];
  const orig = fs.symlinkSync;
  fs.symlinkSync = function (target, at, type) { order.push(String(at).replace(/\.tycon-new-\d+$/, '')); return orig.call(fs, target, at, type); };
  try { return { result: fn(), order }; } finally { fs.symlinkSync = orig; }
}

// ── T2 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T2 Labs_RefuseRealHome_ToyHomeOnly — lanzado con otra HOME, se niega, sale ≠ 0 y no escribe', () => {
  const other = home('no-es-el-lab');
  const before = homeHash(other);
  const r = spawnSync(process.execPath, [__filename, '--guard-only'], { encoding: 'utf8', env: Object.assign({}, process.env, { TYCON_PLACE_LAB_KEEP_HOME: '1', HOME: other, USERPROFILE: other }) });
  assert.notStrictEqual(r.status, 0, `la guarda dejó correr con otra HOME: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /me niego a correr/);
  assert.strictEqual(homeHash(other), before, 'escribió algo en la HOME que no es la suya');
  const ok = spawnSync(process.execPath, [__filename, '--guard-only'], { encoding: 'utf8' });
  assert.strictEqual(ok.status, 0, `con la HOME del laboratorio, la guarda pasa: ${ok.stderr}`);
});

// ── T5 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T5 Birth_LegacyOrStateTree_NeverInstallerClone', () => {
  // (1) una máquina ya instalada: el viejo → X; el instalador nuevo corre primero desde Y, descartable
  const X = clone('X'); const Y = clone('Y'); const h = home('s1');
  link(X, legacyOf(h));
  const r = CP.ensurePlace({ clon: Y, home: h });
  assert.strictEqual(real(placeOf(h)), X, `el lugar nació hacia ${real(placeOf(h))}, no hacia X (${r.mensaje})`);
  assert.ok(PLACE.samePath(direct(legacyOf(h)), placeOf(h)), 'el viejo no quedó apuntando al lugar');
  assert.strictEqual(real(legacyOf(h)), X, 'los dos resuelven a X');
  fs.rmSync(Y, { recursive: true, force: true });
  assert.ok(real(placeOf(h)) && real(legacyOf(h)), 'borrar Y dejó algo colgado');
  // (2) el viejo colgado (su clon se borró) y el estado en Z: el lugar nace hacia Z, no hacia el clon que corre
  const Z = clone('Z'); const Y2 = clone('Y2'); const h2 = home('s1-state');
  link(path.join(LAB, 'borrado-hace-rato'), legacyOf(h2)); writeState(h2, Z);
  CP.ensurePlace({ clon: Y2, home: h2 });
  assert.strictEqual(real(placeOf(h2)), Z, 'con el viejo colgado, el lugar sigue al estado');
  assert.strictEqual(real(legacyOf(h2)), Z, 'y el viejo, reparado hacia el lugar');
  // --prefer (lo pasa harness.js) vale como el estado
  const P = clone('P'); const h2b = home('s1-prefer');
  CP.ensurePlace({ clon: Y2, home: h2b, prefer: P });
  assert.strictEqual(real(placeOf(h2b)), P, '--prefer gana al clon que corre');
  // (3) sin viejo ni estado legible: recién ahí, el clon que corre
  const h3 = home('s1-none'); fs.mkdirSync(path.join(h3, '.claude', '.tycon-pipeline'), { recursive: true });
  fs.writeFileSync(path.join(h3, '.claude', '.tycon-pipeline', 'harness-state.json'), '{ esto no es json');
  CP.ensurePlace({ clon: Y2, home: h3 });
  assert.strictEqual(real(placeOf(h3)), Y2, 'sin estado legible, el clon que corre');
});

// ── T6 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Cada nombre en uno de sus siete estados. `which` es 'place' o 'legacy'; `ctx` trae los clones de la celda.
function build(h, which, kind, ctx, variant) {
  const at = which === 'place' ? placeOf(h) : legacyOf(h);
  switch (kind) {
    case 'F': return;
    case 'E': {
      if (which === 'place') return link(ctx.P, at);
      if (variant === 'atPlace') return link(placeOf(h), at);       // ya apunta al lugar
      if (variant === 'other') return link(ctx.K2, at);             // a otro clon: conflicto si el lugar resuelve
      if (variant === 'sameAsPlace') return link(ctx.placeTarget(), at);   // directo al mismo clon que el lugar
      return link(ctx.K, at);
    }
    case 'C': return link(path.join(LAB, 'no-existe', `${which}-${seq}`), at);
    case 'N': return link(ctx.notClone, at);
    case 'R': {
      fs.mkdirSync(path.join(at, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(at, 'scripts', 'install-tycon-hooks.sh'), '#!/usr/bin/env bash\n');
      fs.writeFileSync(path.join(at, 'testigo.txt'), 'clon real\n');
      return;
    }
    case 'X': fs.mkdirSync(at, { recursive: true }); fs.writeFileSync(path.join(at, 'mio.txt'), 'algo ajeno\n'); return;
    case 'A': fs.writeFileSync(at, 'un archivo donde iría el nombre\n'); return;
    default: throw new Error(kind);
  }
}
const KINDS = ['F', 'E', 'C', 'N', 'R', 'X', 'A'];
// lo que dice la matriz de «Cómo funciona» para cada celda: a dónde queda el lugar ('D' = el clon que corre, 'K' = el
// clon del viejo, 'LR' = la carpeta real del viejo, 'same' = como estaba) y qué le pasa al viejo ('toPlace' | 'same')
function expected(p, v, variant) {
  if (p === 'X' || p === 'A') return { place: 'same', legacy: 'same', accion: 'real-folder' };
  if (p === 'F' || p === 'C' || p === 'N') {
    if (v === 'R') return { place: 'LR', legacy: 'same' };
    if (v === 'E') return { place: 'K', legacy: 'toPlace' };
    if (v === 'F') return { place: 'D', legacy: CP.LEGACY_FOR_NEW_MACHINES ? 'toPlace' : 'same' };   // V→L*: «—»
    return { place: 'D', legacy: v === 'X' || v === 'A' ? 'same' : 'toPlace' };
  }
  // el lugar ya resuelve a un clon (E → P, o R)
  if (v === 'F') return { place: 'same', legacy: CP.LEGACY_FOR_NEW_MACHINES ? 'toPlace' : 'same' };   // V→L*: «—»
  if (v === 'C' || v === 'N') return { place: 'same', legacy: 'toPlace' };
  if (v === 'X' || v === 'A') return { place: 'same', legacy: 'same' };
  if (v === 'R') return p === 'E' && variant === 'placeAtLegacy' ? { place: 'same', legacy: 'same' } : { place: 'same', legacy: 'same', accion: 'conflict' };
  // v === 'E'
  if (variant === 'other') return { place: 'same', legacy: 'same', accion: 'conflict' };
  if (variant === 'atPlace') return { place: 'same', legacy: 'same' };
  return { place: 'same', legacy: 'toPlace' };   // directo al mismo clon: se re-apunta al lugar
}
function cells() {
  const out = [];
  for (const p of KINDS) for (const v of KINDS) {
    // la variante por defecto de cada celda; las que la matriz parte en casos, con sus variantes
    if ((p === 'E' || p === 'R') && v === 'E') { for (const variant of ['sameAsPlace', 'atPlace', 'other']) out.push({ p, v, variant }); continue; }
    if (p === 'E' && v === 'R') { for (const variant of ['placeAtLegacy', 'apart']) out.push({ p, v, variant }); continue; }
    out.push({ p, v, variant: null });
  }
  return out;
}
test('T6 Birth_Matrix49Cells_PlaceFirst_RealCloneUntouched_CycleResolved_Idempotent', () => {
  const all = cells();
  assert.strictEqual(new Set(all.map((c) => `${c.p}${c.v}`)).size, 49, 'las 49 celdas');
  const running = clone('corre');
  for (const c of all) {
    const h = home(`m-${c.p}${c.v}${c.variant ? `-${c.variant}` : ''}`);
    const ctx = { P: clone('P'), K: clone('K'), K2: clone('K2'), notClone: dir('no-clones', `n-${++seq}`), placeTarget: () => (c.p === 'R' ? placeOf(h) : ctx.P) };
    if (c.p === 'E' && c.v === 'R' && c.variant === 'placeAtLegacy') { build(h, 'legacy', 'R', ctx); link(legacyOf(h), placeOf(h)); }
    else { build(h, 'place', c.p, ctx); build(h, 'legacy', c.v, ctx, c.variant); }
    const label = `celda ${c.p}×${c.v}${c.variant ? ` (${c.variant})` : ''}`;
    const placeBefore = real(placeOf(h)); const legacyDirectBefore = direct(legacyOf(h)); const legacyRealBefore = real(legacyOf(h));
    const { result: r, order } = observeWrites(() => CP.ensurePlace({ clon: running, home: h }));
    const exp = expected(c.p, c.v, c.variant);
    if (exp.accion) assert.strictEqual(r.accion, exp.accion, `${label}: acción ${r.accion} (${r.mensaje})`);
    // el lugar
    const want = { D: running, K: ctx.K, LR: legacyRealBefore, same: placeBefore }[exp.place];
    if (c.p === 'X' || c.p === 'A') assert.ok(c.p === 'X' ? isRealDir(placeOf(h)) : fs.lstatSync(placeOf(h)).isFile(), `${label}: el lugar se tocó`);
    else assert.strictEqual(real(placeOf(h)), want, `${label}: el lugar quedó en ${real(placeOf(h))}, se esperaba ${want} (${r.mensaje})`);
    // el viejo
    if (exp.legacy === 'toPlace') assert.ok(isLink(legacyOf(h)) && PLACE.samePath(direct(legacyOf(h)), placeOf(h)), `${label}: el viejo no apunta al lugar (${direct(legacyOf(h))})`);
    else if (c.v === 'F') assert.ok(!exists(legacyOf(h)), `${label}: el viejo apareció`);
    else if (isLink(legacyOf(h))) assert.strictEqual(direct(legacyOf(h)), legacyDirectBefore, `${label}: el viejo se re-apuntó`);
    // una carpeta real que es un clon, en cualquiera de los dos nombres, intacta
    for (const n of [placeOf(h), legacyOf(h)]) if (fs.existsSync(path.join(n, 'testigo.txt')) && !isLink(n)) assert.ok(isRealDir(n), `${label}: la carpeta real ${n} se tocó`);
    // el lugar antes que el viejo
    const iP = order.indexOf(placeOf(h)); const iV = order.indexOf(legacyOf(h));
    if (iP >= 0 && iV >= 0) assert.ok(iP < iV, `${label}: el viejo se escribió antes que el lugar`);
    // la segunda corrida no escribe
    const again = observeWrites(() => CP.ensurePlace({ clon: running, home: h }));
    assert.deepStrictEqual(again.order, [], `${label}: la segunda corrida escribió (${again.result.mensaje})`);
  }
  // el ciclo: el viejo apunta al lugar y el lugar al viejo (los dos colgados) → el lugar a D, el viejo al lugar
  const h = home('ciclo');
  link(legacyOf(h), placeOf(h)); link(placeOf(h), legacyOf(h));
  CP.ensurePlace({ clon: running, home: h });
  assert.strictEqual(real(placeOf(h)), running, 'el ciclo: el lugar hacia D');
  assert.ok(PLACE.samePath(direct(legacyOf(h)), placeOf(h)) && real(legacyOf(h)) === running, 'el ciclo: el viejo hacia el lugar');
  // una máquina que ya tenía el viejo: el viejo apunta al lugar, y no queda anotado como nacido por la regla de máquina nueva
  const had = home('ya-tenia'); link(running, legacyOf(had)); CP.ensurePlace({ clon: running, home: had });
  assert.ok(isLink(placeOf(had)) && PLACE.samePath(direct(legacyOf(had)), placeOf(had)), 'una máquina que ya tenía el viejo: el viejo al lugar');
  assert.ok(!fs.existsSync(path.join(had, '.claude', '.tycon-pipeline', 'legacy-place-born.json')), 'una máquina que ya tenía el viejo quedó anotada');
});

// ── T41 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Una máquina que no tenía el nombre viejo no lo recibe (las celdas V→L* son «—»): los
// textos nombran el lugar, y una máquina nueva queda con un solo nombre. Por la API y por la línea de comandos que
// llama el instalador; la segunda corrida no escribe.
test('T41 FreshMachine_NoLegacyAfterTandaC_OnboardingAgain', () => {
  assert.strictEqual(CP.LEGACY_FOR_NEW_MACHINES, false, 'la llave de máquina nueva sigue prendida después de la tanda C');
  const running = clone('corre-c');
  const fresh = home('nueva-c'); CP.ensurePlace({ clon: running, home: fresh });
  assert.ok(isLink(placeOf(fresh)) && real(placeOf(fresh)) === running, 'una máquina nueva: el lugar hacia el clon');
  assert.ok(!exists(legacyOf(fresh)), 'una máquina nueva recibió el nombre viejo');
  assert.ok(!fs.existsSync(path.join(fresh, '.claude', '.tycon-pipeline', 'legacy-place-born.json')), 'se anotó un viejo que no nació');
  const again = observeWrites(() => CP.ensurePlace({ clon: running, home: fresh }));
  assert.deepStrictEqual(again.order, [], 'la segunda corrida escribió');
  // por la línea de comandos, como la llama el instalador
  const fresh2 = home('nueva-c-cli');
  const r = cli(['--ensure-link', '--clone', running, '--home', fresh2]);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok(isLink(placeOf(fresh2)) && !exists(legacyOf(fresh2)), `por la línea de comandos: ${r.stdout}`);
  assert.ok(!r.stdout.includes(legacyOf(fresh2)), `el mensaje nombra el viejo en una máquina que no lo tiene: ${r.stdout}`);
});

// ── T7 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T7 Birth_Conflict_PlaceForeign_CannotCreate_CheckReadOnly_TwoProcessesLock', async () => {
  const A = clone('A'); const B = clone('B'); const running = clone('corre');
  // conflicto: los dos nombres resuelven a clones distintos → no se mueve ninguno; la línea nombra las dos y --link; sale 0
  const hc = home('conflicto'); link(A, placeOf(hc)); link(B, legacyOf(hc));
  const c = cli(['--ensure-link', '--clone', running, '--home', hc]);
  assert.strictEqual(c.status, 0);
  assert.ok(c.stdout.includes(A) && c.stdout.includes(B) && /--link/.test(c.stdout), `la línea del conflicto: ${c.stdout}`);
  assert.ok(real(placeOf(hc)) === A && real(legacyOf(hc)) === B, 'el conflicto movió algo');
  // una carpeta ajena o un archivo en el lugar: no se pisa y se avisa (en cada arranque: el aviso de canonical-path)
  for (const kind of ['X', 'A']) {
    const h = home(`ajeno-${kind}`); build(h, 'place', kind, {});
    const before = homeHash(h);
    const r = cli(['--ensure-link', '--clone', running, '--home', h]);
    assert.strictEqual(r.status, 0); assert.match(r.stdout, /no lo piso/);
    assert.strictEqual(homeHash(h), before, `${kind}: se escribió algo`);
    assert.ok(CP.aviso({ clon: running, home: h, env: {} }), `${kind}: el aviso de cada arranque no sonó`);
  }
  // el lugar no se puede crear: `.claude` es un archivo → una línea, el viejo intacto, sale 0
  const hf = dir('homes', `claude-archivo-${++seq}`); fs.writeFileSync(path.join(hf, '.claude'), 'archivo');
  const rf = cli(['--ensure-link', '--clone', running, '--home', hf]);
  assert.strictEqual(rf.status, 0); assert.match(rf.stdout, /no pude/);
  // …y `.claude` de sólo lectura con el viejo adentro (no aplica a root, que escribe igual: NO MEDIDO ahí)
  if (!IS_WIN && typeof process.getuid === 'function' && process.getuid() !== 0) {
    const hr = home('solo-lectura'); link(A, legacyOf(hr)); fs.chmodSync(path.join(hr, '.claude'), 0o555);
    const rr = cli(['--ensure-link', '--clone', running, '--home', hr]);
    fs.chmodSync(path.join(hr, '.claude'), 0o755);
    assert.strictEqual(rr.status, 0); assert.match(rr.stdout, /no pude/);
    assert.ok(!exists(placeOf(hr)) && real(legacyOf(hr)) === A && direct(legacyOf(hr)) === A, 'el viejo no quedó intacto');
  } else console.log('⏭ T7: NO MEDIDO — «.claude de sólo lectura» (Windows o root: no hay permiso que negar así)');
  // --check: dice qué haría, no toma el candado y no escribe (HOME idéntica por hash)
  const hk = home('check'); link(A, legacyOf(hk));
  const before = homeHash(hk);
  const k = cli(['--ensure-link', '--clone', running, '--home', hk, '--check']);
  assert.strictEqual(k.status, 0); assert.match(k.stdout, /^\(--check\)/m);
  assert.strictEqual(homeHash(hk), before, '--check escribió');
  // el candado tomado y fresco: espera hasta 5 s y se va sin escribir
  const hl = home('candado'); const lock = path.join(hl, '.claude', '.tycon-pipeline', 'place.lock'); fs.mkdirSync(lock, { recursive: true });
  const t0 = Date.now(); const busy = cli(['--ensure-link', '--clone', running, '--home', hl]);
  assert.strictEqual(busy.status, 0); assert.match(busy.stdout, /place\.lock tomado/);
  assert.ok(Date.now() - t0 >= 4500, 'no esperó al candado');
  assert.ok(!exists(placeOf(hl)), 'escribió con el candado tomado');
  // uno de 3 minutos se considera abandonado: se toma
  const old = new Date(Date.now() - 3 * 60 * 1000); fs.utimesSync(lock, old, old);
  const took = cli(['--ensure-link', '--clone', running, '--home', hl]);
  assert.strictEqual(took.status, 0); assert.strictEqual(real(placeOf(hl)), running, `el candado viejo no se tomó: ${took.stdout}`);
  assert.ok(!exists(lock), 'el candado quedó tomado');
  // la carrera: B espera el candado mientras A crea el lugar hacia su clon. Con el plan calculado
  // ANTES del candado, B escribiría su plan viejo y el clon descartable se quedaría con el lugar. El plan se calcula con el
  // candado tomado: B ve el lugar que dejó A y no lo toca.
  const stable = clone('estable'); const disposable = clone('descartable'); const hr = home('carrera');
  const rlock = path.join(hr, '.claude', '.tycon-pipeline', 'place.lock'); fs.mkdirSync(rlock, { recursive: true });
  const raceOut = await new Promise((res) => {
    const p = spawn(process.execPath, [CP_FILE, '--ensure-link', '--clone', disposable, '--home', hr]);
    let out = ''; p.stdout.on('data', (d) => { out += d; });
    setTimeout(() => { link(stable, placeOf(hr)); fs.rmdirSync(rlock); }, 800);
    p.on('close', (code) => res({ code, out }));
  });
  assert.strictEqual(raceOut.code, 0);
  assert.strictEqual(real(placeOf(hr)), stable, `la carrera: el clon descartable se quedó con el lugar (${raceOut.out})`);
  assert.doesNotMatch(raceOut.out, /lugar .* \(creado/, `la carrera: B dijo que creó el lugar (${raceOut.out})`);
  // dos procesos a la vez: el estado final es el de la matriz, sin temporales sueltos
  const h2 = home('dos'); link(A, legacyOf(h2));
  const run = () => new Promise((res) => { const p = spawn(process.execPath, [CP_FILE, '--ensure-link', '--clone', running, '--home', h2]); p.on('close', res); });
  const codes = await Promise.all([run(), run()]);
  assert.deepStrictEqual(codes, [0, 0]);
  assert.strictEqual(real(placeOf(h2)), A); assert.ok(PLACE.samePath(direct(legacyOf(h2)), placeOf(h2)));
  assert.deepStrictEqual(fs.readdirSync(path.join(h2, '.claude')).filter((n) => /tycon-new/.test(n)), [], 'quedó un temporal');
});

// ── T8 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T8 Link_TempNameSwap_FourOperations_RealFolderRefused', () => {
  const A = clone('A'); const B = clone('B');
  // una máquina del equipo: el viejo ya estaba (una máquina nueva no lo recibe)
  const h = home('link'); link(A, legacyOf(h)); CP.ensurePlace({ clon: A, home: h });
  assert.ok(real(placeOf(h)) === A && real(legacyOf(h)) === A);
  // re-apunta con nombre temporal; después, los dos nombres resuelven a la misma carpeta
  const { result: r, order } = observeWrites(() => CP.ensurePlace({ clon: A, home: h, forzar: B }));
  assert.strictEqual(r.accion, 'repointed', r.mensaje);
  assert.ok(order.length === 1 && order[0] === placeOf(h), `se creó el temporal del lugar: ${order.join(', ')}`);
  assert.ok(real(placeOf(h)) === B && real(legacyOf(h)) === B, 'después del --link los dos nombres no resuelven a lo mismo');
  // crear el temporal falla → no se borró nada
  const orig = fs.symlinkSync;
  fs.symlinkSync = function (t, at, type) { if (/\.tycon-new-\d+$/.test(String(at))) { const e = new Error('EPERM simulado'); e.code = 'EPERM'; throw e; } return orig.call(fs, t, at, type); };
  let r2; try { r2 = CP.ensurePlace({ clon: A, home: h, forzar: A }); } finally { fs.symlinkSync = orig; }
  assert.strictEqual(r2.accion, 'error'); assert.strictEqual(real(placeOf(h)), B, 'un temporal que no se creó borró el lugar');
  // el cambio final falla → el lugar se recrea hacia el destino anterior y se dice
  const origRename = fs.renameSync;
  fs.renameSync = function () { const e = new Error('EBUSY simulado'); e.code = 'EBUSY'; throw e; };
  let r3; try { r3 = CP.ensurePlace({ clon: A, home: h, forzar: A }); } finally { fs.renameSync = origRename; }
  assert.strictEqual(r3.accion, 'error'); assert.match(r3.mensaje, /destino anterior/);
  assert.strictEqual(real(placeOf(h)), B, 'el lugar no volvió al destino anterior');
  assert.deepStrictEqual(fs.readdirSync(path.join(h, '.claude')).filter((n) => /tycon-new/.test(n)), [], 'quedó el temporal');
  // una ruta que no es un clon: todo como estaba, sale 2
  const notClone = dir('no-clones', `n-${++seq}`);
  const bad = cli(['--ensure-link', '--clone', A, '--home', h, '--link', notClone]);
  assert.strictEqual(bad.status, 2); assert.strictEqual(real(placeOf(h)), B);
  // una carpeta real en el lugar (quien clonó ahí): --link sale 2 con el mensaje; nada se toca
  const hr = home('lugar-real'); build(hr, 'place', 'R', {});
  const before = homeHash(hr);
  const ref = cli(['--ensure-link', '--clone', A, '--home', hr, '--link', B]);
  assert.strictEqual(ref.status, 2); assert.match(ref.stdout, /el lugar .* es una carpeta real \(tu clon\): no lo re-apunto; cloná en otra carpeta para usar el modo desarrollador/);
  assert.strictEqual(homeHash(hr), before);
  // la vuelta sola de la copia fija (modo desarrollador con el clon borrado) no re-apunta una carpeta real: cae al
  // respaldo y lo anota en startup.log
  const before2 = fullClone('antes'); const gone = path.join(LAB, 'clon-borrado');
  const hb = LAB;   // la copia fija lee os.homedir(), que en el laboratorio ES la carpeta del laboratorio
  for (const p of [placeOf(hb), legacyOf(hb)]) { try { fs.rmSync(p, { recursive: false }); } catch (_) { /* no estaba */ } }
  build(hb, 'place', 'R', {});
  const pipe = path.join(hb, '.claude', '.tycon-pipeline'); fs.mkdirSync(pipe, { recursive: true });
  fs.writeFileSync(path.join(pipe, 'harness-state.json'), JSON.stringify({ schema: 1, mode: 'developer', tree: gone, tree_before: before2 }));
  const boot = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'setup', 'harness', 'bootstrap.js'), 'startup'], { encoding: 'utf8' });
  assert.notStrictEqual(boot.status, 0, 'la copia fija tenía que caer al respaldo');
  assert.ok(isRealDir(placeOf(hb)), 'la carpeta real del lugar se tocó');
  const log = fs.readFileSync(path.join(pipe, 'harness', 'startup.log'), 'utf8');
  assert.match(log, /carpeta real/, `startup.log no lo anota: ${log}`);
  fs.rmSync(placeOf(hb), { recursive: true, force: true }); fs.rmSync(pipe, { recursive: true, force: true });
});

// ── T9 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const HAS_BASH = spawnSync('bash', ['-c', 'exit 0']).status === 0;
/**
 * La ruta como la ve el bash de Git en Windows. Se le pregunta al propio bash: su `cygpath` vive en `<Git>\usr\bin`, que
 * el bash pone en su PATH, y el PATH de Node en general no lo trae (con sólo `Git\bin` en el PATH,
 * `cygpath` llamado desde Node no existe). null si no se pudo: la parte de shell queda
 * NO MEDIDO, con el motivo, en vez de reventar.
 */
function bashPath(p) {
  if (!IS_WIN) return p;
  const r = spawnSync('bash', ['-c', 'command -v cygpath >/dev/null 2>&1 && cygpath -u "$1"', 'x', p], { encoding: 'utf8' });
  const out = r.status === 0 && typeof r.stdout === 'string' ? r.stdout.trim() : '';
  return out || null;
}
/** La función `harness_dir` tal como está escrita en un archivo de shell (los lectores en shell la llevan igual). */
function shellFn(rel) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const i = text.indexOf('harness_dir() {');
  assert.ok(i >= 0, `${rel}: no tiene harness_dir`);
  return text.slice(i, text.indexOf('\n}\n', i) + 2);
}
function runShell(fnText, env) {
  return spawnSync('bash', ['-c', `${fnText}\nharness_dir`], { encoding: 'utf8', env: Object.assign({ PATH: process.env.PATH }, env) });
}
test('T9 Readers_PlaceFirstThenLegacy_SilentFallback_LegacyNamedOnlyIfPresent_UserprofileTried', () => {
  const A = clone('A'); const B = clone('B');
  const both = home('both'); link(A, placeOf(both)); link(B, legacyOf(both));
  const onlyLegacy = home('only-legacy'); link(B, legacyOf(onlyLegacy));
  const none = home('none');
  const badPlace = home('bad-place'); link(dir('no-clones', `n-${++seq}`), placeOf(badPlace)); link(B, legacyOf(badPlace));
  // place.js
  assert.strictEqual(PLACE.resolvePlace({ home: both }).dir, A, 'resolvePlace: con los dos, el lugar');
  const ol = PLACE.resolvePlace({ home: onlyLegacy });
  assert.ok(ol.dir === B && ol.via === 'legacy', 'resolvePlace: con sólo el viejo, el viejo');
  const n = PLACE.resolvePlace({ home: none });
  assert.ok(n.dir === null && n.present.length === 0, 'resolvePlace: con ninguno, nada (y el viejo no está presente: no se nombra)');
  const bp = PLACE.resolvePlace({ home: badPlace });
  assert.ok(bp.dir === B && bp.invalid.length === 1 && bp.invalid[0].path === placeOf(badPlace), 'resolvePlace: el lugar que no es un clon no vale y se dice');
  // tycon-config.js
  const cfg = require(path.join(ROOT, 'scripts', 'lib', 'tycon-config.js'));
  assert.strictEqual(cfg.estadoEnlace({ home: both, arnes: A }).estado, 'ok');
  const e = cfg.estadoEnlace({ home: onlyLegacy, arnes: B });
  assert.ok(e.estado === 'ok' && e.ruta === legacyOf(onlyLegacy), `tycon-config: con sólo el viejo, el viejo (${JSON.stringify(e)})`);
  assert.strictEqual(cfg.estadoEnlace({ home: none, arnes: A }).ruta, placeOf(none), 'tycon-config: con ninguno, nombra el lugar');
  // el aviso de cada arranque: con sólo el viejo, callado (comparando como el sistema: samePath)
  assert.strictEqual(CP.aviso({ clon: B, home: onlyLegacy, env: {} }), null, 'el aviso habló con sólo el viejo');
  assert.strictEqual(CP.aviso({ clon: `${B}${path.sep}`, home: onlyLegacy, env: {} }), null, 'el aviso habló con una barra final de más');
  // un archivo leído POR EL VIEJO, que pasa por el lugar (un junction a otro junction en
  // Windows), con `[ -f ]` y `[ -d ]` del bash: es lo que hacen los hooks
  const chain = home('cadena'); link(B, placeOf(chain)); link(placeOf(chain), legacyOf(chain));
  const viaLegacy = HAS_BASH ? bashPath(legacyOf(chain)) : null;
  if (viaLegacy) {
    const r = spawnSync('bash', ['-c', '[ -d "$1/scripts" ] && [ -f "$1/scripts/install-tycon-hooks.sh" ] && [ -f "$1/testigo.txt" ]', 'x', viaLegacy], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `bash no lee un archivo por el viejo → el lugar → el clon (${r.stderr})`);
  } else console.log(`⏭ T9: NO MEDIDO — leer por el viejo con [ -f ] (${HAS_BASH ? 'el bash no tiene cygpath para traducir la ruta de Windows' : 'no hay bash'})`);
  // la copia fija nueva: primero el lugar, después el viejo, sin require del árbol
  const boot = fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'harness', 'bootstrap.js'), 'utf8');
  assert.ok(!/require\(\s*['"]\.{1,2}\//.test(boot), 'bootstrap.js hace require del árbol');
  assert.match(boot, /\[LINK, LEGACY_LINK\]\.map\(realDir\)/);
  // los lectores en shell: la misma función en los tres archivos, y anda
  if (!HAS_BASH) { console.log('⏭ T9: NO MEDIDO — los lectores en shell (no hay bash)'); return; }
  const fns = ['scripts/hooks/git-pre-commit-global.sh', '.githooks/pre-commit-checks'].map(shellFn);
  assert.strictEqual(fns[0], fns[1], 'los dos lectores en shell llevan la misma función');
  const sh = fns[0];
  if (!bashPath(LAB)) { console.log('⏭ T9: NO MEDIDO — los lectores en shell (el bash no tiene cygpath para traducir la ruta de Windows)'); return; }
  assert.strictEqual(runShell(sh, { HOME: both }).stdout, bashPath(placeOf(both)), 'shell: con los dos, el lugar');
  assert.strictEqual(runShell(sh, { HOME: onlyLegacy }).stdout, bashPath(legacyOf(onlyLegacy)), 'shell: con sólo el viejo, el viejo');
  assert.strictEqual(runShell(sh, { HOME: none }).stdout, bashPath(placeOf(none)), 'shell: con ninguno, el lugar (lo de hoy: el hook avisa y sigue)');
  assert.strictEqual(runShell(sh, { HOME: none, TYCON_GUIDES_DIR: A }).stdout, A, 'shell: TYCON_GUIDES_DIR sigue ganando');
  // HOME distinta de USERPROFILE (Windows con HOME en otra carpeta: supuesto P4, simulado): lo encuentra bajo USERPROFILE
  assert.strictEqual(runShell(sh, { HOME: none, USERPROFILE: onlyLegacy }).stdout, bashPath(legacyOf(onlyLegacy)), 'shell: bajo USERPROFILE');
  // el respaldo en shell de la copia fija: el mismo orden (su bloque de búsqueda, corrido tal cual)
  const fb = fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'harness', 'bootstrap-fallback.sh'), 'utf8');
  const loop = fb.slice(fb.indexOf('LINK_TREE=""'), fb.indexOf('done\ndone') + 'done\ndone'.length);
  const fbRun = (env) => spawnSync('bash', ['-c', `H="$HOME"\n${loop}\nprintf '%s' "$LINK_TREE"`], { encoding: 'utf8', env: Object.assign({ PATH: process.env.PATH }, env) }).stdout;
  assert.strictEqual(fbRun({ HOME: both }), bashPath(placeOf(both)));
  assert.strictEqual(fbRun({ HOME: onlyLegacy }), bashPath(legacyOf(onlyLegacy)));
  assert.strictEqual(fbRun({ HOME: none, USERPROFILE: onlyLegacy }), bashPath(legacyOf(onlyLegacy)), 'el respaldo: bajo USERPROFILE');
  assert.strictEqual(fbRun({ HOME: none }), '');
});

// ── uninstall no deja inalcanzable un lugar que la persona re-apuntó ─────────────────────────
// El nombre viejo apunta al lugar. Si el lugar apunta a OTRO clon (un --link de la persona) se conserva, y el viejo
// también: borrarlo dejaba ese clon fuera del alcance de todo lo que todavía lee por el viejo. Con el lugar al árbol (o
// ya quitado), el viejo se quita.
test('T27 Uninstall_LegacyKeptWhenPlaceKept_RemovedWhenPlaceGoes', () => {
  const R = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'remove.js'));
  const T = clone('arbol'); const U = clone('otro');
  const pieces = (h) => [{ kind: 'link', where: legacyOf(h), id: PLACE.LEGACY_PLACE_NAME }, { kind: 'link', where: placeOf(h), id: PLACE.PLACE_NAME }];
  const kept = home('lugar-a-otro'); link(U, placeOf(kept)); link(placeOf(kept), legacyOf(kept));
  R.removePieces(pieces(kept), { home: kept, tree: T });
  assert.strictEqual(real(placeOf(kept)), U, 'el lugar a otro clon se conserva');
  assert.ok(isLink(legacyOf(kept)) && real(legacyOf(kept)) === U, 'el viejo se borró aunque el lugar se conservó');
  const gone = home('lugar-al-arbol'); link(T, placeOf(gone)); link(placeOf(gone), legacyOf(gone));
  R.removePieces(pieces(gone), { home: gone, tree: T });
  assert.ok(!exists(placeOf(gone)) && !exists(legacyOf(gone)), 'con el lugar al árbol, los dos nombres se quitan');
  // el orden de las piezas no importa: el viejo primero, con el lugar todavía al árbol
  const first = home('viejo-primero'); link(T, placeOf(first)); link(placeOf(first), legacyOf(first));
  R.removePieces(pieces(first).reverse().reverse(), { home: first, tree: T });
  assert.ok(!exists(legacyOf(first)) && !exists(placeOf(first)));
  assert.ok(fs.existsSync(path.join(T, 'testigo.txt')) && fs.existsSync(path.join(U, 'testigo.txt')), 'un clon perdió su testigo');
});

test('T27 Uninstall_ImportLineEitherName_RealFolderInPlaceUntouched (tanda B, AC 20)', () => {
  // la línea de CLAUDE.md se quita con cualquiera de los dos nombres: la pieza pudo quedar registrada con uno y la línea
  // escrita con el otro (relocate cambia los dos, una vuelta atrás vuelve uno solo)
  const R = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'remove.js'));
  const T = clone('arbol-import');
  const line = (n) => `@~/.claude/${n}/README.md`;
  for (const [reg, written] of [[PLACE.PLACE_NAME, PLACE.LEGACY_PLACE_NAME], [PLACE.LEGACY_PLACE_NAME, PLACE.PLACE_NAME], [PLACE.PLACE_NAME, null]]) {
    const h = home(`import-${reg}-${written}`);
    const md = path.join(h, '.claude', 'CLAUDE.md');
    const lines = ['# mío', 'una línea de la persona'];
    if (written) lines.push(line(written)); else lines.push(line(PLACE.PLACE_NAME), line(PLACE.LEGACY_PLACE_NAME));
    fs.writeFileSync(md, `${lines.join('\n')}\n`);
    const piece = { kind: 'import', where: md, id: line(reg) };
    const plan = R.removePieces([piece], { home: h, tree: T, dryRun: true });
    assert.strictEqual(fs.readFileSync(md, 'utf8'), `${lines.join('\n')}\n`, '--dry-run escribió');
    assert.strictEqual((plan.removed || []).length, 1, `--dry-run no la lista (registrada ${reg}, escrita ${written}): ${JSON.stringify(plan)}`);
    R.removePieces([piece], { home: h, tree: T });
    const left = fs.readFileSync(md, 'utf8');
    assert.ok(!left.includes(line(PLACE.PLACE_NAME)) && !left.includes(line(PLACE.LEGACY_PLACE_NAME)), `quedó una línea (registrada ${reg}, escrita ${written}): ${left}`);
    assert.ok(left.includes('una línea de la persona'), 'se llevó lo de la persona');
  }
  // una carpeta real en el lugar (el clon de la persona) nunca se toca, aunque esté registrada como pieza
  const h = home('carpeta-real'); fs.mkdirSync(placeOf(h)); fs.writeFileSync(path.join(placeOf(h), 'testigo.txt'), 'mío\n');
  R.removePieces([{ kind: 'link', where: placeOf(h), id: PLACE.PLACE_NAME }], { home: h, tree: T });
  assert.ok(fs.existsSync(path.join(placeOf(h), 'testigo.txt')), 'tocó la carpeta real del lugar');
});
