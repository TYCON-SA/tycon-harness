'use strict';
/**
 * reported-criticals.test.js — los críticos que reporta un revisor los anota el arnés, y el agente no los borra ni los
 * rebaja al escribir los hallazgos.
 *
 * El caso: `findings.json` lo arma el agente con `pipeline.js write-findings` desde un JSON que escribe él. Podía omitir un
 * crítico, bajarle la severidad, cambiarle la regla o marcarlo «arreglado» sin que nada lo comprobara. Ahora el arnés anota
 * lo que reportó cada revisor apenas termina (en Codex, `reviewers-run`; en Claude Code, el gancho del fin del subagente),
 * en una zona del estado que el agente no escribe, y cruza findings.json contra eso: por regla y cantidad, sin archivo.
 *
 * Todo corre los comandos de verdad contra una HOME y un repo de juguete. 0 deps (node:test).
 *
 * stable-data: el registro y el marcador se fechan con el reloj real; las pruebas comparan órdenes (antes, después), nunca
 * una fecha fija.
 *
 * 🔴 Mutaciones que los ponen en rojo: anotar los avisos o perder la huella o la cuenta (T1, T2), no frenar un crítico que
 * falta, rebajado o anotado menos veces de las reportadas (T3), aceptar «arreglado» sin otra vuelta, de más, o con la
 * exención por delegación, o un «refutado» sin constancia (T4), tomar «sin reporte» o un veredicto propio como legible
 * (T5, T6), leer el archivo de la corrida en lugar del registro (T7), interpretar la prosa (T8), dejar tocar el registro
 * (T9), frenar una corrida de antes del registro (T10), un revisor del núcleo que no pide el renglón de veredicto (T11).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const MARKER = path.join(SCRIPTS, 'marker.js');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const HOOK = path.join(SCRIPTS, 'on-advisor-done.js');
const BASH_GATE = path.join(SCRIPTS, 'on-bash-write-gate.js');
const cw = require(path.join(SCRIPTS, 'lib', 'critical-waivers.js'));
const { stateDir: stateDirOf } = require(path.join(SCRIPTS, 'lib', 'state-dir.js'));
// el módulo de la historia: si no está, cada prueba falla con su nombre (no el archivo entero)
const rcPath = path.join(SCRIPTS, 'lib', 'reported-criticals.js');
const rcLib = () => require(rcPath);

const SID = 's-rc';
const SEC = 'tycon-plugin-security-basics';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const GIT_ENV = { ...process.env, GIT_AUTHOR_DATE: '2026-10-19T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-19T12:00:00Z' };
const jsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
// stable-data: fechas en orden, a partir de ahora (el marcador arranca con el reloj real)
const at = (seg) => new Date(Date.now() + seg * 1000).toISOString();
// el registro de una sesión, donde lo deja el módulo (`<estado>/reported-criticals/<sesión>.jsonl`)
const registryOf = (state) => path.join(state, 'reported-criticals', `${SID}.jsonl`);

/** Un repo con una story, una HOME propia y un marcador en «Hallazgos». */
function lab({ advisors = [SEC] } = {}) {
  const base = tmp('rc-');
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(home);
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { stdio: 'ignore', env: GIT_ENV });
  git('init', '-q'); git('config', 'user.email', 'noreply@example.com'); git('config', 'user.name', 'lab');
  const story = path.join(repo, 'specs', 'story-9.92-juguete.md');
  fs.writeFileSync(story, ['---', 'story: "9.92"', 'title: "juguete"', 'status: in-progress', 'files_to_modify:', '  - a.js', '---', '', '# Story 9.92', ''].join('\n'));
  fs.writeFileSync(path.join(repo, 'a.js'), 'module.exports = 1;\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: SID, TYCON_LANE_LLM: '0', TYCON_PROFILE: '0', TYCON_PACKS_DEFAULT: 'none', TYCON_AUTO_SNAPSHOT: '0' };
  delete env.TYCON_HOME; delete env.CODEX_SESSION_ID; delete env.CLAUDE_CONFIG_DIR;
  const state = stateDirOf(home);
  fs.mkdirSync(path.join(state, 'active'), { recursive: true });
  fs.mkdirSync(path.join(state, 'advisor-runs'), { recursive: true });
  const marker = {
    storyId: '9.92', storyPath: story, repoPath: repo, sessionId: SID, stepScheme: 2, startedAt: at(-600),
    stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'adversarial-pass'],
    stepsPending: ['findings', 'live-check', 'prepare-commit'], filesTouched: ['a.js'], fileEvents: [],
  };
  const markerPath = path.join(state, 'active', `${SID}.json`);
  fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2));
  const runDir = require(PIPELINE).resolveRunDir(repo, '9.92', true, story);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(state, 'advisor-runs', `${SID}.jsonl`), `${JSON.stringify({ ts: at(-500), event: 'step5-start', expected: advisors, iter: 1 })}\n`);
  const run = path.basename(runDir);
  const registro = registryOf(state);
  const anotar = (l) => { fs.mkdirSync(path.dirname(registro), { recursive: true }); fs.appendFileSync(registro, `${JSON.stringify({ story: '9.92', run, ...l })}\n`); };
  const writeFindings = (lista) => {
    const f = path.join(base, `findings-${Math.random()}.json`);
    fs.writeFileSync(f, JSON.stringify(lista));
    return spawnSync(process.execPath, [PIPELINE, 'write-findings', '--story', story, '--repo', repo, '--findings', f], { cwd: repo, encoding: 'utf8', env });
  };
  // findings.json escrito a mano, como lo podía dejar el agente: el cierre lo vuelve a mirar
  const closeFindings = (lista) => {
    fs.writeFileSync(path.join(runDir, 'findings.json'), JSON.stringify(lista));
    return spawnSync(process.execPath, [MARKER, 'complete-step', 'findings'], { cwd: repo, encoding: 'utf8', env });
  };
  const setMarker = (extra) => fs.writeFileSync(markerPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(markerPath, 'utf8')), ...extra }, null, 2));
  return { base, repo, home, story, env, state, runDir, run, registro, anotar, writeFindings, closeFindings, setMarker };
}

const LANZADO = (ts, iter = 1, advisor = SEC) => ({ ts, kind: 'launched', advisor, iter, launcher: 'claude' });
const REPORTE = (ts, criticals, { iter = 1, advisor = SEC, readable = true, reason } = {}) => ({ ts, kind: 'report', advisor, iter, source: 'subagent-stop', readable, ...(reason ? { reason } : {}), hash: 'h', agent_id: `ag-${advisor}-${iter}`, criticals });
const CRIT = { rule_id: 'SEC-C1', severity: 'CRITICAL', advisor: 'orquestador', file: 'a.js', disposition: 'open', reason: 'pendiente' };
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;

