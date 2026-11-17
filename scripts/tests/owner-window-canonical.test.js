'use strict';
/**
 * owner-window-canonical.test.js — el mismo pedido de firma escrito de otra forma no pide otro click (8.296).
 *
 * El caso: el click del dueño aprobó una `runtime-waiver` con un código; la sesión cambió apenas el comando (el orden de
 * las opciones, la historia por ruta relativa) y el freno pidió otro cuadro para lo mismo. La huella del sello salía del
 * texto tal como se escribió. Ahora sale de la forma canónica del pedido (`formaCanonica`), que cambia sólo la escritura:
 * lo que el guion lee distinto (`--x=v`, otro valor, otro criterio) sigue dando otro código.
 *
 * Vive aparte de owner-window.test.js: aquélla pasa el tope del freno de comandos y no se puede correr desde una copia de
 * trabajo. Las herramientas de abajo son las de aquélla (la casa, el árbol, el evento, la aprobación de prueba).
 *
 * Todo en proceso, con una casa temporal. stable-data: la única hora real es la de la corrida de pruebas en verde que la
 * matriz pide reciente; ninguna aserción compara contra una fecha fija.
 *
 * 🔴 Mutaciones que los ponen en rojo: armar la huella con el texto tal como se escribió o con los criterios en el orden de
 * `--acs` (T19, T20), dar por igual algo que cambia lo que se firma, como `--x=v` (T21), aceptar el click de A para un B
 * que cambia un criterio o dejar la fila de A con otra clave en la lista (T22), inventar una forma canónica donde no la
 * hay (T23), migrar el click de antes (T24).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ow = require('../lib/owner-window.js');
const oaReal = require('../lib/owner-approvals.js');
const sl = require('../lib/signature-list.js');

const RAIZ = path.join(__dirname, '..', '..');
const MARKER = path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'marker.js');
const E2E = path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'e2e-setup.js');
const AHORA = Date.parse('2026-10-27T13:00:00Z');
const INICIO = 'Tue Oct 27 10:00:00 2026';

function casaNueva(t) {
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-canon-'));
  t.after(() => fs.rmSync(casa, { recursive: true, force: true }));
  const activos = path.join(casa, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(activos, { recursive: true });
  fs.writeFileSync(path.join(activos, 'ses-a.json'), JSON.stringify({ sessionId: 'ses-a', storyId: '9.99', storyPath: '/r/h/9.99.md' }));
  return casa;
}

const herramienta = () => ({ pid: 100, ppid: 1, inicio: INICIO, comando: '/Applications/x/native-binary/claude --output-format stream-json --verbose' });
const BASE = [{ pid: 1, ppid: 0, inicio: 'Mon Oct 26 08:00:00 2026', comando: '/sbin/launchd' }];
const arbolDelFreno = () => [...BASE, herramienta(),
  { pid: 200, ppid: 100, inicio: INICIO, comando: '/bin/bash /h/scripts/hooks/safety-guard-pre.sh' },
  { pid: 201, ppid: 200, inicio: INICIO, comando: 'node /h/scripts/lib/owner-window.js gate' }];
const evento = (command, extra = {}) => ({ session_id: 'ses-a', tool_use_id: 'toolu_01', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...extra });
const SIN_DELEGACION = () => ({ ok: false, motivo: 'sin delegación en la prueba' });
const { APPROVERS } = require(path.join(__dirname, '..', 'lib', 'approver.js'));
const DEL_ARNES = () => APPROVERS.maintainers;
// la validación de verdad confirma el click contra la pregunta que se mostró: acá, la misma comparación
const aprobaciones = {
  buscar: (o) => oaReal.buscar({ ...o, validar: (a, ctx) => (a.pregunta === ctx.cuadro.pregunta ? { ok: true } : { ok: false, motivo: 'otra pregunta' }) }),
  consumir: oaReal.consumir,
  devolver: oaReal.devolver,
  coordinadoraConfirmada: () => null,
};
// donde la ventana no llega (una sesión sin permisos): lo que decide es el click
const pedirSinVentana = (casa, cmd) => ow.decidir({ evento: evento(cmd, { permission_mode: 'bypassPermissions' }), escapes: [], arbol: arbolDelFreno(), pid: 201, casa,
  ahora: AHORA, delegacion: SIN_DELEGACION, clasificar: () => null, comprobar: () => null, aprobador: DEL_ARNES, aprobaciones });
const anotarClick = (casa, pregunta) => oaReal.anotar(casa, { tipo: 'click', sesion: 'ses-a', ts: new Date(AHORA - 60000).toISOString(), tool_use_id: 'toolu_1',
  pregunta, respuesta: 'Sí, aprobar', herramienta: { pid: 100, inicio: INICIO } });

/**
 * Una historia de ensayo con tres criterios que no se prueban en vivo (1, 3 y 4). Fuera de `specs/` y sin el nombre
 * `story-*.md`: el freno de comandos lee lo que escribe una prueba.
 */
