#!/usr/bin/env node
'use strict';
// comment-only.test.js — ¿dos versiones de un .js difieren sólo en el lugar de sus comentarios? (historia 8.217)
//
// Caso: una edición que sólo subió un bloque de código por encima de un comentario, después de los revisores, pidió
// otra vuelta con cuatro revisores. El lector de lib/comment-only.js dice si el código y los textos de los comentarios
// quedaron iguales; ante cualquier duda dice que no, y el archivo pide revisión como hoy.
//
// Correr: node --test skills/tycon-pipeline/scripts/tests/comment-only.test.js < /dev/null

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const co = require(path.join(SCRIPTS, 'lib', 'comment-only.js'));

const B = (s) => Buffer.from(s, 'utf8');
const comparar = (antes, ahora, archivo = 'src/a.js') => co.soloSeMovieronComentarios(B(antes), B(ahora), { archivo });
const PRE = "'use strict';\nconst x = require('x');\n";
const tabla = (filas) => {
  for (const [nombre, antes, ahora] of filas) {
    const r = comparar(antes, ahora);
    assert.strictEqual(r.ok, false, `${nombre}: ${JSON.stringify(r)}`);
    assert.ok(r.motivo, `${nombre}: dice por qué`);
  }
};

test('T1 CommentOnly_ComentarioCambiaDeLugar_EsSoloMovido @story-8.217 @ac-1 — un bloque de código sube por encima de un comentario', () => {
  const antes = `${PRE}// toolPid: el pid de la herramienta\nconst WAKE = ['a'];\nfunction wakes() { return WAKE; }\nfunction toolPid() { return 1; }\n`;
  const ahora = `${PRE}const WAKE = ['a'];\nfunction wakes() { return WAKE; }\n// toolPid: el pid de la herramienta\nfunction toolPid() { return 1; }\n`;
  assert.deepStrictEqual(comparar(antes, ahora), { ok: true, movidos: 1 });
});

test('T5 CommentOnly_EspaciosEntreTokens_EsSoloMovido @story-8.217 @ac-4 — sangría y líneas en blanco entre tokens', () => {
  assert.deepStrictEqual(comparar(`${PRE}if (a) {\n  b();\n}\n`, `${PRE}if (a) {\n\n      b();\n\n}\n`), { ok: true, movidos: 0 });
});

test('T6 CommentOnly_TokenCambiado_PideRevision @story-8.217 @ac-5 — cualquier token distinto', () => {
  tabla([
    ['nombre', `${PRE}a(b);\n`, `${PRE}a(c);\n`],
    ['número', `${PRE}a(1);\n`, `${PRE}a(2);\n`],
    ['cadena', `${PRE}a('x');\n`, `${PRE}a('y');\n`],
    ['signo', `${PRE}a = b + c;\n`, `${PRE}a = b - c;\n`],
    ['permutadas', `${PRE}uno();\ndos();\n`, `${PRE}dos();\nuno();\n`],
  ]);
});

test('T8 CommentOnly_TextoDeComentarioCambiado_PideRevision @story-8.217 @ac-6 — el texto de los comentarios no cambia', () => {
  tabla([
    ['texto', `${PRE}// uno\na();\n`, `${PRE}// dos\na();\n`],
    ['agregado', `${PRE}a();\n`, `${PRE}// nuevo\na();\n`],
    ['borrado', `${PRE}// viejo\na();\n`, `${PRE}a();\n`],
    ['repetido de menos', `${PRE}// x\na();\n// x\nb();\n`, `${PRE}// x\na();\nb();\n`],
  ]);
});

test('T9 CommentOnly_SeparacionEntreTokens_PideRevision @story-8.217 @ac-7 — la clase de separación no cambia', () => {
  tabla([
    ['+ + contra ++', `${PRE}x = a + +b;\n`, `${PRE}x = a ++b;\n`],
    ['pegados contra separados', `${PRE}x = a+b;\n`, `${PRE}x = a + b;\n`],
    ['misma línea contra salto', `${PRE}function f() { return x; }\n`, `${PRE}function f() { return\nx; }\n`],
  ]);
});

test('T10 CommentOnly_BloqueMultilineaTrasReturn_PideRevision @story-8.217 @ac-7 — return /*⏎*/ 1 no es return /* */ 1', () => {
  const r = comparar(`${PRE}function f() { return /*\n*/ 1; /* */ }\n`, `${PRE}function f() { return /* */ 1; /*\n*/ }\n`);
  assert.strictEqual(r.ok, false, JSON.stringify(r));
});

