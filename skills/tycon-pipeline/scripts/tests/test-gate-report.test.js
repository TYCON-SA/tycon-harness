'use strict';
/**
 * Pruebas del informe de test-gate.sh en Node.
 *
 * lib/test-gate-report.js arma el informe de test-gate.sh: lee la salida de cada corredor de pruebas y escribe
 * `.advisors/tests-result.json` (en Windows `python3` no es requisito). Reemplaza a un bloque de Python
 * (`python3 - … <<'PY'`) con los mismos argumentos y el mismo artefacto.
 *
 *   T69 · para cada corredor (dotnet con su trx y su cobertura, vitest, jest, `node --test` y el suites.json del
 *         arnés), el JSON que escribe Node es igual —campo por campo y en el mismo orden— al que escribía el bloque de
 *         Python sobre las mismas entradas; lo mismo la copia que viaja y la línea de gates.log. Y test-gate.sh corre
 *         de punta a punta con un PATH sin `python3`.
 *   T70 · smoke-run.sh corre contra un servidor de juguete con un PATH sin `python3` y deja lo mismo que con Python.
 *   T73 · sin el corredor (`npx` o `dotnet` fuera del PATH) test-gate.sh dice «no pude correr las pruebas: falta …» y
 *         el artefacto lo anota, nunca verde; sin `timeout` ni `realpath` da el mismo resultado. (La parte del `claude`
 *         que en Windows es un `.cmd` está en lane-classifier.test.js.)
 *
 * Las esperadas (fixtures/test-gate-report/<caso>/expected.json) se capturaron corriendo el bloque de Python original
 * sobre las mismas entradas:
 *     node tests/test-gate-report.test.js --capture <bloque.py>
 * Las rutas de la carpeta temporal se guardan como <TMP>; la hora de la línea de gates.log no se compara.
 * Nada de nombres reales: acme.
 *
 * Correr: node skills/tycon-pipeline/scripts/tests/test-gate-report.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync, execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const REPORT = path.join(SCRIPTS, 'lib', 'test-gate-report.js');
const GATE = path.join(SCRIPTS, 'test-gate.sh');
const SMOKE = path.join(SCRIPTS, 'smoke-run.sh');
const FIXTURES = path.join(__dirname, 'fixtures', 'test-gate-report');
const SESION = 'sesion-acme-w6';
// test-gate.sh exporta la clave de la copia sellada (TYCON_EVIDENCE_KEY, o _FAILED si no la pudo calcular) cuando recibe
// la ruta de una story, y esta suite corre dentro de él: el informe de cada caso de juguete la tomaba en vez del id del
// caso. Lo de afuera no entra a los casos.
delete process.env.TYCON_EVIDENCE_KEY;
delete process.env.TYCON_EVIDENCE_KEY_FAILED;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'acme@example.com',
  GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'acme@example.com',
};
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
// Carpetas temporales de las pruebas: se borran todas al salir (los PATH armados son miles de enlaces).
const temporales = [];
const tmpReal = (prefijo) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefijo))); temporales.push(d); return d; };
process.on('exit', () => { for (const d of temporales) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* ya no está */ } } });

// ── el caso de juguete: un repo git con su historia, las salidas del corredor y los argumentos de test-gate.sh ──

function contenido(spec) {
  if (typeof spec.text === 'string') return spec.text;
  const cambiadas = new Set(spec.changed || []);
  return Array.from({ length: spec.lines }, (_, i) => (cambiadas.has(i + 1) ? `cambio ${i + 1}` : `linea ${i + 1}`)).join('\n') + '\n';
}

function escribir(repo, mapa) {
  for (const [rel, spec] of Object.entries(mapa || {})) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), contenido(spec));
  }
}

// Copia la carpeta de salidas del caso reemplazando <REPO_RUN> por la ruta de verdad, escapada según el formato.
function copiarSalidas(origen, destino, repoRun) {
  fs.mkdirSync(destino, { recursive: true });
  if (!fs.existsSync(origen)) return;
  for (const e of fs.readdirSync(origen, { withFileTypes: true })) {
    const de = path.join(origen, e.name);
    const a = path.join(destino, e.name);
    if (e.isDirectory()) { copiarSalidas(de, a, repoRun); continue; }
    fs.writeFileSync(a, conRuta(fs.readFileSync(de, 'utf8'), e.name, repoRun));
  }
}

function conRuta(texto, nombre, repoRun) {
  const valor = /\.json$/.test(nombre) ? JSON.stringify(repoRun).slice(1, -1)
    : /\.(xml|trx)$/.test(nombre) ? repoRun.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      : repoRun;
  return texto.split('<REPO_RUN>').join(valor);
}

function armarCaso(nombre) {
  const dir = path.join(FIXTURES, nombre);
  const c = JSON.parse(fs.readFileSync(path.join(dir, 'case.json'), 'utf8'));
  const tmp = tmpReal('tgr-caso-');
  const repo = path.join(tmp, 'repo');
  const home = path.join(tmp, 'home');
  const evidencia = path.join(tmp, 'evidencia');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
  escribir(repo, c.base);
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'base', '--allow-empty']);
  if (c.after) { escribir(repo, c.after); git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'despues']); }
  escribir(repo, c.now);
  const repoRun = c.repo_run ? path.join(repo, c.repo_run) : repo;
  fs.mkdirSync(repoRun, { recursive: true });
  const results = path.join(tmp, 'results');
  copiarSalidas(path.join(dir, 'results'), results, repoRun);
  if (fs.existsSync(path.join(dir, 'coverage-final.json'))) {
    fs.mkdirSync(path.join(repoRun, 'coverage'), { recursive: true });
    fs.writeFileSync(path.join(repoRun, 'coverage', 'coverage-final.json'),
      conRuta(fs.readFileSync(path.join(dir, 'coverage-final.json'), 'utf8'), 'coverage-final.json', repoRun));
  }
  const out = path.join(tmp, 'out', 'tests-result.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const args = [c.runner, repo, repoRun, results, out, c.suite_exit, c.story_id, c.cov_min, c.ts,
    c.test_project_count, c.scope, c.scope_source, (c.declared_new || []).join('\n'),
    typeof c.code_state === 'string' ? c.code_state : JSON.stringify(c.code_state),
    c.base_ref, c.base_json_raw !== undefined ? c.base_json_raw : JSON.stringify(c.base_json)];
  return { c, dir, tmp, repo, home, evidencia, out, args: args.slice(0, c.argc || args.length) };
}

// Corre el informe (Node, o el bloque de Python con --capture) y devuelve lo que dejó, normalizado.
function correrInforme(caso, comando, extraEnv = {}) {
  const env = { ...process.env, HOME: caso.home, USERPROFILE: caso.home, GATE_SESSION_ID: SESION, TYCON_EVIDENCE_DIR: caso.evidencia, ...extraEnv };
  const r = spawnSync(comando[0], [...comando.slice(1), ...caso.args], { encoding: 'utf8', env });
  const leer = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
  const gl = path.join(caso.home, '.claude', '.tycon-pipeline', 'gates.log');
  const gates = fs.existsSync(gl)
    ? fs.readFileSync(gl, 'utf8').split('\n').filter(Boolean).map((l) => { const { ts, ...resto } = JSON.parse(l); return resto; })
    : [];
  const sellada = caso.c.story_id ? leer(path.join(caso.evidencia, `${caso.c.story_id}-tests-result.json`)) : null;
  const tmpRe = new RegExp(caso.tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  const normal = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v), (k, x) => (typeof x === 'string' ? x.replace(tmpRe, '<TMP>') : x));
  return { rc: r.status, stderr: r.stderr, stdout: r.stdout, got: normal({ tests_result: leer(caso.out), sellada, gates }) };
}

