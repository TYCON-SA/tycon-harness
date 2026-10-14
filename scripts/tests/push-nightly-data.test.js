'use strict';
// push-nightly-data.test.js — cómo guardan los nocturnos lo que escribieron (story 8.26, tanda H1a · T73).
//
// Lo que no se puede perder:
//   · A `main` llega SÓLO lo que el paso escribió, sobre la punta recién traída. Nunca el commit local de la
//     superposición ni un borrado que venga de ella: con ese commit debajo, el `git push origin HEAD:main` de antes lo
//     subía entero.
//   · Lo nuevo sin seguimiento, lo que el `.gitignore` del árbol ignora, lo borrado, lo renombrado y lo binario viajan
//     igual: un `git add <carpeta>` salteaba en silencio lo ignorado y la noche salía verde sin su archivo del día.
//   · El checkout no se mueve: `HEAD` y el índice quedan como estaban. Lo guardado se encadena aparte.
//   · Dos guardados del mismo trabajo se componen, y si el primero no viajó el segundo lo lleva.
//   · Lo que otro trabajo escribió en la misma carpeta no se borra; un choque de verdad sale rojo nombrando el archivo.
//   · El archivo del día se comprueba ANTES de empujar; la verificación (el sello del tablero) también, sobre lo que
//     se va a publicar y no sobre el disco.
//   · Si no pudo empujar sale 1 diciendo que NO viajó.
//
// Los casos arman un remoto desnudo y el clon de un trabajo con git de verdad. Cero red.
//
// Correr: node --test scripts/tests/push-nightly-data.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'push-nightly-data.js');

