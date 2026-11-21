'use strict';
// Un guion en archivo (python, node, perl, ruby) con una historia entre sus argumentos: lo que hace con ella no se
// termina de ver desde la consola, así que el freno de escrituras por consola lo cuenta como escritura de la historia.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPTS = path.join(__dirname, '..');
const bash = require(path.join(SCRIPTS, 'on-bash-write-gate.js'));

const SID = 'sesion-interprete';
const HISTORIA = '⛔ tycon-pipeline — HISTORIA ESCRITA POR CONSOLA';

/** Un repo de juguete con dos historias y una corrida abierta con el plan aprobado. */
function corral() {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'interprete-')));
  const estado = path.join(raiz, 'estado');
  const repo = path.join(raiz, 'repo');
  for (const d of [path.join(estado, 'active'), path.join(repo, 'specs'), path.join(repo, 'docs', 'stories'), path.join(repo, 'out')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(path.join(estado, 'active', `${SID}.json`), JSON.stringify({
    storyId: '9.9', repoPath: repo, sessionId: SID, stepsCompleted: [0, 1, 2, 3], stepsPending: [4, 5, 6, 7, 8],
  }));
  const fm = (n) => `---\nstory: "${n}"\ntitle: "x"\nstatus: in-progress\n---\n\n# x\n`;
  fs.writeFileSync(path.join(repo, 'specs', 'story-x.md'), fm('9.9'));
  fs.writeFileSync(path.join(repo, 'docs', 'stories', 'story-y.md'), fm('9.8'));
  return { estado, repo };
}

function conEnv(vars, fn) {
  const antes = {};
  for (const k of Object.keys(vars)) { antes[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k]; }
  }
}

const ENV = { TYCON_LEDGER_VISIBLE: undefined, TYCON_STORY_GATE: undefined, TYCON_NO_RUN_CHANGE: '1' };

// T1 ScriptWithStoryArgument_CountsAsWritingIt
// El modo de `open` en una variable, `os.open`, `fileinput` en el lugar, un programa que lanza, `File.write(ARGV[0])` de
// ruby, el `-pi` de perl en la primera línea, `fs.openSync(p, 'r+')`, una precarga: con una historia entre sus
// argumentos, el guion cuenta como que la escribe, aunque sólo la lea (para leerla está la herramienta de lectura).
// También por `--file=<historia>`, por un comodín del shell y por un enlace. Sin una historia entre los argumentos, el
// guion se juzga por lo que escribe.
// 🔴 Falla con: buscar las formas de escribir una por una (siempre queda una afuera), no expandir el comodín, no partir
//    `--x=valor`, o mirar el nombre del enlace en vez de a dónde lleva.
test('T1 ScriptWithStoryArgument_CountsAsWritingIt', () => {
  const { estado, repo } = corral();
  conEnv(ENV, () => {
    const juzgar = (c) => bash.handle({ tool_name: 'Bash', session_id: SID, cwd: repo, tool_input: { command: c } }, { stateDir: estado, installedRoots: [] });
    const freno = (c) => { const r = juzgar(c); return r && r.block ? r.block.split('\n').find((l) => l.trim()).trim() : ''; };
    const guion = (nombre, texto) => fs.writeFileSync(path.join(repo, nombre), texto);
    guion('modo.py', "import sys\nm = 'w'\nopen(sys.argv[1], m).write('x')\n");
    guion('osopen.py', "import sys, os\nfd = os.open(sys.argv[1], os.O_WRONLY | os.O_TRUNC)\nos.write(fd, b'x')\n");
    guion('fi.py', "import fileinput\nfor l in fileinput.input(inplace=True):\n    print(l.replace('in-progress', 'done'), end='')\n");
    guion('sub.py', "import sys, subprocess\nsubprocess.run(['sed', '-i', 's/a/b/', sys.argv[1]])\n");
    guion('w.rb', "File.write(ARGV[0], File.read(ARGV[0]).sub('in-progress', 'done'))\n");
    guion('pi.pl', '#!/usr/bin/perl -pi\ns/in-progress/done/;\n');
    guion('rmas.js', "const fs = require('fs');\nconst fd = fs.openSync(process.argv[2], 'r+');\nfs.writeSync(fd, 'x');\n");
    guion('lanza.js', "require('child_process').execFileSync('sed', ['-i', 's/a/b/', process.argv[2]]);\n");
    guion('pre.js', "require('fs').writeFileSync(process.argv[2], 'x');\n");
    guion('r.js', 'console.log(1);\n');
    guion('lee.py', "import sys\nprint(open(sys.argv[1]).read())\n");
    guion('fijo.js', "const fs = require('fs');\nfs.writeFileSync('out/r.md', fs.readFileSync(process.argv[2], 'utf8'));\n");
    fs.symlinkSync(path.join(repo, 'specs', 'story-x.md'), path.join(repo, 'enlace'));
    fs.linkSync(path.join(repo, 'specs', 'story-x.md'), path.join(repo, 'duro'));
    // más archivos de los que el comodín mira, ninguno de los cuales puede ser una historia
    fs.mkdirSync(path.join(repo, 'muchos'));
    for (let i = 0; i < 210; i++) fs.writeFileSync(path.join(repo, 'muchos', `${i}.txt`), 'x');
    for (const c of [
      'python3 modo.py specs/story-x.md', 'python3 osopen.py specs/story-x.md', 'python3 fi.py specs/story-x.md',
      'python3 sub.py specs/story-x.md', 'ruby w.rb specs/story-x.md', 'perl pi.pl specs/story-x.md',
      'node rmas.js specs/story-x.md', 'node lanza.js docs/stories/story-y.md', 'node -r ./pre.js r.js specs/story-x.md',
      'python3 lee.py specs/story-x.md', 'node fijo.js specs/story-x.md',
      'python3 modo.py specs/*.md', 'node lanza.js docs/*/story-*.md', 'python3 modo.py --file=specs/story-x.md',
      'python3 modo.py enlace', 'python3 modo.py duro', 'python3 modo.py -ospecs/story-x.md', 'python3 modo.py file=specs/story-x.md',
      'python3 modo.py --file:specs/story-x.md', "python3 modo.py 'specs/story-[!a].md'", 'python3 modo.py specs/{story-x,otra}.md',
      'python3 modo.py "$PWD/specs/story-x.md"',
    ]) assert.equal(freno(c), HISTORIA, c);
    assert.match(juzgar('python3 lee.py specs/story-x.md').block, /recibe la historia por argumento/, 'el motivo dice cómo se lee');
    for (const c of [
      'python3 lee.py out/r.md', 'node fijo.js out/r.md', 'python3 modo.py out/*.md', 'python3 modo.py --file=out/r.md',
      'python3 no-existe.py specs/story-x.md', 'python3 modo.py muchos/*.txt', 'python3 modo.py modo.py',
    ]) assert.equal(freno(c), '', c);
  });
});
