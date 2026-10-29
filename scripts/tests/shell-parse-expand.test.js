'use strict';
/**
 * shell-parse-expand.test.js — el expansor y el partidor de `scripts/lib/shell-parse.js` (T1-T6).
 *
 * Lo que no se puede perder:
 *   · T1 — las llaves se expanden como las expanden zsh y bash DE VERDAD: la referencia no es una tabla escrita a
 *     mano sino los shells de la máquina (`zsh -f`, zsh con las opciones del snapshot de la sesión, `/bin/bash` 3.2 y
 *     el bash del PATH si es otro). Un shell que falta sale NO MEDIDO y la prueba falla: nunca verde por ausencia.
 *     Sólo donde `/bin/bash` es 3.2 (las Mac del equipo): con otro bash, las dos pruebas contra los shells se saltean
 *     diciéndolo.
 *   · T2 — lo que el shell deja literal queda literal (comillas, `\{`, `{x}`, `{}`, `${X}`, llave sin cerrar), y una
 *     comilla escapada fuera de comillas no abre comillas.
 *   · T3 — los agrupamientos cortan por profundidad (grupo, función, subshell, `$(…)`, `<(…)`), el `case` no parte en
 *     sus patrones, y una palabra con llaves o paréntesis queda entera.
 *   · T4-T6 — las formas de zsh, `$'…'`/`$"…"`, y variables/modificadores/arreglos: lo que no se resuelve es
 *     DESCONOCIDO y vale `*`, nunca «nada».
 *
 * Los nombres de ejemplo son inventados; un nombre protegido por el freno se arma por concatenación.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const sp = require(path.join(__dirname, '..', 'lib', 'shell-parse.js'));
const { expandWord, splitWords, segmentos, tokens, parseSimpleCommand, commandVariables, changesShellOptions, ExpansionBudget } = sp;

const lits = (raw, ctx) => expandWord(raw, ctx).patterns.map(sp.patternToLiteral).sort();
const ordenar = (xs) => [...new Set(xs)].sort();

// ── T1 · las llaves contra los shells de verdad ─────────────────────────────────────────────────
const PALABRAS_T1 = [
  'p{a,b}', 'p{a,{b,c}}q', 'p{a..e}', 'p{e..a}', 'p{1..5}', 'p{5..1}', 'p{-2..2}', 'p{1..9..2}', 'p{1..10..3}',
  'p{01..10}', 'p{1..03}', 'p{001..3}', 'p{-01..2}', 'p{,x}', 'p{,.bak}', 'a{b,c}d{1..2}', '{a,b}{c,d}',
  'd/{x,y}/f', '{d1,d2}/{f1,f2}.json', 'p{a..c}{1..2}', 'p{6..1..-2}', 'p{1..10..20}', 'p{+1..3}', 'p{a..e..2}',
  'p{1..3..0}', 'p{1..}', 'p{a\\,b,c}', 'p{"a,b",c}', 'x{a}y', 'x{}y', 'p{a,b', 'p{1...3}', 'pre/{a,b,{c..e}}/suf',
  'q{x,y,}z', 'w{1..2}{,s}',
];

function shellsDeReferencia() {
  const out = [];
  const existe = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } };
  const zsh = spawnSync('/bin/sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).stdout.trim();
  out.push({ nombre: 'zsh -f', ok: !!zsh, correr: (w) => spawnSync(zsh, ['-f', '-c', `setopt noglob; print -rl -- ${w}`], { encoding: 'utf8' }) });
  out.push({ nombre: 'zsh con las opciones del snapshot', ok: !!zsh,
    correr: (w) => spawnSync(zsh, ['-f', '-c', `setopt noglob extendedglob kshglob globdots nobareglobqual; print -rl -- ${w}`], { encoding: 'utf8' }) });
  out.push({ nombre: '/bin/bash', ok: existe('/bin/bash'), correr: (w) => spawnSync('/bin/bash', ['-c', `set -f; printf '%s\\n' ${w}`], { encoding: 'utf8' }) });
  const bashPath = spawnSync('/bin/sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();
  if (bashPath && existe('/bin/bash') && fs.realpathSync(bashPath) !== fs.realpathSync('/bin/bash')) {
    out.push({ nombre: `bash del PATH (${bashPath})`, ok: true, correr: (w) => spawnSync(bashPath, ['-c', `set -f; printf '%s\\n' ${w}`], { encoding: 'utf8' }) });
  }
  return out;
}

// La referencia son los shells de las Mac del equipo: zsh y el bash 3.2 de macOS, que es lo que el expansor modela. Donde
// /bin/bash es otro (el agente Linux de la CI trae el 5.x, que lee distinto las llaves con paso y con ceros) no hay contra
// qué comparar: las dos pruebas que miden contra los shells se saltean DICIÉNDOLO, y el resto corre igual.
// En la plataforma de referencia, un shell que falta sigue rojo.
const BASH_VERSION = (() => {
  const r = spawnSync('/bin/bash', ['--version'], { encoding: 'utf8' });
  const m = /version (\d+\.\d+)/.exec(r.stdout || '');
  return m ? m[1] : null;
})();
const OFF_REFERENCE = BASH_VERSION !== null && BASH_VERSION !== '3.2'
  && `no se mide acá: /bin/bash es ${BASH_VERSION} y la referencia es zsh + bash 3.2 (las Mac del equipo)`;

test('ExpandWord_BraceForms_MatchZshAndBash', { skip: OFF_REFERENCE }, () => {
  const shells = shellsDeReferencia();
  const faltan = shells.filter((s) => !s.ok).map((s) => s.nombre);
  if (faltan.length) assert.fail(`NO MEDIDO: falta ${faltan.join(', ')} — sin el shell de referencia no hay contra qué comparar`);
  assert.ok(PALABRAS_T1.length >= 25, 'la tabla tiene que tener al menos 25 palabras con llaves');
  const difieren = [];
  for (const w of PALABRAS_T1) {
    const union = new Set();
    for (const sh of shells) {
      const r = sh.correr(w);
      if (r.status !== 0) assert.fail(`NO MEDIDO: ${sh.nombre} no pudo expandir «${w}» (${(r.stderr || '').trim()})`);
      for (const l of r.stdout.split('\n').slice(0, -1)) union.add(l);
    }
    const esperado = ordenar([...union]);
    const obtenido = ordenar(lits(w));
    if (JSON.stringify(esperado) !== JSON.stringify(obtenido)) difieren.push(`${w}: shells ${JSON.stringify(esperado)} · expandWord ${JSON.stringify(obtenido)}`);
  }
  assert.deepEqual(difieren, [], `palabras donde el expansor no dice lo que dicen los shells:\n${difieren.join('\n')}`);
});

// ── T2 · lo literal queda literal ───────────────────────────────────────────────────────────────
test('ExpandWord_LiteralAndEscaped_StayLiteral', () => {
  assert.deepEqual(lits("'p{a,b}'"), ['p{a,b}']);
  assert.deepEqual(lits('"p{a,b}"'), ['p{a,b}']);
  assert.deepEqual(lits('p\\{a,b\\}'), ['p{a,b}']);
  assert.deepEqual(lits('x{a}y'), ['x{a}y']);
  assert.deepEqual(lits('{}'), ['{}']);
  assert.deepEqual(lits('${X}', { vars: { X: 'a,b' } }), ['a,b'], '${X} no es una llave que se expanda');
  const sinCerrar = 'produc' + 'tion-{index';
  assert.deepEqual(lits(sinCerrar), [sinCerrar], 'una llave sin cerrar queda como nombre');
  const r = expandWord("'a*b'");
  assert.deepEqual(r.patterns, ['a\\*b'], 'un * entre comillas es literal (escapado en el patrón)');
  assert.equal(r.glob, false);
  // fuera de comillas, `\"` y `\'` son el carácter: no abren comillas
  for (const q of ['"', "'"]) {
    const palabras = splitWords(`\\${q} a{b,c} \\${q}`);
    assert.deepEqual(palabras.flatMap((w) => expandWord(w).patterns.map(sp.patternToLiteral)), [q, 'ab', 'ac', q]);
    const segs = segmentos(`rm -f \\${q} a{b,c} \\${q}; echo fin`);
    assert.deepEqual(segs.map((x) => x.texto), [`rm -f \\${q} a{b,c} \\${q}`, 'echo fin'], 'el partidor no abre comillas en una comilla escapada');
    assert.deepEqual(tokens(`rm \\${q} x \\${q}`), ['rm', `\\${q}`, 'x', `\\${q}`], 'el tokenizador tampoco');
  }
  assert.deepEqual(tokens('a "b\\"c" d'), ['a', 'b"c', 'd'], 'en dobles, \\" no cierra');
});

// ── T3 · los agrupamientos por profundidad ──────────────────────────────────────────────────────
test('Segments_GroupingByDepth_WordsStayWhole', () => {
  // lo que da el partidor para los agrupamientos simples: tiene que seguir igual
  const hoy = {
    '{ rm a; }': [{ texto: 'rm a', sep: ')' }],
    '{ echo a }': [{ texto: 'echo a', sep: ')' }],
    'f(){ echo; }; f': [{ texto: 'f', sep: ')' }, { texto: 'echo', sep: ';' }, { texto: 'f', sep: '' }],
    'f() { echo hola; }; f': [{ texto: 'f', sep: ')' }, { texto: 'echo hola', sep: ';' }, { texto: 'f', sep: '' }],
    '(cd x; rm y)': [{ texto: 'cd x', sep: ';' }, { texto: 'rm y', sep: ')' }],
    'echo $(ls x) y': [{ texto: 'echo', sep: '$(' }, { texto: 'ls x', sep: ')' }, { texto: 'y', sep: '' }],
    'diff <(ls a) >(cat)': [{ texto: 'diff <', sep: '(' }, { texto: 'ls a', sep: ')' }, { texto: '>', sep: '(' }, { texto: 'cat', sep: ')' }],
    '{ echo a; echo b; } > /tmp/x': [{ texto: 'echo a', sep: ';' }, { texto: 'echo b', sep: ')' }, { texto: '> /tmp/x', sep: '' }],
    'echo `ls` x': [{ texto: 'echo', sep: '(' }, { texto: 'ls', sep: '(' }, { texto: 'x', sep: '' }],
    'a && (b || c) | d': [{ texto: 'a', sep: '(' }, { texto: 'b', sep: '||' }, { texto: 'c', sep: '|' }, { texto: 'd', sep: '' }],
  };
  for (const [cmd, esperado] of Object.entries(hoy)) assert.deepEqual(segmentos(cmd), esperado, cmd);

  // el case: ni `|` ni `)` de un patrón cortan; el comando del cuerpo sale entero
  const c = segmentos('case $x in a|b) rm y ;; c) rm z ;; esac');
  assert.deepEqual(c.map((x) => x.texto), ['case $x in', 'rm y', 'rm z', 'esac']);
  assert.ok(!c.some((x) => x.sep === '|'), 'un patrón de case no es una tubería');

  // dentro de una palabra, llaves y paréntesis no cortan
  assert.deepEqual(segmentos('echo a{b,c}'), [{ texto: 'echo a{b,c}', sep: '' }]);
  assert.deepEqual(segmentos('echo a(b|c)'), [{ texto: 'echo a(b|c)', sep: '' }]);
  assert.deepEqual(segmentos('rm -f p/x-*.json(N) && ls'), [{ texto: 'rm -f p/x-*.json(N)', sep: '&&' }, { texto: 'ls', sep: '' }]);
  assert.deepEqual(segmentos('a=(p{1,2} q); rm $a').map((x) => x.texto), ['a=(p{1,2} q)', 'rm $a']);
  assert.deepEqual(segmentos('echo ${(j::)a} | wc').map((x) => x.texto), ['echo ${(j::)a}', 'wc']);
  // una sustitución DENTRO de una palabra sigue cortando (el freno tiene que ver el comando de adentro)
  assert.deepEqual(segmentos('a=( $(rm q) )').map((x) => x.texto), ['a=(', 'rm q', ')']);
  // keepSubst: la sustitución queda en su palabra, y su texto se saca aparte
  const k = sp.lex('rm -f $(ls -d p/* | grep x) y', { keepSubst: true });
  assert.deepEqual(k.map((x) => x.texto), ['rm -f $(ls -d p/* | grep x) y']);
  assert.deepEqual(sp.substitutions(k[0].texto), ['ls -d p/* | grep x']);
});

// ── T4 · las formas de zsh ──────────────────────────────────────────────────────────────────────
test('ExpandWord_ZshWordForms', () => {
  assert.deepEqual(lits('a(b|c)d'), ['abd', 'acd']);
  assert.deepEqual(lits('x(N)'), ['x'], 'el calificador final se saca');
  assert.deepEqual(lits('x(om[1])'), ['x']);
  assert.deepEqual(expandWord('~/**/x', { home: '/h' }).patterns, ['/h/*/x'], '** cuenta como *');
  for (const w of ['^x', '*.json~*t*', '@(a|b)']) {
    const r = expandWord(w);
    assert.deepEqual(r.patterns, ['*'], `${w}: glob extendido → el componente es un comodín`);
    assert.equal(r.glob, true);
  }
  assert.deepEqual(expandWord('d/^STOP').patterns, ['d/*'], 'sólo el componente con el operador se vuelve comodín');
  const sinCerrar = expandWord('d/x-(index');
  assert.equal(sinCerrar.undecidable, true, 'un paréntesis sin cerrar es indecidible');
  // un comando que cambia cómo el shell lee las palabras vuelve indecidible lo que expande
  const [seg1, seg2] = segmentos('setopt extendedglob; rm -f d/x');
  assert.equal(changesShellOptions(parseSimpleCommand(seg1.texto)), true);
  const r2 = expandWord(parseSimpleCommand(seg2.texto).words[2], { shellOptionsChanged: true });
  assert.equal(r2.undecidable, true);
  for (const c of ['set -euo pipefail', 'set -e', 'set +o noclobber', 'set -o xtrace']) assert.equal(changesShellOptions(parseSimpleCommand(c)), false, c);
  for (const c of ['shopt -s extglob', 'emulate -L zsh', 'unsetopt nomatch', 'set -o extendedglob', 'set -eo kshglob']) assert.equal(changesShellOptions(parseSimpleCommand(c)), true, c);
});

// ── T5 · comillas ANSI-C y de traducción ────────────────────────────────────────────────────────
test('ExpandWord_AnsiCAndLocaleQuotes', () => {
  assert.deepEqual(lits("$'a\\x69'"), ['ai']);
  assert.deepEqual(lits("$'\\151'"), ['i']);
  assert.deepEqual(lits("$'i'"), ['i']);
  assert.deepEqual(lits("$'a\\'b'"), ["a'b"]);
  assert.deepEqual(lits('$"a"'), ['$a', 'a'], 'bash lo lee como "a"; zsh como $ seguido de "a"');
  assert.deepEqual(lits("d/$'produc\\x74ion'-x.json"), ['d/production-x.json']);
});

// ── T6 · variables, modificadores y arreglos ────────────────────────────────────────────────────
test('ExpandWord_VariablesModifiersArrays', () => {
  const ctx = commandVariables('X=a');
  const r = expandWord('d/$X.json', ctx);
  assert.deepEqual(r.patterns, ['d/a.json']); assert.equal(r.unknown, false);
  const dos = commandVariables('A=pre; B=-x.json');
  assert.deepEqual(expandWord('d/$A$B', dos).patterns, ['d/pre-x.json'], 'dos variables pegadas');
  assert.deepEqual(expandWord('d/${A}-y', dos).patterns, ['d/pre-y']);

  const desconocidas = {
    '${X} sin definir': expandWord('d/${X}.json', {}),
    '${X:-y}': expandWord('d/${X:-y}', ctx),
    '$(cmd) en la palabra': expandWord('d/$(cmd).json', ctx),
    '$X:l': expandWord('d/$X:l', ctx),
    '${(j::)a}': expandWord('d/${(j::)a}', ctx),
    'variable de un for': expandWord('d/x-$f.json', commandVariables('for f in a b; do rm $f; done')),
    'variable de un read (aunque antes valiera algo)': expandWord('d/x-$f.json', commandVariables('f=a; ls | while read f; do rm $f; done')),
  };
  for (const [caso, res] of Object.entries(desconocidas)) {
    assert.equal(res.unknown, true, `${caso}: tiene que ser desconocida`);
    assert.ok(res.patterns.some((p) => p.includes('*')), `${caso}: lo desconocido vale *`);
  }
  assert.deepEqual(desconocidas['${X} sin definir'].patterns, ['d/*.json']);
  assert.deepEqual(desconocidas['$(cmd) en la palabra'].substitutions, ['cmd']);
  // un modificador sobre una variable conocida: la carpeta de su valor + *
  assert.deepEqual(expandWord('$F:s/X/x/', commandVariables('F=/r/p/name-X.json')).patterns, ['/r/p/*']);

  const arr = commandVariables('a=(p{1,2})');
  assert.deepEqual(lits('$a', arr), ['p1', 'p2']);
  assert.deepEqual(lits('"${a[@]}"', arr), ['p1', 'p2']);
  assert.deepEqual(lits('$a[1]', arr), ['p1', 'p2'], 'un elemento vale la unión');
  // el valor de una asignación no expande llaves (como el shell), pero la variable sí se usa
  assert.deepEqual(lits('$F', commandVariables('F=d/x-{a,b}.json')), ['d/x-{a,b}.json']);
  // sin comillas, bash parte en blancos y zsh no: las dos lecturas
  assert.deepEqual(lits('$F', commandVariables('F="d/a d/b"')), ['d/a', 'd/a d/b', 'd/b']);
});

// ── apoyo de T4-T6: el presupuesto y el comando simple ──────────────────────────────────────────
test('ExpansionBudget_CountedBeforeGenerating', () => {
  const b = new ExpansionBudget();
  const t0 = Date.now();
  const r = expandWord('p{1..100000000}', { budget: b });
  assert.ok(Date.now() - t0 < 200, 'un rango enorme no se materializa');
  assert.equal(r.exhausted, true); assert.equal(r.undecidable, true);
  assert.deepEqual(r.patterns, ['p*'], 'la lectura gruesa: la lista vale *');
  const g = new ExpansionBudget();
  assert.equal(expandWord('a{1..3000}', { budget: g }).exhausted, false);
  assert.equal(expandWord('b{1..3000}', { budget: g }).exhausted, true, 'el presupuesto es global por comando');
  assert.equal(g.used, 3000);
});

test('ParseSimpleCommand_AssignmentsWordsAndAllRedirections', () => {
  const p = parseSimpleCommand("X=1 a=(q r) jq '.x=1' f.json 2>/dev/null >d/out.json 1> e &>> g 2>&1 <in <<<word >|h >&k");
  assert.deepEqual(p.assignments.map((a) => [a.name, a.raw, a.array]), [['X', '1', null], ['a', '(q r)', ['q', 'r']]]);
  assert.deepEqual(p.words, ['jq', "'.x=1'", 'f.json']);
  assert.deepEqual(p.redirections.map((r) => [r.fd, r.op, r.target, r.write, r.dup]), [
    ['2', '>', '/dev/null', true, false], [null, '>', 'd/out.json', true, false], ['1', '>', 'e', true, false],
    [null, '&>>', 'g', true, false], ['2', '>&', '1', false, true], [null, '<', 'in', false, false],
    [null, '<<<', 'word', false, false], [null, '>|', 'h', true, false], [null, '>&', 'k', true, false],
  ]);
  assert.deepEqual(parseSimpleCommand('grep "a>b" f > out').redirections.map((r) => r.target), ['out'], 'una > entre comillas no es redirección');
  assert.deepEqual(parseSimpleCommand('export F=x').assignments.map((a) => [a.name, a.builtin]), [['F', 'export']]);
  assert.deepEqual(parseSimpleCommand('typeset -a b=(1 2)').assignments.map((a) => [a.name, a.array, a.builtin]), [['b', ['1', '2'], 'typeset']]);
  const d = parseSimpleCommand('do X=1 rm -f x');
  assert.deepEqual([d.reserved, d.words, d.assignments.map((a) => a.name)], [['do'], ['rm', '-f', 'x'], ['X']], 'la palabra reservada no es el programa');
  // el destino de `<<<`: ni zsh ni bash le expanden llaves ni comodines
  assert.deepEqual(expandWord('d/x-{a,b}*', { vars: {} }, { hereString: true }).patterns, ['d/x-{a,b}\\*']);
});

// ── arreglos vacíos y variables sin resolver ────────────────────────────────────────────────────
// Un arreglo vacío (`a=()`) multiplicaría la palabra por cero: `expandWord` devolvería NINGÚN nombre y el freno no tendría
// nada que juzgar. Otro defecto lo taparía: leer `a=()` como definición de función y cortar ahí.
test('ExpandWord_EmptyArray_IsUnknown_NotNothing', () => {
  const r = expandWord('d/x$a.json', { arrays: { a: [] } });
  assert.deepEqual(r.patterns, ['d/x*.json'], 'un arreglo vacío vale `*`, nunca «nada»');
  assert.equal(r.unknown, true);
  assert.deepEqual(expandWord('d/x"${a[@]}".json', { arrays: { a: [] } }).patterns, ['d/x*.json']);
  assert.deepEqual(expandWord('d/x$v.json', { vars: { v: [] } }).patterns, ['d/x*.json'], 'una variable sin valores, igual');
});

test('Segments_EmptyArrayAssignment_IsNotAFunction', () => {
  assert.deepEqual(segmentos('a=(); rm -f d/x$a.json').map((x) => x.texto), ['a=()', 'rm -f d/x$a.json']);
  const c = commandVariables('a=()');
  assert.ok(Object.prototype.hasOwnProperty.call(c.arrays, 'a'), '`a=()` es un arreglo, no una función');
  assert.deepEqual(lits('d/x$a.json', commandVariables('a=()')), ['d/x*.json']);
  // una función sigue siendo una función (con y sin `function`, con y sin espacio)
  assert.deepEqual(segmentos('f() { rm x; }').map((x) => x.texto), ['f', 'rm x']);
  assert.deepEqual(segmentos('function g () { y; }').map((x) => x.texto), ['function g', 'y']);
  assert.deepEqual(segmentos('mi-fn() { y; }').map((x) => x.texto), ['mi-fn', 'y']);
});

// Una variable asignada desde algo sin resolver (`F=$(ls …)`) sigue siendo DESCONOCIDA al usarla: si quedara como el
// comodín `*`, quien juzga no podría distinguir «el shell expande un comodín» de «no sé qué vale».
test('ExpandWord_VariableFromSubstitution_StaysUnknown', () => {
  // como lo arma el freno: segmento por segmento con la sustitución dentro de su palabra (`keepSubst`)
  const asignar = (texto) => sp.applyAssignments({ vars: {}, arrays: {} }, parseSimpleCommand(texto));
  const r = expandWord('"$F"', asignar('F=$(ls -t d/*.json | head -1)'));
  assert.deepEqual(r.patterns, ['*']);
  assert.equal(r.unknown, true, 'sigue siendo desconocida');
  assert.equal(expandWord('"$F"', asignar('F=$X')).unknown, true, 'desde otra variable sin resolver, igual');
  assert.equal(expandWord('$a', asignar('a=($(ls))')).unknown, true, 'un elemento de arreglo, igual');
  // un comodín escrito en la asignación sigue siendo un comodín, no un desconocido
  assert.equal(expandWord('$G', asignar('G=d/*.json')).unknown, false);
  assert.equal(expandWord('$G', asignar('G=*')).unknown, false);
});

// El reloj del freno dentro del expansor: vencido a mitad de una palabra, lo que queda se lee grueso y es indecidible.
// Desde el hook casi no se alcanza (el hook mira el reloj ANTES de cada palabra y lo convierte en presupuesto agotado):
// hace falta que venza justo mientras se genera una palabra. Por eso se prueba acá, en la biblioteca.
test('ExpandWord_ClockExpired_IsUndecidable', () => {
  const b = new ExpansionBudget();
  const r = expandWord('p{a,b}{c,d}', { budget: b, expired: () => true });
  assert.equal(b.exhausted, false, 'sin agotar el presupuesto: el que corta es el reloj');
  assert.equal(r.undecidable, true); assert.equal(r.exhausted, true);
  assert.equal(r.reason, 'el reloj');
  assert.deepEqual(r.patterns, ['p**'], 'la lectura gruesa: cada lista vale *');
});

// `GLOBIGNORE` prende `dotglob` en bash: los comodines empiezan a casar con nombres que empiezan con punto.
test('ChangesShellOptions_GlobIgnoreAssignment', () => {
  assert.equal(changesShellOptions(parseSimpleCommand('GLOBIGNORE=x')), true);
  assert.equal(changesShellOptions(parseSimpleCommand('export GLOBIGNORE=x')), true);
  assert.equal(changesShellOptions(parseSimpleCommand('GLOBIGNORE=x rm -rf d/*')), true);
  assert.equal(changesShellOptions(parseSimpleCommand('OTRA=x rm -rf d/*')), false);
});

// ── casos de borde del partidor y del expansor ───────────────────────────────────────────────────
// Cada prueba cubre un caso de borde y da ROJO si se vuelve al partidor sin el arreglo.
// Los nombres son inventados (`d/y`, `h/sub/name.json`): lo que se prueba es cómo se parte y se expande, no el freno.

// Un `|` seguido de un salto de línea, de un grupo `{` o de una subshell `(` se pierde si el segmento vacío
// del medio le pisa el separador al anterior: el freno vaciaría la tubería antes de llegar al `xargs`.
test('Segments_PipeBeforeNewlineGroupOrSubshell_KeepsPipe', () => {
  for (const cmd of ['ls x* |\n  xargs rm', 'ls x* | { xargs rm; }', 'ls x* | ( xargs rm )', 'ls x* |\n\n  ( xargs rm )']) {
    for (const opts of [undefined, { keepSubst: true }]) {
      const s = segmentos(cmd, opts);
      assert.equal(s[0].sep, '|', `${JSON.stringify(cmd)}: el separador del lector sigue siendo la tubería`);
      assert.equal(s[1].texto, 'xargs rm', JSON.stringify(cmd));
    }
  }
  // lo que no es tubería sigue igual (como en T3)
  assert.deepEqual(segmentos('a && (b)')[0], { texto: 'a', sep: '(' });
  assert.deepEqual(segmentos('(a) | b').map((x) => x.sep), ['|', '']);
});

// `>!` y `>>!` de zsh (como `>|`): si el partidor los leyera como `>` con destino `!`, el destino real
// quedaría como argumento del programa.
test('ParseSimpleCommand_ZshClobberRedirections', () => {
  const casos = { 'echo x >! f': '>!', 'echo x >>! f': '>>!', 'echo x >>| f': '>>|', 'echo x &>! f': '&>!', 'echo x >&! f': '>&!', 'echo x >&| f': '>&|' };
  for (const [cmd, op] of Object.entries(casos)) {
    const p = parseSimpleCommand(cmd);
    assert.deepEqual(p.words, ['echo', 'x'], cmd);
    assert.deepEqual(p.redirections.map((r) => [r.op, r.target, r.write]), [[op, 'f', true]], cmd);
  }
  // el `|` de `>|` no es una tubería (el partidor no corta `echo x >` | `f`)
  assert.deepEqual(segmentos('echo x >| f; ls').map((x) => x.texto), ['echo x >| f', 'ls']);
  assert.deepEqual(segmentos('echo x >>| f && ls').map((x) => x.texto), ['echo x >>| f', 'ls']);
  assert.deepEqual(segmentos('echo x \\>| wc').map((x) => [x.texto, x.sep]), [['echo x \\>', '|'], ['wc', '']], 'escapado sí es tubería');
});

// Con el presupuesto agotado, la lectura gruesa no puede cambiar cada lista por UN `*` que no cruza `/`: el
// nombre entero, con su carpeta, adentro de una alternativa, desaparecería.
test('ExpandWord_BudgetExhausted_CoarseReadingKeepsSlashAlternatives', () => {
  const r = expandWord('h/{sub/name.json,{1..5000}}', { budget: new ExpansionBudget() });
  assert.equal(r.exhausted, true);
  assert.ok(r.patterns.includes('h/sub/name.json'), `la alternativa con carpeta sigue a la vista: ${JSON.stringify(r.patterns)}`);
  assert.ok(r.patterns.includes('h/*'), 'el resto de la lista vale *');
  const b = new ExpansionBudget(); expandWord('t/x-{1..4096}', { budget: b });
  const r2 = expandWord('h/{sub/pro,x/y}duct.json', { budget: b });
  assert.equal(r2.exhausted, true);
  assert.ok(r2.patterns.includes('h/sub/product.json'), `un nombre partido por la alternativa también: ${JSON.stringify(r2.patterns)}`);
  // una lista enorme de alternativas con carpeta: no se materializa, y la palabra cruda queda como patrón
  const muchas = 'h/{' + Array.from({ length: 5000 }, (_, k) => `d${k}/x`).join(',') + ',sub/name.json}';
  const t0 = Date.now(); const r3 = expandWord(muchas, { budget: new ExpansionBudget(10) });
  assert.ok(Date.now() - t0 < 500, 'la lectura gruesa tiene tope');
  assert.ok(r3.patterns.some((p) => sp.patternToLiteral(p).includes('sub/name.json')), 'pasado el tope, la palabra cruda');
});

// La continuación de línea fuera de comillas no es un ESPACIO: el shell la quita y une.
test('Segments_LineContinuation_JoinsTheWord', () => {
  assert.deepEqual(segmentos('rm -f d/na\\\nme.json').map((x) => x.texto), ['rm -f d/name.json']);
  assert.deepEqual(splitWords('rm -f d/na\\\nme.json'), ['rm', '-f', 'd/name.json']);
  assert.deepEqual(lits('d/na\\\nme.json'), ['d/name.json']);
  assert.deepEqual(tokens('d/na\\\nme.json'), ['d/name.json']);
  assert.deepEqual(segmentos('ls x |\\\n  xargs rm').map((x) => [x.texto, x.sep]), [['ls x', '|'], ['xargs rm', '']]);
});

// Dentro de `${…}` una `{` (o un `(`) suelta no anida: bash cierra en la primera `}` y ejecuta lo
// que sigue. Si el partidor se quedara en la palabra hasta el final, pegaría el comando siguiente a un `echo`.
test('Segments_UnbalancedBraceInsideParam_ClosesAtFirstBrace', () => {
  assert.deepEqual(segmentos('echo ${x:-{}; rm -f d/y').map((x) => x.texto), ['echo ${x:-{}', 'rm -f d/y']);
  assert.deepEqual(segmentos('cat ${x:-{} && rm -f d/y').map((x) => [x.texto, x.sep]), [['cat ${x:-{}', '&&'], ['rm -f d/y', '']]);
  assert.deepEqual(segmentos('echo ${x:-(}; rm -f d/y', { keepSubst: true }).map((x) => x.texto), ['echo ${x:-(}', 'rm -f d/y']);
  assert.deepEqual(splitWords('echo ${X:-{} y'), ['echo', '${X:-{}', 'y']);
  assert.deepEqual(lits('a/${X:-{}b'), ['a/*b'], 'el valor de la variable con operador es desconocido');
  // lo de siempre: una variable adentro de otra, y los indicadores de zsh, siguen enteros
  assert.deepEqual(segmentos('echo ${x:-${y}} | wc').map((x) => x.texto), ['echo ${x:-${y}}', 'wc']);
  assert.deepEqual(segmentos('echo ${(j:,:)a} ; ls').map((x) => x.texto), ['echo ${(j:,:)a}', 'ls']);
});

// Las opciones pasadas al INVOCAR el shell (`zsh -o braceccl -c`, `zsh --braceccl`, `bash -O extglob`)
// cambian cómo lee las palabras, igual que un `setopt`.
test('ChangesShellOptions_ShellInvokedWithOptions', () => {
  for (const c of ["zsh -o braceccl -c 'x'", "zsh --braceccl -c 'x'", "bash -O extglob -c 'x'", "sudo zsh -o kshglob -c 'x'",
    "zsh -fo extendedglob -c 'x'", "zsh --emulate ksh -c 'x'", "env zsh +o nomatch -c x"]) {
    assert.equal(changesShellOptions(parseSimpleCommand(c)), true, c);
  }
  for (const c of ["bash -lc 'x'", "zsh -fc 'x'", "bash -c 'x'", "bash -o pipefail -c 'x'", "bash --login -c 'x'", "sh -ec 'x'",
    "bash -c 'x' -o braceccl", 'zsh script.sh -o braceccl']) {
    assert.equal(changesShellOptions(parseSimpleCommand(c)), false, c);
  }
});

// Llaves anidadas a 1.600 niveles (unos 6 KB) no pueden desbordar la pila del expansor: la falla saldría como una
// excepción cualquiera y el freno caería en su red de emergencia. Es indecidible, con la palabra cruda como patrón.
test('ExpandWord_DeepNesting_IsUndecidable_NotACrash', () => {
  const w = 'a/pre-{index,' + '{x,'.repeat(1600) + 'y' + '}'.repeat(1600) + '}.json';
  let r;
  assert.doesNotThrow(() => { r = expandWord(w, { budget: new ExpansionBudget() }); });
  assert.equal(r.undecidable, true);
  assert.ok(r.patterns.some((p) => sp.patternToLiteral(p).startsWith('a/pre-')), JSON.stringify(r.patterns.slice(0, 2)));
  assert.doesNotThrow(() => expandWord('a(' + '(x|'.repeat(1600) + 'y' + ')'.repeat(1600) + ')'));
});

// Una reasignación seguida, sin ramas, REEMPLAZA el valor (como el shell). La unión queda para las ramas (`if`,
// `case`, lazos), para `&&`/`||` y para lo que corre en una subshell. Quien llama dice qué separador venía antes.
test('ApplyAssignments_SequentialReassignment_Replaces', () => {
  const ctx = { vars: {}, arrays: {} };
  sp.applyAssignments(ctx, parseSimpleCommand('OUT=d/prot'), { previousSep: '' });
  sp.applyAssignments(ctx, parseSimpleCommand('ls $OUT'), { previousSep: ';' });
  sp.applyAssignments(ctx, parseSimpleCommand('OUT=build'), { previousSep: ';' });
  assert.deepEqual(expandWord('$OUT/*', ctx).patterns, ['build/*']);
  // detrás de `&&` la asignación puede no correr: la unión
  const c2 = { vars: {}, arrays: {} };
  sp.applyAssignments(c2, parseSimpleCommand('D=d/prot'), { previousSep: '' });
  sp.applyAssignments(c2, parseSimpleCommand('D=t'), { previousSep: '&&' });
  assert.deepEqual(lits('$D', c2), ['d/prot', 't']);
  // sin decir el separador, la unión de siempre
  const c3 = { vars: {}, arrays: {} };
  sp.applyAssignments(c3, parseSimpleCommand('D=d/prot')); sp.applyAssignments(c3, parseSimpleCommand('D=t'));
  assert.deepEqual(lits('$D', c3), ['d/prot', 't']);
  // las ramas de un `if`, de un `case` y de un lazo se suman; después de cerrar, se vuelve a reemplazar
  assert.deepEqual(lits('$X', commandVariables('if c; then X=a; else X=b; fi')), ['a', 'b']);
  assert.deepEqual(lits('$X', commandVariables('X=a; case $y in q) X=b;; esac')), ['a', 'b']);
  assert.deepEqual(lits('$X', commandVariables('X=a; for i in 1; do X=b; done')), ['a', 'b']);
  assert.deepEqual(lits('$X', commandVariables('if c; then X=a; fi; X=z')), ['z']);
  assert.deepEqual(lits('$X', commandVariables('X=a; (X=b)')), ['a', 'b'], 'en una subshell no reemplaza');
  assert.deepEqual(lits('$X', commandVariables('X=a; X=b')), ['b']);
  assert.deepEqual(lits('$a', commandVariables('a=(p q); a=(r)')), ['r'], 'un arreglo también');
});

// Un salto de línea después de `&&`, `||` o `&` no cambia el separador: `a &&⏎ b` sigue siendo «b si a anduvo», y
// `a &⏎` sigue corriendo `a` en segundo plano. Leído como `;`, una asignación de ahí reemplazaba como si corriera seguro.
test('Segments_NewlineAfterOperator_KeepsTheOperator', () => {
  for (const op of ['&&', '||', '&']) {
    assert.deepEqual(segmentos(`a ${op}\nb`).map((x) => x.sep), [op, ''], op);
    assert.deepEqual(segmentos(`a ${op}\n\nb`).map((x) => x.sep), [op, ''], `${op} con dos saltos`);
  }
  assert.deepEqual(segmentos('a;\nb').map((x) => x.sep), [';', '']);
});

// Quien lleva datos propios de cada variable (de qué sustitución salió) tiene que saber cuáles se reemplazaron, para
// olvidar también lo suyo. Sólo cuentan las que el shell reemplaza seguro: no la unión ni el `X=a cmd` de un comando.
test('ApplyAssignments_Replaced_NamesWhatWasReplaced', () => {
  const ctx = { vars: {}, arrays: {} };
  sp.applyAssignments(ctx, parseSimpleCommand('F=a G=b'), { previousSep: '' });
  assert.deepEqual([...ctx.replaced].sort(), ['F', 'G']);
  sp.applyAssignments(ctx, parseSimpleCommand('F=c'), { previousSep: '&&' });
  assert.deepEqual([...ctx.replaced], [], 'detrás de && es la unión');
  sp.applyAssignments(ctx, parseSimpleCommand('F=c cmd'), { previousSep: ';' });
  assert.deepEqual([...ctx.replaced], [], 'sólo vale para ese comando');
  // `unset` puede fallar (una variable de sólo lectura) o borrar otra cosa (`-f`): no cuenta como reemplazo
  sp.applyAssignments(ctx, parseSimpleCommand('unset G'), { previousSep: ';' });
  assert.deepEqual([...ctx.replaced], []);
});

// Una comilla `'` después de un `\$` escapado o de `$$` no es `$'…'`: ahí `\'` no escapa. Si el partidor
// abriera una comilla que el shell no abre, escondería los comandos de después.
test('Segments_EscapedDollarBeforeQuote_IsNotAnsiC', () => {
  for (const pre of ["echo \\$'a\\'", "echo $$'a\\'"]) {
    const cmd = `${pre} ; rm -f d/y ; echo 'x'`;
    assert.deepEqual(segmentos(cmd).map((x) => x.texto), [pre, 'rm -f d/y', "echo 'x'"], cmd);
    assert.deepEqual(segmentos(cmd, { keepSubst: true }).map((x) => x.texto), [pre, 'rm -f d/y', "echo 'x'"], cmd);
  }
  assert.deepEqual(splitWords("echo \\$'a\\' b"), ['echo', "\\$'a\\'", 'b']);
  assert.deepEqual(lits("\\$'a\\'"), ['$a\\']);
  assert.deepEqual(lits("$'a\\'b'"), ["a'b"], "en un $'…' de verdad, \\' sigue escapando");
});

// `\ #`, `\;#` y `\>&`: lo escapado no es separador ni comentario ni redirección.
test('Segments_EscapedCharBeforeHashOrAmpersand', () => {
  assert.deepEqual(segmentos('echo a\\ #; rm -f d/y').map((x) => x.texto), ['echo a\\ #', 'rm -f d/y']);
  assert.deepEqual(segmentos('echo a\\;#; rm -f d/y').map((x) => x.texto), ['echo a\\;#', 'rm -f d/y']);
  assert.deepEqual(segmentos('echo x\\>& rm -f d/y').map((x) => [x.texto, x.sep]), [['echo x\\>', '&'], ['rm -f d/y', '']]);
  // lo de siempre: un comentario de verdad, y `2>&1`
  assert.deepEqual(segmentos('echo a # rm x\nls').map((x) => x.texto), ['echo a', 'ls']);
  assert.deepEqual(segmentos('echo a\\\\ # rm x').map((x) => x.texto), ['echo a\\\\']);
  assert.deepEqual(segmentos('cmd 2>&1 && ls').map((x) => x.texto), ['cmd 2>&1', 'ls']);
});

// Los patrones de un `case` adentro de `"$(…)"`: su `)` no cierra la sustitución; si la cerrara, lo que sigue quedaría
// como texto entre comillas que nadie juzgaría.
test('Segments_CaseInsideQuotedSubstitution', () => {
  const cmd = 'echo "$(case a in a) echo x;; esac; rm -f d/y)"';
  const k = segmentos(cmd, { keepSubst: true });
  assert.deepEqual(k.map((x) => x.texto), [cmd.slice(0)]);
  assert.deepEqual(sp.substitutions(k[0].texto), ['case a in a) echo x;; esac; rm -f d/y']);
  assert.deepEqual(segmentos(`${cmd}; ls`).map((x) => x.texto), [cmd, 'ls'], 'las comillas cierran donde cierran');
  assert.deepEqual(splitWords(cmd), ['echo', cmd.slice(5)]);
  // un `case` que no está en posición de comando no cambia nada
  assert.deepEqual(sp.substitutions('x "$(echo case in a) y"'), ['echo case in a']);
  assert.deepEqual(sp.substitutions('x "$(case a in (a) echo x;; esac)" z'), ['case a in (a) echo x;; esac']);
});

// `$'…'` en zsh: un escape que no conoce deja la letra (`\p` → `p`), y `\c` deja la `c`. Se unen las dos lecturas con bash.
test('ExpandWord_AnsiC_ZshReading', () => {
  assert.deepEqual(lits("$'\\p'x"), ['\\px', 'px']);
  assert.deepEqual(lits("d/$'pro\\c'du.json"), ['d/pro\\cdu.json', 'd/procdu.json'].sort());
  assert.ok(lits("$'a\\cDb'").includes('acDb'), 'zsh: \\cD es «cD»');
  assert.ok(lits("$'a\\cDb'").includes('a\x04b'), 'bash: \\cD es un carácter de control');
  assert.deepEqual(lits("$'\\x41\\101\\t'"), ['AA\t'], 'lo que los dos leen igual, una sola vez');
});

// Bash 3.2: una `}` sin coma ni rango en su grupo NO cierra la llave; sigue hasta la próxima `}` después de una coma
// (`{x},y}` da `x}` y `y`). La referencia son los shells de verdad, como en T1.
const PALABRAS_BASH_SIN_COMA = ['a{x},y}b', 'p{a}q,r}s', '{x},y}{c,d}', 'p{x\\},y}', 'p{a{x},y}', 'q{x}{a,b}', 'w{x},{a,b}'];
test('ExpandWord_BashBraceWithoutComma_KeepsScanning', { skip: OFF_REFERENCE }, () => {
  const shells = shellsDeReferencia();
  const faltan = shells.filter((s) => !s.ok).map((s) => s.nombre);
  if (faltan.length) assert.fail(`NO MEDIDO: falta ${faltan.join(', ')}`);
  const difieren = [];
  for (const w of PALABRAS_BASH_SIN_COMA) {
    const union = new Set();
    for (const sh of shells) {
      const r = sh.correr(w);
      if (r.status !== 0) assert.fail(`NO MEDIDO: ${sh.nombre} no pudo expandir «${w}» (${(r.stderr || '').trim()})`);
      for (const l of r.stdout.split('\n').slice(0, -1)) union.add(l);
    }
    const esperado = ordenar([...union]); const obtenido = ordenar(lits(w));
    if (JSON.stringify(esperado) !== JSON.stringify(obtenido)) difieren.push(`${w}: shells ${JSON.stringify(esperado)} · expandWord ${JSON.stringify(obtenido)}`);
  }
  assert.deepEqual(difieren, [], difieren.join('\n'));
  // muchas llaves que zsh y bash leen distinto: indecidible, no exponencial
  const t0 = Date.now(); const r = expandWord('{a}'.repeat(40) + ',}');
  assert.ok(Date.now() - t0 < 500); assert.equal(r.undecidable, true);
});

// Una barra invertida al final del comando entero: el shell la descarta (continuación contra el fin del texto).
test('Segments_TrailingBackslash_IsDropped', () => {
  assert.deepEqual(segmentos('cd d && rm -f name.json\\').map((x) => x.texto), ['cd d', 'rm -f name.json']);
  assert.deepEqual(splitWords('rm -f name.json\\'), ['rm', '-f', 'name.json']);
  assert.deepEqual(lits('name.json\\'), ['name.json']);
  assert.deepEqual(tokens('rm name.json\\'), ['rm', 'name.json']);
  assert.deepEqual(lits('a\\\\'), ['a\\'], 'una barra escapada sigue siendo una barra');
});

// Una subshell pegada a una palabra reservada (`then(…)`, `do(…)`, `time(…)`, `!(…)`) o detrás de la
// cabeza de un comando compuesto de zsh (`repeat N (…)`, `for i (…) (…)`, `if [[ … ]] (…)`, `coproc (…)`) se leería como un
// paréntesis de palabra: el comando de adentro no saldría como segmento y TODAS las reglas del freno quedarían ciegas.
test('Segments_SubshellAfterReservedWordOrZshHead', () => {
  const casos = ['repeat 1 (rm -f d/y)', 'if false; then :; else(rm -f d/y); fi', 'for i in 1; do(rm -f d/y); done',
    'for i (1) (rm -f d/y)', 'coproc (rm -f d/y)', 'if [[ -n x ]] (rm -f d/y)', 'time(rm -f d/y)', '!(rm -f d/y)',
    'while(rm -f d/y); do :; done', 'if true; then(rm -f d/y); fi', 'cd d && repeat 1 (rm -f d/y)', 'if (( 1 )) (rm -f d/y)'];
  for (const cmd of casos) {
    for (const opts of [undefined, { keepSubst: true }]) {
      assert.ok(segmentos(cmd, opts).some((x) => x.texto === 'rm -f d/y'), `${cmd}: ${JSON.stringify(segmentos(cmd, opts))}`);
    }
  }
  // variantes: `time` con su bandera y `coproc` con su nombre (y las cabezas `select`/`foreach`
  // de zsh) también abren una subshell; si no, la subshell entera queda como UNA palabra, el programa del comando
  for (const cmd of ['time -p (rm -f d/y)', 'time -p -- (rm -f d/y)', 'coproc p (rm -f d/y)', 'coproc P2 (rm -f d/y)',
    'select x (a b) (rm -f d/y)', 'foreach x (a b) (rm -f d/y)', 'if true; then time -p (rm -f d/y); fi']) {
    for (const opts of [undefined, { keepSubst: true }]) {
      assert.ok(segmentos(cmd, opts).some((x) => x.texto === 'rm -f d/y'), `${cmd}: ${JSON.stringify(segmentos(cmd, opts))}`);
    }
  }
  // un paréntesis con blancos como palabra entera no es un calificador que se pueda tirar: indecidible
  assert.equal(expandWord('(rm -f d/y)').undecidable, true);
  // …pero una sustitución de proceso no es un paréntesis de palabra: es desconocida, con su texto aparte
  for (const w of ['<(ls d | sort)', '>(tee d/x)', '=(ls d)']) {
    const r = expandWord(w);
    assert.deepEqual([r.patterns, r.undecidable, r.unknown, r.substitutions], [['*'], false, true, [w.slice(2, -1)]], w);
  }
  // lo de siempre: palabras con paréntesis siguen enteras
  assert.deepEqual(segmentos('rm -f p/x-*.json(N) a(b|c)').map((x) => x.texto), ['rm -f p/x-*.json(N) a(b|c)']);
  assert.deepEqual(segmentos('for f (a b) echo $f').map((x) => x.texto), ['for f (a b) echo $f']);
});
