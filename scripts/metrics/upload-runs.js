#!/usr/bin/env node
'use strict';
/*
 * upload-runs.js — LAS CORRIDAS DEL PIPELINE, AL BUZÓN DE AZURE STORAGE (story 2.16, rediseño 2026-09-15)
 *
 * Sube lo nuevo o lo que creció del registro de corridas de esta máquina
 * (`~/.claude/.tycon-pipeline/timing-history/`: el volcado `<story>-<ts>.json` y su
 * `<story>-<ts>.hilo.jsonl.gz`) al contenedor privado del buzón, como `<maquina>/<archivo>`. Lo lanza el
 * instalador en cada arranque, en segundo plano, después del barrido de la 2.13. Todas las máquinas del
 * equipo suben; sólo pueden leer quienes tienen el rol de lectura (lo baja `download-runs.js`, con su cuenta).
 *
 * 🔴 LA LLAVE SÓLO CREA (story 2.24). `corridas-buzon.json` (en la capa del equipo, excepción escrita a la política de
 *    credenciales del repo) trae una SAS atada a una política guardada del contenedor con permiso `c` («sólo crear»): crea blobs
 *    nuevos y nada más —no pisa uno que ya está, no lista, no lee, no borra—. Por eso:
 *      · este guion sólo hace PUT, cada uno con `If-None-Match: *` (no pisar vale aunque la política dejara), y se
 *        NIEGA (exit 2) si la SAS trae permisos propios de lectura/listado/borrado (`sp=` con r, l, d…), permisos
 *        propios que dejen escribir (`sp=` con w o a), o si es una SAS de CUENTA (`ss=`/`srt=`);
 *      · NADA SE PISA: la primera subida de una corrida va a `<maquina>/<archivo>`; lo que se vuelve a subir porque
 *        cambió va a `<maquina>/v<AAAAMMDDTHHMMSSmmmZ>/<archivo>` (el inicio de la pasada, en UTC, monótono por
 *        archivo), y la bajada toma la versión más nueva;
 *      · qué ya subió lo recuerda un REGISTRO LOCAL (`~/.claude/.tycon-pipeline/mailbox-uploads.json`:
 *        tamaño, mtime, sha256, blob y versión por archivo), que se anota archivo por archivo y SÓLO después de que
 *        el servicio confirmó con 201. Un corte a mitad nunca queda como «subido».
 *    Retención: sin vencimiento (decisión del dueño, 2026-10-15): el buzón guarda la conversación entera.
 *
 * 🔴 «NO SUBIDO» NUNCA SE LEE COMO «SUBIDO». Los códigos del servicio se separan (medidos en un contenedor de
 *    laboratorio, story 2.24): «ya existe» (409 BlobAlreadyExists, 403 UnauthorizedBlobOverwrite) se reintenta UNA
 *    vez con una versión nueva —la llave no lee, así que no puede saber si lo que está es igual—; la política que no
 *    deja crear (403 AuthorizationPermissionMismatch) es `llave_sin_permiso`; la llave vencida, revocada o inválida
 *    (403 AuthenticationFailed, otro 403, 404) es `llave_invalida`; y sin red es otro motivo. Ninguno marca nada.
 *    Sale ≠ 0; el instalador lo corre de fondo, así que no pone rojo el arranque: queda en `upload-runs.log`.
 *
 * 🔴 Y LOS REGISTROS DE FRENOS Y ESCAPES (story 2.5, rediseño 2026-09-15): una vez por día prepara
 *    `gates.log.gz`, `bypass.log.gz` (los registros completos de `~/.claude/.tycon-pipeline/`, comprimidos) y
 *    un `cobertura.json` que dice si pudo leer cada uno, en `~/.claude/.tycon-pipeline/registros-buzon/`, y los
 *    sube como UN JUEGO ENTERO bajo `<maquina>/registros/v<momento de la preparación>/<archivo>` (story 2.24: todos,
 *    también el idéntico al de ayer) ANTES que las corridas —pesan poco y al final de la cola no
 *    entrarían—, con la cobertura al final de los tres: es la marca de que los de arriba están completos. Un
 *    «ya existe» en un archivo del juego no se reintenta: el juego falla en esa pasada y se re-prepara. Un
 *    registro que no existe se DECLARA (`no_medido`) y no se sube vacío. De esa carpeta no sube nada más. La
 *    cuenta la hace `scripts/nightly/dashboard/reducer.js`, donde el buzón está bajado; lo que llega a la página del
 *    equipo es sólo la cuenta. Entre esos registros va también `legacy-names.jsonl` (story 8.9, AC 52: los usos de nombres
 *    viejos, con los que se decide su retiro), proyectado a sus campos y con sus conteos en la cobertura.
 *
 * 🔴 Y DÓNDE VIVE EL ARNÉS (story 8.19, tanda B · AC 21): el mismo día, con los registros, prepara `place.json` —en qué
 *    nombre vive el arnés, si el nombre viejo existe, cuánto queda registrado por él (por archivo, con la misma expresión
 *    que `harness.js doctor`), el sha256 de la copia fija de arranque contra el del árbol, y si las skills salen de un
 *    clon aparte y de qué commit—. Es la evidencia con la que la story 8.15 retira el nombre viejo. Números, hashes y
 *    nombres de archivo, y un dato de la persona (story 2.28): `owner`, el correo de git de quien usa la máquina. Un dato
 *    que no se pudo leer va `no_medido`. Una máquina sin el mecanismo no lo sube.
 *    Desde la story 8.26 (AC 40) trae también `install`: el modo (`managed` es la versión bajada), el número de versión
 *    y la capa del equipo (nombre, archivos y commit), lo mismo que `doctor --json`, para saber cómo está cada máquina
 *    sin pedirle a nadie que corra nada.
 *
 * 🔴 Y QUIÉN ES QUIÉN (story 2.28). `place.json` trae `owner`: el correo de git de la persona (`user.email` de su
 *    configuración GLOBAL de git, leída como archivo y en el orden de git, sin seguir los `include`, sin invocar git), o
 *    `no_medido` con el motivo. Es un dato de la persona: lo leen sólo quienes mantienen (el espejo del buzón y el sitio
 *    de la organización, que lo usa para que un mantenedor confirme de quién es cada máquina); la página del equipo no
 *    lo abre. `--json` imprime `place` entero, con el correo: sale en la propia máquina de la persona, no es una fuga, y
 *    el instalador no usa `--json`. Y cada máquina sube a SU carpeta: `<nombre>-<código>`, con un código de 8
 *    hexadecimales al azar que se genera una vez y se guarda en `machine-code.json` de la carpeta de estado (nunca un
 *    dato de hardware): dos máquinas con el mismo nombre ya no escriben en la misma carpeta. `place.json` trae `folder`
 *    (la carpeta, el código y la carpeta vieja que reemplaza) y los lectores unen la vieja a la nueva con
 *    `carpetasDeMaquina` de `download-runs.js`. Con `TYCON_MACHINE` (las pruebas) la carpeta es ese nombre, sin código.
 *
 * Nada de esto pregunta ni abre un login: no usa git, ni `az`, ni credenciales de la persona.
 *
 * Uso:
 *   node scripts/metrics/upload-runs.js [--json] [--dry-run] [--budget-ms N] [--log <archivo>]
 *   node scripts/metrics/upload-runs.js --check-create-only [--json]
 *
 *   --check-create-only (story 2.24): comprueba desde una máquina que la política del buzón no deja pisar. Vuelve a
 *   subir LOS MISMOS BYTES del blob confirmado más chico de esta máquina (cuyo archivo local tiene todavía el mismo
 *   sha256) a su nombre, sin If-None-Match: 403 UnauthorizedBlobOverwrite → «la política no deja pisar» (exit 0);
 *   201 → la política dejó escribir, o el blob ya no estaba (exit 1). Nunca manda bytes distintos de los confirmados.
 *
 * Contrato de salida:
 *   0 → subió, no había nada nuevo, o --dry-run (con o sin aviso de vencimiento), o corre dentro de una corrida de
 *       Azure DevOps (`agente_ci`, story 2.12: un agente de CI no es una máquina del equipo)
 *   1 → no pudo (sin llave, llave ilegible, vencida/revocada, la política no deja crear, sin red, el servicio falló,
 *       algo ilegible)
 *   2 → se negó (la llave permite leer, listar, borrar o escribir, o es de cuenta)
 *
 * Variables (para el banco de pruebas): TYCON_MAILBOX_JSON, TYCON_MAILBOX_URL_BASE, TYCON_TIMING_HISTORY,
 * TYCON_UPLOADS_LOG, TYCON_MACHINE, TYCON_MACHINE_BASE (story 2.28: fija sólo el nombre; el código se arma igual),
 * TYCON_LOGS_SOURCE, TYCON_LOGS_DIR, TYCON_TODAY, TYCON_NOW (el inicio de la pasada, ISO: fija la versión).
 * Apagado desde el instalador: TYCON_NO_UPLOAD_RUNS=1.
 */

const fs = require('fs');
const path = require('path');
// story 8.23 (A2): la carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: este
// archivo viaja suelto (al banco, a laboratorios de pruebas); ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { readEnv, resolveFile, prepareStateWrite, KINDS } = require('../lib/legacy-names.js');
const DONDE = 'scripts/metrics/upload-runs.js';
/** Una variable renombrada a inglés (story 8.9): el nombre viejo sigue valiendo hasta el retiro. */
const variable = (nombre) => readEnv(nombre, { where: DONDE });

const CASA_PIPELINE = path.join(stateDirOf(os.homedir()));
const X_MS_VERSION = '2022-11-02';
// La forma de un nombre de máquina. La usan también la bajada y la vista de corridas para reconocer las
// carpetas: el que escribe y los que leen comparten UNA definición.
const FORMA_MAQUINA = /^[a-z0-9][a-z0-9._-]*$/;
// Lo que se sube: el volcado, su hilo y su cambio según git (story 2.19). Nada más (ni `.advisors/pipeline-runs/`,
// ni la página). `download-runs.js` importa esta misma forma: si una deja de aceptar algo, la otra también.
const FORMA_ARCHIVO = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(json|hilo\.jsonl\.gz|cambio\.json\.gz)$/;
// Los registros que suben para la cuenta del tablero (story 2.5): ESTOS dos, y nada más de la carpeta.
// story 2.6: `frenos.jsonl` es el tercer registro — la constancia de los frenos previos a la
// herramienta. Va por el mismo camino que los otros dos (comprimido, una vez por día, con su
// cobertura): una fuente más, no un transporte nuevo.
// story 2.7: `carriles.jsonl` —el carril de cada commit hecho desde una sesión— es el cuarto.
// story 2.9: `hallazgos.jsonl` es el quinto — los hallazgos de los revisores, proyectados por
// `collect-findings.js`, viajan por el mismo camino y con la misma cobertura.
// story 8.9 (tanda E, AC 52): `legacy-names.jsonl` —los usos de nombres viejos, una línea por nombre viejo, guion y día—
// es el sexto: el retiro de los nombres viejos se decide con «14 días sin usos en el buzón». Sube proyectado (ver
// `usosParaElBuzon`): sólo los campos que el registro promete, nunca un valor ni una ruta de la máquina.
const REGISTROS = ['bypass.log', 'carriles.jsonl', 'frenos.jsonl', 'gates.log', 'hallazgos.jsonl', 'legacy-names.jsonl'];
// 🔴 Se DERIVA de REGISTROS, no se escribe otra vez: eran dos listas de lo mismo y la story 2.6
// encontró la primera separación —`frenos.jsonl` subía y la bajada lo filtraba, así que el
// registro nuevo llegaba al buzón y no lo bajaba nadie, en verde.
const FORMA_REGISTRO = new RegExp(`^(${REGISTROS.map((r) => `${r.replace(/\./g, '\\.')}\\.gz`).join('|')}|cobertura\\.json|place\\.json)$`);
const DIAS_AVISO_VENCE = 30;

