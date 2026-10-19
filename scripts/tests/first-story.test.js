'use strict';
/**
 * first-story.test.js — el lector de «¿es la primera historia de esta máquina?» y la oferta de la instalación completa
 * al cerrar la primera historia.
 *
 * Lo que no se puede perder:
 *   T1/T2 · `closedStories` cuenta sólo las corridas terminadas del historial; una carpeta ilegible es «no medido».
 *   T3-T6 · `isFirstStory` dice «primera» sólo con evidencia de instalación nueva, sin corridas cerradas y sin registro de
 *           un cierre anterior: una máquina vieja sin volcados, un historial podado o una instalación no fresca son
 *           «no medido», nunca «primera».
 *   T8 · `marker.js clear` de la primera corrida cerrada de una máquina nueva con la mínima imprime la oferta una vez.
 *   T10/T11 · `offer accept` corre la instalación completa del árbol; `offer decline` lo anota; ninguno corre dos veces.
 *   T12 · nunca dos veces: segundo cierre, completa elegida, perfil sin elegir, oferta ya anotada.
 *   T13 · sin persona (sesión no atendida o integración continua) no pregunta: un renglón con la orden.
 *   T14 · un error en la oferta no rompe el cierre.
 *   T15/T16 · el paso «preparar el commit» dice qué hacer, y el contrato del lector para la corrida de primera vez está escrito.
 *
 * Nada toca el HOME real: cada caso arma su HOME de juguete; `lib/real-home-guard.js` lo mide y el último caso lo exige.
 *
 * stable-data: el reloj se lee sólo para barreras de arranque simultáneo, cronómetros de plazos (el candado espera 5 s)
 * y un candado envejecido a propósito; ningún resultado depende de la fecha.
 */
const GUARD = require('./lib/real-home-guard.js');   // primera línea que hace algo
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const LIB = path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'first-story.js');
const MARKER = path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'marker.js');
const FS = require(LIB);
const Q = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'questions.js'));
const EFFECTS = require(path.join(RAIZ, 'scripts', 'setup', 'install-effects.json')).effects;

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-first-story-'));
require('./lib/lab-guard.js').labGuard(BASE, 'first-story');
process.on('exit', () => fs.rmSync(BASE, { recursive: true, force: true }));

