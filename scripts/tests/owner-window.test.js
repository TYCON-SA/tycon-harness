'use strict';
/**
 * owner-window.test.js — lo que decide el freno ante una firma del dueño y lo que verifica el guion de la firma.
 *
 * Todo en proceso: el evento, el árbol de procesos, la casa de la cuenta y la hora se pasan como parámetros. Ninguna
 * prueba finge nada por el ambiente; las que cambian `HOME` lo hacen para probar que no cuenta.
 *
 * Un árbol es una lista `{ pid, ppid, inicio, comando }`. El del freno: la herramienta (100), el freno (200) y su
 * consulta (201). El del guion: la herramienta (100), la consola con la envoltura medida (300) y el guion (301).
 *
 * stable-data: los «git commit» de abajo son textos que se le pasan al freno, no commits; la única hora real es la de la
 * corrida de pruebas en verde que la matriz pide reciente, y no se compara con ninguna fecha fija.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ow = require('../lib/owner-window.js');

const RAIZ = path.join(__dirname, '..', '..');
const MARKER = path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'marker.js');
const PIPELINE = path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'pipeline.js');
const E2E = path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'e2e-setup.js');
const CONTROLES = path.join(RAIZ, 'scripts', 'ci', 'run-base-controls.sh');
const AHORA = Date.parse('2026-10-27T13:00:00Z');
const INICIO = 'Tue Oct 27 10:00:00 2026';

function casaNueva(t) {
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-window-'));
  t.after(() => fs.rmSync(casa, { recursive: true, force: true }));
  // el marcador de la sesión destino: de ahí sale la story del texto
  const activos = path.join(casa, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(activos, { recursive: true });
  fs.writeFileSync(path.join(activos, 'ses-a.json'), JSON.stringify({ sessionId: 'ses-a', storyId: '9.99', storyPath: '/r/specs/story-9.99.md' }));
  return casa;
}

const herramienta = (extra = '') => ({ pid: 100, ppid: 1, inicio: INICIO, comando: `/Applications/x/native-binary/claude --output-format stream-json --verbose${extra}` });
const BASE = [{ pid: 1, ppid: 0, inicio: 'Mon Oct 26 08:00:00 2026', comando: '/sbin/launchd' }];

/**
 * La envoltura con la que la herramienta corre un comando (Mac, extensión 2.1.310). La consola de fondo
 * (`run_in_background`) va sin `< /dev/null`.
 */
function envolver(casa, cmd, { deFondo = false } = {}) {
  return `/bin/zsh -c source ${casa}/.claude/shell-snapshots/snapshot-zsh-1793030721191-z5n7vi.sh 2>/dev/null || true`
    + ' && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true'
    + " && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true"
    + ` && eval '${cmd.replace(/'/g, `'"'"'`)}'${deFondo ? '' : ' < /dev/null'} && pwd -P >| /tmp/claude-b725-cwd`;
}

function arbolDelFreno({ tool = herramienta(), extra = [] } = {}) {
  return [...BASE, tool,
    { pid: 200, ppid: 100, inicio: INICIO, comando: '/bin/bash /h/scripts/hooks/safety-guard-pre.sh' },
    { pid: 201, ppid: 200, inicio: INICIO, comando: 'node /h/scripts/lib/owner-window.js gate' }, ...extra];
}

/** El árbol del guion: la consola (con la envoltura, o la línea que se pase) lanzada por `padre`, y el guion. */
function arbolDelGuion(casa, cmd, { consola, padre = 100, tool = herramienta(), extra = [] } = {}) {
  return [...BASE, tool,
    { pid: 300, ppid: padre, inicio: INICIO, comando: consola || envolver(casa, cmd) },
    { pid: 301, ppid: 300, inicio: INICIO, comando: cmd }, ...extra];
}