const CASOS = fs.readdirSync(FIXTURES).filter((n) => fs.existsSync(path.join(FIXTURES, n, 'case.json'))).sort();

// ── modo captura: corre el bloque de Python original y guarda la esperada de cada caso ────────────────
if (process.argv[2] === '--capture') {
  const py = process.argv[3];
  if (!py || !fs.existsSync(py)) { console.error('uso: test-gate-report.test.js --capture <bloque.py>'); process.exit(2); }
  for (const n of CASOS) {
    const caso = armarCaso(n);
    const { rc, stderr, got } = correrInforme(caso, ['python3', py]);
    if (rc !== 0 || !got.tests_result) { console.error(`✗ ${n}: el bloque de Python salió ${rc}\n${stderr}`); process.exit(1); }
    fs.writeFileSync(path.join(FIXTURES, n, 'expected.json'), JSON.stringify(got, null, 2) + '\n');
    console.log(`✓ ${n}: esperada capturada`);
  }
  process.exit(0);
}

const { test } = require('node:test');
const assert = require('node:assert');

// ── un PATH sin ciertas herramientas: enlaces a todo lo del PATH de hoy, menos lo excluido ─────────────────────
const SIN_PYTHON = (n) => /^python/i.test(n);
const yaArmados = new Map(); // un PATH por criterio: armarlo son miles de enlaces
function pathSin(excluir) {
  if (yaArmados.has(excluir)) return yaArmados.get(excluir);
  const dir = tmpReal('tgr-bin-');
  yaArmados.set(excluir, dir);
  const vistos = new Set();
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    let nombres = [];
    try { nombres = fs.readdirSync(d); } catch (_) { continue; }
    for (const n of nombres) {
      if (vistos.has(n) || excluir(n)) continue;
      const full = path.join(d, n);
      try { fs.accessSync(full, fs.constants.X_OK); if (!fs.statSync(full).isFile()) continue; } catch (_) { continue; }
      vistos.add(n);
      try { fs.symlinkSync(full, path.join(dir, n)); } catch (_) { /* un nombre raro: se saltea */ }
    }
  }
  return dir;
}
const tiene = (PATH, herramienta) => spawnSync('bash', ['-c', `command -v ${herramienta}`], { env: { ...process.env, PATH } }).status === 0;

// Un `npx` de juguete que hace de `vitest run --coverage --reporter=json --outputFile <f>`: deja el JSON y la cobertura.
function binDeJuguete() {
  const dir = tmpReal('tgr-fakebin-');
  fs.writeFileSync(path.join(dir, 'npx'), [
    '#!/usr/bin/env bash',
    '# npx de juguete (test-gate-report.test.js): hace de vitest y deja su JSON y su cobertura',
    'out=""; while [ $# -gt 0 ]; do [ "$1" = "--outputFile" ] && out="$2"; shift; done',
    "printf '%s' '{\"numTotalTests\":3,\"numPassedTests\":3,\"numFailedTests\":0,\"numPendingTests\":0}' > \"$out\"",
    'mkdir -p coverage',
    "printf '{\"%s/src/acme.js\":{\"statementMap\":{\"0\":{\"start\":{\"line\":1,\"column\":0},\"end\":{\"line\":1,\"column\":5}},\"1\":{\"start\":{\"line\":2,\"column\":0},\"end\":{\"line\":2,\"column\":5}}},\"s\":{\"0\":1,\"1\":0}}}' \"$PWD\" > coverage/coverage-final.json",
    'exit 0', '',
  ].join('\n'), { mode: 0o755 });
  return dir;
}

function repoDeJuguete(tipo) {
  const repo = path.join(tmpReal('tgr-repo-'), 'acme');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
  if (tipo === 'suites-json') {
    fs.mkdirSync(path.join(repo, 'scripts', 'tests'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'scripts', 'tests', 'ok.test.sh'), 'exit 0\n');
    fs.writeFileSync(path.join(repo, 'scripts', 'tests', 'suites.json'),
      JSON.stringify({ diarias: [{ raiz: 'arnes', ruta: 'tests/ok.test.sh' }], semanales: [] }));
  } else if (tipo === 'vitest') {
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"acme","devDependencies":{"vitest":"^1.0.0"}}\n');
  } else if (tipo === 'dotnet') {
    fs.writeFileSync(path.join(repo, 'Acme.csproj'), '<Project Sdk="Microsoft.NET.Sdk"/>\n');
  }
  fs.writeFileSync(path.join(repo, 'README.md'), 'acme\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'base']);
  if (tipo === 'vitest') { fs.mkdirSync(path.join(repo, 'src')); fs.writeFileSync(path.join(repo, 'src', 'acme.js'), 'a()\nb()\n'); }
  return repo;
}

function correrGate(repo, story, PATH, home) {
  const env = { ...process.env, PATH, HOME: home, CLAUDE_CODE_SESSION_ID: SESION, TYCON_COVERAGE_BASE: '' };
  delete env.TYCON_TEST_SCOPE; delete env.TYCON_EVIDENCE_DIR;
  const r = spawnSync('bash', [GATE, repo, story], { encoding: 'utf8', env, timeout: 180000 });
  const f = path.join(repo, '.advisors', 'tests-result.json');
  return { ...r, art: fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null };
}

// Lo que cambia entre dos corridas iguales: la hora, lo que tardó y las rutas temporales.
function comparable(art) {
  const a = JSON.parse(JSON.stringify(art));
  delete a.ts;
  if (a.totals) delete a.totals.wall_ms;
  return a;
}

// ── T69 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T69 TestGate_NodeReport_EqualsThePythonReport_WorksWithoutPython3 — el informe de Node es el del bloque de Python, campo por campo', () => {
  assert.ok(CASOS.length >= 5, `faltan casos en ${FIXTURES}`);
  const corredores = new Set(CASOS.map((n) => JSON.parse(fs.readFileSync(path.join(FIXTURES, n, 'case.json'), 'utf8')).runner));
  for (const r of ['dotnet', 'vitest', 'jest', 'node-test', 'suites-json']) assert.ok(corredores.has(r), `ningún caso guardado para el corredor ${r}`);
  const sinPython = pathSin(SIN_PYTHON);
  assert.ok(!tiene(sinPython, 'python3'), 'el PATH de la prueba todavía trae python3');
  for (const n of CASOS) {
    if (JSON.parse(fs.readFileSync(path.join(FIXTURES, n, 'case.json'), 'utf8')).sin_python) continue;   // ese caso lo fija su propia prueba
    const esperada = JSON.parse(fs.readFileSync(path.join(FIXTURES, n, 'expected.json'), 'utf8'));
    const caso = armarCaso(n);
    const { rc, stderr, got } = correrInforme(caso, [process.execPath, REPORT], { PATH: sinPython });
    assert.strictEqual(rc, 0, `${n}: el informe salió ${rc}\n${stderr}`);
    // lo único que el bloque de Python no escribía es de dónde salió el umbral; el resto, igual
    for (const art of [got.tests_result, got.sellada]) {
      if (!art || !art.coverage) continue;
      assert.ok(['maquina', 'organizacion', 'por_defecto'].includes(art.coverage.threshold_source), `${n}: threshold_source ${art.coverage.threshold_source}`);
      delete art.coverage.threshold_source;
      delete art.coverage.threshold_problems;
    }
    assert.deepStrictEqual(got.tests_result, esperada.tests_result, `${n}: tests-result.json distinto`);
    // el mismo orden de las claves, no sólo los mismos valores: quien lo lea a ojo ve lo mismo que antes
    assert.strictEqual(JSON.stringify(got.tests_result), JSON.stringify(esperada.tests_result), `${n}: mismo contenido, otro orden`);
    assert.deepStrictEqual(got.sellada, esperada.sellada, `${n}: la copia que viaja es distinta`);
    assert.deepStrictEqual(got.gates, esperada.gates, `${n}: la línea de gates.log es distinta`);
    fs.rmSync(caso.tmp, { recursive: true, force: true });
  }
});

