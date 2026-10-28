#!/usr/bin/env node
'use strict';
/**
 * portable-probe.js — la «base portable» del arnés, medida en un agente Windows: los finales de
 * línea de un clon nuevo y de uno que ya existía, el bash de Git, el banco de controles entero y los portones que
 * deciden por ruta. Es el escenario `portable` de `pipelines/azure-pipelines-windows.yml`; lo llama `rehearse.js`.
 *
 * POR QUÉ EXISTE. La base portable se escribió y se probó en una Mac, y todo el equipo trabaja en Windows: nada del arnés se
 * da por bueno hasta que corrió ahí. Lo que hay que medir quedó escrito bloque por bloque, con su salida esperada, en
 * el informe (`para-medir-en-windows.md`); esto lo corre sin pasos a mano y sin arreglar nada.
 *
 * LAS PARTES (`--part`), cada una un paso del pipeline con su tope:
 *   fresh-clone      `git clone` de los dos repos en el commit que se mide, con el `core.autocrlf` de la máquina: cuántos
 *                    guiones de bash (`.sh` y hooks de git) llegan con `\r`, y `eol.test.js` sobre ese clon.
 *   existing-clone   el clon de quien ya tenía el arnés: clonado en el «antes» (la rama principal), `git pull` a lo
 *                    que se mide, cuántos `\r` quedan, los dos caminos que parecen arreglarlo y no lo hacen, el paso
 *                    que normaliza, y la cuenta otra vez. `eol.test.js` antes y después del paso.
 *   git-bash         qué devuelve `findGitBash()` (`scripts/lib/git-bash.js --json`), la versión de ese bash, las tres
 *                    variantes del informe (sólo en Windows) y `git-bash.test.js`.
 *   suites           `bench-portable.test.js`, `windows-support.test.js` y `test-scope-table.test.js` (la tabla del freno
 *                    de pruebas sin alcance, corrida con el bash de Git).
 *   bench            el banco entero (`runner.js --tool claude`): un veredicto por caso. No abre ninguna sesión del
 *                    asistente: el banco dispara hooks; las sesiones las abren `live-fire.js` y `advisor-runner.js`,
 *                    que acá NO se corren y quedan como «no medido». Además: que el banco no escriba en la carpeta de
 *                    usuario de quien lo corre, y que sin Git for Windows diga «NO MEDIDO» sin imprimir un verde.
 *   path-shapes      los portones por ruta con las tres formas (`C:\a\b`, `C:/a/b`, `/c/a/b`): `runner.js --only forma-`,
 *                    y el aviso de ruta inexistente sin la variable `HOME`.
 * Las cuatro últimas corren sobre el clon nuevo que dejó `fresh-clone`.
 *
 * SIEMPRE `git clone`, NUNCA una copia de archivos: la conversión de finales de línea se aplica al clonar, y una copia
 * esconde justo lo que se mide. Los dos repos salen de los remotos del laboratorio (los bundles de `build-sources.js`).
 *
 * CADA COMANDO queda con su código de salida real, su tope y su salida entera en `<out>/steps/<parte>/NN-<id>.txt`.
 *
 * CÓMO FALLA. Lo que la medición encuentra es un HECHO del reporte y un hallazgo del paso: no pone roja la corrida. El
 * paso sale «error» sólo si no pudo medir: sin los remotos del laboratorio, sin el clon, o un banco que no deja un
 * reporte legible. Si el commit que se mide no trae la pieza (es anterior a la base portable), el paso sale «no medido», con su motivo.
 *
 * NUNCA LA CARPETA DE USUARIO REAL: todo corre con una carpeta de usuario del laboratorio (`lab.labHomeProblem`).
 *
 * Uso: node scripts/tests/windows/portable-probe.js --part <parte> --lab <laboratorio> --out <carpeta del reporte> [--allow-temp]
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('./lab.js');
const T = require('./team-lab.js');
const P = require('./portable-report.js');

const PARTS = Object.freeze(['fresh-clone', 'existing-clone', 'git-bash', 'suites', 'bench', 'path-shapes']);
const REPOS = Object.freeze([['harness', 'tycon-claude-guides'], ['skills', 'agent-skills']]);

/** El repo unido: el clon del arnés trae `agents/`, `skills/` o `packs/` en su raíz. */
const isUnified = (harnessDir) => ['agents', 'skills', 'packs'].some((d) => fs.existsSync(path.join(harnessDir, d)));
/** Qué carpeta de skills ven el banco y las suites: con un arnés unido, el propio clon; si no, el clon de agent-skills. */
const skillsFor = (pair, state) => (singleRepo(state) || isUnified(pair.harness) ? pair.harness : pair.skills);
/** Los repos que se miden: los que el laboratorio trae como remotos. Con un solo repo (las skills viven adentro), uno. */
const reposOf = (state) => REPOS.filter(([key]) => state.remotes[key]);
/** ¿El laboratorio trae un solo repo? (no hay remoto de un segundo: las skills sólo pueden estar en el clon del arnés) */
const singleRepo = (state) => Boolean(state && state.remotes && !state.remotes.skills);
/**
 * Con un solo repo las skills tienen que venir ADENTRO del clon: si no las trae no hay otra carpeta donde buscarlas, y
 * seguir sería medir con una carpeta de skills que no existe. El motivo, o `null`. Sólo se puede saber con el clon hecho.
 */
const skillsProblem = (state, clone) => (singleRepo(state) && !isUnified(clone)
  ? 'no pude medir: el laboratorio trae un solo repo y su árbol no trae las skills adentro (ni agents/, ni skills/, ni packs/): no hay skills con las que medir'
  : null);