test('T11 CommentOnly_BlancoEnPlantilla_PideRevision @story-8.217 @ac-8 — la plantilla es código', () => {
  const r = comparar(`${PRE}const t = \`a\nb\`;\n`, `${PRE}const t = \`a\n\nb\`;\n`);
  assert.strictEqual(r.ok, false, JSON.stringify(r));
});

test('T12 CommentOnly_PlantillaAnidadaConApostrofo_NoVeComentario @story-8.217 @ac-8 — nada adentro de una plantilla es comentario', () => {
  const texto = (c) => `${PRE}const t = \`\${b ? \`'\` : c}\n${c}\nevil()\n\`;\n`;
  const r = comparar(texto('// dentro'), texto('// fuera'));
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  const l = co.leer(texto('// dentro'));
  assert.ok(!l.duda, l.duda);
  assert.strictEqual(l.comentarios.length, 0, JSON.stringify(l.comentarios));
});

test('T13 CommentOnly_SeparadorUnicodeCortaComentario_PideRevision @story-8.217 @ac-9 — U+2028, U+2029 y \\r cortan un comentario', () => {
  for (const fin of ['\u2028', '\u2029', '\r']) {
    const r = comparar(`${PRE}// nota${fin}evil();\n`, `${PRE}// nota${fin}good();\n`);
    assert.strictEqual(r.ok, false, `${JSON.stringify(fin)}: ${JSON.stringify(r)}`);
  }
});

test('T14 CommentOnly_RegexTrasIf_NoAbreComentario @story-8.217 @ac-9 — la expresión regular después de if (…) no abre un comentario', () => {
  const r = comparar(`${PRE}if (x) /[/*]/.test(y);\nevil();\n/* c */ z();\n`, `${PRE}if (x) /[/*]/.test(y);\ngood();\n/* c */ z();\n`);
  assert.strictEqual(r.ok, false, JSON.stringify(r));
});

test('T15 CommentOnly_BarraAmbigua_Duda @story-8.217 @ac-10 — una / que el lector no sabe leer', () => {
  const casos = [
    ['}', '{ a(); } /x/.test(y);'], ['++', 'a++ /x/g;'], ['--', 'a-- /x/g;'], ['.', 'a./x/;'], ['yield', 'function* g() { yield /x/; }'],
    ['await', 'async function g() { await /x/; }'], ['of', 'for (const a of /x/) {}'], ['default', 'export default /[/*]/;'], ['extends', 'class A extends /x/ {}'],
  ];
  for (const [que, codigo] of casos) {
    const r = comparar(`${PRE}// c\n${codigo}\n`, `${PRE}${codigo}\n// c\n`);
    assert.strictEqual(r.ok, false, `${que}: ${JSON.stringify(r)}`);
    assert.match(r.motivo, /`\/`/, `${que}: el motivo nombra la barra (${r.motivo})`);
  }
});

test('T16 CommentOnly_SinCerrarOHtml_Duda @story-8.217 @ac-10 — lo que no se puede leer con certeza', () => {
  const casos = ["a('x);", 'a(`x);', 'a(/x);', 'a(); /* x', 'a(); }', '<!-- a', 'a --> b', '{ a();', 'a(`${b`);', 'function f() { return <a>http://x</a>; }'];
  for (const codigo of casos) {
    const l = co.leer(`${PRE}${codigo}\n`);
    assert.ok(l.duda, `${codigo}: ${JSON.stringify(l).slice(0, 120)}`);
    const r = comparar(`${PRE}// c\n${codigo}\n`, `${PRE}${codigo}\n// c\n`);
    assert.strictEqual(r.ok, false, `${codigo}: ${JSON.stringify(r)}`);
    assert.ok(r.motivo, codigo);
  }
});

