'use strict';
// merge-metrics.test.js — el archivo de métricas de cada merge: la mudanza de los archivos colgados en
// el clon a la carpeta de estado, un archivo por merge cuando dos máquinas mandan el mismo, `juntar` con su constancia
// y la constancia leída por el nocturno. Más la lectura de los YAML de la noche (las copias de operaciones y del
// privado sólo si están: sin ellas, el caso dice «no medido», no verde). Git de verdad, sin red, un par de segundos.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const LIB = path.join(ROOT, 'scripts', 'lib', 'merge-metrics.js');
const MM = require(LIB);
const { METRICS } = require(path.join(ROOT, 'scripts', 'lib', 'dashboard-metrics.js'));

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-metrics-')); dirs.push(d); return d; };

function env(extra = {}) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(GIT_|TYCON_|BUILD_|SYSTEM_|TF_BUILD)/.test(k)) e[k] = v;
  return { ...e, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), 'merge-metrics-no-global'),
    GIT_AUTHOR_NAME: 'Lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'Lab', GIT_COMMITTER_EMAIL: 'lab@example.com',
    GIT_AUTHOR_DATE: '2026-10-25T10:00:00Z', GIT_COMMITTER_DATE: '2026-10-25T10:00:00Z', ...extra };
}
function git(dir, args) {
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', dir, ...args], { env: env(), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const write = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };

/** Un archivo 2.0 como el que escribe retro-heartbeat.js. `vueltas` null = sin volcado de la ejecución. */
function doc({ sha = 'a'.repeat(40), project = 'tycon-harness', repo = '/Users/a/tycon-harness', ts = '2026-10-25T10:00:00.000Z', vueltas = null, story = '8.1' } = {}) {
  const m = vueltas === null
    ? { value: null, unavailable_reason: 'sin volcado de ejecución para este repo+story' }
    : { value: vueltas };
  const metrics = {};
  for (const k of Object.keys(METRICS)) metrics[k] = { value: null, unavailable_reason: 'no la mide esta prueba' };
  metrics.advisor_rerun_loop_iterations = m;
  // generated_by es el campo del registro de siempre, armado como lo arma retro-heartbeat.js: no es la ruta del archivo
  return { schema_version: '2.0', project, captured_at: ts.slice(0, 10), ts, repo, merge_commit: sha, story, generated_by: ['retro', 'latido.js'].join('-'), metrics };
}
const nombre = (d) => `metrics-${d.captured_at}-${d.project}-${d.story}-${d.merge_commit.slice(0, 7)}.json`;
const texto = (d) => `${JSON.stringify(d, null, 2)}\n`;

/** Un clon de juguete con `.dashboard/`; `versionados` entran en un commit, `sueltos` quedan sin versionar. */
function clon({ versionados = [], sueltos = [], ignorada = false } = {}) {
  const c = path.join(tmp(), 'clon');
  fs.mkdirSync(c, { recursive: true });
  git(c, ['init', '--quiet', '-b', 'main']);
  write(path.join(c, 'README.md'), 'x\n');
  if (ignorada) write(path.join(c, '.gitignore'), '.dashboard/\n');
  for (const d of versionados) write(path.join(c, '.dashboard', nombre(d)), texto(d));
  git(c, ['add', '-A', '-f']);
  git(c, ['commit', '--quiet', '-m', 'base']);
  for (const d of sueltos) write(path.join(c, '.dashboard', typeof d === 'string' ? d : nombre(d)), typeof d === 'string' ? '{"schema_version":"1.0"}\n' : texto(d));
  return c;
}

// ── la mudanza ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('T12 Migrate_Untracked_MovedByteEqual @story-8.132 @ac-8: los sin versionar pasan a la carpeta de estado, iguales byte a byte, y el clon queda limpio', () => {
  const a = doc({ sha: '1'.repeat(40) }); const b = doc({ sha: '2'.repeat(40) });
  const c = clon({ sueltos: [a, b] });
  const antes = [a, b].map((d) => fs.readFileSync(path.join(c, '.dashboard', nombre(d))));
  const destino = path.join(tmp(), 'estado', 'dashboard');
  const r = MM.mudar(c, destino);
  assert.strictEqual(r.migrados, 2, JSON.stringify(r));
  assert.deepStrictEqual(r.dejados, []);
  [a, b].forEach((d, i) => assert.ok(fs.readFileSync(path.join(destino, nombre(d))).equals(antes[i]), `${nombre(d)} igual byte a byte`));
  assert.strictEqual(git(c, ['status', '--porcelain']), '', 'el clon queda limpio');
  assert.deepStrictEqual(fs.readdirSync(destino).filter((f) => f.startsWith('.')), [], 'ningún temporal suelto');
});

test('T13 Migrate_Tracked_Untouched @story-8.132 @ac-9: un archivo versionado no se toca', () => {
  const v = doc({ sha: '3'.repeat(40) }); const s = doc({ sha: '4'.repeat(40) });
  const c = clon({ versionados: [v], sueltos: [s] });
  const destino = path.join(tmp(), 'dashboard');
  const r = MM.mudar(c, destino);
  assert.strictEqual(r.migrados, 1);
  assert.ok(fs.existsSync(path.join(c, '.dashboard', nombre(v))), 'el versionado sigue en su lugar');
  assert.ok(git(c, ['ls-files']).split('\n').includes(`.dashboard/${nombre(v)}`), 'y en git ls-files');
  assert.ok(!fs.existsSync(path.join(destino, nombre(v))), 'el versionado no se copia');
});

