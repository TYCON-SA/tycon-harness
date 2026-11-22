'use strict';
/**
 * save-brake-unmeasured.test.js — la familia «sin medir no guarda» del freno de guardar, en su propia suite:
 * save-brake.test.js es una suite bajada y su lista de casos queda fija (slow-suites-goal.test.js). Mismo laboratorio y
 * mismos ayudantes que ella.
 *
 * De save-brake.test.js: el freno de guardar: dentro de una corrida, antes de un commit, un push o un pedido, la sesión le
 * pregunta a la persona en la ventana de permiso; con el sí, guarda. En una pestaña que no pide permisos guarda sin
 * preguntar y lo dice. No hay firma ni constancia del ok: lo delicado lo cubre la firma de control.
 *
 * Laboratorio por prueba: una HOME vacía, un repo con su `origin` (un repo desnudo local) y la rama de la story
 * empujada con seguimiento, y el marcador de la corrida en el estado de esa HOME. El gancho (`on-pre-commit.js`) corre
 * como lo corre Claude Code, con el evento por la entrada; `marker.js` con la sesión por el ambiente. Que la ventana se
 * abre lo dice la salida del gancho (`permissionDecision: ask`).
 *
 * stable-data: las horas de la corrida son fijas; ninguna se compara con el reloj.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
// Sin arnés instalado (la HOME vacía del agente nocturno) packs.default no se puede leer y, con paquetes instalados en
// el árbol, el freno de paquetes frena todo lo que esta suite lanza. La suite fija el valor del perfil del equipo, en
// este proceso y en todo lo que lanza (antes de SIN_SESION, que copia el entorno al cargar).
process.env.TYCON_PACKS_DEFAULT = 'all';
const HOOK = path.join(SCRIPTS, 'on-pre-commit.js');
const MARKER = path.join(SCRIPTS, 'marker.js');
const BRAKE_LIB = path.join(SCRIPTS, 'lib', 'save-brake.js');

const ANTES = '2026-10-29T10:00:00.000Z';
const RAMA = 'story/la-prueba';
const SID = 'ses-freno';
// el texto del freno: lo distingue de los otros controles del gancho
const FRENO = /OK DE GUARDAR|¿GUARDO\?/;
// el texto del comando que el freno no puede leer con certeza
const NO_LEO = /no pude leer este comando/;
// la salida que abre la ventana de permiso
const VENTANA = /"permissionDecision":"ask"/;

const GIT_ENV = { GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@example.com', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@example.com' };
function sh(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
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

/** Un repo con `origin` (desnudo, local), `main` empujada y la rama de la story empujada con seguimiento. */
function repoConOrigin(t, nombre = 'repo') {
  const base = tmp(t, `freno-${nombre}-`);
  const origen = path.join(base, 'origen.git');
  const d = path.join(base, nombre);
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origen]);
  fs.mkdirSync(d);
  sh(d, 'init', '-q', '-b', 'main');
  escribir(d, 'LEEME.md', 'hola\n');
  escribir(d, 'specs/story-9.99.md', '---\nstory_id: "9.99"\nstatus: in-progress\n---\n');
  sh(d, 'add', '-A');
  sh(d, 'commit', '-q', '-m', 'base');
  sh(d, 'remote', 'add', 'origin', origen);
  sh(d, 'push', '-q', 'origin', 'main');
  sh(d, 'checkout', '-q', '-b', RAMA);
  sh(d, 'push', '-q', '-u', 'origin', RAMA);
  return d;
}

/** La HOME vacía de la prueba, con la carpeta del estado. */
function home(t) {
  const h = tmp(t, 'freno-home-');
  fs.mkdirSync(path.join(h, '.claude', '.tycon-pipeline', 'active'), { recursive: true });
  return h;
}
const estado = (h) => path.join(h, '.claude', '.tycon-pipeline');
const marcadorPath = (h, sid = SID) => path.join(estado(h), 'active', `${sid}.json`);
const registroPath = (h, sid = SID) => path.join(estado(h), 'save-closed', `${sid}.json`);

