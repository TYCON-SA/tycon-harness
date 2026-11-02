'use strict';
// session-transcript.test.js — lo que la oficina lee de la conversación de una sesión sin pipeline: el encargo, lo que
// está haciendo y su última acción. Sólo el principio y el final del archivo, y nada de eso queda escrito.
// stable-data: las fechas de las conversaciones de juguete y el «ahora» son fijos; sólo el nombre de las carpetas
// temporales cambia.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { readTranscript, peerMessagesSince, readConversation, coverSecrets, HEAD_BYTES, TAIL_BYTES } = require(path.join(ROOT, 'scripts', 'lib', 'session-transcript.js'));

const NOW = Date.parse('2026-11-01T22:00:00.000Z');
const hm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const at = (min) => new Date(NOW - min * 60000).toISOString();
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-'));
const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

const human = (text, min = 30) => ({ type: 'user', isSidechain: false, timestamp: at(min), message: { role: 'user', content: text } });
const said = (text, min = 5) => ({ type: 'assistant', isSidechain: false, timestamp: at(min), message: { role: 'assistant', content: [{ type: 'text', text }] } });
const tool = (name, input, min = 4) => ({ type: 'assistant', isSidechain: false, timestamp: at(min), message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] } });
const result = (min = 3) => ({ type: 'user', isSidechain: false, timestamp: at(min), message: { role: 'user', content: [{ type: 'tool_result', content: 'salida de la herramienta' }] }, toolUseResult: {} });
const write = (file, lines) => fs.writeFileSync(file, `${lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}\n`);

test('T98 Transcript_EncargoNowLastAction @story-2.81 @ac-53 — el encargo, lo que hace ahora y su última acción, en llano', () => {
  const file = path.join(dir(), 's.jsonl');
  const long = `Sos Tina. Leé /Users/x/repo/specs/story-8.3-algo.md. Encargo: ${'ordená las pruebas del tablero '.repeat(20)}`;
  write(file, [
    { type: 'custom-title', customTitle: 'Tina', sessionId: 's' },
    { type: 'attachment', timestamp: at(40), attachment: { type: 'hook_success', content: 'un aviso del gancho' } },
    { type: 'user', isMeta: true, timestamp: at(39), message: { role: 'user', content: 'un aviso que no escribió la persona' } },
    human('<system-reminder>un recordatorio</system-reminder>', 38),
    result(37),
    human(long, 36),
    said('Primero miro el código. Reviso las pruebas del tablero y sigo con el kanban.'),
    tool('Edit', { file_path: '/Users/x/repo/scripts/tools/office.js', old_string: 'secreto del archivo' }),
    result(),
    // un agente interno no es la sesión
    { type: 'assistant', isSidechain: true, timestamp: at(1), message: { role: 'assistant', content: [{ type: 'text', text: 'Lo dice un agente interno.' }] } },
  ]);
  const r = readTranscript(file, { now: NOW });
  assert.ok(r.encargo.startsWith('Sos Tina.'), r.encargo);
  assert.ok(Array.from(r.encargo).length <= 140, r.encargo);
  assert.doesNotMatch(r.encargo, /\/Users|story-8\.3|\n/);
  assert.strictEqual(r.haciendoAhora, 'Primero miro el código.', 'la primera oración de su último mensaje: su conclusión');
  assert.strictEqual(r.ultimaAccion, `Editar · office.js · a las ${hm(NOW - 4 * 60000)}`);
  assert.doesNotMatch(JSON.stringify(r), /secreto del archivo|un aviso/);
  // la frase larga se recorta, y un comando no se muestra
  const other = path.join(dir(), 's.jsonl');
  write(other, [human('Hacé esto'), said(`Sigo con ${'una frase muy larga '.repeat(20)}`), tool('Bash', { command: 'curl https://secreto.example' }, 90)]);
  const r2 = readTranscript(other, { now: NOW });
  assert.ok(Array.from(r2.haciendoAhora).length <= 160);
  assert.strictEqual(r2.ultimaAccion, `Ejecutar un comando · a las ${hm(NOW - 90 * 60000)}`);
  assert.doesNotMatch(JSON.stringify(r2), /secreto\.example/);
});

