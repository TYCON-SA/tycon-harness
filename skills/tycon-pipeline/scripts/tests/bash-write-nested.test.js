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
  // lo anidado detrás del heredoc vacío también corre
  frena(c, `git commit -F - <<'EOF'\nEOF\necho $(rm ${H})\nEOF`);
  frena(c, `cat <<'EOF'\nEOF\necho $(echo $(echo $(echo $(echo $(rm ${H})))))\nEOF`);
  // un mensaje entre comillas detrás del heredoc vacío sigue siendo texto: el vacío no corre las posiciones de lo que sigue
  pasa(c, `cat <<'EOF'\nEOF\ngit commit -m "$(cat <<'X'\nusar $(rm ${H})\nX\n)"`);
  pasa(c, `cat <<'EOF'\nEOF\ngit commit -m "$(cat <<'X'\nusar $(rm ${H})\nX\n)"\ncat <<'EOF'\nEOF`);
  // un borrador vaciado y una historia vaciada frenan como antes; el cuerpo vacío es lo que el shell escribe
  frena(c, `cat > ${H} <<'EOF'\nEOF`);
  const borrador = correr(c, `cat > specs/story-1.2.md <<'EOF'\nEOF\n---\nstory: "1.2"\nstatus: ready-for-dev\n---\nEOF`);
  assert.strictEqual(borrador.salida, 2, borrador.stderr);
  assert.match(borrador.stderr, /story-1\.2\.md/);
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
  // con la marca entre comillas el shell no expande el cuerpo: su `$(…)` es texto para el programa que lo lee
  for (const cmd of [`git commit -F - <<'EOF'\nusar $(rm ${H})\nEOF`, `gh pr create --body-file - <<'EOF'\nusar $(rm ${H})\nEOF`,
    `grep x <<'EOF'\n$(rm ${H})\nEOF`]) pasa(c, cmd);
  // sin comillas el shell sí lo expande, y a un shell el cuerpo le llega como guion
  frena(c, `git commit -F - <<EOF\nusar $(rm ${H})\nEOF`);
  frena(c, `bash <<'EOF'\necho $(rm ${H})\nEOF`);
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

const SHELLS = ['sh', 'bash', 'zsh', 'dash', 'ksh'];

// 🔴 Falla con: leer sólo el comando de arriba: en `find … -exec rm {}` y en `… | xargs rm` el archivo llega de otro lado.
test('T12 Nested_RunnersWriteTheStory_Block @story-8.308 @ac-12', () => {
  const c = corral();
  for (const opcion of ['-exec', '-execdir', '-ok', '-okdir']) frena(c, `find specs -name story-1.1.md ${opcion} rm {} \\;`);
  for (const cmd of [
    'find specs -name story-1.1.md -exec rm {} +',
    "find specs -name 'story-1.*.md' -exec rm {} \\;",
    'find specs -iname STORY-1.1.MD -exec rm {} \\;',
    'find specs -name story-1.1.md -exec truncate -s 0 {} \\;',
    'find specs -name story-1.1.md -exec sed -i s/a/b/ {} \\;',
    'find specs -type f -exec rm {} \\;',
    'find specs -name story-1.1.md -exec cat {} \\; -exec rm {} \\;',
    'cd specs && find . -name story-1.1.md -exec rm {} \\;',
    `echo ${H} | xargs rm`,
    `echo ${H} | xargs -n 1 rm`,
    `echo ${H} | xargs -I X rm X`,
    `echo ${H} | xargs truncate -s 0`,
    `echo ${H} | xargs sed -i s/a/b/`,
    'ls specs | xargs rm',
  ]) frena(c, cmd);
  for (const shell of SHELLS) {
    frena(c, `${shell} <<EOF\nrm ${H}\nEOF`);
    frena(c, `${shell} <<'EOF'\ntruncate -s 0 ${H}\nEOF`);
    frena(c, `${shell} <<< "rm ${H}"`);
  }
});

