'use strict';
/*
 * tabs/findings.js — LA PESTAÑA «MANTENIMIENTO»: LO QUE ENCONTRÓ LA NOCHE Y ESPERA UNA DECISIÓN.
 *
 * Qué resuelve: quien mantiene decide cada ficha de la noche (dependencias, el vigilante y la revisión de las
 * ejecuciones) con un clic, sin abrir el repo de operaciones. El clic no escribe nada en main: abre un pedido con el
 * archivo `inbox/<carpeta>/decisions/<id>.json`, que otra persona aprueba; la noche siguiente lo aplica
 * (scripts/nightly/findings/cycle.js, `aplicarDecisiones`).
 *
 * UNA FILA POR FICHA VIVA, leída del clon de operaciones con la vista común (sources.js `comoFicha`): sin el diagnóstico
 * ni la evidencia del vigilante, y con la razón del modelo pasada otra vez por su filtro. Cada fila dice en llano qué
 * pasó (cuántas veces, en qué máquinas y en qué stories, de los casos de la ficha) y qué haría «Arreglar» según la familia
 * de la causa; la propuesta del modelo va debajo, como sugerencia. Qué hace cada botón se dice una vez, arriba. El menú
 * lleva al lado del nombre cuántas fichas esperan decisión (`cuantasEsperan`). Estados:
 * «pendiente» (con los botones), «propuesto en el pedido N» (UNA consulta de pedidos abiertos para todas las filas,
 * guardada un minuto) y «decidido, se aplica esta noche» (el archivo de decisión ya está en main). Dependencias ofrece
 * sólo «Arreglar»: aceptar el riesgo es declarar la deuda en cada repo, con plazo. Sin clon, sin fichas o con carpetas
 * que no se pueden leer, una frase: nunca una tabla vacía.
 *
 * Rutas (todas `maintainer`: otro rol no ve la pestaña en el menú): GET /mantenimiento · GET /api/hallazgos · POST
 * /api/hallazgos/confirmar · GET /hallazgos/cliente.js. Casos: scripts/tests/site-findings.test.js.
 */
const fs = require('fs');
const path = require('path');
const ORG = require('../../lib/org-config.js');
const RP = require('../../lib/repo-proposal.js');
const SOURCES = require('../../nightly/findings/sources.js');
const CYCLE = require('../../nightly/findings/cycle.js');
const views = require('../views.js');
const TX = require('../texts.js');
const LANG = require('../language.js');
const { defensaDeEscritura } = require('./config.js');

