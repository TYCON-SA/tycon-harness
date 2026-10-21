'use strict';

/**
 * legacy-names-c1.test.js — lo que llaman la máquina y el otro repo, renombrado.
 * T36 y T37 (T35 es manual: el instalador en la máquina del dev; T38 es `node build/check.js`).
 *
 * Lo que no se puede perder:
 *   · T36 — un hook renombrado escribe en sus registros LO MISMO que antes: el id con que se anota no cambia. Si
 *     cambiara, la serie del tablero y del buzón se partiría en dos nombres para el mismo freno.
 *   · T37 — la identidad de un caso del banco es `<nombre del script>::<id>` y la de una suite, el nombre de su archivo.
 *     El commit del renombre migra las líneas de base y las fotos (`legacy-names.js --migrate-bench`) y
 *     `pr-verdict.js` pasa las dos fotos por el mapa: un rojo viejo con la clave nueva sale como viejo, no frena el PR.
 *
 * Los laboratorios usan nombres en inglés (esta prueba sale en la copia pública); el id viejo de un freno se arma por
 * concatenación. La parte que lee el árbol real del equipo se saltea en la copia pública (no lleva el mapa).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const MAP = path.join(RAIZ, 'scripts', 'lib', 'renames.json');
const LEGACY_JS = path.join(RAIZ, 'scripts', 'lib', 'legacy-names.js');
const VERDICT = path.join(RAIZ, 'scripts', 'ci', 'pr-verdict.js');
const BENCH = path.join(RAIZ, 'scripts', 'controls-bench');
const TEAM = fs.existsSync(path.join(RAIZ, 'perfil-equipo.json')) && fs.existsSync(MAP);
const SKIP_PUBLIC = !TEAM && 'copia pública: sin el mapa';

function cleanEnv(extra) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TYCON_') && k !== 'TF_BUILD') e[k] = v;
  return { ...e, ...extra };
}
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `c1-${p}-`));
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `${JSON.stringify(o, null, 2)}\n`); };

// ── T36 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T36 BatchC1_RecordsUnchanged — el freno renombrado anota con el mismo id, por el nombre nuevo y por el viejo', { skip: SKIP_PUBLIC }, () => {
  const entry = JSON.parse(fs.readFileSync(MAP, 'utf8')).entries.find((e) => e.kind === 'file' && e.new === 'scripts/hooks/pr-auto-complete-guard.js');
  assert.ok(entry, 'el mapa lleva el renombre del freno de auto-complete');
  const oldId = ['pr', 'sin', 'auto', 'complete'].join('-');   // el id con que se anotaba ANTES del renombre
  const cmd = 'az repos pr create --repository r --source-branch dev --target-branch main --title t';
  const lines = (script) => {
    const home = tmp('home');
    fs.mkdirSync(path.join(home, '.claude', '.tycon-pipeline'), { recursive: true });
    const r = spawnSync(process.execPath, [path.join(RAIZ, script)], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd } }),
      env: cleanEnv({ HOME: home }), encoding: 'utf8',
    });
    assert.strictEqual(r.status, 2, `${script} tiene que frenar el pull request sin auto-complete (rc ${r.status}: ${r.stderr})`);
    const f = path.join(home, '.claude', '.tycon-pipeline', 'frenos.jsonl');
    const out = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => { const o = JSON.parse(l); delete o.ts; return o; });
    fs.rmSync(home, { recursive: true, force: true });
    return out;
  };
  const byNew = lines(entry.new);
  const byOld = lines(entry.old);
  assert.ok(byNew.length >= 1, 'el freno dejó su constancia');
  assert.ok(byNew.every((o) => o.freno === oldId), `el id del registro no cambia: ${JSON.stringify(byNew)}`);
  assert.deepStrictEqual(byOld, byNew, 'por la ruta vieja (el reemplazo) anota exactamente lo mismo');
});

test('T36 BatchC1_RecordsUnchanged — los registros que suben al buzón conservan su nombre', { skip: SKIP_PUBLIC }, () => {
  const src = fs.readFileSync(path.join(RAIZ, 'scripts', 'metrics', 'upload-runs.js'), 'utf8');
  for (const r of ['bypass.log', 'carriles.jsonl', 'frenos.jsonl', 'gates.log', 'hallazgos.jsonl', 'cobertura.json']) {
    assert.ok(src.includes(`'${r}'`) || src.includes(`"${r}"`), `upload-runs.js sigue subiendo ${r}`);
  }
});

// ── T37: el laboratorio ─────────────────────────────────────────────────────────────────────────────────────────
/** Un arnés de juguete: un hook renombrado (el nuevo real, el viejo un reemplazo), otro que todavía no se mudó, el mapa
 *  y el banco con las claves viejas. */
