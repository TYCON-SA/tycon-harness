'use strict';
/**
 * save-brake.test.js — el freno de guardar: dentro de una corrida, un commit, un push o un pedido sin el ok de guardar
 * vigente no pasa; cerrar la corrida sin el ok tampoco lo esquiva.
 *
 * Laboratorio por prueba: una HOME vacía, un repo con su `origin` (un repo desnudo local) y la rama de la story
 * empujada con seguimiento, y el marcador de la corrida en el estado de esa HOME. El gancho (`on-pre-commit.js`) corre
 * como lo corre Claude Code, con el evento por la entrada; `marker.js` con la sesión por el ambiente. Ninguna prueba
 * abre la ventana de permiso: la constancia `saveOk` se arma con la misma biblioteca que usa `approve-save`.
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
const SO = require('../lib/save-ok.js');
const { conVentana } = require(path.join(SCRIPTS, '..', '..', '..', 'scripts', 'tests', 'lib', 'window-passed.js'));

const ANTES = '2026-10-29T10:00:00.000Z';
const DESPUES = '2026-10-29T11:00:00.000Z';
const RAMA = 'story/la-prueba';
const SID = 'ses-freno';
// el texto con que frena el freno: lo distingue de los otros controles del gancho
const FRENO = /OK DE GUARDAR/;
// el texto del comando que el freno no puede leer con certeza
const NO_LEO = /no pude leer este comando; si guarda, pedí el ok primero/;

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
/** El ok de guardar de la corrida, armado con la misma biblioteca que usa `approve-save` después de la firma. */
function conOk(marker) {
  const repos = SO.reposDeLaCorrida({ marker, hermanos: [] });
  const previo = SO.antesDeFirmar({ via: 'ventana', marker, repos });
  assert.strictEqual(previo.codigo, 0, previo.motivo);
  return { ...marker, saveOk: SO.constancia({ marker, via: 'ventana', previo, ahora: DESPUES }) };
}

const SIN_SESION = Object.fromEntries(Object.keys(process.env).filter((k) => !/^(CLAUDE_CODE_SESSION_ID|TYCON_SESSION_ID|CODEX_SESSION_ID)$/.test(k)).map((k) => [k, process.env[k]]));
/** El gancho con el evento de Claude Code: `{ status, stderr, stdout }`. */
function gancho(h, command, { cwd, sid = SID, env = {}, transcript, preload } = {}) {
  const ev = { session_id: sid, tool_name: 'Bash', tool_input: { command }, cwd, ...(transcript ? { transcript_path: transcript } : {}) };
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
/** `approve-save` de verdad, con la ventana de permiso dada por pasada: devuelve el marcador con su `saveOk`. */
function aprobar(h, repo, sid = SID) {
  const r = marker(h, ['approve-save'], { cwd: repo, sid, env: conVentana({}) });
  assert.strictEqual(r.status, 0, `approve-save: ${r.stderr}${r.stdout}`);
  const m = JSON.parse(fs.readFileSync(marcadorPath(h, sid), 'utf8'));
  assert.ok(m.saveOk, 'approve-save escribió el saveOk');
  return m;
}
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

// T1 Freno_Commit_CadaForma_SinOk
// 🔴 Falla con: una forma de commit que el freno no lee (otro directorio, la variable delante, un shell envuelto, un
// encadenado) guarda sin el ok de guardar.
test('Freno_Commit_CadaForma_SinOk (T1) @story-8.151 @ac-1', (t) => {
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
    assert.strictEqual(r.status, 2, `«${cmd}» frena: ${r.stderr}`);
    assert.match(r.stderr, FRENO, cmd);
    assert.match(r.stderr, /approve-save/, `«${cmd}» nombra approve-save`);
    assert.match(r.stderr, /«git commit»/, `«${cmd}» nombra la forma`);
  }
  // el repo se nombra con su ruta
  assert.ok(gancho(h, 'git commit -m x', { cwd: a }).stderr.includes(a), 'nombra el repo');
  assert.strictEqual(sh(a, 'rev-parse', 'HEAD'), head, 'ningún commit nuevo');
  // desde la carpeta de la corrida: la variable sin exportar (o exportada en un subshell, o en otro shell) no cambia el
  // repo, `--work-tree` sin `--git-dir` tampoco, la forma con guion de git corre el mismo commit, y el alias del shell
  copiaDelShell(h);
  const vacia = tmp(t, 'freno-vacia-');
  for (const cmd of [`GIT_DIR=${otro}/.git; git commit -m x`, `(export GIT_DIR=${otro}/.git); git commit -m x`,
    `bash -c 'export GIT_DIR=${otro}/.git'; git commit -m x`, `git --work-tree=${vacia} commit -m x`, `GIT_WORK_TREE=${vacia} git commit -m x`,
    `${sh(a, '--exec-path')}/git-commit -m x`, 'git-commit -m x', "gcam 'x'"]) {
    const r = gancho(h, cmd, { cwd: a });
    assert.strictEqual(r.status, 2, `«${cmd}» frena: ${r.stderr}`);
    assert.match(r.stderr, /«git commit»/, `«${cmd}» nombra la forma`);
  }
});

// T2 Freno_PushYPedidos_SinOk
// 🔴 Falla con: un push o un pedido que pasa sin el ok de guardar.
test('Freno_PushYPedidos_SinOk (T2) @story-8.151 @ac-2', (t) => {
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
    assert.strictEqual(r.status, 2, `«${cmd}» frena: ${r.stderr}`);
    assert.match(r.stderr, FRENO, cmd);
    assert.match(r.stderr, /approve-save/, cmd);
    // la forma es la que declara el conector: el alias `pr new` es una forma propia
    assert.match(r.stderr, /«(git push|gh pr create|gh pr new|gh pr merge|az repos pr create)»/, `«${cmd}» nombra la forma`);
  }
  // el texto nombra la forma y el repo, nunca el comando: un comando puede traer una credencial
  const MARCA = 'MARCA-QUE-NO-SALE';
  // ni la carpeta que sale del comando
  fs.mkdirSync(path.join(a, MARCA));
  for (const cmd of [`git push https://u:${MARCA}@example.com/x.git ${RAMA}`, `gh pr create --title t --body "${MARCA}"`,
    `git commit -m "${MARCA}"`, `az repos pr create --title ${MARCA}`, `$G push ${MARCA}`, `git -C ${a}/${MARCA} commit -m x`,
    `cd ${a}/${MARCA} && git push`]) {
    const r = gancho(h, cmd, { cwd: a });
    assert.strictEqual(r.status, 2, `«${cmd}» frena: ${r.stderr}`);
    assert.ok(!r.stderr.includes(MARCA), `el texto no repite el comando: ${r.stderr}`);
  }
});

