'use strict';
/**
 * browser-test-offer.test.js — un repo sin prueba con navegador ofrece prepararla cuando una historia cambia una
 * pantalla; con el sí la prepara en el repo, y con el no la historia sigue con la prueba pendiente a la vista.
 *
 * Lo que no se puede perder:
 *   - La oferta la muestra el arnés en pantalla (`systemMessage`), con el texto aprobado, sólo si la historia cambia una
 *     pantalla Y el repo no tiene prueba con navegador. El no vale para su historia: la próxima la vuelve a recibir.
 *   - Preparar y anotar el no piden el ok de la persona (escrito por ella, o reenviado por la sesión relevo), y el no
 *     además posterior a la oferta de esa historia.
 *   - Los frenos del cierre aceptan el no sólo si vuelven a encontrar ese ok en la conversación: la constancia sola, o
 *     la marca de la historia sola, no alcanzan. Con el repo ya preparado, la prueba se corre y no se exime.
 *   - Lo que se escribe o se borra queda dentro del repo.
 *
 * stable-data: las horas de los mensajes de prueba se calculan desde el reloj (después de la oferta), no se comparan
 * contra un valor fijo.
 *
 * Corre contra un HOME temporal, repos de juguete con git, y `npm` / `npx` simulados en el PATH que anotan cómo se los
 * llamó (no se baja nada).
 *
 * 0 deps (node:test).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const STEPS = path.join(SCRIPTS, '..', 'steps');
const HARNESS = path.join(SCRIPTS, '..', '..', '..');
const bt = require(path.join(SCRIPTS, 'lib', 'browser-test.js'));

const tmp = (prefijo) => fs.mkdtempSync(path.join(os.tmpdir(), prefijo));
const GIT_ENV = { ...process.env, GIT_AUTHOR_DATE: '2026-10-19T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-19T12:00:00Z' };
const despues = () => new Date(Date.now() + 5000).toISOString();

// La tienda del laboratorio: una página estática en frontend/, el package.json en la raíz, sin Playwright.
function tienda({ conPantalla = true, id = '1.1' } = {}) {
  const repo = path.join(tmp('bt-offer-'), 'tienda');
  fs.mkdirSync(path.join(repo, 'frontend', 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'stories'));
  fs.writeFileSync(path.join(repo, 'package.json'), '{\n  "name": "tienda",\n  "version": "1.0.0",\n  "scripts": { "test": "node --test" }\n}\n');
  fs.writeFileSync(path.join(repo, 'frontend', 'index.html'), '<!doctype html><title>Tienda</title><p id="precio"></p>\n');
  fs.writeFileSync(path.join(repo, 'frontend', 'src', 'main.js'), 'export {};\n');
  fs.writeFileSync(path.join(repo, 'lib.js'), 'module.exports = {};\n');
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { stdio: 'ignore', env: GIT_ENV });
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  const story = historia(repo, id, conPantalla);
  git('add', '.'); git('commit', '-qm', 'base');
  return { repo, story };
}

function historia(repo, id, conPantalla = true) {
  const story = path.join(repo, 'stories', `story-${id}-precio.md`);
  fs.writeFileSync(story, ['---', `story: "${id}"`, 'title: "El precio en pesos"', 'status: in-progress',
    'files_to_modify:', conPantalla ? '  - frontend/src/main.js' : '  - lib.js', '---', '', `# Story ${id}`, '',
    ...(conPantalla ? ['### Tests', '', '| # | Nombre | AC | Nivel |', '|---|---|---|---|', `| E1 | tests/e2e/${id}.spec.ts (Playwright) | 1 | e2e |`, ''] : [])].join('\n'));
  return story;
}

function markerCli(home, sid, cwd, args) {
  return spawnSync('node', [path.join(SCRIPTS, 'marker.js'), ...args], {
    cwd, encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0' },
  });
}

function hasta3(home, sid, repo, story, id = '1.1') {
  const set = markerCli(home, sid, repo, ['set', JSON.stringify({ storyId: id, storyPath: story, repoPath: repo })]);
  assert.equal(set.status, 0, set.stderr);
  for (const n of ['0', '1', '2']) markerCli(home, sid, repo, ['complete-step', n]);
}

/** La conversación como la guarda Claude Code. `persona`: lo que tipeó la persona; `otra`: mensajes de otra sesión. */
function conversacion(home, sid, { persona = [], agente = ['Sigo.'], otra = [], cuando = despues() } = {}) {
  const dir = path.join(home, '.claude', 'projects', '-tienda');
  fs.mkdirSync(dir, { recursive: true });
  const r = [
    ...agente.map((text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })),
    ...persona.map((content) => ({ type: 'user', timestamp: cuando, message: { role: 'user', content } })),
    ...otra.map(([name, body]) => ({ type: 'user', timestamp: cuando, isMeta: true, promptSource: 'system', origin: { kind: 'peer', name, body }, message: { role: 'user', content: body } })),
  ];
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), `${r.map((x) => JSON.stringify(x)).join('\n')}\n`);
}