/** Una constancia de `waive-critical` con su renglón en el registro del arnés, como la deja el comando. */
function eximir(l, { rule, file, tipo, delegacion }) {
  const linea = tipo === 'manual'
    ? { ts: at(0), rule_id: rule, file, reason: 'prueba', tipo, quien: 'Dev de Prueba', via: 'click en el cuadro' }
    // como la deja la coordinadora por delegación (owner-window.js, quienFirmo): válida en todo lo demás
    : { ts: at(0), rule_id: rule, file, reason: 'prueba', tipo, quien: 'coordinadora (sesión s-coord)', delegacion, via: 'delegada · coordinadora' };
  assert.equal(cw.constanciaInvalida(linea), null, 'la constancia de la prueba no es válida: la prueba no mide lo que dice');
  fs.appendFileSync(path.join(l.runDir, cw.FILE), `${JSON.stringify(linea)}\n`);
  fs.appendFileSync(path.join(l.state, 'gates.log'), `${JSON.stringify({ name: 'critical-waiver', status: 'ok', rule, file, ts: linea.ts, story: '9.92', huella: cw.huella(linea) })}\n`);
}

// ── T1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('fs');
const argv = process.argv.slice(2);
const out = argv[argv.indexOf('-o') + 1];
fs.writeFileSync(out, process.env.FAKE_REPORT);
`;

test('Findings_CriticoReportado_Registrado_Codex — reviewers-run anota los críticos del reporte al cerrar el proceso @story-8.83 @ac-1', () => {
  const rc = rcLib();
  const l = lab();
  const bin = tmp('rc-bin-');
  fs.writeFileSync(path.join(bin, 'codex'), FAKE_CODEX, { mode: 0o755 });
  const codexHome = path.join(l.home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, `${SEC}.config.toml`), 'model = "x"\n');
  const env = { ...l.env, CODEX_HOME: codexHome, CODEX_SESSION_ID: SID, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FAKE_REPORT: '## hallazgos\n- [SEC-C1] a.js:3 un secreto\n- [SEC-C1] b.js:9 otro\n- [VAL-W2] formato\nVeredicto: hallazgos (SEC-C1, SEC-C1, VAL-W2) · bloquea: sí\n' };
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync(process.execPath, [PIPELINE, 'reviewers-run', '--repo', l.repo, '--story', l.story], { cwd: l.repo, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, out(r));
  const lineas = jsonl(l.registro);
  assert.ok(lineas.some((x) => x.kind === 'launched' && x.advisor === SEC && x.iter === 1), 'sin el lanzamiento anotado');
  const rep = lineas.find((x) => x.kind === 'report' && x.advisor === SEC);
  assert.ok(rep, 'sin el reporte anotado');
  assert.equal(rep.readable, true);
  assert.equal(rep.iter, 1);
  assert.equal(rep.hash, rc.hashOf(env.FAKE_REPORT));
  assert.deepEqual(rep.criticals, [{ rule: 'SEC-C1', count: 2 }]);
});

// ── T2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('Findings_CriticoReportado_Registrado_Claude — el gancho del fin del subagente anota los críticos de las palabras del revisor @story-8.83 @ac-1', () => {
  const l = lab();
  l.anotar(LANZADO(at(-100)));
  const subagents = path.join(l.home, 'transcripts', 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  const transcript = path.join(subagents, 'agent-x.jsonl');
  const del = (role, text) => `${JSON.stringify({ type: role, message: { role, content: [{ type: 'text', text }] } })}\n`;
  // el pedido del orquestador nombra otra regla: no es palabra del revisor
  const texto = '- Encontré un secreto en el código; bloquea.\nVeredicto: hallazgos (SEC-C1, VAL-W2) · bloquea: sí';
  fs.writeFileSync(transcript, del('user', 'Revisá; ojo con [PIPE-C9].') + del('assistant', texto));
  const hook = (ev) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'SubagentStop', session_id: SID, agent_id: 'ag-1', agent_transcript_path: transcript, ...ev }), env: l.env, encoding: 'utf8' });
  // un agente que no salió en la vuelta no se anota
  assert.equal(hook({ agent_type: 'Explore', agent_id: 'ag-0' }).status, 0);
  const r = hook({ agent_type: SEC, last_assistant_message: texto });
  assert.equal(r.status, 0, out(r));
  let reps = jsonl(l.registro).filter((x) => x.kind === 'report');
  assert.equal(reps.length, 1, 'anotó de más o de menos');
  assert.equal(reps[0].advisor, SEC);
  assert.equal(reps[0].iter, 1);
  assert.equal(reps[0].readable, true);
  assert.deepEqual(reps[0].criticals, [{ rule: 'SEC-C1', count: 1 }]);
  assert.match(reps[0].hash, /^[0-9a-f]{64}$/);
  // le piden el detalle con un mensaje y contesta en la misma transcripción: se suma en la misma vuelta
  fs.appendFileSync(transcript, del('user', 'pasame el detalle') + del('assistant', '- [SEC-C1] a.js:3 el secreto\n- [SEC-C2] b.js otro'));
  assert.equal(hook({ agent_type: SEC }).status, 0);
  reps = jsonl(l.registro).filter((x) => x.kind === 'report');
  assert.equal(reps.length, 2, 'la segunda respuesta no se sumó');
  assert.equal(reps[1].iter, 1, 'la segunda respuesta no quedó en su vuelta');
  assert.ok(reps[1].criticals.some((c) => c.rule === 'SEC-C2'), JSON.stringify(reps[1].criticals));
  // sin el renglón de veredicto no se lee
  const l2 = lab();
  l2.anotar(LANZADO(at(-100)));
  const t2 = path.join(subagents, 'agent-y.jsonl');
  fs.writeFileSync(t2, del('assistant', '- Todo bien, tengo el detalle, pedímelo'));
  spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'SubagentStop', session_id: SID, agent_id: 'ag-2', agent_type: SEC, agent_transcript_path: t2 }), env: l2.env, encoding: 'utf8' });
  const rep2 = jsonl(l2.registro).find((x) => x.kind === 'report');
  assert.ok(rep2, 'no anotó el reporte ilegible');
  assert.equal(rep2.readable, false);
  assert.match(rep2.reason, /Veredicto/);
});

// ── T3 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('Findings_OmitidoORebajado_Frena — sin el crítico, rebajado, con otra regla o menos veces de las reportadas: frenan los dos @story-8.83 @ac-2', () => {
  const casos = [
    { nombre: 'sin SEC-C1', lista: [] },
    { nombre: 'como aviso', lista: [{ ...CRIT, severity: 'WARNING' }, CRIT] },
    { nombre: 'otra regla', lista: [{ ...CRIT, rule_id: 'SEC-C9' }, { ...CRIT, rule_id: 'SEC-C9' }] },
    { nombre: 'uno de dos', lista: [CRIT] },
  ];
  for (const c of casos) {
    const l = lab();
    l.anotar(LANZADO(at(-100)));
    l.anotar(REPORTE(at(-90), [{ rule: 'SEC-C1', count: 2 }]));
    const w = l.writeFindings(c.lista);
    assert.notEqual(w.status, 0, `${c.nombre}: write-findings escribió igual`);
    assert.match(out(w), /SEC-C1/, c.nombre);
    assert.match(out(w), new RegExp(`${SEC}, vuelta 1`), `${c.nombre}: no dice revisor y vuelta`);
    assert.ok(!fs.existsSync(path.join(l.runDir, 'findings.json')), `${c.nombre}: escribió findings.json`);
    const k = l.closeFindings(c.lista);
    assert.notEqual(k.status, 0, `${c.nombre}: el cierre de Hallazgos pasó`);
    assert.match(out(k), /SEC-C1/, c.nombre);
  }
  // con los dos SEC-C1, en archivos cualquiera, pasa: el archivo no se compara
  const l = lab();
  l.anotar(LANZADO(at(-100)));
  l.anotar(REPORTE(at(-90), [{ rule: 'SEC-C1', count: 2 }]));
  const ok = l.writeFindings([{ ...CRIT, file: 'x.js' }, { ...CRIT, file: 'y/z.ts' }]);
  assert.equal(ok.status, 0, out(ok));
});

// ── T4 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('Findings_ArregladoSinComprobar_Frena — «arreglado» vale con otra vuelta del revisor o el dueño; no con la prueba sola, el pase ni la delegación @story-8.83 @ac-3', () => {
  const FIXED = [{ ...CRIT, disposition: 'fixed', reason: 'arreglado' }];
  const base = () => {
    const l = lab();
    l.anotar(LANZADO(at(-300)));
    l.anotar(REPORTE(at(-290), [{ rule: 'SEC-C1', count: 1 }]));
    return l;
  };
  // sin otra vuelta
  let l = base();
  let r = l.closeFindings(FIXED);
  assert.notEqual(r.status, 0, 'pasó sin nada que lo compruebe');
  assert.match(out(r), /arreglado/);
  // con una prueba nueva sola: el agente la escribe, no cuenta
  l = base();
  fs.writeFileSync(path.join(l.repo, 'a.test.js'), 'require("node:test")("SEC-C1", () => {});\n');
  assert.notEqual(l.closeFindings(FIXED).status, 0, 'pasó con la prueba sola');
  // con la exención de la coordinadora por delegación
  l = base();
  eximir(l, { rule: 'SEC-C1', file: 'a.js', tipo: 'automatica', delegacion: 'Dev de Prueba' });
  assert.notEqual(l.closeFindings(FIXED).status, 0, 'pasó con la exención por delegación');
  // la vuelta 2 del mismo revisor ya no lo trae
  l = base();
  l.anotar(LANZADO(at(-200), 2));
  l.anotar(REPORTE(at(-190), [], { iter: 2 }));
  r = l.closeFindings(FIXED);
  assert.equal(r.status, 0, out(r));
  // una vuelta 2 ilegible no prueba nada
  l = base();
  l.anotar(LANZADO(at(-200), 2));
  l.anotar(REPORTE(at(-190), [], { iter: 2, readable: false, reason: 'el reporte vino vacío' }));
  assert.match(out(l.closeFindings(FIXED)), /arreglado/, 'una vuelta ilegible lo dio por arreglado');
  // el pase adversarial no prueba «arreglado»: sus hallazgos no traen la regla
  l = base();
  const res = path.join(l.runDir, 'step-05b-adversarial.json');
  fs.writeFileSync(res, JSON.stringify({ confirmed: [] }));
  l.setMarker({ adversarial: { runId: 'r1', launchedAt: at(-250) }, adversarialPasses: [{ ts: at(-100), tipo: '5b', confirmados: 0, veredicto: 'listo', resultado: res }] });
  assert.notEqual(l.closeFindings(FIXED).status, 0, 'pasó con el pase');
  // con la exención del dueño
  l = base();
  eximir(l, { rule: 'SEC-C1', file: 'a.js', tipo: 'manual' });
  r = l.closeFindings(FIXED);
  assert.equal(r.status, 0, out(r));
  // reportado dos veces y la vuelta 2 trae uno: vale uno «arreglado», no los dos
  const dos = () => {
    const x = lab();
    x.anotar(LANZADO(at(-300)));
    x.anotar(REPORTE(at(-290), [{ rule: 'SEC-C1', count: 2 }]));
    x.anotar(LANZADO(at(-200), 2));
    x.anotar(REPORTE(at(-190), [{ rule: 'SEC-C1', count: 1 }], { iter: 2 }));
    return x;
  };
  r = dos().closeFindings([{ ...CRIT, disposition: 'fixed', reason: 'x' }, CRIT]);
  assert.equal(r.status, 0, out(r));
  assert.notEqual(dos().closeFindings([{ ...CRIT, disposition: 'fixed', reason: 'x' }, { ...CRIT, disposition: 'fixed', reason: 'x' }]).status, 0, 'dio por arreglados los dos');
  // un «refutado» escrito a mano, sin la constancia del verificador
  l = base();
  r = l.closeFindings([{ ...CRIT, disposition: 'refuted', reason: 'es falso' }]);
  assert.notEqual(r.status, 0, 'pasó un refutado sin constancia');
  assert.match(out(r), /refutad|refuted/);
});

// ── T5 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('Findings_SinReportes_NoEsNada — sin registro del revisor, reporte vacío o sin «Veredicto:»: lo dice y no cierra @story-8.83 @ac-4', () => {
  const rc = rcLib();
  const A = 'tycon-silent-failure-hunter';
  const B = 'tycon-spec-first-checker';
  const l = lab({ advisors: [SEC, A, B] });
  l.anotar(LANZADO(at(-100), 1, SEC));
  l.anotar(LANZADO(at(-100), 1, A));
  l.anotar(LANZADO(at(-100), 1, B));
  l.anotar(REPORTE(at(-90), [], { advisor: A, readable: false, reason: 'el reporte vino vacío' }));
  l.anotar(REPORTE(at(-90), [], { advisor: B, readable: false, reason: 'el reporte no trae el renglón «Veredicto:»' }));
  const r = l.closeFindings([]);
  assert.notEqual(r.status, 0);
  for (const a of [SEC, A, B]) assert.match(out(r), new RegExp(`no pude leer lo que reportó ${a}`), a);
  const w = l.writeFindings([]);
  assert.notEqual(w.status, 0);
  // con la exención SIN-REPORTE, ése deja de frenar
  eximir(l, { rule: rc.NO_REPORT_RULE, file: SEC, tipo: 'manual' });
  const r2 = l.closeFindings([]);
  assert.doesNotMatch(out(r2), new RegExp(`no pude leer lo que reportó ${SEC}`));
  assert.match(out(r2), new RegExp(`no pude leer lo que reportó ${A}`));
  // un veredicto propio de un revisor no es el renglón que se lee
  assert.match(rc.unreadableReason('**Status**: 0 CRITICAL · **Veredicto**: GREEN'), /Veredicto/);
  assert.match(rc.unreadableReason('## Veredicto\nTodo bien'), /Veredicto/);
});

// ── T6 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('Findings_CodexModelSpawn_NoReport — en Codex, el revisor que lanza el modelo queda sin reporte y no cierra @story-8.83 @ac-4', () => {
  const l = lab();
  const env = { ...l.env, CODEX_SESSION_ID: SID };
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'on-advisor-run.js')], {
    input: JSON.stringify({ session_id: SID, cwd: l.repo, tool_name: 'collaborationspawn_agent', tool_input: { agent_type: SEC, task_name: 'sec' } }),
    env, encoding: 'utf8', cwd: l.repo,
  });
  assert.equal(r.status, 0, out(r));
  assert.ok(jsonl(l.registro).some((x) => x.kind === 'launched' && x.advisor === SEC), 'el lanzamiento del modelo no quedó en el registro');
  const k = l.closeFindings([]);
  assert.notEqual(k.status, 0);
  assert.match(out(k), new RegExp(`no pude leer lo que reportó ${SEC}`));
});

// ── T7 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('Findings_ReportEditedAfter_Ignored — editar el reporte de la carpeta de la corrida no cambia lo anotado @story-8.83 @ac-1', () => {
  const l = lab();
  l.anotar(LANZADO(at(-100)));
  l.anotar(REPORTE(at(-90), [{ rule: 'SEC-C1', count: 1 }]));
  const dir = path.join(l.runDir, 'step-05-advisor-reports');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${SEC}.md`), 'Nada que reportar.\nVeredicto: limpio\n');
  const r = l.closeFindings([]);
  assert.notEqual(r.status, 0);
  assert.match(out(r), /falta SEC-C1/);
});

