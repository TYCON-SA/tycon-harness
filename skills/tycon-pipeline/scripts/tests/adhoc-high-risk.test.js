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
 *   T16 lo que otro pedido metió en `main` después de que la rama salió no se mide como propio
 *   T17 antes de frenar vuelve a medir: la marca de un archivo que ya no es del carril se levanta
 *   T18 lo propio sigue frenando: commiteado, sin commitear, en un merge, en otra rama, ignorado, escondido del índice,
 *       en un enlace, fuera de un repo, sin red, con la medición incompleta
 *   T19 traer `main` a la rama no vence las constancias si lo propio no cambió
 *   T20 la pantalla de otro pedido que la rama trajo no pide maqueta; sin red sigue pidiéndola y lo anota
 *   T21 guardar en un repo ajeno no lo suma al carril
 *   T22 la sonda de un agente del pase no entra al carril ni vence las constancias; el código de un subagente, sí entra
 *   T23 si git no contesta al ubicar lo que escribe un subagente, se anota igual
 *   T24 una ruta que sólo parece de la carpeta de sondas (con `..`, o dentro de src/) se anota
 *   T25 con un carril que todavía no mide ningún repo, lo que escribe un subagente se anota
 *   T26 si git no ubica una ruta ya anotada, lo que escribe un subagente se anota
 *   T27 la sonda que un subagente escribe por consola no entra al carril; su código sí
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
function cli(script, args, { home, sid, cwd, env = {} }) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd, env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, ...env }, encoding: 'utf8',
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
  // `advisors` lee los paquetes de revisores del arnés: la HOME de prueba no tiene el enlace, y en el árbol que arma el nocturno tampoco se deduce solo
  const ctx = { home, sid: 's8', cwd: prod, env: { TYCON_GUIDES_DIR: path.resolve(SCRIPTS, '..', '..', '..') } };
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
  // (8.215, T16) una lente limpia sin su prueba guardada en disco: el carril no anota el pase
  const res = path.join(raiz, 'step-05b-adversarial.json');
  const cazaA = (dir) => path.join(dir, 'step-05b-probes', 'caza-a');
  fs.writeFileSync(res, JSON.stringify({ confirmed: [], lentes: [{ lens: 'a', estado: 'medida', count: 0, probe_dir: cazaA(raiz) }], detalle: [] }));
  const sinPrueba = cli(MARKER, ['mark-adversarial-result', '0', '--adhoc', '--result', res, '--model', 'sonnet'], ctx);
  assert.equal(sinPrueba.status, 2, sinPrueba.stdout);
  assert.match(sinPrueba.stderr, /sin medir/);
  assert.equal(leerCarril(state, 's8').pase, undefined, 'no anotó nada');
  // (8.215, T20) con su prueba al lado del resultado, anota
  fs.mkdirSync(cazaA(raiz), { recursive: true });
  fs.writeFileSync(path.join(cazaA(raiz), 'COMO-SE-CORRIO.txt'), 'node probe.js\n→ ok\n');
  const m = cli(MARKER, ['mark-adversarial-result', '0', '--adhoc', '--result', res, '--model', 'sonnet'], ctx);
  assert.equal(m.status, 0, m.stderr);
  const a3 = leerCarril(state, 's8');
  assert.equal(a3.pase.huella, adhocBase.huellaDelCarril(a3));
  assert.equal(a3.pase.confirmados, 0);
  // (8.215, T20) y sin runDir: el resultado y la prueba en la carpeta por defecto del guion
  const sinCorrida = path.join(raiz, '.advisors', 'pipeline-runs', 'adversarial-sin-corrida');
  fs.mkdirSync(cazaA(sinCorrida), { recursive: true });
  fs.writeFileSync(path.join(cazaA(sinCorrida), 'COMO-SE-CORRIO.txt'), 'node probe.js\n→ ok\n');
  const res2 = path.join(sinCorrida, 'step-05b-adversarial.json');
  fs.writeFileSync(res2, JSON.stringify({ confirmed: [], lentes: [{ lens: 'a', estado: 'medida', count: 0, probe_dir: cazaA(sinCorrida) }], detalle: [] }));
  const m2 = cli(MARKER, ['mark-adversarial-result', '0', '--adhoc', '--result', res2, '--model', 'sonnet'], ctx);
  assert.equal(m2.status, 0, m2.stderr);
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

// ── T16-T19: la rama atrasada contra main ────────────────────────────────────────────────────────

