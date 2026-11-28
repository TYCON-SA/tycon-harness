#!/usr/bin/env node
'use strict';
/**
 * bash-write-unresolved-path.test.js — el camino corto con una ruta de escritura armada con una variable.
 *
 * QUÉ CUIDA: que la puerta de la consola (`on-bash-write-gate.js`), con un camino corto con lista, juzgue la ruta REAL
 * cuando la variable se asigna en el mismo comando, y que cuando no la puede resolver frene diciendo «no pude resolver
 * la ruta», nunca «fuera de la lista» con un `<repo>/$D/x` que no es ningún archivo. Sin esto, un comando como
 * `D=<carpeta temporal>; mkdir -p $D && …; for f in …; do …; done; cat > $D/x` sale frenado como «fuera de la lista»:
 * un `for` en el comando deja todas sus variables sin leer.
 *
 * Y lo que no puede abrir: una variable armada a propósito (`..`, `$(…)`, dos asignaciones, comillas, la variable de un
 * bucle, una lista que nombra `$D/x`) nunca deja escribir fuera de la lista.
 *
 * stable-data: la firma del camino corto de prueba lleva la hora del momento (el portón la quiere reciente); ninguna
 * prueba compara con el reloj.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/bash-write-unresolved-path.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const bash = require(path.join(SCRIPTS, 'on-bash-write-gate.js'));
const { expandirRuta } = require(path.join(SCRIPTS, 'lib', 'command-vars.js'));

const SID = 'sesion-ruta';
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

/** Un repo con `src/a.js`, una carpeta temporal aparte y un camino corto firmado con la lista `src/a.js` (y `extra`). */
function corral(extra = []) {
  const raiz = tmp('ruta-var-');
  const repo = path.join(raiz, 'producto');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  fs.mkdirSync(path.join(repo, '.tycon'));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'x\n');
  const scratch = tmp('ruta-var-scratch-');
  const state = path.join(tmp('ruta-var-home-'), '.claude', '.tycon-pipeline');
  fs.mkdirSync(path.join(state, 'adhoc'), { recursive: true });
  const ts = new Date().toISOString();
  fs.writeFileSync(path.join(state, 'adhoc', `${SID}.json`), JSON.stringify({
    reason: 'arreglo del combo de clientes', maxFiles: 5, files: [], declaredAt: ts, lastTouch: ts, firmadaEn: ts,
    datos: 'sin-cambio', allowedFiles: [path.join(repo, 'src', 'a.js'), ...extra.map((e) => path.join(repo, e))],
  }));
  fs.appendFileSync(path.join(state, 'gates.log'), `${JSON.stringify({ ts, name: 'adhoc-lane-signed', status: 'ok', destino: SID })}\n`);
  const freno = (command) => {
    const r = bash.handle({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: SID, cwd: repo, tool_input: { command } },
      { stateDir: state, installedRoots: [] });
    return r && r.block ? r.block : '';
  };
  return { repo, scratch, state, freno };
}

const FUERA = /FUERA DE LA LISTA/;
const SIN_RESOLVER = /NO PUDE RESOLVER LA RUTA/;

// T1 VariableDelComando_SeJuzgaLaRutaReal
// 🔴 Falla con: un `for` en el comando que deja sin leer TODAS sus variables (la ruta queda `<repo>/$D/x`).
test('T1 VariableDelComando_SeJuzgaLaRutaReal — con un bucle en el comando también', () => {
  const { repo, scratch, freno } = corral();
  const pasan = [
    'D=src; cat > $D/a.js',
    'D="src"; cat > "$D/a.js"',
    `D=${scratch}; cat > $D/x.js`,
    // las formas de la lente de anoche: un bucle antes o después, y heredocs
    `D=${scratch}\ncat > $D/m7.pl <<'EOF'\ns/; \\[ "\\$\\(banco\\)" = no \\] && B=0//\nEOF\nfor m in m7 m8; do echo "== $m"; done`,
    `D=${scratch}; mkdir -p $D && S=${scratch}; for f in a b; do echo $S/$f; done\ncat > $D/COMO-SE-CORRIO.txt <<'EOF'\nx\nEOF`,
    // la segunda asignación manda
    `D=src; D=${scratch}; cat > $D/b.js`,
    // lo que el shell pone y no trae barras: la carpeta se sabe
    `cat > ${scratch}/salida-$$.txt`,
  ];
  for (const c of pasan) assert.equal(freno(c), '', c);
  const fuera = [
    'D=src; cat > $D/b.js',
    "D='src'; cat > \"$D/b.js\"",
    `D=${scratch}; D=src; cat > $D/b.js`,
    `D=${scratch}; cat > $D/x.md; D=src; cat > $D/b.js`,
    'D=src/../src; cat > $D/b.js',
    'D=../producto/src; cat > $D/b.js',
    'export D=src; cat > $D/b.js',
    `D=${scratch}; for f in a; do echo $f; done; D=src; cat > $D/b.js`,
  ];
  for (const c of fuera) {
    const b = freno(c);
    assert.match(b, FUERA, c);
    assert.ok(b.includes(`${path.join(repo, 'src', 'b.js')} no está en la lista`), `la ruta del mensaje es la real: ${c}\n${b}`);
  }
  assert.match(freno('cat > src/b-$$.js'), FUERA, 'con la carpeta sabida, el archivo igual está fuera de la lista');
});