// ── T8 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('Findings_MentionCountsAsReported — una mención en la prosa cuenta como reportado @story-8.83 @ac-5', () => {
  const rc = rcLib();
  assert.deepEqual(rc.extractCriticals('Revisé todo: no encontré nada como [SEC-C3].\nVeredicto: limpio'), [{ rule: 'SEC-C3', count: 1 }]);
  // la cuenta sale del veredicto (la regla una vez por hallazgo); los avisos no se anotan
  assert.deepEqual(rc.extractCriticals('[SEC-C1] a.js\nVeredicto: hallazgos (SEC-C1, SEC-C1, VAL-W2, DODRT-C5.1) · bloquea: sí'),
    [{ rule: 'SEC-C1', count: 2 }, { rule: 'DODRT-C5.1', count: 1 }]);
  assert.deepEqual(rc.extractCriticals('[VAL-W2] x\nVeredicto: limpio'), []);
  // sin el renglón del veredicto, el reporte no se lee
  assert.equal(rc.unreadableReason('- bien\nVeredicto: limpio'), null);
  assert.match(rc.unreadableReason('- bien, tengo el detalle'), /Veredicto/);
});

// ── T9 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('Findings_RegistryProtected — el freno de escritura no deja tocar el registro @story-8.83 @ac-6', () => {
  const l = lab();
  l.anotar(LANZADO(at(-100)));
  const reg = l.registro;
  const comandos = [`rm ${reg}`, `echo '{}' > ${reg}`, `sed -i '' 's/SEC/X/' ${reg}`, `mv ${reg} ${path.join(l.base, 'x.jsonl')}`];
  for (const cmd of comandos) {
    const r = spawnSync(process.execPath, [BASH_GATE], { input: JSON.stringify({ session_id: SID, tool_name: 'Bash', cwd: l.repo, tool_input: { command: cmd } }), env: l.env, encoding: 'utf8', cwd: l.repo });
    const dijo = out(r);
    assert.ok(r.status === 2 || /"permissionDecision"\s*:\s*"deny"|"decision"\s*:\s*"block"/.test(dijo), `no frenó: ${cmd}\n${dijo}`);
  }
  assert.ok(fs.existsSync(reg), 'el registro ya no está');
  const sg = require(path.join(SCRIPTS, 'lib', 'story-gate.js'));
  const edit = sg.computeStoryGate({ filePath: reg, stateDir: l.state, homeDir: l.home, repoRoot: l.repo, repoHasTycon: true, repoHasStories: true });
  assert.equal(edit.action, 'block', 'la edición entra al registro');
  assert.equal(sg.signedRecordKind(reg), 'reported-criticals');
});

