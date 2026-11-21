'use strict';

/**
 * legacy-retire-check.test.js — el chequeo que dice qué nombres viejos se pueden retirar.
 * T4, T5 y T21.
 *
 * Lo que no se puede perder:
 *   · «Se puede retirar» (0) sale sólo con evidencia positiva: cada máquina esperada reportó, cada consulta contestó y
 *     nadie usó un nombre viejo en la ventana (T4).
 *   · Una consulta que falla nunca se vuelve «sin usos»: sale 2 y dice cuál (T5, regla ADO 5).
 *   · El `--json` dice el estado de cada entrada y aparte las máquinas que no reportaron: con eso se arma el retiro
 *     parcial del 17/11 (T21). Una máquina callada no cambia el estado de ninguna entrada; un uso deja «con uso» sólo
 *     su entrada; una consulta caída deja «sin medir» lo que ese repo nombra.
 *
 * Todo es de laboratorio: el mapa, el buzón, las máquinas esperadas, la lista de productos y un `az` falso.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const TOOL = path.join(RAIZ, 'scripts', 'tools', 'legacy-retire-check.js');
const { aliasDeNombre } = require(path.join(RAIZ, 'scripts', 'nightly', 'dashboard', 'reducer.js'));

const HOY = '2026-11-17';
const ENTRADAS = [
  { kind: 'option', old: 'viejo-a', new: 'new-a', batch: 'L' },
  { kind: 'key', old: 'viejo-b', new: 'new-b', batch: 'L' },
  { kind: 'file', old: 'scripts/ci/viejo-c.sh', new: 'scripts/ci/new-c.sh', batch: 'L' },
];

function write(p, body) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); }

/**
 * El laboratorio: `machines` = { carpeta: { fecha, lines: [uso…], medido } }; `runs` = las corridas de un pipeline
 * con sus avisos; `fail` = la consulta de az que falla; `clone` = lo que nombra el clon del producto.
 */
