'use strict';

/**
 * main-check.test.js — el juez de la punta de main: un rojo que la foto y la base no perdonaron se mide sobre la última
 * versión de origin/main, en una copia que se reusa; si main falla igual, la corrida espera a main sin gastar vuelta.
 *
 * Todo corre sobre repos de juguete con un `origin` local (un repo desnudo) y una HOME de prueba: ninguna prueba trae el
 * origin real ni mide las suites reales de la máquina. Las suites de juguete son guiones de bash que salen con el código
 * de su archivo de estado y anotan cada corrida, así se puede afirmar «no corrió nada».
 *
 * stable-data: lee el reloj a propósito — el marcador falso lleva la hora de ahora para que marker.js no lo dé por
 * abandonado, y los candados de prueba llevan la hora de ahora para que no cuenten como vencidos.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const LIB = path.join(SCRIPTS, 'lib', 'main-check.js');
const INHERITED = path.join(SCRIPTS, 'lib', 'inherited-reds.js');
const MARKER_JS = path.join(SCRIPTS, 'marker.js');
const TEST_GATE = path.join(SCRIPTS, 'test-gate.sh');
const STOP_HOOK = path.join(SCRIPTS, 'on-stop-dod-gate.js');
const STEP_06 = path.resolve(SCRIPTS, '..', 'steps', 'step-06-run-tests.md');
const ROUNDS = path.join(SCRIPTS, 'lib', 'review-rounds.js');

const DEL_ENTORNO = ['NODE_TEST_CONTEXT', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'TYCON_TEST_SCOPE',
  'TYCON_TEST_GATE', 'TYCON_TEST_GATE_COMPANION', 'TYCON_TEST_GATE_PART', 'TYCON_TEST_GATE_MARK', 'TYCON_TEST_GATE_OUT_FILE',
  'TYCON_TEST_GATE_STORY_REPO', 'TYCON_EVIDENCE_DIR', 'TYCON_EVIDENCE_KEY', 'TYCON_EVIDENCE_KEY_FAILED', 'TYCON_COVERAGE_BASE',
  'TYCON_GUIDES_DIR', 'TCG', 'TYCON_COVERAGE_MIN', 'TYCON_MUTATION_CHECK', 'STOP_AUTONOMY', 'TYCON_HOME',
  'TYCON_HARNESS_LOCK_HELD', 'TYCON_GATE_ALL_SUITES', 'TYCON_SKILLS_DIR', 'TYCON_SUITE_RUNNER', 'TYCON_SUITE_TIMES',
  'TYCON_MAIN_CHECK', 'TYCON_MAIN_CHECK_MAX', 'TYCON_MAIN_CHECK_TIMEOUT_S', 'TYCON_MAIN_CHECK_LOCK_WAIT_S', 'TYCON_INHERITED_BASE_MAX'];

const A = 'tests/a.test.sh';
const B = 'tests/b.test.sh';
const C = 'tests/c.test.sh';
const D = 'tests/d.test.sh';
const S = 'tests/s.test.sh';
const SID = 'mc-sesion';
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const autor = ['-c', 'user.email=prueba@ejemplo.invalid', '-c', 'user.name=prueba'];

function git(d, ...a) {
  const fecha = '2026-01-01T00:00:00Z';
  return spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'core.hooksPath=/dev/null', ...autor, '-C', d, ...a], {
    // sin las variables de un gancho: con su GIT_DIR, `-C` no decide el repo y un `init --bare` deja pelado al de verdad
    encoding: 'utf8', env: require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'clean-git-env.js')).sinGitDelPadre({ GIT_AUTHOR_DATE: fecha, GIT_COMMITTER_DATE: fecha }),
  });
}
const sha = (d, ref = 'HEAD') => git(d, 'rev-parse', ref).stdout.trim();

/**
 * Una suite de bash: anota que corrió (en `$MC_STATE/corridas`, con el nombre y la carpeta en que corrió), imprime un
 * renglón de caso por cada nombre de `casos` y sale con el código de su archivo de estado (`$MC_STATE/<n>`; si no, el de
 * `fallback`).
 */
const suite = (n, { casos = [], fallback = 0, extra = '' } = {}) => `#!/usr/bin/env bash
${extra}
echo "${n} $(pwd)" >> "\${MC_STATE:-/dev/null}/corridas" 2>/dev/null || true
${casos.map((c) => `echo "✖ ${c}"`).join('\n')}
exit "$(cat "\${MC_STATE:-/nonexistent}/${n}" 2>/dev/null || echo ${fallback})"
`;

const lista = (nombres) => JSON.stringify({ diarias: nombres.map((n) => ({ raiz: 'arnes', ruta: `tests/${n}.test.sh` })), semanales: [] }, null, 2);

/**
 * El laboratorio: un repo desnudo (`origin`) con `main`, un clon en una rama `cambio`, una HOME de prueba, una carpeta
 * de estado para las suites y una de skills vacía. En main: a roja (caso a-1), b verde, c roja (caso c-1), s roja y
 * lenta. En el cambio: a roja igual, b roja (caso b-1), c roja con un caso más (c-1 y c-2), d nueva y roja, s igual.
 */
function lab({ conCambio = true } = {}) {
  const home = tmp('mc-home-');
  const state = tmp('mc-state-');
  const skills = tmp('mc-skills-');
  const remoto = tmp('mc-remoto-');
  git(remoto, 'init', '-q', '--bare', '-b', 'main');
  const repo = tmp('mc-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', remoto);
  const t = path.join(repo, 'scripts', 'tests');
  fs.mkdirSync(t, { recursive: true });
  const escribirMain = () => {
    fs.writeFileSync(path.join(t, 'suites.json'), lista(['a', 'b', 'c', 's']));
    fs.writeFileSync(path.join(t, 'a.test.sh'), suite('a', { casos: ['a-1'], fallback: 1 }));
    fs.writeFileSync(path.join(t, 'b.test.sh'), suite('b', { fallback: 0 }));
    fs.writeFileSync(path.join(t, 'c.test.sh'), suite('c', { casos: ['c-1'], fallback: 1 }));
    fs.writeFileSync(path.join(t, 's.test.sh'), suite('s', { fallback: 1, extra: 'sleep 20' }));
  };
  escribirMain();
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'x.md'), 'x\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.advisors/\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  const base = sha(repo);
  if (conCambio) {
    git(repo, 'checkout', '-q', '-b', 'cambio');
    fs.writeFileSync(path.join(t, 'suites.json'), lista(['a', 'b', 'c', 'd', 's']));
    fs.writeFileSync(path.join(t, 'b.test.sh'), suite('b', { casos: ['b-1'], fallback: 1 }));
    fs.writeFileSync(path.join(t, 'c.test.sh'), suite('c', { casos: ['c-1', 'c-2'], fallback: 1 }));
    fs.writeFileSync(path.join(t, 'd.test.sh'), suite('d', { casos: ['d-1'], fallback: 1 }));
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'el cambio');
  }
  return { home, state, skills, remoto, repo, base, copia: `${repo}--main-check` };
}

/** Un commit en main del remoto que arregla las suites dadas (salen 0), hecho desde otro clon. */
function arreglarMain(l, nombres) {
  const otro = tmp('mc-otro-');
  git(otro, 'clone', '-q', l.remoto, otro);
  for (const n of nombres) fs.writeFileSync(path.join(otro, 'scripts', 'tests', `${n}.test.sh`), suite(n, { fallback: 0 }));
  git(otro, 'add', '-A'); git(otro, 'commit', '-q', '-m', `arregla ${nombres.join(' ')}`);
  git(otro, 'push', '-q', 'origin', 'main');
  return sha(otro);
}

