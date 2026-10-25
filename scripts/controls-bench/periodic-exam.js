#!/usr/bin/env node
'use strict';
/**
 * periodic-exam.js — el examen de los 28 revisores corre solo, en la máquina designada, y
 * cuando NO corre eso se nota.
 *
 * ── POR QUÉ ES UNA PIEZA PROPIA (y no "una tarea programada más") ───────────────────────────────
 * Un lanzador metido en el instalador de hooks (`install-tycon-hooks.sh`) tiene tres defectos:
 *
 *   1. Vive bajo varias condiciones anidadas —`TYCON_BENCH_DAILY`, el sello DIARIO del banco determinista, y
 *      `TYCON_CODEX=1`—. En una máquina donde la última no está puesta no corre nunca, y el sello se atrasa respecto
 *      del calendario.
 *   2. **Marca la semana como hecha ANTES de correr.** Una corrida cancelada tras 5h30 se come igual el turno de la
 *      semana: el sello dice "corrido" y no queda ni una medición.
 *   3. Está enterrado en un script de instalación, lanzado con `nohup` y sin registro: nadie puede saber si terminó,
 *      ni volver a correrlo sin editar el instalador.
 *
 * Una tarea programada NUEVA al lado dejaría dos programadores para lo mismo, gastando la cuota dos veces y
 * escribiendo los dos en el mismo archivo. Por eso esta pieza es el único lanzador, resuelve los tres defectos, y el
 * instalador la invoca.
 *
 * ── LAS TRES DECISIONES QUE SOSTIENEN TODO ──────────────────────────────────────────────────────
 * · **El sello se escribe al TERMINAR, y sólo si la corrida fue completa.** Nunca al empezar.
 * · **Hay dos archivos de resultado, no uno.** El que viaja por git sólo se pisa con una corrida
 *   completa; el intento fallido va a un archivo local con su motivo. Si fueran uno, una corrida
 *   abortada borraría la última medición buena Y SU FECHA — y esa fecha es lo único que sostiene
 *   la denuncia de "el examen no está corriendo".
 * · **Sale 0 cuando midió (aunque el examen encuentre rojos); ≠ 0 sólo cuando NO PUDO medir.** Un
 *   problema hallado no es un job roto; no haber podido mirar sí. (Misma regla que el vigilante.)
 *
 * ── USO ─────────────────────────────────────────────────────────────────────────────────────────
 *   node periodic-exam.js              # decide solo si le toca; lo lanza el instalador/launchd
 *   node periodic-exam.js --dry-run    # dice qué haría y por qué, sin gastar nada
 *   node periodic-exam.js --force      # corrida manual: saltea máquina designada y período
 *   node periodic-exam.js --help
 *
 * 🔴 `--help` y `--dry-run` salen ANTES de cualquier proceso hijo, a propósito: `advisor-runner.js` no tiene handler
 * de flags desconocidos y `advisor-runner.js --help` arranca el banco COMPLETO. Una pieza que envuelve a otra no puede
 * heredar esa forma.
 *
 * Después del examen, el mismo disparador lanza la revisión de la semana (`revisionSemanal`), que decide sola
 * si le toca y tiene su apagado propio (TYCON_NO_WEEKLY_REVIEW=1); su resultado no cambia el código de salida del examen.
 *
 * Apagado: TYCON_NO_NIGHTLY_EXAM=1
 * Inyección para pruebas: TYCON_EXAM_CONFIG · TYCON_EXAM_RUNNER · TYCON_EXAM_REPO ·
 *                         TYCON_EXAM_MACHINE · TYCON_EXAM_PROBE (ruta a un comando, u `off`)
 *                         TYCON_EXAM_PROBE_CLAUDE · TYCON_EXAM_PROBE_CODEX (una por herramienta)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
// La carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: los
// laboratorios copian carpetas sueltas de scripts/ sin scripts/setup/; ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const { spawn, spawnSync, execFileSync } = require('child_process');
const { rutaDeHerramienta, seAlcanza, asegurarPathDeHerramientas, anotarCarpetas, revalidarHerramientas } = require('./tools-path.js');
// El PATH con el que se lanzó el proceso, antes de que `main` le anteponga las carpetas anotadas: anotar desde el PATH
// ya tocado encontraría primero la carpeta vieja, y una que sigue existiendo no se renovaría nunca.
const PATH_DE_QUIEN_LANZA = process.env.PATH;

/**
 * El node que nombra el disparador: el propio del arnés por su enlace `current`
 * (`<casa>/node/current/bin/node`, la casa es TYCON_HOME o ~/.tycon), nunca la carpeta numerada ni `process.execPath`
 * —que por el enlace da la carpeta numerada, y ésa se borra al cambiar de versión—. Sin él (o apagado), el de este proceso.
 * La regla de la ruta es la de scripts/setup/harness/tycon-home.js#harnessNode; si ese archivo no está (los laboratorios
 * copian carpetas sueltas), va ESCRITA acá (copia declarada en scripts/tests/fixtures/harness-node-copies.json).
 */
function nodeDelDisparador(env = process.env) {
  if (env.TYCON_HARNESS_NODE === '0') return process.execPath;
  let bin;
  const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js');
  try { bin = require(lib).harnessNode({ env, platform: 'darwin' }).bin; } catch (_) {
    bin = path.join(env.TYCON_HOME && path.isAbsolute(env.TYCON_HOME) ? env.TYCON_HOME : path.join(os.homedir(), '.tycon'), 'node', 'current', 'bin', 'node');
  }
  try { fs.accessSync(bin, fs.constants.X_OK); return bin; } catch (_) { return process.execPath; }
}
// Las variables renombradas a inglés: el nombre viejo sigue valiendo hasta el retiro — un interruptor de
// apagado viejo en el .zshrc sigue apagando. Sin la biblioteca al lado (el banco copia este archivo a un arnés de
// mentira sin scripts/lib): paso directo con el nombre nuevo.
// Lo mismo con el estado de la máquina renombrado (el sello y el log de launchd): se lee el nombre nuevo
// y, si falta, el viejo; antes de escribir, el viejo pasa al nuevo con su historia. Sin la biblioteca: paso directo.
const DONDE = 'scripts/controls-bench/periodic-exam.js';
const { leerVariable, leerEstado, prepararEstado, diasDeAntes, anotarDiaDeAntes } = (() => {
  try {
    const { readEnv, resolveFile, prepareStateWrite, loadMap, usableEntries, recordUse } = require(path.join(__dirname, '..', 'lib', 'legacy-names.js'));
    return {
      // Los días de `scheduled_days` con su nombre anterior (en castellano): los dice el mapa de renombres
      // (entradas `value` de este guion). Sin mapa —la copia pública, o la copia del banco sin scripts/lib— no hay ninguno.
      diasDeAntes: () => {
        const out = {};
        try { for (const e of usableEntries(loadMap())) if (e.kind === 'value' && e.where === DONDE && e.option === 'scheduled_days') out[e.old] = e.new; } catch (_) { /* paso directo */ }
        return out;
      },
      anotarDiaDeAntes: (viejo, nuevo) => { try { recordUse({ kind: 'value', old: viejo, new: nuevo, script: DONDE }); } catch (_) { /* anotar nunca rompe */ } },
      leerVariable: (n) => readEnv(n, { where: DONDE }),
      // leer nunca rompe: con el mapa ilegible o un sello que no se deja mirar, el nombre nuevo — dicho, no callado
      leerEstado: (p) => {
        try { return resolveFile(p, { where: DONDE }); } catch (e) {
          process.stderr.write(`⚠️  examen-periodico: ${(e && e.message) || e} — se lee ${p}\n`);
          return p;
        }
      },
      prepararEstado: (p) => prepareStateWrite(p, { where: DONDE }),
    };
  } catch (_) { return { leerVariable: (n) => process.env[n], leerEstado: (p) => p, prepararEstado: (p) => p, diasDeAntes: () => ({}), anotarDiaDeAntes: () => {} }; }
})();

// ── El ÚNICO umbral de vejez del examen ────────────────────────────────────────────────────────
// El período son 3-4 días; 8 deja lugar a UNA corrida perdida sin gritar. Lo consume también
// `bench-notice.js`, que lo importa de acá — una sola definición, un solo lugar donde cambiarlo.
// 🔴 NO es el `STALE_MS` de `lib/harness-parity.js` (3 días): ése contesta "¿cuán vieja es esta
// foto?" y éste contesta "¿el examen está corriendo?". Son dos preguntas distintas con dueños
// distintos; unificarlas las rompe a las dos.
const VEJEZ_MS = 8 * 24 * 60 * 60 * 1000;

/** Relativa a la raíz del repo. FUERA de `.bench/`, que git ignora. */
const RUTA_REPORTE_QUE_VIAJA = 'scripts/controls-bench/ultimo-examen.json';

// 🔴 48 h, no 12: el examen completo son ~5h30 y con la máquina cargada puede ser bastante más.
// Un candado que caduca ANTES de que termine la corrida que protege deja arrancar una segunda
// encima de la primera — o sea, gasta la cuota del dev dos veces haciendo justo lo contrario de
// lo que existe para impedir. El plazo igual tiene que existir: los PIDs se reciclan, y sin él
// un candado huérfano cuyo número volvió a estar en uso trabaría el examen para siempre.
const CANDADO_VENCE_MS = 48 * 60 * 60 * 1000;

