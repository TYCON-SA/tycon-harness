#!/usr/bin/env node
'use strict';
/*
 * step-times.js — CUÁNTO TRABAJÓ Y CUÁNTO ESPERÓ UNA CORRIDA
 *
 * El agente marca cada paso del pipeline al TERMINARLO. Sin el arranque,
 * la duración de un paso sería «del fin del anterior al fin de éste», y todo lo que pasa en el
 * medio —incluido el tiempo en que no pasó nada— caería en el paso siguiente. Medido: 208 de 237
 * corridas archivadas tienen pasos «marcados juntos», y el paso 8 de una corrida real aparentaba
 * 3,3 h con 2,7 h sin un solo evento adentro.
 *
 * `marker.js` anota también el arranque (`stepTimings[N].startedAt`). Este archivo es la
 * ÚNICA cuenta que lo usa, y trata igual a la corrida nueva y a la vieja:
 *
 *   · Paso con arranque válido → duración MEDIDA = fin − arranque. Lo que hay entre el fin del paso
 *     anterior y este arranque es HUECO (`entre_pasos_ms`), nunca del paso.
 *   · Paso sin arranque (corrida vieja) → duración ESTIMADA = fin − fin del anterior,
 *     y se dice (`estimados`). 🔴 No se rellena: inventar un arranque mezclaría en
 *     silencio lo estimado con lo medido y arruinaría la serie.
 *   · Marcas invertidas o empatadas → se fusionan (`5+6`) con la misma regla
 *     (`cortesDePaso`, importado: una sola implementación) y cuentan como estimadas.
 *   · Pasos que se PISAN (una vuelta de revisión vuelve a cerrar el 5 después del 6 y el 7), un
 *     arranque anterior al fin del paso previo o anterior al inicio de la corrida → estimados: la marca
 *     existe, pero no dice lo que parece.
 *   · Sub-pasos (0b, 0c, 5b, 7c): tienen arranque y no fin; su tramo va hasta el arranque del paso
 *     siguiente y es TRABAJO, no hueco.
 *
 * Tres totales:
 *   · `espera_humana_ms` — los pasos 3 (aprobar el plan) y 7 (aprobar los hallazgos), MEDIDOS. Si
 *     alguno de los dos que la corrida tiene no está medido, es `null` con motivo (un número parcial se
 *     leería como completo), nunca 0.
 *   · `entre_pasos_ms`   — la suma de los huecos. `null` si ningún paso tiene arranque.
 *   · `trabajo_ms`       — todos los demás pasos (medidos o estimados; `trabajo_medido` dice cuál).
 *   Un tramo que junta el 3 o el 7 con otro paso (fusión) o que es un 3/7 estimado no se puede partir:
 *   va a `sin_repartir_ms` y no entra en ninguno de los tres.
 *
 * Uso:  node scripts/metrics/step-times.js <volcado.json>   → la cuenta en JSON
 */

const fs = require('fs');
const path = require('path');
const { cortesDePaso } = require('./tokens-digest.js');
// la tabla de los pasos: nombres, y la equivalencia del esquema viejo. Sin ella (una copia suelta de
// scripts/), la cuenta sale igual: el esquema se reconoce por la forma de las claves y los pasos van sin nombre.
let STEPS_LIB = null;
try { STEPS_LIB = require('../../skills/tycon-pipeline/scripts/lib/steps.js'); } catch (_) { STEPS_LIB = null; }

const JUNTO_MS = 60000;          // menos de un minuto: «marcado junto con el anterior» — una marca, no una banda
// Esquema viejo (pasos por número): el 3 y el 7 son espera enteros; 0b, 0c, 5b y 7c son sub-pasos.
// Esquema 2 (pasos por nombre): Aprobar el plan es espera entero; Hallazgos lo es sólo desde que preguntó
// (`waitStartedAt`); el pase adversarial y la prueba en vivo se cierran con bandera, como los sub-pasos.
const ESQUEMA = {
  1: { espera: new Set(['3', '7']), subpasos: ['0b', '0c', '5b', '7c'] },
  2: { espera: new Set(['approve-plan']), subpasos: ['adversarial-pass', 'live-check'] },
};
/** El esquema de una ejecución por las claves de sus tiempos: con un nombre de la tabla nueva, el 2. */
const esquemaDe = (st) => (Object.keys(st).some((k) => (STEPS_LIB ? STEPS_LIB.byId(k) : !/^\d+[a-z]?$/.test(k))) ? 2 : 1);
const nombreDe = (ids) => [...new Set(ids.map((i) => (STEPS_LIB && STEPS_LIB.stepName(i)) || i))].join(' + ');

