'use strict';
/**
 * approval-lab.js — el laboratorio de las aprobaciones del plan y de la maqueta sin persona y con ella.
 *
 * Una HOME de juguete con un repo de dos historias (la de ses-a con pantalla, delicada si se pide, en «Aprobar el plan»
 * con su plan escrito; otra de ses-coord), ses-coord designada y confirmada, su revisión del plan aprobada y la
 * maqueta armada. El freno corre en proceso (`decidir`, el de la copia del arnés) y después el guion por subproceso, con
 * la verificación del registro que dejó el freno (window-passed.js, `arbol`). El perfil va en la raíz de la copia del
 * arnés, el único lugar de donde salen las listas de firmas: con `plan-approval` y `plan-approval:delicada`, como el
 * perfil que hacía trámite un plan delicado. El «aprobado» del dueño es el de verdad: la transcripción de la pestaña de la
 * coordinadora con la pregunta del freno y el renglón que deja su gancho.
 *
 * Lo usan delegated-approval-person.test.js y mockup-approval-person.test.js.
 *
 *   laboratorio(t, { delicada })  → lab: pedir(args), aprobado(dijo), pregunta(args), leer(), foto(), aprobaciones()
 *   aprobadoPorTramite(lab)       → el plan y la maqueta de una rutina aprobados como firma de trámite
 *
 * stable-data: las horas son las de la corrida de la prueba; ninguna se compara con una fecha fija.
 */
// sin el perfil del equipo en este proceso: el de la prueba va en la copia del arnés
require('../../../../../scripts/tests/lib/without-team-profile.js');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

for (const k of ['TYCON_HOME', 'CLAUDE_CODE_SESSION_ID', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'NODE_OPTIONS', 'CI', 'TF_BUILD', 'GITHUB_ACTIONS']) delete process.env[k];

const SCRIPTS = path.resolve(__dirname, '..', '..');
const RAIZ = path.resolve(SCRIPTS, '..', '..', '..');
const { harnessCopy } = require('../../../../../scripts/tests/lib/harness-copy.js');
const { conVentana, arbolDelFreno, arbolDelGuion } = require(path.join(RAIZ, 'scripts', 'tests', 'lib', 'window-passed.js'));

const COORD = 'ses-coord';
const DESTINO = 'ses-a';
const HUELLA = 'a1b2c3d4e5f60718';
// las listas del perfil que dio el caso: el plan, y el plan de una historia delicada, como trámite y delegados
const PERFIL = { approvals: { relay_session: 'coordinadora', delegated_signing: ['plan-approval', 'plan-approval:delicada'],
  owner_only: ['adversarial-skip'], delegated_machines: [{ id: HUELLA, label: 'Mac de prueba' }] } };

const COPIA = harnessCopy();
fs.writeFileSync(path.join(COPIA, 'team-profile.json'), JSON.stringify(PERFIL, null, 2));
const COPIA_SCRIPTS = path.join(COPIA, 'skills', 'tycon-pipeline', 'scripts');
const MARKER = path.join(COPIA_SCRIPTS, 'marker.js');
const MOCKUP = path.join(COPIA_SCRIPTS, 'mockup.js');
const PIPELINE = path.join(COPIA_SCRIPTS, 'pipeline.js');
// el freno y su delegación, los de la copia: leen el perfil de la prueba
const OW = require(path.join(COPIA, 'scripts', 'lib', 'owner-window.js'));
const DSC = require(path.join(COPIA, 'scripts', 'lib', 'delegated-signing.js'));
const OA = require(path.join(COPIA, 'scripts', 'lib', 'owner-approvals.js'));
const PR = require(path.join(COPIA_SCRIPTS, 'lib', 'plan-review.js'));

const AHORA = Date.now();
const PLAN = '# Plan\n\n## Qué hace\n\nMuestra la lista de facturas con las que faltan pagar.\n\n## Archivos\n\n- src/components/Facturas.tsx\n\n## Pasos\n\n'
  + '1. Armar la lista de facturas en el componente.\n2. Sumar la prueba de la lista.\n';
