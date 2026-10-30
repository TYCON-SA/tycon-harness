'use strict';
// Los escapes del pipeline que fabrican evidencia o una exención los autoriza una persona, con la firma de la ventana
// sobre ese archivo (`marker.js sign-file`). Sin ella, el guardián de la evidencia no consume el permiso y el hook del
// encabezado frena la exención de la prueba en vivo; la frase en la conversación ya no firma. Los avisos e
// instrucciones no le dan al agente la receta de estos escapes.
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

// el permiso lo consume sólo la firma de la ventana sobre ese archivo (`marker.js sign-file`, en la casa de la cuenta:
// la prueba en proceso es SignFile_ConLaVentana_ElArchivoPasa de owner-window.test.js). La línea del freno y la frase no.
test('T6 EvidenceGuard_ConstanciaViejaOFrase_YaNoPasa @story-8.96 @story-8.139 — ni la línea del freno de esta sesión ni la frase de la persona consumen el permiso', () => {
  const conConstancia = nuevaHome([deLaPersona('escribí la evidencia')]);
  const flag = conPermiso(conConstancia, { constancia: LINEA() });
  const r = escribirEvidencia(conConstancia);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /marker\.js sign-file ALLOW_DOD_EVIDENCE_WRITE/);
  assert.ok(fs.existsSync(flag), 'el permiso no se consume');

  const conFrase = nuevaHome([deLaPersona('lo creé yo: autorizo ALLOW_DOD_EVIDENCE_WRITE')]);
  const flagFrase = conPermiso(conFrase);
  assert.strictEqual(escribirEvidencia(conFrase).status, 2, 'la frase de la persona no firma');
  assert.ok(fs.existsSync(flagFrase), 'con la frase, el permiso tampoco se consume');
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
  assert.match(r.stderr, /marker\.js sign-file dod_runtime_exempt /);
  // un Write que reescribe una historia en review con la exención
  const enReview = historia(home, 'review');
  const contenido = fs.readFileSync(enReview, 'utf8').replace('qa_guide: off\n', 'dod_runtime_exempt: true\nqa_guide: off\n');
  assert.strictEqual(correr(ENCABEZADO, home, { tool_name: 'Write', tool_input: { file_path: enReview, content: contenido } }).status, 2);
  // con la frase de la persona no pasa, y no queda como escape
  const conFrase = nuevaHome([deLaPersona('Es puro texto. Autorizo dod_runtime_exempt')], 'Edit');
  const no = correr(ENCABEZADO, conFrase, agregarExencion(historia(conFrase, 'in-progress')));
  assert.strictEqual(no.status, 2, no.stderr);
  const registro = path.join(estado(conFrase), 'frenos.jsonl');
  const lineas = fs.existsSync(registro) ? fs.readFileSync(registro, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  assert.ok(!lineas.some((l) => l.freno === 'on-frontmatter-write' && l.veredicto === 'escape'), 'la frase no deja un escape');
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
  assert.match(r.stderr, /marker\.js sign-file dod_runtime_exempt /);
  // con la frase de la persona, crearla exenta no pasa
  const conFrase = nuevaHome([deLaPersona('Es puro texto. Autorizo dod_runtime_exempt')], 'Write');
  const nuevaNo = path.join(conFrase, 'repo', 'specs', 'story-9.10-nueva.md');
  fs.mkdirSync(path.dirname(nuevaNo), { recursive: true });
  assert.strictEqual(correr(ENCABEZADO, conFrase, { tool_name: 'Write', tool_input: { file_path: nuevaNo, content: contenido } }).status, 2);
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

// ── La coordinadora corre el guion de firma para otra sesión ──────────────────────────────────────────────────────────
//
// El guion de verdad, por subproceso, con una HOME de juguete. El pedido lo arma `decidir` de verdad, con el evento de
// la sesión que pide (ses-coord); el guion lo verifica de verdad, con el árbol de procesos que dice la prueba
// (window-passed.js con `arbol`): nada se da por pasado.

const { execFileSync } = require('child_process');
const ow = require(path.join(RAIZ, 'scripts', 'lib', 'owner-window.js'));
const DS = require(path.join(RAIZ, 'scripts', 'lib', 'delegated-signing.js'));
const { conVentana, arbolDelFreno, arbolDelGuion } = require(path.join(RAIZ, 'scripts', 'tests', 'lib', 'window-passed.js'));
const MARKER = path.join(SCRIPTS, 'marker.js');
const COORD = 'ses-coord';
const DESTINO = 'ses-a';
// stable-data: el registro del pedido se escribe con esta hora y el guion lo verifica un minuto después
const AHORA = Date.now();
const HUELLA = 'a1b2c3d4e5f60718';
const PERFIL = { delegated_signing: ['plan-approval'], owner_only: [], delegated_machines: [{ id: HUELLA, label: 'Mac de prueba' }] };

const comillas = (a) => (/[\s"]/.test(a) ? `"${a}"` : a);

/** El repo con dos stories, la HOME de juguete y las corridas de ses-a (9.91, en «Aprobar el plan») y de ses-coord (9.92). */
function laboratorioOtraSesion(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'otra-sesion-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(home);
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  const historia = (n) => {
    const f = path.join(repo, 'specs', `story-${n}-juguete.md`);
    fs.writeFileSync(f, ['---', `story: "${n}"`, 'title: "juguete"', 'status: in-progress', 'files_to_modify:', '  - README.md', '---', '', `# Story ${n}`, ''].join('\n'));
    return f;
  };
  const stories = { [DESTINO]: historia('9.91'), [COORD]: historia('9.92') };
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_LANE_LLM: '0', TYCON_PROFILE: '0' };
  for (const k of ['TYCON_HOME', 'CLAUDE_CODE_SESSION_ID', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'NODE_OPTIONS']) delete env[k];
  const estadoDir = path.join(home, '.claude', '.tycon-pipeline');
  const lab = { base, repo, home, env, estadoDir, stories };
  /** marker.js como lo corre `sid`; `ventana` = las opciones de window-passed.js (sin ellas, sin ventana). */
  lab.marker = (sid, args, ventana) => spawnSync(process.execPath, [MARKER, ...args], { cwd: repo, encoding: 'utf8',
    env: ventana ? conVentana({ ...env, CLAUDE_CODE_SESSION_ID: sid }, ventana) : { ...env, CLAUDE_CODE_SESSION_ID: sid } });
  lab.marcador = (sid) => path.join(estadoDir, 'active', `${sid}.json`);
  lab.leer = (sid) => { try { return fs.readFileSync(lab.marcador(sid), 'utf8'); } catch (_) { return null; } };
  for (const [sid, storyId] of [[DESTINO, '9.91'], [COORD, '9.92']]) {
    const set = lab.marker(sid, ['set', JSON.stringify({ storyId, storyPath: stories[sid], repoPath: repo })]);
    assert.strictEqual(set.status, 0, set.stderr);
    for (const n of ['0', '1', '2']) lab.marker(sid, ['complete-step', n], {});
  }
  /** El pedido de la ventana, como lo arma el freno ante el comando de ses-coord. */
  lab.pedir = (cmd, { delegacion = () => ({ ok: false, motivo: 'sin delegación en la prueba' }) } = {}) => ow.decidir({
    evento: { session_id: COORD, tool_use_id: 'toolu_01', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd } },
    escapes: [], arbol: arbolDelFreno(), pid: 201, casa: home, ahora: AHORA, delegacion, clasificar: () => null });
  /** El guion que corre ses-coord con la ventana aprobada (el árbol del comando); `sesionEn`: su variable de sesión al salir. */
  lab.correr = (args) => {
    const cmd = `node ${MARKER} ${args.map(comillas).join(' ')}`;
    const sesionEn = path.join(base, `sesion-${Math.random().toString(36).slice(2)}`);
    const r = lab.marker(COORD, args, { arbol: { arbol: arbolDelGuion(home, cmd), pid: 301, ahora: AHORA + 60000 }, sesionEn });
    let sesion = null;
    try { sesion = fs.readFileSync(sesionEn, 'utf8'); } catch (_) { sesion = null; }
    return { ...r, cmd, sesion };
  };
  lab.comando = (args) => `node ${MARKER} ${args.map(comillas).join(' ')}`;
  lab.vigentes = () => { try { return fs.readdirSync(ow.carpeta(home)).filter((f) => f.endsWith('.json')); } catch (_) { return []; } };
  lab.gates = () => { try { return fs.readFileSync(path.join(estadoDir, 'gates.log'), 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch (_) { return []; } };
  lab.aprobaciones = (sid) => {
    const runDir = require(path.join(SCRIPTS, 'pipeline.js')).resolveRunDir(repo, sid === DESTINO ? '9.91' : '9.92', false, stories[sid]);
    try { return fs.readFileSync(path.join(runDir, 'approvals.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch (_) { return []; }
  };
  return lab;
}

const APROBAR = ['complete-step', 'approve-plan', '--for-session', DESTINO, '--approved', 'dale, seguí'];
const EXIMIR = ['waive-critical', '--rule', 'SEC-C1', '--reason', 'lo cubre otra capa', '--for-session', DESTINO];

test('Guion_ForSession_EscribeElMarcadorDestino (T5) @story-8.142 @ac-2 @ac-3', (t) => {
  const lab = laboratorioOtraSesion(t);
  const deCoord = lab.leer(COORD);
  // el plan de ses-a, aprobado en la ventana de ses-coord
  assert.strictEqual(lab.pedir(lab.comando(APROBAR)).decision, 'ask');
  let r = lab.correr(APROBAR);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const destino = JSON.parse(lab.leer(DESTINO));
  assert.strictEqual(destino.planApproval.via, 'ventana');
  assert.strictEqual(destino.planApproval.por, COORD, 'la constancia dice quién la pidió');
  assert.ok((destino.stepsCompleted || []).some((s) => String(s) === 'approve-plan' || String(s) === '3'), 'el paso quedó completo en ses-a');
  assert.strictEqual(lab.leer(COORD), deCoord, 'el marcador de ses-coord quedó igual byte a byte');
  assert.strictEqual(r.sesion, DESTINO, 'después de la firma la variable de sesión del proceso dice ses-a');
  const firmado = lab.gates().filter((g) => g.name === 'plan-approval-signed');
  assert.strictEqual(firmado.length, 1);
  assert.deepStrictEqual([firmado[0].sesion, firmado[0].destino, firmado[0].via], [COORD, DESTINO, 'ventana']);
  // la exención de un crítico de ses-a: la aprobación queda en la corrida de ses-a, con quién la pidió
  assert.strictEqual(lab.pedir(lab.comando(EXIMIR)).decision, 'ask');
  r = lab.correr(EXIMIR);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const exencion = lab.aprobaciones(DESTINO).find((l) => /exencion SEC-C1/.test(l.que));
  assert.ok(exencion, 'la exención quedó en la corrida de ses-a');
  assert.strictEqual(exencion.por, COORD);
  assert.ok(!lab.aprobaciones(COORD).some((l) => /exencion/.test(l.que)), 'nada en la corrida de ses-coord');
  assert.strictEqual(lab.leer(COORD), deCoord);
  assert.strictEqual(r.sesion, DESTINO);
});

test('Guion_ForSession_DestinoSinMarcador_Sale2 (T6) @story-8.142 @ac-2', (t) => {
  const lab = laboratorioOtraSesion(t);
  const antes = { [DESTINO]: lab.leer(DESTINO), [COORD]: lab.leer(COORD) };
  // una sesión sin marcador abierto: sale 2 antes de la firma, sin gastar el registro
  const sinMarcador = ['complete-step', 'approve-plan', '--for-session', 'ses-z', '--approved', 'dale'];
  assert.strictEqual(lab.pedir(lab.comando(sinMarcador)).decision, 'ask');
  let r = lab.correr(sinMarcador);
  assert.strictEqual(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /ses-z/);
  assert.strictEqual(lab.vigentes().length, 1, 'el registro sigue sin gastar');
  assert.strictEqual(lab.leer('ses-z'), null, 'no creó el marcador de ses-z');
  // un subcomando que no es una firma, para otra sesión
  r = lab.correr(['set-check', 'dod', 'green', '--manual', '--for-session', DESTINO]);
  assert.strictEqual(r.status, 2, `${r.stdout}${r.stderr}`);
  // la salida de una ejecución perdida nombra otra sesión que la de --for-session: la ventana no la pide, y el guion
  // sale 2
  const ajena = ['clear-session', 'ses-x', '--lost', '--for-session', DESTINO];
  assert.strictEqual(lab.pedir(lab.comando(ajena)).decision, 'deny');
  r = lab.correr(ajena);
  assert.strictEqual(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.strictEqual(lab.vigentes().length, 1, 'ningún registro gastado ni pedido');
  // sin variable de sesión y sin --terminal: sale 2 sin pasar por la firma
  r = lab.marker('', APROBAR, {});
  assert.strictEqual(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /--terminal/);
  // sin variable de sesión, con --terminal: un subcomando que no es firma no escribe el marcador nombrado, y la salida
  // de una ejecución perdida tiene que nombrar esa misma sesión
  r = lab.marker('', ['set-check', 'dod', 'green', '--manual', '--terminal', '--for-session', DESTINO], {});
  assert.strictEqual(r.status, 2, `${r.stdout}${r.stderr}`);
  r = lab.marker('', ['clear-session', 'ses-x', '--lost', '--terminal', '--for-session', DESTINO], {});
  assert.strictEqual(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /ses-x/);
  // un marcador que no se puede leer no es «sin ejecución abierta»
  fs.writeFileSync(lab.marcador('ses-rota'), '{ no es json');
  const rota = ['complete-step', 'approve-plan', '--for-session', 'ses-rota', '--approved', 'dale'];
  assert.strictEqual(lab.pedir(lab.comando(rota)).decision, 'ask');
  r = lab.correr(rota);
  assert.strictEqual(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /no pude leer/);
  assert.strictEqual(lab.vigentes().length, 2, 'ningún registro gastado');
  // el plan con la regla de riesgo bajo no pide firma: para otra sesión sale 2 sin anotar nada en su corrida
  const aprobacionesAntes = lab.aprobaciones(DESTINO).length;
  const gatesAntes = lab.gates().length;
  r = lab.correr(['complete-step', 'approve-plan', '--auto-approved', 'riesgo bajo', '--for-session', DESTINO]);
  assert.strictEqual(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /no es una firma que se pida/);
  assert.strictEqual(lab.aprobaciones(DESTINO).length, aprobacionesAntes, 'ninguna aprobación en la corrida de ses-a');
  assert.strictEqual(lab.gates().length, gatesAntes, 'ningún renglón en gates.log');
  assert.deepStrictEqual({ [DESTINO]: lab.leer(DESTINO), [COORD]: lab.leer(COORD) }, antes, 'nada escrito');
  assert.ok(!lab.gates().some((g) => /-signed$/.test(g.name)), 'nada firmado');
  // el plan con el número del marcador viejo es la misma firma que reconoce el freno: el guion no lo rechaza por eso
  const viejo = ['complete-step', '3', '--for-session', DESTINO, '--approved', 'dale'];
  assert.deepStrictEqual(ow.firmasDelComando(lab.comando(viejo)), ['plan-approval']);
  r = lab.correr(viejo);
  assert.doesNotMatch(r.stderr, /no es una firma que se pida/);
});

test('Guion_ForSession_EjecucionPerdida_DiceQuienPidio (T5) @story-8.142 @ac-3', (t) => {
  // la apertura de la ejecución de ses-a en el registro, como la deja el arranque del pipeline
  const abrir = (lab) => require(path.join(SCRIPTS, 'lib', 'open-runs.js')).abrir({ sid: DESTINO, story: '9.91', storyPath: lab.stories[DESTINO], repo: lab.repo,
    runDir: JSON.parse(lab.leer(DESTINO)).runDir || path.join(lab.repo, '.advisors', 'pipeline-runs', '9.91-juguete'), home: lab.home });
  // cerrar como perdida la ejecución de ses-a, pedido desde ses-coord: el cierre dice que lo pidió ses-coord
  let lab = laboratorioOtraSesion(t);
  abrir(lab);
  const perdida = ['clear-session', DESTINO, '--lost', '--for-session', DESTINO];
  assert.strictEqual(lab.pedir(lab.comando(perdida)).decision, 'ask');
  let r = lab.correr(perdida);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  let cierre = lab.gates().filter((g) => g.name === 'run-close' && g.sesion === DESTINO).pop();
  assert.ok(cierre, 'quedó el cierre de la ejecución de ses-a');
  assert.strictEqual(cierre.por, COORD);
  assert.match(cierre.motivo, new RegExp(COORD));
  // rearmarla: el marcador de ses-a y el cierre dicen quién lo pidió
  lab = laboratorioOtraSesion(t);
  abrir(lab);
  const rearmar = ['restore', DESTINO, '--for-session', DESTINO];
  assert.strictEqual(lab.pedir(lab.comando(rearmar)).decision, 'ask');
  r = lab.correr(rearmar);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.strictEqual(JSON.parse(lab.leer(DESTINO)).por, COORD);
  // cada cierre que deja el rearmado (la perdida y, si la había, la propia reemplazada) dice quién lo pidió
  const cierres = lab.gates().filter((g) => g.name === 'run-close' && g.sesion === DESTINO);
  assert.ok(cierres.length >= 1);
  for (const c of cierres) assert.strictEqual(c.por, COORD, c.motivo);
});

test('Guion_ForSession_SalidaDeOtraSesion_PorDelegacionYSinFirma', (t) => {
  const abrir = (lab) => require(path.join(SCRIPTS, 'lib', 'open-runs.js')).abrir({ sid: DESTINO, story: '9.91', storyPath: lab.stories[DESTINO], repo: lab.repo,
    runDir: JSON.parse(lab.leer(DESTINO)).runDir || path.join(lab.repo, '.advisors', 'pipeline-runs', '9.91-juguete'), home: lab.home });
  const designar = (lab) => {
    const d = { name: 'relay-designation', status: 'ok', ts: new Date(AHORA - 3600000).toISOString(), sesion: COORD, rol: 'coordinadora', quien: 'dueño', cita: 'Esta sesión es la coordinadora' };
    fs.appendFileSync(path.join(lab.estadoDir, 'gates.log'), `${[d, DS.confirmationRecord(d, new Date(AHORA - 3500000).toISOString())].map((l) => JSON.stringify(l)).join('\n')}\n`);
  };
  const delegacion = (perfil) => (o) => DS.delegaSinVentana({ ...o, perfil: () => perfil, huella: () => ({ huella: HUELLA }) });
  const DELEGA = { ...PERFIL, delegated_signing: ['lost-run'] };
  // la ejecución perdida de ses-a, cerrada o rearmada desde la designada: con lost-run delegada, sin ventana
  for (const args of [['clear-session', DESTINO, '--lost', '--for-session', DESTINO], ['restore', DESTINO, '--for-session', DESTINO]]) {
    const lab = laboratorioOtraSesion(t);
    designar(lab);
    abrir(lab);
    const p = lab.pedir(lab.comando(args), { delegacion: delegacion(DELEGA) });
    assert.strictEqual(p.decision, 'allow', `${args[0]}: ${p.texto}`);
    const r = lab.correr(args);
    assert.strictEqual(r.status, 0, `${args[0]}: ${r.stdout}${r.stderr}`);
    const firmada = lab.gates().filter((g) => g.name === 'lost-run-signed');
    assert.strictEqual(firmada.length, 1, args[0]);
    assert.deepStrictEqual([firmada[0].sesion, firmada[0].destino, firmada[0].via], [COORD, DESTINO, 'delegacion'], args[0]);
    assert.ok(lab.gates().some((g) => g.name === 'run-close' && g.sesion === DESTINO && g.por === COORD), `${args[0]}: el cierre dice quién lo pidió`);
    // sin lost-run en el perfil, la misma salida pide la ventana del dueño
    const otro = laboratorioOtraSesion(t);
    designar(otro);
    abrir(otro);
    const q = otro.pedir(otro.comando(args), { delegacion: delegacion(PERFIL) });
    assert.strictEqual(q.decision, 'ask', `${args[0]} sin delegar`);
    assert.match(q.texto, new RegExp(`sesión ${DESTINO}`));
  }
  // la ejecución vieja que no está perdida (el marcador está): la designada la cierra sin firma, y el cierre lo dice
  const lab = laboratorioOtraSesion(t);
  const r = lab.marker(COORD, ['clear-session', DESTINO]);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.strictEqual(lab.leer(DESTINO), null, 'el marcador de ses-a ya no está');
  assert.strictEqual(lab.pedir(lab.comando(['clear-session', DESTINO])).decision, 'none', 'no es una firma');
  // `clear` es de la propia sesión: para otra sesión sale 2 y nombra el comando que sí la cierra
  const otra = laboratorioOtraSesion(t);
  const antes = otra.leer(DESTINO);
  const c = otra.marker(COORD, ['clear', '--for-session', DESTINO]);
  assert.strictEqual(c.status, 2, `${c.stdout}${c.stderr}`);
  assert.match(c.stderr, new RegExp(`clear-session ${DESTINO}`));
  assert.strictEqual(otra.leer(DESTINO), antes, 'no tocó el marcador de ses-a');
});

test('Guion_ForSession_Delegada_SeisLlaves (T7) @story-8.142 @ac-4', (t) => {
  const designar = (lab, { sesion = COORD, confirmada = true } = {}) => {
    const d = { name: 'relay-designation', status: 'ok', ts: new Date(AHORA - 3600000).toISOString(), sesion, rol: 'coordinadora', quien: 'dueño', cita: 'Esta sesión es la coordinadora' };
    const lineas = [d, ...(confirmada ? [DS.confirmationRecord(d, new Date(AHORA - 3500000).toISOString())] : [])];
    fs.appendFileSync(path.join(lab.estadoDir, 'gates.log'), `${lineas.map((l) => JSON.stringify(l)).join('\n')}\n`);
  };
  const delegacion = ({ perfil = PERFIL, huella = HUELLA } = {}) => (o) => DS.delegaSinVentana({ ...o, perfil: () => perfil, huella: () => ({ huella }) });
  // con las seis llaves el freno no pide ventana; el plan, además, sólo con el «aprobado» de la revisión automática que
  // lanzó la coordinadora: sin ella sale 2 y el pedido no se gasta
  let lab = laboratorioOtraSesion(t);
  designar(lab);
  const p = lab.pedir(lab.comando(APROBAR), { delegacion: delegacion() });
  assert.strictEqual(p.decision, 'allow', p.texto);
  let r = lab.correr(APROBAR);
  assert.strictEqual(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /revisión automática/);
  assert.strictEqual(lab.vigentes().length, 1, 'el pedido sigue sin gastar');
  const PR = require(path.join(SCRIPTS, 'lib', 'plan-review.js'));
  const runDir = require(path.join(SCRIPTS, 'pipeline.js')).resolveRunDir(lab.repo, '9.91', true, lab.stories[DESTINO]);
  fs.writeFileSync(path.join(runDir, 'step-02-bmad-plan.md'), '1. Cambiar el README.\n');
  assert.strictEqual(PR.preparar({ lanza: COORD, destino: DESTINO, estado: lab.estadoDir, home: lab.home, delegacion: delegacion() }).codigo, 0);
  PR.anotar({ lanza: COORD, destino: DESTINO, estado: lab.estadoDir, resultado: { modo: 'plan', medido: true, confirmed: [], hallazgos_sin_veredicto: 0, a_verificar_aparte: 0, lentes_sin_medir: [] } });
  r = lab.correr(APROBAR);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const destino = JSON.parse(lab.leer(DESTINO));
  assert.strictEqual(destino.planApproval.via, 'revision');
  assert.strictEqual(destino.planApproval.por, COORD);
  // sin cada llave, por vez: pide la ventana y el registro no dice delegación
  const sinUna = [
    ['la designada es otra sesión', { sesion: 'ses-otra' }, {}],
    ['la designación sin confirmar', { confirmada: false }, {}],
    ['la máquina fuera de la lista', {}, { huella: 'ffffffffffffffff' }],
    ['el perfil no la delega', {}, { perfil: { ...PERFIL, delegated_signing: [] } }],
    ['la firma es sólo del dueño', {}, { perfil: { ...PERFIL, owner_only: ['plan-approval'] } }],
  ];
  for (const [que, designacion, llaves] of sinUna) {
    lab = laboratorioOtraSesion(t);
    designar(lab, designacion);
    const q = lab.pedir(lab.comando(APROBAR), { delegacion: delegacion(llaves) });
    assert.strictEqual(q.decision, 'ask', que);
    const reg = JSON.parse(fs.readFileSync(path.join(ow.carpeta(lab.home), lab.vigentes()[0]), 'utf8'));
    assert.notStrictEqual(reg.via, 'delegacion', que);
  }
  // la misma story en las dos sesiones: no se delega
  lab = laboratorioOtraSesion(t);
  designar(lab);
  const misma = JSON.parse(lab.leer(COORD));
  fs.writeFileSync(lab.marcador(COORD), JSON.stringify({ ...misma, storyId: '9.91', storyPath: lab.stories[DESTINO] }));
  assert.strictEqual(lab.pedir(lab.comando(APROBAR), { delegacion: delegacion() }).decision, 'ask', 'la misma story');
});

test('Guion_ForSession_OtraCorridaEnElMedio_Sale2 (T16) @story-8.142 @ac-2', (t) => {
  const lab = laboratorioOtraSesion(t);
  assert.strictEqual(lab.pedir(lab.comando(APROBAR)).decision, 'ask');
  const reg = JSON.parse(fs.readFileSync(path.join(ow.carpeta(lab.home), lab.vigentes()[0]), 'utf8'));
  assert.strictEqual(reg.corrida && reg.corrida.storyId, '9.91', 'el registro guarda la corrida que vio el dueño');
  // ses-a pasa a otra story antes de que corra el guion
  const m = JSON.parse(lab.leer(DESTINO));
  fs.writeFileSync(lab.marcador(DESTINO), JSON.stringify({ ...m, storyId: '9.93' }, null, 2));
  const antes = lab.leer(DESTINO);
  const r = lab.correr(APROBAR);
  assert.strictEqual(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /9\.93|otra corrida|cambi/);
  assert.strictEqual(lab.leer(DESTINO), antes, 'no escribió el marcador de ses-a');
});

// ── Las tres firmas que la coordinadora pide para otra sesión ─────────────────────────────────────────────────────────

const PIPELINE = path.join(SCRIPTS, 'pipeline.js');

/** `guion` (marker.js o pipeline.js) como lo corre ses-coord con la ventana aprobada, sobre el pedido que armó `decidir`. */
function correrGuion(lab, guion, args, sid = COORD) {
  const cmd = `node ${guion} ${args.map(comillas).join(' ')}`;
  const sesionEn = path.join(lab.base, `sesion-${Math.random().toString(36).slice(2)}`);
  const r = spawnSync(process.execPath, [guion, ...args], { cwd: lab.repo, encoding: 'utf8',
    env: conVentana({ ...lab.env, CLAUDE_CODE_SESSION_ID: sid }, { arbol: { arbol: arbolDelGuion(lab.home, cmd), pid: 301, ahora: AHORA + 60000 }, sesionEn }) });
  return { ...r, cmd };
}
const comandoDe = (guion, args) => `node ${guion} ${args.map(comillas).join(' ')}`;
const pedirDe = (lab, guion, args, sid = COORD) => ow.decidir({
  evento: { session_id: sid, tool_use_id: 'toolu_01', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: comandoDe(guion, args) }, cwd: lab.repo },
  escapes: [], arbol: arbolDelFreno(), pid: 201, casa: lab.home, ahora: AHORA, delegacion: () => ({ ok: false, motivo: 'sin delegación en la prueba' }), clasificar: () => null });

test('ForceManual_Canonica_PideFirma (T8) @story-8.142 @ac-5 @ac-8', (t) => {
  const lab = laboratorioOtraSesion(t);
  const deCoord = lab.leer(COORD);
  const paraD = ['set-check', 'dod', 'green', '--force-manual', '--for-session', DESTINO];
  // la forma canónica la pide la ventana: no la niega como «una firma y un escape»
  const p = lab.pedir(lab.comando(paraD));
  assert.strictEqual(p.decision, 'ask', p.texto);
  assert.deepStrictEqual(p.firmas, ['escape:force-manual']);
  assert.match(p.texto, new RegExp(DESTINO));
  // sin la ventana no escribe, tampoco en la propia sesión
  let r = lab.marker(COORD, ['set-check', 'tests', 'red:x', '--force-manual']);
  assert.notStrictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.strictEqual(lab.leer(COORD), deCoord, 'sin firma no se escribe el marcador propio');
  // con la ventana, el control queda declarado a mano en el marcador de ses-a, y el de ses-coord igual
  r = correrGuion(lab, MARKER, paraD);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const d = JSON.parse(lab.leer(DESTINO));
  assert.deepStrictEqual([d.checks.dod, d.checksProvenance.dod], ['green', 'manual-forced']);
  assert.strictEqual(lab.leer(COORD), deCoord, 'el marcador de ses-coord quedó igual byte a byte');
  const firmado = lab.gates().filter((g) => g.name === 'escape:force-manual-signed');
  assert.deepStrictEqual(firmado.map((g) => [g.sesion, g.destino]), [[COORD, DESTINO]]);
  // en la propia sesión, con cualquier estado
  const propio = ['set-check', 'tests', 'red:x', '--force-manual'];
  assert.strictEqual(lab.pedir(lab.comando(propio)).decision, 'ask');
  r = correrGuion(lab, MARKER, propio);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const c = JSON.parse(lab.leer(COORD));
  assert.deepStrictEqual([c.checks.tests, c.checksProvenance.tests], ['red:x', 'manual-forced']);
  // otra sesión sin ejecución abierta: sale 2 sin gastar el registro
  const sinMarcador = ['set-check', 'dod', 'green', '--force-manual', '--for-session', 'ses-z'];
  assert.strictEqual(lab.pedir(lab.comando(sinMarcador)).decision, 'ask');
  r = correrGuion(lab, MARKER, sinMarcador);
  assert.strictEqual(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /ses-z/);
  assert.strictEqual(lab.vigentes().length, 1, 'el registro sigue sin gastar');
  // la propia sesión sin ejecución abierta: sale 2 (no 0 callado) y no firma
  r = correrGuion(lab, MARKER, ['set-check', 'dod', 'green', '--force-manual'], 'ses-sin');
  assert.strictEqual(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /ejecución abierta/);
  assert.strictEqual(lab.leer('ses-sin'), null);
  // --manual sigue como siempre: sin firma
  r = lab.marker(COORD, ['set-check', 'build', 'green', '--manual']);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
});

/** El registro de revisores de `sid`: la vuelta que abrió `advisors`, sin ningún revisor lanzado. */
function vueltaSinRevisores(lab, sid) {
  const dir = path.join(lab.estadoDir, 'advisor-runs');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${sid}.jsonl`), `${JSON.stringify({ ts: new Date(AHORA - 120000).toISOString(), event: 'step5-start', expected: ['rev-a'] })}\n`);
}

test('TrustRan_Canonica_PideFirma (T9) @story-8.142 @ac-6 @ac-8', (t) => {
  const lab = laboratorioOtraSesion(t);
  vueltaSinRevisores(lab, DESTINO);
  const contar = (extra) => ['check-count', '--repo', lab.repo, '--story', lab.stories[DESTINO], '--ran', 'rev-a', ...extra];
  const paraD = contar(['--trust-ran', '--for-session', DESTINO]);
  const p = pedirDe(lab, PIPELINE, paraD);
  assert.strictEqual(p.decision, 'ask', p.texto);
  assert.deepStrictEqual(p.firmas, ['escape:trust-ran']);
  // sin la ventana no cuenta
  let r = spawnSync(process.execPath, [PIPELINE, ...contar(['--trust-ran'])], { cwd: lab.repo, encoding: 'utf8', env: { ...lab.env, CLAUDE_CODE_SESSION_ID: DESTINO } });
  assert.notStrictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.doesNotMatch(r.stdout, /check-count OK/);
  // con la ventana, cuenta con el registro de revisores de ses-a (ses-coord no tiene ninguno)
  r = correrGuion(lab, PIPELINE, paraD);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /check-count OK/);
  assert.match(r.stdout, /no registró spawns/, 'contó con la vuelta de ses-a');
  assert.ok(lab.gates().some((g) => g.name === 'escape:trust-ran-signed' && g.sesion === COORD && g.destino === DESTINO));
  assert.strictEqual(lab.vigentes().length, 0, 'el pedido se gastó');
  // los casos que salen 2 antes de la firma, sin contar ni gastar el registro
  const antes = lab.vigentes().length;
  for (const [que, args] of [
    ['sesión sin marcador', contar(['--trust-ran', '--for-session', 'ses-z'])],
    ['--story de otra historia', ['check-count', '--repo', lab.repo, '--story', lab.stories[COORD], '--ran', 'rev-a', '--trust-ran', '--for-session', DESTINO]],
    ['--for-session sin --trust-ran', contar(['--for-session', DESTINO])],
  ]) {
    pedirDe(lab, PIPELINE, args);
    r = correrGuion(lab, PIPELINE, args);
    assert.strictEqual(r.status, 2, `${que}: ${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stdout, /check-count OK/, que);
  }
  assert.strictEqual(lab.vigentes().length, antes + 2, "ningún registro gastado: los dos pedidos siguen");
  assert.strictEqual(lab.gates().filter((g) => g.name === 'escape:trust-ran-signed').length, 1, 'ninguna firma nueva');
  // la corrida de ses-a cambia entre el pedido y el guion: sale 2 sin contar
  const otra = laboratorioOtraSesion(t);
  vueltaSinRevisores(otra, DESTINO);
  const args = ['check-count', '--repo', otra.repo, '--story', otra.stories[DESTINO], '--ran', 'rev-a', '--trust-ran', '--for-session', DESTINO];
  assert.strictEqual(pedirDe(otra, PIPELINE, args).decision, 'ask');
  const m = JSON.parse(otra.leer(DESTINO));
  fs.writeFileSync(otra.marcador(DESTINO), JSON.stringify({ ...m, startedAt: new Date(AHORA + 1000).toISOString() }));
  r = correrGuion(otra, PIPELINE, args);
  assert.strictEqual(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.doesNotMatch(r.stdout, /check-count OK/);
});

/** La historia de ses-a con un criterio declarado imposible de probar en vivo, cuya prueba corrió en verde. */
function conCriterio(lab) {
  fs.writeFileSync(lab.stories[DESTINO], ['---', 'story: "9.91"', 'title: "juguete"', 'status: in-progress', 'files_to_modify:', '  - README.md',
    'runtime_not_verifiable:', '  - ac: 1', '    reason: "el servicio externo no tiene ambiente de prueba"', '    covered_by: T1', '---', '', '# Story 9.91', '',
    '## Acceptance Criteria', '', '1. **Given** un pedido **Then** el aviso queda en el servicio externo.', '',
    '### Tests', '', '| # | Test | AC | Nivel | Escenario | Resultado esperado |', '|---|---|---|---|---|---|', '| T1 | `Aviso_QuedaRegistrado` | 1 | unit | x | y |', ''].join('\n'));
  fs.mkdirSync(path.join(lab.repo, '.advisors'), { recursive: true });
  fs.writeFileSync(path.join(lab.repo, '.advisors', 'tests-result.json'), JSON.stringify({ ts: new Date().toISOString(), story_id: '9.91', suite_green: true }));
  lab.env.TYCON_WAIVER_LOG = path.join(lab.base, 'home-waivers.jsonl');
}

test('RuntimeWaiver_ForSession_HistoriaDelDestino (T11) @story-8.142 @ac-7', (t) => {
  const lab = laboratorioOtraSesion(t);
  conCriterio(lab);
  const wd = require(path.join(SCRIPTS, 'lib', 'waiver-display.js'));
  const paraD = ['runtime-waiver', lab.stories[DESTINO], '--acs', '1', '--for-session', DESTINO];
  // la muestra de criterios es la de ses-a: una registrada para ses-coord no vale
  const { sha } = wd.criteriosDe(lab.stories[DESTINO], [1]).lista[0];
  fs.appendFileSync(path.join(lab.estadoDir, 'gates.log'), `${JSON.stringify({ ts: new Date().toISOString(), sessionId: COORD, name: 'ac-shown', status: 'ok', story: '9.91', ac: 1, sha })}\n`);
  const muestra = wd.paraMostrar({ command: lab.comando(paraD), sessionId: COORD, stateDir: lab.estadoDir });
  assert.ok(muestra && /AC 1/.test(muestra.systemMessage), 'se muestra el criterio de ses-a');
  muestra.anotar();
  const anotada = lab.gates().filter((g) => g.name === 'ac-shown').pop();
  assert.strictEqual(anotada.sessionId, DESTINO);
  assert.strictEqual(wd.paraMostrar({ command: lab.comando(paraD), sessionId: COORD, stateDir: lab.estadoDir }), null, 'ya mostrado para ses-a');
  // el cartel trae los criterios de la historia de ses-a, y el guion la firma sobre su corrida
  const p = lab.pedir(lab.comando(paraD));
  assert.strictEqual(p.decision, 'ask', p.texto);
  assert.match(p.texto, /AC 1: Given un pedido/);
  let r = lab.correr(paraD);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok(lab.aprobaciones(DESTINO).some((l) => /AC 1 imposible/.test(l.que)), 'la aprobación quedó en la corrida de ses-a');
  assert.ok(!lab.aprobaciones(COORD).some((l) => /AC 1 imposible/.test(l.que)));
  // la historia de ses-coord pedida para ses-a: el cartel la niega y el guion sale 2
  const ajena = ['runtime-waiver', lab.stories[COORD], '--acs', '1', '--for-session', DESTINO];
  assert.strictEqual(lab.pedir(lab.comando(ajena)).decision, 'deny');
  r = lab.correr(ajena);
  assert.strictEqual(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /no es la historia de la corrida/);
});

test('OtraSesion_SinSesion_NoEsDestino (T21) @story-8.142 @ac-5 @ac-6', (t) => {
  const lab = laboratorioOtraSesion(t);
  // un marcador guardado bajo el nombre de «sin sesión», con su corrida
  fs.writeFileSync(lab.marcador('_nosession'), lab.leer(DESTINO));
  vueltaSinRevisores(lab, '_nosession');
  const antes = lab.leer('_nosession');
  const fm = ['set-check', 'dod', 'green', '--force-manual', '--for-session', '_nosession'];
  const p = lab.pedir(lab.comando(fm));
  assert.strictEqual(p.decision, 'deny', p.texto);
  assert.match(p.texto, /sin sesión/);
  let r = correrGuion(lab, MARKER, fm);
  assert.strictEqual(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /sin sesión/);
  assert.strictEqual(lab.leer('_nosession'), antes, 'no escribió el marcador');
  const cc = ['check-count', '--repo', lab.repo, '--story', lab.stories[DESTINO], '--ran', 'rev-a', '--trust-ran', '--for-session', '_nosession'];
  assert.strictEqual(pedirDe(lab, PIPELINE, cc).decision, 'deny');
  r = correrGuion(lab, PIPELINE, cc);
  assert.notStrictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.doesNotMatch(r.stdout, /check-count OK/);
  // los dos pasos de la ventana que leen el destino tampoco lo toman como sesión
  const ex = ow.exigir({ firma: 'escape:force-manual', argv: ['marker.js', ...fm], propia: COORD, casa: lab.home });
  assert.strictEqual(ex.codigo, 1);
  assert.match(ex.motivo, /sin sesión/);
  assert.strictEqual(ow.fijarDestino({ r: { destino: '_nosession', via: 'ventana' }, casa: lab.home }).codigo, 2);
  assert.strictEqual(lab.gates().filter((g) => /-signed$/.test(g.name)).length, 0, 'ninguna firma');
});

test('OtraSesion_HistoriaDelDestino_PorSuRepoYSuArchivo (T22) @story-8.142 @ac-6 @ac-7', (t) => {
  const lab = laboratorioOtraSesion(t);
  conCriterio(lab);
  const wd = require(path.join(SCRIPTS, 'lib', 'waiver-display.js'));
  // la ruta relativa se lee desde el repo de la sesión destino, no desde la carpeta de quien pide
  const relativa = path.relative(lab.repo, lab.stories[DESTINO]);
  const paraD = ['runtime-waiver', relativa, '--acs', '1', '--for-session', DESTINO];
  const muestra = wd.paraMostrar({ command: lab.comando(paraD), sessionId: COORD, stateDir: lab.estadoDir });
  assert.ok(muestra && /AC 1/.test(muestra.systemMessage), 'se muestra el criterio de ses-a');
  muestra.anotar();
  assert.notStrictEqual(path.resolve(relativa), lab.stories[DESTINO], 'la prueba corre fuera del repo de ses-a');
  const p = lab.pedir(lab.comando(paraD));
  assert.strictEqual(p.decision, 'ask', p.texto);
  assert.match(p.texto, /AC 1: Given un pedido/);
  // check-count: otra historia con el mismo número, en otro archivo, no es la de la corrida
  vueltaSinRevisores(lab, DESTINO);
  const copia = path.join(lab.repo, 'specs', 'story-9.91-copia.md');
  fs.writeFileSync(copia, fs.readFileSync(lab.stories[DESTINO], 'utf8'));
  const cc = ['check-count', '--repo', lab.repo, '--story', copia, '--ran', 'rev-a', '--trust-ran', '--for-session', DESTINO];
  pedirDe(lab, PIPELINE, cc);
  const r = correrGuion(lab, PIPELINE, cc);
  assert.strictEqual(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout + r.stderr, /no es el archivo de la historia de la corrida/);
  assert.strictEqual(lab.gates().filter((g) => g.name === 'escape:trust-ran-signed').length, 0, 'ninguna firma');
});
