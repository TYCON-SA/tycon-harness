'use strict';
/**
 * manual-checks.test.js — una persona marca cada criterio de la guía como probado a mano.
 *
 * Con la opción de la organización prendida (`qa.manual_check: required`, sólo desde el perfil del equipo), el arnés le
 * muestra a la persona qué criterios va a marcar (la puerta Bash antes de `marker.js mark-tested`, o el despachador de
 * ediciones al escribir `marca-pedida.json`) y deja la constancia `manual-check-shown`. La marca vale si la persona
 * contesta después nombrando cada criterio; un reenvío de otra sesión no marca. El cierre frena con lo que falta.
 *
 * El arnés se copia a una carpeta propia con su perfil del equipo: la opción se lee del perfil del árbol, nunca de una
 * variable. 0 deps (node:test).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REAL = path.join(__dirname, '..', '..', '..', '..');
const { conVentana } = require(path.join(REAL, 'scripts', 'tests', 'lib', 'window-passed.js'));
// stable-data: las horas de la conversación van después de la muestra, que se anota con el reloj real
const T = (seg) => new Date(Date.now() + 60000 + seg * 1000).toISOString();
function tmp(prefijo) { return fs.mkdtempSync(path.join(os.tmpdir(), prefijo)); }
const GIT_ENV = { ...process.env, GIT_AUTHOR_DATE: '2026-10-20T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-20T12:00:00Z' };

// El arnés copiado una vez: el pipeline y el lector de configuración, sin las pruebas.
const ARNES = (() => {
  const d = tmp('mc-arnes-');
  fs.cpSync(path.join(REAL, 'skills', 'tycon-pipeline'), path.join(d, 'skills', 'tycon-pipeline'), { recursive: true, filter: (src) => !/[\\/]tests([\\/]|$)/.test(src) });
  fs.cpSync(path.join(REAL, 'scripts', 'lib'), path.join(d, 'scripts', 'lib'), { recursive: true });
  return d;
})();
const SCRIPTS = path.join(ARNES, 'skills', 'tycon-pipeline', 'scripts');
const MARKER = path.join(SCRIPTS, 'marker.js');
const MC = () => require(path.join(SCRIPTS, 'lib', 'manual-checks.js'));
const perfil = (datos) => {
  const f = path.join(ARNES, 'team-profile.json');
  if (datos === null) fs.rmSync(f, { force: true }); else fs.writeFileSync(f, JSON.stringify(datos));
};

const STORY = [
  '---', 'story: "9.94"', 'title: "juguete"', 'status: in-progress', 'files_to_modify:', '  - src/Lista.tsx', '---', '',
  '# Story 9.94', '', '## Acceptance Criteria', '',
  '1. Desde la lista, el botón «Cancelar» pide confirmación y el pedido queda cancelado.',
  '2. Un pedido ya despachado no muestra el botón «Cancelar».',
  '3. La cancelación queda anotada en el historial del pedido.', '',
].join('\n');

function laboratorio({ sid = 's-mc', opcion = 'required' } = {}) {
  perfil(opcion ? { qa: { manual_check: opcion } } : null);
  const base = tmp('mc-');
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'));
  fs.mkdirSync(home);
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { stdio: 'ignore', env: GIT_ENV });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  const story = path.join(repo, 'specs', 'story-9.94-juguete.md');
  fs.writeFileSync(story, STORY);
  fs.writeFileSync(path.join(repo, 'src', 'Lista.tsx'), 'export const Lista = () => null;\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0', TYCON_PROFILE: '0' };
  delete env.TYCON_HOME;
  const marker = (args, extra = {}, { ventana = true } = {}) => spawnSync(process.execPath, [MARKER, ...args], { cwd: repo, encoding: 'utf8', env: ventana ? conVentana({ ...env, ...extra }) : { ...env, ...extra }, detached: true });
  const set = marker(['set', JSON.stringify({ storyId: '9.94', storyPath: story, repoPath: repo })]);
  assert.equal(set.status, 0, set.stderr);
  const runDir = require(path.join(SCRIPTS, 'pipeline.js')).resolveRunDir(repo, '9.94', true, story);
  const stateDir = path.join(home, '.claude', '.tycon-pipeline');
  const lab = { base, repo, home, story, sid, env, marker, runDir, stateDir };
  lab.conversar = (regs) => escribirConversacion(home, sid, regs);
  lab.conversar([delAgente('Probá los criterios a mano.', new Date().toISOString())]);
  return lab;
}
function escribirConversacion(home, sid, registros) {
  const dir = path.join(home, '.claude', 'projects', '-repo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), registros.map((r) => JSON.stringify(r)).join('\n') + (registros.length ? '\n' : ''));
}
const delDev = (texto, ts = T(1)) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: texto } });
const delAgente = (texto, ts = T(0)) => ({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: texto }] } });
const deOtraSesion = (nombre, texto, ts = T(5)) => ({
  ...delDev(`Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/x.sock" from-name="${nombre}" from-mode="bypass">\n${texto}\n</cross-session-message>`, ts),
  isMeta: true, promptSource: 'system', origin: { kind: 'peer', from: 'uds:/tmp/x.sock', name: nombre, body: texto },
});

const comando = (acs, extra = '') => `node ${MARKER} mark-tested --acs ${acs}${extra}`;
function puertaBash(lab, command) {
  return spawnSync('node', [path.join(SCRIPTS, 'on-bash-write-gate.js')], {
    cwd: lab.repo, encoding: 'utf8',
    input: JSON.stringify({ session_id: lab.sid, tool_name: 'Bash', cwd: lab.repo, tool_input: { command } }),
    env: lab.env,
  });
}
function despachar(lab, file_path, content) {
  return spawnSync('node', [path.join(SCRIPTS, 'hook-post-edit.js')], {
    cwd: lab.repo, encoding: 'utf8',
    input: JSON.stringify({ session_id: lab.sid, tool_name: 'Write', cwd: lab.repo, tool_input: { file_path, content } }),
    env: lab.env,
  });
}
const mostrar = (lab, acs) => {
  const p = puertaBash(lab, comando(acs));
  assert.equal(p.status, 0, p.stderr);
  return p.stdout.trim() ? JSON.parse(p.stdout).systemMessage : '';
};
const marcar = (lab, acs, extra = [], opts = {}) => lab.marker(['mark-tested', '--acs', acs, '--approved-by', 'Dev de Prueba', ...extra], {}, opts);
const lineas = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const marcas = (lab) => lineas(path.join(lab.runDir, 'manual-checks.jsonl'));
const gates = (lab) => lineas(path.join(lab.stateDir, 'gates.log'));
const cierre = (lab) => MC().freno({ storyPath: lab.story, storyId: '9.94', runDir: lab.runDir, stateDir: lab.stateDir, esPantalla: true });

test('ManualChecks_ClaveRota_SeTrataComoPrendida @story-7.46 @ac-8', () => {
  perfil({ qa: { manual_check: 3 } });
  const r = MC().prendida({ home: tmp('mc-home-') });
  assert.equal(r.prendida, true);
  assert.match(r.motivo, /configuración/);
  perfil({ qa: { manual_check: 'required' } });
  assert.deepEqual(MC().prendida({ home: tmp('mc-home-') }), { prendida: true });
  perfil(null);
  assert.deepEqual(MC().prendida({ home: tmp('mc-home-') }), { prendida: false });
});

test('ManualChecks_PuertaBashLaMuestra @story-7.46 @ac-9', () => {
  const lab = laboratorio();
  const msg = mostrar(lab, '2');
  assert.match(msg, /Vas a marcar como probado a mano, en la historia 9\.94:/);
  assert.match(msg, /Criterio 2 — Un pedido ya despachado no muestra el botón «Cancelar»\./);
  assert.match(msg, /contestá nombrándolo: «probé a mano el criterio 2»/);
  const g = gates(lab).filter((x) => x.name === 'manual-check-shown');
  assert.equal(g.length, 1);
  assert.deepEqual([g[0].story, g[0].acs, g[0].sessionId], ['9.94', [2], lab.sid]);
  // ya mostrado: no se repite
  assert.equal(mostrar(lab, '2'), '');
  // con --terminal: no se muestra (la persona lo ve en su terminal)
  assert.equal(puertaBash(lab, comando('3', ' --terminal')).stdout.trim(), '');
  // sin conversación legible: ni muestra ni constancia
  const sin = laboratorio({ sid: 's-mc-sin' });
  fs.rmSync(path.join(sin.home, '.claude', 'projects'), { recursive: true, force: true });
  assert.equal(mostrar(sin, '2'), '');
  assert.equal(gates(sin).filter((x) => x.name === 'manual-check-shown').length, 0);
});

test('ManualChecks_InstalacionMinima_AlEscribirElPedido @story-7.46 @ac-9', () => {
  const lab = laboratorio();
  const pedido = path.join(lab.runDir, 'marca-pedida.json');
  fs.writeFileSync(pedido, JSON.stringify({ acs: [1, 2] }));
  const d = despachar(lab, pedido, JSON.stringify({ acs: [1, 2] }));
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /Vas a marcar como probado a mano/);
  assert.match(d.stdout, /Criterio 1 — /);
  assert.equal(gates(lab).filter((x) => x.name === 'manual-check-shown').length, 1);
  // el mismo nombre fuera de la carpeta de la corrida: nada
  const otro = path.join(lab.repo, 'marca-pedida.json');
  fs.writeFileSync(otro, JSON.stringify({ acs: [3] }));
  const n = despachar(lab, otro, JSON.stringify({ acs: [3] }));
  assert.doesNotMatch(n.stdout, /Vas a marcar/);
  assert.equal(gates(lab).filter((x) => x.name === 'manual-check-shown').length, 1);
});

test('ManualChecks_OkQueNombra_Marca @story-7.46 @ac-10', () => {
  const lab = laboratorio();
  const r = marcar(lab, '2,3');
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /Criterios 2, 3 marcados como probados a mano por Dev de Prueba/);
  const m = marcas(lab);
  assert.deepEqual(m.map((x) => x.ac), [2, 3]);
  assert.ok(m.every((x) => x.quien === 'Dev de Prueba' && x.via === 'ventana' && !('cita' in x) && x.story === '9.94'));
  assert.equal(gates(lab).filter((x) => x.name === 'manual-check').length, 2);
  const firma = gates(lab).filter((x) => x.name === 'manual-test-signed');
  assert.equal(firma.length, 1);
  assert.deepEqual([firma[0].via, firma[0].destino], ['ventana', lab.sid]);
});

test('ManualChecks_Rechazos @story-7.46 @ac-11', () => {
  // sin la ventana: no marca, aunque la persona lo haya escrito en el chat
  let lab = laboratorio();
  mostrar(lab, '2');
  lab.conversar([delDev('probé a mano el criterio 2')]);
  let r = marcar(lab, '2', [], { ventana: false });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /no pasó por la ventana/);
  assert.match(r.stderr, /--terminal/);
  assert.equal(marcas(lab).length, 0);
  // la cita ya no firma, ni con la ventana
  lab = laboratorio({ sid: 's-mc-cita' });
  mostrar(lab, '2');
  lab.conversar([delDev('probé a mano el criterio 2')]);
  r = marcar(lab, '2', ['--quote', 'probé a mano el criterio 2']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /la cita o el reenvío ya no firman/);
  assert.equal(marcas(lab).length, 0);
  // quien aprueba tiene que ser una persona
  lab = laboratorio({ sid: 's-mc-agente' });
  r = lab.marker(['mark-tested', '--acs', '2', '--approved-by', 'Claude']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /no se marcó nada/);
  assert.equal(marcas(lab).length, 0);
  // reenvío de la sesión que la organización declara: no marca
  lab = laboratorio({ sid: 's-mc-rel' });
  perfil({ qa: { manual_check: 'required' }, approvals: { relay_session: 'coordinadora' } });
  mostrar(lab, '2');
  lab.conversar([deOtraSesion('coordinadora', 'probé a mano el criterio 2')]);
  r = marcar(lab, '2', ['--relayed-by', 'coordinadora']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /la prueba a mano la marca la persona que probó; un reenvío no la marca/);
  assert.equal(marcas(lab).length, 0);
});

test('ManualChecks_JuezLeeRespuestasDeVerdad @story-7.46 @ac-10 @ac-11 — lo que escribe una persona, no sólo la frase del bloque', () => {
  const marca = (acs, t) => MC().juez(acs)(t) === null;
  // nombra todos los criterios, con la puntuación de verdad
  assert.ok(marca([2, 3, 4], 'probé a mano los criterios 2, 3, y 4'));
  assert.ok(marca([2, 3], 'probé a mano el criterio 2 y el 3'));
  assert.ok(marca([1, 2, 3], 'probé a mano los criterios 1, 2 y 3'));
  // una negación que no es de la prueba no la tumba
  assert.ok(marca([2], 'probé a mano el criterio 2 sin problemas'));
  assert.ok(marca([2], 'probé a mano el criterio 2, no hubo problemas'));
  assert.ok(marca([2], 'probé a mano el criterio 2; nunca falló'));
  assert.ok(marca([2], 'probé a mano el criterio 2, tampoco tuve dudas'));
  // lo que sigue sin marcar: no lo probó, falló, falta, genérico, otro criterio
  for (const t of ['no lo probé, el criterio 2', 'el criterio 2 no lo probé a mano', 'probé a mano el criterio 2 y falló', 'falta probar a mano el criterio 2', 'sin probar el criterio 2', 'dale, seguí adelante', 'probé a mano el criterio 3', 'el criterio 2 no anda, lo probé a mano', 'no marques el criterio 2 a mano', 'el criterio 2 a mano, después vemos']) {
    assert.equal(marca([2], t), false, t);
  }
});

test('ManualChecks_Apagada_NoAnota @story-7.46 @ac-11', () => {
  const lab = laboratorio({ opcion: null });
  lab.conversar([delDev('probé a mano el criterio 2')]);
  const r = marcar(lab, '2');
  assert.equal(r.status, 0, r.stderr);
  assert.match(`${r.stdout}${r.stderr}`, /tu organización no pide la marca a mano; no anoté nada/);
  assert.equal(marcas(lab).length, 0);
});

test('ManualChecks_Cierre_FrenaConLoQueFalta @story-7.46 @ac-13', () => {
  const lab = laboratorio();
  mostrar(lab, '1,3');
  lab.conversar([delDev('probé a mano los criterios 1 y 3')]);
  assert.equal(marcar(lab, '1,3').status, 0);
  const f = cierre(lab);
  assert.equal(f.status, 'blocked');
  assert.deepEqual(f.faltan, [2]);
  assert.match(f.mensaje.join('\n'), /Tu organización pide que una persona marque cada criterio como probado a mano\. Falta: criterio 2 — Un pedido ya despachado/);
  // el freno vive en complete-step 8, después de la guía, y no tiene escape por DOD_BYPASS
  const src = fs.readFileSync(path.join(REAL, 'skills', 'tycon-pipeline', 'scripts', 'marker.js'), 'utf8');
  const i = src.indexOf("blocked = 'manualcheck'");
  assert.ok(i > src.indexOf("blocked = 'qaguide'"), 'el bloque está después del de la guía');
  assert.ok(/String\(blocked\)\.startsWith\('acmatrix'\) \|\| blocked === 'qaguide' \|\| blocked === 'manualcheck'/.test(src), 'manualcheck está entre los bloqueos sin DOD_BYPASS');
});

test('ManualChecks_Cierre_PasaYMarcaAMano @story-7.46 @ac-14', () => {
  const lab = laboratorio();
  mostrar(lab, '1,2,3');
  lab.conversar([delDev('probé a mano los criterios 1, 2 y 3')]);
  assert.equal(marcar(lab, '1,2,3').status, 0);
  assert.equal(cierre(lab).status, 'ok');
  assert.equal(MC().freno({ storyPath: lab.story, storyId: '9.94', runDir: lab.runDir, stateDir: lab.stateDir, esPantalla: false }).status, 'no-ui');
  perfil(null);
  assert.equal(cierre(lab).status, 'off');
  // un renglón escrito a mano, sin su par en el registro del arnés, no cuenta y se nombra
  const otro = laboratorio({ sid: 's-mc-mano' });
  fs.writeFileSync(path.join(otro.runDir, 'manual-checks.jsonl'), [1, 2, 3].map((ac) => JSON.stringify({ ac, story: '9.94', quien: 'Dev', cita: 'probé', via: 'ok de la persona en el chat', ts: new Date().toISOString() })).join('\n') + '\n');
  const f = cierre(otro);
  assert.equal(f.status, 'blocked');
  assert.deepEqual(f.faltan, [1, 2, 3]);
  assert.match(f.mensaje.join('\n'), /marca sin muestra previa, no cuenta/);
});

test('ManualChecks_Cierre_SinCriteriosFrena @story-7.46 @ac-13 — una historia sin criterios legibles no pasa sin marca', () => {
  const lab = laboratorio({ sid: 's-mc-sin-crit' });
  fs.writeFileSync(lab.story, ['---', 'story: "9.94"', 'title: "juguete"', 'status: in-progress', '---', '', '# Story 9.94', '', 'Sin criterios.', ''].join('\n'));
  const f = cierre(lab);
  assert.equal(f.status, 'blocked');
  assert.match(f.mensaje.join('\n'), /no encontré criterios en la historia para marcar/);
});

test('ManualChecks_NoRegresion_ApagadaCierraComoHoy @story-7.46 @ac-17', () => {
  const lab = laboratorio({ opcion: 'off' });
  assert.equal(cierre(lab).status, 'off');
  assert.deepEqual(MC().prendida({ home: lab.home }), { prendida: false });
  // waive-critical y runtime-waiver siguen como estaban: sus suites (critical-shown, critical-waiver) corren aparte; acá,
  // que mark-tested no les cambió la ayuda
  const ayuda = lab.marker(['waive-critical']);
  assert.equal(ayuda.status, 2);
  assert.match(ayuda.stderr, /faltan --rule <regla> y --reason/);
});
