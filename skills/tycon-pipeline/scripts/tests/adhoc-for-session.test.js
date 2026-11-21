#!/usr/bin/env node
'use strict';
// adhoc-for-session.test.js — el camino corto pedido para otra sesión toma la carpeta de esa sesión (@story-8.276).
//
// La coordinadora pide `adhoc set --for-session S` desde su propia carpeta. La lista va en rutas relativas (la lista no
// acepta absolutas), y se resolvían contra la carpeta de la coordinadora: el carril quedaba con archivos que S nunca
// toca. Ahora se resuelven contra la carpeta de trabajo de S, que sale de su transcripción (el `cwd` del último renglón
// que lo trae); sin ella, el pedido sale 2. El pedido de la propia sesión sigue con la
// carpeta del proceso; la terminal con --for-session de otra sesión, la de esa sesión (o frena y pide --repo). El freno
// mira el riesgo alto de la lista con la misma carpeta.
//
// Corre el guion real en una HOME de juguete, en el chequeo previo (no firma ni escribe nada).
//
// Correr: node --test skills/tycon-pipeline/scripts/tests/adhoc-for-session.test.js < /dev/null

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const MARKER = path.join(SCRIPTS, 'marker.js');
const LISTA = require(path.join(SCRIPTS, 'lib', 'adhoc-list.js'));
const ow = require(path.join(RAIZ, 'scripts', 'lib', 'owner-window.js'));

const SIN_REPO = /no caen dentro de ningún repo/;

function entorno() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adhoc-for-session-')));
  const home = path.join(base, 'home');
  const destino = path.join(base, 'destino');
  const ajena = path.join(base, 'coordinadora');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'agent-skills'));
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'tycon-harness'));
  fs.mkdirSync(path.join(destino, 'a'), { recursive: true });
  fs.mkdirSync(path.join(destino, 'src', 'auth'), { recursive: true });
  fs.mkdirSync(ajena, { recursive: true });
  fs.writeFileSync(path.join(destino, 'a', 'b.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(destino, 'src', 'auth', 'login.js'), 'module.exports = 2;\n');
  execFileSync('git', ['init', '-q', destino]);
  // la transcripción de la sesión destino: su carpeta de trabajo en `cwd`, el último renglón que lo trae es el que vale
  const transcripcion = (sid, renglones) => {
    const dir = path.join(home, '.claude', 'projects', `-dir-${sid}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sid}.jsonl`), renglones.map((r) => JSON.stringify(r)).join('\n') + '\n');
  };
  const env = (sid) => {
    const e = { ...process.env };
    for (const k of Object.keys(e)) if (/^TYCON_|^CODEX_SESSION_ID$|^CLAUDE_CODE_SESSION_ID$/.test(k)) delete e[k];
    Object.assign(e, { HOME: home, USERPROFILE: home, TYCON_LANE_LLM: '0', TYCON_TIME_TRACKING: 'none', TYCON_GUIDES_DIR: RAIZ, TYCON_SIGN_PRECHECK: '1' });
    if (sid) e.CLAUDE_CODE_SESSION_ID = sid;
    return e;
  };
  // desde una sesión el pedido va en JSON; `--file` arma su lista y lo demás va tal cual al final
  const pedir = (cwd, sid, args) => {
    const files = [];
    const resto = [];
    for (let i = 0; i < args.length; i++) { if (args[i] === '--file') files.push(args[++i]); else resto.push(args[i]); }
    const pedido = JSON.stringify({ reason: 'arreglo del texto del botón', datos: 'sin-cambio', allowedFiles: files });
    return spawnSync(process.execPath, [MARKER, 'adhoc', 'set', pedido, ...resto], { encoding: 'utf8', env: env(sid), input: '', cwd });
  };
  return { home, destino, ajena, transcripcion, pedir };
}

