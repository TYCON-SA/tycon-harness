#!/usr/bin/env node
'use strict';
/**
 * adhoc-high-risk.test.js — el riesgo alto en el camino rápido.
 *
 *   T1  una sola regla de riesgo por ruta (lib/risk-paths.js), con el resultado de computeDelicate de antes
 *   T4  el carril delegado no escribe una ruta de riesgo alto (adhoc-high-risk), por la herramienta y por la consola
 *   T6  el carril queda marcado con la regla y el archivo al escribirla o al commitearla
 *   T7  marcado y sin constancias: commit, push y pedido frenan con «faltan los revisores y el pase»
 *   T8  advisors, check-count, deep-review-gate y mark-adversarial-result con --adhoc
 *   T9  con las dos constancias no frena ni pide un ok firmado; un cambio de código después las vence
 *   T15 la base del carril la trae la función (lib/adhoc-base.js); sin red sigue y avisa
 *
 * stable-data: crea repos de git en carpetas temporales con commits propios; nunca toca el repo real.
 * Correr: node --test skills/tycon-pipeline/scripts/tests/adhoc-high-risk.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const MARKER = path.join(SCRIPTS, 'marker.js');
const ON_EDIT = path.join(SCRIPTS, 'on-edit.js');
const riskPaths = require(path.join(SCRIPTS, 'lib', 'risk-paths.js'));
const adhocBase = require(path.join(SCRIPTS, 'lib', 'adhoc-base.js'));
const io = require(path.join(SCRIPTS, 'lib', 'story-gate-io.js'));
const saveBrake = require(path.join(SCRIPTS, 'lib', 'save-brake.js'));
const bash = require(path.join(SCRIPTS, 'on-bash-write-gate.js'));
const { computeDelicate } = require(PIPELINE);

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commitear = (dir, msg = 'x') => git(dir, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', msg);

function tmp(prefijo) { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefijo))); }

/** Un repo con su origen (un repo vacío local, para traer `main` sin red). `nombre` decide el perfil por la carpeta. */
function repoConOrigen(raiz, nombre, { remoto } = {}) {
  const origen = path.join(raiz, `${nombre}-origen.git`);
  const dir = path.join(raiz, nombre);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origen]);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  git(dir, 'remote', 'add', 'origin', remoto || origen);
  fs.mkdirSync(path.join(dir, '.tycon'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  git(dir, 'add', '.');
  commitear(dir, 'base');
  if (!remoto) git(dir, 'push', '-q', 'origin', 'main');
  return dir;
}

/** La carpeta personal de prueba con el estado del pipeline y un carril firmado de la sesión `sid`. */
function conCarril(home, sid, extra = {}) {
  const state = path.join(home, '.claude', '.tycon-pipeline');
  fs.mkdirSync(path.join(state, 'adhoc'), { recursive: true });
  const ts = new Date().toISOString();
  const a = { reason: 'arreglo de prueba del laboratorio', maxFiles: 5, files: [], declaredAt: ts, lastTouch: ts, firmadaEn: ts, ...extra };
  fs.writeFileSync(path.join(state, 'adhoc', `${sid}.json`), JSON.stringify(a));
  fs.appendFileSync(path.join(state, 'gates.log'), `${JSON.stringify({ ts, name: 'adhoc-lane-signed', status: 'ok', destino: sid })}\n`);
  return state;
}
const leerCarril = (state, sid) => JSON.parse(fs.readFileSync(path.join(state, 'adhoc', `${sid}.json`), 'utf8'));
const escribirCarril = (state, sid, a) => fs.writeFileSync(path.join(state, 'adhoc', `${sid}.json`), JSON.stringify(a));

/** on-edit.js como lo corre la herramienta, con la carpeta personal de prueba. */
function onEdit(home, sid, file) {
  return spawnSync(process.execPath, [ON_EDIT], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Write', session_id: sid, tool_input: { file_path: file } }),
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid }, encoding: 'utf8',
  });
}
function cli(script, args, { home, sid, cwd }) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd, env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid }, encoding: 'utf8',
  });
}
function escribir(dir, rel, txt = 'x\n') {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), txt);
}

// ── T1 ───────────────────────────────────────────────────────────────────────────────────────────