/** La puerta Bash del portón de carril, como la corre Claude Code antes de un comando. */
function puertaBash(home, sid, repo, command) {
  return spawnSync('node', [path.join(SCRIPTS, 'on-bash-write-gate.js')], {
    cwd: repo, encoding: 'utf8',
    input: JSON.stringify({ session_id: sid, tool_name: 'Bash', cwd: repo, tool_input: { command } }),
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0' },
  });
}

// `npm` y `npx` de mentira: anotan su línea en un archivo y, al instalar, dejan el paquete donde Node lo encuentra.
function binariosSimulados() {
  const bin = tmp('bt-bin-');
  const log = path.join(bin, 'llamadas.log');
  const js = `const fs=require('fs'),path=require('path');fs.appendFileSync(${JSON.stringify(log)},process.argv.slice(2).join(' ')+'\\n');` +
    `const a=process.argv.slice(2);if(a[0]==='install'&&a.includes('@playwright/test')){const d=path.join(process.cwd(),'node_modules','@playwright','test');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'package.json'),'{"name":"@playwright/test","version":"1.0.0"}');` +
    `const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.devDependencies={...(p.devDependencies||{}),'@playwright/test':'^1.0.0'};fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\\n');}` +
    `if(a[0]==='uninstall'){fs.rmSync(path.join(process.cwd(),'node_modules','@playwright'),{recursive:true,force:true});const p=JSON.parse(fs.readFileSync('package.json','utf8'));if(p.devDependencies)delete p.devDependencies['@playwright/test'];fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\\n');}`;
  fs.writeFileSync(path.join(bin, 'fake.js'), js);
  for (const n of ['npm', 'npx']) {
    fs.writeFileSync(path.join(bin, n), `#!/bin/sh\nexec node ${JSON.stringify(path.join(bin, 'fake.js'))} ${n === 'npx' ? 'npx' : ''} "$@"\n`);
    fs.chmodSync(path.join(bin, n), 0o755);
  }
  return { bin, log };
}

function setup(home, sid, repo, args, bin, extraEnv = {}) {
  return spawnSync('node', [path.join(SCRIPTS, 'e2e-setup.js'), ...args], {
    cwd: repo, encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...extraEnv },
  });
}

const stateOf = (home) => path.join(home, '.claude', '.tycon-pipeline');
const gatesDe = (home) => { try { return fs.readFileSync(path.join(stateOf(home), 'gates.log'), 'utf8'); } catch (_e) { return ''; } };
const cierre3 = `node ${path.join(SCRIPTS, 'marker.js')} complete-step 3 --approved "dale"`;

/** La oferta en pantalla y después el «no» de la persona, anotado con e2e-setup.js defer. */
function ofertaYNo(home, sid, bin, { repo, story, id = '1.1' }) {
  hasta3(home, sid, repo, story, id);
  conversacion(home, sid);
  assert.match(JSON.parse(puertaBash(home, sid, repo, cierre3).stdout).systemMessage, /¿Lo preparo\?/);
  conversacion(home, sid, { persona: ['no, por ahora no'] });
  return setup(home, sid, repo, ['defer', '--repo', repo, '--story', story, '--approved-by', 'Dev', '--no', 'no, por ahora no'], bin);
}

test('Oferta_PantallaSinNavegador_LaMuestraElArnes @story-8.67 @ac-1', () => {
  const home = tmp('bt-home-');
  const { repo, story } = tienda();
  hasta3(home, 's-oferta', repo, story);
  conversacion(home, 's-oferta');
  const p = puertaBash(home, 's-oferta', repo, cierre3);
  assert.equal(p.status, 0, p.stderr);
  const aviso = JSON.parse(p.stdout).systemMessage;
  assert.ok(aviso.includes(bt.offerText('1.1')), aviso);
  assert.match(aviso, /^Este repo todavía no tiene cómo probar en un navegador\. ¿Lo preparo\?/m);
  assert.match(aviso, /tests\/e2e\/1\.1\.spec\.ts/);
  assert.match(aviso, /«sí, preparala» o «no, por ahora no»/);
  assert.match(gatesDe(home), /"name":"browser-test-offer-shown"[^\n]*"story":"1\.1"/);
});

test('Oferta_ConElPlan_UnSoloAviso @story-8.67 @ac-1', () => {
  const home = tmp('bt-home-');
  const { repo, story } = tienda();
  hasta3(home, 's-plan', repo, story);
  const runDir = require(path.join(SCRIPTS, 'pipeline.js')).resolveRunDir(repo, '1.1', true, story);
  fs.writeFileSync(path.join(runDir, 'step-02-bmad-plan.md'), '# Plan\n\n1. Formatear el precio en pesos en frontend/src/main.js.\n');
  conversacion(home, 's-plan');
  const p = puertaBash(home, 's-plan', repo, cierre3);
  assert.equal(p.status, 0, p.stderr);
  const salida = p.stdout.trim();
  assert.equal(salida.split('\n').filter((l) => l.startsWith('{')).length, 1, salida);
  const aviso = JSON.parse(salida).systemMessage;
  assert.match(aviso, /El plan de la historia 1\.1/);
  assert.ok(aviso.includes(bt.offerText('1.1')), aviso);
});