/** El marcador de una corrida de prueba sobre `repo`. */
function corrida(repo, extra = {}) {
  return {
    storyId: '9.99', startedAt: ANTES, sessionId: SID, repoPath: repo, storyPath: path.join(repo, 'specs', 'story-9.99.md'),
    stepScheme: 2, stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan', 'implement'], stepsPending: ['run-tests'],
    lastTouch: new Date().toISOString(), ...extra,
  };
}
function abrir(h, marker, sid = SID) { fs.writeFileSync(marcadorPath(h, sid), JSON.stringify({ ...marker, sessionId: sid }, null, 2)); }
const SIN_SESION = Object.fromEntries(Object.keys(process.env).filter((k) => !/^(CLAUDE_CODE_SESSION_ID|TYCON_SESSION_ID|CODEX_SESSION_ID)$/.test(k)).map((k) => [k, process.env[k]]));
/** El gancho con el evento de Claude Code: `{ status, stderr, stdout }`. */
function gancho(h, command, { cwd, sid = SID, env = {}, transcript, preload, modo } = {}) {
  const ev = { session_id: sid, tool_name: 'Bash', tool_input: { command }, cwd, ...(transcript ? { transcript_path: transcript } : {}),
    ...(modo ? { permission_mode: modo } : {}) };
  const r = spawnSync(process.execPath, [...(preload ? ['--require', preload] : []), HOOK], {
    input: JSON.stringify(ev), cwd, encoding: 'utf8', env: { ...SIN_SESION, ...GIT_ENV, HOME: h, USERPROFILE: h, ...env }, timeout: 60000,
  });
  return { status: r.status, stderr: String(r.stderr || ''), stdout: String(r.stdout || '') };
}
function guion(script, h, args, { cwd, sid = SID, env = {} } = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd, encoding: 'utf8', input: '', env: { ...SIN_SESION, ...GIT_ENV, HOME: h, USERPROFILE: h, CLAUDE_CODE_SESSION_ID: sid, ...env }, timeout: 120000,
  });
  return { status: r.status, stderr: String(r.stderr || ''), stdout: String(r.stdout || '') };
}
const marker = (h, args, o) => guion(MARKER, h, args, o);
/** Un gancho que no puede cargar el freno: el `require` de lib/save-brake.js tira. */
function frenoRoto(t) {
  const p = path.join(tmp(t, 'freno-roto-'), 'freno-roto.js');
  fs.writeFileSync(p, "const Module = require('module');\nconst orig = Module._load;\n"
    + "Module._load = function (req, ...resto) { if (/save-brake\\.js$/.test(req)) throw new Error('freno roto de prueba'); return orig.call(this, req, ...resto); };\n");
  return p;
}
const brake = () => require(BRAKE_LIB);
/** La copia del shell que deja Claude Code en la HOME: los alias y las funciones que la sesión trae. */
function copiaDelShell(h) {
  const d = path.join(h, '.claude', 'shell-snapshots');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'snapshot-zsh-1-prueba.sh'), ["alias -- ll='ls -lh'", "alias -- gst='git status'", "alias -- gp='git push'",
    "alias -- gcam='git commit --all --message'", "alias -- gpo='git push origin'", 'mirar () {', '\tgit log --oneline -1 "$@"', '}',
    'subir () {', '\tgit push origin "$@"', '}', ''].join('\n'));
}

