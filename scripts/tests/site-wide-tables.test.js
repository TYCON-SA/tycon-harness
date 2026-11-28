'use strict';
// site-wide-tables.test.js — una tabla del sitio más ancha que la pantalla avisa que se desplaza y no pierde la fila.
//
// 🔴 Falla con: «Cómo va cada producto» (Proyectos) cortada a 1280 px y en el celular sin nada que diga que hay más
// columnas a la derecha (recorrido del sitio del 27/11): la paridad y las horas reales no se veían. Ahora la caja que
// envuelve las tablas anchas lleva una sombra en el borde que se puede desplazar (sólo CSS: la sombra se va cuando se
// llega al final), y en la de productos la primera columna queda fija al desplazar.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'site', 'static', 'site.css'), 'utf8');
const regla = (sel) => {
  const re = new RegExp(`(?:^|[}\\s])${sel.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&')}\\{([^}]*)\\}`, 'm');
  const m = re.exec(CSS);
  return m ? m[1] : null;
};

test('W1 TablaAncha_AvisaQueSeDesplaza — sombras en los bordes que siguen al desplazamiento', () => {
  const r = regla('.tbl-wrap');
  assert.ok(r, 'la regla de .tbl-wrap');
  assert.match(r, /overflow-x:auto/);
  // las cubiertas se mueven con el contenido (local) y las sombras quedan quietas (scroll): sin desplazamiento posible
  // las cubiertas tapan las sombras; con más a la derecha, la sombra de la derecha se ve
  assert.match(r, /background:[^;]*\blocal\b[^;]*\bscroll\b/, `sin las sombras de desplazamiento: ${r}`);
  assert.match(r, /var\(--surface\)/, 'las cubiertas son del color de la tarjeta');
});

test('W2 Productos_PrimeraColumnaFija — al desplazar se sigue viendo de qué producto es la fila', () => {
  const cuerpo = regla('table.tabla#proyectos tbody th');
  assert.ok(cuerpo, 'la regla de la primera columna de productos');
  assert.match(cuerpo, /position:sticky/);
  assert.match(cuerpo, /left:0/);
  assert.match(cuerpo, /background:var\(--surface\)/, 'con fondo: si no, las otras columnas se ven por debajo');
});
