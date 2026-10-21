'use strict';
/**
 * scripts/lib/git-target.js —¿a qué REPO apunta cada comando `git` de una línea de shell?
 *
 * ── POR QUÉ EXISTE ──────────────────────────────────────────────────────────────────────────────
 * Un hook recibe el comando como TEXTO y el cwd de la SESIÓN. Los dos no son lo mismo: el comando
 * puede empezar con `cd /otro/repo && …`, o el git puede traer su propio `-C /otro/repo`. Decidir
 * con el cwd de la sesión es decidir sobre el repo equivocado, y como git no falla, no hay error:
 * hay un dato falso.
 *
 * El criterio lo comparten `session-collision-guard.js` y `retro-pending.js`. Sin él, una sesión que trabaja en un
 * clon descartable justamente para no tocar el checkout compartido se frena igual, y un destino irresoluble
 * (`git -C "$VAR" commit`) pasa sin mirar.
 *
 * 🔴 Sin el criterio, un `cd ~/.claude/agent-skills && git push origin main` queda registrado contra un repo del
 * equipo, con la sha del `origin/main` STALE de ese otro checkout. Peor: como el repo se calcula mal, la exclusión que
 * el propio hook tiene para los repos del arnés nunca se activa, y queda un pendiente que NINGUNA retrospectiva puede
 * cerrar. Quien necesite resolver "a qué repo apunta este git" lo pide a este archivo; no escribe otro regex.
 *
 * ── QUÉ NO RESUELVE, A PROPÓSITO ────────────────────────────────────────────────────────────────
 * Sustitución de comandos (`$(…)`), heredocs, `sh -c "…"`, y variables que el comando NO define.
 * En todos esos casos el destino sale `resuelto: false` — que es un dato, no un silencio: cada
 * consumidor decide qué hacer con "no sé" (el freno de sesiones falla hacia el checkout que
 * protege; el registro de retrospectivas se niega a anotar una atribución que no puede probar).
 */

const os = require('os');
const path = require('path');

/** Operadores que separan sentencias. Sin conciencia de comillas: ver "qué no resuelve". */
const SEPARADOR = /\s*(?:&&|\|\||;|\||\n)\s*/;
// 🔴 `expandir`, `variablesDelComando` y la marca de "no lo pude resolver" NO se definen acá: son
// las de `shell-parse.js`. Dos copias del mismo criterio divergen solas. Una definición,
// tres consumidores (el freno de sesiones, el registro de retrospectivas y el freno de producción).
const { expandir, variablesDelComando, SIN_RESOLVER } = require(path.join(__dirname, 'shell-parse.js'));

/**
 * Envoltorios que dejan a un `git` siendo un `git`: `time git push`, `sudo git commit`,
 * `/usr/bin/git push`, el `if git push …; then` de un script, el `do …` de un `for`.
 * El análisis por sentencia exige que la sentencia EMPIECE con `git` (o con `VAR=x git`), así que
 * sin esto un git envuelto es INVISIBLE — y eso no es "otro repo", es "no lo vi": el consumidor que
 * se niega a concluir termina avisando "no pude resolver" cuando no había nada que resolver
 * (`time git push origin main`, sin `cd` y sin `-C`, dejaría de registrarse). Se pide con `{ envoltorios: true }` y NO viene puesto: el freno de sesiones
 * nunca se midió con esta tolerancia, y ampliar lo que FRENA no es lo mismo que ampliar lo que
 * REGISTRA. El día que se le prenda, va con sus casos.
 */
