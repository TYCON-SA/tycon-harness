'use strict';
/*
 * site-texts.test.js — la tabla única de textos del sitio y la prueba que frena la traducción que falta.
 *
 * T7 Textos_CadaClaveEnLosDosIdiomas          T9  Textos_ConfiguracionEnLosDosIdiomas
 * T8 Textos_NingunaPaginaEnInglesTraeCastellano T10 Textos_LaAyudaSigueElIdioma
 * 2.57: Textos_ElCatalogoEnElIdiomaDeLaPagina · Textos_TodasLasSeccionesDeConfiguracionEnIngles
 *
 * T8 arma cada página del sitio en inglés con datos de laboratorio (Acme) y busca texto visible en castellano: un texto
 * escrito en una vista, fuera de la tabla, aparece ahí. Los datos de afuera (nombres de repos, productos, máquinas) no se
 * traducen y se sacan antes de mirar.
 *
 * Sin red: el emisor de inicio de sesión es local (lib/fake-oidc.js) y el sitio corre en el proceso (lib/site-harness.js).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { arrancarEmisor } = require('./lib/fake-oidc.js');
const H = require('./lib/site-harness.js');

const ROOT = path.resolve(H.SITE, '..', '..');
const TEXTS = () => require(path.join(H.SITE, 'texts.js'));
const HELP = require(path.join(H.SITE, 'help.js'));
const ORG = require(path.join(ROOT, 'scripts', 'lib', 'org-config.js'));
const { validarConfiguracion } = require(path.join(H.SITE, 'server.js'));
const MANTIENE = 'lead@acme.example';
const PERSONA = 'ana@acme.example';
const HOY = '2026-10-15';
const AHORA = Date.parse(`${HOY}T12:00:00Z`);

const temporales = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temporales.push(d); return d; };
test.after(() => { for (const d of temporales) fs.rmSync(d, { recursive: true, force: true }); });

// el detector de castellano: uno solo, el mismo de install-effects.test.js y de la prueba en vivo del sitio
const { textosVisibles, enCastellano } = require('./lib/spanish-text.js');

// ── el laboratorio Acme: datos con nombres que no son castellano ───────────────────────────────────────────────────
const leida = (extra) => ({ estado: 'medido', codigo: null, motivo: null, fecha: HOY, ...extra });
const noMedida = (codigo) => ({ estado: 'no_medido', codigo, motivo: null, fecha: null });
// el identificador de cada firma es el valor que se escribe en el perfil, no un texto: no se traduce
const IDS_DE_FIRMAS = require(path.join(H.SITE, '..', 'lib', 'signatures.js')).SIGNATURES.map((f) => f.id);
const DATOS = ['Acme Web','Acme Ops', 'web-repo', 'ops-repo', 'acme-mac-1', 'a.test.js', 'b.test.js', 'Acme', MANTIENE, PERSONA, 'ana', 'lead', 'Acme Corp'];
function modeloAcme() {
  return {
    dependencias: leida({ rubros: { nuevos: 3, aceptadas_sin_resolver: 1, rechazadas_sin_deuda: 0, pedidos_cerrados_con_vivas: 2 }, vivas_por_proyecto: { 'Acme Ops': 4 } }),
    vigilante: noMedida('sin_foto'),
    prs: leida({ lista: [{ numero: 7, proyecto: 'Acme Ops', repo: 'web-repo', dias: 5, autor: PERSONA, enlace: 'https://dev.example/pr/7' }, { numero: 9, proyecto: 'Acme Ops', repo: 'ops-repo', dias: null, autor: PERSONA }] }),
    pedidos: leida({ lista: [] }),
    suites: leida({ rojas: ['a.test.js', 'b.test.js'], sin_medir: 1, total: 300, ayer: { fecha: '2026-10-14', rojas: ['a.test.js'] } }),
    banco: leida({ rojos: [], total: 2500, ayer: null }),
    examen: noMedida('sin_configurar'),
    tablero: noMedida('sin_foto'),
    declarados: leida({ lista: [{ id: 'web-repo', review_before: '2026-10-20' }] }),
    corridas: noMedida('sin_buzon'),
    productos: [{ producto: 'Acme Web', proyectos: ['Acme Ops'], rutas: ['web-repo'] }],
    proyectos: leida({ lista: [] }),
    despliegues: noMedida('sin_foto'),
    paridad: noMedida('sin_paridad'),
    sources: leida({ lista: [{ id: 'web-repo', estado: 'medido', fecha: HOY }, { id: 'ops-repo', estado: 'no_medido', codigo: 'fuente_vieja', fecha: '2026-10-01' }] }),
    // las fichas del tablero: una medida y las demás no medidas, con una oculta
    fichas: (() => {
      const C = require(path.join(H.SITE, 'tabs', 'cards.js'));
      const m = C.fichasNoMedidas(['backlog'], 'sin_foto');
      m.lista[0] = { ...m.lista[0], estado: 'medido', valor: 0.5, medidos: 5, total: 10, unidad: 'ratio', nivel: 'warn', fecha: HOY };
      return m;
    })(),
  };
}
const configAcme = () => ({ version: 1, owners: { default: MANTIENE }, site: { access: [{ emails: [MANTIENE], role: 'maintainer' }, { emails: [PERSONA], role: 'dev' }], brand: { name: 'Acme Corp' } } });

test('T7 Textos_CadaClaveEnLosDosIdiomas @story-2.42 @ac-5 @ac-9 @story-2.60 @ac-3', () => {
  const T = TEXTS();
  const claves = Object.keys(T.TEXTOS);
  assert.ok(claves.length > 100, `la tabla trae los textos del sitio (${claves.length})`);
  assert.deepStrictEqual(T.problemasDeLaTabla(T.TEXTOS), [], 'la tabla de verdad, sin problemas');
  for (const [k, v] of Object.entries(T.TEXTOS)) {
    for (const i of T.IDIOMAS) {
      assert.ok(typeof v[i] === 'string' && v[i].trim(), `${k}: falta «${i}»`);
      assert.ok(!v[i].includes('<'), `${k} (${i}): sin HTML dentro de un texto`);
    }
    assert.deepStrictEqual(T.valoresDe(v.en), T.valoresDe(v.es), `${k}: los mismos valores con nombre`);
  }
  // rojo: una clave sin «en», otra con valores distintos, otra con HTML; la prueba nombra cada una
  const rota = { ...T.TEXTOS, 'prueba.sinIngles': { es: 'hola' }, 'prueba.valores': { es: '{n} días', en: '{dias} days' }, 'prueba.html': { es: 'a <b>b</b>', en: 'a <b>b</b>' }, 'prueba.vacio': { es: 'x', en: '  ' } };
  const p = T.problemasDeLaTabla(rota).join('\n');
  for (const k of ['prueba.sinIngles', 'prueba.valores', 'prueba.html', 'prueba.vacio']) assert.match(p, new RegExp(k.replace('.', '\\.')), `la prueba nombra ${k}`);
  // t(): los valores con nombre se reemplazan; un idioma desconocido cae a castellano; una clave inexistente tira
  const una = claves.find((k) => T.valoresDe(T.TEXTOS[k].es).length === 0);
  assert.strictEqual(T.t('en', una), T.TEXTOS[una].en);
  assert.strictEqual(T.t('xx', una), T.TEXTOS[una].es);
  assert.throws(() => T.t('es', 'no.existe.esta.clave'), /no\.existe\.esta\.clave/);
  const conValor = claves.find((k) => T.valoresDe(T.TEXTOS[k].es).length > 0);
  const vals = Object.fromEntries(T.valoresDe(T.TEXTOS[conValor].es).map((n) => [n, 'ZZ']));
  assert.ok(!/\{[a-z]+\}/i.test(T.t('en', conValor, vals)), 'los valores se reemplazan');
});

/** El sitio entero con el laboratorio: las pestañas del núcleo, la ayuda y Corridas (con un espejo vacío). */
async function conLaboratorio(fn) {
  const emisor = await arrancarEmisor();
  const f = H.fuentesFijas({ config: configAcme(), modelo: modeloAcme() });
  f.dirBuzon = tmp('site-texts-buzon-');
  f.hilos = () => false;
  f.clones = () => ({ operaciones: null, perfil: null });
  f.alRefrescar = () => {};
  f.buzonEstado = () => ({ completo: true, generacion: 1 });
  const env = H.envBase({ SITE_OIDC_ISSUER: emisor.issuer, SITE_DATA_DIR: tmp('site-texts-datos-') });
  const cfg = validarConfiguracion(env).cfg;
  const runs = require(path.join(H.SITE, 'tabs', 'runs.js')).crearRutas({ cfg, fuentes: f, skillsDir: path.join(ROOT, 'skills') });
  const h = await H.arrancarSitio({ env, fuentes: f, rutasExtra: [...runs, ...HELP.crearRutas({})], version: '2026.10.15.1' });
  try {
    if (runs.vista && runs.vista.listo) await runs.vista.listo();
    const entrar = async (email) => (await H.ingresar(h, emisor, { sub: `s-${email}`, email, email_verified: true })).sesion;
    await fn({ h, entrar, fuentes: f });
  } finally { await h.cerrar(); await emisor.cerrar(); }
}

