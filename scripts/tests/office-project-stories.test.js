'use strict';
/*
 * office-project-stories.test.js — la lectura de fondo de los pendientes de cada proyecto, y cómo los muestra la oficina.
 *
 * Arma repos de git de verdad en carpetas temporales (con su remoto escrito, sin red) y una casa de juguete con
 * conversaciones de Claude y de Codex. Lo que no se puede armar con git de verdad (lo que la lectura le pide a git) va
 * con un git de juguete que anota cada pedido.
 *
 * stable-data: las conversaciones, los commits propios y los FETCH_HEAD se fechan con el reloj real a propósito: la
 * lectura mira los últimos 7 días y las horas por la fecha de los archivos, contra el reloj de la máquina. Ninguna
 * afirmación compara una fecha fija.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PS = require(path.join(ROOT, 'scripts', 'tools', 'office', 'project-stories.js'));
const SWB = require(path.join(ROOT, 'skills', 'tycon-create-story', 'scripts', 'story-without-bmad.js'));

const DIA = 24 * 3600 * 1000;
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `pendientes-${p}-`)));
const EMAIL = 'ana@acme.example';

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'user.email=' + EMAIL, '-c', 'user.name=Ana', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Una historia: su encabezado, con lo que se le pase. */
function historia(id, estado, extra = {}) {
  const campos = { story: `"${id}"`, title: `"La historia ${id}"`, status: estado, ...extra };
  return `---\n${Object.entries(campos).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n# Story ${id}\n`;
}

/**
 * Un repo con sus archivos commiteados, su remoto (sin red) y, si se pide, su rama `origin/main` como si se hubiera
 * traído. `autor`: el correo de los commits.
 */
function repo(padre, nombre, { remoto, archivos = {}, traida = true, autor = EMAIL, fecha = null } = {}) {
  const d = path.join(padre, nombre);
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q');
  for (const [rel, txt] of Object.entries(archivos)) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), txt);
  }
  fs.writeFileSync(path.join(d, 'LEEME.md'), nombre);
  git(d, 'add', '-A');
  const env = fecha ? { GIT_AUTHOR_DATE: fecha, GIT_COMMITTER_DATE: fecha } : {};
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', `user.email=${autor}`, '-c', 'user.name=Alguien', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'inicio'], { cwd: d, encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(r.stderr);
  if (remoto) git(d, 'remote', 'add', 'origin', remoto);
  if (traida) git(d, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return d;
}

/** Una casa de juguete con conversaciones: `[{ cwd, como, dias }]` (Claude por defecto; `codex: true`, de Codex). */
function casa(sesiones = [], ahora = Date.now()) {
  const h = tmp('casa');
  sesiones.forEach((s, i) => {
    const dir = s.codex ? path.join(h, '.codex', 'sessions', '2026', '11', '08') : path.join(h, '.claude', 'projects', `p${i}`);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `s${i}.jsonl`);
    const linea = s.codex ? { payload: { cwd: s.cwd, originator: s.como || 'codex-tui' } } : { cwd: s.cwd, entrypoint: s.como || 'cli' };
    fs.writeFileSync(f, `${JSON.stringify(linea)}\n`);
    const t = (ahora - (s.dias || 0) * DIA) / 1000;
    fs.utimesSync(f, t, t);
  });
  return h;
}

const base = (extra = {}) => ({ email: EMAIL, roots: [], products: [], env: {}, ...extra });

test('T1 Projects_SessionOrOwnCommit_NotTheClone @story-8.185 @ac-1 — una sesión o un commit propio; el clon solo, un commit ajeno o una sesión vieja no', () => {
  const raiz = tmp('raiz');
  const conSesion = repo(raiz, 'con-sesion', { remoto: 'https://github.com/acme/con-sesion.git' });
  const conCommit = repo(raiz, 'con-commit', { remoto: 'https://github.com/acme/con-commit.git' });
  const ajeno = repo(raiz, 'ajeno', { remoto: 'https://github.com/acme/ajeno.git', autor: 'otro@acme.example' });
  repo(raiz, 'clon-solo', { remoto: 'https://github.com/acme/clon-solo.git', autor: 'otro@acme.example' });
  const viejo = repo(raiz, 'viejo', { remoto: 'https://github.com/acme/viejo.git', autor: 'otro@acme.example' });
  // un worktree del repo con sesión: es el mismo repo
  const wt = path.join(raiz, 'con-sesion--wt');
  git(conSesion, 'worktree', 'add', '-q', '-b', 'otra', wt);
  const h = casa([{ cwd: conSesion }, { cwd: wt }, { cwd: viejo, dias: 8 }, { cwd: ajeno, dias: 9 }]);
  const p = PS.projectsOf(base({ home: h, roots: [raiz] }));
  const nombres = p.repos.map((r) => path.basename(r.root)).sort();
  assert.deepStrictEqual(nombres, ['con-commit', 'con-sesion'], `sólo la sesión de la semana y el commit propio: ${nombres}`);
  assert.strictEqual(p.ownCommits.medido, true);
  assert.ok(conCommit && ajeno);
});

test('T2 Projects_AutomaticRunsDoNotCount @story-8.185 @ac-1 — sdk-cli y codex_exec no cuentan; cli y codex-tui sí', () => {
  const raiz = tmp('raiz');
  const r = {};
  for (const n of ['sdk', 'exec', 'cli', 'tui']) r[n] = repo(raiz, n, { remoto: `https://github.com/acme/${n}.git`, autor: 'otro@acme.example' });
  const h = casa([{ cwd: r.sdk, como: 'sdk-cli' }, { cwd: r.exec, como: 'codex_exec', codex: true }, { cwd: r.cli, como: 'cli' }, { cwd: r.tui, como: 'codex-tui', codex: true }]);
  const p = PS.projectsOf(base({ home: h }));
  assert.deepStrictEqual(p.repos.map((x) => path.basename(x.root)).sort(), ['cli', 'tui']);
  assert.strictEqual(PS.WORK_DAYS, 7, 'los 7 días están en un solo lugar');
});

test('T3 Stories_FromWhatTheHarnessDeclares @story-8.185 @ac-2 @ac-3 — la carpeta propia, el hermano, lo declarado, la de BMAD, el compañero al revés, y el aviso', () => {
  const raiz = tmp('raiz');
  // un repo con sus historias y un compañero declarado con otras
  repo(raiz, 'hermano', { remoto: 'https://github.com/acme/hermano.git', archivos: { 'specs/s.md': historia('3.1', 'review') } });
  const propio = repo(raiz, 'propio', { remoto: 'https://github.com/acme/propio.git', archivos: { 'specs/s.md': historia('2.1', 'in-progress'), '.tycon/advisors.yaml': 'evidence:\n  companion_repos:\n    - ../hermano\n' } });
  let r = SWB.projectStoryPlaces(propio);
  assert.strictEqual(r.problem, null);
  assert.deepStrictEqual(r.places.map((x) => path.basename(x.repo)), ['propio', 'hermano'], 'la carpeta propia primero y el hermano después');
  // todas sus historias 1.N: projectStoryPlaces da la carpeta; storyPlaces sigue como antes (sin la propia)
  const primeras = repo(raiz, 'primeras', { remoto: 'https://github.com/acme/primeras.git', archivos: { 'specs/a.md': historia('1.1', 'ready-for-dev'), 'specs/b.md': historia('1.2', 'review') } });
  assert.deepStrictEqual(SWB.projectStoryPlaces(primeras).places.map((x) => path.basename(x.repo)), ['primeras']);
  assert.deepStrictEqual(SWB.storyPlaces(primeras).places, [], 'storyPlaces no cambia: con todas 1.N no suma la propia');
  // lo declarado en stories.repo
  const historias = repo(raiz, 'historias', { remoto: 'https://github.com/acme/historias.git', archivos: { 'specs/x.md': historia('7.1', 'ready-for-dev') } });
  const back = repo(raiz, 'back', { remoto: 'https://github.com/acme/back.git', archivos: { '.tycon/advisors.yaml': 'stories:\n  repo: ../historias\n' } });
  assert.deepStrictEqual(SWB.projectStoryPlaces(back).places.map((x) => path.basename(x.repo)), ['historias']);
  assert.ok(historias);
  // la carpeta de BMAD, sin specs/
  const bmad = repo(raiz, 'bmad', { remoto: 'https://github.com/acme/bmad.git', archivos: { '_bmad/bmm/config.yaml': 'implementation_artifacts: "{project-root}/_bmad-output/stories"\n', '_bmad-output/stories/a.md': historia('4.2', 'in-progress') } });
  const pb = SWB.projectStoryPlaces(bmad).places;
  assert.strictEqual(pb.length, 1);
  assert.strictEqual(path.relative(bmad, pb[0].dir), path.join('_bmad-output', 'stories'), 'la carpeta que declara BMAD manda');
  // el compañero al revés: el público no declara nada; el privado trabajado lo nombra en companion_repos
  const publico = repo(raiz, 'publico', { remoto: 'https://github.com/acme/publico.git' });
  const privado = repo(raiz, 'privado', { remoto: 'https://github.com/acme/privado.git', archivos: { 'specs/p.md': historia('8.1', 'ready-for-dev'), '.tycon/advisors.yaml': 'evidence:\n  companion_repos:\n    - ../publico\n' } });
  const lugares = PS.placesFor(publico, [{ root: publico }, { root: privado }]);
  assert.deepStrictEqual(lugares.places.map((x) => path.basename(x.repo)), ['privado'], 'el público toma las historias del que lo nombra');
  // sin nada: sin lugares, y la lectura entera lo avisa
  const nada = repo(raiz, 'nada', { remoto: 'https://github.com/acme/nada.git' });
  assert.deepStrictEqual(PS.placesFor(nada, [{ root: nada }]).places, []);
  const h = casa([{ cwd: nada }, { cwd: propio }]);
  const out = PS.collect(base({ home: h, now: Date.now() }));
  assert.deepStrictEqual(out.sinHistorias, ['nada'], 'el aviso nombra el repo sin historias');
});

