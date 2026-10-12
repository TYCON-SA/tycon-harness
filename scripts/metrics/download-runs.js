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
 * subida escribe);
 * lo demás se cuenta como `ignorados` y no toca el disco. Cada archivo se escribe entero o no se escribe
 * (temporal + rename, verificando tamaño y Content-MD5). Qué ya está al día: tamaño + Content-MD5 del
 * listado contra el archivo local; si el listado no trae MD5, la Etag que se recordó al bajarlo
 * (`~/.claude/.tycon-pipeline/mailbox-downloads.json`). El índice y el sello diario de «sin permiso»
 * (`download-runs-no-permission.seal`) cambiaron de nombre en la story 8.9 (tanda D2): si sólo está el de
 * antes, se lee ése, y antes de escribir el nuevo se le pasa su contenido (scripts/lib/renames.json).
 *
 * Uso:
 *   node scripts/metrics/download-runs.js [--json] [--budget-ms N] [--no-threads]
 *
 *   --no-threads (story 2.12): baja los registros y los volcados, NUNCA los hilos ni los cambios de git
 *   (`*.hilo.jsonl.gz`, `*.cambio.json.gz` — story 2.19: traen código de todos los repos); los cuenta en
 *   `omitidos`. Lo usa el nocturno del tablero: la página no usa las conversaciones —prompts, rutas, código de
 *   clientes— y el agente de Azure no tiene por qué tenerlas.
 *
 *   El resultado dice `codigo` (el de salida) y `completo`: true SÓLO si salió 0, el estado es `bajado` o `al_dia` y
 *   no quedó nada sin tiempo. Es EL criterio de «el buzón se leyó entero»: lo leen el pipeline y el generador del
 *   tablero, que no lo reescriben.
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
const { leerConfig, integracionBuzon, urlBase, FORMA_MAQUINA, FORMA_ARCHIVO, FORMA_REGISTRO, REGISTROS, X_MS_VERSION } = require('./upload-runs.js');

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
    blobs.push({ nombre, largo: Number(campo('Content-Length')), md5: campo('Content-MD5') || null, etag: campo('Etag') || null });
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
  if (partes.length === 3 && partes[1] === 'registros' && FORMA_MAQUINA.test(partes[0]) && FORMA_REGISTRO.test(partes[2])) {
    return { maquina: partes[0], archivo: `registros/${partes[2]}` };
  }
  if (partes.length !== 2) return null;
  const [maquina, archivo] = partes;
  if (!FORMA_MAQUINA.test(maquina) || !FORMA_ARCHIVO.test(archivo)) return null;
  return { maquina, archivo };
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

async function bajar(opts = {}) {
  const res = { bajado: false, estado: null, motivo: null, codigo: null, completo: false, blobs: 0, bajados: 0, bytes: 0, al_dia: 0, ignorados: 0, ignorados_nombres: [], omitidos: 0, sin_tiempo: 0, aviso: null };
  const log = (m) => { if (opts.log) opts.log(m); };
  // Una pasada que no terminó bien nunca dice «bajado»: lo que sí bajó queda en disco y contado en `bajados`.
  const fin = (codigo, estado, motivo) => {
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
  const listado = [];
  let marcador = '';
  for (let vuelta = 0; vuelta < 1000; vuelta++) {
    const url = `${base}?restype=container&comp=list&maxresults=5000${marcador ? `&marker=${encodeURIComponent(marcador)}` : ''}`;
    const r = await pedir(url, tk.token, 60000);
    if (r.error) return fin(1, 'sin_red', `sin red o sin respuesta del buzón al listar (${r.error.code || r.error.message}): no se bajó nada`);
    if (r.status === 401 || r.status === 403) return sinPermiso('sin_permiso', `esta cuenta de az no tiene el rol de lectura sobre el buzón (${r.status}): sólo lo lee quien fue autorizado`);
    if (r.status === 404) return fin(1, 'sin_contenedor', `el contenedor ${cfg.contenedor} no existe en ${cfg.cuenta} (404)`);
    if (r.status !== 200) return fin(1, 'servicio_fallo', `el buzón contestó ${r.status} al listar: no se bajó nada`);
    const pagina = leerListado(r.cuerpo.toString('utf8'));
    listado.push(...pagina.blobs);
    if (!pagina.siguiente) break;
    marcador = pagina.siguiente;
  }
  res.blobs = listado.length;

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
  for (const b of listado) {
    const forma = formaDelNombre(b.nombre);
    if (!forma || !Number.isFinite(b.largo)) { res.ignorados += 1; if (res.ignorados_nombres.length < 20) res.ignorados_nombres.push(nombreMostrable(b.nombre)); continue; }
    // story 2.12: sin hilos ni se mira el disco — la conversación no se baja.
    // `--no-threads` es «bajá lo que la página necesita»: el hilo y el cambio de git traen código de todos los
    // repos y el nocturno del tablero no los usa (pase adversarial, story 2.19).
    if (sinHilos && /\.(hilo\.jsonl|cambio\.json)\.gz$/.test(forma.archivo)) { res.omitidos += 1; continue; }
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
  const esFallaDeRegistro = (x) => REGISTROS.some((r) => x.split('/')[1] === 'registros' && x.split('/')[2] && x.split('/')[2].startsWith(`${r}.gz `));
  const maquinasConRegistroFallido = new Set(noLeidos.filter(esFallaDeRegistro).map((x) => x.split('/')[0]));
  const falloRegistro = (p) => { if (p.archivo.startsWith('registros/') && p.archivo !== 'registros/cobertura.json') maquinasConRegistroFallido.add(p.maquina); };
  for (let i = 0; i < pendientes.length; i++) {
    if (Date.now() - inicio > tope) { res.sin_tiempo = pendientes.length - i; break; }
    const p = pendientes[i];
    if (p.archivo === 'registros/cobertura.json' && maquinasConRegistroFallido.has(p.maquina)) {
      malos.push(`${p.nombre} (retenida: un registro de esa máquina no bajó)`);
      continue;
    }
    const url = `${base}/${encodeURIComponent(p.maquina)}/${encodeURIComponent(p.archivo)}`;
    const r = await pedir(url, tk.token, Math.max(60000, Math.min(300000, p.largo / 20)));
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

module.exports = { bajar, leerListado, formaDelNombre, nombreMostrable };

if (require.main === module) {
  require('../lib/legacy-names.js').aliasArgv('scripts/metrics/download-runs.js');
  const args = process.argv.slice(2);
  const valor = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const json = args.includes('--json');
  const budget = valor('--budget-ms');
  const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
  bajar({
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
