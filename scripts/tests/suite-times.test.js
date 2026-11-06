#!/usr/bin/env node
/**
 * suite-times.test.js — el registro de cuánto tarda cada suite y el comando que lista las lentas.
 *
 * Lo que no se puede perder:
 *   - cada corrida del portón deja un renglón con los segundos de cada suite que corrió (no las diferidas), con su carga
 *     y sus núcleos; si no puede escribir, lo dice y su salida no cambia;
 *   - una corrida que no arrancó por el turno no anota; una cortada anota lo que terminó, marcada;
 *   - dos corridas a la vez no se pisan, y el registro se queda con las últimas 200;
 *   - las portables y la validación de Azure escriben lo mismo, y en GitHub el renglón va marcado en el registro;
 *   - `slow` ordena por mediana de las últimas 5, con su tendencia, y sin datos sale 3: nunca una lista vacía.
 *
 * 🔴 REGLA DE ADMISIÓN: cada caso trae escrita la mutación que lo pone en rojo.
 *
 * stable-data: el caso del candado lee el reloj porque un candado viejo se juzga contra la hora de ahora; las fechas
 * de los renglones son fijas.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const LIB = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'suite-times.js');
const RUNNER = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'run-suites-json.js');
const CLI = path.join(ROOT, 'scripts', 'tools', 'suite-times.js');
const PORTABLES = path.join(ROOT, 'scripts', 'tests', 'portable-suites.test.sh');
const lib = () => require(LIB);

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const CLEAN = ['TYCON_SUITE_TIMES', 'TYCON_SUITE_RUNNER', 'TYCON_HOME', 'TYCON_GATE_ALL_SUITES', 'TYCON_SUITES_MAX_WORKERS',
  'TYCON_SKILLS_DIR', 'NODE_TEST_CONTEXT', 'TYCON_PUBLIC_CI_OUT', 'TYCON_SUITE_TURN', 'TYCON_PORTABLE_ONLY', 'TYCON_PORTABLE_SHARD'];
function envWith(extra) {
  const env = { ...process.env };
  for (const k of CLEAN) delete env[k];
  return { ...env, ...extra };
}

/** Un repo de juguete con suites.json y sus suites. */
function toy(suites) {
  const root = tmp('suite-times-');
  const repo = path.join(root, 'repo');
  const skills = path.join(root, 'skills');
  fs.mkdirSync(path.join(repo, 'scripts', 'tests'), { recursive: true });
  fs.mkdirSync(skills, { recursive: true });
  const entries = suites.map((s) => ({ raiz: 'arnes', ruta: `tests/${s.name}`, ...(s.gate ? { gate_only_when_touching: s.gate } : {}) }));
  fs.writeFileSync(path.join(repo, 'scripts', 'tests', 'suites.json'), JSON.stringify({ diarias: entries, semanales: [] }));
  for (const s of suites) fs.writeFileSync(path.join(repo, 'scripts', 'tests', s.name), s.body);
  return { root, repo, skills };
}

function runGate(t, env, { touched } = {}) {
  const args = [RUNNER, t.repo, path.join(t.root, 'out.json'), '--skills', t.skills];
  if (touched) {
    const f = path.join(t.root, 'touched.json');
    fs.writeFileSync(f, JSON.stringify(touched));
    args.push('--touched', f);
  }
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', env: envWith(env), timeout: 60000 });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

function findFile(dir, name) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory() && !d.isSymbolicLink()) { const f = findFile(p, name); if (f) return f; }
    else if (d.name === name) return p;
  }
  return null;
}
const lines = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('T1 Registro_UnRenglonPorCorrida_ConSusCampos — el portón anota cada suite que corrió, sin las diferidas, en la carpeta de estado', () => {
  // 🔴 mutación: anotar sólo con TYCON_SUITE_TIMES (el portón nunca anota solo), meter la diferida, o perder carga y núcleos.
  const t = toy([
    { name: 'a.test.js', body: 'process.exit(0)' },
    { name: 'b.test.sh', body: 'exit 3' },
    { name: 'c.test.js', body: 'process.exit(0)', gate: ['otra/**'] },
  ]);
  const home = tmp('suite-times-home-');
  const r = runGate(t, { HOME: home, USERPROFILE: home, TYCON_SUITE_RUNNER: 'test-gate' },
    { touched: { known: true, files: ['lib/x.js'], sources: {}, reason: null } });
  assert.equal(r.status, 1, r.out);
  const f = findFile(home, 'suite-times.jsonl');
  assert.ok(f, `no hay suite-times.jsonl en la HOME de la prueba:\n${r.out}`);
  const [e] = lines(f);
  assert.equal(e.origen, 'gate');
  assert.equal(e.repo, 'repo');
  for (const k of ['workers', 'nucleos', 'carga', 'wall_ms']) assert.equal(typeof e[k], 'number', `${k}: ${JSON.stringify(e)}`);
  assert.ok(e.nucleos >= 1);
  assert.deepEqual(e.suites.map((x) => [x.s, x.exit]), [['tests/a.test.js', 0], ['tests/b.test.sh', 3]]);
  for (const x of e.suites) assert.equal(typeof x.ms, 'number');
  assert.equal(e.cortada, undefined);
});

