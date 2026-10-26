'use strict';
/**
 * ledger-visible.js — que el pipeline no se quede ciego POR CONSTRUCCIÓN.
 *
 * EL PROBLEMA. El registro de ediciones
 * (`marker.fileEvents`) lo alimenta `on-edit.js` desde el hook PostToolUse matcher `Edit|Write`.
 * Una edición hecha por Bash —`sed -i`, un heredoc, `python3 -c "open(...,'w')"`— es invisible
 * para ese hook **por construcción**: no es que falle, es que no hay evento.
 *
 * Consecuencia: al re-loopear, `smart-reloop` no puede calcular el delta y cae al set
 * COMPLETO — 7 revisores en vez de los 2-3 que el cambio real justifica. El aviso es honesto
 * ("registro de ediciones CIEGO"), pero llega tarde: cuando el trabajo ya está hecho.
 *
 * POR QUÉ ACÁ Y NO ENSEÑÁNDOLE AL ARNÉS A LEER BASH. Las dos
 * alternativas parchean el síntoma y las dos tienen un costo peor:
 *   · Confiar en la 4ta fuente (git + mtime) cuando el registro está ciego RELAJA una decisión de
 *     seguridad deliberada (`ledger-honesty.js`: "ciego → set COMPLETO"), cuyo modo de falla es el
 *     silencioso — un fix que no se re-audita y nadie ve.
 *   · Reconstruir eventos desde git + mtime mete fechas inferidas en el mismo registro que usa el
 *     gate ATDD para decidir si los tests se escribieron ANTES que el código. Ahí el orden importa
 *     y mtime es una señal floja.
 * Frenar la edición invisible ataca el ORIGEN: si no se puede editar de una forma que el arnés no
 * ve, el registro no se queda ciego y las dos garantías (delta honesto, orden ATDD) siguen intactas.
 *
 * 🔴 EL CONFLICTO QUE ESTO RESUELVE: en «auto mode» el propio arnés INSTRUYE editar con sed/heredocs en vez de
 * Edit/Write. Eso se resuelve para el CARRIL (quién puede editar) pero no para el REGISTRO (si queda anotado).
 * Ésta es la otra mitad.
 *
 * Alcance deliberadamente angosto: sólo CÓDIGO, sólo con pipeline ABIERTO, sólo dentro del repo de
 * la corrida. Un `.md`, un `.json` de configuración, un script del scratchpad o cualquier cosa con
 * el pipeline cerrado siguen pasando por Bash sin fricción — el registro sólo importa mientras hay
 * un re-loop que pueda quedarse ciego.
 */

/**
 * ¿Hay una corrida de pipeline viva? Un marker sin `stepsPending` o con la lista vacía es una
 * corrida terminada (mismo criterio que `story-gate-io.js:140`): ahí no hay re-loop que proteger.
 */
function pipelineAbierto(marker) {
  if (!marker || typeof marker !== 'object') return false;
  if (!Array.isArray(marker.stepsPending)) return false;
  return marker.stepsPending.length > 0;
}

/**
 * Decide si una escritura por Bash tiene que frenarse porque el registro no la vería.
 *
 * @param {object}   args
 * @param {object|null} args.marker      el marker de la sesión (o null)
 * @param {string[]} args.codeTargets    paths ABSOLUTOS de código que el comando va a escribir
 * @param {function} args.dentroDelRepo  (abs, repoPath) => bool
 * @param {string}   [args.off]          valor del kill-switch (env TYCON_LEDGER_VISIBLE)
 * @returns {{block:boolean, files:string[], reason:string}}
 */
function evaluarVisibilidad({ marker, codeTargets, dentroDelRepo, off }) {
  const nada = { block: false, files: [], reason: '' };
  const escape = String(off || '').toLowerCase() === 'off';
  if (!pipelineAbierto(marker)) return { ...nada, reason: escape ? 'kill-switch TYCON_LEDGER_VISIBLE=off' : 'sin pipeline abierto — el registro no se usa' };
  const repo = marker.repoPath;
  if (!repo) return { ...nada, reason: escape ? 'kill-switch TYCON_LEDGER_VISIBLE=off' : 'marker sin repoPath' };

  const files = (codeTargets || []).filter((f) => dentroDelRepo(f, repo));
  if (!files.length) return { ...nada, reason: escape ? 'kill-switch TYCON_LEDGER_VISIBLE=off' : 'ningún target de código dentro del repo de la corrida' };
  // El escape deja pasar, pero devuelve QUÉ habría frenado: el llamador lo anota en gates.log, como promete el
  // mensaje.
  if (escape) return { ...nada, escaped: files, reason: 'kill-switch TYCON_LEDGER_VISIBLE=off' };
  return { block: true, files, reason: 'edición de código por Bash con pipeline abierto: el registro no la vería' };
}

/**
 * El mensaje que ve el agente. Explica la CONSECUENCIA, no sólo la regla.
 * `opts.sinResolver`: `[{ file, vars }]` — destinos con variables que ni el comando ni el ambiente definen:
 * se frenan del lado seguro, pero el mensaje lo dice en vez de presentarlos como código del repo sin más.
 * `opts.codex`: el evento es de Codex, que no tiene Edit ni Write: edita con `apply_patch`, y el mensaje da su forma.
 */
