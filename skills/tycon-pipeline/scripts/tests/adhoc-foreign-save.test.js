#!/usr/bin/env node
'use strict';
/**
 * adhoc-foreign-save.test.js — un guardado ajeno a un camino corto que espera sus revisores.
 *
 *   T1  frena y anota el pedido: el comando, la carpeta, el repo, la rama, la huella y lo que guarda
 *   T2  el cuadro muestra lo que guarda: hasta cinco nombres y cuántos más, lo que puede sumar, los commits del push, los
 *       hooks; sin pedido no pide nada
 *   T3  sólo una persona: la ventana, la delegación, «hecho y avisado», un «aprobado» escrito y una vía que no se conoce
 *       no anotan; el click y la terminal sí; un pedido que cambió entre el cuadro y el anotado, no
 *   T4  el permiso vale una vez y para lo que se vio; de dos copias a la vez pasa una; `adhoc set` lo borra
 *   T5  lo que no se ofrece al click frena como siempre, sin pedido
 *   T5b la configuración de la máquina (y su carpeta de hooks) se muestra y entra en la huella (decisión 7 bis)
 *   T5c y T10 a T18: los huecos que encontró el pase adversarial, cada uno frena como siempre o muestra lo que guarda
 *   T6  los comandos descartados el 7/11: ninguno pasa ni ofrece el click
 *   T7  con las constancias vigentes, o sin marca, lo ajeno pasa como siempre
 *   T8  el chequeo en seco no trae la base; la vuelta real la trae una vez por repo
 *   T9  los textos en los dos perfiles
 *
 * stable-data: crea repos de git en carpetas temporales; la configuración global de git es un archivo de la prueba y la
 * del sistema no se lee. Nunca toca el repo real.
 * Correr: node --test skills/tycon-pipeline/scripts/tests/adhoc-foreign-save.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync, spawn } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const MARKER = path.join(SCRIPTS, 'marker.js');
const saveBrake = require(path.join(SCRIPTS, 'lib', 'save-brake.js'));
const adhocBase = require(path.join(SCRIPTS, 'lib', 'adhoc-base.js'));
const fa = require(path.join(SCRIPTS, 'lib', 'adhoc-foreign-save.js'));
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const fuentes = require(path.join(RAIZ, 'scripts', 'lib', 'signature-sources.js'));
const firmas = require(path.join(RAIZ, 'scripts', 'lib', 'signatures.js'));
const { conVentana } = require(path.join(RAIZ, 'scripts', 'tests', 'lib', 'window-passed.js'));

// la configuración de git de la prueba: la global es un archivo propio y la del sistema no se lee
const GLOBAL = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitglobal-'))), 'gitconfig');
fs.writeFileSync(GLOBAL, '');
process.env.GIT_CONFIG_GLOBAL = GLOBAL;
process.env.GIT_CONFIG_NOSYSTEM = '1';

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commitear = (dir, msg = 'x') => git(dir, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', msg);
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
function escribir(dir, rel, txt = 'x\n') {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), txt);
}

function repoConOrigen(raiz, nombre) {
  const origen = path.join(raiz, `${nombre}-origen.git`);
  const dir = path.join(raiz, nombre);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origen]);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  git(dir, 'remote', 'add', 'origin', origen);
  escribir(dir, 'README.md');
  git(dir, 'add', '.');
  commitear(dir, 'base');
  git(dir, 'push', '-q', 'origin', 'main');
  return dir;
}

function conCarril(home, sid, extra = {}) {
  const state = path.join(home, '.claude', '.tycon-pipeline');
  fs.mkdirSync(path.join(state, 'adhoc'), { recursive: true });
  const ts = new Date().toISOString();
  const a = { reason: 'arreglo de prueba del laboratorio', maxFiles: 5, files: [], declaredAt: ts, lastTouch: ts, firmadaEn: ts, ...extra };
  fs.writeFileSync(path.join(state, 'adhoc', `${sid}.json`), JSON.stringify(a));
  fs.appendFileSync(path.join(state, 'gates.log'), `${JSON.stringify({ ts, name: 'adhoc-lane-signed', status: 'ok', destino: sid })}\n`);
  return state;
}
const leerCarril = (state, sid) => JSON.parse(fs.readFileSync(path.join(state, 'adhoc', `${sid}.json`), 'utf8'));
const escribirCarril = (state, sid, a) => fs.writeFileSync(path.join(state, 'adhoc', `${sid}.json`), JSON.stringify(a));
const sinClick = (state) => fs.readFileSync(path.join(state, 'gates.log'), 'utf8').split('\n').filter((l) => l.includes('guardado ajeno sin click'));

/**
 * Un carril con una migración marcada de riesgo alto y sin constancias, y un repo ajeno con un archivo preparado. `marca`
 * en false: el carril sin marca.
 */
function escenario(nombre, { marca = true } = {}) {
  const raiz = tmp(`fs-${nombre}-`);
  const home = tmp('home-');
  const prod = repoConOrigen(raiz, 'producto');
  // sin marca, el carril toca un archivo que no es de riesgo alto (una migración lo marcaría al medir)
  const rel = marca ? 'db/migrations/001.sql' : 'src/a.js';
  const mig = path.join(prod, rel);
  escribir(prod, rel, 'select 1;\n');
  const sid = `s-${nombre}`;
  const state = conCarril(home, sid, { rutas: [mig], bases: { [prod]: adhocBase.traerBase(prod) },
    ...(marca ? { riesgoAlto: { regla: 'porton-instalador-migracion', archivo: mig, motivo: 'de prueba', ts: new Date().toISOString() } } : {}) });
  const ajeno = repoConOrigen(raiz, 'ajeno');
  escribir(ajeno, 'docs/constancia.md', 'ok\n');
  git(ajeno, 'add', '.');
  const original = leerCarril(state, sid);
  const decidir = (command, cwd = ajeno) => saveBrake.decidir({ command, cwd, sid, home });
  const reiniciar = () => { escribirCarril(state, sid, original); fa.borrarPermiso(state, sid); };
  return { raiz, home, prod, ajeno, sid, state, mig, decidir, reiniciar };
}

