// site.js — lo poco que corre en el navegador del sitio de la organización: el tema elegido y
// el filtro de las tablas. Se sirve como archivo (la política no admite scripts en línea) y no pide nada a nadie: filtra
// filas que el servidor ya mandó, filtradas por persona. Se carga en el <head> sin `defer` para poner el tema antes de
// dibujar la página; lo demás espera a DOMContentLoaded.
'use strict';
(function () {
  var raiz = document.documentElement;
  // el tema elegido a mano vive en el navegador de cada uno; sin almacenamiento (ventana privada) queda el del sistema
  function leerTema() { try { return localStorage.getItem('sitio-tema') || 'auto'; } catch (e) { return 'auto'; } }
  function ponerTema(t) {
    if (t === 'light' || t === 'dark') raiz.setAttribute('data-theme', t); else raiz.removeAttribute('data-theme');
    document.querySelectorAll('[data-tema]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-tema') === t)); });
  }
  ponerTema(leerTema());
  document.addEventListener('DOMContentLoaded', function () {
    ponerTema(leerTema());
    document.querySelectorAll('[data-tema]').forEach(function (b) {
      b.addEventListener('click', function () {
        var t = b.getAttribute('data-tema');
        try { if (t === 'auto') localStorage.removeItem('sitio-tema'); else localStorage.setItem('sitio-tema', t); } catch (e) { /* sin almacenamiento: vale para esta página */ }
        ponerTema(t);
      });
    });
    document.querySelectorAll('input[data-filtro]').forEach(function (input) {
      var tabla = document.getElementById(input.getAttribute('data-filtro'));
      if (!tabla) return;
      input.addEventListener('input', function () {
        var q = input.value.trim().toLowerCase();
        tabla.querySelectorAll('tbody tr').forEach(function (tr) {
          tr.hidden = q !== '' && tr.textContent.toLowerCase().indexOf(q) === -1;
        });
        if (tabla.id === 'proyectos') alFiltrarProyectos(tabla, q);
      });
    });
  });
  // Proyectos filtrado: Estimaciones muestra sólo los productos que quedan y el total se rehace con sus números, cada
  // proyecto una vez (dos productos pueden compartirlo); sin filtro, vuelve el texto que mandó el servidor
  var totalOriginal = null;
  function alFiltrarProyectos(tabla, q) {
    var visibles = {};
    var porProyecto = {};
    tabla.querySelectorAll('tbody tr[data-producto]').forEach(function (tr) {
      if (tr.hidden) return;
      visibles[tr.getAttribute('data-producto')] = true;
      try {
        var pp = JSON.parse(tr.getAttribute('data-por-proyecto') || '{}');
        Object.keys(pp).forEach(function (k) { porProyecto[k] = pp[k]; });
      } catch (e) {
        // el servidor escribe el atributo con JSON.stringify: una fila ilegible es un error del sitio, no un dato; no suma y queda dicho
        if (window.console) console.warn('Proyectos: fila con números ilegibles, no se suma al total filtrado:', tr.getAttribute('data-producto'));
      }
    });
    document.querySelectorAll('#tabla-estimaciones tbody tr[data-producto]').forEach(function (tr) {
      tr.hidden = q !== '' && !visibles[tr.getAttribute('data-producto')];
    });
    var total = document.getElementById('proyectos-totales');
    if (!total) return;
    if (totalOriginal === null) totalOriginal = total.textContent;
    if (q === '') { total.textContent = totalOriginal; return; }
    var suma = { enCurso: 0, paradas: 0, sinMedir: 0 };
    Object.keys(porProyecto).forEach(function (k) {
      var c = porProyecto[k] || {};
      suma.enCurso += Number(c.en_curso) || 0;
      suma.paradas += Number(c.paradas) || 0;
      suma.sinMedir += Number(c.sin_medir) || 0;
    });
    total.textContent = (total.getAttribute('data-plantilla') || '').replace(/\{(enCurso|paradas|sinMedir)\}/g, function (_, k) { return String(suma[k]); });
  }
})();