/** Un repo en una rama con un commit propio, y `entraAMain`: otro pedido que llega a `main` después de que la rama salió. */
function ramaAtrasada(raiz, nombre) {
  const dir = repoConOrigen(raiz, nombre);
  escribir(dir, 'src/propio.js', 'a\n');
  escribir(dir, 'src/auth/x.ts', 'a\n');
  git(dir, 'add', '.');
  commitear(dir, 'base del producto');
  git(dir, 'push', '-q', 'origin', 'main');
  const otro = path.join(raiz, `${nombre}-otro`);
  execFileSync('git', ['clone', '-q', path.join(raiz, `${nombre}-origen.git`), otro]);
  git(dir, 'switch', '-qc', 'rama');
  escribir(dir, 'src/propio.js', 'b\n');
  git(dir, 'add', '.');
  commitear(dir, 'lo propio');
  const entraAMain = (rel, txt = 'de otro pedido\n') => {
    escribir(otro, rel, txt);
    git(otro, 'add', '.');
    commitear(otro, 'otro pedido');
    git(otro, 'push', '-q', 'origin', 'main');
    return git(otro, 'rev-parse', 'HEAD');
  };
  const traerMain = () => { git(dir, 'fetch', '-q', 'origin', 'main'); git(dir, '-c', 'user.email=a@b', '-c', 'user.name=a', 'merge', '-q', '--no-edit', 'FETCH_HEAD'); };
  return { dir, entraAMain, traerMain, propio: path.join(dir, 'src/propio.js') };
}
const guardar = (dir, sid, home) => saveBrake.decidir({ command: 'git commit -m x', cwd: dir, sid, home });
const marcaDe = (archivo, ts = new Date().toISOString()) => ({ regla: 'rutas-sensibles', archivo, motivo: 'de prueba', ts });

test('T16 RamaAtrasada_LoDeOtroPedidoNoEsPropio', () => {
  const raiz = tmp('t16-');
  const home = tmp('home-');
  const { dir, entraAMain, propio } = ramaAtrasada(raiz, 'producto');
  entraAMain('src/auth/x.ts');
  // la base se anota después de que el otro pedido entró: lo suyo no se mide como de la rama
  const b = adhocBase.traerBase(dir);
  assert.deepStrictEqual(adhocBase.archivosDelCarril({ rutas: [propio], bases: { [dir]: b } }).porRepo[dir], ['src/propio.js']);
  const state = conCarril(home, 's16', { rutas: [propio], bases: { [dir]: b } });
  const d = guardar(dir, 's16', home);
  assert.ok(d && !d.texto && d.pregunta, JSON.stringify(d));
  assert.equal(leerCarril(state, 's16').riesgoAlto, undefined);
  // una base que el repo no tiene es una medición incompleta, no «nada cambió»
  const rota = adhocBase.archivosDelCarril({ rutas: [propio], bases: { [dir]: { sha: 'a'.repeat(40), traida: true } } });
  assert.ok(rota.fallas.length, JSON.stringify(rota));
});

test('T17 MarcaPegada_SeVuelveAMedirAntesDeFrenar', () => {
  const raiz = tmp('t17-');
  const home = tmp('home-');
  const { dir, entraAMain, traerMain, propio } = ramaAtrasada(raiz, 'producto');
  const marcado = path.join(dir, 'src/auth/x.ts');
  entraAMain('src/auth/x.ts');
  const b = adhocBase.traerBase(dir);
  // main avanza más allá de la base anotada y la rama lo trae: la marca vieja se levanta, y la ruta deja de contar
  const ultimo = entraAMain('src/auth/y.ts');
  traerMain();
  const state = conCarril(home, 's17', { rutas: [propio, marcado], bases: { [dir]: b }, riesgoAlto: marcaDe(marcado) });
  const d = guardar(dir, 's17', home);
  assert.ok(d && !d.texto && d.pregunta, JSON.stringify(d));
  const a = leerCarril(state, 's17');
  assert.equal(a.riesgoAlto, undefined);
  assert.equal(a.bases[dir].sha, ultimo);
  assert.deepStrictEqual(adhocBase.archivosDelCarril(a).porRepo[dir], ['src/propio.js']);
  // una edición de verdad, restaurada después: la marca era correcta, y ya no tiene de qué agarrarse
  const r = ramaAtrasada(raiz, 'restaurada');
  const x = path.join(r.dir, 'src/auth/x.ts');
  fs.writeFileSync(x, 'editado\n');
  const s2 = conCarril(home, 's17b', { rutas: [r.propio, x], files: [x], bases: { [r.dir]: adhocBase.traerBase(r.dir) }, riesgoAlto: marcaDe(x) });
  assert.ok(guardar(r.dir, 's17b', home).texto);
  assert.ok(leerCarril(s2, 's17b').riesgoAlto);
  fs.writeFileSync(x, 'a\n');
  assert.ok(!guardar(r.dir, 's17b', home).texto);
  assert.equal(leerCarril(s2, 's17b').riesgoAlto, undefined);
});