test('T14 Migrate_Invalid_Left @story-8.132 @ac-10: uno que no es un archivo 2.0 válido queda en el clon y se nombra', () => {
  const malo = doc({ sha: '5'.repeat(40) }); delete malo.repo;
  const c = clon({ sueltos: ['metrics-2026-05-03.json', malo] });
  const destino = path.join(tmp(), 'dashboard');
  const r = MM.mudar(c, destino);
  assert.strictEqual(r.migrados, 0);
  assert.strictEqual(r.dejados.length, 2, JSON.stringify(r.dejados));
  const viejo = r.dejados.find((x) => x.archivo === 'metrics-2026-05-03.json');
  assert.match(viejo.motivo, /no es un archivo 2\.0/);
  assert.match(r.dejados.find((x) => x.archivo === nombre(malo)).motivo, /no pasa la validación/);
  assert.ok(fs.existsSync(path.join(c, '.dashboard', 'metrics-2026-05-03.json')), 'queda en el clon');
});

test('T15 Migrate_NameClash_NeverOverwrites @story-8.132 @ac-10: nunca pisa otro contenido; el mismo contenido sí cuenta como mudado', () => {
  const d = doc({ sha: '6'.repeat(40) });
  const c = clon({ sueltos: [d] });
  const destino = path.join(tmp(), 'dashboard');
  const otro = texto({ ...d, ts: '2026-10-25T11:00:00.000Z' });
  write(path.join(destino, nombre(d)), otro);
  const r = MM.mudar(c, destino);
  assert.strictEqual(r.migrados, 0);
  assert.match(r.dejados[0].motivo, /ya hay otro con ese nombre/);
  assert.strictEqual(fs.readFileSync(path.join(destino, nombre(d)), 'utf8'), otro, 'el de la carpeta de estado no se pisa');
  assert.ok(fs.existsSync(path.join(c, '.dashboard', nombre(d))), 'el original sigue');
  // el mismo contenido: el original se borra y cuenta
  write(path.join(destino, nombre(d)), texto(d));
  const r2 = MM.mudar(c, destino);
  assert.strictEqual(r2.migrados, 1, JSON.stringify(r2));
  assert.ok(!fs.existsSync(path.join(c, '.dashboard', nombre(d))), 'el original se borró');
});

test('T15b Migrate_OriginalVanished_NotError @story-8.132 @ac-10: si el original desaparece entre la copia y el borrado, no es un error', () => {
  const d = doc({ sha: '7'.repeat(40) });
  const c = clon({ sueltos: [d] });
  const destino = path.join(tmp(), 'dashboard');
  const original = path.join(c, '.dashboard', nombre(d));
  // un fs envuelto: justo antes de borrar el original, otro proceso ya lo borró
  const envuelto = { ...fs, unlinkSync: (p) => { if (p === original) { fs.unlinkSync(p); } return fs.unlinkSync(p); } };
  const r = MM.mudar(c, destino, { fs: envuelto });
  assert.strictEqual(r.migrados, 1, JSON.stringify(r));
  assert.deepStrictEqual(r.dejados, []);
  assert.strictEqual(fs.readFileSync(path.join(destino, nombre(d)), 'utf8'), texto(d), 'la copia verificada');
});

test('T16 Migrate_GitFails_MovesNothing @story-8.132 @ac-11: sin saber qué está sin versionar, no se mueve nada', () => {
  const noRepo = path.join(tmp(), 'no-repo');
  write(path.join(noRepo, '.dashboard', nombre(doc())), texto(doc()));
  const destino = path.join(tmp(), 'dashboard');
  const r = MM.mudar(noRepo, destino);
  assert.strictEqual(r.migrados, 0);
  assert.match(r.dejados[0].motivo, /no pude saber cuáles están sin versionar/);
  assert.ok(fs.existsSync(path.join(noRepo, '.dashboard', nombre(doc()))));
  // un git que sale 128 en un repo de verdad
  const c = clon({ sueltos: [doc({ sha: '8'.repeat(40) })] });
  const r2 = MM.mudar(c, destino, { git: () => ({ status: 128, stdout: '', stderr: 'fatal: roto' }) });
  assert.strictEqual(r2.migrados, 0);
  assert.match(r2.dejados[0].motivo, /no pude saber cuáles están sin versionar/);
  assert.ok(!fs.existsSync(destino) || fs.readdirSync(destino).length === 0, 'nada se movió');
});

test('T17 Migrate_IgnoredFolder_MovesAll @story-8.132 @ac-8: con .dashboard/ ignorada (el clon del público) se mudan todos', () => {
  const a = doc({ sha: '9'.repeat(40) }); const b = doc({ sha: 'b'.repeat(40) });
  const c = clon({ sueltos: [a, b], ignorada: true });
  const destino = path.join(tmp(), 'dashboard');
  const r = MM.mudar(c, destino);
  assert.strictEqual(r.migrados, 2, JSON.stringify(r));
  assert.deepStrictEqual(fs.readdirSync(path.join(c, '.dashboard')), []);
});

