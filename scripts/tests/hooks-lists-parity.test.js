'use strict';
/**
 * hooks-lists-parity.test.js — lo que Windows registra y lo que deja afuera no se desfasan sin que alguien lo diga
 * (story 8.17, tanda W3a · AC 69, T95; desde la tanda W3 · AC 23, sobre la lista única).
 *
 * EL CASO. Hasta la W3, `install-tycon-hooks.sh` y `install-tycon-hooks.ps1` llevaban cada uno su lista y nada las
 * comparaba: medido el 2026-10-04 en un agente Windows, el `.ps1` registraba 29 de los 42 controles del `.sh` (faltaban
 * 15, entre ellos los dos frenos de comandos). La W3a agregó esta prueba sobre las dos listas; la W3 dejó UNA lista
 * (`scripts/setup/hooks-list.json`) que leen los dos aplicadores, y lo que Windows deja afuera es su campo
 * `platforms.windows: false`. Ya no hay dos listas que se desfasen: quedan tres archivos que dicen cosas sobre los
 * mismos hooks, y esta prueba los cruza.
 *
 * QUÉ FRENA. Tres reglas:
 *   (a) cada registro con `platforms.windows: false` tiene su guion en `scripts/setup/windows-support.json` → `excluded`
 *       (con `kind: hook` y su motivo), y cada hook de `excluded` es un registro de la lista con `windows: false`;
 *   (b) los guiones excluidos no se registran en Windows por ningún otro de sus eventos;
 *   (c) el campo `windows` de `scripts/tests/fixtures/harness-managed-pieces.json` dice lo mismo que la lista, pieza por
 *       pieza, y no hay pieza «hook» que la lista no tenga ni registro de la lista sin pieza.
 * Y una cuarta (2026-10-04): (d) todo registro de PreToolUse/PostToolUse con `Bash` en el matcher lleva también
 * `PowerShell`. En Windows Claude Code corre los comandos con su herramienta PowerShell (`tool_name: "PowerShell"`), y un
 * hook con matcher `Bash` solo no se dispara: medido ese día en una sesión real, `git add -A` en agent-skills y
 * `git commit --no-verify` pasaron sin que el freno los mirara (code.claude.com/docs/en/tools-reference, «PowerShell tool»).
 * Cada rojo nombra el guion. Las copias de los casos de rojo se arman en memoria.
 *
 * Lo que NO mide: que el aplicador registre de verdad lo que la lista dice (eso es apply-hooks.test.js e
 * installer-ps1.test.sh), ni el orden, ni las etiquetas.
 *
 * No usa bash ni pwsh: corre también en un agente Windows. Correr:   node scripts/tests/hooks-lists-parity.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FILES = {
  list: 'scripts/setup/hooks-list.json',
  support: 'scripts/setup/windows-support.json',
  pieces: 'scripts/tests/fixtures/harness-managed-pieces.json',
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const normMatcher = (m) => String(m || '').split('|').map((x) => x.trim()).filter(Boolean).sort().join('|');
/** El nombre con que lo declara `excluded`: la ruta del registro sin el prefijo del repo de guías. */
const scriptOf = (spec) => spec.replace(/^@tcg:/, '');
/** El `id` de su pieza en la lista de piezas: `<EVENTO>:<spec>` (dos matchers del mismo guion son UNA pieza). */
const pieceIdOf = (h) => `${h.event}:${h.spec}`;

/**
 * Lo que rompe el cruce, cada cosa por su nombre. Vacío = la lista, lo excluido y la lista de piezas coinciden.
 * @param {{list: object, support: object, pieces: object}} input  los tres JSON ya leídos
 * @returns {string[]}
 */