// 🔴 Falla con: tomar por escritura cualquier comando que llega por otro programa.
test('T13 Nested_RunnersThatOnlyRead_Pass @story-8.308 @ac-13', () => {
  const c = corral();
  for (const cmd of [
    'find specs -name story-1.1.md',
    'find specs -name story-1.1.md -exec cat {} \\;',
    'find specs -name story-1.1.md -exec grep -l status {} +',
    'find specs -name otra-cosa.txt -exec rm {} \\;',
    `echo ${H} | xargs cat`,
    `echo ${H} | xargs -n 1 wc -l`,
    'echo README.tmp | xargs rm',
    `cat <<'EOF'\nrm ${H}\nEOF`,
    `cat <<EOF\nrm ${H}\nEOF`,
    `grep x <<< "rm ${H}"`,
    `sh <<EOF\ncat ${H}\nEOF`,
  ]) pasa(c, cmd);
});

// Lo que confirmó el pase adversarial de la corrida: formas de `find`, `xargs` y heredocs que escriben la historia y
// pasaban, y formas que sólo leen y se frenaban.
// 🔴 Falla con: tomar todo `-name` como filtro positivo, buscar `xargs` sólo como primera palabra cruda, no leer el
//    heredoc que entra a un shell por una tubería, o tomar el valor de una opción como el nombre del guion.
test('T12b Adversarial_FormsThatWrite_Block @story-8.308 @ac-12', () => {
  const c = corral();
  for (const cmd of [
    'find specs -not -name README.md -exec rm {} \\;',
    'find specs ! -name README.md -exec rm {} +',
    "find specs -type f ! -name '*.txt' -exec mv {} /tmp/ \\;",
    'find specs -name sub -prune -o -exec rm {} \\;',
    "find specs -name 'story-[!x]*.md' -exec rm {} \\;",
    "find specs -name '[!R]*.md' -exec rm {} \\;",
    'find specs ! -name otra-cosa.txt -exec tee -a {} \\;',
    `echo ${H} | { xargs rm; }`,
    `echo ${H} | time xargs rm`,
    `echo ${H} | ! xargs rm`,
    `echo ${H} | xargs -J % rm %`,
    `echo ${H} | xargs -L 1 -J % rm %`,
    `echo ${H} | xargs -R 1 -I % rm %`,
    `echo ${H} | xargs -S 255 -I % rm %`,
    `echo ${H} | xargs --max-args 1 rm`,
    `echo ${H} | xargs --max-args=1 rm`,
    `echo ${H} | xargs --delimiter , rm`,
    `echo ${H} | xargs -I {} sh -c 'rm {}'`,
    `echo ${H} | xargs -I{} sh -c 'rm {}'`,
    `cat <<'EOF' | bash\nrm ${H}\nEOF`,
    `cat <<EOF | sh\ntruncate -s 0 ${H}\nEOF`,
    `cat <<'EOF' | sh -s\nrm ${H}\nEOF`,
    `cat <<'EOF' | bash -s\nsed -i s/a/b/ ${H}\nEOF`,
    `cat > x.txt <<'EOF'\nrm ${H}\nEOF\nbash -o errexit x.txt`,
    `cat > x.txt <<'EOF'\nrm ${H}\nEOF\nsh -o nounset x.txt`,
    `echo x # <<EOF\nrm ${H}\nEOF`,
    `echo "a\\" <<EOF"\nrm ${H}\nEOF`,
    // la continuación de renglón, de la segunda vuelta del pase
    `echo ${H} |\\\nxargs rm`,
    `echo ${H} | \\\nxargs rm`,
    'ls specs/*.md | \\\nxargs rm',
    'find specs -exec rm \\\n  {} \\;',
    `echo ${H} | xargs \\\n  rm`,
    `cat <<EOF | \\\nbash\nrm ${H}\nEOF`,
    // la comilla invertida que cierra pegada a la historia
    `echo \`sed -i s/a/b/ ${H}\``,
    `echo \`tee ${H}\``,
    `x=\`sed -i s/a/b/ ${H}\``,
  ]) frena(c, cmd);
});

