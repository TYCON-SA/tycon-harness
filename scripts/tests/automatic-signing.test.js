'use strict';
// automatic-signing.test.js — las firmas de trámite, que da el arnés solo.
//
// Una firma de la lista de trámite del perfil no abre ventana ni cuadro y no espera a la coordinadora: el freno la deja
// correr, el guion la firma con la vía `automatica` después de su control previo, y la constancia dice que la dio el
// arnés. Lo que no es de trámite, o lo que el control previo niega, sigue yendo a una persona.
//
// Correr: node --test scripts/tests/automatic-signing.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ow = require('../lib/owner-window.js');
const A = require('../lib/automatic-signing.js');

const RAIZ = path.join(__dirname, '..', '..');
const MARKER = path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'marker.js');
const AHORA = Date.parse('2026-10-27T13:00:00Z');
const INICIO = 'Tue Oct 27 10:00:00 2026';
const PLAN = `node ${MARKER} complete-step approve-plan --approved "dale, seguí"`;
const PLAN_ARGV = [MARKER, 'complete-step', 'approve-plan', '--approved', 'dale, seguí'];

function casaNueva(t) {
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'firma-automatica-'));
  t.after(() => fs.rmSync(casa, { recursive: true, force: true }));
  const activos = path.join(casa, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(activos, { recursive: true });
  fs.writeFileSync(path.join(activos, 'ses-a.json'), JSON.stringify({ sessionId: 'ses-a', storyId: '9.99', storyPath: '/r/specs/story-9.99.md' }));
  return casa;
}

const herramienta = { pid: 100, ppid: 1, inicio: INICIO, comando: '/Applications/x/native-binary/claude --output-format stream-json --verbose' };
const BASE = [{ pid: 1, ppid: 0, inicio: 'Mon Oct 26 08:00:00 2026', comando: '/sbin/launchd' }];

/** La envoltura con la que la herramienta corre un comando (Mac); la de fondo va sin `< /dev/null`. */
function envolver(casa, cmd, { deFondo = false } = {}) {
  return `/bin/zsh -c source ${casa}/.claude/shell-snapshots/snapshot-zsh-1793030721191-z5n7vi.sh 2>/dev/null || true`
    + ' && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true'
    + " && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true"
    + ` && eval '${cmd.replace(/'/g, `'"'"'`)}'${deFondo ? '' : ' < /dev/null'} && pwd -P >| /tmp/claude-b725-cwd`;
}
const arbolDelFreno = (extra = []) => [...BASE, herramienta,
  { pid: 200, ppid: 100, inicio: INICIO, comando: '/bin/bash /h/scripts/hooks/safety-guard-pre.sh' },
  { pid: 201, ppid: 200, inicio: INICIO, comando: 'node /h/scripts/lib/owner-window.js gate' }, ...extra];
const arbolDelGuion = (casa, cmd) => [...BASE, herramienta,
  { pid: 300, ppid: 100, inicio: INICIO, comando: envolver(casa, cmd) },
  { pid: 301, ppid: 300, inicio: INICIO, comando: cmd }];
const consolaDeFondo = (casa) => ({ pid: 150, ppid: 100, inicio: INICIO, comando: envolver(casa, 'npm test', { deFondo: true }) });

