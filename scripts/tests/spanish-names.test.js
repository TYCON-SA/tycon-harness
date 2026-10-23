'use strict';

/**
 * spanish-names.test.js — la convención, la lista de palabras y el conteo del freno de nombres en castellano.
 * T1-T5 y las piezas del extractor.
 *
 * Lo que no se puede perder:
 *   · Que la guía diga las cinco reglas con su ejemplo y que su glosario sea el de la lista.
 *   · Que una lista rota (ilegible, una palabra en dos listas, un glosario que manda dos palabras a la misma) sea
 *     «no pude mirar» (2), nunca un verde.
 *   · Que decidir «castellano» no dependa sólo de la lista cerrada: una palabra que no estaba en la medición y no es
 *     inglesa también cuenta; un plural también; una palabra de las dos lenguas sola no.
 *   · Que el conteo sobre los shas de la medición dé las cifras de la medición corregida.
 *
 * Los nombres castellanos de los ejemplos se arman por concatenación (`'--' + 'sin-copia'`): esta prueba sale en la
 * copia pública y el freno la mira como a cualquier ejecutable. Los commits del freno de verdad, disparados por
 * git, están en githook-livefire.test.sh (T6-T13, T15); el termómetro, en export-real.test.sh (T14).
 */

const test = require('./lib/suite-parts.js').test;   // se corre por partes: lib/suite-parts.js
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(RAIZ, 'scripts', 'publishing', 'spanish-names.js');
const WORDS = path.join(RAIZ, 'scripts', 'lib', 'spanish-words.json');
const GUIDE = path.join(RAIZ, 'guides', 'maintaining', 'nombres-en-ingles.md');
const sn = require(SCRIPT);

// palabras de los ejemplos, armadas para que el propio freno no las vea como nombres de esta prueba
const W = {
  guardar: 'gua' + 'rdar', todo: 'to' + 'do', pedidos: 'pedi' + 'dos', para: 'pa' + 'ra', lista: 'lis' + 'ta',
  de: 'd' + 'e', tareas: 'tare' + 'as', limpiar: 'limp' + 'iar', copia: 'co' + 'pia', sin: 'si' + 'n',
  hoy: 'h' + 'oy', motivo: 'moti' + 'vo', bajar: 'baj' + 'ar', cargar: 'carg' + 'ar', datos: 'dat' + 'os',
};

function cleanEnv(extra = {}) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_') && !k.startsWith('TYCON_')) e[k] = v;
  return {
    ...e, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'Lab', GIT_COMMITTER_EMAIL: 'lab@example.com',
    ...extra,
  };
}
function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', ...args], { env: cleanEnv(), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} (${dir}): ${r.stderr}`);
  return r.stdout.trim();
}
function write(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
}
const run = (args, env = {}, cwd = RAIZ) => spawnSync(process.execPath, [SCRIPT, ...args], {
  cwd, env: cleanEnv({ HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'sn-home-')), ...env }), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
});

// una lista de laboratorio chica y válida
const LAB_WORDS = {
  __doc: 'lista de laboratorio',
  glossary: { [W.copia]: 'copy', [W.sin]: 'without', [W.cargar]: 'load', [W.datos]: 'data' },
  words: [W.copia, W.cargar, W.datos, W.pedidos.slice(0, -1), W.lista, 'tarea', W.todo, W.motivo, W.bajar, W.hoy],
  ambiguous: [W.de, W.para, W.sin, 'es'],
  allowed: [{ word: 'tycon', reason: 'la marca' }, { word: 'json', reason: 'inglés técnico' }],
  schemaFiles: ['scripts/config/settings.json'],
};

