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
// sin `delegacion`, ninguna firma se delega: la delegación de verdad lee el perfil y la huella de esta máquina
const SIN_DELEGACION = () => ({ ok: false, motivo: 'sin delegación en la prueba' });
// sin `aprobador`, el texto de un repo del arnés: el de verdad mira el remoto de la carpeta del evento
const { APPROVERS } = require(path.join(__dirname, '..', 'lib', 'approver.js'));
const DEL_ARNES = () => APPROVERS.maintainers;
const pedir = (casa, cmd, o = {}) => ow.decidir({ evento: evento(cmd, o.evento), escapes: o.escapes || [], arbol: o.arbol || arbolDelFreno(), pid: 201, casa, ahora: o.ahora || AHORA, delegacion: o.delegacion || SIN_DELEGACION, clasificar: o.clasificar || (() => null), comprobar: o.comprobar || (() => null), aprobador: o.aprobador || DEL_ARNES });
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
  ['lost-run', `node ${MARKER} clear-session ses-a --lost`, [MARKER, 'clear-session', 'ses-a', '--lost']],
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

test('OwnerWindow_SiTardio_DiceQueVencio (T42) @story-8.139 @ac-41', (t) => {
  const [firma, cmd, argv] = GUIONES[0];
  let casa = casaNueva(t);
  pedir(casa, cmd);
  const v = ow.verificar({ firma, argv, pid: 301, arbol: arbolDelGuion(casa, cmd), casa, ahora: AHORA + 51 * 60000 });
  assert.strictEqual(v.ok, false);
  assert.match(v.motivo, /se aprobó 51 minutos después/);
  assert.match(v.motivo, /vence a los 30/);
  assert.match(v.motivo, /repetí el mismo comando/i);
  assert.doesNotMatch(v.motivo, /terminal/);
  assert.strictEqual(gates(casa).length, 0, 'nada firmado');
  // sin ningún pedido de ese comando, el motivo de siempre
  casa = casaNueva(t);
  assert.match(ow.verificar({ firma, argv, pid: 301, arbol: arbolDelGuion(casa, cmd), casa, ahora: AHORA }).motivo, /no hay un pedido vigente/);
});

test('OwnerWindow_DespuesDeUnNo_OtroComandoVenceElPedido (T43) @story-8.139 @ac-42', (t) => {
  const [firma, cmd, argv] = GUIONES[0];
  const casa = casaNueva(t);
  assert.strictEqual(pedir(casa, cmd).decision, 'ask');
  // otra sesión con su propio pedido pendiente
  pedir(casa, GUIONES[2][1], { evento: { session_id: 'ses-b' } });
  // el dueño dijo «No»; el agente manda la misma firma disfrazada: el freno no la reconoce como firma
  const disfraz = `exec /bin/bash -c "$(echo ${Buffer.from(`exec /bin/zsh -c "${envolver(casa, cmd)}"`).toString('base64')}|base64 -d)"`;
  assert.strictEqual(pedir(casa, disfraz).decision, 'none');
  // ese comando, como cualquiera que no sea la firma, vence los pedidos de su sesión antes de correr
  assert.strictEqual(ow.vencerPedidos(casa, 'ses-a', AHORA + 1000), 1);
  const v = ow.verificar({ firma, argv, pid: 301, arbol: arbolDelGuion(casa, cmd), casa, ahora: AHORA + 2000 });
  assert.strictEqual(v.ok, false);
  assert.match(v.motivo, /no hay un pedido vigente/);
  assert.strictEqual(gates(casa).length, 0, 'nada firmado');
  assert.ok(vigentes(casa).some((f) => f.endsWith('--ses-b.json')), 'el pedido de otra sesión sigue vigente');
  assert.strictEqual(ow.vencerPedidos(casa, '../x', AHORA), 0, 'una sesión con otra forma no toca nada');
  // el subcomando del freno: una sesión sin pedidos sale 0 sin escribir nada
  const r = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'lib', 'owner-window.js'), 'sweep'], { input: JSON.stringify({ session_id: `t43-${crypto.randomUUID()}` }), encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
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
  r = pedir(casa, `node ${MARKER} set-check dod green --force-manual`, { escapes: ['escape:force-manual'], delegacion: () => { throw new Error('perfil roto'); } });
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
  const r = ow.decidir({ evento: evento(cmd), arbol: arbolDelFreno(), pid: 201, ahora: AHORA, userInfo, comprobar: () => null });
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
    ['escape:no-deep-review', `node ${PIPELINE} start --story s.md --no-deep-review`],
  ];
  for (const [e, cmd] of forma) {
    const casa = casaNueva(t);
    const r = pedir(casa, cmd, { escapes: [e] });
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
    const r = pedir(casa, cmd, { escapes: [e] });
    assert.strictEqual(r.decision, 'deny', cmd);
    assert.match(r.texto, /terminal/, cmd);
  }
});