function cleanEnv(extra = {}) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) {
    // AGENT_: en un agente de Azure la carpeta temporal del trabajo puede traer el guion de la guarda que guardó la
    // plantilla, y el guion de guardar lo prefiere al del checkout: los casos correrían la guarda de verdad
    // CHECK_TREE_ y RUN_GUARD_: lo que hace salir roja a la guarda de mentira lo fija cada caso, no la máquina
    if (/^(GIT_|TYCON_|HARNESS_|BUILD_|SYSTEM_|AGENT_|CHECK_TREE_|RUN_GUARD_|TF_BUILD)/.test(k)) continue;
    e[k] = v;
  }
  return { ...e, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), 'push-nightly-data-no-global'),
    GIT_AUTHOR_NAME: 'Lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'Lab', GIT_COMMITTER_EMAIL: 'lab@example.com', ...extra };
}
function gitRaw(dir, args) {
  return spawnSync('git', ['-C', dir, ...args], { env: cleanEnv(), maxBuffer: 1 << 28 });
}
function git(dir, args) {
  const r = gitRaw(dir, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.toString('utf8').trim();
}
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `push-nightly-${tag}-`)); dirs.push(d); return d; };

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    if (content === null) { fs.rmSync(abs, { force: true }); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

// El `.gitignore` del interno, en chico: la carpeta de datos entera ignorada y vuelta a incluir por partes. `otra/` no
// está incluida: es el archivo «que el .gitignore del árbol ignora» del AC 60.
const GITIGNORE = ['.dashboard/', '!.dashboard/', '.dashboard/*', '!.dashboard/bench/', '!.dashboard/bench/*.json', '!.dashboard/bench/*.bin', '*.bak', ''].join('\n');
const BINARY = Buffer.from([0, 1, 2, 255, 0, 10, 13, 0, 200]);
// La guarda de la otra mitad (`overlay-harness.js --check-tree`), de mentira y en su lugar de siempre: sale lo que
// diga CHECK_TREE_EXIT (0 si no dice nada) y, si le dan dónde, deja constancia de cómo la llamaron. La de verdad
// tiene sus casos en su propia suite; acá se prueba que el guion la llama, y que sin ella no guarda.
const GUARD_FAKE = 'if (process.env.CHECK_TREE_LOG) require("fs").writeFileSync(process.env.CHECK_TREE_LOG, JSON.stringify({ args: process.argv.slice(2), tree: process.env.HARNESS_TREE }));\n'
  // «kill»: la guarda muere sin llegar a salir (una señal): no deja código de salida
  + 'if (process.env.CHECK_TREE_EXIT === "kill") process.kill(process.pid, "SIGKILL");\n'
  + 'if ((process.env.CHECK_TREE_EXIT || "0") !== "0") console.error("el árbol cambió: scripts/run.sh ##vso[task.complete result=Succeeded;] ##VSO[task.complete result=Succeeded;]");\n'
  + 'process.exit(Number(process.env.CHECK_TREE_EXIT || 0));\n';
/** Lo que la plantilla que trae el arnés deja en el entorno de todo paso que guarda. */
const TREE = 'abc123';
const SEED = {
  '.gitignore': GITIGNORE,
  'scripts/ci/overlay-harness.js': GUARD_FAKE,
  'scripts/run.sh': '#!/bin/sh\necho hola\n',
  'scripts/old.js': 'lo que el público borró\n',
  'scripts/ci/tool.js': 'module.exports = 1;\n',
  '.dashboard/bench/base.json': '{"historico":true}\n',
  '.dashboard/bench/viejo.json': '{"se":"borra"}\n',
  '.dashboard/bench/blob.bin': Buffer.from([9, 0, 9]),
  'inbox/q/pending/a.yaml': 'id: a\nveredicto: pendiente\n',
  'inbox/q/pending/.gitkeep': '',
  'inbox/q/promoted/.gitkeep': 'x\n',
  'artifacts/page.html': 'vieja\n',
  'ultimo.json': '{"ts":"base"}\n',
  'datos/ultimo-banco.json': '{"ts":"base"}\n',
};

/** Un remoto desnudo con `main`, y el clon del trabajo parado en esa punta. */
function world(tag, { overlay = false } = {}) {
  const base = tmp(tag);
  const remote = path.join(base, 'remote.git');
  fs.mkdirSync(remote);
  git(remote, ['init', '--quiet', '--bare']);
  // la rama del remoto se fija: no se hereda del git de la máquina
  git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const seed = path.join(base, 'seed');
  git(base, ['clone', '--quiet', remote, seed]);
  writeFiles(seed, SEED);
  git(seed, ['add', '-A', '-f']);
  git(seed, ['commit', '--quiet', '-m', 'base']);
  git(seed, ['branch', '-M', 'main']);
  git(seed, ['push', '--quiet', 'origin', 'main']);
  const job = path.join(base, 'job');
  git(base, ['clone', '--quiet', remote, job]);
  const w = { base, remote, job, seed };
  if (overlay) {
    // la superposición: lo que el público borró sale, lo nuevo del público entra, y queda en un commit LOCAL
    writeFiles(job, { 'scripts/old.js': null, 'scripts/public-new.js': 'del público\n', 'scripts/run.sh': '#!/bin/sh\necho del publico\n' });
    git(job, ['add', '-A']);
    git(job, ['commit', '--quiet', '-m', 'arnés de GitHub [superposición local, no se empuja]']);
  }
  w.head = git(job, ['rev-parse', 'HEAD']);
  w.index = git(job, ['write-tree']);
  return w;
}
/** Otro clon adelanta `main` mientras el trabajo corre. Devuelve el commit que quedó en la punta. */
function rival(w, files, message = 'rival') {
  const dir = path.join(w.base, `rival-${Math.random().toString(16).slice(2, 8)}`);
  git(w.base, ['clone', '--quiet', w.remote, dir]);
  writeFiles(dir, files);
  git(dir, ['add', '-A', '-f']);
  git(dir, ['commit', '--quiet', '-m', message]);
  git(dir, ['push', '--quiet', 'origin', 'HEAD:main']);
  return git(dir, ['rev-parse', 'HEAD']);
}
function run(w, args, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: w.job, env: cleanEnv(env), encoding: 'utf8', maxBuffer: 1 << 28 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
// todo paso que guarda corre con la variable de la plantilla; el caso de «sin la variable» la saca a propósito
const save = (w, rest, env) => run(w, ['save', '--wait-ms', '0', ...rest], { HARNESS_TREE: TREE, ...env });
const saveWithoutTree = (w, rest, env) => run(w, ['save', '--wait-ms', '0', ...rest], env);
const inMain = (w, rel) => { const r = gitRaw(w.remote, ['show', `main:${rel}`]); return r.status === 0 ? r.stdout : null; };
const mainText = (w, rel) => { const b = inMain(w, rel); return b === null ? null : b.toString('utf8'); };
const mainTip = (w) => git(w.remote, ['rev-parse', 'main']);
const changedBy = (w, commit) => git(w.remote, ['diff', '--name-only', `${commit}^`, commit]).split('\n').filter(Boolean).sort();
/** El checkout no se movió: el mismo commit y el mismo índice que antes de guardar. */
function assertCheckoutUntouched(w) {
  assert.strictEqual(git(w.job, ['rev-parse', 'HEAD']), w.head, 'HEAD es el mismo de antes de guardar');
  assert.strictEqual(git(w.job, ['write-tree']), w.index, 'el índice del checkout no se tocó');
  assert.strictEqual(git(w.job, ['symbolic-ref', '-q', '--short', 'HEAD']), 'main', 'ni cambió de rama');
}
/** Un remoto que rechaza todo empuje, hasta que se le saca el gancho. */
function rejectPushes(w) {
  const hook = path.join(w.remote, 'hooks', 'pre-receive');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  // lo que el remoto dice al rechazar trae un retorno de carro y algo que Azure leería como una orden
  fs.writeFileSync(hook, '#!/bin/sh\nprintf \'rechazado a propósito\\r##vso[task.complete result=Succeeded;] ##[error]pintado por el remoto\\n\' >&2\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  return () => fs.rmSync(hook, { force: true });
}

test('T73 Nightlies_SaveOnlyWhatTheStepWrote_NeverTheOverlayCommit_FindingsScriptKeepsTheTree: con el commit local debajo y main adelantada llega sólo lo que el paso escribió, completo', () => {
  const w = world('overlay', { overlay: true });
  const rivalTip = rival(w, { 'otro.txt': 'del rival\n' });
  // la noche: uno nuevo sin seguimiento, uno que el .gitignore ignora, un borrado, un renombre con cambio y un binario
  writeFiles(w.job, {
    '.dashboard/bench/banco-2026-01-02.json': '{"dia":"2026-01-02"}\n',
    '.dashboard/otra/ignorado.json': '{"ignorado":"por el gitignore"}\n',
    '.dashboard/bench/viejo.json': null,
    '.dashboard/bench/blob.bin': BINARY,
    '.dashboard/bench/.DS_Store': 'basura del sistema',
    'inbox/q/pending/a.yaml': null,
    'inbox/q/promoted/a.yaml': 'id: a\nveredicto: util\n',
    'scripts/run.sh': '#!/bin/sh\necho lo ensuciaron las suites\n',   // código sucio en el disco: no es del paso
  });
  const r = save(w, ['--message', 'chore(banco): corrida nocturna [nocturno]', '--', '.dashboard/bench', '.dashboard/otra', 'inbox/q']);
  assert.strictEqual(r.code, 0, r.out);

  assert.strictEqual(mainText(w, '.dashboard/bench/banco-2026-01-02.json'), '{"dia":"2026-01-02"}\n', 'el archivo nuevo, sin seguimiento');
  assert.strictEqual(mainText(w, '.dashboard/otra/ignorado.json'), '{"ignorado":"por el gitignore"}\n', 'el que el .gitignore del árbol ignora viaja igual');
  assert.strictEqual(inMain(w, '.dashboard/bench/viejo.json'), null, 'lo que la noche borró, se borra');
  assert.ok(BINARY.equals(inMain(w, '.dashboard/bench/blob.bin')), 'el binario llega byte a byte');
  assert.strictEqual(inMain(w, 'inbox/q/pending/a.yaml'), null, 'el renombre: sale de pending');
  assert.strictEqual(mainText(w, 'inbox/q/promoted/a.yaml'), 'id: a\nveredicto: util\n', 'y entra en promoted con su cambio');
  assert.strictEqual(inMain(w, '.dashboard/bench/.DS_Store'), null, 'la basura del sistema no viaja');

  // ni el commit local ni sus borrados: main conserva lo que la superposición sacó y no recibe lo que puso
  assert.strictEqual(mainText(w, 'scripts/old.js'), SEED['scripts/old.js'], 'el borrado de la superposición NO llegó a main');
  assert.strictEqual(inMain(w, 'scripts/public-new.js'), null, 'lo que la superposición agregó NO llegó a main');
  assert.strictEqual(mainText(w, 'scripts/run.sh'), SEED['scripts/run.sh'], 'ni lo que cambió, ni el código sucio del disco');
  assert.strictEqual(mainText(w, 'otro.txt'), 'del rival\n', 'lo que main trajo sigue ahí');

  const tip = mainTip(w);
  assert.strictEqual(git(w.remote, ['rev-parse', `${tip}^`]), rivalTip, 'el commit va sobre la punta recién traída');
  assert.strictEqual(git(w.remote, ['rev-list', '--count', `${rivalTip}..${tip}`]), '1', 'un solo commit: el del paso');
  assert.strictEqual(git(w.remote, ['log', '-1', '--format=%s', tip]), 'chore(banco): corrida nocturna [nocturno]');
  for (const f of changedBy(w, tip)) assert.match(f, /^(\.dashboard\/(bench|otra)|inbox\/q)\//, `${f}: fuera de las rutas del paso`);
  assert.ok(!git(w.remote, ['rev-list', tip]).split('\n').includes(w.head), 'el commit local de la superposición no está en la historia de main');
  assertCheckoutUntouched(w);
  assert.strictEqual(fs.readFileSync(path.join(w.job, 'scripts/public-new.js'), 'utf8'), 'del público\n', 'el código del árbol sigue siendo el de la superposición');
});

test('T73 el otro trabajo del banco escribió la misma carpeta: no se le borra nada', () => {
  const w = world('twin');
  // el trabajo Banco ya subió su foto del día; este trabajo (el reporte de suites) no la tiene en su disco
  rival(w, { '.dashboard/bench/banco-2026-01-02.json': '{"del":"otro trabajo"}\n', 'ultimo.json': '{"ts":"del otro"}\n' });
  writeFiles(w.job, { '.dashboard/bench/suites-2026-01-02.json': '{"suites":1}\n' });
  const r = save(w, ['--message', 'chore(suites): corrida nocturna [nocturno]', '--', '.dashboard/bench']);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(mainText(w, '.dashboard/bench/banco-2026-01-02.json'), '{"del":"otro trabajo"}\n', 'la foto del otro trabajo sigue en main');
  assert.strictEqual(mainText(w, '.dashboard/bench/suites-2026-01-02.json'), '{"suites":1}\n');
  assert.strictEqual(mainText(w, 'ultimo.json'), '{"ts":"del otro"}\n', 'y lo que no es de este paso no se pisa');
  assertCheckoutUntouched(w);
});

test('T73 una ruta con comodín lleva sólo lo que nombra: lo nuevo que coincide viaja, el vecino no', () => {
  const w = world('glob');
  writeFiles(w.job, {
    '.dashboard/sdlc-stage-2026-01-02.json': '{"dia":2}\n',          // ignorado por el .gitignore de juguete, y nuevo
    '.dashboard/metrics-ajeno.json': '{"no":"es de este paso"}\n',
    '.dashboard/proyectos/uno.json': '{"p":1}\n',
    '.dashboard/proyectos/notas.txt': 'no es un json\n',
    // el comodín no cruza carpetas, como el del shell que resolvía estas rutas antes
    '.dashboard/proyectos/sub/dos.json': '{"de":"una subcarpeta"}\n',
  });
  const r = save(w, ['--message', 'chore(metricas): snapshot [pipeline nocturno]', '--', '.dashboard/sdlc-stage-*.json', '.dashboard/proyectos/*.json']);
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(changedBy(w, mainTip(w)), ['.dashboard/proyectos/uno.json', '.dashboard/sdlc-stage-2026-01-02.json']);
  assertCheckoutUntouched(w);
});

test('T73 dos guardados del mismo trabajo se componen: el segundo lleva sólo lo que cambió desde el primero', () => {
  const w = world('chain', { overlay: true });
  // 1 · la pasada de sólo anotar: una línea más en la ficha
  writeFiles(w.job, { 'inbox/q/pending/a.yaml': 'id: a\nveredicto: pendiente\nrechazado: 2026-01-01\n' });
  let r = save(w, ['--message', 'q: pull requests anotados [nocturno]', '--', 'inbox/q']);
  assert.strictEqual(r.code, 0, r.out);
  const first = mainTip(w);
  // 2 · la noche: otra línea PEGADA a la anterior (el caso que una fusión contra HEAD daría por choque) y la foto
  writeFiles(w.job, {
    'inbox/q/pending/a.yaml': 'id: a\nveredicto: pendiente\nrechazado: 2026-01-01\nmotivo_rechazo: "no aplica"\n',
    '.dashboard/bench/banco-2026-01-02.json': '{"dia":2}\n',
  });
  r = save(w, ['--message', 'chore(q): revisión nocturna [nocturno]', '--', '.dashboard/bench', 'inbox/q']);
  assert.strictEqual(r.code, 0, r.out);
  const second = mainTip(w);
  assert.strictEqual(git(w.remote, ['rev-parse', `${second}^`]), first, 'el segundo va sobre el primero');
  assert.strictEqual(mainText(w, 'inbox/q/pending/a.yaml'), 'id: a\nveredicto: pendiente\nrechazado: 2026-01-01\nmotivo_rechazo: "no aplica"\n');
  assert.deepStrictEqual(changedBy(w, second), ['.dashboard/bench/banco-2026-01-02.json', 'inbox/q/pending/a.yaml']);
  // 3 · un tercero sin nada nuevo no inventa un commit
  r = save(w, ['--message', 'nada', '--', '.dashboard/bench', 'inbox/q']);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /Nada nuevo/i);
  assert.strictEqual(mainTip(w), second, 'sin cambios no empuja');
  assertCheckoutUntouched(w);
});

test('T73 tres rechazos: sale 1 diciendo que NO viajó; y el guardado siguiente lleva lo que quedó sin viajar', () => {
  const w = world('rejected', { overlay: true });
  const before = mainTip(w);
  const allow = rejectPushes(w);
  writeFiles(w.job, { 'inbox/q/pending/a.yaml': 'id: a\nveredicto: pendiente\nrechazado: 2026-01-01\n' });
  let r = save(w, ['--message', 'q: anotados [nocturno]', '--', 'inbox/q']);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /##vso\[task\.logissue type=error\]/, 'lo denuncia como error de la corrida');
  assert.match(r.out, /NO viajó/, 'y dice que no viajó');
  assert.match(r.out, /3 intentos/, 'después de tres intentos');
  assert.match(r.out, /intento 1: el empuje a main fue rechazado[^\n]*rechazado a propósito/, 'muestra lo que dijo el remoto');
  assert.doesNotMatch(r.out, /##vso\[task\.complete/i, 'pero lo que dijo el remoto no puede leerse como una orden de Azure');
  assert.doesNotMatch(r.out, /##\[error\]/, 'ni pintar una línea de error que el guion no escribió');
  assert.doesNotMatch(r.out, /\r/, 'ni cortar la línea con un retorno de carro');
  assert.strictEqual(mainTip(w), before, 'main no se movió');
  assertCheckoutUntouched(w);
  assert.strictEqual(fs.readFileSync(path.join(w.job, 'inbox/q/pending/a.yaml'), 'utf8'), 'id: a\nveredicto: pendiente\nrechazado: 2026-01-01\n', 'lo anotado sigue en el disco: la noche lo cuenta');

  // el paso que guarda la noche lo vuelve a llevar (el respaldo que promete open-pr-per-finding.sh)
  allow();
  writeFiles(w.job, { '.dashboard/bench/banco-2026-01-02.json': '{"dia":2}\n' });
  r = save(w, ['--message', 'chore(q): revisión nocturna [nocturno]', '--', '.dashboard/bench', 'inbox/q']);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(mainText(w, 'inbox/q/pending/a.yaml'), 'id: a\nveredicto: pendiente\nrechazado: 2026-01-01\n', 'lo que no había viajado, viaja con la noche');
  assert.strictEqual(mainText(w, '.dashboard/bench/banco-2026-01-02.json'), '{"dia":2}\n');
});

test('T73 main avanzó entre el fetch y el empuje: vuelve a trasladar sobre la punta nueva', () => {
  const w = world('race');
  // el primer empuje rebota: un gancho deja pasar al rival y rechaza al trabajo una sola vez
  const flag = path.join(w.base, 'once');
  const hook = path.join(w.remote, 'hooks', 'pre-receive');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, `#!/bin/sh\nif [ ! -f "${flag.replace(/\\/g, '/')}" ]; then : > "${flag.replace(/\\/g, '/')}"; echo "una vez" >&2; exit 1; fi\nexit 0\n`);
  fs.chmodSync(hook, 0o755);
  writeFiles(w.job, { 'ultimo.json': '{"ts":"nuevo"}\n' });
  const r = save(w, ['--message', 'chore: reporte [nocturno]', '--', 'ultimo.json']);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(fs.existsSync(flag), 'el caso ejercitó un rechazo');
  assert.strictEqual(mainText(w, 'ultimo.json'), '{"ts":"nuevo"}\n');
});

test('T73 en un clon recortado y con HEAD suelto (el checkout de un agente) guarda y trae igual', () => {
  const w = world('agent');
  // más historia en main, para que el recorte deje algo afuera
  rival(w, { 'scripts/run.sh': '#!/bin/sh\necho dos\n' });
  rival(w, { 'scripts/run.sh': '#!/bin/sh\necho tres\n' });
  const job = path.join(w.base, 'agent-job');
  git(w.base, ['clone', '--quiet', '--depth', '1', `file://${w.remote.replace(/\\/g, '/')}`, job]);
  git(job, ['checkout', '--quiet', '--detach', 'HEAD']);
  assert.strictEqual(git(job, ['rev-parse', '--is-shallow-repository']), 'true', 'el clon del caso está recortado');
  const head = git(job, ['rev-parse', 'HEAD']);
  const agent = { ...w, job };
  // main avanza dos commits mientras el trabajo corre
  rival(w, { 'otro.txt': 'uno\n' });
  const tip = rival(w, { 'otro.txt': 'dos\n', '.dashboard/bench/foto-nueva.json': '{}\n' });
  writeFiles(job, { '.dashboard/bench/banco-2026-01-02.json': '{"dia":2}\n' });
  let r = save(agent, ['--message', 'chore(banco): corrida nocturna [nocturno]', '--', '.dashboard/bench']);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(mainText(w, '.dashboard/bench/banco-2026-01-02.json'), '{"dia":2}\n');
  assert.strictEqual(git(w.remote, ['rev-parse', 'main^']), tip, 'sobre la punta recién traída');
  assert.strictEqual(mainText(w, 'otro.txt'), 'dos\n');
  assert.strictEqual(git(job, ['rev-parse', 'HEAD']), head, 'HEAD sigue suelto en el mismo commit');
  assert.strictEqual(gitRaw(job, ['symbolic-ref', '-q', 'HEAD']).status, 1, 'y no quedó en ninguna rama');
  r = run(agent, ['sync', '--', '.dashboard']);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(fs.existsSync(path.join(job, '.dashboard/bench/foto-nueva.json')), 'sync trae lo que main sumó');
  assert.strictEqual(git(job, ['rev-parse', 'HEAD']), head);
});

test('T73 un choque de verdad sale rojo nombrando el archivo, sin empujar', () => {
  const w = world('conflict');
  const tip = rival(w, { 'ultimo.json': '{"ts":"otra corrida"}\n' });
  writeFiles(w.job, { 'ultimo.json': '{"ts":"esta corrida"}\n' });
  const r = save(w, ['--message', 'chore: reporte [nocturno]', '--', 'ultimo.json']);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /ultimo\.json/, 'nombra el archivo que chocó');
  assert.match(r.out, /##vso\[task\.logissue type=error\]/);
  assert.match(r.out, /NO viajó/);
  assert.strictEqual(mainTip(w), tip, 'main no se movió');
});

test('T73 sin cambios no empuja y sale 0', () => {
  const w = world('nothing', { overlay: true });
  const before = mainTip(w);
  const r = save(w, ['--message', 'nada', '--', '.dashboard/bench', 'inbox/q', 'no/existe']);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /Nada nuevo/i);
  assert.strictEqual(mainTip(w), before);
  assertCheckoutUntouched(w);
});

test('T73 el archivo del día se comprueba ANTES de empujar', () => {
  // falta: rojo, y nada llega
  let w = world('daily-missing');
  let before = mainTip(w);
  writeFiles(w.job, { '.dashboard/bench/otra-cosa.json': '{}\n' });
  let r = save(w, ['--message', 'm', '--today', '2026-01-02', '--require-daily', '.dashboard/bench/banco-{day}.json', '--', '.dashboard/bench']);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /banco-2026-01-02\.json/, 'nombra el archivo que falta');
  assert.match(r.out, /NO viajó/);
  assert.strictEqual(mainTip(w), before, 'sin el archivo del día no se empuja nada');

  // está el de hoy: viaja
  w = world('daily-today');
  writeFiles(w.job, { '.dashboard/bench/banco-2026-01-02.json': '{}\n' });
  r = save(w, ['--message', 'm', '--today', '2026-01-02', '--require-daily', '.dashboard/bench/banco-{day}.json', '--', '.dashboard/bench']);
  assert.strictEqual(r.code, 0, r.out);
  assert.notStrictEqual(inMain(w, '.dashboard/bench/banco-2026-01-02.json'), null);

  // la corrida cruzó la medianoche: el paso escribió el de ayer, y cuenta
  w = world('daily-midnight');
  writeFiles(w.job, { '.dashboard/bench/banco-2026-01-01.json': '{}\n' });
  r = save(w, ['--message', 'm', '--today', '2026-01-02', '--require-daily', '.dashboard/bench/banco-{day}.json', '--', '.dashboard/bench']);
  assert.strictEqual(r.code, 0, r.out);

  // el de ayer ya estaba en main y esta noche no escribió ninguno: NO cuenta (sería el de anoche, en silencio)
  w = world('daily-stale');
  rival(w, { '.dashboard/bench/banco-2026-01-01.json': '{"de":"anoche"}\n' });
  git(w.job, ['pull', '--quiet', '--ff-only']);
  before = mainTip(w);
  writeFiles(w.job, { '.dashboard/bench/otra-cosa.json': '{}\n' });
  r = save(w, ['--message', 'm', '--today', '2026-01-02', '--require-daily', '.dashboard/bench/banco-{day}.json', '--', '.dashboard/bench']);
  assert.strictEqual(r.code, 1, r.out);
  assert.strictEqual(mainTip(w), before);

  // --require: una ruta fija que tiene que estar en lo que se empuja
  w = world('require');
  before = mainTip(w);
  writeFiles(w.job, { '.dashboard/bench/x.json': '{}\n' });
  r = save(w, ['--message', 'm', '--require', 'artifacts/no-esta.html', '--', '.dashboard/bench']);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /artifacts\/no-esta\.html/);
  assert.strictEqual(mainTip(w), before);
});

test('T73 «nada nuevo» no es «todo bien»: sin cambios y sin el archivo del día en main, rojo; si ya estaba, 0', () => {
  const daily = ['--today', '2026-01-02', '--require-daily', '.dashboard/bench/banco-{day}.json'];
  // el paso no escribió nada y main no tiene la foto de hoy: la noche no midió
  let w = world('idle-red');
  let before = mainTip(w);
  let r = save(w, ['--message', 'm', ...daily, '--', '.dashboard/bench']);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /banco-2026-01-02\.json/, 'nombra el archivo del día que falta');
  assert.match(r.out, /##vso\[task\.logissue type=error\]/);
  assert.doesNotMatch(r.out, /^Nada nuevo/m, 'no dice «nada nuevo» como si estuviera bien');
  assert.strictEqual(mainTip(w), before);

  // una corrida repetida: la foto de hoy ya está en main y esta vez no cambió nada → 0
  w = world('idle-green');
  rival(w, { '.dashboard/bench/banco-2026-01-02.json': '{"dia":2}\n' });
  before = mainTip(w);
  r = save(w, ['--message', 'm', ...daily, '--', '.dashboard/bench']);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /Nada nuevo/);
  assert.strictEqual(mainTip(w), before);

  // lo mismo con una ruta fija
  w = world('idle-require');
  r = save(w, ['--message', 'm', '--require', 'artifacts/no-esta.html', '--', '.dashboard/bench']);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /artifacts\/no-esta\.html/);
  r = save(w, ['--message', 'm', '--require', 'artifacts/page.html', '--', '.dashboard/bench']);
  assert.strictEqual(r.code, 0, r.out);

  // el paso escribió lo mismo que main ya tiene (no hay nada que empujar), pero la foto del día no está: rojo
  w = world('same-red');
  rival(w, { '.dashboard/bench/otra-cosa.json': '{"igual":true}\n' });
  before = mainTip(w);
  writeFiles(w.job, { '.dashboard/bench/otra-cosa.json': '{"igual":true}\n' });
  r = save(w, ['--message', 'm', ...daily, '--', '.dashboard/bench']);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /banco-2026-01-02\.json/);
  assert.strictEqual(mainTip(w), before);

  // el paso escribió lo mismo que main ya tiene, y la foto del día está: 0, lo dice, y deja anotado lo guardado
  w = world('same-green');
  rival(w, { '.dashboard/bench/banco-2026-01-02.json': '{"dia":2}\n' });
  before = mainTip(w);
  writeFiles(w.job, { '.dashboard/bench/banco-2026-01-02.json': '{"dia":2}\n' });
  r = save(w, ['--message', 'm', ...daily, '--', '.dashboard/bench']);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /ya tiene lo que escribió el paso/);
  assert.strictEqual(mainTip(w), before, 'no hay nada que empujar');
  // …anotado: el guardado siguiente lleva sólo lo que cambió desde ahí (una línea pegada no choca)
  writeFiles(w.job, { '.dashboard/bench/banco-2026-01-02.json': '{"dia":2}\n{"mas":1}\n' });
  r = save(w, ['--message', 'm2', ...daily, '--', '.dashboard/bench']);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(git(w.job, ['rev-list', '--count', `${w.head}..refs/nightly-data/base`]), '2', 'los dos guardados quedaron encadenados');
  assert.strictEqual(mainText(w, '.dashboard/bench/banco-2026-01-02.json'), '{"dia":2}\n{"mas":1}\n');

  // …y en esa misma rama la verificación del paso también corre: si lo publicado no pasa, rojo
  w = world('same-verify-red');
  rival(w, { 'ultimo.json': '{"ts":"igual"}\n' });
  writeFiles(w.job, { 'ultimo.json': '{"ts":"igual"}\n' });
  r = save(w, ['--message', 'm', '--verify', `"${process.execPath}" -e "process.exit(3)"`, '--', 'ultimo.json']);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /no pasa la verificación/);
  assert.ok(gitRaw(w.job, ['rev-parse', '--verify', '--quiet', 'refs/nightly-data/base']).status !== 0, 'un guardado que salió rojo no deja la base adelantada');

  // sin exigir nada, sin cambios sale 0 sin hablar con el remoto
  w = world('idle-plain');
  git(w.job, ['remote', 'set-url', 'origin', path.join(w.base, 'no-existe.git')]);
  r = save(w, ['--message', 'm', '--', '.dashboard/bench']);
  assert.strictEqual(r.code, 0, r.out);
  // …y exigiendo, si no puede traer la rama no adivina: rojo
  r = save(w, ['--message', 'm', ...daily, '--', '.dashboard/bench']);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /no pude traer/);
});

