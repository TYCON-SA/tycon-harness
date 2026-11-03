'use strict';
/*
 * tabs/offices.js — LA PESTAÑA «OFICINAS» DEL SITIO DE LA ORGANIZACIÓN.
 *
 * Una oficina por máquina que quien mira puede ver. La página es la misma de la oficina local (scripts/tools/office/):
 * `page.html` y `page.js`, con `data-source="site"`. No lleva ningún dato: todo llega por `/live/offices`, ya filtrado
 * por el sitio antes de mandar (live-hub.js), con la cookie de la sesión y sin token.
 *
 * La política es la del sitio, más el hash del mapa de importación, que los navegadores no aceptan en un archivo aparte.
 * Ese hash vale sólo en la ruta de la página. Los módulos se piden por su número en la lista: una barra codificada en una
 * dirección la puede tocar un intermediario.
 *
 * En el sitio de demostración, `data-source="demo"`: las oficinas inventadas de demo/data.js llegan por un pedido común,
 * con la misma regla de quién ve qué, sin abrir ninguna conexión.
 *
 * Rutas (todas `person`, que incluye a quien mantiene): GET /offices · GET /offices/page.js · GET /offices/modules/<n>.js ·
 * en la demo, GET /offices/demo.json. Casos: scripts/tests/site-offices.test.js y site-offices.smoke.js.
 */
const crypto = require('crypto');
const fs = require('fs');
const TX = require('../texts.js');
const views = require('../views.js');
const access = require('../access.js');
const { esc } = require('../../nightly/dashboard/common.js');

// por su archivo, no por su carpeta: `tools/office` sin más se lee también como `tools/office.js`, que la imagen no trae
const PARTS = require('../../tools/office/page-parts.js');
const CLAVES = Object.keys(PARTS.MODULES);
const NO_EXISTE = { status: 404, tipo: 'text/plain; charset=utf-8', cuerpo: '' };
const JS = 'text/javascript; charset=utf-8';

const direccionDelModulo = (clave) => `/offices/modules/${CLAVES.indexOf(clave)}.js`;

/** La barra de arriba: las pestañas del sitio y la cuenta. La página no carga las hojas del sitio: se dibuja con las suyas. */
function barraDelSitio(ctx) {
  const idioma = views.idiomaDe(ctx);
  const T = (k) => TX.t(idioma, k);
  const enlaces = (ctx.pestanas || []).map((p) => `<a href="${esc(p.path)}"${ctx.activa === p.id ? ' aria-current="page"' : ''}>${esc(p.titulo)}</a>`).join('');
  const cuenta = ctx.quien ? ctx.quien.correoDeIngreso || ctx.quien.email : '';
  const tok = ctx.sesion && typeof ctx.sesion.tok === 'string' ? ctx.sesion.tok : '';
  const salir = cuenta ? `<form class="salir" method="post" action="/auth/logout"><span>${esc(cuenta)}</span> <input type="hidden" name="tok" value="${esc(tok)}"> <button type="submit">${esc(T('barra.salir'))}</button></form>` : '';
  return `<div class="barra-sitio"><nav aria-label="${esc(T('barra.pestanas'))}">${enlaces}</nav>${salir}</div>`;
}

/** La política de la página: la del sitio, con el hash del mapa de importación. */
function politicaDe(csp) {
  const mapa = PARTS.importMap(direccionDelModulo);
  const hash = crypto.createHash('sha256').update(mapa).digest('base64');
  return csp.replace("script-src 'self'", `script-src 'self' 'sha256-${hash}'`);
}

function crearRutas({ log = () => {}, demo = false, fuentes = null, oficinasDeEjemplo = null, ahora = Date.now } = {}) {
  const necesita = ['maintainer', 'person'];
  // sin cargar `server.js` antes de tiempo: él carga esta pestaña al armar sus rutas
  const politica = () => politicaDe(require('../server.js').CSP);
  const codigo = () => fs.readFileSync(PARTS.CODE, 'utf8');

  function pagina(ctx) {
    let cuerpo;
    try {
      cuerpo = PARTS.renderPage({ source: demo ? 'demo' : 'site', urlOf: direccionDelModulo, script: '/offices/page.js', bar: barraDelSitio(ctx) });
    } catch (e) {
      // sin la página en la imagen se dice y el sitio sigue: el motivo trae rutas, va al registro
      log(`oficinas: la página no se pudo armar (${e.code || e.message})`);
      const idioma = views.idiomaDe(ctx);
      return { status: 503, tipo: 'text/html; charset=utf-8', cuerpo: views.paginaSimple(TX.t(idioma, 'pestana.oficinas'), TX.t(idioma, 'oficinas.noSePudo'), ctx) };
    }
    return { status: 200, tipo: 'text/html; charset=utf-8', cuerpo, extra: { 'Content-Security-Policy': politica() } };
  }

  /** Las oficinas inventadas, con la regla de siempre: quien mantiene ve de quién es cada una; un dev, sólo las suyas. */
  function oficinasDemo(ctx) {
    const config = fuentes.config();
    const reglas = access.crearReglas({ config, modelo: fuentes.modelo ? fuentes.modelo() : {}, personas: fuentes.personas ? fuentes.personas() : null });
    const visibilidad = (config && config.site && config.site.offices && config.site.offices.visibility) || 'maintainers';
    const ve = access.oficinasQueVe(ctx.quien, reglas, visibilidad);
    const mantiene = ctx.quien.rol === 'maintainer';
    const oficinas = oficinasDeEjemplo(ahora()).filter((o) => ve(o.id)).map(({ person, ...o }) => (mantiene ? { ...o, person } : o));
    return { status: 200, tipo: 'application/json; charset=utf-8', cuerpo: JSON.stringify({ type: 'oficinas', entera: true, oficinas, fuera: [] }) };
  }

  const rutas = [
    { method: 'GET', path: '/offices', needs: necesita, pestana: { id: 'oficinas', titulo: 'Oficinas', orden: 15 }, handler: pagina },
    { method: 'GET', path: '/offices/page.js', needs: necesita, handler: () => ({ status: 200, tipo: JS, cuerpo: codigo() }) },
    {
      method: 'GET',
      path: '/offices/modules/:modulo',
      needs: necesita,
      handler: (ctx) => {
        const m = /^(\d{1,3})\.js$/.exec(ctx.params.modulo);
        const clave = m ? CLAVES[Number(m[1])] : undefined;
        return clave ? { status: 200, tipo: JS, cuerpo: PARTS.moduleSource(clave, PARTS.MODULES[clave]) } : NO_EXISTE;
      },
    },
  ];
  if (demo) rutas.push({ method: 'GET', path: '/offices/demo.json', needs: necesita, handler: oficinasDemo });
  return rutas;
}

module.exports = { crearRutas, politicaDe, barraDelSitio };