function historiaConTres(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-tres-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(repo, 'h'), { recursive: true });
  assert.strictEqual(spawnSync('git', ['init', '-q', repo]).status, 0);
  const story = path.join(repo, 'h', 'tres.md');
  const escribir = (texto1 = 'el aviso queda en el servicio externo') => fs.writeFileSync(story, ['---', 'story: "9.94"', 'status: in-progress', 'runtime_not_verifiable:',
    ...[1, 3, 4].flatMap((n) => [`  - ac: ${n}`, '    reason: "el servicio externo no tiene ambiente de prueba"', `    covered_by: T${n}`]), '---', '', '# Story 9.94', '',
    '## Acceptance Criteria', '', `1. **Given** un pedido **Then** ${texto1}.`, '2. **Given** otro **Then** se ve.', '3. **Given** un tercero **Then** queda afuera.',
    '4. **Given** un cuarto **Then** queda afuera también.', '', '### Tests', '', '| # | Test | AC | Nivel | Escenario | Resultado esperado |', '|---|---|---|---|---|---|',
    '| T1 | `Uno` | 1 | unit | x | y |', '| T3 | `Tres` | 3 | unit | x | y |', '| T4 | `Cuatro` | 4 | unit | x | y |', ''].join('\n'));
  escribir();
  fs.mkdirSync(path.join(repo, '.advisors'));
  fs.writeFileSync(path.join(repo, '.advisors', 'tests-result.json'), JSON.stringify({ ts: new Date().toISOString(), story_id: '9.94', suite_green: true }));
  return { repo, story, escribir };
}

const cuadroDe = (casa, firma, cmd, cwd) => ow.cuadroPara({ firma, comando: cmd, palabras: ow.canonica(cmd), destino: 'ses-a', sesion: 'ses-a', casa, cwd });

test('T19 Huella_MismoPedidoEscritoDistinto_MismoCodigo @story-8.296 @ac-17 @ac-22', (t) => {
  const casa = casaNueva(t);
  const { story } = historiaConTres(t);
  const pares = [
    [`node ${MARKER} runtime-waiver ${story} --acs 1 --approved-by "el dev"`, `node ${MARKER} runtime-waiver ${story} --approved-by "el dev" --acs 1`],
    [`node ${MARKER} runtime-waiver ${story} --acs 3,1,3`, `node ${MARKER} runtime-waiver ${story} --acs 1,3`],
  ];
  for (const [a, b] of pares) {
    const ca = cuadroDe(casa, 'runtime-waiver', a);
    const cb = cuadroDe(casa, 'runtime-waiver', b);
    assert.ok(!ca.error && !cb.error, `${ca.error || cb.error}`);
    assert.strictEqual(ca.sello, cb.sello, `${a}\n${b}`);
    assert.strictEqual(ca.pregunta, cb.pregunta, 'la pregunta cambia: el click no se encontraría');
  }
  // una firma sin fuente propia (la pregunta trae el comando): las opciones en otro orden, la misma pregunta
  const a = cuadroDe(casa, 'browser-test', `node ${E2E} prepare --repo /r --story s.md`);
  const b = cuadroDe(casa, 'browser-test', `node ${E2E} prepare --story s.md --repo /r`);
  assert.ok(!a.error && !b.error, a.error || b.error);
  assert.strictEqual(a.sello, b.sello);
  assert.strictEqual(a.pregunta, b.pregunta);
  // escrito igual que antes: el mismo cuadro (con su código nuevo)
  assert.deepStrictEqual(cuadroDe(casa, 'runtime-waiver', pares[0][0]), cuadroDe(casa, 'runtime-waiver', pares[0][0]));
});

