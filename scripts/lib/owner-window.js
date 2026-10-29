'use strict';
/**
 * owner-window.js — las firmas del dueño se dan en la ventana de permiso de la herramienta.
 *
 * Dos lados de un mismo módulo:
 *
 *   El freno (`decidir`, y `gate` por consola): ante un comando que pide una firma del catálogo (signatures.js), niega
 *   o pide la ventana («ask»). Para una firma `guion` escribe antes un registro del pedido; una firma `freno` (un escape)
 *   pide la ventana sin registro, porque el «Sí» corre el comando y no hay guion que lo consuma.
 *
 *   El guion (`verificar`, `exigir`, y `verify` por consola): el guion de la firma comprueba en el árbol de procesos que
 *   lo lanzó la consola de la herramienta con el comando exacto de un registro vigente, y lo consume una sola vez. Sin
 *   eso no firma: la persona lo firma en su terminal (`porTerminal`).
 *
 * El registro vive en `owner-window/`, dentro de la carpeta del estado de la casa de la cuenta, un archivo por (firma, sesión
 * destino, sesión del pedido). La casa sale de real-home.js: `HOME`, `USERPROFILE` y `TYCON_HOME` no la cambian.
 *
 * Las firmas sobre un archivo (`marker.js sign-file <firma> <archivo>`, FIRMAS_DE_ARCHIVO de signatures.js) son un
 * guion más; con la firma dada, el guion deja una constancia en `owner-window/files/` (`firmarArchivo`) que el Edit o
 * Write siguiente de esa sesión sobre ese archivo consume (`consumirArchivo`), dentro de los mismos 30 minutos.
 *
 * La envoltura de la consola es la medida en la Mac (`zsh -c source <foto del ambiente> … && eval '<comando>' <
 * /dev/null && pwd -P >| /tmp/claude-…-cwd`). Una que no coincide, un árbol que no se lee (Windows) o una herramienta
 * lanzada por otra herramienta o por su consola se niegan: lo indecidible se firma en la terminal. Lo que no ve: una
 * herramienta abierta por el agente dentro de `tmux`, cuyo servidor no tiene padre (límite declarado en la guía).
 *
 * El árbol, el evento, la casa y la hora se pasan como parámetros en las pruebas; nada se finge por el ambiente.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { SIGNATURES, FIRMAS_DE_ARCHIVO } = require('./signatures.js');
const { casaDeLaCuenta } = require('./real-home.js');

const LIB = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib');
const markerCommand = () => require(path.join(LIB, 'marker-command.js'));
const stateDir = (casa) => require(path.join(LIB, 'state-dir.js')).stateDir(casa);

const VENCE_MIN = 30;
const SESION = /^[\w-]+$/;
// el nombre con que los guiones dicen «sin variable de sesión»: no es una sesión a la que pedirle una firma
const SIN_SESION = '_nosession';
const NO_ES_SESION = '«_nosession» es el nombre de «sin sesión», no una sesión: la firma se pide para la sesión destino por su id';
const VARIABLES_DE_SESION = /(^|[^\w])(CLAUDE_CODE_SESSION_ID|TYCON_SESSION_ID|CODEX_SESSION_ID)(?![\w])/;
// los guiones de las firmas `guion`, por su nombre de archivo
const GUIONES = new Set(['marker.js', 'pipeline.js', 'e2e-setup.js', 'run-base-controls.sh']);
const NODES = new Set(['node', 'nodejs']);
const SHS = new Set(['bash', 'sh']);
// las consolas que corren el texto de `-c` como un comando (`grep -c '…'` cuenta renglones: no corre nada)
const CONSOLAS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell', 'pwsh.exe', 'powershell.exe', 'bash.exe']);
// los consumos de las firmas sobre un archivo que dejó pendientes el despachador (dispatch.js)
const CONSUMOS = Symbol.for('tycon.consumos-diferidos');
const REFIRMA = 'refresh-after-main';
const CONTROL = 'control-change';

const firmaDe = (id) => SIGNATURES.find((s) => s.id === id) || null;
const base = (w) => String(w || '').split(/[\\/]/).pop().toLowerCase();
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const una = (s, n = 300) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** La carpeta del registro de la ventana en esa casa. */
function carpeta(casa) { return path.join(stateDir(casa), 'owner-window'); }

// --- el árbol de procesos ------------------------------------------------------------------------------------------

/**
 * Los procesos de la máquina como `{ pid, ppid, inicio, comando, ejecutable? }`, o null si no se pueden leer (Windows
 * siempre). `ps` corre con un idioma fijo: la fecha en inglés (la que se lee acá) y los acentos tal cual (sin UTF-8,
 * el `ps` de la Mac los escribe en otra notación y el comando ya no es el que se pidió). El ejecutable sale de otra
 * lectura porque su ruta puede tener espacios; sin ella, se lee de la línea.
 */
