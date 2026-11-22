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
function marker(h, sid, args, { cwd, ventana, delegadaPor, via } = {}) {
  const env = { ...process.env, HOME: h, USERPROFILE: h, CLAUDE_CODE_SESSION_ID: sid };
  delete env.NODE_OPTIONS;
  const e = ventana || delegadaPor || via ? conVentana(env, delegadaPor ? { delegadaPor } : via ? { via } : {}) : env;
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

// El arnés se reconoce por su origen (scripts/lib/harness-repo.js): un repo con el origen de este clon es el arnés, y
// ahí el rechazo fuera de la lista conserva la delegación; en un producto habla de vos (P2v52)
test('T32b FueraDeLaLista_EnElArnes_ConservaLaDelegacion — @story-8.174 @ac-52', (t) => {
  let origen = null;
  try { origen = git(RAIZ, 'remote', 'get-url', 'origin'); } catch (_) { origen = null; }
  if (!origen) { t.skip('este clon no tiene origen: no hay con qué reconocer el arnés'); return; }
  const raiz = tmp('t32b-');
  const dir = repo(raiz, 'copia-del-arnes');
  git(dir, 'remote', 'set-url', 'origin', origen);
  const h = tmp('home-');
  const state = conCarril(h, 's32b', { allowedFiles: [path.join(dir, 'src/a.js')] });
  const r = ev(state, 's32b', path.join(dir, 'docs/x.md'), dir);
  assert.strictEqual(r.verdict.kind, 'adhoc-out-of-list');
  assert.match(r.message, /por delegación, la lista nueva contiene entera la firmada/, r.message);
  assert.doesNotMatch(r.message, /lo aprueba el dev, como al abrir/);
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
// El texto lo lee el agente: dice que aprueba el dev y qué hace el agente con su sí (no «lo aprobás vos»).
test('P2v52 FueraDeLaLista_EnUnProducto_ApruebaElDev — @story-8.174 @ac-52', () => {
  const raiz = tmp('p2v52-');
  const dir = repo(raiz, 'producto');
  const h = tmp('home-');
  const state = conCarril(h, 's52', { allowedFiles: [path.join(dir, 'src/a.js')] });
  const r = ev(state, 's52', path.join(dir, 'src/otro.js'), dir);
  assert.strictEqual(r.verdict.kind, 'adhoc-out-of-list');
  assert.match(r.message, /lo aprueba el dev, como al abrir\. Preguntale; con su sí, corré este comando solo/);
  assert.doesNotMatch(r.message, /delegación|coordinadora|dueño|lo aprobás vos/);
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
  // la carpeta va en --repo, sin `cd … &&` (8.319, AC 8)
  assert.match(sin.stderr, /adhoc set .* --terminal --for-session \S+ --repo ".*producto"/);
  assert.doesNotMatch(sin.stderr, /&& node /);
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

// ── el papeleo del camino corto (8.272) ─────────────────────────────────────────────────────────────────────────────
//
// La constancia del cambio de un control de la lista y el renglón de suites.json de una prueba nueva de la lista no piden
// ampliarla. Todo lo demás, sí: la constancia que nombra otra ruta, el renglón de otra prueba, un renglón viejo tocado.

const SUITES = 'scripts/tests/suites.json';
const SUITES_BASE = { __doc: 'la lista', diarias: [{ raiz: 'arnes', ruta: 'tests/viejo.test.js', requiere: [] }], semanales: [], __raices: { arnes: 'scripts' } };
/** Un repo con suites.json commiteado y la lista de un carril: un control, su prueba nueva y una prueba de las skills. */
function conPapeleo(nombre) {
  const raiz = tmp(`${nombre}-`);
  const dir = repo(raiz, 'arnes');
  escribir(dir, SUITES, `${JSON.stringify(SUITES_BASE, null, 2)}\n`);
  git(dir, 'add', '.');
  commitear(dir, 'suites');
  const listaDelCarril = ['scripts/ci/control.js', 'scripts/tests/nuevo.test.js', 'skills/tycon-pipeline/scripts/tests/otro.test.js'].map((r) => path.join(dir, r));
  const fuera = (rel) => lista().fueraDeLaLista({ lista: listaDelCarril, filePath: path.join(dir, rel), real: path.join(dir, rel), repoRoot: dir });
  const suites = (cambiar) => { const s = JSON.parse(JSON.stringify(SUITES_BASE)); cambiar(s); escribir(dir, SUITES, `${JSON.stringify(s, null, 2)}\n`); };
  return { dir, listaDelCarril, fuera, suites };
}

test('T18 AdhocList_ControlChangeAndSuiteLine_NoWiden @story-8.272 @ac-21', () => {
  const p = conPapeleo('t18');
  // sin cambios todavía (antes de la edición): no pide ampliar
  assert.strictEqual(p.fuera(SUITES), null);
  // el renglón de las pruebas nuevas de la lista, de las dos raíces
  p.suites((s) => { s.diarias.push({ raiz: 'arnes', ruta: 'tests/nuevo.test.js', requiere: [] }); s.semanales.push({ raiz: 'agent-skills', ruta: 'tycon-pipeline/scripts/tests/otro.test.js', requiere: [] }); });
  assert.strictEqual(p.fuera(SUITES), null);
  // la constancia del cambio del control de la lista
  const constancia = '.github/control-changes/abc123.json';
  escribir(p.dir, constancia, JSON.stringify({ hash: 'abc123', rules: [{ path: 'scripts/ci/control.js', blob: 'f00' }], at: '2026-11-14', by: 'dueño' }));
  assert.strictEqual(p.fuera(constancia), null);
  // también por el portón de carril, como una edición de la herramienta
  const h = tmp('home-');
  const state = conCarril(h, 's18', { allowedFiles: p.listaDelCarril });
  assert.notEqual(ev(state, 's18', path.join(p.dir, SUITES), p.dir).verdict.kind, 'adhoc-out-of-list');
});

test('T19 AdhocList_OtherFile_StillWidens @story-8.272 @ac-22', () => {
  const p = conPapeleo('t19');
  // el renglón de una prueba que no está en la lista
  p.suites((s) => s.diarias.push({ raiz: 'arnes', ruta: 'tests/ajena.test.js', requiere: [] }));
  assert.notStrictEqual(p.fuera(SUITES), null);
  // un renglón viejo tocado o sacado, aunque sume uno de la lista
  p.suites((s) => { s.diarias = [{ raiz: 'arnes', ruta: 'tests/nuevo.test.js', requiere: [] }]; });
  assert.notStrictEqual(p.fuera(SUITES), null);
  p.suites((s) => { s.__doc = 'otra cosa'; s.diarias.push({ raiz: 'arnes', ruta: 'tests/nuevo.test.js', requiere: [] }); });
  assert.notStrictEqual(p.fuera(SUITES), null);
  // ilegible
  escribir(p.dir, SUITES, '{ no es json');
  assert.notStrictEqual(p.fuera(SUITES), null);
  // sin versión en el último commit
  const nuevo = repo(tmp('t19b-'), 'arnes');
  escribir(nuevo, SUITES, `${JSON.stringify(SUITES_BASE)}\n`);
  assert.notStrictEqual(lista().fueraDeLaLista({ lista: [path.join(nuevo, 'scripts/tests/viejo.test.js')], filePath: path.join(nuevo, SUITES), repoRoot: nuevo }), null);
  // la constancia que nombra una ruta fuera de la lista, una vacía o una ilegible
  const constancia = '.github/control-changes/def456.json';
  for (const txt of [JSON.stringify({ rules: [{ path: 'scripts/ci/control.js' }, { path: 'scripts/ci/otro.js' }] }), JSON.stringify({ rules: [] }), '{ roto']) {
    escribir(p.dir, constancia, txt);
    assert.notStrictEqual(p.fuera(constancia), null, txt);
  }
  // cualquier otro archivo fuera de la lista, como hoy
  assert.notStrictEqual(p.fuera('README.md'), null);
  assert.notStrictEqual(p.fuera('.github/workflows/ci.yml'), null);
});

// ── los repos hermanos (8.316) ──────────────────────────────────────────────────────────────────────────────────────
//
// Tres repos al lado, cada uno con su remoto local y `origin/HEAD` fijado. El grupo se declara en la rama principal del
// remoto (`subirGrupo`), o sólo en la carpeta o en la rama local para ver que no vale.

const RG = () => require(path.join(SCRIPTS, 'lib', 'repo-group.js'));
const yamlDelGrupo = (nombres, archivo = 'advisors.yaml') => [`.tycon/${archivo}`, `repo_group: [${nombres.join(', ')}]\n`];
/** Commitea el grupo en `dir` y, salvo `local`, lo sube a la rama principal del remoto. */
function subirGrupo(dir, nombres, { local = false, archivo = 'advisors.yaml' } = {}) {
  const [rel, txt] = yamlDelGrupo(nombres, archivo);
  escribir(dir, rel, txt);
  git(dir, 'add', '.');
  commitear(dir, 'grupo');
  if (!local) git(dir, 'push', '-q', 'origin', 'main');
}
/** R, B y F al lado, con remoto y `origin/HEAD`; con `grupo`, se declaran entre los tres en la rama principal del remoto. */
function tresRepos(nombre, { grupo = true } = {}) {
  const raiz = tmp(`${nombre}-`);
  const [R, B, F] = ['R', 'B', 'F'].map((n) => repo(raiz, n));
  for (const d of [R, B, F]) git(d, 'remote', 'set-head', 'origin', 'main');
  if (grupo) {
    subirGrupo(R, ['B', 'F']);
    subirGrupo(B, ['R', 'F']);
    subirGrupo(F, ['R', 'B']);
  }
  return { raiz, R, B, F };
}
const norma = (entradas, cwd) => lista().normalizar(entradas, { cwd });

test('T1 Lista_HermanoDeclarado_SeAcepta — @story-8.316 @ac-1', () => {
  const { R, B, F } = tresRepos('t1-316');
  const h = tmp('home-');
  const r = marker(h, 's1', ['adhoc', 'set', pedido({ allowedFiles: ['B/src/A.cs', 'F/src/x.tsx', 'specs/h.md'] })], { cwd: R, via: 'click' });
  assert.equal(r.status, 0, r.stderr);
  const a = leerCarril(h, 's1');
  assert.deepStrictEqual(a.allowedFiles, [path.join(B, 'src/A.cs'), path.join(F, 'src/x.tsx'), path.join(R, 'specs/h.md')].sort());
  assert.ok(a.allowedFiles[0].startsWith(B + path.sep));
  // la terminal nombra cada archivo con su repo, no con «..»
  assert.match(r.stderr, /B\/src\/A\.cs/);
  assert.doesNotMatch(r.stderr, /\.\.\/B/);
});

test('T2 Grupo_SoloEnCarpetaOEnRamaLocal_SeNiega — @story-8.316 @ac-2', () => {
  // sólo en la carpeta de R
  const c = tresRepos('t2a-316', { grupo: false });
  subirGrupo(c.B, ['R']);
  escribir(c.R, ...yamlDelGrupo(['B']));
  let n = norma(['B/src/A.cs'], c.R);
  assert.match(n.problema || '', /R: no hay \.tycon\/advisors\.yaml en origin\/main/);
  // sólo en la rama local de R (commiteado sin subir)
  const d = tresRepos('t2b-316', { grupo: false });
  subirGrupo(d.B, ['R']);
  subirGrupo(d.R, ['B'], { local: true });
  n = norma(['B/src/A.cs'], d.R);
  assert.match(n.problema || '', /R: no hay \.tycon\/advisors\.yaml en origin\/main/);
  // la vuelta sólo en la rama local de B
  const e = tresRepos('t2c-316', { grupo: false });
  subirGrupo(e.R, ['B']);
  subirGrupo(e.B, ['R'], { local: true });
  n = norma(['B/src/A.cs'], e.R);
  assert.match(n.problema || '', /B: no hay \.tycon\/advisors\.yaml en origin\/main/);
  assert.match(n.problema, /no vale como hermano/);
});

test('T3 Grupo_SinRemotoOSinCommits_SeNiega — @story-8.316 @ac-2', () => {
  // sin origin/HEAD: dice cómo arreglarlo y no lee la carpeta
  const a = tresRepos('t3a-316');
  git(a.R, 'remote', 'set-head', 'origin', '-d');
  let n = norma(['B/src/A.cs'], a.R);
  assert.match(n.problema || '', /refs\/remotes\/origin\/HEAD.*remote set-head origin --auto/);
  // el yaml de la rama principal sin repo_group (el grupo sólo en la carpeta)
  const b = tresRepos('t3b-316', { grupo: false });
  subirGrupo(b.B, ['R']);
  escribir(b.R, '.tycon/advisors.yaml', 'otra: 1\n');
  git(b.R, 'add', '.');
  commitear(b.R, 'sin grupo');
  git(b.R, 'push', '-q', 'origin', 'main');
  escribir(b.R, ...yamlDelGrupo(['B']));
  n = norma(['B/src/A.cs'], b.R);
  assert.match(n.problema || '', /no declara repo_group/);
  // un hermano sin commits, con el grupo en la carpeta
  const c = tresRepos('t3c-316', { grupo: false });
  subirGrupo(c.R, ['V']);
  const V = path.join(c.raiz, 'V');
  execFileSync('git', ['init', '-q', '-b', 'main', V]);
  escribir(V, ...yamlDelGrupo(['R']));
  n = norma(['V/src/A.cs'], c.R);
  assert.match(n.problema || '', /V no tiene commits/);
  // las entradas que no son un nombre suelto: la de «..» y la absoluta
  const d = tresRepos('t3d-316', { grupo: false });
  subirGrupo(d.R, ['../B', path.join(d.raiz, 'F')]);
  subirGrupo(d.B, ['R']);
  subirGrupo(d.F, ['R']);
  n = norma(['B/src/A.cs'], d.R);
  assert.match(n.problema || '', /«\.\.\/B».*va el nombre de la carpeta, solo \(«B»\)/);
  n = norma(['F/src/x.tsx'], d.R);
  assert.match(n.problema || '', /va el nombre de la carpeta, solo \(«F»\)/);
});

test('T4 Grupo_AdvisorsYml_SeLeeIgual — @story-8.316 @ac-2', () => {
  const c = tresRepos('t4-316', { grupo: false });
  subirGrupo(c.R, ['B'], { archivo: 'advisors.yml' });
  subirGrupo(c.B, ['R'], { archivo: 'advisors.yml' });
  const n = norma(['B/src/A.cs'], c.R);
  assert.ok(n.lista, n.problema);
  assert.deepStrictEqual(n.lista, [path.join(c.B, 'src/A.cs')]);
  // y la lista de guiones, como en el aviso
  assert.deepStrictEqual(RG().entradasDe('repo_group:\n  - B\n  - "F"\notra: 1\n'), ['B', 'F']);
});

test('T5 Hermano_NoEsRepoEnlaceOWorktree_SeNiega — @story-8.316 @ac-3', () => {
  const c = tresRepos('t5-316', { grupo: false });
  subirGrupo(c.R, ['N', 'L', 'W', 'R2']);
  // una carpeta que no es repo
  fs.mkdirSync(path.join(c.raiz, 'N', 'src'), { recursive: true });
  assert.match(norma(['N/src/a.cs'], c.R).problema || '', /N no es la raíz de un repo/);
  // un enlace a otra carpeta, fuera del padre
  const lejos = repo(tmp('t5-lejos-'), 'L');
  fs.symlinkSync(lejos, path.join(c.raiz, 'L'));
  assert.match(norma(['L/src/a.cs'], c.R).problema || '', /enlace que lleva fuera/);
  // un worktree enlazado de otro repo (B) y uno del mismo R
  git(c.B, 'worktree', 'add', '-q', '-b', 'w', path.join(c.raiz, 'W'));
  assert.match(norma(['W/src/a.cs'], c.R).problema || '', /W es un worktree/);
  git(c.R, 'worktree', 'add', '-q', '-b', 'r2', path.join(c.raiz, 'R2'));
  assert.match(norma(['R2/src/a.cs'], c.R).problema || '', /R2 es un worktree/);
  // una subcarpeta de un repo: los repos dentro de otro repo, y X sin su propio .git
  const grande = repo(tmp('t5-grande-'), 'G');
  const [R, X] = ['R', 'X'].map((n2) => repo(grande, n2));
  for (const d of [R, X]) git(d, 'remote', 'set-head', 'origin', 'main');
  subirGrupo(R, ['X']);
  fs.rmSync(path.join(X, '.git'), { recursive: true, force: true });
  assert.match(norma(['X/src/a.cs'], R).problema || '', /X no es la raíz de un repo/);
});

test('T6 Hermano_DesdeWorktree_MismosHermanos — @story-8.316 @ac-3', () => {
  const c = tresRepos('t6-316');
  const desdeR = norma(['B/src/A.cs'], c.R).lista;
  assert.ok(desdeR, 'desde R');
  // la sesión en `R--wt-x` y en `R/.claude/worktrees/n`: los mismos hermanos
  const wt1 = path.join(c.raiz, 'R--wt-x');
  git(c.R, 'worktree', 'add', '-q', '-b', 'x', wt1);
  const wt2 = path.join(c.R, '.claude', 'worktrees', 'n');
  git(c.R, 'worktree', 'add', '-q', '-b', 'n', wt2);
  for (const wt of [wt1, wt2]) assert.deepStrictEqual(norma(['B/src/A.cs'], wt).lista, desdeR, wt);
  assert.equal(RG().grupoDelRemoto(wt1).nombre, 'R');
  // B que declara el nombre del worktree en vez de R: no vale
  const d = tresRepos('t6b-316', { grupo: false });
  subirGrupo(d.R, ['B']);
  subirGrupo(d.B, ['R--wt-x']);
  const wt = path.join(d.raiz, 'R--wt-x');
  git(d.R, 'worktree', 'add', '-q', '-b', 'x', wt);
  assert.match(norma(['B/src/A.cs'], wt).problema || '', /B no declara a R/);
});

test('T7 Nombre_RarosSeNiegan_MayusculasYAcentos — @story-8.316 @ac-4', () => {
  for (const n of ['', '.', '..', '.git', '.GIT', '-x', 'a\\b', ' B', 'B ', 'a/b']) assert.ok(RG().problemaDelNombre(n), JSON.stringify(n));
  assert.equal(RG().problemaDelNombre('B'), null);
  // mayúsculas: `b/…` resuelve a B
  const c = tresRepos('t7-316');
  assert.deepStrictEqual(norma(['b/src/A.cs'], c.R).lista, [path.join(c.B, 'src/A.cs')]);
  // un nombre raro en la entrada se niega aunque haya una carpeta así al lado
  fs.mkdirSync(path.join(c.raiz, '-x'));
  assert.match(norma(['-x/a.cs'], c.R).problema || '', /guion/);
  // acentos: un repo `Café` (NFC en el disco) pedido en NFD
  const raiz = tmp('t7b-316-');
  const R = repo(raiz, 'R');
  const cafe = repo(raiz, 'Café');
  for (const d of [R, cafe]) git(d, 'remote', 'set-head', 'origin', 'main');
  subirGrupo(R, ['Café']);
  subirGrupo(cafe, ['R']);
  const n = norma(['Café/src/A.cs'], R);
  assert.ok(n.lista, n.problema);
  assert.ok(n.lista[0].startsWith(fs.realpathSync.native(cafe) + path.sep), n.lista[0]);
});

test('T8 Lista_EnlaceQueSaleDelHermano_SeNiega — @story-8.316 @ac-4', () => {
  const c = tresRepos('t8-316');
  fs.mkdirSync(path.join(c.raiz, 'X'), { recursive: true });
  assert.match(norma(['B/../X/a.cs'], c.R).problema || '', /«\.\.»/);
  fs.mkdirSync(path.join(c.B, 'src'), { recursive: true });
  fs.symlinkSync(path.join(c.raiz, 'X'), path.join(c.B, 'src', 'sale'));
  assert.match(norma(['B/src/sale/a.cs'], c.R).problema || '', /sale de la raíz de B/);
});

test('T9 Lista_Ambigua_YRepoFueraDelGrupo_SeNiegan — @story-8.316 @ac-5', () => {
  const c = tresRepos('t9-316');
  // R con una carpeta `b/`: ¿la de R o el repo B?
  fs.mkdirSync(path.join(c.R, 'b'), { recursive: true });
  assert.match(norma(['B/src/A.cs'], c.R).problema || '', /ambigua/);
  fs.rmSync(path.join(c.R, 'b'), { recursive: true });
  // un repo Z al lado que no está en el grupo
  repo(c.raiz, 'Z');
  assert.match(norma(['Z/src/a.cs'], c.R).problema || '', /Z no está en repo_group de R/);
  // una carpeta propia que no es un hermano pasa como hoy
  assert.deepStrictEqual(norma(['src/a.js'], c.R).lista, [path.join(c.R, 'src/a.js')]);
  // y una carpeta propia con el nombre de un repo de al lado que no es del grupo, también
  fs.mkdirSync(path.join(c.R, 'Z'), { recursive: true });
  assert.deepStrictEqual(norma(['Z/a.md'], c.R).lista, [path.join(c.R, 'Z/a.md')]);
});

// 🔴 Falla con: un enlace de la carpeta propia que lleva a un repo de al lado fuera del grupo y lo mete en la lista, sin
//    que nadie lo frene ahora que varios repos se firman como uno.
test('T9b Lista_EnlaceAUnRepoFueraDelGrupo_SeNiega — @story-8.316 @ac-5', { skip: process.platform === 'win32' }, () => {
  const c = tresRepos('t9b-316');
  const Z = repo(c.raiz, 'Z');
  fs.mkdirSync(path.join(Z, 'src'), { recursive: true });
  fs.writeFileSync(path.join(Z, 'src', 'a.cs'), 'x');
  fs.symlinkSync(Z, path.join(c.R, 'lnk'));
  fs.mkdirSync(path.join(c.R, 'src'), { recursive: true });
  fs.symlinkSync(path.join(Z, 'src', 'a.cs'), path.join(c.R, 'src', 'flink.cs'));
  for (const entradas of [['lnk/src/a.cs'], ['B/src/A.cs', 'lnk/src/a.cs'], ['src/flink.cs']]) {
    assert.match(norma(entradas, c.R).problema || '', /lleva, por un enlace, al repo Z, que no vale como hermano/, entradas.join(', '));
  }
  // por delegación tampoco se abre
  const h = tmp('home-');
  const r = marker(h, 's9b', ['adhoc', 'set', pedido({ allowedFiles: ['B/src/A.cs', 'lnk/src/a.cs'] })], { cwd: c.R, delegadaPor: 'coord' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no vale como hermano/);
  assert.ok(!fs.existsSync(path.join(estado(h), 'adhoc', 's9b.json')));
  // un enlace colgante (su destino todavía no existe) hacia Z también se niega
  fs.symlinkSync(path.join(Z, 'src', 'nuevo.cs'), path.join(c.R, 'src', 'colgante.cs'));
  assert.match(norma(['src/colgante.cs'], c.R).problema || '', /lleva, por un enlace, al repo Z/);
  // un enlace que lleva a un hermano declarado, o dentro del propio repo, pasa
  fs.symlinkSync(c.B, path.join(c.R, 'alB'));
  assert.deepStrictEqual(norma(['alB/src/A.cs'], c.R).lista, [path.join(c.B, 'src', 'A.cs')]);
  fs.symlinkSync(path.join(c.R, 'src'), path.join(c.R, 'propio'));
  assert.ok(!norma(['propio/x.js'], c.R).problema);
});

// 🔴 Falla con: un enlace creado o reapuntado DESPUÉS de abrir el carril, que el portón de edición resuelve en ese
//    momento y deja editar un repo que la lista no nombraba.
test('T9c Porton_EnlacePosteriorAOtroRepo_Frena — @story-8.316 @ac-15', { skip: process.platform === 'win32' }, () => {
  const c = tresRepos('t9c-316');
  const Z = repo(c.raiz, 'Z');
  fs.mkdirSync(path.join(Z, 'src', 'dd'), { recursive: true });
  fs.writeFileSync(path.join(Z, 'src', 'f.js'), 'x');
  fs.writeFileSync(path.join(Z, 'src', 'dd', 'y.js'), 'x');
  fs.mkdirSync(path.join(c.R, 'd'), { recursive: true });
  fs.writeFileSync(path.join(c.R, 'real.js'), 'x');
  fs.symlinkSync(path.join(c.R, 'real.js'), path.join(c.R, 'adentro.js'));
  const n = norma(['link.js', 'd/y.js', 'adentro.js', 'B/src/A.cs'], c.R);
  assert.ok(n.lista, n.problema);
  const fuera = (filePath) => lista().fueraDeLaLista({ lista: n.lista, filePath, real: fs.existsSync(filePath) ? fs.realpathSync(filePath) : filePath, repoRoot: null, delegado: true });
  // un enlace dentro del propio repo, ya en la lista al abrir: se edita por los dos nombres
  assert.equal(fuera(path.join(c.R, 'adentro.js')), null);
  // después de abrir: link.js pasa a ser un enlace a Z, y la carpeta d, un enlace a una carpeta de Z
  fs.symlinkSync(path.join(Z, 'src', 'f.js'), path.join(c.R, 'link.js'));
  fs.rmSync(path.join(c.R, 'd'), { recursive: true });
  fs.symlinkSync(path.join(Z, 'src', 'dd'), path.join(c.R, 'd'));
  for (const f of [path.join(c.R, 'link.js'), path.join(Z, 'src', 'f.js'), path.join(c.R, 'd', 'y.js'), path.join(Z, 'src', 'dd', 'y.js')]) {
    assert.ok(fuera(f), `${f}: el portón dejó editar un repo que la lista no nombraba`);
  }
  // el hermano de la lista se sigue editando
  assert.equal(fuera(path.join(c.B, 'src', 'A.cs')), null);
});

test('T10 ParaOtraSesion_UsaElGrupoDeLaDestino — @story-8.316 @ac-6', () => {
  const c = tresRepos('t10-316');
  // quien pide está en otro producto, sin grupo; la sesión destino trabaja en R
  const otro = tresRepos('t10b-316', { grupo: false });
  const h = tmp('home-');
  const proj = path.join(h, '.claude', 'projects', 'x');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'destino10.jsonl'), `${JSON.stringify({ type: 'user', cwd: c.R })}\n`);
  // la carpeta contra la que resuelven la lista el guion y la ventana: la de la transcripción de la destino
  const carpeta = lista().carpetaDeLaSesion({ casa: h, sesion: 'destino10' });
  assert.equal(carpeta, c.R);
  assert.deepStrictEqual(norma(['B/src/A.cs'], carpeta).lista, [path.join(c.B, 'src/A.cs')]);
  // el guion, pedido desde la otra carpeta: llega a la firma con la lista resuelta (la de la destino), sin rechazarla
  const r = marker(h, 'coord10', ['adhoc', 'set', pedido({ allowedFiles: ['B/src/A.cs'] }), '--for-session', 'destino10'], { cwd: otro.R });
  assert.match(r.stderr, /la lista \(1 archivos\): B\/src\/A\.cs/);
  // desde el repo de quien pide, la misma entrada no vale: allá no hay grupo
  assert.ok(norma(['B/src/A.cs'], otro.R).problema);
});

test('T12 Delegacion_VariosRepos_HermanosDeclarados_SeDelega — @story-8.316 @ac-8', () => {
  const c = tresRepos('t12-316');
  const ow = require(path.join(RAIZ, 'scripts', 'lib', 'owner-window.js'));
  const palabras = (allowedFiles) => ['marker.js', 'adhoc', 'set', pedido({ allowedFiles })];
  // dos hermanos declarados por delegación: no se niegan por ser de varios repos, sin el click de la persona. Llegan al
  // aviso a la persona, que en la prueba no tiene canal: ahí frena, y es lo último que mira
  const h = tmp('home-');
  const r = marker(h, 's12', ['adhoc', 'set', pedido({ allowedFiles: ['B/src/A.cs', 'F/src/x.tsx'] })], { cwd: c.R, delegadaPor: 'coord' });
  assert.match(r.stderr, /sin aviso a la persona/);
  assert.doesNotMatch(r.stderr, /varios repos|no por delegación/);
  // y `pasaDelCupoDelegado`, que mira lo mismo antes del cuadro, tampoco la frena por ser de varios repos
  assert.equal(ow.pasaDelCupoDelegado(palabras(['B/src/A.cs', 'F/src/x.tsx']), 3, c.R), null);
  // una ampliación delegada que suma un hermano: contiene entera la firmada, tampoco se niega por los repos
  const h2 = tmp('home-');
  conCarril(h2, 's12b', { allowedFiles: [path.join(c.R, 'docs/a.md')], via: 'delegacion' });
  const amp = marker(h2, 's12b', ['adhoc', 'set', pedido({ allowedFiles: ['docs/a.md', 'B/src/A.cs'] })], { cwd: c.R, delegadaPor: 'coord' });
  assert.match(amp.stderr, /sin aviso a la persona/);
  assert.doesNotMatch(amp.stderr, /varios repos|no por delegación/);
  // un repo al lado que no es hermano declarado no entra por delegación, ni sumado a un hermano
  repo(c.raiz, 'Z');
  const h4 = tmp('home-');
  const z = marker(h4, 's12z', ['adhoc', 'set', pedido({ allowedFiles: ['B/src/A.cs', 'Z/src/a.cs'] })], { cwd: c.R, delegadaPor: 'coord' });
  assert.notEqual(z.status, 0);
  assert.match(z.stderr, /Z no está en repo_group de R/);
  assert.ok(!fs.existsSync(path.join(estado(h4), 'adhoc', 's12z.json')));
  // sin la carpeta de la sesión destino, una entrada `<Nombre>/…` no se puede resolver: el guion no abre nada
  const h3 = tmp('home-');
  const sinCarpeta = marker(h3, 'coord12', ['adhoc', 'set', pedido({ allowedFiles: ['B/src/A.cs'] }), '--for-session', 'desconocida12'], { cwd: c.R, delegadaPor: 'coord12' });
  assert.equal(sinCarpeta.status, 2, sinCarpeta.stderr);
  assert.match(sinCarpeta.stderr, /no sé la carpeta de la sesión desconocida12/);
  assert.ok(!fs.existsSync(path.join(estado(h3), 'adhoc', 'desconocida12.json')));
  // una lista de un solo repo se delega como siempre
  assert.equal(ow.pasaDelCupoDelegado(palabras(['docs/a.md']), 3, c.R), null);
  assert.equal(ow.pasaDelCupoDelegado(palabras(['B/src/A.cs']), 3, c.R), null);
});

test('T13 Firma_VariosRepos_CualquierViaDeLaPersona — @story-8.316 @ac-8', () => {
  const c = tresRepos('t13-316');
  const lista2 = pedido({ allowedFiles: ['B/src/A.cs', 'F/src/x.tsx'] });
  for (const via of ['click', 'terminal', 'ventana', 'mensaje']) {
    const h = tmp('home-');
    const r = marker(h, `s13${via}`, ['adhoc', 'set', lista2], { cwd: c.R, via });
    assert.equal(r.status, 0, `${via}: ${r.stderr}`);
    assert.ok(fs.existsSync(path.join(estado(h), 'adhoc', `s13${via}.json`)), via);
    assert.doesNotMatch(r.stderr, /sólo el click de la persona o su terminal/, via);
  }
});

/** Corre `comando` en una terminal simulada (pty) y contesta «firmo» cuando la pide; null en Windows. */
function enTerminal(home, comando, respuesta = 'firmo') {
  if (process.platform === 'win32') return null;
  const py = [
    'import os, sys, pty, select',
    'resp = os.environ.pop("RESPUESTA_TTY", "")',
    'pid, fd = pty.fork()',
    'if pid == 0:',
    '    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)',
    'out = b""',
    'enviada = False',
    'while True:',
    '    r, _, _ = select.select([fd], [], [], 20)',
    '    if not r: break',
    '    try: d = os.read(fd, 4096)',
    '    except OSError: break',
    '    if not d: break',
    '    out += d',
    '    if not enviada and "firmo".encode() in out:',
    '        os.write(fd, (resp + "\\n").encode()); enviada = True',
    '_, st = os.waitpid(pid, 0)',
    'sys.stdout.write(out.decode("utf8", "replace"))',
    'sys.exit(os.waitstatus_to_exitcode(st))',
  ].join('\n');
  const env = { ...process.env, HOME: home, USERPROFILE: home, RESPUESTA_TTY: respuesta, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'NODE_OPTIONS', 'CI', 'TF_BUILD', 'GITHUB_ACTIONS']) delete env[k];
  const r = spawnSync('python3', ['-c', py, 'bash', '-c', comando], { encoding: 'utf8', env, timeout: 60000, cwd: home });
  return r.error ? null : r;
}

test('T16 Respaldo_PegadoTalCual_SeAcepta — @story-8.316 @ac-11', { skip: process.platform === 'win32' }, () => {
  const c = tresRepos('t16-316');
  const h = tmp('home-');
  // sin la firma: imprime el comando de la terminal, con la forma <Nombre>/<ruta>
  const r = marker(h, 's16', ['adhoc', 'set', pedido({ allowedFiles: ['B/src/A.cs', 'F/src/x.tsx'] })], { cwd: c.R });
  assert.notEqual(r.status, 0);
  const renglon = r.stderr.split('\n').find((l) => /--terminal --for-session s16/.test(l));
  assert.ok(renglon, r.stderr);
  assert.match(renglon, /"allowedFiles":\["B\/src\/A\.cs","F\/src\/x\.tsx"\]/);
  assert.doesNotMatch(renglon, /\.\.\//);
  // pegado tal cual en la terminal de la persona: se acepta y queda declarado. El renglón nombra el guion por su ruta
  // estable de la instalación (8.319), que esta casa de prueba no tiene: se pega apuntando al guion de este repo, con el
  // resto del renglón igual
  const pegado = renglon.trim().replace(/^node\s+("[^"]*marker\.js"|\S*marker\.js)/, `node "${MARKER}"`);
  assert.notStrictEqual(pegado, renglon.trim(), `el renglón no empieza por el guion: ${renglon}`);
  const t = enTerminal(h, pegado);
  if (!t) return;
  assert.equal(t.status, 0, t.stdout);
  // el resumen que lee la persona pone los repos antes del motivo
  const resumen = t.stdout.split('\n').find((l) => /en 2 repos: B \(1\), F \(1\)/.test(l));
  assert.ok(resumen && resumen.indexOf('2 repos') < resumen.indexOf('arreglo del combo'), t.stdout);
  assert.deepStrictEqual(leerCarril(h, 's16').allowedFiles, [path.join(c.B, 'src/A.cs'), path.join(c.F, 'src/x.tsx')]);
  assert.equal(leerCarril(h, 's16').via, 'terminal');
});

test('T17 HermanoConSesionViva_SeNiega — @story-8.316 @ac-12', () => {
  const c = tresRepos('t17-316');
  const h = tmp('home-');
  // otra sesión con su carpeta en B, que anduvo recién
  const dir = path.join(h, '.claude', 'projects', c.B.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'viva17.jsonl'), `${JSON.stringify({ type: 'user', cwd: c.B, message: { role: 'user', content: 'hola' } })}\n`);
  const r = marker(h, 's17', ['adhoc', 'set', pedido({ allowedFiles: ['B/src/A.cs'] })], { cwd: c.R, via: 'click' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /la sesión viva17 está viva en B.*anduvo hace \d+ min/);
  assert.ok(!fs.existsSync(path.join(estado(h), 'adhoc', 's17.json')));
});

test('T20 Porton_DosRepos_ListaYCupo — @story-8.316 @ac-15', () => {
  const c = tresRepos('t20-316');
  const h = tmp('home-');
  const listaB = path.join(c.B, 'src/a.js');
  const listaF = path.join(c.F, 'src/b.js');
  const state = conCarril(h, 's20', { allowedFiles: [listaB, listaF], maxFiles: 1, cwd: c.R });
  // un archivo no listado de cualquiera de los dos repos frena
  for (const [dir, f] of [[c.B, path.join(c.B, 'src/otro.js')], [c.F, path.join(c.F, 'src/otro.js')]]) {
    const v = ev(state, 's20', f, dir);
    assert.equal(v.verdict.action, 'block', f);
    assert.equal(v.verdict.kind, 'adhoc-out-of-list', f);
    assert.doesNotMatch(v.message, /ampliar la lista no alcanza/);
  }
  // el cupo suma los dos repos: con uno ya tocado en B, el segundo archivo de código (en F) pasa el tope
  escribir(c.B, 'src/a.js', 'cambio\n');
  conCarril(h, 's20', { allowedFiles: [listaB, listaF], maxFiles: 1, files: [listaB], cwd: c.R });
  const cupo = ev(state, 's20', listaF, c.F);
  assert.equal(cupo.verdict.action, 'block', JSON.stringify(cupo.verdict));
  assert.notEqual(cupo.verdict.kind, 'adhoc-out-of-list');
  // un archivo de un repo al lado que no está en el grupo: el texto lo dice
  const Z = repo(c.raiz, 'Z');
  const vz = ev(state, 's20', path.join(Z, 'src/z.js'), Z);
  assert.equal(vz.verdict.kind, 'adhoc-out-of-list');
  assert.match(vz.message, /Ese archivo es de el repo Z, que no vale como hermano de R \(Z no está en repo_group de R.*ampliar la lista no alcanza/);
});

test('T24 Guias_DicenLaForma — @story-8.316 @ac-18', () => {
  const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
  for (const [rel, frases] of [
    ['guides/coordination.md', [/<Nombre>\/<ruta>/, /rama principal del remoto/, /en los dos sentidos/, /se firma y se delega como una de un solo repo/, /no entra por ninguna vía/, /adhoc test --repo/]],
    ['guides/coordination.en.md', [/<Name>\/<path>/, /remote's main branch/, /both\s+ways/, /signed and delegated like a single-repo one/, /gets in by no route/, /adhoc test --repo/]],
    ['guides/firmas-del-arnes.md', [/<Nombre>\/<ruta>/, /rama principal del remoto/, /en los dos\s+sentidos/, /se\s+delega\s+igual/, /no entra en la\s+lista por ninguna vía/, /adhoc test --repo/]],
  ]) {
    const t = leer(rel);
    for (const re of frases) assert.match(t, re, `${rel}: ${re}`);
  }
  // la decisión vieja (sólo el click o la terminal para varios repos) no queda escrita
  for (const rel of ['guides/coordination.md', 'guides/firmas-del-arnes.md']) assert.doesNotMatch(leer(rel), /de más de un repo no se delega|pero no se delega: lo firmás sólo con tu click/, rel);
});

// ── lo que encontró el pase adversarial (8.316) ─────────────────────────────────────────────────────────────────────

test('P1 Grupo_FormasDeYaml_SeLeenTodas — @story-8.316 @ac-2', () => {
  const e = RG().entradasDe;
  assert.deepStrictEqual(e('repo_group:\n- A\n- B\n'), ['A', 'B'], 'guiones sin sangría');
  assert.deepStrictEqual(e('repo_group:\n  - A\n  # el del frente\n  - B\n'), ['A', 'B'], 'un comentario entre guiones');
  assert.deepStrictEqual(e('repo_group:\n  - A\n\n  - B\notra: 1\n'), ['A', 'B'], 'un renglón en blanco');
  assert.deepStrictEqual(e('repo_group:\n  - A  # el back\n  - "B"\n'), ['A', 'B'], 'un comentario al final');
  assert.deepStrictEqual(e('repo_group: # los hermanos\n  - A\n'), ['A'], 'un comentario después de la llave');
  assert.deepStrictEqual(e('repo_group: [A, "B"] # en línea\n'), ['A', 'B']);
  assert.strictEqual(e('otra: 1\n'), null);
  assert.strictEqual(e('repo_group:\notra: 1\n'), null);
});

test('P2 Lista_CarpetaComunAlLado_NoEsUnHermano — @story-8.316 @ac-5', () => {
  const c = tresRepos('p2-316');
  // una carpeta común (no es un repo) al lado de R, fuera del grupo: `docs/nuevo.md` es una carpeta nueva de R
  fs.mkdirSync(path.join(c.raiz, 'docs'));
  assert.deepStrictEqual(norma(['docs/nuevo.md'], c.R).lista, [path.join(c.R, 'docs/nuevo.md')]);
  // y su código se cuenta con el prefijo, como una carpeta de R
  fs.mkdirSync(path.join(c.raiz, 'tests'));
  assert.strictEqual(lista().esCodigoRel('tests/A.cs', { cwd: c.R }), false);
});

test('P3 Lista_PedidaPorUnEnlace_NombraLasRutasDelRepo — @story-8.316 @ac-11', () => {
  const c = tresRepos('p3-316');
  const enlace = path.join(tmp('p3-enlace-'), 'R');
  fs.symlinkSync(c.R, enlace);
  const n = norma(['src/a.js', 'B/src/A.cs'], enlace);
  assert.ok(n.lista, n.problema);
  assert.deepStrictEqual(n.lista.map((f) => lista().relDeLaLista(f, enlace, n.hermanos)).sort(), ['B/src/A.cs', 'src/a.js']);
});
