'use strict';
/**
 * instinct-dirs.test.js — dónde viven las propuestas del grabador de aprendizajes (story 8.27).
 *
 * EL CASO (2026-10-09). El observador, el disparador del arranque y el comando de revisión creaban `inbox/instincts/`
 * dentro del árbol del arnés aunque ese árbol no la trajera (una versión bajada, la copia pública): una prueba fallaba
 * siempre a la primera sobre la copia, y en un arnés instalado lo escrito se perdía con la actualización siguiente.
 * Ahora una sola pieza, scripts/instincts/instinct-dirs.js, dice dónde se escribe y dónde se lee.
 *
 * Qué fija (los números son los de la tabla de pruebas de la story):
 *   T1  un árbol que TRAE su buzón (tiene inbox/instincts/README.md) escribe en el árbol, como siempre
 *   T2  un árbol que no lo trae escribe en la casa de la persona: <estado>/inbox/instincts, con el estado que contesta
 *       tycon-home.js; una carpeta de estado vacía (el resto de una instalación cortada) no cuenta
 *   T3  una carpeta inbox/instincts/ que dejó una versión anterior, sin README.md, se LEE y no se escribe
 *   T4  los lugares de lectura: el de escritura primero, sin repetidos (por ruta real), con el clon que la máquina
 *       declara que mantiene y con la casa de cada carpeta de estado que exista
 *   T5  sin tycon-home.js nadie cae al árbol: error con nombre propio; con buzón, el árbol; cargar los guiones no tira
 *   T6  pedir los lugares no crea nada; --prepare-log crea sólo su lugar e imprime la ruta, byte a byte
 *   T7  la pieza no ve la configuración de la máquina que corre la prueba
 *   T8  en el repo interno, el README.md del buzón existe (es la señal de la regla)
 *   y, de la vuelta de revisores: lo que no se pudo leer se dice (notas, y una carpeta ilegible no es una vacía), y
 *   las pruebas no dependen de la TYCON_HOME de quien las corre (el pase adversarial las puso rojas exportándola)
 * 🔴 Nada toca la carpeta de usuario real: cada caso arma la suya en el temporal y corre la pieza en un proceso hijo.
 * Correr: node --test scripts/tests/instinct-dirs.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Los valores ESPERADOS de cada caso se calculan acá, con tycon-home.js, que mira TYCON_HOME antes que la carpeta de
// usuario; la pieza corre en un hijo que no la recibe. Con una TYCON_HOME heredada del ambiente de quien corre, lo
// esperado se iba a esa carpeta y lo medido no: 2 rojos falsos (pase adversarial de la story). Se saca al cargar; el caso
// que la necesita la fija a propósito en el hijo.
delete process.env.TYCON_HOME;

const ROOT = path.resolve(__dirname, '..', '..');
const PIECE = path.join(ROOT, 'scripts', 'instincts', 'instinct-dirs.js');
const HOME_JS = path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js');
const TH = require(HOME_JS);
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const real = (p) => fs.realpathSync.native(p);
const inbox = (base) => path.join(base, 'inbox', 'instincts');
/** La casa esperada bajo una carpeta de estado: se compara por ruta real del estado (el temporal va detrás de un enlace). */
const sameDir = (a, b) => {
  const norm = (p) => { let cur = p; const tail = []; while (!fs.existsSync(cur)) { tail.unshift(path.basename(cur)); cur = path.dirname(cur); } return path.join(real(cur), ...tail); };
  return norm(a) === norm(b);
};
const assertSame = (got, want, msg) => assert.ok(sameDir(got, want), `${msg || 'ruta'}: dio ${got}, esperaba ${want}`);