// 🔴 Falla con: leer el cuerpo de un heredoc que no va a un shell, o reemplazar la palabra entera del marcador de `xargs -I`.
test('T13b Adversarial_FormsThatOnlyRead_Pass @story-8.308 @ac-13', () => {
  const c = corral();
  for (const cmd of [
    `cat <<A > notes.txt; bash <<B\nrm ${H}\nA\necho hola\nB`,
    `cat <<A > /tmp/n.txt; cat <<B > /tmp/m.txt\nhola\nA\necho ${H} | xargs rm\nB`,
    `echo ${H} | xargs -I{} cp {} /tmp/bk.md`,
    `echo ${H} | xargs -I% cp % /tmp/bk.md`,
    `echo ${H} | xargs -n1 -I{} cp {} /tmp/`,
    `echo ${H} | xargs -I {} cp {} {}.bak`,
    'ls specs/*.md | xargs -I{} cp {} /tmp/probe/',
    `echo ${H} | xargs --replace={} cp {} /tmp/x.md`,
    `echo ${H} | xargs -i cp {} /tmp/x.md`,
    `bash scripts/check.sh <<'EOF'\nrm ${H}\nEOF`,
  ]) pasa(c, cmd);
});

// T16 ShellConC_EscribeLaHistoria_Frena
// `sh -c '…'` (y bash, zsh, dash, ksh con `-c`) corre su texto como un comando: lo que ese texto escribe sobre una
// historia frena como si estuviera afuera. Borrar ya frenaba; agregar con `>>`, `tee` o `sed -i` adentro pasaba.
// 🔴 Falla con: leer el cuerpo de `sh -c` sólo para lo que borra, o tomar por escritura un `sh -c` que sólo lee.
test('T16 ShellConC_EscribeLaHistoria_Frena', () => {
  const c = corral();
  for (const shell of SHELLS) {
    frena(c, `${shell} -c 'echo x >> ${H}'`);
    frena(c, `${shell} -c "echo x > ${H}"`);
  }
  for (const cmd of [
    `sh -c 'echo x | tee -a ${H}'`,
    `bash -c 'sed -i s/a/b/ ${H}'`,
    `bash -lc 'printf x >> ${H}'`,
    `echo ${H} | xargs -I {} sh -c 'echo x >> {}'`,
    `sh -c "sh -c 'echo x >> ${H}'"`,
    // lo que encontró el pase: el `--` antes del cuerpo y la historia como argumento del cuerpo
    `bash -c -- 'echo x >> ${H}'`,
    `bash -c -- 'rm ${H}'`,
    `sh -c 'echo x >> "$1"' _ ${H}`,
    `bash -c 'echo x >> $0' ${H}`,
    `echo ${H} | xargs sh -c 'echo x >> $0'`,
    // de la segunda vuelta: comillas dobles escapadas en el cuerpo, una opción después de -c, $* y el formato de printf
    `sh -c "echo x >> \\"${H}\\""`,
    `bash -c "echo \\"a b\\" >> ${H}"`,
    `bash -c -x 'echo x >> ${H}'`,
    `sh -c 'echo x >> $*' _ ${H}`,
    `printf '%s\\n' ${H} | xargs sh -c 'echo x >> $0'`,
    // de la tercera vuelta: un sh -c con comillas simples adentro de $(…) o de comillas invertidas
    `echo $(sh -c 'echo x >> ${H}')`,
    `echo \`bash -c 'echo x >> ${H}'\``,
  ]) frena(c, cmd);
  for (const cmd of [
    `sh -c 'cat ${H}'`,
    `bash -c 'grep -c status ${H} > /tmp/cuenta.txt'`,
    `sh -c 'echo x >> notes.txt'`,
    // un `sh -c` citado como texto (un mensaje, un heredoc a un archivo) no corre
    `git commit -m 'doc: sh -c "echo x >> ${H}"'`,
    `echo "use: sh -c 'echo x >> ${H}'"`,
    `cat <<EOF > /tmp/n.txt\nsh -c 'echo x >> ${H}'\nEOF`,
    // un `$(` escapado es texto
    `echo "\\$(rm ${H})"`,
  ]) pasa(c, cmd);
});