function entorno(l, extra = {}) {
  const env = { ...process.env };
  for (const k of DEL_ENTORNO) delete env[k];
  return { ...env, HOME: l.home, USERPROFILE: l.home, CLAUDE_CODE_SESSION_ID: SID, MC_STATE: l.state, TYCON_SKILLS_DIR: l.skills,
    TYCON_INHERITED_BASE_MAX: '0', TYCON_MAIN_CHECK_LOCK_WAIT_S: '2', ...extra };
}
const corridas = (l) => { try { return fs.readFileSync(path.join(l.state, 'corridas'), 'utf8').split('\n').filter(Boolean); } catch (_) { return []; } };
const limpiarCorridas = (l) => fs.rmSync(path.join(l.state, 'corridas'), { force: true });
const estado = (l, valores) => { for (const [n, v] of Object.entries(valores)) fs.writeFileSync(path.join(l.state, n), String(v)); };

const falla = (l, ruta, casos) => ({ ruta: path.join(l.repo, 'scripts', ruta), exit: 1, casos: casos.map((c) => `✖ ${c}`), entrada: { raiz: 'arnes', ruta } });
/** Un resumen de run-suites-json.js con esas fallas (`[ruta, casos]`). */
function resumen(l, fallas, extra = {}) {
  const f = path.join(tmp('mc-resumen-'), 'suites.json');
  fs.writeFileSync(f, JSON.stringify({ corridas: fallas.length + 1, verdes: 1, fallas: fallas.map(([ruta, casos]) => falla(l, ruta, casos)), ausentes: [],
    suites: [], unmeasured_suites: [], ...extra }, null, 2));
  return f;
}
const leer = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

/** `inherited-reds.js apply` con el tercer juez prendido (como lo llama el portón). */
function aplicar(l, f, extra = {}) {
  return spawnSync(process.execPath, [INHERITED, 'apply', l.repo, f], { encoding: 'utf8', env: entorno(l, { TYCON_MAIN_CHECK: '1', ...extra }), timeout: 120000 });
}
const veredicto = (j, ruta) => ((j.main_check || {}).suites || []).find((s) => s.ruta === ruta) || {};

/** Un guion de Node que usa la biblioteca, corrido en otro proceso con el ambiente del laboratorio. */
function conLib(l, codigo, extra = {}, { async = false } = {}) {
  const args = ['-e', `const mc = require(${JSON.stringify(LIB)}); ${codigo}`];
  const opts = { encoding: 'utf8', env: entorno(l, extra), timeout: 60000 };
  return async ? spawn(process.execPath, args, opts) : spawnSync(process.execPath, args, opts);
}
const estadoDe = (l) => {
  const dir = path.join(l.home, '.claude', '.tycon-pipeline', 'main-check');
  const f = fs.readdirSync(dir).find((x) => x.endsWith('.json'));
  return leer(path.join(dir, f));
};

// ── T1-T5: el juez por línea de la biblioteca ─────────────────────────────────────────────────────────────────────────

test('MC1 Judge_ThreeVerdicts_ByCase @story-8.294 @ac-1 — a main-falla; b y c main-pasa; d no-se con motivo', () => {
  // 🔴 mutación: dar main-falla a toda roja en main → c (un caso más en la historia) saldría main-falla.
  const l = lab();
  const f = resumen(l, [[A, ['a-1']], [B, ['b-1']], [C, ['c-1', 'c-2']], [D, ['d-1']]]);
  // cuatro suites: el tope sube a 4 para que las cuatro se juzguen (el tope de 3 lo prueba MC3 con «pasó del tope»)
  const r = aplicar(l, f, { TYCON_MAIN_CHECK_MAX: '4' });
  assert.equal(r.status, 1, r.stderr);
  const j = leer(f);
  assert.match(j.main_check.sha, /^[0-9a-f]{40}$/);
  assert.equal(veredicto(j, A).verdict, 'main-falla', r.stderr);
  assert.equal(veredicto(j, B).verdict, 'main-pasa');
  assert.equal(veredicto(j, C).verdict, 'main-pasa');
  assert.match(veredicto(j, C).motivo, /caso\(s\) nuevo\(s\)/);
  assert.equal(veredicto(j, D).verdict, 'no-se');
  assert.match(veredicto(j, D).motivo, /la suite no está en main/);
  // la de main sigue roja en el resumen (el informe y lo guardado la ven roja) y queda nombrada aparte
  assert.deepEqual(j.fallas.map((x) => x.entrada.ruta), [A, B, C, D]);
  assert.deepEqual(j.main_fails, [A]);
  assert.equal(j.waiting_on_main, undefined, 'la mezcla no anota espera');
  assert.match(r.stderr, /a\.test\.sh.*main falla igual/);
  // las suites corrieron en la copia, no en el clon de la historia
  assert.ok(corridas(l).every((c) => c.includes('--main-check')), corridas(l).join('\n'));
});

// 🔴 Falla con: la punta de main medida sin el medidor de cobertura cuando la rama se midió con él, o lo guardado de una
// condición reusado para la otra (issue #1855: una suite que depende del tiempo pasa sin el medidor y falla con él, y el
// rojo de main se le cobraba a la historia)
test('MC6 Judge_SameConditionsAsTheBranch @A71 — con cobertura en la rama, main se mide con cobertura; lo guardado no se cruza', () => {
  const l = lab();
  // una suite de main que pasa sin el medidor y falla con él (el medidor deja su carpeta en NODE_V8_COVERAGE)
  const otro = tmp('mc-otro-');
  git(otro, 'clone', '-q', l.remoto, otro);
  const t = path.join(otro, 'scripts', 'tests');
  fs.writeFileSync(path.join(t, 'suites.json'), lista(['a', 'b', 'c', 's', 'k']));
  fs.writeFileSync(path.join(t, 'k.test.sh'), suite('k', { fallback: 0, extra: '[ -n "$NODE_V8_COVERAGE" ] && { echo "✖ k-1"; exit 1; }' }));
  git(otro, 'add', '-A'); git(otro, 'commit', '-q', '-m', 'k depende del medidor');
  git(otro, 'push', '-q', 'origin', 'main');
  const K = 'tests/k.test.sh';
  // con el medidor en la rama: main falla igual
  const conCob = resumen(l, [[K, ['k-1']]], { coverage: { lcov: '/x.lcov', without_data: [] } });
  let r = aplicar(l, conCob);
  assert.equal(veredicto(leer(conCob), K).verdict, 'main-falla', r.stderr);
  assert.match(veredicto(leer(conCob), K).motivo, /cobertura/);
  // sin el medidor en la rama: main pasa (lo guardado con el medidor no se reusa)
  const sinCob = resumen(l, [[K, ['k-1']]]);
  r = aplicar(l, sinCob);
  assert.equal(veredicto(leer(sinCob), K).verdict, 'main-pasa', r.stderr);
  // y otra vez con el medidor: lo guardado de esa condición sí se reusa, con su veredicto
  const otraVez = resumen(l, [[K, ['k-1']]], { coverage: { lcov: '/x.lcov', without_data: [] } });
  r = aplicar(l, otraVez);
  assert.equal(veredicto(leer(otraVez), K).verdict, 'main-falla', r.stderr);
  assert.equal(veredicto(leer(otraVez), K).cached, true);
});

