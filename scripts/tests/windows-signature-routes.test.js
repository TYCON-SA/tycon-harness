'use strict';
/**
 * windows-signature-routes.test.js — en Windows el arnés ofrece sólo la vía de firma que anda en esa consola (@story-8.319).
 *
 *   · el freno (`ofrecerEnWindows`, que lee `ow_negar` de safety-guard-pre.sh): desde la consola PowerShell no ofrece la
 *     ventana, el cuadro ni el «aprobado»; un escape o un guion `.sh` van sólo por la terminal; fuera de Windows, el texto
 *     de hoy. Qué pasa por la pestaña lo dice una sola función (`noPasaEnWindows`), que usa también `decidir`;
 *   · la lista de firmas del dueño: el renglón guarda la consola, y `owner-next` da la terminal en vez del cuadro cuando
 *     el cuadro no firmaría (pedido desde PowerShell, firma que no pasa por la pestaña, u `otherSession: 'no'`);
 *   · un comando de terminal que se pega tal cual: `node "<ruta estable>/marker.js" sign-file … "<archivo>"`, y sin forma
 *     de terminal con `$` o `%`; `adhoc set` con `--repo` y sin `cd /d … &&`, y el aviso de `adhoc test` al abrir;
 *   · un «aprobado» que la persona escribe mientras el agente trabaja (también por el control remoto) llega encolado y vale.
 *
 * T13 y T14 (npm en Windows) están en audit-dependencies.test.sh; T15 (las tres consolas de Windows) es la T13 de
 * lost-run-loop.test.js, que corre el trabajo windows de la CI. Cada prueba arma su casa con mkdtemp.
 *
 * Correr: node --test scripts/tests/windows-signature-routes.test.js < /dev/null
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..', '..');
const ow = require('../lib/owner-window.js');
const sl = require('../lib/signature-list.js');
const oa = require('../lib/owner-approvals.js');
const DS = require('../lib/delegated-signing.js');
const MARKER = path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'marker.js');
const RBC = path.join(RAIZ, 'scripts', 'ci', 'run-base-controls.sh');
const W_BIN = 'C:\\Program Files\\Git\\bin\\bash.exe';
const CON_GIT = () => ({ path: W_BIN });
const SIN_GIT = () => ({ path: null, reason: 'no está' });
const AHORA = Date.parse('2026-11-19T15:00:00.000Z');

const evento = (command, extra = {}) => ({ session_id: 'ses-a', tool_use_id: 'toolu_01', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...extra });
const PLAN = `node ${MARKER} complete-step approve-plan --approved "dale"`;
const ESCAPE = `node ${MARKER} sign-file ALLOW_DOD_EVIDENCE_WRITE /repo/.advisors/dod-runtime/9.9.md`;
// un escape que ningún guion comprueba (el de una variable): en Windows va sólo por la terminal
const ESCAPE_VAR = 'TYCON_TEST_GATE=1 ls';
const GUION_SH = `bash ${RBC} approve --root /repo --entries '[]'`;
const ofrece = (cmd, o = {}) => ow.ofrecerEnWindows({ evento: evento(cmd, o.evento), escapes: o.escapes || [], firmas: o.firmas, plataforma: o.plataforma || 'win32', gitBash: o.gitBash || CON_GIT });

// ── El freno ofrece sólo lo que anda (AC 1, 2) ──────────────────────────────────────────────────────────────────────

test('T1 Freno_WindowsPowerShell_SinCuadroNiAprobado @story-8.319 @ac-1', () => {
  const ps = { tool_name: 'PowerShell' };
  const plan = ofrece(PLAN, { evento: ps, firmas: ['plan-approval'] });
  const esc = ofrece(ESCAPE_VAR, { evento: ps, escapes: ['escape:TYCON_TEST_GATE'], firmas: ['escape:TYCON_TEST_GATE'] });
  const sh = ofrece(GUION_SH, { evento: ps, firmas: ['control-change'] });
  for (const [que, t] of [['plan', plan], ['escape', esc], ['.sh', sh]]) {
    assert.ok(t, `${que}: en Windows PowerShell hay texto`);
    assert.doesNotMatch(t, /cuadro|aprobado/i, `${que}: ${t}`);
    assert.match(t, /terminal/, que);
  }
  assert.match(plan, /consola Bash de Git/, 'la firma que pasa en Windows: por Bash de Git o la terminal');
  assert.doesNotMatch(esc, /consola Bash de Git/, 'un escape: sólo la terminal');
  assert.match(esc, /un escape no se aprueba en la pestaña/);
  assert.doesNotMatch(sh, /consola Bash de Git/, 'un .sh: sólo la terminal');
  assert.match(sh, /guion de consola no se puede comprobar en la pestaña/);
});

test('T2 Freno_WindowsSinGitBash_SoloTerminal @story-8.319 @ac-1', () => {
  const t = ofrece(PLAN, { evento: { tool_name: 'PowerShell' }, firmas: ['plan-approval'], gitBash: SIN_GIT });
  assert.match(t, /Va sólo en la terminal/);
  assert.ok(t.includes(ow.SIN_GIT_BASH || 'esta máquina no tiene Git Bash'), t);
  assert.doesNotMatch(t, /cuadro|aprobado/i);
});

test('T3 Freno_WindowsBashYOtras_SegunLaFirma @story-8.319 @ac-2', () => {
  // en win32 con Bash: la que pasa, el texto de hoy (vacío: ow_negar usa su texto fijo con cuadro); las otras dos, terminal
  assert.strictEqual(ofrece(PLAN, { firmas: ['plan-approval'] }), '');
  assert.match(ofrece(ESCAPE_VAR, { escapes: ['escape:TYCON_TEST_GATE'], firmas: ['escape:TYCON_TEST_GATE'] }), /va sólo en la terminal/);
  // un escape que comprueba su guion (aunque llegue como escape, fuera de su forma): como las firmas de guion
  assert.strictEqual(ofrece(ESCAPE, { escapes: ['escape:ALLOW_DOD_EVIDENCE_WRITE'], firmas: ['escape:ALLOW_DOD_EVIDENCE_WRITE'] }), '');
  assert.match(ofrece(GUION_SH, { firmas: ['control-change'] }), /va sólo en la terminal/);
  // en darwin y linux, el texto de hoy, letra por letra: ow_negar no recibe nada que lo cambie
  for (const plataforma of ['darwin', 'linux']) {
    for (const [cmd, o] of [[PLAN, {}], [ESCAPE_VAR, { escapes: ['escape:TYCON_TEST_GATE'] }], [GUION_SH, {}]]) {
      assert.strictEqual(ofrece(cmd, { ...o, plataforma, evento: { tool_name: 'PowerShell' } }), '', `${plataforma}: ${cmd}`);
    }
  }
  // una sola función: decidir y el texto del freno consultan noPasaEnWindows, y el motivo no está escrito en otro lado
  const fuente = fs.readFileSync(path.join(RAIZ, 'scripts', 'lib', 'owner-window.js'), 'utf8');
  const cuerpo = (nombre) => fuente.slice(fuente.indexOf(`function ${nombre}(`), fuente.indexOf('\n}\n', fuente.indexOf(`function ${nombre}(`)));
  assert.match(cuerpo('decidir'), /noPasaEnWindows\(/);
  assert.match(cuerpo('ofrecerEnWindows'), /noPasaEnWindows\(/);
  assert.strictEqual(fuente.split("'en Windows un escape no se aprueba en la pestaña'").length - 1, 1, 'el motivo vive en un solo lugar');
  // el texto fijo de ow_negar que nombra el cuadro lo reemplaza lo que ofrece la consola: cada uno va dentro de ${alt:-…}
  const sh = fs.readFileSync(path.join(RAIZ, 'scripts', 'hooks', 'safety-guard-pre.sh'), 'utf8');
  const negar = sh.slice(sh.indexOf('ow_negar() {'), sh.indexOf('\n}\n', sh.indexOf('ow_negar() {')));
  const conCuadro = negar.split('\n').filter((l) => /cuadro de opciones/.test(l));
  assert.ok(conCuadro.length >= 4, 'los textos fijos con el cuadro');
  for (const l of conCuadro) assert.match(l, /\$\{alt:-/, `fuera de \${alt:-…}: ${l.trim()}`);
  assert.match(sh, /ofrece=\*\) OW_OFRECE=/, 'el freno lee lo que ofrece la consola');
});

// ── La lista de firmas del dueño (AC 3-5) ────────────────────────────────────────────────────────────────────────────

function casaNueva(t) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-routes-'));
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
  const casa = path.join(raiz, 'casa');
  fs.mkdirSync(path.join(casa, '.claude', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(casa, '.claude', '.tycon-pipeline', 'active'), { recursive: true });
  fs.writeFileSync(path.join(casa, '.claude', 'tycon.json'), JSON.stringify({ approvals: { signature_list: 'on' } }));
  const arnes = path.join(raiz, 'arnes');
  fs.mkdirSync(arnes);
  return { casa, arnes, env: {}, raiz };
}
const estado = (casa) => path.join(casa, '.claude', '.tycon-pipeline');
function sesion(casa, sid) {
  fs.writeFileSync(path.join(casa, '.claude', 'sessions', `${sid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, name: sid, nameSource: 'user', status: 'idle', cwd: '/r' }));
}
function designar(casa, sid = 'ses-coord') {
  const d = { name: 'relay-designation', status: 'ok', ts: '2026-11-19T08:00:00.000Z', sesion: sid, rol: 'coordinadora', quien: 'dueño', cita: 'Esta sesión es la coordinadora' };
  fs.writeFileSync(path.join(estado(casa), 'gates.log'), `${[d, DS.confirmationRecord(d, '2026-11-19T08:01:00.000Z')].map((l) => JSON.stringify(l)).join('\n')}\n`);
}
const palabras = (cmd) => ow.canonica(cmd);
function renglon(toy, { firmaId = 'manual-test', ses = 'ses-a', comando = `node ${MARKER} mark-tested --acs 3`, titulo = 'marcar un criterio como probado a mano', ...marca } = {}) {
  return sl.anotarFirma({ casa: toy.casa, firma: firmaId, titulo, sesion: ses, destino: ses, comando, palabras: palabras(comando), cwd: '/r', ahora: AHORA - 600000, ...marca });
}
const pasar = (toy, o = {}) => sl.siguiente({ casa: toy.casa, arnes: toy.arnes, env: toy.env, ahora: AHORA, arbol: [], sesion: 'ses-coord', validar: () => ({ ok: false }), delegacion: () => ({ ok: false, motivo: 'no se delega' }), ...o });
// la coordinadora se confirma con el perfil del arnés: una copia propia con `relay_session`, como signature-list.test.js
const COPIA = require('./lib/harness-copy.js').harnessCopy();
fs.writeFileSync(path.join(COPIA, 'team-profile.json'), JSON.stringify({ approvals: { relay_session: 'coordinadora' } }));
const confirmadaSinClave = oa.coordinadoraConfirmada;
oa.coordinadoraConfirmada = (casa, o = {}) => confirmadaSinClave(casa, { arnes: COPIA, ...o });

test('T4 OwnerNext_RenglonSoloTerminal_DaLaTerminal @story-8.319 @ac-3', (t) => {
  const toy = casaNueva(t);
  designar(toy.casa);
  for (const s of ['ses-coord', 'ses-a', 'ses-b', 'ses-c', 'ses-d']) sesion(toy.casa, s);
  const MT = (n) => `node ${MARKER} mark-tested --acs ${n}`;
  renglon(toy, { ses: 'ses-a', comando: MT(3), consola: 'powershell' });
  renglon(toy, { ses: 'ses-b', comando: MT(4), windows: 'solo-terminal' });
  const vistos = [];
  let r = pasar(toy);
  for (let i = 0; i < 4 && r.tipo === 'via'; i++) { vistos.push(r); r = pasar(toy, { after: r.id }); }
  assert.strictEqual(vistos.length, 2, JSON.stringify(r));
  for (const v of vistos) {
    assert.strictEqual(v.pregunta, undefined, 'sin cuadro');
    assert.match(v.texto, /en Windows esta firma sólo se da en la terminal/);
    assert.ok(v.texto.includes(`--terminal --for-session ${v.destino}`), v.texto);
    assert.ok(v.texto.includes('mark-tested --acs'), 'sale de f.comando');
  }
  // sin comando, y con una firma sin forma de terminal: lo dicen y no dan comando
  const sinComando = sl.viaQueAnda({ id: 'f-x', firma: 'manual-test', destino: 'ses-c', comando: '', consola: 'powershell' }, { casa: toy.casa, sesion: 'ses-coord', nombre: 'ses-c' });
  assert.match(sinComando.texto, /no trae su comando: no hay comando/);
  // una firma sin forma de terminal (ausente o `pending`): lo dice y no da comando
  for (const terminal of [undefined, 'pending']) {
    const p = sl.enLaTerminalDeLaFila({ comando: MT(9), destino: 'ses-d' }, { id: 'x', terminal });
    assert.match(p, /todavía no tiene forma de terminal/);
    assert.doesNotMatch(p, /--for-session/);
  }
});

// `otherSession: 'no'` de otra sesión, sin delegar: sin cuadro, la pestaña destino y la terminal. La delegada sigue con
// su cuadro (owner-window.test.js T20)
test('T5 OwnerNext_OtraSesionNo_DaLaPestana @story-8.319 @ac-4', (t) => {
  const toy = casaNueva(t);
  designar(toy.casa);
  sesion(toy.casa, 'ses-coord');
  sesion(toy.casa, 'ses-a');
  const cmd = `node ${MARKER} sign-adversarial-skip --story s --reason porque`;
  renglon(toy, { firmaId: 'adversarial-skip', comando: cmd, titulo: 'saltear el pase adversarial con constancia' });
  const r = pasar(toy);
  assert.strictEqual(r.tipo, 'via', JSON.stringify(r));
  assert.strictEqual(r.pregunta, undefined, 'sin cuadro');
  assert.match(r.texto, /pestaña de ses-a/);
  assert.ok(r.texto.includes('--terminal --for-session ses-a'), r.texto);
});

test('T6 OwnerNext_DelegadaSigueDelegada @story-8.319 @ac-4', (t) => {
  const toy = casaNueva(t);
  // no con el plan: el de una historia delicada, o sin marcador que diga cuál, lo da una persona aunque el perfil lo
  // delegue (fila 127, delegation-routing.test.js)
  const v = sl.viaQueAnda({ id: 'f-d', firma: 'compare-waiver', destino: 'ses-a', comando: `node ${MARKER} compare-waiver --reason x` }, { casa: toy.casa, sesion: 'ses-coord', nombre: 'ses-a', coord: 'ses-coord', delegacion: () => ({ ok: true }) });
  assert.strictEqual(v.delegada, true, 'lo que el perfil delega sigue delegado');
});

test('T7 OwnerNext_RenglonViejo_CuadroDeHoy @story-8.319 @ac-5', (t) => {
  const toy = casaNueva(t);
  designar(toy.casa);
  sesion(toy.casa, 'ses-coord');
  sesion(toy.casa, 'ses-a');
  renglon(toy);
  const r = pasar(toy);
  assert.strictEqual(r.tipo, 'firma', JSON.stringify(r));
  assert.ok(r.pregunta, 'el cuadro de hoy');
});

test('T8 Renglon_GuardaLaConsola @story-8.319 @ac-3', (t) => {
  const toy = casaNueva(t);
  sesion(toy.casa, 'ses-a');
  const cmd = `node ${MARKER} mark-tested --acs 3`;
  const r = ow.decidir({ plataforma: 'win32', evento: evento(cmd, { tool_name: 'PowerShell' }), casa: toy.casa, ahora: AHORA, gitBash: CON_GIT, lista: { arnes: toy.arnes, env: toy.env } });
  assert.strictEqual(r.decision, 'deny');
  const filas = JSON.parse(fs.readFileSync(sl.archivo(toy.casa), 'utf8'));
  assert.strictEqual(filas.length, 1, JSON.stringify(filas));
  assert.strictEqual(filas[0].consola, 'powershell');
});

test('T8b Renglon_YaAbierto_RecibeLaMarca @story-8.319 @ac-3 — del pase adversarial', (t) => {
  const toy = casaNueva(t);
  sesion(toy.casa, 'ses-a');
  renglon(toy);
  renglon(toy, { consola: 'powershell' });
  const filas = JSON.parse(fs.readFileSync(sl.archivo(toy.casa), 'utf8'));
  assert.strictEqual(filas.length, 1);
  assert.strictEqual(filas[0].consola, 'powershell', 'el renglón abierto quedó marcado');
});

test('T9b SignFile_RutaDeRed_SinFormaDeTerminal @story-8.319 @ac-6 — del pase adversarial', () => {
  const r = ow.formasDeFirmar('ALLOW_DOD_EVIDENCE_WRITE', '\\\\servidor\\carpeta\\a.md', 'ses-a', { casa: '/Users/x' });
  assert.strictEqual(r.terminal, null, 'dos barras invertidas: bash las lee como una');
  assert.match(r.renglones[1], /dos barras invertidas/);
});

test('T4b OwnerNext_AdhocEnJson_LaTerminalVaPorBanderas @story-8.319 @ac-3 — del pase adversarial', () => {
  const cmd = `node ${MARKER} adhoc set '{"reason":"arreglar el texto del cartel","maxFiles":2,"datos":"sin-cambio","allowedFiles":["src/a.js"]}'`;
  const s = require('../lib/signatures.js').SIGNATURES.find((x) => x.id === 'adhoc-lane');
  const t = sl.enLaTerminalDeLaFila({ comando: cmd, destino: 'ses-a', cwd: '/r/repo' }, s);
  assert.match(t, /adhoc set --reason "arreglar el texto del cartel" --max-files 2 --data sin-cambio --file src\/a\.js --repo "\/r\/repo" --terminal --for-session ses-a/);
  assert.doesNotMatch(t, /'\{/, 'sin JSON entre comillas simples');
});

test('T11b AdhocSet_LaVentanaLeeElRepo @story-8.319 @ac-8 — del pase adversarial', () => {
  const palabras = [MARKER, 'adhoc', 'set', '{}', '--terminal', '--for-session', 'ses-a', '--repo', '/otro/repo'];
  assert.strictEqual(ow.carpetaDelPedido({ palabras, cwd: '/aca', sesion: 'ses-a' }), path.resolve('/otro/repo'));
  assert.strictEqual(ow.carpetaDelPedido({ palabras: palabras.slice(0, 7), cwd: '/aca', sesion: 'ses-a' }), '/aca');
});

// ── Un comando que se pega tal cual (AC 6-8, 10, 11) ────────────────────────────────────────────────────────────────

test('T9 SignFile_FormaDeLaTerminal_SePega @story-8.319 @ac-6', () => {
  const casa = '/Users/x y';
  const f = ow.formasDeFirmar('ALLOW_DOD_EVIDENCE_WRITE', '/repo/a b.md', 'ses-a', { casa });
  assert.strictEqual(f.terminal, `node "${casa}/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js" sign-file ALLOW_DOD_EVIDENCE_WRITE "/repo/a b.md" --terminal --for-session ses-a`);
  assert.doesNotMatch(f.terminal, /~|'/);
  const win = ow.formasDeFirmar('ALLOW_DOD_EVIDENCE_WRITE', 'C:\\repo\\a b.md', 'ses-a', { casa: 'C:\\Users\\x y' });
  assert.strictEqual(win.terminal, 'node "C:\\Users\\x y/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js" sign-file ALLOW_DOD_EVIDENCE_WRITE "C:\\repo\\a b.md" --terminal --for-session ses-a');
  for (const [archivo, home] of [['/repo/a$b.md', casa], ['/repo/a%b%.md', casa], ['/repo/a.md', 'C:\\Users\\x%y'], ['/repo/a.md', '/Users/$x']]) {
    const r = ow.formasDeFirmar('ALLOW_DOD_EVIDENCE_WRITE', archivo, 'ses-a', { casa: home });
    assert.strictEqual(r.terminal, null, `${archivo} / ${home}`);
    assert.match(r.renglones[1], /forma de la terminal no se puede/, `sin forma de la terminal: ${r.renglones[1]}`);
  }
  // signatureCommand no cita una carpeta con %
  const { signatureCommand } = require(path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'home-command.js'));
  assert.match(signatureCommand('x/marker.js', 'C:\\Users\\a%b'), /\$HOME/);
});

test('T10 SignFile_FormaDeLaVentana_EsCanonica @story-8.319 @ac-7', () => {
  for (const casa of ['/Users/x', 'C:\\Users\\x']) {
    const v = ow.comoSeFirma('ALLOW_DOD_EVIDENCE_WRITE', casa.startsWith('C:') ? 'C:\\repo\\a.md' : '/repo/a b.md', { casa });
    assert.match(v, /^node "/);
    const can = ow.canonica(v);
    assert.ok(can, `canonica la acepta: ${v}`);
    assert.strictEqual(can[1], 'sign-file');
    assert.deepStrictEqual([...ow.firmasDelComando(v)], ['escape:ALLOW_DOD_EVIDENCE_WRITE']);
  }
});

function repoDeJuguete(t) {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'windows-adhoc-')));
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
  const casa = path.join(raiz, 'casa');
  const repo = path.join(raiz, 'repo');
  const otro = path.join(raiz, 'otro');
  for (const d of [path.join(casa, '.claude'), path.join(repo, 'src'), otro]) fs.mkdirSync(d, { recursive: true });
  for (const r of [repo, otro]) spawnSync('git', ['init', '-q', '-b', 'main', r]);
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), '1\n');
  const env = (extra = {}) => {
    const e = { ...process.env };
    for (const k of Object.keys(e)) if (/^TYCON_|^CODEX_SESSION_ID$|^CLAUDE_CODE_SESSION_ID$/.test(k)) delete e[k];
    return { ...e, HOME: casa, USERPROFILE: casa, TYCON_HOME: '', ...extra };
  };
  const marker = (args, { cwd = repo, extra } = {}) => spawnSync(process.execPath, [MARKER, ...args], { cwd, env: env(extra), encoding: 'utf8', input: '' });
  return { raiz, casa, repo, otro, marker };
}

test('T11 AdhocSet_Windows_SinCdNiAnd @story-8.319 @ac-8', (t) => {
  const J = repoDeJuguete(t);
  // la forma impresa sin aprobación: sin cd ni &&, con --repo (el guion la arma igual en todas las plataformas)
  const r = J.marker(['adhoc', 'set', JSON.stringify({ reason: 'arreglar el texto del cartel', maxFiles: 1, datos: 'sin-cambio', allowedFiles: ['src/a.js'] })], { extra: { CLAUDE_CODE_SESSION_ID: 'ses-w' } });
  assert.notStrictEqual(r.status, 0, r.stdout);
  const linea = r.stderr.split('\n').find((l) => /adhoc set .*--terminal --for-session ses-w/.test(l));
  assert.ok(linea, r.stderr);
  assert.doesNotMatch(linea, /cd \/d|&&|^\s*cd /);
  assert.ok(linea.includes(`--repo "${J.repo}"`), linea);
  assert.match(linea, /node "[^"]*\/\.claude\/agent-skills\/skills\/tycon-pipeline\/scripts\/marker\.js" adhoc set/);
  // desde otra carpeta y desde otro repo, con --repo: declara el carril con la lista del repo pedido
  const pedido = ['adhoc', 'set', '--reason', 'arreglar el texto del cartel', '--data', 'sin-cambio', '--file', 'src/a.js', '--repo', J.repo, '--terminal', '--for-session', 'ses-w'];
  for (const cwd of [J.raiz, J.otro]) {
    const d = J.marker(pedido, { cwd, extra: { TYCON_TERMINAL_TEST: '1' } });
    // sin una terminal de verdad la firma no se da: lo que importa es que la lista se leyó en el repo pedido
    assert.doesNotMatch(d.stderr, /no cae en ningún repo|no es una carpeta/, `${cwd}: ${d.stderr}`);
  }
  // sin --repo, con --for-session de una sesión sin carpeta conocida: frena y pide --repo; nunca ancla la lista en la
  // carpeta de la terminal
  const sin = J.marker(pedido.filter((w, i, a) => w !== '--repo' && a[i - 1] !== '--repo'), { cwd: J.raiz });
  assert.strictEqual(sin.status, 2, sin.stderr);
  assert.match(sin.stderr, /no sé la carpeta de la sesión ses-w: .*--repo <carpeta>/);
  assert.doesNotMatch(sin.stderr, /la lista \(/);
  // --repo que no es una carpeta
  const malo = J.marker([...pedido.slice(0, 8), '--repo', path.join(J.raiz, 'no-existe'), '--terminal', '--for-session', 'ses-w'], { cwd: J.raiz });
  assert.match(malo.stderr, /no es una carpeta/);
});

test('T12 AdhocSet_AvisaLasPruebasPorErrores @story-8.319 @ac-10 @ac-11', (t) => {
  // el aviso sale por la salida de errores y la salida normal sigue siendo el JSON: se mira en la fuente, porque declarar de
  // verdad necesita la firma de una persona
  const fuente = require(path.join(path.dirname(MARKER), 'tests', 'lib', 'marker-source.js'))(path.dirname(MARKER));
  const j = fuente.indexOf('console.error(`Si este camino corto cambia código, guardar pide una corrida en verde: ');
  assert.ok(j > 0, 'el aviso está');
  const antes = fuente.slice(Math.max(0, j - 300), j);
  assert.match(antes, /process\.stdout\.write\(JSON\.stringify\(obj, null, 2\) \+ '\\n'\);\s*\n\s*\/\/[^\n]*\n\s*$/, 'va justo después del JSON, por la salida de errores');
  const linea = fuente.slice(j, fuente.indexOf('\n', j));
  assert.ok(linea.includes("markerEstable(os.homedir())} adhoc test -- <el comando de las pruebas>. Si cambiás código después, se vence.`);"), linea);
  void t;
});

// ── El «aprobado» encolado (el defecto que sumó la coordinadora) ────────────────────────────────────────────────────

test('T19 Aprobado_Encolado_VaPorLaPersona @story-8.319', () => {
  // lo que la persona escribe mientras el agente trabaja (también desde el celular) llega `cli · queued`, con origen humano
  assert.ok(oa.TIPEADO.cli.includes('queued'));
  assert.ok(oa.TIPEADO.cli.includes('typed'));
  assert.ok(!oa.TIPEADO.cli.includes('system'), 'lo de otra sesión llega como system y origen peer: no');
});

// ── Las guías (AC 16) y la no-regresión (AC 15) ─────────────────────────────────────────────────────────────────────

test('T16 Guias_DicenLaViaDeWindows @story-8.319 @ac-16', () => {
  for (const g of ['firmas-del-arnes.md', 'safety-guard.md']) {
    const t = fs.readFileSync(path.join(RAIZ, 'guides', g), 'utf8');
    assert.match(t, /consola Bash de Git/, g);
    assert.match(t, /consola PowerShell/, g);
    assert.match(t, /--terminal --for-session/, g);
  }
});

test('T16b Guias_ElEscapeQueComprobaSuGuion_ConElClickEnSuFormaExacta', () => {
  // 🔴 Falla con: que el paso 6 o el SKILL digan sólo «lo decide la persona» (el agente pregunta, la persona aprueba y en
  //    Windows la mandan a la terminal), o que las guías digan que en Windows todo escape va sólo por la terminal.
  const leer = (...r) => fs.readFileSync(path.join(RAIZ, ...r), 'utf8').replace(/\s+/g, ' ');
  const paso6 = leer('skills', 'tycon-pipeline', 'steps', 'step-06-run-tests.md');
  const skill = leer('skills', 'tycon-pipeline', 'SKILL.md');
  assert.match(paso6, /--force-manual/);
  assert.match(paso6, /click o el «aprobado»/);
  assert.match(paso6, /también en Windows/);
  assert.match(paso6, /solo y en su forma exacta/);
  // el SKILL no tiene lugar para la regla entera: dice quién la firma y manda al paso 6
  assert.match(skill, /`--force-manual` lo firma la persona \(paso 6\)/);
  for (const g of ['firmas-del-arnes.md', 'safety-guard.md']) {
    const t = leer('guides', g);
    assert.doesNotMatch(t, /En Windows, además, un escape se firma siempre ahí/, g);
    assert.match(t, /escape que ningún guion comprueba/, g);
    assert.match(t, /set-check --force-manual/, g);
  }
});

test('T17 Decidir_NoCambia @story-8.319 @ac-15', () => {
  // los veredictos de decidir sobre Windows los fija owner-window.test.js; acá, que los motivos de siempre siguen
  assert.strictEqual(ow.noPasaEnWindows({ escapes: ['escape:x'] }), 'en Windows un escape no se aprueba en la pestaña');
  assert.strictEqual(ow.noPasaEnWindows({ escapes: ['escape:TYCON_TEST_GATE'] }), 'en Windows un escape no se aprueba en la pestaña');
  assert.strictEqual(ow.noPasaEnWindows({ escapes: ['escape:cerrar-la-ejecucion'] }), 'en Windows un escape no se aprueba en la pestaña');
  // un escape que comprueba su guion pasa como las firmas de guion; con otro que no, no
  assert.strictEqual(ow.noPasaEnWindows({ escapes: ['escape:force-manual'] }), null);
  assert.strictEqual(ow.noPasaEnWindows({ escapes: ['escape:force-manual', 'escape:TYCON_TEST_GATE'] }), 'en Windows un escape no se aprueba en la pestaña');
  assert.strictEqual(ow.noPasaEnWindows({ palabras: [RBC, 'approve'] }), 'en Windows un guion de consola no se puede comprobar en la pestaña');
  assert.strictEqual(ow.noPasaEnWindows({ palabras: [MARKER, 'mark-tested'] }), null);
  // los veredictos de decidir los corre su suite (owner-window.test.js, en la lista de suites): acá, el de Windows
  // PowerShell, con el motivo de siempre
  const r = ow.decidir({ plataforma: 'win32', evento: evento(`node ${MARKER} mark-tested --acs 3`, { tool_name: 'PowerShell' }), casa: fs.mkdtempSync(path.join(os.tmpdir(), 'ow-casa-')), ahora: AHORA, gitBash: CON_GIT });
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.texto, /la línea de la consola PowerShell no dice qué comando corre/);
});

test('T1c Freno_SignFile_ClickComoEnMac_TerminalDeEmergencia @story-8.319 @ac-1 @ac-2', () => {
  // La firma por archivo en Windows va por click, como en Mac, y la terminal queda de emergencia. El freno la ve así: el
  // escape lo lee el guion del comando (`firmas`), no le llega como escape (`escapes` vacío).
  // 🔴 mutación: tratarla como un escape (sólo la terminal) → la consola Bash deja de ofrecer el click y PowerShell deja
  //    de mandar a la consola Bash.
  const firmas = ['escape:ALLOW_DOD_EVIDENCE_WRITE'];
  // desde la consola Bash de Git: el camino de siempre, con la ventana o el click (ofrecerEnWindows no agrega nada)
  assert.strictEqual(ofrece(ESCAPE, { firmas }), '', 'consola Bash: el texto de siempre, con el cuadro');
  // desde PowerShell con Git Bash: a la consola Bash, que firma en la pestaña; la terminal, de emergencia
  const ps = ofrece(ESCAPE, { evento: { tool_name: 'PowerShell' }, firmas });
  assert.match(ps, /consola Bash de Git/, ps);
  assert.match(ps, /--terminal/, ps);
  assert.doesNotMatch(ps, /un escape no se aprueba en la pestaña/, ps);
  // sin Git Bash no hay pestaña que compare el comando: queda sólo la terminal
  assert.match(ofrece(ESCAPE, { evento: { tool_name: 'PowerShell' }, firmas, gitBash: SIN_GIT }), /Va sólo en la terminal/);
  // y decidir desde PowerShell manda a la consola Bash, no sólo a la terminal
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-casa-'));
  try {
    const r = ow.decidir({ plataforma: 'win32', evento: evento(ESCAPE, { tool_name: 'PowerShell' }), casa, ahora: AHORA, gitBash: CON_GIT });
    assert.strictEqual(r.decision, 'deny');
    assert.match(r.texto, /corré la firma por la consola Bash de la herramienta, o con --terminal/, r.texto);
  } finally { fs.rmSync(casa, { recursive: true, force: true }); }
});
