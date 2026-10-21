'use strict';
// notify-channels.test.js — los avisos por varios canales: el perfil elige los canales, cada lado usa sus credenciales
// (la sesión, las del dev en su máquina; la noche, las del servidor), el canal mail y un canal que falla sin frenar a los
// otros. Y que ninguna otra pieza llame a un canal por su cuenta.
//
// 🔴 NINGÚN CASO TOCA LA RED. Telegram y los webhooks son un servidor HTTP local en OTRO proceso, y el correo un servidor
// SMTP local en otro proceso (el envío es sincrónico: en este mismo proceso quedarían bloqueados mientras se manda). El
// canal de Telegram es una carpeta de mentira (`TYCON_TELEGRAM_DIR`) y su API apunta al servidor local
// (`TYCON_TELEGRAM_API`): sin las dos, en la máquina de un dev el guion real mandaría un mensaje de verdad.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const NOTIFY = path.join(RAIZ, 'scripts', 'lib', 'notify.js');
const RESUMEN = path.join(RAIZ, 'scripts', 'nightly', 'dependencies', 'daily-summary.js');
// 🔴 los valores de mentira se arman por partes: escritos enteros, el freno del remoto público los toma por secretos reales
const TOKEN = ['tok', 'de-prueba-que-no-debe-aparecer'].join('-');
const RUTA_SLACK = ['', 'services', 'T0SLACK', 'B0SLACK', 'slackslackslackslack'].join('/');
const RUTA_SLACK_MAQUINA = ['', 'services', 'T0MAQUINA', 'B0MAQUINA', 'maquinamaquinamaquina'].join('/');
const CLAVE_MAIL = ['clave', 'del', 'correo', 'que-no-debe-aparecer'].join('-');
const USUARIO_MAIL = ['avisos', 'acme.example'].join('@');
const DIRECCION_DEV = ['dev', 'acme.example'].join('@');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-channels-'));
const canalDir = path.join(tmp, 'canal');
fs.mkdirSync(canalDir);
fs.writeFileSync(path.join(canalDir, '.env'), `TELEGRAM_BOT_TOKEN=${TOKEN}\n`);
fs.writeFileSync(path.join(canalDir, 'access.json'), '{"allowFrom":["990011223344"]}\n');

// El servidor HTTP: anota cada pedido y contesta lo que diga su archivo de respuestas, una línea por pedido (la última
// queda fija): `ok:<id>` (Telegram) · `status:<n>`.
const HTTP = `
const http = require('http'), fs = require('fs');
const [log, resp, puertoF] = process.argv.slice(1);
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => (b += d)).on('end', () => {
    fs.appendFileSync(log, JSON.stringify({ ruta: req.url, cuerpo: b }) + '\\n');
    const lineas = fs.readFileSync(resp, 'utf8').split('\\n').map((l) => l.trim()).filter(Boolean);
    const r = lineas[0] || '';
    if (lineas.length > 1) fs.writeFileSync(resp, lineas.slice(1).join('\\n') + '\\n');
    if (r.startsWith('ok:')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ok: true, result: { message_id: Number(r.slice(3)) } })); }
    if (r.startsWith('status:')) { res.statusCode = Number(r.slice(7)); return res.end(res.statusCode < 300 ? 'ok' : 'error'); }
    res.statusCode = 500; res.end('?');
  });
});
srv.listen(0, '127.0.0.1', () => fs.writeFileSync(puertoF, String(srv.address().port)));
`;
// El servidor de correo: AUTH PLAIN y LOGIN, sin TLS (sólo contra la propia máquina). Anota lo que recibe. Su modo:
// `accept`, `reject` (contesta 535 a la autenticación), `bare` (cada respuesta, sólo el código: la RFC 5321 lo
// permite) o `no-quit` (acepta el mensaje y no contesta el QUIT).
const SMTP = `
const net = require('net'), fs = require('fs');
const [log, modoF, puertoF] = process.argv.slice(1);
const anota = (o) => fs.appendFileSync(log, JSON.stringify(o) + '\\n');
const srv = net.createServer((s) => {
  let buf = '', enDatos = false, cuerpo = '', paso = null;
  const modo0 = fs.readFileSync(modoF, 'utf8').trim();
  // bare: la última línea de cada respuesta, sólo el código (las intermedias «NNN-texto» quedan)
  const w = (l) => s.write((modo0 === 'bare' && l[3] === ' ' ? l.slice(0, 3) : l) + '\\r\\n');
  s.on('error', () => {});
  w('220 prueba');
  s.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\\r\\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 2);
      if (enDatos) { if (l === '.') { enDatos = false; anota({ datos: cuerpo }); cuerpo = ''; w('250 ok'); } else cuerpo += l + '\\n'; continue; }
      const modo = fs.readFileSync(modoF, 'utf8').trim();
      const no = modo === 'reject';
      if (paso === 'usuario') { anota({ usuario: Buffer.from(l, 'base64').toString() }); paso = 'clave'; w('334 UGFzc3dvcmQ6'); continue; }
      if (paso === 'clave') { anota({ clave: Buffer.from(l, 'base64').toString() }); paso = null; w(no ? '535 5.7.8 no' : '235 ok'); continue; }
      const c = l.toUpperCase();
      if (c.startsWith('EHLO')) { w('250-prueba'); w('250 AUTH PLAIN LOGIN'); }
      else if (c.startsWith('AUTH PLAIN')) { const p = Buffer.from(l.split(' ')[2] || '', 'base64').toString().split('\\u0000'); anota({ usuario: p[1], clave: p[2] }); w(no ? '535 5.7.8 no' : '235 ok'); }
      else if (c.startsWith('AUTH LOGIN')) { paso = 'usuario'; w('334 VXNlcm5hbWU6'); }
      else if (c.startsWith('MAIL FROM')) { anota({ de: l }); w('250 ok'); }
      else if (c.startsWith('RCPT TO')) { anota({ para: l }); w('250 ok'); }
      else if (c === 'DATA') { enDatos = true; w('354 dale'); }
      else if (c === 'QUIT') { if (modo !== 'no-quit') { w('221 chau'); s.end(); } }
      else w('502 no');
    }
  });
});
srv.listen(0, '127.0.0.1', () => fs.writeFileSync(puertoF, String(srv.address().port)));
`;
const logHttp = path.join(tmp, 'http.jsonl');
const respHttp = path.join(tmp, 'http-respuesta');
const logSmtp = path.join(tmp, 'smtp.jsonl');
const modoSmtp = path.join(tmp, 'smtp-modo');
let procs = [];
let base;
let puertoSmtp;

