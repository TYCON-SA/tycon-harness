'use strict';
/**
 * layer-probe.js — la prueba de que una capa de la maqueta se abre ENCIMA de su pantalla.
 *
 * La maqueta aprobada marca una pantalla con `presentation: "layer"`: una ventana que se abre al tocar `trigger` en
 * `over`. Construirla en la página pasa los textos (capa 10 de qa-guide.js) y se ve distinta de lo aprobado. Este
 * ayudante toca el botón y anota, en una línea `layer-check {…}`, si apareció una ventana encima (`role="dialog"`,
 * `aria-modal="true"` o un `<dialog open>`) y cuáles de los textos de la capa están adentro. La línea vale como
 * evidencia sólo en la salida de un humo corrido por smoke-run.sh: la capa 12 de `qa-guide.js --check` la lee de ahí.
 *
 * Con Playwright:
 *   const lp = require('<skill>/scripts/lib/layer-probe.js');
 *   console.log(lp.linea(await lp.probeLayer(page, { screen: 'Probar', trigger: 'Probar', texts: ['Probar la plantilla'] })));
 *
 * Sin navegador (una prueba de componente con jsdom o testing-library), después de tocar el botón:
 *   console.log(lp.linea(lp.probeDocument(document, { screen: 'Probar', trigger: 'Probar', texts: [...] })));
 */

const PREFIJO = 'layer-check ';
const SELECTOR = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]';

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

const visible = (el) => !el.hidden && el.getAttribute('aria-hidden') !== 'true';

/** Mira un documento ya abierto: ¿hay una ventana visible encima, y qué textos de la capa tiene adentro? */
function probeDocument(document, { screen, trigger, texts }) {
  const ventanas = Array.from(document.querySelectorAll(SELECTOR)).filter(visible);
  const adentro = norm(ventanas.map((v) => v.textContent).join(' '));
  return { screen, trigger, dialog: ventanas.length > 0, texts: ventanas.length ? (texts || []).filter((t) => adentro.includes(norm(t))) : [] };
}

/** Con Playwright: toca `trigger` y mira si se abrió una ventana encima con los textos de la capa. */
async function probeLayer(page, { screen, trigger, texts, timeout = 5000 }) {
  const boton = page.getByRole('button', { name: trigger, exact: true }).or(page.getByRole('link', { name: trigger, exact: true }));
  await boton.first().click({ timeout });
  const ventana = page.locator(SELECTOR).filter({ visible: true });
  try { await ventana.first().waitFor({ state: 'visible', timeout }); } catch { return { screen, trigger, dialog: false, texts: [] }; }
  const adentro = norm((await ventana.allInnerTexts()).join(' '));
  return { screen, trigger, dialog: true, texts: (texts || []).filter((t) => adentro.includes(norm(t))) };
}

module.exports = { PREFIJO, SELECTOR, linea, leer, probeDocument, probeLayer };