// T17 TuberiaAUnShell_YCdDeAfuera_Frenan (filas 59 y 60 de la coordinadora, del pase de la fila 54)
// 🔴 Falla con: un texto que llega por una tubería a un shell sin `-c` que escribe la historia y pasa, o un `cd` del shell
//    de afuera que no se aplica al comando anidado.
test('T17 TuberiaAUnShell_YCdDeAfuera_Frenan', () => {
  const c = corral();
  for (const cmd of [
    `echo 'echo x >> ${H}' | sh`,
    `printf 'echo x >> ${H}\\n' | bash`,
    `echo "echo x >> ${H}" | bash -s`,
    `printf '%s\\n' 'echo x >> ${H}' | sh`,
    `echo -e 'true\\necho x >> ${H}' | sh`,
    `bash -c "cd specs && sh -c 'echo x >> story-1.1.md'"`,
    `sh -c 'cd specs; bash -c "echo x > story-1.1.md"'`,
    // del pase: filtros en el medio, envolturas, printf con el destino en el formato, opciones del cd, las dos
    // filas juntas, -o agrupado y barras de escape
    `echo 'echo x >> ${H}' | cat | sh`,
    `echo 'echo x >> ${H}' | tee /dev/null | sh`,
    `{ echo 'echo x >> ${H}'; } | sh`,
    `builtin echo 'echo x >> ${H}' | sh`,
    `echo 'echo x >> ${H}' | ( sh )`,
    `printf 'echo x >> %s\\n' ${H} | sh`,
    `bash -c 'cd -P specs && sh -c "echo x >> story-1.1.md"'`,
    `cd -- specs && sh -c 'echo x >> story-1.1.md'`,
    `bash -c 'cd specs && echo "echo x >> story-1.1.md" | sh'`,
    `echo 'echo x >> ${H}' | bash -euo pipefail`,
    `echo echo x \\>\\> ${H} | sh`,
    // de la segunda vuelta: el cd de un renglón anterior, la tubería partida en renglones, comillas de varios renglones,
    // un comentario después del shell y busybox
    `cd specs\necho 'echo x >> story-1.1.md' | sh`,
    `echo 'echo x >> ${H}' |\nsh`,
    `echo 'a\necho x >> ${H}' | sh`,
    `echo 'echo x >> ${H}' | sh # corre`,
    `echo 'echo x >> ${H}' | busybox sh`,
  ]) frena(c, cmd);
  for (const cmd of [
    `echo 'cat ${H}' | sh`,
    `echo 'echo x >> notes.txt' | bash`,
    `echo 'echo x >> ${H}' | cat`,
    `bash -c "cd /tmp && sh -c 'echo x >> story-1.1.md'"`,
  ]) pasa(c, cmd);
});

// 🔴 Falla con: una sustitución precedida por una barra escapada (`\\$(…)`) leída como escapada: la barra doble es una
// barra suelta y la sustitución corre. La escapada de verdad (`\$(…)`) sigue siendo texto.
test('T18 SustitucionTrasBarraEscapada_Corre', () => {
  const c = corral();
  for (const cmd of [
    `echo \\\\$(sh -c 'echo x > ${H}')`,
    `echo \\\\\`sh -c 'echo x > ${H}'\``,
    `echo "\\\\$(sh -c 'echo x > ${H}')"`,
  ]) frena(c, cmd);
  for (const cmd of [
    `echo \\$(sh -c 'echo x > ${H}')`,
    `echo "\\$(sh -c 'echo x > ${H}')"`,
  ]) pasa(c, cmd);
});

// T19 a T23 · las cinco formas de escribir una historia dentro de un shell anidado que el freno no leía (fila 61, del
// pase adversarial del #1491), y lo que sólo lee o escribe otra cosa por las mismas formas, que sigue pasando.
test('T19 ShellAnidado_ComillasAnsiC_Frena', () => {
  const c = corral();
  frena(c, `bash -c $'echo x >> ${H}'`);
  frena(c, `sh -c $'rm ${H}'`);
  frena(c, `bash -c $'echo x \\x3e\\x3e ${H}'`);
  pasa(c, `bash -c $'echo x >> README.md'`);
  pasa(c, `bash -c $'cat ${H}'`);
});

