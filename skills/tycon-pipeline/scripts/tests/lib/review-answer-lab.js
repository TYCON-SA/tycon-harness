'use strict';
/**
 * review-answer-lab.js — el laboratorio de la respuesta a la pregunta de revisar el plan, con el dueño y sin él.
 *
 * Una HOME de juguete con un repo de dos historias: la de ses-a con su plan escrito y tres vueltas de la revisión del plan
 * rechazadas (la próxima la decide una persona), y otra de ses-coord. ses-coord designada y confirmada, y la pregunta de
 * ses-a anotada (`review-ask --kind plan`). El freno corre en proceso (`decidir`, el de la copia del arnés) y después el
 * guion por subproceso, con la verificación del registro que dejó el freno (window-passed.js, `arbol`). El perfil va en la
 * raíz de la copia del arnés, el único lugar de donde salen las listas de firmas. El click del dueño es el de verdad: la
 * transcripción de la pestaña donde se dio, con el cuadro del freno contestado, y el renglón que deja su gancho.
 *
 * Lo usan plan-review-answer-owner.test.js y review-answer-owner-click.test.js.
 *
 *   laboratorio(t)  → lab: comando(args), freno(sid, args), pedir(sid, args), click(args, { pestana }), cuadro(args),
 *                     respuestas(), abiertas(), accion(), correr(sid, args, ventana), cambio()
 *   SKIP, WAIT, REVIEW → la respuesta al plan; SKIP_CODIGO, WAIT_CODIGO, REVIEW_CODIGO → al código (la sesión anota
 *                     antes las dos preguntas: la del plan al armar el laboratorio y la del código con `preguntarCodigo`)
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
const FIRMA = 'plan-review-answer';
const FIRMA_CODIGO = 'code-review-answer';
// la firma de la respuesta: la del código si el pedido nombra `--kind code`, si no la del plan
const firmaDe = (args) => (args[args.indexOf('--kind') + 1] === 'code' ? FIRMA_CODIGO : FIRMA);
// el perfil de la prueba: delega el plan, como el de una coordinadora que firma la rutina
const PERFIL = { approvals: { relay_session: 'coordinadora', delegated_signing: ['plan-approval'], owner_only: [], delegated_machines: [{ id: HUELLA, label: 'Mac de prueba' }] } };

const COPIA = harnessCopy();
fs.writeFileSync(path.join(COPIA, 'team-profile.json'), JSON.stringify(PERFIL, null, 2));
const COPIA_SCRIPTS = path.join(COPIA, 'skills', 'tycon-pipeline', 'scripts');
const MARKER = path.join(COPIA_SCRIPTS, 'marker.js');
const PIPELINE = path.join(COPIA_SCRIPTS, 'pipeline.js');
// el freno y su delegación, los de la copia: leen el perfil de la prueba
const OW = require(path.join(COPIA, 'scripts', 'lib', 'owner-window.js'));
const DSC = require(path.join(COPIA, 'scripts', 'lib', 'delegated-signing.js'));
const OA = require(path.join(COPIA, 'scripts', 'lib', 'owner-approvals.js'));
const PR = require(path.join(COPIA_SCRIPTS, 'lib', 'plan-review.js'));
const POL = require(path.join(COPIA_SCRIPTS, 'lib', 'review-policy.js'));

const AHORA = Date.now();
const PLAN = '# Plan\n\n## Qué hace\n\nCambia el título del README.\n\n## Archivos\n\n- README.md\n\n## Pasos\n\n1. Tocar el README.md.\n';
const RECHAZADO = { modo: 'plan', medido: true, confirmed: [{ id: 'h1', severity: 'bug', lens: 'suposicion-falsa', title: 'falta un paso' }], hallazgos_sin_veredicto: 0, a_verificar_aparte: 0, lentes_sin_medir: [] };
const comillas = (a) => (/[\s"]/.test(a) ? `"${a}"` : a);
const CONFIG = POL.normalize({ plan_review: { routine: 'always' } }).values;

function laboratorio(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'respuesta-plan-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(home);
  // stable-data: la fecha del commit de juguete es fija
  const fecha = { GIT_AUTHOR_DATE: '2026-11-20T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-20T00:00:00Z' };
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { stdio: 'ignore', env: { ...process.env, ...fecha } });
  git('init', '-q'); git('config', 'user.email', 'lab@example.invalid'); git('config', 'user.name', 'lab');
  const historia = (n) => {
    const f = path.join(repo, 'specs', `story-${n}-juguete.md`);
    fs.writeFileSync(f, ['---', `story: "${n}"`, 'title: "juguete"', 'status: in-progress', 'files_to_modify:', '  - README.md', '---', '', `# Story ${n}`, ''].join('\n'));
    return f;
  };
  const stories = { [DESTINO]: historia('9.91'), [COORD]: historia('9.92') };
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_LANE_LLM: '0' };
  const estado = path.join(home, '.claude', '.tycon-pipeline');
  const lab = { base, repo, home, env, estado, stories, n: 0 };
  lab.correr = (sid, args, ventana) => spawnSync(process.execPath, [MARKER, ...args], { cwd: repo, encoding: 'utf8',
    env: ventana ? conVentana({ ...env, CLAUDE_CODE_SESSION_ID: sid }, ventana) : { ...env, CLAUDE_CODE_SESSION_ID: sid } });
  lab.leer = (sid = DESTINO) => JSON.parse(fs.readFileSync(path.join(estado, 'active', `${sid}.json`), 'utf8'));
  for (const [sid, storyId] of [[DESTINO, '9.91'], [COORD, '9.92']]) {
    const r = lab.correr(sid, ['set', JSON.stringify({ storyId, storyPath: stories[sid], repoPath: repo })]);
    assert.strictEqual(r.status, 0, r.stderr);
    for (const n of ['0', '1', '2']) lab.correr(sid, ['complete-step', n]);
  }
  const planFile = path.join(require(PIPELINE).resolveRunDir(repo, '9.91', true, stories[DESTINO]), 'step-02-bmad-plan.md');
  let version = 0;
  lab.plan = () => fs.writeFileSync(planFile, `${PLAN}\n<!-- versión ${++version} -->\n`);
  lab.plan();
  const d = { name: 'relay-designation', status: 'ok', ts: new Date(AHORA - 3600e3).toISOString(), sesion: COORD, rol: 'coordinadora', quien: 'dueño', cita: 'Esta sesión es la coordinadora' };
  fs.appendFileSync(path.join(estado, 'gates.log'), `${JSON.stringify(d)}\n${JSON.stringify(DSC.confirmationRecord(d, new Date(AHORA - 3500e3).toISOString()))}\n`);
  const delegacion = (o) => DSC.delegaSinVentana({ ...o, huella: () => ({ huella: HUELLA }) });
  lab.delegacion = delegacion;
  // tres vueltas rechazadas, cada una sobre una versión nueva del plan: la cuarta la decide una persona
  for (let i = 0; i < PR.VUELTAS_SIN_PREGUNTAR; i++) {
    const p = PR.preparar({ lanza: COORD, destino: DESTINO, estado, home, delegacion, config: CONFIG });
    assert.strictEqual(p.codigo, 0, p.motivo);
    PR.anotar({ lanza: COORD, destino: DESTINO, estado, resultado: { pedido: p.args.pedido, ...RECHAZADO }, modelo: 'opus', proveedor: 'anthropic' });
    lab.plan();
  }
  lab.accion = () => PR.accionDelPlan({ estado, sesion: DESTINO, marker: lab.leer(), config: CONFIG, home });
  assert.ok(lab.accion().cuartaVuelta, 'la cuarta vuelta la decide una persona');
  const ask = lab.correr(DESTINO, ['review-ask', '--kind', 'plan']);
  assert.strictEqual(ask.status, 0, ask.stderr);
  lab.comando = (args) => `node ${MARKER} ${args.map(comillas).join(' ')}`;
  lab.cuadro = (args, sesion = COORD) => OW.cuadroPara({ firma: firmaDe(args), comando: lab.comando(args), palabras: OW.canonica(lab.comando(args)), destino: DESTINO, cwd: repo, casa: home, sesion });
  const hora = () => AHORA + (++lab.n) * 1000;
  /** El freno ante el comando que corre `sid`, desde su pestaña, con la delegación del perfil. */
  lab.freno = (sid, args, ahora = hora()) => OW.decidir({ evento: { session_id: sid, tool_use_id: `toolu_${ahora}`, hook_event_name: 'PreToolUse', tool_name: 'Bash', permission_mode: 'default', cwd: repo, tool_input: { command: lab.comando(args) } },
    escapes: [], arbol: arbolDelFreno(), pid: 201, casa: home, ahora, clasificar: () => null, delegacion, huellaDeLaMaquina: () => ({ huella: HUELLA }) });
  /** El freno y, si lo deja o no opina, el guion de verdad, con la verificación del registro que dejó el freno. `{ freno, r }`. */
  lab.pedir = (sid, args) => {
    const ahora = hora();
    const freno = lab.freno(sid, args, ahora);
    const cmd = lab.comando(args);
    // sin firma que pedir el freno no opina, y el comando corre igual
    const r = ['allow', 'none'].includes(freno.decision) ? lab.correr(sid, args, { arbol: { arbol: arbolDelGuion(home, cmd), pid: 301, ahora: ahora + 60000 } }) : null;
    return { freno, r };
  };
  /**
   * El click del dueño en «Sí, aprobar» del cuadro que el freno arma para `args` (pedido por la coordinadora para ses-a),
   * dado en la pestaña `pestana`: la transcripción con el cuadro contestado y el renglón de su gancho.
   */
  lab.click = (args, { pestana = COORD } = {}) => {
    const c = lab.cuadro(args);
    assert.ok(c && c.pregunta && !c.error, JSON.stringify(c));
    const ahora = AHORA + lab.n * 1000 + 500;
    const ts = new Date(ahora).toISOString();
    const id = `toolu_click_${ahora}`;
    const opciones = c.opciones.map((label) => ({ label }));
    const dir = path.join(home, '.claude', 'projects', '-r-proyecto');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${pestana}.jsonl`), `${[
      { type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ question: c.pregunta, options: opciones }] } }] } },
      { type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
        toolUseResult: { questions: [{ question: c.pregunta, options: opciones }], answers: { [c.pregunta]: c.opciones[0] } },
        permissionDecision: { decision: 'accept', source: 'user_temporary' } },
    ].map((r) => JSON.stringify(r)).join('\n')}\n`);
    const h = arbolDelFreno().find((x) => OW.esHerramienta(x));
    OA.anotar(home, { tipo: 'click', sesion: pestana, ts, tool_use_id: id, pregunta: c.pregunta, respuesta: c.opciones[0], herramienta: { pid: h.pid, inicio: h.inicio } });
    return c;
  };
  /** La pregunta del código de ses-a, sobre el diff de ahora. */
  lab.preguntarCodigo = () => {
    const r = lab.correr(DESTINO, ['review-ask', '--kind', 'code']);
    assert.strictEqual(r.status, 0, r.stderr);
  };
  /** Un cambio en el repo: otro diff, y otra huella de la pregunta del código. */
  lab.cambio = () => fs.appendFileSync(path.join(repo, 'README.md'), `cambio ${++lab.n}\n`);
  lab.respuestas = () => fs.readFileSync(path.join(estado, 'gates.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((j) => j.name === 'review-answer');
  lab.abiertas = () => PR.preguntasAbiertas({ estado }).map((p) => `${p.sesion}/${p.kind}`);
  return lab;
}

const salida = (x) => `${x.freno.decision} ${x.freno.via || ''} ${x.freno.texto || ''} ${x.freno.motivo || ''}\n${x.r ? `${x.r.status} ${x.r.stdout}${x.r.stderr}` : '(el guion no corrió)'}`;
const SKIP = ['review-answer', '--kind', 'plan', '--choice', 'skip', '--for-session', DESTINO];
const WAIT = ['review-answer', '--kind', 'plan', '--choice', 'wait', '--for-session', DESTINO];
const REVIEW = ['review-answer', '--kind', 'plan', '--choice', 'review', '--for-session', DESTINO];
const SKIP_CODIGO = ['review-answer', '--kind', 'code', '--choice', 'skip', '--for-session', DESTINO];
const WAIT_CODIGO = ['review-answer', '--kind', 'code', '--choice', 'wait', '--for-session', DESTINO];
const REVIEW_CODIGO = ['review-answer', '--kind', 'code', '--choice', 'review', '--for-session', DESTINO];

module.exports = { laboratorio, salida, SKIP, WAIT, REVIEW, SKIP_CODIGO, WAIT_CODIGO, REVIEW_CODIGO, COORD, DESTINO, FIRMA, FIRMA_CODIGO, PR, OW, OA, COPIA, CONFIG };
