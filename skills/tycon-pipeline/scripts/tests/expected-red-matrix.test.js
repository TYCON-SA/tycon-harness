#!/usr/bin/env node
'use strict';
// expected-red-matrix.test.js — una ejecución que la persona cerró en deuda por criterios sin evidencia en vivo llega al
// commit sólo por esos criterios: el control de la matriz al preparar el commit (DODRT-C6) acepta el rojo esperado de
// `acmatrix` cuando cada criterio sin correr está cubierto por la lista de pruebas del rojo esperado, con una fecha de
// vencimiento de hasta 14 días desde el cierre en deuda. `expect-red acmatrix` pide su propia firma, atada a la lista y la
// fecha que mostró la ventana. Vencida, el aviso de arranque lo dice.
//
// Corre los comandos reales con un HOME temporal y el id de sesión fijado en el proceso hijo. El cierre en deuda y la
// constancia del freno se dejan escritos como precondición: la firma de una persona no se forja en una prueba.
//
// stable-data: las fechas de vencimiento son relativas a la fecha local de hoy (ayer, hoy, en una semana) porque
// `marker.js` compara contra el reloj real a propósito (un reloj inyectable dejaría correr el vencimiento); una prueba que
// corre justo a la medianoche puede ver el día cambiar en el medio.
//
// Correr: node --test skills/tycon-pipeline/scripts/tests/expected-red-matrix.test.js < /dev/null

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const LEDGER = require(path.join(__dirname, 'lib', 'smoke-ledger-line.js'));
const NOTICE = path.join(RAIZ, 'scripts', 'hooks', 'unclosed-runs-notice.js');
// el aviso de la deuda corre desde este gancho, que se instala siempre (el de las corridas sin cerrar, sólo con el buzón)
const FINISHED = path.join(RAIZ, 'scripts', 'hooks', 'finished-open-notice.js');
const DEUDA = 'DEF-9.9-sin-entorno';
const MATRIZ_ROJA = /matriz de verificación runtime \(DODRT-C6\) ROJA/;

// la fecha local AAAA-MM-DD, corrida `dias` días desde hoy
function fecha(dias = 0, desde = new Date()) {
  const d = new Date(desde.getFullYear(), desde.getMonth(), desde.getDate() + dias);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// stable-data: la hora del cierre en deuda es la de ahora; el tope de 14 días se cuenta desde su fecha local
const ahora = () => new Date().toISOString();

// Una historia de juguete: cinco criterios, cada uno con su prueba (T1 a T4 y, si se pide, más filas).
function historia({ acs = null, filas = null, archivos = [], accion = false } = {}) {
  const criterios = acs || [
    '1. **Given** algo, **When** pasa, **Then** resultado uno.',
    '2. **Given** otra cosa, **Then** resultado dos.',
    '3. **Given** una tercera, **Then** resultado tres.',
    accion ? '4. **Given** una cuarta, **Then** guarda el archivo de salida.' : '4. **Given** una cuarta, **Then** resultado cuatro.',
  ];
  const tabla = filas || [
    '| T1 | `a.uno` | 1 | integration | x | y |',
    '| T2 | `a.dos` | 2 | integration | x | y |',
    '| T3 | `a.tres` | 3 | integration | x | y |',
    '| T4 | `a.cuatro` | 4 | integration | x | y |',
  ];
  return [
    '---', 'story: "9.9"', 'title: "deuda en vivo"', 'status: ready-for-dev', 'files_to_modify:', '  - src/a.js', ...archivos, '---',
    '# Story 9.9', '', 'Cada criterio se prueba con smoke runtime.', '',
    '## Acceptance Criteria', '', ...criterios, '',
    '### Tests', '', '| ID | Test | AC | Nivel | Escenario | Esperado |', '|---|---|---|---|---|---|', ...tabla, '',
    '## Dev Agent Record', '', `- Deuda: ${DEUDA} — el entorno de prueba no está`, '',
  ].join('\n');
}

function entorno(opciones = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'expected-red-matrix-'));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'agent-skills'));
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'tycon-harness'));
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'));
  const FECHA = '2026-01-01T10:00:00';
  const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', repo, ...a], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA },
  });
  git('init', '-q', '-b', 'feat/x');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const story = path.join(repo, 'specs', 'story-9.9-deuda-en-vivo.md');
  fs.writeFileSync(story, historia(opciones));
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 1;\n');
  // stable-data: la matriz descarta la evidencia más vieja que el código; una hora fija se pudriría con el tiempo
  const viejo = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(path.join(repo, 'src', 'a.js'), viejo, viejo);
  git('add', '.');
  git('commit', '-qm', 'inicio');
  const env = (sid) => ({
    ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0', TYCON_HOME: '',
    TYCON_TIME_TRACKING: 'none', TYCON_MUTATION_CHECK: 'off', TYCON_WAIT_NOTICE: '',
  });
  const correr = (script, args, sid, extra = {}) => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    encoding: 'utf8', env: { ...env(sid), ...extra }, input: '', cwd: repo,
  });
  const dir = () => [path.join(home, '.tycon', 'state'), path.join(home, '.claude', '.tycon-pipeline')].find((d) => fs.existsSync(path.join(d, 'active')));
  const activo = (sid) => path.join(dir(), 'active', `${sid}.json`);
  const leer = (sid) => JSON.parse(fs.readFileSync(activo(sid), 'utf8'));
  const escribir = (sid, m) => fs.writeFileSync(activo(sid), JSON.stringify(m));
  const gates = () => { try { return fs.readFileSync(path.join(dir(), 'gates.log'), 'utf8'); } catch (_) { return ''; } };
  const arrancar = (sid) => {
    const r = correr('pipeline.js', ['start', '--story', story, '--repo', repo, '--brief'], sid);
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  };
  // el humo de los criterios pedidos, con su espejo en el gates.log de la HOME temporal
  // (con `cmd` de un corredor de pruebas, la matriz lo cuenta como evidencia de código, no en vivo)
  const humo = (acs, { cmd } = {}) => {
    const gatesLog = path.join(dir() || path.join(home, '.claude', '.tycon-pipeline'), 'gates.log');
    fs.mkdirSync(path.dirname(gatesLog), { recursive: true });
    const dodDir = path.join(repo, '.advisors', 'dod-runtime');
    fs.mkdirSync(dodDir, { recursive: true });
    LEDGER.append({ dodDir, gatesLog, story: '9.9', acs, ...(cmd ? { cmd } : {}) });
  };
  // la constancia que deja el freno cuando la persona aprueba la firma del rojo esperado de la matriz
  const firmar = (sid, { pruebas, hasta, escape = 'rojo-esperado-de-la-matriz' }) => {
    const detalle = pruebas ? require(path.join(SCRIPTS, 'lib', 'marker-command.js')).detalleDelRojoEsperado('acmatrix', pruebas, hasta) : undefined;
    const r = require(path.join(RAIZ, 'scripts', 'lib', 'guard-record.js')).anotar({ freno: 'safety-guard', regla: 'ESC-C4', veredicto: 'escape',
      cmd: 'x', home, via: 'ventana', sesion: sid, escape, detalle });
    assert.ok(r.escrito, JSON.stringify(r));
  };
  return { home, repo, story, git, correr, leer, escribir, activo, arrancar, humo, dir, gates, firmar };
}