test('T20 ShellAnidado_RutaEnVariableOEnPwd_Frena', () => {
  const c = corral();
  frena(c, `F=${H}; sh -c 'echo x >> "$F"'`);
  frena(c, `export F=${H}; sh -c 'echo x >> $F'`);
  frena(c, `F=${H} sh -c 'rm "$F"'`);
  frena(c, `sh -c 'echo x >> $PWD/${H}'`);
  frena(c, `sh -c 'echo x >> "\${PWD}/${H}"'`);
  pasa(c, `F=README.md; sh -c 'echo x >> "$F"'`);
  pasa(c, `F=${H}; sh -c 'cat "$F"'`);
  pasa(c, `sh -c 'echo x >> $PWD/README.md'`);
});

test('T21 ShellAnidado_ComillaSimpleAnidada_Frena', () => {
  const c = corral();
  frena(c, `sh -c 'sh -c '"'"'rm ${H}'"'"''`);
  frena(c, `bash -c 'bash -c '\\''echo x >> ${H}'\\'''`);
  pasa(c, `sh -c 'sh -c '"'"'cat ${H}'"'"''`);
});

test('T22 ShellAnidado_XargsPorHereString_Frena', () => {
  const c = corral();
  frena(c, `xargs -I{} sh -c 'rm {}' <<< ${H}`);
  frena(c, `xargs -I{} sh -c 'echo x >> {}' <<< "${H}"`);
  frena(c, `xargs sh -c 'rm "$@"' sh <<< ${H}`);
  pasa(c, `xargs -I{} sh -c 'cat {}' <<< ${H}`);
  pasa(c, `xargs -I{} sh -c 'rm {}' <<< README.md`);
});

test('T23 ShellAnidado_Busybox_Frena', () => {
  const c = corral();
  frena(c, `busybox sh -c 'echo x >> ${H}'`);
  frena(c, `busybox ash -c 'rm ${H}'`);
  frena(c, `busybox rm ${H}`);
  frena(c, `busybox sed -i s/a/b/ ${H}`);
  pasa(c, `busybox sh -c 'cat ${H}'`);
  pasa(c, `busybox cat ${H}`);
});

// T24 a T27 · lo que encontró el pase adversarial de la fila 61: las mismas formas con un envoltorio delante, con la
// variable armada de otra forma y con la entrada del `xargs` escrita de otra forma.
test('T24 ShellAnidado_BusyboxConEnvoltorioOVariable_Frena', () => {
  const c = corral();
  for (const cmd of [`sudo busybox rm ${H}`, `nohup busybox rm ${H}`, `timeout 5 busybox rm ${H}`, `command busybox rm ${H}`,
    `nice busybox rm ${H}`, `F=${H}; busybox rm $F`]) frena(c, cmd);
  pasa(c, `sudo busybox cat ${H}`);
  pasa(c, 'echo busybox rm');
});

test('T25 ShellAnidado_VariableArmadaDeOtraForma_Frena', () => {
  const c = corral();
  const muchas = Array.from({ length: 12 }, (_, k) => `V=a${k}`).join('; ');
  for (const cmd of [`D=specs; F=$D/story-1.1.md; sh -c 'rm $F'`, `F=$'sp\\x65cs/story-1.1.md'; sh -c 'rm $F'`,
    `${muchas}; V=${H}; sh -c 'rm $V'`, `F=${H}; sh -c 'rm \${F:-x}'`, `F=${H}; sh -c 'rm "\${F}"'`]) frena(c, cmd);
  pasa(c, `D=specs; F=$D/README.md; sh -c 'rm $F'`);
});

test('T26 ShellAnidado_EntradaDeXargsEscritaDeOtraForma_Frena', () => {
  const c = corral();
  for (const cmd of [`xargs rm <<< 'specs/story-1.'1.md`, 'xargs rm <<< specs/story-1."1".md',
    `xargs rm <<< $'README.md\\n${H}'`, `xargs rm <<< $'${H}\\x20README.md'`, `xargs -0 rm <<< $'README.md\\0${H}'`,
    `xargs -d, rm <<< 'README.md,${H}'`, `F=${H}; xargs rm <<< "$F"`]) frena(c, cmd);
  pasa(c, `xargs -d, cat <<< 'README.md,${H}'`);
  pasa(c, 'xargs rm <<< README.md');
});