// El resultado de computeDelicate con las reglas escritas dentro de pipeline.js, sobre el mismo armado: mover las
// reglas a risk-paths.js no lo cambia.
const ANTES = {
  sensible: [true, 'rutas-sensibles'], 'dos-reglas': [true, 'rutas-sensibles'], produccion: [true, 'produccion'],
  'pipeline-prod': [true, 'produccion'], 'pipeline-sin-prod': [false, null], 'pipeline-ilegible': [true, 'produccion'],
  migracion: [true, 'porton-instalador-migracion'], 'declara-sensible': [true, 'sensible'],
  'lo-sensible-del-arnes': [true, 'controles'], ninguna: [false, null], superficie: [true, 'superficie-compartida'],
  'controles-ilegibles': [true, 'no-pude-saber'],
};
const CASOS = [
  ['sensible', ['src/auth/login.js']], ['dos-reglas', ['scripts/x.sql', 'src/auth/y.js']],
  ['produccion', ['.tycon/production.json']], ['pipeline-prod', ['pipelines/deploy.yml']],
  ['pipeline-sin-prod', ['pipelines/build.yml']], ['pipeline-ilegible', ['pipelines/no-existe.yml']],
  ['migracion', ['db/001.sql']], ['declara-sensible', ['src/app.js'], 'sensible: [pagos]\n'],
  ['lo-sensible-del-arnes', ['scripts/lib/signatures.js']], ['ninguna', ['src/app.js']],
  ['superficie', ['Services/Plugins/a.cs']], ['controles-ilegibles', ['src/app.js'], '', true],
];
function repoDeRiesgo({ controlesRotos } = {}) {
  const d = tmp('rp-');
  execFileSync('git', ['init', '-q', d]);
  escribir(d, '.tycon/advisors.yaml', 'deep_review_always_paths:\n  - Services/Plugins/**\n');
  escribir(d, 'pipelines/deploy.yml', 'stages:\n  - stage: Prod\n');
  escribir(d, 'pipelines/build.yml', 'stages:\n  - stage: Build\n');
  if (controlesRotos) escribir(d, 'scripts/ci/controls-from-base.json', '{"x":1}');
  return d;
}

test('T1 RiskPaths_MismaReglaQueComputeDelicate — @story-8.174 @ac-1', () => {
  for (const [nombre, files, extra, rotos] of CASOS) {
    const d = repoDeRiesgo({ controlesRotos: rotos });
    const s = path.join(d, 'story.md');
    fs.writeFileSync(s, `---\nstory: "9.9"\nstatus: draft\n${extra || ''}files_to_modify:\n${files.map((f) => `  - ${f}`).join('\n')}\n---\n`);
    const r = computeDelicate({ story: s, repo: d });
    assert.deepStrictEqual([r.value, r.rule], ANTES[nombre], `${nombre}: ${r.reason}`);
  }
  // la regla, sola, por ruta y por conjunto
  const d = repoDeRiesgo();
  const una = (rel) => riskPaths.riesgoDeRuta(path.join(d, rel), { repo: d });
  assert.equal(una('src/auth/x.js').rule, 'rutas-sensibles');
  assert.equal(una('.tycon/production.json').rule, 'produccion');
  assert.equal(una('pipelines/deploy.yml').rule, 'produccion');
  assert.equal(una('db/migrations/001.sql').rule, 'porton-instalador-migracion');
  assert.equal(una('scripts/lib/signatures.js').rule, 'controles');
  assert.equal(una('Services/Plugins/a.cs').rule, 'superficie-compartida');
  assert.equal(una('src/app.js').value, false);
  const dos = riskPaths.riesgoDeArchivos(['scripts/x.sql', 'src/auth/y.js'], { repo: d });
  assert.equal(dos.rule, 'rutas-sensibles');
  assert.equal(dos.file, 'src/auth/y.js');
  const roto = repoDeRiesgo({ controlesRotos: true });
  const r = riskPaths.riesgoDeArchivos(['src/app.js'], { repo: roto });
  assert.equal(r.rule, 'no-pude-saber');
  assert.match(r.reason, /no pude saber/);
});

// ── T15 ──────────────────────────────────────────────────────────────────────────────────────────

