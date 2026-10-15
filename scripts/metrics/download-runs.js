#!/usr/bin/env node
'use strict';
/*
 * download-runs.js — LAS CORRIDAS DE TODO EL EQUIPO, DESDE EL BUZÓN, PARA QUIEN PUEDE LEERLAS (story 2.16)
 *
 * Todas las máquinas suben sus corridas al buzón de Azure Storage con una llave que sólo escribe
 * (`upload-runs.js`). Leerlas pide el rol «Storage Blob Data Reader» sobre el contenedor, que tienen
 * sólo quienes el dueño del buzón autorizó. Este guion baja lo nuevo o cambiado a
 * `~/.claude/.tycon-pipeline/corridas-buzon/<maquina>/`, que es de donde lee la vista de corridas.
 *
 * Con la sesión de `az` que la persona YA tiene: pide un token para storage con el tenant del buzón
 * (`corridas-buzon.json → tenant` — DevB es invitado en ese tenant, y su `az` por default pediría el token
 * en el suyo), lista el contenedor y baja por HTTPS.
 *
 * 🔴 EN LA MÁQUINA DE OTRO NO HACE NADA, Y NUNCA PREGUNTA. Sin `az`, sin sesión o sin el rol (403): no
 *    baja, no crea la carpeta, sale 0 y lo anota UNA vez por día. `az` corre sin entrada (stdin cerrado) y
 *    con tope de tiempo: no puede abrir un login ni esperar una respuesta.
 *
 * Qué se baja: sólo nombres con forma `<maquina>/<volcado, hilo o cambio>` o `<maquina>/registros/<registro>` (lo que la
 * subida escribe), y desde la story 2.24 sus versiones: `<maquina>/v<versión>/<archivo>` y
 * `<maquina>/registros/v<versión>/<registro>` (la subida ya no pisa: lo que vuelve a subir lleva versión). De cada
 * corrida se baja SÓLO la versión más nueva (el nombre de siempre es la más vieja; las otras se cuentan en
 * `versiones_viejas`), y de los registros de cada máquina el juego más nuevo que está COMPLETO —su cobertura, y cada
 * fuente que declara `medido` con su archivo—; uno más nuevo incompleto se cuenta en `versiones_incompletas`. Todo
 * queda en la ruta de siempre del espejo (`<maquina>/<archivo>`, `<maquina>/registros/<registro>`): los lectores no
 * cambian.
 * Lo demás se cuenta como `ignorados` y no toca el disco. Cada archivo se escribe entero o no se escribe
 * (temporal + rename, verificando tamaño y Content-MD5). Qué ya está al día: tamaño + Content-MD5 del
 * listado contra el archivo local; si el listado no trae MD5, la Etag que se recordó al bajarlo
 * (`~/.claude/.tycon-pipeline/mailbox-downloads.json`). El índice y el sello diario de «sin permiso»
 * (`download-runs-no-permission.seal`) cambiaron de nombre en la story 8.9 (tanda D2): si sólo está el de
 * antes, se lee ése, y antes de escribir el nuevo se le pasa su contenido (scripts/lib/renames.json).
 *
 * Uso:
 *   node scripts/metrics/download-runs.js [--json] [--budget-ms N] [--no-threads]
 *   node scripts/metrics/download-runs.js --overwrites-report [--json]
 *
 *   --no-threads (story 2.12): baja los registros y los volcados, NUNCA los hilos ni los cambios de git
 *   (`*.hilo.jsonl.gz`, `*.cambio.json.gz` — story 2.19: traen código de todos los repos); los cuenta en
 *   `omitidos`. Lo usa el nocturno del tablero: la página no usa las conversaciones —prompts, rutas, código de
 *   clientes— y el agente de Azure no tiene por qué tenerlas.
 *
 *   --overwrites-report (story 2.24): sólo LISTA el contenedor —no baja nada, no escribe el espejo— y cuenta los blobs
 *   re-escritos (última modificación más de 1 s después de la creación) por tipo y por máquina con su alias, y si cada
 *   máquina declara en su place.json una versión lista para que la política pase a «sólo crear». Es la medición que va
 *   antes de cambiar la política.
 *
 *   El resultado dice `codigo` (el de salida) y `completo`: true SÓLO si salió 0, el estado es `bajado` o `al_dia` y
 *   no quedó nada sin tiempo. Es EL criterio de «el buzón se leyó entero»: lo leen el pipeline y el generador del
 *   tablero, que no lo reescriben.
 *
 * Desde la story 2.28, al terminar cada bajada (también una parcial) deja en el espejo `.carpetas-de-maquina.json`: qué
 * carpeta vieja de una máquina es la historia de qué carpeta nueva `<nombre>-<código>` (ver `carpetasDeMaquina`). Sin
 * correos: el reductor, la poda y la vista leen ese archivo y no abren `place.json`.
 *
 * Contrato de salida:
 *   0 → bajó, estaba al día, o esta máquina no puede leer el buzón (sin az / sin sesión / sin rol)
 *   1 → pudo pedir permiso pero no pudo bajar (sin red, el servicio falló, contenedor inexistente, algo
 *       ilegible, llave del buzón ausente o ilegible)
 *
 * Variables (para el banco de pruebas): TYCON_MAILBOX_JSON, TYCON_MAILBOX_URL_BASE, TYCON_MAILBOX_DIR,
 * TYCON_AZ_BIN, TYCON_DOWNLOADS_LOG. Apagado desde el instalador: TYCON_NO_DOWNLOAD_RUNS=1.
 */

const fs = require('fs');
const path = require('path');
// story 8.23 (A2): la carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: los
// laboratorios copian carpetas sueltas de scripts/ sin scripts/setup/; ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');
const { readEnv, resolveFile, prepareStateWrite } = require('../lib/legacy-names.js');
const { leerConfig, integracionBuzon, urlBase, huellaDeCorridas, FORMA_MAQUINA, FORMA_CODIGO, FORMA_ARCHIVO, FORMA_REGISTRO, FORMA_VERSION, REGISTROS, X_MS_VERSION } = require('./upload-runs.js');

const CASA_PIPELINE = path.join(stateDirOf(os.homedir()));
const DONDE = 'scripts/metrics/download-runs.js';

