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
const { t } = require('../texts.js');

/** Las seis preguntas del tablero; la ficha dice a cuál pertenece por su posición. */
const PREGUNTAS = Object.freeze([0, 1, 2, 3, 4, 5].map((n) => t('es', `ficha.pregunta${n}`)));

const PESTANAS = Object.freeze(['arnes', 'proyectos', 'corridas']);

/**
 * `id` fijo (es lo que `site.hidden_cards` nombra: no se renombra), `pregunta` (posición en PREGUNTAS), `pestana`, `titulo` y
 * `paraQue` (texto fijo, el de la guía), `de` (dónde está en el modelo del tablero: panel y clave), `formato` (cómo se escribe
 * el número) y `clave` (la del umbral de sources.json que le pone color; '' si no tiene).
 */
const DEFINICIONES = [
  { id: 'contrato_v2', pregunta: 0, pestana: 'arnes', de: ['extra', 'contrato_v2'], formato: 'pct', clave: 'contrato_v2' },
  { id: 'fechas_declaradas', pregunta: 0, pestana: 'arnes', de: ['extra', 'fechas_declaradas'], formato: 'pct', clave: '' },
  { id: 'backlog', pregunta: 1, pestana: 'proyectos', de: ['extra', 'backlog'], formato: 'entero', clave: '' },
  { id: 'estados_sin_diccionario', pregunta: 1, pestana: 'proyectos', de: ['extra', 'estados_sin_diccionario'], formato: 'entero', clave: '' },
  { id: 'tiempo_por_etapa', pregunta: 1, pestana: 'proyectos', de: ['extra', 'tiempo_por_etapa'], formato: 'num1', clave: '' },
  { id: 'edad_estado', pregunta: 1, pestana: 'proyectos', de: ['extra', 'edad_estado'], formato: 'entero', clave: '' },
  { id: 'sin_historia', pregunta: 1, pestana: 'proyectos', de: ['extra', 'sin_historia'], formato: 'pct', clave: '' },
  { id: 'dod', pregunta: 2, pestana: 'arnes', de: ['mejora', 'dod'], formato: 'pct', clave: 'dod' },
  { id: 'rework', pregunta: 2, pestana: 'arnes', de: ['mejora', 'rework'], formato: 'pct', clave: 'rework' },
  { id: 'rework_por_causa', pregunta: 2, pestana: 'arnes', de: ['extra', 'rework_por_causa'], formato: 'entero', clave: '' },
  { id: 'rework_por_carril', pregunta: 2, pestana: 'arnes', de: ['extra', 'rework_por_carril'], formato: 'entero', clave: '' },
  { id: 'mutacion', pregunta: 3, pestana: 'arnes', de: ['local', 'mutacion'], formato: 'pct', clave: 'mutacion' },
  { id: 'cobertura_tocada_evaluo', pregunta: 3, pestana: 'arnes', de: ['local', 'cobertura_tocada'], formato: 'pct', clave: 'cobertura_tocada_evaluo' },
  { id: 'qa_guia', pregunta: 3, pestana: 'arnes', de: ['local', 'qa_guia'], formato: 'pct', clave: 'qa_guia' },
  { id: 'gates_dur', pregunta: 3, pestana: 'arnes', de: ['local', 'gates_dur'], formato: 'num1', clave: '' },
  { id: 'bloqueos', pregunta: 4, pestana: 'corridas', de: ['local', 'bloqueos'], formato: 'entero', clave: '' },
  { id: 'frenos', pregunta: 4, pestana: 'arnes', de: ['local', 'frenos'], formato: 'entero', clave: '' },
  { id: 'evidencia_cierre', pregunta: 4, pestana: 'arnes', de: ['local', 'evidencia_cierre'], formato: 'pct', clave: '' },
  { id: 'escapes_regla_dominante', pregunta: 4, pestana: 'arnes', de: ['local', 'escapes_dom'], expr: 'escapesDom', formato: 'pct', clave: 'escapes_regla_dominante' },
  { id: 'reglas_candidatas', pregunta: 4, pestana: 'arnes', de: ['poda', 'candidatas'], formato: 'entero', clave: '' },
  { id: 'reglas_probadas', pregunta: 4, pestana: 'arnes', de: ['poda', 'probadas'], formato: 'pct', clave: '' },
  { id: 'corridas', pregunta: 4, pestana: 'corridas', de: ['local', 'corridas'], formato: 'num1', clave: '' },
  { id: 'pasos', pregunta: 4, pestana: 'corridas', de: ['local', 'pasos'], formato: 'redondo', clave: '' },
  { id: 'carriles', pregunta: 4, pestana: 'arnes', de: ['local', 'carriles'], formato: 'entero', clave: '' },
  { id: 'vueltas_atras', pregunta: 4, pestana: 'arnes', de: ['local', 'vueltas_atras'], formato: 'entero', clave: '' },
  { id: 'bus_factor', pregunta: 5, pestana: 'proyectos', de: ['local', 'bus_factor'], formato: 'entero', clave: 'bus_factor_productos_en_riesgo' },
  { id: 'sin_pipeline_de_prod', pregunta: 5, pestana: 'proyectos', de: ['extra', 'sin_prod'], formato: 'entero', clave: '' },
];
// el título y el para qué de cada ficha viven en la tabla de textos del sitio (`ficha.<id>.*`); acá, en castellano, como
// los copia la guía. La pantalla los pide en el idioma de la página con `tituloDe` y `paraQueDe`
const FICHAS = Object.freeze(DEFINICIONES.map((f) => Object.freeze({ ...f, titulo: t('es', `ficha.${f.id}.titulo`), paraQue: t('es', `ficha.${f.id}.paraQue`) })));

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