function parityProblems({ list, support, pieces }) {
  const problems = [];
  const hooks = Array.isArray(list && list.hooks) ? list.hooks : [];
  // un lector que no encuentra nada compararía vacío contra vacío y daría verde
  if (hooks.length < 30) problems.push(`reader: sólo leí ${hooks.length} registros de la lista`);
  const excludedList = Array.isArray(support && support.excluded) ? support.excluded : null;
  if (!excludedList) problems.push('excluded: windows-support.json no trae la lista «excluded»');
  const excluded = new Map();
  for (const e of excludedList || []) if (e && e.kind === 'hook' && typeof e.id === 'string') excluded.set(e.id, e);
  const hasReason = (e) => typeof e.reason === 'string' && e.reason.trim().length > 0;
  const onWindows = (h) => !(h.platforms && h.platforms.windows === false);

  // (a) lo que la lista deja afuera de Windows está en «excluded», con su motivo
  for (const h of hooks) {
    if (onWindows(h)) continue;
    const e = excluded.get(scriptOf(h.spec));
    if (!e) problems.push(`not-excluded: ${scriptOf(h.spec)} (${h.event}) tiene platforms.windows: false y no está en «excluded» de windows-support.json`);
    else if (!hasReason(e)) problems.push(`excluded-reason: ${scriptOf(h.spec)} (${h.event}) está excluido en Windows y no dice por qué`);
  }
  // …y lo excluido es un registro de la lista con windows: false
  for (const [script] of excluded) {
    const rows = hooks.filter((h) => scriptOf(h.spec) === script);
    if (!rows.length) problems.push(`excluded-unknown: ${script} está en «excluded» y la lista de hooks no lo registra`);
    // (b) ningún evento de un guion excluido se registra en Windows
    for (const h of rows.filter(onWindows)) problems.push(`excluded-registered: ${script} (${h.event}) está en «excluded» y la lista lo registra en Windows`);
  }

  // (c) el campo `windows` de la lista de piezas dice lo mismo
  const hookPieces = ((pieces && pieces.pieces) || []).filter((d) => d && d.kind === 'hook' && d.when !== 'harness.js' && typeof d.id === 'string');
  if (hookPieces.length < 30) problems.push(`reader: sólo leí ${hookPieces.length} piezas «hook» de la lista de piezas`);
  const pieceById = new Map(hookPieces.map((d) => [d.id, d]));
  const known = new Set();
  for (const h of hooks) {
    const id = pieceIdOf(h);
    if (known.has(id)) continue;
    known.add(id);
    const d = pieceById.get(id);
    const registers = hooks.some((x) => pieceIdOf(x) === id && onWindows(x));
    if (!d) { problems.push(`pieces-missing: ${scriptOf(h.spec)} (${h.event}) no está en la lista de piezas`); continue; }
    if (d.windows !== registers) {
      problems.push(`pieces-windows: ${scriptOf(h.spec)} (${h.event}) — la lista de piezas dice windows: ${d.windows} y la lista de hooks ${registers ? 'lo registra en Windows' : 'no lo registra en Windows'}`);
    }
  }
  for (const d of hookPieces) {
    if (!known.has(d.id)) problems.push(`pieces-unknown: ${scriptOf(d.id.slice(d.id.indexOf(':') + 1))} (${d.id.split(':')[0]}) está en la lista de piezas y no en la lista de hooks`);
  }
  return problems;
}

/** (d) Los registros que miran comandos y no cubren la herramienta PowerShell, cada uno por su nombre. */
function shellToolProblems({ list }) {
  const problems = [];
  for (const h of (list && list.hooks) || []) {
    if (!/^(PreToolUse|PostToolUse)$/.test(h.event)) continue;
    const tools = normMatcher(h.matcher).split('|');
    if (tools.includes('Bash') && !tools.includes('PowerShell')) {
      problems.push(`shell-tool: ${scriptOf(h.spec)} (${h.event}) mira comandos con matcher «${h.matcher}» sin «PowerShell»: en Windows no se dispara`);
    }
  }
  return problems;
}

const real = () => ({ list: JSON.parse(read(FILES.list)), support: JSON.parse(read(FILES.support)), pieces: JSON.parse(read(FILES.pieces)) });
/** Una copia de lo real con un cambio: los tres insumos viven en memoria, ningún archivo se toca. */
const copy = (change) => { const c = real(); change(c); return c; };
const row = (c, spec, event) => { const h = c.list.hooks.find((x) => x.spec === spec && (!event || x.event === event)); assert.ok(h, `no hay registro ${spec}`); return h; };
const named = (problems, script) => problems.filter((p) => p.includes(script));

// ── T95 · AC 69 (sobre la lista única desde la W3) ────────────────────────────────────────────────────────────────
test('T95a HooksLists_RealFiles_NoDrift — con los archivos reales, la lista, lo excluido y la lista de piezas coinciden', () => {
  assert.deepStrictEqual(parityProblems(real()), []);
});