test('T20 Huella_RutaRelativaYAbsoluta_MismoCodigo @story-8.296 @ac-17', (t) => {
  const casa = casaNueva(t);
  const { repo, story } = historiaConTres(t);
  const abs = cuadroDe(casa, 'runtime-waiver', `node ${MARKER} runtime-waiver ${story} --acs 1`, repo);
  const rel = cuadroDe(casa, 'runtime-waiver', `node ${MARKER} runtime-waiver h/tres.md --acs 1`, repo);
  assert.ok(!abs.error && !rel.error, abs.error || rel.error);
  assert.strictEqual(abs.sello, rel.sello);
  // con --for-session, relativa al repo de la sesión destino (su marcador)
  const activos = path.join(casa, '.claude', '.tycon-pipeline', 'active');
  fs.writeFileSync(path.join(activos, 'ses-b.json'), JSON.stringify({ sessionId: 'ses-b', storyId: '9.94', storyPath: story, repoPath: repo }));
  const ajena = (cmd) => ow.cuadroPara({ firma: 'runtime-waiver', comando: cmd, palabras: ow.canonica(cmd), destino: 'ses-b', sesion: 'ses-coord', casa, cwd: repo });
  const fa = ajena(`node ${MARKER} runtime-waiver ${story} --acs 1 --for-session ses-b`);
  const fr = ajena(`node ${MARKER} runtime-waiver h/tres.md --for-session ses-b --acs 1`);
  assert.ok(!fa.error && !fr.error, fa.error || fr.error);
  assert.strictEqual(fa.sello, fr.sello);
  // relativa, pedida desde una carpeta que no es el repo de la ejecución: el guion la leería desde el repo → otro código
  fs.writeFileSync(path.join(activos, 'ses-a.json'), JSON.stringify({ sessionId: 'ses-a', storyId: '9.94', storyPath: story, repoPath: path.join(repo, 'h') }));
  const lejos = cuadroDe(casa, 'runtime-waiver', `node ${MARKER} runtime-waiver h/tres.md --acs 1`, repo);
  assert.ok(!lejos.error, lejos.error);
  assert.notStrictEqual(lejos.sello, abs.sello, 'dio por igual una ruta que el guion lee desde otra carpeta');
  // `--for-session <id>` sale de la forma canónica, esté donde esté, y nada más sale con él
  const sinDestino = ow.formaCanonica(ow.canonica(`node ${MARKER} runtime-waiver ${story} --acs 1 --approved-by x`));
  assert.deepStrictEqual(ow.formaCanonica(ow.canonica(`node ${MARKER} runtime-waiver ${story} --for-session ses-b --acs 1 --approved-by x`)), sinDestino);
  assert.deepStrictEqual(ow.formaCanonica(ow.canonica(`node ${MARKER} runtime-waiver ${story} --acs 1 --approved-by x --for-session ses-b`)), sinDestino);
  // la historia que se normaliza es sólo la de runtime-waiver; sin casa, la relativa se lee desde la carpeta del pedido
  assert.strictEqual(ow.historiaDelPedido(['marker.js', 'mark-tested', 'h/tres.md'], { cwd: repo, casa, destino: 'ses-a' }), null);
  assert.strictEqual(ow.historiaDelPedido(['marker.js', 'runtime-waiver', '--acs', '1'], { cwd: repo, casa, destino: 'ses-a' }), null);
  assert.strictEqual(ow.historiaDelPedido(['marker.js', 'runtime-waiver', 'h/tres.md'], { cwd: repo, destino: 'ses-a' }), fs.realpathSync(story));
  assert.strictEqual(ow.historiaDelPedido(['marker.js', 'runtime-waiver', 'h/tres.md'], { cwd: repo, casa }), fs.realpathSync(story));
});

test('T21 Huella_CambiaLoQueSeFirma_OtroCodigo @story-8.296 @ac-18', (t) => {
  const casa = casaNueva(t);
  const h = historiaConTres(t);
  const otra = historiaConTres(t);
  const base = `node ${MARKER} runtime-waiver ${h.story} --acs 1,3 --approved-by x`;
  const sello = (cmd) => { const c = cuadroDe(casa, 'runtime-waiver', cmd); assert.ok(!c.error, `${cmd}: ${c.error}`); return c.sello; };
  const s0 = sello(base);
  for (const cmd of [
    `node ${MARKER} runtime-waiver ${h.story} --acs 1,4 --approved-by x`,
    `node ${MARKER} runtime-waiver ${otra.story} --acs 1,3 --approved-by x`,
    `node ${MARKER} runtime-waiver ${h.story} --acs 1,3 --approved-by y`,
    `node ${MARKER} runtime-waiver ${h.story} --acs 1,3 --approved-by x --note something`,
    `node ${MARKER} runtime-waiver ${h.story} --acs 1,3 --approved-by=x`,
  ]) assert.notStrictEqual(sello(cmd), s0, cmd);
  // el texto de un criterio cambiado en la historia
  h.escribir('el aviso queda en otro servicio');
  assert.notStrictEqual(sello(base), s0, 'cambió el criterio y el código es el mismo');
});

