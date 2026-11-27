'use strict';
/**
 * workday-upload.test.js — el día cerrado: las horas y los tokens de un día local de la máquina, armados por
 * scripts/metrics/workday-upload.js y subidos por scripts/metrics/upload-runs.js a `<maquina>/jornadas/v<versión>/<día>.json`.
 * T13 a T24 y T38 a T41.
 *
 * Cada caso tiene su HOME de juguete con conversaciones de juguete (Claude en `~/.claude/projects`, Codex en
 * `~/.codex/sessions`). La subida va contra un buzón de mentira local (node:http) que anota cada PUT: nada sale de la
 * máquina. La zona es fija (UTC-3 sin horario de verano) en este proceso y en los que lanza.
 *
 * stable-data: las horas son fechas fijas; el «ahora» se inyecta (`now` en el mismo proceso, TYCON_NOW en upload-runs).
 *
 * Correr: node --test scripts/tests/workday-upload.test.js
 */
process.env.TZ = 'America/Argentina/Buenos_Aires';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const WT = path.join(ROOT, 'scripts', 'lib', 'worked-time.js');
const WU = path.join(ROOT, 'scripts', 'metrics', 'workday-upload.js');
const UPLOAD = path.join(ROOT, 'scripts', 'metrics', 'upload-runs.js');
const { stateDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));

const TZ = 'America/Argentina/Buenos_Aires';
const DAY = 86400000;
const at = (local) => Date.parse(`${local.replace(' ', 'T')}:00-03:00`);
const iso = (local) => new Date(at(local)).toISOString();
const AC7_KEYS = ['dia', 'horas', 'tokens', 'tz', 'v'];

function cleanEnv(home, extra = {}) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^TYCON_|^CODEX_|^CLAUDE_/.test(k)) continue;
    e[k] = v;
  }
  return Object.assign(e, { HOME: home, USERPROFILE: home, TZ, TYCON_LANE_LLM: '0', TYCON_TIME_TRACKING: 'none' }, extra);
}

function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workday-'));
  const sdir = stateDir(home);
  fs.mkdirSync(path.join(sdir, 'worked'), { recursive: true });
  return { home, sdir, out: path.join(home, 'out') };
}
const workedDir = (w) => path.join(w.sdir, 'worked');
function opened(w, day, local) { fs.writeFileSync(path.join(workedDir(w), `${day}.abierto`), JSON.stringify({ abierto: iso(local), tz: '-03:00' })); }
function span(w, day, sid, a, b) {
  fs.appendFileSync(path.join(workedDir(w), `${day}.jsonl`), `${JSON.stringify({ sid, tool: 'claude', desde: iso(a), hasta: iso(b) })}\n`);
}
// una conversación de Claude: renglones de respuesta con su hora y su uso
function claudeConv(w, sid, msgs, { mtime, agent = null } = {}) {
  const dir = path.join(w.home, '.claude', 'projects', '-proyecto-de-juguete');
  const file = agent ? path.join(dir, sid, 'subagents', `${agent}.jsonl`) : path.join(dir, `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = msgs.map(([local, input, output, cacheRead], i) => JSON.stringify({
    type: 'assistant', ...(local ? { timestamp: iso(local) } : {}), uuid: `${sid}-${agent || 'm'}-${i}`, ...(agent ? { isSidechain: true } : {}),
    message: { id: `msg-${sid}-${agent || 'm'}-${i}`, model: 'claude-opus-5-5', usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 } },
  }));
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  if (mtime) fs.utimesSync(file, new Date(mtime), new Date(mtime));
  return file;
}
// una conversación de Codex: conteos acumulados con su hora
function codexConv(w, sid, counts, { mtime, startDay = '2026/11/08' } = {}) {
  const dir = path.join(w.home, '.codex', 'sessions', ...startDay.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-11-08T08-00-00-${sid}.jsonl`);
  const lines = counts.map(([local, input, cached, output]) => JSON.stringify({ timestamp: iso(local), type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output }, last_token_usage: { input_tokens: 1 }, model_context_window: 1000 } } }));
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  if (mtime) fs.utimesSync(file, new Date(mtime), new Date(mtime));
  return file;
}
const prepare = (w, now, extra = {}) => require(WU).prepareDays({ sdir: w.sdir, home: w.home, outDir: w.out, now, env: cleanEnv(w.home, extra) });
const dayFile = (w, day) => { try { return JSON.parse(fs.readFileSync(path.join(w.out, `${day}.json`), 'utf8')); } catch { return null; } };

