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
 * 🔴 LA LLAVE SÓLO ESCRIBE. `corridas-buzon.json` (commiteado, excepción escrita a la política de
 *    credenciales del repo) trae una SAS atada a una política guardada del contenedor con permisos `cw`:
 *    no lista, no lee, no borra — ni siquiera lo propio. Por eso:
 *      · este guion sólo hace PUT, y se NIEGA (exit 2) si la SAS trae permisos de lectura/listado/borrado
 *        propios (`sp=` con r, l, d…) o si es una SAS de CUENTA (`ss=`/`srt=`);
 *      · qué ya subió lo recuerda un REGISTRO LOCAL (`~/.claude/.tycon-pipeline/mailbox-uploads.json`:
 *        tamaño, mtime y sha256 por archivo), que se anota archivo por archivo y SÓLO después de que el
 *        servicio confirmó con 201. Un corte a mitad nunca queda como «subido».
 *
 * 🔴 «NO SUBIDO» NUNCA SE LEE COMO «SUBIDO». Llave vencida o revocada (403/404) y sin red son motivos
 *    distintos — el primero pide rotar la llave, el segundo esperar—, y ninguno marca nada. Sale ≠ 0; el
 *    instalador lo corre de fondo, así que no pone rojo el arranque: queda en `upload-runs.log`.
 *
 * 🔴 Y LOS REGISTROS DE FRENOS Y ESCAPES (story 2.5, rediseño 2026-09-15): una vez por día prepara
 *    `gates.log.gz`, `bypass.log.gz` (los registros completos de `~/.claude/.tycon-pipeline/`, comprimidos) y
 *    un `cobertura.json` que dice si pudo leer cada uno, en `~/.claude/.tycon-pipeline/registros-buzon/`, y los
 *    sube como `<maquina>/registros/<archivo>` ANTES que las corridas —pesan poco y al final de la cola no
 *    entrarían—, con la cobertura al final de los tres: es la marca de que los de arriba están completos. Un
 *    registro que no existe se DECLARA (`no_medido`) y no se sube vacío. De esa carpeta no sube nada más. La
 *    cuenta la hace `scripts/nightly/dashboard/reducer.js`, donde el buzón está bajado; lo que llega a la página del
 *    equipo es sólo la cuenta. Entre esos registros va también `legacy-names.jsonl` (story 8.9, AC 52: los usos de nombres
 *    viejos, con los que se decide su retiro), proyectado a sus campos y con sus conteos en la cobertura.
 *
 * 🔴 Y DÓNDE VIVE EL ARNÉS (story 8.19, tanda B · AC 21): el mismo día, con los registros, prepara `place.json` —en qué
 *    nombre vive el arnés, si el nombre viejo existe, cuánto queda registrado por él (por archivo, con la misma expresión
 *    que `harness.js doctor`), el sha256 de la copia fija de arranque contra el del árbol, y si las skills salen de un
 *    clon aparte y de qué commit—. Es la evidencia con la que la story 8.15 retira el nombre viejo. Sólo números, hashes
 *    y nombres de archivo; un dato que no se pudo leer va `no_medido`. Una máquina sin el mecanismo no lo sube.
 *    Desde la story 8.26 (AC 40) trae también `install`: el modo (`managed` es la versión bajada), el número de versión
 *    y la capa del equipo (nombre, archivos y commit), lo mismo que `doctor --json`, para saber cómo está cada máquina
 *    sin pedirle a nadie que corra nada.
 *
 * Nada de esto pregunta ni abre un login: no usa git, ni `az`, ni credenciales de la persona.
 *
 * Uso:
 *   node scripts/metrics/upload-runs.js [--json] [--dry-run] [--budget-ms N]
 *
 * Contrato de salida:
 *   0 → subió, no había nada nuevo, o --dry-run (con o sin aviso de vencimiento), o corre dentro de una corrida de
 *       Azure DevOps (`agente_ci`, story 2.12: un agente de CI no es una máquina del equipo)
 *   1 → no pudo (sin llave, llave ilegible, vencida/revocada, sin red, el servicio falló, algo ilegible)
 *   2 → se negó (la llave permite leer, listar o borrar, o es de cuenta)
 *
 * Variables (para el banco de pruebas): TYCON_MAILBOX_JSON, TYCON_MAILBOX_URL_BASE, TYCON_TIMING_HISTORY,
 * TYCON_UPLOADS_LOG, TYCON_MACHINE, TYCON_LOGS_SOURCE, TYCON_LOGS_DIR, TYCON_TODAY.
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

