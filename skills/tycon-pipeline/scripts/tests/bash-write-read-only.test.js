'use strict';
// Correr una prueba con su corredor no es una escritura invisible; lo que sí escribe código o una historia en el mismo
// comando (una redirección, otro tramo, un bucle, un shell con su texto) frena como siempre.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bash = require(path.join(__dirname, '..', 'on-bash-write-gate.js'));

const SID = 'sesion-solo-lee';
const ENV = { TYCON_LEDGER_VISIBLE: undefined, TYCON_STORY_GATE: undefined, TYCON_STORY_SKILL_GATE: undefined, TYCON_NO_RUN_CHANGE: '1' };
const HISTORIA = 'HISTORIA ESCRITA POR CONSOLA';
const INVISIBLE = 'EDICIÓN INVISIBLE';

function conEnv(vars, fn) {
  const antes = {};
  for (const k of Object.keys(vars)) { antes[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k]; }
  }
}

/** Un repo con una historia en curso, pruebas, una corrida abierta con el plan aprobado y una instalación del arnés. */
// las carpetas de cada corral se borran al terminar
const raices = [];
test.after(() => { for (const r of raices) fs.rmSync(r, { recursive: true, force: true }); });

function corral() {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'solo-lee-')));
  raices.push(raiz);
  const estado = path.join(raiz, 'estado');
  const repo = path.join(raiz, 'repo');
  const instalado = path.join(raiz, 'instalado');
  for (const d of [path.join(estado, 'active'), path.join(repo, '.git'), path.join(repo, '.tycon'), path.join(repo, 'specs'),
    path.join(repo, 'scripts', 'tests'), path.join(repo, 'src'), instalado]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(repo, 'specs', 'story-9.1.md'), '---\nstory: "9.1"\nepic: "9"\ntitle: "x"\nstatus: in-progress\n---\n\n# x\n');
  // una prueba que escribe con rutas armadas en su carpeta temporal, y una de bash que hace lo mismo
  fs.writeFileSync(path.join(repo, 'scripts', 'tests', 'x.test.js'), [
    "const fs = require('fs'); const os = require('os'); const path = require('path');",
    "const d = fs.mkdtempSync(path.join(os.tmpdir(), 't-'));",
    "fs.writeFileSync(path.join(d, 'a.js'), 'x');",
    "fs.writeFileSync(path.join(d, 'story-1.1.md'), '---\\nstatus: done\\n---\\n');",
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(repo, 'scripts', 'tests', 'y.test.sh'), 'd="$(mktemp -d)"\necho x > "$d/a.js"\n');
  // un guion ajeno que escribe la historia que recibe
  fs.writeFileSync(path.join(repo, 'scripts', 'escribe.js'), "require('fs').writeFileSync(process.argv[2], 'x');\n");
  for (const n of ['pipeline.js', 'marker.js']) fs.writeFileSync(path.join(instalado, n), 'process.exit(0);\n');
  fs.writeFileSync(path.join(estado, 'active', `${SID}.json`), JSON.stringify({
    storyId: '9.1', repoPath: repo, storyPath: path.join(repo, 'specs', 'story-9.1.md'), sessionId: SID,
    stepsCompleted: [0, 1, 2, 3], stepsPending: [4, 5, 6, 7, 8],
  }));
  return { estado, repo, instalado, casa: raiz };
}

// El control anota sus fallas internas en el registro de errores de la casa y deja pasar el comando: con la casa del
// corral, un «pasa» que en realidad fue una falla se ve, y no ensucia el registro real.
const erroresDe = (casa) => (fs.readdirSync(casa, { recursive: true }).filter((f) => path.basename(String(f)) === 'hook-errors.log'))
  .map((f) => fs.readFileSync(path.join(casa, String(f)), 'utf8')).join('');

function juzgador({ estado, repo, instalado, casa }) {
  return (c) => conEnv({ ...ENV, HOME: casa, USERPROFILE: casa }, () => {
    const r = bash.handle({ tool_name: 'Bash', session_id: SID, cwd: repo, tool_input: { command: c } }, { stateDir: estado, installedRoots: [instalado] });
    assert.strictEqual(erroresDe(casa), '', `el control falló por dentro con: ${c}`);
    return r && r.block ? r.block.split('\n').find((l) => l.trim()).trim() : '';
  });
}

const H = 'specs/story-9.1.md';

