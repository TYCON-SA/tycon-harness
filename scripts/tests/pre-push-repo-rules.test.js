'use strict';
// stable-data: el reloj sólo mide cuánto tarda el empuje (el tope de 60 s); los commits fijan sus fechas y apagan el mantenimiento.
/**
 * pre-push-repo-rules.test.js — las cuatro reglas que vigilan todo el repo del arnés corren antes de empujar.
 *
 * POR QUÉ. En la CI pública, cerca del 40 % de las suites rojas eran cuatro reglas que miran el repo entero y tardan
 * segundos; la sesión no las corre porque no nombran ningún archivo tocado. El empuje las corre sobre el commit que viaja.
 *
 * CÓMO. Cada caso arma en una carpeta temporal un repo de juguete con la marca del arnés y suites falsas con los cuatro
 * nombres, que salen verdes o rojas según su contenido. Corre `scripts/hooks/pre-push-repo-rules.js` como proceso, con la
 * entrada que da git; T1, T2 y T5 empujan de verdad a un remoto de carpeta, con el gancho global de git. T7 corre el
 * gancho sin Node.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const GUION = path.join(RAIZ, 'scripts', 'hooks', 'pre-push-repo-rules.js');
const GANCHO = path.join(RAIZ, 'scripts', 'hooks', 'git-pre-push-global.sh');
const SUITES = [
  'scripts/tests/node-floor.test.js',
  'scripts/tests/suites-listed.test.js',
  'scripts/tests/suites-coverage.test.js',
  'skills/tycon-pipeline/scripts/tests/test-skill-contract.js',
];
const VERDE = 'console.log("todo en orden");\n';
const ROJA = 'console.log("una línea antes");\nconsole.log("falta registrar scripts/tests/nueva.test.js");\nprocess.exit(1);\n';
const CUELGA = 'setInterval(() => {}, 1000);\n';
const CEROS = '0'.repeat(40);

// git sin la configuración de la máquina: ni ganchos ni identidad ajenos
const envGit = (extra = {}) => {
  const env = {
    ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z', ...extra,
  };
  delete env.NODE_TEST_CONTEXT;
  return env;
};
const QUIEN = ['-c', 'user.name=Mantenedor De Prueba', '-c', 'user.email=4242+mantenedor@users.noreply.github.com', '-c', 'commit.gpgsign=false', '-c', 'maintenance.auto=false'];
function git(cwd, args, extra) {
  const r = spawnSync('git', [...QUIEN, ...args], { cwd, env: envGit(extra), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Un repo del arnés de juguete con un remoto de carpeta. `suites`: ruta → contenido (las que no están, no viajan). */
function laboratorio(t, { suites = Object.fromEntries(SUITES.map((s) => [s, VERDE])), marca = true } = {}) {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'reglas-repo-test-'));
  t.after(() => fs.rmSync(T, { recursive: true, force: true }));
  const repo = path.join(T, 'repo');
  const remoto = path.join(T, 'remoto.git');
  const tmp = path.join(T, 'tmp');
  fs.mkdirSync(repo); fs.mkdirSync(tmp); fs.mkdirSync(path.join(T, 'casa'));
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remoto], { env: envGit() });
  git(repo, ['init', '-q', '-b', 'main']);
  if (marca) escribir(repo, 'scripts/install-tycon-hooks.sh', '#!/bin/sh\n');
  escribir(repo, 'README.md', 'un repo de juguete\n');
  for (const [ruta, contenido] of Object.entries(suites)) escribir(repo, ruta, contenido);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base']);
  git(repo, ['remote', 'add', 'origin', remoto]);
  return { T, repo, remoto, tmp, casa: path.join(T, 'casa'), head: () => git(repo, ['rev-parse', 'HEAD']) };
}
function escribir(repo, ruta, contenido) {
  fs.mkdirSync(path.dirname(path.join(repo, ruta)), { recursive: true });
  fs.writeFileSync(path.join(repo, ruta), contenido);
}