test('T73 si la rama no se puede traer, sale 1 diciendo que NO viajó', () => {
  const w = world('unreachable');
  writeFiles(w.job, { 'ultimo.json': '{"ts":"nuevo"}\n' });
  git(w.job, ['remote', 'set-url', 'origin', path.join(w.base, 'no-existe.git')]);
  const r = save(w, ['--message', 'm', '--', 'ultimo.json']);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /no pude traer origin\/main/);
  assert.match(r.out, /3 intentos/);
  assert.match(r.out, /NO viajó/);
  assertCheckoutUntouched(w);
  // sync, lo mismo con su propio texto: los datos no se trajeron (y no dice que algo «no viajó»)
  const s = run(w, ['sync', '--', '.dashboard']);
  assert.strictEqual(s.code, 1, s.out);
  assert.match(s.out, /##vso\[task\.logissue type=error\][^\n]*no pude traer origin\/main[^\n]*los datos NO se trajeron/);
  assert.doesNotMatch(s.out, /NO viajó/);
});

test('T73 la constancia: ilegible sale rojo (no se adivina qué se guardó); si no coincide con su referencia, avisa y vuelve a llevar todo', () => {
  const w = world('state');
  const stateFile = path.join(git(w.job, ['rev-parse', '--absolute-git-dir']), 'nightly-data.json');
  writeFiles(w.job, { 'ultimo.json': '{"ts":"1"}\n' });
  let r = save(w, ['--message', 'uno', '--', 'ultimo.json']);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(fs.existsSync(stateFile), 'un guardado que viajó deja su constancia');
  const first = mainTip(w);

  // la referencia se perdió y el archivo quedó: no coinciden → aviso en naranja, y el guardado parte de HEAD
  git(w.job, ['update-ref', '-d', 'refs/nightly-data/base']);
  writeFiles(w.job, { '.dashboard/bench/x.json': '{}\n' });
  r = save(w, ['--message', 'dos', '--', 'ultimo.json', '.dashboard/bench']);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /##vso\[task\.logissue type=warning\][^\n]*constancia/);
  assert.strictEqual(mainText(w, 'ultimo.json'), '{"ts":"1"}\n');
  assert.deepStrictEqual(changedBy(w, mainTip(w)), ['.dashboard/bench/x.json'], 'lo que ya estaba en main no se duplica ni se deshace');
  assert.strictEqual(git(w.remote, ['rev-parse', 'main^']), first);

  // el archivo está y no se puede leer: rojo, y nada viaja
  fs.writeFileSync(stateFile, '{ esto no es json');
  const before = mainTip(w);
  writeFiles(w.job, { '.dashboard/bench/y.json': '{}\n' });
  r = save(w, ['--message', 'tres', '--', '.dashboard/bench']);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /constancia[^\n]*ilegible/);
  assert.match(r.out, /NO viajó/);
  assert.strictEqual(mainTip(w), before);
});

