// site.js — lo poco que corre en el navegador del sitio de la organización (story 2.23, decisión 24): el filtro de las
// tablas. Se sirve como archivo (la política no admite scripts en línea) y no pide nada a nadie: filtra filas que el
// servidor ya mandó, filtradas por persona.
'use strict';
document.addEventListener('DOMContentLoaded', function () {
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
