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
 * Donde la ventana no llega (una pestaña sin permisos, una sesión de fondo), la firma la da la persona sin terminal: un
 * click suyo en el cuadro de opciones o un «aprobado» escrito, que anota un gancho (owner-approvals.js). Sirve para una
 * sola firma, dentro de 30 minutos, dado en la sesión que firma o en la coordinadora confirmada. Lo irreversible
 * (`TERMINAL_SIEMPRE`) sigue en la terminal.
 *
 * El registro vive en `owner-window/`, dentro de la carpeta del estado de la casa de la cuenta, un archivo por (firma, sesión
 * destino, sesión del pedido). La casa sale de real-home.js: `HOME`, `USERPROFILE` y `TYCON_HOME` no la cambian.
 *
 * Las firmas sobre un archivo (`marker.js sign-file <firma> <archivo>`, FIRMAS_DE_ARCHIVO de signatures.js) son un
 * guion más; con la firma dada, el guion deja una constancia en `owner-window/files/` (`firmarArchivo`) que el Edit o
 * Write siguiente de esa sesión sobre ese archivo consume (`consumirArchivo`), dentro de los mismos 30 minutos.
 *
 * La envoltura de la consola es la medida en la Mac (`zsh -c source <foto del ambiente> … && eval '<comando>' <
 * /dev/null && pwd -P >| /tmp/claude-…-cwd`), o la de una sesión cuya foto no se sacó (`zsh -c -l setopt … && eval
 * '<comando>' …`, medida con zsh; la de bash con `shopt` es un supuesto). Una que no coincide, un árbol que no se lee o una herramienta lanzada por
 * otra herramienta o por su consola se niegan: lo indecidible se firma en la terminal. Lo que no ve: una herramienta
 * abierta por el agente dentro de `tmux`, cuyo servidor no tiene padre (límite declarado en la guía).
 *
 * En Windows firman sólo el click y el «aprobado», y sólo por la consola Bash, con la forma medida en una máquina
 * (`desenvolverWindows`, `consolaDeWindows`). La ventana de permiso no firma: su pedido queda escrito antes de que la
 * persona conteste, y en Windows un programa puede declarar cualquier padre al crear un proceso, así que podría imitar la
 * consola con la ventana abierta. Con el click, el pedido se escribe después de que la persona aprobó ese comando exacto.
 * La consola PowerShell no firma: su línea no dice qué comando corre.
 *
 * El árbol, el evento, la casa y la hora se pasan como parámetros en las pruebas; nada se finge por el ambiente.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { SIGNATURES, FIRMAS_DE_ARCHIVO, ONLY_IN_TERMINAL, SOBRE_CUPO, firmaDelPedidoAdhoc } = require('./signatures.js');
const { approverOf } = require('./approver.js');
const { casaDeLaCuenta } = require('./real-home.js');

const LIB = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib');
const markerCommand = () => require(path.join(LIB, 'marker-command.js'));
const stateDir = (casa) => require(path.join(LIB, 'state-dir.js')).stateDir(casa);

const VENCE_MIN = 30;
const SESION = /^[\w-]+$/;
// el nombre con que los guiones dicen «sin variable de sesión»: no es una sesión a la que pedirle una firma
const SIN_SESION = '_nosession';
// los modos de permiso de la herramienta en los que un pedido de la ventana le llega a una persona
const MODOS_QUE_PREGUNTAN = new Set(['default', 'acceptEdits', 'plan']);
const NO_ES_SESION = '«_nosession» es el nombre de «sin sesión», no una sesión: la firma se pide para la sesión destino por su id';
const VARIABLES_DE_SESION = /(^|[^\w])(CLAUDE_CODE_SESSION_ID|TYCON_SESSION_ID|CODEX_SESSION_ID)(?![\w])/;
// los guiones de las firmas `guion`, por su nombre de archivo
const GUIONES = new Set(['marker.js', 'pipeline.js', 'e2e-setup.js', 'run-base-controls.sh', 'delegated-signing.js']);
const NODES = new Set(['node', 'nodejs']);
// los procesos de Bash entre el guion y la herramienta en Windows, medidos: el de `Git\\bin` y dos de `Git\\usr\\bin`
const NIVELES_DE_LA_CONSOLA = 3;
// lo que anota la aprobación en Windows; un pedido sin esto sería de la ventana de permiso
const VIAS_DE_WINDOWS = new Set(['click', 'mensaje']);
const SIN_GIT_BASH = 'esta máquina no tiene Git Bash: instalá Git para Windows (winget install Git.Git, y volvé a abrir la herramienta), que hace falta para los controles que son guiones de bash y para firmar con un click; mientras tanto, para firmar queda --terminal, en la ventana nueva de tres palabras';
const buscarGitBash = () => require('./git-bash.js').findGitBash({ platform: 'win32' });
const SHS = new Set(['bash', 'sh']);
// las consolas que corren el texto de `-c` como un comando (`grep -c '…'` cuenta renglones: no corre nada)
const CONSOLAS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell', 'pwsh.exe', 'powershell.exe', 'bash.exe']);
// los consumos de las firmas sobre un archivo que dejó pendientes el despachador (dispatch.js)
const CONSUMOS = Symbol.for('tycon.consumos-diferidos');
const REFIRMA = 'refresh-after-main';
const CONTROL = 'control-change';
const DESIGNACION = 'designation-confirm';

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

// Windows da la hora de inicio con siete decimales y en UTC (`ToString('o')`): como texto, se ordena como hora
const CONSULTA_WINDOWS = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object "
  + "@{n='pid';e={$_.ProcessId}},@{n='ppid';e={$_.ParentProcessId}},@{n='inicio';e={if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}}},"
  + "@{n='ejecutable';e={$_.ExecutablePath}},@{n='comando';e={$_.CommandLine}} | ConvertTo-Json -Compress";

/**
 * Los procesos de Windows como los da `leerArbol`, o null si no se pueden leer. PowerShell sale de su ruta fija, sin
 * `PSModulePath` (un PowerShell 7 lo deja apuntando a sus módulos, y decide de dónde se carga la consulta) ni las variables
 * con las que .NET carga otro código en el proceso.
 * Tarda de 0,7 a 2,2 s (medido), así que se lee sólo al pedir una firma o al anotar una aprobación.
 *
 * Es otra lectura que `leerArbol` porque en Windows la cadena termina en padres que ya murieron, y la emergencia exige
 * que llegue hasta el sistema: con esta lectura nunca llegaría.
 */
function leerArbolWindows({ spawnSync = require('child_process').spawnSync } = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(PSModulePath$|COR_|CORECLR_|COMPLUS_|DOTNET_)/i.test(k)) delete env[k];
  let r;
  try {
    r = spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', CONSULTA_WINDOWS],
      { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024 * 1024, env });
  } catch (_) { return null; }
  if (!r || r.error || r.status !== 0 || !r.stdout) return null;
  let lista;
  try { lista = JSON.parse(String(r.stdout).replace(/^\uFEFF/, '')); } catch (_) { return null; }
  const fuera = (Array.isArray(lista) ? lista : [lista]).filter((p) => p && Number.isInteger(p.pid) && Number.isInteger(p.ppid))
    .map((p) => ({ pid: p.pid, ppid: p.ppid, inicio: String(p.inicio || ''), comando: String(p.comando || ''), ...(p.ejecutable ? { ejecutable: String(p.ejecutable) } : {}) }));
  return fuera.length ? conPadresValidos(fuera) : null;
}

/**
 * Windows reusa los números de proceso y no borra el padre de un hijo cuyo padre murió: un proceso que arrancó después
 * que su hijo no es su padre, sólo tiene el número de aquél. Ese hijo queda sin padre. Sin la hora de los dos, no se sabe.
 */
function conPadresValidos(arbol) {
  const m = new Map(arbol.map((p) => [p.pid, p]));
  return arbol.map((p) => {
    const padre = m.get(p.ppid);
    return !padre || (padre.inicio && p.inicio && padre.inicio <= p.inicio) ? p : { ...p, ppid: null };
  });
}

/** El árbol que se pasó, o el de la máquina si falta; en Windows, sin los padres que no lo son. */
function arbolDeLaPlataforma(arbol, plataforma = process.platform) {
  if (plataforma !== 'win32') return arbol === undefined ? leerArbol({ plataforma }) : arbol;
  const a = arbol === undefined ? leerArbolWindows() : arbol;
  return a && conPadresValidos(a);
}

/**
 * ¿Es el proceso de la herramienta? `claude` (o `node <…>/claude`, el lanzador del paquete), con minúscula: la app de
 * escritorio, `Claude`, no lo es. El ejecutable puede venir aparte (una ruta con espacios, la de la copia de escritorio).
 */
function esHerramienta(p) {
  const linea = String((p && p.comando) || '').trim();
  const exe = p && p.ejecutable ? String(p.ejecutable) : '';
  // la sesión de fondo (`claude --bg`) corre en un proceso que se renombra `claude bg-spare`: su ejecutable ya no se
  // llama `claude`, y la consola de sus comandos cuelga de él
  if (/^claude(\.exe)?\s+bg-spare(\s|$)/.test(linea) || /^claude(\.exe)?\s+bg-spare$/.test(exe)) return true;
  const w = linea.split(/\s+/);
  let nombre = w[0];
  let resto = w.slice(1);
  if (exe && linea.startsWith(exe)) { nombre = exe; resto = linea.slice(exe.length).trim().split(/\s+/); } else if (exe) nombre = exe;
  const crudo = (x) => String(x || '').split(/[\\/]/).pop();
  if (/^claude(\.exe)?$/.test(crudo(nombre))) return true;
  return (NODES.has(base(nombre)) || base(nombre) === 'bun') && (/^claude(\.exe)?$/.test(crudo(resto[0])) || /claude-code[\\/]cli\.(m?js)$/.test(resto[0] || ''));
}

/**
 * La primera palabra después del programa, si el programa es `claude` (con su ruta, `.exe` o entre comillas); null si
 * no. Sólo esa: un argumento posterior que diga `claude --bg-pty-host` no vuelve anfitrión a una herramienta.
 */