test('Oferta_AlEscribirElPlan_LaMuestraElDespachador @story-8.67 @ac-1', () => {
  const home = tmp('bt-home-');
  const { repo, story } = tienda();
  hasta3(home, 's-desp', repo, story);
  conversacion(home, 's-desp');
  const runDir = require(path.join(SCRIPTS, 'pipeline.js')).resolveRunDir(repo, '1.1', true, story);
  const ev = { session_id: 's-desp', tool_name: 'Write', cwd: repo, tool_input: { file_path: path.join(runDir, 'step-02-bmad-plan.md'), content: '# Plan\n' } };
  const r = bt.handle(ev, { stateDir: stateOf(home), home });
  assert.ok(r && r.systemMessage.includes(bt.offerText('1.1')), JSON.stringify(r));
  r.alMostrar();
  assert.match(gatesDe(home), /"sessionId":"s-desp"[^\n]*"name":"browser-test-offer-shown"/);
  // mostrada, no se repite; y otro archivo no la dispara
  assert.equal(bt.handle(ev, { stateDir: stateOf(home), home }), null);
  assert.equal(bt.handle({ ...ev, tool_input: { file_path: path.join(repo, 'README.md') } }, { stateDir: stateOf(home), home }), null);
  // el despachador de ediciones de verdad: otra sesión con su historia ve la oferta en pantalla al escribir el plan
  const otra = tienda();
  hasta3(home, 's-desp2', otra.repo, otra.story);
  conversacion(home, 's-desp2');
  const rd2 = require(path.join(SCRIPTS, 'pipeline.js')).resolveRunDir(otra.repo, '1.1', true, otra.story);
  const d = spawnSync('node', [path.join(SCRIPTS, 'hook-post-edit.js')], {
    cwd: otra.repo, encoding: 'utf8',
    input: JSON.stringify({ session_id: 's-desp2', tool_name: 'Write', cwd: otra.repo, tool_input: { file_path: path.join(rd2, 'step-02-bmad-plan.md'), content: '# Plan\n' } }),
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: 's-desp2', TYCON_LANE_LLM: '0' },
  });
  assert.ok(JSON.parse(d.stdout).systemMessage.includes(bt.offerText('1.1')), d.stdout + d.stderr);
  assert.match(gatesDe(home), /"sessionId":"s-desp2"[^\n]*"name":"browser-test-offer-shown"/);
});

test('Oferta_SinPantallaOListo_NoSeMuestra @story-8.67 @ac-2', () => {
  const home = tmp('bt-home-');
  const sin = tienda({ conPantalla: false });
  hasta3(home, 's-sin', sin.repo, sin.story);
  conversacion(home, 's-sin');
  assert.equal(puertaBash(home, 's-sin', sin.repo, cierre3).stdout.trim(), '');
  const listo = tienda();
  fs.mkdirSync(path.join(listo.repo, '.tycon'));
  fs.writeFileSync(path.join(listo.repo, '.tycon', 'advisors.yaml'), 'e2e:\n  frontend_dir: .\n');
  const pw = path.join(listo.repo, 'node_modules', '@playwright', 'test');
  fs.mkdirSync(pw, { recursive: true });
  fs.writeFileSync(path.join(pw, 'package.json'), '{"name":"@playwright/test"}');
  assert.equal(bt.repoReady(listo.repo).ready, true);
  hasta3(home, 's-listo', listo.repo, listo.story);
  conversacion(home, 's-listo');
  assert.equal(puertaBash(home, 's-listo', listo.repo, cierre3).stdout.trim(), '');
  const otra = tienda();
  hasta3(home, 's-una', otra.repo, otra.story);
  conversacion(home, 's-una');
  assert.match(JSON.parse(puertaBash(home, 's-una', otra.repo, cierre3).stdout).systemMessage, /¿Lo preparo\?/);
  assert.equal(puertaBash(home, 's-una', otra.repo, cierre3).stdout.trim(), '');
});

test('Oferta_TrasUnNo_VuelveEnLaProximaHistoria @story-8.67 @ac-2', () => {
  const home = tmp('bt-home-');
  const { bin } = binariosSimulados();
  const t = tienda();
  const d = ofertaYNo(home, 's-no', bin, t);
  assert.equal(d.status, 0, d.stderr);
  // otra sesión con la misma historia: no se la repite
  hasta3(home, 's-no2', t.repo, t.story);
  conversacion(home, 's-no2');
  assert.equal(puertaBash(home, 's-no2', t.repo, cierre3).stdout.trim(), '');
  // la próxima historia con pantalla del mismo repo la vuelve a recibir
  const story2 = historia(t.repo, '1.2');
  hasta3(home, 's-12', t.repo, story2, '1.2');
  conversacion(home, 's-12');
  assert.ok(JSON.parse(puertaBash(home, 's-12', t.repo, cierre3).stdout).systemMessage.includes(bt.offerText('1.2')));
});

