'use strict';
/**
 * git-memo.test.js — cada proceso le pregunta a git una sola vez lo mismo.
 *
 * Cuatro lugares recuerdan la respuesta de git mientras la carpeta tiene la misma huella (lib/git-stamp.js: el `HEAD`,
 * su historial, la referencia y el índice en uso, leídos del disco): la lista de archivos del commit en el gancho
 * (`on-pre-commit.js`), lo commiteado de `.tycon/` (`config-source.js`), la rama de un hermano (`companion-repos.js`) y,
 * con una versión escrita entera, cada `<commit>:<ruta>` del guion de los controles de la base (`run-base-controls.sh`).
 *
 * Los procesos se cuentan con `GIT_TRACE` a un archivo (el renglón `trace: built-in: git …` de cada llamada); lo que
 * corre en el proceso de la prueba, envolviendo `child_process` antes de cargar las librerías. `TYCON_GIT_MEMO=0` apaga
 * el recuerdo: la salida tiene que ser la misma con y sin él.
 *
 *   T38 GanchoDelCommit_ListaYConfigUnaVez
 *   T39 ControlesDeLaBase_UnaPreguntaPorCommitYRuta
 *   T40 Hermano_RamaUnaVez_OtroHeadVuelveAPreguntar
 *
 * stable-data: las fechas de los commits son fijas; ninguna se compara con el reloj.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

// Las llamadas a git de este proceso, contadas antes de cargar las librerías (guardan `spawnSync`/`execFileSync` al cargar).
const llamadas = [];
for (const fn of ['spawnSync', 'execFileSync']) {
  const orig = cp[fn];
  cp[fn] = function contar(cmd, args, ...rest) {
    if (cmd === 'git' && Array.isArray(args)) llamadas.push(args.join(' '));
    return orig.call(this, cmd, args, ...rest);
  };
}
const { spawnSync } = cp;

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.resolve(SCRIPTS, '..', '..', '..');
const HOOK = path.join(SCRIPTS, 'on-pre-commit.js');
const BASE_CONTROLS = path.join(RAIZ, 'scripts', 'ci', 'run-base-controls.sh');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@example.com', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@example.com',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};
// sin la sesión ni lo que un gancho le pasa a git: cada prueba arma su ambiente
const LIMPIO = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !/^(CLAUDE_CODE_SESSION_ID|TYCON_SESSION_ID|CODEX_SESSION_ID|GIT_DIR|GIT_INDEX_FILE|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_TRACE|TYCON_GIT_MEMO|NODE_TEST_CONTEXT)$/.test(k)));

function sh(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env: { ...LIMPIO, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const tmp = (t, pre) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), pre)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
function escribir(d, r, c) {
  const f = path.join(d, r);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, c);
}
function repo(t, pre = 'memo-') {
  const d = tmp(t, pre);
  sh(d, 'init', '-q', '-b', 'main');
  escribir(d, 'LEEME.md', 'hola\n');
  sh(d, 'add', '-A');
  sh(d, 'commit', '-q', '-m', 'base');
  return d;
}
/** Los renglones `trace: built-in: git …` del archivo de GIT_TRACE, sin el prefijo ni las comillas que git pone a `^{}`. */
function trazas(f) {
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').map((l) => (l.match(/trace: built-in: git (.*)$/) || [])[1]).filter(Boolean)
    .map((l) => l.replace(/'/g, ''));
}
const cuantas = (lista, re) => lista.filter((l) => re.test(l)).length;
const repetidas = (lista, re) => {
  const c = new Map();
  for (const l of lista.filter((x) => re.test(x))) c.set(l, (c.get(l) || 0) + 1);
  return [...c].filter(([, n]) => n > 1).map(([l, n]) => `${n}× ${l}`);
};

/** El gancho como lo corre Claude Code: el evento por la entrada, con `GIT_TRACE` a `traza`. */
function gancho(h, command, cwd, traza, env = {}) {
  const ev = { session_id: 'ses-memo', tool_name: 'Bash', tool_input: { command }, cwd };
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(ev), cwd, encoding: 'utf8', timeout: 60000,
    env: { ...LIMPIO, ...GIT_ENV, HOME: h, USERPROFILE: h, GIT_TRACE: traza, ...env },
  });
  return { status: r.status, salida: `${r.stdout}${r.stderr}`.split(traza).join('<traza>') };
}

