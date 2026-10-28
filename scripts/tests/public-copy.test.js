'use strict';

/**
 * public-copy.test.js — las funciones puras con que el exportador arma la copia pública.
 *
 * Lo que no se puede perder:
 *   · `internalBlocks`: el bloque interno sale entero con sus marcadores; el sólo-público queda visible sin sus dos
 *     líneas; un marcador sin par, anidado, dentro de un cerco o entre dos filas de tabla es un error con archivo y
 *     línea. `markerLines` encuentra el marcador que quedó fuera de un `.md`.
 *   · `brokenLinks`: un enlace relativo de Markdown a algo que no está en la copia es hallazgo; los de un cerco, los de
 *     código en línea, `https://`, `mailto:` y `#ancla` no cuentan.
 *   · `readmePaths`: una ruta entre comillas invertidas del README o del INSTALL de la raíz que empieza con una entrada
 *     de primer nivel y no está en la copia es hallazgo; `:N` y `#…` se quitan, un glob tiene que coincidir con algo,
 *     `<placeholder>`, `{…}` y `.tycon/` se saltean.
 *   · `attributions`: el NOTICE nombra exactamente los `derived` que salen: ni uno de menos ni uno de más.
 *   · `renameSkill` / `renameLeft`: el identificador viejo se reemplaza en todo texto salvo la lista cerrada de
 *     excepciones; lo que queda es hallazgo con archivo y línea.
 *   · `publicThirdParty`: quedan sólo las `download` usadas (cierre transitivo) con licencia MIT o Apache-2.0; el resto
 *     del manifiesto, byte a byte.
 *
 * Funciones puras: la prueba no toca disco ni git. Los marcadores se arman por partes, para que ninguna línea de este
 * archivo sea exactamente un marcador (el exportador frena un marcador solo en su línea fuera de un `.md`).
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const pc = require(path.join(__dirname, '..', 'publishing', 'public-copy.js'));

const IS = '<!-- ' + 'tycon:internal-start -->';
const IE = '<!-- ' + 'tycon:internal-end -->';
const PS = '<!-- ' + 'tycon:public-only';
const PE = '-' + '->';
const FENCE = '`'.repeat(3);
const lines = (...l) => l.join('\n');
const existsIn = (...paths) => (p) => paths.some((x) => x === p || x.startsWith(`${p}/`));

// ── internalBlocks ────────────────────────────────────────────────────────────────────────────────────────────────

test('InternalBlocks_InternalBlockRemovedWithMarkers', () => {
  const r = pc.internalBlocks(lines('# Título', IS, 'secreto del equipo', IE, 'público'), 'README.md');
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.text, lines('# Título', 'público'));
});

test('InternalBlocks_PublicOnlyShownWithoutMarkers', () => {
  const r = pc.internalBlocks(lines('antes', PS, 'sólo afuera', PE, 'después'), 'INSTALL.md');
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.text, lines('antes', 'sólo afuera', 'después'));
});

test('InternalBlocks_FenceAndTableInsideInternal_RemovedWhole', () => {
  const src = lines('a', IS, FENCE + 'bash', 'git clone uno', 'git clone dos', FENCE, '| x | y |', '|---|---|', '| 1 | 2 |', IE, 'b');
  const r = pc.internalBlocks(src, 'INSTALL.md');
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.text, lines('a', 'b'));
});

test('InternalBlocks_BothKindsAndTrailingNewline_Kept', () => {
  const src = lines('x', IS, 'i', IE, PS, 'p', PE, 'y', '');
  const r = pc.internalBlocks(src, 'README.md');
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.text, lines('x', 'p', 'y', ''));
});

test('InternalBlocks_IndentedOrCrlfMarker_Recognized', () => {
  const r = pc.internalBlocks(['a', `  ${IS}\r`, 'i', `${IE}  `, 'b'].join('\n'), 'README.md');
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.text, lines('a', 'b'));
});

test('InternalBlocks_NoMarkers_Unchanged', () => {
  const src = lines('# Nada', 'texto con un <!-- comentario --> en línea', PE, 'fin');
  const r = pc.internalBlocks(src, 'guides/x.md');
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.text, src);
});

// Un marcador con texto en la misma línea no es «texto»: es un marcador casi bien escrito y FRENA. Si pasara callado,
// con la apertura y el cierre escritos igual el bloque entero saldría en la copia. Para nombrarlo en la prosa: sin el comentario (`tycon:internal-start`).
test('InternalBlocks_MarkerNotAloneOnLine_Brakes', () => {
  const src = lines('se escribe así: ' + IS, 'fin');
  const r = pc.internalBlocks(src, 'guides/x.md');
  assert.strictEqual(r.errors.length, 1);
  assert.match(r.errors[0].why, /casi/);
  assert.strictEqual(r.errors[0].line, 1);
  assert.strictEqual(r.text, src, 'con errores el texto vuelve como estaba');
  assert.strictEqual(r.changed, false);
  // nombrado sin el comentario no es un marcador
  const named = lines('se escribe con `tycon:internal-start` y `tycon:internal-end`', 'fin');
  assert.deepStrictEqual(pc.internalBlocks(named, 'guides/x.md').errors, []);
});

test('InternalBlocks_UnpairedMarker_Fails', () => {
  const r1 = pc.internalBlocks(lines('a', IS, 'b'), 'README.md');
  assert.strictEqual(r1.errors.length, 1);
  assert.deepStrictEqual({ file: r1.errors[0].file, line: r1.errors[0].line }, { file: 'README.md', line: 2 });
  assert.match(r1.errors[0].why, /sin su cierre/);
  assert.strictEqual(r1.text, lines('a', IS, 'b'), 'con errores el texto vuelve como estaba');
  assert.strictEqual(r1.changed, false);

  const r2 = pc.internalBlocks(lines('a', IE), 'README.md');
  assert.deepStrictEqual(r2.errors.map((e) => e.line), [2]);
  assert.match(r2.errors[0].why, /sin su apertura/);

  const r3 = pc.internalBlocks(lines(PS, 'p'), 'INSTALL.md');
  assert.deepStrictEqual(r3.errors.map((e) => [e.file, e.line]), [['INSTALL.md', 1]]);
});

test('InternalBlocks_EndClosingPublicOnly_Fails', () => {
  const r = pc.internalBlocks(lines(PS, 'p', IE), 'README.md');
  assert.ok(r.errors.some((e) => e.line === 3), JSON.stringify(r.errors));
});

test('InternalBlocks_NestedMarker_Fails', () => {
  const r1 = pc.internalBlocks(lines(IS, 'a', IS, 'b', IE), 'README.md');
  assert.ok(r1.errors.some((e) => e.line === 3 && /anidado/.test(e.why)), JSON.stringify(r1.errors));
  const r2 = pc.internalBlocks(lines(IS, PS, 'x', PE, IE), 'README.md');
  assert.ok(r2.errors.some((e) => e.line === 2 && /anidado/.test(e.why)), JSON.stringify(r2.errors));
});

test('InternalBlocks_HtmlCommentInsidePublicOnly_Fails', () => {
  // En el interno el bloque sólo-público es un comentario: un «-->» adentro lo cerraría antes de tiempo.
  const r = pc.internalBlocks(lines(PS, 'texto <!-- requirements --> más', PE), 'README.md');
  assert.ok(r.errors.some((e) => e.line === 2 && /anidado/.test(e.why)), JSON.stringify(r.errors));
});

test('InternalBlocks_MarkerInsideFence_Fails', () => {
  const r = pc.internalBlocks(lines('a', FENCE, IS, 'x', IE, FENCE), 'guides/x.md');
  assert.deepStrictEqual(r.errors.map((e) => e.line), [3, 5]);
  assert.match(r.errors[0].why, /cerco/);
  // un cerco que abre adentro del bloque y no cierra antes del final: el cierre queda en el cerco
  const r2 = pc.internalBlocks(lines(IS, FENCE, 'x', IE, FENCE), 'guides/x.md');
  assert.ok(r2.errors.some((e) => e.line === 4 && /cerco/.test(e.why)), JSON.stringify(r2.errors));
});

test('InternalBlocks_MarkerBetweenTableRows_Fails', () => {
  const r = pc.internalBlocks(lines('| a | b |', '|---|---|', IS, '| c | d |', IE, '| e | f |'), 'README.md');
  assert.deepStrictEqual(r.errors.map((e) => e.line), [3, 5]);
  assert.match(r.errors[0].why, /tabla/);
});

test('InternalBlocks_TableEntirelyInside_NotBetweenRows', () => {
  const r = pc.internalBlocks(lines('texto', IS, '| a |', '|---|', IE, 'texto'), 'README.md');
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.text, lines('texto', 'texto'));
});

// ── markerLines ───────────────────────────────────────────────────────────────────────────────────────────────────

test('MarkerLines_FindsEachMarkerLine', () => {
  const r = pc.markerLines(lines('// código', IS, 'x', `  ${PS}`, PE, IE));
  assert.deepStrictEqual(r.map((m) => m.line), [2, 4, 6]);
  assert.ok(r.every((m) => typeof m.marker === 'string' && m.marker.includes('tycon:')));
});

// Fuera de un .md: el marcador ENTERO dentro de una línea de código también se ve —el exportador
// frena: los bloques internos van sólo en los .md—. Lo que no es un marcador: el cierre suelto, y el marcador armado
// por partes (como lo arma el propio código, para que ninguna línea suya lo sea).
test('MarkerLines_WholeMarkerInCodeIsSeen_PartsAndBareCloserAreNot', () => {
  assert.deepStrictEqual(pc.markerLines(lines(`const M = '${IS}';`, PE, 'nada')).map((m) => m.line), [1]);
  const byParts = "const M = '<!-- tycon:' + 'internal-start -->';";
  assert.deepStrictEqual(pc.markerLines(lines(byParts, "const E = '<!-- tycon:' + 'internal-end -->';", "const P = '<!-- tycon:' + 'public-only';", PE, 'nada')), []);
});

// ── brokenLinks ───────────────────────────────────────────────────────────────────────────────────────────────────

test('BrokenLinks_MissingTarget_Reported', () => {
  const files = new Map([['guides/a.md', lines('# A', 'ver [la otra](b.md) y [falta](no-esta.md#seccion)')]]);
  const r = pc.brokenLinks(files, existsIn('guides/b.md'));
  assert.deepStrictEqual(r.map(({ file, line, target }) => ({ file, line, target })), [
    { file: 'guides/a.md', line: 2, target: 'no-esta.md#seccion' },
  ]);
});

test('BrokenLinks_InsideFenceOrInlineCode_Ignored', () => {
  const files = [['README.md', lines(FENCE + 'md', '[x](falta1.md)', FENCE, 'el código `[x](falta2.md)` no cuenta', '~~~', '[y](falta3.md)', '~~~')]];
  assert.deepStrictEqual(pc.brokenLinks(files, () => false), []);
});

test('BrokenLinks_SchemesAnchorsMailto_Ignored', () => {
  const files = { 'README.md': lines('[w](https://example.com/x.md) [h](http://x) [m](mailto:info@example.com)', '[a](#ancla) [p](//cdn.example.com/x)') };
  assert.deepStrictEqual(pc.brokenLinks(files, () => false), []);
});

test('BrokenLinks_ResolvesAgainstFileFolder', () => {
  const seen = [];
  const exists = (p) => { seen.push(p); return true; };
  const files = [{ file: 'guides/bizuit/x.md', text: lines('[1](../maintaining/incident-log.md#caso) [2](./y.md?plain=1) [3](../../scripts/tools/) [4](<con espacio.md>) [5](mi%20guia.md "título")', '![img](../img/a.png)') }];
  assert.deepStrictEqual(pc.brokenLinks(files, exists), []);
  assert.deepStrictEqual(seen, ['guides/maintaining/incident-log.md', 'guides/bizuit/y.md', 'scripts/tools', 'guides/bizuit/con espacio.md', 'guides/bizuit/mi guia.md', 'guides/img/a.png']);
});

test('BrokenLinks_SiblingRepoInTwoRepoLayout_Resolves', () => {
  const files = new Map([['arnes/guides/a.md', '[s](../../agent-skills/skills/tycon-pipeline/SKILL.md)']]);
  assert.deepStrictEqual(pc.brokenLinks(files, existsIn('agent-skills/skills/tycon-pipeline/SKILL.md')), []);
});

test('BrokenLinks_OnlyMarkdownFiles', () => {
  const files = new Map([['scripts/x.js', '// [x](falta.md)'], ['a.md', Buffer.from('[y](falta.md)')]]);
  assert.deepStrictEqual(pc.brokenLinks(files, () => false).map((h) => h.file), ['a.md']);
});

// ── readmePaths ───────────────────────────────────────────────────────────────────────────────────────────────────

const FIRST = ['scripts', 'guides', 'skills', 'README.md', '.tycon', 'INSTALL.md'];

test('ReadmePaths_MissingPath_Reported', () => {
  const files = new Map([
    ['README.md', lines('# R', 'leé `guides/sale.md` y `guides/no-sale.md`', 'y `scripts/tools/x.js [--measured]`')],
    ['guides/sale.md', 'x'],
    ['scripts/tools/x.js', 'x'],
  ]);
  const r = pc.readmePaths(files, FIRST, existsIn('guides/sale.md', 'scripts/tools/x.js'));
  assert.deepStrictEqual(r, [{ file: 'README.md', line: 2, path: 'guides/no-sale.md' }]);
});

test('ReadmePaths_LineSuffixAndAnchor_Stripped', () => {
  const files = new Map([['INSTALL.md', '`scripts/a.sh:184` `scripts/a.sh:12-20` `guides/g.md#seccion` `guides/g.md`']]);
  const seen = [];
  const r = pc.readmePaths(files, FIRST, (p) => { seen.push(p); return true; });
  assert.deepStrictEqual(r, []);
  assert.deepStrictEqual(seen, ['scripts/a.sh', 'scripts/a.sh', 'guides/g.md', 'guides/g.md']);
});

test('ReadmePaths_Glob_MustMatch', () => {
  const files = new Map([
    ['README.md', lines('`scripts/tests/*.test.js`', '`skills/tycon-*`', '`guides/**/*.yaml`')],
    ['scripts/tests/uno.test.js', 'x'],
    ['skills/tycon-pipeline/SKILL.md', 'x'],
  ]);
  const r = pc.readmePaths(files, FIRST, () => { throw new Error('un glob no se pregunta a exists'); });
  assert.deepStrictEqual(r, [{ file: 'README.md', line: 3, path: 'guides/**/*.yaml' }]);
});

test('ReadmePaths_PlaceholderTyconAndNotFirstLevel_Skipped', () => {
  const files = new Map([['README.md', lines(
    '`guides/<guía>.md` `scripts/{a,b}.js` `.tycon/ado-config.yaml` `~/.claude/settings.json`',
    '`node scripts/no-esta.js` `npm test` `otra/cosa.md` `TYCON_PACKS_DEFAULT`',
  )]]);
  assert.deepStrictEqual(pc.readmePaths(files, FIRST, () => false), []);
});

test('ReadmePaths_InsideFence_Ignored', () => {
  const files = new Map([['README.md', lines(FENCE + 'bash', 'ver `scripts/no-esta.js`', FENCE)]]);
  assert.deepStrictEqual(pc.readmePaths(files, FIRST, () => false), []);
});

test('ReadmePaths_OnlyRootReadmeAndInstall', () => {
  const files = new Map([
    ['guides/README.md', '`scripts/no-esta.js`'],
    ['skills/x/INSTALL.md', '`scripts/no-esta.js`'],
    ['NOTES.md', '`scripts/no-esta.js`'],
  ]);
  assert.deepStrictEqual(pc.readmePaths(files, FIRST, () => false), []);
});

test('ReadmePaths_TwoRepoLayout_HarnessReadme', () => {
  const files = new Map([
    ['arnes/README.md', lines('`skills/tycon-*` `scripts/x.js`', '`skills/nada-*`')],
    ['agent-skills/README.md', '`scripts/no-esta.js`'],
    ['agent-skills/skills/tycon-pipeline/SKILL.md', 'x'],
    ['arnes/scripts/x.js', 'x'],
  ]);
  const r = pc.readmePaths(files, new Set(FIRST), (p) => p === 'scripts/x.js');
  assert.deepStrictEqual(r, [{ file: 'arnes/README.md', line: 2, path: 'skills/nada-*' }]);
});

// ── not-in-copy ────────────────────────────────────────────────────────────────
// Una ruta entre comillas invertidas, en prosa de un .md, que existe en el repo del equipo y no en la copia lleva la
// marca a su lado. No la llevan: lo que está en la copia, lo que no existe en el repo, un bloque de código, un ancla al
// registro de incidentes, el README y el INSTALL, ni las convenciones del repo del lector.
test('PublicCopy_PathThatDoesNotTravel_IsMarked', () => {
  const repo = existsIn('tasks/plan-x.md', 'tasks/todo.md', '.tycon/x', 'specs/story-1.2-algo.md', 'scripts/a.js', 'scripts/b.js',
    'guides/maintaining/incident-log.md', 'guides/a.md', 'inbox', 'skills/s/steps/paso.md');
  const copia = existsIn('scripts/b.js', 'guides/a.md', 'skills/s/steps/paso.md');
  const opts = { inRepo: repo, inCopy: copia, conventions: ['tasks/todo.md', '.tycon/', 'specs'] };
  const M = pc.NOT_IN_COPY_MARK;
  assert.ok(typeof M === 'string' && M.trim().length > 0 && M.length <= 60, 'una marca corta, definida en un solo lugar');
  const texto = lines(
    'El plan vive en `tasks/plan-x.md` y la carpeta `inbox`.',            // 1: dos que no viajan
    'Está en la copia: `scripts/b.js`; no existe: `scripts/zzz.js`.',      // 2: nada
    'Convenciones: `tasks/todo.md`, `.tycon/x`, `specs`.',                 // 3: nada
    'Una story del equipo: `specs/story-1.2-algo.md`; un ejemplo: `specs/story-9.9-ejemplo.md`.', // 4: sólo la primera
    'El caso: `guides/maintaining/incident-log.md#un-caso-2026-01-01`.',              // 5: nada
    'Con línea: `scripts/a.js:12`.',                                        // 6: marcada
    FENCE,
    'node scripts/a.js',
    '`scripts/a.js` dentro del cerco',                                      // 9: nada (cerco)
    FENCE,
    'Relativa a su carpeta: `steps/paso.md`.',                              // 11: nada (no existe en la raíz)
  );
  const r = pc.markPathsNotInCopy(texto, 'skills/s/SKILL.md', opts);
  assert.deepStrictEqual(r.marked.map(({ line, path: p }) => [line, p]),
    [[1, 'tasks/plan-x.md'], [1, 'inbox'], [4, 'specs/story-1.2-algo.md'], [6, 'scripts/a.js']]);
  const ls = r.text.split('\n');
  assert.strictEqual(ls[0], `El plan vive en \`tasks/plan-x.md\`${M} y la carpeta \`inbox\`${M}.`);
  assert.strictEqual(ls[5], `Con línea: \`scripts/a.js:12\`${M}.`);
  for (const i of [1, 2, 4, 6, 7, 8, 9, 10]) assert.strictEqual(ls[i], texto.split('\n')[i], `la línea ${i + 1} queda igual`);
  // idempotente: una ruta que ya lleva la marca no se marca dos veces
  assert.strictEqual(pc.markPathsNotInCopy(r.text, 'skills/s/SKILL.md', opts).text, r.text);
  // el README y el INSTALL los gobierna readmePaths; un archivo que no es .md no se toca
  for (const f of ['README.md', 'INSTALL.md', 'arnes/README.md', 'scripts/notas.txt']) {
    assert.deepStrictEqual(pc.markPathsNotInCopy(texto, f, opts).marked, [], f);
  }
  // una ruta que el archivo nombra relativa a su carpeta y que está en la copia desde ahí no se marca aunque exista en la raíz
  const relativa = existsIn('pipelines', 'plantilla/pipelines');
  const r2 = pc.markPathsNotInCopy('La subcarpeta `pipelines`.', 'plantilla/README-plantilla.md',
    { inRepo: relativa, inCopy: existsIn('plantilla/pipelines'), conventions: [] });
  assert.deepStrictEqual(r2.marked, []);
});

