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
const { readTranscript, HEAD_BYTES, TAIL_BYTES } = require(path.join(ROOT, 'scripts', 'lib', 'session-transcript.js'));

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
  assert.strictEqual(r.haciendoAhora, 'Reviso las pruebas del tablero y sigo con el kanban.');
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
  assert.strictEqual(r.haciendoAhora, 'Sigo con el kanban.');
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

