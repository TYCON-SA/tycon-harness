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
const { spawnSync, execFileSync } = require('child_process');

const ow = require('../lib/owner-window.js');

// La coordinadora confirmada pide approvals.relay_session en el perfil del árbol del arnés, y el clon de
// trabajo no lo trae: la lista de firmas y el freno, en el proceso de la prueba, lo leen de una carpeta con ese perfil.
const CON_CLAVE = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-window-clave-'));
fs.writeFileSync(path.join(CON_CLAVE, 'team-profile.json'), JSON.stringify({ approvals: { relay_session: 'coordinadora' } }));
const OA = require('../lib/owner-approvals.js');
const confirmadaSinClave = OA.coordinadoraConfirmada;
OA.coordinadoraConfirmada = (casa, o = {}) => confirmadaSinClave(casa, { arnes: CON_CLAVE, ...o });

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

/**
 * La envoltura de una sesión que arrancó sin foto del ambiente (Mac, 2.1.312, medida el 3/11): `-c -l` en lugar del
 * `source` de la foto, y el bloque propio de la consola. La de bash es un supuesto no medido.
 */
function envolverSinFoto(cmd, { deFondo = false, bash = false, unalias = true } = {}) {
  return (bash ? '/bin/bash -c -l shopt -u extglob 2>/dev/null || true' : '/bin/zsh -c -l setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true')
    + (unalias ? " && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true" : '')
    + ` && eval '${cmd.replace(/'/g, `'"'"'`)}'${deFondo ? '' : ' < /dev/null'} && pwd -P >| /tmp/claude-9890-cwd`;
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
const pedir = (casa, cmd, o = {}) => ow.decidir({ evento: evento(cmd, o.evento), escapes: o.escapes || [], arbol: o.arbol || arbolDelFreno(), pid: 201, casa, ahora: o.ahora || AHORA, delegacion: o.delegacion || SIN_DELEGACION, clasificar: o.clasificar || (() => null), comprobar: o.comprobar || (() => null), aprobador: o.aprobador || DEL_ARNES, aprobaciones: o.aprobaciones, topes: o.topes });
const registros =(casa) => { try { return fs.readdirSync(ow.carpeta(casa)); } catch (_) { return []; } };
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
    // el de la excepción en vivo dice la razón declarada, no el texto del catálogo
    const que = firma === 'runtime-waiver' ? 'Aceptar sin prueba en vivo el AC 1, porque «el servicio externo no tiene ambiente de prueba»'
      : `${s.approves.charAt(0).toUpperCase()}${s.approves.slice(1)}`;
    assert.ok(r.texto.includes(`¿${que}?`), `${cmd}: el texto dice qué aprueba`);
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
    assert.match(r.texto, /AC 1: .*el criterio: Given un pedido Then el aviso queda en el servicio externo\./, cmd);
    assert.match(r.texto, /el servicio externo no tiene ambiente de prueba/);
    assert.match(r.texto, /T1/);
    assert.doesNotMatch(r.texto, /AC 2/);
  }
  // la historia con la ruta relativa al directorio del pedido
  const rel = pedir(casaNueva(t), `node ${MARKER} runtime-waiver specs/story-9.91-juguete.md --acs 1`, { evento: { cwd: repo } });
  assert.strictEqual(rel.decision, 'ask', rel.texto);
  assert.match(rel.texto, /AC 1: .*el criterio: Given un pedido/);
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