test('T17 CommentOnly_DirectivaMovida_PideRevision @story-8.217 @ac-11 — una directiva vale por su lugar', () => {
  const ejemplos = {
    eslint: 'eslint-disable-next-line', tslint: 'tslint:disable', jshint: 'jshint ignore:line', jslint: 'jslint node', prettier: 'prettier-ignore',
    biome: 'biome-ignore lint', istanbul: 'istanbul ignore next', '\\bc8\\b': 'c8 ignore next', '\\bv8\\b': 'v8 ignore next', 'node:': 'node:coverage ignore',
    nosec: 'nosec', nosemgrep: 'nosemgrep', noqa: 'noqa', nosonar: 'NOSONAR', nolint: 'nolint', pragma: 'pragma once', '<reference': '<reference path="x" />',
    'deno-lint': 'deno-lint-ignore', 'deno-fmt': 'deno-fmt-ignore', gitleaks: 'gitleaks:allow', codeql: 'codeql[js/x]', lgtm: 'lgtm[js/x]',
    sourceMappingURL: 'sourceMappingURL=a.map', sourceURL: 'sourceURL=a.js', webpack: 'webpackChunkName: "a"', __PURE__: '__PURE__', __NOINLINE__: '__NOINLINE__',
    'harness-deprecated': 'harness-deprecated', '^(global|globals|exported)\\b': 'global window',
  };
  const textos = [];
  for (const re of co.DIRECTIVAS) {
    const k = re.source;
    assert.ok(ejemplos[k], `falta el ejemplo de ${k}`);
    textos.push(ejemplos[k]);
  }
  textos.push('una nota con @ en el medio', '# algo', '! importante', '$ algo', ': algo');
  for (const t of textos) {
    const movida = comparar(`${PRE}/* ${t} */\na();\nb();\n`, `${PRE}a();\n/* ${t} */\nb();\n`);
    assert.strictEqual(movida.ok, false, `movida «${t}»: ${JSON.stringify(movida)}`);
    const quieta = comparar(`${PRE}/* ${t} */\na();\n// común\nb();\n`, `${PRE}/* ${t} */\na();\nb();\n// común\n`);
    assert.strictEqual(quieta.ok, true, `sin mover «${t}»: ${JSON.stringify(quieta)}`);
  }
  const saltos = comparar(`${PRE}// eslint-disable-next-line\n\neval(x);\n`, `${PRE}// eslint-disable-next-line\neval(x);\n`);
  assert.strictEqual(saltos.ok, false, `una línea en blanco de menos antes de eval: ${JSON.stringify(saltos)}`);
  const numero = comparar(`${PRE}/* c8 ignore next 3 */\na();\nif (b) {\n  c();\n}\n`, `${PRE}/* c8 ignore next 3 */\na();\nif (b) {\n    c();\n}\n`);
  assert.strictEqual(numero.ok, false, `c8 con un número y la sangría cambiada en otra línea: ${JSON.stringify(numero)}`);
});

test('T18 CommentOnly_BytesInvalidosOTope_PideRevision @story-8.217 @ac-3 @ac-12 — bytes que no son UTF-8 o más de 2 MiB', () => {
  const malo = Buffer.concat([B(`${PRE}// a`), Buffer.from([0xff]), B('\nb();\n')]);
  const maloMovido = Buffer.concat([B(`${PRE}b();\n// a`), Buffer.from([0xff]), B('\n')]);
  const r1 = co.soloSeMovieronComentarios(malo, maloMovido, { archivo: 'a.js' });
  assert.strictEqual(r1.ok, false, JSON.stringify(r1));
  assert.ok(r1.motivo);
  const grande = B(`${PRE}// c\n${'a();\n'.repeat(Math.ceil((2 * 1024 * 1024 + 1) / 5))}`);
  const grandeMovido = B(`${PRE}${'a();\n'.repeat(Math.ceil((2 * 1024 * 1024 + 1) / 5))}// c\n`);
  assert.ok(grande.length > 2 * 1024 * 1024);
  const r2 = co.soloSeMovieronComentarios(grande, grandeMovido, { archivo: 'a.js' });
  assert.strictEqual(r2.ok, false, JSON.stringify(r2));
  assert.ok(r2.motivo);
  assert.deepStrictEqual(co.soloSeMovieronComentarios(malo, Buffer.from(malo), { archivo: 'a.js' }), { ok: true, movidos: 0 });
  assert.deepStrictEqual(co.soloSeMovieronComentarios(grande, Buffer.from(grande), { archivo: 'a.js' }), { ok: true, movidos: 0 });
});

test('T25 CommentOnly_PorExtension_SoloJsCjsMjs @story-8.217 @ac-17 — sólo .js, .cjs y .mjs', () => {
  const antes = `${PRE}// c\na();\nb();\n`;
  const ahora = `${PRE}a();\n// c\nb();\n`;
  for (const ext of ['.js', '.cjs', '.mjs']) assert.strictEqual(comparar(antes, ahora, `src/a${ext}`).ok, true, ext);
  for (const ext of ['.ts', '.tsx', '.jsx', '.mts', '.cts', '.py', '.sh', '.JS']) assert.strictEqual(comparar(antes, ahora, `src/a${ext}`).ok, false, ext);
});