// T2 VariableQueNoSeResuelve_FrenaDiciendoQueNoPudo
// 🔴 Falla con: decir «fuera de la lista» con `<repo>/$D/x`, o dejar pasar la ruta por su texto.
test('T2 VariableQueNoSeResuelve_FrenaDiciendoQueNoPudo — $(…), bucles, afuera, prefijo', () => {
  const { scratch, freno } = corral();
  const casos = [
    'D=$(echo src); cat > $D/a.js',
    'D=`echo src`; cat > $D/a.js',
    'cat > $NADIE_DEFINIDA/a.js',
    "D='$X'; cat > $D/a.js",
    // la variable del bucle, y lo que se asigna adentro, puede ser cualquier cosa después
    `D=${scratch}; for D in src; do :; done; cat > $D/b.js`,
    `D=${scratch}; time for D in src; do :; done; cat > $D/b.js`,
    `D=${scratch}; for x in a; do D=src; done; cat > $D/b.js`,
    `D=${scratch}; time for x in a; do D=src; done; cat > $D/b.js`,
    `D=${scratch}; for ((i=0;i<1;i++)); do D=src; done; cat > $D/b.js`,
    `D=${scratch}; for f in ../producto/src/b.js; do echo 1 > ${scratch}/$f; done`,
    // una reasignación más adelante en el mismo cuerpo vale desde la segunda vuelta
    `D=${scratch}; for i in 1 2; do cp src/a.js $D/b.js; D=src; done`,
    `D=${scratch}; while true; do cp src/a.js $D/b.js; D=src; done`,
    // `$$` al lado de una variable que no se sabe no la esconde
    'D=$(echo src); cat > $D/b$$.js',
    // puede no haber pasado, o corre en otro lado
    `D=${scratch}; true && D=src; cat > $D/b.js`,
    `D=${scratch}; (D=src; cat > $D/b.js)`,
    `D=${scratch}; eval D=src; cat > $D/b.js`,
    `D=${scratch}; read D <<< src; cat > $D/b.js`,
    'D=src cat > $D/a.js',
    // una carpeta fija con una variable que no se sabe: la variable puede traer `..`
    `cat > ${scratch}/$F_DE_AFUERA`,
  ];
  for (const c of casos) {
    const b = freno(c);
    assert.match(b, SIN_RESOLVER, c);
    assert.doesNotMatch(b, FUERA, c);
  }
  assert.match(freno('D=$(echo src); cat > $D/a.js'), /«\$D\/a\.js» y no pude saber qué vale \$D/, 'nombra la ruta y la variable');
});

// T3 ListaQueNombraElTexto_NoAbre
// 🔴 Falla con: juzgar la ruta sin resolver por su texto: una lista con `$D/x.js` dejaría escribir cualquier archivo.
test('T3 ListaQueNombraElTexto_NoAbre — ni el papeleo por su texto', () => {
  const { state, freno } = corral(['$D/x.js']);
  assert.match(freno('D=$(echo src); cat > $D/x.js'), SIN_RESOLVER);
  assert.match(freno('cat > .advisors/pipeline-runs/x-1/step-05b-probes/$D/COMO-SE-CORRIO.txt'), SIN_RESOLVER);
  // el freno que el portón no dio queda en el registro, como los demás
  const log = fs.readFileSync(path.join(state, 'gates.log'), 'utf8');
  assert.match(log, /"kind":"adhoc-path-unresolved"/);
});

