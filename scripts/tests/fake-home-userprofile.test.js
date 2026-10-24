#!/usr/bin/env node
'use strict';
/**
 * fake-home-userprofile.test.js — una carpeta personal de juguete cambia HOME y USERPROFILE juntas.
 *
 * QUÉ CUIDA: en Windows `os.homedir()` lee `USERPROFILE`, no `HOME`. Una prueba que se aísla cambiando sólo `HOME`
 * lanza un guion que escribe el marcador y los registros en la carpeta personal REAL de quien corre la suite, y
 * después los busca en la de juguete. En la Mac pasa; en Windows da rojo y ensucia el `~/.claude` del dev.
 *
 * Recorre las suites que corren en Windows y marca cada línea que nombra `HOME` sin `USERPROFILE` en la misma línea y
 * sin el ayudante: `fakeHomeEnv(`, `ponerCarpetaPersonal(` o `conCarpetaPersonal(` (tests/lib/fake-home.js), o
 * `fake_home_create` (scripts/tests/lib/fake-home.sh). No persigue las formas de escribir HOME una por una: frena de
 * más (ver `sitiosSinPar`), y un caso de más se resuelve con el ayudante. Un objeto partido en varias líneas, con HOME
 * en una y USERPROFILE en otra, también frena: se pasa al ayudante.
 *
 * Correr: node --test scripts/tests/fake-home-userprofile.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..');
const SUITES = [
  'skills/tycon-pipeline/scripts/tests/unit.test.js',
  'skills/tycon-pipeline/scripts/tests/story-gate.test.js',
  'skills/tycon-pipeline/scripts/tests/ledger-visible.test.js',
  'skills/tycon-pipeline/scripts/tests/run-close.test.js',
  'scripts/tests/apply-hooks.test.js',
  'scripts/tests/safety-escape.test.js',
  'scripts/tests/harness-node.test.sh',
];

const AYUDANTE = /fakeHomeEnv\(|ponerCarpetaPersonal\(|conCarpetaPersonal\(|fake_home_create/;

/**
 * Cada línea de JS partida en el código sin el contenido de los textos (`code`) y los textos (`strs`). Una comilla
 * simple o doble no cruza de línea; una plantilla sí. Un comentario al final de la línea no cuenta como código.
 */
function partirJs(texto) {
  const out = [];
  let enPlantilla = false;
  for (const raw of texto.split('\n')) {
    let code = '';
    let cur = '';
    let q = enPlantilla ? '`' : null;
    const strs = [];
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (q) {
        if (c === '\\') { cur += c + (raw[i + 1] || ''); i++; continue; }
        if (c === q) { strs.push(cur); cur = ''; code += c; q = null; continue; }
        cur += c;
        continue;
      }
      if (c === '/' && raw[i + 1] === '/') break;
      if (c === '\'' || c === '"' || c === '`') q = c;
      code += c;
    }
    if (q) strs.push(cur);
    enPlantilla = q === '`';
    out.push({ code, strs, raw });
  }
  return out;
}

/**
 * Las líneas que nombran HOME sin su par, como `{ linea, texto }`. Frena de más a propósito: en JS cuenta HOME como
 * nombre en el código (clave, abreviada, `process.env.HOME` leída o escrita) o como texto exacto (`'HOME'`,
 * `'HOME=…'`); en shell, toda asignación `HOME=` (con o sin comillas, con `export` o `env`). La prosa y un comando
 * que sólo lee `$HOME` no cuentan. Un caso de más se resuelve con el ayudante.
 */
function sitiosSinPar(texto, tipo) {
  const out = [];
  const marcar = (i, raw) => out.push({ linea: i + 1, texto: raw.trim().slice(0, 120) });
  const conPar = (raw) => /USERPROFILE/.test(raw) || AYUDANTE.test(raw);
  if (tipo === 'sh') {
    texto.split('\n').forEach((raw, i) => {
      if (!raw.trim().startsWith('#') && /(?:^|[^\w$])HOME=/.test(raw) && !conPar(raw)) marcar(i, raw);
    });
    return out;
  }
  partirJs(texto).forEach(({ code, strs, raw }, i) => {
    const t = raw.trim();
    if (/^\*(\s|\/|$)/.test(t) || t.startsWith('/*')) return;
    const nombra = /(?<![\w$])HOME(?!\w)/.test(code) || strs.some((s) => s === 'HOME' || /^HOME=/.test(s));
    // el par cuenta en el código o como texto exacto (`env['USERPROFILE']`), no en un comentario
    const par = /(?<![\w$])USERPROFILE(?!\w)/.test(code) || AYUDANTE.test(code) || strs.some((s) => s === 'USERPROFILE' || /^USERPROFILE=/.test(s));
    if (nombra && !par) marcar(i, raw);
  });
  return out;
}

