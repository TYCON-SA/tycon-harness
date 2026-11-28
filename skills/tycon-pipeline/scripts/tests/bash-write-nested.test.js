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

// Lo que un `xargs` recibe de un programa (`ls specs`, `find`, `git ls-files`) no se ve: el freno lo prueba también con
// un comodín y con cada palabra como carpeta. Sin eso, un destino armado alrededor del marcador (`specs/{}`) o del
// argumento posicional del cuerpo (`specs/$0`) no nombra la historia y la escritura pasa.
// 🔴 Falla con: tomar las palabras del comando de antes como lo único que llega por la entrada.
test('T34 Nested_XargsUnknownInput_ShellBodyBuildsTheStory_Block @story-8.308 @ac-12', () => {
  const c = corral();
  for (const cmd of [
    "ls specs | xargs -I {} sh -c 'echo x >> specs/{}'",
    "ls specs | xargs -I % sh -c 'echo x >> specs/%'",
    "ls specs | xargs -I {} bash -c 'rm specs/{}'",
    "ls specs | xargs -n1 sh -c 'echo x >> specs/$0'",
    "git ls-files specs | xargs -I {} sh -c 'truncate -s 0 {}'",
    "cd specs && ls | xargs -I {} sh -c 'echo x >> {}'",
  ]) frena(c, cmd);
  // lo que sólo lee, o escribe fuera de la carpeta de las historias, sigue pasando
  for (const cmd of [
    "ls specs | xargs -I {} sh -c 'cat specs/{}'",
    "ls specs | xargs -I {} sh -c 'wc -l specs/{} >> /tmp/cuentas.txt'",
    'git ls-files | xargs grep -l status',
    'ls specs | xargs -n1 basename',
  ]) pasa(c, cmd);
});