test('Colgados_y_Pendientes @story-8.132 @ac-8: colgados nombra sólo los sin versionar; pendientes lista los de la carpeta', () => {
  const v = doc({ sha: 'c'.repeat(40) }); const s = doc({ sha: 'd'.repeat(40) });
  const c = clon({ versionados: [v], sueltos: [s] });
  const r = MM.colgados(c);
  assert.strictEqual(r.error, null);
  assert.deepStrictEqual(r.archivos.map((p) => path.basename(p)), [nombre(s)]);
  assert.deepStrictEqual(MM.pendientes(path.join(c, '.dashboard')).map((x) => x.f), [nombre(v), nombre(s)].sort());
  assert.deepStrictEqual(MM.pendientes(path.join(tmp(), 'no-existe')), []);
  assert.strictEqual(MM.carpetaLocal('/x/estado'), path.join('/x/estado', 'dashboard'));
});

test('Pendientes_Unreadable_SaysSo @story-8.132 @ac-11: una carpeta que no se puede leer no es «nada que subir» ni «nada que mudar»', () => {
  const archivo = path.join(tmp(), 'no-es-carpeta');
  fs.writeFileSync(archivo, 'x');
  assert.throws(() => MM.pendientes(archivo), (e) => e.code === 'ENOTDIR');
  const c = clon({ versionados: [], sueltos: [] });
  fs.rmSync(path.join(c, '.dashboard'), { recursive: true, force: true });
  fs.writeFileSync(path.join(c, '.dashboard'), 'x');
  const r = MM.colgados(c);
  assert.deepStrictEqual(r.archivos, []);
  assert.match(String(r.error), /ENOTDIR/);
});

// ── un archivo por merge ───────────────────────────────────────────────────────────────────────────────────────────

test('T18 OnePerMerge_PrefersRoundsThenNewest @story-8.132 @ac-12: gana el que trae vueltas; entre iguales el más nuevo; nunca une repos distintos', () => {
  const sha = 'e'.repeat(40);
  const conNull = { doc: doc({ sha, repo: '/Users/a/x', ts: '2026-10-25T12:00:00.000Z' }), id: 'null-nuevo' };
  const conVueltas = { doc: doc({ sha, repo: '/srv/b/x', ts: '2026-10-25T10:00:00.000Z', vueltas: 2 }), id: 'vueltas' };
  let r = MM.unoPorMerge([conNull, conVueltas]);
  assert.deepStrictEqual(r.elegidos.map((x) => x.id), ['vueltas']);
  assert.strictEqual(r.repetidos, 1);
  const viejo = { doc: doc({ sha, ts: '2026-10-25T09:00:00.000Z', vueltas: 1 }), id: 'viejo' };
  const nuevo = { doc: doc({ sha, ts: '2026-10-25T11:00:00.000Z', vueltas: 3 }), id: 'nuevo' };
  assert.deepStrictEqual(MM.unoPorMerge([viejo, nuevo]).elegidos.map((x) => x.id), ['nuevo']);
  // un sha de 7 con el mismo project se une
  const corto = { doc: doc({ sha: sha.slice(0, 7), ts: '2026-10-25T13:00:00.000Z' }), id: 'corto' };
  r = MM.unoPorMerge([corto, conVueltas]);
  assert.deepStrictEqual(r.elegidos.map((x) => x.id), ['vueltas']);
  // dos repos distintos con el mismo prefijo de 7 y otro project: quedan los dos
  const p1 = { doc: doc({ sha: 'f'.repeat(7), project: 'uno' }), id: 'uno' };
  const p2 = { doc: doc({ sha: 'f'.repeat(7), project: 'dos' }), id: 'dos' };
  assert.deepStrictEqual(MM.unoPorMerge([p1, p2]).elegidos.map((x) => x.id).sort(), ['dos', 'uno']);
  // mismoMerge directo: dos shas de 40 iguales con otro project son el mismo merge; prefijos que no coinciden, no
  assert.ok(MM.mismoMerge(doc({ sha, project: 'a' }), doc({ sha, project: 'b' })));
  assert.ok(!MM.mismoMerge(doc({ sha }), doc({ sha: '0'.repeat(40) })));
  assert.ok(!MM.mismoMerge(doc({ sha: 'abc' }), doc({ sha: 'abc' })), 'menos de 7 no alcanza');
});

test('OnePerMerge_OrderIndependent @story-8.132 @ac-12: un sha corto junto a dos completos de otro project es un solo merge, en cualquier orden', () => {
  const sha = 'abcdef1' + '0'.repeat(33);
  const casos = [
    [{ doc: doc({ sha: 'abcdef1', project: 'P' }), id: 'a' }, { doc: doc({ sha, project: 'Q' }), id: 'b' }, { doc: doc({ sha, project: 'P' }), id: 'c' }],
    [{ doc: doc({ sha: 'abcdef12', project: 'P' }), id: 'd' }, { doc: doc({ sha: 'abcdef1', project: 'P' }), id: 'e' }, { doc: doc({ sha: 'abcdef13', project: 'P' }), id: 'f' }],
  ];
  const ordenes = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (const items of casos) {
    for (const o of ordenes) {
      const r = MM.unoPorMerge(o.map((i) => items[i]));
      assert.strictEqual(r.elegidos.length, 1, `orden ${o.map((i) => items[i].id).join('')}: ${r.elegidos.map((x) => x.id)}`);
      assert.strictEqual(r.repetidos, 2);
    }
  }
});