test('MC2 Copy_ReusedNotMergeTree_Locked @story-8.294 @ac-2 — una copia que se reusa en la punta nueva; el --merge intacto; candado vivo → no-se; candado muerto se rompe', () => {
  // 🔴 mutación: armar la copia de cero en cada juicio → la carpeta cambia, o usar `--merge` → el testigo desaparece.
  const l = lab();
  const merge = `${l.repo}--merge`;
  fs.mkdirSync(merge); fs.writeFileSync(path.join(merge, 'testigo.txt'), 'no me toques\n');
  const f1 = resumen(l, [[A, ['a-1']]]);
  assert.equal(aplicar(l, f1).status, 78);
  assert.ok(fs.existsSync(l.copia), 'no armó la copia');
  assert.equal(sha(l.copia), l.base, 'la copia no está en la punta de main');
  const inodo = fs.statSync(l.copia).ino;
  // main avanza: la copia se reusa (mismo inodo) y se pone en la punta nueva
  const nuevo = arreglarMain(l, ['c']);
  fs.writeFileSync(path.join(l.copia, 'basura.txt'), 'queda de otra medición\n');
  const f2 = resumen(l, [[A, ['a-1']]]);
  assert.equal(aplicar(l, f2).status, 78);
  assert.equal(fs.statSync(l.copia).ino, inodo, 'armó otra copia');
  assert.equal(sha(l.copia), nuevo, 'la copia no se puso en la punta nueva');
  assert.ok(!fs.existsSync(path.join(l.copia, 'basura.txt')), 'no limpió la copia');
  assert.equal(fs.readFileSync(path.join(merge, 'testigo.txt'), 'utf8'), 'no me toques\n');
  assert.equal(git(l.repo, 'worktree', 'list').stdout.trim().split('\n').length, 2, 'más árboles que el clon y la copia');
  // el candado de la copia tomado por un proceso vivo (este), con la espera bajada a 2 s: no-se
  const dir = path.join(l.home, '.claude', '.tycon-pipeline', 'main-check');
  const lock = fs.readdirSync(dir).find((x) => x.endsWith('--copy.lock')) || `${fs.readdirSync(dir).find((x) => x.endsWith('.json')).replace(/\.json$/, '')}--copy.lock`;
  const ahora = new Date().toISOString();
  fs.writeFileSync(path.join(dir, lock), JSON.stringify({ pid: process.pid, session: 'otra-sesion', since: ahora, touched: ahora }));
  const otraPunta = arreglarMain(l, ['s']);
  const f3 = resumen(l, [[A, ['a-1']]]);
  const r3 = aplicar(l, f3);
  assert.equal(r3.status, 1, r3.stderr);
  assert.equal(veredicto(leer(f3), A).verdict, 'no-se');
  assert.match(veredicto(leer(f3), A).motivo, /otra sesión está midiendo main/);
  assert.notEqual(sha(l.copia), otraPunta, 'tocó la copia con el candado tomado');
  // el candado de un proceso que ya no existe se rompe, se dice, y el juicio mide
  const muerto = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  fs.writeFileSync(path.join(dir, lock), JSON.stringify({ pid: muerto.pid, session: 'muerta', since: ahora, touched: ahora }));
  const f4 = resumen(l, [[A, ['a-1']]]);
  const r4 = aplicar(l, f4);
  assert.equal(r4.status, 78, r4.stderr);
  assert.match(r4.stderr, /candado de la sesión muerta roto/);
  assert.equal(sha(l.copia), otraPunta);
});

test('MC3 Cache_MainResultReused_VerdictPerSession @story-8.294 @ac-3 — el resultado de main se guarda y se reusa; cada sesión su veredicto; un no-se no queda; dos escrituras no se pisan', async () => {
  // 🔴 mutación: guardar el veredicto en vez del resultado → la segunda sesión heredaría «main-falla» con un caso más.
  const l = lab();
  // a y s se miden; c pasa del tope de 2 suites y queda «no se pudo medir»
  const f1 = resumen(l, [[A, ['a-1']], [S, []], [C, ['c-1']]]);
  const r1 = aplicar(l, f1, { TYCON_MAIN_CHECK_TIMEOUT_S: '2', TYCON_MAIN_CHECK_MAX: '2' });
  assert.equal(r1.status, 1, r1.stderr);
  const j1 = leer(f1);
  assert.equal(veredicto(j1, A).verdict, 'main-falla');
  assert.equal(veredicto(j1, S).verdict, 'no-se');
  assert.match(veredicto(j1, S).motivo, /pasó el tope de 2 s/);
  assert.equal(veredicto(j1, C).verdict, 'no-se');
  assert.match(veredicto(j1, C).motivo, /pasó del tope de 2 suites/);
  const st = estadoDe(l);
  const porSha = st.results[j1.main_check.sha];
  assert.deepEqual(porSha[A].estado, 'roja');
  assert.deepEqual(porSha[A].casos, ['✖ a-1']);
  assert.equal(porSha[A].casos_completos, true);
  assert.equal(porSha[A].session, SID);
  assert.ok(!('verdict' in porSha[A]), 'guardó el veredicto, no el resultado');
  assert.equal(porSha[S], undefined, 'guardó un no-se');
  // otra sesión, misma suite y mismo sha, con un caso más: no corre nada y da main-pasa; dice quién midió main
  limpiarCorridas(l);
  const f2 = resumen(l, [[A, ['a-1', 'a-2']]]);
  const r2 = aplicar(l, f2, { CLAUDE_CODE_SESSION_ID: 'otra-sesion' });
  assert.equal(r2.status, 1, r2.stderr);
  assert.deepEqual(corridas(l), [], 'volvió a correr la suite en main');
  assert.equal(veredicto(leer(f2), A).verdict, 'main-pasa');
  // quién midió sale con la sesión acortada a 8 letras, como en el resto de los avisos del arnés
  assert.match(veredicto(leer(f2), A).motivo, new RegExp(`main medido por ${SID.slice(0, 8)} a las \\d\\d:\\d\\d`));
  // la misma sesión, con los mismos casos: tampoco corre, y sigue siendo main-falla (78)
  const f3 = resumen(l, [[A, ['a-1']]]);
  assert.equal(aplicar(l, f3).status, 78);
  assert.deepEqual(corridas(l), []);
  // dos escrituras a la vez, una a `results` y otra a `broken`: ninguna pisa la otra sección
  const shaMain = j1.main_check.sha;
  const p1 = conLib(l, `mc.broken.join({ tree: ${JSON.stringify(l.repo)}, sha: ${JSON.stringify(shaMain)}, suites: [{ ruta: ${JSON.stringify(A)}, raiz: 'arnes', casos: ['✖ a-1'] }], session: 'uno' });`, {}, { async: true });
  const p2 = conLib(l, `mc.saveResult({ tree: ${JSON.stringify(l.repo)}, sha: ${JSON.stringify(shaMain)}, ruta: ${JSON.stringify(B)}, result: { estado: 'verde' }, session: 'dos' });`, {}, { async: true });
  await Promise.all([p1, p2].map((p) => new Promise((res) => p.on('close', res))));
  const despues = estadoDe(l);
  assert.equal(despues.broken.length, 1, 'perdió el registro');
  assert.equal(despues.results[shaMain][B].estado, 'verde', 'perdió el resultado');
  assert.equal(despues.results[shaMain][A].estado, 'roja', 'perdió lo que ya estaba');
});

