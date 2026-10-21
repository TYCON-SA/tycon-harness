#!/usr/bin/env node
'use strict';
/**
 * notify.js — el único camino de salida de los avisos del arnés: los de la sesión de un dev (la ejecución espera a una
 * persona, la evidencia que se movió, los instintos nuevos) y los de la noche (el resumen de la mañana, el vigilante).
 *
 * ── POR QUÉ EXISTE ──────────────────────────────────────────────────────────────────────────────
 * El aviso salía sólo por Telegram, y una organización que usa Slack, Teams o el correo no tenía cómo recibirlo. La
 * organización elige uno o más canales en el perfil del equipo (`integrations.notify.channels`) y todo aviso sale por
 * acá, por cada canal elegido. Ninguna otra pieza llama a un canal por su cuenta.
 *
 * ── QUÉ CANALES ─────────────────────────────────────────────────────────────────────────────────
 *   · Sesión (`--side session`): la lista del perfil que lee la máquina. Sin la lista, lo de antes: Telegram.
 *   · Noche (`--operations`, y `--profile` con el perfil que trajo la noche): la lista de ese perfil. Sin la lista, o
 *     con un perfil que no se pudo leer, `operations.json → notify.channel` (el nombre viejo); en el segundo caso
 *     `canalesDeLaNoche` devuelve la línea que lo dice, para que el resumen la lleve.
 *   · `--channel <canal>`: uno solo, con las credenciales de la noche (lo de siempre).
 * Una lista vacía es «ningún canal»: no se manda nada, y no es un error.
 *
 * ── LOS CANALES ─────────────────────────────────────────────────────────────────────────────────
 * · telegram: por `scripts/lib/tycon-telegram-notify.sh`, el único cliente de Telegram del arnés (manda, y edita con
 *   `--edit`). Este archivo no arma la dirección de la API ni lee el token: lo hace el script.
 * · slack: un webhook entrante. Cuerpo `{ "text": … }` (https://api.slack.com/messaging/webhooks).
 * · teams: un webhook de un flujo de trabajo de Teams («When a Teams webhook request is received»; los conectores de
 *   Microsoft 365 están por retirarse). Cuerpo: un mensaje con una tarjeta adaptable (`type: message`, `attachments`
 *   con `application/vnd.microsoft.card.adaptive`), según
 *   https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook.
 *   Contesta 202.
 * · mail: por `scripts/lib/notify-mail.js`, con el servidor del perfil (`mail_host`, `mail_port`).
 * Un webhook o un correo no devuelven un id ni se editan: cada aviso es un mensaje nuevo (`editado: false`).
 *
 * ── LAS CREDENCIALES, POR LADO ──────────────────────────────────────────────────────────────────
 * Ninguna vive en el perfil. Las de la SESIÓN son del dev, en su máquina: `harness.js config set notify.<clave>`
 * (`slack_webhook`, `teams_webhook`, `mail_user`, `mail_password`, `mail_address` —a quién le llega el correo—), en el
 * archivo de secretos o en su variable; Telegram usa el bot y el chat de la máquina, como siempre. Las de la NOCHE son
 * las variables secretas del servidor: `TELEGRAM_BOT_TOKEN` y `TYCON_TELEGRAM_CHAT_ID`, `TYCON_SLACK_WEBHOOK_URL`,
 * `TYCON_TEAMS_WEBHOOK_URL` (o `TYCON_NOTIFY_WEBHOOK_URL`, el nombre viejo del único webhook), `TYCON_MAIL_USER` y
 * `TYCON_MAIL_PASSWORD`; el remitente y los destinatarios del correo de la noche salen de `operations.json → notify`
 * (`mail_from`, `mail_to`). La noche nunca lee el archivo de secretos de una máquina.
 *
 * 🔴 LA CREDENCIAL NUNCA SE IMPRIME ni se devuelve, ni entera ni en parte: los motivos son de un vocabulario cerrado
 * («slack contestó 500», «sin respuesta en 15 s», «dirección del webhook inválida», «slack: no se pudo conectar»,
 * «falta la dirección del webhook (…)», «mail: el servidor rechazó el usuario o la clave», «canal sin configurar»). El
 * error de red no se copia: puede traer la dirección. El envío sale desde un proceso hijo (este mismo archivo con
 * `--__post` o `--__mail`), así quien llama sigue sincrónico, como el script.
 *
 * ── USO ─────────────────────────────────────────────────────────────────────────────────────────
 *   node scripts/lib/notify.js --side session                                  [--dry-run] -- "texto"
 *   node scripts/lib/notify.js --operations <operations.json> [--profile <perfil>] [--edit <id>] [--dry-run] -- "texto"
 *   node scripts/lib/notify.js --channel telegram|slack|teams                  [--edit <id>] [--dry-run] -- "texto"
 *   (el correo necesita el servidor del perfil y los destinatarios de operations.json: sale con --operations)
 *   Con `--stdin` en lugar de `-- "texto"`, el texto se lee de la entrada estándar.
 *   Imprime el message_id si el canal lo da (Telegram).
 *   SALIDA: 0 mandado por al menos un canal (o ningún canal elegido) · 2 uso · 3 no entregado (el motivo, en stderr).
 *   El 3 es el mismo del script de Telegram: quien avisa tiene que poder distinguir «avisé» de «creí que avisaba».
 *
 * `require('./notify.js')`: `entregar({ canal, texto, editarId, lado })` → `{ canal, entregado, message_id, editado,
 * motivo, nota }`; `avisar({ canales, texto, editarId, lado, mail })` → `{ resultados, entregado }`; `canalesDeLaSesion`,
 * `canalesDeLaNoche`, `ensayo(...)`, `canalDe(archivo)`, `limpiar(texto)`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT_TELEGRAM = path.join(__dirname, 'tycon-telegram-notify.sh');
const CANALES = ['telegram', 'slack', 'teams', 'mail'];
const NO_ENTREGADO = 3;
const REINTENTOS = 2;           // el script no reintenta solo: corta a los 15 s y sale
const ESPERA_MS = 5000;
const TIMEOUT_SCRIPT_MS = 60000;
const TIMEOUT_WEBHOOK_MS = 15000;
const SIN_CANAL = 'canal sin configurar';
const WEBHOOK_INVALIDO = 'dirección del webhook inválida';
const LADOS = ['sesion', 'noche'];
// la variable del servidor de cada webhook; `TYCON_NOTIFY_WEBHOOK_URL` es el nombre viejo, de cuando había uno solo
const VARIABLE_WEBHOOK = { slack: 'TYCON_SLACK_WEBHOOK_URL', teams: 'TYCON_TEAMS_WEBHOOK_URL' };
const WEBHOOK_VIEJO = 'TYCON_NOTIFY_WEBHOOK_URL';
const VARIABLES_CREDENCIAL = ['TELEGRAM_BOT_TOKEN', WEBHOOK_VIEJO, ...Object.values(VARIABLE_WEBHOOK), 'TYCON_MAIL_USER', 'TYCON_MAIL_PASSWORD'];

function recortar(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
const primeraLinea = (s) => String(s || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
function dormir(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
const ladoDe = (lado) => (lado === 'session' || lado === 'sesion' ? 'sesion' : 'noche');
/** El valor de una variable del servidor, o null: vacía, o el literal de Azure sin expandir (`$(NOMBRE)`). */
function variable(env, nombre) {
  const v = String(env[nombre] || '').trim();
  return !v || /^\$\(.*\)$/.test(v) ? null : v;
}
function integraciones() { return require('./integrations.js'); }
/** Un secreto del dev (su variable o su archivo), o null. Nunca para mostrarlo. */
function secreto(clave, env) { try { return integraciones().readSecret(clave, { env }); } catch (_) { return null; } }
/**
 * El motivo de un secreto del dev que no está, con el comando que lo pone: un archivo de secretos dañado no es «falta»
 * (guardar encima se niega, para no borrar los otros), y unas credenciales que no se pudieron leer, tampoco.
 */
