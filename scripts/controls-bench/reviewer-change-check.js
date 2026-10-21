#!/usr/bin/env node
'use strict';
/**
 * reviewer-change-check.js — el examen de UN revisor y el control que frena un cambio de revisor que lo empeora.
 * Casos: scripts/tests/reviewer-change-check.test.js.
 *
 * POR QUÉ EXISTE. Un cambio a `agents/<revisor>.md` puede arreglar una cosa y romper otra, y el examen entero (martes
 * y viernes) tarda horas y llega tarde. Acá se corre sólo el examen del revisor que cambia (sus casos de
 * `cases/advisors/`, con las mismas reglas del examen) y el resultado queda en el commit, atado a la huella del archivo.
 * El control de CI exige ese resultado: sin él, con el de otra versión del archivo o con un puntaje menor que el de la
 * línea de base, el cambio no entra. «No pude correr el examen» nunca cuenta como «pasó».
 *
 * run    corre el examen del revisor y escribe `scripts/controls-bench/reviewer-exams/<revisor>.json`. El examen es
 *        completo o nada: tienen que correr todos los casos que la línea de base tiene para ese revisor. Si el puntaje
 *        supera a la línea de base, pisa en ella sólo las claves que corrieron (y agrega las nuevas); nunca borra.
 * check  mira los `agents/*.md` que cambia el diff y valida el resultado de cada uno, tal como queda en el commit (o en
 *        el índice con --staged): recalcula el puntaje desde los casos y lo compara contra la línea de base de la BASE
 *        del cambio (con --staged, la de HEAD), así que bajar la línea de base en el mismo cambio no baja la vara.
 *
 * Uso:
 *   node scripts/controls-bench/reviewer-change-check.js run --agent <revisor> [--runs N] [--repo <dir>] [--no-baseline-update]
 *   node scripts/controls-bench/reviewer-change-check.js check [--repo <dir>] [--base <ref>] [--staged] [--json]
 * Salida: run 0 si dejó el resultado · 2 si no pudo correr el examen. check 0 al día · 1 hay cambios sin examen válido.
 * Ambiente: TYCON_REVIEWER_EXAM_RUNNER (otro guion en lugar de advisor-runner.js, para pruebas).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { readEnv } = require(path.join(__dirname, '..', 'lib', 'legacy-names.js'));

const WHERE = 'scripts/controls-bench/reviewer-change-check.js';
const BASELINE_REL = 'scripts/controls-bench/baseline/claude-advisors.json';
const EXAMS_REL = 'scripts/controls-bench/reviewer-exams';
const AGENT_FILE = /^agents\/([^/]+)\.md$/;
const AGENT_NAME = /^[A-Za-z0-9][\w.-]*$/;
const validAgentName = (name) => typeof name === 'string' && AGENT_NAME.test(name) && !name.includes('..');

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000, maxBuffer: 32 * 1024 * 1024 });
}
function gitOrNull(repo, args) {
  try { return git(repo, args); } catch (_e) { return null; }
}

const round4 = (n) => Number(n.toFixed(4));
const ratio = (passed, total) => (total > 0 ? round4(passed / total) : 0);
const commandFor = (agent) => `node scripts/controls-bench/reviewer-change-check.js run --agent ${agent}`;

/** Las claves de la línea de base que son de `agent`, con su valor. */
function baselineOf(cases, agent) {
  const out = {};
  for (const [k, v] of Object.entries(cases || {})) if (k.startsWith(`${agent}::`)) out[k] = v === true;
  return out;
}
function scoreOf(cases) {
  const vals = Object.values(cases);
  const passed = vals.filter(Boolean).length;
  return { passed, total: vals.length, score: ratio(passed, vals.length) };
}

