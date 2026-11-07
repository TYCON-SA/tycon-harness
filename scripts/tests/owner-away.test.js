'use strict';
// owner-away.test.js — la marca del dueño ausente: quién la pone, qué la borra y qué queda en el registro.
//
// Lo que no se puede perder:
//   · con la marca puesta, la política da «dueño ausente» enseguida, sin esperar los minutos;
//   · la borran un mensaje tipeado por la persona, un mensaje de la oficina verificado, una firma del dueño (terminal,
//     click, ventana) y el vencimiento a las 24 horas; un mensaje envuelto, uno de una sesión de fondo o una firma por
//     delegación no la borran;
//   · apagar el aviso del gancho de cada mensaje no apaga el borrado;
//   · cada puesta y cada borrado dejan su renglón `owner-away` con quién, la hora y la frase.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..', '..');
const OA = require(path.join(RAIZ, 'scripts', 'lib', 'owner-away.js'));
const P = require(path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'review-policy.js'));
const HOOK = path.join(RAIZ, 'scripts', 'hooks', 'coordination-notice.js');

// stable-data: horas fijas; el módulo no lee el reloj si se le pasa `ahora`
const T0 = Date.parse('2026-11-06T20:00:00Z');

function lab(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owner-away-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const estado = require(path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js')).stateDir(home);
  fs.mkdirSync(estado, { recursive: true });
  const renglones = () => { try { return fs.readFileSync(path.join(estado, 'gates.log'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter((j) => j.name === 'owner-away'); } catch (_) { return []; } };
  const firma = (via, ts) => fs.appendFileSync(path.join(estado, 'gates.log'), `${JSON.stringify({ ts: new Date(ts).toISOString(), name: 'plan-approval-signed', status: 'ok', via, sesion: 's1' })}\n`);
  return { home, estado, renglones, firma };
}

/** Un transcript de Claude Code con los mensajes dados (`humano`: tipeado por la persona). */
function transcript(dir, mensajes) {
  const f = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(f, mensajes.map((m) => JSON.stringify({ type: 'user', message: { role: 'user', content: m.texto }, ...(m.humano ? { origin: { kind: 'human' } } : { isMeta: true }) })).join('\n') + '\n');
  return f;
}

/** La sesión registrada en la máquina, con su tipo (`interactive` o `bg`), como la anota Claude Code. */
function sesion(home, sid, kind) {
  const dir = path.join(require(path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js')).claudeDir(home), 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ sessionId: sid, pid: process.pid, kind, status: 'busy' }));
}

test('T46 OwnerAway_LaMarcaSePoneRigeYSeBorraSola @story-8.221 @ac-36 — se pone con su frase, rige enseguida y se borra sola', (t) => {
  const L = lab(t);
  // puesta: rige sin esperar los minutos
  const s = OA.set({ estado: L.estado, quien: 'coordinadora', frase: 'seguí en autónomo, me voy', ahora: T0 });
  assert.strictEqual(s.codigo, 0);
  const m = OA.get({ estado: L.estado, ahora: T0 + 60000 }).mark;
  assert.ok(m);
  assert.strictEqual(P.ownerAway({ mark: m, askedAt: null, now: T0 + 60000, minutes: 20 }).away, true);
  assert.deepStrictEqual(L.renglones().map((r) => [r.accion, r.quien, r.frase]), [['set', 'coordinadora', 'seguí en autónomo, me voy']]);

  // una firma por delegación no la borra; una del dueño por click, sí
  L.firma('revision', T0 + 120000);
  L.firma('delegacion', T0 + 130000);
  assert.ok(OA.get({ estado: L.estado, ahora: T0 + 140000 }).mark, 'una firma por delegación no la borra');
  L.firma('click', T0 + 150000);
  const g = OA.get({ estado: L.estado, ahora: T0 + 160000 });
  assert.strictEqual(g.mark, null);
  assert.match(L.renglones().pop().motivo, /firma del dueño.*click/);

  // una firma vieja no borra una marca nueva; la ventana y la terminal la borran
  OA.set({ estado: L.estado, quien: 'coordinadora', frase: 'hasta mañana', ahora: T0 + 200000 });
  assert.ok(OA.get({ estado: L.estado, ahora: T0 + 210000 }).mark, 'la firma de antes no la borra');
  L.firma('ventana', T0 + 220000);
  assert.strictEqual(OA.get({ estado: L.estado, ahora: T0 + 230000 }).mark, null);
  OA.set({ estado: L.estado, quien: 'sesion-a', frase: 'me voy', ahora: T0 + 300000 });
  L.firma('terminal', T0 + 310000);
  assert.strictEqual(OA.get({ estado: L.estado, ahora: T0 + 320000 }).mark, null);
  // después del borrado, una firma por delegación no la vuelve a poner
  L.firma('delegacion', T0 + 330000);
  assert.strictEqual(OA.get({ estado: L.estado, ahora: T0 + 340000 }).mark, null);

  // el vencimiento a las 24 h
  OA.set({ estado: L.estado, quien: 'coordinadora', frase: 'me voy', ahora: T0 + 400000 });
  assert.ok(OA.get({ estado: L.estado, ahora: T0 + 400000 + 23 * 3600000 }).mark);
  assert.strictEqual(OA.get({ estado: L.estado, ahora: T0 + 400000 + 24 * 3600000 }).mark, null);
  assert.match(L.renglones().pop().motivo, /24 h/);

  // un mensaje de la oficina verificado la borra
  OA.set({ estado: L.estado, quien: 'coordinadora', frase: 'me voy', ahora: T0 + 500000 });
  OA.clear({ estado: L.estado, motivo: 'mensaje de la oficina verificado', ahora: T0 + 510000 });
  assert.strictEqual(OA.get({ estado: L.estado, ahora: T0 + 520000 }).mark, null);
  assert.ok(L.renglones().every((r) => r.ts && (r.accion === 'set' ? r.quien && r.frase : r.motivo)));
});

test('T46 OwnerAway_UnaMarcaRotaSeDice @story-8.221 @ac-36 — ilegible no es «sin marca»: get y clear dicen el problema, y el gancho lo escribe', (t) => {
  const L = lab(t);
  assert.deepStrictEqual(OA.get({ estado: L.estado, ahora: T0 }), { mark: null }, 'sin archivo no hay problema');
  fs.writeFileSync(path.join(L.estado, OA.ARCHIVO), '{ roto');
  const g = OA.get({ estado: L.estado, ahora: T0 });
  assert.strictEqual(g.mark, null, 'el dueño cuenta como presente');
  assert.match(g.problem, /no es JSON válido/);
  assert.match(OA.clear({ estado: L.estado, ahora: T0 }).problem, /no es JSON válido/);
  fs.writeFileSync(path.join(L.estado, OA.ARCHIVO), '{"quien":"x"}');
  assert.match(OA.get({ estado: L.estado, ahora: T0 }).problem, /falta setAt/);
  // el gancho de cada mensaje lo escribe en su salida de errores, sin frenar
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's-rota', prompt: 'hola' }),
    env: { ...process.env, HOME: L.home, USERPROFILE: L.home }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /marca de ausente: owner-away\.json no tiene la forma/);
});

test('T46 OwnerAway_ElMensajeDeLaPersonaLaBorra_YNoOtro @story-8.221 @ac-36 — el gancho de cada mensaje, también con el aviso apagado', (t) => {
  const L = lab(t);
  const correr = (prompt, mensajes, extra = {}, kind = 'interactive') => {
    sesion(L.home, 'ses-x', kind);
    const env = { ...process.env, HOME: L.home, USERPROFILE: L.home, ...extra };
    for (const k of ['TYCON_COORDINATION_NOTICE', 'TYCON_EVAL_SANDBOX']) if (!(k in extra)) delete env[k];
    return spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'ses-x', prompt, transcript_path: transcript(L.home, mensajes) }),
      encoding: 'utf8', env,
    });
  };
  const poner = () => OA.set({ estado: L.estado, quien: 'coordinadora', frase: 'me voy', ahora: Date.now() });
  // un mensaje envuelto de otra sesión no la borra
  poner();
  correr('<cross-session-message from="x">hola</cross-session-message>', [{ texto: '<cross-session-message from="x">hola</cross-session-message>', humano: false }]);
  assert.ok(OA.get({ estado: L.estado }).mark, 'un mensaje envuelto no la borra');
  // uno de una sesión de fondo, sólo con su encargo, no la borra
  correr('el encargo', [{ texto: 'el encargo', humano: true }], {}, 'bg');
  assert.ok(OA.get({ estado: L.estado }).mark, 'una sesión de fondo no la borra');
  // uno tipeado por la persona sí, aun con el aviso apagado y en la caja del banco
  for (const extra of [{}, { TYCON_COORDINATION_NOTICE: '0' }, { TYCON_EVAL_SANDBOX: '1' }]) {
    poner();
    const r = correr('ya volví', [{ texto: 'ya volví', humano: true }], extra);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(OA.get({ estado: L.estado }).mark, null, `con ${JSON.stringify(extra)} un mensaje de la persona la borra`);
    assert.match(L.renglones().pop().motivo, /mensaje de la persona/);
  }
});

test('T46 OwnerAway_ElMensajeDeLaOficinaVerificadoLaBorra @story-8.221 @ac-36 — sólo el que verify acepta', (t) => {
  const L = lab(t);
  const om = require(path.join(RAIZ, 'scripts', 'lib', 'office-messages.js'));
  const verify = (id, sid) => spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'tools', 'office-message.js'), 'verify', id], {
    encoding: 'utf8', input: '', env: { ...process.env, HOME: L.home, USERPROFILE: L.home, CLAUDE_CODE_SESSION_ID: sid },
  });
  OA.set({ estado: L.estado, quien: 'coordinadora', frase: 'me voy', ahora: Date.now() });
  const left = om.leave(L.estado, { sid: 's1', text: 'ya estoy', now: Date.now() });
  om.take(L.estado, 's1', { now: Date.now() });
  // uno rechazado (de otra sesión) no la borra
  assert.strictEqual(verify(left.id, 's2').status, 1);
  assert.ok(OA.get({ estado: L.estado }).mark, 'un mensaje rechazado no la borra');
  const ok = verify(left.id, 's1');
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.strictEqual(OA.get({ estado: L.estado }).mark, null);
  assert.match(L.renglones().pop().motivo, /mensaje de la oficina verificado/);
});