function nombreDeMaquina() {
  let n = variable('TYCON_MACHINE');
  if (!n && process.platform === 'darwin') n = nombreEstableDeMac();
  if (!n) { try { n = os.hostname(); } catch (_) { n = ''; } }
  return normalizarNombreDeMaquina(n);
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
 * La usan la subida (necesita `sas`) y la bajada (necesita `tenant`): `requiere` dice qué campos exige.
 */
function leerConfig(requiere = ['cuenta', 'contenedor', 'sas', 'vence']) {
  const ruta = rutaConfig();
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

/** Por qué esta SAS NO se acepta para subir, o null. Nunca imprime la firma. */
function negativaDeLaLlave(sas) {
  const p = new URLSearchParams(sas);
  if (!p.get('sig')) return 'la SAS del buzón no trae firma (sig): no es una llave';
  if (p.has('ss') || p.has('srt')) return 'la SAS del buzón es de CUENTA (ss/srt): sólo se acepta una SAS de contenedor atada a una política de escritura';
  const sp = p.get('sp');
  if (sp && /[^cwa]/.test(sp)) return `la SAS del buzón trae permisos propios «${sp}» que permiten más que escribir (leer, listar o borrar): esta llave no se acepta`;
  if (!p.get('si')) return 'la SAS del buzón no está atada a una política guardada (si): no se puede revocar sin rotar la cuenta';
  return null;
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
  try {
    const c = JSON.parse(fs.readFileSync(coberturaArchivo, 'utf8'));
    if (c && c.esquema === 1 && c.fecha === dia) return { estado: 'ya_preparado_hoy' };
  } catch (_) { /* primera vez, o ilegible: se prepara */ }
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
  try { facts = placeFactsForMailbox(dia); } catch (e) { facts = { schema: 1, day: dia, place: { status: 'no_medido', reason: `no se pudo mirar (${(e && e.code) || 'error'})` } }; }
  if (facts) escribirAtomico(lugar, `${JSON.stringify(facts, null, 1)}\n`);
  else { try { fs.unlinkSync(lugar); } catch (_) { /* no estaba */ } }
  escribirAtomico(coberturaArchivo, `${JSON.stringify({ esquema: 1, fecha: dia, fuentes }, null, 1)}\n`);
  return { estado: 'preparado', fuentes };
}

/**
 * Dónde vive el arnés en esta máquina (story 8.19, tanda B · AC 21), como viaja al buzón: SÓLO números, hashes y nombres
 * de archivo (nunca una ruta con la carpeta de la persona; los motivos, códigos de error). Un dato que no se pudo leer va
 * `{ status: 'no_medido', reason }`. null si la máquina no tiene el mecanismo instalado (no participa).
 */
function placeFactsForMailbox(day) {
  const home = os.homedir();
  const pipeline = path.join(stateDirOf(home));
  const notMeasured = (reason) => ({ status: 'no_medido', reason });
  const code = (e) => (e && (e.code || e.name)) || 'error';
  let state = null;
  try { state = JSON.parse(fs.readFileSync(path.join(pipeline, 'harness-state.json'), 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return null;
    state = null;
  }
  const out = { schema: 1, day };
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
 * (`harness-state.json`), y viaja sólo lo que no identifica a nadie: el modo, el número de versión y, de la capa del
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
 * memoria: el blob se manda entero o no se manda (los hilos pesan cientos de KB).
 */
function ponerBlob(url, cuerpo, md5, timeoutMs) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    let hecho = false;
    const fin = (r) => { if (!hecho) { hecho = true; resolve(r); } };
    const req = mod.request(u, {
      method: 'PUT',
      headers: {
        'x-ms-blob-type': 'BlockBlob',
        'x-ms-version': X_MS_VERSION,
        'Content-Length': cuerpo.length,
        'Content-MD5': md5,
        'Content-Type': 'application/octet-stream',
      },
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
    a_subir: 0, subidos: 0, bytes: 0, sin_tiempo: 0, aviso_vence: null,
  };
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
  if (negativa) return fin(2, 'llave_con_lectura', negativa);

  const dias = diasHasta(cfg.vence.trim());
  if (dias <= DIAS_AVISO_VENCE) {
    const texto = dias < 0
      ? `la llave del buzón VENCIÓ el ${cfg.vence} (política ${cfg.politica || '?'}): hay que rotarla — pasos en corridas-buzon.json → "rotar"`
      : `la llave del buzón vence el ${cfg.vence} (en ${dias} día${dias === 1 ? '' : 's'}, política ${cfg.politica || '?'}): hay que rotarla — pasos en corridas-buzon.json → "rotar"`;
    res.aviso_vence = selloDiario(path.join(path.dirname(rutaRegistro), 'upload-runs-expiry.seal'), texto);
    if (res.aviso_vence === 'emitido') log(texto);
  }

  const maquina = nombreDeMaquina();
  res.maquina = maquina || null;
  if (!maquina || !FORMA_MAQUINA.test(maquina)) return fin(1, 'sin_maquina', 'no se pudo saber el nombre de esta máquina (hostname vacío o sin forma de nombre)');

  // 2 · lo que hay y lo que ya subió. 🔴 Los REGISTROS de frenos y escapes van PRIMERO en la cola (story 2.5):
  //    con un atraso de hilos y el presupuesto chico, al final de la cola no entrarían nunca. Los .gz antes y la
  //    cobertura al final: un corte a mitad no deja una cobertura nueva apuntando a registros viejos.
  const entradas = [];
  const noLeidos = [];
  let prep = { estado: 'sin_carpeta' };
  try { prep = prepararRegistros(); }
  catch (e) { noLeidos.push(`registros de frenos y escapes (${e.code || 'error'})`); }
  res.registros = prep.estado;
  // story 8.19 (AC 21): lo que va en place.json, también en la salida (--json)
  try { res.place = JSON.parse(fs.readFileSync(path.join(dirRegistros, 'place.json'), 'utf8')); } catch (_) { res.place = null; }
  if (prep.estado !== 'sin_carpeta') {
    let nombres = [];
    try { nombres = fs.readdirSync(dirRegistros).filter((x) => FORMA_REGISTRO.test(x)); }
    catch (e) { if (e.code !== 'ENOENT') noLeidos.push(`registros de frenos y escapes (${e.code || 'error'})`); }
    nombres.sort((a, b) => (a === 'cobertura.json') - (b === 'cobertura.json') || (a < b ? -1 : a > b ? 1 : 0));
    for (const f of nombres) entradas.push({ dir: dirRegistros, f, clave: `${maquina}/registros/${f}`, blob: `${maquina}/registros/${f}` });
  }
  try { for (const f of archivosDelRegistro(origen)) entradas.push({ dir: origen, f, clave: `${maquina}/${f}`, blob: `${maquina}/${f}` }); }
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
  for (const { dir, f, clave, blob } of entradas) {
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
    pendientes.push({ f, dir, clave, blob, mtimeMs: st.mtimeMs, size: cuerpo.length, sha256 });
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
  // 🔴 La cobertura de registros sube sólo si en ESTA pasada no falló ningún registro: si no, quedaría en el buzón
  //    una cobertura nueva declarando «medido» un registro que sigue siendo el viejo.
  const esRegistro = (p) => p.blob.includes('/registros/') && p.f !== 'cobertura.json';
  // 🔴 Una falla ANTERIOR a la cola cuenta si es de un registro, reconocido por su NOMBRE exacto (story 2.9).
  //    Antes se reconocía por «.log.gz », que no ve `hallazgos.jsonl.gz`; y ampliarlo a «.jsonl.gz » a secas
  //    lo dispararía también por el hilo de una corrida (`*.hilo.jsonl.gz`).
  const esFallaDeRegistro = (x) => x.startsWith('registros de frenos y escapes') || REGISTROS.some((r) => x.startsWith(`${r}.gz `));
  let registroFallido = noLeidos.some(esFallaDeRegistro);
  for (let i = 0; i < pendientes.length; i++) {
    if (Date.now() - inicio > tope) { res.sin_tiempo = pendientes.length - i; break; }
    const p = pendientes[i];
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
    const url = `${base}/${encodeURIComponent(cfg.contenedor)}/${p.blob.split('/').map(encodeURIComponent).join('/')}?${cfg.sas}`;
    const r = await ponerBlob(url, cuerpo, md5, Math.max(30000, Math.min(120000, cuerpo.length / 50)));
    if (r.error) {
      const c = r.error.code || r.error.message;
      return fin(1, 'sin_red', `sin red o sin respuesta del buzón (${c}) al subir ${p.f}: no se marcó nada más; sube en el próximo arranque${res.subidos ? ` — los ${res.subidos} archivo(s) confirmados antes del corte sí quedaron anotados` : ''}`);
    }
    if (r.status === 403 || r.status === 404) {
      return fin(1, 'llave_invalida', `el buzón rechazó la llave (${r.status}${r.codigo ? ` ${r.codigo}` : ''}): vencida o revocada, o inválida — hay que rotarla (corridas-buzon.json → "rotar", vence ${cfg.vence}). No se marcó nada más${res.subidos ? ` — los ${res.subidos} archivo(s) que el servicio confirmó antes sí quedaron anotados` : ''}`);
    }
    if (r.status >= 500) {
      return fin(1, 'servicio_fallo', `el servicio del buzón falló (${r.status}${r.codigo ? ` ${r.codigo}` : ''}) al subir ${p.f}: no se marcó nada más; se reintenta en el próximo arranque${res.subidos ? ` — los ${res.subidos} archivo(s) confirmados antes sí quedaron anotados` : ''}`);
    }
    if (r.status !== 201) { noSubidos.push(`${p.f} (${r.status}${r.codigo ? ` ${r.codigo}` : ''})`); if (esRegistro(p)) registroFallido = true; continue; }
    // 🔴 recién con el 201 se anota — y se persiste ya, archivo por archivo
    registro.archivos[p.clave] = { size: cuerpo.length, mtimeMs: Math.min(stAntes.mtimeMs, p.mtimeMs), sha256, subido: new Date().toISOString() };
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

module.exports = { placeFactsForMailbox, subir, nombreDeMaquina, normalizarNombreDeMaquina, leerConfig, integracionBuzon, negativaDeLaLlave, rutaConfig, urlBase, FORMA_MAQUINA, FORMA_ARCHIVO, FORMA_REGISTRO, REGISTROS, prepararRegistros, usosParaElBuzon, X_MS_VERSION };

if (require.main === module) {
  const args = process.argv.slice(2);
  const valor = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const json = args.includes('--json');
  const budget = valor('--budget-ms');
  const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
  subir({
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
  });
}