test('T73 si el empuje ya viajó y la constancia no se puede escribir, NO dice que no viajó: avisa y sale 0', () => {
  const w = world('state-after-push');
  // el temporal de la constancia ocupado por una carpeta: escribirla falla, después de empujar
  fs.mkdirSync(path.join(git(w.job, ['rev-parse', '--absolute-git-dir']), 'nightly-data.json.tmp'));
  writeFiles(w.job, { 'ultimo.json': '{"ts":"viajó"}\n' });
  let r = save(w, ['--message', 'uno', '--', 'ultimo.json']);
  assert.strictEqual(mainText(w, 'ultimo.json'), '{"ts":"viajó"}\n', 'el empuje viajó');
  assert.strictEqual(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /NO viajó/, 'no miente: lo guardado está en main');
  assert.match(r.out, /##vso\[task\.logissue type=warning\][^\n]*constancia/, 'lo dice en naranja');
  // y el guardado siguiente, sin constancia, parte de HEAD y no deshace ni duplica nada
  const first = mainTip(w);
  writeFiles(w.job, { '.dashboard/bench/x.json': '{}\n' });
  r = save(w, ['--message', 'dos', '--', 'ultimo.json', '.dashboard/bench']);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(git(w.remote, ['rev-parse', 'main^']), first);
  assert.strictEqual(mainText(w, 'ultimo.json'), '{"ts":"viajó"}\n');
});

test('T73 lo que se extrae para verificar son archivos: un enlace simbólico de la rama no se sigue', { skip: process.platform === 'win32' }, () => {
  const w = world('symlink');
  const outside = path.join(w.base, 'afuera.txt');
  fs.writeFileSync(outside, 'no es del repo\n');
  const dir = path.join(w.base, 'rival-link');
  git(w.base, ['clone', '--quiet', w.remote, dir]);
  fs.symlinkSync(outside, path.join(dir, '.dashboard/bench/enlace'));
  git(dir, ['add', '-A', '-f']);
  // y un submódulo (una entrada que apunta a un commit de otro repo): tampoco es un archivo
  git(dir, ['update-index', '--add', '--cacheinfo', `160000,${git(dir, ['rev-parse', 'HEAD'])},.dashboard/bench/submodulo`]);
  git(dir, ['commit', '--quiet', '-m', 'un enlace y un submódulo']); git(dir, ['push', '--quiet', 'origin', 'HEAD:main']);
  const seen = path.join(w.base, 'seen.json');
  const verifier = path.join(w.base, 'verify.js');
  fs.writeFileSync(verifier, 'const fs=require("fs"),p=require("path");const d=p.join(process.env.PUSH_DIR,".dashboard/bench");'
    + `fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify(fs.readdirSync(d).sort()));\n`);
  writeFiles(w.job, { 'artifacts/page.html': 'nueva\n' });
  const r = save(w, ['--message', 'm', '--verify', `"${process.execPath}" "${verifier}"`, '--verify-export', '.dashboard', '--', 'artifacts/page.html']);
  assert.strictEqual(r.code, 0, r.out);
  const files = JSON.parse(fs.readFileSync(seen, 'utf8'));
  assert.ok(files.includes('base.json'), 'los archivos se extraen');
  assert.ok(!files.includes('enlace'), 'el enlace no');
  assert.ok(!files.includes('submodulo'), 'el submódulo tampoco');
});

// ── lo que confirmó el pase adversarial (2026-10-11): cada caso nació en rojo, con la prueba que lo reprodujo ──────────
test('T73 el archivo del día con acento en el nombre: el de ayer que el paso escribió cuenta (las rutas no llegan escapadas)', () => {
  const w = world('accent');
  writeFiles(w.job, { '.dashboard/bench/día-2026-01-01.json': '{"dia":1}\n' });
  let r = save(w, ['--message', 'm', '--today', '2026-01-02', '--require-daily', '.dashboard/bench/día-{day}.json', '--', '.dashboard/bench']);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(mainText(w, '.dashboard/bench/día-2026-01-01.json'), '{"dia":1}\n');
  // …y el que choca se nombra como se llama, no escapado en octal y entre comillas
  rival(w, { '.dashboard/bench/día-2026-01-01.json': '{"dia":"de otra corrida"}\n' });
  writeFiles(w.job, { '.dashboard/bench/día-2026-01-01.json': '{"dia":"de esta corrida"}\n' });
  r = save(w, ['--message', 'm', '--', '.dashboard/bench']);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /choca con lo que main trae en: \.dashboard\/bench\/día-2026-01-01\.json/);
});

