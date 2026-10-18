'use strict';
/*
 * help.js — LA AYUDA DEL SITIO: la guía del sitio de la organización, partida por rol y armada en el servidor.
 *
 * Qué resuelve: quien usa o configura el sitio tiene la guía adentro, en la pestaña «Ayuda», sin ir a buscarla al repo.
 * La fuente es UNA: la guía que viaja en la imagen (`guides/organization-site.md` y su versión en inglés, con la
 * carpeta de capturas). La página se arma al pedirla, así que no hay una segunda copia que se desactualice.
 *
 * Quién ve qué: cada sección `##` de la guía tiene sus roles en `SECCIONES`, una tabla cerrada. Una sección que la tabla
 * no conoce no se muestra a nadie (lo nuevo no queda a la vista por omisión) y la prueba frena. El filtro corre acá, en
 * el servidor: a quien no mantiene nunca le llega el texto de instalación.
 *
 * El markdown se arma escapado: títulos, párrafos, listas, citas, código, tablas, enlaces e imágenes. Cualquier HTML del
 * archivo sale como texto; un enlace sólo es `https://` o `#ancla`; una imagen, sólo una captura de la guía, servida por
 * `/ayuda/capturas/<nombre>.png`. Sin librerías.
 *
 * El idioma de cada pedido lo decide un solo lugar (`idiomaDe`); los textos propios de la página están juntos en `TEXTOS`.
 *
 * Contrato con server.js: crearRutas({ raiz, log }) → las rutas de la ayuda (con su pestaña). Casos:
 * scripts/tests/site-help.test.js.
 */
const fs = require('fs');
const path = require('path');
const views = require('./views.js');
const { t } = require('./texts.js');
const LANG = require('./language.js');

// sin ninguna guía en la imagen, la página dice dónde está en el repo del arnés (el código del sitio no nombra organizaciones)
const RUTA_DE_LA_GUIA = 'guides/organization-site.md';
const ARCHIVO = { es: 'organization-site.md', en: 'organization-site.en.md' };
// los textos de la página, los que dice la ayuda además de la guía: viven en la tabla del sitio (texts.js, `ayuda.*`)
const TEXTOS = Object.freeze({
  idioma: (de, i) => t(de, `ayuda.idioma.${i}`),
  otroIdioma: (de, falta, se) => t(de, 'ayuda.otroIdioma', { falta, se }),
  sinGuia: (de, ruta) => `${esc(t(de, 'ayuda.sinGuiaAntes'))}<code>${esc(ruta)}</code>${esc(t(de, 'ayuda.sinGuiaDespues'))}`,
  noSePudoLeer: (de, codigo) => esc(t(de, 'ayuda.noSePudoLeer', { codigo })),
  ledeMantiene: (de) => t(de, 'ayuda.ledeMantiene'),
  ledePersona: (de) => t(de, 'ayuda.ledePersona'),
});

/** El idioma de la ayuda en este pedido: el de la página. Es el único lugar que lo decide. */
const idiomaDe = (ctx) => LANG.valido(ctx && ctx.idioma) || LANG.POR_DEFECTO;
const CAPTURAS = path.join('guides', 'sitio-de-la-organizacion', 'capturas');
const CAPTURA = /^[a-z0-9][a-z0-9-]*\.png$/;
const TODOS = Object.freeze(['maintainer', 'person']);
const MANTIENE = Object.freeze(['maintainer']);

/** Los roles de cada sección `##`, en el orden de la guía. Las dos guías dan los mismos roles, sección por sección. */
const SECCIONES = Object.freeze({
  es: Object.freeze({
    'Qué es y para qué sirve': TODOS,
    'El primer ingreso': TODOS,
    'Las pestañas': TODOS,
    'Configuración, sección por sección': MANTIENE,
    'Qué ve cada rol': TODOS,
    'Problemas comunes': TODOS,
    'Qué hace falta antes': MANTIENE,
    'Probarlo en tu máquina con Docker': MANTIENE,
    'Lo común a cualquier instalación': MANTIENE,
    'Las recetas': MANTIENE,
    'Por dentro, para quien mantiene el arnés': MANTIENE,
  }),
  en: Object.freeze({
    'What it is and what it is for': TODOS,
    'Signing in for the first time': TODOS,
    'The tabs': TODOS,
    'Configuration, section by section': MANTIENE,
    'What each role sees': TODOS,
    'Common problems': TODOS,
    'What you need first': MANTIENE,
    'Try it on your machine with Docker': MANTIENE,
    'Common to every installation': MANTIENE,
    'The recipes': MANTIENE,
    'Inside, for whoever maintains the harness': MANTIENE,
  }),
});