test('Migrate_ConcurrentSession_NotLeftBehind @story-8.132 @ac-10: otra sesión que muda el mismo archivo a la vez no deja un «dejado» falso', () => {
  // (1) la otra sesión enlaza primero el final, con el mismo contenido
  const d1 = doc({ sha: '8'.repeat(40) });
  const c1 = clon({ sueltos: [d1] });
  const destino1 = path.join(tmp(), 'dashboard');
  const final1 = path.join(destino1, nombre(d1));
  const antes = { ...fs, linkSync: (a, b) => { if (b === final1) fs.writeFileSync(final1, texto(d1)); return fs.linkSync(a, b); } };
  const r1 = MM.mudar(c1, destino1, { fs: antes });
  assert.deepStrictEqual([r1.migrados, r1.dejados], [1, []], JSON.stringify(r1));
  assert.ok(!fs.existsSync(path.join(c1, '.dashboard', nombre(d1))), 'el original se borró');
  // (2) la otra sesión ya se llevó el original entre la lista y la lectura
  const d2 = doc({ sha: '9'.repeat(40) });
  const c2 = clon({ sueltos: [d2] });
  const destino2 = path.join(tmp(), 'dashboard');
  const original2 = path.join(c2, '.dashboard', nombre(d2));
  const llevado = { ...fs, readFileSync: (p, ...r) => { if (p === original2 && fs.existsSync(p)) { write(path.join(destino2, nombre(d2)), texto(d2)); fs.unlinkSync(p); } return fs.readFileSync(p, ...r); } };
  const r2 = MM.mudar(c2, destino2, { fs: llevado });
  assert.deepStrictEqual(r2.dejados, [], JSON.stringify(r2));
});

test('ParaSubir_OnlyValidAndNew @story-8.132 @ac-4: al buzón van sólo los 2.0 válidos que no están ya en la historia', () => {
  const dir = path.join(tmp(), 'dashboard');
  const historia = path.join(tmp(), 'historia');
  const nuevo = doc({ sha: '1'.repeat(40) });
  const viejo = doc({ sha: '2'.repeat(40) });
  write(path.join(dir, nombre(nuevo)), texto(nuevo));
  write(path.join(dir, nombre(viejo)), texto(viejo));
  write(path.join(historia, nombre(viejo)), texto(viejo));
  write(path.join(dir, 'metrics-2026-01-01-legacy.json'), '{"schema_version":"1.0"}\n');
  write(path.join(dir, 'metrics-2026-01-02-roto.json'), '{');
  const r = MM.paraSubir(dir, { historia });
  assert.deepStrictEqual(r.archivos.map((x) => x.f), [nombre(nuevo)]);
  assert.deepStrictEqual([r.invalidos, r.enLaHistoria], [2, 1]);
  // sin historia, el viejo también va
  assert.strictEqual(MM.paraSubir(dir).archivos.length, 2);
});

// ── juntar y la constancia ─────────────────────────────────────────────────────────────────────────────────────────

const juntar = (args) => spawnSync(process.execPath, [LIB, 'juntar', ...args], { env: env(), encoding: 'utf8' });

