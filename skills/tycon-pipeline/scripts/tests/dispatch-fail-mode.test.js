'use strict';
// El modo de falla de cada control del despachador de ediciones: un control que no carga, que no exporta `handle` o
// que tira deja su línea en hook-errors.log, y los críticos frenan la edición. `dispatch` termina con `process.exit` y
// lee la entrada de stdin, así que cada caso corre en un proceso aparte: un guion escrito acá carga `dispatch.js`,
// reemplaza la cadena del modo por una de una sola entrada y llama a `dispatch`. El HOME es temporal y el ambiente,
// limpio.
// stable-data: T13 lee el reloj a propósito: el carril que declara vence por edad contra Date.now(), así que su hora
// tiene que ser la de ahora; la fecha de FAIL_CLOSED_ON_THROW_FROM la prueba la inyecta con `hoy`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const DISPATCH = path.join(SCRIPTS, 'dispatch.js');
const STATE_DIR_LIB = path.join(SCRIPTS, 'lib', 'state-dir.js');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `tycon-fail-mode-${p}`));
const envDe = (home) => ({ PATH: process.env.PATH, HOME: home, USERPROFILE: home });

// la carpeta del estado de ese HOME, calculada por `stateDirOf` con el mismo ambiente limpio del gancho
function estadoDe(home) {
  const r = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(STATE_DIR_LIB)}).stateDir(process.env.HOME))`],
    { env: envDe(home), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
const registro = (home) => { try { return fs.readFileSync(path.join(estadoDe(home), 'hook-errors.log'), 'utf8'); } catch { return ''; } };

// El guion del proceso hijo: argv = dispatch.js, modo, entrada (JSON con la ruta ya puesta), hoy ('' = sin opciones)
const GUION = `
const [dispatchPath, mode, entrada, hoy] = process.argv.slice(2);
const d = require(dispatchPath);
const chain = d.CHAINS[mode];
chain.splice(0, chain.length, JSON.parse(entrada));
d.dispatch(mode, hoy ? { hoy } : undefined);
`;

/** Corre la cadena aislada. `modulo`: el texto del módulo de la entrada (o null si la entrada ya trae su `path`). */
function correr({ mode = 'pre-edit', entrada, modulo, hoy = '', evento, home = tmp('home-'), env = {} }) {
  const dir = tmp('cadena-');
  const guion = path.join(dir, 'correr.js');
  fs.writeFileSync(guion, GUION);
  const e = { ...entrada };
  if (modulo !== null && modulo !== undefined) {
    e.path = path.join(dir, `${e.name}.js`);
    fs.writeFileSync(e.path, modulo);
  }
  const input = JSON.stringify(evento || { session_id: 'prueba-fail-mode', tool_name: 'Write', cwd: dir,
    tool_input: { file_path: path.join(dir, 'src', 'Nuevo.cs'), content: 'class Nuevo {}' } });
  const r = spawnSync(process.execPath, [guion, DISPATCH, mode, JSON.stringify(e), hoy], { env: { ...envDe(home), ...env }, encoding: 'utf8', input });
  return { ...r, home, dir };
}

const ROTO = 'module.exports = { handle( ;\n';   // error de sintaxis: el módulo no carga
const SIN_HANDLE = 'module.exports = {};\n';
const TIRA = "module.exports = { handle() { throw new Error('se rompió adentro'); } };\n";

// ── el censo: cada entrada declara qué hace si no puede correr ──────────────────────────────────────

const TABLA = {
  'pre-edit': {
    'on-controls-off': 'closed', 'on-coordination-write': 'closed', 'on-story-gate': 'closed-on-state',
    'on-story-skill-gate': 'open', 'on-dod-evidence-guard': 'closed', 'on-frontmatter-write': 'closed',
    'on-atdd-preedit': 'open', 'on-red-test-edit': 'closed', 'on-write-collision': 'open', 'on-planning-artifact': 'open',
    'on-deprecated-edit': 'open',
  },
};
const MODOS = ['closed', 'open', 'closed-on-state'];

/** Los problemas del censo de `chains`: [] si cada entrada declara un modo válido y post-edit es todo `open`. */
function censoFailMode(chains, tabla = TABLA) {
  const out = [];
  for (const [mode, chain] of Object.entries(chains)) {
    for (const h of chain) {
      if (!('failMode' in h)) { out.push(`${mode}/${h.name}: sin failMode`); continue; }
      if (!MODOS.includes(h.failMode)) out.push(`${mode}/${h.name}: failMode fuera de ${MODOS.join('|')} (${h.failMode})`);
      if (mode === 'post-edit' && h.failMode !== 'open') out.push(`${mode}/${h.name}: post-edit tiene que ser open (${h.failMode})`);
      const esperado = tabla[mode] && tabla[mode][h.name];
      if (esperado && h.failMode !== esperado) out.push(`${mode}/${h.name}: ${h.failMode}, la tabla dice ${esperado}`);
    }
  }
  return out;
}

test('T9 Census_EveryEntryDeclaresFailMode @story-8.257 @ac-1', () => {
  const { CHAINS } = require(DISPATCH);
  assert.deepEqual(censoFailMode(CHAINS), []);
  assert.deepEqual(CHAINS['pre-edit'].map((h) => h.name).sort(), Object.keys(TABLA['pre-edit']).sort(), 'la tabla nombra todas las entradas de pre-edit');
  // la misma función da rojo con una copia a la que se le borra un failMode, o con un valor inventado
  const copia = JSON.parse(JSON.stringify({ 'pre-edit': CHAINS['pre-edit'], 'post-edit': CHAINS['post-edit'] }));
  delete copia['pre-edit'].find((h) => h.name === 'on-dod-evidence-guard').failMode;
  assert.ok(censoFailMode(copia).some((p) => /on-dod-evidence-guard: sin failMode/.test(p)));
  const otra = JSON.parse(JSON.stringify({ 'post-edit': CHAINS['post-edit'] }));
  otra['post-edit'][0].failMode = 'closed';
  assert.ok(censoFailMode(otra).some((p) => /post-edit tiene que ser open/.test(p)));
  otra['post-edit'][0].failMode = 'a-veces';
  assert.ok(censoFailMode(otra).some((p) => /fuera de/.test(p)));
});

test('T23 SpawnEntryFails_OpenAsToday @story-8.257 @ac-18 @ac-1', () => {
  const { CHAINS } = require(DISPATCH);
  for (const name of ['ado-story-create', 'followup-story-create']) {
    const h = CHAINS['post-edit'].find((x) => x.name === name);
    assert.ok(h && h.spawn, `${name} sigue siendo spawn`);
    assert.equal(h.failMode, 'open', `el censo cuenta ${name} como open`);
  }
  const dir = tmp('spawn-');
  const hijo = path.join(dir, 'sale-uno.js');
  fs.writeFileSync(hijo, 'process.exit(1);\n');
  const r = correr({ mode: 'post-edit', entrada: { name: 'spawn-que-falla', path: hijo, spawn: true, failMode: 'open' }, modulo: null });
  assert.equal(r.status, 0, r.stderr);
  assert.match(registro(r.home), /dispatch handler "spawn-que-falla" FAILED OPEN: /);
});

// ── un control que no corre lo dice ─────────────────────────────────────────────────────────────────

test('T3 ClosedEntryWithoutHandle_Blocks @story-8.257 @ac-3', () => {
  const r = correr({ entrada: { name: 'on-red-test-edit', failMode: 'closed' }, modulo: SIN_HANDLE });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /⛔ el control on-red-test-edit no carga \(.+\) y es de los que frenan: esta edición no pasa\. Reparalo: \/tycon-harness dice si el arnés quedó bien instalado/);
  assert.match(registro(r.home), /dispatch handler "on-red-test-edit" FAILED CLOSED: /);
});

test('T3b ClosedEntryDoesNotLoad_Blocks @story-8.257 @ac-3', () => {
  const r = correr({ entrada: { name: 'on-controls-off', failMode: 'closed' }, modulo: ROTO });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /⛔ el control on-controls-off no carga \(.*\) y es de los que frenan/);
  assert.match(registro(r.home), /dispatch handler "on-controls-off" FAILED CLOSED: /);
});

test('T4 OpenEntryWithoutHandle_PassesWithLine @story-8.257 @ac-4', () => {
  const r = correr({ entrada: { name: 'on-write-collision', failMode: 'open' }, modulo: SIN_HANDLE });
  assert.equal(r.status, 0, r.stderr);
  assert.match(registro(r.home), /dispatch handler "on-write-collision" FAILED OPEN: /);
  assert.match(r.stderr, /dispatch handler "on-write-collision" FAILED OPEN: /, 'stderr dice lo mismo que el registro');
});

test('T4b OpenEntryDoesNotLoad_OneLinePerCall @story-8.257 @ac-4 @ac-6', () => {
  // un patch de Codex con dos archivos: la línea va una sola vez por llamada
  const dir = tmp('patch-');
  const evento = { session_id: 'prueba-fail-mode', tool_name: 'apply_patch', cwd: dir, turn_id: 't1',
    tool_input: { command: `*** Begin Patch\n*** Add File: ${path.join(dir, 'a.txt')}\n+a\n*** Add File: ${path.join(dir, 'b.txt')}\n+b\n*** End Patch\n` } };
  // con el arnés a la vista, el despachador parte el patch en un evento por archivo (si no, la cuenta de abajo no prueba nada)
  const partido = spawnSync(process.execPath, ['-e', `process.stdout.write(String(require(${JSON.stringify(DISPATCH)}).prepareEvents(${JSON.stringify(evento)}).length))`],
    { env: { ...envDe(tmp('home-')), TYCON_GUIDES_DIR: path.join(SCRIPTS, '..', '..', '..') }, encoding: 'utf8' });
  assert.equal(partido.stdout, '2', partido.stderr);
  const r = correr({ entrada: { name: 'on-planning-artifact', failMode: 'open' }, modulo: ROTO, evento,
    env: { TYCON_GUIDES_DIR: path.join(SCRIPTS, '..', '..', '..') } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal((registro(r.home).match(/"on-planning-artifact" FAILED OPEN/g) || []).length, 1, registro(r.home));
});

// ── la excepción de un control cerrado: aviso hasta la fecha, después frena ─────────────────────────

test('T10 ClosedEntryThrows_NoticeThenBlocks @story-8.257 @ac-5', () => {
  const { FAIL_CLOSED_ON_THROW_FROM } = require(DISPATCH);
  assert.match(String(FAIL_CLOSED_ON_THROW_FROM), /^\d{4}-\d{2}-\d{2}$/);
  const antes = new Date(`${FAIL_CLOSED_ON_THROW_FROM}T12:00:00Z`);
  antes.setUTCDate(antes.getUTCDate() - 1);
  const r1 = correr({ entrada: { name: 'on-frontmatter-write', failMode: 'closed' }, modulo: TIRA, hoy: antes.toISOString().slice(0, 10) });
  assert.equal(r1.status, 0, r1.stderr);
  assert.ok(registro(r1.home).includes(`dispatch handler "on-frontmatter-write" FAILED OPEN (frena desde ${FAIL_CLOSED_ON_THROW_FROM}): `), registro(r1.home));
  const r2 = correr({ entrada: { name: 'on-frontmatter-write', failMode: 'closed' }, modulo: TIRA, hoy: FAIL_CLOSED_ON_THROW_FROM });
  assert.equal(r2.status, 2, r2.stderr);
  assert.match(r2.stderr, /⛔ el control on-frontmatter-write tiró \(se rompió adentro\) y es de los que frenan: esta edición no pasa/);
  assert.match(registro(r2.home), /dispatch handler "on-frontmatter-write" FAILED CLOSED: /);
});

test('T11 OpenEntryThrows_AsToday @story-8.257 @ac-5', () => {
  const r = correr({ entrada: { name: 'on-atdd-preedit', failMode: 'open' }, modulo: TIRA, hoy: '2099-01-01' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(registro(r.home), /dispatch handler "on-atdd-preedit" FAILED OPEN: Error: se rompió adentro/);
});

test('T12 IntegrationEntry_TreatedAsOpen @story-8.257 @ac-2', () => {
  // con failMode closed a propósito: una entrada de una integración se trata como open igual
  const r = correr({ entrada: { name: 'control-de-horas', integration: 'x', failMode: 'closed' }, modulo: ROTO });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /el control «control-de-horas» de la integración x no carga/);
  assert.match(registro(r.home), /dispatch handler "control-de-horas" FAILED OPEN: /);
});

// ── closed-on-state: frena sólo si la edición cae en la carpeta del estado ──────────────────────────

test('T6b StoryGateBroken_StateDecidesByPath @story-8.257 @ac-6', () => {
  const home = tmp('home-estado-');
  const estado = estadoDe(home);
  const dentro = correr({ home, entrada: { name: 'on-story-gate', failMode: 'closed-on-state' }, modulo: ROTO,
    evento: { session_id: 's', tool_name: 'Write', cwd: home, tool_input: { file_path: path.join(estado, 'active', 'x.json'), content: '{}' } } });
  assert.equal(dentro.status, 2, dentro.stderr);
  assert.match(registro(home), /dispatch handler "on-story-gate" FAILED CLOSED: /);
  // una ruta relativa con `..` que termina en la carpeta del estado también cae adentro
  const rel = path.relative(home, path.join(estado, 'x', '..', 'y.json'));
  const relativa = correr({ entrada: { name: 'on-story-gate', failMode: 'closed-on-state' }, modulo: ROTO, home,
    evento: { session_id: 's', tool_name: 'Write', cwd: home, tool_input: { file_path: rel, content: '{}' } } });
  assert.equal(relativa.status, 2, relativa.stderr);
  // sin file_path cuenta como adentro
  const sinRuta = correr({ entrada: { name: 'on-story-gate', failMode: 'closed-on-state' }, modulo: ROTO,
    evento: { session_id: 's', tool_name: 'Write', cwd: home, tool_input: {} } });
  assert.equal(sinRuta.status, 2, sinRuta.stderr);
  const fuera = correr({ entrada: { name: 'on-story-gate', failMode: 'closed-on-state' }, modulo: ROTO });
  assert.equal(fuera.status, 0, fuera.stderr);
  assert.match(registro(fuera.home), /dispatch handler "on-story-gate" FAILED OPEN: /);
});

test('T6c StoryGateBroken_PatchWithOneFileInState_Blocks @story-8.257 @ac-6', () => {
  // un patch de dos archivos, uno afuera y otro en la carpeta del estado: basta uno para frenar
  const home = tmp('home-patch-estado-');
  const estado = estadoDe(home);
  const dir = tmp('patch-mixto-');
  const evento = { session_id: 's', tool_name: 'apply_patch', cwd: dir, turn_id: 't1',
    tool_input: { command: `*** Begin Patch\n*** Add File: ${path.join(dir, 'a.txt')}\n+a\n*** Add File: ${path.join(estado, 'active', 'x.json')}\n+{}\n*** End Patch\n` } };
  const r = correr({ home, entrada: { name: 'on-story-gate', failMode: 'closed-on-state' }, modulo: ROTO, evento,
    env: { TYCON_GUIDES_DIR: path.join(SCRIPTS, '..', '..', '..') } });
  assert.equal(r.status, 2, r.stderr);
  assert.match(registro(home), /dispatch handler "on-story-gate" FAILED CLOSED: /);
});

test('T6d StoryGateBroken_DanglingLinkIntoState_Blocks @story-8.257 @ac-6', () => {
  // un enlace colgante que apunta a un archivo nuevo de la carpeta del estado: escribir por él crea el archivo adentro
  if (process.platform === 'win32') return;
  const home = tmp('home-enlace-');
  const estado = estadoDe(home);
  fs.mkdirSync(estado, { recursive: true });
  const dir = tmp('lab-enlace-');
  const enlace = path.join(dir, 'enlace.json');
  fs.symlinkSync(path.join(estado, 'nuevo.json'), enlace);
  const r = correr({ home, entrada: { name: 'on-story-gate', failMode: 'closed-on-state' }, modulo: ROTO,
    evento: { session_id: 's', tool_name: 'Write', cwd: dir, tool_input: { file_path: enlace, content: '{}' } } });
  assert.equal(r.status, 2, r.stderr);
  assert.match(registro(home), /dispatch handler "on-story-gate" FAILED CLOSED: /);
});

// ── la entrada ilegible ─────────────────────────────────────────────────────────────────────────────

test('T7b UnreadableInput_PreEditBlocks_PostEditPasses @story-8.257 @ac-7', () => {
  for (const crudo of ['', '{esto no es json', '42', 'null', '[]']) {
    const home = tmp('home-ilegible-');
    const pre = spawnSync(process.execPath, [path.join(SCRIPTS, 'hook-pre-edit.js')], { env: envDe(home), encoding: 'utf8', input: crudo });
    assert.equal(pre.status, 2, `pre-edit con ${JSON.stringify(crudo)}: ${pre.stderr}`);
    assert.match(pre.stderr, /⛔ el despachador de ediciones no pudo leer esta edición y la frenó: .+\. Reiniciá la sesión; si sigue, \/tycon-harness dice si el arnés quedó bien instalado/);
    const post = spawnSync(process.execPath, [path.join(SCRIPTS, 'hook-post-edit.js')], { env: envDe(home), encoding: 'utf8', input: crudo });
    assert.equal(post.status, 0, `post-edit con ${JSON.stringify(crudo)}: ${post.stderr}`);
    assert.match(registro(home), /dispatch FAILED OPEN: entrada ilegible/);
  }
});

// ── el registro que no se puede escribir no cambia la decisión ──────────────────────────────────────

test('T19 LogNotWritable_SameDecision @story-8.257 @ac-12', () => {
  for (const [failMode, esperado] of [['closed', 2], ['open', 0]]) {
    const home = tmp('home-sin-registro-');
    const estado = estadoDe(home);
    fs.mkdirSync(path.dirname(estado), { recursive: true });
    fs.writeFileSync(estado, 'no soy una carpeta');   // la carpeta del estado es un archivo: no se puede escribir adentro
    const r = correr({ home, entrada: { name: 'on-dod-evidence-guard', failMode }, modulo: ROTO });
    assert.equal(r.status, esperado, `${failMode}: ${r.stderr}`);
    assert.match(r.stderr, /on-dod-evidence-guard/, 'el motivo sale por stderr');
    assert.equal(fs.readFileSync(estado, 'utf8'), 'no soy una carpeta', 'no se escribió nada');
  }
});

// ── el portón de carril: repoContext no escribe; evaluate anota un renglón ──────────────────────────

test('T13 RepoContextThrows_WritesGatesLogLine @story-8.257 @ac-9', () => {
  const DISCOVERY = require.resolve(path.join(SCRIPTS, 'lib', 'story-discovery.js'));
  const IO = path.join(SCRIPTS, 'lib', 'story-gate-io.js');
  const io = require(IO);
  const dir = tmp('fuera-de-repo-');
  const file = path.join(dir, 'src', 'a.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x');
  const sid = 'prueba-repo-context';
  // un carril firmado por aviso con su lista: evaluate llama a repoContext dos veces
  const conCarril = (state) => {
    fs.mkdirSync(path.join(state, 'adhoc'), { recursive: true });
    const ts = new Date().toISOString();
    fs.writeFileSync(path.join(state, 'adhoc', `${sid}.json`), JSON.stringify({ reason: 'arreglo', maxFiles: 5, files: [], declaredAt: ts,
      lastTouch: ts, firmadaEn: ts, datos: 'sin-cambio', via: 'avisado', allowedFiles: [file] }));
    fs.appendFileSync(path.join(state, 'gates.log'), `${JSON.stringify({ ts, name: 'adhoc-lane-signed', status: 'ok', destino: sid })}\n`);
    return state;
  };
  const sano = conCarril(tmp('estado-sano-'));
  const sinError = io.evaluate({ filePath: file, sessionId: sid, cwd: dir, via: 'Edit', stateDir: sano, installedRoots: [] });

  const real = require.cache[DISCOVERY];
  require.cache[DISCOVERY] = { id: DISCOVERY, filename: DISCOVERY, loaded: true,
    exports: { findRepoRoot() { throw new Error('descubrimiento roto'); }, discoverStories() { throw new Error('descubrimiento roto'); } } };
  try {
    const state = conCarril(tmp('estado-roto-'));
    const antes = fs.readFileSync(path.join(state, 'gates.log'), 'utf8');
    const solo = io.repoContext(file);
    assert.match(String(solo.fallo), /descubrimiento roto/);
    assert.equal(solo.repoRoot, null);
    assert.equal(fs.readFileSync(path.join(state, 'gates.log'), 'utf8'), antes, 'repoContext solo no escribe');

    const r = io.evaluate({ filePath: file, sessionId: sid, cwd: dir, via: 'Edit', stateDir: state, installedRoots: [] });
    const nuevas = fs.readFileSync(path.join(state, 'gates.log'), 'utf8').slice(antes.length).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const unknown = nuevas.filter((o) => o.name === 'story-gate' && o.status === 'unknown');
    assert.equal(unknown.length, 1, JSON.stringify(nuevas));
    assert.match(unknown[0].reason, /descubrimiento roto/);
    assert.equal(r.verdict.action, sinError.verdict.action, 'el veredicto es el mismo que sin el error');
    assert.equal(r.verdict.kind, sinError.verdict.kind);
  } finally {
    if (real) require.cache[DISCOVERY] = real; else delete require.cache[DISCOVERY];
  }
});
