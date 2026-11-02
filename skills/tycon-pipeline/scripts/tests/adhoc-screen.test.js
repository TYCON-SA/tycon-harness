#!/usr/bin/env node
'use strict';
/**
 * adhoc-screen.test.js — la pantalla en el camino rápido: sin maqueta aprobada y captura posterior al último cambio, no
 * guarda; sin medir, tampoco.
 *
 * Laboratorio por prueba: una HOME vacía, un repo real con su `origin` local y un carril firmado como lo deja `marker.js
 * adhoc set`. El freno corre como lo llama el gancho (`decidir`) y una vez por el gancho entero.
 *
 * stable-data: las fechas de los archivos se fijan con utimes; ninguna se compara con el reloj.
 * Correr: node --test skills/tycon-pipeline/scripts/tests/adhoc-screen.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const { conVentana } = require(path.join(SCRIPTS, '..', '..', '..', 'scripts', 'tests', 'lib', 'window-passed.js'));
const brake = require(path.join(SCRIPTS, 'lib', 'save-brake.js'));
const { fileTouchesUi } = require(path.join(SCRIPTS, 'lib', 'ui-signal.js'));
const { problemaDeLaCaptura, problemaDeLaMaqueta } = require(path.join(SCRIPTS, 'lib', 'adhoc-screen.js'));

const MARKER = path.join(SCRIPTS, 'marker.js');
const MOCKUP = path.join(SCRIPTS, 'mockup.js');
const SID = 'ses-pantalla';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const AYER = new Date('2026-10-01T10:00:00Z');
const HOY = new Date('2026-10-02T10:00:00Z');
const MANANA = new Date('2026-10-03T10:00:00Z');

const tmp = (t, pre) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), pre)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repo(t, nombre = 'repo') {
  const raiz = tmp(t, 'pantalla-');
  const d = path.join(raiz, nombre);
  execFileSync('git', ['init', '-q', '-b', 'main', d]);
  git(d, 'config', 'user.email', 'a@b');
  git(d, 'config', 'user.name', 'a');
  fs.writeFileSync(path.join(d, 'LEEME.md'), 'hola\n');
  git(d, 'add', '.');
  git(d, 'commit', '-qm', 'base');
  return d;
}
function escribir(dir, rel, contenido = 'x\n', fecha = HOY) {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, contenido);
  fs.utimesSync(f, fecha, fecha);
  return f;
}
function maqueta(dir, rel = 'maqueta.html') {
  const f = path.join(dir, rel);
  const r = spawnSync(process.execPath, [MOCKUP, 'demo', '--out', f], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return f;
}
const estado = (h) => path.join(h, '.claude', '.tycon-pipeline');
function home(t) {
  const h = tmp(t, 'pantalla-home-');
  fs.mkdirSync(path.join(estado(h), 'adhoc'), { recursive: true });
  return h;
}
/** El carril firmado de la prueba, con lo que se le agregue. */
function carril(h, extra = {}) {
  const ahora = new Date().toISOString();
  fs.writeFileSync(path.join(estado(h), 'adhoc', `${SID}.json`), JSON.stringify({
    reason: 'el combo muestra el nombre completo', maxFiles: 5, files: [], declaredAt: ahora, lastTouch: ahora, firmadaEn: ahora, ...extra,
  }));
  fs.appendFileSync(path.join(estado(h), 'gates.log'), `${JSON.stringify({ name: 'adhoc-lane-signed', status: 'ok', destino: SID, ts: ahora })}\n`);
}
const leerCarril = (h) => JSON.parse(fs.readFileSync(path.join(estado(h), 'adhoc', `${SID}.json`), 'utf8'));
const conMaqueta = (f) => ({ file: f, sha256: problemaDeLaMaqueta(f).sha256, approval: 'la aprobó Ana en el chat' });
const decidir = (h, cwd, command = 'git commit -m x') => brake.decidir({ command, cwd, sid: SID, home: h });
function cli(h, args, { ventana = false } = {}) {
  const env = { ...process.env, HOME: h, USERPROFILE: h, CLAUDE_CODE_SESSION_ID: SID };
  delete env.NODE_OPTIONS;
  return spawnSync(process.execPath, [MARKER, ...args], { encoding: 'utf8', env: ventana ? conVentana(env) : env });
}