// ── run ────────────────────────────────────────────────────────────────────────────────────────────────────────
function runExam({ repo, agent, runs, updateBaseline = true }) {
  if (!validAgentName(agent)) return { code: 2, lines: [`nombre de revisor inválido: ${JSON.stringify(agent)}`] };
  const fail = (msg) => ({ code: 2, lines: [`no pude correr el examen de ${agent}: ${msg}`] });
  const agentFile = path.join(repo, 'agents', `${agent}.md`);
  if (!fs.existsSync(agentFile)) return fail(`no existe agents/${agent}.md`);
  const baselinePath = path.join(repo, BASELINE_REL);
  let baselineDoc;
  try { baselineDoc = JSON.parse(fs.readFileSync(baselinePath, 'utf8')); }
  catch (e) { return fail(`no puedo leer la línea de base (${BASELINE_REL}): ${e.code || e.message}`); }
  const base = baselineOf(baselineDoc.cases, agent);

  const runner = readEnv('TYCON_REVIEWER_EXAM_RUNNER', { where: WHERE }) || path.join(__dirname, 'advisor-runner.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-exam-'));
  const reportPath = path.join(tmp, 'report.json');
  try {
    const args = [runner, '--tool', 'claude', '--only', `${agent}::`, ...(runs ? ['--runs', String(runs)] : []), '--json', reportPath];
    // el corredor lee el revisor de la carpeta instalada salvo que se le diga otra: se examina el del árbol que cambia
    const env = { ...process.env, TYCON_AGENTS_DIR: path.join(repo, 'agents') };
    const r = spawnSync(process.execPath, args, { cwd: repo, env, stdio: ['ignore', 'inherit', 'inherit'] });
    // el corredor sale 1 cuando algún caso quedó en rojo: es un examen que corrió (su informe dice cuáles); otra salida, no
    if (r.error || (r.status !== 0 && r.status !== 1)) return fail(`el corredor de casos salió con ${r.error ? r.error.message : `código ${r.status}`}`);
    let report;
    try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); }
    catch (_e) { return fail('el corredor no dejó un informe legible'); }

    const now = {};
    const skipped = [];
    for (const [key, res] of Object.entries((report && report.results) || {})) {
      if (!key.startsWith(`${agent}::`)) continue;
      const t = res && res.tools && res.tools.claude;
      if (!t || t.skipped) { skipped.push(key); continue; }
      now[key] = t.pass === true;
    }
    const incomplete = [...Object.keys(base).filter((k) => !(k in now)), ...skipped.filter((k) => !(k in base))];
    if (incomplete.length) return { code: 2, lines: [`examen incompleto: faltan/salteados ${[...new Set(incomplete)].sort().join(', ')}.`] };
    const total = Object.keys(now).length;
    if (!total) return fail('el revisor no tiene casos que hayan corrido');
    const passed = Object.values(now).filter(Boolean).length;
    const score = ratio(passed, total);
    const b = scoreOf(base);
    const regressions = Object.keys(now).filter((k) => base[k] === true && !now[k]);

    const doUpdate = updateBaseline && score > b.score;
    const result = {
      agent, file: `agents/${agent}.md`, hash: git(repo, ['hash-object', `agents/${agent}.md`]).trim(),
      passed, total, score, baseline: { passed: b.passed, total: b.total, score: b.score }, regressions, cases: now,
    };
    fs.mkdirSync(path.join(repo, EXAMS_REL), { recursive: true });
    fs.writeFileSync(path.join(repo, EXAMS_REL, `${agent}.json`), `${JSON.stringify(result, null, 2)}\n`);

    const lines = [`${agent}: puntaje ${passed}/${total} (línea de base ${b.passed}/${b.total}).`];
    if (regressions.length) lines.push(`Casos que dejaron de pasar: ${regressions.join(', ')}.`);
    if (doUpdate) {
      // la vara de un caso no baja: uno que pasaba sigue en verde aunque esta corrida lo haya perdido (va en regressions)
      const cases = { ...baselineDoc.cases };
      for (const [k, v] of Object.entries(now)) cases[k] = baselineDoc.cases[k] === true ? true : v;
      fs.writeFileSync(baselinePath, `${JSON.stringify({ ...baselineDoc, cases }, null, 2)}\n`);
      lines.push(`línea de base de ${agent} actualizada: ${BASELINE_REL}. Va en el mismo commit.`);
    } else if (score > b.score) {
      lines.push(`El puntaje supera a la línea de base, y no la toqué (--no-baseline-update).`);
    }
    lines.push(`Resultado: ${EXAMS_REL}/${agent}.json. Va en el mismo commit que el cambio del revisor.`);
    return { code: 0, lines };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── check ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** Los `agents/*.md` que existen en el cambio (los borrados no piden examen). */