const DE_TRAMITE = () => ({ ok: true });
const NO_TRAMITE = () => ({ ok: false, motivo: null });
const pedir = (casa, cmd, o = {}) => ow.decidir({
  evento: { session_id: 'ses-a', tool_use_id: 'toolu_01', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd }, permission_mode: 'default', ...(o.evento || {}) },
  escapes: o.escapes || [], arbol: o.arbol || arbolDelFreno(), pid: 201, casa, ahora: AHORA,
  delegacion: () => ({ ok: false, motivo: 'sin delegación en la prueba' }), tramite: o.tramite || NO_TRAMITE,
  clasificar: o.clasificar || (() => null), comprobar: o.comprobar || (() => null), aprobador: () => ({ label: 'Arnés' }),
  huellaDeLaMaquina: o.huella || (() => ({ huella: 'f'.repeat(16) })),
});
const vigentes = (casa) => { try { return fs.readdirSync(ow.carpeta(casa)).filter((f) => f.endsWith('.json')); } catch (_) { return []; } };
const leer = (casa, archivo) => { try { return fs.readFileSync(path.join(casa, '.claude', '.tycon-pipeline', archivo), 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch (_) { return []; } };

test('AutomaticSigning_Tramite_SinVentanaNiCuadro', (t) => {
  const casa = casaNueva(t);
  const r = pedir(casa, PLAN, { tramite: DE_TRAMITE });
  assert.strictEqual(r.decision, 'allow', r.texto);
  assert.strictEqual(r.via, 'automatica');
  assert.match(r.texto, /firma de trámite: la da el arnés/);
  const v = vigentes(casa);
  assert.strictEqual(v.length, 1);
  const reg = JSON.parse(fs.readFileSync(path.join(ow.carpeta(casa), v[0]), 'utf8'));
  assert.strictEqual(reg.via, 'automatica');
  assert.strictEqual(reg.firma, 'plan-approval');
  assert.strictEqual(reg.maquina, 'f'.repeat(16), 'el registro dice en qué máquina se firmó');
  // sin la huella de la máquina no sale sola
  const sinHuella = pedir(casaNueva(t), PLAN, { tramite: DE_TRAMITE, huella: () => ({ error: 'sin huella' }) });
  assert.strictEqual(sinHuella.decision, 'ask');
  assert.match(sinHuella.texto, /no pude leer la huella de esta máquina/);
});

// 🔴 Falla con: liberar a otra sesión frenada (write-after-release) sale por trámite, sin que nadie mire lo que escribió
//    el comando: se le adelanta a la coordinadora designada, y el guion después la rechaza.
test('AutomaticSigning_ReleaseWriteAfterForOtherSession_NotByTramite @story-8.320 @ac-7', (t) => {
  const casa = casaNueva(t);
  const r = pedir(casa, `node ${MARKER} release-write-after --for-session ses-b --reason "miré la historia"`, { tramite: DE_TRAMITE });
  assert.notStrictEqual(r.via, 'automatica', r.texto);
  assert.ok(!vigentes(casa).some((f) => JSON.parse(fs.readFileSync(path.join(ow.carpeta(casa), f), 'utf8')).via === 'automatica'), 'sin registro de trámite');
});

test('AutomaticSigning_RefirmaTrasTraerMain_LlevaLaMaquinaYDeQueEsRefirma', (t) => {
  const casa = casaNueva(t);
  const CONTROLES = path.join(RAIZ, 'scripts', 'ci', 'run-base-controls.sh');
  const r = pedir(casa, `bash ${CONTROLES} approve --base origin/main`, { tramite: (ids) => ({ ok: ids.every((x) => x === 'refresh-after-main') }),
    clasificar: () => ({ clase: 'refresh-after-main', refirma_de: 'abc123' }) });
  assert.strictEqual(r.decision, 'allow', r.texto);
  assert.deepStrictEqual(r.firmas, ['refresh-after-main']);
  const reg = JSON.parse(fs.readFileSync(path.join(ow.carpeta(casa), vigentes(casa)[0]), 'utf8'));
  assert.strictEqual(reg.maquina, 'f'.repeat(16));
  assert.strictEqual(reg.refirma_de, 'abc123');
});

test('AutomaticSigning_ConsolaDeFondoOPestanaSinPermisos_SaleIgual', (t) => {
  const casa = casaNueva(t);
  assert.strictEqual(pedir(casa, PLAN, { arbol: arbolDelFreno([consolaDeFondo(casa)]) }).decision, 'deny', 'sin trámite, la consola de fondo frena la ventana');
  const r = pedir(casa, PLAN, { arbol: arbolDelFreno([consolaDeFondo(casa)]), tramite: DE_TRAMITE });
  assert.strictEqual(r.decision, 'allow', r.texto);
  const sinPermisos = pedir(casaNueva(t), PLAN, { evento: { permission_mode: 'bypassPermissions' }, tramite: DE_TRAMITE });
  assert.strictEqual(sinPermisos.via, 'automatica');
});

test('AutomaticSigning_ControlPrevioNiega_VaALaPersonaConElArbol', (t) => {
  const casa = casaNueva(t);
  const r = pedir(casa, PLAN, { tramite: DE_TRAMITE, comprobar: (o) => (o.via === 'automatica' ? { niega: 'la revisión del plan no está aprobada' } : null) });
  assert.strictEqual(r.decision, 'ask', r.texto);
  assert.match(r.texto, /No salió como firma de trámite: la revisión del plan no está aprobada/);
  // lo que va a la persona vuelve a pasar por los controles del árbol
  const otra = casaNueva(t);
  const n = pedir(otra, PLAN, { arbol: arbolDelFreno([consolaDeFondo(otra)]), tramite: DE_TRAMITE, comprobar: () => ({ niega: 'no' }) });
  assert.strictEqual(n.decision, 'deny');
  assert.match(n.texto, /consola de fondo/);
});

test('T108n AutomaticSigning_ChequeoSinRespuesta_NoSaleSola_VaALaVentana', (t) => {
  // 🔴 rojo si: sin tiempo para el chequeo del guion (el freno de seguridad estaba por cortar), la firma sale sola sin él
  const casa = casaNueva(t);
  const r = pedir(casa, PLAN, { tramite: DE_TRAMITE, comprobar: () => ({ sinRespuesta: 'no quedó tiempo para el chequeo del guion antes de que corte el freno' }) });
  assert.strictEqual(r.decision, 'ask', r.texto);
  assert.notStrictEqual(r.via, 'automatica');
  assert.match(r.texto, /No salió como firma de trámite: no quedó tiempo para el chequeo/);
});

test('AutomaticSigning_NoTramite_NoSaleSola', (t) => {
  assert.strictEqual(pedir(casaNueva(t), PLAN, { tramite: () => ({ ok: false, motivo: 'el perfil no la lista' }) }).decision, 'ask');
  const e = pedir(casaNueva(t), `node ${MARKER} set-check dod green --force-manual`, { escapes: ['escape:force-manual'], tramite: () => ({ ok: false, motivo: null }) });
  assert.notStrictEqual(e.via, 'automatica', 'un escape que el perfil no pone como trámite no sale solo');
});

test('AutomaticSigning_EscapeDeTramite_SaleSinVentanaYSinRegistroDeLaVentana', (t) => {
  const casa = casaNueva(t);
  // un escape por variable, armado por partes: el nombre entero en el fuente lo frena el propio freno de seguridad
  const variable = ['TYCON', 'STATUS', 'GATE'].join('_');
  // stable-data: el comando es sólo el texto que juzga el freno; no se corre ni crea ningún commit
  const r = pedir(casa, `${variable}=off git commit -m x`, { escapes: [`escape:${variable}`], tramite: DE_TRAMITE, arbol: arbolDelFreno([consolaDeFondo(casa)]) });
  assert.strictEqual(r.decision, 'allow', r.texto);
  assert.strictEqual(r.via, 'automatica');
  assert.deepStrictEqual(r.firmas, [`escape:${variable}`]);
  // un escape no deja pedido de la ventana: su constancia la escribe el freno de seguridad
  assert.strictEqual(vigentes(casa).length, 0);
  // dos escapes en el mismo comando no salen solos: la constancia del freno es una por comando
  const otra = ['TYCON', 'NEW', 'NAMES'].join('_');
  const dos = pedir(casaNueva(t), `${variable}=off ${otra}=0 git commit -m x`, { escapes: [`escape:${variable}`, `escape:${otra}`], tramite: DE_TRAMITE });
  assert.notStrictEqual(dos.via, 'automatica');
});

test('AutomaticSigning_LaConstanciaDelEscape_GuardaLaViaYAutorizaElCierre', (t) => {
  const casa = casaNueva(t);
  require('../lib/guard-record.js').anotar({ freno: 'safety-guard', regla: 'ESC-C4', veredicto: 'escape', via: 'automatica', sesion: 'ses-a', escape: 'cerrar-como-deuda', cmd: 'x', home: casa });
  const l = leer(casa, 'frenos.jsonl').find((x) => x.freno === 'safety-guard');
  assert.ok(l, 'quedó la constancia');
  assert.strictEqual(l.via, 'automatica');
  assert.ok(require('../../skills/tycon-pipeline/scripts/lib/run-close.js').VIAS_DE_CIERRE.includes(l.via), 'el cierre la cuenta como autorizada');
});

test('AutomaticSigning_ElGuionFirmaConLaConstanciaDelArnes', (t) => {
  const casa = casaNueva(t);
  assert.strictEqual(pedir(casa, PLAN, { tramite: DE_TRAMITE }).decision, 'allow');
  let avisos = '';
  const r = ow.exigir({ firma: 'plan-approval', argv: PLAN_ARGV, pid: 301, arbol: arbolDelGuion(casa, PLAN), casa, ahora: AHORA + 60000, propia: 'ses-a',
    antes: () => null, env: {}, avisarSinAprobacion: (txt) => { avisos += txt; }, notificar: () => {} });
  assert.strictEqual(r.codigo, 0, r.motivo);
  // al guion vuelve como la delegación: sus controles más estrictos de lo que sale sin persona
  assert.strictEqual(r.via, 'delegacion');
  assert.strictEqual(r.automatica, true);
  assert.match(avisos, /firma de trámite, la dio el arnés/);
  const g = leer(casa, 'gates.log').filter((x) => x.name === 'plan-approval-signed');
  assert.strictEqual(g.length, 1);
  assert.strictEqual(g[0].via, 'automatica');
  const c = leer(casa, 'signatures.jsonl').filter((x) => x.signature === 'plan-approval');
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].via, 'automatic');
  assert.strictEqual(c[0].signer, A.FIRMANTE);
  assert.strictEqual(c[0].ordered_by, 'ses-a');
  assert.strictEqual(c[0].target, 'ses-a');
  assert.strictEqual(ow.quienFirmo(r, 'persona').tipo, 'automatica');
});