test('T22 Click_ComandoEquivalente_FirmaSinOtroCuadro_YCambioReal_Pregunta @story-8.296 @ac-19', (t) => {
  const { story, escribir } = historiaConTres(t);
  const A = `node ${MARKER} runtime-waiver ${story} --acs 1,3 --approved-by "el dev"`;
  const B = `node ${MARKER} runtime-waiver ${story} --approved-by "el dev" --acs 3,1`;
  const casa = casaNueva(t);
  const ca = cuadroDe(casa, 'runtime-waiver', A);
  assert.ok(!ca.error, ca.error);
  anotarClick(casa, ca.pregunta);
  const rb = pedirSinVentana(casa, B);
  assert.deepStrictEqual([rb.decision, rb.via], ['allow', 'click'], rb.texto);
  // B' cambia un criterio: el click de A no sirve
  const casa2 = casaNueva(t);
  anotarClick(casa2, cuadroDe(casa2, 'runtime-waiver', A).pregunta);
  escribir('el aviso queda en otro servicio');
  const rb2 = pedirSinVentana(casa2, B);
  assert.strictEqual(rb2.decision, 'deny', rb2.texto);
  assert.ok(rb2.cuadro, 'trae el cuadro nuevo');
  assert.match(rb2.texto, /lo que se mostró cambió/);
  // la lista de firmas anota A y B con la misma clave: firmar B cierra la fila de A
  escribir();
  assert.strictEqual(sl.claveDe('runtime-waiver', 'ses-a', ow.canonica(A)), sl.claveDe('runtime-waiver', 'ses-a', ow.canonica(B)));
  assert.strictEqual(ow.claveDelPedido({ firma: 'runtime-waiver', destino: 'ses-a', comando: B }), sl.claveDe('runtime-waiver', 'ses-a', ow.canonica(A)));
});

test('T23 Huella_SinFormaCanonica_ComoHoy @story-8.296 @ac-20', (t) => {
  const casa = casaNueva(t);
  const { story } = historiaConTres(t);
  for (const cmd of [`node ${MARKER} runtime-waiver ${story} --acs 1,a`, `node ${MARKER} runtime-waiver ${story} --acs 1 suelta --approved-by x`,
    `node ${MARKER} runtime-waiver ${story} --terminal --acs 1`]) {
    assert.strictEqual(ow.formaCanonica(ow.canonica(cmd), { historia: story }), null, cmd);
  }
  // sin forma canónica, la huella sale del texto: el orden distinto pregunta de nuevo
  const s = (cmd) => cuadroDe(casa, 'runtime-waiver', cmd).sello;
  assert.notStrictEqual(s(`node ${MARKER} runtime-waiver ${story} --acs 1,a --approved-by x`), s(`node ${MARKER} runtime-waiver ${story} --approved-by x --acs 1,a`));
  // la historia que no existe, o un --acs sin un criterio de verdad (0, 1.5): sin cuadro, como hoy
  for (const cmd of [`node ${MARKER} runtime-waiver /no/existe/9.94.md --acs 1`, `node ${MARKER} runtime-waiver ${story} --acs 0`,
    `node ${MARKER} runtime-waiver ${story} --acs 1.5`]) {
    const c = cuadroDe(casa, 'runtime-waiver', cmd);
    assert.ok(c.error, `${cmd}: ${JSON.stringify(c)}`);
  }
});

test('T24 Click_SelloDeAntes_NoSeToma_YLaGuiaLoDice @story-8.296 @ac-21', (t) => {
  // una firma sin fuente propia, con un click anotado a la huella sobre el texto tal cual (sha256(texto + "\0")): no vale
  const casa = casaNueva(t);
  const cmd = `node ${E2E} prepare --repo /r --story s.md`;
  const nuevo = cuadroDe(casa, 'browser-test', cmd);
  assert.ok(!nuevo.error, nuevo.error);
  const deAntes = crypto.createHash('sha256').update('e2e-setup.js prepare --repo /r --story s.md\0').digest('hex').slice(0, 8);
  assert.notStrictEqual(nuevo.sello.slice(-8), deAntes, 'la huella no cambió: el click de antes se tomaría');
  anotarClick(casa, nuevo.pregunta.replace(/código [0-9a-f]{8}/, `código ${deAntes}`));
  const r = pedirSinVentana(casa, cmd);
  assert.strictEqual(r.decision, 'deny', r.texto);
  const guia = fs.readFileSync(path.join(RAIZ, 'guides', 'firmas-del-arnes.md'), 'utf8');
  assert.match(guia, /forma canónica/);
  assert.match(guia, /al actualizar[^.]*(una vez más|otra vez)/);
});
