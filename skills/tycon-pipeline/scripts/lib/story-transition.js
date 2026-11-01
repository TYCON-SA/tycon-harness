'use strict';
/**
 * story-transition.js — ¿un cambio a una historia le cambia a mano lo que su encabezado cuida?
 *
 * Una sola regla para los dos caminos: la herramienta de edición (`on-frontmatter-write.js`) y la consola, que ensaya un
 * `sed` sobre una copia y lo deja pasar sólo si esta regla también lo dejaría (`on-bash-write-gate.js`). Cuida el estado
 * de arriba, un estado repetido, el número de la historia y cada tanda del bloque `pipelines` que pasa a `done`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { stateDir: stateDirOf } = require('./state-dir.js');

const EN_IMPLEMENTACION = new Set(['in-progress', 'review', 'done']);

function isCriticalStatus(s) {
  return s === 'review' || s === 'done';
}

/**
 * El estado de una historia como lo lee una persona: sin la marca de orden de bytes, con fines de renglón de Windows,
 * con el valor entre comillas simples o dobles y con un comentario al final. `{ story, status, tandas }`, con `tandas` el
 * estado de cada tanda del bloque `pipelines` (por su nombre). null si no hay encabezado.
 */
function estadosDe(content) {
  const texto = String(content || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---/.exec(texto);
  if (!m) return null;
  const crudo = (v) => String(v || '').replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();
  const valor = (v) => crudo(v).toLowerCase();
  // el primer `status:` es el que leen marker.js y el freno del commit; uno repetido queda anotado (`estados`)
  const out = { story: null, status: '', estados: [], tandas: new Map() };
  let enPipelines = false;
  let tanda = null;
  let sangriaTanda = null;
  for (const renglon of m[1].split('\n')) {
    // la clave con o sin comillas y con espacios antes de los dos puntos (`status : done`, `"status": done`)
    const tope = /^(["']?)([A-Za-z_][\w-]*)\1\s*:\s*(.*)$/.exec(renglon);
    if (tope) {
      enPipelines = tope[2] === 'pipelines';
      tanda = null; sangriaTanda = null;
      // el id con sus mayúsculas: el patrón de ids del repo las distingue
      if (tope[2] === 'story' && out.story === null) out.story = crudo(tope[3]) || null;
      if (tope[2] === 'status') { out.estados.push(valor(tope[3])); if (out.estados.length === 1) out.status = out.estados[0]; }
      continue;
    }
    if (!enPipelines) continue;
    const anidado = /^(\s+)-?\s*(["']?)([\w.-]+)\2\s*:\s*(.*)$/.exec(renglon);
    if (!anidado) continue;
    const sangria = anidado[1].length;
    if (anidado[3] === 'status' && tanda !== null && sangria > sangriaTanda) { out.tandas.set(tanda, valor(anidado[4])); continue; }
    if (sangriaTanda === null || sangria <= sangriaTanda) { tanda = anidado[3]; sangriaTanda = sangria; }
  }
  return out;
}

/**
 * ¿La escritura cambia a mano el estado de una historia? `{ storyId, estado }` o null. Cuenta:
 * - su `status:` pasa a `review` o `done`, o una tanda del bloque `pipelines` queda en `done` sin haberlo estado;
 * - una historia en implementación (`in-progress`, `review`, `done`) cambia a otro estado (volver a `draft` y después
 *   escribirla por consola sería el mismo cierre en dos pasos);
 * - una historia pierde su encabezado o su `story:`, o le cambia el id (sacarlo o cambiarlo a uno que no es de trabajo y
 *   reponerlo después sería el mismo cierre en dos pasos).
 * Es una historia si el id de antes o el de después es de trabajo. Si no se puede leer y el texto nuevo dice `review` o
 * `done`, o el de antes estaba en implementación, cuenta.
 */
function transicionAMano(filePath, oldContent, newContent) {
  try {
    const antes = estadosDe(oldContent);
    const despues = estadosDe(newContent);
    const { isWorkStoryId, storiesConfigForGate, findRepoRoot } = require('./story-discovery.js');
    const patron = storiesConfigForGate(findRepoRoot(filePath)).idPattern;
    const deTrabajo = (s) => !!s && isWorkStoryId(s, patron);
    const idAntes = antes && antes.story;
    const idDespues = despues && despues.story;
    if (!deTrabajo(idAntes) && !deTrabajo(idDespues)) return null;
    const id = deTrabajo(idAntes) ? idAntes : idDespues;
    if (deTrabajo(idAntes) && (!despues || idDespues !== idAntes)) return { storyId: id, estado: idDespues ? `otro id (${idDespues})` : 'sin encabezado' };
    const viejo = antes || { status: '', estados: [], tandas: new Map() };
    // un `status:` repetido que no estaba: cada lector puede quedarse con uno distinto
    const distintos = (e) => new Set(e.estados).size;
    if (distintos(despues) > 1 && distintos(despues) > distintos(viejo)) return { storyId: id, estado: `estado repetido (${despues.estados.join(', ')})` };
    if (isCriticalStatus(despues.status) && despues.status !== viejo.status) return { storyId: id, estado: despues.status };
    if (EN_IMPLEMENTACION.has(viejo.status) && despues.status !== viejo.status) return { storyId: id, estado: despues.status || 'sin estado' };
    for (const [nombre, estado] of despues.tandas) {
      if (estado === 'done' && viejo.tandas.get(nombre) !== 'done') return { storyId: id, estado: `pipelines.${nombre}` };
    }
    return null;
  } catch (e) {
    // del lado que frena: un error al leer no deja pasar un `review`/`done` escrito, y queda en hook-errors.log
    try {
      fs.mkdirSync(stateDirOf(os.homedir()), { recursive: true });
      fs.appendFileSync(path.join(stateDirOf(os.homedir()), 'hook-errors.log'),
        `[${new Date().toISOString()}] on-frontmatter-write transicionAMano: ${(e && e.stack) || e}\n\n`, 'utf8');
    } catch { /* el registro no cambia la decisión */ }
    const estadoEnTexto = (t) => (/^\s*["']?status["']?\s*:\s*["']?([\w-]+)/m.exec(String(t || '')) || [])[1] || '';
    const nuevo = estadoEnTexto(newContent).toLowerCase();
    const viejo = estadoEnTexto(oldContent).toLowerCase();
    return isCriticalStatus(nuevo) || (EN_IMPLEMENTACION.has(viejo) && nuevo !== viejo)
      ? { storyId: '?', estado: `${nuevo || 'sin estado'} (no se pudo leer la historia)` } : null;
  }
}

module.exports = { estadosDe, transicionAMano, isCriticalStatus, EN_IMPLEMENTACION };
