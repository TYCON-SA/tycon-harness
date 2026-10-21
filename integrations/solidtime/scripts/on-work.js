#!/usr/bin/env node
'use strict';
// on-work.js — escucha el evento de trabajo del núcleo (scripts/lib/work-signal.js) y se lo pasa a solidtime.js.
// El evento llega por la entrada estándar; el resultado sale por la salida (`{"seconds":N}` o `{}`) y cada aviso en una
// línea por la salida de errores. Sale 0 siempre: la historia sigue aunque la herramienta falle.
// `TYCON_SOLIDTIME_TIMEOUT_MS` acorta el tope de cada pedido (las pruebas); sin ella, 10 s.

const { handle, DEFAULT_TIMEOUT_MS } = require('./solidtime.js');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', async () => {
  let ev = null;
  try { ev = JSON.parse(raw); } catch (_) { ev = null; }
  const t = Number(process.env.TYCON_SOLIDTIME_TIMEOUT_MS);
  let r;
  try { r = await handle(ev, { timeoutMs: Number.isInteger(t) && t > 0 ? t : DEFAULT_TIMEOUT_MS }); } catch (e) {
    r = { result: {}, warnings: [`solidtime: falló sin poder atender el evento (${(e && e.code) || 'error inesperado'}); sigo sin registrar`] };
  }
  for (const w of r.warnings) process.stderr.write(`${w}\n`);
  process.stdout.write(`${JSON.stringify(r.result)}\n`);
  process.exit(0);
});
