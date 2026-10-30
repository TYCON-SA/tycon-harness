'use strict';
/*
 * tabs/runs.js — LA PESTAÑA CORRIDAS DEL SITIO DE LA ORGANIZACIÓN.
 *
 * Qué resuelve: todo lo de la vista de corridas (scripts/nightly/dashboard/runs.js) —la cabecera, las fichas, los
 * gráficos, la tabla y el detalle de cada corrida con sus cambios— en el sitio, para cada persona sólo lo suyo. Quien
 * mantiene ve todas; un dev, las de sus máquinas confirmadas. El filtro lo hace el SERVIDOR antes de armar cada
 * respuesta: al navegador nunca llega lo que no puede ver.
 *
 * UN SOLO CÓDIGO: el modelo es `modelo()` de runs.js, la página son sus `cabecera`, `ejecutiva`, `tabla` y
 * `pie`, y el cliente es su `CLIENTE`, servido como archivo. Acá no se lee ningún volcado ni conversación: sólo el modelo.
 *
 * EL ARMADO: en un hilo aparte (`worker_threads`), así el hilo principal nunca lee el espejo y `/healthz` y
 * las otras pestañas contestan mientras arma (medido con 551 corridas: 34 s y 690 MB de pico). Se rearma
 * cuando el refresco de las fuentes deja el espejo distinto (la huella de nombres, tamaños y fechas); mientras rearma, y si
 * el rearmado falla (también por memoria), se sirve el modelo anterior ENTERO, con su hora, y una banda lo dice. Sin
 * modelo todavía: «cargando» (503 con Retry-After); sin modelo y con el armado fallado: 503 con el código del error,
 * nunca un mensaje con rutas. Los textos (cambios y parches) quedan en el disco del sitio, uno por corrida: en memoria
 * vive el modelo sin ellos.
 *
 * LA VISTA GUARDADA: con disco del sitio (`SITE_DATA_DIR`), cada armado bueno deja `runs-view.json` (el modelo como se
 * sirve, el mapa de textos a demanda y lo informado por las máquinas en la misma bajada entera; sin textos ni huella).
 * Lo escribe el hilo del armado a un temporal y el principal lo renombra cuando pone el modelo nuevo. Al arrancar se lee
 * en un hilo aparte y, si todavía no hay un armado de este arranque, se sirve con su fecha: un reinicio no deja la
 * pestaña en «cargando». La guardada se filtra con lo informado guardado con ella y con todo lo demás de hoy; sus textos
 * vuelven con el armado nuevo. Un archivo que no cierra no se sirve, y el registro lo dice.
 *
 * LO QUE VIAJA: la lista (`paraLista`, lista blanca) con la página; el detalle al abrir una corrida; los
 * textos al abrir un cambio. Una corrida que no es tuya, una sin máquina o un id que no existe contestan IGUAL: 404 sin
 * cuerpo.
 *
 * Rutas (todas `person`, que incluye a quien mantiene): GET /corridas (la página) · GET /api/corridas (la lista)
 * · GET /api/corridas/:id (el detalle) · GET /api/corridas/:id/textos ({ texto, textoGit }: gzip en base64) ·
 * GET /corridas/cliente.js · GET /corridas/vista.css. Casos: scripts/tests/site-runs.test.js.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const RUNS = path.join(__dirname, '..', '..', 'nightly', 'dashboard', 'runs.js');
const FRASE_FALLA = 'no se pudo armar la vista de ejecuciones';
// el caché de los textos bajados a demanda (los cambios de una corrida resumida): al pasarlo, se borran los más viejos
const TOPE_CACHE_BYTES = 200 * 1024 * 1024;
const FRASE_SIN_BUZON = 'sin buzón configurado: no medido';
// la vista guardada en el disco del sitio, y el número de su forma: cambia cuando cambia lo que se guarda
const ARCHIVO_VISTA = 'runs-view.json';
const FORMATO_VISTA = 1;
const NO_EXISTE = { status: 404, tipo: 'text/plain; charset=utf-8', cuerpo: '' };
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
// el código de un error, con forma de código: nunca su mensaje (trae rutas del disco)
const codigoDe = (e) => { const c = e && (e.code || e.codigo); return typeof c === 'string' && /^[A-Z0-9_]{1,40}$/.test(c) ? c : 'ERROR'; };
const hora = (iso) => String(iso || '').slice(0, 16).replace('T', ' ');

/**
 * La huella del espejo: nombre, tamaño y fecha de cada archivo hasta dos niveles (`<máquina>/<archivo>`), y del umbral
 * de la organización. Igual huella, mismo modelo: no se rearma.
 */
function huellaDelEspejo(dir, extra = []) {
  const h = crypto.createHash('sha256');
  // las carpetas no cuentan por su fecha (cambia al agregar o borrar adentro; lo de adentro ya se anota uno por uno)
  const anotar = (ruta, nombre) => { try { const st = fs.statSync(ruta); h.update(st.isDirectory() ? `${nombre}\0d\n` : `${nombre}\0${st.size}\0${st.mtimeMs}\n`); } catch (e) { h.update(`${nombre}\0${(e && e.code) || 'error'}\n`); } };
  // los archivos de la raíz que empiezan con «.» los reescribe la bajada en cada pasada (las uniones de carpetas, con
  // escritura atómica: fecha nueva aunque no cambie nada). Cuentan por su CONTENIDO, nunca por su fecha
  const porContenido = (ruta, nombre) => { try { h.update(`${nombre}\0${crypto.createHash('sha256').update(fs.readFileSync(ruta)).digest('hex')}\n`); } catch (e) { h.update(`${nombre}\0${(e && e.code) || 'error'}\n`); } };
  let raiz = [];
  try { raiz = fs.readdirSync(dir).sort(); } catch (e) { h.update(`sin espejo\0${(e && e.code) || 'error'}`); }
  for (const n of raiz) {
    const ruta = path.join(dir, n);
    if (n.startsWith('.')) { let esArchivo = false; try { esArchivo = fs.statSync(ruta).isFile(); } catch { /* lo anota abajo */ } if (esArchivo) { porContenido(ruta, n); continue; } }
    anotar(ruta, n);
    let hijos = [];
    try { if (fs.statSync(ruta).isDirectory()) hijos = fs.readdirSync(ruta).sort(); } catch { /* ya quedó anotado */ }
    for (const f of hijos) anotar(path.join(ruta, f), `${n}/${f}`);
  }
  for (const f of extra) anotar(f, f);
  return h.digest('hex');
}