const GIT_BASH_VAR = 'CLAUDE_CODE_GIT_BASH_PATH';
// El paso que normaliza el árbol de trabajo de un clon anterior a la regla (lo dice el informe y el propio
// `.gitattributes`). Va con el árbol limpio: descarta los cambios locales sin commitear de archivos versionados.
const NORMALIZE = Object.freeze([['rm', '--cached', '-r', '-q', '.'], ['reset', '--hard', '-q']]);
// Los dos caminos que parecen arreglarlo y no lo hacen: git no reescribe un archivo que el índice cree al día.
const PLAIN_RESTORE = Object.freeze([['checkout', '--', '.'], ['reset', '--hard', '-q']]);
const TEST_FILES = Object.freeze({
  'line-endings': 'scripts/tests/eol.test.js',
  'git-bash': 'scripts/tests/git-bash.test.js',
  'bench-portable': 'scripts/tests/bench-portable.test.js',
  'windows-support': 'scripts/tests/windows-support.test.js',
  'test-scope-table': 'scripts/tests/test-scope-table.test.js',
  // las del registro de hooks, el piso de Node, los frenos y el cierre: lo que se rompió en Windows tiene su suite
  // corrida en Windows
  'apply-hooks': 'scripts/tests/apply-hooks.test.js',
  'harness-node': 'scripts/tests/harness-node.test.sh',
  'story-gate': 'skills/tycon-pipeline/scripts/tests/story-gate.test.js',
  'ledger-visible': 'skills/tycon-pipeline/scripts/tests/ledger-visible.test.js',
  'safety-escape': 'scripts/tests/safety-escape.test.js',
  'run-close': 'skills/tycon-pipeline/scripts/tests/run-close.test.js',
  'pipeline-unit': 'skills/tycon-pipeline/scripts/tests/unit.test.js',
  // el conector de pedidos de trabajo: en Windows az es az.cmd y va por la consola
  'work-items-az': 'scripts/tests/work-items-az-windows.test.js',
});
const GIT_BASH = path.join(__dirname, '..', '..', 'lib', 'git-bash.js');
const FINDER = 'scripts/lib/git-bash.js';
const RUNNER = 'scripts/controls-bench/runner.js';
// los topes, en segundos
const CAP = Object.freeze({ git: 600, test: 900, quick: 120, bench: 5100, 'bench-part': 900, 'slow-test': 1800 });
// las suites que en Windows no entran en `test`: safety-escape, con 112 pruebas, pasa los 15 min (en la Mac tarda 9,5)
const SLOW_TESTS = new Set(['safety-escape']);

const say = (s) => process.stdout.write(`${s}\n`);
const isBashScript = (rel) => /\.sh$/.test(rel) || /^\.githooks\//.test(rel);
const lastLines = (text, n = 30) => String(text || '').split('\n').filter((l) => l.trim()).slice(-n).join('\n');

function places(lab) {
  const at = (kind) => Object.fromEntries(REPOS.map(([key, folder]) => [key, path.join(lab, 'portable', kind, folder)]));
  return { home: path.join(lab, 'users', 'portable'), fresh: at('fresh'), existing: at('existing') };
}

// ── contar ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Los guiones de bash versionados de un clon (`.sh` y los hooks de `.githooks/`) y cuántos tienen `\r` en el árbol de
 * trabajo: `{ total, with_cr, first, unreadable }` o `{ problem }`. La lista se pide entera, un nombre por línea, y se
 * filtra acá: un patrón en la línea de comandos o una lista separada por ceros dan «0 de 1».
 */
function scriptsWithCr(clone, env) {
  const r = L.run('git', ['-c', 'core.quotePath=false', '-C', clone, 'ls-files'], { env, cap: 16 * 1024 * 1024, timeoutMs: 120000 });
  if (r.error || r.exit !== 0) return { problem: `git ls-files ${r.error || `salió ${r.exit}`}: ${L.firstLine(r.stderr)}` };
  const files = r.stdout.split('\n').filter(Boolean).filter(isBashScript);
  const out = { total: files.length, with_cr: 0, first: [], unreadable: 0 };
  for (const f of files) {
    let bytes;
    try { bytes = fs.readFileSync(path.join(clone, f)); } catch (_) { out.unreadable++; continue; }
    if (bytes.includes(13)) { out.with_cr++; if (out.first.length < 20) out.first.push(f); }
  }
  return out;
}

/** Los archivos de una carpeta, con su ruta relativa. Para ver qué apareció en la carpeta de usuario del laboratorio. */
function listing(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out.push(path.relative(dir, p).replace(/\\/g, '/'));
    }
  };
  walk(dir);
  return out.sort();
}

// ── correr y guardar ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * El que corre los comandos de una parte. Cada uno deja su salida ENTERA (los dos canales, en orden) en
 * `<out>/steps/<parte>/NN-<id>.txt`, y en `commands` su código de salida real, lo que tardó y su tope. `record` recibe
 * la lista después de cada comando: si el paso se corta por su tope, lo que ya corrió queda en el parcial.
 */
function commandRunner({ out, part, clean = (s) => s, record = () => {} }) {
  const dir = path.join(out, 'steps', part);
  fs.mkdirSync(dir, { recursive: true });
  const commands = [];
  return {
    dir, commands,
    run(id, what, bin, args, { cwd, env, cap = CAP.quick, line = null } = {}) {
      const name = `${String(commands.length + 1).padStart(2, '0')}-${id}.txt`;
      const file = path.join(dir, name);
      const fd = fs.openSync(file, 'w');
      const t0 = Date.now();
      let r;
      try { r = spawnSync(bin, args, { cwd, env, stdio: ['ignore', fd, fd], timeout: cap * 1000, killSignal: 'SIGKILL', windowsHide: true }); } catch (e) { r = { status: null, error: e }; } finally { fs.closeSync(fd); }
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch (_) { text = ''; }
      const safe = clean(text);
      if (safe !== text) { try { fs.writeFileSync(file, safe); } catch (_) { /* queda como salió */ } }
      const code = r.error ? (r.error.code || r.error.message || 'error') : null;
      const c = {
        id, what, line: line || [path.basename(String(bin)), ...args].join(' '), exit: r.status === undefined ? null : r.status, error: code,
        timed_out: code === 'ETIMEDOUT', seconds: Math.round((Date.now() - t0) / 100) / 10, cap_s: cap, saved: `steps/${part}/${name}`,
      };
      commands.push(c);
      record(commands);
      say(`  ${part} · ${id}: ${c.timed_out ? `venció su tope de ${cap} s` : `salió ${c.error || c.exit}`} (${c.seconds} s)`);
      return Object.assign({ text: safe }, c);
    },
  };
}

/**
 * Corre una suite del clon (`node <archivo>`; una `.sh`, con el bash de Git `bash`) y devuelve sus totales. Si el clon
 * no la trae, o es una `.sh` y no hay bash, lo dice y no la corre.
 * `look` son cosas que su salida ENTERA tiene que decir (`{ nombre: expresión }`): quedan en `says`, por sí o por no.
 */
