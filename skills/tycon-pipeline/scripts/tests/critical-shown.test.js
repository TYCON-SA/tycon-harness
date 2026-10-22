'use strict';
/**
 * critical-shown.test.js — un crítico se exime con un ok que responde a ese crítico.
 *
 * El arnés le muestra a la persona el crítico que se quiere eximir (la puerta Bash antes de `marker.js waive-critical`,
 * o el despachador de ediciones al escribir `exencion-pedida.json`) y deja la constancia `critical-shown`. El ok vale
 * sólo si es posterior a esa muestra y dice que exime ese crítico (con su regla o su nombre en llano). Un «apruebo,
 * seguí» genérico no exime nada.
 *
 * Todo corre los comandos de verdad contra un HOME y un repo de juguete. 0 deps (node:test).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const MARKER = path.join(SCRIPTS, 'marker.js');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const REGLA = 'TEST-C1';
const ARCHIVO = '.advisors/tests-result.json';
const MOTIVO = 'test-gate.sh no reconoce pytest; la suite se corrió a mano: 12 pasaron';
// stable-data: las horas de la conversación van después de la muestra, que se anota con el reloj real
const T = (seg) => new Date(Date.now() + 60000 + seg * 1000).toISOString();

function tmp(prefijo) { return fs.mkdtempSync(path.join(os.tmpdir(), prefijo)); }
const GIT_ENV = { ...process.env, GIT_AUTHOR_DATE: '2026-10-20T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-20T12:00:00Z' };

// Un repo con una story, un marcador abierto, findings.json con los críticos dados, una HOME propia y la conversación.
function laboratorio({ sid = 's-cs', criticos = [{ rule_id: REGLA, file: ARCHIVO, summary: 'la suite completa no corrió' }] } = {}) {
  const base = tmp('cs-');
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(home);
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { stdio: 'ignore', env: GIT_ENV });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  const story = path.join(repo, 'specs', 'story-9.93-juguete.md');
  fs.writeFileSync(story, ['---', 'story: "9.93"', 'title: "juguete"', 'status: in-progress', 'files_to_modify:', '  - README.md', '---', '', '# Story 9.93', ''].join('\n'));
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0', TYCON_PROFILE: '0' };
  delete env.TYCON_HOME;
  const marker = (args) => spawnSync(process.execPath, [MARKER, ...args], { cwd: repo, encoding: 'utf8', env, detached: true });
  const set = marker(['set', JSON.stringify({ storyId: '9.93', storyPath: story, repoPath: repo })]);
  assert.equal(set.status, 0, set.stderr);
  const runDir = require(PIPELINE).resolveRunDir(repo, '9.93', true, story);
  fs.writeFileSync(path.join(runDir, 'findings.json'), JSON.stringify(criticos.map((c) => ({ severity: 'CRITICAL', advisor: 'tycon-plugin-tests-coverage', disposition: 'open', ...c }))));
  const lab = { base, repo, home, story, sid, env, marker, runDir };
  lab.conversar = (regs) => escribirConversacion(home, sid, regs);
  lab.conversar([delAgente('Hay un crítico abierto.', new Date().toISOString())]);
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
  isMeta: true, promptSource: 'system', origin: { kind: 'peer', from: 'uds:/tmp/x.sock', name: nombre, msg_id: 'm-1', body: texto },
});
// la sesión designada en la máquina: la frase del dev en su chat, el envío con el número del mensaje y el renglón del
// gates.log
function designarCoordinadora(home) {
  const frase = 'Esta sesión es la coordinadora';
  escribirConversacion(home, 's-coord', [delDev(frase, T(-50)), { type: 'user', timestamp: T(4), toolUseResult: { success: true, msg_id: 'm-1' },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'enviado' }] } }]);
  const st = require(path.join(SCRIPTS, 'lib', 'state-dir.js')).stateDir(home);
  fs.mkdirSync(st, { recursive: true });
  fs.appendFileSync(path.join(st, 'gates.log'), JSON.stringify({ name: 'relay-designation', status: 'ok', sesion: 's-coord', rol: 'coordinadora', quien: 'Dev de Prueba', cita: frase, ts: T(-49) }) + '\n');
}

const sh = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
const comando = (rule = REGLA, file = ARCHIVO, reason = MOTIVO, extra = '') => `node ${MARKER} waive-critical --rule ${rule} --file ${sh(file)} --reason ${sh(reason)}${extra}`;

/** La puerta Bash del portón de carril, como la corre Claude Code antes de un comando. */
function puertaBash(lab, command) {
  return spawnSync('node', [path.join(SCRIPTS, 'on-bash-write-gate.js')], {
    cwd: lab.repo, encoding: 'utf8',
    input: JSON.stringify({ session_id: lab.sid, tool_name: 'Bash', cwd: lab.repo, tool_input: { command } }),
    env: lab.env,
  });
}
/** El despachador de ediciones de la instalación mínima, después de un Write. */
function despachar(lab, file_path, content) {
  return spawnSync('node', [path.join(SCRIPTS, 'hook-post-edit.js')], {
    cwd: lab.repo, encoding: 'utf8',
    input: JSON.stringify({ session_id: lab.sid, tool_name: 'Write', cwd: lab.repo, tool_input: { file_path, content } }),
    env: lab.env,
  });
}
const mostrar = (lab, rule, file, reason) => {
  const p = puertaBash(lab, comando(rule, file, reason));
  assert.equal(p.status, 0, p.stderr);
  return p.stdout.trim() ? JSON.parse(p.stdout).systemMessage : '';
};
const waive = (lab, quote, { rule = REGLA, file = ARCHIVO, reason = MOTIVO } = {}) => lab.marker(['waive-critical', '--rule', rule, '--file', file, '--reason', reason, '--approved-by', 'Dev de Prueba', '--quote', quote]);
const lineas = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const eximidos = (lab) => lineas(path.join(lab.runDir, 'critical-waivers.jsonl'));
const gates = (lab) => lineas(path.join(lab.home, '.claude', '.tycon-pipeline', 'gates.log'));

test('CriticalShown_CasoReal_ApruebogenericoNoExime @story-8.71 @ac-7', () => {
  const lab = laboratorio();
  mostrar(lab);
  lab.conversar([delAgente('Un «apruebo» suelto no alcanza para eximir un crítico.'), delDev('apruebo, seguí')]);
  const r = waive(lab, 'apruebo, seguí');
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /no nombra este crítico/);
  assert.match(r.stderr, /TEST-C1/);
  assert.match(r.stderr, /la suite completa/);
  assert.equal(eximidos(lab).length, 0);
  assert.equal(gates(lab).filter((g) => g.name === 'critical-waiver').length, 0);
});

