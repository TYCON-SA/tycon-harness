'use strict';
/*
 * tabs/findings.js — LA PESTAÑA «MANTENIMIENTO»: LO QUE ENCONTRÓ LA NOCHE, POR QUIÉN TIENE LA PELOTA.
 *
 * Qué resuelve: quien mantiene decide las fichas de la noche sin abrir el repo de operaciones. La pantalla tiene cuatro
 * bloques. «Te toca decidir»: las fichas del vigilante y de la revisión de las ejecuciones que esperan Archivar o
 * Arreglar, y las de dependencias que esperan Aceptar o Rechazar su pull request (rechazar pide un motivo de una línea,
 * que la noche deja como comentario del pull request). «Esperando aprobación»: lo que ya se envió y otra persona tiene que aprobar, agrupado por pedido. «Ya
 * decididas»: lo decidido en los últimos 30 días, con quién, cuándo y si la noche ya lo aplicó. «En
 * marcha»: los arreglos con su tarea y las vulnerabilidades de paquetes, que cada equipo sigue en su tarea. Lo que la revisión declara «aparte» (cause-names.js `APARTE`) no se pregunta.
 *
 * Cada tarjeta dice qué pasó con los datos de la ficha, sin modelo, y el análisis si lo hay (el de la noche o el de
 * una persona), con lo que recomienda. Las elecciones se marcan en el navegador; «Enviar para aprobar» abre UN pedido
 * con un archivo `inbox/<carpeta>/decisions/<id>.json` por ficha, que la noche aplica cuando está en main
 * (scripts/nightly/findings/cycle.js, `aplicarDecisiones`; en dependencias con pull request, open-pr-per-finding.sh, que
 * lo mergea o lo cierra). El pull request de cada decisión de dependencias sale de la ficha, nunca del navegador. Si la
 * noche no pudo aplicar una, la ficha lo anota (`decision_fallida:`) y la fila vuelve a «Te toca decidir» con el porqué.
 * Nada se escribe en main desde acá.
 *
 * Qué espera aprobación sale de los pedidos abiertos de decisiones (sus archivos y la acción de su cuerpo): una
 * consulta para toda la pantalla, guardada un minuto. Si la plataforma no contesta, lo dice una frase y las filas
 * quedan para decidir: el pedido se nombra por su contenido, y reenviarlo no abre otro. El menú lleva al lado del
 * nombre cuántas fichas esperan decisión (`cuantasEsperan`). Sin clon, sin fichas o con carpetas que no se pueden leer,
 * una frase.
 *
 * Rutas (todas `maintainer`: otro rol no ve la pestaña en el menú): GET /mantenimiento · GET /api/hallazgos · POST
 * /api/hallazgos/confirmar · GET /hallazgos/cliente.js. Casos: scripts/tests/site-findings.test.js.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ORG = require('../../lib/org-config.js');
const RP = require('../../lib/repo-proposal.js');
const OPS = require('../../lib/operations-config.js');
const SOURCES = require('../../nightly/findings/sources.js');
const CYCLE = require('../../nightly/findings/cycle.js');
const { APARTE } = require('../../nightly/findings/cause-names.js');
const views = require('../views.js');
const TX = require('../texts.js');
const LANG = require('../language.js');
const { defensaDeEscritura } = require('./config.js');

const FUENTES = CYCLE.FUENTES;
// las que se deciden acá, en el orden de la pantalla: producción primero, porque son clientes reales
const SE_DECIDEN = ['vigilante', 'ejecuciones', 'dependencias'];
// las acciones de cada una, las que aplica la noche: en dependencias se decide su pull request (aceptar lo mergea,
// rechazar lo cierra con el motivo)
const ACCIONES_DE = Object.fromEntries(SE_DECIDEN.map((f) => [f, Object.keys(CYCLE.VEREDICTO_DE_DECISION[f])]));
const ACCIONES = [...new Set(Object.values(ACCIONES_DE).flat())];
const NUMERO_DE_PR = /^[0-9]{1,9}$/;
const REPO_DE_PR = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// los motivos sin tarea que la noche vuelve a calcular cada vez que pide
const RECALCULADOS = ['sin-confirmar', 'sin-configurar'];
// el id de una ficha va a una ruta del clon y a la rama del pedido: sin barras ni nada que salga de su carpeta. Es más
// estricto que la CLAVE de cycle.js a propósito: una ficha con `:` o `/` en el id sale como ilegible y no se envía
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const ENLACE = /^https:\/\/[^\s"'<>\\]{1,500}$/;
const VIGENCIA_PEDIDOS_MS = 60 * 1000;
const CARPETAS_VIVAS = ['pending', 'promoted'];
const TOPE_ENVIO = 100;
// lo ya decidido, en el disco del sitio: tapa la foto vieja una semana como mucho, y se muestra 30 días
const ARCHIVO_DECIDIDAS = 'mantenimiento-decididas.json';
const VIGENCIA_DECIDIDA_MS = 7 * 24 * 3600 * 1000;
const VIGENCIA_HISTORIA_MS = 30 * 24 * 3600 * 1000;
const DIA = /^\d{4}-\d{2}-\d{2}$/;
// cómo terminó cada envío, por su número: lo pregunta la pantalla cuando la conexión se corta
const ENVIO = /^[A-Za-z0-9_-]{8,64}$/;
const VIGENCIA_ENVIO_MS = 15 * 60 * 1000;
// las ramas de los pedidos de decisiones: las de a una (`decision-…`) y las de varias (`decisiones-…`)
const RAMA_DE_DECISIONES = 'team-config/decision';
// lo que el cuerpo del pedido dice de cada ficha: «fuente/id → acción»
const LINEA_DE_DECISION = /(vigilante|ejecuciones|dependencias)\/([A-Za-z0-9][A-Za-z0-9._-]{0,119}) → (aceptar|arreglar|reject)/g;
const SEVERIDADES = { critical: 0, high: 1, moderate: 2, medium: 2, low: 3 };
const NOMBRE_SEVERIDAD = { critical: 'critica', high: 'alta', moderate: 'media', medium: 'media', low: 'baja' };
const PAQUETE = /^[@A-Za-z0-9][@A-Za-z0-9._/-]{0,213}$/;
// el nombre de la máquina sin la huella del final (`mac-mini-b274e100` → `mac-mini`)
const HUELLA_DE_MAQUINA = /-[0-9a-f]{8}$/;
const PRODUCTO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
const AYUDAS = ['aceptar', 'arreglar', 'enviar', 'tarea', 'deuda', 'analisis', 'seguir'];
// las reglas del vigilante que tienen su frase y su «?»; la que la noche no conoce va como `otra`
/** Por qué la ficha no tiene análisis: dejó de pedirse, el motivo de la noche, o que la noche todavía no le llegó. */
const motivoSinAnalisis = (f) => (f.analisis_agotado ? 'agotado' : f.analisis_motivo || (f.fuente === 'vigilante' ? 'sinIntentoProduccion' : 'sinIntento'));
const REGLAS = ['deriva', 'goteo', 'desagregacion', 'latido', 'otra'];
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const json = (status, obj) => ({ status, tipo: 'application/json; charset=utf-8', cuerpo: JSON.stringify(obj) });
const norm = (c) => String(c || '').trim().toLowerCase();
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
/** Una fecha `AAAA-MM-DD` como `DD/MM`. */
const dia = (f) => (typeof f === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f) ? `${f.slice(8, 10)}/${f.slice(5, 7)}` : '');
const clave = (f) => `${f.fuente}/${f.id}`;
const numeroDe = (enlace) => { const m = /\/(?:pull|pullrequest)\/(\d+)$/.exec(String(enlace || '')); return m ? Number(m[1]) : null; };
const aparte = (f) => typeof f.causa === 'string' && hasOwn(APARTE, f.causa);
// quién decidió, sin su correo: lo de antes de la arroba
const alias = (q) => { const m = /^([a-z0-9][a-z0-9._+-]{0,63})@/.exec(norm(q)); return m ? m[1] : null; };

/**
 * Las fichas ya decididas, con qué se decidió, quién y cuándo. Dos usos: (1) las que el sitio decidió (aplicó él mismo,
 * o encontró decididas en main al enviar) mientras su foto de operaciones no las trae: sin esto vuelven a «Te toca
 * decidir» hasta el próximo refresco, y reenviarlas choca con su propia decisión. Eso vale hasta que la foto trae la
 * decisión (`olvidar`) o una semana. (2) «Ya decididas»: la noche borra el archivo de la decisión al aplicarla y la
 * ficha no guarda quién decidió, así que quién y cuándo quedan acá, 30 días. Se guardan en el disco del sitio
 * (sobreviven a un reinicio). Sin disco, en memoria. Un archivo roto o un disco caído no tiran la pestaña: se empieza
 * vacío.
 */
function crearDecididas({ dataDir = null, ahora = Date.now, log = () => {} } = {}) {
  const archivo = dataDir ? path.join(dataDir, ARCHIVO_DECIDIDAS) : null;
  let memoria = {};
  if (archivo) {
    try { const d = JSON.parse(fs.readFileSync(archivo, 'utf8')); if (isObject(d)) memoria = d; } catch (e) {
      if (!(e && e.code === 'ENOENT')) log(`mantenimiento: la lista de lo ya decidido no se pudo leer (${e.code || 'sin forma'}): se empieza vacía`);
    }
  }
  // el día de la decisión: el que anotó, o el de cuando se anotó
  const diaDe = (x) => (DIA.test(String(x.el || '')) ? x.el : new Date(x.en).toISOString().slice(0, 10));
  const enHistoria = (x) => isObject(x) && (x.accion === null || ACCIONES.includes(x.accion)) && Number.isFinite(x.en) && ahora() - x.en < VIGENCIA_HISTORIA_MS;
  const vigente = (x) => enHistoria(x) && x.accion !== null && !x.visto && ahora() - x.en < VIGENCIA_DECIDIDA_MS;
  // quién y cuándo, si tienen forma: lo demás no se guarda
  const datos = (x) => ({ ...(typeof x.quien === 'string' && x.quien ? { quien: norm(x.quien) } : {}), ...(DIA.test(String(x.el || '')) ? { el: x.el } : {}),
    ...(typeof x.nombre === 'string' && x.nombre ? { nombre: x.nombre.slice(0, 300) } : {}), ...(DIA.test(String(x.vio || '')) ? { vio: x.vio } : {}) });
  // la noche anotó que no pudo aplicar ESTA decisión: una falla del día de la decisión o posterior, que no es la que la
  // persona tenía a la vista al decidir (`vio`; decidir otra vez después de leer la falla vale aunque sea el mismo día)
  const superada = (x, fallida) => Boolean(fallida) && fallida !== x.vio && !(fallida < diaDe(x));
  function guardar() {
    for (const k of Object.keys(memoria)) if (!enHistoria(memoria[k])) delete memoria[k];
    if (!archivo) return;
    const tmp = `${archivo}.${process.pid}.tmp`;
    try { fs.writeFileSync(tmp, `${JSON.stringify(memoria)}\n`); fs.renameSync(tmp, archivo); } catch (e) {
      log(`mantenimiento: la lista de lo ya decidido no se pudo guardar (${(e && e.code) || 'error'}): vale hasta el próximo reinicio`);
    }
  }
  return {
    /** `[{ clave, accion, quien?, el?, nombre?, vio? }]`: decididas recién (`vio`: la falla que tenía la ficha al decidir). */
    marcar(lista) { for (const x of lista) memoria[x.clave] = { accion: x.accion, en: ahora(), ...datos(x) }; guardar(); },
    /**
     * La acción decidida, mientras la foto no la trae; o null. `fallida`: el día en que la noche anotó en la ficha que no
     * pudo aplicar una decisión; si anotó que no pudo aplicar ésta, ya no vale y la fila vuelve.
     */
    accionDe(k, fallida = null) {
      if (!hasOwn(memoria, k) || !vigente(memoria[k])) return null;
      return superada(memoria[k], fallida) ? null : memoria[k].accion;
    },
    /** ¿La noche anotó que no pudo aplicar esta decisión? (`fallida`: el día de la anotación en la ficha) */
    noAplicada(x, fallida) { return superada(x, fallida); },
    /**
     * La foto ya trae la decisión (`{ accion, quien?, el?, nombre? }`, lo que dice main): ya no hace falta taparla, y
     * queda en «Ya decididas» con lo que falte. Una decisión que el sitio no vio enviar entra recién acá.
     */
    olvidar(k, d = {}) {
      const x = hasOwn(memoria, k) && enHistoria(memoria[k]) ? memoria[k] : null;
      const nuevo = { accion: ACCIONES.includes(d.accion) ? d.accion : x ? x.accion : null, en: x ? x.en : ahora(), ...datos(d), ...(x ? datos(x) : {}), visto: true };
      if (x && JSON.stringify(x) === JSON.stringify(nuevo)) return;
      memoria[k] = nuevo;
      guardar();
    },
    /** «Ya decididas»: `[{ clave, accion, en, quien?, el?, nombre? }]`, de los últimos 30 días, lo último primero. */
    historia() {
      return Object.keys(memoria).filter((k) => enHistoria(memoria[k])).map((k) => ({ clave: k, ...memoria[k] })).sort((a, b) => b.en - a.en || a.clave.localeCompare(b.clave));
    },
  };
}

