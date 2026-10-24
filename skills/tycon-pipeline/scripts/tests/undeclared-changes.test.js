#!/usr/bin/env node
'use strict';
/**
 * undeclared-changes.test.js — el control al cerrar: lo que cambió de verdad contra lo declarado (T34, T35).
 *
 * QUÉ CUIDA: que `complete-step prepare-commit` no deje pasar un archivo que cambió por fuera del registro de Edit/Write
 * y que la historia no nombra (un package.json reescrito con `node -e` llega al commit sin que nadie lo declare). Lo
 * borrado por la terminal que el freno deja pasar (node_modules) sale como aviso; lo que no se puede medir (sin git, sin
 * commit de arranque) se dice, no se da por verde.
 *
 * Corre el CLI real de marker.js contra un HOME temporal y un repo de juguete con commits de fecha fija.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/undeclared-changes.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const MARKER = path.join(SCRIPTS, 'marker.js');
const SIN_CIERRE = ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers',
  'adversarial-pass', 'findings', 'live-check'];

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'prueba', GIT_AUTHOR_EMAIL: 'prueba@noreply', GIT_COMMITTER_NAME: 'prueba',
  GIT_COMMITTER_EMAIL: 'prueba@noreply', GIT_AUTHOR_DATE: '2026-10-22T10:00:00Z', GIT_COMMITTER_DATE: '2026-10-22T10:00:00Z',
};
const git = (repo, ...args) => execFileSync('git', ['-C', repo, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();

function historia(repo, { modificar = [], fileList = [] } = {}) {
  const storyPath = path.join(repo, 'specs', 'story-9.9.md');
  fs.mkdirSync(path.dirname(storyPath), { recursive: true });
  const fm = ['---', 'story: "9.9"', 'epic: "9"', 'status: in-progress', 'files_to_modify:', ...modificar.map((f) => `  - ${f}`), '---'];
  const cuerpo = ['', '# Story 9.9', '', '## Dev Agent Record', '', '### File List', '', ...fileList.map((f) => `- ${f}`), ''];
  fs.writeFileSync(storyPath, [...fm, ...cuerpo].join('\n'));
  return storyPath;
}

// un repo con su commit de arranque; la historia vive en el mismo repo, ya commiteada
function corral({ conGit = true, modificar = [], fileList = [] } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'undecl-')));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"x"}\n');
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  const storyPath = historia(repo, { modificar, fileList });
  let baseSha = null;
  if (conGit) {
    git(repo, 'init', '-q');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'arranque');
    baseSha = git(repo, 'rev-parse', 'HEAD');
  }
  return { home, repo, storyPath, baseSha };
}

function marcador(home, sid, extra) {
  const dir = path.join(home, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({
    storyId: '9.9', sessionId: sid, stepScheme: 2, startedAt: '2026-10-22T10:00:00.000Z', lastTouch: '2026-10-22T10:00:00.000Z',
    stepsCompleted: SIN_CIERRE, stepsPending: ['prepare-commit'], filesTouched: [], fileEvents: [], iterations: {},
    ...extra,
  }));
}

function consola(home, sid, lineas) {
  const dir = path.join(home, '.claude', '.tycon-pipeline', 'console-writes');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), lineas.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function cerrar(home, sid, env = {}) {
  return spawnSync(process.execPath, [MARKER, 'complete-step', 'prepare-commit'], {
    encoding: 'utf8', env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_NO_RUN_CHANGE: undefined, ...env },
  });
}

function lineasDelControl(home) {
  const f = path.join(home, '.claude', '.tycon-pipeline', 'gates.log');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((g) => g.name === 'undeclared-changes');
}

test('T34 Cierre_CambiosNoDeclarados_Rojo', () => {
  const c = corral({ modificar: ['src/a.ts'] });
  // el package.json cambió por la terminal: no pasó por Edit/Write y la historia no lo nombra
  fs.writeFileSync(path.join(c.repo, 'package.json'), '{"name":"x","version":"2"}\n');
  // lo editado con Edit (está en el registro) y lo nuevo sin rastrear no declarado
  fs.writeFileSync(path.join(c.repo, 'src', 'a.ts'), 'export const a = 2;\n');
  fs.writeFileSync(path.join(c.repo, 'src', 'b.ts'), 'export const b = 1;\n');
  marcador(c.home, 'und-rojo', { storyPath: c.storyPath, repoPath: c.repo, baseSha: c.baseSha, filesTouched: [path.join(c.repo, 'src', 'a.ts')] });
  const r = cerrar(c.home, 'und-rojo');
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /BLOQUEADO — cambios sin declarar/);
  assert.match(r.stderr, /package\.json/);
  assert.match(r.stderr, /src\/b\.ts/);
  assert.doesNotMatch(r.stderr, /· src\/a\.ts/, 'lo que pasó por Edit/Write está declarado');
  assert.doesNotMatch(r.stderr, /specs\/story-9\.9\.md/, 'la historia misma no sobra');
  assert.match(r.stderr, /File List/, 'dice el remedio');
  assert.match(r.stderr, /revert/i, 'y la otra salida');
  const l = lineasDelControl(c.home);
  assert.equal(l.length, 1);
  assert.equal(l[0].action, 'bloqueo');
  assert.deepEqual(l[0].files.sort(), ['package.json', 'src/b.ts']);
  fs.rmSync(c.home, { recursive: true, force: true });
});

test('T35 Cierre_TodoDeclarado_Verde', () => {
  // package.json declarado en files_to_modify; su lock (cambiado por npm install) cuenta como declarado; src/b.ts en el File List
  const c = corral({ modificar: ['package.json'], fileList: ['src/b.ts'] });
  fs.writeFileSync(path.join(c.repo, 'package.json'), '{"name":"x","version":"2"}\n');
  fs.writeFileSync(path.join(c.repo, 'package-lock.json'), '{"lockfileVersion":3}\n');
  fs.writeFileSync(path.join(c.repo, 'src', 'b.ts'), 'export const b = 1;\n');
  marcador(c.home, 'und-verde', { storyPath: c.storyPath, repoPath: c.repo, baseSha: c.baseSha });
  consola(c.home, 'und-verde', [
    { path: path.join(c.repo, 'node_modules'), ts: '2026-10-22T10:05:00.000Z', kind: 'delete' },
    { path: '/tmp/afuera/node_modules', ts: '2026-10-22T10:05:00.000Z', kind: 'delete' },
    { path: path.join(c.repo, 'build.log'), ts: '2026-10-22T10:05:00.000Z' },
  ]);
  const r = cerrar(c.home, 'und-verde');
  assert.doesNotMatch(r.stderr, /cambios sin declarar/, r.stderr);
  assert.match(r.stderr, /borrado por la terminal.*node_modules/s, 'el borrado sale como aviso');
  assert.doesNotMatch(r.stderr, /\/tmp\/afuera/, 'sólo lo de adentro del repo');
  const l = lineasDelControl(c.home);
  assert.equal(l.length, 1);
  assert.equal(l[0].action, 'verde');
  assert.equal(l[0].deletes, 1);

  // con el registro de la consola apagado, el aviso lo dice en vez de callar
  marcador(c.home, 'und-apagado', { storyPath: c.storyPath, repoPath: c.repo, baseSha: c.baseSha });
  const a = cerrar(c.home, 'und-apagado', { TYCON_NO_RUN_CHANGE: '1' });
  assert.match(a.stderr, /los borrados por la terminal no se registraron/);
  fs.rmSync(c.home, { recursive: true, force: true });

  // sin git: no mide, lo dice y no frena por esto
  const s = corral({ conGit: false });
  fs.writeFileSync(path.join(s.repo, 'package.json'), '{"name":"y"}\n');
  marcador(s.home, 'und-singit', { storyPath: s.storyPath, repoPath: s.repo, baseSha: 'abc1234' });
  const g = cerrar(s.home, 'und-singit');
  assert.match(g.stderr, /cambios sin declarar: no medido: /);
  assert.doesNotMatch(g.stderr, /BLOQUEADO — cambios sin declarar/);
  assert.equal(lineasDelControl(s.home)[0].action, 'no-medido');
  fs.rmSync(s.home, { recursive: true, force: true });

  // la historia que no se lee: no mide
  const h = corral();
  fs.writeFileSync(path.join(h.repo, 'package.json'), '{"name":"h"}\n');
  marcador(h.home, 'und-sinhistoria', { storyPath: path.join(h.repo, 'specs', 'no-esta.md'), repoPath: h.repo, baseSha: h.baseSha });
  assert.match(cerrar(h.home, 'und-sinhistoria').stderr, /cambios sin declarar: no medido: no pude leer la historia/);
  fs.rmSync(h.home, { recursive: true, force: true });

  // sin commit de arranque en el marcador: tampoco mide
  const b = corral();
  fs.writeFileSync(path.join(b.repo, 'package.json'), '{"name":"z"}\n');
  marcador(b.home, 'und-sinbase', { storyPath: b.storyPath, repoPath: b.repo });
  const n = cerrar(b.home, 'und-sinbase');
  assert.match(n.stderr, /cambios sin declarar: no medido: .*commit de arranque/);
  assert.equal(lineasDelControl(b.home)[0].action, 'no-medido');
  fs.rmSync(b.home, { recursive: true, force: true });
});

test('T35 Cierre_LoDeclarado_LocksFileListYRegistro', () => {
  const uc = require(path.join(SCRIPTS, 'lib', 'undeclared-changes.js'));
  const c = corral({ modificar: ['app/App.csproj'] });
  // el File List en prosa, con rutas entre comillas invertidas
  fs.appendFileSync(c.storyPath, 'Público: `src/c.ts` y `src/d.ts`, más la story.\n');
  for (const [f, t] of [['package-lock.json', '{}'], ['app/App.csproj', '<Project/>'], ['app/packages.lock.json', '{}'],
    ['src/c.ts', 'c'], ['src/d.ts', 'd'], ['.advisors/x/findings.json', '[]']]) {
    fs.mkdirSync(path.dirname(path.join(c.repo, f)), { recursive: true });
    fs.writeFileSync(path.join(c.repo, f), `${t}\n`);
  }
  const r = uc.computeUndeclared({ repo: c.repo, baseSha: c.baseSha, storyPath: c.storyPath });
  assert.equal(r.medido, true);
  // el lock de npm sin su package.json declarado sobra; el de NuGet con su .csproj declarado no; .advisors no cuenta
  assert.deepEqual(r.sobra, ['package-lock.json']);

  // una línea rota del registro de la consola: el aviso dice que puede estar incompleto
  const estado = path.join(c.home, 'estado');
  fs.mkdirSync(path.join(estado, 'console-writes'), { recursive: true });
  fs.writeFileSync(path.join(estado, 'console-writes', 's.jsonl'), `{"path":"${path.join(c.repo, 'node_modules')}","kind":"delete"}\n{roto\n`);
  const cw = uc.consoleWritesOf(estado, 's');
  assert.equal(cw.lineas.length, 1);
  assert.match(cw.problemas.join(' '), /1 línea\(s\) ilegible/);
  const r2 = uc.computeUndeclared({ repo: c.repo, baseSha: c.baseSha, storyPath: c.storyPath, consola: cw.lineas, consolaProblemas: cw.problemas });
  assert.match(r2.avisos.join('\n'), /pueden estar incompletos/);
  assert.match(r2.avisos.join('\n'), /borrado por la terminal: node_modules/);
  fs.rmSync(c.home, { recursive: true, force: true });
});

test('T35 Cierre_LoQueNoEsDeLaEjecucion_NoSobra', () => {
  const uc = require(path.join(SCRIPTS, 'lib', 'undeclared-changes.js'));
  const c = corral({ modificar: ['src/a.ts'] });
  const arranque = '2026-10-22T12:00:00.000Z';
  const antes = new Date('2026-10-22T11:00:00.000Z');
  // ya estaban antes de arrancar: un archivo sin rastrear y uno rastreado con cambios sin commitear
  fs.writeFileSync(path.join(c.repo, 'guard-old.sh'), 'x\n');
  fs.writeFileSync(path.join(c.repo, 'package.json'), '{"name":"previo"}\n');
  for (const f of ['guard-old.sh', 'package.json']) fs.utimesSync(path.join(c.repo, f), antes, antes);
  // lo que el arranque agrega al .gitignore
  fs.writeFileSync(path.join(c.repo, '.gitignore'), '\n# arnés\n**/.advisors/*\n!**/.advisors/dod-runtime/\n');
  // el registro con otra forma de la misma ruta (un enlace en el medio)
  const enlace = path.join(c.home, 'enlace');
  fs.symlinkSync(c.repo, enlace);
  fs.writeFileSync(path.join(c.repo, 'src', 'a.ts'), 'export const a = 3;\n');
  fs.writeFileSync(path.join(c.repo, 'src', 'e.ts'), 'e\n');
  const r = uc.computeUndeclared({ repo: c.repo, baseSha: c.baseSha, storyPath: c.storyPath, startedAt: arranque,
    registrados: [path.join(enlace, 'src', 'e.ts')] });
  assert.equal(r.medido, true);
  assert.deepEqual(r.sobra, [], JSON.stringify(r));
  assert.deepEqual(r.previos, ['guard-old.sh', 'package.json']);
  assert.match(r.avisos.join('\n'), /antes de arrancar/);
  // una línea del .gitignore que no es del arranque sí cuenta
  fs.appendFileSync(path.join(c.repo, '.gitignore'), 'secretos/\n');
  assert.deepEqual(uc.computeUndeclared({ repo: c.repo, baseSha: c.baseSha, storyPath: c.storyPath, startedAt: arranque,
    registrados: [path.join(c.repo, 'src', 'e.ts')] }).sobra, ['.gitignore']);
  // un .gitignore ya rastreado: lo que el arranque le agrega no cuenta; una línea borrada sí
  fs.writeFileSync(path.join(c.repo, '.gitignore'), 'build/\n');
  git(c.repo, 'add', '.gitignore');
  git(c.repo, 'commit', '-q', '-m', 'gitignore');
  const base2 = git(c.repo, 'rev-parse', 'HEAD');
  fs.appendFileSync(path.join(c.repo, '.gitignore'), '\n**/.advisors/*\n');
  const conArranque = uc.computeUndeclared({ repo: c.repo, baseSha: base2, storyPath: c.storyPath, startedAt: arranque, registrados: [path.join(c.repo, 'src', 'e.ts'), path.join(c.repo, 'src', 'a.ts')] });
  assert.ok(!conArranque.sobra.includes('.gitignore'), JSON.stringify(conArranque));
  fs.writeFileSync(path.join(c.repo, '.gitignore'), '**/.advisors/*\n');
  assert.ok(uc.computeUndeclared({ repo: c.repo, baseSha: base2, storyPath: c.storyPath, startedAt: arranque }).sobra.includes('.gitignore'), 'una línea borrada cuenta');
  fs.rmSync(c.home, { recursive: true, force: true });
});