/**
 * El armado, en el hilo donde corre: el modelo de runs.js desde el espejo, sin registro propio, sin unificar productos
 * (eso va por persona). Los textos de cada corrida van a `textosDir/<id>.json`; vuelve el modelo sin ellos
 * y el pico de memoria del proceso.
 */
async function armarEnElHilo({ buzon, skillsDir = null, sinHilos = false, umbralesArchivo = null, textosDir, guardarEn = null, informados = null }) {
  const runs = require(RUNS);
  const vacia = fs.mkdtempSync(path.join(os.tmpdir(), 'site-corridas-sin-registro-'));
  fs.mkdirSync(textosDir, { recursive: true });
  // las corridas cuyos cambios salieron de su resumen (la conversación ya no está en el disco): sus textos se bajan
  // a demanda, cuando alguien abre los cambios. Del volcado de cada una, sólo la ruta, y sólo del lado del servidor
  const aDemanda = {};
  // cada corrida escribe sus textos apenas se arma: juntarlos todos antes duplicaba el pico de memoria
  const alTexto = (c, t) => {
    if (t.texto || t.textoGit) fs.writeFileSync(path.join(textosDir, `${c.id}.json`), JSON.stringify(t));
    else if (c.cambios && c.cambios.estado === 'leido' && c._volcado) aDemanda[c.id] = c._volcado;
  };
  let M;
  try { M = runs.modelo(vacia, { buzon, soloBuzon: true, sinUnificar: true, sinHilos, umbralesArchivo, skillsDir, alTexto }); }
  finally { fs.rmSync(vacia, { recursive: true, force: true }); }
  M.corridas = M.corridas.map(runs.paraDetalle);
  // la vista para el próximo arranque, a un temporal: el hilo principal la pone en su lugar cuando sirve este modelo. No
  // poder escribirla no tumba el armado: vuelve su código, y lo escrito a medias se borra
  let guardadaError = null;
  if (guardarEn) {
    try { fs.writeFileSync(guardarEn, JSON.stringify({ formato: FORMATO_VISTA, generado: M.generado, ejecuciones: M, aDemanda, informados }), { mode: 0o600 }); }
    catch (e) {
      guardadaError = codigoDe(e);
      try { fs.rmSync(guardarEn, { force: true }); } catch { /* el hilo principal lo vuelve a intentar */ }
    }
  }
  const uso = typeof process.resourceUsage === 'function' ? process.resourceUsage() : null;
  // maxRSS viene en kilobytes: es el pico del PROCESO (el armado es lo que más pesa)
  const pico = uso && Number.isFinite(uso.maxRSS) ? Math.round(uso.maxRSS / 1024) : Math.round(process.memoryUsage().rss / 1048576);
  return { M, pico_mb: pico, aDemanda, guardadaError };
}

/**
 * El armado en un `worker_threads` con un techo de memoria y uno de tiempo: se cae él, nunca el sitio. Un armado colgado
 * (sin llegar al techo de memoria) se corta a los `tiempoMs` (10 minutos): sin eso, la pestaña no volvería a armar nunca.
 */
function armarEnWorker(opts) {
  return new Promise((resolve, reject) => {
    let listo = false;
    // el hilo no hereda el freno del modo demo: lo pone él mismo con la carpeta del proceso (demo-guard.js)
    const w = new Worker(__filename, { workerData: { __armarCorridas: true, __frenoDemo: frenoDemo(), ...opts }, resourceLimits: { maxOldGenerationSizeMb: opts.memoriaMb || 768 } });
    const fin = (fn, x) => { if (listo) return; listo = true; clearTimeout(corte); fn(x); };
    const corte = setTimeout(() => { fin(reject, Object.assign(new Error(FRASE_FALLA), { code: 'TIEMPO_AGOTADO' })); w.terminate(); }, opts.tiempoMs || 600000);
    if (corte.unref) corte.unref();
    w.once('message', (m) => (m && m.error ? fin(reject, Object.assign(new Error(FRASE_FALLA), { code: m.error })) : fin(resolve, m)));
    w.once('error', (e) => fin(reject, e));
    w.once('exit', (codigo) => fin(reject, Object.assign(new Error(FRASE_FALLA), { code: `SALIDA_${codigo}` })));
  });
}

/** El freno del modo demo de este proceso (`{ dir }`), o null: se lo pasa a cada hilo aparte. */
const frenoDemo = () => { const f = require('../demo-guard.js').frenoActual(); return f ? { dir: f.dir } : null; };

/**
 * La vista guardada, leída en un hilo aparte (pesa decenas de MB y su JSON.parse trabaría las sondas): el objeto tal
 * cual, o un error con su código (`ENOENT` si no hay). La forma la valida `vistaUsable`.
 */
function leerVistaEnWorker(archivo, { tiempoMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    let listo = false;
    const w = new Worker(__filename, { workerData: { __leerVista: true, __frenoDemo: frenoDemo(), archivo } });
    const fin = (fn, x) => { if (listo) return; listo = true; clearTimeout(corte); fn(x); };
    const corte = setTimeout(() => { fin(reject, Object.assign(new Error('lectura'), { code: 'TIEMPO_AGOTADO' })); w.terminate(); }, tiempoMs);
    if (corte.unref) corte.unref();
    w.once('message', (m) => (m && m.error ? fin(reject, Object.assign(new Error('lectura'), { code: m.error })) : fin(resolve, m && m.vista)));
    w.once('error', (e) => fin(reject, e));
    w.once('exit', (codigo) => fin(reject, Object.assign(new Error('lectura'), { code: `SALIDA_${codigo}` })));
  });
}

const FECHA_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;
/**
 * ¿La vista guardada se puede servir? `{ ok, vista }` con el mapa a demanda sólo con rutas dentro del buzón, o
 * `{ ok: false, motivo }` (una frase fija, sin rutas).
 */
