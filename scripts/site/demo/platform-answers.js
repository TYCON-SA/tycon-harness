'use strict';
/*
 * demo/platform-answers.js —LA PLATAFORMA DE EJEMPLO DEL SITIO DEMO.
 *
 * El núcleo del sitio no nombra ninguna nube (scripts/site/cloud/ es el único lugar): lo que el sitio demo contesta de
 * adentro del proceso en lugar de preguntarle a la plataforma —sus direcciones, sus repos, sus pipelines, sus campos— lo
 * trae la nube que lo declara (`plataformaDeEjemplo`), igual que el buzón o la identidad. Este módulo la busca.
 */
const fs = require('fs');
const path = require('path');

let hallada = null;
/** La plataforma de ejemplo de la primera nube de cloud/ que la trae. Tira si ninguna (el sitio demo no puede armarse sin ella). */
function plataformaDeEjemplo() {
  if (hallada) return hallada;
  const dir = path.join(__dirname, '..', 'cloud');
  for (const f of fs.readdirSync(dir).filter((x) => /^[a-z][a-z0-9-]*\.js$/.test(x)).sort()) {
    const m = require(path.join(dir, f));
    if (m && m.plataformaDeEjemplo) { hallada = m.plataformaDeEjemplo; return hallada; }
  }
  throw new Error('ninguna nube de cloud/ trae la plataforma de ejemplo del sitio demo');
}

module.exports = { plataformaDeEjemplo };
