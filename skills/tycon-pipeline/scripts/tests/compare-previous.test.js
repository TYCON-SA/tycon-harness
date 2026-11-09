#!/usr/bin/env node
'use strict';
// compare-previous.test.js — el humo comparado (historia 8.167): un comando que el cambio toca se corre con `main` y con
// el cambio, aislados y sin red, y se comparan su código de salida y su salida normalizada.
//
//   T1-T4   el informe: las dos corridas, igual, distinto con el detalle, nuevo
//   T5-T7   aislado de la casa y del repo, sin red, main al día
//   T8-T9   la normalización: lo declarado da igual, lo demás no se esconde
//   T10-T11 topes y limpieza
//   T19-T23 la red por capas, lo que se niega a comparar, el encierro
//   T29-T30, T32-T33  el par de clones por corrida, el tope total, lo que corta el encierro, `{raiz}`
//   P7-P11  lo que encontró el pase adversarial de la 8.243: el orden de la salida y la de error, la carpeta de estado
//           con un enlace, los segundos de un renglón que no es de resumen, el archivo que corre con `node -r`, el
//           nombre de sesión «..» y el informe que no se lee
//
// Correr: node --test skills/tycon-pipeline/scripts/tests/compare-previous.test.js < /dev/null

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync, spawn } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const CP = path.join(SCRIPTS, 'lib', 'compare-previous.js');
const SMOKE = path.join(SCRIPTS, 'smoke-run.sh');
const cp = () => require(CP);

const tmpDirs = [];
function tmp(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}
after(() => { for (const d of tmpDirs) { try { execFileSync('chmod', ['-R', 'u+w', d]); } catch { /* ya no está */ } fs.rmSync(d, { recursive: true, force: true }); } });

const FECHA = '2026-01-01T10:00:00';
// El repo «real»: con su origin (un repo desnudo), la herramienta en main y el cambio sin commitear.
function laboratorio({ herramienta = 'console.log("hola");\n', cambio = null, sid = 's-cp' } = {}) {
  const base = tmp('cp-lab-');
  const origen = path.join(base, 'origen.git');
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const g = (cwd, ...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA, HOME: home },
  }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origen]);
  fs.mkdirSync(repo);
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 't@t');
  g(repo, 'config', 'user.name', 't');
  g(repo, 'remote', 'add', 'origin', origen);
  fs.mkdirSync(path.join(repo, 'specs'));
  fs.writeFileSync(path.join(repo, 'specs', 'story-9.7-cmp.md'), ['---', 'story: "9.7"', 'title: "cmp"', 'status: in-progress', '---', ''].join('\n'));
  fs.writeFileSync(path.join(repo, 'tool.js'), herramienta);
  // la carpeta de la corrida (donde va el informe) no viaja, como en un repo con el .gitignore canónico
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignorado.txt\n.advisors/\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-qm', 'inicio');
  g(repo, 'push', '-q', 'origin', 'main');
  g(repo, 'checkout', '-q', '-b', 'story/9.7');
  if (cambio !== null) fs.writeFileSync(path.join(repo, 'tool.js'), cambio);
  const state = path.join(home, '.claude', '.tycon-pipeline');
  const runDir = path.join(repo, '.advisors', 'pipeline-runs', '9.7-1');
  fs.mkdirSync(path.join(state, 'active'), { recursive: true });
  fs.writeFileSync(path.join(state, 'active', `${sid}.json`), JSON.stringify({ storyId: '9.7', storyPath: path.join(repo, 'specs', 'story-9.7-cmp.md'), repoPath: repo, runDir, sessionId: sid }));
  const env = (extra = {}) => {
    const e = { ...process.env, HOME: home, USERPROFILE: home, TYCON_HOME: '', CLAUDE_CODE_SESSION_ID: sid, ...extra };
    delete e.NODE_TEST_CONTEXT;
    return e;
  };
  const comparar = (argv, extra = {}, { covers = [], sidPropio = sid } = {}) => {
    const r = spawnSync(process.execPath, [CP, 'humo', '--run-dir', runDir, '--state-dir', state, '--sid', sidPropio,
      ...(covers.length ? ['--covers', covers.join(',')] : []), '--', ...argv], { cwd: repo, encoding: 'utf8', env: env(extra) });
    const informe = cp().leerInforme(runDir);
    return { r, e: informe[informe.length - 1], informe };
  };
  return { base, origen, repo, home, state, runDir, sid, g: (...a) => g(repo, ...a), env, comparar };
}
const node = (...a) => [process.execPath, ...a];

