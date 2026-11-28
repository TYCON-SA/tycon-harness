#!/usr/bin/env node
/**
 * tycon-pipeline PreToolUse hook (matcher: Bash|PowerShell|Monitor) — la segunda puerta del portón de CARRIL.
 *
 * El portón de carril vive en PreToolUse Edit|Write (`on-story-gate.js`). Pero un archivo también se
 * escribe por Bash: `cat > src/Foo.cs <<'EOF'`, `sed -i`, `tee`, `perl -pi`, `cp`, un `python3 -c
 * "open(...,'w')"`. Y no hace falta malicia para ir por ahí: en "auto mode" el propio arnés INSTRUYE
 * editar con sed/heredocs en vez de Edit/Write. Sin
 * esta puerta, el portón tendría un agujero del tamaño de la puerta.
 *
 * Qué hace: extrae del comando los paths que el comando VA A ESCRIBIR (redirecciones, tee, sed -i,
 * perl -i, cp/mv destino, open(...,'w'), writeFileSync, Set-Content/Out-File), se queda con los que
 * son CÓDIGO (mismo criterio que el portón: `lib/story-gate.js#isCodeFile`), y corre sobre cada uno el
 * MISMO cálculo (`lib/story-gate-io.js#evaluate`). Si alguno bloquea, el comando se deniega con el
 * mismo mensaje (indicando que vino por Bash).
 *
 * Es BEST-EFFORT a propósito: un parser de shell completo acá sería más frágil que útil. Lo que no
 * reconoce (git apply, patch, herramientas con --write) pasa. La red de fondo sigue siendo la misma
 * que para el resto del arnés: el diff en el commit. Conservador en la extracción para no dar falsos
 * positivos: sólo el token DESPUÉS de `>`/`>>`/`tee`, sólo tokens con extensión de código tras
 * `sed -i`/`perl -i`, sólo el ÚLTIMO token de un `cp`/`mv`.
 *
 * Exit: 0 deja pasar · 2 deniega (stderr = mensaje). Los errores van a hook-errors.log.
 * Escape: el mismo del portón (env TYCON_STORY_GATE=off · config commiteada del repo).
 *
 * ── CUANDO EL FRENO MISMO FALLA ───────────────────────────────────────────────────────────
 * Un módulo del arranque que no carga, o un archivo suyo que falta o no compila cuando lo pide al decidir (también si
 * lo pide un control dentro de su propia red, que seguiría sin él): el freno no decidió con todas sus piezas, así que
 * frena todo comando y dice cuál. En una versión bajada (trae su lista, `.tycon-release.json`, y no es un clon), lo
 * mismo con un archivo suyo que no es el que se instaló: compara la huella de cada uno que usó con la de la lista. Una
 * falla sin prever mientras decide, o una entrada que no se puede leer: frena sólo el comando que escribe y nombra una
 * historia o una constancia, leído como texto (`frenaLaRed`); lo demás sigue. Cada una queda en
 * hook-errors.log: «FRENÓ POR FALLA» o «FAILED OPEN». Límite conocido: un error de sintaxis en este archivo no llega a
 * correr nada.
 * El análisis corre en un hilo y `lib/gate-clock.js` mira el reloj (20 s, `TYCON_BASH_GATE_TIMEOUT_S`): si no alcanza a
 * decidir, el comando no corre. Sin esa biblioteca, el análisis corre acá, sin reloj, y queda «FAILED OPEN». El análisis
 * le anota al reloj sus pasos (`paso`): si tarda la mitad del reloj o más, queda «LENTO» con el paso más lento, y si lo
 * corta, el corte dice en cuál estaba.
 *
 * ── SEGUNDA RESPONSABILIDAD: la puerta Bash del freno de STORY A MANO ────────────────
 * El caso que motiva ese freno son los heredocs de Bash —
 * un hook que sólo mirara Edit|Write no habría frenado nada. Sobre los MISMOS targets extraídos
 * arriba, para cada `.md` que NO existe: si el contenido (cuerpo del heredoc, o el texto inline
 * de un `printf`/`echo -e` con `\n`) declara identidad de story, o —sin contenido legible— el
 * nombre lo sugiere (`story-*.md`, `stories/*.md`), corre `lib/story-skill-gate-io.js#evaluate`. Lo mismo
 * para cada `.md` que existe: si es una historia en borrador, escribirle encima desde acá (`sed -i`, un heredoc)
 * pide la constancia del validador, porque desde un comando no se ve qué estado queda.
 * Por Bash se acepta ser MÁS conservador (nombre + ruta) cuando el
 * contenido no se puede parsear (`cp plantilla.md specs/story-x.md`); el costo es un `.md` con
 * nombre de story que no lo es, en un repo del arnés, escrito por Bash sin el skill — raro, y
 * con escape auditado. Kill-switch propio: TYCON_STORY_SKILL_GATE=off (independiente del carril).
 * Una historia que existe y no está en borrador no se escribe desde acá: desde un comando no se ve qué queda escrito, y
 * su estado lo cambia marker.js. Frena con o sin ejecución abierta.
 * Un guion en archivo (python, node, perl, ruby) con una historia entre sus argumentos cuenta como que la escribe, aunque
 * sólo la lea. Límite conocido: no ve la historia que el guion recibe por otro camino — por `xargs`, `find -exec`,
 * `$(cat lista)`, una variable de entorno, la entrada estándar o una carpeta entera que recorre. La orden que corre por
 * `find -exec`, `xargs` o un heredoc a un shell sí se mira como otro comando, por lo que escribe o borra ella misma.
 *
 * ── TERCERA: los marcadores de la ejecución ───────────────────────────────────────────────
 * Borrar o mover un marcador (`<estado>/active/`, `<estado>/active.json`, o una carpeta que los contiene), de esta
 * sesión o de otra, frena: la ejecución se cierra con `marker.js clear` o `clear-session`. Cuenta también un guion
 * inline que borra (`unlinkSync`, `os.remove`, `rmtree`…). Con el carril apagado, no.
 */

'use strict';

// Antes de todo módulo del arnés: el hilo principal sólo mira el reloj, y este mismo archivo corre en un hilo aparte
const { isMainThread, workerData, parentPort } = require('worker_threads');
let relojRoto = null;
if (require.main === module && isMainThread) {
  try {
    require('./lib/gate-clock.js').vigilar({ archivo: __filename });
    return;
  } catch (e) { relojRoto = e; }
}

const fs = require('fs');
const os = require('os');
const path = require('path');