// Una ruta escrita relativa a la carpeta del archivo, que existe en el repo del equipo desde ahí y no en la copia,
// también lleva la marca (no sólo se mira desde la raíz).
test('PublicCopy_NotInCopy_RelativeTeamPath_IsMarked', () => {
  const opts = { inRepo: existsIn('guides/vecina.md', 'guides/a.md'), inCopy: existsIn('guides/a.md'), conventions: [] };
  const r = pc.markPathsNotInCopy('Ver `vecina.md` y `a.md`.', 'guides/a.md', opts);
  assert.deepStrictEqual(r.marked.map((m) => m.path), ['guides/vecina.md']);
  assert.strictEqual(r.text, `Ver \`vecina.md\`${pc.NOT_IN_COPY_MARK} y \`a.md\`.`);
});

// La forma con que las skills nombran un archivo del arnés instalado (un prefijo
// de `installPrefixes`, que el exportador arma con el nombre del lugar) es una ruta del repo. Acá, prefijos de mentira.
test('PublicCopy_NotInCopy_HarnessInstallPrefix_IsMarked', () => {
  const opts = { inRepo: existsIn('tasks/plan.md', 'skills/s/x.md', 'guides/a.md'), inCopy: existsIn('guides/a.md'), conventions: [],
    installPrefixes: ['~/.claude/acme-lugar/', [/^~\/\.claude\/acme-sk\//, 'skills/']] };
  const r = pc.markPathsNotInCopy('Ver `~/.claude/acme-lugar/tasks/plan.md`, `~/.claude/acme-sk/s/x.md` y `~/.claude/acme-lugar/guides/a.md`.', 'skills/s/SKILL.md', opts);
  assert.deepStrictEqual(r.marked.map((m) => m.path), ['tasks/plan.md', 'skills/s/x.md']);
  // otra cosa bajo ~ (la carpeta de estado, una config del usuario) no es del repo
  assert.deepStrictEqual(pc.markPathsNotInCopy('`~/.claude/otra-cosa/tasks/plan.md`', 'guides/b.md', opts).marked, []);
  // sin prefijos declarados, nada bajo ~ es una ruta del repo
  assert.deepStrictEqual(pc.markPathsNotInCopy('`~/.claude/acme-lugar/tasks/plan.md`', 'guides/b.md', { ...opts, installPrefixes: [] }).marked, []);
});

// El código en línea se lee como CommonMark: una tanda de comillas
// invertidas sin su pareja de igual largo es texto, y no se come la apertura de un código en línea posterior.
test('PublicCopy_NotInCopy_UnbalancedBackticks_FollowCommonMark', () => {
  const opts = { inRepo: existsIn('scripts/y.js', 'tasks/x.md'), inCopy: () => false, conventions: [] };
  const marcadas = (t) => pc.markPathsNotInCopy(t, 'guides/z.md', opts).marked.map((m) => m.path);
  assert.deepStrictEqual(marcadas('el cerco abre con ``` y `scripts/y.js` lo lee'), ['scripts/y.js']);
  assert.deepStrictEqual(marcadas('El título (```) y `tasks/x.md`.'), ['tasks/x.md']);
  assert.deepStrictEqual(marcadas('ver ``scripts/y.js:3-4` acá'), [], 'sin pareja de igual largo no hay código en línea');
  assert.deepStrictEqual(marcadas('ver `` `scripts/y.js` `` acá'), [], 'un código en línea con comillas adentro: su contenido no es una ruta');
  assert.deepStrictEqual(marcadas('dos: ``tasks/x.md`` y `scripts/y.js`'), ['tasks/x.md', 'scripts/y.js']);
});

// Un código en línea que empieza en un renglón y termina en el siguiente (mismo
// párrafo) no despareja las comillas de lo que sigue.
test('PublicCopy_NotInCopy_CodeSpanAcrossLines_IsMarked', () => {
  const opts = { inRepo: existsIn('scripts/secret.js'), inCopy: () => false, conventions: [] };
  const r = pc.markPathsNotInCopy('dice `algo\nsigue` y `scripts/secret.js` fin', 'guides/z.md', opts);
  assert.deepStrictEqual(r.marked.map(({ line, path: p }) => [line, p]), [[2, 'scripts/secret.js']]);
  assert.strictEqual(r.text, `dice \`algo\nsigue\` y \`scripts/secret.js\`${pc.NOT_IN_COPY_MARK} fin`);
  // un párrafo nuevo (renglón en blanco) corta: la comilla suelta del primero no se empareja con la del segundo
  const r2 = pc.markPathsNotInCopy('una `suelta\n\ny `scripts/secret.js` acá', 'guides/z.md', opts);
  assert.deepStrictEqual(r2.marked.map((m) => m.line), [3]);
});

// Una carpeta vecina del archivo que se llama igual que una
// convención suelta del lector (`tasks`) y que es del equipo se marca: la lectura relativa a la carpeta es la más
// específica. La convención sigue valiendo cuando no hay tal vecina.
test('PublicCopy_NotInCopy_NeighbourNamedLikeConvention_IsMarked', () => {
  const opts = { inRepo: existsIn('tasks/todo.md', 'guides/sub/tasks/secreto.md', 'guides/sub/doc.md', 'guides/otra/doc.md'), inCopy: existsIn('guides/sub/doc.md', 'guides/otra/doc.md'), conventions: ['tasks', 'tasks/todo.md'] };
  const r = pc.markPathsNotInCopy('La carpeta `tasks` y `tasks/todo.md`.', 'guides/sub/doc.md', opts);
  assert.deepStrictEqual(r.marked.map((m) => m.path), ['guides/sub/tasks']);
  assert.deepStrictEqual(pc.markPathsNotInCopy('La carpeta `tasks`.', 'guides/otra/doc.md', opts).marked, [], 'sin vecina, es la convención');
});

// ── attributions ──────────────────────────────────────────────────────────────────────────────────────────────────

const DERIVED = [
  { target: 'scripts/tools/rules-distill.js', repo: 'tycon-claude-guides', license: 'MIT' },
  { target: 'skills/acme-made-story', repo: 'agent-skills', license: 'MIT' },
  { target: 'scripts/no-sale.js', repo: 'tycon-claude-guides', license: 'MIT' },
];
const SHIPS = new Set(['scripts/tools/rules-distill.js', 'skills/acme-made-story']);
const notice = (...attr) => lines('Producto', 'Copyright 2026 TYCON', '', 'Atribuciones', '', ...attr, '', 'Permission is hereby granted...');

test('Attributions_AllPresent_Empty', () => {
  const n = notice('* scripts/tools/rules-distill.js — ECC, MIT', '* `skills/acme-made-story` — basada en acme-make-story');
  assert.deepStrictEqual(pc.attributions(n, DERIVED, SHIPS), []);
  assert.deepStrictEqual(pc.attributions(n, DERIVED, (p) => SHIPS.has(p)), []);
});

test('Attributions_MissingLine_Reported', () => {
  const r = pc.attributions(notice('* scripts/tools/rules-distill.js — ECC'), DERIVED, SHIPS);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].file, 'NOTICE');
  assert.strictEqual(r[0].path, 'skills/acme-made-story');
  assert.match(r[0].why, /falta/);
});

test('Attributions_ExtraLine_Reported', () => {
  const n = notice('* scripts/tools/rules-distill.js', '* skills/acme-made-story', '* scripts/no-sale.js — no sale');
  const r = pc.attributions(n, DERIVED, SHIPS);
  assert.deepStrictEqual(r.map(({ file, line, path: p }) => ({ file, line, path: p })), [{ file: 'NOTICE', line: 8, path: 'scripts/no-sale.js' }]);
  assert.match(r[0].why, /no sale/);
});

test('Attributions_DuplicateLine_Reported', () => {
  const n = notice('* scripts/tools/rules-distill.js', '* skills/acme-made-story', '* scripts/tools/rules-distill.js');
  assert.deepStrictEqual(pc.attributions(n, DERIVED, SHIPS).map((h) => h.line), [8]);
});

// ── renameSkill / renameLeft ──────────────────────────────────────────────────────────────────────────────────────

const RULE = {
  source: 'agent-skills',
  from: 'skills/acme-make-story',
  to: 'skills/acme-made-story',
  why: 'publicada como `acme-made-story`: la política de marca de BMad pide otro nombre para una versión propia',
};

const MANIFEST = [
  '{',
  '  "__doc": "manifiesto de mentira «con» comillas",',
  '  "derived": [',
  '    {',
  '      "target": "skills/acme-make-story",',
  '      "repo": "agent-skills",',
  '      "based_on": { "origin": "https://github.com/x/BMAD", "path": "src/acme-make-story" },',
  '      "license": "MIT",',
  '      "license_source": "LICENSE de acme-make-story",',
  '      "used_by": ["tycon-pipeline"],',
  '      "why": "BMAD con cambios; acme-make-story conserva el nombre"',
  '    },',
  '    { "target": "scripts/x.js", "why": "nombra a acme-make-story" }',
  '  ],',
  '  "third_party": [',
  '    { "target": "skills/bmad-init", "used_by": ["acme-make-story"],   "why": "la carga acme-make-story" }',
  '  ]',
  '}',
  '',
].join('\n');

test('RenameSkill_RenamesIdentifierInText', () => {
  const r = pc.renameSkill(lines('---', 'name: acme-make-story', '---', 'usa `acme-make-story` y skills/acme-make-story/SKILL.md'), 'skills/acme-make-story/SKILL.md', RULE);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.text, lines('---', 'name: acme-made-story', '---', 'usa `acme-made-story` y skills/acme-made-story/SKILL.md'));
  const js = pc.renameSkill("const S = 'acme-make-story';\n", 'skills/tycon-pipeline/scripts/lib/x.js', RULE);
  assert.strictEqual(js.text, "const S = 'acme-made-story';\n");
});