function lab({ machines = {}, expected, runs = [], fail = null, clone = null, entries = ENTRADAS, retireAfter = HOY, pipelines = null, runsBy = {}, shape = null, cloneFiles = {}, parityRepos = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-check-'));
  write(path.join(dir, 'map.json'), JSON.stringify({ retire_after: retireAfter, entries }));
  const exp = expected || Object.keys(machines).map((m) => ({ alias: aliasDeNombre(m), from: '2026-06-01' }));
  write(path.join(dir, 'sources.json'), JSON.stringify({ reducer: { expected_machines: exp } }));
  for (const [m, d] of Object.entries(machines)) {
    // `medido: false` es la máquina sin registro de usos (nunca usó un nombre viejo): la subida lo dice así
    const ln = d.medido === false ? { estado: 'no_medido', motivo: 'el registro no existe en esta máquina' }
      : d.medido === 'roto' ? { estado: 'no_medido', motivo: 'el registro no se pudo leer (EACCES)' } : { estado: 'medido' };
    write(path.join(dir, 'mirror', m, 'registros', 'cobertura.json'), JSON.stringify({ esquema: 1, fecha: d.fecha || HOY, fuentes: { 'legacy-names': ln } }));
    if (d.medido !== false) {
      write(path.join(dir, 'mirror', m, 'registros', 'legacy-names.jsonl.gz'),
        zlib.gzipSync((d.raw || []).concat((d.lines || []).map((l) => JSON.stringify(l))).join('\n') + '\n'));
    }
  }
  write(path.join(dir, 'parity.json'), JSON.stringify({ grupos: { formularios: { repos: parityRepos || [{ ruta: 'Prod/Forms', ado: 'Prod/Forms' }] } } }));
  if (clone) write(path.join(dir, 'repos', 'Prod', 'Forms', 'azure-pipelines.yml'), clone);
  for (const [rel, body] of Object.entries(cloneFiles)) write(path.join(dir, 'repos', 'Prod', 'Forms', rel), body);
  write(path.join(dir, 'az.json'), JSON.stringify({ runs, fail, shape, runsBy, pipelines: pipelines || [{ id: 7, name: 'Forms', repository: { name: 'Forms' } }] }));
  write(path.join(dir, 'az.js'), `
    const fx = JSON.parse(require('fs').readFileSync(${JSON.stringify(path.join(dir, 'az.json'))}, 'utf8'));
    const a = process.argv.slice(2).join(' ');
    const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
    const no = (m) => { process.stderr.write(m); process.exit(1); };
    const runsOf = (id) => fx.runsBy[id] || (id === 7 ? fx.runs : []);
    // como el az real: la lista de pipelines no trae el repo; lo dice «pipelines show»
    if (a.startsWith('pipelines list')) { if (fx.fail === 'list') no('ERROR: TF400813'); if (fx.shape === 'list') out({ message: 'x' }); out(fx.pipelines.map((p) => ({ id: p.id, name: p.name, repository: null }))); }
    if (a.startsWith('pipelines show')) {
      if (fx.fail === 'show') no('ERROR: show');
      const id = Number(/--id (\\d+)/.exec(a)[1]);
      out(fx.pipelines.find((p) => p.id === id));
    }
    if (a.startsWith('pipelines runs list')) {
      if (fx.fail === 'runs') no('ERROR: runs'); if (fx.shape === 'runs') out({ message: 'x' });
      const id = Number(/--pipeline-ids (\\d+)/.exec(a)[1]);
      out(runsOf(id).map((r) => ({ id: r.id, finishTime: r.finishTime, startTime: r.startTime || r.finishTime || '2026-11-12T09:00:00Z', result: r.result || (r.finishTime ? 'succeeded' : null), status: r.finishTime ? 'completed' : 'inProgress' })));
    }
    if (a.startsWith('devops invoke')) {
      if (fx.fail === 'timeline') no('ERROR: timeline'); if (fx.shape === 'timeline') out({ message: 'x' });
      const id = Number(/buildId=(\\d+)/.exec(a)[1]);
      const r = [].concat(fx.runs, ...Object.values(fx.runsBy)).find((x) => x.id === id);
      if (r.empty) process.exit(0);   // una corrida sin registro: az sale 0 sin escribir nada
      out({ records: [{ type: 'Task', issues: (r.warnings || []).map((m) => ({ type: 'warning', message: m })) }] });
    }
    no('az falso: no sé ' + a);`);
  return dir;
}

function run(dir, extra = []) {
  const r = spawnSync(process.execPath, [TOOL, '--json', '--today', HOY, '--no-download',
    '--map', path.join(dir, 'map.json'), '--sources', path.join(dir, 'sources.json'), '--mirror', path.join(dir, 'mirror'),
    '--parity', path.join(dir, 'parity.json'), '--repos-root', path.join(dir, 'repos'), '--az', path.join(dir, 'az.js'), ...extra],
  { encoding: 'utf8', env: { ...process.env, HOME: dir, TF_BUILD: '' } });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) { /* lo dice el assert */ }
  return { code: r.status, json, stderr: r.stderr, stdout: r.stdout };
}
const states = (j) => Object.fromEntries(j.entries.map((e) => [e.old, e.state]));
const uso = (old, kind, day = '2026-11-10') => ({ day, kind, old, new: 'x', script: 'scripts/x.js' });
const aviso = (old, kind) => `nombre viejo «${old}» (${kind}) en scripts/ci/x.js: sigue andando y no es la causa de ningún error de este paso`;

test('T4 RetireA_CheckSaysReadyOnlyWithPositiveEvidence — todo en verde: sale 0 y todas las entradas limpias', () => {
  const r = run(lab({ machines: { 'maq-uno': {}, 'maq-dos': {} }, runs: [{ id: 1, finishTime: '2026-11-12T10:00:00Z' }] }));
  assert.strictEqual(r.code, 0, r.stderr + r.stdout);
  assert.deepStrictEqual(states(r.json), { 'viejo-a': 'limpia', 'viejo-b': 'limpia', 'scripts/ci/viejo-c.sh': 'limpia' });
  assert.deepStrictEqual(r.json.machines_unreported, []);
});

test('T4 RetireA_CheckSaysReadyOnlyWithPositiveEvidence — la fecha todavía no llegó: sale 1 con ese motivo', () => {
  const r = run(lab({ machines: { 'maq-uno': {} }, retireAfter: '2026-11-30' }));
  assert.strictEqual(r.code, 1);
  assert.ok(r.json.reasons.some((m) => /2026-11-30/.test(m)), JSON.stringify(r.json.reasons));
});