function crearRutas({ cfg, fuentes, ahora = Date.now, fetch = globalThis.fetch, urlBase = {}, remotos = {}, log = () => {}, demo = false }) {
  const T = (idioma, k, v) => TX.t(idioma, k, v);
  const clones = () => (typeof fuentes.clones === 'function' ? fuentes.clones() : null) || {};
  const dirOps = () => { const o = clones().operaciones; return o && o.dir ? o.dir : null; };
  const remote = () => remotos.operaciones || ORG.remoteOf(cfg.operationsRepo);
  const carpetaDe = (fuente) => SOURCES.FUENTES[fuente].carpeta;
  const rutaDecision = (fuente, id) => path.posix.join('inbox', carpetaDe(fuente), 'decisions', `${id}.json`);
  const decididas = crearDecididas({ dataDir: cfg.dataDir, ahora, log });
  const envios = new Map();

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
          // una ficha por ejecución de antes no es de este ciclo; una resuelta ya no se sigue
          if (!v || v.estado === 'resuelta') continue;
          if (!(typeof v.id === 'string' && ID.test(v.id))) { ilegibles.add(fuente); continue; }
          fichas.push({ ...v, carpeta, contexto: contextoDe(fuente, reg, txt) });
        }
      }
    }
    return { estado: 'leido', fichas, ilegibles: [...ilegibles] };
  }

  /** Lo que hace falta para decir qué pasó y que la vista común no trae: los casos de ejecuciones, el paquete. */
  function contextoDe(fuente, reg, txt) {
    if (fuente === 'ejecuciones') {
      const f = CYCLE.parsear(txt);
      const casos = Array.isArray(f.casos) ? f.casos : [];
      const unicos = (k) => [...new Set(casos.map((c) => c[k]).filter((x) => typeof x === 'string' && x).reverse())];
      const dias = casos.map((c) => c.dia).filter((x) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)).sort();
      return { veces: f.casos_total || f.apariciones || null, maquinas: unicos('maquina').map((m) => m.replace(HUELLA_DE_MAQUINA, '')),
        stories: unicos('story'), desde: dias[0] || null, hasta: dias[dias.length - 1] || null };
    }
    if (fuente === 'dependencias') {
      const e = reg.formato.leerFicha(String(txt)).escalares;
      // el pull request de la ficha, tal como lo compara la noche (`mismoPedido`): el número y, en GitHub, su repo
      const pr = NUMERO_DE_PR.test(String(e.pr || '')) ? String(e.pr) : null;
      const prRepo = pr && REPO_DE_PR.test(String(e.pr_repo || '')) ? String(e.pr_repo) : null;
      return { paquete: PAQUETE.test(String(e.paquete || '')) ? e.paquete : null, pr, pr_repo: prRepo, rechazado: Boolean(e.rechazado),
        // la decisión del sitio que la noche no pudo aplicar: el día y por qué (lo escribe la noche, sin saltos de línea)
        fallida: DIA.test(String(e.decision_fallida || '')) ? e.decision_fallida : null,
        motivo_fallida: typeof e.motivo_decision_fallida === 'string' && e.motivo_decision_fallida.trim() ? e.motivo_decision_fallida.trim().slice(0, CYCLE.MOTIVO_MAX) : null };
    }
    return {};
  }

  /** La decisión de una ficha que ya está en main: `{ accion, quien, el }`, null si no hay, o 'ilegible'. */
  function decisionEnMain(dir, f) {
    let txt;
    try { txt = fs.readFileSync(path.join(dir, rutaDecision(f.fuente, f.id)), 'utf8'); } catch (e) {
      return e && e.code === 'ENOENT' ? null : 'ilegible';
    }
    let d = null;
    try { d = JSON.parse(txt); } catch { /* sin forma: igual está decidida, sin acción que mostrar */ }
    if (!isObject(d)) return { accion: null, quien: null, el: null };
    return { accion: ACCIONES.includes(d.accion) ? d.accion : null, quien: typeof d.quien === 'string' ? d.quien : null, el: DIA.test(String(d.el || '')) ? d.el : null };
  }

  /**
   * ¿Espera que alguien decida? Las pendientes en pending/ que no cuentan aparte; en dependencias, las que nadie rechazó
   * todavía (una rechazada sigue en pending/ con su rechazo anotado).
   */
  const porDecidir = (f) => SE_DECIDEN.includes(f.fuente) && f.carpeta === 'pending' && f.veredicto === 'pendiente' && !aparte(f)
    && !(f.fuente === 'dependencias' && f.contexto && f.contexto.rechazado);
  const fallidaDe = (f) => (f.contexto && f.contexto.fallida) || null;

  // ── lo que espera aprobación: los pedidos de decisiones abiertos, una consulta para toda la pantalla ──
  let membresiaGuardada = null;
  let ultimaMembresia = null;
  let membresiaEnCamino = null;
  let membresiaIntentada = -Infinity;

  /** La ficha de una ruta de un pedido (`inbox/<carpeta>/decisions/<id>.json`), o null. */
  function claveDeRuta(ruta) {
    for (const fuente of SE_DECIDEN) {
      const prefijo = `inbox/${carpetaDe(fuente)}/decisions/`;
      if (!ruta.startsWith(prefijo) || !ruta.endsWith('.json')) continue;
      const id = ruta.slice(prefijo.length, -'.json'.length);
      if (ID.test(id)) return `${fuente}/${id}`;
    }
    return null;
  }

  async function leerMembresia() {
    const rem = remote();
    if (!rem || !rem.platform) return { estado: 'no_se_pudo', error: 'sin plataforma' };
    const credencial = cfg.escritura && cfg.escritura.operaciones;
    const p = await RP.pedidosAbiertos({ remote: rem, credencial, urlBase, fetch });
    if (p.error) return { estado: 'no_se_pudo', error: p.error };
    const porFicha = new Map();
    const deDecisiones = p.pedidos.filter((x) => String(x.rama).startsWith(RAMA_DE_DECISIONES) && Number.isInteger(x.numero)).sort((a, b) => a.numero - b.numero);
    for (const x of deDecisiones) {
      const a = await RP.archivosDelPedido({ remote: rem, credencial, numero: x.numero, urlBase, fetch });
      if (a.error) return { estado: 'no_se_pudo', error: a.error };
      const acciones = new Map([...a.cuerpo.matchAll(LINEA_DE_DECISION)].map((m) => [`${m[1]}/${m[2]}`, m[3]]));
      for (const ruta of a.archivos) {
        const k = claveDeRuta(ruta);
        if (k && !porFicha.has(k)) porFicha.set(k, { numero: x.numero, enlace: ENLACE.test(String(x.enlace)) ? x.enlace : null, accion: acciones.get(k) || null });
      }
    }
    return { estado: 'leido', porFicha };
  }

  /** `{ estado: 'leido', porFicha: Map(fuente/id → { numero, enlace, accion }) }` o `{ estado: 'no_se_pudo' }`. */
  async function membresia() {
    if (membresiaGuardada && ahora() - membresiaGuardada.t < VIGENCIA_PEDIDOS_MS) return membresiaGuardada.r;
    let r;
    if (demo) r = { estado: 'leido', porFicha: new Map() };
    else {
      try { r = await leerMembresia(); } catch (e) { r = { estado: 'no_se_pudo', error: (e && e.code) || 'error' }; }
      if (r.estado !== 'leido') log(`hallazgos: no se pudo ver qué espera aprobación (${String(r.error).slice(0, 120)})`);
    }
    // una falla no se guarda: la lectura siguiente vuelve a preguntar
    membresiaGuardada = r.estado === 'leido' ? { t: ahora(), r } : null;
    if (r.estado === 'leido') ultimaMembresia = r;
    return r;
  }

  /**
   * Las fichas que esperan decisión, para el número del menú y, con `fuente`, para el de Inicio: sin preguntar a la
   * plataforma, con lo último que contestó. Sin fichas legibles, null: el menú muestra sólo el nombre e Inicio, «no medido».
   */
  function cuantasEsperan(fuente = null) {
    const l = leerFichas();
    if (l.estado !== 'leido') return null;
    const dir = dirOps();
    // recién arrancado no se sabe todavía qué espera aprobación: se pregunta de fondo y la próxima cuenta ya lo descuenta;
    // si la plataforma no contesta, se vuelve a preguntar al minuto, no en cada página que se abre
    if (!ultimaMembresia && !membresiaEnCamino && ahora() - membresiaIntentada >= VIGENCIA_PEDIDOS_MS) {
      membresiaIntentada = ahora();
      membresiaEnCamino = membresia().catch(() => null).finally(() => { membresiaEnCamino = null; });
    }
    const enPedido = ultimaMembresia ? ultimaMembresia.porFicha : new Map();
    return l.fichas.filter((f) => (fuente === null || f.fuente === fuente) && porDecidir(f) && decisionEnMain(dir, f) === null && !decididas.accionDe(clave(f), fallidaDe(f)) && !enPedido.has(clave(f))).length;
  }

  // ── la tarea de cada arreglo y de cada vulnerabilidad ──

  /** Dónde viven las tareas: la organización y el proyecto de operations.json, o los del repo de operaciones. */
  function destinoDeTareas() {
    const c = (typeof fuentes.config === 'function' && fuentes.config()) || {};
    return RP.destinoDeTareas(isObject(c.work_items) ? c.work_items : {}, remote());
  }
  /**
   * Dónde crea la noche las tareas: sólo operations.json (`pedidoDeLaNoche`). `{ leido: false }` si el archivo no se
   * pudo leer o no valida: la noche tampoco crea ninguna, pero no es que la organización no lo haya configurado.
   */
  function destinoDeLaNoche() {
    const dir = dirOps();
    if (!dir) return { leido: false, destino: null };
    const ruta = path.join(dir, 'operations.json');
    if (!OPS.load(ruta).ok) return { leido: false, destino: null };
    return { leido: true, destino: CYCLE.pedidoDeLaNoche(ruta).destino };
  }
  const enlaceDeTarea = RP.enlaceDeTarea;
  const nombreDePersona = (x) => (typeof x === 'string' && SOURCES.NOMBRE_DE_PERSONA.test(x.trim()) ? x.trim() : null);

  // ── el título de cada ficha ──

  const reglaDe = (f) => (f.fuente === 'vigilante' ? (REGLAS.includes(f.hechos && f.hechos.regla) ? f.hechos.regla : 'otra') : null);

  /**
   * El título en llano: el de ejecuciones ya lo es; el del vigilante se arma con el producto, el plugin (o el endpoint),
   * qué pasó según la regla y cuántas veces. Nunca la clave de la regla ni el diagnóstico.
   */
  function tituloDe(f, idioma) {
    if (f.fuente !== 'vigilante') return f.nombre;
    const h = f.hechos || {};
    // el producto ya viene validado por la noche (hechosDelVigilante)
    const p = typeof h.producto === 'string' && h.producto ? h.producto : null;
    // las siglas cortas van en mayúsculas (abc → ABC); el resto, con la primera en mayúscula (facturas → Facturas)
    const producto = !p ? T(idioma, 'mant.titulo.sinProducto') : p.length <= 3 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1);
    const donde = h.plugin ? T(idioma, 'mant.titulo.plugin', { plugin: h.plugin }) : h.endpoint ? T(idioma, 'mant.titulo.endpoint', { endpoint: h.endpoint }) : '';
    const regla = reglaDe(f);
    // el latido cuenta la falta de actividad, no errores; sin errores contados, no hay cifra
    const veces = regla === 'latido' || !Number.isInteger(h.errores) || h.errores < 1 ? '' : h.errores === 1 ? T(idioma, 'mant.titulo.vez') : T(idioma, 'mant.titulo.veces', { n: h.errores });
    return T(idioma, 'mant.titulo', { producto, donde, que: T(idioma, `mant.titulo.${regla}`), veces });
  }

  function arregloDe(f, destino, deLaNoche, idioma) {
    const base = { fuente: f.fuente, id: f.id, nombre: tituloDe(f, idioma), regla: reglaDe(f) };
    const asignado = nombreDePersona(f.asignado);
    if (f.pedido) {
      const numero = f.pedido.enlace ? (/(\d{1,12})\/?$/.exec(f.pedido.enlace) || [])[1] || null : f.pedido.id;
      const enlace = f.pedido.enlace || enlaceDeTarea(destino, destino.proyecto, numero);
      return { ...base, estado: enlace ? 'tarea' : 'sin_enlace', tarea: enlace ? { numero, enlace } : null, asignado, motivo: null };
    }
    if (f.historia) return { ...base, estado: 'historia', tarea: null, historia: f.historia, asignado: null, motivo: null };
    // la noche sólo pide las de promoted/: otra carpeta no tiene tarea hasta que pase
    if (f.carpeta !== 'promoted') return { ...base, estado: 'sin_tarea', tarea: null, asignado: null, motivo: 'sin-mover' };
    // la misma condición con la que pide la noche (queHaraLaNoche): «se crea esta noche» sólo si la pide. El motivo que
    // la noche recalcula cada vez (sin confirmar, sin configurar) se toma de ahora, no de lo que dejó anotado
    const noche = CYCLE.queHaraLaNoche(f, deLaNoche.destino);
    const motivo = noche.pide ? (RECALCULADOS.includes(f.pedido_motivo) ? null : f.pedido_motivo)
      : noche.motivo === 'sin-configurar' && !deLaNoche.leido ? 'configuracion-ilegible' : noche.motivo || f.pedido_motivo || 'sin-mover';
    if (motivo) return { ...base, estado: 'sin_tarea', tarea: null, asignado: null, motivo };
    return { ...base, estado: 'se_crea', tarea: null, asignado: null, motivo: null };
  }

  function vulnerabilidadDe(f, destino) {
    const severidad = String(f.severidad || '').toLowerCase() || null;
    return {
      id: f.id, paquete: f.contexto.paquete || f.nombre, severidad, repos: Number.isInteger(f.repos) ? f.repos : 0, desde: f.primera_vez, volvio: f.reaparecido,
      tareas: (f.pedidos || []).map((t) => ({ proyecto: t.proyecto, numero: t.id, enlace: enlaceDeTarea(destino, t.proyecto, t.id), asignado: nombreDePersona(t.asignado), sinAsignar: t.sin_asignar === true })),
      motivo: f.pedido_motivo || null,
    };
  }

  // ── qué pasó, sin modelo ──

  function quePaso(f, idioma) {
    const c = f.contexto || {};
    if (f.fuente === 'ejecuciones') {
      const n = c.veces || f.apariciones || 1;
      const desde = c.desde || f.primera_vez;
      const hasta = c.hasta || f.ultima_vez || desde;
      const veces = n === 1 ? T(idioma, 'mant.paso.vecesUna', { dia: dia(hasta) })
        : desde === hasta ? T(idioma, 'mant.paso.vecesUnDia', { n, dia: dia(hasta) })
          : T(idioma, 'mant.paso.veces', { n, desde: dia(desde), hasta: dia(hasta) });
      // la clase del error más común, en llano: la ficha nunca trae el texto del error
      const h = f.hechos;
      if (!h || !h.error_clase) return veces;
      const clase = T(idioma, `mant.error.${h.error_clase}`, { codigo: h.error_codigo });
      return `${veces} ${T(idioma, 'mant.paso.error', { clase, k: h.error_clase_veces, n: h.error_veces })}`;
    }
    const h = f.hechos || {};
    const regla = T(idioma, `mant.regla.${h.regla || 'otra'}`);
    let frase;
    if (Number.isInteger(h.errores)) {
      const donde = h.endpoint || (h.plugin ? T(idioma, 'mant.paso.plugin', { plugin: h.plugin }) : T(idioma, 'mant.paso.producto', { producto: h.producto || '?' }));
      const sobre = Number.isInteger(h.total_pedidos) ? T(idioma, 'mant.paso.sobre', { n: h.total_pedidos }) : '';
      frase = T(idioma, h.estado_http ? 'mant.paso.produccion' : 'mant.paso.produccionSinHttp', { errores: h.errores, http: h.estado_http, donde, sobre, regla });
    } else frase = T(idioma, 'mant.paso.produccionSinCifras', { regla });
    const partes = [frase];
    if (h.reincidente_desde) partes.push(T(idioma, 'mant.paso.reincidente', { dia: dia(h.reincidente_desde) }));
    if (Number.isInteger(h.duracion_ms)) partes.push(T(idioma, 'mant.paso.duracion', { s: Math.round(h.duracion_ms / 1000) }));
    return partes.join(' ');
  }

  function metaDe(f, idioma) {
    if (f.fuente === 'vigilante') {
      const producto = PRODUCTO.test(String((f.hechos && f.hechos.producto) || '')) ? f.hechos.producto : null;
      return T(idioma, producto ? 'mant.meta.produccion' : 'mant.meta.produccionSinProducto', { producto, dia: dia(f.ultima_vez || f.primera_vez) });
    }
    const c = f.contexto || {};
    const n = c.veces || f.apariciones || 1;
    const partes = [n === 1 ? T(idioma, 'mant.meta.vez') : T(idioma, 'mant.meta.veces', { n })];
    if (c.maquinas && c.maquinas.length) partes.push(c.maquinas.length === 1 ? T(idioma, 'mant.meta.maquina') : T(idioma, 'mant.meta.maquinas', { n: c.maquinas.length }));
    partes.push(T(idioma, 'mant.meta.ultima', { dia: dia(c.hasta || f.ultima_vez || f.primera_vez) }));
    return partes.join(' · ');
  }

  /** El pull request de una ficha de dependencias, en la plataforma del repo de operaciones; null si no se sabe armar. */
  function enlaceDePedido(pr, prRepo) {
    const r = remote();
    if (!r || !r.web || !/^https:\/\//.test(r.web)) return null;
    const base = r.web.replace(/\.git$/, '').replace(/\/+$/, '');
    if (r.platform === 'github') return `${prRepo ? `${new URL(base).origin}/${prRepo}` : base}/pull/${pr}`;
    // la otra plataforma (como en decisions.js): el pedido vive en el mismo repo de operaciones
    return prRepo ? null : `${base}/pullrequest/${pr}`;
  }

  /** Una dependencia: el paquete, su severidad, dónde está, su pull request y, si la noche no aplicó la decisión, por qué. */
  function filaDeDependencia(f, idioma) {
    const c = f.contexto || {};
    const sev = NOMBRE_SEVERIDAD[f.severidad] || null;
    const repos = Number.isInteger(f.repos) ? f.repos : 0;
    const meta = [sev ? T(idioma, `mant.vuln.${sev}`) : null, T(idioma, repos === 1 ? 'mant.vuln.filaUno' : 'mant.vuln.fila', { n: repos, dia: dia(f.primera_vez) })].filter(Boolean).join(' · ');
    const pedido = c.pr ? { numero: Number(c.pr), enlace: enlaceDePedido(c.pr, c.pr_repo) } : null;
    const fallo = !c.fallida ? null : c.motivo_fallida ? T(idioma, 'mant.dep.fallo', { dia: dia(c.fallida), motivo: c.motivo_fallida }) : T(idioma, 'mant.dep.falloSinMotivo', { dia: dia(c.fallida) });
    return { fuente: f.fuente, id: f.id, nombre: c.paquete || f.nombre, regla: null, meta, que_paso: T(idioma, pedido ? 'mant.dep.conPedido' : 'mant.dep.sinPedido'),
      analisis: null, propuesta: null, sin_analizar: null, recomendada: null, veces: f.noches || 1, detalle: { maquinas: [], stories: [] },
      severidad: f.severidad || null, pedido, fallo };
  }

  function filaParaDecidir(f, idioma) {
    if (f.fuente === 'dependencias') return filaDeDependencia(f, idioma);
    const a = f.analisis;
    const analisis = a ? { recomendacion: a.recomendacion, por_que_pasa: a.por_que_pasa, por_que_recomienda: a.por_que_recomienda, arreglo: a.arreglo || null, si_vuelve: a.si_vuelve || null, autor: a.autor } : null;
    const c = f.contexto || {};
    const pr = f.propuesta;
    return {
      fuente: f.fuente, id: f.id, nombre: tituloDe(f, idioma), regla: reglaDe(f), meta: metaDe(f, idioma), que_paso: quePaso(f, idioma), analisis,
      // la propuesta corta de la noche; la razón que no pasó el filtro no se muestra
      propuesta: pr ? { accion: pr.accion, razon: pr.razon === SOURCES.SIN_FORMA ? null : pr.razon } : null,
      sin_analizar: analisis ? null : T(idioma, 'mant.sinAnalizar', { motivo: T(idioma, `mant.sinAnalizar.${motivoSinAnalisis(f)}`) }),
      recomendada: analisis ? analisis.recomendacion : null, veces: c.veces || f.apariciones || 1,
      detalle: { maquinas: c.maquinas || [], stories: c.stories || [] },
    };
  }

  // orden: producción primero; lo que recomienda arreglar, después aceptar, después lo sin analizar; más veces primero
  const tramo = (x) => (x.recomendada === 'arreglar' ? 0 : x.recomendada === 'aceptar' ? 1 : 2);
  // los paquetes, la más grave primero
  const rangoSeveridad = (s) => (hasOwn(SEVERIDADES, s) ? SEVERIDADES[s] : 9);
  const ordenParaDecidir = (a, b) => SE_DECIDEN.indexOf(a.fuente) - SE_DECIDEN.indexOf(b.fuente) || tramo(a) - tramo(b) || rangoSeveridad(a.severidad) - rangoSeveridad(b.severidad) || b.veces - a.veces || a.nombre.localeCompare(b.nombre) || a.id.localeCompare(b.id);
  const ordenFuente = (a, b) => SE_DECIDEN.indexOf(a.fuente) - SE_DECIDEN.indexOf(b.fuente) || a.nombre.localeCompare(b.nombre);
  const ordenVulns = (a, b) => rangoSeveridad(a.severidad) - rangoSeveridad(b.severidad) || String(a.desde || '9').localeCompare(String(b.desde || '9')) || a.paquete.localeCompare(b.paquete);

  /** El modelo de la pantalla: lo mismo para la página y para /api/hallazgos. */
  async function modelo(idioma) {
    const l = leerFichas();
    if (l.estado === 'sin_clon') return { estado: 'sin_clon', frase: T(idioma, 'mant.sinClon'), pedidos: null, toca: [], espera: [], decididas: [], marcha: { arreglos: [], vulnerabilidades: [] }, cuentas: { toca: 0, espera: 0, decididas: 0, marcha: 0 } };
    if (!l.fichas.length && !l.ilegibles.length) return { estado: 'sin_fichas', frase: T(idioma, 'mant.sinFichas'), pedidos: null, toca: [], espera: [], decididas: [], marcha: { arreglos: [], vulnerabilidades: [] }, cuentas: { toca: 0, espera: 0, decididas: 0, marcha: 0 } };
    const m = await membresia();
    const enPedido = m.estado === 'leido' ? m.porFicha : new Map();
    const dir = dirOps();
    const destino = destinoDeTareas();
    let deLaNoche = null;
    const ilegibles = new Set(l.ilegibles);
    const toca = [];
    const pedidos = new Map();
    const aprobadas = [];
    // las que la noche anotó que no pudo aplicar: «Ya decididas» lo dice
    const fallidas = new Map();
    const arreglos = [];
    const vulnerabilidades = [];
    for (const f of l.fichas) {
      // una vulnerabilidad se sigue en su tarea y, mientras está pendiente, además se decide su pull request
      if (f.fuente === 'dependencias') { if (['pendiente', 'arreglo'].includes(f.veredicto)) vulnerabilidades.push(vulnerabilidadDe(f, destino)); }
      else if (f.veredicto === 'arreglo') { arreglos.push(arregloDe(f, destino, deLaNoche || (deLaNoche = destinoDeLaNoche()), idioma)); continue; }
      if (!porDecidir(f)) continue;
      const enMain = decisionEnMain(dir, f);
      if (enMain === 'ilegible') { ilegibles.add(f.fuente); continue; }
      if (fallidaDe(f)) fallidas.set(clave(f), fallidaDe(f));
      if (enMain) decididas.olvidar(clave(f), { ...enMain, nombre: tituloDe(f, LANG.POR_DEFECTO) });
      const yaDecidida = enMain ? enMain.accion : decididas.accionDe(clave(f), fallidaDe(f));
      if (enMain || yaDecidida) { aprobadas.push({ clave: clave(f), nombre: tituloDe(f, idioma) }); continue; }
      const p = enPedido.get(clave(f));
      if (p) {
        if (!pedidos.has(p.numero)) pedidos.set(p.numero, { numero: p.numero, enlace: p.enlace, aprobado: false, filas: [] });
        pedidos.get(p.numero).filas.push({ fuente: f.fuente, id: f.id, nombre: tituloDe(f, idioma), accion: p.accion });
        continue;
      }
      toca.push(filaParaDecidir(f, idioma));
    }
    toca.sort(ordenParaDecidir);
    const espera = [...pedidos.values()].sort((a, b) => a.numero - b.numero);
    // lo ya decidido no espera la aprobación de nadie: sale de la lista y se cuenta en una línea
    for (const g of espera) g.filas.sort(ordenFuente);
    const yaDecididas = listaDecididas(aprobadas, fallidas);
    arreglos.sort(ordenFuente);
    vulnerabilidades.sort(ordenVulns);
    const ilegible = ilegibles.size > 0;
    const c = fuentes.config();
    return {
      estado: ilegible ? 'ilegible' : 'leido',
      frase: ilegible ? T(idioma, 'mant.ilegible', { fuentes: [...ilegibles].map((x) => T(idioma, `mant.fuente.${x}`)).join(', ') }) : null,
      pedidos: m.estado === 'leido' ? { estado: 'leido', frase: null } : { estado: 'no_se_pudo', frase: T(idioma, 'mant.sinPedidos') },
      toca, espera, decididas: yaDecididas, marcha: { arreglos, vulnerabilidades },
      // con auto_apply, lo enviado se guarda sin que nadie más lo apruebe: la pantalla no habla de aprobar
      aplicaSolo: Boolean(c && isObject(c.site) && c.site.auto_apply === true),
      cuentas: { toca: toca.length, espera: espera.reduce((n, g) => n + g.filas.length, 0), decididas: yaDecididas.length, marcha: arreglos.length + vulnerabilidades.length },
    };
  }

  /**
   * «Ya decididas», de lo anotado: la que la foto muestra decidida y todavía en pending la aplica esta noche; la que ya
   * no está ahí, la aplicó la noche; la que la noche anotó que no pudo aplicar, no se aplicó. `aprobadas`: `[{ clave,
   * nombre }]`, las decididas que siguen en pending; `fallidas`: clave → el día de la anotación.
   */
  function listaDecididas(aprobadas, fallidas = new Map()) {
    const pendientes = new Map(aprobadas.map((x) => [x.clave, x.nombre]));
    return decididas.historia().map((x) => {
      const i = x.clave.indexOf('/');
      const estado = decididas.noAplicada(x, fallidas.get(x.clave)) ? 'no_aplicada' : pendientes.has(x.clave) ? 'esta_noche' : 'aplicada';
      return { fuente: x.clave.slice(0, i), id: x.clave.slice(i + 1), nombre: pendientes.get(x.clave) || x.nombre || x.clave.slice(i + 1), accion: x.accion,
        quien: alias(x.quien), el: x.el || null, estado };
    });
  }

  // ── la página ──

  function seccion(m, idioma, tok) {
    const ayudaRegla = (r) => (r ? ` <button type="button" class="m-q" popovertarget="m-ayuda-regla-${r}" aria-label="${esc(T(idioma, 'mant.ayuda.que', { termino: T(idioma, 'mant.ayuda.termino.regla', { que: T(idioma, `mant.titulo.${r}`) }) }))}">?</button>` : '');
    // con auto_apply, la ayuda de enviar no habla de una aprobación que no hay
    const deAyuda = (k) => (m.aplicaSolo && (k === 'enviar' || k === 'seguir') ? `${k}Solo` : k);
    const ayuda = (k) => `<button type="button" class="m-q" popovertarget="m-ayuda-${k}" aria-label="${esc(T(idioma, 'mant.ayuda.que', { termino: T(idioma, `mant.ayuda.termino.${deAyuda(k)}`) }))}">?</button>`;
    const enlace = (texto, url) => (url && ENLACE.test(url) ? `<a href="${esc(url)}" rel="noopener noreferrer" target="_blank">${esc(texto)}</a>` : esc(texto));
    // en dependencias, aceptar es aceptar su pull request; en las demás, archivar la ficha
    const accion = (a, fuente) => T(idioma, fuente === 'dependencias' && a === 'aceptar' ? 'mant.accionDep.aceptar' : `mant.accion.${a}`);
    // el análisis está en castellano (se escribe así): `lang` para quien lo lee en voz alta, y la nota en otro idioma
    const es = (s) => `<span lang="es">${esc(s)}</span>`;
    const renglon = (k, s) => `<p><b>${esc(T(idioma, k))}</b> ${es(s)}</p>`;

    function carta(f) {
      const a = f.analisis;
      const deDependencias = f.fuente === 'dependencias';
      const botones = ACCIONES_DE[f.fuente].map((x) => `<button type="button" class="m-elegir${x === f.recomendada ? ' recomendada' : ''}" data-accion="${x}" aria-pressed="false">${esc(accion(x, f.fuente))}</button>`).join('');
      // el motivo del rechazo: aparece al elegir Rechazar, una línea con el mismo tope que acepta la noche
      const motivo = deDependencias ? `<label class="m-motivo-caja" hidden>${esc(T(idioma, 'mant.dep.motivo'))} <input type="text" class="m-motivo" maxlength="${CYCLE.MOTIVO_MAX}" autocomplete="off"></label>` : '';
      const acciones = `<div class="m-acciones" role="group" aria-label="${esc(f.nombre)}">${botones}${motivo}</div>`;
      let cuerpo;
      if (deDependencias) {
        const pedido = f.pedido ? ` ${enlace(T(idioma, 'mant.dep.pedido', { numero: f.pedido.numero }), f.pedido.enlace)}.` : '';
        cuerpo = `${f.fallo ? `<p class="m-fallo">${esc(f.fallo)}</p>` : ''}<p>${esc(f.que_paso)}${pedido}</p><div class="m-pie">${acciones}</div>`;
      } else if (a) {
        cuerpo = renglon('mant.porQue', a.por_que_pasa) + renglon(`mant.recomienda.${a.recomendacion}`, a.por_que_recomienda)
          + (a.arreglo ? renglon('mant.siSeArregla', a.arreglo) : '') + (a.si_vuelve ? renglon('mant.siVuelve', a.si_vuelve) : '')
          + `<div class="m-pie"><span class="m-autor">${a.autor === 'persona' ? '' : `${esc(T(idioma, 'mant.autor.modelo'))} `}${idioma === 'es' ? '' : `${esc(T(idioma, 'mant.analisisEnCastellano'))} `}${ayuda('analisis')}</span>${acciones}</div>`;
      } else {
        const pr = f.propuesta;
        const propuesta = pr ? `<p class="m-propuesta">${esc(T(idioma, 'mant.propuesta', { accion: accion(pr.accion) }))}${pr.razon ? ` ${es(pr.razon)}${idioma === 'es' ? '' : ` ${esc(T(idioma, 'mant.razonEnCastellano'))}`}` : ''}</p>` : '';
        cuerpo = `<p class="m-sin">${esc(f.sin_analizar)}</p>${propuesta}<details class="m-sin-analisis"><summary>${esc(T(idioma, 'mant.decidirSinAnalisis'))}</summary>${acciones}</details>`;
      }
      const d = f.detalle;
      const detalle = !deDependencias && (d.maquinas.length || d.stories.length
        ? `<details class="m-detalle"><summary>${esc(T(idioma, 'mant.verDetalle'))}</summary>${d.maquinas.length ? `<p>${esc(T(idioma, 'mant.detalle.maquinas', { lista: d.maquinas.join(', ') }))}</p>` : ''}${d.stories.length ? `<p>${esc(T(idioma, 'mant.detalle.stories', { lista: d.stories.join(', ') }))}</p>` : ''}</details>`
        : '');
      return `<article class="m-carta${a || deDependencias ? '' : ' sin-analizar'}" data-ficha="${esc(clave(f))}"${f.recomendada ? ` data-recomendada="${esc(f.recomendada)}"` : ''}>`
        + `<header class="m-cab"><b class="m-nombre">${esc(f.nombre)}</b>${ayudaRegla(f.regla)}<span class="m-meta">${esc(f.meta)}</span></header>`
        + `${deDependencias ? '' : `<p><b>${esc(T(idioma, 'mant.quePaso'))}</b> ${esc(f.que_paso)}</p>`}${cuerpo}${detalle || ''}</article>`;
    }

    // te toca decidir
    const subgrupos = SE_DECIDEN.map((fuente) => {
      const filas = m.toca.filter((x) => x.fuente === fuente);
      const sub = { vigilante: 'mant.sub.produccion', ejecuciones: 'mant.sub.ejecuciones', dependencias: 'mant.sub.dependencias' }[fuente];
      // el molde del número va en la página: la pantalla recuenta sola cuando saca una ficha
      return filas.length ? `<h3 class="m-sub" data-fuente="${esc(fuente)}" data-t="${esc(T(idioma, sub, { n: '{n}' }))}">${esc(T(idioma, sub, { n: filas.length }))}</h3>${filas.map(carta).join('')}` : '';
    }).join('');
    const toca = `<div class="m-bloque m-toca" data-t-vacio="${esc(T(idioma, 'mant.vacio'))}"><h2 data-t="${esc(T(idioma, 'mant.toca.titulo', { n: '{n}' }))}">${esc(T(idioma, 'mant.toca.titulo', { n: m.toca.length }))}</h2>`
      + `<p class="m-intro">${esc(T(idioma, m.aplicaSolo ? 'mant.toca.introSolo' : 'mant.toca.intro'))} ${ayuda('aceptar')} ${ayuda('arreglar')} ${ayuda('enviar')}</p>`
      + (m.toca.length ? subgrupos : `<p class="q-note">${esc(T(idioma, 'mant.vacio'))}</p>`) + '</div>';

    // esperando aprobación
    const grupo = (g) => {
      // «Pedido 12 · 3 decisiones»: el enlace va sobre la primera parte
      const [nombre, ...resto] = T(idioma, g.filas.length === 1 ? 'mant.espera.pedidoUna' : 'mant.espera.pedido', { numero: g.numero, n: g.filas.length }).split(' · ');
      const cab = [enlace(nombre, g.enlace), ...resto.map(esc)].join(' · ');
      const filas = g.filas.map((x) => `<li>${esc(x.nombre)} → ${esc(x.accion ? accion(x.accion, x.fuente) : '?')}</li>`).join('');
      return `<div class="m-pedido"><p class="m-pedido-cab">${cab}</p><ul>${filas}</ul></div>`;
    };
    const espera = m.espera.length
      ? `<div class="m-bloque m-espera"><h2>${esc(T(idioma, 'mant.espera.titulo', { n: m.cuentas.espera }))}</h2><p class="m-intro">${esc(T(idioma, 'mant.espera.intro'))}</p>${m.espera.map(grupo).join('')}</div>`
      : '';

    // ya decididas: va en la página aunque esté vacía, para que lo enviado pase ahí sin recargar
    const estadoDe = (e) => T(idioma, { aplicada: 'mant.decididas.aplicada', no_aplicada: 'mant.decididas.noAplicada' }[e] || 'mant.decididas.estaNoche');
    const decidida = (x) => `<li data-ficha="${esc(`${x.fuente}/${x.id}`)}"><b>${esc(x.nombre)}</b> <span class="m-tarea">${esc([x.accion ? accion(x.accion, x.fuente) : '?', dia(x.el), x.quien, estadoDe(x.estado)].filter(Boolean).join(' · '))}</span></li>`;
    const ya = `<details class="m-bloque m-decididas"${m.decididas.length ? '' : ' hidden'} data-t-esta-noche="${esc(estadoDe('esta_noche'))}">`
      + `<summary data-t="${esc(T(idioma, 'mant.decididas.titulo', { n: '{n}' }))}">${esc(T(idioma, 'mant.decididas.titulo', { n: m.decididas.length }))}</summary>`
      + `<p class="m-intro">${esc(T(idioma, 'mant.decididas.intro'))}</p><ul class="m-lista">${m.decididas.map(decidida).join('')}</ul></details>`;

    // en marcha
    const tarea = (numero, url, proyecto) => enlace(T(idioma, proyecto ? 'mant.marcha.tareaProyecto' : 'mant.marcha.tarea', { numero, proyecto }), url);
    // la story por su nombre, nunca por la ruta; con el número del pedido si lo hay
    const historia = (h) => (h && h.nombre
      ? T(idioma, Number.isInteger(h.pedido) ? 'mant.marcha.historiaPedido' : 'mant.marcha.historia', { nombre: h.nombre, pedido: h.pedido })
      : T(idioma, 'mant.marcha.historiaSinNombre'));
    const arreglo = (x) => {
      const t = x.estado === 'tarea' ? `${tarea(x.tarea.numero, x.tarea.enlace)}${x.asignado ? ` · ${esc(T(idioma, 'mant.marcha.asignada', { quien: x.asignado }))}` : ''}`
        : x.estado === 'sin_enlace' ? esc(T(idioma, 'mant.marcha.sinEnlace'))
          : x.estado === 'sin_tarea' ? esc(T(idioma, 'mant.marcha.sinTarea', { motivo: T(idioma, `mant.sinTarea.${x.motivo}`) }))
            : x.estado === 'historia' ? esc(historia(x.historia))
              : esc(T(idioma, 'mant.marcha.seCrea'));
      return `<li><b>${esc(x.nombre)}</b>${ayudaRegla(x.regla)} <span class="m-tarea">${t}</span></li>`;
    };
    const tareaDeVuln = (t) => (t.enlace ? `${tarea(t.numero, t.enlace, t.proyecto)}` : esc(T(idioma, 'mant.marcha.sinEnlace')))
      // «sin asignar» sólo si la noche leyó la tarea y no la tiene nadie; sin medir, lo dice
      + ` · ${esc(t.asignado ? T(idioma, 'mant.marcha.asignada', { quien: t.asignado }) : T(idioma, t.sinAsignar ? 'mant.marcha.sinAsignar' : 'mant.marcha.asignadoSinMedir'))}`;
    const vuln = (v) => {
      const sev = NOMBRE_SEVERIDAD[v.severidad] || null;
      const meta = [T(idioma, v.repos === 1 ? 'mant.vuln.filaUno' : 'mant.vuln.fila', { n: v.repos, dia: dia(v.desde) })];
      if (v.volvio) meta.push(T(idioma, 'mant.vuln.volvio', { dia: dia(v.volvio) }));
      const tareas = v.tareas.length === 1 ? tareaDeVuln(v.tareas[0])
        : v.tareas.length ? `<details class="m-tareas"><summary>${esc(T(idioma, 'mant.marcha.tareas', { n: v.tareas.length }))}</summary><ul>${v.tareas.map((t) => `<li>${tareaDeVuln(t)}</li>`).join('')}</ul></details>`
          : esc(v.motivo ? T(idioma, 'mant.vuln.sinTarea', { motivo: T(idioma, `mant.sinTarea.${v.motivo}`) }) : T(idioma, 'mant.vuln.sinTareaSinMotivo'));
      return `<li class="m-vuln">${sev ? `<span class="m-sev sev-${sev}">${esc(T(idioma, `mant.vuln.${sev}`))}</span> ` : ''}<b>${esc(v.paquete)}</b> <span class="m-meta">${esc(meta.join(' · '))}</span> <span class="m-tarea">${tareas}</span></li>`;
    };
    const vs = m.marcha.vulnerabilidades;
    const masVieja = vs.map((v) => v.desde).filter(Boolean).sort()[0];
    const vulns = vs.length
      ? `<details class="m-vulns"><summary>${esc(T(idioma, 'mant.vuln.resumen', { n: vs.length, c: vs.filter((v) => v.severidad === 'critical').length, a: vs.filter((v) => v.severidad === 'high').length, dia: dia(masVieja) }))}</summary><ul class="m-lista">${vs.map(vuln).join('')}</ul></details>`
        + `<p class="m-deuda q-note">${esc(T(idioma, 'mant.vuln.deuda'))} ${ayuda('deuda')}</p>`
      : '';
    const marcha = m.cuentas.marcha
      ? `<details class="m-bloque m-marcha"><summary>${esc(T(idioma, 'mant.marcha.titulo', { n: m.cuentas.marcha }))}</summary><p class="m-intro">${esc(T(idioma, 'mant.marcha.intro'))} ${ayuda('tarea')}</p>`
        + (m.marcha.arreglos.length ? `<ul class="m-lista">${m.marcha.arreglos.map(arreglo).join('')}</ul>` : '') + `${vulns}</details>`
      : '';

    // la barra y la ayuda: sólo si hay algo para decidir
    const k = m.toca.filter((x) => x.recomendada).length;
    const textos = { elegidas: 'mant.barra.elegidas', elegidaUna: 'mant.barra.elegidaUna', faltaMotivo: 'mant.barra.faltaMotivo', seguir: 'mant.barra.seguir', enviando: 'mant.envio.enviando', lento: 'mant.envio.lento', verificando: 'mant.envio.verificando', yaEnviado: 'mant.envio.yaEnviado', noLlego: 'mant.envio.noLlego', aplicado: 'mant.envio.aplicado', ok: 'mant.envio.ok', error: 'mant.envio.error', demo: 'mant.envio.demo', esperaTitulo: 'mant.espera.titulo', pedido: 'mant.espera.pedido', pedidoUna: 'mant.espera.pedidoUna' };
    const datos = Object.entries(textos).map(([n, kk]) => ` data-t-${n.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${esc(T(idioma, kk))}"`).join('')
      + ` data-t-aceptar="${esc(accion('aceptar'))}" data-t-arreglar="${esc(accion('arreglar'))}" data-t-reject="${esc(accion('reject'))}" data-t-dep-aceptar="${esc(accion('aceptar', 'dependencias'))}"`;
    const barra = m.toca.length
      ? `<div class="m-barra"${datos}><span class="m-cuenta" aria-live="polite"></span><button type="button" class="btn prim m-enviar" disabled>${esc(T(idioma, m.aplicaSolo ? 'mant.barra.enviarSolo' : 'mant.barra.enviar'))}</button>`
        + `<button type="button" class="btn m-seguir" data-t="${esc(T(idioma, 'mant.barra.seguir', { n: '{n}' }))}"${k ? '' : ' disabled'}>${esc(T(idioma, 'mant.barra.seguir', { n: k }))}</button>${ayuda('seguir')}<button type="button" class="btn m-borrar">${esc(T(idioma, 'mant.barra.borrar'))}</button><span class="m-estado" aria-live="polite"></span></div>`
      : '';
    const negritas = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    const ayudas = AYUDAS.map((x) => `<div id="m-ayuda-${x}" popover class="m-pop"><p>${negritas(T(idioma, `ayuda.${deAyuda(x)}`))}</p></div>`).join('')
      + REGLAS.map((r) => `<div id="m-ayuda-regla-${r}" popover class="m-pop"><p>${esc(T(idioma, `mant.regla.${r}`))}.</p></div>`).join('');
    const frases = [m.frase, m.pedidos && m.pedidos.frase].filter(Boolean).map((t) => `<p class="q-note">${esc(t)}</p>`).join('');
    const contenido = m.estado === 'sin_clon' || m.estado === 'sin_fichas' ? '' : toca + espera + ya + marcha + barra + ayudas;
    return `<section id="hallazgos" class="m-pantalla" data-token="${esc(tok)}">${frases}${contenido}<script src="/hallazgos/cliente.js" defer></script></section>`;
  }

  // ── enviar para aprobar ──

  async function confirmar(body, ctx, idioma) {
    const invalido = json(400, { ok: false, message: T(idioma, 'hallazgos.pedidoInvalido') });
    // la forma de varias (`{ decisiones: [...] }`) o la de a una, como antes
    const lista = isObject(body) && Array.isArray(body.decisiones) ? body.decisiones : isObject(body) && 'fuente' in body ? [body] : null;
    if (!lista || !lista.length || lista.length > TOPE_ENVIO) return invalido;
    if (lista.some((x) => !isObject(x) || !SE_DECIDEN.includes(x.fuente) || typeof x.id !== 'string' || !ID.test(x.id) || !ACCIONES_DE[x.fuente].includes(x.accion))) return invalido;
    // 🔴 El motivo va sólo en un rechazo y lo escribe una persona: termina como comentario del pull request. Una línea,
    // con el tope de la noche (`motivoConForma`); uno que no lo cumple no se recorta: se rechaza el envío entero.
    if (lista.some((x) => (x.accion === 'reject') !== hasOwn(x, 'motivo') || (x.accion === 'reject' && !(typeof x.motivo === 'string' && CYCLE.motivoConForma(x.motivo.trim()))))) return invalido;
    if (new Set(lista.map(clave)).size !== lista.length) return invalido;
    const dir = dirOps();
    if (!dir) return json(200, { ok: false, codigo: 'sin_clon', message: T(idioma, 'mant.sinClon') });
    // sin saber qué espera aprobación no se envía: una ficha ya enviada en otro pedido abriría un segundo
    const m = await membresia();
    if (m.estado !== 'leido') return json(200, { ok: false, codigo: 'sin_pedidos', message: T(idioma, 'mant.sinPedidos') });
    const enPedido = m.porFicha;
    const omitidas = [];
    // lo que ya está decidido en main: sale de la lista y pasa a «Ya decididas»
    const previas = [];
    const nombres = new Map();
    const vistas = new Map();
    let van = [];
    for (const x of lista) {
      const reg = SOURCES.FUENTES[x.fuente];
      // 🔴 Sólo «el archivo no está» es «ya no está pendiente»: una ficha o una carpeta que no se pueden leer no abren
      // un pedido a ciegas ni dicen que otro ya la decidió.
      let f = null;
      try {
        const txt = fs.readFileSync(path.join(dir, 'inbox', reg.carpeta, 'pending', `${x.id}${reg.extension}`), 'utf8');
        f = SOURCES.comoFicha(x.fuente, txt);
        if (f) f = { ...f, carpeta: 'pending', contexto: contextoDe(x.fuente, reg, txt) };
      } catch (e) {
        if (!(e && e.code === 'ENOENT')) return json(200, { ok: false, codigo: 'ficha_ilegible', message: T(idioma, 'hallazgos.fichaIlegible') });
      }
      if (!f || f.id !== x.id || f.estado === 'resuelta' || !porDecidir(f)) { omitidas.push(clave(x)); continue; }
      const enMain = decisionEnMain(dir, x);
      if (enMain === 'ilegible') return json(200, { ok: false, codigo: 'decision_ilegible', message: T(idioma, 'hallazgos.decisionIlegible') });
      nombres.set(clave(x), tituloDe(f, LANG.POR_DEFECTO));
      vistas.set(clave(x), fallidaDe(f));
      if (enMain) previas.push({ clave: clave(x), ...enMain });
      if (enMain || decididas.accionDe(clave(x), fallidaDe(f)) || enPedido.has(clave(x))) { omitidas.push(clave(x)); continue; }
      // 🔴 En dependencias, el pull request es el de la ficha, nunca el que diga el navegador: la noche lo compara antes
      // de mergear o cerrar (`mismoPedido`), y otro número haría que actúe sobre un pedido que la persona no vio.
      const deLaFicha = x.fuente === 'dependencias' ? { pr: f.contexto.pr, pr_repo: f.contexto.pr_repo } : {};
      van.push({ fuente: x.fuente, id: x.id, accion: x.accion, ...deLaFicha, ...(x.accion === 'reject' ? { motivo: x.motivo.trim() } : {}) });
    }
    const quien = norm((ctx.sesion && ctx.sesion.email) || (ctx.quien && ctx.quien.email));
    const el = new Date(ahora()).toISOString().slice(0, 10);
    // lo que la pantalla pasa a «Ya decididas» en el momento, sin el correo
    const paraLaPantalla = (xs) => xs.map((x) => ({ clave: x.clave, accion: x.accion, quien: alias(x.quien), el: x.el || null }));
    for (const x of previas) decididas.olvidar(x.clave, { ...x, nombre: nombres.get(x.clave) });
    if (!van.length) return json(200, { ok: false, codigo: 'nada_que_enviar', message: T(idioma, 'mant.envio.nadaQueEnviar'), omitidas, decididas: paraLaPantalla(previas) });
    const conForma = (lista) => lista.map((x) => ({ fuente: x.fuente, id: x.id, accion: x.accion, quien, el,
      ...(x.fuente === 'dependencias' ? { pr: x.pr, pr_repo: x.pr_repo } : {}), ...(x.accion === 'reject' ? { motivo: x.motivo } : {}) }));
    const archivosDe = (decs) => decs.map((d) => ({ archivo: rutaDecision(d.fuente, d.id), contenido: `${JSON.stringify(d, null, 2)}\n`, oidEsperado: null }));
    if (demo) return json(200, { ok: true, codigo: 'demo', demo: true, loQuePasaria: { repo: 'operaciones', archivos: archivosDe(conForma(van)).map(({ archivo, contenido }) => ({ archivo, contenido })) }, omitidas });
    // la noche sólo aplica una decisión con forma: una que no la tiene (sin correo, por ejemplo) no se propone
    if (conForma(van).some((d) => !CYCLE.decisionConForma(d, d.fuente, d.id))) return json(200, { ok: false, codigo: 'sin_identidad', message: T(idioma, 'hallazgos.sinIdentidad') });
    let clon = dir;
    if (clones().operaciones.indice) {
      if (typeof fuentes.clonDeEscritura !== 'function') return json(200, { ok: false, message: TX.t('es', 'config.sinClonEscritura') });
      const e = await fuentes.clonDeEscritura();
      if (!e || !e.dir) return json(200, { ok: false, message: TX.t('es', 'config.clonFallo', { motivo: (e && e.motivo) || TX.t('es', 'config.noSeArmoClon') }) });
      clon = e.dir;
    }
    const c = fuentes.config();
    // 🔴 La foto del sitio puede venir atrasada: main, recién traída, ya puede tener la decisión de una ficha (un envío
    // anterior que llegó mientras la pantalla esperaba). Esa no es un choque: ya está hecha. Sale de la lista y se
    // propone el resto; el choque con otra cosa (un archivo que no es su decisión) sigue siendo un error.
    const yaDecididas = [];
    let r;
    for (;;) {
      const decisiones = conForma(van);
      const archivos = archivosDe(decisiones);
      const secciones = van.map((x) => `${clave(x)} → ${x.accion}`);
      // el pedido se nombra por lo que trae: reenviar lo mismo encuentra el abierto y no abre otro
      const idCorto = `decisiones-${crypto.createHash('sha1').update([...secciones].sort().join('\n')).digest('hex').slice(0, 12)}`;
      r = await RP.proponer({
        clon, archivos, idCorto, secciones, titulo: `Decisiones sobre lo que encontró la noche (${van.length})`, quien,
        credencial: cfg.escritura && cfg.escritura.operaciones, remote: remote(), urlBase, exclusivo: fuentes.exclusivo || ((fn) => fn()),
        now: new Date(ahora()), fetch, log, aplicarSolo: Boolean(c && isObject(c.site) && c.site.auto_apply === true),
      });
      const hecha = r && r.codigo === 'cambio' ? decisionPropia(r.archivo || archivos[0].archivo, r.textoActual) : null;
      if (!hecha) break;
      yaDecididas.push(hecha);
      van = van.filter((x) => clave(x) !== hecha.clave);
      if (!van.length) break;
    }
    // la próxima lectura vuelve a mirar qué espera aprobación
    membresiaGuardada = null;
    const aplicadas = r && r.codigo === 'aplicado' ? van.map((x) => ({ clave: clave(x), accion: x.accion, quien, el })) : [];
    // lo decidido queda anotado y sale de la lista ya; no se refresca acá: la foto todavía no lo trae, y un refresco baja
    // el buzón (un minuto en un sitio real) con la pantalla esperando
    const hechas = [...yaDecididas, ...aplicadas];
    if (hechas.length) decididas.marcar(hechas.map((x) => ({ ...x, nombre: nombres.get(x.clave), vio: vistas.get(x.clave) })));
    const omitidasTodas = [...omitidas, ...yaDecididas.map((x) => x.clave)];
    const alaVista = paraLaPantalla([...previas, ...hechas]);
    if (!van.length) return json(200, { ok: true, codigo: 'ya_decidida', message: T(idioma, 'mant.envio.yaDecidida'), omitidas: omitidasTodas, enviadas: [], decididas: alaVista });
    const { textoActual: _t, oidActual: _o, ...resto } = r || {};
    const numero = numeroDe(resto.enlace);
    return json(200, { ...resto, ...(numero ? { numero } : {}), omitidas: omitidasTodas, enviadas: van.map(clave), decididas: alaVista });
  }

  /** Si el texto de main en `archivo` es la decisión de esa misma ficha: `{ clave, accion, quien, el }`; si no, null. */
  function decisionPropia(archivo, texto) {
    const m = /^inbox\/([^/]+)\/decisions\/([^/]+)\.json$/.exec(String(archivo || ''));
    if (!m || typeof texto !== 'string') return null;
    let d = null;
    try { d = JSON.parse(texto); } catch { return null; }
    if (!isObject(d) || !SE_DECIDEN.includes(d.fuente) || carpetaDe(d.fuente) !== m[1] || d.id !== m[2] || !ACCIONES_DE[d.fuente].includes(d.accion)) return null;
    return { clave: `${d.fuente}/${d.id}`, accion: d.accion, quien: typeof d.quien === 'string' ? d.quien : null, el: DIA.test(String(d.el || '')) ? d.el : null };
  }

  /** Un envío con número: el mismo número no se corre dos veces, y cómo terminó queda para preguntarlo. */
  function porNumero(id, correr) {
    const t = ahora();
    for (const [k, v] of envios) if (t - v.t > VIGENCIA_ENVIO_MS) envios.delete(k);
    if (!id) return correr();
    const previo = envios.get(id);
    if (previo) return previo.promesa;
    const e = { t, estado: 'en_curso', resultado: null, promesa: null };
    e.promesa = Promise.resolve().then(correr).then((res) => { e.estado = 'listo'; e.resultado = res; return res; }, (err) => { envios.delete(id); throw err; });
    envios.set(id, e);
    return e.promesa;
  }

  /** Los mensajes de la casa, en el idioma del pedido (como la Configuración). */
  const enIdioma = (r, idioma) => {
    if (idioma === LANG.POR_DEFECTO) return r;
    try { return { ...r, cuerpo: JSON.stringify(TX.traducirRespuesta(idioma, JSON.parse(r.cuerpo))) }; } catch { return r; }
  };

  const solo = ['maintainer'];
  return [
    {
      method: 'GET', path: '/mantenimiento', needs: solo, pestana: { id: 'mantenimiento', titulo: 'Mantenimiento', orden: 25, cuenta: () => cuantasEsperan(), esperanDe: (fuente) => cuantasEsperan(fuente) }, handler: async (ctx) => {
        const idioma = views.idiomaDe(ctx);
        const tok = ctx.sesion && typeof ctx.sesion.tok === 'string' ? ctx.sesion.tok.replace(/[^A-Za-z0-9_-]/g, '') : '';
        const cuerpo = ctx.quien && ctx.quien.rol === 'maintainer' ? seccion(await modelo(idioma), idioma, tok) : '';
        return { status: 200, tipo: 'text/html; charset=utf-8', cuerpo: views.layout(ctx, T(idioma, 'pestana.mantenimiento'), cuerpo, T(idioma, 'mant.lede')) };
      },
    },
    { method: 'GET', path: '/api/hallazgos', needs: solo, handler: async (ctx) => json(200, await modelo(views.idiomaDe(ctx))) },
    {
      method: 'POST', path: '/api/hallazgos/confirmar', needs: solo, handler: async (ctx) => {
        const e = await defensaDeEscritura(cfg, ctx);
        if (e.error) return e.error;
        const idioma = views.idiomaDe(ctx);
        const id = isObject(e.body) && hasOwn(e.body, 'envio') ? e.body.envio : null;
        if (id !== null && (typeof id !== 'string' || !ENVIO.test(id))) return json(400, { ok: false, message: T(idioma, 'hallazgos.pedidoInvalido') });
        // la respuesta se arma en el idioma de quien pregunta; lo guardado, en el de la casa
        return enIdioma(await porNumero(id, () => confirmar(e.body, ctx, idioma)), idioma);
      },
    },
    {
      method: 'GET', path: '/api/hallazgos/envio', needs: solo, handler: (ctx) => {
        const id = ctx.url && ctx.url.searchParams.get('id');
        if (typeof id !== 'string' || !ENVIO.test(id)) return json(400, { ok: false, message: T(views.idiomaDe(ctx), 'hallazgos.pedidoInvalido') });
        const e = envios.get(id);
        if (!e || ahora() - e.t > VIGENCIA_ENVIO_MS) return json(200, { estado: 'desconocido' });
        if (e.estado !== 'listo') return json(200, { estado: 'en_curso' });
        let resultado = null;
        try { resultado = JSON.parse(e.resultado.cuerpo); } catch { /* sin cuerpo legible: se dice listo sin detalle */ }
        return json(200, { estado: 'listo', resultado });
      },
    },
    { method: 'GET', path: '/hallazgos/cliente.js', needs: solo, handler: () => ({ status: 200, tipo: 'text/javascript; charset=utf-8', cuerpo: CLIENTE }) },
  ];
}