function benchLab() {
  const root = tmp('bench');
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  fs.copyFileSync(LEGACY_JS, path.join(root, 'scripts', 'lib', 'legacy-names.js'));
  const hooks = path.join(root, 'scripts', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'fresh-notice.js'), 'process.exit(0);\n');
  fs.writeFileSync(path.join(hooks, 'stale-notice.js'), '#!/usr/bin/env node\n// tycon-legacy-shim: scripts/hooks/fresh-notice.js\n');
  fs.writeFileSync(path.join(hooks, 'waiting-notice.js'), 'process.exit(0);\n');   // su entrada existe; no se mudó
  fs.mkdirSync(path.join(root, 'scripts', 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'tests', 'fresh-notice.test.sh'), 'exit 0\n');
  fs.writeFileSync(path.join(root, 'scripts', 'tests', 'stale-notice.test.sh'), '#!/bin/sh\n# tycon-legacy-shim: scripts/tests/fresh-notice.test.sh\n');
  writeJson(path.join(root, 'scripts', 'lib', 'renames.json'), { entries: [
    { kind: 'file', old: 'scripts/hooks/stale-notice.js', new: 'scripts/hooks/fresh-notice.js', batch: 'C1', callers: ['machine'] },
    { kind: 'file', old: 'scripts/hooks/waiting-notice.js', new: 'scripts/hooks/later-notice.js', batch: 'C2', callers: ['machine'] },
    { kind: 'file', old: 'scripts/tests/stale-notice.test.sh', new: 'scripts/tests/fresh-notice.test.sh', batch: 'C1', callers: ['same-repo'] },
  ] });
  const res = (pass) => ({ type: 'must-block', tools: { claude: { pass, failures: pass ? [] : ['x'] } } });
  writeJson(path.join(root, 'scripts', 'controls-bench', 'baseline', 'claude.json'), { tool: 'claude', cases: { 'stale-notice.js::a': true, 'waiting-notice.js::b': true } });
  writeJson(path.join(root, 'scripts', 'controls-bench', 'ultimo-banco.json'), { ts: new Date().toISOString(), results: { 'stale-notice.js::a': res(false), 'waiting-notice.js::b': res(true) } });
  writeJson(path.join(root, 'scripts', 'controls-bench', 'ultimo-suites.json'), { kind: 'bash-tests', ts: new Date().toISOString(), failures: ['stale-notice.test.sh'], motivos: { 'stale-notice.test.sh': 'la prosa nombra stale-notice.test.sh y no se toca' }, reintentos: {} });
  writeJson(path.join(root, 'scripts', 'controls-bench', 'cases', 'hooks', '01-lab.json'), { hook: 'stale-notice.js (avisa algo)', script: '${FIXTURE}/tcg/scripts/hooks/stale-notice.js', cases: [{ id: 'a' }] });
  return root;
}
/** El `--json` de pr-verdict va primero, con sangría: termina en la primera línea que es sólo `}`. */
const verdictJson = (stdout) => JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.indexOf('\n}') + 2));
const migrate = (root, ...extra) => spawnSync(process.execPath, [LEGACY_JS, '--migrate-bench', '--root', root, '--map', path.join(root, 'scripts', 'lib', 'renames.json'), ...extra], { env: cleanEnv(), encoding: 'utf8' });