test('T4 RetireA_CheckSaysReadyOnlyWithPositiveEvidence — un uso viejo fuera de la ventana no cuenta; uno adentro sí', () => {
  const fuera = run(lab({ machines: { 'maq-uno': { lines: [uso('viejo-a', 'option', '2026-10-20')] } } }));
  assert.strictEqual(fuera.code, 0, 'un uso de hace más de 14 días no frena');
  const adentro = run(lab({ machines: { 'maq-uno': { lines: [uso('viejo-a', 'option')] } } }));
  assert.strictEqual(adentro.code, 1);
  assert.strictEqual(states(adentro.json)['viejo-a'], 'con-uso');
});

test('T4 RetireA_CheckSaysReadyOnlyWithPositiveEvidence — una entrada con fecha propia se mide desde la semana antes de su fecha', () => {
  const entries = [{ ...ENTRADAS[0], retire_after: '2026-11-24' }, ENTRADAS[1], ENTRADAS[2]];
  const ese = run(lab({ machines: { 'maq-uno': { lines: [uso('viejo-a', 'option', '2026-11-16')] } }, entries }), ['--today', '2026-11-24']);
  assert.strictEqual(states(ese.json)['viejo-a'], 'limpia', 'el uso de antes de la semana de su fecha ya no cuenta');
  const despues = run(lab({ machines: { 'maq-uno': { lines: [uso('viejo-a', 'option', '2026-11-20')] } }, entries }), ['--today', '2026-11-24']);
  assert.strictEqual(states(despues.json)['viejo-a'], 'con-uso');
  const antes = run(lab({ machines: { 'maq-uno': {} }, entries }));
  assert.strictEqual(antes.json.entries.find((e) => e.old === 'viejo-a').due, false, 'el 17 no le llegó su fecha');
});

test('T4 RetireA_CheckSaysReadyOnlyWithPositiveEvidence — --check-map acepta la fecha de retiro propia de una entrada y rechaza una que no existe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-checkmap-'));
  const map = (fecha) => JSON.stringify({ retire_after: HOY, entries: [{ kind: 'key', old: 'viejo-b', new: 'new-b', where: 'x.json', batch: 'L', retire_after: fecha }] });
  const check = (fecha) => {
    write(path.join(dir, 'map.json'), map(fecha));
    return spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'publishing', 'spanish-names.js'), '--check-map', '--map', path.join(dir, 'map.json'), '--repo', dir], { encoding: 'utf8' });
  };
  assert.strictEqual(check('2026-11-24').status, 0, 'una fecha que existe');
  const mala = check('2026-02-30');
  assert.strictEqual(mala.status, 2);
  assert.match(mala.stdout + mala.stderr, /retire_after tiene que ser una fecha/);
});

test('T4 RetireA_CheckSaysReadyOnlyWithPositiveEvidence — una entrada de un tipo que ninguna fuente anota sale sin-fuente, nunca limpia', () => {
  const entries = [...ENTRADAS, { kind: 'tipo-nuevo', old: 'viejo-d', new: 'new-d', batch: 'L' }];
  const r = run(lab({ machines: { 'maq-uno': {} }, entries }));
  assert.strictEqual(states(r.json)['viejo-d'], 'sin-fuente');
  assert.strictEqual(r.code, 1);
});

test('T5 RetireA_CheckNeverTurnsFailureIntoZero — cada consulta de az que falla sale 2 y se nombra; nunca 0', () => {
  for (const fail of ['list', 'runs', 'timeline']) {
    const r = run(lab({ machines: { 'maq-uno': {} }, runs: [{ id: 1, finishTime: '2026-11-12T10:00:00Z' }], fail }));
    assert.strictEqual(r.code, 2, `${fail}: ${r.stdout}`);
    assert.ok(r.json.failed_queries.some((q) => q.repo === 'Prod/Forms'), `${fail}: nombra el repo`);
  }
  const sinBuzon = run(lab({ machines: { 'maq-uno': {} } }), ['--mirror', path.join(os.tmpdir(), 'no-existe-el-buzon')]);
  assert.strictEqual(sinBuzon.code, 2, 'sin el espejo del buzón: no pude medir');
});

test('T21 RetireE_UsedEntriesGetOwnDate — un uso en el buzón y un aviso en una corrida: sólo esas entradas, sale 1', () => {
  const r = run(lab({
    machines: { 'maq-uno': { lines: [uso('viejo-b', 'key')] } },
    runs: [{ id: 1, finishTime: '2026-11-12T10:00:00Z', warnings: [aviso('scripts/ci/viejo-c.sh', 'file')] }],
  }));
  assert.strictEqual(r.code, 1);
  assert.deepStrictEqual(states(r.json), { 'viejo-a': 'limpia', 'viejo-b': 'con-uso', 'scripts/ci/viejo-c.sh': 'con-uso' });
  const c = r.json.entries.find((e) => e.old === 'scripts/ci/viejo-c.sh');
  assert.deepStrictEqual(c.sources, ['pipeline:Prod/Forms']);
  assert.strictEqual(r.json.own_date_for_used, '2026-11-24', 'la fecha propia que les toca: una semana después');
});