/** Las secciones `##` de un markdown: [{ titulo, texto }]; la primera es lo de antes del primer `##` (sin título). */
function partir(md) {
  const out = [];
  let actual = { titulo: null, lineas: [] };
  let enCodigo = false;
  for (const l of String(md).split('\n')) {
    if (/^```/.test(l)) enCodigo = !enCodigo;
    const m = !enCodigo && /^## (.+)$/.exec(l);
    if (m) { out.push(actual); actual = { titulo: m[1].trim(), lineas: [] }; }
    actual.lineas.push(l);
  }
  out.push(actual);
  return out.map((s) => ({ titulo: s.titulo, texto: s.lineas.join('\n') }));
}

/** Lo que ve `rol`: el comienzo y las secciones con ese rol. `desconocidas`: las que la tabla no conoce (no se muestran). */
function paraRol(md, idioma, rol) {
  const tabla = SECCIONES[idioma] || {};
  const partes = [];
  const desconocidas = [];
  for (const s of partir(md)) {
    if (s.titulo === null) { partes.push(s); continue; }
    if (!Object.prototype.hasOwnProperty.call(tabla, s.titulo)) { desconocidas.push(s.titulo); continue; }
    if (tabla[s.titulo].includes(rol)) partes.push(s);
  }
  return { partes, desconocidas };
}

// ── el markdown, escapado ──────────────────────────────────────────────────────────────────────────────────────
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** El ancla de un título: minúsculas, sin acentos ni signos, con guiones (la misma forma que usa GitHub). */
function ancla(t) {
  return String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
}

/** El destino de un enlace, o null si no va: sólo https o un ancla (llevada a la forma de los títulos). */
function destinoDeEnlace(url) {
  const u = String(url).trim();
  if (/^#[^\s"'<>]+$/.test(u)) {
    // un ancla mal codificada (`#%ZZ`) no es un enlace: queda como texto, nunca tira la página
    let texto;
    try { texto = decodeURIComponent(u.slice(1)); } catch { return null; }
    const a = ancla(texto.replace(/-/g, ' '));
    return a ? `#${a}` : null;
  }
  if (/^https:\/\/[^\s"'<>]+$/i.test(u)) return u;
  return null;
}
/** La dirección de una imagen, o null: sólo una captura de la carpeta de la guía. */
function destinoDeImagen(src) {
  const m = /^sitio-de-la-organizacion\/capturas\/([^/]+)$/.exec(String(src).trim());
  return m && CAPTURA.test(m[1]) ? `/ayuda/capturas/${m[1]}` : null;
}

// sobre texto ya escapado: no puede abrir ninguna etiqueta que no sea éstas. Las etiquetas que ya armó `enLinea` (un
// enlace, una imagen) se apartan mientras tanto: los asteriscos de su dirección no son formato, y la negrita puede
// envolver un enlace entero
function formato(t) {
  const apartadas = [];
  const sinEtiquetas = t.replace(/<[^>]*>/g, (et) => { apartadas.push(et); return `\u0001${apartadas.length - 1}\u0002`; });
  return sinEtiquetas
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\u0001(\d+)\u0002/g, (todo, n) => apartadas[Number(n)]);
}

/** Lo de adentro de una línea: el código va literal y escapado; en el resto, imágenes, enlaces, negrita y cursiva. */
function enLinea(texto, rechazar) {
  return String(texto).split(/(`[^`]+`)/).map((tramo) => {
    if (/^`[^`]+`$/.test(tramo)) return `<code>${esc(tramo.slice(1, -1))}</code>`;
    // las imágenes y los enlaces se reconocen sobre el texto crudo y cada parte se escapa por separado
    const partes = [];
    const re = /(!?)\[([^\]]*)\]\(([^)\s]+)\)/g;
    let desde = 0;
    let m;
    while ((m = re.exec(tramo))) {
      partes.push(esc(tramo.slice(desde, m.index)));
      if (m[1]) {
        const src = destinoDeImagen(m[3]);
        if (!src) rechazar(`imagen que no es una captura de la guía: ${m[3]}`);
        partes.push(src ? `<img src="${esc(src)}" alt="${esc(m[2])}" loading="lazy">` : '');
      } else {
        const href = destinoDeEnlace(m[3]);
        if (!href) rechazar(`enlace que no es https ni un ancla: ${m[3]}`);
        partes.push(href ? `<a href="${esc(href)}"${href.startsWith('#') ? '' : ' rel="noopener" target="_blank"'}>${esc(m[2])}</a>` : esc(m[2]));
      }
      desde = m.index + m[0].length;
    }
    partes.push(esc(tramo.slice(desde)));
    // la negrita y la cursiva sobre el tramo entero (pueden envolver un enlace); el texto ya está escapado
    return formato(partes.join(''));
  }).join('');
}