function leerArbol({ spawnSync = require('child_process').spawnSync, plataforma = process.platform } = {}) {
  if (plataforma === 'win32') return null;
  const o = { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C.UTF-8' } };
  let r;
  try { r = spawnSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,lstart=,command='], o); } catch (_) { return null; }
  if (!r || r.error || r.status !== 0 || !r.stdout) return null;
  const ejecutables = new Map();
  try {
    const c = spawnSync('ps', ['-A', '-ww', '-o', 'pid=,comm='], o);
    if (c && !c.error && c.status === 0 && c.stdout) {
      for (const l of c.stdout.split('\n')) { const m = /^\s*(\d+)\s(.+)$/.exec(l); if (m) ejecutables.set(Number(m[1]), m[2].trim()); }
    }
  } catch (_) { /* sin la segunda lectura, el ejecutable se lee de la línea */ }
  const fuera = [];
  for (const l of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.*)$/.exec(l);
    if (m) fuera.push({ pid: Number(m[1]), ppid: Number(m[2]), inicio: m[3].replace(/\s+/g, ' '), comando: m[4], ...(ejecutables.has(Number(m[1])) ? { ejecutable: ejecutables.get(Number(m[1])) } : {}) });
  }
  return fuera.length ? fuera : null;
}

/**
 * ¿Es el proceso de la herramienta? `claude` (o `node <…>/claude`, el lanzador del paquete), con minúscula: la app de
 * escritorio, `Claude`, no lo es. El ejecutable puede venir aparte (una ruta con espacios, la de la copia de escritorio).
 */
function esHerramienta(p) {
  const linea = String((p && p.comando) || '').trim();
  const exe = p && p.ejecutable ? String(p.ejecutable) : '';
  const w = linea.split(/\s+/);
  let nombre = w[0];
  let resto = w.slice(1);
  if (exe && linea.startsWith(exe)) { nombre = exe; resto = linea.slice(exe.length).trim().split(/\s+/); } else if (exe) nombre = exe;
  const crudo = (x) => String(x || '').split(/[\\/]/).pop();
  if (/^claude(\.exe)?$/.test(crudo(nombre))) return true;
  return (NODES.has(base(nombre)) || base(nombre) === 'bun') && (/^claude(\.exe)?$/.test(crudo(resto[0])) || /claude-code[\\/]cli\.(m?js)$/.test(resto[0] || ''));
}

/** ¿La línea de la herramienta trae `-p` o `--print` (sin pantalla)? */
function sinPantalla(p) {
  return String(p.comando).trim().split(/\s+/).slice(1).some((w) => w === '-p' || w === '--print' || w.startsWith('--print='));
}

/**
 * El comando que corre una consola de la herramienta, sacado de su envoltura medida; null si la línea no es esa
 * envoltura (otra casa en la foto del ambiente, otra forma, una comilla suelta adentro). La consola de fondo va sin
 * `< /dev/null`. La consola es la de la persona: zsh o bash, de cualquier carpeta (la del sistema o la de Homebrew).
 */
function desenvolver(linea, casa) {
  const re = new RegExp('^(?:/[\\w.+-]+)*/(?:zsh|bash) -c source ' + escRe(casa)
    + '/\\.claude/shell-snapshots/snapshot-(?:zsh|bash)-[\\w.-]+\\.sh 2>/dev/null \\|\\| true && '
    + '(?:setopt(?: [A-Z_]+)+ 2>/dev/null \\|\\| true && )?'
    + '(?:shopt -u extglob 2>/dev/null \\|\\| true && )?'
    + "(?:\\{(?: \\\\builtin (?:unalias|unset -f) -- '[\\w-]+';)+ \\} >/dev/null 2>&1 \\|\\| true && )?"
    + "eval '([\\s\\S]*)'(?: < /dev/null)? && pwd -P >\\| (?:/private)?/tmp/claude-[0-9a-f]+-cwd$");
  const m = re.exec(String(linea || ''));
  if (!m) return null;
  const partes = m[1].split(`'"'"'`);
  if (partes.some((p) => p.includes("'"))) return null;
  return partes.join("'");
}

function porPid(arbol) { return new Map(arbol.map((p) => [p.pid, p])); }

/** Los padres de `pid`, del más cercano al más lejano (sin el propio). */
function padres(arbol, pid) {
  const m = porPid(arbol);
  const fuera = [];
  const vistos = new Set([pid]);
  let p = m.get(pid);
  while (p && m.has(p.ppid) && !vistos.has(p.ppid)) {
    vistos.add(p.ppid);
    p = m.get(p.ppid);
    fuera.push(p);
  }
  return fuera;
}

// --- qué firmas pide un comando --------------------------------------------------------------------------------------

/**
 * La forma canónica: un solo comando, sin envolturas, variables ni redirecciones, que corre uno de los guiones de
 * firma (`node <ruta>/marker.js …`, `bash <ruta>/run-base-controls.sh …`). Devuelve las palabras desde el guion, o null.
 */
function canonica(comando) {
  let t;
  try { t = markerCommand().tramos(String(comando), 'bash'); } catch (_) { return null; }
  if (t.abierta || t.subs.length || t.tramos.length !== 1 || t.tramos[0].heredocs.length) return null;
  const w = t.tramos[0].palabras;
  if (!w.length || w.some((x) => !x.literal || /^\d*[<>&|]/.test(x.texto) || /[\r\n]/.test(x.texto))) return null;
  const prog = base(w[0].texto);
  let desde = 0;
  if (NODES.has(prog) || SHS.has(prog)) desde = 1;
  const guion = w[desde];
  if (!guion || guion.texto.startsWith('-') || !GUIONES.has(base(guion.texto))) return null;
  const esSh = base(guion.texto).endsWith('.sh');
  if (esSh ? NODES.has(prog) : !NODES.has(prog)) return null;
  return w.slice(desde).map((x) => x.texto);
}

/**
 * La firma `guion` que piden las palabras de un llamado (el guion, el subcomando y sus argumentos), o null. Las palabras
 * llegan como texto, o como las lee marker-command.js (`{ texto, literal }`); un texto con `$` o una comilla invertida
 * cuenta como armado. Con `llamada` (la de marker-command.js), una bandera de pipeline.js se busca con su lector: un
 * argumento armado donde el guion espera un valor no la esconde.
 */
function firmaDeLlamado(guion, sub, args, llamada = null) {
  const pal = args.map((w) => (w && typeof w === 'object' ? { texto: String(w.texto), literal: !!w.literal }
    : { texto: String(w), literal: !/[$`]/.test(String(w)) }));
  const a = pal.map((w) => w.texto);
  // una palabra que no se lee hasta correr (`$F`, una sustitución) puede ser cualquier bandera: cuenta como puesta
  const opaca = pal.some((w) => !w.literal);
  const con = (b) => opaca || a.some((w) => w === b || w.startsWith(`${b}=`));
  if (guion === 'marker.js') {
    const pide = llamada ? markerCommand().lectorDeBanderas(llamada) : con;
    if (sub === 'set-check' && pide('--force-manual')) return 'escape:force-manual';
    // la firma la piden la cita del plan o la de la maqueta, como en marker.js; el plan que se aprueba solo, no
    if (sub === 'complete-step' && ['approve-plan', '3'].includes(String(a[0] || '').trim()) && (con('--approved') || con('--mockup-approved'))) return 'plan-approval';
    if (sub === 'approve-mockup') return 'plan-approval';
    if (sub === 'waive-critical') return 'critical-waiver';
    if (sub === 'mark-tested') return 'manual-test';
    if (sub === 'runtime-waiver') return 'runtime-waiver';
    if (sub === 'sign-adversarial-skip') return 'adversarial-skip';
    if (sub === 'approve-pending') return 'pending-approval';
    if (sub === 'approve-save') return 'save';
    // declarar o cambiar el arreglo rápido; mirarlo o terminarlo, no. El subcomando en una variable cuenta como `set`
    if (sub === 'adhoc' && (a[0] === 'set' || /[$`]/.test(a[0] || ''))) return 'adhoc-lane';
    if (sub === 'restore' || (sub === 'clear-session' && a.includes('--lost'))) return 'lost-run';
    // la firma en una variable puede ser cualquiera de las cuatro: cuenta como una, y la forma canónica la niega
    if (sub === 'sign-file' && (opaca || FIRMAS_DE_ARCHIVO.includes(a[0]))) return `escape:${FIRMAS_DE_ARCHIVO.includes(a[0]) ? a[0] : FIRMAS_DE_ARCHIVO[0]}`;
    return null;
  }
  if (guion === 'pipeline.js') {
    const pide = llamada ? markerCommand().lectorDeBanderas(llamada) : con;
    // un subcomando que no se lee hasta correr puede ser `smart-reloop`
    if (sub == null) return llamada && llamada.dudosa && pide('--extra-round') ? 'extra-round' : null;
    if (sub === 'check-count') return pide('--trust-ran') ? 'escape:trust-ran' : null;
    return ['smart-reloop', 'advisors'].includes(sub) && pide('--extra-round') ? 'extra-round' : null;
  }
  if (guion === 'e2e-setup.js') return ['prepare', 'defer'].includes(sub) ? 'browser-test' : null;
  if (guion === 'run-base-controls.sh') return sub === 'approve' ? 'control-change' : null;
  return null;
}

/** Los llamados a e2e-setup.js y run-base-controls.sh de un comando (los de marker.js los lee marker-command.js). */
function llamadosSueltos(comando, hondo = 0) {
  const fuera = [];
  if (hondo > 3 || !/e2e-setup|run-base-controls/i.test(comando)) return fuera;
  const t = markerCommand().tramos(String(comando), 'bash');
  for (const tr of t.tramos) {
    const w = tr.palabras;
    for (let i = 0; i < w.length; i++) {
      const b = base(w[i].texto);
      if (b === 'e2e-setup.js' || b === 'run-base-controls.sh') {
        const prog = base(w[0].texto);
        if (i === 0 || (i === 1 && (NODES.has(prog) || SHS.has(prog)))) fuera.push({ guion: b, sub: (w[i + 1] && w[i + 1].texto) || null, args: w.slice(i + 2).map((x) => x.texto) });
        break;
      }
      // un texto con espacios es un comando sólo si lo corre una consola (`bash -c '…'`, `eval '…'`); un mensaje
      // (`git commit -m '…'`) que nombra la firma no la pide
      const ant = i > 0 ? w[i - 1].texto : '';
      const consola = w.slice(0, i - 1).some((x) => CONSOLAS.has(base(x.texto)));
      if (/\s/.test(w[i].texto) && ((consola && /^-(?:[a-z]*c[a-z]*|command)$/i.test(ant)) || base(w[0].texto) === 'eval')) fuera.push(...llamadosSueltos(w[i].texto, hondo + 1));
    }
  }
  for (const s of t.subs) fuera.push(...llamadosSueltos(s, hondo + 1));
  return fuera;
}

/**
 * Las firmas `guion` que pide el comando, en cualquier forma (la canónica o una escondida que el freno ve). Si el lector
 * del comando se cae y el comando nombra un guion de firma, la lista vuelve vacía con `ilegible: true`: no se sabe qué
 * pide, y eso se niega.
 */
function firmasDelComando(comando) {
  const ids = [];
  try {
    for (const l of markerCommand().llamadas(String(comando))) {
      const id = firmaDeLlamado(`${l.guion}.js`, l.sub, l.args || [], l);
      if (id) ids.push(id);
    }
    for (const l of llamadosSueltos(comando)) {
      const id = firmaDeLlamado(l.guion, l.sub, l.args);
      if (id) ids.push(id);
    }
  } catch (_) {
    return Object.assign([], { ilegible: [...GUIONES].some((g) => String(comando).includes(g.replace(/\.(js|sh)$/, ''))) });
  }
  return [...new Set(ids)];
}

/** La firma que pide el comando en forma canónica, con sus palabras; null si no la tiene. */
function canonicaDe(comando) {
  const palabras = canonica(comando);
  if (!palabras) return null;
  const id = firmaDeLlamado(base(palabras[0]), palabras[1], palabras.slice(2));
  return id ? { id, palabras } : null;
}

/**
 * La sesión que nombra el comando de `firma` (palabras desde el guion) cuando el guion actúa sobre ella, o null.
 * Sólo `clear-session <sesión> --lost`: cierra la ejecución de esa sesión. `restore <sesión>` rearma esa ejecución en
 * la sesión que corre el comando, que es su destino.
 */
function sesionNombrada(firma, palabras) {
  return firma === 'lost-run' && palabras && palabras[1] === 'clear-session' ? String(palabras[2] || '') : null;
}

/** El valor de `--for-session`, separado o con `=`; null si no está. */
function forSessionDe(palabras) {
  if (!palabras) return null;
  const i = palabras.indexOf('--for-session');
  if (i >= 0) return palabras[i + 1] || '';
  const conIgual = palabras.find((w) => String(w).startsWith('--for-session='));
  return conIgual ? conIgual.slice('--for-session='.length) : null;
}

/**
 * La sesión destino: la que nombra el comando si la firma actúa sobre ella; si no, `--for-session <id>` en el comando
 * canónico, o la del pedido. `--for-session=<id>` no la elige (el guion no lo lee así), sólo tiene que coincidir.
 */
function destinoDe(palabras, sesion, firma) {
  const nombrada = sesionNombrada(firma, palabras);
  if (nombrada !== null) return nombrada;
  const i = palabras ? palabras.indexOf('--for-session') : -1;
  return i >= 0 ? palabras[i + 1] || '' : sesion;
}

/** ¿El escape por variable viene en su forma de siempre (la asignación literal al principio del comando, una vez)? */
function variableALaVista(nombre, valor, comando) {
  let t;
  try { t = markerCommand().tramos(String(comando), 'bash'); } catch (_) { return false; }
  if (!t.tramos.length) return false;
  const w = t.tramos[0].palabras;
  let i = 0;
  let esta = false;
  for (; i < w.length && /^[A-Za-z_]\w*=/.test(w[i].texto); i++) {
    if (!w[i].literal) return false;
    if (w[i].texto === `${nombre}=${valor}`) esta = true;
  }
  if (!esta || i >= w.length) return false;
  const veces = String(comando).match(new RegExp(`(^|[^\\w])${escRe(nombre)}(?![\\w])`, 'g')) || [];
  return veces.length === 1;
}

/** ¿El escape con nombre viene en su forma de siempre (el comando de marker.js o pipeline.js, canónico)? */
function nombreALaVista(comando) {
  const p = canonica(comando);
  return !!p && ['marker.js', 'pipeline.js'].includes(base(p[0]));
}

// --- los textos ---------------------------------------------------------------------------------------------------

function storyDe(casa, destino) {
  let m;
  try { m = marcadorEn(path.join(stateDir(casa), 'active', `${destino}.json`)); } catch (_) { return 'su marcador no se puede leer'; }
  if (!m) return 'sin ejecución abierta';
  return m.storyId || (m.storyPath ? path.basename(m.storyPath) : null) || 'sin story en su ejecución';
}

/** La corrida abierta de la sesión `destino` (`{ storyId, startedAt }`), o null sin marcador: la que vio el dueño. */
function corridaDelMarcador(m) {
  return m && m.storyId ? { storyId: String(m.storyId), startedAt: m.startedAt || null } : null;
}
/**
 * El marcador de una sesión leído de `ruta`: null si no existe; si existe y no se puede leer, lanza (un marcador roto no
 * es «sin ejecución abierta»).
 */
function marcadorEn(ruta) {
  let texto;
  try { texto = fs.readFileSync(ruta, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`no pude leer el marcador ${path.basename(ruta)} (${e.code || e.message})`);
  }
  try { return JSON.parse(texto); } catch (_) { throw new Error(`no pude leer el marcador ${path.basename(ruta)} (no es JSON)`); }
}
// ilegible, la corrida queda anotada como tal: después no coincide con ninguna y la firma no pasa
function corridaDe(casa, destino) {
  try { return corridaDelMarcador(marcadorEn(path.join(stateDir(casa), 'active', `${destino}.json`))); } catch (_) { return { ilegible: true }; }
}

function detalleDe(id, comando, palabras, cwd) {
  if (id === 'plan-approval' && palabras) {
    const i = palabras.findIndex((w) => w === '--approved' || w === '--mockup-approved');
    if (i >= 0 && palabras[i + 1]) return `la cita: «${una(palabras[i + 1], 200)}»`;
  }
  if (id === 'adhoc-lane' && palabras && palabras[1] === 'adhoc' && palabras[2] === 'set') {
    let p = null;
    try { p = JSON.parse(palabras[3] || ''); } catch (_) { /* un JSON roto lo niega el guion: la ventana muestra el comando */ }
    if (p && typeof p === 'object') {
      const cupo = Number.isFinite(Number(p.maxFiles)) && Number(p.maxFiles) > 0 ? `hasta ${Number(p.maxFiles)} archivos` : 'el cupo de siempre (8 archivos, o el que ya tenía)';
      return `el motivo: «${una(String(p.reason || ''), 200)}» · ${cupo}`;
    }
  }
  if (palabras && palabras[1] === 'sign-file' && palabras[3]) {
    // la consola expande la tilde antes de correr el guion: la ventana muestra la ruta que se va a firmar
    const tilde = /^~(?=[\\/]|$)/.test(palabras[3]) ? os.homedir() + palabras[3].slice(1) : palabras[3];
    const real = rutaReal(tilde, cwd);
    return `sobre el archivo ${una(palabras[3], 300)}${real !== palabras[3] ? ` (${una(real, 300)})` : ''}`;
  }
  return `el comando: ${una(comando)}`;
}

/**
 * Los criterios que pide eximir un `runtime-waiver` canónico, para la ventana: cada uno con su texto, por qué no se
 * prueba en vivo y qué lo cubre. Sin `--acs`, todos los pendientes de firma. `{ texto }`, o `{ error }` si no se pueden
 * mostrar: sin ellos el dueño firmaría a ciegas.
 */
function criteriosDelPedido(palabras, cwd, { casa, destino, sesion } = {}) {
  const story = palabras[2] && !palabras[2].startsWith('-') ? palabras[2] : '';
  if (!story) return { error: 'el comando no nombra la historia: sin sus criterios a la vista no se firma' };
  const wd = require(path.join(LIB, 'waiver-display.js'));
  // pedida para otra sesión, la historia es la de la corrida de esa sesión: el guion firma sobre ella, y una ruta
  // relativa se lee desde su repo, como la leen marker.js y la muestra de criterios
  let m = null;
  if (destino && destino !== sesion) {
    try { m = marcadorEn(path.join(stateDir(casa), 'active', `${destino}.json`)); } catch (e) { return { error: e.message }; }
    if (!m) return { error: `la sesión ${destino} no tiene una ejecución abierta` };
  }
  const abs = path.isAbsolute(story) ? story : path.resolve((m && m.repoPath) || cwd || process.cwd(), story);
  if (!fs.existsSync(abs)) return { error: `no encuentro la historia ${una(abs, 200)}: sin sus criterios a la vista no se firma` };
  if (m && !wd.esLaDelMarcador(abs, m)) return { error: `${path.basename(abs)} no es la historia de la ejecución de la sesión ${destino}` };
  const i = palabras.indexOf('--acs');
  const pedidos = i >= 0 ? [...new Set(String(palabras[i + 1] || '').split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0))] : null;
  if (pedidos && !pedidos.length) return { error: '--acs no dice qué criterios: sin ellos a la vista no se firma' };
  let c;
  try {
    c = wd.criteriosDe(abs, pedidos || []);
    if (!c.error && !pedidos) c = wd.criteriosDe(abs, c.matrix.notVerifiable || []);
  } catch (e) { return { error: `no pude armar los criterios (${una((e && e.message) || String(e), 200)})` }; }
  if (c.error) return { error: `no pude armar los criterios: la matriz no computa (${una(c.error, 200)})` };
  const faltan = (pedidos || []).filter((n) => !c.lista.some((x) => x.ac === n));
  if (faltan.length) return { error: `el AC ${faltan.join(', ')} no es un criterio pendiente de firma en ${path.basename(abs)}` };
  if (!c.lista.length) return { error: `${path.basename(abs)} no tiene criterios pendientes de firma` };
  return { texto: `los criterios a eximir: ${c.lista.map((x) => `AC ${x.ac}: ${una(x.text || '(sin texto en la historia)', 300)} · por qué no se prueba en vivo: ${una(x.reason || '(sin razón declarada)', 200)} · lo cubre: ${una(x.coveredBy || '(ninguna prueba declarada)', 100)}`).join(' | ')}` };
}

