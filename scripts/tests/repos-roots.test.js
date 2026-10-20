'use strict';
// repos-roots.test.js — the repos can live in several folders, and outside the personal folder: repos-root.js gives
// `roots` (all of them) and `root` (the first one), and the ones that walk the repos to count or upload walk them all.
// Homes, configs and repos are toys in temporary folders; no network.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const RR = require(path.join(ROOT, 'scripts', 'lib', 'repos-root.js'));

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
function repoAt(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}
const noConfig = { sinConfig: true };

test('T9 Raiz_FueraDelHome @story-2.67 @ac-7: fuera de la carpeta personal votan todos los ancestros, menos la raíz del disco', () => {
  const R = RR.__test.rutasDe('win32');
  const repos = ['D:\\Repos\\Acme\\Plugin\\Uno', 'D:\\Repos\\Beta\\Dos', 'D:\\Repos\\Tres'];
  const r = RR.__test.raizPorMayoria(repos, 'C:\\Users\\dev', R);
  assert.ok(r, 'hoy sin raíz');
  assert.strictEqual(r.root, 'D:\\Repos');
  // the drive root itself is never a root
  const sueltos = ['D:\\Uno', 'E:\\Dos'];
  assert.strictEqual(RR.__test.raizPorMayoria(sueltos, 'C:\\Users\\dev', R), null);
});

test('T10 Raiz_Lista @story-2.67 @ac-8: rutas.repos como lista y la variable con varias rutas dan todas', () => {
  const home = tmp('rr-home-');
  const a = path.join(tmp('rr-a-'), 'CodigoChile');
  const b = path.join(tmp('rr-b-'), 'CodigoArg');
  fs.mkdirSync(a, { recursive: true }); fs.mkdirSync(b, { recursive: true });
  const env = { TYCON_REPOS_ROOT: [a, b].join(path.delimiter) };
  assert.deepStrictEqual(RR.resolveReposRoot(undefined, { home, env, ...noConfig }).roots, [a, b]);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'tycon.json'), JSON.stringify({ paths: { repos: [a, b] } }));
  const r = RR.resolveReposRoot(undefined, { home, env: {} });
  assert.deepStrictEqual(r.roots, [a, b], JSON.stringify(r));
  assert.strictEqual(r.fuente, 'maquina');
  // one path still works as always
  fs.writeFileSync(path.join(home, '.claude', 'tycon.json'), JSON.stringify({ paths: { repos: a } }));
  assert.deepStrictEqual(RR.resolveReposRoot(undefined, { home, env: {} }).roots, [a]);
});

test('T11 Raiz_RootEsLaPrimera @story-2.67 @ac-9: root es la primera de roots; las sesiones dan una raíz por grupo de repos', () => {
  const home = tmp('rr-home-');
  const env = { TYCON_REPOS_ROOT: ['/uno', '/dos'].join(path.delimiter) };
  const r = RR.resolveReposRoot(undefined, { home, env, ...noConfig });
  assert.strictEqual(r.root, r.roots[0]);
  // two groups of repos in the sessions (Chile and Argentina): two roots
  const R = RR.__test.rutasDe('linux');
  const repos = ['/w/Chile/a', '/w/Chile/b', '/x/Arg/c', '/x/Arg/d'];
  assert.deepStrictEqual(RR.__test.raicesPorMayoria(repos, '/home/dev', R).map((x) => x.root), ['/w/Chile', '/x/Arg']);
});

test('T12 SinRaiz_DiceElComando @story-2.67 @ac-9: sin ninguna raíz, el motivo trae el comando para declararla', () => {
  const home = tmp('rr-home-');
  const r = RR.resolveReposRoot(undefined, { home, env: {}, projectsDir: path.join(home, 'nada'), clon: tmp('rr-clon-'), ...noConfig });
  assert.strictEqual(r.root, null);
  assert.deepStrictEqual(r.roots, []);
  assert.match(RR.describir(r), /tycon-config\.js" set paths\.repos <carpeta>/);
});

test('T13 Recorren_TodasLasRaices @story-2.67 @ac-10: los que recorren repos ven los de todas las raíces', () => {
  const a = tmp('rr-a-');
  const b = tmp('rr-b-');
  const r1 = repoAt(path.join(a, 'uno'));
  const r2 = repoAt(path.join(b, 'prod', 'dos'));
  const prev = process.env.TYCON_REPOS_ROOT;
  process.env.TYCON_REPOS_ROOT = [a, b].join(path.delimiter);
  try {
    const WS = require(path.join(ROOT, 'scripts', 'hooks', 'worktree-sweep.js'));
    const known = WS.knownRepos(null).map((p) => fs.realpathSync(p)).sort();
    assert.deepStrictEqual(known, [r1, r2].sort());
  } finally { if (prev === undefined) delete process.env.TYCON_REPOS_ROOT; else process.env.TYCON_REPOS_ROOT = prev; }
  // the rest go through the same helper: they ask for `roots`, never only `root`
  for (const f of ['scripts/metrics/collect-findings.js', 'scripts/lib/harness-audit.js', 'scripts/hooks/retro-pending.js',
    'scripts/lib/engram-autoheal.js', 'scripts/setup/engram-rescue-unexported.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.match(src, /resolveReposRoot\([^)]*\)\.roots|\.roots\b/, f);
  }
});

test('T14 Raices_SinRuido @story-2.67 @ac-9: un repo suelto no es otra raíz, una carpeta dentro de otra no se repite y `set` guarda la lista', () => {
  const R = RR.__test.rutasDe('linux');
  // three repos in ~/S and one stray repo on the Desktop: one root, not two
  const repos = ['/home/dev/S/a', '/home/dev/S/b', '/home/dev/S/c', '/home/dev/Desktop/P/x'];
  assert.deepStrictEqual(RR.__test.raicesPorMayoria(repos, '/home/dev', R).map((x) => x.root), ['/home/dev/S']);
  // a folder inside another one of the list, and a repeated one, are dropped
  const home = tmp('rr-home-');
  const a = tmp('rr-a-');
  const env = { TYCON_REPOS_ROOT: [a, path.join(a, 'adentro'), a].join(path.delimiter) };
  assert.deepStrictEqual(RR.resolveReposRoot(undefined, { home, env, ...noConfig }).roots, [a]);
  // `set paths.repos a<delimiter>b` writes a list, which reads back as two roots
  const b = tmp('rr-b-');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'lib', 'tycon-config.js'), 'set', 'paths.repos', [a, b].join(path.delimiter)],
    { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: 'pipe' });
  const r = RR.resolveReposRoot(undefined, { home, env: {} });
  assert.deepStrictEqual(r.roots, [a, b], JSON.stringify(r));
});
