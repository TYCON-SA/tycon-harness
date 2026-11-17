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

// ── Las horas de repetición por día, desde gates.log ──────────────────────────────────────────────────────────────────
const local = (dia, hora, min = 0) => new Date(2026, 10, dia, hora, min).toISOString();
function gatesLog(lineas) {
  const f = path.join(tmp('suite-times-gates-'), 'gates.log');
  fs.writeFileSync(f, `${lineas.map((x) => JSON.stringify(x)).join('\n')}\n`);
  return f;
}
const run = (ts, sessionId, story, modo, motivo, min) => ({ ts, sessionId, repoPath: '/r', name: 'test-gate-run', story, modo, motivo,
  origen_at: null, suites: 3, duracion_ms: min * 60000, exit: 0, guardo: 'verde', guardo_motivo: null });
const check = (ts, sessionId, storyId, cmd, min, exit = 0) => ({ ts, sessionId, repoPath: '/r', check: 'tests', status: exit ? `red:exit=${exit}` : 'green',
  provenance: 'test-gate', cmd, exit, durationMs: min * 60000, storyId });
const RSJ = 'node /x/lib/run-suites-json.js';

test('T11 Repeats_FromRunLines_HoursByModeAndMotive @story-8.297 @ac-10 — por día, corridas y horas de cada modo, y las enteras por motivo', () => {
  // 🔴 mutación: agrupar por hora UTC corre al día siguiente una corrida de la noche
  const f = gatesLog([
    run(local(10, 9), 's1', '8.1', 'primera', 'no hay un verde guardado de esta historia en esta sesión', 30),
    run(local(10, 11), 's1', '8.1', 'entera', 'cambió un control (scripts/ci/x.js)', 20),
    run(local(10, 12), 's1', '8.1', 'acotada', 'la carpeta cambió desde la completa verde', 5),
    run(local(10, 23, 50), 's1', '8.1', 'sin correr', 'la carpeta es la que midió la completa verde', 0),
    run(local(11, 9), 's2', '8.2', 'entera', 'lo guardado es de otra historia (8.1)', 10),
    run(local(11, 10), 's2', '8.2', 'entera', 'lo guardado es de otra historia (8.1)', 15),
    { ts: local(11, 10, 30), sessionId: 's2', name: 'tests-no-turn', status: 'blocked' },
  ]);
  const r = cli('repeats', '--log', f, '--json');
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.dias.map((d) => d.dia), ['2026-11-10', '2026-11-11']);
  const [d1, d2] = j.dias;
  assert.deepEqual([d1.primera, d1.entera, d1.acotada, d1.sin_correr], [{ n: 1, ms: 1800000 }, { n: 1, ms: 1200000 }, { n: 1, ms: 300000 }, { n: 1, ms: 0 }]);
  assert.deepEqual(d2.entera, { n: 2, ms: 1500000 });
  assert.deepEqual(d2.enteras_por_motivo, [{ motivo: 'lo guardado es de otra historia (8.1)', n: 2, ms: 1500000 }]);
  const texto = cli('repeats', '--log', f, '--since', '2026-11-11', '--until', '2026-11-11');
  assert.equal(texto.status, 0, texto.stderr);
  assert.match(texto.stdout, /2026-11-11/);
  assert.doesNotMatch(texto.stdout, /2026-11-10/);
  assert.match(texto.stdout, /entera\D+2 ejecución\(es\), 0,4 h/);
  assert.match(texto.stdout, /lo guardado es de otra historia \(8\.1\)/);
});

