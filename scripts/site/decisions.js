'use strict';
// decisions.js — lo que hay que decidir hoy, una ficha por renglón con el lugar exacto donde se decide.
//
// Dos partes, separadas a propósito:
//   · itemsDeLasColas(...) lee, del clon del repo de operaciones, las fichas de cada rubro de la foto diaria de cada
//     cola y el seguimiento que anota cada ficha en inbox/<carpeta>/<estado>/<id>.yaml: su pedido (`pr:`), si se
//     cerró (`pr_cerrado:`), si tiene tareas (`pedidos:`), su gravedad y sus noches. La llama sources.js.
//   · decisiones(m, { operationsRepo }) arma el enlace de cada ficha a SU pedido, con la plataforma que reconoce
//     `remoteOf` de scripts/lib/repo-proposal.js (`/pull/<n>` en GitHub, `/pullrequest/<n>` en la otra). No dibuja
//     nada: el Inicio lo dibuja, y cualquier otra sección lo reusa.
//
// Una ficha sin pedido, o sin una dirección https del repo de operaciones, se lista igual, con `sinLugar` (un código;
// fraseSinLugar lo dice en llano). Nunca se manda a la portada del repo: ahí no se ve qué decidir. Una aceptada con
// su pedido cerrado y sin tareas no muestra ese pedido como su seguimiento: dice que nadie la sigue, y va primero.
// La fuente es una lista abierta ('dependencias', 'vigilante', 'ejecuciones', …): una fuente nueva se lista igual.
//
// Casos: scripts/tests/site-decisions.test.js.

const fs = require('fs');
const path = require('path');

// La carpeta de las fichas de cada fuente en el repo de operaciones, y los rubros de su foto que piden una decisión
const COLAS = Object.freeze({
  dependencias: { carpeta: 'dependencies', rubros: ['nuevos', 'aceptadas_sin_resolver', 'rechazadas_sin_deuda', 'pedidos_cerrados_con_vivas'] },
  vigilante: { carpeta: 'watcher', rubros: ['pendientes', 'aceptadas_sin_story'] },
});
const ESTADOS = ['pending', 'promoted', 'archived'];
const ID_SEGURO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

const esObjeto = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const textoCorto = (x, n = 120) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, n) : null);

/** El título de una ficha, con lo que trae la foto de su cola. */
function tituloDe(fuente, x) {
  if (fuente === 'dependencias') return textoCorto(x.paquete);
  if (fuente === 'vigilante') return [textoCorto(x.producto, 60), textoCorto(x.regla, 60)].filter(Boolean).join(' · ') || null;
  return textoCorto(x.titulo);
}

/**
 * Lo que la ficha `id` anota de su seguimiento, buscada en sus carpetas de estado: { pr, prCerrado, conTarea,
 * severidad, noches }. `pr` es null si no lo anota; `conTarea` dice si su lista `pedidos:` trae alguna tarea. Sin la
 * ficha, todo vacío.
 */