let n = 0;
/** Un HOME de juguete con la carpeta del estado; `fresh` arma el estado con first_install; `profile` el tycon.json. */
function casa({ fresh = true, profile = 'minimal', firstInstall } = {}) {
  const home = path.join(BASE, `h${++n}`);
  const dir = path.join(home, '.claude', '.tycon-pipeline');
  fs.mkdirSync(dir, { recursive: true });
  const fi = firstInstall !== undefined ? firstInstall : (fresh === null ? undefined : { at: '2026-10-18T20:00:00.000Z', version: '2026.10.18.50', fresh });
  const state = { schema: 1, mode: 'managed', tree: RAIZ };
  if (fi !== undefined) state.first_install = fi;
  fs.writeFileSync(path.join(dir, 'harness-state.json'), JSON.stringify(state));
  if (profile) fs.writeFileSync(path.join(home, '.claude', 'tycon.json'), JSON.stringify({ install: { profile } }));
  return home;
}
const dirOf = (home) => path.join(home, '.claude', '.tycon-pipeline');
const record = (home) => { try { return JSON.parse(fs.readFileSync(path.join(dirOf(home), 'first-story.json'), 'utf8')); } catch { return null; } };
/** Un volcado del historial: cerrada (sin pasos pendientes), abandonada, o sin story (un ad-hoc). */
function volcado(home, nombre, marker) {
  const d = path.join(dirOf(home), 'timing-history');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${nombre}.json`), typeof marker === 'string' ? marker : JSON.stringify({ archivedAt: '2026-10-18T21:00:00Z', marker }));
}
const CERRADA = (id = '1.1') => ({ storyId: id, stepsPending: [], stepsCompleted: [0, 1, 2, 3, 4, 5, 6, 7, 8] });
/** El ambiente de una persona delante: sin nada de la sesión real ni de integración continua. */
const ENV = (home, extra = {}) => Object.assign({ PATH: process.env.PATH, HOME: home, TMPDIR: path.join(BASE, 'tmp'), TYCON_PROFILE: '0' }, extra);
fs.mkdirSync(path.join(BASE, 'tmp'), { recursive: true });

/** Corre `marker.js clear` con un marcador activo de juguete en el HOME dado. */
function clear(home, { marker = CERRADA('9.9'), env = {} } = {}) {
  const sid = `sid-${n}-${Math.random().toString(36).slice(2, 8)}`;
  const act = path.join(dirOf(home), 'active');
  fs.mkdirSync(act, { recursive: true });
  fs.writeFileSync(path.join(act, `${sid}.json`), JSON.stringify(Object.assign({ sessionId: sid, startedAt: '2026-10-18T20:10:00Z' }, marker)));
  const r = spawnSync(process.execPath, [MARKER, 'clear'], {
    encoding: 'utf8', timeout: 60000,
    env: ENV(home, Object.assign({ CLAUDE_CODE_SESSION_ID: sid, TYCON_NO_THREAD_RESCUE: '1' }, env)),
  });
  return { rc: r.status, out: r.stdout || '', err: r.stderr || '', markerLeft: fs.existsSync(path.join(act, `${sid}.json`)) };
}

// ─── el lector ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('8.54 T1 ClosedStories_CuentaSoloCerradas · una cerrada cuenta; abandonada y sin story no; un ilegible es «no medido»', () => {
  const home = casa();
  volcado(home, '1.1-a', CERRADA('1.1'));
  volcado(home, '1.2-b', { storyId: '1.2', stepsPending: [5, 6, 7, 8], stepsCompleted: [0, 1, 2, 3, 4] });
  volcado(home, 'adhoc-c', { stepsPending: [], stepsCompleted: [0] });
  fs.writeFileSync(path.join(dirOf(home), 'timing-history', '1.1-a.hilo.jsonl.gz'), 'x');   // los compañeros no son volcados
  const r = FS.closedStories({ home, env: ENV(home) });
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.count, 1, JSON.stringify(r));
  // un volcado ilegible puede ser el de una historia cerrada: la cuenta no se sabe, y se nombra
  volcado(home, '1.3-d', '{roto');
  const i = FS.closedStories({ home, env: ENV(home) });
  assert.strictEqual(i.status, 'no_medido', JSON.stringify(i));
  assert.match(i.reason || '', /1\.3-d/, 'el volcado ilegible no se nombra');
  // y entonces nadie decide «primera»
  const h2 = casa();
  volcado(h2, '1.3-d', '{roto');
  assert.deepStrictEqual([FS.isFirstStory({ home: h2, env: ENV(h2) }).status, FS.isFirstStory({ home: h2, env: ENV(h2) }).first], ['no_medido', false]);
  // sin carpeta: cero, medido
  const vacia = casa();
  assert.deepStrictEqual([FS.closedStories({ home: vacia, env: ENV(vacia) }).status, FS.closedStories({ home: vacia, env: ENV(vacia) }).count], ['ok', 0]);
});

test('8.54 T2 ClosedStories_CarpetaIlegible · una carpeta que no se puede leer es «no medido»', () => {
  const home = casa();
  // un archivo en el lugar de la carpeta: ilegible en cualquier sistema (y sin depender de los permisos)
  fs.writeFileSync(path.join(dirOf(home), 'timing-history'), 'no soy una carpeta');
  const r = FS.closedStories({ home, env: ENV(home) });
  assert.strictEqual(r.status, 'no_medido', JSON.stringify(r));
  assert.ok(r.reason);
});

test('8.54 T3 First_MaquinaNueva · instalación fresca, sin volcados, sin registro: primera', () => {
  const home = casa();
  const r = FS.isFirstStory({ home, env: ENV(home) });
  assert.deepStrictEqual([r.status, r.first, r.count], ['ok', true, 0], JSON.stringify(r));
  // con una corrida cerrada ya no es la primera
  volcado(home, '1.1-a', CERRADA());
  const s = FS.isFirstStory({ home, env: ENV(home) });
  assert.deepStrictEqual([s.status, s.first, s.count], ['ok', false, 1]);
});

test('8.54 T4 First_MaquinaViejaSinVolcados · sin first_install (instalada antes de esta versión): no medido, nunca primera', () => {
  const home = casa({ fresh: null });
  const r = FS.isFirstStory({ home, env: ENV(home) });
  assert.strictEqual(r.status, 'no_medido', JSON.stringify(r));
  assert.strictEqual(r.first, false);
  assert.match(r.reason, /instalación anterior/);
  // y un estado que no se puede leer, tampoco
  const rota = casa();
  fs.writeFileSync(path.join(dirOf(rota), 'harness-state.json'), '{roto');
  assert.strictEqual(FS.isFirstStory({ home: rota, env: ENV(rota) }).status, 'no_medido');
});

test('8.54 T5 First_HistorialPodado · registro de un cierre y cero volcados: no medido', () => {
  const home = casa();
  fs.writeFileSync(path.join(dirOf(home), 'first-story.json'), JSON.stringify({ first_close: { at: '2026-10-18T21:00:00Z', story: '1.1' } }));
  const r = FS.isFirstStory({ home, env: ENV(home) });
  assert.strictEqual(r.status, 'no_medido', JSON.stringify(r));
  assert.match(r.reason, /podado/);
});

test('8.54 T6 First_NoFresca · first_install con fresh: false (había rastros de uso al instalar): no medido', () => {
  const home = casa({ fresh: false });
  const r = FS.isFirstStory({ home, env: ENV(home) });
  assert.strictEqual(r.status, 'no_medido', JSON.stringify(r));
  assert.strictEqual(r.first, false);
});

// ─── la oferta ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('8.54 T8 Oferta_PrimerCierre · el clear de la primera corrida cerrada imprime la oferta y la anota', () => {
  const home = casa();
  const r = clear(home);
  assert.strictEqual(r.rc, 0, r.err);
  assert.strictEqual(r.markerLeft, false, 'el marcador quedó');
  const tres = Q.upgradeOffer({ effects: EFFECTS, tree: RAIZ, home });
  assert.match(r.out, /primera historia/);
  assert.match(r.out, /instalación completa/);
  for (const l of tres) assert.ok(r.out.includes(l), `falta el renglón «${l}» en:\n${r.out}`);
  assert.match(r.out, /offer accept/);
  assert.match(r.out, /offer decline/);
  // en Windows la orden para volver lleva la ruta entera entre comillas; en Mac y Linux, la de la carpeta personal
  assert.strictEqual(FS.shownHarnessFor('C:\\h\\arnes', 'win32'), `"${path.join('C:\\h\\arnes', 'scripts', 'setup', 'harness.js')}"`);
  assert.strictEqual(FS.shownHarnessFor('/h/arnes', 'darwin'), null);
  assert.strictEqual(FS.shownHarnessFor('/h/arnes', 'linux'), null);
  const rec = record(home);
  assert.strictEqual(rec && rec.offer && rec.offer.status, 'offered', JSON.stringify(rec));
  assert.strictEqual(rec.first_close.story, '9.9');
  // el volcado se archivó como siempre
  assert.strictEqual(fs.readdirSync(path.join(dirOf(home), 'timing-history')).filter((f) => /^9\.9-.*\.json$/.test(f)).length, 1);
});

test('8.62 Oferta_RecortadaSeVuelveAVer @story-8.62 @ac-10 · si el cierre se leyó recortado, offer show la muestra entera', () => {
  // medido: el agente leyó la salida del cierre con «| tail -2» y la oferta se perdió
  const home = casa();
  const r = clear(home);
  assert.strictEqual(r.rc, 0, r.err);
  const ultimo = r.out.trim().split('\n').pop();
  assert.match(ultimo, /offer show/, `el último renglón dice cómo verla entera:\n${ultimo}`);
  const s = spawnSync(process.execPath, [LIB, 'offer', 'show'], { encoding: 'utf8', env: ENV(home), timeout: 30000 });
  assert.strictEqual(s.status, 0, s.stderr);
  for (const l of Q.upgradeOffer({ effects: EFFECTS, tree: RAIZ, home })) assert.ok(s.stdout.includes(l), `falta «${l}» en:\n${s.stdout}`);
  assert.match(s.stdout, /offer accept/);
  assert.strictEqual(record(home).offer.status, 'offered', 'mostrarla otra vez no la contesta');
  // contestada, ya no hay oferta que mostrar
  spawnSync(process.execPath, [LIB, 'offer', 'decline'], { encoding: 'utf8', env: ENV(home), timeout: 30000 });
  const otra = spawnSync(process.execPath, [LIB, 'offer', 'show'], { encoding: 'utf8', env: ENV(home), timeout: 30000 });
  assert.strictEqual(otra.status, 2, otra.stdout);
  assert.match(otra.stderr, /no hay una oferta pendiente/);
});

test('8.54 T10 Accept_CorreLaCompleta · corre install --profile full --yes del árbol; si sale distinto de 0, failed', () => {
  const toy = path.join(BASE, 'toy-harness.js');
  fs.writeFileSync(toy, "require('fs').writeFileSync(process.env.TOY_ARGS, JSON.stringify(process.argv.slice(2))); process.exit(Number(process.env.TOY_RC || 0));\n");
  const home = casa();
  fs.writeFileSync(path.join(dirOf(home), 'first-story.json'), JSON.stringify({ first_close: { at: 'x', story: '1.1' }, offer: { status: 'offered', at: 'x', story: '1.1' } }));
  const args = path.join(BASE, 'args-ok.json');
  const a = FS.accept({ home, env: ENV(home, { TOY_ARGS: args }), harnessJs: toy, stdio: 'pipe' });
  assert.strictEqual(a.code, 0, a.lines.join('\n'));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(args, 'utf8')), ['install', '--profile', 'full', '--yes']);
  assert.strictEqual(record(home).offer.status, 'accepted');
  // la instalación que falla queda anotada con su código y se dice
  const h2 = casa();
  fs.writeFileSync(path.join(dirOf(h2), 'first-story.json'), JSON.stringify({ offer: { status: 'offered', at: 'x', story: '1.1' } }));
  const b = FS.accept({ home: h2, env: ENV(h2, { TOY_ARGS: path.join(BASE, 'args-3.json'), TOY_RC: '3' }), harnessJs: toy, stdio: 'pipe' });
  assert.strictEqual(b.code, 3);
  assert.match(b.lines.join('\n'), /3/);
  assert.deepStrictEqual([record(h2).offer.status, record(h2).offer.code], ['failed', 3]);
  // por la línea de comandos: sin oferta pendiente, accept sale 2 sin correr nada; status muestra el lector y el registro
  const h3 = casa();
  const c = spawnSync(process.execPath, [LIB, 'offer', 'accept'], { encoding: 'utf8', env: ENV(h3), timeout: 30000 });
  assert.strictEqual(c.status, 2, c.stdout + c.stderr);
  assert.match(c.stderr, /no hay una oferta pendiente/);
  const st = spawnSync(process.execPath, [LIB, 'offer', 'status'], { encoding: 'utf8', env: ENV(h3), timeout: 30000 });
  assert.strictEqual(st.status, 0, st.stderr);
  const js = JSON.parse(st.stdout);
  assert.deepStrictEqual([js.isFirstStory.status, js.isFirstStory.first], ['ok', true]);
  assert.deepStrictEqual(js.record, {});
  const u = spawnSync(process.execPath, [LIB, 'otra-cosa'], { encoding: 'utf8', env: ENV(h3), timeout: 30000 });
  assert.strictEqual(u.status, 2);
  // si la respuesta no se puede anotar, se dice y el resultado se mantiene (posix: una carpeta sin permiso de escritura)
  if (process.platform !== 'win32' && process.getuid && process.getuid() !== 0) {
    const h4 = casa();
    fs.writeFileSync(path.join(dirOf(h4), 'first-story.json'), JSON.stringify({ offer: { status: 'offered', at: 'x', story: '1.1' } }));
    fs.chmodSync(dirOf(h4), 0o500);
    try {
      const d = FS.decline({ home: h4, env: ENV(h4) });
      assert.strictEqual(d.code, 0);
      assert.match(d.lines.join('\n'), /no pude anotar la respuesta/);
    } finally { fs.chmodSync(dirOf(h4), 0o755); }
  }
});

test('8.54 T11 Decline_Anotado · decline lo anota; después accept no corre nada y lo dice', () => {
  const home = casa();
  fs.writeFileSync(path.join(dirOf(home), 'first-story.json'), JSON.stringify({ offer: { status: 'offered', at: 'x', story: '1.1' } }));
  const d = spawnSync(process.execPath, [LIB, 'offer', 'decline'], { encoding: 'utf8', env: ENV(home), timeout: 30000 });
  assert.strictEqual(d.status, 0, d.stderr);
  assert.match(d.stdout, /install --profile full/, 'no dice cómo pedirla después');
  assert.strictEqual(record(home).offer.status, 'declined');
  const toyArgs = path.join(BASE, 'args-no.json');
  const a = FS.accept({ home, env: ENV(home, { TOY_ARGS: toyArgs }), harnessJs: path.join(BASE, 'toy-harness.js'), stdio: 'pipe' });
  assert.notStrictEqual(a.code, 0);
  assert.match(a.lines.join('\n'), /no hay una oferta pendiente/);
  assert.strictEqual(fs.existsSync(toyArgs), false, 'accept corrió la instalación sin oferta pendiente');
  assert.strictEqual(record(home).offer.status, 'declined');
});

test('8.54 T12 NuncaDosVeces · segundo cierre, completa elegida, perfil sin elegir y oferta ya anotada: nada', () => {
  const casos = [];
  const segundo = casa(); volcado(segundo, '1.1-a', CERRADA());
  fs.writeFileSync(path.join(dirOf(segundo), 'first-story.json'), JSON.stringify({ first_close: { at: 'x', story: '1.1' } }));
  casos.push(['segundo cierre', segundo]);
  casos.push(['completa elegida', casa({ profile: 'full' })]);
  casos.push(['perfil sin elegir', casa({ profile: null })]);
  const anotada = casa();
  fs.writeFileSync(path.join(dirOf(anotada), 'first-story.json'), JSON.stringify({ offer: { status: 'declined', at: 'x', story: '0.1' } }));
  casos.push(['oferta anotada', anotada]);
  for (const [nombre, home] of casos) {
    volcado(home, '9.9-z', CERRADA('9.9'));   // el volcado de este cierre (afterClose corre después de escribirlo)
    const r = FS.afterClose({ home, env: ENV(home), marker: CERRADA('9.9') });
    assert.deepStrictEqual(r.lines, [], `${nombre}: imprimió ${JSON.stringify(r.lines)}`);
    if (nombre !== 'oferta anotada') assert.ok(record(home).first_close, `${nombre}: el cierre no quedó anotado`);
  }
  // y con el clear de verdad, el segundo cierre de una máquina que ya vio la oferta no imprime nada
  const home = casa();
  assert.match(clear(home).out, /offer accept/);
  const otra = clear(home, { marker: CERRADA('9.10') });
  assert.strictEqual(otra.rc, 0);
  assert.doesNotMatch(otra.out, /offer accept|instalación completa/);
});

test('8.54 T13 SinPersona · no atendida, sdk o integración continua: un renglón con la orden y no_person; el modo autónomo sí ofrece', () => {
  for (const extra of [{ CLAUDE_CODE_SESSION_ATTENDED: '0' }, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, { CI: '1' }, { TF_BUILD: 'True' }, { GITHUB_ACTIONS: 'true' }]) {
    const home = casa();
    volcado(home, '9.9-z', CERRADA('9.9'));
    const r = FS.afterClose({ home, env: ENV(home, extra), marker: CERRADA('9.9') });
    assert.strictEqual(r.lines.length, 1, `${JSON.stringify(extra)}: ${JSON.stringify(r.lines)}`);
    assert.match(r.lines[0], /install --profile full --yes/);
    assert.doesNotMatch(r.lines[0], /offer accept/);
    assert.strictEqual(record(home).offer.status, 'no_person');
  }
  // el modo autónomo del pipeline viene prendido con una persona delante: ofrece, también por el clear de verdad
  const viaClear = clear(casa(), { marker: Object.assign(CERRADA('9.9'), { autonomous: true }), env: { CLAUDE_CODE_SESSION_ATTENDED: '1' } });
  assert.match(viaClear.out, /offer accept/, viaClear.out + viaClear.err);
  const sinPersona = clear(casa(), { env: { CLAUDE_CODE_SESSION_ATTENDED: '0' } });
  assert.match(sinPersona.out, /install --profile full --yes/);
  assert.doesNotMatch(sinPersona.out, /offer accept/);
  const home = casa();
  volcado(home, '9.9-z', CERRADA('9.9'));
  const r = FS.afterClose({ home, env: ENV(home, { CLAUDE_CODE_SESSION_ATTENDED: '1' }), marker: Object.assign(CERRADA('9.9'), { autonomous: true }) });
  assert.ok(r.lines.some((l) => /offer accept/.test(l)), JSON.stringify(r.lines));
});

test('8.54 T14 ClearNoSeRompe · registro ilegible o lista de efectos rota: el cierre sigue y lo dice en un renglón', () => {
  const home = casa();
  fs.writeFileSync(path.join(dirOf(home), 'first-story.json'), '{roto');
  const r = clear(home);
  assert.strictEqual(r.rc, 0, r.err);
  assert.strictEqual(r.markerLeft, false, 'el marcador quedó');
  assert.match(r.err, /oferta/);
  assert.doesNotMatch(r.out, /offer accept/);
  assert.strictEqual(fs.readdirSync(path.join(dirOf(home), 'timing-history')).filter((f) => /^9\.9-.*\.json$/.test(f)).length, 1);
  // con la lista de efectos rota no hay oferta y no se anota como ofrecida
  // un árbol con los mismos módulos y la lista de efectos rota
  const tree = path.join(BASE, 'arbol-roto');
  for (const d of [['scripts', 'setup', 'harness'], ['scripts', 'lib']]) fs.cpSync(path.join(RAIZ, ...d), path.join(tree, ...d), { recursive: true });
  fs.writeFileSync(path.join(tree, 'scripts', 'setup', 'install-effects.json'), '{roto');
  const h2 = casa();
  volcado(h2, '9.9-z', CERRADA('9.9'));
  const a = FS.afterClose({ home: h2, env: ENV(h2), marker: CERRADA('9.9'), tree });
  assert.deepStrictEqual(a.lines, []);
  assert.match(a.warn || '', /lista de efectos/);
  assert.doesNotMatch(a.warn || '', /Unexpected|not valid JSON|position/, `repite el motivo del parser: ${a.warn}`);
  assert.strictEqual((record(h2) || {}).offer, undefined, 'se anotó como ofrecida sin haberla mostrado');
  // un volcado ilegible en una máquina nueva: no hay oferta y se dice por qué; en una máquina vieja, silencio (si no,
  // el aviso saldría en cada cierre)
  const h3 = casa();
  volcado(h3, '9.9-z', CERRADA('9.9'));
  volcado(h3, '1.0-roto', '{roto «un pedazo del texto»');
  const b3 = FS.afterClose({ home: h3, env: ENV(h3), marker: CERRADA('9.9') });
  assert.deepStrictEqual(b3.lines, []);
  assert.match(b3.warn || '', /1\.0-roto/);
  assert.doesNotMatch(b3.warn || '', /pedazo/);
  // una máquina nueva que ya anotó su primer cierre también calla (la oferta ya no podía salir)
  const h3b = casa();
  fs.writeFileSync(path.join(dirOf(h3b), 'first-story.json'), JSON.stringify({ first_close: { at: 'x', story: '1.1' } }));
  volcado(h3b, '1.0-roto', '{roto');
  assert.deepStrictEqual(FS.afterClose({ home: h3b, env: ENV(h3b), marker: CERRADA('9.9') }), { lines: [], warn: null });
  const h4 = casa({ fresh: null });
  volcado(h4, '1.0-roto', '{roto');
  assert.deepStrictEqual(FS.afterClose({ home: h4, env: ENV(h4), marker: CERRADA('9.9') }), { lines: [], warn: null });
  // un perfil que no se puede leer: no hay oferta y se dice, sin repetir el contenido de la configuración
  const h6 = casa();
  fs.writeFileSync(path.join(h6, '.claude', 'tycon.json'), '{"install": «secreto» ');
  volcado(h6, '9.9-z', CERRADA('9.9'));
  const b6 = FS.afterClose({ home: h6, env: ENV(h6), marker: CERRADA('9.9') });
  assert.deepStrictEqual(b6.lines, []);
  assert.match(b6.warn || '', /perfil de instalación/);
  assert.doesNotMatch(b6.warn || '', /secreto/);
  // el motivo de un JSON roto nombra el archivo, nunca repite su contenido
  const h5 = casa();
  fs.writeFileSync(path.join(dirOf(h5), 'first-story.json'), '{"clave": «un pedazo del texto» ');
  fs.writeFileSync(path.join(dirOf(h5), 'harness-state.json'), '{"tree": «otro pedazo» ');
  const textos = [FS.isFirstStory({ home: h5, env: ENV(h5) }).reason, FS.afterClose({ home: h5, env: ENV(h5), marker: CERRADA('9.9') }).warn,
    FS.accept({ home: h5, env: ENV(h5), harnessJs: path.join(BASE, 'toy-harness.js'), stdio: 'pipe' }).lines.join(' ')];
  for (const t of textos) {
    assert.match(t || '', /no es JSON válido/, `sin el motivo: ${t}`);
    assert.doesNotMatch(t || '', /pedazo/, `repite el contenido del archivo: ${t}`);
  }
});

test('8.54 T19 Concurrentes_UnaSolaOferta · ocho cierres a la vez, con todos los volcados ya archivados: una sola oferta', async () => {
  const home = casa();
  for (let i = 0; i < 8; i++) volcado(home, `9.${i}-z`, CERRADA(`9.${i}`));
  const startAt = Date.now() + 1500;
  const code = `const FS = require(${JSON.stringify(LIB)}); while (Date.now() < ${startAt}) {}
    const r = FS.afterClose({ home: process.env.HOME, env: process.env, marker: { storyId: process.argv[1] } });
    process.stdout.write(JSON.stringify(r));`;
  const runs = await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((resolve) => {
    const ch = require('child_process').spawn(process.execPath, ['-e', code, `9.${i}`], { env: ENV(home) });
    let out = ''; ch.stdout.on('data', (d) => { out += d; }); ch.on('close', (rc) => resolve({ rc, out }));
  })));
  const results = runs.map((r) => { try { return JSON.parse(r.out); } catch (_) { return { lines: [], warn: `sin JSON: ${r.out}` }; } });
  const offers = results.filter((r) => r.lines.some((l) => /offer accept/.test(l))).length;
  assert.strictEqual(offers, 1, `ofertas: ${offers}\n${JSON.stringify(results)}`);
  assert.strictEqual(record(home).offer.status, 'offered');
  assert.strictEqual(fs.existsSync(path.join(dirOf(home), 'first-story.lock')), false, 'quedó el candado');
  // un candado de un proceso que murió (más de 30 s) se pisa; uno vivo hace esperar y, a los 5 s, no se decide y se dice
  const vieja = casa();
  volcado(vieja, '9.9-z', CERRADA('9.9'));
  const lock = path.join(dirOf(vieja), 'first-story.lock');
  fs.writeFileSync(lock, 'de otro');
  const hace = new Date(Date.now() - 60 * 1000);
  fs.utimesSync(lock, hace, hace);
  assert.ok(FS.afterClose({ home: vieja, env: ENV(vieja), marker: CERRADA('9.9') }).lines.some((l) => /offer accept/.test(l)), 'el candado viejo no se pisó');
  assert.strictEqual(fs.existsSync(lock), false);
  // ocho cierres a la vez que ven viejo el mismo candado: igual sale una sola oferta
  const carrera = casa();
  for (let i = 0; i < 8; i++) volcado(carrera, `9.${i}-z`, CERRADA(`9.${i}`));
  const lock3 = path.join(dirOf(carrera), 'first-story.lock');
  fs.writeFileSync(lock3, 'de uno que murió');
  fs.utimesSync(lock3, hace, hace);
  const startAt2 = Date.now() + 1500;
  const code2 = `const FS = require(${JSON.stringify(LIB)}); while (Date.now() < ${startAt2}) {}
    process.stdout.write(JSON.stringify(FS.afterClose({ home: process.env.HOME, env: process.env, marker: { storyId: process.argv[1] } })));`;
  const runs2 = await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((resolve) => {
    const ch = require('child_process').spawn(process.execPath, ['-e', code2, `9.${i}`], { env: ENV(carrera) });
    let out = ''; ch.stdout.on('data', (d) => { out += d; }); ch.on('close', () => resolve(out));
  })));
  const offers2 = runs2.map((o) => { try { return JSON.parse(o); } catch (_) { return { lines: [] }; } }).filter((r) => r.lines.some((l) => /offer accept/.test(l))).length;
  assert.strictEqual(offers2, 1, `con un candado viejo, ofertas: ${offers2}`);
  // un candado que no se puede leer (una carpeta en su lugar) no hace girar el cierre: a los 5 s no decide y lo dice
  const rara = casa();
  volcado(rara, '9.9-z', CERRADA('9.9'));
  fs.mkdirSync(path.join(dirOf(rara), 'first-story.lock'));
  const t1 = Date.now();
  const rr = FS.afterClose({ home: rara, env: ENV(rara), marker: CERRADA('9.9') });
  assert.ok(Date.now() - t1 < 20000, 'giró sin tope');
  assert.deepStrictEqual(rr.lines, []);
  assert.match(rr.warn || '', /candado/);
  // un enlace roto en lugar del candado tampoco (posix: en Windows un enlace pide privilegios)
  if (process.platform !== 'win32') {
    const enlace = casa();
    volcado(enlace, '9.9-z', CERRADA('9.9'));
    fs.symlinkSync(path.join(BASE, 'no-existe-nunca'), path.join(dirOf(enlace), 'first-story.lock'));
    const t2 = Date.now();
    const re = FS.afterClose({ home: enlace, env: ENV(enlace), marker: CERRADA('9.9') });
    assert.ok(Date.now() - t2 < 20000, 'giró sin tope con un enlace roto');
    assert.deepStrictEqual(re.lines, []);
  }
  const ocupada = casa();
  volcado(ocupada, '9.9-z', CERRADA('9.9'));
  const lock2 = path.join(dirOf(ocupada), 'first-story.lock');
  fs.writeFileSync(lock2, 'de otro vivo');
  const t0 = Date.now();
  const r = FS.afterClose({ home: ocupada, env: ENV(ocupada), marker: CERRADA('9.9') });
  assert.ok(Date.now() - t0 >= 4500, 'no esperó al candado');
  assert.deepStrictEqual(r.lines, []);
  assert.match(r.warn || '', /otro cierre tiene el candado/);
  assert.strictEqual(fs.readFileSync(lock2, 'utf8'), 'de otro vivo', 'borró el candado de otro');
  assert.strictEqual(record(ocupada), null, 'anotó algo sin el candado');
});

test('8.54 T20 ClonDeSkillsAparte · el árbol del arnés sale del estado de la instalación', () => {
  // una máquina en transición: las skills en un clon aparte, sin scripts/ al lado; el estado nombra el árbol instalado
  const clon = path.join(BASE, 'skills-aparte');
  fs.cpSync(path.join(RAIZ, 'skills', 'tycon-pipeline'), path.join(clon, 'skills', 'tycon-pipeline'), { recursive: true });
  const home = casa();
  const lib = path.join(clon, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'first-story.js');
  const r = spawnSync(process.execPath, ['-e', `const FS = require(${JSON.stringify(lib)});
    process.stdout.write(JSON.stringify({ tree: FS.treeOf(process.env.HOME), first: FS.isFirstStory({ home: process.env.HOME }) }));`], { encoding: 'utf8', env: ENV(home), timeout: 30000 });
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.tree, RAIZ, r.stderr);
  assert.deepStrictEqual([j.first.status, j.first.first], ['ok', true]);
  // y el cierre de verdad desde el clon ofrece
  const sid = 'sid-clon';
  fs.mkdirSync(path.join(dirOf(home), 'active'), { recursive: true });
  fs.writeFileSync(path.join(dirOf(home), 'active', `${sid}.json`), JSON.stringify(Object.assign({ sessionId: sid }, CERRADA('9.9'))));
  const c = spawnSync(process.execPath, [path.join(clon, 'skills', 'tycon-pipeline', 'scripts', 'marker.js'), 'clear'],
    { encoding: 'utf8', env: ENV(home, { CLAUDE_CODE_SESSION_ID: sid, TYCON_NO_THREAD_RESCUE: '1' }), timeout: 60000 });
  assert.strictEqual(c.status, 0, c.stderr);
  assert.match(c.stdout, /offer accept/, `${c.stdout}\n${c.stderr}`);
  // sin árbol en ninguno de los dos lugares: nadie decide
  const sinArbol = casa();
  fs.writeFileSync(path.join(dirOf(sinArbol), 'harness-state.json'), JSON.stringify({ tree: path.join(BASE, 'no-existe'), first_install: { at: 'x', version: '1', fresh: true } }));
  fs.writeFileSync(path.join(dirOf(sinArbol), 'first-story.json'), JSON.stringify({ offer: { status: 'offered', at: 'x', story: '1.1' } }));
  volcado(sinArbol, '9.9-z', CERRADA('9.9'));
  const r2 = spawnSync(process.execPath, ['-e', `const FS = require(${JSON.stringify(lib)});
    process.stdout.write(JSON.stringify({ tree: FS.treeOf(process.env.HOME), accept: FS.accept({ home: process.env.HOME, stdio: 'pipe' }) }));`], { encoding: 'utf8', env: ENV(sinArbol), timeout: 30000 });
  const j2 = JSON.parse(r2.stdout);
  assert.strictEqual(j2.tree, null, r2.stderr);
  assert.strictEqual(j2.accept.code, 2);
  assert.match(j2.accept.lines.join(' '), /no encuentro el árbol/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dirOf(sinArbol), 'first-story.json'), 'utf8')).offer.status, 'offered', 'accept anotó algo sin correr');
  // sin árbol en una máquina nueva: no hay oferta, se dice, y el cierre no se anota (el siguiente vuelve a decidir)
  const nuevaSinArbol = casa();
  volcado(nuevaSinArbol, '9.9-z', CERRADA('9.9'));
  const s1 = FS.afterClose({ home: nuevaSinArbol, env: ENV(nuevaSinArbol), marker: CERRADA('9.9'), tree: null });
  assert.deepStrictEqual(s1.lines, []);
  assert.match(s1.warn || '', /no encuentro el árbol/);
  assert.strictEqual(record(nuevaSinArbol), null, 'anotó el cierre con una falla que se puede arreglar');
  assert.ok(FS.afterClose({ home: nuevaSinArbol, env: ENV(nuevaSinArbol), marker: CERRADA('9.10') }).lines.some((l) => /offer accept/.test(l)), 'el cierre siguiente no volvió a decidir');
});

// ─── lo que se lee ─────────────────────────────────────────────────────────────────────────────────────────────────

test('8.54 T15 Paso8_DiceQueHacer · el paso «preparar el commit» dice qué hacer con la oferta', () => {
  const t = fs.readFileSync(path.join(RAIZ, 'skills', 'tycon-pipeline', 'steps', 'step-08-commit-prep.md'), 'utf8');
  const sec = t.slice(t.indexOf('instalación completa'));
  assert.ok(t.includes('instalación completa'), 'el paso no nombra la oferta');
  assert.match(sec, /offer accept/);
  assert.match(sec, /offer decline/);
  assert.match(sec, /tal cual/);
  assert.match(sec, /en otro momento/);
});

test('8.54 T16 Contrato_Cabecera · la cabecera del lector y su ficha nombran isFirstStory y no_medido', () => {
  const cab = fs.readFileSync(LIB, 'utf8').split('*/')[0];
  assert.match(cab, /isFirstStory/);
  assert.match(cab, /no_medido/);
  const ficha = fs.readFileSync(path.join(RAIZ, 'guides', 'maintaining', 'piezas-en-detalle.md'), 'utf8');
  const i = ficha.indexOf('first-story.js');
  assert.ok(i >= 0, 'piezas-en-detalle.md no tiene la ficha de first-story.js');
  assert.match(ficha.slice(i, i + 2500), /isFirstStory/);
  assert.match(ficha.slice(i, i + 2500), /no_medido/);
});

// ─── la red: nada de esta suite tocó la casa real (va último) ──────────────────────────────────────────────────────

test('RealHome_Untouched · ningún caso ni proceso lanzado intentó escribir o borrar en la casa real', () => {
  assert.strictEqual(GUARD.attempts().length, 0, `esta suite intentó tocar la casa real (frenado):\n${GUARD.describe()}`);
});