function runTest(runner, name, { clone, env, id = name, look = null, bash = null }) {
  const file = TEST_FILES[name];
  if (!fs.existsSync(path.join(clone, file))) return { file, not_run: `el commit que se mide no trae ${file}` };
  const sh = /\.sh$/.test(file);
  if (sh && !bash) return { file, not_run: `${file} es de bash y no hay bash de Git` };
  const cap = SLOW_TESTS.has(name) ? CAP['slow-test'] : CAP.test;
  const r = sh
    ? runner.run(id, `la suite ${path.basename(file)}`, bash, [file], { cwd: clone, env, cap, line: `<bash de findGitBash()> ${file}` })
    : runner.run(id, `la suite ${path.basename(file)}`, process.execPath, [file], { cwd: clone, env, cap, line: `node ${file}` });
  const t = Object.assign({ file, exit: r.exit, error: r.error, timed_out: r.timed_out, saved: r.saved }, sh ? P.parseShellSuite(r.text) : P.parseTap(r.text));
  if (look) t.says = Object.fromEntries(Object.entries(look).map(([k, rx]) => [k, rx.test(r.text)]));
  // de una suite que no pasó, el principio y el final de lo que dijo (entero está en `saved`)
  if (!P.testPassed(t)) t.tail = L.clip(lastLines(r.text, 400), 3000);
  return t;
}

const gitValue = (clone, args, env) => { const r = L.run('git', ['-C', clone, ...args], { env, timeoutMs: 60000, cap: 4000 }); return r.exit === 0 ? r.stdout.trim() : null; };
const autocrlfOf = (clone, env) => ({ value: gitValue(clone, ['config', '--get', 'core.autocrlf'], env) || null, origin: (gitValue(clone, ['config', '--show-origin', '--get-all', 'core.autocrlf'], env) || '').split('\n').map((l) => l.trim()).filter(Boolean) });

// ── las partes ───────────────────────────────────────────────────────────────────────────────────────────────────

/** 1 · el clon nuevo. */
function freshClone(ctx) {
  const { rec, runner, state, env, where } = ctx;
  const pointed = T.pointRemotes(state, 'target', env);
  if (pointed) return { status: L.STATUS.error, reason: `no pude medir: ${pointed}` };
  const repos = {};
  for (const [key, folder] of reposOf(state)) {
    const dir = where.fresh[key];
    if (fs.existsSync(dir)) return { status: L.STATUS.error, reason: `no pude medir: ${dir} ya existe — el laboratorio es de una sola ejecución` };
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    // 🔴 `git clone`, no una copia: el clon aplica core.autocrlf como en la máquina de un dev
    const c = runner.run(`clone-${key}`, `clonar ${folder} en lo que se mide`, 'git', ['clone', state.remotes[key].dir, dir], { env, cap: CAP.git, line: `git clone <remoto del laboratorio> ${folder}` });
    if (c.error || c.exit !== 0) return { status: L.STATUS.error, reason: `no pude medir: git clone de ${folder} ${c.timed_out ? 'venció su tope' : `salió ${c.error || c.exit}`} — ${L.firstLine(c.text)}` };
    const crlf = autocrlfOf(dir, env);
    repos[key] = { dir, head: gitValue(dir, ['rev-parse', 'HEAD'], env), autocrlf: crlf.value, autocrlf_origin: crlf.origin, gitattributes: fs.existsSync(path.join(dir, '.gitattributes')), scripts: scriptsWithCr(dir, env) };
    rec.fact('repos', repos);
    const s = repos[key].scripts;
    if (s.problem) rec.finding(`fresh-clone:${key}:not-counted`, 'line-endings', `no se pudieron contar los guiones de bash del clon nuevo de ${folder}: ${s.problem}`);
    else if (s.with_cr) rec.finding(`fresh-clone:${key}:scripts-with-cr`, 'line-endings', `${s.with_cr} de ${s.total} guiones de bash del clon nuevo de ${folder} llegaron con \\r (core.autocrlf: ${crlf.value || 'sin fijar'}; .gitattributes: ${repos[key].gitattributes ? 'sí' : 'no'}). Los primeros: ${s.first.slice(0, 5).join(', ')}`, 'W1');
    else if (!s.total) rec.finding(`fresh-clone:${key}:no-scripts`, 'line-endings', `el clon nuevo de ${folder} no trae ningún guion de bash que contar: un «0 de 0» no dice nada`);
  }
  const clone = where.fresh.harness;
  // un solo repo, y el clon no trae las skills adentro: no se sigue midiendo con una carpeta de skills que no existe
  const noSkills = skillsProblem(state, clone);
  if (noSkills) return { status: L.STATUS.error, reason: noSkills };
  // bash da por bueno un guion con \r\n que al correr falla: un «bash -n limpio» no alcanza
  const guard = 'scripts/hooks/safety-guard-pre.sh';
  const finder = path.join(clone, FINDER);
  if (fs.existsSync(finder) && fs.existsSync(path.join(clone, guard))) {
    const found = L.run(process.execPath, [finder], { cwd: clone, env, timeoutMs: 60000, cap: 2000 });
    const bash = found.exit === 0 ? L.firstLine(found.stdout) : null;
    if (bash) {
      const b = runner.run('bash-reads-a-script', 'bash lee (sin correr) un guion del clon nuevo', bash, ['-n', guard], { cwd: clone, env, line: `<bash de findGitBash()> -n ${guard}` });
      rec.fact('bash_reads', { file: guard, bash, exit: b.exit, error: b.error });
    } else rec.fact('bash_reads', { file: guard, not_measured: `findGitBash() no devolvió un bash (salió ${found.error || found.exit})` });
  }
  const tests = { 'line-endings': runTest(runner, 'line-endings', { clone, env: Object.assign({}, env, { TYCON_SKILLS_DIR: skillsFor(where.fresh, state) }) }) };
  rec.fact('tests', tests);
  const t = tests['line-endings'];
  if (!t.not_run && !P.testPassed(t)) rec.finding('fresh-clone:line-endings-test-failed', 'test', `eol.test.js sobre el clon nuevo ${t.timed_out ? 'venció su tope' : `salió ${t.error || t.exit}`}${t.first_failure ? ` — la primera que falla: ${t.first_failure}` : ''}`, 'W1');
  return { status: L.STATUS.measured, reason: null };
}