test('MC4 Status_ReadsOnly @story-8.294 @ac-4 — status dice sha, resultados, quién midió y el registro, sin correr nada ni traer', () => {
  // 🔴 mutación: hacer `fetch` en status → con el origin borrado fallaría; correr una suite → corridas no estaría vacío.
  const l = lab();
  const f = resumen(l, [[A, ['a-1']]]);
  assert.equal(aplicar(l, f).status, 78);
  const shaMain = leer(f).main_check.sha;
  assert.equal(conLib(l, `mc.broken.join({ tree: ${JSON.stringify(l.repo)}, sha: ${JSON.stringify(shaMain)}, suites: [{ ruta: ${JSON.stringify(A)}, raiz: 'arnes', casos: ['✖ a-1'] }], session: 'mc-sesion' });`).status, 0);
  limpiarCorridas(l);
  fs.rmSync(l.remoto, { recursive: true, force: true });
  const r = spawnSync(process.execPath, [LIB, 'status', '--repo', l.repo], { encoding: 'utf8', env: entorno(l) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`última punta medida: ${shaMain.slice(0, 10)}`));
  assert.match(r.stdout, /a\.test\.sh: roja \(1 caso\(s\)\) en main — medida por mc-sesio a las \d\d:\d\d/);
  assert.match(r.stdout, /registro main-1 abierto desde las \d\d:\d\d .*tests\/a\.test\.sh; esperan 1 sesión\(es\)/);
  assert.deepEqual(corridas(l), [], 'status corrió una suite');
  const j = spawnSync(process.execPath, [LIB, 'status', '--repo', l.repo, '--json'], { encoding: 'utf8', env: entorno(l) });
  const s = JSON.parse(j.stdout);
  assert.equal(s.sha, shaMain);
  assert.equal(s.broken.id, 'main-1');
  assert.equal(s.open, true);
  // un pedido mal hecho sale 2; una carpeta que no es git, 1
  assert.equal(spawnSync(process.execPath, [LIB, 'status'], { encoding: 'utf8', env: entorno(l) }).status, 2);
  assert.equal(spawnSync(process.execPath, [LIB, 'status', '--repo', tmp('mc-nogit-')], { encoding: 'utf8', env: entorno(l) }).status, 1);
});

test('MC5 FetchFails_NoSe_AsToday @story-8.294 @ac-1 @ac-5 — con origin inalcanzable todo es no-se y el portón sale rojo como hoy, sin espera', () => {
  // 🔴 mutación: tratar «no pude traer» como main-falla → la corrida esperaría a un main que nadie midió.
  const l = lab();
  fs.rmSync(l.remoto, { recursive: true, force: true });
  const f = resumen(l, [[A, ['a-1']], [B, ['b-1']]]);
  const r = aplicar(l, f);
  assert.equal(r.status, 1, r.stderr);
  const j = leer(f);
  assert.equal(veredicto(j, A).verdict, 'no-se');
  assert.match(veredicto(j, A).motivo, /no pude traer origin\/main/);
  assert.equal(veredicto(j, B).verdict, 'no-se');
  assert.equal(j.waiting_on_main, undefined);
  assert.deepEqual(j.fallas.map((x) => x.entrada.ruta), [A, B]);
  assert.ok(!fs.existsSync(l.copia), 'armó la copia sin poder traer main');
  // con el juez apagado por el tope en 0, `apply` sale exactamente como hoy: sin foto y sin base, 10 y el resumen intacto
  const f0 = resumen(l, [[A, ['a-1']]]);
  const antes = fs.readFileSync(f0, 'utf8');
  assert.equal(aplicar(l, f0, { TYCON_MAIN_CHECK_MAX: '0' }).status, 10);
  assert.equal(fs.readFileSync(f0, 'utf8'), antes);
  // y sin TYCON_MAIN_CHECK=1 (corrido a mano) tampoco corre
  const fm = resumen(l, [[A, ['a-1']]]);
  const sinPedir = spawnSync(process.execPath, [INHERITED, 'apply', l.repo, fm], { encoding: 'utf8', env: entorno(l) });
  assert.equal(sinPedir.status, 10, sinPedir.stderr);
});

// ── T6-T9: el portón, el marcador, el paso y el cierre del turno ───────────────────────────────────────────────────────

const markerFile = (l, sid = SID) => path.join(l.home, '.claude', '.tycon-pipeline', 'active', `${sid}.json`);
const doingFile = (l, sid = SID) => path.join(l.home, '.claude', '.tycon-pipeline', 'doing', `${sid}.json`);
const PASOS = ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'adversarial-pass', 'findings', 'live-check', 'prepare-commit'];

/** Una historia de juguete, para los comandos que la leen. */
function historia(l) {
  const specs = path.join(l.repo, 'specs');
  fs.mkdirSync(specs, { recursive: true });
  const f = path.join(specs, 'story-9.125-prueba.md');
  fs.writeFileSync(f, `---\nepic: 9\nstory: "9.125"\ntitle: "Prueba"\nstatus: in-progress\npipelines:\n  - name: A\n    status: in-progress\n---\n\n# Story 9.125: Prueba\n\nStatus: in-progress\n`);
  return f;
}

function escribirMarcador(l, { checks = {}, testsFailed, waitingOnMain, autonomous = false, completados = [0, 1, 2, 3, 4, 5], storyPath = '' } = {}) {
  fs.mkdirSync(path.dirname(markerFile(l)), { recursive: true });
  // los pasos por nombre son el marcador nuevo (esquema 2); los números, el viejo
  const nuevo = completados.some((p) => typeof p === 'string');
  fs.writeFileSync(markerFile(l), JSON.stringify({
    storyId: '9.125', storyPath, repoPath: l.repo, baseSha: l.base, sessionId: SID, startedAt: new Date().toISOString(),
    lastTouch: new Date().toISOString(), stepsCompleted: completados, stepsPending: nuevo ? PASOS.filter((p) => !completados.includes(p)) : [],
    ...(nuevo ? { stepScheme: 2 } : {}), filesTouched: [], iterations: {}, fileEvents: [],
    checks, autonomous, ...(testsFailed ? { testsFailed } : {}), ...(waitingOnMain ? { waitingOnMain } : {}),
  }, null, 2));
}
const marcador = (l) => leer(markerFile(l));

function puerta(l, args = [], extra = {}) {
  const r = spawnSync('bash', [TEST_GATE, l.repo, ...args], { cwd: l.repo, encoding: 'utf8', env: entorno(l, extra), timeout: 180000 });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}
