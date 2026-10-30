'use strict';
/**
 * critical-shown.test.js — el crítico que se quiere eximir se lo muestra el arnés a la persona antes de la ventana.
 *
 * El arnés le muestra a la persona el crítico que se quiere eximir (la puerta Bash antes de `marker.js waive-critical`,
 * o el despachador de ediciones al escribir `exencion-pedida.json`) y deja la constancia `critical-shown`. La exención
 * la aprueba la persona en la ventana de permiso, o la firma en su terminal: una respuesta en el chat no exime, y el
 * comando con la cita se niega.
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
const { inHarnessCopy } = require(path.join(SCRIPTS, '..', '..', '..', 'scripts', 'tests', 'lib', 'harness-copy.js'));
const REGLA = 'TEST-C1';
const ARCHIVO = '.advisors/tests-result.json';
const MOTIVO = 'test-gate.sh no reconoce pytest; la suite se corrió a mano: 12 pasaron';
const VENTANA = /aprobalo en la ventana de permiso que sale a continuación; si no, elegí «No»\. Una respuesta en el chat no lo exime\./;

function tmp(prefijo) { return fs.mkdtempSync(path.join(os.tmpdir(), prefijo)); }
const GIT_ENV = { ...process.env, GIT_AUTHOR_DATE: '2026-10-20T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-20T12:00:00Z' };

// Un repo con una story, un marcador abierto, findings.json con los críticos dados y una HOME propia.
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
  return { base, repo, home, story, sid, env, marker, runDir };
}

const sh = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
const comando = (rule = REGLA, file = ARCHIVO, reason = MOTIVO, extra = '') => `node ${MARKER} waive-critical --rule ${rule} --file ${sh(file)} --reason ${sh(reason)}${extra}`;

/**
 * La puerta Bash del portón de carril, como la corre Claude Code antes de un comando. Corre desde una copia propia del
 * arnés, igual que el guion que nombra el comando: el freno reconoce un guion del arnés según el estado de git del clon.
 */
