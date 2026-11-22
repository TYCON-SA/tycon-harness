'use strict';
/**
 * hook-env-bare-init.test.js — una prueba que arma un repo pelado de juguete no deja pelado al repo de verdad, aunque
 * corra dentro de un gancho de git.
 *
 * EL CASO. git le exporta a sus ganchos `GIT_DIR`, y desde una copia de trabajo enlazada vale la carpeta de esa copia
 * dentro del repo común (`<repo>/.git/worktrees/<nombre>`), en absoluto. Un `git -C <temporal> init --bare` sin carpeta
 * que herede esa variable no crea nada en el temporal: reinicia el repo de `GIT_DIR` y le pone `core.bare = true` al
 * común. Desde ahí el clon compartido no tiene árbol para git («this operation must be run in a work tree»), y la matriz
 * de cada historia privada lo compara «tal como está declarado» y da los humos por vencidos.
 *
 * QUÉ FRENA.
 *   · HookEnv_SuitesWithBareInit_LeaveRepoWithTree: team-config.test.js y third-party-origin.test.sh, corridas con el
 *     `GIT_DIR` y el `GIT_INDEX_FILE` de un gancho de una copia enlazada de un repo de juguete, lo dejan con su árbol, en
 *     su commit y sin `core.bare`. third-party-origin corre sin red (un proxy que no contesta): el repo pelado se arma
 *     antes de bajar nada, así que sale NO MEDIDO y lo que se mira es el repo.
 *   · HookEnv_BareInitWithoutFolder_CleansGitEnv: toda prueba que hace `init --bare` sin carpeta (con `-C` o con la
 *     carpeta del proceso) saca `GIT_DIR` antes: por clean-git-env.js, una lista de variables que filtra las `GIT_`,
 *     `env -u GIT_DIR` o `unset GIT_DIR`. Una prueba nueva que lo olvide sale con su archivo y su renglón.
 * Un `init --bare <carpeta>` no entra: con la carpeta, git la crea a ella aunque herede `GIT_DIR`.
 *
 * 🔴 Para ver el rojo: sin el `sinGitDelPadre` de team-config.test.js, la primera deja el repo de juguete pelado.
 *
 * Correr: node --test scripts/tests/hook-env-bare-init.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const { sinGitDelPadre } = require(path.join(ROOT, 'scripts', 'lib', 'clean-git-env.js'));

const tmpDirs = [];
test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `hook-env-${p}-`))); tmpDirs.push(d); return d; };

// git del laboratorio: sin la configuración de la máquina ni las variables del proceso que corre la prueba
const ENV_LAB = sinGitDelPadre({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Lab', GIT_AUTHOR_EMAIL: 'lab@example.com',
  GIT_COMMITTER_NAME: 'Lab', GIT_COMMITTER_EMAIL: 'lab@example.com', GIT_AUTHOR_DATE: '2026-11-22T10:00:00Z', GIT_COMMITTER_DATE: '2026-11-22T10:00:00Z' });
const git = (dir, ...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: ENV_LAB });

/** Un repo de juguete con un commit y una copia enlazada; devuelve las variables que git le da a un gancho de esa copia. */
function repoConCopia() {
  const base = tmp('repo');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'inicio');
  git(repo, 'worktree', 'add', '-q', '-b', 'copia', path.join(base, 'copia'));
  const gitDir = path.join(repo, '.git', 'worktrees', 'copia');
  return { repo, head: git(repo, 'rev-parse', 'HEAD').stdout.trim(), gancho: { GIT_DIR: gitDir, GIT_INDEX_FILE: path.join(gitDir, 'index') } };
}

function sigueConArbol(r, quien) {
  assert.strictEqual(git(r.repo, 'config', '--get', 'core.bare').stdout.trim(), 'false', `${quien}: core.bare`);
  const estado = git(r.repo, 'status', '--porcelain');
  assert.strictEqual(estado.status, 0, `${quien}: git status del repo: ${estado.stderr}`);
  assert.strictEqual(git(r.repo, 'rev-parse', 'HEAD').stdout.trim(), r.head, `${quien}: el commit del repo`);
}