test('RenameSkill_NoMention_Unchanged', () => {
  const r = pc.renameSkill('nada que ver con bmad-dev-story\n', 'a.md', RULE);
  assert.deepStrictEqual(r, { text: 'nada que ver con bmad-dev-story\n', changed: false });
});

test('RenameSkill_SecondPass_NoChange', () => {
  const once = pc.renameSkill('acme-make-story', 'a.md', RULE).text;
  assert.deepStrictEqual(pc.renameSkill(once, 'a.md', RULE), { text: once, changed: false });
});

test('RenameSkill_NoticeExceptions_Untouched', () => {
  const t = 'basada en acme-make-story de BMad Method\n';
  for (const f of ['NOTICE', 'skills/acme-make-story/NOTICE.md', 'skills/acme-make-story/LICENSE', 'skills/acme-made-story/NOTICE.md', 'skills/acme-made-story/LICENSE', 'agent-skills/skills/acme-make-story/NOTICE.md', 'arnes/NOTICE']) {
    assert.deepStrictEqual(pc.renameSkill(t, f, RULE), { text: t, changed: false }, f);
  }
  // un NOTICE.md de otra carpeta no es excepción
  assert.strictEqual(pc.renameSkill(t, 'skills/otra/NOTICE.md', RULE).changed, true);
});