/** Un árbol de juguete con la pieza adentro. `inboxReadme`: trae su buzón; `home`: copia tycon-home.js (por omisión, sí). */
function tree(lab, name, { inboxReadme = false, withHome = true, leftover = false, scripts = false } = {}) {
  const t = path.join(lab, name);
  fs.mkdirSync(path.join(t, 'scripts', 'instincts'), { recursive: true });
  fs.copyFileSync(PIECE, path.join(t, 'scripts', 'instincts', 'instinct-dirs.js'));
  if (scripts) for (const f of ['instinct-observer.js', 'instinct-promote.js', 'instinct-draft.js']) fs.copyFileSync(path.join(ROOT, 'scripts', 'instincts', f), path.join(t, 'scripts', 'instincts', f));
  if (withHome) {
    fs.mkdirSync(path.join(t, 'scripts', 'setup', 'harness'), { recursive: true });
    fs.copyFileSync(HOME_JS, path.join(t, 'scripts', 'setup', 'harness', 'tycon-home.js'));
  }
  if (inboxReadme) { fs.mkdirSync(inbox(t), { recursive: true }); fs.writeFileSync(path.join(inbox(t), 'README.md'), '# el buzón\n'); }
  if (leftover) fs.mkdirSync(path.join(inbox(t), 'pending'), { recursive: true });
  return t;
}
/** Una carpeta de usuario de laboratorio. `own`: vive en la casa propia del arnés; `stale`: la carpeta de estado, vacía. */
function home(lab, name, { own = false, stale = false, release = false, maintained = null } = {}) {
  const h = path.join(lab, name);
  fs.mkdirSync(h, { recursive: true });
  const state = own || stale ? TH.ownStateDir(h) : TH.legacyStateDir(h);
  if (own || stale || release) fs.mkdirSync(state, { recursive: true });
  if (own || release) fs.writeFileSync(path.join(state, 'harness-state.json'), JSON.stringify({ sources: release ? [{ kind: 'release' }] : [] }));
  if (maintained) {
    const cfg = path.join(h, '.tycon', 'config.json');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, JSON.stringify({ paths: { maintained } }));
  }
  return h;
}
/** El ambiente de un proceso hijo: sólo lo que hace falta para lanzar Node, más la carpeta de usuario del laboratorio. */
function labEnv(h, extra = {}) {
  const env = {};
  for (const k of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR']) if (process.env[k] !== undefined) env[k] = process.env[k];
  return Object.assign(env, { HOME: h, USERPROFILE: h }, extra);
}
/** Corre la pieza del árbol `t` con la carpeta de usuario `h`. Devuelve { status, stdout, stderr, json }. */
function run(t, h, args = ['--json'], extraEnv = {}) {
  const r = spawnSync(process.execPath, [path.join(t, 'scripts', 'instincts', 'instinct-dirs.js'), ...args], { encoding: 'utf8', env: labEnv(h, extraEnv) });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) { /* no era JSON */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
const ls = (d) => { try { return fs.readdirSync(d).sort().join(','); } catch (_) { return '(no existe)'; } };

test('T1 InstinctDirs_TreeWithInbox_WritesInTree — un árbol que trae su buzón escribe en el árbol, y no se crea nada', () => {
  const lab = tmp('instinct-dirs-t1-');
  const t = tree(lab, 'clon', { inboxReadme: true });
  const h = home(lab, 'casa');
  const antes = ls(t);
  const r = run(t, h);
  assert.strictEqual(r.status, 0, r.stderr);
  assertSame(r.json.write, inbox(t), 'lugar de escritura');
  assert.strictEqual(r.json.read.length, 1, `un solo lugar de lectura: ${JSON.stringify(r.json.read)}`);
  assertSame(r.json.read[0], inbox(t));
  assert.strictEqual(ls(t), antes, 'el árbol no cambia');
  assert.strictEqual(ls(h), '', 'la carpeta de usuario sigue vacía');
});

test('T2 InstinctDirs_TreeWithoutInbox_WritesInPersonState — sin buzón, la casa de la persona según dónde vive su estado', () => {
  const lab = tmp('instinct-dirs-t2-');
  const t = tree(lab, 'instalado');
  // (a) vive en la casa propia del arnés
  const propia = home(lab, 'propia', { own: true });
  let r = run(t, propia);
  assert.strictEqual(r.status, 0, r.stderr);
  assertSame(r.json.write, inbox(TH.ownStateDir(propia)), '(a) casa propia');
  // (b) no vive ahí: el estado de siempre
  const siempre = home(lab, 'siempre');
  r = run(t, siempre);
  assertSame(r.json.write, inbox(TH.legacyStateDir(siempre)), '(b) estado de siempre');
  assert.strictEqual(ls(siempre), '', '(b) pedir el lugar no crea nada en la carpeta de usuario');
  // (c) una carpeta de estado vacía es el resto de una instalación cortada: no cuenta
  const cortada = home(lab, 'cortada', { stale: true });
  r = run(t, cortada);
  assertSame(r.json.write, inbox(TH.legacyStateDir(cortada)), '(c) estado vacío no cuenta');
  // (d) TYCON_HOME manda, como en todo el arnés
  const otra = path.join(lab, 'otra-casa');
  fs.mkdirSync(path.join(otra, 'state'), { recursive: true });
  fs.writeFileSync(path.join(otra, 'state', 'harness-state.json'), '{"sources":[]}');
  r = run(t, siempre, ['--json'], { TYCON_HOME: otra });
  assertSame(r.json.write, inbox(path.join(otra, 'state')), '(d) TYCON_HOME');
  assert.ok(!fs.existsSync(path.join(t, 'inbox')), 'el árbol no gana inbox/');
});

test('T3 InstinctDirs_LeftoverFolder_ReadNotWritten — una carpeta sin README.md se lee, no se escribe', () => {
  const lab = tmp('instinct-dirs-t3-');
  const t = tree(lab, 'copia', { leftover: true });
  const h = home(lab, 'casa');
  const r = run(t, h);
  assert.strictEqual(r.status, 0, r.stderr);
  assertSame(r.json.write, inbox(TH.legacyStateDir(h)), 'se escribe en la casa');
  assert.strictEqual(r.json.read.length, 2, JSON.stringify(r.json.read));
  assertSame(r.json.read[0], r.json.write, 'el de escritura va primero');
  assertSame(r.json.read[1], inbox(t), 'el buzón sobrante del árbol se lee');
});

test('T4 InstinctDirs_ReadPlaces_UniqueAndOrdered — el clon mantenido, las dos casas, y nada repetido', () => {
  const lab = tmp('instinct-dirs-t4-');
  const clon = tree(lab, 'clon-mantenido', { inboxReadme: true });
  const t = tree(lab, 'instalado');
  // versión bajada que declara el clon que mantiene
  const h = home(lab, 'casa', { own: true, release: true, maintained: clon });
  let r = run(t, h);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.read.length, 2, JSON.stringify(r.json.read));
  assertSame(r.json.read[0], inbox(TH.ownStateDir(h)), 'escritura primero');
  assertSame(r.json.read[1], inbox(clon), 'el clon mantenido');
  // corrido desde el propio clon: se escribe ahí y no sale dos veces
  r = run(clon, h);
  assertSame(r.json.write, inbox(clon));
  assert.strictEqual(r.json.read.filter((p) => sameDir(p, inbox(clon))).length, 1, `el clon una sola vez: ${JSON.stringify(r.json.read)}`);
  // el clon declarado por otro camino (un enlace) sigue siendo el mismo lugar
  const enlace = path.join(lab, 'enlace-al-clon');
  let conEnlace = true;
  try { fs.symlinkSync(clon, enlace, 'junction'); } catch (_) { conEnlace = false; }
  if (conEnlace) {
    const h2 = home(lab, 'casa-enlace', { own: true, release: true, maintained: enlace });
    r = run(clon, h2);
    assert.strictEqual(r.json.read.length, 1, `por el enlace, el mismo lugar: ${JSON.stringify(r.json.read)}`);
  }
  // un clon declarado que no existe, y uno que no trae buzón: no suman
  const sinBuzon = tree(lab, 'clon-sin-buzon', { leftover: true });
  for (const m of [path.join(lab, 'no-existe'), sinBuzon]) {
    const hx = home(lab, `casa-${path.basename(m)}`, { own: true, release: true, maintained: m });
    r = run(t, hx);
    assert.strictEqual(r.json.read.length, 1, `${path.basename(m)} no suma: ${JSON.stringify(r.json.read)}`);
  }
  // la casa cambió sin mudanza: lo de la otra carpeta de estado se sigue viendo
  const dos = home(lab, 'dos-casas', { own: true });
  fs.mkdirSync(inbox(TH.legacyStateDir(dos)), { recursive: true });
  r = run(t, dos);
  assert.strictEqual(r.json.read.length, 2, JSON.stringify(r.json.read));
  assertSame(r.json.read[0], inbox(TH.ownStateDir(dos)));
  assertSame(r.json.read[1], inbox(TH.legacyStateDir(dos)), 'la casa de la otra carpeta de estado');
});

test('T5 InstinctDirs_NoStateResolver_NeverFallsToTree — sin tycon-home.js: error con nombre propio, nunca el árbol', () => {
  const lab = tmp('instinct-dirs-t5-');
  const h = home(lab, 'casa');
  const t = tree(lab, 'suelto', { withHome: false, leftover: true, scripts: true });
  const antes = ls(t);
  let r = run(t, h);
  assert.strictEqual(r.status, 1, `tenía que salir 1: ${r.stdout}${r.stderr}`);
  assert.strictEqual(r.stdout, '', 'nada en la salida estándar');
  assert.match(r.stderr, /InstinctDirsError/);
  assert.match(r.stderr, /tycon-home\.js/);
  assert.strictEqual(ls(t), antes, 'el árbol no cambia');
  assert.strictEqual(ls(h), '', 'la carpeta de usuario sigue vacía');
  // con buzón, la misma falla no cambia nada: se escribe y se lee en el árbol
  const conBuzon = tree(lab, 'suelto-con-buzon', { withHome: false, inboxReadme: true });
  r = run(conBuzon, h);
  assert.strictEqual(r.status, 0, r.stderr);
  assertSame(r.json.write, inbox(conBuzon));
  assert.strictEqual(r.json.read.length, 1);
  // ...pero se DICE que la carpeta de usuario y el clon mantenido quedaron sin mirar
  assert.ok(r.json.notes.some((n) => /tycon-home\.js/.test(n) && /sólo se mira el buzón de este árbol/.test(n)), `la nota: ${JSON.stringify(r.json.notes)}`);
  // cargar los tres guiones no resuelve lugares: no tira ni crea nada
  const c = spawnSync(process.execPath, ['-e', 'for (const f of ["instinct-observer.js","instinct-draft.js","instinct-promote.js"]) require(require("path").join(process.argv[1], f)); process.stdout.write("cargados")', path.join(t, 'scripts', 'instincts')],
    { encoding: 'utf8', env: labEnv(h) });
  assert.strictEqual(c.status, 0, `cargar los guiones tiró: ${c.stderr}`);
  assert.strictEqual(c.stdout, 'cargados', `cargar un guion no ejecuta nada: ${c.stdout}`);
  assert.strictEqual(ls(t), antes, 'cargar no crea nada en el árbol');
  assert.strictEqual(ls(h), '', 'ni en la carpeta de usuario');
});

test('T6 InstinctDirs_PrepareLog_CreatesOnlyItsPlace_ExactBytes — el registro: sólo su lugar, y la ruta byte a byte', () => {
  const lab = tmp('instinct-dirs-t6-');
  const t = tree(lab, 'instalado');
  const h = home(lab, 'casa');
  const casa = inbox(TH.legacyStateDir(h));
  let r = run(t, h, ['--prepare-log']);
  assert.strictEqual(r.status, 0, r.stderr);
  const log = path.join(casa, 'observer.log');
  assert.ok(r.stdout.endsWith('/observer.log\n'), `termina en la ruta y un salto simple: ${JSON.stringify(r.stdout)}`);
  assert.ok(!r.stdout.includes('\r') && !r.stdout.includes('\\') && r.stdout.split('\n').length === 2, `una línea, con «/»: ${JSON.stringify(r.stdout)}`);
  assertSame(r.stdout.trim(), log, 'la ruta impresa');
  assert.strictEqual(fs.readFileSync(log, 'utf8'), '', 'el registro nace vacío');
  assert.strictEqual(ls(casa), 'observer.log', 'crea sólo su lugar, sin subcarpetas');
  assert.ok(!fs.existsSync(path.join(t, 'inbox')), 'el árbol no gana inbox/');
  // otra corrida no pisa lo escrito
  fs.writeFileSync(log, 'una línea del observador\n');
  r = run(t, h, ['--prepare-log']);
  assert.strictEqual(fs.readFileSync(log, 'utf8'), 'una línea del observador\n');
  // con buzón, el registro va al árbol y la casa no se crea
  const clon = tree(lab, 'clon', { inboxReadme: true });
  const h2 = home(lab, 'casa2');
  r = run(clon, h2, ['--prepare-log']);
  assert.strictEqual(r.status, 0, r.stderr);
  assertSame(r.stdout.trim(), path.join(inbox(clon), 'observer.log'));
  assert.strictEqual(ls(h2), '', 'la casa no se crea');
  // sin poder resolver: sale 1 y no imprime ninguna ruta
  const suelto = tree(lab, 'suelto', { withHome: false });
  r = run(suelto, h2, ['--prepare-log']);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.stdout, '');
  assert.ok(!fs.existsSync(path.join(suelto, 'inbox')), 'ni así se crea inbox/ en el árbol');
});

