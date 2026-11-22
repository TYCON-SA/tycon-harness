'use strict';
// hook-failure-critical.test.js — los frenos críticos cuando fallan (historia 8.159): frenan en su terreno y dejan pasar
// avisando fuera de él. Hoy, el freno de publicación (la tanda 0): su red con la entrada rota, el lanzador sin Node, su
// reloj propio, ningún timeout nuevo del instalador y una entrada sana que no lo toca.
// Todo aislado: casa temporal, un clon falso, sin red. Nada escribe en los registros de la máquina.
// Correr: cd scripts/tests && HOME=$(mktemp -d) node --test hook-failure-critical.test.js < /dev/null

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, GUARD, LAUNCHER, lab } = require('./lib/public-guard-lab.js');

const G = require(GUARD);
const EN_TERRENO = 'gh pr create -R TYCON-SA/tycon-harness --title t --body b';

test('T12 Critical_PublicPush_BrokenInputInTerrain_Blocks_OwnErrorWithGhOrPush_Blocks @story-8.159 @ac-0', (t) => {
  const L = lab(t);
  for (const raw of [`no es json ${EN_TERRENO}`, JSON.stringify({ tool_input: { otra: EN_TERRENO } }), JSON.stringify({ tool_input: { command: 42 }, x: 'gh release create v1' })]) {
    const r = L.correr(raw);
    assert.strictEqual(r.code, 2, `entrada rota con un gh que publica frena: ${raw.slice(0, 60)}`);
    assert.match(r.err, /no pude leer el comando de este evento/);
  }
  for (const cmd of [EN_TERRENO, 'git push origin main', 'gh issue comment 3 --body x']) {
    const r = L.correr(L.evento(cmd), { guion: L.sola });
    assert.strictEqual(r.code, 2, `error propio con ${cmd}: frena`);
    assert.match(r.err, /falló por dentro \(MODULE_NOT_FOUND\)/);
  }
  const r = L.correr(L.evento('ls'), { guion: L.roto('throw') });
  assert.strictEqual(r.code, 2, 'un error que se escapa a la salida principal frena siempre, también fuera del terreno');
});

test('T13 Critical_PublicPush_BrokenInputOutsideTerrain_Passes @story-8.159 @ac-0 — fuera de su terreno pasa, y lo dice', (t) => {
  const L = lab(t);
  for (const raw of ['no es json', '', JSON.stringify({ tool_input: { otra: 'git push origin main' } })]) {
    const r = L.correr(raw);
    assert.strictEqual(r.code, 0, `entrada rota sin un gh que publica pasa (aunque traiga push): ${JSON.stringify(raw).slice(0, 60)}`);
    assert.match(r.err, /no freno, pero tampoco miré/);
  }
  const r = L.correr(L.evento('ls -la'), { guion: L.sola });
  assert.strictEqual(r.code, 0, 'error propio sin gh ni push: pasa');
  assert.match(r.err, /falló por dentro/, 'y lo dice');
});

test('T14 Critical_Launcher_NoNode_BlocksInTerrain_PassesOutside @story-8.159 @ac-0 — sin Node, el lanzador decide por el terreno', (t) => {
  const L = lab(t);
  const sinNode = L.pathSin('node');
  const lanzar = (input, runner = 'node') => L.correr(input, { argv: ['/bin/bash', LAUNCHER, runner, GUARD], extra: { PATH: sinNode } });
  for (const cmd of [EN_TERRENO, 'git push origin main', 'gh.exe api repos/x/y -X POST', "gh 'repo' create x"]) {
    const r = lanzar(L.evento(cmd));
    assert.strictEqual(r.code, 2, `sin Node, ${cmd}: frena`);
    assert.match(r.err, /no pude arrancar|no encuentro node/i);
  }
  // un `gh pr` cuenta aunque sólo lea (`gh pr view`): el terreno es el de la regla de hoy, que no distingue
  for (const cmd of ['ls -la', 'gh auth status', 'echo pu sh']) {
    const r = lanzar(L.evento(cmd));
    assert.strictEqual(r.code, 0, `sin Node, ${cmd}: pasa`);
    assert.match(r.err, /no publica, así que pasa/);
  }
  assert.strictEqual(lanzar(L.evento(EN_TERRENO), '/no/existe/node').code, 2, 'una ruta de Node que no está, igual');
  // el lanzador y el freno miran el mismo terreno
  for (const cmd of [EN_TERRENO, 'git push', 'gh pr view 1', 'ls', 'gh label create x', 'xgh pr create', 'gh prx']) {
    const raw = L.evento(cmd);
    assert.strictEqual(lanzar(raw).code === 2, G.inTerrain(raw), `el mismo terreno para «${cmd}»`);
  }
});