test('T100 Transcript_MissingOrBroken_NoNews @story-2.81 @ac-54 — sin conversación legible no hay texto, y lo roto se saltea', () => {
  const d = dir();
  const missing = readTranscript(path.join(d, 'no-esta.jsonl'), { now: NOW });
  assert.deepStrictEqual([missing.encargo, missing.haciendoAhora, missing.ultimaAccion, missing.problem], [null, null, null, null]);
  const empty = path.join(d, 'vacia.jsonl');
  fs.writeFileSync(empty, '');
  fs.utimesSync(empty, new Date(NOW - 600000), new Date(NOW - 600000));
  const e = readTranscript(empty, { now: NOW });
  assert.strictEqual(e.haciendoAhora, null);
  assert.strictEqual(e.lastWriteMs, NOW - 600000, 'dice de cuándo es la última escritura');
  assert.strictEqual(hhmm(e.lastWriteMs), hhmm(NOW - 600000));
  const broken = path.join(d, 'rota.jsonl');
  write(broken, ['{ roto', human('El encargo de verdad'), 'tampoco es json', said('Sigo.')]);
  const b = readTranscript(broken, { now: NOW });
  assert.strictEqual(b.encargo, 'El encargo de verdad');
  assert.strictEqual(b.haciendoAhora, 'Sigo.');
  if (process.platform !== 'win32' && process.getuid() !== 0) {
    const locked = path.join(d, 'cerrada.jsonl');
    write(locked, [human('un texto que no se tiene que ver')]);
    fs.chmodSync(locked, 0o000);
    const l = readTranscript(locked, { now: NOW });
    fs.chmodSync(locked, 0o600);
    assert.match(l.problem, /EACCES/);
    assert.doesNotMatch(JSON.stringify(l), /un texto que no se tiene que ver/);
    assert.strictEqual(l.encargo, null);
  }
});

test('T101 Transcript_ReadsOnlyHeadAndTail_WritesNothing @story-2.81 @ac-55 — de 50 MB lee el principio y el final, y no escribe nada', () => {
  const d = dir();
  const file = path.join(d, 'grande.jsonl');
  const head = `${JSON.stringify(human('El encargo del principio'))}\n`;
  const tail = `\n${JSON.stringify(said('Lo último que dijo.'))}\n`;
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, head);
  fs.ftruncateSync(fd, 50 * 1024 * 1024);
  fs.writeSync(fd, tail, 50 * 1024 * 1024 - tail.length);
  fs.closeSync(fd);
  let bytes = 0;
  let calls = 0;
  const readSync = (...a) => { calls += 1; const n = fs.readSync(...a); bytes += n; return n; };
  const before = fs.readdirSync(d);
  const r = readTranscript(file, { now: NOW, io: { readSync } });
  assert.strictEqual(r.encargo, 'El encargo del principio');
  assert.strictEqual(r.haciendoAhora, 'Lo último que dijo.');
  assert.strictEqual(HEAD_BYTES, 64 * 1024);
  assert.strictEqual(TAIL_BYTES, 256 * 1024);
  assert.ok(bytes <= HEAD_BYTES + TAIL_BYTES, `leyó ${bytes} bytes en ${calls} lecturas`);
  assert.deepStrictEqual(fs.readdirSync(d), before, 'no deja nada en disco');
  // un renglón cortado al principio del final y al final del principio se saltea, sin romper
  const cut = path.join(d, 'cortada.jsonl');
  const pad = 'x'.repeat(70 * 1024);
  write(cut, [human(`Empieza con un mensaje muy largo ${pad}`), ...Array.from({ length: 6 }, () => said(`Relleno ${pad}.`)), said('La última frase.')]);
  const c = readTranscript(cut, { now: NOW });
  assert.strictEqual(c.encargo, null, 'el primer mensaje quedó cortado: no se inventa');
  assert.strictEqual(c.haciendoAhora, 'La última frase.');
  // la lectura de la oficina no guarda el texto: la foto se guarda sin la conversación
  const { collect } = require(path.join(ROOT, 'scripts', 'tools', 'office.js'));
  const { stateDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
  const home = dir();
  const sdir = stateDir(home);
  for (const x of ['active', 'adhoc', 'doing']) fs.mkdirSync(path.join(sdir, x), { recursive: true });
  const sessions = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const cwd = path.join(home, 'obra');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(sessions, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 's-1', name: 'Tina', status: 'busy', statusUpdatedAt: NOW, cwd }));
  const conv = path.join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9-]/g, '-'));
  fs.mkdirSync(conv, { recursive: true });
  write(path.join(conv, 's-1.jsonl'), [human('Un encargo privado de la sesión'), said('Una frase privada de la sesión.')]);
  return collect({ home, now: new Date(NOW).toISOString(), siteUrl: async () => ({ code: 3, out: '' }), quietMinutes: async () => ({ code: 3, out: '' }), projectsDir: path.dirname(conv), sessionsDir: sessions }).then((data) => {
    const a = data.agents.find((x) => x.nombre === 'Tina');
    assert.strictEqual(a.encargo, 'Un encargo privado de la sesión');
    assert.strictEqual(a.haciendoAhora, 'Una frase privada de la sesión.');
    assert.doesNotMatch(fs.readFileSync(path.join(sdir, 'office', 'promises.json'), 'utf8'), /privad/);
  });
});

