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

/** Corre `fn` con el descubridor contestando lo que diga `respuestas` en cada llamada (la última se repite). */
function conEscaneo(respuestas, fn) {
  const sd = require(path.join(SCRIPTS, 'lib', 'story-discovery.js'));
  const real = sd.discoverStories;
  const pedidos = [];
  // lo que el freno anota va a una carpeta personal de prueba, no al registro de la máquina
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guion-grande-home-')));
  sd.discoverStories = (raiz, opts) => {
    pedidos.push(opts);
    const r = respuestas[Math.min(pedidos.length - 1, respuestas.length - 1)];
    if (r instanceof Error) throw r;
    return r === 'real' ? real(raiz, opts) : { stories: [], excluded: [], warnings: [], partial: false, ...r };
  };
  try { return conEnv({ HOME: home, USERPROFILE: home }, () => ({ salida: fn(), pedidos, home })); } finally { sd.discoverStories = real; }
}
const UNA_HISTORIA = { id: '1.1', path: '/x/story-1.1.md' };

// T5 IncompleteScan_NoStories_WordAloneDoesNotBlock
// 🔴 Falla con: contar como repo con historias a un escaneo que no terminó y no encontró ninguna: el mismo comando frena o
//    pasa según lo cargada que esté la máquina.
test('T5 IncompleteScan_NoStories_WordAloneDoesNotBlock', () => {
  const { estado, dir } = repo(null);
  guionGrande(dir, "# arma la historia de cada alumno\n");
  const reintento = conEscaneo([{ partial: true }, 'real'], () => freno(estado, dir));
  assert.strictEqual(reintento.salida, '', 'con más tiempo terminó y no hay historias');
  assert.ok(reintento.pedidos.some((o) => o.budgetMs > 500), 'el segundo intento lleva más presupuesto');
  const nunca = conEscaneo([{ partial: true }], () => freno(estado, dir));
  assert.strictEqual(nunca.salida, '', 'tampoco terminó con más tiempo: la palabra suelta sola no frena');
  const registro = fs.readFileSync(path.join(nunca.home, '.claude', '.tycon-pipeline', 'hook-errors.log'), 'utf8');
  assert.match(registro, /falla atrapada: Error: el escaneo de historias de .* no terminó/, 'el freno aflojó y queda dicho');
});

// T6 IncompleteScan_NoStories_PathOrRecordStillBlocks
// 🔴 Falla con: soltar el guion entero cuando el escaneo no terminó: la ruta de una historia y la constancia frenan igual.
test('T6 IncompleteScan_NoStories_PathOrRecordStillBlocks', () => {
  for (const cuerpo of ["p = '/otro/repo/specs/story-1.1.md'\n", "p = 'control-changes/aprobado.json'\n"]) {
    const { estado, dir } = repo(null);
    guionGrande(dir, cuerpo);
    assert.strictEqual(conEscaneo([{ partial: true }], () => freno(estado, dir)).salida, FRENO, cuerpo.trim());
  }
});

// T7 IncompleteScan_StoriesFound_StillStrict
// 🔴 Falla con: aflojar el freno en un repo con historias: las encontradas en un escaneo incompleto, en el primer intento
//    o en el reintento, valen como un repo con historias. El escaneo que falla, también.
test('T7 IncompleteScan_StoriesFound_StillStrict', () => {
  for (const respuestas of [
    [{ partial: true, stories: [UNA_HISTORIA] }],
    [{ partial: true }, { partial: true, stories: [UNA_HISTORIA] }],
    [{ partial: true }, { partial: false, stories: [UNA_HISTORIA] }],
    [new Error('roto a propósito')],
    [{ partial: true }, new Error('roto a propósito')],
  ]) {
    const { estado, dir } = repo(null);
    guionGrande(dir, "# cambia el estado de la historia\n");
    assert.strictEqual(conEscaneo(respuestas, () => freno(estado, dir)).salida, FRENO, JSON.stringify(respuestas));
  }
});

const RAIZ_ARNES = path.resolve(SCRIPTS, '..', '..', '..');