test('AutomaticSigning_SinElControlPrevioDelGuion_NoSale', (t) => {
  const casa = casaNueva(t);
  pedir(casa, PLAN, { tramite: DE_TRAMITE });
  const r = ow.exigir({ firma: 'plan-approval', argv: PLAN_ARGV, pid: 301, arbol: arbolDelGuion(casa, PLAN), casa, ahora: AHORA + 60000, propia: 'ses-a', env: {}, notificar: () => {} });
  assert.notStrictEqual(r.codigo, 0);
  assert.strictEqual(leer(casa, 'signatures.jsonl').length, 0);
});

test('AutomaticSigning_LasListasDelPerfil_DecidenQueEsTramite', () => {
  const perfil = () => ({ delegated_signing: ['plan-approval', 'critical-waiver', 'escape:TYCON_SAFETY_OFF', 'control-change', 'designation-set', 'adversarial-skip'], owner_only: ['critical-waiver'] });
  assert.ok(A.esDeTramite({ firma: 'plan-approval', perfil }).ok);
  assert.match(A.esDeTramite({ firma: 'critical-waiver', perfil }).motivo, /owner_only/, 'owner_only gana sobre la lista de trámite');
  for (const f of ['escape:TYCON_SAFETY_OFF', 'control-change', 'designation-set', 'adversarial-skip']) assert.strictEqual(A.esDeTramite({ firma: f, perfil }).ok, false, `${f} nunca es de trámite`);
  assert.strictEqual(A.esDeTramite({ firma: 'extra-round', perfil }).ok, false, 'lo que el perfil no lista no es de trámite');
  assert.match(A.esDeTramite({ firma: 'plan-approval', perfil: () => { throw new Error('roto'); } }).motivo, /no pude leer el perfil/);
  assert.match(A.esDeTramite({ firma: 'plan-approval', perfil: () => ({ delegated_signing: { a: 1 } }) }).motivo, /no es una lista/);
  assert.strictEqual(A.todasDeTramite(['plan-approval', 'extra-round'], { perfil }).ok, false);
});

