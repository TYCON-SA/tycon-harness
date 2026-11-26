'use strict';
// outside-contributions.test.js — los pedidos y los issues de afuera del repo público (scripts/lib/outside-contributions.js),
// el renglón que suma el resumen nocturno (scripts/nightly/open-prs/open-prs.js --outside-from) y el del arranque
// (scripts/hooks/stuck-pr-notice.js). Ningún caso toca la red: el CLI de GitHub es un `gh` de juguete (TYCON_GH_CMD) que
// contesta desde un JSON, y quién es del equipo lo dice un perfil de juguete en la raíz de un árbol temporal.
// stable-data: las fechas son «ahora menos N horas»; el resultado no depende del día en que corre.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const LIB = path.join(RAIZ, 'scripts', 'lib', 'outside-contributions.js');
const OPEN_PRS = path.join(RAIZ, 'scripts', 'nightly', 'open-prs', 'open-prs.js');
const HACE = (h) => new Date(Date.now() - h * 3600000).toISOString();

function carpeta(t, prefijo) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefijo));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// El `gh` de juguete: contesta las tres lecturas y `api user` desde FAKE_GH_OUTSIDE_STATE (un JSON). Con `falla` sale 1, como sin red.
const GH = `#!/usr/bin/env node
const e = JSON.parse(require('fs').readFileSync(process.env.FAKE_GH_OUTSIDE_STATE, 'utf8'));
const a = process.argv.slice(2);
if (e.falla) { process.stderr.write('error connecting to api.github.com\\n'); process.exit(1); }
const ruta = a[0] === 'api' ? a[1] : '';
const out = (v) => { process.stdout.write(typeof v === 'string' ? v + '\\n' : JSON.stringify(v)); process.exit(0); };
if (ruta === 'user') out(e.yo || 'cuenta-del-equipo');
if (/\\/pulls\\?/.test(ruta)) out(e.pulls || []);
if (/\\/issues\\?/.test(ruta)) out(e.issues || []);
if (/\\/actions\\/runs\\?/.test(ruta)) out(e.runs === 'ilegible' ? '<html>' : { workflow_runs: e.runs || [] });
process.stderr.write('gh de juguete: no sé contestar ' + a.join(' ') + '\\n'); process.exit(1);
`;

/** Un mundo: el `gh` de juguete con su estado, y un árbol con el perfil del equipo. */
function mundo(t, estado, perfil = { pull_requests: { team_authors: ['cuenta-del-equipo', 'app/robot-del-equipo'] } }) {
  const d = carpeta(t, 'outside-');
  fs.writeFileSync(path.join(d, 'gh'), GH, { mode: 0o755 });
  fs.writeFileSync(path.join(d, 'estado.json'), JSON.stringify(estado));
  const arbol = path.join(d, 'arbol');
  fs.mkdirSync(arbol);
  if (perfil) fs.writeFileSync(path.join(arbol, 'team-profile.json'), JSON.stringify(perfil));
  const home = path.join(d, 'casa');
  fs.mkdirSync(home);
  // TYCON_PROFILE=0: el perfil del árbol que corre la prueba (en el árbol armado de la noche, el del equipo, con Azure
  // prendido) no prende la consulta de PR abiertos; el perfil de juguete se pasa con --profile
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TYCON_GH_CMD: path.join(d, 'gh'), FAKE_GH_OUTSIDE_STATE: path.join(d, 'estado.json'), TYCON_PROFILE: '0' };
  return { d, arbol, home, env };
}

