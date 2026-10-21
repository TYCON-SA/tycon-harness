'use strict';
/**
 * sliding-window.js — los verificadores del pase adversarial en una ventana de tres.
 *
 * En la fase 2 del pase, las tandas fijas de tres esperarían, cada una, a su verificador más lento
 * antes de abrir la siguiente. La ventana tiene el mismo tope (tres: cada verificador abre Bash en la
 * máquina del dev) y repone apenas termina uno.
 *
 * El tope lo pone esta función, no el corredor: el pase corre con dos (la herramienta de flujos y `workflow-lite.js`
 * del lado Codex, cuyo tope es `TYCON_WFLITE_JOBS`), y pasarle todas las clases a su `parallel` dejaría el tope en el
 * del corredor. Por eso el guion la llama sobre promesas sueltas de `agent()`.
 *
 * El pase corre en una caja sin `require`, así que el núcleo va COPIADO dentro de `adversarial-verify.workflow.js`;
 * `tests/adversarial-launch.test.js` (T16) compara las dos copias. Para re-sincronizar:
 *   node lib/sliding-window.js --emit-core
 */

// ===== NUCLEO-VENTANA: INICIO =====
// La ventana: como mucho `size` tareas vivas a la vez; apenas termina una, entra la siguiente. Cada carril está
// aislado: una tarea que tira deja `null` en su lugar y las demás se intentan igual; el motivo va a `onError(k, e)`
// (sin él, la causa se perdía). El resultado sale en el orden de las tareas, no en el de llegada.
async function runWindow(tareas, opts) {
  const size = Math.max(1, Math.floor((opts && opts.size) || 3))
  const onError = opts && typeof opts.onError === 'function' ? opts.onError : null
  const lista = Array.isArray(tareas) ? tareas : []
  const resultados = new Array(lista.length).fill(null)
  let siguiente = 0
  const carril = async () => {
    while (siguiente < lista.length) {
      const k = siguiente
      siguiente += 1
      try {
        resultados[k] = await lista[k]()
      } catch (e) {
        resultados[k] = null
        if (onError) { try { onError(k, e) } catch (_e) { /* el aviso nunca corta la ventana */ } }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, lista.length) }, () => carril()))
  return resultados
}
// ===== NUCLEO-VENTANA: FIN =====

/** El bloque que va copiado dentro del pase. Lo usan la prueba de deriva y el re-sincronizado. */
function nucleo() {
  const src = require('fs').readFileSync(__filename, 'utf8');
  const i = src.indexOf('// ===== NUCLEO-VENTANA: INICIO =====');
  const j = src.indexOf('// ===== NUCLEO-VENTANA: FIN =====');
  if (i < 0 || j < 0) throw new Error('sliding-window.js: faltan las marcas del núcleo');
  return src.slice(i, j).trimEnd();
}

module.exports = { runWindow, nucleo };

if (require.main === module && process.argv.includes('--emit-core')) process.stdout.write(nucleo() + '\n');