test('T14b Installer_WritesLauncher_UpgradesOld_NotOnWindows @story-8.159 @ac-0 — el instalador lo registra con el lanzador, y lo pone al día', (t) => {
  const AH = require(path.join(ROOT, 'scripts', 'setup', 'apply-hooks.js'));
  const L = lab(t);
  const dir = path.join(L.dir, 'hooks');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'public-push-guard.js'), '');
  fs.copyFileSync(LAUNCHER, path.join(dir, 'node-missing-launcher.sh'));
  const list = { hooks: [{ event: 'PreToolUse', matcher: 'Bash|PowerShell', spec: '@tcg:public-push-guard.js', launcher: 'node-missing-launcher.sh', when: 'always', platforms: { windows: true }, effect: 'blocks', label: 'publicación' }] };
  fs.writeFileSync(path.join(dir, 'hooks-list.json'), JSON.stringify(list));
  const cargada = AH.loadList(path.join(dir, 'hooks-list.json'));
  const aplicar = (settings, platform) => {
    const d = AH.decide(cargada, { env: {}, integ: { state: 'ok', values: {} }, profile: { state: 'ok', value: 'full' }, minimalIds: new Set(), platform, has: () => true });
    return AH.applyToSettings(settings, { list: cargada, decision: d, platform, hooksDir: dir, skills: dir, env: {}, check: false, floor: null, settingsPath: path.join(dir, 'settings.json') });
  };
  const comandos = (s) => (s.hooks.PreToolUse || []).flatMap((e) => e.hooks.map((h) => h.command));
  const nuevo = { hooks: {} };
  aplicar(nuevo, 'posix');
  assert.deepStrictEqual(comandos(nuevo), [`bash "${path.join(dir, 'node-missing-launcher.sh')}" node "${path.join(dir, 'public-push-guard.js')}"`]);
  const otraVez = aplicar(nuevo, 'posix');
  assert.deepStrictEqual(otraVez.reformed, [], 'la segunda vez no cambia nada');
  assert.strictEqual(comandos(nuevo).length, 1, 'sin repetirlo');
  // por otra ruta al mismo árbol (el enlace estable o el clon), la línea queda como estaba escrita
  const enlace = path.join(L.dir, 'enlace');
  fs.symlinkSync(dir, enlace);
  const porEnlace = (() => {
    const d = AH.decide(cargada, { env: {}, integ: { state: 'ok', values: {} }, profile: { state: 'ok', value: 'full' }, minimalIds: new Set(), platform: 'posix', has: () => true });
    return AH.applyToSettings(nuevo, { list: cargada, decision: d, platform: 'posix', hooksDir: enlace, skills: enlace, env: {}, check: false, floor: null, settingsPath: path.join(dir, 'settings.json') });
  })();
  assert.deepStrictEqual(porEnlace.reformed, [], 'por el enlace no se reescribe');
  assert.strictEqual(comandos(nuevo).length, 1, 'por el enlace no se repite');
  // una instalación de antes, sin lanzador, se pone al día en su lugar
  const viejo = { hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: `node "${path.join(dir, 'public-push-guard.js')}"` }] }] } };
  const r = aplicar(viejo, 'posix');
  assert.strictEqual(r.reformed.length, 1, 'se reescribe');
  assert.deepStrictEqual(comandos(viejo), comandos(nuevo));
  const win = { hooks: {} };
  aplicar(win, 'windows');
  assert.ok(comandos(win).every((c) => !c.includes('node-missing-launcher.sh')), 'en Windows, sin lanzador');
  assert.ok(AH.validateList({ hooks: [{ ...list.hooks[0], launcher: 'otro.sh' }] }).some((p) => /launcher/.test(p)), 'un lanzador desconocido no pasa la validación');
  const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'hooks-list.json'), 'utf8'));
  assert.strictEqual(real.hooks.find((h) => h.spec === '@tcg:public-push-guard.js').launcher, 'node-missing-launcher.sh', 'la lista real lo pide');
});