// ── T10 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('Findings_RunWithoutRegistry_Says — una corrida sin registro lo dice y sigue como antes @story-8.83 @ac-7', () => {
  const l = lab();
  const w = l.writeFindings([]);
  assert.equal(w.status, 0, out(w));
  assert.match(out(w), /no tiene registro de críticos reportados/);
  const k = spawnSync(process.execPath, [MARKER, 'complete-step', 'findings'], { cwd: l.repo, encoding: 'utf8', env: l.env });
  assert.equal(k.status, 0, out(k));
  assert.match(out(k), /no tiene registro de críticos reportados/);
});

// ── T11 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// El renglón de veredicto que lee el arnés lo piden la definición de cada revisor del núcleo y el pedido del paso.
const RE_PIDE_VEREDICTO = /Veredicto: hallazgos \(([A-Z][A-Z0-9]*-C\d+), \1/;
test('Findings_CoreReviewersCloseWithVerdict — los revisores del núcleo y el paso piden cerrar con el renglón de veredicto @story-8.83 @ac-1', () => {
  const { CORE_REVIEWERS } = require(PIPELINE);
  const raiz = path.join(SCRIPTS, '..', '..', '..');
  assert.ok(CORE_REVIEWERS.length >= 10, 'la tabla del núcleo vino corta');
  for (const { agent } of CORE_REVIEWERS) {
    const def = fs.readFileSync(path.join(raiz, 'agents', `${agent}.md`), 'utf8');
    assert.match(def, RE_PIDE_VEREDICTO, `${agent}: no pide cerrar con la regla una vez por hallazgo`);
    // ninguno escribe su detalle a un archivo: ninguno tiene las herramientas de escritura ni de edición (alguno tiene la
    // consola, para leer), y su definición no se lo pide
    const herramientas = (def.match(/^tools:(.*)$/m) || [])[1];
    assert.ok(herramientas !== undefined, `${agent}: sin la lista de herramientas en su cabecera`);
    assert.doesNotMatch(herramientas, /\b(?:Write|Edit|NotebookEdit)\b/, `${agent}: puede escribir archivos`);
    assert.doesNotMatch(def, /detalle completo en <esa ruta>/, `${agent}: pide escribir su detalle a un archivo`);
  }
  const paso = fs.readFileSync(path.join(SCRIPTS, '..', 'steps', 'step-07-reviewers.md'), 'utf8');
  assert.match(paso, RE_PIDE_VEREDICTO, 'el pedido del paso no pide el renglón de veredicto');
  assert.doesNotMatch(paso, /detalle completo en <esa ruta>/, 'el paso todavía le pide al revisor escribir su detalle a un archivo');
});

// ── T13 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Un revisor que salió (el registro de lanzamientos de la sesión, el que cuenta check-count, lo tiene) y cuyo lanzamiento
// no quedó en el registro de críticos: sin el cruce con ese registro, el cierre no lo veía y pasaba como «nada que decir».
const OTRO = 'tycon-plugin-tests-coverage';
test('Findings_LaunchNotInRegistry_Blocks — un revisor que salió sin su renglón en el registro de críticos frena @story-8.83 @ac-4', () => {
  const l = lab({ advisors: [SEC, OTRO] });
  const ledger = path.join(l.state, 'advisor-runs', `${SID}.jsonl`);
  const salio = (ts, advisor) => fs.appendFileSync(ledger, `${JSON.stringify({ ts, advisor, model: 'sonnet', repo: l.repo, story: '9.92' })}\n`);
  // stable-data: todas las horas de la prueba salen de una sola lectura del reloj (8.270): con una lectura por hora, el
  // renglón quedaba un milisegundo después de su salida y la salida caía fuera de la ventana (4 de cada 30 corridas)
  const base = Date.now();
  const en = (seg) => new Date(base + seg * 1000).toISOString();
  // SEC salió con su renglón y su reporte: bien. La salida y su renglón llevan la misma hora
  salio(en(-120), SEC); l.anotar(LANZADO(en(-120))); l.anotar(REPORTE(en(-110), []));
  // OTRO salió y su salida no quedó anotada
  salio(en(-100), OTRO);
  // SEC salió otra vez sin su renglón
  salio(en(-90), SEC);
  const w = l.writeFindings([]);
  assert.notEqual(w.status, 0, `write-findings escribió igual: ${out(w)}`);
  assert.match(out(w), new RegExp(`no pude leer lo que reportó ${OTRO}`));
  assert.match(out(w), new RegExp(`no pude leer lo que reportó ${SEC}`));
  const k = l.closeFindings([]);
  assert.notEqual(k.status, 0, `el cierre pasó igual: ${out(k)}`);
  assert.match(out(k), new RegExp(OTRO));
  // con la exención de una persona, cada uno deja de frenar
  eximir(l, { rule: 'SIN-REPORTE', file: OTRO, tipo: 'manual' });
  eximir(l, { rule: 'SIN-REPORTE', file: SEC, tipo: 'manual' });
  const w2 = l.writeFindings([]);
  assert.equal(w2.status, 0, out(w2));
  const k2 = l.closeFindings([]);
  assert.equal(k2.status, 0, out(k2));
});

test('Findings_SpawnSameMsAsFirstLine_Counts — una salida con la misma hora exacta que el primer renglón del registro cuenta @story-8.270 @ac-13', () => {
  const l = lab({ advisors: [SEC, OTRO] });
  const ledger = path.join(l.state, 'advisor-runs', `${SID}.jsonl`);
  const salio = (ts, advisor) => fs.appendFileSync(ledger, `${JSON.stringify({ ts, advisor, model: 'sonnet', repo: l.repo, story: '9.92' })}\n`);
  const base = Date.now();
  const en = (seg) => new Date(base + seg * 1000).toISOString();
  // el primer renglón del registro es el de OTRO, con su reporte; SEC salió en el mismo milisegundo y no quedó anotado
  salio(en(-120), OTRO); l.anotar(LANZADO(en(-120), 1, OTRO)); l.anotar(REPORTE(en(-110), [], { advisor: OTRO }));
  salio(en(-120), SEC);
  const w = l.writeFindings([]);
  assert.notEqual(w.status, 0, `la salida de SEC no contó: ${out(w)}`);
  assert.match(out(w), new RegExp(`no pude leer lo que reportó ${SEC}`));
  assert.doesNotMatch(out(w), new RegExp(`no pude leer lo que reportó ${OTRO}`));
});

// ── T14 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Un registro que existe y no se lee no es una corrida de antes del control.
test('Findings_RegistryUnreadable_NotNoRegistry — un registro ilegible frena; un renglón roto suelto se avisa @story-8.83 @ac-7', () => {
  const l = lab();
  fs.mkdirSync(path.dirname(l.registro), { recursive: true });
  fs.writeFileSync(l.registro, '{roto\n{otro roto\n');
  const w = l.writeFindings([]);
  assert.notEqual(w.status, 0, `write-findings escribió igual: ${out(w)}`);
  assert.match(out(w), /ilegible/);
  assert.doesNotMatch(out(w), /no tiene registro de críticos reportados/);
  const k = l.closeFindings([]);
  assert.notEqual(k.status, 0, `el cierre pasó igual: ${out(k)}`);
  assert.match(out(k), /ilegible/);
  // la salida de una persona: la misma exención, con el registro en lugar del revisor
  eximir(l, { rule: 'SIN-REPORTE', file: 'registro', tipo: 'manual' });
  assert.equal(l.writeFindings([]).status, 0);
  // un renglón roto entre renglones buenos: pasa, y los dos cierres lo dicen
  const l2 = lab();
  l2.anotar(LANZADO(at(-100)));
  l2.anotar(REPORTE(at(-90), []));
  fs.appendFileSync(l2.registro, '{roto\n');
  const w2 = l2.writeFindings([]);
  assert.equal(w2.status, 0, out(w2));
  assert.match(out(w2), /ilegible/);
  const k2 = l2.closeFindings([]);
  assert.equal(k2.status, 0, out(k2));
  assert.match(out(k2), /ilegible/);
});

// ── T15 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Hallazgo del pase adversarial: con dos salidas del mismo revisor en vuelo, el reporte del segundo agente se descartaba.
const transcriptCon = (dir, nombre, texto) => {
  const t = path.join(dir, nombre);
  fs.writeFileSync(t, `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: texto }] } })}\n`);
  return t;
};
test('Findings_SameReviewerTwiceInFlight_BothRecorded — dos salidas del mismo revisor a la vez: se anotan las dos @story-8.83 @ac-1', () => {
  const l = lab();
  l.anotar(LANZADO(at(-100), 1));
  l.anotar(LANZADO(at(-95), 2));
  const fin = (agentId, texto) => spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'SubagentStop', session_id: SID, agent_id: agentId, agent_type: SEC, agent_transcript_path: transcriptCon(l.base, `${agentId}.jsonl`, texto) }),
    env: l.env, encoding: 'utf8',
  });
  assert.equal(fin('ag-1', 'Sin hallazgos.\nVeredicto: limpio').status, 0);
  assert.equal(fin('ag-2', 'Dos secretos.\nVeredicto: hallazgos (SEC-C1, SEC-C1) · bloquea: sí').status, 0);
  const reps = jsonl(l.registro).filter((x) => x.kind === 'report');
  assert.equal(reps.length, 2, `se perdió un reporte: ${JSON.stringify(reps)}`);
  assert.deepEqual(reps.map((r) => r.iter).sort(), [1, 2], 'los dos reportes cayeron en la misma salida');
  const w = l.writeFindings([CRIT]);
  assert.notEqual(w.status, 0, 'SEC-C1 se pidió una sola vez');
  assert.match(out(w), /SEC-C1/);
});

