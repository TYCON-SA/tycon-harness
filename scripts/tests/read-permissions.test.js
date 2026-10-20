'use strict';
// read-permissions.test.js — las reglas de lectura del arnés en ~/.claude/settings.json.
//
// Claude Code frena la primera historia con «Read outside the working directories… Allow this read?» la primera vez
// que el recorrido lee las guías o las skills del arnés. El instalador deja permitida de antemano la lectura de las
// carpetas del arnés, y nada más: el árbol, sus dos enlaces y cada skill enlazada al árbol. Una regla vale para la ruta
// pedida y para la real, así que cada enlace lleva la suya (medido en un laboratorio con Claude Code 2.1.304).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const RP = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'read-permissions.js'));
const SH = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'shared.js'));
const RM = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'remove.js'));
const M = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'managed.js'));

/** Una máquina de prueba: el árbol en ~/.tycon/harness, sus dos enlaces, dos skills del arnés y una propia del dev. */
function maquina() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-')));
  const tree = path.join(home, '.tycon', 'harness');
  for (const s of ['tycon-pipeline', 'tycon-create-story']) fs.mkdirSync(path.join(tree, 'skills', s), { recursive: true });
  fs.mkdirSync(path.join(tree, 'commands'), { recursive: true });
  const claude = path.join(home, '.claude');
  fs.mkdirSync(path.join(claude, 'skills', 'propia-del-dev'), { recursive: true });
  fs.symlinkSync(tree, path.join(claude, 'tycon-harness'), 'dir');
  fs.symlinkSync(tree, path.join(claude, 'agent-skills'), 'dir');
  for (const s of ['tycon-pipeline', 'tycon-create-story']) fs.symlinkSync(path.join(tree, 'skills', s), path.join(claude, 'skills', s), 'dir');
  const settings = path.join(claude, 'settings.json');
  return { home, tree, claude, settings, env: { TYCON_SETTINGS_PATH: settings, TYCON_NO_COMMANDS_SYNC: '1' } };
}
const leer = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const NUESTRAS = ['Read(~/.tycon/harness/**)', 'Read(~/.claude/tycon-harness/**)', 'Read(~/.claude/agent-skills/**)', 'Read(~/.claude/skills/tycon-create-story/**)', 'Read(~/.claude/skills/tycon-pipeline/**)'];
const aplicar = (m, extra = {}) => SH.applyShared({ home: m.home, env: m.env, tree: m.tree, backup: false, settings: false, ...extra });

test('T1 ReadRules_CarpetasDelArnesYNadaMas @story-8.66 @ac-1 — el árbol, sus dos enlaces y las skills enlazadas al árbol', () => {
  const m = maquina();
  try {
    assert.deepStrictEqual(RP.ourRules({ home: m.home, tree: m.tree }), NUESTRAS);
    // una skill enlazada a otro lado (no al árbol) no es del arnés, aunque se llame tycon-algo
    const otra = path.join(m.home, 'otra'); fs.mkdirSync(otra);
    fs.symlinkSync(otra, path.join(m.claude, 'skills', 'tycon-ajena'), 'dir');
    assert.ok(!RP.ourRules({ home: m.home, tree: m.tree }).some((r) => /tycon-ajena|propia-del-dev/.test(r)), 'ni la propia del dev ni una enlazada afuera');
    // con el árbol nombrado por un enlace, la regla del árbol va por su ruta real
    assert.strictEqual(RP.ourRules({ home: m.home, tree: path.join(m.claude, 'tycon-harness') })[0], 'Read(~/.tycon/harness/**)');
  } finally { fs.rmSync(m.home, { recursive: true, force: true }); }
});

