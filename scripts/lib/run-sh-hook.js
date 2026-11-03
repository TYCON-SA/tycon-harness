#!/usr/bin/env node
'use strict';
/**
 * run-sh-hook.js — lanza un gancho del arnés para el lado Codex en Windows: un `.sh` con Git Bash y un `.js` con este Node.
 *
 *   node run-sh-hook.js [--gate] <gancho>
 *
 * Por qué. Codex lanza cada gancho con la consola de la sesión, y sigue con la herramienta si el gancho falla. Eso rompe
 * un freno de dos formas: `bash` no está en el camino de búsqueda (Git para Windows sólo agrega `Git\cmd`), y PowerShell
 * cambia por 1 cualquier error de un programa, así que el 2 de un freno nunca llega. No hay ajuste de Codex que lo cambie.
 *
 * Con `--gate`, un freno niega con la respuesta que Codex documenta, en la salida estándar y saliendo con 0: no depende de
 * la consola. Niega si el gancho terminó con 2, y también si no pudo correr: sin el archivo, sin Git Bash, o si terminó con
 * algo que no es 0, 1 ni 2. El 1 se respeta: los frenos lo usan a propósito para «dejo pasar y aviso», y negarlo pararía un `git commit`
 * legítimo. Sin `--gate`, sin Git Bash avisa y sale 0: un gancho que no frena no tiene por qué parar a nadie.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const AVISA = 1;
const FRENA = 2;
const SIN_TOPE = 64 * 1024 * 1024;

/** Corre el gancho y devuelve el código de salida. `existe`, `buscar`, `lanzar`, `decir` y `emitir` se pasan sólo en las pruebas. */
function correr(argv, {
  env = process.env,
  existe = fs.existsSync,
  buscar = (o) => require('./git-bash.js').findGitBash(o),
  lanzar = spawnSync,
  decir = (t) => process.stderr.write(t),
  emitir = (t) => process.stdout.write(t),
} = {}) {
  const palabras = argv.slice();
  const gate = palabras[0] === '--gate';
  if (gate) palabras.shift();
  const gancho = palabras[0];
  const nombre = gancho ? path.basename(gancho) : '(sin gancho)';
  const negar = (motivo) => {
    emitir(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: motivo } })}\n`);
    return 0;
  };
  const no = (motivo) => {
    if (gate) return negar(`🛑 tycon: el freno ${nombre} no pudo correr: ${motivo}. Por seguridad, el comando no sigue. Instalá Git para Windows, o avisale a quien mantiene el arnés.`);
    decir(`⚠️ tycon: el gancho ${nombre} no pudo correr: ${motivo}.\n`);
    return 0;
  };
  if (!gancho || palabras.length !== 1) return no('el lanzador espera un gancho y nada más');
  let programa = process.execPath;
  if (!/\.js$/i.test(gancho)) {
    // adentro de la función: un error al cargarla saldría con 1, y Codex seguiría sin freno
    let bash;
    try { bash = buscar({ env }); } catch (e) { return no(`no pude buscar Git Bash (${e.message})`); }
    if (!bash || !bash.path) return no((bash && bash.reason) || 'no encontré Git Bash');
    programa = bash.path;
  }
  // sin el archivo, Node saldría con 1, y eso se lee como «dejo pasar y aviso»
  if (!existe(gancho)) return no('el archivo no está');
  const r = lanzar(programa, [gancho], gate
    ? { stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: SIN_TOPE, env, windowsHide: true }
    : { stdio: 'inherit', env, windowsHide: true });
  if (r.error) return no(`no arrancó (${r.error.code || r.error.message})`);
  if (!gate) return r.status === null ? 1 : r.status;
  const errores = String(r.stderr || '');
  if (r.status === FRENA) return negar(errores.trim() || `🛑 tycon: el freno ${nombre} frenó este comando, sin decir el motivo.`);
  if (r.status !== 0 && r.status !== AVISA) return no(`terminó con ${r.status === null ? `la señal ${r.signal}` : `el código ${r.status}`}, y un freno sólo termina con 0, 1 o 2`);
  if (r.stdout) emitir(String(r.stdout));
  if (errores) decir(errores);
  return r.status;
}

module.exports = { correr };

if (require.main === module) process.exitCode = correr(process.argv.slice(2));