test('T18 RamaAtrasada_LoPropioSigueFrenando', () => {
  const raiz = tmp('t18-');
  const home = tmp('home-');
  const frena = (nombre, armar) => {
    const r = ramaAtrasada(raiz, nombre);
    const carril = armar(r);
    const state = conCarril(home, nombre, carril);
    const d = guardar(r.dir, nombre, home);
    assert.ok(d && d.texto, `${nombre}: ${JSON.stringify(d)}`);
    assert.match(d.texto, /faltan los revisores y el pase/, nombre);
    assert.ok(leerCarril(state, nombre).riesgoAlto, nombre);
    return d;
  };
  const conMarca = (r, rel) => ({ rutas: [path.join(r.dir, rel)], bases: { [r.dir]: adhocBase.traerBase(r.dir) }, riesgoAlto: marcaDe(path.join(r.dir, rel)) });
  // commiteado en la rama, con main traído después
  frena('commiteado', (r) => {
    const c = conMarca(r, 'src/auth/x.ts');
    escribir(r.dir, 'src/auth/x.ts', 'propio\n');
    git(r.dir, 'add', '.');
    commitear(r.dir, 'auth');
    r.entraAMain('src/otro.js');
    r.traerMain();
    return c;
  });
  // sin commitear, y sin marca todavía: lo mide y la pone
  frena('sin-commitear', (r) => {
    escribir(r.dir, 'src/auth/x.ts', 'propio\n');
    return { rutas: [r.propio], bases: { [r.dir]: adhocBase.traerBase(r.dir) } };
  });
  // un cambio escondido en el commit del merge: el árbol no es el de main
  const escondido = frena('en-el-merge', (r) => {
    const c = { rutas: [r.propio], bases: { [r.dir]: adhocBase.traerBase(r.dir) } };
    r.entraAMain('src/auth/y.ts');
    git(r.dir, 'fetch', '-q', 'origin', 'main');
    git(r.dir, '-c', 'user.email=a@b', '-c', 'user.name=a', 'merge', '-q', '--no-commit', '--no-ff', 'FETCH_HEAD');
    escribir(r.dir, 'src/auth/y.ts', 'escondido\n');
    git(r.dir, 'add', '.');
    commitear(r.dir, 'merge');
    return c;
  });
  assert.match(escondido.texto, /auth\/y\.ts/);
  // sin red no se levanta: no se pudo volver a medir
  frena('sin-red', (r) => {
    const c = conMarca(r, 'src/auth/x.ts');
    git(r.dir, 'remote', 'set-url', 'origin', path.join(raiz, 'no-existe.git'));
    return c;
  });
  // otro remoto con la rama como su main: la base no se toma de ahí
  frena('otro-remoto', (r) => {
    const c = conMarca(r, 'src/auth/x.ts');
    escribir(r.dir, 'src/auth/x.ts', 'propio\n');
    git(r.dir, 'add', '.');
    commitear(r.dir, 'auth');
    const falso = path.join(raiz, 'falso.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', falso]);
    git(r.dir, 'push', '-q', falso, 'HEAD:main');
    git(r.dir, 'remote', 'set-url', 'origin', falso);
    return c;
  });
  // en otra rama, después de la marca: pasarse de rama no la levanta
  frena('otra-rama', (r) => {
    const c = conMarca(r, 'src/auth/x.ts');
    git(r.dir, 'switch', '-qc', 'con-auth');
    escribir(r.dir, 'src/auth/x.ts', 'propio\n');
    git(r.dir, 'add', '.');
    commitear(r.dir, 'auth');
    git(r.dir, 'switch', '-q', 'rama');
    return c;
  });
  // una marca con una hora que no se lee: mira todas las ramas, sin límite de fecha
  frena('hora-ilegible', (r) => {
    const c = conMarca(r, 'src/auth/x.ts');
    c.riesgoAlto.ts = 'basura';
    git(r.dir, 'switch', '-qc', 'con-auth');
    escribir(r.dir, 'src/auth/x.ts', 'de antes\n');
    git(r.dir, 'add', '.');
    execFileSync('git', ['-C', r.dir, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'auth vieja'], { stdio: 'ignore', env: { ...process.env, GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z' } });
    git(r.dir, 'switch', '-q', 'rama');
    return c;
  });
  // escondido de git con una bandera del índice: la marca queda
  for (const bandera of ['--skip-worktree', '--assume-unchanged']) {
    frena(`bandera${bandera}`, (r) => {
      const c = conMarca(r, 'src/auth/x.ts');
      escribir(r.dir, 'src/auth/x.ts', 'propio\n');
      git(r.dir, 'update-index', bandera, 'src/auth/x.ts');
      return c;
    });
    // sin marca todavía: lo anotado con bandera sigue en la medición, y marca
    frena(`bandera-sin-marca${bandera}`, (r) => {
      const x = path.join(r.dir, 'src/auth/x.ts');
      escribir(r.dir, 'src/auth/x.ts', 'propio\n');
      git(r.dir, 'update-index', bandera, 'src/auth/x.ts');
      return { rutas: [r.propio, x], bases: { [r.dir]: adhocBase.traerBase(r.dir) } };
    });
  }
  // la marca en un enlace cambiado, con el destino igual: no se levanta por lo que dice el destino
  frena('enlace', (r) => {
    const enlace = path.join(r.dir, 'src/enlace.ts');
    fs.symlinkSync(path.join(r.dir, 'src/auth/x.ts'), enlace);
    return { rutas: [enlace], bases: { [r.dir]: adhocBase.traerBase(r.dir) }, riesgoAlto: marcaDe(enlace) };
  });
  // git que falla a mitad de la medición (el freno de riesgo: el de pantalla mide desde `origin/main` y no usa esta base):
  // lo preparado se sigue midiendo y marca; con una marca puesta, no se levanta
  const rota = { sha: 'a'.repeat(40), traida: true };
  const incompleta = (nombre, armar) => {
    const r = ramaAtrasada(raiz, nombre);
    git(r.dir, 'remote', 'set-url', 'origin', path.join(raiz, 'no-existe.git'));
    const state = conCarril(home, nombre, { rutas: [r.propio], bases: { [r.dir]: rota }, ...armar(r) });
    assert.match(guardar(r.dir, nombre, home).texto, /auth\/x\.ts/, nombre);
    const d = saveBrake.frenoDelRiesgo(leerCarril(state, nombre), nombre, home, [r.dir]);
    assert.ok(d && d.texto, `${nombre}: ${JSON.stringify(d)}`);
    assert.match(d.texto, /auth\/x\.ts/, nombre);
    assert.ok(leerCarril(state, nombre).riesgoAlto, nombre);
  };
  incompleta('base-rota-sin-marca', (r) => {
    escribir(r.dir, 'src/auth/x.ts', 'propio\n');
    git(r.dir, 'add', '.');
    return {};
  });
  incompleta('base-rota-con-marca', (r) => ({ riesgoAlto: marcaDe(path.join(r.dir, 'src/auth/x.ts')) }));
  // un archivo ignorado, que git no mide
  frena('ignorado', (r) => {
    fs.writeFileSync(path.join(r.dir, '.git', 'info', 'exclude'), 'src/auth/z.ts\n');
    escribir(r.dir, 'src/auth/z.ts', 'propio\n');
    return conMarca(r, 'src/auth/z.ts');
  });
  // fuera de todo repo
  const suelto = path.join(tmp('suelto-'), 'auth', 'x.sql');
  frena('fuera-de-un-repo', (r) => {
    fs.mkdirSync(path.dirname(suelto), { recursive: true });
    fs.writeFileSync(suelto, 'x\n');
    return { rutas: [suelto], bases: { [r.dir]: adhocBase.traerBase(r.dir) }, riesgoAlto: marcaDe(suelto) };
  });
});

test('T19 Constancias_NoVencenPorTraerMain_SiLoPropioNoCambio', () => {
  const raiz = tmp('t19-');
  const home = tmp('home-');
  const { dir, entraAMain, traerMain, propio } = ramaAtrasada(raiz, 'producto');
  const f = path.join(dir, 'src/auth/x.ts');
  escribir(dir, 'src/auth/x.ts', 'propio\n');
  git(dir, 'add', '.');
  commitear(dir, 'auth');
  const carril = { rutas: [propio, f], bases: { [dir]: adhocBase.traerBase(dir) }, riesgoAlto: marcaDe(f) };
  const huella = adhocBase.huellaDelCarril(carril);
  const state = conCarril(home, 's19', { ...carril, revisores: { huella }, pase: { huella, confirmados: 0 } });
  entraAMain('src/nuevo.js');
  traerMain();
  const d = guardar(dir, 's19', home);
  assert.ok(d && !d.texto && d.pregunta, JSON.stringify(d));
  assert.ok(leerCarril(state, 's19').riesgoAlto);
  // con lo propio cambiado, sí vencen
  fs.writeFileSync(f, 'otro cambio\n');
  assert.ok(guardar(dir, 's19', home).texto);
});

test('T20 Pantalla_LaDeOtroPedidoNoPideMaqueta', () => {
  const raiz = tmp('t20-');
  const home = tmp('home-');
  const { dir, entraAMain, traerMain, propio } = ramaAtrasada(raiz, 'producto');
  const b = adhocBase.traerBase(dir);
  entraAMain('src/components/Otra.tsx');
  traerMain();
  // la copia local de `main` se quedó atrás: la pantalla parece propia hasta traerlo otra vez
  git(dir, 'update-ref', 'refs/remotes/origin/main', b.sha);
  const state = conCarril(home, 's20', { rutas: [propio], bases: { [dir]: b } });
  const d = guardar(dir, 's20', home);
  assert.ok(d && !d.texto && d.pregunta, JSON.stringify(d));
  assert.notEqual(leerCarril(state, 's20').bases[dir].sha, b.sha);
  // la pantalla propia sí la pide
  escribir(dir, 'src/components/Propia.tsx', 'export const P = 1;\n');
  const d2 = guardar(dir, 's20', home);
  assert.ok(d2 && d2.texto, JSON.stringify(d2));
  assert.match(d2.texto, /toca una pantalla/);
  // sin red no se puede volver a medir: sigue pidiéndola, lo dice y queda en el registro
  const r = ramaAtrasada(raiz, 'sin-red');
  const b2 = adhocBase.traerBase(r.dir);
  r.entraAMain('src/components/Otra.tsx');
  r.traerMain();
  git(r.dir, 'update-ref', 'refs/remotes/origin/main', b2.sha);
  git(r.dir, 'remote', 'set-url', 'origin', path.join(raiz, 'no-existe.git'));
  const s2 = conCarril(home, 's20b', { rutas: [r.propio], bases: { [r.dir]: b2 } });
  const d3 = guardar(r.dir, 's20b', home);
  assert.ok(d3 && d3.texto, JSON.stringify(d3));
  assert.match(d3.texto, /toca una pantalla/);
  assert.match(fs.readFileSync(path.join(s2, 'gates.log'), 'utf8'), /sigue con la base anotada/);
});

// 🔴 Falla con: el freno del riesgo que sale sin mirar cuando la medición falló: con la base anotada rota, lo commiteado pasa.
test('RiesgoCommiteado_ConLaBaseAnotadaRota_SigueFrenando @story-8.181 @ac-13', () => {
  const raiz = tmp('base-rota-');
  const home = tmp('home-');
  const rota = { sha: 'a'.repeat(40), traida: true };
  const armar = (nombre) => {
    const r = ramaAtrasada(raiz, nombre);
    escribir(r.dir, 'src/auth/nuevo.ts', 'propio\n');
    git(r.dir, 'add', '.');
    commitear(r.dir, 'lo propio de riesgo');
    return r;
  };
  // con red: trae `main`, mide de nuevo y pone la marca
  const conRed = armar('con-red');
  const s1 = conCarril(home, 'con-red', { rutas: [conRed.propio], bases: { [conRed.dir]: rota } });
  const d1 = guardar(conRed.dir, 'con-red', home);
  assert.match(d1.texto, /auth\/nuevo\.ts/, d1.texto);
  assert.ok(leerCarril(s1, 'con-red').riesgoAlto);
  assert.notEqual(leerCarril(s1, 'con-red').bases[conRed.dir].sha, rota.sha);
  // sin red: no pudo medir, y sin medir no guarda
  const sinRed = armar('sin-red');
  git(sinRed.dir, 'remote', 'set-url', 'origin', path.join(raiz, 'no-existe.git'));
  conCarril(home, 'sin-red', { rutas: [sinRed.propio], bases: { [sinRed.dir]: rota } });
  assert.match(guardar(sinRed.dir, 'sin-red', home).texto, /no pude medir si este camino corto toca una ruta de riesgo alto/);
});

// 🔴 Falla con: la marca de un worktree anidado borrado, que se levanta sola con su rama viva: lo de riesgo se empuja sin revisores.
test('Marca_DeUnWorktreeBorrado_NoSeLevanta @story-8.181 @ac-13', () => {
  const raiz = tmp('wt-borrado-');
  const home = tmp('home-');
  const { dir, propio } = ramaAtrasada(raiz, 'producto');
  const wt = path.join(dir, '.claude', 'worktrees', 'x');
  git(dir, 'worktree', 'add', '-q', '-b', 'story/x', wt);
  escribir(wt, 'src/auth/y.ts', 'de riesgo\n');
  git(wt, 'add', '.');
  commitear(wt, 'lo de riesgo');
  const b = adhocBase.traerBase(dir);
  const f = path.join(wt, 'src/auth/y.ts');
  const state = conCarril(home, 'sw', { rutas: [propio, f], bases: { [dir]: b, [wt]: b }, riesgoAlto: marcaDe(f) });
  git(dir, 'worktree', 'remove', '--force', wt);
  const d = saveBrake.decidir({ command: 'git push origin story/x', cwd: dir, sid: 'sw', home });
  assert.ok(d && d.texto, JSON.stringify(d));
  assert.match(d.texto, /faltan los revisores y el pase/);
  assert.ok(leerCarril(state, 'sw').riesgoAlto, 'la marca queda');
});

test('T21 RepoAjeno_NoEntraAlCarrilAlGuardar', () => {
  const raiz = tmp('t21-');
  const home = tmp('home-');
  const { dir, propio } = ramaAtrasada(raiz, 'producto');
  const ajeno = ramaAtrasada(raiz, 'ajeno');
  const f = path.join(dir, 'src/auth/x.ts');
  escribir(dir, 'src/auth/x.ts', 'propio\n');
  const state = conCarril(home, 's21', { rutas: [propio, f], bases: { [dir]: adhocBase.traerBase(dir) }, riesgoAlto: marcaDe(f) });
  assert.ok(guardar(ajeno.dir, 's21', home).texto);
  assert.deepStrictEqual(Object.keys(leerCarril(state, 's21').bases), [dir]);
});

// Un subagente que escribe: el gancho corre como en el uso real y no se puede caer (si se cayera, «no anotó» pasaría por bueno).
function comoSubagente(home, sid, file, env = {}) {
  const r = spawnSync(process.execPath, [ON_EDIT], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Write', session_id: sid, agent_id: 'agente-del-pase', agent_type: 'general-purpose', tool_input: { file_path: file } }),
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, ...env }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, `el gancho se cayó: ${r.stderr}`);
  return r;
}

// 🔴 Falla con: la sonda de un agente del pase (en su laboratorio o en step-05b-probes) entra al carril y vence las constancias.
test('T22 SondaDeSubagente_NoEntraAlCarril_ElCodigoDeUnSubagenteSi', () => {
  const raiz = tmp('t22-');
  const home = tmp('home-');
  const dir = repoConOrigen(raiz, 'producto');
  escribir(dir, '.gitignore', '**/.advisors/*\n');
  git(dir, 'add', '.');
  commitear(dir, 'ignora la evidencia');
  const propio = path.join(dir, 'src/lib/x.js');
  escribir(dir, 'src/lib/x.js', 'module.exports = 1;\n');
  const state = conCarril(home, 's22', { rutas: [propio], bases: { [dir]: adhocBase.traerBase(dir) } });
  const huella = adhocBase.huellaDelCarril(leerCarril(state, 's22'));
  // (a) la sonda en su laboratorio, con su propio repo, fuera de los repos del carril
  const lab = path.join(tmp('probe.'), 'lab');
  execFileSync('git', ['init', '-q', lab]);
  escribir(lab, 'probe.js', 'console.log(1);\n');
  comoSubagente(home, 's22', path.join(lab, 'probe.js'));
  // (a') la sonda en una carpeta suelta, que no es de ningún repo
  const suelta = tmp('probe.');
  escribir(suelta, 'probe.js', 'console.log(3);\n');
  assert.ok(adhocBase.ubicar(path.join(suelta, 'probe.js')).fuera, 'la carpeta suelta está fuera de todo repo');
  comoSubagente(home, 's22', path.join(suelta, 'probe.js'));
  // (b) la sonda guardada como prueba del hallazgo, dentro del repo del carril
  const guardada = path.join(dir, '.advisors/pipeline-runs/x-1/step-05b-probes/lente-1/probe.js');
  escribir(dir, '.advisors/pipeline-runs/x-1/step-05b-probes/lente-1/probe.js', 'console.log(2);\n');
  comoSubagente(home, 's22', guardada);
  const despues = leerCarril(state, 's22');
  assert.deepStrictEqual(despues.rutas, [propio], 'ninguna sonda se anotó');
  assert.deepStrictEqual(Object.keys(despues.bases), [dir], 'ningún repo nuevo');
  assert.equal(adhocBase.huellaDelCarril(despues), huella, 'la huella de las constancias no cambia');
  // el código que escribe un subagente dentro del repo del carril se sigue anotando y cambia la huella
  const delSubagente = path.join(dir, 'src/lib/y.js');
  escribir(dir, 'src/lib/y.js', 'module.exports = 2;\n');
  comoSubagente(home, 's22', delSubagente);
  const conCodigo = leerCarril(state, 's22');
  assert.ok(conCodigo.rutas.includes(delSubagente), 'el código del subagente se anota');
  assert.notEqual(adhocBase.huellaDelCarril(conCodigo), huella);
  // la sesión misma sigue anotando lo que escribe fuera del repo, como siempre
  onEdit(home, 's22', path.join(lab, 'probe.js'));
  assert.ok(leerCarril(state, 's22').rutas.includes(path.join(lab, 'probe.js')));
});

// 🔴 Falla con: git no contesta al ubicar el archivo y el código que un subagente escribe en el repo del carril se toma por sonda.
test('T23 SubagenteConGitQueNoContesta_SeAnotaIgual', { skip: process.platform === 'win32' && 'el git falso es un guion de sh' }, () => {
  const raiz = tmp('t23-');
  const home = tmp('home-');
  const dir = repoConOrigen(raiz, 'producto');
  const state = conCarril(home, 's23', { rutas: [], bases: { [dir]: adhocBase.traerBase(dir) } });
  const bin = tmp('bin-');
  const disparo = path.join(bin, 'disparo');
  const gitReal = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const src = path.join(dir, 'src');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase "$*" in *"${src}"*"rev-parse --show-toplevel"*) : > "${disparo}"; echo "fatal: unable to read index" >&2; exit 128;; esac\nexec "${gitReal}" "$@"\n`, { mode: 0o755 });
  const archivo = path.join(dir, 'src/a.js');
  escribir(dir, 'src/a.js', 'module.exports = 1;\n');
  comoSubagente(home, 's23', archivo, { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  assert.ok(fs.existsSync(disparo), 'el git falso contestó con error: la prueba mide esa rama');
  assert.deepStrictEqual(adhocBase.ubicar(archivo).raiz, dir, 'con git sano el archivo está en el repo del carril');
  assert.ok(leerCarril(state, 's23').rutas.includes(archivo), 'ante la duda, se anota');
});

// 🔴 Falla con: un nombre que sólo parece de la carpeta de sondas (con `..`, o con `.advisors` dentro de src/) deja código sin anotar.
test('T24 RutaQueSoloPareceDeSondas_SeAnota', () => {
  const raiz = tmp('t24-');
  const home = tmp('home-');
  const dir = repoConOrigen(raiz, 'producto');
  const state = conCarril(home, 's24', { rutas: [], bases: { [dir]: adhocBase.traerBase(dir) } });
  escribir(dir, 'src/evil.js', 'module.exports = 1;\n');
  fs.mkdirSync(path.join(dir, '.advisors/pipeline-runs/x/step-05b-probes'), { recursive: true });
  comoSubagente(home, 's24', path.join(dir, '.advisors/pipeline-runs/x/step-05b-probes/../../../../src/evil.js'));
  assert.ok(leerCarril(state, 's24').rutas.some((r) => path.resolve(r) === path.join(dir, 'src/evil.js')), 'el `..` no esconde el código');
  const adentro = path.join(dir, 'src/.advisors/pipeline-runs/x/step-05b-probes/a.js');
  escribir(dir, 'src/.advisors/pipeline-runs/x/step-05b-probes/a.js', 'module.exports = 2;\n');
  comoSubagente(home, 's24', adentro);
  assert.ok(leerCarril(state, 's24').rutas.includes(adentro), 'la carpeta de sondas cuelga de la raíz del repo');
});

// 🔴 Falla con: un carril que todavía no mide ningún repo deja sin anotar lo que escribe un subagente.
test('T25 CarrilSinRepos_LoDelSubagenteSeAnota', () => {
  const home = tmp('home-');
  const state = conCarril(home, 's25', { rutas: [], bases: {} });
  const suelta = tmp('t25-');
  escribir(suelta, 'a.js', 'module.exports = 1;\n');
  comoSubagente(home, 's25', path.join(suelta, 'a.js'));
  assert.ok(leerCarril(state, 's25').rutas.includes(path.join(suelta, 'a.js')), 'sin repos que comparar, se anota');
});

// 🔴 Falla con: git no ubica una ruta ya anotada, su repo falta en la lista y el código de un subagente en ese repo se toma por sonda.
test('T26 RutaDelCarrilSinUbicar_LoDelSubagenteSeAnota', { skip: process.platform === 'win32' && 'el git falso es un guion de sh' }, () => {
  const raiz = tmp('t26-');
  const home = tmp('home-');
  const a = repoConOrigen(raiz, 'producto');
  const b = repoConOrigen(raiz, 'otro');
  const anotada = path.join(b, 'lib/vieja.js');
  escribir(b, 'lib/vieja.js', 'module.exports = 0;\n');
  const state = conCarril(home, 's26', { rutas: [anotada], bases: { [a]: adhocBase.traerBase(a) } });
  const bin = tmp('bin-');
  const disparo = path.join(bin, 'disparo');
  const gitReal = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const lib = path.join(b, 'lib');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase "$*" in *"${lib}"*"rev-parse --show-toplevel"*) : > "${disparo}"; echo "fatal: unable to read index" >&2; exit 128;; esac\nexec "${gitReal}" "$@"\n`, { mode: 0o755 });
  const archivo = path.join(b, 'src/nuevo.js');
  escribir(b, 'src/nuevo.js', 'module.exports = 1;\n');
  comoSubagente(home, 's26', archivo, { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  assert.ok(fs.existsSync(disparo), 'git no ubicó la ruta anotada: la prueba mide esa rama');
  assert.ok(leerCarril(state, 's26').rutas.includes(archivo), 'con la lista de repos incompleta, se anota');
});

// 🔴 Falla con: la sonda que un agente del pase escribe por consola (un heredoc) entra al carril y vence las constancias.
test('T27 SondaDeSubagentePorConsola_NoEntraAlCarril_ElCodigoSi', () => {
  const raiz = tmp('t27-');
  const home = tmp('home-');
  const dir = repoConOrigen(raiz, 'producto');
  escribir(dir, '.gitignore', '**/.advisors/*\n');
  git(dir, 'add', '.');
  commitear(dir, 'ignora la evidencia');
  const propio = path.join(dir, 'src/lib/x.js');
  escribir(dir, 'src/lib/x.js', 'module.exports = 1;\n');
  const state = conCarril(home, 's27', { rutas: [propio], bases: { [dir]: adhocBase.traerBase(dir) } });
  const antes = leerCarril(state, 's27');
  const porConsola = (destino, extra = {}) => bash.handle({
    hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 's27', cwd: dir,
    tool_input: { command: `cat > ${destino} <<'EOF'\nconsole.log(1);\nEOF` }, ...extra,
  }, { stateDir: state, installedRoots: [] });
  const subagente = { agent_id: 'agente-del-pase', agent_type: 'general-purpose' };
  // (a) en su laboratorio, fuera de todo repo; (b) guardada como prueba del hallazgo
  const lab = tmp('probe.');
  porConsola(path.join(lab, 'probe.js'), subagente);
  fs.mkdirSync(path.join(dir, '.advisors/pipeline-runs/x-1/step-05b-probes/lente-1'), { recursive: true });
  porConsola(path.join(dir, '.advisors/pipeline-runs/x-1/step-05b-probes/lente-1/probe.js'), subagente);
  // (c) el criterio, con la carpeta de la sonda todavía sin crear (`mkdir -p` en el mismo comando) y la ruta por un
  // enlace al repo: es la misma sonda que por la ruta real
  const enlace = path.join(tmp('enlace.'), 'repo');
  fs.symlinkSync(dir, enlace);
  const { esSondaDeSubagente } = require(ON_EDIT);
  const sinCrear = '.advisors/pipeline-runs/x-2/step-05b-probes/lente-1/probe.js';
  assert.equal(esSondaDeSubagente(subagente, path.join(dir, sinCrear), 's27', state), true);
  assert.equal(esSondaDeSubagente(subagente, path.join(enlace, sinCrear), 's27', state), true, 'por el enlace, igual');
  const despues = leerCarril(state, 's27');
  assert.deepStrictEqual(despues.files || [], antes.files || [], 'ninguna sonda se anotó');
  assert.equal(adhocBase.huellaDelCarril(despues), adhocBase.huellaDelCarril(antes), 'la huella de las constancias no cambia');
  // lo que el freno no ve hasta el final se anota aunque parezca una sonda: un `..` después de un enlace, un enlace
  // creado en el mismo comando, un destino con una variable sin resolver
  const atajo = path.join(lab, 'atajo');
  fs.symlinkSync(path.join(dir, 'src/lib'), atajo);
  const conAtajo = (command) => bash.handle({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 's27', cwd: dir, tool_input: { command }, ...subagente }, { stateDir: state, installedRoots: [] });
  const cuantos = () => (leerCarril(state, 's27').files || []).length;
  let n = cuantos();
  conAtajo(`cat > ${atajo}/../colado.js <<'EOF'\nx\nEOF`);
  assert.equal(cuantos(), n + 1, 'un `..` no exime');
  n = cuantos();
  conAtajo(`ln -s ${path.join(dir, 'src')} ${lab}/nuevo && cat > ${lab}/nuevo/otro.js <<'EOF'\nx\nEOF`);
  assert.equal(cuantos(), n + 1, 'un enlace creado en el mismo comando no exime');
  assert.equal(require(ON_EDIT).esSondaDeSubagente(subagente, `${atajo}/../colado.js`, 's27', state), false, 'el criterio tampoco exime un `..`');
  // el código que un subagente escribe por consola dentro del repo del carril se sigue anotando
  porConsola(path.join(dir, 'src/lib/y.js'), subagente);
  assert.ok((leerCarril(state, 's27').files || []).includes(path.join(dir, 'src/lib/y.js')), 'el código del subagente se anota');
  // y la sesión misma sigue anotando lo que escribe fuera del repo, como siempre
  porConsola(path.join(lab, 'otra.js'));
  assert.ok((leerCarril(state, 's27').files || []).includes(path.join(lab, 'otra.js')));
});