function vistaUsable(g, dirBuzon) {
  if (!isObject(g)) return { ok: false, motivo: 'no es un objeto' };
  if (g.formato !== FORMATO_VISTA) return { ok: false, motivo: 'es de otro formato' };
  if (typeof g.generado !== 'string' || !FECHA_ISO.test(g.generado)) return { ok: false, motivo: 'no trae la fecha del armado' };
  const M = g.ejecuciones;
  if (!isObject(M) || !Array.isArray(M.corridas)) return { ok: false, motivo: 'no trae las ejecuciones' };
  if (!M.corridas.every((c) => isObject(c) && typeof c.id === 'string' && /^[0-9a-f]{16}$/.test(c.id) && (c.maquina === null || c.maquina === undefined || typeof c.maquina === 'string'))) {
    return { ok: false, motivo: 'trae ejecuciones sin la forma esperada' };
  }
  if (g.informados !== null && g.informados !== undefined && !isObject(g.informados)) return { ok: false, motivo: 'trae lo informado sin la forma esperada' };
  // las rutas del mapa a demanda se copian del lado del servidor: sólo valen dentro del buzón del sitio
  const raiz = dirBuzon ? `${path.resolve(dirBuzon)}${path.sep}` : null;
  const aDemanda = {};
  let descartadas = 0;
  for (const [id, ruta] of Object.entries(isObject(g.aDemanda) ? g.aDemanda : {})) {
    if (raiz && /^[0-9a-f]{16}$/.test(id) && typeof ruta === 'string' && path.resolve(ruta).startsWith(raiz)) aDemanda[id] = ruta;
    else descartadas++;
  }
  return { ok: true, descartadas, vista: { generado: g.generado, M, aDemanda, informados: isObject(g.informados) ? g.informados : null } };
}

if (!isMainThread && workerData && workerData.__armarCorridas) {
  if (workerData.__frenoDemo) require('../demo-guard.js').ponerFreno(workerData.__frenoDemo);
  armarEnElHilo(workerData).then((r) => parentPort.postMessage(r)).catch((e) => parentPort.postMessage({ error: codigoDe(e) }));
}
if (!isMainThread && workerData && workerData.__leerVista) {
  if (workerData.__frenoDemo) require('../demo-guard.js').ponerFreno(workerData.__frenoDemo);
  try { parentPort.postMessage({ vista: JSON.parse(fs.readFileSync(workerData.archivo, 'utf8')) }); }
  catch (e) { parentPort.postMessage({ error: e instanceof SyntaxError ? 'JSON_ROTO' : codigoDe(e) }); }
}

/**
 * La vista de la pestaña: el modelo armado y su estado. `armar` se inyecta en las pruebas; `demora` (ms) estira el
 * armado para probar que el sitio contesta mientras tanto.
 */
