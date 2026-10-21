'use strict';
/**
 * harness-plan.test.js — el plan que `install` muestra antes de escribir (`scripts/setup/harness/plan.js`;
 * T16 y la parte de módulo de T20 y T23).
 *
 * Lo que no se puede perder:
 *   · `describe()` imprime, en este orden, «escribe:», «cambia en cómo trabaja tu asistente:», «corre solo:», «red:»,
 *     «guarda en disco:», «no toca:», «copia de respaldo:» y, sólo si algo se va, «quita:»;
 *   · «escribe:» agrupa por archivo y cuenta los hooks que pueden frenar un comando; los frenos, los bloques y el import
 *     salen además con su oración `does`; lo que ya estaba (`keep`) no se describe como cambio;
 *   · ninguna línea nombra un archivo de implementación (un guion, un hook): se dice lo que pasa;
 *   · un aplicador que no sabe mostrar su plan lo dice, y entonces «nada que escribir» nunca es verdad;
 *   · la diferencia de comportamiento entre dos listas de efectos (lo que `update` muestra antes de preguntar): entra,
 *     sale, o cambia si frena.
 *
 * 🔴 Sin `scripts/setup/harness/plan.js` todo falla en el `require`.
 * 🔴 No toca la HOME: el plan es datos.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..');
const PLAN = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'plan.js'));
const REAL_EFFECTS = require(path.join(RAIZ, 'scripts', 'setup', 'install-effects.json')).effects;

const HOME = '/home/lab';
const SETTINGS = `${HOME}/.claude/settings.json`;
const CLAUDE_MD = `${HOME}/.claude/CLAUDE.md`;
const BACKUPS = `${HOME}/.claude/.tycon-pipeline/harness/backups`;

const EFFECTS = [
  { id: 'PreToolUse:@tcg:guard-a.sh', kind: 'hook', does: 'Frena comandos que borran la raíz.', blocks: 'any-repo', when: 'always', switch: 'TYCON_A=0', network: null, stores: '~/.claude/guard-a.log', windows: true, front_page: true },
  { id: 'Stop:@tcg:meter-b.js', kind: 'hook', does: 'Mide cuánto tardó la herramienta más lenta del turno.', blocks: 'no', when: 'always', switch: null, network: null, stores: '~/.claude/meter-b/', windows: true, front_page: false },
  { id: 'SessionStart:@tcg:notice-c.js', kind: 'hook', does: 'Avisa al arrancar si hay algo pendiente.', blocks: 'no', when: 'always', switch: null, network: 'consulta el tablero del equipo', stores: null, windows: true, front_page: false },
  { id: 'TYCON_BLOCK:style', kind: 'block', does: 'El asistente contesta con la conclusión primero.', blocks: 'no', when: 'always', switch: null, network: null, stores: null, windows: true, front_page: true },
  { id_pattern: '.+', kind: 'import', does: 'Cada sesión carga el índice de guías.', blocks: 'no', when: 'harness.js', switch: null, network: null, stores: null, windows: true, front_page: true },
  { id: 'cleanupPeriodDays', kind: 'setting', does: 'Conserva las conversaciones 365 días.', blocks: 'no', when: 'shared', switch: null, network: null, stores: null, windows: true, front_page: true },
  { id_pattern: '.+', kind: 'startup-line', does: 'Registra la línea que corre al abrir cada sesión.', blocks: 'no', when: 'harness.js', switch: null, network: 'mira si hay versión nueva', stores: null, windows: true, front_page: true },
  { id: 'task:version-check', kind: 'task', does: 'Mira si hay versión nueva una vez cada 6 horas.', blocks: 'no', when: 'always', switch: 'TYCON_UPDATE=0', network: 'consulta el remoto del arnés', stores: '~/.claude/.tycon-pipeline/harness/startup.log', windows: true, front_page: true, source: { file: 'x', pattern: 'y' } },
  { id: 'task:codex-only', kind: 'task', does: 'Despliega algo en Codex.', blocks: 'no', when: 'integration:codex', switch: null, network: null, stores: null, windows: true, front_page: false, source: { file: 'x', pattern: 'y' } },
];

const piece = (kind, where, id, action) => ({ kind, where, id, action });
const freshApplier = () => ({
  known: true,
  pieces: [
    piece('hook', SETTINGS, 'PreToolUse:@tcg:guard-a.sh', 'add'),
    piece('hook', SETTINGS, 'Stop:@tcg:meter-b.js', 'add'),
    piece('hook', SETTINGS, 'SessionStart:@tcg:notice-c.js', 'add'),
    piece('setting', SETTINGS, 'cleanupPeriodDays', 'add'),
    piece('block', CLAUDE_MD, 'TYCON_BLOCK:style', 'add'),
  ],
});
const freshOwn = () => [
  piece('startup-line', SETTINGS, 'SessionStart:bootstrap.js', 'add'),
  piece('import', CLAUDE_MD, '@~/.claude/tycon-harness/INDEX.md', 'add'),
];
const build = (over = {}) => PLAN.build(Object.assign({
  applier: freshApplier(), own: freshOwn(), effects: EFFECTS, home: HOME, env: {}, platform: 'darwin',
  integrations: { codex: false }, first: true, backupRoot: BACKUPS,
}, over));

const SECTIONS = ['escribe:', 'cambia en cómo trabaja tu asistente:', 'corre solo:', 'red:', 'guarda en disco:', 'no toca:', 'copia de respaldo:'];
const headers = (lines) => lines.filter((l) => /^\S.*:$/.test(l));
const sectionLines = (lines, title) => {
  const i = lines.indexOf(title);
  if (i < 0) return null;
  const out = [];
  for (let j = i + 1; j < lines.length && /^\s/.test(lines[j]); j++) out.push(lines[j]);
  return out;
};

test('T16 · Plan_Sections_WritesBehaviorRunsNetworkStoresKeepsBackup', async (t) => {
  await t.test('las siete secciones en orden, sin «quita:» cuando nada se va', () => {
    const lines = PLAN.describe(build());
    assert.deepStrictEqual(headers(lines), SECTIONS);
  });
  await t.test('«escribe:» agrupa por archivo y cuenta los frenos', () => {
    const w = sectionLines(PLAN.describe(build()), 'escribe:').join('\n');
    assert.match(w, /~\/\.claude\/settings\.json: 3 hooks \(1 puede frenar un comando\), la línea de arranque, 1 ajuste/);
    assert.match(w, /~\/\.claude\/CLAUDE\.md: 1 bloque de reglas, la línea que carga las guías/);
  });
  await t.test('«cambia en cómo trabaja tu asistente:» trae el bloque, el import y el freno con su oración', () => {
    const c = sectionLines(PLAN.describe(build()), 'cambia en cómo trabaja tu asistente:').join('\n');
    for (const e of [EFFECTS[0], EFFECTS[3], EFFECTS[4]]) assert.ok(c.includes(e.does), `falta «${e.does}»`);
    assert.ok(!c.includes(EFFECTS[1].does), 'un hook que no frena no va en esta sección (se cuenta en «escribe:»)');
  });
  await t.test('«corre solo:», «red:» y «guarda en disco:» en una primera instalación: tareas que aplican, sin las apagadas', () => {
    const lines = PLAN.describe(build());
    const runs = sectionLines(lines, 'corre solo:').join('\n');
    assert.ok(runs.includes(EFFECTS[7].does));
    assert.ok(runs.includes(EFFECTS[6].does), 'la línea de arranque corre sola en cada sesión');
    assert.ok(!runs.includes(EFFECTS[8].does), 'una tarea de una integración apagada no corre');
    const net = sectionLines(lines, 'red:').join('\n');
    for (const n of ['consulta el tablero del equipo', 'mira si hay versión nueva', 'consulta el remoto del arnés']) assert.ok(net.includes(n), `red: falta «${n}»`);
    const disk = sectionLines(lines, 'guarda en disco:').join('\n');
    for (const s of ['~/.claude/guard-a.log', '~/.claude/meter-b/']) assert.ok(disk.includes(s), `guarda en disco: falta «${s}»`);
  });
  await t.test('con la integración prendida, su tarea aparece', () => {
    const runs = sectionLines(PLAN.describe(build({ integrations: { codex: true } })), 'corre solo:').join('\n');
    assert.ok(runs.includes(EFFECTS[8].does));
  });
  await t.test('Codex en «detect» (el perfil del equipo): cuenta si el plan del aplicador trae piezas de Codex', () => {
    const off = sectionLines(PLAN.describe(build({ integrations: { codex: 'detect' } })), 'corre solo:').join('\n');
    assert.ok(!off.includes(EFFECTS[8].does), 'sin piezas de Codex en el plan, detect es apagado');
    const applier = freshApplier();
    applier.pieces.push(piece('codex', `${HOME}/.codex/hooks.json`, 'hooks.json', 'add'));
    const on = sectionLines(PLAN.describe(build({ applier, integrations: { codex: 'detect' } })), 'corre solo:').join('\n');
    assert.ok(on.includes(EFFECTS[8].does), 'con piezas de Codex en el plan, detect es prendido');
  });
  await t.test('una línea de arranque con git pull que el aplicador reescribe se dice en «escribe:»', () => {
    const applier = freshApplier();
    applier.pieces.push(piece('pull-line', SETTINGS, 'cd x && git pull -q', 'update'));
    const w = sectionLines(PLAN.describe(build({ applier })), 'escribe:').join('\n');
    assert.match(w, /una línea de arranque con `git pull`, para que no pise cambios locales/);
  });
  await t.test('«no toca:» y «copia de respaldo:» dicen qué no se toca y dónde queda la copia', () => {
    const lines = PLAN.describe(build());
    const keep = sectionLines(lines, 'no toca:').join('\n');
    assert.match(keep, /hooks/); assert.match(keep, /CLAUDE\.md/); assert.match(keep, /skills/); assert.match(keep, /agents/);
    const backup = sectionLines(lines, 'copia de respaldo:').join('\n');
    assert.ok(backup.includes('~/.claude/.tycon-pipeline/harness/backups'), backup);
    assert.match(backup, /antes de escribir/);
  });
  await t.test('lo que ya estaba (keep) no es un cambio; una reparación no lista las tareas de siempre', () => {
    const applier = freshApplier();
    for (const p of applier.pieces) p.action = 'keep';
    applier.pieces[1].action = 'add';
    const lines = PLAN.describe(build({ applier, own: freshOwn().map((p) => Object.assign(p, { action: 'keep' })), first: false }));
    const w = sectionLines(lines, 'escribe:').join('\n');
    assert.match(w, /settings\.json: 1 hook\b/);
    assert.ok(!/CLAUDE\.md/.test(w), 'CLAUDE.md no cambia: no va en «escribe:»');
    const c = sectionLines(lines, 'cambia en cómo trabaja tu asistente:') || [];
    assert.ok(!c.join('\n').includes(EFFECTS[3].does), 'el bloque ya estaba');
    const runs = (sectionLines(lines, 'corre solo:') || []).join('\n');
    assert.ok(!runs.includes(EFFECTS[7].does), 'la tarea ya corría: no se anuncia como nueva');
  });
  await t.test('«quita:» aparece sólo cuando algo se va, y en último lugar', () => {
    const applier = freshApplier();
    applier.pieces.push(piece('hook', SETTINGS, 'PreToolUse:@tcg:viejo.sh', 'remove'));
    const lines = PLAN.describe(build({ applier }));
    assert.deepStrictEqual(headers(lines), [...SECTIONS, 'quita:']);
    assert.match(sectionLines(lines, 'quita:').join('\n'), /settings\.json: 1 hook/);
  });
  await t.test('ninguna línea nombra un archivo de implementación, tampoco con la lista REAL de efectos', () => {
    const impl = /\.(js|sh|py|ps1)\b|@tcg:/;
    const own = freshOwn();
    const realPieces = REAL_EFFECTS.filter((e) => e.id && e.kind !== 'task').map((e) => piece(e.kind, e.kind === 'block' ? CLAUDE_MD : SETTINGS, e.id, 'add'));
    for (const plan of [build(), build({ applier: { known: true, pieces: realPieces }, effects: REAL_EFFECTS, own, integrations: { codex: true, engram: true } })]) {
      const bad = PLAN.describe(plan).filter((l) => impl.test(l));
      assert.deepStrictEqual(bad, []);
    }
  });
  await t.test('nothingToWrite: todo keep → sí; un add → no', () => {
    const applier = freshApplier();
    for (const p of applier.pieces) p.action = 'keep';
    const own = freshOwn().map((p) => Object.assign(p, { action: 'keep' }));
    assert.strictEqual(PLAN.nothingToWrite(build({ applier, own, first: false })), true);
    own[0].action = 'update';
    assert.strictEqual(PLAN.nothingToWrite(build({ applier, own, first: false })), false);
  });
});

test('T20 (módulo) · un aplicador que no sabe mostrar su plan nunca se lee como «nada que escribir»', () => {
  const own = freshOwn().map((p) => Object.assign(p, { action: 'keep' }));
  const plan = build({ applier: { known: false, pieces: [] }, own, first: false });
  assert.strictEqual(PLAN.nothingToWrite(plan), false);
  const lines = PLAN.describe(plan).join('\n');
  assert.ok(lines.includes('este aplicador no sabe mostrar su plan: lo que escribe no está en esta lista'), lines);
});

test('T23 (módulo) · effectsDiff: lo que entra, lo que sale y lo que cambia si frena', () => {
  const before = EFFECTS.slice(0, 4);
  const after = [
    Object.assign({}, EFFECTS[0]),
    Object.assign({}, EFFECTS[1], { blocks: 'harness-repos', does: 'Frena el commit sin medir.' }),
    EFFECTS[3],
    { id: 'PreToolUse:@tcg:nuevo-freno.sh', kind: 'hook', does: 'Frena un push sin revisión.', blocks: 'any-repo', when: 'always', switch: null, network: null, stores: null, windows: true, front_page: false },
  ];
  const d = PLAN.effectsDiff(before, after);
  assert.deepStrictEqual(d.added.map((e) => e.id), ['PreToolUse:@tcg:nuevo-freno.sh']);
  assert.deepStrictEqual(d.removed.map((e) => e.id), ['SessionStart:@tcg:notice-c.js']);
  assert.deepStrictEqual(d.blocksChanged.map((x) => [x.effect.id, x.from, x.to]), [['Stop:@tcg:meter-b.js', 'no', 'harness-repos']]);
  const lines = PLAN.describeEffectsDiff(d).join('\n');
  assert.match(lines, /qué cambia en el comportamiento:/);
  assert.ok(lines.includes('Frena un push sin revisión.') && lines.includes(EFFECTS[2].does) && lines.includes('Frena el commit sin medir.'));
  assert.ok(!/\.(js|sh)\b|@tcg:/.test(lines), 'sin nombres de implementación');
  assert.deepStrictEqual(PLAN.describeEffectsDiff(PLAN.effectsDiff(before, before)), ['qué cambia en el comportamiento: nada (la lista de efectos es la misma)']);
});