// ── el buzón de mentira y la subida ───────────────────────────────────────────────────────────────────────────
function mailbox() {
  const puts = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { if (req.method === 'PUT') puts.push(decodeURIComponent(new URL(req.url, 'http://x').pathname)); res.writeHead(201); res.end(); });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, puts, url: `http://127.0.0.1:${srv.address().port}` })));
}
function upload(w, box, nowIso, { dry = false, extra = {} } = {}) {
  const cfg = path.join(w.home, 'cfg.json');
  // la llave de mentira con la forma de una de sólo escritura atada a una política (como en upload-runs.test.sh). La
  // firma va aparte: pegada a su parámetro, la línea tiene la forma de una llave de Azure y el escaneo de secretos la marca
  const firma = ['FIRMA', 'deprueba'].join('%2B') + '%3D';
  const sas = ['sv=2022-11-02', 'si=subida-prueba', 'sr=c', 'spr=https', `sig=${firma}`].join('&');
  if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, JSON.stringify({ cuenta: 'cuentadeprueba', contenedor: 'corridas', tenant: '00000000-0000-0000-0000-000000000000', politica: 'subida-prueba', vence: '2099-01-01', sas }));
  fs.mkdirSync(path.join(w.home, 'h'), { recursive: true });
  const env = cleanEnv(w.home, { TYCON_MAILBOX: '1', TYCON_MAILBOX_JSON: cfg, TYCON_MAILBOX_URL_BASE: box.url, TYCON_TIMING_HISTORY: path.join(w.home, 'h'),
    TYCON_UPLOADS_LOG: path.join(w.home, 'up.json'), TYCON_MACHINE: 'maquina-a', TYCON_LOGS_DIR: path.join(w.home, 'registros-buzon'), TYCON_NOW: nowIso, ...extra });
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [UPLOAD, '--json', ...(dry ? ['--dry-run'] : [])], { env });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.on('exit', (code) => { let j = null; try { j = JSON.parse(out); } catch { /* sin json */ } resolve({ code, json: j, out }); });
  });
}
const jornadaPuts = (box) => box.puts.filter((p) => /\/jornadas\//.test(p));

test('T13 Dia_Cerrado_ArmaElArchivo @story-8.209 @ac-7', () => {
  const w = world();
  opened(w, '2026-11-09', '2026-11-09 08:00');
  span(w, '2026-11-09', 's1', '2026-11-09 09:00', '2026-11-09 10:00');
  claudeConv(w, 'c1', [['2026-11-09 09:30', 100, 20, 1000]], { mtime: at('2026-11-09 10:00') });
  prepare(w, at('2026-11-10 09:00'));
  const d = dayFile(w, '2026-11-09');
  assert.ok(d, 'el día de ayer');
  assert.deepStrictEqual(Object.keys(d).sort(), AC7_KEYS);
  assert.strictEqual(d.v, 2);
  assert.strictEqual(d.dia, '2026-11-09');
  assert.strictEqual(d.tz, '-03:00');
  assert.deepStrictEqual(d.horas, { arnes_segundos: 3600, sesion_segundos: 3600, sesiones: 1, medido: true });
  assert.deepStrictEqual(d.tokens, { lectura: 100, escritura: 20, cache: 1000, medido: true, por_modelo: { 'claude-opus-5-5': { lectura: 100, escritura: 20, cache: 1000 } } });
});

test('T14 Dia_Subida_AlBuzon @story-8.209 @ac-7', async () => {
  const w = world();
  opened(w, '2026-11-09', '2026-11-09 08:00');
  span(w, '2026-11-09', 's1', '2026-11-09 09:00', '2026-11-09 10:00');
  const box = await mailbox();
  try {
    const r = await upload(w, box, new Date(at('2026-11-10 09:00')).toISOString(), { dry: true });
    assert.strictEqual(r.code, 0, r.out);
    const names = r.json && r.json.jornadas_a_subir;
    assert.ok(Array.isArray(names) && names.length === 1, r.out);
    assert.match(names[0], /^maquina-a\/jornadas\/v\d{8}T\d{9}Z\/2026-11-09\.json$/);
    assert.strictEqual(box.puts.length, 0, 'en seco no se manda nada');
  } finally { box.srv.close(); }
});

test('T15 Dia_EnCurso_NoSeArma @story-8.209 @ac-8', async () => {
  const w = world();
  for (const d of ['2026-11-09', '2026-11-10']) { opened(w, d, `${d} 08:00`); span(w, d, 's1', `${d} 09:00`, `${d} 10:00`); }
  const box = await mailbox();
  try {
    // 22:00 locales del 10 = 01:00 UTC del 11. La primera pasada ya prepara los registros de ese día UTC
    const now = new Date(at('2026-11-10 22:00')).toISOString();
    await upload(w, box, now, { dry: true, extra: { TYCON_TODAY: '2026-11-11' } });
    await upload(w, box, now, { dry: true, extra: { TYCON_TODAY: '2026-11-11' } });
    const dir = path.join(w.home, 'registros-buzon', 'jornadas');
    const days = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
    assert.deepStrictEqual(days, ['2026-11-09.json'], 'el día local en curso no se arma; el anterior sí');
  } finally { box.srv.close(); }
});

test('T16 Dia_YaSubido_NoSeRepite @story-8.209 @ac-9', async () => {
  const w = world();
  opened(w, '2026-11-09', '2026-11-09 08:00');
  span(w, '2026-11-09', 's1', '2026-11-09 09:00', '2026-11-09 10:00');
  const box = await mailbox();
  try {
    const now = new Date(at('2026-11-10 09:00')).toISOString();
    await upload(w, box, now);
    await upload(w, box, now);
    assert.strictEqual(jornadaPuts(box).length, 1, box.puts.join('\n'));
  } finally { box.srv.close(); }
});

test('T17 Dia_RenglonTardio_OtraVersion @story-8.209 @ac-9', async () => {
  const w = world();
  opened(w, '2026-11-09', '2026-11-09 08:00');
  span(w, '2026-11-09', 's1', '2026-11-09 09:00', '2026-11-09 10:00');
  const box = await mailbox();
  try {
    await upload(w, box, new Date(at('2026-11-10 09:00')).toISOString());
    await new Promise((r) => setTimeout(r, 30));
    span(w, '2026-11-09', 's2', '2026-11-09 23:00', '2026-11-09 23:30');
    await upload(w, box, new Date(at('2026-11-10 09:05')).toISOString());
    const puts = jornadaPuts(box);
    assert.strictEqual(puts.length, 2, puts.join('\n'));
    assert.notStrictEqual(puts[0], puts[1], 'otra versión');
    assert.ok(puts.every((p) => p.endsWith('/2026-11-09.json')));
  } finally { box.srv.close(); }
});

test('T18 Tokens_PorHoraDelMensaje @story-8.209 @ac-10', () => {
  const w = world();
  opened(w, '2026-11-09', '2026-11-09 08:00');
  // el mensaje sin hora va al día del mensaje con hora anterior
  claudeConv(w, 'c18', [['2026-11-09 10:00', 10, 1, 100], [null, 5, 5, 5], ['2026-11-10 08:00', 1000, 1000, 1000]], { mtime: at('2026-11-10 08:00') });
  claudeConv(w, 'c18', [['2026-11-09 11:00', 7, 3, 30]], { mtime: at('2026-11-09 11:00'), agent: 'agent-x' });
  prepare(w, at('2026-11-10 09:00'));
  const d = dayFile(w, '2026-11-09');
  assert.strictEqual(d.tokens.lectura, 17);
  assert.strictEqual(d.tokens.escritura, 4);
  assert.strictEqual(d.tokens.cache, 130);
  assert.strictEqual(d.tokens.sin_hora, 1, 'el mensaje sin hora no se cuenta y se dice');
});

test('T19 Tokens_Codex_PorDiferencia @story-8.209 @ac-10', () => {
  const w = world();
  opened(w, '2026-11-09', '2026-11-09 08:00');
  fs.writeFileSync(path.join(workedDir(w), 'codex-totals.json'), JSON.stringify({ '2026-11-08': { 'rollout-2026-11-08T08-00-00-x19.jsonl': { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 } } }));
  codexConv(w, 'x19', [['2026-11-08 20:00', 100, 50, 10], ['2026-11-09 10:00', 300, 150, 40], ['2026-11-09 12:00', 400, 200, 60]], { mtime: at('2026-11-09 12:00') });
  prepare(w, at('2026-11-10 09:00'));
  const d = dayFile(w, '2026-11-09');
  // 400-100 de entrada, de los que 200-50 son caché: lectura 150, caché 150, escritura 50
  assert.deepStrictEqual([d.tokens.lectura, d.tokens.cache, d.tokens.escritura], [150, 150, 50]);
});

test('T20 Tokens_SoloArchivosDelDia @story-8.209 @ac-10', () => {
  const w = world();
  opened(w, '2026-11-09', '2026-11-09 08:00');
  // trae un mensaje con la hora del 9, pero no se tocó desde el 7: si se abriera, el 9 lo contaría
  claudeConv(w, 'c20', [['2026-11-09 10:00', 10, 1, 1]], { mtime: at('2026-11-07 10:00') });
  prepare(w, at('2026-11-10 09:00'));
  const d = dayFile(w, '2026-11-09');
  assert.deepStrictEqual(d.tokens, { lectura: 0, escritura: 0, cache: 0, medido: true, por_modelo: {} }, 'la conversación sin tocar desde antes del día no se abrió');
});

test('T21 Dia_ParteIlegible_NoMedidoConMotivo @story-8.209 @ac-11', () => {
  const w = world();
  opened(w, '2026-11-09', '2026-11-09 08:00');
  span(w, '2026-11-09', 's1', '2026-11-09 09:00', '2026-11-09 10:00');
  const spans = path.join(workedDir(w), '2026-11-09.jsonl');
  const conv = claudeConv(w, 'c21', [['2026-11-09 09:30', 1, 1, 1]], { mtime: at('2026-11-09 10:00') });
  fs.chmodSync(spans, 0o000);
  try {
    prepare(w, at('2026-11-10 09:00'));
    const d = dayFile(w, '2026-11-09');
    assert.strictEqual(d.horas.medido, false);
    assert.ok(d.horas.motivo && !d.horas.motivo.includes(w.home) && !d.horas.motivo.includes('/'), d.horas.motivo);
    assert.strictEqual(d.tokens.medido, true, 'la otra parte va igual');
  } finally { fs.chmodSync(spans, 0o600); }
  const w2 = world();
  opened(w2, '2026-11-09', '2026-11-09 08:00');
  span(w2, '2026-11-09', 's1', '2026-11-09 09:00', '2026-11-09 10:00');
  const bad = claudeConv(w2, 'c21', [['2026-11-09 09:30', 1, 1, 1]], { mtime: at('2026-11-09 10:00') });
  fs.chmodSync(bad, 0o000);
  try {
    prepare(w2, at('2026-11-10 09:00'));
    const d = dayFile(w2, '2026-11-09');
    assert.strictEqual(d.tokens.medido, false);
    assert.ok(d.tokens.motivo && !d.tokens.motivo.includes('/'), d.tokens.motivo);
    assert.strictEqual(d.horas.medido, true);
    // los otros días que cubría la conversación rota, si se arman por otro rastro, tampoco salen medidos
  } finally { fs.chmodSync(bad, 0o600); }
  assert.ok(conv);
  const w3 = world();
  opened(w3, '2026-11-08', '2026-11-08 08:00');
  const rota = claudeConv(w3, 'c21b', [['2026-11-09 09:30', 1, 1, 1]], { mtime: at('2026-11-09 10:00') });
  fs.chmodSync(rota, 0o000);
  try {
    prepare(w3, at('2026-11-10 09:00'));
    assert.strictEqual(dayFile(w3, '2026-11-08').tokens.medido, false, 'el 8 se arma por su apertura y la conversación rota lo cubría');
  } finally { fs.chmodSync(rota, 0o600); }
  // los totales guardados de Codex rotos: los tokens de Codex no se restan de otro lado, van sin medir
  const w4 = world();
  opened(w4, '2026-11-09', '2026-11-09 08:00');
  fs.writeFileSync(path.join(workedDir(w4), 'codex-totals.json'), '{roto');
  codexConv(w4, 'x21', [['2026-11-09 10:00', 300, 0, 40], ['2026-11-09 12:00', 400, 0, 60]], { mtime: at('2026-11-09 12:00') });
  prepare(w4, at('2026-11-10 09:00'));
  const t4 = dayFile(w4, '2026-11-09').tokens;
  assert.strictEqual(t4.medido, false);
  assert.match(t4.motivo, /totales guardados de Codex/);
  // un renglón con uso que no se entiende se cuenta, no se pierde callado
  const w5 = world();
  opened(w5, '2026-11-09', '2026-11-09 08:00');
  const f5 = claudeConv(w5, 'c21c', [['2026-11-09 09:30', 1, 1, 1]], { mtime: at('2026-11-09 10:00') });
  fs.appendFileSync(f5, '{"type":"assistant","usage": roto\n');
  fs.utimesSync(f5, new Date(at('2026-11-09 10:00')), new Date(at('2026-11-09 10:00')));
  prepare(w5, at('2026-11-10 09:00'));
  assert.strictEqual(dayFile(w5, '2026-11-09').tokens.ilegibles, 1);
});

test('T22 Dia_SinTrabajo_CeroMedido @story-8.209 @ac-11', () => {
  const w = world();
  opened(w, '2026-11-09', '2026-11-09 08:00');
  prepare(w, at('2026-11-10 09:00'));
  const d = dayFile(w, '2026-11-09');
  assert.deepStrictEqual(d.horas, { arnes_segundos: 0, sesion_segundos: 0, sesiones: 0, medido: true });
  assert.deepStrictEqual(d.tokens, { lectura: 0, escritura: 0, cache: 0, medido: true, por_modelo: {} });
});

test('T23 Dia_Apagado_NoSube @story-8.209 @ac-12', async () => {
  const w = world();
  opened(w, '2026-11-09', '2026-11-09 08:00');
  span(w, '2026-11-09', 's1', '2026-11-09 09:00', '2026-11-09 10:00');
  const box = await mailbox();
  try {
    await upload(w, box, new Date(at('2026-11-10 09:00')).toISOString(), { extra: { TYCON_WORKDAYS: '0' } });
    assert.strictEqual(jornadaPuts(box).length, 0);
    const dir = path.join(w.home, 'registros-buzon', 'jornadas');
    assert.ok(!fs.existsSync(dir) || !fs.readdirSync(dir).some((n) => n.endsWith('.json')), 'ningún archivo');
  } finally { box.srv.close(); }
});

test('T24 Dia_SoloLosCampos_SinIdsNiRutas @story-8.209 @ac-13 @ac-14', () => {
  const w = world();
  opened(w, '2026-11-09', '2026-11-09 08:00');
  span(w, '2026-11-09', 'sesion-secreta-123', '2026-11-09 09:00', '2026-11-09 10:00');
  claudeConv(w, 'conv-secreta', [['2026-11-09 09:30', 1, 1, 1]], { mtime: at('2026-11-09 10:00') });
  const old = '2026-09-09';
  fs.writeFileSync(path.join(workedDir(w), `${old}.jsonl`), '');
  fs.writeFileSync(path.join(workedDir(w), `${old}.abierto`), '{}');
  prepare(w, at('2026-11-10 09:00'));
  const text = fs.readFileSync(path.join(w.out, '2026-11-09.json'), 'utf8');
  const d = JSON.parse(text);
  assert.deepStrictEqual(Object.keys(d).sort(), AC7_KEYS);
  assert.deepStrictEqual(Object.keys(d.horas).sort(), ['arnes_segundos', 'medido', 'sesion_segundos', 'sesiones']);
  assert.deepStrictEqual(Object.keys(d.tokens).sort(), ['cache', 'escritura', 'lectura', 'medido', 'por_modelo']);
  assert.deepStrictEqual(Object.keys(d.tokens.por_modelo), ['claude-opus-5-5'], 'el reparto sólo trae el nombre del modelo');
  for (const bad of ['sesion-secreta', 'conv-secreta', 'proyecto-de-juguete', w.home]) assert.ok(!text.includes(bad), bad);
  assert.ok(!fs.existsSync(path.join(workedDir(w), `${old}.jsonl`)), 'los de hace más de 60 días se borran');
  assert.ok(!fs.existsSync(path.join(workedDir(w), `${old}.abierto`)));
});

test('T38 Dia_SinAperturaDelGancho_HorasNoMedidas @story-8.209 @ac-11', () => {
  const w = world();
  claudeConv(w, 'c38', [['2026-11-07 09:00', 3, 3, 3]], { mtime: at('2026-11-07 09:00') });
  opened(w, '2026-11-08', '2026-11-08 08:00');
  span(w, '2026-11-09', 's1', '2026-11-09 09:00', '2026-11-09 09:30');
  prepare(w, at('2026-11-10 09:00'));
  const a = dayFile(w, '2026-11-07');
  assert.strictEqual(a.horas.medido, false);
  assert.ok(a.horas.motivo);
  assert.strictEqual(a.tokens.medido, true);
  assert.strictEqual(dayFile(w, '2026-11-08').horas.medido, true);
  assert.strictEqual(dayFile(w, '2026-11-08').horas.sesion_segundos, 0);
  const c = dayFile(w, '2026-11-09');
  assert.strictEqual(c.horas.medido, true);
  assert.strictEqual(c.horas.sesion_segundos, 1800);
});

test('T39 Dia_QueDiasSeArman @story-8.209 @ac-11', () => {
  const w = world();
  const now = at('2026-11-10 09:00');
  const dayAgo = (n) => require(WT).dayOf(now - n * DAY);
  for (const n of [40, 20, 10]) opened(w, dayAgo(n), `${dayAgo(n)} 08:00`);
  span(w, dayAgo(5), 's1', `${dayAgo(5)} 09:00`, `${dayAgo(5)} 09:30`);
  prepare(w, now);
  const days = fs.readdirSync(w.out).filter((n) => n.endsWith('.json')).sort();
  assert.deepStrictEqual(days, [`${dayAgo(20)}.json`, `${dayAgo(10)}.json`, `${dayAgo(5)}.json`]);
});

test('T40 Tokens_Codex_TotalGuardadoAlCerrar @story-8.209 @ac-10', async () => {
  const w = world();
  opened(w, '2026-11-08', '2026-11-08 08:00');
  opened(w, '2026-11-09', '2026-11-09 08:00');
  codexConv(w, 'x40', [['2026-11-08 10:00', 100, 0, 10], ['2026-11-08 20:00', 200, 0, 20], ['2026-11-09 10:00', 500, 0, 50]], { mtime: at('2026-11-09 10:00') });
  codexConv(w, 'y40', [['2026-11-09 09:00', 1000, 0, 100], ['2026-11-09 11:00', 1300, 0, 130]], { mtime: at('2026-11-09 11:00'), startDay: '2026/11/09' });
  prepare(w, at('2026-11-09 12:00'));
  assert.strictEqual(dayFile(w, '2026-11-08').tokens.lectura, 100, 'el primer día: desde su primer conteo');
  prepare(w, at('2026-11-10 09:00'));
  const second = dayFile(w, '2026-11-09');
  // x40: 500-200 (el total guardado del 8); y40 sin total guardado: 1300-1000
  assert.strictEqual(second.tokens.lectura, 300 + 300);
  // un renglón tardío del 8: el rearmado da los mismos tokens
  await new Promise((r) => setTimeout(r, 30));
  span(w, '2026-11-08', 's1', '2026-11-08 23:00', '2026-11-08 23:30');
  prepare(w, at('2026-11-10 09:05'));
  const again = dayFile(w, '2026-11-08');
  assert.strictEqual(again.tokens.lectura, 100);
  assert.strictEqual(again.horas.sesion_segundos, 1800);
});

test('T41 Dia_DosHoras_UnionYSuma @story-8.209 @ac-25', () => {
  const s = (sid, a, b) => JSON.stringify({ sid, tool: 'claude', desde: iso(a), hasta: iso(b) });
  const lines = [s('a', '2026-11-09 10:00', '2026-11-09 11:00'), s('b', '2026-11-09 10:30', '2026-11-09 12:00'),
    s('c', '2026-11-09 14:00', '2026-11-09 14:30'), s('c', '2026-11-09 14:00', '2026-11-09 14:30')];
  const t = require(WT).dayTotals(lines, '2026-11-09');
  assert.strictEqual(t.arnes_segundos, 2.5 * 3600);
  assert.strictEqual(t.sesion_segundos, 3 * 3600);
  assert.ok(t.arnes_segundos <= t.sesion_segundos);
  assert.ok(t.arnes_segundos <= require(WT).daySeconds('2026-11-09'));
  assert.strictEqual(t.sesiones, 3);
});

test('T45 Tokens_AgentesDeWorkflow_Cuentan @story-8.209 @ac-9', () => {
  // los agentes de un workflow viven en subagents/workflows/<corrida>/: sus tokens también son de la conversación
  const w = world();
  opened(w, '2026-11-09', '2026-11-09 08:00');
  claudeConv(w, 'c45', [['2026-11-09 09:00', 100, 10, 0]], { mtime: at('2026-11-09 09:00') });
  claudeConv(w, 'c45', [['2026-11-09 09:10', 1000, 100, 0]], { mtime: at('2026-11-09 09:10'), agent: 'agent-suelto' });
  claudeConv(w, 'c45', [['2026-11-09 09:20', 50000, 5000, 0]], { mtime: at('2026-11-09 09:20'), agent: 'workflows/wf_1/agent-w' });
  prepare(w, at('2026-11-10 09:00'));
  assert.deepStrictEqual(dayFile(w, '2026-11-09').tokens, { lectura: 51100, escritura: 5110, cache: 0, medido: true, por_modelo: { 'claude-opus-5-5': { lectura: 51100, escritura: 5110, cache: 0 } } });
});

test('T46 Armado_RenglonDelGanchoMientrasLee_SeRearma @story-8.209 @ac-12', () => {
  // un tramo que el gancho anota mientras la pasada lee las conversaciones no queda afuera para siempre
  const w = world();
  opened(w, '2026-11-11', '2026-11-11 08:00');
  span(w, '2026-11-11', 'a46', '2026-11-11 09:00', '2026-11-11 10:00');
  claudeConv(w, 'c46', [['2026-11-11 09:30', 1, 1, 0]], { mtime: at('2026-11-11 09:30') });
  const ST = require(path.join(ROOT, 'scripts', 'lib', 'transcript-tokens.js'));
  const original = ST.dayTokens;
  let una = false;
  ST.dayTokens = (...args) => {
    if (!una) { una = true; span(w, '2026-11-11', 'b46', '2026-11-11 23:00', '2026-11-11 23:59'); }
    return original(...args);
  };
  try { prepare(w, at('2026-11-12 00:40')); } finally { ST.dayTokens = original; }
  assert.strictEqual(dayFile(w, '2026-11-11').horas.arnes_segundos, 3600, 'la primera pasada armó antes del renglón nuevo');
  prepare(w, at('2026-11-12 01:40'));
  assert.strictEqual(dayFile(w, '2026-11-11').horas.arnes_segundos, 3600 + 59 * 60, 'la pasada siguiente lo ve y rearma');
});

test('T47 Tokens_RenglonRotoAntesDeLaHora_SeCuenta @story-8.209 @ac-11', () => {
  // un renglón de uso roto antes del primer renglón con hora va al día de ese renglón, no se pierde
  const w = world();
  opened(w, '2026-11-09', '2026-11-09 08:00');
  const f = claudeConv(w, 'c47', [['2026-11-09 09:30', 1, 1, 1]]);
  fs.writeFileSync(f, `{"type":"assistant","usage": roto\n${fs.readFileSync(f, 'utf8')}`);
  fs.utimesSync(f, new Date(at('2026-11-09 10:00')), new Date(at('2026-11-09 10:00')));
  prepare(w, at('2026-11-10 09:00'));
  assert.strictEqual(dayFile(w, '2026-11-09').tokens.ilegibles, 1);
});

// ── O-horas, parte 3: los tokens por modelo (el día pasa a la versión 2) ─────────────────────────────────────────────

// una conversación de Claude con el modelo de cada respuesta
function claudeConvModelos(w, sid, msgs, { mtime, agent = null } = {}) {
  const dir = path.join(w.home, '.claude', 'projects', '-proyecto-de-juguete');
  const file = agent ? path.join(dir, sid, 'subagents', `${agent}.jsonl`) : path.join(dir, `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = msgs.map(([local, model, input, output, cacheRead, cacheWrite], i) => JSON.stringify({
    type: 'assistant', timestamp: iso(local), uuid: `${sid}-${agent || 'm'}-${i}`, ...(agent ? { isSidechain: true } : {}),
    message: { id: `msg-${sid}-${agent || 'm'}-${i}`, ...(model ? { model } : {}), usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite || 0 } },
  }));
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  if (mtime) fs.utimesSync(file, new Date(mtime), new Date(mtime));
}
// una conversación de Codex con el modelo de cada turno: renglones ['turno', hora, modelo] y ['conteo', hora, entrada, caché, salida]
function codexConvModelos(w, sid, rows, { mtime, startDay = '2026/11/08' } = {}) {
  const dir = path.join(w.home, '.codex', 'sessions', ...startDay.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-11-08T08-00-00-${sid}.jsonl`);
  const lines = rows.map((r) => (r[0] === 'turno'
    ? JSON.stringify({ timestamp: iso(r[1]), type: 'turn_context', payload: { turn_id: 't', model: r[2], cwd: '/x' } })
    : JSON.stringify({ timestamp: iso(r[1]), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: r[2], cached_input_tokens: r[3], output_tokens: r[4] } } } })));
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  if (mtime) fs.utimesSync(file, new Date(mtime), new Date(mtime));
}
const sumaModelos = (pm) => Object.values(pm).reduce((a, m) => ({ lectura: a.lectura + m.lectura, escritura: a.escritura + m.escritura, cache: a.cache + m.cache }), { lectura: 0, escritura: 0, cache: 0 });