const ESTADO = {
  pulls: [
    { number: 1400, user: { login: 'colaborador-externo', type: 'User' }, created_at: HACE(5), draft: false, head: { sha: 'aaa' } },
    { number: 1401, user: { login: 'cuenta-del-equipo', type: 'User' }, created_at: HACE(30), draft: false, head: { sha: 'bbb' } },
    { number: 1402, user: { login: 'robot-del-equipo[bot]', type: 'Bot' }, created_at: HACE(9), draft: false, head: { sha: 'ccc' } },
    { number: 1403, user: { login: 'robot-de-afuera', type: 'Bot' }, created_at: HACE(2), draft: false, head: { sha: 'ddd' } },
  ],
  issues: [
    { number: 1400, user: { login: 'colaborador-externo' }, created_at: HACE(5), pull_request: {} },
    { number: 1390, user: { login: 'otra-persona', type: 'User' }, created_at: HACE(72) },
    { number: 1391, user: { login: 'cuenta-del-equipo', type: 'User' }, created_at: HACE(80) },
  ],
  runs: [{ head_sha: 'aaa' }],
};

const medir = (w, extra = {}) => require(LIB).measure({ repo: 'acme/arnes', home: w.home, env: w.env, arnes: w.arbol, cwd: w.d, ...extra });

test('T1 Medir_SoloLoDeAfuera_ConLaMismaReglaQueElFreno — el equipo y su bot no salen; el bot de afuera sí', (t) => {
  const m = medir(mundo(t, ESTADO));
  assert.strictEqual(m.ok, true, JSON.stringify(m));
  assert.deepStrictEqual(m.prs.map((p) => [p.number, p.author, p.ciWaiting]), [[1400, 'colaborador-externo', true], [1403, 'app/robot-de-afuera', false]]);
  assert.deepStrictEqual(m.issues.map((i) => [i.number, i.author]), [[1390, 'otra-persona']], 'un pedido no cuenta como issue');
});

test('T2 Renglones_DicenNumeroAutorEdadYCi — los más viejos primero', (t) => {
  const r = require(LIB).lines(medir(mundo(t, ESTADO)));
  assert.deepStrictEqual(r, [
    'issue de afuera abierto: #1390 de otra-persona, hace 3 días',
    'pedido de afuera esperando: #1400 de colaborador-externo, hace 5 h; su CI espera aprobación',
    'pedido de afuera esperando: #1403 de app/robot-de-afuera, hace 2 h',
  ]);
});