test('T1 Compare_CorreConMainYConElCambio @story-8.167 @ac-1 — smoke-run.sh --compare deja el informe con las dos corridas', () => {
  const L = laboratorio({ cambio: 'console.log("chau");\n' });
  const r = spawnSync('bash', [SMOKE, path.join(L.repo, '.advisors', 'dod-runtime'), path.join(L.repo, 'specs', 'story-9.7-cmp.md'), '--compare', '--', process.execPath, 'tool.js'],
    { cwd: L.repo, encoding: 'utf8', env: L.env() });
  assert.strictEqual(r.status, 0, r.stderr);
  const informe = cp().leerInforme(L.runDir);
  assert.strictEqual(informe.length, 1, r.stderr);
  assert.ok(informe[0].main && informe[0].cambio, JSON.stringify(informe[0]));
});

test('T2 Compare_Igual @story-8.167 @ac-2 — mismo código y misma salida: igual', () => {
  const L = laboratorio({ cambio: 'console.log("hola");\n// un comentario\n' });
  const { e } = L.comparar(node('tool.js'));
  assert.strictEqual(e.resultado, 'igual', JSON.stringify(e));
  // con la cobertura del portón puesta: no entra a las corridas (su aviso lleva el número de proceso y daría distinto)
  const conCobertura = L.comparar(node('tool.js'), { NODE_V8_COVERAGE: tmp('cp-cov-') });
  assert.strictEqual(conCobertura.e.resultado, 'igual', JSON.stringify(conCobertura.e));
});

test('T3 Compare_Distinto_TraeElDetalle @story-8.167 @ac-3 — salida 0 contra 1 y una línea distinta', () => {
  const L = laboratorio({ cambio: 'console.log("chau"); process.exitCode = 1;\n' });
  const { e } = L.comparar(node('tool.js'));
  assert.strictEqual(e.resultado, 'distinto');
  assert.deepStrictEqual([e.main.exit, e.cambio.exit], [0, 1]);
  assert.deepStrictEqual(e.diff[0], { linea: 1, main: 'hola', cambio: 'chau' });
});

test('T4 Compare_ComandoNuevo_NoSeCompara @story-8.167 @ac-4 — el guion no está en main', () => {
  const L = laboratorio();
  fs.writeFileSync(path.join(L.repo, 'nuevo.js'), 'console.log(1);\n');
  const { e } = L.comparar(node('nuevo.js'));
  assert.strictEqual(e.resultado, 'nuevo');
  assert.match(e.motivo, /nuevo, no se compara/);
});

test('T5 Compare_Aislado_NoTocaLoReal @story-8.167 @ac-5 — la casa, el árbol, las refs, el stash y la configuración del repo real quedan igual', () => {
  const ensucia = [
    'const fs = require("fs"); const os = require("os"); const path = require("path"); const { execSync } = require("child_process");',
    'console.log("ve-sin-commitear:", fs.existsSync("sin-commitear.txt"));',
    'fs.mkdirSync(path.join(os.homedir(), ".claude"), { recursive: true }); fs.writeFileSync(path.join(os.homedir(), ".claude", "x"), "x");',
    'fs.writeFileSync("arbol.txt", "y"); fs.appendFileSync("sin-commitear.txt", "z");',
    'for (const c of ["git branch -f otra HEAD", "git tag t1", "git update-ref refs/x HEAD", "git -c user.email=a@a -c user.name=a stash -u", "git config user.foo bar"]) { try { execSync(c, { stdio: "ignore" }); } catch (_) {} }',
  ].join('\n');
  const L = laboratorio({ herramienta: ensucia, cambio: `${ensucia}\n` });
  fs.writeFileSync(path.join(L.repo, 'sin-commitear.txt'), 'original\n');
  const foto = () => ({
    refs: L.g('for-each-ref', '--format=%(refname) %(objectname)'), stash: L.g('stash', 'list'), config: fs.readFileSync(path.join(L.repo, '.git', 'config'), 'utf8'),
    status: L.g('status', '--porcelain'), sinCommitear: fs.readFileSync(path.join(L.repo, 'sin-commitear.txt'), 'utf8'),
    casa: fs.readdirSync(L.home).sort().join(','), claude: fs.readdirSync(path.join(L.home, '.claude')).sort().join(','), worktrees: L.g('worktree', 'list'),
  });
  const antes = foto();
  const { e } = L.comparar(node('tool.js'));
  assert.deepStrictEqual(foto(), antes);
  assert.ok(!fs.existsSync(path.join(L.repo, 'arbol.txt')));
  // main no ve el archivo sin commitear; el cambio sí
  assert.strictEqual(e.resultado, 'distinto', JSON.stringify(e));
  assert.ok(e.diff.some((d) => /ve-sin-commitear: false/.test(d.main) && /ve-sin-commitear: true/.test(d.cambio)), JSON.stringify(e.diff));
});