test('RenameSkill_Manifest_KeepsBasedOnAndLicenseSource_FixedWhy', () => {
  const r = pc.renameSkill(MANIFEST, 'scripts/publishing/third-party-skills.json', RULE);
  assert.strictEqual(r.changed, true);
  const expected = MANIFEST
    .replace('"target": "skills/acme-make-story"', '"target": "skills/acme-made-story"')
    .replace('"why": "BMAD con cambios; acme-make-story conserva el nombre"', `"why": ${JSON.stringify(RULE.why)}`)
    .replace('"why": "nombra a acme-make-story"', '"why": "nombra a acme-made-story"')
    .replace('"used_by": ["acme-make-story"],   "why": "la carga acme-make-story"', '"used_by": ["acme-made-story"],   "why": "la carga acme-made-story"');
  assert.strictEqual(r.text, expected);
  const j = JSON.parse(r.text);
  assert.deepStrictEqual(j.derived[0].based_on, { origin: 'https://github.com/x/BMAD', path: 'src/acme-make-story' });
  assert.strictEqual(j.derived[0].license_source, 'LICENSE de acme-make-story');
  // el mismo manifiesto bajo la carpeta del arnés en la copia de dos repos
  assert.strictEqual(pc.renameSkill(MANIFEST, 'arnes/scripts/publishing/third-party-skills.json', RULE).text, expected);
});

