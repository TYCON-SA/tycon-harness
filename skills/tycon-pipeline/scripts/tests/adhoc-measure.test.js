'use strict';
/**
 * adhoc-measure.test.js —una sola medida de lo propio en el camino corto: el tope, la pantalla, los datos y el riesgo leen
 * lo mismo, con un solo criterio para lo anotado, la base y los repos que se miden. Una fila por caso de la tabla.
 *
 * Laboratorio por prueba: una HOME vacía, un repo con su `origin` (un repo desnudo local) y la rama del arreglo empujada,
 * y el carril firmado en el estado de esa HOME. El freno se llama como lo llama el gancho (`decidir`).
 *
 * stable-data: las horas de los carriles son las del momento; ninguna se compara con el reloj.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const REPO_DEL_ARNES = path.join(SCRIPTS, '..', '..', '..');
const SID = 'ses-medida';
const RAMA = 'story/la-medida';

const GIT_ENV = { GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@example.com', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@example.com' };
function sh(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const tmp = (t, pre) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), pre)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
function escribir(d, r, c = 'x\n') {
  const f = path.join(d, r);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, c);
  return f;
}

/** Un repo con `origin` (desnudo, local), `main` empujada y la rama del arreglo empujada con seguimiento. */
function repoConOrigin(t, nombre = 'repo') {
  const base = tmp(t, `medida-${nombre}-`);
  const origen = path.join(base, 'origen.git');
  const d = path.join(base, nombre);
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origen]);
  fs.mkdirSync(d);
  sh(d, 'init', '-q', '-b', 'main');
  escribir(d, 'LEEME.md', 'hola\n');
  sh(d, 'add', '-A');
  sh(d, 'commit', '-q', '-m', 'base');
  sh(d, 'remote', 'add', 'origin', origen);
  sh(d, 'push', '-q', 'origin', 'main');
  sh(d, 'checkout', '-q', '-b', RAMA);
  sh(d, 'push', '-q', '-u', 'origin', RAMA);
  return d;
}
/** Un repo sin `origin`, con un commit. */
function repoSolo(t, nombre = 'solo') {
  const d = tmp(t, `medida-${nombre}-`);
  sh(d, 'init', '-q', '-b', 'main');
  escribir(d, 'LEEME.md', 'hola\n');
  sh(d, 'add', '-A');
  sh(d, 'commit', '-q', '-m', 'base');
  return d;
}
function home(t) {
  const h = tmp(t, 'medida-home-');
  fs.mkdirSync(path.join(h, '.claude', '.tycon-pipeline', 'active'), { recursive: true });
  return h;
}
const estado = (h) => path.join(h, '.claude', '.tycon-pipeline');
const carrilPath = (h) => path.join(estado(h), 'adhoc', `${SID}.json`);

/** El carril firmado, como lo deja `marker.js adhoc set`. */
function carril(h, extra = {}) {
  const ahora = new Date().toISOString();
  fs.mkdirSync(path.join(estado(h), 'adhoc'), { recursive: true });
  fs.writeFileSync(carrilPath(h), JSON.stringify({ reason: 'el combo muestra el nombre completo', maxFiles: 8, files: [],
    declaredAt: ahora, lastTouch: ahora, firmadaEn: ahora, ...extra }));
  fs.appendFileSync(path.join(estado(h), 'gates.log'), `${JSON.stringify({ name: 'adhoc-lane-signed', status: 'ok', destino: SID, ts: ahora })}\n`);
}
const leerCarril = (h) => JSON.parse(fs.readFileSync(carrilPath(h), 'utf8'));
const origenDe = (d) => sh(d, 'remote', 'get-url', 'origin');
/** La base anotada como la deja `traerBase`, con el `origin` de hoy. */
const baseDe = (d, sha = sh(d, 'rev-parse', 'origin/main')) => ({ sha, traida: true, ts: new Date().toISOString(), origen: origenDe(d) });

function commitDeArchivos(d, prefijo, n, carpeta = 'src') {
  for (let i = 0; i < n; i++) escribir(d, `${carpeta}/${prefijo}${i}.js`, `// ${prefijo}${i}\n`);
  sh(d, 'add', '-A');
  sh(d, 'commit', '-q', '-m', `${prefijo}: ${n} archivos`);
}
function commitDe(d, rel, c = 'x\n') {
  escribir(d, rel, c);
  sh(d, 'add', '-A');
  sh(d, 'commit', '-q', '-m', rel);
}

const brake = () => require(path.join(SCRIPTS, 'lib', 'save-brake.js'));
const base = () => require(path.join(SCRIPTS, 'lib', 'adhoc-base.js'));
const decidir = (h, cwd, command = 'git commit -m x') => brake().decidir({ command, cwd, sid: SID, home: h });

const EL_TOPE = /pasó el tope|PASÓ EL TOPE/i;
const REVISORES = /faltan los revisores y el pase/;
const PANTALLA = /toca una pantalla/;
const NO_PUDE = /no pude medir/;
function frena(r, re, que = '') { assert.match((r && r.texto) || '', re, `${que} ${JSON.stringify(r)}`); }
function pregunta(r, que = '') { assert.ok(r && r.pregunta && !r.texto, `${que} ${JSON.stringify(r)}`); }
const bloqueos = (h) => {
  try { return fs.readFileSync(path.join(estado(h), 'gates.log'), 'utf8').split('\n').filter((l) => /"status":"blocked"/.test(l)); } catch (_) { return []; }
};
/** Cuántas veces se llama a una función de adhoc-base durante `fn`. */
function contar(nombres, fn) {
  const m = base();
  const originales = {};
  const veces = Object.fromEntries(nombres.map((n) => [n, 0]));
  for (const n of nombres) {
    originales[n] = m[n];
    m[n] = (...a) => { veces[n] += 1; return originales[n](...a); };
  }
  try { return { r: fn(), veces }; } finally { for (const n of nombres) m[n] = originales[n]; }
}
/** La rama con `n` archivos ajenos traídos de `main` y `origin/main` local atrasado: lo que trae el otro camino. */
function traidosPorOtroCamino(d, n, extras = []) {
  const atras = sh(d, 'rev-parse', 'origin/main');
  sh(d, 'checkout', '-q', 'main');
  for (let i = 0; i < n; i++) escribir(d, `src/de-otro${i}.js`, 'x\n');
  for (const rel of extras) escribir(d, rel, 'x\n');
  sh(d, 'add', '-A');
  sh(d, 'commit', '-q', '-m', 'de otro pedido');
  sh(d, 'push', '-q', 'origin', 'main');
  sh(d, 'checkout', '-q', RAMA);
  sh(d, 'merge', '-q', '--no-edit', 'main');
  sh(d, 'update-ref', 'refs/remotes/origin/main', atras);
  return atras;
}

