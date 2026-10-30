'use strict';
/*
 * spanish-text.js — el detector de castellano de las pruebas del sitio en inglés.
 *
 * Un texto visible está en castellano si tiene una letra acentuada, ñ, ¿ o ¡, o una palabra común del castellano que
 * no es una palabra del inglés. Lo usan site-texts.test.js (cada página en inglés), install-effects.test.js (el inglés
 * de cada pieza) y la prueba en vivo del sitio en inglés.
 */

const PALABRAS = new Set(('el la los las del que con para una uno unos unas por sin como cómo qué cuál cuando cuándo dónde ' +
  'está están esta este estos estas ese esa eso hay son ser fue tiene tienen todavía también desde hasta cada sus tus ' +
  'nada ningún ninguno ninguna más menos días hoy ayer ver entrar salir página sitio fuente fuentes medido medida falta ' +
  'pedido pedidos ejecuciones ejecución tuyas tuyos lista cuenta cambio cambios guardar proponer revisar descargar quién ' +
  'otra otro mantiene arnés prueba pruebas producción configuración sección secciones ayuda proyectos inicio tema claro oscuro ' +
  'versión nueva nuevo nuevos abiertos abiertas cerrados vencen vence decidir asignado asignada bloqueadas paradas curso ' +
  'aprobación vigilado vulnerabilidades vivas paridad orden filtrar compartido licencia créditos componentes terceros ' +
  'todavía cargando frenado ' +
  // las once sin tilde que se escapaban en los denominadores y en Mantenimiento
  'registros chequeos entradas veces decisiones salteadas aceptada vencida pendiente tarea semana ' +
  // los ids en castellano de las fuentes de la noche, que una página en inglés no puede mostrar («Source …»)
  'dependencias vigilante banco concentracion').split(/\s+/).filter(Boolean));
const ACENTO = /[áéíóúñ¿¡]/i;
// lo que se permite en cualquier idioma: el nombre del idioma en el selector
const PERMITIDOS = new Set(['Español']);

/** Los textos visibles de una página: lo que queda entre etiquetas, y los atributos que se leen (aria-label, title, alt, placeholder). */
function textosVisibles(html) {
  const sinCodigo = html.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '');
  const out = [];
  for (const m of sinCodigo.matchAll(/\b(?:aria-label|title|alt|placeholder)="([^"]*)"/g)) out.push(m[1]);
  for (const t of sinCodigo.replace(/<[^>]*>/g, '\n').split('\n')) out.push(t);
  return out.map((t) => t.replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** Los textos en castellano de una lista, sin los `datos` de afuera (se sacan por valor). */
function enCastellano(textos, datos = []) {
  return textos.filter((t) => {
    let s = ` ${t} `;
    for (const d of datos) s = s.split(d).join(' ');
    for (const p of PERMITIDOS) s = s.split(p).join(' ');
    if (ACENTO.test(s)) return true;
    return s.toLowerCase().split(/[^a-záéíóúñü]+/).some((w) => PALABRAS.has(w));
  });
}

module.exports = { PALABRAS, ACENTO, PERMITIDOS, textosVisibles, enCastellano };
