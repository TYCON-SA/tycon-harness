#!/usr/bin/env node
'use strict';
/**
 * rehearse.js — los dos ensayos de la instalación DEL EQUIPO en un agente Windows, y la medición de la base portable:
 * arma el laboratorio, corre cada paso bajo su tope, escribe el reporte y da el veredicto (escenarios
 * `onboarding` y `update`, y `portable`, que mide la base portable).
 * Lo llama el trabajo `Rehearsal` de `pipelines/azure-pipelines-windows.yml`. Es el gemelo de `run.js`, que mide la
 * copia pública (escenario `measure`); comparte con él el laboratorio, el tope de cada paso y la forma del reporte.
 *
 * POR QUÉ EXISTE. Todos los devs del equipo usan Windows. El martes entra uno nuevo, y el lunes cada máquina se
 * actualiza sola a lo que entró esta semana, que nunca corrió en un Windows. Esto lo ensaya antes, en un agente
 * descartable, sin arreglar nada: dice qué pasa.
 *
 * ESCENARIOS (`--scenario`)
 *   update       una máquina instalada con el estado del viernes que se actualiza a lo que se ensaya (`update-probe.js`)
 *   onboarding   el alta de un dev nuevo con lo que se ensaya (`onboarding-probe.js`), y sobre lo que dejó, `count-hooks` y
 *                `fire-registered` (los mismos del escenario `measure`)
 *   all          los dos: primero `update`, que es lo que le pasa al equipo el lunes
 *   Esos dos eligen por lo que el árbol ES: sobre una COPIA PUBLICADA (trae `version.json`) siguen la página pública de
 *   instalación de Windows (`guided-install.js`, `guided-update.js`) y el reporte es otro (`renderGuided`): sin viernes
 *   ni clones. Ninguna corrida suya pasa de 40 minutos: el tope de cada paso está abajo, en `OWN_STEPS`.
 *   portable     la «base portable», medida sobre un clon de los dos repos: los finales de línea de un clon
 *                nuevo y de uno que ya existía, el bash de Git, las suites de la base portable, el banco de controles entero y
 *                los portones por ruta (`portable-probe.js`, una parte por paso). Va aparte: `all` no lo corre.
 *
 * SUBCOMANDOS
 *   init     --lab <carpeta> --out <carpeta> --sources <carpeta de build-sources.js> --scenario <escenario>
 *            [--run-id N] [--run-number X] [--harness-ref R] [--allow-temp] [--same-tree]
 *            Crea el laboratorio (con su marca) y vuelve los dos bundles los remotos del laboratorio. Con bundles de
 *            UN SOLO REPO (`build-sources.js --single-repo`: el árbol publicado, con las skills adentro) el laboratorio
 *            tiene un solo remoto, y el reporte no nombra un segundo repo.
 *            Con `--same-tree`: lo que se ensaya tiene que ser el commit del árbol de estos guiones (los dos salen del
 *            mismo repo); si no, no hay laboratorio. La etiqueta queda como `<harness-ref>:<commit>`.
 *   step     <inventory|update|onboarding|count-hooks|fire-registered> --lab … --out … [--cap <segundos>]
 *            [--only <variantes>] (update, onboarding)      Corre ese paso bajo `run-capped.js`.
 *            Los de `portable`: <fresh-clone|existing-clone|git-bash|suites|bench|path-shapes>.
 *   finish   --out …      Escribe `windows-report.json` y `windows-report.md`.
 *   verdict  --out …      Dice el veredicto y sale 0 (verde) o 1 (rojo).
 *   all      (las opciones de init)      init + los pasos del escenario + finish + verdict, de una.
 *
 * EL VEREDICTO. Lo que el ensayo encuentra NO pone roja la corrida: una máquina que no se actualiza o que pierde un
 * hook es un HECHO del reporte, con su gravedad («rompe el trabajo del dev», «pierde un control», «ruido»). Roja es
 * no haber podido ENSAYAR: un paso en «error», o un paso del escenario que no corrió.
 * «No medido» tampoco es rojo —tiene su motivo: por ejemplo, en el árbol interno el alta sin clon no se ensaya (se
 * ensaya contra una copia publicada)—, pero no pasa callado: cada paso «no medido» deja un aviso
 * en la corrida, y si NINGÚN paso del escenario midió (fuera del inventario) la corrida termina CON AVISOS, no en verde.
 *
 * NUNCA LA CARPETA DE USUARIO REAL: valen las reglas de `run.js` (`labRootProblem`) y de `lab.js` (`labHomeProblem`).
 * SALIDAS: 0 hizo lo suyo (y `verdict`: verde) · 1 `verdict` rojo · 2 uso, o no pudo ni escribir.
 * Fuera de Windows corre igual, en «modo de laboratorio»: para probar los guiones sin una máquina Windows.
 */
const fs = require('fs');
const path = require('path');
const L = require('./lab.js');
const R = require('./run.js');
const T = require('./team-lab.js');
const P = require('./portable-report.js');

const HERE = __dirname;
// Las partes de la base portable, en el orden en que corren. Las suites van ANTES que el banco: si `bench-portable`
// falla, lo que diga el banco entero no es de fiar. Cada una con su tope en segundos.
const PORTABLE_STEPS = Object.freeze({ 'fresh-clone': 2400, 'existing-clone': 3000, 'git-bash': 1500, suites: 2100, bench: 6600, 'path-shapes': 2100 });
const SCENARIOS = Object.freeze({
  update: ['inventory', 'update'],
  onboarding: ['inventory', 'onboarding', 'count-hooks', 'fire-registered'],
  all: ['inventory', 'update', 'onboarding', 'count-hooks', 'fire-registered'],
  portable: ['inventory', ...Object.keys(PORTABLE_STEPS)],
  // la instalación SIN git —una versión bajada— en un Windows, con el archivo tomado (T14). Va
  // aparte, como `portable`: `all` no lo incluye
  'no-clone': ['inventory', 'no-clone'],
  // una máquina SÓLO con Codex —instalar, arrancar Codex, diagnosticar y desinstalar sin nada en
  // la carpeta de Claude Code—. Va aparte, como `no-clone`
  'codex-only': ['inventory', 'codex-only'],
  // las ventanas de consola del arranque desprendido: va aparte, `all` no lo incluye
  'console-windows': ['inventory', 'console-windows'],
  // la mudanza de una máquina del clon a ~/.tycon en Windows —el plan, el archivo tomado que frena,
  // la mudanza con uniones y los hooks al árbol nuevo—. Va aparte, como `no-clone`
  migrate: ['inventory', 'migrate'],
  // la firma del waiver en Windows: sin persona, desde un proceso como el del agente, no se
  // firma. Va aparte, `all` no lo incluye
  waiver: ['inventory', 'waiver'],
  // el instalador del paquete de npm armado con `npm pack` y corrido con `npx --package` contra el GitHub
  // de juguete, y el aviso de pwsh 7 faltante. Va aparte, `all` no lo incluye
  npx: ['inventory', 'npx'],
  // el paquete PUBLICADO, `npx @tyconsa/harness@latest` del registro y el GitHub reales; la segunda
  // corrida dice «al día». Sin red, «no medido». Va aparte, `all` no lo incluye
  'npx-published': ['inventory', 'npx-published'],
});
// todos los pasos que este guion sabe correr, en el orden en que salen en el reporte
const STEP_ORDER = Object.freeze([...SCENARIOS.all, ...Object.keys(PORTABLE_STEPS), 'no-clone', 'codex-only', 'console-windows', 'migrate', 'waiver', 'npx', 'npx-published']);
// los pasos propios de los ensayos, con su tope en segundos (los demás son los de run.js, con el suyo)
const OWN_STEPS = Object.freeze(Object.assign({
  // los dos ensayos del equipo: ninguna corrida suya pasa de 40 minutos (medido: unos 9 y unos 4). El tope de cada
  // paso deja lugar al resto; si una corrida se acerca a ese tiempo no se le sube el tope: se corta y se mira por qué
  update: { script: path.join(HERE, 'update-probe.js'), cap: 1500, pass: ['only', 'allow-temp'] },
  onboarding: { script: path.join(HERE, 'onboarding-probe.js'), cap: 1200, pass: ['only', 'allow-temp'] },
  'no-clone': { script: path.join(HERE, 'no-clone-probe.js'), cap: 2400, pass: ['allow-temp'] },
  'codex-only': { script: path.join(HERE, 'codex-only-probe.js'), cap: 2400, pass: ['allow-temp'] },
  'console-windows': { script: path.join(HERE, 'console-windows-probe.js'), cap: 600, pass: ['allow-temp'] },
  migrate: { script: path.join(HERE, 'migrate-probe.js'), cap: 2400, pass: ['allow-temp'] },
  waiver: { script: path.join(HERE, 'waiver-probe.js'), cap: 600, pass: ['allow-temp'] },
  npx: { script: path.join(HERE, 'npx-probe.js'), cap: 1800, pass: ['allow-temp'] },
  'npx-published': { script: path.join(HERE, 'npx-probe.js'), cap: 1800, pass: ['allow-temp'], args: ['--from', 'registry'] },
}, Object.fromEntries(Object.entries(PORTABLE_STEPS).map(([part, cap]) => [part, { script: path.join(HERE, 'portable-probe.js'), cap, pass: ['allow-temp'], args: ['--part', part] }]))));
const OPTIONS = {
  '--lab': 'value', '--out': 'value', '--sources': 'value', '--scenario': 'value', '--cap': 'value', '--only': 'value',
  '--run-id': 'value', '--run-number': 'value', '--harness-ref': 'value', '--allow-temp': 'flag', '--same-tree': 'flag',
};
const STATUS_TEXT = { measured: 'medido', 'not-measured': 'no medido', error: 'ERROR' };