test('T95b HooksLists_NoOwnListInAppliers — los dos instaladores leen la lista única: ninguno lleva una propia', () => {
  for (const rel of ['scripts/install-tycon-hooks.sh', 'scripts/install-tycon-hooks.ps1']) {
    const text = read(rel);
    assert.ok(text.includes('apply-hooks.js'), `${rel} no llama a apply-hooks.js`);
    for (const marker of ['HOOKS_CANONICAL=(', 'OPTIN_HOOKS', '$HooksCanonical', '$HooksOptIn']) assert.ok(!text.includes(marker), `${rel} todavía trae ${marker}`);
  }
  const l = real().list.hooks;
  assert.ok(l.some((h) => h.event === 'PreToolUse' && normMatcher(h.matcher) === 'Edit|Write' && h.spec === 'tycon-pipeline/scripts/hook-pre-edit.js'));
  assert.ok(l.some((h) => h.spec === '@tcg:safety-guard-pre.sh' && h.when === 'optin:TYCON_SAFETY_GUARD'), 'los opt-in también están');
});

test('T95c HooksLists_ExcludedButNotDeclared_IsRed — un registro que Windows deja afuera sin declararlo da rojo y nombra el guion', () => {
  const problems = parityProblems(copy((c) => { row(c, '@tcg:safety-guard-pre.sh').platforms.windows = false; }));
  assert.ok(named(problems, 'safety-guard-pre.sh').some((p) => p.startsWith('not-excluded:')), problems.join('\n'));
  assert.ok(named(problems, 'safety-guard-pre.sh').some((p) => p.startsWith('pieces-windows:')), problems.join('\n'));
  assert.strictEqual(problems.length, 2, problems.join('\n'));
});

test('T95d HooksLists_NewRowWithoutPiece_IsRed — un registro nuevo sin su pieza da rojo y nombra el guion', () => {
  const problems = parityProblems(copy((c) => {
    c.list.hooks.unshift({ event: 'PreToolUse', matcher: 'Bash|PowerShell', spec: '@tcg:lab-new-guard.js', when: 'always', platforms: { windows: true }, label: 'un control nuevo' });
  }));
  assert.deepStrictEqual(problems, ['pieces-missing: lab-new-guard.js (PreToolUse) no está en la lista de piezas']);
});

test('T95e HooksLists_ExcludedButRegisteredOnWindows_IsRed — un excluido que la lista registra en Windows por otro evento da rojo', () => {
  const problems = parityProblems(copy((c) => {
    c.list.hooks.push({ event: 'Stop', matcher: '', spec: '@tcg:harness-bootstrap-heal.sh', when: 'always', platforms: { windows: true }, label: 'x' });
  }));
  assert.ok(problems.some((p) => p.startsWith('excluded-registered: harness-bootstrap-heal.sh (Stop)')), problems.join('\n'));
});

test('T95f HooksLists_ExcludedReasonErased_IsRed — un excluido sin motivo, o sacado de la lista, da rojo y nombra el guion', () => {
  const erased = parityProblems(copy((c) => { c.support.excluded.find((e) => e.id === 'harness-bootstrap-heal.sh').reason = '  '; }));
  assert.deepStrictEqual(erased.map((p) => p.split(':')[0]), ['excluded-reason'], erased.join('\n'));
  assert.ok(erased[0].includes('harness-bootstrap-heal.sh'));
  const gone = parityProblems(copy((c) => { c.support.excluded = c.support.excluded.filter((e) => e.id !== 'harness-bootstrap-heal.sh'); }));
  assert.deepStrictEqual(gone.map((p) => p.split(':')[0]), ['not-excluded'], gone.join('\n'));
  // una entrada que no es de un hook no alcanza para dejar un hook afuera
  const otherKind = parityProblems(copy((c) => { c.support.excluded.find((e) => e.id === 'harness-bootstrap-heal.sh').kind = 'scheduled-task'; }));
  assert.ok(otherKind.some((p) => p.startsWith('not-excluded: harness-bootstrap-heal.sh')), otherKind.join('\n'));
  // lo excluido no puede estar registrado, ni nombrar un guion que nadie registra
  const both = parityProblems(copy((c) => { c.support.excluded.push({ id: 'safety-guard-pre.sh', kind: 'hook', reason: 'un motivo cualquiera' }); }));
  assert.deepStrictEqual(both, ['excluded-registered: safety-guard-pre.sh (PreToolUse) está en «excluded» y la lista lo registra en Windows']);
  const stale = parityProblems(copy((c) => { c.support.excluded.push({ id: 'lab-retired-hook.js', kind: 'hook', reason: 'un motivo cualquiera' }); }));
  assert.deepStrictEqual(stale, ['excluded-unknown: lab-retired-hook.js está en «excluded» y la lista de hooks no lo registra']);
  // sin la lista, no es «nada excluido»
  assert.ok(parityProblems(copy((c) => { delete c.support.excluded; })).some((p) => p.startsWith('excluded:')));
});