function marker(l, args, extra = {}) {
  const r = spawnSync(process.execPath, [MARKER_JS, ...args], { cwd: l.repo, encoding: 'utf8', env: entorno(l, extra), timeout: 30000 });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

/** El laboratorio del portón: en main a está roja y b verde; el cambio toca docs/x.md y, si se pide, rompe b. */
function labPorton({ bRota = false } = {}) {
  const l = lab({ conCambio: false });
  git(l.repo, 'checkout', '-q', '-b', 'cambio');
  fs.appendFileSync(path.join(l.repo, 'docs', 'x.md'), 'cambio de la historia\n');
  if (bRota) fs.writeFileSync(path.join(l.repo, 'scripts', 'tests', 'b.test.sh'), suite('b', { casos: ['b-1'], fallback: 1 }));
  // s no corre en estas pruebas: sale de la lista del cambio para que la completa sea corta
  fs.writeFileSync(path.join(l.repo, 'scripts', 'tests', 'suites.json'), lista(['a', 'b', 'c']));
  git(l.repo, 'add', '-A'); git(l.repo, 'commit', '-q', '-m', 'el cambio');
  escribirMarcador(l, { autonomous: true });
  return l;
}

test('TG1 Gate_AllMainFails_Exit78_NotInTestsFailed @story-8.294 @ac-5 — el portón sale 78, tests = espera-main, la lista vacía y la espera anotada', () => {
  // 🔴 mutación: dejar la suite en testsFailed → la próxima corrida saldría 76 pidiendo repetirla; o poner tests en verde.
  const l = labPorton();
  // c también está roja en main con el mismo caso: las dos son de main
  const r = puerta(l);
  assert.equal(r.status, 78, r.out);
  const m = marcador(l);
  assert.equal(m.checks.tests, 'espera-main', JSON.stringify(m.checks));
  assert.equal(m.checksProvenance.tests, 'test-gate');
  assert.deepEqual(m.testsFailed || [], [], 'la suite quedó en testsFailed');
  // la espera es una lista con una entrada por repo
  assert.ok(Array.isArray(m.waitingOnMain) && m.waitingOnMain.length === 1, JSON.stringify(m.waitingOnMain));
  const w = m.waitingOnMain[0];
  assert.ok(w.id === 'main-1' && w.repo === l.repo, JSON.stringify(w));
  assert.match(w.sha, /^[0-9a-f]{40}$/);
  assert.deepEqual([...w.suites].sort(), [A, C]);
  const d = leer(doingFile(l));
  assert.equal(d.waitingKind, 'main');
  assert.equal(d.waitingFor, 'espera a main (main-1)');
  assert.ok(d.waitingSince, 'sin waitingSince');
  assert.match(r.out, /main está roto en .*a\.test\.sh.*: espero a main \(main-1\)/);
  assert.ok(!fs.existsSync(path.join(l.repo, '.advisors', 'tests-result.json')), 'dejó tests-result.json');
  // el registro de main roto quedó con esta sesión esperando
  const st = estadoDe(l);
  assert.equal(st.broken.length, 1);
  assert.deepEqual(st.broken[0].waiting.map((w) => w.session), [SID]);
  // `marker.js doing --waiting-for` con el mismo texto la vuelve a anotar con su clase, dicha con `--kind`
  assert.equal(marker(l, ['doing', '--waiting-for', 'espera a main (main-1)', '--kind', 'main']).status, 0);
  assert.equal(leer(doingFile(l)).waitingKind, 'main');
  // main arregla a y c: la completa siguiente las vuelve a correr y las saca de la espera, main pasa, y el rojo que queda
  // (la rama no trajo main) es de la historia: tests rojo, sin espera, y el registro se cerró
  arreglarMain(l, ['a', 'c']);
  const r2 = puerta(l);
  assert.equal(r2.status, 1, r2.out);
  const m2 = marcador(l);
  assert.match(String(m2.checks.tests), /^red/);
  assert.equal(m2.waitingOnMain, undefined, 'la espera sobrevivió a una medición nueva');
  assert.ok(!fs.existsSync(doingFile(l)) || leer(doingFile(l)).waitingKind !== 'main', 'la nota sigue diciendo que espera a main');
  assert.match(r2.out, /main pasó/);
  assert.ok(estadoDe(l).broken[0].closed, 'el registro no se cerró con main verde');
});

test('TG2 Gate_Mixed_RedAsTodayListsMainApart @story-8.294 @ac-5 — a de main y b de la historia: sale 1 con a aparte; arreglada b, la próxima sale 78', () => {
  // 🔴 mutación: anotar la suite de main en testsFailed → la segunda completa saldría 76 en vez de 78.
  const l = labPorton({ bRota: true });
  const r = puerta(l);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /de main: .*a\.test\.sh/);
  const m = marcador(l);
  assert.match(String(m.checks.tests), /^red/);
  // la lista trae las tres rojas, y las de main marcadas: no hay que repetirlas
  const lista1 = (m.testsFailed || []);
  assert.deepEqual(lista1.map((x) => x.ruta).sort(), [A, B, C]);
  assert.ok(lista1.find((x) => x.ruta === A).main && lista1.find((x) => x.ruta === A).main.sha, 'a no quedó marcada como de main');
  assert.equal(lista1.find((x) => x.ruta === B).main, undefined, 'b quedó marcada como de main');
  assert.equal(m.waitingOnMain, undefined, 'la mezcla anotó espera');
  // la completa siguiente no corre: pide repetir sola b, y dice que a y c son de main (no hay que repetirlas)
  const r76 = puerta(l);
  assert.equal(r76.status, 76, r76.out);
  assert.match(r76.out, /--suite tests\/b\.test\.sh/);
  assert.doesNotMatch(r76.out, /--suite tests\/a\.test\.sh/, 'pidió repetir la de main');
  assert.match(r76.out, /de main/);
  // la historia arregla b: la repetición sola sale verde y en la lista quedan sólo las de main
  estado(l, { b: 0 });
  assert.equal(puerta(l, ['--suite', B]).status, 0);
  assert.deepEqual((marcador(l).testsFailed || []).map((x) => x.ruta).sort(), [A, C]);
  // la próxima completa corre (las de main no frenan con 76) y sale 78 con el resultado de main guardado: no vuelve a
  // medir en la copia
  limpiarCorridas(l);
  const r2 = puerta(l);
  assert.equal(r2.status, 78, r2.out);
  assert.equal(marcador(l).checks.tests, 'espera-main');
  assert.deepEqual(marcador(l).testsFailed || [], []);
  assert.ok(corridas(l).every((c) => !c.includes('--main-check')), `volvió a medir main:\n${corridas(l).join('\n')}`);
});

test('TG3 Step06_And_StopHook_WaitIsNotARound @story-8.294 @ac-6 @ac-7 — la fila 78 del paso; el turno cierra con la espera y se frena sin ella; no suma vuelta', () => {
  // 🔴 mutación: tratar espera-main como un rojo en el cierre del turno → el agente no podría esperar a main.
  const md = fs.readFileSync(STEP_06, 'utf8');
  const fila = md.split('\n').find((ln) => /^\| `78` \|/.test(ln));
  assert.ok(fila, 'la tabla de salidas no tiene la fila 78');
  assert.match(fila, /tocar esas pruebas ni el código/i, 'no dice que no se toquen esas pruebas ni el código');
  assert.match(fila, /vuelta extra/, 'no dice que no se pida una vuelta extra');
  assert.match(fila, /dueño/, 'no dice que no se le pregunte al dueño');
  assert.match(fila, /espero a main \(<id>\)/, 'no trae la línea para la persona');
  assert.match(fila, /main-check\.js status/, 'no dice la forma sin espera de fondo');
  assert.match(fila, /Codex/, 'no dice la asimetría de Codex');
  // el cierre del turno: con la espera anotada deja parar (y se lo dice a la persona); sin ella, frena
  const l = lab({ conCambio: false });
  const hook = () => spawnSync(process.execPath, [STOP_HOOK], { input: JSON.stringify({ session_id: SID }), encoding: 'utf8', env: entorno(l) });
  escribirMarcador(l, { autonomous: true, checks: { tests: 'espera-main' }, waitingOnMain: { repo: l.repo, id: 'main-1', sha: l.base, suites: [A], since: new Date().toISOString() } });
  const con = hook();
  assert.equal(con.status, 0);
  assert.doesNotMatch(con.stdout, /"decision":\s*"block"/, `frenó con la espera anotada: ${con.stdout}`);
  assert.match(con.stdout, /espero a main \(main-1\)/, 'no le dijo a la persona que espera a main');
  escribirMarcador(l, { autonomous: true, checks: { tests: 'espera-main' } });
  const sin = hook();
  assert.match(sin.stdout, /"decision":\s*"block"/, 'espera-main sin la espera anotada no frenó');
  escribirMarcador(l, { autonomous: true, checks: { tests: 'red:1' } });
  assert.match(hook().stdout, /"decision":\s*"block"/, 'el rojo de siempre dejó de frenar');
  // la espera no es una vuelta de revisores
  const rr = require(ROUNDS);
  assert.equal(rr.vueltas({ iterations: {}, waitingOnMain: { id: 'main-1' } }), 0);
});

