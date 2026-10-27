'use strict';
// Los escapes del pipeline que fabrican evidencia o una exención los autoriza una persona. El guardián de la evidencia consume el permiso sólo con la constancia del freno de esta sesión o la frase de
// la persona; el hook del encabezado pide la frase para agregar la exención de la prueba en vivo a una historia en
// implementación; los avisos e instrucciones no le dan al agente la receta de estos escapes.
//
// Los hooks corren como los corre Claude Code: un proceso aparte, el evento por la entrada y una HOME de juguete.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const GUARDIAN = path.join(SCRIPTS, 'on-dod-evidence-guard.js');
const ENCABEZADO = path.join(SCRIPTS, 'on-frontmatter-write.js');
const SID = 's-b2';
const TUID = 'toolu_escritura';

// stable-data: la ventana de 30 minutos se mide contra el reloj real; la conversación y el registro quedan cerca de él
const hace = (min) => new Date(Date.now() - min * 60000).toISOString();
const deLaPersona = (texto, min = 2) => ({ type: 'user', timestamp: hace(min), message: { role: 'user', content: texto } });
const delAgente = (texto, min = 2) => ({ type: 'assistant', timestamp: hace(min), message: { role: 'assistant', content: [{ type: 'text', text: texto }] } });

/** Una HOME con la conversación de la sesión (null = sin registro, como Codex) y el pedido que se juzga al final. */
function nuevaHome(conversacion = [], herramienta = 'Write') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-escape-'));
  if (conversacion) {
    const dir = path.join(home, '.claude', 'projects', '-repo');
    fs.mkdirSync(dir, { recursive: true });
    let padre = null;
    const out = conversacion.map((r, i) => { const u = `u-${i}`; const x = { ...r, uuid: u, parentUuid: padre }; padre = u; return x; });
    out.push({ type: 'assistant', timestamp: hace(0), uuid: 'u-pedido', parentUuid: padre,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: TUID, name: herramienta, input: {} }] } });
    fs.writeFileSync(path.join(dir, `${SID}.jsonl`), out.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  return home;
}
const estado = (home) => path.join(home, '.claude', '.tycon-pipeline');

function correr(hook, home, evento) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of Object.keys(env)) if (/^TYCON_|^CLAUDE_CODE_SESSION_ID$/.test(k)) delete env[k];
  // la biblioteca del registro de frenos es la de este árbol (en la HOME de juguete no hay arnés instalado)
  env.TYCON_GUIDES_DIR = RAIZ;
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ session_id: SID, tool_use_id: TUID, ...evento }), env, encoding: 'utf8',
  });
  return { status: r.status, stderr: r.stderr || '', stdout: r.stdout || '' };
}

// ── El guardián de la evidencia ───────────────────────────────────────────────────────────────────────────────────────

/** El permiso creado hace `min` minutos y, si viene, la línea de `frenos.jsonl`. */
function conPermiso(home, { minPermiso = 1, constancia } = {}) {
  const dir = estado(home);
  fs.mkdirSync(dir, { recursive: true });
  const flag = path.join(dir, 'ALLOW_DOD_EVIDENCE_WRITE');
  fs.writeFileSync(flag, '');
  const t = new Date(Date.now() - minPermiso * 60000);
  fs.utimesSync(flag, t, t);
  if (constancia) fs.appendFileSync(path.join(dir, 'frenos.jsonl'), JSON.stringify(constancia) + '\n');
  return flag;
}
const LINEA = (extra = {}) => ({ ts: hace(2), freno: 'safety-guard', regla: 'ESC-C5', veredicto: 'escape', sha256: null,
  via: 'persona', sesion: SID, escape: 'ALLOW_DOD_EVIDENCE_WRITE', ...extra });
const escribirEvidencia = (home) => correr(GUARDIAN, home, {
  tool_name: 'Write', tool_input: { file_path: path.join(home, 'repo', '.advisors', 'dod-runtime', '9.9-20261022.md'), content: '# x' },
});