// ── una sola medida ───────────────────────────────────────────────────────────────────────────────────────────────────

// 🔴 Falla con: una tercera medida, o las dos viejas como envoltorios.
test('T1 Medida_UnaSola_LasDosViejasNoExisten @story-8.190 @ac-1', () => {
  const m = base();
  assert.strictEqual(typeof m.medirLoPropio, 'function');
  assert.strictEqual(m.archivosDelCarril, undefined);
  assert.strictEqual(m.propiosDelCarril, undefined);
  for (const rel of ['lib/adhoc-base.js', 'lib/save-brake.js', 'lib/adhoc-screen.js', 'lib/source-signals.js', 'pipeline.js', 'marker.js']) {
    const txt = fs.readFileSync(path.join(SCRIPTS, rel), 'utf8');
    assert.doesNotMatch(txt, /archivosDelCarril|propiosDelCarril/, rel);
  }
});

// 🔴 Falla con: cada freno midiendo y trayendo `main` por su cuenta, o un freno que el reintento levantó anotado.
test('T2 Medida_LosFrenosLeenLaMisma_UnaVueltaDeMain @story-8.190 @ac-2', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  traidosPorOtroCamino(d, 12, ['src/app/ajena/page.tsx', 'src/auth/ajena.ts']);
  carril(h, { bases: { [d]: baseDe(d, sh(d, 'rev-parse', 'origin/main')) } });
  const { r, veces } = contar(['medirLoPropio', 'conBasesAlDia'], () => decidir(h, d));
  pregunta(r);
  // con lo ajeno contado en la primera medida, hay una vuelta de main y una segunda medida, y ninguna más
  assert.strictEqual(veces.medirLoPropio, 2, `medidas: ${veces.medirLoPropio}`);
  assert.strictEqual(veces.conBasesAlDia, 1, `vueltas de main: ${veces.conBasesAlDia}`);
  assert.deepStrictEqual(bloqueos(h), []);
});

test('T3 Medida_FrenoReal_UnRenglonEnElRegistro @story-8.190 @ac-2', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  commitDeArchivos(d, 'a', 9);
  carril(h, { bases: { [d]: baseDe(d) } });
  frena(decidir(h, d), EL_TOPE);
  assert.strictEqual(bloqueos(h).length, 1, bloqueos(h).join('\n'));
});

// ── caso 1: lo anotado sin cambios ────────────────────────────────────────────────────────────────────────────────────

test('T4 Medida_C1_RestauradoNoSumaAlTope @story-8.190 @ac-3', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  commitDeArchivos(d, 'quieto', 3);
  sh(d, 'push', '-q', 'origin', `HEAD:main`);
  sh(d, 'fetch', '-q', 'origin');
  carril(h, { maxFiles: 1, files: [0, 1, 2].map((i) => path.join(d, 'src', `quieto${i}.js`)), bases: { [d]: baseDe(d) } });
  pregunta(decidir(h, d));
});

test('T5 Medida_C1_RestauradoNoPideMaqueta @story-8.190 @ac-3', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  commitDe(d, 'src/app/combo/page.tsx', 'export default () => null;\n');
  sh(d, 'push', '-q', 'origin', 'HEAD:main');
  sh(d, 'fetch', '-q', 'origin');
  carril(h, { files: [path.join(d, 'src', 'app', 'combo', 'page.tsx')], bases: { [d]: baseDe(d) } });
  pregunta(decidir(h, d));
});

test('T6 Medida_C1_QueEntroDeMainNoPideRevisores @story-8.190 @ac-3', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  commitDe(d, 'src/auth/x.ts');
  sh(d, 'push', '-q', 'origin', 'HEAD:main');
  sh(d, 'fetch', '-q', 'origin');
  carril(h, { files: [path.join(d, 'src', 'auth', 'x.ts')] });
  pregunta(decidir(h, d));
  assert.strictEqual(leerCarril(h).riesgoAlto, undefined);
});

test('T7 Medida_C1_IgnoradoYConBanderaSuman @story-8.190 @ac-4', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  commitDe(d, '.gitignore', 'src/ig*.js\n');
  commitDe(d, 'src/bandera.js');
  commitDe(d, 'src/sinCambios.js');
  sh(d, 'update-index', '--skip-worktree', 'src/bandera.js');
  sh(d, 'update-index', '--assume-unchanged', 'src/sinCambios.js');
  escribir(d, 'src/bandera.js', 'cambiado\n');
  escribir(d, 'src/sinCambios.js', 'cambiado\n');
  const anotados = [escribir(d, 'src/ig0.js'), escribir(d, 'src/ig1.js'), path.join(d, 'src', 'bandera.js'), path.join(d, 'src', 'sinCambios.js')];
  sh(d, 'push', '-q', 'origin', 'HEAD:main');
  sh(d, 'fetch', '-q', 'origin');
  // cupo 3: los dos ignorados solos no alcanzan; con los dos de bandera, sí
  carril(h, { maxFiles: 3, files: anotados, bases: { [d]: baseDe(d) } });
  frena(decidir(h, d), EL_TOPE);
  assert.deepStrictEqual(base().cuentaDelCarril(leerCarril(h)).archivos.map((f) => path.basename(f)).sort(), ['bandera.js', 'ig0.js', 'ig1.js', 'sinCambios.js']);
});

