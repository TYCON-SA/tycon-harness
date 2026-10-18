'use strict';
/*
 * cards.js — las fichas del tablero nocturno que el sitio muestra con su estilo.
 *
 * Una sola cuenta: cada ficha sale del modelo que arma `colectar()` de scripts/nightly/dashboard/dashboard.js, el mismo que
 * dibuja la página del tablero. Acá no se recalcula ninguna métrica: se elige la ficha, se proyecta por LISTA BLANCA y se
 * le pone su título fijo. De cada una llegan al modelo del sitio sólo el estado, el número, su denominador, la fecha y el
 * motivo de una lista cerrada; nunca un texto de la fuente (un título o un diagnóstico puede nombrar un repo de un cliente).
 *
 * La lista `FICHAS` es la lista de las fichas del sitio: la guía la copia, una prueba la compara con las fichas que arma el
 * tablero, y `site.hidden_cards` (operations.json) oculta las que una organización no usa. Una ficha oculta no entra al
 * modelo que va a la vista.
 */
const fs = require('fs');
const path = require('path');
const { juzgar, esc, chip } = require('../../nightly/dashboard/common.js');

/** Las seis preguntas del tablero; la ficha dice a cuál pertenece por su posición. */
const PREGUNTAS = Object.freeze([
  '¿Está midiendo?', '¿El trabajo fluye?', '¿Lo que entregamos aguanta?', '¿Las pruebas prueban algo?',
  '¿Los controles sirven, o estorban?', '¿De qué depende que esto siga funcionando?',
]);

const PESTANAS = Object.freeze(['arnes', 'proyectos', 'corridas']);

/**
 * `id` fijo (es lo que `site.hidden_cards` nombra: no se renombra), `pregunta` (posición en PREGUNTAS), `pestana`, `titulo` y
 * `paraQue` (texto fijo, el de la guía), `de` (dónde está en el modelo del tablero: panel y clave), `formato` (cómo se escribe
 * el número) y `clave` (la del umbral de sources.json que le pone color; '' si no tiene).
 */