function primeraDeClaude(p) {
  const linea = String((p && p.comando) || '').trim();
  // el ejecutable sólo ayuda si es el de claude: uno renombrado (`claude bg-pty-host`) se lee por palabras
  const exe = p && p.ejecutable && /^claude(\.exe)?$/i.test(String(p.ejecutable).split(/[\\/]/).pop()) ? String(p.ejecutable) : '';
  let programa;
  let resto;
  if (exe && linea.startsWith(`"${exe}"`)) { programa = exe; resto = linea.slice(exe.length + 2); } else if (exe && linea.startsWith(exe)) { programa = exe; resto = linea.slice(exe.length); } else {
    const m = linea.match(/^(?:"([^"]*)"|(\S+))(.*)$/s);
    if (!m) return null;
    programa = m[1] !== undefined ? m[1] : m[2];
    resto = m[3];
  }
  if (!/^claude(\.exe)?$/i.test(String(programa).split(/[\\/]/).pop())) return null;
  return String(resto).trim().split(/\s+/)[0] || null;
}

// la terminal virtual de una sesión de fondo: renombrada (`claude bg-pty-host`) o, la de una sesión retomada, con su
// ruta y la bandera (`<ruta>/claude.exe --bg-pty-host <socket> …`)
const esTerminalDeFondo = (p) => ['bg-pty-host', '--bg-pty-host'].includes(primeraDeClaude(p));

/**
 * ¿`p` es un anfitrión de la sesión de fondo `tool`? Sólo si la herramienta es la de una sesión de fondo
 * (`claude bg-spare`, o una retomada colgando directo de su terminal virtual, `padre`) y `p` es esa terminal virtual o
 * el daemon (`claude daemon`): un claude abierto debajo de una sesión de fondo no tiene a esos procesos por anfitriones.
 */
function esAnfitrionDeFondoDe(tool, p, padre = null) {
  const deFondo = /^claude(\.exe)?\s+bg-spare(\s|$)/.test(String((tool && tool.comando) || '').trim()) || esTerminalDeFondo(padre);
  if (!deFondo) return false;
  return esTerminalDeFondo(p) || primeraDeClaude(p) === 'daemon';
}

/** ¿La línea de la herramienta trae `-p` o `--print` (sin pantalla)? */
function sinPantalla(p) {
  return String(p.comando).trim().split(/\s+/).slice(1).some((w) => w === '-p' || w === '--print' || w.startsWith('--print='));
}

/**
 * El comando que corre una consola de la herramienta, sacado de su envoltura medida; null si la línea no es esa
 * envoltura (otra casa en la foto del ambiente, otra forma, una comilla suelta adentro). La consola de fondo va sin
 * `< /dev/null`. La consola es la de la persona: zsh o bash, de cualquier carpeta (la del sistema o la de Homebrew).
 * Una sesión que arrancó sin foto lanza `-c -l` sin el `source`; ahí el bloque propio de su consola (`setopt` en zsh,
 * `shopt` en bash) es obligatorio, porque es el ancla que queda en lugar de la foto.
 */
function desenvolver(linea, casa) {
  const re = new RegExp('^(?:/[\\w.+-]+)*/(?<consola>zsh|bash) -c (?:source ' + escRe(casa)
    + '/\\.claude/shell-snapshots/snapshot-(?:zsh|bash)-[\\w.-]+\\.sh 2>/dev/null \\|\\| true && '
    + '(?:setopt(?: [A-Z_]+)+ 2>/dev/null \\|\\| true && )?'
    + '(?:shopt -u extglob 2>/dev/null \\|\\| true && )?'
    + '|-l (?<propio>setopt(?: [A-Z_]+)+|shopt -u extglob) 2>/dev/null \\|\\| true && )'
    + "(?:\\{(?: \\\\builtin (?:unalias|unset -f) -- '[\\w-]+';)+ \\} >/dev/null 2>&1 \\|\\| true && )*"
    + "eval '(?<comando>[\\s\\S]*)'(?: < /dev/null)? && pwd -P >\\| (?:/private)?/tmp/claude-[0-9a-f]+-cwd$");
  const m = re.exec(String(linea || ''));
  if (!m) return null;
  const { consola, propio, comando } = m.groups;
  if (propio !== undefined && propio.startsWith('setopt') !== (consola === 'zsh')) return null;
  const partes = comando.split(`'"'"'`);
  if (partes.some((p) => p.includes("'"))) return null;
  return partes.join("'");
}

// El owner-wait de esta misma copia del arnés: el que corre el freno, no otra copia con el mismo nombre
const COORDINACION = path.join(__dirname, '..', 'tools', 'coordination.js');
const real = (ruta) => { try { return fs.realpathSync(ruta); } catch (_) { return null; } };

/**
 * ¿El comando de una consola de fondo es exactamente el despertador de la coordinadora? `node <coordination.js> owner-wait`,
 * con el coordination.js de este arnés, sin nada más en la línea: ni otra palabra, ni otro comando, ni redirecciones, ni
 * nada armado. Es la única consola de fondo que no le quita el click al dueño: la coordinadora la tiene viva siempre.
 */
function esOwnerWait(comando) {
  let t;
  try { t = markerCommand().tramos(String(comando), 'bash'); } catch (_) { return false; }
  if (t.abierta || t.subs.length || t.tramos.length !== 1 || t.tramos[0].heredocs.length) return false;
  const w = t.tramos[0].palabras;
  if (w.length !== 3 || w.some((x) => !x.literal || /^\d*[<>&|]/.test(x.texto) || /[\r\n]/.test(x.texto))) return false;
  if (!NODES.has(base(w[0].texto)) || w[2].texto !== 'owner-wait' || !path.isAbsolute(w[1].texto)) return false;
  const propio = real(COORDINACION);
  return propio !== null && real(w[1].texto) === propio;
}

/**
 * Las palabras de una línea de comando de Windows, con sus reglas: las barras valen como escape sólo antes de una comilla.
 * null si la línea queda con una comilla abierta, o si trae `""` dentro de unas comillas, que cada programa lee a su modo.
 */
function palabrasDeWindows(linea) {
  const s = String(linea || '');
  const fuera = [];
  let i = 0;
  for (;;) {
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (i >= s.length) return fuera;
    let w = '';
    let comillas = false;
    while (i < s.length && (comillas || (s[i] !== ' ' && s[i] !== '\t'))) {
      if (s[i] === '\\') {
        let n = 0;
        while (s[i + n] === '\\') n++;
        i += n;
        if (s[i] !== '"') { w += '\\'.repeat(n); continue; }
        w += '\\'.repeat(Math.floor(n / 2));
        if (n % 2) { w += '"'; i++; }
      } else if (s[i] === '"') {
        if (comillas && s[i + 1] === '"') return null;
        comillas = !comillas;
        i++;
      } else w += s[i++];
    }
    if (comillas) return null;
    fuera.push(w);
  }
}