// Un carril con su pantalla, su maqueta aprobada y su captura más nueva que el cambio.
function completo(t) {
  const r = repo(t);
  const h = home(t);
  const pantalla = escribir(r, 'src/Combo.tsx');
  const m = maqueta(r);
  const c = escribir(r, 'captura.png', PNG, MANANA);
  carril(h, { files: [pantalla], mockup: conMaqueta(m), capture: { file: c } });
  return { r, h, pantalla, m, c };
}

// 🔴 Falla con: un criterio de pantalla propio del camino rápido, que deja de coincidir con el de una story.
test('fileTouchesUi: el mismo criterio que una story', (t) => {
  const r = repo(t);
  assert.strictEqual(fileTouchesUi('src/Combo.tsx', r), true, 'por la extensión');
  assert.strictEqual(fileTouchesUi('src/app/page.ts', r), true, 'por la carpeta');
  assert.strictEqual(fileTouchesUi('src/lib/precio.ts', r, 'ui', 'FrontEnd'), true, 'por el nombre del repo');
  assert.strictEqual(fileTouchesUi('scripts/deploy.sh', r, 'ui', 'FrontEnd'), false, 'un guion del repo del frente');
  assert.strictEqual(fileTouchesUi('Api/Precio.cs', r), false);
  assert.strictEqual(fileTouchesUi('LEEME.md', r, 'ui', 'FrontEnd'), false, 'un documento');
  assert.strictEqual(fileTouchesUi('src/Combo.tsx', r, 'off'), false, 'la organización no lo exige');
  assert.strictEqual(fileTouchesUi('src/Combo.svelte', r, 'react'), false, 'la organización sólo exige .tsx y .jsx');
});