const aMs = (iso) => {
  if (typeof iso !== 'string') return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/**
 * @param {object} stepTimings  marker.stepTimings
 * @param {{inicio: string}} opts  marker.startedAt (el eje de la corrida)
 */
function tiempos(stepTimings, opts = {}) {
  const ini = aMs(opts.inicio);
  if (ini === null) {
    return { estado: 'sin_inicio', motivo: 'la ejecución no anotó su hora de inicio: sin eje de tiempo', pasos: [],
      trabajo_ms: null, espera_humana_ms: null, entre_pasos_ms: null, sin_repartir_ms: null, estimados: [], trabajo_medido: false };
  }
  const st = stepTimings && typeof stepTimings === 'object' ? stepTimings : {};
  const esquema = esquemaDe(st);
  const PASOS_DE_ESPERA = ESQUEMA[esquema].espera;
  const SUBPASOS = ESQUEMA[esquema].subpasos;
  // Hallazgos (esquema 2): espera sólo desde que preguntó, si la marca cae adentro del paso
  const preguntoEn = (k, desde, hasta) => {
    if (esquema !== 2 || k !== 'findings') return null;
    const w = st[k] && typeof st[k] === 'object' ? aMs(st[k].waitStartedAt) : null;
    return w !== null && w >= desde && w <= hasta ? w : null;
  };
  // Un arranque sirve si es legible y no es anterior al inicio de la corrida: uno de antes es heredado
  // de otra story de la misma sesión.
  const arranque = (k) => {
    const t = st[k] && typeof st[k] === 'object' ? aMs(st[k].startedAt) : null;
    return t !== null && t >= ini ? t : null;
  };
  const cortes = cortesDePaso(st);
  // Los arranques de los pasos enteros, para detectar pasos que se PISAN: en una vuelta de revisión
  // el 5 se vuelve a cerrar después del 6 y el 7, conserva su arranque de la primera vuelta, y su
  // intervalo se come la espera del 7. Un paso que contiene el arranque de otro no se mide.
  const arranquesEnteros = cortes.filter((c) => !String(c.paso).includes('+'))
    .map((c) => ({ paso: String(c.paso), t: arranque(String(c.paso)) })).filter((x) => x.t !== null);
  // Los sub-pasos (0b, 0c, 5b, 7c) tienen arranque y no fin: su trabajo va desde su arranque hasta el
  // arranque del paso siguiente, y NO es hueco (el pase adversarial del 5b dura ~30 min).
  const subpasos = SUBPASOS.map((k) => ({ paso: k, t: arranque(k) })).filter((x) => x.t !== null).sort((a, b) => a.t - b.t);

  const pasos = [];
  const estimados = [];
  const esperaSinMedir = [];
  let ant = ini;
  let entre = 0;
  let algunoMedido = false;
  let trabajo = 0;
  let trabajoMedido = true;
  let espera = 0;
  let esperaMedida = false;
  let sinRepartir = 0;

  for (const c of cortes) {
    const ids = String(c.paso).split('+');
    const fin = c.hasta;
    const arr = ids.length === 1 ? arranque(ids[0]) : null;
    const pisado = arr !== null && arranquesEnteros.some((x) => x.paso !== ids[0] && x.t > arr && x.t < fin);
    const medida = arr !== null && arr <= fin && arr >= ant && !pisado;
    // Hallazgos (esquema 2) que preguntó pero no se puede medir (sin arranque, o fusionado con otro paso) es una espera
    // sin medir, no trabajo
    const preguntoSinMedir = (i) => esquema === 2 && i === 'findings' && !medida && Boolean(st[i] && st[i].waitStartedAt);
    const esEspera = ids.some((i) => PASOS_DE_ESPERA.has(i) || preguntoSinMedir(i));
    let desde = ant;
    let hueco = 0;
    if (medida) {
      desde = arr;
      // El hueco previo, descontando lo que ocupó un sub-paso arrancado ahí adentro.
      let cursor = ant;
      const adentro = subpasos.filter((x) => x.t >= ant && x.t < arr);
      for (let i = 0; i < adentro.length; i += 1) {
        const sp = adentro[i];
        hueco += Math.max(0, sp.t - cursor);
        const hasta = i + 1 < adentro.length ? adentro[i + 1].t : arr;
        const ms = Math.max(0, hasta - sp.t);
        pasos.push({ paso: sp.paso, pasos: [], nombre: nombreDe([sp.paso]), inicio: sp.t, fin: hasta, ms, hueco_previo_ms: Math.max(0, sp.t - cursor),
          medida: true, junto: ms < JUNTO_MS, espera: false, subpaso: true });
        trabajo += ms;
        cursor = hasta;
      }
      hueco += Math.max(0, arr - cursor);
      algunoMedido = true;
    } else {
      estimados.push(...ids);
    }
    const dur = Math.max(0, fin - desde);
    entre += hueco;
    const pregunto = medida && ids.length === 1 ? preguntoEn(ids[0], desde, fin) : null;
    if (pregunto !== null) { espera += fin - pregunto; trabajo += pregunto - desde; esperaMedida = true; }
    else if (esEspera && medida) { espera += dur; esperaMedida = true; }
    else if (esEspera) {
      sinRepartir += dur;
      esperaSinMedir.push(...ids.filter((i) => PASOS_DE_ESPERA.has(i) || preguntoSinMedir(i)).map((i) => (i === 'findings' ? 'Hallazgos' : i)));
      // Un tramo que junta un paso de espera con uno de trabajo no se puede partir: el trabajo que
      // quedó adentro tampoco está medido.
      if (ids.some((i) => !PASOS_DE_ESPERA.has(i))) trabajoMedido = false;
    } else { trabajo += dur; if (!medida) trabajoMedido = false; }
    const huecoPrevio = pasos.length && pasos[pasos.length - 1].subpaso && pasos[pasos.length - 1].fin === arr
      ? 0 : hueco;
    pasos.push({
      paso: String(c.paso), pasos: ids.map((i) => (/^\d+$/.test(i) ? Number(i) : i)), nombre: nombreDe(ids), inicio: desde, fin, ms: dur,
      hueco_previo_ms: medida ? huecoPrevio : 0, medida, junto: dur < JUNTO_MS, espera: esEspera || pregunto !== null,
      ...(pregunto !== null ? { espera_desde: pregunto } : {}),
    });
    ant = Math.max(ant, fin);
  }

  const principales = pasos.filter((p) => !p.subpaso);
  const estado = !principales.length ? 'sin_pasos' : !estimados.length ? 'medida' : algunoMedido ? 'parcial' : 'estimada';
  let motivo = null;
  // La espera se publica sólo si TODOS los pasos de espera que la corrida tiene están medidos: con uno
  // solo, el número sería parcial y se leería como completo (hallazgos 4 y 10).
  const esperaCompleta = esperaMedida && !esperaSinMedir.length;
  if (!algunoMedido) motivo = 'la ejecución no anotó el arranque de ningún paso (es anterior a la story 2.7): las duraciones son estimadas por diferencia';
  else if (esperaSinMedir.length) motivo = `la espera no se puede medir: el paso ${[...new Set(esperaSinMedir)].join(' y el ')} no tiene arranque medido`;
  else if (!esperaMedida) motivo = esquema === 2 ? 'Aprobar el plan no tiene arranque: la espera no se puede medir' : 'los pasos de espera (3 y 7) no tienen arranque: la espera no se puede medir';
  return {
    // con qué pasos corrió: 1 = por número (el marcador viejo), 2 = por nombre de máquina
    esquema,
    estado,
    motivo,
    pasos,
    trabajo_ms: principales.length ? trabajo : null,
    trabajo_medido: principales.length ? trabajoMedido : false,
    espera_humana_ms: esperaCompleta ? espera : null,
    entre_pasos_ms: algunoMedido ? entre : null,
    sin_repartir_ms: principales.length ? sinRepartir : null,
    estimados,
  };
}

/**
 * La espera por una persona que el hilo muestra FUERA de los pasos 3 y 7: una pregunta al dev
 * a mitad del paso 5, o un turno que terminó esperando su mensaje. Se descuenta de lo que la cuenta por
 * pasos había dado como trabajo (y del tiempo entre pasos, si cayó ahí) y se suma a la espera. Lo que cae
 * adentro del 3 o del 7 ya era espera: no se cuenta dos veces.
 * @param {object} t  el resultado de tiempos()
 * @param {Array<[number, number]>} esperas  tramos en ms, unidos (changes.js)
 */
function conEsperas(t, esperas) {
  if (!t || !Array.isArray(esperas) || !esperas.length || !Array.isArray(t.pasos)) return t;
  const solape = (a, b) => esperas.reduce((acc, [x, y]) => acc + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0);
  let deTrabajo = 0;
  let deEntre = 0;
  let enTresOSiete = 0;
  let prevFin = null;
  for (const p of t.pasos) {
    const s = solape(p.inicio, p.fin);
    if (p.espera) enTresOSiete += s; else deTrabajo += s;
    if (prevFin !== null && p.inicio > prevFin) deEntre += solape(prevFin, p.inicio);
    prevFin = Math.max(prevFin === null ? p.fin : prevFin, p.fin);
  }
  const extra = deTrabajo + deEntre;
  if (!extra) return { ...t, espera_del_hilo_ms: 0 };
  return {
    ...t,
    trabajo_ms: t.trabajo_ms === null ? null : Math.max(0, t.trabajo_ms - deTrabajo),
    entre_pasos_ms: t.entre_pasos_ms === null ? null : Math.max(0, t.entre_pasos_ms - deEntre),
    espera_humana_ms: t.espera_humana_ms === null ? null : t.espera_humana_ms + extra,
    espera_del_hilo_ms: extra,
    espera_en_pasos_de_espera_ms: enTresOSiete,
  };
}

module.exports = { conEsperas, tiempos, JUNTO_MS };

if (require.main === module) {
  const f = process.argv[2];
  if (!f) { console.error('uso: step-times.js <volcado.json>'); process.exit(1); }
  let d;
  try { d = JSON.parse(fs.readFileSync(path.resolve(f), 'utf8')); }
  catch (e) { console.error(`no se pudo leer el volcado (${e.code || 'JSON inválido'})`); process.exit(1); }
  const m = (d && d.marker) || {};
  console.log(JSON.stringify(tiempos(m.stepTimings, { inicio: m.startedAt }), null, 2));
}