/** La carpeta de Git de un `bash.exe` de Git Bash, y si es el de arriba (`bin`) o uno de abajo (`usr\\bin`); null si no es. */
function gitBashDe(programa) {
  const m = /^([A-Za-z]:\\(?:[^\\"]+\\)*Git)\\bin\\(\.\.\\usr\\bin\\)?bash\.exe$/i.exec(String(programa || ''));
  return m ? { git: m[1], arriba: !m[2] } : null;
}

/**
 * Lo que dice la línea de una consola Bash de la herramienta en Windows: `{ programa, texto, comando }`, o null si no es la
 * forma medida. La envoltura es la de la Mac (`desenvolver`), con la casa en `/c/Users/…`, el `export TEMP` y el
 * archivo temporal en la carpeta temporal de la cuenta; un usuario con espacios en la ruta no está medido y no coincide.
 */
function consolaBashDeWindows(linea, casa) {
  const w = palabrasDeWindows(linea);
  if (!w || w.length !== 3 || w[1] !== '-c' || !gitBashDe(w[0])) return null;
  const msys = String(casa).replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/');
  const temp = escRe(`${casa}\\AppData\\Local\\Temp`);
  const re = new RegExp(`^source ${escRe(msys)}/\\.claude/shell-snapshots/snapshot-bash-[\\w.-]+\\.sh 2>/dev/null \\|\\| true && `
    + `export TEMP='${temp}' TMP='${temp}' && `
    + '(?:shopt -u extglob 2>/dev/null \\|\\| true && )?'
    + "(?:\\{(?: \\\\builtin (?:unalias|unset -f) -- '[\\w-]+';)+ \\} >/dev/null 2>&1 \\|\\| true && )*"
    + `eval '([\\s\\S]*)'(?: < /dev/null)? && pwd -P >\\| ${escRe(msys)}/AppData/Local/Temp/claude-[0-9a-f]+-cwd$`);
  const m = re.exec(w[2]);
  if (!m) return null;
  const partes = m[1].split(`'"'"'`);
  if (partes.some((p) => p.includes("'"))) return null;
  return { programa: w[0], texto: w[2], comando: partes.join("'") };
}

/** El comando que corre una consola Bash de la herramienta en Windows, o null: como `desenvolver`, con esa forma. */
function desenvolverWindows(linea, casa) {
  const c = consolaBashDeWindows(linea, casa);
  return c ? c.comando : null;
}

/**
 * ¿La línea es de una consola de la herramienta en Windows, de cualquier forma? La Bash lleva la foto del ambiente, y la
 * PowerShell la variable por la que le llega el comando. Sirve para frenar, no para firmar: no dice qué comando corre.
 */
function esConsolaDeWindows(p) {
  return /shell-snapshots[\\/]snapshot-|CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT|__claudeCodeScript/.test(String((p && p.comando) || ''));
}

/**
 * ¿Es una consola viva de la herramienta (`p`, hijo directo suyo)? Además de las de arriba, cualquier PowerShell, sola o
 * lanzada por `cmd`, por si cambia la variable: no se puede leer qué corre. Un `cmd` que no la nombra no cuenta: con él se
 * lanzan los servidores MCP.
 */
function esConsolaVivaDeWindows(p) {
  if (esConsolaDeWindows(p)) return true;
  const programa = base(p && p.ejecutable);
  if (programa === 'pwsh.exe' || programa === 'powershell.exe') return true;
  return programa === 'cmd.exe' && /(^|[\\/"\s])(?:pwsh|powershell)(?:\.exe)?(?=["\s]|$)/i.test(String(p.comando || ''));
}

/**
 * La consola que lanzó al guion `yo` en Windows, de abajo hacia arriba: `{ comando, tool }`, o `{ motivo }`. Exige los
 * niveles medidos (dos de `usr\\bin` y arriba el de `bin`, de la misma carpeta de Git), cada uno con su ejecutable, el mismo
 * texto en todos, y la herramienta arriba de ellos.
 */
function consolaDeWindows(m, yo, casa) {
  const niveles = [];
  let p = yo && m.get(yo.ppid);
  while (p && niveles.length < NIVELES_DE_LA_CONSOLA) { niveles.push(p); p = m.get(p.ppid); }
  const no = { motivo: 'el guion no lo lanzó la consola Bash de la herramienta, en la forma medida en Windows' };
  if (niveles.length !== NIVELES_DE_LA_CONSOLA) return no;
  const formas = niveles.map((n) => consolaBashDeWindows(n.comando, casa));
  if (formas.some((f) => !f)) return no;
  if (formas.some((f) => f.texto !== formas[0].texto)) return { motivo: 'los niveles de la consola no dicen el mismo comando' };
  const gits = formas.map((f) => gitBashDe(f.programa));
  const orden = gits.every((g, k) => g.arriba === (k === NIVELES_DE_LA_CONSOLA - 1) && g.git === gits[0].git);
  if (!orden || niveles.some((n, k) => n.ejecutable !== formas[k].programa)) return no;
  if (!p || !esHerramienta(p)) return { motivo: 'la consola no es de la herramienta' };
  return { comando: formas[0].comando, tool: p };
}

/**
 * Una ruta como la ve Windows: Git Bash le pasa a un programa `/c/x` como `C:/x`, y la casa de `~/` ya sale así. Sin
 * distinguir mayúsculas. Sólo para comparar.
 */
function rutaDeWindows(w) {
  const m = /^\/([A-Za-z])(\/.*)?$/.exec(String(w));
  return path.win32.normalize(m ? `${m[1]}:${m[2] || '/'}` : String(w)).toLowerCase();
}

function mismaRutaDeWindows(a, b, casa) {
  const conCasa = (w) => (String(w).startsWith('~/') ? path.win32.join(casa, String(w).slice(2)) : String(w));
  const real = (w) => { const r = rutaDeWindows(conCasa(w)); try { return rutaDeWindows(fs.realpathSync(r)); } catch (_) { return r; } };
  return real(a) === real(b);
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
    // nombrar a la coordinadora: sin frase, con el click del dueño; con `--quote` (aun vacío), la frase de respaldo, que
    // confirma después confirm-designation
    if (sub === 'designate-relay') return pide('--quote') ? null : 'designation-set';
    if (sub === 'withdraw-relay') return 'designation-withdraw';
    // declarar o cambiar el arreglo rápido; mirarlo o terminarlo, no. El subcomando en una variable cuenta como `set`
    if (sub === 'adhoc' && a[0] === 'set') return firmaDelPedidoAdhoc(args.slice(1));
    // dejar pasar el freno de los datos; recomendar la historia o descartar no firma nada
    if (sub === 'adhoc' && a[0] === 'allow-data-change') return opaca || (a.includes('--recommends') && a[a.indexOf('--recommends') + 1] === 'pasar') ? 'adhoc-lane:datos' : null;
    if (sub === 'adhoc' && /[$`]/.test(a[0] || '')) return SOBRE_CUPO;
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
  if (guion === 'delegated-signing.js') return sub === 'confirm-designation' ? DESIGNACION : null;
  return null;
}

/** Los llamados a e2e-setup.js, run-base-controls.sh y delegated-signing.js de un comando (los de marker.js los lee marker-command.js). */
function llamadosSueltos(comando, hondo = 0) {
  const fuera = [];
  if (hondo > 3 || !/e2e-setup|run-base-controls|delegated-signing/i.test(comando)) return fuera;
  const t = markerCommand().tramos(String(comando), 'bash');
  for (const tr of t.tramos) {
    const w = tr.palabras;
    for (let i = 0; i < w.length; i++) {
      const b = base(w[i].texto);
      if (b === 'e2e-setup.js' || b === 'run-base-controls.sh' || b === 'delegated-signing.js') {
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

/** El valor de `--repo` del comando canónico (la carpeta del pendiente que se aprueba); null si no está. */
function repoDe(palabras) {
  const i = palabras ? palabras.indexOf('--repo') : -1;
  return i >= 0 ? palabras[i + 1] || null : null;
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

// «Qué hace» de las firmas sin fuente propia (signature-sources.js): lo que hace el comando, en llano
function detalleDe(id, comando, palabras, cwd, casa) {
  if (id === DESIGNACION) {
    try {
      const d = require(path.join(LIB, 'critical-waivers.js')).designacionVigente({ dir: stateDir(casa === undefined ? casaDeLaCuenta() : casa) });
      if (d && !d.error) return `la sesión designada: «${una(d.rol, 60)}» (${d.sesion}), desde ${d.ts}, ${d.cita ? `con la frase «${una(d.cita, 200)}»` : 'por click'}`;
    } catch (_) { /* sin leerla, el comando; el guion la vuelve a leer y niega si no está */ }
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
function criteriosDelPedido(palabras, cwd, { casa, destino, sesion, memo } = {}) {
  // en una misma consulta del freno el cuadro y el detalle piden lo mismo: calcular la matriz tarda segundos
  const clave = JSON.stringify([palabras, cwd, casa, destino, sesion]);
  if (memo && memo.has(clave)) return memo.get(clave);
  const c = criteriosSinMemo(palabras, cwd, { casa, destino, sesion });
  if (memo) memo.set(clave, c);
  return c;
}

function criteriosSinMemo(palabras, cwd, { casa, destino, sesion }) {
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
    if (!c.error && !pedidos) c = wd.criteriosDe(abs, c.matrix.notVerifiable || [], c.matrix);
  } catch (e) { return { error: `no pude armar los criterios (${una((e && e.message) || String(e), 200)})` }; }
  if (c.error) return { error: `no pude armar los criterios: la matriz no computa (${una(c.error, 200)})` };
  const faltan = (pedidos || []).filter((n) => !c.lista.some((x) => x.ac === n));
  if (faltan.length) return { error: `el AC ${faltan.join(', ')} no es un criterio pendiente de firma en ${path.basename(abs)}` };
  if (!c.lista.length) return { error: `${path.basename(abs)} no tiene criterios pendientes de firma` };
  return { lista: c.lista, historia: abs, texto: `los criterios a eximir: ${c.lista.map((x) => `AC ${x.ac}: ${una(x.text || '(sin texto en la historia)', 300)} · por qué no se prueba en vivo: ${una(x.reason || '(sin razón declarada)', 200)} · lo cubre: ${una(x.coveredBy || '(ninguna prueba declarada)', 100)}`).join(' | ')}` };
}

/** El comando de la terminal; para un guion, con la sesión: en la terminal del dueño no hay variable de sesión. */
function terminalDe(ids, sesion) {
  const t = [...new Set(ids.map((id) => (firmaDe(id) || {}).terminal).filter(Boolean))].join(' · ');
  const guion = ids.some((id) => (firmaDe(id) || {}).kind === 'guion');
  return t && guion && sesion && SESION.test(sesion) ? `${t}, con --for-session ${sesion}` : t;
}
// lo irreversible: sigue en la terminal aunque la persona apruebe en la pestaña, porque no tiene vuelta atrás
const TERMINAL_SIEMPRE = new Set(ONLY_IN_TERMINAL);
const vaATerminal = (ids) => ids.some((id) => TERMINAL_SIEMPRE.has(id) || ((firmaDe(id) || {}).covers || []).some((c) => TERMINAL_SIEMPRE.has(c)));

// la razón que declaró un criterio para no probarse en vivo, o null si no declaró ninguna
const SIN_RAZON = '(sin razón declarada)';
const razonDeclarada = (x) => { const r = una(x && x.reason); return r && r !== SIN_RAZON ? r : null; };
// cuánto entra en lo que se aprueba: owner-approvals.js `cuadroDe` lo corta ahí, antes de sumarle «¿» y «?»
const LARGO_DE_LO_QUE_SE_APRUEBA = 200;

/**
 * Lo que se aprueba en el cuadro de `runtime-waiver`, con la razón que declararon sus criterios: la que comparten todos,
 * o que cada uno tiene la suya. La razón se recorta antes que el cuadro, así el corte no se come la comilla que la cierra.
 */
function queDeLaExcepcion(lista) {
  const nums = [...new Set(lista.map((x) => x.ac))].sort((a, b) => a - b);
  const acs = nums.length > 1 ? `los AC ${nums.slice(0, -1).join(', ')} y ${nums[nums.length - 1]}` : `el AC ${nums[0]}`;
  const inicio = `aceptar sin prueba en vivo ${acs.length > 80 ? `${nums.length} criterios` : acs}`;
  const razones = [...new Set(lista.map(razonDeclarada))];
  if (razones.length > 1) return `${inicio}, cada uno por la razón que declaró`;
  if (razones[0] === null) return `${inicio}, sin razón declarada`;
  const lugar = LARGO_DE_LO_QUE_SE_APRUEBA - `${inicio}, porque «»`.length;
  // `una` agrega «…» después de lo que deja: deja uno menos
  return `${inicio}, porque «${una(razones[0], lugar - 1)}»`;
}

// el renglón de un criterio en el cuadro de `runtime-waiver`: la razón va primero, porque el renglón se corta a 200 y, al
// final, no llegaba a verse
const renglonDeLaExcepcion = (x) => `AC ${x.ac}: por qué no se prueba en vivo: ${una(razonDeclarada(x) || 'sin razón declarada', 150)}; lo cubre: ${una(x.coveredBy || '(ninguna prueba declarada)', 60)}; el criterio: ${una(x.text || '(sin texto en la historia)', 200)}`;

/**
 * El cuadro de opciones de una firma, armado por este módulo y no por el agente (owner-approvals.js `cuadroDe`). El mismo
 * comando da el mismo cuadro: la huella y el detalle salen de sus palabras sin la ruta del guion ni `--for-session`, así da
 * igual si lo corre la sesión destino o la coordinadora. `{ pregunta, sello, opciones }` o `{ error }`.
 */
function cuadroPara({ firma, comando, palabras, destino, cwd, casa, sesion, memo }) {
  const s = firmaDe(firma);
  if (!s) return { error: `«${firma}» no es una firma` };
  const i = palabras ? palabras.indexOf('--for-session') : -1;
  const sinDestino = palabras ? palabras.filter((w, k) => i < 0 || (k !== i && k !== i + 1)) : null;
  const texto = sinDestino ? [base(sinDestino[0]), ...sinDestino.slice(1)].join(' ') : String(comando).trim();
  let m = null;
  try { m = casa === undefined || !destino ? null : marcadorEn(path.join(stateDir(casa), 'active', `${destino}.json`)); } catch (_) { m = null; }
  const fuentes = require('./signature-sources.js');
  let partes = fuentes.partesDe({ firma, palabras, cwd, marcador: m, estado: casa === undefined ? null : stateDir(casa), destino });
  // una fuente que dice que no hay nada que firmar: sin cuadro, el pedido se niega
  if (partes && partes.error) return { error: partes.error };
  if (firma === 'runtime-waiver') {
    const c = criteriosDelPedido(palabras, cwd, { casa, destino, sesion, memo });
    if (c.error) return { error: c.error };
    const lineas = c.lista.map(renglonDeLaExcepcion);
    partes = { criterios: c.lista.map((x) => x.ac), queHace: lineas, completo: c.historia, fuente: lineas.join('\n'), que: queDeLaExcepcion(c.lista) };
  }
  if (!partes) partes = { queHace: [detalleDe(firma, texto, palabras, cwd, casa)], fuente: '' };
  // la huella ata el click a lo que se mostró: el comando y la fuente de la pregunta
  const huella = sha256(`${texto}\0${partes.fuente || ''}`).slice(0, 8);
  return require('./owner-approvals.js').cuadroDe({ firma, destino, que: partes.que || s.approves, historia: fuentes.historiaDe(m), criterios: partes.criterios, queHace: partes.queHace, nota: partes.nota, archivos: partes.archivos,
    completo: partes.completo, revision: partes.revision, siSaleMal: s.ifWrong, cita: partes.cita, huella, soloClick: s.soloClick, clickDelDueno: s.clickDelDueno, descripciones: s.descripciones });
}

/**
 * La aprobación explícita de la persona para la firma pedida (owner-approvals.js): `{ ok, aprobacion, via }` o
 * `{ ok: false, motivo }`. Una por firma: un comando que pide dos no la usa. Lo irreversible no la acepta.
 */
function aprobacionExplicita({ pendientes, sesion, destino, casa, ahora, cwd, aprobaciones, herramienta, cuadro, arbol }) {
  if (vaATerminal(pendientes)) return { ok: false, motivo: 'esto es irreversible y se firma en la terminal' };
  if (pendientes.length !== 1) return { ok: false, motivo: 'un click o un «aprobado» sirve para una sola firma, y este comando pide más de una' };
  if (cuadro.error) return { ok: false, motivo: cuadro.error };
  try {
    const oa = aprobaciones || require('./owner-approvals.js');
    return oa.buscar({ casa, sesion, destino, cuadro, coordinadora: oa.coordinadoraConfirmada(casa), ahora, cwd, herramienta, arbol });
  } catch (e) { return { ok: false, motivo: `no pude leer las aprobaciones (${e.message})` }; }
}

/**
 * La negativa donde la ventana no llega: trae el cuadro armado, que es el camino por defecto, y después las otras dos
 * formas de aprobarlo. Lo irreversible, sólo la terminal. `anotado`: ya quedó en la lista de firmas y una coordinadora
 * viva se lo va a pasar a la persona (`anotarNegativa`): la sesión sólo espera el aviso para repetir el comando.
 */
function negarSinVentana(motivo, ids, sesion, cuadro = null, deFondo = false, anotado = false, coordinadora = null) {
  if (vaATerminal(ids)) return negarCon(motivo, ids, sesion);
  const t = terminalDe(ids, sesion);
  const otraForma = `Si prefiere la terminal: ${t || 'el mismo comando con --terminal'}.`;
  // una sesión que abrió la coordinadora no le muestra el cuadro a la persona (scripts/hooks/background-question-guard.js):
  // se lo manda a la coordinadora, que lo muestra en su pestaña
  const aQuien = coordinadora ? `«${coordinadora.name}» (${coordinadora.sid})` : null;
  if (aQuien && cuadro && cuadro.soloClick) {
    return { decision: 'deny', firmas: ids, cuadro, texto: `${motivo}. Esta sesión la abrió la coordinadora y esta firma sólo la aprueba un click en la pestaña que trabaja: no muestres el cuadro. `
      + `Queda la terminal del dueño (${t || 'el mismo comando con --terminal'}): mandale eso a ${aQuien} por SendMessage, con lo que se decide en tres renglones, y esperá su aviso.` };
  }
  if (aQuien && !anotado && cuadro && !cuadro.error && ids.length === 1) {
    return { decision: 'deny', firmas: ids, cuadro, texto: `${motivo}. Esta sesión la abrió la coordinadora: no le muestres el cuadro a la persona. `
      + `Mandale a ${aQuien} por SendMessage esta pregunta exacta, sin cambiarle una letra: «${cuadro.pregunta}», con las opciones «${cuadro.opciones[0]}» y «${cuadro.opciones[1]}», el comando y lo que se decide en tres renglones. `
      + `Ella la muestra en su pestaña; cuando te avise, repetí el mismo comando. ${otraForma}` };
  }
  if (aQuien && !anotado) {
    return { decision: 'deny', firmas: ids, texto: `${motivo}. Esta sesión la abrió la coordinadora: no le muestres nada a la persona. Corré cada firma sola, en su forma exacta: `
      + `este freno te da la pregunta de cada una, y se la mandás a ${aQuien} por SendMessage con el comando y lo que se decide en tres renglones. ${otraForma}` };
  }
  if (cuadro && cuadro.clickDelDueno && !anotado && !cuadro.error) {
    return { decision: 'deny', firmas: ids, cuadro, texto: `${motivo}. Esto lo aprueba sólo el click del dueño: mostrale AskUserQuestion con una sola pregunta, sin cambiarle una letra: «${cuadro.pregunta}», y las opciones «${cuadro.opciones[0]}» y «${cuadro.opciones[1]}». `
      + `Con su click, repetí el mismo comando. Un «aprobado» escrito no vale. ${deFondo ? 'Si esta sesión corre de fondo, pasale la pregunta y el comando a la coordinadora: la muestra en su pestaña, y con el click repetís el comando acá. ' : ''}${otraForma}` };
  }
  if (cuadro && cuadro.soloClick) {
    return { decision: 'deny', firmas: ids, cuadro, texto: `${motivo}. Esto lo elige la persona con un click en el cuadro de opciones de esta pestaña: mostrale AskUserQuestion con una sola pregunta, sin cambiarle una letra: «${cuadro.pregunta}», y las opciones «${cuadro.opciones[0]}», con la descripción «${cuadro.descripciones[0]}», y «${cuadro.opciones[1]}», con la descripción «${cuadro.descripciones[1]}». `
      + `Con su click, repetí el mismo comando. Un mensaje escrito no vale, ni un click en otra pestaña. ${deFondo ? 'Si nadie mira esta sesión de fondo, queda la terminal. ' : ''}${otraForma}` };
  }
  if (!cuadro || cuadro.error || ids.length !== 1) return { decision: 'deny', firmas: ids, texto: `${motivo}. Esto lo aprueba la persona: corré cada firma sola, en su forma exacta, y este freno te da el cuadro de opciones para mostrarle. ${otraForma}` };
  if (anotado) return { decision: 'deny', firmas: ids, cuadro, texto: `${motivo}. Esto lo aprueba la persona y ya quedó anotado en su lista: no muestres el cuadro ni mandes un mensaje. Cuando te avisen, repetí el mismo comando. ${otraForma}` };
  return { decision: 'deny', firmas: ids, cuadro, texto: `${motivo}. Esto lo aprueba la persona, sin terminal, con el cuadro de opciones: mostrale AskUserQuestion con una sola pregunta, sin cambiarle una letra: «${cuadro.pregunta}», y las opciones «${cuadro.opciones[0]}» y «${cuadro.opciones[1]}». `
    + `Con su click, repetí el mismo comando. ${deFondo ? 'Si esta sesión corre de fondo, pasale el texto y el comando a la coordinadora: lo muestra en su pestaña, y con el click repetís el comando acá. ' : ''}`
    + `No se lo pidas por el chat salvo que el cuadro no se pueda mostrar: en ese caso, tu último mensaje trae «${cuadro.sello}» y ella contesta «aprobado». ${otraForma}` };
}

function negarCon(motivo, ids, sesion) {
  const t = terminalDe(ids, sesion);
  return { decision: 'deny', firmas: ids, texto: `${motivo}. Esta firma se da en tu terminal${t ? `: ${t}` : ''}.` };
}

/**
 * La lista de firmas (signature-list.js): lo que el freno niega con su cuadro a la propia sesión destino queda anotado, y
 * devuelve si la negativa dice «cuando te avisen, repetí». No dejan renglón lo que pide otra sesión, `designation-confirm`,
 * un escape, lo irreversible ni, de fondo, lo que sólo aprueba un click en la propia pestaña: nadie la mira y la
 * coordinadora no lo puede pasar. Nada de esto cambia lo que se decide: si falla, la negativa de siempre.
 */
function anotarNegativa({ casa, sesion, destino, guion, pendientes, comando, palabras, cuadro, cwd, ahora, deFondo, lista = {} }) {
  if (!guion || !palabras || destino !== sesion || pendientes.length !== 1 || pendientes[0] === DESIGNACION || vaATerminal(pendientes) || !cuadro || cuadro.error) return false;
  if (deFondo && (firmaDe(pendientes[0]) || {}).soloClick) return false;
  try {
    return require('./signature-list.js').alNegar({ casa, firma: pendientes[0], titulo: firmaDe(pendientes[0]).approves, sesion, destino, comando, palabras, cwd, ahora, deFondo, ...lista });
  } catch (_) { return false; }
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
  avisarOficina(reg.destino, casa);
  return destino;
}

/** La sesión pasó a esperar o dejó de esperar: la oficina se entera enseguida. El aviso nunca cambia el resultado de la firma. */
function avisarOficina(sesion, casa) {
  try { require('./office-event.js').notify(sesion, casa === undefined ? {} : { home: casa }); } catch (_) { /* la vigilancia de la oficina lo ve después */ }
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

// El chequeo antes de la ventana: el freno corre el guion de la firma con esta variable, y el guion comprueba todo lo que
// exige sin escribir nada y sin usar la firma. Si se negaría, la ventana no se abre: un «Sí» del dueño que el guion
// rechaza después es una firma perdida.
const PRECHEQUEO = 'TYCON_SIGN_PRECHECK';
const PRECHEQUEO_OK = 'tycon-sign-precheck: ok';
// por dónde llegó la aprobación que el freno va a gastar (`click` o `mensaje`), para el chequeo previo; vacía sin aprobación
const PRECHEQUEO_VIA = 'TYCON_SIGN_PRECHECK_VIA';
// las firmas de guion con requisitos propios; el carril y las firmas sobre un archivo no comprueban nada antes de firmar
// (`adhoc-lane`: el largo del motivo y un tope menor que lo ya tocado se niegan antes de la ventana)
const CON_PRECHEQUEO = new Set(['extra-round', 'save', 'plan-approval', 'control-change', 'refresh-after-main', 'critical-waiver', 'runtime-waiver', 'adhoc-lane', SOBRE_CUPO,
  'manual-test', 'browser-test', 'lost-run', 'adversarial-skip', 'pending-approval', 'escape:force-manual', 'escape:trust-ran',
  // nombrar sin id de sesión, o retirar desde una sesión que no es la coordinadora, se niega sin gastar el click
  'designation-set', 'designation-withdraw',
  // dejar pasar el freno de los datos sin un freno anotado, o con un texto que el guion no acepta
  'adhoc-lane:datos']);
// las de sólo click cuyo chequeo corre antes de dar el cuadro (el de pasar el tope corre después del click)
const CHEQUEO_ANTES_DEL_CUADRO = new Set(['designation-set', 'designation-withdraw', 'adhoc-lane:datos']);
// lo que espera el chequeo: el ok de guardar corre además los controles del commit de cada repo, con su propio plazo de
// 210 s (lib/save-ok.js)
const PLAZO_DEL_CHEQUEO = { save: 240000 };
// el de las demás: menos que los 20 s del freno entero, que antes calcula los criterios y después valida el click. Si el
// guion no contesta a tiempo, la ventana se abre como siempre y el guion vuelve a comprobar todo al firmar
const PLAZO_DEL_PRECHEQUEO_MS = 12000;

/**
 * Corre en modo de chequeo el guion de este mismo árbol que nombran las `palabras` (las de la forma canónica), en la
 * carpeta del evento, con la sesión del evento y la casa de la cuenta: `{ ok: true }` si el guion llegó a la firma con todo en regla,
 * `{ niega: <lo que dijo> }` si se negó antes, null si no contestó (y la ventana se abre como siempre).
 */
function comprobarConElGuion({ firma, palabras, cwd, sesion, casa, env, via = null }) {
  // el de los controles de la base vive en scripts/ci y es de la consola; los demás, al lado del pipeline y de node
  const nombre = base(palabras[0]);
  const sh = nombre.endsWith('.sh');
  const guion = sh ? path.join(__dirname, '..', 'ci', nombre) : path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', nombre);
  const r = require('child_process').spawnSync(sh ? 'bash' : process.execPath, [guion, ...palabras.slice(1)], { cwd: cwd || process.cwd(), encoding: 'utf8', timeout: PLAZO_DEL_CHEQUEO[firma] || PLAZO_DEL_PRECHEQUEO_MS,
    env: { ...(env || process.env), ...(casa ? { HOME: casa, USERPROFILE: casa } : {}), [PRECHEQUEO]: '1', [PRECHEQUEO_VIA]: via || '', ...(sesion ? { CLAUDE_CODE_SESSION_ID: sesion } : {}) } });
  if (r.error || r.status === null) return null;
  if (r.status === 0) return String(r.stdout).split('\n').includes(PRECHEQUEO_OK) ? { ok: true } : null;
  return { niega: String(r.stderr || r.stdout || `salió ${r.status}`).trim() };
}

// lo que en una pestaña sin permisos se hace sin firma y queda «hecho y avisado»: autorizaciones de rutina, no lo que
// afloja un control (cambiar el estado, cerrar una corrida perdida, subir el tope de un arreglo rápido siguen con firma)
const RUTINA_SIN_PERMISOS = new Set(['pending-approval', 'save', 'plan-approval', 'adhoc-lane']);
// las que avisan a la persona desde los controles de la delegación de su propio guion (save-ok.js, marker.js adhoc)
const AVISA_SU_GUION = new Set(['save', 'adhoc-lane']);

/**
 * ¿La firma pedida en una pestaña sin permisos es de rutina? `{ ok }` o `{ ok: false, motivo }`. Va sola, sin escapes;
 * un arreglo rápido que ya existe no sube su tope (el que se pide sin `maxFiles` conserva el que tenía).
 */
function rutinaSinPermisos({ guion, pendientes = [], palabras, destino, casa }) {
  if (!guion || !RUTINA_SIN_PERMISOS.has(guion) || pendientes.length !== 1 || pendientes[0] !== guion) return { ok: false, motivo: null };
  if (guion !== 'adhoc-lane') return { ok: true };
  let pedido;
  try { pedido = JSON.parse((palabras || [])[3]); } catch (_) { return { ok: false, motivo: 'no pude leer el arreglo rápido que se pide' }; }
  let existente = null;
  try { existente = JSON.parse(fs.readFileSync(path.join(stateDir(casa), 'adhoc', `${destino}.json`), 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') return { ok: false, motivo: 'no pude leer el arreglo rápido que ya tiene la sesión' };
  }
  if (existente && pedido && pedido.maxFiles !== undefined && Number(pedido.maxFiles) > Number(existente.maxFiles)) {
    return { ok: false, motivo: `subir el tope del arreglo rápido (de ${existente.maxFiles} a ${pedido.maxFiles} archivos) sigue siendo una firma` };
  }
  const pasa = pasaDelCupoDelegado(palabras);
  return pasa ? { ok: false, motivo: pasa } : { ok: true };
}

/**
 * Por qué un `adhoc set` no entra en el cupo de lo que se abre sin una persona (la delegación, o «hecho y avisado»), o null.
 * Recortarlo callado le daría un arreglo que no pidió: se niega, y el freno da el cuadro para que lo apruebe una persona.
 */
function pasaDelCupoDelegado(palabras) {
  if (!palabras || palabras[1] !== 'adhoc' || palabras[2] !== 'set') return null;
  let pedido;
  try { pedido = JSON.parse(palabras[3]); } catch (_) { return null; }
  const tope = require(path.join(LIB, 'story-gate.js')).DELEGATED_ADHOC_MAX_FILES;
  return pedido && Number(pedido.maxFiles) > tope ? `pedir ${Number(pedido.maxFiles)} archivos supera los ${tope} archivos que se abren sin una persona` : null;
}

/**
 * Lo que decide el freno ante un evento: `{ decision: 'ask' | 'deny' | 'allow' | 'none', texto, firmas, via? }`.
 * `escapes`: las firmas `freno` que el freno de seguridad vio en el comando (los escapes por variable y con nombre).
 * `aprobaciones`: el módulo de la aprobación explícita (owner-approvals.js), para las pruebas.
 * `delegacion(opciones)`: si la firma corre sin ventana (delegated-signing.js, las dos listas del perfil);
 * `clasificar(palabras, cwd)`: la clase de un `approve` con `--base`; `comprobar(opciones)`: el chequeo antes de la
 * ventana (`comprobarConElGuion`); `arbol` y `casa` se leen si faltan. `plataforma`: la de la máquina; se pasa en las
 * pruebas de la forma de Windows, y no se saca del ambiente. `lista`: `{ arnes, env }` para leer la llave de la lista de
 * firmas; se pasa en las pruebas.
 */
function decidir({ evento = {}, escapes = [], arbol, pid = process.pid, casa, ahora = Date.now(), delegacion, clasificar = clasificarConElGuion, comprobar = comprobarConElGuion, userInfo, aprobador = approverOf, aprobaciones, plataforma = process.platform, gitBash = buscarGitBash, lista } = {}) {
  const enWindows = plataforma === 'win32';
  // los criterios de un runtime-waiver, calculados una vez para el cuadro y para el detalle
  const criterios = new Map();
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
  // Codex: sin ventana de permiso, y la aprobación explícita (owner-approvals.js) todavía no tiene su lado. El cuadro de
  // Codex (`request_user_input`) en el modo normal pide la bandera `features.default_mode_request_user_input`
  if (evento.turn_id) return negar('Codex no tiene ventana de permiso: pedirla deja correr el comando', pedidas);
  // se niega acá, antes de mirar las aprobaciones: el click no se gasta en un comando que el guion no puede comprobar
  if (enWindows && herramientaDelEvento !== 'Bash') {
    const seguir = gitBash().path ? 'corré la firma por la consola Bash de la herramienta, o con --terminal' : SIN_GIT_BASH;
    return negar(`la línea de la consola PowerShell no dice qué comando corre, así que no se puede comparar con lo aprobado: ${seguir}`, pedidas);
  }
  // el motivo del arreglo rápido es texto libre y puede nombrar un flag o una variable: en la forma canónica, los dos
  // controles de abajo miran el comando sin ese argumento (un flag o una variable de verdad siguen a la vista)
  const canAdhoc = canonicaDe(comando);
  const mirado = canAdhoc && (canAdhoc.id === 'adhoc-lane' || canAdhoc.id === SOBRE_CUPO) && canAdhoc.palabras[1] === 'adhoc' && canAdhoc.palabras[2] === 'set'
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
  if (enWindows && escapes.length) return negar('en Windows un escape no se aprueba en la pestaña', pedidas);
  // el guion de consola se identifica con el número de proceso de Git Bash, que no es el de Windows: nunca se comprobaría
  if (enWindows && can && base(can.palabras[0]).endsWith('.sh')) return negar('en Windows un guion de consola no se puede comprobar en la pestaña', pedidas);
  if (casa === undefined) {
    try { casa = casaDeLaCuenta(userInfo ? { userInfo } : undefined); } catch (e) { return negar(`no se pudo resolver la casa de la cuenta (${e.message})`, pedidas); }
  }
  let pendientes = pedidas;
  // el árbol: la herramienta, sin otra herramienta ni consola por arriba, con pantalla y sin consolas de fondo
  arbol = arbolDeLaPlataforma(arbol, plataforma);
  if (!arbol) return negar('no pude leer los procesos de la máquina', pendientes);
  const arriba = padres(arbol, pid);
  const i = arriba.findIndex(esHerramienta);
  if (i < 0) return negar('no encontré el proceso de la herramienta', pendientes);
  const tool = arriba[i];
  // una sesión de fondo (`claude --bg`) corre debajo de sus anfitriones (el daemon y la terminal virtual): no son otra
  // herramienta, pero la ventana de permiso no le llega a nadie seguro. Ahí sólo vale la aprobación explícita
  const esConsola = (p) => (enWindows ? esConsolaDeWindows(p) : desenvolver(p.comando, casa) !== null);
  const otra = (p) => (esHerramienta(p) && !esAnfitrionDeFondoDe(tool, p, arriba[i + 1])) || esConsola(p);
  if (arriba.slice(i + 1).some(otra)) return negar('la herramienta la lanzó otra herramienta o su consola', pendientes);
  const deFondo = arriba.slice(i + 1).some(esHerramienta);
  if (sinPantalla(tool)) return negar('la sesión no tiene pantalla (-p o --print): no hay ventana', pendientes);
  // una consola de fondo frena, salvo el owner-wait de la coordinadora (sólo en Mac y Linux: en Windows no se midió)
  const viva = (p) => (enWindows ? esConsolaVivaDeWindows(p) : esConsola(p) && !esOwnerWait(desenvolver(p.comando, casa)));
  if (arbol.some((p) => p.ppid === tool.pid && viva(p))) return negar('cerrá los procesos de fondo o firmá desde tu terminal: hay una consola de fondo viva', pendientes);
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
  // en Windows no se delega: sólo firman el click y el «aprobado»
  // lo que sólo aprueba un click en la pestaña que trabaja no se delega, aunque el perfil lo nombre, y tampoco va a la ventana
  const soloClick = pendientes.length === 1 && !!(firmaDe(pendientes[0]) || {}).soloClick;
  // lo que aprueba sólo el click del dueño tampoco se delega ni va a la ventana; su click vale también en la coordinadora
  const clickDelDueno = pendientes.length === 1 && !!(firmaDe(pendientes[0]) || {}).clickDelDueno;
  if (!enWindows && !soloClick && !clickDelDueno) try {
    const estado = stateDir(casa);
    const rs = pendientes.map((id) => delegacion({ firma: id, sesion, destino, home: casa, estado, cwd: evento.cwd, repo: repoDe(can && can.palabras) }));
    if (rs.every((r) => r && r.ok)) delegada = rs[0];
    // una firma que el perfil delega y no se delegó lleva su motivo a la ventana; la que no se delega, no (es lo normal)
    else sinDelegar = rs.map((r) => r && !r.ok && r.motivo).find((m) => m && !/no delega|sólo del dueño|la sesión que implementa/.test(m)) || null;
  } catch (e) { return negar(`no se pudo consultar la delegación del perfil (${e.message})`, pendientes); }
  const fueraDelCupo = delegada && firmaGuion === 'adhoc-lane' ? pasaDelCupoDelegado(can && can.palabras) : null;
  if (fueraDelCupo) { delegada = null; sinDelegar = fueraDelCupo; }
  // una pestaña que no pide permisos aprueba sola lo que se manda a la ventana: el renglón quedaría a nombre del dueño
  // sin su Sí. Lo que afloja un control se niega ahí, con el comando de la terminal; lo de rutina se hace y queda en el
  // registro como «hecho y avisado» (`rutinaSinPermisos`). Sólo los modos que preguntan llevan a la ventana; uno
  // desconocido no pregunta. Sin el dato, la de siempre
  const modo = evento.permission_mode == null ? null : String(evento.permission_mode);
  const sinVentana = modo !== null && !MODOS_QUE_PREGUNTAN.has(modo);
  // donde la ventana no llega (una pestaña sin permisos, una sesión de fondo), vale la aprobación explícita de la persona:
  // su click en el cuadro de opciones o su «aprobado» escrito (owner-approvals.js), uno por firma. Va antes de «hecho y
  // avisado» y de la delegación: si la persona aprobó, la firma es suya, y lo que la coordinadora no puede firmar por su
  // cuenta (un plan delicado, un guardado que toca algo sensible) pasa
  let aprobada = null;
  let sinAprobacion = null;
  if (delegada || sinVentana || deFondo || enWindows || soloClick || clickDelDueno) {
    const cuadro = pendientes.length === 1 ? cuadroPara({ firma: pendientes[0], comando, palabras: can && can.palabras, destino, cwd: evento.cwd, casa, sesion, memo: criterios }) : null;
    const a = aprobacionExplicita({ pendientes, sesion, destino, casa, ahora, cwd: evento.cwd, aprobaciones, herramienta: { pid: tool.pid, inicio: tool.inicio }, cuadro: cuadro || {}, arbol });
    if (a.ok) { aprobada = a; delegada = null; }
    else if (delegada) sinAprobacion = a.motivo;
    else {
      sinAprobacion = a.motivo;
      // sin aprobación: lo de rutina en una pestaña sin permisos sigue «hecho y avisado»; lo demás se niega y dice cómo
      // aprobarlo. En una sesión de fondo no hay «hecho y avisado»: nadie ve el aviso en la pestaña
      const rutina = rutinaSinPermisos({ guion: firmaGuion, pendientes, palabras: can && can.palabras, destino, casa });
      // nombrar o retirar a la coordinadora: lo que el guion negaría se dice antes del cuadro, sin gastar el click
      if (CHEQUEO_ANTES_DEL_CUADRO.has(firmaGuion)) {
        let c = null;
        try { c = comprobar({ firma: firmaGuion, palabras: can.palabras, cwd: evento.cwd, sesion, casa }); } catch (_) { c = null; }
        if (c && c.niega) return { decision: 'deny', firmas: pendientes, texto: `No abrí la ventana ni te doy el cuadro: el comando se iba a negar antes de usar la firma, y el click se perdería. Lo que dijo: ${una(c.niega, 800)}` };
      }
      if (enWindows || deFondo || !rutina.ok) {
        const donde = soloClick ? (firmaGuion === SOBRE_CUPO ? 'pasar el tope del camino corto no se aprueba en la ventana' : 'esto lo firma el dueño con un click en esta pestaña, no la ventana')
          : clickDelDueno ? 'esto lo firma sólo el click del dueño, no la ventana ni la delegación' : enWindows ? 'en Windows la ventana de permiso no firma' : deFondo ? 'esta sesión corre de fondo: la ventana de permiso no le llega a nadie seguro'
          : `esta pestaña no pide permisos (${una(modo, 40)}): la ventana se aprobaría sola, sin el Sí del dueño`;
        const anotado = anotarNegativa({ casa, sesion, destino, guion, pendientes, comando, palabras: can && can.palabras, cuadro, cwd: evento.cwd, ahora, deFondo, lista });
        // la sesión que abrió la coordinadora le manda el cuadro a ella; lo que no se pudo leer lo anota la función, y sin
        // poder cargarla, el texto de siempre
        let coordinadora = null;
        if (deFondo) {
          try { coordinadora = require('../hooks/background-question-guard.js').coordinadoraDeLaLanzada({ home: casa, sid: sesion }); } catch (e) {
            try { fs.appendFileSync(path.join(stateDir(casa), 'hook-errors.log'), `[${new Date().toISOString()}] owner-window: no cargué el freno de preguntas (${e.message}): el texto de siempre\n\n`); } catch (_) { /* sin registro tampoco */ }
          }
        }
        return negarSinVentana(`${donde}${rutina.motivo && !enWindows ? `, y ${rutina.motivo}` : ''}; ${a.motivo}`, pendientes, paraTerminal, cuadro, deFondo, anotado, coordinadora);
      }
    }
  }
  let avisado = false;
  if (!delegada && !aprobada && sinVentana) avisado = true;
  // los criterios se calculan antes del chequeo del guion, que tiene su propio plazo: así lo que tarda cada uno entra en
  // los 20 s del freno. Lo que contesten se usa más abajo, en el mismo orden de siempre
  if (guion === 'runtime-waiver') criteriosDelPedido(can.palabras, evento.cwd, { casa, destino, sesion, memo: criterios });
  // el guion dice antes si se negaría: entonces no hay ventana ni registro (sin respuesta, la ventana se abre como siempre)
  if (guion && !delegada && CON_PRECHEQUEO.has(firmaGuion)) {
    let c = null;
    try { c = comprobar({ firma: firmaGuion, palabras: can.palabras, cwd: evento.cwd, sesion, casa, via: aprobada ? aprobada.via : null }); } catch (_) { c = null; }
    if (c && c.niega) {
      return { decision: 'deny', firmas: pendientes, texto: `No abrí la ventana: el comando se iba a negar antes de usar la firma, y el «Sí» se perdería. Lo que dijo: ${una(c.niega, 800)}. Arreglá eso y volvé a pedirla` };
    }
  }
  // la ventana dice la misma pregunta que el cuadro de opciones y la lista de firmas (sin el sello); los criterios de
  // un runtime-waiver salen de la memoria de esta consulta
  const vista = pendientes.length === 1 ? cuadroPara({ firma: pendientes[0], comando, palabras: can && can.palabras, destino, cwd: evento.cwd, casa, sesion, memo: criterios }) : null;
  if (vista && vista.error) return negar(vista.error, pendientes);
  // la aprobación explícita se gasta recién acá, cuando el comando ya no se va a negar, y antes de escribir el pedido:
  // nunca queda un pedido vigente con una aprobación sin gastar. Si el pedido no se puede escribir, se devuelve
  const oa = aprobada ? (aprobaciones || require('./owner-approvals.js')) : null;
  if (aprobada) {
    const u = oa.consumir(casa, aprobada.aprobacion, { ahora, firma: pendientes[0], sesion });
    if (!u.ok) return negarSinVentana(u.motivo, pendientes, paraTerminal);
  }
  if (guion) {
    try {
      escribirRegistro(casa, { firma: firmaGuion, sesion, destino, tool_use_id: evento.tool_use_id == null ? null : String(evento.tool_use_id),
        sha256: sha256(comando), comando, herramienta: { pid: tool.pid, inicio: tool.inicio }, ts: new Date(ahora).toISOString(), corrida: corridaDe(casa, destino),
        ...(delegada ? { via: 'delegacion', maquina: delegada.maquina } : aprobada ? { via: aprobada.via, aprobacion: aprobada.aprobacion.id, aprobada_en: aprobada.aprobacion.sesion }
          : avisado ? { via: 'avisado' } : {}), ...(sinAprobacion ? { sin_aprobacion: una(sinAprobacion, 300) } : {}), ...(refirmaDe ? { refirma_de: refirmaDe } : {}) });
    } catch (e) {
      if (aprobada) oa.devolver(casa, aprobada.aprobacion);
      return negar(`no se pudo escribir el registro de la ventana (${e.code || e.message})`, pendientes);
    }
  }
  if (delegada) return { decision: 'allow', via: 'delegacion', relevo: sesion, firmas: pendientes, texto: 'firmada por la delegación del perfil' };
  if (aprobada) {
    const como = aprobada.via === 'click' ? 'tu click en el cuadro de opciones' : `tu mensaje «${una(aprobada.aprobacion.texto, 80)}»`;
    return { decision: 'allow', via: aprobada.via, relevo: sesion, firmas: pendientes, texto: `aprobada por ${como}: ${firmaDe(pendientes[0]) ? firmaDe(pendientes[0]).approves : pendientes[0]}` };
  }
  if (avisado) {
    return { decision: 'allow', via: 'avisado', relevo: sesion, firmas: pendientes,
      texto: `hecho y avisado: esta pestaña no pide permisos, así que ${firmaDe(firmaGuion).approves} se hace sin firma, con los controles de la delegación, y queda en el registro de firmas` };
  }
  const pregunta = vista ? vista.texto
    : `${pendientes.map((id) => firmaDe(id).approves).join('; ')}. Story ${storyDe(casa, destino)}, sesión ${destino}. El comando: ${una(comando)}.`;
  const texto = `${aprobador(evento.cwd).label}: ${pregunta} `
    + (sinDelegar ? `No se firmó por delegación: ${una(sinDelegar, 200)}. ` : '')
    + `Si preferís, firmala en tu terminal: ${terminalDe(pendientes, destino)}.`;
  return { decision: 'ask', firmas: pendientes, texto };
}

// --- el guion -----------------------------------------------------------------------------------------------------

function mismoArchivo(a, b) {
  const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };
  return real(a) === real(b);
}

/** Cómo pasa con la persona una firma que el pedido `reg` no pudo dar sin ella: con el cuadro armado para ese comando. */
function comoAprobar(firma, reg, casa) {
  const c = cuadroPara({ firma, comando: reg.comando, palabras: canonica(reg.comando), destino: reg.destino || reg.sesion, cwd: process.cwd(), casa, sesion: reg.sesion });
  const cuadro = c.error ? 'el cuadro de opciones (corré el comando sólo con la persona a la vista y este freno te lo da)' : `este cuadro de opciones, sin cambiarle una letra: «${c.pregunta}», con «${c.opciones[0]}» y «${c.opciones[1]}»,`;
  return `Si lo que frena es que no firma una persona: mostrale ${cuadro} y, con su click, repetí el mismo comando${reg.sin_aprobacion ? ` (ahora: ${reg.sin_aprobacion})` : ''}`;
}

/**
 * ¿El guion de `firma` (proceso `pid`, argumentos `argv` desde el guion) viene del «Sí» de una ventana? `{ ok, registro }`
 * consume el registro; `{ ok: false, motivo }` no escribe nada.
 */
function verificar({ firma, argv = [], pid = process.pid, arbol, casa, ahora = Date.now(), userInfo, sesion, destino, antes, plataforma = process.platform, gitBash = buscarGitBash, terminal = null } = {}) {
  const enWindows = plataforma === 'win32';
  const s = firmaDe(firma);
  // `terminal`: el comando entero de la terminal, cuando el guion lo sabe armar (con su ruta y sus argumentos)
  const no = (m) => ({ ok: false, motivo: `esta firma no pasó por la ventana: ${m}. Pedila de nuevo: el comando solo, en su forma exacta; en una pestaña sin permisos se aprueba con un click en el cuadro de opciones o con un «aprobado» escrito. O en tu terminal: ${terminal || (s && s.terminal) || 'el mismo comando con --terminal'}` });
  if (!s || s.kind !== 'guion') return no(`«${firma}» no es una firma de guion`);
  if (casa === undefined) {
    try { casa = casaDeLaCuenta(userInfo ? { userInfo } : undefined); } catch (e) { return no(`no se pudo resolver la casa de la cuenta (${e.message})`); }
  }
  arbol = arbolDeLaPlataforma(arbol, plataforma);
  if (!arbol) return no('no pude leer los procesos de la máquina');
  const m = porPid(arbol);
  let yo = m.get(pid);
  // el piso de Node relanza el guion con el Node del arnés: su padre es el mismo guion con el Node viejo
  // (el relanzado lleva la ruta entera del guion; el padre, la que escribió la consola)
  const llamado = (p) => {
    const w = (enWindows ? palabrasDeWindows(p && p.comando) : String((p && p.comando) || '').trim().split(/\s+/)) || [];
    const programa = base(w[0]);
    return { node: NODES.has(enWindows ? programa.replace(/\.exe$/, '') : programa), guion: base(w[1]), resto: w.slice(2).join(' ') };
  };
  const padre = yo && m.get(yo.ppid);
  if (padre) {
    const a = llamado(padre);
    const b = llamado(yo);
    if (a.node && b.node && GUIONES.has(b.guion) && a.guion === b.guion && a.resto === b.resto) yo = padre;
  }
  let comando;
  let tool;
  if (enWindows) {
    const c = consolaDeWindows(m, yo, casa);
    if (c.motivo) return no(gitBash().path ? c.motivo : `${c.motivo}; ${SIN_GIT_BASH}`);
    ({ comando, tool } = c);
  } else {
    const consola = yo && m.get(yo.ppid);
    comando = consola ? desenvolver(consola.comando, casa) : null;
    if (comando === null) return no('el guion no lo lanzó la consola de la herramienta');
    tool = m.get(consola.ppid);
    if (!tool || !esHerramienta(tool)) return no('la consola no es de la herramienta');
  }
  const can = canonicaDe(comando);
  // la refirma tras traer main es el mismo comando que el cambio de control
  if (!can || (can.id !== firma && !(firma === REFIRMA && can.id === CONTROL))) return no('el comando no tiene la forma canónica de la firma');
  const esperado = can.palabras;
  // la consola expande `~/` al principio de cada palabra, con su HOME
  const conTilde = (w, a) => w === a || (w.startsWith('~/') && [casa, os.homedir()].some((h) => path.join(h, w.slice(2)) === a));
  const guion = esperado[0].startsWith('~/') ? path.join(casa, esperado[0].slice(2)) : esperado[0];
  const iguales = enWindows
    ? argv.length === esperado.length && mismaRutaDeWindows(esperado[0], argv[0], casa)
      && esperado.slice(1).every((w, k) => w === String(argv[k + 1]) || (/^(~|\/[A-Za-z])\//.test(w) && mismaRutaDeWindows(w, argv[k + 1], casa)))
    : argv.length === esperado.length && mismoArchivo(guion, argv[0]) && !esperado.slice(1).some((w, k) => !conTilde(w, String(argv[k + 1])));
  if (!iguales) return no('los argumentos del guion no son los del comando');
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
    // en Windows el pedido tiene que venir de una aprobación ya dada
    if (enWindows && !VIAS_DE_WINDOWS.has(reg.via)) continue;
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
    let previo = null;
    if (antes) {
      // lo hecho y avisado en una pestaña sin permisos pasa por los mismos controles que la delegación
      const sinPersona = ['delegacion', 'avisado'].includes(ultimo.reg.via);
      previo = antes(sinPersona ? 'delegacion' : 'ventana', ultimo.reg);
      // lo que no se firma sin la persona dice cómo se aprueba con ella, y por qué no contó lo que ya hubiera aprobado
      if (previo && previo.codigo) return { ok: false, codigo: previo.codigo, motivo: sinPersona ? `${previo.motivo}. ${comoAprobar(firma, ultimo.reg, casa)}` : previo.motivo };
    }
    try { fs.renameSync(path.join(dir, ultimo.f), path.join(dir, `${ultimo.f}.consumido-${ahora}`)); } catch (_) { return no('el pedido de la ventana ya se usó'); }
    for (const v of viejos) { try { fs.renameSync(path.join(dir, v.f), path.join(dir, `${v.f}.vencido-${ahora}`)); } catch (_) { /* otro guion ya lo movió */ } }
    return { ok: true, registro: ultimo.reg, previo };
  }
  // el «Sí» llegó tarde: el pedido existe y venció. Se repite el comando, que abre otra ventana
  if (vencido !== null) {
    return { ok: false, motivo: `esta firma no pasó por la ventana: la ventana se aprobó ${Math.floor(vencido / 60000)} minutos después de pedirla, y el pedido vence a los ${VENCE_MIN}. Repetí el mismo comando: abre otra ventana` };
  }
  return no(`no hay un pedido vigente de la ventana para este comando${ilegibles ? ` (${ilegibles} registro(s) de la ventana no se pudieron leer)` : ''}`);
}

// la vía de la firma en el registro común (signature-log.js). `revision`: la coordinadora por delegación, respaldada por el
// veredicto aprobado de la revisión automática que ella lanzó (la aprobación del plan)
const VIA_COMUN = { ventana: 'window', terminal: 'terminal', delegacion: 'delegation', revision: 'review', avisado: 'notified', click: 'click', mensaje: 'message' };

/**
 * El renglón `<firma>-signed` del gates.log: cómo se firmó, quién y para quién. Va antes de la constancia del guion.
 * `anotar(renglon)`: el guion que lo escribe en su propio registro (marker.js, con su carpeta de estado).
 * Después, el renglón del registro común de las firmas; si no se puede escribir, avisa y la firma sigue.
 * `persona`, `huella`, `appendSignature` y `avisar` se pasan en las pruebas.
 */
function firmar({ firma, via, sesion = null, destino = null, resumen = '', casa, ahora = Date.now(), anotar, extra, persona, huella, appendSignature, avisar } = {}) {
  // lo que el guion suma al renglón (el ok de guardar, sus huellas) va primero: no pisa quién ni cómo se firmó
  const renglon = { ...(typeof extra === 'function' ? extra({ via, sesion, destino }) : extra || {}), name: `${firma}-signed`, status: 'ok', via, sesion, destino, resumen: una(resumen, 200) };
  if (anotar) anotar(renglon);
  else {
    const dir = stateDir(casa === undefined ? casaDeLaCuenta() : casa);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'gates.log'), `${JSON.stringify({ ts: new Date(ahora).toISOString(), ...renglon })}\n`);
  }
  let quien = via === 'delegacion' ? `coordinadora (sesión ${sesion})` : via === 'revision' ? `coordinadora (sesión ${sesion}), vía revisión automática`
    : via === 'avisado' ? `sesión ${sesion}, en una pestaña sin permisos (hecho y avisado)` : persona;
  if (quien === undefined) { try { quien = os.userInfo().username; } catch (_) { quien = null; } }
  const escribir = appendSignature || require('./signature-log.js').appendSignature;
  // al lado del gates.log que recibió el renglón -signed: el guion que anota lo escribe en la carpeta de estado de su HOME
  const home = casa !== undefined ? casa : anotar ? os.homedir() : undefined;
  let r;
  try {
    r = escribir({ signature: firma, via: VIA_COMUN[via] || via, signer: quien, orderedBy: sesion, target: destino, reason: resumen,
      source: path.basename(process.argv[1] || '') || null, home, now: ahora, huella });
  } catch (e) { r = { ok: false, error: e.message }; }
  if (!r || !r.ok) (avisar || ((m) => console.error(m)))(`⚠️ la firma se dio, pero no quedó en el registro común de firmas: ${(r && r.error) || 'sin respuesta'}`);
  avisarOficina(destino || sesion, home);
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
  avisarOficina(sesion, casa);
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
function porLaVentana({ argv, t, salir = process.exit, aprobador = approverOf }) {
  console.error('🪟 Abro una ventana nueva para la firma: seguí ahí.');
  const v = t.abrir({ programa: process.execPath, script: argv[0], args: argv.slice(1), titulo: aprobador(process.cwd()).label });
  if (v.estado === 'vencida') return { codigo: 1, motivo: `la ventana venció a los ${v.tope} s sin firmar${v.pid ? ` (la ventana arrancó: pid ${v.pid})` : ' (la ventana no llegó a arrancar el comando)'}` };
  if (v.estado !== 'cerrada') return { codigo: 1, motivo: `no pude abrir la ventana (${v.motivo})` };
  salir(v.codigo === 0 ? 0 : (v.codigo || 1));
  return { codigo: v.codigo === 0 ? 0 : (v.codigo || 1), via: 'ventana-nueva' };
}

/**
 * La firma en la terminal del dueño (`--terminal`): `/dev/tty` y «firmo»; en Windows, la ventana nueva y tres palabras.
 * `{ codigo: 0 }` firmó (con `via: terminal`), 1 no firmó, 2 no hay terminal (nada escrito).
 */
function porTerminal({ firma, sesion = null, destino = null, resumen = '', casa, ahora = Date.now(), tty, anotar, extra, aprobador = approverOf } = {}) {
  const s = firmaDe(firma);
  const t = tty || ttyDeVerdad();
  const quien = aprobador(process.cwd());
  if (!t.hay()) return { codigo: 2, motivo: `esta firma se da en ${quien.terminal}, y aquí no hay una` };
  const que = `${quien.label}: ${s ? s.approves : firma}${resumen ? ` (${una(resumen, 200)})` : ''}${destino ? `, sesión ${destino}` : ''}.`;
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
/**
 * El aviso de lo hecho sin firma en una pestaña sin permisos, por los canales de la sesión (`notify.js`). Si no sale, se
 * dice en pantalla: lo hecho ya quedó en el registro de firmas, que es la constancia.
 */
function avisarHecho({ firma, sesion, destino, que, notificar }) {
  const s = firmaDe(firma);
  const texto = `Hecho y avisado: ${s ? s.approves : firma}${destino ? `, sesión ${destino}` : ''}${sesion && sesion !== destino ? ` (lo pidió ${sesion})` : ''}. ${una(que, 200)}`;
  try {
    if (notificar) { notificar(texto); return; }
    const notify = require('./notify.js');
    const s = notify.canalesDeLaSesion();
    if (s.problema) { console.error(`⚠️ hecho y avisado: el aviso no salió (${s.problema}); queda en el registro de firmas`); return; }
    const r = notify.avisar({ canales: s.canales, mail: s.mail, chat: s.chat, texto, lado: 'sesion' });
    if (!r || !r.entregado) console.error('⚠️ hecho y avisado: el aviso no salió por ningún canal; queda en el registro de firmas');
  } catch (e) { console.error(`⚠️ hecho y avisado: el aviso no salió (${e.message}); queda en el registro de firmas`); }
}

function exigir({ firma, argv = process.argv.slice(1), resumen = '', pid = process.pid, arbol, casa, ahora, tty, anotar, propia, salir, antes, extra, aprobador, env, escribir, notificar, avisarSinAprobacion, terminal = null } = {}) {
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
  // el chequeo antes de la ventana (`comprobarConElGuion`): lo que el guion comprueba antes de la firma, y sale sin
  // firmar, sin gastar el pedido y sin hacer lo que la firma autoriza
  const ambienteDelChequeo = env !== undefined ? env : process.env;
  if (ambienteDelChequeo[PRECHEQUEO] === '1') {
    if (antes) {
      // con la aprobación que el freno va a gastar, su vía; sin ella, todavía no hay registro
      const via = ambienteDelChequeo[PRECHEQUEO_VIA];
      const n = antes(argv.includes('--terminal') ? 'terminal' : 'ventana', via ? { via } : null);
      if (n && n.codigo) return { codigo: n.codigo, motivo: n.motivo, destino, sesion: propia || null };
    }
    (escribir || ((t) => process.stdout.write(t)))(`${PRECHEQUEO_OK}\n`);
    (salir || process.exit)(0);
    return { codigo: 0, prechequeo: true, destino };
  }
  if (argv.includes('--terminal')) {
    // sin persona (la CI): no hay terminal que esperar, ni ventana nueva que abrir en Windows. La variable sólo niega: que
    // hay una persona lo dice la terminal de verdad. Con la terminal inyectada (las pruebas), el ambiente es el que se
    // pasa. Sin --terminal no hace falta: la verificación de la ventana ya se niega al instante sin la consola
    const ambiente = env !== undefined ? env : (tty ? {} : process.env);
    if (require(path.join(LIB, 'runtime-waiver.js')).enLaCI(ambiente)) return { codigo: 2, motivo: 'esta firma la da una persona: no sigo (es la CI: CI, TF_BUILD o GITHUB_ACTIONS)', destino };
    const t = tty || ttyDeVerdad();
    if (t.windows && t.enVentana && !t.enVentana()) return { ...porLaVentana({ argv, t, salir, aprobador }), destino };
    if (t.windows && t.enVentana && t.dentro) t.dentro();
    if (antes) {
      const n = antes('terminal', null);
      if (n && n.codigo) return { codigo: n.codigo, motivo: n.motivo, destino, sesion: propia || null };
    }
    const r = porTerminal({ firma, sesion: propia || null, destino, resumen, casa, ahora, tty: t, anotar, extra, aprobador });
    return { ...r, destino, sesion: propia || null };
  }
  const v = verificar({ firma, argv, pid, arbol, casa, ahora, sesion: propia || undefined, destino: destino || undefined, antes, terminal });
  if (!v.ok) return { codigo: v.codigo || 1, motivo: v.motivo };
  // el registro que dejó el freno sin ventana (la delegación del perfil) firma con via: delegacion; si lo que comprobó el
  // guion antes (`antes`) la respalda con la revisión automática, con via: revision y el resumen de la revisión. El de una
  // pestaña sin permisos firma con via: avisado, y se avisa a la persona por los canales de la sesión
  const avisado = v.registro.via === 'avisado';
  const porRevision = !avisado && v.registro.via === 'delegacion' && v.previo && v.previo.via === 'revision';
  const explicita = v.registro.via === 'click' || v.registro.via === 'mensaje';
  const via = avisado ? 'avisado' : porRevision ? 'revision' : v.registro.via === 'delegacion' ? 'delegacion' : explicita ? v.registro.via : 'ventana';
  // una aprobación de la persona que no contó y la delegación firmó igual: quien corrió el comando cree que firmó ella
  if (['delegacion', 'revision', 'avisado'].includes(via) && v.registro.sin_aprobacion && !/^no hay un click/.test(v.registro.sin_aprobacion)) {
    (avisarSinAprobacion || ((t) => process.stderr.write(t)))(`⚠️ no contó la aprobación de la persona, y esto se firmó por ${via}: ${v.registro.sin_aprobacion}\n`);
  }
  const que = (v.previo && v.previo.resumen) || resumen || v.registro.comando;
  firmar({ firma, via, sesion: v.registro.sesion, destino: v.registro.destino, resumen: (porRevision || avisado) ? que : (resumen || v.registro.comando), casa, ahora, anotar, extra });
  // el ok de guardar y el arreglo rápido ya avisaron desde los controles de la delegación de su guion
  if (avisado && !AVISA_SU_GUION.has(firma)) avisarHecho({ firma, sesion: v.registro.sesion, destino: v.registro.destino, que, notificar });
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
  if (via === 'revision') return { tipo: 'automatica', quien: `coordinadora (sesión ${sesion}), vía revisión automática`, delegacion: persona, via: 'revisión automática · coordinadora' };
  if (via === 'avisado') return { tipo: 'automatica', quien: `sesión ${sesion}, en una pestaña sin permisos`, delegacion: persona, via: 'hecho y avisado' };
  if (via === 'click') return { tipo: 'manual', quien: persona, via: 'click en el cuadro de opciones' };
  if (via === 'mensaje') return { tipo: 'manual', quien: persona, via: '«aprobado» escrito' };
  return { tipo: 'manual', quien: persona, via: via === 'terminal' ? 'terminal' : 'ventana' };
}

module.exports = { VENCE_MIN, PRECHEQUEO, PRECHEQUEO_OK, PRECHEQUEO_VIA, PLAZO_DEL_PRECHEQUEO_MS, CON_PRECHEQUEO, comprobarConElGuion, carpeta, quienFirmo, leerArbol, leerArbolWindows, conPadresValidos, arbolDeLaPlataforma, palabrasDeWindows, gitBashDe, desenvolverWindows, esConsolaDeWindows, esHerramienta, desenvolver, canonica, canonicaDe, firmasDelComando, cuadroPara, queDeLaExcepcion, renglonDeLaExcepcion, decidir, verificar, firmar, porTerminal, exigir, fijarDestino, marcadorEn, vencerPedidos,
  rutaReal, firmarArchivo, consumirArchivo, confirmarConsumos, comoSeFirma, esAnfitrionDeFondoDe, negarSinVentana };

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