function puertaBash(lab, command) {
  return spawnSync('node', [inHarnessCopy(path.join(SCRIPTS, 'on-bash-write-gate.js'))], {
    cwd: lab.repo, encoding: 'utf8',
    input: JSON.stringify({ session_id: lab.sid, tool_name: 'Bash', cwd: lab.repo, tool_input: { command: inHarnessCopy(command) } }),
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
const lineas = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const eximidos = (lab) => lineas(path.join(lab.runDir, 'critical-waivers.jsonl'));
const gates = (lab) => lineas(path.join(lab.home, '.claude', '.tycon-pipeline', 'gates.log'));
const muestras = (lab) => gates(lab).filter((x) => x.name === 'critical-shown');

test('CriticalShown_CitaPorElComando_YaNoExime — con la muestra, el comando con la cita no exime', () => {
  const lab = laboratorio({ sid: 's-cs-cli' });
  mostrar(lab);
  const r = lab.marker(['waive-critical', '--rule', REGLA, '--file', ARCHIVO, '--reason', MOTIVO, '--approved-by', 'Dev de Prueba', '--quote', 'eximo TEST-C1, la corrí a mano']);
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /la cita o el reenvío ya no eximen un crítico: lo aprueba la persona en la ventana de permiso/);
  assert.equal(eximidos(lab).length, 0);
  assert.equal(gates(lab).filter((g) => g.name === 'critical-waiver').length, 0);
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
  assert.match(aviso, VENTANA);
  assert.doesNotMatch(aviso, /contestá|«eximo /i, 'no enseña a contestar en el chat');
  const [g] = muestras(lab);
  assert.deepEqual([g.sessionId, g.story, g.rule, g.file], [lab.sid, '9.93', REGLA, ARCHIVO]);
  assert.ok(g.sha && g.ts);
  // ya mostrado con el mismo motivo: no lo repite
  assert.equal(mostrar(lab), '');
  // con otro motivo, sí
  assert.match(mostrar(lab, REGLA, ARCHIVO, 'otro motivo'), /otro motivo/);
  // --terminal: la persona lo ve en la terminal; la puerta no muestra nada
  const t = puertaBash(lab, comando(REGLA, ARCHIVO, 'por la terminal', ' --terminal'));
  assert.equal(t.stdout.trim(), '');
  // sin conversación legible también se muestra: la exención no sale de la conversación
  const sin = laboratorio({ sid: 's-cs-sin' });
  fs.rmSync(path.join(sin.home, '.claude', 'projects'), { recursive: true, force: true });
  assert.match(mostrar(sin), /TEST-C1/);
  assert.equal(muestras(sin).length, 1);
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
  assert.equal(muestras(lab).length, 0, 'fuera de la corrida no deja constancia');
  const propio = path.join(lab.runDir, 'exencion-pedida.json');
  fs.writeFileSync(propio, pedido);
  const d = despachar(lab, propio, pedido);
  assert.equal(d.status, 0, d.stderr);
  const aviso = JSON.parse(d.stdout).systemMessage;
  assert.match(aviso, /TEST-C1/);
  assert.match(aviso, /la suite completa/);
  assert.equal(muestras(lab).length, 1);
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

test('CriticalShown_PedidoVacio_RecuerdaElFormato @story-8.71 @ac-2', () => {
  const lab = laboratorio();
  // un pedido que es JSON pero no un objeto: recordatorio del formato, sin caerse
  const propio = path.join(lab.runDir, 'exencion-pedida.json');
  fs.writeFileSync(propio, 'null');
  const d = despachar(lab, propio, 'null');
  assert.equal(d.status, 0, d.stderr);
  assert.doesNotMatch(d.stderr, /TypeError/);
  assert.match(d.stdout, /rule.*file.*reason/);
});

test('CriticalShown_FindingsConOtraForma @story-8.71 @ac-1 @ac-5', () => {
  // envuelto en { findings: [...] }: se lee igual
  const a = laboratorio({ sid: 's-cs-env' });
  fs.writeFileSync(path.join(a.runDir, 'findings.json'), JSON.stringify({ findings: [{ rule_id: REGLA, file: ARCHIVO, severity: 'CRITICAL', summary: 'envuelto y leído' }] }));
  assert.ok(mostrar(a).includes('envuelto y leído'));
  // un objeto que no es una lista: el bloque avisa
  const b = laboratorio({ sid: 's-cs-obj' });
  fs.writeFileSync(path.join(b.runDir, 'findings.json'), '{}');
  assert.match(mostrar(b), /Aviso del arnés: no pude leer findings\.json/);
});

test('CriticalShown_Paso7YBloqueDicenLaVentana @story-8.77 @ac-7', () => {
  const paso = fs.readFileSync(path.join(SCRIPTS, '..', 'steps', 'step-09-findings.md'), 'utf8');
  assert.match(paso, /La ventana de permiso/);
  assert.match(paso, /sin\s+`--quote` ni `--relayed-by`/);
  assert.match(paso, /ya no exime/);
  const cd = require(path.join(SCRIPTS, 'lib', 'critical-display.js'));
  assert.equal(cd.juez, undefined, 'el juez de la respuesta en el chat ya no existe');
  assert.match(cd.bloque({ storyId: '9.93', rule: REGLA, file: ARCHIVO, reason: MOTIVO, arnes: tmp('cs-bloque-') }), VENTANA);
});

// ── el comando con una variable, todos los críticos juntos, los códigos largos ──────────────────────────────────────

const LARGO = 'ADV-false-negative-classification';
const PIPE_JS = 'skills/tycon-pipeline/scripts/pipeline.js';
const CRITICOS_273 = [{ rule_id: REGLA, file: ARCHIVO, summary: 'la suite completa no corrió' }, { rule_id: LARGO, file: PIPE_JS, summary: 'allowed.anthropic en los caminos del pipeline', reason: 'ningún criterio lo pide' }];
const stateDirDe = (lab) => path.join(lab.home, '.claude', '.tycon-pipeline');

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
  fs.writeFileSync(path.join(lab.runDir, 'critical-waivers.jsonl'), `${JSON.stringify({ rule_id: 'SEC-C2', file: 'app.js', reason: 'r', tipo: 'manual', quien: 'Dev de Prueba', via: 'ventana', ts: '2026-01-01T00:00:00.000Z' })}\n`);
  const aviso = mostrar(lab);
  assert.match(aviso, /TEST-C1/);
  assert.ok(aviso.includes(LARGO), aviso);
  assert.ok(aviso.includes('ningún criterio lo pide'), 'con el motivo del hallazgo');
  assert.doesNotMatch(aviso, /SEC-C2/);
  assert.match(aviso, /Son 2 críticos: se aprueban en la ventana de permiso, no en el chat\./);
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

test('CriticalShown_8_94_CasoReal273 @story-8.94 @ac-1 @ac-2', () => {
  const lab = laboratorio({ sid: 's-cs-273', criticos: CRITICOS_273 });
  // el agente pide la muestra con el ejecutable en una variable: el arnés muestra los dos, con el código largo entero
  const p = puertaBash(lab, `M=${MARKER}; node "$M" waive-critical --rule ${REGLA} --file ${sh(ARCHIVO)} --reason ${sh(MOTIVO)}`);
  assert.equal(p.status, 0, p.stderr);
  const aviso = JSON.parse(p.stdout).systemMessage;
  assert.ok(aviso.includes(REGLA) && aviso.includes(LARGO), aviso);
});

test('CriticalShown_AvisoCorto: tres renglones por crítico, sin perder lo que la persona lee para decidir', () => {
  // Claude Code antepone su propio rótulo a cada renglón del aviso: cada renglón de más es un aviso repetido en pantalla
  const lab = laboratorio();
  const aviso = mostrar(lab);
  assert.ok(aviso.split('\n').length <= 3, aviso);
  for (const t of ['TEST-C1', 'la suite completa', ARCHIVO, MOTIVO, 'la suite completa no corrió', 'ventana de permiso', 'va al commit sin arreglar']) {
    assert.ok(aviso.includes(t), `falta «${t}»:\n${aviso}`);
  }
  // varios juntos: tres por crítico y uno que dice dónde se aprueban, sin renglones vacíos
  const juntos = mostrar(laboratorio({ sid: 's-cs-corto', criticos: CRITICOS_273 }));
  assert.ok(juntos.split('\n').length <= 3 * 2 + 1, juntos);
  assert.doesNotMatch(juntos, /\n\n/);
  // el aviso de findings.json ilegible va en el mismo renglón
  const b = laboratorio({ sid: 's-cs-corto-ile' });
  fs.writeFileSync(path.join(b.runDir, 'findings.json'), '{ no es json');
  const ile = mostrar(b);
  assert.match(ile, /Aviso del arnés: no pude leer findings\.json/);
  assert.ok(ile.split('\n').length <= 4, ile);
});