test('T69 …test-gate.sh no llama a python3, y corre de punta a punta sin él (suites.json y vitest)', () => {
  const codigo = fs.readFileSync(GATE, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(codigo, /\bpython3?\b/, 'test-gate.sh todavía nombra a python fuera de un comentario');
  assert.match(codigo, /lib\/test-gate-report\.js/, 'test-gate.sh no llama al informe de Node');
  const sinPython = pathSin(SIN_PYTHON);
  for (const tipo of ['suites-json', 'vitest']) {
    const repo = repoDeJuguete(tipo);
    const PATH = tipo === 'vitest' ? binDeJuguete() + path.delimiter + sinPython : sinPython;
    const r = correrGate(repo, '9.5', PATH, tmpReal('tgr-home-'));
    assert.strictEqual(r.status, 0, `${tipo}: test-gate.sh salió ${r.status}\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /parser falló|python3: command not found|python3: not found/, `${tipo}: ${r.stderr}`);
    assert.ok(r.art && r.art.runner === tipo && r.art.suite_green === true, `${tipo}: ${JSON.stringify(r.art)}`);
    if (tipo === 'vitest') {
      assert.deepStrictEqual(r.art.totals, { total: 3, passed: 3, failed: 0, skipped: 0 });
      assert.strictEqual(r.art.coverage.per_new_file['src/acme.js'], 50, 'la cobertura del archivo nuevo sale del informe de Node');
      assert.strictEqual(r.art.coverage.touched_lines_pct, 50);
    } else {
      assert.strictEqual(r.art.totals.suites, 1);
      assert.strictEqual(r.art.totals.passed, 1);
    }
  }
});

// ── T70 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
function correrAsync(cmd, args, opts) {
  return new Promise((resolve) => {
    const h = spawn(cmd, args, opts);
    let stdout = ''; let stderr = '';
    h.stdout.on('data', (d) => { stdout += d; });
    h.stderr.on('data', (d) => { stderr += d; });
    h.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('T70 SmokeRun_WorksWithoutPython3 — smoke-run.sh contra un servidor de juguete, sin python3', async () => {
  const codigo = fs.readFileSync(SMOKE, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(codigo, /\bpython3?\b/, 'smoke-run.sh todavía llama a python');
  const servidor = http.createServer((req, res) => {
    if (req.url === '/api/acme/pedidos') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
    res.writeHead(500); res.end('roto');
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const PATH = pathSin(SIN_PYTHON);
  const tmp = tmpReal('tgr-smoke-');
  const repo = path.join(tmp, 'repo');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
  const ev = path.join(repo, '.advisors', 'dod-runtime');
  const env = { ...process.env, PATH, HOME: home };
  const pedir = (url) => [process.execPath, '-e', 'fetch(process.argv[1],{headers:{authorization:"Bearer acmeSecreto123456789"}}).then(r=>process.exit(r.ok?0:1),()=>process.exit(2))', url];
  try {
    const ok = await correrAsync('bash', [SMOKE, ev, '9.10', '--acs', '3,4', '--pass-if', 'responde 200 con los pedidos', '--', ...pedir(`${base}/api/acme/pedidos`)], { env, cwd: repo });
    assert.strictEqual(ok.status, 0, `smoke verde salió ${ok.status}\n${ok.stderr}`);
    const mal = await correrAsync('bash', [SMOKE, ev, '9.10', '--acs', '5', '--mutates', '--pass-if', 'responde 200', '--', ...pedir(`${base}/api/acme/roto`)], { env, cwd: repo });
    assert.strictEqual(mal.status, 1, 'el smoke rojo devuelve el exit real del comando');
  } finally {
    servidor.close();
  }
  const ledger = fs.readFileSync(path.join(ev, '9.10-smoke-ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.strictEqual(ledger.length, 2);
  assert.deepStrictEqual(ledger.map((e) => [e.story, e.acs, e.exit, e.via, !!e.mutates]),
    [['9.10', [3, 4], 0, 'smoke-run.sh', false], ['9.10', [5], 1, 'smoke-run.sh', true]]);
  assert.ok(ledger.every((e) => typeof e.cmd === 'string' && e.cmd.includes('/api/acme/')), JSON.stringify(ledger));
  assert.ok(!ledger.some((e) => e.cmd.includes('acmeSecreto123456789')), `la credencial se escribió tal cual: ${JSON.stringify(ledger)}`);
  const espejo = fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'gates.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepStrictEqual(espejo.map((e) => [e.type, e.story, e.exit, e.repoPath]), [['smoke-run', '9.10', 0, repo], ['smoke-run', '9.10', 1, repo]]);
});

// ── T73 (a, b) ───────────────────────────────────────────────────────────────────────────────────────────────────
test('T73 TestGate_MissingRunnerSaysCouldNotRun_OwnTimeoutAndRealpath — sin el corredor dice «no pude correr las pruebas», nunca verde', () => {
  for (const [tipo, herramienta] of [['vitest', 'npx'], ['dotnet', 'dotnet']]) {
    const PATH = pathSin((n) => SIN_PYTHON(n) || n === herramienta);
    assert.ok(!tiene(PATH, herramienta), `el PATH de la prueba todavía trae ${herramienta}`);
    const repo = repoDeJuguete(tipo);
    const r = correrGate(repo, '9.11', PATH, tmpReal('tgr-home-'));
    assert.strictEqual(r.status, 5, `${tipo}: esperaba la salida 5 (no se corrió nada), salió ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, new RegExp(`no pude correr las pruebas: falta ${herramienta}`), r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, /pasaron|suite_exit=0/, 'nunca dice que pasaron');
    assert.ok(r.art, `${tipo}: no dejó artefacto`);
    assert.strictEqual(r.art.suite_green, false, 'una suite que no corrió jamás se lee como verde');
    assert.strictEqual(r.art.halted, true);
    assert.strictEqual(r.art.runner, tipo);
    assert.strictEqual(r.art.missing_tool, herramienta);
    assert.match(r.art.halt_reason, new RegExp(`no pude correr las pruebas: falta ${herramienta}`));
    assert.strictEqual(r.art.story_id, '9.11');
  }
});

// Corrido DENTRO de `node --test`, el hijo hereda NODE_TEST_CONTEXT,
// el `node --test` de la suite escribe en el formato interno de Node y el informe no cuenta ninguna prueba… y quedaría
// `suite_green: true`. Cero pruebas corridas no es verde («nunca pasaron»). Acá el Node se aparta A PROPÓSITO
// del Python, que da verde con cualquier salida 0.
function informeSuelto(runner, salidas, suiteExit) {
  const tmp = tmpReal('tgr-cero-');
  const repo = path.join(tmp, 'repo');
  const results = path.join(tmp, 'results');
  fs.mkdirSync(results, { recursive: true });
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
  for (const [nombre, contenido] of Object.entries(salidas)) fs.writeFileSync(path.join(results, nombre), contenido);
  const out = path.join(tmp, 'tests-result.json');
  const r = spawnSync(process.execPath, [REPORT, runner, repo, repo, results, out, String(suiteExit), '9.13', '75',
    '2026-10-05T12:09:00Z', '0', '', '', '', '{"git":true}', 'HEAD', '{"source":"HEAD","descartadas":[]}'],
  { encoding: 'utf8', env: { ...process.env, HOME: path.join(tmp, 'home'), TYCON_EVIDENCE_DIR: path.join(tmp, 'ev') } });
  return { rc: r.status, stderr: r.stderr, art: JSON.parse(fs.readFileSync(out, 'utf8')) };
}

test('T73 …cero pruebas corridas no es verde, aunque la suite salga 0', () => {
  const vacias = [
    ['node-test', { 'node-test.txt': '\u0000\u0001\u0002 formato interno de node --test (NODE_TEST_CONTEXT=child-v8)\n' }],
    ['node-test', { 'node-test.txt': 'ℹ tests 0\nℹ pass 0\nℹ fail 0\nℹ skipped 0\n' }],
    ['vitest', { 'vitest.json': '{"numTotalTests":0,"numPassedTests":0,"numFailedTests":0,"numPendingTests":0}' }],
    ['jest', { 'jest.json': '{"numTotalTests":3,"numPassedTests":0,"numFailedTests":0,"numPendingTests":3}' }],
    ['vitest', {}],
    ['dotnet', {}],
    ['suites-json', { 'suites.json': '{"corridas":0,"verdes":0,"fallas":[],"ausentes":[],"deferred_suites":[]}' }],
  ];
  for (const [runner, salidas] of vacias) {
    const { rc, stderr, art } = informeSuelto(runner, salidas, 0);
    const caso = `${runner} ${Object.keys(salidas).join(',') || '(sin salidas)'}`;
    assert.strictEqual(rc, 0, `${caso}: ${stderr}`);
    assert.strictEqual(art.suite_exit, 0, `${caso}: la salida real de la suite se conserva`);
    assert.strictEqual(art.suite_green, false, `${caso}: cero pruebas corridas quedó verde`);
    assert.match(art.no_tests_run || '', /ninguna prueba/, `${caso}: no dice por qué no es verde`);
    assert.match(stderr, /ninguna prueba/, `${caso}: no lo avisa`);
  }
  const conPruebas = informeSuelto('vitest', { 'vitest.json': '{"numTotalTests":2,"numPassedTests":2,"numFailedTests":0,"numPendingTests":0}' }, 0).art;
  assert.strictEqual(conPruebas.suite_green, true, 'con pruebas corridas y salida 0 sigue siendo verde');
  assert.ok(!('no_tests_run' in conPruebas), 'y no trae el aviso');
});

// ── Casos límite del informe ───────────────────────────────────────────────────────────────────────────────────

// Con FORCE_COLOR, el `node --test` de Node ≥23 pinta el resumen con secuencias ANSI
// (`\x1b[34mℹ tests 2\x1b[39m`). El informe tiene que leerlo: si no, una suite verde saldría 6 («no se pudo contar»).
test('W6-5b #3 #4 …el resumen de `node --test` con colores se lee igual que sin colores', () => {
  const color = [
    '', '> acme@1.0.0 test', '> node --test', '',
    '\x1b[32m✔ uno \x1b[90m(1.46325ms)\x1b[39m\x1b[39m',
    '\x1b[32m✔ dos \x1b[90m(0.097458ms)\x1b[39m\x1b[39m',
    '\x1b[34mℹ tests 2\x1b[39m', '\x1b[34mℹ suites 0\x1b[39m', '\x1b[34mℹ pass 2\x1b[39m', '\x1b[34mℹ fail 0\x1b[39m',
    '\x1b[34mℹ cancelled 0\x1b[39m', '\x1b[34mℹ skipped 0\x1b[39m', '\x1b[34mℹ todo 0\x1b[39m', '\x1b[34mℹ duration_ms 101.1\x1b[39m', '',
  ].join('\n');
  const sinColor = color.replace(/\x1b\[[0-9;]*m/g, '');
  const a = informeSuelto('node-test', { 'node-test.txt': color }, 0).art;
  const b = informeSuelto('node-test', { 'node-test.txt': sinColor }, 0).art;
  assert.deepStrictEqual(a.totals, { total: 2, passed: 2, failed: 0, skipped: 0, executed: 2 }, `con colores: ${JSON.stringify(a.totals)} ${a.totals_error || ''}`);
  assert.deepStrictEqual(a.totals, b.totals, 'con y sin colores, los mismos totales');
  assert.strictEqual(a.suite_green, true, `una suite verde con colores salió no verde: ${a.no_tests_run}`);
  assert.ok(!('no_tests_run' in a));
  // una suite roja con colores también se cuenta: el rojo no depende de que se lea el resumen
  const roja = informeSuelto('node-test', { 'node-test.txt': color.replace('ℹ fail 0', 'ℹ fail 1').replace('ℹ pass 2', 'ℹ pass 1') }, 1).art;
  assert.deepStrictEqual(roja.totals, { total: 2, passed: 1, failed: 1, skipped: 0, executed: 2 });
});

// Las pruebas `todo` no corren. Una suite hecha sólo de `it.todo` sale 0 sin haber probado nada, y no debe
// contarse como corrida (restar sólo las saltadas no alcanza, en jest, vitest ni `node --test`).
test('W6-5b #7 …las pruebas todo no cuentan como corridas', () => {
  const sinCorrer = [
    ['jest', { 'jest.json': '{"numTotalTests":3,"numPassedTests":0,"numFailedTests":0,"numPendingTests":0,"numTodoTests":3}' }],
    ['vitest', { 'vitest.json': '{"numTotalTests":4,"numPassedTests":0,"numFailedTests":0,"numPendingTests":2,"numTodoTests":2}' }],
    // vitest real: cuenta las todo también como pasadas
    ['vitest', { 'vitest.json': '{"numTotalTests":2,"numPassedTests":2,"numFailedTests":0,"numPendingTests":0,"numTodoTests":2}' }],
    ['node-test', { 'node-test.txt': '1..2\n# tests 2\n# suites 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 2\n' }],
  ];
  for (const [runner, salidas] of sinCorrer) {
    const { art } = informeSuelto(runner, salidas, 0);
    assert.strictEqual(art.suite_green, false, `${runner} ${JSON.stringify(salidas)}: sólo todo quedó verde`);
    assert.match(art.no_tests_run || '', /ninguna prueba/);
  }
  const conPruebas = [
    ['vitest', { 'vitest.json': '{"numTotalTests":5,"numPassedTests":3,"numFailedTests":0,"numPendingTests":0,"numTodoTests":2}' }],
    ['jest', { 'jest.json': '{"numTotalTests":4,"numPassedTests":1,"numFailedTests":0,"numPendingTests":0,"numTodoTests":3}' }],
    ['node-test', { 'node-test.txt': '# tests 3\n# pass 1\n# fail 0\n# skipped 0\n# todo 2\n' }],
  ];
  for (const [runner, salidas] of conPruebas) {
    const { art } = informeSuelto(runner, salidas, 0);
    assert.strictEqual(art.suite_green, true, `${runner}: con pruebas de verdad además de las todo, sigue verde (${art.no_tests_run})`);
  }
});

// El promedio de cobertura de los archivos nuevos no se suma con un reduce simple: el sum() de Python
// (3.12+) hace una suma compensada, y 70,1 + 92,8 + 62,1 daría 224,99999999999997: 75 de cobertura que «no llega a 75».
function informeCobertura(cubiertasPorMil) {
  const tmp = tmpReal('tgr-cov-');
  const repo = path.join(tmp, 'repo');
  const results = path.join(tmp, 'results');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'coverage'));
  fs.mkdirSync(results);
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'base']);
  const cov = {};
  cubiertasPorMil.forEach((c, i) => {
    const f = `src/f${i}.ts`;
    fs.writeFileSync(path.join(repo, f), 'export const acme = 1\n');
    cov[f] = { s: Object.fromEntries(Array.from({ length: 1000 }, (_, k) => [String(k), k < c ? 1 : 0])) };
  });
  fs.writeFileSync(path.join(repo, 'coverage', 'coverage-final.json'), JSON.stringify(cov));
  fs.writeFileSync(path.join(results, 'vitest.json'), '{"numTotalTests":1,"numPassedTests":1,"numFailedTests":0,"numPendingTests":0}');
  const out = path.join(tmp, 'tests-result.json');
  const r = spawnSync(process.execPath, [REPORT, 'vitest', repo, repo, results, out, '0', '', '75', 'ts', '0', '', '', '', ''],
    { encoding: 'utf8', env: { ...process.env, HOME: path.join(tmp, 'home') } });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(fs.readFileSync(out, 'utf8')).coverage;
}