test('T2 ReadRules_FormaDeLaRuta @story-8.66 @ac-1 — bajo la carpeta personal con ~, fuera con //, en Windows con la unidad', () => {
  assert.strictEqual(RP.ruleFor('/casa/ana/.tycon/harness', { home: '/casa/ana', platform: 'darwin' }), 'Read(~/.tycon/harness/**)');
  assert.strictEqual(RP.ruleFor('/opt/arnes', { home: '/casa/ana', platform: 'darwin' }), 'Read(//opt/arnes/**)');
  assert.strictEqual(RP.ruleFor('C:\\Casa\\ana\\.tycon\\harness', { home: 'C:\\Casa\\ana', platform: 'win32' }), 'Read(~/.tycon/harness/**)');
  assert.strictEqual(RP.ruleFor('D:\\arnes', { home: 'C:\\Casa\\ana', platform: 'win32' }), 'Read(//d/arnes/**)');
  // la carpeta personal misma, o una que sólo empieza igual, no son «bajo la carpeta personal»
  assert.strictEqual(RP.ruleFor('/casa/anabel/x', { home: '/casa/ana', platform: 'darwin' }), 'Read(//casa/anabel/x/**)');
  // un carácter que la regla leería como comodín o como su cierre: sin regla (podría quedar más ancha o rota)
  for (const d of ['/opt/ar*nes', '/opt/a?b', '/opt/[x]', '/opt/{a,b}', '/casa/ana/(x)']) {
    assert.strictEqual(RP.ruleFor(d, { home: '/casa/ana', platform: 'darwin' }), null, d);
  }
  // sólo cuenta lo que va escrito en la regla — una carpeta personal con paréntesis no
  // impide la forma ~/… ni una carpeta de afuera; una barra invertida en Mac/Linux es parte del nombre (sin regla); una
  // ruta de red de Windows no tiene forma documentada (sin regla)
  assert.strictEqual(RP.ruleFor('C:\\Casa\\Juan (work)\\.tycon\\harness', { home: 'C:\\Casa\\Juan (work)', platform: 'win32' }), 'Read(~/.tycon/harness/**)');
  assert.strictEqual(RP.ruleFor('/opt/arnes', { home: '/casa/a (w)', platform: 'darwin' }), 'Read(//opt/arnes/**)');
  assert.strictEqual(RP.ruleFor('/casa/ana/a\\b', { home: '/casa/ana', platform: 'darwin' }), null);
  assert.strictEqual(RP.ruleFor('\\\\servidor\\recurso\\arnes', { home: 'C:\\Casa\\ana', platform: 'win32' }), null);
  const skipped = [];
  const raro = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-raro-[x]-')));
  try {
    assert.deepStrictEqual(RP.ourRules({ home: '/casa/ana', tree: raro, skipped }), []);
    assert.deepStrictEqual(skipped, [raro], 'y lo dice');
  } finally { fs.rmSync(raro, { recursive: true, force: true }); }
});

test('T2c ReadRules_ElPlanAnticipaElEnlaceDelLugar @story-8.66 @ac-1 — antes de instalar, el plan ya cuenta la regla del enlace que install va a crear', () => {
  const m = maquina();
  try {
    fs.unlinkSync(path.join(m.claude, 'tycon-harness'));
    assert.ok(!RP.ourRules({ home: m.home, tree: m.tree }).includes('Read(~/.claude/tycon-harness/**)'), 'hoy no está (el enlace todavía no existe)');
    const plan = RP.plannedRules({ home: m.home, tree: m.tree });
    assert.strictEqual(plan[0], 'Read(~/.tycon/harness/**)');
    assert.ok(plan.includes('Read(~/.claude/tycon-harness/**)'), 'el plan la anticipa');
    assert.strictEqual(new Set(plan).size, plan.length, 'sin repetir');
  } finally { fs.rmSync(m.home, { recursive: true, force: true }); }
});

test('T2b ReadRules_ArbolPorSusDosRutas @story-8.66 @ac-1 — nombrado por un enlace en el medio, la regla de la ruta pedida y la de la real', () => {
  const m = maquina();
  try {
    const otro = path.join(m.home, 'otro-disco'); fs.mkdirSync(otro);
    fs.renameSync(m.tree, path.join(otro, 'harness'));
    fs.symlinkSync(path.join(otro, 'harness'), m.tree, 'dir');
    const r = RP.ourRules({ home: m.home, tree: m.tree });
    assert.deepStrictEqual(r.slice(0, 2), ['Read(~/otro-disco/harness/**)', 'Read(~/.tycon/harness/**)']);
  } finally { fs.rmSync(m.home, { recursive: true, force: true }); }
});