const say = (s) => process.stdout.write(`${s}\n`);
const fail = (s) => { process.stderr.write(`rehearse.js: ${s}\n`); return 2; };
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const cell = (s) => String(s === null || s === undefined || s === '' ? '—' : s).replace(/\|/g, '\\|').replace(/[\n\t]/g, ' ');
const short = (sha) => (sha ? String(sha).slice(0, 10) : '—');
const yes = (v) => (v === true ? 'sí' : (v === false ? 'NO' : 'no se sabe'));

// ── el laboratorio ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Crea el laboratorio y sus remotos (dos, o uno solo si los bundles son de un solo repo). `{ ok, reason, meta }`.
 * Con `sameTree`, antes de crear nada comprueba que lo que se ensaya sea el commit del árbol de estos guiones.
 */
function initLab({ lab, out, sources, scenario, meta = {}, allowTemp = false, env = R.stepEnv(), sameTree = false, scriptsCommit = R.scriptsCommit }) {
  if (!SCENARIOS[scenario]) return { ok: false, reason: `escenario desconocido: «${scenario}» (los que hay: ${Object.keys(SCENARIOS).join(', ')})` };
  const problem = R.labRootProblem(lab, { allowTemp });
  if (problem) return { ok: false, reason: problem };
  if (!sources || !fs.existsSync(path.join(sources, 'sources-info.json'))) return { ok: false, reason: `no encuentro los bundles de los dos repos en ${sources || '(falta --sources)'}: los arma build-sources.js` };
  if (fs.existsSync(lab) && !fs.existsSync(path.join(lab, L.LAB_MARK)) && fs.readdirSync(lab).length) return { ok: false, reason: `${lab} ya existe, tiene cosas y no es un laboratorio (sin ${L.LAB_MARK}): no lo adopto` };
  if (sameTree) {
    let about = null;
    try { about = readJson(path.join(sources, 'sources-info.json')); } catch (_) { about = null; }
    const same = R.sameTreeCheck({ measured: about && about.harness && about.harness.target, scripts: scriptsCommit, verb: 'se ensaya' });
    if (!same.ok) return { ok: false, reason: same.reason };
    meta = Object.assign({}, meta, { harness_ref: R.sameTreeLabel(meta.harness_ref, same.sha) });
  }
  try {
    fs.mkdirSync(lab, { recursive: true });
    fs.mkdirSync(path.join(out, 'steps'), { recursive: true });
    L.writeJsonAtomic(path.join(lab, L.LAB_MARK), { made_by: 'scripts/tests/windows/rehearse.js init', at: L.nowIso() });
  } catch (e) { return { ok: false, reason: `no pude crear el laboratorio o la carpeta del reporte: ${e.code || e.message}` }; }
  const made = T.makeRemotes({ lab, sources, env });
  if (!made.ok) return { ok: false, reason: made.reason };
  const info = made.state.sources;
  // un repo por cada remoto que haya: con un solo repo no hay `skills`, y el reporte no lo inventa
  const run = Object.assign({ id: null, number: null, harness_ref: null }, meta, {
    scenario, expected_steps: SCENARIOS[scenario], started: L.nowIso(), platform: process.platform, lab_mode: !L.isWin(), node: process.versions.node,
    commits: Object.fromEntries(Object.keys(made.state.remotes).map((k) => [k, { friday: info[k].friday, today: info[k].target, between: info[k].commits_between, today_ref: info[k].target_ref, base: info[k].base || null, base_from: info[k].base_from || null, since_base: info[k].commits_since_base === undefined ? null : info[k].commits_since_base }])),
    friday_tag: info.friday_tag,
  }, made.state.single_repo ? { single_repo: true } : {});
  try { L.writeJsonAtomic(path.join(out, 'run.json'), run); } catch (e) { return { ok: false, reason: `no pude escribir ${path.join(out, 'run.json')}: ${e.code || e.message}` }; }
  return { ok: true, meta: run };
}

// ── el reporte y el veredicto ────────────────────────────────────────────────────────────────────────────────────

function compose(out) {
  let run = null;
  try { run = readJson(path.join(out, 'run.json')); } catch (_) { run = null; }
  let names = [];
  try { names = fs.readdirSync(path.join(out, 'steps')).filter((f) => f.endsWith('.json') && !f.endsWith('.partial.json')).map((f) => f.slice(0, -5)); } catch (_) { names = []; }
  const order = STEP_ORDER;
  const steps = [];
  for (const n of [...order.filter((x) => names.includes(x)), ...names.filter((x) => !order.includes(x)).sort()]) {
    try { steps.push(readJson(L.stepFile(out, n))); } catch (e) { steps.push({ schema: L.SCHEMA, name: n, status: L.STATUS.error, reason: `no pude medir: el resultado del paso es ilegible (${e.message})`, facts: {}, findings: [] }); }
  }
  return { schema: L.SCHEMA, kind: 'windows-rehearsal', run: Object.assign({ id: null }, run || { init_problem: 'no hay run.json: «rehearse.js init» no corrió o no pudo escribir' }, { finished: L.nowIso() }), steps };
}

/**
 * El veredicto de un reporte. Función pura. Rojo sólo si no se pudo ensayar: un error, o un paso del escenario que falta.
 * `{ color, nothing_measured, errors, missing_steps, not_measured, by_severity }`
 * `nothing_measured`: sin errores, ningún paso del escenario midió (fuera del inventario, que sólo mira la máquina).
 * No es un rojo —«no medido» tiene su motivo— pero tampoco es un verde: la corrida termina CON AVISOS.
 */
function verdict(report) {
  const v = { color: 'green', nothing_measured: false, errors: [], missing_steps: [], not_measured: [], by_severity: { breaks: 0, 'loses-control': 0, noise: 0, unrated: 0 } };
  const steps = report && Array.isArray(report.steps) ? report.steps : [];
  if (!steps.length) v.errors.push('el reporte no trae ningún paso: un reporte vacío no es verde');
  if (report && report.run && report.run.init_problem) v.errors.push(report.run.init_problem);
  const expected = report && report.run && Array.isArray(report.run.expected_steps) ? report.run.expected_steps : null;
  if (!expected) v.errors.push('el reporte no dice qué pasos tenía que correr (run.expected_steps)');
  for (const name of expected || []) if (!steps.some((s) => s && s.name === name)) v.missing_steps.push(name);
  for (const s of steps) {
    if (!s || !Object.values(L.STATUS).includes(s.status)) { v.errors.push(`${s && s.name ? s.name : '(paso sin nombre)'}: estado desconocido «${s && s.status}»`); continue; }
    if (s.status === L.STATUS.error) v.errors.push(`${s.name}: ${s.reason || 'error sin motivo'}`);
    if (s.status === L.STATUS.notMeasured) v.not_measured.push(`${s.name}: ${s.reason || 'sin motivo'}`);
    for (const f of s.findings || []) v.by_severity[T.SEVERITY_ORDER.includes(f.severity) ? f.severity : 'unrated']++;
  }
  if (v.errors.length || v.missing_steps.length) v.color = 'red';
  const own = steps.filter((s) => s && s.name !== 'inventory');
  v.nothing_measured = v.color === 'green' && own.length > 0 && own.every((s) => s.status === L.STATUS.notMeasured);
  return v;
}
/** Cómo se dice el veredicto: rojo, con avisos (nada midió) o verde. `verb`: «ensayar» o «medir». */
const verdictText = (v, verb) => (v.color !== 'green' ? `ROJO (no se pudo ${verb})` : (v.nothing_measured ? `CON AVISOS (se pudo correr, pero ningún paso del escenario midió)` : `VERDE (se pudo ${verb})`));

const stepOf = (report, name) => (report.steps || []).find((s) => s && s.name === name) || null;
const bySeverity = (findings) => T.SEVERITY_ORDER.map((sev) => [sev, findings.filter((f) => f.severity === sev)]).filter(([, list]) => list.length);