// ── T1 · la guía ─────────────────────────────────────────────────────────────────────────────────────────────────
test('T1 SpanishNames_Guide_HasEveryRuleWithExample — la guía trae las cinco reglas con ejemplo, su glosario es el de la lista, y el README la nombra', () => {
  const guide = fs.readFileSync(GUIDE, 'utf8');
  const sections = [
    ['(a)', /^## Qué va en inglés/m],
    ['(b)', /^## Qué sigue en castellano/m],
    ['(c)', /^## Ruta o valor/m],
    ['(d)', /^## Entre repos/m],
    ['(e)', /^## El glosario/m],
  ];
  const starts = sections.map(([id, re]) => {
    const m = re.exec(guide);
    assert.ok(m, `falta la sección ${id} (${re})`);
    return m.index;
  });
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : guide.length;
    const body = guide.slice(start, end);
    assert.match(body, /`[^`]+`/, `la sección ${sections[i][0]} no trae un ejemplo`);
    assert.match(body, /[Ee]jemplo/, `la sección ${sections[i][0]} no dice «ejemplo»`);
  });
  const list = JSON.parse(fs.readFileSync(WORDS, 'utf8'));
  const glossaryBody = guide.slice(starts[4]);
  for (const [es, en] of Object.entries(list.glossary)) {
    assert.ok(glossaryBody.includes(`\`${es}\``) && glossaryBody.includes(`\`${en}\``), `el glosario de la guía no trae ${es} → ${en}`);
  }
  const readme = fs.readFileSync(path.join(RAIZ, 'INDEX.md'), 'utf8');
  assert.match(readme, /^\|[^\n]*`guides\/maintaining\/nombres-en-ingles\.md`[^\n]*\|$/m, 'el índice (INDEX.md) no tiene la fila de la guía en «Cuándo leer cada guía»');
});

// ── T2 · la lista rota es «no pude mirar» ────────────────────────────────────────────────────────────────────────
test('T2 SpanishNames_Words_InvalidFileExits2 — ilegible, una palabra en dos listas o un glosario no inyectivo salen 2 nombrando el problema', () => {
  assert.throws(() => sn.loadWords('{ esto no es json', 'lab.json'), (e) => e instanceof sn.CouldNotLook && /no es JSON válido/.test(e.message));
  const twice = JSON.parse(JSON.stringify(LAB_WORDS));
  twice.ambiguous.push(W.copia);
  assert.throws(() => sn.loadWords(JSON.stringify(twice), 'lab.json'), (e) => e instanceof sn.CouldNotLook && e.message.includes(W.copia) && /dos listas/.test(e.message));
  const allowedToo = JSON.parse(JSON.stringify(LAB_WORDS));
  allowedToo.allowed.push({ word: W.cargar, reason: 'x' });
  assert.throws(() => sn.loadWords(JSON.stringify(allowedToo), 'lab.json'), (e) => e instanceof sn.CouldNotLook && e.message.includes(W.cargar));
  const notInjective = JSON.parse(JSON.stringify(LAB_WORDS));
  notInjective.glossary[W.bajar] = 'load';
  assert.throws(() => sn.loadWords(JSON.stringify(notInjective), 'lab.json'), (e) => e instanceof sn.CouldNotLook && /inyectivo/.test(e.message) && e.message.includes('load'));
  const noReason = JSON.parse(JSON.stringify(LAB_WORDS));
  noReason.allowed.push({ word: 'otel' });
  assert.throws(() => sn.loadWords(JSON.stringify(noReason), 'lab.json'), (e) => e instanceof sn.CouldNotLook && /reason/.test(e.message));

  // por la línea de comandos: un repo de laboratorio con la lista rota, sale 2 y lo dice
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-t2-'));
  try {
    git(lab, ['init', '-q', '-b', 'main']);
    write(lab, { 'scripts/lib/spanish-words.json': '{ rota', 'scripts/x.js': '// nada\n' });
    git(lab, ['add', '-A']);
    const r = run(['--repo', lab]);
    assert.strictEqual(r.status, 2, `salió ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /spanish-words\.json no es JSON válido/);
  } finally { fs.rmSync(lab, { recursive: true, force: true }); }

  // la lista real se carga limpia: 22 aprobadas como mínimo, 60 como máximo, y las ambiguas son la lista corta
  const real = sn.loadWords(fs.readFileSync(WORDS, 'utf8'), 'scripts/lib/spanish-words.json');
  const glossary = Object.keys(real.glossary);
  assert.ok(glossary.length >= 22 && glossary.length <= 60, `el glosario tiene ${glossary.length} entradas`);
  for (const k of ['corrida', 'buzon', 'tablero', 'constancia', 'registro', 'paquete', 'nucleo']) assert.ok(real.glossary[k], `falta ${k} en el glosario`);
  assert.strictEqual(real.glossary.constancia, 'record');
  assert.strictEqual(real.glossary.registro, 'log');
  assert.ok(real.ambiguous.size >= 20 && real.ambiguous.size <= 50, `ambiguas: ${real.ambiguous.size} (la lista corta del dev es ~35)`);
  assert.ok(real.words.has(W.hoy) && !real.ambiguous.has(W.hoy), 'hoy va en words, no en ambiguous (decisión del 2026-09-29)');
  // la propuesta nunca puede ser castellana: cada palabra inglesa del glosario pasa el propio detector
  const realDet = sn.makeDetector(real, {});
  if (realDet.dictionary) {
    const spanishLooking = Object.values(real.glossary).filter((en) => realDet.isSpanish(en).spanish);
    assert.deepStrictEqual(spanishLooking, [], `palabras inglesas del glosario que el freno tomaría por castellanas: ${spanishLooking.join(', ')} (van a allowed)`);
  }
});

// ── T3 · qué cuenta como castellano ──────────────────────────────────────────────────────────────────────────────
test('T3 SpanishNames_Detect_UnlistedWordPluralAndAmbiguous — cuenta lo no listado que no es inglés, el plural y la ambigua acompañada; no la ambigua sola', (t) => {
  const words = sn.loadWords(JSON.stringify(LAB_WORDS), 'lab.json');
  const d = sn.makeDetector(words, { dictPath: '/usr/share/dict/words' });
  if (!d.dictionary) { t.skip('NO MEDIDO: esta máquina no tiene /usr/share/dict/words (el caso sin diccionario es T4)'); return; }
  const guardarTodo = d.isSpanish(`${W.guardar}-${W.todo}`);
  assert.ok(guardarTodo.spanish, `--${W.guardar}-${W.todo} tiene que contar`);
  assert.ok(guardarTodo.words.includes(W.guardar), `${W.guardar} no está en la lista y no es inglés: cuenta por el diccionario`);
  assert.ok(d.isSpanish(W.pedidos).spanish, `${W.pedidos} (plural de una de words) tiene que contar`);
  assert.ok(!d.isSpanish('es2022').spanish, 'es2022 no cuenta: «es» es ambigua y está sola');
  assert.ok(!d.isSpanish(W.para).spanish, `--${W.para} sola no cuenta`);
  assert.ok(d.isSpanish(`${W.lista}-${W.de}-${W.tareas}`).spanish, 'lista-de-tareas cuenta');
  assert.ok(!d.isSpanish('dry-run').spanish, 'dry-run es inglés');
  assert.ok(!d.isSpanish('TYCON_NO_JSON').spanish, 'tycon y json están permitidas; no, en inglés');
  assert.ok(!d.isSpanish('id-ok').spanish, 'una sigla de menos de 3 letras no cuenta por diccionario');
  assert.ok(d.isSpanish(`${W.sin}-${W.copia}`).spanish, 'sin-copia cuenta: la ambigua va con otra castellana');
  assert.ok(d.isSpanish(`numer${'ación'}`).spanish, 'una palabra con acento cuenta');
});

test('T26 SpanishNames_Tokens_Sha256IsNotAWord @story-8.98 @ac-4 — un sha256 entero (las firmas del dueño se llaman así) no se parte en palabras', () => {
  const sha256 = '5c9d43741acc762b17188bfa883c78003e247220ecc26a1453b17ca35c02e1f5';
  assert.deepStrictEqual(sn.tokens(`.github/control-changes/${sha256}.json`), ['github', 'control', 'changes', 'json']);
  assert.deepStrictEqual(sn.tokens(`x-${'a1'.repeat(20)}`), ['x'], 'un sha1 de 40 tampoco, como antes');
  assert.ok(sn.tokens(`x-${'a1'.repeat(33)}`).length > 1, 'más de 64 no es un sha: se sigue partiendo');
});

// ── T4 · sin diccionario ─────────────────────────────────────────────────────────────────────────────────────────
test('T4 SpanishNames_Detect_NoDictionaryFallsBackAndSays — sin /usr/share/dict/words usa sólo words, y lo dice', () => {
  const words = sn.loadWords(JSON.stringify(LAB_WORDS), 'lab.json');
  const d = sn.makeDetector(words, { dictPath: path.join(os.tmpdir(), 'no-existe-este-diccionario') });
  assert.strictEqual(d.dictionary, false);
  assert.ok(!d.isSpanish(W.limpiar).spanish, 'sin diccionario, una palabra fuera de la lista no cuenta');
  assert.ok(d.isSpanish(`${W.cargar}-x`).spanish, 'las de la lista siguen contando');
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-t4-'));
  try {
    git(lab, ['init', '-q', '-b', 'main']);
    write(lab, { 'scripts/lib/spanish-words.json': LAB_WORDS, 'scripts/x.js': '// nada\n' });
    git(lab, ['add', '-A']);
    git(lab, ['commit', '-q', '-m', 'base']);
    const r = run(['--count', '--json', '--repo', lab], { TYCON_SPANISH_NAMES_DICTIONARY: path.join(os.tmpdir(), 'no-existe-este-diccionario') });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /sin diccionario/);
  } finally { fs.rmSync(lab, { recursive: true, force: true }); }
});

// ── el extractor: qué se mira de cada archivo ────────────────────────────────────────────────────────────────────
test('Extractor_KindsAndCategories — ejecutables, configuración y pruebas; nunca .md ni casos del banco; las seis categorías', () => {
  assert.strictEqual(sn.kindOf('scripts/a.js', ''), 'executable');
  assert.strictEqual(sn.kindOf('scripts/sin-extension', '#!/usr/bin/env bash\n'), 'executable');
  assert.strictEqual(sn.kindOf('.githooks/pre-commit', 'x'), 'executable');
  assert.strictEqual(sn.kindOf('scripts/tests/a.test.js', ''), 'test');
  assert.strictEqual(sn.kindOf('scripts/a.json', '{}'), 'config');
  assert.strictEqual(sn.kindOf('guides/a.md', ''), null);
  assert.strictEqual(sn.kindOf('scripts/controls-bench/cases/hooks/a.json', '{}'), null);

  const opt = `--${W.sin}-${W.copia}`;
  const js = [
    `const x = process.argv.includes('${opt}');`,
    `if (process.env.TYCON_NO_${W.bajar.toUpperCase()}) {}`,
    `const y = process.env['OTHER_${W.datos.toUpperCase()}'];`,
    'switch (cmd) {',
    `  case '${W.limpiar}': break;`,
    "  case 'ok': { const z = { a: 1 }; break; }",
    '}',
    `if (cmd === '${W.cargar}') {}`,
    "switch (kind) { case 'otro': break; }",
  ].join('\n');
  const got = sn.extract('scripts/a.js', js, { schemaFiles: [] });
  const has = (category, name) => got.some((f) => f.category === category && f.name === name);
  assert.ok(has('option', opt.slice(2)), 'la opción');
  assert.ok(has('env', `TYCON_NO_${W.bajar.toUpperCase()}`), 'la variable TYCON_ leída');
  assert.ok(has('env', `OTHER_${W.datos.toUpperCase()}`), 'la variable leída con corchetes');
  assert.ok(has('subcommand', W.limpiar) && has('subcommand', 'ok') && has('subcommand', W.cargar), 'los subcomandos del despacho');
  assert.ok(!has('subcommand', 'otro'), 'un switch sobre otra cosa no es un subcomando');
  assert.strictEqual(got.find((f) => f.name === W.limpiar).line, 5);

  const sh = [
    '#!/usr/bin/env bash',
    `echo "\${SALIDA_${W.datos.toUpperCase()}:-}"`,
    `export ${W.motivo.toUpperCase()}_X=1`,
    `echo "$TYCON_${W.hoy.toUpperCase()}"`,
    'case "${1:-}" in',
    `  ${W.limpiar}|borrar) echo x ;;`,
    '  --other) echo y ;;',
    'esac',
  ].join('\n');
  const gotSh = sn.extract('scripts/a.sh', sh, { schemaFiles: [] });
  const hasSh = (category, name) => gotSh.some((f) => f.category === category && f.name === name);
  assert.ok(!hasSh('env', `SALIDA_${W.datos.toUpperCase()}`), 'una variable local de shell no es de entorno');
  assert.ok(hasSh('env', `${W.motivo.toUpperCase()}_X`), 'una exportada sí');
  assert.ok(hasSh('env', `TYCON_${W.hoy.toUpperCase()}`), 'una TYCON_ sí');
  assert.ok(hasSh('subcommand', W.limpiar) && hasSh('subcommand', 'borrar'), 'los subcomandos del case de bash');
  assert.ok(!hasSh('subcommand', '--other'),'una opción del case no es subcomando');

  const cfg = JSON.stringify({ [W.motivo]: 1, nested: [{ [W.datos]: 2 }], 'scripts/a/b.json': 3 });
  const inSchema = sn.extract('scripts/config/settings.json', cfg, { schemaFiles: ['scripts/config/settings.json'] });
  assert.deepStrictEqual(inSchema.map((f) => f.name).sort(), [W.datos, W.motivo, 'nested'].sort(), 'claves, sin las que son rutas');
  assert.deepStrictEqual(sn.extract('scripts/otra.json', cfg, { schemaFiles: ['scripts/config/settings.json'] }), [], 'fuera de schemaFiles, ninguna clave');

  // (d) los valores: sólo los que el mapa declara, en el archivo que los lee
  const map = { entries: [{ kind: 'value', old: `${W.cargar}-todo`, new: 'load-all', where: 'scripts/a.js' }] };
  const vals = sn.extract('scripts/a.js', `if (x === '${W.cargar}-todo') {}`, { schemaFiles: [], renames: map });
  assert.ok(vals.some((f) => f.category === 'value' && f.name === `${W.cargar}-todo`), 'el valor declarado');
  assert.deepStrictEqual(sn.extract('scripts/b.js', `if (x === '${W.cargar}-todo') {}`, { schemaFiles: [], renames: map }).filter((f) => f.category === 'value'), [], 'en otro archivo no');
  assert.deepStrictEqual(sn.pathNames('scripts/publishing/synthetic/x-y.test.js'), ['scripts', 'publishing', 'synthetic', 'x-y']);
});

test('AllowedPath_IgnoredInBrakeAndCount — una excepción por ruta (AC 2) apaga el freno y el conteo en esos archivos, no en otros', () => {
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-ruta-'));
  const withPath = JSON.parse(JSON.stringify(LAB_WORDS));
  withPath.allowed.push({ path: 'scripts/vendor/**', reason: 'código de un tercero: sus nombres no son nuestros' });
  const opt = `--${W.sin}-${W.copia}`;
  try {
    git(lab, ['init', '-q', '-b', 'main']);
    write(lab, { 'scripts/lib/spanish-words.json': withPath, 'scripts/x.js': '// x\n' });
    git(lab, ['add', '-A']);
    git(lab, ['commit', '-q', '-m', 'base']);
    write(lab, { 'scripts/vendor/tool.js': `const y = process.argv.includes('${opt}');\n` });
    git(lab, ['add', '-A']);
    let r = run(['--repo', lab]);
    assert.strictEqual(r.status, 0, `bajo una ruta permitida no frena: ${r.stderr}`);
    write(lab, { 'scripts/other.js': `const y = process.argv.includes('${opt}');\n` });
    git(lab, ['add', '-A']);
    r = run(['--repo', lab]);
    assert.strictEqual(r.status, 1, 'fuera de la ruta permitida sí frena');
    assert.match(r.stderr, /scripts\/other\.js/);
    assert.doesNotMatch(r.stderr, /scripts\/vendor\/tool\.js/);
    const words = sn.loadWords(JSON.stringify(withPath), 'lab.json');
    const det = sn.makeDetector(words, {});
    const text = `const y = process.argv.includes('${opt}');\n`;
    const c = sn.countFiles([{ source: 'arnes', rel: 'scripts/vendor/tool.js', text }, { source: 'arnes', rel: 'scripts/other.js', text }], words, det);
    assert.strictEqual(c.options, 1, 'el conteo tampoco cuenta lo de la ruta permitida (cuenta el de afuera)');
    const onlyVendor = sn.countFiles([{ source: 'arnes', rel: 'scripts/vendor/tool.js', text }], words, det);
    assert.strictEqual(onlyVendor.options, 0);
  } finally { fs.rmSync(lab, { recursive: true, force: true }); }
});

// ── casos de borde: cada caso es una prueba que un freno sin ellos fallaría ────────────────────────────────────────
test('Adversarial_Detector_PluralsAcronymsAndExactEnglish — plural castellano, siglas pegadas e inglés exacto', (t) => {
  const real = sn.loadWords(fs.readFileSync(WORDS, 'utf8'), 'scripts/lib/spanish-words.json');
  const d = sn.makeDetector(real, {});
  if (!d.dictionary) { t.skip('NO MEDIDO: sin /usr/share/dict/words'); return; }
  for (const w of ['erro' + 'res', 'versio' + 'nes', 'cana' + 'les', 'tota' + 'les']) assert.ok(d.isSpanish(w).spanish, `${w}: el -es castellano no vuelve inglesa la palabra`);
  for (const w of ['errors', 'versions', 'classes', 'matches']) assert.ok(!d.isSpanish(w).spanish, `${w} es inglés`);
  for (const w of ['indices', 'loss', 'tapas']) assert.ok(!d.isSpanish(w).spanish, `${w}: inglés exacto del diccionario, aunque su singular esté en words`);
  for (const w of ['HTMLParser', 'parseJSONFile', 'baseURLPath', 'getAPIKey', 'xmlHTTPTimeout']) assert.ok(!d.isSpanish(w).spanish, `${w}: una sigla pegada a una palabra se separa`);
  assert.deepStrictEqual(sn.tokens('xmlHTTPTimeout'), ['xml', 'HTTP', 'Timeout']);
});

test('Adversarial_Extractor_DispatchEnvAndComments — despachos anidados, switch sobre propiedad, llaves en textos, variables y comentarios', () => {
  const sub = (rel, text) => sn.extract(rel, text, { schemaFiles: [] }).filter((f) => f.category === 'subcommand').map((f) => f.name);
  const nested = ['#!/usr/bin/env bash', 'case "$1" in', '  run)', '    case "$2" in', '      a) echo a ;;', '    esac ;;', `  ${W.limpiar}) echo ;;`, 'esac'].join('\n');
  assert.deepStrictEqual(sub('scripts/a.sh', nested).sort(), ['run', W.limpiar].sort(), 'un case anidado no corta el despacho, y sus alternativas no son subcomandos');
  assert.deepStrictEqual(sub('scripts/a.js', `switch (a.cmd) { case '${W.limpiar}': break; case 'run': break; }`).sort(), [W.limpiar, 'run'].sort(), 'switch sobre a.cmd');
  const braces = `switch (cmd) { case 'ok': console.log('{'); break; /* } */ case '${W.cargar}': break; }\n// abre {`;
  assert.deepStrictEqual(sub('scripts/a.js', braces).sort(), ['ok', W.cargar].sort(), 'las llaves de textos y comentarios no cuentan');
  const env = (rel, text) => sn.extract(rel, text, { schemaFiles: [] }).filter((f) => f.category === 'env').map((f) => f.name);
  const V = `OTHER_${W.datos.toUpperCase()}`;
  assert.ok(env('scripts/a.js', `const { ${V}, B: c = 1 } = process.env;`).includes(V), 'desestructuración');
  assert.ok(env('scripts/a.js', `if ('${V}' in process.env) {}`).includes(V), "'X' in process.env");
  assert.ok(env('scripts/a.js', `const x = process.env?.${V};`).includes(V), 'process.env?.X');
  assert.ok(env('scripts/a.sh', `#!/usr/bin/env bash\n${V}=1\nexport ${V}\n`).includes(V), 'export X suelto');
  const opts = (rel, text) => sn.extract(rel, text, { schemaFiles: [] }).filter((f) => f.category === 'option').map((f) => f.name);
  const opt = `${W.sin}-${W.copia}`;
  assert.deepStrictEqual(opts('scripts/a.js', `// la vieja era --${opt}\nconst x = 1; /* --${opt} */`), [], 'una opción en un comentario de JS no cuenta');
  assert.deepStrictEqual(opts('scripts/a.sh', `#!/usr/bin/env bash\n# antes existía --${opt}\necho "#no-es-comentario"\n`), [], 'ni en un comentario de shell');
  assert.deepStrictEqual(opts('scripts/a.js', `const u = "http://x"; const y = process.argv.includes('--${opt}');`), [opt], 'la de verdad sí, y una URL no abre un comentario');
  assert.deepStrictEqual(opts('scripts/a.js', `let ${W.datos} = 3;\nwhile (${W.datos}) { --${W.datos}; }`), [], 'un pre-decremento no es una opción');
  assert.deepStrictEqual(opts('scripts/a.sh', `#!/usr/bin/env bash\n((--n))\ncase "$1" in\n  --${opt}) echo ;;\nesac`), [opt], 'en bash, ((--n)) no; la etiqueta de un case sí');
});

test('Adversarial_Brake_ShebangAmbiguousAndNoDictionary — shebang sin extensión conocida, ambigua nueva en el mismo commit', (t) => {
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-5b-'));
  const opt = `--${W.cargar}-${W.datos}`;
  try {
    git(lab, ['init', '-q', '-b', 'main']);
    write(lab, { 'scripts/lib/spanish-words.json': LAB_WORDS, 'scripts/x.js': '// x\n' });
    git(lab, ['add', '-A']);
    git(lab, ['commit', '-q', '-m', 'base']);
    write(lab, { 'scripts/tool.zsh': `#!/usr/bin/env zsh\necho ${opt}\n` });
    git(lab, ['add', '-A']);
    let r = run(['--repo', lab]);
    assert.strictEqual(r.status, 1, `un ejecutable por shebang con extensión rara también se mira: ${r.stderr}`);
    git(lab, ['rm', '-q', '--cached', 'scripts/tool.zsh']);
    fs.rmSync(path.join(lab, 'scripts/tool.zsh'));
    // la segunda mitad cuenta con el diccionario: la ambigua recién agregada no vale todavía, así que la palabra se
    // juzga por él (sin diccionario, una palabra fuera de la lista pasa por inglés — el caso T4)
    const dictPath = process.env.TYCON_SPANISH_NAMES_DICTIONARY || '/usr/share/dict/words';
    if (!sn.makeDetector(sn.loadWords(JSON.stringify(LAB_WORDS), 'lab.json'), { dictPath }).dictionary) {
      t.skip(`NO MEDIDO la ambigua nueva: esta máquina no tiene ${dictPath} (el shebang sí se midió)`); return;
    }
    const g = W.guardar;
    const amb = JSON.parse(JSON.stringify(LAB_WORDS));
    amb.ambiguous.push(g);
    write(lab, { 'scripts/lib/spanish-words.json': amb, 'scripts/new.js': `const y = process.argv.includes('--${g}-all');\n` });
    git(lab, ['add', '-A']);
    r = run(['--repo', lab]);
    assert.strictEqual(r.status, 1, `una ambigua nueva no vale en el mismo commit que la usa: ${r.stderr}`);
  } finally { fs.rmSync(lab, { recursive: true, force: true }); }
});

test('Exporter_CountErrorIsVisible— si el conteo no puede leer la lista, el --json del exportador lo dice (y el termómetro da rojo)', () => {
  const exporter = require(path.join(RAIZ, 'scripts', 'publishing', 'export.js'));
  const r = exporter.contarCastellano([], path.join(os.tmpdir(), 'no-existe-este-arnes'));
  assert.ok(r && typeof r.error === 'string' && /spanish-words\.json/.test(r.error), `esperaba { error } nombrando la lista: ${JSON.stringify(r)}`);
  assert.strictEqual(typeof r.total, 'undefined', 'sin cifras: el juez de exportador-real lo toma como «no trae spanishNames completo»');
  const ok = exporter.contarCastellano([{ fuente: 'arnes', ruta: 'scripts/x.js', datos: Buffer.from('// x\n') }]);
  assert.strictEqual(ok.total, 0);
});

test('Proposal_FromGlossary — la propuesta en inglés sólo cuando el glosario tiene todas las palabras', () => {
  const words = sn.loadWords(JSON.stringify(LAB_WORDS), 'lab.json');
  const d = sn.makeDetector(words, { dictPath: '/usr/share/dict/words' });
  assert.strictEqual(sn.propose(`${W.sin}-${W.copia}`, d, words), 'without-copy');
  assert.strictEqual(sn.propose(`TYCON_${W.cargar.toUpperCase()}_${W.datos.toUpperCase()}`, d, words), 'TYCON_LOAD_DATA');
  assert.strictEqual(sn.propose(`${W.motivo}-x`, d, words), null, 'motivo no está en el glosario');
});

test('Ceiling_RaisedOnlyWithNewWords — el techo en castellano sube sólo en el commit que suma palabras a words (AC 12)', () => {
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-techo-'));
  const ceiling = { nucleo: { files: 1, folders: 1, options: 1, subcommands: 0, values: 0, env: 0, keys: 0, total: 3 } };
  try {
    git(lab, ['init', '-q', '-b', 'main']);
    write(lab, { 'scripts/lib/spanish-words.json': LAB_WORDS, 'scripts/publishing/spanish-names-ceiling.json': ceiling, 'scripts/x.js': '// x\n' });
    git(lab, ['add', '-A']);
    git(lab, ['commit', '-q', '-m', 'base']);
    const up = JSON.parse(JSON.stringify(ceiling));
    up.nucleo.options = 2;
    write(lab, { 'scripts/publishing/spanish-names-ceiling.json': up });
    git(lab, ['add', '-A']);
    let r = run(['--repo', lab]);
    assert.strictEqual(r.status, 1, `sin palabras nuevas tiene que frenar: ${r.stderr}`);
    assert.match(r.stderr, /spanish-names-ceiling\.json.*nucleo\.options sube de 1 a 2/);
    const more = JSON.parse(JSON.stringify(LAB_WORDS));
    more.words.push('carpe' + 'ta');
    write(lab, { 'scripts/lib/spanish-words.json': more });
    git(lab, ['add', '-A']);
    r = run(['--repo', lab]);
    assert.strictEqual(r.status, 0, `con una palabra nueva en words el techo puede subir: ${r.stderr}`);
    const gone = JSON.parse(JSON.stringify(ceiling));
    delete gone.nucleo.total;
    write(lab, { 'scripts/publishing/spanish-names-ceiling.json': gone, 'scripts/lib/spanish-words.json': LAB_WORDS });
    git(lab, ['add', '-A']);
    r = run(['--repo', lab]);
    assert.strictEqual(r.status, 1, 'una cifra que desaparece también es subir');
  } finally { fs.rmSync(lab, { recursive: true, force: true }); }
});

test('B3a Ceiling_PackageRenamedByMap — pasar la clave del paquete a su nombre nuevo no es perder la cifra, si el mapa lo declara', () => {
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-techo-pkg-'));
  const OLD = 'nuc' + 'leo';   // armado por partes: el termómetro no cuenta los nombres de esta prueba
  const nums = { files: 1, folders: 1, options: 1, subcommands: 0, values: 0, env: 0, keys: 0, total: 3 };
  const entry = { kind: 'value', old: OLD, new: 'core', where: 'scripts/publishing/export.js', batch: 'lab', option: 'package' };
  // el mapa de una foto de antes de la mudanza del exportador nombra el valor con la ruta vieja del exportador, y la declara en su
  // entrada `file`: la ruta vieja sale del mapa real, nunca escrita acá (sin mapa, la copia pública, no hay variante vieja)
  const realMap = (() => { try { return JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'lib', 'renames.json'), 'utf8')); } catch (_) { return null; } })();
  const movedExporter = realMap && realMap.entries.find((x) => x && x.kind === 'file' && x.new === entry.where);
  try {
    git(lab, ['init', '-q', '-b', 'main']);
    write(lab, { 'scripts/lib/spanish-words.json': LAB_WORDS, 'scripts/publishing/spanish-names-ceiling.json': { [OLD]: nums }, 'scripts/x.js': '// x\n' });
    git(lab, ['add', '-A']);
    git(lab, ['commit', '-q', '-m', 'base']);
    write(lab, { 'scripts/publishing/spanish-names-ceiling.json': { core: nums } });
    git(lab, ['add', '-A']);
    let r = run(['--repo', lab]);
    assert.strictEqual(r.status, 1, `sin la entrada del mapa, la clave vieja que desaparece frena: ${r.stderr}`);
    write(lab, { 'scripts/lib/renames.json': { __about: 'lab', retire_after: null, entries: [entry] } });
    git(lab, ['add', '-A']);
    r = run(['--repo', lab]);
    assert.strictEqual(r.status, 0, `con la entrada value del paquete, el techo sigue con su nombre nuevo: ${r.stderr}`);
    if (movedExporter) {
      const before = { ...entry, where: movedExporter.old };
      write(lab, { 'scripts/lib/renames.json': { __about: 'lab', retire_after: null, entries: [before, { kind: 'file', old: movedExporter.old, new: movedExporter.new, batch: 'lab', callers: ['same-repo'] }] } });
      git(lab, ['add', '-A']);
      r = run(['--repo', lab]);
      assert.strictEqual(r.status, 0, `un mapa de antes de la mudanza del exportador también vale: ${r.stderr}`);
      write(lab, { 'scripts/lib/renames.json': { __about: 'lab', retire_after: null, entries: [before] } });
      git(lab, ['add', '-A']);
      r = run(['--repo', lab]);
      assert.strictEqual(r.status, 1, `control: sin la entrada file, la ruta vieja no es el exportador: ${r.stderr}`);
      write(lab, { 'scripts/lib/renames.json': { __about: 'lab', retire_after: null, entries: [entry] } });
    }
    write(lab, { 'scripts/publishing/spanish-names-ceiling.json': { core: { ...nums, options: 2 } } });
    git(lab, ['add', '-A']);
    r = run(['--repo', lab]);
    assert.strictEqual(r.status, 1, 'y subir bajo el nombre nuevo sigue frenando');
    assert.match(r.stderr, new RegExp(`${OLD}\\.options sube de 1 a 2`));
  } finally { fs.rmSync(lab, { recursive: true, force: true }); }
});