// T7 BashWrite_HarnessReadOnlyWithStory_Passes
// 🔴 Falla con: contar como escritas todas las palabras por un `for` que no toca la historia.
test('T7 BashWrite_HarnessReadOnlyWithStory_Passes @story-8.278 @story-8.308 @ac-10 @ac-16', () => {
  const c = corral();
  const freno = juzgador(c);
  const P = path.join(c.instalado, 'pipeline.js');
  for (const cmd of [
    `node ${P} advisors --story ${H} --files a.js > /tmp/x.json`,
    `node ${P} advisors --story ${H} --files a.js | tee /tmp/x.json`,
    `for f in a b; do echo $f; done > /tmp/o.txt; cat ${H}`,
    `for i in 1 2; do echo $i; done > /tmp/o.txt; node ${P} advisors --story ${H}`,
    `python3 -c "print([k for k in [1]])" > /tmp/o.txt; cat ${H}`,
  ]) assert.strictEqual(freno(cmd), '', cmd);
});

// T8 BashWrite_StoryAsTargetOrWritingSubcommand_Blocks
// 🔴 Falla con: tomar por lector lo que escribe, o un guion que no es el instalado.
test('T8 BashWrite_StoryAsTargetOrWritingSubcommand_Blocks @story-8.278 @story-8.308 @ac-11 @ac-12 @ac-16', () => {
  const c = corral();
  const freno = juzgador(c);
  const P = path.join(c.instalado, 'pipeline.js');
  const M = path.join(c.instalado, 'marker.js');
  assert.match(freno(`node ${P} advisors --story ${H} > ${H}`), new RegExp(HISTORIA));
  assert.match(freno(`node ${P} advisors --story ${H} > "$OUT"`), new RegExp(INVISIBLE));
  assert.match(freno(`node scripts/escribe.js ${H}`), new RegExp(HISTORIA));
  assert.strictEqual(freno(`node ${M} update-story-status ${H} done`), '');
  assert.match(freno('for f in specs/*.md; do sed -i s/a/b/ "$f"; done'), new RegExp(HISTORIA));
  // un `pipeline.js` que no es el instalado no cuenta como lector
  assert.match(freno(`for f in a; do echo $f; done > /tmp/o.txt; node scripts/pipeline.js advisors --story ${H}`), new RegExp(HISTORIA));
});

// T16 BashWrite_ReaderShortcut_Table
// 🔴 Falla con: un atajo que deja afuera lo que corre por una tubería partida, o que frena lo que sólo lee.
test('T16 BashWrite_ReaderShortcut_Table @story-8.308 @ac-16', () => {
  const c = corral();
  const freno = juzgador(c);
  const P = path.join(c.instalado, 'pipeline.js');
  for (const cmd of [
    `for f in a b; do echo $f; done > /tmp/o.txt; cat ${H}`,
    `python3 -c "print([k for k in [1]])" > /tmp/o.txt; cat ${H}`,
    `for f in a b; do echo $f; done > /tmp/o.txt; node ${P} advisors --story ${H}`,
  ]) assert.strictEqual(freno(cmd), '', cmd);
  const FOR = 'for f in a; do echo $f; done > /tmp/o.txt;';
  for (const resto of [
    `cat ${H} > src/x.js`, `cat ${H} | sh`, `bash -c 'rm ${H}'`, `find specs -name story-9.1.md -execdir truncate -s 0 {} \\;`,
    `echo ${H} | xargs truncate -s 0`, `ls ${H} |\nrsync --remove-source-files --files-from=- . /tmp/x`,
    `ls ${H} | (rsync --remove-source-files --files-from=- . /tmp/x)`, `ls ${H} || rsync --remove-source-files --files-from=- . /tmp/x`,
    `ls ${H} |& rsync --remove-source-files --files-from=- . /tmp/x`, `ls ${H} | while read f; do rm "$f"; done`,
  ]) assert.notStrictEqual(freno(`${FOR} ${resto}`), '', resto);
  assert.notStrictEqual(freno('for f in specs/*.md; do sed -i s/a/b/ "$f"; done'), '');
});

// T5 BashWrite_RunningATest_NotInvisible — @story-8.278 @ac-7
// 🔴 Falla con: contar como escritura invisible lo que una prueba arma por dentro al correrla con su corredor.
test('T5 BashWrite_RunningATest_NotInvisible — @story-8.278 @ac-7', () => {
  const freno = juzgador(corral());
  assert.strictEqual(freno('node --test scripts/tests/x.test.js'), '');
  assert.strictEqual(freno('node --test scripts/tests/x.test.js 2>&1 | tail -20'), '');
  assert.strictEqual(freno('bash scripts/tests/y.test.sh'), '');
  assert.strictEqual(freno('npx vitest run scripts/tests/x.test.js'), '');
  assert.strictEqual(freno('npx jest scripts/tests/x.test.js'), '');
  // un corredor que no está en la lista se mira como siempre: sin escritura que se vea, pasa
  assert.strictEqual(freno('pytest scripts/tests/x.test.js'), '');
});

