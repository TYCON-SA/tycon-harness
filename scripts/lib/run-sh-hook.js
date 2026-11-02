#!/usr/bin/env node
'use strict';
/**
 * run-sh-hook.js — lanza un gancho `.sh` con Git Bash, para el lado Codex en Windows.
 *
 *   node run-sh-hook.js [--gate] <gancho.sh>
 *
 * Por qué. Codex lanza cada gancho con `cmd.exe /C`, y `bash` no está en el camino de búsqueda: Git para Windows sólo
 * agrega `Git\cmd`. El gancho sale con 1 sin haber corrido, y Codex sigue con la herramienta: un freno así no frena, y no
 * hay ajuste de Codex que lo cambie. Por eso el que decide es este lanzador.
 *
 * Con `--gate` falla cerrado: sin Git Bash, o si el gancho termina con algo que no es 0, 1 ni 2, sale 2 con el motivo. El 1
 * se respeta: los frenos lo usan a propósito para «dejo pasar y aviso», y volverlo 2 pararía un `git commit` legítimo. Sin
 * `--gate`, sin Git Bash avisa y sale 0: un gancho que no frena no tiene por qué parar a nadie. La entrada y la salida
 * pasan sin tocarse, y el código de salida es el del gancho.
 */
const path = require('path');
const { spawnSync } = require('child_process');

const AVISA = 1;
const FRENA = 2;

/** Corre el gancho y devuelve el código de salida. `buscar` y `lanzar` se pasan sólo en las pruebas. */
function correr(argv, { env = process.env, buscar = (o) => require('./git-bash.js').findGitBash(o), lanzar = spawnSync, decir = (t) => process.stderr.write(`${t}\n`) } = {}) {
  const palabras = argv.slice();
  const gate = palabras[0] === '--gate';
  if (gate) palabras.shift();
  const gancho = palabras[0];
  const nombre = gancho ? path.basename(gancho) : '(sin gancho)';
  const no = (motivo) => {
    if (gate) { decir(`🛑 tycon: el freno ${nombre} no pudo correr: ${motivo}. Por seguridad, el comando no sigue. Instalá Git para Windows, o avisale a quien mantiene el arnés.`); return FRENA; }
    decir(`⚠️ tycon: el gancho ${nombre} no pudo correr: ${motivo}.`);
    return 0;
  };
  if (!gancho || palabras.length !== 1) return no('el lanzador espera un gancho y nada más');
  // adentro de la función: un error al cargarla saldría con 1, y Codex seguiría sin freno
  let bash;
  try { bash = buscar({ env }); } catch (e) { return no(`no pude buscar Git Bash (${e.message})`); }
  if (!bash || !bash.path) return no((bash && bash.reason) || 'no encontré Git Bash');
  const r = lanzar(bash.path, [gancho], { stdio: 'inherit', env, windowsHide: true });
  if (r.error) return no(`Git Bash no arrancó (${r.error.code || r.error.message})`);
  if (r.status === 0 || r.status === AVISA || r.status === FRENA) return r.status;
  if (gate) return no(`terminó con ${r.status === null ? `la señal ${r.signal}` : `el código ${r.status}`}, y un freno sólo termina con 0, 1 o 2`);
  return r.status === null ? 1 : r.status;
}

module.exports = { correr };

if (require.main === module) process.exitCode = correr(process.argv.slice(2));