test('CriticalShown_SinMuestra_Frena @story-8.71 @ac-5', () => {
  const lab = laboratorio();
  lab.conversar([delDev('eximo TEST-C1, la corrí a mano')]);
  const r = waive(lab, 'eximo TEST-C1, la corrí a mano');
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /no se le mostró este crítico/);
  assert.match(r.stderr, /exencion-pedida\.json/);
  assert.equal(eximidos(lab).length, 0);
});

test('CriticalShown_OkAnterior_NoExime @story-8.71 @ac-6', () => {
  const lab = laboratorio();
  // el ok es de esta corrida, pero de antes de que el arnés le mostrara el crítico
  const antes = new Date().toISOString();
  const espera = Date.now() + 30; while (Date.now() < espera) { /* la muestra queda después */ }
  mostrar(lab);
  lab.conversar([delDev('eximo TEST-C1, dale', antes)]);
  const r = waive(lab, 'eximo TEST-C1, dale');
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /de antes de que se le mostrara este crítico/);
  assert.equal(eximidos(lab).length, 0);
});

test('CriticalShown_MotivoReescrito_ElOkSigueValiendo @story-8.86 @ac-1', () => {
  // se muestra el crítico, la persona contesta, y el agente corre waive-critical con el motivo dicho con otras palabras:
  // la puerta lo vuelve a mostrar, y el ok, que respondió a la primera muestra, sigue valiendo
  const lab = laboratorio();
  const esperar = () => { const fin = Date.now() + 30; while (Date.now() < fin) { /* horas distintas */ } };
  mostrar(lab, REGLA, ARCHIVO, 'tres suites rojas que fallan igual en main sin la story');
  esperar();
  const ok = new Date().toISOString();
  esperar();
  const corto = 'tres suites rojas previas';
  assert.match(mostrar(lab, REGLA, ARCHIVO, corto), /tres suites rojas previas/);
  lab.conversar([delDev('eximo TEST-C1, son previas', ok)]);
  const r = waive(lab, 'eximo TEST-C1, son previas', { reason: corto });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.equal(eximidos(lab).length, 1);
  // un ok de antes de la primera muestra sigue sin valer
  const b = laboratorio({ sid: 's-cs-mr' });
  const antes = new Date().toISOString();
  esperar();
  mostrar(b, REGLA, ARCHIVO, 'motivo largo');
  mostrar(b, REGLA, ARCHIVO, 'motivo corto');
  b.conversar([delDev('eximo TEST-C1, dale', antes)]);
  const rb = waive(b, 'eximo TEST-C1, dale', { reason: 'motivo corto' });
  assert.equal(rb.status, 1, `${rb.stdout}${rb.stderr}`);
  assert.match(rb.stderr, /de antes de que se le mostrara este crítico/);
});

test('CriticalShown_OkAOtroCritico_NoExime @story-8.71 @ac-7', () => {
  const lab = laboratorio();
  mostrar(lab);
  lab.conversar([delDev('eximo SEC-C2, es de prueba')]);
  const r = waive(lab, 'eximo SEC-C2, es de prueba');
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /nombra SEC-C2, no TEST-C1/);
  // «TEST-C10» no es TEST-C1
  lab.conversar([delDev('eximo TEST-C10 de una vez')]);
  assert.equal(waive(lab, 'eximo TEST-C10 de una vez').status, 1);
  assert.equal(eximidos(lab).length, 0);
});

// el reenvío por la sesión que declara la organización: por la librería, con el perfil del árbol de prueba
function okReenviado(lab, cuerpo, arnes) {
  const cw = require(path.join(SCRIPTS, 'lib', 'critical-waivers.js'));
  lab.conversar([deOtraSesion('coordinadora', cuerpo)]);
  designarCoordinadora(lab.home);
  return cw.okDeUnaPersona({
    approvedBy: 'Dev de Prueba', quote: cuerpo.split('.')[0], relayedBy: 'coordinadora', arnes, home: lab.home,
    env: { HOME: lab.home, CLAUDE_CODE_SESSION_ID: lab.sid, TYCON_PROFILE: '0' }, desde: new Date(Date.now() - 60000).toISOString(),
    critico: { rule: REGLA, file: ARCHIVO, reason: MOTIVO, storyId: '9.93', sessionId: lab.sid, stateDir: path.join(lab.home, '.claude', '.tycon-pipeline') },
  });
}
function arnesConRelevo() {
  const arnes = tmp('cs-arnes-');
  fs.writeFileSync(path.join(arnes, 'team-profile.json'), JSON.stringify({ approvals: { relay_session: 'coordinadora' } }));
  return arnes;
}

test('CriticalShown_ReenviadoSinNombrar_NoExime @story-8.71 @ac-8', () => {
  const lab = laboratorio();
  mostrar(lab);
  const r = okReenviado(lab, 'Apruebo, seguí con lo que propusiste. Firma: coordinadora', arnesConRelevo());
  assert.equal(r.ok, false);
  assert.match(r.motivo, /no nombra este crítico/);
});

test('CriticalShown_CaminosBuenos @story-8.71 @ac-6 @ac-7 @ac-8', () => {
  // con el código
  const a = laboratorio({ sid: 's-cs-a' });
  const aviso = mostrar(a);
  assert.match(aviso, /TEST-C1/);
  a.conversar([delDev('eximo TEST-C1, la corrí a mano')]);
  const ra = waive(a, 'eximo TEST-C1, la corrí a mano');
  assert.equal(ra.status, 0, `${ra.stdout}${ra.stderr}`);
  assert.equal(eximidos(a)[0].tipo, 'manual');
  // con el nombre en llano que enseñó la muestra
  const b = laboratorio({ sid: 's-cs-b' });
  mostrar(b);
  b.conversar([delDev('Eximo la suite completa, ya la vi pasar')]);
  const rb = waive(b, 'Eximo la suite completa, ya la vi pasar');
  assert.equal(rb.status, 0, `${rb.stdout}${rb.stderr}`);
  // reenviado, nombrando el crítico: automática, por delegación
  const c = laboratorio({ sid: 's-cs-c' });
  mostrar(c);
  const rc = okReenviado(c, 'eximo TEST-C1 por delegación del dueño. Firma: coordinadora', arnesConRelevo());
  assert.equal(rc.ok, true, rc.motivo);
  assert.equal(rc.entrada.tipo, 'automatica');
});