// T3 Freno_NoEsComando_Pasa
// 🔴 Falla con: el freno leyendo texto como comando (un mensaje, un eco, una búsqueda): frenaría trabajo que no guarda.
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
    assert.doesNotMatch(r.stderr, FRENO, cmd);
  }
});

// T4 Freno_ConOkVigente_PasaSinPreguntar
// 🔴 Falla con: el ok vigente que igual pregunta o avisa (el freno molesta en el camino normal), o un push a main, a
// otra rama o un cambio después del ok que pasa.
test('Freno_ConOkVigente_PasaSinPreguntar (T4) @story-8.151 @ac-4', (t) => {
  const h = home(t);
  const a = repoConOrigin(t);
  escribir(a, 'app.js', 'module.exports = 1;\n');
  abrir(h, corrida(a, { fileEvents: [{ path: path.join(a, 'app.js'), ts: ANTES, code: true }] }));
  aprobar(h, a);
  assert.strictEqual(brake().decidir({ command: 'git commit -m x', cwd: a, sid: SID, home: h }), null, 'el commit pasa');
  for (const cmd of [`git push origin ${RAMA}`, 'git push', 'gh pr create --fill', 'az repos pr create --title x']) {
    assert.strictEqual(brake().decidir({ command: cmd, cwd: a, sid: SID, home: h }), null, `«${cmd}» pasa`);
    const r = gancho(h, cmd, { cwd: a });
    assert.strictEqual(r.status, 0, `«${cmd}»: ${r.stderr}`);
    assert.strictEqual(r.stderr + r.stdout, '', `«${cmd}» pasa sin salida`);
  }
  const r = gancho(h, 'git commit -m x', { cwd: a });
  assert.doesNotMatch(r.stderr, FRENO, 'el commit no lo frena el freno');
  // el commit con el mensaje en un heredoc, con comillas y apóstrofes adentro, se lee: con el ok pasa
  const conHeredoc = `git commit -m "$(cat <<'EOF'\nun "mensaje" que dice it's # y un numeral\nEOF\n)"`;
  assert.strictEqual(brake().decidir({ command: conHeredoc, cwd: a, sid: SID, home: h }), null, 'el commit con heredoc pasa');
  for (const [cmd, motivo] of [['git push origin main', /no cubre empujar a main/], ['git push origin master', /no cubre empujar a master/],
    ['git push origin otra', /el ok es para la rama/], [`git push origin ${RAMA} main`, /no cubre empujar a main/],
    ['git push origin HEAD:refs/heads/main', /no cubre empujar a main/], ['git push --all origin', /el ok es para la rama/],
    ['git push --mirror', /el ok es para la rama/], ['G=git; $G commit -m x', NO_LEO], ['=git push origin main', /no cubre empujar a main/],
    // el destino que el mismo comando cambia antes del push: otra rama, la configuración, la refspec de coincidencia, la
    // rama que agrega xargs
    ['git checkout main && git push origin', /no se sabe a qué rama empuja/], ['git switch main; git push', /no se sabe a qué rama empuja/],
    ['git checkout main && git push origin HEAD', /no se sabe a qué rama empuja/],
    ['git -c remote.origin.push=HEAD:refs/heads/main push origin', /no se sabe a qué rama empuja/], ['git push origin :', /no se sabe a qué rama empuja/],
    ['echo main | xargs git push origin', /no se sabe a qué rama empuja/],
    // el comando que cambia archivos del repo antes de guardar: el ok es del árbol de antes
    ['echo zz >> app.js && git commit -am x', /cambia archivos del repo antes de guardar/],
    ["sed -i.bak 's/1/2/' app.js && git commit -am x", /cambia archivos del repo antes de guardar/],
    ['touch nuevo.js; git add -A; git commit -m x', /cambia archivos del repo antes de guardar/],
    [`git stash && git push origin ${RAMA}`, /cambia archivos del repo antes de guardar/]]) {
    const x = gancho(h, cmd, { cwd: a });
    assert.strictEqual(x.status, 2, cmd);
    assert.match(x.stderr, motivo, cmd);
  }
  // la memoria que exporta el cierre después del ok (los trozos y su índice) no vence el ok, ni cuenta como cambio
  escribir(a, '.engram/manifest.json', '{ "chunks": [] }\n');
  escribir(a, '.engram/chunks/abc.jsonl.gz', 'x');
  assert.strictEqual(brake().decidir({ command: 'git commit -m x', cwd: a, sid: SID, home: h }), null, 'la memoria exportada no vence el ok');
  const memoria = repoConOrigin(t, 'memoria');
  escribir(memoria, '.engram/manifest.json', '{ "chunks": [] }\n');
  assert.strictEqual(brake().tieneCambiosDeCodigo(memoria), false, 'el índice de la memoria no es código');
  // la rama escrita en el comando no vuelve en el texto: puede ser una credencial
  const MARCA = 'MARCA-QUE-NO-SALE';
  for (const cmd of [`git push origin ${MARCA}`, `git push origin HEAD:${MARCA}`]) {
    const x = gancho(h, cmd, { cwd: a });
    assert.strictEqual(x.status, 2, cmd);
    assert.ok(!x.stderr.includes(MARCA), `el texto no repite la rama del comando: ${x.stderr}`);
  }
  escribir(a, 'app.js', 'module.exports = 2;\n');
  const c = gancho(h, 'git commit -m x', { cwd: a });
  assert.strictEqual(c.status, 2);
  assert.match(c.stderr, /cambió después del ok/);
});