/** El comando de la terminal; para un guion, con la sesión: en la terminal del dueño no hay variable de sesión. */
function terminalDe(ids, sesion) {
  const t = [...new Set(ids.map((id) => (firmaDe(id) || {}).terminal).filter(Boolean))].join(' · ');
  const guion = ids.some((id) => (firmaDe(id) || {}).kind === 'guion');
  return t && guion && sesion && SESION.test(sesion) ? `${t}, con --for-session ${sesion}` : t;
}
function negarCon(motivo, ids, sesion) {
  const t = terminalDe(ids, sesion);
  return { decision: 'deny', firmas: ids, texto: `${motivo}. Esta firma se da en tu terminal${t ? `: ${t}` : ''}.` };
}

// --- el freno -----------------------------------------------------------------------------------------------------

/**
 * Vence los pedidos sin consumir que pidió `sesion`: cualquier comando suyo que pasa por el freno después de un pedido
 * (el «No» del dueño deja el pedido sin consumir) lo vence antes de correr, así el «Sí» que no se dio no lo firma un
 * guion lanzado desde una consola disfrazada. Devuelve cuántos venció; tira si no puede mover uno.
 */
function vencerPedidos(casa, sesion, ahora = Date.now()) {
  if (!SESION.test(String(sesion || ''))) return 0;
  const dir = carpeta(casa);
  let nombres;
  try { nombres = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return 0; throw e; }
  let n = 0;
  for (const f of nombres) {
    if (!f.endsWith(`--${sesion}.json`)) continue;
    try { fs.renameSync(path.join(dir, f), path.join(dir, `${f}.vencido-${ahora}`)); n++; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return n;
}

function escribirRegistro(casa, reg) {
  const dir = carpeta(casa);
  fs.mkdirSync(dir, { recursive: true });
  const nombre = `${reg.firma.replace(/[^\w-]/g, '_')}--${reg.destino}--${reg.sesion}.json`;
  const destino = path.join(dir, nombre);
  // un pedido igual sin consumir queda vencido: el «Sí» de su ventana ya no firma
  if (fs.existsSync(destino)) fs.renameSync(destino, `${destino}.vencido-${Date.parse(reg.ts)}`);
  const tmp = `${destino}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(reg), { mode: 0o600 });
  fs.renameSync(tmp, destino);
  return destino;
}

/**
 * La clase de un `run-base-controls.sh approve` con `--base` (`{ clase, refirma_de?, motivo }`), con el clasificador del
 * guion de este mismo árbol, corrido en la carpeta del evento. null si no contesta.
 */
function clasificarConElGuion(palabras, cwd) {
  const r = require('child_process').spawnSync('bash', [path.join(__dirname, '..', 'ci', 'run-base-controls.sh'), 'classify', ...palabras.slice(2)],
    { cwd: cwd || process.cwd(), encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0) return null;
  try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch (_) { return null; }
}

/**
 * Lo que decide el freno ante un evento: `{ decision: 'ask' | 'deny' | 'allow' | 'none', texto, firmas, via? }`.
 * `escapes`: las firmas `freno` que el freno de seguridad vio en el comando (los escapes por variable y con nombre).
 * `delegacion(opciones)`: si la firma corre sin ventana (delegated-signing.js, las dos listas del perfil);
 * `clasificar(palabras, cwd)`: la clase de un `approve` con `--base`; `arbol` y `casa` se leen si faltan.
 */
function decidir({ evento = {}, escapes = [], arbol, pid = process.pid, casa, ahora = Date.now(), delegacion, clasificar = clasificarConElGuion, userInfo } = {}) {
  const comando = String((evento.tool_input && evento.tool_input.command) || '');
  const sesion = evento.session_id == null ? '' : String(evento.session_id);
  // la terminal firma para la sesión destino en cuanto se conoce: antes, para la del evento
  let paraTerminal = sesion;
  const negar = (motivo, ids) => negarCon(motivo, ids, paraTerminal);
  const guiones = firmasDelComando(comando);
  const pedidas = [...new Set([...guiones, ...escapes])];
  if (guiones.ilegible) return negar('no se pudo leer el comando, y nombra un guion de firma', pedidas);
  if (!pedidas.length) return { decision: 'none', firmas: [] };
  const desconocida = pedidas.find((id) => { const s = firmaDe(id); return !s || !['guion', 'freno'].includes(s.kind); });
  if (desconocida) return negar(`«${desconocida}» no es una firma que se pida por consola`, pedidas.filter((id) => firmaDe(id)));
  // el Sí del dueño es de un comando de la consola: otra herramienta que corre la misma envoltura (Monitor) usaría el
  // registro de ese pedido sin que nadie lo apruebe
  const herramientaDelEvento = evento.tool_name == null ? 'Bash' : String(evento.tool_name);
  if (!['Bash', 'PowerShell'].includes(herramientaDelEvento)) return negar(`las firmas se piden por la consola de la herramienta, no por ${una(herramientaDelEvento, 40)}`, pedidas);
  if (evento.turn_id) return negar('Codex no tiene ventana de permiso: pedirla deja correr el comando', pedidas);
  // el motivo del arreglo rápido es texto libre y puede nombrar un flag o una variable: en la forma canónica, los dos
  // controles de abajo miran el comando sin ese argumento (un flag o una variable de verdad siguen a la vista)
  const canAdhoc = canonicaDe(comando);
  const mirado = canAdhoc && canAdhoc.id === 'adhoc-lane' && canAdhoc.palabras[1] === 'adhoc' && canAdhoc.palabras[2] === 'set'
    ? canAdhoc.palabras.filter((_, i) => i !== 3).join(' ') : comando;
  if (VARIABLES_DE_SESION.test(mirado)) return negar('la sesión destino va con --for-session, no con una variable de sesión en el comando', pedidas);
  if (!SESION.test(sesion)) return negar('el evento no dice de qué sesión es el pedido', pedidas);
  // el guion niega estas formas sin mirar la ventana: pedirla le haría aprobar al dueño algo que no firma
  if (guiones.length && /(^|\s)--(quote|relayed-by|ok)(\s|=|$)/.test(mirado)) return negar('la cita, el reenvío o el --ok ya no firman: el mismo comando sin --quote, --relayed-by ni --ok', pedidas);
  // la forma: una firma `guion` sólo en su forma canónica; un escape, en su forma de siempre
  const can = canonicaDe(comando);
  const guion = guiones.length ? guiones[0] : null;
  if (guiones.length > 1 || (guion && (!can || can.id !== guion))) {
    const s = firmaDe(guion);
    return negar(`la firma va en su forma exacta, sola, sin \`cd …&&\`, variables ni envolturas (${s.command} …)`, pedidas);
  }
  if (guion && escapes.length) return negar('una firma y un escape en el mismo comando: van por separado', pedidas);
  for (const id of escapes) {
    const nombre = id.slice('escape:'.length);
    const s = firmaDe(id);
    const porVariable = /^[A-Za-z_]\w*=\S+ <comando>$/.test(s.command);
    const aLaVista = porVariable ? variableALaVista(nombre, s.command.split('=')[1].split(' ')[0], comando) : nombreALaVista(comando);
    if (!aLaVista) return negar(`el escape ${nombre} viene escondido (un nombre armado, env, export o una envoltura)`, pedidas);
  }
  if (casa === undefined) {
    try { casa = casaDeLaCuenta(userInfo ? { userInfo } : undefined); } catch (e) { return negar(`no se pudo resolver la casa de la cuenta (${e.message})`, pedidas); }
  }
  let pendientes = pedidas;
  // el árbol: la herramienta, sin otra herramienta ni consola por arriba, con pantalla y sin consolas de fondo
  if (arbol === undefined) arbol = leerArbol();
  if (!arbol) return negar('no pude leer los procesos de la máquina', pendientes);
  const arriba = padres(arbol, pid);
  const i = arriba.findIndex(esHerramienta);
  if (i < 0) return negar('no encontré el proceso de la herramienta', pendientes);
  const tool = arriba[i];
  if (arriba.slice(i + 1).some((p) => esHerramienta(p) || desenvolver(p.comando, casa) !== null)) return negar('la herramienta la lanzó otra herramienta o su consola', pendientes);
  if (sinPantalla(tool)) return negar('la sesión no tiene pantalla (-p o --print): no hay ventana', pendientes);
  if (arbol.some((p) => p.ppid === tool.pid && desenvolver(p.comando, casa) !== null)) return negar('cerrá los procesos de fondo o firmá desde tu terminal: hay una consola de fondo viva', pendientes);
  const destino = destinoDe(can && can.palabras, sesion, guion);
  if (!SESION.test(destino)) return negar(sesionNombrada(guion, can && can.palabras) !== null ? 'la sesión que nombra el comando no se puede leer' : 'la sesión de --for-session no se puede leer', pendientes);
  const pedida = forSessionDe(can && can.palabras);
  if (sesionNombrada(guion, can && can.palabras) !== null && pedida !== null && pedida !== destino) {
    return negar(`el comando nombra la sesión ${una(destino, 80)} y --for-session ${una(pedida, 80)}: van con la misma sesión`, pendientes);
  }
  if (destino === SIN_SESION && destino !== sesion) return negar(NO_ES_SESION, pendientes);
  paraTerminal = destino;
  if (destino !== sesion && guion && firmaDe(guion).otherSession !== 'yes') return negar(`«${firmaDe(guion).approves}» no se corre desde la pestaña de otra sesión`, pendientes);
  // la refirma tras traer main: la dice el clasificador del guion (decisión 28); si no la comprueba, cambio de control
  let firmaGuion = guion;
  let refirmaDe = null;
  if (guion === CONTROL && can.palabras.includes('--base')) {
    let c = null;
    try { c = clasificar(can.palabras, evento.cwd); } catch (_) { c = null; }
    // pendientes queda sólo con la refirma porque un guion no viaja con escapes (lo niega `guion && escapes.length` arriba)
    if (c && c.clase === REFIRMA && typeof c.refirma_de === 'string') { firmaGuion = REFIRMA; refirmaDe = c.refirma_de; pendientes = [REFIRMA]; }
  }
  // la delegación: cada firma con todas las llaves del perfil corre sin ventana (AC 22-25)
  let delegada = null;
  let sinDelegar = null;
  if (delegacion === undefined) delegacion = (o) => require('./delegated-signing.js').delegaSinVentana(o);
  try {
    const estado = stateDir(casa);
    const rs = pendientes.map((id) => delegacion({ firma: id, sesion, destino, home: casa, estado }));
    if (rs.every((r) => r && r.ok)) delegada = rs[0];
    // una firma que el perfil delega y no se delegó lleva su motivo a la ventana; la que no se delega, no (es lo normal)
    else sinDelegar = rs.map((r) => r && !r.ok && r.motivo).find((m) => m && !/no delega|sólo del dueño|la sesión que implementa/.test(m)) || null;
  } catch (e) { return negar(`no se pudo consultar la delegación del perfil (${e.message})`, pendientes); }
  let detalle = detalleDe(pendientes[0], comando, can && can.palabras, evento.cwd);
  if (guion === 'runtime-waiver') {
    const c = criteriosDelPedido(can.palabras, evento.cwd, { casa, destino, sesion });
    if (c.error) return negar(c.error, pendientes);
    detalle = c.texto;
  }
  if (guion) {
    try {
      escribirRegistro(casa, { firma: firmaGuion, sesion, destino, tool_use_id: evento.tool_use_id == null ? null : String(evento.tool_use_id),
        sha256: sha256(comando), comando, herramienta: { pid: tool.pid, inicio: tool.inicio }, ts: new Date(ahora).toISOString(), corrida: corridaDe(casa, destino),
        ...(delegada ? { via: 'delegacion', maquina: delegada.maquina } : {}), ...(refirmaDe ? { refirma_de: refirmaDe } : {}) });
    } catch (e) { return negar(`no se pudo escribir el registro de la ventana (${e.code || e.message})`, pendientes); }
  }
  if (delegada) return { decision: 'allow', via: 'delegacion', relevo: sesion, firmas: pendientes, texto: 'firmada por la delegación del perfil' };
  const que = pendientes.map((id) => firmaDe(id).approves).join('; ');
  const texto = `Firma del dueño: ${que}. Story ${storyDe(casa, destino)}, sesión ${destino}. Detalle: ${detalle}. `
    + (sinDelegar ? `No se firmó por delegación: ${una(sinDelegar, 200)}. ` : '')
    + `Si preferís, firmala en tu terminal: ${terminalDe(pendientes, destino)}.`;
  return { decision: 'ask', firmas: pendientes, texto };
}

