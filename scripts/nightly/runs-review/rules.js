'use strict';
/*
 * rules.js — LAS REGLAS DE LA REVISIÓN NOCTURNA DE LAS EJECUCIONES, SIN MODELO Y SIN LEER NI ESCRIBIR ARCHIVOS.
 *
 * `revisar({ volcado, lineasHilo, registros })` mira una ejecución del buzón y dice qué fallas del arnés tuvo, con un
 * código fijo por regla, una categoría de lista cerrada y un conteo. Nada del texto de la conversación sale de acá:
 * quien llama escribe sólo lo que devuelve.
 *
 * 🔴 SÓLO CUENTA LO QUE EL MODELO CORRIÓ. Una regla mira los `tool_use` de las líneas `assistant` y su `tool_result`, y
 *    dentro de cada comando sólo el programa de cada segmento (`segmentos`): un `grep`, un `echo`, un heredoc o un
 *    `git commit -m` que mencionan el texto no corren nada. Las líneas `api-request*` repiten cada comando y el texto del
 *    asistente cuenta lo que pensó: no se leen.
 */
const path = require('path');
const { CATEGORIAS_HOOK } = require('../../metrics/tokens-digest.js');
const STEPS = require('../../../skills/tycon-pipeline/scripts/lib/steps.js');
const INTEGRATIONS = require('../../lib/integrations.js');
const AZ = require('../../lib/az-pr.js');

const CODIGOS = ['RR-HOOK', 'RR-NODE', 'RR-APAGO', 'RR-BANDERA', 'RR-CIERRE', 'RR-ESCAPE'];
// Dónde vive un guion del arnés, en Mac, Linux y Windows: los dos nombres del lugar salen de su constante.
const { PLACE_NAME, LEGACY_PLACE_NAME } = require('../../setup/harness/place.js');
const RUTAS_DEL_ARNES = ['tycon-pipeline/scripts/', 'tycon-pipeline\\scripts\\', `${PLACE_NAME}/`, `${PLACE_NAME}\\`,
  `${LEGACY_PLACE_NAME}/`, `${LEGACY_PLACE_NAME}\\`, '.tycon/harness/', '.tycon\\harness\\'];
// Dónde corre el arnés INSTALADO: su carpeta y las de donde Claude Code y Codex cargan las skills. Un guion del arnés
// fuera de ellas (el clon, un worktree) es una prueba en obra, no una pieza instalada que no carga.
const RUTAS_INSTALADAS = ['.tycon/harness/', '.tycon\\harness\\', '.claude/agent-skills/', '.claude\\agent-skills\\',
  '.claude/skills/', '.claude\\skills\\', '.codex/skills/', '.codex\\skills\\'];
// Desde esta fecha (el merge a main del cambio que la agregó) marker.js deja la constancia del cierre: una ejecución
// archivada antes no la podía tener. La prueba: T64 CierreSinConstancia.
const CIERRE_DESDE = '2026-10-22T21:14:33Z';
// Lo que cuenta aparte: se ve en la ficha, pero no es una falla nueva del arnés. El resumen de la mañana y el ciclo de
// las fichas no lo suman; una categoría fuera de esta lista sigue siendo una falla.
const APARTE = Object.freeze({
  'RR-ESCAPE:GIT_NO_VERIFY/laboratorio': 'un commit sin los hooks de git en una carpeta de laboratorio: pruebas y ensayos, no trabajo de un producto',
  'RR-ESCAPE:PR_A_MANO/sobra': 'el pedido armado con el escape cumplía la regla del freno: el prefijo estaba de más',
  'RR-CIERRE:derivada/arnes-anterior': 'la ejecución se archivó antes de que el arnés dejara la constancia del cierre (8.92)',
  'RR-ESCAPE:ADVERSARIAL_RELAUNCH/dato': 'relanzar el pase adversarial no esquiva nada: el pase corre igual',
  'RR-ESCAPE:SIZE_FORCED_LIGHT_WITH_CODE/con-motivo': 'la ejecución liviana con código trae su motivo: es una decisión anotada',
  'RR-ESCAPE:FULL_SUITE_RUN/laboratorio': 'la suite completa en una carpeta de laboratorio no es la de un repo',
  'RR-NODE:en-obra': 'el guion que no cargó es una prueba del arnés en obra (el clon o un worktree), no una pieza instalada',
});
/**
 * La lista de carpetas de laboratorio es una sola, la de la vista de ejecuciones. Se carga al usarla, sin red: si no
 * carga, el error sale (la pasada termina con error) en vez de contar callada los laboratorios como fallas.
 */
let laboratorio = null;
function esLaboratorio(dir) {
  if (laboratorio === null) laboratorio = require('../dashboard/runs.js').esLaboratorio;
  return Boolean(dir) && laboratorio(dir);
}
// Las variables de escape de los frenos. Dónde las lee el arnés: la tabla «Interruptor» de INSTALL.md
// (TYCON_PR_BY_HAND, TYCON_SAFETY_OFF, TYCON_FULL_SUITE), scripts/setup/hooks-list.json (TYCON_SESSION_GUARD_OK),
// scripts/hooks/engram-pre-commit.sh (TYCON_ENGRAM_MANIFEST_OK), steps/step-08-adversarial-pass.md
// (TYCON_NO_DEEP_REVIEW), scripts/controls-bench/live-fire-stop.js (STOP_AUTONOMY) y
// skills/tycon-pipeline/scripts/runtime-matrix.js (TYCON_RUNTIME_MATRIX_NO_MUTATION_CHECK).
const ESCAPES = ['TYCON_SAFETY_OFF', 'TYCON_PR_BY_HAND', 'TYCON_FULL_SUITE', 'TYCON_SESSION_GUARD_OK', 'TYCON_ENGRAM_MANIFEST_OK',
  'TYCON_RUNTIME_MATRIX_NO_MUTATION_CHECK', 'TYCON_NO_DEEP_REVIEW', 'STOP_AUTONOMY'];
// Una línea de bypass.log y el comando que la dejó son el mismo escape: cuenta la del registro, que trae el motivo.
const EQUIVALENTES = { GIT_NO_VERIFY: '--no-verify', ATDD_BYPASS: 'atddBypass', PR_A_MANO: 'TYCON_PR_BY_HAND', FULL_SUITE_RUN: 'TYCON_FULL_SUITE',
  ADVERSARIAL_SKIP_FORZADO: 'TYCON_NO_DEEP_REVIEW' };