function pushFindings(M, findings, strip) {
  if (!findings.length) { M.push('Sin diferencias.', ''); return; }
  for (const [sev, list] of bySeverity(findings)) {
    M.push(`**${T.SEVERITY_TEXT[sev]} (${list.length})**`, '');
    for (const f of list) M.push(`- \`${strip ? f.id.replace(strip, '') : f.id}\` — ${f.detail}`);
    M.push('');
  }
}
function installTable(M, inst) {
  if (!inst || !inst.steps) return;
  M.push('| Paso del alta | Salió | Duró (s) | Lo último que dijo |', '|---|---|---|---|');
  for (const s of inst.steps) M.push(`| ${cell(s.what)} | ${cell(s.threw ? `tiró: ${s.threw}` : (s.error || s.exit))} | ${cell(s.seconds)} | ${cell(L.clip(T.lastLines(s.stderr || s.stdout, 2), 220))} |`);
  M.push('');
}
function sessionsTable(M, sessions) {
  if (!sessions || !sessions.length) return;
  M.push('| Sesión | Lanzada por | La línea de arranque | Otros hooks de arranque | Arnés | agent-skills | Lo que dijo |', '|---|---|---|---|---|---|---|');
  for (const s of sessions) {
    if (s.problem) { M.push(`| ${cell(s.label)} | ${cell(s.form)} | no corrió: ${cell(s.problem)} | — | — | — | — |`); continue; }
    const line = s.hooks.find((h) => h.startup);
    const others = s.hooks.filter((h) => !h.startup);
    const bad = others.filter((h) => h.error || h.exit !== 0);
    M.push(`| ${cell(s.label)} | ${cell(s.form)} | ${line ? `${line.startup === 'new' ? 'nueva' : 'vieja'} · salió ${cell(line.error || line.exit)} · ${Math.round(line.ms / 100) / 10} s` : 'no hay'} | ${others.length} (${bad.length} con error) | ${short(s.heads && s.heads.harness)} | ${short(s.heads && s.heads.skills)} | ${cell(L.clip(line ? (T.tellingLine(line.err) || L.firstLine(line.out)) : '', 200))} |`);
  }
  M.push('');
}
function photoLine(p) {
  if (!p) return '—';
  const s = p.settings || {};
  return `${s.hooks ? s.hooks.length : '?'} hook(s) · línea de arranque ${(s.startup_lines || []).map((l) => `${l.form === 'new' ? 'nueva' : 'vieja'} (${l.shell})`).join(', ') || 'ninguna'} · doctor ${p.doctor && p.doctor.readable ? `${p.doctor.mode}, ${p.doctor.fail.length} rojo(s), ${p.doctor.warn.length} aviso(s)` : 'ilegible'} · versión ${cell(p.version && p.version.text)} · arnés ${short(p.repos && p.repos.harness && p.repos.harness.head)}${oneClone(p) ? '' : ` · agent-skills ${short(p.repos && p.repos.skills && p.repos.skills.head)}`}`;
}
/** ¿La foto es de una instalación de un solo clon? (no trae un segundo repo: las skills viven en el del arnés) */
const oneClone = (p) => Boolean(p && p.repos && p.repos.harness && !p.repos.skills);
/** La forma del texto del alta que leyó un paso, dicha en una línea (los reportes viejos no la traen: nada). */
function shapeLine(M, step, when) {
  const shape = step && step.facts && step.facts.doc && step.facts.doc.shape;
  if (T.SHAPE_TEXT[shape]) M.push(`El texto del alta ${when} es de **${T.SHAPE_TEXT[shape]}**${shape === T.SHAPE.one ? ': un repo que trae las skills y los revisores, y un instalador que deja los enlaces, el import, la línea de arranque y los hooks' : ': el arnés y agent-skills, con los enlaces, el import y la línea de arranque a mano'}.`, '');
}

// ── el reporte de una corrida que siguió la página pública ───────────────────────────────────────────────────────

/** ¿Algún ensayo de este reporte siguió la página pública (lo que se ensayó es una copia publicada)? */
const isGuided = (report) => ['update', 'onboarding'].some((n) => { const s = stepOf(report, n); return Boolean(s && s.facts && s.facts.guided); });
const ENDED_TEXT = { cleaned: 'terminó y limpió', 'result-left': 'terminó y dejó su resultado', 'process-gone': 'su proceso ya no existía', 'not-finished': 'SEGUÍA VIVO al tope' };
const secs = (ms) => (typeof ms === 'number' ? Math.round(ms / 100) / 10 : '—');