test('Prepare_ConOkDeLaPersona_InstalaEnElRepo @story-8.67 @ac-3', () => {
  const home = tmp('bt-home-');
  const { bin, log } = binariosSimulados();
  const { repo, story } = tienda();
  conversacion(home, 's-si', { persona: ['sí, preparala'] });
  const r = setup(home, 's-si', repo, ['prepare', '--repo', repo, '--story', story, '--approved-by', 'Dev', '--ok', 'sí, preparala'], bin);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const llamadas = fs.readFileSync(log, 'utf8');
  assert.match(llamadas, /^install --save-dev @playwright\/test$/m);
  assert.match(llamadas, /^npx playwright install chromium$/m);
  const spec = fs.readFileSync(path.join(repo, 'tests', 'e2e', '1.1.spec.ts'), 'utf8');
  assert.match(spec, /@story-1\.1/);
  assert.match(fs.readFileSync(path.join(repo, 'playwright.config.ts'), 'utf8'), /servidor\.mjs frontend 4173/);
  assert.ok(fs.existsSync(path.join(repo, 'tests', 'e2e', 'servidor.mjs')));
  assert.match(fs.readFileSync(path.join(repo, '.tycon', 'advisors.yaml'), 'utf8'), /^e2e:\n {2}frontend_dir: \.$/m);
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, '.tycon', 'e2e-setup.json'), 'utf8')).installed, true);
  assert.equal(require(path.join(SCRIPTS, 'pipeline.js')).e2eConfig(repo).gate, path.join(SCRIPTS, 'e2e-gate.sh'));
  assert.equal(bt.repoReady(repo).ready, true);
  assert.match(gatesDe(home), /"name":"browser-test-prepared"[^\n]*"story":"1\.1"/);
  // el control de dependencias nuevas no le vuelve a preguntar a la persona por Playwright (medido en el laboratorio)
  const dg = spawnSync('node', [path.join(SCRIPTS, 'pipeline.js'), 'dep-gate', '--repo', repo, '--story', story], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  const gate = JSON.parse(dg.stdout);
  assert.equal(gate.gate, 'pass', dg.stdout);
  assert.ok(gate.declared.includes('@playwright/test'), dg.stdout);
});

test('Prepare_CitaAjena_NoPreparaNada @story-8.67 @ac-3', () => {
  const home = tmp('bt-home-');
  const { bin, log } = binariosSimulados();
  const { repo, story } = tienda();
  // la cita llega en un mensaje de otra sesión que la organización no declara como relevo, o la escribió el agente
  conversacion(home, 's-ajena', { otra: [['otra', 'sí, preparala']], agente: ['sí, preparala'] });
  const args = ['prepare', '--repo', repo, '--story', story, '--approved-by', 'Dev', '--ok', 'sí, preparala'];
  const r = setup(home, 's-ajena', repo, args, bin);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /no la encontré en un mensaje escrito por Dev/);
  const rel = setup(home, 's-ajena', repo, [...args, '--relayed-by', 'otra'], bin);
  assert.equal(rel.status, 2);
  assert.match(rel.stderr, /no declara ninguna sesión que pueda reenviar|no es la que la organización deja reenviar/);
  // el agente no es una persona
  conversacion(home, 's-ajena', { persona: ['sí, preparala'] });
  const ag = setup(home, 's-ajena', repo, ['prepare', '--repo', repo, '--story', story, '--approved-by', 'orquestador', '--ok', 'sí, preparala'], bin);
  assert.equal(ag.status, 2);
  assert.equal(fs.existsSync(log), false);
  assert.equal(fs.existsSync(path.join(repo, 'playwright.config.ts')), false);
  assert.equal(fs.existsSync(path.join(repo, '.tycon')), false);
});

test('Prepare_Windows_LlamaPorLaConsola @story-8.67 @ac-3', () => {
  const setupMod = require(path.join(SCRIPTS, 'e2e-setup.js'));
  assert.deepEqual(setupMod.runner('win32'), { shell: true });
  assert.deepEqual(setupMod.runner('darwin'), { shell: false });
  assert.deepEqual(setupMod.runner('linux'), { shell: false });
  assert.match(setupMod.browserDir({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, home: 'C:\\Users\\a' }), /ms-playwright$/);
  assert.equal(setupMod.browserDir({ platform: 'darwin', env: {}, home: '/Users/a' }), path.join('/Users/a', 'Library', 'Caches', 'ms-playwright'));
  assert.equal(setupMod.browserDir({ platform: 'linux', env: { PLAYWRIGHT_BROWSERS_PATH: '/opt/pw' }, home: '/home/a' }), '/opt/pw');
});