// las formas de commit del AC 1; `{a}` es el repo de la corrida
const COMMITS = [
  'git commit -m x',
  'git -C {a} commit -m x',
  'git --git-dir={a}/.git commit -m x',
  'git --git-dir {a}/.git commit -m x',
  'git --work-tree {a} commit -m x',
  'git -c user.name=x commit -m x',
  'VAR=x git commit -m x',
  '/usr/bin/git commit -m x',
  "bash -c 'git commit -m x'",
  'sh -c "git commit -m x"',
  'true && git commit -m x',
  'true; git commit -m x',
  'echo x | git commit -F -',
  '(git commit -m x)',
  // los prefijos que corren el comando que sigue
  'env git commit -m x',
  'env -u HOME FOO=1 git commit -m x',
  'command git commit -m x',
  'exec git commit -m x',
  'time git commit -m x',
  'nohup git commit -m x',
  'sudo -u root git commit -m x',
  'nice -n 5 git commit -m x',
  'timeout 30 git commit -m x',
  'echo . | xargs -n 1 git commit -m x',
  '! git commit -m x',
  'if true; then git commit -m x; fi',
  'for i in 1; do git commit -m x; done',
  // el comando dentro de otro
  'out=$(git commit -m x 2>&1)',
  'echo "$(git commit -m x)"',
  'echo `git commit -m x`',
  'cat <(git commit -m x)',
  "bash -lc 'git commit -m x'",
  'bash -e -c "git commit -m x"',
  `bash -c "bash -c 'git commit -m x'"`,
  "eval 'git commit -m x'",
  "ksh -c 'git commit -m x'",
  "bash --rcfile /dev/null -c 'git commit -m x'",
  "bash --init-file /dev/null -c 'git commit -m x'",
  'git \\\ncommit -m x',
  // los comentarios y los heredocs no esconden lo que sigue, y el mensaje de un heredoc es texto
  "echo # it's\ngit commit -m x",
  "cat <<'EOF'\nit's\nEOF\ngit commit -m x",
  'cat <<-FIN\n\tit\'s\n\tFIN\ngit commit -m x',
  `git commit -m "$(cat <<'EOF'\nun "mensaje" que dice it's\nEOF\n)"`,
  "$'\\x67it' commit -m x",
  // el nombre del programa, como lo escribe Windows
  'GIT commit -m x',
  'git.exe commit -m x',
  'C:/Git/bin/git.exe commit -m x',
  '"C:\\Git\\cmd\\git.exe" commit -m x',
  // las opciones de git que cambian qué corre o dónde
  'git -c alias.ci=commit ci -m x',
  'git -c alias.a=commit -c alias.b=a b -m x',
  'git --namespace x commit -m x',
  'git --attr-source HEAD commit -m x',
  // el repo elegido por otro camino
  'cd {a} && git commit -m x',
  'cd {a}; (git commit -m x)',
  'GIT_DIR={a}/.git git commit -m x',
  'export GIT_DIR={a}/.git; git commit -m x',
  '(cd /tmp); git commit -m x',
  // la sustitución corre con lo que el shell ya hizo antes en el mismo comando
  'cd {a} && out=$(git commit -m x)',
  'export GIT_DIR={a}/.git; x=$(git commit -m x)',
  // un comentario dentro de las comillas invertidas termina en la comilla
  'echo `echo hi # x`; git commit -m x',
  // zsh expande `=git` a la ruta de git
  '=git commit -m x',
];
// las mismas formas con push, más las del destino escrito
const aPush = (f) => f.replace(/\bcommit\b( -m x| -F -)?/g, 'push');
const PUSHES = [...COMMITS.map(aPush), `git push origin ${RAMA}`, 'git push -u origin HEAD', `git push origin ${RAMA} main`, 'git push --all origin'];
const PEDIDOS = ['gh pr create --fill', 'gh -R acme/x pr merge 3', 'az repos pr create --title x', 'gh.exe pr create --fill', 'env gh pr merge 3',
  "bash -c 'az repos pr create --title x'", 'AZ.cmd repos pr create --title x', 'out=$(gh pr create --fill)',
  'gh pr -R acme/x create --fill', 'gh pr --repo acme/x merge 5', 'gh pr --repo=acme/x merge 5'];