test('OH6 Tokens_PorModelo_Claude — cada respuesta suma a su modelo, los agentes también, y el reparto da los totales', () => {
  const w = world();
  opened(w, '2026-11-09', '2026-11-09 08:00');
  claudeConvModelos(w, 'c6', [
    ['2026-11-09 09:00', 'claude-opus-5-5', 100, 10, 1000, 50],
    ['2026-11-09 09:30', 'claude-sonnet-5-5', 20, 5, 200, 0],
    ['2026-11-09 10:00', 'claude-opus-5-5', 1, 1, 1, 0],
    // sin modelo: va aparte, nunca a un modelo inventado
    ['2026-11-09 10:30', null, 7, 7, 7, 0],
  ], { mtime: at('2026-11-09 11:00') });
  claudeConvModelos(w, 'c6', [['2026-11-09 10:15', 'claude-haiku-5-5', 3, 2, 30, 0]], { mtime: at('2026-11-09 11:00'), agent: 'agent-h' });
  prepare(w, at('2026-11-10 09:00'));
  const d = dayFile(w, '2026-11-09');
  assert.strictEqual(d.v, 2);
  assert.deepStrictEqual(d.tokens.por_modelo, {
    'claude-opus-5-5': { lectura: 151, escritura: 11, cache: 1001 },
    'claude-sonnet-5-5': { lectura: 20, escritura: 5, cache: 200 },
    'claude-haiku-5-5': { lectura: 3, escritura: 2, cache: 30 },
    sin_modelo: { lectura: 7, escritura: 7, cache: 7 },
  });
  const { lectura, escritura, cache } = d.tokens;
  assert.deepStrictEqual(sumaModelos(d.tokens.por_modelo), { lectura, escritura, cache }, 'el reparto suma lo mismo que los totales');
});

