'use strict';
// El paso no ubicado: la lectura de la conversación no encontró el renglón del pedido que se juzga (Claude Code todavía no
// lo había escrito). Los cuatro guiones que buscan una autorización en la conversación dicen ese motivo, le piden al agente
// que reintente el mismo comando una vez sin pedirle nada a la persona y que avise si se repite; no piden la frase. Un
// pedido duplicado no es ese caso: dice su motivo, sin reintento.
//
// Los ganchos corren como los corre Claude Code: un proceso aparte, el evento por la entrada y una HOME de juguete. Cada
// caso sin el renglón espera lo que espera el lector (unos segundos).
//
// stable-data: las horas de la conversación son relativas a ahora porque el lector, en otro proceso, mide su vigencia
// contra el reloj real; ninguna aserción depende de la hora ni de un sha.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const ENCABEZADO = path.join(SCRIPTS, 'on-frontmatter-write.js');
const GUARDIAN = path.join(SCRIPTS, 'on-dod-evidence-guard.js');
const SKILL_IO = path.join(SCRIPTS, 'lib', 'story-skill-gate-io.js');
const FRENO = path.join(RAIZ, 'scripts', 'hooks', 'safety-guard-pre.sh');
const SID = 's-paso';
const TUID = 'toolu_paso';

const hace = (min) => new Date(Date.now() - min * 60000).toISOString();
const deLaPersona = (texto, min = 2) => ({ type: 'user', timestamp: hace(min), message: { role: 'user', content: texto } });
const pedido = (uuid, herramienta) => ({ type: 'assistant', timestamp: hace(0), uuid,
  message: { role: 'assistant', content: [{ type: 'tool_use', id: TUID, name: herramienta, input: {} }] } });

/** Una HOME con la conversación: `sinRenglon`, sin el pedido que se juzga; `duplicado`, con el pedido dos veces. */
function nuevaHome(caso, herramienta) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'step-not-found-'));
  const dir = path.join(home, '.claude', 'projects', '-repo');
  fs.mkdirSync(dir, { recursive: true });
  const out = [{ ...deLaPersona('seguí'), uuid: 'u-0', parentUuid: null }];
  if (caso === 'duplicado') out.push({ ...pedido('u-1', herramienta), parentUuid: 'u-0' }, { ...pedido('u-2', herramienta), parentUuid: 'u-0' });
  fs.writeFileSync(path.join(dir, `${SID}.jsonl`), out.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return home;
}

function entorno(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of Object.keys(env)) if (/^TYCON_|^CLAUDE_CODE_SESSION_ID$/.test(k)) delete env[k];
  // las bibliotecas del arnés son las de este árbol (en la HOME de juguete no hay arnés instalado)
  env.TYCON_GUIDES_DIR = RAIZ;
  return env;
}

function gancho(archivo, home, evento) {
  const r = spawnSync(process.execPath, [archivo], { input: JSON.stringify({ session_id: SID, tool_use_id: TUID, ...evento }), env: entorno(home), encoding: 'utf8' });
  return { status: r.status, texto: r.stderr || '' };
}

function historia(home, status) {
  const dir = path.join(home, 'repo', 'specs');
  fs.mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-q', path.join(home, 'repo')]);
  const f = path.join(dir, 'story-9.9-algo.md');
  fs.writeFileSync(f, `---\nepic: 9\nstory: "9.9"\ntitle: "Algo"\nstatus: ${status}\nqa_guide: off\n---\n\n# Story 9.9\n\nStatus: ${status}\n\n## Story\n\nTexto.\n`);
  return f;
}

/** Sin el renglón: el motivo real, el reintento una vez sin la persona y el aviso si se repite; ninguna frase. */
function diceElReintento(texto, que) {
  assert.match(texto, /no pude leer el registro de la conversación para este paso/i, `${que}: ${texto}`);
  assert.match(texto, /Reintentá el mismo comando una vez, sin pedirle nada a la persona/, `${que}: ${texto}`);
  assert.match(texto, /si vuelve a salir esto, decíselo/, `${que}: ${texto}`);
  assert.doesNotMatch(texto, /autorizo/i, `${que}: el cartel todavía pide la frase`);
}

/** Duplicado: su motivo, sin reintento. */
function diceElDuplicado(texto, que) {
  assert.match(texto, /hay más de un registro con este pedido/, `${que}: ${texto}`);
  assert.doesNotMatch(texto, /eintent/, `${que}: el duplicado no se reintenta`);
}