test('T15 Base_LaTraeLaFuncion_SinRedAvisa — @story-8.174 @ac-14', () => {
  const raiz = tmp('ab-');
  const dir = repoConOrigen(raiz, 'producto');
  const remota = git(dir, 'rev-parse', 'HEAD');
  // el origin/main local movido a otro commit no cambia la base: la base se trae
  escribir(dir, 'otro.txt');
  git(dir, 'add', '.');
  commitear(dir, 'local');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const b = adhocBase.traerBase(dir);
  assert.equal(b.traida, true);
  assert.equal(b.sha, remota);
  // sin red (un origen que no contesta): sigue, anota «sin traer» y avisa
  const sinRed = repoConOrigen(raiz, 'aislado', { remoto: path.join(raiz, 'no-existe.git') });
  const n = adhocBase.traerBase(sinRed);
  assert.equal(n.traida, false);
  assert.equal(n.sha, null);
  assert.ok(n.motivo);
  // con la base: entran lo commiteado en la rama y lo modificado sin preparar de un archivo seguido (el `-z` va antes
  // del `--`; si no, git lo lee como una ruta y el diff contra la base sale vacío — hallazgo del pase adversarial)
  const conBase = repoConOrigen(raiz, 'rama');
  escribir(conBase, 'src/seguido.js', 'a\n');
  git(conBase, 'add', '.');
  commitear(conBase, 'seguido');
  git(conBase, 'push', '-q', 'origin', 'main');
  const baseRama = adhocBase.traerBase(conBase);
  escribir(conBase, 'src/prev.js');
  git(conBase, 'add', '.');
  commitear(conBase, 'en la rama');
  fs.writeFileSync(path.join(conBase, 'src/seguido.js'), 'b\n');
  const medido = adhocBase.archivosDelCarril({ rutas: [], bases: { [conBase]: baseRama } }).porRepo[conBase];
  assert.ok(medido.includes('src/prev.js') && medido.includes('src/seguido.js'), JSON.stringify(medido));
  // «fuera de un repo» se reconoce con git en otro idioma
  const ub = spawnSync(process.execPath, ['-e', `console.log(JSON.stringify(require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'adhoc-base.js'))}).ubicar(${JSON.stringify(tmp('nogit-'))})))`],
    { env: { ...process.env, LANG: 'es_AR.UTF-8', LC_ALL: 'es_AR.UTF-8', LANGUAGE: 'es' }, encoding: 'utf8' });
  assert.equal(JSON.parse(ub.stdout).fuera, true, ub.stdout + ub.stderr);
  // al medir sin base: lo registrado y el commit, y el aviso dice que la rama no se midió
  escribir(sinRed, 'src/a.js');
  const m = adhocBase.archivosDelCarril({ rutas: [path.join(sinRed, 'src/a.js')], bases: { [sinRed]: n } });
  assert.ok(m.porRepo[sinRed].includes('src/a.js'));
  assert.ok(m.avisos.some((a) => /la rama no se midió/.test(a)));
  // el primer toque de un repo del carril trae la base y la anota (on-edit)
  const home = tmp('home-');
  const state = conCarril(home, 's15');
  escribir(dir, 'src/b.js');
  const r = onEdit(home, 's15', path.join(dir, 'src/b.js'));
  assert.equal(r.status, 0, r.stderr);
  const a = leerCarril(state, 's15');
  assert.equal(a.bases[dir].sha, remota);
  assert.ok(a.rutas.includes(path.join(dir, 'src/b.js')));
  // sin red, por el registro de ediciones: el carril anota la base «sin traer», avisa y lo deja en gates.log
  const s2 = conCarril(home, 's15b');
  const r2 = onEdit(home, 's15b', path.join(sinRed, 'src/a.js'));
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(leerCarril(s2, 's15b').bases[sinRed].traida, false);
  assert.match(r2.stdout, /sin traer/);
  assert.match(fs.readFileSync(path.join(s2, 'gates.log'), 'utf8'), /"name":"adhoc-base"[^\n]*sin traer/);
});

// ── T4 ───────────────────────────────────────────────────────────────────────────────────────────

