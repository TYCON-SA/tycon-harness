#!/usr/bin/env node
/**
 * bash-write-long-blanks.test.js — una tirada larga (de espacios, `;` o renglones) no vuelve lento al freno de consola.
 *
 * Con las expresiones que se prueban acá contra sus reemplazos, una tirada larga dentro de un comando hace al freno
 * cúbico o cuadrático: el motor la prueba desde cada posición, y el freno no llega a decidir en sus 20 s y frena un
 * comando sano. Son el cierre (`\s*;?\s*[)}]\s*$`) y el comentario del final (`\s+#[^'"]*$`) de un tramo, el recorte de
 * cada línea al buscar heredocs (`^[ \t]+|[ \t]+$`), la partición en segmentos (`\s*…\s*`), los blancos de antes de una
 * redirección (`[ \t]*…>`), la carpeta delante de un `sh -c` (`\S*\/`) y los blancos después del separador en la de
 * borrados (`\s*`). Sus reemplazos se hacen a mano, o sin la parte que crece, con el mismo resultado.
 *
 *   BLANKS1  el cierre y el comentario a mano dan lo mismo que las expresiones de antes (casos y textos al azar)
 *   BLANKS2  el recorte de las puntas a mano da lo mismo que la expresión de antes
 *   BLANKS6  el gancho entero decide en menos de 5 s de CPU con 40 KB de `cp a b <<<x;` repetido, 40 KB de `<` detrás
 *            de un cp y 200 KB de `cp a b \` en renglones continuados
 *   BLANKS3  el gancho entero decide en menos de 3 s de CPU con 40 KB en cinco formas (espacios en un heredoc, `;` en un
 *            heredoc, espacios en `bash -c`, espacios por un tubo a `sh`, renglones vacíos en un heredoc)
 * El gancho entero se mide por el tiempo de CPU de su proceso, no por el reloj de pared: en una máquina cargada (la CI
 * con varias suites a la vez y la cola llena) el reloj cuenta también lo que el proceso esperó su turno, y una prueba
 * sana quedaba en rojo. La CPU cuenta el trabajo del gancho, que es lo que crece con una expresión mala. Pero la CPU
 * tampoco es la misma en toda máquina: un núcleo lento o la memoria apretada la inflan (la CI llegó a 8,5 s con el
 * freno sano). Por eso, si pasa el tope, se mide además la misma forma con un octavo del largo: lo que delata una
 * expresión mala es cómo crece (sana, unas 5 veces; cuadrática, más de 10), y una máquina lenta infla las dos medidas
 * por igual.
 *   BLANKS4  los segmentos, las redirecciones, el `sh -c` y la de borrados dan lo mismo que las expresiones de antes
 *   BLANKS5  los destinos se leen en menos de 1,5 s con 150 KB de `$(` o `${` sin cerrar detrás de `>` o `<`
 *   BLANKS7  los destinos de un `cp` se leen en menos de 1,5 s con 100 KB de blancos o tabuladores entre sus palabras
 *   BLANKS8  los destinos se leen en menos de 1,5 s con 200 KB de `>|` o `>&|` seguidos, y con `sed -i` repetidos el
 *            tiempo crece como el largo, no como su cuadrado
 *   BLANKS9  los cuerpos de 3.000 heredocs en un renglón se leen en menos de 1,5 s
 * 🔴 Nada toca el HOME real: el gancho corre en un proceso hijo con una casa de juguete.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const HOOK = path.join(SCRIPTS, 'on-bash-write-gate.js');
const bash = require(HOOK);
const SP = require(path.join(SCRIPTS, '..', '..', '..', 'scripts', 'lib', 'shell-parse.js'));

// lo de antes, tal cual, para comparar
const cierreDeAntes = (t) => t.replace(/\s*;?\s*[)}]\s*$/, '');
const comentarioDeAntes = (t) => t.replace(/\s+#[^'"]*$/, '');
const puntasDeAntes = (t) => t.replace(/^[ \t]+|[ \t]+$/g, '');

// textos al azar con lo que importa: blancos de cada clase, `#`, cierres, comillas y letras
const ALF = [' ', ' ', '\t', '\n', '\r', ' ', '#', ';', ')', '}', '(', '{', "'", '"', 'a', 'b'];
function alAzar(cuantos, semilla = 7) {
  const out = [];
  let s = semilla;
  const azar = (n) => { s = (s * 1103515245 + 12345) % 2147483648; return s % n; };
  for (let i = 0; i < cuantos; i++) {
    let t = '';
    for (let j = azar(14); j > 0; j--) t += ALF[azar(ALF.length)];
    out.push(t);
  }
  return out;
}

// 🔴 mutación: el comentario desde un `#` antes de la última comilla, o sin los blancos que lo preceden; el cierre sin
// el `;`, con dos `;`, o sin los blancos de antes del `;`.
test('BLANKS1 CierreYComentario_ALaMano_IgualQueAntes', () => {
  const casos = ['a; )', 'a ; )', 'a;)', 'a ;;)', 'a }', 'a', ')', ' ; }', 'a)b', 'echo x # nota', 'echo "#" # nota',
    "echo 'a' #b'c", 'a#b', 'a\t#\tc', '# solo', 'a  #  b  # c', 'x "y" z # w', 'a \n# b'];
  for (const t of [...casos, ...alAzar(20000)]) {
    assert.strictEqual(bash.sinComentarioAlFinal(t), comentarioDeAntes(t), `comentario: ${JSON.stringify(t)}`);
    const recortado = t.trim();
    assert.strictEqual(bash.sinCierre(recortado), cierreDeAntes(recortado), `cierre: ${JSON.stringify(recortado)}`);
  }
});

// 🔴 mutación: recortar también otros blancos (el `\r`, el espacio duro) o sólo una punta.
test('BLANKS2 PuntasDeLaLinea_ALaMano_IgualQueAntes', () => {
  for (const t of ['  a  ', '\ta\t', ' \r a \r ', ' a ', '', '   ', 'a', ...alAzar(20000, 11)]) {
    assert.strictEqual(SP.sinBlancosDeLasPuntas(t), puntasDeAntes(t), JSON.stringify(t));
  }
});

// lo de antes de la segunda vuelta (los blancos de al lado con `\s*`), con los separadores de hoy: el `|` de `>|` y de
// `>&|` no parte, salvo con un `\` impar delante del `>`
const segmentosDeAntes = (c) => String(c).split(/\s*(?:&&|\|\||(?<!(?<!\\)(?:\\\\)*>&?)\|&|;|(?<!(?<!\\)(?:\\\\)*>&?)\||\n|(?<![<>&|\\])&(?![&>]))\s*/).filter(Boolean);
const redireccionesDeAntes = (t) => t.replace(/[ \t]*(?:&|\d)?>{1,2}(?:\||&)?[ \t]*(?:'[^']*'|"[^"]*"|[^\s'"|;&<>]+)?/g, ' ');
const SHELL_CON_C_DE_ANTES = /(?:^|[\s;&|(`])(?:\S*\/)?(?:ba|z|k|da|fi|c|tc)?sh\b(?:\s+(?:--?[A-Za-z][\w-]*|[+-][oO]\s+(?:[^\s+-]|\+(?![oO](?:\s|$))|-(?![-A-Za-z])|--(?![A-Za-z]))\S*|\+[oO](?=\s)))*?\s+-[A-Za-z]*c\s+(?=['"])/g;
const finales = (re, s) => [...s.matchAll(re)].map((m) => m.index + m[0].length);

// 🔴 mutación: los segmentos sin sacar los blancos de al lado de un separador, o sacando los de las puntas del comando;
// la redirección sin los blancos de antes; la carpeta del shell que no deja empezar en un separador.
test('BLANKS4 Segmentos_Redirecciones_ShellConC_IgualQueAntes', () => {
  const alfabeto = (alf, cuantos, semilla) => alAzar(cuantos, semilla).map((t) => [...t].map((c, i) => alf[(c.charCodeAt(0) + i) % alf.length]).join(''));
  for (const t of ['a ; b', '  a; b  ', 'a \n\n b', 'x >& y & z', 'a && b || c | d', 'a\\ & b', ' ; ; ', ...alfabeto([' ', '\t', '\n', '&', '|', ';', '<', '>', '\\', 'a', '\r'], 20000, 3)]) {
    assert.deepStrictEqual(bash.splitSegments(t), segmentosDeAntes(t), `segmentos: ${JSON.stringify(t)}`);
  }
  for (const t of ['rm a > b', 'rm a  2>>"c d"', 'x &>|y', 'a2 >x', '"a  >b"', ...alfabeto([' ', '\t', '>', '&', '2', '|', "'", '"', ';', '<', 'a'], 20000, 5)]) {
    assert.strictEqual(bash.blancoPorRedireccion(t), redireccionesDeAntes(t), `redirección: ${JSON.stringify(t)}`);
  }
  for (const t of ["x;/bin/sh -c 'y'", "a|b/sh -c 'x'", "bash --norc -o pipefail -c \"x\"", "xargs sh -c 'y'", "x/;sh -c 'y'", "a;b;c/zsh -c 'q'",
    ...alfabeto([' ', ';', '&', '|', '(', '`', '/', 's', 'h', '-', 'c', 'o', "'", '"', 'b', 'a'], 20000, 9)]) {
    assert.deepStrictEqual(finales(bash.SHELL_CON_C, t), finales(SHELL_CON_C_DE_ANTES, t), `sh -c: ${JSON.stringify(t)}`);
  }
  // la de borrados: después del separador, `\s*` antes; ahora los blancos no cruzan un salto de línea (otro separador)
  const borraDeAntes = new RegExp(bash.BORRA_O_MUEVE.source.replace('[^\\S\\n]*(?:[^\\s;&|()', '\\s*(?:[^\\s;&|()'), 'i');
  assert.notStrictEqual(borraDeAntes.source, bash.BORRA_O_MUEVE.source, 'se armó la expresión de antes');
  for (const t of [';\n del x', ';\r del x', 'cmd /c\n del x', '"\n\n erase y', 'la deuda del cliente', '\n rd z',
    ...alfabeto([' ', '\t', '\n', '\r', ';', '&', '|', '(', '`', "'", '"', 'd', 'e', 'l', 'r', 'm', 'i'], 20000, 17)]) {
    assert.strictEqual(bash.BORRA_O_MUEVE.test(t), borraDeAntes.test(t), `borrados: ${JSON.stringify(t)}`);
  }
});

// La marca con que el proceso del gancho dice, al salir, cuánta CPU gastó (todos sus hilos, en ms).
const MARCA_CPU = '__blanks_cpu_ms=';
const CPU_AL_SALIR = `process.on('exit', () => { const u = process.cpuUsage(); process.stderr.write('\\n${MARCA_CPU}' + Math.round((u.user + u.system) / 1000) + '\\n'); });\n`;

// El gancho entero con un comando, en una casa de juguete: `{ status, stderr, ms }`, con `ms` la CPU que gastó su proceso
// (Infinity si no llegó a decirla: lo cortó el tope de 60 s o murió).
function correrElGancho(comando) {
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'blanks-casa-'));
  fs.mkdirSync(path.join(casa, '.claude'), { recursive: true });
  try {
    const cpu = path.join(casa, 'cpu-al-salir.js');
    fs.writeFileSync(cpu, CPU_AL_SALIR);
    const entrada = JSON.stringify({ session_id: 'blanks', cwd: os.tmpdir(), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: comando } });
    const r = spawnSync(process.execPath, ['--require', cpu, HOOK], { input: entrada, encoding: 'utf8', timeout: 60000, maxBuffer: 1 << 26,
      env: { ...process.env, HOME: casa, USERPROFILE: casa, TYCON_HOME: path.join(casa, '.tycon') } });
    const salida = `${r.stdout || ''}${r.stderr || ''}`;
    const m = new RegExp(`${MARCA_CPU}(\\d+)`).exec(salida);
    return { status: r.status, stderr: salida, ms: m ? Number(m[1]) : Infinity };
  } finally { fs.rmSync(casa, { recursive: true, force: true }); }
}