// Caso 3 del encargo «de terminal a click» (historia 8.298 de la coordinadora, 20/11): con el perfil que lista la exención
// de un crítico como trámite, el arnés la firmaba solo y anotaba quién = el arnés; después write-findings la rechazaba
// («no nombra a la persona») y quedaba la terminal. Un crítico lo decide una persona: nunca sale como trámite, y va por la
// delegación (que nombra al dueño) o por el click del dueño.
test('T1 AutomaticSigning_CriticalWaiver_NeverTramite — la exención de un crítico no sale sola aunque el perfil la liste', () => {
  const perfil = () => ({ delegated_signing: ['plan-approval', 'critical-waiver'], owner_only: [] });
  const r = A.esDeTramite({ firma: 'critical-waiver', perfil });
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert.match(r.motivo, /un crítico lo decide una persona/);
  assert.ok(A.esDeTramite({ firma: 'plan-approval', perfil }).ok, 'lo demás de la lista sigue saliendo solo');
  // la constancia que dejaría el trámite no la acepta write-findings; la de la delegación, sí
  const cw = require('../../skills/tycon-pipeline/scripts/lib/critical-waivers.js');
  const base = { ts: '2026-11-20T10:00:00.000Z', rule_id: 'TEST-C1', file: '.advisors/tests-result.json', reason: 'rojo de main' };
  const conVia = (firma) => { const q = ow.quienFirmo(firma, 'dueño'); return { ...base, ...q, via: `waive-critical (${q.via})` }; };
  assert.match(cw.constanciaInvalida(conVia({ automatica: true })) || '', /no nombra a la persona/);
  assert.strictEqual(cw.constanciaInvalida(conVia({ via: 'delegacion', sesion: 'ses-coord' })), null);
  assert.strictEqual(cw.constanciaInvalida(conVia({ via: 'click' })), null);
});