// Lleva la ejecución hasta «Preparar el commit», con «Probar en vivo» hecho: el freno que queda es el de la matriz.
const HECHOS = ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'findings', 'live-check'];
function hastaPrepararElCommit(E, sid, extra = {}) {
  const m = E.leer(sid);
  // stable-data: el lanzamiento y el resultado del pase tienen que ser de esta ejecución, que arrancó recién
  const hace = (min) => new Date(Date.now() - min * 60 * 1000).toISOString();
  const w = spawnSync(process.execPath, [path.join(SCRIPTS, 'pipeline.js'), 'write-findings', '--story', E.story, '--repo', E.repo, '--findings', '-'], {
    encoding: 'utf8', input: '[]', cwd: E.repo, env: { ...process.env, HOME: E.home, USERPROFILE: E.home, CLAUDE_CODE_SESSION_ID: sid, TYCON_HOME: '' },
  });
  assert.strictEqual(w.status, 0, w.stderr + w.stdout);
  E.escribir(sid, { ...m, stepScheme: 2, stepsCompleted: HECHOS, stepsPending: ['prepare-commit'],
    dodRuntimeChecked: true, deepReviewDone: true, checks: { tests: 'green', build: 'green', advisors: 'green' },
    adversarial: { launchedAtStep: 'adversarial-pass', runId: 'r1', sessionId: sid, launchedAt: hace(30) },
    adversarialPasses: [{ tipo: '5b', ts: hace(5), confirmados: 0 }], ...extra });
}

// La ejecución en deuda con el rojo esperado de la matriz por estas pruebas y hasta esta fecha (precondición).
function enDeuda(E, sid, { pruebas = ['T1', 'T2', 'T3'], hasta = fecha(7), conRojoEsperado = true } = {}) {
  const m = E.leer(sid);
  const cierre = { estado: 'deuda', motivo: 'el entorno de prueba no está', deuda: DEUDA, via: 'ventana', at: ahora() };
  const checks = { ...(m.checks || {}), ...(conRojoEsperado ? { acmatrix: 'rojo-esperado:exit=1' } : {}) };
  const expectedRed = conRojoEsperado ? { acmatrix: { tests: pruebas, deuda: DEUDA, at: ahora(), until: hasta } } : undefined;
  E.escribir(sid, { ...m, cierre, checks, ...(expectedRed ? { expectedRed } : {}) });
}

const prepararElCommit = (E, sid) => E.correr('marker.js', ['complete-step', 'prepare-commit', '--out-of-order'], sid);
// el bloque del control de la matriz en la salida: lo que dice desde «DODRT-C6» hasta el próximo control
const salida = (r) => `${r.stderr}\n${r.stdout}`;

test('T1 PrepareCommit_DebtWithExpectedRed_Passes @story-8.252 @ac-1 — en deuda, con los criterios sin correr cubiertos por la lista, la matriz no frena', () => {
  const E = entorno();
  E.arrancar('s-t1');
  hastaPrepararElCommit(E, 's-t1');
  E.humo([4]);
  const hasta = fecha(7);
  enDeuda(E, 's-t1', { hasta });
  const r = prepararElCommit(E, 's-t1');
  assert.doesNotMatch(salida(r), MATRIZ_ROJA, salida(r));
  // la línea del mensaje de commit, debajo de la de la deuda
  const lineaDeuda = salida(r).indexOf(`Deuda: ${DEUDA}`);
  const lineaEnVivo = salida(r).indexOf(`Sin evidencia en vivo: AC 1, 2, 3 — deuda ${DEUDA}, vence ${hasta}`);
  assert.ok(lineaDeuda >= 0, salida(r));
  assert.ok(lineaEnVivo > lineaDeuda, `la línea «Sin evidencia en vivo» va debajo de «Deuda:»: ${salida(r)}`);
  const renglon = E.gates().split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.name === 'acmatrix-debt');
  assert.ok(renglon, E.gates());
  assert.strictEqual(renglon.story, '9.9');
  assert.ok(path.isAbsolute(renglon.storyPath), renglon.storyPath);
  assert.strictEqual(fs.realpathSync(renglon.storyPath), fs.realpathSync(E.story));
  assert.strictEqual(renglon.deuda, DEUDA);
  assert.deepStrictEqual(renglon.acs, [1, 2, 3]);
  assert.strictEqual(renglon.until, hasta);
  // dónde vive la historia en su repo: el aviso la busca ahí cuando esta carpeta de trabajo ya no esté
  assert.strictEqual(renglon.storyRel.split(path.sep).join('/'), 'specs/story-9.9-deuda-en-vivo.md');
  assert.strictEqual(fs.realpathSync(renglon.repoCommon), fs.realpathSync(path.join(E.repo, '.git')));
});

test('T14 PrepareCommit_DebtLogUnwritable_Blocks @story-8.252 @ac-1 — si el renglón de la deuda no se puede escribir, la deuda no se acepta', () => {
  const E = entorno();
  E.arrancar('s-t14');
  hastaPrepararElCommit(E, 's-t14');
  // sin humo: la lista cubre los cuatro criterios, así la deuda los aceptaría
  enDeuda(E, 's-t14', { pruebas: ['T1', 'T2', 'T3', 'T4'] });
  // el gates.log no se deja escribir: es una carpeta
  const gatesLog = path.join(E.dir(), 'gates.log');
  const antes = fs.readFileSync(gatesLog, 'utf8');
  fs.rmSync(gatesLog);
  fs.mkdirSync(gatesLog);
  const r = prepararElCommit(E, 's-t14');
  assert.notStrictEqual(r.status, 0, salida(r));
  assert.match(salida(r), /no pude anotar la deuda de evidencia en vivo en gates\.log/);
  assert.doesNotMatch(salida(r), /Sin evidencia en vivo: AC/, 'sin el renglón no hay línea para el commit');
  assert.ok(antes.length > 0);
});

