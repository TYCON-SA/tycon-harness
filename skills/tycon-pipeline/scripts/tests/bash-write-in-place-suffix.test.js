'use strict';
// La edición en el lugar con sufijo (`sed -i.bak`, `sed -i ''`, `sed --in-place=.bak`…) sobre una historia se juzga igual
// que `sed -i` a secas: frena si cambia su estado y pasa si sólo cambia el cuerpo, como la herramienta de edición (la
// prueba `SedSoloCuerpo_Pasa` de status-by-hand.test.js). Un sed con sufijo que sólo cambia el título o el cuerpo pasa
// a propósito: no es un hueco del freno.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bash = require(path.join(__dirname, '..', 'on-bash-write-gate.js'));

const SID = 'sesion-sufijo';
const ENV = { TYCON_LEDGER_VISIBLE: undefined, TYCON_STORY_GATE: undefined, TYCON_STORY_SKILL_GATE: undefined, TYCON_NO_RUN_CHANGE: '1' };
const HISTORIA = 'HISTORIA ESCRITA POR CONSOLA';

function conEnv(vars, fn) {
  const antes = {};
  for (const k of Object.keys(vars)) { antes[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k]; }
  }
}

const raices = [];
test.after(() => { for (const r of raices) fs.rmSync(r, { recursive: true, force: true }); });

/** Un repo con una historia en curso y una corrida abierta con el plan aprobado. */
function corral() {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sed-sufijo-')));
  raices.push(raiz);
  const estado = path.join(raiz, 'estado');
  const repo = path.join(raiz, 'repo');
  const instalado = path.join(raiz, 'instalado');
  for (const d of [path.join(estado, 'active'), path.join(repo, '.git'), path.join(repo, '.tycon'), path.join(repo, 'specs'), instalado]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(repo, 'specs', 'story-9.1.md'), '---\nstory: "9.1"\nepic: "9"\ntitle: "x"\nstatus: in-progress\n---\n\n# Story 9.1\n\nTexto del cuerpo.\n');
  for (const n of ['pipeline.js', 'marker.js']) fs.writeFileSync(path.join(instalado, n), 'process.exit(0);\n');
  fs.writeFileSync(path.join(estado, 'active', `${SID}.json`), JSON.stringify({
    storyId: '9.1', repoPath: repo, storyPath: path.join(repo, 'specs', 'story-9.1.md'), sessionId: SID,
    stepsCompleted: [0, 1, 2, 3], stepsPending: [4, 5, 6, 7, 8],
  }));
  return { estado, repo, instalado, casa: raiz };
}

function juzgador({ estado, repo, instalado, casa }) {
  return (c) => conEnv({ ...ENV, HOME: casa, USERPROFILE: casa }, () => {
    const r = bash.handle({ tool_name: 'Bash', session_id: SID, cwd: repo, tool_input: { command: c } }, { stateDir: estado, installedRoots: [instalado] });
    return r && r.block ? r.block.split('\n').find((l) => l.trim()).trim() : '';
  });
}

// las seis formas con sufijo y `sed -i -e` a secas (en Mac, `-i` a secas toma la palabra siguiente como sufijo)
const FORMAS = [
  (e) => `sed -i.bak '${e}' specs/story-9.1.md`,
  (e) => `sed -i '' '${e}' specs/story-9.1.md`,
  (e) => `sed -i'' '${e}' specs/story-9.1.md`,
  (e) => `sed -i .bak '${e}' specs/story-9.1.md`,
  (e) => `sed -E -i.bak '${e}' specs/story-9.1.md`,
  (e) => `sed --in-place=.bak '${e}' specs/story-9.1.md`,
  (e) => `sed -i -e '${e}' specs/story-9.1.md`,
];

// T12 BashWriteGate_InPlaceEditWithSuffix_BlocksStory — @story-8.288 @ac-15 @ac-16 (no-regresión)
// 🔴 Falla con: que una forma con sufijo deje pasar un cambio de estado de la historia, o que frene un cambio sólo del
// cuerpo que sin sufijo pasa (la decisión de la 8.109).
test('T12 BashWriteGate_InPlaceEditWithSuffix_BlocksStory @story-8.288 @ac-15 @ac-16', () => {
  const freno = juzgador(corral());
  for (const forma of FORMAS) {
    const cambiaEstado = forma('s/^status: .*/status: done/');
    assert.match(freno(cambiaEstado), new RegExp(HISTORIA), `cambia el estado: frena — ${cambiaEstado}`);
    const soloCuerpo = forma('s/^Texto del cuerpo\\.$/Texto nuevo./');
    // fuera de BSD, `-i ''` y `-i .bak` toman esa palabra por el guion, y `-i''` se lee como `-i ''`: el freno no las da por seguras
    if (process.platform !== 'darwin' && /^sed -i( ''|''| \.bak) /.test(soloCuerpo)) assert.notStrictEqual(freno(soloCuerpo), '', `fuera de BSD: frena — ${soloCuerpo}`);
    else assert.strictEqual(freno(soloCuerpo), '', `sólo el cuerpo: pasa — ${soloCuerpo}`);
  }
  assert.strictEqual(freno("sed -n '1,5p' specs/story-9.1.md"), '', 'leer no es escribir');
});