test('T8 Medida_C1_SinBaseLoAnotadoSuma @story-8.190 @ac-4', (t) => {
  const d = repoSolo(t);
  const h = home(t);
  commitDeArchivos(d, 'quieto', 2);
  carril(h, { maxFiles: 1, files: [0, 1].map((i) => path.join(d, 'src', `quieto${i}.js`)) });
  frena(decidir(h, d), EL_TOPE);
  const log = fs.readFileSync(path.join(estado(h), 'gates.log'), 'utf8');
  assert.match(log, /no se midió/);
});

// ── caso 2: la marca de riesgo que entra a `rutas` ────────────────────────────────────────────────────────────────────

function marcaSinSeguir(t) {
  const d = repoConOrigin(t);
  const h = home(t);
  commitDeArchivos(d, 'p', 5);
  escribir(d, 'src/auth/y.ts');
  carril(h, { maxFiles: 5, bases: { [d]: baseDe(d) } });
  return { d, h, ajeno: path.join(d, 'src', 'auth', 'y.ts') };
}

test('T9 Medida_C2_MarcaNoEntraARutasNiSuma @story-8.190 @ac-5', (t) => {
  const { d, h, ajeno } = marcaSinSeguir(t);
  for (const vuelta of [1, 2]) {
    frena(decidir(h, d), REVISORES, `vuelta ${vuelta}`);
    assert.ok(!(leerCarril(h).rutas || []).includes(ajeno), `vuelta ${vuelta}: ${JSON.stringify(leerCarril(h).rutas)}`);
  }
});

test('T10 Medida_C2_LosRevisoresVenElArchivoDeLaMarca @story-8.190 @ac-5', (t) => {
  const { d, h } = marcaSinSeguir(t);
  frena(decidir(h, d), REVISORES);
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'pipeline.js'), 'advisors', '--adhoc'], { cwd: d, encoding: 'utf8',
    env: { ...process.env, HOME: h, USERPROFILE: h, CLAUDE_CODE_SESSION_ID: SID }, timeout: 120000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /src\/auth\/y\.ts/);
});

test('T11 Medida_C2_MarcaLevantadaNoDejaRastro @story-8.190 @ac-6', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  const salida = sh(d, 'rev-parse', 'origin/main');
  sh(d, 'checkout', '-q', 'main');
  commitDe(d, 'src/auth/w.ts');
  sh(d, 'push', '-q', 'origin', 'main');
  sh(d, 'checkout', '-q', RAMA);
  sh(d, 'merge', '-q', '--no-edit', 'main');
  commitDeArchivos(d, 'p', 1);
  const w = path.join(d, 'src', 'auth', 'w.ts');
  carril(h, { maxFiles: 1, rutas: [w], bases: { [d]: baseDe(d, salida) },
    riesgoAlto: { regla: 'rutas-sensibles', archivo: w, motivo: 'de otro pedido', ts: new Date().toISOString() } });
  for (const vuelta of [1, 2]) pregunta(decidir(h, d), `vuelta ${vuelta}`);
  assert.ok(!(leerCarril(h).rutas || []).includes(w));
});

// ── caso 3: la base anotada rota ──────────────────────────────────────────────────────────────────────────────────────

const ROTA = 'a'.repeat(40);
function baseRota(t) {
  const d = repoConOrigin(t);
  const h = home(t);
  commitDe(d, 'src/auth/r.ts');
  carril(h, { bases: { [d]: { sha: ROTA, traida: true, origen: origenDe(d) } } });
  return { d, h };
}

test('T12 Medida_C3_BaseRotaConRed_FrenaElRiesgoYRenueva @story-8.190 @ac-7', (t) => {
  const { d, h } = baseRota(t);
  frena(decidir(h, d), REVISORES);
  assert.notStrictEqual(leerCarril(h).bases[d].sha, ROTA);
});

test('T13 Medida_C3_BaseRotaSinRedConCopia_FrenaElRiesgo @story-8.190 @ac-8', (t) => {
  const { d, h } = baseRota(t);
  fs.renameSync(origenDe(d), `${origenDe(d)}-movido`);
  frena(decidir(h, d), REVISORES);
});

test('T14 Medida_C3_BaseRotaSinRedSinCopia_DiceLaSalida @story-8.190 @ac-9', (t) => {
  const o = repoConOrigin(t, 'original');
  const raiz = tmp(t, 'medida-clon-');
  const d = path.join(raiz, 'clon');
  const r = spawnSync('git', ['clone', '-q', '--single-branch', '-b', RAMA, origenDe(o), d], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  commitDe(d, 'src/auth/r.ts');
  const h = home(t);
  carril(h, { bases: { [d]: { sha: ROTA, traida: true, origen: origenDe(d) } } });
  fs.renameSync(origenDe(o), `${origenDe(o)}-movido`);
  const f = decidir(h, d);
  assert.ok(f && f.texto, JSON.stringify(f));
  assert.match(f.texto, /base anotada/);
  assert.match(f.texto, /repet/i);
  assert.match(f.texto, /cerr[aá] y reabr/i);
  assert.doesNotMatch(f.texto, /git no contestó/);
});

// ── caso 4: rama atrasada y copia local atrasada ──────────────────────────────────────────────────────────────────────

test('T15 Medida_C4_RamaAtrasada_LoDeMainNoSuma @story-8.190 @ac-10', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  const salida = sh(d, 'rev-parse', 'HEAD');
  sh(d, 'checkout', '-q', 'main');
  commitDeArchivos(d, 'de-main', 9);
  sh(d, 'push', '-q', 'origin', 'main');
  sh(d, 'checkout', '-q', RAMA);
  commitDeArchivos(d, 'propio', 1);
  carril(h, { bases: { [d]: baseDe(d, salida) } });
  pregunta(decidir(h, d));
  assert.strictEqual(base().cuentaDelCarril(leerCarril(h)).archivos.length, 1);
});

test('T16 Medida_C4_CopiaLocalAtrasada_PreguntaSinBloqueo @story-8.190 @ac-11', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  const atras = traidosPorOtroCamino(d, 12);
  carril(h, { bases: { [d]: baseDe(d, atras) } });
  pregunta(decidir(h, d));
  assert.deepStrictEqual(bloqueos(h), []);
});