test('OH7 Tokens_PorModelo_Codex_SigueLaResta — el modelo sale del turno, y el reparto sigue la resta contra el total guardado', () => {
  const w = world();
  opened(w, '2026-11-09', '2026-11-09 08:00');
  const key = 'rollout-2026-11-08T08-00-00-x7.jsonl';
  fs.writeFileSync(path.join(workedDir(w), 'codex-totals.json'), JSON.stringify({ '2026-11-08': { [key]: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 } } }));
  codexConvModelos(w, 'x7', [
    ['turno', '2026-11-08 19:00', 'gpt-5.6-terra'],
    ['conteo', '2026-11-08 20:00', 100, 50, 10],
    // el 9: primero sigue terra (lo que pasó entre el total guardado y el primer conteo es de terra), después cambia a sol
    ['conteo', '2026-11-09 10:00', 300, 150, 40],
    ['turno', '2026-11-09 11:00', 'gpt-6.1-sol'],
    ['conteo', '2026-11-09 12:00', 400, 200, 60],
  ], { mtime: at('2026-11-09 12:00') });
  prepare(w, at('2026-11-10 09:00'));
  const d = dayFile(w, '2026-11-09');
  assert.deepStrictEqual([d.tokens.lectura, d.tokens.cache, d.tokens.escritura], [150, 150, 50], 'los totales de siempre');
  assert.deepStrictEqual(d.tokens.por_modelo, {
    'gpt-5.6-terra': { lectura: 100, escritura: 30, cache: 100 },
    'gpt-6.1-sol': { lectura: 50, escritura: 20, cache: 50 },
  });
});