const evento = (command, extra = {}) => ({ session_id: 'ses-a', tool_use_id: 'toolu_01', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...extra });
const pedir = (casa, cmd, o = {}) => ow.decidir({ evento: evento(cmd, o.evento), escapes: o.escapes || [], arbol: o.arbol || arbolDelFreno(), pid: 201, casa, ahora: o.ahora || AHORA, delegado: o.delegado });
const registros = (casa) => { try { return fs.readdirSync(ow.carpeta(casa)); } catch (_) { return []; } };
const vigentes = (casa) => registros(casa).filter((f) => f.endsWith('.json'));
const gates = (casa) => { try { return fs.readFileSync(path.join(casa, '.claude', '.tycon-pipeline', 'gates.log'), 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch (_) { return []; } };

// cada firma `guion` con su forma canónica: [firma, comando, argv del guion]
// la ventana de runtime-waiver muestra los criterios de una historia de verdad
const HISTORIA = historiaConCriterio();
const GUIONES = [
  ['plan-approval', `node ${MARKER} complete-step approve-plan --approved "dale, seguí"`, [MARKER, 'complete-step', 'approve-plan', '--approved', 'dale, seguí']],
  ['plan-approval', `node ${MARKER} approve-mockup --approved "va la maqueta"`, [MARKER, 'approve-mockup', '--approved', 'va la maqueta']],
  ['critical-waiver', `node ${MARKER} waive-critical --rule SEC-C1 --reason "lo cubre otra capa"`, [MARKER, 'waive-critical', '--rule', 'SEC-C1', '--reason', 'lo cubre otra capa']],
  ['manual-test', `node ${MARKER} mark-tested --acs 3`, [MARKER, 'mark-tested', '--acs', '3']],
  ['runtime-waiver', `node ${MARKER} runtime-waiver ${HISTORIA.story} --acs 1`, [MARKER, 'runtime-waiver', HISTORIA.story, '--acs', '1']],
  ['lost-run', `node ${MARKER} clear-session ses-b --lost`, [MARKER, 'clear-session', 'ses-b', '--lost']],
  ['lost-run', `node ${MARKER} restore ses-b`, [MARKER, 'restore', 'ses-b']],
  ['extra-round', `node ${PIPELINE} smart-reloop --iter 3 --extra-round`, [PIPELINE, 'smart-reloop', '--iter', '3', '--extra-round']],
  ['browser-test', `node ${E2E} prepare --repo /r --story s.md`, [E2E, 'prepare', '--repo', '/r', '--story', 's.md']],
  ['browser-test', `node ${E2E} defer --repo /r --story s.md --no "no, después"`, [E2E, 'defer', '--repo', '/r', '--story', 's.md', '--no', 'no, después']],
  ['control-change', `bash ${CONTROLES} approve`, [CONTROLES, 'approve']],
];

test('OwnerWindow_FirmaReconocida_PideVentanaYAnota (T7)', (t) => {
  for (const [firma, cmd] of GUIONES) {
    const casa = casaNueva(t);
    const r = pedir(casa, cmd);
    assert.strictEqual(r.decision, 'ask', `${cmd}: ${r.texto}`);
    assert.deepStrictEqual(r.firmas, [firma], cmd);
    const s = require('../lib/signatures.js').SIGNATURES.find((x) => x.id === firma);
    assert.ok(r.texto.includes(s.approves), `${cmd}: el texto dice qué aprueba`);
    assert.match(r.texto, /9\.99/, `${cmd}: el texto dice la story`);
    assert.match(r.texto, /ses-a/, `${cmd}: el texto dice la sesión destino`);
    const v = vigentes(casa);
    assert.strictEqual(v.length, 1, `${cmd}: un registro`);
    const reg = JSON.parse(fs.readFileSync(path.join(ow.carpeta(casa), v[0]), 'utf8'));
    assert.strictEqual(reg.firma, firma);
    assert.strictEqual(reg.sesion, 'ses-a');
    assert.strictEqual(reg.destino, 'ses-a');
    assert.strictEqual(reg.tool_use_id, 'toolu_01');
    assert.strictEqual(reg.sha256, crypto.createHash('sha256').update(cmd).digest('hex'));
    assert.deepStrictEqual(reg.herramienta, { pid: 100, inicio: INICIO });
  }
  // la cita del plan va en el detalle
  const casa = casaNueva(t);
  assert.match(pedir(casa, GUIONES[0][1]).texto, /dale, seguí/);
  // la sesión destino de otra pestaña sale del comando, y el texto la nombra
  const otra = pedir(casa, `node ${MARKER} mark-tested --acs 3 --for-session ses-z`);
  assert.strictEqual(otra.decision, 'ask');
  assert.match(otra.texto, /ses-z/);
  // un comando sin firma no pide nada
  assert.strictEqual(pedir(casa, `node ${MARKER} get`).decision, 'none');
  assert.strictEqual(pedir(casa, 'git status').decision, 'none');
});

test('OwnerWindow_GuionAprobado_FirmaConVentana (T8)', (t) => {
  for (const [firma, cmd, argv] of GUIONES) {
    const casa = casaNueva(t);
    assert.strictEqual(pedir(casa, cmd).decision, 'ask');
    const v = ow.verificar({ firma, argv, pid: 301, arbol: arbolDelGuion(casa, cmd), casa, ahora: AHORA + 60000 });
    assert.ok(v.ok, `${cmd}: ${v.motivo}`);
    assert.strictEqual(v.registro.destino, 'ses-a');
    assert.strictEqual(vigentes(casa).length, 0, `${cmd}: el registro quedó consumido`);
    ow.firmar({ firma, via: 'ventana', sesion: v.registro.sesion, destino: v.registro.destino, resumen: cmd, casa, ahora: AHORA + 60000 });
    const g = gates(casa).filter((x) => x.name === `${firma}-signed`);
    assert.strictEqual(g.length, 1, cmd);
    assert.strictEqual(g[0].via, 'ventana');
    assert.strictEqual(g[0].sesion, 'ses-a');
    assert.strictEqual(g[0].destino, 'ses-a');
  }
});

test('OwnerWindow_FirmaEscondida_NoFirma (T9)', (t) => {
  const [firma, cmd, argv] = GUIONES[0];
  const casa = casaNueva(t);
  const terminal = /--terminal/;
  // sin registro: la forma canónica corrida por la herramienta, pero el freno no la vio
  let v = ow.verificar({ firma, argv, pid: 301, arbol: arbolDelGuion(casa, cmd), casa, ahora: AHORA });
  assert.strictEqual(v.ok, false);
  assert.match(v.motivo, /esta firma no pasó por la ventana/);
  assert.match(v.motivo, terminal);
  // escondida: el padre del guion no es la consola de la herramienta, aunque haya un registro de la forma canónica
  pedir(casa, cmd);
  const padres = [
    `node -e "require('child_process').spawnSync('node', ['${MARKER}','complete-step','approve-plan','--approved','dale, seguí'])"`,
    `python3 -c "import subprocess; subprocess.run(['node','${MARKER}'])"`,
    `bash -c 'node ${MARKER} complete-step approve-plan --approved "dale, seguí"'`,
    'bash /tmp/mio.sh',
  ];
  for (const p of padres) {
    v = ow.verificar({ firma, argv, pid: 301, arbol: arbolDelGuion(casa, cmd, { consola: p }), casa, ahora: AHORA });
    assert.strictEqual(v.ok, false, p);
    assert.match(v.motivo, /esta firma no pasó por la ventana/, p);
  }
  // la consola de la herramienta corre otra cosa (`node -e`, una variable con el nombre) que lanza el guion
  for (const otro of [`node -e "x"`, `G=${MARKER}; node $G complete-step approve-plan --approved "dale, seguí"`]) {
    v = ow.verificar({ firma, argv, pid: 301, arbol: arbolDelGuion(casa, otro), casa, ahora: AHORA });
    assert.strictEqual(v.ok, false, otro);
  }
  // un proceso de fondo de la herramienta (una consola que no es la padre del guion) no ayuda
  v = ow.verificar({ firma, argv, pid: 301, arbol: arbolDelGuion(casa, cmd, { consola: 'bash /tmp/fondo.sh', extra: [{ pid: 400, ppid: 100, inicio: INICIO, comando: envolver(casa, 'sleep 99') }] }), casa, ahora: AHORA });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(vigentes(casa).length, 1, 'nada lo consumió');
  assert.strictEqual(gates(casa).length, 0, 'nada escrito');
  // del lado del freno: la forma no canónica se niega con la forma exacta
  const r = pedir(casa, `cd /r && ${cmd}`);
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.texto, /forma/);
  assert.match(r.texto, terminal);
});

test('OwnerWindow_RegistroAjenoOForjado_NoVale (T10)', (t) => {
  const [firma, cmd, argv] = GUIONES[0];
  const arbol = (casa, o) => arbolDelGuion(casa, cmd, o);
  // consumido
  let casa = casaNueva(t);
  pedir(casa, cmd);
  assert.ok(ow.verificar({ firma, argv, pid: 301, arbol: arbol(casa), casa, ahora: AHORA }).ok);
  assert.strictEqual(ow.verificar({ firma, argv, pid: 301, arbol: arbol(casa), casa, ahora: AHORA }).ok, false, 'consumido');
  // vencido
  casa = casaNueva(t);
  pedir(casa, cmd);
  assert.strictEqual(ow.verificar({ firma, argv, pid: 301, arbol: arbol(casa), casa, ahora: AHORA + 31 * 60000 }).ok, false, 'vencido');
  // de otra sesión: la consola es de otra herramienta (otro pid, u otro arranque con el mismo pid)
  casa = casaNueva(t);
  pedir(casa, cmd);
  const otraTool = { ...herramienta(), pid: 150 };
  assert.strictEqual(ow.verificar({ firma, argv, pid: 301, arbol: arbol(casa, { padre: 150, extra: [otraTool] }), casa, ahora: AHORA }).ok, false, 'otra herramienta');
  assert.strictEqual(ow.verificar({ firma, argv, pid: 301, arbol: arbol(casa, { tool: { ...herramienta(), inicio: 'Tue Oct 27 11:00:00 2026' } }), casa, ahora: AHORA }).ok, false, 'otro arranque');
  // otro sha256: la consola corre otro comando
  const otro = `node ${MARKER} complete-step approve-plan --approved "otra cita"`;
  assert.strictEqual(ow.verificar({ firma, argv: [MARKER, 'complete-step', 'approve-plan', '--approved', 'otra cita'], pid: 301, arbol: arbolDelGuion(casa, otro), casa, ahora: AHORA }).ok, false, 'otro sha');
  // los argumentos del guion no son los del comando
  assert.strictEqual(ow.verificar({ firma, argv: [MARKER, 'complete-step', 'approve-plan', '--approved', 'x'], pid: 301, arbol: arbol(casa), casa, ahora: AHORA }).ok, false, 'otros argumentos');
  assert.strictEqual(vigentes(casa).length, 1, 'el registro sigue ahí');
  // forjado: escrito por fuera del freno, con un comando que no tiene la forma canónica
  casa = casaNueva(t);
  const forjado = `cd /r && ${cmd}`;
  fs.mkdirSync(ow.carpeta(casa), { recursive: true });
  fs.writeFileSync(path.join(ow.carpeta(casa), 'plan-approval--ses-a--ses-a.json'), JSON.stringify({
    firma, sesion: 'ses-a', destino: 'ses-a', tool_use_id: 'x', sha256: crypto.createHash('sha256').update(forjado).digest('hex'),
    comando: forjado, herramienta: { pid: 100, inicio: INICIO }, ts: new Date(AHORA).toISOString(),
  }));
  assert.strictEqual(ow.verificar({ firma, argv, pid: 301, arbol: arbolDelGuion(casa, forjado), casa, ahora: AHORA }).ok, false, 'forjado sin la forma canónica');
  // forjado con la forma canónica, corrido por un proceso de fondo (`bash -c` hijo de otra consola de la herramienta)
  fs.writeFileSync(path.join(ow.carpeta(casa), 'plan-approval--ses-a--ses-a.json'), JSON.stringify({
    firma, sesion: 'ses-a', destino: 'ses-a', tool_use_id: 'x', sha256: crypto.createHash('sha256').update(cmd).digest('hex'),
    comando: cmd, herramienta: { pid: 100, inicio: INICIO }, ts: new Date(AHORA).toISOString(),
  }));
  const fondo = [...BASE, herramienta(),
    { pid: 290, ppid: 100, inicio: INICIO, comando: envolver(casa, 'bash /tmp/lanza.sh &') },
    { pid: 300, ppid: 290, inicio: INICIO, comando: `bash -c ${cmd}` },
    { pid: 301, ppid: 300, inicio: INICIO, comando: cmd }];
  assert.strictEqual(ow.verificar({ firma, argv, pid: 301, arbol: fondo, casa, ahora: AHORA }).ok, false, 'forjado corrido de fondo');
  assert.strictEqual(gates(casa).length, 0, 'nada escrito');
});

test('OwnerWindow_PedidoNuevo_ReemplazaAlAnterior (T11)', (t) => {
  const [firma, cmd, argv] = GUIONES[0];
  const casa = casaNueva(t);
  assert.strictEqual(pedir(casa, cmd).decision, 'ask');
  assert.strictEqual(pedir(casa, cmd, { ahora: AHORA + 1000 }).decision, 'ask');
  assert.strictEqual(vigentes(casa).length, 1, 'un solo registro vigente');
  assert.ok(registros(casa).some((f) => /vencido/.test(f)), 'el viejo quedó vencido');
  // dos ventanas abiertas: el primer «Sí» firma, el segundo no
  assert.ok(ow.verificar({ firma, argv, pid: 301, arbol: arbolDelGuion(casa, cmd), casa, ahora: AHORA + 2000 }).ok);
  assert.strictEqual(ow.verificar({ firma, argv, pid: 301, arbol: arbolDelGuion(casa, cmd), casa, ahora: AHORA + 3000 }).ok, false);
});

test('OwnerWindow_DespuesDeUnNo_OtraVentana (T12)', (t) => {
  const [firma, cmd, argv] = GUIONES[0];
  const casa = casaNueva(t);
  // la persona dijo «No»: el guion no corrió y el registro quedó; el pedido nuevo abre otra ventana
  pedir(casa, cmd);
  const r = pedir(casa, cmd, { ahora: AHORA + 5 * 60000 });
  assert.strictEqual(r.decision, 'ask');
  // un registro de más de 30 minutos no firma
  assert.strictEqual(ow.verificar({ firma, argv, pid: 301, arbol: arbolDelGuion(casa, cmd), casa, ahora: AHORA + 36 * 60000 }).ok, false);
  assert.ok(ow.verificar({ firma, argv, pid: 301, arbol: arbolDelGuion(casa, cmd), casa, ahora: AHORA + 34 * 60000 }).ok, 'el nuevo vale');
});

test('OwnerWindow_Codex_Niega (T13)', (t) => {
  for (const [, cmd] of GUIONES) {
    const casa = casaNueva(t);
    const r = pedir(casa, cmd, { evento: { turn_id: 'turn-1' } });
    assert.strictEqual(r.decision, 'deny', cmd);
    assert.match(r.texto, /--terminal|en tu terminal/, cmd);
    assert.strictEqual(registros(casa).length, 0, cmd);
  }
  const casa = casaNueva(t);
  const r = pedir(casa, 'TYCON_TEST_GATE=1 bash test-gate.sh', { evento: { turn_id: 'turn-1' }, escapes: ['escape:TYCON_TEST_GATE'] });
  assert.strictEqual(r.decision, 'deny');
});

test('OwnerWindow_SinPantalla_NiegaConLaTerminal (T14)', (t) => {
  for (const extra of [' -p', ' --print', ' --print=json']) {
    for (const [firma, cmd] of GUIONES) {
      const casa = casaNueva(t);
      const r = pedir(casa, cmd, { arbol: arbolDelFreno({ tool: herramienta(extra) }) });
      assert.strictEqual(r.decision, 'deny', `${extra} ${cmd}`);
      const s = require('../lib/signatures.js').SIGNATURES.find((x) => x.id === firma);
      assert.ok(r.texto.includes(s.terminal), `${cmd}: nombra el comando de la terminal`);
      assert.strictEqual(registros(casa).length, 0, 'sin registro');
    }
  }
  // `-p` como argumento de otra opción no es la bandera
  const casa = casaNueva(t);
  assert.strictEqual(pedir(casa, GUIONES[0][1], { arbol: arbolDelFreno({ tool: herramienta(' --permission-prompt-tool=stdio') }) }).decision, 'ask');
});

test('OwnerWindow_Terminal_FirmaYSinTtySaleDos (T15)', (t) => {
  let casa = casaNueva(t);
  let preguntado = '';
  const mac = { windows: false, hay: () => true, preguntar: (m) => { preguntado = m; return 'firmo'; } };
  let r = ow.porTerminal({ firma: 'plan-approval', destino: 'ses-a', resumen: 'aprobar el plan', casa, ahora: AHORA, tty: mac });
  assert.strictEqual(r.codigo, 0);
  assert.match(preguntado, /aprobar el plan de una story/);
  assert.strictEqual(gates(casa).find((g) => g.name === 'plan-approval-signed').via, 'terminal');
  // otra respuesta: no firma
  casa = casaNueva(t);
  r = ow.porTerminal({ firma: 'plan-approval', destino: 'ses-a', casa, ahora: AHORA, tty: { ...mac, preguntar: () => 'si' } });
  assert.strictEqual(r.codigo, 1);
  assert.strictEqual(gates(casa).length, 0);
  // sin terminal: sale 2 sin escribir
  r = ow.porTerminal({ firma: 'plan-approval', destino: 'ses-a', casa, ahora: AHORA, tty: { ...mac, hay: () => false } });
  assert.strictEqual(r.codigo, 2);
  assert.strictEqual(gates(casa).length, 0);
  // Windows: la ventana nueva y las tres palabras
  r = ow.porTerminal({ firma: 'critical-waiver', destino: 'ses-a', casa, ahora: AHORA, tty: { windows: true, hay: () => true, confirmarFrase: () => true } });
  assert.strictEqual(r.codigo, 0);
  assert.strictEqual(gates(casa).find((g) => g.name === 'critical-waiver-signed').via, 'terminal');
  r = ow.porTerminal({ firma: 'critical-waiver', destino: 'ses-a', casa, ahora: AHORA, tty: { windows: true, hay: () => true, confirmarFrase: () => false } });
  assert.strictEqual(r.codigo, 1);
  // cada firma del catálogo con comando tiene su forma de terminal
  for (const s of require('../lib/signatures.js').SIGNATURES) {
    if (s.kind === 'guion' && s.otherSession !== 'pending' && s.id !== 'runtime-waiver') assert.match(s.terminal, /--terminal/, s.id);
  }
});

/** Una historia con un criterio declarado imposible de probar en vivo, cuya prueba corrió en verde: queda pendiente de firma. */
function historiaConCriterio(t) {
  // en una carpeta propia: la matriz mira las hermanas del repo, y las de la carpeta temporal son miles
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-crit-'));
  if (t) t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  else process.on('exit', () => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  assert.strictEqual(spawnSync('git', ['init', '-q', repo]).status, 0);
  const story = path.join(repo, 'specs', 'story-9.91-juguete.md');
  fs.writeFileSync(story, ['---', 'story: "9.91"', 'status: in-progress', 'runtime_not_verifiable:', '  - ac: 1', '    reason: "el servicio externo no tiene ambiente de prueba"',
    '    covered_by: T1', '---', '', '# Story 9.91', '', '## Acceptance Criteria', '', '1. **Given** un pedido **Then** el aviso queda en el servicio externo.',
    '2. **Given** otro pedido **Then** se ve en pantalla.', '', '### Tests', '', '| # | Test | AC | Nivel | Escenario | Resultado esperado |', '|---|---|---|---|---|---|',
    '| T1 | `Aviso_QuedaRegistrado` | 1 | unit | x | y |', ''].join('\n'));
  fs.mkdirSync(path.join(repo, '.advisors'));
  fs.writeFileSync(path.join(repo, '.advisors', 'tests-result.json'), JSON.stringify({ ts: new Date().toISOString(), story_id: '9.91', suite_green: true }));
  return { repo, story };
}

test('OwnerWindow_RuntimeWaiver_PasaPorLaVentana (T16)', (t) => {
  const { repo, story } = historiaConCriterio(t);
  // la ventana muestra cada criterio con su texto, por qué no se prueba en vivo y qué lo cubre: no sólo el número
  for (const cmd of [`node ${MARKER} runtime-waiver ${story} --acs 1`, `node ${MARKER} runtime-waiver ${story}`]) {
    const r = pedir(casaNueva(t), cmd);
    assert.strictEqual(r.decision, 'ask', r.texto);
    assert.deepStrictEqual(r.firmas, ['runtime-waiver']);
    assert.match(r.texto, /AC 1: Given un pedido Then el aviso queda en el servicio externo\./, cmd);
    assert.match(r.texto, /el servicio externo no tiene ambiente de prueba/);
    assert.match(r.texto, /T1/);
    assert.doesNotMatch(r.texto, /AC 2/);
  }
  // la historia con la ruta relativa al directorio del pedido
  const rel = pedir(casaNueva(t), `node ${MARKER} runtime-waiver specs/story-9.91-juguete.md --acs 1`, { evento: { cwd: repo } });
  assert.strictEqual(rel.decision, 'ask', rel.texto);
  assert.match(rel.texto, /AC 1: Given un pedido/);
  // sin criterios que mostrar, el dueño firmaría a ciegas: se niega con la terminal
  for (const cmd of [`node ${MARKER} runtime-waiver /r/specs/story-9.99.md`, `node ${MARKER} runtime-waiver ${story} --acs 2`]) {
    const r = pedir(casaNueva(t), cmd);
    assert.strictEqual(r.decision, 'deny', cmd);
    assert.match(r.texto, /criterio/);
    assert.match(r.texto, /--terminal/);
  }
});

test('OwnerWindow_VariableDeSesion_SeNiega (T17)', (t) => {
  for (const v of ['CLAUDE_CODE_SESSION_ID', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID']) {
    for (const cmd of [`${v}=ses-b node ${MARKER} mark-tested --acs 3`, `export ${v}=ses-b; node ${MARKER} mark-tested --acs 3`]) {
      const casa = casaNueva(t);
      const r = pedir(casa, cmd);
      assert.strictEqual(r.decision, 'deny', cmd);
      assert.match(r.texto, /la sesión destino va con --for-session/, cmd);
      assert.strictEqual(registros(casa).length, 0);
    }
  }
});

test('OwnerWindow_ProcesoDeFondo_Niega (T18)', (t) => {
  const [, cmd] = GUIONES[0];
  let casa = casaNueva(t);
  const fondo = { pid: 400, ppid: 100, inicio: INICIO, comando: envolver(casa, 'sleep 600') };
  let r = pedir(casa, cmd, { arbol: arbolDelFreno({ extra: [fondo] }) });
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.texto, /cerrá los procesos de fondo o firmá desde tu terminal/);
  assert.strictEqual(registros(casa).length, 0);
  // la consola de fondo como la lanza la herramienta, sin `< /dev/null`: también niega
  casa = casaNueva(t);
  r = pedir(casa, cmd, { arbol: arbolDelFreno({ extra: [{ ...fondo, comando: envolver(casa, 'sleep 600', { deFondo: true }) }] }) });
  assert.strictEqual(r.decision, 'deny', r.texto);
  assert.match(r.texto, /cerrá los procesos de fondo o firmá desde tu terminal/);
  assert.strictEqual(registros(casa).length, 0);
  // los servidores de herramientas y los otros frenos no cuentan
  casa = casaNueva(t);
  r = pedir(casa, cmd, { arbol: arbolDelFreno({ extra: [
    { pid: 410, ppid: 100, inicio: INICIO, comando: 'node /Users/x/.claude/plugins/engram/mcp-server.js' },
    { pid: 411, ppid: 100, inicio: INICIO, comando: 'bun run /Users/x/.claude/plugins/telegram/server.ts' },
    { pid: 412, ppid: 100, inicio: INICIO, comando: '/bin/sh -c node /h/scripts/hooks/test-scope-guard-pre.js' },
  ] }) });
  assert.strictEqual(r.decision, 'ask', r.texto);
  // una herramienta lanzada desde una consola de otra herramienta (el agente la abrió): se niega
  casa = casaNueva(t);
  const anidada = [...BASE, { ...herramienta(), pid: 50, ppid: 1 }, { pid: 60, ppid: 50, inicio: INICIO, comando: envolver(casa, 'claude') }, { ...herramienta(), ppid: 60 },
    { pid: 200, ppid: 100, inicio: INICIO, comando: '/bin/bash /h/scripts/hooks/safety-guard-pre.sh' },
    { pid: 201, ppid: 200, inicio: INICIO, comando: 'node /h/scripts/lib/owner-window.js gate' }];
  r = pedir(casa, cmd, { arbol: anidada });
  assert.strictEqual(r.decision, 'deny');
});

test('OwnerWindow_Indecidible_Niega (T19)', (t) => {
  const [firma, cmd, argv] = GUIONES[0];
  const terminal = /--terminal/;
  // árbol ilegible (también Windows, que no lo lee)
  let casa = casaNueva(t);
  let r = ow.decidir({ evento: evento(cmd), arbol: null, pid: 201, casa, ahora: AHORA });
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.texto, terminal);
  assert.strictEqual(ow.leerArbol({ plataforma: 'win32' }), null);
  // sin la herramienta entre los padres
  r = ow.decidir({ evento: evento(cmd), arbol: [...BASE, { pid: 201, ppid: 1, inicio: INICIO, comando: 'node x' }], pid: 201, casa, ahora: AHORA });
  assert.strictEqual(r.decision, 'deny');
  // una envoltura que no coincide con la medida (del lado del guion)
  pedir(casa, cmd);
  const rara = envolver(casa, cmd).replace('pwd -P >|', 'pwd >');
  assert.strictEqual(ow.verificar({ firma, argv, pid: 301, arbol: arbolDelGuion(casa, cmd, { consola: rara }), casa, ahora: AHORA }).ok, false);
  assert.strictEqual(ow.verificar({ firma, argv, pid: 301, arbol: null, casa, ahora: AHORA }).ok, false);
  // el registro no se puede escribir
  casa = casaNueva(t);
  fs.mkdirSync(path.dirname(ow.carpeta(casa)), { recursive: true });
  fs.writeFileSync(ow.carpeta(casa), 'no soy una carpeta');
  r = pedir(casa, cmd);
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.texto, terminal);
  // la casa de la cuenta no se resuelve
  r = ow.decidir({ evento: evento(cmd), arbol: arbolDelFreno(), pid: 201, ahora: AHORA, userInfo: () => { throw new Error('sin cuenta'); } });
  assert.strictEqual(r.decision, 'deny');
  // la delegación no se pudo consultar (el perfil roto)
  casa = casaNueva(t);
  r = pedir(casa, `node ${MARKER} set-check dod green --force-manual`, { escapes: ['escape:force-manual'], delegado: () => { throw new Error('perfil roto'); } });
  assert.strictEqual(r.decision, 'deny');
  // una firma que el catálogo no conoce, o que no se pide por consola
  for (const e of ['escape:NO_EXISTE', 'escape:dod_runtime_exempt']) {
    r = pedir(casa, 'echo hola', { escapes: [e] });
    assert.strictEqual(r.decision, 'deny', e);
  }
  // sin sesión legible en el evento
  r = ow.decidir({ evento: { ...evento(cmd), session_id: '../x' }, arbol: arbolDelFreno(), pid: 201, casa, ahora: AHORA });
  assert.strictEqual(r.decision, 'deny');
  // el lector del comando se cae: un comando que nombra un guion de firma se niega; uno que no lo nombra sigue de largo
  const lector = require(path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'marker-command.js'));
  const { llamadas, tramos } = lector;
  const cae = () => { throw new Error('el lector se cayó'); };
  lector.llamadas = cae;
  lector.tramos = cae;
  try {
    for (const [, c] of GUIONES) {
      r = pedir(casaNueva(t), c);
      assert.strictEqual(r.decision, 'deny', c);
      assert.match(r.texto, /no se pudo leer el comando/);
    }
    assert.strictEqual(pedir(casaNueva(t), 'echo hola').decision, 'none');
  } finally {
    lector.llamadas = llamadas;
    lector.tramos = tramos;
  }
});