test('T73 BORRAR el archivo de ayer no es haberlo escrito: sin el de hoy, rojo', () => {
  const w = world('deleted-yesterday');
  rival(w, { '.dashboard/bench/banco-2026-01-01.json': '{"de":"anoche"}\n' });
  git(w.job, ['pull', '--quiet', '--ff-only']);
  const before = mainTip(w);
  writeFiles(w.job, { '.dashboard/bench/banco-2026-01-01.json': null, '.dashboard/bench/otra-cosa.json': '{}\n' });
  const r = save(w, ['--message', 'm', '--today', '2026-01-02', '--require-daily', '.dashboard/bench/banco-{day}.json', '--', '.dashboard/bench']);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /banco-2026-01-02\.json/);
  assert.strictEqual(mainTip(w), before, 'no empujó un commit sin ninguna foto del día');
});

test('T73 el patrón del archivo del día puede llevar la fecha más de una vez (en la carpeta y en el nombre)', () => {
  const w = world('day-twice');
  writeFiles(w.job, { '.dashboard/bench/2026-01-02/foto-2026-01-02.json': '{}\n' });
  const r = save(w, ['--message', 'm', '--today', '2026-01-02', '--require-daily', '.dashboard/bench/{day}/foto-{day}.json', '--', '.dashboard/bench']);
  assert.strictEqual(r.code, 0, r.out);
});

test('T73 la basura de la máquina no viaja NUNCA: tampoco si ya estaba versionada y la noche la cambió o la borró', () => {
  const w = world('tracked-junk');
  // alguien versionó basura alguna vez: está en main y en el checkout
  rival(w, { '.dashboard/bench/viejo.bak': 'copia vieja\n', '.dashboard/bench/.DS_Store': 'del sistema\n' });
  git(w.job, ['pull', '--quiet', '--ff-only']);
  writeFiles(w.job, {
    '.dashboard/bench/viejo.bak': 'la noche lo cambió\n',
    '.dashboard/bench/.DS_Store': null,
    '.dashboard/bench/banco-2026-01-02.json': '{}\n',
    // y basura NUEVA en la misma corrida: las dos clases salen juntas
    '.dashboard/bench/nuevo.swp': 'del editor\n',
    '.dashboard/bench/sub/otra.bak': 'otra copia\n',
  });
  const r = save(w, ['--message', 'm', '--', '.dashboard/bench']);
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(changedBy(w, mainTip(w)), ['.dashboard/bench/banco-2026-01-02.json'], 'viaja sólo el dato');
  assert.strictEqual(mainText(w, '.dashboard/bench/viejo.bak'), 'copia vieja\n', 'el cambio a la basura no viajó');
  assert.strictEqual(mainText(w, '.dashboard/bench/.DS_Store'), 'del sistema\n', 'ni su borrado');
});

test('T73 un enlace simbólico que quedó en una carpeta del paso no viaja a main, y se avisa', { skip: process.platform === 'win32' }, () => {
  const w = world('symlink-saved');
  writeFiles(w.job, { '.dashboard/bench/banco-2026-01-02.json': '{}\n' });
  fs.symlinkSync('/etc/hosts', path.join(w.job, '.dashboard/bench/enlace'));
  const r = save(w, ['--message', 'm', '--', '.dashboard/bench']);
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(changedBy(w, mainTip(w)), ['.dashboard/bench/banco-2026-01-02.json']);
  assert.strictEqual(git(w.remote, ['ls-tree', '-r', 'main', '--', '.dashboard/bench/enlace']), '', 'el enlace no está en main');
  assert.match(r.out, /##vso\[task\.logissue type=warning\][^\n]*enlace/, 'y lo dice en naranja, nombrándolo');
});

test('T73 un repo de git metido en una carpeta del paso (un submódulo) tampoco viaja, y se avisa', () => {
  const w = world('gitlink-saved');
  const inner = path.join(w.job, '.dashboard/bench/otro-repo');
  fs.mkdirSync(inner, { recursive: true });
  git(inner, ['init', '--quiet']);
  writeFiles(inner, { 'x.txt': 'de otro repo\n' });
  git(inner, ['add', '-A']); git(inner, ['commit', '--quiet', '-m', 'adentro']);
  writeFiles(w.job, { '.dashboard/bench/banco-2026-01-02.json': '{}\n' });
  const r = save(w, ['--message', 'm', '--', '.dashboard/bench']);
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(changedBy(w, mainTip(w)), ['.dashboard/bench/banco-2026-01-02.json']);
  assert.strictEqual(git(w.remote, ['ls-tree', '-r', 'main', '--', '.dashboard/bench/otro-repo']), '', 'el submódulo no está en main');
  assert.match(r.out, /##vso\[task\.logissue type=warning\][^\n]*otro-repo/);
});

test('T73 «no pude» nunca es «no hay»: si git falla al listar o al comparar, sale 1 con su motivo', { skip: process.platform === 'win32' }, () => {
  // un git de mentira delante del de verdad: falla sólo la orden que diga FAIL_GIT, y pasa todo lo demás
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = tmp('fake-git');
  // FAIL_GIT_FROM: recién a partir de la vez N que aparece esa orden (para llegar a la segunda o la tercera comparación)
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/bin/sh',
    'for a in "$@"; do',
    '  if [ "$a" = "$FAIL_GIT" ]; then',
    '    n=$(cat "$FAIL_GIT_COUNT" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$FAIL_GIT_COUNT"',
    '    if [ "$n" -ge "${FAIL_GIT_FROM:-1}" ]; then echo "fatal: simulado, $FAIL_GIT no anda" >&2; exit 128; fi',
    '  fi',
    'done',
    `exec "${real}" "$@"`,
    '',
  ].join('\n'));
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  let counters = 0;
  const failing = (order, from = 1) => ({ PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAIL_GIT: order, FAIL_GIT_FROM: String(from), FAIL_GIT_COUNT: path.join(bin, `count-${++counters}`) });

  // listar lo que hay en las rutas del paso: antes, un fallo descartaba todas las rutas y decía «Nada nuevo»
  let w = world('git-fails-ls');
  let before = mainTip(w);
  writeFiles(w.job, { 'ultimo.json': '{"ts":"nuevo"}\n' });
  let r = save(w, ['--message', 'm', '--', 'ultimo.json'], failing('ls-files'));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /no pude listar[^\n]*simulado/);
  assert.doesNotMatch(r.out, /Nada nuevo/);
  assert.strictEqual(mainTip(w), before);

  // comparar: lo que el paso cambió en su índice (la primera comparación)…
  r = save(w, ['--message', 'm', '--', 'ultimo.json'], failing('diff'));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /no pude listar lo que el paso cambió[^\n]*NO viajó/);
  assert.strictEqual(mainTip(w), before);
  // …la lista de lo que escribió (la primera de las que piden nombres)…
  r = save(w, ['--message', 'm', '--', 'ultimo.json'], failing('--name-only'));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /no pude listar lo que escribió el paso[^\n]*simulado[^\n]*NO viajó/);
  assert.strictEqual(mainTip(w), before);
  // …el traslado a la punta (la tercera: `merge-tree` también pide nombres): un fallo que no es un choque…
  r = save(w, ['--message', 'm', '--', 'ultimo.json'], failing('--name-only', 3));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /no pude trasladar el commit del paso a la punta de main[^\n]*simulado[^\n]*NO viajó/);
  assert.doesNotMatch(r.out, /choca con/, 'no lo confunde con un choque de contenido');
  assert.strictEqual(mainTip(w), before);
  // …y el control de «sólo lo que el paso escribió», justo antes de empujar (la cuarta): sin poder mirar, no empuja
  r = save(w, ['--message', 'm', '--', 'ultimo.json'], failing('--name-only', 4));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /no pude comparar lo que se iba a empujar[^\n]*simulado[^\n]*NO viajó/);
  assert.strictEqual(mainTip(w), before, 'sin poder comprobar qué cambia, no se empuja');

  // sync: antes, un fallo al listar no restauraba nada y decía «Datos … al disco»
  w = world('git-fails-sync');
  rival(w, { '.dashboard/bench/foto-nueva.json': '{}\n' });
  r = run(w, ['sync', '--', '.dashboard'], failing('ls-files'));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /no pude listar[^\n]*los datos NO se trajeron/);
  assert.doesNotMatch(r.out, /al disco/);
  r = run(w, ['sync', '--', '.dashboard'], failing('restore'));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /no pude traer los datos[^\n]*los datos NO se trajeron/);
});