// ── El revisor caído y su relanzamiento (@story-8.270, AC 8-11, 20) ──────────────────────────────────────────────────
// El gancho de antes del lanzamiento anota la salida con su `tool_use_id`; el de después, el agente que la herramienta
// le dio (`launch-agent`). Cada respuesta va a la salida de su agente, no a la más vieja sin reporte.
const RUN_HOOK = path.join(SCRIPTS, 'on-advisor-run.js');
function lanzar(l, toolUseId, agentId, advisor = SEC) {
  const ev = { session_id: SID, cwd: l.repo, tool_name: 'Agent', tool_use_id: toolUseId, tool_input: { subagent_type: advisor, prompt: 'revisá' } };
  const pre = spawnSync(process.execPath, [RUN_HOOK], { input: JSON.stringify({ hook_event_name: 'PreToolUse', ...ev }), env: l.env, encoding: 'utf8', cwd: l.repo });
  assert.equal(pre.status, 0, out(pre));
  if (agentId === undefined) return;
  const post = spawnSync(process.execPath, [RUN_HOOK], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', ...ev, tool_response: { isAsync: true, status: 'async_launched', agentId } }),
    env: l.env, encoding: 'utf8', cwd: l.repo,
  });
  assert.equal(post.status, 0, out(post));
}
const terminar = (l, agentId, texto, advisor = SEC) => spawnSync(process.execPath, [HOOK], {
  input: JSON.stringify({ hook_event_name: 'SubagentStop', session_id: SID, agent_id: agentId, agent_type: advisor, agent_transcript_path: transcriptCon(l.base, `${agentId}-${Math.random()}.jsonl`, texto) }),
  env: l.env, encoding: 'utf8',
});