test('T8 Textos_NingunaPaginaEnInglesTraeCastellano @story-2.42 @ac-4 @ac-5 @ac-9 @story-2.60 @ac-2', async () => {
  // el detector, contra un texto escrito en una vista: rojo con la página y el texto
  assert.deepStrictEqual(enCastellano(textosVisibles('<main><p>Esa página no existe.</p><p>Nothing here.</p></main>')), ['Esa página no existe.']);
  assert.deepStrictEqual(enCastellano(['Acme Web: 3 items'], DATOS), [], 'los datos de afuera no cuentan');
  await conLaboratorio(async ({ h, entrar, fuentes }) => {
    const lead = await entrar(MANTIENE);
    const ana = await entrar(PERSONA);
    const fuera = await entrar('nadie@acme.example');
    const en = 'sitio-idioma=en';
    const paginas = [['/', lead], ['/proyectos', lead], ['/arnes', lead], ['/corridas', lead], ['/ayuda', lead], ['/no-existe', lead],
      ['/', ana], ['/proyectos', ana], ['/arnes', ana], ['/ayuda', ana], ['/', fuera]];
    const hallazgos = [];
    for (const [ruta, ses] of paginas) {
      const r = await h.pedir(ruta, { cookie: `${ses}; ${en}` });
      // cada página se arma de verdad: un 302 al inicio de sesión no es una página en inglés
      const esperado = ruta === '/no-existe' ? 404 : (ses === ana && ruta === '/arnes' ? 403 : 200);
      assert.strictEqual(r.status, esperado, `${ruta}: ${r.status}`);
      // la ayuda trae la guía en inglés: su cuerpo es de la guía, no de la tabla. El cuerpo de la pestaña
      // de ejecuciones sale en el idioma de la página; con ejecuciones de verdad lo mira Corridas_ElCuerpoEnIngles (site-runs.test.js)
      const html = ruta === '/ayuda' ? r.texto.replace(/<article[\s\S]*<\/article>/, '') : r.texto;
      for (const t of enCastellano(textosVisibles(html), DATOS)) hallazgos.push(`${ruta}: «${t}»`);
    }
    // las páginas del freno y de la carga
    fuentes.st.frenado = { desde: AHORA - 3600000 };
    for (const t of enCastellano(textosVisibles((await h.pedir('/', { cookie: `${lead}; ${en}` })).texto), DATOS)) hallazgos.push(`frenado: «${t}»`);
    fuentes.st.frenado = null; fuentes.st.cargado = false; fuentes.st.navegable = false;
    for (const t of enCastellano(textosVisibles((await h.pedir('/', { cookie: `${lead}; ${en}` })).texto), DATOS)) hallazgos.push(`cargando: «${t}»`);
    fuentes.st.cargado = true; fuentes.st.navegable = true;
    // la banda de un refresco fallido y el cartel de la configuración
    fuentes.st.bandaRefresco = { desde: AHORA - 600000, estado: 'sin_red' };
    fuentes.st.bandaConfig = { desde: AHORA - 600000, motivo: 'x' };
    for (const t of enCastellano(textosVisibles((await h.pedir('/', { cookie: `${lead}; ${en}` })).texto), [...DATOS, ': x'])) hallazgos.push(`bandas: «${t}»`);
    assert.deepStrictEqual(hallazgos, [], `texto en castellano en páginas en inglés:\n${hallazgos.join('\n')}`);
    // y en castellano siguen en castellano
    const es = await h.pedir('/', { cookie: lead });
    assert.strictEqual(es.status, 200);
    assert.ok(enCastellano(textosVisibles(es.texto), DATOS).length > 5, 'la página en castellano sigue en castellano');
  });
});