test('T73 sin constancia y con el mismo archivo vuelto a cambiar: sale 1 nombrándolo (no deshace ni duplica nada en main)', () => {
  // El límite conocido de «la constancia se perdió»: el guardado siguiente parte de HEAD; si el archivo que ya había
  // viajado volvió a cambiar, la fusión no puede saber cuál vale. Sale rojo y ruidoso; se recupera corriendo de nuevo.
  const w = world('lost-state');
  writeFiles(w.job, { 'inbox/q/pending/a.yaml': 'id: a\nveredicto: pendiente\nrechazado: 2026-01-01\n' });
  let r = save(w, ['--message', 'uno', '--', 'inbox/q']);
  assert.strictEqual(r.code, 0, r.out);
  const first = mainTip(w);
  fs.rmSync(path.join(git(w.job, ['rev-parse', '--absolute-git-dir']), 'nightly-data.json'));
  git(w.job, ['update-ref', '-d', 'refs/nightly-data/base']);
  writeFiles(w.job, { 'inbox/q/pending/a.yaml': 'id: a\nveredicto: pendiente\nrechazado: 2026-01-01\npr: 7\n' });
  r = save(w, ['--message', 'dos', '--', 'inbox/q']);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /choca con lo que main trae en: inbox\/q\/pending\/a\.yaml/);
  assert.match(r.out, /NO viajó/);
  assert.strictEqual(mainTip(w), first, 'main queda con lo del primer guardado, entero');
});

test('T73 la verificación corre antes de empujar, sobre lo que se va a publicar (el sello del tablero)', () => {
  // un verificador de mentira: aprueba sólo si en lo que se publica NO hay una foto más nueva que la de la página
  const verifier = path.join(tmp('verifier'), 'verify.js');
  fs.writeFileSync(verifier, [
    'const fs = require("fs"); const path = require("path");',
    'const dir = process.env.PUSH_DIR;',
    'const page = fs.readFileSync(path.join(dir, "artifacts/page.html"), "utf8");',
    'const shots = fs.readdirSync(path.join(dir, ".dashboard/bench")).filter((n) => /^foto-/.test(n)).sort();',
    'const newest = shots[shots.length - 1] || "";',
    'if (!page.includes(newest)) { console.error("la página no es de la foto más nueva: " + newest + " ##vso[task.complete result=Succeeded;]"); process.exit(1); }',
  ].join('\n'));
  const verify = `"${process.execPath}" "${verifier}"`;

  // main trajo una foto más nueva que la que usó la página: no se publica
  let w = world('verify-red');
  writeFiles(w.job, { '.dashboard/bench/foto-1.json': '{}\n' });
  git(w.job, ['add', '-A', '-f']); git(w.job, ['commit', '--quiet', '-m', 'foto 1']); git(w.job, ['push', '--quiet', 'origin', 'HEAD:main']);
  const tip = rival(w, { '.dashboard/bench/foto-2.json': '{}\n' });
  writeFiles(w.job, { 'artifacts/page.html': 'página de foto-1.json\n' });
  let r = save(w, ['--message', 'chore(tablero): página [nocturno]', '--verify', verify, '--verify-export', '.dashboard', '--', 'artifacts/page.html']);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /foto-2\.json/, 'el verificador vio lo que main trajo, no el disco');
  assert.match(r.out, /##vso\[task\.logissue type=error\]/);
  assert.doesNotMatch(r.out, /##vso\[task\.complete/i, 'lo que dice el verificador no puede leerse como una orden de Azure');
  assert.strictEqual(mainTip(w), tip, 'no se publicó');
  assert.strictEqual(mainText(w, 'artifacts/page.html'), 'vieja\n');

  // «nada nuevo» tampoco saltea la verificación: la página no cambió, y lo que main tiene publicado no pasa → rojo
  w = world('verify-idle');
  writeFiles(w.job, { '.dashboard/bench/foto-1.json': '{}\n', 'artifacts/page.html': 'página de foto-1.json\n' });
  git(w.job, ['add', '-A', '-f']); git(w.job, ['commit', '--quiet', '-m', 'foto 1 y su página']); git(w.job, ['push', '--quiet', 'origin', 'HEAD:main']);
  const idleTip = rival(w, { '.dashboard/bench/foto-2.json': '{}\n' });
  r = save(w, ['--message', 'chore(tablero): página [nocturno]', '--require', 'artifacts/page.html', '--verify', verify, '--verify-export', '.dashboard', '--', 'artifacts/page.html']);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /foto-2\.json/, 'verificó lo publicado en main, aunque no hubiera nada que empujar');
  assert.strictEqual(mainTip(w), idleTip);
  // …y si lo publicado pasa, sin cambios sale 0
  w = world('verify-idle-green');
  writeFiles(w.job, { '.dashboard/bench/foto-1.json': '{}\n', 'artifacts/page.html': 'página de foto-1.json\n' });
  git(w.job, ['add', '-A', '-f']); git(w.job, ['commit', '--quiet', '-m', 'foto 1 y su página']); git(w.job, ['push', '--quiet', 'origin', 'HEAD:main']);
  r = save(w, ['--message', 'chore(tablero): página [nocturno]', '--verify', verify, '--verify-export', '.dashboard', '--', 'artifacts/page.html']);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /Nada nuevo/);

  // con la foto al día, se publica
  w = world('verify-green');
  writeFiles(w.job, { '.dashboard/bench/foto-1.json': '{}\n' });
  git(w.job, ['add', '-A', '-f']); git(w.job, ['commit', '--quiet', '-m', 'foto 1']); git(w.job, ['push', '--quiet', 'origin', 'HEAD:main']);
  writeFiles(w.job, { 'artifacts/page.html': 'página de foto-1.json\n' });
  r = save(w, ['--message', 'chore(tablero): página [nocturno]', '--verify', verify, '--verify-export', '.dashboard', '--', 'artifacts/page.html']);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(mainText(w, 'artifacts/page.html'), 'página de foto-1.json\n');
});

test('T73 sync trae de main sólo los datos (lo que main borró, se borra) sin mover el checkout; y la página cambiada en main viaja', () => {
  const w = world('sync', { overlay: true });
  // desde que el trabajo hizo su checkout, main cambió: otra página, una foto nueva, una borrada, y código
  const tip = rival(w, {
    'artifacts/page.html': 'la de otra corrida\n',
    '.dashboard/bench/foto-nueva.json': '{"nueva":true}\n',
    '.dashboard/bench/viejo.json': null,
    'scripts/ci/tool.js': 'module.exports = 2; // código nuevo de main\n',
    'datos/ultimo-banco.json': '{"ts":"de otra corrida"}\n',
  });
  // con un comodín, y con una ruta que no existe en ningún lado (no tiene qué traer: no es un error)
  let r = run(w, ['sync', '--', '.dashboard', 'artifacts/page.html', 'datos/ultimo-*.json', 'no/existe']);
  assert.strictEqual(r.code, 0, r.out);
  const disk = (rel) => (fs.existsSync(path.join(w.job, rel)) ? fs.readFileSync(path.join(w.job, rel), 'utf8') : null);
  assert.strictEqual(disk('datos/ultimo-banco.json'), '{"ts":"de otra corrida"}\n', 'el comodín también trae lo suyo');
  assert.strictEqual(disk('artifacts/page.html'), 'la de otra corrida\n', 'los datos de main, al disco');
  assert.strictEqual(disk('.dashboard/bench/foto-nueva.json'), '{"nueva":true}\n');
  assert.strictEqual(disk('.dashboard/bench/viejo.json'), null, 'lo que main borró, se borra');
  assert.strictEqual(disk('scripts/ci/tool.js'), SEED['scripts/ci/tool.js'], 'el código NO se trae');
  assert.strictEqual(disk('scripts/public-new.js'), 'del público\n', 'la superposición sigue en su lugar');
  assertCheckoutUntouched(w);

  // la página se genera sobre esos datos y se guarda: no choca aunque la de main no sea la del checkout
  writeFiles(w.job, { 'artifacts/page.html': 'la de esta corrida\n' });
  r = save(w, ['--message', 'chore(tablero): página [nocturno]', '--require', 'artifacts/page.html', '--', 'artifacts/page.html']);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(mainText(w, 'artifacts/page.html'), 'la de esta corrida\n');
  assert.deepStrictEqual(changedBy(w, mainTip(w)), ['artifacts/page.html']);
  assert.strictEqual(git(w.remote, ['rev-parse', `${mainTip(w)}^`]), tip);
  assert.strictEqual(mainText(w, 'scripts/old.js'), SEED['scripts/old.js'], 'la superposición no viajó');
  assertCheckoutUntouched(w);

  // guardar una ruta que no se trajo devolvería en main lo que otros cambiaron: es un error de uso
  const before = mainTip(w);
  writeFiles(w.job, { 'inbox/q/pending/z.yaml': 'id: z\n' });
  r = save(w, ['--message', 'm', '--', 'artifacts/page.html', 'inbox/q']);
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /inbox\/q/);
  assert.strictEqual(mainTip(w), before);
});