test('T29 Juntar_OnePerMerge_WritesReceipt @story-8.132 @ac-13: junta un archivo por merge y deja la constancia completa', () => {
  const base = tmp();
  const desde = path.join(base, 'desde'); const hacia = path.join(base, 'hacia');
  const h1 = doc({ sha: '1'.repeat(40), ts: '2026-10-25T09:00:00.000Z' });
  const h2 = doc({ sha: '2'.repeat(40) });
  write(path.join(hacia, nombre(h1)), texto(h1)); write(path.join(hacia, nombre(h2)), texto(h2));
  // el mismo merge que h1, desde otra máquina (otro project, otro nombre), con vueltas
  const rep = doc({ sha: '1'.repeat(40), project: 'tycon-harness-wt-x', repo: '/srv/b/tycon-harness-wt-x', vueltas: 2 });
  const nuevo = doc({ sha: '3'.repeat(40) });
  const malo = doc({ sha: '4'.repeat(40) }); delete malo.merge_commit;
  write(path.join(desde, nombre(rep)), texto(rep)); write(path.join(desde, nombre(nuevo)), texto(nuevo));
  write(path.join(desde, 'metrics-2026-10-25-malo.json'), texto(malo));
  const res = path.join(base, 'bajada.json');
  write(res, JSON.stringify({ codigo: 0, estado: 'bajado', completo: true }));
  const r = juntar(['--from', desde, '--to', hacia, '--result', res]);
  assert.strictEqual(r.status, 0, r.stderr);
  const quedan = fs.readdirSync(hacia).filter((f) => /^metrics-.*\.json$/.test(f)).sort();
  assert.strictEqual(quedan.length, 3, quedan.join(' '));
  assert.ok(quedan.includes(nombre(rep)) && !quedan.includes(nombre(h1)), 'el repetido es el de las vueltas');
  assert.ok(quedan.includes(nombre(nuevo)) && quedan.includes(nombre(h2)));
  const c = JSON.parse(fs.readFileSync(path.join(hacia, 'bajada.json'), 'utf8'));
  assert.strictEqual(c.completo, true);
  assert.strictEqual(c.estado, 'bajado');
  assert.match(c.fecha, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  assert.strictEqual(c.invalidos, 1, 'el inválido se cuenta');
  assert.strictEqual(c.repetidos, 1);
});

test('T30 Juntar_NoResult_ReceiptIncomplete @story-8.132 @ac-22: sin resultado legible, la constancia dice incompleta y no toca lo juntado', () => {
  for (const caso of ['ausente', 'ilegible']) {
    const base = tmp();
    const desde = path.join(base, 'desde'); const hacia = path.join(base, 'hacia');
    const h = doc({ sha: '5'.repeat(40) });
    write(path.join(hacia, nombre(h)), texto(h));
    write(path.join(desde, nombre(doc({ sha: '6'.repeat(40) }))), texto(doc({ sha: '6'.repeat(40) })));
    const res = path.join(base, 'bajada.json');
    if (caso === 'ilegible') write(res, '{roto');
    const r = juntar(['--from', desde, '--to', hacia, '--result', res]);
    assert.strictEqual(r.status, 0, `${caso}: ${r.stderr}`);
    const c = JSON.parse(fs.readFileSync(path.join(hacia, 'bajada.json'), 'utf8'));
    assert.strictEqual(c.completo, false, caso);
    assert.strictEqual(c.estado, 'sin_resultado', caso);
    assert.deepStrictEqual(fs.readdirSync(hacia).sort(), ['bajada.json', nombre(h)].sort(), `${caso}: <hacia> sin tocar`);
  }
});

// Sin esto,con el resultado completo y sin la carpeta de lo bajado (la bajada no la dejó), la constancia sale
//    completa sin haber leído nada, y el tablero mediría con lo viejo como si fuera de hoy.
test('T30b Juntar_FromMissing_ReceiptIncomplete @story-8.132 @ac-22: sin lo bajado, la constancia no sale completa', () => {
  const base = tmp();
  const hacia = path.join(base, 'hacia');
  const res = path.join(base, 'r.json');
  write(res, JSON.stringify({ codigo: 0, estado: 'ok', completo: true }));
  const r = juntar(['--from', path.join(base, 'no-existe'), '--to', hacia, '--result', res]);
  assert.strictEqual(r.status, 0, r.stderr);
  const c = JSON.parse(fs.readFileSync(path.join(hacia, 'bajada.json'), 'utf8'));
  assert.deepStrictEqual([c.completo, c.estado], [false, 'sin_lo_bajado']);
});

// Sin esto,los inválidos y repetidos que descartó la bajada (`merges` del resultado de download-runs) no llegan a
//    la constancia: queda `invalidos: 0` y el aviso del paso del YAML no salta nunca.
test('T29c Juntar_CarriesDownloadCounts @story-8.132 @ac-13: la constancia suma lo que descartó la bajada', () => {
  const base = tmp();
  const desde = path.join(base, 'desde'); const hacia = path.join(base, 'hacia');
  write(path.join(desde, nombre(doc())), texto(doc()));
  const res = path.join(base, 'r.json');
  write(res, JSON.stringify({ codigo: 0, estado: 'bajado', completo: true, merges: { bajados: 1, repetidos: 2, invalidos: 3 } }));
  assert.strictEqual(juntar(['--from', desde, '--to', hacia, '--result', res]).status, 0);
  const c = JSON.parse(fs.readFileSync(path.join(hacia, 'bajada.json'), 'utf8'));
  assert.deepStrictEqual([c.juntados, c.repetidos, c.invalidos], [1, 2, 3], JSON.stringify(c));
  // una cuenta que no es un número entero positivo no suma
  write(res, JSON.stringify({ codigo: 0, estado: 'bajado', completo: true, merges: { repetidos: 'x', invalidos: -4 } }));
  juntar(['--from', desde, '--to', hacia, '--result', res]);
  const c2 = JSON.parse(fs.readFileSync(path.join(hacia, 'bajada.json'), 'utf8'));
  assert.deepStrictEqual([c2.repetidos, c2.invalidos], [0, 0], JSON.stringify(c2));
});

// Sin esto,la segunda noche baja el buzón entero otra vez y la constancia dice «0 juntados, N repetidos»: cuenta
//    como repetida la copia idéntica de lo que ya estaba guardado.
test('T29d Juntar_SecondNight_NoFalseRepeats @story-8.132 @ac-13: lo idéntico a lo ya guardado no cuenta como repetido', () => {
  const base = tmp();
  const desde = path.join(base, 'desde'); const hacia = path.join(base, 'hacia');
  for (const s of ['1', '2', '3']) { const d = doc({ sha: s.repeat(40) }); write(path.join(desde, nombre(d)), texto(d)); }
  const res = path.join(base, 'r.json');
  write(res, JSON.stringify({ codigo: 0, estado: 'bajado', completo: true }));
  juntar(['--from', desde, '--to', hacia, '--result', res]);
  const n1 = JSON.parse(fs.readFileSync(path.join(hacia, 'bajada.json'), 'utf8'));
  assert.deepStrictEqual([n1.juntados, n1.repetidos], [3, 0], JSON.stringify(n1));
  juntar(['--from', desde, '--to', hacia, '--result', res]);
  const n2 = JSON.parse(fs.readFileSync(path.join(hacia, 'bajada.json'), 'utf8'));
  assert.deepStrictEqual([n2.juntados, n2.repetidos], [0, 0], JSON.stringify(n2));
  assert.strictEqual(fs.readdirSync(hacia).filter((f) => /^metrics-/.test(f)).length, 3);
});

test('Juntar_ResultIncomplete_JoinsButSaysIncomplete @story-8.132 @ac-22: una bajada parcial junta lo que vino y la constancia lo dice', () => {
  const base = tmp();
  const desde = path.join(base, 'desde'); const hacia = path.join(base, 'hacia');
  write(path.join(desde, nombre(doc())), texto(doc()));
  const res = path.join(base, 'r.json');
  write(res, JSON.stringify({ codigo: 1, estado: 'parcial', completo: false }));
  assert.strictEqual(juntar(['--from', desde, '--to', hacia, '--result', res]).status, 0);
  const c = JSON.parse(fs.readFileSync(path.join(hacia, 'bajada.json'), 'utf8'));
  assert.deepStrictEqual([c.completo, c.estado], [false, 'parcial']);
  assert.ok(fs.existsSync(path.join(hacia, nombre(doc()))));
  // un estado que no es una palabra no se copia tal cual
  write(res, JSON.stringify({ estado: 'x; rm -rf /', completo: true }));
  juntar(['--from', desde, '--to', hacia, '--result', res]);
  assert.match(JSON.parse(fs.readFileSync(path.join(hacia, 'bajada.json'), 'utf8')).estado, /^[a-z_]+$/);
  // sin argumentos: sale 2 y lo dice
  const sin = juntar([]);
  assert.strictEqual(sin.status, 2);
  assert.match(sin.stderr, /--from/);
});

test('T31 Receipt_StaleOrIncomplete_NotUpToDate @story-8.132 @ac-22: la constancia sirve sólo completa y de las últimas 36 horas', () => {
  const ahora = Date.parse('2026-10-25T12:00:00Z');
  const casos = [
    ['completa de hace 2 h', { fecha: '2026-10-25T10:00:00Z', estado: 'bajado', completo: true }, true, null],
    ['completa de hace 40 h', { fecha: '2026-10-23T20:00:00Z', estado: 'bajado', completo: true }, false, /hace 40 h/],
    ['incompleta', { fecha: '2026-10-25T10:00:00Z', estado: 'sin_permiso', completo: false }, false, /no se completó.*sin_permiso/],
    ['ausente', null, false, /no hay constancia/],
    ['JSON roto', '{roto', false, /no se puede leer/],
  ];
  for (const [nombreCaso, cuerpo, alDia, motivo] of casos) {
    const d = path.join(tmp(), 'merges');
    fs.mkdirSync(d, { recursive: true });
    if (cuerpo !== null) write(path.join(d, 'bajada.json'), typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo));
    const c = MM.constancia(d, ahora);
    assert.strictEqual(c.al_dia, alDia, `${nombreCaso}: ${JSON.stringify(c)}`);
    if (motivo) assert.match(c.motivo, motivo, nombreCaso); else assert.strictEqual(c.motivo, null, nombreCaso);
  }
});