test('T6 Compare_SinRed @story-8.167 @ac-6 — git push y curl dan «usa la red»', () => {
  const L = laboratorio();
  const antes = execFileSync('git', ['-C', L.origen, 'for-each-ref']).toString();
  for (const cmd of ['git push origin HEAD:main', 'curl -s http://example.com']) {
    const { e } = L.comparar(['bash', '-c', cmd]);
    assert.strictEqual(e.resultado, 'no-comparado', JSON.stringify(e));
    assert.match(e.motivo, /usa la red/);
  }
  assert.strictEqual(execFileSync('git', ['-C', L.origen, 'for-each-ref']).toString(), antes, 'el origen no recibió nada');
});

test('T7 Compare_FetchFalla_NoCompara @story-8.167 @ac-7 — sin el fetch de main, no se compara', () => {
  const L = laboratorio();
  L.g('remote', 'set-url', 'origin', path.join(L.base, 'no-existe.git'));
  const { e } = L.comparar(node('tool.js'));
  assert.strictEqual(e.resultado, 'no-comparado');
  assert.match(e.motivo, /sin main al día/);
});

test('T8 Compare_Normaliza_LoDeclarado @story-8.167 @ac-8 — horas ISO, duraciones del arnés, raíces, casas, HEAD, rama y pid', () => {
  const h1 = 'a'.repeat(40);
  const h2 = 'b'.repeat(40);
  const ctx = { raices: ['/c/main', '/c/cambio'], casas: ['/c/casa-main', '/c/casa-cambio'], heads: [h1, h2], ramas: ['compare-main', 'story/9.7'] };
  const a = ['2026-01-01T10:00:00.123Z ok (12ms)', 'duration_ms 33', 'ℹ tests 4 2.5s', '/c/main/x · /c/casa-main/.claude', `${h1.slice(0, 7)} compare-main`, 'pid 123'].join('\n');
  const b = ['2026-11-08T22:01:59Z ok (9.5ms)', 'duration_ms 41.2', 'ℹ tests 4 3s', '/c/cambio/x · /c/casa-cambio/.claude', `${h2.slice(0, 12)} story/9.7`, 'pid 98765'].join('\n');
  assert.strictEqual(cp().normalizar(a, ctx), cp().normalizar(b, ctx));
  assert.strictEqual(cp().comparar({ exit: 0, salida: cp().normalizar(a, ctx) }, { exit: 0, salida: cp().normalizar(b, ctx) }).igual, true);
});

test('T9 Compare_Normaliza_NoEscondeLoReal @story-8.167 @ac-8 — una palabra, una fecha suelta o una duración en otro formato no se esconden', () => {
  const n = (t) => cp().normalizar(t, {});
  assert.notStrictEqual(n('el total es uno'), n('el total es dos'));
  assert.notStrictEqual(n('vence el 2026-01-01'), n('vence el 2026-02-01'));
  assert.notStrictEqual(n('tardó 1m30'), n('tardó 2m10'));
});