/** Corre el guion como lo llama el gancho: parado en el repo, con la entrada de git. */
function correr(lab, { sha = lab.head(), env = {}, input } = {}) {
  const entrada = input !== undefined ? input : `refs/heads/main ${sha} refs/heads/main ${CEROS}\n`;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [GUION, 'origin', lab.remoto], {
    cwd: lab.repo, input: entrada, encoding: 'utf8',
    env: envGit({ HOME: lab.casa, TMPDIR: lab.tmp, TMP: lab.tmp, TEMP: lab.tmp, ...env }),
  });
  return { code: r.status, err: `${r.stderr || ''}${r.stdout || ''}`, ms: Date.now() - t0 };
}

/** Un empuje de verdad, con el gancho global de git y el arnés de este árbol como arnés instalado. */
function empujar(lab, env = {}) {
  const hooks = path.join(lab.T, 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.copyFileSync(GANCHO, path.join(hooks, 'pre-push'));
  fs.chmodSync(path.join(hooks, 'pre-push'), 0o755);
  const t0 = Date.now();
  const r = spawnSync('git', ['-c', `core.hooksPath=${hooks}`, 'push', '-q', 'origin', 'main'], {
    cwd: lab.repo, encoding: 'utf8',
    env: envGit({ HOME: lab.casa, TYCON_GUIDES_DIR: RAIZ, TMPDIR: lab.tmp, ...env }),
  });
  return { code: r.status, err: r.stderr || '', ms: Date.now() - t0 };
}

test('T1 PrePushRules_AllGreen_PushGoes — las cuatro verdes: el empuje sale, en menos de 60 s', (t) => {
  const lab = laboratorio(t);
  const r = empujar(lab);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(r.ms < 60000, `tardó ${r.ms} ms`);
  assert.strictEqual(git(lab.remoto, ['rev-parse', 'main']), lab.head(), 'el commit no llegó al remoto');
  assert.match(r.err, /4 de 4 en verde/);
});

test('T2 PrePushRules_OneRed_StopsAndNamesIt — una roja: frena con la suite, sus líneas y el comando', (t) => {
  const lab = laboratorio(t, { suites: { ...Object.fromEntries(SUITES.map((s) => [s, VERDE])), 'scripts/tests/suites-listed.test.js': ROJA } });
  const r = empujar(lab);
  assert.notStrictEqual(r.code, 0, 'el empuje salió con una regla en rojo');
  assert.match(r.err, /scripts\/tests\/suites-listed\.test\.js/);
  assert.match(r.err, /falta registrar scripts\/tests\/nueva\.test\.js/, 'no trae las últimas líneas de la suite');
  assert.match(r.err, /node scripts\/tests\/suites-listed\.test\.js/, 'no trae el comando para correrla sola');
  assert.throws(() => git(lab.remoto, ['rev-parse', '--verify', 'main']), 'el commit llegó al remoto igual');
});

test('T3 PrePushRules_DirtyTreeFixes_StillStops — el arreglo sin commitear no cuenta: mide el commit que viaja', (t) => {
  const lab = laboratorio(t, { suites: { ...Object.fromEntries(SUITES.map((s) => [s, VERDE])), 'scripts/tests/node-floor.test.js': ROJA } });
  escribir(lab.repo, 'scripts/tests/node-floor.test.js', VERDE);   // el árbol lo arregla, el commit no
  const r = correr(lab);
  assert.notStrictEqual(r.code, 0, 'midió el árbol y no el commit');
  assert.match(r.err, /scripts\/tests\/node-floor\.test\.js/);
});

test('T4 PrePushRules_DirtyTree_TempCopyRemoved — la copia temporal no queda', (t) => {
  const lab = laboratorio(t);
  escribir(lab.repo, 'README.md', 'un cambio sin commitear\n');
  const r = correr(lab);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.err, /copia temporal/, 'con el árbol sucio no dijo que corrió en una copia');
  assert.deepStrictEqual(fs.readdirSync(lab.tmp), [], 'quedó la carpeta de la copia temporal');
  assert.strictEqual(git(lab.repo, ['worktree', 'list']).split('\n').length, 1, 'quedó registrada la copia en git');
});