/** marker.js adhoc allow-foreign-save con la ventana de la prueba (`opts` de conVentana) y, si hace falta, otro preload. */
function permitir(e, opts = {}, { preload, env = {} } = {}) {
  const base = conVentana({ ...process.env, HOME: e.home, USERPROFILE: e.home, CLAUDE_CODE_SESSION_ID: e.sid, ...env }, opts);
  if (preload) base.NODE_OPTIONS = `${base.NODE_OPTIONS} --require ${preload}`;
  return spawnSync(process.execPath, [MARKER, 'adhoc', 'allow-foreign-save'], { encoding: 'utf8', env: base, cwd: e.home });
}
const permiso = (e) => { try { return JSON.parse(fs.readFileSync(fa.permisoPath(e.state, e.sid), 'utf8')); } catch (_) { return null; } };
const adhocLog = (e) => { try { return fs.readFileSync(path.join(e.state, 'adhoc.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } };

/** Un repo con sus hooks versionados en `.githooks` (un `pre-commit` ejecutable) y `core.hooksPath` apuntándolos. */
function conHooksVersionados(dir) {
  escribir(dir, '.githooks/pre-commit', '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(dir, '.githooks/pre-commit'), 0o755);
  git(dir, 'add', '.githooks');
  // sólo los hooks: lo que ya estaba preparado sigue preparado
  git(dir, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'hooks', '--', '.githooks');
  // en main del origen, como en el repo de verdad: un hook nuevo sin subir es una ruta de riesgo alto del propio guardado
  git(dir, 'push', '-q', 'origin', 'HEAD:main');
  git(dir, 'config', 'core.hooksPath', '.githooks');
}

// ── T1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 🔴 Falla con: lo ajeno frena sin salida (el caso de la fila T-197), o pasa sin persona.
test('T1 GuardadoAjeno_FrenaYAnotaElPedido @story-8.236 @ac-1', () => {
  const e = escenario('t1');
  const d = e.decidir('git commit -m constancia');
  assert.ok(d && d.texto, JSON.stringify(d));
  assert.match(d.texto, /«arreglo de prueba del laboratorio»/);
  assert.ok(d.texto.includes(e.mig), 'nombra la ruta que espera sus revisores');
  assert.match(d.texto, /adhoc allow-foreign-save/);
  const p = leerCarril(e.state, e.sid).guardadoAjeno;
  assert.ok(p && p.huella, 'el pedido queda en el carril');
  assert.deepStrictEqual([p.comando, p.repo, p.rama, p.cwd], ['git commit -m constancia', e.ajeno, 'main', e.ajeno]);
  assert.deepStrictEqual(p.guarda, [{ tipo: 'commit', archivos: ['docs/constancia.md'], todos: false }]);

  // en otro worktree del repo del carril, en otra rama
  const wt = path.join(e.raiz, 'producto-wt');
  git(e.prod, 'worktree', 'add', '-q', '-b', 'otra', wt);
  escribir(wt, 'docs/c.md', 'c\n');
  git(wt, 'add', '.');
  const d2 = e.decidir('git commit -m c', wt);
  assert.match(d2.texto, /adhoc allow-foreign-save/);
  assert.strictEqual(leerCarril(e.state, e.sid).guardadoAjeno.repo, wt);
});

// ── T2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const cuadro = (e) => fuentes.partesDe({ firma: 'adhoc-lane:guardado-ajeno', palabras: ['marker.js', 'adhoc', 'allow-foreign-save'], estado: e.state, destino: e.sid });

test('T2 AllowForeignSave_CuadroMuestraLoQueGuarda @story-8.236 @ac-2', () => {
  const e = escenario('t2');
  for (let k = 1; k <= 6; k++) escribir(e.ajeno, `docs/a${k}.md`);
  git(e.ajeno, 'add', '.');
  e.decidir('git commit -m siete');
  let c = cuadro(e);
  const que = c.queHace.join('\n');
  assert.match(que, /^Comando: git commit -m siete$/m);
  assert.ok(que.includes(`En: ${e.ajeno} · rama main`));
  // la lista entera en el cuadro: lo que se aprueba se ve todo, sin «y N más»
  assert.match(que, /Commit de 7 archivo\(s\): (docs\/[a-z0-9]+\.md, ){6}docs\/[a-z0-9]+\.md$/m);
  assert.match(que, /Hooks que corren al guardar: ninguno/);
  assert.ok(c.fuente.includes(leerCarril(e.state, e.sid).guardadoAjeno.huella), 'el código del cuadro sale de la huella');
  // la lista entera, antes del cuadro
  assert.match(fa.lineasDe(leerCarril(e.state, e.sid).guardadoAjeno, { todo: true }).join('\n'), /docs\/a6\.md/);

  // con `git add` antes, todos los que tienen cambios
  escribir(e.ajeno, 'suelto.md');
  e.decidir('git add -A && git commit -m todo');
  assert.match(cuadro(e).queHace.join('\n'), /todos los que tienen cambios: el comando puede sumar más/);
  assert.match(fa.lineasDe(leerCarril(e.state, e.sid).guardadoAjeno, { todo: true }).join('\n'), /suelto\.md/);

  // un push de dos commits
  e.reiniciar();
  git(e.ajeno, 'add', '-A');
  commitear(e.ajeno, 'uno');
  escribir(e.ajeno, 'docs/b.md');
  git(e.ajeno, 'add', '.');
  commitear(e.ajeno, 'dos');
  // un remoto de un servidor: uno de esta máquina no se ofrece (sus hooks del lado que recibe corren acá). El push no
  // corre: la copia local de origin/main sigue siendo la del repo de la prueba
  const origenLocal = git(e.ajeno, 'remote', 'get-url', 'origin');
  git(e.ajeno, 'remote', 'set-url', 'origin', 'https://host.example/org/ajeno-origen.git');
  e.decidir('git push origin main');
  assert.match(cuadro(e).queHace.join('\n'), /Push a origin \(.*ajeno-origen\.git\), rama main: 2 commit\(s\) que origin\/main no tiene, según la última copia local: [0-9a-f]+ dos, [0-9a-f]+ uno/);
  git(e.ajeno, 'remote', 'set-url', 'origin', origenLocal);

  // los hooks versionados
  e.reiniciar();
  escribir(e.ajeno, 'docs/c.md');
  git(e.ajeno, 'add', '.');
  conHooksVersionados(e.ajeno);
  e.decidir('git commit -m con-hooks');
  assert.match(cuadro(e).queHace.join('\n'), /Hooks que corren al guardar: pre-commit \(de \.githooks, versionados, sin cambios contra HEAD\)/);

  // sin pedido no hay cuadro, y el comando no pide nada
  e.reiniciar();
  assert.ok(cuadro(e).error, 'sin pedido, el cuadro se niega');
  const r = permitir(e, { via: 'click' });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /No pido nada/);

  const s = firmas.SIGNATURES.find((x) => x.id === 'adhoc-lane:guardado-ajeno');
  assert.strictEqual(s.level, 2);
  assert.strictEqual(s.clickDelDueno, true);
});

// ── T3 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// la terminal de verdad (una pseudo-terminal de Python) que contesta «firmo»; sin Python o en Windows no se mide
const CON_TERMINAL = [
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
function enTerminal(e) {
  if (process.platform === 'win32') return null;
  const env = { ...process.env, HOME: e.home, USERPROFILE: e.home, RESPUESTA_TTY: 'firmo' };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'NODE_OPTIONS', 'CI', 'TF_BUILD', 'GITHUB_ACTIONS']) delete env[k];
  const r = spawnSync('python3', ['-c', CON_TERMINAL, process.execPath, MARKER, 'adhoc', 'allow-foreign-save', '--terminal', '--for-session', e.sid],
    { encoding: 'utf8', env, timeout: 60000, cwd: e.home });
  return r.error ? null : r;
}

test('T3 AllowForeignSave_SoloLaPersona @story-8.236 @ac-3', () => {
  const e = escenario('t3');
  e.decidir('git commit -m constancia');
  for (const opts of [{}, { delegadaPor: 'ses-coord' }, { via: 'avisado' }, { via: 'mensaje' }, { via: 'una-que-no-existe' }]) {
    const r = permitir(e, opts);
    assert.notStrictEqual(r.status, 0, `${JSON.stringify(opts)}: ${r.stdout}${r.stderr}`);
    assert.strictEqual(permiso(e), null, `${JSON.stringify(opts)}: no anota`);
  }
  assert.ok(!adhocLog(e).some((x) => x.kind === 'ADHOC_FOREIGN_SAVE_ALLOWED'));

  // el pedido cambia entre el cuadro y el anotado: no anota
  const cambia = path.join(tmp('cambia-'), 'cambia.js');
  fs.writeFileSync(cambia, [
    "const Module = require('module'); const fs = require('fs'); const orig = Module._load;",
    'Module._load = function (req) { const m = orig.apply(this, arguments);',
    "  if (/owner-window\\.js$/.test(req) && !m.__cambia) { const ex = m.exigir; m.__cambia = true;",
    '    m.exigir = (o) => { const r = ex(o); const f = process.env.REQUEST_FILE; const a = JSON.parse(fs.readFileSync(f, "utf8"));',
    "      a.guardadoAjeno.huella = 'otra'; fs.writeFileSync(f, JSON.stringify(a)); return r; };",
    // la ventana de la prueba vuelve a envolver exigir en cada carga si no ve su marca
    '    m.exigir.porPasada = ex.porPasada; }',
    '  return m; };',
  ].join('\n'));
  const r0 = permitir(e, { via: 'click' }, { preload: cambia, env: { REQUEST_FILE: path.join(e.state, 'adhoc', `${e.sid}.json`) } });
  assert.strictEqual(r0.status, 1, `${r0.stdout}${r0.stderr}`);
  assert.match(r0.stderr, /el pedido cambió/);
  assert.strictEqual(permiso(e), null);

  // el click anota el permiso con la huella, la vía y quién
  e.reiniciar();
  e.decidir('git commit -m constancia');
  const huella = leerCarril(e.state, e.sid).guardadoAjeno.huella;
  const r = permitir(e, { via: 'click' });
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /Lo que guarda, entero:/);
  assert.deepStrictEqual([permiso(e).huella, permiso(e).via, permiso(e).comando], [huella, 'click', 'git commit -m constancia']);
  const log = adhocLog(e).find((x) => x.kind === 'ADHOC_FOREIGN_SAVE_ALLOWED');
  assert.ok(log && log.huella === huella && log.via === 'click');

  // la terminal también
  e.reiniciar();
  e.decidir('git commit -m constancia');
  const t = enTerminal(e);
  if (!t) return console.log('⏭ la firma por la terminal: NO MEDIDA — sin Python o en Windows');
  assert.strictEqual(t.status, 0, t.stdout);
  assert.strictEqual(permiso(e).via, 'terminal');
});

// ── T4 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
function conPermiso(e, comando, cwd) {
  const d = e.decidir(comando, cwd);
  assert.match(d.texto, /adhoc allow-foreign-save/, `primero frena con el pedido; ${sinClick(e.state).slice(-1)[0] || ''}`);
  const r = permitir(e, { via: 'click' });
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  return leerCarril(e.state, e.sid).guardadoAjeno.huella;
}
function correrDosCopias(e, comando) {
  const hijo = (n) => new Promise((ok) => {
    const p = spawn(process.execPath, ['-e', `const sb = require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'save-brake.js'))});
      const d = sb.decidir({ command: ${JSON.stringify(comando)}, cwd: ${JSON.stringify(e.ajeno)}, sid: ${JSON.stringify(e.sid)}, home: ${JSON.stringify(e.home)} });
      process.stdout.write(d && d.texto ? 'frena' : 'pasa');`], { env: process.env });
    let out = '';
    p.stdout.on('data', (b) => { out += b; });
    p.on('close', () => ok(`${n}:${out}`));
  });
  return Promise.all([hijo(1), hijo(2)]);
}

test('T4 Permiso_UnaVezYParaLoQueSeVio @story-8.236 @ac-4', async () => {
  const e = escenario('t4');
  const cmd = 'git commit -m constancia';
  const h0 = conPermiso(e, cmd);
  assert.strictEqual(e.decidir(cmd), null, 'con el permiso pasa una vez');
  assert.strictEqual(permiso(e), null, 'y el permiso se gasta');
  assert.match(e.decidir(cmd).texto, /adhoc allow-foreign-save/, 'la segunda vez frena con un pedido nuevo');

  // dos copias a la vez: pasa una
  e.reiniciar();
  conPermiso(e, cmd);
  const dos = (await correrDosCopias(e, cmd)).map((x) => x.split(':')[1]).sort();
  assert.deepStrictEqual(dos, ['frena', 'pasa'], dos.join(','));

  // un archivo más en el commit
  e.reiniciar();
  conPermiso(e, cmd);
  escribir(e.ajeno, 'docs/otro.md');
  git(e.ajeno, 'add', '.');
  assert.match(e.decidir(cmd).texto, /adhoc allow-foreign-save/);
  assert.notStrictEqual(leerCarril(e.state, e.sid).guardadoAjeno.huella, h0, 'pedido nuevo');

  // el contenido cuenta, no sólo el nombre (SEG-FA-1 de la revisión): un archivo seguido reescrito después del click,
  // con `commit -a`, y uno sin seguir reescrito, con `add -A`
  e.reiniciar();
  escribir(e.ajeno, 'README.md', 'cambio visto\n');
  conPermiso(e, 'git commit -a -m todo');
  escribir(e.ajeno, 'README.md', 'otro contenido\n');
  assert.match(e.decidir('git commit -a -m todo').texto, /adhoc allow-foreign-save/, 'seguido reescrito: pedido nuevo');
  git(e.ajeno, 'checkout', '-q', '--', 'README.md');
  e.reiniciar();
  escribir(e.ajeno, 'nuevo.md', 'visto\n');
  conPermiso(e, 'git add -A && git commit -m n');
  escribir(e.ajeno, 'nuevo.md', 'reescrito\n');
  assert.match(e.decidir('git add -A && git commit -m n').texto, /adhoc allow-foreign-save/, 'sin seguir reescrito: pedido nuevo');
  fs.rmSync(path.join(e.ajeno, 'nuevo.md'));

  // otro HEAD
  e.reiniciar();
  conPermiso(e, cmd);
  escribir(e.ajeno, 'docs/h.md');
  git(e.ajeno, 'add', 'docs/h.md');
  commitear(e.ajeno, 'otro head');
  assert.match(e.decidir(cmd).texto, /adhoc allow-foreign-save/);

  // un hook que cambió (versionado, y guardado)
  e.reiniciar();
  conHooksVersionados(e.ajeno);
  conPermiso(e, cmd);
  escribir(e.ajeno, '.githooks/pre-commit', '#!/bin/sh\necho otro\nexit 0\n');
  git(e.ajeno, 'add', '.githooks');
  commitear(e.ajeno, 'hook nuevo');
  escribir(e.ajeno, 'docs/constancia.md', 'otra vez\n');
  git(e.ajeno, 'add', '.');
  // el hook cambiado sin subir es además una ruta de riesgo alto del propio guardado: frena, sin el permiso viejo
  assert.ok(e.decidir(cmd).texto, 'con el hook cambiado frena');
  // (y su repo entró al carril, como manda el cierre de T-225); subido y con el carril como estaba, pedido nuevo
  git(e.ajeno, 'push', '-q', 'origin', 'HEAD:main');
  e.reiniciar();
  assert.match(e.decidir(cmd).texto, /adhoc allow-foreign-save/, 'subido, frena con un pedido nuevo');

  // otro comando, otra carpeta
  e.reiniciar();
  conPermiso(e, cmd);
  assert.match(e.decidir('git commit -m otra-cosa').texto, /adhoc allow-foreign-save/);
  e.reiniciar();
  conPermiso(e, cmd);
  fs.mkdirSync(path.join(e.ajeno, 'docs', 'sub'), { recursive: true });
  assert.match(e.decidir(cmd, path.join(e.ajeno, 'docs', 'sub')).texto, /adhoc allow-foreign-save/);

  // a los 31 minutos del click
  e.reiniciar();
  conPermiso(e, cmd);
  const p = permiso(e);
  fs.writeFileSync(fa.permisoPath(e.state, e.sid), JSON.stringify({ ...p, at: new Date(Date.now() - 31 * 60 * 1000).toISOString() }));
  assert.match(e.decidir(cmd).texto, /adhoc allow-foreign-save/);

  // un permiso que no anotó una persona, o con una hora que no llegó, no vale (SEG-FA-5 de la revisión)
  e.reiniciar();
  conPermiso(e, cmd);
  const bueno = permiso(e);
  const pedidoAhora = leerCarril(e.state, e.sid).guardadoAjeno;
  for (const malo of [{ ...bueno, via: 'delegacion' }, { ...bueno, via: 'ventana' }, { ...bueno, at: new Date(Date.now() + 10 * 60 * 1000).toISOString() }]) {
    fs.writeFileSync(fa.permisoPath(e.state, e.sid), JSON.stringify(malo));
    assert.strictEqual(fa.reclamarPermiso(e.state, e.sid, pedidoAhora), false, JSON.stringify({ via: malo.via, at: malo.at }));
  }

  // volver a declarar el carril borra el pedido y el permiso
  e.reiniciar();
  conPermiso(e, cmd);
  const r = spawnSync(process.execPath, [MARKER, 'adhoc', 'set', JSON.stringify({ reason: 'arreglo de prueba del laboratorio', allowedFiles: ['db/migrations/001.sql'], datos: 'sin-cambio' })],
    { encoding: 'utf8', cwd: e.prod, env: conVentana({ ...process.env, HOME: e.home, USERPROFILE: e.home, CLAUDE_CODE_SESSION_ID: e.sid }) });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(permiso(e), null, 'sin permiso');
  assert.strictEqual(leerCarril(e.state, e.sid).guardadoAjeno, undefined, 'sin pedido');
});

// ── T5 y T6 ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Frena como siempre, sin pedido ni click; con `motivo`, el registro dice por qué no se ofreció. */
function frenaComoHoy(e, comando, { cwd, motivo } = {}) {
  e.reiniciar();
  const antes = sinClick(e.state).length;
  const d = e.decidir(comando, cwd);
  assert.ok(d && d.texto, `${comando}: ${JSON.stringify(d)}`);
  assert.match(d.texto, /faltan los revisores y el pase/, comando);
  assert.doesNotMatch(d.texto, /allow-foreign-save/, comando);
  assert.strictEqual(leerCarril(e.state, e.sid).guardadoAjeno, undefined, `${comando}: sin pedido`);
  if (motivo) {
    const nuevos = sinClick(e.state).slice(antes);
    assert.ok(nuevos.some((l) => motivo.test(l)), `${comando}: ${nuevos.join(' | ') || 'sin renglón'} · estado: ${git(e.ajeno, 'status', '--porcelain', '--untracked-files=all')} · ${git(e.ajeno, 'log', '--oneline', 'origin/main..HEAD')}`);
  }
}

test('T5 NoAjeno_FrenaComoHoy @story-8.236 @ac-5', () => {
  const e = escenario('t5');
  frenaComoHoy(e, 'git add -A && git commit -m x', { cwd: e.prod });
  frenaComoHoy(e, '$G commit -m x');
  frenaComoHoy(e, 'gh pr create --fill');
  frenaComoHoy(e, 'git commit --amend -m x', { motivo: /--amend/ });
  frenaComoHoy(e, 'git push --force origin main', { motivo: /empuja con --force/ });
  frenaComoHoy(e, 'git push --all origin', { motivo: /empuja con --all/ });
  frenaComoHoy(e, 'git push origin main otra', { motivo: /más de un refspec/ });
  frenaComoHoy(e, 'git push origin :main', { motivo: /borra o fuerza/ });
  frenaComoHoy(e, 'git push origin +main', { motivo: /borra o fuerza/ });
  frenaComoHoy(e, 'git -c url.x.insteadOf=origin push origin main', { motivo: /a dónde empuja/ });
  frenaComoHoy(e, 'git -C ../producto add -A && git commit -m x', { motivo: /toca más de un repo/ });
  // lo que la configuración decide sin que el comando lo diga (SEG-FA-2 y 3 de la revisión)
  frenaComoHoy(e, 'git push --recurse-submodules=on-demand origin main', { motivo: /--recurse-submodules/ });
  frenaComoHoy(e, 'git push origin refs/heads/*:refs/heads/*', { motivo: /más de una rama/ });
  frenaComoHoy(e, 'git add -f docs && git commit -m x', { motivo: /git add -f/ });
  for (const [clave, valor, motivo] of [['branch.main.pushRemote', 'origin', /pushRemote/], ['remote.pushDefault', 'origin', /pushDefault/],
    ['remote.origin.push', 'refs/heads/*:refs/heads/*', /remote\.origin\.push/], ['push.default', 'matching', /matching/], ['push.followTags', 'true', /followTags/]]) {
    git(e.ajeno, 'config', clave, valor);
    frenaComoHoy(e, 'git push', { motivo });
    git(e.ajeno, 'config', '--unset', clave);
  }
  git(e.ajeno, 'config', 'trailer.x.cmd', './x');
  frenaComoHoy(e, 'git commit -m x', { motivo: /trailer\.x\.cmd .*del repo/ });
  git(e.ajeno, 'config', '--unset', 'trailer.x.cmd');
  frenaComoHoy(e, 'git push ../producto main', { motivo: /no es un remoto con nombre/ });
  frenaComoHoy(e, 'git -c core.sshCommand=x push origin main', { motivo: /-c core\.sshCommand/ });
  frenaComoHoy(e, 'git --config-env=core.sshCommand=V push origin main');
  frenaComoHoy(e, 'GIT_SSH_COMMAND=x git push origin main');
  frenaComoHoy(e, 'git push --receive-pack=x origin main', { motivo: /--receive-pack/ });
  frenaComoHoy(e, 'git commit -m "a\nb"');
  frenaComoHoy(e, 'git commit -m "a‮b"', { motivo: /no se ve/ });
  const largo = `git commit -m "${'x'.repeat(161 - 'git commit -m ""'.length)}"`;
  assert.strictEqual(largo.length, 161);
  frenaComoHoy(e, largo, { motivo: /más de 160/ });

  // su propia ruta de riesgo alto
  escribir(e.ajeno, 'db/migrations/002.sql', 'select 2;\n');
  git(e.ajeno, 'add', '.');
  frenaComoHoy(e, 'git commit -m migra', { motivo: /propia ruta de riesgo alto/ });
  git(e.ajeno, 'rm', '-q', '--cached', 'db/migrations/002.sql');
  fs.rmSync(path.join(e.ajeno, 'db'), { recursive: true });

  // dos repos
  const otro = repoConOrigen(e.raiz, 'ajeno2');
  escribir(otro, 'docs/x.md');
  git(otro, 'add', '.');
  frenaComoHoy(e, 'git -C ajeno commit -m a && git -C ajeno2 commit -m b', { cwd: e.raiz, motivo: /más de un repo/ });

  // un push a la URL del carril por otro nombre: ssh contra https, con `.git`, con `insteadOf`
  git(e.prod, 'remote', 'add', 'gh', 'https://Host.Example/org/carril.git');
  git(e.ajeno, 'remote', 'add', 'porssh', 'git@host.example:org/carril');
  git(e.ajeno, 'remote', 'add', 'sinpunto', 'https://host.example/org/carril');
  git(e.ajeno, 'config', 'url.https://host.example/org/.insteadOf', 'corto:');
  git(e.ajeno, 'remote', 'add', 'corto', 'corto:carril.git');
  for (const r of ['porssh', 'sinpunto', 'corto']) frenaComoHoy(e, `git push ${r} main`, { motivo: /URL de un remoto del carril/ });

  // un hook en .git/hooks
  escribir(e.ajeno, '.git/hooks/post-commit', '#!/bin/sh\nexit 0\n');
  frenaComoHoy(e, 'git commit -m x', { motivo: /hook que no es del repo/ });
  fs.rmSync(path.join(e.ajeno, '.git/hooks/post-commit'));

  // un hook versionado con un cambio sin guardar
  conHooksVersionados(e.ajeno);
  escribir(e.ajeno, '.githooks/pre-commit', '#!/bin/sh\necho cambio\n');
  // un hook es además una ruta de riesgo alto: cualquiera de los dos motivos lo saca del click
  frenaComoHoy(e, 'git commit -m x', { motivo: /tienen cambios|propia ruta de riesgo alto/ });
  git(e.ajeno, 'checkout', '-q', '--', '.githooks/pre-commit');

  // una clave del repo que corre un programa
  git(e.ajeno, 'config', 'core.pager', 'less');
  frenaComoHoy(e, 'git commit -m x', { motivo: /core\.pager .*del repo/ });
  git(e.ajeno, 'config', '--unset', 'core.pager');
});

// 🔴 Falla con: los huecos que encontró el pase adversarial de la 8.245 — una opción abreviada, una clave de gpg que
// corre un programa, la URL del carril escrita de otra forma, y una lista de rutas que el cuadro no mostraba.
test('T5c Pase_AbreviadasGpgYUrls_FrenanComoHoy @story-8.236 @ac-5', () => {
  const e = escenario('t5c');
  frenaComoHoy(e, 'git push --forc origin main', { motivo: /empuja con --forc/ });
  frenaComoHoy(e, 'git push --mir origin', { motivo: /empuja con --mir/ });
  frenaComoHoy(e, 'git push --receive=./x origin main', { motivo: /trae --receive/ });
  frenaComoHoy(e, 'git -c gpg.ssh.defaultKeyCommand=./x commit -m x', { motivo: /-c gpg\.ssh\.defaultKeyCommand/ });
  git(e.ajeno, 'config', 'gpg.ssh.defaultKeyCommand', './x');
  frenaComoHoy(e, 'git commit -m x', { motivo: /gpg\.ssh\.defaultkeycommand .*del repo/i });
  git(e.ajeno, 'config', '--unset', 'gpg.ssh.defaultKeyCommand');
  // Azure DevOps por ssh contra https, y la carpeta .git del carril
  git(e.prod, 'remote', 'add', 'ado', 'https://dev.azure.com/org/proy/_git/carril');
  git(e.ajeno, 'remote', 'add', 'adossh', 'git@ssh.dev.azure.com:v3/org/proy/carril');
  git(e.ajeno, 'remote', 'add', 'local', `${e.prod}/.git`);
  for (const r of ['adossh', 'local']) frenaComoHoy(e, `git push ${r} main`, { motivo: /URL de un remoto del carril/ });
  // las rutas que nombra un archivo: el cuadro avisa que el commit puede sumar más
  e.reiniciar();
  escribir(e.ajeno, 'lista.txt', 'docs/constancia.md\n');
  const d = e.decidir('git commit --pathspec-from-file=lista.txt -m x');
  assert.match(d.texto, /adhoc allow-foreign-save/, 'se ofrece el click');
  assert.match(fa.lineasDe(leerCarril(e.state, e.sid).guardadoAjeno, { todo: true }).join('\n'), /todos los que tienen cambios/);
});

// 🔴 Falla con: sólo se miraba la primera URL de empuje; git empuja a todas, y la segunda podía ser la del carril.
test('T10 Push_TodasLasUrlsDelRemoto @story-8.236 @ac-5', () => {
  const e = escenario('t10');
  const carril = path.join(e.raiz, 'producto-origen.git');
  // dos URLs de empuje: la segunda es la del carril
  git(e.ajeno, 'remote', 'add', 'dospush', 'https://host.example/org/otro.git');
  git(e.ajeno, 'remote', 'set-url', '--add', '--push', 'dospush', 'https://host.example/org/otro.git');
  git(e.ajeno, 'remote', 'set-url', '--add', '--push', 'dospush', carril);
  frenaComoHoy(e, 'git push dospush main', { motivo: /URL de un remoto del carril/ });
  // dos URLs de traer, sin las de empuje: git empuja a las dos
  git(e.ajeno, 'remote', 'add', 'dosurl', 'https://host.example/org/otro.git');
  git(e.ajeno, 'remote', 'set-url', '--add', 'dosurl', carril);
  frenaComoHoy(e, 'git push dosurl main', { motivo: /URL de un remoto del carril/ });
  // dos URLs ajenas: se ofrece, y el cuadro muestra las dos
  e.reiniciar();
  git(e.ajeno, 'remote', 'add', 'pub', 'https://host.example/org/a.git');
  git(e.ajeno, 'remote', 'set-url', '--add', '--push', 'pub', 'https://host.example/org/a.git');
  git(e.ajeno, 'remote', 'set-url', '--add', '--push', 'pub', 'https://host.example/org/b.git');
  assert.match(e.decidir('git push pub main').texto, /adhoc allow-foreign-save/, 'se ofrece el click');
  assert.match(fa.lineasDe(leerCarril(e.state, e.sid).guardadoAjeno).join('\n'), /Push a pub \(https:\/\/host\.example\/org\/a\.git, https:\/\/host\.example\/org\/b\.git\)/);
});

// 🔴 Falla con: la configuración con el mismo efecto que --mirror o --recurse-submodules, y push.default=upstream hacia
// una rama de otro nombre, se ofrecían al click con un destino que el cuadro no mostraba.
test('T11 Push_ConfiguracionQueEligeElDestino @story-8.236 @ac-5', () => {
  const e = escenario('t11');
  for (const [clave, valor, comando, motivo] of [
    ['remote.origin.mirror', 'true', 'git push origin', /remote\.origin\.mirror/],
    ['remote.origin.mirror', 'true', 'git push', /remote\.origin\.mirror/],
    ['push.recurseSubmodules', 'on-demand', 'git push origin main', /submódulos/],
    ['submodule.recurse', 'true', 'git push origin main', /submódulos/],
  ]) {
    git(e.ajeno, 'config', clave, valor);
    frenaComoHoy(e, comando, { motivo });
    git(e.ajeno, 'config', '--unset', clave);
  }
  // en la rama feat, que sigue a origin/main
  git(e.ajeno, 'switch', '-q', '-c', 'feat', '--track', 'origin/main');
  git(e.ajeno, 'config', 'push.default', 'upstream');
  frenaComoHoy(e, 'git push', { motivo: /push\.default=upstream empuja a refs\/heads\/main/ });
  git(e.ajeno, 'config', '--unset', 'push.default');
  git(e.ajeno, 'switch', '-q', 'main');
});

// 🔴 Falla con: un push a un repo de esta máquina corría sus hooks del lado que recibe sin mostrarlos ni meterlos en la huella.
test('T12 Push_ARepoDeEstaMaquina_NoSeOfrece @story-8.236 @ac-5', () => {
  const e = escenario('t12');
  frenaComoHoy(e, 'git push origin main', { motivo: /repo de esta máquina/ });
  git(e.ajeno, 'remote', 'add', 'porfile', `file://${path.join(e.raiz, 'ajeno-origen.git')}`);
  frenaComoHoy(e, 'git push porfile main', { motivo: /repo de esta máquina/ });
  // un transporte que corre un programa (`ext::`, o el ayudante git-remote-<transporte>)
  git(e.ajeno, 'remote', 'add', 'porext', 'ext::sh -c x');
  frenaComoHoy(e, 'git push porext main', { motivo: /transporte que corre un programa/ });
  git(e.ajeno, 'remote', 'add', 'porayudante', 'acme::https://host.example/org/ajeno.git');
  frenaComoHoy(e, 'git push porayudante main', { motivo: /transporte que corre un programa/ });
});

// 🔴 Falla con: un nombre de archivo con un carácter que no se ve, o una lista que no entra entera, que el cuadro mostraba
// recortada o distinta de lo que se guarda (revisor de seguridad, vuelta 2).
test('T12c Cuadro_LoQueNoSeVeONoEntra_NoSeOfrece @story-8.236 @ac-2', () => {
  const e = escenario('t12c');
  escribir(e.ajeno, 'docs/a​b.md');
  git(e.ajeno, 'add', '.');
  frenaComoHoy(e, 'git commit -m constancia', { motivo: /carácter que no se ve/ });
  git(e.ajeno, 'rm', '-q', '--cached', 'docs/a​b.md');
  fs.rmSync(path.join(e.ajeno, 'docs/a​b.md'));
  for (let k = 0; k < 30; k++) escribir(e.ajeno, `docs/un-nombre-largo-de-constancia-numero-${k}.md`);
  git(e.ajeno, 'add', '.');
  frenaComoHoy(e, 'git commit -m constancia', { motivo: /no entra entero en el cuadro/ });
  // y el cuadro, con todo lo que hace, no corta ningún renglón
  const largo = `Commit de 1 archivo(s): docs/${'x'.repeat(300)}.md`;
  const pregunta = require(path.join(RAIZ, 'scripts', 'lib', 'owner-approvals.js')).cuadroDe({ firma: 'adhoc-lane:guardado-ajeno', destino: e.sid, que: 'x', queHace: [largo], todoQueHace: true, siSaleMal: 'x', huella: 'h' }).pregunta;
  assert.ok(pregunta.includes(largo), 'el renglón entra entero');
  // tal cual: dos espacios seguidos siguen siendo dos, y un nombre que termina en punto conserva su punto
  for (const tal of ['Comando: git commit -m "a  b"', 'Commit de 1 archivo(s): docs/notas.']) {
    const p2 = require(path.join(RAIZ, 'scripts', 'lib', 'owner-approvals.js')).cuadroDe({ firma: 'adhoc-lane:guardado-ajeno', destino: e.sid, que: 'x', queHace: [tal], todoQueHace: true, siSaleMal: 'x', huella: 'h' }).pregunta;
    assert.ok(p2.includes(`${tal} ·`) || p2.includes(`${tal}.`), `tal cual: ${tal}`);
  }
  // un espacio que no se distingue del común (el duro) tampoco se ofrece
  git(e.ajeno, 'reset', '-q');
  for (let k = 0; k < 30; k++) fs.rmSync(path.join(e.ajeno, `docs/un-nombre-largo-de-constancia-numero-${k}.md`));
  escribir(e.ajeno, 'docs/a b.md');
  git(e.ajeno, 'add', '.');
  frenaComoHoy(e, 'git commit -m constancia', { motivo: /carácter que no se ve/ });
});

// 🔴 Falla con: el cuadro del click recortaba lo que hace a 3 renglones y escondía hooks y configuración (clase 17).
test('T12b Cuadro_MuestraTodoLoQueHace @story-8.236 @ac-2', () => {
  const e = escenario('t12b');
  const hooks = tmp('hooks-maquina-');
  escribir(hooks, 'pre-commit', '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(hooks, 'pre-commit'), 0o755);
  try {
    fs.writeFileSync(GLOBAL, `[core]\n\thooksPath = ${hooks}\n\tpager = less\n`);
    assert.match(e.decidir('git commit -m constancia').texto, /adhoc allow-foreign-save/);
    const p = cuadro(e);
    assert.strictEqual(p.todoQueHace, true);
    const pregunta = require(path.join(RAIZ, 'scripts', 'lib', 'owner-approvals.js')).cuadroDe({ firma: 'adhoc-lane:guardado-ajeno', destino: e.sid, que: 'x', queHace: p.queHace, todoQueHace: p.todoQueHace, siSaleMal: 'x', huella: 'h' }).pregunta;
    assert.ok(p.queHace.length > 3, JSON.stringify(p.queHace));
    assert.match(pregunta, /Hooks que corren al guardar/);
    assert.match(pregunta, /core\.pager=less/);
  } finally { fs.writeFileSync(GLOBAL, ''); }
});

// 🔴 Falla con: las abreviaturas de una letra (`--m` es --mirror, `--e` es --exec) y las de --amend y de add --force.
test('T13 Abreviaturas_CommitAddYPush @story-8.236 @ac-5', () => {
  const e = escenario('t13');
  frenaComoHoy(e, 'git push --m origin', { motivo: /empuja con --m\b/ });
  frenaComoHoy(e, 'git push --e=/tmp/x origin main', { motivo: /trae --e\b/ });
  frenaComoHoy(e, 'git commit --amen -m x', { motivo: /--amend/ });
  frenaComoHoy(e, 'git commit --am -m x', { motivo: /--amend/ });
  frenaComoHoy(e, 'git add --fo docs && git commit -m x', { motivo: /git add -f/ });
  frenaComoHoy(e, 'git add --f docs && git commit -m x', { motivo: /git add -f/ });
});

// 🔴 Falla con: un commit con una opción larga abreviada (`--inter`, `--al`) mostraba 0 archivos y no avisaba que suma.
test('T14 Commit_LargasAbreviadas_PuedenSumar @story-8.236 @ac-2', () => {
  const e = escenario('t14');
  escribir(e.ajeno, 'README.md', 'cambio sin preparar\n');
  for (const op of ['--inter', '--int', '--patc', '--al', '--inc', '--onl', '--interactive', '--patch']) {
    const [g] = fa.loQueGuarda([{ sub: 'commit', resto: [op, '-m', 'x'] }], e.ajeno);
    assert.strictEqual(g.todos, true, op);
    assert.ok(g.archivos.includes('README.md'), `${op}: ${g.archivos}`);
  }
  // sin esas opciones, sólo lo preparado
  assert.deepStrictEqual(fa.loQueGuarda([{ sub: 'commit', resto: ['-m', 'x'] }], e.ajeno)[0], { tipo: 'commit', archivos: ['docs/constancia.md'], todos: false });
});

// 🔴 Falla con: las formas viejas de Azure DevOps (visualstudio.com, DefaultCollection, vs-ssh) no se reconocían como el carril.
test('T15 Push_UrlsViejasDeAzure_SonDelCarril @story-8.236 @ac-5', () => {
  const clave = 'dev.azure.com/acme/proy/_git/carril';
  for (const u of ['https://dev.azure.com/acme/Proy/_git/carril', 'https://acme@dev.azure.com/acme/Proy/_git/carril.git',
    'https://acme.visualstudio.com/Proy/_git/carril', 'https://acme.visualstudio.com/DefaultCollection/Proy/_git/carril',
    'git@ssh.dev.azure.com:v3/acme/Proy/carril', 'acme@vs-ssh.visualstudio.com:v3/acme/Proy/carril',
    'ssh://acme@vs-ssh.visualstudio.com:22/v3/acme/Proy/carril']) {
    assert.strictEqual(fa.normalizarUrl(u), clave, u);
  }
  assert.strictEqual(fa.normalizarUrl('https://dev.azure.com/acme/_git/carril'), 'dev.azure.com/acme/carril/_git/carril');
  const e = escenario('t15');
  git(e.prod, 'remote', 'add', 'ado', 'https://dev.azure.com/acme/Proy/_git/carril');
  git(e.ajeno, 'remote', 'add', 'vieja', 'https://acme.visualstudio.com/Proy/_git/carril');
  git(e.ajeno, 'remote', 'add', 'coleccion', 'https://acme.visualstudio.com/DefaultCollection/Proy/_git/carril');
  git(e.ajeno, 'remote', 'add', 'vsssh', 'acme@vs-ssh.visualstudio.com:v3/acme/Proy/carril');
  for (const r of ['vieja', 'coleccion', 'vsssh']) frenaComoHoy(e, `git push ${r} main`, { motivo: /URL de un remoto del carril/ });
});

// 🔴 Falla con: desde una subcarpeta, una URL relativa se resolvía contra la carpeta del comando y no contra la raíz del
// repo, como hace git, y el push al carril se ofrecía al click.
test('T16 Push_UrlRelativaDesdeUnaSubcarpeta @story-8.236 @ac-5', () => {
  const e = escenario('t16');
  git(e.ajeno, 'remote', 'add', 'carril', '../producto-origen.git');
  const sub = path.join(e.ajeno, 'docs', 'sub');
  fs.mkdirSync(sub, { recursive: true });
  frenaComoHoy(e, 'git push carril main', { motivo: /URL de un remoto del carril/ });
  frenaComoHoy(e, 'git push carril main', { cwd: sub, motivo: /URL de un remoto del carril/ });
});

// 🔴 Falla con: un renombre en el árbol de trabajo (columna Y) mostraba un nombre cortado (`.txt`) y no el que se borra.
test('T17 Commit_RenombreEnElArbol_MuestraLosDosNombres @story-8.236 @ac-2', () => {
  const dir = tmp('renombre-');
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  escribir(dir, 'old.txt', 'contenido\n');
  git(dir, 'add', '.');
  commitear(dir, 'base');
  fs.renameSync(path.join(dir, 'old.txt'), path.join(dir, 'new.txt'));
  git(dir, 'add', '-N', 'new.txt');
  const [g] = fa.loQueGuarda([{ sub: 'commit', resto: ['-a', '-m', 'x'] }], dir);
  assert.deepStrictEqual(g.archivos.slice().sort(), ['new.txt', 'old.txt']);
});

// 🔴 Falla con: los caracteres de ancho cero, de formato y los separadores de renglón pasaban al click: una carpeta
// parecida se veía igual en el cuadro.
test('T18 Comando_ConUnCaracterQueNoSeVe @story-8.236 @ac-5', () => {
  for (const c of ['​', '‍', ' ', ' ', '﻿', '­', '⁠', 'ㅤ', '⠀', '‮', '\n']) {
    const motivo = fa.motivoParaNoOfrecer({ command: `cd /x/rep${c}o && git commit -m x`, cs: [], dudas: [], gits: [], repos: ['/x'], urls: new Set() });
    assert.match(String(motivo), /no se ve/, `U+${c.codePointAt(0).toString(16)}`);
  }
  const e = escenario('t18');
  frenaComoHoy(e, 'git commit -m "a​b"', { motivo: /no se ve/ });
});

// 🔴 Falla con: la configuración de una máquina común (git-lfs y los ayudantes de credenciales de gh) iba toda en un
// renglón de más de 600 letras, y el click no se ofrecía nunca en esa máquina.
test('T2b ConfiguracionComun_UnRenglonPorClave_SeOfreceElClick @story-8.236 @ac-2', () => {
  const e = escenario('t2b');
  const gh = '!/opt/homebrew/bin/gh auth git-credential';
  try {
    fs.writeFileSync(GLOBAL, [
      '[core]', '\teditor = nano',
      '[filter "lfs"]', '\tclean = git-lfs clean -- %f', '\tsmudge = git-lfs smudge -- %f', '\tprocess = git-lfs filter-process', '\trequired = true',
      '[credential "https://github.com"]', '\thelper =', `\thelper = ${gh}`,
      '[credential "https://gist.github.com"]', '\thelper =', `\thelper = ${gh}`,
      '[credential]', '\thelper =', '\thelper = /usr/local/share/gcm-core/git-credential-manager', '',
    ].join('\n'));
    const d = e.decidir('git commit -m constancia');
    assert.match(d.texto, /adhoc allow-foreign-save/, 'se ofrece el click');
    const lineas = fa.lineasDe(leerCarril(e.state, e.sid).guardadoAjeno, { todo: true });
    const conf = lineas.filter((l) => l.startsWith('Configuración de la máquina que corre programas:'));
    assert.strictEqual(conf.length, 11, lineas.join('\n'));
    assert.ok(conf.includes(`Configuración de la máquina que corre programas: credential.https://github.com.helper=${gh} (global)`), conf.join('\n'));
    assert.ok(lineas.every((l) => l.length <= 600));
  } finally {
    fs.writeFileSync(GLOBAL, '');
  }
});

// La decisión 7 bis (9/11): la configuración global y la del sistema se muestran y entran en la huella; no se niegan.
test('T5b ConfiguracionDeLaMaquina_SeMuestraYEntraEnLaHuella @story-8.236 @ac-5', () => {
  const e = escenario('t5b');
  try {
    fs.writeFileSync(GLOBAL, '[core]\n\tpager = less\n[credential]\n\thelper = osxkeychain\n');
    const d = e.decidir('git commit -m constancia');
    assert.match(d.texto, /adhoc allow-foreign-save/, 'se ofrece el click');
    const p = leerCarril(e.state, e.sid).guardadoAjeno;
    assert.deepStrictEqual(p.configuracion.map((c) => [c.clave.toLowerCase(), c.alcance]), [['core.pager', 'global'], ['credential.helper', 'global']]);
    assert.match(fa.lineasDe(p).join('\n'), /Configuración de la máquina que corre programas: core\.pager=less \(global\)\nConfiguración de la máquina que corre programas: credential\.helper=osxkeychain \(global\)/);
    // con el permiso, otra configuración global cambia la huella y vuelve a frenar
    assert.strictEqual(permitir(e, { via: 'click' }).status, 0);
    fs.writeFileSync(GLOBAL, '[core]\n\tpager = more\n[credential]\n\thelper = osxkeychain\n');
    assert.match(e.decidir('git commit -m constancia').texto, /adhoc allow-foreign-save/);

    // la carpeta de hooks de la máquina (la que instala el arnés): se muestra, y su contenido entra en la huella
    const hooks = tmp('hooks-maquina-');
    escribir(hooks, 'pre-commit', '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(hooks, 'pre-commit'), 0o755);
    fs.writeFileSync(GLOBAL, `[core]\n\thooksPath = ${hooks}\n`);
    e.reiniciar();
    assert.match(e.decidir('git commit -m constancia').texto, /adhoc allow-foreign-save/, 'se ofrece el click');
    assert.match(fa.lineasDe(leerCarril(e.state, e.sid).guardadoAjeno).join('\n'), new RegExp(`Hooks que corren al guardar: pre-commit \\(de ${hooks.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, de la configuración de la máquina\\)`));
    assert.strictEqual(permitir(e, { via: 'click' }).status, 0);
    escribir(hooks, 'pre-commit', '#!/bin/sh\necho otro\nexit 0\n');
    assert.match(e.decidir('git commit -m constancia').texto, /adhoc allow-foreign-save/, 'otro hook, otra huella: frena');
    assert.ok(permiso(e), 'el permiso viejo no se gastó');
  } finally { fs.writeFileSync(GLOBAL, ''); }
});

test('T6 ComandosDescartados_NingunoPasaSinClick @story-8.236 @ac-6', () => {
  const e = escenario('t6');
  const remotoDelCarril = () => git(path.join(e.raiz, 'producto-origen.git'), 'for-each-ref', '--format=%(refname) %(objectname)');
  const antes = remotoDelCarril();
  frenaComoHoy(e, 'git -c core.fsmonitor=./x commit -m x', { motivo: /-c core\.fsmonitor/ });
  frenaComoHoy(e, 'git -c core.hooksPath=/tmp/h commit -m x', { motivo: /-c core\.hooksPath/ });
  frenaComoHoy(e, 'git push --upload-pack=./x origin main', { motivo: /--upload-pack/ });
  escribir(e.ajeno, '.git/hooks/post-commit', '#!/bin/sh\nexit 0\n');
  frenaComoHoy(e, 'git commit -m x', { motivo: /hook que no es del repo/ });
  fs.rmSync(path.join(e.ajeno, '.git/hooks/post-commit'));
  git(e.ajeno, 'config', 'core.fsmonitor', './x');
  frenaComoHoy(e, 'git commit -m x', { motivo: /core\.fsmonitor .*del repo/ });
  git(e.ajeno, 'config', '--unset', 'core.fsmonitor');
  // el push de FETCH_HEAD a la URL del carril, también disfrazado con insteadOf
  git(e.ajeno, 'remote', 'add', 'carril', path.join(e.raiz, 'producto-origen.git'));
  frenaComoHoy(e, 'git push carril FETCH_HEAD:refs/heads/main', { motivo: /URL de un remoto del carril/ });
  git(e.ajeno, 'config', 'url.' + path.join(e.raiz, 'producto') + '-.insteadOf', 'disfraz:');
  git(e.ajeno, 'remote', 'add', 'disfraz', 'disfraz:origen.git');
  frenaComoHoy(e, 'git push disfraz FETCH_HEAD:refs/heads/main', { motivo: /URL de un remoto del carril/ });
  // el subtree push encadenado: según la versión de git, no se lee o no es un commit ni un push; en los dos, sin click
  frenaComoHoy(e, 'git commit -m x && git -C ../producto subtree push --prefix=db origin main');
  assert.strictEqual(remotoDelCarril(), antes, 'la rama del carril no se empuja');
});

// ── T7 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T7 ConConstanciasOSinMarca_PasaComoHoy @story-8.236 @ac-7', () => {
  const e = escenario('t7');
  const a = leerCarril(e.state, e.sid);
  const huella = adhocBase.huellaDelCarril(a);
  escribirCarril(e.state, e.sid, { ...a, revisores: { huella }, pase: { huella } });
  const d = e.decidir('git commit -m constancia');
  assert.ok(!d || !d.texto, JSON.stringify(d));
  assert.strictEqual(leerCarril(e.state, e.sid).guardadoAjeno, undefined);
  const s = escenario('t7b', { marca: false });
  const d2 = s.decidir('git commit -m constancia');
  assert.ok(!d2 || !d2.texto, JSON.stringify(d2));
  assert.strictEqual(leerCarril(s.state, s.sid).guardadoAjeno, undefined);
});

// ── T8 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T8 ChequeoEnSeco_NoTraeLaBase @story-8.236 @ac-8', (t) => {
  if (process.platform === 'win32') { t.skip('el git de prueba es un guion de sh'); return; }
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = tmp('gitlog-');
  const log = path.join(bin, 'llamados.log');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "$PWD $*" >> '${log}'\nexec '${real}' "$@"\n`);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  const e = escenario('t8');
  const a0 = leerCarril(e.state, e.sid);
  const huella = adhocBase.huellaDelCarril(a0);
  escribirCarril(e.state, e.sid, { ...a0, revisores: { huella }, pase: { huella } });
  const otro = repoConOrigen(e.raiz, 'otro');
  escribir(otro, 'db/migrations/002.sql', 'select 2;\n');
  // en un proceso aparte: el git de la medida guarda su ambiente la primera vez, y el de este proceso ya está guardado
  const L = path.join(SCRIPTS, 'lib');
  const enOtroProceso = (cuerpo) => {
    fs.writeFileSync(log, '');
    const r = spawnSync(process.execPath, ['-e', `const sb = require(${JSON.stringify(path.join(L, 'save-brake.js'))});
      const ab = require(${JSON.stringify(path.join(L, 'adhoc-base.js'))}); const fs = require('fs');
      const a = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(e.state, 'adhoc', `${e.sid}.json`))}, 'utf8'));
      ${cuerpo}`], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
    assert.strictEqual(r.status, 0, r.stderr);
    return { salida: JSON.parse(r.stdout), log: fs.readFileSync(log, 'utf8').split('\n').filter((l) => / fetch( |$)/.test(l)) };
  };
  const seco = enOtroProceso(`const m = ab.medirLoPropio(a, { repos: [${JSON.stringify(e.prod)}, ${JSON.stringify(otro)}] });
    process.stdout.write(JSON.stringify(sb.frenoDelRiesgo(a, ${JSON.stringify(e.sid)}, ${JSON.stringify(e.home)}, [${JSON.stringify(otro)}], { medida: m, registrar: false })));`);
  assert.deepStrictEqual(seco.salida, { frenaria: true });
  assert.ok(!fs.existsSync(path.join(otro, '.git', 'FETCH_HEAD')), 'sin FETCH_HEAD en el repo ajeno');
  assert.strictEqual(seco.log.length, 0, `en seco no hay fetch: ${seco.log.join('\n')}`);

  const vuelta = enOtroProceso(`process.stdout.write(JSON.stringify(sb.decidir({ command: ${JSON.stringify(`git -C ${otro} add -A && git -C ${otro} commit -m y`)},
    cwd: ${JSON.stringify(e.prod)}, sid: ${JSON.stringify(e.sid)}, home: ${JSON.stringify(e.home)} })));`);
  assert.match(vuelta.salida.texto, /faltan los revisores/);
  const delOtro = vuelta.log.filter((l) => l.includes(otro));
  assert.strictEqual(delOtro.length, 1, delOtro.join('\n'));
  assert.ok(Object.keys(leerCarril(e.state, e.sid).bases).includes(otro), 'las constancias vencen: el repo entra con su base');
});

// ── T9 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T9 GuardadoAjeno_DosPerfiles @story-8.236 @ac-9', () => {
  const pedido = { comando: 'git commit -m x', repo: '/r/ajeno', rama: 'main', huella: 'h', guarda: [{ tipo: 'commit', archivos: ['a.md'], todos: false }], hooks: [], configuracion: [] };
  const base = { motivoDelCarril: 'el botón', archivo: '/r/db/001.sql', regla: 'porton-instalador-migracion', pedido, marker: 'marker.js' };
  const producto = fa.textoDelPedido({ ...base, harness: false });
  const arnes = fa.textoDelPedido({ ...base, harness: true });
  assert.match(producto, /\bvos\b/);
  for (const w of [/dueño/i, /coordinadora/i, /delegaci/i, /constancia/i]) assert.doesNotMatch(producto, w);
  // quien firma es «una persona», como todo mensaje que lee el agente (approver.test.js T7)
  assert.match(arnes, /una persona/);
  assert.doesNotMatch(arnes, /dueño/);
  assert.match(arnes, /coordinadora/);
  assert.match(arnes, /delegación/);
  assert.match(arnes, /constancias/);
  for (const t of [producto, arnes]) assert.match(t, /adhoc allow-foreign-save/);
  // el cuadro no nombra las piezas de la capa de mantenimiento
  const s = firmas.SIGNATURES.find((x) => x.id === 'adhoc-lane:guardado-ajeno');
  for (const texto of [...fa.lineasDe(pedido), s.approves, ...s.descripciones]) {
    for (const w of [/dueño/i, /coordinadora/i, /delegaci/i, /constancia/i]) assert.doesNotMatch(texto, w, texto);
  }
});