// 🔴 Un candado que NO SE PUEDE LEER y se acaba de escribir está OCUPADO, no libre.
//
// Sin este umbral, un candado publicado en dos actos (crear el archivo con `wx`, vacío, y escribir el pid DESPUÉS)
// deja una ventana: un lector que cae en el medio lee un archivo vacío, `JSON.parse` falla, `estadoDelCandado`
// contesta "libre", borra el candado del otro y lo toma: las dos corridas arrancan, que es exactamente lo que el
// candado existe para impedir.
//
// La publicación no es en dos pasos (ver `tomarCandado`), así que un candado publicado nunca
// está vacío. Este umbral es la SEGUNDA barrera, y hace falta por dos razones concretas: una máquina
// del equipo con el arnés atrasado puede publicar el candado en dos pasos (y el candado se comparte
// por el filesystem, no por la versión del código), y un archivo puede quedar a medias por otras
// causas (disco lleno a mitad de una escritura). Ante "no sé", un candado no puede contestar "libre":
// equivocarse hacia libre gasta la cuota del dev dos veces; hacia ocupado, pierde un turno que
// vuelve en 3 días.
//
// 10 s: la ventana real de escritura son microsegundos, así que sobra de lejos; y es cortísimo frente
// a las 48 h del vencimiento, así que un candado genuinamente corrupto no se lleva un turno entero.
const CANDADO_EN_ESCRITURA_MS = 10 * 1000;

const REINTENTOS_DE_PUSH = 3;

// Los días de `scheduled_days` se escriben en inglés. Un día que la tabla no conoce se denuncia: descartarlo callado
// dejaría el examen programado un día menos.
const DIAS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const DIAS_POR_DEFECTO = ['tuesday', 'friday'];

/**
 * Los días programados como números de launchd (0 = domingo) y los que no se reconocen, tal como estaban escritos.
 * Sin días, los por defecto. Mayúsculas, espacios y acentos no importan. Un nombre anterior (del mapa) vale por el actual.
 */