// --- el guion -----------------------------------------------------------------------------------------------------

function mismoArchivo(a, b) {
  const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };
  return real(a) === real(b);
}

/**
 * ¿El guion de `firma` (proceso `pid`, argumentos `argv` desde el guion) viene del «Sí» de una ventana? `{ ok, registro }`
 * consume el registro; `{ ok: false, motivo }` no escribe nada.
 */
function verificar({ firma, argv = [], pid = process.pid, arbol, casa, ahora = Date.now(), userInfo, sesion, destino, antes } = {}) {
  const s = firmaDe(firma);
  const no = (m) => ({ ok: false, motivo: `esta firma no pasó por la ventana: ${m}. Firmala en tu terminal: ${(s && s.terminal) || 'el mismo comando con --terminal'}` });
  if (!s || s.kind !== 'guion') return no(`«${firma}» no es una firma de guion`);
  if (casa === undefined) {
    try { casa = casaDeLaCuenta(userInfo ? { userInfo } : undefined); } catch (e) { return no(`no se pudo resolver la casa de la cuenta (${e.message})`); }
  }
  if (arbol === undefined) arbol = leerArbol();
  if (!arbol) return no('no pude leer los procesos de la máquina');
  const m = porPid(arbol);
  let yo = m.get(pid);
  // el piso de Node relanza el guion con el Node del arnés: su padre es el mismo guion con el Node viejo
  // (el relanzado lleva la ruta entera del guion; el padre, la que escribió la consola)
  const llamado = (p) => { const w = String((p && p.comando) || '').trim().split(/\s+/); return { node: NODES.has(base(w[0])), guion: base(w[1]), resto: w.slice(2).join(' ') }; };
  const padre = yo && m.get(yo.ppid);
  if (padre) {
    const a = llamado(padre);
    const b = llamado(yo);
    if (a.node && b.node && GUIONES.has(b.guion) && a.guion === b.guion && a.resto === b.resto) yo = padre;
  }
  const consola = yo && m.get(yo.ppid);
  const comando = consola ? desenvolver(consola.comando, casa) : null;
  if (comando === null) return no('el guion no lo lanzó la consola de la herramienta');
  const tool = m.get(consola.ppid);
  if (!tool || !esHerramienta(tool)) return no('la consola no es de la herramienta');
  const can = canonicaDe(comando);
  // la refirma tras traer main es el mismo comando que el cambio de control
  if (!can || (can.id !== firma && !(firma === REFIRMA && can.id === CONTROL))) return no('el comando no tiene la forma canónica de la firma');
  const esperado = can.palabras;
  // la consola expande `~/` al principio de cada palabra, con su HOME
  const conTilde = (w, a) => w === a || (w.startsWith('~/') && [casa, os.homedir()].some((h) => path.join(h, w.slice(2)) === a));
  const guion = esperado[0].startsWith('~/') ? path.join(casa, esperado[0].slice(2)) : esperado[0];
  if (argv.length !== esperado.length || !mismoArchivo(guion, argv[0]) || esperado.slice(1).some((w, k) => !conTilde(w, String(argv[k + 1])))) {
    return no('los argumentos del guion no son los del comando');
  }
  const dir = carpeta(casa);
  const prefijo = `${firma.replace(/[^\w-]/g, '_')}--`;
  let archivos = [];
  try { archivos = fs.readdirSync(dir).filter((f) => f.startsWith(prefijo) && f.endsWith('.json')); } catch (_) { archivos = []; }
  const huella = sha256(comando);
  let ilegibles = 0;
  let vencido = null;
  const validos = [];
  for (const f of archivos) {
    let reg;
    try { reg = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { ilegibles++; continue; }
    const edad = ahora - Date.parse(reg.ts);
    if (reg.firma !== firma || reg.sha256 !== huella || reg.comando !== comando) continue;
    // el registro es de la sesión que pidió y para su destino: el de otra sesión no lo usa nadie más
    if (sesion && reg.sesion !== sesion) continue;
    if (destino && reg.destino !== destino) continue;
    if (!reg.herramienta || reg.herramienta.pid !== tool.pid || reg.herramienta.inicio !== tool.inicio) continue;
    if (edad > VENCE_MIN * 60000 && (vencido === null || edad < vencido)) vencido = edad;
    if (!(edad >= 0 && edad <= VENCE_MIN * 60000)) continue;
    validos.push({ f, reg });
  }
  if (validos.length) {
    // sólo vale el último pedido: el más nuevo se consume y los anteriores vencen
    validos.sort((a, b) => Date.parse(b.reg.ts) - Date.parse(a.reg.ts));
    const [ultimo, ...viejos] = validos;
    // lo que el guion comprueba con el pedido a la vista y sin gastarlo (la vía la escribió el freno en el registro)
    if (antes) {
      const n = antes(ultimo.reg.via === 'delegacion' ? 'delegacion' : 'ventana', ultimo.reg);
      if (n && n.codigo) return { ok: false, codigo: n.codigo, motivo: n.motivo };
    }
    try { fs.renameSync(path.join(dir, ultimo.f), path.join(dir, `${ultimo.f}.consumido-${ahora}`)); } catch (_) { return no('el pedido de la ventana ya se usó'); }
    for (const v of viejos) { try { fs.renameSync(path.join(dir, v.f), path.join(dir, `${v.f}.vencido-${ahora}`)); } catch (_) { /* otro guion ya lo movió */ } }
    return { ok: true, registro: ultimo.reg };
  }
  // el «Sí» llegó tarde: el pedido existe y venció. Se repite el comando, que abre otra ventana
  if (vencido !== null) {
    return { ok: false, motivo: `esta firma no pasó por la ventana: la ventana se aprobó ${Math.floor(vencido / 60000)} minutos después de pedirla, y el pedido vence a los ${VENCE_MIN}. Repetí el mismo comando: abre otra ventana` };
  }
  return no(`no hay un pedido vigente de la ventana para este comando${ilegibles ? ` (${ilegibles} registro(s) de la ventana no se pudieron leer)` : ''}`);
}

/**
 * El renglón `<firma>-signed` del gates.log: cómo se firmó, quién y para quién. Va antes de la constancia del guion.
 * `anotar(renglon)`: el guion que lo escribe en su propio registro (marker.js, con su carpeta de estado).
 */
function firmar({ firma, via, sesion = null, destino = null, resumen = '', casa, ahora = Date.now(), anotar, extra } = {}) {
  // lo que el guion suma al renglón (el ok de guardar, sus huellas) va primero: no pisa quién ni cómo se firmó
  const renglon = { ...(typeof extra === 'function' ? extra({ via, sesion, destino }) : extra || {}), name: `${firma}-signed`, status: 'ok', via, sesion, destino, resumen: una(resumen, 200) };
  if (anotar) { anotar(renglon); return; }
  const dir = stateDir(casa === undefined ? casaDeLaCuenta() : casa);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'gates.log'), `${JSON.stringify({ ts: new Date(ahora).toISOString(), ...renglon })}\n`);
}