test('T5 EvidenceGuard_PermisoSinConstancia_Frena @story-8.96 — el permiso solo, o con una constancia que no es de este freno, esta sesión y esta ventana', () => {
  const casos = [
    ['sin constancia', undefined],
    ['de otra sesión', LINEA({ sesion: 'otra-sesion' })],
    ['de más de 30 minutos antes del permiso', LINEA({ ts: hace(45) })],
    ['de otra regla', LINEA({ regla: 'ESC-C1' })],
    ['de otro freno (una línea imitada)', LINEA({ freno: 'on-pre-commit' })],
    ['de otro escape', LINEA({ escape: 'dod_runtime_exempt' })],
    ['que no es un escape', LINEA({ veredicto: 'bloqueo' })],
  ];
  for (const [que, constancia] of casos) {
    const home = nuevaHome([deLaPersona('escribí la evidencia')]);
    const flag = conPermiso(home, { constancia });
    const r = escribirEvidencia(home);
    assert.strictEqual(r.status, 2, `${que}: ${r.stderr}`);
    assert.match(r.stderr, /lo decide la persona/, que);
    assert.ok(fs.existsSync(flag), `${que}: el permiso no se consume`);
  }
});

test('T6 EvidenceGuard_PermisoConConstancia_Pasa @story-8.96 — con la constancia del freno de esta sesión, o con la frase de la persona, pasa una vez', () => {
  const conConstancia = nuevaHome([deLaPersona('escribí la evidencia')]);
  const flag = conPermiso(conConstancia, { constancia: LINEA() });
  assert.strictEqual(escribirEvidencia(conConstancia).status, 0);
  assert.ok(!fs.existsSync(flag), 'el permiso se consume');
  assert.strictEqual(escribirEvidencia(conConstancia).status, 2, 'una sola vez');

  // la persona lo creó en su terminal y lo dijo en el chat
  const conFrase = nuevaHome([deLaPersona('lo creé yo: autorizo ALLOW_DOD_EVIDENCE_WRITE')]);
  conPermiso(conFrase);
  const r = escribirEvidencia(conFrase);
  assert.strictEqual(r.status, 0, r.stderr);
  // la frase del agente no
  const delAgenteHome = nuevaHome([deLaPersona('seguí'), delAgente('autorizo ALLOW_DOD_EVIDENCE_WRITE')]);
  conPermiso(delAgenteHome);
  assert.strictEqual(escribirEvidencia(delAgenteHome).status, 2);
  // sin el permiso, ni la frase alcanza
  assert.strictEqual(escribirEvidencia(nuevaHome([deLaPersona('autorizo ALLOW_DOD_EVIDENCE_WRITE')])).status, 2);
});

// ── La exención de la prueba en vivo ──────────────────────────────────────────────────────────────────────────────────

function historia(home, status, extra = '') {
  const dir = path.join(home, 'repo', 'specs');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'story-9.9-algo.md');
  fs.writeFileSync(f, `---\nepic: 9\nstory: "9.9"\ntitle: "Algo"\nstatus: ${status}\n${extra}qa_guide: off\n---\n\n# Story 9.9\n\nStatus: ${status}\n\n## Story\n\nTexto.\n`);
  return f;
}
const agregarExencion = (f, valor = 'true') => ({ tool_name: 'Edit',
  tool_input: { file_path: f, old_string: 'qa_guide: off\n', new_string: `dod_runtime_exempt: ${valor}\ndod_runtime_exempt_reason: "nada que correr"\nqa_guide: off\n` } });