// T3b SinBarras_SoloLoQueElShellPone
// 🔴 Falla con: dejar pasar cualquier variable desconocida, o una mezcla de `$$` con una que puede traer `..`.
test('T3b SinBarras_SoloLoQueElShellPone — $$, $! y $? pasan; $RANDOM u otra variable, no', () => {
  const { scratch, freno } = corral();
  for (const c of [`cat > ${scratch}/x-$$.txt`, `cat > ${scratch}/x-$!.txt`, `cat > ${scratch}/x-$$-$?.txt`]) {
    assert.equal(freno(c), '', c);
  }
  // con `unset RANDOM`, `$RANDOM` es una variable común y puede traer `..`
  for (const c of [`cat > ${scratch}/x-$$-$OTRA_DE_AFUERA.txt`, `cat > ${scratch}/$ID_DE_AFUERA`, `cat > ${scratch}/x-$RANDOM.txt`,
    `unset RANDOM; RANDOM=../producto/src; cat > ${scratch}/$RANDOM/b.js`]) {
    assert.match(freno(c), SIN_RESOLVER, c);
  }
});

// T4 Lector_LaVariableDelForNoBorraLasDemas
// 🔴 Falla con: un `for` que deja todo en «no sé», o que deja su variable con el valor de antes.
test('T4 Lector_LaVariableDelForNoBorraLasDemas', () => {
  const cmd = 'D=/x; for f in a b; do echo $f; done; cat > $D/y; cat > $D/$f';
  assert.deepEqual(expandirRuta(cmd, '$D/y', { env: {} }), { valor: '/x/y', sinResolver: [] });
  assert.deepEqual(expandirRuta(cmd, '$D/$f', { env: {} }).sinResolver, ['f']);
  // la variable del bucle tapa una asignación de antes con el mismo nombre
  assert.deepEqual(expandirRuta('f=/ok; for f in a; do :; done; cat > $f/z', '$f/z', { env: {} }).sinResolver, ['f']);
  // `for` como palabra suelta (no es un bucle) marca de más, nunca de menos
  assert.deepEqual(expandirRuta('D=/x; echo wait for D; cat > $D/y', '$D/y', { env: {} }).sinResolver, ['D']);
  // un `for` sin nombre detrás, o `for ((…))`, no se lee
  for (const c of ['D=/x; for ((i=0;i<2;i++)); do :; done; cat > $D/y', 'D=/x; for\nD in a; do :; done; cat > $D/y']) {
    assert.deepEqual(expandirRuta(c, '$D/y', { env: {} }).sinResolver, ['D'], c);
  }
});

// T5 CopiaDentroDeUnBloque_SeVe
// Una copia, un movimiento o un `sed -i` dentro de un bucle, de un `if` o de un paréntesis escribe igual que suelto.
// 🔴 Falla con: buscar el comando sólo al principio del tramo, donde está la palabra del bloque (`do cp …`).
test('T5 CopiaDentroDeUnBloque_SeVe — for, if, while, until, paréntesis y llaves', () => {
  const { freno } = corral();
  const casos = [
    'for f in x; do cp src/a.js src/b.js; done',
    'if true; then cp src/a.js src/b.js; fi',
    'if true; then :; else cp src/a.js src/b.js; fi',
    'if false; then :; elif true; then cp src/a.js src/b.js; fi',
    '! cp src/a.js src/b.js',
    "if true; then sed -i '' 's/a/b/' src/b.js; fi",
    'if cp src/a.js src/b.js; then :; fi',
    'while false; do mv src/a.js src/b.js; done',
    'until true; do cp src/a.js src/b.js; done',
    '(cp src/a.js src/b.js)',
    'true && { cp src/a.js src/b.js; }',
    'time cp src/a.js src/b.js',
    "for f in x; do sed -i '' 's/a/b/' src/b.js; done",
    'for f in x\ndo\n  cp src/a.js src/b.js\ndone',
  ];
  for (const c of casos) assert.match(freno(c), FUERA, c);
  assert.equal(freno('for f in x; do cp src/b.js src/a.js; done'), '', 'el destino de la lista pasa');
});