// 🔴 Falla con: un archivo de texto con extensión de imagen que pasa por captura.
test('problemaDeLaCaptura: una imagen de verdad', (t) => {
  const d = tmp(t, 'capturas-');
  assert.strictEqual(problemaDeLaCaptura(escribir(d, 'a.png', PNG)), null);
  assert.strictEqual(problemaDeLaCaptura(escribir(d, 'a.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))), null);
  assert.strictEqual(problemaDeLaCaptura(escribir(d, 'a.webp', Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))), null);
  assert.match(problemaDeLaCaptura(escribir(d, 'b.png', '')), /no es una imagen/, 'vacía');
  assert.match(problemaDeLaCaptura(escribir(d, 'c.png', 'hola')), /no es una imagen/, 'texto');
  assert.match(problemaDeLaCaptura(escribir(d, 'd.txt', 'hola')), /no es una imagen/, 'otra extensión');
  assert.match(problemaDeLaCaptura(path.join(d, 'no-esta.png')), /no pude leer/);
});

// 🔴 Falla con: un arreglo con pantalla que guarda sin nada anotado.
test('toca una pantalla y no tiene nada: no guarda, y dice qué falta y cómo se completa', (t) => {
  const r = repo(t);
  const h = home(t);
  carril(h, { files: [escribir(r, 'src/Combo.tsx')] });
  for (const cmd of ['git commit -m x', 'git push', 'gh pr create --fill']) {
    const d = decidir(h, r, cmd);
    assert.ok(d && d.texto, `«${cmd}» frena`);
    assert.ok(!d.pregunta, `«${cmd}» no pregunta`);
    assert.match(d.texto, /Combo\.tsx/);
    assert.match(d.texto, /la maqueta aprobada/);
    assert.match(d.texto, /la captura de lo construido/);
    assert.match(d.texto, /adhoc capture/);
    assert.match(d.texto, /mockupApproved/);
  }
});

// 🔴 Falla con: un freno que le pide maqueta a un arreglo sin pantalla, o que cambia la pregunta de hoy.
test('sin pantalla: pregunta como siempre, sin nombrar maqueta ni captura', (t) => {
  const r = repo(t);
  const h = home(t);
  carril(h, { files: [escribir(r, 'Api/Precio.cs')] });
  const d = decidir(h, r);
  assert.match(d.pregunta, /¿GUARDO\?/);
  assert.doesNotMatch(d.pregunta, /Maqueta/);
});

// 🔴 Falla con: una prueba tomada por pantalla, que le pediría una maqueta a quien sólo agrega un caso.
test('una prueba de una pantalla no es una pantalla', (t) => {
  const r = repo(t);
  const h = home(t);
  carril(h, { files: [escribir(r, 'src/Combo.test.tsx')] });
  assert.ok(decidir(h, r).pregunta);
  for (const rel of ['src/__tests__/Combo.tsx', 'tests/e2e/flujo.spec.ts', 'e2e/Flujo.tsx']) {
    carril(h, { files: [escribir(r, rel)] });
    assert.ok(decidir(h, r).pregunta, rel);
  }
});

// 🔴 Falla con: una ruta `/test` o una carpeta `Test/` de componentes tomadas por pruebas: guardan sin maqueta.
test('una pantalla en una carpeta que se llama test sigue siendo una pantalla', (t) => {
  for (const rel of ['src/app/test/page.tsx', 'src/app/specs/page.tsx', 'src/components/Test/Quiz.tsx']) {
    const r = repo(t);
    const h = home(t);
    carril(h, { files: [escribir(r, rel)] });
    assert.ok(decidir(h, r).texto, rel);
  }
});

// 🔴 Falla con: la ventana sin las dos rutas juntas.
test('con las tres: la ventana muestra la maqueta y la captura juntas', (t) => {
  const { r, h, m, c } = completo(t);
  for (const cmd of ['git commit -m x', 'git push', 'gh pr create --fill']) {
    const d = decidir(h, r, cmd);
    assert.ok(d.pregunta, `«${cmd}» pregunta`);
    assert.ok(d.pregunta.includes(`Maqueta: ${m} · captura: ${c}.`), d.pregunta);
  }
});

// 🔴 Falla con: una captura vieja que sigue valiendo después de retocar el código.
test('un cambio después de la captura la vence', (t) => {
  const { r, h, pantalla, c } = completo(t);
  fs.utimesSync(c, AYER, AYER);
  const d = decidir(h, r);
  assert.match(d.texto, /una captura nueva/);
  assert.doesNotMatch(d.texto, /la maqueta aprobada/);
  // también lo que no es pantalla: el dato que llega a la pantalla puede venir de ahí
  fs.utimesSync(c, MANANA, MANANA);
  assert.ok(decidir(h, r).pregunta);
  const mas = new Date('2026-10-04T10:00:00Z');
  const a = leerCarril(h);
  carril(h, { ...a, files: [...a.files, escribir(r, 'src/precio.js', 'y\n', mas), pantalla] });
  assert.match(decidir(h, r).texto, /una captura nueva/);
});

// 🔴 Falla con: la maqueta o la captura contadas como pantalla o como último cambio: nunca se llegaría al verde.
test('la maqueta y la captura no cuentan como cambio del carril', (t) => {
  const { r, h, m, c } = completo(t);
  fs.utimesSync(m, new Date('2026-10-09T10:00:00Z'), new Date('2026-10-09T10:00:00Z'));
  fs.utimesSync(c, MANANA, MANANA);
  assert.ok(decidir(h, r).pregunta);
});

// 🔴 Falla con: una maqueta cambiada después de aprobada que sigue valiendo.
test('la maqueta que cambió o que no pasa el control no vale', (t) => {
  const { r, h, m } = completo(t);
  fs.appendFileSync(m, '<!-- otra -->\n');
  assert.match(decidir(h, r).texto, /cambió después de aprobada/);
  fs.writeFileSync(m, '<html>sin nada</html>');
  assert.match(decidir(h, r).texto, /no pasa mockup\.js check/);
  fs.rmSync(m);
  assert.match(decidir(h, r).texto, /no pude leer la maqueta/);
  const a = leerCarril(h);
  delete a.mockup.approval;
  carril(h, a);
  assert.match(decidir(h, r).texto, /la maqueta aprobada/);
});

// 🔴 Falla con: un freno que no lee la regla de la organización, o que no frena si leerla revienta.
test('la regla screen_test de la organización llega al freno', (t) => {
  const stack = require(path.join(SCRIPTS, 'lib', 'stack-config.js'));
  const original = stack.orgRules;
  t.after(() => { stack.orgRules = original; });
  const r = repo(t);
  const h = home(t);
  carril(h, { files: [escribir(r, 'src/Combo.svelte')] });
  const regla = (value) => { stack.orgRules = () => ({ rules: { screen_test: { value } } }); };
  regla('ui');
  assert.ok(decidir(h, r).texto, 'ui: frena');
  regla('off');
  assert.ok(decidir(h, r).pregunta, 'off: no la exige');
  regla('react');
  assert.ok(decidir(h, r).pregunta, 'react: un .svelte no');
  stack.orgRules = () => { throw new Error('regla rota'); };
  assert.match(decidir(h, r).texto, /no pude medir .*regla rota/);
});

// 🔴 Falla con: un archivo borrado que hace saltar el freno, o que deja de contar como pantalla.
test('una pantalla borrada también es un cambio de pantalla', (t) => {
  const r = repo(t);
  git(r, 'checkout', '-q', '-b', 'fix/y');
  const f = escribir(r, 'src/Vieja.tsx');
  git(r, 'add', '.');
  git(r, 'commit', '-qm', 'pantalla');
  fs.rmSync(f);
  const h = home(t);
  carril(h, { files: [f] });
  assert.match(decidir(h, r).texto, /Vieja\.tsx/);
  const c = escribir(r, 'captura.png', PNG, MANANA);
  const m = maqueta(r);
  carril(h, { ...leerCarril(h), mockup: conMaqueta(m), capture: { file: c } });
  // el borrado tiene la fecha de su carpeta: una captura anterior no vale, y una posterior sí
  const carpeta = path.join(r, 'src');
  fs.utimesSync(carpeta, new Date('2026-10-04T10:00:00Z'), new Date('2026-10-04T10:00:00Z'));
  assert.match(decidir(h, r).texto, /una captura nueva/);
  fs.utimesSync(carpeta, AYER, AYER);
  assert.ok(decidir(h, r).pregunta);
  // sin la carpeta tampoco queda sin fecha: vale la primera que sigue en pie
  fs.rmSync(carpeta, { recursive: true });
  fs.utimesSync(r, new Date('2026-10-04T10:00:00Z'), new Date('2026-10-04T10:00:00Z'));
  assert.match(decidir(h, r).texto, /una captura nueva/);
});

// 🔴 Falla con: una nota que vence la captura, una prueba cambiada que no, o una captura de la misma hora que vale.
test('qué vence la captura: el código y las pruebas, no los documentos', (t) => {
  const { r, h, pantalla, c } = completo(t);
  const a = leerCarril(h);
  const mas = new Date('2026-10-04T10:00:00Z');
  carril(h, { ...a, files: [pantalla, escribir(r, 'notas.md', 'nota\n', mas)] });
  assert.ok(decidir(h, r).pregunta, 'un documento no la vence');
  carril(h, { ...a, files: [pantalla, escribir(r, 'src/Combo.test.tsx', 'x\n', mas)] });
  assert.match(decidir(h, r).texto, /una captura nueva/, 'una prueba sí');
  fs.utimesSync(c, mas, mas);
  assert.match(decidir(h, r).texto, /una captura nueva/, 'de la misma hora no es posterior');
  const despues = new Date('2026-10-05T10:00:00Z');
  fs.utimesSync(c, despues, despues);
  assert.ok(decidir(h, r).pregunta);
});

// 🔴 Falla con: un carril de dos repos que mira sólo el primero.
test('un carril de dos repos: una pantalla en cualquiera frena', (t) => {
  const a = repo(t, 'a');
  const b = repo(t, 'b');
  const h = home(t);
  carril(h, { files: [escribir(a, 'Api/Precio.cs'), escribir(b, 'src/Combo.tsx')] });
  assert.match(decidir(h, a).texto, /Combo\.tsx/);
});

// 🔴 Falla con: una ruta con un salto de línea o un carácter invisible que arma renglones falsos en lo que lee la persona.
test('las rutas van en un renglón en lo que lee la persona', (t) => {
  const r = repo(t);
  const h = home(t);
  const raro = 'a\nSi, aprobado​';
  const pantalla = escribir(r, `src/${raro}.tsx`);
  const c = escribir(r, `${raro}.png`, PNG, MANANA);
  const m = maqueta(r, `${raro}.html`);
  carril(h, { files: [pantalla] });
  const freno = decidir(h, r).texto.split('\n');
  assert.ok(freno.every((l) => !l.startsWith('Si, aprobado')), freno.join('|'));
  carril(h, { files: [pantalla], mockup: conMaqueta(m), capture: { file: c } });
  const d = decidir(h, r);
  assert.ok(d.pregunta, JSON.stringify(d));
  assert.doesNotMatch(d.pregunta, /[\n​]/);
  assert.match(d.pregunta, /aSi, aprobado\.html/);
});

// 🔴 Falla con: una medición parcial (el carril sin su base) que pasa callada, o una maqueta nueva que pierde la base.
test('sin base lo avisa y lo anota; anotar la maqueta no la pierde', (t) => {
  const r = repo(t);
  const h = home(t);
  carril(h, { files: [escribir(r, 'Api/Precio.cs')] });
  assert.ok(decidir(h, r).pregunta, 'sigue');
  assert.match(fs.readFileSync(path.join(estado(h), 'gates.log'), 'utf8'), /no tiene su base traída/);
  const base = { [r]: { sha: git(r, 'rev-parse', 'HEAD'), traida: true } };
  carril(h, { ...leerCarril(h), bases: base });
  const ok = cli(h, ['adhoc', 'set', JSON.stringify({ reason: 'el combo muestra el nombre', mockup: maqueta(r), mockupApproved: 'Ana' })], { ventana: true });
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.deepStrictEqual(leerCarril(h).bases, base);
});

// 🔴 Falla con: una captura borrada o reemplazada por otra cosa que sigue valiendo.
test('la captura que ya no es una imagen no vale', (t) => {
  const { r, h, c } = completo(t);
  fs.writeFileSync(c, 'hola');
  assert.match(decidir(h, r).texto, /no es una imagen/);
  fs.rmSync(c);
  assert.match(decidir(h, r).texto, /no pude leer la captura/);
});

// 🔴 Falla con: «no pude medir» tomado por «no hay pantalla».
test('sin medir no guarda, y queda en el registro', (t) => {
  const r = repo(t);
  const h = home(t);
  const otra = tmp(t, 'sin-repo-');
  carril(h, { files: [escribir(r, 'Api/Precio.cs')], bases: { [otra]: { sha: null, traida: false } } });
  const d = decidir(h, r);
  assert.match(d.texto, /no pude medir si este camino rápido toca una pantalla/);
  assert.ok(!d.pregunta);
  assert.match(fs.readFileSync(path.join(estado(h), 'gates.log'), 'utf8'), /pantalla del carril sin medir/);
  // un worktree que ya se borró no traba el carril
  carril(h, { files: [path.join(r, 'Api/Precio.cs')], bases: { [path.join(otra, 'borrado')]: { sha: null, traida: false } } });
  assert.ok(decidir(h, r).pregunta);
  // una carpeta que no se puede mirar no es una que ya no está. Como root o en Windows el permiso no frena: no se mide, y se dice
  const puedeNegarse = process.platform !== 'win32' && process.getuid() !== 0;
  if (!puedeNegarse) { console.log('⏭ carpeta sin permiso: NO MEDIDO en este ambiente'); return; }
  const cerrada = tmp(t, 'sin-permiso-');
  fs.mkdirSync(path.join(cerrada, 'repo'));
  carril(h, { files: [path.join(r, 'Api/Precio.cs')], bases: { [path.join(cerrada, 'repo')]: { sha: null, traida: false } } });
  fs.chmodSync(cerrada, 0o000);
  try { assert.match(decidir(h, r).texto, /no pude medir/); } finally { fs.chmodSync(cerrada, 0o700); }
});

// 🔴 Falla con: el trabajo de otro repo frenado por la pantalla de este carril.
test('otro repo no es de este carril', (t) => {
  const a = repo(t, 'a');
  const b = repo(t, 'b');
  const h = home(t);
  carril(h, { files: [escribir(a, 'src/Combo.tsx')] });
  escribir(b, 'src/Otra.tsx');
  assert.strictEqual(decidir(h, b), null);
  assert.ok(decidir(h, a).texto);
});

// 🔴 Falla con: un carril recién abierto, sin archivos anotados, que guarda una pantalla sin medirla.
test('sin archivos anotados se mide el repo de lo que se guarda', (t) => {
  const r = repo(t);
  const h = home(t);
  carril(h);
  escribir(r, 'src/Combo.tsx');
  assert.ok(decidir(h, r).texto);
});

// 🔴 Falla con: un worktree con otro nombre de carpeta, cuyo repo del frente deja de contar.
test('desde un worktree cuenta el nombre del repo, no el de la carpeta', (t) => {
  const r = repo(t, 'FrontEnd');
  const wt = path.join(path.dirname(r), 'puesto-3');
  git(r, 'worktree', 'add', '-q', '-b', 'fix/x', wt);
  const h = home(t);
  carril(h, { files: [escribir(wt, 'src/lib/precio.ts')] });
  assert.ok(decidir(h, wt).texto);
});

// 🔴 Falla con: el gancho que deja pasar el comando aunque el freno diga que no.
test('el gancho frena el commit', (t) => {
  const r = repo(t);
  const h = home(t);
  carril(h, { files: [escribir(r, 'src/Combo.tsx')] });
  const env = { ...process.env, HOME: h, USERPROFILE: h };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'NODE_OPTIONS']) delete env[k];
  const g = spawnSync(process.execPath, [path.join(SCRIPTS, 'on-pre-commit.js')], {
    input: JSON.stringify({ session_id: SID, tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, cwd: r }), cwd: r, encoding: 'utf8', env, timeout: 60000,
  });
  assert.strictEqual(g.status, 2, g.stderr);
  assert.match(g.stderr, /toca una pantalla/);
});