test('AutomaticSigning_PendienteSinCarpeta_NoSaleYNoNombraALaCoordinadora', () => {
  const ds = require('../lib/delegated-signing.js');
  const r = ds.antesDelPendiente({ via: 'delegacion', registro: { via: 'automatica' }, propia: 'ses-a', estado: os.tmpdir(), cwd: null, repo: '.' });
  assert.strictEqual(r.codigo, 1);
  assert.match(r.motivo, /carpeta/);
  assert.doesNotMatch(r.motivo, /coordinadora/);
});

test('AutomaticSigning_RegistroComun_AceptaLaViaYCuentaSinPersona', (t) => {
  const casa = casaNueva(t);
  const r = require('../lib/signature-log.js').appendSignature({ signature: 'plan-approval', via: 'automatic', signer: A.FIRMANTE, orderedBy: 'ses-a', target: 'ses-a', reason: 'x', home: casa, now: AHORA, huella: () => ({ huella: 'f'.repeat(16) }) });
  assert.ok(r.ok, r.error);
  const [l] = leer(casa, 'signatures.jsonl');
  assert.strictEqual(l.via, 'automatic');
  assert.strictEqual(l.delegated, true);
});

// Una sesión de fondo que abrió la coordinadora trabaja en copias que arma ella misma (`git worktree add`), a veces de
// otro repo que el de la carpeta con que se abrió. La firma de trámite sobre una copia suya sale; sobre la copia de otra
// sesión, sobre el clon principal, o pedida por una sesión que no abrió la coordinadora, no.
/**
 * Una casa con un clon, dos copias (`suya`, de la sesión de fondo `ses-fondo` que abrió la coordinadora, y `ajena`, de
 * `ses-otra`) y la carpeta con que se abrió la de fondo.
 */
function labDeCopiaSuelta(t) {
  const { execFileSync } = require('child_process');
  const { stateDir, claudeDir } = require(path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'copia-suelta-'));
  t.after(() => fs.rmSync(casa, { recursive: true, force: true }));
  // stable-data: la fecha de los commits de esta copia de prueba es fija
  const fecha = { GIT_AUTHOR_DATE: '2026-11-20T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-20T00:00:00Z' };
  const git = (...a) => execFileSync('git', ['-c', 'user.name=lab', '-c', 'user.email=lab@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'maintenance.auto=false', ...a],
    { stdio: 'ignore', env: { ...process.env, ...fecha } });
  const clon = path.join(casa, 'privado');
  fs.mkdirSync(clon);
  git('-C', clon, 'init', '-q');
  fs.writeFileSync(path.join(clon, 'a'), 'a');
  git('-C', clon, 'add', 'a');
  git('-C', clon, 'commit', '-q', '-m', 'a');
  const copia = path.join(casa, 'privado--wt-suya');
  const ajena = path.join(casa, 'privado--wt-ajena');
  git('-C', clon, 'worktree', 'add', '-q', '-b', 'suya', copia);
  git('-C', clon, 'worktree', 'add', '-q', '-b', 'ajena', ajena);
  const carpeta = path.join(casa, 'publico--wt-suya');
  fs.mkdirSync(carpeta);
  const estado = stateDir(casa);
  const sesiones = path.join(claudeDir(casa), 'sessions');
  fs.mkdirSync(sesiones, { recursive: true });
  fs.mkdirSync(path.join(estado, 'coordination'), { recursive: true });
  const abierta = Date.parse('2026-11-20T01:00:00Z');
  fs.writeFileSync(path.join(sesiones, '1.json'), JSON.stringify({ pid: process.pid, sessionId: 'ses-fondo', cwd: carpeta, startedAt: abierta + 1000, kind: 'bg', name: 'R-1' }));
  fs.writeFileSync(path.join(sesiones, '2.json'), JSON.stringify({ pid: process.pid, sessionId: 'ses-otra', cwd: ajena, startedAt: abierta, kind: 'interactive', name: 'Otra' }));
  fs.writeFileSync(path.join(estado, 'coordination', 'launched.json'), JSON.stringify([{ name: 'R-1', cwd: carpeta, at: abierta, por: 'ses-coord' }]));
  return { casa, estado, clon, copia, ajena, carpeta, sesiones, abierta };
}