test('T10 Compare_Topes_PorVariable @story-8.167 @ac-9 — TYCON_COMPARE_MAX y TYCON_COMPARE_TIMEOUT_MS', () => {
  const L = laboratorio();
  assert.strictEqual(L.comparar(node('tool.js'), { TYCON_COMPARE_MAX: '1' }).e.resultado, 'igual');
  const segundo = L.comparar(node('tool.js'), { TYCON_COMPARE_MAX: '1' }).e;
  assert.strictEqual(segundo.resultado, 'no-comparado');
  assert.match(segundo.motivo, /tope/);
  const L2 = laboratorio({ herramienta: 'setTimeout(() => console.log("tarde"), 2000);\n' });
  const lento = L2.comparar(node('tool.js'), { TYCON_COMPARE_TIMEOUT_MS: '500' }).e;
  assert.strictEqual(lento.resultado, 'no-comparado');
  assert.match(lento.motivo, /tope/);
});

test('T11 Compare_Limpieza_TambienDespuesDeMatarlo @story-8.167 @ac-9 — no queda ningún clon y git worktree list no cambia', async () => {
  const L = laboratorio({ sid: 's-cp11' });
  // las carpetas de los worktrees (el HEAD cambia con el commit de la prueba)
  const carpetas = () => L.g('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).join('\n');
  const worktrees = carpetas();
  L.comparar(node('tool.js'));
  assert.ok(fs.existsSync(path.join(L.state, 'compare-previous', 's-cp11')), 'el par de clones de la corrida');
  // al cerrar la corrida se borran
  cp().limpiar(L.state, 's-cp11');
  assert.ok(!fs.existsSync(path.join(L.state, 'compare-previous', 's-cp11')));
  // una comparación de una sesión sin corrida abierta, cortada a mitad: la próxima la barre
  fs.writeFileSync(path.join(L.repo, 'lento.js'), 'setTimeout(() => {}, 30000);\n');
  L.g('add', 'lento.js');
  L.g('commit', '-qm', 'lento');
  L.g('push', '-q', 'origin', 'HEAD:main');
  const h = spawn(process.execPath, [CP, 'humo', '--run-dir', L.runDir, '--state-dir', L.state, '--sid', 's-cortada', '--', process.execPath, 'lento.js'], { cwd: L.repo, env: L.env(), stdio: 'ignore' });
  for (let i = 0; i < 100 && !fs.existsSync(path.join(L.state, 'compare-previous', 's-cortada', 'repo-' + '')); i++) {
    if (fs.existsSync(path.join(L.state, 'compare-previous', 's-cortada'))) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  await new Promise((res) => setTimeout(res, 1500));
  h.kill('SIGKILL');
  await new Promise((res) => h.on('close', res));
  L.comparar(node('tool.js'));
  assert.ok(!fs.existsSync(path.join(L.state, 'compare-previous', 's-cortada')), 'la corrida cortada se barrió');
  cp().limpiar(L.state, 's-cp11');
  assert.deepStrictEqual(fs.existsSync(path.join(L.state, 'compare-previous')) ? fs.readdirSync(path.join(L.state, 'compare-previous')) : [], []);
  assert.strictEqual(carpetas(), worktrees);
});

test('T19 Compare_ReemplazoDeGit_CortaLosSubcomandosDeRed @story-8.167 @ac-17 — fetch, pull, clone, ls-remote, remote y submodule salen 97', () => {
  const marcas = path.join(tmp('cp-marcas-'), 'm.txt');
  for (const sub of ['fetch', 'pull', 'clone', 'ls-remote', 'remote', 'submodule']) {
    const r = spawnSync(path.join(SCRIPTS, 'lib', 'compare-shims', 'git'), ['-C', '.', sub], { encoding: 'utf8', env: { ...process.env, TYCON_COMPARE_MARKS: marcas } });
    assert.strictEqual(r.status, 97, `${sub}: ${r.stderr}`);
    assert.match(r.stderr, /compare: sin red/);
  }
  assert.strictEqual(fs.readFileSync(marcas, 'utf8').trim().split('\n').length, 6);
  const L = laboratorio();
  const { e } = L.comparar(['bash', '-c', 'git ls-remote origin; echo listo']);
  assert.strictEqual(e.resultado, 'no-comparado');
  assert.match(e.motivo, /usa la red/);
});

test('T20 Compare_GitPorRutaAbsoluta_NoEmpuja @story-8.167 @ac-17 — un git push por ruta absoluta no empuja ni deja marca', () => {
  const L = laboratorio();
  const gitAbs = execFileSync('bash', ['-c', 'command -v git']).toString().trim();
  const antes = execFileSync('git', ['-C', L.origen, 'for-each-ref']).toString();
  const { e } = L.comparar(['bash', '-c', `${gitAbs} push origin HEAD:main; echo salio $?`]);
  assert.notStrictEqual(e.resultado, 'no-comparado', JSON.stringify(e));
  assert.ok(!e.main.marcas && !e.cambio.marcas, JSON.stringify(e));
  assert.strictEqual(execFileSync('git', ['-C', L.origen, 'for-each-ref']).toString(), antes, 'el origen no recibió nada');
});

test('T21 Compare_NodeSinRed @story-8.167 @ac-17 — fetch, http.get y dns.lookup de Node fallan y dan «usa la red»', () => {
  const L = laboratorio();
  const codigos = [
    'fetch("http://example.com").then(() => console.log("salió"), (e) => console.log("cortado", e.message))',
    'require("http").get("http://example.com", () => console.log("salió"))',
    'require("dns").lookup("example.com", (e) => console.log(e ? "cortado" : "salió"))',
  ];
  for (const c of codigos) {
    const { e } = L.comparar([process.execPath, '-e', `try { ${c} } catch (e) { console.log("cortado", e.message) }`]);
    assert.strictEqual(e.resultado, 'no-comparado', `${c}: ${JSON.stringify(e)}`);
    assert.match(e.motivo, /usa la red/);
  }
});

test('T22 Compare_SeNiegaATocarLoReal @story-8.167 @ac-18 — la raíz real, la casa real o sudo: no se corre', () => {
  const L = laboratorio();
  const testigo = path.join(L.base, 'corrio.txt');
  for (const argv of [['bash', '-c', `touch ${testigo}; ls ${L.repo}`], ['bash', '-c', `touch ${testigo}; ls ${L.home}`], ['sudo', 'touch', testigo]]) {
    const { e } = L.comparar(argv);
    assert.strictEqual(e.resultado, 'no-comparado', JSON.stringify(e));
    assert.match(e.motivo, /toca lo real/);
  }
  assert.ok(!fs.existsSync(testigo), 'no se corrió');
});

test('T23 Compare_InformeDiceElEncierro @story-8.167 @ac-19 — el informe dice el encierro; sin él, «ninguno»', () => {
  const L = laboratorio();
  const con = L.comparar(node('tool.js')).e;
  const esperado = process.platform === 'darwin' ? 'sandbox-exec' : null;
  if (esperado) assert.strictEqual(con.encierro.nombre, esperado);
  assert.ok(con.encierro.corta, JSON.stringify(con.encierro));
  const sin = L.comparar(node('tool.js'), { TYCON_COMPARE_SANDBOX: 'off' }).e;
  assert.strictEqual(sin.encierro.nombre, 'ninguno');
  assert.strictEqual(sin.resultado, 'igual');
});

test('T29 Compare_UnClonPorCorrida_SeRehaceSiCambia @story-8.167 @ac-23 — dos humos reusan los clones; un cambio sin commitear rehace el del cambio', () => {
  const L = laboratorio();
  assert.deepStrictEqual(L.comparar(node('tool.js')).e.clones, { main: 'nuevo', cambio: 'nuevo' });
  assert.deepStrictEqual(L.comparar(node('tool.js')).e.clones, { main: 'reusado', cambio: 'reusado' });
  fs.writeFileSync(path.join(L.repo, 'tool.js'), 'console.log("otra");\n');
  assert.deepStrictEqual(L.comparar(node('tool.js')).e.clones, { main: 'reusado', cambio: 'nuevo' });
});

test('T30 Compare_TopeTotalYTiempoDelCambio @story-8.167 @ac-9 — TYCON_COMPARE_TOTAL_MS chico y la corrida del cambio lenta', () => {
  const L = laboratorio({ cambio: 'setTimeout(() => console.log("tarde"), 20000);\n' });
  const { e } = L.comparar(node('tool.js'), { TYCON_COMPARE_TOTAL_MS: '6000' });
  assert.strictEqual(e.resultado, 'no-comparado', JSON.stringify(e));
  assert.match(e.motivo, /tope: la corrida de cambio/);
});

test('T32 Compare_EncierroCortaLoQueDice @story-8.167 @ac-19b — escribir en la casa real por ruta absoluta', { skip: !['darwin', 'linux'].includes(process.platform) }, () => {
  const L = laboratorio();
  const objetivo = path.join(L.home, 'escrito-por-la-corrida.txt');
  const { e } = L.comparar(['bash', '-c', 'echo x > "$OBJETIVO" && echo escribio || echo no-pudo'], { OBJETIVO: objetivo });
  if (e.encierro.nombre === 'sandbox-exec') {
    assert.strictEqual(e.encierro.corta, 'red y escritura');
    assert.ok(!fs.existsSync(objetivo), 'el encierro cortó la escritura');
  } else if (e.encierro.nombre === 'unshare') {
    assert.match(e.encierro.corta, /escritura sin cortar/);
  }
});

test('T33 Compare_Raiz_SeReemplazaPorCadaClon @story-8.167 @ac-18 — {raiz} es la raíz de cada clon; con la raíz real escrita, no se corre', () => {
  const L = laboratorio({ herramienta: 'console.log("raíz:", process.argv[2]);\n' });
  const { e } = L.comparar(node('{raiz}/tool.js', '{raiz}'));
  assert.strictEqual(e.resultado, 'igual', JSON.stringify(e));
  // el humo de siempre recibe la raíz real, y el registro guarda {raiz} literal
  const dod = path.join(L.repo, '.advisors', 'dod-runtime');
  const r = spawnSync('bash', [SMOKE, dod, path.join(L.repo, 'specs', 'story-9.7-cmp.md'), '--compare', '--', process.execPath, '{raiz}/tool.js', '{raiz}'],
    { cwd: L.repo, encoding: 'utf8', env: L.env() });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`raíz: ${L.repo}`) || r.stderr.includes(`raíz: ${L.repo}`), r.stdout + r.stderr);
  const renglon = JSON.parse(fs.readFileSync(path.join(dod, '9.7-smoke-ledger.jsonl'), 'utf8').trim().split('\n').pop());
  assert.match(renglon.cmd, /\{raiz\}\/tool\.js/);
  const escrita = L.comparar(node(`${L.repo}/tool.js`, L.repo)).e;
  assert.strictEqual(escrita.resultado, 'no-comparado');
  assert.match(escrita.motivo, /toca lo real/);
});

