#!/usr/bin/env node
'use strict';
/**
 * adhoc-list.test.js — la lista de archivos del camino corto.
 *
 *   T27 la lista se guarda normalizada y la firma la muestra
 *   T28 una lista inválida se niega antes de pedir la firma; más código que el tope es pasar el tope
 *   T29 el motivo con un salto de línea se niega antes de pedir nada
 *   T30 un motivo con varios temas no lo abre la coordinadora ni una pestaña sin permisos
 *   T31 un motivo vago, tampoco
 *   T32 editar fuera de la lista frena, por la herramienta y por la consola; dentro, pasa
 *   T33 la comparación es por la ruta real
 *   T34 la prueba del archivo pasa sin nombrarla
 *   T35 ampliar la lista vuelve a pedir el sí y, por delegación, contiene la anterior
 *   T36 fuera de un repo, la carpeta personal y la evidencia
 *   T37 un solo carril delegado por repo
 *   T38 al guardar, un archivo fuera de la lista frena y se nombra
 *   T49 el portón de carril es de lo sensible
 *   T50 un commit delegado con algo sensible frena al guardar
 *   T51 la entrada que sale con cambios frena al guardar
 *   T52 el carril viejo sin lista sigue con el tope hasta su próximo set; con el portón apagado
 *   T57 abrir trae la base de cada repo de la lista; sin red abre con «sin traer»; agrandar no la cambia
 *
 * stable-data: crea repos de git en carpetas temporales con commits propios; nunca toca el repo real.
 * Correr: node --test skills/tycon-pipeline/scripts/tests/adhoc-list.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const MARKER = path.join(SCRIPTS, 'marker.js');
const io = require(path.join(SCRIPTS, 'lib', 'story-gate-io.js'));
const saveBrake = require(path.join(SCRIPTS, 'lib', 'save-brake.js'));
const bash = require(path.join(SCRIPTS, 'on-bash-write-gate.js'));
const { conVentana } = require(path.join(RAIZ, 'scripts', 'tests', 'lib', 'window-passed.js'));

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commitear = (dir, msg = 'x') => git(dir, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', msg);
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const lista = () => require(path.join(SCRIPTS, 'lib', 'adhoc-list.js'));

function repo(raiz, nombre) {
  const origen = path.join(raiz, `${nombre}-origen.git`);
  const dir = path.join(raiz, nombre);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origen]);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  git(dir, 'remote', 'add', 'origin', origen);
  fs.mkdirSync(path.join(dir, '.tycon'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  git(dir, 'add', '.');
  commitear(dir, 'base');
  git(dir, 'push', '-q', 'origin', 'main');
  return dir;
}
function escribir(dir, rel, txt = 'x\n') {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), txt);
  return path.join(dir, rel);
}
const estado = (h) => path.join(h, '.claude', '.tycon-pipeline');
function conCarril(home, sid, extra = {}) {
  const state = estado(home);
  fs.mkdirSync(path.join(state, 'adhoc'), { recursive: true });
  const ts = new Date().toISOString();
  const a = { reason: 'arreglo del combo de clientes', maxFiles: 5, files: [], declaredAt: ts, lastTouch: ts, firmadaEn: ts, datos: 'sin-cambio', ...extra };
  fs.writeFileSync(path.join(state, 'adhoc', `${sid}.json`), JSON.stringify(a));
  fs.appendFileSync(path.join(state, 'gates.log'), `${JSON.stringify({ ts, name: 'adhoc-lane-signed', status: 'ok', destino: sid })}\n`);
  return state;
}
const leerCarril = (h, sid) => JSON.parse(fs.readFileSync(path.join(estado(h), 'adhoc', `${sid}.json`), 'utf8'));
function marker(h, sid, args, { cwd, ventana, delegadaPor } = {}) {
  const env = { ...process.env, HOME: h, USERPROFILE: h, CLAUDE_CODE_SESSION_ID: sid };
  delete env.NODE_OPTIONS;
  const e = ventana || delegadaPor ? conVentana(env, delegadaPor ? { delegadaPor } : {}) : env;
  return spawnSync(process.execPath, [MARKER, ...args], { cwd, encoding: 'utf8', env: e });
}
const pedido = (o) => JSON.stringify({ reason: 'arreglo del combo de clientes', datos: 'sin-cambio', ...o });
const ev = (state, sid, file, cwd) => io.evaluate({ filePath: file, sessionId: sid, cwd, via: 'Edit', stateDir: state, installedRoots: [] });
const porConsola = (state, sid, cwd, command) => bash.handle({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: sid, cwd,
  tool_input: { command } }, { stateDir: state, installedRoots: [] });
const guardar = (dir, sid, home, command = 'git commit -m x') => saveBrake.decidir({ command, cwd: dir, sid, home });

// ── la biblioteca ───────────────────────────────────────────────────────────────────────────────

test('T27 Lista_SeGuardaYSeMuestra — @story-8.174 @ac-25', () => {
  const raiz = tmp('t27-');
  const dir = repo(raiz, 'producto');
  const h = tmp('home-');
  const r = marker(h, 's27', ['adhoc', 'set', pedido({ allowedFiles: ['src/a.js', './src/b.ts', 'docs/x.md', 'src/a.js'] })], { cwd: dir, ventana: true });
  assert.equal(r.status, 0, r.stderr);
  const a = leerCarril(h, 's27');
  assert.deepStrictEqual(a.allowedFiles, [path.join(dir, 'docs/x.md'), path.join(dir, 'src/a.js'), path.join(dir, 'src/b.ts')]);
  // el resumen de la firma dice cuántos y los primeros; la lista entera sale antes en la terminal y queda en el registro
  assert.match(r.stderr, /3 archivos/);
  assert.match(r.stderr, /src\/a\.js/);
  const log = fs.readFileSync(path.join(estado(h), 'adhoc.log'), 'utf8');
  assert.match(log, /"allowedFiles":\[/);
  // con banderas, en la terminal de la persona: --file repetida
  const { pedidoPorBanderas } = require(path.join(SCRIPTS, 'lib', 'adhoc-screen.js'));
  const p = pedidoPorBanderas(['--reason', 'arreglo del combo de clientes', '--data', 'sin-cambio', '--file', 'src/a.js', '--file', 'src/b.ts', '--terminal']);
  assert.deepStrictEqual(p.payload.allowedFiles, ['src/a.js', 'src/b.ts']);
  assert.match(pedidoPorBanderas(['--reason', 'arreglo del combo', '--file', '--terminal']).problema, /--file/);
});

test('T28 Lista_Invalida_SeNiega — @story-8.174 @ac-25 @ac-26 @ac-27', () => {
  const raiz = tmp('t28-');
  const dir = repo(raiz, 'producto');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const malas = [
    [undefined, /lista/], [[], /lista/], [['src/*.js'], /comod/], [['src'], /carpeta/], [['src/'], /carpeta/],
    [['../otro/x.js'], /\.\./], [[path.join(dir, 'src/a.js')], /absoluta/],
    [['src/a.js', 'src/b.js', 'src/c.js'], /c[oó]digo/, 2],
    [['a.md', 'b.md', 'c.md', 'd.md', 'e.md'], /entradas|doble/, 2],
  ];
  for (const [allowedFiles, re, maxFiles] of malas) {
    for (const quien of [{ ventana: true }, { delegadaPor: 'coord' }]) {
      const h = tmp('home-');
      const r = marker(h, 's28', ['adhoc', 'set', pedido({ allowedFiles, ...(maxFiles ? { maxFiles } : {}) })], { cwd: dir, ...quien });
      assert.notEqual(r.status, 0, `${JSON.stringify(allowedFiles)} pasó`);
      assert.match(r.stderr, re, JSON.stringify(allowedFiles));
      // antes de pedir la firma: no dice que la persona no lo aprobó
      assert.doesNotMatch(r.stderr, /no lo aprob/);
      assert.ok(!fs.existsSync(path.join(estado(h), 'adhoc', 's28.json')));
    }
  }
  // una lista válida con más código que el tope de la organización pide pasar el tope (8.181), también sin maxFiles
  const firmas = require(path.join(RAIZ, 'scripts', 'lib', 'signatures.js'));
  const nueve = Array.from({ length: 9 }, (_, i) => `src/f${i}.js`);
  assert.equal(firmas.firmaDelPedidoAdhoc([pedido({ allowedFiles: nueve })], 8), firmas.SOBRE_CUPO);
  assert.equal(firmas.firmaDelPedidoAdhoc([pedido({ allowedFiles: nueve.slice(0, 8) })], 8), 'adhoc-lane');
  assert.equal(firmas.firmaDelPedidoAdhoc(['--reason', 'x', ...nueve.flatMap((f) => ['--file', f])], 8), firmas.SOBRE_CUPO);
  // firmado por la persona, el carril queda con el cupo de la lista y la marca, y la conserva en el set siguiente
  const h = tmp('home-');
  const ok = marker(h, 's28c', ['adhoc', 'set', pedido({ allowedFiles: nueve })], { cwd: dir, ventana: true });
  if (ok.status === 0) {
    const a = leerCarril(h, 's28c');
    assert.equal(a.maxFiles, 9);
    assert.equal(a.sobreCupo, true);
  }
  // sobre cupo con el motivo en dos renglones se niega antes del cuadro
  const ow = require(path.join(RAIZ, 'scripts', 'lib', 'owner-window.js'));
  assert.ok(ow.CHEQUEO_ANTES_DEL_CUADRO.has(firmas.SOBRE_CUPO));
});

test('T29 Motivo_ConSaltoDeLinea_SeNiegaAntes — @story-8.174 @ac-27', () => {
  const raiz = tmp('t29-');
  const dir = repo(raiz, 'producto');
  for (const reason of ['arreglo del combo\nde clientes', 'arreglo del combo\rde clientes']) {
    for (const quien of [{}, { ventana: true }, { delegadaPor: 'coord' }]) {
      const h = tmp('home-');
      const r = marker(h, 's29', ['adhoc', 'set', pedido({ reason, allowedFiles: ['src/a.js'] })], { cwd: dir, ...quien });
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /una l[ií]nea|salto de l[ií]nea/);
      assert.doesNotMatch(r.stderr, /no lo aprob/);
    }
  }
  assert.ok(lista().problemaDelMotivo('arreglo\ndel combo'));
  assert.equal(lista().problemaDelMotivo('arreglo del combo'), null);
});

test('T30 Motivo_VariosTemas_NoPorDelegacion — @story-8.174 @ac-28', () => {
  const L = lista();
  for (const m of ['/org-site, /wip y /office', 'arreglo a; arreglo b', 'combo + login', 'combo, login, menú', 'combo, y login']) {
    assert.ok(L.sinUnaPersona({ reason: m }), m);
  }
  assert.equal(L.sinUnaPersona({ reason: 'arreglo del combo y su prueba' }), null);
  const raiz = tmp('t30-');
  const dir = repo(raiz, 'producto');
  const h = tmp('home-');
  const del = marker(h, 's30', ['adhoc', 'set', pedido({ reason: 'combo, login y menú', allowedFiles: ['src/a.js'] })], { cwd: dir, delegadaPor: 'coord' });
  assert.notEqual(del.status, 0);
  assert.match(del.stderr, /varios temas/);
  assert.ok(!fs.existsSync(path.join(estado(h), 'adhoc', 's30.json')));
  // «hecho y avisado»: la pestaña sin permisos no lo abre sola
  const ow = require(path.join(RAIZ, 'scripts', 'lib', 'owner-window.js'));
  const palabras = ['marker.js', 'adhoc', 'set', pedido({ reason: 'combo, login y menú', allowedFiles: ['src/a.js'] })];
  assert.ok(ow.pasaDelCupoDelegado(palabras, 5));
  const per = marker(tmp('home-'), 's30b', ['adhoc', 'set', pedido({ reason: 'combo, login y menú', allowedFiles: ['src/a.js'] })], { cwd: dir, ventana: true });
  assert.equal(per.status, 0, per.stderr);
});

test('T30b Motivo_ComaYLetra_LaLetraVaSuelta — una «y», «e» u «o» después de una coma cuenta sólo con un espacio antes', () => {
  const L = lista();
  for (const m of ['combo, y login', 'combo, login e índice', 'combo, menú o login', 'combo, login y']) assert.ok(L.variosTemas(m), m);
  // pegada a la coma o adentro de otra palabra no es una enumeración
  for (const m of ['combo,y login', 'combo, ya hecho', 'arreglo del combo y su prueba', 'combo, login']) assert.ok(!L.variosTemas(m), m);
});

test('T31 Motivo_Vago_NoPorDelegacion — @story-8.174 @ac-29', () => {
  const L = lista();
  for (const m of ['ARREGLOS varios', 'pendiente del combo', 'cosas del login', 'combo etc.', 'otros del combo']) assert.ok(L.sinUnaPersona({ reason: m }), m);
  const raiz = tmp('t31-');
  const dir = repo(raiz, 'producto');
  const del = marker(tmp('home-'), 's31', ['adhoc', 'set', pedido({ reason: 'ARREGLOS varios del combo', allowedFiles: ['src/a.js'] })], { cwd: dir, delegadaPor: 'coord' });
  assert.notEqual(del.status, 0);
  assert.match(del.stderr, /vago/);
  const per = marker(tmp('home-'), 's31b', ['adhoc', 'set', pedido({ reason: 'ARREGLOS varios del combo', allowedFiles: ['src/a.js'] })], { cwd: dir, ventana: true });
  assert.equal(per.status, 0, per.stderr);
});

// ── el portón al editar ─────────────────────────────────────────────────────────────────────────

test('T32 Lista_FueraFrena_DentroPasa — @story-8.174 @ac-30', () => {
  const raiz = tmp('t32-');
  for (const nombre of ['tycon-harness', 'sin-tycon']) {
    const dir = repo(raiz, nombre);
    if (nombre === 'sin-tycon') { fs.rmSync(path.join(dir, '.tycon'), { recursive: true, force: true }); }
    const h = tmp('home-');
    const state = conCarril(h, 's32', { allowedFiles: [path.join(dir, 'src/a.js')] });
    for (const rel of ['docs/x.md', 'config.json', 'src/b.js']) {
      const r = ev(state, 's32', path.join(dir, rel), dir);
      assert.equal(r.verdict.action, 'block', `${nombre} ${rel}`);
      assert.equal(r.verdict.kind, 'adhoc-out-of-list', `${nombre} ${rel}`);
      assert.match(r.message, /src\/a\.js/);
      assert.match(r.message, /adhoc set/);
    }
    assert.notEqual(ev(state, 's32', path.join(dir, 'src/a.js'), dir).verdict.kind, 'adhoc-out-of-list');
    for (const command of ["sed -i '' 's/a/b/' docs/x.md", 'echo x | tee docs/x.md', 'echo x > docs/x.md']) {
      escribir(dir, 'docs/x.md');
      const b = porConsola(state, 's32', dir, command);
      assert.ok(b && /FUERA DE LA LISTA/.test(b.block || ''), `${command}: ${JSON.stringify(b)}`);
    }
  }
});

test('T33 Lista_PorLaRutaReal — @story-8.174 @ac-31', () => {
  const raiz = tmp('t33-');
  const dir = repo(raiz, 'producto');
  escribir(dir, 'src/a.js');
  escribir(dir, 'src/secreto.js');
  const h = tmp('home-');
  const state = conCarril(h, 's33', { allowedFiles: [path.join(dir, 'src/a.js')] });
  fs.symlinkSync(path.join(dir, 'src/secreto.js'), path.join(dir, 'src/enlace.js'));
  for (const f of [path.join(dir, 'src/../src/b.js'), path.join(dir, 'src/enlace.js'), path.join(dir, 'src/nuevo.js')]) {
    assert.equal(ev(state, 's33', f, dir).verdict.kind, 'adhoc-out-of-list', f);
  }
  // movido afuera por la consola (la puerta no lo ve): frena al guardar
  escribir(dir, 'src/a.js', 'cambio\n');
  git(dir, 'add', '.');
  commitear(dir, 'a');
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  git(dir, 'mv', 'src/a.js', 'lib/a.js');
  const g = guardar(dir, 's33', h);
  assert.ok(g && g.texto && /lib\/a\.js/.test(g.texto), JSON.stringify(g));
});

test('T34 Lista_PruebaDelArchivoPasa — @story-8.174 @ac-32', () => {
  const raiz = tmp('t34-');
  const dir = repo(raiz, 'producto');
  const otro = repo(raiz, 'otro');
  const h = tmp('home-');
  const state = conCarril(h, 's34', { allowedFiles: [path.join(dir, 'src/x.js')] });
  assert.notEqual(ev(state, 's34', path.join(dir, 'tests/x.test.js'), dir).verdict.kind, 'adhoc-out-of-list');
  assert.notEqual(ev(state, 's34', path.join(dir, 'src/__tests__/x.spec.js'), dir).verdict.kind, 'adhoc-out-of-list');
  assert.equal(ev(state, 's34', path.join(otro, 'tests/x.test.js'), otro).verdict.kind, 'adhoc-out-of-list');
  assert.equal(ev(state, 's34', path.join(dir, 'src/x.test.helper.js'), dir).verdict.kind, 'adhoc-out-of-list');
  assert.equal(ev(state, 's34', path.join(dir, 'tests/y.test.js'), dir).verdict.kind, 'adhoc-out-of-list');
});

test('T35 Lista_Ampliar_ContieneLaAnterior — @story-8.174 @ac-33', () => {
  const raiz = tmp('t35-');
  const dir = repo(raiz, 'producto');
  const h = tmp('home-');
  assert.equal(marker(h, 's35', ['adhoc', 'set', pedido({ allowedFiles: ['src/a.js'] })], { cwd: dir, ventana: true }).status, 0);
  // más larga, sin firma: vuelve a pedir el sí
  const sin = marker(h, 's35', ['adhoc', 'set', pedido({ allowedFiles: ['src/a.js', 'src/b.js'] })], { cwd: dir });
  assert.notEqual(sin.status, 0);
  // por delegación, una lista nueva sin una entrada firmada se niega
  const sinA = marker(h, 's35', ['adhoc', 'set', pedido({ allowedFiles: ['src/b.js'] })], { cwd: dir, delegadaPor: 'coord' });
  assert.notEqual(sinA.status, 0);
  assert.match(sinA.stderr, /src\/a\.js/);
  // la que contiene la firmada no se niega por la lista: llega al aviso a la persona (sin canal en la prueba, ahí frena)
  const con = marker(h, 's35', ['adhoc', 'set', pedido({ allowedFiles: ['src/a.js', 'src/b.js'] })], { cwd: dir, delegadaPor: 'coord' });
  assert.doesNotMatch(con.stderr, /saca .*ya estaba firmada/);
  assert.match(con.stderr, /sin aviso a la persona/);
});

test('T36 Lista_FueraDeRepoHomeEvidencia — @story-8.174 @ac-34', () => {
  const raiz = tmp('t36-');
  const dir = repo(raiz, 'producto');
  const h = tmp('home-');
  const lista1 = [path.join(dir, 'src/a.js')];
  const state = conCarril(h, 'per', { allowedFiles: lista1 });
  conCarril(h, 'del', { allowedFiles: lista1, via: 'delegacion' });
  const fuera = tmp('suelta-');
  // fuera de un repo, en una carpeta que no es temporal ni la personal: frena
  const suelta = '/opt/tycon-no-existe/x.js';
  assert.notEqual(lista().fueraDeLaLista({ lista: lista1, filePath: suelta, real: suelta, repoRoot: null, home: h, delegado: false }), null);
  // la carpeta temporal pasa
  assert.notEqual(ev(state, 'per', path.join(fuera, 'sonda.js'), fuera).verdict.kind, 'adhoc-out-of-list');
  // la evidencia y los trozos de memoria pasan sin nombrarlos; el resto de .advisors/ y .engram/ no
  for (const rel of ['.advisors/x.json', '.advisors/r/y.jsonl', '.advisors/z.md', '.engram/chunks/a.jsonl.gz', '.engram/manifest.json']) {
    assert.notEqual(ev(state, 'per', path.join(dir, rel), dir).verdict.kind, 'adhoc-out-of-list', rel);
  }
  for (const rel of ['.advisors/x.js', '.engram/config.json']) {
    assert.equal(ev(state, 'per', path.join(dir, rel), dir).verdict.kind, 'adhoc-out-of-list', rel);
  }
  // la carpeta personal: al delegado lo frena, al de una persona no
  assert.equal(lista().fueraDeLaLista({ lista: lista1, filePath: path.join(h, '.zshrc'), real: path.join(h, '.zshrc'), repoRoot: null, home: h, delegado: true }) !== null, true);
  assert.equal(lista().fueraDeLaLista({ lista: lista1, filePath: path.join(h, '.zshrc'), real: path.join(h, '.zshrc'), repoRoot: null, home: h, delegado: false }), null);
});

test('T37 Delegado_UnoPorRepo — @story-8.174 @ac-35', () => {
  const raiz = tmp('t37-');
  const dir = repo(raiz, 'producto');
  const otro = repo(raiz, 'otro');
  const h = tmp('home-');
  conCarril(h, 'ya', { allowedFiles: [path.join(dir, 'src/a.js')], via: 'delegacion' });
  const r = marker(h, 'nuevo', ['adhoc', 'set', pedido({ allowedFiles: ['src/b.js'] })], { cwd: dir, delegadaPor: 'coord' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ya\b/);
  // otro repo, o la ampliación del propio: no se niega por el repo (llega al aviso, que en la prueba no tiene canal)
  for (const [sid, cwd, lista2] of [['n2', otro, ['src/b.js']], ['ya', dir, ['src/a.js', 'src/c.js']]]) {
    const d = marker(h, sid, ['adhoc', 'set', pedido({ allowedFiles: lista2 })], { cwd, delegadaPor: 'coord' });
    assert.doesNotMatch(d.stderr, /ya tiene un camino corto delegado/, sid);
    assert.match(d.stderr, /sin aviso a la persona/, sid);
  }
  // el carril de una persona sobre el mismo repo: pasa
  assert.equal(marker(h, 'n3', ['adhoc', 'set', pedido({ allowedFiles: ['src/b.js'] })], { cwd: dir, ventana: true }).status, 0);
});

// ── lo que encontró el pase adversarial de la 8.245 ─────────────────────────────────────────────

// 🔴 Falla con: otra sesión abierta «hecho y avisado» no cuenta como delegada para el «uno por repo» (clase 10).
test('P10 Delegado_UnoPorRepo_TambienConAvisado — @story-8.174 @ac-35', () => {
  const raiz = tmp('p10-');
  const dir = repo(raiz, 'producto');
  const h = tmp('home-');
  conCarril(h, 'ya', { allowedFiles: [path.join(dir, 'src/a.js')], via: 'avisado' });
  const r = marker(h, 'nuevo', ['adhoc', 'set', pedido({ allowedFiles: ['src/b.js'] })], { cwd: dir, delegadaPor: 'coord' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ya\b/);
  assert.doesNotMatch(r.stderr, /sin aviso a la persona/, 'se niega antes del aviso');
});

// 🔴 Falla con: el mensaje de «fuera de la lista» en un repo de producto, que nombraba la delegación (la prueba en vivo
// del AC 52, 9/11): el portón le pasaba siempre el perfil del arnés.
test('P2v52 FueraDeLaLista_EnUnProducto_HablaDeVos — @story-8.174 @ac-52', () => {
  const raiz = tmp('p2v52-');
  const dir = repo(raiz, 'producto');
  const h = tmp('home-');
  const state = conCarril(h, 's52', { allowedFiles: [path.join(dir, 'src/a.js')] });
  const r = ev(state, 's52', path.join(dir, 'src/otro.js'), dir);
  assert.strictEqual(r.verdict.kind, 'adhoc-out-of-list');
  assert.match(r.message, /lo aprobás vos con tu sí/);
  assert.doesNotMatch(r.message, /delegación|coordinadora|dueño/);
});

// 🔴 Falla con: una carpeta de carriles que no se lee, que salteaba el «uno por repo» como si no hubiera otros
// (revisor de fallos silenciosos, vuelta 3).
test('P10b Delegado_CarrilesQueNoSeLeen_NoAbre — @story-8.174 @ac-35', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const raiz = tmp('p10b-');
  const dir = repo(raiz, 'producto');
  const h = tmp('home-');
  conCarril(h, 'ya', { allowedFiles: [path.join(dir, 'src/a.js')], via: 'delegacion' });
  const carpeta = path.join(estado(h), 'adhoc');
  fs.chmodSync(carpeta, 0o333);
  try {
    const r = marker(h, 'nuevo', ['adhoc', 'set', pedido({ allowedFiles: ['src/b.js'] })], { cwd: dir, delegadaPor: 'coord' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no pude leer los otros caminos cortos/);
  } finally { fs.chmodSync(carpeta, 0o755); }
});

// 🔴 Falla con: corchetes rechazados como comodín (clase 12), un espacio al final que saca un archivo del tope (clase 6),
// la evidencia del pase que frena el carril (clase 11), o un enlace de la lista que no se edita por su nombre (clase 15).
test('P11 Lista_RutasDinamicas_Espacios_Evidencia_Enlaces — @story-8.174 @ac-25 @ac-26 @ac-34', () => {
  const L = lista();
  const raiz = tmp('p11-');
  const dir = repo(raiz, 'producto');
  escribir(dir, 'app/[id]/page.tsx');
  const r = L.normalizar(['app/[id]/page.tsx', 'app/{grupo}/x.ts'], { cwd: dir });
  assert.ok(r.lista && r.lista.length === 2, JSON.stringify(r));
  assert.ok(L.normalizar(['src/*.js'], { cwd: dir }).problema, 'el asterisco sigue siendo comodín');
  assert.strictEqual(L.esCodigoRel('src/a.js '), true, 'con un espacio al final, cuenta igual');
  assert.strictEqual(L.esCodigoRel('src/a.js\t'), true);
  const firmas = require(path.join(SCRIPTS, '..', '..', '..', 'scripts', 'lib', 'signatures.js'));
  const nueve = Array.from({ length: 9 }, (_, k) => `src/f${k}.js `);
  assert.strictEqual(firmas.firmaDelPedidoAdhoc([JSON.stringify({ reason: 'x', allowedFiles: nueve })]), firmas.SOBRE_CUPO, 'nueve con espacio pasan el tope');
  for (const ev2 of ['.advisors/pipeline-runs/x-1/step-05b-probes/caza-a/COMO-SE-CORRIO.txt', '.advisors/pipeline-runs/x-1/step-05b-probes/a-1/probe.js.txt']) {
    assert.strictEqual(L.esPapeleo(ev2), true, ev2);
    assert.strictEqual(L.fueraDeLaLista({ lista: [path.join(dir, 'src/a.js')], filePath: path.join(dir, ev2), repoRoot: dir }), null, ev2);
  }
  assert.strictEqual(L.esPapeleo('.advisors/x.js'), false, 'el código en .advisors/ no es papeleo');
  escribir(dir, 'AGENTS.md');
  fs.symlinkSync('AGENTS.md', path.join(dir, 'CLAUDE.md'));
  const conEnlace = L.normalizar(['CLAUDE.md'], { cwd: dir });
  assert.ok(conEnlace.lista.includes(path.join(dir, 'CLAUDE.md')), JSON.stringify(conEnlace));
  assert.strictEqual(L.fueraDeLaLista({ lista: conEnlace.lista, filePath: path.join(dir, 'CLAUDE.md'), real: path.join(dir, 'AGENTS.md'), repoRoot: dir }), null);
});

// 🔴 Falla con: un renombre que saca de la lista (o de lo sensible) la ruta vieja al guardar (clase 1).
test('P1 Guardar_RenombreCuentaLasDosRutas — @story-8.174 @ac-36 @ac-47', () => {
  const raiz = tmp('p1-');
  const arnes = repo(raiz, 'tycon-harness');
  const h = tmp('home-');
  escribir(arnes, 'scripts/lib/signatures.js', '// x\n');
  escribir(arnes, 'scripts/lib/otro.js', '// y\n');
  git(arnes, 'add', '.');
  commitear(arnes, 'base con los dos');
  git(arnes, 'push', '-q', 'origin', 'main');
  git(arnes, 'mv', 'scripts/lib/signatures.js', 'scripts/lib/nuevo.js');
  const nuevo = path.join(arnes, 'scripts/lib/nuevo.js');
  conCarril(h, 'del', { via: 'delegacion', allowedFiles: [nuevo], files: [nuevo] });
  const g = guardar(arnes, 'del', h);
  assert.ok(g && g.texto && /signatures\.js/.test(g.texto), JSON.stringify(g));
  conCarril(h, 'per', { allowedFiles: [nuevo], files: [nuevo] });
  const p = guardar(arnes, 'per', h);
  assert.ok(p && p.texto && /signatures\.js/.test(p.texto), `la ruta vieja está fuera de la lista: ${JSON.stringify(p)}`);
});

// ── al guardar ──────────────────────────────────────────────────────────────────────────────────

test('T38 Guardar_FueraDeLaLista_Frena — @story-8.174 @ac-36', () => {
  const raiz = tmp('t38-');
  const dir = repo(raiz, 'producto');
  const h = tmp('home-');
  const a = escribir(dir, 'src/a.js');
  conCarril(h, 's38', { allowedFiles: [a], files: [a], bases: { [dir]: { sha: git(dir, 'rev-parse', 'HEAD') } } });
  escribir(dir, 'src/otro.js');
  git(dir, 'add', '.');
  for (const command of ['git commit -m x', 'git push origin HEAD', 'gh pr create --fill']) {
    const g = guardar(dir, 's38', h, command);
    assert.ok(g && g.texto && /src\/otro\.js/.test(g.texto) && /lista/.test(g.texto), `${command}: ${JSON.stringify(g)}`);
  }
  // lo exento y la prueba del archivo no frenan
  git(dir, 'reset', '-q');
  fs.rmSync(path.join(dir, 'src/otro.js'));
  escribir(dir, 'tests/a.test.js');
  escribir(dir, '.advisors/e.json', '{}');
  git(dir, 'add', '.');
  const g = guardar(dir, 's38', h);
  assert.ok(!g || !g.texto || !/fuera de la lista/i.test(g.texto), JSON.stringify(g));
});

// ── lo que encontró la segunda vuelta del pase adversarial de la 8.245 ───────────────────────────

// 🔴 Falla con: un borrador suelto que git no sigue frenaba un commit que no lo suma y un push, que no lo sube (clase 10).
test('P2v10 Guardar_BorradorSueltoNoFrena — @story-8.174 @ac-36', () => {
  const raiz = tmp('p2v10-');
  const dir = repo(raiz, 'producto');
  const h = tmp('home-');
  const a = escribir(dir, 'docs/a.md');
  conCarril(h, 'sb', { allowedFiles: [a], files: [a], bases: { [dir]: { sha: git(dir, 'rev-parse', 'HEAD') } } });
  git(dir, 'add', 'docs/a.md');
  escribir(dir, 'notas-borrador.txt');
  const c = guardar(dir, 'sb', h, 'git commit -m x -- docs/a.md');
  assert.ok(!c || !c.texto || !/notas-borrador/.test(c.texto), JSON.stringify(c));
  commitear(dir);
  const p = guardar(dir, 'sb', h, 'git push origin HEAD');
  assert.ok(!p || !p.texto || !/notas-borrador/.test(p.texto), JSON.stringify(p));
  // un comando que sube lo que no sigue (suma y empuja en uno) lo sigue contando
  const ap = guardar(dir, 'sb', h, 'git add -A && git commit -m y && git push origin HEAD');
  assert.ok(ap && ap.texto && /notas-borrador/.test(ap.texto), JSON.stringify(ap));
});

// 🔴 Falla con: la prueba de .NET (FooTests.cs) o la de Jest en __tests__/ con el mismo nombre, frenadas como fuera de la
// lista (clase 13).
test('P2v13 Lista_PruebaDeDotnetYJest — @story-8.174 @ac-32', () => {
  const raiz = tmp('p2v13-');
  const dir = repo(raiz, 'producto');
  const h = tmp('home-');
  const state = conCarril(h, 'sn', { allowedFiles: [path.join(dir, 'src/Foo.cs'), path.join(dir, 'src/bar.js')] });
  for (const rel of ['tests/FooTests.cs', 'tests/Foo.Tests/FooTests.cs', 'tests/FooTest.cs', 'src/__tests__/bar.js']) {
    assert.notEqual(ev(state, 'sn', path.join(dir, rel), dir).verdict.kind, 'adhoc-out-of-list', rel);
  }
  // otro nombre, o el mismo nombre fuera de __tests__/, sigue fuera
  for (const rel of ['tests/OtroTests.cs', 'src/bar2.js', 'lib/bar.js']) {
    assert.equal(ev(state, 'sn', path.join(dir, rel), dir).verdict.kind, 'adhoc-out-of-list', rel);
  }
});

// 🔴 Falla con: la lista pedida desde una carpeta que no es la del repo, que abría el carril sin aviso con archivos que
// nadie edita, y cada edición real frenaba (clase 15); el comando de la terminal lleva la carpeta.
test('P2v15 Lista_FueraDeTodoRepo_Avisa — @story-8.174 @ac-25', () => {
  const L = lista();
  const suelta = tmp('suelta-');
  assert.deepStrictEqual(L.normalizar(['src/a.js'], { cwd: suelta }).sinRepo, [path.join(suelta, 'src/a.js')]);
  const raiz = tmp('p2v15-');
  const dir = repo(raiz, 'producto');
  assert.deepStrictEqual(L.normalizar(['src/a.js'], { cwd: dir }).sinRepo, [], 'desde el repo, sin aviso');
  assert.deepStrictEqual(L.normalizar(['producto/src/a.js'], { cwd: raiz }).sinRepo, [], 'desde arriba del repo, nombrándolo');
  const h = tmp('home-');
  const avisa = marker(h, 's15a', ['adhoc', 'set', pedido({ allowedFiles: ['src/a.js'] })], { cwd: suelta });
  assert.match(avisa.stderr, /no caen dentro de ningún repo/);
  const sin = marker(h, 's15', ['adhoc', 'set', pedido({ allowedFiles: ['src/a.js'] })], { cwd: dir });
  assert.notEqual(sin.status, 0);
  assert.doesNotMatch(sin.stderr, /no caen dentro de ningún repo/);
  assert.match(sin.stderr, /cd '.*producto' && node /);
});

test('T49 Sensible_ElPortonDeCarril — @story-8.174 @ac-46', () => {
  const firmas = require(path.join(RAIZ, 'scripts', 'lib', 'signatures.js'));
  const sens = firmas.SENSITIVE.join('\n');
  assert.match(sens, /story-gate\.js/);
  assert.match(sens, /story-gate-io\.js/);
  const raiz = tmp('t49-');
  const arnes = repo(raiz, 'tycon-harness');
  const h = tmp('home-');
  const state = conCarril(h, 'del', { via: 'delegacion' });
  for (const rel of ['skills/tycon-pipeline/scripts/lib/story-gate.js', 'skills/tycon-pipeline/scripts/lib/story-gate-io.js']) {
    assert.equal(ev(state, 'del', path.join(arnes, rel), arnes).verdict.kind, 'adhoc-sensitive', rel);
  }
});

test('T50 Guardar_DelegadoConSensible_Frena — @story-8.174 @ac-47', () => {
  const raiz = tmp('t50-');
  const arnes = repo(raiz, 'tycon-harness');
  const h = tmp('home-');
  const f = escribir(arnes, 'scripts/lib/signatures.js', '// x\n');
  conCarril(h, 'del', { via: 'delegacion', allowedFiles: [f], files: [f] });
  git(arnes, 'add', '.');
  const g = guardar(arnes, 'del', h);
  assert.ok(g && g.texto && /sensible/.test(g.texto) && /signatures\.js/.test(g.texto), JSON.stringify(g));
  // el de una persona, con el mismo archivo en la lista, no frena por lo sensible
  conCarril(h, 'per', { allowedFiles: [f], files: [f] });
  const p = guardar(arnes, 'per', h);
  assert.ok(!p || !p.texto || !/sensible/.test(p.texto), JSON.stringify(p));
});

test('T51 Guardar_EntradaQueSale_Frena — @story-8.174 @ac-48', () => {
  const raiz = tmp('t51-');
  const dir = repo(raiz, 'producto');
  const h = tmp('home-');
  const a = escribir(dir, 'src/a.js');
  const b = escribir(dir, 'src/b.js');
  git(dir, 'add', '.');
  // la persona sacó src/b.js de la lista y b tenía cambios
  conCarril(h, 's51', { allowedFiles: [a], files: [a, b] });
  const g = guardar(dir, 's51', h);
  assert.ok(g && g.texto && /src\/b\.js/.test(g.texto), JSON.stringify(g));
});

test('T52 CarrilViejoSinLista_ComoHoyHastaElSet — @story-8.174 @ac-49', () => {
  const raiz = tmp('t52-');
  const dir = repo(raiz, 'producto');
  const h = tmp('home-');
  const state = conCarril(h, 'viejo');
  // sin lista: no frena por la lista
  assert.notEqual(ev(state, 'viejo', path.join(dir, 'src/a.js'), dir).verdict.kind, 'adhoc-out-of-list');
  // su próximo set sin lista se niega
  const r = marker(h, 'viejo', ['adhoc', 'set', pedido({})], { cwd: dir, ventana: true });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /lista/);
  // con el portón apagado por la configuración del repo: el delegado frena igual por la lista; el de una persona no
  escribir(dir, '.tycon/advisors.yaml', 'pipeline:\n  story_gate: false\n');
  git(dir, 'add', '.');
  commitear(dir, 'portón apagado');
  conCarril(h, 'del', { via: 'delegacion', allowedFiles: [path.join(dir, 'src/a.js')] });
  conCarril(h, 'per', { allowedFiles: [path.join(dir, 'src/a.js')] });
  assert.equal(ev(state, 'del', path.join(dir, 'docs/x.md'), dir).verdict.kind, 'adhoc-out-of-list');
  assert.notEqual(ev(state, 'per', path.join(dir, 'docs/x.md'), dir).verdict.kind, 'adhoc-out-of-list');
});

// ── el carril trae la base al abrir ─────────────────────────────────────────────────────────────

test('T57 AdhocSet_TraeLaBaseAlAbrir — @story-8.174 @ac-54', () => {
  const raiz = tmp('t57-');
  const dir = repo(raiz, 'producto');
  const h = tmp('home-');
  // un carril nuevo anota la base de cada repo de su lista: la punta de `main` del origen
  const r = marker(h, 's57', ['adhoc', 'set', pedido({ allowedFiles: ['src/a.js'] })], { cwd: dir, ventana: true });
  assert.equal(r.status, 0, r.stderr);
  const base = leerCarril(h, 's57').bases[dir];
  assert.ok(base && base.traida === true, JSON.stringify(leerCarril(h, 's57').bases));
  assert.equal(base.sha, git(dir, 'rev-parse', 'origin/main'));
  // agrandarlo no cambia una base ya anotada, aunque `main` haya avanzado
  const otro = path.join(raiz, 'otro-clon');
  execFileSync('git', ['clone', '-q', path.join(raiz, 'producto-origen.git'), otro]);
  fs.writeFileSync(path.join(otro, 'b.md'), 'y\n');
  git(otro, 'add', '.');
  commitear(otro, 'avanza main');
  git(otro, 'push', '-q', 'origin', 'HEAD:main');
  const r2 = marker(h, 's57', ['adhoc', 'set', pedido({ allowedFiles: ['src/a.js', 'src/b.js'] })], { cwd: dir, ventana: true });
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepStrictEqual(leerCarril(h, 's57').bases[dir], base);
  // sin red (un origen que no contesta): abre igual, con la base «sin traer», y avisa
  const sinRed = repo(raiz, 'sin-red');
  git(sinRed, 'remote', 'set-url', 'origin', path.join(raiz, 'no-existe.git'));
  const h2 = tmp('home-');
  const r3 = marker(h2, 's57b', ['adhoc', 'set', pedido({ allowedFiles: ['src/a.js'] })], { cwd: sinRed, ventana: true });
  assert.equal(r3.status, 0, r3.stderr);
  assert.equal(leerCarril(h2, 's57b').bases[sinRed].traida, false);
  assert.match(r3.stderr, /sin traer/);
});