test('T1 CarpetaPersonal_HomeYUserprofileJuntos @story-8.115 @ac-1', () => {
  const faltan = [];
  for (const rel of SUITES) {
    const texto = fs.readFileSync(path.join(RAIZ, rel), 'utf8');
    for (const s of sitiosSinPar(texto, rel.endsWith('.sh') ? 'sh' : 'js')) faltan.push(`${rel}:${s.linea}  ${s.texto}`);
  }
  assert.deepEqual(faltan, [], `HOME de juguete sin USERPROFILE (en Windows el guion escribe en la carpeta personal real):\n${faltan.join('\n')}`);
});

test('T1 CarpetaPersonal_ElDetectorVeCadaForma @story-8.115 @ac-1', () => {
  const malos = [
    "  env: { ...process.env, HOME: fakeHome },",
    "  process.env.HOME = tmpHome;",
    "  env.HOME = casa;",
    "  env['HOME'] = casa;",
    "  env: { ...process.env, 'HOME': casa },",
    '  env: { "HOME": casa },',
    "  const e = { ['HOME']: casa };",
    "  env: { ...process.env, HOME },",
    "  const env = { HOME, PATH };",
    "  spawnSync('env', ['HOME=/x', 'node']);",
    "  const leida = path.join(process.env.HOME, '.claude');",
    "  x = 1; const e = { HOME: casa }; // USERPROFILE en un comentario no vale",
  ];
  for (const l of malos) assert.equal(sitiosSinPar(l, 'js').length, 1, `tiene que verlo: ${l}`);
  for (const l of ['export HOME="$BASE/home"; mkdir -p "$HOME"', 'HOME="$t" node x.js', 'env -i "HOME=$t" node x', "env 'HOME=/x' node y"]) {
    assert.equal(sitiosSinPar(l, 'sh').length, 1, `tiene que verlo: ${l}`);
  }
  // una plantilla de varias líneas: lo de adentro es texto, no código
  assert.deepEqual(sitiosSinPar('const cmd = `\nprocess.env.HOME en un comando de prueba\n`;', 'js'), []);
  const buenos = [
    "  env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },",
    "  env: { ...process.env, ...fakeHomeEnv(fakeHome), CLAUDE_CODE_SESSION_ID: sid },",
    "  conCarpetaPersonal(tmpHome, () => {",
    "  const env = { TYCON_HOME: casa, REAL_HOME: x };",
    "  // HOME: un comentario no cuenta",
    "  const msg = 'la HOME temporal';",
    "  run('env -u HOME ls');",
  ];
  for (const l of buenos) assert.deepEqual(sitiosSinPar(l, 'js'), [], `no tiene que verlo: ${l}`);
  assert.deepEqual(sitiosSinPar('export HOME="$H" USERPROFILE="$(cygpath -w "$H")"', 'sh'), []);
  assert.deepEqual(sitiosSinPar('# export HOME=x', 'sh'), []);
  assert.deepEqual(sitiosSinPar('echo "$HOME/x"', 'sh'), []);
  assert.deepEqual(sitiosSinPar('fake_home_create "$TMP/casa"', 'sh'), []);
});

test('T1 CarpetaPersonal_ElAyudanteRestauraLasDos @story-8.115 @ac-1', () => {
  const { fakeHomeEnv, conCarpetaPersonal, ponerCarpetaPersonal } = require(path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'tests', 'lib', 'fake-home.js'));
  assert.deepEqual(fakeHomeEnv('/x'), { HOME: '/x', USERPROFILE: '/x' });
  const antes = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  assert.throws(() => conCarpetaPersonal('/casa', () => {
    assert.equal(process.env.HOME, '/casa');
    assert.equal(process.env.USERPROFILE, '/casa');
    throw new Error('lanza adentro');
  }), /lanza adentro/);
  assert.equal(process.env.HOME, antes.HOME, 'HOME vuelve aunque fn lance');
  assert.equal(process.env.USERPROFILE, antes.USERPROFILE, 'USERPROFILE vuelve aunque fn lance (o sigue sin estar)');
  const volver = ponerCarpetaPersonal('/otra');
  assert.equal(require('os').homedir(), '/otra', 'os.homedir() ve la carpeta de juguete');
  volver();
  assert.equal(process.env.HOME, antes.HOME);
});

module.exports = { sitiosSinPar };