function hoy() { return new Date().toISOString().slice(0, 10); }

function escribirAtomico(archivo, contenido) {
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  const tmp = `${archivo}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contenido);
  fs.renameSync(tmp, archivo);
}

function selloDiario(archivo, texto) {
  try { if (fs.readFileSync(resolveFile(archivo, { where: DONDE }), 'utf8').slice(0, 10) === hoy()) return 'ya_emitido_hoy'; } catch (_) { /* primera vez */ }
  try { prepareStateWrite(archivo, { where: DONDE }); escribirAtomico(archivo, `${hoy()} ${texto}\n`); } catch (_) { /* se avisa igual */ }
  return 'emitido';
}

const decodificarXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Los blobs de una página de listado XML, y el marcador de la siguiente. */
function leerListado(xml) {
  const blobs = [];
  for (const m of String(xml).matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)) {
    const campo = (n) => { const r = m[1].match(new RegExp(`<${n}>([^<]*)</${n}>`)); return r ? decodificarXml(r[1]) : null; };
    const nombre = campo('Name');
    if (nombre === null) continue;
    // story 2.24: las fechas de creación y de última modificación, para contar re-subidas sin bajar contenido
    const fecha = (n) => { const v = campo(n); const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
    blobs.push({ nombre, largo: Number(campo('Content-Length')), md5: campo('Content-MD5') || null, etag: campo('Etag') || null, creado: fecha('Creation-Time'), modificado: fecha('Last-Modified') });
  }
  const sig = (String(xml).match(/<NextMarker>([^<]*)<\/NextMarker>/) || [])[1] || '';
  return { blobs, siguiente: decodificarXml(sig) };
}

/**
 * Un nombre que viene del buzón, listo para mostrar: los nombres los elige cualquiera con la llave de
 * escritura, así que los caracteres de control (ESC, C1, saltos) salen escapados como \uXXXX y se trunca.
 */
// DEL, controles C1 (0x7f-0x9f, incluye el CSI de un byte) y los separadores de línea U+2028/U+2029: JSON.stringify no los escapa.
const C1_Y_SEPARADORES = new RegExp('[' + String.fromCharCode(0x7f) + '-' + String.fromCharCode(0x9f) + String.fromCharCode(0x2028) + String.fromCharCode(0x2029) + ']', 'g');
function nombreMostrable(nombre) {
  const s = JSON.stringify(String(nombre)).slice(1, -1)
    .replace(C1_Y_SEPARADORES, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

/**
 * ¿El nombre de un blob es `<maquina>/<volcado, hilo o cambio>`, o `<maquina>/registros/<registro o cobertura>` (los
 * registros de frenos y escapes que cuenta el reductor, story 2.5)? Devuelve { maquina, archivo } (archivo
 * relativo a la carpeta de la máquina) o null. Ninguna otra subcarpeta se acepta.
 */
function formaDelNombre(nombre) {
  const partes = String(nombre).split('/');
  // story 2.24: lo que se volvió a subir lleva una versión — `<maquina>/v<versión>/<corrida>` y
  // `<maquina>/registros/v<versión>/<registro>`, con la versión EXACTA; `archivo` es la ruta de siempre, sin la versión.
  if (partes.length === 4 && partes[1] === 'registros' && FORMA_MAQUINA.test(partes[0]) && FORMA_VERSION.test(partes[2]) && FORMA_REGISTRO.test(partes[3])) {
    return { maquina: partes[0], archivo: `registros/${partes[3]}`, version: partes[2] };
  }
  if (partes.length === 3 && partes[1] === 'registros' && FORMA_MAQUINA.test(partes[0]) && FORMA_REGISTRO.test(partes[2])) {
    return { maquina: partes[0], archivo: `registros/${partes[2]}`, version: null };
  }
  if (partes.length === 3 && FORMA_MAQUINA.test(partes[0]) && FORMA_VERSION.test(partes[1]) && FORMA_ARCHIVO.test(partes[2])) {
    return { maquina: partes[0], archivo: partes[2], version: partes[1] };
  }
  if (partes.length !== 2) return null;
  const [maquina, archivo] = partes;
  if (!FORMA_MAQUINA.test(maquina) || !FORMA_ARCHIVO.test(archivo)) return null;
  return { maquina, archivo, version: null };
}

/** Un GET con token. Resuelve { status, cuerpo, cabeceras } o { error } — nunca rechaza. */
function pedir(url, token, timeoutMs) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    let hecho = false;
    const fin = (r) => { if (!hecho) { hecho = true; resolve(r); } };
    const req = mod.request(u, { method: 'GET', headers: { Authorization: `Bearer ${token}`, 'x-ms-version': X_MS_VERSION }, timeout: timeoutMs }, (res) => {
      const trozos = [];
      res.on('data', (c) => trozos.push(c));
      res.on('end', () => fin({ status: res.statusCode, cuerpo: Buffer.concat(trozos), cabeceras: res.headers }));
      res.on('error', (e) => fin({ error: e }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => fin({ error: e }));
    req.end();
  });
}

/** El token de storage con la sesión de az que ya existe. { token } o { estado, motivo }. Nunca pregunta. */
function tokenDeAz(tenant) {
  const bin = process.env.TYCON_AZ_BIN || 'az';
  const args = ['account', 'get-access-token', '--resource', 'https://storage.azure.com/', '--query', 'accessToken', '-o', 'tsv'];
  if (tenant) args.push('--tenant', tenant);
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 45000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AZURE_CORE_NO_COLOR: '1', AZURE_CORE_ONLY_SHOW_ERRORS: '1' } });
  if (r.error && r.error.code === 'ENOENT') return { estado: 'sin_az', motivo: `no hay az en esta máquina (${bin}): el buzón sólo lo leen quienes tienen el rol de lectura, con su sesión de az` };
  if (r.error) return { estado: 'sin_sesion', motivo: `az no respondió (${r.error.code || r.error.message}): no se pide un login desde acá` };
  const token = String(r.stdout || '').trim();
  if (r.status !== 0 || !token) {
    const err = String(r.stderr || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || `salió ${r.status}`;
    return { estado: 'sin_sesion', motivo: `az no tiene una sesión que sirva para el buzón (${err.slice(0, 160)}): no se pide un login desde acá` };
  }
  return { token };
}

/**
 * El listado entero del contenedor, paginado. { blobs } o { estado, motivo } (con `permiso: true` si es falta del rol).
 * Lo usan la bajada y el informe de re-subidas: los dos leen el buzón de la misma forma.
 */
async function listarTodo(base, token, cfg) {
  const blobs = [];
  let marcador = '';
  for (let vuelta = 0; vuelta < 1000; vuelta++) {
    const url = `${base}?restype=container&comp=list&maxresults=5000${marcador ? `&marker=${encodeURIComponent(marcador)}` : ''}`;
    const r = await pedir(url, token, 60000);
    if (r.error) return { estado: 'sin_red', motivo: `sin red o sin respuesta del buzón al listar (${r.error.code || r.error.message}): no se bajó nada` };
    if (r.status === 401 || r.status === 403) return { permiso: true, motivo: `esta cuenta de az no tiene el rol de lectura sobre el buzón (${r.status}): sólo lo lee quien fue autorizado` };
    if (r.status === 404) return { estado: 'sin_contenedor', motivo: `el contenedor ${cfg.contenedor} no existe en ${cfg.cuenta} (404)` };
    if (r.status !== 200) return { estado: 'servicio_fallo', motivo: `el buzón contestó ${r.status} al listar: no se bajó nada` };
    const pagina = leerListado(r.cuerpo.toString('utf8'));
    blobs.push(...pagina.blobs);
    if (!pagina.siguiente) break;
    marcador = pagina.siguiente;
  }
  return { blobs };
}

// story 2.24: la versión del arnés que trae «nombre nuevo por subida». Una máquina que declara en su place.json una
// versión igual o posterior está lista para que la política del buzón pase a «sólo crear». Es la de version.json del
// pedido que la trae: si otro pedido sube la versión antes del merge, se corre con ella.
const VERSION_SOLO_CREAR = '2026.10.15.33';
const DIAS_AUSENTE = 14;

/** Compara dos versiones `AAAA.MM.DD.N` por sus números. */
function compararVersiones(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** El tipo de un blob para el informe: por su forma, nunca por su máquina. */
function tipoDelBlob(forma) {
  if (!forma) return 'ignorado';
  if (forma.archivo.startsWith('registros/')) return 'registros';
  if (forma.archivo.endsWith('.hilo.jsonl.gz')) return 'hilo';
  if (forma.archivo.endsWith('.cambio.json.gz')) return 'cambio';
  return 'volcado';
}

/**
 * --overwrites-report (story 2.24, AC 1 y 15): cuántos blobs del buzón fueron re-escritos (última modificación más de 1 s
 * después de la creación), por tipo y por máquina CON SU ALIAS, y si cada máquina está lista para «sólo crear» según el
 * place.json más nuevo del espejo. Sólo LISTA: no baja contenido, no escribe el espejo ni sellos. El resultado es un
 * objeto propio, sin `ignorados_nombres` ni motivos que nombren blobs: los nombres traen la máquina, que se llama como
 * una persona. Sin az, sin sesión o sin el rol: exit 0 y «no medido», como la bajada.
 */
async function informeDeReescrituras(opts = {}) {
  const res = { estado: null, motivo: null, codigo: null };
  const fin = (codigo, estado, motivo) => { res.codigo = codigo; res.estado = estado; if (motivo) res.motivo = motivo; return { codigo, res }; };
  const dirBuzon = path.resolve(readEnv('TYCON_MAILBOX_DIR', { where: DONDE }) || path.join(CASA_PIPELINE, 'corridas-buzon'));
  for (const llave of ['mailbox', 'ado']) {
    const integ = integracionBuzon(llave);
    if (integ.error) return fin(2, 'config_rota', integ.error);
    if (!integ.prendida) return fin(0, 'apagado', integ.apagada);
  }
  const lc = leerConfig(['cuenta', 'contenedor', 'tenant']);
  if (!lc.cfg) return fin(1, lc.estado, lc.motivo);
  const { cfg } = lc;
  const tk = tokenDeAz(cfg.tenant.trim());
  if (!tk.token) return fin(0, 'no_medido', tk.motivo);
  const ls = await listarTodo(`${urlBase(cfg)}/${encodeURIComponent(cfg.contenedor)}`, tk.token, cfg);
  if (ls.permiso) return fin(0, 'no_medido', ls.motivo);
  if (ls.estado) return fin(1, ls.estado, ls.motivo);
  let aliasDeNombre;
  try { ({ aliasDeNombre } = require('../nightly/dashboard/reducer.js')); }
  catch (e) { return fin(1, 'sin_reductor', `no se pudo cargar el alias de las máquinas (scripts/nightly/dashboard/reducer.js: ${e.code || e.name})`); }

  // sin una de las dos fechas, el blob es «no medido» —nunca «no re-escrito»—, y se cuenta aparte
  const cuenta = () => ({ blobs: 0, reescritos: 0, sin_fecha_de_creacion: 0, sin_fecha_de_modificacion: 0 });
  const sumar = (c, b) => {
    c.blobs += 1;
    if (b.creado === null) c.sin_fecha_de_creacion += 1;
    else if (b.modificado === null) c.sin_fecha_de_modificacion += 1;
    else if (b.modificado - b.creado > 1000) c.reescritos += 1;
  };
  const total = cuenta();
  const porTipo = { registros: cuenta(), volcado: cuenta(), hilo: cuenta(), cambio: cuenta(), ignorado: cuenta() };
  const porMaquina = new Map();
  for (const b of ls.blobs) {
    const forma = formaDelNombre(b.nombre);
    sumar(total, b);
    sumar(porTipo[tipoDelBlob(forma)], b);
    if (!forma) continue;
    if (!porMaquina.has(forma.maquina)) porMaquina.set(forma.maquina, { ...cuenta(), ultima: null });
    const m = porMaquina.get(forma.maquina);
    sumar(m, b);
    const t = b.modificado !== null ? b.modificado : b.creado;
    if (t !== null && (m.ultima === null || t > m.ultima)) m.ultima = t;
  }
  const ahora = Date.now();
  const maquinas = [];
  const ausentes = [];
  for (const [nombre, m] of porMaquina) {
    const alias = aliasDeNombre(nombre);
    let version = null;
    let versionDia = null;
    try {
      const place = JSON.parse(fs.readFileSync(path.join(dirBuzon, nombre, 'registros', 'place.json'), 'utf8'));
      const v = place && place.install && place.install.version;
      version = typeof v === 'string' && /^\d{4}\.\d{2}\.\d{2}\.\d{1,4}$/.test(v) ? v : null;
      versionDia = place && typeof place.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(place.day) ? place.day : null;
    } catch (_) { /* sin place.json en el espejo: no medido */ }
    const lista = version === null ? 'no medido' : (compararVersiones(version, VERSION_SOLO_CREAR) >= 0 ? 'sí' : 'no');
    const ultima = m.ultima === null ? null : new Date(m.ultima).toISOString().slice(0, 10);
    maquinas.push({ alias, blobs: m.blobs, reescritos: m.reescritos, sin_fecha_de_creacion: m.sin_fecha_de_creacion, sin_fecha_de_modificacion: m.sin_fecha_de_modificacion, ultima_subida: ultima, version, version_dia: versionDia, lista });
    if (m.ultima === null || ahora - m.ultima > DIAS_AUSENTE * 86400000) ausentes.push(alias);
  }
  maquinas.sort((a, b) => (a.alias < b.alias ? -1 : 1));
  ausentes.sort();
  Object.assign(res, {
    blobs: total.blobs, reescritos: total.reescritos, sin_fecha_de_creacion: total.sin_fecha_de_creacion, sin_fecha_de_modificacion: total.sin_fecha_de_modificacion, ignorados: porTipo.ignorado.blobs,
    por_tipo: porTipo, maquinas, ausentes, version_solo_crear: VERSION_SOLO_CREAR, dias_ausente: DIAS_AUSENTE,
  });
  if (opts.log) opts.log(`informe de re-subidas: ${total.blobs} blob(s), ${total.reescritos} re-escrito(s), ${total.sin_fecha_de_creacion + total.sin_fecha_de_modificacion} sin fecha de creación o de modificación (no medido) · ${maquinas.length} máquina(s), ${maquinas.filter((x) => x.lista === 'sí').length} lista(s) para «sólo crear», ${ausentes.length} ausente(s) hace más de ${DIAS_AUSENTE} días`);
  return fin(0, 'medido');
}

/**
 * story 2.28 (decisiones 11 y 13): qué carpeta vieja del espejo es la historia de qué carpeta nueva. Cada máquina sube
 * ahora a `<nombre>-<código>` y declara en su `registros/place.json` `folder.previous_folder` (la carpeta de antes) y
 * `folder.moved_on` (el día de la mudanza). Una vieja se UNE a su nueva sólo si exactamente UNA carpeta la declara y la
 * vieja no recibió nada después de esa mudanza (ni un volcado con fecha posterior, ni un place.json de un día posterior).
 * Si la declaran dos o más (dos máquinas con el mismo nombre, o un código regenerado) queda `compartida`; si siguió
 * recibiendo (otra máquina con el mismo nombre que todavía no actualizó), `siguio_recibiendo`: ninguna de las dos se une,
 * y las ve sólo quien mantiene. Una carpeta que nadie declara no aparece (sigue siendo una máquina como hoy). Las carpetas
 * cuyo código se regeneró van en `regeneradas`. Sin correos ni rutas: sólo nombres de carpeta y días. Sólo lee; lo que no
 * se puede leer no declara nada. Es LA definición de la regla: el reductor, la poda y la vista leen el archivo que deja
 * la bajada (`.carpetas-de-maquina.json`), y el sitio (`people.js`) llama a esta función.
 */
const DIA = /^\d{4}-\d{2}-\d{2}$/;
// un texto que viene del place.json de OTRA máquina: sin controles ni separadores de línea, y acotado
// (armada con fromCharCode: escritos literales en el fuente, los separadores de línea cortan la expresión)
const NO_IMPRIMIBLES = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`, 'g');
const textoAjeno = (s) => String(s || '').replace(NO_IMPRIMIBLES, ' ').trim().slice(0, 120);
function carpetasDeMaquina(espejoDir, opts = {}) {
  // ningún día de un place.json puede ser posterior a hoy (con un día de margen por los husos horarios): con un día a
  // futuro, la vieja «nunca seguiría recibiendo» y quedaría unida a quien la declara (segunda vuelta de seguridad)
  const limite = new Date(Date.parse(`${opts.hoy || new Date().toISOString().slice(0, 10)}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const out = { schema: 1, carpetas: {}, regeneradas: {}, no_leidas: [] };
  let nombres = [];
  // 🔴 «No pude mirar el espejo» no es «no hay uniones»: sale `no_medido` y no se escribe el archivo (pase de fallos
  //    silenciosos). Un espejo que todavía no existe sí es «nada que unir».
  try { nombres = fs.readdirSync(espejoDir, { withFileTypes: true }).filter((e) => e.isDirectory() && FORMA_MAQUINA.test(e.name)).map((e) => e.name); }
  catch (e) { if (e.code === 'ENOENT') return out; return { ...out, no_medido: `el espejo del buzón no se pudo listar (${e.code || 'error'})` }; }
  const existe = new Set(nombres);
  const leerPlace = (n) => {
    try { return JSON.parse(fs.readFileSync(path.join(espejoDir, n, 'registros', 'place.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') out.no_leidas.push({ carpeta: n, motivo: e instanceof SyntaxError ? 'place.json no es JSON válido' : `place.json no se pudo leer (${e.code || 'error'})` }); return null; }
  };
  // 🔴 Una declaración vale sólo con forma (pase adversarial): el buzón lo escribe cualquiera con la llave. La carpeta que
  //    declara es EXACTAMENTE `<vieja>-<código de 8 hexadecimales>` (la que arma upload-runs.js), la mudanza es una fecha
  //    real y no posterior al día de su place.json, y la vieja no es a su vez una carpeta que declara (no hay cadenas ni
  //    ciclos). Sin eso una máquina podía declarar como suya la carpeta con código de otra y quedarse con sus corridas.
  const fechaReal = (f) => DIA.test(String(f)) && new Date(`${f}T00:00:00Z`).toISOString().slice(0, 10) === f;
  const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declarantes = new Map();   // carpeta nueva → { vieja, desde, reemplaza: [carpetas con código anteriores] }
  for (const n of nombres) {
    const p = leerPlace(n);
    const f = p && p.folder;
    if (!f || typeof f !== 'object' || f.name !== n || !FORMA_CODIGO.test(String(f.code))) continue;
    const vieja = f.previous_folder;
    if (typeof vieja !== 'string' || !FORMA_MAQUINA.test(vieja) || n !== `${vieja}-${f.code}`) continue;
    if (!fechaReal(f.moved_on) || !fechaReal(p.day) || f.moved_on > p.day || p.day > limite) continue;
    const regenerada = f.code_regenerated && typeof f.code_regenerated === 'object' && fechaReal(f.code_regenerated.on) ? f.code_regenerated : null;
    if (regenerada) out.regeneradas[n] = { on: regenerada.on, reason: textoAjeno(regenerada.reason) };
    // un código regenerado nombra las carpetas con código anteriores de la misma máquina (de su registro de subidas):
    // sólo si de verdad se regeneró el día de su mudanza, sólo las del mismo nombre base, y nunca ella misma
    const mismaBase = new RegExp(`^${escapar(vieja)}-[0-9a-f]{8}$`);
    const reemplaza = regenerada && regenerada.on === f.moved_on && Array.isArray(f.superseded_folders)
      ? f.superseded_folders.filter((s) => typeof s === 'string' && s !== n && mismaBase.test(s)) : [];
    // la huella de lo que la máquina subió a cada carpeta que declara (tercera vuelta de seguridad)
    const huellas = f.superseded_runs_sha256 && typeof f.superseded_runs_sha256 === 'object' ? f.superseded_runs_sha256 : {};
    declarantes.set(n, { vieja, desde: f.moved_on, reemplaza, huella: f.previous_runs_sha256, huellas });
  }
  const declaraciones = new Map();   // vieja → [{ nueva, desde }]
  const reemplazos = new Map();      // carpeta con código anterior → [{ nueva, desde }]
  for (const [n, d] of declarantes) {
    if (!declarantes.has(d.vieja)) {   // una carpeta que declara su propia vieja no es la vieja de nadie
      if (!declaraciones.has(d.vieja)) declaraciones.set(d.vieja, []);
      declaraciones.get(d.vieja).push({ nueva: n, desde: d.desde, huella: d.huella });
    }
    for (const s of d.reemplaza) {
      if (!reemplazos.has(s)) reemplazos.set(s, []);
      reemplazos.get(s).push({ nueva: n, desde: d.desde, huella: d.huellas[s] });
    }
  }
  // lo último que recibió una carpeta: el día más nuevo de sus volcados (por su nombre) y de su place.json. null si no se
  // pudo mirar: entonces no se puede afirmar que no recibió nada, y la vieja no se une.
  const ultimoDia = (n) => {
    let ultimo = '';
    try {
      for (const a of fs.readdirSync(path.join(espejoDir, n))) {
        const m = /(\d{4}-\d{2}-\d{2})T\d{4}/.exec(a);
        if (m && a.endsWith('.json') && m[1] > ultimo) ultimo = m[1];
      }
    } catch (e) { out.no_leidas.push({ carpeta: n, motivo: `la carpeta no se pudo listar (${e.code || 'error'})` }); return null; }
    const p = leerPlace(n);
    if (p && DIA.test(String(p.day)) && p.day > ultimo) ultimo = p.day;
    return ultimo;
  };
  // la misma regla para la carpeta vieja de nombre y para la carpeta con código que reemplazó un código regenerado
  const unir = (vieja, ds) => {
    if (!existe.has(vieja) || out.carpetas[vieja]) return;
    const desde = ds.map((d) => d.desde).sort()[0];
    if (ds.length > 1) { out.carpetas[vieja] = { estado: 'compartida', nueva: null, declarantes: ds.length, desde }; return; }
    const ultimo = ultimoDia(vieja);
    if (ultimo === null) return;   // no se pudo mirar: no se une (queda en no_leidas, y la carpeta se cuenta sola, como hoy)
    // 🔴 La unión pide además la HUELLA de las corridas que la máquina subió a la vieja (de su registro de subidas; la
    //    llave no deja listar el buzón, así que nadie más la sabe): si no coincide con lo que hay en la carpeta, la
    //    carpeta tiene corridas que esa máquina no subió — no se une, y cuenta como una máquina propia, como la que
    //    siguió recibiendo (tercera vuelta de seguridad, decisión del dueño del 2026-10-15).
    let nombres = [];
    try { nombres = fs.readdirSync(path.join(espejoDir, vieja)); } catch (_) { nombres = null; }
    const coincide = nombres !== null && typeof ds[0].huella === 'string' && ds[0].huella === huellaDeCorridas(nombres);
    const estado = ultimo > desde || !coincide ? 'siguio_recibiendo' : 'unida';
    out.carpetas[vieja] = { estado, nueva: estado === 'unida' ? ds[0].nueva : null, declarantes: 1, desde };
  };
  for (const [vieja, ds] of [...declaraciones].sort((a, b) => (a[0] < b[0] ? -1 : 1))) unir(vieja, ds);
  for (const [vieja, ds] of [...reemplazos].sort((a, b) => (a[0] < b[0] ? -1 : 1))) unir(vieja, ds);
  return out;
}

/** Deja la unión en el espejo (story 2.28): `.carpetas-de-maquina.json`. Devuelve null si pudo, o el motivo. */
function escribirCarpetasDeMaquina(espejoDir) {
  const u = carpetasDeMaquina(espejoDir);
  // sin poder mirar el espejo no se escribe: un archivo con cero uniones pisaría uno bueno y diría «medidas»
  if (u.no_medido) return `no se escribió .carpetas-de-maquina.json: ${u.no_medido}`;
  try { escribirAtomico(path.join(espejoDir, '.carpetas-de-maquina.json'), `${JSON.stringify(u, null, 1)}\n`); return null; }
  catch (e) { return `no se pudo escribir .carpetas-de-maquina.json (${e.code || 'error'})`; }
}

async function bajar(opts = {}) {
  const res = { bajado: false, estado: null, motivo: null, codigo: null, completo: false, blobs: 0, bajados: 0, bytes: 0, al_dia: 0, ignorados: 0, ignorados_nombres: [], omitidos: 0, versiones_viejas: 0, versiones_incompletas: 0, sin_tiempo: 0, aviso: null };
  const log = (m) => { if (opts.log) opts.log(m); };
  // story 2.28: desde que el listado se leyó, toda pasada —también la parcial— deja la unión de carpetas en el espejo
  let espejoParaUniones = null;
  // Una pasada que no terminó bien nunca dice «bajado»: lo que sí bajó queda en disco y contado en `bajados`.
  const fin = (codigo, estado, motivo) => {
    if (espejoParaUniones) { const m = escribirCarpetasDeMaquina(espejoParaUniones); res.uniones = m || 'escritas'; if (m) log(m); }
    res.estado = estado; if (motivo) res.motivo = motivo; if (codigo !== 0) res.bajado = false;
    // story 2.12: el único criterio de «leído entero» (ver la cabecera).
    res.codigo = codigo;
    res.completo = codigo === 0 && (estado === 'bajado' || estado === 'al_dia') && res.sin_tiempo === 0;
    return { codigo, res };
  };
  const sinHilos = opts.sinHilos === true;

  const where = DONDE;
  const dirBuzon = path.resolve(readEnv('TYCON_MAILBOX_DIR', { where }) || path.join(CASA_PIPELINE, 'corridas-buzon'));
  const casa = path.dirname(dirBuzon);
  const rutaIndice = path.resolve(readEnv('TYCON_DOWNLOADS_LOG', { where }) || path.join(casa, 'mailbox-downloads.json'));

  // 0 · las integraciones (story 8.3, AC 9/10): el buzón apagado → exit 0 y una línea; y bajar necesita la sesión de az,
  //     así que Azure DevOps apagada → exit 0 y una línea. Configuración rota → exit 2 con archivo, clave y motivo.
  for (const llave of ['mailbox', 'ado']) {
    const integ = integracionBuzon(llave);
    if (integ.error) { log(integ.error); return fin(2, 'config_rota', integ.error); }
    if (!integ.prendida) { log(integ.apagada); return fin(0, 'apagado', integ.apagada); }
  }

  const lc = leerConfig(['cuenta', 'contenedor', 'tenant']);
  if (!lc.cfg) return fin(1, lc.estado, lc.motivo);
  const { cfg } = lc;

  // Sin permiso para leer: exit 0, sin carpeta, una vez por día.
  const sinPermiso = (estado, motivo) => {
    res.aviso = selloDiario(path.join(casa, 'download-runs-no-permission.seal'), `${estado}: ${motivo}`);
    if (res.aviso === 'emitido') log(`no se bajan las corridas del buzón: ${motivo}`);
    return fin(0, estado, motivo);
  };

  const tk = tokenDeAz(cfg.tenant.trim());
  if (!tk.token) return sinPermiso(tk.estado, tk.motivo);

  const base = `${urlBase(cfg)}/${encodeURIComponent(cfg.contenedor)}`;
  const inicio = Date.now();
  const tope = Number.isFinite(opts.budgetMs) ? opts.budgetMs : 120000;

  // 1 · el listado entero (paginado)
  const ls = await listarTodo(base, tk.token, cfg);
  if (ls.permiso) return sinPermiso('sin_permiso', ls.motivo);
  if (ls.estado) return fin(1, ls.estado, ls.motivo);
  const listado = ls.blobs;
  res.blobs = listado.length;
  espejoParaUniones = dirBuzon;

  let indice = { version: 1, destino: `${cfg.cuenta}/${cfg.contenedor}`, blobs: {} };
  try {
    const i = JSON.parse(fs.readFileSync(resolveFile(rutaIndice, { where }), 'utf8'));
    if (i && i.destino === indice.destino && i.blobs && typeof i.blobs === 'object') indice = i;
  } catch (_) { /* sin índice: se compara por MD5, y lo que no traiga MD5 se baja una vez */ }

  // 2 · qué falta o cambió
  const md5Local = (ruta, st, previo) => {
    if (previo && previo.md5 && previo.size === st.size && Math.floor(previo.mtimeMs) === Math.floor(st.mtimeMs)) return previo.md5;
    return crypto.createHash('md5').update(fs.readFileSync(ruta)).digest('base64');
  };
  const pendientes = [];
  const noLeidos = [];
  // story 2.24: lo que se volvió a subir lleva versión. ANTES de comparar con el disco se elige, por clave, qué blob es
  // «el de ahora»: de una corrida, la versión más nueva (el nombre de siempre es la más vieja); de los registros de una
  // máquina, el juego más nuevo que está COMPLETO. El espejo queda con la ruta de siempre: los lectores no cambian.
  const porClave = new Map();
  const juegos = new Map();
  for (const b of listado) {
    const forma = formaDelNombre(b.nombre);
    if (!forma || !Number.isFinite(b.largo)) { res.ignorados += 1; if (res.ignorados_nombres.length < 20) res.ignorados_nombres.push(nombreMostrable(b.nombre)); continue; }
    // story 2.12: sin hilos ni se mira el disco — la conversación no se baja.
    // `--no-threads` es «bajá lo que la página necesita»: el hilo y el cambio de git traen código de todos los
    // repos y el nocturno del tablero no los usa (pase adversarial, story 2.19). De TODAS sus versiones.
    if (sinHilos && /\.(hilo\.jsonl|cambio\.json)\.gz$/.test(forma.archivo)) { res.omitidos += 1; continue; }
    if (forma.archivo.startsWith('registros/')) {
      if (!juegos.has(forma.maquina)) juegos.set(forma.maquina, new Map());
      const vs = juegos.get(forma.maquina);
      const v = forma.version || '';
      if (!vs.has(v)) vs.set(v, new Map());
      vs.get(v).set(forma.archivo, { b, forma });
    } else {
      const k = `${forma.maquina}/${forma.archivo}`;
      if (!porClave.has(k)) porClave.set(k, []);
      porClave.get(k).push({ b, forma });
    }
  }
  const elegidos = [];
  for (const lista of porClave.values()) {
    lista.sort((x, y) => ((x.forma.version || '') < (y.forma.version || '') ? -1 : 1));
    elegidos.push(lista[lista.length - 1]);
    res.versiones_viejas += lista.length - 1;
  }
  const urlDe = (nombre) => `${base}/${nombre.split('/').map(encodeURIComponent).join('/')}`;
  // la cobertura que se leyó para decidir si un juego está completo no se vuelve a pedir al bajarlo
  const coberturasLeidas = new Map();
  const juegoCompleto = async (maquina, juego) => {
    const cob = juego.get('registros/cobertura.json');
    if (!cob) return { completo: false };
    let texto = null;
    try {
      const local = path.join(dirBuzon, maquina, 'registros', 'cobertura.json');
      const cuerpo = fs.readFileSync(local);
      if (cob.b.md5 && crypto.createHash('md5').update(cuerpo).digest('base64') === cob.b.md5) texto = cuerpo;
    } catch (_) { /* no está en el espejo: se pide */ }
    if (texto === null) {
      const r = await pedir(urlDe(cob.b.nombre), tk.token, 60000);
      if (r.error) return { estado: 'sin_red', motivo: `sin red a mitad de la bajada (${r.error.code || r.error.message}) al leer ${cob.b.nombre}` };
      if (r.status === 401 || r.status === 403) return { estado: 'sin_permiso_a_mitad', motivo: `el buzón dejó listar pero no leer ${cob.b.nombre} (${r.status})` };
      // 🔴 Un error del servicio NO es «el juego está incompleto»: tomar en silencio la versión anterior dejaría el espejo
      //    con datos viejos y la pasada diciendo «leída entera».
      if (r.status !== 200) return { estado: 'servicio_fallo', motivo: `el buzón contestó ${r.status} al leer ${cob.b.nombre}: no se pudo saber si ese juego de registros está completo` };
      texto = r.cuerpo;
      coberturasLeidas.set(cob.b.nombre, r);
    }
    // Una cobertura que no se puede leer tampoco es «incompleto»: se dice (la pasada sale parcial) y se sigue con la
    // versión anterior, que queda en el espejo como hoy.
    let c;
    try { c = JSON.parse(texto.toString('utf8')); } catch (_) { c = null; }
    if (!c || !c.fuentes || typeof c.fuentes !== 'object') {
      noLeidos.push(`${cob.b.nombre} (cobertura ilegible: no se puede saber si el juego está completo)`);
      return { completo: false, ilegible: true };
    }
    for (const [id, f] of Object.entries(c.fuentes)) {
      if (!f || f.estado !== 'medido') continue;
      const reg = REGISTROS.find((x) => x.replace(/\.[^.]+$/, '') === id);
      if (reg && !juego.has(`registros/${reg}.gz`)) return { completo: false };   // una fuente que este arnés no conoce no se exige
    }
    return { completo: true };
  };
  for (const [maquina, vs] of juegos) {
    // los juegos versionados, del más nuevo al más viejo; el de nombres de siempre es el más viejo de todos
    const versiones = [...vs.keys()].filter(Boolean).sort().reverse();
    let elegido = null;
    for (const v of versiones) {
      const r = await juegoCompleto(maquina, vs.get(v));
      if (r.estado) return fin(1, r.estado, `${r.motivo}${res.bajados ? ` — ${res.bajados} sí bajaron` : ''}`);
      if (r.completo) { elegido = v; break; }
      if (!r.ilegible) res.versiones_incompletas += 1;   // la ilegible ya quedó en no_leidos: no es «incompleta»
    }
    if (elegido === null && vs.has('')) elegido = '';
    if (elegido === null) continue;
    for (const v of vs.keys()) if (v !== elegido && (v === '' || v < elegido)) res.versiones_viejas += 1;
    elegidos.push(...vs.get(elegido).values());
  }
  for (const { b, forma } of elegidos) {
    const local = path.join(dirBuzon, forma.maquina, forma.archivo);
    const previo = indice.blobs[b.nombre];
    let st = null;
    try { st = fs.statSync(local); } catch (e) { if (e.code !== 'ENOENT') { noLeidos.push(`${b.nombre} (${e.code})`); continue; } }
    if (st && st.size === b.largo) {
      let igual;
      try { igual = b.md5 ? md5Local(local, st, previo) === b.md5 : Boolean(previo && previo.etag && previo.etag === b.etag); }
      catch (e) { noLeidos.push(`${b.nombre} (${e.code || e.message})`); continue; }
      if (igual) { res.al_dia += 1; continue; }
    }
    pendientes.push({ ...b, ...forma, local });
  }

  // 🔴 Los REGISTROS primero (story 2.5): los .gz de cada máquina, después su cobertura, y recién ahí las corridas.
  //    Con el orden del listado (bypass, cobertura, gates) un corte dejaba la cobertura nueva junto a un gates viejo,
  //    y los registros esperaban detrás de todas las corridas de la máquina.
  const rango = (p) => (p.archivo.startsWith('registros/') ? (p.archivo === 'registros/cobertura.json' ? 1 : 0) : 2);
  pendientes.sort((a, b) => rango(a) - rango(b) || (a.nombre < b.nombre ? -1 : a.nombre > b.nombre ? 1 : 0));

  // Lo que no se baja se NOMBRA: la llave de escritura está en el repo, así que cualquiera puede dejar un
  // nombre sin forma de corrida, y la vista nunca lo va a ver (no llega al disco).
  if (res.ignorados) log(`${res.ignorados} blob(s) del buzón no tienen forma <maquina>/<volcado, hilo o cambio> y no se bajaron: ${res.ignorados_nombres.join(', ')}${res.ignorados > res.ignorados_nombres.length ? '…' : ''}`);

  // 3 · bajar, archivo por archivo, dentro del presupuesto
  // el viejo (de antes del renombre) pasa al nuevo antes de la primera escritura: el que se escribe ya lo trae en `indice`
  const guardarIndice = () => { prepareStateWrite(rutaIndice, { where }); escribirAtomico(rutaIndice, JSON.stringify(indice, null, 1) + '\n'); };
  const malos = [];
  // La cobertura de una máquina se escribe sólo si ninguno de SUS registros falló en esta pasada.
  // 🔴 `.jsonl.gz` también (story 2.9): sin eso, una falla de hallazgos.jsonl.gz no retenía la cobertura.
  // 🔴 Y por NOMBRE, sacado de REGISTROS de la subida (story 8.9, tanda E): la expresión escrita a mano no veía el guion de
  //    `legacy-names.jsonl.gz`. Una sola lista: un registro nuevo entra solo, como en la subida.
  // story 2.24: el nombre puede traer la versión (`<maq>/registros/v…/<registro>`): se mira el ÚLTIMO tramo.
  const tramos = (x) => x.replace(/ \(.*$/, '').split('/');
  const esFallaDeRegistro = (x) => REGISTROS.some((r) => tramos(x)[1] === 'registros' && tramos(x)[tramos(x).length - 1] === `${r}.gz`);
  const maquinasConRegistroFallido = new Set(noLeidos.filter(esFallaDeRegistro).map((x) => x.split('/')[0]));
  const falloRegistro = (p) => { if (p.archivo.startsWith('registros/') && p.archivo !== 'registros/cobertura.json') maquinasConRegistroFallido.add(p.maquina); };
  for (let i = 0; i < pendientes.length; i++) {
    if (Date.now() - inicio > tope) { res.sin_tiempo = pendientes.length - i; break; }
    const p = pendientes[i];
    if (p.archivo === 'registros/cobertura.json' && maquinasConRegistroFallido.has(p.maquina)) {
      malos.push(`${p.nombre} (retenida: un registro de esa máquina no bajó)`);
      continue;
    }
    // story 2.24: el blob se pide por su nombre en el buzón (con su versión, si la tiene); se escribe en la ruta de siempre
    const r = coberturasLeidas.get(p.nombre) || await pedir(urlDe(p.nombre), tk.token, Math.max(60000, Math.min(300000, p.largo / 20)));
    if (r.error) return fin(1, 'sin_red', `sin red a mitad de la bajada (${r.error.code || r.error.message}) en ${p.nombre}${res.bajados ? ` — ${res.bajados} sí bajaron` : ''}`);
    if (r.status === 401 || r.status === 403) return fin(1, 'sin_permiso_a_mitad', `el buzón dejó listar pero no leer ${p.nombre} (${r.status})${res.bajados ? ` — ${res.bajados} sí bajaron` : ''}`);
    if (r.status !== 200) { malos.push(`${p.nombre} (${r.status})`); falloRegistro(p); continue; }
    const md5 = crypto.createHash('md5').update(r.cuerpo).digest('base64');
    const esperado = p.md5 || r.cabeceras['content-md5'] || null;
    if (r.cuerpo.length !== p.largo || (esperado && esperado !== md5)) { malos.push(`${p.nombre} (llegó distinto: ${r.cuerpo.length} bytes)`); falloRegistro(p); continue; }
    const tmp = `${p.local}.tmp-${process.pid}`;
    let st;
    try {
      fs.mkdirSync(path.dirname(p.local), { recursive: true });
      fs.writeFileSync(tmp, r.cuerpo);
      fs.renameSync(tmp, p.local);
      st = fs.statSync(p.local);   // dentro del try: si falla, se cuenta como no bajado en vez de tumbar la pasada
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch (_) { /* nada */ }
      malos.push(`${p.nombre} (no se pudo escribir: ${e.code || e.message})`);
      falloRegistro(p);
      continue;
    }
    indice.blobs[p.nombre] = { etag: p.etag, size: st.size, md5, mtimeMs: st.mtimeMs };
    try { guardarIndice(); } catch (_) { /* el índice sólo ahorra; lo bajado ya está */ }
    res.bajados += 1;
    res.bytes += r.cuerpo.length;
    res.bajado = true;
  }

  if (noLeidos.length || malos.length) {
    if (noLeidos.length) res.no_leidos = noLeidos;
    if (malos.length) res.no_bajados = malos;
    return fin(1, 'parcial', `${[...noLeidos, ...malos].length} archivo(s) no se pudieron bajar o comparar: ${[...noLeidos, ...malos].slice(0, 3).join(', ')}${res.bajados ? ` — ${res.bajados} sí bajaron` : ''}`);
  }
  const omitidos = res.omitidos ? ` · ${res.omitidos} conversación(es) omitida(s) (--no-threads)` : '';
  log(res.bajados
    ? `bajado: ${res.bajados} archivo(s), ${res.bytes} bytes, a ${dirBuzon}${res.sin_tiempo ? ` · ${res.sin_tiempo} quedaron sin tiempo` : ''}${omitidos}`
    : `el buzón está al día en esta máquina (${res.al_dia} archivo(s))${res.sin_tiempo ? ` · ${res.sin_tiempo} quedaron sin tiempo` : ''}${omitidos}`);
  return fin(0, res.bajados ? 'bajado' : (res.sin_tiempo ? 'sin_tiempo' : 'al_dia'));
}

module.exports = { bajar, informeDeReescrituras, leerListado, formaDelNombre, nombreMostrable, compararVersiones, VERSION_SOLO_CREAR, carpetasDeMaquina };

if (require.main === module) {
  require('../lib/legacy-names.js').aliasArgv('scripts/metrics/download-runs.js');
  const args = process.argv.slice(2);
  const valor = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const json = args.includes('--json');
  const budget = valor('--budget-ms');
  const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
  const accion = args.includes('--overwrites-report') ? informeDeReescrituras : bajar;
  accion({
    budgetMs: budget !== undefined ? Number(budget) : undefined,
    sinHilos: args.includes('--no-threads'),
    log: (m) => (json ? console.error : console.log)(`[${stamp()}] ${m}`),
  }).then(({ codigo, res }) => {
    if (res.motivo && codigo !== 0) console.error(`[${stamp()}] ${res.estado}: ${res.motivo}`);
    if (json) console.log(JSON.stringify(res, null, 2));
    process.exitCode = codigo;
  }, (e) => {
    console.error(`[${stamp()}] error inesperado: ${e && e.stack ? e.stack : e}`);
    process.exitCode = 1;
  });
}
