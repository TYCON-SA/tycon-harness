#!/usr/bin/env node
'use strict';
/**
 * notify.js — el canal del aviso de los nocturnos: el único camino de salida del resumen de la mañana y del aviso del
 * vigilante.
 *
 * ── POR QUÉ EXISTE ──────────────────────────────────────────────────────────────────────────────
 * El aviso salía sólo por Telegram, y una organización que usa Slack o Teams no tenía cómo recibirlo. Esto elige el
 * canal que declara `operations.json → notify.channel` y manda por él. Sin `notify` no se manda nada: un canal por
 * defecto sería un valor de una organización en el código.
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
 * Un webhook no devuelve un id ni se edita: con Slack o Teams cada aviso es un mensaje nuevo (`editado: false`).
 *
 * 🔴 LA DIRECCIÓN DEL WEBHOOK ES LA CREDENCIAL. Llega por la variable secreta `TYCON_NOTIFY_WEBHOOK_URL` y nunca se
 * imprime ni se devuelve, ni entera ni en parte: los motivos son de un vocabulario cerrado («slack contestó 500», «sin
 * respuesta en 15 s», «dirección del webhook inválida», «slack: no se pudo conectar», «falta la dirección del webhook
 * (TYCON_NOTIFY_WEBHOOK_URL)», «canal sin configurar»). El error de red no se copia: puede traer la dirección. El pedido
 * sale desde un proceso hijo (este mismo archivo con `--__post`), así quien llama sigue sincrónico, como el script.
 *
 * ── USO ─────────────────────────────────────────────────────────────────────────────────────────
 *   node scripts/lib/notify.js --operations <operations.json> [--edit <message_id>] [--dry-run] -- "texto"
 *   node scripts/lib/notify.js --channel telegram|slack|teams  [--edit <message_id>] [--dry-run] -- "texto"
 *   Imprime el message_id si el canal lo da (Telegram).
 *   SALIDA: 0 mandado · 2 uso · 3 no entregado (el motivo, en stderr). El 3 es el mismo del script de Telegram: quien
 *   avisa tiene que poder distinguir «avisé» de «creí que avisaba».
 *
 * `require('./notify.js')`: `entregar({ canal, texto, editarId })` → `{ canal, entregado, message_id, editado, motivo,
 * nota }`; `ensayo(...)`; `canalDe(archivo)`; `limpiar(texto)`.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT_TELEGRAM = path.join(__dirname, 'tycon-telegram-notify.sh');
const CANALES = ['telegram', 'slack', 'teams'];
const NO_ENTREGADO = 3;
const REINTENTOS = 2;           // el script no reintenta solo: corta a los 15 s y sale
const ESPERA_MS = 5000;
const TIMEOUT_SCRIPT_MS = 60000;
const TIMEOUT_WEBHOOK_MS = 15000;
const SIN_CANAL = 'canal sin configurar';
const SIN_WEBHOOK = 'falta la dirección del webhook (TYCON_NOTIFY_WEBHOOK_URL)';
const WEBHOOK_INVALIDO = 'dirección del webhook inválida';

function recortar(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
const primeraLinea = (s) => String(s || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
function dormir(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/** Tapa las credenciales del canal en un texto: el token del bot y la dirección del webhook, si vinieron de vuelta. */
function limpiar(s, env = process.env) {
  let t = String(s || '');
  const tok = env.TELEGRAM_BOT_TOKEN;
  if (tok && tok.length >= 8) t = t.split(tok).join('<token>');
  const wh = env.TYCON_NOTIFY_WEBHOOK_URL;
  if (wh && wh.length >= 8) t = t.split(wh).join('<webhook>');
  return t;
}