// ── Configuración ────────────────────────────────────────────────────────────────────────────────────────────────
function g(dir, ...a) {
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@acme.example', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@acme.example', GIT_AUTHOR_DATE: '2026-10-16T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-16T12:00:00Z' } });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function clon(archivos) {
  const d = tmp('site-texts-clon-');
  g(d, 'init', '-q', '-b', 'main');
  for (const [rel, c] of Object.entries(archivos)) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), typeof c === 'string' ? c : ORG.formatJson(c));
  }
  g(d, 'add', '-A'); g(d, 'commit', '-q', '-m', 'base');
  return d;
}

/** Corre el código de pantalla de Configuración con un documento mínimo y la respuesta dada; devuelve sus textos. */
async function pantallaCon(codigo, respuesta, alAtributo = () => {}) {
  const nodo = () => { const n = { hijos: [], textContent: '', attrs: {}, setAttribute(k, v) { n.attrs[k] = v; alAtributo({ [k]: v }); }, appendChild(c) { n.hijos.push(c); return c; }, addEventListener() {}, replaceChildren(...cs) { n.hijos = cs; } }; return n; };
  const app = nodo();
  const document = { querySelector: () => null, getElementById: (id) => (id === 'config-app' ? app : null), createElement: () => nodo() };
  new Function('document', 'fetch', codigo)(document, () => Promise.resolve({ status: 200, json: () => Promise.resolve(respuesta) }));
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  const textos = (n) => [n.textContent, ...['aria-label', 'title', 'placeholder'].map((k) => n.attrs && n.attrs[k]), ...(n.hijos || []).flatMap(textos)].filter(Boolean);
  return textos(app);
}