function crearVista({ cfg, fuentes, armar = armarEnWorker, skillsDir = null, demora = 0, log = () => {}, ahora = Date.now,
  topeCacheBytes = TOPE_CACHE_BYTES, textosDeUna = (o) => require('../summaries.js').textosEnWorker({ ...o, skillsDir }),
  huellaDe = (dir, extra) => require('../summaries.js').huellaEnWorker({ dir, extra }), leerVista = leerVistaEnWorker }) {
  // los textos (los parches de cada corrida) van al disco del contenedor, nunca a SITE_DATA_DIR: son una copia que se
  // rearma, y el disco montado es chico. Los de antes (en el disco montado) se borran al arrancar
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'site-corridas-textos-'));
  if (cfg.dataDir) {
    try { fs.rmSync(path.join(cfg.dataDir, 'corridas-textos'), { recursive: true, force: true }); }
    catch (e) { log(`ejecuciones: no se pudieron borrar los textos viejos del disco del sitio (${codigoDe(e)})`); }
  }
  // los textos bajados a demanda, con su tope: al pasarlo se borran los que se abrieron hace más tiempo
  const dirCache = path.join(base, 'a-demanda');
  const st = { M: null, textosDir: null, huella: null, armando: null, error: null, pico_mb: null, sinBuzon: false, aDemanda: {}, enCurso: new Map(),
    guardada: null, leyendo: null, escribiendo: null };
  // la vista guardada vive en el disco del sitio: sin él, no se guarda ni se lee
  const archivoVista = cfg.dataDir ? path.join(cfg.dataDir, ARCHIVO_VISTA) : null;

  const conBuzon = () => { const c = fuentes.config(); return Boolean(c && isObject(c.site) && isObject(c.site.mailbox)); };
  const umbralesDeLaOrganizacion = () => {
    const ops = typeof fuentes.clones === 'function' ? fuentes.clones().operaciones : null;
    const f = ops && ops.dir ? path.join(ops.dir, 'scripts', 'nightly', 'dashboard', 'sources.json') : null;
    return f && fs.existsSync(f) ? f : null;
  };

  // las carpetas de textos de armados de ANTES de este arranque (un reinicio o un despliegue) no las sirve nadie: se borran.
  // Supone UNA réplica del sitio por SITE_DATA_DIR (como se despliega): dos réplicas sobre el mismo disco se
  // borrarían los textos entre sí (disponibilidad, no fuga)
  //    (antes del primer armado, y sin esperar a nadie: si no, la limpieza podría borrar la carpeta del armado nuevo)
  try { for (const n of fs.readdirSync(base)) fs.rmSync(path.join(base, n), { recursive: true, force: true }); } catch (e) { if (!e || e.code !== 'ENOENT') log(`ejecuciones: no se pudieron borrar los textos de un arranque anterior (${codigoDe(e)})`); }

  // la vista guardada: los temporales de un arranque anterior (una escritura cortada) se borran, nunca se leen; la
  // guardada entera se lee en un hilo aparte y se sirve sólo si todavía no hay un armado de este arranque
  if (archivoVista) {
    let temporales = [];
    try { temporales = fs.readdirSync(cfg.dataDir).filter((n) => n.startsWith(`${ARCHIVO_VISTA}.tmp-`)); }
    catch (e) { if (!e || e.code !== 'ENOENT') log(`ejecuciones: no se pudieron mirar los temporales de la vista guardada (${codigoDe(e)})`); }
    // uno por uno: el que no se puede borrar no deja a los demás
    for (const n of temporales) {
      try { fs.rmSync(path.join(cfg.dataDir, n), { force: true }); } catch (e) { log(`ejecuciones: no se pudo borrar un temporal de la vista guardada (${codigoDe(e)})`); }
    }
    st.leyendo = Promise.resolve()
      .then(() => leerVista(archivoVista))
      .then((g) => {
        const u = vistaUsable(g, fuentes.dirBuzon);
        if (!u.ok) { log(`ejecuciones: la vista guardada no se puede usar (${u.motivo}): se espera el armado`); return; }
        if (u.descartadas) log(`ejecuciones: la vista guardada trae ${u.descartadas} ruta(s) a demanda fuera del buzón: se descartan`);
        if (st.M) return;
        st.M = u.vista.M; st.aDemanda = u.vista.aDemanda; st.textosDir = null;
        st.guardada = { generado: u.vista.generado, informados: u.vista.informados };
        log(`ejecuciones: se sirve la vista guardada (${st.M.corridas.length} ejecuciones, armada el ${hora(u.vista.generado)} UTC) hasta el próximo armado`);
      }, (e) => {
        if (e && e.code === 'ENOENT') return;
        log(`ejecuciones: la vista guardada no se puede usar (${e && e.code === 'JSON_ROTO' ? 'JSON roto' : codigoDe(e)}): se espera el armado`);
      })
      .catch((e) => { log(`ejecuciones: la vista guardada no se pudo poner (${codigoDe(e)}): se espera el armado`); })
      .finally(() => { st.leyendo = null; });
  }

  /** El caché de textos a demanda dentro de su tope: se borran los abiertos hace más tiempo, nunca `salvo`. */
  function podarCache(salvo) {
    let lista = [];
    try { lista = fs.readdirSync(dirCache).map((f) => { const p = path.join(dirCache, f); const s = fs.statSync(p); return { p, t: s.mtimeMs, n: s.size }; }); }
    catch (e) { log(`ejecuciones: no se pudo mirar el caché de textos (${codigoDe(e)})`); return; }
    let total = lista.reduce((a, x) => a + x.n, 0);
    for (const x of lista.sort((a, b) => a.t - b.t)) {
      if (total <= topeCacheBytes) break;
      if (x.p === salvo) continue;
      try { fs.rmSync(x.p, { force: true }); total -= x.n; } catch (e) { log(`ejecuciones: no se pudo borrar un texto del caché (${codigoDe(e)})`); }
    }
  }

  /**
   * Los textos de una corrida resumida, a demanda: del caché si están; si no, baja su conversación y su cambio del
   * buzón a una carpeta temporal, los arma en un hilo aparte, los guarda en el caché y borra lo bajado. Dos pedidos de
   * la misma corrida a la vez comparten la bajada. null = no se pudieron bajar o armar (el registro dice por qué).
   */
  function aDemanda(id, volcado) {
    if (st.enCurso.has(id)) return st.enCurso.get(id);
    const p = (async () => {
      const cache = path.join(dirCache, `${id}.json`);
      try {
        const t = JSON.parse(fs.readFileSync(cache, 'utf8'));
        const ya = new Date(); fs.utimesSync(cache, ya, ya);   // abierto recién: es lo último que se poda
        return { texto: t.texto || null, textoGit: t.textoGit || null };
      } catch (e) { if (!e || e.code !== 'ENOENT') log(`ejecuciones: un texto del caché no se pudo leer (${codigoDe(e)}): se baja de nuevo`); }
      if (typeof fuentes.bajarCorrida !== 'function') { log('ejecuciones: las fuentes no saben bajar una ejecución del buzón'); return null; }
      const maquina = path.basename(path.dirname(volcado));
      const nombre = path.basename(volcado).replace(/\.json$/, '');
      const tmp = fs.mkdtempSync(path.join(base, 'bajando-'));
      try {
        fs.mkdirSync(path.join(tmp, maquina), { recursive: true });
        const copia = path.join(tmp, maquina, `${nombre}.json`);
        fs.copyFileSync(volcado, copia);
        const r = await fuentes.bajarCorrida({ maquina, base: nombre, dir: tmp });
        if (r.codigo !== 0) {
          if (r.res && r.res.estado === 'sin_partes') return { texto: null, textoGit: null };
          log(`ejecuciones: los cambios de una ejecución no se pudieron bajar del buzón (${(r.res && r.res.estado) || 'sin estado'}${r.res && r.res.motivo ? `: ${r.res.motivo}` : ''})`);
          return null;
        }
        const t = await textosDeUna({ volcado: copia });
        fs.mkdirSync(dirCache, { recursive: true });
        fs.writeFileSync(cache, JSON.stringify(t));
        podarCache(cache);
        return { texto: t.texto || null, textoGit: t.textoGit || null };
      } catch (e) {
        log(`ejecuciones: los cambios de una ejecución no se pudieron armar (${codigoDe(e)})`);
        return null;
      } finally {
        fs.rm(tmp, { recursive: true, force: true }, (e) => { if (e) log(`ejecuciones: no se pudo borrar lo bajado para un detalle (${codigoDe(e)})`); });
        st.enCurso.delete(id);
      }
    })();
    st.enCurso.set(id, p);
    return p;
  }

  /** El estado de la última bajada del buzón: `{ completo, generacion }` (unas fuentes sin la función: entera). */
  // `armable`: entera, o con todos los volcados y registros bajados y conversaciones pendientes (unas fuentes que no lo
  // dicen: lo mismo que `completo`)
  const bajada = () => {
    const b = typeof fuentes.buzonEstado === 'function' ? fuentes.buzonEstado() : { completo: true, generacion: 1 };
    return { ...b, armable: b.armable === undefined ? b.completo : b.armable };
  };

  /** ¿Armar ahora dejaría a medias una vista servida? (la bajada trae los registros, no todas las conversaciones) */
  const aMedias = () => Boolean(st.M) && !bajada().completo;

  function asegurar() {
    if (!fuentes.estado().cargado) return;
    st.sinBuzon = !conBuzon();
    if (st.sinBuzon || st.armando) return;
    // se arma SÓLO con una bajada entera: con una a medias, el espejo sería más nuevo que lo informado
    // por las máquinas, y una máquina que cambió de dueño mostraría corridas nuevas a su dueño anterior. Mientras tanto
    // se sirve el último armado, y la respuesta dice que puede faltar alguna corrida.
    if (!bajada().armable) return;
    // con una vista servida, un armado con conversaciones pendientes no la reemplaza: sin la conversación, el título, los
    // tiempos y el consumo de una ejecución irían y volverían entre recargas. Se espera a la pasada entera; sólo en
    // frío, sin vista, se arma a medias (2.77)
    if (aMedias()) {
      if (!st.esperaAvisada) { st.esperaAvisada = true; log('ejecuciones: la bajada trae conversaciones pendientes; se sigue sirviendo la vista anterior hasta la pasada entera, y la respuesta dice que puede faltar alguna ejecución'); }
      return;
    }
    st.esperaAvisada = false;
    // la bajada escribe el espejo: se arma cuando termine (avisa con el refresco)
    if (bajada().bajando) return;
    const umbralesArchivo = umbralesDeLaOrganizacion();
    // las conversaciones sólo cuentan con un disco del sitio: sin SITE_DATA_DIR, lo del hilo es «no medido»
    const sinHilos = !(typeof fuentes.hilos === 'function' && fuentes.hilos() && cfg.dataDir);
    // con la generación del espejo (sources.js) no hace falta recorrerlo: igual generación, mismo espejo. La clave suma
    // los umbrales de la organización (un archivo del clon, no del disco montado)
    if (typeof fuentes.espejoGeneracion === 'function') {
      let umbrales = '';
      if (umbralesArchivo) { try { umbrales = crypto.createHash('sha256').update(fs.readFileSync(umbralesArchivo)).digest('hex'); } catch (e) { umbrales = codigoDe(e); } }
      armarSiCambio(`gen:${fuentes.espejoGeneracion()}:${umbrales}${sinHilos ? ':sin-hilos' : ''}`, { sinHilos, umbralesArchivo });
      return;
    }
    // la huella recorre el espejo en el disco montado: en un hilo aparte (el principal contesta las sondas), una a la vez
    if (st.huellaEnCurso) return;
    st.huellaEnCurso = Promise.resolve()
      .then(() => huellaDe(fuentes.dirBuzon, umbralesArchivo ? [umbralesArchivo] : []))
      .then((h) => { st.huellaEnCurso = null; armarSiCambio(h + (sinHilos ? ':sin-hilos' : ''), { sinHilos, umbralesArchivo }); },
        (e) => { st.huellaEnCurso = null; log(`ejecuciones: no se pudo calcular la huella del espejo (${codigoDe(e)})`); });
  }

  function armarSiCambio(huella, { sinHilos, umbralesArchivo }) {
    // la huella tardó: si mientras tanto la bajada quedó a medias, no se arma (la misma regla de asegurar)
    if (st.armando || !bajada().armable || aMedias() || bajada().bajando) return;
    // el espejo volvió a ser el del modelo que se sirve: lo que falló después ya no vale para la banda
    if (huella === st.huella) {
      st.error = null; st.huellaFallida = null;
      // el espejo no cambió, pero la bajada sí puede: una entera que no trajo nada nuevo deja de deber pendientes
      if (st.guardada === null) { st.pendientes = bajada().completo ? 0 : bajada().pendientes || 0; st.generacion = bajada().generacion; }
      return;
    }
    // el mismo espejo ya fallado: no se repite (un armado que falla por memoria no se reintenta en cada pedido)
    if (huella === st.huellaFallida) return;
    const textosDir = path.join(base, `${ahora()}-${crypto.randomBytes(4).toString('hex')}`);
    // la vista para el próximo arranque, con lo informado de esta misma bajada entera (el armado corre sólo con una)
    const guardarEn = archivoVista ? `${archivoVista}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}` : null;
    const personas = typeof fuentes.personas === 'function' ? fuentes.personas() : null;
    const informados = personas && isObject(personas.informados) ? personas.informados : null;
    const t0 = ahora();
    const pendientes = bajada().completo ? 0 : bajada().pendientes || 0;
    const generacion = bajada().generacion;
    const borrar = (dir, para) => fs.rm(dir, { recursive: true, force: true }, (e) => { if (e) log(`ejecuciones: no se pudieron borrar los textos ${para} (${codigoDe(e)}): quedan en el disco del sitio`); });
    st.armando = (async () => {
      if (demora) await new Promise((r) => setTimeout(r, demora));
      return armar({ buzon: fuentes.dirBuzon, skillsDir, sinHilos, umbralesArchivo, textosDir, guardarEn, informados });
    })().then((r) => {
      const viejo = st.textosDir;
      st.M = r.M; st.textosDir = textosDir; st.huella = huella; st.error = null; st.huellaFallida = null; st.guardada = null;
      st.pendientes = pendientes; st.generacion = generacion;
      // la guardada pasa a ser esta: el temporal se pone en su lugar (un rename, atómico). Si falla (o el hilo no la pudo
      // escribir), el armado igual se sirve
      const sinGuardar = (codigo) => {
        log(`ejecuciones: no se pudo guardar la vista para el próximo arranque (${codigo})`);
        return fs.promises.rm(guardarEn, { force: true })
          .catch((e) => { log(`ejecuciones: no se pudo borrar el temporal de la vista guardada (${codigoDe(e)})`); });
      };
      if (guardarEn && r.guardadaError) st.escribiendo = sinGuardar(r.guardadaError).finally(() => { st.escribiendo = null; });
      else if (guardarEn) {
        st.escribiendo = fs.promises.rename(guardarEn, archivoVista)
          .catch((e) => sinGuardar(codigoDe(e)))
          .finally(() => { st.escribiendo = null; });
      }
      st.aDemanda = r.aDemanda && typeof r.aDemanda === 'object' ? r.aDemanda : {};
      st.pico_mb = Number.isFinite(r.pico_mb) ? r.pico_mb : null;
      // lo de abajo ya no puede marcar el armado como fallado: el modelo nuevo está puesto
      try {
        log(`ejecuciones: vista armada (${r.M.corridas.length} ejecuciones, ${Math.round((ahora() - t0) / 1000)} s, pico ${st.pico_mb === null ? '¿?' : st.pico_mb} MB)`);
        if (viejo && viejo !== textosDir) borrar(viejo, 'del armado anterior');
      } catch { /* el registro no tumba el armado */ }
    }, (e) => {
      // el anterior queda entero; la próxima vez que cambie el espejo se vuelve a intentar
      st.error = { codigo: codigoDe(e), desde: new Date(ahora()).toISOString() };
      st.huellaFallida = huella;
      borrar(textosDir, 'del armado fallado');
      // la guardada no se toca: el temporal de este armado, si llegó a escribirse, se borra
      if (guardarEn) fs.rm(guardarEn, { force: true }, (e2) => { if (e2) log(`ejecuciones: no se pudo borrar el temporal de la vista guardada (${codigoDe(e2)})`); });
      log(`ejecuciones: ${FRASE_FALLA} (${st.error.codigo}${st.error.codigo === 'EDEMO_FRENO' ? ': lo frenó el freno del sitio demo, un hilo quiso salir o escribir afuera' : ''})`);
    }).finally(() => { st.armando = null; });
  }

  if (typeof fuentes.alRefrescar === 'function') fuentes.alRefrescar(asegurar);
  // mientras se arma (y se calcula la huella del espejo), la bajada no escribe el espejo
  if (typeof fuentes.alArmar === 'function') fuentes.alArmar(() => Boolean(st.armando || st.huellaEnCurso));
  asegurar();

  return {
    asegurar,
    /** Espera el armado en curso (nunca rechaza). */
    listo: async () => {
      await (st.leyendo || Promise.resolve()).catch(() => {});
      await (st.huellaEnCurso || Promise.resolve()).catch(() => {});
      await (st.armando || Promise.resolve()).catch(() => {});
      await (st.escribiendo || Promise.resolve()).catch(() => {});
    },
    /** Espera la lectura de la vista guardada en curso (nunca rechaza): el primer pedido no dice «cargando» en vano. */
    leida: () => st.leyendo || Promise.resolve(),
    armando: () => Boolean(st.armando || st.huellaEnCurso),
    /**
     * ¿Viene un armado? El armado en curso, o la huella del espejo que lo puede disparar. Con el armado de este espejo
     * fallado, la huella que se vuelve a calcular en cada pedido no trae nada nuevo: no cuenta.
     */
    viene: () => Boolean(st.armando || (st.huellaEnCurso && !st.error)),
    estado: () => ({ generado: st.M ? st.M.generado : null, pico_mb: st.pico_mb, error: st.error, sinBuzon: st.sinBuzon, guardada: st.guardada ? { generado: st.guardada.generado } : null }),
    modelo: () => st.M,
    /** La vista guardada que se sirve (`{ generado, informados }`), o null si lo que se sirve es un armado de este arranque. */
    guardada: () => st.guardada,
    bajada,
    /** Las conversaciones que le faltaban al armado que se sirve (la guardada: 0, no se sabe de su bajada). */
    pendientes: () => (st.M && st.guardada === null ? st.pendientes || 0 : 0),
    /** ¿La vista servida es de una bajada anterior y espera una entera para rearmarse? (mientras, puede faltar alguna corrida) */
    esperaLaBajada: () => aMedias() && st.generacion !== bajada().generacion,
    /** La carpeta de los textos del modelo que se sirve (las pruebas la miran). */
    textosDir: () => st.textosDir,
    /** La carpeta de los textos bajados a demanda (las pruebas la miran). */
    dirCache: () => dirCache,
    /**
     * Los textos de una corrida: `{ texto, textoGit }` (null = la corrida no los tiene), `{ pendiente: true }` si se sirve
     * la vista guardada (sus textos vuelven con el armado nuevo), o null si no se pudieron leer.
     */
    async textos(id) {
      if (!/^[0-9a-f]{16}$/.test(id)) return { texto: null, textoGit: null };
      if (!st.textosDir) {
        if (st.aDemanda[id]) return aDemanda(id, st.aDemanda[id]);
        return st.guardada ? { pendiente: true } : { texto: null, textoGit: null };
      }
      let crudo;
      try { crudo = fs.readFileSync(path.join(st.textosDir, `${id}.json`), 'utf8'); } catch (e) {
        if (e && e.code === 'ENOENT') return st.aDemanda[id] ? aDemanda(id, st.aDemanda[id]) : { texto: null, textoGit: null };   // sin texto: el armado no escribió archivo
        log(`ejecuciones: los textos de una ejecución no se pudieron leer del disco del sitio (${codigoDe(e)})`);
        return null;
      }
      try { const t = JSON.parse(crudo); return { texto: t.texto || null, textoGit: t.textoGit || null }; } catch {
        log('ejecuciones: los textos de una ejecución están ilegibles en el disco del sitio (JSON roto)');
        return null;
      }
    },
  };
}