/** Una fila por comando de la página: paso, quién, comando, cómo salió y lo esperado contra lo medido. */
function commandsTable(M, commands) {
  if (!commands || !commands.length) return;
  M.push('| Paso | Quién | Comando | Salió | Esperado contra medido |', '|---|---|---|---|---|');
  for (const c of commands) {
    const who = c.runs === 'person' ? 'la persona' : 'la máquina';
    if (c.not_comparable) { M.push(`| ${cell(c.step)} | ${who} | \`${cell(L.clip(c.text, 160))}\` | no corrió | no comparable: ${cell(c.not_comparable)} |`); continue; }
    if (c.skipped) { M.push(`| ${cell(c.step)} | ${who} | \`${cell(L.clip(c.text, 160))}\` | no corrió | ${cell(c.skipped)} |`); continue; }
    const checks = (c.expected || []).map((e) => (e.comparable === false
      ? `${e.what || e.kind}: dio ${e.measured} — no comparable: ${e.why}`
      : `${e.what || e.kind}: esperado ${e.expected}${e.kind === 'min' ? ' o más' : ''}, dio ${e.measured} — ${e.ok ? 'sí' : 'NO'}`));
    const noted = Object.entries(c.noted || {}).map(([k, val]) => `${k}: ${val === null ? 'no lo dijo' : val} (se anota, no se compara)`);
    // arrancó y no hay cómo salió: el paso se cortó con este comando corriendo
    if (c.started && c.exit === undefined && c.error === undefined) { M.push(`| ${cell(c.step)} | ${who} | \`${cell(L.clip(c.text, 160))}\` | NO VOLVIÓ (arrancó ${cell(c.started)} y el paso se cortó) | — |`); continue; }
    const missing = c.not_found && c.not_found.length ? ` · NO ENCONTRÓ: ${c.not_found.join(', ')}` : '';
    M.push(`| ${cell(c.step)} | ${who} | \`${cell(L.clip(c.text, 160))}\` | ${cell(c.error || c.exit)}${c.timed_out ? ' (venció su tope)' : ''}${missing ? cell(missing) : ''} | ${cell([...checks, ...noted].join(' · ') || 'nada que comparar')} |`);
  }
  M.push('');
}
function guidedSessionsTable(M, sessions) {
  const list = (sessions || []).filter(Boolean);
  if (!list.length) return;
  M.push('| Sesión | Lanzada por | La línea de arranque | ¿Se desprendió? | Esperó (s) | Cómo terminó la espera |', '|---|---|---|---|---|---|');
  for (const s of list) {
    if (s.problem) { M.push(`| ${cell(s.label)} | ${cell(s.form)} | no corrió: ${cell(s.problem)} | — | — | — |`); continue; }
    const line = (s.hooks || []).find((h) => h.startup);
    const w = s.wait || {};
    const failed = (s.hooks || []).filter((h) => !h.startup && (h.error || h.exit !== 0)).map((h) => `${h.hook} salió ${h.error || h.exit}`);
    const detached = s.wait ? (w.detached ? 'sí' : 'no') : 'no se midió';
    M.push(`| ${cell(s.label)} | ${cell(s.form)} | ${line ? `salió ${cell(line.error || line.exit)} · ${secs(line.ms)} s${s.version ? ` · quedó la versión ${cell(s.version)}` : ''}` : 'no hay'}${failed.length ? ` · otros hooks de arranque: ${cell(failed.join('; '))}` : ''} | ${detached} | ${w.detached ? secs(w.waited_ms) : (s.wait ? 0 : '—')} | ${w.detached ? cell(ENDED_TEXT[w.ended_by] || w.ended_by) : '—'} |`);
  }
  M.push('');
}
function guidedPhotoLine(p) {
  if (!p) return '—';
  const s = p.settings || {};
  return `${s.hooks ? s.hooks.length : '?'} hook(s) · línea de arranque ${(s.startup_lines || []).map((l) => l.shell).join(', ') || 'ninguna'} · doctor ${p.doctor && p.doctor.readable ? `${p.doctor.mode}, ${p.doctor.fail.length} rojo(s), ${p.doctor.warn.length} aviso(s)` : 'ilegible'} · versión ${cell(p.version && p.version.number)}`;
}
function teamSection(M, team) {
  if (!team) return;
  M.push('**La capa del equipo**', '');
  for (const c of team.commands || []) M.push(`- \`${cell(c.text)}\` salió ${cell(c.error || c.exit)}${c.out ? ` — ${cell(L.clip(c.out, 200))}` : ''}`);
  if (team.state) M.push(`- el estado dice: repo ${cell(team.state.repo)}, commit \`${short(team.state.commit)}\``);
  if (team.profile_origin) M.push(`- con origen en el perfil del equipo: ${cell(Object.keys(team.profile_origin).join(', ') || 'nada')}`);
  // tres estados: se miró y está, se miró y no está, no se llegó a mirar (la capa no se instaló)
  if ('version_json' in team) M.push(`- \`harness.js version --json\`: ${!team.version_json ? 'no se pudo leer' : (team.version_json.team ? `trae la capa, commit \`${short(team.version_json.team.commit)}\`` : 'NO trae la capa')}`);
  if ('doctor_line' in team) M.push(`- el diagnóstico: ${team.doctor_line ? cell(team.doctor_line) : (team.doctor && team.doctor.readable === false ? 'no se pudo leer' : 'NO nombra la capa')}${team.doctor && team.doctor.fail && team.doctor.fail.length ? ` — y trae en rojo: ${cell(team.doctor.fail.join(' · '))}` : ''}`);
  else M.push('- lo que el alta del equipo manda comprobar no se llegó a mirar: la capa no se instaló');
  M.push('');
  if (team.session) { M.push('La sesión con la capa puesta:', ''); guidedSessionsTable(M, [team.session]); }
}

/** El reporte de una corrida sobre una copia publicada: los dos ensayos siguieron la página pública de instalación. */
function renderGuided(report) {
  const v = report.verdict || {};
  const run = report.run || {};
  const M = [];
  const upd = stepOf(report, 'update');
  const onb = stepOf(report, 'onboarding');
  // cada dato común del laboratorio se toma del primer paso que LO TRAIGA: un paso que no pudo ensayar queda con
  // `guided` y nada más, y no tiene que dejar al reporte sin lo que el otro sí midió
  const guidedSteps = [onb, upd].filter((s) => s && s.facts && s.facts.guided);
  const from = (key) => { const s = guidedSteps.find((x) => x.facts[key] !== undefined && x.facts[key] !== null); return s ? s.facts[key] : undefined; };
  const any = { facts: { rehearsed_version: from('rehearsed_version'), page: from('page'), not_rehearsed: from('not_rehearsed') } };
  M.push('# El arnés en Windows — el ensayo sobre la página pública de instalación', '');
  M.push(`Ejecución **${run.id === null || run.id === undefined ? 'sin número' : run.id}**${run.number ? ` (${run.number})` : ''} · escenario \`${run.scenario || '—'}\` · ${run.platform || '—'}${run.lab_mode ? ' — **modo de laboratorio: esto NO es un Windows**' : ''} · Node ${run.node || '—'}`, '');
  if (run.commits && run.commits.harness) M.push('| Lo que se ensaya | Commit | Versión de la copia |', '|---|---|---|', `| una copia publicada del arnés | \`${short(run.commits.harness.today)}\` (${cell(run.commits.harness.today_ref)}) | ${cell(any.facts.rehearsed_version)} |`, '');
  M.push(`## Veredicto: ${v.color !== 'green' ? 'ROJO — NO se pudo ensayar' : (v.nothing_measured ? 'CON AVISOS — se pudo correr, pero ningún paso del escenario midió' : 'VERDE — se pudo ensayar')}`, '');
  M.push('El color dice si el ensayo PUDO CORRER, no si Windows anda bien: lo que encontró está abajo, con su gravedad.', '');
  const bullets = (title, items) => { if (items && items.length) { M.push(`**${title} (${items.length})**`, ''); for (const i of items) M.push(`- ${i}`); M.push(''); } };
  bullets('No pude ensayar', v.errors);
  bullets('Pasos que faltan', v.missing_steps);
  bullets('No medido', v.not_measured);
  if (v.by_severity) M.push(`Hallazgos: **${v.by_severity.breaks}** que rompen el trabajo del dev · **${v.by_severity['loses-control']}** que pierden un control · ${v.by_severity.noise} de ruido${v.by_severity.unrated ? ` · ${v.by_severity.unrated} de los pasos de medición (sin gravedad)` : ''}.`, '');
  const sev = (x) => (x && x.answers && x.answers.by_severity) || {};
  const variantsOf = (s) => (s && s.facts && s.facts.guided && s.facts.variants ? Object.entries(s.facts.variants) : []);
  // ── en corto
  if (variantsOf(onb).length) {
    M.push('## En corto — el alta', '', '| Máquina | ¿Puede trabajar? | Versión instalada | Rompe | Pierde un control | Ruido |', '|---|---|---|---|---|---|');
    for (const [id, x] of variantsOf(onb)) {
      if (x.not_run) { M.push(`| ${id} — ${cell(x.what)} | no corrió: ${cell(x.not_run)} | — | — | — | — |`); continue; }
      if (x.threw) { M.push(`| ${id} — ${cell(x.what)} | NO SE PUDO ENSAYAR entera — tiró: ${cell(x.threw)} | ${cell(x.version)} | ${cell(sev(x).breaks)} | ${cell(sev(x)['loses-control'])} | ${cell(sev(x).noise)} |`); continue; }
      // (tres estados: sin `left` la variante no llegó al juicio —el paso se cortó—, y «sin hallazgos» no es «frenó limpio»)
      if (x.followed_page === false) { M.push(`| ${id} — ${cell(x.what)} | la página manda parar: ${(onb.findings || []).some((f) => f.variant === id) ? 'NO frenó limpio' : (x.left ? 'frenó limpio y lo dijo' : 'no se terminó de medir')} | — | — | — | — |`); continue; }
      M.push(`| ${id} — ${cell(x.what)} | ${x.answers ? yes(x.answers.usable) : 'no se sabe'} | ${cell(x.version)} | ${cell(sev(x).breaks)} | ${cell(sev(x)['loses-control'])} | ${cell(sev(x).noise)} |`);
    }
    M.push('');
  }
  if (variantsOf(upd).length) {
    M.push('## En corto — la actualización', '', '| Máquina | Versión de antes | Versión publicada | Versión de después | ¿Sola? | Rompe | Pierde un control | Ruido |', '|---|---|---|---|---|---|---|---|');
    for (const [id, x] of variantsOf(upd)) {
      if (x.not_run) { M.push(`| ${id} — ${cell(x.what)} | no corrió: ${cell(x.not_run)} | — | — | — | — | — | — |`); continue; }
      const alone = id === 'auto' ? yes(x.updated_by_itself) : (id === 'ask' ? (x.changed_by_itself === undefined ? 'no se midió' : (x.changed_by_itself ? 'CAMBIÓ sin preguntar' : 'no cambió (pregunta)')) : yes(x.updated));
      M.push(`| ${id} — ${cell(x.what)} | ${cell(x.version_before)} | ${cell(x.version_published)} | ${cell(x.version_after)} | ${x.threw ? `NO SE PUDO ENSAYAR entera — tiró: ${cell(x.threw)}` : alone} | ${cell(sev(x).breaks)} | ${cell(sev(x)['loses-control'])} | ${cell(sev(x).noise)} |`);
    }
    M.push('');
  }
  M.push('## Los pasos', '', '| Paso | Estado | Hallazgos | Duró (s) | Tope (s) | Motivo |', '|---|---|---|---|---|---|');
  for (const s of report.steps || []) M.push(`| ${s.name} | ${STATUS_TEXT[s.status] || s.status} | ${(s.findings || []).length} | ${cell(s.wall_seconds)} | ${cell(s.cap_s)} | ${cell(s.reason)} |`);
  M.push('');
  const page = any.facts.page;
  const pageLine = page ? `La página \`${page.file}\` (marca \`${page.mark}\`, ${cell(page.page_steps)} pasos) del commit \`${short(page.at)}\`; el nombre del repo sale de \`${cell(page.page_name_from)}\` de ese mismo árbol.` : null;
  // ── el alta, variante por variante
  if (variantsOf(onb).length) {
    M.push('## El alta, siguiendo la página pública', '');
    if (pageLine) M.push(pageLine, '');
    for (const [id, x] of variantsOf(onb)) {
      M.push(`### ${id} — ${x.what || ''}`, '');
      if (x.not_run) { M.push(`No corrió: ${x.not_run}`, ''); continue; }
      if (x.threw) M.push(`La medición tiró: ${x.threw}${x.threw_at ? ` — en ${x.threw_at}` : ''}. Lo de abajo es lo que alcanzó a medir.`, '');
      commandsTable(M, x.commands);
      if (x.followed_page === false) {
        M.push(`No siguió la página: ${x.why}.`, '');
        if (x.tools) M.push(`El paso de las herramientas, con \`powershell\`: salió ${cell(x.tools.error || x.tools.exit)}; PowerShell ${cell(x.tools.powershell_version)}.`, '');
        if (x.off_page && x.off_page.length) {
          M.push('Fuera de la página (lo que encontraría quien siguiera igual):', '', '| Qué | Salió | Lo que contestó |', '|---|---|---|');
          for (const o of x.off_page) M.push(`| ${cell(o.what)} | ${cell(o.error || o.exit)} | ${cell(L.clip(o.said, 260))} |`);
          M.push('');
          if (x.script_placed_by_lab) M.push(`Nota: ${x.script_placed_by_lab}.`, '');
        }
        if (x.left) M.push(`Cómo quedó la máquina: ${x.left.after.harness_dir ? 'QUEDÓ' : 'sin'} la carpeta del arnés · settings.json ${x.left.after.settings_sha256 === x.left.before.settings_sha256 ? 'sin cambios' : 'CAMBIÓ'} · ${x.left.after.startup_line ? 'CON' : 'sin'} línea de arranque.`, '');
      }
      if (x.version) M.push(`Versión instalada: **${cell(x.version)}**. Cómo quedó: ${guidedPhotoLine(x.installed)}`, '');
      if (x.sessions) { M.push('La primera sesión (lo que corre solo al abrirla, sin apagar el desprendimiento del arranque):', ''); guidedSessionsTable(M, x.sessions); }
      teamSection(M, x.team);
      if (x.after_team) M.push(`Cómo quedó la máquina con la capa puesta: ${guidedPhotoLine(x.after_team)}${x.after_team.doctor && x.after_team.doctor.readable && x.after_team.doctor.fail.length ? ` — en rojo: ${cell(x.after_team.doctor.fail.join(' · '))}` : ''}`, '');
      M.push('**Lo que no quedó bien, con su gravedad**', '');
      pushFindings(M, (onb.findings || []).filter((f) => f.variant === id), `onboarding:${id}:`);
    }
  }
  // ── la actualización, variante por variante
  if (variantsOf(upd).length || (upd && upd.facts && upd.facts.guided)) {
    M.push('## La actualización, sobre una máquina instalada con la página', '');
    if (upd.facts.same_machine_note) M.push(upd.facts.same_machine_note, '');
    for (const [id, x] of variantsOf(upd)) {
      M.push(`### ${id} — ${x.what || ''}`, '');
      if (x.not_run) { M.push(`No corrió: ${x.not_run}`, ''); continue; }
      if (x.threw) M.push(`La medición tiró: ${x.threw}${x.threw_at ? ` — en ${x.threw_at}` : ''}. Lo de abajo es lo que alcanzó a medir.`, '');
      if (x.install) { M.push(`Instalada con los pasos ${cell((x.install.steps || []).join(', '))} de la página:`, ''); commandsTable(M, x.install.commands); }
      teamSection(M, x.team ? Object.assign({}, x.team, { session: null }) : null);
      M.push(`Versión de antes: **${cell(x.version_before)}** · publicada después: **${cell(x.version_published)}** · versión de después: **${cell(x.version_after)}**${x.pwsh_removed_from ? ` · \`pwsh\` fuera del PATH (se quitó ${cell(x.pwsh_removed_from.join(', '))})` : ''}.`, '');
      guidedSessionsTable(M, [x.settled, ...(x.sessions || [])]);
      if (x.by_hand) M.push(`\`harness.js update --yes\` ${x.by_hand.without_a_terminal ? 'lanzado sin una terminal' : 'a mano'}: salió ${cell(x.by_hand.error || x.by_hand.exit)} y quedó la versión ${cell(x.by_hand.version)}${x.by_hand.without_a_terminal ? ` (${x.by_hand.refused_cleanly === true ? 'se negó y dijo por qué: es lo esperado' : (x.by_hand.refused_cleanly === false ? 'NO se negó limpio' : 'no se juzgó si se negó: después no se pudo leer la versión')})` : ''}${x.by_hand.said ? ` — ${cell(x.by_hand.said)}` : ''}.`, '');
      const told = x.what_the_dev_is_told || (x.answers && x.answers.what_the_dev_is_told) || null;
      if (told) {
        M.push('**Lo que se le dijo a la persona**', '');
        if (Array.isArray(told)) { for (const l of told) M.push(`- ${l}`); if (!told.length) M.push('- nada'); } else {
          M.push(`- el aviso en el estado: ${told.state_notice ? cell(told.state_notice) : 'NO hay'}`);
          M.push(`- lo que dijo el hook de avisos en la sesión siguiente: ${told.hook_said ? cell(told.hook_said) : (told.hook_checked === false ? (x.changed_by_itself ? 'no se miró (la máquina cambió sola de versión: ése es el hallazgo, y el aviso ya no tiene por qué estar)' : 'no se miró (sin el aviso de la versión nueva en el estado no hay qué buscar en los hooks)') : 'NADA')}`);
        }
        M.push('');
      }
      if (x.something_tells) M.push(`¿Algo le avisa a la persona? Un hook de la sesión: ${x.something_tells.hook ? cell(x.something_tells.hook) : 'no'} · el diagnóstico: ${x.something_tells.doctor ? cell(x.something_tells.doctor) : 'no'}.`, '');
      if (x.before) M.push(`Antes: ${guidedPhotoLine(x.before)}`, '');
      if (x.after) M.push(`Después: ${guidedPhotoLine(x.after)}`, '');
      M.push('**Qué cambió, con su gravedad**', '');
      pushFindings(M, (upd.findings || []).filter((f) => f.variant === id), `update:${id}:`);
    }
  }
  // ── lo que es del paso y no de una variante (la red de abajo de los permisos, por ejemplo): se lista igual. Cuenta
  // en el total de arriba, y sin esto ningún renglón lo nombraría
  for (const s of guidedSteps) {
    const whole = (s.findings || []).filter((f) => !f.variant);
    if (!whole.length) continue;
    M.push(`## ${s.name}: hallazgos del paso entero (no de una variante)`, '');
    pushFindings(M, whole, `${s.name}:`);
  }
  // ── lo que el laboratorio cambió
  const lab = from('lab_changes');
  if (lab) {
    M.push('## Lo que el laboratorio cambió', '', 'Todo lo que se puso o se cambió respecto de la máquina de una persona. Ningún otro carácter de ningún comando de la página se toca.', '');
    if (lab.download_origin) M.push(`- el origen de la bajada del guion: \`${cell(lab.download_origin.from)}\` → \`${cell(lab.download_origin.to)}\` (en ${cell(lab.download_origin.where)})`);
    // la línea npx: el paquete armado en lugar del publicado, y la respuesta de la persona, dicha en
    // una línea para que el verde no se lea como «la persona no tuvo que hacer nada»
    if (lab.package) M.push(`- el paquete de npm: \`${cell(lab.package.from)}\` → \`${cell(lab.package.to)}\` (en ${cell(lab.package.where)}): ${cell(lab.package.why)}`);
    if (lab.answer) M.push(`- la respuesta de la persona: en el paso ${cell(lab.answer.step)} se sumó \`${cell(lab.answer.append)}\` — ${cell(lab.answer.why)}`);
    if (lab.public_routes) M.push(`- las rutas públicas del GitHub de juguete en los pasos con la línea npx (${cell(lab.public_routes.where)}): TYCON_RELEASE_GIT=${cell(lab.public_routes.TYCON_RELEASE_GIT)} · TYCON_RELEASE_ARCHIVE=${cell(lab.public_routes.TYCON_RELEASE_ARCHIVE)} · TYCON_RELEASE_RAW=${cell(lab.public_routes.TYCON_RELEASE_RAW)}`);
    if (lab.token) M.push(`- ${cell(lab.token)}`);
    if (lab.env_set) M.push(`- variables que se ponen: ${cell(Object.entries(lab.env_set).map(([k, val]) => `${k}=${val}`).join(' · '))}`);
    if (lab.env_set_with_team) M.push(`- desde que se suma la capa del equipo: ${cell(Object.entries(lab.env_set_with_team).map(([k, val]) => `${k}=${val}`).join(' · '))}`);
    if (lab.env_removed) M.push(`- variables de quien lanza que se borran: ${cell(lab.env_removed.join(', ') || 'ninguna')}`);
    if (lab.never_set) M.push(`- lo que NO se pone (una persona no lo tiene): ${cell(lab.never_set.join(', '))}`);
    if (lab.always) M.push(`- variables que se ponen siempre, para que nada de la medición salga de la carpeta de laboratorio: ${cell(Object.entries(lab.always).map(([k, val]) => `${k}=${val}`).join(' · '))}`);
    if (lab.launched_with) M.push(`- cada comando de la página se lanza con: ${cell(lab.launched_with)}`);
    if (lab.execution_policy) M.push(`- cada proceso se lanza con la política de ejecución en ${cell(lab.execution_policy.launched_with)}; la efectiva: ${cell(lab.execution_policy.effective)}`);
    // lo propio de cada variante, de los dos pasos
    for (const s of guidedSteps) {
      for (const [id, own] of Object.entries((s.facts.lab_changes && s.facts.lab_changes.by_variant) || {})) {
        const extra = [own.pwsh_removed_from ? `\`pwsh\` quitado del PATH${own.when ? ` ${own.when}` : ''} (${own.pwsh_removed_from.join(', ')})` : null, own.script_placed_by_lab || null].filter(Boolean);
        M.push(`- ${s.name} · ${id}: carpeta de usuario ${cell(own.user_folder)}, con \`${cell(own.shell)}\`${extra.length ? ` — ${cell(extra.join('; '))}` : ''}`);
      }
    }
    M.push('');
  }
  measureSteps(M, report);
  inventoryTable(M, report);
  // las notas de TODOS los pasos (un paso de medición sin hallazgos no imprime nada más: lo que no pudo medir va acá)
  const notes = (report.steps || []).flatMap((s) => ((s && s.notes) || []).map((n) => `${s.name}: ${n}`));
  if (notes.length) { M.push('## Notas del ensayo', ''); for (const n of notes) M.push(`- ${cell(n)}`); M.push(''); }
  const skipped = any.facts.not_rehearsed;
  M.push('## No ensayado', '');
  // sin la lista no es «nada quedó sin ensayar»: es que ningún paso llegó a anotarla
  if (!skipped) M.push('Ningún paso de esta ejecución llegó a anotar la lista de lo que no se ensaya (está en `scripts/tests/windows/guided-steps.json`): que acá no haya filas NO quiere decir que se ensayó todo.', '');
  else {
    M.push('| De la página | Qué | Por qué no |', '|---|---|---|');
    for (const n of skipped) M.push(`| ${cell(n.step ? `paso ${n.step}` : null)} | ${cell(n.what)} | ${cell(n.why)} |`);
  }
  M.push('', 'Tampoco lo puede ensayar un agente: con qué shell lanza el asistente cada hook (por eso cada sesión se lanza por las formas que la máquina tiene: están en las tablas, y la que faltó, en las notas), una máquina común (el agente corre como administrador y trae herramientas de más), un perfil dentro de OneDrive, un antivirus, una política de empresa.', '');
  return `${M.join('\n')}\n`;
}

