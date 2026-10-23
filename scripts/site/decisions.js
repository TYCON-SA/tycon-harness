'use strict';
// decisions.js — lo que hay que decidir hoy, una ficha por renglón con el lugar exacto donde se decide.
//
// Dos partes, separadas a propósito:
//   · itemsDeLasColas(...) lee, del clon del repo de operaciones, las fichas de cada rubro de la foto diaria de cada
//     cola y el pedido que anota cada ficha (`pr:` en inbox/<carpeta>/<estado>/<id>.yaml). La llama sources.js.
//   · decisiones(m, { operationsRepo }) arma el enlace de cada ficha a SU pedido, con la plataforma que reconoce
//     `remoteOf` de scripts/lib/repo-proposal.js (`/pull/<n>` en GitHub, `/pullrequest/<n>` en la otra). No dibuja
//     nada: el Inicio lo dibuja, y cualquier otra sección lo reusa.
//
// Una ficha sin pedido, o sin una dirección https del repo de operaciones, se lista igual, con `sinLugar` (un código;
// fraseSinLugar lo dice en llano). Nunca se manda a la portada del repo: ahí no se ve qué decidir.
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

/** El `pr:` de la ficha `id`, buscada en sus carpetas de estado; null si no lo anota o no está. */
function pedidoDeLaFicha(clon, carpeta, id, dentroDe) {
  for (const estado of ESTADOS) {
    const archivo = path.join(clon, 'inbox', carpeta, estado, `${id}.yaml`);
    if (!dentroDe(clon, archivo) || !fs.existsSync(archivo)) continue;
    let texto = '';
    try { texto = fs.readFileSync(archivo, 'utf8'); } catch { return null; }
    const m = texto.match(/^pr:\s*(\d{1,9})\s*$/m);
    return m ? Number(m[1]) : null;
  }
  return null;
}

/**
 * Las fichas de cada rubro de las fotos de las colas: [{ fuente, rubro, id, titulo, pr }]. `fotos` = { dependencias,
 * vigilante }: el documento de la foto de cada una (o null). Un id con forma de ruta no se lee.
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
        items.push({ fuente, rubro, id, titulo: tituloDe(fuente, x), pr: pedidoDeLaFicha(clon, cola.carpeta, id, dentroDe) });
      }
    }
  }
  return items;
}

/**
 * La dirección https navegable del repo de operaciones y su plataforma (la que reconoce remoteOf, la misma lectura de
 * Configuración); null si no es https. Con una plataforma que no reconoce, `plataforma` es null.
 */
function repoNavegable(operationsRepo) {
  let u;
  try { u = new URL(String(operationsRepo || '')); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const r = require('../lib/repo-proposal.js').remoteOf(String(operationsRepo));
  return { base: r.web ? r.web.replace(/\.git$/, '').replace(/\/+$/, '') : null, plataforma: r.platform || null };
}

/**
 * Lo que hay que decidir, con su lugar: [{ fuente, rubro, id, titulo, pr, enlace, sinLugar }]. `enlace` es el pedido
 * exacto de la ficha o null; con null, `sinLugar` dice por qué ('sin_repo_https', 'plataforma_desconocida',
 * 'sin_pedido'). Sin la lista medida, [] (nunca un renglón inventado).
 */
function decisiones(m, { operationsRepo = null } = {}) {
  const d = m && m.decisiones;
  if (!d || d.estado !== 'medido' || !Array.isArray(d.items)) return [];
  const repo = repoNavegable(operationsRepo);
  return d.items.filter(esObjeto).map((x) => {
    const pr = Number.isInteger(x.pr) && x.pr > 0 ? x.pr : null;
    let enlace = null;
    let sinLugar = null;
    if (!repo) sinLugar = 'sin_repo_https';
    else if (!repo.plataforma) sinLugar = 'plataforma_desconocida';
    else if (!pr) sinLugar = 'sin_pedido';
    else enlace = repo.plataforma === 'github' ? `${repo.base}/pull/${pr}` : `${repo.base}/pullrequest/${pr}`;
    return { fuente: String(x.fuente || ''), rubro: String(x.rubro || ''), id: String(x.id || ''), titulo: x.titulo || null, pr, enlace, sinLugar };
  });
}

/** El motivo en llano de un `sinLugar`. */
function fraseSinLugar(codigo, idioma = 'es') {
  return require('./texts.js').t(idioma, `decidir.${codigo}`);
}

module.exports = { COLAS, itemsDeLasColas, decisiones, fraseSinLugar, repoNavegable };