test('T8 ReadRules_DespuesDelAplicador @story-8.66 @ac-1 @ac-3 — el pase propio suma las reglas con los enlaces ya hechos, y el resumen las nombra', () => {
  const m = maquina();
  try {
    // antes del aplicador (reads: false) no se suma ninguna, aunque el perfil sea el completo
    const antes = SH.applyShared({ home: m.home, env: m.env, tree: m.tree, backup: false, settings: true, reads: false });
    assert.ok(antes.ok);
    assert.ok(!leer(m.settings).permissions, 'sin reglas antes del aplicador');
    // después: todas, con su pieza
    const r = SH.applyReadRules({ home: m.home, env: m.env, tree: m.tree, backup: false });
    assert.ok(r.ok, r.reason);
    assert.deepStrictEqual(leer(m.settings).permissions.allow, NUESTRAS);
    assert.deepStrictEqual(r.pieces.map((p) => p.value), NUESTRAS);
    assert.strictEqual(leer(m.settings).cleanupPeriodDays, 365, 'lo de antes queda');
    // el resumen de install las nombra en llano, aparte de los ajustes
    const L = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'report.js')).leftCounts([...antes.pieces, ...r.pieces]);
    const linea = L.find((l) => /lee sin preguntar/.test(l));
    assert.ok(linea && linea.includes('5 carpetas') && linea.includes('~/.claude/skills/tycon-pipeline') && /editarlas/.test(linea), L.join('\n'));
    assert.ok(L.includes('ajustes de settings.json: 3'), `los ajustes cuentan sin las reglas: ${L.join(' | ')}`);
    // con el interruptor, nada
    const off = SH.applyReadRules({ home: m.home, env: { ...m.env, TYCON_NO_READ_PERMISSIONS: '1' }, tree: m.tree, backup: false });
    assert.deepStrictEqual(off.pieces, []);
  } finally { fs.rmSync(m.home, { recursive: true, force: true }); }
});

test('T3 ReadRules_SumaSinPisarYSinDuplicar @story-8.66 @ac-2 — lo del dev queda igual y en su orden; una regla igual es del dev', () => {
  const m = maquina();
  try {
    const delDev = { model: 'sonnet', permissions: { allow: ['Bash(npm test)', 'Read(~/.claude/tycon-harness/**)'], deny: ['Read(./.env)'], ask: ['Bash(git push:*)'], defaultMode: 'acceptEdits' } };
    fs.writeFileSync(m.settings, JSON.stringify(delDev, null, 2));
    const r = aplicar(m);
    assert.ok(r.ok, r.reason);
    const s = leer(m.settings);
    assert.strictEqual(s.model, 'sonnet');
    assert.deepStrictEqual(s.permissions.deny, ['Read(./.env)']);
    assert.deepStrictEqual(s.permissions.ask, ['Bash(git push:*)']);
    assert.strictEqual(s.permissions.defaultMode, 'acceptEdits');
    // lo del dev primero y en su orden; lo que faltaba, al final; la igual una sola vez
    assert.deepStrictEqual(s.permissions.allow, ['Bash(npm test)', 'Read(~/.claude/tycon-harness/**)', ...NUESTRAS.filter((x) => x !== 'Read(~/.claude/tycon-harness/**)')]);
    const anotadas = r.pieces.filter((p) => RP.isRuleId(p.id)).map((p) => RP.ruleOf(p.id));
    assert.ok(!anotadas.includes('Read(~/.claude/tycon-harness/**)'), 'la que ya tenía el dev no se anota: al desinstalar queda');
    assert.strictEqual(anotadas.length, 4);
    // una lista que no es lista, o permisos que no son objeto: no se toca nada y se dice
    fs.writeFileSync(m.settings, JSON.stringify({ permissions: { allow: 'Read(x)' } }));
    const roto = aplicar(m);
    assert.deepStrictEqual(leer(m.settings), { permissions: { allow: 'Read(x)' } });
    assert.ok(roto.notes.some((n) => /permissions\.allow/.test(n) && /no lo toco/.test(n)), JSON.stringify(roto.notes));
  } finally { fs.rmSync(m.home, { recursive: true, force: true }); }
});