/** Los pasos de medición reusados (los mismos del escenario `measure`), sobre lo que dejó el alta. */
function measureSteps(M, report) {
  for (const name of ['count-hooks', 'fire-registered']) {
    const s = stepOf(report, name);
    if (!s || !(s.findings || []).length) continue;
    M.push(`## ${name}, sobre lo que dejó el alta (${(s.facts && s.facts.variant) || '—'}): ${s.findings.length} hallazgo(s)`, '');
    for (const f of s.findings) M.push(`- \`${f.id}\`${f.closes_hint ? ` (la cierra ${f.closes_hint})` : ''} — ${f.detail}`);
    M.push('');
  }
}
function inventoryTable(M, report) {
  const inv = stepOf(report, 'inventory');
  if (!inv || !inv.facts || !inv.facts.tools) return;
  M.push('## Qué trae la máquina', '', '| Herramienta | Dónde | Versión |', '|---|---|---|');
  for (const name of ['git', 'node', 'pwsh', 'powershell', 'bash', 'python3', 'python', 'jq']) {
    const t = inv.facts.tools[name];
    if (t) M.push(`| ${name} | ${t.state === 'present' ? cell(t.locations[0]) : (t.state === 'absent' ? 'no está' : `no pude preguntar: ${cell(t.reason)}`)} | ${cell(t.version)} |`);
  }
  M.push('');
}