async function levantar(codigo, args, puertoF) {
  procs.push(spawn(process.execPath, ['-e', codigo, ...args, puertoF], { stdio: 'ignore' }));
  for (let i = 0; i < 200 && !(fs.existsSync(puertoF) && fs.readFileSync(puertoF, 'utf8')); i++) await new Promise((r) => setTimeout(r, 25));
  return fs.readFileSync(puertoF, 'utf8');
}
test.before(async () => {
  fs.writeFileSync(logHttp, ''); fs.writeFileSync(respHttp, 'ok:777\n');
  fs.writeFileSync(logSmtp, ''); fs.writeFileSync(modoSmtp, 'accept\n');
  base = `http://127.0.0.1:${await levantar(HTTP, [logHttp, respHttp], path.join(tmp, 'puerto-http'))}`;
  puertoSmtp = Number(await levantar(SMTP, [logSmtp, modoSmtp], path.join(tmp, 'puerto-smtp')));
});
test.after(() => { for (const p of procs) p.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

const lineas = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
function reset(http = 'ok:777', smtp = 'accept') {
  fs.writeFileSync(logHttp, ''); fs.writeFileSync(respHttp, `${http}\n`);
  fs.writeFileSync(logSmtp, ''); fs.writeFileSync(modoSmtp, `${smtp}\n`);
}
const alTelegram = () => lineas(logHttp).filter((p) => p.ruta.startsWith('/bot'));
/** El texto de un correo recibido: va en base64 después de los encabezados. */
const textoDelCorreo = (datos) => Buffer.from(datos.split('\n\n').slice(1).join('').replace(/\s+/g, ''), 'base64').toString('utf8');
const alWebhook = (ruta) => lineas(logHttp).filter((p) => p.ruta === ruta);

/** Una casa de mentira (HOME y casa del arnés) con su perfil. `perfil` null: sin archivo de perfil. */
function casa(nombre, perfil, secretos = null) {
  const home = path.join(tmp, nombre);
  fs.mkdirSync(path.join(home, '.tycon'), { recursive: true });
  const archivo = path.join(home, 'team-profile.json');
  if (perfil !== null) fs.writeFileSync(archivo, typeof perfil === 'string' ? perfil : `${JSON.stringify(perfil, null, 2)}\n`);
  if (secretos) {
    const dir = path.join(home, '.tycon', 'secrets');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'notify.json'), JSON.stringify(secretos), { mode: 0o600 });
  }
  return { home, perfil: archivo };
}
/** El entorno de cada caso: sin nada del dev, con el canal y la API de mentira, y el perfil de la casa. */
function entorno(c, extra = {}) {
  return {
    // sin archivo de perfil, «sin perfil» (TYCON_PROFILE=0): nunca el del árbol que corre la prueba
    PATH: process.env.PATH, HOME: c.home, TYCON_HOME: path.join(c.home, '.tycon'), TYCON_PROFILE: fs.existsSync(c.perfil) ? c.perfil : '0',
    TYCON_TELEGRAM_DIR: canalDir, TYCON_TELEGRAM_API: base, TYCON_NOTIFY_TIMEOUT_MS: '5000', ...extra,
  };
}
function cli(args, env, input) {
  const r = spawnSync(process.execPath, [NOTIFY, ...args], { encoding: 'utf8', env, timeout: 60000, input });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', todo: `${r.stdout || ''}${r.stderr || ''}` };
}
const perfilCon = (notify) => ({ integrations: { notify } });
const sinSecretos = (salida) => {
  for (const s of [TOKEN, RUTA_SLACK, RUTA_SLACK_MAQUINA, CLAVE_MAIL, 'T0SLACK', 'T0MAQUINA']) assert.ok(!salida.includes(s), `la salida no muestra «${s.slice(0, 6)}…»`);
};