/** Un `marker.js` grande en el repo, y el freno sobre `command`, con esta copia del arnés como la instalada. */
function frenoDeComando(command, opts = {}) {
  const { estado, dir } = repo('specs', { tycon: true });
  const relleno = '// ' + 'x'.repeat(200) + '\n';
  const guion = path.join(dir, 'scripts', 'marker.js');
  fs.writeFileSync(guion, `#!/usr/bin/env node\n// cambia el estado de la story\nrequire('fs').writeFileSync(process.argv[2], 'x');\n` + relleno.repeat(1600));
  fs.chmodSync(guion, 0o755);
  if (opts.plantado) fs.writeFileSync(path.join(dir, 'scripts', 'plantado.js'), 'process.exit(0);\n');
  if (opts.copiaDePipeline) fs.copyFileSync(PIPELINE, path.join(dir, 'scripts', 'pipeline.js'));
  return conEnv(ENV, () => {
    const r = bash.handle({ tool_name: 'Bash', session_id: 'sesion-guion-grande', cwd: dir, tool_input: { command } }, { stateDir: estado, installedRoots: [RAIZ_ARNES] });
    return r && r.block ? r.block.split('\n').find((l) => l.trim()).trim() : '';
  });
}
const MARKER = path.join(SCRIPTS, 'marker.js');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');

// T8 BigScript_GitAdd_OnlyNamesIt
// 🔴 Falla con: contar `git add` como que corre el guion que nombra. Lo que corre detrás, o una opción de git antes, sigue
//    contando.
test('T8 BigScript_GitAdd_OnlyNamesIt', () => {
  assert.strictEqual(frenoDeComando('git add scripts/marker.js'), '');
  assert.strictEqual(frenoDeComando('git add -- scripts/marker.js README.md'), '');
  assert.strictEqual(frenoDeComando('git add scripts/marker.js && ./scripts/marker.js specs/x.md'), FRENO, 'lo que corre detrás cuenta');
  assert.strictEqual(frenoDeComando('git -c alias.add=!./scripts/marker.js add scripts/marker.js'), FRENO, 'con una opción de git antes, `add` puede ser otra cosa');
});

// T9 BigScript_RunCheckOfReadOnlyList_OnlyNamesIt
// 🔴 Falla con: frenar la forma que pide el cartel de `complete-step reviewers`, o eximir de más: otro programa detrás del
//    `--`, un `marker.js` que no es el instalado, o la vuelta extra de revisores.
test('T9 BigScript_RunCheckOfReadOnlyList_OnlyNamesIt', () => {
  const lista = '--files scripts/marker.js';
  assert.strictEqual(frenoDeComando(`node ${MARKER} run-check advisors -- node ${PIPELINE} check-count ${lista}`), '');
  assert.strictEqual(frenoDeComando(`node ${MARKER} run-check advisors -- ./scripts/marker.js specs/x.md`), FRENO, 'otro programa detrás del --');
  assert.strictEqual(frenoDeComando(`node ${MARKER} run-check advisors -- node scripts/marker.js specs/x.md`), FRENO, 'otro guion detrás del --');
  assert.strictEqual(frenoDeComando(`node scripts/plantado.js run-check advisors -- node ${PIPELINE} check-count ${lista}`, { plantado: true }), FRENO, 'un marker que no es el instalado');
  // la vuelta extra con su lista ya no es un guion que corre (8.235 G): su firma la sigue pidiendo el freno de firmas
  assert.strictEqual(frenoDeComando(`node ${MARKER} run-check advisors -- node ${PIPELINE} smart-reloop --extra-round ${lista}`), '', 'la vuelta extra');
  assert.strictEqual(frenoDeComando(`node ${MARKER} run-check advisors -- node ${PIPELINE} complete-step reviewers ${lista}`), FRENO, 'un subcomando que no es de sólo lectura');
  assert.strictEqual(frenoDeComando(`node ${MARKER} run-check $PASO -- node ${PIPELINE} check-count ${lista}`), FRENO, 'un paso que no se lee');
});