// Los valores con que marker.js prende una bandera (cmdSetFlag) y deja prendido el modo automático (cmdSetAutonomous):
// cualquier otro valor de set-autonomous lo apaga.
const PRENDE_BANDERA = ['true', '1'];
const PRENDE_AUTONOMO = ['true', '1', 'on'];
// Palabras que van antes del programa sin ser el programa: las del shell, `env`, y el operador de llamada de PowerShell.
const ANTES_DEL_PROGRAMA = ['if', 'then', 'do', 'else', 'elif', 'while', 'until', 'time', 'exec', 'command', '!', '&', 'env', '{', '('];
// Envoltorios que corren su programa sin pasarle una asignación (`nice X=1 cmd` corre `X=1` como programa), y las
// opciones de cada uno que llevan valor.
const NO_PASAN = new Set(['nice', 'nohup', 'timeout', 'xargs', 'caffeinate', 'stdbuf', 'ionice', 'chrt', 'taskset']);
const CON_VALOR_DE = {
  nice: new Set(['-n', '--adjustment']), timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  xargs: new Set(['-a', '-E', '-I', '-L', '-n', '-P', '-s', '-d', '--arg-file', '--delimiter', '--max-args', '--max-procs', '--max-chars']),
  stdbuf: new Set(['-i', '-o', '-e']), ionice: new Set(['-c', '-n', '-p']), caffeinate: new Set(['-t', '-w']),
};
// Los envoltorios con un valor suelto antes del programa (la duración, la prioridad, la máscara).
const CON_POSICIONAL = new Set(['timeout', 'chrt', 'taskset']);
// Las opciones de `env` y de `sudo` que llevan su valor aparte (`-P`: la ruta de búsqueda de macOS).
const ENV_CON_VALOR = new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string', '-P']);
const SUDO_CON_VALOR = new Set(['-u', '--user', '-g', '--group', '-C', '--close-from', '-D', '--chdir', '-h', '--host', '-p', '--prompt', '-r', '--role', '-t', '--type', '-U', '--other-user', '-T', '--command-timeout']);

// La acción que antecede a la bandera de cada parte del Arranque (steps/step-01-start.md). Poner la bandera es lo
// normal; ponerla sin que su acción saliera bien es la falla. ADO: el `update` que la pasa a Active, o el `show` del
// camino «ya estaba en Active» (paso 5 del Arranque).
const ACCIONES_DE_PARTE = {
  'time-tracking': (c) => argsDe(c.command, 'pipeline.js').some((r) => r[0] === 'work-signal' && r[1] === 'start')
    || (servidoresDeHoras().some((s) => c.name.startsWith(`mcp__${s}__`)) && /create|start/i.test(c.name)),
  ado: (c) => segmentos(c.command).some((s) => {
    if (s.programa !== 'az') return false;
    const k = s.args.indexOf('boards');
    if (k < 0 || s.args[k + 1] !== 'work-item') return false;
    const sub = s.args[k + 2];
    return sub === 'show' || (sub === 'update' && s.args.some((a) => a === '--state' || a.startsWith('--state=')));
  }),
};

/** Los servidores MCP de las integraciones de horas (`kind: timeTracking` con `mcp.server`): el núcleo no los nombra. */
let servidores = null;
function servidoresDeHoras() {
  if (servidores === null) {
    try { servidores = INTEGRATIONS.listManifests().manifests.filter((m) => m.kind === 'timeTracking' && m.mcp && m.mcp.server).map((m) => m.mcp.server); }
    catch { servidores = []; }
  }
  return servidores;
}

/** Las banderas de las partes del Arranque, con la parte y el nombre de hoy de cada una (la primera de su lista). */
function partesPorBandera() {
  const out = new Map();
  for (const [parte, def] of Object.entries(STEPS.START_PARTS)) for (const f of def.flags || []) out.set(f, { parte, nombre: def.flags[0] });
  return out;
}
const banderasDePartes = () => [...partesPorBandera().keys()];

/**
 * Parte un comando en segmentos de palabras, como lo haría el shell en lo que importa acá: las comillas y la barra
 * invertida agrupan; `&&`, `||`, `;`, `|`, `&`, el salto de línea, los paréntesis, las llaves y `$(` separan; el cuerpo
 * de un heredoc (`<<TAG` fuera de comillas, no `<<<`) se saltea hasta su cierre.
 */
function trozos(command) {
  const segs = [];
  let palabras = [];
  let actual = '';
  let comilla = null;
  let tiene = false;
  let heredoc = null;
  const cerrarPalabra = () => { if (tiene) palabras.push(actual); actual = ''; tiene = false; };
  const cerrarSegmento = () => { cerrarPalabra(); if (palabras.length) segs.push(palabras); palabras = []; };
  const s = String(command || '');
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (comilla === "'") { if (ch === "'") comilla = null; else actual += ch; continue; }
    if (comilla === '"') {
      if (ch === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) { actual += s[i + 1]; i += 1; continue; }
      if (ch === '"') comilla = null; else actual += ch;
      continue;
    }
    // fuera de comillas, la barra invertida escapa sólo lo que el shell trataría distinto; delante de una letra queda
    // (una ruta de Windows sin comillas, `D:\acme\…`, no se desarma)
    if (ch === '\\' && i + 1 < s.length && ' \t\n"\'\\$`;&|()<>{}'.includes(s[i + 1])) { if (s[i + 1] !== '\n') { actual += s[i + 1]; tiene = true; } i += 1; continue; }
    if (ch === '"' || ch === "'") { comilla = ch; tiene = true; continue; }
    if (ch === '<' && s[i + 1] === '<' && s[i + 2] !== '<' && s[i - 1] !== '<') {
      const m = /^<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(s.slice(i));
      if (m) { heredoc = m[1]; i += m[0].length - 1; continue; }
    }
    if (ch === '\n') {
      cerrarSegmento();
      if (heredoc) {
        let j = i + 1;
        for (;;) {
          const fin = s.indexOf('\n', j);
          const linea = s.slice(j, fin < 0 ? s.length : fin);
          if (linea.trim() === heredoc || fin < 0) { i = fin < 0 ? s.length : fin; break; }
          j = fin + 1;
        }
        heredoc = null;
      }
      continue;
    }
    if (ch === ';' || ch === '(' || ch === ')' || ch === '{' || ch === '}' || ch === '`') { cerrarSegmento(); continue; }
    if (ch === '$' && s[i + 1] === '(') { cerrarSegmento(); i += 1; continue; }
    if (ch === '&') { cerrarSegmento(); if (s[i + 1] === '&') i += 1; continue; }
    if (ch === '|') { cerrarSegmento(); if (s[i + 1] === '|') i += 1; continue; }
    if (ch === ' ' || ch === '\t') { cerrarPalabra(); continue; }
    actual += ch; tiene = true;
  }
  cerrarSegmento();
  return segs;
}