function faltaSecreto(clave, env, que) {
  let estado;
  try { estado = integraciones().secretState(clave, { env }); } catch (e) {
    return `${que}: no se pudieron leer las credenciales de esta máquina (${(e && e.code) || 'integrations.js no carga'})`;
  }
  if (/dañado/.test(String(estado))) return `${que}: el archivo de secretos de los avisos está dañado y no se lee — arreglalo o borralo y volvé a guardar con harness.js config set ${clave}`;
  return `${que}: harness.js config set ${clave}`;
}

/** Tapa las credenciales de los canales en un texto: las del servidor y las del dev, si vinieron de vuelta. */
function limpiar(s, env = process.env, extra = []) {
  let t = String(s || '');
  const tapar = (v, como) => { if (v && v.length >= 8) t = t.split(v).join(como); };
  for (const n of VARIABLES_CREDENCIAL) tapar(String(env[n] || '').trim(), n === 'TELEGRAM_BOT_TOKEN' ? '<token>' : /WEBHOOK/.test(n) ? '<webhook>' : '<credencial>');
  for (const v of extra) tapar(v, '<credencial>');
  return t;
}

/** https; o http sólo contra la propia máquina (las pruebas). Sin usuario ni clave en la dirección. */
function webhookValido(v) {
  let u;
  try { u = new URL(v); } catch { return false; }
  if (u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
}
function timeoutWebhook(env) {
  const n = Number(env.TYCON_NOTIFY_TIMEOUT_MS);
  return Number.isInteger(n) && n > 0 && n <= 60000 ? n : TIMEOUT_WEBHOOK_MS;
}

/** La dirección del webhook de un canal según el lado: `{ url }` o `{ motivo }`. */
function webhookDe(canal, lado, env) {
  if (lado === 'sesion') {
    const url = secreto(`notify.${canal}_webhook`, env);
    return url ? { url } : { motivo: faltaSecreto(`notify.${canal}_webhook`, env, `falta la dirección del webhook de ${canal}`) };
  }
  const url = variable(env, VARIABLE_WEBHOOK[canal]) || variable(env, WEBHOOK_VIEJO);
  return url ? { url } : { motivo: `falta la dirección del webhook (${VARIABLE_WEBHOOK[canal]} o ${WEBHOOK_VIEJO})` };
}

/** El cuerpo de cada webhook. */
function cuerpoDe(canal, texto) {
  if (canal === 'slack') return { text: texto };
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      contentUrl: null,
      content: { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.2', body: [{ type: 'TextBlock', text: texto, wrap: true }] },
    }],
  };
}