test('T37 BatchC1_BenchKeysMigrated_NoFalseRed — --migrate-bench migra lo mudado, deja la prosa y lo no mudado, y es idempotente', () => {
  const root = benchLab();
  try {
    const check = migrate(root, '--check');
    assert.strictEqual(check.status, 0, check.stderr);
    assert.match(check.stdout, /por migrar: 4 archivo/);
    assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'controls-bench', 'baseline', 'claude.json'), 'utf8')).cases['stale-notice.js::a'], '--check no escribe');
    const r = migrate(root);
    assert.strictEqual(r.status, 0, r.stderr);
    const read = (...p) => JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'controls-bench', ...p), 'utf8'));
    assert.deepStrictEqual(Object.keys(read('baseline', 'claude.json').cases).sort(), ['fresh-notice.js::a', 'waiting-notice.js::b']);
    assert.deepStrictEqual(Object.keys(read('ultimo-banco.json').results).sort(), ['fresh-notice.js::a', 'waiting-notice.js::b']);
    const suites = read('ultimo-suites.json');
    assert.deepStrictEqual(suites.failures, ['fresh-notice.test.sh']);
    assert.deepStrictEqual(suites.motivos, { 'fresh-notice.test.sh': 'la prosa nombra stale-notice.test.sh y no se toca' });
    const c = read('cases', 'hooks', '01-lab.json');
    assert.strictEqual(c.script, '${FIXTURE}/tcg/scripts/hooks/fresh-notice.js');
    assert.strictEqual(c.hook, 'fresh-notice.js (avisa algo)');
    const again = migrate(root);
    assert.match(again.stdout, /migrados: 0 archivo/, 'la segunda ejecución no cambia nada');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('T37 BatchC1_BenchKeysMigrated_NoFalseRed — veredicto-pr: un rojo viejo con la clave nueva sale como viejo', () => {
  const root = benchLab();
  const out = tmp('ahora');
  try {
    // la foto nocturna con las claves viejas; esta corrida, con las nuevas y el mismo rojo
    // (el caso del que todavía no se mudó sigue con su nombre viejo en las dos: el mapa los une igual)
    fs.writeFileSync(path.join(out, 'banco.json'), JSON.stringify({ results: { 'fresh-notice.js::a': { tools: { claude: { pass: false, failures: ['x'] } } }, 'waiting-notice.js::b': { tools: { claude: { pass: true, failures: [] } } } } }));
    fs.writeFileSync(path.join(out, 'suites.json'), JSON.stringify({ failures: ['fresh-notice.test.sh'] }));
    const run = (tcg) => spawnSync(process.execPath, [VERDICT, '--tcg', tcg, '--current-bench', path.join(out, 'banco.json'), '--suites-actual', path.join(out, 'suites.json'), '--json'], { env: cleanEnv(), encoding: 'utf8' });
    const r = run(root);
    const j = verdictJson(r.stdout);
    assert.deepStrictEqual(j.nuevos, [], `ningún rojo nuevo: ${JSON.stringify(j.nuevos)}`);
    // el rojo del banco, su regresión contra la baseline (que también estaba en la foto) y el de la suite: los tres, viejos
    assert.strictEqual(j.viejos.length, 3, `salen como viejos: ${JSON.stringify(j.viejos)}`);
    assert.strictEqual(r.status, 0, r.stderr);
    // sin el mapa (la copia pública, el artefacto) no hay nada que unir: los dos rojos son nuevos, y no se queja del mapa
    fs.rmSync(path.join(root, 'scripts', 'lib', 'renames.json'));
    const sin = run(root);
    const k = verdictJson(sin.stdout);
    assert.strictEqual(k.nuevos.length, 3, JSON.stringify(k.nuevos));
    assert.ok(!k.avisos.some((a) => /mapa de renombres/.test(a)), 'sin mapa no hay aviso del mapa');
    // un mapa que está y no se deja leer se dice
    fs.writeFileSync(path.join(root, 'scripts', 'lib', 'renames.json'), '{ roto');
    const roto = run(root);
    const m = verdictJson(roto.stdout);
    assert.ok(m.avisos.some((a) => /mapa de renombres está ilegible/.test(a)), JSON.stringify(m.avisos));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('T37 BatchC1_BenchKeysMigrated_NoFalseRed — basenameRenames no adivina: un nombre viejo con dos nuevos no se traduce', () => {
  const L = require(LEGACY_JS);
  const m = L.basenameRenames({ entries: [
    { kind: 'file', old: 'a/x.js', new: 'a/y.js' }, { kind: 'file', old: 'b/x.js', new: 'b/z.js' },
    { kind: 'file', old: 'c/k.js', new: 'd/k.js' }, { kind: 'file', old: 'c/p.js', new: 'c/q.js' },
  ] });
  assert.deepStrictEqual([...m], [['p.js', 'q.js']]);
  assert.strictEqual(L.renameKey('p.js::caso', m), 'q.js::caso');
  assert.strictEqual(L.renameKey('p.js', m), 'q.js');
  assert.strictEqual(L.renameKey('x.js::caso', m), 'x.js::caso');
  // un archivo que sólo se muda de carpeta y otro con el mismo nombre que se renombra: la clave no dice cuál es
  const m2 = L.basenameRenames({ entries: [
    { kind: 'file', old: 'a/w.js', new: 'b/w.js' }, { kind: 'file', old: 'c/w.js', new: 'c/v.js' },
  ] });
  assert.deepStrictEqual([...m2], [], 'un nombre viejo que en una entrada se queda igual no se traduce');
});

// ── T37: el árbol real ──────────────────────────────────────────────────────────────────────────────────────────
test('T37 BatchC1_BenchKeysMigrated_NoFalseRed — en el árbol: ninguna clave vieja de lo mudado, y la baseline tiene todos sus casos', { skip: SKIP_PUBLIC }, () => {
  const check = migrate(RAIZ, '--check');
  assert.strictEqual(check.status, 0, check.stderr);
  assert.match(check.stdout, /por migrar: 0 archivo/, `quedan claves viejas de algo ya mudado:\n${check.stdout}`);
  const list = spawnSync(process.execPath, [path.join(BENCH, 'runner.js'), '--list'], { env: cleanEnv(), encoding: 'utf8' });
  assert.strictEqual(list.status, 0, list.stderr);
  const keys = new Set(list.stdout.split('\n').filter(Boolean).map((l) => l.split(' ')[0]));
  const baseline = Object.keys(JSON.parse(fs.readFileSync(path.join(BENCH, 'baseline', 'claude.json'), 'utf8')).cases);
  const lost = baseline.filter((k) => !keys.has(k));
  assert.deepStrictEqual(lost, [], 'casos de la baseline que el banco ya no tiene (se leerían como desaparecidos)');
});

// ── la mudanza adelantada del nocturno ─────────────────────────────────────────────────────────────────────────────
test('BatchC1_NightlyFolder_CensusWalksIt — el censo del mapa recorre scripts/nightly/<x>/: una pieza nueva sin ficha ahí es roja', { skip: SKIP_PUBLIC }, (t) => {
  const lab = tmp('censo');
  try {
    // el arnés real, más una pieza sin ficha en la carpeta nueva
    fs.cpSync(path.join(RAIZ, 'scripts'), path.join(lab, 'scripts'), { recursive: true });
    for (const d of ['artifacts', 'build', 'commands']) if (fs.existsSync(path.join(RAIZ, d))) fs.cpSync(path.join(RAIZ, d), path.join(lab, d), { recursive: true });
    // los pipelines de Azure viven en pipelines/: sin la carpeta, la copia quedaría sin ellos en silencio
    assert.ok(fs.existsSync(path.join(RAIZ, 'pipelines')), 'el arnés no tiene pipelines/');
    fs.cpSync(path.join(RAIZ, 'pipelines'), path.join(lab, 'pipelines'), { recursive: true });
    fs.mkdirSync(path.join(lab, 'scripts', 'nightly', 'probe'), { recursive: true });
    fs.writeFileSync(path.join(lab, 'scripts', 'nightly', 'probe', 'piece-without-card.js'), 'module.exports = 1;\n');
    const skills = path.join(require(path.join(RAIZ, 'scripts', 'lib', 'skills-dir.js')).resolveSkillsDirs(process.env.TYCON_SKILLS_DIR || '').repo, 'skills');
    const r = spawnSync(process.execPath, [path.join(lab, 'scripts', 'tools', 'harness-map', 'census.js'), '--tcg', lab, '--skills', skills], { env: cleanEnv(), encoding: 'utf8' });
    if (/NO MEDIDO/.test(r.stderr)) { t.skip(`el censo no pudo medir: ${r.stderr.trim()}`); return; }   // salteada, nunca verde
    assert.strictEqual(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /scripts\/nightly\/probe\/piece-without-card\.js/);
  } finally { fs.rmSync(lab, { recursive: true, force: true }); }
});

// La mudanza está terminada (en la carpeta vieja quedan sólo reemplazos) y suites.json no trae disparadores por la vieja:
// las cuatro suites se corren por la nueva, y ninguna suite nombra la vieja. La carpeta
// vieja sale del mapa (escrita acá, esta prueba —que sale en la copia pública— nombraría una ruta vieja).
test('BatchC1_NightlyFolder_GateRunsItsSuites — las suites del nocturno de dependencias se corren por su carpeta nueva y ninguna por la vieja', { skip: SKIP_PUBLIC }, () => {
  const folder = JSON.parse(fs.readFileSync(MAP, 'utf8')).entries.find((e) => e.kind === 'folder' && e.new === 'scripts/nightly/dependencies');
  assert.ok(folder && typeof folder.old === 'string' && folder.old, 'el mapa lleva la mudanza de la carpeta del nocturno de dependencias');
  const suites = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'tests', 'suites.json'), 'utf8'));
  const todas = [...(suites.diarias || []), ...(suites.semanales || [])];
  const delNocturno = ['tests/nightly-dependencies.test.sh', 'tests/work-items.test.sh', 'tests/daily-summary.test.sh', 'tests/open-pr-per-finding.test.sh']
    .map((ruta) => todas.find((s) => s.raiz === 'arnes' && s.ruta === ruta) || { ruta, falta: true });
  assert.deepStrictEqual(delNocturno.filter((s) => s.falta).map((s) => s.ruta), [], 'las cuatro suites del nocturno de dependencias están en suites.json');
  const sinNueva = delNocturno.filter((s) => !(s.gate_only_when_touching || []).includes('scripts/nightly/**')).map((s) => s.ruta);
  assert.deepStrictEqual(sinNueva, [], 'la story que toca sólo el ejecutable mudado no difiere sus suites');
  const porLaVieja = todas.filter((s) => (s.gate_only_when_touching || []).some((g) => g === folder.old || g.startsWith(`${folder.old}/`))).map((s) => s.ruta);
  assert.deepStrictEqual(porLaVieja, [], 'un disparador por la carpeta vieja (sólo quedan reemplazos) no dispara nada de verdad');
});