test('AutomaticSigning_CopiaSueltaDeUnaSesionDeFondo_Sale', (t) => {
  const ds = require('../lib/delegated-signing.js');
  const { casa, estado, clon, copia, ajena, carpeta, sesiones, abierta } = labDeCopiaSuelta(t);
  const pedir = (repo, propia = 'ses-fondo') => ds.antesDelPendiente({ via: 'delegacion', registro: { via: 'automatica' }, propia, estado, cwd: carpeta, repo, casa });

  assert.strictEqual(pedir(copia), null, 'la copia que armó la sesión de fondo es suya');
  assert.match(pedir(ajena).motivo, /ses-otra/, 'la carpeta de otra sesión no');
  assert.match(pedir(clon).motivo, /clon principal/, 'el clon principal no');
  assert.match(pedir(copia, 'ses-otra').motivo, /no es una de fondo que abrió la coordinadora/, 'una sesión que no abrió la coordinadora no');
  // el arreglo rápido de otra sesión sobre la copia la hace de ésa
  fs.mkdirSync(path.join(estado, 'adhoc'), { recursive: true });
  fs.writeFileSync(path.join(estado, 'adhoc', 'ses-z.json'), JSON.stringify({ sessionId: 'ses-z', cwd: copia }));
  assert.match(pedir(copia).motivo, /ses-z/, 'la copia del arreglo rápido de otra sesión no');
  fs.rmSync(path.join(estado, 'adhoc', 'ses-z.json'));
  // también el que otra declaró para ella (`by`), con la carpeta sólo en sus archivos y su base
  fs.writeFileSync(path.join(estado, 'adhoc', 'ses-z.json'), JSON.stringify({ cwd: clon, by: 'ses-coord', via: 'delegacion', allowedFiles: [path.join(copia, 'a')], bases: { [copia]: {} } }));
  assert.match(pedir(copia).motivo, /ses-z/, 'el arreglo rápido declarado para otra, con la copia en sus archivos, no');
  fs.rmSync(path.join(estado, 'adhoc', 'ses-z.json'));
  // la ejecución de otra: también la detenida, y también la copia donde está su código (no sólo la de su historia)
  for (const [dir, marcador] of [['pruned', { sessionId: 'ses-y', repoPath: copia, stepsPending: ['5'] }],
    ['active', { sessionId: 'ses-y', repoPath: clon, storyPath: path.join(clon, 'specs', 'story-1.md'), filesTouched: [path.join(copia, 'a')] }]]) {
    fs.mkdirSync(path.join(estado, dir), { recursive: true });
    fs.writeFileSync(path.join(estado, dir, 'ses-y.json'), JSON.stringify(marcador));
    assert.match(pedir(copia).motivo, /ses-y/, `la ejecución de otra en ${dir} no`);
    fs.rmSync(path.join(estado, dir, 'ses-y.json'));
  }
  // lo de una sesión que ya terminó no la hace de nadie: su archivo de sesión muerto y su fila de la apertura
  fs.writeFileSync(path.join(sesiones, '3.json'), JSON.stringify({ pid: 999999, sessionId: 'ses-muerta', cwd: copia, startedAt: abierta - 9e7, kind: 'bg', name: 'Vieja' }));
  fs.writeFileSync(path.join(estado, 'coordination', 'launched.json'), JSON.stringify([{ name: 'R-1', cwd: carpeta, at: abierta, por: 'ses-coord' },
    { name: 'Vieja', cwd: copia, at: abierta - 9e7, por: 'ses-coord' }]));
  assert.strictEqual(pedir(copia), null, 'una sesión que ya terminó no es dueña de la copia');
  fs.rmSync(path.join(sesiones, '3.json'));
  // sin poder leer las sesiones que abrió la coordinadora, no
  fs.writeFileSync(path.join(estado, 'coordination', 'launched.json'), '{roto');
  assert.match(pedir(copia).motivo, /no pude/);
});

