'use strict';
/**
 * hooks-lists-parity.test.js — lo que Windows registra y lo que deja afuera no se desfasan sin que alguien lo diga
 * (sobre la lista única).
 *
 * EL CASO. `install-tycon-hooks.sh` y `install-tycon-hooks.ps1` leen UNA lista (`scripts/setup/hooks-list.json`), y lo
 * que Windows deja afuera es su campo `platforms.windows: false`. Con dos listas propias, el `.ps1` registraría menos
 * controles que el `.sh` (entre ellos los dos frenos de comandos) sin que nada lo dijera. Con la lista única quedan tres
 * archivos que dicen cosas sobre los mismos hooks, y esta prueba los cruza.
 *
 * QUÉ FRENA. Tres reglas:
 *   (a) cada registro con `platforms.windows: false` tiene su guion en `scripts/setup/windows-support.json` → `excluded`
 *       (con `kind: hook` y su motivo), y cada hook de `excluded` es un registro de la lista con `windows: false`;
 *   (b) los guiones excluidos no se registran en Windows por ningún otro de sus eventos;
 *   (c) el campo `windows` de `scripts/tests/fixtures/harness-managed-pieces.json` dice lo mismo que la lista, pieza por
 *       pieza, y no hay pieza «hook» que la lista no tenga ni registro de la lista sin pieza.
 * Y una cuarta: (d) todo registro de PreToolUse/PostToolUse con `Bash` en el matcher lleva también
 * `PowerShell`. En Windows Claude Code corre los comandos con su herramienta PowerShell (`tool_name: "PowerShell"`), y un
 * hook con matcher `Bash` solo no se dispara: `git add -A` en agent-skills y `git commit --no-verify` pasarían sin que
 * el freno los mirara (code.claude.com/docs/en/tools-reference, «PowerShell tool»).
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

// la lista real con los hooks del lado Claude Code de las integraciones (de sus manifiestos): el aplicador los suma así
const listWithIntegrations = () => {
  const list = JSON.parse(read(FILES.list));
  const INT = require(path.join(ROOT, 'scripts', 'lib', 'integrations.js'));
  const extra = INT.listManifests({ dir: path.join(ROOT, 'integrations') }).manifests.flatMap((m) => INT.hookEntries(m, { tool: 'claude' }));
  return Object.assign({}, list, { hooks: list.hooks.concat(extra) });
};
const real = () => ({ list: listWithIntegrations(), support: JSON.parse(read(FILES.support)), pieces: JSON.parse(read(FILES.pieces)) });
/** Una copia de lo real con un cambio: los tres insumos viven en memoria, ningún archivo se toca. */
const copy = (change) => { const c = real(); change(c); return c; };
const row = (c, spec, event) => { const h = c.list.hooks.find((x) => x.spec === spec && (!event || x.event === event)); assert.ok(h, `no hay registro ${spec}`); return h; };
const named = (problems, script) => problems.filter((p) => p.includes(script));

// ── T95 (sobre la lista única) ────────────────────────────────────────────────────────────────
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