test('T26 Notify_OnlyPath_NoDirectTelegram @story-7.40 @ac-17', () => {
  // en el código del público, fuera de notify.js y de los clientes de cada canal, nadie llama a Telegram ni a un webhook
  const permitidos = new Set(['scripts/lib/notify.js', 'scripts/lib/notify-mail.js', 'scripts/lib/tycon-telegram-notify.sh']);
  const r = spawnSync('git', ['-C', RAIZ, 'grep', '-nE', 'tycon-telegram-notify|api\\.telegram\\.org|/sendMessage|hooks\\.slack\\.com|webhook\\.office',
    '--', '*.js', '*.mjs', '*.sh', '*.ps1', '*.py', ':!scripts/tests/**', ':!**/node_modules/**'], { encoding: 'utf8' });
  assert.ok(r.status === 0 || r.status === 1, `git grep corrió (${r.status}: ${r.stderr})`);
  const comentario = /^\s*(\/\/|#|\*|\/\*)/;
  const llamadas = r.stdout.split('\n').filter(Boolean).filter((l) => {
    const [archivo, , ...resto] = l.split(':');
    return !permitidos.has(archivo) && !comentario.test(resto.join(':'));
  });
  assert.deepStrictEqual(llamadas, [], 'sólo notify.js y el cliente de cada canal llaman a un canal');
  // y los que avisaban por su cuenta mandan por notify.js
  for (const f of ['scripts/hooks/wait-notice.js', 'scripts/ci/nightly-dod-notice.sh', 'scripts/instincts/instinct-observer.js']) {
    assert.match(fs.readFileSync(path.join(RAIZ, f), 'utf8'), /notify\.js/, `${f} manda por notify.js`);
  }

  // la grabadora de instintos: el token no va en la línea de comandos de ningún proceso
  const c = casa('t26', null);
  reset('ok:31');
  const codigo = `
    const cp = require('child_process'); const vistos = [];
    for (const f of ['spawn', 'spawnSync', 'execSync', 'execFileSync', 'exec', 'execFile']) {
      const o = cp[f]; cp[f] = function (...a) { vistos.push(JSON.stringify(a.filter((x) => typeof x === 'string' || Array.isArray(x)))); return o.apply(this, a); };
    }
    const obs = require(${JSON.stringify(path.join(RAIZ, 'scripts', 'instincts', 'instinct-observer.js'))});
    obs.maybeNotify(2, 0, { notify: true });
    process.stdout.write(JSON.stringify(vistos));`;
  const r2 = spawnSync(process.execPath, ['-e', codigo], { encoding: 'utf8', timeout: 60000,
    env: entorno(c, { TYCON_INSTINCT_NOTIFY: '1', TYCON_INSTINCT_TELEGRAM_BOT_TOKEN: TOKEN, TYCON_INSTINCT_TELEGRAM_CHAT_ID: '990011223344' }) });
  assert.strictEqual(r2.status, 0, r2.stderr);
  const vistos = JSON.parse(r2.stdout.trim().split('\n').pop());
  assert.ok(vistos.length >= 1, 'el aviso salió por un proceso');
  assert.ok(vistos.every((a) => !a.includes(TOKEN)), 'el token no está en la línea de comandos de ningún proceso');
  assert.strictEqual(alTelegram().length, 1, 'el aviso llegó a Telegram');
  assert.ok(alTelegram()[0].ruta.includes(TOKEN), 'con el token de la grabadora');
});

test('T27 Notify_ChannelsFromProfile_NoneSendsNothing @story-7.40 @ac-18', () => {
  // la lista vacía: no se manda nada y no es un error
  const vacia = casa('t27a', perfilCon({ channels: [] }));
  reset();
  let r = cli(['--side', 'session', '--', 'un aviso'], entorno(vacia));
  assert.strictEqual(r.status, 0, r.todo);
  assert.match(r.stderr, /ningún canal elegido/);
  assert.strictEqual(lineas(logHttp).length + lineas(logSmtp).length, 0, 'no salió nada');

  // sin la lista (el perfil de hoy): lo de antes, Telegram
  const deHoy = casa('t27b', { integrations: { engram: true } });
  reset('ok:5');
  r = cli(['--side', 'session', '--', 'un aviso'], entorno(deHoy));
  assert.strictEqual(r.status, 0, r.todo);
  assert.strictEqual(alTelegram().length, 1);

  // slack y mail: sale por los dos
  const dos = casa('t27c', perfilCon({ channels: ['slack', 'mail'], mail_host: '127.0.0.1', mail_port: puertoSmtp }));
  reset('status:200');
  r = cli(['--side', 'session', '--', 'un aviso por dos canales'], entorno(dos, {
    TYCON_SLACK_WEBHOOK_URL: `${base}${RUTA_SLACK}`, TYCON_MAIL_USER: USUARIO_MAIL, TYCON_MAIL_PASSWORD: CLAVE_MAIL, TYCON_MAIL_ADDRESS: DIRECCION_DEV,
  }));
  assert.strictEqual(r.status, 0, r.todo);
  assert.strictEqual(alWebhook(RUTA_SLACK).length, 1, 'llegó a Slack');
  assert.match(JSON.parse(alWebhook(RUTA_SLACK)[0].cuerpo).text, /un aviso por dos canales/);
  assert.ok(lineas(logSmtp).some((x) => x.datos && /un aviso por dos canales/.test(textoDelCorreo(x.datos))), 'llegó el correo');
  assert.strictEqual(alTelegram().length, 0, 'Telegram no estaba elegido');
  sinSecretos(r.todo);

  // un canal fuera del vocabulario deja el perfil roto: no se adivina
  const raro = casa('t27d', perfilCon({ channels: ['paloma'] }));
  reset();
  r = cli(['--side', 'session', '--', 'x'], entorno(raro));
  assert.strictEqual(r.status, 3, r.todo);
  assert.match(r.stderr, /paloma/);
  assert.strictEqual(lineas(logHttp).length, 0);
});

test('T29 Notify_DevSession_UsesDevCredentials @story-7.40 @ac-19 @ac-20', () => {
  // sin la credencial del dev: una línea con el comando, sin el valor, y sigue (no se cuelga ni tira)
  const sin = casa('t29a', perfilCon({ channels: ['slack'] }));
  reset('status:200');
  let r = cli(['--side', 'session', '--', 'x'], entorno(sin));
  assert.strictEqual(r.status, 3, r.todo);
  assert.match(r.stderr, /harness\.js config set notify\.slack_webhook/);
  assert.strictEqual(lineas(logHttp).length, 0);

  // con la del dev, guardada en su máquina: sale con ésa, y no se imprime
  const con = casa('t29b', perfilCon({ channels: ['slack'] }), { slack_webhook: `${base}${RUTA_SLACK_MAQUINA}` });
  reset('status:200');
  r = cli(['--side', 'session', '--', 'aviso de la sesión'], entorno(con));
  assert.strictEqual(r.status, 0, r.todo);
  assert.strictEqual(alWebhook(RUTA_SLACK_MAQUINA).length, 1, 'salió con la credencial del dev');
  sinSecretos(r.todo);

  // la noche: con los secretos del servidor, aunque la máquina tenga los suyos; sin los del servidor, no usa los de la máquina
  const ops = path.join(tmp, 't29-operations.json');
  fs.writeFileSync(ops, '{ "version": 1, "owners": { "default": "lead@acme.example" }, "notify": { "channel": "telegram" } }\n');
  reset('status:200');
  r = cli(['--operations', ops, '--profile', con.perfil, '--', 'aviso de la noche'], entorno(con, { TYCON_SLACK_WEBHOOK_URL: `${base}${RUTA_SLACK}` }));
  assert.strictEqual(r.status, 0, r.todo);
  assert.strictEqual(alWebhook(RUTA_SLACK).length, 1, 'salió con la del servidor');
  assert.strictEqual(alWebhook(RUTA_SLACK_MAQUINA).length, 0, 'nunca con la de la máquina');
  sinSecretos(r.todo);
  reset('status:200');
  r = cli(['--operations', ops, '--profile', con.perfil, '--', 'aviso de la noche'], entorno(con));
  assert.strictEqual(r.status, 3, r.todo);
  assert.match(r.stderr, /TYCON_SLACK_WEBHOOK_URL/);
  assert.strictEqual(lineas(logHttp).length, 0, 'la noche no cae a la credencial de la máquina');
  sinSecretos(r.todo);

  // un archivo de secretos dañado no es «falta»: guardar encima se niega, así que el aviso dice qué pasa
  const danado = casa('t29c', perfilCon({ channels: ['slack'] }));
  fs.mkdirSync(path.join(danado.home, '.tycon', 'secrets'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(danado.home, '.tycon', 'secrets', 'notify.json'), '{ roto', { mode: 0o600 });
  reset('status:200');
  r = cli(['--side', 'session', '--', 'x'], entorno(danado));
  assert.strictEqual(r.status, 3, r.todo);
  assert.match(r.stderr, /dañado/);

  // el correo de la noche: la credencial del servidor y los destinatarios de operations.json
  const opsCorreo = path.join(tmp, 't29-ops-correo.json');
  fs.writeFileSync(opsCorreo, JSON.stringify({ version: 1, owners: { default: 'lead@acme.example' }, notify: { channel: 'telegram', mail_from: USUARIO_MAIL, mail_to: `${DIRECCION_DEV}, lead@acme.example` } }));
  const perfilCorreo = casa('t29d', perfilCon({ channels: ['mail'], mail_host: '127.0.0.1', mail_port: puertoSmtp }), { mail_user: 'de-la-maquina', mail_password: 'de-la-maquina' });
  reset();
  r = cli(['--operations', opsCorreo, '--profile', perfilCorreo.perfil, '--', 'el resumen por correo'], entorno(perfilCorreo, { TYCON_MAIL_USER: USUARIO_MAIL, TYCON_MAIL_PASSWORD: CLAVE_MAIL }));
  assert.strictEqual(r.status, 0, r.todo);
  const s = lineas(logSmtp);
  assert.ok(s.some((x) => x.usuario === USUARIO_MAIL && x.clave === CLAVE_MAIL), 'con la credencial del servidor');
  assert.deepStrictEqual(s.filter((x) => x.para).map((x) => x.para), [`RCPT TO:<${DIRECCION_DEV}>`, 'RCPT TO:<lead@acme.example>'], 'a los destinatarios de operations.json');
  sinSecretos(r.todo);
  // sin la del servidor, la noche no usa la de la máquina
  reset();
  r = cli(['--operations', opsCorreo, '--profile', perfilCorreo.perfil, '--', 'x'], entorno(perfilCorreo));
  assert.strictEqual(r.status, 3, r.todo);
  assert.match(r.stderr, /TYCON_MAIL_USER/);
  assert.strictEqual(lineas(logSmtp).length, 0);
  // --channel mail no sabe el servidor ni a quién: es un uso, no un envío que falla siempre
  r = cli(['--channel', 'mail', '--', 'x'], entorno(perfilCorreo, { TYCON_MAIL_USER: USUARIO_MAIL, TYCON_MAIL_PASSWORD: CLAVE_MAIL }));
  assert.strictEqual(r.status, 2, r.todo);
  assert.match(r.stderr, /--operations/);
});

test('T30 Notify_Mail_NeverLeaksSecret @story-7.40 @ac-21', async () => {
  const c = casa('t30', perfilCon({ channels: ['mail'], mail_host: '127.0.0.1', mail_port: puertoSmtp }));
  const env = entorno(c, { TYCON_MAIL_USER: USUARIO_MAIL, TYCON_MAIL_PASSWORD: CLAVE_MAIL, TYCON_MAIL_ADDRESS: DIRECCION_DEV });
  reset();
  let r = cli(['--side', 'session', '--', 'La ejecución espera a una persona: ñandú ✔\nsegunda línea'], env);
  assert.strictEqual(r.status, 0, r.todo);
  const s = lineas(logSmtp);
  assert.ok(s.some((x) => x.usuario === USUARIO_MAIL && x.clave === CLAVE_MAIL), 'se autenticó con la credencial');
  assert.ok(s.some((x) => x.para && x.para.includes(DIRECCION_DEV)), 'al dev');
  const datos = s.find((x) => x.datos).datos;
  assert.match(datos, /^Subject: =\?UTF-8\?B\?/m, 'el asunto en UTF-8');
  assert.match(Buffer.from(/^Subject: =\?UTF-8\?B\?([^?]+)\?=/m.exec(datos)[1], 'base64').toString(), /ñandú/);
  assert.match(datos, /Content-Type: text\/plain; charset=utf-8/i);
  assert.strictEqual(textoDelCorreo(datos), 'La ejecución espera a una persona: ñandú ✔\nsegunda línea', 'el texto entero, con sus acentos');
  sinSecretos(r.todo);

  // el servidor rechaza la clave: un motivo del vocabulario, sin la clave ni el usuario en ninguna salida
  reset('ok:1', 'reject');
  r = cli(['--side', 'session', '--', 'x'], env);
  assert.strictEqual(r.status, 3, r.todo);
  assert.match(r.stderr, /mail: el servidor rechazó el usuario o la clave/);
  sinSecretos(r.todo);
  assert.ok(!r.todo.includes(USUARIO_MAIL));

  // sin servidor en el perfil, o sin credencial: lo dice y no intenta
  const sinHost = casa('t30b', perfilCon({ channels: ['mail'] }));
  reset();
  r = cli(['--side', 'session', '--', 'x'], entorno(sinHost, { TYCON_MAIL_USER: USUARIO_MAIL, TYCON_MAIL_PASSWORD: CLAVE_MAIL, TYCON_MAIL_ADDRESS: DIRECCION_DEV }));
  assert.strictEqual(r.status, 3);
  assert.match(r.stderr, /mail_host/);
  r = cli(['--side', 'session', '--', 'x'], entorno(c));
  assert.strictEqual(r.status, 3);
  assert.match(r.stderr, /harness\.js config set notify\.mail_user/);
  assert.strictEqual(lineas(logSmtp).length, 0);

  // respuestas con el código solo (válidas según la RFC 5321): el correo sale igual, no espera hasta el corte
  reset('ok:1', 'bare');
  r = cli(['--side', 'session', '--', 'con respuestas peladas'], { ...env, TYCON_NOTIFY_TIMEOUT_MS: '4000' });
  assert.strictEqual(r.status, 0, r.todo);
  assert.ok(lineas(logSmtp).some((x) => x.datos && /con respuestas peladas/.test(textoDelCorreo(x.datos))));
  // el servidor aceptó el mensaje y no contesta la despedida: se entregó (no se informa como fallido ni se reintenta)
  reset('ok:1', 'no-quit');
  r = cli(['--side', 'session', '--', 'sin despedida'], { ...env, TYCON_NOTIFY_TIMEOUT_MS: '2000' });
  assert.strictEqual(r.status, 0, r.todo);
  assert.strictEqual(lineas(logSmtp).filter((x) => x.datos).length, 1, 'un solo correo');
  // un servidor que no se alcanza: «no se pudo conectar», también en el 465 (no «el servidor no ofrece TLS»)
  const M = require(path.join(RAIZ, 'scripts', 'lib', 'notify-mail.js'));
  const cerrado = await new Promise((ok) => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
  for (const puerto of [cerrado, 465]) {
    const x = await M.enviar({ host: '127.0.0.1', puerto: puerto === 465 ? cerrado : puerto, tlsDirecto: puerto === 465, usuario: 'u', clave: 'c', de: DIRECCION_DEV, para: [DIRECCION_DEV], asunto: 'x', texto: 'x', ms: 3000 });
    assert.deepStrictEqual(x, { error: 'red' }, `puerto ${puerto === 465 ? 'con TLS directo' : 'en claro'}`);
  }
  // fuera de la propia máquina, sin TLS no se manda la clave
  assert.strictEqual(M.correoSeguro({ host: 'smtp.acme.example', conTls: false }), false);
  assert.strictEqual(M.correoSeguro({ host: 'smtp.acme.example', conTls: true }), true);
  assert.strictEqual(M.correoSeguro({ host: '127.0.0.1', conTls: false }), true);
});

test('T31 Notify_ManyChannels_OneFailsOthersSend @story-7.40 @ac-22', () => {
  const c = casa('t31', perfilCon({ channels: ['telegram', 'slack'] }));
  reset('status:500\nstatus:200');
  const r = cli(['--side', 'session', '--', 'un aviso'], entorno(c, { TYCON_SLACK_WEBHOOK_URL: `${base}${RUTA_SLACK}` }));
  assert.strictEqual(r.status, 0, r.todo);
  assert.strictEqual(alTelegram().length, 1, 'probó Telegram');
  assert.strictEqual(alWebhook(RUTA_SLACK).length, 1, 'y salió por Slack igual');
  assert.match(r.stderr, /no se entregó por telegram/);
  sinSecretos(r.todo);
});

test('T53 Notify_Night_FallsBackToOldChannel @story-7.40 @ac-20', () => {
  const D = path.join(tmp, 't53');
  const hoy = '2026-10-21';
  const ops = path.join(D, 'operations.json');
  const armar = (perfil) => {
    fs.rmSync(D, { recursive: true, force: true });
    fs.mkdirSync(path.join(D, 'out'), { recursive: true }); fs.mkdirSync(path.join(D, 'pend'));
    fs.writeFileSync(ops, '{ "version": 1, "owners": { "default": "lead@acme.example" }, "notify": { "channel": "telegram" } }\n');
    fs.writeFileSync(path.join(D, 'out', `dependencias-${hoy}.json`), '{"fecha":"2026-10-21","repos":[],"hallazgos":[],"no_medido":[]}\n');
    if (perfil !== null) fs.writeFileSync(path.join(D, 'team-profile.json'), perfil);
  };
  const entregar = (extra = []) => spawnSync(process.execPath, [RESUMEN, 'deliver', '--source', 'dependencies', '--today', hoy,
    '--out', path.join(D, 'out'), '--pending', path.join(D, 'pend'), '--operations', ops, ...extra],
  { encoding: 'utf8', timeout: 90000, env: { PATH: process.env.PATH, HOME: D, TYCON_TELEGRAM_DIR: canalDir, TYCON_TELEGRAM_API: base,
    TELEGRAM_BOT_TOKEN: TOKEN, TYCON_TELEGRAM_CHAT_ID: '990011223344', TYCON_SLACK_WEBHOOK_URL: `${base}${RUTA_SLACK}`, TYCON_NOTIFY_TIMEOUT_MS: '5000' } });
  const texto = () => decodeURIComponent((alTelegram()[0].cuerpo.match(/(?:^|&)text=([^&]*)/) || [])[1].replace(/\+/g, ' '));
  const constancia = () => JSON.parse(fs.readFileSync(path.join(D, 'out', `dependencias-${hoy}.json`), 'utf8')).resumen;

  // el perfil de hoy (sin la lista): sale por Telegram como hoy, sin ninguna línea nueva
  armar('{ "integrations": { "engram": true } }\n');
  reset('ok:41');
  let r = entregar(['--profile', path.join(D, 'team-profile.json')]);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.strictEqual(alTelegram().length, 1, 'por Telegram');
  assert.strictEqual(alWebhook(RUTA_SLACK).length, 0);
  assert.ok(!/perfil/.test(texto()), 'el resumen no dice nada del perfil');
  assert.strictEqual(constancia().canal, 'telegram');
  assert.strictEqual(constancia().message_id, 41);

  // sin --profile (la noche de hoy, antes de que se le pase): igual que hoy
  armar(null);
  reset('ok:42');
  r = entregar();
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.strictEqual(alTelegram().length, 1);
  assert.ok(!/perfil/.test(texto()));

  // un perfil que no se pudo leer: por Telegram, y el resumen lo dice
  armar('{ esto no es json\n');
  reset('ok:43');
  r = entregar(['--profile', path.join(D, 'team-profile.json')]);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.strictEqual(alTelegram().length, 1, 'por el canal viejo');
  assert.match(texto(), /no se pudo leer el perfil/);
  assert.match(texto(), /operations\.json/);
  // y uno que no está, igual
  armar(null);
  reset('ok:44');
  r = entregar(['--profile', path.join(D, 'team-profile.json')]);
  assert.strictEqual(alTelegram().length, 1);
  assert.match(texto(), /no se pudo leer el perfil/);

  // con la lista: sale por lo que dice el perfil
  armar(`${JSON.stringify(perfilCon({ channels: ['slack'] }))}\n`);
  reset('status:200');
  r = entregar(['--profile', path.join(D, 'team-profile.json')]);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.strictEqual(alWebhook(RUTA_SLACK).length, 1, 'por Slack');
  assert.strictEqual(alTelegram().length, 0);
  assert.deepStrictEqual(constancia().canales.map((x) => [x.canal, x.entregado]), [['slack', true]]);
  sinSecretos(`${r.stdout}${r.stderr}${JSON.stringify(constancia())}`);

  // la lista vacía es «ninguno»: no se manda, y la constancia no se lee como un resumen que no llegó
  armar(`${JSON.stringify(perfilCon({ channels: [] }))}\n`);
  reset('ok:45');
  r = entregar(['--profile', path.join(D, 'team-profile.json')]);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.strictEqual(lineas(logHttp).length, 0, 'no salió nada');
  assert.strictEqual(constancia().sin_canales, true);
  assert.strictEqual(require(RESUMEN).entregado(constancia()), true, 'el resumen siguiente no lo cuenta como fallo');
  assert.strictEqual(require(path.join(RAIZ, 'scripts', 'hooks', 'dependencies-notice.js')).lineaResumen('dependencias', constancia()), null, 'el arranque no lo marca en rojo');

  // el vigilante con Telegram y Slack: Telegram edita el de la mañana con las dos secciones; Slack, que no edita, recibe
  // sólo la del vigilante y lo dice (ya tiene la de dependencias)
  armar(`${JSON.stringify(perfilCon({ channels: ['telegram', 'slack'] }))}\n`);
  reset('ok:61\nstatus:200');
  r = entregar(['--profile', path.join(D, 'team-profile.json')]);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  fs.mkdirSync(path.join(D, 'vig')); fs.mkdirSync(path.join(D, 'vigpend'));
  fs.writeFileSync(path.join(D, 'vig', `vigilante-${hoy}.json`), JSON.stringify({ fecha: hoy, generado: `${hoy}T08:00:00.000Z`, productos: {}, conteos: {}, hallazgos: [], no_medido: [], nuevos: 0, repetidos: 0, marcados_ignorados: 0, ignorados_ids: [], modo: 'normal', aviso: null, recordados: 0 }));
  reset('ok:61\nstatus:200');
  const v = spawnSync(process.execPath, [RESUMEN, 'deliver', '--source', 'vigilante', '--today', hoy, '--out', path.join(D, 'vig'), '--pending', path.join(D, 'vigpend'),
    '--deps-out', path.join(D, 'out'), '--operations', ops, '--profile', path.join(D, 'team-profile.json')],
  { encoding: 'utf8', timeout: 90000, env: { PATH: process.env.PATH, HOME: D, TYCON_TELEGRAM_DIR: canalDir, TYCON_TELEGRAM_API: base,
    TELEGRAM_BOT_TOKEN: TOKEN, TYCON_TELEGRAM_CHAT_ID: '990011223344', TYCON_SLACK_WEBHOOK_URL: `${base}${RUTA_SLACK}`, TYCON_NOTIFY_TIMEOUT_MS: '5000' } });
  assert.strictEqual(v.status, 0, `${v.stdout}${v.stderr}`);
  assert.ok(alTelegram()[0].ruta.endsWith('/editMessageText'), 'Telegram edita el de la mañana');
  const aSlack = JSON.parse(alWebhook(RUTA_SLACK)[0].cuerpo).text;
  assert.match(aSlack, /va aparte \(slack no edita\)/);
  assert.ok(!/pedidos creados/.test(aSlack), 'Slack no recibe otra vez la sección de dependencias');

  // el modelo público: la noche baja el perfil del repo que declara team-repos.json (acá, un repo local en lugar de Azure)
  const bare = path.join(tmp, 't53-perfil.git');
  const obra = path.join(tmp, 't53-perfil');
  const git = (...a) => {
    const g = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Lab', GIT_AUTHOR_EMAIL: 'lab@acme.example', GIT_COMMITTER_NAME: 'Lab', GIT_COMMITTER_EMAIL: 'lab@acme.example',
      GIT_AUTHOR_DATE: '2026-10-21T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-21T12:00:00Z' } });
    assert.strictEqual(g.status, 0, g.stderr);
  };
  git('init', '-q', '--bare', '-b', 'main', bare); git('init', '-q', '-b', 'main', obra);
  fs.writeFileSync(path.join(obra, 'team-profile.json'), `${JSON.stringify(perfilCon({ channels: ['slack'] }))}\n`);
  git('-C', obra, 'add', '-A'); git('-C', obra, 'commit', '-qm', 'perfil'); git('-C', obra, 'push', '-q', bare, 'main');
  const repos = path.join(tmp, 't53-team-repos.json');
  fs.writeFileSync(repos, JSON.stringify({ version: 1, public: { platform: 'github', org: 'acme', repo: 'harness' }, profile: { platform: 'azure', org: 'acme', project: 'Proy', repo: 'perfil' }, operations: { platform: 'azure', org: 'acme', project: 'Proy', repo: 'ops' } }));
  const redirigir = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${bare}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://dev.azure.com/acme/Proy/_git/perfil' };
  const entregarCon = (env) => spawnSync(process.execPath, [RESUMEN, 'deliver', '--source', 'dependencies', '--today', hoy, '--out', path.join(D, 'out'), '--pending', path.join(D, 'pend'),
    '--operations', ops, '--team-repos', repos, '--clone-dir', path.join(D, 'clones')],
  { encoding: 'utf8', timeout: 90000, env: { PATH: process.env.PATH, HOME: D, TYCON_TELEGRAM_DIR: canalDir, TYCON_TELEGRAM_API: base, TELEGRAM_BOT_TOKEN: TOKEN,
    TYCON_TELEGRAM_CHAT_ID: '990011223344', TYCON_SLACK_WEBHOOK_URL: `${base}${RUTA_SLACK}`, TYCON_NOTIFY_TIMEOUT_MS: '5000', GIT_TERMINAL_PROMPT: '0', ...env } });
  armar(null);
  reset('status:200');
  r = entregarCon(redirigir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.strictEqual(alWebhook(RUTA_SLACK).length, 1, 'por el canal del perfil que bajó');
  // sin poder bajarlo: por el canal viejo, y el resumen lo dice
  armar(null);
  reset('ok:46');
  r = entregarCon({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${path.join(tmp, 'no-existe.git')}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://dev.azure.com/acme/Proy/_git/perfil' });
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.strictEqual(alTelegram().length, 1);
  assert.match(texto(), /no se pudo leer el perfil del equipo \(no se pudo bajar/);

  // la credencial de clonado va sólo a su servidor: la de Azure, al host de Azure (no a una dirección que lo nombra);
  // a GitHub, sólo el permiso propio de GitHub
  const espia = `
    const cp = require('child_process'); const vistos = [];
    cp.spawnSync = (cmd, args) => { vistos.push((args || []).join(' ')); return { status: 1, stdout: '', stderr: 'fatal: probando' }; };
    const RS = require(${JSON.stringify(path.join(RAIZ, 'scripts', 'metrics', 'retro-sweep.js'))});
    const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'espia-'));
    const auth = (fuente) => { vistos.length = 0; RS.obtain({ nombre: 'r', fuente }, dir); return (vistos.find((v) => v.includes('clone')) || '').match(/AUTHORIZATION: (\\w+)/i); };
    const out = { azure: auth('https://dev.azure.com/acme/Proy/_git/r'), disfrazada: auth('https://otro.example/dev.azure.com/r'), github: auth('https://github.com/acme/r') };
    process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, m]) => [k, m ? m[1].toLowerCase() : null]))));`;
  const sinGithub = JSON.parse(spawnSync(process.execPath, ['-e', espia], { encoding: 'utf8', env: { PATH: process.env.PATH, CLONE_TOKEN: TOKEN } }).stdout);
  assert.deepStrictEqual(sinGithub, { azure: 'bearer', disfrazada: null, github: null }, 'la de Azure no sale de Azure');
  const conGithub = JSON.parse(spawnSync(process.execPath, ['-e', espia], { encoding: 'utf8', env: { PATH: process.env.PATH, CLONE_TOKEN: TOKEN, GITHUB_CLONE_TOKEN: TOKEN } }).stdout);
  assert.strictEqual(conGithub.github, 'basic', 'a GitHub, su permiso propio');
});
