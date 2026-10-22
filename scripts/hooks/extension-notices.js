#!/usr/bin/env node
'use strict';
// extension-notices.js — SessionStart: dice los avisos de arranque de las extensiones activas que aplican en el repo de
// la sesión (los `notices.json` de los paquetes; scripts/lib/extension-notices.js decide cuáles). Así una regla que sólo
// sirve en ciertos repos viaja ahí y no en las instrucciones de todas las sesiones.
//
// Cada aviso sale una vez por sesión, y otra vez después de compactar o limpiar la conversación. Un `notices.json` roto, o no poder saber qué está activo, se dice en una línea y
// no frena: el arranque sigue con los avisos que sí se pudieron leer. Sale 0 siempre.
// Off: TYCON_EXTENSION_NOTICES=0.
const fs = require('fs');
const os = require('os');
const path = require('path');

// La carpeta del estado la sabe scripts/setup/harness/tycon-home.js, si está al lado (el banco copia este hook suelto).
// Se resuelve adentro de main(): si el módulo fallara al cargar, el gancho igual sale 0 y lo dice.
function stateDirOf(home) {
  const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js');
  return fs.existsSync(lib) ? require(lib).stateDir(home) : path.join(home || os.homedir(), '.claude', '.tycon-pipeline');
}

/** El evento que manda la herramienta. Uno que llega y no se lee se dice: sin él, la carpeta y el momento son supuestos. */
function readStdin() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { return { input: {}, problem: null }; }
  if (!raw.trim()) return { input: {}, problem: null };
  try { return { input: JSON.parse(raw), problem: null }; } catch (e) {
    return { input: {}, problem: `el evento de arranque no se pudo leer (${e.message}); se usó la carpeta actual` };
  }
}

function main() {
  if (process.env.TYCON_EXTENSION_NOTICES === '0') return;
  const { input, problem } = readStdin();
  const cwd = input.cwd || process.cwd();
  const sid = String(input.session_id || '_nosession').replace(/[/\\]/g, '_');
  const { applicable } = require(path.join(__dirname, '..', 'lib', 'extension-notices.js'));
  const { notices, errors } = applicable({ cwd, when: 'session-start' });
  if (problem) errors.unshift(problem);

  const stateFile = path.join(stateDirOf(os.homedir()), 'extension-notices', `${sid}.json`);
  let shown = [];
  // después de compactar o de limpiar la conversación (mismo session_id, `source` compact o clear) lo dicho antes ya no
  // está en el contexto: se vuelve a decir, como se recargaba el CLAUDE.md
  const contextoNuevo = input.source === 'compact' || input.source === 'clear';
  if (!contextoNuevo) {
    try { shown = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (!Array.isArray(shown)) shown = []; } catch (_) { shown = []; }
  }

  const out = [];
  const nuevos = [];
  for (const n of notices) {
    const key = `${n.extension}/${n.id}`;
    if (shown.includes(key)) continue;
    let text;
    try { text = fs.readFileSync(n.file, 'utf8').replace(/^﻿/, '').trim(); } catch (e) { errors.push(`el aviso ${key} no se pudo leer (${e.code || e.message})`); continue; }
    if (!text) { errors.push(`el aviso ${key} está vacío`); continue; }
    out.push(text);
    nuevos.push(key);
  }
  for (const e of errors) out.push(`⚠️ avisos de extensiones: ${e}`);
  if (out.length) process.stdout.write(out.join('\n\n') + '\n');
  if (nuevos.length) {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(shown.concat(nuevos)));
    } catch (_) { /* sin estado, el aviso puede repetirse en la sesión: mejor que no decirlo */ }
  }
}

try { main(); } catch (e) {
  process.stdout.write(`⚠️ avisos de extensiones: el gancho falló (${(e && e.message) || e}); el arranque sigue\n`);
}
process.exit(0);