test('T35 Cierre_RepoEnUnaSubcarpeta_YFileListConSubtitulos', () => {
  const uc = require(path.join(SCRIPTS, 'lib', 'undeclared-changes.js'));
  const c = corral();
  const sub = path.join(c.repo, 'app');
  fs.mkdirSync(path.join(sub, 'src'), { recursive: true });
  fs.writeFileSync(path.join(sub, 'src', 'x.ts'), 'x\n');
  git(c.repo, 'add', '-A');
  git(c.repo, 'commit', '-q', '-m', 'sub');
  const base = git(c.repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(sub, 'src', 'x.ts'), 'y\n');
  fs.writeFileSync(path.join(sub, 'src', 'z.ts'), 'z\n');
  // afuera de la subcarpeta: no es de esta ejecución
  fs.writeFileSync(path.join(c.repo, 'src', 'a.ts'), 'otro\n');
  const historia = path.join(c.home, 'historia.md');
  fs.writeFileSync(historia, '---\nstory: "9.9"\nfiles_to_modify:\n  - src/x.ts\n---\n\n## Dev Agent Record\n\n### File List\n\n#### Nuevos\n\n- `src/z.ts`\n\n## Change Log\n\n- `src/otro.ts`\n');
  const r = uc.computeUndeclared({ repo: sub, baseSha: base, storyPath: historia });
  assert.equal(r.medido, true);
  assert.deepEqual(r.sobra, [], JSON.stringify(r));
  assert.deepEqual(uc.fileListOf(fs.readFileSync(historia, 'utf8')), ['src/z.ts']);
  fs.rmSync(c.home, { recursive: true, force: true });
});