test('T15 Critical_Launcher_WithNode_PassesInputAndOutputUnchanged @story-8.159 @ac-0 — con Node, el freno corre igual que sin lanzador', (t) => {
  const L = lab(t);
  for (const input of [L.evento(EN_TERRENO), L.evento('ls'), 'no es json', '', L.evento('git push origin main')]) {
    const directo = L.correr(input);
    const lanzado = L.correr(input, { argv: ['/bin/bash', LAUNCHER, process.execPath, GUARD] });
    assert.deepStrictEqual({ code: lanzado.code, err: lanzado.err, out: lanzado.out }, { code: directo.code, err: directo.err, out: directo.out }, `igual con «${input.slice(0, 50)}»`);
  }
  const r = spawnSync('/bin/bash', [LAUNCHER, 'node'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2, 'sin la línea del freno, el lanzador frena');
});

test('T17 Critical_PublicPush_Hang_BlocksInTerrainBeforeTimeout @story-8.159 @ac-0 — colgado, su reloj vence y decide por el terreno', (t) => {
  const L = lab(t);
  const colgado = L.roto('hang');
  // stable-data: mide cuánto tarda en vencer el reloj del freno, no una fecha
  const t0 = Date.now();
  const dentro = L.correr(L.evento(EN_TERRENO), { guion: colgado, extra: { TYCON_PUBLIC_GUARD_CLOCK_MS: '500' } });
  assert.strictEqual(dentro.code, 2, dentro.err);
  assert.match(dentro.err, /no alcanzó a revisar este comando en 1 s/);
  assert.ok(Date.now() - t0 < 15000, 'vence a tiempo');
  const fuera = L.correr(L.evento('ls'), { guion: colgado, extra: { TYCON_PUBLIC_GUARD_CLOCK_MS: '500' } });
  assert.strictEqual(fuera.code, 0);
  assert.match(fuera.err, /no publica, así que pasa/);
});

test('T18 Installer_NoNewTimeouts_OwnClockShorterThanToolDefault @story-8.159 @ac-0 — ningún freno con timeout; el reloj vence antes que la herramienta', () => {
  const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'hooks-list.json'), 'utf8'));
  const conTimeout = list.hooks.filter((h) => h.effect === 'blocks' && h.timeout !== undefined).map((h) => `${h.event}:${h.spec}`);
  assert.deepStrictEqual(conTimeout, [], 'ningún freno lleva timeout: un tiempo agotado deja pasar');
  const policy = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'hook-failure-policy.json'), 'utf8'));
  assert.strictEqual(policy.frenos.find((f) => f.guion === 'public-push-guard.js').reloj_propio_ms, G.HOOK_CLOCK_MS, 'la tabla dice el reloj del freno');
  const inv = fs.readFileSync(path.join(ROOT, 'guides', 'maintaining', 'codex-divergence-inventory.md'), 'utf8');
  const sec = (/## El tope por defecto de un gancho[\s\S]*?(?=\n## |$)/.exec(inv) || [''])[0];
  for (const herr of ['Claude Code', 'Codex']) {
    const m = new RegExp(`\\| ${herr} \\| tope_s: (\\d+)`).exec(sec);
    assert.ok(m, `el inventario dice el tope de ${herr}`);
    assert.ok(G.HOOK_CLOCK_MS < Number(m[1]) * 1000, `el reloj (${G.HOOK_CLOCK_MS} ms) vence antes que ${herr} (${m[1]} s)`);
  }
});

test('T20 Critical_SaneUnrelatedInput_Passes @story-8.159 @ac-0 — una entrada sana que no publica pasa sin decir nada', (t) => {
  const L = lab(t);
  for (const cmd of ['ls -la', 'git status', 'gh pr view 12 -R TYCON-SA/tycon-harness', 'node --version']) {
    const r = L.correr(L.evento(cmd));
    assert.strictEqual(r.code, 0, cmd);
    assert.strictEqual(r.err, '', `${cmd}: sin aviso`);
  }
});

// Pase adversarial (21/11): el terreno con un tabulador o un salto de línea entre `gh` y su orden (en el texto crudo
// llegan escritos como `\t` y `\n`), y con el repo antes de la orden; el desinstalador y el doctor con la línea nueva.
const ESCAPADOS = ['gh\tpr create --title t --body b', 'gh \\\n  pr create --title t --body b', 'gh -R dueño/repo pr create --title t', 'gh --repo=o/r issue comment 1 --body x', 'echo hola\ngh pr create',
  'gh -Ro/r pr create -t x', 'gh -t "x y" -b z issue create', 'gh -L 1 repo create z', 'gh --repo o/r --repo=o/r label create x'];
// fuera del terreno: la orden en otro comando, o una palabra que sólo empieza como una orden
const NO_PUBLICAN = ['gh auth status; echo pr', 'gh workflow run x -f label=y', 'gh auth status && echo issue'];

