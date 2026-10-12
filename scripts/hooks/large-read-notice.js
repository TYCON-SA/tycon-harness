#!/usr/bin/env node
/**
 * large-read-notice.js — hook `UserPromptSubmit`: COBRA en este turno la lectura entera que
 * `large-read-meter.js` midió en el anterior.
 *
 * Mismo reparto de tareas que los otros dos medidores del arnés: el que mide no interrumpe, y el
 * que cobra no mide. Consume el pendiente → un aviso por infracción, nunca dos.
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
// sesga la medición de los OTROS controles (Story 3.40). El arnés setea TYCON_EVAL_SANDBOX=1 al
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
  // 🔴 NO se borra todavía. La primera versión borraba acá, antes de validar y de emitir: un
  // pendiente escrito a medias se parseaba a null, se borraba igual, y el cobro se perdía sin
  // traza. El borrado va DESPUÉS de escribir el aviso, al final de esta función.
  if (!p || !p.peor) return;

  const canal = p.peor.canal === 'read'
    ? 'la herramienta de lectura, sin pedirle un rango'
    : 'un comando de terminal que trajo el archivo entero';

  const acotadas = p.acotadas > 0
    ? `En el mismo turno hiciste ${p.acotadas} lectura(s) acotada(s): ésa es la forma, aplicala también acá.\n`
    : '';

  process.stdout.write(`<system-reminder>
lecturas por rango — el turno anterior se trajo ${p.peor.chars} caracteres de un solo archivo (tope ${p.umbral}).

  archivo: ${saneado(p.peor.archivo)}
  canal:   ${canal}

${acotadas}
La regla, en criollo: leer POR RANGO o POR BÚSQUEDA, no el archivo entero. Antes de traerte un archivo:
1. Si buscás un símbolo o una definición, usá el índice de código o una búsqueda — no lo abras entero.
2. Si ya sabés qué parte necesitás, pedí ese rango (las primeras N líneas, un rango de líneas, las líneas alrededor de una coincidencia).
3. Si de verdad necesitás el archivo completo —es chico, o el dev pidió verlo entero— escribí \`lectura-entera-ok: <razón>\` en el propio comando: queda la razón donde se lee después, y no se cobra.

Esto es una medición automática, no un reto del user — no lo comentes en la respuesta salvo que él lo saque. Simplemente pedí el rango.
</system-reminder>
`);

  // Recién ahora: el cobro ya salió, así que consumirlo es seguro. Un aviso por infracción.
  try { fs.unlinkSync(file); } catch { /* fail-open */ }
}

try { main(); } catch { /* fail-open */ }
process.exit(0);