/** 2 · el clon que ya existía. */
function existingClone(ctx) {
  const { rec, runner, state, env, where } = ctx;
  for (const [key] of reposOf(state)) {
    if (state.remotes[key].base) continue;
    // Con un solo repo el «antes» puede no existir de verdad —lo que se mide es la rama principal y no se pasó una
    // marca, o no hay historia en común—: no hay un clon «que ya existía» que ensayar. No es un error: no medido, con
    // el motivo que dejó dicho quien armó el bundle. Con dos repos el bundle siempre trae su «antes»: que falte es un error.
    if (singleRepo(state)) {
      const why = state.sources && state.sources[key] && state.sources[key].no_base_reason;
      return { status: L.STATUS.notMeasured, reason: `no hay un «antes» del que arrancar el clon que ya existía: ${why || 'el bundle no trae la rama «base» ni dice por qué'}` };
    }
    return { status: L.STATUS.error, reason: 'no pude medir: los bundles no traen la rama «base» (de dónde arranca el clon que ya existía): los arma build-sources.js de esta rama' };
  }
  rec.fact('normalize_step', NORMALIZE.map((a) => `git ${a.join(' ')}`).join(' && '));
  const repos = {};
  const save = () => rec.fact('repos', repos);
  const stage = (key, id, withStatus) => {
    const dir = where.existing[key];
    const s = { scripts: scriptsWithCr(dir, env) };
    if (withStatus) {
      const st = L.run('git', ['-C', dir, 'status', '--porcelain'], { env, timeoutMs: 120000, cap: 200000 });
      const lines = st.exit === 0 ? st.stdout.split('\n').filter(Boolean) : null;
      s.status_lines = lines ? lines.length : null;
      s.status_first = lines ? lines.slice(0, 6) : null;
    }
    repos[key].stages[id] = s;
    save();
    return s;
  };
  // antes: el remoto parado en la rama principal, sin los cambios que se miden
  let pointed = T.pointRemotes(state, 'base', env);
  if (pointed) return { status: L.STATUS.error, reason: `no pude medir: ${pointed}` };
  for (const [key, folder] of reposOf(state)) {
    const dir = where.existing[key];
    if (fs.existsSync(dir)) return { status: L.STATUS.error, reason: `no pude medir: ${dir} ya existe — el laboratorio es de una sola ejecución` };
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const c = runner.run(`clone-${key}-at-base`, `clonar ${folder} como lo tiene hoy un dev (antes de la tanda)`, 'git', ['clone', state.remotes[key].dir, dir], { env, cap: CAP.git, line: `git clone <remoto del laboratorio, en el antes> ${folder}` });
    if (c.error || c.exit !== 0) return { status: L.STATUS.error, reason: `no pude medir: git clone de ${folder} ${c.timed_out ? 'venció su tope' : `salió ${c.error || c.exit}`} — ${L.firstLine(c.text)}` };
    const crlf = autocrlfOf(dir, env);
    repos[key] = { dir, base: state.remotes[key].base, target: state.remotes[key].target, autocrlf: crlf.value, autocrlf_origin: crlf.origin, gitattributes_at_base: fs.existsSync(path.join(dir, '.gitattributes')), stages: {} };
    const s = stage(key, 'at-base', false).scripts;
    // con el .gitattributes ya en el «antes» (una rama que sale del main actual), lo esperado es ninguno con \r
    if (repos[key].gitattributes_at_base) { if (!s.problem && s.with_cr) rec.finding(`existing-clone:${key}:base-has-cr`, 'line-endings', `el clon de ${folder} en el antes ya trae .gitattributes y aun así ${s.with_cr} de ${s.total} guiones de bash llegaron con \\r`); }
    else if (crlf.value === 'true' && !s.problem && s.with_cr !== s.total) rec.finding(`existing-clone:${key}:base-not-all-cr`, 'line-endings', `con core.autocrlf=true, el clon de ${folder} en el antes trae ${s.with_cr} de ${s.total} guiones de bash con \\r, no todos${repos[key].gitattributes_at_base ? ' (el antes ya trae .gitattributes)' : ''}`);
  }
  // llegan los cambios que se miden: el mismo `git pull` de siempre
  pointed = T.pointRemotes(state, 'target', env);
  if (pointed) return { status: L.STATUS.error, reason: `no pude medir: ${pointed}` };
  for (const [key, folder] of reposOf(state)) {
    const dir = where.existing[key];
    const p = runner.run(`pull-${key}`, `traer la tanda a ${folder}`, 'git', ['-C', dir, 'pull', '--ff-only'], { env, cap: CAP.git, line: 'git pull --ff-only' });
    repos[key].pull = { exit: p.exit, error: p.error, said: L.clip(lastLines(p.text, 3), 400) };
    repos[key].head_after_pull = gitValue(dir, ['rev-parse', 'HEAD'], env);
    repos[key].gitattributes_after_pull = fs.existsSync(path.join(dir, '.gitattributes'));
    const s = stage(key, 'after-pull', true);
    if (p.error || p.exit !== 0) rec.finding(`existing-clone:${key}:pull-failed`, 'update', `git pull --ff-only en el clon de ${folder} ${p.timed_out ? 'venció su tope' : `salió ${p.error || p.exit}`}: ${repos[key].pull.said}`);
    else if (repos[key].head_after_pull !== state.remotes[key].target) rec.finding(`existing-clone:${key}:pull-did-not-arrive`, 'update', `después del pull, el clon de ${folder} quedó en ${String(repos[key].head_after_pull).slice(0, 10)} y no en lo que se mide (${state.remotes[key].target.slice(0, 10)})`);
    if (s.status_lines) rec.finding(`existing-clone:${key}:dirty-after-pull`, 'line-endings', `después del pull, git status del clon de ${folder} muestra ${s.status_lines} archivo(s) modificado(s): ${s.status_first.join(' · ')}`, 'W1');
  }
  const clone = where.existing.harness;
  const noSkills = skillsProblem(state, clone);
  if (noSkills) return { status: L.STATUS.error, reason: noSkills };
  const testEnv = Object.assign({}, env, { TYCON_SKILLS_DIR: skillsFor(where.existing, state) });
  // la prueba corrida antes del paso sale roja y tiene que decir cómo se arregla: el paso, tal cual
  const tests = { 'before-normalize': runTest(runner, 'line-endings', { clone, env: testEnv, id: 'line-endings-before-normalize', look: { names_the_step: /git rm --cached -r -q \./ } }) };
  rec.fact('tests', tests);
  const left = reposOf(state).some(([key]) => (repos[key].stages['after-pull'].scripts.with_cr || 0) > 0);
  const before = tests['before-normalize'];
  if (!before.not_run && left && P.testPassed(before)) rec.finding('existing-clone:test-does-not-see-cr', 'test', 'quedaron guiones de bash con \\r después del pull y eol.test.js pasó igual: la prueba no los ve', 'W1');
  if (!before.not_run && left && !P.testPassed(before) && !before.says.names_the_step) rec.finding('existing-clone:test-does-not-name-the-step', 'test', 'eol.test.js sale rojo con los \\r que quedaron, y su salida no nombra el paso que normaliza (git rm --cached -r -q . && git reset --hard -q)', 'W1');
  if (!before.not_run && !left && !P.testPassed(before)) rec.finding('existing-clone:test-failed-before-normalize', 'test', `sin ningún guion de bash con \\r, eol.test.js ${before.timed_out ? 'venció su tope' : `salió ${before.error || before.exit}`}${before.first_failure ? ` — ${before.first_failure}` : ''}`, 'W1');
  // los dos caminos que parecen arreglarlo
  for (const [key, folder] of reposOf(state)) {
    const dir = where.existing[key];
    repos[key].plain_restore = PLAIN_RESTORE.map((args, i) => { const r = runner.run(`plain-restore-${key}-${i + 1}`, `${folder}: un camino que parece arreglarlo`, 'git', ['-C', dir, ...args], { env, cap: CAP.git, line: `git ${args.join(' ')}` }); return { exit: r.exit, error: r.error }; });
    const s = stage(key, 'after-plain-restore', false).scripts;
    const pulled = repos[key].stages['after-pull'].scripts;
    if (!s.problem && !pulled.problem && s.with_cr !== pulled.with_cr) rec.finding(`existing-clone:${key}:plain-restore-changed-the-count`, 'line-endings', `git checkout -- . y git reset --hard cambiaron la cuenta en el clon de ${folder}: de ${pulled.with_cr} a ${s.with_cr} guiones con \\r (en la Mac no cambiaban nada)`);
  }
  // el paso que normaliza
  for (const [key, folder] of reposOf(state)) {
    const dir = where.existing[key];
    repos[key].normalize = NORMALIZE.map((args, i) => { const r = runner.run(`normalize-${key}-${i + 1}`, `${folder}: el paso que normaliza`, 'git', ['-C', dir, ...args], { env, cap: CAP.git, line: `git ${args.join(' ')}` }); return { exit: r.exit, error: r.error, said: L.clip(lastLines(r.text, 3), 400) }; });
    const s = stage(key, 'after-normalize', true);
    const bad = repos[key].normalize.filter((c) => c.error || c.exit !== 0);
    if (bad.length) rec.finding(`existing-clone:${key}:normalize-failed`, 'line-endings', `el paso que normaliza, en el clon de ${folder}, salió ${repos[key].normalize.map((c) => c.error || c.exit).join(' y ')}: ${bad[0].said}`, 'W1');
    if (!s.scripts.problem && s.scripts.with_cr) rec.finding(`existing-clone:${key}:cr-left-after-normalize`, 'line-endings', `después del paso que normaliza quedan ${s.scripts.with_cr} de ${s.scripts.total} guiones de bash con \\r en el clon de ${folder}: ${s.scripts.first.slice(0, 5).join(', ')}`, 'W1');
    if (s.status_lines) rec.finding(`existing-clone:${key}:dirty-after-normalize`, 'line-endings', `después del paso que normaliza, git status del clon de ${folder} muestra ${s.status_lines} archivo(s): ${s.status_first.join(' · ')}`, 'W1');
  }
  tests['after-normalize'] = runTest(runner, 'line-endings', { clone, env: testEnv, id: 'line-endings-after-normalize' });
  rec.fact('tests', tests);
  const after = tests['after-normalize'];
  if (!after.not_run && !P.testPassed(after)) rec.finding('existing-clone:test-failed-after-normalize', 'test', `después del paso que normaliza, eol.test.js ${after.timed_out ? 'venció su tope' : `salió ${after.error || after.exit}`}${after.first_failure ? ` — la primera que falla: ${after.first_failure}` : ''}`, 'W1');
  return { status: L.STATUS.measured, reason: null };
}