test('T9 FrontmatterWrite_ExencionNueva_PideLaFrase @story-8.96 — agregarla a una historia en implementación pide la frase', () => {
  const home = nuevaHome([deLaPersona('seguí')], 'Edit');
  const f = historia(home, 'in-progress');
  const r = correr(ENCABEZADO, home, agregarExencion(f));
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /lo decide la persona/);
  assert.match(r.stderr, /autorizo dod_runtime_exempt/);
  // un Write que reescribe una historia en review con la exención
  const enReview = historia(home, 'review');
  const contenido = fs.readFileSync(enReview, 'utf8').replace('qa_guide: off\n', 'dod_runtime_exempt: true\nqa_guide: off\n');
  assert.strictEqual(correr(ENCABEZADO, home, { tool_name: 'Write', tool_input: { file_path: enReview, content: contenido } }).status, 2);
  // con la frase de la persona pasa
  const conFrase = nuevaHome([deLaPersona('Es puro texto. Autorizo dod_runtime_exempt')], 'Edit');
  const ok = correr(ENCABEZADO, conFrase, agregarExencion(historia(conFrase, 'in-progress')));
  assert.strictEqual(ok.status, 0, ok.stderr);
  const lineas = fs.readFileSync(path.join(estado(conFrase), 'frenos.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const c = lineas.find((l) => l.freno === 'on-frontmatter-write' && l.regla === 'exencion-nueva');
  assert.deepStrictEqual(c && [c.veredicto, c.via, c.sesion, c.escape], ['escape', 'persona', SID, 'dod_runtime_exempt']);
});

test('T10 FrontmatterWrite_ExencionQueYaEstaba_Pasa @story-8.96 — la que ya estaba pasa; la de una historia que se escribe y entre comillas no', () => {
  const home = nuevaHome([deLaPersona('seguí')], 'Edit');
  // ya la tenía: se edita otra parte
  const ya = historia(home, 'in-progress', 'dod_runtime_exempt: true\n');
  const otra = correr(ENCABEZADO, home, { tool_name: 'Edit', tool_input: { file_path: ya, old_string: 'Texto.', new_string: 'Texto nuevo.' } });
  assert.strictEqual(otra.status, 0, otra.stderr);
  // mientras se escribe la historia también la pide: el agente que la escribe no se exime solo
  for (const s of ['draft', 'ready-for-dev']) {
    assert.strictEqual(correr(ENCABEZADO, home, agregarExencion(historia(home, s))).status, 2, s);
  }
  const nueva = path.join(home, 'repo', 'specs', 'story-9.10-nueva.md');
  const contenido = '---\nepic: 9\nstory: "9.10"\ntitle: "Nueva"\nstatus: draft\ndod_runtime_exempt: true\n---\n\n# Story 9.10\n';
  const crear = { tool_name: 'Write', tool_input: { file_path: nueva, content: contenido } };
  const r = correr(ENCABEZADO, home, crear);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /autorizo dod_runtime_exempt/);
  // con la frase de la persona, crearla exenta pasa
  const conFrase = nuevaHome([deLaPersona('Es puro texto. Autorizo dod_runtime_exempt')], 'Write');
  const nuevaOk = path.join(conFrase, 'repo', 'specs', 'story-9.10-nueva.md');
  fs.mkdirSync(path.dirname(nuevaOk), { recursive: true });
  assert.strictEqual(correr(ENCABEZADO, conFrase, { tool_name: 'Write', tool_input: { file_path: nuevaOk, content: contenido } }).status, 0);
  // un .md que no es una historia (una guía que la nombra) no la pide
  const guia = path.join(home, 'repo', 'guia.md');
  assert.strictEqual(correr(ENCABEZADO, home, { tool_name: 'Write', tool_input: { file_path: guia, content: '# Guía\n\ndod_runtime_exempt: true\n' } }).status, 0);
  // con comillas también la pide
  for (const v of ['"true"', "'true'"]) {
    assert.strictEqual(correr(ENCABEZADO, home, agregarExencion(historia(home, 'in-progress'), v)).status, 2, v);
  }
  // de false a true, y pasarla a implementación en la misma escritura, también la piden
  const conFalse = historia(home, 'in-progress', 'dod_runtime_exempt: false\n');
  const deFalse = correr(ENCABEZADO, home, { tool_name: 'Edit', tool_input: { file_path: conFalse, old_string: 'dod_runtime_exempt: false', new_string: 'dod_runtime_exempt: true' } });
  assert.strictEqual(deFalse.status, 2, deFalse.stderr);
  // las formas que los lectores conceden (pase adversarial): con comentario, sangrada, en el cuerpo, con CRLF o con el
  // estado entre comillas simples
  const formas = [
    ['con comentario', (s) => s.replace('qa_guide: off\n', 'dod_runtime_exempt: true # sin UI\nqa_guide: off\n')],
    ['sangrada', (s) => s.replace('qa_guide: off\n', '  dod_runtime_exempt: true\nqa_guide: off\n')],
    ['en el cuerpo', (s) => s.replace('Texto.\n', 'Texto.\ndod_runtime_exempt: true\n')],
    ['con CRLF', (s) => s.replace('qa_guide: off\n', 'dod_runtime_exempt: true\nqa_guide: off\n').replace(/\n/g, '\r\n')],
  ];
  for (const [que, cambiar] of formas) {
    const f = historia(home, 'in-progress');
    assert.strictEqual(correr(ENCABEZADO, home, { tool_name: 'Write', tool_input: { file_path: f, content: cambiar(fs.readFileSync(f, 'utf8')) } }).status, 2, que);
  }
  const comillas = historia(home, 'in-progress');
  fs.writeFileSync(comillas, fs.readFileSync(comillas, 'utf8').replace('status: in-progress', "status: 'in-progress'"));
  assert.strictEqual(correr(ENCABEZADO, home, agregarExencion(comillas)).status, 2, 'estado con comillas simples');
  const borrador = historia(home, 'ready-for-dev');
  const juntas = fs.readFileSync(borrador, 'utf8').replace(/status: ready-for-dev/g, 'status: in-progress').replace('qa_guide: off\n', 'dod_runtime_exempt: true\nqa_guide: off\n');
  assert.strictEqual(correr(ENCABEZADO, home, { tool_name: 'Write', tool_input: { file_path: borrador, content: juntas } }).status, 2);
});