test('T9 Textos_ConfiguracionEnLosDosIdiomas @story-2.42 @ac-4 @story-2.57 @ac-5 @ac-8', async () => {
  const ops = clon({ 'operations.json': configAcme() });
  const perfil = clon({ 'team-profile.json': { version: 1, packs: { default: ['bizuit'] } } });
  const emisor = await arrancarEmisor();
  const f = H.fuentesFijas({ config: configAcme() });
  f.clones = () => ({ operaciones: { dir: ops }, perfil: { dir: perfil } });
  f.dirBuzon = tmp('site-texts-cfg-buzon-');
  f.exclusivo = (fn) => fn();
  const env = H.envBase({ SITE_OIDC_ISSUER: emisor.issuer, SITE_PROFILE_REPO: 'https://git.acme.example/perfil.git', SITE_PROFILE_TOKEN: ['tok', 'perfil'].join('-') });
  const cfg = validarConfiguracion(env).cfg;
  const rutas = require(path.join(H.SITE, 'tabs', 'config.js')).crearRutas({ cfg, fuentes: f, versionImagen: '2026.10.15.48', ahora: () => AHORA });
  const h = await H.arrancarSitio({ env, fuentes: f, rutasExtra: rutas });
  try {
    const lead = (await H.ingresar(h, emisor, { sub: 's-lead', email: MANTIENE, email_verified: true })).sesion;
    const vistos = {};
    for (const idioma of ['es', 'en']) {
      const ck = `${lead}; sitio-idioma=${idioma}`;
      const pagina = await h.pedir('/configuracion', { cookie: ck });
      assert.strictEqual(pagina.status, 200);
      const src = (/<script src="(\/static\/config\.js[^"]*)"/.exec(pagina.texto) || [])[1];
      assert.strictEqual(src, `/static/config.js?l=${idioma}`, 'la página pide el código de pantalla en su idioma');
      const codigo = (await h.pedir(src, { cookie: ck })).texto;
      const api = (await h.pedir('/api/config', { cookie: ck })).json;
      assert.ok(api && api.ok, JSON.stringify(api).slice(0, 300));
      vistos[idioma] = await pantallaCon(codigo, api);
      // un valor inválido: el mensaje de la revisión en el idioma pedido
      const tok = (/<meta name="site-token" content="([^"]+)">/.exec(pagina.texto) || [])[1];
      const rev = (await h.pedir('/api/config/revisar', { method: 'POST', cookie: ck, headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json', 'x-site-token': tok }, body: JSON.stringify({ seccion: 'sitio', borrador: { site: { access: [{ emails: [PERSONA], role: 'dev' }] } } }) })).json;
      vistos[`${idioma}-rev`] = JSON.stringify(rev);
    }
    // castellano: como hoy
    assert.ok(vistos.es.some((t) => /Quién entra al sitio/.test(t)), 'el título de la sección en castellano');
    assert.match(vistos['es-rev'], /la lista tiene que tener a alguien que mantenga el sitio/);
    // inglés: títulos, ayudas, botones y el mensaje de validación, sin castellano
    assert.ok(vistos.en.some((t) => /Who gets into the site/.test(t)), `el título de la sección en inglés: ${vistos.en.slice(0, 40).join(' | ')}`);
    // el catálogo de lo que instala el arnés también, con su inglés: sin excepción
    const restos = enCastellano(vistos.en.flatMap((t) => String(t).split('\n')), [...DATOS, ...IDS_DE_FIRMAS, 'bizuit','operations.json', 'team-profile.json', 'team-repos.json']);
    assert.deepStrictEqual(restos, [], `Configuración en inglés con castellano:\n${restos.join('\n')}`);
    assert.doesNotMatch(vistos['en-rev'], /la lista tiene que tener/);
    assert.match(vistos['en-rev'], /the list must include a site maintainer/i);
  } finally { await h.cerrar(); await emisor.cerrar(); }
  // la página local (harness.js team-config) sigue igual: su código de pantalla, el de siempre en castellano
  assert.strictEqual(ORG.pantalla(), ORG.pantalla('es'));
  assert.match(ORG.pantalla(), /Quién entra al sitio/);
});

test('T10 Textos_LaAyudaSigueElIdioma @story-2.42 @ac-7', async () => {
  const GUIA = { es: path.join(ROOT, 'guides', 'organization-site.md'), en: path.join(ROOT, 'guides', 'organization-site.en.md') };
  const con = async (raiz, fn) => {
    const emisor = await arrancarEmisor();
    const h = await H.arrancarSitio({ env: H.envBase({ SITE_OIDC_ISSUER: emisor.issuer }), fuentes: H.fuentesFijas({ config: configAcme() }), rutasExtra: HELP.crearRutas({ raiz }) });
    try { await fn(h, (await H.ingresar(h, emisor, { sub: 's-ana', email: PERSONA, email_verified: true })).sesion); } finally { await h.cerrar(); await emisor.cerrar(); }
  };
  await con(ROOT, async (h, c) => {
    const en = await h.pedir('/ayuda', { cookie: `${c}; sitio-idioma=en` });
    assert.ok(en.texto.includes(`id="${HELP.ancla('What it is and what it is for')}"`), 'la guía en inglés');
    const es = await h.pedir('/ayuda', { cookie: `${c}; sitio-idioma=es` });
    assert.ok(es.texto.includes(`id="${HELP.ancla('Qué es y para qué sirve')}"`), 'la guía en castellano');
  });
  // sin la guía en inglés: la castellana, con el aviso en inglés
  const raiz = tmp('site-texts-solo-es-');
  fs.mkdirSync(path.join(raiz, 'guides'), { recursive: true });
  fs.copyFileSync(GUIA.es, path.join(raiz, 'guides', 'organization-site.md'));
  await con(raiz, async (h, c) => {
    const r = await h.pedir('/ayuda', { cookie: `${c}; sitio-idioma=en` });
    assert.ok(r.texto.includes(`id="${HELP.ancla('Qué es y para qué sirve')}"`), 'la castellana');
    assert.match(r.texto, /does not include help in English|no English help/i, 'el aviso, en inglés');
    assert.doesNotMatch(r.texto, /se muestra en/);
  });
  // el idioma de la ayuda es el del pedido
  assert.strictEqual(HELP.idiomaDe({ idioma: 'en' }), 'en');
  assert.strictEqual(HELP.idiomaDe({ idioma: 'es' }), 'es');
});

test('T9b Textos_LaTraduccionDeMensajes_NoTocaDatos @story-2.42 @ac-4 — el caso que encontró el pase adversarial', () => {
  const T = TEXTS();
  // un mensaje de la casa, con un valor que es otro mensaje de la casa
  assert.strictEqual(T.traducirMensaje('en', 'scripts/x.json no se pudo leer (EACCES): se corrige a mano'), 'scripts/x.json could not be read (EACCES): fix it by hand');
  // lo que dice un lector del arnés pasa tal cual; en castellano, nada cambia
  assert.strictEqual(T.traducirMensaje('en', 'el lector dice otra cosa'), 'el lector dice otra cosa');
  assert.strictEqual(T.traducirMensaje('es', 'al día'), 'al día');
  // los datos de la organización no se traducen aunque coincidan con un molde: una máquina «medido», una persona «nada»
  const r = T.traducirRespuesta('en', { versiones: [{ maquina: 'medido', persona: 'nada', texto: 'al día', diaTexto: 'sin fecha' }], borrador: { x: 'al día' }, oid: 'al día' });
  assert.deepStrictEqual(r.versiones[0], { maquina: 'medido', persona: 'nada', texto: 'up to date', diaTexto: 'no date' });
  assert.deepStrictEqual([r.borrador, r.oid], [{ x: 'al día' }, 'al día'], 'el borrador y la versión del archivo no se tocan');
  // el texto de un archivo (termina con un salto) tampoco
  assert.strictEqual(T.traducirRespuesta('en', { texto: 'al día\n' }).texto, 'al día\n');
  // un valor de un molde que es un dato (un archivo) no se traduce aunque coincida con otro molde
  assert.strictEqual(T.traducirMensaje('en', 'al día no se pudo leer (EIO)'), 'al día could not be read (EIO)');
  // un texto largo no se prueba contra los moldes: no cuelga el sitio
  const v = T.TEXTOS['org.capaPideRepos'].es;
  const partes = v.split(/\{[A-Za-z0-9_]+\}/);
  let s = partes[0];
  for (let i = 0; i < 300; i++) s += `x${partes.slice(1, -1).join('x')}`;
  s += 'xZZZ';
  // stable-data: mide cuánto tarda, no compara contra una fecha
  const t0 = Date.now();
  assert.strictEqual(T.traducirMensaje('en', s), s);
  assert.ok(Date.now() - t0 < 500, `tardó ${Date.now() - t0} ms con ${s.length} caracteres`);
});

test('T8b Textos_ElAvisoDeCorridasSigueElIdioma @story-2.42 @ac-4', async () => {
  // lo que arma el sitio alrededor de la vista de corridas: cargando y sin buzón, en inglés
  const emisor = await arrancarEmisor();
  const f = H.fuentesFijas({ config: configAcme(), modelo: { corridas: { estado: 'no_medido', codigo: 'cargando' } } });
  f.dirBuzon = tmp('site-texts-runs-');
  f.hilos = () => false; f.clones = () => ({ operaciones: null, perfil: null }); f.alRefrescar = () => {};
  f.buzonEstado = () => ({ completo: false, generacion: 0, siguiendo: true });
  const env = H.envBase({ SITE_OIDC_ISSUER: emisor.issuer });
  const runs = require(path.join(H.SITE, 'tabs', 'runs.js')).crearRutas({ cfg: validarConfiguracion(env).cfg, fuentes: f, skillsDir: path.join(ROOT, 'skills'), armar: () => new Promise(() => {}) });
  const h = await H.arrancarSitio({ env, fuentes: f, rutasExtra: runs });
  try {
    const c = (await H.ingresar(h, emisor, { sub: 's-lead', email: MANTIENE, email_verified: true })).sesion;
    const en = await h.pedir('/corridas', { cookie: `${c}; sitio-idioma=en` });
    // sin buzón configurado: el aviso del sitio, en el idioma de la página
    assert.match(en.texto, /no mailbox set up: not measured/);
    assert.deepStrictEqual(enCastellano(textosVisibles(en.texto), DATOS), []);
    const es = await h.pedir('/corridas', { cookie: c });
    assert.match(es.texto, /sin buzón configurado: no medido/);
  } finally { await h.cerrar(); await emisor.cerrar(); }
});

// ── Configuración entera en inglés, con el catálogo de lo que instala el arnés ───────────────────────────────────────
/** Configuración con más datos del laboratorio Acme (máquinas, buzón, perfil con integraciones y paquetes), en un idioma:
 *  los textos que dibuja la pantalla, los ids de sección que dibujó y la respuesta de /api/config. */
async function configuracionAcme(idioma) {
  const opsDoc = { ...configAcme(), people: { machines: { 'acme-mac-1': { person: PERSONA, reported_sha256: null, confirmed_by: MANTIENE, confirmed_on: '2026-10-01' } } } };
  opsDoc.site = { ...opsDoc.site, url: 'https://site.acme.example', refresh_minutes: 15, mailbox: { provider: 'azure-blob', account: 'acmeruns', container: 'runs', threads: false } };
  const ops = clon({ 'operations.json': opsDoc });
  const perfil = clon({ 'team-profile.json': { version: 1, ado: { org: 'https://dev.azure.com/acme' }, integrations: { clockify: false, engram: true, mailbox: true, codex: 'detect', nightly: true },
    update: { channel: 'latest', apply: 'auto' }, packs: { default: ['bizuit'] }, install: { profile: 'full' } } });
  const emisor = await arrancarEmisor();
  const f = H.fuentesFijas({ config: opsDoc });
  f.clones = () => ({ operaciones: { dir: ops }, perfil: { dir: perfil } });
  f.dirBuzon = tmp('site-texts-cfg2-buzon-');
  f.exclusivo = (fn) => fn();
  const env = H.envBase({ SITE_OIDC_ISSUER: emisor.issuer, SITE_PROFILE_REPO: 'https://git.acme.example/perfil.git', SITE_PROFILE_TOKEN: ['tok', 'perfil'].join('-') });
  const cfg = validarConfiguracion(env).cfg;
  const rutas = require(path.join(H.SITE, 'tabs', 'config.js')).crearRutas({ cfg, fuentes: f, versionImagen: '2026.10.15.48', ahora: () => AHORA });
  const h = await H.arrancarSitio({ env, fuentes: f, rutasExtra: rutas });
  try {
    const lead = (await H.ingresar(h, emisor, { sub: 's-lead', email: MANTIENE, email_verified: true })).sesion;
    const ck = `${lead}; sitio-idioma=${idioma}`;
    const pagina = await h.pedir('/configuracion', { cookie: ck });
    const src = (/<script src="(\/static\/config\.js[^"]*)"/.exec(pagina.texto) || [])[1];
    const codigo = (await h.pedir(src, { cookie: ck })).texto;
    const api = (await h.pedir('/api/config', { cookie: ck })).json;
    assert.ok(api && api.ok, JSON.stringify(api).slice(0, 300));
    const ids = [];
    const textos = await pantallaCon(codigo, api, (attrs) => { if (attrs.id) ids.push(attrs.id); });
    return { textos: textos.flatMap((t) => String(t).split('\n')), ids, api, codigo };
  } finally { await h.cerrar(); await emisor.cerrar(); }
}
const EFECTOS = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'install-effects.json'), 'utf8')).effects;