// ── caso 5: otro `origin` ─────────────────────────────────────────────────────────────────────────────────────────────

const MISMAS = [
  ['https://github.com/acme/app.git', 'git@github.com:acme/app.git'],
  ['https://github.com/acme/app', 'ssh://git@github.com/acme/app.git'],
  ['https://usuario:token@10.0.0.7/acme/app.git', 'https://10.0.0.7/acme/app/'],
  ['https://github.com/acme/app.git', 'https://GitHub.com/acme/app/'],
  ['ssh://git@github.com:22/acme/app.git', 'git@github.com:acme/app'],
  ['https://dev.azure.com/acme/proy/_git/app', 'git@ssh.dev.azure.com:v3/acme/proy/app'],
  ['https://acme.visualstudio.com/proy/_git/app', 'https://dev.azure.com/acme/proy/_git/app'],
  ['file:///tmp/x/origen.git', '/tmp/x/origen.git'],
  ['/tmp/x/origen.git/', '/tmp/x/origen.git'],
];
test('T17 MismoOrigen_FormasDeLaMismaRemota @story-8.190 @ac-12', () => {
  for (const [a, b] of MISMAS) {
    assert.strictEqual(base().mismoOrigen(a, b), true, `${a} = ${b}`);
    assert.strictEqual(base().mismoOrigen(b, a), true, `${b} = ${a}`);
  }
});

test('T18 MismoOrigen_RemotasDistintas @story-8.190 @ac-12', () => {
  for (const [a, b] of [
    ['https://github.com/acme/app.git', 'https://github.com/otro/app.git'],
    ['git@github.com:acme/app.git', 'git@github.com:acme/api.git'],
    ['https://github.com/acme/app', 'https://gitlab.com/acme/app'],
    ['https://dev.azure.com/acme/proy/_git/app', 'https://dev.azure.com/acme/proy/_git/api'],
    ['https://github.com/acme/app', ''],
  ]) assert.strictEqual(base().mismoOrigen(a, b), false, `${a} ≠ ${b}`);
});

test('T19 Medida_C5_OtraFormaDeUrl_UsaLaIntegracion @story-8.190 @ac-12', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  const atras = traidosPorOtroCamino(d, 12);
  carril(h, { bases: { [d]: baseDe(d, atras) } });
  sh(d, 'remote', 'set-url', 'origin', `file://${origenDe(d)}`);
  pregunta(decidir(h, d));
  assert.notStrictEqual(leerCarril(h).bases[d].sha, atras, 'la base se renovó');
});

function fork(t, d) {
  const f = path.join(tmp(t, 'medida-fork-'), 'fork.git');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', f]);
  sh(d, 'push', '-q', f, 'HEAD:main');
  return f;
}

test('T20 Medida_C5_ForkConBase_CuentaYNoTrae @story-8.190 @ac-13', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  const b = baseDe(d);
  commitDeArchivos(d, 'a', 9);
  sh(d, 'remote', 'set-url', 'origin', fork(t, d));
  const antes = sh(d, 'rev-parse', 'origin/main');
  carril(h, { bases: { [d]: b } });
  frena(decidir(h, d), EL_TOPE);
  assert.strictEqual(sh(d, 'rev-parse', 'origin/main'), antes, 'no se corrió el fetch');
});

test('T21 Medida_C5_BaseAusenteDeOtroOrigen_DiceLaSalida @story-8.190 @ac-14', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  commitDeArchivos(d, 'a', 1);
  carril(h, { bases: { [d]: { sha: ROTA, traida: true, origen: origenDe(d) } } });
  sh(d, 'remote', 'set-url', 'origin', fork(t, d));
  const f = decidir(h, d);
  assert.ok(f && f.texto, JSON.stringify(f));
  assert.match(f.texto, /el origin cambió/);
  assert.match(f.texto, /cerr[aá] y reabr/i);
  assert.doesNotMatch(f.texto, /git no contestó/);
});

test('T22 TraerBase_SinRed_AnotaElOrigen @story-8.190 @ac-15', (t) => {
  const d = repoConOrigin(t);
  const url = origenDe(d);
  fs.renameSync(url, `${url}-movido`);
  const b = base().traerBase(d);
  assert.strictEqual(b.traida, false);
  assert.strictEqual(b.origen, url);
});

test('T23 Medida_C5_BaseSinOrigen_NoSeLeCreeAlFork @story-8.190 @ac-15', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  commitDeArchivos(d, 'a', 9);
  const f = fork(t, d);
  sh(d, 'remote', 'set-url', 'origin', f);
  sh(d, 'fetch', '-q', 'origin');
  const vieja = { sha: null, traida: false, motivo: 'sin red' };
  carril(h, { bases: { [d]: vieja } });
  const r = decidir(h, d);
  assert.ok(r && r.texto, JSON.stringify(r));
  assert.match(r.texto, /cerr[aá] y reabr/i, 'la misma salida del AC 14');
  assert.deepStrictEqual(leerCarril(h).bases[d], vieja, 'conBasesAlDia no la renueva');
  // con su `sha`, se mide desde ahí: los 9 propios cuentan, y la base sigue igual
  const conSha = { sha: sh(d, 'rev-parse', 'HEAD~1'), traida: true };
  commitDeArchivos(d, 'mas', 8);
  carril(h, { bases: { [d]: conSha } });
  frena(decidir(h, d), EL_TOPE);
  assert.deepStrictEqual(leerCarril(h).bases[d], conSha, 'conBasesAlDia no la renueva');
});

// ── caso 6: qué repo se mide ──────────────────────────────────────────────────────────────────────────────────────────

function nueveEnLaSesion(t) {
  const d = repoConOrigin(t);
  const h = home(t);
  commitDeArchivos(d, 'a', 9);
  carril(h);
  return { d, h, fuera: tmp(t, 'medida-fuera-') };
}

