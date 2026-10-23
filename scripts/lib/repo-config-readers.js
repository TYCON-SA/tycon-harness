'use strict';
/*
 * repo-config-readers.js — dónde vive el lector de cada clave de `.tycon/advisors.yaml` que el sitio edita por repo.
 *
 * La sección por repo de la pestaña Configuración (scripts/lib/org-config.js, CLAVES_DEL_REPO) nombra cada lector por un
 * nombre corto; este archivo lo resuelve a la biblioteca del pipeline, que viaja en la imagen del sitio. Así el núcleo
 * del sitio no nombra carpetas del arnés. Un lector que esta versión no trae devuelve null.
 */
const fs = require('fs');
const path = require('path');

/**
 * El archivo de configuración del arnés en cada repo, relativo a su raíz. El arnés acepta también `.yml` y lee primero
 * `.yaml` (`lib/config-source.js`, NOMBRES): `ARCHIVOS` va en ese orden.
 */
const ARCHIVO = '.tycon/advisors.yaml';
const ARCHIVOS = Object.freeze([ARCHIVO, '.tycon/advisors.yml']);
const PIPELINE_LIB = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib');
const RUTAS = Object.freeze({ deprecated: path.join(PIPELINE_LIB, 'deprecated.js') });

/** El módulo del lector `nombre`, o null si no existe en este árbol. */
function lectorDeClave(nombre) {
  const f = Object.prototype.hasOwnProperty.call(RUTAS, nombre) ? RUTAS[nombre] : null;
  if (!f || !fs.existsSync(f)) return null;
  return require(f);
}

module.exports = { lectorDeClave, RUTAS, ARCHIVO, ARCHIVOS };