test('OwnerWindow_CasaFalsa_NoVale (T20)', (t) => {
  const [firma, cmd, argv] = GUIONES[0];
  const real = casaNueva(t);
  const falsa = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-window-falsa-'));
  t.after(() => fs.rmSync(falsa, { recursive: true, force: true }));
  const antes = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, TYCON_HOME: process.env.TYCON_HOME };
  t.after(() => { for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  process.env.HOME = falsa; process.env.USERPROFILE = falsa; process.env.TYCON_HOME = path.join(falsa, '.tycon');
  const userInfo = () => ({ homedir: real });
  const r = ow.decidir({ evento: evento(cmd), arbol: arbolDelFreno(), pid: 201, ahora: AHORA, userInfo });
  assert.strictEqual(r.decision, 'ask');
  assert.strictEqual(vigentes(real).length, 1, 'escribió en la casa de la cuenta');
  assert.strictEqual(vigentes(falsa).length, 0, 'nada en la casa falsa');
  // un registro plantado en la casa falsa no vale, y el de la casa de la cuenta sí
  fs.mkdirSync(ow.carpeta(falsa), { recursive: true });
  fs.copyFileSync(path.join(ow.carpeta(real), vigentes(real)[0]), path.join(ow.carpeta(falsa), 'plan-approval--ses-a--ses-a.json'));
  fs.rmSync(ow.carpeta(real), { recursive: true });
  assert.strictEqual(ow.verificar({ firma, argv, pid: 301, arbol: arbolDelGuion(real, cmd), ahora: AHORA, userInfo }).ok, false);
});

test('OwnerWindow_FirmaDelFreno_VentanaSinRegistro (T34)', (t) => {
  const forma = [
    ['escape:TYCON_TEST_GATE', 'TYCON_TEST_GATE=1 bash scripts/test-gate.sh /r /r/s.md'],
    ['escape:TYCON_SAFETY_OFF', 'TYCON_SAFETY_OFF=1 git push --force origin x'],
    ['escape:TYCON_PROD_LINT', 'TYCON_PROD_LINT=0 git commit -m x'],
    ['escape:set-autonomous', `node ${MARKER} set-autonomous false`],
    ['escape:cerrar-la-ejecucion', `node ${MARKER} clear`],
    ['escape:trust-ran', `node ${PIPELINE} check-count --trust-ran`],
  ];
  for (const [e, cmd] of forma) {
    const casa = casaNueva(t);
    const r = pedir(casa, cmd, { escapes: [e], delegado: () => ({ ok: false, motivo: 'no delegado' }) });
    assert.strictEqual(r.decision, 'ask', `${cmd}: ${r.texto}`);
    const s = require('../lib/signatures.js').SIGNATURES.find((x) => x.id === e);
    assert.ok(r.texto.includes(s.approves), cmd);
    assert.strictEqual(registros(casa).length, 0, `${cmd}: sin registro`);
  }
  const escondida = [
    ['escape:TYCON_TEST_GATE', 'export TYCON_TEST_GATE=1; bash scripts/test-gate.sh /r /r/s.md'],
    ['escape:TYCON_TEST_GATE', 'env TYCON_TEST_GATE=1 bash scripts/test-gate.sh /r /r/s.md'],
    ['escape:TYCON_TEST_GATE', 'V=TYCON_TEST_GATE; export $V=1; bash scripts/test-gate.sh'],
    ['escape:set-autonomous', `cd /r && node ${MARKER} set-autonomous false`],
    ['escape:set-autonomous', `S=set-autonomous; node ${MARKER} $S false`],
  ];
  for (const [e, cmd] of escondida) {
    const casa = casaNueva(t);
    const r = pedir(casa, cmd, { escapes: [e], delegado: () => ({ ok: false }) });
    assert.strictEqual(r.decision, 'deny', cmd);
    assert.match(r.texto, /terminal/, cmd);
  }
});

test('OwnerWindow_DelegacionAprobada_SigueHastaLaTandaC (decisión 23)', (t) => {
  // force-manual y trust-ran: la delegación del dueño (delegated-ok.js) vale primero; si no, la ventana
  const casa = casaNueva(t);
  const cmd = `node ${MARKER} set-check advisors green --force-manual`;
  let pedido = null;
  let r = pedir(casa, cmd, { escapes: ['escape:force-manual'], delegado: (o) => { pedido = o; return { ok: true, relevo: 'coordinadora' }; } });
  assert.strictEqual(r.decision, 'allow');
  assert.strictEqual(r.via, 'delegacion');
  assert.strictEqual(pedido.firma, 'escape:force-manual');
  assert.strictEqual(pedido.sesion, 'ses-a');
  r = pedir(casa, cmd, { escapes: ['escape:force-manual'], delegado: () => ({ ok: false, motivo: 'no' }) });
  assert.strictEqual(r.decision, 'ask');
  // la vuelta extra: la bandera decide, igual que en pipeline.js. Con --delegated no hay ventana (la delegación la
  // juzga pipeline.js); sin ella, la ventana, haya o no delegación vigente
  const extra = GUIONES.find((g) => g[0] === 'extra-round')[1];
  let consultada = false;
  r = pedir(casa, `${extra} --delegated`, { delegado: () => { consultada = true; return { ok: false }; } });
  assert.strictEqual(r.decision, 'none');
  assert.strictEqual(consultada, false, 'el freno no juzga la delegación de la vuelta extra');
  assert.strictEqual(vigentes(casa).length, 0, 'sin registro: pipeline.js toma la rama delegada');
  r = pedir(casa, extra, { delegado: () => ({ ok: true }) });
  assert.strictEqual(r.decision, 'ask', 'sin --delegated pipeline.js exige la ventana: el freno la pide');
});

test('OwnerWindow_FirmaPorOtraHerramienta_SeNiega (pase adversarial)', (t) => {
  // el Sí del dueño es de la consola: otra herramienta que corre la misma envoltura (Monitor) no firma ni escapa
  const casa = casaNueva(t);
  for (const [, cmd] of GUIONES) {
    const r = pedir(casa, cmd, { evento: { tool_name: 'Monitor' } });
    assert.strictEqual(r.decision, 'deny', cmd);
    assert.match(r.texto, /Monitor/);
  }
  assert.strictEqual(pedir(casa, `node ${MARKER} set-check advisors green --force-manual`, { escapes: ['escape:force-manual'], evento: { tool_name: 'Monitor' } }).decision, 'deny');
  assert.strictEqual(vigentes(casa).length, 0);
  assert.strictEqual(pedir(casa, 'tail -f x.log', { evento: { tool_name: 'Monitor' } }).decision, 'none');
  // el freno se registra también para Monitor
  const lista = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'setup', 'hooks-list.json'), 'utf8'));
  const freno = JSON.stringify(lista).match(/"matcher":\s*"([^"]+)",\s*"spec":\s*"@tcg:safety-guard-pre\.sh"/);
  assert.ok(freno && freno[1].split('|').includes('Monitor'), `matcher del freno: ${freno && freno[1]}`);
});

