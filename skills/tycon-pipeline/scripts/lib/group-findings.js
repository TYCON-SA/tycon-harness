#!/usr/bin/env node
/**
 * group-findings.js — junta los hallazgos del pase adversarial que son EL MISMO problema, para
 * pagar una verificación por problema y no una por hallazgo.
 *
 * 🔴 Sin agrupar se paga de más: en una corrida medida, el pase abrió 25 agentes y 2.668.124 tokens.
 *    Seis cazadores reportaron 19 hallazgos que eran 9 problemas distintos — el mismo defecto
 *    visto por varias lentes, con otra redacción, y cada copia se lleva su propio verificador.
 *
 * 🔴 EL CRITERIO ES CONSERVADOR A PROPÓSITO. Separar de más cuesta un agente. Juntar de más PIERDE
 *    un defecto real y nadie se entera, porque el pase sale igual de verde. Ante cualquier duda,
 *    separa — y deja la duda registrada (`dudas`) para poder calibrarlo con datos en vez de a ojo.
 *
 * Qué NO hace, por diseño: **no agrupa por parecido de
 * texto del resumen**. Dos defectos distintos se describen parecido, y el mismo defecto se describe
 * distinto según la lente. Se agrupa por SITIO (archivo + línea declarada) y se veta por SÍNTOMA;
 * el texto sólo aporta los identificadores de código y la categoría de síntoma, que son señales
 * discretas, no distancia entre cadenas.
 *
 * 🔴 LA REGLA MADRE: para JUNTAR hace falta una señal POSITIVA de que son el mismo defecto.
 * Juntar por ausencia de señal de que fueran distintos haría depender el criterio de un vocabulario de
 * síntomas sacado de UN solo archivo: en cualquier otro repo ninguna descripción caería en esas
 * categorías, el veto quedaría inerte y «mismo archivo + misma línea» fundiría cualquier par de bugs no
 * relacionados, sin dejar siquiera una duda registrada.
 *
 * Las reglas, completas:
 *   1. Distinto archivo → nunca se juntan.
 *   2. Veto por síntoma: si los dos tienen síntoma reconocido y no comparten ninguno → separados.
 *   3. Misma línea declarada → se juntan SÓLO si además comparten síntoma o identificador de código.
 *      El sitio solo no alcanza: dos defectos distintos conviven en la misma línea todo el tiempo.
 *   4. Líneas distintas → NO (aunque compartan símbolos: compartir un símbolo como `measure()` junta
 *      defectos distintos que sólo pasan por la misma función).
 *   5. Los dos sin línea declarada → hacen falta LAS DOS señales: identificador distintivo Y
 *      síntoma compartido. Compartir el nombre de la función que los contiene no prueba nada.
 *   6. Uno con línea y el otro sin → no hay con qué compararlos → separados.
 *   7. Una clase es un CLIQUE: un hallazgo entra sólo si es compatible con TODOS los miembros, no
 *      con uno. Sin esto, A-B y B-C arrastran a C junto a A sin que nadie los haya comparado.
 *
 * Apagado: no lo decide este módulo. Lo decide quien lo llama (el pase mira `TYCON_5B_GROUP`).
 */

'use strict';