test('T24 Medida_C6_LectorNoSeguro_MideLaSesion @story-8.190 @ac-16', (t) => {
  const { d, h, fuera } = nueveEnLaSesion(t);
  for (const command of ['eval "$CMD"', `pushd ${fuera} && popd && git push origin x`, `false && cd ${fuera}; git commit -m x`,
    `if false; then cd ${fuera}; fi; git commit -m x`, `cd ${fuera} | cat; git commit -m x`, `cd ${fuera} & git commit -m x`, 'git -C .git push origin x']) {
    frena(decidir(h, d, command), EL_TOPE, command);
  }
});

test('T25 Medida_C6_CondicionalHaciaOtroRepo_MideLosDos @story-8.190 @ac-16', (t) => {
  const { d, h } = nueveEnLaSesion(t);
  const otro = repoConOrigin(t, 'otro');
  frena(decidir(h, d, `false && cd ${otro}; git commit -m x`), EL_TOPE);
});

test('T26 Medida_C6_QueNoSeLee_TambienMideElRiesgo @story-8.190 @ac-19', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  commitDe(d, 'src/auth/x.ts');
  carril(h);
  frena(decidir(h, d, 'eval "$CMD"'), REVISORES);
  const c = leerCarril(h);
  assert.ok(c.bases && c.bases[d], JSON.stringify(c.bases));
  const antes = base().huellaDelCarril(c);
  escribir(d, 'src/auth/x.ts', 'cambiado\n');
  assert.notStrictEqual(base().huellaDelCarril(leerCarril(h)), antes, 'la huella mide el archivo');
});

test('T27 Medida_C6_PedidoDesdeOtraCarpeta_MideLaSesion @story-8.190 @ac-17', (t) => {
  const { d, h, fuera } = nueveEnLaSesion(t);
  frena(decidir(h, d, `cd ${fuera} && gh pr create --repo o/r --head x --title t`), EL_TOPE);
});

test('T28 Medida_C6_GuardadoEnOtraCarpeta_NoCobraLaSesion @story-8.190 @ac-18', (t) => {
  const { d, h, fuera } = nueveEnLaSesion(t);
  for (const command of [`cd ${fuera} && git init -q && git add -A && git commit -m x`, `git -C ${fuera} commit -m x`]) {
    pregunta(decidir(h, d, command), command);
  }
});

test('T29 Medida_C6_CdSeguroAOtroRepo_SoloMideEse @story-8.190 @ac-18', (t) => {
  const { d, h } = nueveEnLaSesion(t);
  const otro = repoConOrigin(t, 'otro');
  pregunta(decidir(h, d, `cd ${otro} && git commit -m x`));
});

test('T30 Lector_PushdPopd_VuelveALaCarpeta @story-8.190 @ac-16', (t) => {
  const d = repoConOrigin(t);
  const fuera = tmp(t, 'medida-fuera-');
  const h = home(t);
  const ida = brake().leerComando(`pushd ${fuera} && popd && git push`, d, 0, [], h);
  assert.deepStrictEqual(ida.cs.map((c) => c.dir), [d]);
  const sinPushd = brake().leerComando('popd && git push', d, 0, [], h);
  assert.strictEqual(sinPushd.segura, false);
  assert.strictEqual(brake().leerComando(`cd ${fuera} && git commit -m x`, d, 0, [], h).segura, true);
});

// ── caso 7: `git add -N` en un repo sin commits ───────────────────────────────────────────────────────────────────────

function sinCommits(t) {
  const d = tmp(t, 'medida-sin-commits-');
  sh(d, 'init', '-q', '-b', 'main');
  return d;
}

test('T31 Medida_C7_AddNRiesgoSinCommits @story-8.190 @ac-20', (t) => {
  const d = sinCommits(t);
  const h = home(t);
  escribir(d, 'src/auth/l.ts');
  sh(d, 'add', '-N', 'src/auth/l.ts');
  carril(h);
  frena(decidir(h, d, 'git commit -a -m i'), REVISORES);
});

test('T32 Medida_C7_AddNNueveSinCommits @story-8.190 @ac-20', (t) => {
  const d = sinCommits(t);
  const h = home(t);
  for (let i = 0; i < 9; i++) escribir(d, `src/n${i}.js`);
  sh(d, 'add', '-N', 'src');
  carril(h);
  frena(decidir(h, d, 'git commit -a -m i'), EL_TOPE);
});

test('T33 Medida_C7_AddNRamaHuerfana @story-8.190 @ac-20', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  sh(d, 'switch', '-q', '--orphan', 'nueva');
  escribir(d, 'src/auth/o.ts');
  sh(d, 'add', '-N', 'src/auth/o.ts');
  carril(h);
  frena(decidir(h, d, 'git commit -a -m i'), REVISORES);
});

// ── caso 8: worktree anidado borrado con su rama viva ─────────────────────────────────────────────────────────────────

test('T34 Medida_C8_MarcaDeWorktreeBorrado_Queda @story-8.190 @ac-21', (t) => {
  for (const conBase of [true, false]) {
    const d = repoConOrigin(t);
    const h = home(t);
    const wt = path.join(d, 'wt');
    sh(d, 'worktree', 'add', '-q', '-b', 'story/w', wt);
    commitDe(wt, 'src/auth/m.ts');
    const archivo = path.join(wt, 'src', 'auth', 'm.ts');
    const bases = { [d]: baseDe(d) };
    if (conBase) bases[wt] = baseDe(wt);
    carril(h, { bases, riesgoAlto: { regla: 'rutas-sensibles', archivo, motivo: 'de prueba', ts: new Date().toISOString() } });
    sh(d, 'worktree', 'remove', '--force', wt);
    sh(d, 'push', '-q', 'origin', 'story/w');
    frena(decidir(h, d), REVISORES, conBase ? 'con su base' : 'sin su base');
    assert.ok(leerCarril(h).riesgoAlto, 'la marca queda');
  }
});

test('T35 Medida_C8_RutaDeWorktreeBorrado_NoTraeAlDeAfuera @story-8.190 @ac-22', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  const wt = path.join(d, 'wt');
  sh(d, 'worktree', 'add', '-q', '-b', 'story/w', wt);
  const ruta = escribir(wt, 'src/x.js');
  sh(d, 'worktree', 'remove', '--force', wt);
  commitDeArchivos(d, 'a', 9);
  const tercero = repoConOrigin(t, 'tercero');
  carril(h, { files: [ruta] });
  pregunta(decidir(h, tercero));
});