test('T32 CommentOnly_CorpusDelArnes_LoQueLlamaComentarioLoEs @story-8.217 @ac-22 — cada comentario que encuentra lo confirma Node', () => {
  const dir = path.join(SCRIPTS, 'lib');
  const archivos = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  assert.ok(archivos.length > 20, `pocos archivos en ${dir}`);
  const compila = (codigo) => { try { vm.compileFunction(codigo, ['require', 'module', 'exports', '__filename', '__dirname']); return true; } catch (_) { return false; } };
  let mirados = 0;
  for (const f of archivos) {
    const texto = fs.readFileSync(path.join(dir, f), 'utf8');
    let l;
    assert.doesNotThrow(() => { l = co.leer(texto); }, f);
    if (l.duda) continue;
    // sin la primera línea `#!`, que una función no acepta (del mismo largo, para no mover nada)
    const base = texto.startsWith('#!') ? texto.replace(/^#![^\n]*/, (m) => ' '.repeat(m.length)) : texto;
    if (!compila(base)) continue;
    const todos = l.comentarios;
    const paso = Math.max(1, Math.ceil(todos.length / 25));
    for (let k = 0; k < todos.length; k += paso) {
      const c = todos[k];
      const con = (reemplazo) => base.slice(0, c.desde) + reemplazo + base.slice(c.desde + c.texto.length);
      const vacio = /[\n\r\u2028\u2029]/.test(c.texto) ? '/*\n*/' : '/**/';
      assert.ok(compila(con(vacio)), `${f}: cambiar ${JSON.stringify(c.texto.slice(0, 40))} por un comentario vacío no compila`);
      assert.ok(!compila(con('@#')), `${f}: ${JSON.stringify(c.texto.slice(0, 40))} no era un comentario (con @# sigue compilando)`);
      mirados++;
    }
  }
  assert.ok(mirados > 100, `pocos comentarios confirmados: ${mirados}`);
});

test('T34 Signatures_LectorDeComentarios_EsSensible @story-8.217 @ac-23 — el lector es sensible: lo firma el dueño', () => {
  const sig = require(path.join(RAIZ, 'scripts', 'lib', 'signatures.js'));
  const so = require(path.join(SCRIPTS, 'lib', 'save-ok.js'));
  const rel = 'skills/tycon-pipeline/scripts/lib/comment-only.js';
  assert.ok(sig.SENSITIVE.includes(rel), 'en SENSITIVE');
  assert.strictEqual(so.esSensible(rel), true);
});

test('T35 CommentOnly_RegexTrasPlantillaOShebang_NoEsComentario @story-8.217 @ac-9 — (pase) después de `${` o de `#!` la `/` abre una expresión', () => {
  const vmRun = (src) => { const out = []; vm.runInNewContext(src, { console: { log: (x) => out.push(String(x)) }, evil: () => out.push('EVIL') }); return out.join('|'); };
  const antes = 'const s = `${/[ ]/.source}`;\nconsole.log(s); /*]/, evil(), /[*/\n';
  const ahora = 'const s = `${/[/*]/, evil(), /[*/]/.source}`;\nconsole.log(s);\n';
  assert.match(vmRun(ahora), /EVIL/, 'Node corre evil() en la versión nueva');
  assert.strictEqual(comparar(antes, ahora).ok, false);
  const shebang = (resto) => `#!/usr/bin/env node\n/[/*]/.test('x');\n${resto}`;
  assert.strictEqual(comparar(shebang('good();\n/* c */ z();\n'), shebang('evil();\n/* c */ z();\n')).ok, false);
});

test('T36 CommentOnly_MuchosComentariosSeguidos_LeeEnTiempoLineal @story-8.217 @ac-18 — (pase) 200 000 comentarios no cuelgan al lector', () => {
  const relleno = '/**/'.repeat(200000);
  const t0 = process.hrtime.bigint();
  const r = comparar(`const a = 1; /* nota */ ${relleno}\nconsole.log(a);\n`, `const a = 1; ${relleno}\n/* nota */ console.log(a);\n`);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(r && typeof r.ok === 'boolean', JSON.stringify(r));
  assert.ok(ms < 5000, `tardó ${Math.round(ms)} ms`);
});