test('OwnerWindow_FormaQueElGuionNiega_NoPideVentana (pase adversarial)', (t) => {
  // la cita, el reenvío o el --ok ya no firman: el freno lo dice sin mostrarle al dueño una ventana que no sirve
  const casa = casaNueva(t);
  for (const cmd of [`node ${PIPELINE} smart-reloop --iter 3 --extra-round --approved-by x --quote "dale"`,
    `node ${MARKER} waive-critical --rule SEC-C1 --reason "x" --quote "dale"`, `node ${MARKER} mark-tested --acs 1 --relayed-by coord`,
    `node ${MARKER} runtime-waiver ${HISTORIA.story} --acs 1 --quote "dale"`, `node ${E2E} prepare --repo /r --story s.md --ok "dale"`]) {
    const r = pedir(casa, cmd);
    assert.strictEqual(r.decision, 'deny', cmd);
    assert.match(r.texto, /ya no firma/);
  }
  assert.strictEqual(vigentes(casa).length, 0);
  // aprobar el plan: la firma la piden --approved o --mockup-approved, también con --auto-approved; sin ellas, nada
  assert.deepStrictEqual(ow.firmasDelComando(`node ${MARKER} complete-step approve-plan --auto-approved LOW --approved "dale"`), ['plan-approval']);
  assert.deepStrictEqual(ow.firmasDelComando(`node ${MARKER} complete-step 3 --auto-approved LOW --approved "dale"`), ['plan-approval']);
  assert.deepStrictEqual(ow.firmasDelComando(`node ${MARKER} complete-step approve-plan`), []);
  assert.deepStrictEqual(ow.firmasDelComando(`node ${MARKER} complete-step approve-plan --auto-approved LOW`), []);
  assert.deepStrictEqual(ow.firmasDelComando(`node ${MARKER} complete-step approve-plan --auto-approved LOW --mockup-approved "va"`), ['plan-approval']);
});