// ── Los YAML de la noche y las fuentes del tablero ──────────────────────────────────────────────────────────────────
// La copia pública está siempre. La de operaciones y la del privado, sólo con su árbol encima (el nocturno las pone sobre
// el público) o nombrando sus raíces en TYCON_TEST_TREES (separadas como el PATH). Sin ellas, «no medido», no verde.
const ARBOLES = [ROOT, ...(process.env.TYCON_TEST_TREES || '').split(path.delimiter).filter(Boolean)];
function copia(rel) {
  for (const r of ARBOLES) if (fs.existsSync(path.join(r, rel))) return path.join(r, rel);
  return null;
}
function noMedido(caso, rel) { console.log(`  (${caso}: ${rel} no está ni en el árbol ni en TYCON_TEST_TREES: NO MEDIDO acá)`); }

function tableroBajaYJunta(y, donde) {
  const bajada = y.indexOf('node scripts/metrics/download-runs.js');
  assert.ok(bajada > 0, `${donde}: no encontré la bajada del buzón`);
  const linea = y.slice(bajada, y.indexOf('\n', bajada));
  assert.match(linea, /--merges-to "\$\(Agent\.TempDirectory\)\/merges-nuevos"/, `${donde}: la bajada trae --merges-to`);
  const ops = y.indexOf('ops-data.yml');
  const sync = y.indexOf('push-nightly-data.js sync');
  const juntar = y.indexOf('node scripts/lib/merge-metrics.js juntar');
  const pagina = y.indexOf('node scripts/nightly/dashboard/dashboard.js --nightly');
  assert.ok(juntar > 0, `${donde}: falta el paso que junta los merges`);
  assert.ok(ops > 0 && ops < juntar, `${donde}: juntar va después de ops-data.yml`);
  assert.ok(sync < juntar, `${donde}: juntar va después de traer los datos de main (si no, el sync los borra)`);
  assert.ok(juntar < pagina, `${donde}: juntar va antes de generar la página`);
  const paso = y.slice(juntar, y.indexOf('displayName', juntar) + 200);
  assert.match(paso, /--from "\$\(Agent\.TempDirectory\)\/merges-nuevos"/, `${donde}: junta lo bajado`);
  assert.match(paso, /--to "?(\$\(Build\.SourcesDirectory\)\/)?\.dashboard\/merges"?/, `${donde}: en .dashboard/merges`);
  assert.match(paso, /--result "\$\(Agent\.TempDirectory\)\/bajada\.json"/, `${donde}: con el resultado de la bajada`);
  assert.match(paso, /condition: succeededOrFailed\(\)/, `${donde}: corre aunque la bajada falle (la constancia lo dice)`);
  const guardado = y.slice(y.indexOf('-- artifacts/tablero-del-arnes.html'));
  assert.match(guardado.slice(0, guardado.indexOf('\n')), /\.dashboard\/merges/, `${donde}: el guardado lleva .dashboard/merges`);
}
function etapaConConstancia(y, donde) {
  const i = y.indexOf('node scripts/metrics/sdlc-stage-metrics.js');
  assert.ok(i > 0, `${donde}: no encontré la medición`);
  const paso = y.slice(i, y.indexOf('displayName', i));
  assert.match(paso, /--merges-receipt "\$\(Build\.SourcesDirectory\)\/\.dashboard\/merges\/bajada\.json"/, `${donde}: pasa la constancia`);
  assert.doesNotMatch(y, /tablero-nocturno-buzon/, `${donde}: no pide una conexión al buzón`);
}