// T6 LoQueEncontroElPase_Frena
// Las formas que el pase adversarial confirmó escribiendo fuera de la lista.
// 🔴 Falla con: un `${…}` con operador contado como «sin barras», un bucle que empieza en el `do` (la condición de un
// `while` vuelve a correr), un `done` falso después de `\`+salto de línea, o una asignación en la condición sin leer.
test('T6 LoQueEncontroElPase_Frena — operadores, condición del while, done falso, asignación en la condición', () => {
  const { scratch, freno } = corral();
  const casos = [
    // el `${…}` del shell va en un texto entre comillas simples, para que JavaScript no lo interpole
    `cat > ${scratch}/` + '${RANDOM:+..}/producto/src/b.js',
    `cat > ${scratch}/` + '${LINENO:+..}/producto/src/b.js',
    `cat > ${scratch}/` + '${RANDOM/#*/..}/producto/src/b.js',
    `X=../producto/src; D=X; cat > ${scratch}/` + '${!D}/b.js',
    `D=${scratch}; while cp src/a.js $D/b.js; do D=src; done`,
    `D=${scratch}; until ! cp src/a.js $D/b.js; do D=src; done`,
    `D=${scratch}; while cp src/a.js $D/b.js && D=src; do :; done`,
    `D=${scratch}; for i in 1 2; do cp src/a.js $D/b.js; echo y\\\ndone; D=src; done`,
    `D=${scratch}; while D=src; false; do :; done; cp src/a.js $D/b.js`,
    `D=${scratch}; if D=src; then :; fi; cat > $D/b.js`,
    // un bucle adentro de otro, y `!` delante de una asignación (que queda puesta igual)
    `D=${scratch}; while true; do for i in 1; do cp src/a.js $D/b.js; done; D=src; done`,
    `D=${scratch}; ! D=src; cat > $D/b.js`,
  ];
  for (const c of casos) assert.notEqual(freno(c), '', c);
  // y lo de todos los días sigue pasando
  assert.equal(freno(`D=${scratch}; cat > $D/x.md; for i in a b; do echo $i; done`), '');
});

// T7 LoQueEncontroLaSegundaPasada_Frena
// Las formas que la segunda pasada del pase adversarial confirmó escribiendo fuera de la lista (casi todas ya pasaban
// en main): la palabra del bloque pegada al paréntesis, el `)` pegado al archivo, un `&` solo, `sed -i` sobre una
// variable y una `\`+salto de línea en medio de una asignación.
// 🔴 Falla con: buscar el comando sólo después de `do ` con espacio, cortar sólo en `&&`, o leer `D\<salto>=src` como otra cosa.
test('T7 LoQueEncontroLaSegundaPasada_Frena — do(, (sed …), &, sed -i $f, \\+salto en la asignación', () => {
  const { scratch, freno } = corral();
  const casos = [
    'for f in x; do(mv src/a.js src/b.js); done',
    'if true;then(cp src/a.js src/b.js);fi',
    'if true; else(cp src/a.js src/b.js); fi',
    "(sed -i '' s/a/b/ src/b.js)",
    "true && (sed -i '' s/a/b/ src/b.js)",
    'echo hi & mv src/a.js src/b.js',
    "echo hi & sed -i '' s/a/b/ src/b.js",
    "for f in src/b.js; do sed -i '' 's/x/y/' $f; done",
    "f=src/b.js; sed -i '' s/x/y/ $f",
    `D=${scratch}; echo a; D\\\n=src; cat > $D/b.js`,
    `D=${scratch}; export D\\\n=src; cat > $D/b.js`,
    "echo hi |& sed -i '' s/a/b/ src/b.js",
    // `$$` al lado de una variable resuelta: el portón vería el texto (que acá parece papeleo), no la ruta real
    'D=../../../../src; cat > .advisors/pipeline-runs/x-1/step-05b-probes/$D/b$$.js',
  ];
  for (const c of casos) assert.notEqual(freno(c), '', c);
  // lo de todos los días sigue pasando: una redirección con `&` no corta, y lo que va en segundo plano se juzga igual
  assert.equal(freno(`ls 2>&1 > ${scratch}/salida.txt`), '');
  assert.equal(freno(`sleep 1 & cp src/a.js ${scratch}/copia.txt`), '');
  assert.equal(freno("(sed -i '' s/a/b/ src/a.js)"), '', 'el archivo de la lista, entre paréntesis, pasa');
});