test('TG4 EsperaMain_NeverGreen_BlocksPrepareAndDone @story-8.294 @ac-8 — con tests en espera-main, preparar el pull request y pasar a review se frenan', () => {
  // 🔴 mutación: tratar espera-main como verde (no es `red`) → el paso cerraría y la historia pasaría a review.
  const l = lab({ conCambio: false });
  const spec = historia(l);
  const espera = { repo: l.repo, id: 'main-1', sha: l.base, suites: [A], since: new Date().toISOString() };
  escribirMarcador(l, { checks: { tests: 'espera-main', build: 'green', advisors: 'green' }, waitingOnMain: espera, completados: PASOS.slice(0, -1), storyPath: spec });
  const prep = marker(l, ['complete-step', 'prepare-commit']);
  assert.notEqual(prep.status, 0, prep.out);
  assert.match(prep.out, /espera a main \(main-1\): la historia no avanza hasta que main pase y su portón salga verde/);
  const review = marker(l, ['update-story-status', spec, 'review']);
  assert.notEqual(review.status, 0, review.out);
  assert.match(review.out, /espera a main \(main-1\)/);
  assert.match(fs.readFileSync(spec, 'utf8'), /^status: in-progress$/m, 'la historia cambió de estado igual');
  const done = marker(l, ['update-pipeline-status', spec, 'A', 'done']);
  assert.notEqual(done.status, 0, done.out);
  assert.match(done.out, /espera a main \(main-1\)/);
  // «Correr las pruebas» tampoco cierra
  escribirMarcador(l, { checks: { tests: 'espera-main' }, waitingOnMain: espera, completados: PASOS.slice(0, 5), storyPath: spec });
  const rt = marker(l, ['complete-step', 'run-tests']);
  assert.notEqual(rt.status, 0, rt.out);
  assert.match(rt.out, /espera a main \(main-1\)/);
});

// ── T10: el registro de main roto ─────────────────────────────────────────────────────────────────────────────────────

test('MB1 Broken_OneRecord_JoinsAndExtends @story-8.294 @ac-9 — tres corridas, un registro; se cierra cuando main pasa; un rojo después abre otro', () => {
  // 🔴 mutación: crear un registro por corrida → tres ids; o no cerrar nunca → el rojo posterior se sumaría a main-1.
  const l = lab();
  const f = resumen(l, [[A, ['a-1']]]);
  assert.equal(aplicar(l, f).status, 78);
  const shaMain = leer(f).main_check.sha;
  const sumar = (sesion, suites) => conLib(l, `const r = mc.broken.join({ tree: ${JSON.stringify(l.repo)}, sha: ${JSON.stringify(shaMain)}, suites: ${JSON.stringify(suites.map((ruta) => ({ ruta, raiz: 'arnes', casos: ['✖ x'] })))}, session: ${JSON.stringify(sesion)} }); process.stdout.write(r.record.id);`, { CLAUDE_CODE_SESSION_ID: sesion });
  assert.equal(sumar('s1', [A]).stdout, 'main-1');
  assert.equal(sumar('s2', [A]).stdout, 'main-1');
  assert.equal(sumar('s3', [A, C]).stdout, 'main-1');
  let st = estadoDe(l);
  assert.equal(st.broken.length, 1);
  assert.deepEqual(st.broken[0].suites, [A, C]);
  assert.deepEqual(st.broken[0].waiting.map((w) => w.session), ['s1', 's2', 's3']);
  const status = spawnSync(process.execPath, [LIB, 'status', '--repo', l.repo], { encoding: 'utf8', env: entorno(l) });
  assert.match(status.stdout, /registro main-1 abierto .*esperan 3 sesión\(es\): s1, s2, s3/);
  // main arregla a y c: el juicio sobre la punta nueva las da verdes y cierra el registro
  const nuevo = arreglarMain(l, ['a', 'c']);
  const f2 = resumen(l, [[A, ['a-1']], [C, ['c-1']]]);
  const r2 = aplicar(l, f2);
  assert.equal(r2.status, 1, r2.stderr);
  assert.match(r2.stderr, new RegExp(`main pasó: ${nuevo.slice(0, 10)} — el registro main-1 se cierra`));
  st = estadoDe(l);
  assert.ok(st.broken[0].closed, 'no cerró el registro');
  assert.equal(st.broken[0].closedSha, nuevo);
  assert.match(spawnSync(process.execPath, [LIB, 'status', '--repo', l.repo], { encoding: 'utf8', env: entorno(l) }).stdout, /registro main-1 cerrado a las \d\d:\d\d: main pasó/);
  // un rojo de main posterior abre otro registro
  assert.equal(sumar('s4', [B]).stdout, 'main-2');
  st = estadoDe(l);
  assert.equal(st.broken.length, 2);
  assert.equal(st.broken[1].closed, null);
});

// ── T12-T15: el tablero, la espera de fondo, el arreglo y el aviso ───────────────────────────────────────────────────