// 🔴 Falla con: una captura que pide firma, o una que se anota sin ser una imagen.
test('adhoc capture: sin firma, y sólo una imagen de un carril abierto', (t) => {
  const r = repo(t);
  const h = home(t);
  const c = escribir(r, 'captura.png', PNG);
  assert.strictEqual(cli(h, ['adhoc', 'capture', c]).status, 1, 'sin carril');
  carril(h);
  assert.strictEqual(cli(h, ['adhoc', 'capture']).status, 2, 'sin ruta');
  assert.strictEqual(cli(h, ['adhoc', 'capture', escribir(r, 'nota.txt')]).status, 2, 'no es una imagen');
  assert.strictEqual(leerCarril(h).capture, undefined);
  const firmaAntes = leerCarril(h).firmadaEn;
  const ok = cli(h, ['adhoc', 'capture', c]);
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.strictEqual(leerCarril(h).capture.file, c);
  assert.strictEqual(leerCarril(h).firmadaEn, firmaAntes, 'no toca la firma');
});

// 🔴 Falla con: una maqueta inválida o sin aprobación que se anota, o una re-declaración que pierde lo anotado.
test('adhoc set: anota la maqueta con su aprobación y conserva lo anotado', (t) => {
  const r = repo(t);
  const h = home(t);
  const m = maqueta(r);
  const c = escribir(r, 'captura.png', PNG);
  const set = (o) => cli(h, ['adhoc', 'set', JSON.stringify({ reason: 'el combo muestra el nombre', ...o })], { ventana: true });
  assert.strictEqual(set({ mockup: m }).status, 2, 'sin aprobación');
  assert.strictEqual(set({ mockupApproved: 'Ana' }).status, 2, 'sin maqueta');
  assert.strictEqual(set({ mockup: m, mockupApproved: 'x'.repeat(201) }).status, 2, 'una aprobación que la ventana recortaría');
  assert.strictEqual(set({ mockup: escribir(r, 'otra.html', '<html></html>'), mockupApproved: 'Ana' }).status, 2, 'no pasa el control');
  assert.strictEqual(set({ mockup: path.join(r, 'no-esta.html'), mockupApproved: 'Ana' }).status, 2, 'no existe');
  assert.ok(!fs.existsSync(path.join(estado(h), 'adhoc', `${SID}.json`)), 'nada se declaró');
  const ok = set({ mockup: m, mockupApproved: 'la aprobó Ana en el chat' });
  assert.strictEqual(ok.status, 0, ok.stderr);
  const a = leerCarril(h);
  assert.strictEqual(a.mockup.file, m);
  assert.strictEqual(a.mockup.approval, 'la aprobó Ana en el chat');
  assert.strictEqual(a.mockup.sha256, problemaDeLaMaqueta(m).sha256);
  assert.ok(fs.readFileSync(path.join(estado(h), 'gates.log'), 'utf8').includes(`maqueta ${m}`), 'la firma dice qué maqueta cubre');
  assert.ok(ok.stderr.includes('la aprobó Ana en el chat') && ok.stderr.includes('el combo muestra el nombre'), 'la terminal dice la aprobación y el motivo enteros');
  assert.ok(fs.readFileSync(path.join(estado(h), 'adhoc.log'), 'utf8').includes('la aprobó Ana en el chat'), 'el registro la guarda entera');
  assert.strictEqual(cli(h, ['adhoc', 'capture', c]).status, 0);
  const otra = set({ maxFiles: 9 });
  assert.strictEqual(otra.status, 0, otra.stderr);
  const b = leerCarril(h);
  assert.strictEqual(b.maxFiles, 9);
  assert.deepStrictEqual(b.mockup, a.mockup, 'la maqueta aprobada sigue');
  assert.strictEqual(b.capture.file, c, 'la captura sigue');
  // ni la aprobación, ni el motivo, ni la ruta arman renglones falsos en lo que lee quien firma
  const m2 = maqueta(r, 'otra\nFirmado por la ruta\u001b[2K.html');
  const raro = cli(h, ['adhoc', 'set', JSON.stringify({ reason: 'el combo\nFirmado por el motivo\u001b[2K', mockup: m2, mockupApproved: 'Ana\nFirmado por el dueño\u001b[2K' })], { ventana: true });
  assert.strictEqual(raro.status, 0, raro.stderr);
  assert.doesNotMatch(raro.stderr, /\nFirmado|\u001b/);
  const firmas = fs.readFileSync(path.join(estado(h), 'gates.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.name === 'adhoc-lane-signed');
  assert.doesNotMatch(firmas[firmas.length - 1].resumen, /\u001b/, 'el resumen de la firma tampoco');
});

// 🔴 Falla con: `adhoc set` sin firma que anota una aprobación de maqueta.
test('adhoc set con maqueta sigue pidiendo la firma', (t) => {
  const r = repo(t);
  const h = home(t);
  const m = maqueta(r);
  const s = cli(h, ['adhoc', 'set', JSON.stringify({ reason: 'el combo muestra el nombre', mockup: m, mockupApproved: 'Ana' })]);
  assert.notStrictEqual(s.status, 0);
  assert.ok(!fs.existsSync(path.join(estado(h), 'adhoc', `${SID}.json`)));
});