const con = (cmd, a) => cmd.replace(/\{a\}/g, a);
// la forma que se corre desde otra carpeta: el repo lo nombra el comando
const desdeOtra = (forma) => /-C |--git-dir|--work-tree|cd \{a\}|GIT_DIR=/.test(forma);

// T1 Commit_CadaForma_SeLee
// Desde la 8.242 el commit no pregunta: lo que cuida esta prueba es que el lector siga viendo cada forma de commit (y
// la anota en el registro del freno), y que el gancho no commitee nada.
// 🔴 Falla con: una forma de commit que el freno deja de leer (otro directorio, la variable delante, un shell envuelto,
// un encadenado, un alias).

/** El carril de un camino rápido, firmado como lo deja `marker.js adhoc set`: la declaración con la hora de su firma y
 *  el renglón `adhoc-lane-signed` de esa hora en gates.log. Sin `firmado`, la declaración sola (no abre nada). */
function carril(h, { files = [], firmado = true, lastTouch, sid = SID, maxFiles = 5, bases, rutas, riesgoAlto } = {}) {
  const ahora = new Date().toISOString();
  fs.mkdirSync(path.join(estado(h), 'adhoc'), { recursive: true });
  fs.writeFileSync(path.join(estado(h), 'adhoc', `${sid}.json`), JSON.stringify({
    reason: 'el combo muestra el nombre completo', maxFiles, files, declaredAt: lastTouch || ahora, lastTouch: lastTouch || ahora,
    ...(firmado ? { firmadaEn: ahora } : {}), ...(bases ? { bases } : {}), ...(rutas ? { rutas } : {}), ...(riesgoAlto ? { riesgoAlto } : {}),
  }));
  if (firmado) fs.appendFileSync(path.join(estado(h), 'gates.log'), `${JSON.stringify({ name: 'adhoc-lane-signed', status: 'ok', destino: sid, ts: ahora })}\n`);
}

const guardar = (d, h) => brake().decidir({ command: 'git commit -m x', cwd: d, sid: SID, home: h });

const cuenta = (h, opciones) => require(path.join(SCRIPTS, 'lib', 'adhoc-base.js')).cuentaDelCarril(JSON.parse(fs.readFileSync(path.join(estado(h), 'adhoc', `${SID}.json`), 'utf8')), opciones);

const SO_LIB = path.join(SCRIPTS, 'lib', 'save-ok.js');

const HASTA_EL_11 = ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'findings', 'prepare-commit'];

/** La corrida con «Preparar el pull request» cerrado y la foto de ahora de sus repos; `extra` pisa lo que haga falta. */
function preparada(a, extra = {}) {
  const so = require(SO_LIB);
  const m = corrida(a, {
    stepsCompleted: HASTA_EL_11, stepsPending: [], checks: { tests: 'green' }, checksProvenance: { tests: 'test-gate' },
    iterations: { 1: { ts: ANTES } }, stepTimings: { reviewers: { startedAt: ANTES, completedAt: ANTES } },
    adversarialSkip: { motivo: 'LOW', at: ANTES }, ...extra,
  });
  return 'prepareCommitHuellas' in extra ? m : { ...m, prepareCommitHuellas: so.huellas(so.reposDeLaCorrida({ marker: m })) };
}

// 🔴 Falla con: un comando que cambia el código y en la misma línea abre el pull request o empuja, juzgado con el árbol
// de antes de correr.
/**
 * Un git que falla con 128 («no pude», no «no está») cuando sus argumentos contienen `patron`; para el resto, el de
 * verdad. Vale hasta el final de la prueba; uno nuevo reemplaza al anterior.
 */