test('T2 PrepareCommit_ExtraNotRun_Blocks @story-8.252 @ac-2 — un criterio más sin correr, fuera de la lista, frena y se nombra', () => {
  const E = entorno();
  E.arrancar('s-t2');
  hastaPrepararElCommit(E, 's-t2');
  enDeuda(E, 's-t2');
  const r = prepararElCommit(E, 's-t2');
  assert.match(salida(r), MATRIZ_ROJA, salida(r));
  assert.match(salida(r), /sin correr y fuera de la deuda: #4\b/, salida(r));
  assert.doesNotMatch(salida(r), /Sin evidencia en vivo:/);
  assert.ok(!/"name":"acmatrix-debt"/.test(E.gates()), 'no anotó la deuda aceptada');
});

test('T3 PrepareCommit_UnsignedNotVerifiable_Blocks @story-8.252 @ac-3 — un criterio imposible sin su firma frena aunque el resto esté en la lista', () => {
  const E = entorno({ archivos: ['runtime_not_verifiable:', '  - ac: 4', '    reason: "el equipo de pruebas no existe"', '    covered_by: "T4"'] });
  E.arrancar('s-t3');
  hastaPrepararElCommit(E, 's-t3');
  // el imposible-declarado tiene su prueba de código: sin ella, la matriz lo da por sin correr
  E.humo([4], { cmd: 'node --test tests/a.test.js' });
  enDeuda(E, 's-t3');
  const r = prepararElCommit(E, 's-t3');
  assert.match(salida(r), MATRIZ_ROJA, salida(r));
  assert.match(salida(r), /imposibles-declarados[^\n]*#4/, salida(r));
  assert.match(salida(r), /la deuda no exime[^\n]*#4/, salida(r));
  assert.doesNotMatch(salida(r), /Sin evidencia en vivo:/);
});

test('T4 PrepareCommit_NoDebt_SameAsToday @story-8.252 @ac-4 — sin deuda, o en deuda sin rojo esperado de la matriz, frena con los mensajes de hoy', () => {
  // el bloque del control de la matriz, sin las rutas temporales: lo que se compara entre las dos ejecuciones
  const bloque = (r, E) => salida(r).split('\n').filter((l) => /DODRT-C6|SIN CORRER|imposibles-declarados|waiveados|Corrélos|declaralos/.test(l))
    .map((l) => l.split(E.repo).join('<repo>').split(E.home).join('<home>')).join('\n');
  const sin = entorno();
  sin.arrancar('s-t4a');
  hastaPrepararElCommit(sin, 's-t4a');
  const r1 = prepararElCommit(sin, 's-t4a');
  assert.match(salida(r1), MATRIZ_ROJA, salida(r1));
  assert.match(salida(r1), /SIN CORRER \(el agente DEBE correrlos — NO se pueden waivear\): #1, #2, #3, #4/, salida(r1));
  const con = entorno();
  con.arrancar('s-t4b');
  hastaPrepararElCommit(con, 's-t4b');
  enDeuda(con, 's-t4b', { conRojoEsperado: false });
  const r2 = prepararElCommit(con, 's-t4b');
  assert.match(salida(r2), MATRIZ_ROJA, salida(r2));
  assert.strictEqual(bloque(r2, con), bloque(r1, sin), 'en deuda sin rojo esperado de la matriz, el mismo mensaje que sin deuda');
  for (const r of [r1, r2]) {
    assert.doesNotMatch(salida(r), /fuera de la deuda|Sin evidencia en vivo|la deuda no exime/);
  }
});

test('T5 PrepareCommit_MatrixStructError_Blocks @story-8.252 @ac-5 — lo que no se puede medir, o la evidencia incompleta, frena aunque la lista lo cubra', () => {
  // la historia, después del arranque, sin criterios ni tabla: la matriz no se puede calcular
  const rota = entorno();
  rota.arrancar('s-t5a');
  hastaPrepararElCommit(rota, 's-t5a');
  enDeuda(rota, 's-t5a');
  fs.writeFileSync(rota.story, historia({ acs: ['Sin criterios numerados.'] }).replace(/### Tests[\s\S]*?## Dev/, '## Dev'));
  let r = prepararElCommit(rota, 's-t5a');
  assert.match(salida(r), /matriz runtime no computable/, salida(r));
  assert.doesNotMatch(salida(r), /Sin evidencia en vivo:/);
  // código declarado que no existe: la matriz no lo pudo leer
  const sinLeer = entorno({ archivos: ['  - database/no-existe.sql'] });
  sinLeer.arrancar('s-t5b');
  hastaPrepararElCommit(sinLeer, 's-t5b');
  sinLeer.humo([4]);
  enDeuda(sinLeer, 's-t5b');
  r = prepararElCommit(sinLeer, 's-t5b');
  assert.match(salida(r), MATRIZ_ROJA, salida(r));
  assert.match(salida(r), /la deuda no exime[^\n]*database\/no-existe\.sql/, salida(r));
  assert.doesNotMatch(salida(r), /Sin evidencia en vivo:/);
  // un criterio de acción cuya evidencia no ejerció la acción, cubierto por la lista
  const accion = entorno({ accion: true });
  accion.arrancar('s-t5c');
  hastaPrepararElCommit(accion, 's-t5c');
  accion.humo([4]);
  enDeuda(accion, 's-t5c', { pruebas: ['T1', 'T2', 'T3', 'T4'] });
  r = prepararElCommit(accion, 's-t5c');
  assert.match(salida(r), MATRIZ_ROJA, salida(r));
  assert.match(salida(r), /la deuda no exime[^\n]*#4/, salida(r));
  assert.doesNotMatch(salida(r), /Sin evidencia en vivo:/);
  // un criterio de pantalla con su humo y sin imagen, cubierto por la lista
  const pantalla = entorno({ acs: [1, 2, 3].map((n) => `${n}. **Given** algo ${n}, **Then** resultado ${n}.`).concat('4. **Given** una cuarta, **Then** se ve en la pantalla. @pantalla') });
  pantalla.arrancar('s-t5d');
  hastaPrepararElCommit(pantalla, 's-t5d');
  pantalla.humo([4]);
  enDeuda(pantalla, 's-t5d', { pruebas: ['T1', 'T2', 'T3', 'T4'] });
  r = prepararElCommit(pantalla, 's-t5d');
  assert.match(salida(r), MATRIZ_ROJA, salida(r));
  assert.match(salida(r), /la deuda no exime los criterios de pantalla sin imagen: #4/, salida(r));
  assert.doesNotMatch(salida(r), /Sin evidencia en vivo:/);
});

test('T6 PrepareCommit_ExpiredDebt_Blocks @story-8.252 @ac-6 — vencida ayer frena y lo dice; la de hoy vale el día entero', () => {
  const ayer = entorno();
  ayer.arrancar('s-t6a');
  hastaPrepararElCommit(ayer, 's-t6a');
  ayer.humo([4]);
  enDeuda(ayer, 's-t6a', { hasta: fecha(-1) });
  let r = prepararElCommit(ayer, 's-t6a');
  assert.match(salida(r), /venció/, salida(r));
  assert.match(salida(r), new RegExp(fecha(-1)), salida(r));
  assert.doesNotMatch(salida(r), /Sin evidencia en vivo:/);
  const hoy = entorno();
  hoy.arrancar('s-t6b');
  hastaPrepararElCommit(hoy, 's-t6b');
  hoy.humo([4]);
  enDeuda(hoy, 's-t6b', { hasta: fecha(0) });
  r = prepararElCommit(hoy, 's-t6b');
  assert.doesNotMatch(salida(r), MATRIZ_ROJA, salida(r));
  assert.doesNotMatch(salida(r), /venció/, salida(r));
  assert.match(salida(r), new RegExp(`vence ${fecha(0)}`), salida(r));
});

// La ejecución en deuda con el control de la matriz en rojo, lista para `expect-red acmatrix`.
function paraElRojoEsperado(sid, opciones) {
  const E = entorno(opciones);
  E.arrancar(sid);
  const m = E.leer(sid);
  E.escribir(sid, { ...m, cierre: { estado: 'deuda', motivo: 'el entorno de prueba no está', deuda: DEUDA, via: 'ventana', at: ahora() },
    checks: { ...(m.checks || {}), acmatrix: 'red:exit=1' } });
  return E;
}
const expectRed = (E, sid, pruebas, hasta) => E.correr('marker.js', ['expect-red', 'acmatrix', '--tests', pruebas.join(','), ...(hasta ? ['--until', hasta] : [])], sid);

test('T7 ExpectRed_Acmatrix_NeedsUntil @story-8.252 @ac-7 — sin fecha, vencida, más allá del tope o con una prueba ajena no escribe; válida guarda la fecha', () => {
  const E = paraElRojoEsperado('s-t7');
  const T = ['T1', 'T2', 'T3'];
  const sinEscribir = () => {
    const m = E.leer('s-t7');
    assert.strictEqual(m.checks.acmatrix, 'red:exit=1');
    assert.strictEqual(m.expectedRed, undefined);
  };
  let r = expectRed(E, 's-t7', T, null);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /--until/);
  sinEscribir();
  E.firmar('s-t7', { pruebas: T, hasta: fecha(-1) });
  r = expectRed(E, 's-t7', T, fecha(-1));
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /anterior a hoy/);
  sinEscribir();
  E.firmar('s-t7', { pruebas: T, hasta: fecha(15) });
  r = expectRed(E, 's-t7', T, fecha(15));
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /14 días/);
  assert.match(r.stderr, new RegExp(fecha(14)));
  sinEscribir();
  E.firmar('s-t7', { pruebas: ['T1', 'T9'], hasta: fecha(7) });
  r = expectRed(E, 's-t7', ['T1', 'T9'], fecha(7));
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /T9/);
  assert.match(r.stderr, /### Tests/);
  sinEscribir();
  E.firmar('s-t7', { pruebas: T, hasta: fecha(7) });
  r = expectRed(E, 's-t7', T, fecha(7));
  assert.strictEqual(r.status, 0, r.stderr);
  const m = E.leer('s-t7');
  assert.strictEqual(m.checks.acmatrix, 'rojo-esperado:exit=1');
  assert.deepStrictEqual(m.expectedRed.acmatrix.tests, T);
  assert.strictEqual(m.expectedRed.acmatrix.until, fecha(7));
  // otro control sigue como hoy: sin --until y sin la firma nueva
  const otro = paraElRojoEsperado('s-t7b');
  otro.escribir('s-t7b', { ...otro.leer('s-t7b'), checks: { ...otro.leer('s-t7b').checks, tests: 'red:exit=1' } });
  r = otro.correr('marker.js', ['expect-red', 'tests', '--tests', 'T2'], 's-t7b');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(otro.leer('s-t7b').checks.tests, 'rojo-esperado:exit=1');
  assert.strictEqual(otro.leer('s-t7b').expectedRed.tests.until, undefined);
});

test('T9 Matrix_TestsCoverAcs @story-8.252 @ac-2 — qué pruebas nombran cada criterio, y qué cubre una lista', () => {
  const rmx = require(path.join(SCRIPTS, 'runtime-matrix.js'));
  const filas = [
    '| T1 | `a.uno` | 1 | unit | x | y |',
    '| T2 | `a.dos` | 2, 3 | unit | x | y |',
    '| T3 | `a.tres` | 4 | unit | x | y |',
    '| T4 | `a.en-vivo` | 1 | e2e | x | y |',
  ];
  const criterios = [1, 2, 3, 4, 5].map((n) => `${n}. **Given** algo ${n}, **Then** resultado ${n}.`);
  const E = entorno({ acs: criterios, filas });
  const m = rmx.compute({ storyPath: E.story });
  assert.ok(!m.structuralError, m.structuralError);
  assert.deepStrictEqual(m.testsByAc[1], ['T1', 'T4']);
  assert.deepStrictEqual(m.testsByAc[2], ['T2']);
  assert.deepStrictEqual(m.testsByAc[3], ['T2']);
  assert.deepStrictEqual(m.testsByAc[5] || [], []);
  let c = rmx.debtCoverage(m, ['T1', 'T2', 'T3']);
  assert.deepStrictEqual(c.covered, [2, 3, 4]);
  assert.deepStrictEqual(c.uncovered, [1, 5], 'al AC 1 le falta T4; al AC 5 no lo nombra ninguna prueba');
  assert.deepStrictEqual(c.unknown, []);
  c = rmx.debtCoverage(m, ['T9']);
  assert.deepStrictEqual(c.covered, []);
  assert.deepStrictEqual(c.unknown, ['T9']);
  // un rango en la columna AC nombra cada criterio del rango
  const R = entorno({ acs: criterios, filas: [...filas, '| T5 | `a.rango` | 1-3 | e2e | x | y |'] });
  const mr = rmx.compute({ storyPath: R.story });
  assert.deepStrictEqual(mr.testsByAc[2], ['T2', 'T5']);
  c = rmx.debtCoverage(mr, ['T1', 'T2', 'T3', 'T4']);
  assert.deepStrictEqual(c.covered, [4], 'sin T5 en la lista, los AC 1 a 3 no quedan cubiertos');
  c = rmx.debtCoverage(mr, ['T1', 'T2', 'T3', 'T4', 'T5']);
  assert.deepStrictEqual(c.covered, [1, 2, 3, 4]);
  // una celda AC que no se entiende: ningún criterio sin correr queda cubierto mientras esa fila exista
  const I = entorno({ acs: criterios, filas: [...filas, '| T6 | `a.ilegible` | a definir | e2e | x | y |'] });
  const mi = rmx.compute({ storyPath: I.story });
  assert.deepStrictEqual(mi.unreadableTests, ['T6']);
  c = rmx.debtCoverage(mi, ['T1', 'T2', 'T3', 'T4', 'T6']);
  assert.deepStrictEqual(c.covered, []);
  assert.deepStrictEqual(c.uncovered, [1, 2, 3, 4, 5]);
});

test('T10 ExpectRed_Acmatrix_AsksPermission @story-8.252 @ac-9 — la firma propia: la pide el freno, la ventana muestra criterios, pruebas y fecha, y vale una vez para su lista', () => {
  const mc = require(path.join(SCRIPTS, 'lib', 'marker-command.js'));
  const MARKER = 'node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js';
  const hasta = fecha(7);
  const comando = `${MARKER} expect-red acmatrix --tests T1,T2,T3 --until ${hasta}`;
  // el freno: con una ejecución (aunque esté en verde, como al renovar), pide la firma nueva con su huella
  const E = paraElRojoEsperado('s-t10');
  E.escribir('s-t10', { ...E.leer('s-t10'), checks: { tests: 'green', advisors: 'green', acmatrix: 'rojo-esperado:exit=1' },
    expectedRed: { acmatrix: { tests: ['T1'], deuda: DEUDA, at: ahora(), until: fecha(3) } }, stepsPending: [] });
  const gate = (cmd) => spawnSync(process.execPath, [path.join(SCRIPTS, 'lib', 'run-close.js'), '--gate', '--session', 's-t10', '--command-stdin', '--shell', 'bash'], {
    input: cmd, encoding: 'utf8', cwd: E.repo, env: { ...process.env, HOME: E.home, USERPROFILE: E.home, TYCON_HOME: '' },
  });
  let g = gate(comando);
  assert.strictEqual(g.status, 0, g.stderr);
  assert.match(g.stdout, /^frena=rojo esperado de la matriz\texpect-red\tacmatrix$/m, g.stdout);
  assert.match(g.stdout, new RegExp(`^detalle=${mc.detalleDelRojoEsperado('acmatrix', ['T1', 'T2', 'T3'], hasta)}$`, 'm'), g.stdout);
  // la huella no depende del orden ni de las repeticiones de la lista; cambia con la lista o la fecha
  assert.strictEqual(mc.detalleDelRojoEsperado('acmatrix', ['T3', 'T1', 'T2', 'T1'], hasta), mc.detalleDelRojoEsperado('acmatrix', ['T1', 'T2', 'T3'], hasta));
  assert.notStrictEqual(mc.detalleDelRojoEsperado('acmatrix', ['T1', 'T2'], hasta), mc.detalleDelRojoEsperado('acmatrix', ['T1', 'T2', 'T3'], hasta));
  assert.notStrictEqual(mc.detalleDelRojoEsperado('acmatrix', ['T1', 'T2', 'T3'], fecha(8)), mc.detalleDelRojoEsperado('acmatrix', ['T1', 'T2', 'T3'], hasta));
  // otro control sigue pidiendo «cerrar como deuda», sin huella
  g = gate(`${MARKER} expect-red tests --tests T2`);
  assert.match(g.stdout, /^frena=cerrar como deuda\texpect-red\ttests$/m, g.stdout);
  assert.doesNotMatch(g.stdout, /^detalle=/m);
  // la ventana: lo que se aprueba trae los criterios con su texto, las pruebas y la fecha
  const ow = require(path.join(RAIZ, 'scripts', 'lib', 'owner-window.js'));
  const cuadro = ow.cuadroPara({ firma: 'escape:rojo-esperado-de-la-matriz', comando, palabras: null, destino: 's-t10', cwd: E.repo, casa: E.home, sesion: 's-t10' });
  assert.ok(!cuadro.error, cuadro.error);
  for (const n of [1, 2, 3]) assert.match(cuadro.pregunta, new RegExp(`AC ${n}: [^|]*resultado`), cuadro.pregunta);
  assert.match(cuadro.pregunta, /T1, T2, T3/);
  assert.match(cuadro.pregunta, new RegExp(hasta));
  // envuelto, no se ve qué se firma: sin criterios a la vista, no hay cuadro
  const envuelto = ow.cuadroPara({ firma: 'escape:rojo-esperado-de-la-matriz', comando: `bash -c '${comando}'`, palabras: null, destino: 's-t10', cwd: E.repo, casa: E.home, sesion: 's-t10' });
  assert.ok(envuelto.error, JSON.stringify(envuelto));
  // marker.js: sin constancia no escribe; con la de otra lista u otra fecha tampoco; con la suya sí, y una sola vez
  const R = paraElRojoEsperado('s-t10b');
  const T = ['T1', 'T2', 'T3'];
  let r = expectRed(R, 's-t10b', T, hasta);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /ventana de permiso/);
  R.firmar('s-t10b', { pruebas: ['T1', 'T2'], hasta });
  R.firmar('s-t10b', { pruebas: T, hasta: fecha(8) });
  R.firmar('s-t10b', { pruebas: T, hasta, escape: 'cerrar-como-deuda' });
  r = expectRed(R, 's-t10b', T, hasta);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.strictEqual(R.leer('s-t10b').expectedRed, undefined);
  R.firmar('s-t10b', { pruebas: T, hasta });
  r = expectRed(R, 's-t10b', T, hasta);
  assert.strictEqual(r.status, 0, r.stderr);
  // la misma constancia no sirve para otra escritura (renovar con la misma lista y fecha)
  r = expectRed(R, 's-t10b', T, hasta);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /ventana de permiso/);
});

test('T12 ExpectRed_Acmatrix_Renew @story-8.252 @ac-7 — renovar dentro del tope cambia la fecha; más allá, no; una medición más en rojo no borra la deuda', () => {
  const E = paraElRojoEsperado('s-t12');
  const T = ['T1', 'T2', 'T3'];
  E.firmar('s-t12', { pruebas: T, hasta: fecha(3) });
  let r = expectRed(E, 's-t12', T, fecha(3));
  assert.strictEqual(r.status, 0, r.stderr);
  // renovar dentro del tope: cambia la fecha y lo anota
  E.firmar('s-t12', { pruebas: T, hasta: fecha(10) });
  r = expectRed(E, 's-t12', T, fecha(10));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(E.leer('s-t12').expectedRed.acmatrix.until, fecha(10));
  assert.match(E.gates(), new RegExp(`"name":"acmatrix-debt-renewed"[^\\n]*"until":"${fecha(10)}"`));
  // más allá del tope: no escribe y dice el tope
  E.firmar('s-t12', { pruebas: T, hasta: fecha(20) });
  r = expectRed(E, 's-t12', T, fecha(20));
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, new RegExp(fecha(14)));
  assert.strictEqual(E.leer('s-t12').expectedRed.acmatrix.until, fecha(10));
  // una medición más de la matriz, todavía en rojo: el control sigue en rojo esperado y se puede renovar
  r = E.correr('marker.js', ['run-check', 'acmatrix', '--', process.execPath, '-e', 'process.exit(1)'], 's-t12');
  assert.strictEqual(E.leer('s-t12').checks.acmatrix, 'rojo-esperado:exit=1', r.stderr + r.stdout);
  E.firmar('s-t12', { pruebas: T, hasta: fecha(12) });
  r = expectRed(E, 's-t12', T, fecha(12));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(E.leer('s-t12').expectedRed.acmatrix.until, fecha(12));
  // en verde, el control queda verde
  E.correr('marker.js', ['run-check', 'acmatrix', '--', process.execPath, '-e', 'process.exit(0)'], 's-t12');
  assert.match(E.leer('s-t12').checks.acmatrix, /^green/);
});

test('T8 Notice_ExpiredEvidenceDebt @story-8.252 @ac-8 — la deuda vencida con sus criterios sin correr se avisa al arrancar, con su sello propio', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'expected-red-notice-'));
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, '.claude', '.tycon-pipeline', 'active'), { recursive: true });
  const estado = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'tycon-home.js')).stateDir(home);
  fs.mkdirSync(estado, { recursive: true });
  // cuatro historias: vencida y sin correr; vencida con sus criterios corridos (y otro ajeno sin correr); sin vencer; ausente
  const historias = ['vencida', 'pagada', 'vigente'].map((nombre) => {
    const E = entorno();
    fs.renameSync(E.story, path.join(E.repo, 'specs', `story-9.9-${nombre}.md`));
    return { nombre, E, story: path.join(E.repo, 'specs', `story-9.9-${nombre}.md`) };
  });
  // la evidencia del humo de la pagada: su espejo va al gates.log de la HOME del aviso
  const pagada = historias[1];
  const dodDir = path.join(pagada.E.repo, '.advisors', 'dod-runtime');
  fs.mkdirSync(dodDir, { recursive: true });
  LEDGER.append({ dodDir, gatesLog: path.join(estado, 'gates.log'), story: '9.9', acs: [1, 2] });
  const renglon = (story, until, acs = [1, 2]) => JSON.stringify({ ts: ahora(), name: 'acmatrix-debt', story: '9.9', storyPath: story, deuda: DEUDA, acs, until });
  const lineas = [
    renglon(historias[0].story, '2026-01-10'),
    renglon(pagada.story, '2026-01-10', [1, 2]),
    renglon(historias[2].story, '2099-01-10'),
    renglon(path.join(base, 'no-existe', 'story-9.9-ausente.md'), '2026-01-10'),
  ];
  fs.appendFileSync(path.join(estado, 'gates.log'), lineas.join('\n') + '\n');
  // el reloj del gancho: después de los vencimientos; el sello de las corridas sin cerrar de ese día, ya escrito
  const NOW = '2026-01-20T12:00:00.000Z';
  fs.writeFileSync(path.join(estado, 'unclosed-runs-notice.json'), JSON.stringify({ day: NOW.slice(0, 10), runs: 0, problems: 0 }));
  const avisar = () => spawnSync(process.execPath, [FINISHED], { encoding: 'utf8', cwd: base, input: '',
    env: { ...process.env, HOME: home, USERPROFILE: home, TYCON_HOME: '', TYCON_UNCLOSED_NOW: NOW, TYCON_UNSAVED_FOLDERS: '0', TYCON_EVAL_SANDBOX: '' } });
  let r = avisar();
  assert.strictEqual(r.status, 0, r.stderr);
  const dicho = r.stdout.split('\n').filter(Boolean);
  const de = (texto) => dicho.filter((l) => l.includes(texto));
  assert.strictEqual(de('story-9.9-vencida.md').length, 1, r.stdout);
  for (const dato of [DEUDA, 'AC 1, 2', 'vencida el 2026-01-10']) assert.ok(de('story-9.9-vencida.md')[0].includes(dato), `${dato}: ${r.stdout}`);
  assert.strictEqual(de('story-9.9-ausente.md').length, 1, r.stdout);
  assert.match(de('story-9.9-ausente.md')[0], /no pude mirar/);
  assert.strictEqual(de('story-9.9-pagada.md').length, 0, `sus criterios corrieron; el AC 3 sin correr no es de la deuda: ${r.stdout}`);
  assert.strictEqual(de('story-9.9-vigente.md').length, 0, r.stdout);
  // la pagada queda cerrada en el gates.log; la vigente sigue abierta
  const cierres = fs.readFileSync(path.join(estado, 'gates.log'), 'utf8').split('\n').filter((l) => l.includes('"acmatrix-debt-paid"'));
  assert.strictEqual(cierres.length, 1, cierres.join('\n'));
  assert.strictEqual(JSON.parse(cierres[0]).storyPath, pagada.story);
  // el mismo día no lo repite
  r = avisar();
  assert.strictEqual(r.stdout.trim(), '', r.stdout);
});