test('W6-5b #9 …el promedio de cobertura suma como el sum() de Python', () => {
  const justo = informeCobertura([701, 928, 621]);
  assert.deepStrictEqual(Object.values(justo.per_new_file), [70.1, 92.8, 62.1]);
  assert.strictEqual(justo.new_files_pct, 75);
  assert.strictEqual(justo.meets_threshold, true, 'informa 75 y dice que no llega a 75 (Python: true)');
  const empate = informeCobertura([255, 275, 112, 816]);
  assert.strictEqual(empate.new_files_pct, 36.4, 'Python: round(sum([25.5, 27.5, 11.2, 81.6]) / 4, 1) = 36.4');
});

// En Windows `command -v npx` encuentra el guion `npx` de Git Bash, pero run-check no lo puede lanzar.
// Acá se emula con un `npx` que el shell ve y que no se puede ejecutar: «no pude correr» tiene que ser la salida 5,
// no un rojo de pruebas con totales vacíos.
test('W6-5b #8 …un corredor que el shell ve pero que no se puede lanzar es la salida 5, no un rojo', () => {
  const bin = tmpReal('tgr-npx-muerto-');
  fs.writeFileSync(path.join(bin, 'npx'), '#!/bin/sh\necho npx de mentira\n', { mode: 0o644 });
  const PATH = bin + path.delimiter + pathSin((n) => SIN_PYTHON(n) || n === 'npx');
  assert.ok(tiene(PATH, 'npx'), 'el shell tiene que ver el npx (como Git Bash ve el guion de Windows)');
  const repo = repoDeJuguete('vitest');
  const r = correrGate(repo, '9.15', PATH, tmpReal('tgr-home-'));
  assert.strictEqual(r.status, 5, `esperaba la salida 5, salió ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /no pude correr las pruebas: falta npx/);
  assert.strictEqual(r.art.missing_tool, 'npx');
  assert.strictEqual(r.art.halted, true);
});

// La salida 5 escribe el artefacto y también toca el marcador: un verde viejo de `tests` no puede quedar en
// pie ni ser aceptado por `complete-step 4`. Como en la salida 6, el check queda en rojo.
test('W6-5b #10 …la salida 5 deja el check tests del marcador en rojo, no un verde viejo', () => {
  const MARKER = path.join(SCRIPTS, 'marker.js');
  const home = tmpReal('tgr-home-');
  const env = { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: 'tgr-exit5', TYCON_SESSION_ID: 'tgr-exit5' };
  delete env.TYCON_TEST_SCOPE; delete env.TYCON_EVIDENCE_DIR;
  const marker = (args, extra = {}) => spawnSync(process.execPath, [MARKER, ...args], { encoding: 'utf8', env: { ...env, ...extra } });
  const repo = repoDeJuguete('vitest');
  assert.strictEqual(marker(['set', '{"storyId":"9.16","stepsPending":[4,5,6,7,8]}']).status, 0);
  marker(['run-check', 'tests', '--', process.execPath, '-e', 'process.exit(0)'], { TYCON_TEST_GATE: '1' });
  const antes = JSON.parse(marker(['get']).stdout);
  assert.strictEqual(antes.checks.tests, 'green', 'el verde previo de test-gate');
  const PATH = pathSin((n) => SIN_PYTHON(n) || n === 'npx');
  const r = spawnSync('bash', [GATE, repo, '9.16'], { encoding: 'utf8', env: { ...env, PATH, TYCON_COVERAGE_BASE: '' }, timeout: 180000 });
  assert.strictEqual(r.status, 5, r.stderr);
  const despues = JSON.parse(marker(['get']).stdout);
  assert.notStrictEqual(despues.checks.tests, 'green', 'el verde viejo quedó en pie tras «no pude correr»');
  // rojo con el código de la salida: lo leen el Stop-gate y la precondición del paso 8, que piden `tests` verde
  assert.strictEqual(despues.checks.tests, 'red:exit=5');
  assert.strictEqual(despues.checksProvenance.tests, 'test-gate');
});

// La tabla «Salidas del gate» del paso 4 —la que sigue el orquestador— necesita el 5 y el 6: sin ellos, un 5
// (no corrió nada) cae en «suite roja: corregir y re-correr». Cada salida propia de test-gate.sh tiene su fila.
test('W6-5b #11 …la tabla «Salidas del gate» del paso «Correr las pruebas» (step-06-run-tests.md) tiene una fila por cada salida de test-gate.sh', () => {
  const gate = fs.readFileSync(GATE, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const codigos = new Set([...gate.matchAll(/\bexit (\d+)\b|SUITE_EXIT=(\d+)\b|"\$SUITE_EXIT" == "(\d+)"/g)].map((m) => m[1] || m[2] || m[3]).filter((c) => c !== '0'));
  for (const c of ['3', '4', '5', '6', '7']) assert.ok(codigos.has(c), `test-gate.sh ya no sale ${c}: revisar esta prueba`);
  const paso = fs.readFileSync(path.join(SCRIPTS, '..', 'steps', 'step-06-run-tests.md'), 'utf8');
  const tabla = paso.split('### Salidas del gate')[1];
  assert.ok(tabla, 'el paso «Correr las pruebas» perdió la sección «Salidas del gate»');
  const filas = tabla.split('\n\n').find((b) => b.trim().startsWith('|')) || '';
  for (const c of [...codigos].filter((x) => x !== '2' && x !== '1')) {
    assert.match(filas, new RegExp(`^\\|\\s*\`${c}\`\\s*\\|`, 'm'), `la tabla del paso 4 no tiene la salida ${c}`);
  }
  assert.match(filas, /^\|\s*`5`\s*\|[^\n]*no (se corrió|corrió)[^\n]*\|/im, 'la fila del 5 dice que no se corrió nada');
});