test('RenameSkill_InvalidManifest_Throws', () => {
  assert.throws(() => pc.renameSkill('{ "derived": [', 'scripts/publishing/third-party-skills.json', RULE), /third-party-skills\.json/);
});

test('RenameLeft_Leftover_ReportedWithFileAndLine', () => {
  const files = new Map([
    ['skills/tycon-pipeline/x.js', lines('uno', "const S = 'acme-make-story';", 'tres acme-make-story acme-make-story')],
    ['README.md', 'limpio'],
  ]);
  const r = pc.renameLeft(files, RULE);
  assert.deepStrictEqual(r.map(({ file, line }) => [file, line]), [['skills/tycon-pipeline/x.js', 2], ['skills/tycon-pipeline/x.js', 3]]);
});

test('RenameLeft_Exceptions_NotReported', () => {
  const renamed = pc.renameSkill(MANIFEST, 'scripts/publishing/third-party-skills.json', RULE).text;
  const files = new Map([
    ['NOTICE', 'basada en acme-make-story'],
    ['skills/acme-made-story/NOTICE.md', 'adentro se llama acme-make-story'],
    ['skills/acme-made-story/LICENSE', 'acme-make-story'],
    ['scripts/publishing/third-party-skills.json', renamed],
    ['bin.png', Buffer.from([0x89, 0x50, 0x00, 0x62, 0x6d, 0x61, 0x64])],
  ]);
  assert.deepStrictEqual(pc.renameLeft(files, RULE), []);
});

