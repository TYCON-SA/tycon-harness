'use strict';
// connector.js — el conector de mentira: anota cada llamada (FAKE_PLATFORM_LOG) y contesta lo que diga
// FAKE_PLATFORM_ANSWERS (un JSON operación → resultado). Sin el token secreto contesta sin_credencial, como un conector
// real; con FAKE_PLATFORM_THROW=<operación>, esa operación tira, para probar que la capa no deja pasar una excepción.

const fs = require('fs');

function correr(operacion, args, ctx) {
  const env = ctx.env || process.env;
  if (env.FAKE_PLATFORM_LOG) fs.appendFileSync(env.FAKE_PLATFORM_LOG, `${JSON.stringify({ operacion, args })}\n`);
  if (env.FAKE_PLATFORM_THROW === operacion) throw new Error('falla de mentira');
  if (!ctx.secretState('fake-platform.token').present) {
    return { ok: false, reason: 'sin_credencial', detail: 'falta el token de la plataforma de mentira: harness.js config set fake-platform.token <token>' };
  }
  const respuestas = env.FAKE_PLATFORM_ANSWERS ? JSON.parse(env.FAKE_PLATFORM_ANSWERS) : {};
  return Object.prototype.hasOwnProperty.call(respuestas, operacion) ? respuestas[operacion] : { ok: true, value: { operacion } };
}

module.exports = { run: correr };