test('T1 — fuera del portón el corredor no anota, y a sus suites les pasa TYCON_SUITE_TIMES=off', () => {
  // 🔴 mutación: anotar por defecto en cualquier corrida (una prueba sobre un repo de juguete ensuciaría el registro de la
  //    máquina), o no apagarlo para las suites (un corredor anidado dentro de una suite anotaría sus juguetes).
  const t = toy([{ name: 'a.test.js', body: 'require("fs").writeFileSync(process.argv[1] + ".env", String(process.env.TYCON_SUITE_TIMES))' }]);
  const home = tmp('suite-times-home-');
  const r = runGate(t, { HOME: home, USERPROFILE: home });
  assert.equal(r.status, 0, r.out);
  assert.equal(findFile(home, 'suite-times.jsonl'), null, 'sin el portón no anota');
  assert.equal(fs.readFileSync(path.join(t.repo, 'scripts', 'tests', 'a.test.js.env'), 'utf8'), 'off');
});

test('T2 Registro_NoSePuedeEscribir_OcupadaOCortada — sin poder escribir avisa; la ocupada no anota; la cortada anota lo que terminó', async () => {
  // 🔴 mutación: que un registro roto cambie la salida de las suites; anotar la corrida que no arrancó; o, cortada, no
  //    anotar nada (o anotar la que estaba corriendo).
  const t = toy([{ name: 'a.test.js', body: 'process.exit(0)' }]);
  const ro = tmp('suite-times-ro-');
  fs.chmodSync(ro, 0o500);
  const r = runGate(t, { TYCON_SUITE_TIMES: path.join(ro, 'x', 'suite-times.jsonl') });
  fs.chmodSync(ro, 0o700);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /no pude anotar los tiempos/);

  // ocupada: 100 suites (el corte del turno) y un módulo de turno de mentira que dice que lo tiene otro
  const many = Array.from({ length: 100 }, (_, i) => ({ name: `s${i}.test.js`, body: 'process.exit(0)' }));
  const busy = toy(many);
  fs.mkdirSync(path.join(busy.repo, 'scripts', 'tools'), { recursive: true });
  fs.writeFileSync(path.join(busy.repo, 'scripts', 'tools', 'heavy-turn.js'),
    'module.exports = { BUSY_EXIT: 75, take: () => ({ ok: false, taken: false, message: "el turno lo tiene otra corrida" }) };');
  const fb = path.join(busy.root, 'times.jsonl');
  const rb = runGate(busy, { TYCON_SUITE_TIMES: fb });
  assert.match(rb.out, /el turno lo tiene otra corrida/, rb.out);
  assert.equal(fs.existsSync(fb), false, 'la corrida que no arrancó no anota');

  // cortada: la primera termina, la segunda se queda esperando y se corta con SIGINT
  const cut = toy([
    { name: 'a.test.js', body: 'process.exit(0)' },
    { name: 'b.test.sh', body: 'sleep 30' },
  ]);
  const fc = path.join(cut.root, 'times.jsonl');
  const child = spawn(process.execPath, [RUNNER, cut.repo, path.join(cut.root, 'out.json'), '--skills', cut.skills],
    { env: envWith({ TYCON_SUITE_TIMES: fc, TYCON_SUITES_MAX_WORKERS: '2' }), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve) => {
    child.stdout.on('data', (d) => { out += d; if (/ok\s+a\.test\.js/.test(out)) setTimeout(() => child.kill('SIGINT'), 300); });
    child.on('close', resolve);
  });
  const [e] = lines(fc);
  assert.equal(e.cortada, true, out);
  assert.deepEqual(e.suites.map((x) => x.s), ['tests/a.test.js']);
});