test('T4 Stories_NotFoundByFileNameAnywhere @story-8.185 @ac-2 — una carpeta no declarada con archivos parecidos no se lee', () => {
  const raiz = tmp('raiz');
  const r = repo(raiz, 'r', { remoto: 'https://github.com/acme/r.git', archivos: { 'docs/story-1.1-algo.md': historia('9.9', 'ready-for-dev'), 'notas/story-2.md': historia('9.8', 'review') } });
  assert.deepStrictEqual(SWB.projectStoryPlaces(r).places, []);
  const out = PS.collect(base({ home: casa([{ cwd: r }]) }));
  assert.deepStrictEqual(out.proyectos, []);
  assert.deepStrictEqual(out.sinHistorias, ['r']);
});

test('T5 Products_OneRowForSharedStories @story-8.185 @ac-4 — el backend y los formularios con el mismo repo de historias, y dos worktrees: una fila', () => {
  const raiz = tmp('raiz');
  const hist = repo(raiz, 'historias', { remoto: 'https://github.com/acme/historias.git', archivos: { '_bmad/bmm/config.yaml': 'implementation_artifacts: "{project-root}/specs"\n', 'specs/a.md': historia('5.1', 'ready-for-dev') } });
  const wt = path.join(raiz, 'historias--wt');
  git(hist, 'worktree', 'add', '-q', '-b', 'otra', wt);
  const back = repo(raiz, 'back', { remoto: 'https://github.com/acme/back.git', archivos: { '.tycon/advisors.yaml': 'stories:\n  repo: ../historias\n' } });
  const forms = repo(raiz, 'forms', { remoto: 'https://github.com/acme/forms.git', archivos: { '.tycon/advisors.yaml': 'stories:\n  repo: ../historias\n' } });
  const h = casa([{ cwd: back }, { cwd: forms }, { cwd: hist }, { cwd: wt }]);
  let out = PS.collect(base({ home: h }));
  assert.strictEqual(out.proyectos.length, 1, `una sola fila: ${out.proyectos.map((p) => p.nombre)}`);
  assert.strictEqual(out.proyectos[0].nombre, 'historias', 'sin lista de productos, el nombre del repo de historias');
  out = PS.collect(base({ home: h, products: [{ producto: 'Acme', github: 'acme/historias' }] }));
  assert.strictEqual(out.proyectos.length, 1);
  assert.strictEqual(out.proyectos[0].nombre, 'Acme', 'con la lista, el nombre del producto');
});