/** El resumen legible del reporte. El del escenario `portable` tiene su propia forma (`portable-report.js`). */
function renderMarkdown(report) {
  if (report && report.run && report.run.scenario === 'portable') return P.renderMarkdown(report);
  // sobre una copia publicada los dos ensayos siguen la página pública: otro reporte, sin viernes ni clones
  if (isGuided(report)) return renderGuided(report);
  const v = report.verdict || {};
  const run = report.run || {};
  const M = [];
  M.push('# El arnés del equipo en Windows — el ensayo (story 8.17, W0)', '');
  M.push(`Ejecución **${run.id === null || run.id === undefined ? 'sin número' : run.id}**${run.number ? ` (${run.number})` : ''} · escenario \`${run.scenario || '—'}\` · ${run.platform || '—'}${run.lab_mode ? ' — **modo de laboratorio: esto NO es un Windows**' : ''} · Node ${run.node || '—'}`, '');
  if (run.commits) {
    M.push('| Repo | El viernes | Hoy | Commits en el medio |', '|---|---|---|---|');
    // sin marca (un solo repo, y no se pasó una) no hay un viernes que mostrar
    M.push(`| arnés | ${run.commits.harness.friday ? `\`${short(run.commits.harness.friday)}\` (${cell(run.friday_tag)})` : '—'} | \`${short(run.commits.harness.today)}\` (${cell(run.commits.harness.today_ref)}) | ${cell(run.commits.harness.between)} |`);
    // con un solo repo las skills viven en el del arnés: no hay una fila que inventar
    if (run.commits.skills) M.push(`| agent-skills | \`${short(run.commits.skills.friday)}\` | \`${short(run.commits.skills.today)}\` (${cell(run.commits.skills.today_ref)}) | ${cell(run.commits.skills.between)} |`);
    M.push('');
  }
  M.push(`## Veredicto: ${v.color !== 'green' ? 'ROJO — NO se pudo ensayar' : (v.nothing_measured ? 'CON AVISOS — se pudo correr, pero ningún paso del escenario midió' : 'VERDE — se pudo ensayar')}`, '');
  M.push('El color dice si el ensayo PUDO CORRER, no si Windows anda bien: lo que encontró está abajo, con su gravedad.', '');
  const bullets = (title, items) => { if (items && items.length) { M.push(`**${title} (${items.length})**`, ''); for (const i of items) M.push(`- ${i}`); M.push(''); } };
  bullets('No pude ensayar', v.errors);
  bullets('Pasos que faltan', v.missing_steps);
  bullets('No medido', v.not_measured);
  if (v.by_severity) M.push(`Hallazgos: **${v.by_severity.breaks}** que rompen el trabajo del dev · **${v.by_severity['loses-control']}** que pierden un control · ${v.by_severity.noise} de ruido${v.by_severity.unrated ? ` · ${v.by_severity.unrated} de los pasos de medición (sin gravedad)` : ''}.`, '');

  const upd = stepOf(report, 'update');
  const onb = stepOf(report, 'onboarding');
  // ── en corto
  if (upd && upd.facts && upd.facts.variants) {
    M.push('## En corto — del viernes a hoy', '', '| Máquina | ¿Se actualizó sola? | ¿Quedó en lo de hoy? | ¿Quedó sana? | Rompe | Pierde un control | Ruido | doctor (rojos) | Hooks |', '|---|---|---|---|---|---|---|---|---|');
    for (const [id, x] of Object.entries(upd.facts.variants)) {
      if (x.not_run || !x.answers) { M.push(`| ${id} — ${cell(x.what)} | no corrió: ${cell(x.not_run || x.threw || 'el viernes no se pudo instalar')} | — | — | — | — | — | — | — |`); continue; }
      const a = x.answers;
      M.push(`| ${id} — ${cell(x.what)} | ${yes(x.updated_by_itself)} | ${yes(a.updated)} | ${yes(a.healthy)} | ${a.by_severity.breaks} | ${a.by_severity['loses-control']} | ${a.by_severity.noise} | ${cell(a.doctor.before)} → ${cell(a.doctor.after)} | ${cell(a.hooks.before)} → ${cell(a.hooks.after)} (siguen ${cell(a.hooks.kept)}) |`);
    }
    M.push('');
  }
  if (onb && onb.facts && onb.facts.variants) {
    M.push('## En corto — el alta de un dev nuevo', '', '| Máquina | ¿Puede trabajar? | Rompe | Pierde un control | Ruido | Hooks registrados | Faltan de la lista | doctor |', '|---|---|---|---|---|---|---|---|');
    for (const [id, x] of Object.entries(onb.facts.variants)) {
      if (x.not_run || !x.answers) { M.push(`| ${id} — ${cell(x.what)} | no corrió: ${cell(x.not_run || x.threw || (x.install && x.install.problem))} | — | — | — | — | — | — |`); continue; }
      const p = x.after_first_sessions || x.installed;
      M.push(`| ${id} — ${cell(x.what)} | ${yes(x.answers.usable)} | ${x.answers.by_severity.breaks} | ${x.answers.by_severity['loses-control']} | ${x.answers.by_severity.noise} | ${cell(p.settings.hooks ? p.settings.hooks.length : null)} | ${p.expected.problem ? '?' : `${p.expected.missing.length} de ${p.expected.expected_total}`} | ${p.doctor.readable ? `${p.doctor.mode}, ${p.doctor.fail.length} rojo(s)` : 'ilegible'} |`);
    }
    M.push('');
  }

  M.push('## Los pasos', '', '| Paso | Estado | Hallazgos | Duró (s) | Tope (s) | Motivo |', '|---|---|---|---|---|---|');
  for (const s of report.steps || []) M.push(`| ${s.name} | ${STATUS_TEXT[s.status] || s.status} | ${(s.findings || []).length} | ${cell(s.wall_seconds)} | ${cell(s.cap_s)} | ${cell(s.reason)} |`);
  M.push('');

  // ── update, variante por variante
  if (upd && upd.facts && upd.facts.variants) {
    M.push('## Del viernes a hoy, máquina por máquina', '');
    shapeLine(M, upd, 'del viernes');
    for (const [id, x] of Object.entries(upd.facts.variants)) {
      M.push(`### ${id} — ${x.what || ''}`, '');
      if (x.not_run) { M.push(`No corrió: ${x.not_run}`, ''); continue; }
      if (x.threw) M.push(`La medición tiró: ${x.threw}${x.threw_at ? ` — en ${x.threw_at}` : ''}. Lo de abajo es lo que alcanzó a medir.`, '');
      const fr = x.friday || {};
      if (fr.install) {
        M.push(`**El viernes** — instalada con \`${fr.install.ps}\`; ${fr.install.shape === T.SHAPE.one ? 'la línea de arranque que dejó el instalador' : `la línea de arranque que registró el dev (${cell(fr.install.startup_line && fr.install.startup_line.from)})`}:`, '', '```text', (fr.install.startup_line && fr.install.startup_line.command) || '—', '```', '');
        installTable(M, fr.install);
      }
      if (fr.session) sessionsTable(M, [fr.session]);
      if (x.before) M.push(`Foto del viernes: ${photoLine(x.before)}`, '');
      if (x.sessions) {
        M.push(`**Hoy** — ${x.weekend && x.weekend.done ? 'pasó el fin de semana (la última salida a la red quedó tres días atrás)' : `sin fin de semana que simular: ${x.weekend ? x.weekend.why : '—'}`}${x.pwsh_removed_from ? `; \`pwsh\` fuera del PATH (se quitó ${x.pwsh_removed_from.join(', ')})` : ''}.`, '');
        sessionsTable(M, x.sessions);
        if (x.by_hand && !x.by_hand.skills) M.push(`No se actualizó sola: el clon se avanzó a mano (\`git pull --ff-only\` salió ${cell(x.by_hand.harness.error || x.by_hand.harness.exit)}${x.by_hand.harness.said ? ` — ${x.by_hand.harness.said}` : ''}).`, '');
        else if (x.by_hand) M.push(`No se actualizó sola: los clones se avanzaron a mano (\`git pull --ff-only\`: arnés salió ${cell(x.by_hand.harness.error || x.by_hand.harness.exit)}${x.by_hand.harness.said ? ` — ${x.by_hand.harness.said}` : ''}; agent-skills salió ${cell(x.by_hand.skills.error || x.by_hand.skills.exit)}${x.by_hand.skills.said ? ` — ${x.by_hand.skills.said}` : ''}).`, '');
      }
      if (x.after) M.push(`Foto de hoy: ${photoLine(x.after)}`, '');
      if (x.answers && x.answers.what_the_dev_is_told.length) { M.push('Lo que el arranque le dice al dev (o deja en su registro):', ''); for (const l of x.answers.what_the_dev_is_told) M.push(`- ${l}`); M.push(''); }
      if (x.after && x.after.startup_log_tail && x.after.startup_log_tail.length) M.push('El final del registro de arranque:', '', '```text', ...x.after.startup_log_tail.slice(-8), '```', '');
      const mine = (upd.findings || []).filter((f) => f.variant === id);
      M.push('**Qué cambió, con su gravedad**', '');
      pushFindings(M, mine, `update:${id}:`);
    }
  }
  // ── onboarding, variante por variante
  if (onb && onb.facts && onb.facts.variants) {
    M.push('## El alta, máquina por máquina', '');
    shapeLine(M, onb, 'que se ensayó');
    for (const [id, x] of Object.entries(onb.facts.variants)) {
      M.push(`### ${id} — ${x.what || ''}`, '');
      if (x.not_run) { M.push(`No corrió: ${x.not_run}`, ''); continue; }
      if (x.threw) M.push(`La medición tiró: ${x.threw}${x.threw_at ? ` — en ${x.threw_at}` : ''}. Lo de abajo es lo que alcanzó a medir.`, '');
      if (x.install) {
        M.push(`Instalada con \`${x.install.ps}\`; ${x.install.shape === T.SHAPE.one ? 'la línea de arranque que dejó el instalador' : 'la línea de arranque del texto'}:`, '', '```text', (x.install.startup_line && x.install.startup_line.command) || '—', '```', '');
        installTable(M, x.install);
      }
      const p = x.installed;
      if (p) {
        M.push(`Cómo quedó: ${photoLine(p)}`, '');
        M.push('| Enlace de ~/.claude | ¿Está? | Tipo | ¿Llega a donde tiene que llegar? |', '|---|---|---|---|');
        for (const l of p.links) M.push(`| ${l.name} | ${yes(l.present)} | ${cell(l.kind)} | ${yes(l.ok)}${l.ok ? '' : ` (${cell(l.resolves_to || l.problem)})`} |`);
        M.push('');
        if (!p.expected.problem) M.push(`Hooks contra la lista del instalador (la de Mac y Linux): esperados ${p.expected.expected_total} · en su lugar ${p.expected.in_place} · faltan ${p.expected.missing.length} · repetidos ${p.expected.duplicated.length} · reemplazados que siguen sueltos ${p.expected.superseded.length} · sin archivo ${p.expected.dangling.length}`, '');
      }
      if (x.sessions) { M.push('La primera sesión (lo que corre solo al abrirla):', ''); sessionsTable(M, x.sessions); }
      if (x.after_first_sessions) M.push(`Después de la primera sesión: ${photoLine(x.after_first_sessions)}`, '');
      M.push('**Lo que no quedó bien, con su gravedad**', '');
      pushFindings(M, (onb.findings || []).filter((f) => f.variant === id), `onboarding:${id}:`);
    }
  }
  // ── finales de línea y PowerShell
  for (const s of [upd, onb].filter(Boolean)) {
    const eol = s.facts && s.facts.line_endings;
    if (!eol) continue;
    M.push(`## Finales de línea (paso ${s.name})`, '', '| Clon | .sh con \\r | .ps1 con \\r | core.autocrlf en el clon | .gitattributes | ¿bash lee el primero con \\r? |', '|---|---|---|---|---|---|');
    for (const [name, e] of Object.entries(eol)) M.push(e.problem ? `| ${name} | no pude medir: ${cell(e.problem)} | — | — | — | — |` : `| ${name} | ${e.sh.with_cr} de ${e.sh.total} | ${e.ps1.with_cr} de ${e.ps1.total} | ${cell(e.autocrlf_in_clone)} | ${e.gitattributes ? 'sí' : 'no'} | ${e.bash_reads_first ? `${e.bash_reads_first.exit === 0 ? 'sí' : 'NO'} (salió ${cell(e.bash_reads_first.error || e.bash_reads_first.exit)})` : '—'} |`);
    M.push('');
    break;
  }
  const reads = upd && upd.facts && upd.facts.powershell_reads;
  if (reads && reads.length) {
    M.push('## ¿Cada PowerShell puede leer los .ps1 del arnés de hoy?', '', '| PowerShell | Versión | Archivo | Errores de sintaxis | El primero |', '|---|---|---|---|---|');
    for (const r of reads) M.push(r.not_measured ? `| ${r.shell} | — | — | no medido: ${cell(r.not_measured)} | — |` : `| ${r.shell} | ${cell(r.version)} | ${cell(r.file)} | ${cell(r.parse_errors)} | ${cell(L.clip(r.first, 200))} |`);
    M.push('');
  }
  // ── los pasos de medición reusados
  for (const name of ['count-hooks', 'fire-registered']) {
    const s = stepOf(report, name);
    if (!s || !(s.findings || []).length) continue;
    M.push(`## ${name}, sobre lo que dejó el alta (${(s.facts && s.facts.variant) || '—'}): ${s.findings.length} hallazgo(s)`, '');
    for (const f of s.findings) M.push(`- \`${f.id}\`${f.closes_hint ? ` (la cierra ${f.closes_hint})` : ''} — ${f.detail}`);
    M.push('');
  }
  const inv = stepOf(report, 'inventory');
  if (inv && inv.facts && inv.facts.tools) {
    M.push('## Qué trae la máquina', '', '| Herramienta | Dónde | Versión |', '|---|---|---|');
    for (const name of ['git', 'node', 'pwsh', 'powershell', 'bash', 'python3', 'python', 'jq']) {
      const t = inv.facts.tools[name];
      if (t) M.push(`| ${name} | ${t.state === 'present' ? cell(t.locations[0]) : (t.state === 'absent' ? 'no está' : `no pude preguntar: ${cell(t.reason)}`)} | ${cell(t.version)} |`);
    }
    M.push('');
  }
  const skipped = (upd && upd.facts && upd.facts.not_rehearsed) || (onb && onb.facts && onb.facts.not_rehearsed) || T.NOT_REHEARSED;
  M.push('## No ensayado', '', '| Del alta | Qué | Por qué no |', '|---|---|---|');
  for (const n of skipped) M.push(`| ${cell(n.step)} | ${cell(n.what)} | ${cell(n.why)} |`);
  M.push('', 'Tampoco lo puede ensayar un agente: con qué shell lanza el asistente cada hook (por eso cada sesión se lanzó de dos formas), una máquina común (el agente corre como administrador y trae herramientas de más), un perfil dentro de OneDrive, un antivirus, una política de empresa.', '');
  return `${M.join('\n')}\n`;
}

