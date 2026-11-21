'use strict';
/**
 * scripts/lib/command-readers.js — el lector de los comandos de una plataforma, pedido por el programa que lee.
 *
 * Los frenos y los avisos que leen un comando de terminal de una plataforma (qué publica, a qué repo va, qué parte no se
 * puede leer) no cargan el lector por su ruta: lo trae el conector de esa plataforma, en
 * `integrations/<conector>/scripts/command-reader.js`, y declara en `programas` qué programas lee. El núcleo lo busca
 * por el programa.
 *
 *   lectorDe(programa)    el lector; si no hay uno solo que se pueda usar, un error (quien lo usa decide qué hace con
 *                         «no pude leer», igual que cuando el archivo faltaba).
 *   buscarLector(programa) el lector o `null`, sin tirar nunca: para un hook que viaja suelto y calla sin lector.
 * `{ raiz }` cambia el árbol donde se buscan los conectores (por defecto, el de este archivo).
 */
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..');
const cache = new Map();

// 🔴 No se elige a ciegas: los frenos leen el comando con este lector. Si un lector no se pudo cargar (no se sabe qué
// programas leía) o dos conectores dicen leer el mismo programa, ninguno gana — el orden de las carpetas decidiría
// cuál frena. `lectorDe` lo dice como error (el freno cae en su «no pude leer», y frena) y `buscarLector` devuelve null.
function lectoresDe(raiz) {
  if (cache.has(raiz)) return cache.get(raiz);
  const lectores = [];
  let conectores = [];
  try { conectores = fs.readdirSync(path.join(raiz, 'integrations')).sort(); } catch { /* sin conectores: ningún lector */ }
  for (const conector of conectores) {
    const f = path.join(raiz, 'integrations', conector, 'scripts', 'command-reader.js');
    if (!fs.existsSync(f)) continue;
    try { lectores.push({ conector, lector: require(f) }); }
    catch (e) { lectores.push({ conector, error: String((e && e.message) || e).slice(0, 120) }); }
  }
  cache.set(raiz, lectores);
  return lectores;
}

/** `{ lector }` o `{ motivo }`: por qué no hay uno solo que se pueda usar. */
function elegir(programa, { raiz = RAIZ } = {}) {
  const lectores = lectoresDe(raiz);
  const rotos = lectores.filter((x) => x.error);
  if (rotos.length) return { motivo: `no se pudo cargar el lector de comandos de ${rotos.map((x) => `${x.conector} (${x.error})`).join(', ')}: no se sabe cuál lee ${programa}` };
  const suyos = lectores.filter((x) => x.lector && Array.isArray(x.lector.programas) && x.lector.programas.includes(programa));
  if (suyos.length > 1) return { motivo: `más de un lector de comandos para ${programa} (${suyos.map((x) => x.conector).join(', ')}): ninguno tapa al otro` };
  if (!suyos.length) return { motivo: `no hay lector de comandos para ${programa}: ningún conector trae scripts/command-reader.js con ese programa` };
  return { lector: suyos[0].lector };
}

function buscarLector(programa, opciones) {
  return elegir(programa, opciones).lector || null;
}

function lectorDe(programa, opciones) {
  const r = elegir(programa, opciones);
  if (!r.lector) throw new Error(r.motivo);
  return r.lector;
}

module.exports = { lectorDe, buscarLector };