test('T6 Status_FromVocabulary_WithAliases @story-8.185 @ac-5 — en curso, en revisión, lista y el alias; no las cerradas ni los borradores', () => {
  const raiz = tmp('raiz');
  const estados = { a: 'in-progress', b: 'review', c: 'ready-for-dev', d: 'approved', e: 'done', f: 'draft', g: 'blocked' };
  const archivos = Object.fromEntries(Object.entries(estados).map(([k, v], i) => [`specs/${k}.md`, historia(`6.${i + 1}`, v)]));
  const r = repo(raiz, 'r', { remoto: 'https://github.com/acme/r.git', archivos });
  const out = PS.collect(base({ home: casa([{ cwd: r }]) }));
  assert.deepStrictEqual(out.proyectos[0].historias.map((x) => x.id).sort(), ['6.1', '6.2', '6.3', '6.4']);
  assert.strictEqual(out.proyectos[0].historias.find((x) => x.id === '6.4').estado, 'ready-for-dev', 'el alias, por su canónico');
  assert.ok(!/['"]in-progress['"]|['"]review['"]/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'tools', 'office', 'project-stories.js'), 'utf8')), 'el grupo «en curso» sale del vocabulario, no del código');
});

test('T7 BadHeader_CountedNotShown @story-8.185 @ac-6 — sin encabezado o con un estado raro: no entran y la fila las cuenta', () => {
  const raiz = tmp('raiz');
  const r = repo(raiz, 'r', { remoto: 'https://github.com/acme/r.git', archivos: { 'specs/bien.md': historia('7.1', 'review'), 'specs/raro.md': historia('7.2', 'a-medias'), 'specs/sin.md': '---\nstory: "7.3"\ntitle: sin estado\n' } });
  const p = PS.collect(base({ home: casa([{ cwd: r }]) })).proyectos[0];
  assert.deepStrictEqual(p.historias.map((x) => x.id), ['7.1']);
  assert.strictEqual(p.sinLeer, 2);
});

/** Una carpeta de estado con ejecuciones: `active` y cierres de `timing-history` (con su fecha de archivo). */
function estadoConEjecuciones({ activas = [], cierres = [] } = {}, ahora = Date.now()) {
  const e = tmp('estado');
  fs.mkdirSync(path.join(e, 'active'), { recursive: true });
  fs.mkdirSync(path.join(e, 'timing-history'), { recursive: true });
  activas.forEach((m, i) => fs.writeFileSync(path.join(e, 'active', `${m.sessionId || `s${i}`}.json`), JSON.stringify(m)));
  cierres.forEach((c, i) => {
    const f = path.join(e, 'timing-history', `c${i}.json`);
    fs.writeFileSync(f, JSON.stringify({ archivedAt: new Date(ahora - c.horas * 3600e3).toISOString(), marker: c.marker }));
    const t = (ahora - c.horas * 3600e3) / 1000;
    fs.utimesSync(f, t, t);
  });
  return e;
}

test('T8 Run_NoExtraCard @story-8.185 @ac-7 — viva, dejada o cerrada esperando entrar: tiene ejecución; la de 30 h y la sin ejecución, no', () => {
  const ahora = Date.now();
  const e = estadoConEjecuciones({
    activas: [{ sessionId: 'viva', storyPath: '/x/specs/story-8.1-viva.md', storyId: '8.1' }, { sessionId: 'dejada', storyPath: '/x/specs/story-8.2-dejada.md', storyId: '8.2' }],
    cierres: [
      { horas: 2, marker: { sessionId: 'misma', storyPath: '/y/specs/story-8.3-una.md', storyId: '8.3' } },
      { horas: 3, marker: { sessionId: 'misma', storyPath: '/y/specs/story-8.4-otra.md', storyId: '8.4' } },
      { horas: 30, marker: { sessionId: 'vieja', storyPath: '/y/specs/story-8.5-vieja.md', storyId: '8.5' } },
    ],
  }, ahora);
  const runs = PS.runsOfThisMachine({ stateDir: e, now: ahora });
  const con = (archivo) => Boolean(PS.runOf({ archivo }, runs));
  assert.deepStrictEqual(['story-8.1-viva.md', 'story-8.2-dejada.md', 'story-8.3-una.md', 'story-8.4-otra.md'].map(con), [true, true, true, true], 'las cuatro tienen ejecución: no suman tarjeta');
  assert.deepStrictEqual(['story-8.5-vieja.md', 'story-8.6-sin.md'].map(con), [false, false], 'la de 30 h y la sin ejecución sí suman');
});

test('T9 Who_ExecutionOnThisMachine @story-8.185 @ac-8 — con ejecución: el nombre de la sesión y «en esta máquina»', () => {
  const e = estadoConEjecuciones({ activas: [{ sessionId: 'abc', sessionName: 'Passarella', storyPath: '/x/specs/story-9.1-a.md' }] });
  const runs = PS.runsOfThisMachine({ stateDir: e });
  assert.strictEqual(PS.whoOf({ archivo: 'story-9.1-a.md' }, runs, { nameOf: (sid) => (sid === 'abc' ? 'Passarella' : null) }), 'Passarella, en esta máquina');
});

test('T10 Who_NoRun_Unassigned_EvenWithBranch @story-8.185 @ac-9 — sin ejecución dice «sin asignar», aunque haya una rama con commits propios', () => {
  const raiz = tmp('raiz');
  const r = repo(raiz, 'r', { remoto: 'https://github.com/acme/r.git', archivos: { 'specs/story-10.1-a.md': historia('10.1', 'ready-for-dev') } });
  git(r, 'checkout', '-qb', 'story/10.1-a');
  fs.writeFileSync(path.join(r, 'x.txt'), 'x');
  git(r, 'add', '-A'); git(r, 'commit', '-qm', 'propio');
  const runs = PS.runsOfThisMachine({ stateDir: estadoConEjecuciones() });
  assert.strictEqual(PS.whoOf({ archivo: 'story-10.1-a.md' }, runs), 'sin asignar');
});

test('T11 Who_WorkItemIsNotWho_NoOwnerField @story-8.185 @ac-10 — el pedido de trabajo se guarda aparte y owner: no se lee', () => {
  const raiz = tmp('raiz');
  const r = repo(raiz, 'r', { remoto: 'https://github.com/acme/r.git', archivos: { 'specs/a.md': historia('11.1', 'ready-for-dev', { work_item: 4242, owner: 'ana' }) } });
  const h = PS.collect(base({ home: casa([{ cwd: r }]) })).proyectos[0].historias[0];
  assert.strictEqual(h.trabajo, '4242');
  assert.ok(!('owner' in h) && !('quien' in h), 'ni dueño ni quién en el archivo');
});

test('T12 NoNetwork_NoWritesInTheClone @story-8.185 @ac-11 @ac-20 — git de juguete: sin fetch, sin checkout, sin escrituras', () => {
  const raiz = tmp('raiz');
  const r = repo(raiz, 'r', { remoto: 'https://github.com/acme/r.git', archivos: { 'specs/a.md': historia('12.1', 'review') } });
  const pedidos = [];
  const real = PS.gitRunner();
  const espia = (cwd, args, o) => { pedidos.push(args.join(' ')); return real(cwd, args, o); };
  const antes = git(r, 'status', '--porcelain');
  PS.collect(base({ home: casa([{ cwd: r }]), git: espia }));
  assert.ok(pedidos.length > 0, 'la lectura le pidió algo a git');
  const prohibidos = /^(fetch|pull|push|checkout|switch|reset|commit|add|stash|merge|rebase|update-ref|gc|worktree add|remote update)\b/;
  assert.deepStrictEqual(pedidos.filter((x) => prohibidos.test(x)), [], `ningún pedido que sale a la red o escribe: ${pedidos.join(' | ')}`);
  assert.strictEqual(git(r, 'status', '--porcelain'), antes, 'el clon quedó igual');
});

test('T13 Fetched_HourOrNothing @story-8.185 @ac-12 @ac-16 — el FETCH_HEAD más nuevo, sin ninguno no hay hora, y sin rama traída «de tu copia»', () => {
  const raiz = tmp('raiz');
  const r = repo(raiz, 'r', { remoto: 'https://github.com/acme/r.git', archivos: { 'specs/a.md': historia('13.1', 'review') } });
  const wt = path.join(raiz, 'r--wt');
  git(r, 'worktree', 'add', '-q', '-b', 'otra', wt);
  const comun = path.join(r, '.git');
  const ahora = Date.now();
  fs.writeFileSync(path.join(comun, 'FETCH_HEAD'), 'x');
  fs.utimesSync(path.join(comun, 'FETCH_HEAD'), (ahora - 5 * 3600e3) / 1000, (ahora - 5 * 3600e3) / 1000);
  const delWt = path.join(comun, 'worktrees', 'r--wt', 'FETCH_HEAD');
  fs.writeFileSync(delWt, 'x');
  fs.utimesSync(delWt, (ahora - 3600e3) / 1000, (ahora - 3600e3) / 1000);
  const p = PS.collect(base({ home: casa([{ cwd: r }]), now: ahora })).proyectos[0];
  assert.ok(Math.abs(Date.parse(p.traidoAt) - (ahora - 3600e3)) < 2000, `la hora del worktree, la más nueva: ${p.traidoAt}`);
  assert.strictEqual(p.deTuCopia, false);
  // sin FETCH_HEAD: sin hora
  const s = repo(raiz, 's', { remoto: 'https://github.com/acme/s.git', archivos: { 'specs/a.md': historia('13.2', 'review') } });
  assert.strictEqual(PS.collect(base({ home: casa([{ cwd: s }]) })).proyectos[0].traidoAt, null);
  // sin rama traída: de la copia de trabajo
  const c = repo(raiz, 'c', { remoto: 'https://github.com/acme/c.git', archivos: { 'specs/a.md': historia('13.3', 'review') }, traida: false });
  const pc = PS.collect(base({ home: casa([{ cwd: c }]) })).proyectos[0];
  assert.strictEqual(pc.deTuCopia, true);
  assert.deepStrictEqual(pc.historias.map((x) => x.id), ['13.3']);
});

test('T14 GoneFolderOrBadConfig_DoesNotThrow @story-8.185 @ac-17 — carpeta borrada, configuración rota, remoto desconocido y raíz sin resolver', () => {
  const raiz = tmp('raiz');
  const roto = repo(raiz, 'roto', { remoto: 'https://github.com/acme/roto.git', archivos: { '.tycon/advisors.yaml': 'stories:\n  repo: ../no-esta-clonado\n' } });
  const lejos = repo(raiz, 'lejos', { remoto: 'https://github.com/acme/lejos.git', archivos: { '.tycon/advisors.yaml': 'stories:\n  repo: /etc\n' } });
  const raro1 = repo(raiz, 'raro1', { remoto: 'https://git.acme.example/uno.git', archivos: { 'specs/a.md': historia('14.1', 'review') } });
  const raro2 = repo(raiz, 'raro2', { remoto: 'https://git.acme.example/dos.git', archivos: { 'specs/a.md': historia('14.2', 'review') } });
  const ilegible = repo(raiz, 'ilegible', { remoto: 'https://github.com/acme/ilegible.git' });
  fs.mkdirSync(path.join(ilegible, '.tycon', 'advisors.yaml'), { recursive: true });   // una carpeta donde va un archivo: no se lee
  const h = casa([{ cwd: path.join(raiz, 'ya-no-existe') }, { cwd: roto }, { cwd: lejos }, { cwd: raro1 }, { cwd: raro2 }, { cwd: ilegible }]);
  let out;
  assert.doesNotThrow(() => { out = PS.collect(base({ home: h, roots: null, rootsProblem: 'sin raíz de repos' })); });
  assert.deepStrictEqual(out.sinHistorias.sort(), ['ilegible', 'lejos', 'roto']);
  assert.strictEqual(out.proyectos.length, 2, 'dos remotos desconocidos distintos no se juntan');
  assert.strictEqual(out.commitsPropios.medido, false, 'sin raíz, los commits propios se dicen no medidos');
  assert.match(out.commitsPropios.motivo, /raíz/);
});

test('T15 Lock_OneAtATime_AtomicWrite @story-8.185 @ac-18 — un candado de 4 minutos frena; uno de 6, no; se escribe aparte y se renombra', () => {
  const estado = tmp('estado');
  const dir = path.join(estado, 'office');
  fs.mkdirSync(dir, { recursive: true });
  const candado = path.join(dir, 'project-stories.lock');
  const ahora = Date.now();
  const leer = () => ({ at: new Date(ahora).toISOString(), proyectos: [], sinHistorias: [], commitsPropios: { medido: true } });
  fs.writeFileSync(candado, 'otro');
  fs.utimesSync(candado, (ahora - 4 * 60e3) / 1000, (ahora - 4 * 60e3) / 1000);
  assert.strictEqual(PS.refresh({ stateDir: estado, now: ahora, read: leer }).ran, false, 'con un candado de 4 minutos no corre');
  assert.ok(!fs.existsSync(path.join(dir, 'project-stories.json')));
  fs.utimesSync(candado, (ahora - 6 * 60e3) / 1000, (ahora - 6 * 60e3) / 1000);
  const r = PS.refresh({ stateDir: estado, now: ahora, read: leer });
  assert.strictEqual(r.ran, true, 'con uno de 6 minutos, vencido, corre');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'project-stories.json'), 'utf8')).proyectos, []);
  assert.ok(!fs.existsSync(candado), 'suelta el candado');
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f !== 'project-stories.json'), [], 'sin archivos a medio escribir');
});