test('T36 Medida_C8_CarpetaBorradaConocida_SiTraeSuRepo @story-8.190 @ac-22', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  commitDe(d, 'src/app/vieja/page.tsx');
  sh(d, 'push', '-q', 'origin', 'HEAD:main');
  sh(d, 'fetch', '-q', 'origin');
  const b = baseDe(d);
  const pantalla = path.join(d, 'src', 'app', 'vieja', 'page.tsx');
  sh(d, 'rm', '-q', '-r', 'src/app/vieja');
  sh(d, 'commit', '-q', '-m', 'sin la pantalla');
  commitDeArchivos(d, 'a', 9);
  carril(h, { files: [pantalla], bases: { [d]: b } });
  assert.ok(base().reposDelCarril({ files: [pantalla] }).includes(d), 'reposDelCarril trae su repo');
  frena(decidir(h, d), EL_TOPE);
});

// ── caso 9: una ruta real con `$` ya borrada ──────────────────────────────────────────────────────────────────────────

test('T37 Medida_C9_RutaConPesosBorrada_EsDelCarril @story-8.190 @ac-23', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  commitDe(d, 'app/routes/$x.js');
  commitDeArchivos(d, 'a', 9);
  const ruta = path.join(d, 'app', 'routes', '$x.js');
  sh(d, 'rm', '-q', '--', 'app/routes/$x.js');
  sh(d, 'commit', '-q', '-m', 'sin la ruta');
  const otro = repoConOrigin(t, 'otro');
  carril(h, { files: [ruta] });
  assert.deepStrictEqual(base().reposDelCarril({ files: [ruta] }), [d], 'es una ruta: su repo es del carril');
  frena(decidir(h, d), EL_TOPE, 'en su repo');
  // con su repo en el carril, un guardado en otro repo ya no es de este carril: no se le cobra
  assert.strictEqual(decidir(h, otro), null, 'en el otro');
});

test('T38 Medida_C9_VariableSinExpandir_NoEsRuta @story-8.190 @ac-23', (t) => {
  const d = repoConOrigin(t);
  const otro = repoConOrigin(t, 'otro');
  const h = home(t);
  commitDeArchivos(otro, 'a', 9);
  carril(h, { files: [path.join(otro, '$L', 'p.js')] });
  pregunta(decidir(h, d));
});

// ── caso 10: un empuje con otra forma ─────────────────────────────────────────────────────────────────────────────────

function sinSeguirAjenos(t) {
  const d = repoConOrigin(t);
  const h = home(t);
  for (let i = 0; i < 9; i++) escribir(d, `src/ajeno${i}.js`);
  carril(h, { bases: { [d]: baseDe(d) } });
  const dir = path.join(h, '.claude', 'shell-snapshots');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'snapshot-zsh-1-medida.sh'), ["alias -- gp='git push'", 'empujar () {', '  git push "$@"', '}', ''].join('\n'));
  return { d, h };
}

test('T39 Medida_C10_EmpujeSolo_NoCuentaLoSinSeguir @story-8.190 @ac-24', (t) => {
  const { d, h } = sinSeguirAjenos(t);
  for (const command of ['VAR=1 git push', 'env A=1 git push', '/usr/bin/git push', 'gp', 'empujar', 'git push | cat', 'git push && echo listo',
    'git push 2>&1 | tail -3', 'git fetch && git push', 'git status; git push', '{ git push; }', 'git push', 'git push 2>&1']) {
    pregunta(decidir(h, d, command), command);
  }
});

test('T40 Medida_C10_EmpujeConAlgoMas_Cuenta @story-8.190 @ac-25', (t) => {
  const { d, h } = sinSeguirAjenos(t);
  escribir(d, 'x.sh', '#!/bin/sh\ngit add -A\n');
  fs.chmodSync(path.join(d, 'x.sh'), 0o755);
  sh(d, 'config', 'alias.subir', '!git add -A && git push');
  // los que parecen sólo mostrar texto y corren o escriben con sus opciones
  for (const command of ['git add -A && git push', "bash -c 'git add -A && git push'", 'eval "git add -A && git push"', '(git add -A) && git push',
    'git add -A & git push', 'git push < <(git add -A)', './x.sh && git push', 'git subir', 'rg --pre ./x.sh algo && git push',
    'sort -o salida.txt LEEME.md && git push', 'uniq LEEME.md otro.txt && git push']) {
    frena(decidir(h, d, command), EL_TOPE, command);
  }
});

// ── caso 11: una ruta real llamada como una carpeta de pruebas ────────────────────────────────────────────────────────

function conPantalla(t, rel) {
  const d = repoConOrigin(t);
  const h = home(t);
  commitDe(d, rel, 'export default () => null;\n');
  carril(h, { files: [path.join(d, rel)], bases: { [d]: baseDe(d) } });
  return decidir(h, d);
}

test('T41 AdhocScreen_C11_RutaRealComoPrueba_PideMaqueta @story-8.190 @ac-26', (t) => {
  for (const rel of ['src/app/tests/page.tsx', 'src/app/e2e/page.tsx', 'src/app/cypress/page.tsx', 'src/app/playwright/page.tsx', 'src/components/e2e/X.tsx']) {
    frena(conPantalla(t, rel), PANTALLA, rel);
  }
});

test('T42 AdhocScreen_C11_CarpetaDePruebas_NoPide @story-8.190 @ac-27', (t) => {
  for (const rel of ['tests/Foo.tsx', 'e2e/Foo.tsx', 'cypress/Foo.tsx', 'playwright/Foo.tsx', 'apps/web/e2e/Foo.tsx', 'packages/ui/tests/Foo.tsx',
    'src/__tests__/Foo.tsx', 'src/x/Foo.test.tsx']) {
    pregunta(conPantalla(t, rel), rel);
  }
});