test('T27 ShellAnidado_XargsUnaPorVez_Frena', () => {
  const c = corral();
  frena(c, `xargs -n1 sh -c 'rm "$1"' _ <<< "README.md ${H}"`);
  frena(c, `echo README.md ${H} | xargs -n1 sh -c 'rm "$1"' _`);
  pasa(c, `xargs -n1 sh -c 'cat "$1"' _ <<< "README.md ${H}"`);
});

// T28 a T30 · la fila 81 (pase del pedido único #1502), la parte de las historias: la carpeta de `env -C`, `pushd` y los
// `cd` encadenados dentro de un cuerpo anidado, `sudo` con una opción con valor, y `printf` con `\n` hacia `xargs`.
test('T28 ShellAnidado_CarpetaDeEnvCPushdYCdEncadenados_Frena', () => {
  const c = corral();
  fs.mkdirSync(path.join(c.dir, 'sub'), { recursive: true });
  for (const cmd of [`env -C specs sh -c 'echo x >> story-1.1.md'`, `sh -c 'cd sub && cd ../specs && echo x >> story-1.1.md'`,
    `sh -c 'cd specs && cd - && cd specs && rm story-1.1.md'`, 'pushd specs && rm story-1.1.md', 'pushd specs; sh -c \'rm story-1.1.md\'']) frena(c, cmd);
  pasa(c, `env -C specs sh -c 'cat story-1.1.md'`);
  pasa(c, 'pushd specs && echo x >> notas.txt');
});

test('T29 ShellAnidado_SudoConOpcionConValor_Frena', () => {
  const c = corral();
  for (const cmd of [`sudo -u root sh -c 'echo x >> ${H}'`, `sudo -u root -g wheel bash -c 'rm ${H}'`]) frena(c, cmd);
  pasa(c, `sudo -u root sh -c 'cat ${H}'`);
});

test('T30 ShellAnidado_PrintfConSaltoHaciaXargs_Frena', () => {
  const c = corral();
  frena(c, `printf '${H}\\n' | xargs rm`);
  frena(c, `printf 'README.md\\n${H}\\n' | xargs rm`);
  pasa(c, `printf '${H}\\n' | xargs cat`);
});

// T31 · fila 118: comillas pegadas en medio de una palabra (vacías o con algo adentro) son la misma palabra para el shell,
// afuera y adentro de un shell anidado. T32 · `$PWD` después de un `cd` en el cuerpo es la carpeta de ese `cd`.
test('T31 ComillasPegadasEnLaPalabra_Frena', () => {
  const c = corral();
  for (const cmd of ['rm sp""ecs/story-1.1.md', "rm specs/story-1.''1.md", 'echo x >> specs/"story"-1.1.md',
    'sed -i s/a/b/ sp""ecs/story-1.1.md', `sh -c 'rm sp""ecs/story-1.1.md'`]) frena(c, cmd);
  pasa(c, 'rm REA""DME.md');
  pasa(c, 'cat sp""ecs/story-1.1.md');
  pasa(c, 'git commit -m "toca sp""ecs/story-1.1.md"');
});

test('T32 ShellAnidado_PwdDespuesDeUnCd_EsLaCarpetaDelCd', () => {
  const c = corral();
  const afuera = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'freno-afuera-')));
  pasa(c, `sh -c 'cd ${afuera} && echo x >> $PWD/${H}'`);
  frena(c, `sh -c 'cd specs && echo x >> $PWD/story-1.1.md'`);
  frena(c, `sh -c 'echo x >> $PWD/${H}; cd ${afuera}'`);
});