test('RenameLeft_ManifestOtherField_Reported', () => {
  const renamed = pc.renameSkill(MANIFEST, 'scripts/publishing/third-party-skills.json', RULE).text;
  const broken = renamed.replace('"used_by": ["tycon-pipeline"]', '"used_by": ["acme-make-story"]');
  const r = pc.renameLeft(new Map([['scripts/publishing/third-party-skills.json', broken]]), RULE);
  assert.deepStrictEqual(r.map((h) => h.line), [10]);
});

test('RenameLeft_PathWithOldName_Reported', () => {
  const r = pc.renameLeft(new Map([['skills/acme-make-story/steps/a.md', 'limpio']]), RULE);
  assert.deepStrictEqual(r.map(({ file, line }) => [file, line]), [['skills/acme-make-story/steps/a.md', 0]]);
});

test('RenameLeft_CustomExceptions_ReplaceTheList', () => {
  const files = new Map([['NOTICE', 'acme-make-story'], ['otro.md', 'acme-make-story']]);
  assert.deepStrictEqual(pc.renameLeft(files, RULE, ['otro.md']).map((h) => h.file), ['NOTICE']);
});

// ── publicThirdParty ──────────────────────────────────────────────────────────────────────────────────────────────

const TP = [
  '{',
  '  "__doc": "terceros de mentira",',
  '  "own": [ { "glob": "skills/tycon-*", "why": "del equipo" } ],',
  '  "derived": [',
  '    { "target": "scripts/a.js", "license": "MIT" }',
  '  ],',
  '  "origins": {',
  '    "libre@1": { "origin": "https://example.com/libre", "license": "MIT" },',
  '    "apache@1": { "origin": "https://example.com/apache", "license": "Apache-2.0" },',
  '    "cerrado@1": { "origin": "https://example.com/cerrado", "license": "LicenseRef-Proprietary" }',
  '  },',
  '  "third_party": [',
  '    {',
  '      "target": "skills/usada", "from": "libre@1", "install": "download",',
  '      "used_by": ["tycon-pipeline"]',
  '    },',
  '    { "target": "skills/de-la-usada", "from": "apache@1", "install": "download", "used_by": ["usada"] },',
  '    { "target": "skills/nieta", "from": "libre@1", "install": "download", "used_by": ["de-la-usada"] },',
  '    { "target": "skills/no-libre", "from": "cerrado@1", "install": "download", "used_by": ["tycon-pipeline"] },',
  '    { "target": "skills/de-la-no-libre", "from": "libre@1", "install": "download", "used_by": ["no-libre"] },',
  '    { "target": "skills/sin-uso", "from": "libre@1", "install": "download", "used_by": [] },',
  '    { "target": "skills/de-otra", "from": "libre@1", "install": "download", "used_by": ["skill-que-no-sale"] },',
  '    { "target": ".claude/plugins/x", "from": "libre@1", "install": "official-plugin", "used_by": ["tycon-pipeline"] },',
  '    { "target": ".agents/skills/viejo", "from": "libre@1", "install": "retire", "used_by": ["tycon-pipeline"] },',
  '    { "target": "skills/pisa-licencia", "from": "cerrado@1", "license": "MIT", "install": "download", "used_by": ["tycon-pipeline"] },',
  '    { "target": "skills/pisa-al-reves", "from": "libre@1", "license": "NOASSERTION", "install": "download", "used_by": ["tycon-pipeline"] }',
  '  ],',
  '  "retirement": "fin"',
  '}',
  '',
].join('\n');