const FICHAS = Object.freeze([
  { id: 'contrato_v2', pregunta: 0, pestana: 'arnes', titulo: 'Registros por merge que cumplen el contrato de formato', paraQue: 'Dice si los registros que se escriben al cerrar cada merge se pueden leer por máquina.', de: ['extra', 'contrato_v2'], formato: 'pct', clave: 'contrato_v2' },
  { id: 'fechas_declaradas', pregunta: 0, pestana: 'arnes', titulo: 'Registros por merge con fecha declarada adentro', paraQue: 'Una fecha inferida del nombre del archivo ordena, pero no sirve para dibujar una tendencia.', de: ['extra', 'fechas_declaradas'], formato: 'pct', clave: '' },
  { id: 'backlog', pregunta: 1, pestana: 'proyectos', titulo: 'En el backlog: escritas y todavía sin arrancar', paraQue: 'Cuántas stories hay escritas sin empezar.', de: ['extra', 'backlog'], formato: 'entero', clave: '' },
  { id: 'estados_sin_diccionario', pregunta: 1, pestana: 'proyectos', titulo: 'Con un estado que el diccionario no reconoce', paraQue: 'Los estados que nadie tradujo: son la lista de trabajo del próximo diccionario.', de: ['extra', 'estados_sin_diccionario'], formato: 'entero', clave: '' },
  { id: 'tiempo_por_etapa', pregunta: 1, pestana: 'proyectos', titulo: 'Tiempo por etapa: de listo para desarrollar a cerrado', paraQue: 'Dónde se queda parado el trabajo entre una etapa y la siguiente.', de: ['extra', 'tiempo_por_etapa'], formato: 'num1', clave: '' },
  { id: 'edad_estado', pregunta: 1, pestana: 'proyectos', titulo: 'Stories empezadas que llevan mucho en su estado', paraQue: 'El trabajo empezado que no se mueve hace días.', de: ['extra', 'edad_estado'], formato: 'entero', clave: '' },
  { id: 'dod', pregunta: 2, pestana: 'arnes', titulo: 'Cierres que dejaron prueba de que la cosa anda corriendo', paraQue: 'De las stories cerradas, cuántas dejaron evidencia de que se probó en vivo.', de: ['mejora', 'dod'], formato: 'pct', clave: 'dod' },
  { id: 'rework', pregunta: 2, pestana: 'arnes', titulo: 'Lo que vuelve: stories con un seguimiento posterior', paraQue: 'Qué parte de lo entregado hubo que volver a tocar.', de: ['mejora', 'rework'], formato: 'pct', clave: 'rework' },
  { id: 'rework_por_causa', pregunta: 2, pestana: 'arnes', titulo: 'Por qué volvió: defecto nuestro contra cambio de requisito', paraQue: 'Separa lo que volvió por un error nuestro de lo que volvió porque cambió lo que se pedía.', de: ['extra', 'rework_por_causa'], formato: 'entero', clave: '' },
  { id: 'rework_por_carril', pregunta: 2, pestana: 'arnes', titulo: '¿Vuelve menos lo que pasó por el pipeline?', paraQue: 'Compara, por repo, lo que volvió con constancia del pipeline contra lo que no la tiene.', de: ['extra', 'rework_por_carril'], formato: 'entero', clave: '' },
  { id: 'mutacion', pregunta: 3, pestana: 'arnes', titulo: 'Puntaje de mutación: proporción de mutantes que las pruebas matan', paraQue: 'Si las pruebas se rompen cuando se rompe el código a propósito.', de: ['local', 'mutacion'], formato: 'pct', clave: 'mutacion' },
  { id: 'cobertura_tocada_evaluo', pregunta: 3, pestana: 'arnes', titulo: 'Corridas de pruebas que evaluaron el umbral del 75 % sobre las líneas tocadas', paraQue: 'Cuántas veces la cobertura de lo que se tocó se midió de verdad.', de: ['local', 'cobertura_tocada'], formato: 'pct', clave: 'cobertura_tocada_evaluo' },
  { id: 'qa_guia', pregunta: 3, pestana: 'arnes', titulo: 'Cierres que necesitaban guía para probar a mano, y la tenían', paraQue: 'El puente entre las pruebas automáticas y una persona que prueba.', de: ['local', 'qa_guia'], formato: 'pct', clave: 'qa_guia' },
  { id: 'gates_dur', pregunta: 3, pestana: 'arnes', titulo: 'Cuánto tarda verificar: duración de la suite de pruebas', paraQue: 'Una suite que tarda horas no se corre antes de commitear: se saltea.', de: ['local', 'gates_dur'], formato: 'num1', clave: '' },
  { id: 'bloqueos', pregunta: 4, pestana: 'corridas', titulo: 'Veces que un control del pipeline bloqueó una acción', paraQue: 'Cuántas veces un control frenó de verdad algo del trabajo.', de: ['local', 'bloqueos'], formato: 'entero', clave: '' },
  { id: 'frenos', pregunta: 4, pestana: 'arnes', titulo: 'Los frenos previos a la herramienta: cuántas veces frenaron y cuántas los saltearon', paraQue: 'Los dos números de la misma regla juntos: sin el primero, un freno que funcionó parece que no sirvió.', de: ['local', 'frenos'], formato: 'entero', clave: '' },
  { id: 'evidencia_cierre', pregunta: 4, pestana: 'arnes', titulo: 'Los hooks del cierre: decisiones sobre una evidencia que la rechazaron', paraQue: 'Cuántas veces los frenos que impiden cerrar sin evidencia la rechazaron.', de: ['local', 'evidencia_cierre'], formato: 'pct', clave: '' },
  { id: 'escapes_regla_dominante', pregunta: 4, pestana: 'arnes', titulo: 'Escapes concentrados en una sola regla', paraQue: 'Si lo que se escapa de los controles viene casi todo de una sola regla.', de: ['local', 'escapes_dom'], expr: 'escapesDom', formato: 'pct', clave: 'escapes_regla_dominante' },
  { id: 'reglas_candidatas', pregunta: 4, pestana: 'arnes', titulo: 'Reglas candidatas a retiro: probadas, que nunca encontraron nada', paraQue: 'Reglas que saben ponerse rojas y nunca encontraron nada con recorrido de sobra.', de: ['poda', 'candidatas'], formato: 'entero', clave: '' },
  { id: 'reglas_probadas', pregunta: 4, pestana: 'arnes', titulo: 'Reglas que el banco de pruebas probó de verdad', paraQue: 'Una regla sin prueba que la obligue a marcar no se juzga: sale «sin probar», nunca candidata.', de: ['poda', 'probadas'], formato: 'pct', clave: '' },
  { id: 'corridas', pregunta: 4, pestana: 'corridas', titulo: 'Una corrida del pipeline, de punta a punta (mediana, horas)', paraQue: 'Cuánto dura una corrida completa.', de: ['local', 'corridas'], formato: 'num1', clave: '' },
  { id: 'pasos', pregunta: 4, pestana: 'corridas', titulo: 'Pasos de una corrida del pipeline (mediana)', paraQue: 'Una corrida consume según cuántos pasos da: la variable que explica lo que cuesta.', de: ['local', 'pasos'], formato: 'redondo', clave: '' },
  { id: 'carriles', pregunta: 4, pestana: 'arnes', titulo: 'Commits por carril: pipeline, atajo declarado o ninguno', paraQue: 'Cuántos commits pasaron por el pipeline, cuántos por un atajo declarado y cuántos por ninguno.', de: ['local', 'carriles'], formato: 'entero', clave: '' },
  { id: 'bus_factor', pregunta: 5, pestana: 'proyectos', titulo: 'Productos donde una sola persona hizo el 75 % o más de los commits del último año', paraQue: 'El riesgo de ingeniería no es el código: es quién es la única persona que sabe tocarlo.', de: ['local', 'bus_factor'], formato: 'entero', clave: 'bus_factor_productos_en_riesgo' },
  { id: 'sin_pipeline_de_prod', pregunta: 5, pestana: 'proyectos', titulo: 'Productos sin pipeline de producción', paraQue: 'No es calidad: es exposición. Para ellos «despliegues» es cero porque no hay a dónde mirar.', de: ['extra', 'sin_prod'], formato: 'entero', clave: '' },
]);