// ── la vuelta extra con guiones grandes en --files ──────────────────────────────────────────────

// 8.235 T4 BashWrite_ExtraRoundConGuionesGrandesEnFiles_Pasa
// 🔴 Falla con: leer como guiones que corren los archivos de la lista de la vuelta extra, o dejar de pedir su firma.
test('8.235 T4 BashWrite_ExtraRoundConGuionesGrandesEnFiles_Pasa @story-8.235 @ac-4', () => {
  for (const cmd of [
    `node ${PIPELINE} smart-reloop --extra-round --files scripts/marker.js ${MARKER} ${PIPELINE}`,
    `node ${PIPELINE} smart-reloop --files scripts/marker.js ${MARKER} --extra-round`,
  ]) assert.strictEqual(frenoDeComando(cmd), '', cmd);
  const ow = require(path.join(SCRIPTS, '..', '..', '..', 'scripts', 'lib', 'owner-window.js'));
  assert.match(JSON.stringify(ow.firmasDelComando(`node ${PIPELINE} smart-reloop --extra-round --files scripts/marker.js ${MARKER}`)), /extra-round/, 'la firma de la vuelta extra sigue');
  // la bandera escondida (una variable, un `$(…)`) sigue sin exención
  for (const cmd of [`F=--extra-round; node ${PIPELINE} smart-reloop --files scripts/marker.js $F`, `node ${PIPELINE} smart-reloop --files scripts/marker.js $(echo --extra-round)`]) {
    assert.strictEqual(frenoDeComando(cmd), FRENO, cmd);
  }
});

// 8.235 T5 BashWrite_GuionGrandeQueCorre_FrenaComoHoy
// 🔴 Falla con: eximir un guion grande que corre porque otro comando con lista pasa.
test('8.235 T5 BashWrite_GuionGrandeQueCorre_FrenaComoHoy @story-8.235 @ac-5', () => {
  const { estado, dir } = repo('specs');
  guionGrande(dir, "ruta = 'specs/story-1.1.md'\n");
  assert.strictEqual(freno(estado, dir), FRENO);
  assert.strictEqual(frenoDeComando('node scripts/marker.js specs/x.md'), FRENO, 'el marker.js grande editado a mano, como programa que corre');
});

// 8.235 T6 BashWrite_FilesDeOtroPrograma_ComoHoy
// 🔴 Falla con: eximir por el nombre del archivo: un programa ajeno con --files, o una copia de pipeline.js fuera del arnés.
test('8.235 T6 BashWrite_FilesDeOtroPrograma_ComoHoy @story-8.235 @ac-6', () => {
  assert.strictEqual(frenoDeComando('node scripts/plantado.js smart-reloop --extra-round --files scripts/marker.js', { plantado: true }), FRENO, 'un programa ajeno con --files');
  // una copia de pipeline.js fuera del arnés: no es el instalado, por su ruta real y no por el nombre
  assert.strictEqual(frenoDeComando('node scripts/pipeline.js smart-reloop --extra-round --files scripts/marker.js', { copiaDePipeline: true }), FRENO, 'la copia de pipeline.js');
  assert.strictEqual(frenoDeComando('node scripts/pipeline.js smart-reloop --files scripts/marker.js', { copiaDePipeline: true }), FRENO, 'la copia, aun sin la vuelta extra');
});

// 8.235 T7 BashWrite_PipelineLista_SubcomandosExisten
// 🔴 Falla con: una lista de subcomandos de sólo lectura que nombra uno que pipeline.js ya no tiene.
test('8.235 T7 BashWrite_PipelineLista_SubcomandosExisten @story-8.235 @ac-7', () => {
  const lista = bash.PIPELINE_LISTA;
  assert.ok(lista && lista.size > 0, 'on-bash-write-gate.js exporta PIPELINE_LISTA');
  const texto = fs.readFileSync(PIPELINE, 'utf8');
  for (const sub of lista) assert.match(texto, new RegExp(`cmd === '${sub}'`), sub);
});