test('Undo_DejaElRepoComoEstaba_YCuidaLoCambiado @story-8.67 @ac-4', () => {
  const home = tmp('bt-home-');
  const { bin, log } = binariosSimulados();
  const vacio = tienda();
  const nada = setup(home, 's-undo', vacio.repo, ['undo', '--repo', vacio.repo], bin);
  assert.equal(nada.status, 1);
  assert.match(nada.stdout + nada.stderr, /No hay una preparación anotada/);

  const { repo, story } = tienda();
  conversacion(home, 's-undo', { persona: ['sí, preparala'] });
  assert.equal(setup(home, 's-undo', repo, ['prepare', '--repo', repo, '--story', story, '--approved-by', 'Dev', '--ok', 'sí, preparala'], bin).status, 0);
  fs.appendFileSync(path.join(repo, 'tests', 'e2e', '1.1.spec.ts'), '// el criterio 1\n');
  const u = setup(home, 's-undo', repo, ['undo', '--repo', repo], bin);
  assert.equal(u.status, 0, u.stderr);
  assert.match(fs.readFileSync(log, 'utf8'), /^uninstall --save-dev @playwright\/test$/m);
  assert.equal(fs.existsSync(path.join(repo, 'playwright.config.ts')), false);
  assert.equal(fs.existsSync(path.join(repo, 'tests', 'e2e', 'servidor.mjs')), false);
  assert.equal(fs.existsSync(path.join(repo, 'tests', 'e2e', '1.1.spec.ts')), true);
  assert.match(u.stdout, /tests\/e2e\/1\.1\.spec\.ts/);
  assert.match(u.stdout, /ms-playwright/);
  assert.equal(fs.existsSync(path.join(repo, '.tycon', 'advisors.yaml')), false);
  assert.equal(fs.existsSync(path.join(repo, '.tycon', 'e2e-setup.json')), false);
  assert.doesNotMatch(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'), /playwright/);
  assert.equal(bt.repoReady(repo).ready, false);
});

test('Rutas_SiempreDentroDelRepo @story-8.67 @ac-4', async () => {
  const home = tmp('bt-home-');
  const { bin, log } = binariosSimulados();
  const { repo, story } = tienda();
  // un .tycon/e2e-setup.json que nombra algo fuera del repo: undo no toca nada
  const victima = path.join(path.dirname(repo), 'ajeno.txt');
  fs.writeFileSync(victima, '');
  fs.mkdirSync(path.join(repo, '.tycon'));
  fs.writeFileSync(path.join(repo, '.tycon', 'e2e-setup.json'), JSON.stringify({ pkgDir: '..', installed: true, files: [{ path: '../ajeno.txt', sha: require('crypto').createHash('sha256').update('').digest('hex') }] }));
  const u = setup(home, 's-rutas', repo, ['undo', '--repo', repo], bin);
  assert.equal(u.status, 1);
  assert.match(u.stderr, /fuera del repo/);
  assert.ok(fs.existsSync(victima));
  assert.equal(fs.existsSync(log), false);
  fs.rmSync(path.join(repo, '.tycon'), { recursive: true });
  // una historia fuera del repo: ni prepare ni defer la tocan
  const afuera = path.join(path.dirname(repo), 'otra.md');
  fs.writeFileSync(afuera, '---\nstory: "1.1"\n---\n');
  conversacion(home, 's-rutas', { persona: ['no, por ahora no'] });
  for (const cmd of [['defer', '--no', 'no, por ahora no'], ['prepare', '--ok', 'no, por ahora no']]) {
    const r = setup(home, 's-rutas', repo, [cmd[0], '--repo', repo, '--story', afuera, '--approved-by', 'Dev', cmd[1], cmd[2]], bin);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /no está dentro del repo/);
  }
  assert.equal(fs.readFileSync(afuera, 'utf8'), '---\nstory: "1.1"\n---\n');
  // un número de historia que no sirve de nombre de archivo: no prepara
  fs.writeFileSync(story, fs.readFileSync(story, 'utf8').replace('story: "1.1"', 'story: "../../x"'));
  conversacion(home, 's-rutas', { persona: ['sí, preparala'] });
  const mal = setup(home, 's-rutas', repo, ['prepare', '--repo', repo, '--story', story, '--approved-by', 'Dev', '--ok', 'sí, preparala'], bin);
  assert.equal(mal.status, 2, mal.stderr);
  assert.equal(fs.existsSync(path.join(path.dirname(repo), 'x.spec.ts')), false);
  // el servidor de la página no sirve nada fuera de su carpeta
  const servidor = tmp('bt-srv-');
  fs.mkdirSync(path.join(servidor, 'tests', 'e2e'), { recursive: true });
  fs.mkdirSync(path.join(servidor, 'frontend'));
  fs.mkdirSync(path.join(servidor, 'frontend-secreto'));
  fs.writeFileSync(path.join(servidor, 'frontend', 'index.html'), 'hola');
  fs.writeFileSync(path.join(servidor, 'frontend-secreto', 'x.txt'), 'secreto');
  const texto = fs.readFileSync(path.join(SCRIPTS, 'e2e-setup.js'), 'utf8').match(/const TEXTO_SERVIDOR = \[([\s\S]*?)\]\.join/)[1];
  // eslint-disable-next-line no-new-func
  fs.writeFileSync(path.join(servidor, 'tests', 'e2e', 'servidor.mjs'), new Function(`return [${texto}].join('\\n');`)());
  const puerto = 41000 + Math.floor(Math.random() * 2000);
  const hijo = spawn('node', ['tests/e2e/servidor.mjs', 'frontend', String(puerto)], { cwd: servidor, stdio: 'ignore' });
  try {
    const pedir = (ruta) => new Promise((ok) => {
      const intento = (n) => http.get({ host: '127.0.0.1', port: puerto, path: ruta }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => ok({ code: res.statusCode, body: b })); })
        .on('error', () => (n > 0 ? setTimeout(() => intento(n - 1), 100) : ok({ code: 0, body: '' })));
      intento(30);
    });
    assert.equal((await pedir('/')).body, 'hola');
    assert.notEqual((await pedir('/..%2ffrontend-secreto/x.txt')).body, 'secreto');
    assert.equal((await pedir('/%E0%A4%A')).code, 400);
  } finally { hijo.kill(); }
});