test('T102 Transcript_Codex_KnownOrNothing @story-2.81 @ac-55 — el formato de Codex de hoy se lee; uno desconocido, nada', () => {
  const d = dir();
  const file = path.join(d, 'rollout-2026-11-01T21-00-00-01a19a3a-9aec.jsonl');
  const item = (payload, min = 5) => ({ timestamp: at(min), type: 'response_item', payload });
  write(file, [
    { timestamp: at(40), type: 'session_meta', payload: { id: '01a19a3a-9aec', cwd: '/x', base_instructions: { text: 'instrucciones largas' } } },
    { timestamp: at(39), type: 'event_msg', payload: { type: 'task_started', turn_id: 't' } },
    item({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<skills_instructions>' }] }, 38),
    item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\n\n<INSTRUCTIONS>\nreglas' }] }, 37),
    item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>la carpeta</environment_context>' }] }, 36),
    item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Ordená las pruebas de la oficina.' }] }, 35),
    item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Miro el código. Sigo con el kanban.' }] }, 6),
    item({ type: 'custom_tool_call', name: 'exec', input: 'rm secreto' }, 5),
    item({ type: 'custom_tool_call_output', output: 'salida' }, 4),
  ]);
  const r = readTranscript(file, { now: NOW, tool: 'codex' });
  assert.strictEqual(r.encargo, 'Ordená las pruebas de la oficina.');
  assert.strictEqual(r.haciendoAhora, 'Miro el código.');
  assert.strictEqual(r.ultimaAccion, `Ejecutar un comando · a las ${hm(NOW - 5 * 60000)}`);
  assert.doesNotMatch(JSON.stringify(r), /secreto/);
  const unknown = path.join(d, 'rollout-otro.jsonl');
  write(unknown, [{ kind: 'mensaje', texto: 'un formato que no conozco' }, { kind: 'respuesta', texto: 'otra cosa' }]);
  const u = readTranscript(unknown, { now: NOW, tool: 'codex' });
  assert.deepStrictEqual([u.encargo, u.haciendoAhora, u.ultimaAccion, u.problem], [null, null, null, null]);
});

test('T145 Transcript_LastSentenceIsProse @story-2.81 @ac-53: una fila de tabla o un bloque de código no son «lo que está haciendo»', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-prosa-'));
  const f = path.join(d, 's.jsonl');
  const say = (text) => [{ type: 'user', timestamp: at(9), message: { content: 'Encargo' } }, { type: 'assistant', timestamp: at(1), message: { content: [{ type: 'text', text }] } }];
  write(f, say('Sigo con el kanban.\n\n| Cosa | Estado |\n|---|---|\n| Mapa | Hecho |'));
  assert.strictEqual(readTranscript(f, { now: NOW }).haciendoAhora, 'Sigo con el kanban.');
  write(f, say('Corro esto.\n```bash\nnode x\n```'));
  assert.strictEqual(readTranscript(f, { now: NOW }).haciendoAhora, 'Corro esto.');
  write(f, say(`Mi correo es ana${'@'}acme.com y sigo.`));
  assert.doesNotMatch(String(readTranscript(f, { now: NOW }).haciendoAhora), /@/);
});

test('T200 Transcript_OnlyWholeSentences: una oración a la que le faltaría una ruta o un código no se muestra a medias', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trans-enteras-')), 's.jsonl');
  const line = (o) => `${JSON.stringify(o)}\n`;
  const user = (t) => line({ type: 'user', message: { content: t } });
  const said = (t) => line({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
  fs.writeFileSync(f, user('Corregir los datos de /office. Leé y hacé ~/Documents/encargo.md') + said('Terminé la prueba. Está en la memoria `notas.md`.'));
  const r = readTranscript(f);
  assert.strictEqual(r.encargo, 'Corregir los datos de /office.');
  assert.strictEqual(r.haciendoAhora, 'Terminé la prueba.');
  fs.writeFileSync(f, user('Leé y hacé ~/x/encargo.md') + said('Todo está en rama `fix/algo`.'));
  const nada = readTranscript(f);
  assert.strictEqual(nada.encargo, null, 'sin una oración entera no hay encargo');
  assert.strictEqual(nada.haciendoAhora, null, 'ni qué dice que hace');
});

test('T201 Transcript_Abbreviation_NotASentence: «Sr. García» no parte la oración', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trans-abrev-')), 's.jsonl');
  fs.writeFileSync(f, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Listo. Hablé con el Sr. García del informe.' }] } })}\n`);
  assert.strictEqual(readTranscript(f).haciendoAhora, 'Hablé con el Sr. García del informe.');
});

test('T221 Transcript_NowSaysWhatItDoes: una pregunta o un consejo no dicen qué hace; lo de un mensaje anterior ya no vale', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trans-hace-')), 's.jsonl');
  const text = (t) => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
  const now = (...lines) => { fs.writeFileSync(f, `${lines.map((l) => JSON.stringify(text(l))).join('\n')}\n`); return readTranscript(f).haciendoAhora; };
  assert.strictEqual(now('Conviene abrirlo en una sesión nueva. ¿Arranco?'), null);
  assert.strictEqual(now('Corro las pruebas. ¿Querés el detalle?'), 'Corro las pruebas.');
  assert.strictEqual(now('Reviso el panel.', '¿Arranco?'), null, 'un mensaje anterior no dice lo de ahora');
  assert.strictEqual(now('Listo. Reviso el panel.'), 'Reviso el panel.');
  assert.strictEqual(now('Espero que entre el #907 y el pedido 6106.'), 'Espero que entre el #907 y el pedido 6106.', 'el pedido queda: sin él la oración no dice nada');
});

test('T222 Transcript_EncargoFirstSentence: del encargo, la primera oración; las instrucciones de método no van', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trans-encargo-')), 's.jsonl');
  fs.writeFileSync(f, `${JSON.stringify({ type: 'user', message: { content: 'Urgente: el freno no ve el click. Avisá a la Coordinadora al arrancar. Decí «ejecución».' } })}\n`);
  assert.strictEqual(readTranscript(f).encargo, 'Urgente: el freno no ve el click.');
});