test('2.57 · Textos_ElCatalogoEnElIdiomaDeLaPagina @story-2.57 @ac-4', async () => {
  const T = TEXTS();
  const guarda = EFECTOS().find((e) => e.id === 'PreToolUse:@tcg:session-collision-guard.js');
  const frenos = EFECTOS().find((e) => e.id === 'PreToolUse:@tcg:safety-guard-pre.sh');
  const en = await configuracionAcme('en');
  // en inglés: el título, el detalle y dónde se cambia, con la frase del interruptor en inglés
  for (const x of [guarda.en.title, guarda.en.does, frenos.en.title, frenos.en.does]) assert.ok(en.textos.includes(x), `en inglés falta «${x}»`);
  // el freno de dos sesiones lo enciende la organización desde «Frenos y medidores»: la frase dice dónde, en inglés
  const donde = T.t('en', 'pantalla.vieneApagado') + T.t('en', 'pantalla.seCambiaEnConfiguracion') + T.t('en', 'pantalla.comoTrabajaClaude') + ' → ' + T.t('en', 'pantalla.interruptoresTitulo') + '.';
  assert.strictEqual(donde, 'Off by default. Change it in Configuration → How the agent works → Brakes and meters.', 'la frase se lee entera en inglés');
  assert.ok(en.textos.some((t) => t.startsWith(donde)), `en inglés: «${donde}» (${en.textos.filter((t) => t.includes('Brakes and meters')).join(' | ')})`);
  for (const x of [guarda.title, guarda.does, frenos.title, guarda.switch]) assert.ok(!en.textos.some((t) => t.includes(x)), `en inglés sale el castellano «${x}»`);
  // en castellano: lo mismo, en castellano
  const es = await configuracionAcme('es');
  for (const x of [guarda.title, guarda.does, frenos.title]) assert.ok(es.textos.includes(x), `en castellano falta «${x}»`);
  assert.ok(es.textos.some((t) => t.startsWith('Viene apagado. Se cambia en Configuración → Cómo trabaja el agente → Frenos y medidores.')), 'en castellano, dónde se cambia');
  assert.ok(!es.textos.includes(guarda.en.title), 'en castellano no sale el inglés');
  // una pieza sin su inglés, con la página en inglés: sale en castellano (decisión 7), no vacía
  const api = JSON.parse(JSON.stringify(en.api));
  const inst = api.secciones.find((s) => s.id === 'instalacion');
  const sinEn = inst.extras.perfiles.minimal.find((f) => f.title === guarda.title) || inst.extras.perfiles.full.find((f) => f.title === guarda.title);
  assert.ok(sinEn && sinEn.en, 'la ficha de la pieza trae su inglés');
  for (const p of ['minimal', 'full']) for (const f of inst.extras.perfiles[p]) if (f.title === guarda.title) f.en = null;
  const caida = (await pantallaCon(en.codigo, api)).flatMap((t) => String(t).split('\n'));
  assert.ok(caida.includes(guarda.title) && caida.includes(guarda.does), 'sin en: el título y el detalle en castellano');
  assert.ok(caida.some((t) => t.startsWith(donde)), 'sin en: dónde se cambia sigue en el idioma de la página');
  assert.ok(!caida.includes(guarda.en.title), 'sin en: no aparece el inglés de otra');
});