// ── Lo que encontró el pase adversarial de la 8.243 ───────────────────────────────────────────────────────────────────
test('P7 Compare_SalidaYErrorEnSuOrden @story-8.167 @ac-2 — la salida y la de error mezcladas en el orden en que se escriben: el mismo código da igual siempre', () => {
  const herramienta = ['for (let i = 0; i < 60; i++) { console.error(`aviso ${i}`); console.log(`resultado ${i}`); }', ''].join('\n');
  const L = laboratorio({ herramienta, cambio: `${herramienta}// un comentario\n` });
  for (let k = 0; k < 3; k++) {
    const { e } = L.comparar(node('tool.js'));
    assert.strictEqual(e.resultado, 'igual', JSON.stringify(e.diff));
  }
});

test('P8 Compare_EstadoConEnlace @story-8.167 @ac-8 — con un enlace en la carpeta de estado, la ruta real de cada clon también se tapa', () => {
  const herramienta = 'console.log(__dirname); console.log(process.cwd());\n';
  const L = laboratorio({ herramienta, cambio: `${herramienta}// otro\n` });
  const enlace = path.join(L.base, 'estado-enlace');
  fs.symlinkSync(L.state, enlace);
  const r = spawnSync(process.execPath, [CP, 'humo', '--run-dir', L.runDir, '--state-dir', enlace, '--sid', L.sid, '--', process.execPath, 'tool.js'], { cwd: L.repo, encoding: 'utf8', env: L.env() });
  const e = cp().leerInforme(L.runDir).at(-1);
  assert.strictEqual(e.resultado, 'igual', `${r.stderr}\n${JSON.stringify(e.diff)}`);
});