// Una conversación con mensajes entre sesiones, con la forma medida en las reales.
const peer = (name, body, min, id = `m-${name}-${min}`) => ({ type: 'user', isMeta: true, timestamp: at(min), origin: { kind: 'peer', name, body, msg_id: id }, message: { role: 'user', content: `<cross-session-message from="x">${body}</cross-session-message>` } });
const sent = (to, message, min) => ({ type: 'assistant', isSidechain: false, timestamp: at(min), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'SendMessage', input: { to, message } }] } });
const person = (text, min) => ({ type: 'user', timestamp: at(min), origin: { kind: 'human' }, message: { role: 'user', content: text } });
const turnEnd = (min) => ({ type: 'system', subtype: 'stop_hook_summary', timestamp: at(min) });

test('T240 Envelopes_OnlyWhatGrew: lee sólo lo nuevo, trae quién y no el texto; si el archivo no creció, no da nada', () => {
  const file = path.join(dir(), 's.jsonl');
  write(file, [said('Empiezo.', 9), peer('Coordinadora', 'el texto del mensaje', 8)]);
  const first = peerMessagesSince(file, 0);
  assert.deepStrictEqual(first.items.map((m) => [m.id, m.de]), [['m-Coordinadora-8', 'Coordinadora']]);
  assert.ok(!JSON.stringify(first).includes('el texto del mensaje'), 'el sobre no lleva el texto');
  assert.deepStrictEqual(peerMessagesSince(file, first.offset), { offset: first.offset, items: [] });
  fs.appendFileSync(file, `${JSON.stringify(peer('Bruno', 'otro', 2))}\n${JSON.stringify(said('Sigo.', 1)).slice(0, 10)}`);
  const second = peerMessagesSince(file, first.offset);
  assert.deepStrictEqual(second.items.map((m) => m.de), ['Bruno'], 'un renglón a medio escribir queda para la próxima');
  assert.ok(second.offset < fs.statSync(file).size);
  assert.deepStrictEqual(peerMessagesSince(path.join(dir(), 'no-esta.jsonl'), 0), { offset: 0, items: [] });
});