// Una tanda que sale de main después de que otra story entró: el diff contra el arranque de la tanda anterior trae los
// archivos de esa story. Se descuenta un archivo sólo si las tres cosas son ciertas: su contenido es el de origin/main,
// entró a main después del arranque, y la ejecución no lo tocó nunca. Si falta cualquiera, sigue contando.
function conMainAdelante() {
  const c = corral({ modificar: ['src/a.ts'] });
  // otra story entra a main después del arranque: un archivo nuevo y uno cambiado
  fs.mkdirSync(path.join(c.repo, 'otra'), { recursive: true });
  fs.writeFileSync(path.join(c.repo, 'otra', 'vigilante.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(c.repo, 'package.json'), '{"name":"x","otra":true}\n');
  git(c.repo, 'add', '-A');
  git(c.repo, 'commit', '-q', '-m', 'merge de otra story');
  git(c.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  // y la tanda trabaja encima
  fs.writeFileSync(path.join(c.repo, 'src', 'a.ts'), 'export const a = 2;\n');
  return c;
}

test('T35 Cierre_LoQueEntroPorMain_NoSobra @story-8.115 @ac-11', () => {
  const uc = require(path.join(SCRIPTS, 'lib', 'undeclared-changes.js'));
  const c = conMainAdelante();
  const r = uc.computeUndeclared({ repo: c.repo, baseSha: c.baseSha, storyPath: c.storyPath, registrados: [path.join(c.repo, 'src', 'a.ts')] });
  assert.equal(r.medido, true);
  assert.deepEqual(r.sobra, [], JSON.stringify(r));
  assert.match(r.avisos.join('\n'), /entró por main.*otra\/vigilante\.js/s, 'lo descontado se dice');
  fs.rmSync(c.home, { recursive: true, force: true });
});

test('T34 Cierre_LoQueEntroPorMain_SiLaEjecucionLoToco_Sobra @story-8.115 @ac-11', () => {
  const uc = require(path.join(SCRIPTS, 'lib', 'undeclared-changes.js'));
  const c = conMainAdelante();
  // la ejecución lo tocó por la terminal (lo restauró desde main): igual al de main, pero cuenta
  const r = uc.computeUndeclared({ repo: c.repo, baseSha: c.baseSha, storyPath: c.storyPath, registrados: [path.join(c.repo, 'src', 'a.ts')],
    consola: [{ path: path.join(c.repo, 'otra', 'vigilante.js'), kind: 'restore' }] });
  assert.deepEqual(r.sobra, ['otra/vigilante.js'], JSON.stringify(r));
  // uno que entró por main pero la tanda dejó distinto: también cuenta
  fs.writeFileSync(path.join(c.repo, 'package.json'), '{"name":"x","otra":false}\n');
  const r2 = uc.computeUndeclared({ repo: c.repo, baseSha: c.baseSha, storyPath: c.storyPath, registrados: [path.join(c.repo, 'src', 'a.ts')] });
  assert.deepEqual(r2.sobra, ['package.json'], JSON.stringify(r2));
  // sin origin/main no hay con qué comparar: nada se descuenta
  git(c.repo, 'update-ref', '-d', 'refs/remotes/origin/main');
  const r3 = uc.computeUndeclared({ repo: c.repo, baseSha: c.baseSha, storyPath: c.storyPath, registrados: [path.join(c.repo, 'src', 'a.ts')] });
  assert.deepEqual(r3.sobra, ['otra/vigilante.js', 'package.json'], JSON.stringify(r3));
  fs.rmSync(c.home, { recursive: true, force: true });
});

test('T34 Cierre_IgualAMainPeroSinEntrarDespuesDelArranque_Sobra @story-8.115 @ac-11', () => {
  const uc = require(path.join(SCRIPTS, 'lib', 'undeclared-changes.js'));
  const c = corral({ modificar: ['src/a.ts'] });
  // main quedó atrás: el arranque es un commit posterior que cambió el package.json
  git(c.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const deMain = fs.readFileSync(path.join(c.repo, 'package.json'), 'utf8');
  fs.writeFileSync(path.join(c.repo, 'package.json'), '{"name":"arranque"}\n');
  git(c.repo, 'commit', '-q', '-am', 'arranque de la tanda');
  const base = git(c.repo, 'rev-parse', 'HEAD');
  // la tanda lo devuelve a mano al contenido de main, sin Edit: igual a main, pero no entró a main después del arranque
  fs.writeFileSync(path.join(c.repo, 'package.json'), deMain);
  const r = uc.computeUndeclared({ repo: c.repo, baseSha: base, storyPath: c.storyPath });
  assert.deepEqual(r.sobra, ['package.json'], JSON.stringify(r));
  fs.rmSync(c.home, { recursive: true, force: true });
});