// la delegación de verdad (delegated-signing.js) con el perfil y la huella inyectados, sobre la casa de la prueba
const DS = require('../lib/delegated-signing.js');
const HUELLA = 'a1b2c3d4e5f60718';
const PERFIL = { delegated_signing: ['plan-approval', 'extra-round', 'refresh-after-main'], owner_only: ['control-change'], delegated_machines: [{ id: HUELLA, label: 'Mac de prueba' }] };
/** La casa con la sesión `ses-coord` designada (y confirmada, salvo `confirmada: false`) y la ejecución de ses-a. */
function casaConDesignada(t, { confirmada = true, designada = 'ses-coord' } = {}) {
  const casa = casaNueva(t);
  const estado = path.join(casa, '.claude', '.tycon-pipeline');
  const d = { name: 'relay-designation', status: 'ok', ts: '2026-10-27T08:00:00.000Z', sesion: designada, rol: 'coordinadora', quien: 'dueño', cita: 'Esta sesión es la coordinadora' };
  const lineas = [d];
  if (confirmada) lineas.push(DS.confirmationRecord(d, '2026-10-27T08:01:00.000Z'));
  fs.writeFileSync(path.join(estado, 'gates.log'), `${lineas.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return casa;
}
const delegacionReal = ({ perfil = PERFIL, huella = HUELLA } = {}) => (o) => DS.delegaSinVentana({ ...o, perfil: () => perfil, huella: () => ({ huella }) });
const DE_LA_COORD = { session_id: 'ses-coord' };
const PLAN = `node ${MARKER} complete-step approve-plan --for-session ses-a --approved "el plan de 5 pasos"`;
const PLAN_ARGV = [MARKER, 'complete-step', 'approve-plan', '--for-session', 'ses-a', '--approved', 'el plan de 5 pasos'];
const registroVigente = (casa) => JSON.parse(fs.readFileSync(path.join(ow.carpeta(casa), vigentes(casa)[0]), 'utf8'));

test('OwnerWindow_Coordinadora_VentanaEnSuPestana (T22)', (t) => {
  const casa = casaNueva(t);
  const r = pedir(casa, PLAN, { evento: DE_LA_COORD });
  assert.strictEqual(r.decision, 'ask', r.texto);
  assert.match(r.texto, /sesión ses-a/);
  assert.match(r.texto, /9\.99/);
  // el guion lo corre la coordinadora: su sesión propia es la de ella
  const e = ow.exigir({ firma: 'plan-approval', argv: PLAN_ARGV, pid: 301, arbol: arbolDelGuion(casa, PLAN), casa, ahora: AHORA + 60000, propia: 'ses-coord' });
  assert.strictEqual(e.codigo, 0, e.motivo);
  assert.strictEqual(e.via, 'ventana');
  const g = gates(casa).filter((x) => x.name === 'plan-approval-signed');
  assert.strictEqual(g.length, 1);
  assert.strictEqual(g[0].via, 'ventana');
  assert.strictEqual(g[0].sesion, 'ses-coord', 'la sesión que firmó es la de ella');
  assert.strictEqual(g[0].destino, 'ses-a');
});

test('OwnerWindow_Delegado_SinVentana (T23)', (t) => {
  for (const [cmd, firma, argv] of [
    [PLAN, 'plan-approval', PLAN_ARGV],
    [`node ${PIPELINE} smart-reloop --iter 3 --extra-round --for-session ses-a`, 'extra-round', [PIPELINE, 'smart-reloop', '--iter', '3', '--extra-round', '--for-session', 'ses-a']],
  ]) {
    const casa = casaConDesignada(t);
    const r = pedir(casa, cmd, { evento: DE_LA_COORD, delegacion: delegacionReal() });
    assert.strictEqual(r.decision, 'allow', `${cmd}: ${r.texto}`);
    assert.strictEqual(r.via, 'delegacion');
    assert.strictEqual(vigentes(casa).length, 1, `${cmd}: escribe el registro`);
    const reg = registroVigente(casa);
    assert.strictEqual(reg.via, 'delegacion');
    assert.strictEqual(reg.maquina, HUELLA);
    assert.strictEqual(reg.sesion, 'ses-coord');
    const e = ow.exigir({ firma, argv, pid: 301, arbol: arbolDelGuion(casa, cmd), casa, ahora: AHORA + 60000, propia: 'ses-coord' });
    assert.strictEqual(e.codigo, 0, e.motivo);
    assert.strictEqual(e.via, 'delegacion', 'el guion firma con via: delegacion');
    assert.strictEqual(gates(casa).filter((x) => x.name === `${firma}-signed`)[0].via, 'delegacion');
  }
});

// --- el guion que corre la coordinadora firma para la sesión destino -----------------------------------------------

const exigirDe = (casa, argv, cmd, propia) => ow.exigir({ firma: 'plan-approval', argv, pid: 301, arbol: arbolDelGuion(casa, cmd), casa, ahora: AHORA + 60000, propia });

test('Exigir_OtraSesion_ConRegistro_Firma (T1) @story-8.142 @ac-1', (t) => {
  const casa = casaNueva(t);
  assert.strictEqual(pedir(casa, PLAN, { evento: DE_LA_COORD }).decision, 'ask');
  const e = exigirDe(casa, PLAN_ARGV, PLAN, 'ses-coord');
  assert.strictEqual(e.codigo, 0, e.motivo);
  assert.strictEqual(e.destino, 'ses-a');
  assert.strictEqual(e.sesion, 'ses-coord');
  assert.strictEqual(vigentes(casa).length, 0, 'el registro quedó gastado');
  // un uso: el mismo guion otra vez no firma
  assert.strictEqual(exigirDe(casa, PLAN_ARGV, PLAN, 'ses-coord').codigo, 1);
  assert.strictEqual(gates(casa).filter((g) => g.name === 'plan-approval-signed').length, 1);
  // un marcador del destino que no se puede leer no es «sin ejecución»: sale 2 sin tocar la variable de sesión,
  // también para una firma que no exige el marcador
  const env = {};
  const fd = ow.fijarDestino({ r: e, propia: 'ses-coord', leerMarcador: () => { throw new Error('no pude leer el marcador de la sesión ses-a'); }, env });
  assert.strictEqual(fd.codigo, 2);
  assert.match(fd.motivo, /no pude leer/);
  assert.deepStrictEqual(env, {});
  const activos = path.join(require('../../skills/tycon-pipeline/scripts/lib/state-dir.js').stateDir(casa), 'active');
  fs.mkdirSync(activos, { recursive: true });
  fs.writeFileSync(path.join(activos, 'ses-a.json'), '{ no es json');
  assert.strictEqual(ow.fijarDestino({ r: e, propia: 'ses-coord', casa, env }).codigo, 2);
  // en la terminal del dueño sin variable de sesión, nadie la pidió para otra: la constancia no lleva `por`
  const terminal = ow.fijarDestino({ r: { via: 'terminal', sesion: null, destino: 'ses-a' }, propia: '_nosession', leerMarcador: () => null, env: {} });
  assert.strictEqual(terminal.codigo, 0);
  assert.deepStrictEqual(terminal.constancia, { via: 'terminal' });
});

test('Exigir_OtraSesion_SinRegistro_Sale1 (T2) @story-8.142 @ac-1 @ac-4', (t) => {
  // sin registro
  let casa = casaNueva(t);
  let e = exigirDe(casa, PLAN_ARGV, PLAN, 'ses-coord');
  assert.strictEqual(e.codigo, 1);
  assert.strictEqual(gates(casa).length, 0, 'nada escrito');
  // un registro para otra sesión destino (ses-e) no firma el pedido para ses-a
  casa = casaNueva(t);
  pedir(casa, PLAN, { evento: DE_LA_COORD });
  const f = path.join(ow.carpeta(casa), vigentes(casa)[0]);
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), destino: 'ses-e' }));
  e = exigirDe(casa, PLAN_ARGV, PLAN, 'ses-coord');
  assert.strictEqual(e.codigo, 1);
  assert.strictEqual(vigentes(casa).length, 1, 'el registro para ses-e sigue sin gastar');
  assert.strictEqual(gates(casa).length, 0);
  // el registro de la sesión ses-x, con el mismo comando y la misma herramienta, no lo usa ses-coord
  casa = casaNueva(t);
  assert.strictEqual(pedir(casa, PLAN, { evento: { session_id: 'ses-x' } }).decision, 'ask');
  e = exigirDe(casa, PLAN_ARGV, PLAN, 'ses-coord');
  assert.strictEqual(e.codigo, 1, 'un registro de ses-x no firma lo que corre ses-coord');
  assert.strictEqual(vigentes(casa).length, 1, 'el registro de ses-x quedó intacto');
  assert.strictEqual(registroVigente(casa).sesion, 'ses-x');
  assert.strictEqual(gates(casa).length, 0);
});

test('Exigir_SinForSession_ComoHoy (T3) @story-8.142 @ac-1', (t) => {
  // red de no regresión: sin --for-session, la sesión propia firma con su registro y sin él no
  const [, cmd, argv] = GUIONES[0];
  let casa = casaNueva(t);
  assert.strictEqual(pedir(casa, cmd).decision, 'ask');
  const e = exigirDe(casa, argv, cmd, 'ses-a');
  assert.strictEqual(e.codigo, 0, e.motivo);
  assert.strictEqual(e.destino, 'ses-a');
  assert.strictEqual(e.sesion, 'ses-a');
  casa = casaNueva(t);
  assert.strictEqual(exigirDe(casa, argv, cmd, 'ses-a').codigo, 1);
  assert.strictEqual(gates(casa).length, 0);
});

test('Exigir_Terminal_DestinoPedido (T4) @story-8.142 @ac-1', (t) => {
  const tty = { windows: false, hay: () => true, preguntar: () => 'firmo' };
  let casa = casaNueva(t);
  const e = ow.exigir({ firma: 'manual-test', argv: [MARKER, 'mark-tested', '--acs', '1', '--terminal', '--for-session', 'ses-a'], propia: 'ses-coord', casa, tty, ahora: AHORA });
  assert.strictEqual(e.codigo, 0, e.motivo);
  assert.strictEqual(e.destino, 'ses-a');
  const g = gates(casa).find((x) => x.name === 'manual-test-signed');
  assert.strictEqual(g.via, 'terminal');
  assert.strictEqual(g.sesion, 'ses-coord', 'el renglón dice quién la pidió');
  assert.strictEqual(g.destino, 'ses-a');
  // una firma que no se corre desde otra sesión sigue saliendo 1, con o sin terminal
  for (const extra of [['--terminal'], []]) {
    casa = casaNueva(t);
    const r = ow.exigir({ firma: 'adversarial-skip', argv: [MARKER, 'sign-adversarial-skip', '--story', 's.md', '--reason', 'x', ...extra, '--for-session', 'ses-a'], propia: 'ses-coord', casa, tty, ahora: AHORA });
    assert.strictEqual(r.codigo, 1, extra.join(' '));
    assert.match(r.motivo, /se corre desde la sesión destino/);
    assert.strictEqual(gates(casa).length, 0);
  }
});

test('OwnerWindow_DelegadoSinUnaLlave_PideVentana (T24)', (t) => {
  const casos = [
    ['otra sesión', casaConDesignada(t, { designada: 'ses-otra' }), delegacionReal()],
    ['máquina fuera de la lista', casaConDesignada(t), delegacionReal({ huella: 'ffffffffffffffff' })],
    ['designación sin confirmar', casaConDesignada(t, { confirmada: false }), delegacionReal()],
    ['el perfil no la delega', casaConDesignada(t), delegacionReal({ perfil: { ...PERFIL, delegated_signing: ['extra-round'] } })],
  ];
  for (const [nombre, casa, delegacion] of casos) {
    const r = pedir(casa, PLAN, { evento: DE_LA_COORD, delegacion });
    assert.strictEqual(r.decision, 'ask', `${nombre}: ${r.texto}`);
    assert.notStrictEqual(registroVigente(casa).via, 'delegacion', nombre);
    // la ventana dice por qué no se delegó una firma que el perfil delega; la que no delega, no lo dice (es lo normal)
    if (nombre === 'el perfil no la delega') assert.doesNotMatch(r.texto, /No se firmó por delegación/, nombre);
    else assert.match(r.texto, /No se firmó por delegación: /, nombre);
  }
  const m = pedir(casaConDesignada(t), PLAN, { evento: DE_LA_COORD, delegacion: delegacionReal({ huella: 'ffffffffffffffff' }) });
  assert.match(m.texto, /No se firmó por delegación: esta máquina no está en approvals\.delegated_machines/);
});

test('OwnerWindow_SoloDelDueno_GanaAlGrupo + OwnerWindow_SesionPropia_NoSeDelega (T25)', (t) => {
  // sólo del dueño, aunque un grupo de delegated_signing la incluya: el candado gana
  let casa = casaConDesignada(t);
  const candado = delegacionReal({ perfil: { ...PERFIL, delegated_signing: ['plan-approval'], owner_only: ['plan-approval'] } });
  assert.strictEqual(pedir(casa, PLAN, { evento: DE_LA_COORD, delegacion: candado }).decision, 'ask');
  const s = DS.delegaSinVentana({ firma: 'escape:force-manual', sesion: 'ses-coord', destino: 'ses-a', home: casa, estado: path.join(casa, '.claude', '.tycon-pipeline'),
    perfil: () => ({ ...PERFIL, delegated_signing: ['escape-phrases'], owner_only: ['escape:force-manual'] }), huella: () => ({ huella: HUELLA }) });
  assert.strictEqual(s.ok, false);
  assert.match(s.motivo, /sólo del dueño/);
  // saltear el pase adversarial no se delega aunque el perfil lo liste y no esté en owner_only
  const salteo = DS.delegaSinVentana({ firma: 'adversarial-skip', sesion: 'ses-coord', destino: 'ses-a', home: casa, estado: path.join(casa, '.claude', '.tycon-pipeline'),
    perfil: () => ({ ...PERFIL, delegated_signing: ['adversarial-skip'], owner_only: [] }), huella: () => ({ huella: HUELLA }) });
  assert.deepStrictEqual(salteo, { ok: false, motivo: 'saltear el pase adversarial es sólo del dueño: no se delega' });
  // sin perfil inyectado, las listas las lee el lector de configuración del árbol (owner_only incluido)
  const conPerfil = (approvals) => {
    const arnes = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-window-arnes-'));
    t.after(() => fs.rmSync(arnes, { recursive: true, force: true }));
    fs.writeFileSync(path.join(arnes, 'team-profile.json'), JSON.stringify({ approvals }));
    return DS.delegaSinVentana({ firma: 'plan-approval', sesion: 'ses-coord', destino: 'ses-a', home: casa, env: {}, arnes, estado: path.join(casa, '.claude', '.tycon-pipeline'), huella: () => ({ huella: HUELLA }) });
  };
  const leido = conPerfil({ delegated_signing: ['plan-approval'], delegated_machines: [{ id: HUELLA, label: 'Mac de prueba' }] });
  assert.strictEqual(leido.ok, true, leido.motivo);
  assert.strictEqual(conPerfil({ delegated_signing: ['plan-approval'], owner_only: ['plan-approval'], delegated_machines: [{ id: HUELLA, label: 'Mac de prueba' }] }).ok, false);
  // sobre la propia sesión: sin --for-session, el destino es la del evento
  casa = casaConDesignada(t, { designada: 'ses-a' });
  assert.strictEqual(pedir(casa, `node ${MARKER} complete-step approve-plan --approved "el plan"`, { delegacion: delegacionReal() }).decision, 'ask');
  // la propia sesión no se delega, tampoco un control declarado a mano aunque el perfil lo nombre
  const fm = delegacionReal({ perfil: { ...PERFIL, delegated_signing: ['escape:force-manual'], owner_only: [] } });
  assert.strictEqual(pedir(casa, `node ${MARKER} set-check advisors green --force-manual`, { delegacion: fm }).decision, 'ask');
  // sobre otra sesión con la misma story que la ejecución abierta de la designada
  casa = casaConDesignada(t);
  fs.writeFileSync(path.join(casa, '.claude', '.tycon-pipeline', 'active', 'ses-coord.json'), JSON.stringify({ sessionId: 'ses-coord', storyId: '9.99' }));
  const r = pedir(casa, PLAN, { evento: DE_LA_COORD, delegacion: delegacionReal() });
  assert.strictEqual(r.decision, 'ask', r.texto);
  // lo que no se puede leer no delega: el marcador ilegible de la sesión destino, una lista que no es lista, un perfil
  // cuya lista de firmas retiró el validador
  fs.writeFileSync(path.join(casa, '.claude', '.tycon-pipeline', 'active', 'ses-a.json'), '{ roto');
  const destinoIlegible = DS.delegaSinVentana({ firma: 'plan-approval', sesion: 'ses-coord', destino: 'ses-a', home: casa, estado: path.join(casa, '.claude', '.tycon-pipeline'),
    perfil: () => PERFIL, huella: () => ({ huella: HUELLA }) });
  assert.strictEqual(destinoIlegible.ok, false);
  assert.match(destinoIlegible.motivo, /marcador de la sesión destino/);
  casa = casaConDesignada(t);
  const noEsLista = DS.delegaSinVentana({ firma: 'plan-approval', sesion: 'ses-coord', destino: 'ses-a', home: casa, estado: path.join(casa, '.claude', '.tycon-pipeline'),
    perfil: () => ({ ...PERFIL, owner_only: { 'plan-approval': true } }), huella: () => ({ huella: HUELLA }) });
  assert.strictEqual(noEsLista.ok, false);
  assert.match(noEsLista.motivo, /approvals\.owner_only/);
  const retirada = conPerfil({ delegated_signing: ['plan-approval'], owner_only: { x: 1 }, delegated_machines: [{ id: HUELLA, label: 'Mac de prueba' }] });
  assert.strictEqual(retirada.ok, false);
  assert.match(retirada.motivo, /perfil/);
});

test('OwnerWindow_PasosDeOtraSesion_SegunElCatalogo (T27)', (t) => {
  const { SIGNATURES } = require('../lib/signatures.js');
  for (const [firma, cmd] of GUIONES) {
    const s = SIGNATURES.find((x) => x.id === firma);
    const casa = casaNueva(t);
    // los criterios que se eximen son los de la historia de la corrida de ses-a
    if (firma === 'runtime-waiver') tresParaOtra(casa);
    const r = pedir(casa, `${cmd} --for-session ses-a`, { evento: DE_LA_COORD });
    if (s.otherSession === 'yes') assert.strictEqual(r.decision, 'ask', `${firma}: ${r.texto}`);
    else {
      assert.strictEqual(r.decision, 'deny', `${firma}: ${r.texto}`);
      assert.match(r.texto, /terminal/, firma);
      assert.match(r.texto, /--for-session ses-a\.$/, `${firma}: la terminal firma para la sesión destino`);
    }
  }
});

test('OwnerWindow_Refirma_DelegadaSinVentana + OwnerWindow_RefirmaNoComprobada_PideVentana (T41)', (t) => {
  const cmd = `bash ${CONTROLES} approve --root /r --base main --out .tycon/control-changes/ --for-session ses-a`;
  const argv = [CONTROLES, 'approve', '--root', '/r', '--base', 'main', '--out', '.tycon/control-changes/', '--for-session', 'ses-a'];
  let casa = casaConDesignada(t);
  let pedidoAlClasificador = null;
  const refirma = (palabras, cwd) => { pedidoAlClasificador = { palabras, cwd }; return { clase: 'refresh-after-main', refirma_de: 'h'.repeat(64) }; };
  let r = pedir(casa, cmd, { evento: { ...DE_LA_COORD, cwd: '/r' }, delegacion: delegacionReal(), clasificar: refirma });
  assert.strictEqual(r.decision, 'allow', r.texto);
  assert.strictEqual(r.via, 'delegacion');
  assert.deepStrictEqual(r.firmas, ['refresh-after-main']);
  assert.strictEqual(pedidoAlClasificador.palabras[1], 'approve');
  assert.strictEqual(pedidoAlClasificador.cwd, '/r');
  const reg = registroVigente(casa);
  assert.strictEqual(reg.firma, 'refresh-after-main');
  assert.strictEqual(reg.via, 'delegacion');
  assert.strictEqual(reg.refirma_de, 'h'.repeat(64));
  // el guion de la refirma consume ese registro; el de un cambio de control, no
  assert.strictEqual(ow.verificar({ firma: 'control-change', argv, pid: 301, arbol: arbolDelGuion(casa, cmd), casa, ahora: AHORA + 60000 }).ok, false);
  // el guion lo corre la coordinadora, la sesión que pidió
  const e = ow.exigir({ firma: 'refresh-after-main', argv, pid: 301, arbol: arbolDelGuion(casa, cmd), casa, ahora: AHORA + 60000, propia: DE_LA_COORD.session_id });
  assert.strictEqual(e.codigo, 0, e.motivo);
  assert.strictEqual(e.via, 'delegacion');
  assert.strictEqual(e.registro.refirma_de, 'h'.repeat(64));
  // el clasificador dice cambio de control, no contesta o se cae: la ventana del dueño, con control-change
  for (const clasificar of [() => ({ clase: 'control-change', motivo: 'no cuadra' }), () => null, () => { throw new Error('se cayó'); }]) {
    casa = casaConDesignada(t);
    r = pedir(casa, cmd, { evento: DE_LA_COORD, delegacion: delegacionReal(), clasificar });
    assert.strictEqual(r.decision, 'ask', r.texto);
    assert.deepStrictEqual(r.firmas, ['control-change']);
    assert.strictEqual(registroVigente(casa).firma, 'control-change');
  }
  // sin --base no se clasifica: cambio de control, y control-change es sólo del dueño
  casa = casaConDesignada(t);
  let clasificado = false;
  r = pedir(casa, `bash ${CONTROLES} approve --root /r --for-session ses-a`, { evento: DE_LA_COORD, delegacion: delegacionReal(), clasificar: () => { clasificado = true; return { clase: 'refresh-after-main', refirma_de: 'x' }; } });
  assert.strictEqual(r.decision, 'ask');
  assert.strictEqual(clasificado, false);
});

test('OwnerWindow_VueltaExtra_ConDelegatedIgualLaVentana', (t) => {
  // --delegated ya no saca la vuelta extra del freno: la delegación es la de las listas del perfil
  const casa = casaNueva(t);
  const extra = GUIONES.find((g) => g[0] === 'extra-round')[1];
  const r = pedir(casa, `${extra} --delegated`);
  assert.strictEqual(r.decision, 'ask', r.texto);
  assert.deepStrictEqual(r.firmas, ['extra-round']);
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

test('OwnerWindow_PipelineConArgumentosArmados_SoloPideLaVueltaSiPuedeEsconderla', () => {
  // un valor armado donde el guion lo toma sí o sí (`--repo`, `--story`), no puede ser la bandera: entre comillas, o una
  // variable del ambiente que el comando no escribe; ni un subcomando armado sin nada que pueda traerla
  for (const c of [`node ${PIPELINE} advisors --repo "$(pwd)" --story s.md`, `node ${PIPELINE} smart-reloop --repo "$R" --story "$S" --iter 2`,
    `node ${PIPELINE} advisors --repo x$R --story s.md`, `node ${PIPELINE} mech-check --repo $(pwd) --story s.md`, `node ${PIPELINE} "$S" --repo x`,
    `node ${PIPELINE} $S`, `cd /r && node ${PIPELINE} advisors --repo "$PWD" --story s.md --files a.js`]) {
    assert.deepStrictEqual(ow.firmasDelComando(c), [], c);
  }
  // sin comillas el shell parte un `$(…)`; tras `--files`, o tras un `--story` que se comió la opción siguiente, queda
  // suelto; la bandera entre comillas de una sustitución, también detrás de una opción de marker.js que pipeline.js no
  // lee; y un subcomando armado que el shell parte o con la bandera
  for (const c of [`node ${PIPELINE} advisors --repo $(pwd) --story s.md`, `node ${PIPELINE} advisors --story s.md "$(echo --extra-round)"`,
    `node ${PIPELINE} smart-reloop --story s.md --in "$(echo --extra-round)"`, `node ${PIPELINE} advisors --story s.md --type "$F"`,
    `node ${PIPELINE} advisors --story s.md "$F"`, `node ${PIPELINE} advisors --files "$F"`, `node ${PIPELINE} advisors --story --repo "$F"`,
    `node ${PIPELINE} $S --extra-round`, `node ${PIPELINE} $(echo smart-reloop --extra-round)`, `read S; node ${PIPELINE} $S`]) {
    assert.deepStrictEqual(ow.firmasDelComando(c), ['extra-round'], c);
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

// --- las cuatro firmas sobre un archivo (marker.js sign-file, AC 43) y las constancias (AC 30) ------------------------
// Los frenos de escritura anotan con el HOME del proceso: una casa de mentira para ellos (las constancias de la ventana
// van a la casa de la prueba, que se les pasa; el HOME no las cambia), y sin el registro del cierre.
const HOME_DE_LOS_FRENOS = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-window-home-'));
const HOME_ANTES = process.env.HOME;
process.env.HOME = HOME_DE_LOS_FRENOS;
process.env.TYCON_CLOSURE_RECORD = 'off';
test.after(() => {
  if (HOME_ANTES === undefined) delete process.env.HOME; else process.env.HOME = HOME_ANTES;
  fs.rmSync(HOME_DE_LOS_FRENOS, { recursive: true, force: true });
});
const SCRIPTS_PIPE = path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts');
const fw = () => require(path.join(SCRIPTS_PIPE, 'on-frontmatter-write.js'));
const eg = () => require(path.join(SCRIPTS_PIPE, 'on-dod-evidence-guard.js'));
const sio = () => require(path.join(SCRIPTS_PIPE, 'lib', 'story-skill-gate-io.js'));

/** Un repo con una historia en implementación, y la evidencia de la prueba en vivo por escribir. */
function repoNuevo(t) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-window-repo-'));
  t.after(() => fs.rmSync(r, { recursive: true, force: true }));
  for (const d of ['.git', 'specs', '.tycon', path.join('.advisors', 'dod-runtime')]) fs.mkdirSync(path.join(r, d), { recursive: true });
  fs.writeFileSync(path.join(r, '.tycon', 'advisors.yaml'), "stories:\n  id_pattern: '^(?:[A-Z]{1,4}-)?\\d+(?:[.-]\\d+)*$'\n");
  const historia = path.join(r, 'specs', 'story-9.99-x.md');
  fs.writeFileSync(historia, '---\nstory: "9.99"\nepic: "9"\nstatus: in-progress\ntitle: "X"\n---\n# Story 9.99\n');
  return { repo: r, historia };
}

/**
 * Cada firma con el archivo que firma y el freno que lo escribe: `escribir(casa, sesion)` devuelve true si el freno lo
 * dejó pasar, o el texto con que lo negó.
 */
function frenosDeArchivo(t) {
  const { repo, historia } = repoNuevo(t);
  const viejo = fs.readFileSync(historia, 'utf8');
  const ev = (sesion, archivo, content) => ({ session_id: sesion, tool_use_id: 'toolu_w', tool_name: 'Write', cwd: repo, transcript_path: path.join(HOME_DE_LOS_FRENOS, '.claude', 'projects', '-repo', `${sesion}.jsonl`), tool_input: { file_path: archivo, content } });
  const paso = (r) => (r == null || (r && !r.block) ? true : r.block);
  const nueva = path.join(repo, 'specs', 'story-AS-1-pedidos.md');
  const evidencia = path.join(repo, '.advisors', 'dod-runtime', '9.99-20261027.md');
  return [
    ['dod_runtime_exempt', historia, (casa, s) => paso(fw().handle(ev(s, historia, viejo.replace('status: in-progress', 'status: in-progress\ndod_runtime_exempt: true')), { casa }))],
    ['cambiar-el-estado', historia, (casa, s) => paso(fw().handle(ev(s, historia, viejo.replace('status: in-progress', 'status: ready-for-dev')), { casa }))],
    ['ALLOW_DOD_EVIDENCE_WRITE', evidencia, (casa, s) => paso(eg().handle(ev(s, evidencia, '# evidencia\n'), { casa }))],
    ['story-skill-bypass', nueva, (casa, s) => {
      const estado = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-window-ssg-'));
      t.after(() => fs.rmSync(estado, { recursive: true, force: true }));
      const r = sio().evaluate({ absPath: nueva, content: '---\nstory: "AS-1"\nepic: "pedidos"\nstatus: ready-for-dev\ntitle: "Pedidos"\n---\n# Story AS-1\n',
        sessionId: s, via: 'Write', event: ev(s, nueva, ''), stateDir: estado, casa });
      return r.verdict.action === 'pass' ? true : r.message;
    }],
  ];
}

const SIGN_FILE = (firma, archivo) => `node ${MARKER} sign-file ${firma} ${archivo}`;
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** El «Sí» de la ventana para `marker.js sign-file`: el pedido del freno, el guion que lo verifica y su constancia. */
function firmarEnLaVentana(casa, firma, archivo, ahora = AHORA) {
  const cmd = SIGN_FILE(firma, archivo);
  const r = pedir(casa, cmd, { ahora });
  assert.strictEqual(r.decision, 'ask', `${cmd}: ${r.texto}`);
  assert.ok(r.texto.includes(archivo), `${cmd}: la ventana nombra el archivo`);
  const e = ow.exigir({ firma: `escape:${firma}`, argv: [MARKER, 'sign-file', firma, archivo], pid: 301, arbol: arbolDelGuion(casa, cmd), casa, ahora, propia: 'ses-a' });
  assert.strictEqual(e.codigo, 0, e.motivo);
  ow.firmarArchivo({ firma, via: e.via, sesion: 'ses-a', archivo, casa, ahora });
}

test('SignFile_ConLaVentana_ElArchivoPasa (T45) @story-8.139 @ac-43', (t) => {
  for (const [firma, archivo, escribir] of frenosDeArchivo(t)) {
    const casa = casaNueva(t);
    firmarEnLaVentana(casa, firma, archivo, Date.now());
    assert.strictEqual(escribir(casa, 'ses-a'), true, `${firma}: con la constancia de la ventana pasa`);
    // la consume: la segunda escritura vuelve a frenar
    assert.notStrictEqual(escribir(casa, 'ses-a'), true, `${firma}: la constancia es de un solo uso`);
  }
});

test('SignFile_SinConstancia_NiegaYNombraElComando (T45) @story-8.139 @ac-43', (t) => {
  for (const [firma, , escribir] of frenosDeArchivo(t)) {
    const r = escribir(casaNueva(t), 'ses-a');
    assert.notStrictEqual(r, true, `${firma}: sin constancia frena`);
    assert.match(String(r), new RegExp(`marker\\.js sign-file ${escRe(firma)}`), `${firma}: nombra el comando`);
    assert.doesNotMatch(String(r), /«autorizo/, `${firma}: no dicta una frase`);
  }
});

test('SignFile_FraseEnLaConversacion_NoFirma (T45) @story-8.139 @ac-43', (t) => {
  for (const [firma, , escribir] of frenosDeArchivo(t)) {
    // la conversación con la frase de la persona, como la guarda la herramienta y anclada al pedido
    const dir = path.join(HOME_DE_LOS_FRENOS, '.claude', 'projects', '-repo');
    fs.mkdirSync(dir, { recursive: true });
    const hace = new Date(Date.now() - 60000).toISOString();
    const regs = [
      { type: 'user', timestamp: hace, uuid: 'u-0', parentUuid: null, message: { role: 'user', content: `autorizo ${firma.replace(/-/g, ' ')}` } },
      { type: 'user', timestamp: hace, uuid: 'u-1', parentUuid: 'u-0', message: { role: 'user', content: `autorizo ${firma}` } },
      { type: 'assistant', timestamp: new Date().toISOString(), uuid: 'u-2', parentUuid: 'u-1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_w', name: 'Write', input: {} }] } },
    ];
    fs.writeFileSync(path.join(dir, 'ses-frase.jsonl'), regs.map((x) => JSON.stringify(x)).join('\n') + '\n');
    assert.notStrictEqual(escribir(casaNueva(t), 'ses-frase'), true, `${firma}: la frase no firma`);
  }
});

test('SignFile_OtroArchivoOVencida_Niega (T45) @story-8.139 @ac-43', (t) => {
  for (const [firma, archivo, escribir] of frenosDeArchivo(t)) {
    // la constancia de otro archivo
    let casa = casaNueva(t);
    const otro = path.join(path.dirname(archivo), 'otro.md');
    fs.writeFileSync(otro, '# otro\n');
    ow.firmarArchivo({ firma, via: 'ventana', sesion: 'ses-a', archivo: otro, casa, ahora: Date.now() });
    assert.notStrictEqual(escribir(casa, 'ses-a'), true, `${firma}: la de otro archivo no vale`);
    // la de otra sesión
    casa = casaNueva(t);
    ow.firmarArchivo({ firma, via: 'ventana', sesion: 'ses-b', archivo, casa, ahora: Date.now() });
    assert.notStrictEqual(escribir(casa, 'ses-a'), true, `${firma}: la de otra sesión no vale`);
    // la de otra firma sobre el mismo archivo
    casa = casaNueva(t);
    ow.firmarArchivo({ firma: firma === 'dod_runtime_exempt' ? 'cambiar-el-estado' : 'dod_runtime_exempt', via: 'ventana', sesion: 'ses-a', archivo, casa, ahora: Date.now() });
    assert.notStrictEqual(escribir(casa, 'ses-a'), true, `${firma}: la de otra firma no vale`);
    // vencida: de hace 31 minutos
    casa = casaNueva(t);
    ow.firmarArchivo({ firma, via: 'ventana', sesion: 'ses-a', archivo, casa, ahora: Date.now() - 31 * 60000 });
    const r = escribir(casa, 'ses-a');
    assert.notStrictEqual(r, true, `${firma}: vencida no vale`);
    assert.match(String(r), /marker\.js sign-file/, `${firma}: vencida, nombra el comando`);
  }
  // una firma que no es de archivo no se pide con sign-file
  const casa = casaNueva(t);
  assert.strictEqual(pedir(casa, SIGN_FILE('TYCON_SAFETY_OFF', '/r/x.md')).decision, 'none');
  assert.throws(() => ow.firmarArchivo({ firma: 'plan-approval', via: 'ventana', sesion: 'ses-a', archivo: '/r/x.md', casa }), /no es una firma sobre un archivo/);
});

test('Constancias_DicenViaQuienYDestino_SinCita (T46) @story-8.139 @ac-30', (t) => {
  const SIN_CITA = /^(cita|quote|relevo|relayed_?by|ok|frase|approved_?by)$/i;
  const mira = (r, como) => {
    for (const k of ['via', 'sesion', 'destino']) assert.ok(r[k], `${como}: trae ${k}`);
    for (const k of Object.keys(r)) assert.doesNotMatch(k, SIN_CITA, `${como}: no guarda una cita (${k})`);
  };
  // por la ventana, cada firma `guion`
  for (const [firma, cmd, argv] of GUIONES) {
    const casa = casaNueva(t);
    pedir(casa, cmd);
    const e = ow.exigir({ firma, argv, pid: 301, arbol: arbolDelGuion(casa, cmd), casa, ahora: AHORA + 60000, propia: 'ses-a' });
    assert.strictEqual(e.codigo, 0, `${cmd}: ${e.motivo}`);
    const g = gates(casa).find((x) => x.name === `${firma}-signed`);
    mira(g, `${cmd} (ventana)`);
    assert.strictEqual(g.via, 'ventana');
  }
  // por la delegación
  const casa = casaConDesignada(t);
  pedir(casa, PLAN, { evento: DE_LA_COORD, delegacion: delegacionReal() });
  assert.strictEqual(ow.exigir({ firma: 'plan-approval', argv: PLAN_ARGV, pid: 301, arbol: arbolDelGuion(casa, PLAN), casa, ahora: AHORA + 60000, propia: DE_LA_COORD.session_id }).codigo, 0);
  const d = gates(casa).find((x) => x.name === 'plan-approval-signed');
  mira(d, 'delegación');
  assert.strictEqual(d.via, 'delegacion');
  assert.strictEqual(d.sesion, 'ses-coord');
  // la constancia del guion dice que firmó la coordinadora por delegación, no el dueño en la ventana
  const quien = ow.quienFirmo({ via: 'delegacion', sesion: 'ses-coord' }, 'el-dueno');
  assert.strictEqual(quien.via, 'delegada · coordinadora');
  assert.strictEqual(quien.tipo, 'automatica');
  assert.match(quien.quien, /^coordinadora \(sesión ses-coord\)$/);
  assert.strictEqual(quien.delegacion, 'el-dueno');
  const cw = require(path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'critical-waivers.js'));
  assert.strictEqual(cw.constanciaInvalida({ rule_id: 'X-C1', ts: 't', ...quien }), null, 'la exención delegada vale');
  assert.deepStrictEqual(ow.quienFirmo({ via: 'ventana', sesion: 'ses-a' }, 'el-dueno'), { tipo: 'manual', quien: 'el-dueno', via: 'ventana' });
  // la firma por `--terminal` queda como terminal, no como ventana, y la exención sigue valiendo
  const term = ow.quienFirmo({ codigo: 0, via: 'terminal' }, 'el-dueno');
  assert.deepStrictEqual(term, { tipo: 'manual', quien: 'el-dueno', via: 'terminal' });
  assert.strictEqual(cw.constanciaInvalida({ rule_id: 'X-C1', ts: 't', ...term }), null, 'la exención por la terminal vale');
  // el cierre de la corrida reconoce la vía de la delegación
  const rc = require(path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'run-close.js'));
  assert.ok(rc.VIAS_DE_CIERRE.includes('delegacion'), 'un cierre firmado por delegación no queda «sin registro»');
  // por la terminal
  const casaT = casaNueva(t);
  const tty = { windows: false, hay: () => true, preguntar: () => 'firmo' };
  assert.strictEqual(ow.exigir({ firma: 'manual-test', argv: [MARKER, 'mark-tested', '--acs', '1', '--for-session', 'ses-a', '--terminal'], propia: '_nosession', casa: casaT, tty, ahora: AHORA }).codigo, 0);
  const tr = gates(casaT).find((x) => x.name === 'manual-test-signed');
  assert.strictEqual(tr.via, 'terminal');
  assert.strictEqual(tr.destino, 'ses-a');
  for (const k of Object.keys(tr)) assert.doesNotMatch(k, SIN_CITA, `terminal: no guarda una cita (${k})`);
  // la constancia de una firma sobre un archivo
  const casaF = casaNueva(t);
  ow.firmarArchivo({ firma: 'dod_runtime_exempt', via: 'ventana', sesion: 'ses-a', archivo: '/r/specs/story-9.99.md', casa: casaF, ahora: AHORA });
  const dir = path.join(ow.carpeta(casaF), 'files');
  const [f] = fs.readdirSync(dir);
  const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  mira(c, 'archivo');
  assert.strictEqual(c.archivo, '/r/specs/story-9.99.md');
});

// --- lo que encontró el pase adversarial ---------------------------------------------------------------------------

const DISPATCH = path.join(SCRIPTS_PIPE, 'dispatch.js');
const constanciasVigentes = (casa) => { try { return fs.readdirSync(path.join(ow.carpeta(casa), 'files')).filter((f) => f.endsWith('.json')); } catch (_) { return []; } };

test('SignFile_EscrituraFrenadaPorOtraRegla_NoGastaLaFirma (pase adversarial) @story-8.139 @ac-43', (t) => {
  const { repo, historia } = repoNuevo(t);
  const casa = casaNueva(t);
  const viejo = fs.readFileSync(historia, 'utf8');
  // una sola escritura que agrega la exención y cambia el estado: pide las dos firmas
  const nuevo = viejo.replace('status: in-progress', 'status: ready-for-dev\ndod_runtime_exempt: true');
  const ev = { session_id: 'ses-a', tool_use_id: 'toolu_w', tool_name: 'Write', cwd: repo, tool_input: { file_path: historia, content: nuevo } };
  const d = require(DISPATCH);
  ow.firmarArchivo({ firma: 'dod_runtime_exempt', via: 'ventana', sesion: 'ses-a', archivo: historia, casa, ahora: Date.now() });
  d.abrirConsumos();
  const r = fw().handle(ev, { casa });
  assert.ok(r && r.block, 'sin la firma del estado frena');
  assert.match(r.block, /sign-file cambiar-el-estado/, 'el cartel nombra la firma que falta');
  d.cerrarConsumos({ paso: false });
  assert.strictEqual(constanciasVigentes(casa).length, 1, 'la firma de la exención no se gastó');
  // con la otra firma pasa, y recién ahí se gastan las dos
  ow.firmarArchivo({ firma: 'cambiar-el-estado', via: 'ventana', sesion: 'ses-a', archivo: historia, casa, ahora: Date.now() });
  d.abrirConsumos();
  const r2 = fw().handle(ev, { casa });
  assert.ok(!r2 || !r2.block, `con las dos firmas pasa: ${r2 && r2.block}`);
  assert.strictEqual(constanciasVigentes(casa).length, 0, 'mientras el evento no terminó, las dos quedan reservadas');
  assert.deepStrictEqual(d.cerrarConsumos({ paso: true }), []);
  assert.strictEqual(constanciasVigentes(casa).length, 0, 'la escritura pasó: las dos quedan usadas');
  assert.strictEqual(fs.readdirSync(path.join(ow.carpeta(casa), 'files')).filter((f) => /\.consumido-/.test(f)).length, 2);
});

test('SignFile_DosEscriturasALaVez_UnaSolaUsaLaFirma (pase adversarial) @story-8.139 @ac-43', (t) => {
  const { repo, historia } = repoNuevo(t);
  const casa = casaNueva(t);
  const nuevo = fs.readFileSync(historia, 'utf8').replace('status: in-progress', 'status: in-progress\ndod_runtime_exempt: true');
  const ev = { session_id: 'ses-a', tool_use_id: 'toolu_w', tool_name: 'Write', cwd: repo, tool_input: { file_path: historia, content: nuevo } };
  const d = require(DISPATCH);
  ow.firmarArchivo({ firma: 'dod_runtime_exempt', via: 'ventana', sesion: 'ses-a', archivo: historia, casa, ahora: Date.now() });
  // el primer despachador valida la firma y todavía no terminó; el segundo (otro proceso) ya no la encuentra
  d.abrirConsumos();
  const r1 = fw().handle(ev, { casa });
  assert.ok(!r1 || !r1.block, `la primera escritura pasa: ${r1 && r1.block}`);
  const primero = globalThis[Symbol.for('tycon.consumos-diferidos')];
  globalThis[Symbol.for('tycon.consumos-diferidos')] = [];
  const r2 = fw().handle(ev, { casa });
  assert.ok(r2 && r2.block, 'la segunda escritura no usa la misma firma');
  globalThis[Symbol.for('tycon.consumos-diferidos')] = primero;
  d.cerrarConsumos({ paso: false });
  assert.strictEqual(constanciasVigentes(casa).length, 1, 'la primera frenó después: la firma vuelve a su lugar');
});

test('ConfirmarConsumos_NoSePuedeGastar_LoDice (pase adversarial) @story-8.139 @ac-43', (t) => {
  const casa = casaNueva(t);
  const f = path.join(ow.carpeta(casa), 'files', 'no-existe.json');
  const errores = ow.confirmarConsumos([{ f, reservado: `${f}.reservado-1-1`, ahora: 1 }], { paso: true });
  assert.strictEqual(errores.length, 1, 'una firma que no se pudo gastar no se da por gastada');
  assert.strictEqual(errores[0].error, 'ENOENT');
});

test('ConfirmarConsumos_SinPaso_NoSePuedeDevolver_LoDiceYNoPisaUnaFirmaNueva @story-8.139 @ac-43', (t) => {
  const casa = casaNueva(t);
  const dir = path.join(ow.carpeta(casa), 'files');
  fs.mkdirSync(dir, { recursive: true });
  // la reservada desapareció: devolverla falla y se dice
  const f = path.join(dir, 'a.json');
  const errores = ow.confirmarConsumos([{ f, reservado: `${f}.reservado-1-1`, ahora: 1 }], { paso: false });
  assert.strictEqual(errores.length, 1, 'una firma que no se pudo devolver no se da por devuelta');
  assert.strictEqual(errores[0].error, 'ENOENT');
  // mientras la escritura frenaba, la persona firmó otra vez: la nueva queda, la vieja se descarta
  const g = path.join(dir, 'b.json');
  fs.writeFileSync(g, '{"ts":"nueva"}');
  fs.writeFileSync(`${g}.reservado-1-1`, '{"ts":"vieja"}');
  assert.deepStrictEqual(ow.confirmarConsumos([{ f: g, reservado: `${g}.reservado-1-1`, ahora: 1 }], { paso: false }), []);
  assert.strictEqual(fs.readFileSync(g, 'utf8'), '{"ts":"nueva"}', 'la firma nueva no se pisa');
  assert.ok(!fs.existsSync(`${g}.reservado-1-1`), 'la vieja no queda reservada');
});

test('SignFile_FirmaReservadaYPerdida_LoDice (pase adversarial) @story-8.139 @ac-43', (t) => {
  const { repo, historia } = repoNuevo(t);
  const casa = casaNueva(t);
  ow.firmarArchivo({ firma: 'dod_runtime_exempt', via: 'ventana', sesion: 'ses-a', archivo: historia, casa, ahora: Date.now() });
  // un despachador reserva la firma y muere sin cerrarla
  globalThis[Symbol.for('tycon.consumos-diferidos')] = [];
  assert.ok(ow.consumirArchivo({ firma: 'dod_runtime_exempt', sesion: 'ses-a', archivo: historia, cwd: repo, casa }).ok);
  delete globalThis[Symbol.for('tycon.consumos-diferidos')];
  const r = ow.consumirArchivo({ firma: 'dod_runtime_exempt', sesion: 'ses-a', archivo: historia, cwd: repo, casa });
  assert.strictEqual(r.ok, false, 'la firma reservada no se reusa');
  assert.match(r.motivo, /se perdió, firmala de nuevo/);
});

test('Dispatch_UnFrenoPosterior_NoGastaLaFirma (pase adversarial) @story-8.139 @ac-43', (t) => {
  const casa = casaNueva(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-window-dispatch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const archivo = path.join(dir, 'x.md');
  // dos reglas de la cadena: la primera valida la firma, la segunda frena según BLOCK_NEXT
  fs.writeFileSync(path.join(dir, 'valida.js'), `const ow = require(${JSON.stringify(path.join(RAIZ, 'scripts', 'lib', 'owner-window.js'))});
module.exports = { handle: (e) => { const r = ow.consumirArchivo({ firma: 'dod_runtime_exempt', sesion: e.session_id, archivo: e.tool_input.file_path, casa: process.env.SIGNING_HOME }); return r.ok ? null : { block: r.motivo }; } };\n`);
  fs.writeFileSync(path.join(dir, 'frena.js'), "module.exports = { handle: () => (process.env.BLOCK_NEXT === '1' ? { block: 'otra regla' } : null) };\n");
  const corre = `const d = require(${JSON.stringify(DISPATCH)}); const c = d.CHAINS['pre-edit']; c.length = 0;
c.push({ name: 'valida', path: ${JSON.stringify(path.join(dir, 'valida.js'))} }, { name: 'frena', path: ${JSON.stringify(path.join(dir, 'frena.js'))} });
d.dispatch('pre-edit');`;
  const ev = JSON.stringify({ session_id: 'ses-a', tool_use_id: 'toolu_w', hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: dir, tool_input: { file_path: archivo, content: 'x' } });
  const lanzar = (frena) => spawnSync(process.execPath, ['-e', corre], { input: ev, encoding: 'utf8', env: { ...process.env, SIGNING_HOME: casa, BLOCK_NEXT: frena } });
  ow.firmarArchivo({ firma: 'dod_runtime_exempt', via: 'ventana', sesion: 'ses-a', archivo, casa, ahora: Date.now() });
  const r = lanzar('1');
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /otra regla/);
  assert.strictEqual(constanciasVigentes(casa).length, 1, 'frenó otra regla: la firma sigue sin usar');
  const r2 = lanzar('0');
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.strictEqual(constanciasVigentes(casa).length, 0, 'la escritura pasó: la firma quedó usada');
  assert.strictEqual(lanzar('0').status, 2, 'usada, no vuelve a valer');
});

test('SignFile_TerminalSinSesion_NoFirma (pase adversarial) @story-8.139 @ac-43', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-window-sinsesion-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/SESSION_ID$/.test(k)) delete env[k];
  const r = spawnSync(process.execPath, [MARKER, 'sign-file', 'dod_runtime_exempt', path.join(dir, 'x.md'), '--terminal'], { input: '', encoding: 'utf8', env });
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /sin --for-session/, 'dice qué falta');
  assert.doesNotMatch(r.stdout, /firmada/);
});

test('FirmasDelComando_BanderaConCDeOtroPrograma_NoEsUnaConsola (pase adversarial) @story-8.139', () => {
  assert.deepStrictEqual([...ow.firmasDelComando("grep -c 'e2e-setup.js prepare' log.txt")], []);
  assert.deepStrictEqual([...ow.firmasDelComando("grep -rc 'bash /h/scripts/ci/run-base-controls.sh approve' .")], []);
  assert.deepStrictEqual([...ow.firmasDelComando("rg -ic 'node /h/e2e-setup.js defer --no x' .")], []);
  // una consola de verdad sigue contando, también detrás de env o con su ruta
  assert.deepStrictEqual([...ow.firmasDelComando("bash -c 'node /h/e2e-setup.js prepare --repo /r --story s.md'")], ['browser-test']);
  assert.deepStrictEqual([...ow.firmasDelComando("env bash -c 'node /h/e2e-setup.js prepare --repo /r --story s.md'")], ['browser-test']);
  assert.deepStrictEqual([...ow.firmasDelComando("/bin/zsh -lc 'bash /h/scripts/ci/run-base-controls.sh approve'")], ['control-change']);
});

test('Ventana_ArchivoConTilde_MuestraLaRutaDeLaCasa (pase adversarial) @story-8.139 @ac-43', (t) => {
  const casa = casaNueva(t);
  const r = pedir(casa, SIGN_FILE('dod_runtime_exempt', '~/notas/story-9.99.md'));
  assert.strictEqual(r.decision, 'ask', r.texto);
  assert.ok(r.texto.includes(path.join(os.homedir(), 'notas', 'story-9.99.md')), `la ventana muestra la ruta que firma la consola: ${r.texto}`);
  assert.doesNotMatch(r.texto, /[\\/]~[\\/]/, 'no muestra una carpeta «~» que no existe');
});

test('ComoSeFirma_RutaConCaracteresDeLaConsola_VaEntreComillas (pase adversarial) @story-8.139 @ac-43', () => {
  assert.strictEqual(ow.comoSeFirma('dod_runtime_exempt', '/r/specs/story-9.99.md'), 'marker.js sign-file dod_runtime_exempt /r/specs/story-9.99.md');
  assert.strictEqual(ow.comoSeFirma('dod_runtime_exempt'), 'marker.js sign-file dod_runtime_exempt <archivo>');
  for (const ruta of ["/r/it's $HOME (1).md", '/r/a b;c&d.md', '/r/`x`.md']) {
    const linea = ow.comoSeFirma('dod_runtime_exempt', ruta);
    const arg = linea.slice('marker.js sign-file dod_runtime_exempt '.length);
    const eco = spawnSync('bash', ['-c', `printf %s ${arg}`], { encoding: 'utf8' });
    assert.strictEqual(eco.stdout, ruta, `${ruta}: copiado tal cual, la consola lee la misma ruta (${linea})`);
  }
});

test('Ventana_SalteoDelPase_NoDiceQueNoSeDelego (pase adversarial) @story-8.139', (t) => {
  const casa = casaNueva(t);
  const r = pedir(casa, `node ${MARKER} sign-adversarial-skip --story /r/specs/story-9.99.md --reason "sin código"`, { delegacion: delegacionReal() });
  assert.notStrictEqual(r.decision, 'allow');
  assert.doesNotMatch(r.texto || '', /No se firmó por delegación/, 'que no se delegue es lo normal: no se anuncia');
});

// En Windows la terminal no se lee: `--terminal` abre la ventana NUEVA con el mismo comando, como waive-critical, y la
// firma se da adentro con las tres palabras. Sin eso ninguna story pasaba de «Aprobar el plan» en Windows.
test('OwnerWindow_TerminalEnWindows_AbreLaVentanaNueva', (t) => {
  const casa = casaNueva(t);
  const argv = [MARKER, 'complete-step', 'approve-plan', '--terminal', '--for-session', 'ses-a'];
  const exigir = (tty) => { let salida = null; const r = ow.exigir({ firma: 'plan-approval', argv, propia: '_nosession', casa, ahora: AHORA, tty, salir: (c) => { salida = c; } }); return { r, salida }; };
  let abierta = null;
  const afuera = (v) => ({ windows: true, enVentana: () => false, hay: () => false, confirmarFrase: () => { throw new Error('afuera no se pregunta'); }, abrir: (o) => { abierta = o; return v; } });
  let e = exigir(afuera({ estado: 'cerrada', codigo: 0 }));
  assert.strictEqual(abierta.script, MARKER);
  assert.deepStrictEqual(abierta.args, argv.slice(1), 'el mismo comando');
  assert.strictEqual(abierta.programa, process.execPath);
  assert.strictEqual(e.salida, 0, 'sale con el código de la ventana');
  assert.strictEqual(gates(casa).length, 0, 'afuera no se firma: firma el proceso de la ventana');
  assert.strictEqual(exigir(afuera({ estado: 'cerrada', codigo: 1 })).salida, 1);
  // no se abrió, o venció: no firma y lo dice
  e = exigir(afuera({ estado: 'no-abrio', motivo: 'spawnSync cmd.exe ENOENT' }));
  assert.strictEqual(e.r.codigo, 1);
  assert.match(e.r.motivo, /no pude abrir la ventana \(spawnSync cmd\.exe ENOENT\)/);
  assert.strictEqual(e.salida, null);
  e = exigir(afuera({ estado: 'vencida', tope: 300 }));
  assert.strictEqual(e.r.codigo, 1);
  assert.match(e.r.motivo, /la ventana venció a los 300 s sin firmar \(la ventana no llegó a arrancar el comando\)/);
  assert.strictEqual(gates(casa).length, 0);
  // adentro de la ventana: no abre otra, se anota y firma con las tres palabras
  let anotada = 0;
  const adentro = { windows: true, enVentana: () => true, hay: () => true, confirmarFrase: () => true, dentro: () => { anotada++; }, abrir: () => { throw new Error('no abre otra'); } };
  e = exigir(adentro);
  assert.strictEqual(e.r.codigo, 0, e.r.motivo);
  assert.strictEqual(e.r.via, 'terminal');
  assert.strictEqual(anotada, 1);
  assert.strictEqual(gates(casa).find((g) => g.name === 'plan-approval-signed').via, 'terminal');
  assert.strictEqual(exigir({ ...adentro, confirmarFrase: () => false }).r.codigo, 1, 'sin las tres palabras no firma');
  // en la Mac no cambia nada
  e = exigir({ windows: false, hay: () => true, preguntar: () => 'firmo', abrir: () => { throw new Error('en la Mac no hay ventana'); } });
  assert.strictEqual(e.r.codigo, 0, e.r.motivo);
});

test('OwnerWindow_VentanaDeWindows_DiceQueSeFirmaAntesDeLasTresPalabras', (t) => {
  const casa = casaNueva(t);
  const argv = [MARKER, 'complete-step', 'approve-plan', '--terminal', '--for-session', 'ses-a'];
  const dicho = [];
  let alPreguntar = null;
  const original = console.error;
  console.error = (...a) => { dicho.push(a.join(' ')); };
  try {
    ow.exigir({ firma: 'plan-approval', argv, propia: '_nosession', resumen: 'el plan de la story 9.97', casa, ahora: AHORA, salir: () => {}, aprobador: DEL_ARNES,
      tty: { windows: true, enVentana: () => true, hay: () => true, dentro: () => {}, confirmarFrase: () => { alPreguntar = dicho.join('\n'); return true; } } });
  } finally { console.error = original; }
  // sin esto el dueño escribe las tres palabras sin saber qué firma: el agente elige el plan, la vuelta o el salteo
  assert.ok(alPreguntar !== null, 'preguntó las tres palabras');
  assert.match(alPreguntar, /Firma del dueño: .*\(el plan de la story 9\.97\), sesión ses-a\./);
});

/** Un HOME con el marcador de una corrida parada en «Aprobar el plan» (sesión ses-w) y un repo con la story. */
function laboratorioWindows(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-win-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  const activos = path.join(home, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(activos, { recursive: true });
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  assert.strictEqual(spawnSync('git', ['init', '-q', repo]).status, 0);
  const story = path.join(repo, 'specs', 'story-9.97-ventana.md');
  fs.writeFileSync(story, '---\nstory: "9.97"\nstatus: ready-for-dev\n---\n# Story 9.97\n');
  const pasos = ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'adversarial-pass', 'findings', 'live-check', 'prepare-commit'];
  fs.writeFileSync(path.join(activos, 'ses-w.json'), JSON.stringify({ sessionId: 'ses-w', storyId: '9.97', storyPath: story, repo, stepScheme: 2, stepsCompleted: pasos.slice(0, 3), stepsPending: pasos.slice(3) }));
  // su apertura en el registro: de ahí sale la ejecución que cierra «clear-session --lost»
  fs.writeFileSync(path.join(activos, '..', 'gates.log'), `${JSON.stringify({ ts: new Date(AHORA).toISOString(), name: 'run-open', sesion: 'ses-w', story: '9.97', runDir: path.join(base, 'run') })}\n`);
  return { home, repo, story };
}

test('OwnerWindow_CadaFirmaPorTerminal_AbreLaVentanaEnWindows', (t) => {
  if (process.platform === 'win32') return;   // en Windows de verdad se abriría: eso lo mide el ensayo de Windows
  const { home, repo, story } = laboratorioWindows(t);
  // Windows simulado, sin cmd.exe y en la terminal del dueño (sin variable de sesión): cada firma intenta abrir la ventana
  // (la vuelta extra pide una corrida con el tope ya avisado; llega a la misma `exigir` que las de acá)
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_HOME: '', TYCON_WAIVER_PLATFORM: 'win32', TYCON_WAIVER_IN_WINDOW: '', TYCON_LANE_LLM: '0' };
  // sin las variables de la CI: en la CI la firma por la terminal se corta antes de abrir la ventana
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'CI', 'TF_BUILD', 'GITHUB_ACTIONS']) delete env[k];
  const casos = [
    ['plan-approval', process.execPath, [MARKER, 'complete-step', 'approve-plan', '--terminal', '--for-session', 'ses-w']],
    ['lost-run', process.execPath, [MARKER, 'clear-session', 'ses-w', '--lost', '--terminal', '--for-session', 'ses-w']],
    ['browser-test', process.execPath, [E2E, 'prepare', '--repo', repo, '--story', story, '--terminal', '--for-session', 'ses-w']],
    ['control-change', 'bash', [CONTROLES, 'approve', '--root', repo, '--file', 'specs/story-9.97-ventana.md', '--terminal']],
  ];
  for (const [firma, prog, args] of casos) {
    const r = spawnSync(prog, args, { cwd: repo, env, encoding: 'utf8', input: '', timeout: 60000 });
    const out = `${r.stdout}${r.stderr}`;
    assert.notStrictEqual(r.status, 0, `${firma}: ${out}`);
    assert.match(out, /no pude abrir la ventana/, `${firma}: intenta abrir la ventana nueva: ${out}`);
    assert.doesNotMatch(out, /aquí no hay una|terminal interactiva de verdad/, firma);
  }
});

test('OwnerWindow_MarcaDeLaVentanaPuestaAMano_NoFirma', (t) => {
  if (process.platform === 'win32') return;   // acá la consola no se le puede preguntar a Windows: siempre «no es nueva»
  const { home, repo } = laboratorioWindows(t);
  // lo que haría el agente para saltear la ventana: la marca puesta y la respuesta por la entrada
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_HOME: '', TYCON_WAIVER_PLATFORM: 'win32', TYCON_WAIVER_IN_WINDOW: '1', TYCON_LANE_LLM: '0' };
  // sin las variables de la CI: en la CI la firma por la terminal se corta antes de abrir la ventana
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'CI', 'TF_BUILD', 'GITHUB_ACTIONS']) delete env[k];
  const plan = spawnSync(process.execPath, [MARKER, 'complete-step', 'approve-plan', '--terminal', '--for-session', 'ses-w'], { cwd: repo, env, encoding: 'utf8', input: 'gato luna reloj\n', timeout: 60000 });
  assert.strictEqual(plan.status, 2, `${plan.stdout}${plan.stderr}`);
  assert.ok(!fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'gates.log'), 'utf8').includes('plan-approval-signed'), 'no firmó el plan');
  // el portón, con los argumentos por el ambiente como los pasa la ventana: los lee, y sin la ventana nueva no firma
  const argv = JSON.stringify(['approve', '--root', repo, '--file', 'specs/story-9.97-ventana.md', '--terminal']);
  const ctl = spawnSync('bash', [CONTROLES, 'approve'], { cwd: repo, env: { ...env, BASE_CONTROLS_WINDOW_ARGS: argv }, encoding: 'utf8', input: 'gato luna reloj\n', timeout: 60000 });
  assert.strictEqual(ctl.status, 2, `${ctl.stdout}${ctl.stderr}`);
  assert.match(ctl.stderr, /en Windows firma sólo la ventana nueva que abre este comando/);
  assert.strictEqual(fs.existsSync(path.join(repo, '.tycon')), false, 'no escribió ninguna constancia');
});

test('OwnerWindow_PortonEnLaVentana_LeeElProgramaDeUnArchivoYNoDeLaEntrada', (t) => {
  if (process.platform === 'win32') return;
  const { repo } = laboratorioWindows(t);
  const argv = JSON.stringify(['approve', '--root', repo, '--file', 'specs/story-9.97-ventana.md', '--terminal']);
  const env = { ...process.env, TYCON_WAIVER_PLATFORM: 'win32', TYCON_WAIVER_IN_WINDOW: '1', BASE_CONTROLS_WINDOW_ARGS: argv, BASE_CONTROLS_SELF_DIR: path.dirname(CONTROLES) };
  // lo que corre la ventana: node con el lanzador, sin programa por la entrada (la entrada queda para la consola)
  const r = spawnSync(process.execPath, [path.join(path.dirname(CONTROLES), 'run-base-controls-window.js'), 'approve'], { cwd: repo, env, encoding: 'utf8', input: 'gato luna reloj\n', timeout: 60000 });
  assert.strictEqual(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /en Windows firma sólo la ventana nueva que abre este comando/, 'corrió el programa del portón');
  assert.strictEqual(fs.existsSync(path.join(repo, '.tycon')), false);
  // los argumentos por el ambiente valen sólo para approve en Windows: otro comando, o fuera de Windows, usa los suyos
  const otro = spawnSync('bash', [CONTROLES, 'nada'], { cwd: repo, env, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(otro.status, 2);
  assert.match(otro.stderr, /^uso: /m);
  const mac = spawnSync('bash', [CONTROLES, 'approve'], { cwd: repo, env: { ...env, TYCON_WAIVER_PLATFORM: '' }, encoding: 'utf8', timeout: 60000 });
  assert.doesNotMatch(mac.stderr, /ventana nueva/, `${mac.stdout}${mac.stderr}`);
});

// ── Las tres firmas pedidas para otra sesión ──────────────────────────────────────────────────────────────────────────

/** Las tres, pedidas por la coordinadora para ses-a; la de los criterios, sobre la historia de la corrida de ses-a. */
function tresParaOtra(casa) {
  const { repo, story } = HISTORIA;
  fs.writeFileSync(path.join(casa, '.claude', '.tycon-pipeline', 'active', 'ses-a.json'), JSON.stringify({ sessionId: 'ses-a', storyId: '9.91', storyPath: story, repoPath: repo }));
  return [
    ['escape:force-manual', `node ${MARKER} set-check dod green --force-manual --for-session ses-a`],
    ['escape:trust-ran', `node ${PIPELINE} check-count --repo ${repo} --story ${story} --trust-ran --ran a --for-session ses-a`],
    ['runtime-waiver', `node ${MARKER} runtime-waiver ${story} --acs 1 --for-session ses-a`],
  ];
}

test('TresFirmas_OwnerOnly_NoSeDelegan (T12) @story-8.142 @ac-9', (t) => {
  for (const [firma] of tresParaOtra(casaNueva(t))) {
    const casa = casaConDesignada(t);
    const [, cmd] = tresParaOtra(casa).find(([f]) => f === firma);
    // con todas las llaves, salvo que el perfil la deja sólo al dueño
    const delegacion = delegacionReal({ perfil: { ...PERFIL, delegated_signing: [firma], owner_only: [firma] } });
    const r = pedir(casa, cmd, { evento: DE_LA_COORD, delegacion });
    assert.strictEqual(r.decision, 'ask', `${firma}: ${r.texto}`);
    assert.notStrictEqual(registroVigente(casa).via, 'delegacion', firma);
    // y con las mismas llaves sin el candado, la delegación la firma: la diferencia es owner_only
    const casa2 = casaConDesignada(t);
    const [, cmd2] = tresParaOtra(casa2).find(([f]) => f === firma);
    const libre = pedir(casa2, cmd2, { evento: DE_LA_COORD, delegacion: delegacionReal({ perfil: { ...PERFIL, delegated_signing: [firma], owner_only: [] } }) });
    assert.strictEqual(libre.decision, 'allow', `${firma}: ${libre.texto}`);
  }
});

test('TresFirmas_SinPerfil_PidenVentana (T13) @story-8.142 @ac-9', (t) => {
  for (const [firma, cmd] of tresParaOtra(casaNueva(t))) {
    const casa = casaConDesignada(t);
    tresParaOtra(casa);
    const r = pedir(casa, cmd, { evento: DE_LA_COORD, delegacion: delegacionReal({ perfil: {} }) });
    assert.strictEqual(r.decision, 'ask', `${firma}: ${r.texto}`);
    assert.deepStrictEqual(r.firmas, [firma]);
    assert.match(r.texto, /sesión ses-a/, `${firma}: el texto dice la sesión destino`);
    const reg = registroVigente(casa);
    assert.deepStrictEqual([reg.firma, reg.sesion, reg.destino], [firma, 'ses-coord', 'ses-a']);
    assert.deepStrictEqual(reg.corrida, { storyId: '9.91', startedAt: null });
  }
  // la historia de los criterios tiene que ser la de la corrida de ses-a
  const casa = casaNueva(t);
  tresParaOtra(casa);
  fs.writeFileSync(path.join(casa, '.claude', '.tycon-pipeline', 'active', 'ses-a.json'), JSON.stringify({ sessionId: 'ses-a', storyId: '9.99', storyPath: '/r/specs/story-9.99.md' }));
  const r = pedir(casa, `node ${MARKER} runtime-waiver ${HISTORIA.story} --acs 1 --for-session ses-a`, { evento: DE_LA_COORD });
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.texto, /no es la historia de la ejecución de la sesión ses-a/);
});

test('EscapePhrases_SinLasDosFirmas (T17) @story-8.142 @ac-9', (t) => {
  const cat = require('../lib/signatures.js');
  // el grupo de delegated_signing no las trae; el de owner_only, sí
  const grupo = cat.expand('escape-phrases');
  assert.ok(!grupo.includes('escape:force-manual') && !grupo.includes('escape:trust-ran'), grupo.join(', '));
  assert.ok(grupo.includes('escape:TYCON_SAFETY_OFF'));
  const restringe = cat.expand('escape-phrases', { restringe: true });
  assert.ok(restringe.includes('escape:force-manual') && restringe.includes('escape:trust-ran'));
  // un perfil que delega el grupo no delega trust-ran para otra sesión: pide la ventana
  const casa = casaConDesignada(t);
  const [, cmd] = tresParaOtra(casa).find(([f]) => f === 'escape:trust-ran');
  const r = pedir(casa, cmd, { evento: DE_LA_COORD, delegacion: delegacionReal({ perfil: { ...PERFIL, delegated_signing: ['escape-phrases'] } }) });
  assert.strictEqual(r.decision, 'ask', r.texto);
  // el grupo en owner_only las sigue dejando al dueño, aunque delegated_signing las nombre
  const s = DS.delegaSinVentana({ firma: 'escape:trust-ran', sesion: 'ses-coord', destino: 'ses-a', home: casa, estado: path.join(casa, '.claude', '.tycon-pipeline'),
    perfil: () => ({ ...PERFIL, delegated_signing: ['escape:trust-ran'], owner_only: ['escape-phrases'] }), huella: () => ({ huella: HUELLA }) });
  assert.strictEqual(s.ok, false);
  assert.match(s.motivo, /sólo del dueño/);
});

// ── el ok de guardar: «save» (@story-8.143) ───────────────────────────────────────────────────────────────────────
const SAVE = `node ${MARKER} approve-save --for-session ses-a`;
const SAVE_ARGV = [MARKER, 'approve-save', '--for-session', 'ses-a'];

test('Freno_ApproveSave_FormaCanonica (T12) @story-8.143 @ac-1', (t) => {
  const casa = casaNueva(t);
  assert.deepStrictEqual(ow.firmasDelComando(SAVE), ['save']);
  const r = pedir(casa, SAVE, { evento: DE_LA_COORD });
  assert.strictEqual(r.decision, 'ask', r.texto);
  assert.match(r.texto, /sesión ses-a/, 'el destino en el texto');
  for (const cmd of [`CLAUDE_CODE_SESSION_ID=ses-a node ${MARKER} approve-save`, `cd /tmp && node ${MARKER} approve-save --for-session ses-a`]) {
    const otra = casaNueva(t);
    assert.strictEqual(pedir(otra, cmd, { evento: DE_LA_COORD }).decision, 'deny', cmd);
    assert.strictEqual(registros(otra).length, 0, `${cmd}: sin registro`);
  }
});

// Una pestaña que no pide permisos (bypass y parecidos) aprueba sola lo que el freno manda a la ventana: el renglón
// quedaría a nombre del dueño sin que nadie haya dicho Sí. Ahí la firma se niega con el comando de la terminal; en una
// pestaña que pregunta, la ventana de siempre; la delegación no usa ventana y sigue valiendo.
// 🔴 mutación: sin mirar el modo de permisos → en bypass sale 'ask' y la ventana se aprueba sola.
test('Freno_PestanaSinPermisos_NiegaLaVentana_ConElComandoDeLaTerminal', (t) => {
  for (const modo of ['bypassPermissions', 'dontAsk', 'auto', 'un-modo-nuevo']) {
    const casa = casaNueva(t);
    const r = pedir(casa, SAVE, { evento: { ...DE_LA_COORD, permission_mode: modo } });
    assert.strictEqual(r.decision, 'deny', `${modo}: ${r.texto}`);
    assert.match(r.texto, /no pide permisos/, modo);
    assert.match(r.texto, /approve-save --terminal .*con --for-session ses-a/, `${modo}: el comando de la terminal`);
    assert.strictEqual(registros(casa).length, 0, `${modo}: sin registro de ventana`);
  }
  for (const modo of ['default', 'acceptEdits', 'plan', undefined]) {
    const casa = casaNueva(t);
    const ev = modo === undefined ? DE_LA_COORD : { ...DE_LA_COORD, permission_mode: modo };
    assert.strictEqual(pedir(casa, SAVE, { evento: ev }).decision, 'ask', String(modo));
  }
  // la delegación no pasa por la ventana: en una pestaña sin permisos sigue firmando
  const conSave = { ...PERFIL, delegated_signing: ['save'] };
  const r = pedir(casaConDesignada(t), SAVE, { evento: { ...DE_LA_COORD, permission_mode: 'bypassPermissions' }, delegacion: delegacionReal({ perfil: conSave }) });
  assert.strictEqual(r.decision, 'allow', r.texto);
  assert.strictEqual(r.via, 'delegacion');
});

test('ApproveSave_SeisLlaves (T13) @story-8.143 @ac-8', (t) => {
  const conSave = { ...PERFIL, delegated_signing: ['save'] };
  const casa = casaConDesignada(t);
  const r = pedir(casa, SAVE, { evento: DE_LA_COORD, delegacion: delegacionReal({ perfil: conSave }) });
  assert.strictEqual(r.decision, 'allow', r.texto);
  assert.strictEqual(r.via, 'delegacion');
  const e = ow.exigir({ firma: 'save', argv: SAVE_ARGV, pid: 301, arbol: arbolDelGuion(casa, SAVE), casa, ahora: AHORA + 60000, propia: 'ses-coord' });
  assert.strictEqual(e.codigo, 0, e.motivo);
  assert.strictEqual(e.via, 'delegacion');
  // sin cada llave, por vez: la ventana (o la negación), nunca la delegación
  const sinLlave = [
    ['la firma no está delegada', () => [casaConDesignada(t), PERFIL, DE_LA_COORD, HUELLA]],
    ['la máquina no está', () => [casaConDesignada(t), conSave, DE_LA_COORD, 'otra-huella']],
    ['la designación sin confirmar', () => [casaConDesignada(t, { confirmada: false }), conSave, DE_LA_COORD, HUELLA]],
    ['la sesión no es la designada', () => [casaConDesignada(t), conSave, { session_id: 'ses-otra' }, HUELLA]],
    ['la designada es la destino', () => [casaConDesignada(t, { designada: 'ses-a' }), conSave, { session_id: 'ses-a' }, HUELLA]],
  ];
  for (const [nombre, armar] of sinLlave) {
    const [c, perfil, ev, huella] = armar();
    const x = pedir(c, SAVE, { evento: ev, delegacion: delegacionReal({ perfil, huella }) });
    assert.notStrictEqual(x.via, 'delegacion', nombre);
  }
  // la misma story en la ejecución abierta de la coordinadora
  const misma = casaConDesignada(t);
  fs.writeFileSync(path.join(misma, '.claude', '.tycon-pipeline', 'active', 'ses-coord.json'), JSON.stringify({ sessionId: 'ses-coord', storyId: '9.99' }));
  assert.notStrictEqual(pedir(misma, SAVE, { evento: DE_LA_COORD, delegacion: delegacionReal({ perfil: conSave }) }).via, 'delegacion', 'la misma story');
});

// --- el arreglo rápido: la firma adhoc-lane -------------------------------------------------------------------------

const ADHOC = `node ${MARKER} adhoc set '{"reason":"arreglo del sp","maxFiles":3}'`;
const ADHOC_PARA_A = `node ${MARKER} adhoc set '{"reason":"arreglo del sp","maxFiles":20}' --for-session ses-a`;
const ADHOC_PARA_A_ARGV = [MARKER, 'adhoc', 'set', '{"reason":"arreglo del sp","maxFiles":20}', '--for-session', 'ses-a'];

// 8.141 T8 OwnerWindow_AdhocSet_PideLaVentana @story-8.141 @ac-3 @ac-4
// 🔴 Falla con: `adhoc set` sin pedir la ventana, la ventana sin el motivo o el cupo, `get`/`clear` pidiendo firma, o
// una forma escondida (`cd … &&`, el subcomando en una variable) que no se niega.
test('8.141 T8 OwnerWindow_AdhocSet_PideLaVentana', (t) => {
  const casa = casaNueva(t);
  const r = pedir(casa, ADHOC);
  assert.strictEqual(r.decision, 'ask', r.texto);
  assert.deepStrictEqual(r.firmas, ['adhoc-lane']);
  assert.match(r.texto, /Firma del dueño: abrir el arreglo rápido de una sesión, sin historia\. Story 9\.99, sesión ses-a\./);
  assert.match(r.texto, /Detalle: el motivo: «arreglo del sp» · hasta 3 archivos/);
  for (const sub of ['adhoc get', 'adhoc clear', 'adhoc clear-orphan ses-b']) {
    assert.strictEqual(pedir(casaNueva(t), `node ${MARKER} ${sub}`).decision, 'none', sub);
  }
  const conCd = pedir(casaNueva(t), `cd /r && ${ADHOC}`);
  assert.strictEqual(conCd.decision, 'deny');
  assert.match(conCd.texto, /forma exacta/);
  const codex = casaNueva(t);
  const c = pedir(codex, ADHOC, { evento: { turn_id: 'turn-1' } });
  assert.strictEqual(c.decision, 'deny');
  assert.match(c.texto, /en tu terminal: marker\.js adhoc set '<json>' --terminal --for-session <id>/);
  assert.strictEqual(registros(codex).length, 0);
  // el subcomando en una variable cuenta como el arreglo rápido, y la forma lo niega
  const opaca = pedir(casaNueva(t), `S=set; node ${MARKER} adhoc "$S" '{"reason":"arreglo del sp"}'`);
  assert.deepStrictEqual(opaca.firmas, ['adhoc-lane']);
  assert.strictEqual(opaca.decision, 'deny');
  // con el «Sí», el guion firma; sin pedido de la ventana, no
  const v = ow.exigir({ firma: 'adhoc-lane', argv: [MARKER, 'adhoc', 'set', '{"reason":"arreglo del sp","maxFiles":3}'], pid: 301, arbol: arbolDelGuion(casa, ADHOC), casa, ahora: AHORA + 60000, propia: 'ses-a' });
  assert.strictEqual(v.codigo, 0, v.motivo);
  assert.strictEqual(v.via, 'ventana');
  const sin = casaNueva(t);
  assert.strictEqual(ow.exigir({ firma: 'adhoc-lane', argv: [MARKER, 'adhoc', 'set', '{"reason":"arreglo del sp"}'], pid: 301, arbol: arbolDelGuion(sin, ADHOC), casa: sin, ahora: AHORA + 60000, propia: 'ses-a' }).codigo, 1);
});

// 8.141 T8b OwnerWindow_AdhocSet_MotivoConFlags_PideLaVentana @story-8.141 @ac-4 @ac-6
// Prueba que confirmó el pase adversarial (false-positive-edge-1): el freno miraba el texto entero del comando, y un
// motivo que nombra un flag o una variable de sesión negaba la ventana y la delegación.
// 🔴 Falla con: un motivo legítimo que nombra `--ok`, `--quote`, `--relayed-by` o CLAUDE_CODE_SESSION_ID negado; o esas
// formas como argumento de verdad (fuera del motivo) que dejan de negarse.
test('8.141 T8b OwnerWindow_AdhocSet_MotivoConFlags_PideLaVentana', (t) => {
  for (const motivo of ['el flag --ok del CLI no anda', 'el parser de --quote rompe con tildes', 'falta --relayed-by en la ayuda', 'on-prompt lee mal CLAUDE_CODE_SESSION_ID']) {
    const cmd = `node ${MARKER} adhoc set '${JSON.stringify({ reason: motivo })}'`;
    const r = pedir(casaNueva(t), cmd);
    assert.strictEqual(r.decision, 'ask', `${motivo}: ${r.texto}`);
    const d = pedir(casaConDesignada(t), `${cmd} --for-session ses-a`, { evento: DE_LA_COORD, delegacion: delegacionReal({ perfil: { ...PERFIL, delegated_signing: ['adhoc-lane'] } }) });
    assert.strictEqual(d.decision, 'allow', `${motivo} (delegada): ${d.texto}`);
  }
  // como argumentos de verdad siguen negándose
  assert.strictEqual(pedir(casaNueva(t), `${ADHOC} --ok`).decision, 'deny');
  assert.strictEqual(pedir(casaNueva(t), `CLAUDE_CODE_SESSION_ID=ses-z ${ADHOC}`).decision, 'deny');
  assert.strictEqual(pedir(casaNueva(t), `node ${MARKER} complete-step approve-plan --approved "dale" --quote "x"`).decision, 'deny');
});

// 8.141 T10 AdhocSet_ElChatNoAutoriza (la ventana de otro motivo) @story-8.141 @ac-8
// 🔴 Falla con: un motivo copiado del mensaje del dueño que firma con el «Sí» que el dueño dio para otro motivo.
test('8.141 T10 AdhocSet_ElChatNoAutoriza (la ventana de otro motivo)', (t) => {
  const casa = casaNueva(t);
  assert.strictEqual(pedir(casa, ADHOC).decision, 'ask');
  const copiado = `node ${MARKER} adhoc set '{"reason":"arreglo rápido: el botón de guardar"}'`;
  const e = ow.exigir({ firma: 'adhoc-lane', argv: [MARKER, 'adhoc', 'set', '{"reason":"arreglo rápido: el botón de guardar"}'], pid: 301, arbol: arbolDelGuion(casa, copiado), casa, ahora: AHORA + 60000, propia: 'ses-a' });
  assert.strictEqual(e.codigo, 1, 'el «Sí» era para otro motivo');
  assert.strictEqual(gates(casa).filter((x) => x.name === 'adhoc-lane-signed').length, 0);
});

// 8.141 T11 AdhocSet_ForSession_Delegada_SinVentana (el freno) @story-8.141 @ac-6
// 🔴 Falla con: la designada, con todas las llaves, frenada en la ventana; o el guion que no firma con via: delegacion.
test('8.141 T11 AdhocSet_ForSession_Delegada_SinVentana', (t) => {
  const casa = casaConDesignada(t);
  const r = pedir(casa, ADHOC_PARA_A, { evento: DE_LA_COORD, delegacion: delegacionReal({ perfil: { ...PERFIL, delegated_signing: ['adhoc-lane'] } }) });
  assert.strictEqual(r.decision, 'allow', r.texto);
  assert.strictEqual(r.via, 'delegacion');
  const reg = registroVigente(casa);
  assert.strictEqual(reg.firma, 'adhoc-lane');
  assert.strictEqual(reg.sesion, 'ses-coord');
  assert.strictEqual(reg.destino, 'ses-a');
  const e = ow.exigir({ firma: 'adhoc-lane', argv: ADHOC_PARA_A_ARGV, pid: 301, arbol: arbolDelGuion(casa, ADHOC_PARA_A), casa, ahora: AHORA + 60000, propia: 'ses-coord' });
  assert.strictEqual(e.codigo, 0, e.motivo);
  assert.strictEqual(e.via, 'delegacion');
  assert.strictEqual(e.sesion, 'ses-coord');
});

// 8.141 T12 AdhocSet_ForSession_SinLlaves_AbreLaVentana @story-8.141 @ac-6 @ac-8 @ac-10
// 🔴 Falla con: una designada sin alguna llave que declara sin ventana (sin la clave en el perfil, con otro grupo, con la
// firma sólo del dueño, en otra máquina o sin la designación confirmada).
test('8.141 T12 AdhocSet_ForSession_SinLlaves_AbreLaVentana', (t) => {
  const conAdhoc = { ...PERFIL, delegated_signing: ['adhoc-lane'] };
  const casos = [
    ['sin approvals', casaConDesignada(t), delegacionReal({ perfil: {} }), false],
    ['con escape-phrases', casaConDesignada(t), delegacionReal({ perfil: { ...PERFIL, delegated_signing: ['escape-phrases'] } }), false],
    ['sólo del dueño', casaConDesignada(t), delegacionReal({ perfil: { ...conAdhoc, owner_only: ['adhoc-lane'] } }), false],
    ['máquina fuera de la lista', casaConDesignada(t), delegacionReal({ perfil: conAdhoc, huella: 'ffffffffffffffff' }), true],
    ['designación sin confirmar', casaConDesignada(t, { confirmada: false }), delegacionReal({ perfil: conAdhoc }), true],
  ];
  for (const [nombre, casa, delegacion, motivo] of casos) {
    const r = pedir(casa, ADHOC_PARA_A, { evento: DE_LA_COORD, delegacion });
    assert.strictEqual(r.decision, 'ask', `${nombre}: ${r.texto}`);
    assert.notStrictEqual(registroVigente(casa).via, 'delegacion', nombre);
    if (motivo) assert.match(r.texto, /No se firmó por delegación: /, nombre);
  }
});

// 8.141 T13 AdhocSet_ForSession_ParaSiMisma @story-8.141 @ac-6 @ac-8
// 🔴 Falla con: la designada que se declara el atajo a sí misma sin ventana.
test('8.141 T13 AdhocSet_ForSession_ParaSiMisma', (t) => {
  const casa = casaConDesignada(t);
  const r = pedir(casa, `node ${MARKER} adhoc set '{"reason":"arreglo del sp"}' --for-session ses-coord`,
    { evento: DE_LA_COORD, delegacion: delegacionReal({ perfil: { ...PERFIL, delegated_signing: ['adhoc-lane'] } }) });
  assert.notStrictEqual(r.decision, 'allow', r.texto);
  assert.strictEqual(r.decision, 'ask');
});

// --- la salida de una ejecución perdida: la sesión que se cierra es la que nombra el comando ------------------------

/** La salida de ses-a pedida por ses-coord, cuya ejecución es otra story: el dueño lee y firma la de ses-a. */
function salidaDeOtraSesion(t, cmd, argv) {
  const casa = casaNueva(t);
  fs.writeFileSync(path.join(casa, '.claude', '.tycon-pipeline', 'active', 'ses-coord.json'), JSON.stringify({ sessionId: 'ses-coord', storyId: '9.92', storyPath: '/r/specs/story-9.92.md' }));
  const r = pedir(casa, cmd, { evento: DE_LA_COORD });
  assert.strictEqual(r.decision, 'ask', `${cmd}: ${r.texto}`);
  assert.match(r.texto, /Story 9\.99, sesión ses-a\./, `${cmd}: la story y la sesión que se cierran`);
  assert.doesNotMatch(r.texto, /9\.92/, `${cmd}: no la de quien pide`);
  const reg = registroVigente(casa);
  assert.strictEqual(reg.sesion, 'ses-coord', cmd);
  assert.strictEqual(reg.destino, 'ses-a', cmd);
  const e = ow.exigir({ firma: 'lost-run', argv, pid: 301, arbol: arbolDelGuion(casa, cmd), casa, ahora: AHORA + 60000, propia: 'ses-coord' });
  assert.strictEqual(e.codigo, 0, `${cmd}: ${e.motivo}`);
  assert.strictEqual(e.destino, 'ses-a', cmd);
  const g = gates(casa).filter((x) => x.name === 'lost-run-signed');
  assert.strictEqual(g.length, 1, cmd);
  assert.strictEqual(g[0].sesion, 'ses-coord', cmd);
  assert.strictEqual(g[0].destino, 'ses-a', cmd);
}

test('OwnerWindow_SalidaPerdidaSinForSession_MuestraLaSesionQueCierra', (t) => {
  salidaDeOtraSesion(t, `node ${MARKER} clear-session ses-a --lost`, [MARKER, 'clear-session', 'ses-a', '--lost']);
});

test('OwnerWindow_SalidaPerdidaConForSessionIgual_MuestraLaSesionQueCierra', (t) => {
  salidaDeOtraSesion(t, `node ${MARKER} clear-session ses-a --lost --for-session=ses-a`, [MARKER, 'clear-session', 'ses-a', '--lost', '--for-session=ses-a']);
});

test('OwnerWindow_SalidaPerdidaConDosSesiones_NoSePide', (t) => {
  const casa = casaNueva(t);
  for (const cmd of [`node ${MARKER} clear-session ses-a --lost --for-session ses-b`, `node ${MARKER} clear-session ses-a --lost --for-session=ses-b`]) {
    const r = pedir(casa, cmd, { evento: DE_LA_COORD });
    assert.strictEqual(r.decision, 'deny', `${cmd}: ${r.texto}`);
    assert.match(r.texto, /nombra la sesión ses-a/, cmd);
  }
  assert.strictEqual(vigentes(casa).length, 0, 'no quedó ningún pedido');
});

test('OwnerWindow_RestoreDeOtraSesion_FirmaParaQuienLoTrae', (t) => {
  // restore rearma la ejecución perdida de ses-b en la sesión que corre el comando: ése es el destino que se firma
  const casa = casaNueva(t);
  const cmd = `node ${MARKER} restore ses-b`;
  const r = pedir(casa, cmd);
  assert.strictEqual(r.decision, 'ask', r.texto);
  assert.match(r.texto, /sesión ses-a\./);
  assert.strictEqual(registroVigente(casa).destino, 'ses-a');
  const e = ow.exigir({ firma: 'lost-run', argv: [MARKER, 'restore', 'ses-b'], pid: 301, arbol: arbolDelGuion(casa, cmd), casa, ahora: AHORA + 60000, propia: 'ses-a' });
  assert.strictEqual(e.codigo, 0, e.motivo);
  assert.strictEqual(e.destino, 'ses-a');
});

// --- quién aprueba: el dueño en los repos del arnés, vos en los demás -----------------------------------------------

// aprobador T5 OwnerWindow_RepoDeProducto_LoAprobasVos
// 🔴 Falla con: la ventana de un repo de producto que dice «Firma del dueño», o el freno que no mira la carpeta del
// evento para decidirlo.
test('aprobador T5 OwnerWindow_RepoDeProducto_LoAprobasVos', (t) => {
  const vistas = [];
  const r = pedir(casaNueva(t), ADHOC, { evento: { cwd: '/repos/producto' }, aprobador: (cwd) => { vistas.push(cwd); return APPROVERS.dev; } });
  assert.strictEqual(r.decision, 'ask', r.texto);
  assert.match(r.texto, /^Lo aprobás vos: abrir el arreglo rápido de una sesión, sin historia\. Story 9\.99, sesión ses-a\./);
  assert.doesNotMatch(r.texto, /dueño/);
  assert.match(r.texto, /firmala en tu terminal/);
  assert.deepStrictEqual(vistas, ['/repos/producto'], 'decide con la carpeta del evento');
  // en el repo del arnés, el dueño
  assert.match(pedir(casaNueva(t), ADHOC).texto, /^Firma del dueño: /);
});

// aprobador T6 OwnerWindow_Terminal_LoAprobasVos
// 🔴 Falla con: la firma en la terminal o la ventana nueva de Windows de un repo de producto que dicen «el dueño».
test('aprobador T6 OwnerWindow_Terminal_LoAprobasVos', (t) => {
  const casa = casaNueva(t);
  const argv = [MARKER, 'complete-step', 'approve-plan', '--terminal', '--for-session', 'ses-a'];
  const DEV = () => APPROVERS.dev;
  let pregunta = null;
  const r = ow.exigir({ firma: 'plan-approval', argv, propia: '_nosession', casa, ahora: AHORA, aprobador: DEV,
    tty: { windows: false, hay: () => true, preguntar: (p) => { pregunta = p; return 'no'; } } });
  assert.strictEqual(r.codigo, 1);
  assert.match(pregunta, /Lo aprobás vos: aprobar el plan de una story, sesión ses-a\./);
  const sinTerminal = ow.exigir({ firma: 'plan-approval', argv, propia: '_nosession', casa, ahora: AHORA, aprobador: DEV, tty: { windows: false, hay: () => false } });
  assert.strictEqual(sinTerminal.codigo, 2);
  assert.match(sinTerminal.motivo, /en tu terminal/);
  let titulo = null;
  ow.exigir({ firma: 'plan-approval', argv, propia: '_nosession', casa, ahora: AHORA, aprobador: DEV, salir: () => {},
    tty: { windows: true, enVentana: () => false, abrir: (o) => { titulo = o.titulo; return { estado: 'cerrada', codigo: 1 }; } } });
  assert.strictEqual(titulo, 'Lo aprobás vos');
});

// --- aprobar un pendiente por delegación: sobre el repo de la sesión que lo abrió, nunca el de la coordinadora ---------

const CON_PENDIENTES = { ...PERFIL, delegated_signing: [...PERFIL.delegated_signing, 'pending-approval'] };
/** Un repo de git de prueba, con su ruta real (la que devuelve git). */
function repoDePrueba(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pendiente-repo-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', d]);
  return fs.realpathSync(d);
}
/** La casa con la coordinadora designada, ses-a trabajando en `ajeno` y la coordinadora con su checkout `propio`. */
function casaConPendiente(t, o = {}) {
  const casa = casaConDesignada(t, o);
  const activos = path.join(casa, '.claude', '.tycon-pipeline', 'active');
  const ajeno = repoDePrueba(t);
  const propio = repoDePrueba(t);
  fs.writeFileSync(path.join(activos, 'ses-a.json'), JSON.stringify({ sessionId: 'ses-a', storyId: '9.99', storyPath: `${ajeno}/specs/story-9.99.md`, repoPath: ajeno }));
  return { casa, ajeno, propio };
}
const aprobarPendiente = (repo, extra = '') => `node ${MARKER} approve-pending --id DEF-nuevo --repo ${repo}${extra}`;
const pedirPendiente = (casa, cmd, cwd, delegacion = delegacionReal({ perfil: CON_PENDIENTES })) => pedir(casa, cmd, { evento: { ...DE_LA_COORD, cwd }, delegacion });

test('Pendiente_CoordinadoraDesignada_RepoDeOtraSesion_FirmaSinVentana (a)', (t) => {
  const { casa, ajeno, propio } = casaConPendiente(t);
  const cmd = aprobarPendiente(ajeno, ' --for-session ses-a');
  const r = pedirPendiente(casa, cmd, propio);
  assert.strictEqual(r.decision, 'allow', r.texto);
  assert.strictEqual(r.via, 'delegacion');
  const reg = registroVigente(casa);
  assert.strictEqual(reg.destino, 'ses-a');
  assert.strictEqual(reg.sesion, 'ses-coord');
  // el guion de la coordinadora firma con via: delegacion, y la constancia dice que fue ella por delegación
  const argv = [MARKER, 'approve-pending', '--id', 'DEF-nuevo', '--repo', ajeno, '--for-session', 'ses-a'];
  const e = ow.exigir({ firma: 'pending-approval', argv, pid: 301, arbol: arbolDelGuion(casa, cmd), casa, ahora: AHORA + 60000, propia: undefined });
  assert.strictEqual(e.codigo, 0, e.motivo);
  assert.strictEqual(e.via, 'delegacion');
  const q = ow.quienFirmo(e, 'el-dev');
  assert.match(q.quien, /^coordinadora/);
  assert.strictEqual(q.delegacion, 'el-dev');
  // también vale el arreglo rápido de la sesión: su carpeta es su repo
  const otra = casaConPendiente(t);
  const adhoc = path.join(otra.casa, '.claude', '.tycon-pipeline', 'adhoc');
  fs.mkdirSync(adhoc, { recursive: true });
  fs.writeFileSync(path.join(otra.casa, '.claude', '.tycon-pipeline', 'active', 'ses-a.json'), JSON.stringify({ sessionId: 'ses-a', storyId: '9.99' }));
  fs.writeFileSync(path.join(adhoc, 'ses-a.json'), JSON.stringify({ reason: 'x', maxFiles: 2, files: [], cwd: otra.ajeno }));
  assert.strictEqual(pedirPendiente(otra.casa, aprobarPendiente(otra.ajeno, ' --for-session ses-a'), otra.propio).decision, 'allow');
});

test('Pendiente_RepoDeLaCoordinadora_Ventana (b)', (t) => {
  const { casa, ajeno, propio } = casaConPendiente(t);
  // su checkout, aunque nombre otra sesión
  let r = pedirPendiente(casa, aprobarPendiente(propio, ' --for-session ses-a'), propio);
  assert.strictEqual(r.decision, 'ask', r.texto);
  assert.match(r.texto, /No se firmó por delegación: .*coordinadora/);
  // un worktree de su ejecución abierta, aunque sea también el de la otra sesión
  fs.writeFileSync(path.join(casa, '.claude', '.tycon-pipeline', 'active', 'ses-coord.json'), JSON.stringify({ sessionId: 'ses-coord', storyId: '7.77', repoPath: ajeno }));
  r = pedirPendiente(casa, aprobarPendiente(ajeno, ' --for-session ses-a'), propio);
  assert.strictEqual(r.decision, 'ask', r.texto);
  assert.match(r.texto, /No se firmó por delegación: .*coordinadora/);
  // su checkout escrito con otras mayúsculas, en un disco que no las distingue, sigue siendo suyo
  const otraForma = propio.replace(/pendiente-repo-/, 'PENDIENTE-REPO-');
  if (fs.existsSync(otraForma)) {
    const limpia = casaConPendiente(t);
    const mayus = limpia.propio.replace(/pendiente-repo-/, 'PENDIENTE-REPO-');
    r = pedirPendiente(limpia.casa, aprobarPendiente(mayus, ' --for-session ses-a'), limpia.propio);
    assert.strictEqual(r.decision, 'ask', r.texto);
  }
  // el arreglo rápido que la coordinadora pidió para la otra sesión guarda la carpeta de ella: no hace suyo ese repo
  const fabricado = casaConPendiente(t);
  const adhoc = path.join(fabricado.casa, '.claude', '.tycon-pipeline', 'adhoc');
  fs.mkdirSync(adhoc, { recursive: true });
  const trucho = repoDePrueba(t);
  fs.writeFileSync(path.join(adhoc, 'ses-a.json'), JSON.stringify({ reason: 'x', maxFiles: 2, files: [], cwd: trucho, via: 'delegacion', by: 'ses-coord' }));
  r = pedirPendiente(fabricado.casa, aprobarPendiente(trucho, ' --for-session ses-a'), fabricado.propio);
  assert.strictEqual(r.decision, 'ask', r.texto);
  // sin la carpeta del pedido no se sabe cuál es su checkout
  r = pedir(fabricado.casa, aprobarPendiente(fabricado.ajeno, ' --for-session ses-a'), { evento: DE_LA_COORD, delegacion: delegacionReal({ perfil: CON_PENDIENTES }) });
  assert.strictEqual(r.decision, 'ask', r.texto);
  // sin --for-session el destino es ella misma: ventana, con el motivo a la vista
  const sola = casaConPendiente(t);
  r = pedirPendiente(sola.casa, aprobarPendiente(sola.ajeno), sola.propio);
  assert.strictEqual(r.decision, 'ask', r.texto);
  assert.match(r.texto, /No se firmó por delegación: .*--for-session/);
});

test('Pendiente_ForSessionDeUnaSesionSinEseRepo_SeNiega (c)', (t) => {
  const { casa, ajeno, propio } = casaConPendiente(t);
  const lejos = repoDePrueba(t);
  fs.writeFileSync(path.join(casa, '.claude', '.tycon-pipeline', 'active', 'ses-b.json'), JSON.stringify({ sessionId: 'ses-b', storyId: '5.55', repoPath: lejos }));
  const r = pedirPendiente(casa, aprobarPendiente(ajeno, ' --for-session ses-b'), propio);
  assert.strictEqual(r.decision, 'ask', r.texto);
  assert.notStrictEqual(r.via, 'delegacion');
  assert.match(r.texto, /No se firmó por delegación: .*ses-b/);
  // una sesión sin marcador ni arreglo rápido, igual
  assert.strictEqual(pedirPendiente(casa, aprobarPendiente(ajeno, ' --for-session ses-z'), propio).decision, 'ask');
});

test('Pendiente_SesionNoDesignada_Ventana (d)', (t) => {
  const { casa, ajeno, propio } = casaConPendiente(t, { designada: 'ses-otra' });
  const r = pedirPendiente(casa, aprobarPendiente(ajeno, ' --for-session ses-a'), propio);
  assert.strictEqual(r.decision, 'ask', r.texto);
  assert.match(r.texto, /no es la designada/);
  // el pendiente de un dev sin coordinadora, en su propio repo: la ventana de siempre, sin ruido de la delegación
  const dev = casaConPendiente(t, { designada: 'ses-otra' });
  const propia = pedir(dev.casa, aprobarPendiente(dev.ajeno), { evento: { cwd: dev.ajeno }, delegacion: delegacionReal({ perfil: CON_PENDIENTES }) });
  assert.strictEqual(propia.decision, 'ask', propia.texto);
  assert.doesNotMatch(propia.texto, /No se firmó por delegación/);
});

/** Un worktree agregado (`git worktree add`) de un repo de prueba, con su carpeta `specs/`. */
function worktreeDePrueba(t) {
  const base = repoDePrueba(t);
  spawnSync('git', ['-C', base, '-c', 'user.name=prueba', '-c', 'user.email=prueba@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'base']);
  const d = `${base}-wt`;
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  spawnSync('git', ['-C', base, 'worktree', 'add', '-q', '-b', 'wt', d]);
  fs.mkdirSync(path.join(d, 'specs'));
  return fs.realpathSync(d);
}

test('Pendiente_RepoDeLaStoryDeOtraSesion_FirmaSinVentana (e): el worktree privado de su story también es suyo', (t) => {
  const { casa, ajeno, propio } = casaConPendiente(t);
  const privado = worktreeDePrueba(t);
  fs.writeFileSync(path.join(casa, '.claude', '.tycon-pipeline', 'active', 'ses-a.json'), JSON.stringify({ sessionId: 'ses-a', storyId: '9.99', storyPath: `${privado}/specs/story-9.99.md`, repoPath: ajeno }));
  const r = pedirPendiente(casa, aprobarPendiente(privado, ' --for-session ses-a'), propio);
  assert.strictEqual(r.decision, 'allow', r.texto);
  assert.strictEqual(r.via, 'delegacion');
  // la story en un clon principal no suma ese repo: lo comparten varias stories
  const clon = repoDePrueba(t);
  fs.mkdirSync(path.join(clon, 'specs'));
  fs.writeFileSync(path.join(casa, '.claude', '.tycon-pipeline', 'active', 'ses-a.json'), JSON.stringify({ sessionId: 'ses-a', storyId: '9.99', storyPath: `${clon}/specs/story-9.99.md`, repoPath: ajeno }));
  const c = pedirPendiente(casa, aprobarPendiente(clon, ' --for-session ses-a'), propio);
  assert.strictEqual(c.decision, 'ask', c.texto);
  assert.match(c.texto, /No se firmó por delegación: .*no es un repo donde trabaja la sesión ses-a/);
  // la carpeta de la story que todavía no existe, o una ruta relativa, no suman repo
  for (const storyPath of [`${privado}/no-existe/story-9.99.md`, 'specs/story-9.99.md']) {
    fs.writeFileSync(path.join(casa, '.claude', '.tycon-pipeline', 'active', 'ses-a.json'), JSON.stringify({ sessionId: 'ses-a', storyId: '9.99', storyPath, repoPath: ajeno }));
    const n = pedirPendiente(casa, aprobarPendiente(privado, ' --for-session ses-a'), propio);
    assert.strictEqual(n.decision, 'ask', `${storyPath}: ${n.texto}`);
  }
});

test('Pendiente_RepoDeLaStoryDeLaCoordinadora_Ventana (f): el repo de su story es de ella, aunque también sea el de otra', (t) => {
  const { casa, ajeno, propio } = casaConPendiente(t);
  const activos = path.join(casa, '.claude', '.tycon-pipeline', 'active');
  const privado = worktreeDePrueba(t);
  fs.writeFileSync(path.join(activos, 'ses-a.json'), JSON.stringify({ sessionId: 'ses-a', storyId: '9.99', storyPath: `${privado}/specs/story-9.99.md`, repoPath: ajeno }));
  fs.writeFileSync(path.join(activos, 'ses-coord.json'), JSON.stringify({ sessionId: 'ses-coord', storyId: '7.77', storyPath: `${privado}/specs/story-7.77.md`, repoPath: repoDePrueba(t) }));
  let r = pedirPendiente(casa, aprobarPendiente(privado, ' --for-session ses-a'), propio);
  assert.strictEqual(r.decision, 'ask', r.texto);
  assert.match(r.texto, /No se firmó por delegación: .*coordinadora/);
  // del lado de ella, un repo declarado que no se encuentra niega: no se abre por un dato que falta
  for (const suyo of [
    { storyPath: `${privado}/no-existe/story-7.77.md`, repoPath: repoDePrueba(t) },
    { storyPath: 'specs/story-7.77.md', repoPath: repoDePrueba(t) },
    { storyPath: `${repoDePrueba(t)}/story-7.77.md`, repoPath: path.join(os.tmpdir(), 'no-es-un-repo-de-git') },
  ]) {
    fs.writeFileSync(path.join(activos, 'ses-coord.json'), JSON.stringify({ sessionId: 'ses-coord', storyId: '7.77', ...suyo }));
    r = pedirPendiente(casa, aprobarPendiente(privado, ' --for-session ses-a'), propio);
    assert.strictEqual(r.decision, 'ask', `${JSON.stringify(suyo)}: ${r.texto}`);
    assert.match(r.texto, /No se firmó por delegación: .*no pude leer/);
  }
  // la story de la otra sesión vive en el checkout de la coordinadora: ese repo sigue siendo de ella
  const otra = casaConPendiente(t);
  fs.mkdirSync(path.join(otra.propio, 'specs'));
  fs.writeFileSync(path.join(otra.casa, '.claude', '.tycon-pipeline', 'active', 'ses-a.json'), JSON.stringify({ sessionId: 'ses-a', storyId: '9.99', storyPath: `${otra.propio}/specs/story-9.99.md`, repoPath: otra.ajeno }));
  r = pedirPendiente(otra.casa, aprobarPendiente(otra.propio, ' --for-session ses-a'), otra.propio);
  assert.strictEqual(r.decision, 'ask', r.texto);
  assert.match(r.texto, /No se firmó por delegación: .*coordinadora/);
});

test('Plan_ForSession_DesignacionDeOtraSesion_Ventana: la confirmación de una designación vieja no delega a la sesión nueva', (t) => {
  // la designada es otra sesión (la de hace días), confirmada: la coordinadora de hoy firma con ventana
  const casa = casaConDesignada(t, { designada: 'ses-coord-vieja' });
  const r = pedir(casa, PLAN, { evento: DE_LA_COORD, delegacion: delegacionReal() });
  assert.strictEqual(r.decision, 'ask', r.texto);
  assert.match(r.texto, /No se firmó por delegación: la sesión del pedido no es la designada/);
});

test('Pendiente_MarkerAcepta_ForSession: approve-pending se pide para otra sesión', (t) => {
  const d = repoDePrueba(t);
  fs.mkdirSync(path.join(d, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(d, 'tasks', 'todo.md'), '# Pendientes\n\n- [ ] [DEF-nuevo] algo\n');
  const casa = casaNueva(t);
  const env = { ...process.env, HOME: casa, CLAUDE_SESSION_ID: 'ses-coord', CLAUDE_CODE_SESSION_ID: 'ses-coord' };
  const r = spawnSync(process.execPath, [MARKER, 'approve-pending', '--id', 'DEF-nuevo', '--repo', d, '--for-session', 'ses-a'], { encoding: 'utf8', env, cwd: d });
  assert.doesNotMatch(r.stderr, /no es una firma que se pida para otra sesión/);
  // sin el «Sí» de la ventana, no aprueba ni escribe
  assert.notStrictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /no se aprobó DEF-nuevo/);
  assert.strictEqual(fs.existsSync(path.join(d, 'tasks', 'pending-approvals.jsonl')), false);
});

// --- el chequeo antes de la ventana -----------------------------------------------------------------------------------
//
// Una ventana que el guion rechaza después del «Sí» es una firma perdida: el freno corre antes el guion en modo de
// chequeo y, si se negaría, no la abre.

const EXTRA = GUIONES.find((g) => g[0] === 'extra-round');

// 🔴 Falla con: la ventana abierta (o su registro escrito) para un comando que el guion iba a rechazar.
test('Precheck_GuionQueSeNegaria_NoAbreLaVentana', (t) => {
  for (const [firma, cmd] of GUIONES.filter((g) => ow.CON_PRECHEQUEO.has(g[0]))) {
    const casa = casaNueva(t);
    let visto = null;
    const r = pedir(casa, cmd, { comprobar: (o) => { visto = o; return { niega: '🛑 falta la nota de la tercera vuelta' }; } });
    assert.strictEqual(r.decision, 'deny', `${cmd}: ${r.texto}`);
    assert.match(r.texto, /No abrí la ventana/);
    assert.match(r.texto, /falta la nota de la tercera vuelta/, 'dice lo que contestó el guion');
    assert.strictEqual(vigentes(casa).length, 0, `${cmd}: sin registro`);
    assert.strictEqual(visto.firma, firma);
    assert.strictEqual(visto.sesion, 'ses-a');
    assert.strictEqual(visto.casa, casa);
    assert.deepStrictEqual(visto.palabras, ow.canonica(cmd));
  }
});

// 🔴 Falla con: un chequeo que no contesta (o se cae) cerrando la ventana: ante la duda se abre como siempre.
test('Precheck_GuionEnRegla_SinRespuestaOCaido_AbreLaVentana', (t) => {
  for (const comprobar of [() => ({ ok: true }), () => null, () => { throw new Error('se cayó'); }]) {
    const casa = casaNueva(t);
    const r = pedir(casa, EXTRA[1], { comprobar });
    assert.strictEqual(r.decision, 'ask', r.texto);
    assert.strictEqual(vigentes(casa).length, 1);
  }
});

// 🔴 Falla con: el chequeo corrido para una firma sin chequeo o para la que ya delegó el perfil.
test('Precheck_SoloParaSusFirmasYSinDelegar', (t) => {
  let llamado = 0;
  const comprobar = () => { llamado++; return { niega: 'no' }; };
  for (const [firma, cmd] of GUIONES.filter((g) => !ow.CON_PRECHEQUEO.has(g[0]))) {
    const r = pedir(casaNueva(t), cmd, { comprobar });
    assert.strictEqual(r.decision, 'ask', `${firma}: ${r.texto}`);
  }
  const casa = casaConDesignada(t);
  const r = pedir(casa, PLAN, { evento: DE_LA_COORD, delegacion: delegacionReal(), comprobar });
  assert.strictEqual(r.decision, 'allow', r.texto);
  assert.strictEqual(llamado, 0);
});

// 🔴 Falla con: el guion en modo de chequeo que firma, gasta el pedido o no lo dice por la salida.
test('Precheck_ExigirEnModoDeChequeo_NoFirmaNiGasta', (t) => {
  const casa = casaNueva(t);
  assert.strictEqual(pedir(casa, PLAN, { evento: DE_LA_COORD }).decision, 'ask');
  let salida = '';
  let codigo = null;
  const base = { firma: 'plan-approval', argv: PLAN_ARGV, pid: 301, arbol: arbolDelGuion(casa, PLAN), casa, ahora: AHORA + 60000, propia: 'ses-coord',
    env: { [ow.PRECHEQUEO]: '1' }, escribir: (s) => { salida += s; }, salir: (c) => { codigo = c; } };
  const e = ow.exigir(base);
  assert.strictEqual(codigo, 0);
  assert.strictEqual(e.prechequeo, true);
  assert.ok(salida.split('\n').includes(ow.PRECHEQUEO_OK), salida);
  assert.strictEqual(vigentes(casa).length, 1, 'el pedido sigue sin gastar');
  assert.strictEqual(gates(casa).length, 0, 'sin renglón de firma');
  // lo que el guion comprueba antes de la firma corre también en el chequeo, y su negativa vuelve tal cual
  salida = '';
  codigo = null;
  let via = null;
  const n = ow.exigir({ ...base, antes: (v) => { via = v; return { codigo: 2, motivo: 'la corrida no está limpia' }; } });
  assert.deepStrictEqual([n.codigo, n.motivo, via, codigo, salida], [2, 'la corrida no está limpia', 'ventana', null, '']);
  assert.strictEqual(vigentes(casa).length, 1);
  // con --terminal, el chequeo no pregunta nada en la terminal
  const tty = { windows: false, hay: () => { throw new Error('preguntó'); }, preguntar: () => { throw new Error('preguntó'); } };
  ow.exigir({ ...base, argv: [...PLAN_ARGV, '--terminal'], tty, antes: (v) => { via = v; return null; } });
  assert.strictEqual(via, 'terminal');
  assert.strictEqual(codigo, 0);
  assert.strictEqual(gates(casa).length, 0);
});

// 🔴 Falla con: el chequeo de verdad que no corre el guion, o que lo deja escribir.
test('Precheck_ElGuionDeVerdad_NiegaSinCorridaYNoEscribe', (t) => {
  const casa = casaNueva(t);
  const rd = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-window-pre-'));
  t.after(() => fs.rmSync(rd, { recursive: true, force: true }));
  const estado = path.join(casa, '.claude', '.tycon-pipeline');
  const foto = () => fs.readdirSync(estado, { recursive: true }).sort();
  const antes = foto();
  for (const cmd of [`node ${MARKER} approve-save`, `node ${MARKER} complete-step approve-plan --approved "dale"`]) {
    const c = ow.comprobarConElGuion({ palabras: ow.canonica(cmd), cwd: rd, sesion: 'ses-sin-corrida', casa });
    assert.ok(c && c.niega, `${cmd}: ${JSON.stringify(c)}`);
    assert.match(c.niega, /ses-sin-corrida|ejecución|marker/i, cmd);
  }
  assert.deepStrictEqual(foto(), antes, 'las negativas no escribieron nada en la casa');
  // con la corrida abierta, el ok de guardar llega a la firma: el chequeo dice que sí, sin firmar ni escribir
  const git = (...a) => spawnSync('git', ['-C', rd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  fs.writeFileSync(path.join(rd, 'story.md'), '---\nstory: 9.99\n---\n');
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(estado, 'active', 'ses-ok.json'), JSON.stringify({ sessionId: 'ses-ok', storyId: '9.99', storyPath: path.join(rd, 'story.md'), repoPath: rd,
    startedAt: new Date(AHORA).toISOString() }));
  const antesDelOk = foto();
  const ok = ow.comprobarConElGuion({ palabras: ow.canonica(`node ${MARKER} approve-save`), cwd: rd, sesion: 'ses-ok', casa });
  assert.deepStrictEqual(ok, { ok: true });
  assert.deepStrictEqual(foto(), antesDelOk, 'el chequeo no escribió nada en la casa');
  assert.ok(!fs.readFileSync(path.join(estado, 'active', 'ses-ok.json'), 'utf8').includes('saveOk'), 'ni el ok en el marcador');
});

// 🔴 Falla con: aprobar el plan fuera de orden con la ventana abierta, o el chequeo que deja su renglón cuando pasa.
test('Precheck_AprobarElPlan_FueraDeOrdenNiegaYEnOrdenNoEscribe', (t) => {
  const casa = casaNueva(t);
  const rd = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-window-plan-'));
  t.after(() => fs.rmSync(rd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(rd, 'story.md'), '---\nstory: 9.99\n---\n\n## Acceptance Criteria\n- AC1: x\n');
  const estado = path.join(casa, '.claude', '.tycon-pipeline');
  const marcador = (pendientes) => fs.writeFileSync(path.join(estado, 'active', 'ses-p.json'), JSON.stringify({ sessionId: 'ses-p', storyId: '9.99',
    storyPath: path.join(rd, 'story.md'), repoPath: rd, startedAt: new Date(AHORA).toISOString(), stepScheme: 2, stepsCompleted: ['validate-story', 'plan'].filter((s) => !pendientes.includes(s)),
    stepsPending: [...pendientes, 'approve-plan', 'implement'] }));
  const palabras = ow.canonica(`node ${MARKER} complete-step approve-plan --approved "dale, seguí"`);
  const gatesLog = path.join(estado, 'gates.log');
  const renglones = () => { try { return fs.readFileSync(gatesLog, 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch (_) { return []; } };
  marcador(['plan']);
  const no = ow.comprobarConElGuion({ palabras, cwd: rd, sesion: 'ses-p', casa });
  assert.ok(no && no.niega, JSON.stringify(no));
  assert.match(no.niega, /pendiente/);
  assert.strictEqual(renglones().filter((g) => g.name === 'step-order' && g.status === 'blocked').length, 1, 'la negativa queda anotada una vez');
  // fuera de orden a conciencia: el chequeo pasa y el renglón del desvío lo deja el comando de verdad, no el chequeo
  const desvio = ow.comprobarConElGuion({ palabras: [...palabras, '--out-of-order'], cwd: rd, sesion: 'ses-p', casa });
  assert.deepStrictEqual(desvio, { ok: true });
  assert.ok(!fs.existsSync(path.join(estado, 'bypass.log')), 'el chequeo no anotó el desvío');
  marcador([]);
  const antes = fs.readFileSync(path.join(estado, 'active', 'ses-p.json'), 'utf8');
  const n = renglones().length;
  const si = ow.comprobarConElGuion({ palabras, cwd: rd, sesion: 'ses-p', casa });
  assert.deepStrictEqual(si, { ok: true });
  assert.strictEqual(renglones().length, n, 'el chequeo que pasa no anota nada');
  assert.strictEqual(fs.readFileSync(path.join(estado, 'active', 'ses-p.json'), 'utf8'), antes, 'ni aprueba el plan');
});