// 🔴 Falla con: un archivo movido en la rama y editado después, que pierde su ruta vieja: un pipeline mudado y borrado no
// pide revisores (pase adversarial, 7/11).
test('T54 Medida_MovidoYEditado_GuardaLaRutaVieja @story-8.190 @ac-1', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  commitDe(d, 'azure-pipelines.yml', 'trigger: none\n');
  sh(d, 'push', '-q', 'origin', 'HEAD:main');
  sh(d, 'fetch', '-q', 'origin');
  fs.mkdirSync(path.join(d, 'docs'));
  sh(d, 'mv', 'azure-pipelines.yml', 'docs/viejo-pipeline.txt');
  sh(d, 'commit', '-q', '-m', 'mudado');
  fs.appendFileSync(path.join(d, 'docs', 'viejo-pipeline.txt'), 'una línea más\n');
  sh(d, 'add', '-A');
  carril(h, { bases: { [d]: baseDe(d) } });
  const m = base().medirLoPropio(leerCarril(h));
  assert.ok(base().rutasDe(m, leerCarril(h), { como: 'todo' })[d].includes('azure-pipelines.yml'), JSON.stringify(m.porRepo[d]));
  frena(decidir(h, d), REVISORES);
});

// 🔴 Falla con: un `cd` que el lector lee mal (`cd -- X`) o que sigue adentro de otro texto (`bash -c`, `eval`) dado por
// seguro: el repo donde de verdad se guarda no se mide (pase adversarial, 7/11).
test('T55 Lector_CdConOpcionesOAdentro_NoAsegura @story-8.190 @ac-16', (t) => {
  const { d, h, fuera } = nueveEnLaSesion(t);
  const leer = (command) => brake().leerComando(command, d, 0, [], h);
  for (const command of [`cd -- ${fuera} && git commit -m x`, `cd -P -- ${fuera} && git commit -m x`, `bash -c "false && cd ${fuera}; git commit -m x"`,
    `eval "false && cd ${fuera}; git commit -m x"`]) {
    assert.strictEqual(leer(command).segura, false, command);
    frena(decidir(h, d, command), EL_TOPE, command);
  }
  assert.strictEqual(leer(`cd ${fuera} && git commit -m x`).segura, true);
});

// ── modos de falla ────────────────────────────────────────────────────────────────────────────────────────────────────

test('T43 Medida_GitNoContesta_NoGuardaYHuellaIncompleta @story-8.190 @ac-28', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  commitDeArchivos(d, 'a', 1);
  carril(h, { files: [path.join(d, 'src', 'a0.js')], bases: { [d]: baseDe(d) } });
  fs.writeFileSync(path.join(d, '.git', 'HEAD'), 'basura\n');
  frena(decidir(h, d), NO_PUDE);
  assert.ok(base().huellaDelCarril(leerCarril(h)).startsWith('incompleta:'));
});

// 🔴 Falla con: un error dentro del freno de riesgo que deja guardar con un aviso.
test('T53 Medida_ElRiesgoQueFalla_NoGuarda @story-8.190 @ac-28', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  commitDe(d, 'src/auth/x.ts');
  carril(h, { bases: { [d]: baseDe(d) } });
  const rp = require(path.join(SCRIPTS, 'lib', 'risk-paths.js'));
  const original = rp.riesgoDeArchivos;
  rp.riesgoDeArchivos = () => { throw new Error('la regla de riesgo se rompió'); };
  try {
    const r = decidir(h, d);
    frena(r, NO_PUDE);
    assert.match(r.texto, /riesgo alto/);
  } finally { rp.riesgoDeArchivos = original; }
  // un error de la medida misma, fuera de lo que mide cada repo: tampoco guarda (no sube al gancho, que afuera deja pasar)
  const realpath = fs.realpathSync;
  const m = base();
  carril(h, { files: [path.join(d, 'src', 'auth', 'x.ts')], bases: { [d]: baseDe(d) } });
  const carrilLeido = leerCarril(h);
  fs.realpathSync = () => { throw new Error('el disco no contestó'); };
  let r2;
  try { r2 = m.medirLoPropio(carrilLeido); } finally { fs.realpathSync = realpath; }
  assert.ok(r2.fallas.length, JSON.stringify(r2));
  // la carpeta de un guardado que git no pudo ubicar no es «fuera de un repo»
  const q = m.reposQueSeMiden({ adhoc: { reason: 'x' }, cs: [{ tipo: 'commit', dir: '/en/ninguna/parte' }], cwd: d, segura: true,
    raiz: () => null, ubicarRuta: () => ({ falla: 'git no contestó' }) });
  assert.strictEqual(q.fallas.length, 1, JSON.stringify(q));
});

test('T44 RepoConoce_AgotaElTiempo_CuentaComoConocida @story-8.190 @ac-29', (t) => {
  const d = repoConOrigin(t);
  const previo = process.env.TYCON_ADHOC_KNOWN_TIMEOUT_MS;
  process.env.TYCON_ADHOC_KNOWN_TIMEOUT_MS = '0';
  try {
    const avisos = [];
    assert.strictEqual(base().repoConoce(d, 'nunca/existio.js', avisos), true);
    assert.strictEqual(avisos.length, 1, avisos.join('\n'));
  } finally {
    if (previo === undefined) delete process.env.TYCON_ADHOC_KNOWN_TIMEOUT_MS; else process.env.TYCON_ADHOC_KNOWN_TIMEOUT_MS = previo;
  }
});

test('T45 Medida_RepoBorrado_AvisaSinFalla @story-8.190 @ac-30', (t) => {
  const borrada = path.join(tmp(t, 'medida-borrado-'), 'ya-no');
  const m = base().medirLoPropio({ reason: 'x', files: [], bases: { [borrada]: { sha: ROTA, traida: true, origen: '/x' } } });
  assert.strictEqual(m.avisos.length, 1, m.avisos.join('\n'));
  assert.deepStrictEqual(m.fallas, []);
});