function mensaje(files, storyId, opts = {}) {
  const codex = !!opts.codex;
  const lista = files.map((f) => `     · ${f}`).join('\n');
  const sinResolver = Array.isArray(opts.sinResolver) ? opts.sinResolver : [];
  const nombres = sinResolver.map((s) => s.vars.map((v) => (v.startsWith('$') ? v : `$${v}`)).join(', ')).join(' · ');
  const avisoVariables = !sinResolver.length ? [] : [
    '',
    `   Ojo: ${nombres} sin resolver — sin ejecutar el comando no sé adónde escribe (la variable no está definida`,
    '   antes en el mismo comando ni en el ambiente, o se arma con `$(…)` o con `${VAR:-…}`), así que lo trato como si',
    '   cayera en el repo. Si apunta afuera (el scratchpad), asignale la ruta LITERAL en el mismo comando',
    '   (`SP=/ruta/al/scratchpad; …`) o escribí la ruta literal en el destino.',
  ];
  const avisoBorrar = !opts.borrarODeshacer ? [] : [
    '',
    '   Borrar o deshacer código o un manifiesto por la terminal tampoco lo ve el registro. Deshacer: reescribí el',
    `   archivo con ${codex ? 'apply_patch' : 'Write'} desde su versión de git (\`git show <commit>:<ruta>\`). Borrar: si es parte de la historia,`,
    '   nombralo en la story (files_to_delete o files_to_modify) y borralo con `git rm <ruta>`, un archivo por ruta:',
    '   pasa y queda anotado entre los archivos tocados de la corrida.',
  ];
  const avisoArmado = !opts.armado ? [] : [
    '',
    '   Un script inline que escribe en un destino que no es una ruta literal (una variable, `path.join`, una',
    `   concatenación): sin ejecutarlo no sé adónde escribe. Escribí la ruta literal, o editá con ${codex ? 'apply_patch' : 'Edit/Write'}.`,
  ];
  const queHacer = codex ? [
    '   QUÉ HACER: editá esos archivos con **apply_patch**, con el parche en un heredoc. Mismo resultado, y el',
    '   registro los ve:',
    "     apply_patch <<'EOF'",
    '     *** Begin Patch',
    '     *** Update File: <ruta>     (o *** Add File: <ruta> para uno nuevo, con cada línea empezando con +)',
    '     @@',
    '     -línea vieja',
    '     +línea nueva',
    '     *** End Patch',
    '     EOF',
    "   El heredoc con 'EOF' entre comillas deja el código tal cual. No pases el parche entre comillas simples",
    "   (`apply_patch '*** Begin Patch…'`): una comilla del código lo parte en varios argumentos y sale",
    '   «apply_patch accepts exactly one argument». Si apply_patch da un error, leelo y corregí el parche:',
    '   no repitas el mismo comando, va a fallar igual.',
    '   (El resto —`.md`, configuración, scripts del scratchpad— sigue pasando por la terminal sin fricción: esto es',
    '   sólo código, y sólo mientras hay una corrida abierta.)',
  ] : [
    '   QUÉ HACER: editá esos archivos con las tools **Edit** o **Write**. Mismo resultado, y el',
    '   registro los ve. (El resto —`.md`, configuración, scripts del scratchpad— sigue pasando por',
    '   Bash sin fricción: esto es sólo código, y sólo mientras hay una corrida abierta.)',
  ];
  return [
    '🔴 EDICIÓN INVISIBLE — escritura de código por Bash con el pipeline ABIERTO' +
      (storyId ? ` (story ${storyId})` : '') + ':',
    lista,
    ...avisoVariables,
    ...avisoBorrar,
    ...avisoArmado,
    '',
    `   El registro de ediciones lo alimenta el hook PostToolUse sobre ${codex ? 'apply_patch' : 'Edit|Write'}. Un \`sed\`, un`,
    '   heredoc o un `python3 -c "open(...)"` NO generan ese evento: la edición ocurre y el arnés',
    '   no se entera. No es que falle — no hay nada que leer.',
    '',
    '   Qué se rompe después, no ahora: al re-loopear, `smart-reloop` no puede calcular qué cambió',
    '   y cae al set COMPLETO de revisores. Medido el 2026-09-21 (Story OC-1): 7 revisores en vez',
    '   de 2-3. El aviso llegaba recién ahí, con el trabajo ya hecho.',
    '',
    ...queHacer,
    '',
    `   Para reemplazar un tramo GRANDE (${codex ? 'un parche' : 'un Edit'} tendría que copiar el bloque viejo entero), la receta`,
    `   registrada pasa por los mismos frenos y el mismo registro que ${codex ? 'un parche' : 'un Edit'}:`,
    '     node <skill>/scripts/replace-section.js --file <ruta> --from <n> --to <m> --with <archivo>',
    '',
    '   Escape del dev (no del agente): TYCON_LEDGER_VISIBLE=off en el ambiente de la sesión. Ponerlo',
    '   adelante del comando no sirve — el freno corre en otro proceso. Cada paso queda en gates.log.',
  ].join('\n');
}

module.exports = { pipelineAbierto, evaluarVisibilidad, mensaje };