const resultado = (canal, extra) => ({ canal, entregado: false, message_id: null, editado: false, motivo: null, nota: null, ...extra });

// ── Telegram: por el script ────────────────────────────────────────────────────────────────────
// el texto va por la entrada estándar (`--stdin`), nunca como argumento: en Windows un argumento cruza la página de
// códigos del sistema y los acentos llegan rotos, y en la lista de procesos se vería entero
function correrScript(args, texto, env) {
  return spawnSync('bash', [SCRIPT_TELEGRAM, ...args, '--stdin'], { input: Buffer.from(texto, 'utf8'), encoding: 'utf8', timeout: TIMEOUT_SCRIPT_MS, env, windowsHide: true });
}

/**
 * Manda (o edita) con el script y clasifica lo que pasó. Tres respuestas que el script da como fallo y no lo son del
 * todo se separan acá: «message is not modified» es el texto que ya estaba (entregado), un mensaje que ya no se puede
 * editar cae a uno nuevo (y lo anota), y un corte por tiempo no se reintenta (el paso no se cuelga). Sólo un rechazo
 * `ok:false` se reintenta. `chat`: el destinatario de la máquina (`--chat-id`), si quien llama lo sabe.
 */
function telegram(texto, editarId, env, chat = null, { reintentar = true, nuevoSiNoEdita = true } = {}) {
  let editando = editarId ? String(editarId) : null;
  let nota = null;
  let reintentos = reintentar ? 0 : REINTENTOS;
  const chatArgs = chat ? ['--chat-id', String(chat)] : [];
  const falla = (motivo) => resultado('telegram', { motivo, nota });
  for (;;) {
    const r = correrScript([...chatArgs, ...(editando ? ['--edit', editando] : [])], texto, env);
    const out = String(r.stdout || '').trim();
    const err = limpiar(String(r.stderr || '').trim(), env);
    if (r.error || r.status === null) {
      return falla(`el script de Telegram no terminó (${r.error ? (r.error.code || r.error.message) : `señal ${r.signal}`})`);
    }
    if (r.status === 0) {
      const ultima = out.split('\n').pop();
      const id = /^\d+$/.test(ultima) ? Number(ultima) : null;
      const mid = editando ? Number(editando) : id;
      return resultado('telegram', { entregado: true, message_id: mid, editado: !!editando,
        nota: nota || (mid === null ? 'Telegram aceptó pero no devolvió message_id' : null) });
    }
    if (r.status === 3) {
      if (/message is not modified/i.test(err)) {
        return resultado('telegram', { entregado: true, message_id: editando ? Number(editando) : null, editado: !!editando,
          nota: 'el texto ya estaba (Telegram: message is not modified)' });
      }
      if (editando && nuevoSiNoEdita && /message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i.test(err)) {
        nota = `no se pudo editar el mensaje ${editando} (${recortar(primeraLinea(err), 140)}): se mandó uno nuevo`;
        editando = null;
        continue;
      }
      // `(28)` es el código de «se acabó el tiempo» del cliente HTTP que usa el script.
      if (/: \(28\) |timed out/i.test(err)) return falla(`sin respuesta de Telegram: el pedido cortó a los 15 s (${recortar(primeraLinea(err), 160)})`);
      if (/"ok"\s*:\s*false/.test(err) && reintentos < REINTENTOS) {
        reintentos += 1;
        dormir(ESPERA_MS);
        continue;
      }
      return falla(recortar(primeraLinea(err) || 'el script salió 3 sin decir por qué', 300));
    }
    return falla(`el script de Telegram salió ${r.status}: ${recortar(primeraLinea(err) || primeraLinea(out), 200)}`);
  }
}