// --- las firmas sobre un archivo ------------------------------------------------------------------------------------

/** La ruta real de un archivo: la de su carpeta resuelta y su nombre (el archivo puede no existir todavía). */
function rutaReal(archivo, cwd) {
  const abs = path.resolve(cwd || process.cwd(), String(archivo));
  try { return fs.realpathSync(abs); } catch (_) { /* todavía no existe */ }
  try { return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); } catch (_) { return abs; }
}

function constanciaDe(casa, firma, sesion, real) {
  return path.join(carpeta(casa), 'files', `${firma}--${sesion}--${sha256(real).slice(0, 16)}.json`);
}

function deArchivo(firma) {
  if (!FIRMAS_DE_ARCHIVO.includes(firma)) throw new Error(`«${firma}» no es una firma sobre un archivo (${FIRMAS_DE_ARCHIVO.join(', ')})`);
}

/** La constancia de una firma sobre un archivo, para la sesión que lo va a escribir: la deja el guion después de firmar. */
function firmarArchivo({ firma, via, sesion, archivo, cwd, casa, ahora = Date.now() } = {}) {
  deArchivo(firma);
  if (!SESION.test(String(sesion || ''))) throw new Error('la constancia necesita la sesión que escribe el archivo');
  if (casa === undefined) casa = casaDeLaCuenta();
  const real = rutaReal(archivo, cwd);
  const destino = constanciaDe(casa, firma, sesion, real);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  const tmp = `${destino}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ ts: new Date(ahora).toISOString(), firma, via, sesion, destino: sesion, archivo: real }), { mode: 0o600 });
  fs.renameSync(tmp, destino);
  return destino;
}

/**
 * ¿Hay una constancia vigente de `firma` para esta sesión y este archivo? `{ ok: true, constancia }` la consume (una
 * escritura por firma); `{ ok: false, motivo }` no toca nada.
 */
function consumirArchivo({ firma, sesion, archivo, cwd, casa, ahora = Date.now() } = {}) {
  deArchivo(firma);
  if (!SESION.test(String(sesion || ''))) return { ok: false, motivo: 'el evento no dice de qué sesión es la escritura' };
  if (casa === undefined) {
    try { casa = casaDeLaCuenta(); } catch (e) { return { ok: false, motivo: `no se pudo resolver la casa de la cuenta (${e.message})` }; }
  }
  const real = rutaReal(archivo, cwd);
  const f = constanciaDe(casa, firma, sesion, real);
  let c;
  try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') return { ok: false, motivo: `la constancia de la ventana no se pudo leer (${e.code || e.message})` };
    // una escritura que murió con la firma reservada la dejó perdida: no es lo mismo que no haberla firmado
    let perdida = false;
    try { perdida = fs.readdirSync(path.dirname(f)).some((x) => x.startsWith(`${path.basename(f)}.reservado-`)); } catch (_) { /* sin carpeta: no hay firma */ }
    return { ok: false, motivo: perdida ? 'la firma de la ventana quedó reservada por una escritura que no terminó: se perdió, firmala de nuevo' : 'no hay una firma de la ventana para este archivo' };
  }
  if (c.firma !== firma || c.sesion !== sesion || c.archivo !== real) return { ok: false, motivo: 'la constancia de la ventana es de otra firma, sesión o archivo' };
  const edad = ahora - Date.parse(c.ts);
  if (!(edad >= 0 && edad <= VENCE_MIN * 60000)) return { ok: false, motivo: `la firma de la ventana venció (vale ${VENCE_MIN} minutos)` };
  // dentro del despachador la firma queda reservada (otra escritura ya no la encuentra) y al final se gasta, si ninguna
  // regla del evento frenó la escritura, o vuelve a su lugar; si el despachador muere en el medio, queda reservada: perdida
  const espera = globalThis[CONSUMOS];
  if (Array.isArray(espera) && espera.some((x) => x.f === f)) return { ok: true, constancia: c };
  const destino = Array.isArray(espera) ? `${f}.reservado-${process.pid}-${ahora}` : `${f}.consumido-${ahora}`;
  try { fs.renameSync(f, destino); } catch (e) {
    return { ok: false, motivo: e.code === 'ENOENT' ? 'la firma de la ventana ya se usó' : `la firma de la ventana no se pudo reservar (${e.code || e.message})` };
  }
  if (Array.isArray(espera)) espera.push({ f, reservado: destino, ahora });
  return { ok: true, constancia: c };
}

/**
 * Cierra las firmas que reservó `consumirArchivo` dentro del despachador: con `paso` se gastan, sin `paso` vuelven a su
 * lugar, salvo que ya haya ahí una firma nueva. Devuelve los errores (`[{ f, error }]`): una firma que no se pudo cerrar no se da por cerrada en silencio.
 */
function confirmarConsumos(lista, { paso = true } = {}) {
  const errores = [];
  for (const { f, reservado, ahora } of lista || []) {
    try {
      if (paso) fs.renameSync(reservado, `${f}.consumido-${ahora}`);
      else {
        // vuelve sin pisar: si la persona firmó otra vez mientras tanto, queda la nueva y la vieja se descarta
        try { fs.linkSync(reservado, f); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        fs.unlinkSync(reservado);
      }
    } catch (e) { errores.push({ f, error: e.code || e.message }); }
  }
  return errores;
}

/** El renglón que dice cómo se pide una firma sobre un archivo: lo usan los carteles de los frenos de escritura. */
function comoSeFirma(firma, archivo) {
  // entre comillas simples si la consola leería otra cosa (espacios, `$`, `;`, comillas, paréntesis…)
  const ruta = archivo ? (/^[A-Za-z0-9_./:@%+=,-]+$/.test(archivo) ? archivo : `'${String(archivo).replace(/'/g, "'\\''")}'`) : '<archivo>';
  return `marker.js sign-file ${firma} ${ruta}`;
}

