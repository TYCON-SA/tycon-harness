'use strict';
/**
 * Avanzar la rama hasta la copia de su rama de origin cuando trae una constancia firmada en otra máquina (A211).
 *
 * La constancia ya está en un commit del remoto: la firmó otra máquina, y lo que esta máquina empuja pasa por el freno del
 * empuje, que pide su huella. `git merge --ff-only origin/<rama>` pasa sólo si:
 *   · es un avance rápido de verdad: `--ff-only`, una sola ref, sin opciones que fusionen o dejen algo en el índice, y la
 *     punta de ahora es la base común;
 *   · no hay un fetch ni un pull en el mismo comando (lo que se trae se bajaría después de mirarlo);
 *   · la ref es la copia de la rama que sigue la de ahora (su upstream, u `origin/<rama actual>`), y su registro dice que
 *     la escribió un fetch o un pull de origin, sin `--refmap=…` ni una ruta en lugar de origin;
 *   · cada constancia coincide con su huella: un archivo `<hash>.json` de una carpeta de constancias, cuyo nombre y `hash`
 *     son los de sus reglas, cuyas reglas son lo que había en el commit que la escribió por última vez, y cuyo cuadro, si
 *     lo trae, es el de su línea.
 * Una constancia escrita a mano en esta copia no está en la copia del remoto; una que no coincide, o un renglón del
 * registro de antes, siguen frenando.
 */
const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
// el hash de una constancia: sus reglas como `ruta<TAB>blob`, ordenadas (el de `run-base-controls.sh approve`)
const hashDeReglas = (rules) => sha256(rules.map((e) => `${e.path}\t${e.blob}\n`).sort().join(''));
// JSON con las claves ordenadas y sin blancos, y la huella de la línea sin su cuadro (las de signed-record-approval.js)
function canonico(x) {
  if (Array.isArray(x)) return `[${x.map(canonico).join(',')}]`;
  if (x && typeof x === 'object') return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canonico(x[k])}`).join(',')}}`;
  return JSON.stringify(x === undefined ? null : x);
}
const huellaDeLinea = (linea) => { const { cuadro, ...resto } = linea; return sha256(canonico(resto)); }; // eslint-disable-line no-unused-vars

/**
 * `acepta(p)` para las constancias que trae el avance hasta `ref` desde la base `mb`, o null si el comando no es ese avance.
 * `git(argv)` devuelve la salida o null; `commit(ref)` y `blob(ref, ruta)`, el sha o null.
 */
function aceptaDelRemoto({ git, commit, blob, args, sueltas, comando, ref, mb }) {
  if (!args.includes('--ff-only') || args.some((w) => /^--(?:no-ff|ff|squash|no-commit|allow-unrelated-histories)$/.test(w))) return null;
  if (sueltas.length > 1) return null;
  if (/\b(?:fetch|pull)\b/.test(String(comando))) return null;
  // `rev-parse --symbolic-full-name` repite `--end-of-options` en su salida: una ref con guion no se pregunta
  if (/^-/.test(ref)) return null;
  const nombreCompleto = (git(['rev-parse', '--symbolic-full-name', ref]) || '').trim();
  if (!/^refs\/remotes\/origin\/\S+$/.test(nombreCompleto) || nombreCompleto === 'refs/remotes/origin/HEAD') return null;
  const punta = commit(nombreCompleto);
  if (!punta || punta !== commit(ref)) return null;
  const ultimo = (git(['reflog', 'show', '-n1', '--format=%H%x09%gs', nombreCompleto]) || '').trim().split('\t');
  if (ultimo[0] !== punta || !/^(?:(?:fetch|pull)(?: --?[a-z][a-z-]*)*(?: origin(?: [\w./-]+)*)?:|update by push$)/.test(ultimo[1] || '')) return null;
  const actual = (git(['symbolic-ref', '-q', 'HEAD']) || '').trim().replace(/^refs\/heads\//, '');
  const arriba = (git(['rev-parse', '--symbolic-full-name', '@{upstream}']) || '').trim();
  if (!actual || (nombreCompleto !== arriba && nombreCompleto !== `refs/remotes/origin/${actual}`)) return null;
  if (!mb || mb !== commit('HEAD')) return null;
  return (p) => {
    const m = /^\.(?:github|tycon)\/control-changes\/([0-9a-f]{64})\.json$/.exec(p);
    if (!m) return false;
    const escritor = (git(['log', '-n1', '--format=%H', '--end-of-options', `${mb}..${punta}`, '--', p]) || '').trim();
    if (!/^[0-9a-f]{40,64}$/.test(escritor) || blob(escritor, p) !== blob(punta, p)) return false;
    let linea;
    try { linea = JSON.parse(git(['cat-file', 'blob', `${punta}:${p}`]) || ''); } catch (_) { return false; }
    if (!linea || typeof linea !== 'object' || Array.isArray(linea) || linea.hash !== m[1]) return false;
    const rules = linea.rules;
    if (!Array.isArray(rules) || !rules.length || rules.some((x) => !x || typeof x.path !== 'string' || !x.path || typeof x.blob !== 'string')) return false;
    if (hashDeReglas(rules) !== m[1]) return false;
    if (rules.some((x) => (blob(escritor, x.path) || 'borrado') !== x.blob)) return false;
    if (linea.cuadro !== undefined && (!linea.cuadro || typeof linea.cuadro !== 'object' || linea.cuadro.huella !== huellaDeLinea(linea))) return false;
    return true;
  };
}

module.exports = { aceptaDelRemoto };