test('Launch_DeadThenRelaunched_ReportPairsByAgentId — el reporte del relanzado va a su salida, no a la caída @story-8.270 @ac-8 @ac-9', () => {
  const l = lab();
  lanzar(l, 'toolu_a', 'ag-A');
  lanzar(l, 'toolu_b', 'ag-B');
  const atadas = jsonl(l.registro).filter((x) => x.kind === 'launch-agent');
  assert.deepEqual(atadas.map((x) => [x.advisor, x.iter, x.agent_id, x.story, x.run]), [[SEC, 1, 'ag-A', '9.92', l.run], [SEC, 2, 'ag-B', '9.92', l.run]]);
  assert.equal(terminar(l, 'ag-B', 'Sin hallazgos.\nVeredicto: limpio').status, 0);
  const reps = jsonl(l.registro).filter((x) => x.kind === 'report');
  assert.deepEqual(reps.map((r) => r.iter), [2], `el reporte de B no fue a su salida: ${JSON.stringify(reps)}`);
});

test('Findings_DeadThenRelaunched_NoSinReporte — la caída relanzada no pide exención al cerrar @story-8.270 @ac-9', () => {
  const l = lab();
  lanzar(l, 'toolu_a', 'ag-A');
  lanzar(l, 'toolu_b', 'ag-B');
  assert.equal(terminar(l, 'ag-B', 'Sin hallazgos.\nVeredicto: limpio').status, 0);
  const w = l.writeFindings([]);
  assert.equal(w.status, 0, out(w));
  const k = l.closeFindings([]);
  assert.equal(k.status, 0, out(k));
});

test('Findings_DeadNeverRelaunched_StillBlocks — una caída sin relanzar sigue frenando con SIN-REPORTE @story-8.270 @ac-10', () => {
  const l = lab();
  lanzar(l, 'toolu_a', 'ag-A');
  assert.ok(jsonl(l.registro).some((x) => x.kind === 'launch-agent' && x.agent_id === 'ag-A'));
  const w = l.writeFindings([]);
  assert.notEqual(w.status, 0, out(w));
  assert.match(out(w), new RegExp(`no pude leer lo que reportó ${SEC}`));
  const k = l.closeFindings([]);
  assert.notEqual(k.status, 0, out(k));
  assert.match(out(k), new RegExp(SEC));
});

test('Launch_WithoutLaunchAgent_PairsAsBefore — sin launch-agent, la más vieja; con él, cada uno la suya @story-8.270 @ac-11 @ac-20', () => {
  const rc = rcLib();
  const L = (iter) => ({ kind: 'launched', advisor: SEC, iter, story: '9.92', run: 'r' });
  const A = (iter, id) => ({ kind: 'launch-agent', advisor: SEC, iter, story: '9.92', run: 'r', agent_id: id });
  // sin launch-agent: la más vieja sin reporte, como siempre
  assert.equal(rc.launchFor([L(1), L(2)], SEC, 'ag-2').iter, 1);
  assert.equal(rc.launchFor([L(1), L(2)], SEC, null).iter, 1);
  // con launch-agent, contestando al revés: cada reporte a su vuelta
  const lineas = [L(1), A(1, 'ag-1'), L(2), A(2, 'ag-2')];
  assert.equal(rc.launchFor(lineas, SEC, 'ag-2').iter, 2);
  assert.equal(rc.launchFor(lineas, SEC, 'ag-1').iter, 1);
  // `launch-agent` no es una salida: el cruce de salidas no cambia
  assert.deepEqual(lineas.filter((x) => x.kind === 'launched').length, 2);
});

// ── T16 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Hallazgo del pase adversarial: una regla con sufijo de letra (TEST-C1b existe) o un veredicto partido perdían críticos.
test('Findings_RuleSuffixAndSplitVerdict_Counted — la regla con sufijo de letra y el veredicto en dos renglones cuentan @story-8.83 @ac-1', () => {
  const rc = rcLib();
  assert.deepEqual(rc.extractCriticals('Faltan pruebas.\nVeredicto: hallazgos (TEST-C1b) · bloquea: sí'), [{ rule: 'TEST-C1b', count: 1 }]);
  const partido = 'Dos secretos.\nVeredicto: hallazgos (SEC-C1,\n  SEC-C1) · bloquea: sí';
  assert.deepEqual(rc.extractCriticals(partido), [{ rule: 'SEC-C1', count: 2 }]);
  assert.equal(rc.unreadableReason(partido), null);
  // lo que sigue al veredicto cerrado no se suma
  assert.deepEqual(rc.extractCriticals('Veredicto: hallazgos (SEC-C1) · bloquea: sí\nSEC-C1 SEC-C1'), [{ rule: 'SEC-C1', count: 1 }]);
});