test('Defer_ConElNoDespuesDeLaOferta_DeudaConNombre @story-8.67 @ac-5', () => {
  const home = tmp('bt-home-');
  const { bin } = binariosSimulados();
  // sin oferta mostrada: el no no vale
  const a = tienda();
  conversacion(home, 's-sinof', { persona: ['no, por ahora no'] });
  const sinOferta = setup(home, 's-sinof', a.repo, ['defer', '--repo', a.repo, '--story', a.story, '--approved-by', 'Dev', '--no', 'no, por ahora no'], bin);
  assert.equal(sinOferta.status, 2);
  assert.match(sinOferta.stderr, /sin la oferta, el «no» no vale/);
  // una respuesta de antes de la oferta: no vale
  const b = tienda();
  hasta3(home, 's-antes', b.repo, b.story);
  conversacion(home, 's-antes', { persona: ['no, por ahora no'], cuando: '2026-01-01T00:00:00Z' });
  puertaBash(home, 's-antes', b.repo, cierre3);
  const antes = setup(home, 's-antes', b.repo, ['defer', '--repo', b.repo, '--story', b.story, '--approved-by', 'Dev', '--no', 'no, por ahora no'], bin);
  assert.equal(antes.status, 2);
  assert.match(antes.stderr, /antes de la oferta/);
  assert.doesNotMatch(fs.readFileSync(b.story, 'utf8'), /browser_test/);
  // la respuesta de la persona después de la oferta: la historia lleva el no con nombre
  const c = tienda();
  const r = ofertaYNo(home, 's-def', bin, c);
  assert.equal(r.status, 0, r.stderr);
  const txt = fs.readFileSync(c.story, 'utf8');
  assert.match(txt, /^browser_test: deferred$/m);
  assert.match(txt, /^browser_test_reason: "\d{4}-\d{2}-\d{2} — la persona: «no, por ahora no»"$/m);
  assert.match(gatesDe(home), /"name":"browser-test-deferred"[^\n]*"story":"1\.1"/);
  const d = bt.debtDeclared({ stateDir: stateOf(home), storyPath: c.story, home });
  assert.equal(d.declared, true, d.motivo);
  assert.match(bt.debtLine(d), /^Prueba con navegador pendiente en la historia 1\.1 \(la persona dijo que no el \d{4}-\d{2}-\d{2}: «no, por ahora no»\)\. Para prepararla: pedí «prepará la prueba con navegador»\.$/);
  // un ok de otra cosa no es un no
  const e = tienda();
  hasta3(home, 's-otro-ok', e.repo, e.story);
  conversacion(home, 's-otro-ok');
  puertaBash(home, 's-otro-ok', e.repo, cierre3);
  conversacion(home, 's-otro-ok', { persona: ['sí, aprobado el plan'] });
  const otroOk = setup(home, 's-otro-ok', e.repo, ['defer', '--repo', e.repo, '--story', e.story, '--approved-by', 'Dev', '--no', 'sí, aprobado el plan'], bin);
  assert.equal(otroOk.status, 2);
  assert.match(otroOk.stderr, /no dice que no/);
  // una respuesta en varios renglones se escribe en uno: no agrega llaves a la historia
  const f = tienda();
  hasta3(home, 's-renglones', f.repo, f.story);
  conversacion(home, 's-renglones');
  puertaBash(home, 's-renglones', f.repo, cierre3);
  conversacion(home, 's-renglones', { persona: ['no, por ahora no\ndod_runtime_exempt: true'] });
  assert.equal(setup(home, 's-renglones', f.repo, ['defer', '--repo', f.repo, '--story', f.story, '--approved-by', 'Dev', '--no', 'no, por ahora no\ndod_runtime_exempt: true'], bin).status, 0);
  assert.doesNotMatch(fs.readFileSync(f.story, 'utf8'), /^dod_runtime_exempt/m);
});