test('HookEnv_SuitesWithBareInit_LeaveRepoWithTree — corridas dentro de un gancho de una copia enlazada, no dejan pelado a nadie', () => {
  const sinRed = { HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', GIT_TERMINAL_PROMPT: '0' };
  const suites = [
    ['team-config.test.js', process.execPath, ['--test', path.join(ROOT, 'scripts', 'tests', 'team-config.test.js')]],
    ['third-party-origin.test.sh', 'bash', [path.join(ROOT, 'scripts', 'tests', 'third-party-origin.test.sh')]],
  ];
  for (const [nombre, cmd, args] of suites) {
    const r = repoConCopia();
    // NODE_TEST_CONTEXT: la suite hija informa como un proceso propio, no como parte de esta
    const env = { ...process.env, ...sinRed, ...r.gancho };
    delete env.NODE_TEST_CONTEXT;
    const out = spawnSync(cmd, args, { cwd: path.dirname(r.gancho.GIT_DIR), encoding: 'utf8', env, timeout: 300000 });
    assert.ok(!out.error, `${nombre}: ${out.error && out.error.message}`);
    sigueConArbol(r, nombre);
  }
});

// ── el inventario: `init --bare` sin carpeta, con las variables de git del proceso limpias ─────────────────────────────
// Limpia las variables si usa clean-git-env.js, una lista que filtra las `GIT_` del entorno, una lista de las únicas que
// pasan (`env[k] = process.env[k]`), el ayudante del laboratorio (que corre `env -u GIT_DIR`), o saca `GIT_DIR` en su
// propio texto.
const LIMPIA = /clean-git-env|sinGitDelPadre|\^\(GIT_|\w+\[k\]\s*=\s*process\.env\[k\]|harness_lab_git|env -u GIT_DIR|unset[^\n]*\bGIT_DIR\b|delete [\w.]*\[?['"]?GIT_DIR/;

/** Los renglones de `texto` con un `init --bare` sin carpeta: después de `--bare` sólo vienen opciones. */
function initsSinCarpeta(texto, esShell) {
  const hallados = [];
  texto.split('\n').forEach((renglon, i) => {
    if (/^\s*(\/\/|\*|#)/.test(renglon)) return;
    // forma de llamada (JS): 'init', … '--bare', … hasta el `]` o el `)` que cierra
    for (const m of renglon.matchAll(/['"]init['"]\s*,([^\])]*)[\])]/g)) {
      const tokens = m[1].split(',').map((t) => t.trim()).filter(Boolean);
      if (!tokens.some((t) => /^['"]--bare['"]$/.test(t))) continue;
      const despues = tokens.slice(tokens.findIndex((t) => /^['"]--bare['"]$/.test(t)) + 1);
      const conCarpeta = despues.some((t, j) => !/^['"`]-/.test(t) && !/^['"`]-(b|-initial-branch)['"`]$/.test(despues[j - 1] || ''));
      if (!conCarpeta) hallados.push(i + 1);
    }
    // forma de consola: `init … --bare` y después sólo opciones, hasta el fin del comando
    if (esShell) {
      const m = /\binit((?:\s+-[-\w=]+)*)\s+--bare((?:\s+(?:-b|--initial-branch)\s+\S+|\s+-[-\w=]+)*)\s*($|[;&|>)])/.exec(renglon);
      if (m) hallados.push(i + 1);
    }
  });
  return hallados;
}

function archivosDePrueba(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'fixtures' && e.name !== 'node_modules') out.push(...archivosDePrueba(abs)); }
    else if (/\.(js|sh)$/.test(e.name)) out.push(abs);
  }
  return out;
}

test('HookEnv_BareInitWithoutFolder_CleansGitEnv — toda prueba con un init --bare sin carpeta saca GIT_DIR antes', () => {
  const carpetas = [path.join(ROOT, 'scripts', 'tests'), path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'tests')];
  const faltan = [];
  let vistos = 0;
  for (const abs of carpetas.flatMap(archivosDePrueba)) {
    if (abs === __filename) continue;
    const texto = fs.readFileSync(abs, 'utf8');
    const renglones = initsSinCarpeta(texto, abs.endsWith('.sh'));
    if (!renglones.length) continue;
    vistos += 1;
    if (!LIMPIA.test(texto)) faltan.push(`${path.relative(ROOT, abs)}:${renglones.join(',')}`);
  }
  // el control: el inventario encuentra los que hay (si dejara de encontrar, quedaría verde sin medir nada)
  assert.ok(vistos >= 3, `el inventario encontró ${vistos} pruebas con un init --bare sin carpeta; se esperaban al menos 3`);
  assert.deepStrictEqual(faltan, [], 'pruebas con un init --bare sin carpeta que heredan GIT_DIR (usá sinGitDelPadre de scripts/lib/clean-git-env.js)');
  // y el detector distingue la forma con carpeta de la forma sin carpeta
  assert.deepStrictEqual(initsSinCarpeta("git(d, ['init', '-q', '--bare']);\ngit(d, ['init', '-q', '--bare', '-b', 'main', origen]);", false), [1]);
  assert.deepStrictEqual(initsSinCarpeta('git -C "$B" init -q --bare\ngit init -q --bare "$T/o.git"\ng init -q --bare -b main >/dev/null', true), [1, 3]);
});