/**
 * Cada segmento: sus asignaciones iniciales (`VAR=v`, `export VAR=v`, `$env:VAR=v`, y en PowerShell también
 * `$VAR = v`), su programa y sus argumentos. Un programa o un argumento que nombran una variable asignada antes en el
 * mismo comando (`N=…/node.exe; "$N" …`, la forma de Windows) se leen por su valor. Los envoltorios (`env`, `sudo`,
 * `timeout`, `nice`, …, también por su ruta) se saltean con sus opciones, y el segmento queda `envuelto` (dónde corre
 * ya no es seguro); sólo `env` y `sudo` le pasan sus asignaciones al programa: detrás de los otros, `X=1` es el nombre
 * de un programa. En `valor` va lo asignado en el segmento, por nombre, y en `cadena` el comando de `env -S "…"`.
 */
function segmentos(command) {
  const valores = new Map();
  const expandir = (w) => String(w).replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, n) => (valores.has(n) ? valores.get(n) : m));
  const base = (w) => path.basename(String(w || '').replace(/\\/g, '/')).replace(/\.(exe|cmd)$/i, '');
  return trozos(command).map((p) => {
    const asignaciones = [];
    const valor = {};
    let envuelto = false;
    let pasan = true;
    let cadena = null;
    let i = 0;
    for (;;) {
      const b = p[i] === undefined ? null : base(p[i]);
      const env = b === 'env' && p[i] !== 'env' ? true : b === 'env' && (/^-/.test(p[i + 1] || '') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(p[i + 1] || ''));
      if (env || b === 'sudo' || b === 'doas' || NO_PASAN.has(b)) {
        const r = saltearOpciones(p, i + 1, env ? ENV_CON_VALOR : b === 'sudo' || b === 'doas' ? SUDO_CON_VALOR : CON_VALOR_DE[b] || new Set());
        i = r.i;
        if (r.cadena !== null) cadena = r.cadena;
        // `env -` es `env -i`; `timeout` lleva la duración antes del programa, `chrt` la prioridad y `taskset` la máscara
        let opciones = r.opciones;
        if (env && p[i] === '-') { i += 1; opciones = true; }
        if (CON_POSICIONAL.has(b) && p[i] !== undefined && !/^-/.test(p[i])) i += 1;
        if (!env || opciones) envuelto = true;
        pasan = env || b === 'sudo' || b === 'doas';
        continue;
      }
      // `time -p …` y `exec -a nombre …`: sus opciones no son el programa; `time` le pasa las asignaciones, `exec` no
      if ((b === 'time' || b === 'exec') && /^-/.test(p[i + 1] || '')) {
        i = saltearOpciones(p, i + 1, b === 'exec' ? new Set(['-a']) : new Set()).i;
        if (b === 'exec') pasan = false;
        continue;
      }
      if (ANTES_DEL_PROGRAMA.includes(p[i])) { i += 1; continue; }
      if (!pasan) break;
      if (p[i] === 'export' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(p[i + 1] || '')) { i += 1; continue; }
      const ps = /^\$(?:env:)?([A-Za-z_][A-Za-z0-9_]*)$/.exec(p[i] || '');
      if (ps && p[i + 1] === '=' && p[i + 2] !== undefined) { asignaciones.push(ps[1]); valores.set(ps[1], p[i + 2]); valor[ps[1]] = p[i + 2]; i += 3; continue; }
      const m = /^(?:\$env:|\$)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(p[i] || '');
      if (!m) break;
      asignaciones.push(m[1]);
      valores.set(m[1], m[2]);
      valor[m[1]] = m[2];
      i += 1;
    }
    const crudo = p[i] === undefined ? null : expandir(p[i]);
    const programa = crudo === null ? null : path.basename(crudo.replace(/\\/g, '/')).replace(/\.(exe|cmd)$/i, '');
    return { asignaciones, valor, envuelto, cadena, programa, args: p.slice(i + 1).map(expandir), crudo };
  });
}
/**
 * Saltea las opciones de un envoltorio desde `i`: largas (`--user x`, `--user=x`) y cortas, también juntas (`-iu bob`:
 * la última lleva su valor aparte; `-ubob`: el valor va pegado). Devuelve dónde sigue, si hubo opciones y el valor de
 * `-S`/`--split-string` (el comando que `env` parte).
 */
function saltearOpciones(p, i, conValor) {
  let opciones = false;
  let cadena = null;
  while (/^-/.test(p[i] || '') && p[i] !== '-') {
    opciones = true;
    const t = p[i];
    if (t === '--') return { i: i + 1, opciones, cadena };
    if (t.startsWith('--')) {
      const [nombre, pegado] = t.split(/=(.*)/s);
      const lleva = conValor.has(nombre) && pegado === undefined;
      if (/^--split-string$/.test(nombre)) cadena = lleva ? p[i + 1] : pegado;
      i += lleva ? 2 : 1;
      continue;
    }
    let salto = 1;
    for (let j = 1; j < t.length; j += 1) {
      if (!conValor.has(`-${t[j]}`)) continue;
      const v = j === t.length - 1 ? p[i + 1] : t.slice(j + 1);
      if (t[j] === 'S') cadena = v;
      if (j === t.length - 1) salto = 2;
      break;
    }
    i += salto;
  }
  return { i, opciones, cadena };
}
/** ¿El segmento activa el escape? Cada freno lo toma sólo con `1`. Casos: T3 de scripts/tests/runs-review.test.js. */
const activa = (s, nombre) => s.asignaciones.includes(nombre) && s.valor[nombre] === '1';

/** Lo que sigue a `<guion>` en cada segmento que lo corre (por `node` o el guion mismo): una lista por segmento. */
function argsDe(command, guion) {
  const esGuion = (w) => typeof w === 'string' && w.replace(/\\/g, '/').split('/').pop() === guion;
  const out = [];
  for (const s of segmentos(command)) {
    if (s.programa === 'node') { const k = s.args.findIndex(esGuion); if (k >= 0) out.push(s.args.slice(k + 1)); }
    else if (esGuion(s.crudo)) out.push(s.args);
  }
  return out;
}
/** ¿Algún segmento corre `<guion>` seguido exactamente de `sub`? */
const corre = (command, guion, sub) => argsDe(command, guion).some((r) => sub.every((w, j) => r[j] === w));