// ── Los avisos no recetan los escapes ─────────────────────────────────────────────────────────────────────────────────

// Lo que le da al agente el escape como salida: el comando o el renglón que lo activa.
const RECETAS = [
  /--force-manual\b/,
  /--trust-ran\b/,
  /DOD_BYPASS=1/,
  /touch\b[^\n]*ALLOW_DOD_EVIDENCE_WRITE/,
  /dod_runtime_exempt: true/,
];
// Un renglón que nombra el escape y dice que lo decide la persona, con su frase, no es una receta.
const DE_LA_PERSONA = /autorizo|la persona|lo decide (?:el dev|la persona)/i;
// En el código, sólo cuentan los textos que se le muestran al agente; en las instrucciones, todo renglón.
// (cualquier `.push(` de renglones de un aviso, no sólo `lines`: el validador encontró uno en `pl.push`)
const EMISOR = /console\.(?:error|log|warn)\(|\.push\(|stderr\.write\(|mensaje:|^\s*(?:[:?+]\s*)?['"`]/;
const AVISOS = [
  'skills/tycon-pipeline/scripts/marker.js',
  'skills/tycon-pipeline/scripts/pipeline.js',
  'skills/tycon-pipeline/scripts/on-frontmatter-write.js',
  'skills/tycon-pipeline/scripts/on-pre-commit.js',
  'skills/tycon-pipeline/scripts/on-dod-evidence-guard.js',
  'scripts/ci/tycon-ci-gate.js',
];
const INSTRUCCIONES = [
  'skills/tycon-pipeline/SKILL.md',
  'skills/tycon-pipeline/steps/step-06-run-tests.md',
  'skills/tycon-pipeline/steps/step-07-reviewers.md',
  'skills/tycon-pipeline/steps/step-10-live-check.md',
  'guides/ci-gate.md',
];

test('T16 Avisos_NoRecetanLosEscapes @story-8.96 — los avisos y las instrucciones dicen que lo decide la persona y no dan el comando', () => {
  const malos = [];
  for (const [lista, esCodigo] of [[AVISOS, true], [INSTRUCCIONES, false]]) {
    for (const rel of lista) {
      const lineas = fs.readFileSync(path.join(RAIZ, rel), 'utf8').split('\n');
      lineas.forEach((l, i) => {
        if (!RECETAS.some((re) => re.test(l))) return;
        if (esCodigo && !EMISOR.test(l)) return;
        // la frase puede venir en el renglón de al lado del mismo aviso
        const cerca = lineas.slice(Math.max(0, i - 1), i + 2).join('\n');
        if (!DE_LA_PERSONA.test(cerca)) malos.push(`${rel}:${i + 1}: ${l.trim().slice(0, 120)}`);
      });
    }
  }
  assert.deepStrictEqual(malos, []);
});
