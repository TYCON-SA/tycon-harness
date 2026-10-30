'use strict';
// Un guion en archivo más grande que lo que el freno lee entero: si escribe y nombra una historia o una constancia, frena.
// «Nombra una historia» es la palabra entera, no un pedazo («historial», «storage», «restore»), y en un repo sin
// historias sólo cuenta una ruta de historia o una constancia, no la palabra suelta.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPTS = path.join(__dirname, '..');
const bash = require(path.join(SCRIPTS, 'on-bash-write-gate.js'));

const FRENO = '⛔ tycon-pipeline — GUION QUE NO SE PUEDE LEER ENTERO';
const ENV = { TYCON_LEDGER_VISIBLE: undefined, TYCON_STORY_GATE: undefined, TYCON_NO_RUN_CHANGE: '1' };

function conEnv(vars, fn) {
  const antes = {};
  for (const k of Object.keys(vars)) { antes[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k]; }
  }
}

/** Un repo git de juguete; `historias` es la carpeta (relativa) donde deja una historia con su encabezado, o nada. */
function repo(historias, extra = {}) {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guion-grande-')));
  const estado = path.join(raiz, 'estado');
  const dir = path.join(raiz, 'repo');
  fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  if (historias) {
    fs.mkdirSync(path.join(dir, historias), { recursive: true });
    fs.writeFileSync(path.join(dir, historias, 'story-1.1.md'), '---\nstory: "1.1"\nepic: "1"\ntitle: "x"\nstatus: in-progress\n---\n\n# x\n');
  }
  if (extra.tycon) fs.mkdirSync(path.join(dir, '.tycon'), { recursive: true });
  return { estado, dir };
}

/** Un guion de python de más de 256 KB que escribe un archivo y dice `cuerpo` en su texto. */
function guionGrande(dir, cuerpo) {
  const relleno = '# ' + 'x'.repeat(200) + '\n';
  const texto = `import csv, sys\n${cuerpo}\nopen('salida.csv', 'w').write('x')\n` + relleno.repeat(Math.ceil((300 * 1024) / relleno.length));
  fs.writeFileSync(path.join(dir, 'scripts', 'barrido.py'), texto);
}

function freno(estado, dir) {
  return conEnv(ENV, () => {
    const r = bash.handle({ tool_name: 'Bash', session_id: 'sesion-guion-grande', cwd: dir, tool_input: { command: 'python3 scripts/barrido.py datos.csv --group=2' } }, { stateDir: estado, installedRoots: [] });
    return r && r.block ? r.block.split('\n').find((l) => l.trim()).trim() : '';
  });
}

// T1 BigScript_WordInsideAnother_DoesNotCount
// 🔴 Falla con: buscar «historia» o «story» como pedazo de otra palabra (el «historial» de commits, «storage», «restore»).
test('T1 BigScript_WordInsideAnother_DoesNotCount', () => {
  const { estado, dir } = repo('specs');
  guionGrande(dir, "# el historial de commits, el storage y el restore de la base\nhistorial = []\n");
  assert.strictEqual(freno(estado, dir), '', 'en un repo con historias, «historial», «storage» y «restore» no nombran una historia');
});

// T2 BigScript_RepoWithoutStories_WordAloneDoesNotCount
// 🔴 Falla con: frenar en un repo sin historias (sin `.tycon/` y sin ninguna historia que el descubridor encuentre) a
//    un guion grande que sólo dice la palabra.
test('T2 BigScript_RepoWithoutStories_WordAloneDoesNotCount', () => {
  const { estado, dir } = repo(null);
  guionGrande(dir, "# arma la historia de cada alumno y una story por comisión\n");
  assert.strictEqual(freno(estado, dir), '', 'sin historias en el repo, la palabra sola no frena');
});

// T3 BigScript_StoryPathOrRecord_StillBlocks
// 🔴 Falla con: soltar el freno en un repo sin historias cuando el guion nombra una ruta de historia (de otro repo) o una
//    constancia (también armada por partes: `Path('specs') / n`), o soltarlo en un repo con historias cuando nombra la
//    palabra entera.
test('T3 BigScript_StoryPathOrRecord_StillBlocks', () => {
  const sin = repo(null);
  guionGrande(sin.dir, "p = '/otro/repo/specs/story-1.1.md'\n");
  assert.strictEqual(freno(sin.estado, sin.dir), FRENO, 'una ruta de historia frena aunque el repo no tenga historias');
  const sin2 = repo(null);
  guionGrande(sin2.dir, "p = 'control-changes/aprobado.json'\n");
  assert.strictEqual(freno(sin2.estado, sin2.dir), FRENO, 'una constancia frena en cualquier repo');
  // la ruta armada por partes
  for (const partes of ["from pathlib import Path\np = Path('specs') / (n + '.md')\n", "import os\np = os.path.join('stories', f)\n", "p = 'specs/' + n + '.md'\n"]) {
    const s = repo(null);
    guionGrande(s.dir, partes);
    assert.strictEqual(freno(s.estado, s.dir), FRENO, `una ruta de historia armada por partes frena: ${partes.trim()}`);
  }
  const con = repo('specs');
  guionGrande(con.dir, "# cambia el estado de la story\n");
  assert.strictEqual(freno(con.estado, con.dir), FRENO, 'en un repo con historias, la palabra entera frena');
});

// T4 BigScript_RepoWithStoriesElsewhere_StillBlocks
// 🔴 Falla con: reconocer las historias por una lista de carpetas en vez de por el descubridor del arnés (un repo de
//    producto con `spec/stories/`), no contar `.tycon/` como repo del arnés aunque todavía no tenga historias, o reusar
//    un «ninguna» guardado de antes de la primera historia.
test('T4 BigScript_RepoWithStoriesElsewhere_StillBlocks', () => {
  const spec = repo('spec/stories');
  guionGrande(spec.dir, "# cambia el estado de la historia\n");
  assert.strictEqual(freno(spec.estado, spec.dir), FRENO, 'un repo con spec/stories/ tiene historias');
  // la primera historia recién escrita en un repo que hasta recién no tenía: el «ninguna» anterior no se reusa
  const nueva = repo(null);
  guionGrande(nueva.dir, "# cambia el estado de la historia\n");
  assert.strictEqual(freno(nueva.estado, nueva.dir), '');
  fs.mkdirSync(path.join(nueva.dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(nueva.dir, 'docs', 'story-1.1.md'), '---\nstory: "1.1"\nepic: "1"\ntitle: "x"\nstatus: in-progress\n---\n\n# x\n');
  assert.strictEqual(freno(nueva.estado, nueva.dir), FRENO, 'con su primera historia, el repo ya tiene historias');
  const tycon = repo(null, { tycon: true });
  guionGrande(tycon.dir, "# cambia el estado de la historia\n");
  assert.strictEqual(freno(tycon.estado, tycon.dir), FRENO, 'un repo con .tycon/ es del arnés');
});
