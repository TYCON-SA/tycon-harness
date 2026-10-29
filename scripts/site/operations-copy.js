#!/usr/bin/env node
'use strict';
/**
 * operations-copy.js — la copia de lo que el sitio lee del repo de operaciones, en un contenedor de almacenamiento.
 *
 * Por qué: leer el repo de operaciones pide una credencial de la plataforma de git (un permiso personal que vence, o una
 * licencia para la identidad del sitio). El sitio ya lee un contenedor con su identidad administrada, sin token y sin
 * licencia. Un trabajo con su propia identidad copia ahí lo que el sitio necesita, y el sitio lo lee de ahí.
 *
 * Dos órdenes:
 *   subir   (el trabajo que copia) arma la foto con las rutas de `RUTAS` del commit de `main`, sube primero
 *           `fotos/<commit>.tar.gz` y recién al final el índice `actual.json` (commit, hora, huella sha256 de la foto y la
 *           versión de git de cada archivo). Si el índice ya nombra ese commit, con la misma lista de archivos y su foto
 *           presente, no sube nada; si la lista cambió (el arnés suma un archivo a la foto), re-sube con el mismo commit
 *           en `fotos/<commit>-<huella>.tar.gz`, sin pisar la que nombra el índice; el índice dice cuál en `foto`.
 *           Borra las fotos de más de 7 días, salvo la que nombra el índice. Si falla la foto, el índice no se toca y el
 *           sitio sigue con la anterior.
 *   bajar   (el sitio) baja el índice; si el commit o la huella cambiaron, baja la foto que nombra `foto`, comprueba
 *           la huella, la valida entera (sin enlaces, sin rutas absolutas ni `..`) y recién entonces la abre en una
 *           carpeta nueva. Una foto que no pasa
 *           no se abre: el sitio sigue con la carpeta anterior. Una ruta sana que el sitio no lee se ignora (no se
 *           escribe y queda en el registro): un archivo nuevo en la copia no deja al sitio sin datos frescos.
 *
 * Además de `RUTAS`, la foto trae el logo que declara `site.brand.logo` del `operations.json` del mismo commit (la ruta
 * la elige cada organización, así que no puede estar en la lista fija), validado con `BRAND_LOGO`.
 *
 * La foto es un tar.gz armado acá, sin el `tar` del sistema (la imagen del sitio no lo garantiza). La lista de rutas es una
 * sola: la usan el trabajo que copia y el sitio, y una prueba la compara con lo que leen sources.js y la pestaña
 * Configuración (scripts/tests/site-operations-copy.test.js).
 *
 * El almacenamiento (`{ get, put, list, del }`) lo da el módulo de la nube en cloud/ (`almacenDeCopia`): este archivo no
 * nombra a ninguna. La credencial: `{ lineaDeOrdenes: true }` (el trabajo que copia, con la sesión de la línea de órdenes
 * de esa nube), `{ managed: true }` (la identidad administrada del sitio) o `{ sas }` (una SAS de servicio de sólo leer y
 * listar). Nunca se escribe en el registro.
 *
 * Despertar al sitio: con `--wake <dirección del sitio>`, si la foto subida trae otro `operations.json` que la anterior,
 * el trabajo que copia le pide `/livez` al sitio. Un sitio que escala a cero no lee operaciones hasta que alguien entra,
 * y con él esperan lo que dispara un cambio de la lista (las invitaciones de Personas). El pedido despierta una réplica,
 * que al arrancar lee operaciones (de la copia o del repo, según `SITE_OPERATIONS_SOURCE`). Si el sitio no contesta, la corrida no falla: lo dice, y el cambio se aplica cuando alguien
 * entre. Los guardados de los nocturnos no cambian `operations.json` y no lo despiertan.
 *
 * Uso:  node operations-copy.js subir --repo <clon de main> --account <c> --container <k> [--wake <url>] [--dry-run]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { BRAND_LOGO } = require('../lib/operations-config.js');

/** Lo que el sitio lee del repo de operaciones. Una ruta que termina en `/` es la carpeta entera (se lee por listado). */
const RUTAS = Object.freeze([
  'operations.json',
  'scripts/nightly/dashboard/sources.json',
  'scripts/nightly/dashboard/declared.json',
  'scripts/nightly/dependencies/repos.json',
  'scripts/ci/product-parity.json',
  'artifacts/tablero-del-arnes.html',
  '.dashboard/',
  // las fichas vivas de la noche y las decisiones que esperan aplicarse: «Lo que encontró la noche» (tabs/findings.js).
  // Las archivadas no: la sección no las muestra.
  ...['dependencies', 'watcher', 'runs-review'].flatMap((c) => ['pending', 'promoted', 'decisions'].map((d) => `inbox/${c}/${d}/`)),
]);
const INDICE = 'actual.json';
const CARPETA_FOTOS = 'fotos/';
// la foto que nombra un índice: `foto` (una re-subida con el mismo commit va con otro nombre y no pisa la anterior) o, sin
// él, la de siempre. `null` si `foto` no tiene la forma de una foto: ese índice no se usa.
const FORMA_FOTO = /^fotos\/[0-9a-f]{7,64}(-[0-9a-f]{16})?\.tar\.gz$/;
function fotoDe(indice) {
  if (!indice || indice.foto === undefined) return `${CARPETA_FOTOS}${indice && indice.commit}.tar.gz`;
  return typeof indice.foto === 'string' && FORMA_FOTO.test(indice.foto) ? indice.foto : null;
}
const VIDA_FOTOS_MS = 7 * 86400000;