/**
 * El nombre de esta máquina: la regla de exam-config.json (hostname, minúsculas, sin `.local`).
 * Lo usan también la bajada y la vista de corridas: una sola definición.
 */
let nombreMac;   // cacheado: la vista lo pide una vez por corrida, scutil no se llama dos veces
function nombreEstableDeMac() {
  if (nombreMac !== undefined) return nombreMac;
  nombreMac = null;
  // 🔴 En macOS, sin HostName fijado, os.hostname() sigue a la red (x.lan / x.home / nombre del DHCP): la misma
  //    máquina escribiría en dos carpetas del buzón y re-subiría todo (pase adversarial). HostName si está
  //    fijado —es lo que os.hostname() ya devuelve—, y si no LocalHostName, que no depende de la red.
  for (const clave of ['HostName', 'LocalHostName']) {
    const r = spawnSync('scutil', ['--get', clave], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    const v = !r.error && r.status === 0 ? String(r.stdout || '').trim() : '';
    if (v) { nombreMac = v; break; }
  }
  return nombreMac;
}

/** La regla de forma de un nombre de máquina, sola: la usa también el alias del reductor (story 2.5). */
function normalizarNombreDeMaquina(n) {
  return String(n || '').trim().toLowerCase().replace(/\.local$/, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '');
}

/** El nombre de esta máquina, sin código (story 2.28): `TYCON_MACHINE`, o `TYCON_MACHINE_BASE` (pruebas), o el de la red. */
function nombreBaseDeMaquina() {
  let n = variable('TYCON_MACHINE') || process.env.TYCON_MACHINE_BASE;
  if (!n && process.platform === 'darwin') n = nombreEstableDeMac();
  if (!n) { try { n = os.hostname(); } catch (_) { n = ''; } }
  return normalizarNombreDeMaquina(n);
}

const FORMA_CODIGO = /^[0-9a-f]{8}$/;
const rutaCodigoDeMaquina = (home = os.homedir()) => path.join(stateDirOf(home), 'machine-code.json');

/**
 * `machine-code.json` como está (story 2.28): `{ datos }` si tiene forma, o `{ motivo }` («no estaba», «ilegible» o
 * «sin forma»). Sólo lee.
 */
function leerCodigoDeMaquina(archivo = rutaCodigoDeMaquina()) {
  let texto;
  // 🔴 «No se pudo leer» (permisos, un antivirus que lo tiene tomado, demasiados archivos abiertos) NO es «está roto»:
  //    sale `error` y nadie lo pisa — regenerar por un error pasajero mudaba la máquina para siempre (pase adversarial).
  try { texto = fs.readFileSync(archivo, 'utf8'); }
  catch (e) { return e.code === 'ENOENT' ? { motivo: 'no estaba' } : { error: e.code || 'error' }; }
  let d;
  try { d = JSON.parse(texto); } catch (_) { return { motivo: 'ilegible' }; }
  const fechaReal = (f) => /^\d{4}-\d{2}-\d{2}$/.test(String(f)) && new Date(`${f}T00:00:00Z`).toISOString().slice(0, 10) === f;
  if (!d || typeof d !== 'object' || !FORMA_CODIGO.test(String(d.code)) || typeof d.folder !== 'string'
    || !FORMA_MAQUINA.test(d.folder) || !d.folder.endsWith(`-${d.code}`) || !fechaReal(d.created_on)) return { motivo: 'sin forma' };
  return { datos: d };
}

/**
 * La huella de las corridas de una carpeta (story 2.28, tercera vuelta de seguridad, decisión del dueño del 2026-10-15):
 * sha256 de los nombres de sus volcados `.json` de primer nivel, ordenados y unidos por saltos de línea. La máquina la
 * declara para su carpeta vieja con lo que dice su registro de subidas; la bajada la calcula con lo que hay en el espejo;
 * la unión pide que coincidan. La llave no deja listar el buzón: otra máquina no puede saberla. UNA definición: la usa
 * también `download-runs.js`.
 */
function huellaDeCorridas(nombres) {
  const lista = [...new Set((nombres || []).filter((n) => typeof n === 'string' && n.endsWith('.json') && FORMA_ARCHIVO.test(n)))].sort();
  return crypto.createHash('sha256').update(lista.join('\n')).digest('hex');
}

/**
 * La huella de lo que esta máquina subió a `carpeta`, según su registro de subidas (claves `<carpeta>/<volcado>.json`;
 * los registros y las versiones no cuentan: el espejo los guarda con el nombre de siempre). null si el registro existe y
 * no se pudo leer: sin huella no hay unión (falla hacia no mostrar).
 */
function huellaDeLoSubido(rutaRegistro, carpeta) {
  let r;
  try { r = JSON.parse(fs.readFileSync(rutaRegistro, 'utf8')); }
  catch (e) { return e && e.code === 'ENOENT' ? huellaDeCorridas([]) : null; }
  const nombres = Object.keys((r && r.archivos) || {}).map((k) => k.split('/')).filter((p) => p.length === 2 && p[0] === carpeta).map((p) => p[1]);
  return huellaDeCorridas(nombres);
}

/**
 * Las carpetas con código anteriores de esta máquina, según su registro de subidas: `<base>-<8 hexadecimales>` exacto
 * (un nombre que ya termina en 8 hexadecimales no cuenta como «con código»). Distingue «borrado» de «primera vez», y la
 * carpeta regenerada las declara (`superseded_folders`) para que la bajada las una a ella. `leido: false` si el registro
 * existe y no se pudo leer: no prueba nada, y se declara regenerado (falla hacia decirlo).
 */
function carpetasConCodigoAnteriores(rutaRegistro, base) {
  const mismaBase = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[0-9a-f]{8}$`);
  try {
    const r = JSON.parse(fs.readFileSync(rutaRegistro, 'utf8'));
    return { leido: true, carpetas: [...new Set(Object.keys((r && r.archivos) || {}).map((k) => k.split('/')[0]).filter((c) => mismaBase.test(c)))].sort() };
  } catch (e) { return { leido: Boolean(e && e.code === 'ENOENT'), carpetas: [] }; }
}

/**
 * La carpeta de esta máquina en el buzón (story 2.28, decisión 9). Con `TYCON_MACHINE`, ese nombre (como siempre, sin
 * código). Si no, la de `machine-code.json`: la carpeta se LEE del archivo, no se vuelve a armar (renombrar el equipo no
 * la mueve). Sin archivo con forma: quien sólo lee (`crear` falso: la vista, el reductor, la poda) recibe el nombre sin
 * código, que es donde subía antes; la subida (`crear`) genera un código al azar —nunca un dato de hardware—, escribe el
 * archivo (en exclusiva si no estaba: dos pasadas a la vez no generan dos códigos) y devuelve el motivo si regeneró.
 * Devuelve `{ nombre, folder, regenerado }`; `nombre` vacío si no hay forma de nombrar la máquina.
 */
function carpetaDeMaquina(opts = {}) {
  const fijo = variable('TYCON_MACHINE');
  if (fijo) { const n = normalizarNombreDeMaquina(fijo); return { nombre: n, folder: { name: n, source: 'TYCON_MACHINE' }, regenerado: null }; }
  const archivo = opts.archivo || rutaCodigoDeMaquina();
  const deDatos = (d) => {
    const folder = { name: d.folder, code: d.code, previous_folder: d.previous_folder || null, moved_on: d.created_on || null };
    if (d.code_regenerated && typeof d.code_regenerated === 'object') folder.code_regenerated = { on: d.code_regenerated.on, reason: d.code_regenerated.reason };
    if (Array.isArray(d.superseded_folders) && d.superseded_folders.length) folder.superseded_folders = d.superseded_folders.slice();
    // null = el registro no se pudo leer: se dice (sin huella la bajada no une), no se calla
    if ('previous_runs_sha256' in d) folder.previous_runs_sha256 = typeof d.previous_runs_sha256 === 'string' ? d.previous_runs_sha256 : null;
    if (d.superseded_runs_sha256 && typeof d.superseded_runs_sha256 === 'object') folder.superseded_runs_sha256 = { ...d.superseded_runs_sha256 };
    return { nombre: d.folder, folder, regenerado: null };
  };
  const leido = leerCodigoDeMaquina(archivo);
  if (leido.datos) return deDatos(leido.datos);
  const base = nombreBaseDeMaquina();
  // un archivo que existe y no se pudo leer: quien sólo lee usa el nombre sin código; la subida NO lo pisa — falla y
  // reintenta en el próximo arranque
  if (leido.error && opts.crear) throw Object.assign(new Error(`machine-code.json no se pudo leer (${leido.error})`), { code: leido.error });
  if (!opts.crear || !base) return { nombre: base, folder: null, regenerado: null };
  const dia = opts.hoy || hoy();
  const code = crypto.randomBytes(4).toString('hex');
  const datos = { schema: 1, code, folder: `${base}-${code}`, created_on: dia, previous_folder: base };
  // «no estaba» la primera vez es la carpeta de siempre de la máquina, no una regenerada: se regenera si la máquina ya
  // había subido a una carpeta con código de su mismo nombre (el archivo se borró), o si el archivo estaba roto. Las
  // carpetas con código anteriores se declaran, para que la bajada las una a ésta (pase adversarial).
  const anteriores = opts.registro ? carpetasConCodigoAnteriores(opts.registro, base) : { leido: true, carpetas: [] };
  const regenera = leido.motivo !== 'no estaba' || anteriores.carpetas.length > 0 || !anteriores.leido;
  if (regenera) datos.code_regenerated = { on: dia, reason: leido.motivo };
  const reemplaza = anteriores.carpetas.filter((c) => c !== datos.folder);
  if (reemplaza.length) datos.superseded_folders = reemplaza;
  // la huella de lo que subió a la carpeta vieja y a cada carpeta que reemplaza: la prueba que pide la bajada para unirlas
  if (opts.registro) {
    datos.previous_runs_sha256 = huellaDeLoSubido(opts.registro, base);
    if (reemplaza.length) datos.superseded_runs_sha256 = Object.fromEntries(reemplaza.map((c) => [c, huellaDeLoSubido(opts.registro, c)]));
  }
  const texto = `${JSON.stringify(datos, null, 1)}\n`;
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  if (leido.motivo === 'no estaba') {
    // 🔴 Se crea ENTERO o no se crea: el texto va a un temporal y se engancha con un enlace duro, que falla si el archivo
    //    ya existe. Con `wx` sobre el archivo final, la otra pasada podía leerlo a medio escribir, darlo por roto y
    //    pisarlo con su código (dos pasadas a la vez, dos códigos: lo cazó T31).
    const tmp = `${archivo}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    fs.writeFileSync(tmp, texto);
    try { fs.linkSync(tmp, archivo); }
    catch (e) {
      if (e.code !== 'EEXIST') { try { fs.writeFileSync(archivo, texto, { flag: 'wx' }); } catch (e2) { if (e2.code !== 'EEXIST') { fs.rmSync(tmp, { force: true }); throw e2; } } }
    } finally { fs.rmSync(tmp, { force: true }); }
    // gane quien gane, vale lo que quedó en el archivo
    const quedo = leerCodigoDeMaquina(archivo);
    if (quedo.datos && quedo.datos.code !== code) return deDatos(quedo.datos);
    if (!quedo.datos) escribirAtomico(archivo, texto);
  } else escribirAtomico(archivo, texto);
  return { ...deDatos(datos), regenerado: regenera ? leido.motivo : null };
}