// T8 LoQueEncontroLaTerceraPasada_Frena
// Lo que la tercera pasada encontró abierto por este cambio (main lo frenaba): una barra escapada antes de un salto de
// línea, un `trap … DEBUG`, un `\&` dentro de un sed, y la palabra de un bucle adentro de un `$(…)` de la condición.
// 🔴 Falla con: tomar `\\`+salto como continuación, no contar `trap` como algo que asigna, cortar en un `\&`, o arrancar
// el bucle de afuera en el `for` de un `$(…)`.
test('T8 LoQueEncontroLaTerceraPasada_Frena — \\\\+salto, trap, \\&, bucle en $(…)', () => {
  const { scratch, freno } = corral();
  const casos = [
    `D=${scratch}; echo \\\\\n D=src; cat > $D/b.js`,
    `D=${scratch}; for i in 1 2; do cat > $D/b.js; echo \\\\\n  D=src; done`,
    `D=${scratch}; trap 'D=src' DEBUG; for i in 1; do :; done; cat > $D/b.js`,
    'sed -i s/foo/x\\&y/ src/b.js',
    'perl -pi -e s/foo/x\\&y/ src/b.js',
    `D=${scratch}; while true && cp src/a.js $D/b.js && x=$(for i in 1; do :; done); do D=src; done`,
  ];
  for (const c of casos) assert.notEqual(freno(c), '', c);
});

// T9 CdQueElFrenoNoSigue_FrenaLoRelativo
// Un `cd` adentro de un paréntesis o de un bucle cambia la carpeta de lo que se escribe después, y el freno sólo sigue
// el `cd` del principio del comando: lo relativo frena diciendo que no se sabe la carpeta.
// 🔴 Falla con: resolver `src/a.js` contra la carpeta de la sesión cuando un `cd` de adentro la cambió.
test('T9 CdQueElFrenoNoSigue_FrenaLoRelativo — cd en un paréntesis o en un bucle', () => {
  const { scratch, freno } = corral();
  for (const c of ['(cd docs && cp src/a.js src/a.js)', '( cd .. && cp src/a.js src/a.js )', 'D=src; for i in 1; do cd /; cp src/a.js $D/a.js; done',
    '(cd docs; cp src/a.js src/a.js) && echo ok', 'pushd docs; cp src/a.js src/a.js; popd']) {
    assert.match(freno(c), SIN_RESOLVER, c);
  }
  // el `cd` del principio se sigue como siempre, y una ruta entera no depende de la carpeta
  assert.match(freno('cd docs && cp src/a.js src/a.js'), FUERA);
  assert.equal(freno('cp src/a.js src/a.js'), '');
  assert.equal(freno(`(cd docs && cp src/a.js ${scratch}/copia.js)`), '');
});

// T11 CarpetaDeMktemp_SeSabeDondeQueda
// 🔴 Falla con: tomar `$(mktemp …)` como «no sé»: una escritura a una carpeta temporal del laboratorio salía frenada
// como fuera de la lista (medido en la revisión de precisión). Lo que la deja caer en el repo sigue frenando.
test('T11 CarpetaDeMktemp_SeSabeDondeQueda — la carpeta temporal pasa; un molde relativo, un TMPDIR del comando o un .. al repo, no', () => {
  const { repo, freno } = corral();
  const pasan = [
    'T=$(mktemp -d /tmp/probe.XXXXXX); echo x > $T/probe.js',
    'P="$(mktemp -d /tmp/probe.XXXXXX)"; cat > $P/probe.js <<\'EOF\'\nx\nEOF',
    'T=$(mktemp -d); echo x > $T/a.js',
    'T=$(mktemp -d -t lab); echo x > $T/a.js',
  ];
  for (const c of pasan) assert.equal(freno(c), '', c);
  // un molde relativo cae en la carpeta del comando (el repo): fuera de la lista
  assert.match(freno('T=$(mktemp -d lab.XXXX); echo x > $T/a.js'), FUERA);
  // con `..` la cuenta de carpetas es la del molde: vuelve al repo
  const subir = path.relative('/tmp/x.XXXX', path.join(repo, 'src', 'b.js'));
  assert.match(freno(`T=$(mktemp -d /tmp/x.XXXX); echo x > $T/${subir}`), FUERA);
  // un TMPDIR del mismo comando, una forma que no se lee o un mktemp con otro comando adentro: no se sabe
  // y un PATH del mismo comando, que puede hacer de `mktemp` otro programa (hallazgo del pase adversarial)
  for (const c of ['TMPDIR=src; T=$(mktemp -d); echo x > $T/a.js', 'T=$(mktemp --tmpdir=src x); echo x > $T/a.js',
    'PATH=/tmp/ev:$PATH; T=$(mktemp -d /tmp/x.XXXX); echo x > $T/a.js',
    'T=$(mktemp -d /tmp/a.XX; echo src); echo x > $T/a.js', "T='$(mktemp -d)'; echo x > $T/a.js"]) {
    assert.match(freno(c), SIN_RESOLVER, c);
  }
  assert.deepStrictEqual(expandirRuta('T=$(mktemp -d /tmp/p.XXXX); cat > $T/x', '$T/x'), { valor: '/tmp/p.XXXX/x', sinResolver: [], temporal: true });
  // y a través de otra asignación
  assert.equal(expandirRuta('T=$(mktemp -d /tmp/p.XXXX); U=$T/sub; cat > $U/x', '$U/x').temporal, true);
  assert.equal(expandirRuta('D=/tmp/fija; cat > $D/x', '$D/x').temporal, undefined);
  // un TMPDIR relativo en el ambiente: mktemp lo usa relativo, no `/tmp`
  assert.deepStrictEqual(expandirRuta('T=$(mktemp -d); cat > $T/x', '$T/x', { env: { TMPDIR: 'src' } }).sinResolver, ['T']);
});