const APROBADO = { modo: 'plan', medido: true, confirmed: [], hallazgos_sin_veredicto: 0, a_verificar_aparte: 0, lentes_sin_medir: [] };
// la hora del paso «Aprobar el plan»: por su nombre en un marcador nuevo, por su número en uno viejo (el de `set`)
const pasoDelPlan = (m) => (m && m.stepTimings ? m.stepTimings['approve-plan'] || m.stepTimings['3'] || null : null);
const comillas = (a) => (/[\s"]/.test(a) ? `"${a}"` : a);

/**
 * El laboratorio: un repo con la historia de ses-a (con pantalla; delicada si `delicada`), en «Aprobar el plan» con su
 * plan escrito, y otra de ses-coord; ses-coord designada y confirmada, su revisión del plan aprobada y la
 * maqueta armada.
 */
function laboratorio(t, { delicada = false } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aprobacion-persona-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src', 'components'), { recursive: true });
  fs.mkdirSync(home);
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 'lab@example.invalid'); git('config', 'user.name', 'lab');
  const historia = (n, extra, archivos) => {
    const f = path.join(repo, 'specs', `story-${n}-juguete.md`);
    fs.writeFileSync(f, ['---', 'epic: 9', `story: "${n}"`, 'title: "La lista de facturas"', 'status: in-progress', ...extra,
      'files_to_modify:', ...archivos.map((a) => `  - ${a}`), '---', '', `# Story ${n}`, '',
      '## Acceptance Criteria', '', '1. **Given** un cliente con facturas **When** abre la lista **Then** ve cuántas le faltan pagar.', '',
      '### Tests', '', '| # | Test | AC | Nivel | Escenario | Resultado esperado |', '|---|---|---|---|---|---|',
      '| T1 | `ListaDeFacturas_MuestraPendientes` | 1 | e2e | x | y |', ''].join('\n'));
    return f;
  };
  const stories = { [DESTINO]: historia('9.91', delicada ? ['sensible: seguridad'] : [], ['src/components/Facturas.tsx']), [COORD]: historia('9.92', [], ['README.md']) };
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
  fs.writeFileSync(path.join(repo, 'src', 'components', 'Facturas.tsx'), 'export const Facturas = () => null;\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_LANE_LLM: '0' };
  const estado = path.join(home, '.claude', '.tycon-pipeline');
  const lab = { base, repo, home, env, estado, stories, n: 0 };
  lab.marker = (sid, args, ventana) => spawnSync(process.execPath, [MARKER, ...args], { cwd: repo, encoding: 'utf8',
    env: ventana ? conVentana({ ...env, CLAUDE_CODE_SESSION_ID: sid }, ventana) : { ...env, CLAUDE_CODE_SESSION_ID: sid } });
  lab.leer = (sid = DESTINO) => { try { return JSON.parse(fs.readFileSync(path.join(estado, 'active', `${sid}.json`), 'utf8')); } catch (_) { return null; } };
  const set = (sid, storyId) => {
    const r = lab.marker(sid, ['set', JSON.stringify({ storyId, storyPath: stories[sid], repoPath: repo })]);
    assert.strictEqual(r.status, 0, r.stderr);
  };
  set(DESTINO, '9.91');
  for (const n of ['0', '1', '2']) lab.marker(DESTINO, ['complete-step', n], {});
  set(COORD, '9.92');
  lab.runDir = require(PIPELINE).resolveRunDir(repo, '9.91', true, stories[DESTINO]);
  fs.writeFileSync(path.join(lab.runDir, 'step-02-bmad-plan.md'), PLAN);
  const d = { name: 'relay-designation', status: 'ok', ts: new Date(AHORA - 3600e3).toISOString(), sesion: COORD, rol: 'coordinadora', quien: 'dueño', cita: 'Esta sesión es la coordinadora' };
  fs.appendFileSync(path.join(estado, 'gates.log'), `${JSON.stringify(d)}\n${JSON.stringify(DSC.confirmationRecord(d, new Date(AHORA - 3500e3).toISOString()))}\n`);
  assert.strictEqual(require(PIPELINE).computeDelicate({ story: stories[DESTINO], repo, planText: PLAN }).value, delicada, 'la historia de la prueba es como se pidió');
  // la revisión del plan que lanza la coordinadora, aprobada
  const delegacion = (o) => DSC.delegaSinVentana({ ...o, huella: () => ({ huella: HUELLA }) });
  const p = PR.preparar({ lanza: COORD, destino: DESTINO, estado, home, delegacion });
  assert.strictEqual(p.codigo, 0, p.motivo);
  PR.anotar({ lanza: COORD, destino: DESTINO, estado, resultado: { pedido: p.args.pedido, ...APROBADO }, modelo: 'opus', proveedor: 'anthropic' });
  const modelo = path.join(base, 'modelo.json');
  fs.writeFileSync(modelo, JSON.stringify({ storyId: '9.91', title: 'La lista de facturas', screens: [{ name: 'Lista de facturas', state: 'con facturas',
    file: 'src/components/Facturas.tsx', elements: [{ kind: 'heading', text: 'Facturas' }, { kind: 'text', text: 'Tiene 3 facturas sin pagar.' }, { kind: 'button', text: 'Pagar', primary: true }] }] }));
  const rm = spawnSync(process.execPath, [MOCKUP, 'render', '--data', modelo, '--story', stories[DESTINO]], { cwd: repo, encoding: 'utf8', env });
  assert.strictEqual(rm.status, 0, rm.stderr);
  lab.maqueta = path.join(repo, 'specs', 'qa', '9.91-mockup.html');
  lab.comando = (args) => `node ${MARKER} ${args.map(comillas).join(' ')}`;
  lab.pregunta = (args) => OW.cuadroPara({ firma: 'plan-approval', comando: lab.comando(args), palabras: OW.canonica(lab.comando(args)), destino: DESTINO, cwd: repo, casa: home, sesion: COORD }).pregunta;
  /** El freno ante el comando que corre ses-coord y, si lo deja, el guion de verdad. `{ freno, r }`. */
  lab.pedir = (args) => {
    const k = ++lab.n;
    const ahora = AHORA + k * 1000;
    const cmd = lab.comando(args);
    const freno = OW.decidir({ evento: { session_id: COORD, tool_use_id: `toolu_${k}`, hook_event_name: 'PreToolUse', tool_name: 'Bash', permission_mode: 'default', cwd: repo, tool_input: { command: cmd } },
      escapes: [], arbol: arbolDelFreno(), pid: 201, casa: home, ahora, clasificar: () => null, delegacion, huellaDeLaMaquina: () => ({ huella: HUELLA }) });
    const r = freno.decision === 'allow' ? lab.marker(COORD, args, { arbol: { arbol: arbolDelGuion(home, cmd), pid: 301, ahora: ahora + 60000 } }) : null;
    return { freno, r };
  };
  /** El «aprobado» que tipea el dueño en la pestaña de ses-coord, después de que el agente le mostró `dijo`. */
  lab.aprobado = (dijo) => {
    // después del último pedido y antes del próximo: cada «aprobado» es un renglón distinto del gancho
    const ts = new Date(AHORA + lab.n * 1000 + 500).toISOString();
    const dir = path.join(home, '.claude', 'projects', '-r-proyecto');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${COORD}.jsonl`), `${[
      { type: 'assistant', timestamp: new Date(AHORA + lab.n * 1000 + 100).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: dijo }] } },
      { type: 'user', timestamp: ts, message: { role: 'user', content: 'aprobado' }, origin: { kind: 'human' }, promptSource: 'typed', entrypoint: 'cli' },
    ].map((r) => JSON.stringify(r)).join('\n')}\n`);
    const h = arbolDelFreno().find((x) => OW.esHerramienta(x));
    OA.anotar(home, { tipo: 'mensaje', sesion: COORD, ts, texto: 'aprobado', herramienta: { pid: h.pid, inicio: h.inicio } });
  };
  lab.aprobaciones = () => { try { return fs.readFileSync(path.join(lab.runDir, 'approvals.jsonl'), 'utf8'); } catch (_) { return ''; } };
  /** Lo que queda escrito de las aprobaciones: el marcador, el registro de la corrida y el archivo de la maqueta. */
  lab.foto = () => {
    const m = lab.leer() || {};
    let archivo = null;
    try { archivo = fs.readFileSync(path.join(repo, 'specs', 'qa', '9.91-mockup-approval.json'), 'utf8'); } catch (_) { archivo = null; }
    return JSON.stringify({ plan: m.planApproval || null, maqueta: m.mockupApproval || null, pasos: pasoDelPlan(m), aprobaciones: lab.aprobaciones(), archivo });
  };
  return lab;
}

const salida = (x) => `${x.freno.decision} ${x.freno.via || ''} ${x.freno.texto || ''}\n${x.r ? `${x.r.stdout}${x.r.stderr}` : '(el guion no corrió)'}`;
// el comando del caso: la coordinadora aprueba el plan y la maqueta «por la revisión», con --mockup-approved sin cita
const DEL_CASO = ['complete-step', 'approve-plan', '--approved', 'revisión', '--mockup-approved', '--for-session', DESTINO];
const POR_LA_REVISION = ['complete-step', 'approve-plan', '--approved', 'revisión', '--mockup-approved', 'la coordinadora vio la maqueta', '--for-session', DESTINO];

/** El plan y la maqueta de una historia de rutina con pantalla, aprobados como firma de trámite: lo que se reemplaza. */
function aprobadoPorTramite(lab) {
  const x = lab.pedir(POR_LA_REVISION);
  assert.deepStrictEqual([x.freno.decision, x.freno.via], ['allow', 'automatica'], salida(x));
  assert.strictEqual(x.r.status, 0, salida(x));
  const m = lab.leer();
  assert.strictEqual(m.planApproval.via, 'delegacion', 'el plan quedó por delegación');
  return m;
}

module.exports = { laboratorio, aprobadoPorTramite, salida, pasoDelPlan, DEL_CASO, POR_LA_REVISION, PLAN, COORD, DESTINO, PR };
