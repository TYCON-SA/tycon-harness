'use strict';
/*
 * tabs/config.js — LA PESTAÑA CONFIGURACIÓN DEL SITIO DE LA ORGANIZACIÓN (story 2.29).
 *
 * Qué resuelve: quien mantiene el arnés en una organización configura lo de la organización desde el sitio —dónde vive
 * cada repo, a quién se asignan avisos y pedidos, los despliegues, el canal del aviso, personas y máquinas, el sitio
 * mismo, los umbrales y las diferencias declaradas de la paridad— con las MISMAS validaciones que usa el arnés, y cada
 * cambio se propone con una rama y un pedido al repo que corresponde (nunca se escribe la rama principal). No toca la
 * configuración de ninguna máquina; muestra, de sólo lectura, los productos y la versión del arnés de cada máquina.
 *
 * QUIÉN ENTRA (AC 1 a 3): todas las rutas se registran en la tabla de la 2.23 como `maintainer` (un dev recibe 403 sin
 * un dato; sin sesión, lo que manda la 2.23). Cada ESCRITURA exige, en este orden: el `Origin` del sitio (o, sin `Origin`,
 * `Sec-Fetch-Site: same-origin`), `X-Site-Token` igual al token de la sesión (doble envío: nace con la sesión en la
 * cookie firmada y la página lo recibe en un `<meta>`), `Content-Type` JSON y un cuerpo de hasta 256 KB. Ninguna falta
 * crea nada en ningún repo.
 *
 * LO QUE LEE (AC 5): los clones que mantienen las fuentes de la 2.23 (`fuentes.clones()`): el de operaciones y, con
 * `SITE_PROFILE_REPO`, el del perfil; el espejo del buzón (`fuentes.dirBuzon`) para las versiones. Las secciones, sus
 * lectores y la revisión viven en scripts/lib/org-config.js (el núcleo común con la página local); la propuesta, en
 * scripts/lib/repo-proposal.js. «Descargar el archivo» no es una ruta: el navegador lo arma con lo que «Revisar» validó.
 *
 * Rutas: GET /configuracion (la página) · GET /static/config.js (su código, sin nada en línea) · GET /api/config (las
 * secciones) · POST /api/config/revisar · POST /api/config/stages (la propuesta de stages, sólo lee) ·
 * POST /api/config/proponer. Casos: scripts/tests/site-config.test.js.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ORG = require('../../lib/org-config.js');
const RP = require('../../lib/repo-proposal.js');
const people = require('../../lib/people.js');
const access = require('../access.js');
const views = require('../views.js');
const { dentroDe } = require('../sources.js');

const TREE = path.join(__dirname, '..', '..', '..');
const CUERPO_MAX = 256 * 1024;
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const norm = (c) => String(c || '').trim().toLowerCase();
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const json = (status, obj) => ({ status, tipo: 'application/json; charset=utf-8', cuerpo: JSON.stringify(obj) });
const rechazo = (status, message) => json(status, { ok: false, message });

/** Un archivo de un clon: `{ estado: 'leido', texto, oid }` · `{ estado: 'nuevo' }` · `{ estado: 'ilegible', motivo }`. */
function leer(dir, rel) {
  const ruta = path.join(dir, rel);
  let texto;
  try {
    if (fs.existsSync(ruta) && !dentroDe(dir, ruta)) return { estado: 'ilegible', motivo: `${rel} no es un archivo del repo` };
    texto = fs.readFileSync(ruta, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { estado: 'nuevo' };
    return { estado: 'ilegible', motivo: `${rel} no se pudo leer (${(e && e.code) || 'error'})` };
  }
  const r = spawnSync('git', ['-C', dir, 'rev-parse', `HEAD:${rel}`], { encoding: 'utf8', windowsHide: true });
  // sin la versión del archivo, «Proponer» no puede saber si cambió: se dice, no se sigue con null
  if (r.status !== 0) return { estado: 'ilegible', motivo: `git no pudo leer la versión de ${rel} en el clon` };
  return { estado: 'leido', texto, oid: r.stdout.trim() };
}
const docDe = (t) => { try { const v = JSON.parse(t); return isObject(v) ? v : null; } catch { return null; } };

/**
 * Las rutas de la pestaña, para `rutasExtra` de crearSitio. `cfg` es la del servidor; `fuentes`, las de la 2.23.
 * Inyectables (pruebas): `lectores`, `versionImagen`, `ahora`, `hoy`, `fetch`, `urlBase` (la dirección de la API de cada plataforma) y
 * `remotos` ({ operaciones, perfil }: la plataforma de cada repo cuando la dirección no la dice).
 */
function crearRutas({ cfg, fuentes, versionImagen = null, ahora = Date.now, hoy = null, lectores = {}, fetch = globalThis.fetch, urlBase = {}, remotos = {}, log = () => {} }) {
  const dia = () => (hoy ? hoy() : new Date(ahora()).toISOString().slice(0, 10));
  const lector = (nombre) => ORG.loadReader(TREE, nombre, lectores);
  // los umbrales del arnés (los de la imagen): `{ thresholds, motivo }`; sin ellos, Umbrales no edita y lo dice
  const arnes = () => {
    let texto = null;
    try { texto = fs.readFileSync(path.join(TREE, 'scripts', 'nightly', 'dashboard', 'sources.json'), 'utf8'); } catch (e) { return { thresholds: {}, motivo: `no se pudo leer el sources.json del arnés (${(e && e.code) || 'error'})` }; }
    const d = docDe(texto);
    return d && isObject(d.thresholds) ? { thresholds: d.thresholds, motivo: null } : { thresholds: {}, motivo: 'el sources.json del arnés no trae umbrales legibles' };
  };
  const clones = () => (typeof fuentes.clones === 'function' ? fuentes.clones() : { operaciones: null, perfil: null });
  const urlDe = (repo) => (repo === 'perfil' ? cfg.profileRepo : cfg.operationsRepo);
  const remoteDe = (repo) => remotos[repo] || ORG.remoteOf(urlDe(repo));

  // ── la defensa de las escrituras (AC 3) ──
  async function escritura(ctx) {
    const h = ctx.req.headers;
    if (h.origin) { if (h.origin !== cfg.publicUrl) return { error: rechazo(403, 'el pedido viene de otro origen') }; }
    else if (h['sec-fetch-site'] !== 'same-origin') return { error: rechazo(403, 'falta el origen del pedido') };
    const tok = h['x-site-token'];
    if (!tok) return { error: rechazo(403, 'falta el token del sitio') };
    const propio = ctx.sesion && typeof ctx.sesion.tok === 'string' ? Buffer.from(ctx.sesion.tok) : Buffer.alloc(0);
    const traido = Buffer.from(String(tok));
    if (!propio.length || propio.length !== traido.length || !crypto.timingSafeEqual(propio, traido)) return { error: rechazo(403, 'el token no es el de tu sesión') };
    if (!/^application\/json\b/.test(String(h['content-type'] || ''))) return { error: rechazo(415, 'se espera JSON') };
    const cuerpo = await new Promise((resolve) => {
      let size = 0; const partes = []; let listo = false;
      ctx.req.on('data', (c) => { size += c.length; if (size > CUERPO_MAX) { if (!listo) { listo = true; resolve({ grande: true }); } } else partes.push(c); });
      ctx.req.on('end', () => { if (!listo) { listo = true; resolve({ texto: Buffer.concat(partes).toString('utf8') }); } });
      ctx.req.on('error', () => { if (!listo) { listo = true; resolve({ grande: true }); } });
    });
    if (cuerpo.grande) return { error: rechazo(400, 'el pedido es demasiado grande (más de 256 KB)') };
    try { return { body: cuerpo.texto ? JSON.parse(cuerpo.texto) : {} }; } catch { return { error: rechazo(400, 'el cuerpo no es JSON') }; }
  }

  // ── la vista de una sección ──
  function contextoPersonas(doc) {
    const pers = typeof fuentes.personas === 'function' ? fuentes.personas() : null;
    return { c: people.contexto({ operations: doc || {}, informados: pers && isObject(pers.informados) ? pers.informados : null }), informados: pers && isObject(pers.informados) ? pers.informados : null, pers };
  }

  function vista(s) {
    const base = { id: s.id, titulo: s.titulo, archivo: s.archivo, repo: s.repo, lector: s.lector, estado: 'cargado', motivo: null, soloLectura: false, borrador: {}, problems: [], avisos: [], texto: null, oid: null };
    const cl = clones();
    let dir = null;
    if (s.repo === 'perfil') {
      if (!cfg.profileRepo || !cl.perfil) return { ...base, estado: 'no_configurado', motivo: 'no configurado: el sitio no tiene SITE_PROFILE_REPO y SITE_PROFILE_TOKEN; team-repos.json se edita con un pedido al perfil' };
      if (!cl.perfil.dir) return { ...base, estado: 'no_configurado', motivo: cl.perfil.motivo || 'el perfil del equipo todavía no se bajó' };
      dir = cl.perfil.dir;
    } else {
      if (!cl.operaciones) return { ...base, estado: 'ilegible', motivo: 'el repo de operaciones todavía no se bajó' };
      dir = cl.operaciones.dir;
    }
    const a = leer(dir, s.archivo);
    if (a.estado === 'ilegible') return { ...base, estado: 'ilegible', motivo: `${a.motivo}: se corrige a mano` };
    const doc = a.estado === 'leido' ? docDe(a.texto) : null;
    const v = { ...base, texto: a.texto || null, oid: a.estado === 'leido' ? a.oid : null };

    if (s.id === 'umbrales') {
      const ar = arnes();
      const th = ar.thresholds;
      if (ar.motivo) return { ...v, soloLectura: true, motivo: `${ar.motivo}: sin los umbrales que conoce el arnés no se puede revisar ninguna fila`, borrador: doc && isObject(doc.thresholds) ? doc.thresholds : {} };
      if (a.estado === 'nuevo') return { ...v, soloLectura: true, motivo: 'tu organización no tiene su sources.json en el repo de operaciones: se muestran los umbrales del arnés, sin editar (crearlo copiaría también las fuentes)', borrador: th };
      const marca = leer(dir, '.dashboard/applied-config.json');
      const aplicado = marca.estado === 'leido' ? docDe(marca.texto) : null;
      if (marca.estado === 'ilegible' || (marca.estado === 'leido' && !aplicado)) return { ...v, soloLectura: true, motivo: 'la marca .dashboard/applied-config.json del nocturno no se pudo leer: sin ella no se sabe si tu nocturno lee este archivo', borrador: doc && isObject(doc.thresholds) ? doc.thresholds : th };
      const r = ORG.thresholdsParse(a.texto, { arnes: { thresholds: th }, tree: TREE });
      const borrador = doc && isObject(doc.thresholds) ? doc.thresholds : th;
      if (!aplicado || !isObject(aplicado.files) || !aplicado.files[s.archivo]) return { ...v, soloLectura: true, motivo: 'tu nocturno todavía no lee este archivo: se edita cuando una noche verde deje la marca .dashboard/applied-config.json', borrador, avisos: r.avisos || [] };
      if (r.soloLectura) return { ...v, soloLectura: true, motivo: r.problems[0].message, borrador };
      return { ...v, borrador, problems: r.problems, avisos: r.avisos || [] };
    }

    if (s.id === 'paridad') {
      if (a.estado === 'nuevo') return { ...v, estado: 'no_configurado', motivo: 'la lista de paridad no está en el repo de operaciones', vista: ORG.paridadPorProducto({ lista: null }) };
      if (!doc) return { ...v, estado: 'ilegible', motivo: 'la lista de paridad no se pudo leer: no es JSON válido' };
      const res = leer(dir, `.dashboard/paridad/paridad-${dia()}.json`);
      const leido = res.estado === 'leido' ? docDe(res.texto) : null;
      const vp = ORG.paridadPorProducto({ lista: doc, resultado: leido, hoy: dia(), resultadoIlegible: res.estado === 'ilegible' || (res.estado === 'leido' && !leido) });
      if (vp.estado === 'sin_productos' || vp.estado === 'sin_lista') return { ...v, estado: 'no_configurado', motivo: vp.texto, vista: vp };
      if (!lector('check-product-parity.js')) return { ...v, estado: 'no_reader', motivo: 'esta versión del arnés todavía no sabe leer las diferencias declaradas', vista: vp };
      return { ...v, vista: vp, borrador: {} };
    }

    const lec = lector(s.lector);
    if (!ORG.lectorSabe(lec, s)) return { ...base, estado: 'no_reader', motivo: `esta versión del arnés todavía no sabe leer ${s.archivo}${s.claves ? ` → ${s.claves.join(', ')}` : ''}` };
    if (a.estado === 'nuevo') v.estado = 'nuevo';
    // Personas tiene su propia regla con el archivo roto (abajo): el último bueno 24 horas
    else if (!doc && s.id !== 'personas') return { ...v, estado: 'ilegible', motivo: `${s.archivo} no es un objeto JSON legible: se corrige a mano` };
    const parsed = a.estado === 'leido' ? lec.parse(a.texto) : { ok: true, problems: [] };
    v.problems = (parsed.problems || []).filter((p) => !s.claves || s.claves.some((k) => p.path === k || String(p.path).startsWith(`${k}.`)));
    v.borrador = s.claves === null ? clone(doc || { version: 1 }) : Object.fromEntries(s.claves.filter((k) => doc && doc[k] !== undefined).map((k) => [k, clone(doc[k])]));
    if (s.id === 'sitio') v.campos = { url: Array.isArray(lec.SITE_KEYS) && lec.SITE_KEYS.includes('url') };
    if (s.id === 'personas') {
      // operations.json que no valida: el último bueno (24 h, la regla de la 2.28); el sitio frenado ya contesta 503
      let base2 = parsed.ok ? doc : null;
      const est = fuentes.estado();
      const extras = {};
      if (!base2) {
        base2 = fuentes.config();
        if (est.bandaConfig) extras.ultimoBueno = `se muestra el último bueno: operations.json no valida desde ${views.hora(est.bandaConfig.desde)} (${est.bandaConfig.motivo})`;
        else { extras.vencido = 'people venció: operations.json no valida hace más de 24 horas; se corrige a mano'; v.soloLectura = true; v.motivo = extras.vencido; }
        v.borrador = { people: clone((base2 && base2.people) || {}) };
      }
      const { c, informados, pers } = contextoPersonas(base2);
      extras.porConfirmar = informados ? people.maquinasPorConfirmar(c) : [];
      const reglas = access.crearReglas({ config: base2, modelo: fuentes.modelo(), personas: pers });
      const correos = [...new Set(Object.values(c.machines).filter(isObject).map((e) => norm(e.person)).filter(Boolean))].sort();
      extras.personas = correos.map((correo) => {
        const suyas = Object.entries(c.machines).filter(([, e]) => isObject(e) && norm(e.person) === correo).map(([m]) => m);
        return { correo, deducidos: reglas.proyectosDe(correo) || [], caida: suyas.every((m) => people.estadoDeMaquina(m, c).estado !== 'confirmada') };
      });
      v.extras = extras;
    }
    return v;
  }

  async function estadoProponer(repo) {
    const cred = cfg.escritura && cfg.escritura[repo];
    if (!cred) return { habilitado: false, motivo: 'sin identidad de escritura: revisá, descargá el archivo y abrí el pedido a mano' };
    const remote = remoteDe(repo);
    if (!remote.platform) return { habilitado: false, motivo: 'no reconozco la plataforma del repo: descargá el archivo y abrí el pedido a mano' };
    try {
      const p = await RP.politicaDeRevision({ remote, credencial: cred, urlBase, fetch });
      return p.ok ? { habilitado: true, motivo: null } : { habilitado: false, motivo: p.message };
    } catch (e) { return { habilitado: false, motivo: `no pude leer la política de la rama principal (${(e && e.name) || 'error'})` }; }
  }

  /** Los productos (AC 7): `{ lista, motivo }` — una lista que no se pudo leer lo dice; no es «ningún producto». */
  function productos(dirOps, opsDoc) {
    const out = [];
    const r = dirOps ? leer(dirOps, 'scripts/nightly/dependencies/repos.json') : { estado: 'nuevo' };
    const d = r.estado === 'leido' ? docDe(r.texto) : null;
    let motivo = null;
    if (r.estado === 'ilegible' || (r.estado === 'leido' && (!d || !Array.isArray(d.repos)))) motivo = 'la lista de la revisión de dependencias (repos.json) no se pudo leer: los productos de ahí no se muestran';
    for (const x of (d && Array.isArray(d.repos) ? d.repos : [])) {
      if (!isObject(x) || typeof x.producto !== 'string') continue;
      out.push({ producto: x.producto, origen: 'dependencias', repo: x.ado || x.github || x.ruta || null, activo: x.activo !== false, motivo: typeof x.motivo === 'string' ? x.motivo : null });
    }
    // la forma de `deployments` es la del lector de la 2.22: { provider, products: { "<producto>": { staging, production } } }
    const dep = opsDoc && isObject(opsDoc.deployments) && isObject(opsDoc.deployments.products) ? opsDoc.deployments.products : {};
    for (const k of Object.keys(dep)) if (!k.startsWith('__')) out.push({ producto: k, origen: 'deployments', repo: null, activo: true, motivo: null });
    return { lista: out, motivo };
  }
  const enlaceArchivo = (rel) => RP.enlaceArchivo(remoteDe('operaciones'), rel);

  async function leerTodo() {
    const secciones = ORG.SECCIONES.map(vista);
    const cl = clones();
    const opsDoc = cl.operaciones ? docDe((leer(cl.operaciones.dir, 'operations.json').texto) || '') : null;
    const machines = (opsDoc || fuentes.config() || {}).people;
    const quien = Object.fromEntries(Object.entries(isObject(machines) && isObject(machines.machines) ? machines.machines : {}).filter(([, e]) => isObject(e)).map(([m, e]) => [m, norm(e.person)]));
    const prods = productos(cl.operaciones && cl.operaciones.dir, opsDoc);
    let versionesMotivo = null;
    try { fs.readdirSync(fuentes.dirBuzon); } catch (e) { if (e && e.code !== 'ENOENT') versionesMotivo = `el espejo del buzón no se pudo leer (${e.code || 'error'}): la versión de cada máquina no se sabe`; }
    return {
      ok: true, secciones,
      proponer: { operaciones: await estadoProponer('operaciones'), perfil: cfg.profileRepo ? await estadoProponer('perfil') : { habilitado: false, motivo: 'el perfil del equipo no está configurado en el sitio' } },
      productos: prods.lista, productosMotivo: prods.motivo, versionesMotivo,
      productosEnlace: enlaceArchivo('scripts/nightly/dependencies/repos.json'),
      versiones: ORG.versionesDeMaquinas({ espejo: fuentes.dirBuzon, versionImagen, ahora: ahora(), personas: quien }),
    };
  }

  // ── revisar ──
  function revisarSeccion(s, borradorIn, ctx) {
    const v = vista(s);
    if (['no_reader', 'no_configurado', 'ilegible'].includes(v.estado) || v.soloLectura) return { ok: false, problems: [{ path: '', message: v.motivo, sinCampo: true }], texto: null };
    let borrador = clone(borradorIn);
    const problemas = [];
    let advertencia = null;
    if (s.id === 'personas' && isObject(borrador) && borrador.accion === 'confirm') {
      const peopleDoc = clone(isObject(borrador.people) ? borrador.people : ((docDe(v.texto || '') || {}).people || {}));
      const { informados } = contextoPersonas(null);
      const inf = informados && isObject(informados.maquinas) ? informados.maquinas[borrador.maquina] : null;
      const correo = inf && inf.estado === 'informa' ? inf.correo : null;
      peopleDoc.machines = isObject(peopleDoc.machines) ? peopleDoc.machines : {};
      // el correo informado nunca se escribe en claro: la huella, normalizada (2.28, decisiones 3 y 5)
      peopleDoc.machines[borrador.maquina] = { person: norm(borrador.person || correo || ''), reported_sha256: correo ? people.huellaDeCorreo(correo) : null, confirmed_by: norm(ctx.sesion.email), confirmed_on: dia() };
      borrador = { people: peopleDoc };
    }
    if (s.id === 'sitio') {
      const lista = isObject(borrador) && isObject(borrador.site) ? borrador.site.maintainers : undefined;
      if (!Array.isArray(lista) || !lista.length) problemas.push({ path: 'site.maintainers', message: 'la lista de los que mantienen no puede quedar vacía: quedaría sin nadie que pueda entrar a esta pestaña' });
      else if (!lista.map(norm).includes(norm(ctx.sesion.email))) advertencia = 'no estás en la lista que proponés: al mergear perdés el acceso a esta pestaña';
    }
    const r = ORG.revisar({ seccion: s, texto: v.texto, borrador, lectores: { [s.lector]: lector(s.lector) }, arnes: { thresholds: arnes().thresholds }, hoy: dia(), tree: TREE });
    const problems = [...problemas, ...r.problems];
    return { ...r, ok: r.ok && !problemas.length, problems, texto: r.ok && !problemas.length ? r.texto : null, borrador, advertencia };
  }

  /** El texto que llega a «Proponer» se vuelve a validar entero, con el lector de su archivo: nunca se confía en la pantalla. */
  function validarTexto(s, texto) {
    const doc = docDe(texto);
    if (!doc || ORG.formatJson(doc) !== texto) return 'el archivo propuesto no es el que validó «Revisar»: revisá de nuevo';
    // el pedido cambia sólo la sección (AC 23): lo demás del archivo tiene que quedar como está en el clon
    if (s.claves) {
      const actual = docDe(vista(s).texto || '') || {};
      const ajenas = [...new Set([...Object.keys(actual), ...Object.keys(doc)])].filter((k) => !s.claves.includes(k) && JSON.stringify(actual[k]) !== JSON.stringify(doc[k]));
      if (ajenas.length) return `el archivo propuesto cambia ${ajenas.join(', ')}, que no es de esta sección: revisá de nuevo desde su sección`;
    }
    if (s.id === 'umbrales') { const r = ORG.thresholdsParse(texto, { arnes: { thresholds: arnes().thresholds }, previas: Object.keys(((docDe(vista(s).texto || '') || {}).thresholds) || {}), tree: TREE }); return r.ok ? null : r.problems[0].message; }
    if (s.id === 'paridad') { const l = lector('check-product-parity.js'); const r = l && l.leerDeclaradas(doc, dia()); return !r ? 'esta versión del arnés no sabe leer las diferencias declaradas' : (r.problemas.length ? r.problemas[0].message : null); }
    const lec = lector(s.lector);
    if (!ORG.lectorSabe(lec, s)) return `esta versión del arnés todavía no sabe leer ${s.archivo}`;
    const r = lec.parse(texto);
    if (!r.ok) return `el lector rechaza el archivo: ${(r.problems || []).map((p) => `${p.path || '(el archivo)'}: ${p.message}`).join(' · ')}`;
    if (s.archivo === 'operations.json' && isObject(doc.site) && Array.isArray(doc.site.maintainers) && !doc.site.maintainers.length) return 'la lista de los que mantienen no puede quedar vacía: quedaría sin nadie que pueda entrar a esta pestaña';
    if (s.repo === 'perfil') {
      const capa = leer(clones().perfil.dir, 'team-layer.json');
      const gate = ORG.profileGateProblem(capa.estado === 'leido' ? capa.texto : '');
      if (gate) return gate;
    }
    return null;
  }

  async function proponer(s, body, ctx) {
    const v = vista(s);
    if (['no_reader', 'no_configurado', 'ilegible'].includes(v.estado) || v.soloLectura) return { ok: false, message: v.motivo };
    if (s.id === 'personas' && v.extras && v.extras.vencido) return { ok: false, message: v.extras.vencido };
    const texto = typeof body.texto === 'string' ? body.texto : '';
    // sin la versión que abrió, no se puede saber si otro cambió el archivo (AC 16): no se propone a ciegas
    if (body.oid === undefined) return { ok: false, message: 'falta la versión del archivo que abriste: recargá' };
    const problema = validarTexto(s, texto);
    if (problema) return { ok: false, message: problema };
    const cred = cfg.escritura && cfg.escritura[s.repo];
    if (!cred) return { ok: false, message: 'sin identidad de escritura: descargá el archivo y abrí el pedido a mano' };
    const remote = remoteDe(s.repo);
    if (!remote.platform) return { ok: false, message: 'no reconozco la plataforma del repo: descargá el archivo y abrí el pedido a mano' };
    const dir = s.repo === 'perfil' ? clones().perfil.dir : clones().operaciones.dir;
    return RP.proponer({
      clon: dir, archivo: s.archivo, contenido: texto, oidEsperado: body.oid, idCorto: s.idCorto,
      secciones: [s.titulo], quien: norm(ctx.sesion.email), credencial: cred, remote, urlBase, exclusivo: fuentes.exclusivo || ((fn) => fn()),
      now: new Date(ahora()), fetch, log,
    });
  }

  // ── la propuesta de stages (AC 8): sólo lee, con SITE_PIPELINES_TOKEN; lo de cada plataforma vive en repo-proposal.js ──
  const stages = (pipeline) => RP.stagesPropuestos({ pipeline, remote: remoteDe('operaciones'), token: cfg.pipelinesToken, urlBase, fetch });

  // ── la página ──
  function pagina(ctx) {
    const tok = ctx.sesion && typeof ctx.sesion.tok === 'string' ? ctx.sesion.tok : '';
    const html = views.layout(ctx, 'Configuración', '<div id="config-app"><p class="q-note">Cargando…</p></div>', 'Lo que vale para toda la organización. Cada cambio se revisa antes de proponerlo, y entra cuando alguien lo aprueba. Lo de cada máquina no se toca desde acá.');
    // el token de doble envío y el código de la pestaña, sin nada en línea (la CSP de la 2.23 no lo admite)
    return html.replace('</head>', `<meta name="site-token" content="${tok.replace(/[^A-Za-z0-9_-]/g, '')}"><script src="/static/config.js" defer></script></head>`);
  }

  const solo = ['maintainer'];
  return [
    { method: 'GET', path: '/configuracion', needs: solo, pestana: { id: 'configuracion', titulo: 'Configuración', orden: 90 }, handler: (ctx) => ({ status: 200, tipo: 'text/html; charset=utf-8', cuerpo: pagina(ctx) }) },
    { method: 'GET', path: '/static/config.js', needs: solo, handler: () => ({ status: 200, tipo: 'text/javascript; charset=utf-8', cuerpo: ORG.pantalla() }) },
    { method: 'GET', path: '/api/config', needs: solo, handler: async () => json(200, await leerTodo()) },
    {
      method: 'POST', path: '/api/config/revisar', needs: solo, handler: async (ctx) => {
        const e = await escritura(ctx); if (e.error) return e.error;
        const s = ORG.seccionPorId(e.body && e.body.seccion);
        if (!s) return rechazo(400, 'sección desconocida');
        return json(200, revisarSeccion(s, e.body.borrador, ctx));
      },
    },
    {
      method: 'POST', path: '/api/config/stages', needs: solo, handler: async (ctx) => {
        const e = await escritura(ctx); if (e.error) return e.error;
        return json(200, await stages(e.body && e.body.pipeline));
      },
    },
    {
      method: 'POST', path: '/api/config/proponer', needs: solo, handler: async (ctx) => {
        const e = await escritura(ctx); if (e.error) return e.error;
        const s = ORG.seccionPorId(e.body && e.body.seccion);
        if (!s) return rechazo(400, 'sección desconocida');
        return json(200, await proponer(s, e.body, ctx));
      },
    },
  ];
}

module.exports = { crearRutas };