function ttyDeVerdad() {
  const rw = require(path.join(LIB, 'runtime-waiver.js'));
  return {
    windows: rw.esWindows(), hay: rw.hasTty, preguntar: rw.promptTty, confirmarFrase: rw.confirmarFrase,
    // Windows: la ventana nueva (la abre el proceso de afuera; el de adentro se anota y espera una tecla al terminar)
    enVentana: () => process.env[rw.MARCA_VENTANA] === '1',
    abrir: (o) => rw.abrirVentana(o),
    dentro: () => rw.dentroDeLaVentana(),
  };
}

/**
 * En Windows la terminal no se lee: el comando se corre otra vez en una ventana nueva y la firma se da adentro. El
 * proceso de afuera sale con el código de la ventana (`salir`); si no se abrió o venció, devuelve 1 sin firmar.
 */
function porLaVentana({ argv, t, salir = process.exit }) {
  console.error('🪟 Abro una ventana nueva para la firma: seguí ahí.');
  const v = t.abrir({ programa: process.execPath, script: argv[0], args: argv.slice(1), titulo: 'Firma del dueño' });
  if (v.estado === 'vencida') return { codigo: 1, motivo: `la ventana venció a los ${v.tope} s sin firmar${v.pid ? ` (la ventana arrancó: pid ${v.pid})` : ' (la ventana no llegó a arrancar el comando)'}` };
  if (v.estado !== 'cerrada') return { codigo: 1, motivo: `no pude abrir la ventana (${v.motivo})` };
  salir(v.codigo === 0 ? 0 : (v.codigo || 1));
  return { codigo: v.codigo === 0 ? 0 : (v.codigo || 1), via: 'ventana-nueva' };
}