test('OwnerWindow_PedidosRepetidos_GanaElUltimo (pase adversarial)', (t) => {
  const casa = casaNueva(t);
  const cmd = `node ${MARKER} mark-tested --acs 3 --for-session ses-m`;
  const argv = [MARKER, 'mark-tested', '--acs', '3', '--for-session', 'ses-m'];
  for (const [sesion, ahora] of [['ses-zzz', AHORA], ['ses-aaa', AHORA + 1000]]) {
    ow.decidir({ evento: evento(cmd, { session_id: sesion }), arbol: arbolDelFreno(), pid: 201, casa, ahora });
  }
  const v = ow.verificar({ firma: 'manual-test', argv, pid: 301, arbol: arbolDelGuion(casa, cmd), casa, ahora: AHORA + 2000, destino: 'ses-m' });
  assert.ok(v.ok, v.motivo);
  assert.strictEqual(v.registro.sesion, 'ses-aaa', 'el pedido más nuevo');
  assert.strictEqual(vigentes(casa).length, 0, 'el viejo queda vencido');
});

test('OwnerWindow_ArgumentoConTilde_Firma (pase adversarial)', (t) => {
  const casa = casaNueva(t);
  const cmd = `node ${MARKER} waive-critical --rule SEC-C1 --file ~/r/a.ts --reason "x"`;
  assert.strictEqual(pedir(casa, cmd).decision, 'ask');
  const v = ow.verificar({ firma: 'critical-waiver', argv: [MARKER, 'waive-critical', '--rule', 'SEC-C1', '--file', path.join(os.homedir(), 'r', 'a.ts'), '--reason', 'x'],
    pid: 301, arbol: arbolDelGuion(casa, cmd), casa, ahora: AHORA + 1000 });
  assert.ok(v.ok, v.motivo);
});