test('T21 RetireE_UsedEntriesGetOwnDate — una opción con el mismo nombre viejo en dos guiones: el uso cuenta sólo para la del guion que la usó, también por su ruta de antes', () => {
  const entries = [
    { kind: 'option', old: 'raiz-v', new: 'root', where: 'scripts/ci/uno.js', batch: 'L' },
    { kind: 'option', old: 'raiz-v', new: 'root', where: 'scripts/nightly/dos.js', batch: 'L' },
    { kind: 'file', old: 'scripts/noche/dos-viejo.js', new: 'scripts/nightly/dos.js', batch: 'L' },
  ];
  const r = run(lab({
    entries,
    machines: { 'maq-uno': { lines: [{ day: '2026-11-10', kind: 'option', old: 'raiz-v', new: 'root', script: 'scripts/noche/dos-viejo.js' }] } },
    runs: [{ id: 1, finishTime: '2026-11-12T10:00:00Z', warnings: ['nombre viejo «--raiz-v» (option) en scripts/ci/uno.js: sigue andando'] }],
  }));
  const st = r.json.entries.filter((e) => e.kind === 'option').map((e) => [e.where, e.state, e.sources.join(',')]);
  assert.deepStrictEqual(st, [['scripts/ci/uno.js', 'con-uso', 'pipeline:Prod/Forms'], ['scripts/nightly/dos.js', 'con-uso', `maquina:${aliasDeNombre('maq-uno')}`]]);
  const solo = run(lab({ entries, machines: { 'maq-uno': { lines: [{ day: '2026-11-10', kind: 'option', old: 'raiz-v', new: 'root', script: 'scripts/ci/uno.js' }] } } }));
  assert.deepStrictEqual(solo.json.entries.filter((e) => e.kind === 'option').map((e) => e.state), ['con-uso', 'limpia']);
});

test('T21 RetireE_UsedEntriesGetOwnDate — una máquina callada no cambia ninguna entrada: todo limpio, la máquina aparte, sale 2', () => {
  const callada = { alias: aliasDeNombre('maq-callada'), from: '2026-06-01' };
  const r = run(lab({ machines: { 'maq-uno': {} }, expected: [{ alias: aliasDeNombre('maq-uno'), from: '2026-06-01' }, callada] }));
  assert.strictEqual(r.code, 2);
  assert.deepStrictEqual(states(r.json), { 'viejo-a': 'limpia', 'viejo-b': 'limpia', 'scripts/ci/viejo-c.sh': 'limpia' });
  assert.deepStrictEqual(r.json.machines_unreported, [callada.alias]);
  const vieja = run(lab({ machines: { 'maq-uno': { fecha: '2026-10-01' } } }));
  assert.deepStrictEqual(vieja.json.machines_unreported, [aliasDeNombre('maq-uno')], 'un reporte de antes de la ventana no cuenta');
});

test('T21 RetireE_UsedEntriesGetOwnDate — una consulta caída deja sin medir lo que ese repo nombra, y el resto limpio', () => {
  const r = run(lab({ machines: { 'maq-uno': {} }, fail: 'runs', clone: 'steps:\n  - script: bash $(arnes)/scripts/ci/viejo-c.sh\n' }));
  assert.strictEqual(r.code, 2);
  assert.deepStrictEqual(states(r.json), { 'viejo-a': 'limpia', 'viejo-b': 'limpia', 'scripts/ci/viejo-c.sh': 'sin-medir' });
  const sinClon = run(lab({ machines: { 'maq-uno': {} }, fail: 'runs' }));
  assert.ok(Object.values(states(sinClon.json)).every((s) => s === 'sin-medir'), 'sin el clon del repo no se sabe qué nombra: todo sin medir');
});