/** La carpeta de esta máquina en el buzón, para quien sólo lee (la vista, el reductor, la poda): ver carpetaDeMaquina. */
function nombreDeMaquina() {
  return carpetaDeMaquina({ crear: false }).nombre;
}

const FORMA_CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * `user.email` de la configuración GLOBAL de git (story 2.28, AC 1-2), leída como archivo: si `GIT_CONFIG_GLOBAL` está
 * puesta, sólo ése; si no, los que existan en el orden de git (`$XDG_CONFIG_HOME/git/config` o `~/.config/git/config`, y
 * después `~/.gitconfig`), y vale el ÚLTIMO `user.email`. Los `include`/`includeIf` NO se siguen (su `path` puede ser
 * cualquier archivo de la máquina). Devuelve `{ email, source: 'git-global' }` en minúsculas y sin espacios, o
 * `{ status: 'no_medido', reason }` con un motivo por caso, nunca una ruta. No invoca git (T18).
 */
/**
 * El valor de una clave de la configuración de git, como lo lee git (pase adversarial): las comillas se pueden abrir y
 * cerrar en cualquier parte, `\` escapa (`\\`, `\"`, `\n`, `\t`, `\b`), un `#` o `;` fuera de comillas empieza un
 * comentario, y los espacios de los bordes fuera de comillas no cuentan.
 */
function valorDeGit(crudo) {
  const ESCAPES = { n: '\n', t: '\t', b: '\b', '"': '"', '\\': '\\' };
  let out = '';
  let espacios = '';
  let comillas = false;
  for (let i = 0; i < crudo.length; i++) {
    const ch = crudo[i];
    if (ch === '\\' && i + 1 < crudo.length) { out += espacios + (ESCAPES[crudo[i + 1]] || crudo[i + 1]); espacios = ''; i += 1; continue; }
    if (ch === '"') { out += espacios; espacios = ''; comillas = !comillas; continue; }
    if (!comillas && (ch === '#' || ch === ';')) break;
    if (!comillas && /\s/.test(ch)) { if (out) espacios += ch; continue; }
    out += espacios + ch;
    espacios = '';
  }
  return out;
}

function correoDeGitGlobal(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  const noMedido = (reason) => ({ status: 'no_medido', reason });
  const archivos = env.GIT_CONFIG_GLOBAL
    ? [env.GIT_CONFIG_GLOBAL]
    : [env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, 'git', 'config') : path.join(home, '.config', 'git', 'config'), path.join(home, '.gitconfig')];
  let alguno = false;
  let email = null;
  let conInclude = false;
  for (const f of archivos) {
    let texto;
    try { texto = fs.readFileSync(f, 'utf8'); }
    catch (e) {
      if (e.code === 'ENOENT') continue;
      return noMedido(`la configuración global de git no se pudo leer (${e.code || 'error'})`);
    }
    alguno = true;
    let seccion = null;
    // las líneas lógicas: una línea que termina en una barra invertida sin pareja sigue en la siguiente (como git)
    const logicas = [];
    let acumulada = null;
    for (const cruda of texto.split(/\r?\n/)) {
      const junta = acumulada === null ? cruda : acumulada + cruda;
      const barras = (/\\+$/.exec(junta) || [''])[0].length;
      if (barras % 2 === 1) { acumulada = junta.slice(0, -1); continue; }
      logicas.push(junta);
      acumulada = null;
    }
    if (acumulada !== null) logicas.push(acumulada);
    for (const logica of logicas) {
      let linea = logica.trim();
      const cab = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"[^"]*")?\s*\](.*)$/.exec(linea);
      if (cab) {
        const nombre = cab[1].toLowerCase();
        const sub = /^\[\s*[A-Za-z0-9.-]+\s+"/.test(linea);
        seccion = sub ? `${nombre}:sub` : nombre;
        if (nombre === 'include' || nombre === 'includeif') conInclude = true;
        linea = cab[2].trim();   // git deja una clave en la misma línea de la cabecera
      }
      if (seccion !== 'user' || !linea || /^[#;]/.test(linea)) continue;
      const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=(.*))?$/.exec(linea);
      if (!kv || kv[1].toLowerCase() !== 'email') continue;
      email = valorDeGit(kv[2] === undefined ? '' : kv[2]);
    }
  }
  if (!alguno) return noMedido('esta máquina no tiene configuración global de git');
  if (email === null || email === '') {
    return noMedido(conInclude
      ? 'user.email no está en la configuración global de git; el correo puede estar en un archivo incluido, que no se sigue'
      : 'la configuración global de git no tiene user.email');
  }
  const limpio = email.trim().toLowerCase();
  if (!FORMA_CORREO.test(limpio)) return noMedido('user.email de la configuración global de git no tiene forma de correo');
  return { email: limpio, source: 'git-global' };
}

function rutaConfig() {
  return path.resolve(variable('TYCON_MAILBOX_JSON') || path.join(__dirname, 'corridas-buzon.json'));
}

/**
 * La integración «buzón» según la configuración del arnés (story 8.3, AC 9/10): `integrations.mailbox` por variable
 * (TYCON_MAILBOX), ~/.claude/tycon.json o el perfil del equipo, y si nada la dice, PRENDIDA sólo si la llave existe
 * (`rutaConfig()`, la misma que lee `leerConfig`). Apagada → el comando sale 0 y lo dice; prendida sin archivo → el
 * error de siempre (falta la llave: en el repo del equipo, un clon incompleto). Configuración rota → `{ error }` (exit 2). Sin lector al lado:
 * como hoy (prendida). La usa también la bajada.
 */
function integracionBuzon(llave = 'mailbox') {
  try {
    const cfg = require(path.join(__dirname, '..', 'lib', 'tycon-config.js'));
    const r = cfg.integracionParaComando(llave);
    return { prendida: r.prendida, apagada: r.apagada };
  } catch (e) {
    if (e && e.name === 'ConfigError') return { prendida: false, error: e.message };
    if (!(e && e.code === 'MODULE_NOT_FOUND')) throw e;   // sólo «sin la lib al lado» es «como hoy»; un bug del lector no se traga
    return { prendida: true };
  }
}

/**
 * Lee y valida `corridas-buzon.json`. Devuelve { cfg } o { estado, motivo }. `sas` sin `?` inicial.
 * La usan la subida (necesita `sas`) y la bajada (necesita `tenant`): `requiere` dice qué campos exige. `ruta` (story 2.24)
 * la pasa el panel de sólo lectura de `team-config`; sin ella, la de siempre.
 */
function leerConfig(requiere = ['cuenta', 'contenedor', 'sas', 'vence'], ruta = rutaConfig()) {
  let texto;
  try { texto = fs.readFileSync(ruta, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return { estado: 'sin_config', motivo: `falta la llave del buzón (${ruta}, corridas-buzon.json): no se sube nada. Es una integración del equipo que la copia pública no trae` };
    return { estado: 'config_ilegible', motivo: `no se pudo leer ${ruta} (${e.code || e.message})` };
  }
  let cfg;
  try { cfg = JSON.parse(texto); } catch (_) { return { estado: 'config_ilegible', motivo: `${ruta} no es JSON válido` }; }
  if (!cfg || typeof cfg !== 'object') return { estado: 'config_ilegible', motivo: `${ruta} no es un objeto` };
  const faltan = requiere.filter((k) => typeof cfg[k] !== 'string' || !cfg[k].trim());
  if (faltan.length) return { estado: 'config_ilegible', motivo: `${ruta} tiene que declarar ${faltan.map((k) => `"${k}"`).join(', ')} (texto)` };
  // La forma sola no alcanza: «2027-13-15» la pasa, diasHasta da NaN y el aviso de vencimiento no sale nunca.
  const fechaValida = (f) => /^\d{4}-\d{2}-\d{2}$/.test(f) && !Number.isNaN(Date.parse(`${f}T00:00:00Z`)) && new Date(`${f}T00:00:00Z`).toISOString().slice(0, 10) === f;
  if (requiere.includes('vence') && !fechaValida(cfg.vence.trim())) return { estado: 'config_ilegible', motivo: `${ruta}: "vence" tiene que ser una fecha AAAA-MM-DD (es ${JSON.stringify(cfg.vence)})` };
  if (!/^[a-z0-9]{3,24}$/.test(cfg.cuenta.trim())) return { estado: 'config_ilegible', motivo: `${ruta}: "cuenta" no tiene la forma de una cuenta de almacenamiento` };
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61})[a-z0-9]$/.test(cfg.contenedor.trim())) return { estado: 'config_ilegible', motivo: `${ruta}: "contenedor" no tiene la forma de un contenedor` };
  const limpio = { ...cfg, cuenta: cfg.cuenta.trim(), contenedor: cfg.contenedor.trim() };
  if (typeof cfg.sas === 'string') limpio.sas = cfg.sas.trim().replace(/^\?/, '');
  return { cfg: limpio, ruta };
}

/**
 * Por qué esta SAS NO se acepta para subir: { estado, motivo }, o null. Nunca imprime la firma. Sin permisos propios
 * (`sp`) la SAS toma los de su política guardada; con `sp`, sólo se acepta `c` (story 2.24: una llave que puede pisar
 * no es la del buzón).
 */
