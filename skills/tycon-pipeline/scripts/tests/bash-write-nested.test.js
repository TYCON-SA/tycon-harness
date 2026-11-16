'use strict';
// El freno de escrituras lee lo que corre adentro de otro comando: `$(…)`, comillas invertidas, `sh -c`, las llaves y las
// palabras de control del shell (`{`, `if`, `!`, `time`…), un heredoc de cuerpo vacío y un guion de shell escrito en el
// mismo comando. Lo que sólo lee o sólo cita sigue pasando, y un archivo que no es una historia pasa igual adentro que
// afuera.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const GATE = path.join(__dirname, '..', 'on-bash-write-gate.js');
const BENCH = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'controls-bench', 'runner.js');
const CASOS = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'controls-bench', 'cases', 'hooks', '79-freno-comandos-anidados.json');
const H = 'specs/story-1.1.md';
const HISTORIA = /HISTORIA ESCRITA POR CONSOLA/;

/** Un repo de juguete con una historia, un borrador y una HOME propia: el registro de errores no es el de la máquina. */
function corral() {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'freno-anidados-')));
  const home = path.join(raiz, 'home');
  const dir = path.join(raiz, 'repo');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.tycon'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, H), '---\nstory: "1.1"\nepic: "1"\ntitle: "x"\nstatus: in-progress\n---\n\n# x\n');
  fs.writeFileSync(path.join(dir, 'specs', 'story-1.2.md'), '---\nstory: "1.2"\nepic: "1"\ntitle: "y"\nstatus: draft\n---\n\n# y\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  return { raiz, home, dir };
}