const NOTICE = path.resolve(SCRIPTS, '..', '..', '..', 'scripts', 'hooks', 'bench-notice.js');
const filas = (l) => {
  const f = path.join(l.home, '.claude', '.tycon-pipeline', 'coordination', 'tablero.json');
  return fs.existsSync(f) ? (leer(f).pendientes || []) : null;
};
/** `broken.join` de la sesión `sesion` con `suites` (rutas), en otro proceso, con el ambiente del laboratorio. */
function unir(l, sesion, suites, extra = {}) {
  return conLib(l, `const r = mc.broken.join({ tree: ${JSON.stringify(l.repo)}, sha: ${JSON.stringify(l.base)}, suites: ${JSON.stringify(suites.map((ruta) => ({ ruta, raiz: 'arnes', casos: ['✖ x'] })))}, session: ${JSON.stringify(sesion)} }); process.stdout.write(JSON.stringify({ id: r.record.id, fila: r.record.fila || null, tablero: r.board || null }));`, { CLAUDE_CODE_SESSION_ID: sesion, ...extra });
}
/** `wait` por la biblioteca: la memoria la da la prueba, no la máquina. */
function esperar(l, id, { pct = 90, interval = 0, max = 60 } = {}) {
  const r = conLib(l, `const r = mc.wait({ repo: ${JSON.stringify(l.repo)}, id: ${JSON.stringify(id)}, interval: ${interval}, max: ${max}, readMemory: () => ({ pct: ${pct} }) }); process.stdout.write(r.line + '\\n'); process.exitCode = r.code;`);
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

test('MB2 Board_OneRowPerId_OnlyWithCoordinator @story-8.294 @ac-11 — con coordinadora, una fila por id que cambia su título al ampliarse; sin coordinadora, el tablero no se toca', () => {
  // 🔴 mutación: una fila por corrida; buscar la fila por su título (la de main-2 pisaría la cerrada de main-1); escribir
  //    el tablero sin coordinadora.
  const l = lab();
  const con = { TYCON_SUITE_TURN: '1' };
  const a1 = JSON.parse(unir(l, 's1', [A], con).stdout);
  assert.equal(a1.id, 'main-1');
  assert.match(String(a1.fila), /^T-\d+$/, JSON.stringify(a1));
  assert.equal(JSON.parse(unir(l, 's2', [A], con).stdout).fila, a1.fila);
  let f = filas(l);
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.equal(f[0].estado, 'riesgo');
  assert.match(f[0].titulo, /^Arreglar main en mc-repo-\w+ \(main-1\): a\.test\.sh$/);
  unir(l, 's3', [A, C], con);
  f = filas(l);
  assert.equal(f.length, 1);
  assert.match(f[0].titulo, /\(main-1\): a\.test\.sh, c\.test\.sh$/, 'el título no cambió al ampliarse');
  // main pasa: el registro y su fila se cierran; un rojo nuevo con las mismas suites abre main-2 con otra fila
  arreglarMain(l, ['a', 'c']);
  assert.equal(aplicar(l, resumen(l, [[A, ['a-1']], [C, ['c-1']]]), con).status, 1);
  f = filas(l);
  assert.equal(f[0].estado, 'hecho', 'la fila no se cerró con main verde');
  const a2 = JSON.parse(unir(l, 's4', [A, C], con).stdout);
  assert.equal(a2.id, 'main-2');
  assert.notEqual(a2.fila, a1.fila);
  f = filas(l);
  assert.equal(f.length, 2);
  assert.equal(f.find((x) => x.id === a1.fila).estado, 'hecho', 'la fila cerrada de main-1 se volvió a abrir');
  assert.match(f.find((x) => x.id === a2.fila).titulo, /\(main-2\)/);
  // sin coordinadora: nada
  const sin = lab();
  assert.equal(JSON.parse(unir(sin, 's1', [A], { TYCON_SUITE_TURN: '0' }).stdout).fila, null);
  assert.equal(filas(sin), null, 'escribió el tablero sin coordinadora');
});

test('MB3 Wait_PollsWithoutMeasuring_ResumesOnGreen @story-8.294 @ac-12 — sin punta nueva no mide; con la punta que arregla todo cierra, aun con cuatro suites y con el árbol en la punta', () => {
  // 🔴 mutación: medir en cada vuelta; cortar en el tope de 3 del portón (el registro de cuatro no cierra nunca); usar
  //    el atajo del árbol en la punta (toma el rojo de la historia por el de main).
  let l = lab();
  unir(l, 's1', [A, B, C, S]);
  limpiarCorridas(l);
  let r = esperar(l, 'main-1', { max: 0 });
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /main sigue roto \(main-1\)/);
  assert.ok(corridas(l).every((c) => !c.includes('--main-check')), `midió sin punta nueva:\n${corridas(l).join('\n')}`);
  const nuevo = arreglarMain(l, ['a', 'c', 's']);
  r = esperar(l, 'main-1');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, new RegExp(`main pasó: ${nuevo}; traé main y repetí el portón`));
  assert.equal(estadoDe(l).broken[0].closedSha, nuevo);
  // el árbol de la sesión ya en la punta y limpio: igual mide en la copia
  l = lab({ conCambio: false });
  unir(l, 's1', [A]);
  arreglarMain(l, ['a']);
  git(l.repo, 'fetch', '-q', 'origin');
  git(l.repo, 'checkout', '-q', '--detach', 'origin/main');
  r = esperar(l, 'main-1');
  assert.equal(r.status, 0, r.out);
});

test('MB4 Wait_Timeout_LowMemory_DeadSession @story-8.294 @ac-12 — al tope sale 3 y la espera sigue; con poca memoria posterga; sin registro sale 2; status dice si main pasó', () => {
  const l = lab();
  unir(l, 's1', [A]);
  arreglarMain(l, ['a']);
  limpiarCorridas(l);
  let r = esperar(l, 'main-1', { pct: 1, max: 0 });
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /memoria libre 1 %, debajo del piso de \d+ %: postergo la medición/);
  assert.ok(corridas(l).every((c) => !c.includes('--main-check')), 'midió con la memoria debajo del piso');
  assert.equal(estadoDe(l).broken[0].closed, null);
  assert.equal(esperar(l, 'main-9').status, 2);
  // la sesión que esperaba ya no está: status dice si main pasó, sin correr nada
  assert.match(spawnSync(process.execPath, [LIB, 'status', '--repo', l.repo], { encoding: 'utf8', env: entorno(l) }).stdout, /registro main-1 abierto/);
  assert.equal(esperar(l, 'main-1').status, 0);
  assert.match(spawnSync(process.execPath, [LIB, 'status', '--repo', l.repo], { encoding: 'utf8', env: entorno(l) }).stdout, /registro main-1 cerrado a las \d\d:\d\d: main pasó/);
});