const KEPT = ['skills/usada', 'skills/de-la-usada', 'skills/nieta', 'skills/pisa-licencia'];

test('PublicThirdParty_UsedFreeAndTransitive_Kept', () => {
  const r = pc.publicThirdParty(TP, ['tycon-pipeline', 'tycon-ado-story-wi']);
  assert.deepStrictEqual(r.kept, KEPT);
  assert.deepStrictEqual(JSON.parse(r.text).third_party.map((e) => e.target), KEPT);
});

test('PublicThirdParty_NonFreeUnusedPluginRetire_Removed', () => {
  const r = pc.publicThirdParty(TP, new Set(['tycon-pipeline']));
  assert.deepStrictEqual(r.removed, [
    'skills/no-libre', 'skills/de-la-no-libre', 'skills/sin-uso', 'skills/de-otra', '.claude/plugins/x', '.agents/skills/viejo', 'skills/pisa-al-reves',
  ]);
});

test('PublicThirdParty_RestByteForByte', () => {
  const r = pc.publicThirdParty(TP, ['skills/tycon-pipeline']);
  const tl = TP.split('\n');
  const s = tl.indexOf('  "third_party": [');
  // lo esperado, a mano: las líneas de las cuatro que quedan (la última sin su coma) y todo lo demás intacto
  const expected = [
    ...tl.slice(0, s + 1),
    tl[s + 1], tl[s + 2], tl[s + 3], tl[s + 4], // usada, en cuatro líneas
    tl[s + 5], tl[s + 6], // de-la-usada, nieta
    tl[s + 13].replace(/,$/, ''), // pisa-licencia, ahora la última
    ...tl.slice(s + 15), // «  ],» y el resto
  ].join('\n');
  assert.strictEqual(tl[s + 15], '  ],');
  assert.strictEqual(r.text, expected);
});

