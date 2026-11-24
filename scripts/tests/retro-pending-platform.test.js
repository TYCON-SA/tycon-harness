'use strict';
// retro-pending-platform.test.js — un repo de una plataforma declarada por la capa (no Azure DevOps ni GitHub) hace el
// ciclo del merge: el skill de merge la nombra por la capa, el reclamo de la retrospectiva anota su pedido con la
// identidad que da la capa y, cuando el pedido entra, reclama el commit que dejó en main.
//
// La plataforma de estas pruebas es la de GitLab, porque es la que tiene conector además de las dos de siempre; el código
// que se prueba no la nombra. Las pruebas de Azure y GitHub (retro-pending-punta, -correct, -harness-repos, merge-pr)
// siguen corriendo sin cambios en sus aserciones (T8).
//
// stable-data: no toca la red; repos de juguete con git de verdad, una copia del gancho y scripts/tests/lib/fake-glab.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const FAKE_GLAB = path.join(ROOT, 'scripts', 'tests', 'lib', 'fake-glab.js');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p = 'retro-plat-') => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); dirs.push(d); return d; };

const HOST = 'gitlab.example.com';
const GL = { platform: 'gitlab', host: HOST, namespace: 'producto/plataforma', repo: 'servicio' };
const PROYECTO = 'producto/plataforma/servicio';
const ORIGEN_GL = `https://${HOST}/${PROYECTO}.git`;
const github = (repo) => ({ platform: 'github', org: 'acme', repo });
const teamDoc = () => ({ version: 1, public: github('arnes'), profile: github('perfil'), operations: github('operaciones'),
  merge_suites: { repos: [{ repo: GL, rule: 'automatico' }] } });

/** Un árbol con team-repos.json (el repo de GitLab declarado), las integraciones y el estado del glab de mentira. */
function mundo(estado = {}) {
  const tree = tmp('arbol-');
  const ints = tmp('plataformas-');
  for (const n of ['gitlab', 'github', 'azure-devops']) fs.cpSync(path.join(ROOT, 'integrations', n), path.join(ints, n), { recursive: true });
  fs.writeFileSync(path.join(tree, 'team-profile.json'), JSON.stringify({}));
  fs.writeFileSync(path.join(tree, 'team-repos.json'), JSON.stringify(teamDoc()));
  const state = path.join(tmp('glab-'), 'estado.json');
  fs.writeFileSync(state, JSON.stringify(estado));
  return { tree, ints, state };
}

function env(home, m) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(GIT_|TYCON_|BUILD_|SYSTEM_|TF_BUILD|CLAUDE_|FAKE_GLAB)/.test(k)) e[k] = v;
  return { ...e, HOME: home, USERPROFILE: home, TYCON_RETRO_LAB_DIRS: '', TYCON_RETRO_ASK_REMOTE: '0', TYCON_RETRO_GATE_FOREIGN_MAX_AGE_DAYS: '100000',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'sin-global'),
    GIT_AUTHOR_NAME: 'Lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'Lab', GIT_COMMITTER_EMAIL: 'lab@example.com',
    ...(m ? { TYCON_TREE: m.tree, TYCON_HOME: path.join(home, '.tycon'), TYCON_INTEGRATIONS_DIR: m.ints, TYCON_GLAB_CMD: FAKE_GLAB, FAKE_GLAB_STATE: m.state } : {}) };
}
function git(dir, args) {
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', dir, ...args], { env: env(os.tmpdir()), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function commit(dir, nombre) {
  fs.writeFileSync(path.join(dir, nombre), `${nombre}\n`);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', nombre]);
  return git(dir, ['rev-parse', 'HEAD']);
}

/** Un repo bajo el arnés con `origin` en `origen`, `main` y una rama `dev` con un commit más. */
function repo(origen) {
  const dir = path.join(tmp(), 'servicio');
  fs.mkdirSync(dir);
  git(dir, ['init', '--quiet', '-b', 'main']);
  fs.mkdirSync(path.join(dir, '.tycon'));
  fs.writeFileSync(path.join(dir, '.tycon', 'advisors.yaml'), '');
  commit(dir, 'base.txt');
  git(dir, ['remote', 'add', 'origin', origen]);
  git(dir, ['checkout', '--quiet', '-b', 'dev']);
  const punta = commit(dir, 'cambio.txt');
  git(dir, ['checkout', '--quiet', 'main']);
  return { dir, punta };
}