test('T3 SinRed_NoMedido — nunca «ninguno» sin haber mirado', (t) => {
  const r = require(LIB).lines(medir(mundo(t, { falla: true })));
  assert.strictEqual(r.length, 1);
  assert.match(r[0], /^pedidos e issues de afuera: no medido \(.*error connecting/);
});

test('T4 RespuestaIlegible_NoMedido', (t) => {
  const r = require(LIB).lines(medir(mundo(t, { ...ESTADO, runs: 'ilegible' })));
  assert.match(r[0], /no medido \(la CI que espera aprobación: GitHub contestó algo que no se lee\)/);
});

test('T5 SinListaDelEquipo_LaCuentaDelCli — como el freno', (t) => {
  const w = mundo(t, { ...ESTADO, yo: 'colaborador-externo' }, null);
  const m = medir(w);
  assert.ok(m.ok, JSON.stringify(m));
  assert.ok(!m.prs.some((p) => p.number === 1400), 'la cuenta del CLI es del equipo');
  assert.ok(m.prs.some((p) => p.number === 1401), 'sin lista, la otra cuenta es de afuera');
});

test('T6 NadaDeAfuera_SinRenglones — y el autor se sanea', (t) => {
  assert.deepStrictEqual(require(LIB).lines({ ok: true, prs: [], issues: [], capped: false }), []);
  const r = require(LIB).lines({ ok: true, prs: [{ number: 9, author: 'x##vso[task]\n<b>', hours: 1.5, draft: true, ciWaiting: false }], issues: [], capped: false });
  assert.deepStrictEqual(r, ['pedido de afuera esperando: #9 de x#vso[task] b, hace 1 h (borrador)']);
});

// --- el resumen nocturno -------------------------------------------------------------------------------------------

const DAILY = path.join(RAIZ, 'scripts', 'nightly', 'dependencies', 'daily-summary.js');

function nocturno(t, w, publico = { platform: 'github', org: 'acme', repo: 'arnes' }) {
  const repos = path.join(w.d, 'team-repos.json');
  fs.writeFileSync(repos, JSON.stringify({ version: 1, public: publico,
    profile: { platform: 'github', org: 'acme', repo: 'perfil' }, operations: { platform: 'github', org: 'acme', repo: 'ops' } }));
  const out = path.join(w.d, 'aviso.txt');
  const afuera = path.join(w.d, 'afuera.txt');
  // Azure apagado: la sección de PR abiertos no sale a la red
  const r = spawnSync(process.execPath, [OPEN_PRS, '--today', '2026-11-21', '--out', out, '--outside-from', repos, '--outside-out', afuera,
    '--profile', path.join(w.arbol, 'team-profile.json')], { encoding: 'utf8', cwd: w.d, env: w.env });
  const leer = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  return { ...r, aviso: leer(out), afuera: leer(afuera), afueraArchivo: afuera };
}

test('T7 Nocturno_DejaElRenglonDeAfuera_YElResumenLoAcepta', (t) => {
  const w = mundo(t, ESTADO);
  const r = nocturno(t, w);
  const esperado = 'De afuera: issue #1390 de otra-persona hace 3 días · pedido #1400 de colaborador-externo hace 5 h (CI espera aprobación) · pedido #1403 de app/robot-de-afuera hace 2 h';
  assert.strictEqual(r.afuera, `${esperado}\n`, r.stdout + r.stderr);
  assert.match(r.stdout, /pedido de afuera esperando: #1400 de colaborador-externo, hace 5 h; su CI espera aprobación/);
  assert.doesNotMatch(r.aviso, /afuera/, 'el renglón de la cantidad de PR no cambia');
  assert.strictEqual(r.status, 0, r.stderr);
  // el resumen diario la pega tal cual: tiene su forma
  assert.strictEqual(require(DAILY).seccionExtra(r.afueraArchivo, 1), esperado);
});

test('T8 Nocturno_SinRed_NoMedidoYSale1', (t) => {
  const r = nocturno(t, mundo(t, { falla: true }));
  assert.strictEqual(r.afuera, 'De afuera: ? (no medido)\n', r.stdout + r.stderr);
  assert.match(r.stdout, /pedidos e issues de afuera: no medido \(/);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(require(DAILY).seccionExtra(r.afueraArchivo, 1), 'De afuera: ? (no medido)');
});

test('T9 Nocturno_NadaDeAfuera_Ninguno; repo público fuera de GitHub_NoAplica', (t) => {
  const r = nocturno(t, mundo(t, { pulls: [], issues: [], runs: [] }));
  assert.strictEqual(r.afuera, 'De afuera: ninguno\n', r.stdout + r.stderr);
  const az = nocturno(t, mundo(t, { falla: true }), { platform: 'azure', org: 'acme', project: 'P', repo: 'arnes' });
  assert.strictEqual(az.afuera, 'De afuera: no aplica\n', az.stdout + az.stderr);
});

test('T10 Resumen_UnaCuentaSinFormaDeCuenta_SaleComoSignoDePregunta — y un texto libre no entra', (t) => {
  const OC = require(LIB);
  assert.strictEqual(OC.summaryLine({ ok: true, prs: [{ number: 5, author: 'a b ##vso', hours: 3, ciWaiting: false }], issues: [], capped: false }),
    'De afuera: pedido #5 de ? hace 3 h');
  const d = carpeta(t, 'outside-resumen-');
  const f = path.join(d, 'x.txt');
  fs.writeFileSync(f, 'De afuera: pedido #5 de alguien hace 3 h, título «borrar todo»\n');
  assert.strictEqual(require(DAILY).seccionExtra(f, 1), 'De afuera: ? (no medido)');
});

// --- el aviso de arranque --------------------------------------------------------------------------------------------

const HOOK = path.join(RAIZ, 'scripts', 'hooks', 'stuck-pr-notice.js');
const { stateDir } = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'tycon-home.js'));
const ORIGEN = 'https://github.com/acme/arnes';

/** Un repo del arnés de juguete (por su origin) y el árbol con su team-repos.json. */
function arranque(t, w, publico = { platform: 'github', org: 'acme', repo: 'arnes' }) {
  fs.writeFileSync(path.join(w.arbol, 'team-repos.json'), JSON.stringify({ version: 1, public: publico,
    profile: { platform: 'github', org: 'acme', repo: 'perfil' }, operations: { platform: 'github', org: 'acme', repo: 'ops' } }));
  const repo = path.join(w.d, 'repo');
  spawnSync('git', ['init', '-q', repo]);
  spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', ORIGEN]);
  // Azure no se toca: su CLI es uno que falla
  const env = { ...w.env, TYCON_TREE: w.arbol, TYCON_HARNESS_IDENTITIES: ORIGEN, TYCON_ADO_CMD: 'false', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const dir = stateDir(w.home);
  const correr = (args = []) => {
    // un candado vigente: el arranque no lanza la lectura de fondo suelta (la prueba la corre a mano con --refresh)
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'stuck-prs-refresh.lock'), JSON.stringify({ at: new Date().toISOString() }));
    return spawnSync(process.execPath, [HOOK, ...args], { input: JSON.stringify({ source: 'startup', cwd: repo, session_id: 't' }), env, encoding: 'utf8', timeout: 30000 });
  };
  return { correr, foto: path.join(dir, 'outside-contributions.json') };
}