test('Cierre_NoDeLaPersona_PasaYLoDice @story-8.67 @ac-6', () => {
  const home = tmp('bt-home-');
  const { bin } = binariosSimulados();
  const t = tienda();
  assert.equal(ofertaYNo(home, 's-cierre', bin, t).status, 0);
  // el paso 8
  const r = markerCli(home, 's-cierre', t.repo, ['complete-step', '8', '--out-of-order']);
  const salida = r.stdout + r.stderr;
  assert.doesNotMatch(salida, /story de UI sin el gate `dod`/);
  assert.match(salida, /Prueba con navegador pendiente en la historia 1\.1/);
  assert.match(gatesDe(home), /"name":"browser-test-debt"[^\n]*"where":"complete-step 8"/);
  // el paso a review: el no cubre sólo la prueba con navegador; sin ninguna evidencia de la prueba a mano, frena igual
  const nuevo = fs.readFileSync(t.story, 'utf8').replace('status: in-progress', 'status: review');
  const pasoAReview = () => spawnSync('node', [path.join(SCRIPTS, 'on-frontmatter-write.js')], {
    cwd: t.repo, encoding: 'utf8',
    input: JSON.stringify({ session_id: 's-cierre', tool_name: 'Write', cwd: t.repo, tool_input: { file_path: t.story, content: nuevo } }),
    // mide la evidencia, no el freno del estado a mano (8.109): ése se apaga en el ambiente del gancho
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: 's-cierre', TYCON_STATUS_GATE: 'off' },
  });
  assert.equal(pasoAReview().status, 2);
  fs.mkdirSync(path.join(t.repo, '.advisors', 'dod-runtime'), { recursive: true });
  fs.writeFileSync(path.join(t.repo, '.advisors', 'dod-runtime', '1.1-20261020T040000Z.md'), '# DoD Runtime Evidence — Story 1.1\n\nAC 1: probado a mano con la guía.\n');
  const fw = pasoAReview();
  assert.equal(fw.status, 0, fw.stderr);
  assert.match(fw.stderr, /Prueba con navegador pendiente en la historia 1\.1/);
  assert.match(gatesDe(home), /"name":"browser-test-debt"[^\n]*"where":"review"/);
  // el commit usa la misma comprobación
  assert.match(fs.readFileSync(path.join(SCRIPTS, 'on-pre-commit.js'), 'utf8'), /require\('\.\/lib\/browser-test\.js'\)\.debtDeclared\(/);
});

test('Cierre_SinElOkDeLaPersona_Frena @story-8.67 @ac-7', () => {
  const home = tmp('bt-home-');
  const stateDir = stateOf(home);
  const { bin } = binariosSimulados();
  // sin nada: frena como hoy
  const a = tienda();
  hasta3(home, 's-nada', a.repo, a.story);
  assert.match(markerCli(home, 's-nada', a.repo, ['complete-step', '8', '--out-of-order']).stderr, /story de UI sin el gate `dod`/);
  // sólo la marca de la historia, escrita a mano: frena
  const b = tienda();
  fs.writeFileSync(b.story, fs.readFileSync(b.story, 'utf8').replace('status: in-progress', 'status: in-progress\nbrowser_test: deferred\nbrowser_test_reason: "2026-10-20 — la persona: «no, por ahora no»"'));
  assert.equal(bt.debtDeclared({ stateDir, storyPath: b.story, home }).declared, false);
  hasta3(home, 's-marca', b.repo, b.story);
  assert.match(markerCli(home, 's-marca', b.repo, ['complete-step', '8', '--out-of-order']).stderr, /story de UI sin el gate `dod`/);
  // la marca y la constancia, pero la respuesta ya no está en la conversación: la constancia sola no alcanza
  const c = tienda();
  assert.equal(ofertaYNo(home, 's-borrada', bin, c).status, 0);
  conversacion(home, 's-borrada');
  const sinOk = bt.debtDeclared({ stateDir, storyPath: c.story, home });
  assert.equal(sinOk.declared, false);
  assert.match(sinOk.motivo, /no está en la conversación/);
  assert.match(markerCli(home, 's-borrada', c.repo, ['complete-step', '8', '--out-of-order']).stderr, /no está en la conversación/);
  // sin la conversación (otra máquina): no vale
  const d = tienda();
  assert.equal(ofertaYNo(home, 's-otra-maquina', bin, d).status, 0);
  fs.rmSync(path.join(home, '.claude', 'projects', '-tienda', 's-otra-maquina.jsonl'));
  assert.match(bt.debtDeclared({ stateDir, storyPath: d.story, home }).motivo, /no puedo leer la conversación/);
  // la marca con otra cita que la de la constancia: no vale
  const e = tienda();
  assert.equal(ofertaYNo(home, 's-cita', bin, e).status, 0);
  fs.writeFileSync(e.story, fs.readFileSync(e.story, 'utf8').replace('«no, por ahora no»', '«no la quiero nunca»'));
  assert.equal(bt.debtDeclared({ stateDir, storyPath: e.story, home }).declared, false);
  // con el repo ya preparado, el no deja de valer: la prueba se corre
  const f = tienda();
  assert.equal(ofertaYNo(home, 's-listo', bin, f).status, 0);
  fs.mkdirSync(path.join(f.repo, '.tycon'), { recursive: true });
  fs.writeFileSync(path.join(f.repo, '.tycon', 'advisors.yaml'), 'e2e:\n  frontend_dir: .\n');
  fs.mkdirSync(path.join(f.repo, 'node_modules', '@playwright', 'test'), { recursive: true });
  fs.writeFileSync(path.join(f.repo, 'node_modules', '@playwright', 'test', 'package.json'), '{}');
  assert.match(bt.debtDeclared({ stateDir, storyPath: f.story, home }).motivo, /se corre, no se exime/);
});