test('MB5 Notice_OfficeWip_Fix_OpenAndClose @story-8.294 @ac-13 @ac-15 — el arreglo es uno solo; el aviso de arranque lo dice mientras está abierto, y deja de salir al cerrarse', () => {
  // 🔴 mutación: un segundo fix que pisa al primero; un aviso que sigue saliendo con el registro cerrado.
  const l = lab();
  unir(l, 's1', [A]);
  unir(l, 's2', [A]);
  const fix = (sesion, extra = []) => spawnSync(process.execPath, [LIB, 'fix', '--repo', l.repo, '--id', 'main-1', '--session', sesion, ...extra], { encoding: 'utf8', env: entorno(l) });
  let f = fix('s1', ['--pr', '12']);
  assert.equal(f.status, 0, f.stderr);
  f = fix('s2');
  assert.equal(f.status, 1);
  assert.match(`${f.stdout}${f.stderr}`, /el arreglo de main-1 ya lo tiene s1 \(pedido #12\)/);
  assert.equal(estadoDe(l).broken[0].fix.session, 's1');
  assert.equal(spawnSync(process.execPath, [LIB, 'fix', '--repo', l.repo, '--id', 'main-9', '--session', 's1'], { encoding: 'utf8', env: entorno(l) }).status, 2);
  const aviso = () => spawnSync(process.execPath, [NOTICE], { encoding: 'utf8', env: entorno(l, { TYCON_BENCH_DIR: tmp('mc-banco-') }) }).stdout;
  assert.match(aviso(), /main roto en mc-repo-\w+ desde \d\d:\d\d \(main-1\): a\.test\.sh; esperan 2 sesiones; arreglo: pedido #12/);
  arreglarMain(l, ['a']);
  assert.equal(esperar(l, 'main-1').status, 0);
  assert.doesNotMatch(aviso(), /main roto en/);
  // un archivo del registro que no se deja leer se dice: no medido no es «sin main roto»
  fs.writeFileSync(path.join(l.home, '.claude', '.tycon-pipeline', 'main-check', 'roto-1234.json'), '{ no es json');
  assert.match(aviso(), /main roto: no pude leer .*roto-1234\.json.*no medido/);
});

// ── Lo que encontró el pase adversarial de la 8.309 ─────────────────────────────────────────────────────────────────

test('MC6 Wait_NotMeasured_TriesTheSameTipAgain @story-8.309 @ac-8 — una punta que no se pudo medir (copia ocupada) se vuelve a medir, y se dice por qué no', () => {
  // 🔴 mutación: dar por medida la punta con un `no-se` deja el registro abierto hasta otro commit en main o las 8 h.
  const l = lab();
  unir(l, 's1', [A]);
  arreglarMain(l, ['a']);
  const r = conLib(l, `
    const fs = require('fs');
    const p = mc.statePaths(mc.mainRepoOf(${JSON.stringify(l.repo)}));
    fs.mkdirSync(require('path').dirname(p.copyLock), { recursive: true });
    fs.writeFileSync(p.copyLock, JSON.stringify({ pid: process.ppid, session: 'otra', since: new Date().toISOString(), touched: new Date().toISOString() }));
    const log = [];
    const w = mc.wait({ repo: ${JSON.stringify(l.repo)}, id: 'main-1', interval: 0, max: 5, readMemory: () => ({ pct: 90 }), log: (x) => log.push(x), sleepMs: () => { try { fs.unlinkSync(p.copyLock); } catch (_) {} } });
    process.stdout.write(JSON.stringify({ w, log }));`, { TYCON_MAIN_CHECK_LOCK_WAIT_S: '0' });
  const out = JSON.parse(r.stdout);
  assert.equal(out.w.code, 0, JSON.stringify(out));
  assert.ok(out.log.some((x) => /no pude medir .*otra sesión está midiendo main/.test(x)), `no dijo por qué no midió: ${JSON.stringify(out.log)}`);
});

test('MC7 Close_AllCachedGreen_ClosesTheRecord @story-8.309 @ac-8 — con todas las suites ya guardadas en verde en una punta más nueva, el juicio y la espera cierran el registro', () => {
  // 🔴 mutación: cerrar sólo cuando se midió algo nuevo deja el registro abierto con main verde.
  const l = lab();
  // A juzga en la punta vieja (main roto); B mide la punta arreglada sin registro abierto; después A se suma con su sha
  const f1 = resumen(l, [[A, ['a-1']]]);
  aplicar(l, f1, { CLAUDE_CODE_SESSION_ID: 'sA' });
  const shaViejo = leer(f1).main_check.sha;
  arreglarMain(l, ['a']);
  assert.equal(aplicar(l, resumen(l, [[A, ['a-1']]]), { CLAUDE_CODE_SESSION_ID: 'sB' }).status, 1);
  conLib(l, `mc.broken.join({ tree: ${JSON.stringify(l.repo)}, sha: ${JSON.stringify(shaViejo)}, suites: [{ ruta: ${JSON.stringify(A)}, raiz: 'arnes', casos: ['✖ a-1'] }], session: 'sA' });`);
  const abierto = estadoDe(l).broken.find((b) => !b.closed);
  assert.ok(abierto, 'no quedó un registro abierto para probar');
  assert.equal(aplicar(l, resumen(l, [[A, ['a-1']]]), { CLAUDE_CODE_SESSION_ID: 'sA' }).status, 1);
  assert.ok(estadoDe(l).broken.find((b) => b.id === abierto.id).closed, 'el juicio con todo en la caché no cerró el registro');
});

test('MC8 Close_OlderTip_DoesNotClose @story-8.309 @ac-8 — un verde de una punta más vieja que la del registro no lo cierra', () => {
  // 🔴 mutación: cerrar con cualquier punta distinta dice «main pasó» con main roto.
  const l = lab({ conCambio: false });
  const viejo = l.base;
  const otro = tmp('mc-otro-');
  git(otro, 'clone', '-q', l.remoto, otro);
  fs.writeFileSync(path.join(otro, 'docs-nuevo.md'), 'x\n');
  git(otro, 'add', '-A'); git(otro, 'commit', '-q', '-m', 'otro'); git(otro, 'push', '-q', 'origin', 'main');
  const nuevo = sha(otro);
  git(l.repo, 'fetch', '-q', 'origin');
  conLib(l, `mc.broken.join({ tree: ${JSON.stringify(l.repo)}, sha: ${JSON.stringify(nuevo)}, suites: [{ ruta: ${JSON.stringify(A)}, raiz: 'arnes', casos: [] }], session: 's1' });
    mc.saveResult({ tree: ${JSON.stringify(l.repo)}, sha: ${JSON.stringify(viejo)}, ruta: ${JSON.stringify(A)}, result: { estado: 'verde' }, session: 's2' });`);
  assert.equal(estadoDe(l).broken[0].closed, null, 'lo cerró una punta más vieja');
  conLib(l, `mc.saveResult({ tree: ${JSON.stringify(l.repo)}, sha: ${JSON.stringify(nuevo)}, ruta: ${JSON.stringify(A)}, result: { estado: 'verde' }, session: 's2' });`);
  assert.equal(estadoDe(l).broken[0].closed, null, 'la misma punta del registro no lo cierra');
});

test('MC9 Lock_EmptyFile_NotBrokenAtOnce @story-8.309 @ac-8 — un candado recién creado y todavía vacío no se rompe; uno vacío y viejo, sí', () => {
  // 🔴 mutación: romper al instante un candado vacío deja a dos procesos con la misma copia de main.
  const d = tmp('mc-candado-');
  const f = path.join(d, 'x.lock');
  const mc = require(LIB);
  fs.writeFileSync(f, '', { flag: 'wx' });
  const r = mc.takeLock(f, { staleMs: 900000, waitMs: 300, pollMs: 50, session: 's' });
  assert.equal(r.ok, false, JSON.stringify(r));
  const viejo = new Date(Date.now() - 60000);
  fs.utimesSync(f, viejo, viejo);
  const r2 = mc.takeLock(f, { staleMs: 900000, waitMs: 300, pollMs: 50, session: 's' });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.match(String(r2.broke), /ilegible/);
  mc.releaseLock(f);
});

test('MC10 State_Unreadable_NotOverwritten_SaysIt @story-8.309 @ac-8 — un archivo de estado roto no se pisa, y branch-check dice que no pudo comprobar', () => {
  // 🔴 mutación: leerlo como vacío y escribir encima borra los registros de main roto; callar el «no pude» deja pasar una
  //    rama que no trae el arreglo de main.
  const l = lab();
  unir(l, 's1', [A]);
  const { file } = (() => { const dir = path.join(l.home, '.claude', '.tycon-pipeline', 'main-check'); return { file: path.join(dir, fs.readdirSync(dir).find((x) => x.endsWith('.json'))) }; })();
  fs.writeFileSync(file, '{ roto');
  const j = unir(l, 's2', [A]);
  assert.notEqual(j.status, 0, 'se sumó sobre un archivo roto');
  assert.equal(fs.readFileSync(file, 'utf8'), '{ roto', 'pisó el archivo roto');
  const bc = spawnSync(process.execPath, [LIB, 'branch-check', '--repo', l.repo, '--id', 'main-1'], { encoding: 'utf8', env: entorno(l) });
  assert.match(`${bc.stdout}${bc.stderr}`, /no pude comprobar si main ya pasó/);
  // status tampoco lo lee como «sin mediciones»: lo dice y sale 1
  const st = spawnSync(process.execPath, [LIB, 'status', '--repo', l.repo], { encoding: 'utf8', env: entorno(l) });
  assert.equal(st.status, 1, st.stdout);
  assert.match(st.stdout, /no se deja leer/);
  assert.doesNotMatch(st.stdout, /sin mediciones de main guardadas/);
});