test('T13 Notice_TwoDebtsSameStory @story-8.252 @ac-8 — dos deudas de la misma historia (dos tandas) se avisan las dos; la renovación de una no mueve la otra', () => {
  const aviso = require(NOTICE);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'expected-red-two-debts-'));
  const E = entorno();
  const gates = path.join(base, 'gates.log');
  const renglon = (name, deuda, acs, until) => JSON.stringify({ ts: ahora(), name, story: '9.9', storyPath: E.story, deuda, acs, until });
  fs.writeFileSync(gates, [
    renglon('acmatrix-debt', 'DEF-9.9-tanda-A', [1, 2], '2026-01-10'),
    renglon('acmatrix-debt', 'DEF-9.9-tanda-B', [4], '2026-01-12'),
    renglon('acmatrix-debt-renewed', 'DEF-9.9-tanda-A', undefined, '2026-01-25'),
  ].join('\n') + '\n');
  const { debts: deudas, problems } = aviso.evidenceDebts(gates);
  assert.deepStrictEqual(problems, []);
  assert.deepStrictEqual(deudas.map((d) => [d.deuda, d.until]).sort(), [['DEF-9.9-tanda-A', '2026-01-25'], ['DEF-9.9-tanda-B', '2026-01-12']]);
  const dicho = aviso.expiredDebtLines(deudas, '2026-01-20');
  assert.strictEqual(dicho.length, 1, dicho.join('\n'));
  assert.match(dicho[0], /DEF-9\.9-tanda-B, AC 4/);
  assert.strictEqual(aviso.expiredDebtLines(deudas, '2026-01-26').length, 2);
  // el cierre de una deuda no cierra la otra de la misma historia
  fs.appendFileSync(gates, renglon('acmatrix-debt-paid', 'DEF-9.9-tanda-B', [4], undefined) + '\n');
  assert.deepStrictEqual(aviso.evidenceDebts(gates).debts.map((d) => d.deuda), ['DEF-9.9-tanda-A']);
});