// Las partes del freno (lib/bash-gate-*.js). Si falta una, el freno frena y la nombra: seguir sin ella sería decidir
// sin mirar. Otra falla al cargar sigue su camino de siempre (la segunda lectura, con la red de fallas). Cargado como
// biblioteca (un aviso que usa sus funciones), no termina el proceso de quien lo carga: tira un error que la nombra.
const parte = (cargar) => {
  try { return cargar(); } catch (e) {
    const falta = e && e.code === 'MODULE_NOT_FOUND' && /bash-gate-[\w-]+\.js/.exec(String(e.message).split('\n')[0]);
    if (!falta) throw e;
    const motivo = `al freno de escrituras le falta una parte suya, lib/${falta[0]}`;
    if (require.main !== module) throw new Error(`${motivo} (reinstalá el arnés)`);
    // el renglón va directo a la carpeta del estado: la red carga antes que el registro de más abajo, que con ella
    // ausente todavía no sabe dónde escribir. El aviso de arranque cuenta las fallas por este renglón
    try {
      let dir;
      try { const lib = path.join(__dirname, '..', '..', '..', 'scripts', 'setup', 'harness', 'tycon-home.js'); dir = require(lib).stateDir(os.homedir()); } catch { dir = os.tmpdir(); }
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'hook-errors.log'), `[${new Date().toISOString()}] on-bash-write-gate FRENÓ POR FALLA: ${(e && e.stack) || e}\n\n`, 'utf8');
    } catch { /* sin dónde anotarlo, lo dice el mensaje */ }
    try {
      process.stderr.write(`⛔ tycon-pipeline — ${motivo}: el comando no corrió. Reinstalá el arnés; \`/tycon-harness\` dice si quedó bien instalado.\n`);
    } catch { /* sin dónde decirlo, frena igual */ }
    process.exit(2);
  }
};
const { GUION_ESCRIBE, NOMBRA_RUTA_DE_HISTORIA, frenaLaRed, textoDeUnaEntradaRota, usarRegistro } = parte(() => require('./lib/bash-gate-net.js'));
// las partes registran sus fallas con el registro de este archivo (logHookError, más abajo)
usarRegistro(logHookError);
// sin el lector de rutas no se sabe dónde vive el estado: el registro va a la carpeta temporal, y el mensaje lo dice
const carpetaDelEstado = () => {
  try { return stateDirOf(os.homedir()); } catch { return os.tmpdir(); }
};
function salirPorLaRed(e, texto) {
  // la falla que vino de una pieza rota no es una falla sin prever: frena todo
  const rota = piezaRota || archivoQueNoEsElInstalado();
  if (rota) salirSinCargar(rota);
  if (frenaLaRed(String(texto || ''))) {
    logHookError(e, 'FRENÓ POR FALLA');
    try {
      process.stderr.write([
        '⛔ tycon-pipeline — EL FRENO FALLÓ Y ESTE COMANDO ESCRIBE UNA HISTORIA O UNA CONSTANCIA',
        `  No pude mirar qué escribe. La falla quedó en ${registroDeFallas()}.`,
        '  Una historia se edita con la herramienta de edición (Edit/Write); una constancia la firma una persona.',
        '',
      ].join('\n'));
    } catch { /* sin dónde decirlo, frena igual */ }
    process.exit(2);
  }
  logHookError(e, 'FAILED OPEN');
  process.exit(0);
}
let entradaCruda = null;
let yaDecidio = false;
function leerEntrada() {
  if (entradaCruda === null) {
    // la segunda lectura recibe el texto que ya leyó el análisis: la entrada estándar no se puede leer dos veces
    if (!isMainThread && workerData && typeof workerData.entrada === 'string') entradaCruda = workerData.entrada;
    // sin texto no hay qué frenar: el comando pasa sin mirarse
    else try { entradaCruda = fs.readFileSync(0, 'utf8'); } catch (e) { entradaCruda = ''; logHookError(e, 'FAILED OPEN'); }
    if (!isMainThread && parentPort) require('./lib/gate-clock.js').entregarEntrada(parentPort, workerData, entradaCruda);
  }
  return entradaCruda;
}
function salirPorLaRedConLaEntrada(e) {
  const cruda = leerEntrada();
  let texto = textoDeUnaEntradaRota(cruda);
  try { texto = JSON.parse(cruda).tool_input.command; } catch { /* entrada rota o sin comando: se lee el texto entero */ }
  salirPorLaRed(e, texto);
}

// ── la pieza rota: el freno que no tiene todas sus piezas ─────────────────────────────────────────
// Sin terminar de cargarse, el freno no decidió nada: frena todo comando y dice qué no cargó. Igual con una pieza rota
// al decidir. La red de fallas queda para lo que se cae con todas las piezas: ahí sabe lo bastante para frenar lo que
// importa.
let cargado = false;
// La primera pieza rota que se pidió al decidir, también la que pide un control dentro de su propia red (un `try` que
// traga el error y sigue sin ella): sin esto, ese control se apagaba callado y el resto decidía sin él. La de más
// adentro queda primero: un archivo que falta hace fallar también a los que lo cargan.
let piezaRota = null;
if (require.main === module) {
  const Module = require('module');
  const cargar = Module._load;
  Module._load = function cargarYAnotar(pedido, padre, ...resto) {
    try { return cargar.call(this, pedido, padre, ...resto); } catch (e) {
      try { if (!piezaRota && esPiezaDelArnes(e, pedido, padre)) piezaRota = e; } catch { /* la parte que la define todavía está cargando */ }
      throw e;
    }
  };
}
function salirSinCargar(e) {
  logHookError(e, 'FRENÓ POR FALLA');
  try {
    // la parte que lo sabe decir puede ser la que no cargó: sin ella, el mensaje sale sin ese detalle
    let roto = null;
    try { roto = archivoQueNoCompila(e); } catch { /* sin la parte de las palabras */ }
    const cual = e && e.instalado ? e.message : roto ? `No cargó: ${roto} (no compila: ${e.message})` : `No cargó: ${String((e && e.stack) || e).split('\n')[0]}`;
    process.stderr.write([
      '⛔ tycon-pipeline — EL FRENO DE ESCRITURAS NO PUDO CARGARSE ENTERO: ningún comando corre hasta repararlo',
      `  ${cual}`,
      `  La falla quedó en ${registroDeFallas()}. Reinstalá el arnés desde tu terminal; \`/tycon-harness\` dice si quedó bien instalado.`,
      '',
    ].join('\n'));
  } catch { /* sin dónde decirlo, frena igual */ }
  process.exit(2);
}
if (require.main === module) {
  // lo que `try` no alcanza: un módulo de los de abajo que no carga, o una falla después de decidir, en los avisos
  process.on('uncaughtException', (e) => {
    if (yaDecidio) { logHookError(e); process.exit(0); }
    if (!cargado) salirSinCargar(e);
    salirPorLaRedConLaEntrada(e);
  });
}