test('T4 ReadRules_DosVecesNoCambiaNada @story-8.66 @ac-2 — la segunda vez no escribe ni deja copia', () => {
  const m = maquina();
  try {
    fs.writeFileSync(m.settings, '{\n  "theme": "dark"\n}\n');
    aplicar(m, { backup: true });
    const antes = fs.readFileSync(m.settings);
    const mtime = fs.statSync(m.settings).mtimeMs;
    const copias = () => fs.readdirSync(m.claude).filter((n) => n.startsWith('settings.json.bak')).length;
    const n = copias();
    const r = aplicar(m, { backup: true, previous: aplicar(m).pieces });
    assert.ok(r.ok);
    assert.deepStrictEqual(fs.readFileSync(m.settings), antes);
    assert.strictEqual(fs.statSync(m.settings).mtimeMs, mtime);
    assert.strictEqual(copias(), n, 'sin copia nueva');
    assert.deepStrictEqual(r.changed.filter((c) => RP.isRuleId(c)), []);
  } finally { fs.rmSync(m.home, { recursive: true, force: true }); }
});

test('T5 ReadRules_SaleEnLasPiezasYEnLaSalida @story-8.66 @ac-1 @ac-3 — una pieza por regla, y la salida dice cuáles en llano', () => {
  const m = maquina();
  try {
    const dichas = [];
    const r = aplicar(m, { log: (l) => dichas.push(l) });
    assert.ok(r.ok, r.reason);
    const piezas = r.pieces.filter((p) => RP.isRuleId(p.id));
    assert.deepStrictEqual(piezas.map((p) => RP.ruleOf(p.id)), NUESTRAS);
    for (const p of piezas) { assert.strictEqual(p.kind, 'setting'); assert.strictEqual(p.where, path.resolve(m.settings)); assert.strictEqual(p.id, `${RP.PREFIX}${p.value}`); }
    const nota = dichas.find((l) => /leer sin preguntar/.test(l));
    assert.ok(nota, dichas.join('\n'));
    for (const x of NUESTRAS) assert.ok(nota.includes(x), x);
    assert.match(nota, /no escribir/, 'dice que es sólo lectura');
    // con el interruptor no se toca nada
    const n = maquina();
    try {
      const off = SH.applyShared({ home: n.home, env: { ...n.env, TYCON_NO_READ_PERMISSIONS: '1' }, tree: n.tree, backup: false, settings: false });
      assert.ok(off.ok);
      assert.ok(!fs.existsSync(n.settings) || !leer(n.settings).permissions, 'TYCON_NO_READ_PERMISSIONS=1: sin reglas');
    } finally { fs.rmSync(n.home, { recursive: true, force: true }); }
    // en la completa también (con las otras claves)
    const c = maquina();
    try {
      SH.applyShared({ home: c.home, env: c.env, tree: c.tree, backup: false, settings: true });
      const s = leer(c.settings);
      assert.deepStrictEqual(s.permissions.allow, NUESTRAS);
      assert.strictEqual(s.cleanupPeriodDays, 365);
    } finally { fs.rmSync(c.home, { recursive: true, force: true }); }
    // y el registro las reconoce en su lugar
    for (const p of piezas) assert.strictEqual(M.present(p, { home: m.home, env: m.env }), true, p.id);
  } finally { fs.rmSync(m.home, { recursive: true, force: true }); }
});

