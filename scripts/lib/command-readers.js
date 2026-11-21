'use strict';
/**
 * scripts/lib/command-readers.js — el lector de los comandos de una plataforma, pedido por el programa que lee.
 *
 * Los frenos y los avisos que leen un comando de terminal de una plataforma (qué publica, a qué repo va, qué parte no se
 * puede leer) no cargan el lector por su ruta: lo trae el conector de esa plataforma, en
 * `integrations/<conector>/scripts/command-reader.js`, y declara en `programas` qué programas lee. El núcleo lo busca
 * por el programa.
 *
 *   lectorDe(programa)    el lector; si ningún conector lo trae, un error (quien lo usa decide qué hace con «no pude
 *                         leer», igual que cuando el archivo faltaba).
 *   buscarLector(programa) el lector o `null`: para un hook que viaja suelto y calla sin lector.
 * `{ raiz }` cambia el árbol donde se buscan los conectores (por defecto, el de este archivo).
 */
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..');
const cache = new Map();

function lectoresDe(raiz) {
  if (cache.has(raiz)) return cache.get(raiz);
  const lectores = [];
  let conectores = [];
  try { conectores = fs.readdirSync(path.join(raiz, 'integrations')).sort(); } catch { /* sin conectores: ningún lector */ }
  for (const c of conectores) {
    const f = path.join(raiz, 'integrations', c, 'scripts', 'command-reader.js');
    if (fs.existsSync(f)) lectores.push(f);
  }
  cache.set(raiz, lectores);
  return lectores;
}

function buscarLector(programa, { raiz = RAIZ } = {}) {
  for (const f of lectoresDe(raiz)) {
    const lector = require(f);
    if (Array.isArray(lector.programas) && lector.programas.includes(programa)) return lector;
  }
  return null;
}

function lectorDe(programa, opciones) {
  const lector = buscarLector(programa, opciones);
  if (!lector) throw new Error(`no hay lector de comandos para ${programa}: ningún conector trae scripts/command-reader.js con ese programa`);
  return lector;
}

module.exports = { lectorDe, buscarLector };