test('T12 Repeats_OldDays_FromCheckCommand_NoMotive @story-8.297 @ac-10 — los días de antes se clasifican por el comando, sin achicar', () => {
  // 🔴 mutación: contar la segunda completa de la misma historia y sesión como «primera» achica las repeticiones
  const T = '/var/folders/T';
  const f = gatesLog([
    check(local(12, 8), 's9', '7.1', `node /x/lib/failed-first.js merge --dir /e/red-full/s9 --out ${T}/suites.json`, 0),
    check(local(12, 9), 's9', '7.1', `${RSJ} /r ${T}/suites.json --touched ${T}/touched-repetidas.json --coverage ${T}/cov --run-check tests`, 4),
    check(local(12, 9, 1), 's9', '7.1', `node /x/lib/failed-first.js merge --dir /e/green-full/s9 --new ${T}/suites-nuevas.json --out ${T}/suites.json`, 0),
    check(local(12, 10), 's8', '7.2', `${RSJ} ${T}/arbol-privado-AB/arbol ${T}/suites.json --touched ${T}/touched.json --skills ${T}/arbol-privado-AB/arbol/skills --scoped-by-repo la CI --coverage ${T}/cov --run-check tests`, 6),
    check(local(12, 11), 's1', '7.3', `${RSJ} /r ${T}/suites.json --touched ${T}/touched.json --only-touched --coverage ${T}/cov --run-check tests`, 30),
    check(local(12, 12), 's1', '7.3', `${RSJ} /r ${T}/suites.json --touched ${T}/touched.json --only-touched --coverage ${T}/cov --run-check tests`, 20, 1),
    check(local(12, 13), 's1', '7.3', `${RSJ} /r ${T}/suites.json --touched ${T}/touched.json --only-touched --coverage ${T}/cov --run-check tests`, 0, 77),
    check(local(12, 14), 's1', '7.3', `${RSJ} /r ${T}/suites.json --suite tests/a.test.sh --run-check tests`, 3),
  ]);
  const r = cli('repeats', '--log', f, '--json');
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const [d] = JSON.parse(r.stdout).dias;
  assert.deepEqual([d.sin_correr.n, d.acotada.n, d.primera.n, d.entera.n], [1, 2, 1, 1]);
  assert.deepEqual(d.enteras_por_motivo, [{ motivo: 'sin motivo: de antes del registro', n: 1, ms: 1200000 }]);
  // la corrida con su renglón test-gate-run no se cuenta dos veces por su check tests
  const g = gatesLog([
    check(local(13, 9, 29), 's5', '7.5', `${RSJ} /r ${T}/suites.json --touched ${T}/touched.json --coverage ${T}/cov --run-check tests`, 29),
    run(local(13, 9, 30), 's5', '7.5', 'primera', 'no hay un verde guardado de esta historia en esta sesión', 30),
  ]);
  const [e] = JSON.parse(cli('repeats', '--log', g, '--json').stdout).dias;
  assert.deepEqual([e.primera.n, e.entera.n], [1, 0]);
  // la corrida del repo hermano es parte de la corrida que la lanzó: no es otra entera. Una que no corrió nada (7) o que
  // se cortó (143) no cuenta; una salida que no se sabe leer no se pierde callada: cuenta entre las que no pude leer
  const h = gatesLog([
    run(local(14, 10), 's6', '7.6', 'primera', 'no hay un verde guardado de esta historia en esta sesión', 10),
    check(local(14, 10, 20), 's6', '7.6', `${RSJ} /hermano ${T}/suites.json --touched ${T}/touched.json --only-touched --coverage ${T}/cov --run-check tests`, 18),
    { ts: local(14, 10, 20), sessionId: 's6', name: 'run-check-companion', check: 'tests', cmd: `${RSJ} /hermano ${T}/suites.json --touched ${T}/touched.json --only-touched --coverage ${T}/cov --run-check tests` },
    // el mismo comando en otra sesión no es del hermano: cuenta
    check(local(14, 10, 30), 's7', '7.7', `${RSJ} /hermano ${T}/suites.json --touched ${T}/touched.json --only-touched --coverage ${T}/cov --run-check tests`, 5),
    check(local(14, 10, 40), 's6', '7.6', `${RSJ} /r ${T}/suites.json --touched ${T}/touched.json --only-touched --coverage ${T}/cov --run-check tests`, 0, 7),
    check(local(14, 10, 50), 's6', '7.6', `${RSJ} /r ${T}/suites.json --touched ${T}/touched.json --coverage ${T}/cov --run-check tests`, 3, 143),
    check(local(14, 11), 's6', '7.6', `${RSJ} /r ${T}/suites.json --touched ${T}/touched.json --coverage ${T}/cov --run-check tests`, 2, 3),
  ]);
  const hj = JSON.parse(cli('repeats', '--log', h, '--json').stdout);
  // la del hermano no cuenta; la de la otra sesión es la primera de la suya
  assert.deepEqual([hj.dias[0].primera.n, hj.dias[0].entera.n], [2, 0]);
  assert.equal(hj.descartados, 1);
  // los bordes de la marca: saca un solo check, el más cercano, a 10 s o menos antes o después, con el mismo comando
  // 🔴 mutación: una marca que saca todos los checks de su ventana pierde la corrida de arriba que terminó segundos antes
  const seg = (hora, min, s) => new Date(2026, 10, 15, hora, min, s).toISOString();
  const X = `${RSJ} /r ${T}/suites.json --touched ${T}/touched.json --coverage ${T}/cov --run-check tests`;
  const Y = `${RSJ} /otro ${T}/suites.json --run-check tests`;
  const marca = (ts, cmd = X) => ({ ts, sessionId: 's8', name: 'run-check-companion', check: 'tests', cmd });
  const k = gatesLog([
    check(seg(10, 0, 0), 's8', '7.8', X, 1), check(seg(10, 0, 4), 's8', '7.8', X, 1), marca(seg(10, 0, 5)),
    check(seg(10, 10, 0), 's8', '7.8', X, 1), marca(seg(10, 10, 9)),
    marca(seg(10, 20, 5)), check(seg(10, 20, 10), 's8', '7.8', X, 1),
    check(seg(10, 30, 0), 's8', '7.8', X, 1), marca(seg(10, 30, 11)),
    check(seg(10, 40, 0), 's8', '7.8', X, 1), marca(seg(10, 40, 1), Y),
    { ts: 'no es una hora', sessionId: 's8', name: 'run-check-companion', check: 'tests', cmd: X },
  ]);
  const kj = JSON.parse(cli('repeats', '--log', k, '--json').stdout);
  // cuentan la de arriba de las 10:00, la de las 10:30 (marca a 11 s) y la de las 10:40 (marca de otro comando)
  assert.deepEqual([kj.dias[0].primera.n, kj.dias[0].entera.n], [1, 2]);
  assert.equal(kj.descartados, 1, 'la marca con una hora ilegible se cuenta');
});