test('T241 Envelopes_NotFromAgents: un mensaje de un subagente o una mención en un texto no son un sobre', () => {
  const file = path.join(dir(), 's.jsonl');
  write(file, [{ ...peer('Coordinadora', 'de un agente', 8), isSidechain: true }, said('Dije "kind":"peer" en un texto.', 7), { ...peer('', 'sin nombre', 6) }]);
  assert.deepStrictEqual(peerMessagesSince(file, 0).items, []);
});

test('T242 Conversation_Session: sus mensajes con la coordinadora, en orden, y los de otras sesiones no', () => {
  const file = path.join(dir(), 's.jsonl');
  write(file, [peer('Coordinadora', 'Hacé la tanda.', 9), sent('Ferrari', 'A otra sesión.', 8), sent('Coordinadora [8e42be]', 'Arranco.', 7), peer('Ferrari', 'De otra sesión.', 6)]);
  const got = readConversation(file, { coordinator: 'Coordinadora' });
  assert.deepStrictEqual(got.conCoordinadora.map((m) => [m.propio, m.texto]), [[false, 'Hacé la tanda.'], [true, 'Arranco.']]);
});

test('T243 Conversation_NoCoordinator: sin coordinadora no hay conversación que mostrar', () => {
  const file = path.join(dir(), 's.jsonl');
  write(file, [person('Hola', 9), said('Hola.', 8)]);
  assert.deepStrictEqual(readConversation(file, { coordinator: null, isCoordinator: false }), { sinCoordinadora: true });
});