test('2.57 · Textos_TodasLasSeccionesDeConfiguracionEnIngles @story-2.57 @ac-6', async () => {
  const { textos, ids, api } = await configuracionAcme('en');
  // la pantalla dibujó cada sección que mandó el servidor, en sus cinco pestañas
  const secciones = api.secciones.map((s) => s.id);
  assert.ok(secciones.length >= 20, `las secciones de Configuración (${secciones.length})`);
  const faltan = secciones.filter((id) => !ids.includes(`seccion-${id}`));
  assert.deepStrictEqual(faltan, [], 'secciones que la pantalla no dibujó');
  for (const p of ['personas', 'repos', 'avisos', 'claude', 'instalacion']) assert.ok(ids.includes(`pestana-${p}`), `la pestaña ${p}`);
  // y ninguna trae castellano: ni sus títulos, ni sus ayudas, ni el catálogo de lo que instala el arnés
  const restos = enCastellano(textos, [...DATOS, ...IDS_DE_FIRMAS, 'acme-mac-1','acmeruns', 'bizuit', 'operations.json', 'team-profile.json', 'team-repos.json']);
  assert.deepStrictEqual(restos, [], `Configuración en inglés con castellano:\n${restos.join('\n')}`);
  // el detector no ve el castellano sin tildes («Frena comandos destructivos o riesgosos»): el catálogo se compara entero
  const castellano = new Set(EFECTOS().flatMap((e) => [e.title, e.does]));
  const delCatalogo = textos.filter((t) => castellano.has(t));
  assert.deepStrictEqual(delCatalogo, [], `piezas en castellano en la página en inglés:\n${delCatalogo.join('\n')}`);
  // y la frase en castellano de los interruptores («lo prende»), que va dentro de una oración: se busca adentro
  const frases = EFECTOS().map((e) => (typeof e.switch === 'string' ? e.switch.trim().split(' ').slice(1).join(' ') : '')).filter(Boolean);
  assert.strictEqual(frases.length, 4, `los cuatro interruptores con frase (${frases.join(' | ')})`);
  const conFrase = textos.filter((t) => frases.some((f) => t.includes(f)));
  assert.deepStrictEqual(conFrase, [], `interruptores en castellano en la página en inglés:\n${conFrase.join('\n')}`);
});

