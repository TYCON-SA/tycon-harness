#!/usr/bin/env node
/**
 * large-read-notice.js — hook `UserPromptSubmit`: COBRA en este turno la lectura entera que
 * `large-read-meter.js` midió en el anterior.
 *
 * Mismo reparto de tareas que los otros dos medidores del arnés: el que mide no interrumpe, y el
 * que cobra no mide. Consume el pendiente → un aviso por infracción, nunca dos.
 *
 * El aviso es UNA línea y deja la decisión al agente: el medidor no sabe si le alcanzaba un pedazo.
 * Leer por rango a ciegas cuesta hallazgos (banco de 115 casos de revisores: 2 defectos perdidos
 * leyendo por rango, 0 leyendo normal), así que el aviso pide el rango sólo cuando alcanzaba, y la
 * lectura entera que hacía falta sigue igual, con su marca.
 *
 * Opt-out: TYCON_READ_METER=0 (apaga medidor y aviso a la vez).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const PENDING_DIR = path.join(os.homedir(), '.claude', 'lectura-grande', 'pending');

// 🔇 Sandbox de EVALS: las corridas del banco spawnean `claude -p` y cada hook UserPromptSubmit le
// inyecta su reminder AL PROMPT del agente simulado, que lo lee como parte de la conversación. Eso
// sesga la medición de los OTROS controles. El arnés setea TYCON_EVAL_SANDBOX=1 al
// spawnear; acá nos callamos.
if (process.env.TYCON_EVAL_SANDBOX === '1') process.exit(0);

/**
 * Sanea un nombre de archivo antes de meterlo en el aviso.
 *
 * 🔴 Por qué: el aviso se emite como un bloque `<system-reminder>` que entra DERECHO al contexto
 * del agente. El nombre viene de dos lados y sólo uno filtra: el canal de terminal ya rechaza
 * cualquier comando con `< > | & ; $ ( )` antes de extraer el archivo, pero el `file_path` de la
 * herramienta de lectura viaja tal cual. Un nombre que contenga el cierre del bloque lo cortaría e
 * inyectaría texto falso en el contexto — el agente lo leería como si se lo hubiera dicho el arnés.
 * Poco probable (hace falta que ya lo hayan inducido a leer ese path), pero es gratis cerrarlo.
 */
function saneado(nombre) {
  return String(nombre == null ? '' : nombre)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')   // caracteres de control
    .replace(/[<>]/g, '_')                     // no puede abrir ni cerrar una etiqueta
    .slice(0, 300);
}

function main() {
  const { readEnv } = require('../lib/legacy-names.js');
  if (readEnv('TYCON_READ_METER', { where: 'scripts/hooks/large-read-notice.js' }) === '0') return;

  let event = {};
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    event = stdin ? JSON.parse(stdin) : {};
  } catch { return; }

  const sessionId = event.session_id || event.sessionId || '_nosession';
  const file = path.join(PENDING_DIR, `${sessionId}.json`);
  if (!fs.existsSync(file)) return;

  let p;
  try { p = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { p = null; }
  // 🔴 NO se borra todavía. Borrar acá, antes de validar y de emitir, perdería el cobro sin traza: un
  // pendiente escrito a medias se parsea a null y se borraría igual. El borrado va DESPUÉS de escribir el aviso, al final de esta función.
  if (!p || !p.peor) return;

  const canal = p.peor.canal === 'read' ? 'la herramienta de lectura' : 'la terminal';
  const tope = p.umbral || 8000;

  process.stdout.write(`<system-reminder>
lecturas por rango: el turno anterior trajo entero ${saneado(p.peor.archivo)} (${p.peor.chars} caracteres, tope ${tope}, por ${canal}); si te alcanzaba un pedazo, la próxima pedí el rango o buscá, y si lo necesitabas entero, seguí igual con \`lectura-entera-ok: <razón>\` en el comando (aviso automático: no lo comentes en la respuesta).
</system-reminder>
`);

  // Recién ahora: el cobro ya salió, así que consumirlo es seguro. Un aviso por infracción.
  try { fs.unlinkSync(file); } catch { /* fail-open */ }
}

try { main(); } catch { /* fail-open */ }
process.exit(0);