// Con un octavo del largo, el gancho sano gasta como mucho esta fracción de lo que gasta con el largo entero (medido: 4 a
// 5 veces menos; la expresión cuadrática de la fila 257, más de 10).
const CRECE_COMO_MUCHO = 7;

// El gancho decide la forma armada con `largo` en menos de `topeMs` de CPU, o, en una máquina lenta que pasa el tope,
// su CPU crece con el largo como la de un gancho sano.
function decideEnSegundos(forma, armar, largo, topeMs) {
  const r = correrElGancho(armar(largo));
  assert.doesNotMatch(r.stderr, /no alcanzó a decidir/, forma);
  if (r.ms < topeMs) return;
  const chico = correrElGancho(armar(Math.ceil(largo / 8)));
  const crece = r.ms / Math.max(chico.ms, 1);
  assert.ok(crece < CRECE_COMO_MUCHO,
    `${forma}: tardó ${r.ms} ms (tope ${topeMs}), y ${chico.ms} ms con un octavo del largo: crece ${crece.toFixed(1)} veces`);
}

// 🔴 mutación: la expresión de antes para los heredocs (cúbica con `<<<x;` repetido), juzgar cada `<<<` desde el
// principio de su renglón, juzgar un `<<<` sin palabra, preguntar por la ruta real de un destino una vez por cada origen
// de la copia, o copiar el resto de las palabras por cada palabra al buscar una edición en el lugar.
test('BLANKS6 HereStringsYContinuaciones_EnCantidad_DecidenEnSegundos', () => {
  const formas = {
    '`cp a b <<<x;` repetido': [(n) => 'cp a b <<<x; '.repeat(Math.ceil(n / 13)), 40 * 1024],
    '`<` repetido': [(n) => `cp a b ${'<'.repeat(n)}`, 40 * 1024],
    'renglones continuados': [(n) => 'cp a b \\\n'.repeat(Math.ceil(n / 9)), 200 * 1024],
  };
  for (const [forma, [armar, largo]] of Object.entries(formas)) decideEnSegundos(forma, armar, largo, 5000);
});