/** Una fila de tabla en celdas. */
const celdas = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const MARCA = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
const sangria = (l) => /^\s*/.exec(l)[0].length;

/** Una lista desde la línea `i`, con sus sublistas (por sangría): { html, i } con la primera línea que ya no es suya. */
function lista(lineas, i, rechazar) {
  const base = sangria(lineas[i]);
  const ordenada = /^\s*\d+\./.test(lineas[i]);
  const items = [];
  while (i < lineas.length) {
    const l = lineas[i];
    const m = MARCA.exec(l);
    if (m && sangria(l) === base) { items.push({ texto: m[3], hijos: '' }); i += 1; continue; }
    if (!items.length) break;
    if (m && sangria(l) > base) { const sub = lista(lineas, i, rechazar); items[items.length - 1].hijos += sub.html; i = sub.i; continue; }
    // la continuación de un ítem: una línea con sangría que no es una marca
    if (!m && l.trim() && sangria(l) > base) { items[items.length - 1].texto += ` ${l.trim()}`; i += 1; continue; }
    break;
  }
  const tag = ordenada ? 'ol' : 'ul';
  return { html: `<${tag}>${items.map((x) => `<li>${enLinea(x.texto, rechazar)}${x.hijos}</li>`).join('')}</${tag}>`, i };
}

/** Un enlace a un ancla que la página no tiene (una sección de otro rol) queda como texto: no apunta a lo que no se ve. */
function sinAnclasAjenas(html) {
  const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
  return html.replace(/<a href="#([^"]+)">([\s\S]*?)<\/a>/g, (todo, id, texto) => (ids.has(id) ? todo : texto));
}

/**
 * El markdown de la guía en HTML: todo lo del archivo sale escapado. `alRechazar(motivo)` se llama por cada enlace o
 * imagen que no se muestra (la ruta lo deja en el registro: un enlace roto de la guía no pasa en silencio).
 */