test('T73 …test-gate.sh lanzado desde `node --test`: la suite corre como en una terminal, y con cero pruebas no da verde', () => {
  const repoNode = (conPrueba) => {
    const repo = path.join(tmpReal('tgr-nodetest-'), 'acme');
    fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
    execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"acme","version":"1.0.0","scripts":{"test":"node --test"}}\n');
    if (conPrueba) fs.writeFileSync(path.join(repo, 'tests', 'acme.test.js'), "require('node:test')('acme suma', () => {});\n");
    git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'base', '--allow-empty']);
    return repo;
  };
  const conContexto = { ...process.env, NODE_TEST_CONTEXT: 'child-v8' };
  const correr = (repo) => {
    const env = { ...conContexto, HOME: tmpReal('tgr-home-'), CLAUDE_CODE_SESSION_ID: SESION, TYCON_COVERAGE_BASE: '' };
    delete env.TYCON_TEST_SCOPE; delete env.TYCON_EVIDENCE_DIR;
    const r = spawnSync('bash', [GATE, repo, '9.14'], { encoding: 'utf8', env, timeout: 180000 });
    return { ...r, art: JSON.parse(fs.readFileSync(path.join(repo, '.advisors', 'tests-result.json'), 'utf8')) };
  };
  const una = correr(repoNode(true));
  assert.strictEqual(una.status, 0, una.stderr);
  assert.strictEqual(una.art.totals.total, 1, `con NODE_TEST_CONTEXT heredado no contó la prueba: ${JSON.stringify(una.art.totals)} ${una.art.totals_error || ''}`);
  assert.strictEqual(una.art.suite_green, true);
  const ninguna = correr(repoNode(false));
  assert.notStrictEqual(ninguna.status, 0, `cero pruebas y test-gate.sh salió 0\n${ninguna.stderr}`);
  assert.strictEqual(ninguna.art.suite_green, false);
  assert.match(ninguna.stderr, /ninguna prueba/);
});