test('T21b Critical_Terrain_EscapesAndRepoFlag_BlockInEveryNewPath @story-8.159 @ac-0 — sin Node, con el reloj vencido y con la entrada rota', (t) => {
  const L = lab(t);
  const sinNode = L.pathSin('node');
  const colgado = L.roto('hang');
  for (const cmd of ESCAPADOS) {
    assert.strictEqual(L.correr(L.evento(cmd), { argv: ['/bin/bash', LAUNCHER, 'node', GUARD], extra: { PATH: sinNode } }).code, 2, `sin Node: ${JSON.stringify(cmd)}`);
    assert.strictEqual(L.correr(L.evento(cmd), { guion: colgado, extra: { TYCON_PUBLIC_GUARD_CLOCK_MS: '400' } }).code, 2, `reloj vencido: ${JSON.stringify(cmd)}`);
    assert.strictEqual(L.correr(JSON.stringify({ tool_input: { otra: cmd } })).code, 2, `entrada rota: ${JSON.stringify(cmd)}`);
    assert.ok(G.inTerrain(G.terrainText(L.evento(cmd))), `el terreno del freno: ${JSON.stringify(cmd)}`);
  }
  for (const cmd of NO_PUBLICAN) {
    assert.strictEqual(L.correr(L.evento(cmd), { argv: ['/bin/bash', LAUNCHER, 'node', GUARD], extra: { PATH: sinNode } }).code, 0, `sin Node, no publica: ${cmd}`);
    assert.ok(!G.inTerrain(G.terrainText(L.evento(cmd))), `fuera del terreno del freno: ${cmd}`);
  }
  // sin `sed`, el lanzador mira el texto tal cual y sigue frenando lo de siempre
  const sinSed = L.pathSin('sed', ['bash', 'cat', 'grep', 'printf']);
  assert.strictEqual(L.correr(L.evento(EN_TERRENO), { argv: ['/bin/bash', LAUNCHER, 'node', GUARD], extra: { PATH: sinSed } }).code, 2, 'sin sed: frena igual');
});

test('T14c Installer_UninstallAndDoctor_KnowTheLauncherLine @story-8.159 @ac-0 — desinstalar lo saca y el doctor no lo toma por otro Node', (t) => {
  const L = lab(t);
  const RM = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'remove.js'));
  const HN = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'harness-node.js'));
  const raiz = path.join(L.dir, 'arnes');
  const guion = path.join(raiz, 'scripts', 'hooks', 'public-push-guard.js');
  const lanz = path.join(raiz, 'scripts', 'hooks', 'node-missing-launcher.sh');
  const propio = path.join(L.casa, '.tycon', 'node', 'current', 'bin', 'node');
  for (const cmd of [`bash "${lanz}" node "${guion}"`, `bash "${lanz}" ${propio} "${guion}"`]) {
    // las raíces llegan normalizadas, sin el `/private` con que macOS resuelve /var (como las arma hookRoots)
    assert.ok(RM.isHarnessCommand(cmd, 'scripts/hooks/public-push-guard.js', [raiz.replace(/^\/private(?=\/(?:var|tmp)\/)/, '')]), `el desinstalador lo reconoce: ${cmd}`);
  }
  const settings = path.join(L.dir, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `bash "${lanz}" ${propio} "${guion}"` }] }] } }));
  const c = HN.countHooks(settings, { own: true, prefix: propio }, ['scripts/hooks/public-push-guard.js']);
  assert.deepStrictEqual({ own: c.own, other: c.other }, { own: 1, other: 0 }, 'el doctor lo cuenta con el Node propio');
});

test('T14d Rollback_DropsLauncherTheOldVersionLacks @story-8.159 @ac-0 — volver a una versión sin lanzador lo saca de la línea; si está, no', (t) => {
  const L = lab(t);
  const RB = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'rollback.js'));
  const guion = path.join(L.dir, 'h', 'public-push-guard.js');
  const falta = path.join(L.dir, 'h', 'node-missing-launcher.sh');
  const esta = path.join(L.dir, 'otro', 'node-missing-launcher.sh');
  fs.mkdirSync(path.dirname(esta), { recursive: true });
  fs.writeFileSync(esta, '');
  fs.mkdirSync(path.join(L.casa, '.claude'), { recursive: true });
  const file = path.join(L.casa, '.claude', 'settings.json');
  const hooks = (a, b) => ({ permissions: { allow: ['Bash(ls)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: a }, { type: 'command', command: b }] }] } });
  fs.writeFileSync(file, JSON.stringify(hooks(`bash "${falta}" node "${guion}"`, `bash "${esta}" node "${guion}"`)));
  const dicho = [];
  RB.dropMissingLauncher(L.casa, (l) => dicho.push(l));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), hooks(`node "${guion}"`, `bash "${esta}" node "${guion}"`));
  assert.match(dicho.join('\n'), /saqué el lanzador/);
});
