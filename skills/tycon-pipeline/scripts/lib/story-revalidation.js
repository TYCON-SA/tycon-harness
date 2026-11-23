'use strict';
// story-revalidation.js — cuándo un cambio de la historia lo revalida la vuelta siguiente de la revisión del plan, en vez
// de vencer las constancias de validación y de revisión adversarial y repetir las dos.
//
// El caso: la revisión del plan rechaza con un hallazgo confirmado, la sesión corrige la historia (una causa técnica,
// una prueba, un archivo de la lista) y las dos constancias vencen, porque vencen con cualquier cambio fuera del avance.
// Repetir la adversarial entera cuesta una pasada por cada plan rechazado, y no mira el cambio contra el hallazgo.
//
// La regla: las constancias quedan «a revalidar por el plan» (`por-revalidar`) sólo si se dan las tres cosas.
//   - Cada constancia guardó el texto que validó (`texto`). Sin él no se ve qué cambió, y vence como siempre.
//   - Todo lo cambiado es técnico: las pruebas, las tareas, las dependencias de tareas, las notas de desarrollo y sus
//     subsecciones, y la lista de archivos del encabezado (`files_to_modify`, `files_to_create`). Cuentan como
//     comportamiento: un criterio, la sección de la historia, el título, otra clave del encabezado, una sección que no se
//     reconoce, una salvaguarda de las notas, una parte que se va entera, unas pruebas que pierden renglones y cualquier
//     forma que el corte por títulos no lee con certeza. Ante la duda, vence.
//   - El último veredicto de la revisión del plan de esa historia, posterior a la constancia, es `rechazado`, y es de la
//     corrida abierta sobre este mismo archivo (el renglón `plan-review` de gates.log y el marcador de su sesión). Sin un
//     rechazo así, editar la historia validada sigue venciendo todo.
//   - La revisión adversarial que vence se hizo: una saltada por riesgo bajo o una pendiente vuelven a su portón.
// La vuelta siguiente de la revisión del plan corre con una lente más que juzga el cambio (`cambio-de-historia` en
// adversarial-verify.workflow.js, con `textoDelCambio`). Si aprueba con esa lente medida y sin ningún hallazgo suyo (su
// verificador no ve el cambio: un hallazgo refutado no cuenta como limpio) y con la historia tal como la vio, escribe las
// dos constancias nuevas (`revalidar`); si no, no escribe nada y siguen a revalidar. Mientras sigan así, el cuadro del
// dueño lo dice.
const fs = require('fs');
const path = require('path');
const { stateDir } = require('./state-dir.js');

// los títulos que deciden el tipo de lo que está debajo, comparados en minúsculas, sin acentos ni lo que va entre
// paréntesis («Tests (12 verificaciones)» es «tests»). Lo que no está en ninguna lista es comportamiento
const TECNICAS = ['tests', 'pruebas', 'tasks / subtasks', 'tasks', 'tareas', 'task dependencies', 'dependencias de tareas',
  'dev notes', 'notas de desarrollo', 'notas tecnicas'];
// también las salvaguardas de las notas de desarrollo y los ajustes después de la firma: sacarlas o cambiarlas cambia
// lo que se pide aunque vivan dentro de una sección técnica
const DE_COMPORTAMIENTO = ['story', 'historia', 'acceptance criteria', 'criterios de aceptacion', 'cambios de comportamiento',
  'lo que no hay que hacer', 'patron de referencia verificado', 'ajustes despues de la firma', 'fuera de alcance', 'out of scope'];
// toda salvaguarda («Salvaguarda de BD», «Salvaguarda de estado», …), con el nombre que tenga después
const ES_SALVAGUARDA = /^salvaguarda\b/;
// las pruebas: una que se va puede dejar un criterio sin cubrir
const DE_PRUEBAS = ['tests', 'pruebas'];
// del encabezado, sólo la lista de archivos es técnica
const CLAVES_TECNICAS = new Set(['files_to_modify', 'files_to_create']);
// las revisiones adversariales hechas: las únicas que una vuelta del plan puede revalidar
const REVISADAS = ['limpio', 'corregido', 'preguntado', 'revalidada'];