// ── Slack y Teams: por el webhook, desde un proceso hijo ───────────────────────────────────────
function webhook(canal, texto, editarId, env, lado) {
  const w = webhookDe(canal, lado, env);
  if (!w.url) return resultado(canal, { motivo: w.motivo });
  if (!webhookValido(w.url)) return resultado(canal, { motivo: WEBHOOK_INVALIDO });
  const ms = timeoutWebhook(env);
  const r = spawnSync(process.execPath, [__filename, '--__post'], {
    input: JSON.stringify(cuerpoDe(canal, texto)), encoding: 'utf8', timeout: ms + 10000, windowsHide: true,
    env: { PATH: env.PATH, TYCON_NOTIFY_POST_URL: w.url, TYCON_NOTIFY_TIMEOUT_MS: String(ms) },
  });
  let dijo = null;
  try { dijo = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch { dijo = null; }
  const nota = editarId ? `${canal} no edita: se mandó un mensaje nuevo` : null;
  if (!dijo) return resultado(canal, { motivo: `${canal}: el envío no terminó`, nota });
  if (dijo.error === 'timeout') return resultado(canal, { motivo: `sin respuesta en ${Math.round(ms / 1000)} s`, nota });
  if (dijo.error) return resultado(canal, { motivo: `${canal}: no se pudo conectar`, nota });
  if (dijo.status >= 200 && dijo.status < 300) return resultado(canal, { entregado: true, nota });
  return resultado(canal, { motivo: `${canal} contestó ${dijo.status}`, nota });
}

/** El hijo: un POST, y una línea JSON con el código o el tipo de error. Nunca imprime la dirección ni el error de red. */
async function postHijo() {
  const url = process.env.TYCON_NOTIFY_POST_URL;
  const ms = Number(process.env.TYCON_NOTIFY_TIMEOUT_MS) || TIMEOUT_WEBHOOK_MS;
  const cuerpo = fs.readFileSync(0, 'utf8');
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: cuerpo, redirect: 'manual', signal: AbortSignal.timeout(ms) });
    try { await res.arrayBuffer(); } catch { /* el cuerpo de la respuesta no importa */ }
    process.stdout.write(`${JSON.stringify({ status: res.status })}\n`);
  } catch (e) {
    const corte = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    process.stdout.write(`${JSON.stringify({ error: corte ? 'timeout' : 'red' })}\n`);
  }
}