test('OH8 Rearmado_DiaArmadoAntes_SinReparto — un día armado sin reparto se rearma en la versión 2 sin inventarlo', async () => {
  const w = world();
  opened(w, '2026-11-09', '2026-11-09 08:00');
  span(w, '2026-11-09', 's1', '2026-11-09 09:00', '2026-11-09 10:00');
  const viejo = { lectura: 100, escritura: 20, cache: 1000, medido: true };
  const contenido = `${JSON.stringify({ v: 1, dia: '2026-11-09', tz: '-03:00', horas: { arnes_segundos: 3600, sesion_segundos: 3600, sesiones: 1, medido: true }, tokens: viejo })}\n`;
  // armado después de los tramos de ese día, como lo dejó la pasada de antes de la versión 2
  fs.writeFileSync(path.join(workedDir(w), 'armados.json'), JSON.stringify({ '2026-11-09': { armadoAt: Date.now() + 5, tokens: viejo, contenido } }));
  await new Promise((r) => setTimeout(r, 10));
  // sin renglón tardío: el día se reusa como estaba, en la versión 1
  prepare(w, at('2026-11-10 09:00'));
  assert.strictEqual(dayFile(w, '2026-11-09').v, 1, 'sin cambios no se rearma');
  // un renglón tardío: se rearma con los mismos tokens, en la versión 2 y sin reparto
  await new Promise((r) => setTimeout(r, 30));
  span(w, '2026-11-09', 's2', '2026-11-09 11:00', '2026-11-09 11:30');
  prepare(w, at('2026-11-10 09:05'));
  const d = dayFile(w, '2026-11-09');
  assert.strictEqual(d.v, 2);
  assert.deepStrictEqual(d.tokens, viejo, 'sin por_modelo: el sitio dice «sin dato de modelo»');
});

