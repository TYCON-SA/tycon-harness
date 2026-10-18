'use strict';
/*
 * site-help.test.js — la ayuda del sitio: sale de la guía que viaja en la imagen, partida por rol en el servidor.
 *
 * T1 Ayuda_CadaSeccionTieneRoles                 T4 Ayuda_HtmlDeLaGuiaSaleComoTexto
 * T2 Ayuda_LoQueVeCadaRol_EsLaGuia               T5 Ayuda_Capturas_SoloLasDeLaGuia
 * T3 Ayuda_SinRolDeMantener_NoLlegaLaInstalacion T6 Ayuda_SinSesionYSinGuia_YElIdioma
 *
 * Sin red: el emisor de inicio de sesión es local (lib/fake-oidc.js) y el sitio corre en el proceso (lib/site-harness.js).
 * Correos inventados.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { arrancarEmisor } = require('./lib/fake-oidc.js');
const H = require('./lib/site-harness.js');

const ROOT = path.resolve(H.SITE, '..', '..');
const HELP = require(path.join(H.SITE, 'help.js'));
const GUIA = { es: path.join(ROOT, 'guides', 'organization-site.md'), en: path.join(ROOT, 'guides', 'organization-site.en.md') };
const leer = (f) => fs.readFileSync(f, 'utf8');
const MANTIENE = 'lead@acme.example';
const PERSONA = 'ana@acme.example';
const config = () => ({ version: 1, owners: { default: MANTIENE }, site: { maintainers: [MANTIENE] }, people: { machines: { 'mac-ana': { person: PERSONA, reported_sha256: null, confirmed_by: MANTIENE, confirmed_on: '2026-10-01' } } } });

const temporales = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temporales.push(d); return d; };
test.after(() => { for (const d of temporales) fs.rmSync(d, { recursive: true, force: true }); });

/** Las secciones `##` de un markdown, partidas a mano (independiente de help.js): [{ titulo, texto }], la primera sin título. */
function partirAMano(md) {
  const out = [];
  let actual = { titulo: null, lineas: [] };
  let enCodigo = false;
  for (const l of md.split('\n')) {
    if (/^```/.test(l)) enCodigo = !enCodigo;
    const m = !enCodigo && /^## (.+)$/.exec(l);
    if (m) { out.push(actual); actual = { titulo: m[1].trim(), lineas: [] }; }
    actual.lineas.push(l);
  }
  out.push(actual);
  return out.map((s) => ({ titulo: s.titulo, texto: s.lineas.join('\n') }));
}

/** El sitio con la ayuda sobre `raiz` (un árbol con guides/); `entrar(correo)` da la cookie de una sesión real. */
async function conAyuda({ raiz = ROOT } = {}, fn) {
  const emisor = await arrancarEmisor();
  const h = await H.arrancarSitio({ env: H.envBase({ SITE_OIDC_ISSUER: emisor.issuer }), fuentes: H.fuentesFijas({ config: config() }), rutasExtra: HELP.crearRutas({ raiz }) });
  try {
    const entrar = async (email) => (await H.ingresar(h, emisor, { sub: `s-${email}`, email, email_verified: true })).sesion;
    await fn({ h, entrar });
  } finally { await h.cerrar(); await emisor.cerrar(); }
}

test('T1 Ayuda_CadaSeccionTieneRoles @story-2.41 @ac-2', () => {
  for (const idioma of ['es', 'en']) {
    const titulos = partirAMano(leer(GUIA[idioma])).filter((s) => s.titulo).map((s) => s.titulo);
    const tabla = Object.keys(HELP.SECCIONES[idioma]);
    assert.deepStrictEqual(titulos.filter((t) => !tabla.includes(t)), [], `${idioma}: secciones de la guía que la tabla no conoce (nadie las vería)`);
    assert.deepStrictEqual(tabla.filter((t) => !titulos.includes(t)), [], `${idioma}: la tabla nombra secciones que la guía ya no tiene`);
    for (const [t, roles] of Object.entries(HELP.SECCIONES[idioma])) assert.ok(Array.isArray(roles) && roles.length && roles.every((r) => ['maintainer', 'person'].includes(r)), `${idioma}: «${t}» sin roles válidos`);
  }
  // las dos guías dan los mismos roles, sección por sección y en el mismo orden
  assert.deepStrictEqual(Object.values(HELP.SECCIONES.es), Object.values(HELP.SECCIONES.en));
  // lo de instalar es sólo de quien mantiene; lo de usar, de todos
  assert.deepStrictEqual(HELP.SECCIONES.es['Qué hace falta antes'], ['maintainer']);
  assert.deepStrictEqual(HELP.SECCIONES.es['Por dentro, para quien mantiene el arnés'], ['maintainer']);
  assert.deepStrictEqual(HELP.SECCIONES.es['Problemas comunes'], ['maintainer', 'person']);
  // una sección nueva que la tabla no conoce no se muestra a nadie
  const nueva = `${leer(GUIA.es)}\n## Una sección nueva\n\nTexto que nadie revisó.\n`;
  for (const rol of ['maintainer', 'person']) {
    const r = HELP.paraRol(nueva, 'es', rol);
    assert.ok(!r.partes.some((p) => p.titulo === 'Una sección nueva'), `${rol}: la sección desconocida no se muestra`);
    assert.deepStrictEqual(r.desconocidas, ['Una sección nueva']);
  }
});

test('T2 Ayuda_LoQueVeCadaRol_EsLaGuia @story-2.41 @ac-2 @ac-7', () => {
  for (const idioma of ['es', 'en']) {
    const md = leer(GUIA[idioma]);
    const aMano = partirAMano(md);
    for (const rol of ['maintainer', 'person']) {
      const esperadas = aMano.filter((s) => s.titulo === null || HELP.SECCIONES[idioma][s.titulo].includes(rol));
      const r = HELP.paraRol(md, idioma, rol);
      assert.deepStrictEqual(r.partes.map((p) => p.titulo), esperadas.map((s) => s.titulo), `${idioma}/${rol}: las secciones`);
      r.partes.forEach((p, i) => assert.strictEqual(p.texto, esperadas[i].texto, `${idioma}/${rol}: «${p.titulo || 'el comienzo'}» no es el texto de la guía`));
    }
  }
  // «Qué ve cada rol» dice que la ayuda está dentro del sitio (AC 7)
  const rol = partirAMano(leer(GUIA.es)).find((s) => s.titulo === 'Qué ve cada rol').texto;
  assert.match(rol.replace(/\s+/g, ' '), /pestaña «Ayuda»/);
  const role = partirAMano(leer(GUIA.en)).find((s) => s.titulo === 'What each role sees').texto;
  assert.match(role.replace(/\s+/g, ' '), /"Help" tab/);
});

test('T3 Ayuda_SinRolDeMantener_NoLlegaLaInstalacion @story-2.41 @ac-3', async () => {
  const md = leer(GUIA.es);
  const deMantener = partirAMano(md).filter((s) => s.titulo && !HELP.SECCIONES.es[s.titulo].includes('person'));
  assert.ok(deMantener.length >= 5, 'hay secciones sólo de quien mantiene');
  await conAyuda({}, async ({ h, entrar }) => {
    const persona = await h.pedir('/ayuda', { cookie: await entrar(PERSONA) });
    assert.strictEqual(persona.status, 200, persona.texto.slice(0, 200));
    for (const s of deMantener) assert.ok(!persona.texto.includes(HELP.ancla(s.titulo)), `la persona recibe «${s.titulo}»`);
    for (const frase of ['SITE_OPERATIONS_WRITE_TOKEN', 'docker buildx', 'Bypass policies', 'SITE_SESSION_KEY', 'SITE_FIRST_MAINTAINER']) assert.ok(!persona.texto.includes(frase), `la persona recibe «${frase}»`);
    const mantiene = await h.pedir('/ayuda', { cookie: await entrar(MANTIENE) });
    assert.strictEqual(mantiene.status, 200);
    for (const s of deMantener) assert.ok(mantiene.texto.includes(`id="${HELP.ancla(s.titulo)}"`), `quien mantiene no recibe «${s.titulo}»`);
    assert.ok(mantiene.texto.includes('SITE_OPERATIONS_WRITE_TOKEN'));
  });
});

test('T4 Ayuda_HtmlDeLaGuiaSaleComoTexto @story-2.41 @ac-4', () => {
  const md = [
    '# Título', '', 'Un <script>alert(1)</script> y <img src=x onerror=alert(2)>.', '',
    '[malo](javascript:alert(3)) · [bueno](https://example.com/a?b=1&c=2) · [ancla](#mas-abajo) · [relativo](otra-guia.md)', '',
    '![afuera](https://example.com/x.png) ![adentro](sitio-de-la-organizacion/capturas/inicio.png) ![trampa](sitio-de-la-organizacion/capturas/../../x.png)', '',
    '| a | b |', '|---|---|', '| <b>uno</b> | `dos` |', '',
    '```', '<script>alert(4)</script>', '```', '', '## Más abajo', '', '[a otra sección](#no-esta-en-la-pagina)',
  ].join('\n');
  const html = HELP.aHtml(md);
  assert.ok(!/<script/i.test(html), html);
  assert.ok(!/<img[^>]*onerror/i.test(html) && !/<b>uno/.test(html), 'el HTML del archivo sale como texto');
  assert.ok(html.includes('&lt;script&gt;'), 'el script, como texto');
  assert.ok(!/href="javascript:/i.test(html), 'sin enlaces javascript:');
  assert.ok(html.includes('href="https://example.com/a?b=1&amp;c=2"'), 'el enlace https');
  assert.ok(html.includes('href="#mas-abajo"'), 'el ancla');
  assert.ok(!html.includes('href="#no-esta-en-la-pagina"') && html.includes('a otra sección'), 'un ancla que la página no tiene queda como texto');
  assert.ok(!html.includes('href="otra-guia.md"'), 'un enlace relativo no sale como enlace');
  assert.ok(!html.includes('src="https://example.com/x.png"'), 'una imagen de afuera no sale');
  assert.ok(html.includes('src="/ayuda/capturas/inicio.png"'), 'la captura de la guía, por la ruta del sitio');
  assert.ok(!/src="[^"]*\.\./.test(html), 'sin rutas con ..');
  assert.match(html, /<table>/);
  assert.match(html, /<code>dos<\/code>/);
  // la negrita envuelve un enlace a un ancla con acentos (la forma de la guía): sale negrita y apunta al id del título
  const lista = HELP.aHtml('- **[Usar el sitio](#qué-es-y-para-qué-sirve):** qué es.\n\n## Qué es y para qué sirve');
  assert.ok(lista.includes('<strong><a href="#que-es-y-para-que-sirve">Usar el sitio</a>:</strong>'), lista);
  assert.ok(lista.includes('id="que-es-y-para-que-sirve"'), lista);
});

test('T5 Ayuda_Capturas_SoloLasDeLaGuia @story-2.41 @ac-5', async () => {
  const una = fs.readdirSync(path.join(ROOT, 'guides', 'sitio-de-la-organizacion', 'capturas')).find((f) => f.endsWith('.png'));
  assert.ok(una, 'la guía tiene capturas');
  await conAyuda({}, async ({ h, entrar }) => {
    const c = await entrar(PERSONA);
    const ok = await h.pedir(`/ayuda/capturas/${una}`, { cookie: c });
    assert.strictEqual(ok.status, 200);
    assert.match(ok.headers['content-type'] || '', /image\/png/);
    assert.strictEqual((await h.pedir('/ayuda/capturas/no-existe.png', { cookie: c })).status, 404);
    assert.strictEqual((await h.pedir('/ayuda/capturas/..%2F..%2FLICENSE', { cookie: c })).status, 404);
    assert.strictEqual((await h.pedir('/ayuda/capturas/configuracion-personas.html', { cookie: c })).status, 404, 'sólo imágenes');
  });
});

test('T6 Ayuda_SinSesionYSinGuia_YElIdioma @story-2.41 @ac-1 @ac-5 @ac-6', async () => {
  // sin sesión: al inicio de sesión, como cualquier pestaña
  await conAyuda({}, async ({ h, entrar }) => {
    const sin = await h.pedir('/ayuda');
    assert.strictEqual(sin.status, 302);
    assert.strictEqual((await h.pedir(`/ayuda/capturas/inicio.png`)).status, 302);
    // con sesión: la pestaña «Ayuda» en la barra, para quien mantiene y para una persona
    for (const quien of [MANTIENE, PERSONA]) {
      const r = await h.pedir('/', { cookie: await entrar(quien) });
      assert.match(r.texto, /<a href="\/ayuda"[^>]*>.*Ayuda<\/a>/, `${quien}: la pestaña Ayuda`);
    }
    // el idioma del sitio: la guía en castellano
    const es = await h.pedir('/ayuda', { cookie: await entrar(PERSONA) });
    assert.ok(es.texto.includes(`id="${HELP.ancla('Qué es y para qué sirve')}"`), 'la guía en el idioma del sitio');
  });
  // sin ninguna guía en la imagen
  await conAyuda({ raiz: tmp('ayuda-sin-guia-') }, async ({ h, entrar }) => {
    const r = await h.pedir('/ayuda', { cookie: await entrar(PERSONA) });
    assert.strictEqual(r.status, 200);
    assert.match(r.texto, /esta versión del sitio no trae la ayuda/);
    assert.ok(r.texto.includes('<code>guides/organization-site.md</code>'), 'dice dónde está la guía en el repo del arnés');
  });
  // sin la guía del idioma del sitio: la del otro, con el aviso
  const raiz = tmp('ayuda-solo-en-');
  fs.mkdirSync(path.join(raiz, 'guides'), { recursive: true });
  fs.copyFileSync(GUIA.en, path.join(raiz, 'guides', 'organization-site.en.md'));
  await conAyuda({ raiz }, async ({ h, entrar }) => {
    const r = await h.pedir('/ayuda', { cookie: await entrar(PERSONA) });
    assert.match(r.texto, /no trae la ayuda en castellano: se muestra en inglés/);
    assert.ok(r.texto.includes(`id="${HELP.ancla('What it is and what it is for')}"`));
  });
});

test('T4b Ayuda_FormasDelMarkdown_YAnclasMalCodificadas @story-2.41 @ac-4 — el caso que encontró el pase adversarial', () => {
  // listas numeradas, sublistas por sangría, continuación de un ítem, citas y cursiva
  const html = HELP.aHtml(['1. uno', '2. dos', '', '- Padre', '  sigue el padre', '  - Hijo A', '  - Hijo B', '- Hermano', '', '> una *cita* con cursiva', '', '---'].join('\n'));
  assert.ok(html.includes('<ol><li>uno</li><li>dos</li></ol>'), html);
  assert.ok(html.includes('<ul><li>Padre sigue el padre<ul><li>Hijo A</li><li>Hijo B</li></ul></li><li>Hermano</li></ul>'), html);
  assert.ok(html.includes('<blockquote>una <em>cita</em> con cursiva</blockquote>'), html);
  // un ancla mal codificada no tira la página: queda como texto, y el rechazo se avisa
  for (const roto of ['#%ZZ', '#%', '#x%2', '#%E0%A4%A']) {
    const rechazos = [];
    const r = HELP.aHtml(`[ancla rota](${roto})`, { alRechazar: (m) => rechazos.push(m) });
    assert.ok(r.includes('ancla rota') && !r.includes('href='), `${roto}: ${r}`);
    assert.strictEqual(rechazos.length, 1, `${roto}: el rechazo se avisa`);
  }
});

test('T5b Ayuda_CapturaFalsaOIlegible @story-2.41 @ac-5', async () => {
  const raiz = tmp('ayuda-capturas-');
  const dir = path.join(raiz, 'guides', 'sitio-de-la-organizacion', 'capturas');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(GUIA.es, path.join(raiz, 'guides', 'organization-site.md'));
  fs.writeFileSync(path.join(dir, 'falsa.png'), 'no soy un png');
  fs.mkdirSync(path.join(dir, 'carpeta.png'));
  const registro = [];
  const emisor = await arrancarEmisor();
  const h = await H.arrancarSitio({ env: H.envBase({ SITE_OIDC_ISSUER: emisor.issuer }), fuentes: H.fuentesFijas({ config: config() }), rutasExtra: HELP.crearRutas({ raiz, log: (l) => registro.push(l) }) });
  try {
    const c = (await H.ingresar(h, emisor, { sub: 's-ana', email: PERSONA, email_verified: true })).sesion;
    assert.strictEqual((await h.pedir('/ayuda/capturas/falsa.png', { cookie: c })).status, 404, 'un archivo que no es png no se sirve');
    assert.ok(registro.some((l) => /falsa\.png no es un png/.test(l)), registro.join('\n'));
    assert.strictEqual((await h.pedir('/ayuda/capturas/carpeta.png', { cookie: c })).status, 500, '«no la pude leer» no es «no está»');
    assert.ok(registro.some((l) => /no pude leer la captura carpeta\.png \(EISDIR\)/.test(l)), registro.join('\n'));
  } finally { await h.cerrar(); await emisor.cerrar(); }
});

test('T6b Ayuda_GuiaIlegible_NoPasaPorQueNoEsta @story-2.41 @ac-1', () => {
  // la del idioma del sitio existe pero no se puede leer: no se muestra la otra con un aviso falso, se dice el motivo
  const raiz = tmp('ayuda-ilegible-');
  fs.mkdirSync(path.join(raiz, 'guides', 'organization-site.md'), { recursive: true });
  fs.copyFileSync(GUIA.en, path.join(raiz, 'guides', 'organization-site.en.md'));
  assert.deepStrictEqual(HELP.guiaDe(raiz, 'es'), { error: 'EISDIR', archivo: 'organization-site.md' });
  // la del idioma del sitio no está y la otra no se puede leer: tampoco «no está»
  const raiz2 = tmp('ayuda-ilegible2-');
  fs.mkdirSync(path.join(raiz2, 'guides', 'organization-site.en.md'), { recursive: true });
  assert.deepStrictEqual(HELP.guiaDe(raiz2, 'es'), { error: 'EISDIR', archivo: 'organization-site.en.md' });
  // y al revés: el sitio en inglés sin su guía usa la castellana, con el aviso
  const raiz3 = tmp('ayuda-solo-es-');
  fs.mkdirSync(path.join(raiz3, 'guides'), { recursive: true });
  fs.copyFileSync(GUIA.es, path.join(raiz3, 'guides', 'organization-site.md'));
  const g = HELP.guiaDe(raiz3, 'en');
  assert.deepStrictEqual([g.idioma, g.otroIdioma], ['es', true]);
  assert.strictEqual(HELP.guiaDe(raiz3, 'es').otroIdioma, false);
  // el idioma de cada pedido lo decide un solo lugar: hoy, el del sitio
  assert.strictEqual(HELP.idiomaDe({}), require(path.join(H.SITE, 'views.js')).IDIOMA);
});

test('T6c Ayuda_GuiaIlegible_LaPaginaLoDice @story-2.41 @ac-1', async () => {
  const raiz = tmp('ayuda-ilegible-pagina-');
  fs.mkdirSync(path.join(raiz, 'guides', 'organization-site.md'), { recursive: true });
  fs.copyFileSync(GUIA.en, path.join(raiz, 'guides', 'organization-site.en.md'));
  const registro = [];
  const emisor = await arrancarEmisor();
  const h = await H.arrancarSitio({ env: H.envBase({ SITE_OIDC_ISSUER: emisor.issuer }), fuentes: H.fuentesFijas({ config: config() }), rutasExtra: HELP.crearRutas({ raiz, log: (l) => registro.push(l) }) });
  try {
    const c = (await H.ingresar(h, emisor, { sub: 's-ana', email: PERSONA, email_verified: true })).sesion;
    const r = await h.pedir('/ayuda', { cookie: c });
    assert.match(r.texto, /No pude leer la guía del sitio \(EISDIR\)/);
    assert.ok(!/se muestra en inglés/.test(r.texto), 'sin el aviso falso del otro idioma');
    assert.ok(registro.some((l) => /no pude leer guides\/organization-site\.md \(EISDIR\)/.test(l)), registro.join('\n'));
  } finally { await h.cerrar(); await emisor.cerrar(); }
});

test('T6d Ayuda_Estilo_TemaYTelefono @story-2.41 @ac-6', () => {
  // la página usa las variables de color del sitio (que cambian con el tema) y se acomoda a un teléfono
  const css = fs.readFileSync(path.join(H.SITE, 'static', 'site.css'), 'utf8');
  const reglas = css.split('\n').filter((l) => l.includes('.ayuda'));
  assert.ok(reglas.length > 0, 'la hoja trae el estilo de la ayuda');
  assert.ok(!reglas.join('\n').match(/#[0-9a-f]{3,6}\b/i), 'sin colores fijos: sólo las variables del tema');
  assert.ok(reglas.some((l) => /@media \(max-width:640px\)/.test(l)), 'el ancho de un teléfono');
  assert.ok(reglas.some((l) => /\.ayuda img\{[^}]*max-width:100%/.test(l)) && reglas.some((l) => /\.ayuda table\{[^}]*overflow-x:auto/.test(l)) && reglas.some((l) => /\.ayuda pre\{[^}]*overflow-x:auto/.test(l)), 'imágenes, tablas y código no rompen el ancho');
});

test('T4c Ayuda_AsteriscosEnUnaDireccion_NoSonFormato @story-2.41 @ac-4', () => {
  const html = HELP.aHtml('[x](https://example.com/**a**) y **[Usar](#arriba):** *it*\n\n## Arriba');
  assert.ok(html.includes('href="https://example.com/**a**"'), html);
  assert.ok(html.includes('<strong><a href="#arriba">Usar</a>:</strong>'), html);
  assert.ok(html.includes('<em>it</em>'), html);
});

test('T3b Ayuda_RegistroYBajadaPorRol @story-2.41 @ac-2 @ac-5', async () => {
  // una guía con una sección que la tabla no conoce y un enlace que no va: los dos quedan en el registro
  const raiz = tmp('ayuda-registro-');
  fs.mkdirSync(path.join(raiz, 'guides', 'sitio-de-la-organizacion', 'capturas'), { recursive: true });
  fs.writeFileSync(path.join(raiz, 'guides', 'organization-site.md'), `${leer(GUIA.es)}\n[relativo](otra-guia.md)\n\n## Una sección nueva\n\nTexto.\n`);
  const una = fs.readdirSync(path.join(ROOT, 'guides', 'sitio-de-la-organizacion', 'capturas')).find((f) => f.endsWith('.png'));
  fs.copyFileSync(path.join(ROOT, 'guides', 'sitio-de-la-organizacion', 'capturas', una), path.join(raiz, 'guides', 'sitio-de-la-organizacion', 'capturas', una));
  const registro = [];
  const emisor = await arrancarEmisor();
  const h = await H.arrancarSitio({ env: H.envBase({ SITE_OIDC_ISSUER: emisor.issuer }), fuentes: H.fuentesFijas({ config: config() }), rutasExtra: HELP.crearRutas({ raiz, log: (l) => registro.push(l) }) });
  try {
    const entrar = async (email) => (await H.ingresar(h, emisor, { sub: `s-${email}`, email, email_verified: true })).sesion;
    const mantiene = await h.pedir('/ayuda', { cookie: await entrar(MANTIENE) });
    assert.ok(mantiene.texto.includes(HELP.TEXTOS.ledeMantiene), 'la bajada de quien mantiene');
    assert.ok(registro.some((l) => /secciones que la tabla no conoce.*Una sección nueva/.test(l)), registro.join('\n'));
    assert.ok(registro.some((l) => /no se muestran: enlace que no es https ni un ancla: otra-guia\.md/.test(l)), registro.join('\n'));
    const c = await entrar(PERSONA);
    assert.ok((await h.pedir('/ayuda', { cookie: c })).texto.includes(HELP.TEXTOS.ledePersona), 'la bajada de una persona');
    const img = await h.pedir(`/ayuda/capturas/${una}`, { cookie: c });
    assert.strictEqual(img.headers['cache-control'], 'private, max-age=3600', 'la captura se guarda sólo en el navegador de la sesión');
  } finally { await h.cerrar(); await emisor.cerrar(); }
});