// El cliente: marcar Archivar o Arreglar en cada tarjeta (en dependencias, Aceptar o Rechazar con su motivo; todo se
// recuerda en el navegador), seguir las recomendaciones y enviar todo junto. Un rechazo sin motivo no se envía. Sin «Enviar para aprobar» no se escribe nada. Lo enviado pasa a «Esperando aprobación» o a «Ya
// decididas» sin recargar, y cada número de la pantalla se recuenta.
const CLIENTE = `(function () {
  var s = document.getElementById('hallazgos');
  var barra = s && s.querySelector('.m-barra');
  if (!s || !barra) return;
  var GUARDA = 'mant-elecciones', GUARDA_MOTIVOS = 'mant-motivos';
  var t = function (n) { return barra.getAttribute('data-t-' + n) || ''; };
  var elecciones = {};
  try { elecciones = JSON.parse(localStorage.getItem(GUARDA) || '{}') || {}; } catch (e) { elecciones = {}; }
  var motivos = {};
  try { motivos = JSON.parse(localStorage.getItem(GUARDA_MOTIVOS) || '{}') || {}; } catch (e) { motivos = {}; }
  var cartas = function () { return s.querySelectorAll('article[data-ficha]'); };
  var vivas = {};
  Array.prototype.forEach.call(cartas(), function (c) { vivas[c.getAttribute('data-ficha')] = true; });
  var ACCIONES = ['aceptar', 'arreglar', 'reject'];
  Object.keys(elecciones).forEach(function (k) { if (!vivas[k] || ACCIONES.indexOf(elecciones[k]) < 0) delete elecciones[k]; });
  Object.keys(motivos).forEach(function (k) { if (!vivas[k] || typeof motivos[k] !== 'string') delete motivos[k]; });
  // el motivo de un rechazo: una línea, con el tope del campo
  var motivoDe = function (k) { return String(motivos[k] || '').replace(/[\\u0000-\\u001f\\u007f\\u2028\\u2029]+/g, ' ').trim(); };
  var faltaMotivo = function () { return Object.keys(elecciones).some(function (k) { return elecciones[k] === 'reject' && !motivoDe(k); }); };
  // en dependencias, aceptar es aceptar su pull request
  var etiqueta = function (k, a) { return k.indexOf('dependencias/') === 0 && a === 'aceptar' ? t('dep-aceptar') : t(a); };
  var enviando = false;
  var hayRecomendadas = Boolean(s.querySelector('article[data-recomendada]'));
  function guardar() { try { localStorage.setItem(GUARDA, JSON.stringify(elecciones)); localStorage.setItem(GUARDA_MOTIVOS, JSON.stringify(motivos)); } catch (e) { /* sin almacenamiento: sólo se pierde la marca al recargar */ } }
  function pintar() {
    Array.prototype.forEach.call(cartas(), function (c) {
      var k = c.getAttribute('data-ficha');
      Array.prototype.forEach.call(c.querySelectorAll('button[data-accion]'), function (b) { b.setAttribute('aria-pressed', elecciones[k] === b.getAttribute('data-accion') ? 'true' : 'false'); });
      if (elecciones[k]) { var d = c.querySelector('details.m-sin-analisis'); if (d) d.open = true; }
      var caja = c.querySelector('.m-motivo-caja');
      if (caja) {
        caja.hidden = elecciones[k] !== 'reject';
        var campo = caja.querySelector('.m-motivo');
        if (campo.value !== (motivos[k] || '')) campo.value = motivos[k] || '';
        campo.disabled = enviando;
      }
    });
    var n = Object.keys(elecciones).length;
    var falta = faltaMotivo();
    barra.querySelector('.m-cuenta').textContent = (n === 1 ? t('elegida-una') : t('elegidas').replace('{n}', n)) + (falta ? ' ' + t('falta-motivo') : '');
    barra.querySelector('.m-enviar').disabled = n === 0 || enviando || falta;
    // mientras se envía no se cambia nada: otra elección abriría un segundo pedido con las mismas fichas
    Array.prototype.forEach.call(s.querySelectorAll('button[data-accion], .m-borrar'), function (b) { b.disabled = enviando; });
    barra.querySelector('.m-seguir').disabled = enviando || !hayRecomendadas;
    // la barra aparece cuando hay algo que enviar o una recomendación para seguir
    barra.hidden = n === 0 && !hayRecomendadas && !barra.querySelector('.m-estado').textContent;
    guardar();
  }
  s.addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-accion]');
    if (!b || enviando) return;
    var c = b.closest('article[data-ficha]');
    var k = c.getAttribute('data-ficha');
    var a = b.getAttribute('data-accion');
    if (elecciones[k] === a) delete elecciones[k]; else elecciones[k] = a;
    pintar();
    var campo = a === 'reject' && elecciones[k] === 'reject' && c.querySelector('.m-motivo');
    if (campo) campo.focus();
  });
  s.addEventListener('input', function (ev) {
    var campo = ev.target;
    if (!campo.classList || !campo.classList.contains('m-motivo')) return;
    motivos[campo.closest('article[data-ficha]').getAttribute('data-ficha')] = campo.value;
    pintar();
  });
  barra.querySelector('.m-seguir').addEventListener('click', function () {
    Array.prototype.forEach.call(cartas(), function (c) { var r = c.getAttribute('data-recomendada'); if (r) elecciones[c.getAttribute('data-ficha')] = r; });
    pintar();
  });
  barra.querySelector('.m-borrar').addEventListener('click', function () { elecciones = {}; motivos = {}; pintar(); });
  function quitar(k) {
    var c = s.querySelector('article[data-ficha="' + k.replace(/"/g, '') + '"]');
    if (c) c.parentNode.removeChild(c);
    delete elecciones[k];
    delete motivos[k];
    hayRecomendadas = Boolean(s.querySelector('article[data-recomendada]'));
    recontar();
  }
  // los números de la pantalla cuentan lo que sigue esperando: el título, el subtítulo de cada fuente, la pestaña,
  // «Seguir las recomendaciones» y «Ya decididas»; sin nada por decidir, la frase de la lista vacía
  function recontar() {
    var toca = s.querySelector('.m-toca');
    if (!toca) return;
    var n = toca.querySelectorAll('article[data-ficha]').length;
    var h2 = toca.querySelector('h2[data-t]');
    if (h2) h2.textContent = h2.getAttribute('data-t').replace('{n}', n);
    if (!n && !toca.querySelector('.q-note')) { var vacio = document.createElement('p'); vacio.className = 'q-note'; vacio.textContent = toca.getAttribute('data-t-vacio') || ''; toca.appendChild(vacio); }
    var seguir = barra.querySelector('.m-seguir');
    seguir.textContent = (seguir.getAttribute('data-t') || '').replace('{n}', s.querySelectorAll('article[data-recomendada]').length);
    var ya = s.querySelector('.m-decididas');
    if (ya) {
      var cuantas = ya.querySelectorAll('li').length;
      var sum = ya.querySelector('summary[data-t]');
      if (sum) sum.textContent = sum.getAttribute('data-t').replace('{n}', cuantas);
      ya.hidden = !cuantas;
    }
    Array.prototype.forEach.call(toca.querySelectorAll('h3.m-sub[data-fuente]'), function (h3) {
      var f = h3.getAttribute('data-fuente');
      var m = toca.querySelectorAll('article[data-ficha^="' + f + '/"]').length;
      if (m) h3.textContent = h3.getAttribute('data-t').replace('{n}', m);
      else h3.parentNode.removeChild(h3);
    });
    var tab = document.querySelector('nav.tabs a[href="/mantenimiento"]');
    var txt = tab && tab.lastChild;
    if (txt && txt.nodeType === 3) txt.nodeValue = txt.nodeValue.replace(/\\s*\\(\\d+\\)$/, '') + (n ? ' (' + n + ')' : '');
  }
  // lo decidido pasa a «Ya decididas» con lo que contestó el sitio: qué, cuándo y quién; la noche lo aplica
  function aDecididas(lista) {
    var ya = s.querySelector('.m-decididas');
    var ul = ya && ya.querySelector('ul');
    (lista || []).forEach(function (x) {
      var k = String(x.clave || '');
      var c = s.querySelector('article[data-ficha="' + k.replace(/"/g, '') + '"]');
      if (!c) return;
      if (ul) {
        var viejo = ul.querySelector('li[data-ficha="' + k.replace(/"/g, '') + '"]');
        if (viejo) ul.removeChild(viejo);
        var li = document.createElement('li'); li.setAttribute('data-ficha', k);
        var b = document.createElement('b'); b.textContent = c.querySelector('.m-nombre').textContent; li.appendChild(b);
        var el = /^\\d{4}-\\d{2}-\\d{2}$/.test(x.el || '') ? x.el.slice(8, 10) + '/' + x.el.slice(5, 7) : '';
        var sp = document.createElement('span'); sp.className = 'm-tarea';
        sp.textContent = [etiqueta(k, x.accion) || '?', el, x.quien || '', ya.getAttribute('data-t-esta-noche') || ''].filter(Boolean).join(' · ');
        li.appendChild(document.createTextNode(' ')); li.appendChild(sp);
        ul.insertBefore(li, ul.firstChild);
      }
      quitar(k);
    });
  }
  function aEspera(j, enviadas, acciones) {
    var bloque = s.querySelector('.m-espera');
    if (!bloque) {
      bloque = document.createElement('div'); bloque.className = 'm-bloque m-espera';
      var h = document.createElement('h2'); bloque.appendChild(h);
      var toca = s.querySelector('.m-toca'); toca.parentNode.insertBefore(bloque, toca.nextSibling);
    }
    var g = document.createElement('div'); g.className = 'm-pedido';
    var cab = document.createElement('p'); cab.className = 'm-pedido-cab';
    var texto = (enviadas.length === 1 ? t('pedido-una') : t('pedido')).replace('{numero}', j.numero || '').replace('{n}', enviadas.length);
    if (j.enlace && /^https:\\/\\//.test(j.enlace)) { var a = document.createElement('a'); a.href = j.enlace; a.rel = 'noopener noreferrer'; a.target = '_blank'; a.textContent = texto; cab.appendChild(a); } else cab.textContent = texto;
    g.appendChild(cab);
    var ul = document.createElement('ul');
    enviadas.forEach(function (k) {
      var c = s.querySelector('article[data-ficha="' + k.replace(/"/g, '') + '"]');
      if (!c) return;
      var li = document.createElement('li'); li.textContent = c.querySelector('.m-nombre').textContent + ' → ' + etiqueta(k, acciones[k]); ul.appendChild(li);
      quitar(k);
    });
    g.appendChild(ul); bloque.appendChild(g);
    bloque.querySelector('h2').textContent = t('espera-titulo').replace('{n}', bloque.querySelectorAll('li').length);
  }
  // Un envío lleva su número: si la conexión se corta o tarda de más (el sitio dormido tarda en despertar, y lo que está
  // delante puede cortar la espera mientras el envío sigue), la pantalla pregunta cómo terminó en vez de quedarse colgada.
  var LENTO_MS = 15000, TOPE_MS = 150000, CADA_MS = 4000, PREGUNTAS = 45;
  function terminar(j, ks, acciones) {
    var estado = barra.querySelector('.m-estado');
    enviando = false;
    estado.textContent = '';
    // primero lo decidido, que se lleva su título; después lo demás que salió de la lista
    aDecididas(j && j.decididas);
    // las que el sitio salteó ya no están por decidir (decididas en otro lado, o ya en un pedido): salen de la lista
    ((j && j.omitidas) || []).forEach(quitar);
    // nada quedaba por enviar: lo elegido ya estaba decidido o en un pedido; recargar traería la misma foto vieja
    if (j && j.codigo === 'nada_que_enviar') { ks.forEach(quitar); estado.textContent = t('ya-enviado'); pintar(); return; }
    if (j && j.ok && j.demo && j.loQuePasaria) {
      estado.appendChild(document.createTextNode(t('demo') + ' '));
      (j.loQuePasaria.archivos || []).forEach(function (x) { var c = document.createElement('code'); c.textContent = String(x.archivo || ''); estado.appendChild(c); estado.appendChild(document.createTextNode(' ')); });
      pintar();
      return;
    }
    // ya estaba hecho: no es un error, la ficha sale y se dice
    if (j && j.codigo === 'ya_decidida') { estado.textContent = j.message || t('ya-enviado'); pintar(); return; }
    if (j && j.codigo === 'aplicado') {
      (j.enviadas || ks).forEach(quitar);
      estado.textContent = t('aplicado');
      pintar();
      return;
    }
    // un pedido abierto con lo mismo: ya está esperando aprobación
    if (j && (j.ok || (j.codigo === 'pedido_abierto' && j.enlace))) {
      aEspera(j, j.enviadas || ks, acciones);
      estado.textContent = t('ok').replace('{numero}', j.numero || '');
      pintar();
      return;
    }
    estado.textContent = t('error').replace('{motivo}', (j && j.message) || '');
    pintar();
  }
  // sin respuesta del envío: el sitio sabe cómo terminó por su número; si no lo sabe (se reinició), la lista dice si las
  // elegidas ya no esperan decisión
  function averiguar(id, ks, acciones, n) {
    var estado = barra.querySelector('.m-estado');
    estado.textContent = t('verificando');
    fetch('/api/hallazgos/envio?id=' + encodeURIComponent(id), { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (e) {
        if (e && e.estado === 'listo' && e.resultado) { terminar(e.resultado, ks, acciones); return; }
        if (e && e.estado === 'desconocido') { porLaLista(ks); return; }
        if (n >= PREGUNTAS) { enviando = false; estado.textContent = t('no-llego'); pintar(); return; }
        setTimeout(function () { averiguar(id, ks, acciones, n + 1); }, CADA_MS);
      })
      .catch(function () {
        if (n >= PREGUNTAS) { enviando = false; estado.textContent = t('no-llego'); pintar(); return; }
        setTimeout(function () { averiguar(id, ks, acciones, n + 1); }, CADA_MS);
      });
  }
  function porLaLista(ks) {
    var estado = barra.querySelector('.m-estado');
    fetch('/api/hallazgos', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (m) {
        enviando = false;
        if (!m || !Array.isArray(m.toca)) { estado.textContent = t('no-llego'); pintar(); return; }
        var siguen = {};
        m.toca.forEach(function (x) { siguen[x.fuente + '/' + x.id] = true; });
        var faltan = ks.filter(function (k) { return siguen[k]; });
        if (faltan.length) { estado.textContent = t('no-llego'); pintar(); return; }
        aDecididas((m.decididas || []).filter(function (x) { return ks.indexOf(x.fuente + '/' + x.id) >= 0; }).map(function (x) { return { clave: x.fuente + '/' + x.id, accion: x.accion, quien: x.quien, el: x.el }; }));
        ks.forEach(quitar);
        estado.textContent = t('ya-enviado');
        pintar();
      })
      .catch(function () { enviando = false; estado.textContent = t('no-llego'); pintar(); });
  }
  barra.querySelector('.m-enviar').addEventListener('click', function () {
    var ks = Object.keys(elecciones);
    if (!ks.length || faltaMotivo()) return;
    var estado = barra.querySelector('.m-estado');
    enviando = true; estado.textContent = t('enviando'); pintar();
    var acciones = {};
    ks.forEach(function (k) { acciones[k] = elecciones[k]; });
    var decisiones = ks.map(function (k) {
      var i = k.indexOf('/');
      var d = { fuente: k.slice(0, i), id: k.slice(i + 1), accion: acciones[k] };
      if (acciones[k] === 'reject') d.motivo = motivoDe(k);
      return d;
    });
    var id = 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
    var corte = typeof AbortController === 'function' ? new AbortController() : null;
    var lento = setTimeout(function () { if (enviando) estado.textContent = t('lento'); }, LENTO_MS);
    var tope = setTimeout(function () { if (corte) corte.abort(); }, TOPE_MS);
    var listo = function () { clearTimeout(lento); clearTimeout(tope); };
    fetch('/api/hallazgos/confirmar', { method: 'POST', credentials: 'same-origin', signal: corte ? corte.signal : undefined, headers: { 'content-type': 'application/json', 'x-site-token': s.getAttribute('data-token') || '' }, body: JSON.stringify({ envio: id, decisiones: decisiones }) })
      .then(function (r) {
        listo();
        // lo que está delante del sitio cortó la espera (un 502 o 504, sin el JSON del sitio): el envío puede seguir
        return r.json().catch(function () { return null; });
      })
      .then(function (j) { if (j) terminar(j, ks, acciones); else averiguar(id, ks, acciones, 0); })
      .catch(function () { listo(); averiguar(id, ks, acciones, 0); });
  });
  pintar();
})();
`;

module.exports = { crearRutas, crearDecididas, CLIENTE, CARPETAS_VIVAS };