test('2.57 · Textos_LasFuentesConSuNombreEnIngles @story-2.57 @ac-7 @ac-8', () => {
  const V = require(path.join(H.SITE, 'views.js'));
  // las fuentes de la noche se llaman por su id, en castellano («dependencias», «vigilante»): en inglés, con su nombre
  const ids = require(path.join(ROOT, 'scripts', 'nightly', 'dashboard', 'sources.json')).sources.map((s) => s.id);
  // cada fuente de la noche tiene su nombre en la tabla: una nueva sin nombre saldría con su id, aunque fuera castellano
  const sinNombre = ids.filter((id) => !Object.prototype.hasOwnProperty.call(TEXTS().TEXTOS, `fuente.${id}`));
  assert.deepStrictEqual(sinNombre, [], `fuentes de sources.json sin su clave fuente.<id> en texts.js: ${sinNombre.join(', ')}`);
  const m = { sources: { lista: [...ids, 'propia-de-acme'].map((id) => ({ id, estado: 'medido', fecha: HOY })) } };
  const titulos = (idioma) => V.filasArnes(m, { idioma }).filter((l) => /^fuente:/.test(l.clave)).map((l) => l.titulo);
  const en = titulos('en');
  assert.strictEqual(en.length, ids.length + 1, 'una línea por fuente');
  assert.ok(en.includes('Source dependencies') && en.includes('Source watcher') && en.includes('Source controls bench'), en.join(' | '));
  assert.ok(en.includes('Source propia-de-acme'), 'una fuente propia de la organización sale con su id');
  const restos = enCastellano(en.filter((t) => t !== 'Source propia-de-acme'), ['sdlc-stage']);
  assert.deepStrictEqual(restos, [], `fuentes con nombre en castellano en inglés:\n${restos.join('\n')}`);
  // ninguna fuente conocida sale con su id en castellano
  for (const id of ['dependencias', 'vigilante', 'banco', 'suites', 'paridad', 'corridas', 'pasos-corrida', 'concentracion']) {
    assert.ok(!en.includes(`Source ${id}`), `«Source ${id}» en inglés`);
  }
  // en castellano: «Fuente <su nombre>», que es el id salvo donde la tabla le da otro (corridas → ejecuciones)
  const nombreEs = (id) => (TEXTS().TEXTOS[`fuente.${id}`] || {}).es || id;
  assert.deepStrictEqual(titulos('es'), [...ids, 'propia-de-acme'].map((id) => `Fuente ${nombreEs(id)}`));
});