test('P9 Compare_SegundosSoloEnElResumen @story-8.167 @ac-8 — «timeout: 30s» contra «timeout: 600s» es un cambio; en un renglón de resumen, no', () => {
  const n = (t) => cp().normalizar(t, {});
  assert.notStrictEqual(n('timeout de la espera: 30s'), n('timeout de la espera: 600s'));
  assert.strictEqual(n('ℹ tests 4 2.5s'), n('ℹ tests 4 3s'));
  assert.strictEqual(n('[suites] 616 corridas · 444s'), n('[suites] 616 corridas · 12s'));
});

test('P10 Compare_ArchivoQueCorre_ConOpcionDeValor @story-8.167 @ac-22 — `node -r ./setup.js tool.js` corre tool.js', () => {
  const L = laboratorio();
  fs.writeFileSync(path.join(L.repo, 'setup.js'), '\n');
  assert.strictEqual(cp().archivoQueCorre(['node', '-r', './setup.js', 'tool.js', 'show'], { cwd: L.repo, raiz: L.repo }), fs.realpathSync(path.join(L.repo, 'tool.js')));
  assert.strictEqual(cp().archivoQueCorre(['node', '--require=./setup.js', 'tool.js'], { cwd: L.repo, raiz: L.repo }), fs.realpathSync(path.join(L.repo, 'tool.js')));
  // los bordes negativos: sin archivo, un archivo que no existe, una opción que pide valor y no lo trae, o una opción
  // desconocida que se come el nombre (se toma su valor como archivo, que no existe): nada corre, null
  for (const argv of [['node'], ['node', 'nope.js'], ['node', '-r'], ['node', '--unknown-flag', 'valor', 'tool.js'], ['herramienta-que-no-existe']]) {
    assert.strictEqual(cp().archivoQueCorre(argv, { cwd: L.repo, raiz: L.repo }), null, argv.join(' '));
  }
});

