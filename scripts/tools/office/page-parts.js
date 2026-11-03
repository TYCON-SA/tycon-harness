'use strict';
/*
 * page-parts.js — la página de la oficina y sus módulos, para todos los que la sirven: `office.js` (la foto fija y el
 * proceso local) y la pestaña «Oficinas» del sitio, cuya imagen trae esta carpeta y no `office.js`. Por eso no carga nada
 * de afuera de la carpeta.
 *
 * La página es una sola (`page.html` y `page.js`). Lo que cambia entre una fuente y otra son cuatro marcadores:
 *   · los atributos de <html>: `data-source` (`local`, `site` o `demo`; sin él, la foto fija), `data-token` y `data-site`;
 *   · la barra de arriba, que sólo pone el sitio;
 *   · el mapa de importación: en la foto fija, la librería adentro; en lo demás, una dirección por módulo;
 *   · el código: en la foto fija, adentro; en lo demás, por su dirección.
 * Los datos no se inyectan: llegan por la conexión. Sólo la foto fija, que no tiene de dónde pedirlos, los lleva en un
 * bloque que el navegador no ejecuta.
 */
const fs = require('fs');
const path = require('path');

const TEMPLATE = path.join(__dirname, 'page.html');
const CODE = path.join(__dirname, 'page.js');
const VENDOR = path.join(__dirname, 'vendor', 'three');

// Los módulos de la librería que usa la escena, con el nombre con que se importan. Los archivos están copiados sin
// cambios en una sola carpeta (`extras/`); el nombre con que se importan conserva la ruta original de la librería, que
// es contra la que se resuelven sus importaciones relativas.
const MODULES = {
  three: 'three.module.min.js',
  'three/addons/controls/OrbitControls.js': 'extras/OrbitControls.js',
  'three/addons/geometries/RoundedBoxGeometry.js': 'extras/RoundedGeometry.js',
  'three/addons/postprocessing/EffectComposer.js': 'extras/EffectComposer.js',
  'three/addons/postprocessing/RenderPass.js': 'extras/RenderPass.js',
  'three/addons/postprocessing/UnrealBloomPass.js': 'extras/UnrealBloomPass.js',
  'three/addons/postprocessing/OutputPass.js': 'extras/OutputPass.js',
  'three/addons/postprocessing/Pass.js': 'extras/Pass.js',
  'three/addons/postprocessing/ShaderPass.js': 'extras/ShaderPass.js',
  'three/addons/postprocessing/MaskPass.js': 'extras/MaskPass.js',
  'three/addons/shaders/CopyShader.js': 'extras/CopyShader.js',
  'three/addons/shaders/LuminosityHighPassShader.js': 'extras/LuminosityHighPassShader.js',
  'three/addons/shaders/OutputShader.js': 'extras/OutputShader.js',
};

// Un módulo de la librería con sus importaciones relativas cambiadas por el nombre con que figura en MODULES: un
// módulo que viene de una dirección `data:` no tiene carpeta contra la cual resolverlas.
function moduleSource(key, rel) {
  const src = fs.readFileSync(path.join(VENDOR, rel), 'utf8');
  if (key === 'three') return src;
  const dir = path.posix.dirname(key);
  return src.replace(/(from\s*|import\s*)(['"])(\.{1,2}\/[^'"]+)\2/g, (all, kw, q, spec) => `${kw}${q}${path.posix.normalize(path.posix.join(dir, spec))}${q}`);
}

/** El mapa de importación: cada módulo en la dirección que diga `urlOf(clave)`; sin ella, la librería adentro. */
function importMap(urlOf = null) {
  const imports = {};
  for (const [key, rel] of Object.entries(MODULES)) {
    imports[key] = urlOf ? urlOf(key) : `data:text/javascript;base64,${Buffer.from(moduleSource(key, rel)).toString('base64')}`;
  }
  return JSON.stringify({ imports }).replace(/</g, '\\u003c');
}

const escapeAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * La página entera. `source`: `local`, `site` o `demo`; sin él, la foto fija, con `data` y el código adentro. `token`: el
 * del proceso local. `site`: el enlace al sitio. `urlOf` y `script`: dónde se piden los módulos y el código. `bar`: la
 * barra del sitio, ya escapada por quien la arma.
 */
function renderPage({ data = null, source = null, token = null, site = null, urlOf = null, script = null, bar = '' } = {}) {
  const attrs = [source && `data-source="${escapeAttr(source)}"`, token && `data-token="${escapeAttr(token)}"`, site && `data-site="${escapeAttr(site)}"`].filter(Boolean).join(' ');
  const fixed = !source;
  const code = fixed
    ? `<script>${fs.readFileSync(CODE, 'utf8').replace(/<\/script/gi, '<\\/script')}</script>`
    : `<script src="${escapeAttr(script)}"></script>`;
  const block = fixed ? `<script type="application/json" id="officeData">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>` : '';
  // con funciones de reemplazo y en este orden: un texto de los datos que diga el nombre de un marcador no lo reemplaza
  return fs.readFileSync(TEMPLATE, 'utf8')
    .replace('__OFFICE_ATTRS__', () => attrs)
    .replace('__OFFICE_BAR__', () => bar)
    .replace('__OFFICE_IMPORTMAP__', () => importMap(fixed ? null : urlOf))
    .replace('__OFFICE_CODE__', () => code)
    .replace('__OFFICE_DATA_BLOCK__', () => block);
}

module.exports = { MODULES, moduleSource, importMap, renderPage, TEMPLATE, CODE };