test('T4 RetireA_CheckSaysReadyOnlyWithPositiveEvidence — una máquina que nunca usó un nombre viejo (sin registro) reportó: sale 0', () => {
  const r = run(lab({ machines: { 'maq-uno': { medido: false } } }));
  assert.strictEqual(r.code, 0, r.stdout);
  assert.deepStrictEqual(r.json.machines_unreported, []);
  const roto = run(lab({ machines: { 'maq-uno': { medido: 'roto' } } }));
  assert.deepStrictEqual(roto.json.machines_unreported, [aliasDeNombre('maq-uno')], 'un registro que no se pudo leer no es «sin usos»');
});

test('T4 RetireA_CheckSaysReadyOnlyWithPositiveEvidence — un pipeline de un repo fuera de la lista con un aviso de nombre viejo sale «no declarado» y su uso cuenta', () => {
  const r = run(lab({
    machines: { 'maq-uno': {} },
    pipelines: [{ id: 7, name: 'Forms', repository: { name: 'Forms' } }, { id: 9, name: 'Otro', repository: { name: 'Otro' } }, { id: 10, name: 'Quieto', repository: { name: 'Quieto' } }],
    runsBy: { 9: [{ id: 91, finishTime: '2026-11-12T10:00:00Z', warnings: [aviso('viejo-b', 'key')] }], 10: [{ id: 101, finishTime: '2026-11-12T10:00:00Z' }] },
  }));
  assert.strictEqual(r.code, 1);
  assert.deepStrictEqual(r.json.undeclared_pipelines, [{ project: 'Prod', repo: 'Otro', pipeline: 'Otro' }], 'sólo el que llamó al arnés');
  assert.deepStrictEqual(states(r.json)['viejo-b'], 'con-uso');
  assert.deepStrictEqual(r.json.entries.find((e) => e.old === 'viejo-b').sources, ['no-declarado:Prod/Otro']);
});

test('T4 RetireA_CheckSaysReadyOnlyWithPositiveEvidence — el repo de cada pipeline sale de «pipelines show»; una corrida en curso se lee; una cancelada antes de arrancar no tiene registro', () => {
  const r = run(lab({
    machines: { 'maq-uno': {} },
    runs: [
      // en curso desde hace un mes (producción esperando su aprobación): se lee igual
      { id: 1, finishTime: null, startTime: '2026-10-15T10:00:00Z', warnings: [aviso('viejo-b', 'key')] },
      { id: 2, startTime: '2026-11-12T10:00:00Z', finishTime: '2026-11-12T10:00:00Z', result: 'canceled', empty: true },
    ],
  }));
  assert.strictEqual(r.code, 1, r.stdout);
  assert.deepStrictEqual(r.json.failed_queries, [], 'ni la corrida en curso ni la cancelada son consultas fallidas');
  assert.deepStrictEqual(r.json.undeclared_pipelines, [], 'el pipeline del producto no sale como no declarado');
  assert.deepStrictEqual(r.json.entries.find((e) => e.old === 'viejo-b').sources, ['pipeline:Prod/Forms'], 'el aviso de la corrida en curso cuenta, del producto');
});

test('T21 RetireE_UsedEntriesGetOwnDate — una consulta caída de un pipeline fuera de la lista se informa, pero no deja sin medir lo de los productos', () => {
  const r = run(lab({
    machines: { 'maq-uno': {} },
    pipelines: [{ id: 7, name: 'Forms', repository: { name: 'Forms' } }, { id: 9, name: 'Otro', repository: { name: 'Otro' } }],
    runsBy: { 9: [{ id: 91, finishTime: '2026-11-12T10:00:00Z', empty: true }] },
  }));
  assert.strictEqual(r.code, 2, 'no pude medir ese pipeline: se dice');
  assert.ok(r.json.failed_queries.some((q) => q.repo === 'Prod/Otro' && q.undeclared));
  assert.deepStrictEqual(states(r.json), { 'viejo-a': 'limpia', 'viejo-b': 'limpia', 'scripts/ci/viejo-c.sh': 'limpia' }, 'lo limpio sigue limpio');
});

