'use strict';
/*
 * messages.js — la ruta `POST /mensaje` del proceso de la oficina: la persona le escribe a una sesión desde la ventana de esa
 * sesión, y el proceso deja el mensaje en su buzón (scripts/lib/office-messages.js) y sigue en qué va.
 *
 * Quién puede mandar: además del token y del `Host` local que el proceso ya mira en todo pedido, esta ruta pide `Origin` igual
 * a la dirección de la oficina, `Sec-Fetch-Site: same-origin` y `Content-Type: application/json` (403 o 415 sin escribir
 * nada). Así otra página abierta en el mismo navegador no llega: no tiene el token, no puede poner esas cabeceras y no recibe
 * ninguna cabecera que le dé permiso. Un agente de la misma cuenta sí puede leer el token e imitar las cabeceras: por eso un
 * mensaje de la oficina nunca firma (el límite de owner-approvals.js).
 *
 * A quién: el nombre es una clave de las personas de la última foto, nunca una ruta (404 si no está). A una sesión de Codex
 * no se le escribe (409): no hay una vía medida. Sin vigilante vivo tampoco (409), salvo que el último acabe de entregar y la
 * sesión no haya cerrado ese turno: entonces espera hasta 30 min. Con el vigilante vivo, 10 s.
 *
 * En qué va: mientras haya mensajes en curso, cada segundo mira el buzón: tomado es «recibido», vencido es «no-entregado». Uno
 * recibido que a los 5 min de sesión quieta no aparece en su conversación es «no-aparece»; con un cuadro abierto o la sesión
 * trabajando, ese reloj no corre. Cada cambio sale a la página por el WebSocket (`{type: 'mensaje', id, s, estado, motivo}`),
 * que sigue siendo de ida. Nada de esto entra en la foto ni sale al sitio.
 *
 * Todo intento que pasó los controles de acceso queda en el registro, también los rechazados.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const om = require(path.join(ROOT, 'scripts', 'lib', 'office-messages.js'));

const MAX_BODY = 64 * 1024;
const numEnv = (name, dflt) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : dflt; };

// lo que dice la ventana; el mismo texto en la respuesta y en el aviso por el WebSocket
const SAYS = {
  apagado: 'Los mensajes de la oficina están apagados en esta máquina (TYCON_OFFICE_MESSAGES=0).',
  codex: 'Esta sesión es de Codex: desde acá no se le puede escribir.',
  'sin-vigilante': 'Esta sesión no puede recibir mensajes de la oficina. Escribile una vez en su pestaña y vuelve a poder.',
  aprobacion: 'Esto no aprueba nada: para aprobar, contestá el cuadro.',
  'espera-cierre': 'Lo va a recibir cuando termine lo que está haciendo.',
};

// ¿el mensaje entró en la conversación? Se busca del final hacia atrás, de a 2 MB y con la memoria de un trozo: el trabajo
// que el mensaje arrancó puede haber dejado mucho después. null si no se pudo leer
function appearsIn(file, id, { chunkBytes = 2 * 1024 * 1024 } = {}) {
  const needle = Buffer.from(`[oficina ${id}]`);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    let end = fs.fstatSync(fd).size;
    while (end > 0) {
      const start = Math.max(0, end - chunkBytes);
      // el trozo se solapa con el siguiente lo justo para no partir la marca en dos
      const len = Math.min(end - start + needle.length - 1, fs.fstatSync(fd).size - start);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      if (buf.includes(needle)) return true;
      end = start;
    }
    return false;
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function officeMessages({ sdir, envelopes, okOrigin, notify, clock = Date.now, log = () => {} }) {
  const off = () => process.env.TYCON_OFFICE_MESSAGES === '0';
  const deadlineMs = () => numEnv('TYCON_OFFICE_MESSAGE_DEADLINE_MS', om.DEADLINE_MS);
  const longMs = () => numEnv('TYCON_OFFICE_MESSAGE_LONG_MS', 30 * 60 * 1000);
  const appearMs = () => numEnv('TYCON_OFFICE_MESSAGE_APPEAR_MS', 5 * 60 * 1000);
  // los mensajes en curso de este proceso: id → { s, sid, estado, at, deadline, quietFrom }
  const tracked = new Map();
  let timer = null;

  const say = (m) => { try { notify(m); } catch { /* una página que se fue no frena el resto */ } };
  // la persona de la última foto, con el vigilante mirado ahora: su candado cambia sin que cambie la foto
  const recipient = (name) => {
    const r = (envelopes.recipients instanceof Map ? envelopes.recipients.get(name) : null) || null;
    if (!r || !r.sid || r.recibe === 'codex' || r.recibe === 'apagado') return r;
    let w;
    try { w = om.watcherState(sdir, r.sid); } catch { w = { alive: false }; }
    return { ...r, recibe: w.alive ? 'si' : (Number.isFinite(w.deliveredAt) ? 'espera-cierre' : 'sin-vigilante') };
  };

  // un mensaje cuyo seguimiento falla (el registro o el buzón no se pueden escribir) se deja de seguir y se dice: el reloj
  // sigue con los demás y el proceso no se cae
  const tick = () => {
    timer = null;
    for (const [id, t] of tracked) {
      try { follow(id, t); } catch (e) {
        log(`oficina: no pude seguir el mensaje ${id} (${e.code || e.message})`);
        say({ id, s: t.s, estado: 'no-entregado', motivo: 'No se pudo seguir el mensaje.' });
        tracked.delete(id);
      }
    }
    if (tracked.size) { timer = setTimeout(tick, numEnv('TYCON_OFFICE_MESSAGE_POLL_MS', 1000)); timer.unref(); }
  };
  function follow(id, t) {
    const now = clock();
    if (t.estado === 'mandado') {
      const inbox = path.join(om.paths(sdir).inbox(t.sid), `${id}.json`);
      if (fs.existsSync(inbox)) {
        if (now - t.at > t.deadline && om.expire(sdir, t.sid, id, { now, motivo: 'vencido' })) {
          t.estado = 'no-entregado';
          say({ id, s: t.s, estado: 'no-entregado', motivo: 'No le llegó.' });
          tracked.delete(id);
        }
        return;
      }
      if (fs.existsSync(path.join(om.paths(sdir).taken(t.sid), `${id}.json`))) {
        t.estado = 'recibido';
        t.quietFrom = now;
        say({ id, s: t.s, estado: 'recibido' });
      } else {
        say({ id, s: t.s, estado: 'no-entregado', motivo: 'No le llegó.' });
        tracked.delete(id);
      }
      return;
    }
    // recibido: el reloj de «no aparece» corre sólo con la sesión quieta
    const r = recipient(t.s);
    if (r && (r.ocupada || r.cuadro)) { t.quietFrom = now; return; }
    if (now - t.quietFrom < appearMs()) return;
    const e = envelopes.files.get(t.s);
    const seen = e ? appearsIn(e.file, id) : null;
    if (seen === false) say({ id, s: t.s, estado: 'no-aparece', motivo: 'Se le entregó y no aparece en su conversación.' });
    if (seen === null) log(`oficina: no pude leer la conversación de ${t.s} para ver si el mensaje ${id} apareció`);
    tracked.delete(id);
  }
  const watchSoon = () => { if (!timer) { timer = setTimeout(tick, numEnv('TYCON_OFFICE_MESSAGE_POLL_MS', 1000)); timer.unref(); } };

  const reject = (res, code, body, { name, sid = '', text = null, why } = {}) => {
    if (why) { try { om.record(sdir, { id: om.newId(), sid: sid || '-', text, estado: 'rechazado', motivo: why, at: clock() }); } catch { /* sin registro, la respuesta igual */ } }
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ s: name || null, ...body }));
  };

  function onPost(req, res) {
    const bare = (code) => { req.resume(); res.writeHead(code, { 'cache-control': 'no-store' }); res.end(); };
    if (req.method !== 'POST') { bare(405); return; }
    if (!okOrigin(req.headers.origin) || req.headers['sec-fetch-site'] !== 'same-origin') { bare(403); return; }
    if (!/^application\/json(\s*;|$)/i.test(String(req.headers['content-type'] || ''))) { bare(415); return; }
    const chunks = [];
    let size = 0;
    req.on('data', (d) => { size += d.length; if (size <= MAX_BODY) chunks.push(d); });
    req.on('error', () => { /* quien mandó cortó */ });
    req.on('end', () => {
      if (size > MAX_BODY) { reject(res, 413, { motivo: 'El mensaje es demasiado largo.' }, { why: 'pedido de más de 64 KB' }); return; }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
      if (!body || typeof body !== 'object' || typeof body.s !== 'string' || typeof body.texto !== 'string') { reject(res, 400, { motivo: 'El pedido no se entiende.' }, { why: 'pedido mal formado' }); return; }
      const name = body.s;
      const text = body.texto;
      if (off()) { reject(res, 409, { recibe: 'apagado', motivo: SAYS.apagado }, { name, text, why: 'apagado' }); return; }
      const r = recipient(name);
      if (!r) { reject(res, 404, { motivo: 'Esa sesión no está en la oficina.' }, { name, text, why: 'sesión que no está en la oficina' }); return; }
      if (r.recibe === 'codex') { reject(res, 409, { recibe: 'codex', motivo: SAYS.codex }, { name, text, why: 'sesión de Codex' }); return; }
      const bad = om.checkText(text);
      if (bad) { reject(res, 400, { motivo: bad }, { name, sid: r.sid, text, why: bad }); return; }
      if (r.recibe !== 'si' && r.recibe !== 'espera-cierre') { reject(res, 409, { recibe: r.recibe, motivo: SAYS[r.recibe] || SAYS['sin-vigilante'] }, { name, sid: r.sid, text, why: 'sin vigilante vivo' }); return; }
      const approval = om.looksLikeApproval(text);
      if (approval && body.igual !== true) { reject(res, 409, { parece: 'aprobacion', motivo: SAYS.aprobacion }, { name, sid: r.sid, text, why: 'parece una aprobación: se avisó antes de mandar' }); return; }
      const deadline = r.recibe === 'espera-cierre' ? longMs() : deadlineMs();
      let left;
      try { left = om.leave(sdir, { sid: r.sid, text, now: clock(), deadlineMs: deadline, approval }); } catch (e) {
        reject(res, 500, { motivo: 'No se pudo mandar.' }, { name, sid: r.sid, text, why: `no se pudo guardar (${e.code || 'error'})` });
        return;
      }
      if (!left.ok) { reject(res, 409, { esperando: left.waiting || null, motivo: left.motivo }, { name, sid: r.sid, text, why: left.motivo }); return; }
      tracked.set(left.id, { s: name, sid: r.sid, estado: 'mandado', at: clock(), deadline, quietFrom: null });
      watchSoon();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ id: left.id, s: name, estado: 'mandado', ...(r.recibe === 'espera-cierre' ? { motivo: SAYS['espera-cierre'] } : {}), ...(r.cuadro ? { cuadro: true } : {}) }));
    });
  }

  /** Lo que la ventana de una sesión necesita para ofrecer escribirle, y sus mensajes en curso. */
  function stateOf(name) {
    const r = recipient(name);
    const enCurso = [...tracked].filter(([, t]) => t.s === name).map(([id, t]) => ({ id, estado: t.estado }));
    if (!r) return { recibe: null, motivo: null, enCurso };
    return { recibe: r.recibe, motivo: SAYS[r.recibe] || null, cuadro: Boolean(r.cuadro), ocupada: Boolean(r.ocupada), enCurso };
  }

  /** Al arrancar: lo que quedó vencido en el buzón no se entrega. */
  const sweep = () => {
    try { return om.sweep(sdir, { now: clock() }); } catch (e) { log(`oficina: no pude barrer el buzón al arrancar (${e.code || e.message})`); return []; }
  };
  const stop = () => { clearTimeout(timer); timer = null; };

  return { onPost, stateOf, sweep, stop, SAYS };
}

module.exports = { officeMessages, appearsIn, SAYS };