/** El freno de verdad, en su proceso: la salida, lo que dijo y lo que quedó en su registro de errores. */
function correr({ home, dir }, command, env = {}, sesion = 's-anidados') {
  const log = path.join(home, '.claude', '.tycon-pipeline', 'hook-errors.log');
  fs.rmSync(log, { force: true });
  const base = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TYCON_')) base[k] = v;
  const r = spawnSync(process.execPath, [GATE], {
    input: JSON.stringify({ tool_name: 'Bash', session_id: sesion, cwd: dir, tool_input: { command } }),
    env: { ...base, HOME: home, USERPROFILE: home, TYCON_NO_RUN_CHANGE: '1', ...env }, encoding: 'utf8', timeout: 15000,
  });
  return { salida: r.status, stderr: String(r.stderr), log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}

function frena(c, command) {
  const r = correr(c, command);
  assert.strictEqual(r.salida, 2, `frena: ${JSON.stringify(command)}\n${r.stderr}`);
  assert.match(r.stderr, HISTORIA, `lo dice como historia: ${JSON.stringify(command)}`);
  assert.ok(r.stderr.includes('story-1.1.md'), `nombra la historia: ${JSON.stringify(command)}`);
  return r;
}

function pasa(c, command) {
  const r = correr(c, command);
  assert.strictEqual(r.salida, 0, `pasa: ${JSON.stringify(command)}\n${r.stderr}`);
  return r;
}

const anidado = (k, adentro) => { let s = adentro; for (let i = 0; i < k; i++) s = `echo $(${s})`; return s; };

// T1 Nested_Substitution_Blocks
// 🔴 Falla con: `destinosBorrados` y el editor en el lugar leyendo sólo los tramos de arriba: en `echo $(rm x)` el
//    comando es `echo`.
test('T1 Nested_Substitution_Blocks', () => {
  const c = corral();
  for (const cmd of [`echo $(rm ${H})`, `x=$(rm ${H})`, `cat $(sed -i s/a/b/ ${H})`, `echo "$(rm ${H})"`,
    'echo $(sed -i s/a/b/ specs/*.md)']) frena(c, cmd);
});

// T2 Nested_Backticks_Blocks
// 🔴 Falla con: lo mismo, por las comillas invertidas.
test('T2 Nested_Backticks_Blocks', () => {
  frena(corral(), `echo \`rm ${H}\``);
});

// T3 Nested_ShellDashC_Blocks
// 🔴 Falla con: no leer el guion de un shell con `-c` al buscar lo que borra o edita en el lugar.
test('T3 Nested_ShellDashC_Blocks', () => {
  const c = corral();
  frena(c, `sh -c 'rm ${H}'`);
  frena(c, `bash -c 'sed -i s/a/b/ ${H}'`);
});

// T4 Prefix_GroupAndControlWords_Block
// 🔴 Falla con: quitar sólo `PREFIJO`: en `{ rm x; }` el comando es `{`, y en `if rm x` es `if`.
test('T4 Prefix_GroupAndControlWords_Block', () => {
  const c = corral();
  for (const cmd of [`{ rm ${H}; }`, `if true; then rm ${H}; fi`, `if rm ${H}; then :; fi`,
    `if false; then :; elif rm ${H}; then :; fi`, `if false; then :; else rm ${H}; fi`, `while rm ${H}; do break; done`,
    `until rm ${H}; do break; done`, `! rm ${H}`, `time rm ${H}`]) frena(c, cmd);
});

// T5 Braces_WholeStoryName_Blocks
// 🔴 Falla con: resolver la palabra con las llaves sin expandir: con ellas puestas, la ruta no existe tal cual.
test('T5 Braces_WholeStoryName_Blocks', () => {
  frena(corral(), 'sed -i s/a/b/ specs/{story-1.1,x}.md');
});

// T6 Heredoc_EmptyBody_ReadsWhatFollows
// 🔴 Falla con: la expresión de heredocs que exige un salto antes de la marca: con el cuerpo vacío salta a la marca
//    siguiente y se traga la orden del medio.
test('T6 Heredoc_EmptyBody_ReadsWhatFollows', () => {
  const c = corral();
  frena(c, `cat <<'EOF' > n.txt\nEOF\nrm ${H}\nEOF`);
  frena(c, `cat <<'EOF'\nEOF\nrm ${H}\nEOF`);
  frena(c, `cat <<'EOF'\nEOF\necho x > ${H}\nEOF`);
});

// T7 Script_HeredocToAbsolutePath_IsRead
// 🔴 Falla con: no leer un guion de shell: `sh`, `bash` y `.` no están entre los intérpretes cuyos guiones se leen.
test('T7 Script_HeredocToAbsolutePath_IsRead', () => {
  const c = corral();
  const sh = path.join(c.raiz, 'propio', 'x.sh');
  fs.mkdirSync(path.dirname(sh), { recursive: true });
  for (const corre of ['sh', 'bash', '.']) {
    const r = correr(c, `cat <<'EOF' > ${sh}\nrm ${H}\nEOF\n${corre} ${sh}`);
    assert.strictEqual(r.salida, 2, `con ${corre}\n${r.stderr}`);
    assert.match(r.stderr, HISTORIA);
  }
  const py = path.join(c.raiz, 'propio', 'x.py');
  const r = correr(c, `cat <<'EOF' > ${py}\nopen('${H}','w').write('x')\nEOF\npython3 ${py}`);
  assert.strictEqual(r.salida, 2, r.stderr);
});

// T8 Nested_DepthLimit
// 🔴 Falla con: leer sin tope (o dejar pasar lo que queda más hondo): en el quinto nivel no se sabe qué corre.
test('T8 Nested_DepthLimit', () => {
  const c = corral();
  frena(c, anidado(4, `rm ${H}`));
  const r = frena(c, anidado(5, `rm ${H}`));
  assert.match(r.stderr, /más de 4 niveles/);
  pasa(c, anidado(5, `cat ${H}`));
});

// T9 Nested_Unclosed_DoesNotThrow
// 🔴 Falla con: buscar el cierre del `$(` sin cuidar el final del texto.
test('T9 Nested_Unclosed_DoesNotThrow', () => {
  const r = correr(corral(), `echo $(rm ${H}`);
  assert.strictEqual(r.log, '', 'sin renglón en hook-errors.log');
  assert.ok([0, 2].includes(r.salida));
});

// T10 Still_Blocks_WhatBlockedBefore
test('T10 Still_Blocks_WhatBlockedBefore', () => {
  const c = corral();
  for (const cmd of [`rm ${H}`, `(rm ${H})`, `for f in a; do rm ${H}; done`, `{ sed -i s/a/b/ specs/*.md; }`,
    `{ echo x > ${H}; }`, `echo $(echo x > ${H})`, anidado(5, `echo x > ${H}`), `sed -i s/a/b/ specs/[!z-a]tory-1.1.md`]) {
    frena(c, cmd);
  }
  // estos frenan por otro freno (la historia sin validar, el código sin carril): siguen frenando
  for (const cmd of ['sed -i s/a/b/ specs/story-1.{1,2}.md', `cat <<'EOF' > x.sh\nrm ${H}\nEOF\nsh x.sh`, `time grep "sed -i ${H}" notas.txt`]) {
    assert.strictEqual(correr(c, cmd).salida, 2, JSON.stringify(cmd));
  }
});

// T11 Still_Passes_Reads
test('T11 Still_Passes_Reads', () => {
  const c = corral();
  for (const cmd of ['ls -la', `echo $(cat ${H})`, `x=$(cat ${H}); echo $x`, `{ cat ${H}; }`, 'cat specs/{story-1.1,x}.md',
    `cat <<'EOF'\nrm ${H}\nEOF`, anidado(5, `cat ${H}`), `git commit -m "rm ${H}"`, `time git commit -m "rm ${H}"`,
    `! grep "rm ${H}" notas.txt`]) pasa(c, cmd);
});

// T12 Still_Passes_TextThatDoesNotRun
// 🔴 Falla con: leer lo anidado con `comandosAnidados`, que también ve un `$(…)` entre comillas simples; o leer el
//    cuerpo de un heredoc como comando.
test('T12 Still_Passes_TextThatDoesNotRun', () => {
  const c = corral();
  for (const cmd of [`echo '$(rm ${H})'`, `git commit -F - <<'EOF'\nrm ${H}\nEOF`,
    `git commit -m "$(cat <<'EOF'\nrm ${H}\n$(rm ${H})\nEOF\n)"`, `gh pr create --body 'rm ${H} y $(rm ${H})'`,
    `! git commit -m "rm ${H}"`]) pasa(c, cmd);
});

// T13 Nested_SameAsDirect_NotStoryAndDraft
test('T13 Nested_SameAsDirect_NotStoryAndDraft', () => {
  const c = corral();
  for (const archivo of ['README.md', 'specs/story-1.2.md']) {
    const directo = correr(c, `rm ${archivo}`).salida;
    assert.strictEqual(correr(c, `{ rm ${archivo}; }`).salida, directo, `{ rm ${archivo}; }`);
    assert.strictEqual(correr(c, `echo $(rm ${archivo})`).salida, directo, `echo $(rm ${archivo})`);
  }
  assert.strictEqual(correr(c, 'rm README.md').salida, 0);
});

// un repo de verdad, con una ejecución abierta cuya historia declara `src/a.ts`
function conEjecucion() {
  const c = corral();
  fs.rmSync(path.join(c.dir, '.git'), { recursive: true, force: true });
  fs.mkdirSync(path.join(c.dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(c.dir, 'src', 'a.ts'), 'export const a = 1;\n');
  const storyPath = path.join(c.dir, 'specs', 'story-9.9.md');
  fs.writeFileSync(storyPath, '---\nstory: "9.9"\nepic: "9"\nstatus: in-progress\nfiles_to_modify:\n  - src/a.ts\n---\n\n# Story 9.9\n');
  const env = { GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@noreply', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@noreply',
    GIT_AUTHOR_DATE: '2026-11-16T10:00:00Z', GIT_COMMITTER_DATE: '2026-11-16T10:00:00Z' };
  const git = (...a) => execFileSync('git', ['-C', c.dir, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { encoding: 'utf8', env: { ...process.env, ...env } });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'arranque');
  const marcador = (sid) => {
    const dir = path.join(c.home, '.claude', '.tycon-pipeline', 'active');
    fs.mkdirSync(dir, { recursive: true });
    const archivo = path.join(dir, `${sid}.json`);
    fs.writeFileSync(archivo, JSON.stringify({
      storyId: '9.9', sessionId: sid, stepScheme: 2, storyPath, repoPath: c.dir, startedAt: '2026-11-16T10:00:00.000Z',
      lastTouch: '2026-11-16T10:00:00.000Z', stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan'],
      stepsPending: ['implement', 'run-tests', 'reviewers', 'adversarial-pass', 'findings', 'live-check', 'prepare-commit'],
      filesTouched: [], fileEvents: [], iterations: {},
    }));
    return () => JSON.parse(fs.readFileSync(archivo, 'utf8')).filesTouched.map((p) => fs.realpathSync(p));
  };
  return { ...c, marcador };
}

// T14 Nested_SwitchOff_AndOpenRun
// 🔴 Falla con: leer lo de adentro de un grupo sólo en el freno de historias: `frenoBorrarYArmados` también lee
//    `destinosBorrados`, y un borrado adentro de `{ …; }` tiene que pasar por él igual que afuera.
test('T14 Nested_SwitchOff_AndOpenRun', () => {
  const c = corral();
  for (const cmd of [`rm ${H}`, `{ rm ${H}; }`, `echo $(rm ${H})`, `sh -c 'rm ${H}'`]) {
    assert.strictEqual(correr(c, cmd, { TYCON_STORY_SKILL_GATE: 'off' }).salida, correr(c, `rm ${H}`, { TYCON_STORY_SKILL_GATE: 'off' }).salida, cmd);
  }
  const e = conEjecucion();
  const resultados = [];
  for (const cmd of ['git rm -q src/a.ts', '{ git rm -q src/a.ts; }']) {
    const leer = e.marcador('s-run');
    const r = correr(e, cmd, {}, 's-run');
    resultados.push({ salida: r.salida, touched: leer() });
  }
  assert.deepStrictEqual(resultados[1], resultados[0], 'git rm de un declarado: la misma salida y la misma ruta en filesTouched');
  assert.deepStrictEqual(resultados[0].touched, [fs.realpathSync(path.join(e.dir, 'src', 'a.ts'))]);
  e.marcador('s-run');
  const directo = correr(e, 'rm src/a.ts', {}, 's-run');
  const grupo = correr(e, '{ rm src/a.ts; }', {}, 's-run');
  assert.strictEqual(grupo.salida, directo.salida, 'rm de código seguido: la misma salida');
  assert.strictEqual(directo.salida, 2);
  assert.strictEqual(grupo.stderr.split('\n').slice(0, 4).join('\n').replace(/\{ |; \}/g, ''),
    directo.stderr.split('\n').slice(0, 4).join('\n'), 'el mismo mensaje');
});

// T15 Bench_FrenoComandosAnidados
// 🔴 Falla con: un caso del banco que no corre o que da otra salida que la esperada.
test('T15 Bench_FrenoComandosAnidados', () => {
  // `--only` compara contra `<guion del freno>::<id del caso>`: los casos de este archivo comparten el comienzo del id
  const ids = JSON.parse(fs.readFileSync(CASOS, 'utf8')).hooks.flatMap((h) => h.cases.map((x) => x.id));
  assert.ok(ids.length >= 8 && ids.every((id) => id.startsWith('anidado-')), 'un caso por forma, todos con su prefijo');
  const r = spawnSync(process.execPath, [BENCH, '--tool', 'claude', '--only', 'on-bash-write-gate.js::anidado-'], { encoding: 'utf8', timeout: 300000 });
  assert.strictEqual(r.status, 0, `${r.stdout.slice(-2000)}\n${r.stderr.slice(-2000)}`);
  assert.match(r.stdout, new RegExp(`✅ ${ids.length} corridos · 0 rojos · .*0 NO MEDIDOS`), r.stdout.slice(-1500));
});