// Programas que corren otro programa: lo que corre de verdad viene después, y dónde corre ya no es seguro.
const ENVOLTORIOS = new Set(['sudo', 'doas', 'nice', 'ionice', 'nohup', 'timeout', 'stdbuf', 'xargs', 'env', 'time', 'command', 'exec', 'caffeinate']);
// Lo que cambia la carpeta de una forma que no se lee: después de esto, ninguna carpeta del comando es segura.
const CAMBIA_CARPETA = new Set(['cd', 'pushd', 'popd', 'chdir', 'Set-Location', 'sl', 'Push-Location', 'Pop-Location']);
/** Una carpeta que se puede juzgar como texto: absoluta, sin `.` ni `..` y sin nada que la terminal expanda. */
const carpetaCierta = (d) => typeof d === 'string' && /^(?:\/|[A-Za-z]:[\\/])/.test(d)
  && !/(^|[\\/])\.\.?([\\/]|$)/.test(d) && !/[$`~*?{]/.test(d);
// Las opciones de git antes del subcomando que llevan un valor aparte.
const GIT_CON_VALOR = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

/** El `git` de un segmento, directo o detrás de un envoltorio: `{ args, envuelto }`, o null si no corre git. */
function gitDe(s) {
  // los envoltorios ya los saltea `segmentos`: el programa es el de verdad
  return s.programa === 'git' ? { args: s.args, envuelto: s.envuelto } : null;
}
/** Las opciones de git antes del subcomando: sus `-C`, si nombra otro repo (`--git-dir`, `--work-tree`) y el subcomando. */
function opcionesDeGit(args) {
  const ces = [];
  let otroRepo = false;
  let i = 0;
  while (i < args.length && String(args[i]).startsWith('-')) {
    if (args[i] === '-C') ces.push(args[i + 1]);
    if (/^--(?:git-dir|work-tree)(?:=|$)/.test(args[i])) otroRepo = true;
    i += GIT_CON_VALOR.has(args[i]) ? 2 : 1;
  }
  return { ces, otroRepo, sub: args[i] || null, resto: args.slice(i + 1) };
}

/**
 * Cada segmento con la carpeta donde corre y si se sabe con certeza (`cierta`). La carpeta es la del último `cd <dir>`
 * de antes, o el `-C <dir>` de un `git`; `carpeta: null` con `cierta` es «la de la ejecución». Lo que no se puede
 * saber —un subshell o un `$(…)` en el comando, un `&`, `|` o `||` (el `cd` puede no valer para lo que sigue), un
 * `cd -` o un `cd` sin carpeta, `pushd`/`popd`, dos `-C`, una carpeta relativa o con `..`, un `git` que nombra otro
 * repo (`--git-dir`, `--work-tree`, `GIT_DIR=`), un programa envuelto— deja `cierta: false`, y quien juzga lo cuenta
 * como del repo real: mejor una ficha de más, con su motivo, que un escape que no se ve.
 */
function conCarpeta(command, nivel = 0) {
  const texto = String(command || '');
  // (las redirecciones `2>&1` y `&>` no separan nada)
  const subshell = /[()`]|\$\(/.test(texto) || /&|\|/.test(texto.replace(/&&/g, ' ').replace(/\d*>&\d*-?|&>>?/g, ' '));
  let dir = null;
  let perdida = subshell;
  const out = [];
  for (const s of segmentos(command)) {
    // el segmento cuenta con sus asignaciones (`X=1 bash -c "…"`), y el código que le pasa a un intérprete
    // (`bash -c "…"`, `eval …`, `env -S "…"`) es otro comando: sus segmentos también cuentan, en un lugar no cierto
    out.push(carpetaDe(s));
    if (nivel < NIVELES) for (const cadena of codigosDeUnInterprete(s)) for (const adentro of conCarpeta(cadena, nivel + 1)) out.push({ ...adentro, cierta: false });
  }
  // el cuerpo de un heredoc que se le da a un shell (`bash <<'EOF'`, `sh -s <<EOF`) corre. Se buscan una sola vez, en el
  // texto entero: adentro de una cadena o de otro cuerpo ya están en ese texto, y leerlos de nuevo los contaría dos veces
  if (nivel === 0) for (const cuerpo of heredocsAUnShell(texto)) for (const adentro of conCarpeta(cuerpo, 1)) out.push({ ...adentro, cierta: false });
  return out;

  function carpetaDe(s) {
    if (CAMBIA_CARPETA.has(s.programa)) {
      if (s.programa === 'cd' && s.args.length === 1 && carpetaCierta(s.args[0]) && !perdida) dir = s.args[0];
      else { perdida = true; dir = null; }
    }
    const git = gitDe(s);
    let carpeta = dir;
    let cierta = !perdida;
    if (git) {
      const { ces, otroRepo } = opcionesDeGit(git.args);
      if (git.envuelto || ces.length > 1 || otroRepo || s.asignaciones.some((a) => /^GIT_(?:DIR|WORK_TREE)$/.test(a))) cierta = false;
      else if (ces.length === 1) carpeta = ces[0];
    } else if (ENVOLTORIOS.has(s.programa)) cierta = false;
    if (s.envuelto) cierta = false;
    if (carpeta !== null && !carpetaCierta(carpeta)) cierta = false;
    return { s, carpeta, cierta, git };
  }
}
/** El código que un segmento le pasa a un intérprete (`bash -c "…"`, `sh -lc "…"`, `eval …`), o null. */
function codigosDeUnInterprete(s) {
  const out = [];
  if (s.cadena) out.push(s.cadena);
  if (s.programa === 'eval' && s.args.length) out.push(s.args.join(' '));
  if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(s.programa)) {
    const k = s.args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    if (k >= 0 && s.args[k + 1] !== undefined) out.push(s.args[k + 1]);
  }
  return out;
}
// Hasta cuántos intérpretes uno dentro de otro se lee el código (más adentro, un comando así no es trabajo normal).
const NIVELES = 4;
/** Los cuerpos de los heredocs que se le dan a un shell: `bash <<'EOF'`, `sh -s <<EOF`, `zsh -s -- <<-EOF`. */
function heredocsAUnShell(texto) {
  const out = [];
  // la búsqueda mira el carácter previo sin tomarlo: así encuentra también el heredoc del renglón siguiente a otro
  const re = /(?<=^|[\s;&|(])(?:[^\s;&|()]*[\\/])?(?:ba|z|da|k)?sh(?:\.exe)?(?:\s+-[a-zA-Z-]+)*\s*<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n/g;
  for (const m of String(texto).matchAll(re)) {
    const desde = m.index + m[0].length;
    const fin = new RegExp(`^[\\t ]*${m[2]}[\\t ]*$`, 'm').exec(texto.slice(desde));
    out.push(texto.slice(desde, fin ? desde + fin.index : texto.length));
  }
  return out;
}
/** ¿El segmento es de laboratorio con certeza? Su carpeta, o la de la ejecución si el comando no la cambió. */
const enLaboratorio = ({ carpeta, cierta }, repoPath) => {
  if (!cierta) return false;
  const d = carpeta === null ? repoPath : carpeta;
  return carpetaCierta(d) && esLaboratorio(d);
};
// Los prefijos de `--no-verify` que git acepta sin ambigüedad en `commit` y `push` (`--no-ver` choca con `--no-verbose`;
// en `merge`, con `--no-verify-signatures`): sacado de `git commit -h` y `git push -h`.
const NO_VERIFY_ABREVIADA = ['--no-veri', '--no-verif'];
/**
 * ¿El segmento corre un `git` que saltea los hooks? `--no-verify` en cualquier subcomando; en `commit` y `push`
 * también su prefijo inequívoco; y `-n` sólo en `commit`, también junto a otras opciones cortas (`-an`, `-nm`): en
 * `push` es `--dry-run` y en `log`, la cantidad.
 */
function salteaHooks(s) {
  const git = gitDe(s);
  if (!git) return false;
  const { sub, resto } = opcionesDeGit(git.args);
  if (resto.includes('--no-verify')) return true;
  if ((sub === 'commit' || sub === 'push') && resto.some((a) => NO_VERIFY_ABREVIADA.includes(a))) return true;
  return sub === 'commit' && resto.some(nEnOpcionesCortas);
}
// Las opciones cortas de `git commit` que llevan valor: lo que sigue a su letra es el valor (`-mdone`, `-uno`), no
// otras opciones.
const COMMIT_CON_VALOR = new Set(['m', 'F', 'C', 'c', 't', 'u', 'S']);
/** ¿Las opciones cortas juntas (`-an`, `-nm`, `-anm`) traen `-n`, antes de una que lleva valor? */
function nEnOpcionesCortas(a) {
  if (!/^-[a-zA-Z]/.test(a)) return false;
  for (const letra of a.slice(1)) {
    if (letra === 'n') return true;
    if (COMMIT_CON_VALOR.has(letra) || !/[a-zA-Z]/.test(letra)) return false;
  }
  return false;
}
/** El texto de un comando para compararlo con el de una línea del registro, que lo guarda con otras comillas. */
const normalizado = (t) => String(t || '').replace(/\\\r?\n/g, ' ').replace(/["']/g, '').replace(/\s+/g, ' ').trim();
/**
 * Los pedidos del comando que llevan el escape, cada uno con su texto (el que guarda el freno: `textoDe`) y si el
 * escape sobraba en ESE pedido: un pedido que se puede juzgar —el comando no le pasa código a un intérprete y su destino
 * no es una expansión de la terminal— y que el freno no frenaría (`faltasDe`).
 */
function pedidosConEscape(command) {
  const segs = command ? AZ.segmentos(command) : [];
  const interprete = segs.some((seg) => AZ.pasaCodigoAUnInterprete(seg));
  return segs.filter((seg) => AZ.tieneEscape(seg)).map((seg) => {
    const verbo = AZ.verboDePr(seg);
    const destino = AZ.flagDe(seg, 'target-branch', 't');
    const sobra = !interprete && (verbo === 'create' || verbo === 'update') && !(destino !== null && /[$`]/.test(destino))
      && AZ.faltasDe(seg).faltas.length === 0;
    return { texto: normalizado(AZ.textoDe(seg)), sobra };
  });
}
/**
 * ¿El texto de una línea del registro es el de este comando (o pedido)? Igual, o su comienzo: los frenos cortan el
 * texto (300 caracteres, 300 bytes, 500), y el corte no se sabe de antemano. Con varios candidatos gana el igual (ver
 * `emparejar`).
 */
const coincide = (t, texto) => Boolean(t) && (texto === t || texto.startsWith(t));
/** Los textos de un comando con los que se compara una línea: sus pedidos, para la de pedidos; el comando, para el resto. */
const textosDe = (l, comando) => (tipoDeEscape(l.type || l.kind) === 'PR_A_MANO'
  ? AZ.segmentos(comando).map((seg) => normalizado(AZ.textoDe(seg)))
  : [normalizado(comando)]);

/** Los comandos de la conversación con su resultado, en orden: `{ id, name, command, resultado: { texto, is_error } }`. */
function comandos(lineas) {
  const lista = [];
  const porId = new Map();
  for (const o of lineas || []) {
    if (!o || !o.message || !Array.isArray(o.message.content)) continue;
    for (const b of o.message.content) {
      if (o.type === 'assistant' && b && b.type === 'tool_use') {
        const c = { id: b.id, name: String(b.name || ''), command: b.input && typeof b.input.command === 'string' ? b.input.command : '', resultado: null };
        lista.push(c); if (b.id) porId.set(b.id, c);
      } else if (o.type === 'user' && b && b.type === 'tool_result' && porId.has(b.tool_use_id)) {
        const t = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('\n') : '';
        porId.get(b.tool_use_id).resultado = { texto: t, is_error: b.is_error === true };
      }
    }
  }
  return lista;
}
const esShell = (c) => c.name === 'Bash' || c.name === 'PowerShell';
const tieneRutaDelArnes = (t) => RUTAS_DEL_ARNES.some((r) => String(t || '').includes(r));

/** Suma `cuenta` por la clave de un objeto de regla. */
function sumar(mapa, regla) {
  const k = JSON.stringify([regla.regla, regla.categoria, regla.con_frase, regla.con_motivo]);
  const prev = mapa.get(k);
  if (prev) prev.cuenta += regla.cuenta; else mapa.set(k, { ...regla });
}

// Las categorías que vienen de afuera se cierran acá, al nacer: la ficha y el resumen de la mañana no llevan texto de
// una conversación ni de bypass.log, aunque tenga forma de nombre.
const EVENTOS_DE_HOOK = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact'];
// las de tokens-digest.js: las de su lista, `tiempo` (el hook que se pasó de tiempo) y `otro`
const NOMBRES_HOOK = new Set([...CATEGORIAS_HOOK.map(([n]) => n), 'tiempo', 'otro']);
function categoriaDeHook(a) {
  const evento = EVENTOS_DE_HOOK.includes(a.hookEvent) ? a.hookEvent : 'otro';
  return `${evento}/${NOMBRES_HOOK.has(a.categoria) ? a.categoria : 'otro'}`;
}
/** El `type` de una línea de bypass.log, sólo con forma de constante; si no, `otro`. */
const tipoDeEscape = (t) => (typeof t === 'string' && /^[A-Z][A-Z0-9_]{2,40}$/.test(t) ? t : 'otro');

// Qué nombre de `escape` de frenos.jsonl autoriza cada cosa que ve la revisión: sólo los escapes que su freno anota con
// la sesión y el nombre. Lo que no está acá sigue creando ficha aunque una persona lo haya autorizado.
const AUTORIZABLES = Object.freeze({
  TYCON_NO_DEEP_REVIEW: ['TYCON_NO_DEEP_REVIEW', 'no-deep-review'],
  ADVERSARIAL_SKIP_FORZADO: ['TYCON_NO_DEEP_REVIEW', 'no-deep-review'],
  'story-skill-bypass': ['story-skill-bypass'],
  STORY_SKILL_BYPASS: ['story-skill-bypass'],
  DOD_BYPASS: ['DOD_BYPASS'],
  DOD_BYPASS_UI: ['DOD_BYPASS'],
  DOD_BYPASS_ACMATRIX: ['DOD_BYPASS'],
  'RR-APAGO': ['set-autonomous'],
});
// las vías con la frase de una persona: la suya en la conversación, o la que reenvió la sesión relevo
const VIAS_QUE_AUTORIZAN = ['persona', 'reenvio'];

/**
 * Las autorizaciones de una ejecución, de las líneas de frenos.jsonl de su máquina (`null`: el registro no se midió y
 * nada se autoriza). Una línea autoriza un solo escape: `autoriza(clave)` la consume. De la línea sólo se cuenta.
 */
function autorizaciones(frenos, volcado) {
  if (!frenos) return null;
  const m = (volcado && volcado.marker) || {};
  const desde = Date.parse(m.startedAt || '');
  // sin `archivedAt` (sin cerrar), desde el arranque
  const hasta = Date.parse((volcado && volcado.archivedAt) || '');
  // una línea que autoriza en esta sesión y la ventana no se puede medir (sin arranque, o la línea sin hora legible): no
  // se sabe si autoriza, así que la cuenta queda sin medir
  const deLaSesion = frenos.filter((l) => l && typeof l === 'object' && l.veredicto === 'escape' && VIAS_QUE_AUTORIZAN.includes(l.via) && typeof m.sessionId === 'string' && l.sesion === m.sessionId);
  // un `archivedAt` que no se puede leer no es «sin cerrar»: la ventana no se sabe dónde termina
  const cierreIlegible = Boolean(volcado && volcado.archivedAt) && !Number.isFinite(hasta);
  if (deLaSesion.some((l) => !Number.isFinite(desde) || cierreIlegible || !Number.isFinite(Date.parse(l.ts || '')))) return null;
  const libres = frenos.filter((l) => {
    if (!l || typeof l !== 'object' || l.veredicto !== 'escape' || !VIAS_QUE_AUTORIZAN.includes(l.via)) return false;
    if (typeof m.sessionId !== 'string' || l.sesion !== m.sessionId || typeof l.escape !== 'string') return false;
    const t = Date.parse(l.ts || '');
    return Number.isFinite(desde) && Number.isFinite(t) && t >= desde && (!Number.isFinite(hasta) || t <= hasta);
  });
  const aut = {
    cuenta: 0,
    autoriza(clave) {
      const nombres = Object.prototype.hasOwnProperty.call(AUTORIZABLES, clave) ? AUTORIZABLES[clave] : [];
      const i = libres.findIndex((l) => nombres.includes(l.escape));
      if (i < 0) return false;
      libres.splice(i, 1);
      aut.cuenta += 1;
      return true;
    },
  };
  return aut;
}

function reglasDelHilo(lineas, volcado, out, aut = null) {
  // un hook que se pasó de tiempo (`hook_cancelled`, categoría `tiempo`) también es un aviso que no anduvo
  const hooks = (lineas || []).filter((o) => o && o.type === 'attachment' && o.attachment && (o.attachment.type === 'hook_non_blocking_error' || o.attachment.type === 'hook_cancelled'));
  for (const h of hooks) sumar(out, { regla: 'RR-HOOK', categoria: categoriaDeHook(h.attachment), cuenta: 1 });
  const cs = comandos(lineas);
  const cierre = volcado && volcado.marker && volcado.marker.cierre && typeof volcado.marker.cierre === 'object' ? volcado.marker.cierre : null;
  const partes = partesPorBandera();
  const ultima = {};
  const errorCat = (t) => { const c = CATEGORIAS_HOOK.slice(0, 2).find(([, re]) => re.test(t)); return c ? c[0] : null; };
  for (const c of cs) {
    for (const [parte, es] of Object.entries(ACCIONES_DE_PARTE)) if (es(c)) ultima[parte] = { ok: !(c.resultado && c.resultado.is_error) };
    if (!esShell(c)) continue;
    // un guion del arnés que no arrancó: el comando corre uno (su primer argumento que no es una opción) y el error de
    // su salida nombra una ruta del arnés (lo que el arnés retransmite de un comando del proyecto no la nombra)
    const guiones = segmentos(c.command).filter((s) => s.programa === 'node' && !s.args.includes('-e'))
      .map((s) => s.args.find((a) => !a.startsWith('-'))).filter(tieneRutaDelArnes);
    if (guiones.length && c.resultado && tieneRutaDelArnes(c.resultado.texto)) {
      const cat = errorCat(c.resultado.texto);
      // un guion del arnés que no es del instalado (el clon, un worktree) es una prueba en obra
      const enObra = guiones.every((g) => !RUTAS_INSTALADAS.some((r) => g.includes(r)));
      if (cat) sumar(out, { regla: 'RR-NODE', categoria: enObra ? 'en-obra' : cat, cuenta: 1 });
    }
    const marker = argsDe(c.command, 'marker.js');
    let apagos = marker.filter((r) => r[0] === 'set-autonomous' && !PRENDE_AUTONOMO.includes(String(r[1]).toLowerCase())).length;
    while (apagos && aut && aut.autoriza('RR-APAGO')) apagos -= 1;
    if (apagos) sumar(out, { regla: 'RR-APAGO', categoria: null, cuenta: apagos, con_frase: cierre ? cierre.via === 'persona' : null });
    for (const [bandera, { parte, nombre }] of partes) {
      if (!marker.some((r) => r[0] === 'set-flag' && r[1] === bandera && PRENDE_BANDERA.includes(r[2]))) continue;
      if (!ultima[parte] || !ultima[parte].ok) sumar(out, { regla: 'RR-BANDERA', categoria: nombre, cuenta: 1 });
    }
  }
  return { hilo_sin_hooks: hooks.length === 0, comandos: cs };
}

/**
 * Cada escape que corrió en los comandos de la conversación, uno por vez que corrió: `[{ clave, categoria, texto }]`.
 * `clave` es el escape y `texto` lo que guarda su línea del registro (el comando entero, o el pedido): con los dos se
 * empareja la línea del mismo hecho. `categoria`, dónde cuenta: en una carpeta de laboratorio (sólo con certeza,
 * `enLaboratorio`) el commit sin hooks y la suite completa cuentan aparte, y el escape de un pedido que cumplía la regla
 * sobra.
 */
function escapesDeComandos(cs, repoPath) {
  const out = [];
  for (const c of cs) {
    if (!esShell(c)) continue;
    const texto = normalizado(c.command);
    const add = (clave, categoria = clave, t = texto, extra = {}) => out.push({ clave, categoria, texto: t, ...extra });
    // el escape de pedidos, uno por pedido que lo lleva
    for (const p of pedidosConEscape(c.command)) add('TYCON_PR_BY_HAND', p.sobra ? 'PR_A_MANO/sobra' : 'TYCON_PR_BY_HAND', p.texto);
    for (const seg of conCarpeta(c.command)) {
      // el de pedidos cuenta sólo como lo toma su freno (pegado y con un valor cierto): arriba, por pedido; el resto,
      // con el valor que activa su freno
      for (const a of seg.s.asignaciones) {
        if (!ESCAPES.includes(a) || a === 'TYCON_PR_BY_HAND' || !activa(seg.s, a)) continue;
        if (a === 'TYCON_FULL_SUITE' && enLaboratorio(seg, repoPath)) add(a, 'FULL_SUITE_RUN/laboratorio');
        else add(a);
      }
      // `porLaEjecucion`: sin `cd` ni `-C`, la carpeta es la de la sesión; la línea del registro trae la exacta (`cwd`)
      if (salteaHooks(seg.s)) {
        add('--no-verify', enLaboratorio(seg, repoPath) ? 'GIT_NO_VERIFY/laboratorio' : '--no-verify', texto,
          { porLaEjecucion: seg.cierta && seg.carpeta === null });
      }
    }
    const marker = argsDe(c.command, 'marker.js');
    if (marker.some((r) => r[0] === 'set-flag' && r[1] === 'atddBypass' && PRENDE_BANDERA.includes(r[2]))) add('atddBypass');
    if (marker.some((r) => r[0] === 'story-skill-bypass')) add('story-skill-bypass');
  }
  return out;
}

// Código que corre adentro de una cadena (`bash -c "…"`, `eval`, `python3 -c`): lo que nombra ahí no se puede dar por
// texto que no se ejecuta.
// (también lo que se le da a un shell por un tubo, por `<<<` o con `env -S`)
const INTERPRETE = /(?:^|[\s;&|(/\\])(?:ba|z|k|da)?sh(?:\.exe)?\s+(?:-\w+\s+)*-\w*c\b|(?:^|[\s;&|(])eval\b|python3?(?:\.exe)?\s+-c\b|node(?:\.exe)?\s+(?:-e|-p|--eval)\b|\|\s*(?:\S*[\\/])?(?:ba|z|k|da)?sh\b|(?:ba|z|k|da)?sh(?:\.exe)?(?:\s+-\w+)*\s*<<<|\benv\s+(?:-\S+\s+)*(?:-S|--split-string)\b/;
// Cómo se llama en el registro el escape que se ve en un comando: la categoría de una línea emparejada.
const DEL_REGISTRO = { '--no-verify': 'GIT_NO_VERIFY', TYCON_FULL_SUITE: 'FULL_SUITE_RUN', TYCON_PR_BY_HAND: 'PR_A_MANO', atddBypass: 'ATDD_BYPASS',
  TYCON_NO_DEEP_REVIEW: 'ADVERSARIAL_SKIP_FORZADO' };

/**
 * Dónde cuenta una línea de `bypass.log` que no se emparejó con un comando de la conversación, o `null` si no cuenta:
 * la opción o la variable que la dejó aparece en su texto, pero sólo en algo que no se ejecuta (el cuerpo de un heredoc,
 * el patrón de un `grep`). Si su texto ni la nombra, el corte del freno se la llevó: cuenta. Una línea sin `command`
 * cuenta como hoy. Un texto que pudo quedar cortado no da un pedido por bueno.
 */
function categoriaDeLinea(l, repoPath) {
  const tipo = tipoDeEscape(l.type || l.kind);
  const command = typeof l.command === 'string' && l.command.trim() ? l.command : null;
  const cwdLab = carpetaCierta(l.cwd) ? esLaboratorio(l.cwd) : false;
  if (tipo === 'GIT_NO_VERIFY') {
    if (!command) return cwdLab ? 'GIT_NO_VERIFY/laboratorio' : tipo;
    const corrio = conCarpeta(command).filter(({ s }) => salteaHooks(s));
    // la nombra (entera o abreviada, como la anota el freno del commit) y no la corrió: texto
    if (!corrio.length) return /--no-veri(?:fy?)?(?![\w-])|--no-verify/.test(command) && !INTERPRETE.test(command) ? null : tipo;
    const seg = corrio[0];
    const lab = seg.carpeta === null && seg.cierta && l.cwd ? cwdLab : enLaboratorio(seg, repoPath);
    return lab ? 'GIT_NO_VERIFY/laboratorio' : tipo;
  }
  if (tipo === 'FULL_SUITE_RUN') {
    if (!command) return tipo;
    const corrio = conCarpeta(command).filter(({ s }) => activa(s, 'TYCON_FULL_SUITE'));
    if (!corrio.length) return command.includes('TYCON_FULL_SUITE') && !INTERPRETE.test(command) ? null : tipo;
    return enLaboratorio(corrio[0], repoPath) ? 'FULL_SUITE_RUN/laboratorio' : tipo;
  }
  if (tipo === 'PR_A_MANO') {
    const pedidos = command && command.length < 300 ? pedidosConEscape(command) : [];
    return pedidos.length > 0 && pedidos.every((p) => p.sobra) ? 'PR_A_MANO/sobra' : tipo;
  }
  if (tipo === 'ADVERSARIAL_RELAUNCH') return 'ADVERSARIAL_RELAUNCH/dato';
  if (tipo === 'SIZE_FORCED_LIGHT_WITH_CODE' && typeof l.reason === 'string' && l.reason.trim() !== '') return 'SIZE_FORCED_LIGHT_WITH_CODE/con-motivo';
  return tipo;
}

function reglaDeCierre(volcado, out) {
  const m = (volcado && volcado.marker) || {};
  const pendientes = Array.isArray(m.stepsPending) ? m.stepsPending.length : 0;
  const rojos = Object.values(m.checks || {}).filter((v) => /^red/.test(String(v))).length;
  const c = m.cierre && typeof m.cierre === 'object' ? m.cierre : null;
  if (c) {
    if (c.estado === 'abortada' || c.estado === 'abandonada') sumar(out, { regla: 'RR-CIERRE', categoria: c.estado, cuenta: 1 });
    else if (c.estado === 'completa') { if (pendientes || rojos) sumar(out, { regla: 'RR-CIERRE', categoria: 'incoherente', cuenta: 1, pendientes, rojos }); }
    else if (c.estado !== 'deuda') sumar(out, { regla: 'RR-CIERRE', categoria: 'desconocido', cuenta: 1 });
    return;
  }
  if (volcado && volcado.sinCerrar === true) { sumar(out, { regla: 'RR-CIERRE', categoria: 'sin-cerrar', cuenta: 1 }); return; }
  if (!volcado || !volcado.archivedAt) return;
  // Sin constancia, lo pendiente sale de los pasos. No cuentan el paso viejo 9 (cerrar la historia después del merge,
  // que corre aparte) ni el 7 viejo con el 8 hecho.
  const hechos = new Set((Array.isArray(m.stepsCompleted) ? m.stepsCompleted : []).map(String));
  const quedan = (Array.isArray(m.stepsPending) ? m.stepsPending : []).map(String)
    .filter((p) => p !== '9' && p !== 'close-work-item' && !(p === '7' && hechos.has('8'))).length;
  if (!quedan && !rojos) return;
  const antes = Date.parse(volcado.archivedAt) < Date.parse(CIERRE_DESDE);
  sumar(out, { regla: 'RR-CIERRE', categoria: antes ? 'derivada/arnes-anterior' : 'derivada', cuenta: 1, pendientes: quedan, rojos });
}

/**
 * Las líneas de bypass.log que son de esta ejecución: por `sessionId`, o, en las que no lo traen (los frenos de PR a
 * mano y de la suite completa), por la hora, entre el arranque y el archivo de la ejecución. Con la conversación
 * (`comandos`), una línea sin `sessionId` que trae su `command` es además de la ejecución que lo corrió: otra que sólo
 * la cubre por la hora no la cuenta.
 */
function delRegistro(lineas, volcado, comandos = null) {
  const propios = comandos ? comandos.filter(esShell).map((c) => c.command) : null;
  const corrioAca = (l) => !propios || !normalizado(l.command)
    || propios.some((c) => textosDe(l, c).some((x) => coincide(normalizado(l.command), x)));
  return enLaVentana(lineas, volcado).filter((l) => l.sessionId || corrioAca(l));
}
function enLaVentana(lineas, volcado) {
  const m = (volcado && volcado.marker) || {};
  const desde = Date.parse(m.startedAt || '');
  // sin `archivedAt` (sin cerrar) no hay fin de ventana: sólo cuentan las líneas de su sesión, y el resultado no depende
  // de la hora a la que corre la pasada
  const hasta = Date.parse((volcado && volcado.archivedAt) || '');
  return lineas.filter((l) => {
    if (!l || typeof l !== 'object') return false;
    if (l.sessionId) return l.sessionId === m.sessionId;
    if (!Number.isFinite(hasta)) return false;
    const t = Date.parse(l.ts || '');
    return Number.isFinite(desde) && Number.isFinite(t) && t >= desde && t <= hasta;
  });
}

/**
 * Empareja cada línea del registro con UNA vez que su escape corrió en la conversación (`vistos`, que quedan marcados
 * `usado`): primero las de texto igual, después las que son su comienzo (una línea cortada), y al final las que no
 * traen texto, con la primera libre de su escape. Una línea no tapa dos comandos, y dos líneas no tapan uno.
 */
function emparejar(lineas, vistos) {
  const res = lineas.map((l) => ({ l, par: null }));
  for (const pasada of ['igual', 'comienzo', 'sin-texto']) {
    for (const r of res) {
      const clave = EQUIVALENTES[r.l.type || r.l.kind];
      if (r.par || !clave) continue;
      const t = normalizado(r.l.command);
      if ((pasada === 'sin-texto') !== !t) continue;
      const v = vistos.find((x) => !x.usado && x.clave === clave
        && (pasada === 'sin-texto' || (pasada === 'igual' ? x.texto === t : coincide(t, x.texto))));
      if (v) { v.usado = true; r.par = v; }
    }
  }
  return res;
}

/**
 * Las fallas de una ejecución. `lineasHilo: null` = no hay conversación: sólo corren las reglas del volcado y los
 * registros, y `sin_hilo: true` (nunca «sin fallas»). `registros: { bypass: [líneas] | null, frenos: [líneas] | null,
 * cobertura }`, los de la máquina de la ejecución. Un escape autorizado en frenos.jsonl no va a la ficha: suma a
 * `escapes_autorizados` (`null` sin el registro medido).
 */
function revisar({ volcado, lineasHilo, registros }) {
  const out = new Map();
  const sinHilo = lineasHilo === null || lineasHilo === undefined;
  const fuenteFrenos = registros && registros.cobertura && registros.cobertura.fuentes && registros.cobertura.fuentes.frenos;
  const aut = autorizaciones(fuenteFrenos && fuenteFrenos.estado === 'medido' && Array.isArray(registros.frenos) ? registros.frenos : null, volcado);
  let hiloSinHooks = null;
  let cs = [];
  if (!sinHilo) { const r = reglasDelHilo(lineasHilo, volcado, out, aut); hiloSinHooks = r.hilo_sin_hooks; cs = r.comandos; }
  reglaDeCierre(volcado, out);
  const fuente = registros && registros.cobertura && registros.cobertura.fuentes && registros.cobertura.fuentes.bypass;
  const medido = Boolean(fuente && fuente.estado === 'medido' && Array.isArray(registros.bypass));
  const repoPath = volcado && volcado.marker ? volcado.marker.repoPath : null;
  const propias = medido ? delRegistro(registros.bypass, volcado, sinHilo ? null : cs) : [];
  // El mismo hecho en el registro y en la conversación cuenta una vez, por el registro, y uno a uno: cada línea se
  // empareja con UNA vez que su escape corrió (`emparejar`) y entonces cuenta con lo que se ve del comando entero. Lo que
  // queda sin pareja cuenta solo: la línea por su texto, el comando por lo suyo.
  const vistos = escapesDeComandos(cs, repoPath);
  for (const { l, par } of emparejar(propias, vistos)) {
    let categoria = par ? (DEL_REGISTRO[par.categoria] || par.categoria) : categoriaDeLinea(l, repoPath);
    // sin `cd` ni `-C`, el commit corrió en la carpeta de la sesión: la de la línea es la exacta
    if (par && par.porLaEjecucion && carpetaCierta(l.cwd)) categoria = esLaboratorio(l.cwd) ? 'GIT_NO_VERIFY/laboratorio' : 'GIT_NO_VERIFY';
    if (categoria === null || (aut && aut.autoriza(categoria))) continue;
    sumar(out, { regla: 'RR-ESCAPE', categoria, cuenta: 1, con_motivo: typeof l.reason === 'string' && l.reason.trim() !== '' });
  }
  for (const v of vistos) if (!v.usado && !(aut && aut.autoriza(v.categoria))) sumar(out, { regla: 'RR-ESCAPE', categoria: v.categoria, cuenta: 1 });
  const reglas = [...out.values()].map((r) => { const x = { ...r }; for (const k of Object.keys(x)) if (x[k] === undefined) delete x[k]; return x; });
  return { reglas, sin_hilo: sinHilo, escapes_registro: medido ? 'medido' : 'no_medido', hilo_sin_hooks: hiloSinHooks,
    escapes_autorizados: aut ? aut.cuenta : null };
}

module.exports = { CODIGOS, ESCAPES, EQUIVALENTES, ACCIONES_DE_PARTE, RUTAS_DEL_ARNES, RUTAS_INSTALADAS, CIERRE_DESDE, APARTE,
  banderasDePartes, segmentos, argsDe, corre, comandos, revisar };
