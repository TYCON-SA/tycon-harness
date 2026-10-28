'use strict';

/**
 * packs-per-repo.test.js — ningún repo pierde un revisor cuando los revisores cambian de lugar (T34).
 *
 * Qué sostiene: `package-equivalence.js per-repo` calcula, para cada repo, el set de revisores sobre sus commits recientes
 * con dos árboles (el de antes y el del cambio) y sale en rojo si algún repo pierde un revisor o declara en `packs:` un
 * paquete que la organización no activó. Los casos de laboratorio arman los dos árboles con el pipeline de esta copia y
 * paquetes de juguete. La medición sobre los repos reales de la máquina corre con `PACKS_PER_REPO_REAL=1` (la deja en el
 * archivo que diga `PACKS_PER_REPO_OUT`); sin la variable dice «no medido», nunca verde.
 *
 * stable-data: los commits de juguete llevan la fecha de hoy a propósito (`git log --since=<N>.days` compara contra el
 * reloj de git, que no se inyecta); los commits fijan esa fecha y apagan el mantenimiento automático.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'package-equivalence.js');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const W = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };

/** Un árbol del arnés de laboratorio: el pipeline de esta copia, sus agentes del núcleo y los paquetes que se pasen. */
function arbol(paquetes) {
  const d = tmp('ppr-arbol-');
  fs.cpSync(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts'), path.join(d, 'skills', 'tycon-pipeline', 'scripts'), { recursive: true, filter: (s) => !s.includes(`${path.sep}tests${path.sep}`) });
  fs.cpSync(path.join(ROOT, 'agents'), path.join(d, 'agents'), { recursive: true });
  for (const [nombre, revisores] of Object.entries(paquetes)) {
    for (const a of revisores) W(path.join(d, 'packs', nombre, 'agents', `${a}.md`), `# ${a}\n`);
    W(path.join(d, 'packs', nombre, 'pack.json'), JSON.stringify({
      name: nombre, description: nombre, agents: 'agents',
      reviewers: revisores.map((a) => ({ agent: a, group: 'base', when: { detection: 'csModified' }, surface: { paths: ['**/*.cs'] }, depth: 'standard', prefixes: [a.replace(/[^a-z]/g, '').toUpperCase().slice(0, 6) || 'X'] })),
    }, null, 2));
  }
  return d;
}

/** Un repo de juguete con un commit que toca un `.cs` (y su `.tycon/advisors.yaml`, si se pasa). */
function repo(yaml) {
  const d = tmp('ppr-repo-');
  // la fecha es la de hoy a propósito (la medición mira los commits de los últimos días), fijada al armar el repo
  const hoy = new Date().toISOString();   // stable-data: `git log --since=<N>.days` compara contra el reloj de git, no hay fecha que inyectarle
  const g = (...a) => spawnSync('git', ['-C', d, '-c', 'user.email=b@b', '-c', 'user.name=b', '-c', 'maintenance.auto=false', ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: hoy, GIT_COMMITTER_DATE: hoy } });
  g('init', '-q', '-b', 'main', '.');
  W(path.join(d, 'README.md'), 'x\n');
  if (yaml) W(path.join(d, '.tycon', 'advisors.yaml'), yaml);
  g('add', '-A'); g('commit', '-q', '-m', 'base');
  W(path.join(d, 'src', 'A.cs'), 'class A {}\n');
  g('add', '-A'); g('commit', '-q', '-m', 'código');
  return d;
}

function correr({ viejo, nuevo, repos, valor = 'all' }) {
  const perfil = path.join(tmp('ppr-perfil-'), 'team-profile.json');
  W(perfil, JSON.stringify({ packs: { default: valor } }));
  const out = path.join(tmp('ppr-out-'), 'medicion.md');
  const r = spawnSync(process.execPath, [SCRIPT, 'per-repo', '--old-tree', viejo, '--new-tree', nuevo, '--repos', repos.join(','), '--since', '30', '--profile', perfil, '--out', out],
    { encoding: 'utf8', timeout: 300000, env: { PATH: process.env.PATH, HOME: tmp('ppr-home-'), LANG: 'en_US.UTF-8' } });
  return { status: r.status, stderr: r.stderr, md: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '' };
}

