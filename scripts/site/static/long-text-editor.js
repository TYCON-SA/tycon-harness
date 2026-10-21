'use strict';
/*
 * long-text-editor.js — el editor de texto largo del sitio: una sola pieza para los cuadros de texto largo (las
 * instrucciones de un revisor y «Proponer una mejora» en «Cómo trabaja», y los bloques de texto de Configuración).
 *
 * Toma un <textarea> y le pone alrededor: «Escribir / Vista previa», «Buscar», «Ver qué cambió» (contra el texto con
 * que se abrió) y «Ampliar» (a pantalla completa, con números de renglón; «Volver» o Esc lo devuelven). El cuadro
 * crece con el texto. Sin editores de terceros: lo que escribe la persona nunca se ejecuta, la vista previa escapa
 * todo y sólo reconoce títulos (##, ###), listas (-) y código en línea (`…`).
 *
 * En el navegador queda como `window.LongTextEditor`; en Node (las pruebas) se exportan las partes que deciden algo:
 * `vistaPrevia`, `queCambio`, `hayCambios`, `buscar` y `siguiente`.
 */
(function (raiz) {
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function enLinea(s) { return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>'); }

  /** El HTML de la vista previa: títulos, listas, código en línea y párrafos; el resto, escapado. */
  function vistaPrevia(texto) {
    var out = []; var lista = null; var parrafo = [];
    function cerrarParrafo() { if (parrafo.length) { out.push('<p>' + parrafo.map(enLinea).join('<br>') + '</p>'); parrafo = []; } }
    function cerrarLista() { if (lista) { out.push('<ul>' + lista.join('') + '</ul>'); lista = null; } }
    String(texto || '').split('\n').forEach(function (l) {
      var t = /^(#{2,3})\s+(.*)$/.exec(l);
      var li = /^\s*[-*]\s+(.*)$/.exec(l);
      if (t) { cerrarParrafo(); cerrarLista(); out.push('<h' + t[1].length + '>' + enLinea(t[2]) + '</h' + t[1].length + '>'); }
      else if (li) { cerrarParrafo(); (lista = lista || []).push('<li>' + enLinea(li[1]) + '</li>'); }
      else if (!l.trim()) { cerrarParrafo(); cerrarLista(); }
      else { cerrarLista(); parrafo.push(l); }
    });
    cerrarParrafo(); cerrarLista();
    return out.join('');
  }

  /**
   * Lo que cambió, renglón por renglón: `[['igual'|'menos'|'mas', renglón], …]`. Los renglones iguales del principio y
   * del final se sacan antes de comparar el medio (la subsecuencia común más larga), así un texto largo con un cambio
   * chico no cuesta nada.
   */
  function queCambio(antes, ahora) {
    var a = String(antes == null ? '' : antes).split('\n'); var b = String(ahora == null ? '' : ahora).split('\n');
    var ini = 0; while (ini < a.length && ini < b.length && a[ini] === b[ini]) ini++;
    var fa = a.length; var fb = b.length; while (fa > ini && fb > ini && a[fa - 1] === b[fb - 1]) { fa--; fb--; }
    var ma = a.slice(ini, fa); var mb = b.slice(ini, fb);
    var n = ma.length; var m = mb.length; var lcs = [];
    for (var i = 0; i <= n; i++) { lcs.push(new Array(m + 1).fill(0)); }
    for (i = n - 1; i >= 0; i--) for (var j = m - 1; j >= 0; j--) lcs[i][j] = ma[i] === mb[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    var medio = []; i = 0; j = 0;
    while (i < n && j < m) {
      if (ma[i] === mb[j]) { medio.push(['igual', ma[i]]); i++; j++; }
      else if (lcs[i + 1][j] >= lcs[i][j + 1]) { medio.push(['menos', ma[i]]); i++; }
      else { medio.push(['mas', mb[j]]); j++; }
    }
    while (i < n) medio.push(['menos', ma[i++]]);
    while (j < m) medio.push(['mas', mb[j++]]);
    return a.slice(0, ini).map(function (l) { return ['igual', l]; }).concat(medio, a.slice(fa).map(function (l) { return ['igual', l]; }));
  }
  function hayCambios(d) { return d.some(function (x) { return x[0] !== 'igual'; }); }

  /**
   * Dónde aparece `q` en `texto`, sin mirar mayúsculas: las posiciones en el texto tal cual (una letra que cambia de
   * largo al pasar a minúscula, como «İ», no las corre).
   */
  function buscar(texto, q) {
    var out = []; if (!q) return out;
    var t = String(texto); var b = String(q);
    var re = new RegExp(b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'); var m;
    while ((m = re.exec(t)) !== null) { out.push(m.index); if (!m[0].length) re.lastIndex++; }
    return out;
  }
  /** La siguiente aparición después de `desde`; después de la última, la primera; sin apariciones, -1. */
  function siguiente(posiciones, desde) {
    if (!posiciones.length) return -1;
    for (var k = 0; k < posiciones.length; k++) if (posiciones[k] > desde) return posiciones[k];
    return posiciones[0];
  }

  /**
   * Monta el editor alrededor de `ta`. `opciones`: `textos` (las etiquetas, en el idioma de la página), `vistaPrevia`
   * y `queCambio` (si llevan esas solapas), `alCambiar` (se llama en cada cambio del texto). Devuelve el contenedor.
   */
  function montar(ta, opciones) {
    // el original de «Ver qué cambió»: el que pase quien lo monta (si la pantalla se redibuja con un borrador), o el de hoy
    var o = opciones || {}; var T = o.textos || {}; var original = originalDe(ta.value, o);
    var doc = ta.ownerDocument;
    function el(tag, a, hijos) { var e = doc.createElement(tag); for (var k in a || {}) { if (a[k] == null) continue; if (k === 'text') e.textContent = a[k]; else if (k.slice(0, 2) === 'on') e[k] = a[k]; else e.setAttribute(k, a[k]); } (hijos || []).forEach(function (h) { if (h) e.appendChild(h); }); return e; }
    var caja = el('div', { class: 'lte' });
    var escribir = el('button', { type: 'button', role: 'tab', 'aria-selected': 'true', 'data-lte': 'escribir', text: T.escribir || 'Escribir' });
    var previa = o.vistaPrevia ? el('button', { type: 'button', role: 'tab', 'aria-selected': 'false', 'data-lte': 'previa', text: T.vistaPrevia || 'Vista previa' }) : null;
    var bBuscar = el('button', { type: 'button', class: 'btn', 'aria-expanded': 'false', 'data-lte': 'buscar', text: T.buscar || 'Buscar' });
    var bCambios = o.queCambio ? el('button', { type: 'button', class: 'btn', 'aria-expanded': 'false', 'data-lte': 'cambios', text: T.queCambio || 'Ver qué cambió' }) : null;
    var bAmpliar = el('button', { type: 'button', class: 'btn', 'data-lte': 'ampliar', text: T.ampliar || 'Ampliar' });
    var bVolver = el('button', { type: 'button', class: 'btn', hidden: 'hidden', 'data-lte': 'volver', text: T.volver || 'Volver' });
    var barra = el('div', { class: 'lte-barra' }, [el('div', { class: 'lte-solapas', role: 'tablist' }, [escribir, previa]), el('div', { class: 'lte-acciones' }, [bBuscar, bCambios, bAmpliar, bVolver])]);
    var q = el('input', { type: 'search', 'aria-label': T.buscarQue || 'Buscar', placeholder: T.buscarQue || 'Buscar' });
    var cuenta = el('span', { class: 'lte-cuenta', 'aria-live': 'polite' });
    var bSig = el('button', { type: 'button', class: 'btn', text: T.siguiente || 'Siguiente' });
    var fila = el('div', { class: 'lte-buscar', hidden: 'hidden' }, [q, cuenta, bSig]);
    var renglones = el('pre', { class: 'lte-renglones', 'aria-hidden': 'true', hidden: 'hidden' });
    var cuerpo = el('div', { class: 'lte-cuerpo' }, [renglones]);
    var vista = el('div', { class: 'lte-previa', hidden: 'hidden' });
    var cambios = el('div', { class: 'lte-cambios', hidden: 'hidden', 'aria-live': 'polite' });
    ta.parentNode.insertBefore(caja, ta);
    cuerpo.appendChild(ta);
    caja.appendChild(barra); caja.appendChild(fila); caja.appendChild(cuerpo); caja.appendChild(vista); caja.appendChild(cambios);
    ta.classList.add('lte-texto');
    function crecer() { if (caja.classList.contains('ampliado')) return; ta.style.height = 'auto'; ta.style.height = Math.max(ta.scrollHeight + 2, 120) + 'px'; }
    function numerar() { var n = ta.value.split('\n').length; var s = ''; for (var i = 1; i <= n; i++) s += i + '\n'; renglones.textContent = s; }
    function mostrarCambios() {
      var d = queCambio(original, ta.value); cambios.textContent = '';
      if (!hayCambios(d)) { cambios.appendChild(el('p', { class: 'ct-nota', text: T.sinCambios || 'Todavía no cambiaste nada.' })); return; }
      d.forEach(function (x) { cambios.appendChild(el('div', { class: 'lte-' + x[0], text: (x[0] === 'mas' ? '+ ' : x[0] === 'menos' ? '− ' : '  ') + x[1] })); });
    }
    ta.addEventListener('input', function () { crecer(); numerar(); if (!cambios.hidden) mostrarCambios(); if (o.alCambiar) o.alCambiar(); });
    function modo(cual) {
      escribir.setAttribute('aria-selected', String(cual === 'escribir')); if (previa) previa.setAttribute('aria-selected', String(cual === 'previa'));
      cuerpo.hidden = cual !== 'escribir'; vista.hidden = cual !== 'previa';
      if (cual === 'previa') vista.innerHTML = vistaPrevia(ta.value);
    }
    escribir.onclick = function () { modo('escribir'); };
    if (previa) previa.onclick = function () { modo('previa'); };
    if (bCambios) bCambios.onclick = function () { var abrir = cambios.hidden; cambios.hidden = !abrir; bCambios.setAttribute('aria-expanded', String(abrir)); if (abrir) mostrarCambios(); };
    var desde = -1;
    function contar() { var p = buscar(ta.value, q.value); cuenta.textContent = q.value ? (p.length === 1 ? (T.unaVez || 'aparece 1 vez') : (T.vecesN || 'aparece {n} veces').replace('{n}', String(p.length))) : ''; return p; }
    function irASiguiente() { var p = contar(); var i = siguiente(p, desde); if (i < 0) return; desde = i; modo('escribir'); ta.focus(); ta.setSelectionRange(i, i + q.value.length); }
    bBuscar.onclick = function () { var abrir = fila.hidden; fila.hidden = !abrir; bBuscar.setAttribute('aria-expanded', String(abrir)); if (abrir) q.focus(); };
    q.addEventListener('input', function () { desde = -1; contar(); });
    q.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); irASiguiente(); } });
    bSig.onclick = irASiguiente;
    function reducir() { caja.classList.remove('ampliado'); renglones.hidden = true; bVolver.hidden = true; bAmpliar.hidden = false; crecer(); bAmpliar.focus(); }
    bAmpliar.onclick = function () { caja.classList.add('ampliado'); numerar(); renglones.hidden = false; bVolver.hidden = false; bAmpliar.hidden = true; ta.style.height = ''; ta.focus(); };
    bVolver.onclick = reducir;
    caja.addEventListener('keydown', function (e) { if (e.key === 'Escape' && caja.classList.contains('ampliado')) { e.preventDefault(); reducir(); } });
    crecer(); numerar();
    // montado fuera de la página o adentro de algo cerrado (un desplegable, una sección oculta) no se puede medir: cuando
    // la caja pasa a verse, se vuelve a medir el alto (ResizeObserver avisa al pasar de ancho 0 a uno de verdad)
    var ancho = 0;
    if (typeof ResizeObserver === 'function') new ResizeObserver(function () { var w = caja.clientWidth; if (hayQueMedir(ancho, w)) { ancho = w; crecer(); } }).observe(caja);
    return caja;
  }

  /** El texto contra el que compara «Ver qué cambió»: el que pase quien monta el editor, o el que tiene el cuadro. */
  function originalDe(valor, opciones) { return opciones && typeof opciones.original === 'string' ? opciones.original : valor; }
  /** ¿Se vuelve a medir el alto? Cuando la caja se ve (ancho distinto de 0) y su ancho cambió desde la última medida. */
  function hayQueMedir(antes, ahora) { return Boolean(ahora) && ahora !== antes; }

  var api = { vistaPrevia: vistaPrevia, queCambio: queCambio, hayCambios: hayCambios, buscar: buscar, siguiente: siguiente, originalDe: originalDe, hayQueMedir: hayQueMedir, montar: montar };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.LongTextEditor = api;
})(typeof window !== 'undefined' ? window : this);