test('CriticalShown_DosArchivos_PideElArchivo @story-8.71 @ac-7', () => {
  const lab = laboratorio({ criticos: [{ rule_id: 'TEST-C2', file: 'app/orders.py' }, { rule_id: 'TEST-C2', file: 'app/users.py' }] });
  mostrar(lab, 'TEST-C2', 'app/orders.py', 'cobertura baja en código viejo');
  mostrar(lab, 'TEST-C2', 'app/users.py', 'cobertura baja en código viejo');
  lab.conversar([delDev('eximo TEST-C2 sin más vueltas')]);
  const r = waive(lab, 'eximo TEST-C2 sin más vueltas', { rule: 'TEST-C2', file: 'app/orders.py', reason: 'cobertura baja en código viejo' });
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /TEST-C2 está abierta en 2 archivos: el ok tiene que nombrar orders\.py/);
  lab.conversar([delDev('eximo TEST-C2 en orders.py, es código viejo')]);
  const ok = waive(lab, 'eximo TEST-C2 en orders.py, es código viejo', { rule: 'TEST-C2', file: 'app/orders.py', reason: 'cobertura baja en código viejo' });
  assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);
});

test('CriticalShown_Negacion_NoExime @story-8.71 @ac-7', () => {
  const lab = laboratorio();
  mostrar(lab);
  lab.conversar([delDev('no eximo TEST-C1, arreglalo primero')]);
  const r = waive(lab, 'no eximo TEST-C1, arreglalo primero');
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /trae una negación/);
  assert.equal(eximidos(lab).length, 0);
});

test('CriticalShown_PuertaBashLoMuestra @story-8.71 @ac-1 @ac-4', () => {
  const lab = laboratorio();
  const aviso = mostrar(lab);
  assert.match(aviso, /9\.93/);
  assert.match(aviso, /TEST-C1/);
  assert.match(aviso, /la suite completa/);
  assert.ok(aviso.includes(ARCHIVO), aviso);
  assert.ok(aviso.includes(MOTIVO), aviso);
  assert.ok(aviso.includes('la suite completa no corrió'), 'lo que dijo el revisor');
  assert.match(aviso, /«eximo TEST-C1»/);
  assert.match(aviso, /«eximo la suite completa»/);
  const [g] = gates(lab).filter((x) => x.name === 'critical-shown');
  assert.deepEqual([g.sessionId, g.story, g.rule, g.file], [lab.sid, '9.93', REGLA, ARCHIVO]);
  assert.ok(g.sha && g.ts);
  // ya mostrado con el mismo motivo: no lo repite
  assert.equal(mostrar(lab), '');
  // con otro motivo, sí
  assert.match(mostrar(lab, REGLA, ARCHIVO, 'otro motivo'), /otro motivo/);
  // --terminal: la persona lo ve en la terminal; la puerta no muestra nada
  const t = puertaBash(lab, comando(REGLA, ARCHIVO, 'por la terminal', ' --terminal'));
  assert.equal(t.stdout.trim(), '');
  // sin conversación legible: ni muestra ni constancia
  const sin = laboratorio({ sid: 's-cs-sin' });
  fs.rmSync(path.join(sin.home, '.claude', 'projects'), { recursive: true, force: true });
  assert.equal(mostrar(sin), '');
  assert.equal(gates(sin).filter((x) => x.name === 'critical-shown').length, 0);
});