/** La dirección del webhook, o null si falta (vacía, o el literal de Azure sin expandir: `$(TYCON_NOTIFY_WEBHOOK_URL)`). */
function webhookDe(env) {
  const v = String(env.TYCON_NOTIFY_WEBHOOK_URL || '').trim();
  return !v || /^\$\(.*\)$/.test(v) ? null : v;
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
function correrScript(args, env) {
  return spawnSync('bash', [SCRIPT_TELEGRAM, ...args], { encoding: 'utf8', timeout: TIMEOUT_SCRIPT_MS, env });
}

/**
 * Manda (o edita) con el script y clasifica lo que pasó. Tres respuestas que el script da como fallo y no lo son del
 * todo se separan acá: «message is not modified» es el texto que ya estaba (entregado), un mensaje que ya no se puede
 * editar cae a uno nuevo (y lo anota), y un corte por tiempo no se reintenta (el paso no se cuelga). Sólo un rechazo
 * `ok:false` se reintenta.
 */
function telegram(texto, editarId, env) {
  let editando = editarId ? String(editarId) : null;
  let nota = null;
  let reintentos = 0;
  const falla = (motivo) => resultado('telegram', { motivo, nota });
  for (;;) {
    const r = correrScript([...(editando ? ['--edit', editando] : []), '--', texto], env);
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
      if (editando && /message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i.test(err)) {
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
function webhook(canal, texto, editarId, env) {
  const url = webhookDe(env);
  if (!url) return resultado(canal, { motivo: SIN_WEBHOOK });
  if (!webhookValido(url)) return resultado(canal, { motivo: WEBHOOK_INVALIDO });
  const ms = timeoutWebhook(env);
  const r = spawnSync(process.execPath, [__filename, '--__post'], {
    input: JSON.stringify(cuerpoDe(canal, texto)), encoding: 'utf8', timeout: ms + 10000,
    env: { PATH: env.PATH, TYCON_NOTIFY_WEBHOOK_URL: url, TYCON_NOTIFY_TIMEOUT_MS: String(ms) },
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
  const url = process.env.TYCON_NOTIFY_WEBHOOK_URL;
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

/** Manda por el canal. Sin canal (o uno desconocido), no manda nada: «canal sin configurar». */
function entregar({ canal, texto, editarId = null, env = process.env }) {
  if (!CANALES.includes(canal)) return resultado(canal || null, { motivo: SIN_CANAL });
  if (canal === 'telegram') return telegram(texto, editarId, env);
  return webhook(canal, texto, editarId, env);
}

/** El ensayo: qué mandaría, sin mandar. `{ codigo, salida, error }`. El chat y la dirección no se muestran. */
function ensayo({ canal, texto, editarId = null, env = process.env }) {
  if (!CANALES.includes(canal)) return { codigo: NO_ENTREGADO, salida: '', error: SIN_CANAL };
  if (canal === 'telegram') {
    const r = correrScript(['--dry-run', ...(editarId ? ['--edit', String(editarId)] : []), '--', texto], env);
    const tapar = (s) => limpiar(String(s || ''), env).replace(/chat_id=\S+/g, 'chat_id=<oculto>');
    const primera = tapar(r.stdout).split(' texto=')[0].trim();
    return { codigo: r.status === 0 ? 0 : NO_ENTREGADO, salida: primera, error: r.status === 0 ? '' : tapar(r.stderr) };
  }
  const url = webhookDe(env);
  if (!url) return { codigo: NO_ENTREGADO, salida: '', error: SIN_WEBHOOK };
  if (!webhookValido(url)) return { codigo: NO_ENTREGADO, salida: '', error: WEBHOOK_INVALIDO };
  return { codigo: 0, salida: `DRY-RUN ${canal}: webhook, ${texto.length} caracteres${editarId ? ' (mensaje nuevo: no edita)' : ''}`, error: '' };
}

/** El canal que declara un operations.json: `{ canal, motivo }`. Uno ilegible o con problemas no cae a ningún canal. */
function canalDe(archivo) {
  const OPS = require('./operations-config.js');
  const r = OPS.load(archivo);
  if (r.couldNotRead) return { canal: null, motivo: `no pude leer operations.json (${(r.problems[0] && r.problems[0].message.split(': ').pop()) || 'sin motivo'})` };
  if (!r.ok) return { canal: null, motivo: `operations.json tiene problemas: ${r.problems.map((p) => p.path || '(el archivo)').join(', ')}` };
  if (!r.data.notify) return { canal: null, motivo: `${SIN_CANAL} en operations.json → notify` };
  return { canal: r.data.notify.channel, motivo: null };
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────
function main(argv) {
  let canal = null; let ops = null; let editarId = null; let dryRun = false; let texto = null; let error = null;
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--') { texto = argv.slice(i + 1).join(' '); break; }
    if (v === '--channel') canal = argv[++i];
    else if (v === '--operations') ops = argv[++i];
    else if (v === '--edit') editarId = argv[++i];
    else if (v === '--dry-run') dryRun = true;
    else { error = `opción desconocida: ${v}`; break; }
  }
  if (error || !texto || (!canal && !ops) || (canal && ops) || (editarId !== null && !/^\d+$/.test(String(editarId)))) {
    if (error) process.stderr.write(`${error}\n`);
    process.stderr.write('uso: notify.js --operations <operations.json> | --channel telegram|slack|teams [--edit <id>] [--dry-run] -- "texto"\n');
    return 2;
  }
  if (ops) {
    const c = canalDe(ops);
    if (!c.canal) { process.stderr.write(`🔴 notify: no se mandó el aviso: ${c.motivo}\n`); return NO_ENTREGADO; }
    canal = c.canal;
  }
  if (dryRun) {
    const e = ensayo({ canal, texto, editarId });
    if (e.salida) process.stdout.write(`${e.salida} (ensayo: no se mandó nada)\n`);
    if (e.codigo !== 0) process.stderr.write(`🔴 notify: ${e.error}\n`);
    return e.codigo;
  }
  const r = entregar({ canal, texto, editarId });
  if (!r.entregado) { process.stderr.write(`🔴 notify: no se entregó por ${canal}: ${r.motivo}\n`); return NO_ENTREGADO; }
  if (r.message_id !== null) process.stdout.write(`${r.message_id}\n`);
  if (r.nota) process.stderr.write(`ℹ️ notify: ${r.nota}\n`);
  return 0;
}

module.exports = { CANALES, NO_ENTREGADO, SIN_CANAL, entregar, ensayo, canalDe, limpiar, cuerpoDe };

if (require.main === module) {
  if (process.argv[2] === '--__post') {
    postHijo().then(() => process.exit(0), () => { process.stdout.write('{"error":"red"}\n'); process.exit(0); });
  } else {
    process.exit(main(process.argv.slice(2)));
  }
}