test('T6 ReadRules_ActualizarSumaYSaca @story-8.66 @ac-4 — una skill nueva suma su regla; una que dejó de estar enlazada saca la suya', () => {
  const m = maquina();
  try {
    const primera = aplicar(m);
    // el dev suma una regla suya después de instalar
    const s0 = leer(m.settings); s0.permissions.allow.push('Read(~/notas/**)'); fs.writeFileSync(m.settings, JSON.stringify(s0, null, 2));
    // sale una skill, entra otra
    fs.unlinkSync(path.join(m.claude, 'skills', 'tycon-create-story'));
    fs.mkdirSync(path.join(m.tree, 'skills', 'clocki'));
    fs.symlinkSync(path.join(m.tree, 'skills', 'clocki'), path.join(m.claude, 'skills', 'clocki'), 'dir');
    const dichas = [];
    const r = aplicar(m, { previous: primera.pieces, log: (l) => dichas.push(l) });
    assert.ok(r.ok, r.reason);
    const allow = leer(m.settings).permissions.allow;
    assert.ok(allow.includes('Read(~/.claude/skills/clocki/**)'), 'la nueva entra');
    assert.ok(!allow.includes('Read(~/.claude/skills/tycon-create-story/**)'), 'la vieja sale');
    assert.ok(allow.includes('Read(~/notas/**)'), 'la del dev queda');
    assert.ok(dichas.some((l) => /saqué/.test(l) && l.includes('tycon-create-story')), dichas.join('\n'));
    assert.ok(!r.pieces.some((p) => p.id === `${RP.PREFIX}Read(~/.claude/skills/tycon-create-story/**)`), 'y no se anota');
  } finally { fs.rmSync(m.home, { recursive: true, force: true }); }
});

test('T6b ReadRules_ActualizarLeeElRegistroReal @story-8.66 @ac-4 — lo anotado antes sale del registro de la máquina, no de una lista armada a mano', () => {
  // medido en el laboratorio: con el registro leído con la forma equivocada, «lo anotado antes» salía vacío y una skill
  // que dejaba de estar enlazada conservaba su regla. Acá el registro se escribe donde lo deja el instalador
  const m = maquina();
  try {
    const ST = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'state.js'));
    const pieza = { kind: 'setting', where: m.settings, id: `${RP.PREFIX}Read(~/.claude/skills/vieja/**)`, value: 'Read(~/.claude/skills/vieja/**)' };
    const { file } = ST.paths(m.home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schema: 1, tree: m.tree, sources: [], managed: [pieza] }));
    const H = require(path.join(ROOT, 'scripts', 'setup', 'harness.js'));
    assert.deepStrictEqual(H.managedBefore({ home: m.home, env: m.env }, null), [pieza]);
    // y un registro ilegible se dice (no se calla como «no había nada»)
    fs.writeFileSync(file, '{ roto');
    const dichas = [];
    assert.deepStrictEqual(H.managedBefore({ home: m.home, env: m.env }, (l) => dichas.push(l)), []);
    assert.ok(dichas.some((l) => /no pude leer el registro/.test(l)), dichas.join('\n'));
  } finally { fs.rmSync(m.home, { recursive: true, force: true }); }
});

test('T7 ReadRules_DesinstalarSacaSoloLasPropias @story-8.66 @ac-5 — saca las anotadas; sin nada más, sin permissions', () => {
  const m = maquina();
  try {
    // con reglas del dev: quedan ellas y lo demás de permissions
    fs.writeFileSync(m.settings, JSON.stringify({ permissions: { allow: ['Bash(npm test)'], deny: ['Read(./.env)'] } }, null, 2));
    const r = aplicar(m);
    const res = RM.removePieces(r.pieces.filter((p) => RP.isRuleId(p.id)), { home: m.home, env: m.env });
    assert.deepStrictEqual(leer(m.settings).permissions, { allow: ['Bash(npm test)'], deny: ['Read(./.env)'] });
    assert.strictEqual(res.removed.length, 5);
    // sólo las del arnés: sin allow, y sin permissions
    fs.writeFileSync(m.settings, JSON.stringify({ theme: 'dark' }, null, 2));
    const r2 = aplicar(m);
    RM.removePieces(r2.pieces.filter((p) => RP.isRuleId(p.id)), { home: m.home, env: m.env });
    assert.deepStrictEqual(leer(m.settings), { theme: 'dark' });
    // una que ya no está: ausente, no error
    const otra = RM.removePieces(r2.pieces.filter((p) => RP.isRuleId(p.id)).slice(0, 1), { home: m.home, env: m.env });
    assert.strictEqual(otra.absent.length, 1);
  } finally { fs.rmSync(m.home, { recursive: true, force: true }); }
});

const RPT = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'report.js'));
const pieza = (regla) => ({ kind: 'setting', where: '/x/settings.json', id: RP.pieceId(regla), value: regla });

