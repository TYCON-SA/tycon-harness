'use strict';
/**
 * pending-approvals.test.js — un pendiente nuevo en la lista de pendientes no entra sin su aprobación firmada.
 *
 * La biblioteca (`scripts/lib/pending-approvals.js`) en proceso; el control (`scripts/ci/check-pending-approvals.js`)
 * sobre repos de prueba descartables; el comando de la firma (`marker.js approve-pending`) sólo en lo que sale antes de
 * pedir la firma; y la firma en el catálogo, el mapeo del comando y el freno de escritura del registro.
 *
 * Ninguna prueba escribe en el registro del arnés de la cuenta: el camino con su renglón se prueba en proceso, pasando
 * los renglones. El control con `--staged` lo lee (sólo lee), y la línea que se le da tiene una huella que no está ahí.
 *
 * stable-data: las horas son fijas; ninguna se compara con el reloj.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const PA = require(path.join(RAIZ, 'scripts', 'lib', 'pending-approvals.js'));
const CHECK = path.join(RAIZ, 'scripts', 'ci', 'check-pending-approvals.js');
const MARKER = path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'marker.js');
const sg = require(path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'story-gate.js'));
const ow = require(path.join(RAIZ, 'scripts', 'lib', 'owner-window.js'));
const { SIGNATURES } = require(path.join(RAIZ, 'scripts', 'lib', 'signatures.js'));

const AHORA = Date.parse('2026-10-28T12:00:00Z');
const LISTA = [
  '# Pendientes',
  '- [ ] [DEF-viejo] un pendiente que ya estaba',
  '- [x] [DEF-hecho] uno tachado',
  '  - [ ] un paso adentro de otro pendiente',
  '- [ ] (sin código) uno de antes que no tiene código',
  '',
].join('\n');
const SIN_CODIGO = '(sin código) uno de antes que no tiene código';
const base = (id) => JSON.stringify({ id, via: 'base', ts: '2026-10-28T00:00:00.000Z' });
const BASE = `${base('DEF-viejo')}\n${base(PA.claveSinCodigo(SIN_CODIGO))}\n`;

function firmada(id, via = 'delegacion') {
  const l = PA.lineaNueva({ id, maquina: 'abc', ahora: AHORA });
  return { ...l, via, quien: 'coordinadora (sesión s1)' };
}
const renglonDe = (l) => ({ name: PA.FIRMADA, status: 'ok', via: l.via, resumen: `huella ${l.huella} · ${l.id} · …` });

test('T1 los abiertos de la lista: con código, sin código por la huella de su texto; ni tachados ni pasos adentro', () => {
  const p = PA.pendientesAbiertos(LISTA);
  assert.deepStrictEqual(p.map((x) => x.clave), ['DEF-viejo', PA.claveSinCodigo(SIN_CODIGO)]);
  assert.strictEqual(p[1].codigo, null);
  assert.strictEqual(p[0].numero, 2);
  assert.strictEqual(PA.claveSinCodigo('a   b'), PA.claveSinCodigo(' a b '), 'los espacios de más no cambian la clave');
  // las otras viñetas de markdown y un espacio adelante también son casillas de primer nivel
  const otras = PA.pendientesAbiertos('* [ ] [DEF-a] x\n+ [ ] [DEF-b] x\n-  [ ] [DEF-c] x\n - [ ] [DEF-d] x\n   - [ ] [DEF-e] paso\n');
  assert.deepStrictEqual(otras.map((x) => x.codigo), ['DEF-a', 'DEF-b', 'DEF-c', 'DEF-d']);
});

test('T2 la lista entera aprobada por la base da verde', () => {
  const r = PA.revisar({ todo: LISTA, registro: BASE });
  assert.ok(r.ok, JSON.stringify(r));
});

test('T3 un pendiente nuevo sin aprobación lo nombra; con su línea firmada, verde', () => {
  const todo = `${LISTA}- [ ] [DEF-nuevo] algo que apareció\n`;
  const r = PA.revisar({ todo, registro: BASE });
  assert.ok(!r.ok);
  assert.deepStrictEqual(r.faltan.map((x) => x.codigo), ['DEF-nuevo']);
  const ok = PA.revisar({ todo, registro: `${BASE}${JSON.stringify(firmada('DEF-nuevo'))}\n` });
  assert.ok(ok.ok, JSON.stringify(ok));
});

test('T4 uno tachado que vuelve a abrirse es un pendiente nuevo', () => {
  const r = PA.revisar({ todo: LISTA.replace('- [x] [DEF-hecho]', '- [ ] [DEF-hecho]'), registro: BASE });
  assert.deepStrictEqual(r.faltan.map((x) => x.codigo), ['DEF-hecho']);
});

test('T5 un abierto sin código que no está en la base se nombra aparte: sin código no se aprueba', () => {
  const r = PA.revisar({ todo: `${LISTA}- [ ] otro sin código\n`, registro: BASE });
  assert.strictEqual(r.sinCodigo.length, 1);
  assert.strictEqual(r.faltan.length, 0);
});

test('T6 una línea firmada que se cambió después de firmar, o una ilegible, no vale y se nombra', () => {
  const l = firmada('DEF-viejo');
  const cambiada = JSON.stringify({ ...l, id: 'DEF-otro' });
  const r = PA.revisar({ todo: '- [ ] [DEF-otro] x\n', registro: `${cambiada}\nesto no es json\n` });
  assert.ok(!r.ok);
  assert.deepStrictEqual(r.faltan.map((x) => x.codigo), ['DEF-otro']);
  assert.deepStrictEqual(r.rotas.map((x) => x.numero), [2, 1]);
  assert.match(r.rotas[1].motivo, /huella/);
  for (const malo of [{ ...l, via: 'cita' }, { ...l, quien: '' }, { id: 'a b', via: 'base' }]) assert.ok(PA.motivoDe(malo), JSON.stringify(malo));
});

test('T7 lo que agrega un commit: una línea de base nueva nunca vale; una firmada, sólo con su renglón', () => {
  const l = firmada('DEF-nuevo');
  const despues = `${BASE}${JSON.stringify(l)}\n${base('DEF-colado')}\n`;
  const sin = PA.revisarNuevas({ antes: BASE, despues, renglones: [] });
  assert.deepStrictEqual(sin.map((x) => x.id), ['DEF-nuevo', 'DEF-colado']);
  assert.match(sin[0].motivo, /no se firmó en esta máquina/);
  assert.match(sin[1].motivo, /la base sólo se achica/);
  const con = PA.revisarNuevas({ antes: BASE, despues: `${BASE}${JSON.stringify(l)}\n`, renglones: [renglonDe(l)] });
  assert.deepStrictEqual(con, []);
  const otraVia = PA.revisarNuevas({ antes: BASE, despues: `${BASE}${JSON.stringify(l)}\n`, renglones: [{ ...renglonDe(l), via: 'ventana' }] });
  assert.strictEqual(otraVia.length, 1, 'el renglón tiene que ser de la misma vía');
  assert.deepStrictEqual(PA.revisarNuevas({ antes: BASE, despues: BASE, renglones: [] }), [], 'las líneas que ya estaban no se miran');
});

// un repo descartable con la lista y el registro, y un commit
function repo(todo, registro) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pendientes-'));
  const git = (...a) => spawnSync('git', ['-C', d, '-c', 'user.name=prueba', '-c', 'user.email=prueba@ejemplo.test', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' });
  git('init', '-q');
  fs.mkdirSync(path.join(d, 'tasks'));
  fs.writeFileSync(path.join(d, PA.TODO), todo);
  if (registro != null) fs.writeFileSync(path.join(d, PA.RECORD), registro);
  git('add', '-A');
  git('commit', '-q', '-m', 'inicio');
  return { d, git };
}
const check = (d, ...a) => spawnSync(process.execPath, [CHECK, '--repo', d, ...a], { encoding: 'utf8' });

test('T8 el control sobre el árbol: verde con todo aprobado, 1 nombrando el código y el comando con uno nuevo', (t) => {
  const { d } = repo(LISTA, BASE);
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const ok = check(d);
  assert.strictEqual(ok.status, 0, ok.stderr);
  fs.appendFileSync(path.join(d, PA.TODO), '- [ ] [DEF-nuevo] algo\n');
  const r = check(d);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /DEF-nuevo/);
  assert.match(r.stderr, /approve-pending --id DEF-nuevo/);
});

test('T9 un repo sin lista no tiene nada que revisar; una lista sin registro frena con todo lo abierto', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pendientes-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  assert.strictEqual(check(d).status, 0);
  const { d: d2 } = repo(LISTA, null);
  t.after(() => fs.rmSync(d2, { recursive: true, force: true }));
  const r = check(d2);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /DEF-viejo/);
});

test('T10 el control del commit mira el índice: lo que está en el disco sin agregar no cuenta', (t) => {
  const { d, git } = repo(LISTA, BASE);
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.appendFileSync(path.join(d, PA.TODO), '- [ ] [DEF-nuevo] algo\n');
  assert.strictEqual(check(d, '--staged').status, 0, 'sin agregar, el commit no lo lleva');
  git('add', PA.TODO);
  const r = check(d, '--staged');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /DEF-nuevo/);
});

test('T11 el control del commit frena una aprobación escrita a mano: su huella no está en el registro del arnés', (t) => {
  const { d, git } = repo(LISTA, BASE);
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.appendFileSync(path.join(d, PA.TODO), '- [ ] [DEF-nuevo] algo\n');
  // una hora que ningún registro real tiene: la huella no puede estar firmada
  const l = { ...PA.lineaNueva({ id: 'DEF-nuevo', maquina: 'prueba-sin-firma', ahora: Date.parse('2001-01-01T00:00:00Z') }), via: 'ventana', quien: 'alguien' };
  fs.appendFileSync(path.join(d, PA.RECORD), `${JSON.stringify(l)}\n`);
  git('add', '-A');
  assert.strictEqual(check(d).status, 0, 'sobre el árbol la línea está sana');
  const r = check(d, '--staged');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /no se firmó en esta máquina/);
});

test('T12 el control del commit frena una línea de base nueva', (t) => {
  const { d, git } = repo(LISTA, BASE);
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.appendFileSync(path.join(d, PA.TODO), '- [ ] [DEF-colado] algo\n');
  fs.appendFileSync(path.join(d, PA.RECORD), `${base('DEF-colado')}\n`);
  git('add', '-A');
  const r = check(d, '--staged');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /la base sólo se achica/);
});

test('T13 una opción que no conoce sale 2: un control que no leyó no es un verde', () => {
  assert.strictEqual(spawnSync(process.execPath, [CHECK, '--unknown-flag'], { encoding: 'utf8' }).status, 2);
});

test('T14 approve-pending sale sin pedir firma ni escribir: sin código, con cita, con un código que no está abierto, fuera de un repo', (t) => {
  const { d } = repo(LISTA, BASE);
  const fuera = fs.mkdtempSync(path.join(os.tmpdir(), 'pendientes-fuera-'));
  t.after(() => { fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(fuera, { recursive: true, force: true }); });
  const env = { ...process.env };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'NODE_TEST_CONTEXT']) delete env[k];
  const corre = (...a) => spawnSync(process.execPath, [MARKER, 'approve-pending', ...a], { encoding: 'utf8', env, cwd: d });
  assert.strictEqual(corre().status, 2);
  const cita = corre('--id', 'DEF-viejo', '--quote', 'dale');
  assert.strictEqual(cita.status, 1);
  assert.match(cita.stderr, /no aprueban/);
  const noEsta = corre('--id', 'DEF-hecho', '--repo', d);
  assert.strictEqual(noEsta.status, 1);
  assert.match(noEsta.stderr, /no es un pendiente abierto/);
  assert.strictEqual(corre('--id', 'DEF-viejo', '--repo', fuera).status, 2);
  assert.strictEqual(fs.readFileSync(path.join(d, PA.RECORD), 'utf8'), BASE, 'el registro quedó como estaba');
});

test('T15 la firma está en el catálogo, se puede dar desde otra sesión, y el comando la pide', () => {
  const s = SIGNATURES.find((x) => x.id === PA.FIRMA);
  assert.ok(s, 'pending-approval en el catálogo');
  assert.strictEqual(s.otherSession, 'yes');
  assert.strictEqual(s.kind, 'guion');
  assert.deepStrictEqual(ow.firmasDelComando(`node ${MARKER} approve-pending --id DEF-x --repo /tmp/r`), [PA.FIRMA]);
});

test('T16 el registro no se escribe a mano: el freno de edición lo para en cualquier repo, la lista no', () => {
  assert.strictEqual(sg.signedRecordKind('/r/tasks/pending-approvals.jsonl'), 'pending-approvals');
  assert.strictEqual(sg.signedRecordKind('/r/tasks/todo.md'), null);
  assert.strictEqual(sg.signedRecordKind('/r/otra/pending-approvals.jsonl'), null);
  const r = sg.computeStoryGate({ filePath: '/r/tasks/pending-approvals.jsonl', gateEnabled: false, marker: null, adhoc: null });
  assert.strictEqual(r.action, 'block');
  assert.match(sg.blockMessage(r, { filePath: '/r/tasks/pending-approvals.jsonl' }), /approve-pending/);
});

test('T17 un código que ya tiene aprobación no abre otro pendiente: el commit que lo abre trae su firma nueva', () => {
  // la base aprueba DEF-viejo; se tacha y en el mismo commit se abre otro renglón con ese código
  const todoAntes = LISTA;
  const todoDespues = LISTA.replace('- [ ] [DEF-viejo] un pendiente que ya estaba', '- [x] [DEF-viejo] un pendiente que ya estaba').replace('- [x] [DEF-hecho] uno tachado', '- [ ] [DEF-viejo] algo nuevo con un código viejo');
  assert.ok(PA.revisar({ todo: todoDespues, registro: BASE }).ok, 'sobre el árbol el código está aprobado');
  const malas = PA.revisarNuevas({ antes: BASE, despues: BASE, renglones: [], todoAntes: todoAntes.replace('- [ ] [DEF-viejo]', '- [x] [DEF-viejo]'), todoDespues });
  assert.deepStrictEqual(malas.map((x) => x.id), ['DEF-viejo']);
  assert.match(malas[0].motivo, /aprobación vieja/);
  // uno tachado que se reabre, con su línea vieja de base
  const reabre = PA.revisarNuevas({ antes: BASE, despues: BASE, renglones: [], todoAntes: LISTA.replace('- [ ] [DEF-viejo]', '- [x] [DEF-viejo]'), todoDespues: LISTA });
  assert.deepStrictEqual(reabre.map((x) => x.id), ['DEF-viejo']);
  // con la firma nueva en el mismo commit, entra
  const l = firmada('DEF-viejo');
  const conFirma = PA.revisarNuevas({ antes: BASE, despues: `${BASE}${JSON.stringify(l)}\n`, renglones: [renglonDe(l)], todoAntes: LISTA.replace('- [ ] [DEF-viejo]', '- [x] [DEF-viejo]'), todoDespues: LISTA });
  assert.deepStrictEqual(conFirma, []);
  // un pendiente que ya estaba abierto y sólo cambia su texto no pide nada
  assert.deepStrictEqual(PA.revisarNuevas({ antes: BASE, despues: BASE, renglones: [], todoAntes: LISTA, todoDespues: LISTA.replace('que ya estaba', 'reescrito') }), []);
});

test('T18 dos renglones abiertos con el mismo código frenan sobre el árbol', () => {
  const r = PA.revisar({ todo: `${LISTA}- [ ] [DEF-viejo] otro con el mismo código\n`, registro: BASE });
  assert.ok(!r.ok);
  assert.deepStrictEqual(r.repetidos.map((x) => x.codigo), ['DEF-viejo']);
});

test('T19 el commit que crea el registro trae la base, sólo de lo que ya estaba abierto', () => {
  assert.deepStrictEqual(PA.revisarNuevas({ antes: '', despues: BASE, renglones: [], todoAntes: LISTA, todoDespues: LISTA }), []);
  const colado = PA.revisarNuevas({ antes: '', despues: `${BASE}${base('DEF-nuevo')}\n`, renglones: [], todoAntes: LISTA, todoDespues: `${LISTA}- [ ] [DEF-nuevo] x\n` });
  assert.deepStrictEqual(colado.map((x) => x.id), ['DEF-nuevo', 'DEF-nuevo']);
  assert.match(colado[0].motivo, /no estaba abierto antes de este commit/);
});

test('T20 el control del commit: crear el registro con la base pasa; reabrir con un código aprobado frena', (t) => {
  const { d, git } = repo(LISTA, null);
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.writeFileSync(path.join(d, PA.RECORD), BASE);
  git('add', '-A');
  const nace = check(d, '--staged');
  assert.strictEqual(nace.status, 0, nace.stderr);
  git('commit', '-q', '-m', 'registro');
  fs.writeFileSync(path.join(d, PA.TODO), LISTA.replace('- [ ] [DEF-viejo] un pendiente que ya estaba', '- [ ] [DEF-viejo] un pendiente que ya estaba\n- [x] tachado aparte').replace('- [x] [DEF-hecho] uno tachado', '- [ ] [DEF-hecho] reabierto'));
  fs.appendFileSync(path.join(d, PA.RECORD), `${JSON.stringify({ id: 'DEF-hecho', via: 'base', ts: '2026-10-28T00:00:00.000Z' })}\n`);
  git('add', '-A');
  const r = check(d, '--staged');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /la base sólo se achica/);
  assert.match(r.stderr, /no trae su aprobación firmada en este commit/);
});

test('T21 el registro con el que nace: todo lo abierto en el último commit va de base; se quedan las firmas de lo abierto después', () => {
  const despues = JSON.stringify(firmada('DEF-despues'));
  const rota = JSON.stringify({ ...firmada('DEF-roto'), huella: '0000000000000000' });
  const viejo = `${base('DEF-cerrado')}\n${JSON.stringify(firmada('DEF-viejo'))}\n${despues}\n${rota}\n`;
  const r = PA.registroDelNacimiento({ antes: '', registro: viejo, todoAntes: LISTA });
  assert.ok(!r.error, r.error);
  // DEF-viejo va de base aunque traiga firma (la de otra máquina no pasaría el commit); DEF-cerrado y la rota salen
  assert.deepStrictEqual(PA.leerRegistro(r.texto).lineas.map((x) => [x.valor.id, x.valor.via]),
    [['DEF-viejo', 'base'], [PA.claveSinCodigo(SIN_CODIGO), 'base'], ['DEF-despues', 'delegacion']]);
  assert.deepStrictEqual([r.base, r.firmadas, r.descartadas], [2, 1, 3]);
  assert.ok(PA.revisar({ todo: LISTA, registro: r.texto }).ok, 'lo que arma cubre la lista');
  assert.deepStrictEqual(PA.revisarNuevas({ antes: '', despues: r.texto, renglones: [renglonDe(firmada('DEF-despues'))], todoAntes: LISTA, todoDespues: `${LISTA}- [ ] [DEF-despues] x\n` }), [], 'el commit que crea el registro lo acepta');
  // sin registro en el disco: toda la lista va de base
  assert.strictEqual(PA.registroDelNacimiento({ todoAntes: LISTA }).texto, `${JSON.stringify({ id: 'DEF-viejo', via: 'base' })}\n${JSON.stringify({ id: PA.claveSinCodigo(SIN_CODIGO), via: 'base' })}\n`);
  // ya nacido, o con un renglón que no se lee: no arma nada
  assert.match(PA.registroDelNacimiento({ antes: BASE, registro: BASE, todoAntes: LISTA }).error, /ya nació/);
  assert.match(PA.registroDelNacimiento({ registro: 'no es json\n', todoAntes: LISTA }).error, /no se leen/);
});

test('T22 --create-base: arma lo que el commit que crea el registro acepta, y con el registro ya commiteado no escribe', (t) => {
  const { d, git } = repo(`${LISTA}- [ ] [DEF-commiteado] abierto en el commit\n`, null);
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  // en el disco, una base vieja con un pendiente que ya se cerró y la lista con uno que no está commiteado
  fs.writeFileSync(path.join(d, PA.RECORD), `${base('DEF-cerrado')}\n`);
  fs.appendFileSync(path.join(d, PA.TODO), '- [ ] [DEF-del-disco] escrito después del commit\n');
  const r = check(d, '--create-base');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /3 línea\(s\) de base y 0 aprobación\(es\) firmada\(s\)\. Descarté 1 línea/);
  const ids = PA.leerRegistro(fs.readFileSync(path.join(d, PA.RECORD), 'utf8')).lineas.map((x) => x.valor.id);
  assert.deepStrictEqual(ids, ['DEF-viejo', PA.claveSinCodigo(SIN_CODIGO), 'DEF-commiteado'], 'sale de la lista commiteada, sin la base vieja');
  git('add', PA.RECORD);
  const nace = check(d, '--staged');
  assert.strictEqual(nace.status, 0, nace.stderr);
  git('commit', '-q', '-m', 'registro');
  const antes = fs.readFileSync(path.join(d, PA.RECORD), 'utf8');
  const otra = check(d, '--create-base');
  assert.strictEqual(otra.status, 1);
  assert.match(otra.stderr, /ya nació.*No escribí nada/);
  assert.strictEqual(fs.readFileSync(path.join(d, PA.RECORD), 'utf8'), antes);
  assert.strictEqual(check(d, '--create-base', '--staged').status, 2, 'las dos opciones juntas no van');
});

test('T23 el comando que se sugiere para aprobar es el que approve-pending acepta: sin --for-session', (t) => {
  const { d } = repo(`${LISTA}- [ ] [DEF-nuevo] algo\n`, BASE);
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const r = check(d);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /approve-pending --id DEF-nuevo --repo \S+\n/);
  assert.doesNotMatch(r.stderr, /--for-session/);
  assert.doesNotMatch(SIGNATURES.find((x) => x.id === PA.FIRMA).command, /--for-session/);
  assert.doesNotMatch(sg.blockMessage({ action: 'block', kind: 'pending-approvals', reason: 'x' }, { filePath: '/r/tasks/pending-approvals.jsonl' }), /--for-session/);
});