test('T5 RetireA_CheckNeverTurnsFailureIntoZero — una línea ilegible del registro, una respuesta de az con otra forma o la ventana que no entra en el tope: no pude medir', () => {
  const ilegible = run(lab({ machines: { 'maq-uno': { raw: ['{"day":"2026-11-10","kind":"opt'] } } }));
  assert.strictEqual(ilegible.code, 2, 'una línea rota del registro no se tira en silencio');
  assert.ok(ilegible.json.failed_queries.some((q) => q.source === 'buzon'));
  for (const shape of ['list', 'runs', 'timeline']) {
    const r = run(lab({ machines: { 'maq-uno': {} }, runs: [{ id: 1, finishTime: '2026-11-12T10:00:00Z' }], shape }));
    assert.strictEqual(r.code, 2, `${shape}: una forma inesperada no es «cero»`);
  }
  const vacio = run(lab({ machines: { 'maq-uno': {} }, runs: [{ id: 1, finishTime: '2026-11-12T10:00:00Z', empty: true }] }));
  assert.strictEqual(vacio.code, 2, 'un timeline vacío de una corrida que no se canceló: no pude medir');
  const aMitad = run(lab({ machines: { 'maq-uno': {} }, runs: [{ id: 1, startTime: '2026-11-12T09:00:00Z', finishTime: '2026-11-12T10:00:00Z', result: 'canceled', empty: true }] }));
  assert.strictEqual(aMitad.code, 2, 'una cancelada a mitad de camino sí corrió: su timeline vacío es no pude medir');
  const sinRepo = run(lab({ machines: { 'maq-uno': {} }, runs: [{ id: 1, finishTime: '2026-11-12T10:00:00Z' }], fail: 'show' }));
  assert.strictEqual(sinRepo.code, 2, 'sin saber de qué repo es un pipeline: no pude medir');
  assert.ok(sinRepo.json.failed_queries.some((q) => q.repo === 'Prod/Forms'), 'y se dice por los repos de la lista de ese proyecto');
  const sinAdo = run(lab({ machines: { 'maq-uno': {} }, parityRepos: [{ ruta: 'Prod/Forms', ado: 'Prod/Forms' }, { ruta: 'Prod/Gh', github: 'acme/gh' }] }));
  assert.strictEqual(sinAdo.code, 2, 'un producto de la lista que no se puede medir no es «limpio»');
  assert.ok(sinAdo.json.failed_queries.some((q) => q.repo === 'Prod/Gh'));
  const vacia = run(lab({ machines: { 'maq-uno': {} }, parityRepos: [] }));
  assert.strictEqual(vacia.code, 2, 'una lista de productos vacía no mide nada');
  const lleno = Array.from({ length: 200 }, (_, i) => ({ id: 1000 + i, finishTime: '2026-11-12T10:00:00Z' }));
  const tope = run(lab({ machines: { 'maq-uno': {} }, runs: lleno }));
  assert.strictEqual(tope.code, 2, 'con el tope de corridas lleno dentro de la ventana no se miró todo');
  assert.ok(tope.json.failed_queries.some((q) => /tope/.test(q.error)));
});

test('T21 RetireE_UsedEntriesGetOwnDate — una consulta caída deja sin medir también las variables y claves que el repo nombra', () => {
  const entries = [...ENTRADAS,
    { kind: 'env', old: 'TYCON_LEGACY_X', new: 'TYCON_NEW_X', batch: 'L' },
    { kind: 'key', old: 'servidores-v', new: 'servers', where: '.tycon/production.json', batch: 'L' }];
  const r = run(lab({
    entries, machines: { 'maq-uno': {} }, fail: 'runs',
    clone: 'variables:\n  TYCON_LEGACY_X: srv\n',
    cloneFiles: { '.tycon/production.json': '{ "servidores-v": [] }\n' },
  }));
  assert.strictEqual(r.code, 2);
  assert.strictEqual(states(r.json).TYCON_LEGACY_X, 'sin-medir');
  assert.strictEqual(states(r.json)['servidores-v'], 'sin-medir');
  assert.strictEqual(states(r.json)['viejo-a'], 'limpia');
});

test('T21 RetireE_UsedEntriesGetOwnDate — uso, consulta caída y máquina callada juntos: sale 2 y el --json trae los tres', () => {
  const r = run(lab({
    machines: { 'maq-uno': { lines: [uso('viejo-a', 'option')] } },
    expected: [{ alias: aliasDeNombre('maq-uno'), from: '2026-06-01' }, { alias: aliasDeNombre('maq-callada'), from: '2026-06-01' }],
    fail: 'list', clone: 'steps:\n  - script: bash $(arnes)/scripts/ci/viejo-c.sh\n',
  }));
  assert.strictEqual(r.code, 2);
  assert.deepStrictEqual(states(r.json), { 'viejo-a': 'con-uso', 'viejo-b': 'limpia', 'scripts/ci/viejo-c.sh': 'sin-medir' });
  assert.strictEqual(r.json.machines_unreported.length, 1);
  assert.strictEqual(r.json.failed_queries.length, 1);
});