/** Lo que imprime `git-bash.js --json`, o `null`. */
function parseFound(text) {
  const line = String(text || '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('{'));
  try { return line ? JSON.parse(line) : null; } catch (_) { return null; }
}

/** 3 · el bash de Git. */
function gitBash(ctx) {
  const { rec, runner, env, clone, platform } = ctx;
  if (!fs.existsSync(path.join(clone, FINDER))) return { status: L.STATUS.notMeasured, reason: `el commit que se mide no trae ${FINDER} (¿es anterior a la tanda W1?)` };
  const ask = (id, what, askEnv, bin = process.execPath) => {
    const r = runner.run(id, what, bin, [FINDER, '--json'], { cwd: clone, env: askEnv, line: `node ${FINDER} --json` });
    return Object.assign({ exit: r.exit, error: r.error }, parseFound(r.text) || { path: null, source: null, reason: `no devolvió JSON: ${L.clip(L.firstLine(r.text), 200)}` });
  };
  const plain = Object.assign({}, env);
  L.setEnv(plain, GIT_BASH_VAR, null);
  const found = ask('find', 'findGitBash() con el ambiente de la máquina', plain);
  rec.fact('found', Object.assign({ platform }, found));
  if (!found.path) rec.finding('git-bash:not-found', 'git-bash', `findGitBash() no encontró el bash de Git (salió ${found.error || found.exit}): ${found.reason || 'sin motivo'}`, 'W1');
  else if (P.isWslLauncher(found.path)) rec.finding('git-bash:wsl-launcher', 'git-bash', `findGitBash() devolvió el lanzador de WSL: ${found.path}`, 'W1');
  if (found.path) {
    const ver = runner.run('version', 'la versión de ese bash', found.path, ['--version'], { cwd: clone, env: plain, line: '<bash de findGitBash()> --version' });
    rec.fact('version', ver.exit === 0 ? L.firstLine(ver.text) : `no contestó (salió ${ver.error || ver.exit})`);
  }
  // las tres variantes del informe: son de Windows (fuera de él no hay lanzador de WSL ni carpetas por defecto)
  const variants = [];
  if (!L.isWin(platform)) rec.fact('not_measured', [{ what: 'las tres variantes de `findGitBash()`: la variable hacia el lanzador de WSL, la variable hacia otro bash de Git, y el PATH sin Git', why: 'son de Windows: en modo de laboratorio no hay lanzador de WSL ni carpetas de instalación por defecto' }]);
  else if (found.path) {
    const W = path.win32;
    const system32 = W.join(env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows', 'System32');
    const same = (a, b) => Boolean(a) && Boolean(b) && L.samePath(a, b, 'win32');
    // a · la variable apunta al lanzador de WSL: no se acepta
    const launcher = W.join(system32, 'bash.exe');
    const a = ask('variable-points-to-wsl-launcher', `con ${GIT_BASH_VAR} hacia el lanzador de WSL`, Object.assign({}, plain, { [GIT_BASH_VAR]: launcher }));
    variants.push({ id: 'variable-points-to-wsl-launcher', what: `\`findGitBash()\` con la variable hacia \`${launcher}\``, expected: 'el mismo bash de Git: la variable no se acepta', path: a.path, source: a.source, exit: a.exit, ok: same(a.path, found.path) && a.source !== 'env' });
    // b · la variable apunta a otro bash de Git: manda la variable
    const other = [found.path.replace(/([\\/])bin([\\/])bash\.exe$/i, '$1usr$2bin$2bash.exe'), W.join(env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'bash.exe')].find((p) => !same(p, found.path) && fs.existsSync(p));
    if (!other) variants.push({ id: 'variable-points-to-git-bash', what: '`findGitBash()` con la variable hacia otro bash de Git', expected: 'esa ruta, de: env', not_measured: 'no encontré otro bash.exe de Git (usr\\bin) al que apuntar' });
    else {
      const b = ask('variable-points-to-git-bash', `con ${GIT_BASH_VAR} hacia otro bash de Git`, Object.assign({}, plain, { [GIT_BASH_VAR]: other }));
      variants.push({ id: 'variable-points-to-git-bash', what: `\`findGitBash()\` con la variable hacia \`${other}\``, expected: 'esa ruta, de: env', path: b.path, source: b.source, exit: b.exit, ok: same(b.path, other) && b.source === 'env' });
    }
    // c · sin Git en el PATH: las carpetas de instalación por defecto
    const defaults = [W.join(env.ProgramFiles || 'C:\\Program Files', 'Git'), W.join(env.LOCALAPPDATA || '', 'Programs', 'Git')].filter((d) => fs.existsSync(W.join(d, 'bin', 'bash.exe')) || fs.existsSync(W.join(d, 'usr', 'bin', 'bash.exe')));
    if (!defaults.length) variants.push({ id: 'path-without-git', what: '`findGitBash()` con el PATH sólo en System32', expected: 'el de la carpeta de instalación por defecto, de: default', not_measured: 'esta máquina no tiene Git for Windows en ninguna de las dos carpetas por defecto' });
    else {
      const bare = Object.assign({}, plain);
      L.setEnv(bare, 'PATH', system32);
      const c = ask('path-without-git', 'con el PATH sólo en System32', bare);
      variants.push({ id: 'path-without-git', what: '`findGitBash()` con el PATH sólo en System32', expected: `el de ${defaults[0]}, de: default`, path: c.path, source: c.source, exit: c.exit, ok: c.source === 'default' && defaults.some((d) => L.isInside(c.path, d, 'win32')) });
    }
    for (const v of variants.filter((x) => !x.not_measured && !x.ok)) rec.finding(`git-bash:variant:${v.id}`, 'git-bash', `${v.what}: se esperaba ${v.expected} y devolvió ${v.path || 'null'} (de: ${v.source || '—'})`, 'W1');
  }
  rec.fact('variants', variants);
  const tests = { 'git-bash': runTest(runner, 'git-bash', { clone, env: plain }) };
  rec.fact('tests', tests);
  const t = tests['git-bash'];
  if (!t.not_run && !P.testPassed(t)) rec.finding('git-bash:test-failed', 'test', `git-bash.test.js ${t.timed_out ? 'venció su tope' : `salió ${t.error || t.exit}`}${t.first_failure ? ` — la primera que falla: ${t.first_failure}` : ''}`, 'W1');
  return { status: L.STATUS.measured, reason: null };
}

/**
 * 6 · las suites: dos que no usan bash para armar nada, la tabla del freno de pruebas por el bash de Git, y las del
 * registro de hooks, el piso de Node, los frenos y el cierre (la de bash, con el bash de Git).
 */
function suites(ctx) {
  const { rec, runner, env, clone, platform } = ctx;
  let bash = null;
  try { bash = require(GIT_BASH).findGitBash({ platform, env }).path || null; } catch (_) { bash = null; }
  rec.fact('suites_bash', bash);
  const tests = {};
  for (const name of P.SUITES) {
    tests[name] = runTest(runner, name, { clone, env, bash });
    rec.fact('tests', tests);
    const t = tests[name];
    if (!t.not_run && !P.testPassed(t)) rec.finding(`suites:${name}-failed`, 'test', `${path.basename(t.file)} ${t.timed_out ? 'venció su tope' : `salió ${t.error || t.exit}`}${t.first_failure ? ` — la primera que falla: ${t.first_failure}` : ''}${name === 'bench-portable' ? '. Con esta suite en rojo, lo que diga el banco entero no es de fiar' : ''}`, 'W1');
  }
  if (Object.values(tests).every((t) => t.not_run)) return { status: L.STATUS.notMeasured, reason: `el commit que se mide no trae ninguna de las suites (¿es anterior a la tanda W1?): ${Object.values(tests).map((t) => t.not_run).join(' · ')}` };
  return { status: L.STATUS.measured, reason: null };
}

/** Corre el banco con `--json` y devuelve `{ command, doc, problem }`. */
function runBench(runner, id, what, extra, { clone, env, cap }) {
  const file = path.join(runner.dir, `${id}.json`);
  fs.rmSync(file, { force: true });
  const r = runner.run(id, what, process.execPath, [RUNNER, '--tool', 'claude', ...extra, '--json', file], { cwd: clone, env, cap, line: `node ${RUNNER} --tool claude ${[...extra, '--json', `steps/${path.basename(runner.dir)}/${id}.json`].join(' ')}` });
  let doc = null;
  let problem = null;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { problem = `${r.timed_out ? `venció su tope de ${cap} s` : `salió ${r.error || r.exit}`} y no dejó un reporte legible (${e.code || e.message}): ${L.clip(lastLines(r.text, 2), 400)}`; }
  return { command: r, doc, problem };
}

/** 4 · el banco de controles entero. */
function bench(ctx) {
  const { rec, runner, env, clone, platform, where } = ctx;
  if (!fs.existsSync(path.join(clone, RUNNER))) return { status: L.STATUS.error, reason: `no pude medir: el clon no trae ${RUNNER}` };
  // el disparo real y el examen de los revisores abren sesiones del asistente: acá no se corren, y queda dicho
  rec.fact('sessions_opened', 0);
  const list = runner.run('list', 'la lista de casos del banco', process.execPath, [RUNNER, '--tool', 'claude', '--list'], { cwd: clone, env, cap: CAP.quick, line: `node ${RUNNER} --tool claude --list` });
  const listed = list.exit === 0 ? P.parseBenchList(list.text) : null;
  rec.fact('listed', listed ? listed.length : null);
  const before = listing(where.home);
  const run = runBench(runner, 'bench', 'el banco entero, sin abrir ninguna sesión del asistente', [], { clone, env, cap: CAP.bench });
  rec.fact('exit', run.command.error || run.command.exit);
  const appeared = listing(where.home).filter((f) => !before.includes(f));
  rec.fact('user_folder', { home: where.home, appeared });
  if (appeared.length) rec.finding('bench:user-folder-written', 'isolation', `el banco dejó ${appeared.length} archivo(s) en la carpeta de usuario de quien lo corre (el aislamiento de algún caso falló): ${appeared.slice(0, 8).join(', ')}`, 'W1');
  if (!run.doc) return { status: L.STATUS.error, reason: `no pude medir: el banco ${run.problem}` };
  const summary = P.benchSummary(run.doc, { listed });
  L.writeJsonAtomic(path.join(runner.dir, 'verdicts.json'), { schema: L.SCHEMA, tool: 'claude', totals: summary.totals, verdicts: summary.verdicts, red: summary.red, not_measured: summary.not_measured, missing: summary.missing });
  const { verdicts, ...kept } = summary;
  rec.fact('summary', kept);
  if (!summary.readable) return { status: L.STATUS.error, reason: `no pude medir: ${summary.problem}` };
  for (const r of summary.red) rec.finding(`bench:red:${r.key}`, 'bench', `${r.key} (${r.type || 'caso'}) en rojo: ${L.clip(String(r.failures[0] || 'sin motivo'), 400)}`);
  for (const n of summary.not_measured) rec.finding(`bench:not-measured:${n.key}`, 'bench', `${n.key} quedó sin medir: ${L.clip(n.why, 300)}`);
  // sin la lista no se sabe qué casos faltan: eso se dice, nunca pasa como «no falta ninguno»
  if (!listed || !listed.length) rec.finding('bench:list-unreadable', 'bench', `no pude leer la lista de casos del banco (${list.timed_out ? 'venció su tope' : `salió ${list.error || list.exit}`}${listed && !listed.length ? ', sin ningún caso legible' : ''}): los casos que no aparecen en el reporte NO se midieron`);
  if (summary.missing.length) rec.finding('bench:missing-cases', 'bench', `${summary.missing.length} caso(s) de la lista no aparecen en el reporte del banco: ${summary.missing.slice(0, 10).join(', ')}`);
  if (!summary.totals.ran) rec.finding('bench:nothing-ran', 'bench', 'el banco no corrió ningún caso');
  // sin Git for Windows el banco tiene que negarse a medir, sin imprimir un verde (sólo se puede esconder en Windows)
  if (!L.isWin(platform)) rec.fact('without_git', { not_measured: 'sólo en Windows: fuera de él el banco usa el bash del PATH' });
  else {
    const hidden = Object.assign({}, env);
    const system32 = path.win32.join(env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows', 'System32');
    L.setEnv(hidden, 'PATH', system32);
    L.setEnv(hidden, 'ProgramFiles', 'C:\\no-such-folder');
    L.setEnv(hidden, 'LOCALAPPDATA', 'C:\\no-such-folder');
    L.setEnv(hidden, GIT_BASH_VAR, null);
    const r = runner.run('without-git', 'el banco con Git for Windows escondido', process.execPath, [RUNNER, '--tool', 'claude'], { cwd: clone, env: hidden, cap: CAP['bench-part'], line: `node ${RUNNER} --tool claude   (PATH sólo System32, sin las carpetas por defecto de Git)` });
    const fact = { exit: r.exit, error: r.error, says_not_measured: /NO MEDIDO: falta Git for Windows/.test(r.text), greens: (r.text.match(/^✅/gm) || []).length, said: L.clip(lastLines(r.text, 3), 500) };
    rec.fact('without_git', fact);
    if (!(fact.exit === 2 && fact.says_not_measured && fact.greens === 0)) rec.finding('bench:without-git:not-refused', 'bench', `con Git for Windows escondido el banco salió ${fact.error || fact.exit}, ${fact.says_not_measured ? 'dijo' : 'no dijo'} «NO MEDIDO» e imprimió ${fact.greens} ✅ (se esperaba: sale 2, lo dice, y ningún verde)`, 'W1');
  }
  return { status: L.STATUS.measured, reason: null };
}

/** 5 · los portones que deciden por ruta, con las tres formas. */
function pathShapes(ctx) {
  const { rec, runner, env, clone } = ctx;
  if (!fs.existsSync(path.join(clone, RUNNER))) return { status: L.STATUS.error, reason: `no pude medir: el clon no trae ${RUNNER}` };
  const forms = runBench(runner, 'shapes', 'los portones por ruta, en cada forma de ruta', ['--only', 'forma-'], { clone, env, cap: CAP['bench-part'] });
  const shapes = forms.doc ? P.shapesSummary(forms.doc) : { readable: false, problem: forms.problem };
  rec.fact('shapes', shapes);
  if (shapes.readable) {
    for (const s of [...Object.values(shapes.shapes), shapes.other]) for (const r of s.red_cases) rec.finding(`path-shapes:red:${r.key}`, 'path-shapes', `${r.key} en rojo: ${L.clip(String(r.failures[0] || 'sin motivo'), 400)}`, 'W1');
    if (!Object.values(shapes.shapes).some((s) => s.cases)) rec.finding('path-shapes:no-cases', 'path-shapes', 'el banco del commit que se mide no trae ningún caso de formas de ruta (¿es anterior a la tanda W1?)');
  }
  const home = runBench(runner, 'no-home', 'el aviso de ruta inexistente sin la variable HOME', ['--only', 'sin-HOME'], { clone, env, cap: CAP['bench-part'] });
  const s = home.doc ? P.benchSummary(home.doc) : null;
  const fact = s && s.readable ? { readable: true, ran: s.totals.ran, red: s.totals.red, not_measured: s.totals.not_measured, skipped: s.totals.skipped, red_cases: s.red } : { readable: false, problem: home.problem || (s && s.problem) };
  rec.fact('no_home', fact);
  if (fact.readable && (fact.red || !fact.ran)) rec.finding('path-shapes:no-home', 'path-shapes', fact.ran ? `el caso sin HOME salió rojo: ${L.clip(String((fact.red_cases[0] || {}).failures || ''), 300)}` : 'el banco no trae el caso «sin-HOME» (¿el commit es anterior a la tanda W1?)', 'W1');
  if (!shapes.readable) return { status: L.STATUS.error, reason: `no pude medir: el banco, corrido con --only forma-, ${shapes.problem}` };
  return { status: L.STATUS.measured, reason: null };
}

const RUN = Object.freeze({ 'fresh-clone': freshClone, 'existing-clone': existingClone, 'git-bash': gitBash, suites, bench, 'path-shapes': pathShapes });

// ── el paso ──────────────────────────────────────────────────────────────────────────────────────────────────────

function measure({ part, lab, out, platform = process.platform, baseEnv = process.env, allowTemp = false, rec }) {
  const state = T.readState(lab);
  if (!state) return { status: L.STATUS.error, reason: `no pude medir: ${lab} no trae los remotos del laboratorio (${T.STATE_FILE}): los deja «rehearse.js init»` };
  const where = places(lab);
  try { fs.mkdirSync(where.home, { recursive: true }); } catch (e) { return { status: L.STATUS.error, reason: `no pude medir: no pude crear ${where.home}: ${e.code || e.message}` }; }
  const problem = L.labHomeProblem(where.home, { labRoot: lab, platform, allowTemp });
  if (problem) return { status: L.STATUS.error, reason: `no pude medir: ${problem}` };
  // el clon nuevo de agent-skills es el que ven el banco y las suites: nunca el de la carpeta de usuario. Con un arnés
  // del repo unido las skills son las del propio clon: el agent-skills anterior a la unión está
  // congelado en el corte y el banco actual, leído contra él, daría rojos que no son del arnés
  const env = L.labEnv(where.home, { base: baseEnv, platform, extra: { TYCON_SKILLS_DIR: skillsFor(where.fresh, state) } });
  // Si a este guion lo lanza una prueba de `node --test`, esa variable llega heredada y las suites que se miden
  // escribirían su resultado en el formato interno de Node, no en el que se lee acá.
  L.setEnv(env, 'NODE_TEST_CONTEXT', null);
  const seen = L.run(process.execPath, ['-e', 'process.stdout.write(require("os").homedir())'], { env, timeoutMs: 30000, cap: 600 });
  if (seen.exit !== 0 || !L.samePath(L.realOrSelf(seen.stdout.trim()), L.realOrSelf(where.home), platform)) return { status: L.STATUS.error, reason: `no pude medir: os.homedir() devuelve «${seen.stdout.trim()}», no la carpeta de laboratorio` };
  const clean = L.redactor({ secrets: L.secretValues(baseEnv) });
  rec.setRedactor(clean);
  const clone = where.fresh.harness;
  if (!['fresh-clone', 'existing-clone'].includes(part) && !fs.existsSync(path.join(clone, '.git'))) return { status: L.STATUS.error, reason: `no pude medir: no está el clon nuevo del arnés (${clone}): lo deja el paso fresh-clone` };
  // con el clon ya hecho (toda parte menos las dos que clonan): un solo repo sin las skills adentro no se mide
  if (!['fresh-clone', 'existing-clone'].includes(part)) { const noSkills = skillsProblem(state, clone); if (noSkills) return { status: L.STATUS.error, reason: noSkills }; }
  // Qué se mide y dónde están las skills. `unified` mira el clon: en la parte que lo CREA todavía no existe, así que se
  // vuelve a anotar al terminar (sin esto, queda dicho «no unido» y una carpeta de skills que nunca va a existir).
  // Sin el clon (la parte que lo crea no llegó a hacerlo) no se sabe si trae las skills: se anota «no se sabe», no «no».
  const noteMeasured = () => {
    const cloned = fs.existsSync(path.join(where.fresh.harness, '.git'));
    rec.fact('measured', { harness: state.remotes.harness.target, skills: state.remotes.skills ? state.remotes.skills.target : null, skills_dir: cloned ? skillsFor(where.fresh, state) : null, unified: cloned ? isUnified(where.fresh.harness) : null });
  };
  noteMeasured();
  const runner = commandRunner({ out, part, clean, record: (list) => rec.fact('commands', list) });
  const result = RUN[part]({ rec, runner, state, env, where, clone, platform, lab, out });
  noteMeasured();
  return result;
}

function main(argv) {
  const args = L.parseArgs(argv, { '--part': 'value', '--lab': 'value', '--out': 'value', '--allow-temp': 'flag' });
  if (args.problem || !args.part || !args.lab || !args.out) { process.stderr.write(`portable-probe.js: ${args.problem || 'faltan --part <parte>, --lab <laboratorio> y --out <carpeta del reporte>'}\n`); return 2; }
  if (!PARTS.includes(args.part)) { process.stderr.write(`portable-probe.js: parte desconocida: «${args.part}» (las que hay: ${PARTS.join(', ')})\n`); return 2; }
  const lab = path.resolve(args.lab);
  if (!fs.existsSync(path.join(lab, L.LAB_MARK))) { process.stderr.write(`portable-probe.js: ${lab} no tiene la marca del laboratorio (${L.LAB_MARK}): no mido ni escribo nada\n`); return 2; }
  const out = path.resolve(args.out);
  const rec = L.recorder(args.part, out);
  let result;
  try { result = measure({ part: args.part, lab, out, allowTemp: Boolean(args['allow-temp']), rec }); } catch (e) {
    result = { status: L.STATUS.error, reason: `no pude medir: el paso tiró: ${e.message}` };
  }
  rec.finish(result.status, result.reason);
  say(`${args.part}: ${result.status === L.STATUS.measured ? `medido — ${rec.step.findings.length} hallazgo(s)` : result.reason}`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { PARTS, NORMALIZE, PLAIN_RESTORE, TEST_FILES, CAP, SLOW_TESTS, isBashScript, scriptsWithCr, listing, commandRunner, parseFound, places, isUnified, skillsFor, reposOf, singleRepo, skillsProblem, measure };