const ENVOLTORIO = /^(?:[!({]\s*|(?:if|then|elif|else|do|while|until|time|sudo|command|exec|eval|nice|nohup|env)\s+|\w+=(?:"[^"]*"|'[^']*'|[^\s;&|)]*)\s+)+/;
function sinEnvoltorio(st) {
  return String(st).replace(/^\s+/, '').replace(ENVOLTORIO, '').replace(/^\S*\/git(?=\s|$)/, 'git');
}

/** Los verbos de git que ESCRIBEN en el árbol o la historia (los que vigila el freno de sesiones). */
const VERBOS_QUE_ESCRIBEN = 'commit|checkout|switch|rebase|stash(?!\\s+(?:list|show))|reset|merge(?!-)|cherry-pick|pull|revert';
/** El verbo que PUBLICA (el que mira el registro de retrospectivas). */
const VERBOS_QUE_PUBLICAN = 'push';

/**
 * El regex de "un git con estos verbos", con los grupos que `destinos()` espera:
 *   1 = las banderas antes del verbo · 2 = el valor de `-C` (si lo hay) · 3 = el verbo.
 * Se construye acá para que nadie tenga que volver a escribirlo a mano: dos copias de este regex
 * divergen igual que dos copias de cualquier otra cosa.
 */
function regexDeGit(verbos) {
  return new RegExp(
    '^(?:\\w+=(?:"[^"]*"|\'[^\']*\'|[^\\s;&|)]*)\\s+)*git\\b'
    + '((?:\\s+(?:-C\\s+("[^"]+"|\'[^\']+\'|[^\\s;&|)]+)|-c\\s+\\S+|--?[\\w-]+(?:=\\S*)?))*)'
    + `\\s+(${verbos})(?!-)\\b`
  );
}



/**
 * Recorre el comando sentencia por sentencia arrastrando el `cd`.
 * Devuelve `{ statements: [{ st, dir, esCd }], vars }`; `dir === null` significa "no se pudo saber
 * dónde corre esta sentencia" (un `cd` a una variable que el comando no define, o `cd -`).
 */
function recorrer(texto, base) {
  const vars = variablesDelComando(texto);
  const out = [];
  let actual = base;                                    // el cwd "corriente" a lo largo de la cadena
  for (let st of String(texto).split(SEPARADOR)) {
    st = st.replace(/^[\s(]+/, '');                     // `(cd X && git …)`: el subshell se sigue igual
    const cd = st.match(/^cd(?:\s+("[^"]+"|'[^']+'|[^\s;&|)]+))?\s*$/);
    if (cd) {
      const d = cd[1] ? expandir(cd[1], vars) : os.homedir();
      actual = d === null || d === '-' ? null : path.resolve(actual || base, d);
      out.push({ st, dir: actual, esCd: true });
      continue;
    }
    out.push({ st, dir: actual, esCd: false });
  }
  return { statements: out, vars };
}

/**
 * Un destino por cada `git <verbo>` del comando: `{ dir, op, resuelto, st }`.
 * `dir` NUNCA es null — cuando no se pudo resolver cae en `base` y `resuelto` queda en false, para
 * que quien llama pueda elegir entre fallar hacia el repo de la sesión (el freno de sesiones) o
 * negarse a concluir (el registro de retrospectivas).
 * `st` es el texto de LA SENTENCIA, no el del comando entero: quien tenga que leer a qué rama
 * apunta ESE git no puede preguntárselo a la línea completa (`… push origin main; … push origin
 * dev` habla de las dos).
 * `opciones.envoltorios` (default false): ver `sinEnvoltorio`.
 */
function destinos(texto, base, reGit, opciones) {
  const { statements, vars } = recorrer(texto, base);
  const conEnvoltorios = !!(opciones && opciones.envoltorios);
  const out = [];
  for (const s of statements) {
    if (s.esCd) continue;
    // El `st` que se devuelve es SIEMPRE el crudo: quitar el envoltorio sirve para RECONOCER el
    // git, no para reescribir lo que el consumidor va a leer (la rama sale de ese texto).
    const g = (conEnvoltorios ? sinEnvoltorio(s.st) : s.st).match(reGit);
    if (!g) continue;
    let dest = s.dir;
    if (g[2]) { const d = expandir(g[2], vars); dest = d === null ? null : path.resolve(s.dir || base, d); }
    out.push({ dir: dest === null ? base : dest, op: g[3], resuelto: dest !== null, st: s.st });
  }
  return out;
}

module.exports = {
  SEPARADOR, SIN_RESOLVER, VERBOS_QUE_ESCRIBEN, VERBOS_QUE_PUBLICAN,
  regexDeGit, expandir, variablesDelComando, recorrer, destinos, sinEnvoltorio,
};