function diasProgramados(scheduled_days) {
  // un valor que no es lista (un texto suelto, un objeto) no cae callado a los días por defecto: es desconocido (con
  // `"monday"` el disparador quedaría en martes y viernes sin decir nada)
  if (scheduled_days !== undefined && scheduled_days !== null && !Array.isArray(scheduled_days)) {
    return { numeros: [], desconocidos: [`${JSON.stringify(scheduled_days)} (scheduled_days no es una lista)`] };
  }
  const lista = Array.isArray(scheduled_days) && scheduled_days.length ? scheduled_days : DIAS_POR_DEFECTO;
  const deAntes = diasDeAntes();
  const numeros = [];
  const desconocidos = [];
  for (const d of lista) {
    const escrito = String(d).trim();
    const llano = escrito.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    let dia = llano;
    if (!Object.prototype.hasOwnProperty.call(DIAS, dia) && Object.prototype.hasOwnProperty.call(deAntes, llano)) {
      dia = deAntes[llano];
      anotarDiaDeAntes(llano, dia);
    }
    if (Object.prototype.hasOwnProperty.call(DIAS, dia)) numeros.push(DIAS[dia]);
    else desconocidos.push(escrito);
  }
  return { numeros, desconocidos };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Funciones puras — lo que decide, separado de lo que ejecuta
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * 🔴 DE QUÉ REPO SE LEE LA MÁQUINA DESIGNADA, Y ADÓNDE VA EL RESULTADO.
 *
 * La copia pública trae `exam-config.json` con la máquina designada vacía: afuera nadie corre este examen. Una máquina
 * del equipo que usa la versión bajada (el árbol público, sin git) leería esa copia vacía, retiraría el disparador y
 * el examen dejaría de correr, con el arranque marcándolo en rojo en cada sesión. La máquina designada y el resultado
 * que viaja son del repo de mantenimiento, el clon que la máquina declara en `paths.maintainers` (el mismo del que
 * los avisos leen la noche: scripts/lib/night-data.js). Por eso, en orden:
 *   · TYCON_EXAM_REPO / TYCON_EXAM_CONFIG, si vienen (cada una por su lado);
 *   · si no, la configuración de este árbol cuando designa una máquina (un clon completo del arnés): este árbol;
 *   · si no, y la máquina usa la versión bajada con su clon de mantenimiento sano: la configuración y el resultado de
 *     ese clon. El código sigue siendo el de este árbol, el instalado;
 *   · si no, este árbol (la copia pública de alguien de afuera: nadie designado, nadie corre).
 * Lo usan las tres preguntas —el instalador del disparador, la corrida y el aviso de arranque (bench-notice.js)—, para
 * que las tres miren el MISMO lugar.
 */
function lugarDelExamen() {
  const propio = path.resolve(__dirname, '..', '..');
  const configPropia = path.join(__dirname, 'exam-config.json');
  const repoVar = leerVariable('TYCON_EXAM_REPO');
  const configVar = leerVariable('TYCON_EXAM_CONFIG');
  if (repoVar || configVar) return { repo: repoVar || propio, config: configVar || configPropia, origen: 'variable' };
  const lugarPropio = { repo: propio, config: configPropia, origen: 'propio' };
  if (designaMaquina(leerJson(configPropia))) return lugarPropio;
  const lib = path.join(__dirname, '..', 'lib', 'night-data.js');
  if (!fs.existsSync(lib)) return lugarPropio;   // copiado solo (el banco lo hace): como siempre
  let r;
  try { r = require(lib).resolve(propio); } catch (e) {
    return Object.assign({}, lugarPropio, { problema: `no pude saber cuál es el clon de mantenimiento (${(e && e.message) || e})` });
  }
  if (r && r.source === 'maintainers' && r.dir) {
    return { repo: r.dir, config: path.join(r.dir, 'scripts', 'controls-bench', 'exam-config.json'), origen: 'mantenimiento' };
  }
  return r && r.problem ? Object.assign({}, lugarPropio, { problema: r.problem }) : lugarPropio;
}

function leerJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function designaMaquina(cfg) {
  return Boolean(cfg && typeof cfg === 'object' && !Array.isArray(cfg)
    && String(cfg.designated_machine == null ? '' : cfg.designated_machine).trim());
}

function leerConfig(ruta) {
  return leerJson(ruta || lugarDelExamen().config) || {};
}

/** Cómo se llama esta máquina, en todas las formas en que se la puede nombrar (minúsculas). */
function identidadesDeMaquina() {
  const forzada = leerVariable('TYCON_EXAM_MACHINE');
  if (forzada) return [forzada.toLowerCase().replace(/\.local$/, '')];
  const nombres = [];
  try { nombres.push(os.hostname()); } catch (_) { /* */ }
  for (const clave of ['ComputerName', 'LocalHostName']) {
    try { nombres.push(execFileSync('scutil', ['--get', clave], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); }
    catch (_) { /* no es macOS, o scutil no está */ }
  }
  return [...new Set(nombres.filter(Boolean).map((n) => n.toLowerCase().replace(/\.local$/, '')))];
}

/**
 * 🔴 Sin `designated_machine` en la config, NADIE corre. Fail-closed a propósito: una máquina de
 * más corriendo el examen gasta la cuota del dev dos veces, y el aviso de vejez ya denuncia el
 * caso contrario (que no corra ninguna).
 */
function esMaquinaDesignada(cfg, identidades) {
  // Se normalizan LOS DOS LADOS. `identidadesDeMaquina()` ya entrega minúsculas y sin `.local`,
  // pero normalizar sólo la config dejaría la comparación a merced de quién llame: un llamador que
  // pasara el nombre crudo del sistema ("Mi-Mac-mini.local") obtendría "no es la designada" y la
  // máquina no correría el examen — en silencio, que es el modo de falla que este archivo persigue.
  const normal = (s) => String(s || '').trim().toLowerCase().replace(/\.local$/, '');
  const designada = normal(cfg && cfg.designated_machine);
  if (!designada) return false;
  return (identidades || []).some((i) => normal(i) === designada);
}

/** ¿Pasaron los días desde la última corrida COMPLETA? Sin sello (o ilegible) → le toca. */
function periodoCumplido(selloIso, ahora, diasEntreCorridas) {
  if (!selloIso) return true;
  const t = Date.parse(String(selloIso).trim());
  if (isNaN(t)) return true;              // un sello ilegible no puede frenar el examen para siempre
  const dias = Number(diasEntreCorridas) > 0 ? Number(diasEntreCorridas) : 3;
  return (ahora.getTime() - t) >= dias * 24 * 60 * 60 * 1000;
}

/**
 * Toma el candado de forma ATÓMICA (`link` = falla si el nombre ya existe) — y el llamador lo hace
 * ANTES de la sonda de sesión, no después.
 *
 * 🔴 Chequear en `decidir()` y escribir varios pasos más abajo, con la sonda en el medio (hasta dos minutos), deja
 * una ventana: dos procesos leen "libre" y los dos arrancan el examen completo en paralelo, gastando la cuota del dev
 * dos veces — justo lo que el candado existe para impedir. Chequear y tomar tienen que ser el MISMO acto; si no,
 * entre uno y otro cabe otra corrida.
 *
 * 🔴 Y el acto también tiene que ser UNO desde afuera: `wx` decide bien quién gana, pero publica el candado VACÍO y le
 * escribe el pid después — ver el cuerpo de la función.
 */
/**
 * El dueño refresca la marca de su candado mientras la corrida vive. Sin esto, el plazo de 48 h
 * —que existe para que un PID reciclado no trabe el examen para siempre— se aplicaría también a un
 * dueño VIVO: una corrida más larga que el plazo se dejaría robar el candado y arrancaría una segunda
 * encima. El latido separa las dos preguntas: "¿sigue vivo?" la contesta el proceso; "¿esto quedó
 * abandonado?" la contesta el tiempo desde su último latido, no desde que empezó.
 */
function latirCandado(ruta, maquina) {
  const cada = Number(leerVariable('TYCON_EXAM_HEARTBEAT_MS') || 10 * 60 * 1000);
  let yaAvisado = false;
  const t = setInterval(() => {
    try {
      const d = JSON.parse(fs.readFileSync(ruta, 'utf8'));
      if (Number(d.pid) !== process.pid) return;            // nos lo robaron: no lo pisamos
      escribirJsonAtomico(ruta, Object.assign({}, d, { ts: new Date().toISOString() }));
    } catch (e) {
      // 🔴 El latido nunca puede tumbar la corrida, PERO tampoco puede morir mudo: si dejara de
      // latir en silencio, el candado se vencería solo a las 48 h y arrancaría una segunda corrida
      // encima — lo que existe para impedir— sin una sola pista de por qué. Se avisa UNA vez: son
      // ~33 latidos en una corrida completa y repetirlo sería ruido que se aprende a ignorar.
      if (!yaAvisado) { yaAvisado = true; console.error(`examen: el candado dejó de latir (${e && e.message}) — si esto persiste, el candado puede vencerse con la ejecución viva`); }
    }
  }, cada);
  if (typeof t.unref === 'function') t.unref();
  return t;
}

function tomarCandado(ruta, ahoraMs, maquina) {
  const cuerpo = JSON.stringify({ pid: process.pid, ts: new Date(ahoraMs).toISOString(), maquina }, null, 2) + '\n';
  // 🔴 SE PUBLICA UN CANDADO YA COMPLETO, no uno vacío que se llena después.
  //
  // `openSync(ruta, 'wx')` y un `writeFileSync` a continuación: el `wx` es atómico para decidir QUIÉN gana, pero deja
  // el candado publicado y VACÍO durante el intervalo entre los dos actos, y en ese intervalo un lector no lo puede
  // parsear, lo juzga libre, lo borra y lo toma. Arrancan las dos corridas (ver el comentario de
  // CANDADO_EN_ESCRITURA_MS).
  //
  // El cuerpo se escribe en un archivo aparte —con el pid en el nombre, así dos procesos no
  // se pisan— y se PUBLICA con `link`, que es UN solo acto: falla con EEXIST si el nombre ya existe
  // (el mismo desempate que daba `wx`) y, cuando existe, el contenido ya está entero adentro. No hay
  // instante en que el candado exista y no se pueda leer. `link` pide el mismo filesystem: el tmp va
  // en la misma carpeta que el candado, no en el temporal del sistema.
  //
  // Si el proceso muere entre escribir y publicar queda un `.tmp` huérfano en `.bench/` (carpeta que
  // git ignora): basura inofensiva, porque no es el nombre que nadie consulta.
  const tmp = `${ruta}.${process.pid}.tmp`;
  const crear = () => {
    fs.writeFileSync(tmp, cuerpo);
    try { fs.linkSync(tmp, ruta); }              // atómico: EEXIST si otro llegó primero
    finally { try { fs.unlinkSync(tmp); } catch (_) { /* ya no está */ } }
  };
  try { crear(); return { ok: true }; }
  catch (e) { if (e.code !== 'EEXIST') return { ok: false, error: true, motivo: `no se pudo tomar el candado: ${e.message}` }; }

  // Ya existe: sólo se roba si su dueño murió, o si es tan viejo que no puede ser una corrida viva.
  const est = estadoDelCandado(ruta, ahoraMs);
  if (!est.libre) return { ok: false, motivo: est.motivo, pid: est.pid, desde: est.desde };
  // Lo juzgamos libre: si aun así no se puede sacar del camino, el problema es de la máquina
  // (permisos, una carpeta donde va un archivo, disco), no otra corrida. Y eso se grita.
  let borrado = true;
  try { fs.unlinkSync(ruta); }
  catch (e) { borrado = !fs.existsSync(ruta); if (!borrado) return { ok: false, error: true, motivo: `no se pudo liberar un candado abandonado: ${e.message}` }; }
  // Un solo reintento: si en este instante otro lo tomó, ganó él y esta corrida no arranca.
  try { crear(); return { ok: true, robado: est.motivo }; }
  catch (e) {
    if (e.code === 'EEXIST') return { ok: false, motivo: 'otra-corrida-en-curso' };   // ganó otro: normal
    return { ok: false, error: true, motivo: `no se pudo tomar el candado: ${e.message}` };
  }
}

/**
 * Libera el candado SÓLO si sigue siendo el nuestro. Si en el medio nos lo robaron (una corrida
 * que se pasó del plazo y otra tomó su lugar), borrarlo a ciegas dejaría la puerta abierta para una
 * TERCERA corrida simultánea — el candado protegiendo cada vez menos justo cuando ya falló una vez.
 */
function liberarCandado(ruta, pid) {
  try {
    const d = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    if (Number(d && d.pid) !== Number(pid)) return false;   // ya no es nuestro: no se toca
  } catch (_) {
    // 🔴 ILEGIBLE tampoco es "mío". Borrarlo igual reabriría por el otro lado la carrera que `estadoDelCandado`
    // cierra: un candado que otra corrida está publicando —o que quedó a medias— se sacaría del camino como si fuera
    // propio, dejando la puerta abierta a una TERCERA. No queda trabado: pasados los 10 s de la ventana de escritura,
    // `estadoDelCandado` lo declara libre y la corrida siguiente lo roba.
    return false;
  }
  try { fs.unlinkSync(ruta); return true; } catch (_) { return false; }
}

/**
 * ¿Hay otra corrida viva? Un candado sin proceso, ilegible VIEJO o vencido NO bloquea. Uno ilegible
 * RECIÉN escrito sí: ahí "no sé" se contesta ocupado (ver `CANDADO_EN_ESCRITURA_MS`).
 */
function estadoDelCandado(ruta, ahoraMs) {
  let d;
  try { d = JSON.parse(fs.readFileSync(ruta, 'utf8')); }
  catch (_) {
    let st = null;
    try { st = fs.statSync(ruta); } catch (_) { return { libre: true }; }   // no está: no hay candado
    // 🔴 Sólo un ARCHIVO puede ser un candado a medio publicar. Si en el lugar del candado hay una
    // carpeta —u otra cosa que no se puede leer—, eso NO es otra corrida: es un problema de la
    // máquina (permisos, un mkdir de más), y el camino de abajo tiene que poder intentar sacarlo del
    // medio y GRITAR si no puede. Tratarlo como "ocupado" lo convertiría en una salida limpia y el
    // examen dejaría de correr para siempre sin un rastro — el modo de falla que esta pieza cierra.
    if (st.isFile() && (ahoraMs - st.mtimeMs) < CANDADO_EN_ESCRITURA_MS)
      return { libre: false, motivo: 'candado-en-escritura' };
    return { libre: true, motivo: 'candado-ilegible' };
  }
  const pid = Number(d && d.pid);
  // Un pid que no es un entero positivo no es un proceso: no puede sostener un candado.
  if (!Number.isInteger(pid) || pid <= 0) return { libre: true, motivo: 'candado-ilegible' };
  // El proceso PRIMERO: mientras la corrida esté viva el candado vale, dure lo que dure.
  // 🔴 `EPERM` es "existe pero es de otro usuario" — o sea, VIVO. Leerlo como muerto roba el
  // candado de un dueño que sigue corriendo. Sólo `ESRCH` (no existe tal proceso) es muerto.
  try { process.kill(pid, 0); }
  catch (e) {
    if (e.code === 'ESRCH') return { libre: true, motivo: 'candado-huerfano' };
    // EPERM u otro: no puedo afirmar que esté muerto, así que respeto el candado.
  }
  const t = Date.parse((d && d.ts) || '');
  if (isNaN(t) || (ahoraMs - t) > CANDADO_VENCE_MS) return { libre: true, motivo: 'candado-vencido' };
  return { libre: false, motivo: 'otra-corrida-en-curso', pid, desde: d.ts };
}

/** El disparador se GENERA desde la config: cambiar la frecuencia no toca una línea de código. */
function plistDeseado({ label, nodeBin, script, scheduled_days, hour }) {
  const [h, m] = String(hour || '02:00').split(':').map((x) => parseInt(x, 10) || 0);
  // los días que no se reconocen no llegan acá: `instalarTarea` se niega antes de escribir el disparador
  const dias = diasProgramados(scheduled_days).numeros;
  const entradas = dias.map((wd) =>
    `    <dict><key>Weekday</key><integer>${wd}</integer><key>Hour</key><integer>${h}</integer><key>Minute</key><integer>${m}</integer></dict>`
  ).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `  <key>Label</key><string>${label}</string>`,
    `  <key>ProgramArguments</key><array><string>${nodeBin}</string><string>${script}</string></array>`,
    '  <key>StartCalendarInterval</key><array>',
    entradas,
    '  </array>',
    // Sin esto launchd DESCARTA la salida, y el motivo de una corrida que no pudo medir no llega a
    // ninguna parte: quedaría sólo la denuncia a los 8 días, sin el porqué.
    `  <key>StandardOutPath</key><string>${rutaLog()}</string>`,
    `  <key>StandardErrorPath</key><string>${rutaLog()}</string>`,
    '  <key>RunAtLoad</key><false/>',
    '</dict></plist>',
  ].join('\n');
}

/**
 * La decisión, en orden de costo creciente. Devuelve el primer motivo por el que NO corre.
 * Todos los "no" son exit 0: no le toca no es un error.
 */
function decidir(ctx, opciones = {}) {
  if (leerVariable('TYCON_NO_NIGHTLY_EXAM') === '1')
    return { correr: false, motivo: 'apagado', detalle: 'TYCON_NO_NIGHTLY_EXAM=1', exit: 0 };
  if (!opciones.forzar && !esMaquinaDesignada(ctx.cfg, ctx.identidades))
    return { correr: false, motivo: 'no-designada', exit: 0,
      detalle: `esta máquina es ${ctx.identidades.join(' / ') || '(sin nombre)'}; la designada es ${ctx.cfg.designated_machine || '(ninguna)'}` };
  if (!opciones.forzar && !periodoCumplido(ctx.sello, ctx.ahora, ctx.cfg.days_between_runs))
    return { correr: false, motivo: 'periodo-no-cumplido', exit: 0,
      detalle: `la última ejecución completa fue el ${String(ctx.sello).slice(0, 10)}; el período es de ${ctx.cfg.days_between_runs || 3} días` };
  const candado = estadoDelCandado(ctx.rutaCandado, ctx.ahora.getTime());
  if (!candado.libre)
    return { correr: false, motivo: candado.motivo, exit: 0, detalle: `pid ${candado.pid}, desde ${candado.desde}` };
  return { correr: true, motivo: 'le-toca', exit: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Efectos
// ─────────────────────────────────────────────────────────────────────────────────────────────

function rutaSello() {
  return path.join(stateDirOf(os.homedir()), 'periodic-exam-last-run');
}

/** Donde launchd deja la salida del examen. La abre launchd, no este proceso: ver `instalarTarea`. */
function rutaLog() {
  return path.join(stateDirOf(os.homedir()), 'periodic-exam.log');
}

function leerSello() {
  try { return fs.readFileSync(leerEstado(rutaSello()), 'utf8').trim(); } catch (_) { return null; }
}

function escribirJsonAtomico(destino, obj) {
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  const tmp = `${destino}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, destino);   // bench-notice puede estar leyéndolo justo ahora
}

/**
 * Las últimas líneas de error de un hijo, para el motivo del intento: en una línea, a lo sumo 400 caracteres, y cada
 * una por el limpiador del arnés (usuario y clave de una URL, `token=…`, `Bearer …`, tiras largas) y sin caracteres de
 * control. Encima, lo que el limpiador no ve en un error: desde una palabra sensible (token, secret, key, password,
 * private, credential, authorization, cookie, pat) se tapa el resto de la línea, con o sin `:`/`=` y aunque el valor
 * traiga espacios; `-u usuario:clave`; prefijos de llaves conocidas cortas; y una llave PEM entera, en varias líneas o
 * en una sola con `\n` escritos, más las líneas sueltas de su cuerpo si la cola la corta por el medio. Los renglones
 * de la pila (`at …`) y el pie de Node no entran: con ellos los 400 caracteres se gastan y la causa queda afuera.
 * El motivo lo muestra el arranque y puede viajar: sin el limpiador a mano no sale ninguna línea, y se dice.
 */
const PALABRA_SENSIBLE = /((?:token|secret|key|passw(?:or)?d|passphrase|pwd|private|credential|authoriz|cookie|\bpat\b)[\w-]*)["']?\s*[:=]?\s*\S[\s\S]*$/i;
const USUARIO_CLAVE = /((?:^|\s)(?:-u|--user|--proxy-user)(?:\s+|=))("[^"]*"|'[^']*'|\S+)/g;
const LLAVE_CONOCIDA = /\b(?:[sr]k[-_](?:live_|test_)?[\w-]{8,}|(?:AKIA|ASIA)[0-9A-Z]{12,}|AIza[\w-]{20,}|gh[pousr]_\w{16,}|glpat-[\w-]{12,}|npm_\w{16,}|xox[abprs]-[\w-]{10,})/g;
// todo corte de renglón, no sólo \n: \r suelto (una barra de progreso), \v, \f, U+0085, U+2028 y U+2029. Cualquiera
// que quedara adentro de una línea dejaría el resto fuera del alcance de la palabra sensible, o la partiría en el
// aviso. Armado por código, como el CONTROL de maintainers-sync.js
const FIN_DE_LINEA = new RegExp(`\\r\\n|[\\r\\n\\v\\f${String.fromCharCode(0x85, 0x2028, 0x2029)}]`);
const BLOQUE_PEM = /-----BEGIN[^-]*-----[\s\S]*?(?:-----END[^-]*-----|$)|-----END[^-]*-----/g;
// una línea sin espacios hecha sólo de base64, con algún dígito o `+`/`/`: el cuerpo de una llave cortada
const LINEA_BASE64 = /^(?=\S*[\d+/])[A-Za-z0-9+/]{8,}={0,2}$/;
const LINEA_DE_PILA = /^(?:at\s|Node\.js v\d|\^+$)/;
function colaDeError(texto, cortada = false) {
  let limpiar;
  let sinControl;
  try { ({ redact: limpiar, clean: sinControl } = require(path.join(__dirname, '..', 'lib', 'maintainers-sync.js'))); } catch (_) { /* abajo */ }
  if (typeof limpiar !== 'function' || typeof sinControl !== 'function') return '(error omitido: no cargó el limpiador de secretos)';
  const crudas = String(texto || '').replace(BLOQUE_PEM, '[llave omitida]').split(FIN_DE_LINEA);
  if (cortada) crudas.shift();   // la cola se corta por caracteres: su primera línea viene partida y el limpiador no la reconoce
  const tapar = (l) => l.replace(USUARIO_CLAVE, '$1***').replace(LLAVE_CONOCIDA, '***')
    .replace(PALABRA_SENSIBLE, (m, palabra) => `${palabra} ***`);
  const lineas = crudas.filter((l) => !LINEA_BASE64.test(l.trim()) && !LINEA_DE_PILA.test(l.trim()))
    .map((l) => sinControl(tapar(limpiar(l)), 200)).filter(Boolean);   // la URL con clave, antes: la palabra sensible tapa desde ahí
  let out = '';
  for (let i = lineas.length - 1; i >= 0; i--) {
    const con = out ? `${lineas[i]} · ${out}` : lineas[i];
    if (con.length > 400) break;
    out = con;
  }
  return out;
}

/** El registro del intento: LOCAL, y se escribe pase lo que pase. Nunca pisa el que viaja. */
function registrarIntento(benchDir, datos) {
  try { escribirJsonAtomico(path.join(benchDir, 'examen-intento.json'),
    Object.assign({ kind: 'examen-periodico-intento', ts: new Date().toISOString() }, datos)); }
  catch (e) { console.error(`examen: no se pudo registrar el intento — ${e.message}`); }
}

/**
 * ¿Hay sesión con qué correr el examen? Se prueba ANTES de gastar las ~580 consultas.
 * Sin esto, una sesión vencida produce 5 horas de errores y un reporte que no mide nada.
 */
function sondaDeSesion() {
  const inyectada = leerVariable('TYCON_EXAM_PROBE');
  if (inyectada === 'off') return { ok: true };
  if (inyectada) {
    const r = spawnSync(inyectada, [], { encoding: 'utf8', timeout: 60000 });
    return r.status === 0 ? { ok: true }
      : { ok: false, motivo: `la sonda de sesión falló (${(r.stderr || r.stdout || '').trim().slice(0, 200)})` };
  }

  // 🔴 LAS DOS herramientas, y a cada una con una CONSULTA DE VERDAD — no con `--version`.
  //
  // Codex sin credenciales contesta `--version` sin chistar y devuelve `401 Missing bearer` en cuanto se le pide
  // algo. Una sonda que prueba Claude con una consulta real y a Codex sólo la versión da el visto bueno y el examen
  // arranca igual: la mitad de sus ~580 invocaciones serían error de corrida, 5h30 de reloj, y un sello que se come el
  // turno de los 3 días siguientes. Preguntar "¿estás instalado?" cuando lo que hace falta saber es "¿podés trabajar?"
  // es la forma más barata de que un control diga que sí cuando la respuesta es no.
  //
  // `TYCON_EVAL_SANDBOX=1` NO es opcional: sin él los hooks de arranque le inyectan a la sesión de sonda el aviso
  // "controls-bench EN ROJO — Correr: node runner.js", el agente va y lo corre, y la sonda muere por permisos o por
  // tiempo (lo caza `bench-silence.test.sh`).
  // Antes de la consulta: ¿las herramientas siguen donde quedaron anotadas? Bajo launchd el PATH es el mínimo y no
  // sirve para anotar; si una se mudó, el que sabe adónde es el shell de inicio del usuario (tools-path.js). Sin
  // encontrarla en ningún lado no se lanza nada.
  const revision = revalidarHerramientas(['claude', 'codex'].filter((bin) => !leerVariable(`TYCON_EXAM_PROBE_${bin.toUpperCase()}`)));
  if (!revision.ok) {
    const donde = revision.causa ? `no está en la carpeta anotada, y ${revision.causa}` : 'no está en la carpeta anotada ni en el PATH del usuario';
    return { ok: false, motivo: revision.faltan.map((bin) => `${bin} ${donde}`).join(' · ') };
  }
  asegurarPathDeHerramientas();   // con la anotación nueva, si la hubo: codex busca su node en el PATH
  const ENTORNO = Object.assign({}, process.env, { TYCON_EVAL_SANDBOX: '1' });
  const HERRAMIENTAS = [
    { nombre: 'Claude Code', env: 'TYCON_EXAM_PROBE_CLAUDE', bin: 'claude', args: ['-p', 'ok'] },
    // `--skip-git-repo-check`: el examen lo usa igual, y sin él codex se niega fuera de un repo.
    { nombre: 'Codex', env: 'TYCON_EXAM_PROBE_CODEX', bin: 'codex', args: ['exec', '--skip-git-repo-check', 'ok'] },
  ];
  for (const h of HERRAMIENTAS) {
    const inyectadaPropia = leerVariable(h.env);
    // 🔴 RUTA ABSOLUTA, no nombre pelado. Bajo launchd el PATH es el mínimo de macOS
    // (`/usr/bin:/bin:/usr/sbin:/sbin`) y `claude` no está ahí: con el nombre pelado la sonda muere con
    // `spawnSync claude ENOENT`. La ruta se deduce del node que está corriendo (ver `tools-path.js`) y si la
    // herramienta no está a su lado, se devuelve el nombre pelado y lo resuelve el PATH.
    const ruta = rutaDeHerramienta(h.bin);
    const r = inyectadaPropia
      ? spawnSync(inyectadaPropia, [], { encoding: 'utf8', timeout: 180000, env: ENTORNO })
      : spawnSync(ruta, h.args, { encoding: 'utf8', timeout: 180000, env: ENTORNO });
    if (r.error)
      return { ok: false, motivo: `el binario de ${h.nombre} ('${ruta}') no está o no se pudo lanzar (${r.error.message})` };
    if (r.status !== 0) {
      const detalle = `${(r.stderr || '')}\n${(r.stdout || '')}`.trim().split('\n').filter(Boolean).slice(-2).join(' · ').slice(0, 240);
      return { ok: false, motivo: `la sesión de ${h.nombre} no puede trabajar — hay que autenticarse de nuevo (${detalle})` };
    }
  }
  return { ok: true };
}

/**
 * Trae lo último antes de medir. Devuelve `{ok, motivo}` — nunca tira: no poder actualizar no puede
 * impedir la corrida.
 *
 * 🔴 `timeout` + `GIT_TERMINAL_PROMPT=0`: bajo launchd no hay nadie que conteste un pedido de
 * contraseña, y un git que pregunta se queda esperando PARA SIEMPRE con el label de launchd
 * ocupado — el examen dejaría de correr hasta que alguien lo note por la denuncia de los 8 días.
 * Colgar es peor que fallar.
 *
 * 🔴 `--ff-only` a propósito: si la máquina tiene un commit local sin pushear (por ejemplo, un
 * push del examen que falló), el pull REHÚSA en vez de fabricar un merge a las 2 de la mañana.
 * Se corre con lo que hay, y se deja dicho.
 */
/**
 * 🔴 EL MOTIVO SE QUEDA CON LA PRIMERA LÍNEA, NO CON LA ÚLTIMA.
 *
 * Este texto va a parar a `codigo_desactualizado` del reporte que viaja: es lo ÚNICO que va a leer el que se
 * pregunte por qué la medición se hizo con código viejo. Git escribe sus errores de arriba hacia abajo: lo accionable
 * va primero y abajo queda la coletilla. Con un remote inexistente, la última línea es `pull: and the repository
 * exists.` — el final de una frase partida, que no dice ni qué falló ni dónde. Dejar constancia de algo que no se
 * puede accionar es casi peor que no dejarla: hace perder el tiempo del que la lee y encima parece que el control
 * funcionó.
 *
 * No hay lista de mensajes de git mapeados a categorías propias, a propósito: esa lista envejece
 * mal —git cambia sus textos y traduce— y el día que un mensaje nuevo no matchee, el motivo sería
 * "error desconocido", que es peor que el crudo. Se elige BIEN el texto crudo y se lo deja entero.
 *
 * Recorta a 200 y lo DICE con el puntito: un texto cortado sin marca se lee como el mensaje
 * completo y manda a buscar una causa que no está ahí.
 */
function motivoDeGit(stderr, stdout, status) {
  const linea = `${stderr || ''}\n${stdout || ''}`.split('\n')
    .map((l) => l.trim()).find((l) => l.length > 0);
  if (!linea) return `exit ${status}`;
  return linea.length <= 200 ? linea : `${linea.slice(0, 199)}…`;
}

function actualizarRepo(repo, log) {
  const r = spawnSync('git', ['-C', repo, 'pull', '--ff-only', '--quiet'],
    { encoding: 'utf8', timeout: 120000, env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }) });
  if (r.error && r.error.code === 'ETIMEDOUT') {
    log('no pude actualizar el repo: el pull se pasó de los 2 minutos (¿pidió credenciales?) — mido con lo que hay');
    return { ok: false, motivo: 'pull: timeout' };
  }
  if (r.status !== 0) {
    const motivo = motivoDeGit(r.stderr, r.stdout, r.status);
    log(`no pude actualizar el repo (${motivo}) — mido con el código que hay`);
    return { ok: false, motivo: `pull: ${motivo}` };
  }
  return { ok: true };
}

/**
 * Stagea SOLO el reporte (nunca `git add -A`) y pushea con reintento por rebase. `rutas` y `mensaje` los pasa
 * otra pieza que viaja por el mismo camino (la revisión de la semana); sin ellos, el reporte del examen.
 */
function viajar(repo, log, rutas = [RUTA_REPORTE_QUE_VIAJA], mensaje = `chore(examen): resultado del examen de revisores ${new Date().toISOString().slice(0, 10)}`) {
  // 🔴 `timeout` + `GIT_TERMINAL_PROMPT=0`: bajo launchd no hay nadie que
  // conteste un pedido de contraseña. Sin esto, un git que pregunta se queda esperando para
  // siempre, y el label de launchd queda ocupado — el examen deja de correr hasta que alguien
  // lo note por la denuncia de los 8 días. Colgar es peor que fallar.
  const git = (...a) => spawnSync('git', ['-C', repo, ...a],
    { encoding: 'utf8', timeout: 120000, env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }) });
  const add = git('add', '--', ...rutas);   // hace falta: el reporte puede ser nuevo
  if (add.status !== 0) return { ok: false, motivo: `git add falló: ${add.stderr}` };
  if (git('diff', '--quiet', 'HEAD', '--', ...rutas).status === 0) {
    log('el reporte no cambió: no hay nada que commitear'); return { ok: true };
  }
  // 🔴 `--only -- <ruta>`: lo que decide qué entra a un commit es el índice ENTERO, no el último
  // `git add`. Sin esto, un commit de las 2 de la mañana se lleva puesto lo que el dev haya dejado
  // preparado antes de irse a dormir — dentro de un commit cuyo mensaje habla de otra cosa.
  // El orden importa: todo lo que va DESPUÉS de `--` es ruta, así que el mensaje va antes.
  const commit = git('commit', '-q', '--only', '-m', mensaje, '--', ...rutas);
  if (commit.status !== 0) return { ok: false, motivo: `git commit falló: ${commit.stderr || commit.stdout}` };

  // La rama por NOMBRE: `pull --rebase origin HEAD` resuelve la rama por defecto DEL REMOTO, que
  // no tiene por qué ser en la que se está trabajando — y el reintento existe justamente para
  // cuando alguien más movió esta rama.
  const rama = (git('rev-parse', '--abbrev-ref', 'HEAD').stdout || '').trim() || 'HEAD';
  for (let intento = 1; intento <= REINTENTOS_DE_PUSH; intento++) {
    const push = git('push', 'origin', rama);
    if (push.status === 0) { log(`resultado pusheado a ${rama} (intento ${intento})`); return { ok: true }; }
    log(`push rechazado (intento ${intento} de ${REINTENTOS_DE_PUSH}): ${(push.stderr || '').trim().split('\n').pop()}`);
    if (intento === REINTENTOS_DE_PUSH) break;
    const rebase = git('pull', '--rebase', 'origin', rama);
    if (rebase.status !== 0) { git('rebase', '--abort'); log(`el rebase falló: ${(rebase.stderr || '').trim()}`); break; }
  }
  // 🔴 El archivo NO se borra ni se revierte: la medición fue buena, lo que falló fue el
  // transporte. Queda en disco para que una persona lo pushee a mano.
  return { ok: false, motivo: `no se pudo pushear tras ${REINTENTOS_DE_PUSH} reintentos — el resultado quedó en ${rutas.join(', ')}` };
}

/**
 * ¿La HOME de este proceso NO es la del usuario?
 *
 * launchd es por USUARIO (`gui/<uid>`), no por HOME: una prueba que corre el instalador en una HOME
 * temporal y llega a launchctl escribe el plist en SU LaunchAgents pero registra la tarea en el dominio
 * del usuario real — y la tarea de la máquina designada queda apuntando a una copia que se borra. La HOME real
 * sale de la cuenta del usuario (`os.userInfo().homedir`), no de $HOME. TYCON_EXAM_REAL_HOME la
 * declara SÓLO para las pruebas que instalan en una HOME de mentira con un launchctl de mentira.
 * «No pude saber» cuenta como ajena: ante la duda, launchd no se toca.
 */
function homeAjena() {
  // la ruta canónica del SISTEMA: en APFS la misma carpeta escrita con otra caja es la misma HOME,
  // y `fs.realpathSync` (la versión de JS) no normaliza la caja: sin esto, la máquina designada nunca instalaría
  const canon = (p) => { try { return fs.realpathSync.native(p); } catch (_) { return path.resolve(p); } };
  let real = leerVariable('TYCON_EXAM_REAL_HOME') || null;
  if (!real) {
    try { real = os.userInfo().homedir || null; } catch (_) { real = null; }
  }
  const propia = os.homedir() || null;
  if (!real || !propia) return { ajena: true, propia: propia || '(sin HOME)', real: real || '(no se pudo saber)' };
  return { ajena: canon(propia) !== canon(real), propia, real };
}

/**
 * Instala (o retira) el disparador del sistema. Vive ACÁ y no en el instalador a propósito: el
 * plist se GENERA desde la config, así que si la lógica estuviera en bash habría dos lugares donde
 * cambiar una frecuencia — que es exactamente el problema que esta pieza vino a cerrar.
 *
 * 🔴 En una máquina que no es la designada no instala nada, y RETIRA el disparador si estaba: si
 * mañana se designa otra máquina, la vieja tiene que dejar de correr sola.
 *
 * 🔴 Y desde una HOME que no es la del usuario no toca launchd en absoluto: ver `homeAjena`.
 */
function instalarTarea({ soloChequear } = {}) {
  const h = homeAjena();
  if (h.ajena) {
    console.log(`examen: la HOME de este proceso (${h.propia}) no es la del usuario (${h.real}): no toco launchd — la tarea programada es del usuario, no de esta HOME`);
    return { cambio: false, homeAjena: true };
  }
  const cfg = leerConfig();
  const dir = leerVariable('TYCON_EXAM_LAUNCHAGENTS') || path.join(os.homedir(), 'Library', 'LaunchAgents');
  const label = 'ar.com.tycon.examen-periodico';
  const destino = path.join(dir, `${label}.plist`);
  const launchctl = process.env.LAUNCHCTL_BIN || 'launchctl';
  const designada = esMaquinaDesignada(cfg, identidadesDeMaquina());

  if (!designada) {
    if (!fs.existsSync(destino)) return { cambio: false, designada: false };
    if (soloChequear) { console.log(`⚠ sobra el disparador del examen en esta máquina (la designada es ${cfg.designated_machine || '(ninguna)'})`); return { cambio: true, designada: false }; }
    try { spawnSync(launchctl, ['bootout', `gui/${process.getuid()}/${label}`], { stdio: 'ignore' }); } catch (_) { /* */ }
    fs.unlinkSync(destino);
    console.log(`✓ disparador del examen retirado: esta máquina ya no es la designada`);
    return { cambio: true, designada: false };
  }

  // 🔴 UN DÍA QUE NO EXISTE NO SE DESCARTA CALLADO. Escribir el disparador con los días que sí se entienden haría que,
  // con `["tuesday", "friyay"]`, el examen corriera la mitad de las veces y la configuración dijera otra cosa.
  // 🔴 La negativa va por la salida NORMAL, como los demás resultados de --install-task: el instalador llama a este guion
  // con la salida de error tapada, y por ahí nadie se enteraría.
  const { desconocidos } = diasProgramados(cfg.scheduled_days);
  if (desconocidos.length) {
    console.log([
      `⛔ NO instalo el disparador del examen: scheduled_days trae ${desconocidos.map((d) => `«${d}»`).join(', ')}, que no ${desconocidos.length === 1 ? 'es un día' : 'son días'}.`,
      `   Valen: ${['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].join(', ')}.`,
      '   Corregilo en scripts/controls-bench/exam-config.json y volvé a correr:',
      '     node scripts/controls-bench/periodic-exam.js --install-task',
    ].join('\n'));
    return { cambio: false, designada: true, rechazado: true, diasDesconocidos: desconocidos };
  }

  // 🔴 Se compara EXACTAMENTE lo que se escribe (con el salto final incluido). Comparar contra el
  // texto sin el `\n` que sí se escribe haría que nunca coincidiera: el plist se reescribiría en
  // CADA arranque de sesión y con él vendrían un `bootout` y un `bootstrap`, o sea reiniciar el
  // trabajo programado varias veces por día para dejarlo idéntico.
  const nodeBin = nodeDelDisparador();
  const contenido = `${plistDeseado({ label, nodeBin, script: __filename, ...cfg })}\n`;
  let actual = null;
  try { actual = fs.readFileSync(destino, 'utf8'); } catch (_) { /* no está */ }
  // 🔴 La anotación se renueva ANTES del corto: en régimen el disparador no cambia, y si sólo se anotara al
  // reescribirlo, el día que una herramienta se muda (otra versión de node) la anotación quedaría vieja para siempre.
  // Es el PATH de quien instala, el único que sabe dónde están; uno pobre no pisa lo bueno (tools-path.js).
  let anotadas = null;
  if (!soloChequear) {
    try { anotadas = anotarCarpetas({ env: { PATH: PATH_DE_QUIEN_LANZA } }); } catch (e) { console.log(`examen: no pude anotar dónde están claude, codex y engram (${e.message}): se buscan al lado de node y en el PATH`); }
  }
  if (actual === contenido) return { cambio: false, designada: true };
  if (soloChequear) { console.log('⚠ falta (o cambió) el disparador del examen periódico de revisores'); return { cambio: true, designada: true }; }

  // 🔴 NO SE INSTALA UN DISPARADOR QUE NO PUEDE TRABAJAR.
  //
  // Un disparador con día, hora, máquina y ruta de node correctos es inútil si no alcanza a `claude` ni a `codex`:
  // arranca puntual cada martes y viernes, muere a los 4 segundos, y lo único que lo delata es la denuncia de los 8
  // días. Un disparador instalado es una PROMESA de que el examen va a correr; instalarlo sin verificar que puede es
  // prometer algo que no se sabe si se puede cumplir, y encima callado.
  //
  // Se pregunta `--version`, y eso es DELIBERADO: acá la pregunta es "¿existe el binario?" (el
  // ENOENT), no "¿la sesión puede trabajar?" — eso lo contesta la sonda a las 2 de la
  // mañana, con una consulta de verdad, y lo tiene que contestar ENTONCES porque una sesión válida
  // hoy puede estar vencida el martes. Verificar la sesión acá gastaría dos consultas en cada
  // arranque sin probar nada sobre el día que importa.
  //
  // Va DESPUÉS del corto de idempotencia a propósito: en régimen el plist no cambia, así que este
  // freno no cuesta nada; sólo corre cuando efectivamente se va a escribir.
  // Se verifica como las va a buscar el disparador: con la anotación de recién (tools-path.js)
  const inalcanzables = ['claude', 'codex']
    .map((bin) => Object.assign({ bin }, seAlcanza(bin, Object.assign({ nodeBin }, anotadas ? { anotadas } : {}))))
    .filter((h) => !h.ok);
  if (inalcanzables.length) {
    console.log([
      '⛔ NO instalo el disparador del examen: desde acá no se alcanzan las herramientas que necesita.',
      ...inalcanzables.map((h) => `   · ${h.bin} → ${h.ruta} — ${h.motivo}`),
      `   Busqué al lado de node (${path.dirname(nodeBin)}), en la carpeta que el PATH de esta instalación tiene para cada una y después en el PATH.`,
      '   Un disparador que no puede trabajar corre puntual, muere en 4 segundos y no lo nota nadie',
      '   hasta la denuncia de los 8 días (incidente 2026-09-04). Instalá las dos y volvé a correr:',
      '     node scripts/controls-bench/periodic-exam.js --install-task',
    ].join('\n'));
    return { cambio: false, designada: true, rechazado: true, inalcanzables: inalcanzables.map((h) => h.bin) };
  }

  // 🔴 El log lo abre launchd, no este proceso: si el viejo no pasó al nombre nuevo ANTES de cargar la tarea, el nuevo
  // nace vacío y la historia de las corridas anteriores queda en un archivo que nadie mira. Una
  // copia que falla no frena la instalación: la tarea igual corre y el log nuevo empieza de cero, pero queda dicho.
  try { prepararEstado(rutaLog()); } catch (e) { console.error(`examen: ${e && e.message}`); }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(destino, contenido);
  spawnSync(launchctl, ['bootout', `gui/${process.getuid()}/${label}`], { stdio: 'ignore' });
  const boot = spawnSync(launchctl, ['bootstrap', `gui/${process.getuid()}`, destino], { stdio: 'ignore' });
  if (boot.status !== 0) spawnSync(launchctl, ['load', destino], { stdio: 'ignore' });
  const nombres = diasProgramados(cfg.scheduled_days).numeros.map((n) => Object.keys(DIAS).find((k) => DIAS[k] === n));
  console.log(`✓ examen de revisores programado: ${nombres.join(' y ')} a las ${cfg.hour || '02:00'}`);
  return { cambio: true, designada: true };
}

function ayuda() {
  console.log([
    'periodic-exam.js — corre el examen de los 28 revisores en la máquina designada.',
    '',
    '  (sin flags)   decide solo si le toca (máquina designada · período · candado) y corre',
    '  --dry-run     dice qué haría y por qué, SIN gastar nada',
    '  --force       ejecución manual: saltea máquina designada y período (respeta el candado)',
    '  --install-task [--check]     instala/retira el disparador del sistema (lo llama el instalador)',
    '                sale 2 si no instala porque no alcanza a claude/codex',
    '  --help        esto',
    '',
    'Config: la de este árbol si designa una máquina; en una versión bajada, la del clon de mantenimiento',
    '        (paths.maintainers). --dry-run dice cuál leyó.',
    'Apagado: TYCON_NO_NIGHTLY_EXAM=1',
  ].join('\n'));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────

async function main(argv) {
  // 🔴 Antes de cualquier proceso hijo (ver la cabecera).
  if (argv.includes('--help') || argv.includes('-h')) { ayuda(); return 0; }
  // 🔴 Y antes que nada, el PATH del proceso: bajo launchd viene el mínimo de macOS, y con ése
  // `codex` (script `#!/usr/bin/env node`) muere con 127 AUNQUE se lo lance por ruta absoluta.
  // Se deduce del node corriendo; lo heredan la sonda, el runner y sus hijos.
  asegurarPathDeHerramientas();
  const dryRun = argv.includes('--dry-run');
  const forzar = argv.includes('--force');
  if (argv.includes('--install-task')) {
    // 🔴 2 = "no instalé y por eso el examen NO va a correr". Salir 0 acá dejaría al instalador de
    // sesión (que lo llama con `|| true`) reportando todo bien sobre un disparador que no existe.
    const r = instalarTarea({ soloChequear: argv.includes('--check') });
    return r && r.rechazado ? 2 : 0;
  }

  const lugar = lugarDelExamen();
  const repo = lugar.repo;
  const benchDir = path.join(repo, 'scripts', 'controls-bench', '.bench');
  const cfg = leerConfig(lugar.config);
  const ctx = {
    cfg, identidades: identidadesDeMaquina(), sello: leerSello(), ahora: new Date(),
    rutaCandado: path.join(benchDir, 'examen.lock'),
  };
  const d = decidir(ctx, { forzar });
  const log = (m) => console.log(`examen: ${m}`);

  if (dryRun) {
    console.log(`examen periódico — ${d.correr ? 'HOY LE TOCA correr' : 'hoy NO le toca correr'}`);
    console.log(`  motivo:            ${d.motivo}${d.detalle ? ` (${d.detalle})` : ''}`);
    console.log(`  esta máquina es:   ${ctx.identidades.join(' / ') || '(sin nombre)'}`);
    console.log(`  máquina designada: ${cfg.designated_machine || '(ninguna — así NADIE corre)'}`);
    console.log(`  configuración:     ${lugar.config}${lugar.origen === 'mantenimiento' ? ' (del clon de mantenimiento)' : ''}`);
    if (lugar.problema) console.log(`  ⚠ ${lugar.problema}`);
    const dias = diasProgramados(cfg.scheduled_days);
    console.log(`  cada:              ${cfg.days_between_runs || 3} días · ${dias.numeros.map((n) => Object.keys(DIAS).find((k) => DIAS[k] === n)).join(', ')} ${cfg.hour || ''}`);
    // el día que no existe se marca acá también: --dry-run es el primer paso de la revisión a mano del examen
    for (const d of dias.desconocidos) console.log(`  ⚠ «${d}» no es un día: --install-task no instala el disparador hasta que se corrija`);
    console.log(`  última completa:   ${ctx.sello || '(nunca)'}`);
    console.log(`  reporte que viaja: ${path.join(repo, RUTA_REPORTE_QUE_VIAJA)}`);
    return 0;
  }

  if (!d.correr) { log(`${d.motivo}${d.detalle ? ` — ${d.detalle}` : ''}`); return d.exit; }

  // 🔴 EL NOCTURNO SE ACTUALIZA SOLO. launchd corre este script directo, sin pasar por
  // ningún arranque de sesión — así que el repo sólo se actualizaría si un humano abriera una sesión en
  // esta máquina antes de la hora. Un caso nuevo escrito el jueves no entraría a la corrida del
  // viernes, y NADA lo diría: el examen mediría con código viejo y reportaría como si fuera el actual.
  //
  // Va ACÁ y no antes: la cabecera de este archivo manda que ningún proceso hijo corra antes de los
  // early-exits (`--help`/`--dry-run`/"no le toca"), porque el instalador invoca esta pieza en CADA
  // arranque de sesión de CADA máquina — un pull ahí sería un pull por sesión en todo el equipo.
  // Y antes del candado: el candado es atómico (`wx`) y cubre la carrera igual.
  //
  // FAIL-OPEN, pero con constancia: si no se pudo actualizar, la corrida SIGUE (medir con código
  // viejo es mejor que no medir) y queda escrito en el reporte que viaja — no en el log de launchd,
  // que no lo lee nadie.
  const actualizacion = actualizarRepo(repo, log);

  // 🔴 El candado PRIMERO, y de forma atómica: la sonda de abajo puede tardar hasta dos minutos, y
  // esa espera sería la ventana por la que se colaría una segunda corrida.
  fs.mkdirSync(benchDir, { recursive: true });
  const candado = tomarCandado(ctx.rutaCandado, Date.now(), ctx.identidades[0] || '?');
  if (!candado.ok) {
    // 🔴 "Ya hay otra corrida" y "no pude ni crear el archivo" son cosas OPUESTAS. La primera es el
    // candado funcionando (exit 0, silencio). La segunda es un problema de la máquina —permisos,
    // disco lleno—: si se trata igual, el examen deja de correr para siempre sin dejar un rastro.
    if (candado.error) {
      log(`NO PUDE MEDIR: ${candado.motivo}`);
      registrarIntento(benchDir, { estado: 'incompleto', motivo: candado.motivo, fase: 'candado' });
      return 6;
    }
    log(`${candado.motivo}${candado.pid ? ` — pid ${candado.pid}, desde ${candado.desde}` : ''}`);
    return 0;
  }
  if (candado.robado) log(`candado anterior descartado (${candado.robado})`);
  const latido = latirCandado(ctx.rutaCandado, ctx.identidades[0] || '?');

  const inicio = new Date().toISOString();
  try {
    const sonda = sondaDeSesion();
    if (!sonda.ok) {
      log(`NO PUDE MEDIR: ${sonda.motivo}`);
      registrarIntento(benchDir, { estado: 'incompleto', motivo: sonda.motivo, fase: 'sonda-de-sesion' });
      return 2;   // no haber podido mirar sí es un error
    }
    const runner = leerVariable('TYCON_EXAM_RUNNER') || path.join(__dirname, 'advisor-runner.js');
    const scratch = path.join(benchDir, `examen-scratch-${process.pid}.json`);
    // 🔴 EL TRABAJO NOCTURNO ES EL CHEQUEO DE VIDA — ~12 min en vez de ~3 h.
    //
    // Por qué. El examen completo son 97 casos × 2 herramientas × 3 corridas = 582 consultas, dos veces por semana, y
    // casi todo lo que encuentra son defectos del propio banco, no de los revisores. Un control caro cuyo hallazgo
    // típico es un defecto suyo se achica hasta lo que sí paga: por cada revisor, un par de gemelos (grita / se calla),
    // una corrida, una herramienta. Eso contesta la única pregunta que ninguna otra pieza del arnés contesta —¿este
    // revisor sigue vivo?— y la contesta en 12 minutos.
    //
    // Lo que se deja de medir, a propósito y con lugar donde recuperarlo: si un revisor se contradice entre corridas
    // (necesita N corridas) y si las dos herramientas coinciden (necesita las dos). Las dos siguen disponibles a pedido
    // con `--tool both --baseline check`, para cuando se migra de herramienta o se sospecha de algo puntual. Si el
    // chequeo de vida sostiene el valor, el examen profundo se retira del todo.
    log(`arranca el chequeo de vida de los revisores (~12 min) — el examen profundo quedó a pedido`);
    // 🔴 `spawn` y no `spawnSync`: con la variante bloqueante el hilo queda detenido durante las
    // ~5h30 del examen y NINGÚN reloj puede correr — así que el latido que mantiene vivo el candado
    // sería imposible por construcción. Esperar la promesa deja al proceso atender sus temporizadores.
    // La salida de error del hijo va por tubo: se copia entera a la del padre (el registro de launchd queda igual) y se
    // guarda la cola, para que un examen que se cae sin reporte deje dicho POR QUÉ en el intento, no sólo «exit 1».
    let colaDelHijo = '';
    let colaCortada = false;
    const r = await new Promise((res) => {
      const hijo = spawn(process.execPath, [runner, '--liveness', '--baseline', 'check', '--json', scratch],
        { stdio: ['inherit', 'inherit', 'pipe'] });
      // decodificado con estado: un carácter de varios bytes partido entre dos trozos no se convierte en «�»
      if (hijo.stderr) hijo.stderr.setEncoding('utf8');
      if (hijo.stderr) hijo.stderr.on('data', (d) => {
        process.stderr.write(d);
        const junta = colaDelHijo + d;
        if (junta.length > 4096) colaCortada = true;
        colaDelHijo = junta.slice(-4096);
      });
      // 🔴 `error` NO siempre significa "el hijo murió": lo típico es que ni arrancó, pero no está
      // garantizado. Soltar el candado asumiendo que murió deja al examen corriendo de fondo con la
      // puerta abierta a una segunda corrida encima. Se lo mata explícitamente antes de seguir.
      hijo.on('error', (e) => { try { hijo.kill('SIGKILL'); } catch (_) { /* ya no está */ } res({ status: null, signal: null, error: e }); });
      hijo.on('close', (status, signal) => res({ status, signal }));
    });

    // 🔴 El exit code del examen NO decide si midió: sale 1 cuando ENCUENTRA rojos, que es una
    // medición perfectamente buena. Lo que decide es si dejó su reporte.
    let medicion = null;
    try { medicion = JSON.parse(fs.readFileSync(scratch, 'utf8')); } catch (_) { /* no dejó reporte */ }
    try { fs.unlinkSync(scratch); } catch (_) { /* */ }

    if (!medicion) {
      const motivo = r.signal
        ? `el examen fue interrumpido (${r.signal}) y no dejó reporte`
        : r.error ? `no se pudo lanzar el examen: ${colaDeError(r.error.message)}`
        : `el examen terminó (exit ${r.status}) sin dejar reporte: no midió nada`
          + ((cola) => (cola ? ` — ${cola}` : ''))(colaDeError(colaDelHijo, colaCortada));
      log(`NO PUDE MEDIR: ${motivo}`);
      registrarIntento(benchDir, { estado: 'incompleto', motivo, fase: 'corrida', inicio });
      return 3;
    }

    // ¿Esta corrida midió ALGO? Hay tres formas de dejar un reporte que no midió nada y que igual se
    // lee como una corrida buena:
    //   · no hay ni un caso;
    //   · TODOS terminaron en error de corrida (la sesión se cayó a mitad; la sonda del arranque no
    //     puede atrapar eso, porque al empezar sí andaba);
    //   · TODOS se SALTEARON por un servidor MCP ausente. Éste es el peor: los casos salteados no suman criterio ni
    //     inestables ni paridad, así que un examen con CERO revisores evaluados es indistinguible de un verde
    //     perfecto si no se mira `skippedMcp`.
    //
    // 🔴 Se cuenta en RANURAS, no en casos. Con `--tool both` cada caso tiene DOS (una por
    // herramienta), y tanto `erroresDeCorrida` como `skippedMcp` cuentan ranuras. Comparar ranuras
    // contra casos mezclaría unidades: una herramienta entera caída daría "no midió" y tiraría a la
    // basura la medición perfectamente buena de la otra.
    const casos = Object.keys(medicion.results || {}).length;
    const porCaso = String(medicion.tool || '').toLowerCase() === 'both' ? 2 : 1;
    const ranuras = casos * porCaso;
    const perdidas = Number(medicion.erroresDeCorrida || 0) + Number(medicion.skippedMcp || 0);
    const medidas = ranuras - perdidas;
    if (casos === 0 || medidas <= 0) {
      const motivo = casos === 0
        ? 'el examen dejó un reporte sin un solo caso medido'
        : `ninguno de los ${ranuras} pares caso×herramienta llegó a medirse `
          + `(${Number(medicion.erroresDeCorrida || 0)} en error de ejecución, ${Number(medicion.skippedMcp || 0)} salteados por MCP ausente)`;
      log(`NO PUDE MEDIR: ${motivo}`);
      registrarIntento(benchDir, { estado: 'incompleto', motivo, fase: 'corrida', inicio });
      return 4;
    }

    // Corrida COMPLETA: recién acá se pisa el reporte que viaja y recién acá se sella.
    const reporte = Object.assign({}, medicion, {
      kind: 'examen-periodico', estado: 'completo', alcance: 'completo',
      maquina: ctx.identidades[0] || '?', inicio, fin: new Date().toISOString(),
      // 🔴 Si no se pudo actualizar el repo, esta medición se hizo con código VIEJO y hay que
      // poder saberlo leyendo el reporte. En el log de launchd no lo ve nadie.
      ...(actualizacion.ok ? {} : { codigo_desactualizado: actualizacion.motivo }),
    });
    escribirJsonAtomico(path.join(repo, RUTA_REPORTE_QUE_VIAJA), reporte);
    registrarIntento(benchDir, { estado: 'completo', motivo: 'terminó entero', inicio, fin: reporte.fin });
    fs.mkdirSync(path.dirname(rutaSello()), { recursive: true });
    // El sello viejo pasa al nombre nuevo antes de pisarlo. Si esa copia falla se sella igual: lo que
    // se pisa es una fecha, y no sellar una corrida completa la repetiría entera (5h30) en la próxima sesión.
    let destinoSello = rutaSello();
    try { destinoSello = prepararEstado(destinoSello); } catch (e) { log(`el sello viejo no pasó al nombre nuevo: ${e && e.message}`); }
    fs.writeFileSync(destinoSello, `${reporte.fin}\n`);
    // Un rubro que la corrida no pudo medir se registra como tal, no como 0. Se deriva
    // de `tool`/`runs` con el MISMO criterio que el corredor y el aviso (un solo archivo): si
    // este examen corre con un corredor que todavía escribe ceros, el log igual dice la verdad.
    let nm = {};
    try { nm = require('./unmeasured-categories.js').rubrosNoMedidos(medicion); } catch (_) { nm = medicion.no_medido || {}; }
    log(`examen completo — criterio=${medicion.criterio}`
      + ` inestables=${nm.inestables ? 'no medido' : medicion.inestables}`
      + ` paridad=${nm.paridad ? 'no medida' : medicion.paridadReal}`
      + ` regresiones=${medicion.baselineRegressions}`);

    const v = viajar(repo, log);
    if (!v.ok) {
      // 🔴 El sello y el reporte local quedan frescos, así que en ESTA máquina —la única que
      // puede arreglarlo— no se notaría nada: la denuncia viviría sólo en el log de launchd, un canal invisible.
      // Por eso queda como intento, y el aviso lo grita.
      log(`EL RESULTADO NO VIAJÓ: ${v.motivo}`);
      registrarIntento(benchDir, { estado: 'no-viajo', motivo: v.motivo, fase: 'viaje', inicio, fin: reporte.fin });
      return 5;
    }
    return 0;
  } finally {
    clearInterval(latido);
    liberarCandado(ctx.rutaCandado, process.pid);
  }
}

/**
 * La revisión de la semana (scripts/nightly/weekly-review/; casos: scripts/tests/weekly-review.test.js T10) usa ESTE disparador: el nocturno de Azure no trae agente, y otro disparador al
 * lado gastaría la cuota dos veces. Corre después del examen, pase lo que pase con él, sólo en la máquina designada
 * (o con --force), y nunca con --help, --dry-run ni --install-task. Ella decide sola si le toca (`--if-due`, una vez
 * por semana) y tiene su propio apagado (TYCON_NO_WEEKLY_REVIEW=1); su resultado no cambia el código de salida del examen.
 */
function revisionSemanal(argv, deps = {}) {
  if (['--help', '-h', '--dry-run', '--install-task'].some((f) => argv.includes(f))) return { corrio: false, motivo: 'no en este modo' };
  const designada = deps.designada !== undefined ? deps.designada : esMaquinaDesignada(leerConfig(lugarDelExamen().config), identidadesDeMaquina());
  if (!designada && !argv.includes('--force')) return { corrio: false, motivo: 'no-designada' };
  const repo = deps.repo || lugarDelExamen().repo;
  const guion = path.join(__dirname, '..', 'nightly', 'weekly-review', 'weekly-review.js');
  const equipo = path.join(__dirname, '..', '..', 'team-repos.json');
  const args = [guion, '--if-due', '--out', repo, ...(fs.existsSync(equipo) ? ['--team-repos', equipo] : [])];
  const r = (deps.spawn || spawnSync)(process.execPath, args, { stdio: 'inherit', timeout: 45 * 60000 });
  // lo que salió mal queda en el registro del disparador (el log de launchd): un 5 es «no viajó», sin código es un corte
  const log = deps.log || ((m) => console.error(`examen-periodico: ${m}`));
  if (r && r.status === null) log(`la revisión de la semana no terminó (${r.signal || (r.error && r.error.code) || 'sin código'})`);
  else if (r && r.status !== 0) log(`la revisión de la semana salió ${r.status}: su informe dice qué no pudo`);
  return { corrio: true, codigo: r && r.status };
}

module.exports = {
  VEJEZ_MS, RUTA_REPORTE_QUE_VIAJA, CANDADO_EN_ESCRITURA_MS, viajar, revisionSemanal,
  leerConfig, lugarDelExamen, designaMaquina, identidadesDeMaquina, esMaquinaDesignada, periodoCumplido, estadoDelCandado,
  motivoDeGit, colaDeError,
  plistDeseado, diasProgramados, decidir, instalarTarea, liberarCandado, tomarCandado, main,
};

if (require.main === module) {
  // Los nombres viejos siguen andando. Sin la biblioteca al lado (la copia del banco), paso directo.
  let legacy = null;
  try { legacy = require(path.join(__dirname, '..', 'lib', 'legacy-names.js')); } catch (_) { legacy = null; }
  if (legacy) legacy.aliasArgv('scripts/controls-bench/periodic-exam.js', { exitCode: 2, prefix: 'examen-periodico: ' });
  main(process.argv.slice(2))
    .then((c) => {
      try { revisionSemanal(process.argv.slice(2)); } catch (e) { console.error(`examen-periodico: la revisión de la semana no se pudo lanzar: ${e && e.message}`); }
      process.exit(c);
    })
    .catch((e) => { console.error(`examen-periodico: ${e && e.message}`); process.exit(1); });
}