test('T73 la constancia de otra corrida no se usa: un checkout vuelto a traer no devuelve en main lo ya guardado', () => {
  const w = world('stale');
  writeFiles(w.job, { 'ultimo.json': '{"ts":"corrida 1"}\n' });
  let r = save(w, ['--message', 'uno', '--', 'ultimo.json', '.dashboard/bench'], { BUILD_BUILDID: '1' });
  assert.strictEqual(r.code, 0, r.out);
  // otra corrida reusa la carpeta: el checkout devuelve el disco al commit, y escribe otra cosa
  git(w.job, ['checkout', '--quiet', '--force', 'HEAD', '--', 'ultimo.json']);
  writeFiles(w.job, { '.dashboard/bench/banco-2026-01-03.json': '{}\n' });
  r = save(w, ['--message', 'dos', '--', 'ultimo.json', '.dashboard/bench'], { BUILD_BUILDID: '2' });
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(mainText(w, 'ultimo.json'), '{"ts":"corrida 1"}\n', 'lo que guardó la corrida anterior no se deshace');
  assert.deepStrictEqual(changedBy(w, mainTip(w)), ['.dashboard/bench/banco-2026-01-03.json']);
});

test('T73 la guarda del árbol: se comprueba antes de guardar; si el árbol cambió, o si falta HARNESS_TREE, rojo y nada viaja', () => {
  // la guarda de mentira (GUARD_FAKE) viene en la semilla: sale lo que diga CHECK_TREE_EXIT y deja constancia
  let w = world('guard-green');
  let log = path.join(w.base, 'check.json');
  writeFiles(w.job, { 'ultimo.json': '{"ts":"1"}\n' });
  let r = save(w, ['--message', 'm', '--', 'ultimo.json'], { CHECK_TREE_EXIT: '0', CHECK_TREE_LOG: log });
  assert.strictEqual(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /##vso\[task\.logissue type=warning\][^\n]*HARNESS_TREE/, 'con la variable no queda ningún aviso de la guarda');
  const called = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.strictEqual(called.tree, TREE);
  assert.strictEqual(called.args[0], '--check-tree');
  assert.strictEqual(called.args[1], '--repo');
  assert.strictEqual(fs.realpathSync(called.args[2]), fs.realpathSync(w.job), 'la guarda mira el checkout del trabajo');
  assert.strictEqual(mainText(w, 'ultimo.json'), '{"ts":"1"}\n');

  for (const exit of ['1', '2']) {
    w = world(`guard-red-${exit}`);
    log = path.join(w.base, 'check.json');
    const before = mainTip(w);
    writeFiles(w.job, { 'ultimo.json': '{"ts":"1"}\n' });
    r = save(w, ['--message', 'm', '--', 'ultimo.json'], { CHECK_TREE_EXIT: exit, CHECK_TREE_LOG: log });
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /##vso\[task\.logissue type=error\]/);
    assert.match(r.out, /NO viajó/);
    assert.match(r.out, /scripts\/run\.sh/, 'muestra lo que dijo la guarda');
    assert.doesNotMatch(r.out, /##vso\[task\.complete/i, 'y lo que dijo no puede leerse como una orden de Azure (taparía el rojo), tampoco en mayúsculas');
    assert.strictEqual(mainTip(w), before, `guarda en ${exit}: nada viaja`);
  }

  // la guarda en rojo frena también cuando no hay nada nuevo que guardar: «no había qué empujar» no tapa un árbol
  // que cambió (una guarda que corriera después de «nada nuevo» saldría 0 acá)
  w = world('guard-red-idle');
  const beforeIdle = mainTip(w);
  r = save(w, ['--message', 'm', '--', 'ultimo.json'], { CHECK_TREE_EXIT: '1' });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /el árbol ya no es el que dejó la superposición/);
  assert.doesNotMatch(r.out, /Nada nuevo/, 'no llega a decir que no había nada');
  assert.strictEqual(mainTip(w), beforeIdle);

  // una guarda que muere sin código de salida (una señal, o no llegó a arrancar) no es un «todo bien»: rojo
  w = world('guard-killed');
  const beforeKilled = mainTip(w);
  writeFiles(w.job, { 'ultimo.json': '{"ts":"1"}\n' });
  r = save(w, ['--message', 'm', '--', 'ultimo.json'], { CHECK_TREE_EXIT: 'kill' });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /NO viajó/);
  // en Windows matar un proceso deja un código de salida; el caso «sin código» es de las otras plataformas
  if (process.platform !== 'win32') assert.match(r.out, /--check-tree salió sin código/, 'lo dice: terminó sin código');
  assert.strictEqual(mainTip(w), beforeKilled, 'la guarda muerta: nada viaja');

  // El guion de ESTA corrida. Con el arnés traído de GitHub y antes del corte, el checkout queda parado en el commit
  // del que salió la copia: el `overlay-harness.js` del disco es el de ese commit, que puede no conocer `--check-tree`
  // o calcular la huella de otro modo. La plantilla guarda antes el de la corrida —el que calculó HARNESS_TREE— en la
  // carpeta temporal del agente, y la guarda corre ése (lo mismo que hace check-tree.yml antes de medir).
  w = world('guard-run-script');
  log = path.join(w.base, 'check.json');
  const agentTmp = path.join(w.base, 'agent-tmp');
  writeFiles(agentTmp, { 'arnes-guion/overlay-harness.js':
    'require("fs").writeFileSync(process.env.CHECK_TREE_LOG, JSON.stringify({ from: "la corrida", args: process.argv.slice(2) }));\nprocess.exit(Number(process.env.RUN_GUARD_EXIT || 0));\n' });
  writeFiles(w.job, { 'ultimo.json': '{"ts":"1"}\n' });
  // el del disco diría que el árbol cambió: si se corriera ése, saldría rojo
  r = save(w, ['--message', 'm', '--', 'ultimo.json'], { AGENT_TEMPDIRECTORY: agentTmp, CHECK_TREE_EXIT: '1', CHECK_TREE_LOG: log });
  assert.strictEqual(r.code, 0, r.out);
  let ran = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.strictEqual(ran.from, 'la corrida', 'corre el guion que guardó la plantilla, no el del disco');
  assert.deepStrictEqual(ran.args.slice(0, 2), ['--check-tree', '--repo']);
  assert.strictEqual(fs.realpathSync(ran.args[2]), fs.realpathSync(w.job), 'y mira el checkout del trabajo');
  assert.strictEqual(mainText(w, 'ultimo.json'), '{"ts":"1"}\n');
  // y si ése dice que cambió, rojo aunque el del disco diga que no
  const beforeRun = mainTip(w);
  writeFiles(w.job, { 'ultimo.json': '{"ts":"2"}\n' });
  r = save(w, ['--message', 'm', '--', 'ultimo.json'], { AGENT_TEMPDIRECTORY: agentTmp, RUN_GUARD_EXIT: '1', CHECK_TREE_EXIT: '0', CHECK_TREE_LOG: log });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /NO viajó/);
  assert.match(r.out, /el guion de la corrida[^\n]*--check-tree salió 1/, 'el rojo nombra el guion que corrió, no el del checkout');
  assert.strictEqual(mainTip(w), beforeRun, 'la guarda de la corrida en rojo: nada viaja');
  // sin guion guardado (la fuente azure, o después del corte) corre el del checkout
  fs.rmSync(path.join(agentTmp, 'arnes-guion'), { recursive: true, force: true });
  fs.rmSync(log, { force: true });
  r = save(w, ['--message', 'm', '--', 'ultimo.json'], { AGENT_TEMPDIRECTORY: agentTmp, CHECK_TREE_EXIT: '0', CHECK_TREE_LOG: log });
  assert.strictEqual(r.code, 0, r.out);
  ran = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.strictEqual(ran.from, undefined, 'sin el guion guardado, la guarda es la del checkout');
  assert.strictEqual(ran.tree, TREE);
  // y si en ese lugar hay otra cosa que un archivo (una carpeta), tampoco es el guion de la corrida: la del
  // checkout, igual que elige check-tree.yml con `[ -f ]` antes de medir
  fs.mkdirSync(path.join(agentTmp, 'arnes-guion', 'overlay-harness.js'), { recursive: true });
  fs.rmSync(log, { force: true });
  writeFiles(w.job, { 'ultimo.json': '{"ts":"3"}\n' });
  r = save(w, ['--message', 'm', '--', 'ultimo.json'], { AGENT_TEMPDIRECTORY: agentTmp, CHECK_TREE_EXIT: '0', CHECK_TREE_LOG: log });
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(JSON.parse(fs.readFileSync(log, 'utf8')).tree, TREE, 'una carpeta con ese nombre no es el guion de la corrida');

  // sin la variable no se sabe contra qué árbol comparar: no se guarda. La plantilla que trae el arnés la deja en
  // todo trabajo que guarda; que falte es que algo cambió ahí, y «guardar igual» era el estado de paso de antes.
  for (const [tag, env] of [['absent', {}], ['empty', { HARNESS_TREE: '' }]]) {
    w = world(`guard-${tag}`);
    log = path.join(w.base, 'check.json');
    const before = mainTip(w);
    writeFiles(w.job, { 'ultimo.json': '{"ts":"1"}\n' });
    r = saveWithoutTree(w, ['--message', 'm', '--', 'ultimo.json'], { CHECK_TREE_EXIT: '0', CHECK_TREE_LOG: log, ...env });
    assert.strictEqual(r.code, 1, `${tag}: ${r.out}`);
    assert.match(r.out, /##vso\[task\.logissue type=error\][^\n]*HARNESS_TREE[^\n]*NO viajó/, `${tag}: lo dice en rojo, nombrando la variable`);
    assert.doesNotMatch(r.out, /type=warning\][^\n]*HARNESS_TREE/, `${tag}: ya no es un aviso`);
    assert.ok(!fs.existsSync(log), `${tag}: sin la variable no se llama a la guarda`);
    assert.strictEqual(mainTip(w), before, `${tag}: nada viaja`);
    assertCheckoutUntouched(w);
  }

  // tampoco cuando no hay nada nuevo que guardar: «no comprobé» no puede salir verde por no tener qué empujar
  w = world('guard-absent-idle');
  r = saveWithoutTree(w, ['--message', 'm', '--', 'ultimo.json']);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /HARNESS_TREE/);
  assert.doesNotMatch(r.out, /Nada nuevo/, 'no llega a decir que no había nada');
});