// Sin esto,el nocturno no baja los merges (falta --merges-to), los junta antes del sync (que los borra) o no los
//    guarda; la medición no pasa la constancia; el privado no los trae de operaciones.
test('T21 Pipeline_TeamDashboard_DownloadsAndJoins @story-8.132 @ac-13 @ac-22: bajar, juntar, guardar y medir con la constancia', () => {
  tableroBajaYJunta(fs.readFileSync(path.join(ROOT, 'pipelines', 'operations', 'team-dashboard.yml'), 'utf8'), 'pipelines/operations/team-dashboard.yml');
  etapaConConstancia(fs.readFileSync(path.join(ROOT, 'pipelines', 'operations', 'stage-metrics.yml'), 'utf8'), 'pipelines/operations/stage-metrics.yml');
  const td = copia('pipelines/team-dashboard.yml');
  if (td) tableroBajaYJunta(fs.readFileSync(td, 'utf8'), td); else noMedido('T21', 'pipelines/team-dashboard.yml de operaciones');
  const sm = copia('pipelines/stage-metrics.yml');
  if (sm) etapaConConstancia(fs.readFileSync(sm, 'utf8'), sm); else noMedido('T21', 'pipelines/stage-metrics.yml de operaciones');
  const od = copia('pipelines/templates/ops-data.yml');
  if (!od) { noMedido('T21', 'pipelines/templates/ops-data.yml del privado'); return; }
  const y = fs.readFileSync(od, 'utf8');
  const lazo = y.match(/for d in ([^;]*\.dashboard\/deployments[^;]*); do/);
  assert.ok(lazo, `${od}: no encontré las carpetas opcionales`);
  assert.match(lazo[1], /(^|\s)\.dashboard\/merges(\s|$)/, `${od}: .dashboard/merges entre las opcionales (y con ellas, en ADD)`);
});