test('T4 Delegado_EditaRiesgoAlto_Frena — @story-8.174 @ac-3', () => {
  const raiz = tmp('t4-');
  const arnes = repoConOrigen(raiz, 'tycon-harness');
  const prod = repoConOrigen(raiz, 'producto');
  const home = tmp('home-');
  const state = conCarril(home, 'del', { via: 'delegacion' });
  conCarril(home, 'per');
  const ev = (sid, file, dir) => io.evaluate({ filePath: path.join(dir, file), sessionId: sid, cwd: dir, via: 'Edit', stateDir: state, installedRoots: [] });
  for (const f of ['skills/a/auth/b.js', '.tycon/production.json', 'scripts/x.sql']) {
    const r = ev('del', f, arnes);
    assert.equal(r.verdict.action, 'block', f);
    assert.equal(r.verdict.kind, 'adhoc-high-risk', f);
    assert.match(r.message, new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  // lo sensible del arnés, que hoy pasaba por la puerta real, también frena (con su propio freno)
  assert.equal(ev('del', 'scripts/lib/signatures.js', arnes).verdict.kind, 'adhoc-sensitive');
  // por la consola, con las formas que la puerta ya lee: la misma cuenta
  for (const command of ["sed -i '' 's/a/b/' skills/a/auth/b.js", "echo '{}' | tee .tycon/production.json", "echo '{}' > .tycon/production.json"]) {
    const b = bash.handle({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'del', cwd: arnes,
      tool_input: { command } }, { stateDir: state, installedRoots: [] });
    assert.ok(b && /RUTA DE RIESGO ALTO/.test(b.block), `${command}: ${JSON.stringify(b)}`);
  }
  // el carril de una persona la escribe, en el arnés y en un producto
  assert.notEqual(ev('per', 'skills/a/auth/b.js', arnes).verdict.kind, 'adhoc-high-risk');
  assert.notEqual(ev('per', 'src/auth/x.ts', prod).verdict.kind, 'adhoc-high-risk');
  // lo que no es de riesgo alto pasa también al delegado
  assert.notEqual(ev('del', 'skills/a/b.js', arnes).verdict.kind, 'adhoc-high-risk');
  // un archivo de control de la constancia de controles del repo frena con adhoc-high-risk
  escribir(arnes, 'scripts/ci/controls-from-base.json', JSON.stringify({ controls: [{ script: 'scripts/ci/mi-control.js' }] }));
  escribir(arnes, 'scripts/ci/mi-control.js', '// x\n');
  const ctl = ev('del', 'scripts/ci/mi-control.js', arnes);
  assert.equal(ctl.verdict.kind, 'adhoc-high-risk');
  assert.equal(ctl.verdict.regla, 'controles');
  // un enlace con nombre inocente que apunta a una migración: decide la ruta real
  escribir(arnes, 'db/001.sql', 'select 1;\n');
  fs.symlinkSync(path.join(arnes, 'db/001.sql'), path.join(arnes, 'notas.txt'));
  assert.equal(ev('del', 'notas.txt', arnes).verdict.kind, 'adhoc-high-risk');
});

// ── T6 ───────────────────────────────────────────────────────────────────────────────────────────

test('T6 Carril_SeMarcaRiesgoAlto — @story-8.174 @ac-5', () => {
  const raiz = tmp('t6-');
  const prod = repoConOrigen(raiz, 'producto');
  const home = tmp('home-');
  const state = conCarril(home, 'p1');
  // escribir una ruta común: no marca
  escribir(prod, 'src/app.ts');
  assert.equal(onEdit(home, 'p1', path.join(prod, 'src/app.ts')).status, 0);
  assert.equal(leerCarril(state, 'p1').riesgoAlto, undefined);
  // escribir una de riesgo alto: marca con la regla y el archivo
  escribir(prod, 'src/auth/x.ts');
  assert.equal(onEdit(home, 'p1', path.join(prod, 'src/auth/x.ts')).status, 0);
  const a = leerCarril(state, 'p1');
  assert.equal(a.riesgoAlto.regla, 'rutas-sensibles');
  assert.equal(a.riesgoAlto.archivo, path.join(prod, 'src/auth/x.ts'));
  // commitear una que la herramienta no vio (escrita por la consola): el freno de guardar la marca
  const prod2 = repoConOrigen(raiz, 'producto2');
  escribir(prod2, 'src/app.ts');
  escribir(prod2, 'db/migrations/001.sql', 'select 1;\n');
  git(prod2, 'add', 'db/migrations/001.sql');
  const state2 = conCarril(home, 'p2', { rutas: [path.join(prod2, 'src/app.ts')], bases: { [prod2]: adhocBase.traerBase(prod2) } });
  const d = saveBrake.decidir({ command: 'git commit -m x', cwd: prod2, sid: 'p2', home });
  assert.ok(d && d.texto, JSON.stringify(d));
  assert.equal(leerCarril(state2, 'p2').riesgoAlto.regla, 'porton-instalador-migracion');
  // un commit sin rutas de riesgo alto: no marca
  const otro = repoConOrigen(raiz, 'otro');
  const s3 = conCarril(home, 'p3');
  escribir(otro, 'src/app.ts');
  git(otro, 'add', '.');
  const d3 = saveBrake.decidir({ command: 'git commit -m x', cwd: otro, sid: 'p3', home });
  assert.ok(!d3 || !d3.texto, JSON.stringify(d3));
  assert.equal(leerCarril(s3, 'p3').riesgoAlto, undefined);
  // un archivo nuevo sin rastrear (un `git add -A && git commit` en el mismo comando) y con acentos en el nombre: marca
  const s4 = conCarril(home, 'p4');
  escribir(otro, 'db/migración nueva.sql', 'select 1;\n');
  const d4 = saveBrake.decidir({ command: 'git add -A && git commit -m x', cwd: otro, sid: 'p4', home });
  assert.ok(d4 && d4.texto, JSON.stringify(d4));
  assert.equal(leerCarril(s4, 'p4').riesgoAlto.archivo, path.join(otro, 'db/migración nueva.sql'));
  // un archivo de riesgo alto movido a una ruta común (`git mv`) también marca: la ruta vieja cuenta (hallazgo del pase)
  const movido = repoConOrigen(raiz, 'movido');
  escribir(movido, 'scripts/production/deploy.js');
  git(movido, 'add', '.');
  commitear(movido, 'deploy');
  git(movido, 'push', '-q', 'origin', 'main');
  const s6 = conCarril(home, 'p6', { bases: { [movido]: adhocBase.traerBase(movido) } });
  fs.mkdirSync(path.join(movido, 'lib'), { recursive: true });
  git(movido, 'mv', 'scripts/production/deploy.js', 'lib/deploy.js');
  const d6 = saveBrake.decidir({ command: 'git commit -m x', cwd: movido, sid: 'p6', home });
  assert.ok(d6 && d6.texto, JSON.stringify(d6));
  assert.equal(leerCarril(s6, 'p6').riesgoAlto.regla, 'produccion');
  // una ruta fuera de todo repo, aunque una carpeta de arriba se llame «auth» o «secret»: no marca (hallazgo del pase)
  const s7 = conCarril(home, 'p7');
  const afuera = path.join(tmp('secret-auth-'), 'auth', 'nota.js');
  escribir(path.dirname(afuera), 'nota.js');
  assert.equal(onEdit(home, 'p7', afuera).status, 0);
  assert.equal(leerCarril(s7, 'p7').riesgoAlto, undefined);
  // un registro del carril que no se lee no es «no hay carril»: pregunta y lo anota
  const s5 = conCarril(home, 'p5');
  fs.writeFileSync(path.join(s5, 'adhoc', 'p5.json'), '{ roto');
  const d5 = saveBrake.decidir({ command: 'git commit -m x', cwd: otro, sid: 'p5', home });
  assert.ok(d5 && /no pude leer el registro del camino rápido/.test(d5.pregunta), JSON.stringify(d5));
  assert.match(fs.readFileSync(path.join(s5, 'gates.log'), 'utf8'), /registro del camino rápido ilegible/);
});

// ── T7 ───────────────────────────────────────────────────────────────────────────────────────────

test('T7 RiesgoAlto_SinConstancias_NoGuarda — @story-8.174 @ac-6', () => {
  const raiz = tmp('t7-');
  const prod = repoConOrigen(raiz, 'producto');
  const home = tmp('home-');
  escribir(prod, 'src/auth/x.ts');
  conCarril(home, 's7', { rutas: [path.join(prod, 'src/auth/x.ts')], bases: { [prod]: adhocBase.traerBase(prod) },
    riesgoAlto: { regla: 'rutas-sensibles', archivo: path.join(prod, 'src/auth/x.ts') } });
  for (const cmd of ['git commit -m x', 'git push origin main', 'gh pr create --fill']) {
    const d = saveBrake.decidir({ command: cmd, cwd: prod, sid: 's7', home });
    assert.ok(d && d.texto, `${cmd}: ${JSON.stringify(d)}`);
    assert.match(d.texto, /faltan los revisores y el pase/);
    assert.match(d.texto, /advisors --adhoc/);
    assert.match(d.texto, /deep-review-gate --adhoc/);
    // en un repo de producto, el freno elige el texto de producto
    assert.doesNotMatch(d.texto, /dueñ[oa]|coordinadora|delegaci|constancia/i);
  }
  // un comando que no guarda no frena
  assert.equal(saveBrake.decidir({ command: 'git status', cwd: prod, sid: 's7', home }), null);
});

// ── T8 ───────────────────────────────────────────────────────────────────────────────────────────

test('T8 Advisors_y_DeepReviewGate_ConAdhoc — @story-8.174 @ac-7', () => {
  const raiz = tmp('t8-');
  const prod = repoConOrigen(raiz, 'producto');
  const home = tmp('home-');
  escribir(prod, 'src/auth/x.ts', 'export const a = 1;\n');
  const state = conCarril(home, 's8', { rutas: [path.join(prod, 'src/auth/x.ts')], bases: { [prod]: adhocBase.traerBase(prod) },
    riesgoAlto: { regla: 'rutas-sensibles', archivo: path.join(prod, 'src/auth/x.ts') } });
  const ctx = { home, sid: 's8', cwd: prod };
  // advisors --adhoc: el set del diff del carril y el expected en el registro del carril
  const adv = cli(PIPELINE, ['advisors', '--adhoc'], ctx);
  assert.equal(adv.status, 0, adv.stderr);
  const set = JSON.parse(adv.stdout);
  assert.ok(Array.isArray(set.all) && set.all.length > 0, adv.stdout);
  assert.ok(set.files.includes(path.join(prod, 'src/auth/x.ts')));
  // sin historia, los revisores que piden una no entran
  for (const r of ['tycon-story-validator', 'tycon-spec-first-checker', 'tycon-ac-coverage-checker', 'tycon-deferral-tracker']) assert.ok(!set.all.includes(r), r);
  const a1 = leerCarril(state, 's8');
  assert.deepStrictEqual(a1.revisoresEsperados.expected, set.all);
  assert.equal(a1.revisoresEsperados.repo, prod);
  // --repo elige otro repo del carril para medir; uno que no es del carril se rechaza
  const otro = repoConOrigen(raiz, 'otro');
  const ajeno = repoConOrigen(raiz, 'ajeno');
  escribir(otro, 'src/b.ts');
  escribirCarril(state, 's8', { ...leerCarril(state, 's8'), rutas: [path.join(prod, 'src/auth/x.ts'), path.join(otro, 'src/b.ts')] });
  const conRepo = cli(PIPELINE, ['advisors', '--adhoc', '--repo', otro], ctx);
  assert.equal(conRepo.status, 0, conRepo.stderr);
  assert.equal(JSON.parse(conRepo.stdout).repo, otro);
  assert.equal(leerCarril(state, 's8').revisoresEsperados.repo, otro);
  const conAjeno = cli(PIPELINE, ['advisors', '--adhoc', '--repo', ajeno], ctx);
  assert.equal(conAjeno.status, 2);
  assert.match(conAjeno.stderr, /no es un repo del camino rápido/);
  assert.equal(cli(PIPELINE, ['advisors', '--adhoc'], ctx).status, 0);
  // sin corrida: no anota el inicio del paso de revisores de una corrida (step5-start)
  const runs = path.join(state, 'advisor-runs');
  assert.ok(!fs.existsSync(path.join(runs, 's8.jsonl')) || !/step5-start/.test(fs.readFileSync(path.join(runs, 's8.jsonl'), 'utf8')));
  // check-count --adhoc: sin los revisores lanzados no escribe la constancia; con uno que falta, tampoco
  const sinNada = cli(PIPELINE, ['check-count', '--adhoc'], ctx);
  assert.equal(sinNada.status, 2, sinNada.stdout);
  assert.equal(leerCarril(state, 's8').revisores, undefined);
  fs.mkdirSync(runs, { recursive: true });
  const ts = new Date(Date.now() + 1000).toISOString();
  if (set.all.length > 1) {
    fs.writeFileSync(path.join(runs, 's8.jsonl'), set.all.slice(1).map((r) => JSON.stringify({ ts, advisor: r })).join('\n') + '\n');
    const falta = cli(PIPELINE, ['check-count', '--adhoc'], ctx);
    assert.equal(falta.status, 2, falta.stdout);
    assert.match(falta.stderr, new RegExp(set.all[0]));
    assert.equal(leerCarril(state, 's8').revisores, undefined);
  }
  // con todos lanzados por la sesión desde ese momento, la escribe con la huella
  fs.writeFileSync(path.join(runs, 's8.jsonl'), set.all.map((r) => JSON.stringify({ ts, advisor: r })).join('\n') + '\n');
  const ok = cli(PIPELINE, ['check-count', '--adhoc'], ctx);
  assert.equal(ok.status, 0, ok.stderr);
  const a2 = leerCarril(state, 's8');
  assert.equal(a2.revisores.huella, adhocBase.huellaDelCarril(a2));
  // deep-review-gate --adhoc: decide con las reglas de siempre
  const gate = cli(PIPELINE, ['deep-review-gate', '--adhoc'], ctx);
  assert.equal(gate.status, 0, gate.stderr);
  const g = JSON.parse(gate.stdout);
  assert.equal(typeof g.run, 'boolean');
  assert.ok(g.reason);
  // mark-adversarial-result --adhoc: la constancia del pase en el registro del carril
  const res = path.join(raiz, 'pase.json');
  fs.writeFileSync(res, JSON.stringify({ confirmed: [], lentes: [{ lens: 'a', estado: 'medida' }], detalle: [] }));
  const m = cli(MARKER, ['mark-adversarial-result', '0', '--adhoc', '--result', res, '--model', 'sonnet'], ctx);
  assert.equal(m.status, 0, m.stderr);
  const a3 = leerCarril(state, 's8');
  assert.equal(a3.pase.huella, adhocBase.huellaDelCarril(a3));
  assert.equal(a3.pase.confirmados, 0);
  // cambiar un archivo entre pedir los revisores y contarlos: la cuenta no escribe la constancia
  assert.equal(cli(PIPELINE, ['advisors', '--adhoc'], ctx).status, 0);
  const lanzados = JSON.parse(cli(PIPELINE, ['advisors', '--adhoc'], ctx).stdout).all;
  const ts2 = new Date(Date.now() + 2000).toISOString();
  fs.appendFileSync(path.join(runs, 's8.jsonl'), lanzados.map((r) => JSON.stringify({ ts: ts2, advisor: r })).join('\n') + '\n');
  fs.writeFileSync(path.join(prod, 'src/auth/x.ts'), 'export const a = 3;\n');
  const cambiado = cli(PIPELINE, ['check-count', '--adhoc'], ctx);
  assert.equal(cambiado.status, 2, cambiado.stdout);
  assert.match(cambiado.stderr, /cambiaron después de pedir los revisores/);
  // un carril sólo de documentación: el portón no corre el pase y deja la constancia del salteo
  const home2 = tmp('home-');
  const docs = repoConOrigen(raiz, 'docs');
  escribir(docs, 'docs/guia.md', '# x\n');
  // un archivo fuera de todo repo (la carpeta temporal de la sesión) no deja la huella incompleta
  const suelto = path.join(tmp('suelto-'), 'nota.txt');
  fs.writeFileSync(suelto, 'x');
  const s2 = conCarril(home2, 's8b', { rutas: [path.join(docs, 'docs/guia.md'), suelto], bases: { [docs]: adhocBase.traerBase(docs) } });
  assert.ok(adhocBase.huellaCompleta(adhocBase.huellaDelCarril(leerCarril(s2, 's8b'))));
  const g2 = cli(PIPELINE, ['deep-review-gate', '--adhoc'], { home: home2, sid: 's8b', cwd: docs });
  assert.equal(g2.status, 0, g2.stderr);
  assert.equal(JSON.parse(g2.stdout).run, false, g2.stdout);
  assert.equal(leerCarril(s2, 's8b').pase.salteado, true);
  // con un repo de documentación y otro de código en el mismo carril, manda el más estricto: corre
  escribirCarril(s2, 's8b', { ...leerCarril(s2, 's8b'), pase: undefined, rutas: [path.join(docs, 'docs/guia.md'), path.join(prod, 'src/auth/x.ts')] });
  const g3 = cli(PIPELINE, ['deep-review-gate', '--adhoc'], { home: home2, sid: 's8b', cwd: docs });
  assert.equal(g3.status, 0, g3.stderr);
  assert.equal(JSON.parse(g3.stdout).run, true, g3.stdout);
  assert.equal(leerCarril(s2, 's8b').pase, undefined);
});

// ── T9 ───────────────────────────────────────────────────────────────────────────────────────────

test('T9 RiesgoAlto_ConConstancias_NoFrena_YVencen — @story-8.174 @ac-8 @ac-9', () => {
  const raiz = tmp('t9-');
  const prod = repoConOrigen(raiz, 'producto');
  const home = tmp('home-');
  const f = path.join(prod, 'src/auth/x.ts');
  escribir(prod, 'src/auth/x.ts', 'export const a = 1;\n');
  const base = { rutas: [f], bases: { [prod]: adhocBase.traerBase(prod) }, riesgoAlto: { regla: 'rutas-sensibles', archivo: f } };
  const huella = adhocBase.huellaDelCarril(base);
  const state = conCarril(home, 's9', { ...base, revisores: { huella, at: new Date().toISOString() }, pase: { huella, at: new Date().toISOString(), confirmados: 0 } });
  const d = saveBrake.decidir({ command: 'git commit -m x', cwd: prod, sid: 's9', home });
  // no frena por las constancias ni pide ningún ok firmado: pregunta como todo guardado del camino rápido
  assert.ok(d && !d.texto && typeof d.pregunta === 'string', JSON.stringify(d));
  assert.doesNotMatch(d.pregunta, /firm|ok de guardar|approve-save|faltan los revisores/i);
  // un archivo de código editado después vence las dos
  fs.writeFileSync(f, 'export const a = 2;\n');
  const d2 = saveBrake.decidir({ command: 'git commit -m x', cwd: prod, sid: 's9', home });
  assert.ok(d2 && d2.texto, JSON.stringify(d2));
  assert.match(d2.texto, /faltan los revisores y el pase/);
  assert.ok(leerCarril(state, 's9').riesgoAlto);
  // un archivo de riesgo alto que no es código (una migración) editado después también las vence
  const m = path.join(prod, 'db/001.sql');
  escribir(prod, 'db/001.sql', 'select 1;\n');
  const conMigracion = { ...base, rutas: [f, m] };
  const h2 = adhocBase.huellaDelCarril(conMigracion);
  escribirCarril(state, 's9', { ...leerCarril(state, 's9'), rutas: [f, m], revisores: { huella: h2 }, pase: { huella: h2, confirmados: 0 } });
  assert.ok(!(saveBrake.decidir({ command: 'git commit -m x', cwd: prod, sid: 's9', home }) || {}).texto);
  fs.writeFileSync(m, 'drop table x;\n');
  const d3 = saveBrake.decidir({ command: 'git commit -m x', cwd: prod, sid: 's9', home });
  assert.ok(d3 && d3.texto, JSON.stringify(d3));
  // un archivo seguido que el carril no anotó, cambiado después (por `git apply`, por ejemplo): vence (hallazgo del pase)
  escribir(prod, 'src/otro.js', 'x\n');
  git(prod, 'add', 'src/otro.js');
  commitear(prod, 'otro');
  const h3 = adhocBase.huellaDelCarril(conMigracion);
  fs.writeFileSync(path.join(prod, 'src/otro.js'), 'y\n');
  assert.notEqual(adhocBase.huellaDelCarril(conMigracion), h3);
});