// la carpeta del estado, de una sola pieza. Sin `lib/state-dir.js`: la red de arriba la necesita aunque ese módulo no cargue
const stateDirOf = (() => { const lib = path.join(__dirname, '..', '..', '..', 'scripts', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
if (relojRoto) logHookError(relojRoto, 'FAILED OPEN');
// la segunda lectura va acá: necesita la carpeta del estado para su renglón, y ninguno de los módulos de abajo
if (require.main === module && !isMainThread && workerData && workerData.modo === 'net') salirPorLaRedConLaEntrada(workerData.falla);
const { isCodeFile, isManifestFile } = require('./lib/story-gate.js');
const { resolveSessionId } = require('./lib/session-id.js');
// ── variables del comando ─────────────────────────────────────
// `SP=<scratchpad>; python3 -c "open('$SP/x.cs','w')"` sale frenado como «EDICIÓN INVISIBLE»: el destino se resuelve
// tal cual, `<repo>/$SP/x.cs`, y queda adentro del repo de la corrida.
// Las variables las expande `lib/command-vars.js`: con el valor que tenían EN ESE PUNTO del comando, y si el comando no
// las asignó, con el ambiente. Lo que no se puede saber sin ejecutar (`$(…)`, `${VAR:-x}`, una variable que nadie
// define) queda «sin resolver»: se resuelve como siempre (del lado seguro: si cae en el repo, frena) y queda marcado,
// para que el mensaje diga que no se pudo resolver en vez de presentarlo como código del repo sin más.
// (Un lector compartido, `scripts/lib/shell-parse.js`, no sirve acá:
// da rutas falsas — la cabecera de command-vars.js dice por qué.)
const { expandirRuta } = require('./lib/command-vars.js');
// las partes, después del manejador de fallas del arranque y de la carpeta del estado: una que no carga frena con su
// nombre y deja su renglón, como un `require` de arriba del freno entero
const { BORRA_O_MUEVE, MENCIONA_HISTORIA, RAIZ_DEL_ARNES, SHELL_CON_C, archivoQueNoCompila, archivoQueNoEsElInstalado, blancoPorRedireccion, corredoresDeLaOrganizacion, esPiezaDelArnes, expandirLlaves, leadingCd, nativePath, programasPorEntrada, repoConHistorias, splitSegments, subcomandosComoComodin, vaAUnShell } = parte(() => require('./lib/bash-gate-words.js'));
const { algunOpenEscribe, estadoDeHistoria, expandirComodin, inlineStoryText, resolveTarget, sinCierre, sinComentarioAlFinal } = parte(() => require('./lib/bash-gate-expansions.js'));
const { anotarBorradosDeLaStory, anotarEscriturasConsola, destinosArmados, escritosDelGuion, extractWriteTargets, heredocs, mensajeCarpetaSinSeguir, mensajeRutaSinResolver, modoDeLectura, nameSuggestsStory, quitarCuerposDeHeredoc, salidaAjenaALaRevision, sinBarras, stripNonCommandText } = parte(() => require('./lib/bash-gate-targets.js'));
const { aprobacionesTocadas, buzonTocado, carpetasDelComando, comandosAnidados, comandosPorOtroPrograma, corridasDeRevisoresTocadas, criticosTocados, fotosTocadas, cwdDelComando, destinosBorrados, lanzadasTocadas, marcadoresTocados, marcasDeTerminalTocadas, relativosDe, resolverCd, revisionDelPlanTocada } = parte(() => require('./lib/bash-gate-commands.js'));
const { borraEjecucionAbierta, carpetasQueBorraOMueve, cuerposDistintos, destinosResueltos, ejecucionPerdida, estadoPorOtroPrograma, frenoBorrarYArmados, guionesEnArchivo, heredocBodies, renameOrCopyOfExistingStory } = parte(() => require('./lib/bash-gate-scripts.js'));
const { constanciasSinHuella, constanciasTocadas, coordinadoraPorConsola, historiasPorConsola } = parte(() => require('./lib/bash-gate-records.js'));

// ── hook ──────────────────────────────────────────────────────────────────────────────────────────

// «FAILED OPEN» es sólo la falla que deja pasar el comando sin mirarlo, y «FRENÓ POR FALLA» la que lo frena sin mirarlo: las
// de arriba de todo. Las demás se atrapan donde pasan, y el freno sigue con lo que sabe
function logHookError(e, rotulo = 'falla atrapada') {
  try {
    const dir = carpetaDelEstado();
    fs.mkdirSync(dir, { recursive: true });
    const desde = esCopiaQueNoEsLaInstalada() ? ` (copia en ${RAIZ_DEL_ARNES})` : '';
    fs.appendFileSync(registroDeFallas(),
      `[${new Date().toISOString()}] on-bash-write-gate${desde} ${rotulo}: ${(e && e.stack) || e}\n\n`, 'utf8');
  } catch { /* noop */ }
}

// En una máquina con el arnés instalado, el registro de fallas (`hook-errors.log`) mide los frenos que corren de verdad:
// una copia que no es la instalada (la de una prueba, la de un laboratorio en la carpeta de trabajo de una sesión) anota
// en un registro aparte, para no ensuciar esa medición. Sin instalación (un clon, o la casa de una prueba), o si no se
// puede saber, el registro de siempre.
function esCopiaQueNoEsLaInstalada() {
  try {
    const arbol = require('./lib/installed-tree.js');
    const raices = arbol.roots({ home: os.homedir() });
    return raices.length > 0 && !arbol.inside(raices, RAIZ_DEL_ARNES);
  } catch { return false; }
}
function registroDeFallas() {
  return path.join(carpetaDelEstado(), esCopiaQueNoEsLaInstalada() ? 'hook-errors-copies.log' : 'hook-errors.log');
}

const { PIPELINE_LISTA } = require('./lib/marker-command.js');
/**
 * Lo que decide el freno sobre un comando. Lo lee dos veces si tiene comentarios: con sus comentarios apagados
 * (`conComentariosApagados`) y sin apagarlos, y frena si cualquiera de las dos frena. Así, apagar los comentarios nunca
 * deja pasar algo que la lectura sin apagarlos frena, aunque algo se tome por comentario sin serlo. La segunda lectura
 * sólo decide: no anota escrituras ni borrados, que ya anotó la primera.
 */
// En qué paso está el análisis, para el reloj (lib/gate-clock.js): si tarda o lo cortan, el registro lo dice. Sin el
// reloj no se lo vuelve a pedir: pedido al decidir, contaría como una pieza rota y frenaría todo
function paso(texto) {
  if (relojRoto) return;
  try { require('./lib/gate-clock.js').anotarPaso(texto); } catch { /* sin reloj, no hay a quién decírselo */ }
}

function handle(event, opts = {}) {
  modoDeLectura({ apagoAlgo: false });
  const r = handleUnaLectura(event, opts);
  if ((r && r.block) || !modoDeLectura().apagoAlgo) return r;
  paso('la segunda lectura, sin los comentarios');
  modoDeLectura({ leerComentarios: false });
  modoDeLectura({ soloDecidir: true });
  try {
    const comoAntes = handleUnaLectura(event, opts);
    if (comoAntes && comoAntes.block) return comoAntes;
  } finally {
    modoDeLectura({ leerComentarios: true });
    modoDeLectura({ soloDecidir: false });
  }
  return r;
}

function handleUnaLectura(event, opts = {}) {
  {
    let perdida = null;
    paso('mirando si se pierde una ejecución');
    try { perdida = ejecucionPerdida(event); } catch (e) { logHookError(e); perdida = { block: `🔴 EJECUCIÓN PERDIDA — no pude revisar las piezas de la ejecución (${e.message}): frena hasta poder mirarlas.\n` }; }
    if (perdida) return perdida;
  }
  {
    let abierta = null;
    paso('mirando si borra una ejecución abierta');
    try { abierta = borraEjecucionAbierta(event); } catch (e) { logHookError(e); abierta = { block: `🔒 CERRÁ LA EJECUCIÓN ANTES — no pude revisar si el comando borra la carpeta de una ejecución abierta (${e.message}): frena hasta poder mirarlo.\n` }; }
    if (abierta) return abierta;
  }
  {
    let huella = null;
    paso('mirando las constancias de un commit o un empuje');
    try { huella = constanciasSinHuella(event, opts); } catch (e) { logHookError(e); huella = { block: `🔒 CONSTANCIA SIN MIRAR — no pude revisar las constancias antes del commit o del empuje (${e.message}): frena hasta poder mirarlas.\n` }; }
    if (huella) return huella;
  }
  {
    let coordinadora = null;
    paso('mirando lo que se escribe en la carpeta de la coordinadora');
    try { coordinadora = coordinadoraPorConsola(event, opts); } catch (e) { logHookError(e); coordinadora = null; }
    if (coordinadora) return coordinadora;
  }
  // el stash que se llevaría archivos de otra sesión viva, y el drop/pop/clear de lo que guardó otra
  // (lib/stash-guard.js). Una falla del freno queda en hook-errors.log y deja pasar: el caso de «no pude calcular» lo decide él
  if (deConsola(event)) {
    let stash = null;
    try {
      const cmd = event?.tool_input?.command;
      if (typeof cmd === 'string' && /\bstash\b/.test(cmd)) {
        paso('mirando un stash');
        stash = require('./lib/stash-guard.js').evaluar({
          cmd, cwd: nativePath(event?.cwd || process.cwd()), sessionId: resolveSessionId(event?.session_id),
          stateDir: opts.stateDir || require('./lib/story-gate-io.js').DEFAULT_STATE_DIR,
          avisar: (texto) => logHookError(texto, 'stash-guard sin medir'),
        });
      }
    } catch (e) { logHookError(e, 'stash-guard'); stash = null; }
    if (stash && stash.block) return stash;
  }
  let deprecado = null;
  try {
    const cmd = event?.tool_input?.command;
    if (cmd && deConsola(event)) {
      const baseCwd = nativePath(event?.cwd || process.cwd());
      paso('mirando si escribe código deprecado');
      deprecado = require('./on-deprecated-edit.js').porLaTerminal({
        cmd, cwd: cwdDelComando(cmd, baseCwd),
        // todo destino, sea o no código: lo deprecado puede ser una guía, un esquema o una configuración
        destinos: (c, cwd) => destinosResueltos(c, cwd, process.platform, { keep: () => true }).map((d) => d.abs),
        sessionId: resolveSessionId(event?.session_id),
        stateDir: opts.stateDir || require('./lib/story-gate-io.js').DEFAULT_STATE_DIR,
        via: `Bash: ${String(cmd).replace(/\s+/g, ' ').slice(0, 120)}`,
      });
    }
  } catch (e) { logHookError(e); deprecado = null; }
  if (deprecado && deprecado.block) return deprecado;
  paso('mirando el carril y las historias');
  return handleCarrilEHistoria(event, opts) || deprecado;
}

// Bash, la herramienta PowerShell de Claude Code en Windows y Monitor, que corre su comando de fondo: las tres traen el
// comando en la misma entrada. Un evento sin nombre de herramienta es el de las pruebas y el de Codex
const HERRAMIENTAS_DE_CONSOLA = ['Bash', 'PowerShell', 'Monitor'];
const deConsola = (event) => !event?.tool_name || HERRAMIENTAS_DE_CONSOLA.includes(event.tool_name);

function handleCarrilEHistoria(event, opts = {}) {
  const laneOff = String(process.env.TYCON_STORY_GATE || '').toLowerCase() === 'off';
  const skillOff = String(process.env.TYCON_STORY_SKILL_GATE || '').toLowerCase() === 'off';
  if (!deConsola(event)) return null;
  const cmd = event?.tool_input?.command;
  if (!cmd) return null;
  const baseCwd = nativePath(event?.cwd || process.cwd());
  const io = require('./lib/story-gate-io.js');
  const stateDir = opts.stateDir || io.DEFAULT_STATE_DIR;
  const installedTree = require('./lib/installed-tree.js');
  const installedRoots = Array.isArray(opts.installedRoots) ? opts.installedRoots : io.defaultInstalledRoots();
  const { isInside } = require('./lib/atdd-preedit.js');
  // Con un comando ambiguo (varios cd), de las carpetas donde puede caer una escritura relativa vale la que hace caer en
  // el repo de la corrida una de código o un manifiesto (alcanza con una para frenar); si no hay, la que hace caer
  // cualquiera (una carpeta, un borrado); si tampoco, la primera. El lado que frena
  const carpetas = carpetasDelComando(cmd, baseCwd);
  let cwd = carpetas[0];
  if (carpetas.length > 1) {
    try {
      const marcador = io.readMarker(stateDir, resolveSessionId(event?.session_id));
      const repoCorrida = marcador && marcador.repoPath;
      const relativos = relativosDe(String(cmd), String(cmd)) || [];
      const enRepo = (c, soloCodigo) => repoCorrida && relativos.some((t) => {
        const abs = resolveTarget(expandirRuta(cmd, t).valor, c, process.platform, { homeVariable: true });
        const adentro = isInside(repoCorrida, abs) || isInside(installedTree.realPath(repoCorrida), installedTree.realPath(abs));
        return adentro && (!soloCodigo || isCodeFile(abs) || isManifestFile(abs));
      });
      cwd = carpetas.find((c) => enRepo(c, true)) || carpetas.find((c) => enRepo(c, false)) || carpetas[0];
    } catch (e) { logHookError(e); }
  }
  // el estado y el árbol instalado del arnés se miran por ruta real, sea cual sea la extensión; las constancias de los
  // cambios de control, por su final
  const stateReal = installedTree.realPath(stateDir);
  const { signedRecordKind } = require('./lib/story-gate.js');
  const protegido = (abs) => {
    const real = installedTree.realPath(abs);
    return isInside(stateDir, abs) || isInside(stateReal, real) || installedTree.inside(installedRoots, real, { real: true })
      || signedRecordKind(abs) !== null || signedRecordKind(real) !== null;
  };
  // La zona protegida (el estado o el árbol instalado) adonde puede llegar un destino con comodín, o null. Un patrón de k
  // tramos desde su primer comodín sólo nombra rutas a esa profundidad; `**` y `(a|b)` (zsh) llegan a cualquiera. Llega
  // si el tramo fijo ya está adentro de la zona, o si la zona queda a menos de k tramos debajo de él.
  const zonaQueAlcanzaElComodin = (abs) => {
    const partes = String(abs).split(process.platform === 'win32' ? /[\\/]+/ : /\/+/);
    const i = partes.findIndex((p) => /[*?[{(]/.test(p));
    if (i < 0) return null;
    const fijo = partes.slice(0, i).join(path.sep) || path.sep;
    const resto = partes.slice(i);
    const cualquiera = resto.some((p) => p.includes('**') || /[(|]/.test(p));
    for (const z of [stateDir, stateReal, ...installedRoots, ...installedRoots.map((r) => installedTree.realPath(r))]) {
      if (isInside(z, fijo)) return z;
      if (isInside(fijo, z) && (cualquiera || resto.length > path.relative(fijo, z).split(path.sep).length)) return z;
    }
    return null;
  };
  // un `.md` también se mira en un `sed -i`: puede ser una historia en borrador (el freno de historia sin validar)
  // (con las variables del comando expandidas: `sed -i … "$F"` con `F=story.md`)
  const keep = (t) => {
    const valor = expandirRuta(cmd, t).valor;
    const abs = resolveTarget(valor, cwd, process.platform, { homeVariable: true });
    return /\.md$/i.test(t) || /\.md$/i.test(String(valor)) || protegido(abs) || zonaQueAlcanzaElComodin(abs) !== null;
  };
  // las constancias de cambio de control, sin interruptor: como el freno de Edit y Write
  const constancias = constanciasTocadas(cmd, cwd, stateDir, baseCwd);
  // el registro de las aprobaciones de la persona, también al borrarlo o moverlo
  const aprobaciones = constancias.length ? [] : aprobacionesTocadas(cmd, cwd, stateDir);
  if (aprobaciones.length) {
    const sg = require('./lib/story-gate.js');
    const via = `Bash: ${String(cmd).replace(/\s+/g, ' ').slice(0, 120)}`;
    // el comando que nombra el registro (su carpeta, un archivo suyo, su nombre en un texto) recibe su cartel. El que lo
    // alcanza sólo por una carpeta que lo contiene borra el estado entero, con los marcadores: el cartel es el del estado,
    // que dice cómo se cierra una ejecución; el del registro queda para cuando ese freno está apagado (éste no se apaga)
    const directo = aprobaciones.some((a) => /(^|[^\w.-])owner-approvals(?![\w.-])/i.test(String(a)));
    const tocados = directo || laneOff ? [] : marcadoresTocados(cmd, cwd, stateDir);
    return { block: (tocados.length ? sg.markerDeleteMessage(tocados, via) : sg.blockMessage({ kind: 'owner-approvals' }, { filePath: aprobaciones[0], via })) + '\n' };
  }
  // las marcas de las constancias dadas en la terminal, también al borrarlas o moverlas
  const marcasDeTerminal = constancias.length ? [] : marcasDeTerminalTocadas(cmd, cwd, stateDir);
  if (marcasDeTerminal.length) {
    const sg = require('./lib/story-gate.js');
    const via = `Bash: ${String(cmd).replace(/\s+/g, ' ').slice(0, 120)}`;
    // como el registro: el que las alcanza sólo por una carpeta de arriba borra el estado entero y recibe ese cartel
    const directo = marcasDeTerminal.some((a) => /(^|[^\w.-])terminal-acknowledgments(?![\w.-])/i.test(String(a)));
    const tocados = directo || laneOff ? [] : marcadoresTocados(cmd, cwd, stateDir);
    return { block: (tocados.length ? sg.markerDeleteMessage(tocados, via) : sg.blockMessage({ kind: 'terminal-acknowledgments' }, { filePath: marcasDeTerminal[0], via })) + '\n' };
  }
  // el registro de las sesiones que abrió la coordinadora, también al borrarlo o moverlo
  const lanzadas = constancias.length ? [] : lanzadasTocadas(cmd, cwd, stateDir);
  if (lanzadas.length) {
    const sg = require('./lib/story-gate.js');
    return { block: sg.blockMessage({ kind: 'launched-sessions' }, { filePath: lanzadas[0], via: `Bash: ${String(cmd).replace(/\s+/g, ' ').slice(0, 120)}` }) + '\n' };
  }
  // el buzón de la oficina, también al borrarlo o moverlo
  const buzon = constancias.length ? [] : buzonTocado(cmd, cwd, stateDir);
  if (buzon.length) {
    const sg = require('./lib/story-gate.js');
    const via = `Bash: ${String(cmd).replace(/\s+/g, ' ').slice(0, 120)}`;
    const directo = buzon.some((a) => /(^|[^\w.-])office[\\/](?:inbox|tomados|usados|messages\.jsonl)/i.test(String(a)) || /[\\/]office[\\/]?$/.test(String(a)));
    const tocados = directo || laneOff ? [] : marcadoresTocados(cmd, cwd, stateDir);
    return { block: (tocados.length ? sg.markerDeleteMessage(tocados, via) : sg.blockMessage({ kind: 'office-mailbox' }, { filePath: buzon[0], via })) + '\n' };
  }
  // el registro de los críticos que reportaron los revisores, también al borrarlo o moverlo
  const criticos = constancias.length ? [] : criticosTocados(cmd, cwd, stateDir);
  if (criticos.length) {
    const sg = require('./lib/story-gate.js');
    return { block: sg.blockMessage({ kind: 'reported-criticals' }, { filePath: criticos[0], via: `Bash: ${String(cmd).replace(/\s+/g, ' ').slice(0, 120)}` }) + '\n' };
  }
  // el registro de corridas de los revisores, también al borrarlo o moverlo
  const corridas = constancias.length ? [] : corridasDeRevisoresTocadas(cmd, cwd, stateDir);
  if (corridas.length) {
    const sg = require('./lib/story-gate.js');
    return { block: sg.blockMessage({ kind: 'advisor-runs' }, { filePath: corridas[0], via: `Bash: ${String(cmd).replace(/\s+/g, ' ').slice(0, 120)}` }) + '\n' };
  }
  // las fotos de lo protegido, también al borrarlas o moverlas
  const fotos = constancias.length ? [] : fotosTocadas(cmd, cwd, stateDir);
  if (fotos.length) {
    const sg = require('./lib/story-gate.js');
    return { block: sg.blockMessage({ kind: 'write-photos' }, { filePath: fotos[0], via: `Bash: ${String(cmd).replace(/\s+/g, ' ').slice(0, 120)}` }) + '\n' };
  }
  // la revisión automática del plan, también al borrarla o moverla, o con un `--out` que no es el del corredor del pase
  const ajena = constancias.length ? null : salidaAjenaALaRevision(cmd, cwd, stateDir, installedRoots);
  const revisionDelPlan = constancias.length ? [] : ajena ? [ajena] : revisionDelPlanTocada(cmd, cwd, stateDir);
  if (revisionDelPlan.length) {
    const sg = require('./lib/story-gate.js');
    return { block: sg.blockMessage({ kind: 'plan-review' }, { filePath: revisionDelPlan[0], via: `Bash: ${String(cmd).replace(/\s+/g, ' ').slice(0, 120)}` }) + '\n' };
  }
  if (constancias.length) {
    const sg = require('./lib/story-gate.js');
    // el registro del arnés y la carpeta de una ejecución son estado del pipeline; lo demás, su constancia
    const kind = constancias.map((c) => sg.signedRecordKind(String(c).replace(/ \(.*\)$/, ''))).find(Boolean)
      || (constancias.some((c) => /(^|[\\/])gates\.log$|\(no se puede ver qué trae lo que se descomprime\)$/.test(String(c))) ? 'state-dir' : 'control-approvals');
    return { block: sg.blockMessage({ kind }, { filePath: constancias[0], via: `Bash: ${String(cmd).replace(/\s+/g, ' ').slice(0, 120)}` }) + '\n' };
  }
  // un guion guardado en un archivo (`python3 p.py`, `node p.js <historia>`): lo que escribe se mira como si llegara por
  // la entrada. La constancia frena sin interruptor; la historia, con el freno de historias prendido
  {
    for (const g of guionesEnArchivo(cmd, [...new Set([cwd, baseCwd])], installedRoots)) {
      const via = `Bash: ${String(cmd).replace(/\s+/g, ' ').slice(0, 100)} (el guion ${path.basename(g.archivo)})`;
      // uno muy grande no se lee entero: si escribe y nombra una historia o una constancia, frena. Donde corre y donde
      // vive sin historias, la palabra suelta no cuenta: sí la ruta de una historia y la constancia
      if (g.grande) {
        const nombra = () => (repoConHistorias(cwd) || repoConHistorias(path.dirname(g.archivo)) ? MENCIONA_HISTORIA : NOMBRA_RUTA_DE_HISTORIA).test(g.texto);
        if (!g.texto || ((GUION_ESCRIBE.test(g.texto) || algunOpenEscribe(g.texto)) && nombra())) {
          return { block: `⛔ tycon-pipeline — GUION QUE NO SE PUEDE LEER ENTERO\n\n  ${g.archivo}\n  (detectado en ${via})\n  Es demasiado grande para ver qué escribe, y nombra una historia o una constancia. Una historia se edita con\n  la herramienta de edición (Edit/Write); una constancia la firma una persona.\n` };
        }
        continue;
      }
      const escritos = escritosDelGuion(g);
      const resolver = (t) => resolveTarget(t, cwd, process.platform, { homeVariable: true });
      // un destino que arma de un modo que no se lee (`argparse`, un desempaquetado) puede ser cualquier argumento
      const abs = [...escritos.rutas, ...(escritos.armadosSinSaber ? g.argv : [])].map(resolver);
      const constancia = abs.find((p) => signedRecordKind(p) !== null || signedRecordKind(installedTree.realPath(p) || p) !== null);
      if (constancia) {
        const sg = require('./lib/story-gate.js');
        return { block: sg.blockMessage({ kind: sg.signedRecordKind(constancia) || 'control-approvals' }, { filePath: constancia, via }) + '\n' };
      }
      if (skillOff) continue;
      // una historia entre los argumentos cuenta como escrita: lo que el guion hace con ella no se termina de ver desde acá
      // (un modo en una variable, en el lugar, un programa que lanza). También pegada a una opción (`--file=<historia>`,
      // `file:<historia>`, `-o<historia>`), con variables, llaves y comodines del shell, y por un enlace, aunque no
      // termine en `.md`; un comodín que puede traer una historia y tiene más archivos de los que se miran, frena
      let recortado = false;
      const argumentos = g.argv.flatMap((a) => {
        const v = String(a);
        const formas = [v, v.replace(/^[^=:]*[=:]/, '')];
        if (/^-[A-Za-z]./.test(v)) formas.push(v.slice(2));
        return [...new Set(formas)];
      }).flatMap((v) => {
        // `$PWD` es la carpeta desde donde corre el comando
        const valor = String(expandirRuta(cmd, v.replace(/^\$\{?PWD\}?(?=[\\/]|$)/, cwd)).valor ?? v);
        return expandirLlaves(valor).flatMap((x) => {
          if (!/[*?[]/.test(x)) return [x];
          const aviso = {};
          const halladas = expandirComodin(x, cwd, aviso);
          if (aviso.recortado && !/\.(?!md$)[A-Za-z0-9]+$/i.test(x)) recortado = true;
          return halladas;
        });
      });
      const esHistoria = (p) => {
        const real = installedTree.realPath(p) || p;
        let st;
        try { st = fs.statSync(real); } catch { return false; }
        // un archivo grande que no termina en `.md` no se abre para ver si es una historia
        if (!st.isFile() || (st.size > 1024 * 1024 && !/\.md$/i.test(p) && !/\.md$/i.test(real))) return false;
        return estadoDeHistoria(real) !== null;
      };
      const historias = [...new Set([...abs, ...argumentos.map(resolver)])].filter(esHistoria);
      if (recortado) historias.push('(un comodín entre los argumentos con más archivos de los que se miran)');
      if (historias.length) {
        const recibe = historias.some((h) => !abs.includes(h)) ? ' — recibe la historia por argumento: para leerla, la herramienta de lectura' : '';
        return { block: require('./lib/story-gate.js').storyByConsoleMessage(historias, via + recibe) + '\n' };
      }
    }
  }
  if (!laneOff) {
    // los marcadores de la ejecución, de esta sesión o de otra, con la ejecución abierta o no
    const tocados = marcadoresTocados(cmd, cwd, stateDir);
    if (tocados.length) {
      return { block: require('./lib/story-gate.js').markerDeleteMessage(tocados, `Bash: ${String(cmd).replace(/\s+/g, ' ').slice(0, 120)}`) + '\n' };
    }
    const r = frenoBorrarYArmados({
      cmd, cwd, stateDir, sessionId: resolveSessionId(event?.session_id), io, isInside,
      via: `Bash: ${String(cmd).replace(/\s+/g, ' ').slice(0, 120)}`,
      codex: require('./lib/story-skill-gate-io.js').isCodexEvent(event),
    });
    if (r) return r;
    // lo que otro programa escribe en el estado: el portón de carril sólo ve lo escrito a la vista
    const alEstado = estadoPorOtroPrograma(cmd, cwd, baseCwd, (abs) => isInside(stateDir, abs) || isInside(stateReal, installedTree.realPath(abs)));
    if (alEstado) {
      return { block: require('./lib/story-gate.js').blockMessage({ kind: 'state-dir' }, { filePath: alEstado, via: `Bash: ${String(cmd).replace(/\s+/g, ' ').slice(0, 120)} (lo corre otro programa)` }) + '\n' };
    }
  }
  // un `$(date …)` en el nombre de un informe se lee como un comodín: el destino entero, ya no «sin
  // resolver». La carpeta que se sabe no puede tocar el estado del pipeline ni el árbol instalado
  // desde cada carpeta donde puede estar parado el comando (`cd a || cd b`, dos `cd` seguidos), y siguiendo los enlaces
  // simbólicos que el comodín puede nombrar
  const basesPosibles = [...new Set([cwd, baseCwd, ...carpetas])];
  const sub = subcomandosComoComodin(cmd, (conocida, glob) => {
    // una variable que no se resuelve deja la carpeta sin saber: frena como hoy
    const ex = expandirRuta(cmd, conocida);
    if (ex.sinResolver.length) return false;
    const exGlob = expandirRuta(cmd, glob);
    if (exGlob.sinResolver.length) return false;
    const zonas = [stateDir, stateReal, ...installedRoots, ...installedRoots.map((r) => installedTree.realPath(r))];
    const toca = (p) => { const real = installedTree.realPath(p); return zonas.some((z) => isInside(z, p) || isInside(z, real) || isInside(p, z) || isInside(real, z)); };
    for (const base of basesPosibles) {
      if (toca(resolveTarget(ex.valor, base, process.platform, { homeVariable: true }))) return false;
      // lo que el comodín nombra en el disco, carpeta por carpeta (un enlace que da al estado); con un tramo recortado
      // no se sabe si quedó uno afuera
      const partes = exGlob.valor.split('/');
      for (let i = partes.findIndex((s) => s.includes('*')); i >= 0 && i < partes.length; i++) {
        const aviso = {};
        for (const p of expandirComodin(partes.slice(0, i + 1).join('/') || '.', base, aviso)) if (toca(p)) return false;
        if (aviso.recortado) return false;
      }
    }
    return true;
  });
  const cmdDestinos = sub.cmd;
  const targets = extractWriteTargets(cmdDestinos, { keep });
  if (!skillOff) {
    // una historia que existe y no está en borrador no se escribe por consola (con o sin ejecución abierta)
    const historias = historiasPorConsola(cmd, cwd, targets, baseCwd, sub.destinos, 0, installedRoots);
    if (historias.length) {
      return { block: require('./lib/story-gate.js').storyByConsoleMessage(historias, `Bash: ${String(cmd).replace(/\s+/g, ' ').slice(0, 120)}`) + '\n' };
    }
  }
  // Lo que un guion escribe a un destino armado (`p = 'src/x.js'` y después `open(p, 'w')`): la ruta que se lee de su
  // asignación o de sus argumentos es un destino más. La que no se lee se juzga abajo, como código en la carpeta donde
  // corre, cuando no hay carril ni ejecución abiertos. Sin esto, sin carril, sólo frenaban las rutas escritas a la vista.
  const armadosAbs = [];
  const armadosSinLeer = [];
  for (const a of destinosArmados(cmd)) {
    const lits = a.literal ? [a.literal] : (a.literales || []);
    if (lits.length) {
      for (const l of lits) {
        const ex = expandirRuta(cmd, l);
        // con una variable que no se resuelve (`"$F"` sin definir) la ruta no se lee: puede ser cualquier archivo
        if (ex.sinResolver.length) armadosSinLeer.push(l);
        else armadosAbs.push(resolveTarget(ex.valor, cwd, process.platform, { homeVariable: true }));
      }
      continue;
    }
    if (a.ext && !isCodeFile(`x${a.ext}`) && !isManifestFile(a.cola)) continue;
    armadosSinLeer.push(a.expr);
  }
  if (!targets.length && !armadosAbs.length && !armadosSinLeer.length) return null;

  const sessionId = resolveSessionId(event?.session_id);
  // Con las variables del comando (y del ambiente) expandidas; lo no resuelto queda anotado para el mensaje
  const resueltos = destinosResueltos(cmdDestinos, cwd, process.platform, { keep });
  const absTargets = [...new Set([...resueltos.map((d) => d.abs), ...armadosAbs])];
  // un comodín en el destino (`>> /p/est?do/x`, `{a,b}`, `**` y `(a|b)` de zsh): el shell lo expande y puede nombrar un
  // archivo del estado o del árbol instalado. Sin mirar el disco: si el comodín puede llegar adentro de una zona, frena
  for (const abs of [...absTargets]) {
    const zona = zonaQueAlcanzaElComodin(abs);
    if (zona && !absTargets.includes(path.join(zona, 'comodin'))) absTargets.push(path.join(zona, 'comodin'));
  }
  const sinResolverDe = new Map(resueltos.filter((d) => d.sinResolver.length).map((d) => [d.abs, d]));
  // los destinos relativos, si el comando cambia de carpeta con un `cd` (o `pushd`/`popd`) que no es el que se sigue: el
  // del principio, o el de la forma mínima de `resolverCd`. Ahí la carpeta de esos destinos no se sabe
  const relativosConCdSinSeguir = new Map();
  try {
    const sinCuerpos = String(cmdDestinos).replace(/'[^']*'|"[^"]*"/g, '""');
    if (/(^|[^\w./-])(?:cd|pushd|popd)(?=[\s;&|)]|$)/.test(sinCuerpos)) {
      const forma = resolverCd(cmdDestinos, nativePath(event?.cwd || process.cwd()));
      const seguido = forma.forma === 'minima' || (forma.forma === 'hoy' && leadingCd(cmdDestinos) && !/(^|[^\w./-])(?:pushd|popd)(?=[\s;&|)]|$)/.test(sinCuerpos));
      if (!seguido) {
        for (const d of resueltos) {
          const v = String(expandirRuta(cmdDestinos, d.raw).valor);
          if (!path.isAbsolute(v) && !/^~/.test(v) && !/^[A-Za-z]:[\\/]/.test(v)) relativosConCdSinSeguir.set(d.abs, d);
        }
      }
    }
  } catch (e) { logHookError(e); }
  // Antes de decidir y aunque los frenos estén apagados: dónde escribió la consola es un dato de la
  // corrida, no una decisión del freno.
  anotarEscriturasConsola(stateDir, sessionId, absTargets);
  if (laneOff && skillOff) return null;
  const via = `Bash: ${String(cmd).replace(/\s+/g, ' ').slice(0, 120)}`;

  // ── Portón de CARRIL (código + estado del pipeline) ──────────────────────────────────────────
  if (!laneOff) {
    const passedCode = [];
    // un carril delegado no escribe una ruta de riesgo alto aunque no sea código (`.tycon/production.json`): sus
    // destinos ya leídos van todos al portón, que decide
    // (y un carril con lista no deja escribir lo que no nombra, sea código o no: también van todos)
    let delegado = false;
    let conLista = false;
    try {
      const a = io.readAdhoc(stateDir, sessionId);
      delegado = !!(a && (a.via === 'delegacion' || Array.isArray(a.allowedFiles)));
      conLista = !!(a && Array.isArray(a.allowedFiles));
    } catch (e) { logHookError(e); }
    // un destino armado que no se lee puede ser cualquier archivo: se le pregunta al portón como si fuera código de la
    // carpeta donde corre, y frena lo que no tiene carril y la ejecución a la que le falta una pieza (no dependen del
    // archivo). Con un carril o una ejecución sana pasa: no se sabe qué archivo es, y no se gasta el cupo con uno inventado
    if (armadosSinLeer.length) {
      const r = io.evaluate({ filePath: path.join(cwd, 'destino-armado.js'), sessionId, cwd, stateDir, installedRoots,
        via: `${via} (un guion escribe a una ruta que no se puede leer: ${armadosSinLeer.map((x) => String(x).slice(0, 60)).join(', ')})` });
      if (r.verdict.action === 'block' && (r.verdict.kind === 'no-lane' || r.verdict.kind === 'ejecucion-perdida')) return { block: r.message + '\n' };
    }
    for (const abs of absTargets) {
      // un destino con una variable sin resolver PUEDE ser código aunque su ruta cruda no tenga la extensión
      // (`cat > $F`, `src/x.$EXT`): para el registro cuenta como código
      // …salvo que la extensión ESCRITA (sin variables) diga que no es código: `$OUT/notes.md` pasa como cualquier .md
      const extLiteral = /\.([^./\\$`{}]+)$/.exec(path.basename(abs));
      // un manifiesto o su lock: para el registro es código; para el carril, no
      const quizasCodigo = isCodeFile(abs) || isManifestFile(abs) || (sinResolverDe.has(abs) && !extLiteral);
      const enProtegido = protegido(abs);
      if (!quizasCodigo && !enProtegido && !delegado) continue;
      if (isCodeFile(abs) || enProtegido || delegado) {
        const r = io.evaluate({ filePath: abs, sessionId, cwd, via, stateDir, installedRoots });
        // un destino con una variable sin resolver no es un archivo del repo que se sepa (`$P/probe.js`, con
        // P=$(mktemp -d)): no gasta el cupo del carril. El tope lo vuelve a medir el freno de guardar, con git
        const sinCupo = r.verdict.kind === 'adhoc-cap' && sinResolverDe.has(abs);
        // con lista, una ruta que no se resolvió no se juzga por su texto: `<repo>/$D/x` no es ningún archivo, y una
        // variable con `..` o con una ruta entera lleva a cualquiera (`/tmp/$F` con F=../<repo>/src/x.js), aunque el
        // portón dejaría pasar el texto (la lista nombra `$D/x`, parece papeleo, cae en la carpeta temporal). Frena
        // diciendo eso, en vez de «fuera de la lista». Pasa sólo lo que no lleva barras (`$$`, `$!`): con eso la
        // carpeta se sabe, y el portón ya juzgó el archivo
        // con lista, un destino relativo de un comando que cambia de carpeta con un `cd` que el freno no sigue (adentro de
        // un paréntesis, de un bucle, después de otro comando): no se sabe en qué carpeta cae, y frena diciendo eso
        if (conLista && relativosConCdSinSeguir.has(abs)) {
          try { io.appendLog(stateDir, 'gates.log', sessionId, { name: 'story-gate', status: 'blocked', kind: 'adhoc-path-unresolved', file: abs, via }); } catch (e) { logHookError(e); }
          return { block: mensajeCarpetaSinSeguir(relativosConCdSinSeguir.get(abs), via) };
        }
        const rutaSinResolver = conLista && sinResolverDe.get(abs);
        // (con `$$` y además una variable con nombre, `$D/x$$`, el portón juzgó el texto `$D/…`, no la ruta: tampoco pasa)
        const soloSinBarras = sinBarras(rutaSinResolver ? rutaSinResolver.sinResolver : []) && !/\$\{?[A-Za-z_]/.test(rutaSinResolver.raw);
        if (rutaSinResolver && !soloSinBarras && (r.verdict.action !== 'block' || r.verdict.kind === 'adhoc-out-of-list')) {
          if (r.verdict.action !== 'block') {
            try { io.appendLog(stateDir, 'gates.log', sessionId, { name: 'story-gate', status: 'blocked', kind: 'adhoc-path-unresolved', file: abs, via }); } catch (e) { logHookError(e); }
          }
          return { block: mensajeRutaSinResolver(rutaSinResolver, via) };
        }
        if (r.verdict.action === 'block' && !sinCupo) return { block: r.message + '\n' };
      }
      if (quizasCodigo) passedCode.push(abs);
    }
    // ── TERCERA RESPONSABILIDAD: que el REGISTRO no se quede ciego ────────────────
    // El carril ya dijo que esta sesión PUEDE editar. Falta la otra mitad: si la edición va por
    // Bash con el pipeline abierto, el hook PostToolUse Edit|Write no la ve y `smart-reloop` se
    // queda sin delta (corren 7 revisores en vez de 2-3). Es el conflicto que declara la cabecera de este
    // archivo —"en auto mode el propio arnés INSTRUYE editar con sed/heredocs"— resuelto para el carril y
    // no para el registro. Se frena la edición invisible en vez de enseñarle al arnés a adivinarla.
    if (passedCode.length) {
      const lv = require('./lib/ledger-visible.js');
      const marker = io.readMarker(stateDir, sessionId);
      const vis = lv.evaluarVisibilidad({
        marker,
        codeTargets: passedCode,
        // un destino con una variable sin resolver PUEDE caer en el repo: cuenta como adentro, aunque la ruta cruda
        // anclada al cwd quede afuera (con la sesión parada en otra carpeta, pasaría callado). Por ruta real también: la
        // sesión puede llegar al repo por un enlace y el marcador guarda la ruta real (o al revés)
        dentroDelRepo: (f, repo) => isInside(repo, f) || isInside(installedTree.realPath(repo), installedTree.realPath(f)) || sinResolverDe.has(f),
        off: process.env.TYCON_LEDGER_VISIBLE,
      });
      if (vis.escaped && vis.escaped.length) {
        // El escape del dev deja su línea: el mensaje del freno lo promete, y la línea se escribe.
        try {
          fs.appendFileSync(path.join(stateDir, 'gates.log'), JSON.stringify({
            ts: new Date().toISOString(), sessionId,
            repoPath: (marker && marker.repoPath) || null, name: 'ledger-visible', status: 'escaped',
            storyId: (marker && marker.storyId) || null, files: vis.escaped.length, paths: vis.escaped, via,
            reason: 'TYCON_LEDGER_VISIBLE=off en el ambiente de la sesión',
          }) + '\n', 'utf8');
        } catch (e) { logHookError(e); }
      }
      if (vis.block) {
        try {
          // Constancia en gates.log (misma forma que el resto). El freno NO depende de esto: si el
          // log falla, igual se frena — al revés sería un control que se apaga solo.
          fs.appendFileSync(path.join(stateDir, 'gates.log'), JSON.stringify({
            ts: new Date().toISOString(), sessionId,
            repoPath: (marker && marker.repoPath) || null, name: 'ledger-visible', status: 'blocked',
            storyId: (marker && marker.storyId) || null, files: vis.files.length, via,
          }) + '\n', 'utf8');
        } catch (e) { logHookError(e); /* el freno no depende del log */ }
        const sinResolver = vis.files.filter((f) => sinResolverDe.has(f))
          .map((f) => ({ file: f, vars: sinResolverDe.get(f).sinResolver }));
        return { block: lv.mensaje(vis.files, marker && marker.storyId, { sinResolver, codex: require('./lib/story-skill-gate-io.js').isCodexEvent(event) }) + '\n' };
      }
      // Un destino sin resolver que pasa (sin corrida abierta, o con el escape) no queda callado: constancia en
      // gates.log con la ruta. No suma al cupo ad-hoc: no se sabe qué archivo es.
      const dudosos = passedCode.filter((f) => sinResolverDe.has(f));
      if (dudosos.length) {
        try {
          fs.appendFileSync(path.join(stateDir, 'gates.log'), JSON.stringify({
            ts: new Date().toISOString(), sessionId,
            repoPath: (marker && marker.repoPath) || null, name: 'ledger-visible', status: 'unresolved-passed',
            storyId: (marker && marker.storyId) || null, files: dudosos.length, paths: dudosos, via,
            reason: vis.reason || 'destino con una variable sin resolver',
          }) + '\n', 'utf8');
        } catch (e) { logHookError(e); }
      }
    }

    // Cupo ad-hoc: Bash no tiene PostToolUse nuestro, así que el registro va acá (best-effort: el
    // comando puede fallar después, pero sin esto un hotfix hecho con heredocs nunca suma al cupo).
    // La sonda de un agente del pase no es del carril, por la consola igual que con la herramienta de edición. No se
    // exime lo que el freno no puede ver hasta el final: un destino con una variable sin resolver, un comando que crea
    // enlaces (el destino puede pasar por uno que todavía no existe) o una ruta con `..` (después de un enlace cae en
    // otra carpeta que la que queda al normalizarla). Ante cualquier falla del criterio, se anota.
    const textoDestinos = String(cmdDestinos);
    const noSeVe = /(^|[\s;&|(])ln\s[^;&|]*-[a-zA-Z]*s/.test(textoDestinos) || /(^|[\s/'"=])\.\.([\\/]|$)/.test(textoDestinos);
    // un destino sin resolver no suma al cupo: no se sabe cuál es. Uno en una carpeta de `mktemp` tampoco: su nombre
    // lleva las `X` del molde, no es un archivo que exista
    const temporales = new Set(resueltos.filter((d) => d.temporal).map((d) => d.abs));
    for (const abs of passedCode.filter((f) => isCodeFile(f) && !sinResolverDe.has(f) && !temporales.has(f))) {
      let sonda = false;
      if (!noSeVe) {
        try { sonda = require('./on-edit.js').esSondaDeSubagente(event, abs, sessionId, stateDir); } catch (e) { logHookError(e); }
      }
      if (sonda) continue;
      try { io.recordAdhocFile(stateDir, sessionId, abs); } catch (e) { logHookError(e); }
    }
  }

  // ── Freno de STORY A MANO — la puerta Bash ─────────────────────────────────────
  if (!skillOff) {
    const mdNew = absTargets.filter((abs) => /\.md$/i.test(abs) && !fs.existsSync(abs));
    // una historia que existe y está en borrador: escribirle encima desde acá puede pasarla a ready-for-dev sin el validador
    const mdDraft = absTargets.filter((abs) => /\.md$/i.test(abs) && fs.existsSync(abs));
    if (mdDraft.length) {
      const sio = require('./lib/story-skill-gate-io.js');
      const hds = heredocs(cmdDestinos);
      const sameFile = (a, b) => String(a).replace(/\\/g, '/').toLowerCase() === String(b).replace(/\\/g, '/').toLowerCase();
      const resolveT = (t) => { const d = resueltos.find((x) => x.raw === t); return d ? d.abs : resolveTarget(t, cwd); };
      for (const abs of mdDraft) {
        // con varios cuerpos para el archivo (dos heredocs en un renglón, dos lecturas), frena si cualquiera frena
        const propios = cuerposDistintos(hds.filter((h) => h.target && sameFile(resolveT(h.target), abs)));
        for (const own of propios.length ? propios : [null]) {
          // con `>>` el cuerpo del heredoc no es el archivo entero: no se sabe qué estado queda
          const r = sio.evaluate({ absPath: abs, content: own && !/>>/.test(cmd) ? own.body : null, sessionId, via, event, stateDir });
          if (r.verdict.action === 'block') return { block: r.message + '\n' };
        }
      }
    }
    if (mdNew.length) {
      const sio = require('./lib/story-skill-gate-io.js');
      let declares = (t) => /^---[\s\S]*?^[ \t]*story[ \t]*:/m.test(t);
      try { ({ declaresStoryIdentity: declares } = require('./lib/story-discovery.js')); } catch (e) { logHookError(e); /* fallback regex */ }
      const hds = heredocs(cmdDestinos);
      const sameFile = (a, b) => String(a).replace(/\\/g, '/').toLowerCase() === String(b).replace(/\\/g, '/').toLowerCase();
      // el mismo destino que se juzgó arriba, con las variables del comando expandidas
      const resolveT = (t) => { const d = resueltos.find((x) => x.raw === t); return d ? d.abs : resolveTarget(t, cwd); };
      // Un cuerpo sin target atribuible sólo se usa si el comando escribe UN solo .md nuevo.
      const orphanBody = hds.filter((h) => !h.target && declares(h.body)).map((h) => h.body)[0] || null;
      const inline = hds.length ? null : inlineStoryText(cmd, declares);
      const renamedStory = renameOrCopyOfExistingStory(cmd, cwd);
      for (const abs of mdNew) {
        // con varios cuerpos para el archivo (dos heredocs en un renglón, dos lecturas), frena si cualquiera frena
        const propios = cuerposDistintos(hds.filter((h) => h.target && sameFile(resolveT(h.target), abs)));
        for (const own of propios.length ? propios : [null]) {
          let content = own ? own.body : null;
          if (!content && !own && mdNew.length === 1) content = orphanBody || inline;
          // `mv`/`cp` desde una story EXISTENTE: es renombrar/duplicar, no crear. Pasa y queda medido.
          if (!content && renamedStory && sameFile(renamedStory.dest, abs)) {
            sio.logUnknown({ absPath: abs, sessionId, via, stateDir, kind: 'unknown-rename', reason: `renombrado/copia de una story existente (${path.basename(renamedStory.src)})` });
            continue;
          }
          const r = sio.evaluate({
            absPath: abs, content, nameHint: !content && nameSuggestsStory(abs),
            sessionId, via, event, stateDir,
          });
          if (r.verdict.action === 'block') return { block: r.message + '\n' };
        }
      }
    }
  }
  return null;
}

// cargado entero: de acá en más, una falla sin prever va por la red de fallas
cargado = true;
module.exports = { handle, programasPorEntrada, sinComentarioAlFinal, sinCierre, blancoPorRedireccion, splitSegments, SHELL_CON_C, BORRA_O_MUEVE, guionesEnArchivo, carpetasQueBorraOMueve, borraEjecucionAbierta, corredoresDeLaOrganizacion, anotarBorradosDeLaStory, resolveTarget, cwdDelComando, destinosResueltos, extractWriteTargets, destinosArmados, destinosBorrados, stripNonCommandText, leadingCd, heredocs, heredocBodies, inlineStoryText, nameSuggestsStory, renameOrCopyOfExistingStory, PIPELINE_LISTA, frenaLaRed, quitarCuerposDeHeredoc, vaAUnShell, comandosAnidados, comandosPorOtroPrograma };

if (require.main === module) {
  const cruda = leerEntrada();
  let event = null;
  try { event = JSON.parse(cruda || 'null'); } catch (e) { salirPorLaRed(e, textoDeUnaEntradaRota(cruda)); }
  let r = null;
  try { r = handle(event || {}); } catch (e) { salirPorLaRed(e, event && event.tool_input && event.tool_input.command); }
  // decidió, pero con una pieza rota que un control pidió dentro de su propia red, o con un archivo que no es el instalado
  const rota = piezaRota || archivoQueNoEsElInstalado();
  if (rota) salirSinCargar(rota);
  if (r && r.block) {
    try { process.stderr.write(r.block); } catch { /* sin dónde decirlo, frena igual */ }
    process.exit(2);
  }
  yaDecidio = true;
  paso('armando los avisos para la persona');
  // Antes de cerrar «Aprobar el plan», el arnés le muestra a la persona el plan si el agente no lo hizo (lib/plan-display.js) y,
  // si la historia cambia una pantalla en un repo sin prueba con navegador, la oferta de prepararla (lib/browser-test.js).
  // Van en un solo aviso.
  const avisos = [];
  // el código deprecado que se escribe por la terminal con `deprecated.edit: warn`
  if (r && r.aviso) avisos.push({ systemMessage: r.aviso, anotar() {} });
  const pedido = {
    command: event && event.tool_input && event.tool_input.command,
    sessionId: resolveSessionId(event && event.session_id), stateDir: require('./lib/story-gate-io.js').DEFAULT_STATE_DIR,
  };
  try { const pd = require('./lib/plan-display.js').planParaMostrar(pedido); if (pd) avisos.push(pd); } catch (e) { logHookError(e); process.stderr.write(`⚠️  no pude armar el plan para mostrarlo (${e.message})\n`); }
  // antes de eximir un crítico, el arnés se lo muestra a la persona: el ok vale si responde a eso (lib/critical-display.js)
  try { const cd = require('./lib/critical-display.js').paraMostrar(pedido); if (cd) avisos.push(cd); } catch (e) { logHookError(e); process.stderr.write(`⚠️  no pude armar el crítico para mostrarlo (${e.message})\n`); }
  // antes de marcar criterios como probados a mano, el arnés le muestra a la persona cuáles (lib/manual-checks.js)
  try { const mc = require('./lib/manual-checks.js').paraMostrar(pedido); if (mc) avisos.push(mc); } catch (e) { logHookError(e); process.stderr.write(`⚠️  no pude armar los criterios para mostrarlos (${e.message})\n`); }
  // antes de firmar un criterio que no se puede probar en vivo, el arnés se lo muestra a la persona (lib/waiver-display.js)
  try { const wd = require('./lib/waiver-display.js').paraMostrar(pedido); if (wd) avisos.push(wd); } catch (e) { logHookError(e); process.stderr.write(`⚠️  no pude armar el criterio para mostrarlo (${e.message})\n`); }
  try { const of = require('./lib/browser-test.js').offerToShow(pedido); if (of) avisos.push(of); } catch (e) { logHookError(e); process.stderr.write(`⚠️  no pude decidir si va la oferta de la prueba con navegador (${e.message})\n`); }
  if (avisos.length) {
    process.stdout.write(JSON.stringify({ systemMessage: avisos.map((a) => a.systemMessage).join('\n\n') }));
    for (const a of avisos) { try { a.anotar(); } catch (e) { logHookError(e); } }
  }
  process.exit(0);
}
