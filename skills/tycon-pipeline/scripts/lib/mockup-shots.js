'use strict';
/**
 * mockup-shots.js — la maqueta mirada con un navegador antes de pedir su aprobación.
 *
 * La maqueta es un HTML: que pase `mockup.js check` dice que es estática y no carga nada, no que se pueda leer. Una marca
 * dibujada encima del contenido, zonas lado a lado que no entran en el ancho o un texto partido letra por letra pasan el
 * check y llegan al dueño. Acá se abre con el Playwright fijado del arnés (scripts/lib/pinned-playwright.js, sin red: la
 * maqueta no carga nada) a 1440 y a 390 px, se guarda una captura de cada ancho y se buscan tres cosas en la página:
 *   - desborde: la página es más ancha que la ventana;
 *   - textos que se pisan: dos textos visibles cuyas cajas se cruzan (lo que está detrás de una ventana, marcado
 *     `aria-hidden`, no cuenta);
 *   - palabras partidas: una palabra que el navegador cortó en dos renglones.
 * El informe queda al lado de la maqueta (`<clave>-mockup-review.json`), atado a la huella del HTML: «Aprobar el plan» no
 * cierra sin un informe de esa misma maqueta y sin hallazgos (`problemaDeLaRevision`).
 */
const fs = require('fs');
const path = require('path');

const WIDTHS = [1440, 390];
const HEIGHT = 900;
const MAX_FINDINGS = 12;

/** Dónde van el informe y las capturas de la maqueta `mockupPath` (`.../1.1-mockup.html`). */
function shotsPaths(mockupPath) {
  const base = String(mockupPath).replace(/\.html?$/i, '');
  return { report: `${base}-review.json`, shots: Object.fromEntries(WIDTHS.map((w) => [w, `${base}-${w}.png`])) };
}

// Corre en la página: los hallazgos de ese ancho. Sin dependencias: se manda como texto a `page.evaluate`.
function medirEnLaPagina(max) {
  const out = [];
  const W = window.innerWidth;
  const sw = document.documentElement.scrollWidth;
  if (sw > W + 1) out.push({ kind: 'desborde', what: `la página mide ${sw} px de ancho y la ventana ${W}: hay que correrla de costado` });
  // lo que no se ve no cuenta: lo marcado `aria-hidden` (la pantalla detrás de una ventana) y lo invisible
  const oculto = (el) => {
    if (el.closest('[aria-hidden="true"]')) return true;
    const s = getComputedStyle(el);
    return s.visibility !== 'visible' || Number(s.opacity) === 0;
  };
  const visible = (r) => r.width > 0 && r.height > 0;
  // lo recortado: un recuadro que esconde lo que no entra (overflow hidden o clip) y tiene contenido más ancho
  for (const el of document.body.querySelectorAll('*')) {
    if (out.length >= max) break;
    const ox = getComputedStyle(el).overflowX;
    if ((ox === 'hidden' || ox === 'clip') && el.scrollWidth > el.clientWidth + 1 && !oculto(el)) {
      out.push({ kind: 'recortado', what: `un recuadro de ${el.clientWidth} px esconde contenido de ${el.scrollWidth} px («${(el.textContent || '').trim().slice(0, 40)}»)` });
    }
  }
  // los textos: cada nodo de texto con sus cajas renglón por renglón (las del elemento entero se cruzan entre dos textos
  // seguidos en el mismo párrafo, sin que se pisen)
  const range = document.createRange();
  const cajasDe = (n) => { range.selectNodeContents(n); return [...range.getClientRects()].filter(visible); };
  const textos = [];
  const todos = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = todos.nextNode(); n; n = todos.nextNode()) {
    if (!n.textContent.trim() || !n.parentElement || oculto(n.parentElement)) continue;
    const cajas = cajasDe(n);
    if (cajas.length) textos.push({ n, cajas, t: n.textContent.trim().slice(0, 40) });
  }
  const cruza = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2;
  for (let i = 0; i < textos.length && out.length < max; i++) {
    for (let j = i + 1; j < textos.length && out.length < max; j++) {
      const a = textos[i];
      const b = textos[j];
      if (a.cajas.some((x) => b.cajas.some((y) => cruza(x, y)))) out.push({ kind: 'se pisan', what: `«${a.t}» y «${b.t}» se dibujan uno encima del otro` });
    }
  }
  // las palabras partidas: una palabra de dos letras o más cuyo dibujo ocupa más de un renglón. Donde el navegador corta
  // un renglón a propósito separa palabras: el guion, el guion blando, la barra y lo que corta una dirección (? & =).
  // La escritura sin espacios (japonés, chino) se corta entre letras: no cuenta
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n && out.length < max; n = walker.nextNode()) {
    if (!n.parentElement || oculto(n.parentElement)) continue;
    const re = /[^\s\-‐–—/­?&=]{2,}/g;
    for (let m = re.exec(n.textContent); m && out.length < max; m = re.exec(n.textContent)) {
      if (/[　-鿿가-힯＀-￯]/.test(m[0])) continue;
      // al lado de un guion blando, el navegador mide el corte junto con la palabra: ese corte es a propósito
      if (n.textContent[m.index - 1] === '­' || n.textContent[m.index + m[0].length] === '­') continue;
      range.setStart(n, m.index);
      range.setEnd(n, m.index + m[0].length);
      // una caja de menos de 2 px es la del corte mismo (el guion blando la deja), no un pedazo de la palabra
      const tops = new Set([...range.getClientRects()].filter((r) => r.width >= 2 && r.height > 0).map((r) => Math.round(r.top)));
      if (tops.size > 1) out.push({ kind: 'palabra partida', what: `«${m[0].slice(0, 40)}» queda cortada en ${tops.size} renglones` });
    }
  }
  return out;
}