// ── el techo se muda con su carpeta ─────────────────────────────────────────────────────────────
// En el pull request de la mudanza (y en su pre-commit, contra HEAD) la base tiene el techo en la carpeta vieja. El freno
// lee primero la ruta nueva y, si en esa foto no está, la vieja que dice el mapa (la `folder` de su carpeta). Sin eso, el
// techo de la base no se ve y subirlo en la mudanza pasa callado. La ruta vieja sale del mapa real, nunca escrita acá.
const OLD_CEILING = (() => {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'lib', 'renames.json'), 'utf8'));
    const nu = sn.CEILING_PATH;
    const file = m.entries.find((x) => x && x.kind === 'file' && x.new === nu && typeof x.old === 'string');
    const folder = m.entries.filter((x) => x && x.kind === 'folder' && typeof x.new === 'string' && typeof x.old === 'string' && nu.startsWith(`${x.new}/`))
      .sort((a, b) => b.new.length - a.new.length)[0];
    const old = file ? file.old : folder ? `${folder.old}/${nu.slice(folder.new.length + 1)}` : null;
    return old && old !== nu ? old : null;
  } catch (_) {
    return null;
  }
})();
const CEILING_NUMS = { files: 1, folders: 1, options: 1, subcommands: 0, values: 0, env: 0, keys: 0, total: 3 };

test('SpanishNames_BaseCeilingUnderOldFolder_ReadsItViaTheMap — la base con el techo en la carpeta vieja: se lee por el mapa', { skip: OLD_CEILING ? false : 'sin el mapa de renombres no hay ruta vieja' }, () => {
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-techo-viejo-'));
  try {
    git(lab, ['init', '-q', '-b', 'main']);
    write(lab, { 'scripts/lib/spanish-words.json': LAB_WORDS, [OLD_CEILING]: { core: CEILING_NUMS }, 'scripts/x.js': '// x\n' });
    git(lab, ['add', '-A']);
    git(lab, ['commit', '-q', '-m', 'base: el techo en la carpeta vieja']);
    const base = git(lab, ['rev-parse', 'HEAD']);
    fs.mkdirSync(path.dirname(path.join(lab, sn.CEILING_PATH)), { recursive: true });
    git(lab, ['mv', OLD_CEILING, sn.CEILING_PATH]);
    let r = run(['--repo', lab]);
    assert.strictEqual(r.status, 0, `la mudanza sola no sube nada: ${r.stderr}`);
    write(lab, { [sn.CEILING_PATH]: { core: { ...CEILING_NUMS, options: 2 } } });
    git(lab, ['add', '-A']);
    r = run(['--repo', lab]);
    assert.strictEqual(r.status, 1, `el techo de la base se lee por su ruta vieja: subirlo en la mudanza frena: ${r.stderr}`);
    assert.match(r.stderr, /spanish-names-ceiling\.json.*core\.options sube de 1 a 2/);
    git(lab, ['commit', '-q', '-m', 'la mudanza con el techo más alto']);
    r = run(['--repo', lab, '--range', `${base}...HEAD`]);
    assert.strictEqual(r.status, 1, `lo mismo por --range, como lo mira el pull request: ${r.stderr}`);
    assert.match(r.stderr, /core\.options sube de 1 a 2/);
  } finally { fs.rmSync(lab, { recursive: true, force: true }); }
});

// Con la PUNTA del rango de antes de la mudanza, el techo está en la carpeta vieja también en
// la punta: subirlo ahí frena igual (repetir un rango histórico con el código actual).
test('SpanishNames_TipCeilingUnderOldFolder_StillBlocks — un rango que termina antes de la mudanza sigue viendo el techo', { skip: OLD_CEILING ? false : 'sin el mapa de renombres no hay ruta vieja' }, () => {
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-techo-punta-'));
  try {
    git(lab, ['init', '-q', '-b', 'main']);
    write(lab, { 'scripts/lib/spanish-words.json': LAB_WORDS, [OLD_CEILING]: { core: CEILING_NUMS }, 'scripts/x.js': '// x\n' });
    git(lab, ['add', '-A']);
    git(lab, ['commit', '-q', '-m', 'base: el techo en la carpeta vieja']);
    const base = git(lab, ['rev-parse', 'HEAD']);
    write(lab, { [OLD_CEILING]: { core: { ...CEILING_NUMS, options: 2 } } });
    git(lab, ['add', '-A']);
    git(lab, ['commit', '-q', '-m', 'el techo más alto, todavía en la carpeta vieja']);
    const r = run(['--repo', lab, '--range', `${base}...HEAD`]);
    assert.strictEqual(r.status, 1, `subir el techo en la carpeta vieja frena igual: ${r.stderr}`);
    assert.match(r.stderr, /core\.options sube de 1 a 2/);
  } finally { fs.rmSync(lab, { recursive: true, force: true }); }
});

test('SpanishNames_BaseCeilingUnderNewFolder_ReadsTheNewOne — con las dos rutas en la base, manda la nueva',{ skip: OLD_CEILING ? false : 'sin el mapa de renombres no hay ruta vieja' }, () => {
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-techo-nuevo-'));
  try {
    git(lab, ['init', '-q', '-b', 'main']);
    // una copia vieja y más alta que quedó al lado: si el freno la leyera, subir la nueva de 1 a 2 sería bajar
    write(lab, {
      'scripts/lib/spanish-words.json': LAB_WORDS, [sn.CEILING_PATH]: { core: CEILING_NUMS },
      [OLD_CEILING]: { core: { ...CEILING_NUMS, options: 99 } }, 'scripts/x.js': '// x\n',
    });
    git(lab, ['add', '-A']);
    git(lab, ['commit', '-q', '-m', 'base: el techo en la carpeta nueva, y una copia vieja']);
    const base = git(lab, ['rev-parse', 'HEAD']);
    write(lab, { [sn.CEILING_PATH]: { core: { ...CEILING_NUMS, options: 2 } } });
    git(lab, ['add', '-A']);
    let r = run(['--repo', lab]);
    assert.strictEqual(r.status, 1, `el techo de la base es el de la ruta nueva: ${r.stderr}`);
    assert.match(r.stderr, /core\.options sube de 1 a 2/);
    git(lab, ['commit', '-q', '-m', 'el techo más alto']);
    r = run(['--repo', lab, '--range', `${base}...HEAD`]);
    assert.strictEqual(r.status, 1, r.stderr);
  } finally { fs.rmSync(lab, { recursive: true, force: true }); }
});

// ── --stale-mentions y las claves: lo que se escribe igual pero no es la clave ─────────────────
// Una clave vieja cuenta como clave JSON o en prosa; no cuenta en otro .json, en una línea de un esquema ajeno DECLARADO
// (FOREIGN_SCHEMAS: una entrada de suites.json, la tabla de reemplazos), como «x» privado (la tabla privada) ni, en
// prosa, cuando es el id de una transformación. Las claves de los esquemas ajenos salen de la lista del script.
test('D1 StaleKeys_OtherSchemaPrivateAndTransformationIds — positivos y negativos de cada regla', () => {
  const q = (k) => `"${k}"`;
  const lab = (old, nu) => ({ kind: 'key', old, new: nu, where: 'scripts/lab/lab.json' });
  const [m, d] = sn.keyMatchers([lab(W.motivo, 'reason'), lab(W.datos, 'data')], { ids: [W.datos] });
  // positivos
  assert.ok(m.test(`{ ${q(W.motivo)}: "x", "glob": "y" }`, 'scripts/x.js'), 'la clave vieja con hermanas de su mismo esquema');
  assert.ok(m.test(`  ${q(W.motivo)}: "x"`, 'scripts/lab/lab.json'), 'en su propio .json');
  assert.ok(m.test(`un «${W.motivo}» de la lista`, 'guides/x.md'), 'en prosa');
  assert.ok(d.test(`  ${q(W.datos)}: 1`, 'scripts/x.js'), 'la que también es un id cuenta en su forma JSON');
  // negativos
  assert.ok(!m.test(`  ${q(W.motivo)}: "x"`, 'scripts/tests/fixtures/otro.json'), 'una clave de otro .json');
  assert.ok(!m.test(`un «${W.motivo}» privado`, 'guides/x.md'), 'la de la tabla privada');
  assert.ok(!m.test(`los \`${W.motivo}\` PRIVADOS`, 'guides/x.md'), 'la de la tabla privada, en mayúsculas');
  assert.ok(!d.test(`la transformación \`${W.datos}\``, 'guides/x.md'), 'en prosa, el id de una transformación');
  // cada esquema ajeno declarado: con su clave propia en la línea, su clave no cuenta; sin ella, sí
  assert.ok(sn.FOREIGN_SCHEMAS.length >= 2, 'los dos esquemas ajenos de hoy: suites.json y la tabla de reemplazos');
  for (const s of sn.FOREIGN_SCHEMAS) {
    for (const key of s.keys) {
      const [f] = sn.keyMatchers([lab(key, 'nuevo')]);
      assert.ok(!f.test(`{ ${q(key)}: "x", ${q(s.marker)}: [] }`, 'scripts/x.js'), `${s.what}: «${key}» con «${s.marker}» en la línea es suya`);
      assert.ok(f.test(`{ ${q(key)}: "x", "glob": [] }`, 'scripts/x.js'), `${s.what}: «${key}» sin «${s.marker}» cuenta`);
    }
  }
  // un esquema ajeno no exime una clave que no es suya, aunque su clave propia esté en la línea
  assert.ok(m.test(`{ ${q(W.motivo)}: "x", ${q(sn.FOREIGN_SCHEMAS[0].marker)}: [] }`, 'scripts/x.js'));
});