function gitQueFalla(t, patron) {
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-falla-'));
  fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh\ncase " $* " in *"${patron}"*) echo "fatal: falla de prueba" >&2; exit 128;; esac\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const antes = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${antes}`;
  t.after(() => { process.env.PATH = antes; fs.rmSync(dir, { recursive: true, force: true }); });
}

/** Reemplaza `nombre` de lib/adhoc-base.js mientras dura la prueba: cada freno lo pide al decidir, no al cargar. */
function conBaseCambiada(t, nombre, fn) {
  const base = require(path.join(SCRIPTS, 'lib', 'adhoc-base.js'));
  const orig = base[nombre];
  base[nombre] = fn(orig);
  t.after(() => { base[nombre] = orig; });
}

// 🔴 mutación: el carril con un repo que no se pudo ubicar sigue de largo (`if (false)` en vez de `if (sinUbicar.length)`)
test('SaveBrake_RepoSinUbicar_NoGuarda', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  carril(h, { maxFiles: 8 });
  assert.ok(!(guardar(d, h) || {}).texto, 'con todo ubicado, guarda');
  conBaseCambiada(t, 'reposQueSeMiden', (orig) => (...a) => ({ ...orig(...a), fallas: ['repo de prueba sin ubicar'] }));
  const r = guardar(d, h);
  assert.match((r || {}).texto || '', /no pude medir este camino corto \(repo de prueba sin ubicar\)/, JSON.stringify(r));
});

// 🔴 mutación: el tope del carril que no se pudo contar sigue de largo (`if (false)` en vez de `if (c.fallas.length)`)
test('SaveBrake_TopeSinContar_NoGuarda', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  carril(h, { maxFiles: 8 });
  conBaseCambiada(t, 'cuentaDelCarril', () => () => { throw new Error('cuenta rota de prueba'); });
  const r = guardar(d, h);
  assert.match((r || {}).texto || '', /no pude medir cuántos archivos cambió este camino corto \(cuenta rota de prueba\)/, JSON.stringify(r));
});

// 🔴 mutación: el carril con lista que no pudo medir qué cambió sigue de largo (`if (false)` en vez de `if (m.fallas…)`)
test('SaveBrake_ListaSinMedir_NoGuarda', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  carril(h, { maxFiles: 8 });
  const p = path.join(estado(h), 'adhoc', `${SID}.json`);
  fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(fs.readFileSync(p, 'utf8')), allowedFiles: ['src/a.js'] }));
  conBaseCambiada(t, 'cuentaDelCarril', () => () => ({ archivos: [], avisos: [], fallas: [] }));
  conBaseCambiada(t, 'medirLoPropio', (orig) => (...a) => ({ ...orig(...a), fallas: ['lista rota de prueba'] }));
  const r = guardar(d, h);
  assert.match((r || {}).texto || '', /no pude medir qué cambió este camino corto \(lista rota de prueba\)/, JSON.stringify(r));
});

// 🔴 mutación: el carril sobre el tope que no sabe en qué rama guarda sigue de largo (`if (false)` en vez de
// `if (!destino && falla)`)
test('SaveBrake_RamaSinSaber_NoGuarda', { skip: process.platform === 'win32' }, (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  carril(h, { maxFiles: 8 });
  const p = path.join(estado(h), 'adhoc', `${SID}.json`);
  const a = { ...JSON.parse(fs.readFileSync(p, 'utf8')), allowedFiles: ['src/a.js'], sobreCupo: true };
  fs.writeFileSync(p, JSON.stringify(a));
  // la medida se toma antes de romper git: sólo la pregunta por la rama falla
  const base = require(path.join(SCRIPTS, 'lib', 'adhoc-base.js'));
  const medida = base.medirLoPropio(a, { repos: [d] });
  conBaseCambiada(t, 'medirLoPropio', () => () => medida);
  conBaseCambiada(t, 'cuentaDelCarril', () => () => ({ archivos: [], avisos: [], fallas: [] }));
  gitQueFalla(t, 'rev-parse --abbrev-ref HEAD');
  const r = guardar(d, h);
  assert.match((r || {}).texto || '', /no pude saber en qué rama guarda este camino corto/, JSON.stringify(r));
});

// 🔴 mutación: la pantalla que no se pudo medir deja guardar (`if (r.sinMedir) { return null;`)
test('SaveBrake_PantallaSinMedir_NoGuarda', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  carril(h, { maxFiles: 8 });
  const pantalla = require(path.join(SCRIPTS, 'lib', 'adhoc-screen.js'));
  const orig = pantalla.revisar;
  pantalla.revisar = () => { throw new Error('pantalla rota de prueba'); };
  t.after(() => { pantalla.revisar = orig; });
  const r = guardar(d, h);
  assert.match((r || {}).texto || '', /no pude medir si este camino rápido toca una pantalla \(pantalla rota de prueba\)/, JSON.stringify(r));
});

/** El carril de la prueba, como lo lee el freno, con su medida tomada sobre `d`. */
function carrilYMedida(h, d) {
  const a = JSON.parse(fs.readFileSync(path.join(estado(h), 'adhoc', `${SID}.json`), 'utf8'));
  return { a, medida: require(path.join(SCRIPTS, 'lib', 'adhoc-base.js')).medirLoPropio(a, { repos: [d] }) };
}

// 🔴 mutación: el freno de los datos que no pudo medir sigue de largo (`if (false)` en vez de `if (r.fallas.length)`)
test('SaveBrake_DatosSinMedir_NoGuarda', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  carril(h, { maxFiles: 8 });
  const { a } = carrilYMedida(h, d);
  const r = brake().frenoDeDatos(a, SID, h, [d], { medir: () => ({ hallazgos: [], avisos: [], fallas: ['datos rotos de prueba'] }) });
  assert.match((r || {}).texto || '', /no pude medir si este camino corto cambia de dónde sale un dato o quién lo ve \(datos rotos de prueba\)/, JSON.stringify(r));
});

// 🔴 mutación: el riesgo que no se pudo medir, sin marca ni ruta nueva, sigue de largo (`if (false)` en vez de
// `if (!marca && !nueva)`)
test('SaveBrake_RiesgoSinMedir_NoGuarda', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  carril(h, { maxFiles: 8 });
  const { a, medida } = carrilYMedida(h, d);
  const r = brake().frenoDelRiesgo(a, SID, h, [], { medida: { ...medida, fallas: ['riesgo roto de prueba'] } });
  assert.match((r || {}).texto || '', /toca una ruta de riesgo alto \(riesgo roto de prueba\)/, JSON.stringify(r));
});

// 🔴 mutación: el error al medir el riesgo devuelve null (`return null && { texto… }` en el catch)
test('SaveBrake_RiesgoQueTiraError_NoGuarda', (t) => {
  const d = repoConOrigin(t);
  const h = home(t);
  carril(h, { maxFiles: 8 });
  const { a, medida } = carrilYMedida(h, d);
  conBaseCambiada(t, 'rutasDe', () => () => { throw new Error('rutas rotas de prueba'); });
  const r = brake().frenoDelRiesgo(a, SID, h, [], { medida });
  assert.match((r || {}).texto || '', /toca una ruta de riesgo alto \(rutas rotas de prueba\)/, JSON.stringify(r));
});


// 🔴 mutación: el gancho traga el error de medir el diff entero del cierre (`cierre = null`) y el commit pasa.
test('Cierre_SinPoderMedirElDiffEntero_NoGuarda', (t) => {
  const h = home(t);
  const a = repoConOrigin(t);
  abrir(h, preparada(a));
  assert.strictEqual(gancho(h, 'git commit -m x', { cwd: a }).status, 0, 'con la medida sana, el commit de la corrida pasa');
  const p = path.join(tmp(t, 'cierre-roto-'), 'cierre-roto.js');
  fs.writeFileSync(p, `require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'batch-scope.js'))}).frenoDelCierre = () => { throw new Error('medida rota de prueba'); };\n`);
  const r = gancho(h, 'git commit -m x', { cwd: a, preload: p });
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /no pude medir el diff entero \(medida rota de prueba\)/);
});