test('T26 Read_FromMainBranch_NotTheCopy @story-8.185 @ac-2 @ac-16 — la rama traída manda sobre la copia; con sólo origin/master no es «de tu copia»', () => {
  const raiz = tmp('raiz');
  const r = repo(raiz, 'r', { remoto: 'https://github.com/acme/r.git', archivos: { 'specs/a.md': historia('26.1', 'ready-for-dev') }, traida: false });
  // en origin/main ya está terminada; la copia quedó atrás y la dice lista
  fs.writeFileSync(path.join(r, 'specs', 'a.md'), historia('26.1', 'done'));
  git(r, 'commit', '-qam', 'terminada');
  git(r, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(r, 'reset', '-q', '--hard', 'HEAD~1');
  const p = PS.collect(base({ home: casa([{ cwd: r }]) }));
  // desde la 8.313 el proyecto leído sigue en la lectura (su número de abiertas es 0); la historia no entra
  assert.deepStrictEqual(p.proyectos.map((x) => [x.historias, x.abiertas]), [[[], []]], 'terminada en origin/main: no entra aunque la copia la diga lista');
  const m = repo(raiz, 'm', { remoto: 'https://github.com/acme/m.git', archivos: { 'specs/a.md': historia('26.2', 'review') }, traida: false });
  git(m, 'update-ref', 'refs/remotes/origin/master', 'HEAD');
  const pm = PS.collect(base({ home: casa([{ cwd: m }]) })).proyectos[0];
  assert.strictEqual(pm.deTuCopia, false, 'con origin/master no es de tu copia');
});

test('T28 Guides_SayWhatComesAlone @story-8.185 @ac-23 — las cuatro guías dicen qué sale solo, que lo sin historia va con board.js, y el límite', () => {
  const guias = {
    'guides/coordination.md': [/sale sola/i, /board\.js/, /otra máquina/i],
    'guides/coordination.en.md': [/shows up on its own/i, /board\.js/, /another machine/i],
    'guides/working-with-a-coordinator.md': [/sale sola/i, /board\.js/, /otra máquina/i],
    'guides/working-with-a-coordinator.en.md': [/shows up on its own/i, /board\.js/, /another machine/i],
  };
  for (const [g, pide] of Object.entries(guias)) {
    const t = fs.readFileSync(path.join(ROOT, g), 'utf8');
    for (const re of pide) assert.match(t, re, `${g}: ${re}`);
  }
});

// ---------- en la oficina: la tabla «Pendientes» y el kanban (T16–T25, T27) ----------

const OF = require('./lib/office-fixtures.js');
const OFFICE_MOD = require(path.join(ROOT, 'scripts', 'tools', 'office.js'));
const FIELDS_MOD = require(path.join(ROOT, 'scripts', 'tools', 'office', 'fields.js'));
const AHORA = OF.NOW;
const HORA = 3600e3;
const hm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** Una lectura de fondo ya hecha, como la deja `refresh`. */
const lectura = (proyectos, { at = AHORA - 10 * 60e3, sinHistorias = [] } = {}) => ({ at: new Date(at).toISOString(), proyectos, sinHistorias, commitsPropios: { medido: true } });
const hist = (id, estado = 'ready-for-dev', extra = {}) => ({ id, archivo: `story-${id}-x.md`, titulo: `La historia ${id}`, estado, prioridad: null, trabajo: null, ...extra });
const proyecto = (nombre, historias, extra = {}) => ({ nombre, traidoAt: new Date(AHORA - 3 * HORA).toISOString(), deTuCopia: false, sinLeer: 0, historias, ...extra });
/** La foto de la oficina con lo que se le pase; `historias` es lo que la oficina recibe de la lectura de fondo. */
const oficina = ({ sesiones = [], tablero = null, historias } = {}) => OF.buildOffice({
  wip: OF.wip(sesiones), nowMs: AHORA, board: tablero ? OFFICE_MOD.buildBoard(tablero) : null, ...(historias !== undefined ? { projectStories: historias } : {}),
}).data;
const sinSesion = (data) => data.kanban.columnas.find((c) => c.id === 'sinEmpezar').tarjetas;
const deHistoria = (data) => sinSesion(data).filter((t) => t.local === true);
const tablas = (data) => OF.buildTables({ kanban: data.kanban, nowMs: AHORA, sinModelo: true });
const FILA_SIN_HISTORIA = { id: 'T-9', titulo: 'Algo sin historia', estado: 'espera', grupo: 'Hoy', orden: 1 };

test('T16 Table_ProjectRows_AfterTopics @story-8.185 @ac-12 @ac-14 — las filas de proyecto van después de las de tema, con su línea y dos títulos', () => {
  const runs = [{ archivo: 'story-2.1-x.md', sessionId: 'sid-Alfa' }];
  const snap = lectura([
    proyecto('Acme', [hist('2.3'), hist('2.1', 'in-progress'), hist('2.2')]),
    proyecto('Beta', [hist('1.1', 'review')], { deTuCopia: true, traidoAt: null, sinLeer: 1 }),
  ]);
  const data = oficina({ sesiones: [{ session: 'Alfa' }], tablero: { pendientes: [FILA_SIN_HISTORIA] }, historias: { snap, runs } });
  const filas = tablas(data).pendientes.filas;
  const i = filas.findIndex((f) => f.seccion === 'De tus proyectos');
  assert.ok(i > 0, 'hay filas de tema y las de proyecto van después');
  assert.ok(filas.slice(0, i).every((f) => !f.seccion), 'las de tema, primero');
  const [acme, beta] = filas.slice(i);
  assert.strictEqual(acme.grupo, 'Acme');
  assert.strictEqual(acme.col, '1 en esta máquina · 2 sin asignar · traído hace 3 h');
  assert.strictEqual(acme.que, 'La historia 2.1; La historia 2.2; y 1 más');
  assert.deepStrictEqual(acme.trabajos[0], { numero: '2.1', titulo: 'La historia 2.1', quien: 'Alfa, en esta máquina', como: 'en curso' });
  assert.deepStrictEqual(acme.trabajos.slice(1).map((w) => [w.numero, w.quien, w.como]), [['2.2', 'sin asignar', 'lista'], ['2.3', 'sin asignar', 'lista']]);
  assert.strictEqual(beta.col, '1 sin asignar · 1 no se pudo leer · de tu copia');
  assert.strictEqual(beta.trabajos[0].como, 'en revisión');
});

test('T17 TableAndKanban_OldOrMissing_SaySo @story-8.185 @ac-15 — sin archivo, roto o de hace dos horas: sin historias, y lo dicen', () => {
  const vieja = AHORA - 2 * HORA;
  const casos = [
    ['sin archivo', () => {}, /No pude leer los pendientes de tus proyectos/],
    ['roto', (d) => fs.writeFileSync(path.join(d, 'project-stories.json'), '{no es json'), /No pude leer los pendientes de tus proyectos/],
    ['de hace dos horas', (d) => fs.writeFileSync(path.join(d, 'project-stories.json'), JSON.stringify(lectura([proyecto('Acme', [hist('2.1')])], { at: vieja }))), new RegExp(`se leyeron a las ${hm(vieja)}`)],
  ];
  for (const [caso, preparar, aviso] of casos) {
    const e = tmp('estado');
    fs.mkdirSync(path.join(e, 'office'), { recursive: true });
    preparar(path.join(e, 'office'));
    const leida = PS.readSnapshot(e, AHORA);
    assert.strictEqual(leida.snap, null, `${caso}: no se usa`);
    const data = oficina({ historias: { ...leida, runs: [] } });
    assert.deepStrictEqual(deHistoria(data), [], `${caso}: sin tarjetas de historia`);
    assert.match(data.kanban.historias.nota, aviso, `${caso}: el kanban lo dice`);
    const t = tablas(data).pendientes;
    assert.ok(!t.filas.some((f) => f.seccion), `${caso}: sin filas de proyecto`);
    assert.ok(t.pie.some((l) => aviso.test(l)), `${caso}: la tabla lo dice`);
  }
  // una lectura de hace diez minutos sí se usa
  const e = tmp('estado');
  fs.mkdirSync(path.join(e, 'office'), { recursive: true });
  fs.writeFileSync(path.join(e, 'office', 'project-stories.json'), JSON.stringify(lectura([proyecto('Acme', [hist('2.1')])])));
  assert.ok(PS.readSnapshot(e, AHORA).snap, 'la de diez minutos, sí');
});

test('T18 Page_FoldsAndKeepsOpen @story-8.185 @ac-13 — la fila de proyecto se abre y sigue abierta con la foto nueva', () => {
  const data = oficina({ tablero: { pendientes: [FILA_SIN_HISTORIA] }, historias: { snap: lectura([proyecto('Acme', [hist('2.1'), hist('2.2')])]), runs: [] } });
  data.tablas = tablas(data);
  const html = OF.page(data);
  const el = (html.match(/const el=(\([^\n]*\});\n/) || [])[1];
  const from = html.indexOf('const temasAbiertos=new Set();');
  const to = html.indexOf('function renderCrew');
  assert.ok(el && from > 0 && to > from, 'la página trae la tabla');
  const node = (tag) => {
    const n = { tag, className: '', textContent: '', hidden: false, children: [], dataset: {}, attrs: {}, on: {} };
    n.appendChild = (c) => { n.children.push(c); return c; };
    n.replaceChildren = () => { n.children = []; };
    n.setAttribute = (k, v) => { n.attrs[k] = v; };
    n.addEventListener = (k, f) => { n.on[k] = f; };
    n.focus = () => {};
    return n;
  };
  const sec = node('section');
  const document = { createElement: node, getElementById: (id) => (id === 'tablas' ? sec : null), activeElement: null };
  const page = new Function('document', 'DATA', `const el=${el};${html.slice(from, to)}; return { draw: renderTablas, set: (d) => { DATA = d; } };`)(document, data);
  page.draw();
  const todos = (n, out = []) => { out.push(n); n.children.forEach((c) => todos(c, out)); return out; };
  const texto = (n) => n.textContent + n.children.map(texto).join('');
  const filaDe = () => todos(sec).find((n) => n.tag === 'tr' && n.className === 'temaFila' && texto(n).startsWith('Acme'));
  const det = () => { const body = todos(sec).find((n) => n.children.includes(filaDe())); return body.children[body.children.indexOf(filaDe()) + 1]; };
  assert.ok(todos(sec).some((n) => texto(n) === 'De tus proyectos'), 'la sección se nombra');
  assert.ok(filaDe(), 'la fila de proyecto se dibuja');
  assert.strictEqual(det().hidden, true, 'cerrada al principio');
  filaDe().on.click();
  assert.strictEqual(det().hidden, false, 'se abre al tocarla');
  assert.match(texto(det()), /2\.1.*La historia 2\.1.*sin asignar · lista/);
  page.set({ ...data, tablas: tablas(data) });
  page.draw();
  assert.strictEqual(det().hidden, false, 'sigue abierta con la foto nueva');
});

test('T19 Kanban_RestUnchanged @story-8.185 @ac-21 — con y sin la lectura de historias, las otras tarjetas y columnas son iguales', () => {
  const sesiones = [{ session: 'Alfa' }, { session: 'Beta', extra: { kind: 'entering' } }];
  const tablero = { pendientes: [FILA_SIN_HISTORIA, { id: 'T-10', titulo: 'Una firma', estado: 'firma', grupo: 'Hoy', orden: 2 }] };
  const sin = oficina({ sesiones, tablero });
  const con = oficina({ sesiones, tablero, historias: { snap: lectura([proyecto('Acme', [hist('5.1'), hist('5.2', 'review')])]), runs: [] } });
  const resto = (d) => JSON.parse(JSON.stringify(d.kanban.columnas.map((c) => ({ ...c, tarjetas: c.tarjetas.filter((t) => t.local !== true) }))));
  assert.strictEqual(deHistoria(con).length, 2, 'la lectura suma sus tarjetas');
  assert.deepStrictEqual(resto(con), resto(sin));
  assert.strictEqual(con.kanban.linea, sin.kanban.linea);
});

test('T20 Site_ProjectRowsAndStoryCardsDoNotTravel @story-8.185 @ac-19 — las filas de proyecto y las tarjetas de historia no viajan; la fila del tablero sí', () => {
  const data = oficina({ tablero: { pendientes: [FILA_SIN_HISTORIA] }, historias: { snap: lectura([proyecto('Acme', [hist('6.1')])], { sinHistorias: ['nada'] }), runs: [] } });
  data.tablas = tablas(data);
  assert.ok(deHistoria(data).length && data.tablas.pendientes.filas.some((f) => f.seccion), 'la foto local las trae');
  const sent = FIELDS_MOD.pick(data, '/home/nadie');
  const enviadas = sent.kanban.columnas.find((c) => c.id === 'sinEmpezar').tarjetas;
  assert.deepStrictEqual(enviadas.map((t) => t.titulo), ['Algo sin historia'], 'viaja la fila del tablero, no la tarjeta de historia');
  assert.ok(!JSON.stringify(sent).includes('La historia 6.1'), 'ni la fila de proyecto ni su historia');
  assert.ok(!('historias' in sent.kanban) && !('pie' in sent.tablas.pendientes), 'ni el aviso de la lectura');
  for (const k of ['kanban.historias', 'tablas.pendientes.pie', 'kanban.columnas.tarjetas.local', 'tablas.pendientes.filas.local', 'tablas.pendientes.filas.seccion']) assert.ok(k in FIELDS_MOD.LOCAL_ONLY, `${k} dice por qué no viaja`);
});

test('T22 Kanban_StoryWithoutRun_HasCard @story-8.185 @ac-21 — una historia lista sin fila ni ejecución tiene su tarjeta en «Sin sesión»', () => {
  const data = oficina({ historias: { snap: lectura([proyecto('Acme', [hist('8.183', 'ready-for-dev', { trabajo: '6402' })])]), runs: [] } });
  const [t] = deHistoria(data);
  assert.deepStrictEqual({ titulo: t.titulo, quien: t.quien, grupo: t.grupo, nota: t.nota }, { titulo: '8.183 · La historia 8.183', quien: 'sin asignar', grupo: 'Historias', nota: 'lista · pedido de trabajo 6402' });
});

test('T23 Kanban_SortedByPriority @story-8.185 @ac-22 — P0 a P3, después sin prioridad y dentro por número; después de la fila del tablero', () => {
  const hs = [hist('3.1', 'ready-for-dev', { prioridad: 'P2' }), hist('3.2', 'ready-for-dev', { prioridad: 'P0' }), hist('3.3'), hist('3.10', 'ready-for-dev', { prioridad: 'P1' }), hist('3.4', 'ready-for-dev', { prioridad: 'P1' })];
  const data = oficina({ tablero: { pendientes: [FILA_SIN_HISTORIA] }, historias: { snap: lectura([proyecto('Acme', hs)]), runs: [] } });
  assert.deepStrictEqual(sinSesion(data).map((t) => t.titulo.split(' · ')[0]), ['Algo sin historia', '3.2', '3.4', '3.10', '3.1', '3.3']);
});

test('T24 Tables_StoryCardsNotClassified @story-8.185 @ac-14 — las tarjetas de historia no entran a las filas de tema ni van al modelo', () => {
  const data = oficina({ tablero: { pendientes: [FILA_SIN_HISTORIA] }, historias: { snap: lectura([proyecto('Acme', [hist('7.1'), hist('7.2')])]), runs: [] } });
  const t = tablas(data).pendientes;
  const deTema = t.filas.filter((f) => !f.seccion);
  assert.ok(deTema.length, 'hay filas de tema');
  assert.ok(!JSON.stringify(deTema).includes('La historia 7.'), 'las líneas de tema no las nombran');
  // «En el kanban, de a uno» cuenta las tarjetas que no son historias plegadas: ésas tienen su propio número (8.313, AC 7)
  assert.match(t.cruce, /\b1 sin sesión\b/, 'la línea del kanban no cuenta las plegadas');
  assert.deepStrictEqual(OFFICE_MOD.workCards(data.kanban).map((c) => c.titulo), ['Algo sin historia'], 'al modelo no van');
});

test('T25 Run_CrossedByFileNotByNumber @story-8.185 @ac-7 — la 2.1 de dos productos: se cruza sólo la del mismo archivo; sin storyPath, ninguna', () => {
  const e = estadoConEjecuciones({ activas: [{ sessionId: 'a', storyPath: '/otra/copia/specs/story-2.1-a.md' }, { sessionId: 'b', storyId: '2.2' }] }, AHORA);
  const runs = PS.runsOfThisMachine({ stateDir: e, now: AHORA });
  const snap = lectura([
    proyecto('Uno', [hist('2.1', 'ready-for-dev', { archivo: 'story-2.1-a.md' })]),
    proyecto('Dos', [hist('2.1', 'ready-for-dev', { archivo: 'story-2.1-b.md' }), hist('2.2')]),
  ]);
  const data = oficina({ historias: { snap, runs } });
  assert.deepStrictEqual(deHistoria(data).map((t) => t.titulo.split(' · ')[0]), ['2.1', '2.2'], 'la 2.1 de «Dos» y la 2.2 sí tienen tarjeta');
  const uno = tablas(data).pendientes.filas.find((f) => f.grupo === 'Uno');
  assert.match(uno.trabajos[0].quien, /en esta máquina$/, 'la de «Uno» tiene su ejecución');
});

test('T27 Kanban_StoryOnBoardRow_NoExtraCard @story-8.185 @ac-7 — la historia de una fila abierta no suma tarjeta; la de una fila hecha, sí', () => {
  const tablero = { pendientes: [
    { id: 'T-5', titulo: 'La 4.1 en el tablero', estado: 'espera', grupo: 'Hoy', orden: 1, historia: '4.1' },
    { id: 'T-6', titulo: 'La 4.2 ya hecha', estado: 'hecho', grupo: 'Hoy', orden: 2, historia: '4.2', realIso: '2026-10-18T09:10' },
  ] };
  const data = oficina({ tablero, historias: { snap: lectura([proyecto('Acme', [hist('4.1'), hist('4.2')])]), runs: [] } });
  assert.deepStrictEqual(deHistoria(data).map((t) => t.titulo.split(' · ')[0]), ['4.2']);
  const fila = sinSesion(data).find((t) => t.titulo === 'La 4.1 en el tablero');
  assert.strictEqual(fila && fila.numero, 'T-5', 'la fila sigue con su número');
});

// ---------- regresiones del pase adversarial de la corrida 8.247 ----------

test('Regresion_RamaPrincipal_NombresConTildes @story-8.185 @ac-2 — una historia con ñ o tilde en el nombre del archivo se lee de la rama traída', () => {
  const raiz = tmp('raiz');
  const r = repo(raiz, 'r', { remoto: 'https://github.com/acme/r.git', archivos: { 'specs/story-1.1-ñandú.md': historia('1.1', 'in-progress'), 'specs/story-1.2-sesión.md': historia('1.2', 'ready-for-dev'), 'specs/plain.md': historia('1.3', 'review') } });
  const leido = PS.readPlace({ repo: r, dir: path.join(r, 'specs') }, PS.gitRunner());
  assert.strictEqual(leido.problem, null);
  assert.deepStrictEqual(leido.historias.map((h) => h.id).sort(), ['1.1', '1.2', '1.3'], 'ninguna se pierde por el nombre');
  assert.ok(leido.historias.some((h) => h.archivo === 'story-1.1-ñandú.md'), 'el archivo conserva su nombre, sin comillas ni escapes');
});

test('Regresion_RamaPrincipal_CarpetaEnLaRaiz @story-8.185 @ac-2 — si las historias viven en la raíz del repo, se leen igual de la rama traída', () => {
  const raiz = tmp('raiz');
  const r = repo(raiz, 'r', { remoto: 'https://github.com/acme/r.git', archivos: { 'story-2.1.md': historia('2.1', 'ready-for-dev'), 'docs/story-2.2.md': historia('2.2', 'review') } });
  const leido = PS.readPlace({ repo: r, dir: r }, PS.gitRunner());
  assert.strictEqual(leido.problem, null, 'git no rechaza la carpeta');
  assert.deepStrictEqual(leido.historias.map((h) => h.id).sort(), ['2.1', '2.2']);
});

test('Regresion_Encabezado_ConBOM @story-8.185 @ac-6 — una historia guardada con BOM se reconoce, en la rama y en la copia', () => {
  assert.strictEqual(PS.parseStory(`﻿${historia('3.1', 'in-progress')}`, 'a.md').story.id, '3.1');
  const raiz = tmp('raiz');
  const r = repo(raiz, 'r', { remoto: 'https://github.com/acme/r.git', archivos: { 'specs/a.md': `﻿${historia('3.2', 'ready-for-dev')}` } });
  assert.deepStrictEqual(PS.readPlace({ repo: r, dir: path.join(r, 'specs') }, PS.gitRunner()).historias.map((h) => h.id), ['3.2']);
});

test('Regresion_Pagina_DibujaElAvisoDeLaLectura @story-8.185 @ac-15 — la columna «Sin sesión» y el pie de «Pendientes» dibujan el aviso', () => {
  const data = oficina({ tablero: { pendientes: [FILA_SIN_HISTORIA] }, historias: { snap: null, nota: 'No pude leer los pendientes de tus proyectos', runs: [] } });
  data.tablas = tablas(data);
  const html = OF.page(data);
  const el = (html.match(/const el=(\([^\n]*\});\n/) || [])[1];
  const node = (tag) => {
    const n = { tag, className: '', textContent: '', hidden: false, children: [], dataset: {}, attrs: {}, style: { setProperty() {} } };
    n.appendChild = (c) => { n.children.push(c); return c; };
    n.append = (...cs) => cs.forEach((c) => n.children.push(c));
    n.replaceChildren = () => { n.children = []; };
    n.setAttribute = (k, v) => { n.attrs[k] = v; };
    n.addEventListener = () => {};
    n.focus = () => {};
    return n;
  };
  const texto = (n) => n.textContent + n.children.map(texto).join('');
  // la tabla
  const sec = node('section');
  const from = html.indexOf('const temasAbiertos=new Set();');
  const to = html.indexOf('function renderCrew');
  new Function('document', 'DATA', `const el=${el};${html.slice(from, to)}; renderTablas();`)({ createElement: node, getElementById: (id) => (id === 'tablas' ? sec : null), activeElement: null }, data);
  assert.match(texto(sec), /No pude leer los pendientes de tus proyectos/, 'el pie de la tabla lo dice');
  // el kanban
  const { body } = OF.drawKanban(data);
  assert.match(texto(body), /No pude leer los pendientes de tus proyectos/, '«Sin sesión» lo dice');
});

// ── Las dependencias abiertas, la pausa y los repos de cada proyecto (@story-8.307) ─────────────────────────────────

test('T13 ProjectStories_PendientesYRepos @story-8.307 @ac-6 @ac-7 @ac-19 — pendientes con done y review resueltas, el comentario no rompe la lista, pausa, repos sin repetidos y view igual', () => {
  const raiz = tmp('raiz');
  const archivos = {
    'specs/a.md': historia('9.1', 'ready-for-dev', { depends_on: '["9.2", "9.3"]' }),
    'specs/b.md': historia('9.2', 'done'),
    'specs/c.md': historia('9.3', 'review'),
    'specs/d.md': historia('9.4', 'ready-for-dev', { depends_on: '["9.5", "9.9"]' }),
    'specs/e.md': historia('9.5', 'draft'),
    'specs/f.md': historia('9.6', 'ready-for-dev', { depends_on: '\n  - "9.2"\n  - "9.3"' }),
    'specs/g.md': historia('9.7', 'ready-for-dev', { depends_on: '9.8 y 9.2' }),
    'specs/h.md': historia('9.8', 'ready-for-dev', { depends_on: '[]  # no espera a otra historia' }),
    'specs/i.md': historia('9.10', 'ready-for-dev', { depends_on: '["9.2"]  # de la 9.2, la tanda E' }),
    'specs/j.md': historia('9.11', 'ready-for-dev', { paused_until: '2027-01-05' }),
  };
  const r = repo(raiz, 'r', { remoto: 'https://github.com/acme/r.git', archivos });
  const out = PS.collect(base({ home: casa([{ cwd: r }]) }));
  const p = out.proyectos[0];
  const by = Object.fromEntries(p.historias.map((h) => [h.id, h]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['9.1', '9.10', '9.11', '9.3', '9.4', '9.6', '9.7', '9.8'], 'las done y draft no entran al archivo');
  assert.strictEqual(by['9.1'].pendientes, undefined, 'done y review resuelven');
  assert.deepStrictEqual(by['9.4'].pendientes, ['9.5', '9.9'], 'draft e inexistente quedan pendientes');
  assert.strictEqual(by['9.6'].pendientes, undefined, 'la lista con guiones también resuelve');
  assert.deepStrictEqual(by['9.7'].pendientes, ['9.8 y 9.2'], 'lo que no se entiende queda pendiente, tal cual');
  assert.strictEqual(by['9.8'].pendientes, undefined, 'el comentario del final no vuelve ilegible la lista vacía');
  assert.strictEqual(by['9.10'].pendientes, undefined, 'el comentario del final no vuelve ilegible una dependencia resuelta');
  assert.strictEqual(by['9.11'].pausa, '2027-01-05');
  assert.strictEqual(by['9.1'].pausa, undefined);
  // formas válidas de YAML que la lectura tiene que entender (las encontró el pase adversarial): la lista sin sangría, un
  // comentario o un renglón vacío dentro del bloque, un archivo con CRLF, y el nulo de YAML (null, ~), que no es una
  // dependencia
  const crlf = (txt) => txt.replace(/\n/g, '\r\n');
  const formas = repo(raiz, 'formas', { remoto: 'https://github.com/acme/formas.git', archivos: {
    'specs/a.md': historia('5.1', 'ready-for-dev', { depends_on: '\n- "5.9"' }),
    'specs/b.md': historia('5.2', 'ready-for-dev', { depends_on: '\n  # la base primero\n  - "5.9"' }),
    'specs/c.md': historia('5.3', 'ready-for-dev', { depends_on: '\n\n  - "5.9"' }),
    'specs/d.md': crlf(historia('5.4', 'ready-for-dev', { depends_on: '[]  # no espera a otra' })),
    'specs/e.md': crlf(historia('5.5', 'ready-for-dev', { depends_on: '\n  - "5.9"' })),
    'specs/f.md': historia('5.6', 'ready-for-dev', { depends_on: 'null' }),
    'specs/g.md': historia('5.7', 'ready-for-dev', { depends_on: '~' }),
    'specs/h.md': historia('5.8', 'ready-for-dev', { depends_on: '\n  - "5.9"\n  - null' }),
  } });
  const bf = Object.fromEntries(PS.collect(base({ home: casa([{ cwd: formas }]) })).proyectos[0].historias.map((h) => [h.id, h]));
  for (const id of ['5.1', '5.2', '5.3', '5.5', '5.8']) assert.deepStrictEqual(bf[id].pendientes, ['5.9'], `${id}: la 5.9 (que no existe) sigue pendiente`);
  for (const id of ['5.4', '5.6', '5.7']) assert.strictEqual(bf[id].pendientes, undefined, `${id}: no declara dependencias`);
  assert.ok(!('dependsOn' in by['9.1']) && !/"estados"/.test(JSON.stringify(out)), 'ni las dependencias crudas ni los estados se guardan');
  assert.deepStrictEqual(p.repos, ['github/acme/r']);
  // sin rama principal traída, lo leído es de la copia: toda dependencia declarada queda pendiente
  const copia = repo(raiz, 'copia', { remoto: 'https://github.com/acme/copia.git', traida: false, archivos: { 'specs/a.md': historia('9.1', 'ready-for-dev', { depends_on: '["9.2"]' }), 'specs/b.md': historia('9.2', 'done') } });
  const pc = PS.collect(base({ home: casa([{ cwd: copia }]) })).proyectos[0];
  assert.strictEqual(pc.deTuCopia, true);
  assert.deepStrictEqual(pc.historias.find((h) => h.id === '9.1').pendientes, ['9.2']);
  // dos repos trabajados que leen del mismo lugar: repos trae el remoto del lugar y los de los dos, sin repetidos
  const historias = repo(raiz, 'historias', { remoto: 'https://github.com/acme/historias.git', archivos: { 'specs/x.md': historia('7.1', 'ready-for-dev') } });
  const back = repo(raiz, 'back', { remoto: 'https://github.com/acme/back.git', archivos: { '.tycon/advisors.yaml': 'stories:\n  repo: ../historias\n' } });
  const out3 = PS.collect(base({ home: casa([{ cwd: back }, { cwd: historias }]) }));
  const row3 = out3.proyectos.find((x) => x.historias.some((h) => h.id === '7.1'));
  assert.deepStrictEqual([...row3.repos].sort(), ['github/acme/back', 'github/acme/historias']);
  // la oficina dibuja lo mismo que antes: los campos nuevos no se muestran
  const v = PS.view({ snap: out, now: Date.now() });
  assert.doesNotMatch(JSON.stringify(v), /pendientes|pausa|repos/);
  assert.strictEqual(typeof PS.remoteKey, 'function');
  assert.strictEqual(typeof PS.inOrder, 'function');
  assert.strictEqual(PS.READY, 'ready-for-dev');
});

// ---------- 8.313: las historias abiertas en main, el commit leído y la relectura cuando main se mueve ----------

const STATES_8313 = require(path.join(ROOT, 'scripts', 'metrics', 'states.json'));
const SD_8313 = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
const READER_8313 = path.join(ROOT, 'scripts', 'tools', 'office', 'project-stories.js');
const snapFile8313 = (estado) => path.join(estado, 'office', 'project-stories.json');
/** La lectura de un proyecto con su lugar y su commit, como la deja `collect` (`repoDir`, una carpeta de mentira para el git inyectado). */
const leido8313 = (nombre, repoDir, commit, extra = {}) => ({ nombre, traidoAt: null, deTuCopia: false, sinLeer: 0, repos: [`github/acme/${nombre}`], remoto: `github/acme/${nombre}`, lugar: { repo: repoDir, ref: 'origin/main', common: path.join(repoDir, '.git') }, commit, historias: [], abiertas: [], ...extra });
const guardar8313 = (estado, proyectos) => {
  fs.mkdirSync(path.join(estado, 'office'), { recursive: true });
  fs.writeFileSync(snapFile8313(estado), `${JSON.stringify(lectura(proyectos, { at: Date.now() }), null, 2)}\n`);
};

test('T1 Abiertas_CuentaLosEstadosDeMain @story-8.313 @ac-1 @ac-20 — los grupos abiertos según origin/main, el alias por su canónico y el desconocido sin leer', () => {
  const raiz = tmp('raiz');
  const archivos = {};
  STATES_8313.canonical.forEach((e, i) => { archivos[`specs/story-1.${i + 1}.md`] = historia(`1.${i + 1}`, e); });
  archivos['specs/story-1.20.md'] = historia('1.20', 'pending');
  archivos['specs/story-1.21.md'] = historia('1.21', 'rarisimo');
  const r = repo(raiz, 'r', { remoto: 'https://github.com/acme/r.git', archivos });
  // la copia de trabajo dice otra cosa que main: manda main
  fs.writeFileSync(path.join(r, 'specs', 'story-1.7.md'), historia('1.7', 'in-progress'));
  fs.writeFileSync(path.join(r, 'specs', 'story-1.1.md'), historia('1.1', 'done'));
  const antes = git(r, 'status', '--porcelain');
  const p = PS.collect(base({ home: casa([{ cwd: r }]) })).proyectos[0];
  const abiertas = Object.fromEntries(p.abiertas.map((a) => [a.id, a.estado]));
  assert.deepStrictEqual(abiertas, { '1.1': 'draft', '1.2': 'backlog', '1.3': 'ready-for-dev', '1.4': 'in-progress', '1.5': 'review', '1.6': 'blocked', '1.20': 'backlog' });
  assert.ok(p.abiertas.every((a) => a.archivo && a.archivo.startsWith('story-1.')), 'cada una con su archivo');
  assert.strictEqual(p.sinLeer, 1, 'el estado desconocido va a sinLeer');
  assert.deepStrictEqual(p.historias.map((h) => h.id).sort(), ['1.3', '1.4', '1.5'], 'las tarjetas siguen siendo las de antes');
  assert.strictEqual(p.commit, git(r, 'rev-parse', 'origin/main'), 'el commit leído');
  assert.strictEqual(git(r, 'status', '--porcelain'), antes, 'el clon quedó igual');
});

test('T2 Abiertas_SoloBorradores_ElProyectoAparece @story-8.313 @ac-1 — un proyecto con sólo draft y backlog está, con abiertas y sin tarjetas', () => {
  const raiz = tmp('raiz');
  const r = repo(raiz, 'r', { remoto: 'https://github.com/acme/r.git', archivos: { 'specs/a.md': historia('2.1', 'draft'), 'specs/b.md': historia('2.2', 'backlog') } });
  const out = PS.collect(base({ home: casa([{ cwd: r }]) }));
  assert.strictEqual(out.proyectos.length, 1, 'el proyecto aparece');
  assert.deepStrictEqual(out.proyectos[0].abiertas.map((a) => a.id).sort(), ['2.1', '2.2']);
  assert.deepStrictEqual(out.proyectos[0].historias, []);
  assert.deepStrictEqual(PS.view({ snap: out, now: Date.now() }).cards, [], 'sin tarjetas');
});

test('T9 RefreshSiSeMovio_ReleeYDejaDeContarLaCerrada @story-8.313 @ac-8 — main avanza con una historia cerrada: se relee y deja de contarse', () => {
  const raiz = tmp('raiz');
  const r = repo(raiz, 'r', { remoto: 'https://github.com/acme/r.git', archivos: { 'specs/a.md': historia('9.1', 'in-progress'), 'specs/b.md': historia('9.2', 'ready-for-dev') } });
  const h = casa([{ cwd: r }]);
  const estado = tmp('estado');
  const read = () => PS.collect(base({ home: h }));
  assert.strictEqual(PS.refresh({ stateDir: estado, read }).ran, true);
  const antes = JSON.parse(fs.readFileSync(snapFile8313(estado), 'utf8')).proyectos[0];
  assert.deepStrictEqual(antes.abiertas.map((a) => a.id).sort(), ['9.1', '9.2']);
  fs.writeFileSync(path.join(r, 'specs', 'a.md'), historia('9.1', 'done'));
  git(r, 'commit', '-qam', 'cierra la 9.1');
  git(r, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const res = PS.refreshIfMoved({ stateDir: estado, read });
  assert.strictEqual(res.ran, true, JSON.stringify(res));
  const despues = JSON.parse(fs.readFileSync(snapFile8313(estado), 'utf8')).proyectos[0];
  assert.notStrictEqual(despues.commit, antes.commit);
  assert.strictEqual(despues.commit, git(r, 'rev-parse', 'origin/main'));
  assert.deepStrictEqual(despues.abiertas.map((a) => a.id), ['9.2'], 'la cerrada ya no cuenta');
});

test('T10 RefreshSiSeMovio_SinCambio_NoEscribe @story-8.313 @ac-9 @ac-12 — sin mover main no lee ni escribe y sale 0; una lectura de antes del cambio se relee', () => {
  const raiz = tmp('raiz');
  const r = repo(raiz, 'r', { remoto: 'https://github.com/acme/r.git', archivos: { 'specs/a.md': historia('10.1', 'review') } });
  const h = casa([{ cwd: r }]);
  // la carpeta de estado de la casa de juguete: la misma que lee la línea de comandos con esa HOME
  const estado = SD_8313.stateDir(h);
  assert.strictEqual(PS.refresh({ stateDir: estado, read: () => PS.collect(base({ home: h })) }).ran, true);
  const bytes = fs.readFileSync(snapFile8313(estado));
  const viejo = (Date.now() - 3600e3) / 1000;
  fs.utimesSync(snapFile8313(estado), viejo, viejo);
  const hora = fs.statSync(snapFile8313(estado)).mtimeMs;
  let leidas = 0;
  for (let i = 0; i < 2; i += 1) {
    const res = PS.refreshIfMoved({ stateDir: estado, read: () => { leidas += 1; return PS.collect(base({ home: h })); } });
    assert.strictEqual(res.ran, false, JSON.stringify(res));
  }
  assert.strictEqual(leidas, 0, 'el lector no corrió');
  const cli = spawnSync(process.execPath, [READER_8313, '--refresh-if-moved'], { encoding: 'utf8', env: { ...process.env, HOME: h, USERPROFILE: h, TYCON_HOME: '' } });
  assert.strictEqual(cli.status, 0, cli.stderr);
  assert.ok(fs.readFileSync(snapFile8313(estado)).equals(bytes), 'los bytes no cambian');
  assert.strictEqual(fs.statSync(snapFile8313(estado)).mtimeMs, hora, 'la hora del archivo no cambia');
  // una lectura de antes del cambio: sin commit ni lugar, cuenta como movida
  const vieja = JSON.parse(bytes.toString());
  for (const p of vieja.proyectos) { delete p.commit; delete p.lugar; delete p.abiertas; }
  fs.writeFileSync(snapFile8313(estado), JSON.stringify(vieja));
  const res = PS.refreshIfMoved({ stateDir: estado, read: () => { leidas += 1; return PS.collect(base({ home: h })); } });
  assert.strictEqual(res.ran, true);
  assert.strictEqual(leidas, 1, 'la releyó');
  assert.ok(Array.isArray(JSON.parse(fs.readFileSync(snapFile8313(estado), 'utf8')).proyectos[0].abiertas));
});

test('T14 Proyecto_NoLeidasYDeTuCopia_SeDicen @story-8.313 @ac-14 — la ilegible va a sinLeer fuera del total; sin rama traída, de tu copia', () => {
  const raiz = tmp('raiz');
  const roto = '---\nstory: "14.9"\nstatus: rarisimo\n---\n# con un estado que no existe\n';
  const r = repo(raiz, 'r', { remoto: 'https://github.com/acme/r.git', archivos: { 'specs/a.md': historia('14.1', 'review'), 'specs/b.md': roto } });
  const p = PS.collect(base({ home: casa([{ cwd: r }]) })).proyectos[0];
  assert.strictEqual(p.sinLeer, 1);
  assert.deepStrictEqual(p.abiertas.map((a) => a.id), ['14.1'], 'la no leída no entra en las abiertas');
  const c = repo(raiz, 'c', { remoto: 'https://github.com/acme/c.git', traida: false, archivos: { 'specs/a.md': historia('14.2', 'draft') } });
  const pc = PS.collect(base({ home: casa([{ cwd: c }]) })).proyectos[0];
  assert.strictEqual(pc.deTuCopia, true);
  assert.strictEqual(pc.commit, null, 'leída de la copia: sin commit con qué comparar');
  assert.strictEqual(pc.lugar.ref, null);
  assert.deepStrictEqual(pc.abiertas.map((a) => a.id), ['14.2']);
});

test('T15 RefreshSiSeMovio_RepoQueNoContesta @story-8.313 @ac-15 — un repo que no contesta cuenta como no movido; una lectura que se cae deja el archivo anterior', () => {
  const estado = tmp('estado');
  const copia = leido8313('copia', '/repos/copia', null, { deTuCopia: true, lugar: { repo: '/repos/copia', ref: null, common: '/repos/copia/.git' } });
  guardar8313(estado, [leido8313('uno', '/repos/uno', 'a'.repeat(40)), leido8313('dos', '/repos/dos', 'b'.repeat(40)), copia]);
  const pedidos = [];
  const git8313 = (cwd, args) => {
    pedidos.push([cwd, ...args].join(' '));
    if (cwd === '/repos/uno') return { ok: false, out: '', err: 'no contesta', timedOut: true };
    return { ok: true, out: `${'c'.repeat(40)}\n`, err: '' };
  };
  // sólo «dos» se movió: el que no contesta no frena la comparación de los demás
  let leidas = 0;
  const res = PS.refreshIfMoved({ stateDir: estado, git: git8313, read: () => { leidas += 1; return lectura([]); } });
  assert.strictEqual(res.ran, true);
  assert.strictEqual(leidas, 1);
  assert.ok(!pedidos.some((x) => x.startsWith('/repos/copia')), 'la leída de la copia no se compara');
  // nada se movió salvo el que no contesta: no relee
  guardar8313(estado, [leido8313('uno', '/repos/uno', 'a'.repeat(40)), leido8313('dos', '/repos/dos', 'c'.repeat(40))]);
  assert.strictEqual(PS.refreshIfMoved({ stateDir: estado, git: git8313, read: () => { leidas += 1; return lectura([]); } }).ran, false);
  assert.strictEqual(leidas, 1);
  // la lectura nueva se cae: queda el archivo anterior y el error sube (la línea de comandos sale distinta de 0)
  guardar8313(estado, [leido8313('dos', '/repos/dos', 'b'.repeat(40))]);
  const bytes = fs.readFileSync(snapFile8313(estado));
  assert.throws(() => PS.refreshIfMoved({ stateDir: estado, git: git8313, read: () => { throw new Error('se cayó'); } }), /se cayó/);
  assert.ok(fs.readFileSync(snapFile8313(estado)).equals(bytes), 'el archivo anterior intacto');
  assert.ok(!fs.existsSync(path.join(estado, 'office', 'project-stories.lock')), 'sin candado colgado');
});

test('Regresion_TodasCerradas_ElProyectoSigueConCero @story-8.313 @ac-2 @ac-13 — un proyecto con todo cerrado en main sigue en la lectura: su número es 0, no «sin proyecto principal»', () => {
  const raiz = tmp('raiz');
  const r = repo(raiz, 'r', { remoto: 'https://github.com/acme/r.git', archivos: { 'specs/a.md': historia('1.1', 'done'), 'specs/b.md': historia('1.2', 'cancelled') } });
  const out = PS.collect(base({ home: casa([{ cwd: r }]) }));
  assert.strictEqual(out.proyectos.length, 1, 'el proyecto leído no desaparece');
  assert.deepStrictEqual(out.proyectos[0].abiertas, []);
  const a = OFFICE_MOD.openStories({ snap: out, coordinator: { sid: 'coord', cwd: r, remote: out.proyectos[0].remoto }, nowMs: Date.now() });
  assert.ok(a.principal, JSON.stringify(a));
  assert.strictEqual(a.linea, 'Abiertas: 0 · 0 en curso · 0 en espera · 0 sin comenzar');
  assert.deepStrictEqual(PS.view({ snap: out, now: Date.now() }).rows, [], 'la tabla no suma una fila vacía');
});

test('T19 Lectura_SoloComandosDeLectura @story-8.313 @ac-20 — collect y --refresh-if-moved sólo piden rev-parse, log, ls-tree y cat-file', () => {
  const raiz = tmp('raiz');
  const r = repo(raiz, 'r', { remoto: 'https://github.com/acme/r.git', archivos: { 'specs/a.md': historia('19.1', 'review') } });
  const c = repo(raiz, 'c', { remoto: 'https://github.com/acme/c.git', traida: false, archivos: { 'specs/a.md': historia('19.2', 'draft') } });
  const h = casa([{ cwd: r }, { cwd: c }]);
  const pedidos = [];
  const real = PS.gitRunner();
  const espia = (cwd, args, o) => { pedidos.push(args.join(' ')); return real(cwd, args, o); };
  const estado = tmp('estado');
  const read = () => PS.collect(base({ home: h, git: espia }));
  PS.refresh({ stateDir: estado, read });
  PS.refreshIfMoved({ stateDir: estado, git: espia, read });
  git(r, 'commit', '-q', '--allow-empty', '-m', 'otra');
  git(r, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.strictEqual(PS.refreshIfMoved({ stateDir: estado, git: espia, read }).ran, true);
  assert.ok(pedidos.length > 0);
  const otros = pedidos.filter((x) => !/^(rev-parse|log|ls-tree|cat-file)\b/.test(x));
  assert.deepStrictEqual(otros, [], `sólo lecturas: ${pedidos.join(' | ')}`);
  assert.ok(!pedidos.some((x) => /^fetch\b/.test(x)), 'ningún fetch');
});

// 🔴 Falla con: `cerradasHoy` sin comparar con el commit de antes de las 0 (sale la que ya estaba cerrada) o leyendo la
// copia en vez de la rama principal.
test('CerradasHoy_SoloLasQuePasaronHoyEnMain — la que pasó a cerrada hoy sale con su hora; la que ya estaba cerrada, la abierta y la de la copia no', () => {
  const raiz = tmp('raiz');
  const ayer = new Date(Date.now() - 2 * DIA).toISOString();
  const r = repo(raiz, 'r', { remoto: 'https://github.com/acme/r.git', fecha: ayer, archivos: { 'specs/a.md': historia('20.1', 'review'), 'specs/b.md': historia('20.2', 'done'), 'specs/c.md': historia('20.3', 'in-progress') } });
  fs.writeFileSync(path.join(r, 'specs', 'a.md'), historia('20.1', 'done'));
  fs.writeFileSync(path.join(r, 'specs', 'b.md'), `${historia('20.2', 'done')}\notra línea\n`);
  fs.writeFileSync(path.join(r, 'specs', 'c.md'), historia('20.3', 'review'));
  git(r, 'commit', '-qam', 'hoy');
  git(r, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  // en la copia, sin llegar a main, otra pasa a cerrada: no cuenta
  fs.writeFileSync(path.join(r, 'specs', 'c.md'), historia('20.3', 'done'));
  git(r, 'commit', '-qam', 'local');
  const antes = Date.now();
  const p = PS.collect(base({ home: casa([{ cwd: r }]) })).proyectos[0];
  assert.deepStrictEqual(p.cerradasHoy.map((h) => [h.id, h.titulo]), [['20.1', 'La historia 20.1']]);
  assert.ok(Math.abs(p.cerradasHoy[0].at - antes) < 120e3, 'la hora es la del commit de hoy');
  // sin rama principal traída no se afirma nada
  const c = repo(raiz, 'c', { remoto: 'https://github.com/acme/c.git', traida: false, archivos: { 'specs/a.md': historia('20.4', 'done') } });
  assert.deepStrictEqual(PS.collect(base({ home: casa([{ cwd: c }]) })).proyectos[0].cerradasHoy, []);
});

// 🔴 Falla con: «Terminados hoy» sólo con las filas del tablero (las historias cerradas hoy en main y los pedidos que
// entraron no salen), o repitiendo lo que una fila hecha ya dice por su historia o su pedido.
test('Kanban_Finished_FromMainAndPrs: «Terminados hoy» suma sin carga manual las historias cerradas hoy en main y los pedidos que entraron; lo que ya dice una fila hecha no se repite', () => {
  const board = OFFICE_MOD.buildBoard({ pendientes: [
    { titulo: 'Fila de la 9.1', estado: 'hecho', realIso: OF.localIsoAt(AHORA - 3 * 60000), historia: '9.1' },
    { titulo: 'Fila del pedido', estado: 'hecho', realIso: OF.localIsoAt(AHORA - 4 * 60000), pedido: { repo: 'pub', numero: 70 } },
  ] });
  const historias = [
    { id: '9.1', titulo: 'Ya la dice la fila', at: AHORA - 5 * 60000, proyecto: 'Acme' },
    { id: '9.2', titulo: 'Cerrada hoy', at: AHORA - 2 * 60000, proyecto: 'Acme' },
  ];
  const pedidos = [
    { repo: 'org/pub', repoName: 'pub', number: 70, title: 'el que ya dice la fila', at: AHORA - 6 * 60000 },
    { repo: 'org/pub', repoName: 'pub', number: 71, title: 'entró hoy', at: AHORA - 60000 },
    { repo: 'biz/proj/priv', repoName: 'priv', number: 6101, title: 'el privado', at: AHORA - 7 * 60000 },
  ];
  const { data } = OF.buildOffice({ wip: OF.wip([]), board, prAnswers: new Map(), enteredPrs: pedidos, projectStories: { snap: { at: new Date(AHORA).toISOString(), proyectos: [{ nombre: 'Acme', abiertas: [], cerradasHoy: historias }] }, runs: [] }, nowMs: AHORA });
  const hechos = data.kanban.columnas.find((c) => c.id === 'hechos').tarjetas;
  assert.deepStrictEqual(hechos.map((t) => t.titulo), ['entró hoy', '9.2 · Cerrada hoy', 'Fila de la 9.1', 'Fila del pedido', 'el privado'], 'lo último primero, sin repetir la 9.1 ni el #70');
  assert.deepStrictEqual([hechos[0].quien, hechos[0].hora], ['pedido #71', hm(AHORA - 60000)]);
  assert.deepStrictEqual([hechos[1].quien, hechos[1].hora, hechos[1].grupo], ['historia cerrada en main', hm(AHORA - 2 * 60000), 'Acme']);
  assert.strictEqual(hechos[4].quien, 'pedido !6101', 'el de Azure, con su marca');
  assert.deepStrictEqual(hechos[0].pedido, OFFICE_MOD.cardPr('org/pub', 71), 'el pedido lleva su enlace');
  assert.strictEqual(hechos[1].local, true, 'la historia es de esta máquina: no viaja al sitio');
  // lo de otro día no entra, ni pasa a la tabla «Hechos»: una lectura vieja no suma
  const otroDia = OF.buildOffice({ wip: OF.wip([]), enteredPrs: [{ repo: 'org/pub', repoName: 'pub', number: 72, title: 'ayer', at: AHORA - 86400000 }], projectStories: { snap: { at: new Date(AHORA).toISOString(), proyectos: [{ nombre: 'Acme', abiertas: [], cerradasHoy: [{ id: '9.3', titulo: 'De ayer', at: AHORA - 86400000 }] }] }, runs: [] }, nowMs: AHORA }).data;
  assert.deepStrictEqual(otroDia.kanban.columnas.find((c) => c.id === 'hechos').tarjetas, []);
  assert.deepStrictEqual(otroDia.kanban.anteriores, []);
});
