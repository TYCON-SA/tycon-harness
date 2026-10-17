'use strict';
/**
 * ledger-visible.js — que el pipeline no se quede ciego POR CONSTRUCCIÓN.
 *
 * EL PROBLEMA (caso Story OC-1 del backend de un producto del equipo, 2026-09-21 — guides/maintaining/incident-log.md#case-bash-edits-blind-ledger-2026-09-21). El registro de ediciones
 * (`marker.fileEvents`) lo alimenta `on-edit.js` desde el hook PostToolUse matcher `Edit|Write`.
 * Una edición hecha por Bash —`sed -i`, un heredoc, `python3 -c "open(...,'w')"`— es invisible
 * para ese hook **por construcción**: no es que falle, es que no hay evento.
 *
 * Consecuencia medida: al re-loopear, `smart-reloop` no pudo calcular el delta y cayó al set
 * COMPLETO — 7 revisores en vez de los 2-3 que el cambio real justificaba. El aviso fue honesto
 * ("registro de ediciones CIEGO"), pero llegó tarde: cuando el trabajo ya estaba hecho.
 *
 * POR QUÉ ACÁ Y NO ENSEÑÁNDOLE AL ARNÉS A LEER BASH (decisión del dev, 2026-09-21). Las dos
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
 * 🔴 EL CONFLICTO QUE ESTO RESUELVE, y que ya estaba anotado en `on-bash-write-gate.js`: *"en «auto
 * mode» el propio arnés INSTRUYE editar con sed/heredocs en vez de Edit/Write"* (hallazgo R3 del
 * review adversarial 2026-08-19). Ese hallazgo se resolvió para el CARRIL (quién puede editar) y no
 * para el REGISTRO (si queda anotado). Ésta es la otra mitad.
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
  // El escape deja pasar, pero devuelve QUÉ habría frenado (story 7.25): el llamador lo anota en gates.log. Antes el
  // mensaje prometía esa constancia y no se escribía nada.
  if (escape) return { ...nada, escaped: files, reason: 'kill-switch TYCON_LEDGER_VISIBLE=off' };
  return { block: true, files, reason: 'edición de código por Bash con pipeline abierto: el registro no la vería' };
}

/**
 * El mensaje que ve el agente. Explica la CONSECUENCIA, no sólo la regla.
 * `opts.sinResolver`: `[{ file, vars }]` — destinos con variables que ni el comando ni el ambiente definen (story 7.25):
 * se frenan del lado seguro, pero el mensaje lo dice en vez de presentarlos como código del repo sin más.
 */
function mensaje(files, storyId, opts = {}) {
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
  return [
    '🔴 EDICIÓN INVISIBLE — escritura de código por Bash con el pipeline ABIERTO' +
      (storyId ? ` (story ${storyId})` : '') + ':',
    lista,
    ...avisoVariables,
    '',
    '   El registro de ediciones lo alimenta el hook PostToolUse sobre Edit|Write. Un `sed`, un',
    '   heredoc o un `python3 -c "open(...)"` NO generan ese evento: la edición ocurre y el arnés',
    '   no se entera. No es que falle — no hay nada que leer.',
    '',
    '   Qué se rompe después, no ahora: al re-loopear, `smart-reloop` no puede calcular qué cambió',
    '   y cae al set COMPLETO de revisores. Medido el 2026-09-21 (Story OC-1): 7 revisores en vez',
    '   de 2-3. El aviso llegaba recién ahí, con el trabajo ya hecho.',
    '',
    '   QUÉ HACER: editá esos archivos con las tools **Edit** o **Write**. Mismo resultado, y el',
    '   registro los ve. (El resto —`.md`, configuración, scripts del scratchpad— sigue pasando por',
    '   Bash sin fricción: esto es sólo código, y sólo mientras hay una corrida abierta.)',
    '',
    '   Para reemplazar un tramo GRANDE (un Edit tendría que copiar el bloque viejo entero), la receta',
    '   registrada pasa por los mismos frenos y el mismo registro que un Edit:',
    '     node <skill>/scripts/replace-section.js --file <ruta> --from <n> --to <m> --with <archivo>',
    '',
    '   Escape del dev (no del agente): TYCON_LEDGER_VISIBLE=off en el ambiente de la sesión. Ponerlo',
    '   adelante del comando no sirve — el freno corre en otro proceso. Cada paso queda en gates.log.',
  ].join('\n');
}

module.exports = { pipelineAbierto, evaluarVisibilidad, mensaje };