test('OwnerWindow_ConsolasYHerramientasDeOtraInstalacion (pase adversarial)', (t) => {
  const casa = casaNueva(t);
  // la envoltura de bash (con su shopt) y una consola de Homebrew se desenvuelven igual
  const bash = envolver(casa, 'x').replace('/bin/zsh', '/opt/homebrew/bin/bash').replace('snapshot-zsh', 'snapshot-bash')
    .replace(" && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true", ' && shopt -u extglob 2>/dev/null || true');
  assert.strictEqual(ow.desenvolver(bash, casa), 'x');
  // Claude Desktop: su copia de Claude Code vive en una ruta con espacios; la app misma no es la herramienta
  const desk = `${casa}/Library/Application Support/Claude/claude-code/2.1.308/claude`;
  assert.strictEqual(ow.esHerramienta({ comando: `${desk} --output-format stream-json`, ejecutable: desk }), true);
  assert.strictEqual(ow.esHerramienta({ comando: '/Applications/Claude.app/Contents/MacOS/Claude', ejecutable: '/Applications/Claude.app/Contents/MacOS/Claude' }), false);
  assert.strictEqual(ow.esHerramienta({ comando: '/Applications/Claude.app/Contents/MacOS/Claude' }), false);
  assert.strictEqual(ow.esHerramienta({ comando: 'node /x/script.js --out /y/claude', ejecutable: '/usr/local/bin/node' }), false);
  assert.strictEqual(ow.esHerramienta(herramienta()), true);
  // ps con el idioma de la máquina en castellano o sin UTF-8: se lee con uno fijo
  let env = null;
  const fingido = (bin, args, o) => { env = o.env; return { status: 0, stdout: args.includes('pid=,comm=') ? '  100 /x/claude\n' : `  100     1 ${INICIO}     /x/claude\n` }; };
  const a = ow.leerArbol({ spawnSync: fingido, plataforma: 'darwin' });
  assert.strictEqual(env && env.LC_ALL, 'C.UTF-8');
  assert.strictEqual(a[0].ejecutable, '/x/claude');
});