// T38 GanchoDelCommit_ListaYConfigUnaVez
// 🔴 Falla con: el gancho pidiendo la lista del commit o el yaml más de una vez (el costo que pagan las suites y cada
// sesión), o recordando la lista del índice real cuando el gancho ya pasó a la copia con los `add` simulados.
test('T38 GanchoDelCommit_ListaYConfigUnaVez', (t) => {
  const h = tmp(t, 'memo-home-');
  const a = repo(t);
  escribir(a, '.tycon/advisors.yaml', 'story_ids: ["9.99"]\n');
  sh(a, 'add', '-A');
  sh(a, 'commit', '-q', '-m', 'el yaml');
  escribir(a, 'app.js', 'module.exports = 1;\n');
  sh(a, 'add', 'app.js');

  const traza = path.join(tmp(t, 'memo-traza-'), 'git.trace');
  const con = gancho(h, 'git commit -m x', a, traza);
  const lista = trazas(traza);
  assert.strictEqual(cuantas(lista, /^diff --cached --name-only$/), 1, `una sola lista del commit:\n${lista.join('\n')}`);
  assert.deepStrictEqual(repetidas(lista, /^show HEAD:\.tycon\//), [], 'cada archivo de .tycon commiteado, una vez');
  assert.deepStrictEqual(repetidas(lista, /^diff --cached/), [], 'ninguna lista del commit repetida con los mismos argumentos');

  // la misma salida sin recordar
  const traza0 = path.join(tmp(t, 'memo-traza-'), 'git.trace');
  const sin = gancho(h, 'git commit -m x', a, traza0, { TYCON_GIT_MEMO: '0' });
  assert.strictEqual(con.status, sin.status, `${con.salida}\n---\n${sin.salida}`);
  assert.strictEqual(con.salida, sin.salida);
  assert.ok(cuantas(trazas(traza0), /^diff --cached --name-only$/) > 1, 'sin recordar, el gancho pregunta varias veces (si no, la prueba no mide nada)');

  // `git add otro && git commit`: el gancho evalúa una copia del índice con el `add`; la lista se vuelve a preguntar
  escribir(a, 'otro.js', 'module.exports = 2;\n');
  const trazaAdd = path.join(tmp(t, 'memo-traza-'), 'git.trace');
  const conAdd = gancho(h, 'git add otro.js && git commit -m x', a, trazaAdd);
  const sinAdd = gancho(h, 'git add otro.js && git commit -m x', a, path.join(tmp(t, 'memo-traza-'), 'git.trace'), { TYCON_GIT_MEMO: '0' });
  assert.strictEqual(conAdd.status, sinAdd.status, `${conAdd.salida}\n---\n${sinAdd.salida}`);
  assert.strictEqual(conAdd.salida, sinAdd.salida);

  // en el mismo proceso: la lista del índice real y, con GIT_INDEX_FILE en la copia con el `add`, la nueva
  const { getStagedDiff } = require(HOOK);
  const antes = process.env.GIT_INDEX_FILE;
  t.after(() => { if (antes === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = antes; });
  delete process.env.GIT_INDEX_FILE;
  const real = getStagedDiff(a).split('\n').filter(Boolean);
  assert.deepStrictEqual(real, ['app.js']);
  const copia = path.join(tmp(t, 'memo-indice-'), 'index');
  fs.copyFileSync(path.join(a, '.git', 'index'), copia);
  spawnSync('git', ['add', 'otro.js'], { cwd: a, env: { ...LIMPIO, ...GIT_ENV, GIT_INDEX_FILE: copia } });
  process.env.GIT_INDEX_FILE = copia;
  assert.deepStrictEqual(getStagedDiff(a).split('\n').filter(Boolean), ['app.js', 'otro.js'], 'con la copia, la lista nueva');
  delete process.env.GIT_INDEX_FILE;
  assert.deepStrictEqual(getStagedDiff(a).split('\n').filter(Boolean), ['app.js'], 'de vuelta al índice real, la de siempre');

  // un GIT_INDEX_FILE relativo lo resuelve git desde la raíz del repo, no desde la carpeta: sin huella, no se recuerda
  const GS = require(path.join(SCRIPTS, 'lib', 'git-stamp.js'));
  fs.mkdirSync(path.join(a, 'sub'));
  assert.strictEqual(GS.stampOf(path.join(a, 'sub'), { GIT_INDEX_FILE: '../otro-indice' }), null);
  assert.ok(GS.stampOf(path.join(a, 'sub'), { GIT_INDEX_FILE: copia }), 'con ruta absoluta, sí hay huella');
});

/** La base de juguete de base-controls.test.sh: un control que frena una palabra salvo en los archivos de su lista. */
function baseDeJuguete(r) {
  escribir(r, '.githooks/pre-commit-checks', 'REPO_ROOT="$(git rev-parse --show-toplevel)"\nbash "$REPO_ROOT/scripts/ci/toy-check.sh" || exit 1\n');
  escribir(r, 'scripts/ci/toy-check.sh', [
    'REPO_ROOT="$(git rev-parse --show-toplevel)"',
    'WORD="PROHIBIDO"',
    "node -e '",
    'const fs = require("fs"); const { execFileSync } = require("child_process");',
    'const [root, word] = process.argv.slice(1);',
    'const rules = JSON.parse(fs.readFileSync(root + "/scripts/ci/toy-rules.json", "utf8"));',
    'const files = execFileSync("git", ["-C", root, "diff", "--cached", "--name-only", "--diff-filter=ACMR"]).toString().split("\\n").filter(Boolean);',
    'let bad = 0;',
    'for (const f of files) {',
    '  if (f.startsWith("scripts/") || f.startsWith(".")) continue;',
    '  const text = execFileSync("git", ["-C", root, "show", ":" + f]).toString();',
    '  if (text.includes(word) && !(rules.allow || []).includes(f)) { console.log("toy: " + word + " en " + f); bad++; }',
    '}',
    'process.exit(bad && rules.mode === "block" ? 1 : 0);',
    "' \"$REPO_ROOT\" \"$WORD\"",
    '',
  ].join('\n'));
  escribir(r, 'scripts/ci/toy-rules.json', '{ "mode": "block", "allow": ["docs/permitido.txt"] }\n');
  escribir(r, 'scripts/ci/toy-names.json', '{ "names": ["uno"] }\n');
  escribir(r, 'scripts/ci/controls-from-base.json', JSON.stringify({
    hook: '.githooks/pre-commit-checks',
    passes: [{ name: 'pre-commit', mode: 'index', cmd: ['bash', '.githooks/pre-commit-checks'] }],
    controls: [
      { name: 'toy', script: 'scripts/ci/toy-check.sh', rules: ['scripts/ci/toy-rules.json', 'scripts/ci/toy-names.json'] },
      { name: 'base-controls', script: 'scripts/ci/run-base-controls.sh', rules: ['scripts/ci/controls-from-base.json'] },
    ],
    content: [],
    workflows: [{ path: '.github/workflows/ci.yml', must_contain: ['run-base-controls'] }],
    approvals: '.tycon/control-changes.jsonl',
  }, null, 2));
  fs.copyFileSync(BASE_CONTROLS, path.join(r, 'scripts', 'ci', 'run-base-controls.sh'));
  escribir(r, '.github/workflows/ci.yml', 'name: ci\njobs: { ci: { steps: [ { run: "bash run-base-controls" } ] } }\n');
  escribir(r, 'docs/leeme.txt', 'nada\n');
  sh(r, 'init', '-q', '-b', 'main');
  sh(r, 'add', '-A');
  sh(r, 'commit', '-q', '-m', 'base');
}

// T39 ControlesDeLaBase_UnaPreguntaPorCommitYRuta
// 🔴 Falla con: el guion de los controles de la base preguntando varias veces por el mismo `<commit>:<ruta>` o el mismo
// `<commit>^{commit}` en una corrida, o dando otro veredicto u otra salida por recordar.
test('T39 ControlesDeLaBase_UnaPreguntaPorCommitYRuta', (t) => {
  const r = path.join(tmp(t, 'memo-base-'), 'repo');
  fs.mkdirSync(r);
  baseDeJuguete(r);
  sh(r, 'checkout', '-q', '-b', 'pedido');
  escribir(r, 'docs/malo.txt', 'PROHIBIDO\n');
  escribir(r, 'scripts/ci/toy-rules.json', '{ "mode": "warn", "allow": ["docs/permitido.txt"] }\n');
  sh(r, 'add', '-A');
  sh(r, 'commit', '-q', '-m', 'pedido');
  const h = tmp(t, 'memo-home-');
  const correr = (env) => {
    const traza = path.join(tmp(t, 'memo-traza-'), 'git.trace');
    const p = spawnSync('bash', [BASE_CONTROLS, 'run', '--root', r, '--base', 'main', '--range', 'main...pedido'], {
      encoding: 'utf8', timeout: 120000, env: { ...LIMPIO, ...GIT_ENV, HOME: h, USERPROFILE: h, GIT_TRACE: traza, ...env },
    });
    return { status: p.status, salida: `${p.stdout}${p.stderr}`, lista: trazas(traza) };
  };
  const con = correr({});
  const sin = correr({ TYCON_GIT_MEMO: '0' });
  assert.strictEqual(con.status, 1, `el pedido que baja el modo es rojo:\n${con.salida}`);
  assert.strictEqual(con.status, sin.status);
  assert.strictEqual(con.salida, sin.salida, 'la misma salida con y sin recordar');
  const sha = /^rev-parse --verify -q [0-9a-f]{40}(\^\{commit\}|:.+)$/;
  assert.deepStrictEqual(repetidas(con.lista, sha), [], 'cada commit:ruta y cada commit^{commit}, una vez');
  assert.deepStrictEqual(repetidas(con.lista, /^cat-file blob [0-9a-f]{40}:.+$/), [], 'cada blob de la base, una vez');
  assert.ok(repetidas(sin.lista, sha).length > 0, 'sin recordar se repiten (si no, la prueba no mide nada)');
  // una versión con nombre se pregunta cada vez: las mismas veces con y sin recordar
  const conNombre = /^rev-parse --verify -q (main|pedido|HEAD)(\^\{commit\}|:.+)$/;
  assert.ok(cuantas(sin.lista, conNombre) > 0, 'la corrida pregunta por versiones con nombre');
  assert.strictEqual(cuantas(con.lista, conNombre), cuantas(sin.lista, conNombre), 'con nombre no se recuerda');
  assert.ok(con.lista.length < sin.lista.length, `menos llamadas: ${con.lista.length} contra ${sin.lista.length}`);
});

// T40 Hermano_RamaUnaVez_OtroHeadVuelveAPreguntar
// 🔴 Falla con: una respuesta vieja dentro de un proceso (la rama de antes de un `switch -c`, el yaml de antes de un
// commit, la carpeta de trabajo recordada, un null de git que no contestaba), o la misma pregunta hecha dos veces.
test('T40 Hermano_RamaUnaVez_OtroHeadVuelveAPreguntar', (t) => {
  const CR = require(path.join(SCRIPTS, 'lib', 'companion-repos.js'));
  const CS = require(path.join(SCRIPTS, 'lib', 'config-source.js'));
  const a = repo(t);
  const de = (re) => { const n = cuantas(llamadas, re); llamadas.length = 0; return n; };
  llamadas.length = 0;

  // la rama: una pregunta mientras la huella es la misma
  assert.strictEqual(CR.ramaDe(a), 'main');
  assert.strictEqual(CR.ramaDe(a), 'main');
  assert.strictEqual(de(/symbolic-ref/), 1, 'la rama, una vez');
  // rama nueva en el mismo commit
  sh(a, 'switch', '-q', '-c', 'otra');
  assert.strictEqual(CR.ramaDe(a), 'otra', 'la rama nueva, aunque el commit sea el mismo');
  assert.strictEqual(de(/symbolic-ref/), 1);

  // el yaml: lo commiteado una vez; la carpeta, siempre del disco
  assert.strictEqual(CS.leerAmbas(a).commiteado, null);
  const primeras = llamadas.length;
  assert.strictEqual(CS.leerAmbas(a).commiteado, null);
  assert.strictEqual(llamadas.length, primeras, 'la segunda lectura no le pregunta a git');
  llamadas.length = 0;
  escribir(a, '.tycon/advisors.yaml', 'uno: 1\n');
  assert.strictEqual(CS.leerAmbas(a).carpeta, 'uno: 1\n', 'el yaml sin commitear se ve sin commitear');
  assert.strictEqual(CS.leerAmbas(a).commiteado, null, 'y todavía no está commiteado');
  sh(a, 'add', '-A');
  sh(a, 'commit', '-q', '-m', 'el yaml');
  assert.strictEqual(CS.leerAmbas(a).commiteado, 'uno: 1\n', 'después del commit, el commiteado nuevo');
  assert.strictEqual(CS.archivoParaFreno(a, '.tycon/advisors.yaml'), 'uno: 1\n');
  escribir(a, '.tycon/advisors.yaml', 'dos: 2\n');
  assert.strictEqual(CS.leerAmbas(a).carpeta, 'dos: 2\n');
  assert.strictEqual(CS.leerAmbas(a).difieren, true);

  // una carpeta que no es repo da null, y el null no se recuerda: con `git init`, la rama
  const suelta = tmp(t, 'memo-suelta-');
  assert.strictEqual(CR.ramaDe(suelta), null);
  sh(suelta, 'init', '-q', '-b', 'nueva');
  escribir(suelta, 'x', 'x\n');
  sh(suelta, 'add', '-A');
  sh(suelta, 'commit', '-q', '-m', 'x');
  assert.strictEqual(CR.ramaDe(suelta), 'nueva', 'el null de antes no se recordó');

  // desde una subcarpeta del repo, lo commiteado de .tycon/ es el de la raíz (como `git show HEAD:<ruta>`)
  fs.mkdirSync(path.join(a, 'sub'), { recursive: true });
  escribir(a, '.tycon/atdd-gate', 'block\n');
  sh(a, 'add', '.tycon/atdd-gate');
  sh(a, 'commit', '-q', '-m', 'atdd');
  assert.strictEqual(CS.leerCommiteado(path.join(a, 'sub')), CS.leerCommiteado(a), 'el yaml commiteado, también desde la subcarpeta');
  assert.strictEqual(CS.archivoParaFreno(path.join(a, 'sub'), '.tycon/atdd-gate'), 'block\n', 'el archivo suelto, también desde la subcarpeta');

  // git que no contesta (una configuración rota, que la huella no mira): «no está commiteado» no se recuerda
  const cfg = path.join(a, '.git', 'config');
  const cfgSana = fs.readFileSync(cfg, 'utf8');
  sh(a, 'add', '-A');
  sh(a, 'commit', '-q', '-m', 'el yaml dos');
  fs.writeFileSync(cfg, '[core\n  roto = = =\n');
  assert.strictEqual(CS.leerAmbas(a).commiteado, null, 'con git que no contesta, no hay commiteado');
  fs.writeFileSync(cfg, cfgSana);
  assert.strictEqual(CS.leerAmbas(a).commiteado, 'dos: 2\n', 'con git sano otra vez, lo commiteado (el fallo no se recordó)');

  // sin huella no se recuerda: las referencias en `reftable/`, o GIT_DIR puesto
  const GS = require(path.join(SCRIPTS, 'lib', 'git-stamp.js'));
  assert.ok(GS.stampOf(a), 'una carpeta de git común tiene huella');
  assert.strictEqual(GS.stampOf(a, { GIT_DIR: path.join(a, '.git') }), null);
  const reftable = path.join(a, '.git', 'reftable');
  fs.mkdirSync(reftable);
  assert.strictEqual(GS.stampOf(a), null, 'con reftable/ no hay huella');
  llamadas.length = 0;
  CR.ramaDe(a); CR.ramaDe(a);
  assert.strictEqual(de(/symbolic-ref/), 2, 'sin huella, cada lectura pregunta como siempre');
  fs.rmdirSync(reftable);

  // sin recordar (TYCON_GIT_MEMO=0) cada lectura pregunta
  process.env.TYCON_GIT_MEMO = '0';
  t.after(() => { delete process.env.TYCON_GIT_MEMO; });
  llamadas.length = 0;
  CR.ramaDe(a); CR.ramaDe(a);
  assert.strictEqual(de(/symbolic-ref/), 2);
  // y los puntos de limpieza de lo que se carga en un proceso de node existen
  assert.strictEqual(typeof CS.limpiarCache, 'function');
  assert.strictEqual(typeof CR.limpiarRamas, 'function');
  assert.strictEqual(typeof require(HOOK).limpiarStaged, 'function');
});