// T4b Freno_ConOk_LoComunPasa
// 🔴 Falla con: un comando común dentro de una corrida con el ok vigente (mirar, probar, un alias del shell, la salida
// del push a un archivo, una cuenta del shell) que frena: frenar de más interrumpe tanto como dejar pasar.
test('Freno_ConOk_LoComunPasa (T4b) @story-8.151 @ac-4', (t) => {
  const h = home(t);
  const a = repoConOrigin(t);
  copiaDelShell(h);
  // un programa que está sólo en el PATH que exporta la copia del shell (el del hook puede no traerlo)
  const herramientas = tmp(t, 'freno-herramientas-');
  fs.writeFileSync(path.join(herramientas, 'herramienta-del-shell'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.appendFileSync(path.join(h, '.claude', 'shell-snapshots', 'snapshot-zsh-1-prueba.sh'), `export PATH='${herramientas}:/usr/bin:/bin'\n`
    // los alias de oh-my-zsh que empujan a la rama actual
    + `alias -- ggpush='git push origin "$(git_current_branch)"'\nalias -- gpsup='git push --set-upstream origin $(git_current_branch)'\n`);
  // un programa dado con su ruta: absoluta y con `~`
  fs.mkdirSync(path.join(h, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(h, 'bin', 'herramienta-local'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  escribir(a, 'app.js', 'module.exports = 1;\n');
  abrir(h, corrida(a, { fileEvents: [{ path: path.join(a, 'app.js'), ts: ANTES, code: true }] }));
  aprobar(h, a);
  const log = path.join(tmp(t, 'freno-log-'), 'salida.log');
  const COMUNES = ['ls', 'ls -la', 'll', 'll src', 'cat app.js', 'grep -rn x .', 'npm test', 'npm test -- app.test.js 2>&1 | tail -5', 'git status',
    'gst', 'git log --oneline -3', 'git diff', 'git diff --stat 2>/dev/null', 'mirar', 'herramienta-que-no-esta --version', 'noglob git status',
    `git push origin ${RAMA} 2>&1`, `git push origin ${RAMA} > ${log}`, `git push origin ${RAMA} 2>/dev/null`, `git push origin ${RAMA} 2>&1 | tail -5`,
    `git push origin ${RAMA} &> ${log}`, `git push origin ${RAMA} >${log} 2>&1`, 'git push -u origin HEAD 2>&1', 'git push origin @',
    `time -p git push origin ${RAMA}`, 'gp', 'gpo HEAD', 'subir HEAD', `echo listo > ${log} && git commit -m x`,
    `git add -A && git commit -m x && git push origin ${RAMA} 2>&1 | tail -3`,
    'echo $((60*5))', 'timeout $((2*60)) npm test', 'x=$((3*4)); echo $x', 'n=$((arr[1]+1))', 'echo $((1<<2))',
    'git show-branch', 'git check-attr -a app.js', 'git whatchanged -1', 'echo `echo hi # x`; git status',
    "echo $'\\U110000'", "git commit -m $'\\UFFFFFFFF'", 'herramienta-del-shell push',
    `${path.join(herramientas, 'herramienta-del-shell')} push`, '~/bin/herramienta-local push',
    'git push origin $(git branch --show-current)', 'git push origin "$(git rev-parse --abbrev-ref HEAD)"',
    'git push -u origin `git symbolic-ref --short HEAD`', 'ggpush', 'gpsup',
    `git branch --show-current && git push origin HEAD`, `git remote -v; git config --get remote.origin.url; git push origin ${RAMA}`];
  for (const cmd of COMUNES) {
    let d;
    assert.doesNotThrow(() => { d = brake().decidir({ command: cmd, cwd: a, sid: SID, home: h }); }, cmd);
    assert.strictEqual(d, null, `«${cmd}» pasa: ${d && d.texto}`);
    const r = gancho(h, cmd, { cwd: a });
    // el commit lo miran además los otros controles del gancho: acá sólo cuenta que el freno no frene
    if (!/git commit/.test(cmd)) assert.strictEqual(r.status, 0, `«${cmd}»: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, FRENO, cmd);
  }
  // una rama que sale de otro comando que no es la rama actual: no se sabe a dónde empuja
  for (const cmd of ['git push origin $(cat rama.txt)', 'git push origin "$RAMA_DESTINO"', 'git branch -m otra && git push origin HEAD',
    'git config --unset push.default; git push']) {
    const d = brake().decidir({ command: cmd, cwd: a, sid: SID, home: h });
    assert.ok(d && /rama/.test(d.texto), `«${cmd}» frena: ${d && d.texto}`);
  }
});

// T5 Freno_RepoAjeno_Pasa_PedidoJuzgaLaCorrida
// 🔴 Falla con: el freno parando el trabajo de otro repo (un arreglo aparte en otro clon), o un pedido que pasa porque
// se abre desde un repo que no es de la corrida.
test('Freno_RepoAjeno_Pasa_PedidoJuzgaLaCorrida (T5) @story-8.151 @ac-5', (t) => {
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
  assert.strictEqual(r.status, 2, 'el pedido se juzga contra toda la corrida');
  assert.match(r.stderr, FRENO);
});

// T6 Freno_SinCorrida_O_Adhoc_IgualQueHoy
// 🔴 Falla con: el freno cambiando lo que pasa fuera de una corrida (un aviso, una salida distinta o un freno nuevo
// para quien trabaja sin pipeline).
test('Freno_SinCorrida_O_Adhoc_IgualQueHoy (T6) @story-8.151 @ac-6', (t) => {
  const h = home(t);
  const a = repoConOrigin(t);
  escribir(a, 'app.js', 'module.exports = 1;\n');
  // la salida de hoy: el mismo gancho con el freno que nunca frena
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
});

// T7 Freno_OkDichoEnElChat_NoAlcanza
// 🔴 Falla con: el ok dado por una frase, una opción o una variable: cualquiera que escribe en la conversación o en el
// comando abriría el freno.
test('Freno_OkDichoEnElChat_NoAlcanza (T7) @story-8.151 @ac-7', (t) => {
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
    assert.strictEqual(r.status, 2, `«${cmd}» frena`);
    assert.match(r.stderr, FRENO, cmd);
  }
  const r = gancho(h, 'git commit -m x', { cwd: a, env: { TYCON_SAVE_BRAKE: 'off', TYCON_SAVE_OK: '1' } });
  assert.strictEqual(r.status, 2, 'una variable del ambiente no lo apaga');
});

// T8 Freno_NoSePuedeLeer_FrenaAdentro
// 🔴 Falla con: no poder leer el marcador, no poder medir con git o un comando escondido en una variable leídos como
// «no hay nada que frenar» dentro de una corrida; o frenando a quien trabaja sin corrida.
test('Freno_NoSePuedeLeer_FrenaAdentro (T8) @story-8.151 @ac-8', (t) => {
  const h = home(t);
  const a = repoConOrigin(t);
  // un git que falla sólo al armar el árbol de la huella
  const bin = tmp(t, 'freno-bin-');
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nfor x in "$@"; do [ "$x" = write-tree ] && { echo "fatal: de mentira" >&2; exit 128; }; done\nexec ${real} "$@"\n`, { mode: 0o755 });
  const PATH_FALSO = { PATH: `${bin}${path.delimiter}${process.env.PATH}` };

  // adentro
  fs.writeFileSync(marcadorPath(h), '{ esto no es json');
  let r = gancho(h, 'git commit -m x', { cwd: a });
  assert.strictEqual(r.status, 2, `el marcador ilegible frena: ${r.stderr}`);
  assert.match(r.stderr, /no se puede leer|no pude leer/);
  abrir(h, conOk(corrida(a)));
  r = gancho(h, 'git commit -m x', { cwd: a, env: PATH_FALSO });
  assert.strictEqual(r.status, 2, `git que no contesta frena: ${r.stderr}`);
  assert.match(r.stderr, /no pude medirlo/);
  // el comando, o su repo, que no se puede leer: una variable, una carpeta que sale de una variable, un alias o una
  // configuración que viene del ambiente, o un programa que corre git por su cuenta
  const OPACOS = ['G=git; $G commit -m x', '${G} push', '$GH pr create', '${G:-git} commit -m x', 'env $G commit -m x', '$(which git) push',
    'git $SUB -m x', 'cd $D && git commit -m x', 'cd - && git push', 'git -C $D commit -m x', 'git --git-dir=$D/.git push',
    'GIT_DIR=$X git commit -m x', 'git --config-env alias.ci=V ci -m x', 'watch git commit -m x', "find . -exec git push \\;"];
  // y lo que no se puede leer con certeza, guarde o no: el comando entero en una variable, un shell que lee de un tubo,
  // una función o un alias del shell, un subcomando de git que no es de git, más de cuatro niveles, una ruta de Windows
  // sin sus barras
  const DUDAS = ["C='git commit -m x'; $C", 'eval $C', 'bash -c "$C"', '$(cat guion.txt)', "echo 'git commit -m x' | sh",
    "printf 'git push' | bash", 'bash <<< "git push"', 'bash <<FIN\ngit push\nFIN', 'cat guion | zsh -s', 'g(){ git "$@"; }; g commit -m x',
    'function g { git "$@"; }; g push', 'alias g=git; g commit -m x', 'git -c help.autocorrect=immediate comit -m x', 'git comit -m x',
    'git -c alias.a=commit -c alias.b=a -c alias.c=b -c alias.d=c -c alias.e=d -c alias.f=e f -m x',
    'echo $(echo $(echo $(echo $(echo $(git push)))))', 'echo commit | xargs git', 'C:\\Git\\git.exe push',
    // el comando armado de un texto, un shell con opciones que llevan valor, una comilla sin cerrar, un heredoc que corre
    // algo, y el programa escrito con lo que el shell expande
    "env -S 'git commit -m x'", "env --split-string='git push'", "sudo -s 'git commit -m x'",
    'bash -c', 'sh -ec', "echo 'sin cerrar; git commit -m x",
    'cat <<FIN\n$(git push)\nFIN', 'cat <<FIN\ngit commit -m x', '/usr/bin/g?t commit -m x', '/usr/bin/gi[t] commit -m x', '{git,commit} -m x',
    'HOME=/tmp/otra git ci -m x', 'GIT_CONFIG_GLOBAL=/tmp/f git ci -m x', 'XDG_CONFIG_HOME=/tmp/x git ci -m x',
    // el shell que lee de la entrada con `-` o `/dev/stdin`, un intérprete que recibe el guion por un heredoc, y un
    // programa que no se encuentra con palabras de guardar
    "printf 'git push origin main\\n' | bash -", "echo 'git push' | sh -", "echo 'git push' | bash /dev/stdin",
    "python3 - <<'EOF'\nimport os; os.system('git push')\nEOF", "node <<'EOF'\nrequire('child_process').execSync('git push')\nEOF",
    'programa-que-no-esta commit -m x'];
  for (const cmd of [...OPACOS, ...DUDAS]) {
    r = gancho(h, cmd, { cwd: a });
    assert.strictEqual(r.status, 2, `«${cmd}» frena: ${r.stderr}`);
    assert.match(r.stderr, NO_LEO, cmd);
  }
  // la copia del shell que no da certeza: una función que envuelve otro programa y dice guardar, un alias que dos copias
  // definen distinto, y una copia que no se puede leer (con un alias que no está en el PATH)
  const copias = path.join(h, '.claude', 'shell-snapshots');
  fs.mkdirSync(copias, { recursive: true });
  fs.writeFileSync(path.join(copias, 'snapshot-zsh-1-vieja.sh'), "alias -- gcm='git commit -m'\n");
  fs.writeFileSync(path.join(copias, 'snapshot-zsh-2-nueva.sh'), ["alias -- gcm='echo'", 'g () {', '\t/opt/no-esta/gitw "$@"', '}', ''].join('\n'));
  for (const cmd of ['g commit -m x', 'gcm x']) {
    r = gancho(h, cmd, { cwd: a });
    assert.strictEqual(r.status, 2, `«${cmd}» frena: ${r.stderr}`);
    assert.match(r.stderr, NO_LEO, cmd);
  }
  fs.rmSync(copias, { recursive: true });
  if (process.platform !== 'win32' && process.getuid && process.getuid() !== 0) {
    fs.mkdirSync(copias, { recursive: true });
    fs.writeFileSync(path.join(copias, 'snapshot-zsh-1-cerrada.sh'), "alias -- gp='git push'\n", { mode: 0o000 });
    r = gancho(h, 'gp', { cwd: a });
    assert.strictEqual(r.status, 2, `con la copia que no se lee, un alias que no está en el PATH frena: ${r.stderr}`);
    assert.match(r.stderr, NO_LEO);
    fs.rmSync(copias, { recursive: true, force: true });
  }
  // un marcador que se lee pero no es el de una corrida
  for (const raro of ['null', '[]', '{}', '"9.99"']) {
    fs.writeFileSync(marcadorPath(h), raro);
    r = gancho(h, 'git commit -m x', { cwd: a });
    assert.strictEqual(r.status, 2, `el marcador ${raro} frena: ${r.stderr}`);
    assert.match(r.stderr, /marcador/, raro);
  }
  // el freno que no carga frena adentro
  abrir(h, corrida(a));
  for (const cmd of ['git commit -m x', 'git ci -m x', '$C', "echo 'x' | sh", 'gh pr create --fill', 'az repos pr create', 'eval x',
    'g(){ :; }; g', 'alias g=x', 'cat f | dash', 'cat f | fish', 'cat f | ksh', 'source x.sh', '. ./x.sh', 'xargs < f', '{git,commit} -m x']) {
    r = gancho(h, cmd, { cwd: a, preload: frenoRoto(t) });
    assert.strictEqual(r.status, 2, `«${cmd}»: el freno que no carga frena adentro: ${r.stderr}`);
    assert.match(r.stderr, FRENO);
  }
  // el alias de git que no se pudo buscar, adentro: frena como lo que no se lee
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nfor x in "$@"; do [ "$x" = --get ] && { echo "fatal: de mentira" >&2; exit 3; }; done\nexec ${real} "$@"\n`, { mode: 0o755 });
  r = gancho(h, 'git ci -m x', { cwd: a, env: PATH_FALSO });
  assert.strictEqual(r.status, 2, `adentro, el alias que no se pudo buscar frena: ${r.stderr}`);
  assert.match(r.stderr, NO_LEO);
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nfor x in "$@"; do [ "$x" = write-tree ] && { echo "fatal: de mentira" >&2; exit 128; }; done\nexec ${real} "$@"\n`, { mode: 0o755 });

  // afuera
  fs.rmSync(marcadorPath(h));
  r = gancho(h, 'git push', { cwd: a, env: PATH_FALSO });
  assert.strictEqual(r.status, 0, 'sin corrida, git que no contesta no frena');
  for (const cmd of [...OPACOS, ...DUDAS]) {
    assert.strictEqual(brake().decidir({ command: cmd, cwd: a, sid: SID, home: h }), null, `«${cmd}» pasa sin corrida`);
  }
  // el freno que no carga deja pasar afuera, y lo dice
  r = gancho(h, 'git push', { cwd: a, preload: frenoRoto(t) });
  assert.strictEqual(r.status, 0, `afuera, el freno que no carga deja pasar: ${r.stderr}`);
  assert.match(r.stderr, /freno de guardar no pudo correr/);
  r = gancho(h, 'ls', { cwd: a, preload: frenoRoto(t) });
  assert.strictEqual(r.status, 0, `afuera, lo que no guarda pasa con el freno roto: ${r.stderr}`);

  // un registro «cerrada sin ok» que no se lee frena también afuera
  fs.mkdirSync(path.dirname(registroPath(h)), { recursive: true });
  fs.writeFileSync(registroPath(h), '{ esto no es json');
  r = gancho(h, 'git commit -m x', { cwd: a });
  assert.strictEqual(r.status, 2, `afuera, el registro ilegible frena: ${r.stderr}`);
  assert.match(r.stderr, /no pude leer el registro/);
  fs.rmSync(registroPath(h));

  // un git que falla al buscar un alias no se lee como «no es un alias»: con el registro de la sesión, frena
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nfor x in "$@"; do [ "$x" = --get ] && { echo "fatal: de mentira" >&2; exit 3; }; done\nexec ${real} "$@"\n`, { mode: 0o755 });
  escribir(a, 'app.js', 'module.exports = 1;\n');
  fs.mkdirSync(path.dirname(registroPath(h)), { recursive: true });
  fs.writeFileSync(registroPath(h), JSON.stringify([{ story: '9.97', repos: [a], ts: ANTES }]));
  r = gancho(h, 'git ci -m x', { cwd: a, env: PATH_FALSO });
  assert.strictEqual(r.status, 2, `el alias que no se pudo buscar frena: ${r.stderr}`);
  assert.match(r.stderr, FRENO);
});

// T9 Clear_Y_ClearSession_SinOk_ConCambios_Sale2
// 🔴 Falla con: cerrar la corrida sin el ok como salida del freno, o un cierre que no deja el registro.
test('Clear_Y_ClearSession_SinOk_ConCambios_Sale2 (T9) @story-8.151 @ac-9', (t) => {
  const h = home(t);
  const a = repoConOrigin(t);
  escribir(a, 'app.js', 'module.exports = 1;\n');
  for (const args of [['clear'], ['clear-session', SID]]) {
    abrir(h, corrida(a));
    const r = marker(h, args, { cwd: a });
    assert.strictEqual(r.status, 2, `${args.join(' ')} sin ok sale 2: ${r.stderr}`);
    assert.match(r.stderr, /approve-save/);
    assert.match(r.stderr, /--discard/);
    assert.ok(fs.existsSync(marcadorPath(h)), `${args.join(' ')}: el marcador queda`);
  }
  // con el ok vigente cierra, y no deja registro
  abrir(h, conOk(corrida(a)));
  let r = marker(h, ['clear'], { cwd: a });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(marcadorPath(h)));
  assert.ok(!fs.existsSync(registroPath(h)), 'con el ok no hay registro');
  // sin cambios cierra
  const limpio = repoConOrigin(t, 'limpio');
  abrir(h, corrida(limpio));
  r = marker(h, ['clear-session', SID], { cwd: limpio });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(registroPath(h)), 'sin cambios no hay registro');

  // desde otra sesión cierra, y deja el registro para la sesión de la corrida
  abrir(h, corrida(a));
  r = marker(h, ['clear-session', SID], { cwd: a, sid: 'ses-otra' });
  assert.strictEqual(r.status, 0, r.stderr);
  let reg = JSON.parse(fs.readFileSync(registroPath(h), 'utf8'));
  assert.ok(reg.some((e) => e.story === '9.99' && e.repos.includes(a)), JSON.stringify(reg));
  fs.rmSync(registroPath(h));

  // el reemplazo por otra story deja el registro
  abrir(h, corrida(a));
  r = marker(h, ['set', JSON.stringify({ storyId: '9.98', repoPath: a }), '--replace'], { cwd: a });
  assert.strictEqual(r.status, 0, r.stderr);
  reg = JSON.parse(fs.readFileSync(registroPath(h), 'utf8'));
  assert.ok(reg.some((e) => e.story === '9.99'), 'el reemplazo deja el registro');
  fs.rmSync(marcadorPath(h));
  fs.rmSync(registroPath(h));

  // la poda por antigüedad deja el registro
  abrir(h, corrida(a, { lastTouch: '2026-01-01T00:00:00.000Z' }));
  r = marker(h, ['list-all'], { cwd: a, sid: 'ses-otra' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(marcadorPath(h)), 'la poda borró el marcador');
  reg = JSON.parse(fs.readFileSync(registroPath(h), 'utf8'));
  assert.ok(reg.some((e) => e.story === '9.99'), 'la poda deja el registro');
  fs.rmSync(registroPath(h));

  // la adopción no deja registro: la corrida sigue, en la sesión que adopta
  abrir(h, corrida(a));
  r = marker(h, ['adopt-session', SID], { cwd: a, sid: 'ses-adopta' });
  assert.strictEqual(r.status, 0, `adopt-session: ${r.stderr}`);
  assert.ok(!fs.existsSync(registroPath(h)), `la adopción no deja registro: ${r.stderr}`);
  assert.strictEqual(JSON.parse(fs.readFileSync(marcadorPath(h, 'ses-adopta'), 'utf8')).storyId, '9.99', 'el marcador pasó a la sesión que adopta');
  fs.rmSync(marcadorPath(h, 'ses-adopta'));

  // un marcador que no se lee: no se sabe qué deja sin guardar ni se puede anotar, así que ningún cierre lo borra (ni
  // con --discard, ni desde otra sesión): sale 2 y lo saca una persona
  for (const roto of ['{ esto no es json', '{}', 'null']) {
    for (const [args, sid] of [[['clear'], SID], [['clear', '--discard'], SID], [['clear-session', SID], SID],
      [['clear-session', SID, '--discard'], SID], [['clear-session', SID], 'ses-otra'], [['set', JSON.stringify({ storyId: '9.98', repoPath: a })], SID],
      [['set', JSON.stringify({ storyId: '9.98', repoPath: a }), '--replace'], SID]]) {
      fs.writeFileSync(marcadorPath(h), roto);
      r = marker(h, args, { cwd: a, sid });
      assert.strictEqual(r.status, 2, `${args.join(' ')} con el marcador ${roto} sale 2: ${r.stderr}`);
      assert.match(r.stderr, /no se puede leer/);
      assert.match(r.stderr, /una persona/);
      assert.strictEqual(fs.readFileSync(marcadorPath(h), 'utf8'), roto, `${args.join(' ')}: el marcador ${roto} queda`);
    }
  }
  fs.rmSync(marcadorPath(h));

  // el registro que no se puede escribir: el cierre no se hace (el freno no se pierde por un error de disco)
  fs.rmSync(path.join(estado(h), 'save-closed'), { recursive: true, force: true });
  fs.writeFileSync(path.join(estado(h), 'save-closed'), 'no es una carpeta');
  for (const [args, sid] of [[['clear', '--discard'], SID], [['clear-session', SID, '--discard'], SID], [['clear-session', SID], 'ses-otra']]) {
    abrir(h, corrida(a));
    r = marker(h, args, { cwd: a, sid });
    assert.strictEqual(r.status, 1, `${args.join(' ')} sin poder anotar el registro sale 1: ${r.stderr}`);
    assert.match(r.stderr, /no pude anotar/);
    assert.ok(fs.existsSync(marcadorPath(h)), `${args.join(' ')}: el marcador queda`);
  }
  // el reemplazo por otra story tampoco borra sin anotar
  abrir(h, corrida(a));
  r = marker(h, ['set', JSON.stringify({ storyId: '9.98', repoPath: a }), '--replace'], { cwd: a });
  assert.strictEqual(r.status, 1, `set --replace sin poder anotar sale 1: ${r.stderr}`);
  assert.match(r.stderr, /no pude anotar/);
  assert.strictEqual(JSON.parse(fs.readFileSync(marcadorPath(h), 'utf8')).storyId, '9.99', 'el marcador de la corrida queda');
  // ni la poda por antigüedad: el marcador queda hasta poder anotarlo
  abrir(h, corrida(a, { lastTouch: '2026-01-01T00:00:00.000Z' }));
  r = marker(h, ['list-all'], { cwd: a, sid: 'ses-otra' });
  assert.ok(fs.existsSync(marcadorPath(h)), `la poda no borra sin anotar: ${r.stderr}`);
  fs.rmSync(path.join(estado(h), 'save-closed'));
  fs.rmSync(marcadorPath(h));

  // sin poder saber los repos de la corrida (la story ya no está), cuentan todos los que la corrida nombra: el suyo, el
  // de la story y los de los archivos que tocó
  const eventos = repoConOrigin(t, 'eventos');
  escribir(eventos, 'b.js', 'x\n');
  const s = brake().sinOk({ marker: corrida(a, { storyPath: path.join(a, 'specs', 'no-esta.md'), fileEvents: [{ path: path.join(eventos, 'b.js'), ts: ANTES, code: true }] }) });
  assert.ok(s && s.repos.includes(a) && s.repos.includes(eventos), `cuentan todos los repos: ${JSON.stringify(s)}`);
  // el repo de la corrida que git no contesta tampoco sale de la cuenta, aunque otro sí conteste
  const raizReal = SO.raizDe;
  SO.raizDe = (p) => { if (path.resolve(p).startsWith(a)) throw new Error('git no contesta'); return raizReal(p); };
  let s2;
  try { s2 = brake().sinOk({ marker: corrida(a, { fileEvents: [{ path: path.join(eventos, 'b.js'), ts: ANTES, code: true }] }) }); } finally { SO.raizDe = raizReal; }
  assert.ok(s2 && s2.repos.includes(a) && s2.repos.includes(eventos), `el repo que no contesta cuenta: ${JSON.stringify(s2)}`);
});

// T9b PerdidaYRestore_DejanElRegistro
// 🔴 Falla con: las salidas que firma una persona (cerrar una corrida perdida, o restaurar otra encima de la propia)
// como puerta para guardar sin el ok.
test('PerdidaYRestore_DejanElRegistro (T9b) @story-8.151 @ac-9', (t) => {
  const h = home(t);
  const a = repoConOrigin(t);
  // `start` de verdad: el arnés enlazado en la HOME y stories listas para implementar
  const RAIZ = path.resolve(SCRIPTS, '..', '..', '..');
  fs.symlinkSync(RAIZ, path.join(h, '.claude', 'agent-skills'));
  fs.symlinkSync(RAIZ, path.join(h, '.claude', 'tycon-harness'));
  const historia = (n) => {
    const f = path.join(a, 'specs', `story-${n}-perdida.md`);
    fs.writeFileSync(f, ['---', `story: "${n}"`, 'title: "perdida"', 'status: ready-for-dev', 'files_to_modify:', '  - app.js', '---',
      `# Story ${n}`, '', '### Tests', '', '| # | Test |', '|---|---|', '| T1 | a |', '', '## Dev Agent Record', ''].join('\n'));
    return f;
  };
  const ENV = { TYCON_LANE_LLM: '0', TYCON_HOME: '', TYCON_TIME_TRACKING: 'none', TYCON_MUTATION_CHECK: 'off', TYCON_GUIDES_DIR: RAIZ };
  const pipeline = (args, o) => guion(PIPELINE, h, args, { ...o, env: ENV });
  // una corrida arrancada de verdad, con cambios, que pierde su marcador
  let r = pipeline(['start', '--story', historia('9.95'), '--repo', a, '--brief'], { cwd: a, sid: 'ses-perdida' });
  assert.strictEqual(r.status, 0, `start: ${r.stderr}${r.stdout}`);
  escribir(a, 'app.js', 'module.exports = 1;\n');
  fs.rmSync(marcadorPath(h, 'ses-perdida'));
  // sin poder anotar el registro, `--lost` no cierra
  const noEsCarpeta = () => {
    fs.rmSync(path.join(estado(h), 'save-closed'), { recursive: true, force: true });
    fs.writeFileSync(path.join(estado(h), 'save-closed'), 'no es una carpeta');
  };
  noEsCarpeta();
  r = marker(h, ['clear-session', 'ses-perdida', '--lost'], { cwd: a, sid: 'ses-perdida', env: conVentana(ENV) });
  assert.strictEqual(r.status, 1, `--lost sin poder anotar sale 1: ${r.stderr}${r.stdout}`);
  assert.match(r.stderr, /no pude anotar/);
  fs.rmSync(path.join(estado(h), 'save-closed'));
  r = marker(h, ['clear-session', 'ses-perdida', '--lost'], { cwd: a, sid: 'ses-perdida', env: conVentana(ENV) });
  assert.strictEqual(r.status, 0, `--lost: ${r.stderr}${r.stdout}`);
  let reg = JSON.parse(fs.readFileSync(registroPath(h, 'ses-perdida'), 'utf8'));
  assert.ok(reg.some((e) => e.story === '9.95' && e.repos.includes(a)), `--lost deja el registro: ${JSON.stringify(reg)}`);
  assert.strictEqual(gancho(h, 'git commit -m x', { cwd: a, sid: 'ses-perdida' }).status, 2, 'y el commit de esa sesión frena');

  // restore de una corrida perdida encima de la propia: la propia cierra reemplazada y deja el registro
  r = pipeline(['start', '--story', historia('9.96'), '--repo', a, '--brief'], { cwd: a, sid: 'ses-otra-perdida' });
  assert.strictEqual(r.status, 0, `start: ${r.stderr}${r.stdout}`);
  fs.rmSync(marcadorPath(h, 'ses-otra-perdida'));
  abrir(h, corrida(a, { storyId: '9.98' }));
  // sin poder anotar el registro, restore no pisa la corrida propia
  noEsCarpeta();
  r = marker(h, ['restore', 'ses-otra-perdida'], { cwd: a, env: conVentana(ENV) });
  assert.strictEqual(r.status, 1, `restore sin poder anotar sale 1: ${r.stderr}${r.stdout}`);
  assert.match(r.stderr, /no pude anotar/);
  assert.strictEqual(JSON.parse(fs.readFileSync(marcadorPath(h), 'utf8')).storyId, '9.98', 'la corrida propia queda');
  fs.rmSync(path.join(estado(h), 'save-closed'));
  // con el marcador propio ilegible, restore no lo pisa: no se puede anotar lo que deja
  fs.writeFileSync(marcadorPath(h), '{ esto no es json');
  r = marker(h, ['restore', 'ses-otra-perdida'], { cwd: a, env: conVentana(ENV) });
  assert.strictEqual(r.status, 2, `restore sobre un marcador ilegible sale 2: ${r.stderr}${r.stdout}`);
  assert.match(r.stderr, /no se puede leer/);
  assert.strictEqual(fs.readFileSync(marcadorPath(h), 'utf8'), '{ esto no es json', 'el marcador ilegible queda');
  abrir(h, corrida(a, { storyId: '9.98' }));
  r = marker(h, ['restore', 'ses-otra-perdida'], { cwd: a, env: conVentana(ENV) });
  assert.strictEqual(r.status, 0, `restore: ${r.stderr}${r.stdout}`);
  reg = JSON.parse(fs.readFileSync(registroPath(h), 'utf8'));
  assert.ok(reg.some((e) => e.story === '9.98' && e.repos.includes(a)), `restore deja el registro de la reemplazada: ${JSON.stringify(reg)}`);
  assert.strictEqual(gancho(h, 'git commit -m x', { cwd: a }).status, 2, 'y el commit de ese repo frena');

  // la corrida perdida con su marcador todavía en la carpeta (le falta la copia de la apertura): `--lost` lo lee. Un
  // marcador que no se lee no se borra; con el ok vigente no queda registro; sin el ok, el registro lleva los repos de los
  // archivos que tocó
  const eventos = repoConOrigin(t, 'eventos');
  escribir(eventos, 'b.js', 'x\n');
  const perderLaCopia = (sid, story, ajustar) => {
    r = pipeline(['start', '--story', historia(story), '--repo', a, '--brief'], { cwd: a, sid });
    assert.strictEqual(r.status, 0, `start ${story}: ${r.stderr}${r.stdout}`);
    const m = ajustar(JSON.parse(fs.readFileSync(marcadorPath(h, sid), 'utf8')));
    fs.writeFileSync(marcadorPath(h, sid), JSON.stringify(m));
    // la copia de la apertura vive en la carpeta de la corrida, dentro del repo
    const corridas = path.join(a, '.advisors', 'pipeline-runs');
    const copia = fs.readdirSync(corridas).map((d) => path.join(corridas, d, 'run-open.json'))
      .find((f) => fs.existsSync(f) && JSON.parse(fs.readFileSync(f, 'utf8')).sesion === sid);
    assert.ok(copia, `la copia de la apertura de ${sid}`);
    fs.rmSync(copia);
    return m;
  };
  const conEventos = (m) => ({ ...m, fileEvents: [{ path: path.join(eventos, 'b.js'), ts: ANTES, code: true }] });
  const m = perderLaCopia('ses-copia', '9.94', conEventos);
  fs.writeFileSync(marcadorPath(h, 'ses-copia'), '{ esto no es json');
  r = marker(h, ['clear-session', 'ses-copia', '--lost'], { cwd: a, sid: 'ses-copia', env: conVentana(ENV) });
  assert.strictEqual(r.status, 2, `--lost sobre un marcador ilegible sale 2: ${r.stderr}${r.stdout}`);
  assert.match(r.stderr, /no se puede leer/);
  assert.strictEqual(fs.readFileSync(marcadorPath(h, 'ses-copia'), 'utf8'), '{ esto no es json', 'el marcador ilegible queda');
  fs.writeFileSync(marcadorPath(h, 'ses-copia'), JSON.stringify(m));
  r = marker(h, ['clear-session', 'ses-copia', '--lost'], { cwd: a, sid: 'ses-copia', env: conVentana(ENV) });
  assert.strictEqual(r.status, 0, `--lost con el marcador: ${r.stderr}${r.stdout}`);
  reg = JSON.parse(fs.readFileSync(registroPath(h, 'ses-copia'), 'utf8'));
  assert.ok(reg.some((e) => e.story === '9.94' && e.repos.includes(eventos)), `el registro lleva el repo de los archivos tocados: ${JSON.stringify(reg)}`);
  perderLaCopia('ses-copia-ok', '9.93', (x) => conOk(x));
  r = marker(h, ['clear-session', 'ses-copia-ok', '--lost'], { cwd: a, sid: 'ses-copia-ok', env: conVentana(ENV) });
  assert.strictEqual(r.status, 0, `--lost con el ok vigente: ${r.stderr}${r.stdout}`);
  assert.ok(!fs.existsSync(registroPath(h, 'ses-copia-ok')), 'con el ok vigente no hay registro');
});

// T10 Discard_FrenoSigue_HastaOkNuevoODescartado
// 🔴 Falla con: `--discard` como salida del freno (cerrar y commitear después), o el registro que no se va nunca.
test('Discard_FrenoSigue_HastaOkNuevoODescartado (T10) @story-8.151 @ac-10', (t) => {
  const h = home(t);
  const a = repoConOrigin(t);
  escribir(a, 'app.js', 'module.exports = 1;\n');
  abrir(h, corrida(a));
  let r = marker(h, ['clear', '--discard'], { cwd: a });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(marcadorPath(h)));
  r = gancho(h, 'git commit -m x', { cwd: a });
  assert.strictEqual(r.status, 2, 'el commit después del discard frena');
  assert.match(r.stderr, /la corrida de 9\.99 cerró sin ok de guardar/);
  assert.strictEqual(gancho(h, 'gh pr create --fill', { cwd: tmp(t, 'freno-cwd-') }).status, 2, 'un pedido también');
  // el registro es de su sesión: otra sesión, sin corrida, no lo ve
  assert.doesNotMatch(gancho(h, 'git commit -m x', { cwd: a, sid: 'ses-b' }).stderr, FRENO, 'el registro no frena otra sesión');
  // el ok de una corrida sobre otro repo no lo borra
  const tercero = repoConOrigin(t, 'tercero');
  escribir(tercero, 'app.js', 'module.exports = 3;\n');
  abrir(h, corrida(tercero, { storyId: '9.96', startedAt: DESPUES }));
  aprobar(h, tercero);
  assert.ok(fs.existsSync(registroPath(h)), 'el ok de otro repo no borra el registro');
  assert.strictEqual(gancho(h, 'git commit -m x', { cwd: a }).status, 2, 'el repo de la corrida cerrada sigue frenado');

  // (a) una corrida nueva con su ok (`approve-save` de verdad) cubre el repo y borra el registro
  abrir(h, corrida(a, { storyId: '9.97', startedAt: DESPUES }));
  aprobar(h, a);
  assert.ok(!fs.existsSync(registroPath(h)), 'el ok nuevo borró el registro');
  assert.strictEqual(brake().decidir({ command: 'git commit -m x', cwd: a, sid: SID, home: h }), null, 'con el ok nuevo pasa');
  fs.rmSync(marcadorPath(h));
  assert.doesNotMatch(gancho(h, 'git commit -m x', { cwd: a }).stderr, FRENO, 'sin registro, el commit pasa el freno');

  // (b) en otro laboratorio: deshacer los cambios borra el registro
  const h2 = home(t);
  const b = repoConOrigin(t, 'otro');
  escribir(b, 'app.js', 'module.exports = 1;\n');
  abrir(h2, corrida(b));
  assert.strictEqual(marker(h2, ['clear', '--discard'], { cwd: b }).status, 0);
  assert.strictEqual(gancho(h2, 'git commit -m x', { cwd: b }).status, 2);
  fs.rmSync(path.join(b, 'app.js'));
  r = gancho(h2, 'git commit -m x', { cwd: b });
  assert.doesNotMatch(r.stderr, FRENO, `sin cambios el commit pasa: ${r.stderr} ${spawnSync('git', ['-C', b, 'status', '--porcelain', '--ignored'], { encoding: 'utf8' }).stdout}`);
  assert.ok(!fs.existsSync(registroPath(h2)), 'y el registro ya no está');
});

// T12 PrepareCommit_SinOkDelChat_ConOrden
// 🔴 Falla con: el paso de preparar el commit que todavía ofrece el ok dicho en el chat, o sin el orden del cierre.
test('PrepareCommit_SinOkDelChat_ConOrden (T12) @story-8.151 @ac-12', () => {
  const texto = fs.readFileSync(path.join(SCRIPTS, '..', 'steps', 'step-11-prepare-commit.md'), 'utf8');
  assert.doesNotMatch(texto, /si el usuario dice\W+commite/i, 'sin el camino «si el usuario dice commiteá»');
  assert.doesNotMatch(texto, /la frase del dueño en tu propia conversación/i, 'sin el ok por la frase');
  const orden = ['exportar la memoria', 'approve-save', 'commitear', 'empujar', 'abrir los pedidos', 'marker.js clear'];
  const i = texto.search(/El orden del cierre/i);
  assert.ok(i >= 0, 'nombra el orden del cierre');
  let desde = i;
  for (const paso of orden) {
    const j = texto.indexOf(paso, desde);
    assert.ok(j > desde, `«${paso}» después del paso anterior`);
    desde = j;
  }
  assert.match(texto, /lo hace cumplir el gancho|el freno lo hace cumplir/i);
});

// T13 Freno_PedidosDeLosConectores
// 🔴 Falla con: un freno que reconoce los pedidos por un nombre de herramienta escrito en el núcleo y no por lo que
// declaran los conectores de plataforma, o una lista de conectores que no se lee y deja pasar el pedido.
test('Freno_PedidosDeLosConectores (T13)', (t) => {
  const h = home(t);
  const a = repoConOrigin(t);
  abrir(h, corrida(a));
  const conectores = tmp(t, 'freno-conectores-');
  escribir(conectores, 'otra/integration.json', JSON.stringify({ __doc: 'de prueba', name: 'otra', label: 'Otra', kind: 'platform',
    connector: 'scripts/connector.js', operations: ['ci.read'], capabilities: {}, rawCommands: ['otra pr create', 'otra pr merge', 'otra pr list', 'otra issue create'] }));
  const env = { TYCON_INTEGRATIONS_DIR: conectores };
  // el pedido que el conector declara frena, con las opciones antes de cada palabra y su valor
  for (const [cmd, forma] of [['otra pr create --fill', 'otra pr create'], ['otra -R acme/x pr merge 3', 'otra pr merge'],
    ['otra pr --repo=acme/x create', 'otra pr create'], ["bash -c 'otra pr create --title x'", 'otra pr create']]) {
    const r = gancho(h, cmd, { cwd: a, env });
    assert.strictEqual(r.status, 2, `«${cmd}» frena: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`«${forma}»`), `«${cmd}» nombra la forma`);
  }
  // un programa que corre el pedido por su cuenta no se lee
  let r = gancho(h, `node -e "require('child_process').execSync('otra pr create')"`, { cwd: a, env });
  assert.strictEqual(r.status, 2, `el pedido escondido frena: ${r.stderr}`);
  // lo que el conector declara y no crea ni mergea un pedido pasa
  for (const cmd of ['otra pr list', 'otra issue create --title x']) {
    r = gancho(h, cmd, { cwd: a, env });
    assert.strictEqual(r.status, 0, `«${cmd}» pasa: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, FRENO, cmd);
  }
  // con una integración que no se lee no se sabe qué comandos son pedidos: uno que dice `pr` frena, el resto pasa
  escribir(conectores, 'rota/integration.json', '{ no es json');
  r = gancho(h, 'otra pr create --fill', { cwd: a, env });
  assert.strictEqual(r.status, 2, `sin la lista de los conectores, el pedido frena: ${r.stderr}`);
  assert.match(r.stderr, NO_LEO);
  r = gancho(h, 'git status', { cwd: a, env });
  assert.strictEqual(r.status, 0, `lo que no guarda pasa igual: ${r.stderr}`);
});
