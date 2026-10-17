'use strict';
// notify.test.js — red de scripts/lib/notify.js, el único camino de salida de los avisos de los nocturnos.
//
// 🔴 NINGÚN CASO TOCA LA RED. Telegram y los webhooks son un servidor HTTP local en OTRO proceso (el envío es
// sincrónico: un servidor en este mismo proceso quedaría bloqueado mientras se manda). El canal de Telegram es una
// carpeta de mentira (`TYCON_TELEGRAM_DIR`) y la API apunta a ese servidor (`TYCON_TELEGRAM_API`): sin las dos, en la
// máquina de un dev el script real leería ~/.claude/channels/telegram/.env y mandaría un mensaje de verdad.
//

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const NOTIFY = path.join(RAIZ, 'scripts', 'lib', 'notify.js');
// 🔴 los valores de mentira se arman por partes: escritos enteros, el freno del remoto público los toma por secretos reales
const TOKEN = ['tok', 'de-prueba-que-no-debe-aparecer'].join('-');
// una dirección con forma real: el host y la ruta son la credencial; ninguno puede aparecer en ninguna salida
const RUTA_SECRETA = ['', 'services', 'T0SECRETO', 'B0SECRETO', 'abcdefghijklmnopqrstuvwx'].join('/');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-test-'));
const canalDir = path.join(tmp, 'canal');
fs.mkdirSync(canalDir);
fs.writeFileSync(path.join(canalDir, '.env'), `TELEGRAM_BOT_TOKEN=${TOKEN}\n`);
fs.writeFileSync(path.join(canalDir, 'access.json'), '{"allowFrom":["990011223344"]}\n');

// El servidor de mentira: anota cada pedido (ruta, cuerpo) y contesta lo que diga el archivo de respuestas:
// `ok:<id>` (Telegram) · `status:<n>` (webhook) · `mudo` (acepta la conexión y no contesta). Cada pedido consume la
// primera línea; la última queda fija.
const SERVIDOR = `
const http = require('http'), fs = require('fs');
const [log, resp, puertoF] = process.argv.slice(1);
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => (b += d)).on('end', () => {
    fs.appendFileSync(log, JSON.stringify({ ruta: req.url, tipo: req.headers['content-type'] || null, cuerpo: b }) + '\\n');
    const lineas = fs.readFileSync(resp, 'utf8').split('\\n').map((l) => l.trim()).filter(Boolean);
    const r = lineas[0] || '';
    if (lineas.length > 1) fs.writeFileSync(resp, lineas.slice(1).join('\\n') + '\\n');
    if (r === 'mudo') return;
    if (r.startsWith('ok:')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ok: true, result: { message_id: Number(r.slice(3)) } })); }
    if (r.startsWith('status:')) { res.statusCode = Number(r.slice(7)); return res.end(res.statusCode < 300 ? 'ok' : 'error del servidor con ${RUTA_SECRETA}'); }
    res.statusCode = 500; res.end('?');
  });
});
srv.listen(0, '127.0.0.1', () => fs.writeFileSync(puertoF, String(srv.address().port)));
`;
const log = path.join(tmp, 'pedidos.jsonl');
const resp = path.join(tmp, 'respuesta');
const puertoF = path.join(tmp, 'puerto');
let srv;
let base;