test('T73 …sin `timeout` ni `realpath` (un Git Bash pelado), test-gate.sh da el mismo resultado', () => {
  const codigo = fs.readFileSync(GATE, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(codigo, /(^|[\s;|&(`$])(g?timeout|g?realpath)\s/m, 'test-gate.sh llama a timeout o realpath: en Git Bash pueden faltar');
  const pelado = pathSin((n) => SIN_PYTHON(n) || /^g?(timeout|realpath)$/.test(n));
  assert.ok(!tiene(pelado, 'timeout') && !tiene(pelado, 'realpath'), 'el PATH pelado todavía trae timeout o realpath');
  const completo = process.env.PATH;
  const juguete = binDeJuguete();
  for (const tipo of ['suites-json', 'vitest']) {
    const repo = repoDeJuguete(tipo);
    const con = (p) => (tipo === 'vitest' ? juguete + path.delimiter + p : p);
    const a = correrGate(repo, '9.12', con(completo), tmpReal('tgr-home-'));
    fs.rmSync(path.join(repo, '.advisors'), { recursive: true, force: true });
    if (tipo === 'vitest') fs.rmSync(path.join(repo, 'coverage'), { recursive: true, force: true });
    const b = correrGate(repo, '9.12', con(pelado), tmpReal('tgr-home-'));
    assert.strictEqual(a.status, 0, `${tipo} con todo: ${a.stderr}`);
    assert.strictEqual(b.status, a.status, `${tipo}: sin timeout ni realpath salió ${b.status}\n${b.stderr}`);
    assert.deepStrictEqual(comparable(b.art), comparable(a.art), `${tipo}: el artefacto cambia sin timeout ni realpath`);
  }
});

// ── El corredor de suites.json con cobertura, y de dónde sale el umbral ──────────────────────────────────────────
test('T9 7.31-SuitesJson_ConReporte_DaPorcentaje @story-7.31 @ac-8 @ac-14 — con el lcov del corredor, las líneas tocadas salen con número', () => {
  // 🔴 rojo: el «sin cruce» fijo para suites-json, o el registro de fuera del árbol contado como el archivo nuevo.
  const caso = armarCaso('suites-json-coverage');
  const { rc, stderr, got } = correrInforme(caso, [process.execPath, REPORT], { TYCON_GUIDES_DIR: tmpReal('tgr-sin-org-') });
  assert.strictEqual(rc, 0, stderr);
  const cov = got.tests_result.coverage;
  assert.strictEqual(cov.touched_lines_pct, 50, JSON.stringify(cov, null, 1));
  assert.deepStrictEqual(cov.touched_lines.per_file, { 'scripts/lib/acme.js': { covered: 1, measurable: 2, pct: 50 } });
  assert.deepStrictEqual(cov.touched_files_without_coverage_data, ['scripts/lib/nuevo.js'], 'el archivo nuevo, sin datos (el de fuera del árbol no cuenta)');
  assert.strictEqual(cov.touched_no_cross_check, undefined);
  assert.strictEqual(cov.no_cross_check, 'sin cruce de cobertura: hay archivos nuevos pero ninguno aparece en el reporte de cobertura');
  assert.deepStrictEqual(cov.per_new_file, { 'scripts/lib/nuevo.js': null });
  assert.strictEqual(cov.threshold_basis, 'touched_lines');
  assert.strictEqual(cov.meets_threshold, false);
  assert.strictEqual(cov.threshold, 75);
  assert.strictEqual(cov.threshold_source, 'maquina');
  assert.deepStrictEqual(got.sellada.coverage.touched_lines_pct, 50, 'la copia que viaja lleva el número');
  // las suites que no dejaron datos llegan al artefacto: un número parcial no se lee como cobertura real baja
  // (relativas al repo: el artefacto viaja en la copia sellada, que no lleva rutas de la máquina)
  assert.deepStrictEqual(cov.suites_without_coverage, { without_data: ['scripts/tests/acme-sin-node.test.sh'], unreadable: [] });
  assert.strictEqual(cov.lcov_sources_unreadable, undefined, 'con las fuentes legibles, el campo no aparece');

  // y de punta a punta: test-gate.sh le pide la cobertura al corredor y el artefacto trae el número
  const repo = repoDeJuguete('suites-json');
  fs.mkdirSync(path.join(repo, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'scripts', 'lib', 'acme.js'), 'module.exports = (n) => {\n  if (n > 0) return 1;\n  return 0;\n};\n');
  fs.writeFileSync(path.join(repo, 'scripts', 'tests', 'acme.test.js'),
    "const { spawnSync } = require('child_process');\nconst r = spawnSync(process.execPath, ['-e', 'require(process.argv[1])(1)', require('path').join(__dirname, '..', 'lib', 'acme.js')]);\nprocess.exit(r.status);\n");
  fs.writeFileSync(path.join(repo, 'scripts', 'tests', 'suites.json'),
    JSON.stringify({ diarias: [{ raiz: 'arnes', ruta: 'tests/ok.test.sh' }, { raiz: 'arnes', ruta: 'tests/acme.test.js' }], semanales: [] }));
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'acme']);
  fs.writeFileSync(path.join(repo, 'scripts', 'lib', 'acme.js'), 'module.exports = (n) => {\n  if (n > 0) return 2;\n  return -1;\n};\n');
  const home = tmpReal('tgr-home-');
  const g = correrGate(repo, '7.31', process.env.PATH, home);
  assert.strictEqual(g.status, 0, g.stderr + g.stdout);
  assert.strictEqual(g.art.coverage.touched_lines_pct, 50, JSON.stringify(g.art.coverage, null, 1));
  assert.deepStrictEqual(g.art.coverage.touched_lines.per_file, { 'scripts/lib/acme.js': { covered: 1, measurable: 2, pct: 50 } });
});

// Un repo con su historia, las salidas del corredor de suites.json (con su lcov) y el informe corrido encima.
function informeSuitesJson({ base, now, lcov, resumen = '{"corridas":1,"verdes":1,"fallas":[],"ausentes":[],"deferred_suites":[]}' }) {
  const tmp = tmpReal('tgr-sj-');
  const repo = path.join(tmp, 'repo');
  const results = path.join(tmp, 'results');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
  escribir(repo, { 'scripts/tests/suites.json': { text: '{"diarias":[],"semanales":[]}\n' }, ...base });
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'base']);
  escribir(repo, now);
  fs.mkdirSync(path.join(results, 'coverage'), { recursive: true });
  fs.writeFileSync(path.join(results, 'suites.json'), typeof resumen === 'function' ? resumen(repo) : resumen);
  fs.writeFileSync(path.join(results, 'coverage', 'lcov.info'), lcov(repo));
  const out = path.join(tmp, 'out.json');
  const r = spawnSync(process.execPath, [REPORT, 'suites-json', repo, repo, results, out, '0', '7.31', '75', '2026-10-17T12:00:00Z',
    '0', '', 'explicito', '', '{"git":true}', 'HEAD', '{"ref":"HEAD","source":"HEAD","descartadas":[]}'],
  { encoding: 'utf8', env: { ...process.env, HOME: tmp, USERPROFILE: tmp, TYCON_GUIDES_DIR: tmp, TYCON_EVIDENCE_DIR: path.join(tmp, 'ev') } });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(fs.readFileSync(out, 'utf8')).coverage;
}
const da = (sf, lineas) => ['TN:', `SF:${sf}`, ...Object.entries(lineas).map(([l, v]) => `DA:${l},${v}`), 'end_of_record', ''].join('\n');

test('T9 …lo de las carpetas de pruebas no cuenta como código tocado @story-7.31 @ac-8', () => {
  // 🔴 rojo: un ayudante de scripts/tests/lib/ cubierto, o una suite test-*.js, entran al porcentaje de las líneas tocadas.
  const cov = informeSuitesJson({
    base: { 'scripts/lib/a.js': { lines: 3 }, 'scripts/tests/lib/helper.js': { lines: 3 }, 'scripts/tests/test-plain.js': { lines: 2 } },
    now: { 'scripts/lib/a.js': { lines: 3, changed: [1, 2, 3] }, 'scripts/tests/lib/helper.js': { lines: 3, changed: [1, 2, 3] }, 'scripts/tests/test-plain.js': { lines: 2, changed: [1] } },
    lcov: () => da('scripts/lib/a.js', { 1: 1, 2: 0, 3: 0 }) + da('scripts/tests/lib/helper.js', { 1: 1, 2: 1, 3: 1 }),
  });
  assert.deepStrictEqual(Object.keys(cov.touched_lines.per_file), ['scripts/lib/a.js']);
  assert.strictEqual(cov.touched_lines_pct, 33.3);
  assert.deepStrictEqual(cov.touched_files_without_coverage_data, [], 'la suite test-plain.js no es código sin datos');
});

test('T9 …un archivo nuevo no toma el número de un homónimo de otra carpeta @story-7.31 @ac-8', () => {
  // 🔴 rojo: el cruce de archivos nuevos por «termina en» le da a scripts/lib/h.js el 100 % de skills/p/scripts/lib/h.js.
  const cov = informeSuitesJson({
    base: { 'skills/p/scripts/lib/h.js': { lines: 2 } },
    now: { 'scripts/lib/h.js': { lines: 2 } },
    lcov: () => da('skills/p/scripts/lib/h.js', { 1: 1, 2: 1 }),
  });
  assert.deepStrictEqual(cov.per_new_file, { 'scripts/lib/h.js': null });
  assert.strictEqual(cov.new_files_pct, null);
  assert.deepStrictEqual(cov.touched_files_without_coverage_data, ['scripts/lib/h.js']);
});

test('T9 …lo que el número no cubre llega al artefacto, con rutas del repo @story-7.31 @ac-5 @ac-7', () => {
  // 🔴 rojo: las suites ilegibles o una fuente que no se pudo leer quedan sólo en la salida del corredor, y el número
  // parcial se lee como cobertura real baja.
  const cov = informeSuitesJson({
    base: { 'scripts/lib/a.js': { lines: 2 } },
    now: { 'scripts/lib/a.js': { lines: 2, changed: [1] } },
    lcov: () => da('scripts/lib/a.js', { 1: 1, 2: 0 }) + da('scripts/lib/borrado.js', { 1: 1 }),
    resumen: (repo) => JSON.stringify({ corridas: 2, verdes: 2, fallas: [], ausentes: [], deferred_suites: [], coverage: {
      without_data: [path.join(repo, 'scripts', 'tests', 'sin-node.test.sh')],
      unreadable: [{ ruta: path.join(repo, 'scripts', 'tests', 'rota.test.js'), motivo: 'cortado: 1 registro(s) abierto(s) y 0 cerrado(s)' }, { ruta: '', motivo: 'x' }],
    } }),
  });
  assert.deepStrictEqual(cov.suites_without_coverage, {
    without_data: ['scripts/tests/sin-node.test.sh'],
    unreadable: [{ ruta: 'scripts/tests/rota.test.js', motivo: 'cortado: 1 registro(s) abierto(s) y 0 cerrado(s)' }, { ruta: null, motivo: 'x' }],
  });
  assert.deepStrictEqual(cov.lcov_sources_unreadable, ['scripts/lib/borrado.js'], 'una fuente que no está: se nombra');
  // un resumen sin `coverage` (un corredor sin la cobertura pedida) no inventa el campo
  const sin = informeSuitesJson({ base: { 'scripts/lib/a.js': { lines: 1 } }, now: {}, lcov: () => da('scripts/lib/a.js', { 1: 1 }) });
  assert.strictEqual(sin.suites_without_coverage, undefined);
});

test('T9 …un archivo con un espacio en el nombre también cuenta como tocado @story-7.31 @ac-8', () => {
  // 🔴 rojo: git agrega un TAB al final de «+++ b/<ruta>» cuando la ruta tiene un espacio, y el archivo se pierde.
  const cov = informeSuitesJson({
    base: { 'scripts/lib/acme x.js': { lines: 2 } },
    now: { 'scripts/lib/acme x.js': { lines: 2, changed: [1, 2] } },
    lcov: () => da('scripts/lib/acme x.js', { 1: 1, 2: 0 }),
  });
  assert.deepStrictEqual(cov.touched_lines.per_file, { 'scripts/lib/acme x.js': { covered: 1, measurable: 2, pct: 50 } });
});

test('T10 7.31-Umbral_MaquinaOrganizacionDefecto @story-7.31 @ac-9 — el umbral sale de la máquina, de la organización o del valor por defecto, y lo dice', () => {
  // 🔴 rojo: la variable inválida usada igual (NaN), o la organización ignorada.
  // un árbol del arnés de juguete: el lugar se reconoce por su instalador (lib/harness-path.js, esClon)
  const arbolDelArnes = () => {
    const d = tmpReal('tgr-org-');
    fs.mkdirSync(path.join(d, 'scripts'));
    fs.writeFileSync(path.join(d, 'scripts', 'install-tycon-hooks.sh'), '#!/bin/bash\n');
    return d;
  };
  const conOrg = (pct) => {
    const d = arbolDelArnes();
    const team = {
      version: 1,
      public: { platform: 'github', org: 'acme', repo: 'harness' },
      profile: { platform: 'azure', org: 'acme', project: 'Main', repo: 'team-profile' },
      operations: { platform: 'azure', org: 'acme', project: 'Main', repo: 'team-operations' },
      ...(pct === undefined ? {} : { coverage: { min_touched_lines_pct: pct } }),
    };
    fs.writeFileSync(path.join(d, 'team-repos.json'), JSON.stringify(team));
    return d;
  };
  const casos = [
    ['60', conOrg(80), 60, 'maquina', null],
    ['abc', conOrg(80), 80, 'organizacion', /TYCON_COVERAGE_MIN/],
    ['0', conOrg(80), 80, 'organizacion', /TYCON_COVERAGE_MIN/],
    ['', conOrg(80), 80, 'organizacion', null],
    ['', conOrg(101), 75, 'por_defecto', /coverage\.min_touched_lines_pct/],
    ['', conOrg(undefined), 75, 'por_defecto', null],
    ['', arbolDelArnes(), 75, 'por_defecto', null],
    // el archivo de la organización roto, o que no se puede leer: el valor por defecto, y el motivo dicho
    ['', (() => { const d = arbolDelArnes(); fs.writeFileSync(path.join(d, 'team-repos.json'), '{roto'); return d; })(), 75, 'por_defecto', /team-repos\.json: no se pudo usar/],
    ['', (() => { const d = arbolDelArnes(); fs.mkdirSync(path.join(d, 'team-repos.json')); return d; })(), 75, 'por_defecto', /no pude leer el umbral de la organización/],
  ];
  for (const [maquina, arbol, umbral, origen, problema] of casos) {
    const caso = armarCaso('suites-json-coverage');
    caso.args[7] = maquina;
    const { rc, stderr, got } = correrInforme(caso, [process.execPath, REPORT], { TYCON_GUIDES_DIR: arbol });
    assert.strictEqual(rc, 0, stderr);
    const cov = got.tests_result.coverage;
    const que = `máquina «${maquina}», ${path.basename(arbol)}`;
    assert.strictEqual(cov.threshold, umbral, que);
    assert.strictEqual(cov.threshold_source, origen, que);
    assert.strictEqual(cov.meets_threshold, 50 >= umbral, que);
    if (problema) assert.ok((cov.threshold_problems || []).some((p) => problema.test(p)), `${que}: ${JSON.stringify(cov.threshold_problems)}`);
    else assert.strictEqual(cov.threshold_problems, undefined, que);
  }
});

// ── El portón de pruebas ────────────────────────────────────────────────────────────────────────────────────────────────
test('T1 8.55-ClaveHeredada_NoCambiaElResultado @story-8.55 @ac-1 — la clave de la evidencia que exporta un test-gate.sh de afuera no cambia el resultado', () => {
  // 🔴 rojo: test-gate.sh exporta TYCON_EVIDENCE_KEY (o _FAILED) cuando recibe la ruta de una story, y esta suite corre
  //    dentro de él: el informe nombraba la copia sellada con la clave de afuera y dos casos de esta suite salían rojos.
  for (const [k, v] of [['TYCON_EVIDENCE_KEY', '8.55'], ['TYCON_EVIDENCE_KEY_FAILED', 'no encontré la story']]) {
    const env = { ...process.env, [k]: v };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--test', '--test-name-pattern', '^T69 TestGate_NodeReport|^T9 7\\.31-SuitesJson_ConReporte', __filename],
      { encoding: 'utf8', env, timeout: 300000 });
    assert.strictEqual(r.status, 0, `con ${k} puesta la suite cambia:\n${(r.stdout + r.stderr).slice(-3000)}`);
    assert.match(r.stdout, /ℹ pass 2\b/, `esperaba las dos pruebas corridas con ${k}:\n${r.stdout.slice(-1500)}`);
  }
});

test('T6 8.55-Informe_Salida7_SinAcotar @story-8.55 @ac-6 — la salida 7 es «sin acotar»: no es verde y el merge exige la CI completa', () => {
  // 🔴 rojo: el informe leía la salida 7 como una suite roja más, sin decir que no se corrió nada ni por qué.
  const tmp = tmpReal('tgr-sinacotar-');
  const repo = path.join(tmp, 'repo');
  const results = path.join(tmp, 'results');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
  escribir(repo, { 'scripts/tests/suites.json': { text: '{"diarias":[],"semanales":[]}\n' } });
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'base']);
  fs.mkdirSync(results, { recursive: true });
  const motivo = 'no sé qué archivos tocó la story en este repo: la base cayó a HEAD';
  fs.writeFileSync(path.join(results, 'suites.json'), JSON.stringify({ corridas: 0, verdes: 0, fallas: [], ausentes: [], deferred_suites: [], unscoped: { reason: motivo } }));
  const out = path.join(tmp, 'out.json');
  const r = spawnSync(process.execPath, [REPORT, 'suites-json', repo, repo, results, out, '7', '8.55', '75', '2026-10-18T12:00:00Z',
    '0', '', 'explicito', '', '{"git":true}', '', '{"ref":null,"source":null,"descartadas":[]}'],
  { encoding: 'utf8', env: { ...process.env, HOME: tmp, USERPROFILE: tmp, TYCON_GUIDES_DIR: tmp, TYCON_EVIDENCE_DIR: path.join(tmp, 'ev') } });
  assert.strictEqual(r.status, 0, r.stderr);
  const art = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(art.suite_exit, 7);
  assert.strictEqual(art.suite_green, false, 'sin acotar nunca es verde');
  assert.strictEqual(art.unscoped, true);
  assert.strictEqual(art.unscoped_reason, motivo);
  assert.strictEqual(art.merge_requires_ci, true);
  // y el revisor de cobertura lo nombra como no verde
  const regla = fs.readFileSync(path.join(SCRIPTS, '..', '..', '..', 'agents', 'tycon-plugin-tests-coverage.md'), 'utf8')
    .split('\n').find((l) => l.startsWith('| **TEST-C1** |')) || '';
  assert.match(regla, /unscoped/, `la regla TEST-C1 no nombra «sin acotar»: ${regla}`);
});