// ── T17 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Hallazgo del pase adversarial: una respuesta tardía del agente de la vuelta 1 tapaba que la vuelta 2 no reportó.
test('Findings_LateReportOtherRound_DoesNotCount — la respuesta tardía de otra vuelta no cuenta para la nueva @story-8.83 @ac-4', () => {
  const l = lab();
  // las respuestas pasan por el gancho real: el de la vuelta 1 vuelve a contestar después de la salida de la vuelta 2
  const fin = (texto) => spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'SubagentStop', session_id: SID, agent_id: 'ag-1', agent_type: SEC, agent_transcript_path: transcriptCon(l.base, `ag-1-${Math.random()}.jsonl`, texto) }),
    env: l.env, encoding: 'utf8',
  });
  l.anotar(LANZADO(at(-100), 1));
  assert.equal(fin('Sin hallazgos.\nVeredicto: limpio').status, 0);
  l.anotar(LANZADO(at(100), 2));
  assert.equal(fin('El detalle que pediste: nada.\nVeredicto: limpio').status, 0);
  const reps = jsonl(l.registro).filter((x) => x.kind === 'report');
  assert.deepEqual(reps.map((r) => r.iter), [1, 1], `el gancho no dejó la respuesta tardía en su vuelta: ${JSON.stringify(reps)}`);
  const w = l.writeFindings([]);
  assert.notEqual(w.status, 0, `write-findings escribió igual: ${out(w)}`);
  assert.match(out(w), new RegExp(`no pude leer lo que reportó ${SEC}, vuelta 2`));
  const k = l.closeFindings([]);
  assert.notEqual(k.status, 0, `el cierre pasó igual: ${out(k)}`);
  assert.match(out(k), new RegExp(`no pude leer lo que reportó ${SEC}, vuelta 2`));
});

// ── El cruce por corrida: lo de otra sesión o de otra corrida no entra ───────────────────────────────────────────────────────────────
// 🔴 Mutaciones: cruzar todas las sesiones del registro (T1), perder la ayudante que comparte la corrida (T2), contar
// un renglón sin corrida de otra sesión (T3), contar las salidas sin historia o de otra corrida (T4).
const S2 = 's-otra';
const AYUDANTE = 's-ayudante';
const ADOPTADA = 's-adoptada';
const ACCOV = 'tycon-ac-coverage-checker';
const anotarEn = (l, sesion, linea) => {
  const f = path.join(l.state, 'reported-criticals', `${sesion}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, `${JSON.stringify({ story: '9.92', ...linea })}\n`);
};
const salidas = (l, sesion, lineas) => fs.appendFileSync(path.join(l.state, 'advisor-runs', `${sesion}.jsonl`), lineas.map((x) => `${JSON.stringify(x)}\n`).join(''));

test('Findings_OtherSessionSameStory_NotCrossed — los renglones de otra corrida de la misma historia no entran al cruce @story-8.267 @ac-1', () => {
  const l = lab();
  l.anotar(LANZADO(at(-100))); l.anotar(REPORTE(at(-90), []));
  // otra sesión, otra corrida, la misma historia, después del arranque: un crítico que esta corrida no tiene que pedir
  anotarEn(l, S2, { ...LANZADO(at(-80), 1, ACCOV), run: 'N2' });
  anotarEn(l, S2, { ...REPORTE(at(-70), [{ rule: 'ACCOV-C1', count: 1 }], { advisor: ACCOV }), run: 'N2' });
  const since = at(-600);
  const r = rcLib().checkRun({ stateDir: l.state, story: '9.92', since, run: l.run, sessionKeys: [SID], findings: [], runDir: l.runDir, home: l.home });
  assert.deepEqual(r.problemas, [], JSON.stringify(r.problemas));
  const w = l.writeFindings([]);
  assert.equal(w.status, 0, `write-findings pidió lo de otra corrida: ${out(w)}`);
  // la de esta corrida sí se pide: el filtro no es «nada»
  l.anotar(REPORTE(at(-60), [{ rule: 'SEC-C1', count: 1 }], { agentId: 'otro' }));
  const w2 = l.writeFindings([]);
  assert.notEqual(w2.status, 0, out(w2));
  assert.match(out(w2), /falta SEC-C1/);
  assert.doesNotMatch(out(w2), /ACCOV-C1/);
});

test('Findings_HelperSharingRun_Counts — una ayudante que escribe la misma corrida en su archivo entra al cruce @story-8.267 @ac-1', () => {
  const l = lab();
  l.anotar(LANZADO(at(-100))); l.anotar(REPORTE(at(-90), []));
  anotarEn(l, AYUDANTE, { ...LANZADO(at(-80), 1, ACCOV), run: l.run });
  anotarEn(l, AYUDANTE, { ...REPORTE(at(-70), [{ rule: 'ACCOV-C1', count: 1 }], { advisor: ACCOV }), run: l.run });
  const r = rcLib().checkRun({ stateDir: l.state, story: '9.92', since: at(-600), run: l.run, sessionKeys: [SID], findings: [], runDir: l.runDir, home: l.home });
  assert.ok(r.problemas.some((p) => p.rule === 'ACCOV-C1'), `la ayudante no entró: ${JSON.stringify(r.problemas)}`);
  const w = l.writeFindings([]);
  assert.notEqual(w.status, 0, out(w));
  assert.match(out(w), /falta ACCOV-C1/);
});

test('Findings_NoRunLines_OnlyFromRunSessions — sin corrida, cuenta sólo el archivo de una sesión de la corrida @story-8.267 @ac-2', () => {
  const l = lab();
  l.setMarker({ adoptedFrom: ADOPTADA });
  // renglones de antes de este cambio: sin `run`
  const sinRun = (x) => { const { run, ...resto } = x; return resto; };
  anotarEn(l, SID, sinRun({ ...LANZADO(at(-100)), run: null }));
  anotarEn(l, SID, sinRun({ ...REPORTE(at(-95), [{ rule: 'SEC-C1', count: 1 }]), run: null }));
  anotarEn(l, ADOPTADA, sinRun({ ...LANZADO(at(-90), 1, OTRO), run: null }));
  anotarEn(l, ADOPTADA, sinRun({ ...REPORTE(at(-85), [{ rule: 'TEST-C2', count: 1 }], { advisor: OTRO }), run: null }));
  anotarEn(l, S2, sinRun({ ...LANZADO(at(-80), 1, ACCOV), run: null }));
  anotarEn(l, S2, sinRun({ ...REPORTE(at(-75), [{ rule: 'ACCOV-C1', count: 1 }], { advisor: ACCOV }), run: null }));
  const r = rcLib().checkRun({ stateDir: l.state, story: '9.92', since: at(-600), run: l.run, sessionKeys: [SID, ADOPTADA], findings: [], runDir: l.runDir, home: l.home });
  const reglas = r.problemas.map((p) => p.rule).filter(Boolean).sort();
  assert.deepEqual(reglas, ['SEC-C1', 'TEST-C2'], JSON.stringify(r.problemas));
  // el mismo cruce por el comando: toma las sesiones del marcador
  const w = l.writeFindings([]);
  assert.notEqual(w.status, 0, out(w));
  assert.match(out(w), /falta SEC-C1/);
  assert.match(out(w), /falta TEST-C2/);
  assert.doesNotMatch(out(w), /ACCOV-C1/);
});

// 🔴 Mutación: sin carpeta de la corrida, descartar el renglón que sí trae `run` aunque sea de una sesión de la corrida:
// el crítico que reportó dejaría de exigirse.
test('Findings_NoRunDir_LineWithRunFromRunSession_Counts — sin carpeta, el renglón con run de una sesión de la corrida cuenta @story-8.267 @ac-2', () => {
  const l = lab();
  anotarEn(l, SID, { ...LANZADO(at(-100)), run: 'otra-carpeta' });
  anotarEn(l, SID, { ...REPORTE(at(-95), [{ rule: 'SEC-C1', count: 1 }]), run: 'otra-carpeta' });
  anotarEn(l, S2, { ...LANZADO(at(-80), 1, ACCOV), run: 'otra-carpeta' });
  anotarEn(l, S2, { ...REPORTE(at(-75), [{ rule: 'ACCOV-C1', count: 1 }], { advisor: ACCOV }), run: 'otra-carpeta' });
  const r = rcLib().checkRun({ stateDir: l.state, story: '9.92', since: at(-600), run: null, sessionKeys: [SID], findings: [], runDir: l.runDir, home: l.home });
  assert.deepEqual(r.problemas.map((p) => p.rule).filter(Boolean), ['SEC-C1'], JSON.stringify(r.problemas));
});

// 🔴 Mutación: que el gancho del fin del subagente no copie la corrida del renglón `launched` al `report`.
test('Findings_ReportHook_CarriesRunOfLaunch — el renglón report hereda la corrida de su lanzamiento @story-8.267 @ac-1', () => {
  const l = lab();
  l.anotar({ ...LANZADO(at(-100)), run: 'carpeta-x' });
  const subagents = path.join(l.home, 'transcripts', 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  const transcript = path.join(subagents, 'agent-run.jsonl');
  const texto = 'Nada que reportar.\nVeredicto: limpio';
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: texto }] } })}\n`);
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'SubagentStop', session_id: SID, agent_id: 'ag-run', agent_type: SEC, agent_transcript_path: transcript, last_assistant_message: texto }), env: l.env, encoding: 'utf8' });
  assert.equal(r.status, 0, out(r));
  const rep = jsonl(l.registro).filter((x) => x.kind === 'report').pop();
  assert.ok(rep, 'no anotó el report');
  assert.equal(rep.run, 'carpeta-x', `el report no lleva la corrida: ${JSON.stringify(rep)}`);
});