test.before(async () => {
  fs.writeFileSync(log, '');
  fs.writeFileSync(resp, 'ok:777\n');
  srv = spawn(process.execPath, ['-e', SERVIDOR, log, resp, puertoF], { stdio: 'ignore' });
  for (let i = 0; i < 200 && !(fs.existsSync(puertoF) && fs.readFileSync(puertoF, 'utf8')); i++) await new Promise((r) => setTimeout(r, 25));
  base = `http://127.0.0.1:${fs.readFileSync(puertoF, 'utf8')}`;
});
test.after(() => { if (srv) srv.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

const pedidos = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const reset = (r) => { fs.writeFileSync(log, ''); fs.writeFileSync(resp, `${r}\n`); };

/** El entorno de cada caso: sin nada del dev, con el canal y la API de mentira. */
function entorno(extra = {}) {
  const env = { PATH: process.env.PATH, HOME: tmp, TYCON_TELEGRAM_DIR: canalDir, TYCON_TELEGRAM_API: base };
  return { ...env, ...extra };
}
/** Corre el CLI: { status, stdout, stderr }. */
function cli(args, env) {
  const r = spawnSync(process.execPath, [NOTIFY, ...args], { encoding: 'utf8', env, timeout: 60000 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
/** La función, en un proceso aparte con su propio entorno (el módulo lee process.env al mandar). */
function entregar(opciones, env) {
  const codigo = `const N = require(${JSON.stringify(NOTIFY)}); process.stdout.write(JSON.stringify(N.entregar(${JSON.stringify(opciones)})));`;
  const r = spawnSync(process.execPath, ['-e', codigo], { encoding: 'utf8', env, timeout: 60000 });
  assert.strictEqual(r.status, 0, r.stderr);
  return { resultado: JSON.parse(r.stdout), stderr: r.stderr || '' };
}

test('T18 Notify_TelegramPorElScript @story-2.30 @ac-15 @ac-26', () => {
  reset('ok:4242');
  const { resultado } = entregar({ canal: 'telegram', texto: 'resumen de prueba' }, entorno());
  assert.strictEqual(resultado.entregado, true, JSON.stringify(resultado));
  assert.strictEqual(resultado.message_id, 4242);
  assert.strictEqual(resultado.editado, false);
  assert.strictEqual(resultado.canal, 'telegram');
  const [p] = pedidos();
  assert.match(p.ruta, /\/sendMessage$/, 'por el script: el mismo método de Telegram que hoy');
  assert.ok(p.ruta.includes(`/bot${TOKEN}/`), 'con el token del canal de mentira');
  assert.match(decodeURIComponent(p.cuerpo.replace(/\+/g, ' ')), /chat_id=990011223344/);
  // con editarId, edita
  reset('ok:4242');
  const ed = entregar({ canal: 'telegram', texto: 'resumen editado', editarId: '4242' }, entorno()).resultado;
  assert.strictEqual(ed.entregado, true);
  assert.strictEqual(ed.editado, true);
  assert.strictEqual(ed.message_id, 4242);
  assert.match(pedidos()[0].ruta, /\/editMessageText$/);
  // por el CLI: imprime el message_id y sale 0
  reset('ok:5151');
  const c = cli(['--channel', 'telegram', '--', 'hola'], entorno());
  assert.strictEqual(c.status, 0, c.stderr);
  assert.strictEqual(c.stdout.trim(), '5151');
  // el script es el único cliente de Telegram: notify.js no arma la dirección de la API
  const src = fs.readFileSync(NOTIFY, 'utf8');
  assert.ok(src.includes('tycon-telegram-notify.sh'));
  assert.doesNotMatch(src, /api\.telegram\.org|sendMessage/);
});

test('T19 Notify_SlackYTeamsPorWebhook_SinDireccionALaVista @story-2.30 @ac-15', () => {
  const url = () => `${base}${RUTA_SECRETA}`;
  // Slack: { text }
  reset('status:200');
  let r = entregar({ canal: 'slack', texto: 'dependencias: 3' }, entorno({ TYCON_NOTIFY_WEBHOOK_URL: url() }));
  assert.strictEqual(r.resultado.entregado, true, JSON.stringify(r.resultado));
  assert.strictEqual(r.resultado.editado, false);
  assert.strictEqual(r.resultado.message_id, null, 'un webhook no devuelve id: no se edita');
  let [p] = pedidos();
  assert.strictEqual(p.ruta, RUTA_SECRETA);
  assert.match(p.tipo, /application\/json/);
  assert.deepStrictEqual(JSON.parse(p.cuerpo), { text: 'dependencias: 3' });
  // Teams (flujos de trabajo): una tarjeta adaptable con el texto
  reset('status:202');
  r = entregar({ canal: 'teams', texto: 'dependencias: 3' }, entorno({ TYCON_NOTIFY_WEBHOOK_URL: url() }));
  assert.strictEqual(r.resultado.entregado, true, JSON.stringify(r.resultado));
  [p] = pedidos();
  const card = JSON.parse(p.cuerpo);
  assert.strictEqual(card.type, 'message');
  assert.strictEqual(card.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
  assert.strictEqual(card.attachments[0].content.type, 'AdaptiveCard');
  assert.strictEqual(card.attachments[0].content.body[0].text, 'dependencias: 3');
  // con editarId, en un canal que no edita: manda uno nuevo y lo dice
  reset('status:200');
  r = entregar({ canal: 'slack', texto: 'x', editarId: '12' }, entorno({ TYCON_NOTIFY_WEBHOOK_URL: url() }));
  assert.strictEqual(r.resultado.entregado, true);
  assert.strictEqual(r.resultado.editado, false);

  const salidas = [];
  // 500: no entregado, con el código
  reset('status:500');
  r = entregar({ canal: 'slack', texto: 'x' }, entorno({ TYCON_NOTIFY_WEBHOOK_URL: url() }));
  assert.strictEqual(r.resultado.entregado, false);
  assert.strictEqual(r.resultado.motivo, 'slack contestó 500');
  salidas.push(JSON.stringify(r.resultado), r.stderr);
  // sin respuesta: el corte, con sus segundos
  reset('mudo');
  r = entregar({ canal: 'teams', texto: 'x' }, entorno({ TYCON_NOTIFY_WEBHOOK_URL: url(), TYCON_NOTIFY_TIMEOUT_MS: '1000' }));
  assert.strictEqual(r.resultado.entregado, false);
  assert.strictEqual(r.resultado.motivo, 'sin respuesta en 1 s');
  salidas.push(JSON.stringify(r.resultado), r.stderr);
  // dirección inválida (http a otro host, basura, el literal de Azure sin expandir)
  for (const mala of ['http://hooks.acme.example/x', 'no es una dirección']) {
    r = entregar({ canal: 'slack', texto: 'x' }, entorno({ TYCON_NOTIFY_WEBHOOK_URL: mala }));
    assert.strictEqual(r.resultado.entregado, false);
    assert.strictEqual(r.resultado.motivo, 'dirección del webhook inválida');
    salidas.push(JSON.stringify(r.resultado), r.stderr);
  }
  for (const ausente of [undefined, '', '$(TYCON_NOTIFY_WEBHOOK_URL)']) {
    r = entregar({ canal: 'slack', texto: 'x' }, entorno(ausente === undefined ? {} : { TYCON_NOTIFY_WEBHOOK_URL: ausente }));
    assert.strictEqual(r.resultado.entregado, false);
    assert.strictEqual(r.resultado.motivo, 'falta la dirección del webhook (TYCON_NOTIFY_WEBHOOK_URL)');
  }
  // sin conexión (un puerto cerrado)
  r = entregar({ canal: 'slack', texto: 'x' }, entorno({ TYCON_NOTIFY_WEBHOOK_URL: `http://127.0.0.1:9${RUTA_SECRETA}` }));
  assert.strictEqual(r.resultado.entregado, false);
  assert.strictEqual(r.resultado.motivo, 'slack: no se pudo conectar');
  salidas.push(JSON.stringify(r.resultado), r.stderr);
  // por el CLI, con un 500: sale 3, y ni stdout ni stderr traen la dirección
  reset('status:500');
  const c = cli(['--channel', 'slack', '--', 'x'], entorno({ TYCON_NOTIFY_WEBHOOK_URL: url() }));
  assert.strictEqual(c.status, 3);
  assert.match(c.stderr, /slack contestó 500/);
  salidas.push(c.stdout, c.stderr);
  // ensayo: dice qué mandaría, sin la dirección
  const d = cli(['--channel', 'teams', '--dry-run', '--', 'x'], entorno({ TYCON_NOTIFY_WEBHOOK_URL: url() }));
  assert.strictEqual(d.status, 0, d.stderr);
  salidas.push(d.stdout, d.stderr);
  for (const s of salidas) {
    assert.ok(!s.includes(RUTA_SECRETA), `la ruta del webhook apareció: ${s}`);
    assert.ok(!s.includes('T0SECRETO') && !s.includes('abcdefghijkl'), `un pedazo del webhook apareció: ${s}`);
  }
  // limpiar() tapa la dirección del webhook en un texto cualquiera
  const N = require(NOTIFY);
  assert.strictEqual(N.limpiar(`falló ${url()} ayer`, { TYCON_NOTIFY_WEBHOOK_URL: url() }), 'falló <webhook> ayer');
  assert.strictEqual(N.limpiar(`token ${TOKEN}`, { TELEGRAM_BOT_TOKEN: TOKEN }), 'token <token>');
});

test('T20 Notify_SinCanal_NoManda @story-2.30 @ac-15 @ac-19', () => {
  reset('ok:1');
  // las variables de Telegram puestas no alcanzan: sin canal, no se manda
  const env = entorno({ TELEGRAM_BOT_TOKEN: TOKEN, TYCON_TELEGRAM_CHAT_ID: '990011223344' });
  const { resultado } = entregar({ canal: null, texto: 'x' }, env);
  assert.strictEqual(resultado.entregado, false);
  assert.strictEqual(resultado.motivo, 'canal sin configurar');
  assert.strictEqual(pedidos().length, 0, 'ningún pedido salió');
  // por el CLI con un operations.json sin `notify`: sale 3 y lo dice
  const ops = path.join(tmp, 'operations.json');
  fs.writeFileSync(ops, JSON.stringify({ version: 1, owners: { default: 'lead@acme.example' } }));
  let c = cli(['--operations', ops, '--', 'x'], env);
  assert.strictEqual(c.status, 3);
  assert.match(c.stderr, /canal sin configurar en operations\.json → notify/);
  assert.strictEqual(pedidos().length, 0);
  // un operations.json que no se puede leer, o con problemas, no cae a un canal: no manda y lo dice
  c = cli(['--operations', path.join(tmp, 'no-existe.json'), '--', 'x'], env);
  assert.strictEqual(c.status, 3);
  assert.match(c.stderr, /no pude leer operations\.json/);
  fs.writeFileSync(ops, JSON.stringify({ version: 1, owners: { default: 'lead@acme.example' }, notify: { channel: 'fax' } }));
  c = cli(['--operations', ops, '--', 'x'], env);
  assert.strictEqual(c.status, 3);
  assert.match(c.stderr, /operations\.json tiene problemas/);
  assert.strictEqual(pedidos().length, 0);
  // con `notify: telegram`, el mismo CLI manda
  fs.writeFileSync(ops, JSON.stringify({ version: 1, owners: { default: 'lead@acme.example' }, notify: { channel: 'telegram' } }));
  c = cli(['--operations', ops, '--', 'x'], env);
  assert.strictEqual(c.status, 0, c.stderr);
  assert.strictEqual(pedidos().length, 1);
  // uso: sin texto, o sin canal ni operations
  assert.strictEqual(cli(['--channel', 'telegram'], env).status, 2);
  assert.strictEqual(cli(['--', 'x'], env).status, 2);
});

test('T20b Notify_CanalDeYCuerpos_Directos @story-2.30 @ac-15', () => {
  const N = require(NOTIFY);
  const ops = path.join(tmp, 'ops-directo.json');
  const base = { version: 1, owners: { default: 'lead@acme.example' } };
  fs.writeFileSync(ops, JSON.stringify({ ...base, notify: { channel: 'teams' } }));
  assert.deepStrictEqual(N.canalDe(ops), { canal: 'teams', motivo: null });
  fs.writeFileSync(ops, JSON.stringify(base));
  assert.deepStrictEqual(N.canalDe(ops), { canal: null, motivo: 'canal sin configurar en operations.json → notify' });
  fs.writeFileSync(ops, '{ roto');
  assert.strictEqual(N.canalDe(ops).canal, null);
  assert.match(N.canalDe(ops).motivo, /operations\.json tiene problemas/);
  assert.match(N.canalDe(path.join(tmp, 'no-esta.json')).motivo, /no pude leer operations\.json/);
  // los cuerpos de cada webhook, directos
  assert.deepStrictEqual(N.cuerpoDe('slack', 'hola'), { text: 'hola' });
  assert.strictEqual(N.cuerpoDe('teams', 'hola').attachments[0].content.body[0].text, 'hola');
  // el ensayo sin canal no manda y lo dice
  assert.strictEqual(N.ensayo({ canal: null, texto: 'x' }).codigo, N.NO_ENTREGADO);
});