const FUENTES = CYCLE.FUENTES;
// el id de una ficha va a una ruta del clon y a la rama del pedido: sin barras ni nada que salga de su carpeta. Es más
// estricto que la CLAVE de cycle.js a propósito: una ficha con `:` o `/` en el id sale como ilegible y no se confirma
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const ENLACE = /^https:\/\/[^\s"'<>\\]{1,500}$/;
const VIGENCIA_PEDIDOS_MS = 60 * 1000;
const CARPETAS_VIVAS = ['pending', 'promoted'];
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const json = (status, obj) => ({ status, tipo: 'application/json; charset=utf-8', cuerpo: JSON.stringify(obj) });
const norm = (c) => String(c || '').trim().toLowerCase();
// las familias de causa de ejecuciones con un texto fijo de qué haría «Arreglar» (hallazgos.arreglo.<familia>)
const FAMILIAS = { 'RR-ESCAPE': 'escape', 'RR-HOOK': 'hook', 'RR-CIERRE': 'cierre', 'RR-NODE': 'node', 'RR-BANDERA': 'bandera', 'RR-APAGO': 'apago' };
// el nombre de la máquina sin la huella del final (`mac-mini-b274e100` → `mac-mini`)
const HUELLA_DE_MAQUINA = /-[0-9a-f]{8}$/;
const PRODUCTO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
const TOPE_LISTA = 3;

/** Las acciones que se pueden confirmar en una fuente (decisión 14: dependencias, sólo arreglar). */
const accionesDe = (fuente) => Object.keys(CYCLE.VEREDICTO_DE_DECISION[fuente]).sort();
/** El identificador del pedido de una ficha: un segundo clic encuentra el pedido abierto y no abre otro. */
const idCortoDe = (fuente, id) => `decision-${fuente}-${id}`;
const numeroDe = (enlace) => { const m = /\/(?:pull|pullrequest)\/(\d+)$/.exec(String(enlace || '')); return m ? Number(m[1]) : null; };

function crearRutas({ cfg, fuentes, ahora = Date.now, fetch = globalThis.fetch, urlBase = {}, remotos = {}, log = () => {}, demo = false }) {
  const T = (idioma, k, v) => TX.t(idioma, k, v);
  const clones = () => (typeof fuentes.clones === 'function' ? fuentes.clones() : null) || {};
  const dirOps = () => { const o = clones().operaciones; return o && o.dir ? o.dir : null; };
  const remote = () => remotos.operaciones || ORG.remoteOf(cfg.operationsRepo);
  const carpetaDe = (fuente) => SOURCES.FUENTES[fuente].carpeta;
  const rutaDecision = (fuente, id) => path.posix.join('inbox', carpetaDe(fuente), 'decisions', `${id}.json`);

  // ── las fichas ──

  /** `{ estado: 'sin_clon' | 'leido', fichas, ilegibles: [fuente] }`, del clon tal como está. */
  function leerFichas() {
    const dir = dirOps();
    if (!dir) return { estado: 'sin_clon', fichas: [], ilegibles: [] };
    const fichas = [];
    const ilegibles = new Set();
    for (const fuente of FUENTES) {
      const reg = SOURCES.FUENTES[fuente];
      for (const carpeta of CARPETAS_VIVAS) {
        const d = path.join(dir, 'inbox', reg.carpeta, carpeta);
        let nombres;
        try { nombres = fs.readdirSync(d).filter((n) => n.endsWith(reg.extension)).sort(); } catch (e) {
          if (!(e && e.code === 'ENOENT')) ilegibles.add(fuente);
          continue;
        }
        for (const n of nombres) {
          let v;
          let txt;
          try { txt = fs.readFileSync(path.join(d, n), 'utf8'); v = SOURCES.comoFicha(fuente, txt); } catch { ilegibles.add(fuente); continue; }
          // una ficha por ejecución de antes no es de este ciclo; una resuelta ya no se decide
          if (!v || v.estado === 'resuelta') continue;
          if (!(typeof v.id === 'string' && ID.test(v.id))) { ilegibles.add(fuente); continue; }
          fichas.push({ ...v, carpeta, contexto: contextoDe(fuente, reg, txt) });
        }
      }
    }
    return { estado: 'leido', fichas, ilegibles: [...ilegibles] };
  }

  /** Lo que hace falta para decir qué pasó y que la vista común no trae: los casos, los repos, el producto. */
  function contextoDe(fuente, reg, txt) {
    if (fuente === 'ejecuciones') {
      const f = CYCLE.parsear(txt);
      const casos = Array.isArray(f.casos) ? f.casos : [];
      const unicos = (k) => [...new Set(casos.map((c) => c[k]).filter((x) => typeof x === 'string' && x).reverse())];
      return { veces: f.casos_total || f.apariciones || null, maquinas: unicos('maquina').map((m) => m.replace(HUELLA_DE_MAQUINA, '')), stories: unicos('story') };
    }
    if (fuente === 'dependencias') return { repos: reg.formato.listaDe(String(txt), 'repos') };
    const producto = reg.formato.leerFicha(String(txt)).escalares.producto;
    return { producto: PRODUCTO.test(String(producto || '')) ? producto : null };
  }

  /** Las fichas que esperan decisión, para el número del menú: pendientes, en pending/, sin decisión en main ni pedido de la noche. */
  function cuantasEsperan() {
    const l = leerFichas();
    if (l.estado !== 'leido') return 0;
    const dir = dirOps();
    return l.fichas.filter((f) => f.carpeta === 'pending' && f.veredicto === 'pendiente' && !f.pr_noche && !fs.existsSync(path.join(dir, rutaDecision(f.fuente, f.id)))).length;
  }

  // ── los pedidos abiertos: una consulta para todas las filas, guardada un minuto ──
  let pedidosGuardados = null;
  async function pedidos() {
    if (pedidosGuardados && ahora() - pedidosGuardados.t < VIGENCIA_PEDIDOS_MS) return pedidosGuardados.r;
    let r;
    if (demo) r = { pedidos: [] };
    else {
      const rem = remote();
      try { r = rem && rem.platform ? await RP.pedidosAbiertos({ remote: rem, credencial: cfg.escritura && cfg.escritura.operaciones, urlBase, fetch }) : { error: 'sin plataforma' }; } catch (e) { r = { error: (e && e.code) || 'error' }; }
      if (r.error) log(`hallazgos: no se pudo ver si hay pedidos abiertos (${String(r.error).slice(0, 120)})`);
    }
    // una falla no se guarda: la lectura siguiente vuelve a preguntar
    pedidosGuardados = r.error ? null : { t: ahora(), r };
    return r;
  }

  /** El modelo de la sección: lo mismo para la página y para /api/hallazgos. */
  async function modelo(idioma) {
    const l = leerFichas();
    if (l.estado === 'sin_clon') return { estado: 'sin_clon', frase: T(idioma, 'hallazgos.sinClon'), pedidos: null, filas: [] };
    if (!l.fichas.length && !l.ilegibles.length) return { estado: 'sin_fichas', frase: T(idioma, 'hallazgos.sinFichas'), pedidos: null, filas: [] };
    const p = await pedidos();
    const abiertos = p.error ? null : p.pedidos;
    const dir = dirOps();
    const filas = l.fichas.map((f) => {
      const id = idCortoDe(f.fuente, f.id);
      const decidido = fs.existsSync(path.join(dir, rutaDecision(f.fuente, f.id)));
      const pr = abiertos && abiertos.find((x) => RP.esRamaDe(x.rama, id));
      // sólo una ficha de pending/ se confirma (es la que leen confirmar y la noche); una con el pedido de la noche
      // abierto se decide en ese pedido, o quedaría huérfano
      const estado = decidido ? 'decidido' : f.veredicto !== 'pendiente' ? 'decidida' : pr ? 'propuesto'
        : f.carpeta !== 'pending' ? 'movida' : f.pr_noche ? 'pedido_noche' : 'pendiente';
      const acciones = estado === 'pendiente' ? accionesDe(f.fuente) : [];
      const propuesta = f.propuesta ? { accion: f.propuesta.accion, razon: f.propuesta.razon } : null;
      return {
        fuente: f.fuente, id: f.id, nombre: f.nombre, que_paso: quePaso(f, idioma), que_arreglaria: T(idioma, `hallazgos.arreglo.${familiaDe(f)}`), apariciones: f.apariciones, noches: f.noches, primera_vez: f.primera_vez,
        ultima_vez: f.ultima_vez, veredicto: f.veredicto, propuesta, propuesta_motivo: propuesta ? null : f.propuesta_motivo || null,
        pedido: f.pedido, asignado: f.asignado || null, pr_noche: f.pr_noche || null,
        estado_fila: estado, propuesto: pr ? { numero: pr.numero, enlace: ENLACE.test(String(pr.enlace)) ? pr.enlace : null } : null,
        acciones, por_defecto: acciones.length ? (propuesta && acciones.includes(propuesta.accion) ? propuesta.accion : acciones[0]) : null,
      };
    });
    const ilegible = l.ilegibles.length > 0;
    return {
      estado: ilegible ? 'ilegible' : 'leido',
      frase: ilegible ? T(idioma, 'hallazgos.ilegible', { fuentes: l.ilegibles.map((x) => T(idioma, `hallazgos.fuente.${x}`)).join(', ') }) : null,
      pedidos: p.error ? { estado: 'no_se_pudo', frase: T(idioma, 'hallazgos.sinPedidos') } : { estado: 'leido', frase: null },
      filas,
    };
  }

  // ── qué pasó y qué haría «Arreglar» ──

  /** La familia de la causa: la de ejecuciones por su regla; dependencias y el vigilante, la fuente. */
  const familiaDe = (f) => (f.fuente !== 'ejecuciones' ? f.fuente : FAMILIAS[String(f.causa || '').split(':')[0]] || 'desconocida');

  /** «a, b y c» (con «y N más» pasado el tope), en el idioma de la página. */
  function lista(idioma, xs) {
    const vistos = xs.slice(0, TOPE_LISTA);
    const resto = xs.length - vistos.length;
    if (resto > 0) return `${vistos.join(', ')} ${T(idioma, 'hallazgos.paso.yMas', { n: resto })}`;
    return vistos.length > 1 ? `${vistos.slice(0, -1).join(', ')} ${T(idioma, 'hallazgos.paso.y')} ${vistos[vistos.length - 1]}` : vistos.join('');
  }

  /** Una frase en llano de qué pasó, con los datos de la ficha. */
  function quePaso(f, idioma) {
    const c = f.contexto || {};
    const uno = (n, k) => T(idioma, n === 1 ? `${k}Una` : k, { n, lista: '' });
    if (f.fuente === 'ejecuciones') {
      const partes = [c.veces ? uno(c.veces, 'hallazgos.paso.veces') : T(idioma, 'hallazgos.paso.sinCuenta')];
      if (c.maquinas.length) partes.push(T(idioma, c.maquinas.length === 1 ? 'hallazgos.paso.maquina' : 'hallazgos.paso.maquinas', { lista: lista(idioma, c.maquinas) }));
      if (c.stories.length) partes.push(T(idioma, c.stories.length === 1 ? 'hallazgos.paso.story' : 'hallazgos.paso.stories', { lista: lista(idioma, c.stories) }));
      const ultima = f.ultima_vez || f.primera_vez;
      return `${partes.join(', ')}.${ultima ? ` ${T(idioma, 'hallazgos.paso.ultima', { dia: ultima })}` : ''}`;
    }
    if (f.fuente === 'dependencias') {
      const partes = [T(idioma, 'hallazgos.paso.paquete', { nombre: f.nombre })];
      if (f.noches) partes.push(uno(f.noches, 'hallazgos.paso.nochesSeguidas'));
      if (c.repos.length) partes.push(T(idioma, 'hallazgos.paso.repos', { lista: lista(idioma, c.repos) }));
      return `${partes.join(', ')}.`;
    }
    const partes = [T(idioma, c.producto ? 'hallazgos.paso.produccionDe' : 'hallazgos.paso.produccion', { producto: c.producto, nombre: f.nombre })];
    if (f.apariciones) partes.push(uno(f.apariciones, 'hallazgos.paso.nochesSeguidas'));
    return `${partes.join(', ')}.`;
  }

  // ── la página ──

  function filaHtml(f, idioma) {
    const enlace = (texto, url) => (url && ENLACE.test(url) ? `<a href="${esc(url)}" rel="noopener noreferrer">${esc(texto)}</a>` : esc(texto));
    const sinPropuesta = f.propuesta_motivo ? T(idioma, `hallazgos.motivo.${f.propuesta_motivo}`) : T(idioma, 'hallazgos.sinPropuesta');
    // la razón del modelo está en castellano (se le pide así): lo dice la etiqueta, y `lang` para quien la lee en voz alta
    const sugerencia = f.propuesta ? `${esc(T(idioma, 'hallazgos.sugerencia', { accion: T(idioma, `hallazgos.accion.${f.propuesta.accion}`) }))} <span lang="es">${esc(f.propuesta.razon)}</span>` : esc(sinPropuesta);
    const arreglo = `${esc(f.que_arreglaria)}<div class="q-note">${sugerencia}</div>`;
    const asignado = f.asignado ? `<div class="q-note">${esc(T(idioma, 'hallazgos.asignado', { quien: f.asignado }))}</div>` : '';
    const pedido = `${f.pedido ? enlace(f.pedido.id || T(idioma, 'hallazgos.col.pedido'), f.pedido.enlace) : '—'}${asignado}`;
    const estado = f.estado_fila === 'propuesto' ? enlace(T(idioma, 'hallazgos.estado.propuesto', { numero: f.propuesto.numero }), f.propuesto.enlace)
      : f.estado_fila === 'pedido_noche' ? esc(T(idioma, 'hallazgos.estado.pedido_noche', { numero: f.pr_noche }))
      : f.estado_fila === 'decidida' ? esc(T(idioma, 'hallazgos.estado.decidida', { veredicto: T(idioma, `hallazgos.veredicto.${f.veredicto === 'arreglo' ? 'arreglo' : 'aceptada'}`) }))
        : esc(T(idioma, `hallazgos.estado.${f.estado_fila}`));
    const botones = f.acciones.map((a) => `<button type="button" class="btn${a === f.por_defecto ? ' primario' : ''}" data-accion="${esc(a)}" data-fuente="${esc(f.fuente)}" data-id="${esc(f.id)}">${esc(T(idioma, `hallazgos.accion.${a}`))}</button>`).join(' ');
    return `<tr data-ficha="${esc(`${f.fuente}/${f.id}`)}"><td>${esc(T(idioma, `hallazgos.fuente.${f.fuente}`))}</td><td><b>${esc(f.nombre)}</b><div>${esc(f.que_paso)}</div></td>`
      + `<td>${arreglo}</td><td>${pedido}</td><td class="h-estado" aria-live="polite">${estado}</td><td>${botones}</td></tr>`;
  }

  async function seccion(ctx) {
    if (!ctx || !ctx.quien || ctx.quien.rol !== 'maintainer') return '';
    const idioma = views.idiomaDe(ctx);
    const m = await modelo(idioma);
    const tok = ctx.sesion && typeof ctx.sesion.tok === 'string' ? ctx.sesion.tok.replace(/[^A-Za-z0-9_-]/g, '') : '';
    const frases = [m.frase, m.pedidos && m.pedidos.frase].filter(Boolean).map((t) => `<p class="q-note">${esc(t)}</p>`).join('');
    const cols = ['fuente', 'quePaso', 'arreglo', 'pedido', 'estado', 'decidir'].map((c) => `<th>${esc(T(idioma, `hallazgos.col.${c}`))}</th>`).join('');
    const tabla = m.filas.length ? `<div class="tabla-scroll"><table class="tabla"><thead><tr>${cols}</tr></thead><tbody>${m.filas.map((f) => filaHtml(f, idioma)).join('')}</tbody></table></div>` : '';
    const textos = ['abriendo', 'abierto', 'noSePudo', 'demo'].map((k) => ` data-t-${k.toLowerCase()}="${esc(T(idioma, `hallazgos.${k}`))}"`).join('');
    // qué hace cada botón, una vez arriba: no en cada fila
    const conDependencias = m.filas.some((f) => f.fuente === 'dependencias' && f.acciones.length);
    const botones = m.filas.length ? `<ul class="lista">${['aceptar', 'arreglar'].map((a) => `<li>${esc(T(idioma, `hallazgos.botones.${a}`))}</li>`).join('')}${conDependencias ? `<li>${esc(T(idioma, 'hallazgos.deuda'))}</li>` : ''}</ul>` : '';
    return `<section id="hallazgos" class="hallazgos" data-token="${esc(tok)}"${textos}>${frases}${botones}${tabla}<script src="/hallazgos/cliente.js" defer></script></section>`;
  }

  // ── confirmar ──

  async function confirmar(body, ctx, idioma) {
    if (!isObject(body) || !FUENTES.includes(body.fuente) || typeof body.id !== 'string' || !ID.test(body.id) || !CYCLE.ACCIONES.includes(body.accion)) {
      return json(400, { ok: false, message: T(idioma, 'hallazgos.pedidoInvalido') });
    }
    const { fuente, id, accion } = body;
    if (!accionesDe(fuente).includes(accion)) return json(400, { ok: false, message: T(idioma, 'hallazgos.soloArreglar') });
    const dir = dirOps();
    if (!dir) return json(200, { ok: false, codigo: 'sin_clon', message: T(idioma, 'hallazgos.sinClon') });
    // la ficha, otra vez del clon: sólo una pendiente se confirma
    const reg = SOURCES.FUENTES[fuente];
    // 🔴 Sólo «el archivo no está» es «ya no está pendiente»: una ficha o una carpeta que no se pueden leer no abren
    // un pedido a ciegas ni le dicen a la persona que otro ya la decidió.
    const fichaIlegible = json(200, { ok: false, codigo: 'ficha_ilegible', message: T(idioma, 'hallazgos.fichaIlegible') });
    let f = null;
    try { f = SOURCES.comoFicha(fuente, fs.readFileSync(path.join(dir, 'inbox', reg.carpeta, 'pending', `${id}${reg.extension}`), 'utf8')); } catch (e) {
      if (!(e && e.code === 'ENOENT')) return fichaIlegible;
    }
    if (!f || f.id !== id || f.veredicto !== 'pendiente' || f.estado === 'resuelta') return json(200, { ok: false, codigo: 'no_pendiente', message: T(idioma, 'hallazgos.noPendiente') });
    if (f.pr_noche) return json(200, { ok: false, codigo: 'pedido_de_la_noche', message: T(idioma, 'hallazgos.pedidoDeLaNoche', { numero: f.pr_noche }) });
    const archivo = rutaDecision(fuente, id);
    try {
      fs.statSync(path.join(dir, archivo));
      return json(200, { ok: false, codigo: 'ya_decidido', message: T(idioma, 'hallazgos.yaDecidido') });
    } catch (e) {
      if (!(e && e.code === 'ENOENT')) return json(200, { ok: false, codigo: 'decision_ilegible', message: T(idioma, 'hallazgos.decisionIlegible') });
    }
    const quien = norm((ctx.sesion && ctx.sesion.email) || (ctx.quien && ctx.quien.email));
    const decision = { fuente, id, accion, quien, el: new Date(ahora()).toISOString().slice(0, 10) };
    const contenido = `${JSON.stringify(decision, null, 2)}\n`;
    if (demo) return json(200, { ok: true, codigo: 'demo', demo: true, loQuePasaria: { repo: 'operaciones', archivo, contenido } });
    // la noche sólo aplica una decisión con forma: una que no la tiene (sin correo, por ejemplo) no se propone
    if (!CYCLE.decisionConForma(decision, fuente, id)) return json(200, { ok: false, codigo: 'sin_identidad', message: T(idioma, 'hallazgos.sinIdentidad') });
    let clon = dir;
    if (clones().operaciones.indice) {
      if (typeof fuentes.clonDeEscritura !== 'function') return json(200, { ok: false, message: TX.t('es', 'config.sinClonEscritura') });
      const e = await fuentes.clonDeEscritura();
      if (!e || !e.dir) return json(200, { ok: false, message: TX.t('es', 'config.clonFallo', { motivo: (e && e.motivo) || TX.t('es', 'config.noSeArmoClon') }) });
      clon = e.dir;
    }
    const c = fuentes.config();
    const r = await RP.proponer({
      clon, archivo, contenido, oidEsperado: null, idCorto: idCortoDe(fuente, id), secciones: [TX.t('es', 'hallazgos.titulo')],
      titulo: `Decisión sobre lo que encontró la noche: ${f.nombre}`, quien, credencial: cfg.escritura && cfg.escritura.operaciones,
      remote: remote(), urlBase, exclusivo: fuentes.exclusivo || ((fn) => fn()), now: new Date(ahora()), fetch, log,
      aplicarSolo: Boolean(c && isObject(c.site) && c.site.auto_apply === true),
    });
    // el próximo pedido de la sección vuelve a mirar los pedidos abiertos
    pedidosGuardados = null;
    const { textoActual: _t, oidActual: _o, ...resto } = r || {};
    const numero = numeroDe(resto.enlace);
    return json(200, { ...resto, ...(numero ? { numero } : {}) });
  }

  /** Los mensajes de la casa, en el idioma del pedido (como la Configuración). */
  const enIdioma = (r, idioma) => {
    if (idioma === LANG.POR_DEFECTO) return r;
    try { return { ...r, cuerpo: JSON.stringify(TX.traducirRespuesta(idioma, JSON.parse(r.cuerpo))) }; } catch { return r; }
  };

  const solo = ['maintainer'];
  const rutas = [
    {
      method: 'GET', path: '/mantenimiento', needs: solo, pestana: { id: 'mantenimiento', titulo: 'Mantenimiento', orden: 25, cuenta: cuantasEsperan }, handler: async (ctx) => {
        const idioma = views.idiomaDe(ctx);
        return { status: 200, tipo: 'text/html; charset=utf-8', cuerpo: views.layout(ctx, T(idioma, 'pestana.mantenimiento'), await seccion(ctx), T(idioma, 'hallazgos.lede')) };
      },
    },
    { method: 'GET', path: '/api/hallazgos', needs: solo, handler: async (ctx) => json(200, await modelo(views.idiomaDe(ctx))) },
    {
      method: 'POST', path: '/api/hallazgos/confirmar', needs: solo, handler: async (ctx) => {
        const e = await defensaDeEscritura(cfg, ctx);
        if (e.error) return e.error;
        const idioma = views.idiomaDe(ctx);
        return enIdioma(await confirmar(e.body, ctx, idioma), idioma);
      },
    },
    { method: 'GET', path: '/hallazgos/cliente.js', needs: solo, handler: () => ({ status: 200, tipo: 'text/javascript; charset=utf-8', cuerpo: CLIENTE }) },
  ];
  return rutas;
}

// El cliente: un clic manda la decisión y la fila dice qué pasó. Sin el clic no se escribe nada.
const CLIENTE = `(function () {
  var s = document.getElementById('hallazgos');
  if (!s) return;
  s.addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-accion]');
    if (!b) return;
    var fila = b.closest('tr');
    var estado = fila && fila.querySelector('.h-estado');
    var botones = fila ? fila.querySelectorAll('button[data-accion]') : [b];
    for (var i = 0; i < botones.length; i++) botones[i].disabled = true;
    if (estado) estado.textContent = s.getAttribute('data-t-abriendo');
    fetch('/api/hallazgos/confirmar', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-site-token': s.getAttribute('data-token') || '' },
      body: JSON.stringify({ fuente: b.getAttribute('data-fuente'), id: b.getAttribute('data-id'), accion: b.getAttribute('data-accion') }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, message: String(r.status) }; }); })
      .then(function (j) {
        if (!estado) return;
        estado.textContent = '';
        if (j && j.ok && j.enlace && /^https:\\/\\//.test(j.enlace)) {
          estado.appendChild(document.createTextNode(s.getAttribute('data-t-abierto') + ' '));
          var a = document.createElement('a'); a.href = j.enlace; a.rel = 'noopener noreferrer'; a.textContent = j.numero ? '#' + j.numero : j.enlace;
          estado.appendChild(a);
          return;
        }
        if (j && j.ok && j.demo && j.loQuePasaria) {
          estado.appendChild(document.createTextNode(s.getAttribute('data-t-demo') + ' '));
          var c = document.createElement('code'); c.textContent = String(j.loQuePasaria.archivo || '');
          var pre = document.createElement('pre'); pre.textContent = String(j.loQuePasaria.contenido || '');
          estado.appendChild(c); estado.appendChild(pre);
          return;
        }
        if (j && j.ok) { estado.textContent = j.message || s.getAttribute('data-t-abierto'); return; }
        estado.textContent = s.getAttribute('data-t-nosepudo') + ' ' + ((j && j.message) || '');
        if (j && j.codigo !== 'pedido_abierto' && j.codigo !== 'ya_decidido' && j.codigo !== 'no_pendiente' && j.codigo !== 'pedido_de_la_noche') for (var k = 0; k < botones.length; k++) botones[k].disabled = false;
      })
      .catch(function () { if (estado) estado.textContent = s.getAttribute('data-t-nosepudo'); for (var k = 0; k < botones.length; k++) botones[k].disabled = false; });
  });
})();
`;

module.exports = { crearRutas, CLIENTE, CARPETAS_VIVAS };
