'use strict';
/**
 * report-name.js —de qué se llama el reporte de una corrida del examen de revisores.
 *
 * ── EL AGUJERO QUE CIERRA ───────────────────────────────────────────────────────────────────────
 * `advisor-runner.js` derivaba el nombre de su reporte SÓLO de `--tool`. O sea que una corrida
 * acotada a 3 revisores (`--only`) escribía en el MISMO archivo que la foto completa de los 28 y
 * la pisaba — y el aviso del arranque leía ese archivo fresco con 3 casos y lo mostraba como el
 * estado general. Los otros 25 desaparecían sin que nada lo dijera.
 *
 * El arreglo tenía que ser MECÁNICO: la salida legítima era "acordate de pasar `--json`", y un
 * control que depende de que alguien se acuerde es un control que no corre. Acá el alcance de la
 * corrida DECIDE el nombre; no hay forma de pisar la foto completa sin pedirlo explícitamente.
 *
 * ── POR QUÉ ES UN ARCHIVO APARTE ────────────────────────────────────────────────────────────────
 * `advisor-runner.js` no tiene guarda `require.main === module`: requerirlo ARRANCA el banco
 * completo de los 28 revisores (el mismo gotcha que hace que `advisor-runner.js --help` dispare
 * una corrida entera). Así que la lógica que hay que poder probar barato vive acá, donde un test
 * puede requerirla sin gastar una sola llamada al modelo.
 */
const crypto = require('crypto');

/** Sólo letras, números y guiones: lo que entra viene de la línea de comandos. */
const limpiar = (s) => String(s || '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();

/**
 * 🔴 `prefijo` (2026-09-01): el mismo agujero existía en `runner.js`, el banco determinista —una
 * corrida `--only` pisaba `last-run-<tool>.json`, la foto de los 86 casos, y el aviso del arranque
 * mostraba esos pocos como el estado general—. Se reprodujo en vivo al escribir los casos de la
 * revisión nocturna de dependencias. Arreglarlo copiando esta lógica allá habría creado la segunda
 * copia del mismo criterio; se parametriza el prefijo y sigue habiendo un solo lugar donde el
 * ALCANCE de una corrida decide el nombre de su reporte.
 *
 * @param {{tool: string, only: string[], vida?: boolean, prefijo?: string}} corrida
 * @returns {{nombre: string, alcance: 'completo'|'acotado'|'vida'}}
 */
function nombreDeReporte({ tool, only, vida, prefijo }) {
  const herramienta = limpiar(tool) || 'desconocida';
  const pre = limpiar(prefijo) || 'advisors';
  const lista = (only || []).map((x) => String(x || '').trim()).filter(Boolean);
  // 🔴 El chequeo de vida tiene su PROPIO archivo (2026-09-01). Corre sólo el par canario de cada
  // revisor: si escribiera en `advisors-<tool>.json`, el aviso de arranque leería una foto de 53
  // casos como si fuera el estado de los 99 — exactamente el fallo que este módulo nació para
  // evitar con `--only`, pero peor, porque el chequeo de vida va a correr seguido y la foto
  // completa cada vez menos.
  if (vida) {
    const acotado = lista.length ? `-${limpiar(lista.slice().sort().join('-')).slice(0, 24)}` : '';
    return { nombre: `vida-${herramienta}${acotado}.json`, alcance: 'vida' };
  }
  if (lista.length === 0) {
    // El nombre HISTÓRICO no cambia: todo lo que ya lee `<prefijo>-<tool>.json` sigue andando.
    return { nombre: `${pre}-${herramienta}.json`, alcance: 'completo' };
  }
  // Legible para el humano que mira la carpeta + huella para que dos alcances distintos nunca
  // compartan archivo (el recorte a 40 caracteres, solo, sí podría colisionar).
  const legible = limpiar(lista.slice().sort().join('-')).slice(0, 40).replace(/-+$/, '');
  const huella = crypto.createHash('sha1').update(lista.slice().sort().join(',')).digest('hex').slice(0, 8);
  return { nombre: `${pre}-${herramienta}-parcial-${legible}-${huella}.json`, alcance: 'acotado' };
}

module.exports = { nombreDeReporte };