// El aviso de la deuda, corrido como en el arranque (desde finished-open-notice.js), con una HOME y su gates.log.
function avisoDeLaDeuda(lineas, { tz } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'expected-red-debt-notice-'));
  const home = path.join(base, 'home');
  const estado = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'tycon-home.js')).stateDir(home);
  fs.mkdirSync(estado, { recursive: true });
  if (lineas != null) fs.writeFileSync(path.join(estado, 'gates.log'), lineas.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  const avisar = (now) => spawnSync(process.execPath, [FINISHED], { encoding: 'utf8', cwd: base, input: '',
    env: { ...process.env, HOME: home, USERPROFILE: home, TYCON_HOME: '', TYCON_UNCLOSED_NOW: now, TYCON_UNSAVED_FOLDERS: '0', TYCON_EVAL_SANDBOX: '', ...(tz ? { TZ: tz } : {}) } });
  return { base, home, estado, avisar, sello: () => JSON.parse(fs.readFileSync(path.join(estado, 'evidence-debt-notice.json'), 'utf8')) };
}
const deudaDe = (storyPath, extra = {}) => ({ ts: ahora(), name: 'acmatrix-debt', story: '9.9', storyPath, deuda: DEUDA, acs: [1, 2], until: '2026-11-10', ...extra });