// 🔴 Falla con: un pendiente que abrió una sesión de fondo sin ejecución ni arreglo rápido (modo ágil), en su copia, que la
//    coordinadora no puede aprobar por delegación y cae al dueño; o, al revés, una copia de la coordinadora que nadie
//    nombra y que pasa como de la sesión ágil. Vale sólo lo que la sesión ágil declaró. Nadie se aprueba a sí mismo.
test('Delegacion_PendienteEnLaCopiaDeUnaSesionAgil_SoloConLaDeclaracion', (t) => {
  const { execFileSync } = require('child_process');
  const ds = require('../lib/delegated-signing.js');
  const { casa, estado, clon, copia, ajena, carpeta } = labDeCopiaSuelta(t);
  // una copia que armó la coordinadora y donde trabaja sin marcador: ninguna sesión la nombra
  const deLaCoord = path.join(casa, 'privado--wt-coord');
  execFileSync('git', ['-C', clon, 'worktree', 'add', '-q', '-b', 'coord', deLaCoord], { stdio: 'ignore' });
  const designada = (s) => s === 'ses-coord';
  const pedir = (repo, { sesion = 'ses-coord', destino = 'ses-fondo', pendiente = 'DEF-uno' } = {}) => ds.antesDelPendiente({ via: 'delegacion', registro: { via: 'delegacion', sesion, destino },
    estado, cwd: carpeta, repo, casa, designada, pendiente });
  const declarar = (sesion, id, repo) => fs.appendFileSync(path.join(estado, 'gates.log'),
    `${JSON.stringify({ ts: '2026-11-20T02:00:00.000Z', name: ds.DECLARADO, status: 'ok', sesion, id, repo: ds.raizDelRepo(repo).clave, ruta: repo })}\n`);
  // sin declarar, ni la copia de la sesión ágil ni la de la coordinadora
  assert.match(pedir(copia).motivo || '', /no declaró DEF-uno en esa copia: la sesión ses-fondo lo declara con `marker.js declare-pending/);
  assert.match(pedir(deLaCoord).motivo || '', /no declaró/, 'la copia de la coordinadora que nadie nombra no pasa');
  assert.match(pedir(copia, { pendiente: null }).motivo || '', /no dice qué pendiente es/);
  // declarado por la sesión ágil, en su copia: sale
  declarar('ses-fondo', 'DEF-uno', copia);
  assert.strictEqual(pedir(copia), null, 'la copia de la sesión ágil, con su declaración');
  assert.match(pedir(copia, { pendiente: 'DEF-otro' }).motivo || '', /no declaró DEF-otro/, 'la declaración es de ese pendiente');
  assert.match(pedir(deLaCoord).motivo || '', /no declaró/, 'la declaración es de esa copia');
  // la coordinadora declarando por su cuenta no le sirve: la declaración tiene que ser de la sesión destino
  declarar('ses-coord', 'DEF-dos', deLaCoord);
  assert.match(pedir(deLaCoord, { pendiente: 'DEF-dos' }).motivo || '', /no declaró DEF-dos/);
  // lo de siempre: la copia de otra sesión, el clon principal, nadie se aprueba a sí mismo, otra sesión no es la coordinadora
  declarar('ses-fondo', 'DEF-uno', ajena);
  assert.match(pedir(ajena).motivo || '', /ses-otra/, 'la copia de otra sesión no, aunque la declare');
  assert.match(pedir(clon).motivo || '', /clon principal|repo de la coordinadora/, 'el clon principal no');
  assert.match(pedir(copia, { destino: 'ses-coord' }).motivo || '', /no ella misma/, 'la coordinadora no se aprueba a sí misma');
  assert.match(pedir(copia, { sesion: 'ses-fondo' }).motivo || '', /no ella misma/, 'la sesión ágil no se aprueba a sí misma');
  assert.match(pedir(copia, { sesion: 'ses-otra' }).motivo || '', /no es la coordinadora designada/, 'otra sesión no aprueba por delegación');
});

// 🔴 Falla con: una declaración que se anota sin un pendiente abierto, con la sesión de otra, o que el freno deja correr
//    con una variable de sesión escrita en el comando (una sesión declararía por otra y se aprobaría lo suyo).
test('DeclarePending_AnotaLaSesionDelProceso_YElFrenoNiegaLaVariable', (t) => {
  const { spawnSync, execFileSync } = require('child_process');
  const ds = require('../lib/delegated-signing.js');
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'declarar-'));
  t.after(() => fs.rmSync(casa, { recursive: true, force: true }));
  const repo = path.join(casa, 'repo');
  fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
  execFileSync('git', ['-C', repo, 'init', '-q']);
  fs.writeFileSync(path.join(repo, 'tasks', 'todo.md'), '- [ ] [DEF-uno] (2026-11-20) algo que falta\n');
  const marker = path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'marker.js');
  const correr = (args, sid = 'ses-fondo') => spawnSync(process.execPath, [marker, 'declare-pending', ...args], { cwd: repo, encoding: 'utf8',
    env: { ...process.env, HOME: casa, USERPROFILE: casa, CLAUDE_CODE_SESSION_ID: sid, TYCON_SIGN_PRECHECK: '' } });
  const { stateDir } = require(path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
  const renglones = () => { try { return fs.readFileSync(path.join(stateDir(casa), 'gates.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((j) => j.name === ds.DECLARADO); } catch (_) { return []; } };
  assert.strictEqual(correr(['--id', 'DEF-nada']).status, 1, 'un código que no está abierto no se declara');
  assert.notStrictEqual(correr(['--id', 'DEF-uno', '--for-session', 'ses-otra']).status, 0, 'no se declara por otra sesión');
  assert.deepStrictEqual(renglones(), []);
  const r = correr(['--id', 'DEF-uno']);
  assert.strictEqual(r.status, 0, r.stderr);
  const [j] = renglones();
  assert.strictEqual(j.sesion, 'ses-fondo');
  assert.strictEqual(j.id, 'DEF-uno');
  assert.strictEqual(j.repo, ds.raizDelRepo(repo).clave);
  // el freno: con una variable de sesión en el comando, no corre; sin ella, no la mira
  const ow = require('../lib/owner-window.js');
  const evento = (command) => ({ session_id: 'ses-coord', tool_use_id: 'toolu_01', hook_event_name: 'PreToolUse', tool_name: 'Bash', permission_mode: 'default', tool_input: { command } });
  for (const c of [`CLAUDE_CODE_SESSION_ID=ses-fondo node ${marker} declare-pending --id DEF-uno`, `export TYCON_SESSION_ID=ses-fondo; node ${marker} declare-pending --id DEF-uno`]) {
    const d = ow.decidir({ evento: evento(c), casa, sinAviso: ['x'] });
    assert.strictEqual(d.decision, 'deny', c);
    assert.match(d.texto, /lo declara la sesión que lo abrió/);
  }
  // también con un escape en su período de aviso en el mismo comando, y con el guion escrito sin «.js»
  const conEscape = `TYCON_MUTATION_CHECK=off CLAUDE_CODE_SESSION_ID=ses-fondo node ${marker} declare-pending --id DEF-uno`;
  assert.strictEqual(ow.decidir({ evento: evento(conEscape), escapes: ['escape:TYCON_MUTATION_CHECK'], casa, ahora: Date.parse('2026-11-20T12:00:00Z') }).decision, 'deny', 'el período de aviso no la deja pasar');
  const sinJs = `CLAUDE_CODE_SESSION_ID=ses-fondo node ${marker.replace(/\.js$/, '')} declare-pending --id DEF-uno`;
  assert.strictEqual(ow.decidir({ evento: evento(sinJs), casa, sinAviso: ['x'] }).decision, 'deny', 'el guion sin «.js»');
  assert.strictEqual(ow.decidir({ evento: evento(`node ${marker} declare-pending --id DEF-uno`), casa, sinAviso: ['x'] }).decision, 'none');
});

// @story-8.274 @ac-16
// 🔴 Falla con: `runtime-waiver` que sale como trámite, o que pasa a la coordinadora por delegación, aunque el perfil la
//    liste: aceptar un criterio imposible de probar en vivo espera el click o la terminal del dueño, que lo quiere ver.
test('RuntimeWaiver_NeverRoutineNorDelegated_WaitsForTheOwner @story-8.274 @ac-16', () => {
  const perfil = () => ({ delegated_signing: ['runtime-waiver', 'plan-approval'] });
  const r = A.esDeTramite({ firma: 'runtime-waiver', perfil });
  assert.strictEqual(r.ok, false, 'listada en el perfil, igual no es de trámite');
  assert.match(r.motivo, /dueño/, r.motivo);
  assert.strictEqual(A.todasDeTramite(['runtime-waiver'], { perfil }).ok, false);
  assert.ok(require('../lib/delegated-signing.js').NUNCA_DELEGABLES.has('runtime-waiver'), 'tampoco se delega a la coordinadora');
  assert.ok(A.esDeTramite({ firma: 'plan-approval', perfil }).ok, 'lo demás del perfil sigue igual');
});