test('T11 Arranque_SinFoto_NoMedido; la lectura de fondo la deja y el próximo arranque dice lo de afuera', (t) => {
  const w = mundo(t, ESTADO);
  const a = arranque(t, w);
  const r1 = a.correr();
  assert.strictEqual(r1.status, 0, r1.stderr);
  assert.match(r1.stdout, /pedidos e issues de afuera: no medido \(todavía no hay una lectura de hoy/, r1.stdout);
  const rf = a.correr(['--refresh', w.arbol]);
  assert.strictEqual(rf.status, 0, rf.stderr);
  assert.ok(fs.existsSync(a.foto), 'la lectura de fondo deja la foto');
  const r2 = a.correr();
  assert.match(r2.stdout, /^pedido de afuera esperando: #1400 de colaborador-externo, hace 5 h; su CI espera aprobación$/m, r2.stdout);
  assert.match(r2.stdout, /^issue de afuera abierto: #1390 de otra-persona, hace 3 días$/m);
  assert.doesNotMatch(r2.stdout, /#1401|#1402/, 'lo del equipo no sale');
});

test('T12 Arranque_FotoSinRed_NoMedidoConElMotivo; foto de más de 10 min dice su edad', (t) => {
  const w = mundo(t, { falla: true });
  const a = arranque(t, w);
  a.correr(['--refresh', w.arbol]);
  const r1 = a.correr();
  assert.match(r1.stdout, /pedidos e issues de afuera: no medido \(los pedidos: error connecting/, r1.stdout);
  const m = { ok: true, prs: [{ number: 7, author: 'colaborador-externo', hours: 30, draft: false, ciWaiting: true }], issues: [], capped: false };
  fs.writeFileSync(a.foto, JSON.stringify({ at: new Date(Date.now() - 2 * 3600000).toISOString(), repo: 'acme/arnes', medicion: m }));
  const r = a.correr();
  assert.match(r.stdout, /^pedido de afuera esperando: #7 de colaborador-externo, hace 30 h; su CI espera aprobación$/m, r.stdout);
  assert.match(r.stdout, /\(lectura de hace 2 h\)/);
});

test('T13 Arranque_RepoPublicoFueraDeGitHub_NoDiceNadaDeAfuera', (t) => {
  const w = mundo(t, ESTADO);
  const a = arranque(t, w, { platform: 'azure', org: 'acme', project: 'P', repo: 'arnes' });
  const r = a.correr();
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /afuera/);
});