test('T3 Registro_Tope200_RenglonIlegible_Candado — se queda con 200, cuenta lo ilegible, y dos a la vez no se pisan', () => {
  // 🔴 mutación: sin tope (crece para siempre), un renglón roto que rompe la lectura, escribir sin candado (dos procesos
  //    pierden o mezclan renglones), no tomar un candado abandonado, o esperar para siempre uno vivo.
  const st = lib();
  const dir = tmp('suite-times-reg-');
  const f = path.join(dir, 'suite-times.jsonl');
  const run = (i) => st.entryOf({ origen: 'gate', repo: 'r', workers: 1, nucleos: 1, carga: 0, wallMs: i, suites: [{ s: 'a', ms: i, exit: 0 }], ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() });
  for (let i = 0; i < 201; i++) assert.equal(st.append(run(i), f).ok, true);
  let all = lines(f);
  assert.equal(all.length, 200);
  assert.equal(all[0].wall_ms, 1, 'se fue la más vieja');
  assert.equal(st.MAX_RUNS, 200);

  fs.appendFileSync(f, '{"esto no cierra\n');
  const read = st.readSources([f]);
  assert.equal(read.runs.length, 200);
  assert.equal(read.unreadable, 1);

  // dos procesos agregan 50 cada uno a la vez, con tope 60
  const g = path.join(dir, 'par.jsonl');
  const script = `const st=require(${JSON.stringify(LIB)});for(let i=0;i<50;i++){const r=st.append(st.entryOf({origen:'gate',repo:process.argv[1],workers:1,nucleos:1,carga:0,wallMs:i,suites:[{s:'x'.repeat(2000),ms:i,exit:0}]}),${JSON.stringify(g)},{max:60});if(!r.ok){console.error(r.reason);process.exit(1)}}`;
  const a = spawn(process.execPath, ['-e', script, 'A']);
  const b = spawn(process.execPath, ['-e', script, 'B']);
  const done = (p) => new Promise((res) => p.on('close', res));
  return Promise.all([done(a), done(b)]).then(([ca, cb]) => {
    assert.equal(ca, 0); assert.equal(cb, 0);
    all = lines(g);
    assert.equal(all.length, 60, 'renglones enteros, ninguno perdido dentro del tope ni mezclado');

    // candado abandonado (90 s): se toma; candado vivo: a los waitMs no anota y lo dice
    const h = path.join(dir, 'lock.jsonl');
    fs.writeFileSync(`${h}.lock`, '');
    const old = (Date.now() - 90000) / 1000;    fs.utimesSync(`${h}.lock`, old, old);
    assert.equal(st.append(run(1), h).ok, true);
    fs.writeFileSync(`${h}.lock`, '');
    const t0 = Date.now();
    const busy = st.append(run(2), h, { waitMs: 400 });
    assert.equal(busy.ok, false);
    assert.match(busy.reason, /candado/);
    assert.ok(Date.now() - t0 >= 400);
    assert.equal(lines(h).length, 1);
    fs.rmSync(`${h}.lock`);
  });
});