// 🔴 mutación: volver a cualquiera de las seis expresiones: con 40 KB, el freno tarda segundos o no decide en 20 s.
test('BLANKS3 TiradaLarga_EnCadaForma_DecideEnSegundos', () => {
  const formas = {
    'espacios en un heredoc': (n) => `cd /tmp && python3 - <<'EOF'\nx = "${' '.repeat(n)}"\nEOF`,
    'puntos y comas en un heredoc': (n) => `cd /tmp && python3 - <<'EOF'\nx = "${';'.repeat(n)}"\nEOF`,
    'espacios en bash -c': (n) => `bash -c 'x ${' '.repeat(n)}'`,
    'espacios por un tubo a sh': (n) => `echo "${' '.repeat(n)}" | sh`,
    'renglones vacíos en un heredoc': (n) => `cd /tmp && python3 - <<'EOF'\nx = """${'\n'.repeat(n)}"""\nEOF`,
  };
  for (const [forma, armar] of Object.entries(formas)) decideEnSegundos(forma, armar, 40 * 1024, 3000);
});

// 🔴 mutación: que la palabra de una redirección exija el cierre de `$(` o `${`: cada una sin cerrar recorre el resto del
// comando, y con 150 KB tarda segundos.
test('BLANKS5 SustitucionSinCerrar_TrasRedireccion_LeeEnUnaPasada', () => {
  const n = 150 * 1024;
  for (const abre of ['>${', '>$(', '<$(', '<${', '> $( ']) {
    const comando = `cp a /tmp/destino ${abre.repeat(Math.ceil(n / abre.length))}`;
    // stable-data: el reloj mide cuánto tarda la lectura, que es lo que se prueba
    const desde = Date.now();
    const destinos = bash.extractWriteTargets(comando);
    const ms = Date.now() - desde;
    // la sustitución sin cerrar deja una palabra que no se resuelve: el destino es ésa, o el del cp
    assert.ok(destinos.some((d) => d === '/tmp/destino' || d.startsWith('$')), `${abre}: ${JSON.stringify(destinos.slice(0, 4))}`);
    assert.ok(ms < 1500, `${abre}: tardó ${ms} ms`);
  }
});