test('OH12 Tokens_PorModelo_CodexTotalQueBaja — si un total baja, el reparto que no cierra va a sin_modelo y suma lo mismo que el total', () => {
  const w = world();
  opened(w, '2026-11-09', '2026-11-09 08:00');
  const key = 'rollout-2026-11-08T08-00-00-x12.jsonl';
  fs.writeFileSync(path.join(workedDir(w), 'codex-totals.json'), JSON.stringify({ '2026-11-08': { [key]: { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 100 } } }));
  codexConvModelos(w, 'x12', [['turno', '2026-11-09 09:00', 'gpt-5.6-terra'], ['conteo', '2026-11-09 10:00', 100, 50, 10], ['conteo', '2026-11-09 12:00', 400, 200, 40]], { mtime: at('2026-11-09 12:00') });
  prepare(w, at('2026-11-10 09:00'));
  const d = dayFile(w, '2026-11-09');
  const { lectura, escritura, cache } = d.tokens;
  assert.deepStrictEqual(sumaModelos(d.tokens.por_modelo), { lectura, escritura, cache }, 'el reparto nunca dice más que el total');
});

test('OH13 Tokens_NombreDeModeloRaro_VaASinModelo — un nombre con espacio, «/» o demasiado largo no sube: va a sin_modelo', () => {
  const w = world();
  opened(w, '2026-11-09', '2026-11-09 08:00');
  claudeConvModelos(w, 'c13', [
    ['2026-11-09 09:00', 'modelo con espacio', 1, 1, 1, 0],
    ['2026-11-09 09:10', 'Users/ana/modelos/local.gguf', 2, 2, 2, 0],
    ['2026-11-09 09:20', `m${'x'.repeat(120)}`, 3, 3, 3, 0],
    ['2026-11-09 09:30', 'kimi-k2.7-code:cloud', 4, 4, 4, 0],
  ], { mtime: at('2026-11-09 10:00') });
  prepare(w, at('2026-11-10 09:00'));
  assert.deepStrictEqual(dayFile(w, '2026-11-09').tokens.por_modelo, { sin_modelo: { lectura: 6, escritura: 6, cache: 6 }, 'kimi-k2.7-code:cloud': { lectura: 4, escritura: 4, cache: 4 } });
});