test('PasoNoUbicado_Frontmatter_DiceElMotivo @story-8.139 @ac-38 — la exención y el estado a mano, sin el renglón y con el pedido duplicado', () => {
  const exencion = (f) => ({ tool_name: 'Edit', tool_input: { file_path: f, old_string: 'qa_guide: off\n', new_string: 'dod_runtime_exempt: true\nqa_guide: off\n' } });
  const estado = (f) => ({ tool_name: 'Edit', tool_input: { file_path: f, old_string: 'status: in-progress\nqa', new_string: 'status: done\nqa' } });
  for (const [que, evento] of [['exención', exencion], ['estado a mano', estado]]) {
    const sin = nuevaHome('sinRenglon', 'Edit');
    const r = gancho(ENCABEZADO, sin, evento(historia(sin, 'in-progress')));
    assert.strictEqual(r.status, 2, `${que}: ${r.texto}`);
    diceElReintento(r.texto, que);
    const dup = nuevaHome('duplicado', 'Edit');
    const d = gancho(ENCABEZADO, dup, evento(historia(dup, 'in-progress')));
    assert.strictEqual(d.status, 2, `${que}: ${d.texto}`);
    diceElDuplicado(d.texto, que);
  }
});

test('PasoNoUbicado_EvidenciaAMano_DiceElMotivo @story-8.139 @ac-38 — el permiso de escribir la evidencia, sin el renglón y con el pedido duplicado', () => {
  for (const caso of ['sinRenglon', 'duplicado']) {
    const home = nuevaHome(caso, 'Write');
    const estado = path.join(home, '.claude', '.tycon-pipeline');
    fs.mkdirSync(estado, { recursive: true });
    fs.writeFileSync(path.join(estado, 'ALLOW_DOD_EVIDENCE_WRITE'), '');
    const r = gancho(GUARDIAN, home, { tool_name: 'Write', tool_input: { file_path: path.join(home, 'repo', '.advisors', 'dod-runtime', '9.9-20261027.md'), content: '# x' } });
    assert.strictEqual(r.status, 2, `${caso}: ${r.texto}`);
    if (caso === 'sinRenglon') diceElReintento(r.texto, caso); else diceElDuplicado(r.texto, caso);
    assert.ok(fs.existsSync(path.join(estado, 'ALLOW_DOD_EVIDENCE_WRITE')), `${caso}: el permiso no se consume`);
  }
});

test('PasoNoUbicado_SkillDeStories_DiceElMotivo @story-8.139 @ac-38 — la historia nueva sin la skill, sin el renglón y con el pedido duplicado', () => {
  const guion = `
    const sio = require(${JSON.stringify(SKILL_IO)});
    const fs = require('fs'); const path = require('path');
    const repo = path.join(process.env.HOME, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true }); fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.tycon'), { recursive: true });
    const r = sio.evaluate({ absPath: path.join(repo, 'specs', 'story-9-9.md'), content: '---\\nstory: "9.9"\\nepic: "9"\\nstatus: backlog\\n---\\n# Story 9.9\\n',
      sessionId: ${JSON.stringify(SID)}, via: 'Write', event: { session_id: ${JSON.stringify(SID)}, tool_use_id: ${JSON.stringify(TUID)}, tool_name: 'Write' },
      stateDir: path.join(process.env.HOME, 'estado') });
    process.stdout.write(JSON.stringify({ action: r.verdict.action, message: r.message || '' }));`;
  for (const caso of ['sinRenglon', 'duplicado']) {
    const home = nuevaHome(caso, 'Write');
    const p = spawnSync(process.execPath, ['-e', guion], { env: entorno(home), encoding: 'utf8' });
    assert.strictEqual(p.status, 0, p.stderr);
    const r = JSON.parse(p.stdout);
    assert.strictEqual(r.action, 'block', `${caso}: ${r.message}`);
    if (caso === 'sinRenglon') diceElReintento(r.message, caso); else diceElDuplicado(r.message, caso);
  }
});

test('PasoNoUbicado_EscC5_DiceElMotivo @story-8.139 @ac-38 — el freno de seguridad, al crear el permiso de la evidencia, sin el renglón y con el pedido duplicado', () => {
  for (const caso of ['sinRenglon', 'duplicado']) {
    const home = nuevaHome(caso, 'Bash');
    const r = spawnSync('bash', [FRENO], {
      input: JSON.stringify({ session_id: SID, tool_use_id: TUID, tool_name: 'Bash', tool_input: { command: 'touch ~/.claude/.tycon-pipeline/ALLOW_DOD_EVIDENCE_WRITE' }, cwd: home }),
      env: entorno(home), encoding: 'utf8',
    });
    assert.strictEqual(r.status, 2, `${caso}: ${r.stderr}`);
    assert.match(r.stderr, /ESC-C5/);
    if (caso === 'sinRenglon') diceElReintento(r.stderr, caso); else diceElDuplicado(r.stderr, caso);
  }
});