// ── la línea de comandos ─────────────────────────────────────────────────────────────────────────────────────────

function cmdInit(args) {
  if (!args.lab || !args.out) return fail('faltan --lab <laboratorio> y --out <carpeta del reporte>');
  const r = initLab({ lab: path.resolve(args.lab), out: path.resolve(args.out), sources: args.sources ? path.resolve(args.sources) : null, scenario: args.scenario || 'all', meta: { id: args['run-id'] || null, number: args['run-number'] || null, harness_ref: args['harness-ref'] || null }, allowTemp: Boolean(args['allow-temp']), sameTree: Boolean(args['same-tree']) });
  if (!r.ok) { say(`##vso[task.logissue type=error]no pude ensayar: ${r.reason}`); return fail(`no pude ensayar: ${r.reason}`); }
  const c = r.meta.commits;
  say(`rehearse.js: laboratorio en ${path.resolve(args.lab)} · escenario ${r.meta.scenario} · arnés ${short(c.harness.friday)} → ${short(c.harness.today)}${c.skills ? ` · agent-skills ${short(c.skills.friday)} → ${short(c.skills.today)}` : ' · un solo repo'}`);
  return 0;
}

function cmdStep(name, args) {
  if (!STEP_ORDER.includes(name)) return fail(`paso desconocido: «${name}» (los que hay: ${STEP_ORDER.join(', ')})`);
  if (!args.out) return fail('falta --out <carpeta del reporte>');
  const out = path.resolve(args.out);
  let lab = null;
  if (name !== 'inventory') {
    if (!args.lab) return fail('falta --lab <laboratorio>');
    lab = path.resolve(args.lab);
    const problem = R.labRootProblem(lab, { allowTemp: Boolean(args['allow-temp']), needMark: true });
    if (problem) return fail(`no ensayo: ${problem}`);
  }
  const own = OWN_STEPS[name];
  const extra = own && own.args ? [...own.args] : [];
  if (own) for (const k of own.pass) { if (args[k] === true) extra.push(`--${k}`); else if (typeof args[k] === 'string') extra.push(`--${k}`, args[k]); }
  let step;
  try { step = R.runStep(name, own ? { lab, out, cap: args.cap || own.cap, script: own.script, args: extra } : { lab, out, cap: args.cap }); } catch (e) { return fail(`no pude escribir el resultado del paso ${name}: ${e.message}`); }
  say(`rehearse.js: ${name} → ${STATUS_TEXT[step.status]}${step.reason ? ` — ${step.reason}` : ''} · ${(step.findings || []).length} hallazgo(s) · ${step.wall_seconds} s`);
  if (step.status === L.STATUS.error) say(`##vso[task.logissue type=warning]${name}: ${step.reason}`);
  return 0;
}