/**
 * Las fichas que la página del tablero arma con `F(...)` y que el sitio ya mostraba antes de esta lista (Inicio, Proyectos y
 * Arnés), por la expresión de su métrica en `render()`. Una ficha nueva en el tablero que no está acá ni en `FICHAS` hace
 * fallar la prueba de la lista: hay que decidir si el sitio la lleva.
 */
const YA_EN_EL_SITIO = Object.freeze(['E.en_curso', 'dInc', 'X.banco_rojos', 'X.suites', 'E.despliegues', 'E.vigilados']);

const PREFIJO_DE_PANEL = Object.freeze({ extra: 'E', local: 'L', mejora: 'M', encuentra: 'X', poda: 'P' });

/** La expresión con que `render()` del tablero nombra la métrica de la ficha. */
function exprDelTablero(def) {
  if (def.expr) return def.expr;
  return `${PREFIJO_DE_PANEL[def.de[0]]}.${def.de[1]}`;
}

const MOTIVOS = Object.freeze(['sin_foto', 'vieja', 'sin_buzon', 'solo_en_la_maquina', 'ilegible', 'sin_datos']);

/** El motivo del tablero es texto libre; el sitio manda sólo uno de la lista cerrada. */
function motivoCerrado(texto) {
  const t = String(texto || '');
  if (/sin medición desde/i.test(t)) return 'vieja';
  if (/no hay ningún archivo|no se pudo leer la carpeta|no está la carpeta|no está declarada|sin_foto/i.test(t)) return 'sin_foto';
  if (/disco de cada máquina|no aplica en el nocturno|esta máquina/i.test(t)) return 'solo_en_la_maquina';
  if (/buzón/i.test(t)) return 'sin_buzon';
  if (/ilegible|no tiene la forma|no se pudo cargar|no pudo cargar/i.test(t)) return 'ilegible';
  return 'sin_datos';
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const fechaCorta = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const etiqueta = (v) => (typeof v === 'string' && /^[a-záéíóúñ ]{1,30}$/i.test(v) ? v : null);

/**
 * Una ficha para el sitio: sólo lo de la lista blanca. `m` es la métrica del tablero (medida / noMedida).
 * `nivel` es el color que le da sources.json (ok / warn / bad), o '' si no tiene juicio.
 */
function proyectar(def, m, cfg) {
  const base = { id: def.id, pregunta: def.pregunta, pestana: def.pestana, formato: def.formato };
  if (!m || typeof m !== 'object' || m.estado !== 'medido') {
    return { ...base, estado: 'no_medido', nivel: '', valor: null, medidos: null, total: null, den_etiqueta: null, fecha: fechaCorta(m && m.fecha), motivo: motivoCerrado(m && m.motivo) };
  }
  if (num(m.valor) === null) {
    return { ...base, estado: 'no_medido', nivel: '', valor: null, medidos: null, total: null, den_etiqueta: null, fecha: fechaCorta(m.fecha), motivo: 'sin_datos' };
  }
  const nivel = juzgar(cfg || {}, def.clave, m);
  return {
    ...base,
    estado: m.prov === 'declarada' ? 'declarado' : 'medido',
    nivel: nivel === 'ok' || nivel === 'warn' || nivel === 'bad' ? nivel : '',
    valor: num(m.valor), medidos: num(m.medidos), total: num(m.total),
    den_etiqueta: etiqueta(m.den_etiqueta), unidad: m.unidad === 'ratio' ? 'ratio' : 'conteo',
    fecha: fechaCorta(m.fecha), motivo: null,
  };
}

/** Lo de `de` dentro de los paneles del tablero, sin romper si el panel falta. */
function delPanel(paneles, de) {
  const panel = paneles && paneles[de[0]];
  return panel && typeof panel === 'object' ? panel[de[1]] : undefined;
}

/**
 * El modelo de las fichas del sitio. `ocultas` es `site.hidden_cards`: esas no se arman ni entran al modelo (el cálculo
 * común del tablero corre entero porque se comparte con la página, pero ninguna ficha oculta llega a la vista).
 * Devuelve `{ lista, ocultas }`: las fichas visibles y cuántas se ocultaron.
 */
function modeloDeFichas(paneles, { cfg = {}, ocultas = [] } = {}) {
  const fuera = new Set(Array.isArray(ocultas) ? ocultas : []);
  const lista = [];
  let n = 0;
  for (const def of FICHAS) {
    if (fuera.has(def.id)) { n += 1; continue; }
    lista.push(proyectar(def, delPanel(paneles, def.de), cfg));
  }
  return { lista, ocultas: n };
}

/** Todas las fichas visibles como no medidas con un motivo cerrado (el cálculo no corrió o se cayó). */
function fichasNoMedidas(ocultas = [], motivo = 'ilegible') {
  const fuera = new Set(Array.isArray(ocultas) ? ocultas : []);
  return { lista: FICHAS.filter((f) => !fuera.has(f.id)).map((f) => proyectar(f, { estado: 'no_medido', motivo }, {})), ocultas: FICHAS.filter((f) => fuera.has(f.id)).length };
}

/**
 * Las fichas del sitio a partir de la copia de operaciones (`clon`) y el espejo del buzón: llama al MISMO `colectar()` del
 * tablero nocturno, en su modo de noche (el sitio, igual que el agente de la noche, no es una máquina del equipo). Si el
 * cálculo falla, cada ficha sale «no medida» con el motivo `ilegible` y el detalle va a `log`.
 */
function fichasDelClon({ clon, dirBuzon = null, buzonLeido = false, ocultas = [], ahora = Date.now(), log = () => {} }) {
  const fuera = new Set(Array.isArray(ocultas) ? ocultas : []);
  if (fuera.size >= FICHAS.length && FICHAS.every((f) => fuera.has(f.id))) return { lista: [], ocultas: FICHAS.length };
  try {
    const dashboard = require('../../nightly/dashboard/dashboard.js');
    // sources.json de la copia de operaciones si se lee; si no, el del arnés (la misma regla que el resto del sitio)
    let config;
    const propio = path.join(clon, 'scripts', 'nightly', 'dashboard', 'sources.json');
    try { JSON.parse(fs.readFileSync(propio, 'utf8')); config = propio; } catch (e) {
      config = undefined;
      log(`el sources.json de la copia de operaciones no se pudo leer (${(e && e.code) || (e && e.name) || 'error'}): las fichas usan el del arnés`);
    }
    const d = dashboard.colectar({
      dir: path.join(clon, '.dashboard'), raiz: clon, nocturno: true, config, ahora,
      hoy: new Date(ahora).toISOString().slice(0, 10),
      mailbox: dirBuzon || undefined,
      estadoBuzon: buzonLeido && dirBuzon ? { estado: 'leido' } : { estado: 'no_leido', motivo: 'el sitio no tiene el buzón de corridas' },
    });
    return modeloDeFichas(d.paneles, { cfg: d.cfg, ocultas });
  } catch (e) {
    log(`las fichas del tablero no se pudieron calcular (${(e && e.code) || (e && e.name) || 'error'}): salen no medidas`);
    return fichasNoMedidas(ocultas);
  }
}

/** La frase de cada motivo de la lista cerrada. */
const FRASES_MOTIVO = Object.freeze({
  sin_foto: 'no hay foto de esta fuente',
  vieja: 'la foto es más vieja que su antigüedad máxima',
  sin_buzon: 'depende del buzón de corridas y hoy no se pudo leer entero',
  solo_en_la_maquina: 'sólo se mide en la máquina de cada dev',
  ilegible: 'la foto de esta fuente no se pudo leer',
  sin_datos: 'la fuente no trae este dato',
});
const PALABRA = Object.freeze({ ok: 'bien', warn: 'atención', bad: 'rojo', '': 'medido' });

/** Una ficha como la del tablero, con el estilo del sitio. */
function tile(f) {
  const def = FICHAS.find((x) => x.id === f.id);
  const titulo = def ? def.titulo : f.id;
  if (f.estado === 'no_medido') {
    return `<div class="tile blind" data-ficha="${esc(f.id)}">${chip('blind', 'no medido')}<div class="t-label">${esc(titulo)}</div><div class="t-val">falta</div><div class="t-den">${esc(FRASES_MOTIVO[f.motivo] || FRASES_MOTIVO.sin_datos)}${f.fecha ? ` (fuente del ${esc(f.fecha)})` : ''}</div></div>`;
  }
  const est = f.estado === 'declarado' ? 'decl' : f.nivel;
  const etiq = f.den_etiqueta ? ` ${esc(f.den_etiqueta)}` : '';
  const den = f.unidad === 'ratio' ? `${esc(f.medidos)} de ${esc(f.total)}${etiq}` : `n=${esc(f.medidos)}${f.total && f.total !== f.medidos ? ` de ${esc(f.total)}` : ''}${etiq}`;
  return `<div class="tile ${est}" data-ficha="${esc(f.id)}">${chip(est, f.estado === 'declarado' ? 'declarado' : PALABRA[f.nivel])}<div class="t-label">${esc(titulo)}</div><div class="t-val">${esc(formatear(f))}</div><div class="t-den">${den}</div>${f.fecha ? `<div class="t-den">fuente del ${esc(f.fecha)}</div>` : ''}</div>`;
}

/** Las fichas de una pestaña, en una grilla por pregunta (o en una sola, sin título, si `sinPreguntas`). */
function seccionesDe(model, pestana, { sinPreguntas = false } = {}) {
  const mias = ((model && model.lista) || []).filter((f) => f.pestana === pestana);
  if (!mias.length) return [];
  if (sinPreguntas) return [{ titulo: null, html: `<div class="grid">${mias.map(tile).join('')}</div>` }];
  return PREGUNTAS.map((titulo, n) => ({ titulo, fichas: mias.filter((f) => f.pregunta === n) }))
    .filter((g) => g.fichas.length)
    .map((g) => ({ titulo: g.titulo, html: `<div class="grid">${g.fichas.map(tile).join('')}</div>` }));
}

/** La línea que dice cuántas fichas se ocultaron desde Configuración (vacía si ninguna). */
function avisoDeOcultas(model) {
  const n = model && Number.isInteger(model.ocultas) ? model.ocultas : 0;
  return n > 0 ? `${n} ${n === 1 ? 'ficha oculta' : 'fichas ocultas'}, desde Configuración` : '';
}

const FORMATOS = Object.freeze({
  pct: (x) => `${(x * 100).toFixed(0)}%`,
  num1: (x) => (Math.round(x * 10) / 10).toString().replace('.', ','),
  entero: (x) => String(x),
  redondo: (x) => String(Math.round(x)),
});

/** El número de una ficha tal como se lee. */
function formatear(f) {
  if (!f || f.estado === 'no_medido' || f.valor === null) return null;
  return (FORMATOS[f.formato] || FORMATOS.entero)(f.valor);
}

module.exports = { fichasNoMedidas, fichasDelClon, tile, seccionesDe, avisoDeOcultas, FRASES_MOTIVO, FICHAS, PREGUNTAS, PESTANAS, YA_EN_EL_SITIO, exprDelTablero, MOTIVOS, motivoCerrado, proyectar, modeloDeFichas, formatear };
