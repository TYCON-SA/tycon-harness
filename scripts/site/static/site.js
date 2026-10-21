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
      });
    });
  });
})();
