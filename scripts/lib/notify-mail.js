'use strict';
/**
 * notify-mail.js — el cliente de correo del canal `mail` de scripts/lib/notify.js, sin dependencias.
 *
 * Habla SMTP con el servidor que declara el perfil (`integrations.notify.mail_host` y `mail_port`): TLS directo en el
 * 465; en cualquier otro puerto, en claro hasta que el servidor ofrece STARTTLS y ahí pasa a TLS. Se autentica con AUTH
 * PLAIN (o LOGIN, si es lo único que ofrece) y manda un texto plano en UTF-8, con el asunto codificado.
 *
 * 🔴 LA CLAVE NO VIAJA EN CLARO. Sin TLS la autenticación sólo se hace contra la propia máquina (las pruebas): un servidor
 * de afuera que no ofrece STARTTLS es un fallo, no un envío sin cifrar. Lo que devuelve es de un vocabulario cerrado
 * (`{ ok }` o `{ error, codigo }`): nunca el usuario, la clave, ni lo que contestó el servidor, que puede repetirlos.
 *
 * Lo usa notify.js desde un proceso hijo (`notify.js --__mail`), con los datos por la entrada estándar.
 */
const net = require('net');
const tls = require('tls');

const LOCAL = new Set(['127.0.0.1', 'localhost', '::1']);
// los códigos de un servidor que no se alcanza (no de un apretón TLS que falla)
const REDES = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET'];

/** Si se puede autenticar: con TLS siempre; sin TLS, sólo contra la propia máquina. */
function correoSeguro({ host, conTls }) { return Boolean(conTls) || LOCAL.has(String(host || '').trim().toLowerCase()); }

/** Un encabezado en UTF-8 (RFC 2047), sin saltos de línea. */
function encabezado(texto) { return `=?UTF-8?B?${Buffer.from(String(texto).replace(/[\r\n]+/g, ' '), 'utf8').toString('base64')}?=`; }

/** El cuerpo del mensaje: encabezados y el texto en base64 (los acentos llegan enteros y ninguna línea empieza con «.»). */
function mensaje({ de, para, asunto, texto, fecha = new Date() }) {
  const b64 = Buffer.from(String(texto), 'utf8').toString('base64').replace(/.{1,76}/g, (l) => `${l}\r\n`);
  return [`From: ${de}`, `To: ${para.join(', ')}`, `Subject: ${encabezado(asunto)}`, `Date: ${fecha.toUTCString()}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64].join('\r\n');
}

/**
 * Manda un correo: `{ host, puerto, usuario, clave, de, para: [..], asunto, texto, ms, tlsDirecto? }` → `{ ok: true }` o
 * `{ error, codigo }`. `tlsDirecto`: TLS desde el primer byte (por defecto, sólo en el 465).
 * `error`: `tiempo` · `red` (no se alcanza el servidor) · `tls` (el servidor no ofrece TLS y no es la propia máquina, o
 * el apretón falla) · `auth` · `rechazo` (otro código). Un corte después de que el servidor aceptó el mensaje es `ok`.
 */
function enviar(o) {
  return new Promise((resolve) => {
    let sock = net.connect({ host: o.host, port: o.puerto });
    let conTls = false;
    let terminado = false;
    let entregado = false;   // el servidor ya aceptó el mensaje: lo que pase con la despedida no lo cambia
    let buf = '';
    let esperando = null;
    const fin = (r) => { if (terminado) return; terminado = true; clearTimeout(reloj); try { sock.destroy(); } catch (_) { /* ya cerrado */ } resolve(r); };
    const corte = () => fin(entregado ? { ok: true } : { error: 'red' });
    // un corte por tiempo después de que el servidor aceptó el mensaje (esperando la despedida) no es un fallo
    const reloj = setTimeout(() => fin(entregado ? { ok: true } : { error: 'tiempo' }), o.ms || 15000);
    const escuchar = (s) => {
      s.on('data', (d) => {
        buf += d.toString('utf8');
        // una respuesta termina en la línea «NNN texto» o «NNN» sola (RFC 5321: el texto es opcional); las
        // intermedias son «NNN-texto»
        const m = /(^|\r\n)(\d{3})(?: [^\r\n]*)?\r\n$/.exec(buf);
        if (!m || !esperando) return;
        const lineas = buf; buf = '';
        const e = esperando; esperando = null;
        e({ codigo: Number(m[2]), texto: lineas });
      });
      s.on('error', corte);
      s.on('close', corte);
    };
    const pedir = (linea) => new Promise((r) => { esperando = r; if (linea !== null) sock.write(`${linea}\r\n`); });
    const pasoATls = () => new Promise((r) => {
      sock.removeAllListeners('data'); sock.removeAllListeners('close'); sock.removeAllListeners('error');
      let cifrado = false;
      const t = tls.connect({ socket: sock, servername: o.host }, () => { cifrado = true; r(); });
      // sin conexión (rechazada, sin nombre, sin ruta) es «no se pudo conectar»; lo demás antes del apretón, TLS
      t.on('error', (e) => { if (cifrado || REDES.includes(e && e.code)) corte(); else fin({ error: 'tls' }); });
      sock = t; conTls = true; escuchar(t);
    });
    const espera = (r, ...codigos) => {
      if (codigos.includes(r.codigo)) return true;
      fin({ error: 'rechazo', codigo: r.codigo });
      return false;
    };
    (async () => {
      // TLS directo en el 465 (o si quien llama lo pide); en los demás, en claro hasta el STARTTLS
      if (o.tlsDirecto !== undefined ? o.tlsDirecto : o.puerto === 465) await pasoATls(); else escuchar(sock);
      if (!espera(await pedir(null), 220)) return;
      let r = await pedir('EHLO tycon-harness');
      if (!espera(r, 250)) return;
      if (!conTls && /STARTTLS/i.test(r.texto)) {
        if (!espera(await pedir('STARTTLS'), 220)) return;
        await pasoATls();
        r = await pedir('EHLO tycon-harness');
        if (!espera(r, 250)) return;
      }
      if (!correoSeguro({ host: o.host, conTls })) { fin({ error: 'tls' }); return; }
      if (/AUTH[ =][^\r\n]*PLAIN/i.test(r.texto) || !/AUTH[ =][^\r\n]*LOGIN/i.test(r.texto)) {
        const a = await pedir(`AUTH PLAIN ${Buffer.from(`\u0000${o.usuario}\u0000${o.clave}`, 'utf8').toString('base64')}`);
        if (a.codigo !== 235) { fin({ error: a.codigo === 535 || a.codigo === 534 ? 'auth' : 'rechazo', codigo: a.codigo }); return; }
      } else {
        if (!espera(await pedir('AUTH LOGIN'), 334)) return;
        if (!espera(await pedir(Buffer.from(o.usuario, 'utf8').toString('base64')), 334)) return;
        const a = await pedir(Buffer.from(o.clave, 'utf8').toString('base64'));
        if (a.codigo !== 235) { fin({ error: a.codigo === 535 || a.codigo === 534 ? 'auth' : 'rechazo', codigo: a.codigo }); return; }
      }
      if (!espera(await pedir(`MAIL FROM:<${o.de}>`), 250)) return;
      for (const p of o.para) if (!espera(await pedir(`RCPT TO:<${p}>`), 250, 251)) return;
      if (!espera(await pedir('DATA'), 354)) return;
      if (!espera(await pedir(`${mensaje(o)}\r\n.`), 250)) return;
      entregado = true;
      await pedir('QUIT');
      fin({ ok: true });
    })().catch(() => fin({ error: 'red' }));
  });
}

module.exports = { enviar, mensaje, encabezado, correoSeguro };