test('PacksPerRepo_TwoRepoFolders_WalksBoth', () => {
  // two folders of repos in the variable, as in the PATH: the repos of both are measured
  const arbolDos = arbol({ prueba: ['rev-uno'] });
  const una = tmp('ppr-raiz-'); const otra = tmp('ppr-raiz-');
  const r1 = repo(null); const r2 = repo(null);
  fs.renameSync(r1, path.join(una, 'uno')); fs.renameSync(r2, path.join(otra, 'dos'));
  const perfil = path.join(tmp('ppr-perfil-'), 'team-profile.json');
  W(perfil, JSON.stringify({ packs: { default: 'all' } }));
  const out = path.join(tmp('ppr-out-'), 'medicion.md');
  const r = spawnSync(process.execPath, [SCRIPT, 'per-repo', '--old-tree', arbolDos, '--new-tree', arbolDos, '--since', '30', '--profile', perfil, '--out', out],
    { encoding: 'utf8', timeout: 300000, env: { PATH: process.env.PATH, HOME: tmp('ppr-home-'), LANG: 'en_US.UTF-8', TYCON_REPOS_ROOT: [una, otra].join(path.delimiter) } });
  const md = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  assert.equal(r.status, 0, r.stderr + md);
  assert.match(md, /\(2\), commits/, md);
  assert.ok(md.includes('uno') && md.includes('dos'), md);
});

test('PacksPerRepo_NoRepoLosesReviewer', (t) => {
  const conDos = arbol({ prueba: ['rev-uno', 'rev-dos'] });
  const r1 = repo(null);
  const r2 = repo('packs: [prueba]\n');

  // los mismos revisores, en el mismo lugar: verde
  const igual = correr({ viejo: conDos, nuevo: arbol({ prueba: ['rev-uno', 'rev-dos'] }), repos: [r1, r2] });
  assert.equal(igual.status, 0, igual.stderr + igual.md);
  assert.match(igual.md, /0 repos pierden un revisor/);

  // un revisor que cambia de paquete (los dos activos): verde, el set no cambia
  const mudado = correr({ viejo: conDos, nuevo: arbol({ prueba: ['rev-uno'], otro: ['rev-dos'] }), repos: [r1] });
  assert.equal(mudado.status, 0, mudado.stderr + mudado.md);

  // el árbol nuevo pierde un revisor: rojo, y nombra el repo y el revisor
  const pierde = correr({ viejo: conDos, nuevo: arbol({ prueba: ['rev-uno'] }), repos: [r1] });
  assert.equal(pierde.status, 1, pierde.stderr + pierde.md);
  assert.ok(pierde.md.includes(path.basename(r1)), pierde.md);
  assert.match(pierde.md, /rev-dos/);

  // un repo que declara un paquete que la organización no activó: rojo, y dice qué paquete
  const dosPaquetes = arbol({ prueba: ['rev-uno'], otro: ['rev-dos'] });
  const noActivo = correr({ viejo: dosPaquetes, nuevo: dosPaquetes, repos: [r2], valor: ['otro'] });
  assert.equal(noActivo.status, 1, noActivo.stderr + noActivo.md);
  assert.match(noActivo.md, /prueba/);
  assert.match(noActivo.md, /no activó|no está activo/);

  // sin ningún commit medido (repos sin commits en la ventana, o ningún repo): «no medido», nunca verde
  const viejo = tmp('ppr-viejo-');
  const g = (...a) => spawnSync('git', ['-C', viejo, '-c', 'user.email=b@b', '-c', 'user.name=b', '-c', 'maintenance.auto=false', ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' } });
  g('init', '-q', '-b', 'main', '.'); W(path.join(viejo, 'A.cs'), 'class A {}\n'); g('add', '-A'); g('commit', '-q', '-m', 'viejo');
  const nada = correr({ viejo: conDos, nuevo: conDos, repos: [viejo] });
  assert.equal(nada.status, 2, nada.stderr + nada.md);
  assert.match(nada.md, /NO MEDIDO/);
  assert.doesNotMatch(nada.md, /✅/);

  // los repos reales de la máquina: sólo a pedido (es lenta) — sin la variable, «no medido»
  if (process.env.PACKS_PER_REPO_REAL !== '1') { t.diagnostic('repos reales: NO MEDIDO (PACKS_PER_REPO_REAL=1 los mide)'); return; }
  const out = process.env.PACKS_PER_REPO_OUT || path.join(tmp('ppr-real-'), 'medicion.md');
  const real = spawnSync(process.execPath, [SCRIPT, 'per-repo', '--base', process.env.PACKS_PER_REPO_BASE || 'origin/main', '--since', '30', '--out', out, ...(process.env.PACKS_PER_REPO_PROFILE ? ['--profile', process.env.PACKS_PER_REPO_PROFILE] : [])],
    { encoding: 'utf8', timeout: 3600000, env: process.env });
  assert.equal(real.status, 0, `${real.stderr}\n${fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : ''}`);
});