function negativaDeLaLlave(sas) {
  const p = new URLSearchParams(sas);
  const no = (motivo, estado = 'llave_con_lectura') => ({ estado, motivo });
  if (!p.get('sig')) return no('la SAS del buzón no trae firma (sig): no es una llave');
  if (p.has('ss') || p.has('srt')) return no('la SAS del buzón es de CUENTA (ss/srt): sólo se acepta una SAS de contenedor atada a una política de escritura');
  const sp = p.get('sp');
  if (sp && /[^cwa]/.test(sp)) return no(`la SAS del buzón trae permisos propios «${sp}» que permiten más que escribir (leer, listar o borrar): esta llave no se acepta`);
  if (sp && /[wa]/.test(sp)) return no(`la SAS del buzón trae permisos propios «${sp}» que dejan pisar blobs que ya están: sólo se acepta «c» (sólo crear) o ninguno`, 'llave_con_escritura');
  if (!p.get('si')) return no('la SAS del buzón no está atada a una política guardada (si): no se puede revocar sin rotar la cuenta');
  return null;
}

/** El inicio de la pasada, en ms (story 2.24). TYCON_NOW (ISO) sólo para el banco de pruebas. */
function ahoraMs() {
  const t = Date.parse(variable('TYCON_NOW') || '');
  return Number.isFinite(t) ? t : Date.now();
}
// La forma de una versión: la carpeta `v<AAAAMMDDTHHMMSSmmmZ>`. La bajada la importa: una sola definición.
const FORMA_VERSION = /^v\d{8}T\d{9}Z$/;
/** Una versión, desde ms. */
function versionDe(ms) { return `v${new Date(ms).toISOString().replace(/[-:.]/g, '')}`; }
/** Los ms de una versión, o null si no tiene la forma. */
function msDeVersion(v) {
  if (typeof v !== 'string' || !FORMA_VERSION.test(v)) return null;
  const m = /^v(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(v);
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`;
  const t = Date.parse(iso);
  // ida y vuelta: Date.parse normaliza el desborde (un 30 de febrero sería el 2 de marzo); una fecha imposible no es versión
  return Number.isFinite(t) && new Date(t).toISOString() === iso ? t : null;
}
/** Una versión que nunca retrocede: max(desde, la anterior + 1 ms) (story 2.24, decisión 4). */
function versionMonotona(desdeMs, anterior) {
  const prev = typeof anterior === 'number' ? anterior : msDeVersion(anterior);
  return versionDe(prev === null ? desdeMs : Math.max(desdeMs, prev + 1));
}

/**
 * Qué dijo el buzón a un PUT (story 2.24, códigos medidos en el laboratorio): 'creado' · 'ya_existe' (409
 * BlobAlreadyExists, 403 UnauthorizedBlobOverwrite) · 'sin_permiso' (403 AuthorizationPermissionMismatch: la política
 * no deja crear) · 'llave' (otro 403, 404: vencida, revocada o inválida) · 'servicio' (5xx) · 'otro'.
 */
function respuestaDelBuzon(r) {
  if (r.status === 201) return 'creado';
  if ((r.status === 409 && r.codigo === 'BlobAlreadyExists') || (r.status === 403 && r.codigo === 'UnauthorizedBlobOverwrite')) return 'ya_existe';
  if (r.status === 403 && r.codigo === 'AuthorizationPermissionMismatch') return 'sin_permiso';
  if (r.status === 403 || r.status === 404) return 'llave';
  if (r.status >= 500) return 'servicio';
  return 'otro';
}

function urlBase(cfg) {
  return String(variable('TYCON_MAILBOX_URL_BASE') || `https://${cfg.cuenta}.blob.core.windows.net`).replace(/\/+$/, '');
}

function hoy() { return new Date().toISOString().slice(0, 10); }
/** El día de la preparación de registros; TYCON_TODAY sólo para el banco (no toca el aviso de vencimiento). */
function diaDeRegistros() {
  const h = variable('TYCON_TODAY');
  return h && /^\d{4}-\d{2}-\d{2}$/.test(h) ? h : hoy();
}

function diasHasta(fecha) {
  const t = Date.parse(`${fecha}T00:00:00Z`);
  return Math.floor((t - Date.parse(`${hoy()}T00:00:00Z`)) / 86400000);
}

/** Escribe `archivo` de forma atómica (temporal en la misma carpeta + rename). */
function escribirAtomico(archivo, contenido) {
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  const tmp = `${archivo}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contenido);
  fs.renameSync(tmp, archivo);
}

/** ¿Ya se avisó hoy? Si no, deja el sello. Un sello que no se pudo escribir no calla el aviso. */
function selloDiario(archivo, texto) {
  // story 8.9 (tanda D2): el sello cambió de nombre; si sólo está el de antes, se lee ése y pasa al nuevo al escribir
  try { if (fs.readFileSync(resolveFile(archivo, { where: DONDE }), 'utf8').slice(0, 10) === hoy()) return 'ya_emitido_hoy'; } catch (_) { /* primera vez */ }
  try { prepareStateWrite(archivo, { where: DONDE }); escribirAtomico(archivo, `${hoy()} ${texto}\n`); } catch (_) { /* se avisa igual */ }
  return 'emitido';
}

/** ¿La serie de hallazgos está medida? Delegado en el recolector: UNA definición (story 2.9). */
function estadoDeHallazgos(salida, dia) {
  try { return require('./collect-findings.js').estadoDeLaSerie({ salida, hoy: dia }); }
  // 🔴 Este motivo viaja al buzón: el mensaje de un require fallido trae la pila con rutas del home.
  catch (e) { return { estado: 'no_medido', motivo: `no se pudo evaluar la serie de hallazgos (${e.code || e.name || 'error'})` }; }
}

/**
 * Los conteos del recolector que viajan con la cobertura: una LISTA de claves conocidas, con números. La
 * lista vive en el recolector (`conteosDelSello`), que es también quien la lee del otro lado.
 */
function resumenDeHallazgos(sello) {
  try { return require('./collect-findings.js').conteosDelSello(sello); } catch (_) { return {}; }
}

/** ¿`f` es una fecha AAAA-MM-DD que existe? */
function fechaReal(f) {
  return typeof f === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f) && !Number.isNaN(Date.parse(`${f}T00:00:00Z`))
    && new Date(`${f}T00:00:00Z`).toISOString().slice(0, 10) === f;
}
// Un nombre del mapa (sin espacios, comillas ni barras invertidas) y un guion relativo a su repo (sin raíz, `~`, unidad
// de Windows ni `..`): lo que `legacy-names.js` anota (AC 17). Otra cosa no viaja.
const NOMBRE_USO = /^[^\s"'\\]{1,200}$/;
const GUION_USO = /^(?![/~])(?![A-Za-z]:)[A-Za-z0-9._/-]{1,300}$/;
/**
 * El registro de usos de nombres viejos, como viaja al buzón (story 8.9, AC 52): cada línea con SÓLO `day`, `kind`, `old`,
 * `new`, `script` y `conflict` (si es true). Una línea que no parsea, con un día imposible, un tipo desconocido o un guion
 * que es una ruta de la máquina no sube —se cuenta en `dropped`—, y un campo de más se cae. El resumen son números.
 */
function usosParaElBuzon(texto) {
  const salida = [];
  const nombres = new Set();
  let descartadas = 0;
  for (const linea of String(texto).split('\n')) {
    if (!linea.trim()) continue;
    let d;
    try { d = JSON.parse(linea); } catch (_) { descartadas += 1; continue; }
    const sirve = d && typeof d === 'object' && fechaReal(d.day) && KINDS.includes(d.kind)
      && typeof d.old === 'string' && NOMBRE_USO.test(d.old) && typeof d.new === 'string' && NOMBRE_USO.test(d.new)
      && typeof d.script === 'string' && GUION_USO.test(d.script) && !d.script.split('/').includes('..');
    if (!sirve) { descartadas += 1; continue; }
    const l = { day: d.day, kind: d.kind, old: d.old, new: d.new, script: d.script };
    if (d.conflict === true) l.conflict = true;
    salida.push(JSON.stringify(l));
    nombres.add(`${d.kind}\0${d.old}`);
  }
  // las claves del resumen son nuevas (story 8.9): en inglés
  return { texto: salida.length ? `${salida.join('\n')}\n` : '', resumen: { lines: salida.length, names: nombres.size, dropped: descartadas } };
}

/**
 * Prepara, una vez por día, los registros de frenos y escapes comprimidos y su cobertura (story 2.5).
 * Devuelve { estado: 'preparado' | 'ya_preparado_hoy' | 'sin_carpeta', fuentes? }. Nunca devuelve rutas.
 * Tira si no puede escribir la carpeta de preparación: quien llama lo cuenta como no subido.
 */
function prepararRegistros(opts = {}) {
  const origen = path.resolve(opts.origen || variable('TYCON_LOGS_SOURCE') || CASA_PIPELINE);
  const destino = path.resolve(opts.destino || variable('TYCON_LOGS_DIR') || path.join(CASA_PIPELINE, 'registros-buzon'));
  const dia = opts.hoy || diaDeRegistros();
  // Una máquina sin la carpeta del pipeline no tiene nada que declarar: no es «no medido», es «no participa».
  // 🔴 Sólo «no existe» (ENOENT) es eso. Una carpeta que existe y no se puede mirar, o que es un archivo, TIRA:
  //    quien llama lo cuenta como no subido y sale 1 — si no, esa máquina dejaría de subir registros en silencio.
  let st;
  try { st = fs.statSync(origen); }
  catch (e) { if (e.code === 'ENOENT') return { estado: 'sin_carpeta' }; throw e; }
  if (!st.isDirectory()) throw Object.assign(new Error('la carpeta del pipeline no es un directorio'), { code: 'ENOTDIR' });
  const coberturaArchivo = path.join(destino, 'cobertura.json');
  // story 2.24: el momento de la preparación (`preparado`) es la versión del juego en el buzón. Una cobertura de hoy SIN
  // `preparado` —la de antes de la 2.24, o una invalidada por un «ya existe»— se vuelve a preparar, con un momento que
  // nunca retrocede respecto del anterior (`preparado` o `invalidado`).
  let anterior = null;
  try {
    const c = JSON.parse(fs.readFileSync(coberturaArchivo, 'utf8'));
    // story 2.28: la preparación de hoy vale si su place.json es de la carpeta de ahora; si la carpeta cambió (la primera
    // pasada con código, o un código regenerado), se re-prepara: el juego nuevo tiene que declarar la carpeta nueva.
    if (c && c.esquema === 1 && c.fecha === dia && msDeVersion(c.preparado) !== null && carpetaPreparada(destino, opts.folder)) return { estado: 'ya_preparado_hoy', version: c.preparado };
    if (c) anterior = [c.preparado, c.invalidado].map(msDeVersion).filter((x) => x !== null).sort((a, b) => b - a)[0];
  } catch (_) { /* primera vez, o ilegible: se prepara */ }
  const preparado = versionMonotona(ahoraMs(), anterior === undefined ? null : anterior);
  fs.mkdirSync(destino, { recursive: true });
  const fuentes = {};
  for (const archivo of REGISTROS) {
    // El nombre de la fuente en la cobertura es el del archivo SIN su extensión — y se saca la
    // última, no un `.log` literal: con `.log` a secas, `frenos.jsonl` se declaraba como
    // «frenos.jsonl» mientras el reductor lo buscaba como «frenos», y esa máquina quedaba
    // «no medida» para siempre, en silencio (lo cazó el caso 2.6-T10).
    const id = archivo.replace(/\.[^.]+$/, '');
    const gz = path.join(destino, `${archivo}.gz`);
    let resumen = null;
    if (archivo === 'hallazgos.jsonl') {
      // 🔴 La serie de hallazgos se declara medida con LA MISMA regla que usa el cruce (story 2.9):
      //    un archivo vacío, sin sello o viejo —el recolector apagado— NO es «0 hallazgos medidos».
      const estado = estadoDeHallazgos(path.join(origen, archivo), dia);
      if (estado.estado !== 'medido') {
        try { fs.unlinkSync(gz); } catch (_) { /* no estaba */ }
        fuentes[id] = { estado: 'no_medido', motivo: estado.motivo };
        continue;
      }
      resumen = resumenDeHallazgos(estado.sello);
      // 🔴 Se sube el MISMO texto que se validó contra el sello (leerlo de nuevo podía traer otra versión),
      //    con la fecha del sello: la de la preparación dice cuándo se armó la subida, no cuándo se midió.
      const cuerpoValidado = Buffer.from(estado.texto, 'utf8');
      escribirAtomico(gz, zlib.gzipSync(cuerpoValidado));
      fuentes[id] = { estado: 'medido', bytes: cuerpoValidado.length, fecha: estado.fecha, resumen };
      continue;
    }
    let cuerpo;
    try { cuerpo = fs.readFileSync(path.join(origen, archivo)); }
    catch (e) {
      // 🔴 Ausente o ilegible NO es vacío: se declara, y el .gz de un día anterior se saca de la preparación
      //    para que no vuelva a subir números viejos.
      try { fs.unlinkSync(gz); } catch (_) { /* no estaba */ }
      fuentes[id] = { estado: 'no_medido', motivo: e.code === 'ENOENT' ? 'el registro no existe en esta máquina' : `el registro no se pudo leer (${e.code || 'error'})` };
      continue;
    }
    if (archivo === 'legacy-names.jsonl') {
      // story 8.9 (AC 52): sube proyectado, con sus conteos en la cobertura
      const usos = usosParaElBuzon(cuerpo.toString('utf8'));
      const proyectado = Buffer.from(usos.texto, 'utf8');
      escribirAtomico(gz, zlib.gzipSync(proyectado));
      fuentes[id] = { estado: 'medido', bytes: proyectado.length, resumen: usos.resumen };
      continue;
    }
    escribirAtomico(gz, zlib.gzipSync(cuerpo));
    fuentes[id] = { estado: 'medido', bytes: cuerpo.length };
  }
  // story 8.19 (AC 21): dónde vive el arnés, antes de la cobertura (que es la marca de que lo de arriba está completo)
  const lugar = path.join(destino, 'place.json');
  let facts = null;
  try { facts = placeFactsForMailbox(dia, opts.folder); } catch (e) { facts = { schema: 1, day: dia, place: { status: 'no_medido', reason: `no se pudo mirar (${(e && e.code) || 'error'})` } }; }
  if (facts) escribirAtomico(lugar, `${JSON.stringify(facts, null, 1)}\n`);
  else { try { fs.unlinkSync(lugar); } catch (_) { /* no estaba */ } }
  escribirAtomico(coberturaArchivo, `${JSON.stringify({ esquema: 1, fecha: dia, preparado, fuentes }, null, 1)}\n`);
  return { estado: 'preparado', fuentes, version: preparado };
}

/**
 * Invalida la preparación local de registros (story 2.24, AC 10): le quita `preparado` a la cobertura y anota la versión
 * fallida en `invalidado`, para que la pasada siguiente —aunque sea el mismo día— re-prepare el juego con un momento
 * posterior. Tira si no puede escribir.
 */
function invalidarPreparacion(dirRegistros, version) {
  const archivo = path.join(dirRegistros, 'cobertura.json');
  const c = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  delete c.preparado;
  c.invalidado = version;
  escribirAtomico(archivo, `${JSON.stringify(c, null, 1)}\n`);
}

/**
 * ¿La preparación que está en `destino` es de la carpeta `folder`? (story 2.28). Sin carpeta que comparar, sí; sin
 * place.json (una máquina sin el mecanismo), sí: no hay qué re-preparar.
 */
function carpetaPreparada(destino, folder) {
  if (!folder) return true;
  let p;
  try { p = JSON.parse(fs.readFileSync(path.join(destino, 'place.json'), 'utf8')); }
  catch (e) { return e.code === 'ENOENT'; }
  return Boolean(p && p.folder && p.folder.name === folder.name);
}

/**
 * Dónde vive el arnés en esta máquina (story 8.19, tanda B · AC 21), como viaja al buzón: números, hashes y nombres de
 * archivo (nunca una ruta con la carpeta de la persona; los motivos, códigos de error), y desde la story 2.28 un dato de
 * la persona, `owner` (su correo de git, ver correoDeGitGlobal), y `folder` (la carpeta de la máquina en el buzón). Un
 * dato que no se pudo leer va `{ status: 'no_medido', reason }`. null si la máquina no tiene el mecanismo instalado (no
 * participa).
 */
function placeFactsForMailbox(day, folder = null) {
  const home = os.homedir();
  const pipeline = path.join(stateDirOf(home));
  const notMeasured = (reason) => ({ status: 'no_medido', reason });
  const code = (e) => (e && (e.code || e.name)) || 'error';
  let state = null;
  try { state = JSON.parse(fs.readFileSync(path.join(pipeline, 'harness-state.json'), 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return null;
    state = null;
  }
  const out = { schema: 1, day, owner: correoDeGitGlobal({ home }) };
  if (folder) out.folder = folder;
  let P;
  try { P = require('../setup/harness/place.js'); } catch (e) {
    return Object.assign(out, { place: notMeasured(`place.js no se pudo cargar (${code(e)})`) });
  }
  const kindOf = (p) => { try { const st = fs.lstatSync(p); return st.isSymbolicLink() ? 'link' : (st.isDirectory() ? 'folder' : 'file'); } catch (_) { return null; } };
  const where = P.resolvePlace({ home });
  out.place = { name: where.via === 'place' ? P.PLACE_NAME : (where.via === 'legacy' ? P.LEGACY_PLACE_NAME : null), kind: where.path ? kindOf(where.path) : null };
  const legacy = P.legacyPlacePath(home);
  const lk = kindOf(legacy);
  let toPlace = false;
  try { toPlace = lk === 'link' && P.samePath(path.resolve(path.dirname(legacy), fs.readlinkSync(legacy)), P.placePath(home)); } catch (_) { toPlace = false; }
  let legacyReal = null;
  try { legacyReal = fs.realpathSync(legacy); } catch (_) { legacyReal = null; }
  out.legacy = { exists: Boolean(lk), kind: lk === 'link' && !legacyReal ? 'dangling' : lk, to_place: toPlace };
  const tree = state && typeof state.tree === 'string' ? state.tree : null;
  try {
    const c = require('../lib/legacy-names.js').countRegistered({ from: legacy, home, tree: where.dir || tree });
    const files = {};
    for (const f of c.files) files[f.file] = { count: f.count, permissions: f.permissions };
    out.registered_by_legacy = { total: c.total, files, unreadable: c.notes.length };
  } catch (e) { out.registered_by_legacy = notMeasured(`no se pudo contar (${code(e)})`); }
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  try {
    if (!tree) throw Object.assign(new Error('sin tree'), { code: 'NO_TREE' });
    const fixed = sha(path.join(pipeline, 'harness', 'bootstrap.js'));
    const inTree = sha(path.join(tree, 'scripts', 'setup', 'harness', 'bootstrap.js'));
    out.bootstrap = { fixed_sha256: fixed, tree_sha256: inTree, same: fixed === inTree };
  } catch (e) { out.bootstrap = notMeasured(`la copia fija o la del árbol no se pudo leer (${code(e)})`); }
  // las skills: de un clon aparte (~/.claude/agent-skills fuera del árbol) o del árbol mismo, y de qué commit
  const skillsClone = path.join(home, '.claude', 'agent-skills');
  let skillsDir = tree;
  let separate = false;
  try {
    const r = fs.realpathSync(skillsClone);
    const t = tree ? fs.realpathSync(tree) : null;
    separate = !t || !(r === t || r.startsWith(t + path.sep));
    if (separate) skillsDir = r;
  } catch (_) { separate = false; }
  let commit = notMeasured('sin carpeta de la que salgan las skills');
  if (skillsDir) { try { commit = headCommit(skillsDir); } catch (e) { commit = notMeasured(`no se pudo leer el commit (${code(e)})`); } }
  out.skills = { separate, commit };
  out.install = installFacts(state);
  return out;
}
/**
 * Cómo está instalado el arnés en esta máquina, como lo dice `harness.js doctor --json` (story 8.26, AC 40: versión
 * bajada y capa del equipo en todas las máquinas, sin pedirle nada a nadie). Sale del mismo estado que lee `doctor`
 * (`harness-state.json`), y de acá viaja lo que no identifica a nadie (el dato de la persona, `owner`, lo arma
 * placeFactsForMailbox, no esta función): el modo, el número de versión y, de la capa del
 * equipo, su nombre corto, cuántos archivos trajo y su commit. Nunca la dirección del repo de la capa. Un estado
 * ilegible es `no_medido`; un campo que no tiene la forma esperada va `null` (no se adivina).
 */
function installFacts(state) {
  if (!state || typeof state !== 'object') return { status: 'no_medido', reason: 'harness-state.json ilegible' };
  const mode = typeof state.mode === 'string' && /^[a-z][a-z-]{0,19}$/.test(state.mode) ? state.mode : null;
  const v = state.version && typeof state.version === 'object' ? state.version.number : null;
  const version = typeof v === 'string' && /^\d{4}\.\d{2}\.\d{2}\.\d{1,4}$/.test(v) ? v : null;
  let team = null;
  if (state.team && typeof state.team === 'object') {
    const t = state.team;
    team = {
      name: typeof t.name === 'string' && /^[\w.-]{1,40}$/.test(t.name) ? t.name : null,
      files: Number.isInteger(t.files) && t.files >= 0 ? t.files : null,
      commit: typeof t.commit === 'string' && /^[0-9a-f]{40}$/.test(t.commit) ? t.commit : null,
    };
  }
  return { mode, version, team };
}
/**
 * El commit de HEAD de un clon, LEYENDO .git (sin invocar git: este guion no usa git para nada, T18). Sigue `gitdir:` de
 * un worktree, `commondir`, la rama suelta y `packed-refs`. Tira si no lo encuentra.
 */
function headCommit(dir) {
  let gitDir = path.join(dir, '.git');
  const st = fs.statSync(gitDir);
  if (st.isFile()) gitDir = path.resolve(dir, fs.readFileSync(gitDir, 'utf8').replace(/^gitdir:\s*/, '').trim());
  let common = gitDir;
  try { common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch (_) { /* no es un worktree */ }
  const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
  if (/^[0-9a-f]{40}$/.test(head)) return head;
  const ref = (/^ref:\s*(refs\/\S+)$/.exec(head) || [])[1];
  if (!ref) throw Object.assign(new Error('HEAD sin forma'), { code: 'HEAD_SIN_FORMA' });
  for (const d of [gitDir, common]) {
    try { const v = fs.readFileSync(path.join(d, ref), 'utf8').trim(); if (/^[0-9a-f]{40}$/.test(v)) return v; } catch (_) { /* en packed-refs */ }
  }
  const packed = fs.readFileSync(path.join(common, 'packed-refs'), 'utf8').split('\n').map((l) => l.split(' ')).find((x) => x[1] === ref);
  if (packed && /^[0-9a-f]{40}$/.test(packed[0])) return packed[0];
  throw Object.assign(new Error('rama sin commit'), { code: 'REF_SIN_COMMIT' });
}

/** Los archivos a subir del registro de corridas, en orden: el volcado, su cambio y su hilo quedan juntos. */
function archivosDelRegistro(dir) {
  return fs.readdirSync(dir).filter((f) => FORMA_ARCHIVO.test(f)).sort();
}

/**
 * Un PUT de blob. Resuelve { status } o { error } — nunca rechaza. `cuerpo` es un Buffer entero en
 * memoria: el blob se manda entero o no se manda (los hilos pesan cientos de KB). Con `If-None-Match: *` siempre
 * (story 2.24): no pisar vale desde la subida, aunque la política del contenedor dejara escribir. Sólo el chequeo de
 * `--check-create-only` la saca (`pisar: true`), para probar que la política no deja.
 */
function ponerBlob(url, cuerpo, md5, timeoutMs, opciones = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    let hecho = false;
    const fin = (r) => { if (!hecho) { hecho = true; resolve(r); } };
    const headers = {
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-version': X_MS_VERSION,
      'Content-Length': cuerpo.length,
      'Content-MD5': md5,
      'Content-Type': 'application/octet-stream',
    };
    if (opciones.pisar !== true) headers['If-None-Match'] = '*';
    const req = mod.request(u, {
      method: 'PUT',
      headers,
      timeout: timeoutMs,
    }, (res) => {
      const trozos = [];
      res.on('data', (c) => { if (trozos.length < 64) trozos.push(c); });
      res.on('end', () => fin({ status: res.statusCode, codigo: (Buffer.concat(trozos).toString('utf8').match(/<Code>([^<]*)<\/Code>/) || [])[1] || null }));
      res.on('error', (e) => fin({ error: e }));
    });
    req.on('timeout', () => { req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); });
    req.on('error', (e) => fin({ error: e }));
    req.end(cuerpo);
  });
}

async function subir(opts = {}) {
  const res = {
    subido: false, estado: null, motivo: null, maquina: null,
    a_subir: 0, subidos: 0, bytes: 0, sin_tiempo: 0, ya_existian: 0, aviso_vence: null,
  };
  // story 2.24: el inicio de la pasada es la versión de todo lo que esta pasada vuelve a subir
  const pasada = ahoraMs();
  const log = (m) => { if (opts.log) opts.log(m); };
  // 🔴 Una pasada que no terminó bien NUNCA dice «subido», aunque haya subido algo antes de fallar: lo
  //    confirmado queda anotado y contado en `subidos`; `subido` es el veredicto de la pasada (AC3).
  const fin = (codigo, estado, motivo) => { res.estado = estado; if (motivo) res.motivo = motivo; if (codigo !== 0) res.subido = false; return { codigo, res }; };

  // 🔴 story 2.12: un agente de CI no es una máquina del equipo. El banco nocturno corría una prueba que lanzaba el
  //    instalador real con el HOME del agente, y el agente subió sus registros al buzón como si fuera una máquina
  //    (`runnervmg34hb/`, 2026-09-17 05:01 UTC); cada noche el nombre cambia, así que sería una «máquina» nueva por
  //    noche en la cuenta del equipo. Dentro de una corrida de Azure DevOps (TF_BUILD) no se prepara ni se sube nada al
  //    buzón REAL. Con un destino de prueba (TYCON_MAILBOX_URL_BASE) la guarda no aplica: las suites siguen probando.
  if (/^true$/i.test(String(process.env.TF_BUILD || '').trim()) && !variable('TYCON_MAILBOX_URL_BASE')) {
    const motivo = 'esto corre dentro de una corrida de Azure DevOps (TF_BUILD): un agente de CI no es una máquina del equipo y no sube al buzón';
    log(motivo);
    return fin(0, 'agente_ci', motivo);
  }

  const origen = path.resolve(process.env.TYCON_TIMING_HISTORY || path.join(CASA_PIPELINE, 'timing-history'));
  const dirRegistros = path.resolve(variable('TYCON_LOGS_DIR') || path.join(CASA_PIPELINE, 'registros-buzon'));
  const rutaRegistro = path.resolve(variable('TYCON_UPLOADS_LOG') || path.join(CASA_PIPELINE, 'mailbox-uploads.json'));

  // 0 · la integración (story 8.3): apagada → exit 0 y una línea; rota → exit 2 con archivo, clave y motivo
  const integ = integracionBuzon();
  if (integ.error) { log(integ.error); return fin(2, 'config_rota', integ.error); }
  if (!integ.prendida) { log(integ.apagada); return fin(0, 'apagado', integ.apagada); }

  // 1 · la llave
  const lc = leerConfig();
  if (!lc.cfg) return fin(1, lc.estado, lc.motivo);
  const { cfg } = lc;
  const negativa = negativaDeLaLlave(cfg.sas);
  if (negativa) return fin(2, negativa.estado, negativa.motivo);

  const dias = diasHasta(cfg.vence.trim());
  if (dias <= DIAS_AVISO_VENCE) {
    const texto = dias < 0
      ? `la llave del buzón VENCIÓ el ${cfg.vence} (política ${cfg.politica || '?'}): hay que rotarla — pasos en corridas-buzon.json → "rotar"`
      : `la llave del buzón vence el ${cfg.vence} (en ${dias} día${dias === 1 ? '' : 's'}, política ${cfg.politica || '?'}): hay que rotarla — pasos en corridas-buzon.json → "rotar"`;
    res.aviso_vence = selloDiario(path.join(path.dirname(rutaRegistro), 'upload-runs-expiry.seal'), texto);
    if (res.aviso_vence === 'emitido') log(texto);
  }

  // story 2.28: la carpeta de esta máquina (`<nombre>-<código>`). La primera pasada con la carpeta nueva vuelve a subir
  // ahí lo que hay en el disco: la clave del registro de subidas empieza con la carpeta (decisión 12).
  let carpeta;
  try { carpeta = carpetaDeMaquina({ crear: true, hoy: diaDeRegistros(), registro: rutaRegistro }); }
  catch (e) { return fin(1, 'sin_maquina', `no se pudo guardar el código de esta máquina (machine-code.json: ${e.code || 'error'})`); }
  const maquina = carpeta.nombre;
  res.maquina = maquina || null;
  if (!maquina || !FORMA_MAQUINA.test(maquina)) return fin(1, 'sin_maquina', 'no se pudo saber el nombre de esta máquina (hostname vacío o sin forma de nombre)');
  if (carpeta.regenerado) log(`el código de esta máquina se regeneró (${carpeta.regenerado}): sube a la carpeta nueva ${maquina}; un mantenedor la tiene que confirmar`);

  // 2 · lo que hay y lo que ya subió. 🔴 Los REGISTROS de frenos y escapes van PRIMERO en la cola (story 2.5):
  //    con un atraso de hilos y el presupuesto chico, al final de la cola no entrarían nunca. Los .gz antes y la
  //    cobertura al final: un corte a mitad no deja una cobertura nueva apuntando a registros viejos.
  const entradas = [];
  const noLeidos = [];
  let prep = { estado: 'sin_carpeta' };
  try { prep = prepararRegistros({ folder: carpeta.folder }); }
  catch (e) { noLeidos.push(`registros de frenos y escapes (${e.code || 'error'})`); }
  res.registros = prep.estado;
  // story 8.19 (AC 21): lo que va en place.json, también en la salida (--json)
  try { res.place = JSON.parse(fs.readFileSync(path.join(dirRegistros, 'place.json'), 'utf8')); } catch (_) { res.place = null; }
  // story 2.24: el juego del día sube ENTERO bajo `registros/v<momento de la preparación>/`; la clave en el registro
  // local lleva la versión, así un archivo idéntico al de ayer sube igual con el juego nuevo.
  const juego = typeof prep.version === 'string' && FORMA_VERSION.test(prep.version) ? prep.version : null;
  if (prep.estado !== 'sin_carpeta' && juego) {
    let nombres = [];
    try { nombres = fs.readdirSync(dirRegistros).filter((x) => FORMA_REGISTRO.test(x)); }
    catch (e) { if (e.code !== 'ENOENT') noLeidos.push(`registros de frenos y escapes (${e.code || 'error'})`); }
    nombres.sort((a, b) => (a === 'cobertura.json') - (b === 'cobertura.json') || (a < b ? -1 : a > b ? 1 : 0));
    for (const f of nombres) entradas.push({ dir: dirRegistros, f, juego, clave: `${maquina}/registros/${juego}/${f}`, blob: `${maquina}/registros/${juego}/${f}` });
  } else if (prep.estado !== 'sin_carpeta') noLeidos.push('registros de frenos y escapes (la preparación no tiene momento: no se sabe su versión)');
  try { for (const f of archivosDelRegistro(origen)) entradas.push({ dir: origen, f, juego: null, clave: `${maquina}/${f}`, blob: `${maquina}/${f}` }); }
  catch (e) {
    // Una máquina que nunca corrió el pipeline no tiene la carpeta: es «nada que subir» de corridas, no un fallo en cada arranque.
    if (e.code !== 'ENOENT') return fin(1, 'sin_registro', `no se pudo leer el registro de corridas ${origen} (${e.code || e.message})`);
    // 🔴 «Nada que subir» sólo si tampoco hubo un error con los registros: si no, eso sale 1 al final (parcial).
    if (!entradas.length && !noLeidos.length) { log(`esta máquina todavía no tiene corridas del pipeline (${origen}): nada que subir`); return fin(0, 'sin_corridas'); }
  }

  const destino = `${cfg.cuenta}/${cfg.contenedor}`;
  let registro = { version: 1, destino, archivos: {} };
  try {
    // story 8.9 (tanda D2): el registro cambió de nombre; si sólo está el de antes, se lee ése
    const r = JSON.parse(fs.readFileSync(resolveFile(rutaRegistro, { where: DONDE }), 'utf8'));
    // Otro buzón (la llave se rotó a otra cuenta o contenedor): lo anotado no vale para éste.
    if (r && r.destino === destino && r.archivos && typeof r.archivos === 'object') registro = r;
  } catch (e) {
    if (e.code !== 'ENOENT') log(`(el registro de subidas ${rutaRegistro} no se pudo leer — ${e.code || 'JSON inválido'}: se toma como vacío y se vuelve a subir todo)`);
  }
  // el de antes del renombre pasa al nuevo antes de la primera escritura (el que se escribe ya lo trae en `registro`)
  const guardar = () => { prepareStateWrite(rutaRegistro, { where: DONDE }); escribirAtomico(rutaRegistro, JSON.stringify(registro, null, 1) + '\n'); };

  let cambioRegistro = false;
  const pendientes = [];
  // story 2.24 (AC 6): un archivo del juego ya confirmado que cambió NO se vuelve a mandar a su nombre: el juego se
  // da por roto en esta pasada y se re-prepara (la pasada siguiente lo sube entero bajo otra versión).
  const juegosRotos = new Set();
  for (const { dir, f, clave, blob, juego: suJuego } of entradas) {
    const local = path.join(dir, f);
    let st;
    try { st = fs.statSync(local); } catch (e) { if (e.code !== 'ENOENT') noLeidos.push(`${f} (${e.code || e.message})`); continue; }
    if (!st.isFile()) continue;
    const prev = registro.archivos[clave];
    if (prev && prev.size === st.size && Math.floor(prev.mtimeMs) === Math.floor(st.mtimeMs)) continue;
    let cuerpo;
    try { cuerpo = fs.readFileSync(local); } catch (e) { noLeidos.push(`${f} (${e.code || e.message})`); continue; }
    const sha256 = crypto.createHash('sha256').update(cuerpo).digest('hex');
    if (prev && prev.size === cuerpo.length && prev.sha256 === sha256) {
      // Mismo contenido con otro mtime (un touch): se recuerda el mtime para no volver a hashear.
      registro.archivos[clave] = { ...prev, mtimeMs: st.mtimeMs };
      cambioRegistro = true;
      continue;
    }
    if (prev && suJuego) { juegosRotos.add(suJuego); continue; }
    // story 2.24: lo que ya se confirmó y cambió va a una versión —el inicio de la pasada, monótono por archivo—, nunca
    // al nombre anterior. Una entrada de antes de la 2.24 (sin `blob`) apunta al nombre de siempre.
    if (prev && !suJuego) {
      const version = versionMonotona(pasada, prev.version);
      pendientes.push({ f, dir, clave, blob: `${maquina}/${version}/${f}`, version, previa: prev.version || null, juego: null, mtimeMs: st.mtimeMs, size: cuerpo.length, sha256 });
      continue;
    }
    pendientes.push({ f, dir, clave, blob, version: null, previa: null, juego: suJuego || null, mtimeMs: st.mtimeMs, size: cuerpo.length, sha256 });
  }
  res.a_subir = pendientes.length;

  if (opts.dryRun) {
    log(`--dry-run: subiría ${res.a_subir} archivo(s) a ${maquina}/ en ${destino} — no se mandó nada`);
    return fin(0, 'dry_run');
  }
  if (cambioRegistro) { try { guardar(); } catch (_) { /* sólo ahorra hashes */ } }

  // 3 · subir, blob por blob, dentro del presupuesto
  const base = urlBase(cfg);
  const inicio = Date.now();
  const tope = Number.isFinite(opts.budgetMs) ? opts.budgetMs : 90000;
  const noSubidos = [];
  // story 2.24 (AC 10): un juego de registros que falló por «ya existe» (o que cambió después de confirmado) no se
  // reintenta archivo por archivo: se invalida la preparación local, se sacan del registro local sus claves y el resto
  // del juego no se manda en esta pasada. Nunca queda en el buzón una versión con cobertura y sin alguno de sus registros.
  const juegosFallidos = new Set();
  const fallarJuego = (version, motivo) => {
    if (juegosFallidos.has(version)) return;
    juegosFallidos.add(version);
    noSubidos.push(`juego de registros ${version} (${motivo}: se re-prepara en la pasada siguiente)`);
    try { invalidarPreparacion(dirRegistros, version); }
    catch (e) { noLeidos.push(`registros de frenos y escapes (no se pudo invalidar la preparación: ${e.code || 'error'})`); }
    const prefijo = `${maquina}/registros/${version}/`;
    let saco = false;
    for (const k of Object.keys(registro.archivos)) if (k.startsWith(prefijo)) { delete registro.archivos[k]; saco = true; }
    if (saco) { try { guardar(); } catch (_) { /* la pasada siguiente usa otra versión: estas claves no se vuelven a mirar */ } }
  };
  for (const v of juegosRotos) fallarJuego(v, 'un registro cambió después de confirmado');
  const urlDe = (blob) => `${base}/${encodeURIComponent(cfg.contenedor)}/${blob.split('/').map(encodeURIComponent).join('/')}?${cfg.sas}`;
  const confirmadosAntes = () => (res.subidos ? ` — los ${res.subidos} archivo(s) que el servicio confirmó antes sí quedaron anotados` : '');
  // 🔴 La cobertura de registros sube sólo si en ESTA pasada no falló ningún registro: si no, quedaría en el buzón
  //    una cobertura nueva declarando «medido» un registro que sigue siendo el viejo.
  const esRegistro = (p) => p.blob.includes('/registros/') && p.f !== 'cobertura.json';
  // 🔴 Una falla ANTERIOR a la cola cuenta si es de un registro, reconocido por su NOMBRE exacto (story 2.9).
  //    Antes se reconocía por «.log.gz », que no ve `hallazgos.jsonl.gz`; y ampliarlo a «.jsonl.gz » a secas
  //    lo dispararía también por el hilo de una corrida (`*.hilo.jsonl.gz`).
  const esFallaDeRegistro = (x) => x.startsWith('registros de frenos y escapes') || REGISTROS.some((r) => x.startsWith(`${r}.gz `));
  let registroFallido = noLeidos.some(esFallaDeRegistro) || juegosFallidos.size > 0;
  for (let i = 0; i < pendientes.length; i++) {
    if (Date.now() - inicio > tope) { res.sin_tiempo = pendientes.length - i; break; }
    const p = pendientes[i];
    if (p.juego && juegosFallidos.has(p.juego)) continue;
    if (p.f === 'cobertura.json' && p.blob.includes('/registros/') && registroFallido) {
      noSubidos.push('cobertura.json de registros (retenida: un registro de esta pasada no subió)');
      continue;
    }
    // 🔴 El stat se toma ANTES de leer: si el archivo se reescribe durante el PUT, el mtime anotado es el viejo
    //    y la pasada siguiente lo re-hashea y lo re-sube. Con el de después, un cambio del mismo tamaño quedaba
    //    como «subido» para siempre (pase adversarial).
    let cuerpo, stAntes;
    try { stAntes = fs.statSync(path.join(p.dir, p.f)); cuerpo = fs.readFileSync(path.join(p.dir, p.f)); } catch (e) { noLeidos.push(`${p.f} (${e.code || e.message})`); if (esRegistro(p)) registroFallido = true; continue; }
    // El archivo cambió entre el recorrido y la subida (el barrido de la 2.13 lo reescribió): va lo de ahora.
    const sha256 = crypto.createHash('sha256').update(cuerpo).digest('hex');
    const md5 = crypto.createHash('md5').update(cuerpo).digest('base64');
    const tiempo = Math.max(30000, Math.min(120000, cuerpo.length / 50));
    let blob = p.blob;
    let version = p.version;
    let r = await ponerBlob(urlDe(blob), cuerpo, md5, tiempo);
    let reintentado = false;
    // story 2.24 (AC 7): «ya existe» en un archivo de corrida → UNA vez más, con una versión nueva (la llave no lee: no
    // puede saber si lo que está es igual a lo de la máquina, y un duplicado cuesta menos que un dato viejo).
    if (!r.error && respuestaDelBuzon(r) === 'ya_existe' && !p.juego) {
      reintentado = true;
      const vistas = [msDeVersion(version), msDeVersion(p.previa)].filter((x) => x !== null);
      version = versionMonotona(Math.max(ahoraMs(), pasada), vistas.length ? Math.max(...vistas) : null);
      blob = `${maquina}/${version}/${p.f}`;
      r = await ponerBlob(urlDe(blob), cuerpo, md5, tiempo);
    }
    if (r.error) {
      const c = r.error.code || r.error.message;
      return fin(1, 'sin_red', `sin red o sin respuesta del buzón (${c}) al subir ${p.f}: no se marcó nada más; sube en el próximo arranque${res.subidos ? ` — los ${res.subidos} archivo(s) confirmados antes del corte sí quedaron anotados` : ''}`);
    }
    const codigo = `${r.status}${r.codigo ? ` ${r.codigo}` : ''}`;
    const tipo = respuestaDelBuzon(r);
    if (tipo === 'sin_permiso') {
      return fin(1, 'llave_sin_permiso', `la política del buzón no deja crear (política ${cfg.politica || '?'}): revisarla (${codigo} al subir ${p.f}). No se marcó nada más${confirmadosAntes()}`);
    }
    if (tipo === 'llave') {
      return fin(1, 'llave_invalida', `el buzón rechazó la llave (${codigo}): vencida o revocada, o inválida — hay que rotarla (corridas-buzon.json → "rotar", vence ${cfg.vence}). No se marcó nada más${confirmadosAntes()}`);
    }
    if (tipo === 'servicio') {
      return fin(1, 'servicio_fallo', `el servicio del buzón falló (${codigo}) al subir ${p.f}: no se marcó nada más; se reintenta en el próximo arranque${confirmadosAntes()}`);
    }
    if (tipo === 'ya_existe' && p.juego) { fallarJuego(p.juego, `${p.f} ya existía (${codigo})`); registroFallido = true; continue; }
    if (tipo === 'ya_existe') { noSubidos.push(`${p.f} (${codigo}: ya existía también con una versión nueva)`); continue; }
    if (tipo !== 'creado') { noSubidos.push(`${p.f} (${codigo})`); if (esRegistro(p)) registroFallido = true; continue; }
    if (reintentado) res.ya_existian += 1;
    // 🔴 recién con el 201 se anota — y se persiste ya, archivo por archivo (story 2.24: con el blob y la versión)
    registro.archivos[p.clave] = { size: cuerpo.length, mtimeMs: Math.min(stAntes.mtimeMs, p.mtimeMs), sha256, subido: new Date().toISOString(), blob, version: version || p.juego || null };
    try { guardar(); }
    catch (e) { return fin(1, 'registro_ilegible', `${p.f} subió pero el registro de subidas ${rutaRegistro} no se pudo escribir (${e.code || e.message}): la pasada siguiente lo volvería a subir`); }
    res.subidos += 1;
    res.bytes += cuerpo.length;
    res.subido = true;
  }

  if (noLeidos.length || noSubidos.length) {
    if (noLeidos.length) res.no_leidos = noLeidos;
    if (noSubidos.length) res.no_subidos = noSubidos;
    const partes = [];
    if (noLeidos.length) partes.push(`${noLeidos.length} archivo(s) del registro no se pudieron leer: ${noLeidos.slice(0, 3).join(', ')}${noLeidos.length > 3 ? '…' : ''}`);
    if (noSubidos.length) partes.push(`${noSubidos.length} el buzón no los aceptó: ${noSubidos.slice(0, 3).join(', ')}${noSubidos.length > 3 ? '…' : ''}`);
    return fin(1, 'parcial', `${partes.join(' · ')}${res.subidos ? ` — ${res.subidos} sí subieron` : ''}`);
  }
  if (!res.subidos) {
    log(`nada nuevo que subir desde ${maquina}${res.sin_tiempo ? ` (${res.sin_tiempo} quedaron sin tiempo)` : ''}`);
    return fin(0, res.sin_tiempo ? 'sin_tiempo' : 'nada_nuevo');
  }
  log(`subido: ${res.subidos} archivo(s), ${res.bytes} bytes, a ${maquina}/ en ${destino}${res.sin_tiempo ? ` · ${res.sin_tiempo} quedaron sin tiempo para el próximo arranque` : ''}`);
  return fin(0, 'subido');
}

/**
 * --check-create-only (story 2.24, AC 16): ¿la política del buzón deja pisar? Vuelve a subir LOS MISMOS BYTES del blob
 * confirmado más chico de esta máquina —cuyo archivo local tiene todavía el sha256 anotado— a su nombre, SIN
 * If-None-Match. Con la política «sólo crear» el buzón contesta 403 UnauthorizedBlobOverwrite. Nunca manda bytes
 * distintos de los confirmados: en el peor caso (la política deja escribir) el blob queda igual. Nunca imprime la firma.
 */
async function chequearSoloCrear(opts = {}) {
  const res = { estado: null, motivo: null, maquina: null };
  const fin = (codigo, estado, motivo) => { res.estado = estado; if (motivo) res.motivo = motivo; return { codigo, res }; };
  const integ = integracionBuzon();
  if (integ.error) return fin(2, 'config_rota', integ.error);
  if (!integ.prendida) return fin(0, 'apagado', integ.apagada);
  const lc = leerConfig();
  if (!lc.cfg) return fin(1, lc.estado, lc.motivo);
  const { cfg } = lc;
  const negativa = negativaDeLaLlave(cfg.sas);
  if (negativa) return fin(2, negativa.estado, negativa.motivo);
  const maquina = nombreDeMaquina();
  res.maquina = maquina || null;
  if (!maquina || !FORMA_MAQUINA.test(maquina)) return fin(1, 'sin_maquina', 'no se pudo saber el nombre de esta máquina (hostname vacío o sin forma de nombre)');
  const origen = path.resolve(process.env.TYCON_TIMING_HISTORY || path.join(CASA_PIPELINE, 'timing-history'));
  const dirRegistros = path.resolve(variable('TYCON_LOGS_DIR') || path.join(CASA_PIPELINE, 'registros-buzon'));
  const rutaRegistro = path.resolve(variable('TYCON_UPLOADS_LOG') || path.join(CASA_PIPELINE, 'mailbox-uploads.json'));
  let registro = null;
  try {
    const r = JSON.parse(fs.readFileSync(resolveFile(rutaRegistro, { where: DONDE }), 'utf8'));
    if (r && r.destino === `${cfg.cuenta}/${cfg.contenedor}` && r.archivos && typeof r.archivos === 'object') registro = r;
  } catch (_) { /* sin registro: no medido */ }
  if (!registro) return fin(1, 'no_medido', `no medido: esta máquina no tiene un registro de subidas a este buzón (${rutaRegistro}): no hay un blob confirmado que volver a subir`);
  // el archivo local de cada clave: `<maq>/registros/[v…/]<f>` → la preparación; `<maq>/<f>` → el registro de corridas
  const candidatos = [];
  for (const [clave, e] of Object.entries(registro.archivos)) {
    if (!clave.startsWith(`${maquina}/`) || !e || typeof e.sha256 !== 'string' || !Number.isInteger(e.size)) continue;
    const partes = clave.split('/');
    const f = partes[partes.length - 1];
    const local = partes[1] === 'registros' ? path.join(dirRegistros, f) : (partes.length === 2 ? path.join(origen, f) : null);
    if (local) candidatos.push({ clave, e, f, local });
  }
  candidatos.sort((a, b) => a.e.size - b.e.size || (a.clave < b.clave ? -1 : 1));
  for (const c of candidatos) {
    let cuerpo;
    try { cuerpo = fs.readFileSync(c.local); } catch (_) { continue; }
    if (crypto.createHash('sha256').update(cuerpo).digest('hex') !== c.e.sha256) continue;
    const blob = typeof c.e.blob === 'string' && c.e.blob.startsWith(`${maquina}/`) ? c.e.blob : c.clave;
    const md5 = crypto.createHash('md5').update(cuerpo).digest('base64');
    const url = `${urlBase(cfg)}/${encodeURIComponent(cfg.contenedor)}/${blob.split('/').map(encodeURIComponent).join('/')}?${cfg.sas}`;
    const r = await ponerBlob(url, cuerpo, md5, 30000, { pisar: true });
    res.archivo = c.f;
    res.bytes = cuerpo.length;
    if (r.error) return fin(1, 'sin_red', `sin red o sin respuesta del buzón (${r.error.code || r.error.message}): no se pudo comprobar`);
    const codigo = `${r.status}${r.codigo ? ` ${r.codigo}` : ''}`;
    res.respuesta = codigo;
    if (r.status === 403 && r.codigo === 'UnauthorizedBlobOverwrite') return fin(0, 'solo_crear', `la política no deja pisar (${codigo}, política ${cfg.politica || '?'}): el buzón sólo crea`);
    if (r.status === 201) return fin(1, 'dejo_escribir', `la política dejó escribir, o el blob ya no estaba (201, política ${cfg.politica || '?'}): lo verifica con az storage blob show alguien con el rol de lectura. Se mandaron los mismos bytes confirmados: el blob quedó igual`);
    return fin(1, 'otro', `el buzón contestó ${codigo} al volver a subir los mismos bytes (política ${cfg.politica || '?'}): no prueba ni «sólo crear» ni lo contrario`);
  }
  return fin(1, 'no_medido', `no medido: ningún blob confirmado de esta máquina tiene todavía su archivo local con el mismo sha256 (${candidatos.length} anotado(s)): no se manda nada distinto de lo confirmado`);
}

module.exports = { placeFactsForMailbox, subir, chequearSoloCrear, respuestaDelBuzon, versionDe, msDeVersion, FORMA_VERSION, nombreDeMaquina, nombreBaseDeMaquina, carpetaDeMaquina, leerCodigoDeMaquina, rutaCodigoDeMaquina, correoDeGitGlobal, huellaDeCorridas, FORMA_CODIGO, normalizarNombreDeMaquina, leerConfig, integracionBuzon, negativaDeLaLlave, rutaConfig, urlBase, FORMA_MAQUINA, FORMA_ARCHIVO, FORMA_REGISTRO, REGISTROS, prepararRegistros, usosParaElBuzon, X_MS_VERSION };

/**
 * `--log <archivo>`: la salida (la estándar y la de error) se AGREGA a ese archivo, que pasado ~512 KB se mueve a `.1`.
 * Lo usa el arranque de Windows (2026-10-15): un proceso de fondo de PowerShell no puede agregar a un archivo, y
 * sobrescribir el registro borraría el aviso de vencimiento de la llave, que sale una vez por día (la razón del `>>` y
 * del `rotar` del instalador .sh, que no lo usa). Si el registro no se puede abrir, la salida queda donde estaba.
 */
function salidaAlRegistro(archivo) {
  try {
    fs.mkdirSync(path.dirname(path.resolve(archivo)), { recursive: true });
    try { if (fs.statSync(archivo).size > 524288) fs.renameSync(archivo, `${archivo}.1`); } catch (_) { /* no había registro */ }
    const fd = fs.openSync(archivo, 'a');
    const escribir = (trozo, enc, cb) => {
      // si el registro no se puede escribir (disco lleno, bloqueado), el trozo va a la salida de error de siempre
      try { fs.writeSync(fd, typeof trozo === 'string' ? trozo : Buffer.from(trozo)); } catch (_) { try { fs.writeSync(2, trozo); } catch (__) { /* sin salida */ } }
      if (typeof enc === 'function') enc(); else if (typeof cb === 'function') cb();
      return true;
    };
    process.stdout.write = escribir;
    process.stderr.write = escribir;
    // lo que Node imprimiría por su cuenta (una excepción o un rechazo sin atrapar) iría directo a la salida de error, que
    // en el arranque de Windows es una ventana oculta: va al registro, y la corrida sale 1
    const caida = (e) => { escribir(`[${new Date().toISOString().slice(0, 19).replace('T', ' ')}] error inesperado: ${e && e.stack ? e.stack : e}\n`); process.exit(1); };
    process.on('uncaughtException', caida);
    process.on('unhandledRejection', caida);
    return true;
  } catch (e) {
    console.error(`no pude abrir el registro ${archivo}: ${e.message} — la salida sigue por la terminal`);
    return false;
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const valor = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  if (valor('--log')) salidaAlRegistro(valor('--log'));
  const json = args.includes('--json');
  const budget = valor('--budget-ms');
  const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
  const accion = args.includes('--check-create-only') ? chequearSoloCrear : subir;
  accion({
    dryRun: args.includes('--dry-run'),
    budgetMs: budget !== undefined ? Number(budget) : undefined,
    log: (m) => (json ? console.error : console.log)(`[${stamp()}] ${m}`),
  }).then(({ codigo, res }) => {
    if (res.motivo && codigo !== 0) console.error(`[${stamp()}] ${res.estado}: ${res.motivo}`);
    if (json) console.log(JSON.stringify(res, null, 2));
    process.exitCode = codigo;
  }, (e) => {
    console.error(`[${stamp()}] error inesperado: ${e && e.stack ? e.stack : e}`);
    process.exitCode = 1;
  }).catch((e) => {
    // un error al informar el resultado (después de subir) también se dice
    console.error(`[${stamp()}] error inesperado al informar: ${e && e.stack ? e.stack : e}`);
    process.exitCode = 1;
  });
}