// `calculo_caido`: el cálculo común del tablero tiró, y ninguna ficha se pudo saber (no es una foto ilegible)
const MOTIVOS = Object.freeze(['sin_foto', 'vieja', 'sin_buzon', 'solo_en_la_maquina', 'ilegible', 'sin_datos', 'calculo_caido']);

/** El motivo del tablero es texto libre; el sitio manda sólo uno de la lista cerrada. */
function motivoCerrado(texto) {
  const t = String(texto || '');
  if (MOTIVOS.includes(t)) return t;
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
function fichasNoMedidas(ocultas = [], motivo = 'calculo_caido') {
  const fuera = new Set(Array.isArray(ocultas) ? ocultas : []);
  return { lista: FICHAS.filter((f) => !fuera.has(f.id)).map((f) => proyectar(f, { estado: 'no_medido', motivo }, {})), ocultas: FICHAS.filter((f) => fuera.has(f.id)).length };
}

/**
 * Las fichas del sitio a partir de la copia de operaciones (`clon`) y el espejo del buzón: llama al MISMO `colectar()` del
 * tablero nocturno, en su modo de noche (el sitio, igual que el agente de la noche, no es una máquina del equipo). Si el
 * cálculo falla, cada ficha sale «no medida» con el motivo `calculo_caido` y el detalle va a `log`.
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
    // el examen y los casos del banco que trae la copia de operaciones, si los trae (la poda de reglas; la imagen del sitio
    // no trae los del arnés); sin ellos, el camino de siempre. Un enlace de la copia no lleva a leer fuera de ella: ni el
    // archivo, ni una carpeta de más arriba (la ruta real queda adentro), ni un caso de la carpeta (todos archivos comunes)
    const banco = path.join(clon, 'scripts', 'controls-bench');
    const delBanco = (rel, carpeta) => {
      const p = path.join(banco, rel);
      try {
        const s = fs.lstatSync(p);
        if (carpeta ? !s.isDirectory() : !s.isFile()) return undefined;
        const raiz = fs.realpathSync(clon);
        const real = fs.realpathSync(p);
        if (real !== path.join(raiz, path.relative(clon, p))) { log(`${path.relative(clon, p)} de la copia de operaciones pasa por un enlace: la poda usa el del arnés`); return undefined; }
        if (carpeta && fs.readdirSync(p, { withFileTypes: true }).some((e) => !e.isFile())) { log(`${path.relative(clon, p)} de la copia de operaciones trae algo que no es un archivo común: la poda usa los del arnés`); return undefined; }
        return p;
      } catch (e) {
        // que no esté es lo normal; cualquier otra falla se anota y se sigue con el camino de siempre
        if (e && e.code !== 'ENOENT') log(`${path.relative(clon, p)} de la copia de operaciones no se pudo mirar (${e.code || e.name || 'error'}): la poda usa el del arnés`);
        return undefined;
      }
    };
    const d = dashboard.colectar({
      dir: path.join(clon, '.dashboard'), raiz: clon, nocturno: true, config, ahora,
      examen: delBanco('ultimo-examen.json', false), casos: delBanco(path.join('cases', 'advisors'), true),
      hoy: new Date(ahora).toISOString().slice(0, 10),
      mailbox: dirBuzon || undefined,
      estadoBuzon: buzonLeido && dirBuzon ? { estado: 'leido' } : { estado: 'no_leido', motivo: 'el sitio no tiene el buzón de ejecuciones' },
    });
    return modeloDeFichas(d.paneles, { cfg: d.cfg, ocultas });
  } catch (e) {
    log(`las fichas del tablero no se pudieron calcular (${(e && e.code) || (e && e.name) || 'error'}): salen no medidas`);
    return fichasNoMedidas(ocultas);
  }
}

/** La frase de cada motivo de la lista cerrada, en castellano (la de cada idioma, en la tabla: `ficha.motivo.*`). */
const FRASES_MOTIVO = Object.freeze(Object.fromEntries(MOTIVOS.map((m) => [m, t('es', `ficha.motivo.${m}`)])));
const PALABRA = Object.freeze({ ok: 'bien', warn: 'atencion', bad: 'rojo', '': 'medido' });

/** El título y el para qué de una ficha, en un idioma (para la pantalla de Configuración). */
const tituloDe = (id, idioma = 'es') => (FICHAS.some((x) => x.id === id) ? t(idioma, `ficha.${id}.titulo`) : id);
const paraQueDe = (id, idioma = 'es') => (FICHAS.some((x) => x.id === id) ? t(idioma, `ficha.${id}.paraQue`) : '');

/** Una ficha como la del tablero, con el estilo del sitio, en el idioma de la página. */
function tile(f, idioma = 'es') {
  const T = (k, v) => t(idioma, k, v);
  const titulo = tituloDe(f.id, idioma);
  if (f.estado === 'no_medido') {
    const motivo = T(`ficha.motivo.${MOTIVOS.includes(f.motivo) ? f.motivo : 'sin_datos'}`);
    return `<div class="tile blind" data-ficha="${esc(f.id)}">${chip('blind', T('fichas.noMedido'))}<div class="t-label">${esc(titulo)}</div><div class="t-val">${esc(T('fichas.falta'))}</div><div class="t-den">${esc(motivo)}${f.fecha ? ` ${esc(T('fichas.fuenteDelParen', { fecha: f.fecha }))}` : ''}</div></div>`;
  }
  const est = f.estado === 'declarado' ? 'decl' : f.nivel;
  // la etiqueta del denominador sale del tablero de la noche: va tal cual
  const etiq = f.den_etiqueta ? ` ${esc(f.den_etiqueta)}` : '';
  const de = (a, b) => esc(T('fichas.de', { medidos: a, total: b }));
  const den = f.unidad === 'ratio' ? `${de(f.medidos, f.total)}${etiq}` : `n=${f.total && f.total !== f.medidos ? de(f.medidos, f.total) : esc(f.medidos)}${etiq}`;
  return `<div class="tile ${est}" data-ficha="${esc(f.id)}">${chip(est, T(f.estado === 'declarado' ? 'fichas.declarado' : `fichas.${PALABRA[f.nivel] || 'medido'}`))}<div class="t-label">${esc(titulo)}</div><div class="t-val">${esc(formatear(f, idioma))}</div><div class="t-den">${den}</div>${f.fecha ? `<div class="t-den">${esc(T('fichas.fuenteDel', { fecha: f.fecha }))}</div>` : ''}</div>`;
}

/** Las fichas de una pestaña, en una grilla por pregunta (o en una sola, sin título, si `sinPreguntas`). */
function seccionesDe(model, pestana, opciones = {}) {
  // el tercer argumento es el idioma, o las opciones con `idioma`
  const { sinPreguntas = false, idioma = 'es' } = typeof opciones === 'string' ? { idioma: opciones } : (opciones || {});
  const mias = ((model && model.lista) || []).filter((f) => f.pestana === pestana);
  if (!mias.length) return [];
  const grilla = (fs) => `<div class="grid">${fs.map((f) => tile(f, idioma)).join('')}</div>`;
  if (sinPreguntas) return [{ titulo: null, html: grilla(mias) }];
  return PREGUNTAS.map((titulo, n) => ({ titulo: t(idioma, `ficha.pregunta${n}`), fichas: mias.filter((f) => f.pregunta === n) }))
    .filter((g) => g.fichas.length)
    .map((g) => ({ titulo: g.titulo, html: grilla(g.fichas) }));
}

/** La línea que dice cuántas fichas se ocultaron desde Configuración (vacía si ninguna). */
function avisoDeOcultas(model, idioma = 'es') {
  const n = model && Number.isInteger(model.ocultas) ? model.ocultas : 0;
  return n > 0 ? t(idioma, n === 1 ? 'fichas.ocultaUna' : 'fichas.ocultas', { n }) : '';
}

// el separador decimal de cada idioma: coma en castellano, punto en inglés
const FORMATOS = Object.freeze({
  pct: (x) => `${(x * 100).toFixed(0)}%`,
  num1: (x, idioma) => { const s = (Math.round(x * 10) / 10).toString(); return idioma === 'en' ? s : s.replace('.', ','); },
  entero: (x) => String(x),
  redondo: (x) => String(Math.round(x)),
});

/** El número de una ficha tal como se lee. */
function formatear(f, idioma = 'es') {
  if (!f || f.estado === 'no_medido' || f.valor === null) return null;
  return (FORMATOS[f.formato] || FORMATOS.entero)(f.valor, idioma);
}

module.exports = { fichasNoMedidas, fichasDelClon, tile, seccionesDe, avisoDeOcultas, tituloDe, paraQueDe, FRASES_MOTIVO, FICHAS, PREGUNTAS, PESTANAS, YA_EN_EL_SITIO, exprDelTablero, MOTIVOS, motivoCerrado, proyectar, modeloDeFichas, formatear };