test('T13 Repeats_NoLogOrNoRuns_Exit3 @story-8.297 @ac-11 — sin registro, ilegible o sin corridas en el rango: sale 3 y lo dice', (t) => {
  // 🔴 mutación: imprimir «0 h» y salir 0 haría pasar «sin datos» por «sin repeticiones»
  const dir = tmp('suite-times-sin-');
  const ilegible = path.join(dir, 'gates.log');
  fs.writeFileSync(ilegible, `${JSON.stringify(run(local(10, 9), 's1', '8.1', 'entera', 'x', 5))}\n`);
  fs.chmodSync(ilegible, 0o000);
  t.after(() => fs.chmodSync(ilegible, 0o644));
  // como root el archivo sin permisos se lee igual: ese caso no se puede armar, los otros sí
  const root = typeof process.getuid === 'function' && process.getuid() === 0;
  const fuera = gatesLog([run(local(10, 9), 's1', '8.1', 'entera', 'x', 5)]);
  for (const args of [['--log', path.join(dir, 'no-existe.log')], ...(root ? [] : [['--log', ilegible]]), ['--log', fuera, '--since', '2026-11-20']]) {
    const r = cli('repeats', ...args);
    assert.equal(r.status, 3, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /no hay ejecuciones que leer/);
  }
  // un renglón cortado no cuenta, y se dice cuántos fueron
  const cortado = path.join(tmp('suite-times-cortado-'), 'gates.log');
  fs.writeFileSync(cortado, `${JSON.stringify(run(local(10, 9), 's1', '8.1', 'entera', 'x', 5))}\n{"name":"test-gate-run","ts":"2026-11-10T1\n`);
  const conAviso = cli('repeats', '--log', cortado);
  assert.equal(conAviso.status, 0, conAviso.stderr);
  assert.match(conAviso.stdout, /1 renglón\(es\) de ejecuciones que no pude leer: no cuentan/);
  assert.equal(JSON.parse(cli('repeats', '--log', cortado, '--json').stdout).descartados, 1);
  // una fecha que no existe no apaga el filtro en silencio ni rueda al mes siguiente: sale 2 y lo dice
  for (const v of ['2026-02-31', '2026-13-45', '2026-11-17T25:00', '2026-02-31T10:00']) {
    const mal = cli('repeats', '--log', cortado, '--since', v);
    assert.equal(mal.status, 2, `${v}: ${mal.stdout}${mal.stderr}`);
    assert.match(mal.stderr, /no existe/);
  }
  // sin --log lee el de la carpeta de estado: con una casa vacía, tampoco hay
  const home = tmp('suite-times-home-');
  const r = spawnSync(process.execPath, [CLI, 'repeats'], { encoding: 'utf8', env: envWith({ HOME: home, USERPROFILE: home }) });
  assert.equal(r.status, 3, `${r.stdout}${r.stderr}`);
});