/**
 * Abre la maqueta a 1440 y 390 px, guarda las capturas y escribe el informe. `{ ok, report, shots, findings }`, o
 * `{ error }` si no se pudo medir (sin el Playwright fijado, o el navegador no arrancó): nunca «sin hallazgos».
 * `pw` (opcional): el módulo de Playwright, para las pruebas.
 */
async function revisar({ mockupPath, pw, env = process.env } = {}) {
  let html;
  try { html = fs.readFileSync(mockupPath, 'utf8'); } catch (e) { return { error: `no pude leer la maqueta ${mockupPath} (${e.code || e.message})` }; }
  const pinned = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'pinned-playwright.js'));
  const modulo = pw || pinned.load({ env });
  if (!modulo) return { error: `no hay navegador para mirarla: ${pinned.locate({ env }).why}` };
  const { report, shots } = shotsPaths(mockupPath);
  let browser;
  const findings = [];
  try {
    browser = await modulo.chromium.launch({ headless: true });
    for (const w of WIDTHS) {
      const page = await browser.newPage({ viewport: { width: w, height: HEIGHT } });
      // la maqueta no carga nada (su política lo niega): igual se corta toda red que no sea el archivo
      await page.route('**/*', (r) => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
      // la dirección del archivo bien escrita: una carpeta con «#», «?» o «%» se abre igual
      await page.goto(require('url').pathToFileURL(path.resolve(mockupPath)).href, { waitUntil: 'load' });
      await page.screenshot({ path: shots[w], fullPage: true });
      const deEste = await page.evaluate(medirEnLaPagina, MAX_FINDINGS);
      for (const f of deEste) findings.push({ width: w, ...f });
      await page.close();
    }
  } catch (e) {
    return { error: `el navegador no pudo mirar la maqueta (${String((e && e.message) || e).split('\n')[0]})` };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  const sha256 = require('../mockup.js').mockupHash(html);
  escribirInforme({ report, file: path.basename(mockupPath), sha256, shots, findings });
  return { ok: findings.length === 0, report, shots, findings };
}

/** El informe al lado de la maqueta. También lo usan las pruebas que no abren un navegador. */
function escribirInforme({ report, file, sha256, shots, findings }) {
  const data = { schema: 1, file, sha256, widths: WIDTHS, shots: Object.fromEntries(Object.entries(shots).map(([w, p]) => [w, path.basename(p)])), findings, at: new Date().toISOString() };
  fs.writeFileSync(report, `${JSON.stringify(data, null, 2)}\n`);
  return data;
}

/**
 * ¿La maqueta `mockupPath` (con su HTML `html`) tiene su revisión con navegador, de esa misma versión y sin hallazgos?
 * null = sí; si no, `{ motivo, extra }` para el freno, con el comando que la hace.
 */
function problemaDeLaRevision({ mockupPath, html, mockupJs }) {
  const { report, shots } = shotsPaths(mockupPath);
  const comando = `node ${mockupJs} shots ${mockupPath}`;
  let data;
  try { data = JSON.parse(fs.readFileSync(report, 'utf8')); } catch (e) {
    const motivo = e && e.code === 'ENOENT' ? 'nadie la miró con un navegador' : `su revisión con navegador no se puede leer (${(e && (e.code || e.message)) || e})`;
    return { motivo: `la maqueta no se pide aprobar sin mirarla: ${motivo} (${report})`, extra: [`Miralas: ${comando}   (capturas a 1440 y 390 px; frena si algo se pisa, desborda o parte una palabra)`] };
  }
  const sha = require('../mockup.js').mockupHash(html);
  if (!data || data.sha256 !== sha) return { motivo: 'la maqueta cambió después de su revisión con navegador', extra: [`Volvé a mirarla: ${comando}`] };
  const f = Array.isArray(data.findings) ? data.findings : null;
  if (!f) return { motivo: `la revisión con navegador no dice sus hallazgos (${report})`, extra: [`Volvé a mirarla: ${comando}`] };
  if (f.length) {
    return { motivo: `la maqueta no se lee bien en el navegador (${f.length} hallazgo(s)): arreglala y volvé a mirarla`,
      extra: [...f.slice(0, 8).map((x) => `- a ${x.width} px, ${x.kind}: ${x.what}`), `Capturas: ${Object.values(shots).join(' · ')}`, `Después: ${comando}`] };
  }
  return null;
}

module.exports = { WIDTHS, shotsPaths, revisar, escribirInforme, problemaDeLaRevision, medirEnLaPagina };