// ===== NUCLEO-AGRUPAR: INICIO =====
// 🔴 Este bloque está COPIADO LITERAL dentro de adversarial-verify.workflow.js: el pase corre en
// una caja sin `require`, así que no puede importarlo. `tests/test-group-findings.js` compara las
// dos copias carácter por carácter y se pone rojo si se separan: es el defecto de una lista
// duplicada y desincronizada.
// Para re-sincronizar: node lib/group-findings.js --emit-core > /tmp/n.js y pegarlo.
// Categorías de síntoma. Cerradas a propósito: una lista abierta se vuelve parecido de texto con
// otro nombre. Cada una se reconoce por marcas de CÓDIGO (identificadores, operadores, literales),
// no por adjetivos. Un hallazgo puede caer en varias; se comparan como conjuntos.
const SINTOMAS = [
  ['exports', /module\.exports|require\.main|process\.exit|inalcanzable/i],
  ['exencion', /lectura-entera-ok|marcaExencion|exenci[oó]n/i],
  ['heredoc', /heredoc|<<-?\s*['"]?[A-Z]/],
  ['redireccion', /2>&1|2>\/dev\/null|stderr|redirecci[oó]n de salida|>>?\\?s/i],
  ['offset', /offset/i],
  ['conteo', /acotad[ao]s?\b|CONFIG\.acotadores|contador|--report/i],
  ['comentario', /comentario/i],
  ['nombre-archivo', /archivoDe|nombre del archivo|paths? entre comillas/i],
];

// Palabras que parecen identificadores pero no distinguen nada.
const GENERICOS = new Set([
  'null', 'true', 'false', 'undefined', 'string', 'number', 'object', 'array', 'function', 'return',
  'console', 'error', 'value', 'result', 'archivo', 'comando', 'linea', 'texto', 'prueba',
]);

function texto(h) {
  return `${(h && h.summary) || ''}\n${(h && h.repro) || ''}`;
}

/** Las categorías de síntoma que se reconocen en un hallazgo. Conjunto, posiblemente vacío. */
function sintomasDe(h) {
  const t = texto(h);
  const out = new Set();
  for (const [nombre, re] of SINTOMAS) if (re.test(t)) out.add(nombre);
  return out;
}

/**
 * Identificadores de código nombrados en el texto: `entre backticks`, `foo(`, `CONFIG.algo` y
 * camelCase. NO son palabras del idioma: son los nombres que el código usa de verdad.
 */
function simbolosDe(h) {
  const t = texto(h);
  const out = new Set();
  const agregar = (s) => {
    const v = String(s || '').replace(/[^A-Za-z0-9_.]/g, '');
    if (v.length >= 4 && !GENERICOS.has(v.toLowerCase()) && /[A-Za-z]/.test(v)) out.add(v);
  };
  for (const m of t.matchAll(/`([^`]{2,60})`/g)) agregar(m[1]);
  for (const m of t.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) agregar(m[1]);
  for (const m of t.matchAll(/\b([A-Z][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\b/g)) agregar(m[1]);
  for (const m of t.matchAll(/\b([a-z]+[A-Z][A-Za-z0-9]*)\b/g)) agregar(m[1]);
  return out;
}

function interseca(a, b) {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

function sitio(h) {
  const f = String((h && h.file) || '').trim();
  const l = h && h.line !== null && h.line !== undefined && h.line !== '' ? String(h.line) : null;
  return { file: f, line: l };
}

/**
 * ¿Estos dos hallazgos son el mismo problema? Devuelve {ok, motivo}. `motivo` explica tanto el sí
 * como el no: es lo que después se lee en el informe y en la lista de dudas.
 */
function compatibles(a, b, ctx) {
  const sa = sitio(a);
  const sb = sitio(b);
  if (!sa.file || !sb.file || sa.file !== sb.file) return { ok: false, motivo: 'archivos distintos' };

  const symA = ctx.simbolos.get(a);
  const symB = ctx.simbolos.get(b);
  const sinA = ctx.sintomas.get(a);
  const sinB = ctx.sintomas.get(b);

  // Veto por síntoma: los dos reconocidos y sin nada en común → son cosas distintas.
  if (sinA.size && sinB.size && !interseca(sinA, sinB)) {
    return { ok: false, motivo: `mismo archivo, pero síntomas distintos (${[...sinA].join('/')} vs ${[...sinB].join('/')})`, cerca: true };
  }

  // Señales POSITIVAS de que son el mismo defecto. Ninguna de las dos es suficiente sola en todos
  // los casos; cuáles hacen falta lo decide la rama de abajo.
  const sintomasEnComun = [...sinA].filter((x) => sinB.has(x));
  const simbolosEnComun = [...symA].filter((x) => symB.has(x) && !ctx.genericos.has(x));

  if (sa.line && sb.line) {
    if (sa.line !== sb.line) {
      return { ok: false, motivo: `mismo archivo pero líneas declaradas distintas (${sa.line} vs ${sb.line})`, cerca: true };
    }
    // 🔴 El sitio SOLO no alcanza (un bug de índice y una
    // condición de carrera en la misma línea): hace falta algo más que compartan.
    if (sintomasEnComun.length) {
      return { ok: true, motivo: `mismo sitio (${sa.file}:${sa.line}) y mismo síntoma (${sintomasEnComun.join('/')})` };
    }
    if (simbolosEnComun.length) {
      return { ok: true, motivo: `mismo sitio (${sa.file}:${sa.line}) y nombran el mismo código (${simbolosEnComun.slice(0, 3).join(', ')})` };
    }
    return { ok: false, motivo: `mismo sitio (${sa.file}:${sa.line}) pero nada más en común: ante la duda, separados`, cerca: true };
  }

  if (!sa.line && !sb.line) {
    // Sin sitio, una sola señal es demasiado poco: el nombre de la función que los contiene lo
    // comparten TODOS los defectos de esa función, que es justo el caso que el pase reprodujo.
    if (simbolosEnComun.length && sintomasEnComun.length) {
      return { ok: true, motivo: `ninguno declara línea, pero nombran el mismo código (${simbolosEnComun.slice(0, 3).join(', ')}) y comparten síntoma (${sintomasEnComun.join('/')})` };
    }
    const falta = !simbolosEnComun.length ? 'no nombran el mismo código' : 'no comparten síntoma reconocido';
    return { ok: false, motivo: `ninguno declara línea y ${falta}`, cerca: true };
  }

  // Uno declara línea y el otro no: no hay con qué compararlos. Ante la duda, separados.
  return { ok: false, motivo: 'uno declara línea y el otro no: no hay con qué compararlos', cerca: true };
}

/**
 * Agrupa. Devuelve { clases, dudas, resumen }.
 *   clases: [{ id, miembros:[índices], representante:índice, motivo, file, line }]
 *   dudas:  [{ a, b, motivo }] — los pares que ESTUVIERON CERCA y no se juntaron.
 *   resumen: { hallazgos, clases, agentes_ahorrados }
 */
function agrupar(hallazgos, opts) {
  const hs = Array.isArray(hallazgos) ? hallazgos : [];
  const o = opts || {};
  const simbolos = new Map();
  const sintomas = new Map();
  const cuenta = new Map();
  for (const h of hs) {
    const s = simbolosDe(h);
    simbolos.set(h, s);
    sintomas.set(h, sintomasDe(h));
    for (const x of s) cuenta.set(x, (cuenta.get(x) || 0) + 1);
  }
  // Un símbolo que aparece en buena parte de los hallazgos no distingue nada: es el nombre del
  // módulo que todos tocan. Un corte en la MITAD sería demasiado permisivo con pases chicos (con 2
  // hallazgos, un símbolo compartido por los dos nunca llegaría a «genérico»); el corte es un tercio.
  const tope = Math.max(1, Math.ceil(hs.length / 3));
  const genericos = new Set([...cuenta.entries()].filter(([, n]) => n > tope).map(([k]) => k));
  const ctx = { simbolos, sintomas, genericos };

  const clases = [];
  const dudas = [];
  for (let i = 0; i < hs.length; i++) {
    let destino = null;
    for (const c of clases) {
      // CLIQUE: compatible con TODOS los miembros, no con uno.
      let todos = true;
      let motivo = '';
      for (const j of c.miembros) {
        const r = compatibles(hs[i], hs[j], ctx);
        if (!r.ok) { todos = false; if (r.cerca) dudas.push({ a: j, b: i, motivo: r.motivo }); break; }
        motivo = r.motivo;
      }
      if (todos) { destino = c; c.motivo = motivo || c.motivo; break; }
    }
    if (destino) destino.miembros.push(i);
    else {
      const s = sitio(hs[i]);
      clases.push({ id: clases.length + 1, miembros: [i], representante: i, motivo: 'no se juntó con ninguna otra: queda sola', file: s.file, line: s.line });
    }
  }
  // El representante es el primero de la clase: es el que se verifica, y el que todos citan.
  for (const c of clases) c.representante = c.miembros[0];

  return {
    clases,
    dudas,
    resumen: { hallazgos: hs.length, clases: clases.length, agentes_ahorrados: Math.max(0, hs.length - clases.length) },
    __opts: o,
  };
}

// ===== NUCLEO-AGRUPAR: FIN =====

/**
 * Compara lo que produjo el criterio contra las clases REALES de una corrida archivada.
 * `clasesReales` es un array paralelo a los hallazgos con la etiqueta de cada uno.
 *
 * 🔴 `juntadas_de_mas` es EL número que decide si esto se cablea: una clase producida con hallazgos
 *    de dos clases reales significa que un defecto se verificaría con la prueba de otro.
 */
function compararContra(resultado, clasesReales) {
  const reales = Array.isArray(clasesReales) ? clasesReales : [];
  const porReal = new Map();
  reales.forEach((r, i) => { if (!porReal.has(r)) porReal.set(r, []); porReal.get(r).push(i); });

  const juntadas = [];
  const coinciden = [];
  const separadas = [];

  for (const c of resultado.clases) {
    const etiquetas = [...new Set(c.miembros.map((i) => reales[i]))];
    if (etiquetas.length > 1) juntadas.push({ clase: c.id, miembros: c.miembros, clases_reales: etiquetas, motivo: c.motivo });
  }

  for (const [etiqueta, miembros] of porReal) {
    const clasesTocadas = [...new Set(miembros.map((i) => resultado.clases.findIndex((c) => c.miembros.includes(i))))];
    // 🔴 «Coincide» es reproducción EXACTA: todos sus miembros en una sola clase producida Y esa
    // clase sin miembros de otra clase real. Sin la segunda mitad, dos clases reales fundidas en una
    // se reportarían las dos como «coinciden».
    const limpia = clasesTocadas.length === 1 && clasesTocadas[0] >= 0 &&
      resultado.clases[clasesTocadas[0]].miembros.every((i) => reales[i] === etiqueta);
    if (limpia) coinciden.push(etiqueta);
    else if (clasesTocadas.length > 1) {
      const motivos = [];
      for (let a = 0; a < miembros.length; a++) {
        for (let b = a + 1; b < miembros.length; b++) {
          const d = resultado.dudas.find((x) => (x.a === miembros[a] && x.b === miembros[b]) || (x.a === miembros[b] && x.b === miembros[a]));
          if (d) motivos.push(d.motivo);
        }
      }
      separadas.push({ clase_real: etiqueta, partida_en: clasesTocadas.length, motivo: motivos[0] || 'el criterio no encontró con qué juntarlos' });
    }
  }

  const texto = [
    `Comparación contra las clases reales de la corrida 7.10 (${reales.length} hallazgos, ${porReal.size} clases reales):`,
    `- el criterio produjo ${resultado.clases.length} clases → ahorra ${resultado.resumen.agentes_ahorrados} verificadores`,
    `- reprodujo exactas ${coinciden.length} de ${porReal.size} clases reales: ${coinciden.join(', ') || '(ninguna)'}`,
    `- partió ${separadas.length} (cuesta un agente de más, no pierde nada): ${separadas.map((s) => `${s.clase_real} — ${s.motivo}`).join(' · ') || '(ninguna)'}`,
    `- juntó de más ${juntadas.length} ${juntadas.length ? '🔴 NO SE CABLEA' : '(ninguna: no se pierde ningún hallazgo)'}`,
  ].join('\n');

  return {
    clases_reales: porReal.size,
    coinciden,
    separadas_de_mas: separadas,
    juntadas_de_mas: juntadas,
    pierde: juntadas.length > 0,
    texto,
  };
}

module.exports = { agrupar, compararContra, sintomasDe, simbolosDe, SINTOMAS, nucleo };

/** El bloque que va copiado dentro del pase. Lo usa el test de deriva y el re-sincronizado. */
function nucleo() {
  const src = require('fs').readFileSync(__filename, 'utf8');
  const i = src.indexOf('// ===== NUCLEO-AGRUPAR: INICIO =====');
  const j = src.indexOf('// ===== NUCLEO-AGRUPAR: FIN =====');
  if (i < 0 || j < 0) throw new Error('group-findings.js: faltan las marcas del núcleo');
  return src.slice(i, j).trimEnd();
}

if (require.main === module) {
  // La opción vieja sigue andando hasta el retiro
  require('./legacy-names.js').aliasArgv('skills/tycon-pipeline/scripts/lib/group-findings.js');
  if (process.argv.includes('--emit-core')) process.stdout.write(nucleo() + '\n');
}