test('T7 InstinctDirs_IgnoresTheRealMachine — la configuración de quien corre la prueba no entra', () => {
  const lab = tmp('instinct-dirs-t7-');
  const clon = tree(lab, 'clon-de-la-maquina', { inboxReadme: true });
  // «la máquina real»: una casa propia que declara un clon, puesta en el ambiente de ESTE proceso
  const maquina = path.join(lab, 'casa-de-la-maquina');
  fs.mkdirSync(maquina, { recursive: true });
  fs.writeFileSync(path.join(maquina, 'config.json'), JSON.stringify({ paths: { maintained: clon } }));
  const previa = process.env.TYCON_HOME;
  process.env.TYCON_HOME = maquina;
  try {
    const t = tree(lab, 'instalado');
    const h = home(lab, 'casa');
    const r = run(t, h);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.json.read.length, 1, `el hijo no ve el clon de la máquina: ${JSON.stringify(r.json.read)}`);
    assertSame(r.json.write, inbox(TH.legacyStateDir(h)));
    // el control del caso: lo que aísla es el AMBIENTE del hijo. Con esa misma casa declarada en su ambiente, SÍ lo ve
    const visto = run(t, h, ['--json'], { TYCON_HOME: maquina });
    assert.strictEqual(visto.status, 0, visto.stderr);
    assert.ok(visto.json.read.some((p) => sameDir(p, inbox(clon))), `con TYCON_HOME en su ambiente, la pieza ve el clon declarado: ${JSON.stringify(visto.json.read)}`);
  } finally {
    if (previa === undefined) delete process.env.TYCON_HOME; else process.env.TYCON_HOME = previa;
  }
});