function cmdFinish(args) {
  if (!args.out) return fail('falta --out <carpeta del reporte>');
  const out = path.resolve(args.out);
  const report = compose(out);
  report.verdict = verdict(report);
  try {
    fs.mkdirSync(out, { recursive: true });
    L.writeJsonAtomic(path.join(out, 'windows-report.json'), report);
    fs.writeFileSync(path.join(out, 'windows-report.md'), renderMarkdown(report));
  } catch (e) { return fail(`no pude escribir el reporte en ${out}: ${e.message}`); }
  say(`rehearse.js: reporte en ${path.join(out, 'windows-report.json')} y windows-report.md`);
  return 0;
}

function cmdVerdict(args) {
  if (!args.out) return fail('falta --out <carpeta del reporte>');
  let report;
  try { report = readJson(path.join(path.resolve(args.out), 'windows-report.json')); } catch (e) { return fail(`no pude leer el reporte: ${e.message} — sin reporte no hay veredicto`); }
  const v = report.verdict;
  if (!v) return fail('el reporte no trae veredicto (¿corrió «finish»?)');
  for (const s of report.steps || []) say(`  ${s.name.padEnd(16)} ${STATUS_TEXT[s.status] || s.status}${s.reason ? ` — ${s.reason}` : ''} · ${(s.findings || []).length} hallazgo(s)`);
  for (const l of [...v.errors.map((e) => `no pude ensayar — ${e}`), ...v.missing_steps.map((s) => `falta el paso ${s}: no corrió`)]) say(`##vso[task.logissue type=error]${l}`);
  // lo grave se dice en la corrida como aviso (no la pone roja): que nadie tenga que abrir el artefacto para enterarse
  for (const s of report.steps || []) for (const f of (s.findings || []).filter((x) => x.severity === T.SEVERITY.breaks)) say(`##vso[task.logissue type=warning]${T.SEVERITY_TEXT[f.severity]} — ${f.id}: ${L.clip(f.detail, 300)}`);
  // «no medido» no es un rojo, pero tampoco pasa callado: un aviso por paso, y si ningún paso del escenario midió la
  // corrida termina CON AVISOS —nunca en un verde liso que parezca un ensayo hecho—
  for (const l of v.not_measured || []) say(`##vso[task.logissue type=warning]no medido — ${L.clip(l, 400)}`);
  if (v.color === 'green' && v.nothing_measured) say('##vso[task.complete result=SucceededWithIssues;]ningún paso del escenario midió: la ejecución termina con avisos');
  if (report.run && report.run.scenario === 'portable') {
    // el «En corto», también en el registro de la corrida: que nadie tenga que abrir el artefacto para enterarse
    const rows = P.shortRows(report);
    for (const r of rows) say(`  ${r.match === true ? 'coincide ' : (r.match === false ? 'NO       ' : '—        ')} ${r.question} · ${r.what} — esperado: ${r.expected} · medido: ${r.measured}`);
    for (const r of rows.filter((x) => x.match === false)) say(`##vso[task.logissue type=warning]no coincide con lo esperado — ${r.what}: ${L.clip(r.measured, 300)}`);
    say(`rehearse.js: veredicto ${verdictText(v, 'medir')} · coinciden ${rows.filter((r) => r.match === true).length} · no coinciden ${rows.filter((r) => r.match === false).length} · sin nada que comparar ${rows.filter((r) => r.match === null).length}`);
    return v.color === 'green' ? 0 : 1;
  }
  say(`rehearse.js: veredicto ${verdictText(v, 'ensayar')} · rompe ${v.by_severity.breaks} · pierde un control ${v.by_severity['loses-control']} · ruido ${v.by_severity.noise}`);
  return v.color === 'green' ? 0 : 1;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') { say('uso: node scripts/tests/windows/rehearse.js init|step <paso>|finish|verdict|all … (ver la cabecera del archivo)'); return cmd ? 0 : 2; }
  const args = L.parseArgs(rest, OPTIONS);
  if (args.problem) return fail(args.problem);
  if (cmd === 'init') return cmdInit(args);
  if (cmd === 'step') return args._.length === 1 ? cmdStep(args._[0], args) : fail('uso: rehearse.js step <paso> --lab … --out …');
  if (cmd === 'finish') return cmdFinish(args);
  if (cmd === 'verdict') return cmdVerdict(args);
  if (cmd === 'all') {
    let rc = cmdInit(args);
    if (rc === 0) for (const name of SCENARIOS[args.scenario || 'all']) { rc = cmdStep(name, args); if (rc !== 0) break; }
    const wrote = cmdFinish(args);
    if (wrote !== 0) return wrote;
    const v = cmdVerdict(args);
    return rc !== 0 ? rc : v;
  }
  return fail(`subcomando desconocido: «${cmd}» (los que hay: init, step, finish, verdict, all)`);
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { SCENARIOS, STEP_ORDER, PORTABLE_STEPS, OWN_STEPS, initLab, compose, verdict, renderMarkdown };