function changedAgents(repo, base, staged) {
  const filter = '--diff-filter=ACMRT';
  let out;
  if (staged) out = gitOrNull(repo, ['diff', '--cached', '--name-only', filter]);
  else out = gitOrNull(repo, ['diff', '--name-only', filter, `${base}...HEAD`]) ?? gitOrNull(repo, ['diff', '--name-only', filter, base, 'HEAD']);
  if (out === null) return { error: staged ? 'no pude leer lo que está por commitearse (`git diff --cached`)' : `no pude comparar contra \`${base}\`` };
  return { agents: out.split('\n').map((f) => (AGENT_FILE.exec(f) || [])[1]).filter(Boolean) };
}

/** El resultado tiene la forma de un examen: huella de texto, casos booleanos y todos del revisor. */
function shapeProblem(res, agent) {
  if (!res || typeof res !== 'object' || Array.isArray(res)) return 'no es un objeto';
  if (typeof res.hash !== 'string' || !res.hash) return 'la huella no es un texto';
  const c = res.cases;
  if (!c || typeof c !== 'object' || Array.isArray(c) || !Object.keys(c).length) return 'los casos faltan o están vacíos';
  for (const [k, v] of Object.entries(c)) {
    if (!k.startsWith(`${agent}::`)) return `la clave ${k} no es de este revisor`;
    if (typeof v !== 'boolean') return `el caso ${k} no es verdadero ni falso`;
  }
  return null;
}