// T12 EscapesEnElValor_ComoLosQuitaBash
// 🔴 Falla con (A214): el valor guardaba los escapes (`ca\rpeta`), y bash escribe en `carpeta`.
test('T12 EscapesEnElValor_ComoLosQuitaBash — fuera de comillas se quitan, entre comillas dobles casi nunca', () => {
  const v = (cmd, raw = '$F/x.txt') => expandirRuta(cmd, raw, { env: {} });
  assert.deepEqual(v('F=/tmp/ca\\rpeta; echo x > $F/x.txt'), { valor: '/tmp/carpeta/x.txt', sinResolver: [] });
  assert.ok(v('F=/tmp/una\\ carpeta; echo x > $F/x.txt').sinResolver.length, 'un blanco escapado no lo lee la asignación: «no sé»');
  assert.deepEqual(v('F="/tmp/ca\\rpeta"; echo x > $F/x.txt'), { valor: '/tmp/ca\\rpeta/x.txt', sinResolver: [] }, 'entre comillas dobles `\\r` queda');
  assert.deepEqual(v('F="/tmp/a\\\\b"; echo x > $F/x.txt'), { valor: '/tmp/a\\b/x.txt', sinResolver: [] }, 'entre comillas dobles `\\\\` es una');
  assert.deepEqual(v("F=/tmp/'ca\\r'peta; echo x > $F/x.txt"), { valor: '/tmp/ca\\rpeta/x.txt', sinResolver: [] }, 'un tramo entre comillas simples es literal');
  assert.ok(v('F=/tmp/\\$HOME; echo x > $F/x.txt').sinResolver.length, 'un `$` escapado es literal: no se sabe representar, «no sé»');
  // de la revisión de Fable: lo que bash lee distinto y quitar comillas no alcanza
  assert.deepEqual(v("F='/tmp/est''ado'; echo x > $F/x.txt"), { valor: '/tmp/estado/x.txt', sinResolver: [] }, 'comillas simples con comillas adentro');
  for (const c of ["F=$'/tmp/estado'; echo x > $F/x.txt", "F=/tmp/est$'\\141'do; echo x > $F/x.txt", 'F=$"/tmp/estado"; echo x > $F/x.txt',
    "x=esta; xdo=/tmp/q; F=/tmp/$x''do; echo x > $F/x.txt", 'x=esta; xdo=/tmp/q; F=/tmp/"$x"do; echo x > $F/x.txt', 'x=esta; xdo=/tmp/q; F=/tmp/$x\\do; echo x > $F/x.txt']) {
    assert.ok(v(c).sinResolver.length, `«no sé»: ${c}`);
  }
  for (const c of ['x=a/b; F=/tmp/$\\x/../estado; echo x > $F/x.txt', 'x=a/b; F=/tmp/$\\{x}/../estado; echo x > $F/x.txt']) {
    assert.ok(v(c).sinResolver.length, `un \`$\` escapado es literal: «no sé»: ${c}`);
  }
  assert.deepEqual(v('U=/u; F="$U\\Desktop"; echo x > $F/x.txt'), { valor: '/u\\Desktop/x.txt', sinResolver: [] }, 'entre comillas dobles la contrabarra no corta el nombre: queda');
  assert.deepEqual(v('U=/u; F="$U"/d; echo x > $F/x.txt'), { valor: '/u/d/x.txt', sinResolver: [] }, 'una comilla seguida de barra no pega nombres');
});