function seguimientoDeLaFicha(clon, carpeta, id, dentroDe) {
  const vacio = { pr: null, prCerrado: false, conTarea: false, severidad: null, noches: null };
  for (const estado of ESTADOS) {
    const archivo = path.join(clon, 'inbox', carpeta, estado, `${id}.yaml`);
    if (!dentroDe(clon, archivo) || !fs.existsSync(archivo)) continue;
    let texto = '';
    try { texto = fs.readFileSync(archivo, 'utf8'); } catch { return vacio; }
    const escalar = (clave) => { const m = texto.match(new RegExp(`^${clave}:[ \\t]*(.*?)[ \\t]*$`, 'm')); return m && m[1] ? m[1].replace(/^["']|["']$/g, '') : null; };
    const pr = /^\d{1,9}$/.test(escalar('pr') || '') ? Number(escalar('pr')) : null;
    // las tareas son los renglones `  - <proyecto>: <n>` que siguen a `pedidos:`, hasta la próxima clave
    const tareas = texto.match(/^pedidos:[ \t]*\n((?:[ \t]+-[^\n]*\n?)*)/m);
    const noches = /^\d{1,4}$/.test(escalar('noches') || '') ? Number(escalar('noches')) : null;
    return { pr, prCerrado: !!escalar('pr_cerrado'), conTarea: !!(tareas && /\d/.test(tareas[1])), severidad: textoCorto(escalar('severidad'), 20), noches };
  }
  return vacio;
}

/**
 * Las fichas de cada rubro de las fotos de las colas: [{ fuente, rubro, id, titulo, pr, prCerrado, conTarea, severidad,
 * noches }]. `fotos` = { dependencias, vigilante }: el documento de la foto de cada una (o null). Un id con forma de
 * ruta no se lee.
 */
function itemsDeLasColas({ clon, fotos, dentroDe }) {
  const items = [];
  for (const [fuente, cola] of Object.entries(COLAS)) {
    const doc = fotos[fuente];
    const rubros = esObjeto(doc) && esObjeto(doc.resumen) && esObjeto(doc.resumen.rubros) ? doc.resumen.rubros : null;
    if (!rubros) continue;
    for (const rubro of cola.rubros) {
      const r = rubros[rubro];
      const valor = esObjeto(r) && Array.isArray(r.valor) ? r.valor : [];
      for (const x of valor) {
        const id = esObjeto(x) ? textoCorto(x.id || x.ficha, 130) : null;
        if (!id || !ID_SEGURO.test(id)) continue;
        items.push({ fuente, rubro, id, titulo: tituloDe(fuente, x), ...seguimientoDeLaFicha(clon, cola.carpeta, id, dentroDe) });
      }
    }
  }
  return items;
}

/**
 * La dirección https navegable del repo de operaciones y su plataforma (la que reconoce remoteOf, la misma lectura de
 * Configuración); null si no es https. Con una plataforma que no reconoce, `plataforma` es null. `remoto`
 * (`{ platform, web }`), si viene, es el remoto ya resuelto y gana sobre remoteOf, como en Configuración
 * (`remotos[repo] || remoteOf(url)`).
 */
function repoNavegable(operationsRepo, remoto = null) {
  let u;
  try { u = new URL(String(operationsRepo || '')); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const r = esObjeto(remoto) ? remoto : require('../lib/repo-proposal.js').remoteOf(String(operationsRepo));
  return { base: r.web ? r.web.replace(/\.git$/, '').replace(/\/+$/, '') : null, plataforma: r.platform || null };
}

// La gravedad, de mayor a menor, con los nombres que puede traer una ficha; una que no se reconoce va después de todas
const GRAVEDADES = Object.freeze(['critical', 'high', 'medium', 'low']);
const SINONIMOS = Object.freeze({ critical: 'critical', critica: 'critical', 'crítica': 'critical', high: 'high', alta: 'high',
  moderate: 'medium', medium: 'medium', media: 'medium', low: 'low', baja: 'low' });
/** La gravedad de una ficha en uno de GRAVEDADES, o null si no se reconoce. */
const gravedadNormal = (s) => (s && Object.hasOwn(SINONIMOS, String(s).toLowerCase()) ? SINONIMOS[String(s).toLowerCase()] : null);
const rangoDeGravedad = (s) => { const g = gravedadNormal(s); return g ? GRAVEDADES.indexOf(g) : GRAVEDADES.length; };

/**
 * El orden de las fichas: primero lo que nadie sigue; después, por gravedad (crítica, alta, media, baja); después, por
 * cuántas noches lleva (más primero); a igualdad, por id, para que el orden no cambie entre noches.
 */
function compararDecisiones(a, b) {
  const nadie = (d) => (d.sinLugar === 'nadie_lo_sigue' ? 0 : 1);
  const noches = (d) => (Number.isInteger(d.noches) ? d.noches : -1);
  return nadie(a) - nadie(b) || rangoDeGravedad(a.severidad) - rangoDeGravedad(b.severidad) || noches(b) - noches(a)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Lo que hay que decidir, con su lugar y en el orden de compararDecisiones: [{ fuente, rubro, id, titulo, pr, enlace,
 * sinLugar, severidad, noches }]. `enlace` es el pedido exacto de la ficha o null; con null, `sinLugar` dice por qué
 * ('sin_repo_https', 'plataforma_desconocida', 'sin_pedido', 'en_su_tarea', 'nadie_lo_sigue'). Sin la lista medida, []
 * (nunca un renglón inventado).
 */
function decisiones(m, { operationsRepo = null, remoto = null } = {}) {
  const d = m && m.decisiones;
  if (!d || d.estado !== 'medido' || !Array.isArray(d.items)) return [];
  const repo = repoNavegable(operationsRepo, remoto);
  return d.items.filter(esObjeto).map((x) => {
    const pr = Number.isInteger(x.pr) && x.pr > 0 ? x.pr : null;
    const aceptada = x.rubro === 'aceptadas_sin_resolver';
    let enlace = null;
    let sinLugar = null;
    // una aceptada ya se decidió: sin pull request, o con el suyo cerrado y una tarea, se sigue en su tarea, en
    // Mantenimiento (la noche no le abre otro). Con el suyo cerrado y ninguna tarea, nadie la sigue: el pull request
    // cerrado no es su seguimiento.
    if (aceptada && pr && x.prCerrado === true && x.conTarea !== true) sinLugar = 'nadie_lo_sigue';
    else if (aceptada && (!pr || x.prCerrado === true)) sinLugar = 'en_su_tarea';
    else if (!repo) sinLugar = 'sin_repo_https';
    else if (!repo.plataforma) sinLugar = 'plataforma_desconocida';
    else if (!pr) sinLugar = 'sin_pedido';
    else enlace = repo.plataforma === 'github' ? `${repo.base}/pull/${pr}` : `${repo.base}/pullrequest/${pr}`;
    return {
      fuente: String(x.fuente || ''), rubro: String(x.rubro || ''), id: String(x.id || ''), titulo: x.titulo || null, pr, enlace, sinLugar,
      severidad: textoCorto(x.severidad, 20), noches: Number.isInteger(x.noches) ? x.noches : null,
    };
  }).sort(compararDecisiones);
}

/** El motivo en llano de un `sinLugar`; `vars` completa el texto (el número del pull request cerrado). */
function fraseSinLugar(codigo, idioma = 'es', vars = undefined) {
  return require('./texts.js').t(idioma, `decidir.${codigo}`, vars);
}

module.exports = { COLAS, itemsDeLasColas, decisiones, compararDecisiones, gravedadNormal, fraseSinLugar, repoNavegable };