/** Una raíz de juguete con la copia de las portables y dos portables. */
function portablesToy() {
  const root = tmp('suite-times-port-');
  fs.mkdirSync(path.join(root, 'scripts', 'tests'), { recursive: true });
  fs.copyFileSync(PORTABLES, path.join(root, 'scripts', 'tests', 'portable-suites.test.sh'));
  fs.symlinkSync(path.join(ROOT, 'skills'), path.join(root, 'skills'));
  fs.writeFileSync(path.join(root, 'scripts', 'tests', 'suites.json'), JSON.stringify({ diarias: [
    { raiz: 'arnes', ruta: 'tests/p1.test.js', requiere: [] },
    { raiz: 'arnes', ruta: 'tests/p2.test.sh', requiere: [] },
  ], semanales: [] }));
  fs.writeFileSync(path.join(root, 'scripts', 'tests', 'p1.test.js'), 'process.exit(0)');
  fs.writeFileSync(path.join(root, 'scripts', 'tests', 'p2.test.sh'), 'exit 0');
  return root;
}
function runPortables(root, env) {
  const r = spawnSync('bash', [path.join(root, 'scripts', 'tests', 'portable-suites.test.sh')],
    { encoding: 'utf8', env: envWith({ TYCON_PORTABLE_HOME: path.join(root, 'casa'), ...env }), timeout: 120000 });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

test('T4 Registro_CI_MismoFormatoPorVariable — las portables escriben el mismo renglón en TYCON_SUITE_TIMES', () => {
  // 🔴 mutación: que las portables no anoten, anoten otro formato o sin su origen.
  const root = portablesToy();
  const f = path.join(root, 'times.jsonl');
  const r = runPortables(root, { TYCON_SUITE_TIMES: f });
  assert.equal(r.status, 0, r.out);
  const [e] = lines(f);
  assert.equal(e.origen, 'portables');
  assert.deepEqual(e.suites.map((x) => x.s).sort(), ['tests/p1.test.js', 'tests/p2.test.sh']);
  for (const k of ['workers', 'nucleos', 'carga', 'wall_ms']) assert.equal(typeof e[k], 'number');
});

test('T5 CI_TiemposEnElRegistroYEnElArtefacto — en GitHub el renglón sale marcado y se lee de un registro; Azure lo arma con record', () => {
  // 🔴 mutación: no imprimir el renglón marcado en la CI, que `--from` no lo lea con la hora delante, o que `record` no
  //    escriba el renglón de Azure.
  const root = portablesToy();
  const out = path.join(root, 'ci-out');
  fs.mkdirSync(out);
  const r = runPortables(root, { TYCON_PUBLIC_CI_OUT: out, TYCON_SUITE_RUNNER: 'public-ci' });
  assert.equal(r.status, 0, r.out);
  const marked = r.out.split('\n').filter((l) => l.startsWith('SUITE-TIMES {'));
  assert.equal(marked.length, 1, r.out);
  assert.equal(JSON.parse(marked[0].slice('SUITE-TIMES '.length)).origen, 'ci-github');
  const log = path.join(root, 'parte.log');
  fs.writeFileSync(log, r.out.split('\n').map((l) => `2026-11-04T12:00:00.0000000Z ${l}`).join('\n'));
  const s = spawnSync(process.execPath, [CLI, 'slow', '--from', log, '--json'], { encoding: 'utf8' });
  assert.equal(s.status, 0, s.stderr);
  assert.deepEqual(JSON.parse(s.stdout).suites.map((x) => x.s).sort(), ['tests/p1.test.js', 'tests/p2.test.sh']);

  // Azure anota el nombre del archivo; con --suites, record lo vuelve la `ruta` de suites.json (la misma clave que el
  // portón), y la carga es la que se midió al arrancar (--carga), no la de ahora.
  // 🔴 mutación: dejar el nombre suelto (la misma suite sale en dos filas al leer Azure y la máquina juntas), o medir la
  //    carga al terminar el trabajo.
  const tsv = path.join(root, 'times.tsv');
  fs.writeFileSync(tsv, 'p1.test.js\t1200\t0\np2.test.sh\t300\t1\nsin-registro.test.js\t10\t0\nroto\n');
  const jsonl = path.join(root, 'azure', 'suite-times.jsonl');
  const rec = spawnSync(process.execPath, [CLI, 'record', '--tsv', tsv, '--source', 'ci-azure', '--out', jsonl, '--workers', '2',
    '--wall-ms', '1500', '--repo', 'privado', '--carga', '3.5', '--suites', path.join(root, 'scripts', 'tests', 'suites.json')], { encoding: 'utf8' });
  assert.equal(rec.status, 0, rec.stderr);
  assert.match(rec.stdout, /1 renglón ilegible/);
  const [e] = lines(jsonl);
  assert.equal(e.origen, 'ci-azure');
  assert.equal(e.carga, 3.5);
  assert.deepEqual(e.suites, [{ s: 'tests/p1.test.js', ms: 1200, exit: 0 }, { s: 'tests/p2.test.sh', ms: 300, exit: 1 }, { s: 'sin-registro.test.js', ms: 10, exit: 0 }]);
  const both = spawnSync(process.execPath, [CLI, 'slow', '--from', jsonl, '--from', log, '--json'], { encoding: 'utf8' });
  const p1 = JSON.parse(both.stdout).suites.filter((x) => /p1\.test\.js$/.test(x.s));
  assert.deepEqual(p1.map((x) => [x.s, x.n]), [['tests/p1.test.js', 2]], 'Azure y GitHub juntan la misma suite en una fila');
});

/** Un registro de juguete con corridas fechadas en orden. */
function registry(runs) {
  const dir = tmp('suite-times-cli-');
  const f = path.join(dir, 'r.jsonl');
  fs.writeFileSync(f, runs.map((r, i) => JSON.stringify({ v: 1, ts: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(), repo: 'r', workers: 4, nucleos: 10, wall_ms: 1000, ...r })).join('\n'));
  return f;
}
const cli = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8' });

test('T6 Slow_MedianaMaximoYOrigen — ordena por mediana de las últimas 5, con máximo y cuenta, y filtra', () => {
  // 🔴 mutación: ordenar por la última medición o por el máximo, ignorar `--source` o `--max-load`, o callar de dónde salió.
  const runs = [];
  const lentas = [900, 100, 100, 100, 100, 100, 100];   // la vieja de 900 no cuenta para la mediana
  for (let i = 0; i < 7; i++) {
    runs.push({ origen: i < 5 ? 'gate' : 'ci-github', carga: i === 6 ? 9 : 1,
      suites: [{ s: 'a', ms: lentas[i], exit: 0 }, { s: 'b', ms: 200, exit: 0 }, { s: 'c', ms: 50, exit: 0 }] });
  }
  const f = registry(runs);
  const r = cli('slow', '--from', f, '--top', '2', '--json');
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.suites.map((x) => x.s), ['b', 'a']);
  assert.equal(j.suites[1].mediana, 100);
  assert.equal(j.suites[1].max, 900);
  assert.equal(j.suites[1].n, 7);
  assert.equal(j.corridas, 7);
  assert.deepEqual(j.origenes, { gate: 5, 'ci-github': 2 });
  assert.equal(cli('slow', '--from', f, '--source', 'gate', '--json').stdout.includes('"corridas": 5'), true);
  assert.equal(JSON.parse(cli('slow', '--from', f, '--max-load', '4', '--json').stdout).corridas, 6);
  const txt = cli('slow', '--from', f, '--top', '2');
  assert.match(txt.stdout, /de 7 ejecuciones/);
  assert.match(txt.stdout, /gate 5/);
  assert.match(txt.stdout, /2026-11-01/);
});