/** Una copia del gancho con sus bibliotecas y un HOME propio: el registro es el de esta prueba. */
function laboratorio(m) {
  const base = tmp();
  const home = path.join(base, 'home');
  const arnes = path.join(base, 'arnes');
  fs.mkdirSync(path.join(home, '.claude', '.tycon-pipeline'), { recursive: true });
  fs.mkdirSync(path.join(arnes, 'scripts', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(arnes, '.dashboard'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'hooks', 'retro-pending.js'), path.join(arnes, 'scripts', 'hooks', 'retro-pending.js'));
  fs.cpSync(path.join(ROOT, 'scripts', 'lib'), path.join(arnes, 'scripts', 'lib'), { recursive: true });
  const ledger = path.join(home, '.claude', '.tycon-pipeline', 'retro-pending.jsonl');
  const correr = (evento) => {
    const r = spawnSync(process.execPath, [path.join(arnes, 'scripts', 'hooks', 'retro-pending.js')], { input: JSON.stringify(evento), env: env(home, m), encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return {
    pedido: (command, cwd, salida) => correr({ session_id: 's1', tool_name: 'Bash', tool_input: { command }, cwd, tool_response: { stdout: salida } }),
    cierre: (cwd) => correr({ session_id: 's1', hook_event_name: 'Stop', stop_hook_active: false, cwd }),
    renglones: () => (fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}

const ABRIR = `node scripts/lib/platform/platform.js change-request open --repo '${JSON.stringify(GL)}' --args '{"targetBranch":"main","sourceBranch":"dev"}'`;
const RESPUESTA = (id) => JSON.stringify({ ok: true, value: { id, url: `https://${HOST}/${PROYECTO}/-/merge_requests/${id}` } });

// ── el skill de merge ────────────────────────────────────────────────────────────────────────────────────────────────

test('T1 MergeSkill_NombraLaCapa', () => {
  const lineas = fs.readFileSync(path.join(ROOT, 'skills', 'tycon-merge-to-main', 'SKILL.md'), 'utf8').split('\n');
  const modo = lineas.find((l) => l.startsWith('| `mode` |'));
  const paso9b = lineas.find((l) => /^9b\. \*\*step-09b/.test(l));
  assert.ok(modo && paso9b, 'el SKILL.md trae el renglón del modo y el del paso 9b');
  assert.match(modo, /host: platform/, 'el modo pr nombra la plataforma por la capa');
  assert.match(paso9b, /host: platform/, 'el paso 9b nombra la plataforma por la capa');
  assert.deepStrictEqual(lineas.filter((l) => /gitlab|glab/i.test(l)), [], 'el núcleo no nombra GitLab');
});

// ── el pedido anotado y su entrada ───────────────────────────────────────────────────────────────────────────────────

test('T2 RetroPending_GitlabEsperando', () => {
  const m = mundo();
  const { dir, punta } = repo(ORIGEN_GL);
  const lab = laboratorio(m);
  const r = lab.pedido(ABRIR, dir, RESPUESTA(7));
  assert.match(r.stderr, /pedido 7 a main anotado .*queda esperando que entre/, 'el gancho dice que lo anotó');
  const [e, otra] = lab.renglones();
  assert.ok(e, `el pedido deja su entrada (${r.stderr.trim()})`);
  assert.strictEqual(otra, undefined);
  assert.deepStrictEqual([e.repoPath, e.sha, e.pr, e.plataforma, e.estado], [dir, punta.slice(0, 12), 7, 'gitlab', 'esperando']);
});

test('T3 RetroPending_GitlabEntra', () => {
  const { dir } = repo(ORIGEN_GL);
  // el pedido entra: el commit de la fusión queda en la línea de main
  git(dir, ['merge', '--quiet', '--no-ff', '-m', 'fusion del pedido 7', 'dev']);
  const merge = git(dir, ['rev-parse', 'HEAD']);
  const m = mundo({ mrs: { [PROYECTO]: [{ iid: 7, state: 'merged', title: 'pedido 7', source_branch: 'dev', target_branch: 'main', sha: 'a'.repeat(40),
    author: 'ana', merged_at: '2026-11-24T10:00:00Z', merge_commit_sha: merge }] } });
  git(dir, ['checkout', '--quiet', 'dev']);
  const lab = laboratorio(m);
  lab.pedido(ABRIR, dir, RESPUESTA(7));
  assert.strictEqual(lab.renglones()[0].estado, 'esperando', 'el pedido queda esperando');
  const r = lab.cierre(dir);
  const pedido = lab.renglones().find((x) => x.tipo === 'pedido');
  assert.ok(pedido, `el cierre le preguntó a la capa y anotó lo que supo (${r.stdout}${r.stderr})`);
  assert.deepStrictEqual([pedido.pr, pedido.estado, pedido.merge], [7, 'entro', merge.slice(0, 12)]);
  // el reclamo nombra el commit de la fusión, que está en la línea de main: es el que el latido acepta
  assert.match(r.stdout + r.stderr, new RegExp(`--merge ${merge.slice(0, 12)}`), 'el reclamo pide el latido del commit de la fusión');
  assert.ok(git(dir, ['rev-list', '--first-parent', 'main']).split('\n').includes(merge));
});

// ── la identidad del repo ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `identidadParaLaCapa` del gancho, cargado con `require` en un proceso aparte (con la entrada cerrada: un gancho que
 * corriera su `main` al cargarse no cuelga la prueba) y con el árbol y las integraciones de `m` en su entorno.
 */
function identidad(dir, m, gancho = path.join(ROOT, 'scripts', 'hooks', 'retro-pending.js')) {
  const programa = `const f = require(${JSON.stringify(gancho)}).identidadParaLaCapa;
    process.stdout.write(JSON.stringify(typeof f === 'function' ? f(${JSON.stringify(dir)}) : { sinFuncion: true }));`;
  const r = spawnSync(process.execPath, ['-e', programa], { env: env(tmp('casa-'), m), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  assert.strictEqual(r.status, 0, r.stderr);
  const d = JSON.parse(r.stdout || '{}');
  assert.ok(!d.sinFuncion, 'el gancho exporta identidadParaLaCapa');
  return d;
}

test('T4 RetroPending_IdentidadPorLaCapa', () => {
  const m = mundo();
  assert.deepStrictEqual(identidad(repo(ORIGEN_GL).dir, m), { valor: GL });
  // la de Azure y la de GitHub, como las armaba el gancho antes de la capa (la ruta del origin sin mayúsculas)
  assert.deepStrictEqual(identidad(repo('https://dev.azure.com/acme/Prod/_git/producto').dir, m),
    { valor: { platform: 'azure', org: 'acme', project: 'prod', repo: 'producto' } });
  assert.deepStrictEqual(identidad(repo('git@github.com:acme/producto.git').dir, m), { valor: { platform: 'github', org: 'acme', repo: 'producto' } });
});

test('T5 RetroPending_OriginSinPlataforma', () => {
  const m = mundo();
  const r = identidad(repo('https://git.otro-servidor.example/equipo/servicio.git').dir, m);
  assert.strictEqual(r.valor, undefined, 'no inventa una identidad');
  assert.match(r.problema, /no sé en qué plataforma vive/);
});

/** Una copia del gancho con sus bibliotecas menos la capa de plataforma: `require` de la capa falla. */
function ganchoSinCapa() {
  const arnes = tmp('sin-capa-');
  fs.mkdirSync(path.join(arnes, 'scripts', 'hooks'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'hooks', 'retro-pending.js'), path.join(arnes, 'scripts', 'hooks', 'retro-pending.js'));
  const lib = path.join(ROOT, 'scripts', 'lib');
  fs.cpSync(lib, path.join(arnes, 'scripts', 'lib'), { recursive: true, filter: (src) => path.relative(lib, src).split(path.sep)[0] !== 'platform' });
  return path.join(arnes, 'scripts', 'hooks', 'retro-pending.js');
}

test('T9 RetroPending_SinCapaAzureGithubIgual', () => {
  const m = mundo();
  const gancho = ganchoSinCapa();
  // Azure y GitHub no dependen de la capa: la misma identidad que en T4
  assert.deepStrictEqual(identidad(repo('https://dev.azure.com/acme/Prod/_git/producto').dir, m, gancho),
    { valor: { platform: 'azure', org: 'acme', project: 'prod', repo: 'producto' } });
  assert.deepStrictEqual(identidad(repo('git@github.com:acme/producto.git').dir, m, gancho), { valor: { platform: 'github', org: 'acme', repo: 'producto' } });
  // otro servidor sí la necesita, y lo dice
  const r = identidad(repo(ORIGEN_GL).dir, m, gancho);
  assert.strictEqual(r.valor, undefined, 'no inventa una identidad');
  assert.match(r.problema, /no pude cargar la capa de plataforma/);
});