function aHtml(md, { alRechazar = () => {} } = {}) {
  const lineas = String(md).split('\n');
  const out = [];
  let i = 0;
  const parrafo = [];
  const cerrarParrafo = () => { if (parrafo.length) { out.push(`<p>${enLinea(parrafo.join(' '), alRechazar)}</p>`); parrafo.length = 0; } };
  while (i < lineas.length) {
    const l = lineas[i];
    if (/^```/.test(l)) {
      cerrarParrafo();
      const cuerpo = [];
      i += 1;
      while (i < lineas.length && !/^```/.test(lineas[i])) { cuerpo.push(lineas[i]); i += 1; }
      out.push(`<pre><code>${esc(cuerpo.join('\n'))}</code></pre>`);
      i += 1;
      continue;
    }
    const h = /^(#{1,6})\s+(.+)$/.exec(l);
    if (h) {
      cerrarParrafo();
      const n = Math.min(h[1].length + 1, 6);
      out.push(`<h${n} id="${esc(ancla(h[2]))}">${enLinea(h[2], alRechazar)}</h${n}>`);
      i += 1;
      continue;
    }
    if (/^\s*\|/.test(l) && i + 1 < lineas.length && /^\s*\|[\s:|-]+\|\s*$/.test(lineas[i + 1])) {
      cerrarParrafo();
      const cab = celdas(l);
      i += 2;
      const filas = [];
      while (i < lineas.length && /^\s*\|/.test(lineas[i])) { filas.push(celdas(lineas[i])); i += 1; }
      out.push(`<table><thead><tr>${cab.map((c) => `<th>${enLinea(c, alRechazar)}</th>`).join('')}</tr></thead><tbody>${filas.map((f) => `<tr>${f.map((c) => `<td>${enLinea(c, alRechazar)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (MARCA.test(l)) {
      cerrarParrafo();
      const r = lista(lineas, i, alRechazar);
      out.push(r.html);
      i = r.i;
      continue;
    }
    if (/^>\s?/.test(l)) {
      cerrarParrafo();
      const cita = [];
      while (i < lineas.length && /^>\s?/.test(lineas[i])) { cita.push(lineas[i].replace(/^>\s?/, '')); i += 1; }
      out.push(`<blockquote>${enLinea(cita.join(' '), alRechazar)}</blockquote>`);
      continue;
    }
    if (!l.trim() || /^(-{3,}|\*{3,})$/.test(l.trim())) { cerrarParrafo(); i += 1; continue; }
    parrafo.push(l.trim());
    i += 1;
  }
  cerrarParrafo();
  return sinAnclasAjenas(out.join('\n'));
}

// ── las rutas ─────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * La guía para `idioma`: { idioma, texto, otroIdioma } · { error: código } si existe y no se pudo leer · null sin
 * ninguna. «No está» (ENOENT) y «no la pude leer» son cosas distintas: sólo la que no está pasa a la del otro idioma.
 */
function guiaDe(raiz, idioma) {
  const leer = (id) => {
    try { return { texto: fs.readFileSync(path.join(raiz, 'guides', ARCHIVO[id]), 'utf8') }; } catch (e) { return e && e.code === 'ENOENT' ? null : { error: (e && e.code) || 'error' }; }
  };
  const propia = leer(idioma);
  if (propia) return propia.error ? { error: propia.error, archivo: ARCHIVO[idioma] } : { idioma, texto: propia.texto, otroIdioma: false };
  const otro = idioma === 'es' ? 'en' : 'es';
  const ajena = leer(otro);
  if (!ajena) return null;
  return ajena.error ? { error: ajena.error, archivo: ARCHIVO[otro] } : { idioma: otro, texto: ajena.texto, otroIdioma: true };
}

function crearRutas({ raiz = path.join(__dirname, '..', '..'), log = () => {} } = {}) {
  const html = (cuerpo) => ({ status: 200, tipo: 'text/html; charset=utf-8', cuerpo });
  const dirCapturas = path.join(raiz, CAPTURAS);
  return [
    {
      method: 'GET', path: '/ayuda', needs: ['maintainer', 'person'], pestana: { id: 'ayuda', titulo: 'Ayuda', orden: 90 },
      handler: (ctx) => {
        const idioma = idiomaDe(ctx);
        const g = guiaDe(raiz, idioma);
        const titulo = t(idioma, 'pestana.ayuda');
        if (!g) return html(views.layout(ctx, titulo, `<section class="card form-block"><p>${TEXTOS.sinGuia(idioma, RUTA_DE_LA_GUIA)}</p></section>`));
        if (g.error) {
          log(`ayuda: no pude leer guides/${g.archivo} (${g.error})`);
          return html(views.layout(ctx, titulo, `<section class="card form-block"><p>${TEXTOS.noSePudoLeer(idioma, g.error)}</p></section>`));
        }
        const rol = ctx.quien && ctx.quien.rol;
        const { partes, desconocidas } = paraRol(g.texto, g.idioma, rol);
        if (desconocidas.length) log(`ayuda: la guía trae secciones que la tabla no conoce y no se muestran: ${desconocidas.join(' · ')}`);
        const rechazos = [];
        const cuerpo = aHtml(partes.map((p) => p.texto).join('\n'), { alRechazar: (m) => rechazos.push(m) });
        if (rechazos.length) log(`ayuda: ${rechazos.length} enlace(s) o imagen(es) de la guía no se muestran: ${[...new Set(rechazos)].slice(0, 5).join(' · ')}`);
        const aviso = g.otroIdioma ? `<div class="banda">${esc(TEXTOS.otroIdioma(idioma, TEXTOS.idioma(idioma, idioma), TEXTOS.idioma(idioma, g.idioma)))}</div>` : '';
        return html(views.layout(ctx, titulo, `${aviso}<article class="ayuda" lang="${esc(g.idioma)}">${cuerpo}</article>`, rol === 'maintainer' ? TEXTOS.ledeMantiene(idioma) : TEXTOS.ledePersona(idioma)));
      },
    },
    {
      method: 'GET', path: '/ayuda/capturas/:nombre', needs: ['maintainer', 'person'],
      handler: (ctx) => {
        const no = { status: 404, tipo: 'text/plain; charset=utf-8', cuerpo: '' };
        const nombre = String(ctx.params.nombre || '');
        if (!CAPTURA.test(nombre)) return no;
        let datos;
        try { datos = fs.readFileSync(path.join(dirCapturas, nombre)); } catch (e) {
          if (e && e.code === 'ENOENT') return no;
          // «no la pude leer» no es «no está»: queda en el registro y la respuesta lo dice
          log(`ayuda: no pude leer la captura ${nombre} (${(e && e.code) || 'error'})`);
          return { status: 500, tipo: 'text/plain; charset=utf-8', cuerpo: '' };
        }
        if (datos.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') { log(`ayuda: la captura ${nombre} no es un png: no se sirve`); return no; }
        return { status: 200, tipo: 'image/png', cuerpo: datos, extra: { 'Cache-Control': 'private, max-age=3600' } };
      },
    },
  ];
}

module.exports = { SECCIONES, RUTA_DE_LA_GUIA, TEXTOS, partir, paraRol, aHtml, ancla, guiaDe, idiomaDe, crearRutas };