test('CriticalShown_AlEscribirElPedidoLoMuestra @story-8.71 @ac-2', () => {
  const lab = laboratorio();
  const pedido = JSON.stringify({ rule: REGLA, file: ARCHIVO, reason: MOTIVO });
  // el mismo nombre fuera de la carpeta de la corrida: nada
  const ajeno = path.join(lab.repo, 'exencion-pedida.json');
  fs.writeFileSync(ajeno, pedido);
  const a = despachar(lab, ajeno, pedido);
  assert.equal(a.status, 0, a.stderr);
  assert.doesNotMatch(a.stdout, /TEST-C1/);
  assert.equal(gates(lab).filter((x) => x.name === 'critical-shown').length, 0, 'fuera de la corrida no deja constancia');
  const propio = path.join(lab.runDir, 'exencion-pedida.json');
  fs.writeFileSync(propio, pedido);
  const d = despachar(lab, propio, pedido);
  assert.equal(d.status, 0, d.stderr);
  const aviso = JSON.parse(d.stdout).systemMessage;
  assert.match(aviso, /TEST-C1/);
  assert.match(aviso, /«eximo la suite completa»/);
  assert.equal(gates(lab).filter((x) => x.name === 'critical-shown').length, 1);
  // con esa muestra, el ok a ese crítico exime
  lab.conversar([delDev('eximo la suite completa, está bien')]);
  const r = waive(lab, 'eximo la suite completa, está bien');
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

test('CriticalShown_NombreEnLlano @story-8.71 @ac-3', () => {
  const cd = require(path.join(SCRIPTS, 'lib', 'critical-display.js'));
  const arnes = tmp('cs-cat-');
  fs.mkdirSync(path.join(arnes, 'guides'));
  fs.writeFileSync(path.join(arnes, 'guides', 'advisor-rules-catalog.md'), [
    '| **SEC-C9** | Bind a todas las interfaces | Escuchar en localhost |',
    '| **VAL-C2** | Pseudocódigo de la story inyecta `IConfiguration` en ctor de plugin service O usa algo largo de verdad | x |',
  ].join('\n'));
  assert.equal(cd.nombreEnLlano('TEST-C1', { arnes }), 'la suite completa');
  assert.equal(cd.nombreEnLlano('SEC-C9', { arnes }), 'bind a todas las interfaces');
  assert.equal(cd.nombreEnLlano('VAL-C2', { arnes }), null);
  assert.equal(cd.nombreEnLlano('NADA-C1', { arnes }), null);
});

// Los bordes del juez: códigos con sufijo, el nombre en llano junto a otro código, el archivo nombrado entero, el «no».
test('CriticalShown_JuezClasesDelPaseAdversarial @story-8.71 @ac-7', () => {
  const cd = require(path.join(SCRIPTS, 'lib', 'critical-display.js'));
  const arnes = tmp('cs-juez-');
  // códigos con sufijo: se nombran enteros y no se confunden con la regla base
  assert.equal(cd.juez({ rule: 'TEST-C1b', file: 'a', arnes })('eximo TEST-C1b, la corrí a mano'), null);
  assert.match(cd.juez({ rule: 'ACCOV-C1-EXT', file: 'a', arnes })('eximo ACCOV-C1, es otra'), /nombra ACCOV-C1, no ACCOV-C1-EXT/);
  assert.equal(cd.juez({ rule: 'ACCOV-C1-EXT', file: 'a', arnes })('eximo ACCOV-C1-EXT.'), null);
  assert.match(cd.juez({ rule: 'TEST-C1', file: 'a', arnes })('eximo TEST-C1b de paso'), /nombra TEST-C1B, no TEST-C1/);
  // el nombre en llano no gana sobre otro código nombrado
  assert.match(cd.juez({ rule: 'TEST-C1', file: 'a', arnes })('eximo SEC-C2; la suite completa la miro después'), /nombra SEC-C2, no TEST-C1/);
  // el archivo se nombra entero: ni contenido en otro nombre, ni el nombre base cuando dos comparten nombre
  const varios = cd.juez({ rule: 'TEST-C2', file: 'app/foo.js', archivos: ['app/foo.js', 'app/barfoo.js'], arnes });
  assert.match(varios('eximo TEST-C2 en barfoo.js'), /tiene que nombrar foo\.js/);
  assert.equal(varios('eximo TEST-C2 en foo.js'), null);
  const mismos = cd.juez({ rule: 'TEST-C2', file: 'src/a/index.js', archivos: ['src/a/index.js', 'src/b/index.js'], arnes });
  assert.match(mismos('eximo TEST-C2 en index.js'), /tiene que nombrar src\/a\/index\.js/);
  assert.match(mismos('eximo TEST-C2 en src/b/index.js'), /tiene que nombrar src\/a\/index\.js/);
  assert.equal(mismos('eximo TEST-C2 en src/a/index.js'), null);
  // ante cualquier negación no exime: leer todas las formas de negar no cierra, y el bloque enseña qué escribir
  const juez1 = cd.juez({ rule: 'TEST-C1', file: 'a', arnes });
  for (const t2 of ['no lo apruebo, TEST-C1 se arregla', 'TEST-C1? no.', 'TEST-C1 no.', 'TEST-C1, no, arreglalo', 'TEST-C1: nunca lo eximas',
    'eximo TEST-C1? No.', 'No eximo. TEST-C1 sí', 'no eximo TEST-C1. No.', 'Eximo SEC-C2, pero TEST-C1 no', 'Eximo TEST-C1. Mejor no.',
    'Eximo TEST-C1. No, esperá.', 'jamás eximo TEST-C1', 'tampoco eximo TEST-C1', 'sin eximir TEST-C1', 'nada de eximir TEST-C1',
    'eximo TEST-C1. SEC-C2 no lo eximas todavía', 'No hay duda: eximo TEST-C1']) {
    assert.notEqual(juez1(t2), null, t2);
  }
  assert.match(juez1('Eximo TEST-C1. Mejor no.'), /trae una negación/);
  for (const t2 of ['Eximo TEST-C1, pero no', 'Eximo la suite completa, no', 'TEST-C1 sigue sin eximir']) assert.match(juez1(t2), /trae una negación/, t2);
  assert.match(juez1('Si lo arreglás, eximo TEST-C1'), /condición/);
  // el crítico es lo que se exime: la parte de la frase es «eximo <regla o nombre en llano>», sin excepciones ni rodeos
  for (const t2 of ['eximo todo menos TEST-C1', 'eximo TEST-C2 y mantengo TEST-C1', 'eximo TEST-C2 en vez de TEST-C1', 'Rechazo eximir TEST-C1',
    'eximo TEST-C1 cuando lo arreglen', 'eximo TEST-C1 salvo que falle', 'Eximir TEST-C1 sería un error', 'quizás eximo TEST-C1',
    'mejor eximo TEST-C1 mañana', 'eximo TEST-C1, únicamente con la CI verde', 'eximo el eximio TEST-C1', 'Eximilo: TEST-C1 la corre la CI']) {
    assert.notEqual(juez1(t2), null, t2);
  }
  assert.equal(juez1('eximo TEST-C1.'), null);
  assert.equal(juez1('si, eximo TEST-C1'), null);
  // una pregunta no exime
  assert.match(juez1('¿Eximo TEST-C1?'), /no dice que lo exime/);
  assert.match(juez1('Eximimos TEST-C1?'), /no dice que lo exime/);
  // nombrarlo sin decir que lo exime no alcanza; el nombre y el «exim…» van en la misma parte de la frase
  assert.match(juez1('TEST-C1 sí, dale'), /no dice que lo exime/);
  assert.match(juez1('Eximo la otra, TEST-C1 queda'), /no dice que lo exime/);
  // los oks claros
  for (const t2 of ['eximo TEST-C1', 'Eximo TEST-C1, la corrí a mano', 'ok, eximo la suite completa: ya la vi pasar', 'eximo TEST-C1 por delegación del dueño']) {
    assert.equal(juez1(t2), null, t2);
  }
});

test('CriticalShown_NombreEnLlanoConSiglas @story-8.71 @ac-3', () => {
  const cd = require(path.join(SCRIPTS, 'lib', 'critical-display.js'));
  const arnes = tmp('cs-siglas-');
  fs.mkdirSync(path.join(arnes, 'guides'));
  fs.writeFileSync(path.join(arnes, 'guides', 'advisor-rules-catalog.md'), '| **SEC-C7** | HTTP sin TLS hacia afuera | x |\n| **SEC-C8** | Webhooks sin firma | x |\n');
  assert.equal(cd.nombreEnLlano('SEC-C7', { arnes }), 'HTTP sin TLS hacia afuera');
  assert.equal(cd.nombreEnLlano('SEC-C8', { arnes }), 'webhooks sin firma');
});

test('CriticalShown_ComandoEnVariasFormas @story-8.71 @ac-1', () => {
  const cd = require(path.join(SCRIPTS, 'lib', 'critical-display.js'));
  // renglones unidos con barra invertida, como los une la terminal
  assert.deepEqual(cd.pedidosDelComando('node marker.js \\\nwaive-critical --rule TEST-C1 \\\n--file a.json --reason "por qué"'), [{ rule: 'TEST-C1', file: 'a.json', reason: 'por qué' }]);
  // dos exenciones en un comando: las dos; la que va por la terminal, no
  assert.deepEqual(cd.pedidosDelComando("node m/marker.js waive-critical --rule A-C1 --reason x --terminal; node m/marker.js waive-critical --rule B-C2 --reason 'y'").map((p) => p.rule), ['B-C2']);
  // dentro de bash -c
  assert.deepEqual(cd.pedidosDelComando(`bash -c "node marker.js waive-critical --rule A-C1 --reason 'z'"`).map((p) => p.rule), ['A-C1']);
  // con variables de la terminal no se sabe el valor: no se muestra
  assert.deepEqual(cd.pedidosDelComando('node marker.js waive-critical --rule A-C1 --reason "$MOTIVO"'), []);
});

test('CriticalShown_PedidoVacioYRegistroIlegible @story-8.71 @ac-2 @ac-5', () => {
  const lab = laboratorio();
  // un pedido que es JSON pero no un objeto: recordatorio del formato, sin caerse
  const propio = path.join(lab.runDir, 'exencion-pedida.json');
  fs.writeFileSync(propio, 'null');
  const d = despachar(lab, propio, 'null');
  assert.equal(d.status, 0, d.stderr);
  assert.doesNotMatch(d.stderr, /TypeError/);
  assert.match(d.stdout, /rule.*file.*reason/);
  // el registro del arnés ilegible: el rechazo lo dice, no «no se le mostró»
  mostrar(lab);
  const gl = path.join(lab.home, '.claude', '.tycon-pipeline', 'gates.log');
  fs.chmodSync(gl, 0o000);
  try {
    lab.conversar([delDev('eximo TEST-C1, la corrí a mano')]);
    const r = waive(lab, 'eximo TEST-C1, la corrí a mano');
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /no pude leer el registro del arnés/);
  } finally { fs.chmodSync(gl, 0o644); }
});

test('CriticalShown_RetractacionPosterior_NoExime @story-8.71 @ac-7', () => {
  const lab = laboratorio({ sid: 's-cs-atras' });
  mostrar(lab);
  // la persona eximió y después se echó atrás: la cita del ok viejo no alcanza
  lab.conversar([delDev('eximo TEST-C1, la corrí a mano', T(1)), delDev('no eximo TEST-C1, mejor arreglalo', T(2))]);
  const r = waive(lab, 'eximo TEST-C1, la corrí a mano');
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /se echó atrás/);
  assert.equal(eximidos(lab).length, 0);
});