const enRutas = (rel) => RUTAS.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p));
/** La forma de una ruta de la foto: relativa, con `/`, sin segmentos vacíos ni `.` ni `..`. */
function rutaSegura(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 255) return false;
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.includes('\\') || rel.includes('\0')) return false;
  return !rel.split('/').some((s) => s === '' || s === '.' || s === '..');
}
/** Una ruta segura y de las que el sitio lee. */
const rutaSana = (rel) => rutaSegura(rel) && enRutas(rel);

/** El logo que declara un operations.json (`site.brand.logo`), si pasa `BRAND_LOGO`; si no, `null`. */
function logoDe(cuerpo) {
  let ops; try { ops = JSON.parse(cuerpo.toString('utf8')); } catch { return null; }
  const logo = ops && ops.site && ops.site.brand ? ops.site.brand.logo : undefined;
  return typeof logo === 'string' && BRAND_LOGO.test(logo) && rutaSegura(logo) ? logo : null;
}

// ── la foto (tar ustar + gzip) ─────────────────────────────────────────────────────────────────────────────────
// un nombre que no entra en la cabecera ustar (100 + 155 bytes) va en una cabecera extendida PAX con su `path`; el
// lector la acepta sólo inmediatamente antes de un archivo, y valida esa ruta igual que cualquier otra
const PAX_MAX = 4096;
function cabeceraTar(rel, tam, tipo = '0') {
  const h = Buffer.alloc(512);
  let nombre = rel; let prefijo = '';
  if (Buffer.byteLength(rel) > 100) {
    const corte = rel.lastIndexOf('/', rel.length - 1);
    prefijo = rel.slice(0, corte); nombre = rel.slice(corte + 1);
    if (corte < 0 || Buffer.byteLength(nombre) > 100 || Buffer.byteLength(prefijo) > 155) return null;
  }
  h.write(nombre, 0, 100, 'utf8');
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(`${tam.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write(tipo, 156);
  h.write('ustar\0', 257); h.write('00', 263);
  if (prefijo) h.write(prefijo, 345, 155, 'utf8');
  h.fill(' ', 148, 156);
  let suma = 0; for (const b of h) suma += b;
  h.write(`${suma.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

/** `[{ rel, cuerpo }]` → el tar.gz. */
function armarFoto(archivos) {
  const partes = [];
  const relleno = (n) => Buffer.alloc((512 - (n % 512)) % 512);
  for (const a of archivos) {
    let h = cabeceraTar(a.rel, a.cuerpo.length);
    if (!h) {
      // el registro PAX: «<largo> path=<ruta>\n», donde <largo> cuenta el registro entero (con sus propios dígitos)
      const resto = ` path=${a.rel}\n`;
      let largo = Buffer.byteLength(resto) + 1;
      while (String(largo).length + Buffer.byteLength(resto) !== largo) largo = String(largo).length + Buffer.byteLength(resto);
      const pax = Buffer.from(`${largo}${resto}`, 'utf8');
      if (pax.length > PAX_MAX) throw new Error(`la ruta ${a.rel.slice(0, 120)} es demasiado larga para la foto`);
      partes.push(cabeceraTar('PaxHeader', pax.length, 'x'), pax, relleno(pax.length));
      h = cabeceraTar('PaxHeader', a.cuerpo.length);
    }
    partes.push(h, a.cuerpo, relleno(a.cuerpo.length));
  }
  partes.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(partes), { level: 9 });
}

const cadena = (b, desde, largo) => { const s = b.subarray(desde, desde + largo); const fin = s.indexOf(0); return (fin === -1 ? s : s.subarray(0, fin)).toString('utf8'); };

/**
 * El tar.gz → `{ ok: true, archivos: [{ rel, cuerpo }], ignorados: [rel] }` o `{ ok: false, motivo }`. Valida TODO antes
 * de devolver nada. Lo peligroso rechaza la foto entera; una ruta segura que el sitio no lee (ni es el logo que declara
 * el operations.json de la misma foto) va a `ignorados` y no se devuelve.
 */
function leerFoto(gz) {
  let tar;
  try { tar = zlib.gunzipSync(gz); } catch (e) { return { ok: false, motivo: `la foto no se puede descomprimir (${e.code || e.message})` }; }
  const archivos = [];
  const vistos = new Set();
  let rutaPax = null;
  for (let i = 0; i + 512 <= tar.length;) {
    const h = tar.subarray(i, i + 512);
    if (h.every((b) => b === 0)) break;
    let suma = 0; for (let k = 0; k < 512; k++) suma += k >= 148 && k < 156 ? 32 : h[k];
    if (parseInt(cadena(h, 148, 8).trim(), 8) !== suma) return { ok: false, motivo: 'la foto tiene una cabecera rota' };
    const prefijo = cadena(h, 345, 155);
    const tipo = String.fromCharCode(h[156] || 48);
    const tam = parseInt(cadena(h, 124, 12).trim() || '0', 8);
    if (tipo === 'x') {
      // una cabecera PAX: sólo `path`, chica, y seguida de un archivo (dos seguidas, o una al final, no se abren)
      if (rutaPax !== null) return { ok: false, motivo: 'la foto trae dos cabeceras extendidas seguidas: no se abre' };
      if (!Number.isFinite(tam) || tam <= 0 || tam > PAX_MAX || i + 512 + tam > tar.length) return { ok: false, motivo: 'la foto trae una cabecera extendida que no se abre' };
      const m = /^(\d+) path=([^\n]*)\n$/s.exec(tar.subarray(i + 512, i + 512 + tam).toString('utf8'));
      if (!m || Number(m[1]) !== tam) return { ok: false, motivo: 'la foto trae una cabecera extendida que no es sólo una ruta: no se abre' };
      rutaPax = m[2];
      i += 512 + tam + ((512 - (tam % 512)) % 512);
      continue;
    }
    const rel = rutaPax !== null ? rutaPax : (prefijo ? `${prefijo}/${cadena(h, 0, 100)}` : cadena(h, 0, 100));
    rutaPax = null;
    if (tipo !== '0') return { ok: false, motivo: `la foto trae algo que no es un archivo (${rel}, tipo ${tipo}): no se abre` };
    if (!rutaSegura(rel)) return { ok: false, motivo: `la foto trae una ruta que no se abre (${rel.slice(0, 120)})` };
    if (vistos.has(rel)) return { ok: false, motivo: `la foto trae ${rel} dos veces` };
    if (!Number.isFinite(tam) || tam < 0 || i + 512 + tam > tar.length) return { ok: false, motivo: `la foto está cortada en ${rel}` };
    vistos.add(rel);
    archivos.push({ rel, cuerpo: Buffer.from(tar.subarray(i + 512, i + 512 + tam)) });
    i += 512 + tam + ((512 - (tam % 512)) % 512);
  }
  if (rutaPax !== null) return { ok: false, motivo: 'la foto termina en una cabecera extendida sin su archivo: no se abre' };
  const ops = archivos.find((a) => a.rel === 'operations.json');
  const logo = ops ? logoDe(ops.cuerpo) : null;
  const sirve = (a) => enRutas(a.rel) || a.rel === logo;
  const ignorados = archivos.filter((a) => !sirve(a)).map((a) => a.rel);
  const abiertos = archivos.filter(sirve);
  if (!abiertos.length) return { ok: false, motivo: archivos.length ? `la foto no trae ningún archivo que el sitio lea (${archivos.length} ignorado(s))` : 'la foto no trae ningún archivo' };
  return { ok: true, archivos: abiertos, ignorados };
}

// ── lo que entra a la foto, del commit de main ─────────────────────────────────────────────────────────────────
function gitDe(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 << 20, windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args[0]} falló en ${repo}: ${String(r.stderr || '').trim().slice(0, 200)}`);
  return r.stdout;
}

/** Suma a `elegidos` el logo que declara el operations.json del commit, si es un archivo de git (no un enlace). */
function sumarLogo(repo, elegidos, log) {
  const ops = elegidos.find((e) => e.rel === 'operations.json');
  if (!ops) return;
  const r = spawnSync('git', ['-C', repo, 'cat-file', 'blob', ops.oid], { maxBuffer: 64 << 20, windowsHide: true });
  if (r.status !== 0) throw new Error(`git cat-file falló en ${repo}: ${String(r.stderr || '').trim().slice(0, 200)}`);
  let declarado;
  try { const o = JSON.parse(r.stdout.toString('utf8')); declarado = o && o.site && o.site.brand ? o.site.brand.logo : undefined; }
  catch (e) { log(`operations.json no se lee como JSON (${e.message.slice(0, 120)}): el logo no entra a la foto`); return; }
  if (declarado === undefined) return;
  const logo = logoDe(r.stdout);
  if (!logo) { log(`site.brand.logo (${String(declarado).slice(0, 120)}) no es la ruta de un .png o un .svg dentro del repo: no entra a la foto`); return; }
  if (elegidos.some((e) => e.rel === logo)) return;
  const linea = gitDe(repo, ['ls-tree', '-z', 'HEAD', '--', logo]).split('\0').filter(Boolean)[0];
  const m = linea && /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/s.exec(linea);
  if (!m || m[4] !== logo) { log(`el logo ${logo} no está en el commit: no entra a la foto`); return; }
  if (m[2] !== 'blob') { log(`el logo ${logo} es un ${m[2]} de git, no un archivo: no entra a la foto`); return; }
  if (m[1] === '120000') { log(`el logo ${logo} es un enlace simbólico, no entra a la foto`); return; }
  elegidos.push({ rel: logo, oid: m[3] });
}

/** `{ commit, archivos: [{ rel, cuerpo, oid }] }` del HEAD del clon. Sin enlaces simbólicos ni nada fuera del clon. */
function juntar(repo, log = () => {}) {
  const commit = gitDe(repo, ['rev-parse', 'HEAD']).trim();
  const lista = gitDe(repo, ['ls-tree', '-r', '-z', 'HEAD', '--', ...RUTAS.map((r) => r.replace(/\/$/, ''))]).split('\0').filter(Boolean);
  const elegidos = [];
  for (const linea of lista) {
    const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/s.exec(linea);
    if (!m) { log(`una línea de git ls-tree que no se entiende (${linea.slice(0, 120)}): no entra a la foto`); continue; }
    const [, modo, tipo, oid, rel] = m;
    if (tipo !== 'blob') { log(`${rel}: es un ${tipo} de git, no un archivo: no entra a la foto`); continue; }
    if (modo === '120000') { log(`${rel}: es un enlace simbólico, no entra a la foto`); continue; }
    if (!rutaSana(rel)) { log(`${rel}: ruta que no entra a la foto`); continue; }
    elegidos.push({ rel, oid });
  }
  sumarLogo(repo, elegidos, log);
  // 🔴 el contenido sale de los OBJETOS del commit, nunca del árbol de trabajo: un cambio sin commitear en el clon (o en
  //    un agente que reusa la carpeta) no puede publicarse con el sello de `main`
  const archivos = [];
  if (elegidos.length) {
    const r = spawnSync('git', ['-C', repo, 'cat-file', '--batch'], { input: elegidos.map((e) => e.oid).join('\n') + '\n', maxBuffer: 1 << 30, windowsHide: true });
    if (r.status !== 0) throw new Error(`git cat-file falló en ${repo}: ${String(r.stderr || '').trim().slice(0, 200)}`);
    const out = r.stdout;
    let i = 0;
    for (const e of elegidos) {
      const fin = out.indexOf(0x0a, i);
      const cab = out.subarray(i, fin).toString('utf8').split(' ');
      if (cab[0] !== e.oid || cab[1] !== 'blob') throw new Error(`git cat-file no devolvió el archivo ${e.rel} (${cab.join(' ').slice(0, 120)})`);
      const tam = Number(cab[2]);
      archivos.push({ rel: e.rel, oid: e.oid, cuerpo: Buffer.from(out.subarray(fin + 1, fin + 1 + tam)) });
      i = fin + 1 + tam + 1;
    }
  }
  return { commit, archivos };
}

// ── el almacenamiento ──────────────────────────────────────────────────────────────────────────────────────────
/** Lo que contesta el almacenamiento, en un código del sitio. */
function codigoDe(r) {
  if (!r || r.error) return 'sin_red';
  if (r.status === 404) return 'sin_foto';
  if (r.status === 401 || r.status === 403) return 'sin_permiso';
  return 'sin_red';
}

// ── subir ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** Borra las fotos de más de 7 días, salvo la que nombra el índice. `{ borradas }`. */
async function borrarViejas({ almacen, ahora = Date.now, log = () => {} }) {
  const idx = await almacen.get(INDICE);
  let actual = null;
  if (idx.status === 200) {
    try { actual = fotoDe(JSON.parse(idx.cuerpo)); } catch { log('el índice de la copia no se lee: no se borra ninguna foto vieja (sin saber cuál nombra, podría ser ésa)'); return { borradas: [] }; }
  }
  const l = await almacen.list(CARPETA_FOTOS);
  if (l.error || l.status !== 200) { log(`no se pudo listar las fotos viejas (${codigoDe(l)}): quedan para la próxima`); return { borradas: [] }; }
  if (l.truncado) log('el listado de fotos se cortó antes del final: las que no se listaron quedan para la próxima');
  const borradas = [];
  for (const b of l.blobs) {
    if (actual && b.name === actual) continue;
    if (!Number.isFinite(b.modificado)) { log(`${b.name}: sin fecha legible, no se borra`); continue; }
    if (ahora() - b.modificado <= VIDA_FOTOS_MS) continue;
    const r = await almacen.del(b.name);
    if (r.error || (r.status !== 202 && r.status !== 200 && r.status !== 204)) log(`no se pudo borrar ${b.name} (${codigoDe(r)})`);
    else borradas.push(b.name);
  }
  return { borradas };
}

/** ¿Las dos listas `{ rel: versión }` nombran los mismos archivos con las mismas versiones? */
function mismaLista(a, b) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
}

/**
 * `{ ok, subido, motivo, commit, bytes, cambioOperaciones }`. Nunca deja un índice que nombre una foto que no se subió.
 * `cambioOperaciones`: se subió una foto y su `operations.json` no es el del índice anterior (o no había uno legible).
 */
async function subir({ repo, almacen, ahora = Date.now, log = () => {}, dryRun = false }) {
  let j;
  try { j = juntar(repo, log); } catch (e) { return { ok: false, motivo: e.message }; }
  if (!j.archivos.length) return { ok: false, motivo: 'el clon no trae ninguna de las rutas que lee el sitio' };
  // sin operations.json el sitio no tiene configuración: una foto así no se publica (el sitio sigue con la anterior)
  if (!j.archivos.some((a) => a.rel === 'operations.json')) return { ok: false, motivo: 'el commit de main no trae operations.json: no se sube una foto sin la configuración del sitio' };
  let foto;
  try { foto = armarFoto(j.archivos); } catch (e) { return { ok: false, motivo: e.message }; }
  const huella = crypto.createHash('sha256').update(foto).digest('hex');
  const indice = { version: 1, commit: j.commit, hora: new Date(ahora()).toISOString(), huella, bytes: foto.length, archivos: Object.fromEntries(j.archivos.map((a) => [a.rel, a.oid])), foto: `${CARPETA_FOTOS}${j.commit}.tar.gz` };
  if (dryRun) return { ok: true, subido: false, motivo: `prueba: ${j.archivos.length} archivo(s), ${foto.length} bytes, commit ${j.commit.slice(0, 12)}`, commit: j.commit, bytes: foto.length, indice };
  const previo = await almacen.get(INDICE);
  let anterior = null;
  if (previo.error || (previo.status !== 200 && previo.status !== 404)) return { ok: false, motivo: `no se pudo leer el índice de la copia (${codigoDe(previo)}${previo.status ? ` ${previo.status}` : ''})` };
  if (previo.status === 200) {
    let p = null; try { p = JSON.parse(previo.cuerpo); } catch { /* ilegible: se reemplaza */ }
    anterior = p;
    if (p && p.commit === j.commit && !mismaLista(p.archivos, indice.archivos)) {
      // con otro nombre: la foto que nombra el índice viejo queda entera por si el índice nuevo no llega a escribirse
      indice.foto = `${CARPETA_FOTOS}${j.commit}-${huella.slice(0, 16)}.tar.gz`;
      log(`el índice nombra ${j.commit.slice(0, 12)} con otra lista de archivos: se vuelve a subir con el mismo commit`);
    } else if (p && p.commit === j.commit && fotoDe(p)) {
      // al día sólo si la foto que nombra el índice está: si se borró, se vuelve a subir (y el índice con ella)
      const nombre = fotoDe(p);
      const l = await almacen.list(nombre);
      const esta = !l.error && l.status === 200 && l.blobs.some((b) => b.name === nombre);
      if (l.error || l.status !== 200) return { ok: false, motivo: `no se pudo comprobar que la foto de ${j.commit.slice(0, 12)} siga en el contenedor (${codigoDe(l)})` };
      if (esta) {
        const b = await borrarViejas({ almacen, ahora, log });
        if (b.borradas.length) log(`borradas ${b.borradas.length} foto(s) de más de 7 días`);
        return { ok: true, subido: false, motivo: `la copia ya está al día con ${j.commit.slice(0, 12)}: no se sube nada`, commit: j.commit };
      }
      log(`el índice nombra ${j.commit.slice(0, 12)} y su foto no está: se vuelve a subir`);
    }
  }
  const f = await almacen.put(indice.foto, foto, 'application/gzip');
  if (f.error || (f.status !== 201 && f.status !== 200)) return { ok: false, motivo: `no se pudo subir la foto (${f.error ? f.error.code || f.error.message : f.status}): el índice queda como estaba` };
  const i = await almacen.put(INDICE, Buffer.from(`${JSON.stringify(indice)}\n`), 'application/json');
  if (i.error || (i.status !== 201 && i.status !== 200)) return { ok: false, motivo: `la foto se subió y el índice no (${i.error ? i.error.code || i.error.message : i.status}): el sitio sigue con la anterior` };
  const b = await borrarViejas({ almacen, ahora, log });
  if (b.borradas.length) log(`borradas ${b.borradas.length} foto(s) de más de 7 días`);
  const opsAntes = anterior && anterior.archivos && typeof anterior.archivos === 'object' ? anterior.archivos['operations.json'] : undefined;
  return { ok: true, subido: true, motivo: `subida la foto de ${j.commit.slice(0, 12)}: ${j.archivos.length} archivo(s), ${foto.length} bytes`, commit: j.commit, bytes: foto.length, cambioOperaciones: opsAntes !== indice.archivos['operations.json'] };
}

const DESPERTAR_MS = 90 * 1000;  // un sitio dormido tarda alrededor de un minuto en contestar
/** Le pide `/livez` al sitio para despertarlo. Nunca rechaza: `{ ok, motivo }`. */
async function despertar({ url, pedir = fetch, plazoMs = DESPERTAR_MS }) {
  let destino;
  try { destino = new URL('/livez', url); } catch { return { ok: false, motivo: `la dirección del sitio no es válida: ${url}` }; }
  if (destino.protocol !== 'https:' && destino.protocol !== 'http:') return { ok: false, motivo: `la dirección del sitio no es web: ${url}` };
  try {
    const r = await pedir(destino, { signal: AbortSignal.timeout(plazoMs), redirect: 'manual' });
    // cualquier respuesta por debajo de 400 viene de una réplica que ya arrancó (una redirección, también)
    if (r.status >= 200 && r.status < 400) return { ok: true, motivo: `el sitio despertó (${destino.origin}): lee operaciones al arrancar` };
    return { ok: false, motivo: `el sitio contestó ${r.status} a /livez: el cambio se aplica cuando alguien entre` };
  } catch (e) {
    const porque = e && e.name === 'TimeoutError' ? `no contestó en ${Math.round(plazoMs / 1000)} s` : 'sin conexión con el sitio';
    return { ok: false, motivo: `${porque}: el cambio se aplica cuando alguien entre` };
  }
}

// ── bajar ──────────────────────────────────────────────────────────────────────────────────────────────────────
const CONSERVAR_COPIAS = 3;
const GRACIA_COPIAS_MS = 60 * 60 * 1000;
const FORMA_COPIA = /^copia-[0-9a-f]{7,12}-[0-9a-f]{6}$/;
// la poda corre de fondo: un minuto después de abrir la foto (el servidor ya atiende), de a una carpeta con una pausa
// entre cada una y hasta un tope por pasada; lo que queda, en el próximo refresco. Borrar decenas de miles de archivos
// de un disco compartido de una vez traba al servidor y vence las pruebas de disponibilidad de la nube
const DEMORA_PODA_MS = 60 * 1000;
const PAUSA_PODA_MS = 1000;
const TOPE_PODA = 10;
const podasEnCurso = new Map();  // por carpeta: una poda a la vez en cada una
/**
 * Poda la carpeta de las copias abiertas: quedan `actual` y las más nuevas hasta `conservar` en total; las demás, y los
 * `.abriendo-` que dejó un corte, se borran si se abrieron hace más de `gracia`; `previo` (la copia que este proceso dejó
 * de usar) se borra sin esperar la gracia. La gracia y las copias que se conservan cuidan a otra réplica del sitio que
 * abrió la suya hace poco (un cambio de revisión); una réplica que sigue con una copia más vieja que esas la vuelve a bajar
 * en su próximo refresco, porque la suya ya no existe. Sin esto, cada reinicio dejaba la copia anterior para siempre:
 * quién era la anterior sólo lo sabe la memoria del proceso. Lo que no tiene la forma de una copia no se toca. Todo es
 * asíncrono, de a una carpeta, con `pausaMs` entre cada una y hasta `tope` por pasada. `{ borradas, quedan }`.
 */
async function podarCopias({ dir, actual, previo = null, conservar = CONSERVAR_COPIAS, gracia = GRACIA_COPIAS_MS, ahora = Date.now, log = () => {}, tope = TOPE_PODA, pausaMs = PAUSA_PODA_MS }) {
  let nombres;
  try { nombres = await fs.promises.readdir(dir); } catch (e) { if (e.code !== 'ENOENT') log(`copia de operaciones: no se pudo listar ${dir} para borrar las copias viejas (${e.code || e.message})`); return { borradas: [], quedan: 0 }; }
  const fecha = async (n) => { try { return (await fs.promises.lstat(path.join(dir, n))).mtimeMs; } catch { return NaN; } };
  const copias = [];
  for (const n of nombres.filter((x) => FORMA_COPIA.test(x))) { const t = await fecha(n); if (Number.isFinite(t)) copias.push({ n, t }); }
  copias.sort((a, b) => b.t - a.t);
  const enUso = actual ? path.basename(actual) : null;
  const quedan = new Set(enUso ? [enUso] : []);
  for (const c of copias) { if (quedan.size >= conservar) break; quedan.add(c.n); }
  const limite = ahora() - gracia;
  const aBorrar = [];
  const anterior = previo && path.dirname(previo) === dir ? path.basename(previo) : null;
  if (anterior && anterior !== enUso && FORMA_COPIA.test(anterior) && nombres.includes(anterior)) aBorrar.push(anterior);
  for (const c of copias) if (!quedan.has(c.n) && c.t <= limite && !aBorrar.includes(c.n)) aBorrar.push(c.n);
  for (const n of nombres.filter((x) => x.startsWith('.abriendo-'))) { const t = await fecha(n); if (Number.isFinite(t) && t <= limite) aBorrar.push(n); }
  const borradas = [];
  for (const n of aBorrar.slice(0, tope)) {
    if (borradas.length && pausaMs) await new Promise((r) => setTimeout(r, pausaMs));
    try { await fs.promises.rm(path.join(dir, n), { recursive: true, force: true }); borradas.push(n); } catch (e) { log(`copia de operaciones: ${n} no se pudo borrar (${e.code || e.message}); queda para la próxima`); }
  }
  const pendientes = Math.max(0, aBorrar.length - tope);
  if (borradas.length) log(`copia de operaciones: borradas ${borradas.length} carpeta(s) viejas de la copia${pendientes ? `; quedan ${pendientes} para la próxima pasada` : ''}`);
  return { borradas, quedan: pendientes };
}
/**
 * Programa una poda de fondo de `dir`, sin esperarla: corre después de `demoraMs`, una a la vez por carpeta (si ya hay
 * una en curso, devuelve ésa). La promesa nunca falla: un error se registra.
 */
function programarPoda({ dir, demoraMs = DEMORA_PODA_MS, log = () => {}, ...resto }) {
  if (podasEnCurso.has(dir)) {
    if (resto.previo) log('copia de operaciones: ya hay una poda en curso; la carpeta anterior queda para la próxima pasada');
    return podasEnCurso.get(dir);
  }
  const p = new Promise((listo) => { const t = setTimeout(listo, demoraMs); if (t.unref) t.unref(); })
    .then(() => podarCopias({ dir, log, ...resto }))
    .catch((e) => {
      try { log(`copia de operaciones: la poda de copias viejas falló (${(e && (e.code || e.message)) || e}); queda para la próxima`); } catch { /* sin registro, igual no rechaza */ }
      return { borradas: [], quedan: 0 };
    })
    .finally(() => { podasEnCurso.delete(dir); });
  podasEnCurso.set(dir, p);
  return p;
}
/** La poda en curso de `dir`, o una promesa ya cumplida si no hay ninguna (para esperarla, las pruebas). */
function podaPendiente(dir) { return podasEnCurso.get(dir) || Promise.resolve({ borradas: [], quedan: 0 }); }

/**
 * `{ ok: true, cambio, carpeta, indice, poda }` o `{ ok: false, codigo, motivo }`. `previo`: `{ commit, huella, carpeta }` de
 * la bajada anterior. Con el mismo commit y la misma huella no baja la foto. Con uno nuevo, la abre en
 * `<dir>/copia-<commit>-<azar>` (escribiendo sin trabar al servidor) y recién entonces programa la poda de fondo, que borra
 * la carpeta anterior y las viejas: quien lee nunca ve una mezcla. `poda` es la promesa de esa poda (nadie la espera; las
 * pruebas sí) y `opcionesPoda` cambia su demora, su pausa y su tope.
 */
async function bajar({ almacen, dir, previo = null, log = () => {}, opcionesPoda = {} }) {
  const r = await almacen.get(INDICE);
  if (r.error || r.status !== 200) return { ok: false, codigo: codigoDe(r), motivo: `el índice de la copia no se pudo bajar (${r.error ? r.error.code || r.error.message : r.status})` };
  let indice;
  try { indice = JSON.parse(r.cuerpo); } catch { return { ok: false, codigo: 'ilegible', motivo: 'el índice de la copia no es JSON' }; }
  if (!indice || typeof indice.commit !== 'string' || !/^[0-9a-f]{7,64}$/.test(indice.commit) || !/^[0-9a-f]{64}$/.test(String(indice.huella)) || Number.isNaN(Date.parse(indice.hora))) {
    return { ok: false, codigo: 'ilegible', motivo: 'el índice de la copia no tiene commit, hora y huella' };
  }
  // la versión de cada archivo: sin ella «Proponer» no sabe si el archivo cambió (Configuración lo pide)
  const arch = indice.archivos;
  if (!arch || typeof arch !== 'object' || Array.isArray(arch) || !Object.keys(arch).length || !Object.entries(arch).every(([k, v]) => rutaSegura(k) && typeof v === 'string' && /^[0-9a-f]{40,64}$/.test(v))) {
    return { ok: false, codigo: 'ilegible', motivo: 'el índice de la copia no trae la versión de cada archivo' };
  }
  const nombre = fotoDe(indice);
  if (!nombre) return { ok: false, codigo: 'ilegible', motivo: 'el índice de la copia nombra una foto que no tiene la forma de una foto' };
  // sin cambio sólo con el mismo commit Y la misma huella: una foto re-subida con el mismo commit trae otra
  if (previo && previo.commit === indice.commit && previo.huella === indice.huella && previo.carpeta && fs.existsSync(previo.carpeta)) {
    const poda = programarPoda({ dir, actual: previo.carpeta, log, ...opcionesPoda });
    return { ok: true, cambio: false, carpeta: previo.carpeta, indice, poda };
  }
  const f = await almacen.get(nombre);
  if (f.error || f.status !== 200) return { ok: false, codigo: f.status === 404 ? 'ilegible' : codigoDe(f), motivo: `la foto que nombra el índice no se pudo bajar (${f.error ? f.error.code || f.error.message : f.status})` };
  if (crypto.createHash('sha256').update(f.cuerpo).digest('hex') !== indice.huella) return { ok: false, codigo: 'ilegible', motivo: 'la foto no tiene la huella que dice el índice: no se abre' };
  const foto = leerFoto(f.cuerpo);
  if (!foto.ok) return { ok: false, codigo: 'ilegible', motivo: foto.motivo };
  if (foto.ignorados.length) log(`copia de operaciones: ${foto.ignorados.length} archivo(s) de la foto que el sitio no lee, ignorados: ${foto.ignorados.slice(0, 10).join(', ').slice(0, 400)}`);
  // asíncrono, archivo por archivo: sobre un disco compartido escribir miles de archivos de una vez traba al servidor
  let abriendo = null;
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    abriendo = await fs.promises.mkdtemp(path.join(dir, '.abriendo-'));
    for (const a of foto.archivos) {
      const destino = path.join(abriendo, a.rel);
      await fs.promises.mkdir(path.dirname(destino), { recursive: true });
      await fs.promises.writeFile(destino, a.cuerpo);
    }
    const carpeta = path.join(dir, `copia-${indice.commit.slice(0, 12)}-${crypto.randomBytes(3).toString('hex')}`);
    await fs.promises.rename(abriendo, carpeta);
    log(`copia de operaciones: abierta la foto de ${indice.commit.slice(0, 12)} (${foto.archivos.length} archivo(s))`);
    // la anterior se borra DESPUÉS y de fondo: si el borrado falla, la foto nueva ya está abierta y es la que vale
    const poda = programarPoda({ dir, actual: carpeta, previo: previo && previo.carpeta !== carpeta ? previo.carpeta : null, log, ...opcionesPoda });
    return { ok: true, cambio: true, carpeta, indice, poda };
  } catch (e) {
    if (abriendo) { try { await fs.promises.rm(abriendo, { recursive: true, force: true }); } catch { /* lo dice el motivo de abajo */ } }
    return { ok: false, codigo: 'ilegible', motivo: `la foto no se pudo abrir en el disco (${e.code || e.message})` };
  }
}

// ── la línea de órdenes (el trabajo que copia) ─────────────────────────────────────────────────────────────────
/** El almacenamiento de la nube que sabe guardar la copia (un módulo de cloud/ con `almacenDeCopia`). */
function almacenDeLaNube(opciones) {
  const nube = require('./sources.js').nubes().find((n) => typeof n.almacenDeCopia === 'function');
  if (!nube) throw new Error('ningún módulo de cloud/ sabe guardar la copia de operaciones');
  return nube.almacenDeCopia(opciones);
}

async function main(argv) {
  const [orden, ...resto] = argv;
  const op = (k) => { const i = resto.indexOf(k); return i >= 0 ? resto[i + 1] : null; };
  if (orden !== 'subir' || !op('--repo') || (!resto.includes('--dry-run') && (!op('--account') || !op('--container')))) {
    process.stderr.write('uso: operations-copy.js subir --repo <clon de main> --account <c> --container <k> [--wake <url>] [--dry-run]\n');
    return 2;
  }
  const log = (l) => process.stdout.write(`[copia] ${l}\n`);
  if (resto.includes('--dry-run')) {
    const r = await subir({ repo: op('--repo'), almacen: null, log, dryRun: true });
    log(r.motivo);
    return r.ok ? 0 : 1;
  }
  let almacen;
  try { almacen = almacenDeLaNube({ cuenta: op('--account'), contenedor: op('--container'), credencial: { lineaDeOrdenes: true }, urlBase: op('--url-base') }); }
  catch (e) { process.stderr.write(`[copia] ${e.message}\n`); return 1; }
  const r = await subir({ repo: op('--repo'), almacen, log });
  (r.ok ? process.stdout : process.stderr).write(`[copia] ${r.motivo}\n`);
  if (r.ok && op('--wake')) {
    if (r.cambioOperaciones) log((await despertar({ url: op('--wake') })).motivo);
    else log('operations.json no cambió: el sitio no hace falta despertarlo');
  }
  return r.ok ? 0 : 1;
}

module.exports = { RUTAS, INDICE, rutaSana, rutaSegura, logoDe, armarFoto, leerFoto, juntar, almacenDeLaNube, codigoDe, subir, despertar, bajar, borrarViejas, podarCopias, programarPoda, podaPendiente };

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { process.stderr.write(`[copia] falló: ${e && e.stack ? e.stack : e}\n`); process.exit(1); });
}
