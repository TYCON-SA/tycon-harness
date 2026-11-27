'use strict';
/**
 * layer-probe.js — la prueba de que una capa de la maqueta se abre ENCIMA de su pantalla.
 *
 * La maqueta aprobada marca una pantalla con `presentation: "layer"`: una ventana que se abre al tocar `trigger` en
 * `over`. Construirla en la página pasa los textos (capa 10 de qa-guide.js) y se ve distinta de lo aprobado. Este
 * ayudante toca el botón y anota, en una línea `layer-check {…}`, si apareció algo encima (una ventana con `role="dialog"`,
 * `aria-modal="true"` o un `<dialog open>`, un menú, una lista desplegable o un popover abierto) y cuáles de los textos
 * de la capa están adentro. El campo `dialog` de la línea dice eso: si se abrió algo encima. La línea vale como
 * evidencia sólo en la salida de un humo corrido por smoke-run.sh: la capa 12 de `qa-guide.js --check` la lee de ahí.
 *
 * Con Playwright:
 *   const lp = require('<skill>/scripts/lib/layer-probe.js');
 *   console.log(lp.linea(await lp.probeLayer(page, { screen: 'Probar', trigger: 'Probar', texts: ['Probar la plantilla'] })));
 *
 * Sin navegador (una prueba de componente con jsdom o testing-library), después de tocar el botón:
 *   const antes = lp.antesDe(document);   // antes de tocar el botón: un menú que ya estaba no cuenta
 *   console.log(lp.linea(lp.probeDocument(document, { screen: 'Probar', trigger: 'Probar', texts: [...], antes })));
 */

const PREFIJO = 'layer-check ';
const VENTANAS = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]';
// un menú o una lista desplegable cuentan sólo si aparecieron con el click: uno que ya estaba en la página (la barra, una
// lista de la pantalla de abajo) no es lo que se abrió
const MENUS = '[role="menu"], [role="listbox"]';
const POPOVER = '[popover]:popover-open';
const SELECTOR = `${VENTANAS}, ${MENUS}, ${POPOVER}`;
// la marca que deja probeLayer en los menús visibles antes del click
const ANTES = 'data-layer-probe-antes';

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

/** La línea de evidencia de una capa. */
function linea({ screen, trigger, dialog, texts }) {
  return PREFIJO + JSON.stringify({ screen: String(screen), trigger: String(trigger), dialog: dialog === true, texts: (texts || []).map(String) });
}

/** Las líneas `layer-check` de una salida, ya leídas; una que no se puede leer no cuenta. */
function leer(texto) {
  const out = [];
  for (const l of String(texto || '').split(/\r?\n/)) {
    if (!l.startsWith(PREFIJO)) continue;
    let j;
    try { j = JSON.parse(l.slice(PREFIJO.length)); } catch { continue; }
    if (!j || typeof j.screen !== 'string' || typeof j.dialog !== 'boolean' || !Array.isArray(j.texts)) continue;
    out.push({ screen: j.screen, trigger: typeof j.trigger === 'string' ? j.trigger : '', dialog: j.dialog, texts: j.texts.map(String) });
  }
  return out;
}

// escondido por sí mismo: hidden, aria-hidden o, con el estilo calculado del documento (jsdom lo tiene), display:none o
// visibility:hidden, que es lo que deja una clase de CSS
const escondido = (n) => {
  if (n.hidden || n.getAttribute('aria-hidden') === 'true') return true;
  const win = n.ownerDocument && n.ownerDocument.defaultView;
  if (!win || typeof win.getComputedStyle !== 'function') return false;
  try { const cs = win.getComputedStyle(n); return cs.display === 'none' || cs.visibility === 'hidden'; } catch { return false; }
};
// visible: ni él ni un contenedor suyo escondidos
const visible = (el) => {
  for (let n = el; n && typeof n.getAttribute === 'function'; n = n.parentElement) if (escondido(n)) return false;
  return true;
};
// el texto que se ve de un elemento visible: sin lo de sus hijos escondidos
const textoVisible = (el) => {
  if (!el.childNodes) return el.textContent || '';
  return Array.from(el.childNodes).map((h) => (h.nodeType === 1 ? (typeof h.getAttribute === 'function' && escondido(h) ? '' : textoVisible(h)) : (h.nodeType === 3 ? h.textContent : ''))).join('');
};
const todos = (document, sel) => { try { return Array.from(document.querySelectorAll(sel)); } catch { return []; } };

/** Los menús y las listas visibles ANTES de tocar el botón: se le pasan a probeDocument como `antes`. */
function antesDe(document) {
  return new Set(todos(document, MENUS).filter(visible));
}

/**
 * Lo que está encima en un documento: una ventana, un popover abierto (uno que no sabe de popovers no tiene ninguno) y,
 * con la foto de `antes`, un menú o una lista que no estaban.
 */
function encimaDe(document, antes) {
  const els = [...todos(document, VENTANAS), ...todos(document, POPOVER)];
  if (antes instanceof Set) els.push(...todos(document, MENUS).filter((e) => !antes.has(e)));
  return [...new Set(els)].filter(visible);
}

/**
 * Mira un documento ya abierto: ¿hay algo visible encima, y qué textos de la capa tiene adentro? Para que un menú o una
 * lista desplegable cuenten, `antes` es lo que dio antesDe(document) antes de tocar el botón.
 */
function probeDocument(document, { screen, trigger, texts, antes }) {
  const ventanas = encimaDe(document, antes);
  const adentro = norm(ventanas.map(textoVisible).join(' '));
  return { screen, trigger, dialog: ventanas.length > 0, texts: ventanas.length ? (texts || []).filter((t) => adentro.includes(norm(t))) : [] };
}

/** Con Playwright: toca `trigger` y mira si se abrió algo encima con los textos de la capa. */
async function probeLayer(page, { screen, trigger, texts, timeout = 5000 }) {
  // los menús visibles antes del click quedan marcados: después cuentan sólo los que aparecieron
  let conMenus = false;
  if (typeof page.evaluate === 'function') {
    try {
      await page.evaluate(([sel, marca]) => { for (const e of document.querySelectorAll(sel)) if (e.checkVisibility ? e.checkVisibility() : e.offsetParent !== null) e.setAttribute(marca, ''); }, [MENUS, ANTES]);
      conMenus = true;
    } catch { conMenus = false; }
  }
  const nuevos = MENUS.split(', ').map((s) => `${s}:not([${ANTES}])`).join(', ');
  const boton = page.getByRole('button', { name: trigger, exact: true }).or(page.getByRole('link', { name: trigger, exact: true }));
  await boton.first().click({ timeout });
  const ventana = page.locator(conMenus ? `${VENTANAS}, ${nuevos}, ${POPOVER}` : `${VENTANAS}, ${POPOVER}`).filter({ visible: true });
  try { await ventana.first().waitFor({ state: 'visible', timeout }); } catch { return { screen, trigger, dialog: false, texts: [] }; }
  const adentro = norm((await ventana.allInnerTexts()).join(' '));
  return { screen, trigger, dialog: true, texts: (texts || []).filter((t) => adentro.includes(norm(t))) };
}

module.exports = { PREFIJO, SELECTOR, linea, leer, antesDe, probeDocument, probeLayer };