test('ReadFoldersLine_CeroUnaYVarias @story-8.66.1 @ac-2 — la línea de las carpetas, una sola forma', () => {
  assert.strictEqual(typeof RPT.readFoldersLine, 'function', 'falta readFoldersLine en report.js');
  assert.strictEqual(RPT.readFoldersLine([{ kind: 'hook', id: 'x' }, { kind: 'setting', id: 'cleanupPeriodDays' }]), null);
  const una = RPT.readFoldersLine([pieza('Read(~/.tycon/harness/**)')]);
  assert.match(una, /lee sin preguntar 1 carpeta del arnés/);
  assert.match(una, /~\/\.tycon\/harness$/);
  const tres = RPT.readFoldersLine([{ kind: 'hook', id: 'x' }, ...NUESTRAS.slice(0, 3).map(pieza)]);
  assert.match(tres, /3 carpetas/);
  for (const d of ['~/.tycon/harness', '~/.claude/tycon-harness', '~/.claude/agent-skills']) assert.ok(tres.includes(d), tres);
  // el resumen de la instalación desde un clon dice exactamente la misma línea
  assert.ok(RPT.leftCounts(NUESTRAS.slice(0, 3).map(pieza)).includes(tres));
});

test('UpdateNotes_SoloSiSumaOSaca @story-8.66.1 @ac-3 — la nota de lo que cambió sale sólo cuando cambió algo', () => {
  const m = maquina();
  try {
    const primera = SH.applyReadRules({ home: m.home, env: m.env, tree: m.tree, backup: false });
    assert.ok(primera.notes.some((n) => /permití leer sin preguntar/.test(n) && n.includes('~/.tycon/harness')), primera.notes.join(' | '));
    const segunda = SH.applyReadRules({ home: m.home, env: m.env, tree: m.tree, backup: false, previous: primera.pieces });
    assert.ok(!segunda.notes.some((n) => /permití leer|saqué de/.test(n)), segunda.notes.join(' | '));
  } finally { fs.rmSync(m.home, { recursive: true, force: true }); }
});

test('RuleFor_CarpetaPersonalEnlazada @story-8.66.2 @ac-1 — con la carpeta personal enlazada, la forma ~/… igual', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-enl-')));
  try {
    const realHome = path.join(base, 'real', 'ana');
    fs.mkdirSync(path.join(realHome, '.tycon', 'harness'), { recursive: true });
    const home = path.join(base, 'ana');
    fs.symlinkSync(realHome, home, 'dir');
    assert.strictEqual(RP.ruleFor(path.join(realHome, '.tycon', 'harness'), { home, platform: 'darwin' }), 'Read(~/.tycon/harness/**)');
    // una carpeta fuera de las dos sigue con la forma absoluta
    assert.strictEqual(RP.ruleFor(path.join(base, 'otra'), { home, platform: 'darwin' }), `Read(/${path.join(base, 'otra')}/**)`);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('OurRules_ArbolEnVersions_ReglaDeVersionsEntera @story-8.66.2 @ac-2 — la regla de la ruta real no nombra una versión', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-ver-')));
  try {
    const version = path.join(home, '.tycon', 'versions', '2026.1.1');
    fs.mkdirSync(path.join(version, 'skills'), { recursive: true });
    const tree = path.join(home, '.tycon', 'harness');
    fs.symlinkSync(version, tree, 'dir');
    const reglas = RP.ourRules({ home, tree });
    assert.ok(reglas.includes('Read(~/.tycon/versions/**)'), reglas.join(' | '));
    assert.ok(reglas.includes('Read(~/.tycon/harness/**)'), reglas.join(' | '));
    assert.ok(!reglas.some((r) => /versions\/2026/.test(r)), reglas.join(' | '));
    // un árbol en otra carpeta que se llama versions/ no ensancha la regla a sus vecinas
    const ajena = path.join(home, 'trabajo', 'versions', 'arnes');
    fs.mkdirSync(path.join(ajena, 'skills'), { recursive: true });
    const deAfuera = RP.ourRules({ home, tree: ajena });
    assert.ok(deAfuera.includes('Read(~/trabajo/versions/arnes/**)'), deAfuera.join(' | '));
    assert.ok(!deAfuera.includes('Read(~/trabajo/versions/**)'), deAfuera.join(' | '));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
