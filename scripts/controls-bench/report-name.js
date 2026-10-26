'use strict';
/**
 * report-name.js — de qué se llama el reporte de una corrida del examen de revisores.
 *
 * ── EL AGUJERO QUE CIERRA ───────────────────────────────────────────────────────────────────────
 * Si el nombre del reporte saliera SÓLO de `--tool`, una corrida acotada a 3 revisores (`--only`) escribiría en
 * el MISMO archivo que la foto completa de los 28 y la pisaría: el aviso del arranque leería ese archivo fresco con 3
 * casos y lo mostraría como el estado general. Los otros 25 desaparecerían sin que nada lo dijera.
 *
 * El arreglo es MECÁNICO: "acordate de pasar `--json`" depende de que alguien se acuerde, y un control así no corre.
 * Acá el alcance de la corrida DECIDE el nombre; no hay forma de pisar la foto completa sin pedirlo explícitamente.
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
 * 🔴 `prefijo`: `runner.js`, el banco determinista, tiene el mismo agujero —una corrida `--only` pisaría
 * `last-run-<tool>.json`, la foto de todos sus casos, y el aviso del arranque mostraría esos pocos como el estado
 * general—. Copiar esta lógica allá crearía una segunda copia del mismo criterio; se parametriza el prefijo y hay un
 * solo lugar donde el ALCANCE de una corrida decide el nombre de su reporte.
 *
 * 🔴 `modelo`: una corrida con otro modelo que el de cada revisor (`--model`) es una comparación, no el estado de los
 * revisores. Con el nombre de siempre pisaría la foto completa, la de vida o la acotada del mismo `--only`, y el aviso
 * del arranque mostraría los rojos de otro modelo como los del equipo. Va siempre a un archivo `-parcial-`, que el aviso
 * ya trata como complementario, con el modelo y el alcance en el nombre.
 *
 * @param {{tool: string, only: string[], vida?: boolean, prefijo?: string, modelo?: string|null}} corrida
 * @returns {{nombre: string, alcance: 'completo'|'acotado'|'vida'|'modelo'}}
 */
function nombreDeReporte({ tool, only, vida, prefijo, modelo }) {
  const herramienta = limpiar(tool) || 'desconocida';
  const pre = limpiar(prefijo) || 'advisors';
  const lista = (only || []).map((x) => String(x || '').trim()).filter(Boolean);
  if (modelo) {
    const m = limpiar(modelo) || 'desconocido';
    const alcance = [vida ? 'vida' : '', ...lista.slice().sort()].filter(Boolean);
    const legible = limpiar(alcance.join('-')).slice(0, 32).replace(/-+$/, '');
    const huella = crypto.createHash('sha1').update(`${m}|${alcance.join(',')}`).digest('hex').slice(0, 8);
    return { nombre: `${pre}-${herramienta}-parcial-modelo-${m}${legible ? `-${legible}` : ''}-${huella}.json`, alcance: 'modelo' };
  }
  // 🔴 El chequeo de vida tiene su PROPIO archivo. Corre sólo el par canario de cada revisor: si escribiera en
  // `advisors-<tool>.json`, el aviso de arranque leería esa foto parcial como si fuera el estado completo — el mismo
  // fallo que `--only`, pero peor, porque el chequeo de vida corre seguido y la foto completa cada vez menos.
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