test('PublicThirdParty_NothingRemoved_TextIdentical', () => {
  const t = '{\n  "own": [],\n  "third_party": [ { "target": "skills/a", "from": "o", "install": "download", "used_by": ["s"] } ],\n  "origins": { "o": { "license": "MIT" } }\n}\n';
  const r = pc.publicThirdParty(t, ['s']);
  assert.strictEqual(r.text, t);
  assert.deepStrictEqual(r.removed, []);
});

test('PublicThirdParty_AllRemoved_EmptyArray', () => {
  const t = '{\n  "third_party": [\n    { "target": "skills/a", "install": "retire", "used_by": [] }\n  ],\n  "x": 1\n}\n';
  const r = pc.publicThirdParty(t, []);
  assert.strictEqual(r.text, '{\n  "third_party": [],\n  "x": 1\n}\n');
  assert.deepStrictEqual(JSON.parse(r.text).third_party, []);
});

// `publish: true` hace que la copia baje una skill libre aunque
// nada de lo que sale la nombre en `used_by` —el README promete BMAD completo y las de .NET/React—; su cierre transitivo
// entra con ella. Sin licencia libre, o si no se baja, la marca no alcanza.
test('PublicThirdParty_PublishFlag_KeptOnlyIfFreeDownload', () => {
  const t = [
    '{',
    '  "origins": { "libre@1": { "license": "MIT" }, "dudosa@1": { "license": "NOASSERTION" } },',
    '  "third_party": [',
    '    { "target": "skills/marcada", "from": "libre@1", "install": "download", "used_by": [], "publish": true },',
    '    { "target": "skills/de-la-marcada", "from": "libre@1", "install": "download", "used_by": ["marcada"] },',
    '    { "target": "skills/marcada-dudosa", "from": "dudosa@1", "install": "download", "used_by": [], "publish": true },',
    '    { "target": "skills/marcada-retirada", "from": "libre@1", "install": "retire", "used_by": [], "publish": true },',
    '    { "target": "skills/marcada-falso", "from": "libre@1", "install": "download", "used_by": [], "publish": false }',
    '  ]',
    '}',
    '',
  ].join('\n');
  const r = pc.publicThirdParty(t, []);
  assert.deepStrictEqual(r.kept, ['skills/marcada', 'skills/de-la-marcada']);
  assert.deepStrictEqual(r.removed, ['skills/marcada-dudosa', 'skills/marcada-retirada', 'skills/marcada-falso']);
});

test('PublicThirdParty_InvalidJson_Throws', () => {
  assert.throws(() => pc.publicThirdParty('{ "third_party": [', []), /third-party-skills\.json/);
});

// El nombre viejo dentro del NOMBRE de un archivo (no sólo como una
// carpeta entera) también es un resto que el renombre no movió.
test('RenameLeft_OldIdInsideFileName_Flagged', () => {
  const rule = { from: 'skills/acme-make-story', to: 'skills/acme-made-story' };
  const r = pc.renameLeft(new Map([['skills/tycon-pipeline/acme-make-story.md', 'limpio\n'], ['docs/acme-make-story-notes.txt', 'x'], ['skills/ok/a.md', 'nada\n']]), rule);
  assert.deepStrictEqual(r.map(({ file, line }) => [file, line]).sort(), [['docs/acme-make-story-notes.txt', 0], ['skills/tycon-pipeline/acme-make-story.md', 0]]);
});

// Un enlace a un archivo con paréntesis balanceados en el nombre es válido
// en CommonMark y resuelve; un enlace dentro de un comentario HTML no se muestra y no cuenta.
test('BrokenLinks_ParensInNameAndHtmlComments', () => {
  const files = new Map([['guides/a.md', ['Ver [la guía](notas(2026).md).', '<!-- [viejo](no-existe.md) -->', '<!--', '[otro viejo](tampoco.md)', '-->', '[roto](falta.md)'].join('\n')]]);
  const hay = new Set(['guides/a.md', 'guides/notas(2026).md']);
  const r = pc.brokenLinks(files, (p) => hay.has(p));
  assert.deepStrictEqual(r.map(({ line, target }) => [line, target]), [[6, 'falta.md']]);
});

// Esta prueba viaja en la copia, y el renombre real de la skill (skillRenames de la lista
// blanca) reescribe en la copia todo texto que la nombre. Por eso sus casos usan nombres inventados: si uno nombra la
// skill real, la copia le cambia los datos y la prueba falla afuera y no adentro.
test('PublicCopyTest_DoesNotNameTheRealRenamedSkill', () => {
  const fuente = require('fs').readFileSync(__filename, 'utf8');
  for (const real of ['bmad-' + 'create-story', 'tycon-' + 'create-story']) assert.ok(!fuente.includes(real), `la prueba no nombra ${real}`);
});
