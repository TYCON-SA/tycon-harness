'use strict';
/**
 * save-brake.test.js — el freno de guardar: dentro de una corrida, antes de un commit, un push o un pedido, la sesión le
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
const HOOK = path.join(SCRIPTS, 'on-pre-commit.js');
const MARKER = path.join(SCRIPTS, 'marker.js');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const BRAKE_LIB = path.join(SCRIPTS, 'lib', 'save-brake.js');

const ANTES = '2026-10-29T10:00:00.000Z';
const DESPUES = '2026-10-29T11:00:00.000Z';
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

// T1 Pregunta_Commit_CadaForma
// 🔴 Falla con: una forma de commit que el freno no lee (otro directorio, la variable delante, un shell envuelto, un
// encadenado) guarda sin que la persona lo autorice en la ventana.
test('Pregunta_Commit_CadaForma (T1) @story-8.151 @ac-1', (t) => {
  const h = home(t);
  const a = repoConOrigin(t);
  abrir(h, corrida(a));
  const otro = tmp(t, 'freno-cwd-');
  const head = sh(a, 'rev-parse', 'HEAD');
  // un alias de git del repo
  sh(a, 'config', 'alias.ci', 'commit');
  for (const forma of [...COMMITS, 'git ci -m x']) {
    const cmd = con(forma, a);
    const r = gancho(h, cmd, { cwd: desdeOtra(forma) ? otro : a });
    assert.match(r.stdout, VENTANA, `«${cmd}» abre la ventana: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /«git commit»/, `«${cmd}» nombra la forma`);
    assert.doesNotMatch(r.stdout + r.stderr, /approve-save/, `«${cmd}» ya no pide approve-save`);
  }
  // el repo se nombra con su ruta
  assert.ok(gancho(h, 'git commit -m x', { cwd: a }).stdout.includes(JSON.stringify(a).slice(1, -1)), 'nombra el repo');
  assert.strictEqual(sh(a, 'rev-parse', 'HEAD'), head, 'el gancho no commitea nada');
  // desde la carpeta de la corrida: la variable sin exportar (o exportada en un subshell, o en otro shell) no cambia el
  // repo, `--work-tree` sin `--git-dir` tampoco, la forma con guion de git corre el mismo commit, y el alias del shell
  copiaDelShell(h);
  const vacia = tmp(t, 'freno-vacia-');
  for (const cmd of [`GIT_DIR=${otro}/.git; git commit -m x`, `(export GIT_DIR=${otro}/.git); git commit -m x`,
    `bash -c 'export GIT_DIR=${otro}/.git'; git commit -m x`, `git --work-tree=${vacia} commit -m x`, `GIT_WORK_TREE=${vacia} git commit -m x`,
    `${sh(a, '--exec-path')}/git-commit -m x`, 'git-commit -m x', "gcam 'x'"]) {
    const d = brake().decidir({ command: cmd, cwd: a, sid: SID, home: h });
    assert.ok(d && d.pregunta, `«${cmd}» pregunta: ${JSON.stringify(d)}`);
    assert.match(d.pregunta, /«git commit»/, `«${cmd}» nombra la forma`);
  }
});

// T2 Pregunta_PushYPedidos
// 🔴 Falla con: un push o un pedido que pasa sin preguntar, o una pregunta que repite el comando (puede traer una
// credencial).
test('Pregunta_PushYPedidos (T2) @story-8.151 @ac-2', (t) => {
  const h = home(t);
  const a = repoConOrigin(t);
  abrir(h, corrida(a));
  const otro = tmp(t, 'freno-cwd-');
  sh(a, 'config', 'alias.sube', '!git push');
  copiaDelShell(h);
  // el alias del shell, el alias propio de `gh pr create`, la forma con guion de git, y la rama que agrega `xargs`
  for (const forma of [...PUSHES, ...PEDIDOS, 'git sube', 'gp', 'gpo HEAD', 'subir HEAD', 'gh pr new --fill', `${sh(a, '--exec-path')}/git-push`,
    'echo main | xargs git push origin']) {
    const cmd = con(forma, a);
    const r = gancho(h, cmd, { cwd: desdeOtra(forma) ? otro : a });
    assert.strictEqual(r.status, 0, `«${cmd}» no frena: ${r.stderr}`);
    assert.match(r.stdout, VENTANA, `«${cmd}» abre la ventana`);
    // la forma es la que declara el conector: el alias `pr new` es una forma propia
    assert.match(r.stdout, /«(git push|gh pr create|gh pr new|gh pr merge|az repos pr create)»/, `«${cmd}» nombra la forma`);
  }
  // el texto nombra la forma y el repo, nunca el comando: un comando puede traer una credencial
  const MARCA = 'MARCA-QUE-NO-SALE';
  // ni la carpeta que sale del comando
  fs.mkdirSync(path.join(a, MARCA));
  for (const cmd of [`git push https://u:${MARCA}@example.com/x.git ${RAMA}`, `gh pr create --title t --body "${MARCA}"`,
    `git commit -m "${MARCA}"`, `az repos pr create --title ${MARCA}`, `$G push ${MARCA}`, `git -C ${a}/${MARCA} commit -m x`,
    `cd ${a}/${MARCA} && git push`, `git push origin ${MARCA}`, `git push origin HEAD:${MARCA}`]) {
    const r = gancho(h, cmd, { cwd: a });
    assert.match(r.stdout, VENTANA, `«${cmd}» abre la ventana: ${r.stderr}`);
    assert.ok(!(r.stdout + r.stderr).includes(MARCA), `el texto no repite el comando: ${r.stdout}${r.stderr}`);
  }
});

// T3 Freno_NoEsComando_Pasa
// 🔴 Falla con: el freno leyendo texto como comando (un mensaje, un eco, una búsqueda): preguntaría por trabajo que no
// guarda.
test('Freno_NoEsComando_Pasa (T3) @story-8.151 @ac-3', (t) => {
  const NO = ['echo "git commit"', 'git log --grep=commit', 'git tag -m "git commit" v1', "echo 'git push origin main'", 'git status',
    'git diff', 'gh pr view 3', 'az repos pr list', 'printf "gh pr create"', 'echo "$(echo git commit)"', 'grep -rn "git push" .',
    'command -v git', 'time git status', 'bash -c "git status"', "eval 'echo git push'", 'cd /tmp && git status', 'git commit-graph write',
    'env | grep push', 'xargs -n1 echo push', 'sudo -u x ls', 'echo `git log -1`', 'git -C /tmp log'];
  for (const cmd of NO) assert.deepStrictEqual(brake().comandosQueGuardan(cmd, os.tmpdir()), [], `«${cmd}» no guarda`);
  const h = home(t);
  const a = repoConOrigin(t);
  abrir(h, corrida(a));
  for (const cmd of NO) {
    const r = gancho(h, cmd, { cwd: a });
    assert.strictEqual(r.status, 0, `«${cmd}» pasa: ${r.stderr}`);
    assert.doesNotMatch(r.stdout, VENTANA, `«${cmd}» no abre la ventana`);
    assert.doesNotMatch(r.stderr, FRENO, cmd);
  }
});

// T4 PestanaQuePregunta_Y_PestanaSinPreguntas
// 🔴 Falla con: una pestaña que pide permisos y guarda sin preguntar, o una que no los pide (la ventana se aprobaría
// sola) que se traba o guarda sin decirlo.
test('PestanaQuePregunta_Y_PestanaSinPreguntas (T4) @story-8.151 @ac-4', (t) => {
  const h = home(t);
  const a = repoConOrigin(t);
  abrir(h, corrida(a));
  for (const modo of ['default', 'acceptEdits', 'plan', undefined]) {
    const r = gancho(h, `git push origin ${RAMA}`, { cwd: a, modo });
    assert.strictEqual(r.status, 0, `${modo}: ${r.stderr}`);
    assert.match(r.stdout, VENTANA, `${modo || 'sin el dato'}: abre la ventana`);
  }
  for (const modo of ['bypassPermissions', 'dontAsk']) {
    const r = gancho(h, `git push origin ${RAMA}`, { cwd: a, modo });
    assert.strictEqual(r.status, 0, `${modo}: guarda sin trabarse: ${r.stderr}`);
    assert.strictEqual(r.stdout, '', `${modo}: no abre la ventana`);
    assert.match(r.stderr, /no pide permisos/, `${modo}: lo dice en pantalla`);
    assert.match(r.stderr, /«git push»/, `${modo}: dice qué guarda`);
  }
  // lo que no se lee con certeza, igual: pregunta donde se pregunta, y pasa con aviso donde no
  const duda = 'G=git; $G push';
  assert.match(gancho(h, duda, { cwd: a, modo: 'default' }).stdout, VENTANA);
  const b = gancho(h, duda, { cwd: a, modo: 'bypassPermissions' });
  assert.strictEqual(b.status, 0, b.stderr);
  assert.match(b.stderr, NO_LEO);
});

// T5 Freno_RepoAjeno_Pasa_PedidoPregunta
// 🔴 Falla con: el freno preguntando por el trabajo de otro repo (un arreglo aparte en otro clon), o un pedido que no
// pregunta porque se abre desde un repo que no es de la corrida.
test('Freno_RepoAjeno_Pasa_PedidoPregunta (T5) @story-8.151 @ac-5', (t) => {
  const h = home(t);
  const a = repoConOrigin(t);
  const ajeno = repoConOrigin(t, 'ajeno');
  escribir(a, 'app.js', 'module.exports = 1;\n');
  abrir(h, corrida(a));
  assert.strictEqual(brake().decidir({ command: 'git commit -m x', cwd: ajeno, sid: SID, home: h }), null, 'el commit en otro repo pasa');
  assert.strictEqual(brake().decidir({ command: 'git push', cwd: ajeno, sid: SID, home: h }), null, 'el push en otro repo pasa');
  // también cuando el comando entra al otro repo desde el de la corrida: después del cd, git corre allá
  for (const cmd of [`cd ${ajeno} && git commit -m x`, `(cd ${ajeno} && git commit -m x)`, `cd ${ajeno}; git push`]) {
    assert.strictEqual(brake().decidir({ command: cmd, cwd: a, sid: SID, home: h }), null, `«${cmd}» pasa`);
  }
  const r = gancho(h, 'gh pr create --fill', { cwd: ajeno });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, VENTANA, 'el pedido pregunta: se juzga contra toda la corrida');
});

// T6 Freno_SinCorrida_O_Adhoc_IgualQueHoy
// 🔴 Falla con: el freno cambiando lo que pasa fuera de una corrida (un aviso, una salida distinta o una pregunta nueva
// para quien trabaja sin pipeline).
test('Freno_SinCorrida_O_Adhoc_IgualQueHoy (T6) @story-8.151 @ac-6', (t) => {
  const h = home(t);
  const a = repoConOrigin(t);
  escribir(a, 'app.js', 'module.exports = 1;\n');
  // la salida de hoy: el mismo gancho con el freno que nunca pregunta
  const preload = path.join(tmp(t, 'freno-sin-'), 'sin-freno.js');
  fs.writeFileSync(preload, `const p = ${JSON.stringify(BRAKE_LIB)};\nconst real = require(p);\nrequire.cache[p].exports = { ...real, decidir: () => null };\n`);
  const casos = [...COMMITS, ...PUSHES, ...PEDIDOS].map((f) => con(f, a));
  for (const conAdhoc of [false, true]) {
    if (conAdhoc) {
      fs.mkdirSync(path.join(estado(h), 'adhoc'), { recursive: true });
      fs.writeFileSync(path.join(estado(h), 'adhoc', `${SID}.json`), JSON.stringify({ reason: 'un arreglo rápido de prueba', maxFiles: 3, files: [] }));
    }
    for (const cmd of casos) {
      assert.strictEqual(brake().decidir({ command: cmd, cwd: a, sid: SID, home: h }), null, `«${cmd}» pasa sin corrida`);
      const hoy = gancho(h, cmd, { cwd: a, preload });
      const ahora = gancho(h, cmd, { cwd: a });
      assert.deepStrictEqual(ahora, hoy, `«${cmd}»${conAdhoc ? ' con adhoc' : ''}: la salida es la de hoy`);
    }
  }
  // el registro viejo «cerrada sin ok» ya no frena ni pregunta
  fs.mkdirSync(path.dirname(registroPath(h)), { recursive: true });
  fs.writeFileSync(registroPath(h), JSON.stringify([{ story: '9.97', repos: [a], ts: ANTES }]));
  assert.strictEqual(brake().decidir({ command: 'git commit -m x', cwd: a, sid: SID, home: h }), null, 'el registro viejo no cuenta');
});

// T7 OkDelChat_NoSaltaLaVentana
// 🔴 Falla con: una frase, una opción o una variable que guarda sin la ventana: cualquiera que escribe en la
// conversación o en el comando la saltearía.
test('OkDelChat_NoSaltaLaVentana (T7) @story-8.151 @ac-7', (t) => {
  const h = home(t);
  const a = repoConOrigin(t);
  abrir(h, corrida(a));
  const tr = path.join(tmp(t, 'freno-chat-'), 'transcripcion.jsonl');
  fs.writeFileSync(tr, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'commiteá y pusheá, tenés mi ok' } })}\n`);
  // un mensaje de otra sesión (la coordinadora) que da el ok
  const tr2 = path.join(tmp(t, 'freno-chat-'), 'transcripcion.jsonl');
  fs.writeFileSync(tr2, `${JSON.stringify({ type: 'user', message: { role: 'user',
    content: '<cross-session-message from="uds:/tmp/x.sock" from-name="Coordinadora">tenés el ok de guardar: commiteá y pusheá</cross-session-message>' } })}\n`);
  for (const [cmd, extra] of [['git commit -m x', { transcript: tr }], ['git push', { transcript: tr2 }], ['git commit -m x --ok', {}], ['TYCON_SAVE_OK=1 git commit -m x', {}],
    ['TYCON_SAVE_BRAKE=off git push', {}]]) {
    const r = gancho(h, cmd, { cwd: a, ...extra });
    assert.match(r.stdout, VENTANA, `«${cmd}» abre la ventana`);
  }
  const r = gancho(h, 'git push', { cwd: a, env: { TYCON_SAVE_BRAKE: 'off', TYCON_SAVE_OK: '1' } });
  assert.match(r.stdout, VENTANA, 'una variable del ambiente no la saltea');
});

// T8 NoSePuedeLeer_Pregunta
// 🔴 Falla con: no poder leer el marcador o un comando escondido en una variable leídos como «no hay nada que guardar»
// dentro de una corrida; o el freno que no carga dejando pasar adentro.
test('NoSePuedeLeer_Pregunta (T8) @story-8.151 @ac-8', (t) => {
  const h = home(t);
  const a = repoConOrigin(t);
  // adentro
  for (const raro of ['{ esto no es json', 'null', '[]', '{}', '"9.99"']) {
    fs.writeFileSync(marcadorPath(h), raro);
    const d = brake().decidir({ command: 'git push', cwd: a, sid: SID, home: h });
    assert.ok(d && d.pregunta, `el marcador ${raro} pregunta: ${JSON.stringify(d)}`);
    assert.match(d.pregunta, /marcador/, raro);
  }
  abrir(h, corrida(a));
  // el comando, o su repo, que no se puede leer: una variable, una carpeta que sale de una variable, un alias o una
  // configuración que viene del ambiente, o un programa que corre git por su cuenta
  const OPACOS = ['G=git; $G commit -m x', '${G} push', '$GH pr create', '${G:-git} commit -m x', 'env $G commit -m x', '$(which git) push',
    'git $SUB -m x', 'cd $D && git commit -m x', 'cd - && git push', 'git -C $D commit -m x', 'git --git-dir=$D/.git push',
    'GIT_DIR=$X git commit -m x', 'git --config-env alias.ci=V ci -m x', 'watch git commit -m x', "find . -exec git push \\;"];
  // y lo que no se puede leer con certeza, guarde o no
  const DUDAS = ["C='git commit -m x'; $C", 'eval $C', 'bash -c "$C"', '$(cat guion.txt)', "echo 'git commit -m x' | sh",
    "printf 'git push' | bash", 'bash <<< "git push"', 'bash <<FIN\ngit push\nFIN', 'cat guion | zsh -s', 'g(){ git "$@"; }; g commit -m x',
    'function g { git "$@"; }; g push', 'alias g=git; g commit -m x', 'git comit -m x',
    'echo $(echo $(echo $(echo $(echo $(git push)))))', 'echo commit | xargs git', 'C:\\Git\\git.exe push',
    "env -S 'git commit -m x'", "sudo -s 'git commit -m x'", 'bash -c', "echo 'sin cerrar; git commit -m x",
    'cat <<FIN\n$(git push)\nFIN', '/usr/bin/g?t commit -m x', '{git,commit} -m x', 'HOME=/tmp/otra git ci -m x',
    "printf 'git push origin main\\n' | bash -", "python3 - <<'EOF'\nimport os; os.system('git push')\nEOF",
    'programa-que-no-esta commit -m x'];
  for (const cmd of [...OPACOS, ...DUDAS]) {
    const d = brake().decidir({ command: cmd, cwd: a, sid: SID, home: h });
    assert.ok(d && d.pregunta, `«${cmd}» pregunta: ${JSON.stringify(d)}`);
    assert.match(d.pregunta, NO_LEO, cmd);
  }
  // el freno que no carga frena adentro: sin él no se sabe qué guarda
  for (const cmd of ['git commit -m x', 'gh pr create --fill', '$C', "echo 'x' | sh"]) {
    const r = gancho(h, cmd, { cwd: a, preload: frenoRoto(t) });
    assert.strictEqual(r.status, 2, `«${cmd}»: el freno que no carga frena adentro: ${r.stderr}`);
    assert.match(r.stderr, /freno de guardar no pudo correr/);
  }
  // afuera
  fs.rmSync(marcadorPath(h));
  for (const cmd of [...OPACOS, ...DUDAS]) {
    assert.strictEqual(brake().decidir({ command: cmd, cwd: a, sid: SID, home: h }), null, `«${cmd}» pasa sin corrida`);
  }
  // el freno que no carga deja pasar afuera, y lo dice
  let r = gancho(h, 'git push', { cwd: a, preload: frenoRoto(t) });
  assert.strictEqual(r.status, 0, `afuera, el freno que no carga deja pasar: ${r.stderr}`);
  assert.match(r.stderr, /freno de guardar no pudo correr/);
  r = gancho(h, 'ls', { cwd: a, preload: frenoRoto(t) });
  assert.strictEqual(r.status, 0, `afuera, lo que no guarda pasa con el freno roto: ${r.stderr}`);
});

// T9 Cierre_SinOk_Cierra
// 🔴 Falla con: un cierre de la corrida que todavía exige el ok de guardar, o que deja el registro «cerrada sin ok».
test('Cierre_SinOk_Cierra (T9) @story-8.151 @ac-9', (t) => {
  const h = home(t);
  const a = repoConOrigin(t);
  escribir(a, 'app.js', 'module.exports = 1;\n');
  for (const [args, sid] of [[['clear'], SID], [['clear-session', SID], SID], [['clear-session', SID], 'ses-otra']]) {
    abrir(h, corrida(a));
    const r = marker(h, args, { cwd: a, sid });
    assert.strictEqual(r.status, 0, `${args.join(' ')} con cambios cierra: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /approve-save|ok de guardar/, args.join(' '));
    assert.ok(!fs.existsSync(marcadorPath(h)), `${args.join(' ')}: el marcador se fue`);
  }
  // el reemplazo por otra story y la poda por antigüedad, tampoco
  abrir(h, corrida(a));
  let r = marker(h, ['set', JSON.stringify({ storyId: '9.98', repoPath: a }), '--replace'], { cwd: a });
  assert.strictEqual(r.status, 0, r.stderr);
  fs.rmSync(marcadorPath(h));
  abrir(h, corrida(a, { lastTouch: '2026-01-01T00:00:00.000Z' }));
  r = marker(h, ['list-all'], { cwd: a, sid: 'ses-otra' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(marcadorPath(h)), 'la poda borró el marcador');
  assert.ok(!fs.existsSync(path.join(estado(h), 'save-closed')), 'ningún cierre deja el registro «cerrada sin ok»');
  // y después del cierre, fuera de una corrida, guardar pasa como siempre
  assert.strictEqual(brake().decidir({ command: 'git commit -m x', cwd: a, sid: SID, home: h }), null);
  // un marcador que no se lee sigue sin borrarse: lo saca una persona
  fs.writeFileSync(marcadorPath(h), '{ esto no es json');
  r = marker(h, ['clear'], { cwd: a });
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /no se puede leer/);
});

// T12 PrepareCommit_LaVentanaConOrden
// 🔴 Falla con: el paso de preparar el commit que todavía pide approve-save o el ok dicho en el chat, o sin el orden
// del cierre.
test('PrepareCommit_LaVentanaConOrden (T12) @story-8.151 @ac-12', () => {
  const texto = fs.readFileSync(path.join(SCRIPTS, '..', 'steps', 'step-11-prepare-commit.md'), 'utf8');
  assert.doesNotMatch(texto, /si el usuario dice\W+commite/i, 'sin el camino «si el usuario dice commiteá»');
  assert.doesNotMatch(texto, /approve-save/, 'sin approve-save');
  assert.match(texto, /ventana de permiso/, 'dice que guardar se autoriza en la ventana');
  const orden = ['exportar la memoria', 'commitear', 'empujar', 'abrir los pedidos', 'marker.js clear'];
  const i = texto.search(/El orden del cierre/i);
  assert.ok(i >= 0, 'nombra el orden del cierre');
  let desde = i;
  for (const paso of orden) {
    const j = texto.indexOf(paso, desde);
    assert.ok(j > desde, `«${paso}» después del paso anterior`);
    desde = j;
  }
});

// T13 Freno_PedidosDeLosConectores
// 🔴 Falla con: un freno que reconoce los pedidos por un nombre de herramienta escrito en el núcleo y no por lo que
// declaran los conectores de plataforma, o una lista de conectores que no se lee y deja pasar el pedido sin preguntar.
test('Freno_PedidosDeLosConectores (T13)', (t) => {
  const h = home(t);
  const a = repoConOrigin(t);
  abrir(h, corrida(a));
  const conectores = tmp(t, 'freno-conectores-');
  escribir(conectores, 'otra/integration.json', JSON.stringify({ __doc: 'de prueba', name: 'otra', label: 'Otra', kind: 'platform',
    connector: 'scripts/connector.js', operations: ['ci.read'], capabilities: {}, rawCommands: ['otra pr create', 'otra pr merge', 'otra pr list', 'otra issue create'] }));
  const env = { TYCON_INTEGRATIONS_DIR: conectores };
  // el pedido que el conector declara pregunta, con las opciones antes de cada palabra y su valor
  for (const [cmd, forma] of [['otra pr create --fill', 'otra pr create'], ['otra -R acme/x pr merge 3', 'otra pr merge'],
    ['otra pr --repo=acme/x create', 'otra pr create'], ["bash -c 'otra pr create --title x'", 'otra pr create']]) {
    const r = gancho(h, cmd, { cwd: a, env });
    assert.match(r.stdout, VENTANA, `«${cmd}» pregunta: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`«${forma}»`), `«${cmd}» nombra la forma`);
  }
  // un programa que corre el pedido por su cuenta no se lee
  let r = gancho(h, `node -e "require('child_process').execSync('otra pr create')"`, { cwd: a, env });
  assert.match(r.stdout, VENTANA, `el pedido escondido pregunta: ${r.stderr}`);
  // lo que el conector declara y no crea ni mergea un pedido pasa
  for (const cmd of ['otra pr list', 'otra issue create --title x']) {
    r = gancho(h, cmd, { cwd: a, env });
    assert.strictEqual(r.status, 0, `«${cmd}» pasa: ${r.stderr}`);
    assert.doesNotMatch(r.stdout, VENTANA, cmd);
  }
  // con una integración que no se lee no se sabe qué comandos son pedidos: uno que dice `pr` pregunta, el resto pasa
  escribir(conectores, 'rota/integration.json', '{ no es json');
  r = gancho(h, 'otra pr create --fill', { cwd: a, env });
  assert.match(r.stdout, VENTANA, `sin la lista de los conectores, el pedido pregunta: ${r.stderr}`);
  r = gancho(h, 'git status', { cwd: a, env });
  assert.strictEqual(r.status, 0, `lo que no guarda pasa igual: ${r.stderr}`);
  assert.doesNotMatch(r.stdout, VENTANA);
});

// T14 CambioAUnControl_SiguePidiendoLaFirmaDeControl
// 🔴 Falla con: que sacar el ok de guardar deje un cambio a un freno sin la firma de control del dueño. Guardar pregunta
// en la ventana; el pedido que cambia el freno sigue listado para la firma de control.
test('CambioAUnControl_SiguePidiendoLaFirmaDeControl (T14)', (t) => {
  const RAIZ = path.resolve(SCRIPTS, '..', '..', '..');
  const copia = path.join(tmp(t, 'freno-control-'), 'arnes');
  const clon = spawnSync('git', ['clone', '-q', '--depth', '1', `file://${RAIZ}`, copia], { encoding: 'utf8' });
  assert.strictEqual(clon.status, 0, clon.stderr);
  sh(copia, 'branch', 'base');
  sh(copia, 'checkout', '-q', '-b', 'pedido');
  const freno = 'skills/tycon-pipeline/scripts/lib/save-brake.js';
  fs.appendFileSync(path.join(copia, freno), '// un cambio al freno de guardar\n');
  sh(copia, 'commit', '-q', '-am', 'toca el freno');
  // guardar, dentro de una corrida, pregunta en la ventana: no firma ni saltea nada
  const h = home(t);
  abrir(h, corrida(copia));
  const d = brake().decidir({ command: 'git push origin pedido', cwd: copia, sid: SID, home: h });
  assert.ok(d && d.pregunta, `guardar pregunta: ${JSON.stringify(d)}`);
  // y el pedido sigue pidiendo la firma de control por ese archivo
  const r = spawnSync('bash', [path.join(copia, 'scripts', 'ci', 'run-base-controls.sh'), 'pending', '--root', copia, '--base', 'base', '--range', 'base...pedido'],
    { encoding: 'utf8', env: { ...SIN_SESION, HOME: h, USERPROFILE: h } });
  const salida = `${r.stdout}${r.stderr}`;
  assert.match(salida, new RegExp(`${freno.replace(/[.]/g, '\\.')} \\(código que corre un control\\)`), salida);
  assert.match(salida, /approve --root/, `da el comando de la firma: ${salida}`);
});