test('OwnerWindow_OwnerWaitDeFondo_NoFrena_YOtraCosaSi — el despertador de la coordinadora no le quita el click al dueño', (t) => {
  // 🔴 rojo: con owner-wait de fondo la firma va a la terminal, o pasa algo que no es exactamente owner-wait de este arnés
  const [, cmd] = GUIONES[0];
  const propio = path.join(RAIZ, 'scripts', 'tools', 'coordination.js');
  const fondo = (casa, linea) => ({ pid: 400, ppid: 100, inicio: INICIO, comando: envolver(casa, linea, { deFondo: true }) });
  const pide = (linea) => { const casa = casaNueva(t); return pedir(casa, cmd, { arbol: arbolDelFreno({ extra: [fondo(casa, linea)] }) }); };
  // como lo pide el aviso de coordination.js, con la ruta entre comillas, y sin comillas: pasa como si no hubiera consola
  for (const linea of [`node "${propio}" owner-wait`, `node ${propio} owner-wait`, `/usr/local/bin/node "${propio}" owner-wait`]) {
    assert.strictEqual(pide(linea).decision, 'ask', linea);
  }
  // cualquier otra cosa sigue frenando
  const otro = fs.mkdtempSync(path.join(os.tmpdir(), 'otro-arnes-'));
  t.after(() => fs.rmSync(otro, { recursive: true, force: true }));
  fs.mkdirSync(path.join(otro, 'scripts', 'tools'), { recursive: true });
  const copia = path.join(otro, 'scripts', 'tools', 'coordination.js');
  fs.copyFileSync(propio, copia);
  for (const linea of [
    `node "${propio}" owner-wait; sleep 600`, // algo más en la línea
    `node "${propio}" owner-wait && sleep 600`,
    `node "${propio}" owner-wait --x`, // otra palabra
    `node "${propio}" status`, // otro subcomando
    `node "${copia}" owner-wait`, // la misma herramienta de otra copia
    `bash "${propio}" owner-wait`, // no la corre node
    `node "$(echo ${propio})" owner-wait`, // armada
    `node "${propio}" owner-wait > /tmp/x`, // con redirección
  ]) {
    const r = pide(linea);
    assert.strictEqual(r.decision, 'deny', linea);
    assert.match(r.texto, /cerrá los procesos de fondo o firmá desde tu terminal/, linea);
  }
  // owner-wait y otra consola de fondo: la otra frena
  const casa = casaNueva(t);
  const r = pedir(casa, cmd, { arbol: arbolDelFreno({ extra: [fondo(casa, `node "${propio}" owner-wait`), { ...fondo(casa, 'sleep 600'), pid: 401 }] }) });
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.texto, /cerrá los procesos de fondo o firmá desde tu terminal/);
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
    assert.ok(r.texto.includes(`¿${s.approves.charAt(0).toUpperCase()}${s.approves.slice(1)}?`), cmd);
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
// la coordinadora firma por el dueño sólo con approvals.relay_session en el perfil
const PERFIL = { relay_session: 'coordinadora', delegated_signing: ['plan-approval', 'extra-round', 'refresh-after-main'], owner_only: ['control-change'], delegated_machines: [{ id: HUELLA, label: 'Mac de prueba' }] };
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
    // la delegación pide también la clave de la coordinadora
    fs.writeFileSync(path.join(arnes, 'team-profile.json'), JSON.stringify({ approvals: { relay_session: 'coordinadora', ...approvals } }));
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
    ow.decidir({ evento: evento(cmd, { session_id: sesion }), arbol: arbolDelFreno(), pid: 201, casa, ahora, comprobar: () => null });
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

test('OwnerWindow_SinFoto_SeDesenvuelveTalCual', (t) => {
  const casa = casaNueva(t);
  for (const cmd of ['x', `echo 'a' "b"`, GUIONES[0][1]]) {
    assert.strictEqual(ow.desenvolver(envolver(casa, cmd), casa), cmd, `con foto: ${cmd}`);
    assert.strictEqual(ow.desenvolver(envolverSinFoto(cmd), casa), cmd, `sin foto: ${cmd}`);
  }
  // la línea tal cual se midió, con la consola de bash (supuesto), de fondo y sin el bloque de unalias
  const medida = String.raw`/bin/zsh -c -l setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \builtin unalias -- 'unsetenv'; \builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval 'sh /tmp/linea.sh' < /dev/null && pwd -P >| /tmp/claude-9890-cwd`;
  assert.strictEqual(ow.desenvolver(medida, casa), 'sh /tmp/linea.sh');
  assert.strictEqual(ow.desenvolver(envolverSinFoto(`echo 'a'`, { deFondo: true }), casa), `echo 'a'`);
  assert.strictEqual(ow.desenvolver(envolverSinFoto('x', { unalias: false }), casa), 'x');
  assert.strictEqual(ow.desenvolver(envolverSinFoto(`echo 'a'`, { bash: true }), casa), `echo 'a'`);
  assert.strictEqual(ow.desenvolver(envolverSinFoto('x', { bash: true }).replace('/bin/bash', '/opt/homebrew/bin/bash'), casa), 'x');
});

test('OwnerWindow_SinFoto_InyectadoSeRechaza', (t) => {
  const casa = casaNueva(t);
  const L = envolverSinFoto('x');
  const noVale = {
    'antes del bloque propio': L.replace('-c -l ', '-c -l echo y && '),
    'entre bloques': L.replace(' && { \\builtin', ' && echo y && { \\builtin'),
    'después del eval': L.replace("eval 'x'", "eval 'x' ; 'y'"),
    'después del eval, con &&': L.replace("eval 'x'", "eval 'x' && echo y"),
    'después de pwd': `${L} ; echo y`,
    'salto de línea antes del eval': L.replace(' && eval', '\n&& eval'),
    'salto de línea al final': `${L}\n`,
    'salto de línea después de -l': L.replace('-c -l ', '-c -l\n'),
    'retorno de carro al final': `${L}\r`,
    'comilla suelta en el eval': L.replace("eval 'x'", "eval 'a'b'"),
    'la cola embebida en el eval': L.replace("eval 'x'", "eval 'a' && pwd -P >| /tmp/claude-1-cwd'"),
    'la cola en otra carpeta': L.replace('/tmp/claude-9890-cwd', '/tmp/x/claude-1-cwd'),
    'la cola sin hexadecimal': L.replace('/tmp/claude-9890-cwd', '/tmp/claude-ZZ-cwd'),
  };
  // lo mismo con la consola de bash y sin el bloque de unalias
  const B = envolverSinFoto('x', { bash: true });
  const S = envolverSinFoto('x', { unalias: false });
  Object.assign(noVale, {
    'bash: antes del bloque propio': B.replace('-c -l ', '-c -l echo y && '),
    'bash: entre bloques': B.replace(' && { \\builtin', ' && echo y && { \\builtin'),
    'bash: después del eval': B.replace("eval 'x'", "eval 'x' && echo y"),
    'sin unalias: antes del bloque propio': S.replace('-c -l ', '-c -l echo y && '),
    'sin unalias: entre el bloque propio y el eval': S.replace(' && eval', ' && echo y && eval'),
    'sin unalias: después de pwd': `${S} ; echo y`,
  });
  for (const [que, linea] of Object.entries(noVale)) assert.strictEqual(ow.desenvolver(linea, casa), null, que);
});

test('OwnerWindow_SinFoto_OtraBanderaSeRechaza', (t) => {
  const casa = casaNueva(t);
  const L = envolverSinFoto('x');
  const noVale = {
    '-l con la foto': L.replace('-c -l ', `-c -l source ${casa}/.claude/shell-snapshots/snapshot-zsh-1-a.sh 2>/dev/null || true && `),
    '-c -l -l': L.replace('-c -l ', '-c -l -l '),
    '-cl': L.replace('-c -l ', '-cl '),
    '-lc': L.replace('-c -l ', '-lc '),
    '-l -c': L.replace('-c -l ', '-l -c '),
    '-c -lx': L.replace('-c -l ', '-c -lx '),
    '-c -i': L.replace('-c -l ', '-c -i '),
    '-c -x': L.replace('-c -l ', '-c -x '),
    'sin el bloque propio': L.replace('setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && ', ''),
    'la más corta': "/bin/zsh -c -l eval 'x' && pwd -P >| /tmp/claude-1-cwd",
    'zsh con shopt': envolverSinFoto('x', { bash: true }).replace('/bin/bash', '/bin/zsh'),
    'bash con setopt': L.replace('/bin/zsh', '/bin/bash'),
  };
  for (const [que, linea] of Object.entries(noVale)) assert.strictEqual(ow.desenvolver(linea, casa), null, que);
});

test('OwnerWindow_SinFoto_ElGuionFirmaSiElPadreEsLaHerramienta', (t) => {
  const [firma, cmd, argv] = GUIONES[0];
  let casa = casaNueva(t);
  assert.strictEqual(pedir(casa, cmd).decision, 'ask');
  const v = ow.verificar({ firma, argv, pid: 301, arbol: arbolDelGuion(casa, cmd, { consola: envolverSinFoto(cmd) }), casa, ahora: AHORA + 60000 });
  assert.ok(v.ok, v.motivo);
  assert.strictEqual(vigentes(casa).length, 0, 'el registro quedó consumido');
  // la misma línea, lanzada a mano por la consola de un agente o por un proceso cualquiera
  const padres = {
    'la consola de un agente': { pid: 250, ppid: 100, inicio: INICIO, comando: envolver(casa, `/bin/zsh -c -l 'x'`) },
    'un proceso cualquiera': { pid: 250, ppid: 1, inicio: INICIO, comando: 'python3 /tmp/lanza.py' },
  };
  for (const [que, padre] of Object.entries(padres)) {
    casa = casaNueva(t);
    pedir(casa, cmd);
    const r = ow.verificar({ firma, argv, pid: 301, arbol: arbolDelGuion(casa, cmd, { consola: envolverSinFoto(cmd), padre: 250, extra: [padre] }), casa, ahora: AHORA + 60000 });
    assert.strictEqual(r.ok, false, que);
    assert.match(r.motivo, /la consola no es de la herramienta/, que);
    assert.strictEqual(vigentes(casa).length, 1, `${que}: nada lo consumió`);
  }
});

test('OwnerWindow_SinFoto_LasNegacionesLaVen', (t) => {
  const [, cmd] = GUIONES[0];
  // una consola sin foto por arriba de la herramienta
  let casa = casaNueva(t);
  let r = pedir(casa, cmd, { arbol: arbolDelFreno({ tool: { ...herramienta(), ppid: 90 }, extra: [{ pid: 90, ppid: 1, inicio: INICIO, comando: envolverSinFoto('claude') }] }) });
  assert.strictEqual(r.decision, 'deny', r.texto);
  assert.match(r.texto, /la lanzó otra herramienta o su consola/);
  // una consola sin foto viva de fondo
  casa = casaNueva(t);
  r = pedir(casa, cmd, { arbol: arbolDelFreno({ extra: [{ pid: 400, ppid: 100, inicio: INICIO, comando: envolverSinFoto('sleep 600', { deFondo: true }) }] }) });
  assert.strictEqual(r.decision, 'deny', r.texto);
  assert.match(r.texto, /cerrá los procesos de fondo o firmá desde tu terminal/);
  // sin consolas de fondo, la sesión sin foto pide la ventana como cualquiera
  casa = casaNueva(t);
  assert.strictEqual(pedir(casa, cmd).decision, 'ask');
});

test('OwnerWindow_SinFoto_WindowsIgual', (t) => {
  const casa = casaNueva(t);
  assert.strictEqual(ow.desenvolverWindows(envolverSinFoto('x'), casa), null);
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
  for (const via of ['click', 'mensaje']) {
    const q = ow.quienFirmo({ via }, 'el dev');
    assert.strictEqual(cw.constanciaInvalida({ rule_id: 'X-C1', ts: 't', ...q, via: `waive-critical (${q.via})` }), null, `la exención aprobada por ${via} vale`);
  }
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
/** El plan escrito de la corrida, con lo que la pregunta de su firma muestra (signature-sources.js). */
function planEscrito(repo, storyId, story) {
  const dir = require(PIPELINE).resolveRunDir(repo, storyId, true, story);
  fs.writeFileSync(path.join(dir, 'step-02-bmad-plan.md'), '# Plan\n\n## Qué hace\n\nUna línea.\n\n## Archivos\n\n- a.js\n');
}

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
  planEscrito(repo, '9.97', story);
  const pasos =['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'adversarial-pass', 'findings', 'live-check', 'prepare-commit'];
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
    // con la dirección de la app: lo que prepare comprueba va antes de la firma
    ['browser-test', process.execPath, [E2E, 'prepare', '--repo', repo, '--story', story, '--url', 'http://localhost:4173', '--terminal', '--for-session', 'ses-w']],
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

// Una pestaña que no pide permisos (bypass y parecidos) aprueba sola lo que el freno manda a la ventana. Lo que afloja
// un control se niega ahí con el comando de la terminal; lo de rutina (un pendiente, el ok de guardar, el plan, un
// arreglo rápido dentro de su tope) se hace y queda en el registro como «hecho y avisado». En una pestaña que pregunta,
// la ventana de siempre; la delegación no usa ventana y sigue valiendo.
// 🔴 mutación: sin mirar el modo de permisos → en bypass sale 'ask' y la ventana se aprueba sola.
test('Freno_PestanaSinPermisos_NiegaLoQueAfloja_ConElComandoDeLaTerminal', (t) => {
  for (const modo of ['bypassPermissions', 'dontAsk', 'auto', 'un-modo-nuevo']) {
    const casa = casaNueva(t);
    const cmd = `node ${MARKER} clear-session ses-a --lost`;
    const r = pedir(casa, cmd, { evento: { ...DE_LA_COORD, permission_mode: modo } });
    assert.strictEqual(r.decision, 'deny', `${modo}: ${r.texto}`);
    assert.match(r.texto, /no pide permisos/, modo);
    assert.match(r.texto, /--terminal/, `${modo}: el comando de la terminal`);
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

// Lo de rutina en una pestaña sin permisos: se hace y queda «hecho y avisado». El guion pasa por los mismos controles
// que la delegación (el guardado sensible, el plan sin revisión aprobada y el cupo delegado siguen afuera).
// 🔴 rojo con el código de antes: en bypass las cuatro se negaban y había que firmarlas en la terminal.
test('Freno_PestanaSinPermisos_RutinaHechaYAvisada', (t) => {
  const RUTINA = [
    ['save', SAVE, SAVE_ARGV],
    ['pending-approval', `node ${MARKER} approve-pending --id DEF-nuevo --repo /r --for-session ses-a`, [MARKER, 'approve-pending', '--id', 'DEF-nuevo', '--repo', '/r', '--for-session', 'ses-a']],
    ['plan-approval', `node ${MARKER} complete-step approve-plan --approved "dale" --for-session ses-a`, [MARKER, 'complete-step', 'approve-plan', '--approved', 'dale', '--for-session', 'ses-a']],
    ['adhoc-lane', `node ${MARKER} adhoc set '{"reason":"arreglo del sp","allowedFiles":["src/sp.js"],"maxFiles":3}' --for-session ses-a`, [MARKER, 'adhoc', 'set', '{"reason":"arreglo del sp","allowedFiles":["src/sp.js"],"maxFiles":3}', '--for-session', 'ses-a']],
  ];
  for (const [firma, cmd, argv] of RUTINA) {
    const casa = casaNueva(t);
    const r = pedir(casa, cmd, { evento: { ...DE_LA_COORD, permission_mode: 'bypassPermissions' } });
    assert.strictEqual(r.decision, 'allow', `${firma}: ${r.texto}`);
    assert.strictEqual(r.via, 'avisado', firma);
    assert.match(r.texto, /hecho y avisado/, firma);
    assert.strictEqual(vigentes(casa).length, 1, `${firma}: deja el registro que consume el guion`);
    // el guion firma con la vía nueva, y lo que comprueba antes lo comprueba como la delegación
    let viaDeAntes = null;
    const avisos = [];
    const e = ow.exigir({ firma, argv, pid: 301, arbol: arbolDelGuion(casa, cmd), casa, ahora: AHORA + 60000, propia: 'ses-coord',
      antes: (via) => { viaDeAntes = via; return null; }, notificar: (texto) => avisos.push(texto) });
    assert.strictEqual(e.codigo, 0, `${firma}: ${e.motivo}`);
    assert.strictEqual(e.via, 'avisado', firma);
    assert.strictEqual(viaDeAntes, 'delegacion', `${firma}: los controles de la delegación`);
    // el ok de guardar y el arreglo rápido avisan desde su propio guion (los controles de la delegación); el resto, acá
    assert.strictEqual(avisos.length, ['save', 'adhoc-lane'].includes(firma) ? 0 : 1, `${firma}: avisa una vez`);
    const firmada = gates(casa).find((g) => g.name === `${firma}-signed`);
    assert.strictEqual(firmada && firmada.via, 'avisado', firma);
    const q = ow.quienFirmo(e, 'el-dev');
    assert.strictEqual(q.via, 'hecho y avisado', firma);
    // un control de la delegación que niega vuelve como negado, sin gastar el pedido
    const casa2 = casaNueva(t);
    pedir(casa2, cmd, { evento: { ...DE_LA_COORD, permission_mode: 'bypassPermissions' } });
    const n = ow.exigir({ firma, argv, pid: 301, arbol: arbolDelGuion(casa2, cmd), casa: casa2, ahora: AHORA + 60000, propia: 'ses-coord',
      antes: () => ({ codigo: 2, motivo: 'toca algo sensible' }), notificar: () => {} });
    assert.strictEqual(n.codigo, 2, firma);
    assert.strictEqual(vigentes(casa2).length, 1, `${firma}: el pedido sigue sin gastar`);
  }
  // subir el tope de un arreglo rápido que ya existe sigue siendo una firma
  const casa = casaNueva(t);
  const adhoc = path.join(casa, '.claude', '.tycon-pipeline', 'adhoc');
  fs.mkdirSync(adhoc, { recursive: true });
  fs.writeFileSync(path.join(adhoc, 'ses-a.json'), JSON.stringify({ reason: 'arreglo del sp', maxFiles: 3, files: [] }));
  const sube = pedir(casa, `node ${MARKER} adhoc set '{"reason":"arreglo del sp","allowedFiles":["src/sp.js"],"maxFiles":7}' --for-session ses-a`, { evento: { ...DE_LA_COORD, permission_mode: 'bypassPermissions' } });
  assert.strictEqual(sube.decision, 'deny', sube.texto);
  assert.match(sube.texto, /subir el tope/);
  const igual = pedir(casa, `node ${MARKER} adhoc set '{"reason":"arreglo del sp","allowedFiles":["src/sp.js"],"maxFiles":3}' --for-session ses-a`, { evento: { ...DE_LA_COORD, permission_mode: 'bypassPermissions' } });
  assert.strictEqual(igual.decision, 'allow', igual.texto);
  // y un escape que viaja con la firma de rutina no se hace sin firma
  const conEscape = pedir(casaNueva(t), SAVE, { evento: { ...DE_LA_COORD, permission_mode: 'bypassPermissions' }, escapes: ['escape:TYCON_STATUS_GATE'] });
  assert.notStrictEqual(conEscape.decision, 'allow', conEscape.texto);
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

const ADHOC = `node ${MARKER} adhoc set '{"reason":"arreglo del sp","allowedFiles":["src/sp.js"],"maxFiles":3}'`;
const ADHOC_PARA_A = `node ${MARKER} adhoc set '{"reason":"arreglo del sp","allowedFiles":["src/sp.js"],"maxFiles":4}' --for-session ses-a`;
const ADHOC_PARA_A_ARGV = [MARKER, 'adhoc', 'set', '{"reason":"arreglo del sp","allowedFiles":["src/sp.js"],"maxFiles":4}', '--for-session', 'ses-a'];

// 8.141 T8 OwnerWindow_AdhocSet_PideLaVentana @story-8.141 @ac-3 @ac-4
// 🔴 Falla con: `adhoc set` sin pedir la ventana, la ventana sin el motivo o el cupo, `get`/`clear` pidiendo firma, o
// una forma escondida (`cd … &&`, el subcomando en una variable) que no se niega.
test('8.141 T8 OwnerWindow_AdhocSet_PideLaVentana', (t) => {
  const casa = casaNueva(t);
  const r = pedir(casa, ADHOC);
  assert.strictEqual(r.decision, 'ask', r.texto);
  assert.deepStrictEqual(r.firmas, ['adhoc-lane']);
  assert.match(r.texto, /Firma del dueño: ¿Abrir el arreglo rápido de una sesión, sin historia\? Historia 9\.99 \(sin título en su archivo\), sesión ses-a\./);
  assert.match(r.texto, /Qué hace: Abre un arreglo rápido sin historia, con hasta 3 archivos de implementación.*Cita de la sesión: «arreglo del sp»/);
  for (const sub of ['adhoc get', 'adhoc clear', 'adhoc clear-orphan ses-b']) {
    assert.strictEqual(pedir(casaNueva(t), `node ${MARKER} ${sub}`).decision, 'none', sub);
  }
  const conCd = pedir(casaNueva(t), `cd /r && ${ADHOC}`);
  assert.strictEqual(conCd.decision, 'deny');
  assert.match(conCd.texto, /forma exacta/);
  const codex = casaNueva(t);
  const c = pedir(codex, ADHOC, { evento: { turn_id: 'turn-1' } });
  assert.strictEqual(c.decision, 'deny');
  assert.match(c.texto, /en tu terminal: marker\.js adhoc set --reason "<motivo>" \[--max-files N\] --data sin-cambio --file <ruta> --terminal --for-session <id>/);
  assert.strictEqual(registros(codex).length, 0);
  // el subcomando en una variable cuenta como el arreglo que pasa el tope, y la forma lo niega
  const opaca = pedir(casaNueva(t), `S=set; node ${MARKER} adhoc "$S" '{"reason":"arreglo del sp","allowedFiles":["src/sp.js"]}'`);
  assert.deepStrictEqual(opaca.firmas, ['adhoc-lane:sobre-cupo']);
  assert.strictEqual(opaca.decision, 'deny');
  // con el «Sí», el guion firma; sin pedido de la ventana, no
  const v = ow.exigir({ firma: 'adhoc-lane', argv: [MARKER, 'adhoc', 'set', '{"reason":"arreglo del sp","allowedFiles":["src/sp.js"],"maxFiles":3}'], pid: 301, arbol: arbolDelGuion(casa, ADHOC), casa, ahora: AHORA + 60000, propia: 'ses-a' });
  assert.strictEqual(v.codigo, 0, v.motivo);
  assert.strictEqual(v.via, 'ventana');
  const sin = casaNueva(t);
  assert.strictEqual(ow.exigir({ firma: 'adhoc-lane', argv: [MARKER, 'adhoc', 'set', '{"reason":"arreglo del sp","allowedFiles":["src/sp.js"]}'], pid: 301, arbol: arbolDelGuion(sin, ADHOC), casa: sin, ahora: AHORA + 60000, propia: 'ses-a' }).codigo, 1);
});

// El chequeo previo de `adhoc set`: el motivo de más de 200 caracteres y un tope menor que los archivos ya tocados se
// niegan antes de la ventana (o de la terminal), con el guion de verdad en modo de chequeo.
// 🔴 rojo con el código de antes: `adhoc-lane` no tenía chequeo previo, la ventana se abría y el «Sí» se perdía; y el
// tope menor que lo tocado ni siquiera lo frenaba el guion.
test('OwnerWindow_AdhocSet_ChequeoPrevio_MotivoLargoYTopeMenorQueLoTocado', (t) => {
  assert.ok(ow.CON_PRECHEQUEO.has('adhoc-lane'), 'adhoc-lane pasa por el chequeo previo');
  const casa = casaNueva(t);
  const largo = 'x'.repeat(201);
  const motivoLargo = ow.comprobarConElGuion({ firma: 'adhoc-lane', palabras: [MARKER, 'adhoc', 'set', JSON.stringify({ reason: largo })], cwd: casa, sesion: 'ses-a', casa });
  assert.ok(motivoLargo && motivoLargo.niega, JSON.stringify(motivoLargo));
  assert.match(motivoLargo.niega, /hasta 200 caracteres/);
  const adhoc = path.join(casa, '.claude', '.tycon-pipeline', 'adhoc');
  fs.mkdirSync(adhoc, { recursive: true });
  execFileSync('git', ['init', '-q', casa]);
  const tocados = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => { const f = path.join(casa, 'src', `${n}.js`); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x\n'); return f; });
  fs.writeFileSync(path.join(adhoc, 'ses-a.json'), JSON.stringify({ reason: 'arreglo del sp', maxFiles: 8, files: tocados }));
  const menor = ow.comprobarConElGuion({ firma: 'adhoc-lane', palabras: [MARKER, 'adhoc', 'set', JSON.stringify({ reason: 'arreglo del sp', allowedFiles: ['src/a.js'], maxFiles: 5 })], cwd: casa, sesion: 'ses-a', casa });
  assert.ok(menor && menor.niega, JSON.stringify(menor));
  assert.match(menor.niega, /ya tocó 6 archivos/);
  // el mismo pedido con un tope que alcanza llega a la firma
  const alcanza = ow.comprobarConElGuion({ firma: 'adhoc-lane', palabras: [MARKER, 'adhoc', 'set', JSON.stringify({ reason: 'arreglo del sp', allowedFiles: ['src/a.js'], maxFiles: 6 })], cwd: casa, sesion: 'ses-a', casa });
  assert.deepStrictEqual(alcanza, { ok: true });
  // y el freno, con ese chequeo, no abre la ventana
  const r = pedir(casa, `node ${MARKER} adhoc set '{"reason":"arreglo del sp","allowedFiles":["src/sp.js"],"maxFiles":5}'`, { comprobar: (o) => ow.comprobarConElGuion({ ...o, casa }) });
  assert.strictEqual(r.decision, 'deny', r.texto);
  assert.match(r.texto, /No abrí la ventana/);
  assert.strictEqual(vigentes(casa).length, 0);
});

// 8.141 T8b OwnerWindow_AdhocSet_MotivoConFlags_PideLaVentana @story-8.141 @ac-4 @ac-6
// Prueba que confirmó el pase adversarial (false-positive-edge-1): el freno miraba el texto entero del comando, y un
// motivo que nombra un flag o una variable de sesión negaba la ventana y la delegación.
// 🔴 Falla con: un motivo legítimo que nombra `--ok`, `--quote`, `--relayed-by` o CLAUDE_CODE_SESSION_ID negado; o esas
// formas como argumento de verdad (fuera del motivo) que dejan de negarse.
test('8.141 T8b OwnerWindow_AdhocSet_MotivoConFlags_PideLaVentana', (t) => {
  for (const motivo of ['el flag --ok del CLI no anda', 'el parser de --quote rompe con tildes', 'falta --relayed-by en la ayuda', 'on-prompt lee mal CLAUDE_CODE_SESSION_ID']) {
    const cmd = `node ${MARKER} adhoc set '${JSON.stringify({ reason: motivo, allowedFiles: ['src/sp.js'] })}'`;
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
  const r = pedir(casa, `node ${MARKER} adhoc set '{"reason":"arreglo del sp","allowedFiles":["src/sp.js"]}' --for-session ses-coord`,
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
  assert.match(r.texto, /Historia 9\.99 \(sin título en su archivo\), sesión ses-a\./, `${cmd}: la story y la sesión que se cierran`);
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
  assert.match(r.texto, /^Lo aprobás vos: ¿Abrir el arreglo rápido de una sesión, sin historia\? Historia 9\.99 \(sin título en su archivo\), sesión ses-a\./);
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

test('Pendiente_WorktreeDeLaStoryDeLaCoordinadora_FirmaSinVentana (f): un worktree agregado nunca es de la coordinadora; sólo su checkout', (t) => {
  const { casa, ajeno, propio } = casaConPendiente(t);
  const activos = path.join(casa, '.claude', '.tycon-pipeline', 'active');
  const privado = worktreeDePrueba(t);
  fs.writeFileSync(path.join(activos, 'ses-a.json'), JSON.stringify({ sessionId: 'ses-a', storyId: '9.99', storyPath: `${privado}/specs/story-9.99.md`, repoPath: ajeno }));
  fs.writeFileSync(path.join(activos, 'ses-coord.json'), JSON.stringify({ sessionId: 'ses-coord', storyId: '7.77', storyPath: `${privado}/specs/story-7.77.md`, repoPath: repoDePrueba(t) }));
  // el rojo: antes, el worktree de la story de ella la hacía dueña de ese repo y el pendiente iba al dueño
  let r = pedirPendiente(casa, aprobarPendiente(privado, ' --for-session ses-a'), propio);
  assert.strictEqual(r.decision, 'allow', r.texto);
  assert.strictEqual(r.via, 'delegacion');
  // la firma pedida parada en el worktree (`cd <worktree> && …`) tampoco lo hace suyo
  r = pedirPendiente(casa, aprobarPendiente(privado, ' --for-session ses-a'), privado);
  assert.strictEqual(r.decision, 'allow', r.texto);
  // con un dato de ella que no se lee, un worktree agregado igual no es suyo
  for (const suyo of [
    { storyPath: `${privado}/no-existe/story-7.77.md`, repoPath: repoDePrueba(t) },
    { storyPath: 'specs/story-7.77.md', repoPath: repoDePrueba(t) },
  ]) {
    fs.writeFileSync(path.join(activos, 'ses-coord.json'), JSON.stringify({ sessionId: 'ses-coord', storyId: '7.77', ...suyo }));
    r = pedirPendiente(casa, aprobarPendiente(privado, ' --for-session ses-a'), propio);
    assert.strictEqual(r.decision, 'allow', `${JSON.stringify(suyo)}: ${r.texto}`);
  }
  // un clon principal sí se mira entero: un dato de ella que no se lee niega
  const clonDeA = repoDePrueba(t);
  fs.mkdirSync(path.join(clonDeA, 'specs'));
  fs.writeFileSync(path.join(activos, 'ses-a.json'), JSON.stringify({ sessionId: 'ses-a', storyId: '9.99', repoPath: clonDeA }));
  fs.writeFileSync(path.join(activos, 'ses-coord.json'), JSON.stringify({ sessionId: 'ses-coord', storyId: '7.77', storyPath: `${repoDePrueba(t)}/story-7.77.md`, repoPath: path.join(os.tmpdir(), 'no-es-un-repo-de-git') }));
  r = pedirPendiente(casa, aprobarPendiente(clonDeA, ' --for-session ses-a'), propio);
  assert.strictEqual(r.decision, 'ask', r.texto);
  assert.match(r.texto, /No se firmó por delegación: .*no pude leer/);
  fs.writeFileSync(path.join(activos, 'ses-a.json'), JSON.stringify({ sessionId: 'ses-a', storyId: '9.99', storyPath: `${privado}/specs/story-9.99.md`, repoPath: ajeno }));
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
  assert.strictEqual(fs.existsSync(path.join(d, 'tasks', 'pending-approvals')), false, 'ni la carpeta de un archivo por aprobación');
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
  // (el arreglo rápido tiene chequeo previo desde que el motivo largo y el tope menor se niegan antes de la ventana)
  for (const cmd of [SIGN_FILE('dod_runtime_exempt', '/r/specs/story-9.99.md')]) {
    const r = pedir(casaNueva(t), cmd, { comprobar });
    assert.strictEqual(r.decision, 'ask', `${cmd}: ${r.texto}`);
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
  planEscrito(rd, '9.99', path.join(rd, 'story.md'));
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

// Las otras firmas de guion con requisitos propios pasan por el mismo chequeo. Quedan sin chequeo el carril, que no
// tiene requisitos antes de la firma, y las cuatro firmas sobre un archivo.
const CON_REQUISITOS = ['plan-approval', 'extra-round', 'save', 'control-change', 'refresh-after-main', 'critical-waiver', 'runtime-waiver',
  'manual-test', 'browser-test', 'lost-run', 'adversarial-skip', 'pending-approval', 'escape:force-manual', 'escape:trust-ran', 'adhoc-lane', 'adhoc-lane:sobre-cupo',
  'designation-set', 'designation-withdraw', 'adhoc-lane:datos', 'adhoc-lane:guardado-ajeno'];

// 🔴 Falla con: una firma de guion con requisitos que abre la ventana sin preguntarle antes al guion.
test('Precheck_LasFirmasConRequisitos_NoAbrenLaVentanaSiElGuionSeNiega', (t) => {
  assert.deepStrictEqual([...ow.CON_PRECHEQUEO].sort(), [...CON_REQUISITOS].sort());
  const otras = [
    ['adversarial-skip', `node ${MARKER} sign-adversarial-skip --story /r/specs/story-9.99.md --reason "sin código"`],
    ['pending-approval', `node ${MARKER} approve-pending --id DEF-nuevo --repo /r`],
    ['escape:force-manual', `node ${MARKER} set-check dod green --force-manual`],
    ['escape:trust-ran', `node ${PIPELINE} check-count --repo /r --story /r/specs/story-9.99.md --trust-ran --ran a`],
    ['adhoc-lane', ADHOC],
    // nombrar y retirar a la coordinadora: el chequeo corre antes de dar el cuadro de sólo click
    ['designation-set', `node ${MARKER} designate-relay`],
    ['designation-withdraw', `node ${MARKER} withdraw-relay`],
    // dejar pasar el freno de los datos: también antes de dar el cuadro
    ['adhoc-lane:datos', `node ${MARKER} adhoc allow-data-change --changed "el botón pide al proceso" --recommends pasar --why "el proceso tiene su seguridad"`],
    // dejar pasar un guardado ajeno: también antes de dar el cuadro
    ['adhoc-lane:guardado-ajeno', `node ${MARKER} adhoc allow-foreign-save`],
  ];
  const vistas = new Set();
  for (const [firma, cmd] of [...GUIONES, ...otras]) {
    const casa = casaNueva(t);
    let visto = null;
    const r = pedir(casa, cmd, { comprobar: (o) => { visto = o; return { niega: 'falta un requisito' }; } });
    assert.strictEqual(r.decision, 'deny', `${cmd}: ${r.texto}`);
    assert.match(r.texto, /No abrí la ventana.*falta un requisito/);
    assert.strictEqual(vigentes(casa).length, 0, `${cmd}: sin registro`);
    assert.strictEqual(visto && visto.firma, firma, cmd);
    vistas.add(firma);
  }
  // la refirma tras traer main la dice el clasificador, y su chequeo es el de esa firma
  let visto = null;
  const r = pedir(casaNueva(t), `bash ${CONTROLES} approve --base origin/main`, { clasificar: () => ({ clase: 'refresh-after-main', refirma_de: 'abc' }),
    comprobar: (o) => { visto = o; return { niega: 'falta un requisito' }; } });
  assert.strictEqual(r.decision, 'deny', r.texto);
  vistas.add(visto.firma);
  // el ok de guardar tiene sus pruebas arriba; pasar el tope, la suya: su chequeo corre después del click
  assert.deepStrictEqual(CON_REQUISITOS.filter((f) => !vistas.has(f)), ['save', 'adhoc-lane:sobre-cupo'], 'cada firma con su comando');
});

/** Una foto de lo que hay en las carpetas: cada archivo con su contenido. */
function fotoDe(...carpetas) {
  const out = {};
  for (const c of carpetas) {
    let lista = [];
    try { lista = fs.readdirSync(c, { recursive: true }); } catch (_) { /* no existe */ }
    for (const f of lista.sort()) {
      const p = path.join(c, String(f));
      if (p.includes(`${path.sep}.git${path.sep}`)) continue;
      try { out[p] = fs.statSync(p).isDirectory() ? 'carpeta' : fs.readFileSync(p, 'utf8'); } catch (_) { out[p] = '?'; }
    }
  }
  return out;
}

// 🔴 Falla con: un requisito que el guion mira después de la firma (el «Sí» se pierde), o el chequeo que escribe.
test('Precheck_LosGuionesDeVerdad_NieganLoQueAntesNegabanDespuesDeLaFirma', (t) => {
  const casa = casaNueva(t);
  const estado = path.join(casa, '.claude', '.tycon-pipeline');
  const rd = repoDePrueba(t);
  const git = (...a) => spawnSync('git', ['-C', rd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  fs.writeFileSync(path.join(rd, 'a.txt'), 'a\n');
  fs.mkdirSync(path.join(rd, 'specs'));
  fs.writeFileSync(path.join(rd, 'specs', 'story-9.97.md'), '---\nstory: "9.97"\n---\n\n# Story 9.97\n');
  fs.mkdirSync(path.join(rd, 'tasks'));
  fs.writeFileSync(path.join(rd, 'tasks', 'todo.md'), '# Pendientes\n\n- [ ] [DEF-viejo] algo\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const blob = git('rev-parse', 'HEAD:a.txt').stdout.trim();
  const chequear = (cmd, sesion = 'ses-a') => ow.comprobarConElGuion({ palabras: ow.canonica(cmd), cwd: rd, sesion, casa });
  const niega = (cmd, re, sesion) => {
    const antes = fotoDe(estado, rd);
    const c = chequear(cmd, sesion);
    assert.ok(c && c.niega, `${cmd}: ${JSON.stringify(c)}`);
    assert.match(c.niega, re, cmd);
    assert.deepStrictEqual(fotoDe(estado, rd), antes, `${cmd}: la negativa no escribió nada`);
  };
  // el guion de los controles es de la consola: corre con bash, y lo que niega es suyo
  niega(`bash ${CONTROLES} approve --root ${rd} --entries '[{"path":"a.txt","blob":"0000000"}]'`, /no coinciden con la punta/);
  // la constancia que ya está en la carpeta: igual o distinta, firmar de nuevo no escribe nada
  const carpeta = path.join(rd, '.github', 'control-changes');
  fs.mkdirSync(carpeta, { recursive: true });
  const hash = crypto.createHash('sha256').update(`a.txt\t${blob}\n`).digest('hex');
  fs.writeFileSync(path.join(carpeta, `${hash}.json`), '{"no":"es esta firma"}\n');
  niega(`bash ${CONTROLES} approve --root ${rd} --out .github/control-changes/ --entries '[{"path":"a.txt","blob":"${blob}"}]'`, /ya existe/);
  fs.rmSync(path.join(rd, '.github'), { recursive: true, force: true });
  // contar sin la constancia de que corrieron los revisores, sin la lista que se confía: no cuenta nada
  niega(`node ${PIPELINE} check-count --repo ${rd} --story ${path.join(rd, 'specs', 'story-9.97.md')} --trust-ran`, /--ran/);
  // un pendiente ya aprobado no se vuelve a firmar
  const PA = require('../lib/pending-approvals.js');
  fs.writeFileSync(path.join(rd, PA.RECORD), `${JSON.stringify({ id: 'DEF-viejo', via: 'base' })}\n`);
  niega(`node ${MARKER} approve-pending --id DEF-viejo --repo ${rd}`, /ya estaba aprobado/);
  fs.rmSync(path.join(rd, PA.RECORD));
  // …y uno aprobado en su archivo de la carpeta, tampoco
  const enCarpeta = { ...PA.lineaNueva({ id: 'DEF-viejo', maquina: 'abc', ahora: AHORA }), via: 'terminal', quien: 'alguien' };
  fs.mkdirSync(path.join(rd, PA.RECORD_DIR), { recursive: true });
  fs.writeFileSync(path.join(rd, PA.archivoDe(enCarpeta)), `${JSON.stringify(enCarpeta)}\n`);
  niega(`node ${MARKER} approve-pending --id DEF-viejo --repo ${rd}`, /ya estaba aprobado/);
  fs.rmSync(path.join(rd, PA.RECORD_DIR), { recursive: true });
  // preparar la prueba con navegador con una dirección que no sirve
  niega(`node ${E2E} prepare --repo ${rd} --story specs/story-9.97.md --url ftp://x`, /no es una dirección http/);
  // eximir un crítico en una corrida sin carpeta: el chequeo llega a la firma sin crearla
  fs.writeFileSync(path.join(estado, 'active', 'ses-w.json'), JSON.stringify({ sessionId: 'ses-w', storyId: '9.97', storyPath: path.join(rd, 'specs', 'story-9.97.md'),
    repoPath: rd, startedAt: new Date(AHORA).toISOString() }));
  const antes = fotoDe(estado, rd);
  assert.deepStrictEqual(chequear(`node ${MARKER} waive-critical --rule SEC-C1 --reason "lo cubre otra capa"`, 'ses-w'), { ok: true });
  assert.deepStrictEqual(fotoDe(estado, rd), antes, 'el chequeo no creó la carpeta de la corrida');
});

// --- la aprobación explícita: un click en el cuadro o un «aprobado» escrito (owner-approvals.js) ---------------------
// Donde la ventana no llega (una pestaña sin permisos, una sesión de fondo) la firma la da la persona sin terminal. Se
// prueba lo que tiene que pasar y lo que no: sin aprobación se niega y dice cómo aprobar; una aprobación sirve para una
// sola firma; la de otra sesión que no es la coordinadora no vale; lo irreversible sigue en la terminal.
const oaReal = require('../lib/owner-approvals.js');
// la transcripción y los ganchos se prueban en owner-approvals.test.js: acá se dan por buenos
const aprobacionesDePrueba = ({ coordinadora = null } = {}) => ({
  buscar: (o) => oaReal.buscar({ ...o, validar: () => ({ ok: true }) }),
  consumir: oaReal.consumir,
  devolver: oaReal.devolver,
  coordinadoraConfirmada: () => coordinadora,
});
const pedirSinVentana = (casa, cmd, o = {}) => ow.decidir({ evento: evento(cmd, { ...DE_LA_COORD, permission_mode: 'bypassPermissions', ...(o.evento || {}) }),
  escapes: o.escapes || [], arbol: o.arbol || arbolDelFreno(), pid: 201, casa, ahora: o.ahora || AHORA, delegacion: o.delegacion || SIN_DELEGACION,
  clasificar: () => null, comprobar: () => null, aprobador: DEL_ARNES, aprobaciones: o.aprobaciones || aprobacionesDePrueba(o), topes: o.topes });
const anotarAprobacion = (casa, sesion, extra = {}) => oaReal.anotar(casa, { tipo: 'mensaje', sesion, ts: new Date(AHORA - 60000).toISOString(), texto: 'Aprobado',
  herramienta: { pid: 100, inicio: INICIO }, ...extra });
const PERDIDA = `node ${MARKER} clear-session ses-a --lost`;
const PERDIDA_ARGV = [MARKER, 'clear-session', 'ses-a', '--lost'];
const LA_RUTINA_PENDIENTE = () => `node ${MARKER} approve-pending --id DEF-x --repo /r`;

test('Aprobacion_SinClickNiMensaje_SeNiegaYDiceComoAprobarSinTerminal', (t) => {
  const casa = casaNueva(t);
  const r = pedirSinVentana(casa, PERDIDA);
  assert.strictEqual(r.decision, 'deny', r.texto);
  assert.match(r.texto, /cuadro de opciones/);
  assert.match(r.texto, /«aprobado»/);
  assert.match(r.texto, /Si sale mal: la ejecución se cierra/);
  assert.match(r.texto, /--terminal/, 'la terminal queda como opción');
  assert.strictEqual(registros(casa).length, 0);
  // el cuadro va primero, armado: el chat queda para cuando no se puede mostrar
  assert.ok(r.cuadro && r.texto.includes(r.cuadro.pregunta), 'trae la pregunta entera');
  assert.match(r.cuadro.sello, /^firma lost-run · sesión ses-a · código [0-9a-f]{8}$/);
  assert.ok(r.texto.indexOf('AskUserQuestion') < r.texto.lastIndexOf('«aprobado»'), 'el «aprobado» escrito va después del cuadro');
  assert.match(r.texto, /No se lo pidas por el chat salvo/);
});

test('Cuadro_ElMismoComandoDaElMismoCuadro_DesdeLaSesionODesdeLaCoordinadora', (t) => {
  const casa = casaNueva(t);
  const JSON1 = '{"reason":"arreglar el aviso","maxFiles":3}';
  const palabras = (...r) => [MARKER, 'adhoc', 'set', JSON1, ...r];
  const propia = ow.cuadroPara({ firma: 'adhoc-lane', palabras: palabras(), destino: 'ses-a', casa, sesion: 'ses-a' });
  const ajena = ow.cuadroPara({ firma: 'adhoc-lane', palabras: palabras('--for-session', 'ses-a'), destino: 'ses-a', casa, sesion: 'ses-coord' });
  assert.deepStrictEqual(propia, ajena);
  assert.match(propia.pregunta, /Qué hace: Abre un arreglo rápido sin historia, con hasta 3 archivos.*Cita de la sesión: «arreglar el aviso»/);
  const otro = ow.cuadroPara({ firma: 'adhoc-lane', palabras: [MARKER, 'adhoc', 'set', '{"reason":"otra cosa distinta","maxFiles":3}'], destino: 'ses-a', casa, sesion: 'ses-a' });
  assert.notStrictEqual(otro.sello, propia.sello, 'otro comando es otra aprobación');
  // el cambio de control muestra los archivos, no el JSON
  const c = ow.cuadroPara({ firma: 'control-change', palabras: [`${MARKER}/../run-base-controls.sh`, 'approve', '--root', '/r', '--entries', '[{"path":"scripts/a.js","blob":"b1"},{"path":"scripts/b.js","blob":"b2"}]'], destino: 'ses-a', casa, sesion: 'ses-a' });
  assert.match(c.pregunta, /Archivos: scripts\/a\.js, scripts\/b\.js\./);
  // toda firma del catálogo dice qué pasa si sale mal
  const { SIGNATURES } = require('../lib/signatures.js');
  for (const s of SIGNATURES) assert.ok(s.ifWrong && s.ifWrong.length > 10, s.id);
});

test('Aprobacion_NoContoYFirmoLaDelegacion_ElComandoLoDice', (t) => {
  const casa = casaConDesignada(t);
  const noVale = { ...aprobacionesDePrueba(), buscar: () => ({ ok: false, motivo: 'la aprobación no vale: la pregunta no es la del guion' }) };
  assert.strictEqual(pedir(casa, PLAN, { evento: DE_LA_COORD, delegacion: delegacionReal(), aprobaciones: noVale }).via, 'delegacion');
  const dichos = [];
  const e = ow.exigir({ firma: 'plan-approval', argv: PLAN_ARGV, pid: 301, arbol: arbolDelGuion(casa, PLAN), casa, ahora: AHORA + 60000, propia: 'ses-coord', antes: () => null, avisarSinAprobacion: (x) => dichos.push(x) });
  assert.strictEqual(e.codigo, 0, e.motivo);
  assert.match(dichos.join(''), /no contó la aprobación de la persona, y esto se firmó por delegacion: la aprobación no vale: la pregunta no es la del guion/);
  // sin aprobación ninguna es lo normal de la delegación: no hay nada que avisar
  const casa2 = casaConDesignada(t);
  const nada = { ...aprobacionesDePrueba(), buscar: () => ({ ok: false, motivo: 'no hay un click en el cuadro ni un «aprobado» tuyo' }) };
  pedir(casa2, PLAN, { evento: DE_LA_COORD, delegacion: delegacionReal(), aprobaciones: nada });
  const otros = [];
  ow.exigir({ firma: 'plan-approval', argv: PLAN_ARGV, pid: 301, arbol: arbolDelGuion(casa2, PLAN), casa: casa2, ahora: AHORA + 60000, propia: 'ses-coord', antes: () => null, avisarSinAprobacion: (x) => otros.push(x) });
  assert.deepStrictEqual(otros, []);
});

test('Aprobacion_SaltearElPaseYaNoEsDeLaTerminal', (t) => {
  const casa = casaNueva(t);
  const CMD = `node ${MARKER} sign-adversarial-skip --story 9.99 --reason "el cambio es sólo un texto"`;
  const r = pedirSinVentana(casa, CMD);
  assert.strictEqual(r.decision, 'deny', r.texto);
  assert.match(r.texto, /AskUserQuestion/);
  anotarAprobacion(casa, 'ses-coord');
  const con = pedirSinVentana(casa, CMD);
  assert.deepStrictEqual([con.decision, con.via], ['allow', 'mensaje'], con.texto);
});

test('Aprobacion_ConfirmarLaCoordinadora_ConUnClickEnSuPestana', (t) => {
  const casa = casaNueva(t);
  const CMD = `node ${path.join(__dirname, '..', 'lib', 'delegated-signing.js')} confirm-designation`;
  assert.deepStrictEqual([...ow.firmasDelComando(CMD)], ['designation-confirm']);
  assert.deepStrictEqual([...ow.firmasDelComando(`node /x/delegated-signing.js otra-cosa`)], []);
  const sin = pedirSinVentana(casa, CMD);
  assert.strictEqual(sin.decision, 'deny', sin.texto);
  assert.match(sin.texto, /firma designation-confirm/);
  anotarAprobacion(casa, 'ses-coord', { tipo: 'click', tool_use_id: 'toolu_1' });
  assert.strictEqual(pedirSinVentana(casa, CMD).via, 'click');
  // no se corre para otra sesión: la confirma la designada en su pestaña
  const otra = pedirSinVentana(casaNueva(t), `${CMD} --for-session ses-a`);
  assert.strictEqual(otra.decision, 'deny');
  assert.match(otra.texto, /no se corre desde la pestaña de otra sesión/);
});

// Una firma delegada corre sin negar, y el cuadro sólo lo da el freno al negar: pedir más que el cupo y recortarlo callado
// dejaba a la coordinadora sin cuadro que mostrar, y a la persona con un arreglo que no pidió.
const ADHOC_GRANDE = `node ${MARKER} adhoc set '{"reason":"arreglo del sp","allowedFiles":["src/sp.js"],"maxFiles":7}' --for-session ses-a`;
const pedirConDelegacion = (casa, cmd, o = {}) => pedirSinVentana(casa, cmd, { ...o, coordinadora: 'ses-coord', delegacion: () => ({ ok: true, maquina: 'm' }) });

test('Adhoc_PideMasQueElCupoDelegado_NoDelega_DaElCuadro', (t) => {
  const casa = casaNueva(t);
  const r = pedirConDelegacion(casa, ADHOC_GRANDE);
  assert.strictEqual(r.decision, 'deny', r.texto);
  assert.match(r.texto, /supera los 5 archivos/);
  assert.match(r.texto, /firma adhoc-lane · sesión ses-a · código /, 'el cuadro va armado');
  assert.strictEqual(registros(casa).length, 0);
});

test('Adhoc_DentroDelCupo_SigueDelegando', (t) => {
  const casa = casaNueva(t);
  const r = pedirConDelegacion(casa, `node ${MARKER} adhoc set '{"reason":"arreglo del sp","allowedFiles":["src/sp.js"],"maxFiles":5}' --for-session ses-a`);
  assert.deepStrictEqual([r.decision, r.via], ['allow', 'delegacion'], r.texto);
});

test('Adhoc_ClickConElCuadroDelFreno_DejaElCupoPedido', (t) => {
  const casa = casaNueva(t);
  anotarAprobacion(casa, 'ses-coord', { tipo: 'click', tool_use_id: 'toolu_1' });
  const r = pedirConDelegacion(casa, ADHOC_GRANDE);
  assert.deepStrictEqual([r.decision, r.via], ['allow', 'click'], r.texto);
});

test('Adhoc_PestanaSinPermisos_PideMasQueElCupo_NoSeHaceAvisado', (t) => {
  const casa = casaNueva(t);
  const r = pedirSinVentana(casa, `node ${MARKER} adhoc set '{"reason":"arreglo del sp","allowedFiles":["src/sp.js"],"maxFiles":7}'`, { evento: { session_id: 'ses-a' } });
  assert.strictEqual(r.decision, 'deny', r.texto);
  assert.match(r.texto, /supera los 5 archivos/);
  const chico = pedirSinVentana(casaNueva(t), `node ${MARKER} adhoc set '{"reason":"arreglo del sp","allowedFiles":["src/sp.js"],"maxFiles":5}'`, { evento: { session_id: 'ses-a' } });
  assert.deepStrictEqual([chico.decision, chico.via], ['allow', 'avisado'], chico.texto);
});

// --- pasar el tope del camino corto: lo elige la persona, con su click, en la pestaña que trabaja ---------------------
const SOBRE_CUPO = 'adhoc-lane:sobre-cupo';
const pedidoDe = (cupo, resto = '') => `node ${MARKER} adhoc set '{"reason":"arreglo del sp","allowedFiles":["src/sp.js"],"maxFiles":${cupo}}'${resto}`;
const DE_LA_PROPIA = { session_id: 'ses-a' };

test('T1 AdhocSet_MasDeOcho_PideLaFirmaDeSobreCupo @story-8.181 @ac-1', (t) => {
  assert.deepStrictEqual(ow.firmasDelComando(pedidoDe(9)), [SOBRE_CUPO]);
  assert.deepStrictEqual(pedir(casaNueva(t), pedidoDe(9)).firmas, [SOBRE_CUPO]);
});

// ── los topes del camino corto configurados por la organización (@story-8.182) ──────────────────────────────────────
// 🔴 Falla con: un freno que sigue con el 5 o el 8 escritos aunque el perfil diga otro tope, o que nombra otro número.
const TOPES_3_10 = { delegado: 3, maximo: 10 };

test('T12 Ventana_DelegadoConfigurado_NiegaNombrandoElValor @story-8.182 @ac-13 @ac-18 — tope delegado 3: pedir 4 se niega y dice 3', (t) => {
  const pide4 = `node ${MARKER} adhoc set '{"reason":"arreglo del sp","allowedFiles":["src/sp.js"],"maxFiles":4}' --for-session ses-a`;
  const r = pedirConDelegacion(casaNueva(t), pide4, { topes: TOPES_3_10 });
  assert.strictEqual(r.decision, 'deny', r.texto);
  assert.match(r.texto, /supera los 3 archivos/);
  // pedir 3 sigue delegando
  const tres = pedirConDelegacion(casaNueva(t), `node ${MARKER} adhoc set '{"reason":"arreglo del sp","allowedFiles":["src/sp.js"],"maxFiles":3}' --for-session ses-a`, { topes: TOPES_3_10 });
  assert.notStrictEqual(tres.decision, 'deny', tres.texto);
  // una pestaña sin permisos, «hecho y avisado»: lo mismo
  const avisado = pedirSinVentana(casaNueva(t), `node ${MARKER} adhoc set '{"reason":"arreglo del sp","allowedFiles":["src/sp.js"],"maxFiles":4}'`, { evento: { session_id: 'ses-a' }, topes: TOPES_3_10 });
  assert.strictEqual(avisado.decision, 'deny', avisado.texto);
  assert.match(avisado.texto, /supera los 3 archivos/);
  // un perfil leído de verdad: la misma lectura que usa el freno
  const { copiaConPerfil } = require('./lib/profile-harness-copy.js');
  const io = require(path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'story-gate-io.js'));
  const arbol = copiaConPerfil(t, { short_path: { coordinator_max_files: 3, max_files: 10 } });
  assert.deepStrictEqual((({ delegado, maximo }) => ({ delegado, maximo }))(io.topesDelCaminoCorto({ arnes: arbol.raiz })), TOPES_3_10);
});

test('T13 Ventana_SobreCupoConfigurado_PideElClick @story-8.182 @ac-14 — tope 10: pedir 10 es la firma común, 11 el sobre cupo', (t) => {
  assert.deepStrictEqual(ow.firmasDelComando(pedidoDe(10), TOPES_3_10), ['adhoc-lane']);
  assert.deepStrictEqual(ow.firmasDelComando(pedidoDe(11), TOPES_3_10), [SOBRE_CUPO]);
  assert.deepStrictEqual(ow.firmasDelComando(`node ${MARKER} adhoc set '{"reason":"arreglo del sp","allowedFiles":["src/sp.js"]}'`, TOPES_3_10), ['adhoc-lane'], 'sin número, la común');
  assert.deepStrictEqual(pedir(casaNueva(t), pedidoDe(11), { topes: TOPES_3_10 }).firmas, [SOBRE_CUPO]);
  assert.deepStrictEqual(pedir(casaNueva(t), pedidoDe(10), { topes: TOPES_3_10 }).firmas, ['adhoc-lane']);
  // el techo técnico no cambia: 51 sigue siendo sobre cupo para el freno y el guion lo niega
  assert.deepStrictEqual(ow.firmasDelComando(pedidoDe(51), TOPES_3_10), [SOBRE_CUPO]);
  // sin topes configurados, los de fábrica: 8 común, 9 sobre cupo
  assert.deepStrictEqual(ow.firmasDelComando(pedidoDe(8), { delegado: 5, maximo: 8 }), ['adhoc-lane']);
  assert.deepStrictEqual(ow.firmasDelComando(pedidoDe(9), { delegado: 5, maximo: 8 }), [SOBRE_CUPO]);
});

test('T14 Ventana_SinNumero_DiceElValorConfigurado @story-8.182 @ac-18 — tope 10 y un pedido sin número: el resumen de la firma dice 10', (t) => {
  const { copiaConPerfil } = require('./lib/profile-harness-copy.js');
  const { conVentana } = require('./lib/window-passed.js');
  const arbol = copiaConPerfil(t, { short_path: { max_files: 10 } });
  const casa = casaNueva(t);
  const r = spawnSync(process.execPath, [arbol.marker, 'adhoc', 'set', '{"reason":"arreglo del sp de deudas","datos":"sin-cambio","allowedFiles":["src/sp.js"]}'],
    { encoding: 'utf8', cwd: casa, env: conVentana({ ...process.env, HOME: casa, USERPROFILE: casa, CLAUDE_CODE_SESSION_ID: 'ses-a' }) });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).maxFiles, 10);
  const firma = gates(casa).find((g) => g.name === 'adhoc-lane-signed');
  assert.ok(firma, JSON.stringify(gates(casa)));
  assert.match(firma.resumen, /10 archivos/);
  assert.doesNotMatch(firma.resumen, /\b8 archivos/);
  // el cuadro que firma el dueño (la ventana, el cuadro de opciones y la lista de firmas) dice el mismo número
  const fuentes = require('../lib/signature-sources.js');
  const sinNumero = ['marker.js', 'adhoc', 'set', '{"reason":"arreglo del sp de deudas","datos":"sin-cambio"}'];
  const cuadro = fuentes.partesDe({ firma: 'adhoc-lane', palabras: sinNumero, topes: { delegado: 5, maximo: 10 } }).queHace[0];
  assert.match(cuadro, /10 archivos/);
  assert.doesNotMatch(cuadro, /\b8 archivos/);
  // y leído del perfil de un arnés copiado, sin pasarle los topes
  const r2 = spawnSync(process.execPath, ['-e', `const f=require(${JSON.stringify(path.join(arbol.raiz, 'scripts', 'lib', 'signature-sources.js'))});process.stdout.write(f.partesDe({firma:'adhoc-lane',palabras:${JSON.stringify(sinNumero)}}).queHace[0])`],
    { encoding: 'utf8', env: { ...process.env, HOME: casa, USERPROFILE: casa } });
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /10 archivos/);
  // el cuadro que arma el freno (cuadroPara) le pasa a la fuente los topes con que decide
  const owCopia = JSON.stringify(path.join(arbol.raiz, 'scripts', 'lib', 'owner-window.js'));
  const r3 = spawnSync(process.execPath, ['-e', `const ow=require(${owCopia});process.stdout.write(JSON.stringify(ow.cuadroPara({firma:'adhoc-lane',comando:${JSON.stringify(sinNumero.join(' '))},palabras:${JSON.stringify(sinNumero)},cwd:process.cwd(),casa:${JSON.stringify(casa)}})))`],
    { encoding: 'utf8', env: { ...process.env, HOME: casa, USERPROFILE: casa } });
  assert.strictEqual(r3.status, 0, r3.stderr);
  assert.match(r3.stdout, /10 archivos/);
  assert.doesNotMatch(r3.stdout, /\b8 archivos/);
  // si la lectura de los topes no carga, la fuente cae a los de fábrica: nunca a uno más alto
  fs.writeFileSync(path.join(arbol.raiz, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'story-gate-io.js'), "throw new Error('lectura rota');\n");
  const r4 = spawnSync(process.execPath, ['-e', `const f=require(${JSON.stringify(path.join(arbol.raiz, 'scripts', 'lib', 'signature-sources.js'))});process.stdout.write(f.partesDe({firma:'adhoc-lane',palabras:${JSON.stringify(sinNumero)}}).queHace[0])`],
    { encoding: 'utf8', env: { ...process.env, HOME: casa, USERPROFILE: casa } });
  assert.strictEqual(r4.status, 0, r4.stderr);
  assert.match(r4.stdout, /\b8 archivos/);
});

test('T2 AdhocSet_OchoJustos_SiguePidiendoLaFirmaComun @story-8.181 @ac-1', () => {
  assert.deepStrictEqual(ow.firmasDelComando(pedidoDe(8)), ['adhoc-lane']);
  assert.deepStrictEqual(ow.firmasDelComando(`node ${MARKER} adhoc set --reason "arreglo del sp" --max-files 8 --terminal`), ['adhoc-lane']);
});

test('T3 AdhocSet_SinCupoNiTecho_FirmaComunY51SeNiega @story-8.181 @ac-1', (t) => {
  assert.deepStrictEqual(ow.firmasDelComando(`node ${MARKER} adhoc set '{"reason":"arreglo del sp","allowedFiles":["src/sp.js"]}'`), ['adhoc-lane']);
  assert.deepStrictEqual(ow.firmasDelComando(`node ${MARKER} adhoc set --reason "arreglo del sp" --terminal`), ['adhoc-lane']);
  assert.deepStrictEqual(ow.firmasDelComando(pedidoDe(50)), [SOBRE_CUPO]);
  const casa = casaNueva(t);
  const r = require('child_process').spawnSync(process.execPath, [MARKER, 'adhoc', 'set', '{"reason":"arreglo del sp","allowedFiles":["src/sp.js"],"maxFiles":51}'],
    { encoding: 'utf8', env: { ...process.env, HOME: casa, USERPROFILE: casa, CLAUDE_CODE_SESSION_ID: 'ses-a' } });
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /de 1 a 50/);
});

test('T4 AdhocSet_AgrandarPasandoDeOcho_PideLaFirmaDeSobreCupo @story-8.181 @ac-1', (t) => {
  const casa = casaNueva(t);
  const adhoc = path.join(casa, '.claude', '.tycon-pipeline', 'adhoc');
  fs.mkdirSync(adhoc, { recursive: true });
  fs.writeFileSync(path.join(adhoc, 'ses-a.json'), JSON.stringify({ reason: 'arreglo del sp', maxFiles: 8, files: [] }));
  const r = pedir(casa, pedidoDe(9));
  assert.strictEqual(r.decision, 'deny', r.texto);
  assert.deepStrictEqual(r.firmas, [SOBRE_CUPO]);
});

test('T5 OwnerWindow_CupoQueNoSePuedeLeer_CuentaComoSobreCupo @story-8.181 @ac-2', (t) => {
  for (const cmd of [`node ${MARKER} adhoc set "$PEDIDO"`, `node ${MARKER} adhoc "$QUE"`, `node ${MARKER} adhoc set '{"reason":"roto"'`, `node ${MARKER} adhoc set`,
    `node ${MARKER} adhoc set --reason "arreglo del sp" --max-files "$N" --terminal`, `node ${MARKER} adhoc set --reason "arreglo del sp" --max-files=9 --terminal`,
    `node ${MARKER} adhoc set '{"reason":"arreglo del sp","allowedFiles":["src/sp.js"],"maxFiles":"nueve"}'`]) {
    assert.deepStrictEqual(ow.firmasDelComando(cmd), [SOBRE_CUPO], cmd);
    assert.deepStrictEqual(pedir(casaNueva(t), cmd).firmas, [SOBRE_CUPO], cmd);
  }
  // un `$` dentro del motivo, entre comillas simples, no es una variable: el freno y el guion ven la misma firma
  const conPesos = `node ${MARKER} adhoc set '{"reason":"el total en $ sale mal","maxFiles":3}'`;
  assert.deepStrictEqual(ow.firmasDelComando(conPesos), ['adhoc-lane']);
  assert.strictEqual(ow.canonicaDe(conPesos).id, 'adhoc-lane');
});

test('T6 AdhocSet_SobreCupo_NoSaleConDelegacion @story-8.181 @ac-3', (t) => {
  const delegacion = () => ({ ok: true, maquina: 'm' });
  // aunque el perfil la nombre: no se delega
  const casa = casaNueva(t);
  const r = pedir(casa, pedidoDe(9), { delegacion });
  assert.strictEqual(r.decision, 'deny', r.texto);
  assert.ok(r.cuadro && r.cuadro.soloClick, 'trae el cuadro para la persona');
  assert.strictEqual(registros(casa).length, 0);
  // y la coordinadora no lo pide por otra pestaña
  const ajena = pedirConDelegacion(casaNueva(t), pedidoDe(9, ' --for-session ses-a'));
  assert.strictEqual(ajena.decision, 'deny', ajena.texto);
  assert.match(ajena.texto, /no se corre desde la pestaña de otra sesión/);
});

// 🔴 Falla con: la negativa desde otra pestaña sólo en el freno: el guion correría si el freno no lo mira.
test('AdhocSet_SobreCupo_ParaOtraSesion_ElGuionTambienLoNiega @story-8.181 @ac-3', () => {
  const r = ow.exigir({ firma: SOBRE_CUPO, argv: [MARKER, 'adhoc', 'set', '{"reason":"arreglo del sp","allowedFiles":["src/sp.js"],"maxFiles":9}', '--for-session', 'ses-b'], propia: 'ses-a' });
  assert.strictEqual(r.codigo, 1, JSON.stringify(r));
  assert.match(r.motivo, /se corre desde la sesión destino/);
});

// 🔴 Falla con: la lista cruda, con pruebas y sondas, que niega un cupo que alcanza y empuja a la firma de sobre cupo.
test('AdhocSet_ChequeoPrevio_PruebasYSondasNoCuentanContraElCupo @story-8.181 @ac-10', (t) => {
  const casa = casaNueva(t);
  execFileSync('git', ['init', '-q', casa]);
  const real = path.join(casa, 'src', 'a.js');
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, 'x\n');
  const adhoc = path.join(casa, '.claude', '.tycon-pipeline', 'adhoc');
  fs.mkdirSync(adhoc, { recursive: true });
  const crudos = [real, ...Array.from({ length: 9 }, (_, i) => path.join(casa, 'src', `a${i}.test.js`)), '/tmp/sonda.js', '$L/p.js'];
  for (const f of crudos.slice(1, 10)) fs.writeFileSync(f, 'x\n');
  fs.writeFileSync(path.join(adhoc, 'ses-a.json'), JSON.stringify({ reason: 'arreglo del sp', maxFiles: 8, files: crudos }));
  const pedido = (cupo) => ow.comprobarConElGuion({ firma: 'adhoc-lane', palabras: [MARKER, 'adhoc', 'set', JSON.stringify({ reason: 'arreglo del sp', allowedFiles: ['src/a.js'], maxFiles: cupo })], cwd: casa, sesion: 'ses-a', casa });
  assert.deepStrictEqual(pedido(8), { ok: true });
  assert.deepStrictEqual(pedido(1), { ok: true }, 'un archivo de verdad entra en un cupo de 1');
});

test('T7 AdhocSet_SobreCupo_NoSaleConHechoYAvisado @story-8.181 @ac-3', (t) => {
  const casa = casaNueva(t);
  const r = pedirSinVentana(casa, pedidoDe(9), { evento: DE_LA_PROPIA });
  assert.strictEqual(r.decision, 'deny', r.texto);
  assert.ok(r.cuadro && r.texto.includes(r.cuadro.pregunta), 'trae el cuadro entero');
  assert.doesNotMatch(r.texto, /«aprobado»/, 'no ofrece el mensaje escrito');
  assert.doesNotMatch(r.texto, /coordinadora/, 'no ofrece la coordinadora');
  assert.match(r.texto, /--terminal/, 'ofrece la terminal');
  assert.strictEqual(registros(casa).length, 0);
});

test('T8 AdhocSet_SobreCupo_AprobadoEscrito_NoVale @story-8.181 @ac-4', (t) => {
  const casa = casaNueva(t);
  anotarAprobacion(casa, 'ses-a');
  const r = pedirSinVentana(casa, pedidoDe(9), { evento: DE_LA_PROPIA });
  assert.strictEqual(r.decision, 'deny', r.texto);
  assert.strictEqual(oaReal.leerSesion(casa, 'ses-a').filter((a) => !oaReal.usada || !oaReal.usada(casa, a.id)).length, 1, 'el mensaje no se gastó');
});

test('T9 AdhocSet_SobreCupo_ClickEnLaCoordinadora_NoVale @story-8.181 @ac-4', (t) => {
  const casa = casaNueva(t);
  anotarAprobacion(casa, 'ses-coord', { tipo: 'click', tool_use_id: 'toolu_1' });
  const r = pedirSinVentana(casa, pedidoDe(9), { evento: DE_LA_PROPIA, coordinadora: 'ses-coord' });
  assert.strictEqual(r.decision, 'deny', r.texto);
  // el click en la pestaña que trabaja, sí
  const propia = casaNueva(t);
  anotarAprobacion(propia, 'ses-a', { tipo: 'click', tool_use_id: 'toolu_2' });
  const v = pedirSinVentana(propia, pedidoDe(9), { evento: DE_LA_PROPIA, coordinadora: 'ses-coord' });
  assert.deepStrictEqual([v.decision, v.via], ['allow', 'click'], v.texto);
});

test('T10 AdhocSet_SobreCupo_ConPermisos_VaPorElCuadro @story-8.181 @ac-4', (t) => {
  for (const evento of [undefined, { permission_mode: 'default' }, { permission_mode: 'acceptEdits' }]) {
    const casa = casaNueva(t);
    const r = pedir(casa, pedidoDe(9), { evento, aprobaciones: aprobacionesDePrueba() });
    assert.strictEqual(r.decision, 'deny', r.texto);
    assert.ok(r.cuadro && r.cuadro.descripciones, 'el cuadro con sus descripciones');
    assert.strictEqual(registros(casa).length, 0);
  }
  // con el click, sale sin ventana: el renglón queda con su vía
  const casa = casaNueva(t);
  anotarAprobacion(casa, 'ses-a', { tipo: 'click', tool_use_id: 'toolu_1' });
  const r = pedir(casa, pedidoDe(9), { aprobaciones: aprobacionesDePrueba() });
  assert.deepStrictEqual([r.decision, r.via], ['allow', 'click'], r.texto);
  // la firma común sigue por la ventana
  assert.strictEqual(pedir(casaNueva(t), pedidoDe(8)).decision, 'ask');
});

test('Precheck_SobreCupo_ConElClick_NoLoGastaSiElGuionSeNiega @story-8.181 @ac-4', (t) => {
  const casa = casaNueva(t);
  anotarAprobacion(casa, 'ses-a', { tipo: 'click', tool_use_id: 'toolu_1' });
  let visto = null;
  const r = pedir(casa, pedidoDe(9), { aprobaciones: aprobacionesDePrueba(), comprobar: (o) => { visto = o; return { niega: 'falta un requisito' }; } });
  assert.strictEqual(r.decision, 'deny', r.texto);
  assert.strictEqual(visto.firma, SOBRE_CUPO);
  // el click sigue sin gastar: vale para el pedido corregido
  const otra = pedir(casa, pedidoDe(9), { aprobaciones: aprobacionesDePrueba() });
  assert.deepStrictEqual([otra.decision, otra.via], ['allow', 'click'], otra.texto);
});

test('T11 AdhocSet_SobreCupo_Codex_VaALaTerminal @story-8.181 @ac-4', (t) => {
  const r = pedir(casaNueva(t), pedidoDe(9), { evento: { turn_id: 'turn-1' } });
  assert.strictEqual(r.decision, 'deny', r.texto);
  assert.match(r.texto, /--terminal/);
  assert.ok(!r.cuadro, 'en Codex no hay cuadro');
});

test('HechoYAvisado_MandaPorLosCanalesDeLaSesion', (t) => {
  const casa = casaNueva(t);
  const notify = require('../lib/notify.js');
  const orig = { canalesDeLaSesion: notify.canalesDeLaSesion, avisar: notify.avisar };
  const llamadas = [];
  notify.canalesDeLaSesion = () => ({ canales: ['telegram'], mail: null, chat: 'c1', origen: 'perfil', problema: null });
  notify.avisar = (o) => { llamadas.push(o); return { resultados: [], entregado: true }; };
  t.after(() => Object.assign(notify, orig));
  assert.strictEqual(pedirSinVentana(casa, LA_RUTINA_PENDIENTE()).via, 'avisado');
  const r = ow.exigir({ firma: 'pending-approval', argv: [MARKER, 'approve-pending', '--id', 'DEF-x', '--repo', '/r'], pid: 301, arbol: arbolDelGuion(casa, LA_RUTINA_PENDIENTE()), casa, ahora: AHORA + 60000, propia: 'ses-coord', antes: () => null });
  assert.strictEqual(r.codigo, 0, r.motivo);
  assert.strictEqual(llamadas.length, 1, 'el aviso salió');
  assert.deepStrictEqual(llamadas[0].canales, ['telegram'], 'la lista de canales, no el objeto entero');
  assert.strictEqual(llamadas[0].chat, 'c1');
  assert.match(llamadas[0].texto, /Hecho y avisado/);
  const PA = require('../lib/pending-approvals.js');
  assert.ok(PA.VIAS.includes('avisado'), 'el control del commit acepta lo que escribe la rutina');
});

test('Aprobacion_MensajeAnotado_FirmaUnaVezYElGuionLaUsa', (t) => {
  const casa = casaNueva(t);
  anotarAprobacion(casa, 'ses-coord');
  const r = pedirSinVentana(casa, PERDIDA);
  assert.strictEqual(r.decision, 'allow', r.texto);
  assert.strictEqual(r.via, 'mensaje');
  assert.match(r.texto, /tu mensaje «Aprobado»/);
  const reg = JSON.parse(fs.readFileSync(path.join(ow.carpeta(casa), vigentes(casa)[0]), 'utf8'));
  assert.strictEqual(reg.via, 'mensaje');
  // el guion firma con la vía de la aprobación, con los controles de la ventana
  let viaDeAntes = null;
  const firmas = [];
  const e = ow.exigir({ firma: 'lost-run', argv: PERDIDA_ARGV, pid: 301, arbol: arbolDelGuion(casa, PERDIDA), casa, ahora: AHORA + 60000, propia: 'ses-coord',
    antes: (via) => { viaDeAntes = via; return null; }, notificar: () => {} });
  assert.strictEqual(e.codigo, 0, e.motivo);
  assert.strictEqual(e.via, 'mensaje');
  assert.strictEqual(viaDeAntes, 'ventana');
  assert.strictEqual(gates(casa).find((g) => g.name === 'lost-run-signed').via, 'mensaje');
  assert.strictEqual(ow.quienFirmo(e, 'el-dev').tipo, 'manual');
  void firmas;
  // la misma aprobación no sirve para otra firma
  const otra = pedirSinVentana(casa, PERDIDA);
  assert.strictEqual(otra.decision, 'deny', otra.texto);
});

test('Aprobacion_ViejaODeOtraSesionNoCoordinadora_SeNiega', (t) => {
  const vieja = casaNueva(t);
  anotarAprobacion(vieja, 'ses-coord', { ts: new Date(AHORA - 31 * 60000).toISOString() });
  assert.strictEqual(pedirSinVentana(vieja, PERDIDA).decision, 'deny');
  const ajena = casaNueva(t);
  anotarAprobacion(ajena, 'ses-otra');
  assert.strictEqual(pedirSinVentana(ajena, PERDIDA).decision, 'deny', 'otra sesión sin coordinadora');
  assert.strictEqual(pedirSinVentana(ajena, PERDIDA, { coordinadora: 'ses-tercera' }).decision, 'deny', 'otra sesión que no es la coordinadora');
  fs.mkdirSync(path.join(ajena, '.claude', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(ajena, '.claude', 'sessions', '100.json'), JSON.stringify({ pid: 100, sessionId: 'ses-otra' }));
  const r = pedirSinVentana(ajena, PERDIDA, { coordinadora: 'ses-otra' });
  assert.strictEqual(r.decision, 'allow', `en la pestaña de la coordinadora sí: ${r.texto}`);
});

test('Aprobacion_LoIrreversibleSigueEnLaTerminal', (t) => {
  for (const [nombre, cmd] of [['TYCON_SAFETY_OFF', 'TYCON_SAFETY_OFF=1 rm -rf build'], ['TYCON_PROD_LINT', 'TYCON_PROD_LINT=off sqlcmd -Q x']]) {
    const casa = casaNueva(t);
    anotarAprobacion(casa, 'ses-coord');
    const r = pedirSinVentana(casa, cmd, { escapes: [`escape:${nombre}`] });
    assert.strictEqual(r.decision, 'deny', `${nombre}: ${r.texto}`);
    assert.doesNotMatch(r.texto, /cuadro de opciones/, nombre);
    assert.match(r.texto, /terminal/, nombre);
    assert.ok(oaReal.buscar({ casa, sesion: 'ses-coord', ahora: AHORA, cuadro: { pregunta: 'p', sello: 's' }, validar: () => ({ ok: true }) }).ok, `${nombre}: la aprobación no se gastó`);
  }
});

test('Aprobacion_SesionDeFondo_SinAprobacionSeNiega_ConAprobacionFirma', (t) => {
  const fondo = [...BASE,
    // como lo lee `ps` en la Mac: los dos de abajo se renombran y su ejecutable trae el subcomando
    { pid: 50, ppid: 1, inicio: INICIO, ejecutable: '/u/node_modules/@anthropic-ai/claude-code/bin/claude.exe', comando: '/u/node_modules/@anthropic-ai/claude-code/bin/claude.exe daemon run --origin transient' },
    { pid: 60, ppid: 50, inicio: INICIO, ejecutable: 'claude bg-pty-host', comando: 'claude bg-pty-host --bg-pty-host /tmp/x.pty.sock 200 50 -- /u/claude' },
    { pid: 100, ppid: 60, inicio: INICIO, ejecutable: 'claude bg-spare', comando: 'claude bg-spare --bg-spare /tmp/x.claim.sock' },
    { pid: 200, ppid: 100, inicio: INICIO, comando: '/bin/bash /h/scripts/hooks/safety-guard-pre.sh' },
    { pid: 201, ppid: 200, inicio: INICIO, comando: 'node /h/scripts/lib/owner-window.js gate' }];
  const casa = casaNueva(t);
  // aun en un modo que pregunta: la ventana de una sesión de fondo no le llega a nadie seguro
  const sin = pedirSinVentana(casa, SAVE, { arbol: fondo, evento: { permission_mode: 'default' } });
  assert.strictEqual(sin.decision, 'deny', sin.texto);
  assert.match(sin.texto, /corre de fondo/);
  anotarAprobacion(casa, 'ses-coord');
  const con = pedirSinVentana(casa, SAVE, { arbol: fondo, evento: { permission_mode: 'default' } });
  assert.strictEqual(con.decision, 'allow', con.texto);
  assert.strictEqual(con.via, 'mensaje');
  // el guion de la firma, lanzado por la consola de la sesión de fondo, la reconoce como la herramienta y firma
  const guion = [...fondo.slice(0, 4),
    { pid: 300, ppid: 100, inicio: INICIO, comando: envolver(casa, SAVE) },
    { pid: 301, ppid: 300, inicio: INICIO, comando: SAVE }];
  const e = ow.exigir({ firma: 'save', argv: SAVE_ARGV, pid: 301, arbol: guion, casa, ahora: AHORA + 60000, propia: 'ses-coord', antes: () => null, notificar: () => {} });
  assert.strictEqual(e.codigo, 0, e.motivo);
  assert.strictEqual(e.via, 'mensaje');
  // otra herramienta de verdad por arriba sigue negando
  const anidada = [...BASE, { pid: 90, ppid: 1, inicio: INICIO, comando: 'claude --print algo' }, { ...herramienta(), ppid: 90 },
    { pid: 200, ppid: 100, inicio: INICIO, comando: '/bin/bash /h/scripts/hooks/safety-guard-pre.sh' },
    { pid: 201, ppid: 200, inicio: INICIO, comando: 'node /h/scripts/lib/owner-window.js gate' }];
  const casa2 = casaNueva(t);
  anotarAprobacion(casa2, 'ses-coord');
  assert.match(pedirSinVentana(casa2, SAVE, { arbol: anidada }).texto, /la lanzó otra herramienta/);
});

test('Aprobacion_RutinaSinAprobacion_SigueHechaYAvisada_ConAprobacionEsDeLaPersona', (t) => {
  const casa = casaNueva(t);
  assert.strictEqual(pedirSinVentana(casa, SAVE).via, 'avisado');
  const casa2 = casaNueva(t);
  anotarAprobacion(casa2, 'ses-coord', { tipo: 'click', tool_use_id: 'toolu_9' });
  const r = pedirSinVentana(casa2, SAVE);
  assert.strictEqual(r.via, 'click');
  assert.match(r.texto, /tu click en el cuadro de opciones/);
});

test('Aprobacion_GanaALaDelegacion_LaFirmaEsDeLaPersonaYSeUsaUnaVez', (t) => {
  const delegaTodo = delegacionReal({ perfil: { ...PERFIL, delegated_signing: ['plan-approval', 'save', 'runtime-waiver'] } });
  const RUNTIME = `node ${MARKER} runtime-waiver ${HISTORIA.story} --acs 1 --for-session ses-a`;
  const casos = [['plan-approval', PLAN, PLAN_ARGV], ['save', SAVE, SAVE_ARGV],
    ['runtime-waiver', RUNTIME, [MARKER, 'runtime-waiver', HISTORIA.story, '--acs', '1', '--for-session', 'ses-a']]];
  for (const [firma, cmd, argv] of casos) {
    const casa = casaConDesignada(t);
    if (firma === 'runtime-waiver') tresParaOtra(casa);
    const pide = (modo) => pedir(casa, cmd, { evento: { ...DE_LA_COORD, ...(modo ? { permission_mode: modo } : {}) }, delegacion: delegaTodo, aprobaciones: aprobacionesDePrueba() });
    // sin aprobación, la delegación como siempre: el guion decide con sus controles
    assert.strictEqual(pide('bypassPermissions').via, 'delegacion', firma);
    // el «aprobado» vale también en una pestaña que pregunta: lo que la delegación firmaría, ahora lo firma la persona
    anotarAprobacion(casa, 'ses-coord');
    const r = pide('default');
    assert.deepStrictEqual([r.decision, r.via], ['allow', 'mensaje'], `${firma}: ${r.texto}`);
    // el guion ya no pasa por los controles de la delegación: los de una persona en la ventana
    const vistas = [];
    const e = ow.exigir({ firma, argv, pid: 301, arbol: arbolDelGuion(casa, cmd), casa, ahora: AHORA + 60000, propia: 'ses-coord', notificar: () => {},
      antes: (via) => { vistas.push(via); return via === 'delegacion' ? { codigo: 2, motivo: 'esto es delicado' } : null; } });
    assert.strictEqual(e.codigo, 0, `${firma}: ${e.motivo}`);
    assert.strictEqual(e.via, 'mensaje', firma);
    assert.deepStrictEqual(vistas, ['ventana'], firma);
    assert.strictEqual(ow.quienFirmo(e, 'el-dev').quien, 'el-dev', firma);
    // la aprobación se gastó: el siguiente pedido vuelve a la delegación, y lo delicado se frena
    const otra = pide();
    assert.strictEqual(otra.via, 'delegacion', firma);
    const frena = ow.exigir({ firma, argv, pid: 301, arbol: arbolDelGuion(casa, cmd), casa, ahora: AHORA + 60000, propia: 'ses-coord', antes: () => ({ codigo: 2, motivo: 'esto es delicado' }) });
    assert.strictEqual(frena.codigo, 2, firma);
    assert.match(frena.motivo, /^esto es delicado\. Si lo que frena es que no firma una persona: /, firma);
    assert.match(frena.motivo, new RegExp(`firma ${firma} · sesión ses-a · código [0-9a-f]{8}`), firma);
    assert.match(frena.motivo, /sin usar\)$/, firma);
  }
});

test('Aprobacion_SinRegistroNoSeGasta_SiOtraLaGanoNoQuedaPedido', (t) => {
  // el registro no se puede escribir: se niega y la aprobación sigue sin usar
  const casa = casaNueva(t);
  anotarAprobacion(casa, 'ses-coord');
  fs.mkdirSync(path.dirname(ow.carpeta(casa)), { recursive: true });
  fs.writeFileSync(ow.carpeta(casa), 'no es una carpeta');
  const r = pedirSinVentana(casa, PERDIDA);
  assert.strictEqual(r.decision, 'deny', r.texto);
  assert.match(r.texto, /no se pudo escribir el registro/);
  fs.rmSync(ow.carpeta(casa));
  assert.strictEqual(pedirSinVentana(casa, PERDIDA).via, 'mensaje', 'la aprobación se puede usar todavía');
  // otra firma la gastó en el medio: se niega y no queda un pedido vigente que el guion pueda usar
  const casa2 = casaNueva(t);
  anotarAprobacion(casa2, 'ses-coord');
  const ganada = { ...aprobacionesDePrueba(), consumir: () => ({ ok: false, motivo: 'esa aprobación ya la usó otra firma' }) };
  const n = pedirSinVentana(casa2, PERDIDA, { aprobaciones: ganada });
  assert.strictEqual(n.decision, 'deny', n.texto);
  assert.match(n.texto, /ya la usó otra firma/);
  assert.deepStrictEqual(vigentes(casa2), []);
});

test('Aprobacion_QueNoValeConDelegacion_NoLaGastaYFirmaLaDelegacion', (t) => {
  const casa = casaConDesignada(t);
  anotarAprobacion(casa, 'ses-coord');
  const consumidas = [];
  const noVale = { ...aprobacionesDePrueba(), buscar: () => ({ ok: false, motivo: 'no nombra la firma' }), consumir: (...a) => { consumidas.push(a); return { ok: true }; } };
  const r = pedir(casa, PLAN, { evento: DE_LA_COORD, delegacion: delegacionReal(), aprobaciones: noVale });
  assert.strictEqual(r.via, 'delegacion', r.texto);
  assert.deepStrictEqual(consumidas, []);
  const reg = JSON.parse(fs.readFileSync(path.join(ow.carpeta(casa), vigentes(casa)[0]), 'utf8'));
  assert.strictEqual(reg.sin_aprobacion, 'no nombra la firma');
});

test('Aprobacion_DeOtraCopiaDeLaSesion_NoVale', (t) => {
  // un agente abre la misma sesión en otro proceso (`claude --resume`) y escribe «aprobado»: lo anota otro proceso
  const casa = casaNueva(t);
  anotarAprobacion(casa, 'ses-coord', { herramienta: { pid: 777, inicio: INICIO } });
  assert.strictEqual(pedirSinVentana(casa, PERDIDA).decision, 'deny');
});

// --- Windows: sólo el click o el «aprobado», sólo por la consola Bash ------------------------------------------------
// Líneas inventadas con la forma medida en una máquina (extensión 2.1.289, Git Bash): tres niveles de bash con el mismo texto
// entre el guion y la herramienta. La lectura de verdad se mide en la CI de Windows (scripts/tests/windows/waiver-probe.js).
// 🔴 Falla con: una firma por la ventana o por delegación en Windows, una imitación por otra consola que firma, un click
// gastado en un comando que el guion no puede comprobar.
const W_INICIO = (min) => `2026-10-27T1${min < 60 ? '0' : '1'}:${String(min % 60).padStart(2, '0')}:00.0000000Z`;
const W_GIT = 'C:\\Program Files\\Git';
const W_BIN = `${W_GIT}\\bin\\bash.exe`;
const W_USR = `${W_GIT}\\bin\\..\\usr\\bin\\bash.exe`;
const W_CLAUDE = 'C:\\Users\\dev\\.vscode\\extensions\\anthropic.claude-code-win32-x64\\resources\\native-binary\\claude.exe';
const W_TOOL = { pid: 100, ppid: 40, inicio: W_INICIO(0), ejecutable: W_CLAUDE, comando: `${W_CLAUDE} --output-format stream-json --verbose` };
const W_VSCODE = { pid: 40, ppid: 30, inicio: '2026-10-27T09:00:00.0000000Z', ejecutable: 'C:\\Code\\Code.exe', comando: '"C:\\Code\\Code.exe" --type=utility' };
const msysDe = (casa) => String(casa).replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/');
// el texto de `-c` con las reglas de Windows: la comilla con barra, y las barras antes de ella o del cierre, dobles
const citarWin = (s) => `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
function guionWin(casa, cmd, { temp = `${casa}\\AppData\\Local\\Temp`, cwd = `${msysDe(casa)}/AppData/Local/Temp/claude-0ab1-cwd` } = {}) {
  return `source ${msysDe(casa)}/.claude/shell-snapshots/snapshot-bash-1793-ab12.sh 2>/dev/null || true && export TEMP='${temp}' TMP='${temp}'`
    + " && shopt -u extglob 2>/dev/null || true && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true"
    + ` && eval '${cmd.replace(/'/g, `'"'"'`)}' < /dev/null && pwd -P >| ${cwd}`;
}
const lineaWin = (programa, texto) => `"${programa}" -c ${citarWin(texto)}`;
/** El árbol del guion: `niveles` son los procesos de la consola, de arriba hacia abajo, y el último es el padre del guion. */
function arbolGuionWin(casa, cmd, { texto = guionWin(casa, cmd), niveles, tool = W_TOOL, guion = {}, extra = [] } = {}) {
  const lista = niveles || [[W_BIN, texto], [W_USR, texto], [W_USR, texto]];
  const procesos = lista.map(([programa, t], k) => ({ pid: 300 + k, ppid: k ? 299 + k : tool.pid, inicio: W_INICIO(5 + k), ejecutable: programa, comando: lineaWin(programa, t) }));
  return [W_VSCODE, tool, ...procesos, { pid: 400, ppid: 299 + lista.length, inicio: W_INICIO(10), ejecutable: 'C:\\Program Files\\nodejs\\node.exe', comando: `"C:\\Program Files\\nodejs\\node.exe" ${cmd}`, ...guion }, ...extra];
}
const arbolFrenoWin = ({ tool = W_TOOL, extra = [] } = {}) => [W_VSCODE, tool,
  { pid: 200, ppid: tool.pid, inicio: W_INICIO(5), ejecutable: W_BIN, comando: `"${W_BIN}" -c "bash /c/h/safety-guard-pre.sh"` },
  { pid: 201, ppid: 200, inicio: W_INICIO(6), ejecutable: W_USR, comando: `"${W_USR}" -c "bash /c/h/safety-guard-pre.sh"` },
  { pid: 202, ppid: 201, inicio: W_INICIO(7), ejecutable: 'C:\\Program Files\\nodejs\\node.exe', comando: '"C:\\Program Files\\nodejs\\node.exe" /c/h/owner-window.js gate' }, ...extra];
const W_APROBADA = { id: 'a1', sesion: 'ses-a', tipo: 'click' };
const conClick = (usos = []) => ({ buscar: () => ({ ok: true, aprobacion: W_APROBADA, via: 'click' }), consumir: (c, a) => { usos.push(a.id); return { ok: true }; }, devolver: () => {}, coordinadoraConfirmada: () => null });
const sinClick = { buscar: () => ({ ok: false, motivo: 'no hay un click en el cuadro ni un «aprobado» tuyo de los últimos 30 minutos sin usar' }), consumir: () => assert.fail('no se gasta'), devolver: () => {}, coordinadoraConfirmada: () => null };
const CON_GIT = () => ({ path: W_BIN });
const SIN_GIT = () => ({ path: null, reason: 'no está' });
const pedirWin = (casa, cmd, o = {}) => ow.decidir({ plataforma: 'win32', evento: evento(cmd, o.evento), escapes: o.escapes || [], arbol: o.arbol || arbolFrenoWin(), pid: 202, casa, ahora: AHORA,
  delegacion: o.delegacion || (() => assert.fail('en Windows no se consulta la delegación')), clasificar: () => null, comprobar: o.comprobar || (() => null), aprobador: DEL_ARNES, aprobaciones: o.aprobaciones || sinClick, gitBash: o.gitBash || CON_GIT });
const verificarWin = (casa, firma, argv, arbol, o = {}) => ow.verificar({ plataforma: 'win32', firma, argv, pid: 400, arbol, casa, ahora: AHORA + 1000, gitBash: CON_GIT, ...o });
const W_ADHOC = `node ${MARKER} adhoc set '{"reason":"subir el tope ñandú","maxFiles":3}' --for-session ses-a`;
const W_ADHOC_ARGV = [MARKER, 'adhoc', 'set', '{"reason":"subir el tope ñandú","maxFiles":3}', '--for-session', 'ses-a'];

test('Windows_Palabras_ConLasReglasDeWindows', () => {
  assert.deepStrictEqual(ow.palabrasDeWindows('"C:\\Program Files\\a.exe" -c "x \\"y\\" z"'), ['C:\\Program Files\\a.exe', '-c', 'x "y" z']);
  assert.deepStrictEqual(ow.palabrasDeWindows('a\\b c\\\\d'), ['a\\b', 'c\\\\d'], 'una barra que no va antes de una comilla queda como está');
  assert.deepStrictEqual(ow.palabrasDeWindows('"a\\\\" b'), ['a\\', 'b'], 'dos barras antes de la comilla: una barra, y la comilla cierra');
  assert.deepStrictEqual(ow.palabrasDeWindows('"a\\\\\\"b"'), ['a\\"b'], 'tres barras: una barra y una comilla');
  assert.strictEqual(ow.palabrasDeWindows('"sin cerrar'), null);
  assert.strictEqual(ow.palabrasDeWindows('"a""b"'), null, 'dos comillas seguidas: cada programa las lee a su modo');
});

test('Windows_Desenvolver_SoloLaFormaMedida', () => {
  const casa = 'C:\\Users\\dev';
  const cmd = `node "C:/h/marker.js" adhoc set '{"reason":"motivo"}' --for-session abc`;
  assert.strictEqual(ow.desenvolverWindows(lineaWin(W_USR, guionWin(casa, cmd)), casa), cmd);
  assert.strictEqual(ow.desenvolverWindows(lineaWin(W_BIN, guionWin(casa, cmd)), casa), cmd);
  const noVale = {
    'otra casa': lineaWin(W_USR, guionWin('C:\\Users\\otro', cmd)),
    'otra carpeta temporal': lineaWin(W_USR, guionWin(casa, cmd, { temp: 'C:\\Temp' })),
    'el archivo temporal en otro lado': lineaWin(W_USR, guionWin(casa, cmd, { cwd: '/tmp/claude-0ab1-cwd' })),
    'otro bash': lineaWin('C:\\msys64\\usr\\bin\\bash.exe', guionWin(casa, cmd)),
    'el bash de Windows': lineaWin('C:\\Windows\\System32\\bash.exe', guionWin(casa, cmd)),
    'una consola de la Mac': `/bin/zsh -c source ${casa}/.claude/shell-snapshots/snapshot-zsh-1-a.sh 2>/dev/null || true && eval 'x' < /dev/null && pwd -P >| /tmp/claude-ab12-cwd`,
    'sin -c': `"${W_USR}" ${citarWin(guionWin(casa, cmd))}`,
    'una palabra de más': `${lineaWin(W_USR, guionWin(casa, cmd))} otra`,
    'algo después de la envoltura': lineaWin(W_USR, `${guionWin(casa, cmd)}; node marker.js`),
    'una comilla suelta adentro': lineaWin(W_USR, guionWin(casa, 'x').replace("eval 'x'", "eval 'x'y'")),
    'comillas sin cerrar': `"${W_USR}" -c "source`,
  };
  for (const [que, linea] of Object.entries(noVale)) assert.strictEqual(ow.desenvolverWindows(linea, casa), null, que);
  // la forma de Windows no vale en la Mac
  assert.strictEqual(ow.desenvolver(lineaWin(W_USR, guionWin(casa, cmd)), casa), null);
});

// La línea real de la consola, medida en una máquina Windows, con la casa y el comando puestos por la prueba. Trae dos
// bloques que borran nombres de atajos; cuántos trae depende de la máquina.
const lineaMedida = (casa, cmd) => String.raw`source <msys>/.claude/shell-snapshots/snapshot-bash-1793640180323-vwupfx.sh 2>/dev/null || true && export TEMP='<casa>\AppData\Local\Temp' TMP='<casa>\AppData\Local\Temp' && shopt -u extglob 2>/dev/null || true && { \builtin unalias -- 'which'; \builtin unset -f -- 'which'; } >/dev/null 2>&1 || true && { \builtin unalias -- 'unsetenv'; \builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval '<cmd>' < /dev/null && pwd -P >| <msys>/AppData/Local/Temp/claude-e33b-cwd`
  .split('<msys>').join(msysDe(casa)).split('<casa>').join(casa).split('<cmd>').join(cmd.replace(/'/g, `'"'"'`));

// 🔴 Falla con: la forma que acepta un solo bloque, que en esa máquina deja la firma sin reconocer a su consola.
test('Windows_LineaMedidaCon2Bloques_Firma', (t) => {
  const casa = casaNueva(t);
  const r = pedirWin(casa, W_ADHOC, { aprobaciones: conClick() });
  assert.strictEqual(r.decision, 'allow', r.texto);
  const v = verificarWin(casa, 'adhoc-lane', W_ADHOC_ARGV, arbolGuionWin(casa, W_ADHOC, { texto: lineaMedida(casa, W_ADHOC) }));
  assert.ok(v.ok, v.motivo);
  assert.strictEqual(v.registro.via, 'click');
  const dev = 'C:\\Users\\dev';
  assert.strictEqual(ow.desenvolverWindows(lineaWin(W_USR, lineaMedida(dev, W_ADHOC)), dev), W_ADHOC);
});

// 🔴 Falla con: una forma que acepta cualquier cosa entre los bloques: la consola correría otro comando que el aprobado.
test('Windows_LineaMedida_OtroTextoEntreLosBloques_NoSeReconoce', () => {
  const dev = 'C:\\Users\\dev';
  const buena = lineaMedida(dev, W_ADHOC);
  const bloque = String.raw`{ \builtin unalias -- 'which'; \builtin unset -f -- 'which'; } >/dev/null 2>&1 || true && `;
  const noVale = {
    'un comando antes de un bloque': buena.replace(bloque, `otro.exe && ${bloque}`),
    'otro comando adentro del bloque': buena.replace(String.raw`\builtin unset -f -- 'which';`, 'otro.exe;'),
    'un bloque sin su cierre': buena.replace(bloque, String.raw`{ \builtin unalias -- 'which'; } && `),
    'un nombre que no es un nombre': buena.replace(String.raw`-- 'which'; \builtin unset`, String.raw`-- 'a b'; \builtin unset`),
  };
  for (const [que, texto] of Object.entries(noVale)) assert.strictEqual(ow.desenvolverWindows(lineaWin(W_USR, texto), dev), null, que);
  // sin bloques, con uno o con muchos, el comando que se firma es el mismo
  const otro = String.raw`{ \builtin unalias -- 'unsetenv'; \builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && `;
  for (const texto of [buena.replace(bloque, '').replace(otro, ''), buena.replace(bloque, ''), buena.replace(bloque, bloque.repeat(5))]) {
    assert.strictEqual(ow.desenvolverWindows(lineaWin(W_USR, texto), dev), W_ADHOC);
  }
  // en la Mac, el mismo tope
  const mac = (bloques) => `/bin/zsh -c source /Users/dev/.claude/shell-snapshots/snapshot-zsh-1-a.sh 2>/dev/null || true && ${bloques}eval 'x' < /dev/null && pwd -P >| /tmp/claude-ab12-cwd`;
  assert.strictEqual(ow.desenvolver(mac(bloque + bloque), '/Users/dev'), 'x');
  assert.strictEqual(ow.desenvolver(mac(`otro.exe && ${bloque}`), '/Users/dev'), null);
});

// 🔴 Falla con: pasar el tope del camino corto saliendo en Windows por otro camino que el de una firma común.
test('Windows_SobreCupo_ConElClick_Firma_SinElClick_NiegaConSuCuadro @story-8.181 @ac-4', (t) => {
  const pedido = '{"reason":"subir el tope ñandú","maxFiles":9}';
  const cmd = `node ${MARKER} adhoc set '${pedido}' --for-session ses-a`;
  const sin = pedirWin(casaNueva(t), cmd, { evento: DE_LA_PROPIA });
  assert.strictEqual(sin.decision, 'deny', sin.texto);
  assert.deepStrictEqual(sin.firmas, [SOBRE_CUPO]);
  assert.ok(sin.cuadro && sin.cuadro.soloClick && sin.texto.includes(sin.cuadro.pregunta), 'trae el cuadro entero');
  assert.match(sin.texto, /Un mensaje escrito no vale/);
  assert.match(sin.texto, /--terminal/, 'ofrece la terminal');
  const casa = casaNueva(t);
  const r = pedirWin(casa, cmd, { evento: DE_LA_PROPIA, aprobaciones: conClick() });
  assert.deepStrictEqual([r.decision, r.via], ['allow', 'click'], r.texto);
  const v = verificarWin(casa, SOBRE_CUPO, [MARKER, 'adhoc', 'set', pedido, '--for-session', 'ses-a'], arbolGuionWin(casa, cmd, { texto: lineaMedida(casa, cmd) }));
  assert.ok(v.ok, v.motivo);
  assert.strictEqual(v.registro.via, 'click');
});

test('Windows_SinAprobacion_NiegaConElCuadroYLaTerminal_NuncaLaVentana', (t) => {
  const casa = casaNueva(t);
  for (const modo of ['default', 'acceptEdits', 'plan', 'bypassPermissions']) {
    const r = pedirWin(casa, W_ADHOC, { evento: { permission_mode: modo } });
    assert.strictEqual(r.decision, 'deny', `${modo}: ni ventana ni hecho y avisado`);
    assert.match(r.texto, /en Windows la ventana de permiso no firma/);
    assert.ok(r.cuadro && r.texto.includes(r.cuadro.pregunta), 'da el cuadro');
    assert.match(r.texto, /adhoc set --reason "<motivo>" \[--max-files N\] --data sin-cambio --file <ruta> --terminal --for-session <id>/, 'y el comando de la terminal');
  }
  assert.strictEqual(vigentes(casa).length, 0, 'no queda un pedido escrito');
});

test('Windows_ConClick_ElPedidoSeEscribeDespues_YElGuionLoConsume', (t) => {
  const casa = casaNueva(t);
  const usos = [];
  const r = pedirWin(casa, W_ADHOC, { aprobaciones: conClick(usos) });
  assert.strictEqual(r.decision, 'allow', r.texto);
  assert.strictEqual(r.via, 'click');
  assert.deepStrictEqual(usos, ['a1'], 'la aprobación se gasta una vez');
  const [archivo] = vigentes(casa);
  const reg = JSON.parse(fs.readFileSync(path.join(ow.carpeta(casa), archivo), 'utf8'));
  assert.strictEqual(reg.via, 'click');
  const v = verificarWin(casa, 'adhoc-lane', W_ADHOC_ARGV, arbolGuionWin(casa, W_ADHOC));
  assert.ok(v.ok, v.motivo);
  assert.strictEqual(v.registro.via, 'click');
  assert.strictEqual(vigentes(casa).length, 0, 'consumido');
  assert.ok(!verificarWin(casa, 'adhoc-lane', W_ADHOC_ARGV, arbolGuionWin(casa, W_ADHOC)).ok, 'una sola vez');
});

test('Windows_PorPowerShell_NiegaSinGastarLaAprobacion', (t) => {
  const casa = casaNueva(t);
  const nunca = { buscar: () => assert.fail('no se mira'), consumir: () => assert.fail('no se gasta'), devolver: () => {}, coordinadoraConfirmada: () => null };
  const r = pedirWin(casa, W_ADHOC, { evento: { tool_name: 'PowerShell' }, aprobaciones: nunca });
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.texto, /consola Bash de la herramienta, o con --terminal/);
  assert.strictEqual(vigentes(casa).length, 0);
});

test('Windows_SinGitBash_DiceComoSeguir', (t) => {
  const casa = casaNueva(t);
  const nunca = { buscar: () => assert.fail('no se mira'), consumir: () => assert.fail('no se gasta'), devolver: () => {}, coordinadoraConfirmada: () => null };
  const r = pedirWin(casa, W_ADHOC, { evento: { tool_name: 'PowerShell' }, aprobaciones: nunca, gitBash: SIN_GIT });
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.texto, /instalá Git para Windows/);
  assert.match(r.texto, /ventana nueva de tres palabras/);
  assert.doesNotMatch(r.texto, /corré la firma por la consola Bash/, 'sin Git no hay consola Bash a la que mandarlo');
  // sin Git, el guion lanzado por PowerShell tampoco firma, y dice lo mismo
  const ps = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  const arbol = [W_VSCODE, W_TOOL, { pid: 300, ppid: 100, inicio: W_INICIO(5), ejecutable: ps, comando: `"${ps}" -Command x` },
    { pid: 400, ppid: 300, inicio: W_INICIO(10), ejecutable: 'C:\\node.exe', comando: `C:\\node.exe ${W_ADHOC}` }];
  const v = verificarWin(casa, 'adhoc-lane', W_ADHOC_ARGV, arbol, { gitBash: SIN_GIT });
  assert.ok(!v.ok);
  assert.match(v.motivo, /instalá Git para Windows/);
  assert.doesNotMatch(verificarWin(casa, 'adhoc-lane', W_ADHOC_ARGV, arbol).motivo, /instalá Git para Windows/);
});

test('Windows_ConsolaViva_Frena_YUnServidorMcpNo', (t) => {
  const casa = casaNueva(t);
  const psCmd = 'C:\\WINDOWS\\System32\\cmd.exe /d /s /c ""C:\\WINDOWS\\System32\\chcp.com" 65001 >nul & "C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command "$__claudeCodeScript = $env:CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT; Invoke-Expression -Command $__claudeCodeScript""';
  const vivas = {
    'Bash de fondo': { ejecutable: W_BIN, comando: lineaWin(W_BIN, guionWin(casa, 'sleep 100')) },
    'Bash de otra forma': { ejecutable: W_BIN, comando: `"${W_BIN}" -c "source /c/x/.claude/shell-snapshots/snapshot-bash-1-a.sh && sleep 100"` },
    'PowerShell medida': { ejecutable: 'C:\\WINDOWS\\System32\\cmd.exe', comando: psCmd },
    'PowerShell con otra variable': { ejecutable: 'C:\\WINDOWS\\System32\\cmd.exe', comando: 'C:\\WINDOWS\\System32\\cmd.exe /d /s /c "pwsh.exe -Command x"' },
    'PowerShell directa': { ejecutable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', comando: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command x' },
  };
  for (const [que, p] of Object.entries(vivas)) {
    const r = pedirWin(casa, W_ADHOC, { arbol: arbolFrenoWin({ extra: [{ pid: 500, ppid: 100, inicio: W_INICIO(8), ...p }] }), aprobaciones: conClick() });
    assert.strictEqual(r.decision, 'deny', que);
    assert.match(r.texto, /consola de fondo viva/, que);
  }
  const mcp = { pid: 500, ppid: 100, inicio: W_INICIO(8), ejecutable: 'C:\\WINDOWS\\System32\\cmd.exe', comando: 'C:\\WINDOWS\\System32\\cmd.exe /c npx -y servidor-mcp' };
  assert.strictEqual(pedirWin(casa, W_ADHOC, { arbol: arbolFrenoWin({ extra: [mcp] }), aprobaciones: conClick() }).decision, 'allow', 'un servidor MCP no es una consola');
});

test('Windows_Herramienta_SinPantalla_OLanzadaPorUnaConsola_Niega', (t) => {
  const casa = casaNueva(t);
  const sinPantalla = { ...W_TOOL, comando: `${W_CLAUDE} -p hola` };
  assert.match(pedirWin(casa, W_ADHOC, { arbol: arbolFrenoWin({ tool: sinPantalla }), aprobaciones: conClick() }).texto, /no tiene pantalla/);
  const ps = { pid: 40, ppid: 30, inicio: '2026-10-27T09:00:00.0000000Z', ejecutable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', comando: '"pwsh.exe" -Command "$__claudeCodeScript = 1"' };
  const r = pedirWin(casa, W_ADHOC, { arbol: arbolFrenoWin().map((p) => (p.pid === 40 ? ps : p)), aprobaciones: conClick() });
  assert.match(r.texto, /la lanzó otra herramienta o su consola/);
});

test('Windows_UnEscapeYUnGuionDeConsola_VanALaTerminal', (t) => {
  const casa = casaNueva(t);
  const escape = pedirWin(casa, 'TYCON_SAFETY_OFF=1 ls', { escapes: ['escape:TYCON_SAFETY_OFF'], aprobaciones: conClick() });
  assert.strictEqual(escape.decision, 'deny');
  assert.match(escape.texto, /en Windows un escape no se aprueba en la pestaña/);
  const sh = pedirWin(casa, `bash ${CONTROLES} approve`, { aprobaciones: conClick() });
  assert.strictEqual(sh.decision, 'deny');
  assert.match(sh.texto, /en Windows un guion de consola no se puede comprobar en la pestaña/);
  assert.strictEqual(vigentes(casa).length, 0);
});

test('Windows_Verificar_NoAceptaUnaImitacion', (t) => {
  const casa = casaNueva(t);
  assert.strictEqual(pedirWin(casa, W_ADHOC, { aprobaciones: conClick() }).decision, 'allow');
  const texto = guionWin(casa, W_ADHOC);
  const otroTexto = guionWin(casa, `${W_ADHOC} --terminal`);
  const PS = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  const imitaciones = {
    'otro texto en un nivel': { niveles: [[W_BIN, otroTexto], [W_USR, texto], [W_USR, texto]] },
    'otro texto en el nivel de abajo': { niveles: [[W_BIN, texto], [W_USR, texto], [W_USR, otroTexto]] },
    'un nivel de menos': { niveles: [[W_USR, texto], [W_USR, texto]] },
    'un nivel de más': { niveles: [[W_BIN, texto], [W_BIN, texto], [W_USR, texto], [W_USR, texto]] },
    'los niveles al revés': { niveles: [[W_USR, texto], [W_USR, texto], [W_BIN, texto]] },
    'otra carpeta de Git': { niveles: [['D:\\Git\\bin\\bash.exe', texto], [W_USR, texto], [W_USR, texto]] },
    'otro programa': { niveles: [['C:\\tmp\\bash.exe', texto], [W_USR, texto], [W_USR, texto]] },
    'otra casa': { texto: guionWin('C:\\Users\\otro', W_ADHOC) },
    'la herramienta no está arriba': { tool: { ...W_TOOL, ejecutable: PS, comando: `"${PS}" -NoProfile` } },
  };
  for (const [que, o] of Object.entries(imitaciones)) {
    const v = verificarWin(casa, 'adhoc-lane', W_ADHOC_ARGV, arbolGuionWin(casa, W_ADHOC, o));
    assert.ok(!v.ok, que);
  }
  // el ejecutable de un nivel no es el que dice su línea
  const mentira = arbolGuionWin(casa, W_ADHOC).map((p) => (p.pid === 301 ? { ...p, ejecutable: 'C:\\tmp\\falso.exe' } : p));
  assert.ok(!verificarWin(casa, 'adhoc-lane', W_ADHOC_ARGV, mentira).ok, 'el ejecutable');
  // la consola PowerShell: su línea no dice qué comando corre
  const porPs = [W_VSCODE, W_TOOL, { pid: 300, ppid: 100, inicio: W_INICIO(5), ejecutable: PS, comando: `"${PS}" -NoProfile -Command "$__claudeCodeScript = $env:CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT"` },
    { pid: 400, ppid: 300, inicio: W_INICIO(10), ejecutable: 'C:\\node.exe', comando: `C:\\node.exe ${W_ADHOC}` }];
  assert.ok(!verificarWin(casa, 'adhoc-lane', W_ADHOC_ARGV, porPs).ok, 'PowerShell');
  // otros argumentos que los del comando
  assert.ok(!verificarWin(casa, 'adhoc-lane', [MARKER, 'adhoc', 'set', '{"reason":"otro motivo cualquiera"}', '--for-session', 'ses-a'], arbolGuionWin(casa, W_ADHOC)).ok, 'los argumentos');
  // nada de lo anterior gastó el pedido: el de verdad sigue sirviendo
  assert.ok(verificarWin(casa, 'adhoc-lane', W_ADHOC_ARGV, arbolGuionWin(casa, W_ADHOC)).ok);
});

test('Windows_UnPadreQueArrancoDespues_NoEsElPadre', (t) => {
  const casa = casaNueva(t);
  assert.strictEqual(pedirWin(casa, W_ADHOC, { aprobaciones: conClick() }).decision, 'allow');
  // la consola arrancó después que el guion: tiene el número de su padre muerto, y nada más
  const reusado = arbolGuionWin(casa, W_ADHOC).map((p) => (p.pid === 302 ? { ...p, inicio: W_INICIO(30) } : p));
  assert.ok(!verificarWin(casa, 'adhoc-lane', W_ADHOC_ARGV, reusado).ok, 'un nivel');
  const herramientaNueva = arbolGuionWin(casa, W_ADHOC).map((p) => (p.pid === 100 ? { ...p, inicio: W_INICIO(30) } : p));
  assert.ok(!verificarWin(casa, 'adhoc-lane', W_ADHOC_ARGV, herramientaNueva).ok, 'la herramienta');
  const sinHora = arbolGuionWin(casa, W_ADHOC).map((p) => (p.pid === 301 ? { ...p, inicio: '' } : p));
  assert.ok(!verificarWin(casa, 'adhoc-lane', W_ADHOC_ARGV, sinHora).ok, 'sin la hora no se sabe');
  // el freno tampoco encuentra la herramienta por ese camino
  const frenoReusado = arbolFrenoWin().map((p) => (p.pid === 100 ? { ...p, inicio: W_INICIO(30) } : p));
  assert.match(pedirWin(casa, W_ADHOC, { arbol: frenoReusado, aprobaciones: conClick() }).texto, /no encontré el proceso de la herramienta/);
  assert.ok(verificarWin(casa, 'adhoc-lane', W_ADHOC_ARGV, arbolGuionWin(casa, W_ADHOC)).ok, 'con los horarios en orden, sí');
  const igual = ow.conPadresValidos([{ pid: 1, ppid: 0, inicio: W_INICIO(0) }, { pid: 2, ppid: 1, inicio: W_INICIO(0) }]);
  assert.strictEqual(igual[1].ppid, 1, 'a la misma hora puede ser: el reloj de Windows no llega a separarlos');
});

test('Windows_UnPedidoDeLaVentana_NoFirma', (t) => {
  // el pedido sin aprobación es el que dejaría la ventana: escrito antes de que la persona conteste
  const casa = casaNueva(t);
  assert.strictEqual(ow.decidir({ plataforma: 'darwin', evento: evento(W_ADHOC), arbol: arbolDelFreno(), pid: 201, casa, ahora: AHORA, delegacion: SIN_DELEGACION, clasificar: () => null, comprobar: () => null, aprobador: DEL_ARNES }).decision, 'ask');
  const [archivo] = vigentes(casa);
  const reg = JSON.parse(fs.readFileSync(path.join(ow.carpeta(casa), archivo), 'utf8'));
  assert.strictEqual(reg.via, undefined);
  const herramienta = { pid: W_TOOL.pid, inicio: W_TOOL.inicio };
  fs.writeFileSync(path.join(ow.carpeta(casa), archivo), JSON.stringify({ ...reg, herramienta }));
  assert.ok(!verificarWin(casa, 'adhoc-lane', W_ADHOC_ARGV, arbolGuionWin(casa, W_ADHOC)).ok);
  // con la vía de una aprobación, ese mismo pedido sí
  fs.writeFileSync(path.join(ow.carpeta(casa), archivo), JSON.stringify({ ...reg, herramienta, via: 'mensaje' }));
  assert.ok(verificarWin(casa, 'adhoc-lane', W_ADHOC_ARGV, arbolGuionWin(casa, W_ADHOC)).ok);
});

test('Windows_LasRutasQueCambiaGitBash_CuentanComoLaMisma', (t) => {
  const casa = casaNueva(t);
  const cmd = `node /c/h/scripts/marker.js adhoc set '{"reason":"motivo largo del arreglo"}' --for-session ses-a`;
  const argv = ['C:\\h\\scripts\\marker.js', 'adhoc', 'set', '{"reason":"motivo largo del arreglo"}', '--for-session', 'ses-a'];
  assert.strictEqual(pedirWin(casa, cmd, { aprobaciones: conClick() }).decision, 'allow');
  assert.ok(!verificarWin(casa, 'adhoc-lane', ['C:\\otra\\marker.js', ...argv.slice(1)], arbolGuionWin(casa, cmd)).ok, 'otro guion');
  assert.ok(verificarWin(casa, 'adhoc-lane', argv, arbolGuionWin(casa, cmd)).ok);
  // el piso de Node relanza el guion: su padre es el mismo guion, y la consola está arriba de él
  assert.strictEqual(pedirWin(casa, cmd, { aprobaciones: conClick() }).decision, 'allow');
  const nodo = 'C:\\Program Files\\nodejs\\node.exe';
  const hijo = { pid: 401, ppid: 400, inicio: W_INICIO(11), ejecutable: nodo, comando: `"${nodo}" C:\\h\\scripts\\marker.js adhoc set "{\\"reason\\":\\"motivo largo del arreglo\\"}" --for-session ses-a` };
  const padre = { comando: `"${nodo}" /c/h/scripts/marker.js adhoc set "{\\"reason\\":\\"motivo largo del arreglo\\"}" --for-session ses-a` };
  assert.ok(verificarWin(casa, 'adhoc-lane', argv, arbolGuionWin(casa, cmd, { guion: padre, extra: [hijo] }), { pid: 401 }).ok, 'relanzado');
});

test('Windows_LeerLosProcesos_RutaFijaSinModulosYSinTocarLaEmergencia', () => {
  let visto = null;
  const salida = JSON.stringify([
    { pid: 10, ppid: 0, inicio: W_INICIO(0), ejecutable: W_CLAUDE, comando: 'claude.exe ñandú' },
    { pid: 11, ppid: 10, inicio: W_INICIO(1), ejecutable: null, comando: null },
    { pid: 12, ppid: 99, inicio: W_INICIO(1), comando: 'padre muerto' },
    { pid: 'x', ppid: 1, comando: 'no se entiende' },
  ]);
  const previo = process.env.PSModulePath;
  process.env.PSModulePath = 'C:\\agente\\modulos';
  process.env.COR_PROFILER = '{agente}';
  let a;
  try { a = ow.leerArbolWindows({ spawnSync: (cmd, args, o) => { visto = { cmd, args, o }; return { status: 0, stdout: `\uFEFF${salida}` }; } }); } finally {
    if (previo === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = previo;
    delete process.env.COR_PROFILER;
  }
  assert.strictEqual(visto.cmd, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.ok(visto.args.includes('-NoProfile'));
  assert.strictEqual(visto.o.env.PSModulePath, undefined, 'de dónde se carga la consulta no lo decide el ambiente');
  assert.strictEqual(visto.o.env.COR_PROFILER, undefined, 'ni qué código carga .NET en el proceso');
  assert.strictEqual(a.length, 3);
  assert.strictEqual(a[0].comando, 'claude.exe ñandú');
  assert.strictEqual(a[0].ejecutable, W_CLAUDE);
  assert.strictEqual(a[1].ejecutable, undefined);
  assert.strictEqual(a[2].ppid, 99, 'un padre que ya no está sigue diciendo su número');
  for (const r of [{ status: 1, stdout: salida }, { status: 0, stdout: '' }, { status: 0, stdout: 'no es json' }, { error: new Error('x') }, null]) {
    assert.strictEqual(ow.leerArbolWindows({ spawnSync: () => r }), null, JSON.stringify(r));
  }
  assert.strictEqual(ow.leerArbolWindows({ spawnSync: () => { throw new Error('x'); } }), null);
  assert.strictEqual(ow.leerArbol({ plataforma: 'win32', spawnSync: () => assert.fail('no lee') }), null, 'la lectura de la emergencia queda como estaba');
});

test('Windows_FueraDeWindows_LaFormaDeWindowsNoFirma', (t) => {
  const casa = casaNueva(t);
  assert.strictEqual(pedirWin(casa, W_ADHOC, { aprobaciones: conClick() }).decision, 'allow');
  const v = ow.verificar({ plataforma: 'darwin', firma: 'adhoc-lane', argv: W_ADHOC_ARGV, pid: 400, arbol: arbolGuionWin(casa, W_ADHOC), casa, ahora: AHORA + 1000 });
  assert.ok(!v.ok);
});

// --- la lista de firmas: lo que el freno anota al negar con su cuadro (signature-list.js) ------------------------------

const sl = require('../lib/signature-list.js');
const { appendSignature } = require('../lib/signature-log.js');
const ARBOL_DE_FONDO = [...BASE,
  { pid: 50, ppid: 1, inicio: INICIO, ejecutable: '/u/node_modules/@anthropic-ai/claude-code/bin/claude.exe', comando: '/u/node_modules/@anthropic-ai/claude-code/bin/claude.exe daemon run --origin transient' },
  { pid: 60, ppid: 50, inicio: INICIO, ejecutable: 'claude bg-pty-host', comando: 'claude bg-pty-host --bg-pty-host /tmp/x.pty.sock 200 50 -- /u/claude' },
  { pid: 100, ppid: 60, inicio: INICIO, ejecutable: 'claude bg-spare', comando: 'claude bg-spare --bg-spare /tmp/x.claim.sock' },
  { pid: 200, ppid: 100, inicio: INICIO, comando: '/bin/bash /h/scripts/hooks/safety-guard-pre.sh' },
  { pid: 201, ppid: 200, inicio: INICIO, comando: 'node /h/scripts/lib/owner-window.js gate' }];
const MANUAL_T = `node ${MARKER} mark-tested --acs 3`;
const SKIP_T = `node ${MARKER} sign-adversarial-skip --story s --reason porque`;
const AVISAN = /Cuando te avisen, repetí el mismo comando/;

/** Una casa con la llave encendida, ses-a viva y, según se pida, la coordinadora designada y viva. */
function casaDeLista(t, { llave = 'on', coord = 'viva', confirmada = true } = {}) {
  const casa = coord ? casaConDesignada(t, { confirmada }) : casaNueva(t);
  fs.mkdirSync(path.join(casa, '.claude', 'sessions'), { recursive: true });
  if (llave) fs.writeFileSync(path.join(casa, '.claude', 'tycon.json'), JSON.stringify({ approvals: { signature_list: llave } }));
  const sesion = (sid, pid = process.pid) => fs.writeFileSync(path.join(casa, '.claude', 'sessions', `${sid}.json`), JSON.stringify({ pid, sessionId: sid, name: sid, status: 'idle', cwd: '/r' }));
  sesion('ses-a');
  if (coord === 'viva') sesion('ses-coord');
  if (coord === 'muerta') sesion('ses-coord', 999999);
  return casa;
}
const SIN_PERFIL = (casa) => { const a = path.join(casa, 'arnes-vacio'); fs.mkdirSync(a, { recursive: true }); return { arnes: a, env: {} }; };
const pedirConLista = (casa, cmd, o = {}) => ow.decidir({ evento: evento(cmd, o.evento), escapes: o.escapes || [], arbol: o.arbol || ARBOL_DE_FONDO, pid: 201, casa, ahora: o.ahora || AHORA,
  delegacion: o.delegacion || SIN_DELEGACION, clasificar: () => null, comprobar: o.comprobar || (() => null), aprobador: DEL_ARNES, aprobaciones: o.aprobaciones, lista: SIN_PERFIL(casa) });
const renglones = (casa) => { try { return JSON.parse(fs.readFileSync(sl.archivo(casa), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };

test('Freno_NiegaConCuadro_DejaUnRenglon (T1) — @story-8.153 @ac-1', (t) => {
  // sesión de fondo, sin coordinadora: renglón con sus campos y el título del catálogo; el texto, el de hoy
  let casa = casaDeLista(t, { coord: null });
  let r = pedirConLista(casa, MANUAL_T, { evento: { cwd: '/r/proyecto' } });
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.texto, /AskUserQuestion/);
  assert.doesNotMatch(r.texto, AVISAN);
  const [f] = renglones(casa);
  assert.strictEqual(f.tipo, 'firma');
  assert.strictEqual(f.firma, 'manual-test');
  assert.strictEqual(f.sesion, 'ses-a');
  assert.strictEqual(f.destino, 'ses-a');
  assert.strictEqual(f.comando, MANUAL_T);
  assert.strictEqual(f.cwd, '/r/proyecto');
  assert.strictEqual(f.at, AHORA);
  assert.strictEqual(f.title, 'marcar un criterio como probado a mano');
  assert.ok(f.id);

  // pestaña sin permisos: también
  casa = casaDeLista(t, { coord: null });
  r = pedirConLista(casa, MANUAL_T, { arbol: arbolDelFreno(), evento: { permission_mode: 'bypassPermissions' } });
  assert.strictEqual(r.decision, 'deny');
  assert.strictEqual(renglones(casa).length, 1);

  // el mismo dos veces: uno solo. Con el anterior ya firmado y todavía en el archivo: uno nuevo
  casa = casaDeLista(t, { coord: null });
  pedirConLista(casa, MANUAL_T);
  pedirConLista(casa, MANUAL_T, { ahora: AHORA + 60000 });
  assert.strictEqual(renglones(casa).length, 1, 'el mismo pedido no suma otro');
  // el mismo con --for-session propio tampoco: no cuenta para la clave
  pedirConLista(casa, `${MANUAL_T} --for-session ses-a`, { ahora: AHORA + 90000 });
  assert.strictEqual(renglones(casa).length, 1, '--for-session no cuenta para la clave');
  const primero = renglones(casa)[0].id;
  appendSignature({ signature: 'manual-test', via: 'click', target: 'ses-a', home: casa, now: AHORA + 120000, huella: () => ({ huella: 'h' }) });
  pedirConLista(casa, MANUAL_T, { ahora: AHORA + 180000 });
  assert.strictEqual(renglones(casa).length, 1);
  assert.notStrictEqual(renglones(casa)[0].id, primero, 'uno cerrado no se traga el pedido nuevo');

  // de fondo con coordinadora viva y renglón, con otherSession `yes` y con otro: frase nueva, sin pedir el cuadro ni el mensaje
  for (const cmd of [MANUAL_T, SKIP_T]) {
    casa = casaDeLista(t);
    r = pedirConLista(casa, cmd);
    assert.strictEqual(r.decision, 'deny');
    assert.match(r.texto, AVISAN, cmd);
    assert.doesNotMatch(r.texto, /AskUserQuestion|pasale el texto|contesta «aprobado»/, cmd);
    assert.match(r.texto, /terminal/, 'queda la forma por terminal');
    assert.strictEqual(renglones(casa).length, 1, cmd);
    // la repetición, con el renglón ya abierto: la misma frase y un solo renglón
    r = pedirConLista(casa, cmd, { ahora: AHORA + 60000 });
    assert.match(r.texto, AVISAN, `${cmd}, repetido`);
    assert.strictEqual(renglones(casa).length, 1, `${cmd}, repetido`);
  }

  // la propia coordinadora de fondo: el texto de hoy
  casa = casaDeLista(t);
  r = pedirConLista(casa, MANUAL_T, { evento: DE_LA_COORD });
  assert.match(r.texto, /AskUserQuestion/);
  assert.doesNotMatch(r.texto, AVISAN);

  // cerrada, sin confirmar, o sin dato de si vive: el texto de hoy, y el renglón igual
  const hoy = (c) => { const x = pedirConLista(c, MANUAL_T); assert.match(x.texto, /AskUserQuestion/); assert.doesNotMatch(x.texto, AVISAN); assert.strictEqual(renglones(c).length, 1); };
  hoy(casaDeLista(t, { coord: 'muerta' }));
  hoy(casaDeLista(t, { confirmada: false }));
  casa = casaDeLista(t);
  fs.rmSync(path.join(casa, '.claude', 'sessions'), { recursive: true });
  hoy(casa);
});

test('Freno_LoQueNoEntra (T2) — @story-8.153 @ac-2', (t) => {
  const nada = (casa, r) => { assert.strictEqual(renglones(casa).length, 0, r.texto); assert.doesNotMatch(r.texto, AVISAN); };
  // el destino distinto de la sesión del evento: lo corre otra sesión, ya frente a la persona
  let casa = casaDeLista(t);
  nada(casa, pedirConLista(casa, `${MANUAL_T} --for-session ses-b`));
  // lo delegado y lo «hecho y avisado» pasan sin la persona
  casa = casaDeLista(t);
  const delegada = pedirConLista(casa, MANUAL_T, { delegacion: () => ({ ok: true, maquina: 'm' }) });
  assert.strictEqual(delegada.decision, 'allow');
  nada(casa, delegada);
  casa = casaDeLista(t);
  const avisada = pedirConLista(casa, `node ${MARKER} approve-save`, { arbol: arbolDelFreno(), evento: { permission_mode: 'bypassPermissions' } });
  assert.strictEqual(avisada.via, 'avisado');
  nada(casa, avisada);
  // la ventana abierta se contesta en su pestaña
  casa = casaDeLista(t);
  const ventana = pedirConLista(casa, MANUAL_T, { arbol: arbolDelFreno() });
  assert.strictEqual(ventana.decision, 'ask');
  nada(casa, ventana);
  // sin la forma exacta, `designation-confirm`, un escape, lo irreversible y Codex
  casa = casaDeLista(t);
  nada(casa, pedirConLista(casa, `cd /r && ${MANUAL_T}`));
  casa = casaDeLista(t);
  nada(casa, pedirConLista(casa, `node ${path.join(RAIZ, 'scripts', 'lib', 'delegated-signing.js')} confirm-designation`));
  casa = casaDeLista(t);
  nada(casa, pedirConLista(casa, 'DOD_BYPASS=1 git commit -m x', { escapes: ['escape:DOD_BYPASS'] }));
  casa = casaDeLista(t);
  nada(casa, pedirConLista(casa, 'TYCON_SAFETY_OFF=1 rm x', { escapes: ['escape:TYCON_SAFETY_OFF'] }));
  casa = casaDeLista(t);
  nada(casa, pedirConLista(casa, MANUAL_T, { evento: { turn_id: 't1' } }));
  // una sesión que pasa --for-session con su propio id sí lo deja
  casa = casaDeLista(t);
  const propio = pedirConLista(casa, `${MANUAL_T} --for-session ses-a`);
  assert.match(propio.texto, AVISAN);
  assert.strictEqual(renglones(casa).length, 1);
});

// una sesión de fondo retomada (`claude --resume` debajo de `claude.exe --bg-pty-host`), como la leyó `ps` en la Mac
const EXE = '/u/claude.exe';
const pr = (pid, ppid, comando, ejecutable) => ({ pid, ppid, inicio: INICIO, comando, ...(ejecutable ? { ejecutable } : {}) });
const RETOMADA = [...BASE, pr(50, 1, `${EXE} daemon run`, EXE), pr(60, 50, `${EXE} --bg-pty-host /tmp/a.sock 120 30 -- ${EXE} --resume /h/a`, EXE),
  pr(100, 60, `${EXE} --resume /h/a.jsonl -n Enzo`, EXE)];
const FRENO = (pid, padre = 100) => [pr(pid, padre, '/bin/bash /h/scripts/hooks/safety-guard-pre.sh'), pr(pid + 1, pid, 'node /h/scripts/lib/owner-window.js gate')];

test('Freno_SesionDeFondoRetomada_LaVueltaExtraVaALaListaYValeConElClick', (t) => {
  const extra = `node ${PIPELINE} smart-reloop --iter 3 --extra-round`;
  const pide = (casa, arbol, pid = 201, o = {}) => ow.decidir({ evento: evento(extra), arbol, pid, casa, ahora: AHORA, delegacion: SIN_DELEGACION, clasificar: () => null, comprobar: () => null, aprobador: DEL_ARNES, aprobaciones: o.aprobaciones || aprobacionesDePrueba(), lista: SIN_PERFIL(casa) });
  // sin click: no va a la terminal por «otra herramienta»; queda en la lista del dueño
  let casa = casaDeLista(t);
  const sin = pide(casa, [...RETOMADA, ...FRENO(200)]);
  assert.strictEqual(sin.decision, 'deny');
  assert.match(sin.texto, /corre de fondo/);
  assert.match(sin.texto, AVISAN);
  assert.strictEqual(renglones(casa)[0].firma, 'extra-round');
  // con el click de la persona, pasa
  casa = casaDeLista(t);
  anotarAprobacion(casa, 'ses-a', { tipo: 'click', tool_use_id: 'toolu_9' });
  const con = pide(casa, [...RETOMADA, ...FRENO(200)]);
  assert.deepStrictEqual([con.decision, con.via], ['allow', 'click'], con.texto);
  // sigue siendo «otra herramienta»: un claude abierto por su consola, una terminal virtual falsa colgando de esa
  // consola, y una herramienta común con `claude --bg-pty-host` en un argumento
  const consola = pr(300, 100, envolver(casa, 'claude'));
  for (const arbol of [[...RETOMADA, consola, pr(310, 300, `${EXE} --permission-mode default`, EXE), ...FRENO(320, 310)],
    [...RETOMADA, consola, pr(305, 300, `${EXE} --bg-pty-host /tmp/f.sock -- ${EXE}`, EXE), pr(310, 305, EXE, EXE), ...FRENO(320, 310)],
    [...BASE, pr(60, 1, '/A/claude --resume /h/p --add-dir /tmp/claude --bg-pty-host /tmp/x'), pr(100, 60, `${EXE} --resume /h/a`, EXE), ...FRENO(200)]]) {
    const pid = arbol[arbol.length - 1].pid;
    assert.match(pide(casa, arbol, pid).texto, /la lanzó otra herramienta/, JSON.stringify(arbol.slice(-3)));
  }
  // la ruta de Windows entre comillas, con espacios
  const W = 'C:\\Program Files\\Claude\\claude.exe';
  assert.ok(ow.esAnfitrionDeFondoDe(pr(1, 2, `"${W}" --resume a`, W), pr(3, 4, `"${W}" daemon run`, W), pr(2, 3, `"${W}" --bg-pty-host C:\\t.sock`, W)));
  // el gancho que anota el click también la reconoce: el click no se pierde
  const g = oaReal.lanzadoPorLaHerramienta({ arbol: [...RETOMADA, ...FRENO(400)], pid: 401, casa, plataforma: 'darwin' });
  assert.deepStrictEqual([g.ok, g.herramienta && g.herramienta.pid], [true, 100], g.motivo);
});

test('Freno_RegistroRoto_DecideIgual (T3) — @story-8.153 @ac-3', (t) => {
  const conLlaveApagada = pedirConLista(casaDeLista(t, { llave: 'off' }), MANUAL_T);
  // archivo roto: misma decisión y el texto de hoy, y el archivo no se pisa
  let casa = casaDeLista(t);
  fs.mkdirSync(path.dirname(sl.archivo(casa)), { recursive: true });
  fs.writeFileSync(sl.archivo(casa), '{ esto no es una lista');
  let r = pedirConLista(casa, MANUAL_T);
  assert.strictEqual(r.decision, conLlaveApagada.decision);
  assert.strictEqual(r.texto, conLlaveApagada.texto);
  assert.strictEqual(fs.readFileSync(sl.archivo(casa), 'utf8'), '{ esto no es una lista');
  // sin permiso de escritura: misma decisión y el texto de hoy
  if (process.platform !== 'win32' && !(process.getuid && process.getuid() === 0)) {
    casa = casaDeLista(t);
    const dir = path.dirname(sl.archivo(casa));
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o500);
    try { r = pedirConLista(casa, MANUAL_T); } finally { fs.chmodSync(dir, 0o700); }
    assert.strictEqual(r.decision, conLlaveApagada.decision);
    assert.strictEqual(r.texto, conLlaveApagada.texto);
  }
  // con la llave apagada el freno no anota ni cambia su texto
  casa = casaDeLista(t, { llave: 'off' });
  r = pedirConLista(casa, MANUAL_T);
  assert.strictEqual(fs.existsSync(sl.archivo(casa)), false);
  assert.match(r.texto, /AskUserQuestion/);
  casa = casaDeLista(t, { llave: null });
  pedirConLista(casa, MANUAL_T);
  assert.strictEqual(fs.existsSync(sl.archivo(casa)), false);
});

// --- de a una: la pregunta, el click en la coordinadora y la repetición ---------------------------------------------

/** El click de la coordinadora en su pestaña: su registro y su transcripción, como los dejan el gancho y Claude Code. */
function clickEnLaCoordinadora(casa, pregunta, { ts = AHORA - 60000, fuente = 'user_temporary' } = {}) {
  const dir = path.join(casa, '.claude', 'projects', '-r-coord');
  fs.mkdirSync(dir, { recursive: true });
  const cuando = new Date(ts).toISOString();
  const id = `toolu_${ts}`;
  const filas = [
    { type: 'assistant', timestamp: cuando, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ question: pregunta }] } }] } },
    { type: 'user', timestamp: cuando, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, permissionDecision: { decision: 'accept', source: fuente },
      toolUseResult: { questions: [{ question: pregunta, options: [{ label: 'Sí, aprobar' }, { label: 'No' }] }], answers: { [pregunta]: 'Sí, aprobar' } } }];
  fs.writeFileSync(path.join(dir, 'ses-coord.jsonl'), `${filas.map((x) => JSON.stringify(x)).join('\n')}\n`);
  // el proceso de la coordinadora es éste: vivo y con su archivo de sesión
  fs.rmSync(path.join(casa, '.claude', 'sessions', 'ses-coord.json'), { force: true });
  fs.writeFileSync(path.join(casa, '.claude', 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'ses-coord', name: 'Coordinadora', status: 'idle', cwd: '/r/coord' }));
  oaReal.anotar(casa, { tipo: 'click', sesion: 'ses-coord', ts: cuando, tool_use_id: id, pregunta, respuesta: 'Sí, aprobar', herramienta: { pid: process.pid, inicio: 'COORD' } });
}
const COORD_VIVA = { pid: process.pid, ppid: 1, inicio: 'COORD', comando: herramienta().comando };
const CON_COORD = [...ARBOL_DE_FONDO, COORD_VIVA];
// la confirmación contra la transcripción, sin mirar los ganchos de la máquina donde corre la prueba
const VALIDA = (casa) => (a, ctx) => oaReal.clickEnLaTranscripcion(oaReal.transcripcionDe(casa, a.sesion), a, { pregunta: ctx.cuadro.pregunta, opciones: ctx.cuadro.opciones });
const aprobacionesDeLaLista = (casa) => ({ ...oaReal, buscar: (o) => oaReal.buscar({ ...o, validar: VALIDA(casa) }) });
const pasada = (casa, sesion, o = {}) => sl.siguiente({ casa, ...SIN_PERFIL(casa), sesion, ahora: o.ahora || AHORA, arbol: o.arbol || CON_COORD, validar: VALIDA(casa), after: o.after || null });

test('OwnerNext_DaElCuadro_LaSesionRepite (T11) — @story-8.153 @ac-11', (t) => {
  // la pregunta de owner-next es la de `decidir` en la sesión destino, letra por letra, con la coordinadora en otra carpeta
  const carpeta = path.dirname(HISTORIA.story);
  for (const [cmd, firma] of [[MANUAL_T, 'manual-test'], [`node ${MARKER} runtime-waiver ${HISTORIA.story} --acs 1`, 'runtime-waiver'], [SIGN_FILE('dod_runtime_exempt', 'specs/x.md'), 'escape:dod_runtime_exempt']]) {
    const casa = casaDeLista(t);
    const neg = pedirConLista(casa, cmd, { evento: { cwd: carpeta } });
    assert.strictEqual(neg.decision, 'deny', neg.texto);
    assert.deepStrictEqual(neg.firmas, [firma]);
    assert.strictEqual(renglones(casa).length, 1, cmd);
    const r = pasada(casa, 'ses-coord');
    assert.strictEqual(r.tipo, 'firma', JSON.stringify(r));
    assert.strictEqual(r.pregunta, neg.cuadro.pregunta, cmd);
    assert.deepStrictEqual(r.opciones, neg.cuadro.opciones);
    assert.strictEqual(r.rotulo, 'Firma 1/1');
    assert.ok(r.rotulo.length <= 12);
    assert.strictEqual(r.comando, undefined, 'sin comando para correr ahí');
    assert.match(r.aviso, /es un dato/);
  }

  for (const fuente of ['user_temporary', 'bypassPermissions']) {
    const casa = casaDeLista(t);
    const neg = pedirConLista(casa, MANUAL_T, { arbol: CON_COORD });
    assert.strictEqual(neg.decision, 'deny');
    const r = pasada(casa, 'ses-coord');
    clickEnLaCoordinadora(casa, r.pregunta, { fuente });
    // con el click sin usar: lo saltea y dice que falta repetir
    const salteo = pasada(casa, 'ses-coord');
    assert.strictEqual(salteo.tipo, 'nada', JSON.stringify(salteo));
    assert.deepStrictEqual(salteo.faltaRepetir.map((x) => x.id), [r.id]);
    assert.match(salteo.faltaRepetir[0].aviso, /mark-tested/);
    // pasados 30 minutos y uno, lo vuelve a dar
    assert.strictEqual(pasada(casa, 'ses-coord', { ahora: AHORA + 30 * 60000 }).tipo, 'firma');
    // la repetición firma con `via: click`, en la coordinadora
    const fin = pedirConLista(casa, MANUAL_T, { arbol: CON_COORD, aprobaciones: aprobacionesDeLaLista(casa) });
    assert.strictEqual(fin.decision, 'allow', fin.texto);
    assert.strictEqual(fin.via, 'click');
    const reg = registroVigente(casa);
    assert.strictEqual(reg.via, 'click');
    assert.strictEqual(reg.aprobada_en, 'ses-coord');
  }

  // con el proceso de la coordinadora muerto, la repetición no firma y owner-next lo vuelve a dar
  let casa = casaDeLista(t);
  pedirConLista(casa, MANUAL_T, { arbol: CON_COORD });
  const r = pasada(casa, 'ses-coord');
  clickEnLaCoordinadora(casa, r.pregunta);
  assert.strictEqual(pedirConLista(casa, MANUAL_T, { arbol: ARBOL_DE_FONDO, aprobaciones: aprobacionesDeLaLista(casa) }).decision, 'deny');
  assert.strictEqual(pasada(casa, 'ses-coord', { arbol: ARBOL_DE_FONDO }).tipo, 'firma');

  // en otra sesión da sólo aquellos de los que es destino, y repite ella
  casa = casaDeLista(t, { coord: null });
  pedirConLista(casa, MANUAL_T);
  assert.strictEqual(pasada(casa, 'ses-b').tipo, 'nada');
  const propia = pasada(casa, 'ses-a');
  assert.strictEqual(propia.tipo, 'firma');
  assert.strictEqual(propia.destino, 'ses-a');
});

test('Aviso_SinCoordinadora_AprobadoAlCuadroYaMostrado (T10) — @story-8.153 @ac-10', (t) => {
  const casa = casaDeLista(t, { coord: null });
  const neg = pedirConLista(casa, MANUAL_T);
  const dir = path.join(casa, '.claude', 'projects', '-r');
  fs.mkdirSync(dir, { recursive: true });
  const cuando = new Date(AHORA - 60000).toISOString();
  fs.writeFileSync(path.join(dir, 'ses-a.jsonl'), `${[
    { type: 'assistant', timestamp: cuando, message: { role: 'assistant', content: [{ type: 'text', text: neg.cuadro.pregunta }] } },
    { type: 'user', timestamp: cuando, message: { role: 'user', content: 'aprobado' }, origin: { kind: 'human' }, promptSource: 'typed', entrypoint: 'cli' }].map((x) => JSON.stringify(x)).join('\n')}\n`);
  oaReal.anotar(casa, { tipo: 'mensaje', sesion: 'ses-a', ts: cuando, texto: 'aprobado', herramienta: { pid: 100, inicio: INICIO } });
  const valida = (a, ctx) => oaReal.mensajeEnLaTranscripcion(oaReal.transcripcionDe(casa, a.sesion), a, { sello: ctx.cuadro.sello, destino: ctx.destino, pregunta: ctx.cuadro.pregunta });
  // owner-next no pregunta de nuevo
  const r = sl.siguiente({ casa, ...SIN_PERFIL(casa), sesion: 'ses-a', ahora: AHORA, arbol: ARBOL_DE_FONDO, validar: valida });
  assert.strictEqual(r.tipo, 'nada');
  assert.strictEqual(r.faltaRepetir.length, 1);
  // y repetir el comando firma
  const fin = pedirConLista(casa, MANUAL_T, { aprobaciones: { ...oaReal, buscar: (o) => oaReal.buscar({ ...o, validar: valida }) } });
  assert.strictEqual(fin.decision, 'allow', fin.texto);
  assert.strictEqual(fin.via, 'mensaje');
});

test('OwnerNext_PlanAntesDelClick_LaRepeticionNoGastaElClick (T17) — @story-8.153 @ac-17', (t) => {
  const casa = casaDeLista(t);
  const cmd = `node ${MARKER} complete-step approve-plan --approved "aprobado"`;
  pedirConLista(casa, cmd, { arbol: CON_COORD });
  const r = pasada(casa, 'ses-coord');
  assert.strictEqual(r.tipo, 'firma');
  clickEnLaCoordinadora(casa, r.pregunta);
  // el control del plan niega en la sesión destino, antes de gastar el click
  const niega = pedirConLista(casa, cmd, { arbol: CON_COORD, aprobaciones: aprobacionesDeLaLista(casa), comprobar: () => ({ niega: 'el plan no está en lo que vio la persona' }) });
  assert.strictEqual(niega.decision, 'deny');
  assert.match(niega.texto, /el plan no está/);
  // el click sigue sin usar: tras escribirlo, firma con `via: click`
  const fin = pedirConLista(casa, cmd, { arbol: CON_COORD, aprobaciones: aprobacionesDeLaLista(casa) });
  assert.strictEqual(fin.decision, 'allow', fin.texto);
  assert.strictEqual(fin.via, 'click');
});

// --- nombrar a la coordinadora con un click --------------------------------------------------------------------------

const DESIGNA = `node ${MARKER} designate-relay`;
const RETIRA = `node ${MARKER} withdraw-relay`;

// 🔴 Falla con: el cuadro de confirmar una designación por click que dice «con la frase undefined».
test('OwnerWindowBoxDetail_ClickDesignation_SaysPorClick (T7)', (t) => {
  const casa = casaNueva(t);
  fs.appendFileSync(path.join(casa, '.claude', '.tycon-pipeline', 'gates.log'),
    `${JSON.stringify({ name: 'relay-designation', status: 'ok', ts: '2026-11-04T10:00:00.000Z', sesion: 'ses-a', rol: 'coordinadora', quien: 'el dueño', via: 'click' })}\n`);
  const cmd = 'node /h/scripts/lib/delegated-signing.js confirm-designation';
  const c = ow.cuadroPara({ firma: 'designation-confirm', comando: cmd, palabras: ow.canonica(cmd), destino: 'ses-a', sesion: 'ses-a', casa });
  assert.match(c.pregunta, /la sesión designada: «coordinadora» \(ses-a\), desde 2026-11-04T10:00:00\.000Z, por click/);
  assert.doesNotMatch(c.pregunta, /undefined|null/);
});

// 🔴 Falla con: un click en la pestaña de la coordinadora que nombra o retira a otra sesión.
test('DesignationFirmas_ClickInCoordinatorTab_DoesNotCount (T20)', (t) => {
  for (const [firma, cmd] of [['designation-set', DESIGNA], ['designation-withdraw', RETIRA]]) {
    const casa = casaNueva(t);
    const cuadro = ow.cuadroPara({ firma, comando: cmd, palabras: ow.canonica(cmd), destino: 'ses-a', sesion: 'ses-a', casa });
    assert.strictEqual(cuadro.soloClick, true, firma);
    require('../lib/owner-approvals.js').anotar(casa, { tipo: 'click', sesion: 'ses-coord', ts: new Date(AHORA - 60000).toISOString(), tool_use_id: 'toolu_9', pregunta: cuadro.pregunta, respuesta: cuadro.opciones[0] });
    const r = require('../lib/owner-approvals.js').buscar({ casa, sesion: 'ses-a', destino: 'ses-a', cuadro, coordinadora: 'ses-coord', ahora: AHORA, validar: () => ({ ok: true }) });
    assert.strictEqual(r.ok, false, `${firma}: ${JSON.stringify(r)}`);
  }
});

// 🔴 Falla con: un «aprobado» escrito, en la propia pestaña o en la de la coordinadora, que nombra o retira.
test('DesignationFirmas_WrittenApproval_OwnOrCoordinatorTab_DoesNotCount (T21)', (t) => {
  const oaLib = require('../lib/owner-approvals.js');
  for (const [firma, cmd] of [['designation-set', DESIGNA], ['designation-withdraw', RETIRA]]) {
    for (const donde of ['ses-a', 'ses-coord']) {
      const casa = casaNueva(t);
      const cuadro = ow.cuadroPara({ firma, comando: cmd, palabras: ow.canonica(cmd), destino: 'ses-a', sesion: 'ses-a', casa });
      oaLib.anotar(casa, { tipo: 'mensaje', sesion: donde, ts: new Date(AHORA - 60000).toISOString(), texto: 'aprobado' });
      const r = oaLib.buscar({ casa, sesion: 'ses-a', destino: 'ses-a', cuadro, coordinadora: 'ses-coord', ahora: AHORA, validar: () => ({ ok: true }) });
      assert.strictEqual(r.ok, false, `${firma} en ${donde}: ${JSON.stringify(r)}`);
    }
  }
});

// Calcular la matriz de una historia grande tarda segundos, y el freno tiene 20 s para todo: la calcula una sola vez por
// consulta, con o sin ventana, y el chequeo del guion (otro proceso, que la calcula otra vez) tiene un plazo propio menor.
test('OwnerWindow_RuntimeWaiver_LaMatrizSeCalculaUnaVezPorConsulta', (t) => {
  const { story } = historiaConCriterio(t);
  const rmx = require(path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'runtime-matrix.js'));
  const original = rmx.compute;
  let veces = 0;
  rmx.compute = (...a) => { veces += 1; return original.apply(rmx, a); };
  t.after(() => { rmx.compute = original; });
  for (const [extra, acs] of [[{}, ''], [{ permission_mode: 'bypassPermissions' }, ''], [{}, ' --acs 1'], [{ permission_mode: 'bypassPermissions' }, ' --acs 1']]) {
    veces = 0;
    const r = pedir(casaNueva(t), `node ${MARKER} runtime-waiver ${story}${acs}`, { evento: extra });
    assert.match(r.texto, /AC 1: .*el criterio: Given un pedido/, `${JSON.stringify(extra)}${acs}`);
    assert.strictEqual(veces, 1, `${JSON.stringify(extra)}${acs}: la matriz se calculó ${veces} veces`);
  }
  // la memoria es de una consulta: la misma historia, editada entre dos consultas con la misma casa, se vuelve a calcular
  // y el cuadro muestra lo que se va a firmar ahora, no lo de la consulta anterior
  const otra = historiaConCriterio(t);
  const casa = casaNueva(t);
  const cmd = `node ${MARKER} runtime-waiver ${otra.story}`;
  assert.match(pedir(casa, cmd).texto, /el aviso queda en el servicio externo\./);
  fs.writeFileSync(otra.story, fs.readFileSync(otra.story, 'utf8').replace('el aviso queda en el servicio externo', 'el pago queda en el banco'));
  veces = 0;
  const r = pedir(casa, cmd);
  assert.match(r.texto, /AC 1: .*el criterio: Given un pedido Then el pago queda en el banco\./, r.texto);
  assert.doesNotMatch(r.texto, /servicio externo\./);
  assert.strictEqual(veces, 1);
});

test('OwnerWindow_Prechequeo_PlazoPropioMenorQueElDelFreno', (t) => {
  const cp = require('child_process');
  const original = cp.spawnSync;
  const plazos = {};
  cp.spawnSync = (cmd, args, o) => { plazos[args[1]] = o.timeout; return { status: 2, stdout: '', stderr: 'no' }; };
  t.after(() => { cp.spawnSync = original; });
  ow.comprobarConElGuion({ firma: 'runtime-waiver', palabras: [MARKER, 'runtime-waiver', '/r/specs/story-9.99.md'], cwd: os.tmpdir(), sesion: 'ses-a' });
  ow.comprobarConElGuion({ firma: 'save', palabras: [MARKER, 'approve-save'], cwd: os.tmpdir(), sesion: 'ses-a' });
  cp.spawnSync = original;
  // el freno tiene 20 s para todo: el chequeo del guion espera menos, y el ok de guardar conserva el suyo
  assert.strictEqual(plazos['runtime-waiver'], ow.PLAZO_DEL_PRECHEQUEO_MS);
  assert.ok(ow.PLAZO_DEL_PRECHEQUEO_MS <= 12000, `el chequeo del guion espera ${ow.PLAZO_DEL_PRECHEQUEO_MS} ms`);
  assert.strictEqual(plazos['approve-save'], 240000);
});

// --- dejar pasar el freno de los datos: sólo el click del dueño -------------------------------------------------------
const DATOS = 'adhoc-lane:datos';
const pideDatos = (rec = 'pasar', resto = '') => `node ${MARKER} adhoc allow-data-change --changed "el botón pide al proceso" --recommends ${rec} --why "el proceso tiene su seguridad"${resto}`;
function conFrenoDeDatos(casa) {
  const adhoc = path.join(casa, '.claude', '.tycon-pipeline', 'adhoc');
  fs.mkdirSync(adhoc, { recursive: true });
  fs.writeFileSync(path.join(adhoc, 'ses-a.json'), JSON.stringify({ reason: 'el botón', maxFiles: 8, files: [], frenoDatos: { huella: 'h1', hallazgos: [{ id: 'proceso', strength: 'strong', says: 'una llamada a un proceso', file: 'src/a.tsx', line: 3, borrada: false, texto: 'executeQuery(x)' }] } }));
  return casa;
}

// 🔴 Falla con: el freno de los datos que se destraba por la delegación del perfil o por la ventana de permiso.
test('T27 OwnerWindow_ClickDelDueno_NoDelegaNiVentana @story-8.196 @ac-13', (t) => {
  assert.deepStrictEqual(ow.firmasDelComando(pideDatos()), [DATOS]);
  assert.deepStrictEqual(ow.firmasDelComando(pideDatos('historia')), [], 'recomendar la historia no firma');
  assert.deepStrictEqual(ow.firmasDelComando(pideDatos('descartar')), []);
  // por delegación: no se delega, aunque el perfil la nombre, y trae el cuadro
  const delegada = pedir(conFrenoDeDatos(casaNueva(t)), pideDatos(), { delegacion: () => ({ ok: true, maquina: 'm' }) });
  assert.strictEqual(delegada.decision, 'deny', delegada.texto);
  assert.ok(delegada.cuadro && delegada.cuadro.clickDelDueno, 'el cuadro del click del dueño');
  assert.match(delegada.texto, /sólo el click del dueño/);
  assert.match(delegada.cuadro.pregunta, /una llamada a un proceso, src\/a\.tsx:3/);
  // en una pestaña que pregunta: no abre la ventana
  const casa = conFrenoDeDatos(casaNueva(t));
  const ventana = pedir(casa, pideDatos());
  assert.strictEqual(ventana.decision, 'deny', ventana.texto);
  assert.strictEqual(registros(casa).length, 0, 'no queda un pedido para la ventana');
  // con el click del dueño, firma por click
  const conElClick = pedir(conFrenoDeDatos(casaNueva(t)), pideDatos(), { aprobaciones: conClick() });
  assert.deepStrictEqual([conElClick.decision, conElClick.via], ['allow', 'click'], conElClick.texto);
});

// 🔴 Falla con: el cuadro del click del dueño para un comando que marker.js rechaza después (sin freno anotado, un
// --why demasiado largo): el click se gasta y no destraba nada.
test('T27 OwnerWindow_DatosQueSeNegaria_NoDaElCuadro @story-8.196 @ac-13', (t) => {
  const casa = conFrenoDeDatos(casaNueva(t));
  let visto = null;
  const r = pedir(casa, pideDatos(), { comprobar: (o) => { visto = o; return { niega: 'no hay un freno de datos que destrabar' }; } });
  assert.strictEqual(r.decision, 'deny', r.texto);
  assert.match(r.texto, /ni te doy el cuadro.*no hay un freno de datos/);
  assert.ok(!r.cuadro, 'sin cuadro: el click se perdería');
  assert.strictEqual(visto && visto.firma, DATOS);
  // si el guion no se niega, el cuadro sale como siempre
  const sigue = pedir(conFrenoDeDatos(casaNueva(t)), pideDatos(), { comprobar: () => ({ ok: true }) });
  assert.ok(sigue.cuadro && sigue.cuadro.clickDelDueno, sigue.texto);
});

test('Freno_SoloClickDeFondo_NoDejaRenglon — @fix-T-207', (t) => {
  // de fondo nadie mira la pestaña donde vale ese click, y la coordinadora no lo puede dar: el renglón contaría sin cierre
  let casa = casaDeLista(t);
  const r = pedirConLista(casa, pedidoDe(9));
  assert.strictEqual(r.decision, 'deny');
  assert.deepStrictEqual(r.firmas, [SOBRE_CUPO]);
  assert.strictEqual(renglones(casa).length, 0, r.texto);
  assert.doesNotMatch(r.texto, AVISAN);
  assert.match(r.texto, /terminal/, 'queda la forma por terminal');
  // en una pestaña que trabaja a la vista, el renglón sigue: la sesión lo ve en su propia pestaña
  casa = casaDeLista(t);
  pedirConLista(casa, pedidoDe(9), { arbol: arbolDelFreno(), evento: { permission_mode: 'bypassPermissions' } });
  assert.strictEqual(renglones(casa).length, 1);
  assert.strictEqual(renglones(casa)[0].firma, SOBRE_CUPO);
  // lo de fondo que la coordinadora sí puede pasar, igual que siempre
  casa = casaDeLista(t);
  pedirConLista(casa, pedidoDe(8));
  assert.strictEqual(renglones(casa).length, 1);
});