// 🔴 Falla con: `env -S "<orden>"` (o `--split-string`) corre la orden que lleva en su valor, y el freno no la miraba.
test('T33 EnvSplitString_LaOrdenDelValor_SeMiraComoAnidada', () => {
  const c = corral();
  for (const cmd of [`env -S "rm ${H}"`, `env -S'rm ${H}'`, `env -iS "rm ${H}"`, `env --split-string="rm ${H}"`,
    `env --split-string "rm ${H}"`, `env -S "sh -c 'echo x >> ${H}'"`, `sudo -u root env -S "rm ${H}"`]) frena(c, cmd);
  pasa(c, `env -S "cat ${H}"`);
  pasa(c, 'env -S "echo hola" > /dev/null');
});

// T34 Find_CarpetaEsLaDelComando_Frena
// 🔴 Falla con: la carpeta de un `find` escrita como `$PWD`, `${PWD}` o `$(pwd)` no se resuelve, y el `find` no alcanza
//    ninguna historia.
test('T34 Find_CarpetaEsLaDelComando_Frena', () => {
  const c = corral();
  for (const carpeta of ['$PWD', '${PWD}', '$(pwd)', '"$PWD"', '$PWD/specs']) {
    frena(c, `find ${carpeta} -name 'story-*.md' -exec rm {} \\;`);
    frena(c, `find ${carpeta} -name 'story-*.md' | xargs rm`);
  }
  pasa(c, "find $PWD -name 'story-*.md' -exec cat {} \\;");
  pasa(c, "find $PWD -name 'README.md' -exec rm {} \\;");
});

// T35 Xargs_RutaEnUnaVariableDelComando_Frena
// 🔴 Falla con: el `echo $f` que le da la entrada a un `xargs` llega con la variable sin resolver.
test('T35 Xargs_RutaEnUnaVariableDelComando_Frena', () => {
  const c = corral();
  for (const cmd of [`f=${H}; echo $f | xargs rm`, `f=${H}; echo "$f" | xargs rm`, `f=${H}; echo \${f} | xargs -I{} rm {}`,
    `f=${H}; printf '%s\\n' "$f" | xargs rm`]) frena(c, cmd);
  pasa(c, `f=${H}; echo $f | xargs cat`);
  pasa(c, 'f=README.md; echo $f | xargs rm');
});

// T36 FindName_ClasesPosixYEscapes_Frena
// 🔴 Falla con: el patrón de `-name` traducido sin entender `[[:digit:]]` ni `\.`: no cumple con ningún nombre.
test('T36 FindName_ClasesPosixYEscapes_Frena', () => {
  const c = corral();
  for (const nombre of ["'story-[[:digit:]].[[:digit:]].md'", "'story-1\\.1\\.md'", "'story-[[:digit:][:space:]].1.md'",
    "'[[:alpha:]]tory-*.md'", "'story-[0-9].1.md'"]) frena(c, `find . -name ${nombre} -exec rm {} \\;`);
  pasa(c, "find . -name 'story-[[:alpha:]].1.md' -exec rm {} \\;");
  pasa(c, "find . -name 'story-1\\.1\\.txt' -exec rm {} \\;");
});

// T15 Bench_FrenoComandosAnidados
// 🔴 Falla con: un caso del banco que no corre o que da otra salida que la esperada.
test('T15 Bench_FrenoComandosAnidados', () => {
  // `--only` compara contra `<guion del freno>::<id del caso>`: los casos de este archivo comparten el comienzo del id
  const ids = JSON.parse(fs.readFileSync(CASOS, 'utf8')).hooks.flatMap((h) => h.cases.map((x) => x.id));
  assert.ok(ids.length >= 8 && ids.every((id) => id.startsWith('anidado-')), 'un caso por forma, todos con su prefijo');
  // el reporte va a una carpeta propia: en el árbol lo vería cambiar otra suite que corre a la vez
  const reporte = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'anidados-banco-')), 'reporte.json');
  const r = spawnSync(process.execPath, [BENCH, '--tool', 'claude', '--only', 'on-bash-write-gate.js::anidado-', '--json', reporte], { encoding: 'utf8', timeout: 300000 });
  assert.strictEqual(r.status, 0, `${r.stdout.slice(-2000)}\n${r.stderr.slice(-2000)}`);
  assert.match(r.stdout, new RegExp(`✅ ${ids.length} corridos · 0 rojos · .*0 NO MEDIDOS`), r.stdout.slice(-1500));
});