// El paso de juntar del YAML, corrido de verdad con bash: la corrida avisa (naranja) los inválidos y una constancia
// incompleta, y calla con una bajada completa y limpia.
// Sin esto, el paso avisa sólo si `juntar` sale distinto de 0, y `juntar` sale 0 en esos dos casos.
function correrPasoJuntar(y, donde, { resultado, invalido }) {
  const i = y.indexOf('node scripts/lib/merge-metrics.js juntar');
  const ini = y.lastIndexOf('- script: |', i) + '- script: |'.length;
  const fin = y.indexOf('displayName', i);
  const cuerpo = y.slice(ini, fin).split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n');
  const base = tmp();
  const temp = path.join(base, 'temp'); const fuentes = path.join(base, 'fuentes');
  fs.mkdirSync(path.join(temp, 'merges-nuevos'), { recursive: true });
  write(path.join(temp, 'bajada.json'), JSON.stringify(resultado));
  write(path.join(temp, 'merges-nuevos', nombre(doc())), texto(doc()));
  if (invalido) write(path.join(temp, 'merges-nuevos', 'metrics-2026-10-25-roto-8.1-ccccccc.json'), '{roto');
  const guion = cuerpo.split('$(Agent.TempDirectory)').join(temp).split('$(Build.SourcesDirectory)').join(fuentes);
  const r = spawnSync('bash', ['-c', guion], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `${donde}: el paso es tolerante (${r.stderr})`);
  return r.stdout;
}
test('T21b Pipeline_Juntar_WarnsInvalidAndIncomplete @story-8.132 @ac-13: el paso de juntar avisa inválidos y constancia incompleta', () => {
  const mira = (y, donde) => {
    const avisa = /##vso\[task\.logissue type=warning\][^\n]*\n[^\n]*##vso\[task\.complete result=SucceededWithIssues;\]/;
    assert.doesNotMatch(correrPasoJuntar(y, donde, { resultado: { estado: 'ok', completo: true } }), /##vso\[task\.logissue/, `${donde}: completa y limpia, calla`);
    assert.match(correrPasoJuntar(y, donde, { resultado: { estado: 'parcial', completo: false } }), avisa, `${donde}: incompleta, avisa`);
    assert.match(correrPasoJuntar(y, donde, { resultado: { estado: 'ok', completo: true }, invalido: true }), avisa, `${donde}: con un inválido, avisa`);
    // Sin esto, los que descartó la bajada no llegan a la constancia y el paso calla
    assert.match(correrPasoJuntar(y, donde, { resultado: { estado: 'ok', completo: true, merges: { invalidos: 3 } } }), avisa, `${donde}: con inválidos de la bajada, avisa`);
  };
  mira(fs.readFileSync(path.join(ROOT, 'pipelines', 'operations', 'team-dashboard.yml'), 'utf8'), 'pipelines/operations/team-dashboard.yml');
  const td = copia('pipelines/team-dashboard.yml');
  if (td) mira(fs.readFileSync(td, 'utf8'), td); else noMedido('T21b', 'pipelines/team-dashboard.yml de operaciones');
});

// Sin esto,en la copia pública el paso de juntar corre también sin buzón declarado, y cada noche de una
//    organización sin buzón queda naranja con «sin_resultado».
test('T21d Pipeline_Juntar_OnlyWithMailbox @story-8.132 @ac-13: sin buzón declarado, el paso de juntar no existe', () => {
  const y = fs.readFileSync(path.join(ROOT, 'pipelines', 'operations', 'team-dashboard.yml'), 'utf8');
  const lineas = y.split('\n');
  const i = lineas.findIndex((l) => l.includes('node scripts/lib/merge-metrics.js juntar'));
  let s = i; while (s >= 0 && !/^\s*- script: \|/.test(lineas[s])) s--;
  assert.ok(s > 0, 'no encontré el paso de juntar');
  const sangria = (l) => l.match(/^ */)[0].length;
  let p = s - 1;
  while (p >= 0 && (!lineas[p].trim() || lineas[p].trim().startsWith('#') || sangria(lineas[p]) >= sangria(lineas[s]))) p--;
  assert.match(lineas[p], /^\s*- \$\{\{ if ne\(parameters\.mailboxConnection, ''\) \}\}:\s*$/, `el paso cuelga de: ${lineas[p]}`);
});

// Sin esto,el barrido no mira los merges bajados y les escribe un latido de más a los que ya tienen el suyo.
test('T22 Pipeline_Sweep_CoveredInMerges @story-8.132 @ac-16: el barrido da por cubierto lo que ya bajó', () => {
  const mira = (y, donde) => {
    const i = y.indexOf('node scripts/metrics/retro-sweep.js');
    assert.ok(i > 0, `${donde}: no encontré el barrido`);
    assert.match(y.slice(i, y.indexOf('displayName', i)), /--covered-in "\$\(Build\.SourcesDirectory\)\/\.dashboard\/merges"/, `${donde}: --covered-in .dashboard/merges`);
  };
  mira(fs.readFileSync(path.join(ROOT, 'pipelines', 'operations', 'dependency-audit.yml'), 'utf8'), 'pipelines/operations/dependency-audit.yml');
  const da = copia('pipelines/dependency-audit.yml');
  if (da) mira(fs.readFileSync(da, 'utf8'), da); else noMedido('T22', 'pipelines/dependency-audit.yml de operaciones');
});

// Sin esto,la fuente «capturer» sigue leyendo la raíz de .dashboard, donde ya no llega nada.
test('T24 Sources_CapturerReadsMerges @story-8.132 @ac-15: la fuente lee merges/ con su constancia', () => {
  const mira = (f) => {
    const s = JSON.parse(fs.readFileSync(f, 'utf8')).sources.find((x) => x.id === 'capturer');
    assert.ok(s, `${f}: falta la fuente capturer`);
    assert.strictEqual(s.dir, 'merges', `${f}: dir`);
    assert.strictEqual(s.receipt, 'bajada.json', `${f}: receipt`);
  };
  mira(path.join(ROOT, 'scripts', 'nightly', 'dashboard', 'sources.json'));
  mira(path.join(ROOT, 'pipelines', 'operations', 'examples', 'sources.json'));
  // la del privado y la de operaciones viven en la misma ruta: con su árbol encima es la de ROOT; si no, las de las raíces
  const otras = ARBOLES.slice(1).map((r) => path.join(r, 'scripts', 'nightly', 'dashboard', 'sources.json')).filter((f) => fs.existsSync(f));
  for (const f of otras) mira(f);
  if (!otras.length) noMedido('T24', 'scripts/nightly/dashboard/sources.json del privado y de operaciones');
});