test('T15 Notice_SealUsesLocalDay @story-8.252 @ac-8 — el sello del aviso es el día local, el mismo reloj que el vencimiento', () => {
  const E = entorno();
  const A = avisoDeLaDeuda([deudaDe(E.story, { until: '2026-11-10' }), deudaDe(E.story, { deuda: 'DEF-otra', until: '2026-11-11' })], { tz: 'America/Argentina/Buenos_Aires' });
  // a las 22 del 11 (la 1 del 12 en UTC): vence la primera; la segunda vale todo el 11
  let r = A.avisar('2026-11-11T22:00:00-03:00');
  assert.strictEqual(A.sello().day, '2026-11-11', r.stdout);
  assert.strictEqual(r.stdout.split('\n').filter((l) => /vencida el/.test(l)).length, 1, r.stdout);
  // a las 9 del 12, la segunda ya venció por la fecha local: se dice ese mismo día, no a la noche
  r = A.avisar('2026-11-12T09:00:00-03:00');
  assert.match(r.stdout, /DEF-otra/, r.stdout);
  // y no se repite en el mismo día local
  r = A.avisar('2026-11-12T22:30:00-03:00');
  assert.strictEqual(r.stdout.trim(), '', r.stdout);
});

test('T16 Notice_StoryMovedToAnotherWorktree @story-8.252 @ac-8 — la carpeta de la corrida se borró: la historia se busca en su repo', () => {
  const E = entorno();
  // la corrida trabajó en otra carpeta del repo, que se borró después del merge
  const wt = path.join(path.dirname(E.repo), 'wt-borrado');
  E.git('worktree', 'add', '-q', '-b', 'wt/borrado', wt);
  const storyEnWt = path.join(wt, 'specs', 'story-9.9-deuda-en-vivo.md');
  E.git('worktree', 'remove', '--force', wt);
  assert.ok(!fs.existsSync(storyEnWt));
  const comun = path.join(E.repo, '.git');
  const A = avisoDeLaDeuda([
    deudaDe(storyEnWt, { storyRel: path.join('specs', 'story-9.9-deuda-en-vivo.md'), repoCommon: comun }),
    deudaDe(path.join(A0(), 'story-9.9-sin-repo.md'), { deuda: 'DEF-sin-repo' }),
  ]);
  const r = A.avisar('2026-11-20T12:00:00Z');
  const dicho = r.stdout.split('\n').filter(Boolean);
  // la encontró en el checkout principal: la mira y dice qué falta, no «no pude mirar»
  const encontrada = dicho.find((l) => l.includes(DEUDA));
  assert.ok(encontrada, r.stdout);
  assert.match(encontrada, /siguen sin evidencia en vivo: AC 1, 2/);
  // sin dónde buscarla, sigue diciendo que no pudo mirar
  assert.match(dicho.find((l) => l.includes('DEF-sin-repo')) || '', /no pude mirar: la historia ya no está/);
});
// una carpeta que no existe
function A0() { return path.join(os.tmpdir(), `expected-red-no-existe-${process.pid}`); }