test('T5 PrePushRules_NotHarness_RunsNothing — un repo que no es del arnés no corre nada', (t) => {
  const lab = laboratorio(t, { marca: false, suites: { 'scripts/tests/suites-listed.test.js': ROJA } });
  const r = empujar(lab);
  assert.strictEqual(r.code, 0, r.err);
  assert.doesNotMatch(r.err, /suites-listed/, 'corrió una regla en un repo que no es del arnés');
});

test('T6 PrePushRules_SuiteMissing_SkippedAndSaid — corre la que viaja y saltea las otras tres, diciéndolo', (t) => {
  const lab = laboratorio(t, { suites: { 'scripts/tests/suites-coverage.test.js': VERDE } });
  const r = correr(lab);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.err, /1 de 1 en verde/);
  for (const s of SUITES.filter((x) => !x.includes('suites-coverage'))) {
    assert.match(r.err, new RegExp(`${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*no viaja`), `no dijo que salteó ${s}`);
  }
});

test('T7 PrePushRules_NoNode_Stops — sin Node, el empuje del arnés frena con el motivo', (t) => {
  const lab = laboratorio(t);
  // un arnés instalado cuyo Node no existe: el gancho no puede correr ni el freno ni las reglas
  const arnes = path.join(lab.T, 'arnes');
  escribir(arnes, 'scripts/hooks/public-push-guard.js', '');
  escribir(arnes, 'scripts/lib/harness-node.sh', 'harness_node_bin() { echo /no/existe/node; }\n');
  const r = empujar(lab, { TYCON_GUIDES_DIR: arnes });
  assert.notStrictEqual(r.code, 0, 'sin Node el empuje del arnés salió sin correr las reglas');
  assert.match(r.err, /falta node/);
  assert.match(r.err, /reglas/);
});

test('T8 PrePushRules_TempCopyFails_Stops — si la copia temporal no se arma, frena con el motivo', (t) => {
  const lab = laboratorio(t);
  escribir(lab.repo, 'README.md', 'un cambio sin commitear\n');   // obliga a la copia
  const r = correr(lab, { env: { TMPDIR: path.join(lab.T, 'no-existe'), TMP: path.join(lab.T, 'no-existe'), TEMP: path.join(lab.T, 'no-existe') } });
  assert.notStrictEqual(r.code, 0, 'sin copia temporal no se midió nada y salió igual');
  assert.match(r.err, /copia temporal/);
});

test('T10 PrePushRules_NoSuiteTravels_StaysQuiet — ninguna de las cuatro viaja: sale 0 sin una línea', (t) => {
  const lab = laboratorio(t, { suites: {} });
  const r = correr(lab);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.err, '', 'sin reglas que correr habló igual');
});

test('T11 PrePushRules_HookGitEnv_NotInherited — las suites de la copia no heredan el GIT_DIR que git le pone al gancho', (t) => {
  // la suite falsa sale roja si su git apunta al repo que se empuja y no a la copia
  const MIRA = 'const fs=require("fs");const {execSync}=require("child_process");' +
    'const d=fs.realpathSync(execSync("git rev-parse --absolute-git-dir").toString().trim());' +
    'if(d===fs.realpathSync(process.env.REPO_GIT)){console.log("git ajeno: "+d);process.exit(1)}\n';
  const lab = laboratorio(t, { suites: { ...Object.fromEntries(SUITES.map((s) => [s, VERDE])), 'scripts/tests/suites-listed.test.js': MIRA } });
  escribir(lab.repo, 'README.md', 'un cambio sin commitear\n');   // obliga a la copia
  const gitDir = path.join(lab.repo, '.git');
  const r = correr(lab, { env: { GIT_DIR: gitDir, REPO_GIT: gitDir } });
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.err, /copia temporal/);
});

test('T12 PrePushRules_RulesMissing_ForeignPushGoes — sin el guion de reglas en el arnés, un empuje ajeno al arnés sale', (t) => {
  const lab = laboratorio(t, { marca: false });
  // un arnés a medio actualizar: el freno (que deja salir) sin las reglas al lado
  const arnes = path.join(lab.T, 'arnes');
  escribir(arnes, 'scripts/hooks/public-push-guard.js', '');
  const r = empujar(lab, { TYCON_GUIDES_DIR: arnes });
  assert.strictEqual(r.code, 0, r.err);
  const lab2 = laboratorio(t);
  escribir(path.join(lab2.T, 'arnes'), 'scripts/hooks/public-push-guard.js', '');
  const r2 = empujar(lab2, { TYCON_GUIDES_DIR: path.join(lab2.T, 'arnes') });
  assert.notStrictEqual(r2.code, 0, 'un empuje del arnés salió sin las reglas');
  assert.match(r2.err, /no encontré las reglas del repo/);
});

