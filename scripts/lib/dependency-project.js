'use strict';
// En qué proyecto vive un repo de la lista de dependencias (scripts/nightly/dependencies/repos.json), por su etiqueta.
// La usan la revisión de dependencias de la noche, para saber a qué proyecto pedirle una tarea, y la pestaña
// Mantenimiento del sitio, para saber si una tarea sigue vigente. Vive acá, y no en la noche, porque el sitio sólo
// trae scripts/lib: si cada uno tuviera su copia, las dos podrían dejar de coincidir sin que nada avise.
const path = require('path');

/** La etiqueta de una entrada: `<producto>/<carpeta>[/<subruta>]`. */
const repoLabel = (r) => `${r.producto}/${path.basename(r.ruta)}${r.subruta ? `/${r.subruta}` : ''}`;

/**
 * La entrada de la lista de una etiqueta. Una carpeta descubierta no está en la lista: es de la entrada npm de la raíz
 * de su repo, y su proyecto es ése. Sin esto, sus pedidos irían a un proyecto inventado.
 */
function entryFor(label, cfg) {
  const repos = (cfg && cfg.repos) || [];
  return repos.find((r) => repoLabel(r) === label)
    || repos.find((r) => r.tipo === 'npm' && !r.subruta && String(label).startsWith(`${repoLabel(r)}/`));
}

/**
 * El proyecto al que se le pide una tarea por ese repo, SÓLO si la lista lo declara; si no, `null`. En GitHub es el
 * repo `<dueño>/<repo>`, donde se abre el issue. El producto no sirve: no es el proyecto, y un pedido a un proyecto
 * inexistente fallaría todas las noches.
 */
function declaredProject(label, cfg) {
  const e = entryFor(label, cfg);
  if (e && !e.ado && e.github) return String(e.github);
  if (!e || !e.ado) return null;
  const crudo = String(e.ado).split('/')[0];
  try { return decodeURIComponent(crudo); } catch { return crudo; }
}

module.exports = { repoLabel, entryFor, declaredProject };