test('CriticalShown_FindingsConOtraForma @story-8.71 @ac-1 @ac-5', () => {
  // envuelto en { findings: [...] }: se lee igual
  const a = laboratorio({ sid: 's-cs-env' });
  fs.writeFileSync(path.join(a.runDir, 'findings.json'), JSON.stringify({ findings: [{ rule_id: REGLA, file: ARCHIVO, severity: 'CRITICAL', summary: 'envuelto y leído' }] }));
  assert.ok(mostrar(a).includes('envuelto y leído'));
  // un objeto que no es una lista: el bloque avisa y el ok no exime
  const b = laboratorio({ sid: 's-cs-obj' });
  fs.writeFileSync(path.join(b.runDir, 'findings.json'), '{}');
  assert.match(mostrar(b), /Aviso del arnés: no pude leer findings\.json/);
  b.conversar([delDev('eximo TEST-C1, la corrí a mano')]);
  const r = waive(b, 'eximo TEST-C1, la corrí a mano');
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /findings\.json/);
});

test('CriticalShown_MuestraViejaNoHabilitaOkViejo @story-8.71 @ac-6', () => {
  const cw = require(path.join(SCRIPTS, 'lib', 'critical-waivers.js'));
  const lab = laboratorio({ sid: 's-cs-viejo' });
  mostrar(lab);
  lab.conversar([delDev('eximo TEST-C1, de la corrida anterior', new Date().toISOString())]);
  // la corrida arrancó después de la muestra y del ok: el ok es viejo aunque sea posterior a la muestra
  const r = cw.okDeUnaPersona({
    approvedBy: 'Dev de Prueba', quote: 'eximo TEST-C1, de la corrida anterior', home: lab.home,
    env: { HOME: lab.home, CLAUDE_CODE_SESSION_ID: lab.sid, TYCON_PROFILE: '0' }, desde: new Date(Date.now() + 5000).toISOString(),
    critico: { rule: REGLA, file: ARCHIVO, reason: MOTIVO, storyId: '9.93', sessionId: lab.sid, stateDir: path.join(lab.home, '.claude', '.tycon-pipeline') },
  });
  assert.equal(r.ok, false);
});

// ── el ok va solo en su mensaje; una aclaración, en otro (los casos de una sesión real, con nombres cambiados) ────
const FIRMA = 'Firma: coordinadora, por delegación del dueño.';
const juezDe = (rule = REGLA) => require(path.join(SCRIPTS, 'lib', 'critical-display.js')).juez({ rule, file: ARCHIVO, arnes: tmp('cs-orac-') });