test('P12 Compare_SalidaDeMasDeUnMega_NoDaIgual @story-8.167 @ac-2 — la diferencia después del corte no se esconde como «igual»', () => {
  // las dos versiones escriben lo mismo el primer mega y difieren al final
  const grande = (fin) => `process.stdout.write('x'.repeat(1100000) + '\\n${fin}\\n');\n`;
  const L = laboratorio({ herramienta: grande('fin A'), cambio: grande('fin B') });
  const { e } = L.comparar(node('tool.js'));
  assert.strictEqual(e.resultado, 'no-comparado', JSON.stringify(e));
  assert.match(e.motivo, /más de 1 MB/);
  // con la diferencia antes del corte, «distinto» sí vale
  const L2 = laboratorio({ herramienta: "process.stdout.write('a\\n' + 'x'.repeat(1100000));\n", cambio: "process.stdout.write('b\\n' + 'x'.repeat(1100000));\n" });
  assert.strictEqual(L2.comparar(node('tool.js')).e.resultado, 'distinto');
});

test('P11 Compare_SesionPuntoPunto_YInformeIlegible @story-8.167 @ac-9 — «..» no borra la carpeta de estado; un informe que no se lee lo dice', () => {
  const L = laboratorio();
  fs.writeFileSync(path.join(L.state, 'gates.log'), 'no se borra\n');
  cp().limpiar(L.state, '..');
  cp().limpiar(L.state, '.');
  spawnSync(process.execPath, [CP, 'limpiar', '..', '--state-dir', L.state], { encoding: 'utf8', env: L.env() });
  assert.ok(fs.existsSync(path.join(L.state, 'gates.log')), 'la carpeta de estado sigue entera');
  assert.ok(fs.existsSync(path.join(L.state, 'active')), 'y su marcador también');
  // un informe roto no es «no hubo comparaciones»: el error lo dice, y al anotar queda aparte en vez de pisarse
  fs.mkdirSync(L.runDir, { recursive: true });
  fs.writeFileSync(path.join(L.runDir, cp().INFORME), '{ roto');
  const v = cp().informeVerificado(L.runDir, L.state);
  assert.match(String(v.error), /no es JSON/);
  cp().anotarEntrada(L.runDir, L.state, { sid: L.sid, cmd: 'x', resultado: 'igual' });
  assert.ok(fs.readdirSync(L.runDir).some((f) => f.startsWith(`${cp().INFORME}.ilegible-`)), 'el roto quedó aparte');
  assert.strictEqual(cp().leerInforme(L.runDir).length, 1);
});