// La regla de «otro esquema» no puede tomar por clave cualquier `"x":` de la línea —datos (nombres de bloques), textos
// dentro de un string y ternarios—: con el .json de la clave legible y sin esas «claves», dejaría de contar menciones
// viejas reales. Se arma como una sonda: un arnés de laboratorio con su mapa, el .json de las claves (legible, con sus claves nuevas) y los
// archivos que lo nombran; --stale-mentions de punta a punta. Con los esquemas ajenos declarados, todas cuentan.
test('D1 false-negative-classification-2 + algorithmic-correctness-1 — datos, textos y ternarios no esconden la clave vieja', () => {
  const dirs = [];
  const repo = (files) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-d1-fnc2-'));
    dirs.push(d);
    git(d, ['init', '-q', '-b', 'main']);
    write(d, files);
    git(d, ['add', '-A']);
    git(d, ['commit', '-q', '-m', 'lab']);
    return d;
  };
  try {
    const where = 'scripts/lab/lab.json';
    const entries = [
      { kind: 'key', old: W.motivo, new: 'reason', where, batch: 'lab' },
      { kind: 'key', old: W.datos, new: 'data', where, batch: 'lab' },
    ];
    const lines = {
      'guides/a.md': [
        'La configuración vive en scripts/lab/lab.json.',
        `{ "glob": "x/**", "${W.motivo}": "el cliente 'acme': privado" }`,
        `"${W.motivo}": "valor con \\"cita\\": adentro"`,
      ],
      'scripts/x.sh': [
        '# escribe scripts/lab/lab.json',
        `printf '{ "${W.datos}": { "lab": 10 } }\\n' > scripts/lab/lab.json`,
        `x = cond ? "a" : "b"; printf '{ "${W.datos}": 1 }' > scripts/lab/lab.json`,
        `"${W.motivo}": cond ? 'a' : 'b'`,
      ],
    };
    const arnes = repo({
      'scripts/lib/renames.json': { __about: 'mapa de laboratorio', retire_after: null, entries },
      // legible y sin «lab», «acme», «cita» ni «a»: lo que una regla laxa tomaría por claves ajenas
      [where]: { glob: 'x/**', reason: 'r', data: { otro: 1 } },
      ...Object.fromEntries(Object.entries(lines).map(([f, ls]) => [f, `${ls.join('\n')}\n`])),
    });
    const skills = repo({ 'README.md': 'nada\n' });
    const r = run(['--stale-mentions', '--json', '--repo', arnes], { TYCON_SKILLS_DIR: skills });
    assert.strictEqual(r.status, 1, `las menciones viejas cuentan (rc ${r.status})\n${r.stdout}\n${r.stderr}`);
    const found = new Set(JSON.parse(r.stdout).findings.map((f) => `${f.rel}:${f.line}`));
    for (const [f, n, why] of [['guides/a.md', 2, 'una cita con «:» dentro de un valor'], ['guides/a.md', 3, 'una cita escapada dentro de un valor'],
      ['scripts/x.sh', 2, 'un nombre de bloque (dato) al lado'], ['scripts/x.sh', 3, 'un ternario antes'], ['scripts/x.sh', 4, 'un ternario después']]) {
      assert.ok(found.has(`${f}:${n}`), `${why}: ${f}:${n} no se contó\n${r.stdout}`);
    }
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

// ── T5 · el conteo sobre los shas de la medición ─────────────────────────────────────────────────────────────────
const MEASURED = { arnes: '8ac1904', 'agent-skills': '42c77f0' };
// La columna «corregida» de la medición, re-medida con el freno (lista corta de ambiguas, sin .md ni
// casos del banco, subcomandos del despacho, claves sólo de schemaFiles). Si cambia la lista de palabras, se re-mide y se
// corrigen juntas la medición y esta tabla. `schemaFiles` suma los archivos cuyas claves son esquema puro; en el núcleo de
// la medición eso son 3 claves más (`adapters/codex/hooks.json` 2, `build/equivalences.json` 1). `sin`, `solo`, `vista` y
// `de` son castellanas (no ambiguas), y en los commits de la medición cuenta lo que la lista corta deja afuera a propósito:
// el freno de pull requests y su prueba (ejecutables 87, pruebas 101), su interruptor (variables 116) y cinco opciones
// —la vista, las dos «local», el alias de otra máquina y la de instalar sin permisos de administrador— (opciones 123,
// 119 fuera de pruebas). La que es sólo `en` sigue afuera.
const CORRECTED = { executables: 87, tests: 101, folders: 5, options: 123, optionsOutsideTests: 119, subcommands: 49, env: 116, keys: 47 };

test('T5 SpanishNames_Count_MatchesCorrectedMeasurement — --count --json sobre los shas de la medición da la columna «corregida»', (t) => {
  const skills = require(path.join(RAIZ, 'scripts', 'lib', 'skills-dir.js')).resolveSkillsDirs(process.env.TYCON_SKILLS_DIR || '').repo;
  const has = (dir, sha) => spawnSync('git', ['-C', dir, 'cat-file', '-e', `${sha}^{commit}`], { env: cleanEnv() }).status === 0;
  if (!fs.existsSync(skills) || !has(RAIZ, MEASURED.arnes) || !has(skills, MEASURED['agent-skills'])) {
    t.skip(`NO MEDIDO: faltan los commits de la medición (${MEASURED.arnes} en el arnés, ${MEASURED['agent-skills']} en ${skills}) — un clon superficial no los trae`);
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-t5-'));
  const wa = path.join(tmp, 'arnes');
  const ws = path.join(tmp, 'skills');
  try {
    git(RAIZ, ['worktree', 'add', '-q', '--detach', wa, MEASURED.arnes]);
    git(skills, ['worktree', 'add', '-q', '--detach', ws, MEASURED['agent-skills']]);
    const r = run(['--count', '--json', '--repo', wa, '--words', WORDS], { TYCON_SKILLS_DIR: ws });
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    // las cifras valen con el diccionario inglés: sin él (Windows, un contenedor) el conteo es otro, y eso no es un rojo
    if (!out.dictionary) { t.skip('NO MEDIDO: esta máquina no tiene /usr/share/dict/words — las cifras de la story se midieron con él'); return; }
    const n = out.packages.nucleo;
    assert.ok(n, `sin el paquete nucleo: ${r.stdout.slice(0, 300)}`);
    assert.strictEqual(n.detail.executables, CORRECTED.executables, 'ejecutables fuera de pruebas');
    assert.strictEqual(n.detail.tests, CORRECTED.tests, 'archivos de prueba');
    assert.strictEqual(n.folders, CORRECTED.folders, 'carpetas');
    assert.strictEqual(n.options, CORRECTED.options, 'opciones');
    assert.strictEqual(n.detail.optionsOutsideTests, CORRECTED.optionsOutsideTests, 'opciones fuera de pruebas');
    assert.strictEqual(n.subcommands, CORRECTED.subcommands, 'subcomandos');
    assert.strictEqual(n.env, CORRECTED.env, 'variables');
    assert.strictEqual(n.keys, CORRECTED.keys, 'claves');
    assert.strictEqual(n.total, n.files + n.folders + n.options + n.subcommands + n.values + n.env + n.keys);
  } finally {
    spawnSync('git', ['-C', RAIZ, 'worktree', 'remove', '--force', wa], { env: cleanEnv() });
    spawnSync('git', ['-C', skills, 'worktree', 'remove', '--force', ws], { env: cleanEnv() });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── el nombre que sólo cambia de carpeta (T53) y el borde de la ruta vieja (T3) ───────────────
// T53: un archivo o carpeta que sólo se muda conserva su nombre —también uno en castellano que se decidió dejar así—:
// del `new` se juzgan sólo los segmentos que el `old` no tenía. Si el nombre cambia, el nombre nuevo se juzga entero.
test('T53 Restructure_CheckMap_FolderOnlyMoveKeepsName — sólo se juzgan en castellano los segmentos nuevos del destino', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-t53-'));
  const carpeta = 'carp' + 'eta';
  const tablero = 'tabl' + 'ero';
  const name = `${W.datos}-lab`;
  write(repo, { [`scripts/${name}.js`]: '#!/usr/bin/env node\n', [`scripts/${tablero}/a.js`]: '#!/usr/bin/env node\n' });
  const check = (entry) => {
    const f = path.join(repo, `map-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify({ __about: 'mapa de laboratorio', retire_after: null, entries: [{ batch: 'lab', callers: ['same-repo'], ...entry }] }));
    return run(['--check-map', '--map', f, '--repo', repo]);
  };
  try {
    const cases = [
      ['file: sólo cambia a una carpeta en inglés', { kind: 'file', old: `scripts/${name}.js`, new: `scripts/tools/${name}.js` }, 0],
      ['file: el mismo nombre a una carpeta nueva en castellano', { kind: 'file', old: `scripts/${name}.js`, new: `scripts/${carpeta}/${name}.js` }, 2],
      ['file: además cambia el nombre a otro en castellano', { kind: 'file', old: `scripts/${name}.js`, new: `scripts/tools/${W.copia}-lab.js` }, 2],
      // un archivo que cambia de nombre se juzga ENTERO, también la carpeta en castellano que ya tenía
      ['file: cambia el nombre a uno en inglés dentro de una carpeta en castellano que ya estaba', { kind: 'file', old: `scripts/${tablero}/a.js`, new: `scripts/${tablero}/report-lab.js` }, 2],
      ['folder: sólo cambia a una carpeta en inglés', { kind: 'folder', old: `scripts/${tablero}`, new: `scripts/nightly/${tablero}` }, 0],
      ['folder: a una carpeta nueva en castellano', { kind: 'folder', old: `scripts/${tablero}`, new: `scripts/${carpeta}/${tablero}` }, 2],
    ];
    for (const [what, entry, want] of cases) {
      const r = check(entry);
      assert.strictEqual(r.status, want, `${what}: sale ${want} (salió ${r.status}: ${r.stderr})`);
      if (want) assert.match(r.stderr, /está en castellano/, `${what}: por el castellano, no por otra cosa`);
    }
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// T3: una entrada que sólo agrega carpetas delante (`x.yml` → `pipelines/x.yml`) tiene el nombre viejo DENTRO de la ruta
// nueva: esa mención no es vieja. La misma ruta suelta, detrás de un comando o al final de una absoluta, sí.
test('T3 Restructure_StaleMentions_BasenameInsideNewPathNotStale — la ruta nueva no cuenta como mención de la vieja', () => {
  const dirs = [];
  const repo = (files) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-t3-'));
    dirs.push(d);
    git(d, ['init', '-q', '-b', 'main']);
    write(d, files);
    git(d, ['add', '-A']);
    git(d, ['commit', '-q', '-m', 'lab']);
    return d;
  };
  try {
    const entries = [
      { kind: 'file', old: 'azure-pipelines-banco-lab.yml', new: 'pipelines/azure-pipelines-banco-lab.yml', batch: 'lab', callers: ['ado'] },
      { kind: 'file', old: 'scripts/x-lab.js', new: 'scripts/lib/x-lab.js', batch: 'lab', callers: ['same-repo'] },
    ];
    const arnes = repo({
      'scripts/lib/renames.json': { __about: 'mapa de laboratorio', retire_after: null, entries },
      'pipelines/azure-pipelines-banco-lab.yml': 'trigger: none\n',
      // el archivo que sólo cambia de carpeta se mira también a sí mismo: su «Uso:» con la ruta vieja es una instrucción
      // viva (la exclusión de la propia ruta es para la cabecera de un archivo RENOMBRADO)
      'scripts/lib/x-lab.js': '// Uso: node scripts/x-lab.js\nmodule.exports = 1;\n',
      'guides/clean.md': 'Ver `pipelines/azure-pipelines-banco-lab.yml` y `scripts/lib/x-lab.js`.\nTambién /repo/tcg/pipelines/azure-pipelines-banco-lab.yml y bash pipelines/azure-pipelines-banco-lab.yml\nWindows: pwsh ~\\repo\\scripts\\lib\\x-lab.js\n',
      'guides/stale.md': 'bash azure-pipelines-banco-lab.yml\nnode scripts/x-lab.js\n',
      'guides/absolute.md': 'El de antes: /repo/tcg/azure-pipelines-banco-lab.yml y /repo/tcg/scripts/x-lab.js\n',
      // la forma de Windows (con barras invertidas) también es una mención
      'guides/windows.md': 'pwsh ~\\.claude\\tycon-harness\\scripts\\x-lab.js\n.\\scripts\\x-lab.js\n',
    });
    const skills = repo({ 'README.md': 'nada\n' });
    const r = run(['--stale-mentions', '--json', '--repo', arnes], { TYCON_SKILLS_DIR: skills });
    assert.strictEqual(r.status, 1, `las menciones viejas cuentan (rc ${r.status})\n${r.stdout}\n${r.stderr}`);
    const found = JSON.parse(r.stdout).findings.map((f) => `${f.rel}:${f.line} ${f.old}`).sort();
    assert.deepStrictEqual(found, [
      'guides/absolute.md:1 azure-pipelines-banco-lab.yml',
      'guides/absolute.md:1 scripts/x-lab.js',
      'guides/stale.md:1 azure-pipelines-banco-lab.yml',
      'guides/stale.md:2 scripts/x-lab.js',
      'guides/windows.md:1 scripts/x-lab.js',
      'guides/windows.md:2 scripts/x-lab.js',
      'scripts/lib/x-lab.js:1 scripts/x-lab.js',
    ], 'la ruta nueva (relativa o absoluta, también con «\\») no cuenta; la vieja suelta, detrás de un comando, al final de una absoluta, con «\\» o dentro del propio archivo movido, sí');
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

// ── la barra que completa OTRA ruta real (T3b) y la carpeta de un solo pedazo (T3c) ─────────
// T3b: una carpeta de la raíz que se muda a `inbox/` (la de los instintos) se llama igual que el último pedazo
// de `scripts/<misma>/`, una carpeta de verdad que nació en la misma mudanza. Detrás de esa barra no es la vieja: es otra
// ruta del repo que existe. La vieja suelta, al final de una absoluta o detrás de `$TCG/` sigue contando. Nombres de
// laboratorio (`notions`): la prueba no escribe el nombre viejo real, que el propio control contaría.
const t3Repo = (dirs, prefix) => (files) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  git(d, ['init', '-q', '-b', 'main']);
  write(d, files);
  git(d, ['add', '-A']);
  git(d, ['commit', '-q', '-m', 'lab']);
  return d;
};
const staleFound = (arnes, skills) => {
  const r = run(['--stale-mentions', '--json', '--repo', arnes], { TYCON_SKILLS_DIR: skills });
  assert.strictEqual(r.status, 1, `las menciones viejas cuentan (rc ${r.status})\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout).findings.map((f) => `${f.rel}:${f.line} ${f.old}`).sort();
};
const T3_ENTRIES = [
  { kind: 'folder', old: 'notions', new: 'inbox/notions', batch: 'lab', callers: ['same-repo'] },
  { kind: 'file', old: 'scripts/x.js', new: 'scripts/notions/x.js', batch: 'lab', callers: ['same-repo'] },
];
test('T3b Restructure_StaleMentions_SlashCompletesAnotherRealPath — una barra que arma otra ruta real del repo no es mención vieja', () => {
  const dirs = [];
  const repo = t3Repo(dirs, 'sn-t3b-');
  try {
    const arnes = repo({
      'scripts/lib/renames.json': { __about: 'mapa de laboratorio', retire_after: null, entries: T3_ENTRIES },
      'inbox/notions/pending/.gitkeep': '',
      'scripts/notions/x.js': 'module.exports = 1;\n',
      'guides/clean.md': 'Corre `node scripts/notions/x.js` y deja lo suyo en `inbox/notions/pending/`.\n'
        + 'Absoluta: /home/x/repo/scripts/notions/x.js\nWindows: scripts\\notions\\x.js\n'
        // la barra escapada de una expresión regular (`\/`) es una sola barra: arma la misma ruta
        + 'Zona: /^inbox\\/notions\\/archived\\//, /^scripts\\/notions\\//\n',
      'guides/stale.md': 'Lo deja en notions/pending/.\nAbsoluta: /home/x/repo/notions/pending/\nO bien: ls $TCG/notions/\n',
    });
    const skills = repo({ 'README.md': 'nada\n' });
    assert.deepStrictEqual(staleFound(arnes, skills), [
      'guides/stale.md:1 notions',
      'guides/stale.md:2 notions',
      'guides/stale.md:3 notions',
    ], '`scripts/notions/…` (relativa, absoluta o con «\\») e `inbox/notions/` no cuentan; la vieja suelta, al final de una absoluta o detrás de $TCG/ sí');
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

// T3c: una carpeta cuyo nombre viejo es de UN solo pedazo es también una palabra común («propone notions», «accionar
// notions»): cuenta sólo escrita como ruta, con una barra detrás (`notions/pending/`, `notions\pending\`). La palabra suelta
// es prosa. Las de varios pedazos siguen como en T3.
test('T3c Restructure_StaleMentions_SingleSegmentFolderOnlyAsPath — la palabra suelta no es la carpeta vieja; con barra detrás sí', () => {
  const dirs = [];
  const repo = t3Repo(dirs, 'sn-t3c-');
  try {
    const arnes = repo({
      'scripts/lib/renames.json': { __about: 'mapa de laboratorio', retire_after: null, entries: T3_ENTRIES },
      'inbox/notions/pending/.gitkeep': '',
      'scripts/notions/x.js': 'module.exports = 1;\n',
      'guides/prose.md': 'El grabador propone notions y las deja para el equipo.\ndescription: Revisar y accionar notions\nLas `notions` aceptadas se promueven.\n',
      'guides/stale.md': 'ls notions/pending/\nWindows: dir notions\\pending\\a.yaml\n',
    });
    const skills = repo({ 'README.md': 'nada\n' });
    assert.deepStrictEqual(staleFound(arnes, skills), [
      'guides/stale.md:1 notions',
      'guides/stale.md:2 notions',
    ], 'la palabra suelta (también entre acentos graves) no cuenta; la carpeta con barra detrás, «/» o «\\», sí');
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

// ── restos en la carpeta vieja ───────────────────────────────────────────────────────────────────────
// T3d: tras el pull de la mudanza, la carpeta vieja queda en cada máquina con lo que git nunca
// versionó (el log del grabador, sus descartados, un `.DS_Store`). Eso no la vuelve «real»: la entrada sigue mudada, las
// menciones viejas se cuentan (nunca un verde callado) y --check-map no ve un choque. Igual si esos restos quedan
// ignorados por un `.gitignore` de la raíz. Un archivo versionado en la vieja sí la vuelve real (no mudada).
test('T3d R2Adversarial_StaleMentionsAndCheckMap_LeftoversInOldFolder — adversarial R2: los restos sin versionar no callan el control', () => {
  const dirs = [];
  const repo = t3Repo(dirs, 'sn-t3d-');
  try {
    const arnes = repo({
      'scripts/lib/renames.json': { __about: 'mapa de laboratorio', retire_after: null, entries: T3_ENTRIES },
      'inbox/notions/pending/.gitkeep': '',
      'scripts/notions/x.js': 'module.exports = 1;\n',
      'guides/stale.md': 'Ver notions/pending/ para lo nuevo.\n',
    });
    const skills = repo({ 'README.md': 'nada\n' });
    const checkMap = () => run(['--check-map', '--repo', arnes], { TYCON_SKILLS_DIR: skills });
    const expected = ['guides/stale.md:1 notions'];
    assert.deepStrictEqual(staleFound(arnes, skills), expected, 'sin carpeta vieja: la mención cuenta');
    let cm = checkMap();
    assert.strictEqual(cm.status, 0, `sin carpeta vieja, el mapa pasa\n${cm.stdout}${cm.stderr}`);

    write(arnes, { 'notions/observer.log': 'log\n', 'notions/observer.err': '', 'notions/descartados/a.md': 'x\n', 'notions/.DS_Store': 'x' });
    assert.deepStrictEqual(staleFound(arnes, skills), expected, 'con restos sin seguir en la vieja: la mención sigue contando');
    cm = checkMap();
    assert.strictEqual(cm.status, 0, `con restos sin seguir, el mapa no choca\n${cm.stdout}${cm.stderr}`);

    // el `.gitignore` de la raíz que ignora la carpeta vieja ENTERA la nombra a propósito (es lo que esconde los restos);
    // un patrón de adentro de la vieja sí es una mención vieja
    write(arnes, { '.gitignore': '/notions/\nnotions/drafts/\n' });
    git(arnes, ['add', '.gitignore']);
    git(arnes, ['commit', '-q', '-m', 'ignorar la carpeta vieja']);
    assert.deepStrictEqual(staleFound(arnes, skills), ['.gitignore:2 notions', ...expected], 'con los restos ignorados: igual; la línea que ignora la vieja entera no cuenta');
    cm = checkMap();
    assert.strictEqual(cm.status, 0, `con los restos ignorados, el mapa no choca\n${cm.stdout}${cm.stderr}`);

    // un archivo que git versiona en la vieja: la carpeta vieja vuelve a ser la de verdad (no mudada)
    git(arnes, ['add', '-f', 'notions/descartados/a.md']);
    const r = run(['--stale-mentions', '--json', '--repo', arnes], { TYCON_SKILLS_DIR: skills });
    assert.strictEqual(r.status, 0, `con un archivo versionado en la vieja, todavía no está mudada: nada que marcar\n${r.stdout}${r.stderr}`);
    cm = checkMap();
    assert.strictEqual(cm.status, 2, `y el mapa ve el choque de verdad\n${cm.stdout}${cm.stderr}`);
    assert.match(cm.stderr, /el nombre nuevo choca: inbox\/notions ya existe y notions también/);
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

// T3f: --check-map, al ver si la carpeta nueva tiene sólo lo que
// llegó antes que su carpeta, pregunta a git qué versiona. Si no es un repo, mira el disco; si git falla de
// verdad («dubious ownership», un permiso, un repo roto), frena diciendo qué pasó: no cae callado al disco.
test('T3f R2AdversarialSilent_CheckMapArrivals_GitFailsForReal_Stops — adversarial R2 / silent: sólo «no es un repo» mira el disco', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-t3f-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-t3f-bin-'));
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  try {
    const entries = [
      { kind: 'folder', old: 'notions', new: 'inbox/notions', batch: 'lab', callers: ['same-repo'] },
      { kind: 'file', old: 'notions/b.md', new: 'inbox/notions/b.md', batch: 'lab', callers: ['same-repo'] },
    ];
    write(repo, { 'scripts/lib/renames.json': { __about: 'mapa de laboratorio', retire_after: null, entries },
      'notions/a.md': 'real\n', 'inbox/notions/b.md': 'llegó antes que su carpeta\n' });
    const check = (env = {}) => run(['--check-map', '--repo', repo], env);
    const plain = check();
    assert.strictEqual(plain.status, 0, `sin repo, el disco: la carpeta nueva tiene sólo lo que llegó antes (${plain.stderr})`);
    // `rev-parse` contesta «no es un repo» (el disco para la carpeta vieja); `ls-files` falla de verdad
    fs.writeFileSync(path.join(bin, 'git'), [
      '#!/bin/sh',
      'case "$*" in',
      '  *rev-parse*) echo "fatal: not a git repository (or any of the parent directories): .git" >&2; exit 128 ;;',
      `  *ls-files*) echo "fatal: detected dubious ownership in repository at '${repo}'" >&2; exit 1 ;;`,
      'esac',
      `exec ${JSON.stringify(realGit)} "$@"`,
      '',
    ].join('\n'));
    fs.chmodSync(path.join(bin, 'git'), 0o755);
    const r = check({ PATH: `${bin}${path.delimiter}${process.env.PATH}` });
    assert.strictEqual(r.status, 2, `un git que falla de verdad frena (${r.stderr})`);
    assert.match(r.stderr, /dubious ownership/, 'y dice qué pasó');
    assert.match(r.stderr, /no pude/);
    assert.doesNotMatch(r.stderr, /choca/, 'no es un veredicto sobre el disco');
  } finally {
    for (const d of [repo, bin]) fs.rmSync(d, { recursive: true, force: true });
  }
});

// T3e: detrás de una carpeta vieja de un solo pedazo, una `\` seguida de una letra de escape (`\n`, `\t`, `\b`,
// `\r`, `\f`, `\v`, `\0`, `\x`, `\u`, una comilla o un acento grave) es una secuencia de escape de un string o de una
// expresión regular, no una barra de ruta. `\\` (la barra de Windows escrita dentro de un string) y `\/` (la barra
// escapada) sí son barras. Borde elegido: `<vieja>\notas` (Windows, con el pedazo siguiente empezando por una letra de
// escape) no cuenta — las subcarpetas reales de la carpeta mudada no empiezan con esas letras.
test('T3e R2Adversarial_StaleMentions_EscapeSequenceIsNotPathSeparator — adversarial R2: «\\n» o «\\t» detrás no hacen ruta', () => {
  const dirs = [];
  const repo = t3Repo(dirs, 'sn-t3e-');
  try {
    const arnes = repo({
      'scripts/lib/renames.json': { __about: 'mapa de laboratorio', retire_after: null, entries: T3_ENTRIES },
      'inbox/notions/pending/.gitkeep': '',
      'scripts/notions/x.js': 'module.exports = 1;\n',
      'guides/escapes.md': [
        'console.log("No hay notions\\n");',
        'echo "sin notions\\t(0)"',
        'const re = /notions\\b/;',
        "printf 'notions\\r' ; x = 'notions\\x41' ; y = \"notions\\u00e1\" ; z = 'notions\\'' ; w = `notions\\``",
        'Windows con escape: notions\\notas',
        '',
      ].join('\n'),
      'guides/stale.md': [
        'C:\\tcg\\notions\\pending\\',
        '"cd notions\\\\pending"',
        '"notions\\/pending"',
        'ls notions/pending/',
        '',
      ].join('\n'),
    });
    const skills = repo({ 'README.md': 'nada\n' });
    assert.deepStrictEqual(staleFound(arnes, skills), [
      'guides/stale.md:1 notions',
      'guides/stale.md:2 notions',
      'guides/stale.md:3 notions',
      'guides/stale.md:4 notions',
    ], 'las secuencias de escape no son ruta; la barra de Windows (también «\\\\» dentro de un string), «\\/» y «/» sí');
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

// ── T41: el campo `homonyms` de una entrada del mapa ──────────────────────────────────────────
// Un yml del arnés que se mudó a `pipelines/` puede llamarse igual que el pipeline de cada producto: en los archivos que
// hablan del producto, el nombre suelto es OTRO archivo. La entrada lo declara con `homonyms` (glob + motivo) y
// --stale-mentions no cuenta ESA entrada ahí; afuera, sí; otra entrada en el mismo archivo, también. Un glob que no
// matchea nada frena: una lista vieja no tapa en silencio. Nombres de laboratorio (`…-lab.yml`), nunca el mapa real.
const HOMONYM_ENTRIES = (homonyms) => [
  { kind: 'file', old: 'azure-pipelines-lab.yml', new: 'pipelines/azure-pipelines-lab.yml', batch: 'lab', callers: ['ado'], ...(homonyms ? { homonyms } : {}) },
  { kind: 'file', old: 'azure-pipelines-other-lab.yml', new: 'pipelines/azure-pipelines-other-lab.yml', batch: 'lab', callers: ['ado'] },
];
const HOMONYM_FILES = (homonyms) => ({
  'scripts/lib/renames.json': { __about: 'mapa de laboratorio', retire_after: null, entries: HOMONYM_ENTRIES(homonyms) },
  'pipelines/azure-pipelines-lab.yml': 'trigger: none\n',
  'pipelines/azure-pipelines-other-lab.yml': 'trigger: none\n',
  // el producto: su propio pipeline se llama igual que el del arnés que se mudó
  'templates/product/README.md': 'El producto define su azure-pipelines-lab.yml en la raíz.\n',
  'templates/product/backend/azure-pipelines-lab.yml': 'trigger: [main]\n',
  // un archivo del producto que además nombra OTRO yml del arnés con su nombre viejo: ése sigue contando
  'templates/product/mixed.md': 'El producto corre azure-pipelines-lab.yml en main\nY el arnés, azure-pipelines-other-lab.yml de noche\n',
  // fuera de la lista, el mismo nombre suelto es el del arnés
  'guides/stale.md': 'bash azure-pipelines-lab.yml\n',
});

test('T41 R6_StaleMentions_HomonymsNotCountedInsideCountedOutside — adentro del glob no cuenta; afuera sí; otra entrada en el mismo archivo sí', () => {
  const dirs = [];
  const repo = t3Repo(dirs, 'sn-t41-');
  try {
    const skills = repo({ 'README.md': 'nada\n' });
    // sin el campo, cada mención cuenta
    const plain = repo(HOMONYM_FILES(null));
    assert.deepStrictEqual(staleFound(plain, skills), [
      'guides/stale.md:1 azure-pipelines-lab.yml',
      'templates/product/README.md:1 azure-pipelines-lab.yml',
      'templates/product/mixed.md:1 azure-pipelines-lab.yml',
      'templates/product/mixed.md:2 azure-pipelines-other-lab.yml',
    ], 'sin homonyms, el nombre suelto cuenta en todos lados');
    const homonyms = [{ glob: 'templates/product/**', reason: 'el pipeline de cada producto se llama igual en su repo' }];
    const arnes = repo(HOMONYM_FILES(homonyms));
    assert.deepStrictEqual(staleFound(arnes, skills), [
      'guides/stale.md:1 azure-pipelines-lab.yml',
      'templates/product/mixed.md:2 azure-pipelines-other-lab.yml',
    ], 'en los archivos del glob no cuenta ESA entrada; afuera sí, y otra entrada en el mismo archivo también');
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('T41 R6_StaleMentions_HomonymsDeadGlobStops — un glob que no matchea ningún archivo del repo sale 2 nombrándolo', () => {
  const dirs = [];
  const repo = t3Repo(dirs, 'sn-t41d-');
  try {
    const skills = repo({ 'README.md': 'nada\n' });
    const dead = 'templates/gone/**';
    const arnes = repo(HOMONYM_FILES([
      { glob: 'templates/product/**', reason: 'el pipeline de cada producto' },
      { glob: dead, reason: 'una carpeta que ya no está' },
    ]));
    const r = run(['--stale-mentions', '--json', '--repo', arnes], { TYCON_SKILLS_DIR: skills });
    assert.strictEqual(r.status, 2, `un glob muerto es «no pude mirar» (rc ${r.status})\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /no pude/);
    assert.ok(r.stderr.includes(dead), `nombra el glob muerto\n${r.stderr}`);
    assert.ok(r.stderr.includes('azure-pipelines-lab.yml'), `y la entrada que lo trae\n${r.stderr}`);
    // una forma rota del campo tampoco se saltea callada
    const broken = repo(HOMONYM_FILES([{ glob: '', reason: 'vacío' }]));
    const b = run(['--stale-mentions', '--json', '--repo', broken], { TYCON_SKILLS_DIR: skills });
    assert.strictEqual(b.status, 2, `un homonyms mal formado frena (rc ${b.status})\n${b.stderr}`);
    assert.match(b.stderr, /homonyms/);
    // homonyms en una entrada de un repo que este modo no mira: tampoco se saltea callado
    const foreign = HOMONYM_FILES([{ glob: 'templates/product/**', reason: 'el pipeline de cada producto' }]);
    foreign['scripts/lib/renames.json'].entries[0].repo = 'lab-other-repo';
    const f = run(['--stale-mentions', '--json', '--repo', repo(foreign)], { TYCON_SKILLS_DIR: skills });
    assert.strictEqual(f.status, 2, `homonyms de un repo desconocido es «no pude mirar» (rc ${f.status})\n${f.stdout}\n${f.stderr}`);
    assert.match(f.stderr, /lab-other-repo/);
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('T41 R6_StaleMentions_HomonymsShapeInCheckMap — --check-map acepta homonyms bien formado y frena el mal formado', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-t41c-'));
  write(repo, { 'pipelines/azure-pipelines-lab.yml': 'trigger: none\n', 'pipelines/azure-pipelines-other-lab.yml': 'trigger: none\n' });
  const check = (homonyms) => {
    const f = path.join(repo, `map-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify({ __about: 'mapa de laboratorio', retire_after: null, entries: HOMONYM_ENTRIES(homonyms) }));
    return run(['--check-map', '--map', f, '--repo', repo]);
  };
  try {
    const ok = check([{ glob: 'templates/product/**', reason: 'el pipeline de cada producto' }]);
    assert.strictEqual(ok.status, 0, `bien formado: pasa (${ok.stderr})`);
    const cases = [
      ['no es una lista', { glob: 'x/**', reason: 'r' }],
      ['lista vacía', []],
      ['un elemento que no es objeto', ['x/**']],
      ['glob vacío', [{ glob: '', reason: 'r' }]],
      ['glob que no es texto', [{ glob: 3, reason: 'r' }]],
      ['sin motivo', [{ glob: 'x/**' }]],
      ['motivo vacío', [{ glob: 'x/**', reason: '  ' }]],
      ['un campo de más', [{ glob: 'x/**', reason: 'r', extra: 1 }]],
      ['glob absoluto', [{ glob: '/x/**', reason: 'r' }]],
      ['glob con «..»', [{ glob: '../x/**', reason: 'r' }]],
    ];
    for (const [what, h] of cases) {
      const r = check(h);
      assert.strictEqual(r.status, 2, `${what}: sale 2 (salió ${r.status}: ${r.stderr})`);
      assert.match(r.stderr, /homonyms/, `${what}: el problema nombra homonyms`);
      assert.doesNotMatch(r.stderr, /campo desconocido «homonyms»/, `${what}: homonyms es un campo conocido`);
    }
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// ── T19 · el repo único: el arnés y agent-skills en la MISMA raíz ───────────────────────────────────
// La copia de un solo repo corre el pre-commit de agent-skills con el arnés en su propia raíz. En modo público el freno
// del lado agent-skills tiene que leer la lista de palabras del índice de ese mismo repo; no la busca en el árbol
// del «otro» repo, que en modo público no arma (frenaría todo commit con «no pude mirar»).
test('SingleRepo_SkillsSourceReadsHarnessFromSameRoot — en el repo único, el lado agent-skills lee la lista del arnés en la misma raíz', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-single-'));
  try {
    for (const rel of ['scripts/publishing', 'scripts/lib']) fs.cpSync(path.join(RAIZ, rel), path.join(dir, rel), { recursive: true });
    // como en la copia: sin lo privado de la publicación y sin el mapa de renombres
    for (const rel of ['scripts/publishing/denylist.json', 'scripts/publishing/replacements.json', 'scripts/lib/renames.json']) fs.rmSync(path.join(dir, rel), { force: true });
    write(dir, { 'scripts/lib/spanish-words.json': LAB_WORDS, 'skills/lab-x/SKILL.md': '# Lab\n' });
    git(dir, ['init', '-q', '-b', 'main']); git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'base']);
    const env = { TYCON_GUIDES_DIR: dir, TYCON_SKILLS_DIR: dir };
    write(dir, { 'skills/lab-x/run.sh': '#!/usr/bin/env bash\necho ok\n' }); git(dir, ['add', '-A']);
    const limpio = run(['--repo', dir, '--source', 'agent-skills'], env, dir);
    assert.equal(limpio.status, 0, `un ejecutable en inglés pasa: ${limpio.stderr}${limpio.stdout}`);
    write(dir, { [`skills/lab-x/${W.cargar}-${W.datos}.sh`]: '#!/usr/bin/env bash\necho ok\n' }); git(dir, ['add', '-A']);
    const nuevo = run(['--repo', dir, '--source', 'agent-skills'], env, dir);
    assert.equal(nuevo.status, 1, `un nombre en castellano frena: ${nuevo.stderr}${nuevo.stdout}`);
    assert.doesNotMatch(nuevo.stderr + nuevo.stdout, /no pude mirar/, 'frena por el nombre, no por no poder mirar');
    assert.match(nuevo.stderr + nuevo.stdout, new RegExp(`${W.cargar}-${W.datos}\\.sh`), 'nombra el archivo');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── el repo unido del equipo: cada parte mira lo de su fuente lógica, sin leer «el otro repo» ──────────
// El arnés y agent-skills son un repo y su pre-commit corre el freno dos veces sobre la misma raíz. Con el perfil del
// equipo (no es la copia pública) cada corrida arma las dos fuentes partiendo el mismo árbol por ruta.
// 🔴 rojo verificado: sin «el otro repo» a mano la corrida del arnés sale 0 con «no encontré agent-skills»,
//    sin haber mirado nada, aunque las skills están en el propio repo.
test('Unified_TeamRepo_SourceByPath — en el repo unido cada parte frena lo suyo, y no busca el otro repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-unified-'));
  try {
    write(dir, {
      'perfil-equipo.json': '{}\n',
      'scripts/publishing/allowlist.json': {
        packages: { core: {
          arnes: { in: ['scripts/**'], out: [{ glob: 'perfil-equipo.json', reason: 'prueba: del equipo' }] },
          'agent-skills': { in: ['agents/*.md', 'skills/tycon-*/**'], out: [] },
        } },
        suitesOutside: [], casesOutside: [], empty: {}, synthetic: [],
      },
      'scripts/publishing/replacements.json': { pares: [], afuera: [] },
      'scripts/publishing/denylist.json': { terminos: [], permitidos: [] },
      'scripts/lib/spanish-words.json': LAB_WORDS,
      'scripts/tool.js': '// nada\n',
      'agents/lab-reviewer.md': '---\nname: lab-reviewer\ndescription: de laboratorio\n---\n\nRevisa.\n',
      'skills/tycon-pipeline/SKILL.md': '# Pipeline\n',
      'skills/tycon-x/SKILL.md': '# Lab\n',
    });
    git(dir, ['init', '-q', '-b', 'main']); git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'la unión']);
    const nowhere = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-nowhere-'));
    const part = (source) => {
      const r = run(['--repo', dir, '--source', source], { TYCON_GUIDES_DIR: nowhere, TYCON_SKILLS_DIR: nowhere }, dir);
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    };
    const opt = `--${W.sin}-${W.copia}`;

    // un ejecutable del arnés con una opción en castellano: lo frena la parte del arnés; la de skills no lo mira
    write(dir, { 'scripts/english-tool.js': `const y = process.argv.includes('${opt}');\n` }); git(dir, ['add', '-A']);
    let h = part('arnes'); let s = part('agent-skills');
    assert.equal(h.status, 1, `la parte del arnés frena: ${h.out}`);
    assert.match(h.out, /scripts\/english-tool\.js/);
    assert.doesNotMatch(h.out, /no encontré/, 'no busca el otro repo: las skills están en este');
    assert.equal(s.status, 0, `la parte de skills no mira lo del arnés: ${s.out}`);
    assert.doesNotMatch(s.out, /no encontré/);
    git(dir, ['reset', '-q', '--hard']); git(dir, ['clean', '-qfd']);

    // un ejecutable de skills/ con nombre en castellano: lo frena la parte de skills; la del arnés no lo mira
    write(dir, { [`skills/tycon-x/${W.cargar}-${W.datos}.sh`]: '#!/usr/bin/env bash\necho ok\n' }); git(dir, ['add', '-A']);
    h = part('arnes'); s = part('agent-skills');
    assert.equal(s.status, 1, `la parte de skills frena: ${s.out}`);
    assert.match(s.out, new RegExp(`${W.cargar}-${W.datos}\\.sh`));
    assert.equal(h.status, 0, `la parte del arnés no mira lo de skills: ${h.out}`);
    git(dir, ['reset', '-q', '--hard']); git(dir, ['clean', '-qfd']);

    // limpio en las dos mitades: pasan las dos
    write(dir, { 'scripts/other-tool.js': 'const y = 4;\n', 'skills/tycon-x/run.sh': '#!/usr/bin/env bash\necho ok\n' }); git(dir, ['add', '-A']);
    h = part('arnes'); s = part('agent-skills');
    assert.equal(h.status, 0, h.out);
    assert.equal(s.status, 0, s.out);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── T25 · el repo unido ─────────────────────────────────────────────────────────
// Un repo unido de laboratorio: el arnés del equipo (perfil, lista blanca, lista de palabras) con agent-skills adentro.
const UNIFIED_LIST = {
  packages: { core: {
    arnes: { in: ['scripts/**', 'guides/**'], out: [{ glob: 'perfil-equipo.json', reason: 'prueba: del equipo' }] },
    'agent-skills': { in: ['agents/*.md', 'skills/tycon-*/**'], out: [] },
  } },
  suitesOutside: [], casesOutside: [], empty: {}, synthetic: [],
};
const HARNESS_HALF = {
  'perfil-equipo.json': '{}\n',
  'scripts/publishing/allowlist.json': UNIFIED_LIST,
  'scripts/publishing/replacements.json': { pares: [], afuera: [] },
  'scripts/publishing/denylist.json': { terminos: [], permitidos: [] },
  'scripts/lib/spanish-words.json': LAB_WORDS,
  'scripts/tool.js': '// nada\n',
};
const SKILLS_HALF = {
  'agents/lab-reviewer.md': '---\nname: lab-reviewer\ndescription: de laboratorio\n---\n\nRevisa.\n',
  'skills/tycon-pipeline/SKILL.md': '# Pipeline\n',
  'skills/tycon-x/SKILL.md': '# Lab\n',
};
const OLD_ENV = `TYCON_${W.hoy.toUpperCase()}`;   // una variable en castellano que agent-skills trae «desde siempre»
/** Un repo de laboratorio con esos archivos, en un commit. */
function labRepo(dir, files, msg) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  write(dir, files);
  git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', msg]);
  return git(dir, ['rev-parse', 'HEAD']);
}
/** La unión hecha como la de verdad: el arnés y agent-skills, cada uno con su historia, juntados por un merge en una rama. */
function unionMergeLab({ inTheMerge = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-union-'));
  const harness = path.join(dir, 'harness');
  const skills = path.join(dir, 'skills-repo');
  const main = labRepo(harness, HARNESS_HALF, 'el main del arnés, antes de la unión');
  const side = labRepo(skills, { ...SKILLS_HALF, 'skills/tycon-x/aliases.js': `module.exports = process.env.${OLD_ENV};\n` }, 'agent-skills, con su variable de siempre');
  git(harness, ['checkout', '-q', '-b', 'union']);
  git(harness, ['fetch', '-q', skills, 'HEAD']);
  git(harness, ['merge', '-q', '--no-commit', '--allow-unrelated-histories', 'FETCH_HEAD']);
  if (inTheMerge) { write(harness, inTheMerge); git(harness, ['add', '-A']); }
  git(harness, ['commit', '-q', '-m', 'la unión: las dos historias en un merge']);
  const nowhere = fs.mkdtempSync(path.join(dir, 'nowhere-'));
  const part = (source, range) => {
    const r = run(['--repo', harness, '--source', source, ...(range ? ['--range', range] : [])], { TYCON_GUIDES_DIR: nowhere, TYCON_SKILLS_DIR: nowhere }, harness);
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  return { dir, harness, skills, main, side, union: git(harness, ['rev-parse', 'HEAD']), part };
}

// 🔴 rojo verificado: el rango del pull request del corte (desde el main de antes de la unión) sale 1 con las
//    dos fuentes, por variables de agent-skills que su techo ya contaba: para el freno, toda la mitad de skills/
//    «empieza a salir» porque la base del rango no la trae.
test('Unified_RangeCrossingTheUnion_EachHalfAgainstItsOwnHistory — T25: el rango del pull request que trae la unión pasa, y lo nuevo de después frena', () => {
  const l = unionMergeLab();
  try {
    for (const range of [`${l.main}...HEAD`, `${l.union}^1...${l.union}`, `${l.union}^2...${l.union}`]) {
      for (const source of ['arnes', 'agent-skills']) {
        const r = l.part(source, range);
        assert.equal(r.status, 0, `${source} sobre ${range}: un nombre que esa mitad ya traía en su historia no es nuevo — ${r.out}`);
        assert.doesNotMatch(r.out, /no encontré/, 'sin buscar «el otro repo»');
      }
    }
    // usar después de la unión un nombre que ya existía (en cualquiera de las dos mitades) sigue pasando; uno nuevo frena,
    // por su parte y sólo su archivo
    write(l.harness, {
      'scripts/reuses.js': `module.exports = process.env.${OLD_ENV};\n`,
      [`skills/tycon-x/${W.cargar}-${W.datos}.sh`]: '#!/usr/bin/env bash\necho ok\n',
    });
    git(l.harness, ['add', '-A']); git(l.harness, ['commit', '-q', '-m', 'después de la unión']);
    const h = l.part('arnes', `${l.main}...HEAD`);
    const s = l.part('agent-skills', `${l.main}...HEAD`);
    assert.equal(h.status, 0, `reusar la variable que agent-skills ya traía no es un nombre nuevo: ${h.out}`);
    assert.equal(s.status, 1, s.out);
    assert.match(s.out, new RegExp(`${W.cargar}-${W.datos}\\.sh`));
    assert.doesNotMatch(s.out, new RegExp(OLD_ENV), 'la variable de siempre no se nombra');
  } finally { fs.rmSync(l.dir, { recursive: true, force: true }); }
});

test('Unified_RangeCrossingTheUnion_ChangedInTheMergeItself_Blocks — lo que el commit de la unión cambia sobre su historia se mira', () => {
  const added = `TYCON_${W.motivo.toUpperCase()}`;
  const l = unionMergeLab({ inTheMerge: { 'skills/tycon-x/aliases.js': `module.exports = process.env.${OLD_ENV} || process.env.${added};\n` } });
  try {
    for (const range of [`${l.main}...HEAD`, `${l.union}^1...${l.union}`, `${l.union}^2...${l.union}`]) {
      const s = l.part('agent-skills', range);
      assert.equal(s.status, 1, `${range}: ${s.out}`);
      assert.match(s.out, new RegExp(`aliases\\.js:1 .*${added}`));
      assert.doesNotMatch(s.out, new RegExp(`${OLD_ENV}\\b`), 'la que ya estaba en esa historia no se nombra');
    }
  } finally { fs.rmSync(l.dir, { recursive: true, force: true }); }
});

test('Unified_RangeCrossingTheUnion_HalfWithoutHistory_IsAllNew — sin la historia (la mitad agregada por un commit común) se mira entera', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-nohist-'));
  try {
    const main = labRepo(dir, HARNESS_HALF, 'el main del arnés');
    write(dir, { ...SKILLS_HALF, 'skills/tycon-x/aliases.js': `module.exports = process.env.${OLD_ENV};\n` });
    git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'agent-skills copiado adentro, sin su historia']);
    const r = run(['--repo', dir, '--source', 'agent-skills', '--range', `${main}...HEAD`], { TYCON_GUIDES_DIR: dir, TYCON_SKILLS_DIR: dir }, dir);
    assert.equal(r.status, 1, `sin de dónde comparar, la mitad es nueva y se mira: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, new RegExp(OLD_ENV));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Lo mismo que en new-names.js (la función es la misma): el lado de skills de la unión (rama aparte) y el main de
// agent-skills mezclado después no se contienen. Una variable en castellano que el main ya pasó a inglés sigue «estando»
// en el lado viejo, y volver a meterla pasa la red del rango.
// 🔴 rojo verificado: la parte de skills sale 0 sobre el rango del pull request.
test('Unified_RangeCrossingTheUnion_TwoSidesNotContained_ComparedWithTheLatest — lo que la última punta pasó a inglés no vuelve por la red', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-twosides-'));
  try {
    const harness = path.join(dir, 'harness');
    const skills = path.join(dir, 'skills-repo');
    const main = labRepo(harness, HARNESS_HALF, 'el main del arnés');
    labRepo(skills, { ...SKILLS_HALF, 'skills/tycon-x/aliases.js': `module.exports = process.env.${OLD_ENV};\n` }, 'A0: agent-skills, con su variable');
    git(skills, ['checkout', '-q', '-b', 'side']);
    write(skills, { 'skills/tycon-x/side.js': 'module.exports = 1;\n' }); git(skills, ['add', '-A']); git(skills, ['commit', '-q', '-m', 'S1: el lado de la unión']);
    git(harness, ['checkout', '-q', '-b', 'union']);
    git(harness, ['fetch', '-q', skills, 'side']);
    git(harness, ['merge', '-q', '--no-edit', '--allow-unrelated-histories', 'FETCH_HEAD']);
    git(skills, ['checkout', '-q', 'main']);
    write(skills, { 'skills/tycon-x/aliases.js': 'module.exports = process.env.TYCON_TODAY;\n' }); git(skills, ['add', '-A']); git(skills, ['commit', '-q', '-m', 'A1: la variable, en inglés']);
    git(harness, ['fetch', '-q', skills, 'main']);
    git(harness, ['merge', '-q', '--no-edit', 'FETCH_HEAD']);
    const nowhere = fs.mkdtempSync(path.join(dir, 'nowhere-'));
    const part = (source) => {
      const r = run(['--repo', harness, '--source', source, '--range', `${main}...HEAD`], { TYCON_GUIDES_DIR: nowhere, TYCON_SKILLS_DIR: nowhere }, harness);
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    };
    // el espejo: hasta acá, nada nuevo en ninguna mitad (lo del lado viejo y lo de la última punta, de su historia)
    for (const source of ['arnes', 'agent-skills']) assert.equal(part(source).status, 0, `${source}: ${part(source).out}`);
    // vuelve la variable en castellano que la última punta había sacado
    write(harness, { 'skills/tycon-x/aliases.js': `module.exports = process.env.TYCON_TODAY || process.env.${OLD_ENV};\n` });
    git(harness, ['add', '-A']); git(harness, ['commit', '-q', '-m', 'vuelve la variable en castellano']);
    const s = part('agent-skills');
    assert.equal(s.status, 1, s.out);
    assert.match(s.out, new RegExp(`aliases\\.js:1 .*${OLD_ENV}`));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// El doble aviso: en el repo unido las dos partes ven cambiar las DOS mitades en el mismo commit.
// 🔴 rojo verificado: un commit con un ejecutable nuevo en cada mitad sale 1 por las dos partes, y cada una
//    nombra también el archivo de la otra: el mismo hallazgo dos veces, y doble en el registro.
test('Unified_BothHalvesInOneCommit_EachFindingOnce — el doble aviso: cada hallazgo lo reporta una sola parte', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-double-'));
  try {
    labRepo(dir, { ...HARNESS_HALF, ...SKILLS_HALF }, 'el repo unido');
    const env = { TYCON_GUIDES_DIR: dir, TYCON_SKILLS_DIR: dir };
    const part = (source) => { const r = run(['--repo', dir, '--source', source], env, dir); return { status: r.status, out: `${r.stdout}${r.stderr}` }; };
    const inHarness = `${W.bajar}-${W.datos}`;
    const inSkills = `${W.cargar}-${W.datos}`;
    write(dir, { [`scripts/${inHarness}.sh`]: '#!/usr/bin/env bash\necho ok\n', [`skills/tycon-x/${inSkills}.sh`]: '#!/usr/bin/env bash\necho ok\n' });
    git(dir, ['add', '-A']);
    const h = part('arnes'); const s = part('agent-skills');
    assert.equal(h.status, 1, h.out);
    assert.match(h.out, new RegExp(`scripts/${inHarness}\\.sh`));
    assert.doesNotMatch(h.out, new RegExp(inSkills), 'el archivo nuevo de skills/ lo reporta la parte de skills');
    assert.match(h.out, /\(1 hallazgo/);
    assert.equal(s.status, 1, s.out);
    assert.match(s.out, new RegExp(`skills/tycon-x/${inSkills}\\.sh`));
    assert.doesNotMatch(s.out, new RegExp(inHarness), 'el archivo nuevo del arnés lo reporta la parte del arnés');
    assert.match(s.out, /\(1 hallazgo/);
    git(dir, ['reset', '-q', '--hard']); git(dir, ['clean', '-qfd']);

    // lo que el commit NO toca y empieza a salir porque cambia la lista blanca lo reporta la parte del arnés, una vez
    write(dir, { [`skills/other-x/${inSkills}.sh`]: '#!/usr/bin/env bash\necho ok\n' });
    git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'una skill que la lista blanca no publica']);
    const list = JSON.parse(JSON.stringify(UNIFIED_LIST));
    list.packages.core['agent-skills'].in.push('skills/other-x/**');
    write(dir, { 'scripts/publishing/allowlist.json': list, 'skills/tycon-x/run.sh': '#!/usr/bin/env bash\necho ok\n' });
    git(dir, ['add', '-A']);
    const h2 = part('arnes'); const s2 = part('agent-skills');
    assert.equal(h2.status, 1, h2.out);
    assert.match(h2.out, new RegExp(`agent-skills: skills/other-x/${inSkills}\\.sh`));
    assert.equal(s2.status, 0, `lo que reclasifica la lista ya lo reportó la parte del arnés: ${s2.out}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Un ejecutable con nombre en castellano que EMPIEZA A SALIR porque cambia la lista blanca, y que el mismo commit
// además modifica. El reparto del doble aviso se lo deja a la parte de su fuente (lo tocó), y ésa lo ve como
// «modificado»: no juzga su ruta. Ninguna de las dos corridas lo frena.
// 🔴 rojo verificado: las dos partes salen 0, con lo stageado y con el rango del pull request.
test('Unified_StartsShippingAndModified_PathJudged — lo que empieza a salir se juzga por su ruta aunque el mismo commit lo modifique', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-starts-'));
  try {
    labRepo(dir, { ...HARNESS_HALF, ...SKILLS_HALF }, 'el repo unido');
    const env = { TYCON_GUIDES_DIR: dir, TYCON_SKILLS_DIR: dir };
    const part = (source, range) => { const r = run(['--repo', dir, '--source', source, ...(range ? ['--range', range] : [])], env, dir); return { status: r.status, out: `${r.stdout}${r.stderr}` }; };
    const name = `${W.cargar}-${W.datos}`;
    const inSkills = `skills/other-x/${name}.sh`;
    const inHarness = `tools/${W.bajar}-${W.datos}.sh`;
    // dos ejecutables que la lista blanca no publica, uno en cada mitad
    write(dir, { [inSkills]: '#!/usr/bin/env bash\necho ok\n', [inHarness]: '#!/usr/bin/env bash\necho ok\n' });
    git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'dos ejecutables que no salen']);
    const base = git(dir, ['rev-parse', 'HEAD']);
    // la lista los empieza a publicar Y el mismo commit los modifica
    const list = JSON.parse(JSON.stringify(UNIFIED_LIST));
    list.packages.core['agent-skills'].in.push('skills/other-x/**');
    list.packages.core.arnes.in.push('tools/**');
    write(dir, { 'scripts/publishing/allowlist.json': list, [inSkills]: '#!/usr/bin/env bash\necho ok\necho otra\n', [inHarness]: '#!/usr/bin/env bash\necho ok\necho otra\n' });
    git(dir, ['add', '-A']);
    const check = (label, h, s) => {
      assert.equal(s.status, 1, `${label}, agent-skills: ${s.out}`);
      assert.match(s.out, new RegExp(`${inSkills.replace(/[.]/g, '\\.')}.*\\[ruta\\]`), `${label}: la ruta de skills/ se juzga`);
      assert.equal(h.status, 1, `${label}, arnes: ${h.out}`);
      assert.match(h.out, new RegExp(`${inHarness.replace(/[.]/g, '\\.')}.*\\[ruta\\]`), `${label}: la ruta del arnés se juzga`);
      assert.doesNotMatch(h.out, new RegExp(name), `${label}: cada hallazgo, de su parte (sin doble aviso)`);
    };
    check('lo stageado', part('arnes'), part('agent-skills'));
    git(dir, ['commit', '-q', '-m', 'la lista los publica y los dos cambian']);
    check('el rango del pull request', part('arnes', `${base}...HEAD`), part('agent-skills', `${base}...HEAD`));

    // el espejo: un ejecutable que YA salía con ese nombre y sólo se modifica no frena (su ruta no es nueva)
    write(dir, { [inSkills]: '#!/usr/bin/env bash\necho ok\necho otra\necho una mas\n', [inHarness]: '#!/usr/bin/env bash\necho ok\necho otra\necho una mas\n' });
    git(dir, ['add', '-A']);
    const h = part('arnes'); const s = part('agent-skills');
    assert.equal(h.status, 0, h.out);
    assert.equal(s.status, 0, s.out);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// `--count`, `--check-map` y `--stale-mentions` no buscan «el otro repo» en el repo unido: si lo buscaran, sin él no
// contarían ni validarían, y con él a mano (un clon viejo de la máquina) recorrerían el repo unido entero como si fuera el arnés.
// 🔴 rojo verificado: sin «el otro repo» los tres salen 2 («no encontré agent-skills»); con la variable en el
//    propio clon, --stale-mentions cuenta como del arnés las menciones de skills/.
test('Unified_CountCheckMapStaleMentions_SourceByPath_NoOtherRepo — T25: en el repo unido los tres modos parten el árbol por ruta', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-modes-'));
  const dir = path.join(tmp, 'unified');
  try {
    const opt = `--${W.sin}-${W.copia}`;
    const entries = [
      { kind: 'file', old: 'scripts/moved-tool.js', new: 'scripts/tools/moved-tool.js', batch: 'lab', callers: ['same-repo'] },
      { kind: 'file', repo: 'agent-skills', old: 'skills/tycon-x/moved-helper.js', new: 'skills/tycon-x/tools/moved-helper.js', batch: 'lab', callers: ['same-repo'] },
    ];
    const harnessHalf = {
      ...HARNESS_HALF,
      'scripts/lib/renames.json': { __about: 'mapa de laboratorio', retire_after: null, entries },
      'scripts/tools/moved-tool.js': 'module.exports = 1;\n',
      'scripts/tool.js': `const y = process.argv.includes('${opt}');\n// la de skills, nombrada desde el arnés: skills/tycon-x/moved-helper.js\n`,
      'guides/stale.md': 'node scripts/moved-tool.js\n',
    };
    const skillsHalf = {
      ...SKILLS_HALF,
      'skills/tycon-x/tools/moved-helper.js': 'module.exports = 2;\n',
      [`skills/tycon-x/${W.cargar}-${W.datos}.sh`]: '#!/usr/bin/env bash\n# la del arnés, nombrada desde skills: scripts/moved-tool.js\necho ok\n',
      'skills/tycon-x/notes.md': 'node skills/tycon-x/moved-helper.js\n',
    };
    labRepo(dir, { ...harnessHalf, ...skillsHalf }, 'el repo unido');
    const nowhere = path.join(tmp, 'nowhere');
    fs.mkdirSync(nowhere);
    const env = { TYCON_GUIDES_DIR: nowhere, TYCON_SKILLS_DIR: nowhere };

    // --count: las dos mitades del mismo árbol, cada una con las reglas de su fuente — la misma cuenta que dan los
    // mismos archivos en dos repos
    const c = run(['--count', '--json', '--repo', dir], env, dir);
    assert.equal(c.status, 0, `--count no busca el otro repo: ${c.stderr}`);
    const core = JSON.parse(c.stdout).packages.core;
    assert.ok(core.files >= 1 && core.options === 1, `cuenta el ejecutable de skills/ y la opción del arnés: ${c.stdout}`);
    const two = { harness: path.join(tmp, 'two-harness'), skills: path.join(tmp, 'two-skills') };
    labRepo(two.harness, harnessHalf, 'el arnés solo');
    labRepo(two.skills, skillsHalf, 'agent-skills solo');
    const c2 = run(['--count', '--json', '--repo', two.harness], { TYCON_GUIDES_DIR: two.harness, TYCON_SKILLS_DIR: two.skills }, two.harness);
    assert.equal(c2.status, 0, c2.stderr);
    assert.deepStrictEqual(JSON.parse(c.stdout).packages, JSON.parse(c2.stdout).packages, 'la misma cuenta que con dos repos');

    // --check-map: una entrada de agent-skills se resuelve contra el mismo árbol
    const m = run(['--check-map', '--repo', dir], env, dir);
    assert.equal(m.status, 0, `--check-map valida las entradas de agent-skills en el mismo repo: ${m.stderr}`);
    assert.doesNotMatch(m.stderr, /no encontré agent-skills/);

    // --stale-mentions: cada archivo, de su fuente por su ruta; la mención desde la otra mitad es una referencia entre
    // repos y no cuenta, y ninguna sale dos veces — lo mismo que con dos repos
    const stale = (repo, e) => {
      const st = run(['--stale-mentions', '--json', '--repo', repo], e, repo);
      assert.equal(st.status, 1, `rc ${st.status}: ${st.stderr}`);
      return JSON.parse(st.stdout).findings.map((f) => `${f.source}:${f.rel}:${f.line} ${f.old}`).sort();
    };
    const expected = ['agent-skills:skills/tycon-x/notes.md:1 skills/tycon-x/moved-helper.js', 'arnes:guides/stale.md:1 scripts/moved-tool.js'];
    assert.deepStrictEqual(stale(dir, env), expected);
    assert.deepStrictEqual(stale(two.harness, { TYCON_GUIDES_DIR: two.harness, TYCON_SKILLS_DIR: two.skills }), expected, 'el espejo: con dos repos, las mismas');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// La unión DE VERDAD (los commits anotados en scripts/tests/fixtures/union-commits.json). En un clon que no los trae
// (la copia pública, un clon recortado) o que no es el del equipo, sale NO MEDIDA.
// 🔴 Sólo que el archivo FALTE es «no medido»: un `catch` general convertiría un union-commits.json roto en
// NO MEDIDO, y las pruebas de la unión se saltearían calladas. Roto, las dos fallan diciéndolo.
const UNION_FILE = path.join(RAIZ, 'scripts', 'tests', 'fixtures', 'union-commits.json');
let UNION_BROKEN = null;
const UNION = (() => {
  let text;
  try {
    text = fs.readFileSync(UNION_FILE, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    UNION_BROKEN = `no pude leer ${path.relative(RAIZ, UNION_FILE)}: ${e.message}`;
    return null;
  }
  let u;
  try { u = JSON.parse(text); } catch (e) { UNION_BROKEN = `${path.relative(RAIZ, UNION_FILE)} no es JSON: ${e.message}`; return null; }
  const has = (sha) => typeof sha === 'string' && spawnSync('git', ['-C', RAIZ, 'cat-file', '-e', `${sha}^{commit}`], { env: cleanEnv() }).status === 0;
  const all = [u.union, u.harness_side, u.skills_side, u.harness_resolved, u.skills_resolved, u.tips && u.tips.harness_main, u.tips && u.tips.skills_main];
  return fs.existsSync(path.join(RAIZ, 'perfil-equipo.json')) && all.every(has) ? u : null;
})();
const NO_UNION = UNION || UNION_BROKEN ? false : 'NO MEDIDO: no es el clon del equipo o no trae los commits de la unión';
const unionOrFail = () => { if (UNION_BROKEN) assert.fail(`los commits de la unión: ${UNION_BROKEN} — un archivo roto no es «no medido»`); return UNION; };

test('Unified_RealUnionRange_PassesBothSources — T25: el rango del commit de la unión de verdad pasa con las dos fuentes', { skip: NO_UNION }, () => {
  const UNION = unionOrFail();
  const nowhere = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-nowhere-'));
  try {
    // 🔴 La salida 0 también la dan «quiet» y «not-measured»: cada rango y cada fuente tiene su resultado ESPERADO
    // (el porqué de cada «quiet», en la T25 de new-names.test.js). «quiet»
    // no escribe nada; «not-measured» avisa: por eso «quiet» se exige con la salida vacía, no sólo sin --json.
    const expected = [
      [`${UNION.harness_resolved}...${UNION.union}`, { arnes: 'quiet', 'agent-skills': 'quiet' }],
      [`${UNION.skills_resolved}...${UNION.union}`, { arnes: 'quiet', 'agent-skills': 'quiet' }],
      [`${UNION.tips.harness_main}...${UNION.union}`, { arnes: 'clean', 'agent-skills': 'quiet' }],   // el rango del pull request de la unión
      [`${UNION.tips.skills_main}...${UNION.union}`, { arnes: 'quiet', 'agent-skills': 'clean' }],
    ];
    for (const [range, bySource] of expected) {
      for (const source of ['arnes', 'agent-skills']) {
        const r = run(['--repo', RAIZ, '--source', source, '--range', range, '--json'], { TYCON_GUIDES_DIR: nowhere, TYCON_SKILLS_DIR: nowhere });
        assert.equal(r.status, 0, `${source} sobre ${range.slice(0, 12)}…: salió ${r.status}\n${r.stdout}${r.stderr}`);
        assert.doesNotMatch(r.stderr, /no encontré/, 'sin buscar «el otro repo»');
        let j;
        if (!`${r.stdout}${r.stderr}`.trim()) j = { outcome: 'quiet' };
        else { try { j = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { j = { outcome: `(no es --json: ${`${r.stdout}${r.stderr}`.trim().split('\n').pop()})` }; } }
        assert.equal(j.outcome, bySource[source], `${source} sobre ${range.slice(0, 12)}…: esperaba «${bySource[source]}» y salió «${j.outcome}»`);
        if (j.outcome === 'clean') assert.ok(j.files > 0, `${source} sobre ${range.slice(0, 12)}…: «clean» sin haber mirado ningún archivo`);
      }
    }
  } finally { fs.rmSync(nowhere, { recursive: true, force: true }); }
});

// El techo es el mismo antes y después de la unión. Si el commit de la unión lo tocara, la cuenta «igual» se
// conseguiría subiendo el techo; y esta comparación no depende del diccionario inglés, así que mide en cualquier máquina.
test('Unified_RealUnion_SpanishCeilingUnchanged — T25: spanish-names-ceiling.json es el mismo del lado del arnés que en el repo unido', { skip: NO_UNION }, () => {
  const UNION = unionOrFail();
  const show = (sha) => spawnSync('git', ['-C', RAIZ, 'show', `${sha}:scripts/publishing/spanish-names-ceiling.json`], { encoding: 'utf8', env: cleanEnv() });
  const before = show(UNION.harness_side);
  const after = show(UNION.union);
  assert.equal(before.status, 0, `no pude leer el techo del lado del arnés: ${before.stderr}`);
  assert.equal(after.status, 0, `no pude leer el techo del repo unido: ${after.stderr}`);
  const b = JSON.parse(before.stdout);
  assert.ok(Object.keys(b).some((k) => !k.startsWith('__')), 'el espejo: el techo del lado del arnés trae al menos un paquete');
  assert.deepStrictEqual(JSON.parse(after.stdout), b, 'el techo cambió con la unión');
});

// Los techos: la cuenta por paquete es la misma con dos repos (cada lado, antes de la unión) que con el repo unido.
test('Unified_Count_SameBeforeAndAfterTheUnion — T25: el termómetro da la misma cuenta con dos repos que con el repo unido', { skip: NO_UNION }, (t) => {
  const UNION = unionOrFail();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-ceil-'));
  const trees = { before: path.join(tmp, 'harness'), skills: path.join(tmp, 'skills'), after: path.join(tmp, 'unified') };
  const nowhere = path.join(tmp, 'nowhere');
  fs.mkdirSync(nowhere);
  try {
    git(RAIZ, ['worktree', 'add', '-q', '--detach', trees.before, UNION.harness_side]);
    git(RAIZ, ['worktree', 'add', '-q', '--detach', trees.skills, UNION.skills_side]);
    git(RAIZ, ['worktree', 'add', '-q', '--detach', trees.after, UNION.union]);
    const before = run(['--count', '--json', '--repo', trees.before, '--words', WORDS], { TYCON_SKILLS_DIR: trees.skills });
    const after = run(['--count', '--json', '--repo', trees.after, '--words', WORDS], { TYCON_GUIDES_DIR: nowhere, TYCON_SKILLS_DIR: nowhere });
    assert.equal(before.status, 0, before.stderr);
    assert.equal(after.status, 0, `en el repo unido cuenta sin buscar el otro repo: ${after.stderr}`);
    const b = JSON.parse(before.stdout); const a = JSON.parse(after.stdout);
    assert.deepStrictEqual(a.packages, b.packages, 'la misma cuenta por paquete, antes y después de la unión');
    // 🔴 sin diccionario la prueba saldría VERDE sin comparar contra el techo: por eso es un
    // «no medido» que cuenta en el resumen (la cuenta de arriba sí se comparó; el techo lo cubre también *SpanishCeilingUnchanged*)
    if (!a.dictionary) { t.skip('NO MEDIDO: sin diccionario inglés en esta máquina — se comparó la cuenta, no las cifras del techo'); return; }
    // y es la del techo: lo que el termómetro mide no supera lo que el techo deja
    const ceiling = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'publishing', 'spanish-names-ceiling.json'), 'utf8'));
    for (const [pkg, nums] of Object.entries(a.packages)) {
      assert.ok(ceiling[pkg], `el techo no trae el paquete ${pkg}`);
      assert.ok(nums.total <= ceiling[pkg].total, `${pkg}: el repo unido cuenta ${nums.total} y el techo deja ${ceiling[pkg].total}`);
    }
  } finally {
    for (const d of Object.values(trees)) spawnSync('git', ['-C', RAIZ, 'worktree', 'remove', '--force', d], { env: cleanEnv() });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── --stale-mentions y los valores que no son de una opción ────
// Un valor viejo se busca como `--<opción> <viejo>`. Algunos son de una clave de configuración o de una
// variable (`"codex": "<viejo>"`, `TYCON_ROSTER_NAMES=<viejo>`, `"scheduled_days": [...]`): esa forma no puede aparecer
// nunca, y el modo saldría 0 callado. Por eso el valor declara a qué nombres se asigna (`assigned_to`) y se busca ahí; un valor
// que no es de una opción y no lo declara es «no pude mirar». Las claves de tycon.json se buscan también con punto
// (`integrations.<vieja>`) y como argumento de tycon-config.js (`key <vieja>`). 🔴 ROJO: ninguna contaría.
test('G stale-mentions: los valores asignados a una clave o una variable, y las claves con punto o como argumento, cuentan', () => {
  const dirs = [];
  const repo = (files) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-g-asig-'));
    dirs.push(d);
    git(d, ['init', '-q', '-b', 'main']);
    write(d, files);
    git(d, ['add', '-A']);
    git(d, ['commit', '-q', '-m', 'lab']);
    return d;
  };
  // los viejos por partes: escritos enteros acá, esta misma prueba sería una mención vieja del repo
  const V = { det: ['detec', 'tar'].join(''), fre: ['fre', 'no'].join(''), mar: ['mar', 'tes'].join(''), buz: ['bu', 'zon'].join(''), sec: ['integra', 'ciones'].join('') };
  const MAQ = '~/.claude/tycon.json';
  const entries = [
    { kind: 'value', old: V.det, new: 'detect', where: 'scripts/lib/tycon-config.js', option: 'codex', assigned_to: ['codex', 'TYCON_CODEX'], batch: 'lab' },
    { kind: 'value', old: V.fre, new: 'block', where: 'scripts/ci/tycon-ci-gate.js', option: 'TYCON_REVIEW_A_DONE', assigned_to: ['TYCON_REVIEW_A_DONE', 'TYCON_ROSTER_NAMES'], batch: 'lab' },
    { kind: 'value', old: V.mar, new: 'tuesday', where: 'scripts/controls-bench/periodic-exam.js', option: 'scheduled_days', assigned_to: ['scheduled_days'], batch: 'lab' },
    { kind: 'key', old: V.sec, new: 'integrations', where: MAQ, batch: 'lab' },
    { kind: 'key', old: V.buz, new: 'mailbox', where: MAQ, batch: 'lab' },
  ];
  const cuentan = [
    `{ "integrations": { "codex": "${V.det}" } }`,
    `TYCON_CODEX=${V.det} claude`,
    `export TYCON_ROSTER_NAMES=${V.fre}`,
    `TYCON_REVIEW_A_DONE='${V.fre}' git commit`,
    `"scheduled_days": ["tuesday", "${V.mar}"],`,
    `poné integrations.${V.buz}=true en ${MAQ}`,
    `o ${V.sec}.${V.buz}: true`,
    `node scripts/lib/tycon-config.js key ${V.buz}`,
    `node scripts/lib/tycon-config.js get integrations.${V.buz}`,
  ];
  const noCuentan = [
    `'TYCON_REVIEW_A_DONE=${V.fre}:block'`,     // la declaración del par viejo:nuevo no es una mención
    `el ${V.fre} de producción no cambia`,       // prosa: la palabra suelta no es una asignación
    '"codex": "detect"',
    '"scheduled_days": ["tuesday", "friday"]',
    `${V.mar} y viernes, en la prosa de una guía`,
  ];
  try {
    const arnes = repo({
      'scripts/lib/renames.json': { __about: 'mapa de laboratorio', retire_after: null, entries },
      'guides/a.md': `${[...cuentan, ...noCuentan].join('\n')}\n`,
      'scripts/lib/tycon-config.js': '// lab\n',
      'scripts/ci/tycon-ci-gate.js': '// lab\n',
      'scripts/controls-bench/periodic-exam.js': '// lab\n',
    });
    const skills = repo({ 'README.md': 'nada\n' });
    const r = run(['--stale-mentions', '--json', '--repo', arnes], { TYCON_SKILLS_DIR: skills });
    assert.strictEqual(r.status, 1, `las menciones viejas cuentan (rc ${r.status})\n${r.stdout}\n${r.stderr}`);
    const found = new Set(JSON.parse(r.stdout).findings.filter((f) => f.rel === 'guides/a.md').map((f) => f.line));
    cuentan.forEach((l, i) => assert.ok(found.has(i + 1), `cuenta: «${l}»\n${r.stdout}`));
    noCuentan.forEach((l, i) => assert.ok(!found.has(cuentan.length + i + 1), `no cuenta: «${l}»\n${r.stdout}`));

    // un valor que no es de una opción (su guion no tiene `--<option>`) y no declara assigned_to: no se sabe buscarlo
    const sinDeclarar = repo({
      'scripts/lib/renames.json': { __about: 'lab', retire_after: null, entries: [{ kind: 'value', old: V.det, new: 'detect', where: 'scripts/lib/tycon-config.js', option: 'codex', batch: 'lab' }] },
      'scripts/lib/tycon-config.js': '// lee la clave codex, sin opción de línea de comandos\n',
    });
    const r2 = run(['--stale-mentions', '--json', '--repo', sinDeclarar], { TYCON_SKILLS_DIR: skills });
    assert.strictEqual(r2.status, 2, `no poder mirar no es verde (rc ${r2.status})\n${r2.stdout}\n${r2.stderr}`);
    assert.match(`${r2.stdout}${r2.stderr}`, /assigned_to/, 'y dice qué falta declarar');

    // --check-map: assigned_to va sólo en un value, como lista de nombres
    const mal = repo({
      'scripts/lib/renames.json': { __about: 'lab', retire_after: null, entries: [
        { kind: 'env', old: 'TYCON_LAB_OLD', new: 'TYCON_LAB_NEW', assigned_to: ['x'], batch: 'lab' },
        { kind: 'value', old: V.det, new: 'detect', where: 'scripts/lib/tycon-config.js', option: 'codex', assigned_to: 'codex', batch: 'lab' },
      ] },
    });
    const r3 = run(['--check-map', '--json', '--repo', mal], { TYCON_SKILLS_DIR: skills });
    assert.notStrictEqual(r3.status, 0, `un assigned_to mal puesto es un mapa mal escrito\n${r3.stdout}`);
    assert.match(r3.stdout + r3.stderr, /assigned_to/);
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

// Con la lista real, los siete días que se retiran tienen que contar como castellano aunque el diccionario inglés del
// sistema traiga «lune» y «Martes»: si no, un nombre nuevo con esas palabras pasa el freno.
// Los días salen del mapa, no de esta prueba. 🔴 ROJO: dos de los siete no cuentan.
test('G SpanishNames_RealList_TheSevenOldDaysCount — con la lista real, los siete días que la tanda G retira cuentan como castellano', (t) => {
  const mapa = path.join(RAIZ, 'scripts', 'lib', 'renames.json');
  if (!fs.existsSync(mapa)) { t.skip('NO MEDIDO — copia pública sin el mapa de renombres'); return; }
  const dias = JSON.parse(fs.readFileSync(mapa, 'utf8')).entries.filter((e) => e.kind === 'value' && e.batch === 'G' && e.option === 'scheduled_days').map((e) => e.old);
  assert.strictEqual(dias.length, 7, 'el mapa trae los siete días de la tanda');
  const real = sn.loadWords(fs.readFileSync(WORDS, 'utf8'), 'scripts/lib/spanish-words.json');
  // el peor caso: un diccionario que trae los siete días como inglés (el de Linux de la CI no es el de macOS).
  // Contar no puede depender del diccionario de la máquina: los siete tienen que estar en la lista.
  const peor = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sn-dias-')), 'words');
  fs.writeFileSync(peor, `${dias.join('\n')}\n`);
  for (const dictPath of [undefined, peor, '/usr/share/dict/words']) {
    if (dictPath && !fs.existsSync(dictPath)) continue;
    const d = sn.makeDetector(real, dictPath ? { dictPath } : {});
    for (const dia of dias) {
      assert.ok(d.isSpanish(dia).spanish, `«${dia}» cuenta como castellano${dictPath ? ` con ${dictPath}` : ''}`);
      assert.ok(d.isSpanish(`send-${dia}`).spanish, `«send-${dia}» también`);
    }
  }
});

// ── una palabra «ambigua» pegada a una inglesa cuenta ─────────────────────────
// 🔴 rojo verificado: si estas cuatro palabras fueran «ambiguas» (cuentan sólo junto a otra castellana), cuatro
//    opciones del tablero y el interruptor de un freno —una ambigua más palabras inglesas— no frenarían ni contarían en
//    el termómetro.
test('T73 SpanishNames_RealList_AmbiguousPlusEnglishCounts — con la lista real, las cuatro opciones y la variable que el termómetro no veía cuentan; sus nombres en inglés no', async (t) => {
  const real = sn.loadWords(fs.readFileSync(WORDS, 'utf8'), 'scripts/lib/spanish-words.json');
  const solo = 'so' + 'lo'; const vista = 'vis' + 'ta';
  for (const w of [W.sin, solo, vista, W.de]) {
    assert.ok(real.words.has(w), `«${w}» va en words: en un nombre de máquina de este repo es castellano`);
    assert.ok(!real.ambiguous.has(w), `«${w}» ya no es ambigua`);
  }
  const viejos = [`${W.sin}-local`, `${solo}-local`, vista, `alias-${W.de}`, `TYCON_PR_${W.sin.toUpperCase()}_AUTO_COMPLETE`];
  const nuevos = ['without-local', 'local-only', 'view', 'alias-of', 'TYCON_PR_AUTO_COMPLETE_GUARD', 'mailbox', 'nightly', 'detect', 'block'];
  /** Las dos mitades con un detector: los nombres de antes cuentan, los nuevos no, y el extractor los ve en un guion. */
  const lasDosMitades = (det, con) => {
    for (const name of viejos) assert.ok(det.isSpanish(name).spanish, `${con}: ${name} tiene que contar`);
    for (const name of nuevos) assert.ok(!det.isSpanish(name).spanish, `${con}: ${name} es inglés, no cuenta (${det.isSpanish(name).words.join(', ')})`);
    const code = `const a = args.includes('--${viejos[0]}');\nif (process.env.${viejos[4]} === '0') process.exit(0);\nconst b = args.includes('--${nuevos[0]}');\nif (process.env.${nuevos[4]} === '0') process.exit(0);\n`;
    const found = [...new Set(sn.extract('scripts/x.js', code).filter((x) => det.isSpanish(x.name).spanish).map((x) => `${x.category}:${x.name}`))];
    assert.deepStrictEqual(found.sort(), [`env:${viejos[4]}`, `option:${viejos[0]}`].sort(), `${con}: el extractor ve los de antes y no los de hoy`);
  };

  // La mitad de los nombres en inglés tiene que medirse aunque la máquina no tenga el diccionario del sistema (un agente
  // de CI puede no traerlo): si no, la prueba saldría sin haberla medido. Se mide SIEMPRE, de las dos maneras que el
  // freno sabe trabajar, y el diccionario del sistema es una tercera, aparte y visible.
  await t.test('sin diccionario: el respaldo del freno (sólo la lista de palabras)', () => {
    const det = sn.makeDetector(real, { dictPath: path.join(os.tmpdir(), 'no-existe-este-diccionario') });
    assert.strictEqual(det.dictionary, false, 'este detector trabaja sin diccionario, como el freno en una máquina que no lo tiene');
    lasDosMitades(det, 'sin diccionario');
  });

  await t.test('con un diccionario propio y fijo: las palabras inglesas de esta tanda', () => {
    // una lista de la prueba, no de la máquina: con ella la regla «lo que no está en el diccionario inglés cuenta» está
    // prendida de verdad en cualquier lado, y los nombres nuevos tienen que pasarla por ser inglés, no por omisión
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-t73-'));
    try {
      const dic = path.join(dir, 'words');
      fs.writeFileSync(dic, ['without', 'local', 'only', 'view', 'alias', 'auto', 'complete', 'guard', 'mailbox', 'nightly', 'detect', 'block'].join('\n') + '\n');
      const det = sn.makeDetector(real, { dictPath: dic });
      assert.strictEqual(det.dictionary, true, 'este detector trabaja con diccionario');
      assert.ok(det.isSpanish('qwertyzz-local').spanish, 'control: con diccionario, una palabra que no es inglesa ni está en la lista cuenta');
      lasDosMitades(det, 'con el diccionario de la prueba');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  const sistema = process.env.TYCON_SPANISH_NAMES_DICTIONARY || '/usr/share/dict/words';
  const hay = sn.makeDetector(real, { dictPath: sistema }).dictionary;
  await t.test('con el diccionario del sistema, que es con el que se midió el techo', { skip: !hay && `NO MEDIDO — esta máquina no tiene ${sistema}: las otras dos mediciones sí corrieron` }, () => {
    lasDosMitades(sn.makeDetector(real, { dictPath: sistema }), 'con el diccionario del sistema');
  });
});

// ── --stale-mentions mira si el archivo nombra la ruta antes de probarle sus expresiones ──
// Probar cada entrada de ruta del mapa contra cada archivo del repo es cálculo puro y caro (todo el peso de
// guides-moved.test.js). El filtro es el último pedazo de la ruta vieja (`needle`): ninguna expresión de la entrada puede
// encontrar nada en un texto que no lo tenga escrito. Acá se mide que eso es cierto para CADA entrada del mapa real.
// El mapa real es del equipo: la copia pública no lo trae (ahí no hay rutas viejas que filtrar).
const REAL_MAP = fs.existsSync(path.join(RAIZ, 'scripts', 'lib', 'renames.json'));
test('T43 StaleMentions_PathNeedle_SoundForEveryMapEntry — toda forma en que una ruta vieja del mapa se encuentra contiene el pedazo que se usa de filtro', { skip: REAL_MAP ? false : 'sin el mapa de renombres no hay rutas viejas' }, () => {
  const map = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'lib', 'renames.json'), 'utf8'));
  const entries = map.entries.filter((e) => e && ['file', 'folder', 'state-file', 'config-file'].includes(e.kind));
  assert.ok(entries.length > 100, `el mapa real trae sus entradas de ruta (${entries.length})`);
  const matchers = sn.pathMatchers(entries);
  assert.strictEqual(matchers.length, entries.length, 'un buscador por entrada');
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let found = 0;
  for (const m of matchers) {
    const old = m.e.old.replace(/^~\//, '').replace(/\/+$/, '');
    assert.strictEqual(m.needle, path.posix.basename(old), `${m.e.old}: el filtro es el último pedazo de la ruta vieja`);
    assert.ok(m.needle.length > 1 && !m.needle.includes('/'), `${m.e.old}: un pedazo de verdad («${m.needle}»)`);
    // cada expresión lleva el pedazo, entero y escapado, como parte obligatoria de lo que busca
    for (const re of m.res) assert.ok(re.source.includes(esc(m.needle)), `${m.e.old}: ${re.source} no lleva «${m.needle}»`);
    // y las formas en que se escribe de verdad: entera, a la Windows, el nombre solo, detrás de ./ y detrás de su carpeta
    const parent = path.posix.basename(path.posix.dirname(old));
    const forms = [old, old.split('/').join('\\'), path.posix.basename(old), `./${path.posix.basename(old)}`, `${parent}/${path.posix.basename(old)}`, `${old}/adentro.txt`, `${old.split('/').join('\\')}\\adentro.txt`];
    for (const form of forms) {
      const line = `mirá ${form} acá`;
      if (!m.res.some((re) => re.test(line))) continue;
      found++;
      assert.ok(line.includes(m.needle), `${m.e.old}: la forma «${form}» se encuentra y no contiene «${m.needle}»`);
      assert.deepStrictEqual(sn.pathsNaming([m], line), [m], `${m.e.old}: el filtro deja pasar la forma «${form}»`);
    }
    assert.deepStrictEqual(sn.pathsNaming([m], 'un texto que no nombra nada de eso\n'), [], `${m.e.old}: un texto que no lo nombra no llega a las expresiones`);
  }
  assert.ok(found >= entries.length, `cada entrada se encontró en al menos una forma (${found} formas de ${entries.length} entradas)`);
});

test('T43 — con el filtro, --stale-mentions sigue encontrando una ruta vieja escrita de cada forma, y calla lo que antes callaba', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-t43-'));
  try {
    git(repo, ['init', '-q']);
    write(repo, {
      'scripts/lib/renames.json': { entries: [
        { kind: 'file', old: 'scripts/ci/viejo-uno.js', new: 'scripts/ci/new-one.js' },
        { kind: 'folder', old: 'scripts/carpeta-vieja/', new: 'scripts/new-folder/' },
      ] },
      'scripts/ci/new-one.js': '// nuevo\n',
      'scripts/new-folder/x.js': '// x\n',
      'guides/entera.md': 'corré `node scripts/ci/viejo-uno.js` y listo\n',
      'guides/windows.md': 'en Windows: scripts\\ci\\viejo-uno.js\n',
      'guides/sola.md': 'el guion viejo-uno.js ya no está\n',
      'guides/carpeta.md': 'mirá scripts/carpeta-vieja/x.js\n',
      'guides/limpia.md': 'acá no se nombra nada viejo: scripts/ci/new-one.js y mi-viejo-uno.js.bak\n',
    });
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'base']);
    const r = run(['--stale-mentions', '--json', '--repo', repo], { TYCON_SKILLS_DIR: repo });
    assert.ok(r.status === 0 || r.status === 1, r.stderr);
    const got = JSON.parse(r.stdout).findings.map((f) => `${f.rel} — ${f.old}`).sort();
    assert.deepStrictEqual(got, [
      'guides/carpeta.md — scripts/carpeta-vieja/',
      'guides/entera.md — scripts/ci/viejo-uno.js',
      'guides/sola.md — scripts/ci/viejo-uno.js',
      'guides/windows.md — scripts/ci/viejo-uno.js',
    ]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
