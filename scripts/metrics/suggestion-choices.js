#!/usr/bin/env node
'use strict';
if (require.main === module) { try { require('../lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/*
 * suggestion-choices.js — ¿LA PERSONA ELIGIÓ LA OPCIÓN QUE SUGERÍA EL AGENTE?
 *
 * Medido al comparar dos planificaciones: 53 de 57 decisiones las había propuesto el agente, y la persona las aceptó.
 * Nadie lo sabía hasta contarlas a mano. Esto las cuenta desde la conversación de Claude Code (regla 12.4 de
 * workflow-orchestration.md, historia 8.324).
 *
 * Cada cuadro de opciones (`AskUserQuestion`) es una llamada con sus preguntas; la respuesta llega en el renglón que trae
 * su `tool_result`, en `toolUseResult.answers` (pregunta → opción elegida). Una opción es la sugerida si su texto termina
 * en «(Recommended)», «(Recomendado)» o «(Recomendada)». Por cada pregunta:
 *   · sin opción sugerida → cuenta en `cuadros`, no en `con_sugerencia`;
 *   · con sugerida y la respuesta es esa → `eligio_sugerencia`;
 *   · con sugerida y la respuesta es otra opción o un texto libre («Other») → `otra`;
 *   · con sugerida y sin respuesta (el cuadro se cortó o se negó) → `sin_respuesta`: cuenta en `con_sugerencia`, pero ni
 *     como elegida ni como otra.
 * Lo que se responde fuera de un cuadro, escrito en el chat, no se cuenta.
 *
 * Uso: suggestion-choices.js --transcript <conversación.jsonl> [--json]
 * Sale 0 con la cuenta; 2 si la conversación no se puede leer (nunca una cuenta en cero).
 * Casos: scripts/tests/suggestion-choices.test.js
 */
const fs = require('fs');

const SUGERIDA = /\((Recommended|Recomendad[oa])\)\s*$/i;

// Sólo los renglones de la conversación: Claude Code guarda además copias del pedido a la API (`api-request-blob`, sin
// `toolUseResult`) que repiten cuadros y respuestas; contarlas duplicaría cuadros y pisaría respuestas con nada.
const TIPOS = new Set(['user', 'assistant']);
const contenidoDe = (o) => (o && TIPOS.has(o.type) && o.message && Array.isArray(o.message.content) ? o.message.content : []);

/**
 * La respuesta de un cuadro de varias opciones: las etiquetas elegidas, como lista o unidas por «, ». Una etiqueta puede
 * llevar «, » adentro: se reconoce primero la etiqueta conocida más larga que empieza ahí, y si ninguna, hasta la coma.
 */
function elegidas(v, labels) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).sort();
  const porLargo = [...labels].sort((a, b) => b.length - a.length);
  const out = [];
  let resto = String(v);
  while (resto) {
    const l = porLargo.find((x) => x && (resto === x || resto.startsWith(`${x}, `)));
    const k = l ? l.length : (resto.indexOf(', ') < 0 ? resto.length : resto.indexOf(', '));
    out.push(resto.slice(0, k).trim());
    resto = resto.slice(k).replace(/^, /, '');
  }
  return out.filter(Boolean).sort();
}

/**
 * La cuenta sobre los renglones ya leídos. `cuadrosDe` (opcional): los renglones donde se buscan las llamadas, por ejemplo
 * el tramo de una corrida; las respuestas se buscan siempre en todos los renglones, aunque caigan fuera del tramo. Cada
 * cuadro cuenta una vez, y una respuesta ya encontrada no la pisa otro renglón sin respuesta.
 */
function contar(lineas, cuadrosDe = lineas) {
  const respuestas = new Map();
  for (const o of lineas) {
    for (const it of contenidoDe(o)) {
      if (it && it.type === 'tool_result' && it.tool_use_id) {
        const answers = o.toolUseResult && typeof o.toolUseResult === 'object' && o.toolUseResult.answers && typeof o.toolUseResult.answers === 'object'
          ? o.toolUseResult.answers : null;
        if (answers || !respuestas.has(it.tool_use_id)) respuestas.set(it.tool_use_id, answers);
      }
    }
  }
  const out = { cuadros: 0, con_sugerencia: 0, eligio_sugerencia: 0, otra: 0, sin_respuesta: 0, cuadros_detalle: [] };
  const vistos = new Set();
  for (const o of cuadrosDe) {
    for (const it of contenidoDe(o)) {
      if (!it || it.type !== 'tool_use' || it.name !== 'AskUserQuestion') continue;
      if (it.id) { if (vistos.has(it.id)) continue; vistos.add(it.id); }
      const preguntas = it.input && Array.isArray(it.input.questions) ? it.input.questions : [];
      const answers = respuestas.has(it.id) ? respuestas.get(it.id) : null;
      for (const q of preguntas) {
        if (!q || typeof q.question !== 'string') continue;
        out.cuadros += 1;
        const labels = (Array.isArray(q.options) ? q.options : []).map((x) => String((x && x.label) || ''));
        const sugeridas = labels.filter((l) => SUGERIDA.test(l));
        const crudo = answers && Object.prototype.hasOwnProperty.call(answers, q.question) ? answers[q.question] : null;
        const elegida = crudo === null || crudo === undefined ? null : (Array.isArray(crudo) ? crudo.join(', ') : String(crudo));
        if (!sugeridas.length) continue;
        out.con_sugerencia += 1;
        const sugerida = sugeridas.join(', ');
        if (elegida === null) { out.sin_respuesta += 1; continue; }
        // de varias opciones: coincide si eligió exactamente las sugeridas, en cualquier orden
        const coincide = q.multiSelect ? JSON.stringify(elegidas(crudo, labels)) === JSON.stringify([...sugeridas].sort()) : elegida === sugeridas[0];
        if (coincide) out.eligio_sugerencia += 1; else out.otra += 1;
        out.cuadros_detalle.push({ pregunta: q.question, sugerida, elegida, coincide });
      }
    }
  }
  return out;
}

/** Lee la conversación: `{ lineas, ilegibles }` o `{ error }`. */
function leer(ruta) {
  let crudo;
  try { crudo = fs.readFileSync(ruta, 'utf8'); } catch (e) { return { error: `no pude leer la conversación ${ruta}: ${e.code || e.message}` }; }
  const lineas = [];
  let ilegibles = 0;
  for (const l of crudo.split('\n')) {
    if (!l.trim()) continue;
    try { lineas.push(JSON.parse(l)); } catch (_e) { ilegibles += 1; }
  }
  return { lineas, ilegibles };
}

function main(argv) {
  const i = argv.indexOf('--transcript');
  const ruta = i >= 0 ? argv[i + 1] : null;
  if (!ruta) { process.stderr.write('uso: suggestion-choices.js --transcript <conversación.jsonl> [--json]\n'); return 2; }
  const leido = leer(ruta);
  if (leido.error) { process.stderr.write(`suggestion-choices: ${leido.error}\n`); return 2; }
  const c = { ...contar(leido.lineas), lineas_ilegibles: leido.ilegibles };
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(c, null, 2)}\n`);
  else {
    process.stdout.write(`${c.con_sugerencia} cuadro(s) con sugerencia: la persona eligió la sugerida en ${c.eligio_sugerencia} y otra en ${c.otra}`
      + `${c.sin_respuesta ? `; ${c.sin_respuesta} sin respuesta` : ''} (de ${c.cuadros} pregunta(s) en total)\n`);
    if (c.lineas_ilegibles) process.stdout.write(`(${c.lineas_ilegibles} renglón(es) de la conversación no se pudieron leer)\n`);
  }
  return 0;
}

module.exports = { contar, leer, SUGERIDA };

if (require.main === module) process.exit(main(process.argv.slice(2)));