test('OwnerWindow_GuionRelanzadoPorElPisoDeNode_Firma (pase adversarial)', (t) => {
  // node-floor relanza el guion con el Node del arnés: el padre del guion es el Node viejo, y arriba la consola
  const casa = casaNueva(t);
  const [firma, cmd, argv] = GUIONES[2];
  assert.strictEqual(pedir(casa, cmd).decision, 'ask');
  const nuevo = cmd.replace(/^node /, '/h/.tycon/node/bin/node ');
  const arbol = arbolDelGuion(casa, cmd, { extra: [{ pid: 302, ppid: 301, inicio: INICIO, comando: nuevo }] });
  const v = ow.verificar({ firma, argv, pid: 302, arbol, casa, ahora: AHORA + 1000 });
  assert.ok(v.ok, v.motivo);
  // otro guion debajo no vale: el relanzado corre lo mismo
  const otro = arbolDelGuion(casa, cmd, { extra: [{ pid: 302, ppid: 301, inicio: INICIO, comando: `node ${MARKER} get` }] });
  assert.strictEqual(ow.verificar({ firma, argv, pid: 302, arbol: otro, casa, ahora: AHORA + 1000 }).ok, false);
});

test('OwnerWindow_CadaEscapeDelCatalogo_SeAnotaConSuNombre (pase adversarial)', (t) => {
  // el freno anota con su nombre cada escape que pide en la ventana: ninguno del catálogo queda fuera de la constancia
  const casa = casaNueva(t);
  const gr = require('../lib/guard-record.js');
  const ESCAPES = require('../lib/signatures.js').SIGNATURES.map((s) => s.id).filter((id) => id.startsWith('escape:'));
  for (const id of ESCAPES) gr.anotar({ freno: 'safety-guard', regla: 'ESC-C1', veredicto: 'escape', cmd: 'x', home: casa, via: 'ventana', sesion: 'ses-a', escape: id.slice('escape:'.length) });
  const dir = path.join(casa, '.claude', '.tycon-pipeline');
  const lineas = fs.readFileSync(path.join(dir, 'frenos.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  assert.deepStrictEqual(lineas.map((l) => `escape:${l.escape}`), ESCAPES);
  assert.ok(!fs.existsSync(path.join(dir, 'hook-errors.log')), () => fs.readFileSync(path.join(dir, 'hook-errors.log'), 'utf8'));
});

test('OwnerWindow_TerminalSinSesion_UsaLaDelPedido (pase adversarial)', (t) => {
  // el texto del freno da el comando de la terminal con la sesión; en la terminal del dueño no hay variable de sesión
  const casa = casaNueva(t);
  const r = pedir(casa, `node ${MARKER} complete-step approve-plan --approved "x"`, { evento: { tool_name: 'Monitor' } });
  assert.match(r.texto, /--for-session ses-a/);
  assert.match(pedir(casa, GUIONES[0][1]).texto, /--for-session ses-a/);
  const tty = { windows: false, hay: () => true, preguntar: () => 'firmo' };
  const e = ow.exigir({ firma: 'manual-test', argv: [MARKER, 'mark-tested', '--acs', '1', '--for-session', 'ses-a', '--terminal'], propia: '_nosession', casa, tty, ahora: AHORA });
  assert.strictEqual(e.codigo, 0, e.motivo);
  assert.strictEqual(e.destino, 'ses-a');
});

test('OwnerWindow_ControlConRelevo_SeNiega (decisión 24)', (t) => {
  const casa = casaNueva(t);
  const r = pedir(casa, `bash ${CONTROLES} approve --relayed-by coordinadora --quote "dale"`);
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.texto, /--terminal/);
  assert.strictEqual(registros(casa).length, 0);
});

test('OwnerWindow_FirmaNombradaEnUnTexto_NoSePide', () => {
  // un mensaje que nombra la firma no la pide; el texto que corre una consola, sí
  for (const c of [`git commit -m 'run-base-controls.sh approve --relayed-by: la firma'`, `git commit -m 'node e2e-setup.js prepare'`, `echo "bash ${CONTROLES} approve"`]) {
    assert.deepStrictEqual(ow.firmasDelComando(c), [], c);
  }
  for (const [c, id] of [[`bash -c 'bash ${CONTROLES} approve'`, 'control-change'], [`sh -lc 'node e2e-setup.js prepare'`, 'browser-test'],
    [`env bash -c 'bash ${CONTROLES} approve'`, 'control-change'], [`eval 'bash ${CONTROLES} approve'`, 'control-change']]) {
    assert.deepStrictEqual(ow.firmasDelComando(c), [id], c);
  }
});

test('OwnerWindow_Envoltura_SeDesenvuelveTalCual', (t) => {
  const casa = casaNueva(t);
  for (const cmd of [GUIONES[0][1], "echo 'a' \"b\" '\"'", 'x']) assert.strictEqual(ow.desenvolver(envolver(casa, cmd), casa), cmd);
  // otra casa en la foto del ambiente, o una comilla suelta adentro: no es la envoltura
  assert.strictEqual(ow.desenvolver(envolver('/otra', 'x'), casa), null);
  assert.strictEqual(ow.desenvolver(envolver(casa, 'x').replace("eval 'x'", "eval 'x' ; 'y'"), casa), null);
  assert.strictEqual(ow.desenvolver(`bash -c 'x'`, casa), null);
});