/**
 * La firma en la terminal del dueño (`--terminal`): `/dev/tty` y «firmo»; en Windows, la ventana nueva y tres palabras.
 * `{ codigo: 0 }` firmó (con `via: terminal`), 1 no firmó, 2 no hay terminal (nada escrito).
 */
function porTerminal({ firma, sesion = null, destino = null, resumen = '', casa, ahora = Date.now(), tty, anotar, extra } = {}) {
  const s = firmaDe(firma);
  const t = tty || ttyDeVerdad();
  if (!t.hay()) return { codigo: 2, motivo: 'esta firma se da en la terminal del dueño, y aquí no hay una' };
  const que = `Firma del dueño: ${s ? s.approves : firma}${resumen ? ` (${una(resumen, 200)})` : ''}${destino ? `, sesión ${destino}` : ''}.`;
  let ok;
  // en Windows también: la ventana dice qué se firma antes de pedir las tres palabras
  if (t.windows) { console.error(`\n${que}`); ok = t.confirmarFrase({}); }
  else ok = String(t.preguntar(`\n${que}\nPara firmar, escribí «firmo»: `) || '').trim().toLowerCase() === 'firmo';
  if (!ok) return { codigo: 1, motivo: 'no se firmó' };
  firmar({ firma, via: 'terminal', sesion, destino, resumen, casa, ahora, anotar, extra });
  return { codigo: 0, via: 'terminal' };
}

/**
 * Lo que llama cada guion de firma antes de actuar: con `--terminal`, la terminal; si no, la ventana. Devuelve
 * `{ codigo, motivo?, via?, destino? }`; con 0, el renglón `-signed` ya está escrito. `propia`: la sesión sobre la que
 * actúa el guion; un registro para otra sesión destino no la firma.
 * `antes(via, registro)`: lo que el guion comprueba antes de la firma, con la vía ya sabida y el pedido sin gastar
 * (`{ codigo, motivo }` para no firmar; null para seguir). `extra`: campos más para el renglón `-signed` (o una función
 * que los da, llamada al firmar con `{ via, sesion, destino }`).
 */