function checkReviewerChange({ repo, base, staged }) {
  const hallazgos = [];
  const avisos = [];
  const ch = changedAgents(repo, base, staged);
  if (ch.error) return { error: ch.error, hallazgos, avisos, revisados: [] };
  const tree = staged ? '' : 'HEAD';
  const treeBlob = (rel) => gitOrNull(repo, ['show', `${tree}:${rel}`]);
  const baselineFrom = (text) => {
    if (text === null) return null;
    try { const c = JSON.parse(text).cases; return c && typeof c === 'object' ? c : null; } catch (_e) { return null; }
  };

  // la línea de base de la BASE del cambio (con --staged, HEAD) y la del árbol del cambio
  const baseRef = staged ? 'HEAD' : base;
  let baseCases = null;
  let treeCases = null;
  if (ch.agents.length) {
    baseCases = baselineFrom(gitOrNull(repo, ['show', `${baseRef}:${BASELINE_REL}`]));
    treeCases = baselineFrom(treeBlob(BASELINE_REL));
  }

  for (const agent of ch.agents) {
    const archivo = `agents/${agent}.md`;
    const comando = commandFor(agent);
    const add = (regla, mensaje) => hallazgos.push({ archivo, regla, mensaje: `${agent}: ${mensaje}`, comando });

    const text = treeBlob(`${EXAMS_REL}/${agent}.json`);
    if (text === null) { add('reviewer-exam-missing', 'cambio sin el examen de ese revisor.'); continue; }
    let res;
    try { res = JSON.parse(text); } catch (_e) { add('reviewer-exam-unreadable', 'el resultado del examen no se puede leer.'); continue; }
    const problem = shapeProblem(res, agent);
    if (problem) { add('reviewer-exam-malformed', `el resultado del examen está mal formado: ${problem}.`); continue; }

    const hash = (gitOrNull(repo, ['rev-parse', `${tree}:${archivo}`]) || '').trim();
    if (!hash || res.hash !== hash) { add('reviewer-exam-stale', 'la ejecución es de otra versión del archivo.'); continue; }

    const mine = scoreOf(res.cases);
    if (res.passed !== mine.passed || res.total !== mine.total || res.score !== mine.score) {
      add('reviewer-exam-inconsistent', `el resultado no cuadra con sus casos (los casos dan ${mine.passed}/${mine.total}).`);
      continue;
    }

    let ref = baseCases === null ? {} : baselineOf(baseCases, agent);
    if (!Object.keys(ref).length) {
      ref = treeCases === null ? {} : baselineOf(treeCases, agent);
      if (!Object.keys(ref).length) { add('reviewer-baseline-unreadable', 'no hay línea de base de este revisor ni en la base ni en este árbol, así que no puedo comparar el puntaje.'); continue; }
      avisos.push({ archivo, regla: 'reviewer-new', mensaje: `${agent}: revisor nuevo: la línea de base nace con este cambio.` });
    }
    const notRun = Object.keys(ref).filter((k) => !(k in res.cases));
    if (notRun.length) { add('reviewer-exam-incomplete', `el examen no corrió ${notRun.join(', ')}.`); continue; }

    const b = scoreOf(ref);
    const lost = Object.keys(ref).filter((k) => ref[k] === true && res.cases[k] === false);
    if (mine.score < b.score) {
      add('reviewer-exam-lower', `puntaje ${mine.passed}/${mine.total} menor que el de la línea de base ${b.passed}/${b.total}.${lost.length ? ` Casos que dejaron de pasar: ${lost.join(', ')}.` : ''}`);
      continue;
    }
    if (lost.length) avisos.push({ archivo, regla: 'reviewer-case-regressed', mensaje: `${agent}: casos que dejaron de pasar aunque el puntaje no baja: ${lost.join(', ')}.` });
    const t = treeCases === null ? b : scoreOf(baselineOf(treeCases, agent));
    if (mine.score > t.score) {
      avisos.push({ archivo, regla: 'reviewer-baseline-outdated',
        mensaje: `${agent}: puntaje ${mine.passed}/${mine.total}, mejor que la línea de base ${t.passed}/${t.total}. Pasa; actualizá la línea de base: ${comando}` });
    }
  }
  return { hallazgos, avisos, revisados: ch.agents };
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────────────────────
function main(argv) {
  const cmd = argv[0];
  const arg = (n, def) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
  const repo = path.resolve(arg('--repo', process.cwd()));
  if (cmd === 'run') {
    const agent = arg('--agent');
    if (!agent) { console.error('uso: run --agent <revisor> [--runs N] [--repo <dir>] [--no-baseline-update]'); return 2; }
    const r = runExam({ repo, agent, runs: arg('--runs'), updateBaseline: !argv.includes('--no-baseline-update') });
    for (const l of r.lines) (r.code ? console.error : console.log)(l);
    return r.code;
  }
  if (cmd === 'check') {
    const staged = argv.includes('--staged');
    const base = arg('--base', process.env.TYCON_CI_BASE || 'origin/main');
    const r = checkReviewerChange({ repo, base, staged });
    if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return r.error || r.hallazgos.length ? 1 : 0; }
    if (r.error) { console.error(`${r.error}. No se da por bueno.`); return 1; }
    for (const a of r.avisos) console.log(`aviso: ${a.mensaje}`);
    if (!r.hallazgos.length) { console.log(`Cambios de revisores al día (${r.revisados.length} mirado(s)).`); return 0; }
    console.error(`${r.hallazgos.length} cambio(s) de revisor sin examen válido:`);
    for (const h of r.hallazgos) { console.error(`  ${h.mensaje}`); console.error(`    Comando: ${h.comando}`); }
    return 1;
  }
  console.error('uso: reviewer-change-check.js run|check (ver la cabecera)');
  return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { runExam, checkReviewerChange, commandFor };
