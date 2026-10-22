#!/usr/bin/env node
'use strict';
/*
 * runs-review.js — LA REVISIÓN NOCTURNA DE LAS EJECUCIONES: LEE LAS NUEVAS DEL BUZÓN Y DICE CUÁLES TUVIERON FALLAS DEL
 * ARNÉS.
 *
 * Cada noche, sin modelo: baja el buzón (las conversaciones, sólo las de la ventana: download-runs.js --threads-since),
 * lee cada ejecución, le pasa las reglas de rules.js y deja una ficha por ejecución con fallas en
 * `inbox/runs-review/pending/` del repo de operaciones, más el estado de la pasada en `inbox/runs-review/last-run.json`,
 * que lee el resumen diario. El id de cada ficha es el de la pestaña Corridas (`leerRegistro` de runs.js: misma máquina
 * después de unir carpetas viejas); una sesión que corrió dos stories tiene dos fichas con el mismo id y distinto `base`.
 *
 * 🔴 NINGÚN TEXTO LIBRE SALE. La ficha lleva sólo ids, fechas, números, el enlace y valores de las listas cerradas de
 *    rules.js: ni comandos, ni salidas, ni rutas del disco del dev, ni el motivo escrito en bypass.log, ni el texto de
 *    un error de la bajada.
 * 🔴 «NO PUDE» NO ES «LIMPIO». Sin conversación, la ficha dice `sin_hilo`; sin el registro de escapes,
 *    `escapes_registro: no_medido`; con la bajada fallada no se toca ninguna ficha; y un volcado, una ficha o una línea
 *    que no se pudo leer se cuentan en `ilegibles` y dejan la pasada en `completo: false`.
 *
 * Ciclo de una ficha: nace en `pending/`; la persona la mueve a `promoted/` (terminó en trabajo) o `archived/`. Una que
 * vuelve con una regla nueva se mueve de nuevo a `pending/` con `reaparecido`; una cuya ejecución hoy se revisó entera y
 * ya no da reglas pasa sola a `archived/` con `resuelta_sola`. Cada archivo se escribe a un temporal y se renombra.
 *
 * Uso: node scripts/nightly/runs-review/runs-review.js run --mailbox <dir> --operations <clon de operaciones> --today <AAAA-MM-DD>
 *        [--days 7] [--no-download]
 * Salida: 0 pasada entera · 1 parcial o sin poder bajar · 2 uso.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const RULES = require('./rules.js');
const RUNS = require('../dashboard/runs.js');
const OPS = require('../../lib/operations-config.js');

const CARPETAS = ['pending', 'promoted', 'archived'];
const DIA = /^\d{4}-\d{2}-\d{2}$/;
const ESTADOS = ['completa', 'deuda', 'abortada', 'abandonada'];
const VIAS = ['persona', 'reenvio', 'subida'];
// Un campo que viene del volcado entra a la ficha sólo con forma de id o de fecha; si no, null.
const FORMA_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const FORMA_HORA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const comoId = (v) => (typeof v === 'string' && FORMA_ID.test(v) ? v : null);

/** El día de la ejecución por su nombre (las dos formas que sube upload-runs.js); null si no trae una fecha legible. */
function diaDelNombre(base) {
  const a = /-(\d{4}-\d{2}-\d{2})T\d{4}$/.exec(base);
  if (a) return a[1];
  const b = /-(\d{4})(\d{2})(\d{2})\d{6}-sin-cerrar$/.exec(base);
  return b ? `${b[1]}-${b[2]}-${b[3]}` : null;
}
const menosDias = (dia, n) => new Date(Date.parse(`${dia}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);

/** Escribe entero o no escribe: a un temporal al lado y después el renombre. */
function escribirEntero(p, contenido) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contenido, 'utf8');
  fs.renameSync(tmp, p);
}
/** La ficha: un campo por renglón, cada valor en JSON (YAML válido, y se lee sin librería). */
function escribirFicha(p, f) {
  const orden = ['id', 'fecha', 'maquina', 'story', 'base', 'archivada', 'cierre', 'reglas', 'sin_hilo', 'escapes_registro', 'enlace', 'enlace_sin_sitio', 'veredicto', 'vista_por_ultima_vez', 'reaparecido', 'resuelta_sola'];
  const y = ['# Ficha de la revisión nocturna de las ejecuciones. La decide quien mantiene el arnés:',
    '# promoted/ si terminó en trabajo, archived/ si no. Sin texto de la conversación, a propósito.',
    ...orden.filter((k) => f[k] !== undefined).map((k) => `${k}: ${JSON.stringify(f[k])}`), ''];
  escribirEntero(p, y.join('\n'));
}
/** La ficha leída; `null` si no tiene forma de ficha (sin `id` legible). */
function leerFicha(p) {
  const out = {};
  for (const l of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = /^([a-z_]+): (.*)$/.exec(l);
    if (!m) continue;
    try { out[m[1]] = JSON.parse(m[2]); } catch { out[m[1]] = null; }
  }
  if (!Array.isArray(out.reglas)) out.reglas = [];
  out.reglas = out.reglas.filter((r) => r && typeof r === 'object');
  return out;
}
/** La clave de una ejecución: el id de la pestaña y el nombre de su volcado. */
const clave = (id, base) => `${id}|${base}`;
/** Las fichas que ya hay, por clave, y cuántas no se pudieron leer. */
function fichasPrevias(raiz) {
  const porClave = new Map();
  let ilegibles = 0;
  for (const c of CARPETAS) {
    const dir = path.join(raiz, c);
    let nombres = [];
    try { nombres = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')); } catch (e) { if (e.code !== 'ENOENT') ilegibles += 1; continue; }
    for (const f of nombres) {
      const ruta = path.join(dir, f);
      let datos = null;
      try { datos = leerFicha(ruta); } catch { datos = null; }
      if (!datos || typeof datos.id !== 'string' || !datos.id) { ilegibles += 1; continue; }
      porClave.set(clave(datos.id, datos.base), { carpeta: c, ruta, datos });
    }
  }
  return { porClave, ilegibles };
}

/**
 * Las líneas JSON de un `.gz`: `{ lineas, rotas }`; `null` si el archivo no está; `{ lineas: null, roto: true }` si está
 * y no se puede leer (no es gzip, permisos).
 */
function leerJsonl(p) {
  let t;
  try { t = zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'); } catch (e) { return e && e.code === 'ENOENT' ? null : { lineas: null, rotas: 0, roto: true }; }
  const lineas = [];
  let rotas = 0;
  for (const l of t.split('\n')) { if (!l.trim()) continue; try { lineas.push(JSON.parse(l)); } catch { rotas += 1; } }
  return { lineas, rotas };
}
function leerRegistros(dirMaquina, cache, estado) {
  if (cache.has(dirMaquina)) return cache.get(dirMaquina);
  const r = path.join(dirMaquina, 'registros');
  let cobertura = null;
  try { cobertura = JSON.parse(fs.readFileSync(path.join(r, 'cobertura.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') estado.ilegibles += 1; }
  const b = leerJsonl(path.join(r, 'bypass.log.gz'));
  if (b) estado.ilegibles += b.roto ? 1 : b.rotas;
  const out = { cobertura, bypass: b && !b.roto ? b.lineas : null };
  cache.set(dirMaquina, out);
  return out;
}

/** Lo que entra a la ficha de lo que devolvieron las reglas: categorías de forma cerrada, sin texto. */
function reglasParaFicha(reglas) {
  return reglas.map((r) => {
    const x = { regla: r.regla, categoria: r.categoria === null ? null : (/^[A-Za-z0-9:/._-]{1,80}$/.test(String(r.categoria)) ? r.categoria : 'otro'), cuenta: r.cuenta };
    for (const k of ['con_frase', 'con_motivo', 'pendientes', 'rojos']) if (r[k] !== undefined) x[k] = r[k];
    return x;
  });
}
// El estado de una bajada que no fue entera va por su código (`sin_permiso`, `parcial`…); su texto puede traer rutas.
const estadoDeBajada = (e) => (typeof e === 'string' && /^[a-z_]{1,30}$/.test(e) ? e : 'desconocido');

/** Los volcados del espejo, por carpeta de máquina: `{ ruta, carpeta }`, y cuántas carpetas no se pudieron leer. */
function volcadosDelEspejo(mailbox) {
  const out = [];
  let ilegibles = 0;
  let carpetas = [];
  try { carpetas = fs.readdirSync(mailbox, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return null; }
  for (const c of carpetas) {
    let fs_ = [];
    try { fs_ = fs.readdirSync(path.join(mailbox, c)).filter((f) => f.endsWith('.json')).sort(); } catch { ilegibles += 1; continue; }
    for (const f of fs_) out.push({ ruta: path.join(mailbox, c, f), carpeta: c });
  }
  return { lista: out, ilegibles };
}

async function run(opts) {
  const { mailbox, ops: opsDir, today } = opts;
  const days = Number.isFinite(opts.days) ? opts.days : 7;
  if (!mailbox || !opsDir || !DIA.test(String(today || ''))) return { codigo: 2, motivo: 'faltan --mailbox, --operations o --today (AAAA-MM-DD)' };
  const raiz = path.join(opsDir, 'inbox', 'runs-review');
  const desde = menosDias(today, days);
  const estado = { fecha: today, completo: true, motivo: null, miradas: 0, con_fallas: 0, nuevas: 0, sin_hilo: 0, hilos_sin_hooks: 0, ilegibles: 0 };
  const cerrar = (codigo) => {
    escribirEntero(path.join(raiz, 'last-run.json'), `${JSON.stringify(estado, null, 2)}\n`);
    return { codigo, estado };
  };

  if (!opts.noDownload) {
    const bajar = opts.bajar || ((o) => require('../../metrics/download-runs.js').bajar(o));
    // la bajada escribe en TYCON_MAILBOX_DIR: la carpeta de --mailbox, para que esta pasada lea lo que bajó
    const antes = process.env.TYCON_MAILBOX_DIR;
    process.env.TYCON_MAILBOX_DIR = mailbox;
    let r;
    try { r = await bajar({ hilosDesde: desde }); } catch { r = { codigo: 1, res: { completo: false, estado: 'error' } }; }
    finally { if (antes === undefined) delete process.env.TYCON_MAILBOX_DIR; else process.env.TYCON_MAILBOX_DIR = antes; }
    const res = (r && r.res) || {};
    if (!(r && r.codigo === 0 && res.completo === true)) {
      // la bajada no fue entera: no se mueve ni se escribe ninguna ficha
      estado.completo = false;
      estado.motivo = `la bajada del buzón no fue entera (${estadoDeBajada(res.estado)})`;
      return cerrar(1);
    }
  }

  try {
    let urlSitio = null;
    const opsJson = path.join(opsDir, 'operations.json');
    try {
      const o = OPS.load(opsJson);
      if (o.ok && o.data.site && typeof o.data.site.url === 'string') urlSitio = o.data.site.url.replace(/\/+$/, '');
      else if (!o.ok && fs.existsSync(opsJson)) estado.motivo = 'operations.json no se pudo leer: los enlaces van sin el sitio';
    } catch { estado.motivo = 'operations.json no se pudo leer: los enlaces van sin el sitio'; }

    const espejo = volcadosDelEspejo(mailbox);
    if (espejo === null) { estado.completo = false; estado.motivo = 'la carpeta del buzón no se pudo leer'; return cerrar(1); }
    const lista = espejo.lista;
    estado.ilegibles += espejo.ilegibles;
    // id y máquina de cada sesión, como los arma la pestaña Corridas
    const reg = RUNS.leerRegistro(null, RUNS.nombresDePasos().nombres, { buzon: mailbox, soloBuzon: true });
    const porSesion = new Map();
    for (const c of reg.corridas) {
      const sid = c._volcado ? (() => { try { return JSON.parse(fs.readFileSync(c._volcado, 'utf8')).marker.sessionId; } catch { return null; } })() : null;
      if (sid) porSesion.set(sid, { id: c.id, maquina: c.maquina });
    }
    const previas = fichasPrevias(raiz);
    estado.ilegibles += previas.ilegibles;
    const cacheRegistros = new Map();
    for (const { ruta, carpeta } of lista) {
      let volcado;
      try { volcado = JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch { volcado = null; }
      if (!volcado || typeof volcado !== 'object' || !volcado.marker || typeof volcado.marker !== 'object' || typeof volcado.marker.sessionId !== 'string') { estado.ilegibles += 1; continue; }
      const base = path.basename(ruta, '.json');
      const dia = diaDelNombre(base) || String(volcado.archivedAt || volcado.marker.startedAt || '').slice(0, 10);
      if (!DIA.test(dia) || dia < desde) continue;
      const sesion = porSesion.get(volcado.marker.sessionId) || { id: RUNS.idEstable(carpeta, volcado.marker.sessionId), maquina: carpeta };
      estado.miradas += 1;
      const h = leerJsonl(ruta.replace(/\.json$/, '.hilo.jsonl.gz'));
      if (h) estado.ilegibles += h.roto ? 1 : h.rotas;
      const r = RULES.revisar({ volcado, lineasHilo: h && !h.roto ? h.lineas : null, registros: leerRegistros(path.dirname(ruta), cacheRegistros, estado) });
      if (r.sin_hilo) estado.sin_hilo += 1; else if (r.hilo_sin_hooks) estado.hilos_sin_hooks += 1;
      const prev = previas.porClave.get(clave(sesion.id, comoId(base)));
      if (!r.reglas.length) {
        // se archiva sola sólo si hoy se pudo revisar entera: con conversación y con el registro de escapes medido
        if (prev && prev.carpeta === 'pending' && !r.sin_hilo && r.escapes_registro === 'medido') {
          escribirFicha(path.join(raiz, 'archived', path.basename(prev.ruta)), { ...prev.datos, resuelta_sola: today });
          fs.unlinkSync(prev.ruta);
        }
        continue;
      }
      estado.con_fallas += 1;
      const m = volcado.marker;
      const cierre = m.cierre && typeof m.cierre === 'object' ? { estado: ESTADOS.includes(m.cierre.estado) ? m.cierre.estado : 'desconocido', via: VIAS.includes(m.cierre.via) ? m.cierre.via : null } : null;
      const enlace = urlSitio ? `${urlSitio}/corridas?abrir=${sesion.id}` : `/corridas?abrir=${sesion.id}`;
      const nueva = {
        id: sesion.id, fecha: prev ? prev.datos.fecha : today, maquina: comoId(sesion.maquina), story: comoId(m.storyId), base: comoId(base),
        archivada: typeof volcado.archivedAt === 'string' && FORMA_HORA.test(volcado.archivedAt) ? volcado.archivedAt : null, cierre, reglas: reglasParaFicha(r.reglas),
        sin_hilo: r.sin_hilo, escapes_registro: r.escapes_registro, enlace, ...(urlSitio ? {} : { enlace_sin_sitio: true }),
        veredicto: prev && typeof prev.datos.veredicto === 'string' ? prev.datos.veredicto : 'pendiente', vista_por_ultima_vez: today,
      };
      if (!prev) {
        estado.nuevas += 1;
        const marca = crypto.createHash('sha1').update(base).digest('hex').slice(0, 6);
        escribirFicha(path.join(raiz, 'pending', `${today}-${nueva.maquina || 'sin-maquina'}-${sesion.id}-${marca}.yaml`), nueva);
      } else if (prev.carpeta === 'pending') {
        escribirFicha(prev.ruta, { ...nueva, ...(prev.datos.reaparecido ? { reaparecido: prev.datos.reaparecido } : {}) });
      } else {
        const antes = new Set(prev.datos.reglas.map((x) => x.regla));
        if (nueva.reglas.some((x) => !antes.has(x.regla))) {
          // se mueve: primero la nueva en pending/, después se borra la de su carpeta (nunca dos con la misma clave)
          escribirFicha(path.join(raiz, 'pending', path.basename(prev.ruta)), { ...nueva, veredicto: 'pendiente', reaparecido: today });
          fs.unlinkSync(prev.ruta);
        }
      }
    }
    if (estado.ilegibles) { estado.completo = false; if (!estado.motivo) estado.motivo = `${estado.ilegibles} archivo(s) o línea(s) ilegible(s)`; }
    return cerrar(estado.completo ? 0 : 1);
  } catch (e) {
    // una pasada cortada no deja el estado de ayer como si fuera de hoy
    estado.completo = false;
    estado.motivo = `la pasada se cortó por un error (${e && e.code ? e.code : 'sin código'})`;
    return cerrar(1);
  }
}

function main(argv) {
  const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv[0] !== 'run') { process.stderr.write('uso: runs-review.js run --mailbox <dir> --operations <dir> --today <AAAA-MM-DD> [--days 7] [--no-download]\n'); return Promise.resolve(2); }
  const days = val('--days') === undefined ? undefined : Number(val('--days'));
  return run({ mailbox: val('--mailbox'), ops: val('--operations'), today: val('--today'), days, noDownload: argv.includes('--no-download') })
    .then((r) => { process.stdout.write(`${JSON.stringify(r.estado || { motivo: r.motivo }, null, 2)}\n`); return r.codigo; });
}

module.exports = { run, leerFicha, diaDelNombre };

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { process.stderr.write(`runs-review: ${e && e.stack ? e.stack : e}\n`); process.exitCode = 1; });
}