test('T73 uso: sin mensaje, sin rutas o con una ruta que sale del repo, 2 y nada se toca', () => {
  const w = world('usage');
  const before = mainTip(w);
  writeFiles(w.job, { 'ultimo.json': '{"ts":"1"}\n' });
  for (const args of [
    ['save', '--', 'ultimo.json'],
    ['save', '--message', 'm'],
    ['save', '--message', 'm', '--'],
    ['save', '--message', 'm', '--', '../afuera'],
    ['save', '--message', 'm', '--', path.join(w.job, 'ultimo.json')],
    ['save', '--message', 'm', '--unknown', '--', 'ultimo.json'],
    ['save', '--message', 'm', '--', '.'],
    ['save', '--message', 'm', '--', './ultimo.json'],
    ['save', '--message', 'm', '--', '*'],
    ['save', '--message', 'm', '--', '**/x.json'],
    ['save', '--message', 'm', '--verify-export', '.dashboard', '--', 'ultimo.json'],
    ['save', '--message', 'm', '--require-daily', '.dashboard/bench/banco.json', '--', 'ultimo.json'],
    ['save', '--message', 'm', '--today', 'ayer', '--', 'ultimo.json'],
    ['save', '--message', 'm', '--attempts', '0', '--', 'ultimo.json'],
    ['save', '--message', 'm', '--wait-ms', '-1', '--', 'ultimo.json'],
    ['save', '--message', '--', 'ultimo.json'],
    ['sync', '--', '.'],
    ['sync'],
    ['other', '--', 'ultimo.json'],
    // el primer tramo de una ruta va escrito sin comodines: una clase de caracteres abarcaba el repo igual que `*`
    ['save', '--message', 'm', '--', '[.a-z]*'],
    ['save', '--message', 'm', '--', '[a-z]*/x.json'],
    ['save', '--message', 'm', '--', '?dashboard/bench'],
    ['save', '--message', 'm', '--', 'ulti*.json'],
    // una fecha con forma de fecha que no existe
    ['save', '--message', 'm', '--today', '2026-13-45', '--require-daily', '.dashboard/bench/banco-{day}.json', '--', 'ultimo.json'],
    ['save', '--message', 'm', '--today', '2026-02-30', '--', 'ultimo.json'],
    // una ruta absoluta escrita con barras al revés, y una con un salto de línea adentro (se imprimiría tal cual)
    ['save', '--message', 'm', '--', '\\private\\tmp\\repo'],
    ['save', '--message', 'm', '--', 'ultimo.json\n##vso[task.complete result=Succeeded;]'],
    ['sync', '--', '.dashboard\r\n##vso[task.complete result=Succeeded;]'],
    // lo que se exige es un archivo con su nombre: un comodín ahí nunca encontraría nada
    ['save', '--message', 'm', '--require', '.dashboard/bench/*.json', '--', 'ultimo.json'],
    ['save', '--message', 'm', '--require-daily', '.dashboard/bench/banco-{day}*.json', '--', 'ultimo.json'],
    // una palabra que es una propiedad de todo objeto no es una opción
    ['save', '--message', 'm', 'constructor', 'x', '--', 'ultimo.json'],
    ['save', '--message', 'm', 'toString', 'x', '--', 'ultimo.json'],
    [],
  ]) {
    const r = run(w, args);
    assert.strictEqual(r.code, 2, `${JSON.stringify(args)} → ${r.code}\n${r.out}`);
    assert.doesNotMatch(r.out, /^##vso\[task\.complete/m, `${JSON.stringify(args)}: lo que se rechaza tampoco se imprime como una orden de Azure`);
  }
  assert.strictEqual(mainTip(w), before);
  assertCheckoutUntouched(w);
});

test('T73 lo que cambia fuera de las rutas del paso se nombra (el control de «sólo lo que el paso escribió»)', () => {
  const { changedOutside } = require(SCRIPT);
  const w = world('outside');
  const a = git(w.job, ['rev-parse', 'HEAD']);
  writeFiles(w.job, { 'scripts/run.sh': 'otro\n', '.dashboard/bench/x.json': '{}\n', 'inbox/q/pending/b.yaml': 'id: b\n' });
  git(w.job, ['add', '-A', '-f']); git(w.job, ['commit', '--quiet', '-m', 'mezcla']);
  const b = git(w.job, ['rev-parse', 'HEAD']);
  assert.deepStrictEqual(changedOutside(w.job, a, b, ['.dashboard/bench', 'inbox/q'], cleanEnv()), ['scripts/run.sh']);
  assert.deepStrictEqual(changedOutside(w.job, a, b, ['.dashboard/bench', 'inbox/q', 'scripts/run.sh'], cleanEnv()), []);
  assert.deepStrictEqual(changedOutside(w.job, a, b, ['.dashboard/bench/*.json', 'inbox'], cleanEnv()), ['scripts/run.sh']);
});

test('T8 (story 8.30) PushNightlyData_PublicTree_UsesHarnessTree: un árbol sin overlay-harness.js guarda con la guarda pública, y si el checkout se movió sale rojo nombrándola', () => {
  // el árbol de un pipeline de operaciones de otra organización: el arnés público, sin la superposición del equipo
  const w = world('public-guard');
  fs.rmSync(path.join(w.job, 'scripts', 'ci', 'overlay-harness.js'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'ci', 'harness-tree.js'), path.join(w.job, 'scripts', 'ci', 'harness-tree.js'));
  git(w.job, ['add', '-A', '-f']);
  git(w.job, ['commit', '--quiet', '-m', 'datos de operaciones [local, no se empuja]']);
  const tree = spawnSync(process.execPath, [path.join(w.job, 'scripts', 'ci', 'harness-tree.js'), '--tree', '--repo', w.job], { env: cleanEnv(), encoding: 'utf8' });
  assert.strictEqual(tree.status, 0, tree.stderr);
  const real = tree.stdout.trim();
  assert.match(real, /^[0-9a-f]{64}@[0-9a-f]{40}$/);

  writeFiles(w.job, { 'ultimo.json': '{"ts":"publico"}\n' });
  let r = save(w, ['--message', 'm', '--', 'ultimo.json'], { HARNESS_TREE: real });
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(mainText(w, 'ultimo.json'), '{"ts":"publico"}\n', 'guardó con la guarda pública');

  // un paso movió el checkout a otro código: la guarda pública lo ve y nada viaja
  writeFiles(w.job, { 'scripts/run.sh': '#!/bin/sh\necho otro codigo\n' });
  git(w.job, ['add', '-A']);
  git(w.job, ['commit', '--quiet', '-m', 'otro código']);
  const before = mainTip(w);
  writeFiles(w.job, { 'ultimo.json': '{"ts":"movido"}\n' });
  r = save(w, ['--message', 'm', '--', 'ultimo.json'], { HARNESS_TREE: real });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /scripts\/ci\/harness-tree\.js --check-tree salió 1/, 'el rojo nombra la guarda pública');
  assert.match(r.out, /scripts\/run\.sh/, 'y lo que cambió');
  assert.strictEqual(mainTip(w), before, 'nada viaja');
});