/** Las rutas de la pestaña, para `rutasExtra` de crearSitio. */
function crearRutas({ cfg, fuentes, version = null, skillsDir = null, armar, demora = 0, log = () => {}, ahora = Date.now, topeCacheBytes = null } = {}) {
  const runs = require(RUNS);
  const access = require('../access.js');
  const views = require('../views.js');
  const { t: tx } = require('../texts.js');
  const idiomaDe = (ctx) => views.idiomaDe(ctx);
  const vista = crearVista({ cfg, fuentes, armar, skillsDir, demora, log, ahora, ...(topeCacheBytes ? { topeCacheBytes } : {}) });
  const json = (status, obj, extra) => ({ status, tipo: 'application/json; charset=utf-8', cuerpo: JSON.stringify(obj), ...(extra ? { extra } : {}) });
  const texto = (status, t, extra) => ({ status, tipo: 'text/plain; charset=utf-8', cuerpo: t, ...(extra ? { extra } : {}) });
  // lo que arma el sitio alrededor de la vista sale del idioma del pedido; el cuerpo lo arma la vista de la noche, que
  // todavía es sólo castellano
  const pagina = (ctx, cuerpo, status = 200, extra) => ({ status, tipo: 'text/html; charset=utf-8', cuerpo: views.layout(ctx, tx(idiomaDe(ctx), 'pestana.corridas'), cuerpo, tx(idiomaDe(ctx), 'corridas.lede')), ...(extra ? { extra } : {}) });
  const gris = (ctx, t) => `<div class="tile blind"><div class="t-label">${runsEsc(tx(idiomaDe(ctx), 'pestana.corridas'))}</div><div class="t-val">${runsEsc(tx(idiomaDe(ctx), 'corridas.falta'))}</div><div class="t-den">${runsEsc(t)}</div></div>`;
  const runsEsc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  /**
   * ¿Hay algo por esperar? Un armado en curso, una pasada que cortó y ya sigue, o la bajada todavía no entera con la
   * fuente sin fallar. Con la fuente del buzón fallando (la banda de las fuentes ya lo dice) o sin buzón, no.
   */
  const esperando = () => {
    if (vista.estado().sinBuzon) return false;
    if (vista.viene() || vista.bajada().siguiendo) return true;
    const ef = typeof fuentes.estado === 'function' ? fuentes.estado() : null;
    return !vista.bajada().armable && !(ef && ef.bandaRefresco);
  };
  // la guardada se filtra con lo informado guardado con ella (la misma foto) y con todo lo demás de hoy: un objeto por
  // par, para que lo filtrado por persona no se rehaga en cada pedido
  // (las fuentes pueden cambiar un campo en el mismo objeto de personas, como repos.json: se compara campo por campo)
  let personasDeLaGuardada = { de: null, guardada: null, foto: null, valor: null };
  const mismosCampos = (a, b) => {
    const ka = Object.keys(a || {}); const kb = Object.keys(b || {});
    return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
  };
  const personasPara = (personas, guardada) => {
    if (!guardada) return personas;
    const p = personasDeLaGuardada;
    if (p.de !== personas || p.guardada !== guardada || !mismosCampos(p.foto, personas)) {
      personasDeLaGuardada = { de: personas, guardada, foto: { ...(personas || {}) }, valor: { ...(personas || { repos: null }), informados: guardada.informados } };
    }
    return personasDeLaGuardada.valor;
  };

  /** Lo que puede ver quien pide, o la respuesta que va en su lugar (`{ falla }`). */
  // lo armado para cada persona, por modelo de la vista: se va solo cuando el armado deja un modelo nuevo
  const guardados = new WeakMap();
  function loSuyo(ctx, esApi) {
    vista.asegurar();
    const e = vista.estado();
    if (e.sinBuzon) return { sinBuzon: true };
    const M = vista.modelo();
    if (!M) {
      if (e.error) {
        const t = tx(idiomaDe(ctx), 'corridas.fallaCodigo', { codigo: e.error.codigo });
        return { falla: esApi ? texto(503, t) : pagina(ctx, `<p class="lede">${runsEsc(t)}.</p>`, 503) };
      }
      // nunca hubo una bajada entera y la fuente dice por qué (credencial rechazada, sin red…): «no medido», no «cargando»
      // (y lo mismo sin armado y con la última bajada a medias: no se va a armar hasta una entera, así que no es «cargando»)
      const c = fuentes.modelo() && fuentes.modelo().corridas;
      // todavía cargando (la primera lectura del buzón no terminó, o una pasada que cortó ya sigue, o se está armando): la
      // pestaña lo dice y se recarga sola; las demás pestañas del sitio ya se ven (la espera es por fuente)
      if ((c && c.codigo === 'cargando') || vista.bajada().siguiendo || vista.armando()) {
        const t = tx(idiomaDe(ctx), 'corridas.cargando');
        return { falla: esApi ? texto(503, t, { 'Retry-After': '5' }) : { status: 503, tipo: 'text/html; charset=utf-8', cuerpo: views.layout({ ...ctx, recargar: 5 }, tx(idiomaDe(ctx), 'pestana.corridas'), `<p class="lede">${runsEsc(t)}.</p>`), extra: { 'Retry-After': '5' } } };
      }
      const sinArmar = !vista.armando() && !vista.bajada().armable;
      if ((vista.bajada().generacion === 0 && c && c.estado === 'no_medido' && c.codigo) || sinArmar) {
        const t = c && c.codigo ? tx(idiomaDe(ctx), 'corridas.buzonIncompletoCodigo', { codigo: c.codigo }) : tx(idiomaDe(ctx), 'corridas.buzonIncompleto');
        return { falla: esApi ? texto(503, t, { 'Retry-After': '60' }) : pagina(ctx, gris(ctx, t)) };
      }
      return { falla: esApi ? texto(503, '', { 'Retry-After': '10' }) : { status: 503, tipo: 'text/html; charset=utf-8', cuerpo: views.paginaCargando(ctx), extra: { 'Retry-After': '10' } } };
    }
    // lo de cada persona se filtra una vez por armado y por datos de fondo, no en cada clic: la configuración y el modelo
    // se reemplazan enteros al refrescar, y de las personas cambian sus dos partes
    const config = fuentes.config(); const modeloFondo = fuentes.modelo();
    const personas = personasPara(typeof fuentes.personas === 'function' ? fuentes.personas() : null, vista.guardada());
    // la vista servida que espera una bajada entera dice, como la bajada a medias, que puede faltar alguna corrida
    const completo = Boolean(vista.bajada().armable) && !(typeof vista.esperaLaBajada === 'function' && vista.esperaLaBajada());
    const pendientes = completo ? vista.pendientes() : 0;
    const deps = [config, modeloFondo, personas, personas && personas.informados, personas && personas.repos, completo, pendientes];
    let porPersona = guardados.get(M);
    if (!porPersona) { porPersona = new Map(); guardados.set(M, porPersona); }
    const clave = `${ctx.quien.rol}\0${ctx.quien.email || ''}`;
    let g = porPersona.get(clave);
    if (!g || g.deps.some((d, i) => d !== deps[i])) {
      const reglas = access.crearReglas({ config, modelo: modeloFondo, personas });
      const vis = access.filtrarCorridas(M, ctx.quien, reglas);
      // el grupo del filtro, con los productos de repos.json, sobre los nombres ya unificados de lo que ve
      if (vis) runs.agruparRepos(vis.corridas, personas && personas.repos);
      // la última bajada no terminó entera: se sirve el último armado entero, y la respuesta dice que puede faltar alguna
      if (vis && !completo) vis.buzon = { ...(vis.buzon || { estado: 'leido' }), parcial: true, ...(ctx.quien.rol === 'maintainer' ? { incompleto: true } : {}) };
      // armada con conversaciones que quedaron para la pasada siguiente: las corridas están, y la banda dice cuánto falta
      if (vis && pendientes > 0) vis.buzon = { ...(vis.buzon || { estado: 'leido' }), pendientes };
      g = { deps, vis, salidas: {} };
      porPersona.set(clave, g);
    }
    return { vis: g.vis, error: e.error, salidas: g.salidas, guardada: vista.guardada() };
  }

  // sin buzón no hay corridas de nadie: se dice «no medido» (no es el 404 de «no es tuya», que no puede contar nada)
  const SIN_BUZON = texto(404, FRASE_SIN_BUZON);
  const corrida = (vis, id) => (vis && /^[0-9a-f]{16}$/.test(String(id)) ? vis.corridas.find((c) => c.id === id) || null : null);

  const rutas = [
    {
      method: 'GET', path: '/corridas', needs: ['maintainer', 'person'], pestana: { id: 'corridas', titulo: 'Ejecuciones', orden: 20 }, handler: async (ctx) => {
        await vista.leida();
        const r = loSuyo(ctx, false);
        if (r.sinBuzon) return pagina(ctx, gris(ctx, tx(idiomaDe(ctx), 'corridas.sinBuzon')));
        if (r.falla) return r.falla;
        const V = r.vis;
        // la guardada, mientras hay algo por esperar: lo dice una banda y la página se recarga sola cada 60 s. Con el
        // armado de este arranque fallado sale la banda del rearmado (con la fecha de la guardada) y no se recarga
        const conBandaGuardada = Boolean(r.guardada) && !r.error && esperando();
        const marco = conBandaGuardada ? { ...ctx, recargar: 60 } : ctx;
        // el cuerpo de la página se arma una vez por persona y por modelo; el marco (pestañas, bandas) va en cada pedido
        const idioma = idiomaDe(ctx);
        const llave = `pagina\0${idioma}\0${r.error ? `${r.error.codigo}\0${r.error.desde}` : ''}\0${conBandaGuardada ? 'guardada' : ''}`;
        if (r.salidas[llave]) return pagina(marco, r.salidas[llave]);
        const opts = { sitio: { rol: ctx.quien.rol, version }, idioma };
        const rearmado = r.error ? `<div class="banda gris"><b>${runsEsc(tx(idioma, 'corridas.rearmado', { desde: hora(r.error.desde), codigo: r.error.codigo }))}</b>${runsEsc(tx(idioma, 'corridas.rearmadoSeMuestra', { generado: hora(V.generado) }))}</div>`
          : conBandaGuardada ? `<div class="banda gris"><b>${runsEsc(tx(idioma, 'corridas.guardada', { generado: hora(r.guardada.generado) }))}</b></div>` : '';
        // las fichas de Corridas del tablero nocturno (de la organización: sólo quien mantiene), entre el resumen y la
        // tabla; salen del mismo modelo de fichas que Arnés y Proyectos. Sin fichas todavía (el primer refresco), lo dice como
        // Arnés; vacía sólo si se ocultaron todas desde Configuración
        const modeloFondo = fuentes.modelo() || {};
        const esQuienMantiene = ctx.quien.rol === 'maintainer';
        const [grilla] = esQuienMantiene ? require('./cards.js').seccionesDe(modeloFondo.fichas, 'corridas', { sinPreguntas: true, idioma }) : [];
        const fichasTablero = !esQuienMantiene ? ''
          : modeloFondo.fichas == null ? `<p class="q-note" id="fichas-calculando">${runsEsc(tx(idioma, 'fichas.calculando'))}</p>`
            : (grilla ? `<div id="fichas-corridas"><p class="q-note">${runsEsc(tx(idioma, 'corridas.fichasDeLaNoche'))}</p>${grilla.html}</div>` : '');
        const cuerpo = `<link rel="stylesheet" href="/corridas/vista.css"><div class="corridas">${rearmado}${runs.cabecera(V, opts)}\n${runs.ejecutiva(V, opts)}\n${fichasTablero}${runs.tabla(V, opts)}\n${runs.pie(V, opts)}</div>`
          + `<div id="fuente-corridas" data-api="/api/corridas" data-generado="${runsEsc(V.generado)}" hidden></div>${runs.bloqueDeTextos(idioma)}<script src="/corridas/cliente.js"></script>`;
        r.salidas[llave] = cuerpo;
        return pagina(marco, cuerpo);
      },
    },
    {
      method: 'GET', path: '/api/corridas', needs: ['maintainer', 'person'], handler: async (ctx) => {
        await vista.leida();
        const r = loSuyo(ctx, true);
        if (r.sinBuzon) return json(200, { estado: 'no_medido', motivo: tx(idiomaDe(ctx), 'corridas.sinBuzon'), corridas: [] });
        if (r.falla) return r.falla;
        // las frases de la casa que trae el modelo, en el idioma del pedido (una lista por idioma)
        const idioma = idiomaDe(ctx);
        const llave = `lista\0${idioma}`;
        // la guardada lo dice, con la fecha de su armado
        const deLaGuardada = r.guardada ? { vista: { guardada: true, generado: r.guardada.generado } } : {};
        if (!r.salidas[llave]) r.salidas[llave] = JSON.stringify(runs.todoEnIdioma(idioma, { ...r.vis, ...deLaGuardada, corridas: r.vis.corridas.map(runs.paraLista) }));
        return { status: 200, tipo: 'application/json; charset=utf-8', cuerpo: r.salidas[llave] };
      },
    },
    {
      method: 'GET', path: '/api/corridas/:id', needs: ['maintainer', 'person'], handler: async (ctx) => {
        await vista.leida();
        const r = loSuyo(ctx, true);
        if (r.sinBuzon) return SIN_BUZON;
        if (r.falla) return r.falla;
        const c = corrida(r.vis, ctx.params.id);
        return c ? json(200, runs.todoEnIdioma(idiomaDe(ctx), runs.paraDetalle(c))) : NO_EXISTE;
      },
    },
    {
      method: 'GET', path: '/api/corridas/:id/textos', needs: ['maintainer', 'person'], handler: async (ctx) => {
        await vista.leida();
        const r = loSuyo(ctx, true);
        if (r.sinBuzon) return SIN_BUZON;
        if (r.falla) return r.falla;
        const c = corrida(r.vis, ctx.params.id);
        if (!c) return NO_EXISTE;
        const t = await vista.textos(c.id);
        // la guardada no trae los textos: vuelven con el armado nuevo (nunca «la ejecución no tiene cambios»)
        // con el armado de este arranque fallado no hay nada por esperar, aunque la bajada siga a medias
        if (t && t.pendiente) {
          return !r.error && esperando() ? texto(503, tx(idiomaDe(ctx), 'corridas.textosVuelven'), { 'Retry-After': '60' }) : texto(503, tx(idiomaDe(ctx), 'corridas.textosNoDisponibles'));
        }
        // ilegibles no es «no hay»: el navegador dice «no se pudo abrir el cambio», nunca «no está»
        return t ? json(200, t) : texto(500, tx(idiomaDe(ctx), 'corridas.textosIlegibles'));
      },
    },
    { method: 'GET', path: '/corridas/cliente.js', needs: ['maintainer', 'person'], handler: () => ({ status: 200, tipo: 'text/javascript; charset=utf-8', cuerpo: runs.CLIENTE }) },
    // sólo lo propio de la vista: el tema, la grilla y las fichas ya vienen en /static/site.css con la paleta del sitio;
    // repetirlos acá (esta hoja carga después) volvería a poner la paleta de la página de la noche en toda la pestaña
    { method: 'GET', path: '/corridas/vista.css', needs: ['maintainer', 'person'], handler: () => ({ status: 200, tipo: 'text/css; charset=utf-8', cuerpo: runs.CSS_PROPIO }) },
  ];
  rutas.vista = vista;
  return rutas;
}

module.exports = { crearRutas, crearVista, armarEnWorker, armarEnElHilo, huellaDelEspejo, vistaUsable, FRASE_FALLA, FRASE_SIN_BUZON, ARCHIVO_VISTA };