test('T17 Notice_PaidDebtStaysClosed @story-8.252 @ac-8 — la historia eximida o la deuda pagada se cierran; después de pagada, el código que cambia no la reabre', () => {
  // eximida: la matriz está verde, la deuda queda pagada
  const X = entorno();
  fs.writeFileSync(X.story, fs.readFileSync(X.story, 'utf8').replace('status: ready-for-dev', 'status: ready-for-dev\ndod_runtime_exempt: true'));
  let A = avisoDeLaDeuda([deudaDe(X.story)]);
  let r = A.avisar('2026-11-20T12:00:00Z');
  assert.strictEqual(r.stdout.trim(), '', r.stdout);
  assert.match(fs.readFileSync(path.join(A.estado, 'gates.log'), 'utf8'), /"acmatrix-debt-paid"/);
  // pagada con un humo antes de vencer, y el código cambia después: no vuelve
  const E = entorno();
  A = avisoDeLaDeuda([deudaDe(E.story, { until: '2026-11-30' })]);
  LEDGER.append({ dodDir: path.join(E.repo, '.advisors', 'dod-runtime'), gatesLog: path.join(A.estado, 'gates.log'), story: '9.9', acs: [1, 2] });
  r = A.avisar('2026-11-20T12:00:00Z');
  assert.strictEqual(r.stdout.trim(), '', r.stdout);
  assert.match(fs.readFileSync(path.join(A.estado, 'gates.log'), 'utf8'), /"acmatrix-debt-paid"/);
  fs.writeFileSync(path.join(E.repo, 'src', 'a.js'), 'module.exports = 2;\n');
  r = A.avisar('2026-12-05T12:00:00Z');
  assert.strictEqual(r.stdout.trim(), '', r.stdout);
});