test('Regresion_PaseAdversarial_CitaConDolarNumeroYCarpetaRaros @story-8.67 @ac-2 @ac-4 @ac-5', () => {
  const home = tmp('bt-home-');
  const { bin } = binariosSimulados();
  // una respuesta con `$&` o `$$` se escribe tal cual en la historia y el no vale
  const t = tienda();
  hasta3(home, 's-dolar', t.repo, t.story);
  conversacion(home, 's-dolar');
  puertaBash(home, 's-dolar', t.repo, cierre3);
  const cita = 'no, por ahora no: cuesta $$ y $& no';
  conversacion(home, 's-dolar', { persona: [cita] });
  const r = setup(home, 's-dolar', t.repo, ['defer', '--repo', t.repo, '--story', t.story, '--approved-by', 'Dev', '--no', cita], bin);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.readFileSync(t.story, 'utf8').includes(`«${cita}»`));
  assert.equal(bt.debtDeclared({ stateDir: stateOf(home), storyPath: t.story, home }).declared, true);
  // un número de historia que no sirve de nombre de archivo: no se ofrece lo que no se puede preparar
  const raro = tienda();
  fs.writeFileSync(raro.story, fs.readFileSync(raro.story, 'utf8').replace('story: "1.1"', 'story: "1.1 b"'));
  hasta3(home, 's-raro', raro.repo, raro.story, '1.1 b');
  conversacion(home, 's-raro');
  assert.equal(puertaBash(home, 's-raro', raro.repo, cierre3).stdout.trim(), '');
  // un package.json en una carpeta con espacios: no se escribe un bloque e2e: que el lector cortaría
  const esp = tienda();
  fs.mkdirSync(path.join(esp.repo, 'mi app', 'web', 'src'), { recursive: true });
  fs.writeFileSync(path.join(esp.repo, 'mi app', 'package.json'), '{"name":"x"}\n');
  fs.writeFileSync(path.join(esp.repo, 'mi app', 'web', 'index.html'), 'hola');
  fs.writeFileSync(path.join(esp.repo, 'mi app', 'web', 'src', 'a.js'), '');
  fs.writeFileSync(esp.story, fs.readFileSync(esp.story, 'utf8').replace('frontend/src/main.js', '"mi app/web/src/a.js"'));
  conversacion(home, 's-esp', { persona: ['sí, preparala'] });
  const p = setup(home, 's-esp', esp.repo, ['prepare', '--repo', esp.repo, '--story', esp.story, '--approved-by', 'Dev', '--ok', 'sí, preparala'], bin);
  assert.equal(p.status, 2, p.stderr + p.stdout);
  assert.equal(fs.existsSync(path.join(esp.repo, '.tycon', 'advisors.yaml')), false);
});

test('Instrucciones_PasoTresSieteYGuia_DicenLaOfertaYComoSeDeshace @story-8.67 @ac-8', () => {
  const paso3 = fs.readFileSync(path.join(STEPS, 'step-04-approve-plan.md'), 'utf8');
  assert.match(paso3, /e2e-setup\.js prepare[^\n]*--ok/);
  assert.match(paso3, /e2e-setup\.js defer[^\n]*--no/);
  assert.match(paso3, /la muestra el arnés/);
  const paso7c = fs.readFileSync(path.join(STEPS, 'step-10-live-check.md'), 'utf8');
  assert.match(paso7c, /browser_test: deferred/);
  assert.match(paso7c, /e2e-setup\.js prepare/);
  for (const g of ['reference.es.md', 'reference.md']) {
    assert.match(fs.readFileSync(path.join(HARNESS, 'getting-started', g), 'utf8'), /e2e-setup\.js undo/, g);
  }
});