// ── no-regresión ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('T46 Medida_Limites_OtraRamaYDevSiguenIgual @story-8.190 @ac-31', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  sh(d, 'checkout', '-q', '-b', 'otra');
  commitDeArchivos(d, 'otra', 9);
  sh(d, 'checkout', '-q', RAMA);
  carril(h, { bases: { [d]: baseDe(d) } });
  pregunta(decidir(h, d, 'git push origin otra'), 'el trabajo de otra rama no suma');
  const e = repoConOrigin(t, 'dev');
  const he = home(t);
  sh(e, 'checkout', '-q', '-b', 'dev', 'origin/main');
  commitDeArchivos(e, 'de-dev', 2);
  sh(e, 'push', '-q', 'origin', 'dev');
  sh(e, 'checkout', '-q', '-B', 'main', 'origin/main');
  commitDeArchivos(e, 'de-main', 3);
  sh(e, 'push', '-q', 'origin', 'main');
  sh(e, 'checkout', '-q', 'dev');
  sh(e, 'merge', '-q', '--no-edit', 'origin/main');
  carril(he);
  const contados = base().cuentaDelCarril(leerCarril(he), { repos: [e] }).archivos.map((f) => path.basename(f)).sort();
  // con `main` traído, la integración más cercana es `main`: lo que `dev` ya tenía integrado suma de más, hasta empujar
  assert.deepStrictEqual(contados, ['de-dev0.js', 'de-dev1.js'], 'en dev con main traído sin empujar, lo integrado suma');
  // pasar de 8 sigue siendo el click del dev: el freno lo dice
  sh(e, 'checkout', '-q', '-b', 'story/mucho', 'origin/main');
  commitDeArchivos(e, 'mucho', 9);
  frena(decidir(he, e), /click/);
});

test('T47 Medida_RiesgoDesdeDev_NoPideRevisores @story-8.190 @ac-32', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  sh(d, 'checkout', '-q', '-b', 'dev', 'origin/main');
  commitDe(d, 'src/auth/x.ts');
  sh(d, 'push', '-q', 'origin', 'dev');
  sh(d, 'checkout', '-q', '-b', 'story/de-dev');
  commitDeArchivos(d, 'propio', 1);
  // la base que anota el carril al primer toque: `main` traído
  carril(h, { bases: { [d]: baseDe(d) } });
  pregunta(decidir(h, d));
});

test('T48 Medida_TraerMainNoVenceLaConstancia @story-8.190 @ac-33', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  commitDeArchivos(d, 'propio', 1);
  carril(h, { files: [path.join(d, 'src', 'propio0.js')], bases: { [d]: baseDe(d) } });
  const antes = base().huellaDelCarril(leerCarril(h));
  sh(d, 'checkout', '-q', 'main');
  commitDeArchivos(d, 'de-otro', 3);
  sh(d, 'push', '-q', 'origin', 'main');
  sh(d, 'checkout', '-q', RAMA);
  sh(d, 'merge', '-q', '--no-edit', 'origin/main');
  assert.strictEqual(base().huellaDelCarril(leerCarril(h)), antes);
});

test('T49 Guia_LimitesDeLaMedida_AlDia @story-8.190 @ac-34', () => {
  for (const g of ['coordination.md', 'coordination.en.md']) {
    const txt = fs.readFileSync(path.join(REPO_DEL_ARNES, 'guides', g), 'utf8');
    const i = txt.search(/\*\*(Pasar el tope no pasa por vos|Going past the limit does not go through you)/);
    assert.ok(i >= 0, `${g}: el párrafo del tope`);
    const parrafo = txt.slice(i, txt.indexOf('\n\n', i));
    assert.doesNotMatch(parrafo, /`\| cat`|add -N|cuenta como prueba|counts as a test|cobra el tope de la rama de la sesión|charged the limit of the session/, g);
    assert.match(parrafo, /gh pr create/, `${g}: el pedido desde otra carpeta (AC 17)`);
    assert.match(parrafo, /nacida de `dev`|born from `dev`/, `${g}: lo que trae dev (AC 32)`);
  }
});

test('T50 Banco_CaminoCortoUnaMedida @story-8.190 @ac-34', () => {
  const dir = path.join(REPO_DEL_ARNES, 'scripts', 'controls-bench', 'cases', 'hooks');
  const archivo = fs.readdirSync(dir).find((f) => /camino-corto-una-medida\.json$/.test(f));
  assert.ok(archivo, 'el caso del banco existe');
  const casos = JSON.parse(fs.readFileSync(path.join(dir, archivo), 'utf8')).hooks.flatMap((x) => x.cases);
  const empuje = casos.find((c) => /\| cat/.test(c.stdin.tool_input.command));
  const conAdd = casos.find((c) => /git add -A/.test(c.stdin.tool_input.command));
  assert.ok(empuje && conAdd);
  assert.strictEqual(empuje.type, 'must-not-block');
  assert.strictEqual(conAdd.type, 'must-block');
});

// 🔴 Falla con: el freno de datos midiendo por su cuenta, o leyendo lo anotado que no cambió.
test('T51 Medida_Datos_LeeLaMismaMedida @story-8.190 @ac-2', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  commitDe(d, 'src/quieta.ts', 'executeQuery("a");\n');
  sh(d, 'push', '-q', 'origin', 'HEAD:main');
  sh(d, 'fetch', '-q', 'origin');
  commitDe(d, 'src/propia.ts', 'executeQuery("b");\n');
  carril(h, { files: [path.join(d, 'src', 'quieta.ts'), path.join(d, 'src', 'propia.ts')], bases: { [d]: baseDe(d) } });
  const ss = require(path.join(SCRIPTS, 'lib', 'source-signals.js'));
  const cargar = ss.cargar;
  ss.cargar = () => ({ senales: [{ id: 'proceso', strength: 'strong', files: ['**/*.ts'], pattern: 'executeQuery\\(', says: 'una llamada a un proceso' }], avisos: [] });
  try {
    const { r, veces } = contar(['medirLoPropio'], () => decidir(h, d));
    assert.match((r && r.texto) || '', /de dónde sale un dato/, JSON.stringify(r));
    assert.ok(veces.medirLoPropio >= 1 && veces.medirLoPropio <= 2, `medidas: ${veces.medirLoPropio}`);
    const archivos = leerCarril(h).frenoDatos.hallazgos.map((x) => x.file);
    assert.ok(archivos.every((f) => /propia\.ts/.test(f)), archivos.join(', '));
  } finally { ss.cargar = cargar; }
});