test('CriticalShown_AclaracionEnOtroMensaje_Exime @story-8.77 @ac-1', () => {
  const j = juezDe();
  // casos c y d: con la aclaración en el mismo mensaje no exime, y el motivo enseña cómo escribirlo
  const juntos = `Eximo TEST-C1 de la 9.93: la suite completa la corre la CI del pedido. ${FIRMA} Sobre la Mac: es el laboratorio local, no hay otro ensayo.`;
  assert.match(j(juntos), /contestá sólo «eximo TEST-C1».*cualquier otra cosa, en otro mensaje/);
  // el ok solo, con su motivo y la firma, exime
  assert.equal(j(`Eximo TEST-C1 de la 9.93: la suite completa la corre la CI del pedido. ${FIRMA}`), null);
  // por el comando: la aclaración en un mensaje aparte, después del ok, no lo tumba
  const lab = laboratorio({ sid: 's-cs-aparte' });
  mostrar(lab);
  lab.conversar([delDev(`Eximo TEST-C1 de la 9.93: la suite completa la corre la CI del pedido. ${FIRMA}`, T(1)),
    delDev('Sobre la Mac: es el laboratorio local, no hay otro ensayo. Una corrección: la 182 no pasa a tanda B.', T(2))]);
  const r = waive(lab, 'Eximo TEST-C1 de la 9.93');
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

test('CriticalShown_NegacionEnElMensaje_NoExime @story-8.77 @ac-2', () => {
  const j = juezDe();
  for (const t of ['Eximo TEST-C1. No eximo TEST-C1.', 'Eximo TEST-C1 cuando pase la CI', 'eximo TEST-C1. no lo eximas todavía',
    'Eximo TEST-C1. Sobre la Mac: no quiero que se avance con nada.', 'Eximo TEST-C1. Una corrección: No avancen con nada de lo planeado.',
    'Eximo TEST-C1. Esperá, todavía no está listo para eso.', 'Eximo TEST-C1. Ojo, salvo que falle.', 'Eximo TEST-C1. Eso sí, solo si pasa la CI.',
    'Eximo TEST-C1. Sobre lo de antes: te confirmo después de hablar con el equipo.']) assert.notEqual(j(t), null, t);
});

test('CriticalShown_FrenoYNegacionCorta_NoExime @story-8.77 @ac-3', () => {
  const j = juezDe();
  for (const t of ['Eximo TEST-C1. No.', 'Eximo TEST-C1. Mejor no.', 'Eximo TEST-C1.\nNo, pará.', 'Eximo TEST-C1. Esperá.', 'Eximo TEST-C1. Pará.']) {
    assert.notEqual(j(t), null, t);
  }
  assert.match(j('Eximo TEST-C1. Esperá.'), /pide esperar/);
});

test('CriticalShown_ApruebaEximir_Exime @story-8.77 @ac-4', () => {
  const j = juezDe();
  assert.equal(j('Apruebo eximir TEST-C1 de la 9.93: la suite completa la corre la CI del pedido.'), null);
  assert.equal(j('apruebo eximir la suite completa'), null);
  assert.match(j('Apruebo.'), /no nombra este crítico/);
  assert.match(j('Apruebo eximir TEST-C1 si pasa la CI'), /condición/);
  // caso b, por el comando: la misma frase después de la muestra exime
  const lab = laboratorio({ sid: 's-cs-apruebo' });
  mostrar(lab);
  const frase = `Apruebo eximir TEST-C1 de la 9.93: la suite completa la corre la CI del pedido. ${FIRMA}`;
  lab.conversar([delDev(frase)]);
  const r = waive(lab, 'Apruebo eximir TEST-C1 de la 9.93');
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.equal(eximidos(lab).length, 1);
});

test('CriticalShown_OkAntesDeLaMuestra_PideDeNuevoEnLlano @story-8.77 @ac-5', () => {
  const lab = laboratorio({ sid: 's-cs-destiempo' });
  const antes = new Date().toISOString();
  const espera = Date.now() + 30; while (Date.now() < espera) { /* la muestra queda después */ }
  mostrar(lab);
  lab.conversar([delDev(`Eximo TEST-C1 de la 9.93: la suite completa la corre la CI del pedido. ${FIRMA}`, antes)]);
  const r = waive(lab, 'Eximo TEST-C1 de la 9.93');
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /de antes de que se le mostrara este crítico/);
  assert.match(r.stderr, /se lo mostró a las \d{2}:\d{2}/);
  assert.match(r.stderr, /pedile que conteste ahora/i);
  assert.match(r.stderr, /«eximo TEST-C1»/);
  assert.equal(eximidos(lab).length, 0);
});

test('CriticalShown_RetractaSiNombraHablaDeEximirOEsCorto @story-8.77 @ac-6', () => {
  const j = juezDe();
  for (const t of ['No.', 'Mejor no.', 'Esperá.', 'No lo eximas todavía.', 'Sobre TEST-C1: no, mejor arreglalo.', 'Pensándolo bien, TEST-C1 no.']) {
    assert.equal(j.retracta(t), true, t);
  }
  for (const t of ['Una corrección: la 182 no pasa a tanda B.', 'Sobre la Mac: es el laboratorio local, no hay otro ensayo.', 'Bien el --tool-only.']) {
    assert.equal(j.retracta(t), false, t);
  }
  for (const despues of ['No.', 'No lo eximas todavía.']) {
    const l = laboratorio({ sid: `s-cs-atras-${despues.length}` });
    mostrar(l);
    l.conversar([delDev('eximo TEST-C1, la corrí a mano', T(1)), delDev(despues, T(2))]);
    const rr = waive(l, 'eximo TEST-C1, la corrí a mano');
    assert.equal(rr.status, 1, `${despues}: ${rr.stdout}${rr.stderr}`);
    assert.match(rr.stderr, /se echó atrás/);
  }
});

test('CriticalShown_Paso7YBloqueEnsenanLaForma @story-8.77 @ac-7', () => {
  const paso = fs.readFileSync(path.join(SCRIPTS, '..', 'steps', 'step-09-findings.md'), 'utf8');
  assert.match(paso, /antes de pedirle el ok/);
  assert.match(paso, /apruebo eximir/i);
  assert.match(paso, /en otro mensaje/);
  const cd = require(path.join(SCRIPTS, 'lib', 'critical-display.js'));
  assert.match(cd.bloque({ storyId: '9.93', rule: REGLA, file: ARCHIVO, reason: MOTIVO, arnes: tmp('cs-bloque-') }), /Contestá sólo eso.*cualquier otra cosa, en otro mensaje/);
});

// El freno sin tilde («para», «espera», «frena», «aguanta») cuenta sólo cuando abre el mensaje, una oración o una
// cláusula; con tilde, en cualquier lugar. La preposición «para» dentro de una oración no es un pedido de esperar.
const FRASE_737 = 'Eximo SEC-C3 de la 7.37: findings.json lo puede reescribir el agente; es un hueco previo que vale para todos los críticos y va a una story aparte.';
const FRASE_747 = 'Eximo TEST-C1 de la 7.47: la suite completa la corre la CI del pedido.';

test('CriticalShown_ParaPreposicion_Exime @story-8.82 @ac-1', () => {
  const archivo = 'skills/tycon-pipeline/scripts/marker.js';
  const motivo = 'findings.json lo puede reescribir el agente: hueco previo; va a una story aparte';
  const lab = laboratorio({ sid: 's-cs-para', criticos: [{ rule_id: 'SEC-C3', file: archivo, summary: 'findings.json lo escribe el agente' }] });
  mostrar(lab, 'SEC-C3', archivo, motivo);
  lab.conversar([delDev(FRASE_737)]);
  const r = waive(lab, FRASE_737, { rule: 'SEC-C3', file: archivo, reason: motivo });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.equal(eximidos(lab).length, 1);
  // la frase que ya pasaba sigue pasando
  assert.equal(juezDe()(FRASE_747), null);
});

test('CriticalShown_FrenoConTilde_NoExime @story-8.82 @ac-2', () => {
  const j = juezDe();
  for (const f of ['esperá', 'pará', 'frená', 'aguantá']) {
    for (const t of [`${f[0].toUpperCase()}${f.slice(1)}, eximo TEST-C1.`, `Eximo TEST-C1 y ${f} un poco.`, `Eximo TEST-C1, ${f}.`]) {
      assert.match(j(t) || '', /pide esperar/, t);
    }
  }
});

test('CriticalShown_FrenoSinTildeAlAbrir_NoExime @story-8.82 @ac-3', () => {
  const j = juezDe();
  for (const t of ['Para.', 'Espera un poco, eximo TEST-C1.', 'Eximo TEST-C1, para.', 'Eximo TEST-C1. Frena.', 'Eximo TEST-C1; aguanta.', 'Eximo TEST-C1: espera.',
    // tras un conector, un guion, un paréntesis, unas comillas o puntos suspensivos, al final, o en otra línea
    'Eximo TEST-C1 y espera un poco', 'Eximo TEST-C1 pero para', 'Eximo TEST-C1 ahora espera', 'Eximo TEST-C1 y para', 'Eximo TEST-C1 — espera',
    'Eximo TEST-C1 - aguanta', 'Eximo TEST-C1 (para)', 'Eximo TEST-C1… frena', 'Eximo TEST-C1 «espera»', '"Para." Eximo TEST-C1', 'Eximo TEST-C1 para.',
    'Eximo TEST-C1\npara', '¿Espera? Eximo TEST-C1',
    // con tilde en forma descompuesta (letra + acento aparte)
    'Eximo TEST-C1. Esperá.']) {
    assert.notEqual(j(t), null, t);
  }
  assert.match(j('Eximo TEST-C1, para.'), /pide esperar/);
});

test('CriticalShown_SinTildeEnMedio_NoEsFreno @story-8.82 @ac-4', () => {
  const j = juezDe();
  for (const t of ['Eximo TEST-C1 de la 9.93: el pedido queda en espera de la CI.', 'Eximo TEST-C1 de la 9.93: el control frena el merge igual.',
    'Eximo TEST-C1 de la 9.93: la regla vale para todos los repos.', 'Eximo TEST-C1 de la 9.93: la máquina aguanta la suite en la CI.']) {
    assert.equal(j(t), null, t);
  }
});

test('CriticalShown_RetractaMismaRegla @story-8.82 @ac-5', () => {
  const j = juezDe();
  for (const t of ['Para.', 'Esperá.', 'Espera, eximir no.', 'Mejor espera.', 'Y espera, eximir', 'Eximir — para']) assert.equal(j.retracta(t), true, t);
  for (const t of ['Sobre la CI: corre para todos los repos.', 'El pedido queda en espera de la CI.']) assert.equal(j.retracta(t), false, t);
});

// ── eximir sin trabas: el comando con una variable, todos los críticos juntos, los códigos largos ────────────────────

const LARGO = 'ADV-false-negative-classification';
const PIPE_JS = 'skills/tycon-pipeline/scripts/pipeline.js';
const CRITICOS_273 = [{ rule_id: REGLA, file: ARCHIVO, summary: 'la suite completa no corrió' }, { rule_id: LARGO, file: PIPE_JS, summary: 'allowed.anthropic en los caminos del pipeline', reason: 'ningún criterio lo pide' }];
const stateDirDe = (lab) => path.join(lab.home, '.claude', '.tycon-pipeline');
const muestras = (lab) => gates(lab).filter((x) => x.name === 'critical-shown');

test('CriticalShown_8_94_ComandoConVariable_LoMuestra @story-8.94 @ac-1', () => {
  const cd = require(path.join(SCRIPTS, 'lib', 'critical-display.js'));
  const esperado = [{ rule: 'A-C1', file: 'f.json', reason: 'por qué' }];
  for (const ej of ['node "$M"', 'node $M', 'node ${M}', '$M', '"$M"']) {
    assert.deepEqual(cd.pedidosDelComando(`M=/x/marker.js; ${ej} waive-critical --rule A-C1 --file f.json --reason "por qué"`), esperado, ej);
  }
  // y por la puerta de verdad: el comando con la variable muestra el crítico
  const lab = laboratorio({ sid: 's-cs-var' });
  const p = puertaBash(lab, `M=${MARKER}; node "$M" waive-critical --rule ${REGLA} --file ${sh(ARCHIVO)} --reason ${sh(MOTIVO)}`);
  assert.equal(p.status, 0, p.stderr);
  assert.match(JSON.parse(p.stdout).systemMessage, /TEST-C1/);
  assert.equal(muestras(lab).length, 1);
});

test('CriticalShown_8_94_VariableEnLoQueSeExime_NoSeMuestra @story-8.94 @ac-1 @ac-6', () => {
  const cd = require(path.join(SCRIPTS, 'lib', 'critical-display.js'));
  for (const c of ['node "$M" waive-critical --rule $R --file f --reason "x"', 'node "$M" waive-critical --rule A-C1 --file f --reason "$(cat motivo)"', '$M waive-critical --rule A-C1 --file "$F" --reason x']) {
    assert.deepEqual(cd.pedidosDelComando(c), [], c);
  }
  // un ejecutable que no es una variable sola no se toma por el marcador
  assert.deepEqual(cd.pedidosDelComando('node otro.js waive-critical --rule A-C1 --file f --reason x'), []);
});

test('CriticalShown_8_94_TodosLosCriticosJuntos @story-8.94 @ac-2', () => {
  const lab = laboratorio({ sid: 's-cs-todos', criticos: [...CRITICOS_273, { rule_id: 'SEC-C2', file: 'app.js', summary: 'un secreto' }] });
  // SEC-C2 ya está eximido: no se vuelve a mostrar
  fs.writeFileSync(path.join(lab.runDir, 'critical-waivers.jsonl'), `${JSON.stringify({ rule_id: 'SEC-C2', file: 'app.js', reason: 'r', tipo: 'manual', quien: 'Dev de Prueba', cita: 'eximo SEC-C2', via: 'ok del dev en el chat', ts: new Date().toISOString() })}\n`);
  const aviso = mostrar(lab);
  assert.match(aviso, /TEST-C1/);
  assert.ok(aviso.includes(LARGO), aviso);
  assert.ok(aviso.includes('ningún criterio lo pide'), 'con el motivo del hallazgo');
  assert.doesNotMatch(aviso, /SEC-C2/);
  assert.match(aviso, /«eximo TEST-C1\. eximo ADV-false-negative-classification»/, 'cómo contestar todos en un mensaje');
  assert.deepEqual(muestras(lab).map((g) => g.rule).sort(), [LARGO, REGLA].sort(), 'una constancia por cada crítico mostrado');
});

test('CriticalShown_8_94_MostradoNoSeRepite @story-8.94 @ac-2', () => {
  const lab = laboratorio({ sid: 's-cs-repite', criticos: CRITICOS_273 });
  mostrar(lab);
  // otro motivo para TEST-C1: se vuelve a mostrar ése, pero no el otro, que ya se vio en esta corrida
  const aviso = mostrar(lab, REGLA, ARCHIVO, 'otro motivo');
  assert.match(aviso, /otro motivo/);
  assert.ok(!aviso.includes(LARGO), aviso);
  assert.equal(muestras(lab).filter((g) => g.rule === LARGO).length, 1);
});

test('CriticalShown_8_94_OtrosAbiertos_RamasYAviso @story-8.94 @ac-2', () => {
  const cd = require(path.join(SCRIPTS, 'lib', 'critical-display.js'));
  // un hallazgo repetido (misma regla y archivo) se muestra una vez, y sin motivo ni resumen lleva el texto fijo
  const lab = laboratorio({ sid: 's-cs-otros', criticos: [{ rule_id: REGLA, file: ARCHIVO }, { rule_id: 'ADV-C2', file: 'a.js' }, { rule_id: 'ADV-C2', file: 'a.js' }] });
  const o = cd.otrosAbiertos({ sessionId: lab.sid, stateDir: stateDirDe(lab), pedidos: [{ rule: REGLA, file: ARCHIVO }] });
  assert.deepEqual(o, { lista: [{ rule: 'ADV-C2', file: 'a.js', reason: 'el crítico abierto de la corrida' }], aviso: null });
  // las exenciones ilegibles: ninguno, y el aviso llega a la muestra
  fs.mkdirSync(path.join(lab.runDir, 'critical-waivers.jsonl'));
  const ile = cd.otrosAbiertos({ sessionId: lab.sid, stateDir: stateDirDe(lab), pedidos: [] });
  assert.deepEqual(ile.lista, []);
  assert.match(ile.aviso, /no pude leer las exenciones de la corrida.*puede haber otros críticos/);
  assert.match(mostrar(lab), /Aviso del arnés: no pude leer las exenciones/);
  // findings.json ilegible: el mismo aviso, por su lado
  const lab2 = laboratorio({ sid: 's-cs-otros2' });
  fs.writeFileSync(path.join(lab2.runDir, 'findings.json'), '{ no es json');
  assert.match(cd.otrosAbiertos({ sessionId: lab2.sid, stateDir: stateDirDe(lab2), pedidos: [] }).aviso, /no pude leer findings\.json/);
  // sin marcador de la sesión: nada, sin aviso
  assert.deepEqual(cd.otrosAbiertos({ sessionId: 'otra-sesion', stateDir: stateDirDe(lab2), pedidos: [] }), { lista: [], aviso: null });
});

test('CriticalShown_8_94_UnMensajeConTodos @story-8.94 @ac-3 @ac-6', () => {
  const arnes = tmp('cs-todos-');
  const cd = require(path.join(SCRIPTS, 'lib', 'critical-display.js'));
  const uno = cd.juez({ rule: REGLA, file: ARCHIVO, arnes });
  const otro = cd.juez({ rule: 'ADV-C1', file: PIPE_JS, arnes });
  const ok = 'eximo TEST-C1. eximo ADV-C1 de pipeline.js.';
  assert.equal(uno(ok), null);
  assert.equal(otro(ok), null);
  const conNo = 'eximo TEST-C1. eximo ADV-C1 de pipeline.js, no el resto.';
  assert.ok(uno(conNo) && otro(conNo), 'con una negación no exime ninguno');
});

test('CriticalShown_8_94_CodigoLargo_SeNombraEntero @story-8.94 @ac-4', () => {
  const cd = require(path.join(SCRIPTS, 'lib', 'critical-display.js'));
  const j = cd.juez({ rule: LARGO, file: PIPE_JS, arnes: tmp('cs-largo-') });
  assert.equal(j(`eximo ${LARGO} de pipeline.js`), null);
  assert.equal(j(`Eximo ${LARGO.toUpperCase()}: queda como deuda.`), null);
  assert.match(j('eximo ADV-false de pipeline.js'), /no nombra este crítico/);
  assert.match(j('eximo ADV-false-negative-classification-2 de pipeline.js'), /no nombra este crítico/);
  assert.match(j('eximo ADV-traversal-completeness de pipeline.js'), /no nombra este crítico/);
  // la forma corta sigue igual
  assert.equal(cd.juez({ rule: REGLA, file: ARCHIVO, arnes: tmp('cs-largo2-') })('eximo TEST-C1'), null);
});

test('CriticalShown_8_94_FraseRepetida_LaMasNueva @story-8.94 @ac-5 @ac-6', () => {
  const frase = 'eximo TEST-C1, la corrí a mano';
  // la misma frase antes y después de la muestra: cuenta la de después, con su hora
  const lab = laboratorio({ sid: 's-cs-repetida' });
  const antes = new Date().toISOString();
  mostrar(lab);
  const despues = T(3);
  lab.conversar([delAgente('Hay un crítico abierto.', antes), delDev(frase, antes), delDev(frase, despues)]);
  const r = waive(lab, frase);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.equal(eximidos(lab)[0].cita_cuando, despues);
  // sólo antes: no cuenta
  const solo = laboratorio({ sid: 's-cs-soloantes' });
  const antes2 = new Date().toISOString();
  mostrar(solo);
  solo.conversar([delAgente('Hay un crítico abierto.', antes2), delDev(frase, antes2)]);
  const r2 = waive(solo, frase);
  assert.notEqual(r2.status, 0);
  assert.match(`${r2.stdout}${r2.stderr}`, /de antes de que se le mostrara/);
});

test('CriticalShown_8_94_CasoReal273 @story-8.94 @ac-1 @ac-2 @ac-3 @ac-4 @ac-5', () => {
  const cw = require(path.join(SCRIPTS, 'lib', 'critical-waivers.js'));
  const lab = laboratorio({ sid: 's-cs-273', criticos: CRITICOS_273 });
  // el agente pide la muestra con el ejecutable en una variable: el arnés muestra los dos
  const p = puertaBash(lab, `M=${MARKER}; node "$M" waive-critical --rule ${REGLA} --file ${sh(ARCHIVO)} --reason ${sh(MOTIVO)}`);
  assert.equal(p.status, 0, p.stderr);
  const aviso = JSON.parse(p.stdout).systemMessage;
  assert.ok(aviso.includes(REGLA) && aviso.includes(LARGO), aviso);
  // la coordinadora contesta los dos en un mensaje, después de la muestra
  const cuerpo = `Eximo TEST-C1. Eximo ${LARGO} de pipeline.js.`;
  lab.conversar([deOtraSesion('coordinadora', cuerpo)]);
  designarCoordinadora(lab.home);
  const arnes = arnesConRelevo();
  for (const [rule, file, quote] of [[REGLA, ARCHIVO, 'Eximo TEST-C1'], [LARGO, PIPE_JS, `Eximo ${LARGO} de pipeline.js`]]) {
    const r = cw.okDeUnaPersona({
      approvedBy: 'Dev de Prueba', quote, relayedBy: 'coordinadora', arnes, home: lab.home,
      env: { HOME: lab.home, CLAUDE_CODE_SESSION_ID: lab.sid, TYCON_PROFILE: '0' }, desde: new Date(Date.now() - 60000).toISOString(),
      critico: { rule, file, reason: rule === REGLA ? MOTIVO : 'ningún criterio lo pide', storyId: '9.93', sessionId: lab.sid, stateDir: stateDirDe(lab), runDir: lab.runDir },
    });
    assert.equal(r.ok, true, `${rule}: ${r.motivo}`);
  }
});