// ── El correo: por notify-mail.js, desde un proceso hijo ───────────────────────────────────────
const EMAIL = /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/;
const listaDeCorreos = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

/**
 * Los datos del correo según el lado: `{ datos }` o `{ motivo }`. `mail`: lo del perfil (`mail_host`, `mail_port`) y, en
 * la noche, lo de operations.json (`mail_from`, `mail_to`).
 */
function datosDeCorreo(lado, mail, env) {
  const m = mail || {};
  if (!m.mail_host) return { motivo: 'mail: falta el servidor (integrations.notify.mail_host en el perfil)' };
  const puerto = Number.isInteger(m.mail_port) ? m.mail_port : 587;
  if (lado === 'sesion') {
    const usuario = secreto('notify.mail_user', env);
    const clave = secreto('notify.mail_password', env);
    if (!usuario) return { motivo: faltaSecreto('notify.mail_user', env, 'mail: falta el usuario') };
    if (!clave) return { motivo: faltaSecreto('notify.mail_password', env, 'mail: falta la clave') };
    const direccion = secreto('notify.mail_address', env) || (EMAIL.test(usuario) ? usuario : null);
    if (!direccion || !EMAIL.test(direccion)) return { motivo: faltaSecreto('notify.mail_address', env, 'mail: falta a quién mandarlo') };
    return { datos: { host: m.mail_host, puerto, usuario, clave, de: direccion, para: [direccion] } };
  }
  const usuario = variable(env, 'TYCON_MAIL_USER');
  const clave = variable(env, 'TYCON_MAIL_PASSWORD');
  if (!usuario || !clave) return { motivo: 'mail: falta la credencial del servidor (TYCON_MAIL_USER y TYCON_MAIL_PASSWORD)' };
  const para = listaDeCorreos(m.mail_to);
  if (!para.length || !para.every((x) => EMAIL.test(x))) return { motivo: 'mail: falta a quién mandarlo (operations.json → notify.mail_to)' };
  const de = m.mail_from && EMAIL.test(m.mail_from) ? m.mail_from : (EMAIL.test(usuario) ? usuario : null);
  if (!de) return { motivo: 'mail: falta el remitente (operations.json → notify.mail_from)' };
  return { datos: { host: m.mail_host, puerto, usuario, clave, de, para } };
}