test('T7 Slow_Tendencia — sube, igual o sin tendencia', () => {
  // 🔴 mutación: comparar contra la primera medición, otro umbral que 15 %, o dar tendencia con menos de 6.
  const st = lib();
  assert.equal(st.trend([100, 100, 100, 100, 100, 130, 130, 130, 130, 130]), 'sube');
  assert.equal(st.trend([100, 100, 100, 100, 100, 110, 110, 110, 110, 110]), 'igual');
  assert.equal(st.trend([130, 130, 130, 130, 130, 100, 100, 100, 100, 100]), 'baja');
  assert.equal(st.trend([100, 100, 100, 100]), 'sin tendencia');
  assert.equal(st.trend([100, 100, 100, 200, 200, 200]), 'sube', 'con 6 ya compara: la mediana de las últimas 5 contra la primera');
  // 🔴 mutación: con la mediana anterior en 0 (una suite de menos de 1 s medida en segundos) dar «igual» aunque crezca
  assert.equal(st.trend([0, 0, 0, 0, 0, 5000, 5000, 5000, 5000, 5000]), 'sube');
  assert.equal(st.trend([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 'igual');
});

test('T8 SlowSinRegistroSale3_RunsLista — sin datos sale 3 con el motivo; runs lista cada corrida', () => {
  // 🔴 mutación: imprimir una lista vacía y salir 0, o que `runs` pierda columnas.
  const dir = tmp('suite-times-vacio-');
  const vacio = path.join(dir, 'v.jsonl');
  fs.writeFileSync(vacio, '');
  for (const args of [['--from', path.join(dir, 'no-existe.jsonl')], ['--from', vacio], ['--from', registry([{ origen: 'gate', carga: 1, suites: [{ s: 'a', ms: 1, exit: 0 }] }]), '--source', 'ci-azure']]) {
    const r = cli('slow', ...args);
    assert.equal(r.status, 3, `${args.join(' ')}: ${r.stdout}`);
    assert.match(`${r.stdout}${r.stderr}`, /no hay ejecuciones/);
  }
  const f = registry([
    { origen: 'gate', carga: 1.5, suites: [{ s: 'a', ms: 1000, exit: 0 }, { s: 'b', ms: 2000, exit: 0 }] },
    { origen: 'portables', carga: 2, cortada: true, suites: [{ s: 'a', ms: 500, exit: 0 }] },
    { origen: 'gate', carga: 3, suites: [{ s: 'a', ms: 700, exit: 0 }] },
  ]);
  const r = cli('runs', '--from', f, '--last', '2', '--json');
  assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(r.stdout).runs;
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]).filter((k) => k !== 'cortada').sort(), ['carga', 'nucleos', 'origen', 'repo', 'suites', 'suma_ms', 'ts', 'wall_ms', 'workers']);
  assert.equal(rows[0].cortada, true);
  assert.equal(rows[1].suma_ms, 700);
  assert.match(cli('runs', '--from', f).stdout, /portables/);
  // 🔴 mutación: aceptar 0 (`slice(-0)` devuelve todas)
  assert.equal(cli('runs', '--from', f, '--last', '0').status, 2);
  assert.equal(cli('slow', '--from', f, '--top', '0').status, 2);
});
