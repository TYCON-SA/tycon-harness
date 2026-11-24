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
 *   BLANKS3  el gancho entero decide en menos de 3 s con 40 KB en cinco formas (espacios en un heredoc, `;` en un
 *            heredoc, espacios en `bash -c`, espacios por un tubo a `sh`, renglones vacíos en un heredoc)
 *   BLANKS4  los segmentos, las redirecciones, el `sh -c` y la de borrados dan lo mismo que las expresiones de antes
 *   BLANKS5  los destinos se leen en menos de 1,5 s con 150 KB de `$(` o `${` sin cerrar detrás de `>` o `<`
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

// El gancho entero con un comando, en una casa de juguete: `{ status, stderr, ms }`.
function correrElGancho(comando) {
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'blanks-casa-'));
  fs.mkdirSync(path.join(casa, '.claude'), { recursive: true });
  try {
    const entrada = JSON.stringify({ session_id: 'blanks', cwd: os.tmpdir(), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: comando } });
    // stable-data: el reloj mide cuánto tarda el gancho, que es lo que se prueba; ninguna fecha entra en el resultado
    const desde = Date.now();
    const r = spawnSync(process.execPath, [HOOK], { input: entrada, encoding: 'utf8', timeout: 60000, maxBuffer: 1 << 26,
      env: { ...process.env, HOME: casa, USERPROFILE: casa, TYCON_HOME: path.join(casa, '.tycon') } });
    return { status: r.status, stderr: `${r.stdout || ''}${r.stderr || ''}`, ms: Date.now() - desde };
  } finally { fs.rmSync(casa, { recursive: true, force: true }); }
}

// 🔴 mutación: volver a cualquiera de las seis expresiones: con 40 KB, el freno tarda segundos o no decide en 20 s.
test('BLANKS3 TiradaLarga_EnCadaForma_DecideEnSegundos', () => {
  const n = 40 * 1024;
  const formas = {
    'espacios en un heredoc': `cd /tmp && python3 - <<'EOF'\nx = "${' '.repeat(n)}"\nEOF`,
    'puntos y comas en un heredoc': `cd /tmp && python3 - <<'EOF'\nx = "${';'.repeat(n)}"\nEOF`,
    'espacios en bash -c': `bash -c 'x ${' '.repeat(n)}'`,
    'espacios por un tubo a sh': `echo "${' '.repeat(n)}" | sh`,
    'renglones vacíos en un heredoc': `cd /tmp && python3 - <<'EOF'\nx = """${'\n'.repeat(n)}"""\nEOF`,
  };
  for (const [forma, comando] of Object.entries(formas)) {
    const r = correrElGancho(comando);
    assert.doesNotMatch(r.stderr, /no alcanzó a decidir/, forma);
    assert.ok(r.ms < 3000, `${forma}: tardó ${r.ms} ms`);
  }
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