test('Findings_OtherSessionLaunches_NotCounted — las salidas de otra sesión, sin historia o de otra corrida, no piden reporte @story-8.267 @ac-1 @ac-3', () => {
  const l = lab({ advisors: [SEC, OTRO, ACCOV] });
  // esta corrida: una salida de SEC con su renglón y su reporte
  salidas(l, SID, [{ ts: at(-100), advisor: SEC, model: 'sonnet', repo: l.repo, story: '9.92', run: l.run }]);
  l.anotar(LANZADO(at(-100))); l.anotar(REPORTE(at(-90), []));
  // otra sesión sin marcador (sin historia) y otra corrida de la misma historia
  salidas(l, S2, [
    { ts: at(-200), event: 'step5-start', expected: [SEC, OTRO, ACCOV], iter: 1 },
    { ts: at(-80), advisor: SEC, model: 'sonnet', repo: null, story: null },
    { ts: at(-79), advisor: OTRO, model: 'sonnet', repo: null, story: null },
    { ts: at(-78), advisor: ACCOV, model: 'sonnet', repo: null, story: null },
    { ts: at(-77), advisor: OTRO, model: 'sonnet', repo: l.repo, story: '9.92', run: 'N2' },
    { ts: at(-76), advisor: ACCOV, model: 'sonnet', repo: l.repo, story: '9.92', run: 'N2' },
  ]);
  // una ayudante de esta corrida: su salida cuenta y tiene su reporte, no sobra
  salidas(l, AYUDANTE, [
    { ts: at(-200), event: 'step5-start', expected: [ACCOV], iter: 1 },
    { ts: at(-70), advisor: ACCOV, model: 'sonnet', repo: l.repo, story: '9.92', run: l.run },
  ]);
  anotarEn(l, AYUDANTE, { ...LANZADO(at(-70), 1, ACCOV), run: l.run });
  anotarEn(l, AYUDANTE, { ...REPORTE(at(-60), [], { advisor: ACCOV }), run: l.run });
  const r = rcLib().checkRun({ stateDir: l.state, story: '9.92', since: at(-600), run: l.run, sessionKeys: [SID], findings: [], runDir: l.runDir, home: l.home });
  assert.deepEqual(r.problemas, [], JSON.stringify(r.problemas));
  const w = l.writeFindings([]);
  assert.equal(w.status, 0, `pidió SIN-REPORTE por salidas de otra sesión: ${out(w)}`);
  // una salida de esta corrida sin su renglón sigue frenando: el filtro no apaga el control
  salidas(l, SID, [{ ts: at(-50), advisor: OTRO, model: 'sonnet', repo: l.repo, story: '9.92', run: l.run }]);
  const w2 = l.writeFindings([]);
  assert.notEqual(w2.status, 0, out(w2));
  assert.match(out(w2), new RegExp(`no pude leer lo que reportó ${OTRO}`));
  // el lanzamiento de Claude Code deja la corrida en el registro de lanzamientos y en el de críticos
  const prev = process.env.HOME;
  const prevSid = process.env.CLAUDE_CODE_SESSION_ID;
  try {
    process.env.HOME = l.home; process.env.USERPROFILE = l.home;
    salidas(l, SID, [{ ts: at(-40), event: 'step5-start', expected: [SEC], iter: 2 }]);
    delete require.cache[require.resolve(path.join(SCRIPTS, 'on-advisor-run.js'))];
    const run = require(path.join(SCRIPTS, 'on-advisor-run.js'));
    const env0 = process.env.TYCON_REVIEW_ROSTER;
    process.env.TYCON_REVIEW_ROSTER = '0';
    const hecho = run.recordLaunch({ sessionId: SID, cwd: l.repo, advisor: SEC, model: 'sonnet' });
    if (env0 === undefined) delete process.env.TYCON_REVIEW_ROSTER; else process.env.TYCON_REVIEW_ROSTER = env0;
    assert.equal(hecho.ok, true, hecho.error);
    const ultima = jsonl(path.join(l.state, 'advisor-runs', `${SID}.jsonl`)).filter((x) => !x.event && x.advisor === SEC).pop();
    assert.equal(ultima.run, l.run, `la salida no lleva la corrida: ${JSON.stringify(ultima)}`);
    const lanz = jsonl(l.registro).filter((x) => x.kind === 'launched').pop();
    assert.equal(lanz.run, l.run, `el renglón launched no lleva la corrida: ${JSON.stringify(lanz)}`);
  } finally {
    process.env.HOME = prev;
    if (prevSid === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = prevSid;
  }
});