test('T3 AdhocSet_ForSession_RelativeFromDestinationFolder @story-8.276 @ac-4', () => {
  const E = entorno();
  E.transcripcion('ses-d', [{ type: 'user', cwd: '/otra/carpeta/vieja' }, { type: 'assistant' }, { type: 'user', cwd: E.destino }]);
  assert.strictEqual(LISTA.carpetaDeLaSesion({ casa: E.home, sesion: 'ses-d' }), E.destino, 'el último cwd de la transcripción');
  // se lee desde el final, por bloques: una transcripción larga, con renglones sin cwd de más de un bloque después del
  // último que lo trae, y ese renglón cortado entre dos bloques, se resuelve igual (una de cientos de MB no entra entera)
  const relleno = Array.from({ length: 40 }, (_, i) => ({ type: 'assistant', n: i, texto: 'x'.repeat(7000) }));
  E.transcripcion('ses-larga', [{ type: 'user', cwd: '/vieja' }, ...relleno, { type: 'user', cwd: E.destino, texto: 'y'.repeat(70000) }, ...relleno]);
  assert.strictEqual(LISTA.carpetaDeLaSesion({ casa: E.home, sesion: 'ses-larga' }), E.destino, 'la última, aunque esté lejos del final');
  // desde la carpeta de la coordinadora, la lista cae en la carpeta de la sesión destino
  const r = E.pedir(E.ajena, 'ses-coord', ['--file', 'a/b.js', '--for-session', 'ses-d']);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /tycon-sign-precheck: ok/);
  assert.doesNotMatch(r.stderr, SIN_REPO, 'resuelta contra la carpeta de la coordinadora, cae fuera de todo repo');
  assert.match(r.stderr, /la lista \(1 archivos\): a\/b\.js/);
  // el freno mira el riesgo alto con la misma carpeta: una ruta de auth en el repo de la sesión destino
  const palabras = (sesion) => [MARKER, 'adhoc', 'set', JSON.stringify({ reason: 'arreglo del texto del botón', datos: 'sin-cambio', allowedFiles: ['src/auth/login.js'] }), '--for-session', sesion];
  const carpeta = ow.carpetaDelPedido({ palabras: palabras('ses-d'), cwd: E.ajena, casa: E.home, sesion: 'ses-coord' });
  assert.strictEqual(carpeta, E.destino);
  assert.match(String(ow.pasaDelCupoDelegado(palabras('ses-d'), 8, carpeta)), /riesgo alto/);
  // y el camino «hecho y avisado» (una pestaña sin permisos) mira la misma carpeta que la delegación
  const rutina = ow.rutinaSinPermisos({ guion: 'adhoc-lane', pendientes: ['adhoc-lane'], palabras: palabras('ses-d'), destino: 'ses-d', casa: E.home,
    topes: { delegado: 3, maximo: 5 }, cwd: E.ajena, sesion: 'ses-coord' });
  assert.strictEqual(rutina.ok, false, JSON.stringify(rutina));
  assert.match(String(rutina.motivo), /riesgo alto/);
  // sin --for-session, o de la propia sesión, la carpeta del evento
  assert.strictEqual(ow.carpetaDelPedido({ palabras: palabras('ses-coord'), cwd: E.ajena, casa: E.home, sesion: 'ses-coord' }), E.ajena);
});

