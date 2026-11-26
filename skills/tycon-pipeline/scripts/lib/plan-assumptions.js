'use strict';
/**
 * plan-assumptions — la sección «## Suposiciones sobre el código» del plan escrito.
 *
 * La revisión del plan busca «suposición falsa»: lo que el plan cree del código y no es cierto. Esa lente corre recién
 * en «Aprobar el plan», y un plan rechazado ahí cuesta una vuelta entera. Por eso el plan de una historia con código
 * escribe lo que da por cierto, cada cosa con su `archivo:línea`, y el cierre de «Armar el plan» no pasa si falta la
 * sección o si un archivo citado no existe. Un plan de puro texto (guías, historias, configuración) no la lleva.
 *
 * Qué cuenta como «con código»: algún archivo de la sección «## Archivos» del plan es código de implementación (los
 * mismos lectores que el portón: story-gate.isCodeFile y atdd-order.isImplPath). Sin «## Archivos» no se sabe, y no
 * frena: esa falta ya la dice la pregunta de la firma.
 *
 * Las rutas se buscan en el repo de la ejecución y en sus hermanos (`raices`): una historia que vive en el repo de las
 * historias cita el código del repo hermano. Un renglón vale si alguna de sus citas existe dentro de alguna raíz (el
 * resto del texto puede traer algo que se parece a una cita, como una versión o una URL). Un plan que no da nada por
 * cierto (sólo crea archivos nuevos) lo dice con un único renglón «Ninguna: <por qué>».
 *
 * Uso: revisar(planTexto, { repo, raices }) → { aplica, problemas: [texto], suposiciones: [{ archivo, linea, texto }] }
 */

const fs = require('fs');
const path = require('path');

const TITULO = 'Suposiciones sobre el código';
const EJEMPLO = '«- skills/tycon-pipeline/scripts/lib/steps.js:27 — el paso del plan se llama plan»';
// `ruta:línea` (también `ruta:línea-línea`), con o sin comillas invertidas; la ruta lleva una extensión
const CITA = /`?([\w.@\-/\\[\]]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?`?/g;
const NINGUNA = /^ninguna\b\s*[:—–-]\s*\S/i;

/** El cuerpo de la sección `## <titulo>` (sin el título), o null si no está. */
function seccion(texto, titulo) {
  const lineas = String(texto || '').split(/\r?\n/);
  const escapado = titulo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const i = lineas.findIndex((l) => new RegExp(`^##\\s+${escapado}\\s*$`, 'i').test(l.trim()));
  if (i < 0) return null;
  const fin = lineas.findIndex((l, k) => k > i && /^#{1,2}\s/.test(l));
  return lineas.slice(i + 1, fin < 0 ? undefined : fin);
}

const renglones = (cuerpo) => (cuerpo || []).map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').trim()).filter(Boolean);

/** Los archivos de «## Archivos»: la ruta de cada renglón, sin anotaciones ni comandos. */
function archivosDelPlan(texto) {
  return renglones(seccion(texto, 'Archivos'))
    .flatMap((l) => l.split(/,\s+(?![^(]*\))/))
    .map((a) => a.replace(/[`*]/g, '').trim())
    // un comando que sólo corre (`node --test …`) no es un archivo que el plan cambia
    .filter((a) => a && !/^(node|npm|npx|sh|bash|dotnet|python3?|pwsh)\s/.test(a))
    // «ruta: descripción» o «ruta — descripción»: la ruta es lo de antes
    .map((a) => a.split(/\s+|:\s/)[0].replace(/:$/, ''));
}

/** ¿El plan toca código de implementación? */
function conCodigo(texto) {
  const { isCodeFile } = require('./story-gate.js');
  const { isImplPath } = require('./atdd-order.js');
  return archivosDelPlan(texto).some((a) => isCodeFile(a) && isImplPath(a));
}

/** Una cita contra las raíces: `{ ok, archivo, linea }` o `{ ok: false, problema }`. */
function comprobar(c, donde) {
  const archivo = c[1].replace(/\\/g, '/');
  const linea = Number(c[2]);
  const hasta = c[3] ? Number(c[3]) : linea;
  let largo = null;
  for (const raiz of donde) {
    const abs = path.resolve(raiz, archivo);
    // una ruta que sale de las raíces (absoluta o con ../) no es del código de la ejecución
    if (abs !== raiz && !abs.startsWith(raiz + path.sep)) continue;
    let texto;
    try { texto = fs.readFileSync(abs, 'utf8'); } catch (_) { continue; }
    largo = texto.split(/\r?\n/).length;
    if (linea >= 1 && hasta >= linea && hasta <= largo) return { ok: true, archivo, linea };
  }
  const cita = `${archivo}:${linea}${c[3] ? `-${hasta}` : ''}`;
  if (largo !== null) return { ok: false, problema: `${cita} no existe: el archivo tiene ${largo} líneas` };
  return { ok: false, problema: `${cita} no existe en el repo ni en sus hermanos: corregí la ruta o sacá la suposición` };
}

function revisar(planTexto, { repo = process.cwd(), raices = null } = {}) {
  if (!conCodigo(planTexto)) return { aplica: false, problemas: [], suposiciones: [] };
  const cuerpo = seccion(planTexto, TITULO);
  if (cuerpo === null) {
    return { aplica: true, suposiciones: [], problemas: [`falta la sección «## ${TITULO}». Agregala con un renglón por cada cosa que el plan da por cierta del código y su archivo:línea, por ejemplo: ${EJEMPLO}`] };
  }
  const lista = renglones(cuerpo);
  if (!lista.length) {
    return { aplica: true, suposiciones: [], problemas: [`la sección «## ${TITULO}» está vacía. Escribí un renglón por cada cosa que el plan da por cierta del código, con su archivo:línea, por ejemplo: ${EJEMPLO}; si no da nada por cierto, «- Ninguna: <por qué>»`] };
  }
  if (lista.length === 1 && NINGUNA.test(lista[0])) return { aplica: true, problemas: [], suposiciones: [] };
  const donde = [...new Set([repo, ...(raices || [])].filter(Boolean).map((r) => path.resolve(r)))];
  const problemas = [];
  const suposiciones = [];
  for (const r of lista) {
    const citas = [...r.matchAll(CITA)];
    if (!citas.length) { problemas.push(`«${r.slice(0, 80)}» no cita dónde lo comprobaste. Sumale su archivo:línea, por ejemplo: ${EJEMPLO}`); continue; }
    const vistas = citas.map((c) => comprobar(c, donde));
    const buena = vistas.find((v) => v.ok);
    if (buena) suposiciones.push({ archivo: buena.archivo, linea: buena.linea, texto: r });
    else problemas.push(vistas[0].problema);
  }
  return { aplica: true, problemas, suposiciones };
}

module.exports = { TITULO, EJEMPLO, revisar, conCodigo, archivosDelPlan };