// De la revisión de Fable del T34: el comodín suelto en la raíz frenaba los reemplazos y borrados en bloque de otra
// carpeta, y un filtro en el medio o una historia un nivel más abajo dejaban pasar la escritura.
// 🔴 Falla con: sumar el comodín de la raíz aunque la fuente nombre su carpeta, o mirar sólo el tramo de antes.
test('T34b Nested_XargsUnknownInput_FolderOfTheSource @story-8.308 @ac-12', () => {
  const c = corral();
  for (const d of ['src', 'build', path.join('specs', 'epic-2')]) fs.mkdirSync(path.join(c.dir, d), { recursive: true });
  fs.writeFileSync(path.join(c.dir, 'src', 'a.js'), 'foo\n');
  fs.writeFileSync(path.join(c.dir, 'build', 'a.log'), 'x\n');
  fs.writeFileSync(path.join(c.dir, 'specs', 'epic-2', 'story-2.1.md'), '---\nstory: "2.1"\nepic: "2"\ntitle: "z"\nstatus: draft\n---\n\n# z\n');
  for (const cmd of [
    "git ls-files specs | sort | xargs -I {} sh -c 'truncate -s 0 {}'",
    'git ls-files specs | sort | xargs -I {} tee -a {}',
    "find specs -type f | head -5 | xargs -I {} sh -c 'echo x >> {}'",
    "ls -d specs/* | grep story | xargs -I {} sh -c 'echo x >> {}'",
    "find specs -name '*.md' | sort | xargs -I {} sh -c 'echo x >> {}'",
    // el marcador con otro nombre, entre comillas o por una asignación (segunda vuelta de Fable)
    "ls specs | xargs -I FILE sh -c 'echo x >> specs/FILE'",
    'ls specs | xargs -I X rm specs/X',
    `ls specs | xargs -I {} sh -c 'echo x >> specs/"{}"'`,
    `ls specs | xargs -n1 sh -c 'echo x >> specs/"$0"'`,
    // una palabra de la fuente que no es una carpeta (un subcomando) no acota: va el comodín suelto
    'git ls-files | xargs rm -f',
    // una carpeta nombrada en un filtro no acota: sólo la fuente (tercera vuelta de Fable)
    "git diff --name-only | grep -v build | xargs sed -i '' s/draft/done/",
  ]) frena(c, cmd);
  for (const cmd of [
    "grep -rl foo src | xargs sed -i '' s/foo/bar/",
    'grep -rl foo src | xargs perl -pi -e s/foo/bar/',
    "git ls-files src | xargs -I {} sh -c 'sed -i \"\" s/a/b/ {}'",
    'ls build | xargs rm -rf',
    'find build -type f | xargs rm -f',
    "find build -name '*.log' -print0 | xargs -0 rm -f",
    // una opción pegada del xargs, un `%` o un `$1` de otro programa no son el marcador pegado a una ruta
    "find build -name '*.log' | xargs -I{} rm {}",
    'find build -type f | xargs -I% rm %',
    "grep -rl foo src | xargs sed -i '' 's%foo%bar%'",
    "grep -rl foo src | xargs perl -pi -e 's/foo(\\d)/bar$1/'",
    `git ls-files src | xargs -n1 sh -c 'sed -i "" s/a/b/ $0 && echo $0:ok'`,
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
  // A57: una asignación posterior al uso no tapa la anterior; y en un bucle cualquiera de las dos vale
  frena(c, `f=${H}; echo $f | xargs rm; f=otro.txt`);
  frena(c, `f=otro.txt; f=${H}; echo $f | xargs rm`);
  frena(c, `for i in 1 2; do echo $f | xargs rm; f=${H}; done`);
  pasa(c, 'f=README.md; echo $f | xargs rm; f=otro.txt');
  // pasado el tope de variantes, lo que llega no se ve y frena; y cada combinación es una entrada entera (las posiciones
  // no se corren)
  const relleno = Array.from({ length: 17 }, (_, i) => `f=a${i}.txt`).join('; ');
  frena(c, `${relleno}; f=${H}; echo $f | xargs rm`);
  frena(c, `f=${H}; echo $f | xargs rm; ${relleno}`);
  const [carpeta, nombre] = [H.slice(0, H.lastIndexOf('/')), H.slice(H.lastIndexOf('/') + 1)];
  frena(c, `n=otro.md; n=${nombre}; printf '%s/%s\\n' ${carpeta} $n | xargs rm`);
  frena(c, `f=otro.txt; f=${H}; echo x $f | xargs sh -c 'rm $1'`);
  // por `<<<`, lo mismo
  frena(c, `f=${H}; xargs rm <<< $f; f=otro.txt`);
  frena(c, `f=${H}; xargs rm <<< "$f"; f=otro.txt`);
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

// T37 FindAXargs_LoQueLaLecturaNoAlcanza_SigueFrenando
// 🔴 Falla con: reemplazar las palabras del `find` por los archivos que su lectura alcanza: cuando la lectura queda corta
//    (un `\*` sin comillas, el patrón en una variable, `\!`, un comodín en la carpeta, una carpeta que coincide), la orden
//    queda sin argumentos y la historia se borra.
test('T37 FindAXargs_LoQueLaLecturaNoAlcanza_SigueFrenando', () => {
  const c = corral();
  for (const cmd of ['find . -name \\*.md | xargs rm', 'find . -name story-\\*.md | xargs rm',
    "p='story-*.md'; find . -name \"$p\" | xargs rm", "find . \\! -name 'README.md' -type f | xargs rm",
    "find * -name 'story-*.md' | xargs rm", "find {specs,docs} -name 'story-*.md' | xargs rm",
    'find . -name specs | xargs rm -rf', 'find . -type d -name specs -print0 | xargs -0 rm -rf']) frena(c, cmd);
});

// T38 FindAXargsQueSoloLee_NoRecorre
// 🔴 Falla con: recorrer lo que alcanza el `find` antes de saber qué corre el `xargs`: un `find | xargs ls` sobre una
//    carpeta grande lee miles de carpetas (en /tmp, 15 s), y dos seguidos llegan al reloj del freno.
test('T38 FindAXargsQueSoloLee_NoRecorre', () => {
  const c = corral();
  const grande = path.join(c.raiz, 'grande');
  for (let i = 0; i < 20; i++) fs.mkdirSync(path.join(grande, `d${i}`, 'e', 'f'), { recursive: true });
  const { comandosPorOtroPrograma } = require(path.join(__dirname, '..', 'lib', 'bash-gate-commands.js'));
  const leer = fs.readdirSync;
  let lecturas = 0;
  fs.readdirSync = (...a) => { lecturas++; return leer(...a); };
  try {
    comandosPorOtroPrograma(`find ${grande} -name '*.log' | xargs grep -l x`, c.dir);
    assert.strictEqual(lecturas, 0, 'un xargs que sólo lee no recorre');
    comandosPorOtroPrograma(`find ${grande} -name '*.md' | xargs rm`, c.dir);
    assert.ok(lecturas > 0, 'uno que borra sí');
  } finally { fs.readdirSync = leer; }
});

// T40 XargsTrasUnSeparador_LoDeAlLadoCuenta
// 🔴 Falla con: saltar los filtros del medio hacia atrás también por `;`, `&&` o un salto de renglón: la fuente cae en un
//    `echo` de otro comando y las palabras del tramo de al lado (`rg -l draft specs`) se pierden; la historia se borra.
test('T40 XargsTrasUnSeparador_LoDeAlLadoCuenta', () => {
  const c = corral();
  for (const cmd of ['echo ok && rg -l draft specs | xargs rm', 'echo x; grep -l draft specs/*.md | xargs rm',
    'echo x\ngrep -l draft specs/*.md | xargs -I{} mv {} /tmp/', 'echo ok; grep -l draft specs/*.md | sort | xargs rm']) frena(c, cmd);
});

// T41 FindConNombreQueNoEsMd_NoRecorre
// 🔴 Falla con: recorrer cuatro niveles de carpetas para un `find -name '*.tmp' | xargs rm`, que no puede dar una
//    historia: sobre una carpeta grande tarda segundos.
test('T41 FindConNombreQueNoEsMd_NoRecorre', () => {
  const c = corral();
  const grande = path.join(c.raiz, 'grande-tmp');
  for (let i = 0; i < 5; i++) fs.mkdirSync(path.join(grande, `d${i}`, 'e'), { recursive: true });
  const { comandosPorOtroPrograma } = require(path.join(__dirname, '..', 'lib', 'bash-gate-commands.js'));
  const leer = fs.readdirSync;
  let lecturas = 0;
  fs.readdirSync = (...a) => { lecturas++; return leer(...a); };
  try {
    comandosPorOtroPrograma(`find ${grande} -name '*.tmp' | sort | xargs rm -f`, c.dir);
    comandosPorOtroPrograma(`find ${grande} -iname 'cache-*.log' | xargs rm -f`, c.dir);
    assert.strictEqual(lecturas, 0, 'un -name que no puede dar un .md no recorre');
    comandosPorOtroPrograma(`find ${grande} -name 'story-*' | xargs rm`, c.dir);
    assert.ok(lecturas > 0, 'uno que puede dar un .md sí');
  } finally { fs.readdirSync = leer; }
  frena(c, "find . -name 'story-*' | xargs rm");
  // un corchete o una barra pueden dar `.md` aunque no lo digan al final
  // (nombra la primera historia que encuentra, que puede ser cualquiera de las dos del corral)
  for (const n of ["'*.[m]d'", "'*.m\\d'", "'story-*.m?'", "'*d'"]) {
    const r = correr(c, `find . -name ${n} | xargs truncate -s 0`);
    assert.strictEqual(r.salida, 2, `frena: ${n}\n${r.stderr}`);
    assert.match(r.stderr, HISTORIA, n);
  }
});

// T39 Find_PwdPegadoAUnaCarpeta_EsEsaCarpeta
// 🔴 Falla con: `"$PWD"/docs` partido en dos palabras: `$PWD` sola es el repo entero y frena por las historias de specs/.
test('T39 Find_PwdPegadoAUnaCarpeta_EsEsaCarpeta', () => {
  const c = corral();
  fs.mkdirSync(path.join(c.dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(c.dir, 'docs', 'a.md'), 'x\n');
  pasa(c, "find \"$PWD\"/docs -name '*.md' -exec rm {} \\;");
  frena(c, "find \"$PWD\"/specs -name '*.md' -exec rm {} \\;");
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

// T40 CarpetaDelComando_Nombrada_Frena @A50
// 🔴 Falla con: `$PWD`, `$(pwd)`, `~+`, la raíz de git o `$OLDPWD` resueltos sólo en la carpeta de un find, o un
// `find … -delete` que el freno de historias no mira: borraban la historia sin que el freno la viera.
test('T40 CarpetaDelComando_Nombrada_Frena @A50 — la carpeta del comando nombrada de otra forma, y find -delete', () => {
  const c = corral();
  fs.mkdirSync(path.join(c.dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(c.dir, 'docs', 'a.md'), '# a\n');
  for (const cmd of [
    `rm $PWD/${H}`, `rm "$PWD/${H}"`, `rm "$(pwd)/${H}"`, `rm ~+/${H}`, 'cd $PWD/specs && rm story-1.1.md',
    `f=$PWD/${H}; rm "$f"`, `ROOT=$(git rev-parse --show-toplevel); rm "$ROOT/${H}"`, `echo $PWD/${H} | xargs rm`,
    `xargs rm <<< $PWD/${H}`, "find ~+ -name 'story-*.md' -exec rm {} \;", "find \"$(pwd -P)\" -name 'story-*.md' -exec rm {} \;",
    "find ${PWD:-.} -name 'story-*.md' -exec rm {} \;", "d=$PWD; find $d -name 'story-*.md' -exec rm {} \;",
    "cd specs && find $OLDPWD -name 'story-*.md' -exec rm {} \;", "rm $(find $PWD -name 'story-*.md')",
    "find . -name 'story-1.1.md' -delete", 'find specs -type f -delete', "find $PWD -name 'story-1.1.md' -delete",
  ]) frena(c, cmd);
  // lo que no toca historias sigue pasando, también con la carpeta nombrada y comillas pegadas
  pasa(c, "find \"$PWD\"/docs -name '*.md' -exec rm {} \;");
  pasa(c, `rm $PWD/docs/a.md`);
  pasa(c, 'find docs -name a.md -delete');
  pasa(c, 'ls $PWD/specs');
});

// T41 CarpetaDelComando_DespuesDeUnCd @A50
// 🔴 Falla con: el recorrido que arranca desde la carpeta ya movida al primer `cd` (lo aplicaba dos veces), `cd -` que
// no vuelve, un `cd` entre paréntesis que mueve el resto, `pushd` o las opciones de `cd` leídas como carpeta, o un
// `-delete` que arma el borrado de archivos con `-type d` o `-empty` (revisión de Fable de la A50).
test('T41 CarpetaDelComando_DespuesDeUnCd @A50 — el cd mueve $PWD una vez, cd - vuelve, el paréntesis devuelve la carpeta', () => {
  const c = corral();
  const afuera = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'freno-afuera-')));
  for (const cmd of [
    'cd specs && rm $PWD/story-1.1.md', 'cd specs; rm "$(pwd)/story-1.1.md"', `cd ${afuera} && rm $OLDPWD/${H}`,
    `cd ${afuera} && cd - && rm $PWD/${H}`, `(cd ${afuera} && true); rm $PWD/${H}`, 'pushd specs && rm $PWD/story-1.1.md',
    'cd -P specs && rm $PWD/story-1.1.md', `rm "$(git rev-parse --show-toplevel 2>/dev/null)/${H}"`,
  ]) frena(c, cmd);
  for (const cmd of [`cd ${afuera} && rm $PWD/${H}`, `pushd ${afuera} && rm $PWD/${H}`, 'find . -type d -empty -delete',
    `(cd ${afuera} && rm $PWD/${H})`]) pasa(c, cmd);
});

// T42 FindName_ComoLoDejaElShell_YBucles @A50
// 🔴 Falla con: un `-name` sin comillas con barra (`\*.md`), con una variable o con `$'…'` leído tal cual; una carpeta que
// cumple el `-name` borrada entera con `rm -rf` sin mirar sus historias; o un bucle que recorre lo que lista un `find`
// (`for f in $(find …)`, `find … | while read f`) sin mirar lo que corre su cuerpo.
test('T42 FindName_ComoLoDejaElShell_YBucles @A50 — el -name como lo deja el shell, la carpeta que cumple y los bucles de un find', () => {
  const c = corral();
  fs.mkdirSync(path.join(c.dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(c.dir, 'docs', 'a.md'), '# a\n');
  for (const cmd of [
    'find . -name \\*.md -exec rm {} \\;', 'find . -name story-\\*.md -exec rm {} \\;', "p='story-*.md'; find . -name \"$p\" -exec rm {} \\;",
    "find . -name $'story-1.1.md' -exec rm {} \\;", 'find . -name specs -exec rm -rf {} +', 'find . -type d -name specs -exec rm -rf {} \\;',
    "find specs -name 'story-*.md' | while read f; do rm \"$f\"; done", "for f in $(find specs -name 'story-*.md'); do rm $f; done",
    "find $PWD -name 'story-*.md' | while read -r f; do rm \"$f\"; done",
  ]) frena(c, cmd);
  for (const cmd of ["find docs -name '*.md' | while read f; do rm \"$f\"; done", "for f in $(find docs -name '*.md'); do rm $f; done",
    "for f in $(find specs -name 'story-*.md'); do cat $f; done", 'find . -name docs -exec rm -rf {} +']) pasa(c, cmd);
});

// T43 Bucles_FormasQueSeEscapaban @A50
// 🔴 Falla con (revisión de Fable de la tanda 2): las comillas de alrededor de `$f` comidas (`echo "Borrando $f"; rm "$f"`),
// el cuerpo cortado en el primer `done` (bucle adentro, `echo done`), el `do` en otro renglón, un filtro en el medio de la
// tubería, `< <(find …)`, `read -rd ''` o sin variable (REPLY), o un `rm -r` del cuerpo sobre una carpeta que cumple.
test('T43 Bucles_FormasQueSeEscapaban @A50 — comillas, done de adentro, do en otro renglón, filtros, < <(find) y rm -r', () => {
  const c = corral();
  for (const cmd of [
    "for f in $(find specs -name 'story-*.md'); do echo \"Borrando $f\"; rm \"$f\"; done",
    "for f in $(find specs -name 'story-*.md'); do for g in 1 2; do echo done; done; rm $f; done",
    "for f in $(find specs -name 'story-*.md')\ndo\n  rm \"$f\"\ndone",
    "find specs -name 'story-*.md' | sort | while read f; do rm \"$f\"; done",
    "while read -r f; do rm \"$f\"; done < <(find specs -name 'story-*.md')",
    "find specs -name 'story-*.md' -print0 | while IFS= read -rd '' f; do rm \"$f\"; done",
    "find specs -name 'story-*.md' | while read; do rm \"$REPLY\"; done",
    "find specs -name 'story-*.md' | while read f\ndo rm \"$f\"; done",
    'for d in $(find . -type d -name specs); do rm -rf "$d"; done',
  ]) frena(c, cmd);
  pasa(c, 'for d in $(find . -type d -name specs); do ls "$d"; done');
  pasa(c, 'find . -type f -name specs -exec rm -rf {} +');
});

// T44 Bucles_SinTardarConBlancos @A50
// 🔴 Falla con: las expresiones del bucle que se comían los mismos blancos una y otra vez: un `for … in` con miles de
// espacios llegaba al tope de tiempo del freno, que frena el comando entero aunque no toque historias.
test('T44 Bucles_SinTardarConBlancos @A50 — un for con muchos blancos no crece más que lineal', () => {
  const { ordenesDeBucles } = require('../lib/bash-gate-folders.js');
  const op = { palabras: (s) => s.split(/\s+/), alcanzadas: () => [], citar: (x) => x };
  const medir = (n) => {
    const t = process.hrtime.bigint();
    ordenesDeBucles(`find . ; for f in${' '.repeat(n)}x${' '.repeat(n)}done`, op);
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  medir(1000);
  const chico = Math.max(medir(4000), 1);
  const grande = medir(32000);
  assert.ok(grande < chico * 40, `8 veces más texto tardó ${grande.toFixed(1)} ms contra ${chico.toFixed(1)} ms`);
  // con miles de bucles sin cerrar (o bien cerrados), el tope de bucles leídos lo deja en menos de un segundo
  // lo que sigue al `done` armado para enredar la expresión de las redirecciones (CodeQL, js/redos): lineal
  {
    const t = process.hrtime.bigint();
    for (const trozo of ['!>', '!0>', '0>!', '&! >', '>& ']) ordenesDeBucles(`find x | while read f; do y; done >${trozo.repeat(3000)}`, op);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    assert.ok(ms < 1000, `las redirecciones tardaron ${ms.toFixed(0)} ms`);
  }
  for (const trozo of ['for f in a; do x; ', 'find x | while read f; do y; done; ']) {
    const t = process.hrtime.bigint();
    ordenesDeBucles(`${trozo.repeat(8000)} echo done`, op);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    assert.ok(ms < 1000, `8000 veces ${JSON.stringify(trozo)} tardó ${ms.toFixed(0)} ms`);
  }
});

// T45 Bucles_SegundaVuelta @A50
// 🔴 Falla con (segunda vuelta de Fable): el bucle pegado a una comilla (`bash -c 'for …'`), un `\;` o un `;` entre comillas
// en la tubería o en la lista del `for`, el `find` partido en dos renglones, `${f:?}`, la segunda variable del `read`,
// `done<` o una redirección antes de `< <(find …)`.
test('T45 Bucles_SegundaVuelta @A50 — comillas pegadas, \\; y ; citados, continuación de renglón, ${f…}, read a b, done<', () => {
  const c = corral();
  for (const cmd of [
    "bash -c 'for f in $(find specs -name \"*.md\"); do rm $f; done'",
    "find specs -name '*.md' -exec grep -l status {} \\; | while read f; do rm \"$f\"; done",
    "find specs -name '*.md' | awk '{ print $0; }' | while read f; do rm \"$f\"; done",
    "for f in $(find specs -name '*.md' | awk '{ print $0; }'); do rm $f; done",
    "find specs \\\n  -name '*.md' | while read f; do rm \"$f\"; done",
    "find specs -name '*.md' |\n  while read f; do rm \"$f\"; done",
    "for f in $(find specs -name '*.md'); do rm \"${f:?}\"; done",
    "find specs -name '*.md' | nl | while read n f; do rm \"$f\"; done",
    "while read f; do rm \"$f\"; done< <(find specs -name '*.md'); echo done",
    "while read f; do rm \"$f\"; done 2>/dev/null < <(find specs -name '*.md')",
  ]) frena(c, cmd);
});

// T46 CarpetaQueCumple_ConMuchasCarpetas @A50
// 🔴 Falla con: el tope de carpetas del recorrido que cortaba en silencio: con más de dos mil carpetas antes, una `specs` a
// dos niveles no se miraba y `find . -name specs -exec rm -rf {} +` pasaba.
test('T46 CarpetaQueCumple_ConMuchasCarpetas @A50 — pasado el tope de carpetas se miran todas las historias', () => {
  const c = corral();
  fs.mkdirSync(path.join(c.dir, 'zzz'));
  fs.renameSync(path.join(c.dir, 'specs'), path.join(c.dir, 'zzz', 'specs'));
  for (let i = 0; i < 2500; i++) fs.mkdirSync(path.join(c.dir, 'aaa', `d${i}`), { recursive: true });
  frena(c, 'find . -name specs -exec rm -rf {} +');
  frena(c, 'for d in $(find . -type d -name specs); do rm -rf "$d"; done');
  pasa(c, 'find aaa -name specs -exec rm -rf {} +');
});

// T47 Cuenta_EntreComillas_NoEsUnDestino @S247d
// 🔴 Falla con: el `>` de una cuenta `$(( a > b ))`, con o sin comillas, leído como una redirección (frenaba con la palabra
// de después como destino), o con lo que corre adentro de la cuenta, con una sustitución que sólo parece una cuenta
// (`$((cp …) )`) o con una cuenta que zsh corre como comandos (`$((cp … && : `: \(`))`), dejado de leer.
test('T47 Cuenta_EntreComillas_NoEsUnDestino @S247d — el > de una cuenta compara; lo que corre adentro se sigue leyendo', () => {
  const c = corral();
  for (const cmd of [`echo "$(( x > ${H} ? 1 : 0 ))"`, `echo $(( x > ${H} ))`, `n="$(( 3 > ${H} ))"`,
    `echo "$(( $(( x > ${H} )) + 1 ))"`, `echo "$(( x >= ${H} ))" | cat`]) pasa(c, cmd);
  for (const cmd of [
    `echo "$(( $(cp README.md ${H}) ))"`, `echo "$(( \`cp README.md ${H}\` ))"`, `echo $(( $(cp README.md ${H}) + 1 ))`,
    `echo "$((cp README.md ${H}) )"`, `echo "$((cp README.md ${H}); (true))"`, `echo "$(( 1 ))" > ${H}`,
    `echo "$(( "x" > ${H} ))"`, `echo "$(( a[$(cp README.md ${H})] ))"`, `echo "$(( x )) $(cp README.md ${H})"`,
    `echo "$(( x ; cp README.md ${H} ))"`, `echo "$(( <(cp README.md ${H}) ))"`,
    // zsh corre como comandos una cuenta que no puede leer y que tiene una sustitución adentro (revisión de Fable)
    `echo $((cp README.md ${H} && : \`: \\(\`))`, `echo "$((cat README.md > ${H} && : \`: \\(\`))"`,
    `x=$((cp README.md ${H} && : \`: \\(\`))`, `echo "$(( \${x:-$(cp README.md ${H})} ))"`,
  ]) frena(c, cmd);
});

// T48 CuentaSinPesos_NoEsUnDestino @A213
// 🔴 Falla con: el `>` o el `<` de una cuenta sin `$`, `(( a > b ))` o `for ((i=0;i<3;i++))`, leído como una redirección
// (frenaba con la palabra de después como destino), o con una escritura de verdad al lado de la cuenta, o adentro de un
// subshell que sólo se parece a una cuenta, dejada de leer.
test('T48 CuentaSinPesos_NoEsUnDestino @A213 — el > de (( … )) compara; lo que escribe al lado se sigue leyendo', () => {
  const c = corral();
  for (const cmd of [`(( x > ${H} ))`, `(( i++ ))`, `if (( x >= ${H} )); then echo si; fi`,
    `for ((i=0;i<${H};i++)); do echo $i; done`, `(( x > ${H} )) && echo si`, `while (( x < ${H} )); do break; done`,
    `echo a; (( x > ${H} ))`, `! (( x > ${H} ))`, `for ((i=5;i>${H};i--)); do echo $i; done`, `{ (( x > ${H} )); }`,
    `x=$( (( x > ${H} )) && echo 1 )`, `until (( x > ${H} )); do break; done`, `time (( x > ${H} ))`, `(((x > ${H})))`,
    `if true; then (( x > ${H} )); fi`, `! (( x > ${H} )) || echo no`, `if ! (( x > ${H} )); then :; fi`]) pasa(c, cmd);
  for (const cmd of [`(( 1 )) > ${H}`, `echo $(( 1 > 0 )) > ${H}`, `( cat README.md > ${H} )`,
    `((cat README.md > ${H}) )`, `( (cat README.md > ${H}) )`, `((cat README.md) > ${H})`, `(( x > 0 )); cp README.md ${H}`,
    `((cat README.md > ${H}); (true))`, `for ((i=0;i<1;i++)); do cp README.md ${H}; done`,
    `(( $(cp README.md ${H}) ))`, `(( \`cp README.md ${H}\` ))`, `(( a[$(cp README.md ${H})] ))`,
    `(( x > 0 )) > ${H}`, `cat <((x > ${H}))`, `{ (( x )) > ${H}; }`, `echo $( (( 1 )) > ${H} )`, `echo hi >|((x > ${H}))`,
    `\\((x > ${H}))`, `cat <( ((1)) ) > ${H}`, `(( "x" > ${H} ))`, `(( x > ${H} ; cp README.md ${H} ))`,
    `if ((1)); then cat README.md > ${H}; fi`, `for ((cat README.md > ${H}; 0; )) ; do :; done; cp README.md ${H}`,
    // en `sh` de Linux, `dash` o `ash`, `((…))` son dos subshells y lo de adentro corre: lo anidado no se lee como cuenta
    // (revisión de Fable)
    `dash -c '((cp README.md ${H}))'`, `dash -c '(( x > ${H} ))'`, `ash -c '((cp README.md ${H}))'`, `sh -c '(( x > ${H} ))'`,
    `xargs dash -c '(( x > ${H} ))'`, `dash <<'EOF'\n(( x > ${H} ))\nEOF`,
    // el `!`, el `{`, el `(` o la palabra de bloque de delante tienen que abrir un comando: detrás de `echo` son argumentos
    `( ( noglob echo ! ((x > ${H}))`, `( ( noglob echo if ((x > ${H}))`, `( ( noglob echo (((x > ${H})))`,
    `( ( noglob : for ((a; cp README.md ${H}; b))`, `echo { ((x > ${H}))`, `echo do ((x > ${H}))`,
  ]) frena(c, cmd);
  // en PowerShell (y en lo que corre Monitor) `((x > f))` escribe: la cuenta se lee así sólo en la herramienta Bash
  for (const herramienta of ['PowerShell', 'Monitor']) {
    const base = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TYCON_')) base[k] = v;
    const r = spawnSync(process.execPath, [GATE], {
      input: JSON.stringify({ tool_name: herramienta, session_id: 's-anidados', cwd: c.dir, tool_input: { command: `(( x > ${H} ))` } }),
      env: { ...base, HOME: c.home, USERPROFILE: c.home, TYCON_NO_RUN_CHANGE: '1' }, encoding: 'utf8', timeout: 15000,
    });
    assert.strictEqual(r.status, 2, `frena en ${herramienta}\n${r.stderr}`);
  }
});

// T49 PowerShellConComando_Y_ForDeCuentaSinPuntoYComa @A216
// 🔴 Falla con: lo que corre PowerShell con `-Command` (o `-c`) sin leer como un comando más (`pwsh -Command
// '((cp a h.md))'` copiaba a la historia), o el cuerpo de un `for ((…))` sin `;` antes del `do` (o del `{`, o sin nada
// en zsh) leído como argumentos del `for`.
test('T49 PowerShellConComando_Y_ForDeCuentaSinPuntoYComa @A216 — lo de adentro corre; las cuentas que no escriben pasan', () => {
  const c = corral();
  for (const cmd of [`pwsh -Command '((cp README.md ${H}))'`, `pwsh -Command "((cp README.md ${H}))"`,
    `pwsh -c 'cp README.md ${H}'`, `powershell -Command '(cp README.md ${H})'`, `pwsh -NoProfile -Command '((cp README.md ${H}))'`,
    `pwsh.exe -command 'cp README.md ${H}'`, `/usr/local/bin/pwsh -Command 'cp README.md ${H}'`, `pwsh -Command cp README.md ${H}`,
    `pwsh -Command '((x > ${H}))'`, `pwsh -NonInteractive -c "Copy-Item README.md ${H}"`, `pwsh -cwa 'cp README.md ${H}'`,
    `for ((i=0;i<1;i++)) do cp README.md ${H}; done`, `for ((i=0;i<1;i++))do cp README.md ${H}; done`,
    `for ((i=0;i<1;i++)) { cp README.md ${H}; }`, `for ((i=0;i<1;i++)) cp README.md ${H}`, `for (( ; ; )) do cp README.md ${H}; break; done`,
    `bash -c 'for ((i=0;i<1;i++)) do cp README.md ${H}; done'`, `for ((i=0;i<1;i++)) do mv README.md ${H}; done`,
    `if true; then for ((i=0;i<1;i++)) do cp README.md ${H}; done; fi`, `for ((i=0;i<1;i++)) do rm ${H}; done`,
    `bash -c "for ((i=0;i<1;i++)) do rm ${H}; done"`, `pwsh -Command "rm ${H}"`,
    `pwsh -EncodedCommand ${Buffer.from(`cp README.md ${H}`, 'utf16le').toString('base64')}`,
    // (revisión de Fable) las redirecciones de afuera no son destinos de la copia; las variables de afuera valen; la entrada
    `pwsh -Command 'cp README.md ${H}' 2>/dev/null`, `pwsh -Command 'cp README.md ${H}' 2>&1 | tail -5`,
    `F=${H}; pwsh -c "cp README.md $F"`, `F=${H}; pwsh -c 'rm $F'`, `echo 'cp README.md ${H}' | pwsh -Command -`,
    `pwsh <<'EOF'\ncp README.md ${H}\nEOF`,
    // el `for` en una función, un `case`, un `<(…)`, un `"$(…)"`, tres anidados, detrás de un comentario con apóstrofo
    `f() { for ((i=0;i<1;i++)) do cp README.md ${H}; done; }; f`, `case x in x) for ((i=0;i<1;i++)) do cp README.md ${H}; done;; esac`,
    `cat <(for ((i=0;i<1;i++)) do cp README.md ${H}; done)`, `x="$(for ((i=0;i<1;i++)) do cp README.md ${H}; done)"`,
    `for ((i=0;i<1;i++)) do for ((j=0;j<1;j++)) do for ((k=0;k<1;k++)) do cp README.md ${H}; done; done; done`,
    `# don't\nfor ((i=0;i<1;i++)) do cp README.md ${H}; done`,
    // (segunda vuelta de Fable) un `for ((` citado o fuera de lugar no corta los argumentos; las entradas de afuera de pwsh
    `rm $(: $(: 'for ((')) ${H}`, `cp README.md $(: "$(: 'for ((')") ${H}`, `cat README.md | tee $(: $(: '# for ((')) ${H}`,
    `touch fora; cp for((a)) ${H}`, `pwsh -c 'cp README.md ${H}' </dev/null`, `pwsh -c 'cp README.md ${H}' <<< x`,
    `pwsh -c 'cp README.md ${H}' > >(cat)`, `pwsh -c 'cp README.md ${H}' {fd}>/tmp/x`,
  ]) frena(c, cmd);
  for (const cmd of [`for ((i=0;i<3;i++)) do echo $i; done`, `for ((i=5;i>${H};i--)) do echo $i; done`,
    `for ((i=0;i<${H};i++)) { echo $i; }`, `for ((i=0;i<${H};i++))do echo $i; done`, `pwsh -Command 'Get-Content README.md'`,
    `pwsh -Command 'cp README.md notas.txt'`, `pwsh -Command '((x > notas.txt))'`, `echo "pwsh -Command 'cp README.md ${H}'"`,
    `git commit -m "for ((i=0;i<1;i++)) do cp README.md ${H}; done"`, `echo 'for ((i=0;i<1;i++)) do cp README.md ${H}; done'`,
    `pwsh -Command 'Get-Content README.md' 2>&1 | tail -5`, `pwsh -File script.ps1 <<'EOF'\nhola\nEOF`,
    `git commit -m'fix: for ((i=0;i<1;i++)) do cp README.md ${H}; done'`, `git commit -m"fix: for ((i=0;i<1;i++)) do cp README.md ${H}; done"`,
    `git log -S'for ((i=0;i<1;i++)) do cp README.md ${H}' --oneline`, `git grep -n -e'for ((i=0;i<1;i++)) do cp README.md ${H}'`,
    `# for ((i=0;i<1;i++)) do cp README.md ${H}; done`, `echo hola # for ((i=0;i<1;i++)) do cp README.md ${H}; done`,
    `echo ok # (ver for ((i=0;i<1;i++)) cp README.md ${H})`]) pasa(c, cmd);
});