test('T8 InstinctDirs_VersionedInboxKeepsItsReadme — en el repo interno, el README.md del buzón existe', (t) => {
  // el interno se reconoce por su perfil en la raíz, nunca por una carpeta que falta (eso daría verde falso)
  if (!fs.existsSync(path.join(ROOT, 'perfil-equipo.json'))) { t.skip('NO MEDIDO — este árbol no es el repo interno (no trae su perfil): no versiona el buzón'); return; }
  assert.ok(fs.statSync(path.join(inbox(ROOT), 'README.md')).isFile(),
    'inbox/instincts/README.md es la señal de que el árbol trae su buzón (scripts/instincts/instinct-dirs.js): sin él, el grabador de este clon escribiría en la carpeta de usuario');
});

const esRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const sinPermisos = process.platform === 'win32' || esRoot;

test('T21 InstinctDirs_UnreadableIsNotEmpty — lo que no se pudo mirar se dice: nunca se confunde con «no hay»', { skip: sinPermisos ? 'NO MEDIDO — en Windows o como root, quitar permisos no impide leer' : false }, () => {
  const lab = tmp('instinct-dirs-t5b-');
  const h = home(lab, 'casa');
  // un clon cuyo buzón existe y no se deja mirar: NO es «no trae buzón» (escribiría, callado, en la carpeta de usuario)
  const clon = tree(lab, 'clon', { inboxReadme: true });
  fs.chmodSync(inbox(clon), 0o000);
  try {
    const r = run(clon, h);
    assert.strictEqual(r.status, 1, `tenía que salir 1: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /InstinctDirsError/);
    assert.match(r.stderr, /no pude mirar/);
    assert.strictEqual(ls(h), '', 'no cae a la carpeta de usuario');
  } finally { fs.chmodSync(inbox(clon), 0o755); }
  // listDir: una carpeta que no existe no tiene nada y no avisa; una que existe y no se deja leer AVISA
  const out = spawnSync(process.execPath, ['-e', `
    const D = require(process.argv[1]); const fs = require('fs'); const path = require('path');
    const dir = path.join(process.argv[2], 'ilegible'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'a.yaml'), 'x'); fs.chmodSync(dir, 0o000);
    const avisos = [];
    const r = { falta: D.listDir(path.join(process.argv[2], 'no-existe'), (m) => avisos.push('falta: ' + m)), ilegible: D.listDir(dir, (m) => avisos.push(m)) };
    fs.chmodSync(dir, 0o755);
    process.stdout.write(JSON.stringify({ r, avisos }));`, path.join(clon, 'scripts', 'instincts', 'instinct-dirs.js'), lab], { encoding: 'utf8', env: labEnv(h) });
  assert.strictEqual(out.status, 0, out.stderr);
  const j = JSON.parse(out.stdout);
  assert.deepStrictEqual(j.r, { falta: [], ilegible: [] });
  assert.strictEqual(j.avisos.length, 1, `un solo aviso, el de la ilegible: ${JSON.stringify(j.avisos)}`);
  assert.match(j.avisos[0], /no pude leer .*ilegible.*EACCES/);
  // un lugar de LECTURA que no se deja mirar no frena nada: no se suma, y la nota lo dice
  const t = tree(lab, 'instalado');
  // (i) el buzón del clon que la máquina declara
  const otro = tree(lab, 'clon-declarado', { inboxReadme: true });
  const h1 = home(lab, 'casa-clon-ilegible', { own: true, release: true, maintained: otro });
  fs.chmodSync(inbox(otro), 0o000);
  try {
    const r = run(t, h1);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.json.read.length, 1, `el clon que no se puede mirar no suma: ${JSON.stringify(r.json.read)}`);
    assert.match(r.json.notes.join('|'), /no pude mirar el buzón del clon/);
  } finally { fs.chmodSync(inbox(otro), 0o755); }
  // (ii) la configuración de la máquina
  const h2 = home(lab, 'casa-config-ilegible', { own: true, release: true, maintained: otro });
  const cfg = path.join(h2, '.tycon', 'config.json');
  fs.chmodSync(cfg, 0o000);
  try {
    const r = run(t, h2);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.json.read.length, 1);
    assert.match(r.json.notes.join('|'), /no pude leer .*config\.json/);
  } finally { fs.chmodSync(cfg, 0o644); }
  // (iii) la casa de la otra carpeta de estado, que existe y no se deja mirar
  const h3 = home(lab, 'casa-estado-ilegible', { own: true });
  const otraCasa = path.join(TH.legacyStateDir(h3), 'inbox');
  fs.mkdirSync(path.join(otraCasa, 'instincts'), { recursive: true });
  fs.chmodSync(otraCasa, 0o000);
  try {
    const r = run(t, h3);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.json.read.length, 1, `la casa que no se puede mirar no suma: ${JSON.stringify(r.json.read)}`);
    assert.match(r.json.notes.join('|'), /no pude mirar .*instincts.*si hay propuestas ahí, no se ven/);
  } finally { fs.chmodSync(otraCasa, 0o755); }
});

test('T22 InstinctDirs_NotesSayWhatWasNotRead — las notas: clon declarado que no existe, sin buzón, y configuración rota', () => {
  const lab = tmp('instinct-dirs-t7b-');
  const t = tree(lab, 'instalado');
  const sinBuzon = tree(lab, 'clon-sin-buzon', { leftover: true });
  const nota = (m, cfg) => {
    const h = home(lab, `casa-${Math.random().toString(36).slice(2, 8)}`, { own: true, release: true, maintained: m });
    if (cfg !== undefined) fs.writeFileSync(path.join(h, '.tycon', 'config.json'), cfg);
    const r = run(t, h);
    assert.strictEqual(r.status, 0, r.stderr);
    return r.json.notes;
  };
  assert.deepStrictEqual(nota(tree(lab, 'clon-bueno', { inboxReadme: true })), [], 'con el clon declarado y su buzón, ninguna nota');
  assert.match(nota(path.join(lab, 'no-existe')).join('|'), /esa carpeta no existe/);
  assert.match(nota(sinBuzon).join('|'), /no trae su buzón/);
  assert.match(nota(sinBuzon, '{ esto no es JSON').join('|'), /no es JSON válido/);
  assert.deepStrictEqual(nota(null), [], 'sin clon declarado no hay nada que decir acá (lo dice status)');
});

test('T23 InstinctDirs_TestsIgnoreInheritedTyconHome — las pruebas del grabador no dependen de la TYCON_HOME de quien las corre', () => {
  // (a) esta misma suite, con una TYCON_HOME absoluta exportada: los dos casos que el pase adversarial puso en rojo
  if (!process.env.INSTINCT_DIRS_NESTED) {
    const lab = tmp('instinct-dirs-t9-');
    const env = Object.assign({}, process.env, { TYCON_HOME: path.join(lab, 'una-casa-heredada'), INSTINCT_DIRS_NESTED: '1' });
    delete env.NODE_TEST_CONTEXT;   // una prueba de node --test adentro de otra daría verde falso
    const r = spawnSync(process.execPath, ['--test', '--test-name-pattern', '^T2 |^T4 ', __filename], { encoding: 'utf8', env });
    assert.strictEqual(r.status, 0, `con TYCON_HOME heredada, T2 y T4 tienen que pasar igual:\n${r.stdout.slice(-1500)}${r.stderr.slice(-500)}`);
    assert.match(r.stdout, /# pass 2\b/, `corrieron los dos casos: ${r.stdout.slice(-400)}`);
    assert.ok(!fs.existsSync(path.join(lab, 'una-casa-heredada')), 'nadie escribió en la casa heredada');
  }
  // (b) las suites de bash del grabador la neutralizan antes de correr nada: la sacan, o corren con una hostil a propósito
  for (const f of ['instinct-outside-tree.test.sh', 'instinct-executor.test.sh', 'instinct-observer-catalog.test.sh']) {
    const lines = fs.readFileSync(path.join(__dirname, f), 'utf8').split('\n');
    const i = lines.findIndex((l) => /^(unset TYCON_HOME|export TYCON_HOME=)/.test(l));
    const primerComando = lines.findIndex((l) => /^TCG=/.test(l));
    assert.ok(i >= 0 && primerComando >= 0 && i < primerComando, `${f} tiene que neutralizar TYCON_HOME antes de su primer comando (línea ${i + 1}, primer comando en ${primerComando + 1})`);
  }
});