test('T13 PrePushRules_HarnessEnv_NotInherited — las suites no heredan las variables del arnés (TYCON_SKILLS_DIR)', (t) => {
  const MIRA = 'if(Object.keys(process.env).some((k)=>/^TYCON_/.test(k))){console.log("heredó "+Object.keys(process.env).filter((k)=>/^TYCON_/.test(k)));process.exit(1)}\n';
  const lab = laboratorio(t, { suites: { ...Object.fromEntries(SUITES.map((s) => [s, VERDE])), 'scripts/tests/suites-coverage.test.js': MIRA } });
  const r = correr(lab, { env: { TYCON_SKILLS_DIR: path.join(lab.T, 'otra-carpeta') } });
  assert.strictEqual(r.code, 0, r.err);
});

test('T14 PrePushRules_AssumeUnchanged_MeasuresCommit — un archivo marcado assume-unchanged no esconde el rojo del commit', (t) => {
  const lab = laboratorio(t, { suites: { ...Object.fromEntries(SUITES.map((s) => [s, VERDE])), 'scripts/tests/node-floor.test.js': ROJA } });
  escribir(lab.repo, 'scripts/tests/node-floor.test.js', VERDE);
  git(lab.repo, ['update-index', '--assume-unchanged', 'scripts/tests/node-floor.test.js']);
  assert.strictEqual(git(lab.repo, ['status', '--porcelain']), '', 'el laboratorio no esconde el cambio');
  const r = correr(lab);
  assert.notStrictEqual(r.code, 0, 'midió el disco y no el commit');
  assert.match(r.err, /scripts\/tests\/node-floor\.test\.js/);
});

test('T15 PrePushRules_SameTree_MeasuredOnce — una marca y su rama sobre el mismo commit se miden una vez', (t) => {
  const lab = laboratorio(t);
  git(lab.repo, ['tag', '-a', '-m', 'una marca', 'v1']);
  const marca = git(lab.repo, ['rev-parse', 'v1']);
  const entrada = `refs/heads/main ${lab.head()} refs/heads/main ${CEROS}\nrefs/tags/v1 ${marca} refs/tags/v1 ${CEROS}\n`;
  const r = correr(lab, { input: entrada });
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual((r.err.match(/4 de 4 en verde/g) || []).length, 1, r.err);
});

test('T16 PrePushRules_InputUnreadable_HarnessStops — sin poder leer qué se empuja, un árbol del arnés frena', (t) => {
  const lab = laboratorio(t);
  const r = spawnSync(process.execPath, [GUION, 'origin', lab.remoto, '--input-unreadable'], {
    cwd: lab.repo, input: '', encoding: 'utf8', env: envGit({ HOME: lab.casa, TMPDIR: lab.tmp }),
  });
  assert.notStrictEqual(r.status, 0, 'salió sin saber qué se empujaba');
  assert.match(r.stderr, /no pude leer qué se empuja/);
});

test('T9 PrePushRules_OverCap_Stops — pasado el tope, frena y nombra la suite que quedó corriendo', (t) => {
  const lab = laboratorio(t, { suites: { ...Object.fromEntries(SUITES.map((s) => [s, VERDE])), 'scripts/tests/suites-coverage.test.js': CUELGA } });
  const r = correr(lab, { env: { TYCON_PRE_PUSH_RULES_CAP_MS: '1500' } });
  assert.notStrictEqual(r.code, 0, 'una suite colgada no frenó el empuje');
  assert.match(r.err, /tope/);
  assert.match(r.err, /scripts\/tests\/suites-coverage\.test\.js/);
  assert.ok(r.ms < 20000, `el tope no cortó: tardó ${r.ms} ms`);
});