test('BatchC1_CheckMap_EarlyArrivalIgnoresUntracked — un archivo que git no versiona en la carpeta nueva no la hace chocar', () => {
  const sn = path.join(RAIZ, 'scripts', 'publishing', 'spanish-names.js');
  const repo = tmp('arrival');
  try {
    const g = (...a) => { const r = spawnSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'user.email=l@l', '-c', 'user.name=l', ...a], { encoding: 'utf8' }); assert.strictEqual(r.status, 0, r.stderr); };
    g('init', '-q', '-b', 'main');
    fs.mkdirSync(path.join(repo, 'scripts', 'old-dir'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'scripts', 'new-dir'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'scripts', 'old-dir', 'sibling.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(repo, 'scripts', 'new-dir', 'early.js'), 'module.exports = 2;\n');
    writeJson(path.join(repo, 'scripts', 'lib', 'renames.json'), { entries: [
      { kind: 'folder', old: 'scripts/old-dir', new: 'scripts/new-dir', batch: 'F', callers: ['same-repo'] },
      { kind: 'file', old: 'scripts/old-dir/early-old.js', new: 'scripts/new-dir/early.js', batch: 'C1', callers: ['same-repo'] },
    ] });
    g('add', '-A'); g('commit', '-q', '-m', 'lab');
    fs.writeFileSync(path.join(repo, 'scripts', 'new-dir', '.DS_Store'), 'x');   // sin versionar
    const r = spawnSync(process.execPath, [sn, '--check-map', '--repo', repo], { env: cleanEnv(), encoding: 'utf8' });
    assert.ok(!/choca/.test(r.stderr + r.stdout), `${r.stdout}${r.stderr}`);
    fs.writeFileSync(path.join(repo, 'scripts', 'new-dir', 'other.js'), 'module.exports = 3;\n');
    g('add', '-A'); g('commit', '-q', '-m', 'otro');
    const r2 = spawnSync(process.execPath, [sn, '--check-map', '--repo', repo], { env: cleanEnv(), encoding: 'utf8' });
    assert.match(r2.stderr + r2.stdout, /choca/, 'un archivo versionado que no llegó por el mapa sí choca');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// ── --stale-mentions: el nombre suelto de un archivo renombrado ───────────────────────────────────────────────
test('BatchC1_StaleMentions_LooseNameOnlyInItsFolder — detrás de otra carpeta es otro archivo con el mismo nombre', () => {
  const sn = require(path.join(RAIZ, 'scripts', 'publishing', 'spanish-names.js'));
  const [m] = sn.pathMatchers([{ kind: 'file', old: 'scripts/ci/old-rules.js', new: 'scripts/ci/reviewer-rules.js' }]);
  const loose = m.res[1];
  for (const t of ['corre old-rules.js', 'node scripts/ci/old-rules.js', 'require("./old-rules.js")', 'ci/old-rules.js']) {
    assert.ok(m.res.some((r) => r.test(t)), `es el archivo renombrado: ${t}`);
  }
  for (const t of ['(`lib/old-rules.js` de otro repo)', 'x-old-rules.js', 'old-rules.json']) {
    assert.ok(!m.res.some((r) => r.test(t)), `no es el archivo renombrado: ${t}`);
  }
  assert.ok(loose, 'un archivo que cambia de nombre se busca también por su nombre suelto');
});

// ── el freno de nombres: un reemplazo generado sí, la marca escrita a mano no ─────────────────────────────────
test('BatchC1_GeneratedShimOnly — sólo un reemplazo idéntico al generado deja de contar como nombre', () => {
  const L = require(LEGACY_JS);
  const sn = require(path.join(RAIZ, 'scripts', 'publishing', 'spanish-names.js'));
  const root = tmp('shim');
  try {
    const hooks = path.join(root, 'scripts', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, 'fresh-notice.js'), 'process.exit(0);\n');
    const map = path.join(root, 'renames.json');
    writeJson(map, { entries: [{ kind: 'file', old: 'scripts/hooks/stale-notice.js', new: 'scripts/hooks/fresh-notice.js', batch: 'C1', callers: ['machine'] }] });
    const w = spawnSync(process.execPath, [LEGACY_JS, '--write-shims', '--map', map, '--root', root], { env: cleanEnv(), encoding: 'utf8' });
    assert.strictEqual(w.status, 0, w.stderr);
    const rel = 'scripts/hooks/stale-notice.js';
    const shim = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.ok(L.isGeneratedShim(rel, shim), 'el reemplazo generado se reconoce');
    assert.strictEqual(sn.kindOf(rel, shim), null, 'el freno no lo cuenta como nombre');
    const forged = shim.replace(/\n$/, "\nrequire('child_process').execSync('echo otra cosa');\n");
    assert.ok(!L.isGeneratedShim(rel, forged), 'la marca con otro contenido no es un reemplazo');
    assert.strictEqual(sn.kindOf(rel, forged), 'executable', 'el freno lo mira como cualquier ejecutable');
    assert.ok(!L.isGeneratedShim('scripts/hooks/other-name.js', shim), 'en otra ruta, el mismo texto no es su reemplazo');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── las fichas de las dos colas son datos que escribe el nocturno ──────────────────────────────────────────────────
// Con las dos colas mudadas a `inbox/`, `--stale-mentions` busca la palabra de cada cola con barra en todo archivo
// versionado. Las fichas de `pending/`, `promoted/` y `archived/` las escribe el nocturno, con texto libre de personas (el
// motivo de un rechazo copiado del pull request: «se resuelve junto con <cola>/<id>», «la rama <cola>/<fecha>-…») y rutas
// de los productos: la primera noche que una lo trajera, el control —que una prueba exige en cero— saldría rojo sin que
// nadie tocara código. Son zona de historia, como `.dashboard/`. El README de cada cola NO: es una guía, y una ruta vieja
// ahí es una instrucción viva. Nombres de laboratorio (`ledgers`, `beacons`); las carpetas nuevas, las de verdad.
test('BatchF_StaleMentions_QueueCardsAreData — una ficha que nombra la rama de su cola o la carpeta de antes no es una mención vieja; el README de la cola sí', () => {
  const sn = path.join(RAIZ, 'scripts', 'publishing', 'spanish-names.js');
  const arnes = tmp('cards');
  const skills = tmp('cards-skills');
  try {
    const g = (repo, ...a) => { const r = spawnSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'user.email=l@l', '-c', 'user.name=l', ...a], { encoding: 'utf8' }); assert.strictEqual(r.status, 0, r.stderr); };
    const put = (repo, rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
    writeJson(path.join(arnes, 'scripts', 'lib', 'renames.json'), { entries: [
      { kind: 'folder', old: 'ledgers', new: 'inbox/dependencies', batch: 'lab', callers: ['docs', 'same-repo'] },
      { kind: 'folder', old: 'beacons', new: 'inbox/watcher', batch: 'lab', callers: ['docs', 'same-repo'] },
    ] });
    // las fichas: lo que el nocturno anota (el motivo de un rechazo, tal cual lo escribió una persona)
    put(arnes, 'inbox/dependencies/pending/aa11.yaml', 'id: aa11\nrechazo: "se resuelve junto con ledgers/bb22"\n');
    put(arnes, 'inbox/dependencies/promoted/bb22.yaml', 'id: bb22\nnota: "antes estaba en ledgers/pending/bb22.yaml"\n');
    put(arnes, 'inbox/dependencies/archived/cc33.yaml', 'id: cc33\nrechazo: "ver la rama ledgers/cc33"\n');
    put(arnes, 'inbox/watcher/pending/2026-10-02-lab-1.yaml', 'id: lab-1\nrechazo: "duplicado: lo cubre la rama beacons/2026-10-02-lab-2"\n');
    put(arnes, 'inbox/watcher/promoted/2026-10-02-lab-2.yaml', 'id: lab-2\nnota: "estaba en beacons/pending/"\n');
    put(arnes, 'inbox/watcher/archived/2026-10-02-lab-3.yaml', 'id: lab-3\nrechazo: "beacons/2026-10-02-lab-3 abandonada"\n');
    // lo que NO es dato: la guía de cada cola, y cualquier otra carpeta de la cola
    put(arnes, 'inbox/dependencies/README.md', 'Las fichas viven en `ledgers/pending/`.\n');
    put(arnes, 'inbox/watcher/README.md', 'Los borradores viven en `beacons/pending/`.\n');
    put(arnes, 'inbox/watcher/notes/how-to.md', 'Mirar `beacons/archived/`.\n');
    put(skills, 'README.md', 'nada\n');
    for (const repo of [arnes, skills]) { g(repo, 'init', '-q', '-b', 'main'); g(repo, 'add', '-A'); g(repo, 'commit', '-q', '-m', 'lab'); }

    const r = spawnSync(process.execPath, [sn, '--stale-mentions', '--repo', arnes, '--json'], { env: cleanEnv({ TYCON_SKILLS_DIR: skills }), encoding: 'utf8' });
    assert.ok(r.status === 0 || r.status === 1, `--stale-mentions no pudo mirar (rc ${r.status}): ${r.stderr}`);
    const found = JSON.parse(r.stdout).findings.map((f) => `${f.rel}:${f.line} ${f.old}`).sort();
    assert.deepStrictEqual(found, [
      'inbox/dependencies/README.md:1 ledgers',
      'inbox/watcher/README.md:1 beacons',
      'inbox/watcher/notes/how-to.md:1 beacons',
    ], 'las fichas de pending/, promoted/ y archived/ no cuentan; la guía de la cola y el resto de su carpeta, sí');
    assert.strictEqual(r.status, 1, 'con las tres menciones de verdad, el control sale 1');
  } finally {
    fs.rmSync(arnes, { recursive: true, force: true });
    fs.rmSync(skills, { recursive: true, force: true });
  }
});