test('T95g HooksLists_PiecesWindowsFlipped_IsRed — un `windows` al revés en la lista de piezas da rojo y nombra el guion', () => {
  const flip = (id) => copy((c) => { const d = c.pieces.pieces.find((p) => p.id === id); assert.ok(d, `no hay pieza ${id}`); d.windows = !d.windows; });
  assert.deepStrictEqual(parityProblems(flip('PreToolUse:@tcg:safety-guard-pre.sh')),
    ['pieces-windows: safety-guard-pre.sh (PreToolUse) — la lista de piezas dice windows: false y la lista de hooks lo registra en Windows']);
  assert.deepStrictEqual(parityProblems(flip('SessionStart:@tcg:harness-bootstrap-heal.sh')),
    ['pieces-windows: harness-bootstrap-heal.sh (SessionStart) — la lista de piezas dice windows: true y la lista de hooks no lo registra en Windows']);
  const less = parityProblems(copy((c) => { c.pieces.pieces = c.pieces.pieces.filter((p) => p.id !== 'Stop:@tcg:large-read-meter.js'); }));
  assert.deepStrictEqual(less, ['pieces-missing: large-read-meter.js (Stop) no está en la lista de piezas']);
  const more = parityProblems(copy((c) => {
    c.pieces.pieces.push({ kind: 'hook', id: 'PostToolUse:lab-skill/scripts/on-story-create.js', where_pattern: 'settings\\.json$', when: 'platform:windows', windows: true });
  }));
  assert.deepStrictEqual(more, ['pieces-unknown: lab-skill/scripts/on-story-create.js (PostToolUse) está en la lista de piezas y no en la lista de hooks']);
});

test('T95h HooksLists_EmptyReader_IsRed — un lector que no lee nada no da verde', () => {
  const problems = parityProblems(copy((c) => { c.list.hooks = []; }));
  assert.ok(problems.some((p) => p.startsWith('reader: sólo leí 0 registros de la lista')), problems.join('\n'));
});

// ── (d) la herramienta PowerShell de Claude Code (2026-10-04) ───────────────────────────────────────────────────────
test('PS1a HooksLists_ShellCommandRows_CoverPowerShell — todo registro que mira comandos cubre también la herramienta PowerShell', () => {
  assert.deepStrictEqual(shellToolProblems(real()), []);
  for (const g of ['@tcg:safety-guard-pre.sh', '@tcg:test-scope-guard-pre.sh']) {
    assert.ok(real().list.hooks.some((h) => h.event === 'PreToolUse' && h.spec === g && normMatcher(h.matcher) === 'Bash|PowerShell'), `${g} no está con «Bash|PowerShell»`);
  }
});

test('PS1b HooksLists_BashOnlyRow_IsRed — un registro con «Bash» solo da rojo y nombra el guion', () => {
  const p = shellToolProblems(copy((c) => { row(c, '@tcg:safety-guard-pre.sh').matcher = 'Bash'; }));
  assert.deepStrictEqual(p, ['shell-tool: safety-guard-pre.sh (PreToolUse) mira comandos con matcher «Bash» sin «PowerShell»: en Windows no se dispara']);
  // lo que no mira comandos no se juzga: un SessionStart sin matcher, un Edit|Write
  assert.deepStrictEqual(shellToolProblems({ list: { hooks: [
    { event: 'SessionStart', matcher: '', spec: '@tcg:lab.js' }, { event: 'PreToolUse', matcher: 'Edit|Write', spec: 'lab/x.js' },
  ] } }), []);
});

module.exports = { parityProblems, shellToolProblems };