const normal = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\(.*?\)/g, '').replace(/[*_`]/g, '')
  .trim().toLowerCase().replace(/\s+/g, ' ');
const tipoDeTitulo = (nombre) => {
  const n = normal(nombre);
  if (DE_COMPORTAMIENTO.includes(n) || ES_SALVAGUARDA.test(n)) return 'comportamiento';
  if (TECNICAS.includes(n)) return 'tecnico';
  return null;
};

/**
 * Lee un renglón como lo lee Markdown para los bloques de código: `{ abre }` con la marca que abre un bloque (hasta tres
 * espacios, tres o más ` o ~, y una de ` sin ` en su etiqueta), `{ cierra: true }` si cierra el bloque `cerco`, o null.
 * La misma regla en `partes` y en `formaDudosa`: si no, un renglón que una toma por bloque y la otra no esconde un título.
 */
function valla(l, cerco) {
  if (cerco) {
    const cierre = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(l);
    return cierre && cierre[1][0] === cerco[0] && cierre[1].length >= cerco.length ? { cierra: true } : null;
  }
  const apertura = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(l);
  return apertura && !(apertura[1][0] === '`' && apertura[2].includes('`')) ? { abre: apertura[1] } : null;
}

/**
 * Las partes del texto que mide la huella, cada una con su nombre y su tipo: las claves del encabezado y las secciones
 * por su camino de títulos. El tipo lo decide el título más cercano que se reconoce; sin ninguno, es comportamiento.
 * Dentro de un bloque de código nada es título.
 */
function partes(texto) {
  const lineas = String(texto || '').split('\n');
  const out = new Map();
  const sumar = (nombre, tipo, l) => { if (!out.has(nombre)) out.set(nombre, { tipo, lineas: [] }); out.get(nombre).lineas.push(l); };
  let i = 0;
  if (lineas[0] === '---') {
    const fin = lineas.indexOf('---', 1);
    if (fin > 0) {
      let clave = null;
      for (let k = 1; k < fin; k++) {
        const m = /^([\w-]+)\s*:/.exec(lineas[k]);
        if (m) clave = m[1];
        // un renglón sin clave y sin sangría (un comentario, otra forma) cuenta con la clave de antes o como comportamiento
        const nombre = `encabezado: ${clave || '(sin clave)'}`;
        sumar(nombre, clave && CLAVES_TECNICAS.has(clave.toLowerCase()) ? 'tecnico' : 'comportamiento', lineas[k]);
      }
      i = fin + 1;
    }
  }
  const pila = [];   // [{ nivel, nombre, tipo }]
  let cerco = null;
  for (; i < lineas.length; i++) {
    const l = lineas[i];
    const v = valla(l, cerco);
    if (v && v.abre) cerco = v.abre;
    else if (v && v.cierra) cerco = null;
    else if (cerco === null) {
      const t = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
      if (t) {
        const nivel = t[1].length;
        while (pila.length && pila[pila.length - 1].nivel >= nivel) pila.pop();
        pila.push({ nivel, nombre: t[2], tipo: tipoDeTitulo(t[2]) });
      }
    }
    const camino = pila.map((p) => `${'#'.repeat(p.nivel)} ${p.nombre}`).join(' > ') || '(antes del primer título)';
    const decide = [...pila].reverse().find((p) => p.tipo);
    sumar(camino, decide ? decide.tipo : 'comportamiento', l);
    // pruebas: cualquier título del camino, también «### Tests > #### Backend»
    if (pila.some((p) => DE_PRUEBAS.includes(normal(p.nombre)))) out.get(camino).pruebas = true;
  }
  return out;
}

/**
 * ¿El texto tiene una forma que el corte por títulos no lee con certeza? Un título con sangría o subrayado, un comentario
 * HTML, una valla con cuatro espacios o un bloque sin cerrar: lo mismo que la revisión del plan trata como la historia
 * entera (`textoDeConstruccion` de plan-review.js). Con una de esas, todo el cambio cuenta como comportamiento.
 */
function formaDudosa(texto) {
  let lineas = String(texto || '').split('\n');
  // el encabezado no es cuerpo: su `---` de cierre no es el subrayado de un título
  if (lineas[0] === '---') { const fin = lineas.indexOf('---', 1); if (fin > 0) lineas = lineas.slice(fin + 1); }
  let cerco = null;
  let anterior = '';
  for (const l of lineas) {
    if (cerco) {
      if (valla(l, cerco)) cerco = null;
      anterior = l;
      continue;
    }
    if (/^ {4,}(`{3,}|~{3,})/.test(l)) return true;
    const v = valla(l, null);
    if (v) { cerco = v.abre; anterior = l; continue; }
    if (/^ {1,3}#{1,6}(\s|$)/.test(l) || /<!--/.test(l) || (/^ {0,3}(=+|-+)\s*$/.test(l) && anterior.trim() !== '')) return true;
    anterior = l;
  }
  return cerco !== null;
}

/** Las partes que cambiaron entre dos textos de huella: `[{ parte, tipo, quitadas, sumadas }]`, en orden. */
function cambios(viejo, nuevo) {
  if (viejo !== nuevo && (formaDudosa(viejo) || formaDudosa(nuevo))) {
    const { quitadas, sumadas } = diferencia(String(viejo || '').split('\n'), String(nuevo || '').split('\n'));
    return [{ parte: '(la historia entera: una forma que no se lee con certeza)', tipo: 'comportamiento', quitadas, sumadas }];
  }
  const a = partes(viejo);
  const b = partes(nuevo);
  const out = [];
  for (const nombre of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(nombre);
    const y = b.get(nombre);
    const lx = x ? x.lineas : [];
    const ly = y ? y.lineas : [];
    if (lx.length === ly.length && lx.every((l, k) => l === ly[k])) continue;
    const { quitadas, sumadas } = diferencia(lx, ly);
    // cuenta como comportamiento: una parte que lo es en alguno de los dos textos, una parte que se va entera (una
    // subsección de las notas que desaparece puede ser una salvaguarda), y unas pruebas que pierden renglones
    const tipo = (x && x.tipo === 'comportamiento') || (y && y.tipo === 'comportamiento') || (x && !y)
      || (((x && x.pruebas) || (y && y.pruebas)) && quitadas.length > sumadas.length) ? 'comportamiento' : 'tecnico';
    out.push({ parte: nombre, tipo, quitadas, sumadas });
  }
  return out;
}

/** Los renglones que se van y los que llegan entre dos listas, por la subsecuencia común más larga. */
function diferencia(a, b) {
  // con listas grandes la tabla no se arma: todo cuenta como cambiado, que es lo más estricto
  if (a.length * b.length > 4e6) return { quitadas: a.slice(), sumadas: b.slice() };
  const t = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const quitadas = [];
  const sumadas = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; } else if (t[i + 1][j] >= t[i][j + 1]) quitadas.push(a[i++]); else sumadas.push(b[j++]);
  }
  while (i < a.length) quitadas.push(a[i++]);
  while (j < b.length) sumadas.push(b[j++]);
  return { quitadas, sumadas };
}

/** El id de la historia, del `story:` de su encabezado; null si no lo tiene. */
function idDeHistoria(textoHistoria) {
  const m = /^---\n([\s\S]*?)\n---/.exec(String(textoHistoria || '').replace(/\r\n?/g, '\n'));
  if (!m) return null;
  const s = /^story:\s*["']?([^"'\n#]+?)["']?\s*(#.*)?$/m.exec(m[1]);
  return s ? s[1].trim() : null;
}

const realPath = (p) => { try { return fs.realpathSync.native(p); } catch (_) { return path.resolve(p); } };

/**
 * El rechazo que deja a revalidar: el último veredicto de la revisión del plan de esa historia después de `desde` (ISO)
 * es `rechazado` (uno `sin-veredicto` no cuenta: no decidió), y es de la corrida abierta de su sesión sobre ESTE archivo
 * (el marcador de la sesión destino nombra esta historia y la misma hora de arranque). Un rechazo de otra copia, de otro
 * repo o de otra corrida, o uno con un aprobado después, no vale. null si no hay.
 */
function rechazoDespuesDe(estado, storyId, desde, storyPath) {
  let lineas = [];
  try { lineas = fs.readFileSync(path.join(estado, 'gates.log'), 'utf8').split('\n'); } catch (_) { return null; }
  let ultimo = null;
  const tope = Date.parse(desde);
  for (const l of lineas) {
    if (!l.trim()) continue;
    let r;
    try { r = JSON.parse(l); } catch (_) { continue; }
    if (!r || r.name !== 'plan-review' || String(r.story) !== storyId || !(Date.parse(r.ts) > tope)) continue;
    if (['rechazado', 'aprobado', 'aprobado-con-notas'].includes(r.veredicto)) ultimo = r;
  }
  if (!ultimo || ultimo.veredicto !== 'rechazado' || !/^[\w-]+$/.test(String(ultimo.destino || ''))) return null;
  let marker;
  try { marker = JSON.parse(fs.readFileSync(path.join(estado, 'active', `${ultimo.destino}.json`), 'utf8')); } catch (_) { return null; }
  // la ruta del marcador, relativa a su repo si no es absoluta; la de la historia, relativa a donde se corre
  const delMarcador = marker && marker.storyPath ? (path.isAbsolute(marker.storyPath) ? marker.storyPath : path.resolve(marker.repoPath || '', marker.storyPath)) : null;
  if (!delMarcador || realPath(delMarcador) !== realPath(path.resolve(storyPath))) return null;
  if (!ultimo.corrida || !marker.startedAt || ultimo.corrida.startedAt !== marker.startedAt) return null;
  return ultimo;
}

/**
 * ¿Las constancias de la historia quedan a revalidar por la vuelta del plan? `{ aplica, motivo, cambios, rechazo,
 * validacion, revision }`. `validacion` y `revision` son las lecturas de cada constancia con `estado: 'por-revalidar'`
 * cuando aplica (las que ya eran `current` quedan igual). Lo que no se puede leer, vence: `aplica: false` con su motivo.
 */
function porRevalidar({ home, storyPath, estado = null }) {
  const VR = require('./validation-record.js');
  const SR = require('./story-review-record.js');
  const validacion = VR.readRecord(home, storyPath);
  const revision = SR.readRecord(home, storyPath);
  const base = { aplica: false, cambios: [], rechazo: null, validacion, revision };
  const vencidas = [validacion, revision].filter((x) => x.estado === 'stale');
  if (!vencidas.length) return { ...base, motivo: 'ninguna constancia vencida' };
  // una revisión que no se hizo (saltada por riesgo bajo, pendiente de una respuesta) no se revalida: su portón vuelve a
  // decidir, con el riesgo de ahora
  if (revision.estado === 'stale' && !REVISADAS.includes(revision.record.resultado)) {
    return { ...base, motivo: `la revisión adversarial no se hizo (${revision.record.resultado}): su portón vuelve a decidir` };
  }
  let textoHistoria;
  try { textoHistoria = fs.readFileSync(storyPath, 'utf8'); } catch (e) { return { ...base, motivo: `no pude leer la historia (${e.code || e.message})` }; }
  const ahora = SR.textoDeHuella(textoHistoria);
  const sinTexto = vencidas.find((x) => typeof x.record.texto !== 'string');
  if (sinTexto) return { ...base, motivo: 'una constancia es de antes de guardar el texto validado: no se ve qué cambió' };
  // las dos constancias tienen que haber validado el mismo texto: si no, no hay un cambio solo que mirar
  const textos = new Set(vencidas.map((x) => x.record.texto));
  if (textos.size > 1) return { ...base, motivo: 'las dos constancias validaron textos distintos' };
  const viejo = [...textos][0];
  const lista = cambios(viejo, ahora);
  const deComportamiento = lista.filter((c) => c.tipo === 'comportamiento');
  if (!lista.length) return { ...base, motivo: 'no encontré qué cambió' };
  if (deComportamiento.length) return { ...base, cambios: lista, motivo: `cambió lo que define el comportamiento: ${deComportamiento.map((c) => c.parte).join('; ')}` };
  const storyId = idDeHistoria(textoHistoria);
  if (!storyId) return { ...base, cambios: lista, motivo: 'la historia no declara `story:`: no puedo atarla a su revisión del plan' };
  // el rechazo tiene que ser posterior a la constancia más nueva de las vencidas
  const desde = vencidas.map((x) => x.record.hora).sort().pop();
  const rechazo = rechazoDespuesDe(estado || stateDir(home), storyId, desde, storyPath);
  if (!rechazo) return { ...base, cambios: lista, motivo: 'no hay una revisión del plan rechazada de esta corrida después de la validación, como último veredicto' };
  const marcar = (x) => (x.estado === 'stale' ? { ...x, estado: 'por-revalidar' } : x);
  return {
    aplica: true, motivo: null, cambios: lista, rechazo, storyId, textoValidado: viejo,
    validacion: marcar(validacion), revision: marcar(revision),
  };
}

/** El cambio, en texto para el revisor: cada parte con sus renglones que se van (-) y los que llegan (+). */
function textoDelCambio(lista) {
  return lista.map((c) => [`### ${c.parte} (${c.tipo === 'tecnico' ? 'técnico' : 'comportamiento'})`,
    ...c.quitadas.map((l) => `- ${l}`), ...c.sumadas.map((l) => `+ ${l}`)].join('\n')).join('\n\n');
}

/**
 * Escribe las dos constancias nuevas después de una vuelta del plan aprobada sobre la historia tal como la vio. Sólo las
 * que estaban a revalidar, y sólo si siguen siendo las mismas que la vuelta vio (`horas`, la hora de cada una al
 * preparar): una constancia que se escribe mientras corre el pase, en rojo o pendiente, no se pisa. La de validación sólo
 * si la vencida es verde. Devuelve las rutas escritas.
 */
function revalidar({ home, storyPath, kinds, validadores, riesgo, revisionDelPlan, horas = {} }) {
  const escritas = [];
  const origen = { revision_del_plan: revisionDelPlan };
  const VR = require('./validation-record.js');
  const SR = require('./story-review-record.js');
  const igual = (leida, hora) => leida.record && leida.record.hora === hora;
  if (kinds.includes('validacion') && Array.isArray(validadores) && validadores.length && igual(VR.readRecord(home, storyPath), horas.validacion)) {
    escritas.push(VR.writeRecord(home, storyPath, { resultado: 'verde', validadores, origen }));
  }
  if (kinds.includes('revision') && igual(SR.readRecord(home, storyPath), horas.revision)) {
    escritas.push(SR.writeRecord(home, storyPath, { resultado: 'revalidada', hallazgos: [], riesgo, origen }));
  }
  return escritas;
}

module.exports = { TECNICAS, DE_COMPORTAMIENTO, CLAVES_TECNICAS, REVISADAS, partes, formaDudosa, cambios, idDeHistoria, rechazoDespuesDe, porRevalidar, textoDelCambio, revalidar };