test('T18 Notice_UnreadableLogIsSaid @story-8.252 @ac-8 — un gates.log que no se lee, o un renglón de deuda roto, se dice: no medido no es limpio', () => {
  let A = avisoDeLaDeuda(['{"name":"acmatrix-debt", roto']);
  let r = A.avisar('2026-11-20T12:00:00Z');
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /no pude mirar del todo — 1 renglón\(es\) de deuda de evidencia ilegibles/);
  A = avisoDeLaDeuda(null);
  fs.mkdirSync(path.join(A.estado, 'gates.log'));
  r = A.avisar('2026-11-20T12:00:00Z');
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /deuda de evidencia en vivo: no pude mirar del todo — no pude leer/);
  // sin gates.log no hay deudas: no dice nada
  A = avisoDeLaDeuda(null);
  r = A.avisar('2026-11-20T12:00:00Z');
  assert.strictEqual(r.stdout.trim(), '', r.stdout);
});

test('T19 Notice_RunsWithoutMailbox @story-8.252 @ac-8 — el aviso corre desde un gancho que se instala siempre', () => {
  // la lista de ganchos tiene un gancho por renglón
  const renglones = fs.readFileSync(path.join(RAIZ, 'scripts', 'setup', 'hooks-list.json'), 'utf8').split('\n');
  const fin = renglones.filter((l) => l.includes('"@tcg:finished-open-notice.js"'));
  assert.strictEqual(fin.length, 1, 'finished-open-notice.js está una vez en la lista de ganchos');
  assert.match(fin[0], /"when": "always"/);
  assert.match(fs.readFileSync(FINISHED, 'utf8'), /debtNotice\(/);
});

test('T20 Matrix_AcCellReadLikeTheMatrix @story-8.252 @ac-2 — la celda AC se lee como la lee la matriz: «—», «4b», «n/a» y «todos» no la vuelven ilegible; una fila sin id no deja cubrir su criterio', () => {
  const rmx = require(path.join(SCRIPTS, 'runtime-matrix.js'));
  for (const [celda, acs] of [['—', []], ['n/a', []], ['4b', [4]], ['2, 2a', [2]], ['1.3', [1]], ['1-2', [1, 2]]]) {
    const c = rmx.acsDeLaCelda(celda);
    assert.ok(c.legible, celda);
    assert.deepStrictEqual(c.acs, acs, celda);
  }
  assert.ok(rmx.acsDeLaCelda('todos').todos);
  assert.strictEqual(rmx.acsDeLaCelda('a definir').legible, false);
  const criterios = [1, 2, 3].map((n) => `${n}. **Given** algo ${n}, **Then** resultado ${n}.`);
  // una regresión sin criterio y un subcriterio no apagan la deuda
  const L = entorno({ acs: criterios, filas: ['| T1 | `a.uno` | 1 | unit | x | y |', '| T2 | `a.dos` | 2b | unit | x | y |', '| T3 | `a.tres` | 3 | unit | x | y |', '| T4 | `reg` | — | unit | x | y |'] });
  let m = rmx.compute({ storyPath: L.story });
  assert.deepStrictEqual(m.unreadableTests, []);
  assert.deepStrictEqual(rmx.debtCoverage(m, ['T1', 'T2', 'T3']).covered, [1, 2, 3]);
  // «todos» nombra cada criterio: tiene que estar en la lista para cubrir cualquiera
  const T = entorno({ acs: criterios, filas: ['| T1 | `a.uno` | 1 | unit | x | y |', '| T2 | `a.dos` | 2 | unit | x | y |', '| T3 | `a.tres` | 3 | unit | x | y |', '| T5 | `todo` | todos | e2e | x | y |'] });
  m = rmx.compute({ storyPath: T.story });
  assert.deepStrictEqual(rmx.debtCoverage(m, ['T1', 'T2', 'T3']).covered, []);
  assert.deepStrictEqual(rmx.debtCoverage(m, ['T1', 'T2', 'T3', 'T5']).covered, [1, 2, 3]);
  // una prueba en vivo sin id que nombra el AC 1: el AC 1 no queda cubierto
  const S = entorno({ acs: criterios, filas: ['| T1 | `a.uno` | 1 | unit | x | y |', '|  | prueba en vivo del uno | 1 | e2e | x | y |', '| T2 | `a.dos` | 2 | unit | x | y |', '| T3 | `a.tres` | 3 | unit | x | y |'] });
  m = rmx.compute({ storyPath: S.story });
  const c = rmx.debtCoverage(m, ['T1', 'T2', 'T3']);
  assert.deepStrictEqual(c.covered, [2, 3]);
  assert.deepStrictEqual(c.uncovered, [1]);
});

test('T21 ExpectRed_UntilWithSpaces_SameFingerprint @story-8.252 @ac-9 — la fecha con espacios da la misma huella del lado del freno y del de marker.js', () => {
  const mc = require(path.join(SCRIPTS, 'lib', 'marker-command.js'));
  assert.strictEqual(mc.detalleDelRojoEsperado('acmatrix', ['T1'], ' 2026-11-20 '), mc.detalleDelRojoEsperado('acmatrix', ['T1'], '2026-11-20'));
  const E = paraElRojoEsperado('s-t21');
  const gate = spawnSync(process.execPath, [path.join(SCRIPTS, 'lib', 'run-close.js'), '--gate', '--session', 's-t21', '--command-stdin', '--shell', 'bash'], {
    input: `node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js expect-red acmatrix --tests T1 --until ' ${fecha(7)}'`,
    encoding: 'utf8', cwd: E.repo, env: { ...process.env, HOME: E.home, USERPROFILE: E.home, TYCON_HOME: '' },
  });
  assert.strictEqual(gate.status, 0, gate.stderr);
  assert.match(gate.stdout, new RegExp(`^detalle=${mc.detalleDelRojoEsperado('acmatrix', ['T1'], fecha(7))}$`, 'm'), gate.stdout);
});