// 🔴 Fila 228. Mutación: blancos opcionales delante del operador de la redirección que se saca de las palabras de un
// tramo. Con una tirada larga de blancos sin `>` detrás, cada blanco la recorre entera: un `cp` con 100 KB de blancos
// tardaba más de 20 s, y el freno frenaba por falla un comando sano.
test('BLANKS7 CopiaConUnaTiradaDeBlancos_LeeSusDestinosEnUnaPasada', () => {
  for (const blanco of [' ', '\t']) {
    const comando = `cp a${blanco.repeat(100 * 1024)}/tmp/destino`;
    // stable-data: el reloj mide cuánto tarda la lectura, que es lo que se prueba
    const desde = Date.now();
    const destinos = bash.extractWriteTargets(comando);
    const ms = Date.now() - desde;
    assert.ok(destinos.includes('/tmp/destino'), JSON.stringify(destinos));
    assert.ok(ms < 1500, `${JSON.stringify(blanco)}: tardó ${ms} ms`);
  }
});

// 🔴 Fila 228. Mutaciones: mirar la punta del tramo que se arma (`cur[cur.length - 1]`) para saber si un `|` es de `>|`, y
// buscar el `-i ''` de sed en el comando entero por cada `sed -i`. La primera recompone el tramo entero en cada `|`; la
// segunda recorre el comando una vez por cada sed: con 200 KB, segundos.
test('BLANKS8 TuberiasTrasRedireccionYSedRepetido_LeenEnUnaPasada', () => {
  const n = 200 * 1024;
  // stable-data: el reloj mide cuánto tarda la lectura, que es lo que se prueba
  const tarda = (comando) => { const desde = Date.now(); bash.extractWriteTargets(comando); return Date.now() - desde; };
  for (const comando of [`echo x ${'>|'.repeat(n / 2)}`, `echo x ${'>&|'.repeat(Math.ceil(n / 3))}`]) {
    const ms = tarda(comando);
    assert.ok(ms < 1500, `${comando.slice(0, 20)}…: tardó ${ms} ms`);
  }
  // miles de `sed -i` llevan su tiempo aunque se lean en una pasada: lo que se mira es cómo crece. Con cuatro veces el
  // largo, una pasada tarda unas cuatro veces más; recorrer el comando por cada sed, unas dieciséis
  const sed = (kb) => 'sed -i f.ts; '.repeat(Math.ceil((kb * 1024) / 13));
  const chico = Math.max(1, Math.min(tarda(sed(50)), tarda(sed(50))));
  const grande = tarda(sed(200));
  assert.ok(grande / chico < 9 && grande < 6000, `sed -i repetido: 50 KB ${chico} ms, 200 KB ${grande} ms`);
});

// 🔴 Fila 243. Mutación: leer el destino del renglón que abre un heredoc una vez por cada heredoc. Con las dos lecturas de
// los cuerpos, un renglón con miles de heredocs se leía miles de veces entero: 3.000 tardaban más de 4 s.
test('BLANKS9 MilesDeHeredocsEnUnRenglon_LeenSuDestinoUnaVez', () => {
  const comando = `cat ${"<<'E' ".repeat(3000)}\n${'x\nE\n'.repeat(3000)}`;
  // stable-data: el reloj mide cuánto tarda la lectura, que es lo que se prueba
  const desde = Date.now();
  const cuerpos = bash.heredocs(comando);
  const ms = Date.now() - desde;
  assert.equal(cuerpos.length, 3000);
  assert.ok(ms < 1500, `tardó ${ms} ms`);
});