// ── (d) la herramienta PowerShell de Claude Code ───────────────────────────────────────────────────────
test('PS1a HooksLists_ShellCommandRows_CoverPowerShell — todo registro que mira comandos cubre también la herramienta PowerShell', () => {
  assert.deepStrictEqual(shellToolProblems(real()), []);
  for (const g of ['@tcg:safety-guard-pre.sh', '@tcg:test-scope-guard-pre.sh']) {
    assert.ok(real().list.hooks.some((h) => h.event === 'PreToolUse' && h.spec === g && ['Bash', 'PowerShell'].every((x) => normMatcher(h.matcher).split('|').includes(x))), `${g} no está con «Bash|PowerShell»`);
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

// ── (e) las demás listas que nombran cada gancho ───────────────────────────────────────────────────────
// Un gancho nuevo en hooks-list.json tiene que estar también en la lista de efectos, en los textos del sitio y en la
// tabla de INSTALL.md. Las suites que lo miran (repo-papers, how-it-works, integration-effects…) son pesadas y no corren
// en la prueba acotada: el faltante salía recién en la cola. Acá sale en la prueba corta, con el renglón que falta.
// Las mismas reglas que esas suites: los textos, los del lector del sitio (`readControls`: un despachador no lleva texto
// propio, cada control de su cadena sí; uno de una integración lo trae su manifiesto); la tabla, un par (evento, guion)
// por registro, con los de las integraciones escritos `integrations/<n>/…`.
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification', 'SessionEnd'];
const MORE = { effects: 'scripts/setup/install-effects.json', texts: 'scripts/site/texts.js', install: 'INSTALL.md' };
const tableName = (spec) => spec.replace(/^@tcg:/, '').replace(/^@int:/, 'integrations/');

/** Los pares (evento, guion) de la tabla «Los hooks que instala» de INSTALL.md; null si no está la tabla. */
function installPairs(text) {
  const lines = text.split('\n');
  let inFence = false;
  const h = lines.findIndex((l) => { if (/^\s*(```|~~~)/.test(l)) inFence = !inFence; return !inFence && /^#+\s.*Los hooks que instala/.test(l); });
  if (h < 0) return null;
  const start = lines.findIndex((l, i) => i > h && /^\s*\|/.test(l));
  if (start < 0) return null;
  const pairs = new Set();
  for (let i = start + 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) {
    const cells = lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.replace(/`/g, '').trim());
    const event = (cells[1] || '').match(new RegExp(`\\b(${EVENTS.join('|')})\\b`));
    if (event) pairs.add(`${event[1]} ${cells[0]}`);
  }
  return pairs;
}

/**
 * Lo que falta en las otras listas, cada cosa con la lista y el renglón que hay que agregar. Vacío = ninguna falta.
 * @param {{own: object[], all: object[], effects: object, texts: object, controls: object[], install: string}} input
 *   `own`: los registros de hooks-list.json; `all`: ésos más los de las integraciones (la tabla los lleva a todos).
 */
function listsProblems({ own = [], all = [], effects, texts, controls, install }) {
  const problems = [];
  const ids = new Set(((effects && effects.effects) || []).map((e) => e && e.id));
  if (ids.size < 30) problems.push(`reader: sólo leí ${ids.size} entradas de ${MORE.effects}`);
  // los de las integraciones declaran su efecto en su manifiesto: acá sólo los de la lista del arnés
  for (const h of own) {
    const id = pieceIdOf(h);
    if (!ids.has(id)) problems.push(`effects-missing: ${scriptOf(h.spec)} (${h.event}) no está en ${MORE.effects} — agregá una entrada con "id": "${id}", "kind": "hook" y su "does", "title" y "en"`);
  }
  if (!Array.isArray(controls) || controls.length < 30) problems.push(`reader: sólo leí ${(controls || []).length} controles con el lector del sitio`);
  const seen = new Set();
  for (const c of controls || []) {
    if (c.control || seen.has(c.spec)) continue;
    seen.add(c.spec);
    const v = (texts && (texts[`control.${c.spec}@${c.event}`] || texts[`control.${c.spec}`])) || null;
    if (!v || !v.es || !v.en) problems.push(`texts-missing: ${c.spec} no tiene su texto en ${MORE.texts} — agregá 'control.${c.spec}': { es: '<qué hace, en castellano>', en: '<what it does, in English>' }`);
  }
  const pairs = installPairs(String(install || ''));
  if (!pairs) problems.push(`install-table: ${MORE.install} no tiene la tabla de «Los hooks que instala»`);
  else {
    for (const h of all) {
      const k = `${h.event} ${tableName(h.spec)}`;
      if (!pairs.has(k)) problems.push(`install-missing: ${tableName(h.spec)} (${h.event}) no tiene su fila en la tabla de ganchos de ${MORE.install} — agregá | \`${tableName(h.spec)}\` | ${h.event} | <qué hace> | <¿bloquea?> | <perfil> | <interruptor> |`);
    }
  }
  return problems;
}

const realLists = () => {
  const HIW = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'how-it-works.js'));
  return {
    own: JSON.parse(read(FILES.list)).hooks,
    all: listWithIntegrations().hooks,
    effects: JSON.parse(read(MORE.effects)),
    texts: require(path.join(ROOT, MORE.texts)).TEXTOS,
    controls: HIW.readControls(ROOT).controls,
    install: read(MORE.install),
  };
};

test('HL1 HooksLists_EveryHookInEveryList — con los archivos reales, cada gancho está en la lista de efectos, en los textos del sitio y en la tabla de INSTALL.md', () => {
  assert.deepStrictEqual(listsProblems(realLists()), []);
});

test('HL2 HooksLists_NewHookMissingEverywhere_IsRed — un gancho nuevo sólo en hooks-list.json da un rojo por lista, con el renglón que falta', () => {
  const c = realLists();
  const nuevo = { event: 'SessionStart', matcher: '', spec: '@tcg:lab-owner-record.js', when: 'always', platforms: { windows: true }, label: 'x' };
  c.own = c.own.concat(nuevo);
  c.all = c.all.concat(nuevo);
  c.controls = c.controls.concat({ spec: nuevo.spec, event: nuevo.event, control: null });
  const p = listsProblems(c);
  assert.deepStrictEqual(p.map((x) => x.split(':')[0]), ['effects-missing', 'texts-missing', 'install-missing'], p.join('\n'));
  assert.match(p[0], /"id": "SessionStart:@tcg:lab-owner-record\.js"/);
  assert.match(p[1], /'control\.@tcg:lab-owner-record\.js': \{ es: /);
  assert.match(p[1], /scripts\/site\/texts\.js/);
  assert.match(p[2], /\| `lab-owner-record\.js` \| SessionStart \|/);
  assert.match(p[2], /INSTALL\.md/);
});

test('HL3 HooksLists_OneListMissing_NamesOnlyThatList — el caso del #882: el texto del sitio y la fila de INSTALL.md faltan, la lista de efectos no', () => {
  const c = realLists();
  const h = c.own.find((x) => x.spec === '@tcg:context-size-notice.js' && x.event === 'UserPromptSubmit');
  assert.ok(h, 'no está el registro de ejemplo');
  const texts = { ...c.texts };
  delete texts['control.@tcg:context-size-notice.js'];
  const install = c.install.split('\n').filter((l) => !(l.includes('`context-size-notice.js`') && l.includes('UserPromptSubmit'))).join('\n');
  const p = listsProblems({ ...c, texts, install });
  assert.deepStrictEqual(p.map((x) => x.split(':')[0]), ['texts-missing', 'install-missing'], p.join('\n'));
  assert.ok(p.every((x) => x.includes('context-size-notice.js')), p.join('\n'));
  // la otra fila del mismo gancho (SessionStart) sigue: falta sólo la de UserPromptSubmit
  assert.match(p[1], /\(UserPromptSubmit\)/);
});

test('HL4 HooksLists_EmptyReaders_AreRed — una lista de efectos vacía, sin controles o sin la tabla no dan verde', () => {
  const c = realLists();
  const p = listsProblems({ ...c, effects: { effects: [] }, controls: [], install: '# INSTALL\nsin tabla\n' });
  assert.ok(p.some((x) => x.startsWith(`reader: sólo leí 0 entradas de ${MORE.effects}`)), p.join('\n'));
  assert.ok(p.some((x) => x.startsWith('reader: sólo leí 0 controles')), p.join('\n'));
  assert.ok(p.some((x) => x.startsWith('install-table:')), p.join('\n'));
});

module.exports = { parityProblems, shellToolProblems, listsProblems };