test('T244 Conversation_WithPerson: cada mensaje con su respuesta, en orden; lo que contestó a una sesión no es una respuesta a la persona', () => {
  const file = path.join(dir(), 's.jsonl');
  write(file, [
    person('¿Cómo va?', 20), said('Lo miro.', 19), said('Va bien.', 18), turnEnd(18),
    peer('Bruno', 'Terminé.', 15), said('Gracias, Bruno.', 14), turnEnd(14),
    person('Seguí.', 10), sent('Bruno', 'Seguí vos.', 9), said('Le avisé.', 8), turnEnd(8),
    { type: 'user', isMeta: true, timestamp: at(7), message: { role: 'user', content: 'un aviso de un gancho' } },
    { type: 'user', timestamp: at(6), origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>x</task-notification>' } },
  ]);
  const got = readConversation(file, { coordinator: 'Coordinadora', isCoordinator: true });
  assert.deepStrictEqual(got.conVos.map((m) => [m.quien, m.texto]), [['vos', '¿Cómo va?'], ['coordinadora', 'Va bien.'], ['vos', 'Seguí.'], ['coordinadora', 'Le avisé.']]);
  assert.deepStrictEqual(got.conSesiones.map((m) => [m.de, m.a, m.texto]), [['Bruno', 'Coordinadora', 'Terminé.'], ['Coordinadora', 'Bruno', 'Seguí vos.']]);
});

test('T245 Conversation_Limits: se queda con los últimos 20 de la persona, y un tope de lectura lo corta sin romperse', () => {
  const file = path.join(dir(), 's.jsonl');
  const lines = [];
  for (let i = 30; i > 0; i -= 1) lines.push(person(`mensaje ${i}`, i * 2), said(`respuesta ${i}`, i * 2 - 1), turnEnd(i * 2 - 1));
  write(file, lines);
  const got = readConversation(file, { coordinator: 'Coordinadora', isCoordinator: true });
  const mine = got.conVos.filter((m) => m.quien === 'vos');
  assert.strictEqual(mine.length, 20);
  assert.strictEqual(mine[0].texto, 'mensaje 20');
  assert.strictEqual(got.conVos[got.conVos.length - 1].texto, 'respuesta 1');
  // el tope cuenta de a tramos de 1 MB: lo que quedó antes de ese tramo no se lee
  const capped = path.join(dir(), 's.jsonl');
  write(capped, [person('viejo', 9), tool('Read', { file_path: 'x'.repeat(2 * 1024 * 1024) }, 8), person('nuevo', 3), said('Respondo.', 2), turnEnd(2)]);
  assert.deepStrictEqual(readConversation(capped, { coordinator: 'Coordinadora', isCoordinator: true, maxBytes: 1 }).conVos.map((m) => m.texto), ['nuevo', 'Respondo.']);
  assert.ok(readConversation(capped, { coordinator: 'Coordinadora', isCoordinator: true }).conVos.some((m) => m.texto === 'viejo'), 'sin ese tope, sí');
  const tail = path.join(dir(), 's.jsonl');
  write(tail, [person('ñandú '.repeat(400000), 3), said('Respondo.', 2), turnEnd(2)]);
  const big = readConversation(tail, { coordinator: 'Coordinadora', isCoordinator: true });
  assert.ok(big.conVos[0].texto.startsWith('ñandú'), 'un renglón más largo que el tramo se lee entero y sin romper las letras');
  assert.ok(Array.from(big.conVos[0].texto).length <= 2000, 'el mensaje se recorta');
});

test('T246 CoverSecrets: tapa las claves y deja las rutas, los pedidos y las horas', () => {
  const key = `${'ghp'}_a1b2c3d4e5f6g7h8i9j0k1l2m3n4`;
  assert.strictEqual(coverSecrets(`usá ${key} ahora`), 'usá •••••• ahora');
  assert.strictEqual(coverSecrets('La clave es hunter2.'), 'La clave es ••••••');
  assert.strictEqual(coverSecrets('La contraseña: abc123, sigo'), 'La contraseña: ••••••, sigo');
  const keep = 'Mirá /Users/x/SourceCode/tycon-harness/scripts/lib/session-transcript.js y el pedido #911 a las 16:45.';
  assert.strictEqual(coverSecrets(keep), keep);
  const file = path.join(dir(), 's.jsonl');
  write(file, [person(`Te paso ${key}.`, 3), said('Listo.', 2), turnEnd(2), peer('Bruno', `El token: ${key}`, 1)]);
  assert.ok(!JSON.stringify(readConversation(file, { coordinator: 'Coordinadora', isCoordinator: true })).includes(key));
});
