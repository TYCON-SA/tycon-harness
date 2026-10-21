'use strict';
// hook-event.js — lo que comparten los dos hooks de Solidtime (on-activity.js y on-prompt.js): leen la sesión que manda
// la herramienta del agente por la entrada estándar y le pasan el evento al núcleo (scripts/lib/work-signal.js), que lo
// manda a la integración elegida con sus ajustes.
// No le habla al agente: los avisos van a la salida de errores. Sale 0 siempre: un hook de horas nunca frena una sesión.
// Casos: scripts/tests/solidtime-integration.test.js (T49).

const path = require('path');

function run(event) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    try {
      let input = null;
      try { input = JSON.parse(raw); } catch (_) { input = null; }
      if (input && typeof input === 'object' && input.session_id) {
        const { emit } = require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'work-signal.js'));
        const r = emit(event, { sessionId: String(input.session_id), repo: typeof input.cwd === 'string' ? input.cwd : null });
        for (const w of r.warnings) process.stderr.write(`${w}\n`);
      }
    } catch (e) {
      process.stderr.write(`solidtime: el hook no pudo pasar el evento (${(e && e.code) || 'error inesperado'}); sigo sin registrar\n`);
    }
    process.exit(0);
  });
}

module.exports = { run };