const MOTIVO_CORREO = {
  tiempo: (ms) => `mail: sin respuesta en ${Math.round(ms / 1000)} s`,
  red: () => 'mail: no se pudo conectar',
  tls: () => 'mail: el servidor no ofrece TLS (la clave no viaja en claro)',
  auth: () => 'mail: el servidor rechazó el usuario o la clave',
};
function correo(texto, env, lado, mail) {
  const d = datosDeCorreo(lado, mail, env);
  if (!d.datos) return resultado('mail', { motivo: d.motivo });
  const ms = timeoutWebhook(env);
  const asunto = recortar(primeraLinea(texto), 120) || 'aviso del arnés';
  const r = spawnSync(process.execPath, [__filename, '--__mail'], {
    input: JSON.stringify({ ...d.datos, asunto, texto, ms }), encoding: 'utf8', timeout: ms + 10000, windowsHide: true, env: { PATH: env.PATH },
  });
  let dijo = null;
  try { dijo = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch { dijo = null; }
  if (!dijo) return resultado('mail', { motivo: 'mail: el envío no terminó' });
  if (dijo.ok) return resultado('mail', { entregado: true });
  const f = MOTIVO_CORREO[dijo.error];
  if (f) return resultado('mail', { motivo: f(ms) });
  return resultado('mail', { motivo: `mail: el servidor contestó ${Number.isInteger(dijo.codigo) ? dijo.codigo : '?'}` });
}
async function correoHijo() {
  let o;
  try { o = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.stdout.write('{"error":"red"}\n'); return; }
  const r = await require('./notify-mail.js').enviar(o);
  process.stdout.write(`${JSON.stringify(r.ok ? { ok: true } : { error: r.error, codigo: r.codigo })}\n`);
}

/**
 * Manda por un canal. Sin canal (o uno desconocido), no manda nada: «canal sin configurar». `lado`: `sesion` (las
 * credenciales del dev) o `noche` (las del servidor, por defecto). `chat`: el chat de Telegram de la máquina.
 * `reintentar: false`: un solo intento. `nuevoSiNoEdita: false`: si el mensaje no se puede editar, falla (no manda otro).
 */
function entregar({ canal, texto, editarId = null, env = process.env, lado = 'noche', mail = null, chat = null, reintentar = true, nuevoSiNoEdita = true }) {
  if (!CANALES.includes(canal)) return resultado(canal || null, { motivo: SIN_CANAL });
  const l = ladoDe(lado);
  if (canal === 'telegram') return telegram(texto, editarId, env, chat, { reintentar, nuevoSiNoEdita });
  if (canal === 'mail') return correo(texto, env, l, mail);
  return webhook(canal, texto, editarId, env, l);
}

/**
 * Manda por cada canal: uno que falla no frena a los otros. `{ resultados, entregado }`: `entregado` si salió por al
 * menos uno (o si no había ningún canal: no es un error). Sólo Telegram edita: a los demás va un mensaje nuevo.
 */
function avisar({ canales, texto, editarId = null, env = process.env, lado = 'noche', mail = null, chat = null, reintentar = true }) {
  const resultados = (canales || []).map((canal) => entregar({ canal, texto, editarId: canal === 'telegram' ? editarId : null, env, lado, mail, chat, reintentar }));
  return { resultados, entregado: !resultados.length || resultados.some((r) => r.entregado) };
}

/** Los ajustes de los avisos en un perfil ya leído (`entradas` de tycon-config.leerPerfil o `valores` de cargar). */
const notifyDe = (valores) => (valores && valores.integraciones && valores.integraciones.notify) || null;

/**
 * Los canales de la sesión: `{ canales, mail, chat, origen, problema }` (`chat`: el de Telegram de la máquina, o null).
 * `origen`: `perfil` (la lista del perfil), `antes`
 * (sin la lista: Telegram, como siempre). Una configuración rota no manda por ningún canal: `problema` dice por qué.
 */
function canalesDeLaSesion({ env = process.env, home = os.homedir() } = {}) {
  let c;
  const rota = (errores, e) => {
    const motivo = errores.length ? errores.map((x) => `${x.clave || '(el archivo)'}: ${x.motivo}`).join(' · ') : String((e && e.message) || e);
    return { canales: [], mail: null, chat: null, origen: null, problema: `la configuración del arnés no se pudo leer (${recortar(motivo, 300)})` };
  };
  try { c = require('./tycon-config.js').cargar({ env, home }); } catch (e) { return rota(e && Array.isArray(e.errores) ? e.errores : [], e); }
  // un perfil o un archivo de la máquina con errores no se lee como «sin lista»: no se adivina por dónde mandar
  if (c.errores && c.errores.length) return rota(c.errores);
  const n = notifyDe(c.valores);
  const chat = (c.valores.telegram && c.valores.telegram.chat_id) || null;
  if (n && Array.isArray(n.channels)) return { canales: n.channels, mail: n, chat, origen: 'perfil', problema: null };
  return { canales: ['telegram'], mail: n, chat, origen: 'antes', problema: null };
}

/**
 * Los canales de la noche: `{ canales, mail, origen, aviso, motivo }`. Del perfil que trajo la noche (`perfil`: su
 * ruta) si trae la lista; si no, de `operations.json → notify.channel`. `aviso`: la línea para el resumen cuando el
 * perfil no se pudo leer. `motivo`: por qué no hay canal (sin lista y sin `notify.channel`). `perfilProblema`: por
 * qué la noche no pudo traer el perfil (el motivo ya limpio), si lo intentó y no pudo.
 */
function canalesDeLaNoche({ perfil = null, perfilProblema = null, operations, home = os.homedir() } = {}) {
  let aviso = null;
  let n = null;
  if (perfilProblema) aviso = `no se pudo leer el perfil del equipo (${recortar(perfilProblema, 160)}): el aviso salió por el canal de operations.json`;
  else if (perfil) {
    const TC = require('./tycon-config.js');
    const p = TC.leerPerfil({ env: { TYCON_PROFILE: perfil }, home });
    if (p.estado === 'leido') {
      const e = p.entradas.find((x) => x.ruta === 'integraciones.notify');
      n = e ? e.valor : null;
    } else {
      const por = p.estado === 'roto' && p.errores[0] && /no existe|ENOENT/.test(String(p.errores[0].motivo)) ? 'no está' : 'no es válido';
      aviso = `no se pudo leer el perfil del equipo (${por}): el aviso salió por el canal de operations.json`;
    }
  }
  const ops = operations ? opsNotify(operations) : { notify: null, motivo: `${SIN_CANAL} en operations.json → notify` };
  const mail = { ...(n || {}), mail_from: ops.notify && ops.notify.mail_from, mail_to: ops.notify && ops.notify.mail_to };
  if (n && Array.isArray(n.channels)) return { canales: n.channels, mail, origen: 'perfil', aviso: null, motivo: null };
  if (!ops.notify || !ops.notify.channel) return { canales: [], mail, origen: 'operations', aviso, motivo: ops.motivo || `${SIN_CANAL} en operations.json → notify` };
  return { canales: [ops.notify.channel], mail, origen: 'operations', aviso, motivo: null };
}

/** `operations.json → notify` validado: `{ notify, motivo }`. Uno ilegible o con problemas no cae a ningún canal. */
function opsNotify(archivo) {
  const OPS = require('./operations-config.js');
  const r = OPS.load(archivo);
  if (r.couldNotRead) return { notify: null, motivo: `no pude leer operations.json (${(r.problems[0] && r.problems[0].message.split(': ').pop()) || 'sin motivo'})` };
  if (!r.ok) return { notify: null, motivo: `operations.json tiene problemas: ${r.problems.map((p) => p.path || '(el archivo)').join(', ')}` };
  if (!r.data.notify) return { notify: null, motivo: `${SIN_CANAL} en operations.json → notify` };
  return { notify: r.data.notify, motivo: null };
}

/** El canal que declara un operations.json (el nombre viejo): `{ canal, motivo }`. */
function canalDe(archivo) {
  const o = opsNotify(archivo);
  if (!o.notify) return { canal: null, motivo: o.motivo };
  if (!o.notify.channel) return { canal: null, motivo: `${SIN_CANAL} en operations.json → notify.channel` };
  return { canal: o.notify.channel, motivo: null };
}

/** El ensayo de un canal: qué mandaría, sin mandar. `{ codigo, salida, error }`. El chat y la dirección no se muestran. */
function ensayo({ canal, texto, editarId = null, env = process.env, lado = 'noche', mail = null, chat = null }) {
  if (!CANALES.includes(canal)) return { codigo: NO_ENTREGADO, salida: '', error: SIN_CANAL };
  const l = ladoDe(lado);
  if (canal === 'telegram') {
    const r = correrScript(['--dry-run', ...(chat ? ['--chat-id', String(chat)] : []), ...(editarId ? ['--edit', String(editarId)] : [])], texto, env);
    const tapar = (s) => limpiar(String(s || ''), env).replace(/chat_id=\S+/g, 'chat_id=<oculto>');
    const primera = tapar(r.stdout).split(' texto=')[0].trim();
    return { codigo: r.status === 0 ? 0 : NO_ENTREGADO, salida: primera, error: r.status === 0 ? '' : tapar(r.stderr) };
  }
  if (canal === 'mail') {
    const d = datosDeCorreo(l, mail, env);
    if (!d.datos) return { codigo: NO_ENTREGADO, salida: '', error: d.motivo };
    return { codigo: 0, salida: `DRY-RUN mail: a ${d.datos.para.length} destinatario(s), ${texto.length} caracteres`, error: '' };
  }
  const w = webhookDe(canal, l, env);
  if (!w.url) return { codigo: NO_ENTREGADO, salida: '', error: w.motivo };
  if (!webhookValido(w.url)) return { codigo: NO_ENTREGADO, salida: '', error: WEBHOOK_INVALIDO };
  return { codigo: 0, salida: `DRY-RUN ${canal}: webhook, ${texto.length} caracteres${editarId ? ' (mensaje nuevo: no edita)' : ''}`, error: '' };
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────
function main(argv) {
  let canal = null; let ops = null; let perfil = null; let lado = null; let editarId = null; let dryRun = false; let texto = null; let error = null; let stdin = false;
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--') { texto = argv.slice(i + 1).join(' '); break; }
    if (v === '--channel') canal = argv[++i];
    else if (v === '--operations') ops = argv[++i];
    else if (v === '--profile') perfil = argv[++i];
    else if (v === '--side') lado = argv[++i];
    else if (v === '--edit') editarId = argv[++i];
    else if (v === '--dry-run') dryRun = true;
    else if (v === '--stdin') stdin = true;
    else { error = `opción desconocida: ${v}`; break; }
  }
  if (stdin && texto === null) { try { texto = fs.readFileSync(0, 'utf8').replace(/\s+$/, ''); } catch { texto = null; } }
  const modos = [canal, ops, lado].filter((x) => x !== null).length;
  if (canal === 'mail' && !error) error = '--channel mail no sabe el servidor ni a quién mandarlo: el correo sale con --operations <operations.json> --profile <perfil>';
  if (error || !texto || modos !== 1 || (perfil && !ops) || (lado !== null && lado !== 'session')
    || (editarId !== null && !/^\d+$/.test(String(editarId)))) {
    if (error) process.stderr.write(`${error}\n`);
    process.stderr.write('uso: notify.js --side session | --operations <operations.json> [--profile <perfil>] | --channel telegram|slack|teams [--edit <id>] [--dry-run] (-- "texto" | --stdin)\n');
    return 2;
  }
  let canales; let mail = null; let ladoEnvio = 'noche'; let chat = null;
  if (lado) {
    const s = canalesDeLaSesion();
    if (s.problema) { process.stderr.write(`🔴 notify: no se mandó el aviso: ${s.problema}\n`); return NO_ENTREGADO; }
    canales = s.canales; mail = s.mail; chat = s.chat; ladoEnvio = 'sesion';
  } else if (ops) {
    const n = canalesDeLaNoche({ perfil, operations: ops });
    if (n.aviso) process.stderr.write(`⚠️ notify: ${n.aviso}\n`);
    if (!n.canales.length && n.motivo) { process.stderr.write(`🔴 notify: no se mandó el aviso: ${n.motivo}\n`); return NO_ENTREGADO; }
    canales = n.canales; mail = n.mail;
  } else canales = [canal];
  if (!canales.length) { process.stderr.write('ℹ️ notify: ningún canal elegido en el perfil del equipo: no se manda nada\n'); return 0; }
  if (dryRun) {
    let codigo = 0;
    for (const c of canales) {
      const e = ensayo({ canal: c, texto, editarId, lado: ladoEnvio, mail, chat });
      if (e.salida) process.stdout.write(`${e.salida} (ensayo: no se mandó nada)\n`);
      if (e.codigo !== 0) { process.stderr.write(`🔴 notify: ${c}: ${e.error}\n`); codigo = NO_ENTREGADO; }
    }
    return codigo;
  }
  const r = avisar({ canales, texto, editarId, lado: ladoEnvio, mail, chat });
  for (const x of r.resultados) {
    if (!x.entregado) process.stderr.write(`🔴 notify: no se entregó por ${x.canal}: ${x.motivo}\n`);
    if (x.message_id !== null) process.stdout.write(`${x.message_id}\n`);
    if (x.nota) process.stderr.write(`ℹ️ notify: ${x.canal}: ${x.nota}\n`);
  }
  return r.entregado ? 0 : NO_ENTREGADO;
}

module.exports = {
  CANALES, LADOS, NO_ENTREGADO, SIN_CANAL, entregar, avisar, ensayo, canalDe, canalesDeLaSesion, canalesDeLaNoche, limpiar, cuerpoDe,
};

if (require.main === module) {
  const hijo = process.argv[2] === '--__post' ? postHijo : process.argv[2] === '--__mail' ? correoHijo : null;
  if (hijo) hijo().then(() => process.exit(0), () => { process.stdout.write('{"error":"red"}\n'); process.exit(0); });
  else process.exit(main(process.argv.slice(2)));
}