test('Textos_EncabezadosEnUnRenglon_ConfiguracionConSuComoFunciona', () => {
  // el encabezado de cada pestaña entra en un renglón; lo de Configuración que explica cómo se revisa y se propone va en
  // un desplegable cerrado de entrada
  const tx = TEXTS();
  const tabla = tx.TEXTOS || tx.textos || tx;
  for (const [k, v] of Object.entries(tabla)) {
    if (!/(^|\.)lede(Mantiene|Persona)?$/.test(k) || k === 'comoTrabaja.lede') continue;
    for (const idioma of ['es', 'en']) assert.ok(v[idioma].length <= 130, `${k} (${idioma}): ${v[idioma].length} caracteres`);
  }
  for (const k of ['config.comoFunciona', 'config.comoFunciona.revisar', 'config.comoFunciona.sinCambios', 'config.comoFunciona.anteLaDuda', 'config.comoFunciona.palabras']) {
    assert.ok(tabla[k] && tabla[k].es && tabla[k].en, `${k} en los dos idiomas`);
  }
  const codigo = fs.readFileSync(path.join(H.SITE, 'tabs', 'config.js'), 'utf8');
  assert.match(codigo, /<details class="mas-info como-funciona">/);
  assert.doesNotMatch(codigo, /<details class="mas-info como-funciona" open/);
});