// T6 BashWrite_TestPlusRedirectOrStory_Blocks — @story-8.278 @ac-8 @ac-9 @ac-19
// 🔴 Falla con: dejar pasar la escritura de código o de la historia que viaja en el mismo comando que la prueba.
test('T6 BashWrite_TestPlusRedirectOrStory_Blocks — @story-8.278 @ac-8 @ac-9 @ac-19', () => {
  const freno = juzgador(corral());
  assert.match(freno('node --test scripts/tests/x.test.js > src/a.js'), new RegExp(INVISIBLE));
  assert.match(freno('node --test scripts/tests/x.test.js specs/story-9.1.md'), new RegExp(HISTORIA));
  assert.match(freno('node --test scripts/tests/x.test.js && cat specs/story-9.1.md > src/b.js'), new RegExp(INVISIBLE));
  assert.match(freno('for f in specs/*.md; do sed -i.bak s/a/b/ "$f"; done'), new RegExp(HISTORIA));
  // un bucle inofensivo no saca de la cuenta a otro tramo que corre un shell o eval con su propio texto (en main frenaba)
  assert.match(freno("for f in a; do :; done; bash -c 'echo x > specs/story-9.1.md'"), new RegExp(HISTORIA));
  assert.match(freno("for i in 1; do :; done; bash -c 'for f in specs/*.md; do echo x >> \"$f\"; done'"), new RegExp(HISTORIA));
  assert.match(freno("for f in a; do :; done; sh -c 'echo x > specs/story-9.1.md'"), new RegExp(HISTORIA));
  assert.match(freno("for f in a; do :; done; eval 'echo x > specs/story-9.1.md'"), new RegExp(HISTORIA));
  // y cualquier otra forma de darle texto a un shell: con ruta, con opciones largas, entre comillas, por la entrada o con source
  for (const resto of ["/bin/bash -c 'echo x > specs/story-9.1.md'", "bash --login -c 'echo x > specs/story-9.1.md'",
    "bash -o pipefail -c 'echo x > specs/story-9.1.md'", "\"bash\" -c 'echo x > specs/story-9.1.md'",
    "$SHELL -c 'echo x > specs/story-9.1.md'", "echo 'echo x > specs/story-9.1.md' | bash",
    "source <(echo echo x \\> specs/story-9.1.md)", "env bash -c 'echo x > specs/story-9.1.md'"]) {
    assert.match(freno(`for f in a; do :; done; ${resto}`), new RegExp(HISTORIA), resto);
  }
  assert.match(freno('node --test scripts/tests/x.test.js; cp /tmp/x.md specs/story-9.1.md'), new RegExp(HISTORIA));
  // un guion que no es prueba y escribe la historia que recibe, y un corredor que no está en la lista: se miran como hoy
  assert.match(freno('node scripts/escribe.js specs/story-9.1.md'), new RegExp(HISTORIA));
  assert.match(freno('dotnet test; cp /tmp/x.md specs/story-9.1.md'), new RegExp(HISTORIA));
  assert.match(freno("cat > specs/story-9.1.md <<'EOF'\n---\nstatus: done\n---\nEOF"), new RegExp(HISTORIA));
  assert.match(freno('for f in specs/story-9.1.md; do echo x > "$f"; done'), new RegExp(HISTORIA));
  // un guion en línea corto antes o después del bucle no le cambia las palabras
  assert.match(freno('python3 -c "r"; for f in specs/story-9.1.md; do cp /tmp/x.md "$f"; done'), new RegExp(HISTORIA));
  assert.match(freno('for f in specs/story-9.1.md; do echo x > "$f"; done; node -e "1"'), new RegExp(HISTORIA));
  // un guion en línea con un bucle que escribe lo que recibe: frena (con la corrida abierta lo para primero el registro)
  assert.match(freno(`python3 -c "import sys\nfor p in sys.argv[1:]: open(p, 'w').write('x')" specs/story-9.1.md`), new RegExp(`${HISTORIA}|${INVISIBLE}`));
});