function exigir({ firma, argv = process.argv.slice(1), resumen = '', pid = process.pid, arbol, casa, ahora, tty, anotar, propia, salir, antes, extra } = {}) {
  // sin variable de sesión (la terminal del dueño) el guion no tiene sesión propia: la dice --for-session
  if (propia === '_nosession') propia = null;
  const i = argv.indexOf('--for-session');
  const pedida = i >= 0 ? argv[i + 1] : null;
  if (pedida === SIN_SESION) return { codigo: 1, motivo: NO_ES_SESION };
  // otra sesión, sólo para las firmas que el catálogo marca así: la firma la pide la sesión propia para la pedida
  const s = firmaDe(firma);
  if (pedida && propia && pedida !== propia && !(s && s.otherSession === 'yes')) {
    return { codigo: 1, motivo: `este guion actúa sobre la sesión ${propia}: firmar para otra sesión (--for-session ${pedida}) se corre desde la sesión destino` };
  }
  const destino = sesionNombrada(firma, argv) || pedida || propia || null;
  if (argv.includes('--terminal')) {
    const t = tty || ttyDeVerdad();
    if (t.windows && t.enVentana && !t.enVentana()) return { ...porLaVentana({ argv, t, salir }), destino };
    if (t.windows && t.enVentana && t.dentro) t.dentro();
    if (antes) {
      const n = antes('terminal', null);
      if (n && n.codigo) return { codigo: n.codigo, motivo: n.motivo, destino, sesion: propia || null };
    }
    const r = porTerminal({ firma, sesion: propia || null, destino, resumen, casa, ahora, tty: t, anotar, extra });
    return { ...r, destino, sesion: propia || null };
  }
  const v = verificar({ firma, argv, pid, arbol, casa, ahora, sesion: propia || undefined, destino: destino || undefined, antes });
  if (!v.ok) return { codigo: v.codigo || 1, motivo: v.motivo };
  // el registro que dejó el freno sin ventana (la delegación del perfil) firma con via: delegacion
  const via = v.registro.via === 'delegacion' ? 'delegacion' : 'ventana';
  firmar({ firma, via, sesion: v.registro.sesion, destino: v.registro.destino, resumen: resumen || v.registro.comando, casa, ahora, anotar, extra });
  return { codigo: 0, via, destino: v.registro.destino, sesion: v.registro.sesion, registro: v.registro };
}

/**
 * Después de la firma, el guion pasa a trabajar sobre la sesión destino de `r` (lo que devolvió `exigir`), con esta
 * única llamada: compara la corrida que vio el dueño (la del registro; la terminal no deja registro) con la del
 * marcador de ahora, exige el marcador abierto si la firma trabaja sobre la ejecución, y fija la variable de sesión del
 * proceso (las bibliotecas y los procesos hijos). `{ codigo: 0, destino, constancia: { via, por? } }`, o
 * `{ codigo: 2, motivo }` sin tocar nada. `leerMarcador(sesion)`: el marcador como lo lee el guion (null si no existe;
 * lanza si existe y no se puede leer, como `marcadorEn`); sin él, el de `casa`.
 */
function fijarDestino({ r, propia, necesitaMarcador = false, leerMarcador, casa, env = process.env } = {}) {
  const destino = r && r.destino;
  // sin sesión (ni propia ni pedida) el guion sigue como estaba: no hay a qué sesión pasar
  if (!destino) return { codigo: 0, destino: null, constancia: { via: r && r.via } };
  // «sin sesión» como destino pasaría sin comparar la corrida que vio el dueño
  if (destino === SIN_SESION) return { codigo: 2, motivo: NO_ES_SESION };
  if (!SESION.test(destino)) return { codigo: 2, motivo: 'la sesión destino de la firma no se puede leer' };
  const leer = leerMarcador || ((sid) => marcadorEn(path.join(stateDir(casa === undefined ? casaDeLaCuenta() : casa), 'active', `${sid}.json`)));
  let hoy;
  try { hoy = corridaDelMarcador(leer(destino)); } catch (e) { return { codigo: 2, motivo: e.message }; }
  if (necesitaMarcador && !hoy) return { codigo: 2, motivo: `la sesión ${destino} no tiene una ejecución abierta` };
  const vio = r.registro ? r.registro.corrida : undefined;
  if (vio !== undefined && JSON.stringify(vio) !== JSON.stringify(hoy)) {
    return { codigo: 2, motivo: `la ejecución de la sesión ${destino} cambió desde que se pidió la firma (se pidió para ${vio && vio.ilegible ? 'un marcador que no se podía leer' : vio ? `la story ${vio.storyId}` : 'ninguna ejecución'}; ahora ${hoy ? `es la story ${hoy.storyId}` : 'no hay ninguna'}): pedila de nuevo` };
  }
  // la variable que gana en la resolución de la sesión, y las otras dos si están, para que la cadena no se parta
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID']) if (k === 'CLAUDE_CODE_SESSION_ID' || env[k]) env[k] = destino;
  // la terminal del dueño sin variable de sesión no es una sesión que pida: no deja `por`
  const pidio = r.sesion || (propia && propia !== '_nosession' ? propia : null);
  return { codigo: 0, destino, constancia: { via: r.via, ...(pidio && pidio !== destino ? { por: pidio } : {}) } };
}

/**
 * Quién firmó, para la constancia del guion, a partir de lo que devolvió `exigir`: por la delegación del perfil firmó
 * la coordinadora (la sesión del evento) en nombre de `persona`; por la ventana o por la terminal, la persona.
 */
function quienFirmo({ via, sesion } = {}, persona) {
  if (via === 'delegacion') return { tipo: 'automatica', quien: `coordinadora (sesión ${sesion})`, delegacion: persona, via: 'delegada · coordinadora' };
  return { tipo: 'manual', quien: persona, via: via === 'terminal' ? 'terminal' : 'ventana' };
}

module.exports = { VENCE_MIN, carpeta, quienFirmo, leerArbol, esHerramienta, desenvolver, canonica, canonicaDe, firmasDelComando, decidir, verificar, firmar, porTerminal, exigir, fijarDestino, marcadorEn, vencerPedidos,
  rutaReal, firmarArchivo, consumirArchivo, confirmarConsumos, comoSeFirma };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const lineas = (o) => process.stdout.write(Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${k === 'json' ? v : una(v, 4000)}\n`).join(''));
  if (sub === 'gate') {
    // el evento por la entrada; los escapes que vio el freno de seguridad, con --escape <id>
    const escapes = [];
    for (let k = 1; k < argv.length; k++) if (argv[k] === '--escape' && argv[k + 1]) escapes.push(argv[++k]);
    let r;
    try {
      const evento = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, ''));
      // antes de decidir, los pedidos anteriores de la sesión vencen: un pedido vive sólo hasta el próximo comando
      vencerPedidos(casaDeLaCuenta(), evento.session_id);
      r = decidir({ evento, escapes });
    } catch (e) { r = negarCon(`no pude decidir la firma (${e.message})`, escapes.filter((id) => firmaDe(id))); }
    const ask = r.decision === 'ask' ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: r.texto } }) : undefined;
    lineas({ decision: r.decision, firma: (r.firmas || [])[0], via: r.via, relevo: r.relevo, texto: r.texto, json: ask });
    process.exit(0);
  }
  if (sub === 'sweep') {
    // el freno, ante un comando que no es una firma: vence los pedidos de su sesión. Sale 1 si no pudo
    try {
      const evento = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, ''));
      vencerPedidos(casaDeLaCuenta(), evento.session_id);
      process.exit(0);
    } catch (e) { process.stderr.write(`no pude vencer los pedidos de la ventana (${e.message})\n`); process.exit(1); }
  }
  if (sub === 'verify') {
    // para los guiones de consola: `verify --signature <id> --process-id <pid del guion> -- <guion> <argumentos…>`
    const val = (n) => { const k = argv.indexOf(n); return k > 0 ? argv[k + 1] : undefined; };
    const corte = argv.indexOf('--');
    const delGuion = corte >= 0 ? argv.slice(corte + 1) : [];
    const r = exigir({ firma: val('--signature'), argv: delGuion, pid: Number(val('--process-id')), resumen: val('--summary') || '' });
    if (r.codigo !== 0) process.stderr.write(`${r.motivo}\n`);
    lineas({ via: r.via, destino: r.destino });
    process.exit(r.codigo);
  }
  process.stderr.write('uso: owner-window.js gate [--escape <id>]… < evento  |  verify --signature <id> --process-id <n> -- <guion> <args…>\n');
  process.exit(2);
}