test('T4 AdhocSet_ForSession_UnknownFolder_Exit2 @story-8.276 @ac-5', () => {
  const E = entorno();
  // sin transcripción, con dos, o sin cwd (una sesión de Codex, por ejemplo)
  E.transcripcion('ses-dos', [{ type: 'user', cwd: E.destino }]);
  fs.mkdirSync(path.join(E.home, '.claude', 'projects', '-otra'), { recursive: true });
  fs.writeFileSync(path.join(E.home, '.claude', 'projects', '-otra', 'ses-dos.jsonl'), `${JSON.stringify({ type: 'user', cwd: E.destino })}\n`);
  E.transcripcion('ses-sin-cwd', [{ type: 'user' }, { type: 'assistant' }]);
  for (const sid of ['ses-nadie', 'ses-dos', 'ses-sin-cwd']) {
    assert.strictEqual(LISTA.carpetaDeLaSesion({ casa: E.home, sesion: sid }), null, sid);
    const r = E.pedir(E.ajena, 'ses-coord', ['--file', 'a/b.js', '--for-session', sid]);
    assert.strictEqual(r.status, 2, `${sid}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`no sé la carpeta de la sesión ${sid}: que lo pida esa sesión, o pedilo con --repo <carpeta>`), sid);
    assert.doesNotMatch(r.stderr, /la lista \(/, `${sid}: sin lista`);
    assert.doesNotMatch(r.stdout, /tycon-sign-precheck: ok/, sid);
  }
  // el freno no decide el riesgo sin la carpeta: lo dice el guion
  const palabras = [MARKER, 'adhoc', 'set', JSON.stringify({ reason: 'x', allowedFiles: ['a/b.js'] }), '--for-session', 'ses-nadie'];
  assert.strictEqual(ow.carpetaDelPedido({ palabras, cwd: E.ajena, casa: E.home, sesion: 'ses-coord' }), null);
});

test('T5 AdhocSet_AbsoluteOrOwnSession_AsToday @story-8.276 @ac-6 @ac-7', () => {
  const E = entorno();
  E.transcripcion('ses-d', [{ type: 'user', cwd: E.destino }]);
  // rutas absolutas: la lista las rechaza, con o sin --for-session
  for (const extra of [[], ['--for-session', 'ses-d']]) {
    const r = E.pedir(E.ajena, 'ses-coord', ['--file', path.join(E.destino, 'a', 'b.js'), ...extra]);
    assert.strictEqual(r.status, 2, r.stderr);
    assert.match(r.stderr, /ruta absoluta/);
  }
  // la propia sesión, sin --for-session: la carpeta del proceso
  const propia = E.pedir(E.destino, 'ses-d', ['--file', 'a/b.js']);
  assert.strictEqual(propia.status, 0, propia.stderr);
  assert.doesNotMatch(propia.stderr, SIN_REPO);
  // con --for-session de la propia sesión, igual
  const misma = E.pedir(E.destino, 'ses-d', ['--file', 'a/b.js', '--for-session', 'ses-d']);
  assert.strictEqual(misma.status, 0, misma.stderr);
  // y sin su transcripción, desde otra carpeta: la del proceso, como hoy (fuera de todo repo: avisa)
  const fuera = E.pedir(E.ajena, 'ses-sola', ['--file', 'a/b.js']);
  assert.strictEqual(fuera.status, 0, fuera.stderr);
  assert.match(fuera.stderr, SIN_REPO);
});

test('T6 AdhocSet_TerminalForSession_AnchorsInSessionFolder', () => {
  const E = entorno();
  E.transcripcion('ses-d', [{ type: 'user', cwd: E.destino }]);
  // la terminal de la persona, sin sesión propia, parada en otra carpeta: la lista cae en la carpeta de la sesión destino
  const terminal = (cwd, args) => E.pedir(cwd, null, [...args, '--terminal']);
  const r = terminal(E.ajena, ['--file', 'a/b.js', '--for-session', 'ses-d']);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /tycon-sign-precheck: ok/);
  assert.doesNotMatch(r.stderr, SIN_REPO, 'anclada en la carpeta de la terminal');
  assert.match(r.stderr, /la lista \(1 archivos\): a\/b\.js/);
  // la carpeta de la sesión manda aunque la terminal esté en otro repo que también tiene ese archivo
  const otro = path.join(path.dirname(E.destino), 'otro-repo');
  fs.mkdirSync(path.join(otro, 'a'), { recursive: true });
  fs.writeFileSync(path.join(otro, 'a', 'b.js'), '1\n');
  execFileSync('git', ['init', '-q', otro]);
  assert.strictEqual(ow.carpetaDelPedido({ palabras: [MARKER, 'adhoc', 'set', '{}', '--terminal', '--for-session', 'ses-d'], cwd: otro, casa: E.home, sesion: null }), E.destino);
  // sesión sin carpeta conocida (id inventado, ajena sin transcripción): frena y pide --repo, nunca la de la terminal
  for (const cwd of [E.ajena, E.destino]) {
    const x = terminal(cwd, ['--file', 'a/b.js', '--for-session', 'ses-inventada']);
    assert.strictEqual(x.status, 2, x.stderr + x.stdout);
    assert.match(x.stderr, /no sé la carpeta de la sesión ses-inventada: .*--repo <carpeta>/);
    assert.doesNotMatch(x.stderr, /la lista \(/);
    assert.doesNotMatch(x.stdout, /tycon-sign-precheck: ok/);
  }
  // la carpeta de la sesión ya no existe: frena igual, sin caer en la de la terminal
  const borrada = path.join(path.dirname(E.destino), 'borrada');
  E.transcripcion('ses-borrada', [{ type: 'user', cwd: borrada }]);
  const b = terminal(E.destino, ['--file', 'a/b.js', '--for-session', 'ses-borrada']);
  assert.strictEqual(b.status, 2, b.stderr + b.stdout);
  assert.match(b.stderr, /no sé la carpeta de la sesión ses-borrada \(la última que usó, .*borrada, ya no es una carpeta que se pueda abrir\): .*--repo <carpeta>/);
  assert.doesNotMatch(b.stderr, /la lista \(/);
  // --repo manda aunque la sesión tenga carpeta conocida: la lista queda en el repo dicho, no en el de la sesión
  fs.mkdirSync(path.join(otro, 'solo-aca'), { recursive: true });
  fs.writeFileSync(path.join(otro, 'solo-aca', 'c.js'), '1\n');
  // en la carpeta de la sesión ese nombre es una carpeta: resuelta ahí, la lista se negaría
  fs.mkdirSync(path.join(E.destino, 'solo-aca', 'c.js'), { recursive: true });
  const gana = terminal(E.ajena, ['--file', 'solo-aca/c.js', '--for-session', 'ses-d', '--repo', otro]);
  assert.strictEqual(gana.status, 0, gana.stderr + gana.stdout);
  assert.doesNotMatch(gana.stderr, /es una carpeta|no caen dentro/, 'resuelta contra la carpeta de la sesión, no contra --repo');
  assert.match(gana.stderr, /la lista \(1 archivos\): solo-aca\/c\.js/);
  // con --repo, la carpeta dicha manda, como hoy
  const conRepo = terminal(E.ajena, ['--file', 'a/b.js', '--for-session', 'ses-inventada', '--repo', E.destino]);
  assert.strictEqual(conRepo.status, 0, conRepo.stderr + conRepo.stdout);
  assert.doesNotMatch(conRepo.stderr, SIN_REPO);
});
